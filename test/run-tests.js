// Интеграционный тест: мок-провайдер + /api/proxy нашего сервера.
// Проверяем: 1) раздача статики, 2) каталог провайдеров,
// 3) проксирование SSE-стрима, 4) проброс статуса ошибки (429).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');

const MOCK_PORT = 9101;
const PORT = 3311;
const WS_DIR = path.join(os.tmpdir(), 'zx-ws-test');

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
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ZX_NO_OPEN: '1', ZX_WORKSPACE: WS_DIR, ZX_CONFIG: path.join(os.tmpdir(), 'zx-test-config.json') },
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


  // 4b. инструменты агента
  const fs = require('fs');
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });

  const exec = async (body) => req('POST', '/api/tools/exec', JSON.stringify(body), { 'content-type': 'application/json' });

  const term = await exec({ tool: 'run_terminal', args: { command: 'echo hello-agent' } });
  const termJ = JSON.parse(term.body);
  check('run_terminal: echo', termJ.ok === true && termJ.stdout.includes('hello-agent'), JSON.stringify(termJ).slice(0, 120));

  const wf = await exec({ tool: 'write_file', args: { path: 'sub/hello.txt', content: 'привет, агент' } });
  check('write_file: создаёт файл', JSON.parse(wf.body).ok === true);

  const rf = await exec({ tool: 'read_file', args: { path: 'sub/hello.txt' } });
  check('read_file: читает файл', JSON.parse(rf.body).content === 'привет, агент');

  const ld = await exec({ tool: 'list_dir', args: {} });
  const ldJ = JSON.parse(ld.body);
  check('list_dir: видит файлы', ldJ.ok === true && ldJ.entries.includes('sub/'));

  const unk = await exec({ tool: 'hack', args: {} });
  check('неизвестный инструмент отклонён', unk.status === 400);

  const info = await req('GET', '/api/agent/info');
  check('agent/info: workspace', JSON.parse(info.body).workspace === WS_DIR, JSON.parse(info.body).workspace);


  // 4c. выбор рабочей папки и хранение контекста
  const WS2 = path.join(WS_DIR, 'deep', 'nested');
  const cfgFile = path.join(os.tmpdir(), 'zx-test-config.json');
  fs.rmSync(cfgFile, { force: true });

  const noDir = await req('POST', '/api/agent/workspace', JSON.stringify({ path: WS2 }), { 'content-type': 'application/json' });
  check('смена папки: без create — отказ', noDir.status === 400 && JSON.parse(noDir.body).needCreate === true);

  const wsSet = await req('POST', '/api/agent/workspace', JSON.stringify({ path: WS2, create: true }), { 'content-type': 'application/json' });
  check('смена папки: с create — ок', wsSet.status === 200 && JSON.parse(wsSet.body).workspace === WS2);

  const info2 = JSON.parse((await req('GET', '/api/agent/info')).body);
  check('agent/info: новая папка', info2.workspace === WS2);
  check('конфиг сохранён', fs.existsSync(cfgFile) && JSON.parse(fs.readFileSync(cfgFile, 'utf8')).workspace === WS2, cfgFile);

  const w2 = await exec({ tool: 'write_file', args: { path: 'in-new-ws.txt', content: 'here' } });
  check('инструменты пишут в новую папку', JSON.parse(w2.body).ok === true && fs.existsSync(path.join(WS2, 'in-new-ws.txt')));

  const putCtx = await req('PUT', '/api/store/chats', JSON.stringify({ curId: 'x', chats: [{ id: 'x', title: 'Т', messages: [] }], settings: { system: 'тест' } }), { 'content-type': 'application/json' });
  const ctxPath = path.join(WS2, 'zx-context.json');
  check('контекст сохранён в папку', putCtx.status === 200 && fs.existsSync(ctxPath));

  const getCtx = JSON.parse((await req('GET', '/api/store/chats')).body);
  check('контекст читается обратно', getCtx.exists === true && getCtx.data.chats[0].id === 'x' && getCtx.data.settings.system === 'тест');

  // вернём исходную папку
  await req('POST', '/api/agent/workspace', JSON.stringify({ path: WS_DIR }), { 'content-type': 'application/json' });

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
