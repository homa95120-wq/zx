'use strict';
/* ============================================================
   zx — ИИ-агент для кода (UI в духе claude.ai)
   - чат на бесплатных провайдерах (авто-фейловер при лимитах)
     и топовых Claude / GPT по собственному ключу
   - режим агента: модель вызывает инструменты (терминал,
     чтение/запись файлов, список папки), сервер исполняет их
     локально; каждое действие подтверждается в UI
   - ключи живут только в localStorage браузера
   ============================================================ */

const $ = (s) => document.querySelector(s);
const LS = { chats: 'zx.chats', keys: 'zx.keys', settings: 'zx.settings', models: 'zx.models' };

/* ---------------- состояние ---------------- */
let CAT = { providers: [], priority: [] };
let WS = { workspace: '', platform: 'unknown', node: '' };
let chats = [];
let curId = null;
let keys = {};
let settings = {
  model: 'auto',
  system: '',
  custom: { url: '', key: '', model: '' },
  agent: { enabled: true, ask: true },
};
let modelsCache = {};
let streaming = null;
let sessionAllowAll = false;

const CUSTOM_PROVIDER = () => ({
  id: 'custom',
  name: 'Свой endpoint',
  baseUrl: (settings.custom.url || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, ''),
  keyUrl: '',
  keyless: false,
  free: 'ваш релей',
  note: 'Любой OpenAI-совместимый endpoint',
  picks: settings.custom.model ? [settings.custom.model] : [],
  filter: /embed|rerank/i,
  onlyFree: false,
  custom: true,
});

const byId = (pid) => (pid === 'custom' ? CUSTOM_PROVIDER() : CAT.providers.find((p) => p.id === pid));

/* ---------------- инструменты агента ---------------- */
const TOOLS_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description: 'Выполнить команду в терминале на машине пользователя (bash в Linux/macOS, cmd в Windows) и получить stdout/stderr/код выхода. Используй для сборки, тестов, git, установки пакетов.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'команда для выполнения' },
          cwd: { type: 'string', description: 'подпапка рабочей области (необязательно)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать текстовый файл с диска пользователя.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'путь к файлу (относительный рабочей папки или абсолютный)' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Создать или полностью перезаписать текстовый файл. Папки создаются автоматически.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'путь к файлу' },
          content: { type: 'string', description: 'полное содержимое файла' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Показать список файлов и папок.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'папка (по умолчанию рабочая)' } },
        required: [],
      },
    },
  },
];

const TOOL_LABELS = { run_terminal: 'Терминал', read_file: 'Читаю файл', write_file: 'Пишу файл', list_dir: 'Список файлов' };

function agentSystem() {
  if (!settings.agent?.enabled || !WS.workspace) return '';
  return [
    'Ты — zx, агент-помощник по программированию, работающий на машине пользователя.',
    `Рабочая папка: ${WS.workspace} (платформа: ${WS.platform}).`,
    'Доступные инструменты: run_terminal (команды терминала), read_file, write_file, list_dir.',
    'Перед правками сначала смотри реальные файлы (read_file/list_dir), не выдумывай их содержимое.',
    'После изменений запускай проверки (тесты/сборку) через run_terminal и разбирай ошибки.',
    'Каждое действие пользователь подтверждает вручную. Отвечай кратко, по делу, на русском.',
  ].join(' ');
}

/* ---------------- утилиты ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function persistChats() {
  save(LS.chats, { chats: chats.slice(0, 60), curId });
  saveContext();
}

/* Контекст (чаты + настройки) дублируется в файл zx-context.json
   внутри рабочей папки агента — «вся работа хранится в выбранной папке». */
let ctxSaving = false, ctxDirty = false;
function saveContext() {
  if (!WS.workspace) return;
  if (ctxSaving) { ctxDirty = true; return; }
  ctxSaving = true;
  fetch('/api/store/chats', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chats: chats.slice(0, 60),
      curId,
      settings: { model: settings.model, system: settings.system, agent: settings.agent },
    }),
  }).catch(() => {}).finally(() => {
    ctxSaving = false;
    if (ctxDirty) { ctxDirty = false; saveContext(); }
  });
}

function applyServerContext(data) {
  if (!data || !Array.isArray(data.chats)) return false;
  chats = data.chats;
  curId = data.curId && chats.find((c) => c.id === data.curId) ? data.curId : (chats[0]?.id || null);
  if (data.settings) {
    if (data.settings.model !== undefined) settings.model = data.settings.model;
    if (typeof data.settings.system === 'string') settings.system = data.settings.system;
    if (data.settings.agent) settings.agent = Object.assign({}, settings.agent, data.settings.agent);
  }
  return true;
}
const curChat = () => chats.find((c) => c.id === curId) || null;

let toastTimer = null;
function toast(text, isErr = false, ms = 3400) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function greetingText() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Доброе утро';
  if (h >= 12 && h < 18) return 'Добрый день';
  if (h >= 18 && h < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

/* ---------------- markdown ---------------- */
const codeStore = new Map();
let codeSeq = 0;

function codeRenderer(a, b) {
  const tok = typeof a === 'object' && a !== null ? a : { text: String(a ?? ''), lang: b };
  const lang = (tok.lang || '').split(/\s+/)[0] || 'код';
  const id = 'c' + (++codeSeq);
  codeStore.set(id, tok.text);
  return `<div class="codeblock"><div class="codeblock-head"><span>${esc(lang)}</span>` +
    `<button class="codeblock-copy" data-code-id="${id}">Копировать</button></div>` +
    `<pre><code>${esc(tok.text)}</code></pre></div>`;
}
marked.use({ renderer: { code: codeRenderer }, breaks: true, gfm: true });

if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener'); }
  });
}

