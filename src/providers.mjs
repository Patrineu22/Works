/**
 * FreeCode Free Gateway - keyless, unlimited, free forever.
 *
 * Chain (first available wins, failures fall through automatically):
 *   1. an explicitly configured provider (.freecode/config.json -> "provider")
 *   2. OpenAI        when OPENAI_API_KEY is present
 *   3. OpenRouter    when OPENROUTER_API_KEY is present (free models)
 *   4. Pollinations  keyless OpenAI-compatible endpoint  <- default primary
 *   5. Ollama        local models, keyless
 *
 * Everything speaks the OpenAI /chat/completions shape, so one code path drives
 * all of them. No SDKs, only global fetch (Node 18+).
 */
import process from 'node:process';

export const FREE_GATEWAY_NOTICE = '⚡ FreeCode Free Gateway active - keyless free forever';

export class GatewayError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = 'GatewayError';
    this.attempts = attempts;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

function providerConfig(config, id) {
  return (config?.providers && config.providers[id]) || {};
}

function keyFor(config, name) {
  return (config?.keys && config.keys[name]) || process.env[name] || '';
}

/**
 * Build the ordered provider chain. Entries are expanded per model so
 * OpenRouter's free-model list is tried one after another.
 */
export function buildProviderChain(config = {}, env = process.env) {
  const chain = [];
  const push = (entry) => {
    if (!entry.enabled) return;
    if (entry.needsKey && !entry.apiKey) return;
    chain.push(entry);
  };

  const preferred = config.provider;
  const openaiKey = keyFor(config, 'OPENAI_API_KEY');
  const openrouterKey = keyFor(config, 'OPENROUTER_API_KEY');

  if (openaiKey) {
    const p = providerConfig(config, 'openai');
    push({
      id: 'openai',
      label: 'OpenAI (your key)',
      baseUrl: p.baseUrl || 'https://api.openai.com/v1',
      model: config.model || p.model || 'gpt-4o-mini',
      apiKey: openaiKey,
      needsKey: true,
      enabled: p.enabled !== false,
    });
  }

  if (openrouterKey) {
    const p = providerConfig(config, 'openrouter');
    const models = config.model ? [config.model] : p.models || [p.model || 'deepseek/deepseek-r1:free'];
    for (const model of models) {
      push({
        id: 'openrouter',
        label: 'OpenRouter (your key)',
        baseUrl: p.baseUrl || 'https://openrouter.ai/api/v1',
        model,
        apiKey: openrouterKey,
        needsKey: true,
        enabled: p.enabled !== false,
        headers: { 'HTTP-Referer': 'https://github.com/freecode', 'X-Title': 'FreeCode' },
      });
    }
  }

  const poll = providerConfig(config, 'pollinations');
  push({
    id: 'pollinations',
    label: 'Pollinations (keyless)',
    baseUrl: poll.baseUrl || 'https://text.pollinations.ai/openai',
    model: config.model || poll.model || 'openai',
    apiKey: '',
    needsKey: false,
    keyless: true,
    enabled: poll.enabled !== false,
  });

  if (env.OLLAMA_HOST || true) {
    const ollama = providerConfig(config, 'ollama');
    push({
      id: 'ollama',
      label: 'Ollama (local, keyless)',
      baseUrl: env.OLLAMA_HOST ? `${env.OLLAMA_HOST.replace(/\/$/, '')}/v1` : ollama.baseUrl || 'http://127.0.0.1:11434/v1',
      model: config.model || ollama.model || 'llama3.2',
      apiKey: '',
      needsKey: false,
      keyless: true,
      local: true,
      enabled: ollama.enabled !== false,
    });
  }

  if (!preferred) return chain;

  // Move the explicitly requested provider to the front, keep the rest as fallback.
  const idx = chain.findIndex((entry) => entry.id === preferred);
  if (idx > 0) {
    const [first] = chain.splice(idx, 1);
    chain.unshift(first);
  }
  return chain;
}

/** Normalise our message list into the OpenAI wire format. */
export function toWireMessages(messages) {
  return messages
    .filter((m) => m && m.role && typeof m.content === 'string' && m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

/** Pull text out of any of the response shapes the providers use. */
export function extractText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.choices) && payload.choices.length) {
    const choice = payload.choices[0];
    if (typeof choice?.delta?.content === 'string') return choice.delta.content;
    if (typeof choice?.message?.content === 'string') return choice.message.content;
    if (typeof choice?.text === 'string') return choice.text;
  }
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.response === 'string') return payload.response;
  return '';
}

