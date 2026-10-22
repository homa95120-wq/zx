// Браузерный смоук-тест на jsdom: загрузка UI, чат, выбор модели, настройки,
// и агентский сценарий: модель вызывает run_terminal → подтверждение →
// выполнение на реальном сервере → финальный ответ + карточка действия.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { JSDOM } = require('jsdom');

const PORT = 3312;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_DIR = path.join(os.tmpdir(), 'zx-ws-smoke');
const WS_DIR2 = path.join(os.tmpdir(), 'zx-ws-smoke-2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.rmSync(WS_DIR2, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ZX_NO_OPEN: '1', ZX_WORKSPACE: WS_DIR },
  });
  await sleep(600);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push([name, cond]);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 140) : ''}`);
  };

  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();

  function sse(deltas) {
    const stream = new ReadableStream({
      start(c) {
        for (const d of deltas) c.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const jsonResp = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

  let chatCalls = 0;
  let lastChatBody = '';
  let force429 = false;

  const dom = await JSDOM.fromFile(path.join(__dirname, '..', 'public', 'index.html'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.TextEncoder = TextEncoder;
      window.localStorage.setItem('zx.keys', JSON.stringify({ groq: 'test-key' }));
      window.fetch = (input, init) => {
        const url = String(input instanceof Object ? input.url : input);
        if (url.startsWith('/api/proxy') && typeof init?.body === 'string' && init.body.includes('ovh')) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'upstream blocked in test' }), { status: 502, headers: { 'content-type': 'application/json' } }));
        }
        if (url.startsWith('/')) return realFetch(BASE + url, init);
        if (url.includes('api.groq.com')) {
          if (url.endsWith('/models')) {
            return Promise.resolve(jsonResp({ data: [{ id: 'mock-120b' }, { id: 'mock-embed-x' }, { id: 'llama-70b' }] }));
          }
          chatCalls++;
          if (typeof init?.body === 'string') lastChatBody = init.body;
          if (force429) {
            return Promise.resolve(new Response(JSON.stringify({ error: { message: 'rate limit: daily quota exceeded, try tomorrow' } }), { status: 429, headers: { 'content-type': 'application/json' } }));
          }
          if (chatCalls === 1) {
            // первый заход: модель вызывает инструмент
            return Promise.resolve(sse([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_terminal', arguments: '{"command":' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"echo agent-ok"}' } }] } }] },
            ]));
          }
          // второй заход: финальный текст
          return Promise.resolve(sse([{ choices: [{ delta: { content: 'Готово: команда вывела agent-ok.' } }] }]));
        }
        return Promise.resolve(new Response('{}', { status: 403 }));
      };
    },
  });

  const { window } = dom;
  const doc = window.document;
  await sleep(1200);

  check('boot: приветствие отрисовано', doc.querySelector('#greeting')?.textContent.length > 3, doc.querySelector('#greeting')?.textContent);
  check('boot: статус провайдеров', /бесплатно: \d/.test(doc.querySelector('#provStatus')?.textContent || ''), doc.querySelector('#provStatus')?.textContent);
  check('boot: рабочая папка агента в подсказке', (doc.querySelector('#composerHint')?.textContent || '').includes(WS_DIR), doc.querySelector('#composerHint')?.textContent);

  // меню моделей
  doc.querySelector('#modelPill').click();
  await sleep(400);
  const menuText = doc.querySelector('#modelMenu')?.textContent || '';
  check('меню: есть «Авто»', menuText.includes('Авто'));
  check('меню: живой список Groq подтянулся', menuText.includes('mock-120b'));
  check('меню: топ-модели Claude/GPT присутствуют', menuText.includes('Claude') && menuText.includes('ChatGPT'), menuText.slice(-160));
  doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);

  // отправка сообщения → агентский цикл
  const input = doc.querySelector('#input');
  input.value = 'Выполни echo agent-ok и расскажи, что вышло';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#sendBtn').click();
  await sleep(700);

  // модалка подтверждения
  const modal = doc.querySelector('#approveModal');
  check('модалка подтверждения показана', modal && !modal.hidden);
  check('в модалке команда', (doc.querySelector('#apDetail')?.textContent || '').includes('echo agent-ok'), doc.querySelector('#apDetail')?.textContent);

  doc.querySelector('#apAllowBtn').click();
  await sleep(1500);

  const cardText = [...doc.querySelectorAll('.tool-card')].map((e) => e.textContent).join(' | ');
  check('карточка действия: echo agent-ok', cardText.includes('echo agent-ok'), cardText);
  check('карточка действия: успешно', cardText.includes('✓'), cardText);

  const contents = [...doc.querySelectorAll('.msg-assistant .content')].map((e) => e.textContent).join('|');
  check('финальный ответ модели', contents.includes('Готово: команда вывела agent-ok'), contents.slice(0, 100));

  const badge = [...doc.querySelectorAll('.msg-badge')].map((e) => e.textContent).join(' ');
  check('бейдж: Groq + действия', badge.includes('Groq') && badge.includes('1 действ'), badge);

  // файл реально создан? (echo не создаёт; проверим инструмент напрямую через сервер)
  const execRes = await realFetch(BASE + '/api/tools/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'write_file', args: { path: 'smoke.txt', content: 'ok' } }),
  });
  check('сервер исполняет write_file в workspace', execRes.ok && fs.existsSync(path.join(WS_DIR, 'smoke.txt')));

  // ---- вложения файлов ----
  const file = new window.File(['строка-1\nстрока-2'], 'note.txt', { type: 'text/plain' });
  const fi = doc.querySelector('#fileInput');
  Object.defineProperty(fi, 'files', { value: [file], configurable: true });
  fi.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(900);
  check('чип вложения появился', [...doc.querySelectorAll('#attachRow .attach-chip')].some((e) => e.textContent.includes('note.txt')));
  check('файл загружен в zx-files', fs.existsSync(path.join(WS_DIR, 'zx-files', 'note.txt')));

  input.value = 'Что внутри приложенного файла?';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#sendBtn').click();
  await sleep(900);
  check('чип вложения в сообщении', [...doc.querySelectorAll('.msg-user .attach-chip')].some((e) => e.textContent.includes('note.txt')));
  check('мелкий текст авто-вшит в контекст модели', lastChatBody.includes('Файл: note.txt') && lastChatBody.includes('строка-2'));

  // ---- дневной лимит: запоминается и провайдер обходится ----
  force429 = true;
  input.value = 'Ещё один вопрос';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#sendBtn').click();
  await sleep(1500);
  const lim = JSON.parse(window.localStorage.getItem('zx.limits') || '{}');
  check('дневной лимит Groq запомнен', (lim.groq?.until || 0) > Date.now(), JSON.stringify(lim));
  check('бейдж показывает обход', [...doc.querySelectorAll('.msg-badge')].some((e) => e.textContent.includes('↻')));
  check('агент объяснил исчерпание лимитов', [...doc.querySelectorAll('.error-card')].some((e) => e.textContent.includes('Никто из цепочки')));

  // смена рабочей папки через UI
  doc.querySelector('#wsBtn').click();
  await sleep(100);
  const wsModal = doc.querySelector('#wsModal');
  check('модалка папки открылась', wsModal && !wsModal.hidden);
  const wsInput = doc.querySelector('#wsPath');
  wsInput.value = WS_DIR2;
  doc.querySelector('#wsCreate').checked = true;
  doc.querySelector('#wsApplyBtn').click();
  await sleep(1200);

  check('модалка папки закрылась после выбора', wsModal.hidden);
  check('подсказка показывает новую папку', (doc.querySelector('#composerHint')?.textContent || '').includes('zx-ws-smoke-2'), doc.querySelector('#composerHint')?.textContent);
  check('контекст-файл создан в новой папке', fs.existsSync(path.join(WS_DIR2, 'zx-context.json')), 'zx-context.json');
  const savedCtx = JSON.parse(fs.readFileSync(path.join(WS_DIR2, 'zx-context.json'), 'utf8'));
  check('в контексте есть чат', Array.isArray(savedCtx.chats) && savedCtx.chats.some((c) => (c.title || '').includes('Выполни echo')));

  // настройки
  doc.querySelector('#openSettingsBtn').click();
  await sleep(100);
  check('модалка настроек открылась', !doc.querySelector('#settingsModal').hidden);
  const paidRows = [...doc.querySelectorAll('#keyRows .key-free.paid')];
  check('в настройках есть платные Claude/GPT', paidRows.length === 2, paidRows.map((e) => e.textContent).join(','));
  doc.querySelector('#closeSettingsBtn').click();

  check('чат в сайдбаре', [...doc.querySelectorAll('.chat-item .title')].some((e) => e.textContent.includes('Выполни echo')));

  srv.kill();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${failed} тестов упало` : '\nВсе смоук-тесты прошли');
  window.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