function splitThink(src) {
  const i = src.indexOf('<think>');
  if (i === -1) return { think: '', body: src };
  const close = src.indexOf('</think>', i);
  const think = close === -1 ? src.slice(i + 7) : src.slice(i + 7, close);
  const body = close === -1 ? src.slice(0, i) : src.slice(0, i) + src.slice(close + 8);
  return { think: think.trim(), body };
}

function renderMarkdown(text, extraThink = '') {
  const { think: tTag, body } = splitThink(text);
  const think = [extraThink, tTag].filter(Boolean).join('\n');
  let html = '';
  if (think) html += `<details class="think"><summary>Размышления модели</summary><div class="think-body">${esc(think)}</div></details>`;
  const raw = marked.parse(body || '');
  html += window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
  return html;
}

/* ---------------- карточки действий агента ---------------- */
function toolCardHtml(st) {
  const label = TOOL_LABELS[st.tool] || st.tool;
  let short = '', detail = '';
  if (st.tool === 'run_terminal') {
    short = '$ ' + st.args.command;
    detail = [st.result?.stdout, st.result?.stderr].filter(Boolean).join('\n');
  } else if (st.tool === 'write_file') {
    short = st.args.path + ` (${(st.args.content || '').length} симв.)`;
    detail = (st.args.content || '').split('\n').slice(0, 12).join('\n');
  } else {
    short = st.args.path || '.';
    detail = st.tool === 'read_file' ? String(st.result?.content || '').split('\n').slice(0, 12).join('\n')
      : (st.result?.entries || []).join('  ');
  }
  const status = st.pending ? '⏳' : (st.denied ? '✕ отклонено' : (st.ok ? '✓' : '✗ код ' + (st.result?.exitCode ?? '?')));
  return `<div class="tool-card ${st.ok === false && !st.pending && !st.denied ? 'tool-err' : ''}">` +
    `<div class="tool-head"><span class="tool-ico">⚙</span><b>${esc(label)}</b>` +
    `<span class="tool-args">${esc(short.length > 110 ? short.slice(0, 110) + '…' : short)}</span>` +
    `<span class="tool-status">${status}</span></div>` +
    (detail ? `<details${st.ok === false ? ' open' : ''}><summary>подробнее</summary><pre>${esc(detail.slice(0, 4000))}</pre></details>` : '') +
    `</div>`;
}

function stepsHtml(m) {
  if (!m.steps?.length) return '';
  return `<div class="steps">${m.steps.map(toolCardHtml).join('')}</div>`;
}

/* ---------------- чаты ---------------- */
function newChat(silent = false) {
  if (streaming) stopStreaming();
  const c = { id: uid(), title: 'Новый чат', createdAt: Date.now(), messages: [] };
  chats.unshift(c);
  curId = c.id;
  persistChats();
  renderAll();
  $('#input').focus();
  if (!silent) $('#main').classList.add('centered');
}

function openChat(id) {
  if (streaming && streaming.chatId !== id) stopStreaming();
  curId = id;
  persistChats();
  renderAll();
  closeSidebar();
}

function deleteChat(id, ev) {
  ev.stopPropagation();
  chats = chats.filter((c) => c.id !== id);
  if (curId === id) {
    curId = chats[0]?.id || null;
    if (!curId) newChat(true);
  }
  persistChats();
  renderAll();
}

/* ---------------- рендер ---------------- */
function renderAll() {
  renderSidebar();
  renderThread();
  renderProvStatus();
  renderModelPill();
  renderAgentChip();
  $('#main').classList.toggle('centered', !curChat() || curChat().messages.length === 0);
}

function renderSidebar() {
  const list = $('#chatList');
  if (!chats.length) { list.innerHTML = '<div class="chat-empty">История пуста</div>'; return; }
  list.innerHTML = chats.map((c) => `
    <div class="chat-item ${c.id === curId ? 'active' : ''}" data-id="${c.id}" title="${esc(c.title)}">
      <span class="title">${esc(c.title)}</span>
      <button class="del" title="Удалить">✕</button>
    </div>`).join('');
  list.querySelectorAll('.chat-item').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.del')) deleteChat(el.dataset.id, e);
      else openChat(el.dataset.id);
    };
  });
}

function msgHtml(m, i) {
  if (m.role === 'user') {
    return `<div class="msg-user" data-i="${i}"><div class="bubble">${esc(m.content)}</div></div>`;
  }
  const actions = `
    <div class="meta-row">
      <span class="msg-badge">${m.badge || ''}</span>
      <div class="msg-actions">
        <button class="icon-btn act-copy" title="Скопировать"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M9 9h10v12H9zM5 15V3h10"/></svg></button>
        <button class="icon-btn act-regen" title="Переписать ответ"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M4 10a8 8 0 1 1 2 6.5M4 10V4m0 6h6"/></svg></button>
      </div>
    </div>`;
  const err = m.error ? `<div class="error-card">${m.error}</div>` : '';
  const bodyHtml = (m.content || '').trim()
    ? renderMarkdown(m.content, m.think)
    : (m.error ? '' : '<span class="cursor"></span>');
  return `<div class="msg-assistant" data-i="${i}">${err}${stepsHtml(m)}<div class="content">${bodyHtml}</div>${actions}</div>`;
}