/** Turn an SSE `data:` line into a text delta. */
export function parseSseData(data) {
  const trimmed = String(data).trim();
  if (!trimmed || trimmed === '[DONE]') return { done: true, text: '' };
  try {
    const json = JSON.parse(trimmed);
    if (json.error) return { done: true, text: '', error: json.error.message || String(json.error) };
    return { done: false, text: extractText(json), model: json.model };
  } catch {
    return { done: false, text: '' };
  }
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}/${suffix}`;
}

async function readErrorBody(res) {
  try {
    const text = await res.text();
    if (!text) return res.statusText;
    try {
      const json = JSON.parse(text);
      return json?.error?.message || json?.message || text.slice(0, 400);
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return res.statusText;
  }
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return timeout;
}

/**
 * Stream a completion, falling through the chain until one provider produces text.
 *
 * @returns {Promise<{text:string, provider:string, model:string, keyless:boolean}>}
 */
export async function streamCompletion({
  messages,
  config = {},
  chain = buildProviderChain(config),
  signal,
  onToken = () => {},
  onProvider = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!chain.length) {
    throw new GatewayError(
      'No provider available. Enable the keyless gateway or add a key in .freecode/config.json.',
    );
  }
  const attempts = [];
  const wire = toWireMessages(messages);
  if (!wire.length) throw new GatewayError('Nothing to send: the conversation is empty.');

  for (const entry of chain) {
    const url = joinUrl(entry.baseUrl, 'chat/completions');
    const body = {
      model: entry.model,
      messages: wire,
      stream: true,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 2048,
    };
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (entry.apiKey) headers.Authorization = `Bearer ${entry.apiKey}`;
    Object.assign(headers, entry.headers || {});

    let emitted = '';
    try {
      onProvider(entry);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: withTimeout(signal, timeoutMs),
      });

      if (!res.ok) {
        const detail = await readErrorBody(res);
        attempts.push({
          provider: entry.id,
          model: entry.model,
          status: res.status,
          error: detail,
          hint: res.status === 401 ? 'needs a valid key' : res.status === 429 ? 'rate limited/retry later' : '',
        });
        continue;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      let usedModel = entry.model;

      // Non-streaming JSON response (some providers ignore stream:true).
      if (contentType.includes('application/json')) {
        const payload = await res.json();
        const text = extractText(payload);
        if (!text) {
          attempts.push({ provider: entry.id, model: entry.model, error: 'empty response' });
          continue;
        }
        usedModel = payload.model || usedModel;
        emitted += text;
        onToken(text);
        return { text: emitted, provider: entry.id, model: usedModel, keyless: Boolean(entry.keyless), attempts };
      }

      if (!res.body) {
        attempts.push({ provider: entry.id, model: entry.model, error: 'no response body' });
        continue;
      }

      let buffer = '';
      let done = false;
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const parsed = parseSseData(line.slice(5));
          if (parsed.model) usedModel = parsed.model;
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.text) {
            emitted += parsed.text;
            onToken(parsed.text);
          }
          if (parsed.done) {
            done = true;
            break;
          }
        }
        if (done) break;
      }

      if (emitted.trim()) {
        return { text: emitted, provider: entry.id, model: usedModel, keyless: Boolean(entry.keyless), attempts };
      }
      attempts.push({ provider: entry.id, model: entry.model, error: 'stream ended without text' });
    } catch (err) {
      if (signal?.aborted) throw err;
      attempts.push({ provider: entry.id, model: entry.model, error: err.message });
      // If we already streamed some text, do not silently restart elsewhere.
      if (emitted.trim()) {
        return { text: emitted, provider: entry.id, model: entry.model, keyless: Boolean(entry.keyless), attempts, partial: true };
      }
    }
  }

  throw new GatewayError(explainFailures(attempts), attempts);
}

/** Human-readable summary of every failed attempt. */
export function explainFailures(attempts) {
  const lines = ['All providers failed.'];
  for (const a of attempts) {
    const bits = [`  - ${a.provider}${a.model ? ` (${a.model})` : ''}`];
    if (a.status) bits.push(`HTTP ${a.status}`);
    if (a.error) bits.push(a.error);
    if (a.hint) bits.push(`[${a.hint}]`);
    lines.push(bits.join(' '));
  }
  lines.push('');
  lines.push('Things to try:');
  lines.push('  freecode --check                 test each gateway endpoint');
  lines.push('  add OPENROUTER_API_KEY=sk-or-... to .freecode/config.json keys');
  lines.push('  or run a local model:  ollama serve  &&  ollama pull llama3.2');
  return lines.join('\n');
}

/** Lightweight reachability probe used by `--check` and `/providers`. */
export async function probeProviders({
  config = {},
  chain = buildProviderChain(config),
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const results = [];
  for (const entry of chain) {
    const started = Date.now();
    try {
      const res = await fetchImpl(joinUrl(entry.baseUrl, 'models'), {
        method: 'GET',
        headers: entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      results.push({
        provider: entry.id,
        label: entry.label,
        model: entry.model,
        ok: res.ok || res.status === 401 || res.status === 403,
        status: res.status,
        ms: Date.now() - started,
        note: res.ok ? 'reachable' : `HTTP ${res.status}`,
      });
    } catch (err) {
      results.push({
        provider: entry.id,
        label: entry.label,
        model: entry.model,
        ok: false,
        status: 0,
        ms: Date.now() - started,
        note: err.name === 'TimeoutError' ? 'timeout' : err.message,
      });
    }
  }
  return results;
}
