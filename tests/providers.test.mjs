import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  buildProviderChain,
  streamCompletion,
  extractText,
  parseSseData,
  toWireMessages,
  explainFailures,
  probeProviders,
} from '../src/providers.mjs';

test('keyless gateway is in the chain with no keys configured', () => {
  const chain = buildProviderChain({}, {});
  const ids = chain.map((c) => c.id);
  assert.ok(ids.includes('pollinations'), 'pollinations must be keyless default');
  assert.equal(chain[0].id, 'pollinations');
  assert.ok(chain.find((c) => c.id === 'pollinations').keyless);
});

test('provider keys add providers and are tried first', () => {
  const chain = buildProviderChain(
    { keys: { OPENROUTER_API_KEY: 'sk-or-test', OPENAI_API_KEY: 'sk-test' }, providers: { openai: { enabled: true }, openrouter: { enabled: true } } },
    {},
  );
  assert.equal(chain[0].id, 'openai');
  assert.ok(chain.some((c) => c.id === 'openrouter' && c.model.includes(':free')));
  assert.ok(chain.some((c) => c.id === 'pollinations'), 'keyless stays as fallback');
});

test('explicit provider is moved to the front', () => {
  const chain = buildProviderChain({ provider: 'ollama' }, {});
  assert.equal(chain[0].id, 'ollama');
});

test('extractText handles all provider shapes', () => {
  assert.equal(extractText({ choices: [{ message: { content: 'a' } }] }), 'a');
  assert.equal(extractText({ choices: [{ delta: { content: 'b' } }] }), 'b');
  assert.equal(extractText({ choices: [{ text: 'c' }] }), 'c');
  assert.equal(extractText({ content: 'd' }), 'd');
  assert.equal(extractText({}), '');
});

test('sse parsing', () => {
  assert.deepEqual(parseSseData('[DONE]').done, true);
  assert.equal(parseSseData('{"choices":[{"delta":{"content":"hi"}}]}').text, 'hi');
  assert.equal(parseSseData('not json').text, '');
});

test('wire messages drop empty/system noise safely', () => {
  const wire = toWireMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.deepEqual(wire, [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('failures are explained with actionable hints', () => {
  const text = explainFailures([{ provider: 'pollinations', model: 'openai', status: 429, error: 'slow down', hint: 'rate limited/retry later' }]);
  assert.match(text, /pollinations/);
  assert.match(text, /429/);
  assert.match(text, /ollama/);
});

/** Local OpenAI-compatible mock so streaming is tested end to end, offline. */
function startMock({ mode = 'stream' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (mode === 'stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const piece of ['Hello', ', ', 'green ', 'world']) {
          res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (mode === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: `json:${parsed.messages.at(-1).content}` } }] }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test('streams tokens from an OpenAI-compatible endpoint', async () => {
  const { server, baseUrl } = await startMock({ mode: 'stream' });
  try {
    const chain = [{ id: 'mock', label: 'Mock', baseUrl, model: 'mock-model', keyless: true }];
    const tokens = [];
    const result = await streamCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      chain,
      onToken: (t) => tokens.push(t),
    });
    assert.equal(result.text, 'Hello, green world');
    assert.equal(result.provider, 'mock');
    assert.equal(result.model, 'mock-model');
    assert.equal(result.keyless, true);
    assert.ok(tokens.length >= 4);
  } finally {
    server.close();
  }
});

test('handles a non-streaming JSON response', async () => {
  const { server, baseUrl } = await startMock({ mode: 'json' });
  try {
    const chain = [{ id: 'mock', label: 'Mock', baseUrl, model: 'm', keyless: true }];
    const result = await streamCompletion({ messages: [{ role: 'user', content: 'ping' }], chain });
    assert.equal(result.text, 'json:ping');
  } finally {
    server.close();
  }
});

test('falls through a failing provider to a working one', async () => {
  const bad = await startMock({ mode: 'fail' });
  const good = await startMock({ mode: 'stream' });
  try {
    const chain = [
      { id: 'bad', label: 'Bad', baseUrl: bad.baseUrl, model: 'm', keyless: true },
      { id: 'good', label: 'Good', baseUrl: good.baseUrl, model: 'm', keyless: true },
    ];
    const result = await streamCompletion({ messages: [{ role: 'user', content: 'hi' }], chain });
    assert.equal(result.text, 'Hello, green world');
    assert.equal(result.provider, 'good');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].status, 500);
  } finally {
    bad.server.close();
    good.server.close();
  }
});

test('throws a helpful GatewayError when everything fails', async () => {
  const bad = await startMock({ mode: 'fail' });
  try {
    const chain = [{ id: 'bad', label: 'Bad', baseUrl: bad.baseUrl, model: 'm', keyless: true }];
    await assert.rejects(
      () => streamCompletion({ messages: [{ role: 'user', content: 'hi' }], chain }),
      (err) => {
        assert.match(err.message, /All providers failed/);
        assert.match(err.message, /freecode --check/);
        return true;
      },
    );
  } finally {
    bad.server.close();
  }
});

test('probeProviders reports reachability', async () => {
  const { server, baseUrl } = await startMock();
  try {
    const results = await probeProviders({ chain: [{ id: 'mock', label: 'Mock', baseUrl, model: 'm' }] });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].status, 200);
  } finally {
    server.close();
  }
});

test('network errors are reported, not thrown, during probe', async () => {
  const results = await probeProviders({ chain: [{ id: 'dead', label: 'Dead', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' }], timeoutMs: 1500 });
  assert.equal(results[0].ok, false);
});