function badgeFor(m) {
  const parts = [];
  if (m.provider) parts.push(esc(m.provider));
  if (m.model) parts.push(`<span style="font-family:ui-monospace,Menlo,monospace;font-size:11px">${esc(m.model)}</span>`);
  if (m.ms) parts.push(((m.ms) / 1000).toFixed(1) + ' с');
  if (m.stopped) parts.push('остановлено');
  if (m.steps?.length) parts.push(`⚙ ${m.steps.length} действ.`, );
  if (m.failovers?.length) {
    parts.push(`<span title="${esc(m.failovers.map((x) => `${x.provider} (${x.reason})`).join(' → '))}">↻ обход: ${esc(m.failovers.map((x) => x.provider).join(' → '))}</span>`);
  }
  return parts.join(' · ');
}

function renderThread() {
  const c = curChat();
  $('#greeting').textContent = greetingText();
  const wrap = $('#messages');
  if (!c) { wrap.innerHTML = ''; return; }
  codeStore.clear();
  wrap.innerHTML = c.messages.map((m, i) => msgHtml(m, i)).join('');
  bindMsgActions(wrap);
  scrollBottom(true);
}

function bindMsgActions(wrap) {
  wrap.querySelectorAll('.msg-assistant').forEach((el) => {
    const i = Number(el.dataset.i);
    const c = curChat(); if (!c) return;
    const m = c.messages[i];
    el.querySelector('.act-copy')?.addEventListener('click', () => {
      navigator.clipboard.writeText(m.content || '').then(() => toast('Скопировано'));
    });
    el.querySelector('.act-regen')?.addEventListener('click', () => regenerate());
  });
  wrap.querySelectorAll('.codeblock-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = codeStore.get(btn.dataset.codeId) || '';
      navigator.clipboard.writeText(code).then(() => { btn.textContent = 'Скопировано'; setTimeout(() => (btn.textContent = 'Копировать'), 1400); });
    });
  });
}

function scrollBottom(force = false) {
  const th = $('#thread');
  const near = th.scrollHeight - th.scrollTop - th.clientHeight < 160;
  if (force || near) th.scrollTop = th.scrollHeight;
}

function renderProvStatus() {
  const freeReady = CAT.providers.filter((p) => !p.paid && (p.keyless || keys[p.id])).length;
  const paidReady = CAT.providers.filter((p) => p.paid && keys[p.id]).length;
  const customReady = settings.custom.url && settings.custom.model ? 1 : 0;
  const el = $('#provStatus');
  el.innerHTML = `<span class="dot ${freeReady ? 'ok' : ''}"></span> бесплатно: ${freeReady}` +
    (paidReady ? ` · топ: ${paidReady}` : '') + (customReady ? ' + свой' : '');
}

function renderAgentChip() {
  const btn = $('#agentBtn');
  if (!btn) return;
  const on = !!settings.agent?.enabled;
  btn.classList.toggle('active', on);
  btn.title = on ? 'Агент включён: терминал и файлы (нажмите, чтобы выключить)' : 'Агент выключен (нажмите, чтобы включить)';
  const hint = $('#composerHint');
  if (hint) {
    hint.textContent = on && WS.workspace
      ? `папка агента: ${WS.workspace} — сменить`
      : (on ? 'агент: терминал и файлы' : '');
    hint.title = 'Сменить рабочую папку агента';
  }
}

/* ---------------- композер ---------------- */
const input = $('#input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}
function updateSendBtn() {
  const btn = $('#sendBtn');
  if (streaming) { btn.disabled = false; btn.classList.add('streaming'); btn.title = 'Остановить'; return; }
  btn.classList.remove('streaming'); btn.title = 'Отправить';
  btn.disabled = !input.value.trim();
}
input.addEventListener('input', () => { autosize(); updateSendBtn(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 760) {
    e.preventDefault();
    sendMessage();
  }
});
$('#sendBtn').addEventListener('click', () => (streaming ? stopStreaming() : sendMessage()));
$('#newChatBtn').addEventListener('click', () => newChat());
$('#plusBtn').addEventListener('click', () => toast('Вложения файлов — скоро'));
$('#agentBtn').addEventListener('click', () => {
  settings.agent = settings.agent || { enabled: true, ask: true };
  settings.agent.enabled = !settings.agent.enabled;
  save(LS.settings, settings);
  renderAgentChip();
  toast(settings.agent.enabled ? 'Агент включён: могу выполнять команды и править файлы' : 'Агент выключен: обычный чат');
});

/* ---------------- подтверждение действий ---------------- */
function approvalDetail(call) {
  if (call.name === 'run_terminal') return `$ ${call.args.command}\n# в ${call.args.cwd || WS.workspace || '.'}`;
  if (call.name === 'write_file') {
    const lines = String(call.args.content || '').split('\n');
    return `${call.args.path} — записать ${lines.length} строк:\n\n` + lines.slice(0, 30).join('\n') + (lines.length > 30 ? '\n…' : '');
  }
  return call.args.path || '(рабочая папка)';
}

function requestApproval(call) {
  if (sessionAllowAll) return Promise.resolve('allow');
  return new Promise((resolve) => {
    const modal = $('#approveModal');
    $('#apToolName').textContent = `${TOOL_LABELS[call.name] || call.name} · ${call.provider || ''}`;
    $('#apDetail').textContent = approvalDetail(call);
    $('#apSession').checked = false;
    modal.hidden = false;
    const done = (v) => { modal.hidden = true; cleanup(); resolve(v); };
    const onAllow = () => { if ($('#apSession').checked) sessionAllowAll = true; done('allow'); };
    const onDeny = () => done('deny');
    function cleanup() {
      $('#apAllowBtn').removeEventListener('click', onAllow);
      $('#apDenyBtn').removeEventListener('click', onDeny);
    }
    $('#apAllowBtn').addEventListener('click', onAllow);
    $('#apDenyBtn').addEventListener('click', onDeny);
  });
}

async function execTool(call) {
  const verdict = await requestApproval(call);
  if (verdict === 'deny') return { denied: true, result: { ok: false, error: 'пользователь отклонил действие' } };
  try {
    const res = await fetch('/api/tools/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: call.name, args: call.args }),
    });
    return { denied: false, result: await res.json() };
  } catch (e) {
    return { denied: false, result: { ok: false, error: 'не удалось выполнить: ' + e.message } };
  }
}

