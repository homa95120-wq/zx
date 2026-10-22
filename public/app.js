'use strict';
/* ============================================================
   zx — ИИ-агент на бесплатных моделях (UI в духе claude.ai)
   - агрегация бесплатных провайдеров (Google, Groq, Cerebras,
     Mistral, OpenRouter:free, NVIDIA, OVH + свой endpoint)
   - авто-режим: строит цепочку провайдеров и фейловерит при
     лимитах/ошибках, стримит ответ, показывает, кто отвечал
   - ключи живут только в localStorage браузера
   ============================================================ */

const $ = (s) => document.querySelector(s);
const LS = { chats: 'zx.chats', keys: 'zx.keys', settings: 'zx.settings', models: 'zx.models' };

/* ---------------- состояние ---------------- */
let CAT = { providers: [], priority: [] };
let chats = [];            // [{id, title, createdAt, messages:[{role, content, think, provider, model, ms, failovers}]}]
let curId = null;
let keys = {};             // { providerId: apiKey }
let settings = { model: 'auto', system: '', custom: { url: '', key: '', model: '' } };
let modelsCache = {};      // { providerId: { at, list:[] } }
let streaming = null;      // { chatId, abort, stopped }

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

/* ---------------- утилиты ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function persistChats() {
  save(LS.chats, { chats: chats.slice(0, 60), curId });
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
  const badge = m.badge || '';
  const actions = `
    <div class="meta-row">
      <span class="msg-badge">${badge}</span>
      <div class="msg-actions">
        <button class="icon-btn act-copy" title="Скопировать"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M9 9h10v12H9zM5 15V3h10"/></svg></button>
        <button class="icon-btn act-regen" title="Переписать ответ"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M4 10a8 8 0 1 1 2 6.5M4 10V4m0 6h6"/></svg></button>
      </div>
    </div>`;
  const err = m.error ? `<div class="error-card">${m.error}</div>` : '';
  const body = (m.content || '').trim()
    ? `<div class="content">${renderMarkdown(m.content, m.think)}</div>`
    : (m.error ? '' : '<div class="content"><span class="cursor"></span></div>');
  return `<div class="msg-assistant" data-i="${i}">${err}${body}${actions}</div>`;
}

function badgeFor(m) {
  const parts = [];
  if (m.provider) parts.push(esc(m.provider));
  if (m.model) parts.push(`<span style="font-family:ui-monospace,Menlo,monospace;font-size:11px">${esc(m.model)}</span>`);
  if (m.ms) parts.push(((m.ms) / 1000).toFixed(1) + ' с');
  if (m.stopped) parts.push('остановлено');
  if (m.failovers && m.failovers.length) {
    const f = m.failovers.map((x) => `${x.provider} (${x.reason})`).join(' → ');
    parts.push(`<span title="${esc(f)}">↻ обход: ${esc(m.failovers.map((x) => x.provider).join(' → '))}</span>`);
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
      const code = codeStore.get(btn.dataset.codeId) || btn.dataset.code || '';
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
  const ready = CAT.providers.filter((p) => p.keyless || keys[p.id]).length;
  const customReady = settings.custom.url && settings.custom.model ? 1 : 0;
  const el = $('#provStatus');
  el.innerHTML = `<span class="dot ${ready ? 'ok' : ''}"></span> готово провайдеров: ${ready}${customReady ? ' + свой' : ''}`;
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

/* ---------------- получение моделей провайдеров ---------------- */
function filterModels(p, list) {
  let out = list.filter(Boolean);
  const re = p.filter ? new RegExp(p.filter) : null;
  if (re) out = out.filter((id) => !re.test(id));
  if (p.onlyFree) out = out.filter((id) => /:free/i.test(id));
  return [...new Set(out)];
}

async function fetchModels(p) {
  const cached = modelsCache[p.id];
  if (cached && cached.list?.length && Date.now() - cached.at < 3600e3) return cached.list;
  const key = p.custom ? settings.custom.key : (keys[p.id] || '');
  const url = p.baseUrl + '/models';
  let list = null;
  try {
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (res.ok) list = (await res.json())?.data?.map((m) => String(m.id).replace(/^models\//, '')) || null;
  } catch { /* CORS/сеть — пробуем через сервер */ }
  if (!list) {
    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, key, method: 'GET' }),
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
    const prefs = [/flash-lite/i, /flash/i, /mini/i, /small/i, /120b/i, /70b/i, /32b/i, /8b/i];
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
  for (const pid of CAT.priority || []) {
    const p = byId(pid);
    if (!p) continue;
    if (!p.keyless && !keys[p.id]) continue;
    const model = pickModel(p);
    if (model) chain.push({ provider: p, model, key: keys[p.id] || '' });
  }
  // убираем дубликаты провайдер+модель
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
  const headers = { 'content-type': 'application/json' };
  if (target.key) headers.authorization = `Bearer ${target.key}`;

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
    body: JSON.stringify({ url, key: target.key, payload, stream: true }),
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

async function streamTarget(target, messages, handlers, signal) {
  const payload = { model: target.model, messages, stream: true };
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
        const c = j.choices?.[0]?.message?.content || '';
        if (j.error) throw { failover: true, status: 0, detail: j.error?.message || 'ошибка провайдера' };
        if (c) { got += c.length; handlers.onDelta(c); }
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
    }
  }
  if (got === 0) throw { failover: true, status: 0, detail: 'пустой ответ' };
}

