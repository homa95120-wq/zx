#!/usr/bin/env node
/**
 * zx — ИИ-агент на бесплатных моделях.
 * Сервер без зависимостей: раздаёт статику и проксирует запросы к провайдерам
 * (нужен, когда провайдер не разрешает запросы прямо из браузера / CORS).
 *
 * Ключи провайдеров НЕ хранятся на сервере — они приходят с каждым запросом
 * из браузера и живут только в localStorage у пользователя.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const CATALOG = require('./lib/providers');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBodyRaw(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit) {
  return readBodyRaw(req, limit).then((b) => b.toString('utf8'));
}

function isAllowedUpstream(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    // http разрешён только для локальных моков/тестов
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
    return false;
  } catch { return false; }
}

async function handleProxy(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch { return send(res, 400, { error: 'bad json' }); }

  const { url, key, method = 'POST', payload, stream = false } = parsed;
  if (typeof url !== 'string' || !isAllowedUpstream(url)) {
    return send(res, 400, { error: 'недопустимый url' });
  }

  const headers = { 'content-type': 'application/json' };
  if (key) {
    headers.authorization = `Bearer ${key}`;
    if (parsed.authStyle === 'anthropic') headers['x-api-key'] = key;
  }
  // OpenRouter любит заголовки с метаданными приложения — остальным не мешают
  headers['http-referer'] = 'http://localhost:3000';
  headers['x-title'] = 'zx agent';
  // доп. заголовки провайдера (например anthropic-version) — только известные префиксы
  if (parsed.extraHeaders && typeof parsed.extraHeaders === 'object') {
    for (const [k, v] of Object.entries(parsed.extraHeaders)) {
      if (/^(anthropic-|http-|x-|openai-)/i.test(k) && typeof v === 'string') headers[k.toLowerCase()] = v;
    }
  }

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const killTimer = setTimeout(() => { try { ac.abort(); } catch {} }, 45 * 1000);
  let up;
  try {
    up = await fetch(url, {
      method: method === 'GET' ? 'GET' : 'POST',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
      signal: ac.signal,
    });
    clearTimeout(killTimer);
  } catch (e) {
    clearTimeout(killTimer);
    return send(res, 502, { error: `upstream fetch failed: ${e.message}` });
  }

  const resHeaders = {
    'content-type': up.headers.get('content-type') || 'application/json',
    'cache-control': 'no-store',
    'x-zx-upstream-status': String(up.status),
  };
  res.writeHead(up.status, resHeaders);

  if (stream && up.body) {
    try {
      for await (const chunk of up.body) {
        if (!res.write(chunk)) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    } catch { /* клиент отключился */ }
    res.end();
  } else {
    const text = await up.text();
    res.end(text);
  }
}

/* ---------------- агент: выполнение инструментов на машине ---------------- */
// Рабочую папку можно сменить на лету (POST /api/agent/workspace) — выбор
// сохраняется в конфиг рядом с местом запуска (важно для zx-agent.exe).
const CONFIG_FILE = path.resolve(process.env.ZX_CONFIG || path.join(process.cwd(), 'zx.config.json'));
let WORKSPACE = path.resolve(process.env.ZX_WORKSPACE || process.cwd());
(function loadConfig() {
  try {
    if (process.env.ZX_WORKSPACE) return; // env имеет приоритет (тесты/скрипты)
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.workspace) WORKSPACE = path.resolve(cfg.workspace);
  } catch {}
})();
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ workspace: WORKSPACE }, null, 2)); } catch {}
}
const MAX_OUT = 16 * 1024;          // обрезать вывод команды до 16 КБ
const CMD_TIMEOUT = 120 * 1000;     // таймаут команды — 2 минуты

function safeJoin(base, rel) {
  // это локальный личный агент: разрешаем любые пути, UI всегда показывает итоговый
  return path.resolve(base, String(rel || '.'));
}

