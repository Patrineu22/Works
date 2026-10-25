/**
 * Dev-only OpenAI-compatible mock used by tests and manual CLI checks.
 *   node tests/mock-server.mjs [port]
 * Point .freecode/config.json providers.pollinations.baseUrl at it to run the
 * CLI fully offline.
 */
import http from 'node:http';

const port = Number(process.argv[2] || 8787);

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'freecode-mock' }] }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }
    const messages = parsed.messages || [];
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const agent = /Active agent: (\w+)/.exec(system)?.[1] || 'ALEX';
    const reply = [
      `**${agent} mock reply** for: \`${last.slice(0, 80)}\``,
      '',
      'Here is a small snippet:',
      '```js',
      'const green = "#00FF88";',
      'console.log(green);',
      '```',
      '- keyless gateway path works',
      '- streaming works',
      `system prompt bytes: ${system.length}`,
    ].join('\n');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const words = reply.match(/\S+\s*/g) || [reply];
    let i = 0;
    const timer = setInterval(() => {
      if (i >= words.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ model: 'freecode-mock', choices: [{ delta: { content: words[i++] } }] })}\n\n`);
    }, 8);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mock model server on http://0.0.0.0:${port}/v1`);
});