/* ---------------- получение моделей провайдеров ---------------- */
function filterModels(p, list) {
  let out = list.filter(Boolean);
  const re = p.filter ? new RegExp(p.filter) : null;
  if (re) out = out.filter((id) => !re.test(id));
  if (p.onlyFree) out = out.filter((id) => /:free/i.test(id));
  return [...new Set(out)];
}

function authHeaders(p, key) {
  const h = {};
  if (key) {
    h.authorization = `Bearer ${key}`;
    if (p.authStyle === 'anthropic') h['x-api-key'] = key;
  }
  if (p.extraHeaders) Object.assign(h, p.extraHeaders);
  return h;
}

async function fetchModels(p) {
  const cached = modelsCache[p.id];
  if (cached && cached.list?.length && Date.now() - cached.at < 3600e3) return cached.list;
  const key = p.custom ? settings.custom.key : (keys[p.id] || '');
  const url = p.baseUrl + '/models';
  let list = null;
  try {
    const res = await fetch(url, { headers: authHeaders(p, key) });
    if (res.ok) list = (await res.json())?.data?.map((m) => String(m.id).replace(/^models\//, '')) || null;
  } catch { /* CORS/сеть — пробуем через сервер */ }
  if (!list) {
    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, key, method: 'GET', authStyle: p.authStyle, extraHeaders: p.extraHeaders }),
      });
      if (res.ok) list = (await res.json())?.data?.map((m) => String(m.id).replace(/^models\//, '')) || null;
    } catch {}
  }
  const filtered = list ? filterModels(p, list) : [];
  modelsCache[p.id] = { at: Date.now(), list: filtered };
  save(LS.models, modelsCache);
  return filtered;
}

function pickModel(p) {
  const list = modelsCache[p.id]?.list || [];
  if (list.length) {
    const hit = (p.picks || []).find((x) => list.includes(x));
    if (hit) return hit;
    const prefs = [/opus-5/i, /gpt-5\.6/i, /gpt-5\.5/i, /flash-lite/i, /flash/i, /mini/i, /small/i, /120b/i, /70b/i, /32b/i, /8b/i];
    for (const re of prefs) {
      const m = list.find((id) => re.test(id));
      if (m) return m;
    }
    return list[0];
  }
  return (p.picks || [])[0] || null;
}

/* ---------------- авто-цепочка ---------------- */
function buildChain() {
  const chain = [];
  if (settings.custom.url && settings.custom.model) {
    chain.push({ provider: CUSTOM_PROVIDER(), model: settings.custom.model, key: settings.custom.key || '' });
  }
  const sel = settings.model;
  if (sel && sel !== 'auto' && sel.provider && sel.model) {
    const p = byId(sel.provider);
    if (p) chain.unshift({ provider: p, model: sel.model, key: p.custom ? settings.custom.key : (keys[p.id] || '') });
  }
  // автоматом перебираем только бесплатные
  for (const pid of CAT.priority || []) {
    const p = byId(pid);
    if (!p || p.paid) continue;
    if (!p.keyless && !keys[p.id]) continue;
    const model = pickModel(p);
    if (model) chain.push({ provider: p, model, key: keys[p.id] || '' });
  }
  const seen = new Set();
  return chain.filter((t) => {
    const k = t.provider.id + '|' + t.model;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ---------------- стриминг с фейловером ---------------- */
async function upstreamChat(target, payload, signal) {
  const url = target.provider.baseUrl + '/chat/completions';
  const headers = { 'content-type': 'application/json', ...authHeaders(target.provider, target.key) };
  const proxyBody = {
    url,
    key: target.key,
    authStyle: target.provider.authStyle,
    extraHeaders: target.provider.extraHeaders,
    payload,
    stream: true,
  };

  // 1) прямой запрос из браузера
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    return wrapRes(res, false);
  } catch (e) {
    if (signal?.aborted) throw { aborted: true };
    /* CORS/сеть — идём через сервер */
  }

  // 2) через наш сервер
  const res = await fetch('/api/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proxyBody),
    signal,
  });
  const wrapped = wrapRes(res, true);
  if (res.status === 502) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch {}
    throw { failover: true, status: 0, detail: detail || 'сервер недоступен' };
  }
  return wrapped;
}

