import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'packages', 'desktop', 'server.mjs');

/** Temp project with prompts + a config pointing at the mock model. */
function makeProject(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-desktop-'));
  fs.mkdirSync(path.join(dir, '.freecode'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.freecode', 'config.json'),
    JSON.stringify({
      agent: 'alex',
      provider: 'pollinations',
      providers: {
        pollinations: { enabled: true, baseUrl, model: 'mock' },
        openrouter: { enabled: false },
        ollama: { enabled: false },
        openai: { enabled: false },
      },
      keys: {},
    }),
  );
  fs.writeFileSync(
    path.join(dir, '.freecode', 'system-prompts.json'),
    JSON.stringify({ global: 'G', jim: 'J', kai: 'K', alex: 'A' }),
  );
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'green\n');
  return dir;
}

function startMockModel() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [] }));
    }
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of ['green ', 'desk ', 'ok']) {
      res.write(`data: ${JSON.stringify({ model: 'mock', choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

async function startDesktop(root) {
  const proc = spawn(process.execPath, [SERVER, '--port', '0', '--root', root], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('desktop server did not start')), 15000);
    proc.stdout.on('data', (chunk) => {
      const match = /http:\/\/[^:]+:(\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    proc.on('exit', (code) => reject(new Error(`desktop server exited with ${code}`)));
  });
  return { proc, port };
}

const get = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (port, p, body) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('desktop server: static UI, prompts, config, files, chat streaming', async () => {
  const mock = await startMockModel();
  const root = makeProject(mock.baseUrl);
  const { proc, port } = await startDesktop(root);
  const base = `http://127.0.0.1:${port}`;
  try {
    // static shell
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /System Prompts/);
    assert.match(html, /id="prompt-kai"/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/logo.png`)).status, 200);
    assert.equal((await fetch(`${base}/styles.css`)).status, 200);

    // status + keyless notice
    const status = await get(port, '/api/status');
    assert.equal(status.body.version, '1.0.0');
    assert.equal(status.body.providerKeyless, true);
    assert.equal(status.body.agents.length, 3);

    // prompts round trip
    const prompts = await get(port, '/api/prompts');
    assert.equal(prompts.body.prompts.jim, 'J');
    const saved = await post(port, '/api/prompts', { global: 'G2', jim: 'J2', kai: 'K2', alex: 'A2' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.message, 'Saved - prompts reloaded');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.freecode', 'system-prompts.json'), 'utf8')).kai, 'K2');
    const rejected = await post(port, '/api/prompts', { global: '', jim: 'x', kai: 'y', alex: 'z' });
    assert.equal(rejected.status, 400);

    // config update
    const cfg = await post(port, '/api/config', { agent: 'kai', temperature: 0.3 });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.config.agent, 'kai');
    assert.equal(cfg.body.config.temperature, 0.3);

    // files
    const files = await get(port, '/api/files?dir=.');
    assert.ok(files.body.entries.some((e) => e.name === 'hello.txt'));
    const file = await get(port, '/api/file?path=hello.txt');
    assert.equal(file.body.content, 'green\n');
    const escape = await fetch(`${base}/api/file?path=../../etc/passwd`);
    assert.equal(escape.status, 400);

    // gateway probe
    const check = await post(port, '/api/check');
    assert.equal(check.body.ok, true);

    // chat streaming
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'alex', message: 'hi', history: [] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"token":"green "/);
    assert.match(text, /"meta":"⚡ pollinations/);

    // KAI scan request from the desktop lists networks, never tests
    const kai = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'kai', message: '/scan', history: [] }),
    }).then((r) => r.text());
    assert.match(kai, /freecode --agent kai|Network discovery/);
    assert.doesNotMatch(kai, /scan\.authorised/);

    // sessions
    const created = await post(port, '/api/sessions', { messages: [{ role: 'user', text: 'hi' }], title: 'demo' });
    assert.equal(created.body.sessions.length, 1);
    const list = await get(port, '/api/sessions');
    assert.equal(list.body.sessions[0].title, 'demo');

    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  } finally {
    proc.kill();
    mock.server.close();
  }
});
