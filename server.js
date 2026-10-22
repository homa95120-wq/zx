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
  if (key) headers.authorization = `Bearer ${key}`;
  // OpenRouter любит заголовки с метаданными приложения — остальным не мешают
  headers['http-referer'] = 'http://localhost:3000';
  headers['x-title'] = 'zx free agent';

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
        })),
        priority: CATALOG.PRIORITY,
      });
    }

    if (u.pathname === '/api/proxy' && req.method === 'POST') {
      return await handleProxy(req, res);
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
  console.log(`zx agent → http://${HOST}:${PORT}`);
});