function reasonLabel(status, detail) {
  if (status === 401 || status === 403) return 'ключ не принят';
  if (status === 429) return 'лимит';
  if (status >= 500) return 'ошибка сервера';
  if (status === 404) return 'модель недоступна';
  return detail ? 'сбой' : 'недоступен';
}

/* ---------------- отправка ---------------- */
function buildMessages(history) {
  const msgs = [];
  const sys = (settings.system || '').trim();
  if (sys) msgs.push({ role: 'system', content: sys });
  msgs.push(...history.slice(-24).map((m) => ({ role: m.role, content: m.content })));
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
  // убираем последний ассистентский ответ
  while (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
  persistChats();
  renderThread();
  $('#main').classList.remove('centered');
  await runCompletion(c);
}

async function runCompletion(c) {
  const chain = buildChain();
  const m = { role: 'assistant', content: '', think: '', provider: '', model: '', failovers: [], ms: 0 };
  c.messages.push(m);
  const wrap = $('#messages');

  const el = document.createElement('div');
  el.className = 'msg-assistant';
  el.innerHTML = '<div class="content"><span class="cursor"></span></div>';
  wrap.appendChild(el);
  scrollBottom(true);
  const t0 = performance.now();

  if (!chain.length) {
    m.error = '<b>Нет настроенных провайдеров.</b> Откройте Настройки и добавьте хотя бы один бесплатный ключ (Google AI Studio или Groq — самые щедрые), либо включите OVHcloud без ключа.';
    finishMsg();
    return;
  }

  streaming = { chatId: c.id, abort: new AbortController(), stopped: false };
  updateSendBtn();

  for (const target of chain) {
    if (streaming.stopped) break;
    let started = false;
    let renderQueued = false;
    const rerender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        const cur = el.querySelector('.content');
        if (cur) cur.innerHTML = renderMarkdown(m.content, m.think) + '<span class="cursor"></span>';
        scrollBottom();
      });
    };
    try {
      await streamTarget(
        target,
        buildMessages(c.messages.slice(0, -1)),
        {
          onDelta: (d) => {
            if (!started) {
              started = true;
              m.provider = target.provider.name;
              m.model = target.model;
            }
            m.content += d;
            rerender();
          },
          onThink: (d) => { m.think = (m.think || '') + d; rerender(); },
        },
        streaming.abort.signal
      );
      if (!m.provider) { m.provider = target.provider.name; m.model = target.model; }
      m.ms = performance.now() - t0;
      break; // успех
    } catch (e) {
      if (e && (e.aborted || e.name === 'AbortError' || streaming?.stopped)) {
        m.stopped = true; m.ms = performance.now() - t0; break;
      }
      if (started) {
        // стрим начался и оборвался — фейловер уже невозможен, показываем ошибку
        m.error = `<b>Провайдер оборвал поток.</b> ${esc(e.detail || '')}`;
        m.ms = performance.now() - t0;
        break;
      }
      m.failovers.push({ provider: target.provider.name, reason: reasonLabel(e.status || 0, e.detail) });
      if (e.detail) console.warn('zx failover:', target.provider.id, e.status, e.detail);
    }
  }

  // все провайдеры не ответили — объясняем, что случилось
  if (!m.content && !m.error && !m.stopped) {
    const det = m.failovers.length
      ? m.failovers.map((f) => `${esc(f.provider)} — ${f.reason}`).join(', ')
      : 'провайдеры не ответили';
    m.error = `<b>Никто из цепочки не ответил.</b> ${det}. Проверьте ключи в Настройках или попробуйте ещё раз — лимиты бесплатных тарифов сбрасываются ежедневно.`;
    m.ms = performance.now() - t0;
  }

  function finishMsg() {
    m.ms = m.ms || performance.now() - t0;
    m.badge = badgeFor(m);
    persistChats();
    streaming = null;
    updateSendBtn();
    renderThread();
    renderSidebar();
    scrollBottom();
    const keysReady = CAT.providers.some((p) => p.keyless || keys[p.id]);
    if (!m.content && !m.error && !m.stopped && !keysReady) {
      toast('Добавьте ключ провайдера в Настройках', true);
    }
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
  const dot = $('#modelPillDot');
  dot.style.background = dotOk ? 'var(--accent)' : '#CFCCC0';
}

