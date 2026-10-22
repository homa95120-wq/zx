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
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ZX_NO_OPEN: '1',
      ZX_WORKSPACE: WS_DIR,
      ZX_CONFIG: path.join(os.tmpdir(), 'zx-smoke-config.json'),
    },
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
  let lastCerebrasBody = '';
  let force429 = false;
  // сценарий веб-инструментов: поиск → чтение страницы → финальный ответ (моки)
  let webScenario = false;
  let webPhase = 0;
  // сценарий видеомонтажа: media_probe → media_render (ошибка) → media_render (успех) → media_probe → финальный ответ
  let videoScenario = false;
  let videoPhase = 0;
  // сценарий: 2 ПАРАЛЛЕЛЬНЫХ tool_calls в одном ответе (один — без index) +
  // на следующем шаге 503 ДО начала потока (ретрай + фейловер на Cerebras)
  let multiScenario = false;
  let multiGroqCalls = 0;
  const webSources = [
    { title: 'Погода в Амстердаме сегодня', url: 'https://example.com/weather', snippet: 'Сейчас +12 °C, облачно, ветер 5 м/с.' },
    { title: 'Amsterdam weather forecast', url: 'https://example.org/ams', snippet: 'Прогноз на неделю и карта осадков.' },
  ];

  const dom = await JSDOM.fromFile(path.join(__dirname, '..', 'public', 'index.html'), {
    url: BASE + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.TextEncoder = TextEncoder;
      window.localStorage.setItem('zx.keys', JSON.stringify({ groq: 'test-key', cerebras: 'test-key' }));
      window.fetch = (input, init) => {
        const url = String(input instanceof Object ? input.url : input);
        if (url.startsWith('/api/proxy') && typeof init?.body === 'string' && init.body.includes('ovh')) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'upstream blocked in test' }), { status: 502, headers: { 'content-type': 'application/json' } }));
        }
        // инструменты поиска/чтения и видео замоканы для UI-смоука
        if (url.startsWith('/api/tools/exec') && typeof init?.body === 'string') {
          let toolBody = null;
          try { toolBody = JSON.parse(init.body); } catch {}
          if (toolBody?.tool === 'web_search') {
            return Promise.resolve(jsonResp({ ok: true, query: toolBody.args.query, results: webSources }));
          }
          if (toolBody?.tool === 'web_fetch') {
            return Promise.resolve(jsonResp({
              ok: true, url: toolBody.args.url, total: 67, offset: 0, truncated: false,
              content: 'Погода в Амстердаме: +12 °C, облачно. Ветер 5 м/с. Подробный прогноз на неделю.',
            }));
          }
          if (toolBody?.tool === 'media_probe') {
            const p = String(toolBody.args.path || '');
            if (p.includes('out.mp4')) {
              return Promise.resolve(jsonResp({
                ok: true,
                path: path.join(WS_DIR, 'out.mp4'),
                duration: 10,
                sizeBytes: 1572864,
                format: 'mov,mp4',
                hasVideo: true,
                hasAudio: true,
                streams: [
                  { type: 'video', codec: 'h264', width: 1280, height: 720, fps: 30, bitrate: 1100000, sampleRate: null, channels: null },
                  { type: 'audio', codec: 'aac', width: null, height: null, fps: null, bitrate: 128000, sampleRate: 48000, channels: 2 },
                ],
              }));
            }
            return Promise.resolve(jsonResp({
              ok: true,
              path: path.join(WS_DIR, 'raw.mp4'),
              duration: 42.5,
              sizeBytes: 8388608,
              format: 'mov,mp4',
              hasVideo: true,
              hasAudio: true,
              streams: [
                { type: 'video', codec: 'h264', width: 1920, height: 1080, fps: 30, bitrate: 2500000, sampleRate: null, channels: null },
                { type: 'audio', codec: 'aac', width: null, height: null, fps: null, bitrate: 192000, sampleRate: 48000, channels: 2 },
              ],
              scenes: [{ time: 3.12, score: 0.45 }, { time: 14.8, score: 0.61 }],
            }));
          }
          if (toolBody?.tool === 'media_render') {
            const arr = Array.isArray(toolBody.args?.args) ? toolBody.args.args : [];
            if (arr.includes('bad-preset')) {
              return Promise.resolve(jsonResp({
                ok: false,
                exitCode: 1,
                outPath: path.join(WS_DIR, 'out.mp4'),
                error: 'ошибка ffmpeg (код 1): Unrecognized option bad-preset',
                progress: { seconds: 0, fps: null, speed: null },
                durationMs: 120,
                timedOut: false,
                log: 'Input #0, mov,mp4, from raw.mp4\n[error] Unrecognized option bad-preset\nError splitting the argument list',
              }));
            }
            return Promise.resolve(jsonResp({
              ok: true,
              exitCode: 0,
              outPath: path.join(WS_DIR, 'out.mp4'),
              sizeBytes: 1572864,
              progress: { seconds: 10, percent: 23.5, fps: 95, speed: '3.17x' },
              durationMs: 3150,
              timedOut: false,
              log: 'Input #0, mov,mp4, from raw.mp4\nStream mapping:\n  Stream #0:0 -> #0:0 (h264 -> libx264)\nframe= 300 fps=95.0 Lsize= 1536KiB time=00:00:10.00 speed=3.17x\nmuxing overhead: 0.5%',
            }));
          }
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
          if (multiScenario) {
            multiGroqCalls++;
            if (multiGroqCalls === 1) {
              // 2 tool_calls в ОДНОМ ответе: list_dir (index 0) + run_terminal
              // (БЕЗ index, аргументы по чанкам — стиль OVH/vLLM/Qwen3)
              return Promise.resolve(sse([
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_m1', function: { name: 'list_dir', arguments: '{}' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ id: 'call_m2', function: { name: 'run_terminal', arguments: '{"comm' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ function: { arguments: 'and": "echo multi-tool-ok"}' } }] } }] },
              ]));
            }
            // следующий шаг: 503 ДО начала потока (оригинал + ретрай) → фейловер
            return Promise.resolve(new Response(JSON.stringify({ error: { message: 'upstream overloaded (mock 503)' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
          }
          if (videoScenario) {
            videoPhase++;
            const toolCall = (name, args) => sse([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_v_' + videoPhase, function: { name, arguments: JSON.stringify(args) } }] } }] },
            ]);
            if (videoPhase === 1) return Promise.resolve(toolCall('media_probe', { path: 'raw.mp4', scenes: true }));
            if (videoPhase === 2) {
              return Promise.resolve(toolCall('media_render', {
                args: ['-i', 'raw.mp4', '-preset', 'bad-preset', 'out.mp4'],
              }));
            }
            if (videoPhase === 3) {
              return Promise.resolve(toolCall('media_render', {
                args: ['-i', 'raw.mp4', '-ss', '00:00:03', '-t', '10', '-vf', 'scale=1280:720', '-c:v', 'libx264', '-c:a', 'aac', 'out.mp4'],
              }));
            }
            if (videoPhase === 4) return Promise.resolve(toolCall('media_probe', { path: 'out.mp4' }));
            return Promise.resolve(sse([{
              choices: [{ delta: { content: `Готово! Видео смонтировано и проверено: \`${path.join(WS_DIR, 'out.mp4')}\` (10 с, 1280x720).` } }],
            }]));
          }
          if (webScenario) {
            webPhase++;
            const toolCall = (name, args) => sse([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + name, function: { name, arguments: JSON.stringify(args) } }] } }] },
            ]);
            if (webPhase === 1) return Promise.resolve(toolCall('web_search', { query: 'погода в Амстердаме', limit: 3 }));
            if (webPhase === 2) return Promise.resolve(toolCall('web_fetch', { url: 'https://example.com/weather' }));
            return Promise.resolve(sse([{ choices: [{ delta: { content: 'По данным поиска, в Амстердаме сейчас +12 °C, облачно. Источник: https://example.com/weather' } }] }]));
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
        if (url.includes('api.cerebras.ai')) {
          if (url.endsWith('/models')) {
            return Promise.resolve(jsonResp({ data: [{ id: 'mock-cerebras-70b' }] }));
          }
          if (multiScenario) {
            if (typeof init?.body === 'string') lastCerebrasBody = init.body;
            // следующий провайдер в цепочке: дописывает финальный ответ
            return Promise.resolve(sse([{ choices: [{ delta: { content: 'Готово: оба инструмента выполнены, echo вывел multi-tool-ok.' } }] }]));
          }
          return Promise.resolve(new Response(JSON.stringify({ error: { message: 'mock busy (сценарий не активен)' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
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

  // ---- веб-инструменты: поиск → чтение страницы (мок выдачи) ----
  webScenario = true;
  webPhase = 0;
  input.value = 'Найди в интернете погоду в Амстердаме и открой лучшую страницу';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#sendBtn').click();
  await sleep(800);

  check('веб: инструменты и промпт ушли в модель',
    lastChatBody.includes('"web_search"') && lastChatBody.includes('"web_fetch"') && lastChatBody.includes('web_search и web_fetch'));
  check('веб: модалка подтверждения для web_search', !doc.querySelector('#approveModal').hidden
    && (doc.querySelector('#apDetail')?.textContent || '').includes('погода в Амстердаме'), doc.querySelector('#apDetail')?.textContent);
  doc.querySelector('#apAllowBtn').click();
  await sleep(1000);

  check('веб: модалка подтверждения для web_fetch', !doc.querySelector('#approveModal').hidden
    && (doc.querySelector('#apDetail')?.textContent || '').includes('https://example.com/weather'), doc.querySelector('#apDetail')?.textContent);
  doc.querySelector('#apAllowBtn').click();
  await sleep(1800);

  const webCards = [...doc.querySelectorAll('.tool-card')].map((e) => e.textContent).join(' | ');
  check('веб: карточка поиска — запрос и число результатов',
    webCards.includes('Поиск в интернете') && webCards.includes('погода в Амстердаме') && webCards.includes('2 рез.'), webCards.slice(-400));
  check('веб: карточка web_fetch — URL',
    webCards.includes('Читаю страницу') && webCards.includes('https://example.com/weather'), webCards.slice(-300));
  check('веб: «подробнее» показывает сниппеты',
    webCards.includes('Погода в Амстердаме сегодня') && webCards.includes('Сейчас +12 °C'), webCards.slice(-400));
  check('веб: «подробнее» показывает текст страницы', webCards.includes('Ветер 5 м/с'), webCards.slice(-300));

  const webAnswer = [...doc.querySelectorAll('.msg-assistant .content')].map((e) => e.textContent).join('|');
  check('веб: финальный ответ со ссылкой на источник',
    webAnswer.includes('+12 °C') && webAnswer.includes('https://example.com/weather'), webAnswer.slice(-200));

  // ---- видеомонтаж: media_probe → media_render (ошибка + успех) → media_probe ----
  webScenario = false;
  videoScenario = true;
  videoPhase = 0;
  input.value = 'Обрежь raw.mp4 с 3-й секунды на 10 секунд в 720p и сохрани в out.mp4';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#sendBtn').click();
  await sleep(700);

  check('видео: схемы и системный промпт ушли в модель',
    lastChatBody.includes('"media_probe"') && lastChatBody.includes('"media_render"') && lastChatBody.includes('Для видео используй media_probe'));
  check('видео: подтверждение media_probe показывает путь к файлу',
    !doc.querySelector('#approveModal').hidden
    && (doc.querySelector('#apToolName')?.textContent || '').includes('Смотрю видео')
    && (doc.querySelector('#apDetail')?.textContent || '').includes('raw.mp4'),
    doc.querySelector('#apDetail')?.textContent);
  doc.querySelector('#apAllowBtn').click();
  await sleep(700);

  // Шаг 2: неудачный media_render (проверим и подтверждение, и автораскрытие лога при ошибке)
  check('видео: подтверждение media_render (попытка 1)',
    !doc.querySelector('#approveModal').hidden
    && (doc.querySelector('#apToolName')?.textContent || '').includes('Монтирую видео')
    && (doc.querySelector('#apDetail')?.textContent || '').includes('ffmpeg -i raw.mp4 -preset bad-preset out.mp4'),
    doc.querySelector('#apDetail')?.textContent);
  doc.querySelector('#apAllowBtn').click();
  await sleep(700);

  // Шаг 3: успешный media_render — проверяем полную команду ffmpeg + выходной файл в модалке
  const renderApText = doc.querySelector('#apDetail')?.textContent || '';
  check('видео: в модалке подтверждения полная команда ffmpeg и выходной файл',
    !doc.querySelector('#approveModal').hidden
    && renderApText.includes('ffmpeg -i raw.mp4 -ss 00:00:03 -t 10 -vf scale=1280:720 -c:v libx264 -c:a aac out.mp4')
    && renderApText.includes('выходной файл: out.mp4'),
    renderApText);
  doc.querySelector('#apAllowBtn').click();
  await sleep(700);

  // Шаг 4: контрольный media_probe по out.mp4
  check('видео: контрольный media_probe по out.mp4',
    !doc.querySelector('#approveModal').hidden
    && (doc.querySelector('#apDetail')?.textContent || '').includes('out.mp4'),
    doc.querySelector('#apDetail')?.textContent);
  doc.querySelector('#apAllowBtn').click();
  await sleep(1200);

  const allVideoCards = [...doc.querySelectorAll('.tool-card')];
  const videoCardsText = allVideoCards.map((e) => e.textContent).join(' | ');
  check('видео: карточка «Смотрю видео» (длительность/разрешение/кодеки/сцены + таймкоды)',
    videoCardsText.includes('Смотрю видео') && videoCardsText.includes('raw.mp4')
    && videoCardsText.includes('1920x1080') && videoCardsText.includes('h264/aac')
    && videoCardsText.includes('2 сцен') && videoCardsText.includes('3.12с'),
    videoCardsText.slice(-500));
  check('видео: карточка «Монтирую видео» (файл/длительность/speed/размер + лог ffmpeg)',
    videoCardsText.includes('Монтирую видео') && videoCardsText.includes('out.mp4')
    && videoCardsText.includes('3.17x') && videoCardsText.includes('1.5 МБ')
    && videoCardsText.includes('muxing overhead: 0.5%'),
    videoCardsText.slice(-500));
  const errRenderCard = allVideoCards.find((el) => el.classList.contains('tool-err') && el.textContent.includes('Монтирую видео'));
  check('видео: при ошибке рендера лог раскрыт автоматически (details[open])',
    !!errRenderCard && errRenderCard.querySelector('details')?.hasAttribute('open') === true
    && errRenderCard.textContent.includes('Unrecognized option bad-preset'));

  const videoAnswer = [...doc.querySelectorAll('.msg-assistant .content')].map((e) => e.textContent).join('|');
  check('видео: финальный ответ агента с путём к файлу',
    videoAnswer.includes(path.join(WS_DIR, 'out.mp4')) && videoAnswer.includes('1280x720'),
    videoAnswer.slice(-220));

  // ---- параллельные tool_calls + 503 до потока → ретрай + фейловер ----
  videoScenario = false;
  multiScenario = true;
  multiGroqCalls = 0;
  input.value = 'Посмотри список файлов и выполни echo multi-tool-ok';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#sendBtn').click();
  await sleep(700);

  check('multi: модалка первого инструмента (list_dir)', !doc.querySelector('#approveModal').hidden
    && (doc.querySelector('#apToolName')?.textContent || '').includes('Список файлов'), doc.querySelector('#apToolName')?.textContent);
  doc.querySelector('#apAllowBtn').click();
  await sleep(500);

  check('multi: модалка второго инструмента (стрим без index)', !doc.querySelector('#approveModal').hidden
    && (doc.querySelector('#apDetail')?.textContent || '').includes('echo multi-tool-ok'), doc.querySelector('#apDetail')?.textContent);
  doc.querySelector('#apAllowBtn').click();
  // далее: 503 до потока → ретрай ~1.5с → 503 → фейловер на Cerebras (финальный ответ)
  await sleep(3000);

  const lastMsg = [...doc.querySelectorAll('.msg-assistant')].pop();
  const multiCards = lastMsg ? [...lastMsg.querySelectorAll('.tool-card')].map((e) => e.textContent).join(' | ') : '';
  check('multi: 2 карточки — list_dir и терминал', multiCards.includes('Список файлов') && multiCards.includes('echo multi-tool-ok'), multiCards.slice(0, 220));
  check('multi: обе ✓, без зависшего ⏳', (multiCards.match(/✓/g) || []).length >= 2 && !multiCards.includes('⏳'), multiCards.slice(-140));

  const multiAnswer = lastMsg ? [...lastMsg.querySelectorAll('.content')].map((e) => e.textContent).join('') : '';
  check('multi: финальный ответ после 503 (ретрай/следующий провайдер)', multiAnswer.includes('multi-tool-ok'), multiAnswer.slice(-160));

  const multiBadge = lastMsg?.querySelector('.msg-badge')?.textContent || '';
  check('multi: бейдж показывает обход провайдера', multiBadge.includes('↻'), multiBadge);

  // следующий провайдер получил ПОЛНУЮ историю: assistant с 2 tool_calls + 2 результата
  let multiBody = null;
  try { multiBody = JSON.parse(lastChatBody); } catch {}
  const multiAsst = (multiBody?.messages || []).find((msg) => msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length === 2);
  check('multi: в истории assistant с 2 tool_calls', !!multiAsst, lastChatBody.slice(0, 160));
  const multiTools = (multiBody?.messages || []).filter((msg) => msg.role === 'tool');
  check('multi: 2 tool-результата с корректными id', multiTools.length === 2 && multiTools.map((t) => t.tool_call_id).join(',') === 'call_m1,call_m2', JSON.stringify(multiTools.map((t) => t.tool_call_id)));

  // следующий провайдер (Cerebras) получил накопленную историю целиком —
  // выполненные шаги не потерялись и не запускались повторно
  let cereBody = null;
  try { cereBody = JSON.parse(lastCerebrasBody); } catch {}
  const cereAsst = (cereBody?.messages || []).find((msg) => msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length === 2);
  const cereTools = (cereBody?.messages || []).filter((msg) => msg.role === 'tool');
  check('multi: следующий провайдер получил накопленную историю (2 tool_calls + 2 результата)',
    !!cereAsst && cereTools.length === 2 && cereTools.map((t) => t.tool_call_id).join(',') === 'call_m1,call_m2',
    lastCerebrasBody.slice(0, 120));

  // ---- дневной лимит: запоминается и провайдер обходится ----
  videoScenario = false;
  multiScenario = false;
  webScenario = false;
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
