// Мок OpenAI-совместимого провайдера для интеграционных тестов.
//   POST /v1/bad/chat/completions  → всегда 429 (имитация лимита)
//   POST /v1/good/chat/completions → SSE-стрим
//   GET  /v1/good/models           → список моделей
'use strict';
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/good/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-70b' }, { id: 'mock-flash' }, { id: 'mock-embed' }] }));
  }
  if (req.method === 'POST' && req.url === '/v1/bad/chat/completions') {
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
  }
  if (req.method === 'POST' && req.url === '/v1/good/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = ['При', 'вет', ', мир'];
    let i = 0;
    const t = setInterval(() => {
      if (i < chunks.length) {
        const d = { choices: [{ delta: { content: chunks[i++] } }] };
        res.write(`data: ${JSON.stringify(d)}\n\n`);
      } else {
        res.write('data: [DONE]\n\n');
        res.end();
        clearInterval(t);
      }
    }, 15);
    req.on('close', () => clearInterval(t));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

if (require.main === module) {
  server.listen(Number(process.env.PORT || 9101), '127.0.0.1', () => console.log('mock provider on 9101'));
}
module.exports = server;