function wrapRes(res, isProxy) {
  return {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type') || '',
    async text() { return res.text(); },
    async json() { return res.json(); },
    async *iter() {
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield dec.decode(value, { stream: true });
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    },
    isProxy,
  };
}

async function streamTarget(target, messages, handlers, signal, withTools) {
  const payload = { model: target.model, messages, stream: true };
  if (withTools) payload.tools = TOOLS_SCHEMA;
  const res = await upstreamChat(target, payload, signal);
  if (signal?.aborted) throw { aborted: true };

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || '';
    } catch {}
    throw { failover: true, status: res.status, detail };
  }

  let buf = '';
  let got = 0;

  for await (const chunk of res.iter()) {
    if (signal?.aborted) throw { aborted: true };
    buf += chunk;
    // некоторые провайдеры отвечают цельным JSON при stream:true — детект
    if (got === 0 && /^\s*\{/.test(buf) && buf.includes('"choices"') && !buf.includes('data:')) {
      try {
        const j = JSON.parse(buf);
        if (j.error) throw { failover: true, status: 0, detail: j.error?.message || 'ошибка провайдера' };
        const msg = j.choices?.[0]?.message || {};
        const c = typeof msg.content === 'string' ? msg.content : '';
        if (c) { got += c.length; handlers.onDelta(c); }
        if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) handlers.onToolCall(tc);
        return;
      } catch (e) {
        if (e && e.failover) throw e;
        // это ещё не полный JSON — ждём дальше
      }
    }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw { failover: got === 0, status: 0, detail: j.error?.message || 'ошибка провайдера' };
      const d = j.choices?.[0]?.delta || {};
      if (d.reasoning_content) handlers.onThink(d.reasoning_content);
      if (typeof d.content === 'string' && d.content) { got += d.content.length; handlers.onDelta(d.content); }
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) handlers.onToolCall(tc);
    }
  }
  if (got === 0 && !handlers.hasToolCalls()) throw { failover: true, status: 0, detail: 'пустой ответ' };
}

function reasonLabel(status, detail) {
  if (status === 401 || status === 403) return 'ключ не принят';
  if (status === 429) return 'лимит';
  if (status >= 500) return 'ошибка сервера';
  if (status === 404) return 'модель недоступна';
  if (status === 400 || status === 422) return 'запрос отклонён';
  return detail ? 'сбой' : 'недоступен';
}

/* ---------------- отправка ---------------- */
function buildMessages(history) {
  const msgs = [];
  const sys = [(settings.system || '').trim(), agentSystem()].filter(Boolean).join('\n\n');
  if (sys) msgs.push({ role: 'system', content: sys });
  msgs.push(...history.slice(-30).map((m) => ({ role: m.role, content: m.content })));
  return msgs;
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || streaming) return;
  let c = curChat();
  if (!c) { newChat(true); c = curChat(); }

  c.messages.push({ role: 'user', content: text });
  if (c.title === 'Новый чат') c.title = text.slice(0, 46) + (text.length > 46 ? '…' : '');
  input.value = ''; autosize(); updateSendBtn();
  $('#main').classList.remove('centered');
  persistChats();
  renderSidebar();

  const wrap = $('#messages');
  wrap.insertAdjacentHTML('beforeend', msgHtml({ role: 'user', content: text }, c.messages.length - 1));
  scrollBottom(true);

  await runCompletion(c);
}