function runTerminal(args) {
  const command = String(args.command || '').trim();
  if (!command) return Promise.resolve({ ok: false, error: 'пустая команда' });
  const cwd = args.cwd ? safeJoin(WORKSPACE, args.cwd) : WORKSPACE;
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false;
    const child = spawn(shell, shellArgs, { cwd, windowsHide: true, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch {}
    }, CMD_TIMEOUT);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUT * 2) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT * 2) err += d; });
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message, cwd }); });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const trunc = (s) => s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n… [обрезано, всего ${s.length} байт]` : s;
      resolve({ ok: code === 0 && !timedOut, exitCode: code, cwd, stdout: trunc(out), stderr: trunc(err), timedOut });
    });
  });
}

function listDir(args) {
  const dir = safeJoin(WORKSPACE, args.path || '.');
  return new Promise((resolve) => {
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) return resolve({ ok: false, error: err.message, path: dir });
      const list = entries
        .slice(0, 500)
        .map((e) => e.isDirectory() ? e.name + '/' : e.name)
        .sort((a, b) => (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b));
      resolve({ ok: true, path: dir, entries: list });
    });
  });
}

function readFileTool(args) {
  const file = safeJoin(WORKSPACE, args.path || '');
  return new Promise((resolve) => {
    fs.readFile(file, 'utf8', (err, data) => {
      if (err) return resolve({ ok: false, error: err.message, path: file });
      const offset = Math.max(0, Number(args.offset) || 0);
      const max = Math.min(96 * 1024, Math.max(1024, Number(args.length) || 48 * 1024));
      const rest = offset > 0 ? data.slice(offset) : data;
      const truncated = rest.length > max;
      const body = truncated ? rest.slice(0, max) + `\n… [показано ${max} из ${rest.length} символов; дальше читайте с offset=${offset + max}]` : rest;
      resolve({ ok: true, path: file, total: data.length, offset, content: body, truncated });
    });
  });
}

function writeFileTool(args) {
  const file = safeJoin(WORKSPACE, args.path || '');
  const content = typeof args.content === 'string' ? args.content : '';
  return new Promise((resolve) => {
    fs.mkdir(path.dirname(file), { recursive: true }, (e1) => {
      if (e1) return resolve({ ok: false, error: e1.message, path: file });
      fs.writeFile(file, content, 'utf8', (e2) => {
        if (e2) return resolve({ ok: false, error: e2.message, path: file });
        resolve({ ok: true, path: file, bytes: Buffer.byteLength(content) });
      });
    });
  });
}

/* ---------- вложения: чанковая загрузка любых размеров ---------- */
const uploads = new Map(); // id -> { fp, name, size, written }

function safeName(n) {
  const base = path.basename(String(n || 'file'));
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120).trim();
  return cleaned || 'file';
}

function uniquePath(dir, name) {
  let final = path.join(dir, name);
  let i = 1;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  while (fs.existsSync(final)) {
    final = path.join(dir, `${stem}-${i++}${ext}`);
  }
  return final;
}

async function handleUploadInit(req, res) {
  let b;
  try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
  const name = safeName(b.name);
  const dir = path.join(WORKSPACE, 'zx-files');
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch (e) { return send(res, 500, { error: e.message }); }
  const fp = uniquePath(dir, name);
  const id = require('crypto').randomBytes(12).toString('hex');
  uploads.set(id, { fp, name, size: Number(b.size) || 0, written: 0 });
  send(res, 200, { ok: true, id, path: fp });
}

async function handleUploadChunk(req, res, query) {
  const up = uploads.get(query.get('id'));
  if (!up) return send(res, 404, { error: 'загрузка не найдена' });
  let buf;
  try { buf = await readBodyRaw(req, 16 * 1024 * 1024); } catch (e) { return send(res, 400, { error: e.message }); }
  try {
    await fs.promises.appendFile(up.fp, buf);
  } catch (e) { return send(res, 500, { error: e.message }); }
  up.written += buf.length;
  const done = up.written >= up.size;
  if (done) uploads.delete(query.get('id'));
  send(res, 200, { ok: true, written: up.written, done, path: up.fp });
}

const TOOLS = {
  run_terminal: runTerminal,
  list_dir: listDir,
  read_file: readFileTool,
  write_file: writeFileTool,
};

async function handleToolExec(req, res) {
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
  const fn = TOOLS[parsed?.tool];
  if (!fn) return send(res, 400, { error: 'неизвестный инструмент' });
  const result = await fn(parsed.args || {});
  send(res, 200, result);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPA-фолбэк на index.html для неизвестных путей без расширения
      if (!path.extname(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(html);
        });
      }
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, name: 'zx' });

    if (u.pathname === '/api/providers') {
      return send(res, 200, {
        providers: CATALOG.map((p) => ({
          id: p.id, name: p.name, baseUrl: p.baseUrl, keyUrl: p.keyUrl,
          keyless: p.keyless, free: p.free, note: p.note, picks: p.picks,
          onlyFree: !!p.onlyFree, filter: p.filter ? p.filter.source : null,
          paid: !!p.paid, authStyle: p.authStyle || null, extraHeaders: p.extraHeaders || null,
        })),
        priority: CATALOG.PRIORITY,
      });
    }

    if (u.pathname === '/api/proxy' && req.method === 'POST') {
      return await handleProxy(req, res);
    }

    if (u.pathname === '/api/agent/info') {
      return send(res, 200, {
        workspace: WORKSPACE,
        platform: process.platform,
        node: process.version,
        exe: !!process.pkg,
        contextFile: path.join(WORKSPACE, 'zx-context.json'),
        configFile: CONFIG_FILE,
      });
    }

    if (u.pathname === '/api/agent/workspace' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
      const raw = String(body.path || '').trim();
      if (!raw) return send(res, 400, { error: 'укажите путь к папке' });
      const target = path.resolve(raw);
      let st = null;
      try { st = await fs.promises.stat(target); } catch {}
      if (st && !st.isDirectory()) return send(res, 400, { error: 'это не папка, а файл' });
      if (!st) {
        if (!body.create) return send(res, 400, { error: 'папка не существует', needCreate: true });
        try {
          await fs.promises.mkdir(target, { recursive: true });
        } catch (e) { return send(res, 400, { error: 'не удалось создать папку: ' + e.message }); }
      }
      WORKSPACE = target;
      saveConfig();
      return send(res, 200, { ok: true, workspace: WORKSPACE });
    }

    // контекст (чаты+настройки) живёт в файле внутри рабочей папки
    if (u.pathname === '/api/store/chats' && req.method === 'GET') {
      const file = path.join(WORKSPACE, 'zx-context.json');
      try {
        const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        return send(res, 200, { exists: true, data });
      } catch { return send(res, 200, { exists: false }); }
    }

    if (u.pathname === '/api/store/chats' && req.method === 'PUT') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
      const file = path.join(WORKSPACE, 'zx-context.json');
      const payload = {
        savedAt: new Date().toISOString(),
        workspace: WORKSPACE,
        curId: body.curId || null,
        chats: Array.isArray(body.chats) ? body.chats.slice(0, 60) : [],
        settings: body.settings && typeof body.settings === 'object' ? body.settings : {},
      };
      try {
        await fs.promises.writeFile(file, JSON.stringify(payload, null, 2));
      } catch (e) { return send(res, 500, { error: e.message }); }
      return send(res, 200, { ok: true, file });
    }

    if (u.pathname === '/api/tools/exec' && req.method === 'POST') {
      return await handleToolExec(req, res);
    }

    if (u.pathname === '/api/upload/init' && req.method === 'POST') {
      return await handleUploadInit(req, res);
    }

    if (u.pathname === '/api/upload/chunk' && req.method === 'PUT') {
      return await handleUploadChunk(req, res, u.searchParams);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); return res.end();
    }
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ██  z x  — агент для кода на бесплатных и топовых моделях');
  console.log(`  ►  ${url}`);
  console.log(`  ►  рабочая папка агента: ${WORKSPACE}`);
  console.log('  ►  остановить: Ctrl+C');
  console.log('');
  // Автозапуск браузера (для .exe / интерактивного запуска)
  if (process.env.ZX_NO_OPEN !== '1' && (process.platform === 'win32' || process.stdout.isTTY)) {
    setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch {}
    }, 700);
  }
});
