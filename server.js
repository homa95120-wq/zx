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

/* ---------------- веб: поиск и чтение страниц ---------------- */
// Бесплатный поиск без ключей через HTML-версию DuckDuckGo + чтение страниц.
// Всё выполняется на машине пользователя; локальные и приватные адреса
// запрещены (SSRF), редиректы проверяются на каждом шаге.
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const WEB_MAX_BYTES = 2 * 1024 * 1024;
const WEB_PAGE_CHARS = 48 * 1024;

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  times: '×', divide: '÷', middot: '·', bull: '•', euro: '€', pound: '£', yen: '¥', deg: '°',
};

function htmlDecode(str) {
  return String(str).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const hex = ent[1] && ent[1].toLowerCase() === 'x';
      const code = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = HTML_ENTITIES[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // скрипты/стили/навигация не нужны в тексте страницы
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe|nav|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe|nav|head)\b[^>]*\/?>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt|figure|figcaption)\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = htmlDecode(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t\f\v\u00a0]+/g, ' ');
  s = s.split('\n').map((line) => line.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function isPrivateHost(rawHost) {
  let h = String(rawHost || '').trim().toLowerCase();
  if (!h) return true;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(local|internal|intranet|lan|home|corp|private)$/.test(h)) return true;

  if (!h.includes(':')) {
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const p = m.slice(1).map(Number);
      if (p.some((n) => n > 255)) return true;
      const [a, b] = p;
      if (a === 0 || a === 10 || a === 127) return true;          // this-host, private, loopback
      if (a === 169 && b === 254) return true;                    // link-local / cloud metadata
      if (a === 172 && b >= 16 && b <= 31) return true;           // private
      if (a === 192 && b === 168) return true;                    // private
      if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
      if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
      if (a >= 224) return true;                                  // multicast / reserved
      return false;
    }
    // имя без точки — локальное имя из /etc/hosts или DNS-суффикса
    return !h.includes('.');
  }

  // IPv6
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{0,2}(:|$)/.test(h)) return true;            // fc00::/7 (unique local)
  if (/^fe[89ab][0-9a-f]{0,2}(:|$)/.test(h)) return true;         // fe80::/10 (link-local)
  if (/^ff[0-9a-f]{0,2}(:|$)/.test(h)) return true;               // multicast
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const mapped4 = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped4) return isPrivateHost(mapped4[1]);
  return false;
}

function checkWebUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, error: 'некорректный url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'разрешены только http и https' };
  }
  if (isPrivateHost(u.hostname)) {
    return { ok: false, error: 'запрещён доступ к локальным и приватным адресам' };
  }
  if (u.username || u.password) return { ok: false, error: 'url с логином/паролем не поддерживается' };
  return { ok: true, url: u };
}

async function readLimited(res, maxBytes) {
  if (!res.body) {
    const text = await res.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        truncated = true;
        try { await reader.cancel(); } catch {}
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

async function fetchWeb(rawUrl, opts = {}) {
  let current = String(rawUrl);
  let method = opts.method || 'GET';
  let body = opts.body;
  const maxRedirects = opts.maxRedirects == null ? 5 : opts.maxRedirects;

  const abort = new AbortController();
  const timer = setTimeout(() => { try { abort.abort(); } catch {} }, opts.timeoutMs || 20000);
  const fail = (error) => { clearTimeout(timer); return { ok: false, error, url: current }; };
  try {
    for (let i = 0; i <= maxRedirects; i++) {
      const chk = checkWebUrl(current);
      if (!chk.ok) return fail(chk.error);
      let res;
      try {
        res = await fetch(chk.url.href, { method, headers: opts.headers, body, redirect: 'manual', signal: abort.signal });
      } catch (e) {
        return fail(e.name === 'AbortError' ? 'таймаут запроса' : e.message);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        try { await res.body?.cancel(); } catch {}
        if (!loc) return fail(`редирект ${res.status} без location`);
        let next;
        try { next = new URL(loc, chk.url.href).href; } catch { return fail('некорректный редирект'); }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = undefined;
        }
        current = next;
        continue;
      }
      return { ok: true, res, url: chk.url.href, timer };
    }
    return fail('слишком много редиректов');
  } catch (e) {
    return fail(e.message);
  }
}

function ddgResults(html, limit) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...String(html).matchAll(re)];
  for (let i = 0; i < matches.length && out.length < limit; i++) {
    const m = matches[i];
    const tag = m[0];
    const href = (tag.match(/\bhref="([^"]*)"/i) || tag.match(/\bhref='([^']*)'/i) || [])[1] || '';
    const title = htmlToText(m[1]);
    const url = unwrapDdgUrl(href);
    if (!url || !title) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    // реклама и внутренние переходы DuckDuckGo
    if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname) && /^\/(y\.js|l\/)/.test(parsed.pathname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const blockEnd = i + 1 < matches.length ? matches[i + 1].index : String(html).length;
    const block = String(html).slice(m.index + m[0].length, blockEnd);
    const sm = block.match(/<a\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<(div|td|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i);
    const snippet = sm ? htmlToText(sm[2] == null ? sm[1] : sm[2]) : '';
    out.push({ title, url, snippet });
  }
  return out;
}

