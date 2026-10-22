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

  // 6. видео-инструменты (media_probe + media_render)
  const { spawnSync } = require('child_process');
  const reqPort = (port, method, urlPath, body, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  const execOn = (port, body) => reqPort(port, 'POST', '/api/tools/exec', JSON.stringify(body), { 'content-type': 'application/json' })
    .then((r) => JSON.parse(r.body));

  // 6a. Фейковый ffmpeg (детерминированные тесты на POSIX; на Windows — SKIP)
  if (process.platform === 'win32') {
    console.log('SKIP  fake ffmpeg (POSIX sh) — пропуск на Windows');
  } else {
    const fakeDir = path.join(os.tmpdir(), 'zx-fake-ff');
    const fakeWs = path.join(os.tmpdir(), 'zx-ws-fake-ff');
    const pidFile = path.join(fakeDir, 'sleep.pid');
    fs.rmSync(fakeDir, { recursive: true, force: true });
    fs.rmSync(fakeWs, { recursive: true, force: true });
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.mkdirSync(fakeWs, { recursive: true });
    fs.writeFileSync(path.join(fakeWs, 'in.mp4'), 'FAKE_MP4_DATA');
    fs.writeFileSync(path.join(fakeWs, 'scenes-timeout.mp4'), 'FAKE_MP4_SLOW');
    fs.writeFileSync(path.join(fakeWs, 'bad.txt'), 'not a video');

    const fakeScript = [
      '#!/bin/sh',
      'if [ "$1" = "-version" ]; then',
      '  echo "ffmpeg version 9.9-fake"',
      '  exit 0',
      'fi',
      'has_progress=0',
      'has_showinfo=0',
      'has_fail=0',
      'has_sleep=0',
      'for a in "$@"; do',
      '  case "$a" in',
      '    pipe:1) has_progress=1 ;;',
      '    *showinfo*) has_showinfo=1 ;;',
      '    __FAIL__) has_fail=1 ;;',
      '    __SLEEP__) has_sleep=1 ;;',
      '  esac',
      'done',
      'for last; do :; done',
      'if [ "$has_showinfo" = "1" ]; then',
      '  echo "[Parsed_showinfo_1 @ 0x1] n:0 pts:1250 pts_time:1.254 fmt:yuv420p" >&2',
      '  echo "[Parsed_showinfo_1 @ 0x1] n:1 pts:2500 pts_time:2.5 fmt:yuv420p" >&2',
      '  case "$3" in',
      '    *scenes-timeout.mp4) exec sleep 10 ;;',
      '  esac',
      '  echo "[Parsed_showinfo_1 @ 0x1] n:2 pts:4019 pts_time:4.019 fmt:yuv420p" >&2',
      '  exit 0',
      'fi',
      'if [ "$has_progress" = "0" ] && [ "$1" = "-hide_banner" ] && [ "$2" = "-i" ]; then',
      '  case "$3" in',
      '    *bad.txt)',
      '      echo "Invalid data found when processing input" >&2',
      '      exit 1',
      '      ;;',
      '  esac',
      '  echo "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'$3\':" >&2',
      '  echo "  Duration: 00:00:05.00, start: 0.000000, bitrate: 2500 kb/s" >&2',
      '  echo "  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 2200 kb/s, 30 fps, 30 tbr" >&2',
      '  echo "  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 192 kb/s" >&2',
      '  echo "At least one output file must be specified" >&2',
      '  exit 1',
      'fi',
      'if [ "$has_fail" = "1" ]; then',
      '  echo "[error] Invalid argument __FAIL__: тестовая ошибка кодирования" >&2',
      '  exit 1',
      'fi',
      'if [ "$has_sleep" = "1" ]; then',
      '  if [ -n "$ZX_FAKE_PIDFILE" ]; then echo "$$" > "$ZX_FAKE_PIDFILE"; fi',
      '  echo "frame=25"',
      '  echo "fps=25.0"',
      '  echo "out_time_ms=1000000"',
      '  echo "speed=1.0x"',
      '  echo "progress=continue"',
      '  echo "rendering slow frame..." >&2',
      '  exec sleep 10',
      'fi',
      'echo "frame=150"',
      'echo "fps=60.5"',
      'echo "out_time_ms=5000000"',
      'echo "speed=2.5x"',
      'echo "progress=end"',
      'echo "Stream mapping: #0:0 -> #0:0" >&2',
      'echo "video:512KiB audio:64KiB muxing overhead: 0.4%" >&2',
      'printf "%s\\n" "$@" > "$last"',
      'exit 0',
      '',
    ].join('\n');

    const fakeBin = path.join(fakeDir, 'ffmpeg');
    fs.writeFileSync(fakeBin, fakeScript, { mode: 0o755 });
    fs.chmodSync(fakeBin, 0o755);

    const FAKE_PORT = 3313;
    const srvFake = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(FAKE_PORT),
        HOST: '127.0.0.1',
        ZX_NO_OPEN: '1',
        ZX_WORKSPACE: fakeWs,
        ZX_CONFIG: path.join(os.tmpdir(), 'zx-fake-ff-cfg.json'),
        ZX_FFMPEG: fakeBin,
        ZX_SCENES_TIMEOUT_MS: '350',
        ZX_FAKE_PIDFILE: pidFile,
      },
    });
    await new Promise((r) => setTimeout(r, 500));

    try {
      const pr = await execOn(FAKE_PORT, { tool: 'media_probe', args: { path: 'in.mp4' } });
      const vStream = (pr.streams || []).find((s) => s.type === 'video');
      const aStream = (pr.streams || []).find((s) => s.type === 'audio');
      check('fake media_probe: метаданные без ffprobe (ffmpeg -i)',
        pr.ok === true && pr.duration === 5 && pr.hasVideo === true && pr.hasAudio === true
        && vStream?.codec === 'h264' && vStream?.width === 1920 && vStream?.height === 1080 && vStream?.fps === 30
        && aStream?.codec === 'aac' && aStream?.sampleRate === 48000 && aStream?.channels === 2,
        JSON.stringify(pr).slice(0, 160));

      const prSc = await execOn(FAKE_PORT, { tool: 'media_probe', args: { path: 'in.mp4', scenes: true, threshold: 0.35, maxScenes: 2 } });
      check('fake media_probe: сцены и округление/лимит',
        prSc.ok === true && Array.isArray(prSc.scenes) && prSc.scenes.length === 2
        && prSc.scenes[0].time === 1.25 && prSc.scenes[1].time === 2.5,
        JSON.stringify(prSc.scenes));

      const prScTo = await execOn(FAKE_PORT, { tool: 'media_probe', args: { path: 'scenes-timeout.mp4', scenes: true } });
      check('fake media_probe: таймаут сцен возвращает частичный результат',
        prScTo.ok === false && prScTo.timedOut === true && Array.isArray(prScTo.scenes) && prScTo.scenes.length === 2,
        JSON.stringify({ ok: prScTo.ok, timedOut: prScTo.timedOut, scenes: prScTo.scenes }));

      const prMiss = await execOn(FAKE_PORT, { tool: 'media_probe', args: { path: 'no-such.mp4' } });
      check('fake media_probe: нет файла — ошибка на русском',
        prMiss.ok === false && /не найден/i.test(prMiss.error || ''), prMiss.error);

      const prBad = await execOn(FAKE_PORT, { tool: 'media_probe', args: { path: 'bad.txt' } });
      check('fake media_probe: не видео — ошибка на русском',
        prBad.ok === false && /не распознан|видео/i.test(prBad.error || ''), prBad.error);

      const rrOk = await execOn(FAKE_PORT, {
        tool: 'media_render',
        args: { args: ['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'] },
      });
      check('fake media_render: ok + прогресс + percent',
        rrOk.ok === true && rrOk.exitCode === 0 && fs.existsSync(rrOk.outPath)
        && rrOk.progress?.seconds === 5 && rrOk.progress?.percent === 100
        && rrOk.progress?.fps === 60.5 && rrOk.progress?.speed === '2.5x',
        JSON.stringify(rrOk.progress));

      // Проверка безопасности массива аргументов: пробелы, кавычки и спецсимволы шелла не интерполируются
      const pwnFile = path.join(fakeWs, 'pwned');
      const trickyOut = `clip "quotes" 'single' $(touch "${pwnFile}") end.mp4`;
      const trickyFilter = `drawtext=text='Привет "мир" & ; | $HOME'`;
      const rrArr = await execOn(FAKE_PORT, {
        tool: 'media_render',
        args: { args: ['-i', 'in.mp4', '-vf', trickyFilter, trickyOut] },
      });
      const writtenLines = fs.existsSync(rrArr.outPath) ? fs.readFileSync(rrArr.outPath, 'utf8').split('\n') : [];
      check('fake media_render: аргументы доходят массивом без shell-интерполяции',
        rrArr.ok === true && !fs.existsSync(pwnFile)
        && fs.existsSync(path.join(fakeWs, trickyOut))
        && writtenLines.includes(trickyFilter) && writtenLines.includes(trickyOut) && writtenLines.includes('-y'),
        rrArr.outPath);

      const rrBadArgs = await execOn(FAKE_PORT, { tool: 'media_render', args: { args: '-i in.mp4 out.mp4' } });
      check('fake media_render: не-массив args отклонён', rrBadArgs.ok === false && /массив/i.test(rrBadArgs.error || ''), rrBadArgs.error);

      const rrFail = await execOn(FAKE_PORT, {
        tool: 'media_render',
        args: { args: ['-i', 'in.mp4', '__FAIL__', 'fail.mp4'] },
      });
      check('fake media_render: ошибка кодирования (exitCode=1 + log)',
        rrFail.ok === false && rrFail.exitCode === 1 && (rrFail.log || '').includes('__FAIL__'),
        rrFail.error);

      const t0 = Date.now();
      const rrTo = await execOn(FAKE_PORT, {
        tool: 'media_render',
        args: { args: ['-i', 'in.mp4', '__SLEEP__', 'slow.mp4'], timeout: 0.35 },
      });
      const elapsed = Date.now() - t0;
      check('fake media_render: таймаут убивает процесс и подсказывает разбить на части',
        rrTo.ok === false && rrTo.timedOut === true && elapsed < 3000 && /разбейте рендер на части/i.test(rrTo.error || ''),
        `elapsed=${elapsed}ms err=${rrTo.error}`);

      // Отмена при закрытии HTTP-запроса клиентом
      fs.rmSync(pidFile, { force: true });
      const abortReq = http.request({
        host: '127.0.0.1', port: FAKE_PORT, path: '/api/tools/exec', method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      abortReq.on('error', () => {});
      abortReq.write(JSON.stringify({ tool: 'media_render', args: { args: ['-i', 'in.mp4', '__SLEEP__', 'aborted.mp4'], timeout: 30 } }));
      abortReq.end();
      for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 40));
      const childPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : 0;
      abortReq.destroy();
      await new Promise((r) => setTimeout(r, 250));
      let stillAlive = false;
      if (childPid > 0) {
        try { process.kill(childPid, 0); stillAlive = true; } catch { stillAlive = false; }
      }
      check('fake media_render: обрыв запроса убивает дочерний процесс', childPid > 0 && !stillAlive, `pid=${childPid} alive=${stillAlive}`);
    } finally {
      srvFake.kill();
    }

    // Проверка ветки с ffprobe рядом с ffmpeg + проверка отсутствия ffmpeg
    const probeDir = path.join(os.tmpdir(), 'zx-fake-ffprobe');
    fs.rmSync(probeDir, { recursive: true, force: true });
    fs.mkdirSync(probeDir, { recursive: true });
    fs.copyFileSync(fakeBin, path.join(probeDir, 'ffmpeg'));
    fs.chmodSync(path.join(probeDir, 'ffmpeg'), 0o755);
    const ffprobeScript = [
      '#!/bin/sh',
      'cat <<\'JSON\'',
      '{"format":{"format_name":"matroska,webm","duration":"12.345","size":"98765"},"streams":[{"codec_type":"video","codec_name":"vp9","width":3840,"height":2160,"avg_frame_rate":"60/1","bit_rate":"8000000"},{"codec_type":"audio","codec_name":"opus","sample_rate":"48000","channels":2,"bit_rate":"128000"}]}',
      'JSON',
      'exit 0',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(probeDir, 'ffprobe'), ffprobeScript, { mode: 0o755 });
    fs.chmodSync(path.join(probeDir, 'ffprobe'), 0o755);

    const PROBE_PORT = 3314;
    const srvProbe = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PROBE_PORT),
        HOST: '127.0.0.1',
        ZX_NO_OPEN: '1',
        ZX_WORKSPACE: fakeWs,
        ZX_CONFIG: path.join(os.tmpdir(), 'zx-fake-probe-cfg.json'),
        ZX_FFMPEG: path.join(probeDir, 'ffmpeg'),
      },
    });
    const NOFF_PORT = 3315;
    const srvNoFf = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(NOFF_PORT),
        HOST: '127.0.0.1',
        ZX_NO_OPEN: '1',
        ZX_WORKSPACE: fakeWs,
        ZX_CONFIG: path.join(os.tmpdir(), 'zx-noff-cfg.json'),
        ZX_FFMPEG: '',
        FFMPEG_PATH: '',
        PATH: '',
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const jp = await execOn(PROBE_PORT, { tool: 'media_probe', args: { path: 'in.mp4' } });
      check('fake ffprobe: JSON-метаданные из одной папки с ffmpeg',
        jp.ok === true && jp.duration === 12.35 && jp.format === 'matroska,webm'
        && jp.streams?.[0]?.codec === 'vp9' && jp.streams?.[0]?.width === 3840 && jp.streams?.[0]?.fps === 60
        && jp.streams?.[1]?.codec === 'opus' && jp.streams?.[1]?.channels === 2,
        JSON.stringify(jp).slice(0, 160));

      const nf = await execOn(NOFF_PORT, { tool: 'media_probe', args: { path: 'in.mp4' } });
      check('без ffmpeg: понятная инструкция по установке',
        nf.ok === false && (nf.error || '').includes('winget install Gyan.FFmpeg') && (nf.error || '').includes('ZX_FFMPEG'),
        nf.error);
    } finally {
      srvProbe.kill();
      srvNoFf.kill();
    }
  }

  // 6b. Реальный ffmpeg (статический из /tmp/if/ffmpeg или системный в PATH / Windows)
  const findRealFfmpeg = () => {
    const cands = [
      process.env.ZX_FFMPEG,
      process.env.FFMPEG_PATH,
      '/tmp/if/ffmpeg',
    ].filter(Boolean);
    for (const c of cands) {
      try { if (fs.statSync(c).isFile()) return path.resolve(c); } catch {}
    }
    try {
      const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'], { shell: false, encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && r.stdout) {
        const hit = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (hit && fs.statSync(hit).isFile()) return hit;
      }
    } catch {}
    if (process.platform === 'win32') {
      for (const wp of [
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe') : '',
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      ]) {
        try { if (wp && fs.statSync(wp).isFile()) return wp; } catch {}
      }
    }
    return null;
  };

  const realFfmpeg = findRealFfmpeg();
  if (!realFfmpeg) {
    console.log('SKIP  real ffmpeg — бинарник ffmpeg не найден в среде');
  } else {
    const realWs = path.join(os.tmpdir(), 'zx-ws-real-ff');
    fs.rmSync(realWs, { recursive: true, force: true });
    fs.mkdirSync(realWs, { recursive: true });
    const REAL_PORT = 3316;
    const srvReal = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(REAL_PORT),
        HOST: '127.0.0.1',
        ZX_NO_OPEN: '1',
        ZX_WORKSPACE: realWs,
        ZX_CONFIG: path.join(os.tmpdir(), 'zx-real-ff-cfg.json'),
        ZX_FFMPEG: realFfmpeg,
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const inClip = path.join(realWs, 'in.mp4');
      const gen = spawnSync(
        realFfmpeg,
        ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '2', '-pix_fmt', 'yuv420p', '-y', inClip],
        { shell: false, timeout: 30000 }
      );
      check('real ffmpeg: тестовый клип 2с сгенерирован', gen.status === 0 && fs.existsSync(inClip), realFfmpeg);

      const pIn = await execOn(REAL_PORT, { tool: 'media_probe', args: { path: 'in.mp4' } });
      const vIn = (pIn.streams || []).find((s) => s.type === 'video');
      check('real media_probe: in.mp4 (duration≈2, 320x240, hasVideo)',
        pIn.ok === true && Math.abs((pIn.duration || 0) - 2) < 0.25
        && pIn.hasVideo === true && vIn?.width === 320 && vIn?.height === 240,
        JSON.stringify({ duration: pIn.duration, vIn }));

      const rCut = await execOn(REAL_PORT, {
        tool: 'media_render',
        args: { args: ['-i', 'in.mp4', '-ss', '0.5', '-t', '1', '-pix_fmt', 'yuv420p', 'out.mp4'] },
      });
      check('real media_render: обрезка -ss 0.5 -t 1 → out.mp4',
        rCut.ok === true && rCut.exitCode === 0 && fs.existsSync(rCut.outPath) && (rCut.progress?.seconds || 0) > 0.5,
        JSON.stringify({ outPath: rCut.outPath, progress: rCut.progress }));

      const pOut = await execOn(REAL_PORT, { tool: 'media_probe', args: { path: 'out.mp4' } });
      const vOut = (pOut.streams || []).find((s) => s.type === 'video');
      check('real media_probe: out.mp4 (duration≈1, 320x240)',
        pOut.ok === true && Math.abs((pOut.duration || 0) - 1) < 0.25 && vOut?.width === 320 && vOut?.height === 240,
        JSON.stringify({ duration: pOut.duration, vOut }));
    } finally {
      srvReal.kill();
    }
  }

  srv.kill();
  mock.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `\n${failed} тестов упало` : '\nВсе тесты прошли');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
