#!/usr/bin/env node
/**
 * FreeCode desktop server - zero dependencies.
 *
 * Serves the UI and a small JSON/SSE API. No build step, no bundler, so it also
 * runs happily inside a Tauri window (tauri.conf points at this server) and in
 * a proxied preview. Browser code only ever uses relative URLs.
 *
 *   node server.mjs --port 4321 --root <project>
 *
 * API
 *   GET  /api/status            version, provider chain, roles
 *   GET  /api/prompts           editable system prompts
 *   POST /api/prompts           save prompts  -> "Saved - prompts reloaded"
 *   GET  /api/prompts/defaults  built-in prompts
 *   GET  /api/config            redacted config
 *   POST /api/config            update agent/model/temperature/keys
 *   POST /api/check             probe gateway endpoints
 *   POST /api/chat              SSE stream of assistant tokens
 *   GET  /api/files?dir=path    directory listing (root-confined)
 *   GET  /api/file?path=file    text preview (root-confined)
 *   GET  /api/sessions          list desktop sessions
 *   POST /api/sessions          upsert a session
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROMPTS,
  AGENTS,
  getAgent,
  buildSystemPrompt,
  loadSystemPrompts,
  saveSystemPrompts,
  findPromptsFile,
} from '../../src/agents.mjs';
import {
  findProjectRoot,
  ensureState,
  loadConfig,
  saveConfig,
  stateDir,
  configPath,
  promptsPath,
} from '../../src/config.mjs';
import { buildProviderChain, streamCompletion, probeProviders, GatewayError, FREE_GATEWAY_NOTICE } from '../../src/providers.mjs';
import { discoverNetworks } from '../../src/scan.mjs';
import { listDir, readTextFile, resolveInside, ToolError } from '../../src/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT || 4321));
const HOST = arg('host', '0.0.0.0');
const ROOT = path.resolve(arg('root', findProjectRoot()));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Desktop sessions live in memory and are mirrored to .freecode/sessions. */
const sessions = new Map();
const sessionsDir = path.join(stateDir(ROOT), 'sessions');

function loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(sessionsDir)) return;
    for (const file of fs.readdirSync(sessionsDir).filter((f) => f.startsWith('desktop-') && f.endsWith('.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
      if (data?.id) sessions.set(data.id, data);
    }
  } catch {
    /* corrupt session files are ignored */
  }
}

function sessionList() {
  return [...sessions.values()]
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .map(({ id, title, updatedAt, agent }) => ({ id, title, updatedAt, agent }));
}

function upsertSession(input) {
  const id = input.id || `desktop-${Date.now()}`;
  const record = {
    id,
    title: (input.title || 'new session').slice(0, 80),
    agent: input.agent || 'alex',
    messages: Array.isArray(input.messages) ? input.messages.slice(-200) : [],
    updatedAt: Date.now(),
  };
  sessions.set(id, record);
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(record, null, 2));
  } catch {
    /* read-only project: keep it in memory */
  }
  return { id, sessions: sessionList() };
}

/* ------------------------------------------------------------------ helpers */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid JSON body');
  }
}

function redact(config) {
  const keys = config.keys || {};
  const mask = (value) => (value ? `${String(value).slice(0, 6)}…${String(value).slice(-4)}` : '');
  return {
    agent: config.agent,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    provider: config.provider,
    providers: config.providers,
    keys: { OPENROUTER_API_KEY: mask(keys.OPENROUTER_API_KEY), OPENAI_API_KEY: mask(keys.OPENAI_API_KEY) },
  };
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const candidates = [path.join(HERE, rel), path.join(HERE, 'public', rel)];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(HERE + path.sep)) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      const body = fs.readFileSync(resolved);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ routes */

