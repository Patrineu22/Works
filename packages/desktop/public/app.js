/**
 * FreeCode desktop renderer - talks to the local server with relative URLs only
 * (never localhost), so it works inside a Tauri window or a proxied preview.
 */
const state = {
  agent: 'alex',
  sessions: [],
  activeSession: null,
  messages: [],
  prompts: {},
  config: {},
  streaming: false,
};

const AGENTS = [
  { id: 'alex', name: 'ALEX', blurb: 'coding genius' },
  { id: 'jim', name: 'JIM', blurb: 'white-hat mentor' },
  { id: 'kai', name: 'KAI', blurb: 'own-device lab' },
];

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

/* ------------------------------------------------------------------ render */

function renderAgents() {
  const box = $('agent-list');
  box.innerHTML = '';
  for (const agent of AGENTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `agent${agent.id === state.agent ? ' active' : ''}`;
    btn.innerHTML = `${agent.name}<small>${agent.blurb}</small>`;
    btn.addEventListener('click', () => {
      state.agent = agent.id;
      $('agent-pill').textContent = agent.name;
      $('status-agent').textContent = `agent ${agent.name}`;
      renderAgents();
    });
    box.appendChild(btn);
  }
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  if (!state.messages.length) {
    const intro = document.createElement('div');
    intro.className = 'msg system';
    intro.innerHTML = '<div class="body">New session. Ask a question, or type <code>/scan</code> with KAI for the own-device workflow.</div>';
    box.appendChild(intro);
    return;
  }
  for (const msg of state.messages) {
    const el = document.createElement('div');
    el.className = `msg ${msg.role}`;
    const who = msg.role === 'user' ? 'you' : msg.role === 'assistant' ? agentName() : 'freecode';
    el.innerHTML = `<div class="who">${who}</div><div class="body"></div>${msg.meta ? `<div class="meta">${escapeHtml(msg.meta)}</div>` : ''}`;
    el.querySelector('.body').textContent = msg.text;
    box.appendChild(el);
  }
  box.scrollTop = box.scrollHeight;
}

function agentName() {
  return AGENTS.find((a) => a.id === state.agent)?.name || 'ALEX';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSessions() {
  const box = $('session-list');
  box.innerHTML = '';
  for (const session of state.sessions.slice().reverse()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `session-item${session.id === state.activeSession ? ' active' : ''}`;
    btn.textContent = session.title || 'untitled';
    btn.title = new Date(session.updatedAt || Date.now()).toLocaleString();
    btn.addEventListener('click', () => {
      state.activeSession = session.id;
      state.messages = session.messages || [];
      renderSessions();
      renderMessages();
    });
    box.appendChild(btn);
  }
}

/* ------------------------------------------------------------------- chat */

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = '';
  state.streaming = true;
  $('send').disabled = true;
  $('status-state').textContent = 'thinking…';

  state.messages.push({ role: 'user', text });
  renderMessages();

  const replyIndex = state.messages.push({ role: 'assistant', text: '' }) - 1;
  renderMessages();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: state.agent, message: text, session: state.activeSession, history: state.messages.slice(0, -1) }),
    });
    if (!res.ok || !res.body) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const event of events) {
        const line = event.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.token) {
          state.messages[replyIndex].text += payload.token;
          renderMessages();
        }
        if (payload.meta) {
          state.messages[replyIndex].meta = payload.meta;
          renderMessages();
        }
        if (payload.error) {
          state.messages[replyIndex].text += `\n\n[error] ${payload.error}`;
          renderMessages();
        }
      }
    }
  } catch (err) {
    state.messages[replyIndex].text = `Could not reach the gateway: ${err.message}\n\nTry Settings → Gateway → Test gateway, or run the CLI: freecode --check`;
    renderMessages();
  } finally {
    state.streaming = false;
    $('send').disabled = false;
    $('status-state').textContent = 'ready';
    persistSession();
  }
}

async function persistSession() {
  try {
    const result = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: state.activeSession,
        title: state.messages.find((m) => m.role === 'user')?.text?.slice(0, 48) || 'new session',
        messages: state.messages,
      }),
    });
    state.activeSession = result.id;
    state.sessions = result.sessions;
    renderSessions();
  } catch {
    /* sessions are best-effort */
  }
}

/* ------------------------------------------------------------------- tree */

async function loadTree(dir = '.') {
  const box = $('tree');
  box.innerHTML = '<div class="hint">loading…</div>';
  try {
    const data = await api(`/api/files?dir=${encodeURIComponent(dir)}`);
    box.innerHTML = '';
    if (dir !== '.') {
      const up = document.createElement('div');
      up.className = 'row dir';
      up.textContent = '..';
      up.addEventListener('click', () => loadTree(data.parent || '.'));
      box.appendChild(up);
    }
    for (const entry of data.entries) {
      const row = document.createElement('div');
      row.className = `row${entry.dir ? ' dir' : ''}`;
      row.innerHTML = `<span>${entry.dir ? '▸' : '·'}</span><span>${escapeHtml(entry.name)}</span>${entry.size != null ? `<span class="size">${entry.size}b</span>` : ''}`;
      row.addEventListener('click', () => {
        if (entry.dir) loadTree(entry.path);
        else previewFile(entry.path);
      });
      box.appendChild(row);
    }
    if (!data.entries.length) box.innerHTML = '<div class="hint">empty directory</div>';
  } catch (err) {
    box.innerHTML = `<div class="hint">${escapeHtml(err.message)}</div>`;
  }
}

