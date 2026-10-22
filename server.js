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

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

  let up;
  try {
    up = await fetch(url, {
      method: method === 'GET' ? 'GET' : 'POST',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
      signal: ac.signal,
    });
  } catch (e) {
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
const WORKSPACE = path.resolve(process.env.ZX_WORKSPACE || process.cwd());
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
      const max = 48 * 1024;
      const body = data.length > max ? data.slice(0, max) + `\n… [файл обрезан, всего ${data.length} символов]` : data;
      resolve({ ok: true, path: file, content: body });
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
      });
    }

    if (u.pathname === '/api/tools/exec' && req.method === 'POST') {
      return await handleToolExec(req, res);
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