async function regenerate() {
  const c = curChat();
  if (!c || streaming) return;
  while (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
  persistChats();
  renderThread();
  $('#main').classList.remove('centered');
  await runCompletion(c);
}

async function runCompletion(c) {
  const chain = buildChain();
  const m = { role: 'assistant', content: '', think: '', provider: '', model: '', failovers: [], ms: 0, steps: [] };
  c.messages.push(m);
  const wrap = $('#messages');

  const el = document.createElement('div');
  el.className = 'msg-assistant';
  el.innerHTML = '<div class="content"><span class="cursor"></span></div>';
  wrap.appendChild(el);
  scrollBottom(true);
  const t0 = performance.now();

  const rerender = () => {
    requestAnimationFrame(() => {
      const cur = el.querySelector('.content');
      const curSteps = el.querySelector('.steps');
      const stepsHtmlNew = stepsHtml(m);
      if (curSteps) curSteps.outerHTML = stepsHtmlNew;
      else if (stepsHtmlNew) el.insertAdjacentHTML('afterbegin', stepsHtmlNew);
      if (cur) cur.innerHTML = renderMarkdown(m.content, m.think) + '<span class="cursor"></span>';
      scrollBottom();
    });
  };

  if (!chain.length) {
    m.error = '<b>Нет настроенных провайдеров.</b> Откройте Настройки и добавьте хотя бы один бесплатный ключ (Google AI Studio или Groq — самые щедрые), либо включите OVHcloud без ключа.';
    finishMsg();
    return;
  }

  streaming = { chatId: c.id, abort: new AbortController(), stopped: false };
  updateSendBtn();
  const agentOn = () => !!settings.agent?.enabled;
  const baseHistory = buildMessages(c.messages.slice(0, -1));
  const MAX_ITER = 15;

  for (const target of chain) {
    if (streaming.stopped) break;
    let started = false;
    let apiMessages = baseHistory.slice();
    let noTools = false; // провайдер не потянул tools — повторяем без них
    let ok = false;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      if (streaming.stopped) break;
      const pending = new Map(); // index -> {id, name, argsStr}

      try {
        await streamTarget(
          target,
          apiMessages,
          {
            onDelta: (d) => {
              if (!started) { started = true; m.provider = target.provider.name; m.model = target.model; }
              m.content += (m.content ? '' : '') + d;
              rerender();
            },
            onThink: (d) => { m.think = (m.think || '') + d; rerender(); },
            onToolCall: (tc) => {
              if (!started) { started = true; m.provider = target.provider.name; m.model = target.model; }
              const idx = typeof tc.index === 'number' ? tc.index : pending.size;
              const cur = pending.get(idx) || { id: tc.id || '', name: '', argsStr: '' };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') cur.argsStr += tc.function.arguments;
              else if (tc.function?.arguments && typeof tc.function.arguments === 'object') cur.argsStr = JSON.stringify(tc.function.arguments);
              pending.set(idx, cur);
            },
            hasToolCalls: () => pending.size > 0,
          },
          streaming.abort.signal,
          agentOn() && !noTools
        );

        // == поток завершился ==
        const calls = [...pending.values()].filter((x) => x.name);
        if (agentOn() && calls.length) {
          // фиксируем ответ ассистента с tool_calls в API-истории
          apiMessages.push({
            role: 'assistant',
            content: m.content || '',
            tool_calls: calls.map((x, i) => ({
              id: x.id || `call_${iter}_${i}`,
              type: 'function',
              function: { name: x.name, arguments: x.argsStr || '{}' },
            })),
          });

          for (const [i, call] of calls.entries()) {
            let args = {};
            try { args = JSON.parse(call.argsStr || '{}'); } catch { args = { _raw: call.argsStr }; }
            const st = { tool: call.name, args, pending: true };
            m.steps.push(st);
            rerender();
            const id = apiMessages[apiMessages.length - 1].tool_calls[i].id;
            const { denied, result } = await execTool({ ...call, args, provider: target.provider.name });
            st.pending = false; st.denied = denied; st.result = result; st.ok = !!result.ok;
            rerender();
            apiMessages.push({
              role: 'tool',
              tool_call_id: id,
              content: JSON.stringify(result).slice(0, 8000),
            });
          }
          continue; // следующий заход: модель видит результаты
        }

        if (!m.provider) { m.provider = target.provider.name; m.model = target.model; }
        ok = true;
        break; // обычный текстовый ответ — готово
      } catch (e) {
        if (e && (e.aborted || e.name === 'AbortError' || streaming?.stopped)) {
          m.stopped = true; break;
        }
        // провайдер не умеет tools — пробуем ещё раз без них (той же моделью)
        if (!noTools && agentOn() && (e.status === 400 || e.status === 422) && /tool|function/i.test(e.detail || '')) {
          noTools = true;
          apiMessages = baseHistory.slice();
          m.content = ''; m.steps = [];
          continue;
        }
        if (started) {
          m.error = `<b>Провайдер оборвал поток.</b> ${esc(e.detail || '')}`;
          break;
        }
        m.failovers.push({ provider: target.provider.name, reason: reasonLabel(e.status || 0, e.detail) });
        if (e.detail) console.warn('zx failover:', target.provider.id, e.status, e.detail);
        break; // к следующему провайдеру цепочки
      }
    }

    if (ok || m.stopped || m.error) break;
  }

  // все провайдеры не ответили — объясняем, что случилось
  if (!m.content && !m.error && !m.stopped) {
    const det = m.failovers.length
      ? m.failovers.map((f) => `${esc(f.provider)} — ${f.reason}`).join(', ')
      : 'провайдеры не ответили';
    m.error = `<b>Никто из цепочки не ответил.</b> ${det}. Проверьте ключи в Настройках или попробуйте ещё раз — лимиты бесплатных тарифов сбрасываются ежедневно.`;
  }

  function finishMsg() {
    m.ms = performance.now() - t0;
    m.badge = badgeFor(m);
    persistChats();
    streaming = null;
    updateSendBtn();
    renderThread();
    renderSidebar();
    scrollBottom();
  }
  finishMsg();
}

function stopStreaming() {
  if (!streaming) return;
  streaming.stopped = true;
  try { streaming.abort.abort(); } catch {}
}

/* ---------------- меню моделей ---------------- */
const menu = $('#modelMenu');
const menuRefreshed = new Set();

function renderModelPill() {
  const sel = settings.model;
  let label = 'Авто · лучший бесплатный';
  let dotOk = true;
  if (sel && sel !== 'auto' && sel.provider) {
    const p = byId(sel.provider);
    label = `${sel.model} · ${p ? p.name : sel.provider}`;
    dotOk = p ? (p.keyless || !!keys[p.id] || !!settings.custom.key) : false;
  }
  $('#modelPillLabel').textContent = label;
  $('#modelPillDot').style.background = dotOk ? 'var(--accent)' : '#CFCCC0';
}

