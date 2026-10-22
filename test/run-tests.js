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

  // 4b-2. веб-инструменты: SSRF-защита и схемы (без реального интернета).
  // Поиск и чтение публичных страниц проверяются на машине пользователя.
  const webFetchAs = async (url) => JSON.parse((await exec({ tool: 'web_fetch', args: { url } })).body);
  const privateUrls = [
    `http://127.0.0.1:${PORT}/`,
    `http://localhost:${PORT}/`,
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:3000/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://example.com@127.0.0.1/',
  ];
  for (const url of privateUrls) {
    const r = await webFetchAs(url);
    check(`web_fetch: SSRF — ${url}`, r.ok === false && /приват|локальн|запрещ/i.test(r.error || ''), r.error);
  }
  const wfFile = await webFetchAs('file:///etc/passwd');
  check('web_fetch: file:// отклонён', wfFile.ok === false && /http/i.test(wfFile.error || ''), wfFile.error);
  const wfFtp = await webFetchAs('ftp://example.com/file');
  check('web_fetch: ftp:// отклонён', wfFtp.ok === false && /http/i.test(wfFtp.error || ''), wfFtp.error);
  const wfNoUrl = JSON.parse((await exec({ tool: 'web_fetch', args: {} })).body);
  check('web_fetch: без url — ошибка', wfNoUrl.ok === false && !!wfNoUrl.error, wfNoUrl.error);
  const wsNoQuery = JSON.parse((await exec({ tool: 'web_search', args: {} })).body);
  check('web_search: без query — ошибка', wsNoQuery.ok === false && !!wsNoQuery.error, wsNoQuery.error);
  const unkWeb = await exec({ tool: 'web_hack', args: {} });
  check('неизвестный веб-инструмент отклонён', unkWeb.status === 400);

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


  // 4d. вложения: чанковая загрузка любых размеров
  const initUp = JSON.parse((await req('POST', '/api/upload/init', JSON.stringify({ name: 'big-data.bin', size: 10 }), { 'content-type': 'application/json' })).body);
  check('upload/init: путь в zx-files', initUp.ok === true && initUp.path.includes('zx-files'), initUp.path);
  await req('PUT', '/api/upload/chunk?id=' + initUp.id, 'AAAAA', { 'content-type': 'application/octet-stream' });
  const up2 = await req('PUT', '/api/upload/chunk?id=' + initUp.id, 'BBBBB', { 'content-type': 'application/octet-stream' });
  check('upload/chunk: файл собран', up2.status === 200 && JSON.parse(up2.body).done === true);
  const rf2 = await exec({ tool: 'read_file', args: { path: initUp.path } });
  check('агент видит загруженный файл', JSON.parse(rf2.body).content === 'AAAAABBBBB');
  const rf3 = await exec({ tool: 'read_file', args: { path: initUp.path, offset: 5 } });
  check('read_file: чтение с offset', JSON.parse(rf3.body).content.startsWith('BBBBB'));
  const evilUp = JSON.parse((await req('POST', '/api/upload/init', JSON.stringify({ name: '../../evil.txt', size: 1 }), { 'content-type': 'application/json' })).body);
  check('upload: traversal нейтрализован', !evilUp.path.includes('..'), evilUp.path);

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