function unwrapDdgUrl(raw) {
  let href = htmlDecode(raw).trim();
  if (!href) return '';
  if (href.startsWith('//')) href = 'https:' + href;
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    return u.href;
  } catch { return href; }
}

async function webSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) return { ok: false, error: 'пустой поисковый запрос' };
  const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 6)));
  const target = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const got = await fetchWeb(target, {
    headers: {
      'user-agent': WEB_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
      referer: 'https://html.duckduckgo.com/',
    },
    timeoutMs: 15000,
  });
  if (!got.ok) return { ok: false, query, error: got.error };
  try {
    if (got.res.status >= 400) {
      return { ok: false, query, error: `DuckDuckGo вернул ${got.res.status}` };
    }
    const { text } = await readLimited(got.res, WEB_MAX_BYTES);
    const results = ddgResults(text, limit);
    if (!results.length) {
      return { ok: true, query, results: [], note: 'DuckDuckGo не вернул результатов (возможно, запрос заблокирован сетью или капчей)' };
    }
    return { ok: true, query, results };
  } catch (e) {
    return { ok: false, query, error: e.name === 'AbortError' ? 'таймаут запроса' : e.message };
  } finally {
    clearTimeout(got.timer);
  }
}

async function webFetch(args) {
  const rawUrl = String(args.url || '').trim();
  if (!rawUrl) return { ok: false, error: 'укажите url страницы' };
  const chk = checkWebUrl(rawUrl);
  if (!chk.ok) return { ok: false, url: rawUrl, error: chk.error };

  const got = await fetchWeb(chk.url.href, {
    headers: {
      'user-agent': WEB_UA,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
    timeoutMs: 20000,
  });
  if (!got.ok) return { ok: false, url: rawUrl, error: got.error };

  try {
    if (got.res.status >= 400) {
      return { ok: false, url: got.url, status: got.res.status, error: `HTTP ${got.res.status}` };
    }
    const { text, truncated: downloadTruncated } = await readLimited(got.res, WEB_MAX_BYTES);
    const ct = String(got.res.headers.get('content-type') || '').toLowerCase();
    const isJson = ct.includes('application/json') || ct.includes('+json');
    let content;
    if (isJson) content = text.trim();
    else if (ct.includes('html') || ct.includes('xml') || /^\s*</.test(text)) content = htmlToText(text);
    else content = text.replace(/\r\n?/g, '\n').trim();

    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const max = Math.min(WEB_PAGE_CHARS, Math.max(1024, Math.floor(Number(args.length) || WEB_PAGE_CHARS)));
    const rest = offset > 0 ? content.slice(offset) : content;
    const truncated = rest.length > max;
    const body = truncated
      ? rest.slice(0, max) + `\n… [показано ${max} из ${rest.length} символов; дальше читайте с offset=${offset + max}]`
      : rest;
    return {
      ok: true,
      url: got.url,
      total: content.length,
      offset,
      content: body,
      truncated,
      ...(downloadTruncated ? { note: 'страница больше 2 МБ — скачано только начало' } : {}),
    };
  } catch (e) {
    return { ok: false, url: got.url, error: e.name === 'AbortError' ? 'таймаут запроса' : e.message };
  } finally {
    clearTimeout(got.timer);
  }
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
  web_search: webSearch,
  web_fetch: webFetch,
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