function modelMenuItem({ title, sub, selected, onclick }) {
  const el = document.createElement('button');
  el.className = 'menu-item' + (selected ? ' selected' : '');
  el.innerHTML = `<span class="mi-title">${title}${selected ? '<span class="mi-check">✓</span>' : ''}</span>` +
    (sub ? `<span class="mi-sub">${sub}</span>` : '');
  el.addEventListener('click', onclick);
  return el;
}

function buildMenuDom() {
  menu.innerHTML = '';

  menu.appendChild(modelMenuItem({
    title: '✳ Авто',
    sub: 'Лучший доступный бесплатный провайдер, с авто-фейловером при лимитах',
    selected: settings.model === 'auto',
    onclick: () => selectModel('auto'),
  }));
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));

  const sections = [...CAT.providers];
  if (settings.custom.url) sections.push(CUSTOM_PROVIDER());
  const free = sections.filter((p) => !p.paid);
  const paid = sections.filter((p) => p.paid);

  const renderGroup = (list) => {
    for (const p of list) {
      const hasKey = p.keyless || (p.custom ? !!settings.custom.url : !!keys[p.id]);
      const sec = document.createElement('div');
      sec.className = 'menu-section';
      const tag = p.paid ? '<span class="tag paid">по ключу · платно</span>' : `<span class="tag">${esc(p.free)}</span>`;
      sec.innerHTML = `<span>${esc(p.name)}</span>${tag}${hasKey ? '' : '<span style="text-transform:none;letter-spacing:0">· нужен ключ</span>'}`;
      menu.appendChild(sec);

      const list0 = modelsCache[p.id]?.list || [];
      const picks = (p.picks || []).slice(0, 6);
      const shown = (list0.length ? list0.slice(0, 14) : picks);
      if (!shown.length) {
        const hint = document.createElement('div');
        hint.className = 'menu-foot';
        hint.textContent = hasKey ? 'Список моделей загрузится…' : 'Добавьте ключ в Настройках, чтобы включить провайдера';
        menu.appendChild(hint);
        continue;
      }
      for (const id of shown) {
        const isSel = settings.model !== 'auto' && settings.model?.provider === p.id && settings.model?.model === id;
        menu.appendChild(modelMenuItem({
          title: esc(id),
          sub: hasKey ? '' : 'добавьте ключ в Настройках',
          selected: isSel,
          onclick: () => {
            if (!hasKey) { openSettings(); toast(`Нужен ключ ${p.name}`, true); return; }
            selectModel({ provider: p.id, model: id });
          },
        }));
      }
    }
  };

  renderGroup(free);

  if (paid.length) {
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);
    const head = document.createElement('div');
    head.className = 'menu-section';
    head.innerHTML = '<span>Топ-модели — ваш ключ</span>';
    menu.appendChild(head);
    renderGroup(paid);
  }

  const foot = document.createElement('div');
  foot.className = 'menu-foot';
  foot.textContent = '«Авто» перебирает бесплатные: Google → Groq → Cerebras → Mistral → OpenRouter → NVIDIA → OVH. Claude и GPT — по явному выбору, тарифицируются вашим ключом.';
  menu.appendChild(foot);
}

function openMenu() {
  menu.hidden = false;
  buildMenuDom();

  const pill = $('#modelPill').getBoundingClientRect();
  menu.style.top = Math.min(pill.bottom + 6, window.innerHeight - 60) + 'px';
  menu.style.left = Math.max(8, Math.min(pill.left, window.innerWidth - 376)) + 'px';

  const sections = [...CAT.providers];
  if (settings.custom.url) sections.push(CUSTOM_PROVIDER());
  for (const p of sections) {
    const hasKey = p.keyless || (p.custom ? !!settings.custom.url : !!keys[p.id]);
    if (!hasKey || menuRefreshed.has(p.id)) continue;
    menuRefreshed.add(p.id);
    fetchModels(p).then((list) => {
      if (!menu.hidden && list.length) buildMenuDom();
    }).catch(() => {});
  }
}

function selectModel(v) {
  settings.model = v;
  save(LS.settings, settings);
  menu.hidden = true;
  renderModelPill();
}

$('#modelPill').addEventListener('click', (e) => {
  e.stopPropagation();
  if (menu.hidden) { menuRefreshed.clear(); openMenu(); }
  else menu.hidden = true;
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest?.('#modelPill')) menu.hidden = true;
});

/* ---------------- настройки ---------------- */
function openSettings() {
  const rows = $('#keyRows');
  rows.innerHTML = '';
  const order = [...CAT.providers].sort((a, b) => (a.paid === b.paid ? 0 : a.paid ? 1 : -1));
  for (const p of order) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const has = !!keys[p.id];
    const tag = p.keyless
      ? '<span class="key-free keyless">без ключа</span>'
      : (p.paid ? '<span class="key-free paid">топ · платно</span>' : '<span class="key-free">бесплатно</span>');
    row.innerHTML = `
      <span class="key-dot ${has ? 'ok' : ''}"></span>
      <div class="key-main">
        <div class="key-name">${esc(p.name)} ${tag}</div>
        <div class="key-note">${esc(p.note)}</div>
      </div>
      ${p.keyless ? '<span class="key-note">включён всегда</span>' : `
      <div class="key-input-wrap">
        <input class="key-input" type="password" data-pid="${p.id}" placeholder="API-ключ" value="${esc(keys[p.id] || '')}" autocomplete="off">
        ${p.keyUrl ? `<a class="key-link" href="${p.keyUrl}" target="_blank" rel="noopener">получить ключ ↗</a>` : ''}
      </div>`}
    `;
    rows.appendChild(row);
  }
  $('#customUrl').value = settings.custom.url || '';
  $('#customKey').value = settings.custom.key || '';
  $('#customModel').value = settings.custom.model || '';
  $('#systemPrompt').value = settings.system || '';
  $('#settingsModal').hidden = false;
}

