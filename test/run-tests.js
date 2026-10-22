// Интеграционный тест: мок-провайдер + /api/proxy нашего сервера.
// Проверяем: 1) раздача статики, 2) каталог провайдеров,
// 3) проксирование SSE-стрима, 4) проброс статуса ошибки (429).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const MOCK_PORT = 9101;
const PORT = 3311;

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  const mock = require('./mock-server');
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  });
  await new Promise((r) => setTimeout(r, 700));

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push([name, cond]);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  };

  // 1. статика
  const idx = await req('GET', '/');
  check('GET / отдаёт index.html', idx.status === 200 && idx.body.includes('zx'), `status=${idx.status}`);
  const css = await req('GET', '/style.css');
  check('GET /style.css', css.status === 200 && css.body.includes('--accent'));
  const js = await req('GET', '/app.js');
  check('GET /app.js', js.status === 200 && js.body.includes('buildChain'));
  const vend = await req('GET', '/vendor/marked.min.js');
  check('GET /vendor/marked.min.js', vend.status === 200);
  const pur = await req('GET', '/vendor/purify.min.js');
  check('GET /vendor/purify.min.js', pur.status === 200);

  // 2. каталог
  const prov = await req('GET', '/api/providers');
  const pj = JSON.parse(prov.body);
  check('GET /api/providers', prov.status === 200 && pj.providers.length >= 7 && pj.priority.length >= 7);

  // 3. стрим через прокси
  const stream = await req('POST', '/api/proxy', JSON.stringify({
    url: `http://127.0.0.1:${MOCK_PORT}/v1/good/chat/completions`,
    payload: { model: 'mock', messages: [], stream: true },
    stream: true,
  }), { 'content-type': 'application/json' });
  check('прокси стримит SSE', stream.status === 200 && stream.body.includes('data: {') && stream.body.includes('[DONE]'), `len=${stream.body.length}`);
  const assembled = [...stream.body.matchAll(/data: (\{.*?\})\n/g)]
    .map((m) => { try { return JSON.parse(m[1]).choices[0].delta.content || ''; } catch { return ''; } })
    .join('');
  check('стрим содержит весь контент', assembled === 'Привет, мир', `assembled="${assembled}"`);

  // 4. ошибка пробрасывается со статусом
  const bad = await req('POST', '/api/proxy', JSON.stringify({
    url: `http://127.0.0.1:${MOCK_PORT}/v1/bad/chat/completions`,
    payload: { model: 'mock', messages: [] },
    stream: true,
  }), { 'content-type': 'application/json' });
  check('прокси пробрасывает 429', bad.status === 429 && bad.body.includes('rate limit'));

  // 5. защита от левых url
  const evil = await req('POST', '/api/proxy', JSON.stringify({ url: 'ftp://evil', payload: {} }), { 'content-type': 'application/json' });
  check('недопустимый url отклонён', evil.status === 400);

  srv.kill();
  mock.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${failed} тестов упало` : '\nВсе тесты прошли');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