async function handleChat(req, res) {
  const body = await readJson(req);
  const agentId = getAgent(body.agent)?.id || 'alex';
  const config = loadConfig(ROOT);
  const { prompts } = loadSystemPrompts(findPromptsFile(ROOT) || promptsPath(ROOT));
  const userText = String(body.message || '').trim();
  if (!userText) return json(res, 400, { error: 'empty message' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // KAI convenience: list networks, never test from the desktop (consent flow
  // needs the terminal's interactive confirmation).
  if (agentId === 'kai' && /^\/?scan\b/i.test(userText)) {
    const discovery = discoverNetworks();
    if (!discovery.networks.length) {
      send({ token: `Network discovery is not available here (${discovery.error || 'no networks'}).\n\nRun \`freecode --agent kai\` in a terminal and type /scan for the full own-device workflow (scan → list → pick → verify → test).` });
    } else {
      const lines = discovery.networks
        .filter((n) => n.ssid)
        .map((n, i) => `${i + 1}. ${n.ssid}${n.authentication ? ` [${n.authentication}]` : ''}${n.signal ? ` ${n.signal}` : ''}`);
      send({
        token: [
          `Found networks (${discovery.command}):`,
          ...lines,
          '',
          'Which one is YOUR OWN device? Testing only runs in the terminal, where FreeCode asks you to confirm ownership:',
          '```',
          'freecode --agent kai',
          '/scan',
          '```',
        ].join('\n'),
        meta: 'scan list only · no tests run from the desktop',
      });
    }
    send({ done: true });
    return res.end();
  }

  const history = Array.isArray(body.history) ? body.history : [];
  const messages = [
    { role: 'system', content: buildSystemPrompt(agentId, prompts, { extra: `Working directory: ${ROOT}` }) },
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
      .slice(-20)
      .map((m) => ({ role: m.role, content: String(m.text) })),
    { role: 'user', content: userText },
  ];

  const chain = buildProviderChain(config);
  try {
    const result = await streamCompletion({
      messages,
      config,
      chain,
      onToken: (token) => send({ token }),
      onProvider: (entry) => send({ provider: entry.id }),
    });
    send({ meta: `⚡ ${result.provider} · ${result.model} · ${result.keyless ? 'keyless' : 'your key'}` });
    send({ done: true });
    res.end();
  } catch (err) {
    const message = err instanceof GatewayError ? err.message : err.message;
    send({ error: message });
    send({ done: true });
    res.end();
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      const config = loadConfig(ROOT);
      const chain = buildProviderChain(config);
      return json(res, 200, {
        version: PKG.version,
        root: ROOT,
        agents: AGENTS.map((a) => ({ id: a.id, name: a.name, title: a.title })),
        model: config.model || chain[0]?.model || 'provider default',
        providerLabel: chain[0]?.label || 'no provider',
        providerKeyless: Boolean(chain[0]?.keyless),
        notice: FREE_GATEWAY_NOTICE,
        configPath: configPath(ROOT),
      });
    }

    if (pathname === '/api/prompts' && req.method === 'GET') {
      const file = findPromptsFile(ROOT) || promptsPath(ROOT);
      const loaded = loadSystemPrompts(file);
      return json(res, 200, { file, prompts: loaded.prompts, error: loaded.error, defaults: DEFAULT_PROMPTS });
    }

    if (pathname === '/api/prompts' && req.method === 'POST') {
      const body = await readJson(req);
      const file = findPromptsFile(ROOT) || promptsPath(ROOT);
      const prompts = {
        global: String(body.global ?? ''),
        jim: String(body.jim ?? ''),
        kai: String(body.kai ?? ''),
        alex: String(body.alex ?? ''),
      };
      const empty = Object.entries(prompts).filter(([, v]) => !v.trim()).map(([k]) => k);
      if (empty.length) return json(res, 400, { error: `these prompts are empty: ${empty.join(', ')}` });
      saveSystemPrompts(prompts, file);
      const verify = loadSystemPrompts(file);
      if (verify.error) return json(res, 500, { error: `written file failed to reload: ${verify.error}` });
      return json(res, 200, { ok: true, file, message: 'Saved - prompts reloaded', prompts: verify.prompts });
    }

    if (pathname === '/api/prompts/defaults' && req.method === 'GET') {
      return json(res, 200, { prompts: DEFAULT_PROMPTS });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, redact(loadConfig(ROOT)));
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readJson(req);
      const config = loadConfig(ROOT);
      if (body.agent && getAgent(body.agent)) config.agent = getAgent(body.agent).id;
      if ('model' in body) config.model = body.model || null;
      if ('temperature' in body) config.temperature = Number(body.temperature) || 0.7;
      if ('provider' in body) config.provider = body.provider || null;
      if (body.keys && typeof body.keys === 'object') {
        config.keys = { ...config.keys };
        for (const [key, value] of Object.entries(body.keys)) {
          // A masked value coming back from the UI must not overwrite the real key.
          if (typeof value === 'string' && !value.includes('…')) config.keys[key] = value;
        }
      }
      const file = saveConfig(config, ROOT);
      return json(res, 200, { ok: true, file, config: redact(loadConfig(ROOT)) });
    }

    if (pathname === '/api/check' && req.method === 'POST') {
      const config = loadConfig(ROOT);
      const results = await probeProviders({ config, chain: buildProviderChain(config) });
      return json(res, 200, { ok: results.some((r) => r.ok), results });
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res);
    }

    if (pathname === '/api/files' && req.method === 'GET') {
      const dir = url.searchParams.get('dir') || '.';
      const entries = listDir(dir, { root: ROOT, depth: 1 }).map((row) => ({
        name: row.rel.replace(/\/$/, '').split('/').pop(),
        path: row.rel.replace(/\/$/, ''),
        dir: row.type === 'dir',
        size: row.size,
      }));
      return json(res, 200, { dir, parent: dir === '.' ? '.' : path.dirname(dir), entries });
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      const file = url.searchParams.get('path') || '';
      const data = readTextFile(file, { root: ROOT, maxBytes: 60_000 });
      return json(res, 200, { path: file, content: data.content, truncated: data.truncated, bytes: data.bytes });
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, { sessions: sessionList() });
    }

    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, upsertSession(body));
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: `no route ${pathname}` });

    if (req.method === 'GET' && serveStatic(res, pathname)) return undefined;
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof ToolError) return json(res, 400, { error: err.message });
    return json(res, 500, { error: err.message });
  }
}

ensureState(ROOT);
loadSessionsFromDisk();

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    try {
      json(res, 500, { error: err.message });
    } catch {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  const actual = server.address().port;
  console.log(`FreeCode desktop  →  http://${HOST}:${actual}`);
  console.log(`  project root : ${ROOT}`);
  console.log(`  ${FREE_GATEWAY_NOTICE}`);
});

export { server, route };