function closeSettings() { $('#settingsModal').hidden = true; }

$('#openSettingsBtn').addEventListener('click', () => { openSettings(); closeSidebar(); });
$('#closeSettingsBtn').addEventListener('click', closeSettings);
$('#settingsModal').addEventListener('click', (e) => { if (e.target === $('#settingsModal')) closeSettings(); });

$('#saveSettingsBtn').addEventListener('click', () => {
  keys = {};
  document.querySelectorAll('#keyRows .key-input').forEach((inp) => {
    const v = inp.value.trim();
    if (v) keys[inp.dataset.pid] = v;
  });
  settings.custom = {
    url: $('#customUrl').value.trim(),
    key: $('#customKey').value.trim(),
    model: $('#customModel').value.trim(),
  };
  settings.system = $('#systemPrompt').value;
  save(LS.keys, keys);
  save(LS.settings, settings);
  modelsCache = {}; save(LS.models, {});
  closeSettings();
  renderAll();
  saveContext();
  toast('Сохранено — провайдеры обновлены');
});

/* ---------------- выбор рабочей папки ---------------- */
function openWsModal() {
  $('#wsCurrent').textContent = WS.workspace || '—';
  $('#wsPath').value = WS.workspace || '';
  $('#wsCreate').checked = false;
  $('#wsModal').hidden = false;
  $('#wsPath').focus();
}
function closeWsModal() { $('#wsModal').hidden = true; }

async function reloadContextFromWorkspace() {
  let loaded = false;
  try {
    const j = await (await fetch('/api/store/chats')).json();
    if (j.exists) loaded = applyServerContext(j.data);
  } catch {}
  if (!loaded) {
    // в новой папке контекста нет — переносим текущие чаты с собой
    saveContext();
  }
  renderAll();
}

$('#wsBtn').addEventListener('click', () => { openWsModal(); closeSidebar(); });
$('#wsCloseBtn').addEventListener('click', closeWsModal);
$('#wsModal').addEventListener('click', (e) => { if (e.target === $('#wsModal')) closeWsModal(); });
$('#composerHint').addEventListener('click', openWsModal);
$('#wsApplyBtn').addEventListener('click', async () => {
  const path = $('#wsPath').value.trim();
  if (!path) return;
  $('#wsApplyBtn').disabled = true;
  try {
    const res = await fetch('/api/agent/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, create: $('#wsCreate').checked }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) {
      if (j.needCreate && !$('#wsCreate').checked) toast('Папки нет — отметьте «создать папку» и повторите', true);
      else toast(j.error || 'Не удалось сменить папку', true);
      return;
    }
    WS.workspace = j.workspace;
    $('#wsModal').hidden = true;
    renderAgentChip();
    await reloadContextFromWorkspace();
    toast(`Папка агента: ${j.workspace}`);
  } catch (e) {
    toast('Ошибка: ' + e.message, true);
  } finally {
    $('#wsApplyBtn').disabled = false;
  }
});

/* ---------------- сайдбар (мобильный) ---------------- */
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('show');
}
$('#burgerBtn').addEventListener('click', () => {
  $('#sidebar').classList.add('open');
  $('#scrim').classList.add('show');
});
$('#scrim').addEventListener('click', closeSidebar);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#approveModal').hidden) { /* ждём явного решения */ }
    else if (!menu.hidden) menu.hidden = true;
    else if (!$('#settingsModal').hidden) closeSettings();
    else closeSidebar();
  }
});

/* ---------------- запуск ---------------- */
async function boot() {
  const saved = load(LS.chats, { chats: [], curId: null });
  chats = Array.isArray(saved?.chats) ? saved.chats : [];
  curId = saved?.curId || null;
  keys = load(LS.keys, {}) || {}; // ключи — только в браузере, в папку не пишем
  settings = Object.assign({ model: 'auto', system: '', custom: {}, agent: {} }, load(LS.settings, {}));
  settings.custom = Object.assign({ url: '', key: '', model: '' }, settings.custom || {});
  settings.agent = Object.assign({ enabled: true, ask: true }, settings.agent || {});
  modelsCache = load(LS.models, {}) || {};

  try {
    const [r, w] = await Promise.all([fetch('/api/providers'), fetch('/api/agent/info')]);
    CAT = await r.json();
    WS = await w.json();
  } catch {
    toast('Не удалось связаться с сервером zx', true);
  }

  // контекст из рабочей папки важнее localStorage
  try {
    const j = await (await fetch('/api/store/chats')).json();
    if (j.exists) {
      if (applyServerContext(j.data)) save(LS.settings, settings);
    }
  } catch {}

  if (!chats.find((c) => c.id === curId)) curId = chats[0]?.id || null;
  if (!chats.length) { const c = { id: uid(), title: 'Новый чат', createdAt: Date.now(), messages: [] }; chats.unshift(c); curId = c.id; }

  renderAll();
  autosize();
  updateSendBtn();
  if (window.innerWidth > 760) input.focus();
}

boot();