async function previewFile(file) {
  const pre = $('preview');
  pre.textContent = 'loading…';
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(file)}`);
    pre.textContent = `${file}\n${'-'.repeat(Math.max(8, file.length))}\n${data.content}`;
  } catch (err) {
    pre.textContent = err.message;
  }
}

/* --------------------------------------------------------------- settings */

async function openSettings() {
  $('settings').hidden = false;
  try {
    const [prompts, config] = await Promise.all([api('/api/prompts'), api('/api/config')]);
    state.prompts = prompts.prompts;
    state.config = config;
    $('prompt-global').value = prompts.prompts.global || '';
    $('prompt-jim').value = prompts.prompts.jim || '';
    $('prompt-kai').value = prompts.prompts.kai || '';
    $('prompt-alex').value = prompts.prompts.alex || '';
    $('cfg-agent').value = config.agent || 'alex';
    $('cfg-model').value = config.model || '';
    $('cfg-temp').value = config.temperature ?? 0.7;
    $('cfg-openrouter').value = config.keys?.OPENROUTER_API_KEY || '';
    $('cfg-openai').value = config.keys?.OPENAI_API_KEY || '';
    $('prompts-msg').textContent = '';
    $('prompts-msg').className = 'msg';
  } catch (err) {
    $('prompts-msg').textContent = err.message;
    $('prompts-msg').className = 'msg error';
  }
}

async function savePrompts() {
  const msg = $('prompts-msg');
  msg.className = 'msg';
  msg.textContent = 'saving…';
  try {
    const body = {
      global: $('prompt-global').value,
      jim: $('prompt-jim').value,
      kai: $('prompt-kai').value,
      alex: $('prompt-alex').value,
    };
    const result = await api('/api/prompts', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = result.message || 'Saved - prompts reloaded';
    loadStatus();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = `Save failed: ${err.message}`;
  }
}

async function resetPrompts() {
  try {
    const result = await api('/api/prompts/defaults');
    $('prompt-global').value = result.prompts.global;
    $('prompt-jim').value = result.prompts.jim;
    $('prompt-kai').value = result.prompts.kai;
    $('prompt-alex').value = result.prompts.alex;
    $('prompts-msg').textContent = 'defaults loaded — press Save to apply';
  } catch (err) {
    $('prompts-msg').className = 'msg error';
    $('prompts-msg').textContent = err.message;
  }
}

async function saveAgent() {
  const msg = $('agent-msg');
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        agent: $('cfg-agent').value.trim() || 'alex',
        model: $('cfg-model').value.trim() || null,
        temperature: Number($('cfg-temp').value) || 0.7,
      }),
    });
    msg.className = 'msg';
    msg.textContent = 'saved';
    loadStatus();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
}

async function saveGateway() {
  const msg = $('gateway-msg');
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        keys: {
          OPENROUTER_API_KEY: $('cfg-openrouter').value.trim(),
          OPENAI_API_KEY: $('cfg-openai').value.trim(),
        },
      }),
    });
    msg.className = 'msg';
    msg.textContent = 'saved';
    loadStatus();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
}

async function checkGateway() {
  const out = $('gateway-result');
  const msg = $('gateway-msg');
  msg.className = 'msg';
  msg.textContent = 'testing…';
  out.textContent = '';
  try {
    const result = await api('/api/check', { method: 'POST' });
    out.textContent = result.results
      .map((r) => `${r.ok ? '✔' : '✖'} ${r.provider.padEnd(14)} ${String(r.status).padEnd(4)} ${r.ms}ms  ${r.note}`)
      .join('\n');
    msg.textContent = result.ok ? 'at least one endpoint reachable' : 'no endpoint reachable';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
}

async function loadStatus() {
  try {
    const status = await api('/api/status');
    $('status-model').textContent = `freecode v${status.version} · ${status.model}`;
    $('status-root').textContent = status.root;
    $('provider-pill').textContent = status.providerLabel || 'keyless free gateway';
    $('status-state').textContent = status.providerKeyless ? 'keyless free gateway' : 'your key';
  } catch {
    $('status-state').textContent = 'offline';
  }
}

/* ------------------------------------------------------------------- init */

function wire() {
  $('send').addEventListener('click', send);
  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  $('settings-btn').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', () => {
    $('settings').hidden = true;
  });
  $('save-prompts').addEventListener('click', savePrompts);
  $('reset-prompts').addEventListener('click', resetPrompts);
  $('save-agent').addEventListener('click', saveAgent);
  $('save-gateway').addEventListener('click', saveGateway);
  $('check-gateway').addEventListener('click', checkGateway);
  $('new-session').addEventListener('click', async () => {
    state.activeSession = null;
    state.messages = [];
    renderMessages();
    try {
      const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ messages: [] }) });
      state.activeSession = result.id;
      state.sessions = result.sessions;
      renderSessions();
    } catch {
      /* ignore */
    }
  });
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tabs button')) other.classList.toggle('active', other === tab);
      for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $('settings').hidden = true;
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      openSettings();
    }
  });
}

async function init() {
  wire();
  renderAgents();
  renderMessages();
  loadStatus();
  loadTree('.');
  try {
    const sessions = await api('/api/sessions');
    state.sessions = sessions.sessions || [];
    renderSessions();
  } catch {
    /* ignore */
  }
}

init();
