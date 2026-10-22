// Браузерный смоук-тест на jsdom: загрузка UI, открытие чата,
// отправка сообщения, стрим ответа мок-провайдера, badge, меню моделей.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { JSDOM } = require('jsdom');

const PORT = 3312;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  });
  await sleep(600);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push([name, cond]);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  };

  // Стаб fetch: относительные URL → наш сервер; api.groq.com → мок-стрим; остальное → 403.
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();
  function sseResponse(text) {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const jsonResp = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

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
        if (url.startsWith('/')) return realFetch(BASE + url, init);
        if (url.includes('api.groq.com')) {
          if (url.endsWith('/models')) {
            return Promise.resolve(jsonResp({ data: [{ id: 'mock-120b' }, { id: 'mock-embed-x' }, { id: 'llama-70b' }] }));
          }
          return Promise.resolve(sseResponse('Привет из мока!'));
        }
        return Promise.resolve(new Response('{}', { status: 403 }));
      };
    },
  });

  const { window } = dom;
  await sleep(1200); // загрузка скриптов + boot

  const doc = window.document;
  check('boot: приветствие отрисовано', doc.querySelector('#greeting')?.textContent.length > 3, doc.querySelector('#greeting')?.textContent);
  check('boot: статус провайдеров', /готово провайдеров: \d/.test(doc.querySelector('#provStatus')?.textContent || ''), doc.querySelector('#provStatus')?.textContent);

  // меню моделей
  doc.querySelector('#modelPill').click();
  await sleep(400);
  const menuText = doc.querySelector('#modelMenu')?.textContent || '';
  check('меню: есть «Авто»', menuText.includes('Авто'));
  check('меню: живой список Groq подтянулся', menuText.includes('mock-120b'), menuText.slice(0, 120));

  // выбор конкретной модели
  const items = [...doc.querySelectorAll('#modelMenu .menu-item')];
  const mockItem = items.find((el) => el.textContent.includes('mock-120b'));
  mockItem?.click();
  await sleep(100);
  check('пилл обновился', doc.querySelector('#modelPillLabel')?.textContent.includes('mock-120b'));

  // отправка сообщения
  const input = doc.querySelector('#input');
  input.value = 'Тестовый вопрос';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#sendBtn').click();
  await sleep(900);

  const contents = [...doc.querySelectorAll('.msg-assistant .content')].map((e) => e.textContent).join('|');
  check('ответ замоканного провайдера отрисован', contents.includes('Привет из мока'), contents.slice(0, 80));
  const badge = doc.querySelector('.msg-badge')?.textContent || '';
  check('бейдж: Groq + модель', badge.includes('Groq') && badge.includes('mock-120b'), badge);
  check('бабл пользователя', [...doc.querySelectorAll('.msg-user .bubble')].some((e) => e.textContent === 'Тестовый вопрос'));

  // настройки
  doc.querySelector('#openSettingsBtn').click();
  await sleep(100);
  check('модалка настроек открылась', !doc.querySelector('#settingsModal').hidden);
  const groqInput = doc.querySelector('#keyRows input[data-pid="groq"]');
  check('ключ Groq подставлен из localStorage', groqInput?.value === 'test-key');
  doc.querySelector('#closeSettingsBtn').click();

  // сайдбар: чат с заголовком из первого сообщения
  check('чат в сайдбаре', [...doc.querySelectorAll('.chat-item .title')].some((e) => e.textContent.includes('Тестовый вопрос')));

  srv.kill();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${failed} тестов упало` : '\nВсе смоук-тесты прошли');
  window.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