function modelMenuItem({ title, sub, selected, onclick, check }) {
  const el = document.createElement('button');
  el.className = 'menu-item' + (selected ? ' selected' : '');
  el.innerHTML = `<span class="mi-title">${title}${selected ? '<span class="mi-check">✓</span>' : (check ? `<span class="mi-check">${check}</span>` : '')}</span>` +
    (sub ? `<span class="mi-sub">${sub}</span>` : '');
  el.addEventListener('click', onclick);
  return el;
}

const menuRefreshed = new Set();

function buildMenuDom() {
  menu.innerHTML = '';

  // «Авто»
  menu.appendChild(modelMenuItem({
    title: '✳ Авто',
    sub: 'Лучший доступный провайдер, с авто-фейловером при лимитах',
    selected: settings.model === 'auto',
    onclick: () => selectModel('auto'),
  }));
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));

  const sections = [...CAT.providers];
  if (settings.custom.url) sections.push(CUSTOM_PROVIDER());

  for (const p of sections) {
    const hasKey = p.keyless || (p.custom ? !!settings.custom.url : !!keys[p.id]);
    const sec = document.createElement('div');
    sec.className = 'menu-section';
    sec.innerHTML = `<span>${esc(p.name)}</span><span class="tag">${esc(p.free)}</span>${hasKey ? '' : '<span style="text-transform:none;letter-spacing:0">· нужен ключ</span>'}`;
    menu.appendChild(sec);

    const picks = (p.picks || []).slice(0, 6);
    const list = modelsCache[p.id]?.list || [];
    const shown = (list.length ? list.slice(0, 14) : picks);
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

  const foot = document.createElement('div');
  foot.className = 'menu-foot';
  foot.textContent = 'В «Авто» провайдеры перебираются по качеству: Google → Groq → Cerebras → Mistral → OpenRouter → NVIDIA → OVH';
  menu.appendChild(foot);
}

function openMenu() {
  menu.hidden = false;
  buildMenuDom();

  const pill = $('#modelPill').getBoundingClientRect();
  menu.style.top = Math.min(pill.bottom + 6, window.innerHeight - 60) + 'px';
  menu.style.left = Math.max(8, Math.min(pill.left, window.innerWidth - 376)) + 'px';

  // подтягиваем живые списки моделей (каждого провайдера — один раз за открытие)
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
  for (const p of CAT.providers) {
    const row = document.createElement('div');
    row.className = 'key-row';
    const has = !!keys[p.id];
    row.innerHTML = `
      <span class="key-dot ${has ? 'ok' : ''}"></span>
      <div class="key-main">
        <div class="key-name">${esc(p.name)} <span class="key-free ${p.keyless ? 'keyless' : ''}">${p.keyless ? 'без ключа' : 'бесплатно'}</span></div>
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
  toast('Сохранено — провайдеры обновлены');
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
    if (!menu.hidden) menu.hidden = true;
    else if (!$('#settingsModal').hidden) closeSettings();
    else closeSidebar();
  }
});

/* ---------------- запуск ---------------- */
async function boot() {
  const saved = load(LS.chats, { chats: [], curId: null });
  chats = Array.isArray(saved?.chats) ? saved.chats : [];
  curId = saved?.curId || null;
  keys = load(LS.keys, {}) || {};
  settings = Object.assign({ model: 'auto', system: '', custom: { url: '', key: '', model: '' } }, load(LS.settings, {}));
  settings.custom = Object.assign({ url: '', key: '', model: '' }, settings.custom || {});
  modelsCache = load(LS.models, {}) || {};

  try {
    const r = await fetch('/api/providers');
    CAT = await r.json();
  } catch {
    toast('Не удалось загрузить каталог провайдеров', true);
  }

  if (!chats.find((c) => c.id === curId)) curId = chats[0]?.id || null;
  if (!chats.length) { const c = { id: uid(), title: 'Новый чат', createdAt: Date.now(), messages: [] }; chats.unshift(c); curId = c.id; }

  renderAll();
  autosize();
  updateSendBtn();
  if (window.innerWidth > 760) input.focus();
}

boot();
