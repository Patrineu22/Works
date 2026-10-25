#!/usr/bin/env node
/**
 * FreeCode CLI - sharp green, keyless-free terminal AI coding agent.
 *
 *   freecode                 interactive session
 *   freecode "explain this"  one-shot answer
 *   freecode --help          all flags and commands
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { fg, bold, dim, band, colorEnabled, setColorEnabled, padEnd, visibleLength } from './theme.mjs';
import { renderBanner, renderLogo, renderHeader, LOGO_DIR } from './logo.mjs';
import { box, header, ok, warn, error, bullet, renderMarkdown, keyValue, spinner } from './ui.mjs';
import {
  findProjectRoot,
  ensureState,
  stateDir,
  loadConfig,
  saveConfig,
  configPath,
  promptsPath,
  auditLogPath,
} from './config.mjs';
import {
  AGENTS,
  DEFAULT_PROMPTS,
  getAgent,
  loadSystemPrompts,
  saveSystemPrompts,
  findPromptsFile,
  watchSystemPrompts,
  buildSystemPrompt,
} from './agents.mjs';
import {
  streamCompletion,
  buildProviderChain,
  probeProviders,
  GatewayError,
  FREE_GATEWAY_NOTICE,
} from './providers.mjs';
import { runKaiWorkflow, passiveSummary, discoverNetworks, COMMON_PORTS } from './scan.mjs';
import { listDir, readTextFile, writeTextFile, diffStat, runCommand, ToolError, resolveInside } from './tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
export const VERSION = PKG.version;

const CMD_NAMES = [
  '/help', '/agent', '/agents', '/scan', '/providers', '/check', '/prompts', '/prompt', '/preset', '/reload',
  '/config', '/set', '/run', '/read', '/write', '/ls', '/cd', '/new', '/history', '/save', '/clear', '/theme',
  '/logo', '/status', '/exit', '/quit',
];

const DESTRUCTIVE = /\b(rm\s+-rf|rm\s+-r|del\s+\/[fqs]|format\s+[a-z]:|mkfs|dd\s+if=|shutdown|reboot|drop\s+database|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f)\b/i;

/* ------------------------------------------------------------------ args */

export function parseArgs(argv) {
  const opts = {
    help: false, version: false, check: false, showLogo: false, agents: false, scanJson: false,
    prompts: false, agent: null, prompt: null, json: false, color: true, project: null,
    noBanner: false, timeout: null,
  };
  const rest = [];
  const takesValue = new Set(['agent', 'prompt', 'project', 'timeout']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-v' || arg === '--version') opts.version = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--logo') opts.showLogo = true;
    else if (arg === '--agents') opts.agents = true;
    else if (arg === '--scan-json') opts.scanJson = true;
    else if (arg === '--prompts') opts.prompts = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '--no-banner') opts.noBanner = true;
    else if (takesValue.has(arg.replace(/^--/, ''))) {
      const key = arg.replace(/^--/, '');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      opts[key] = key === 'timeout' ? Number(value) : value;
      i += 1;
    } else if (arg.startsWith('-p=')) opts.prompt = arg.slice(3);
    else if (arg === '-p') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('-p needs a prompt');
      opts.prompt = value;
      i += 1;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (opts.prompt === null && rest.length) opts.prompt = rest.join(' ');
  return opts;
}

export function helpText() {
  const rows = [
    ['freecode', 'interactive session (REPL)'],
    ['freecode "question"', 'one-shot answer, then exit'],
    ['freecode -p "question"', 'same as above'],
    ['freecode --agent kai', 'start with KAI (jim | kai | alex)'],
    ['freecode --check', 'test every gateway endpoint and show status'],
    ['freecode --agents', 'list agents and their prompts'],
    ['freecode --prompts', 'show the editable system prompts'],
    ['freecode --scan-json', 'passive WiFi list as JSON (no testing)'],
    ['freecode --logo', 'print the ASCII logo and asset paths'],
    ['freecode --project DIR', 'use another project root'],
    ['freecode --no-color', 'plain text output'],
    ['freecode --version', 'print version'],
  ];
  const cmds = [
    ['/agent jim|kai|alex', 'switch agent (prompt reloads instantly)'],
    ['/agents', 'list agents with descriptions'],
    ['/scan', 'KAI own-device workflow: list → pick → verify → test'],
    ['/providers', 'show the provider chain and which keys are set'],
    ['/check', 'probe endpoints for reachability'],
    ['/prompts', 'show all editable system prompts'],
    ['/prompt <agent>', 'show one prompt'],
    ['/preset <agent> <text>', 'write a prompt to .freecode/system-prompts.json'],
    ['/reload', 'force-reload prompts from disk'],
    ['/config', 'show local configuration'],
    ['/set key=value', 'update config (agent, model, provider, temperature...)'],
    ['/run <command>', 'run a shell command and feed output to the agent'],
    ['/read <file>', 'show a file and add it to the agent context'],
    ['/write <file>', 'write a file (paste, end with a single ".")'],
    ['/ls [dir]', 'list project files'],
    ['/cd [dir]', 'change the working directory for /run'],
    ['/new', 'start a fresh conversation'],
    ['/history', 'show this session transcript'],
    ['/save [file]', 'export the transcript as Markdown'],
    ['/clear', 'clear the screen'],
    ['/logo', 'show the logo assets'],
    ['/status', 'root, state dir, config, prompts, provider'],
    ['/exit or /quit', 'leave FreeCode'],
  ];
  const fmt = (pairs) => pairs.map(([a, b]) => `  ${fg('primary', padEnd(a, 26))} ${fg('muted', b)}`).join('\n');
  return [
    '',
    renderHeader(),
    '',
    fg('muted', '  Sharp green terminal AI coding agent. Keyless free forever.'),
    '',
    header('Usage'),
    fmt(rows),
    '',
    header('In-session commands'),
    fmt(cmds),
    '',
    header('Shortcuts'),
    `  ${fg('primary', padEnd('Ctrl+C', 26))} ${fg('muted', 'cancel streaming / press twice to exit')}`,
    `  ${fg('primary', padEnd('Ctrl+D', 26))} ${fg('muted', 'exit')}`,
    `  ${fg('primary', padEnd('Tab', 26))} ${fg('muted', 'complete commands and agent names')}`,
    '',
    fg('muted', `  state dir: ${path.join('<project>', '.freecode')}  •  prompts: system-prompts.json`),
    '',
  ].join('\n');
}

/* ----------------------------------------------------------------- utils */

function agentTag(agentId) {
  const agent = getAgent(agentId) || AGENTS[0];
  return fg(agent.colour === 'warn' ? 'warn' : 'primary', agent.name);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function makeSessionId() {
  return `session-${timestamp()}`;
}

/* ------------------------------------------------------------------ CLI */

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    setColorEnabled(false);
    console.error(error(err.message));
    console.error(fg('muted', '  try: freecode --help'));
    return 2;
  }

  if (!opts.color) setColorEnabled(false);
  else if (!process.stdout.isTTY) setColorEnabled(false);

  const root = path.resolve(opts.project || findProjectRoot());
  process.chdir(root);

  if (opts.help) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`freecode ${VERSION}\n`);
    return 0;
  }
  if (opts.showLogo) {
    process.stdout.write(`\n${renderLogo()}\n\n`);
    for (const file of ['freecode-icon.svg', 'freecode-full.svg', 'freecode-icon.png', 'freecode-full.png']) {
      const full = path.join(LOGO_DIR, file);
      process.stdout.write(`  ${fg('primary', fs.existsSync(full) ? '✔' : '·')} ${full}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }
  if (opts.scanJson) {
    const summary = await passiveSummary();
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary.networks.length ? 0 : 1;
  }

  const config = loadConfig(root);
  const promptsState = loadSystemPrompts(findPromptsFile(root));
  const agentId = getAgent(opts.agent)?.id || config.agent || 'alex';

  if (opts.agents) {
    process.stdout.write(`\n${renderHeader()}\n\n`);
    for (const agent of AGENTS) {
      process.stdout.write(
        box(
          [bold(fg('primary', agent.title)), fg('muted', agent.description), '', renderMarkdown(promptsState.prompts[agent.promptKey])].join('\n'),
          { title: agent.name },
        ) + '\n\n',
      );
    }
    return 0;
  }
  if (opts.prompts) {
    process.stdout.write(`\n${renderHeader()}\n`);
    process.stdout.write(fg('muted', `  file: ${promptsState.file || promptsPath(root)}\n\n`));
    for (const agent of AGENTS) {
      process.stdout.write(box(renderMarkdown(promptsState.prompts[agent.promptKey]), { title: `${agent.name} (${agent.promptKey})` }) + '\n\n');
    }
    process.stdout.write(box(renderMarkdown(promptsState.prompts.global), { title: 'GLOBAL (applies to every agent)' }) + '\n\n');
    return 0;
  }
  if (opts.check) {
    return await runCheck(config, root);
  }

  ensureState(root);

  if (opts.prompt) {
    // One-shot / piped mode: no REPL, no banner.
    const session = new Session({ root, config, promptsState, agentId, interactive: false, timeout: opts.timeout });
    const code = await session.oneShot(opts.prompt);
    session.dispose();
    return code;
  }

  if (!process.stdin.isTTY) {
    // Piped input, no prompt: read stdin as the question.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) {
      process.stdout.write(helpText() + '\n');
      return 0;
    }
    const session = new Session({ root, config, promptsState, agentId, interactive: false });
    const code = await session.oneShot(text);
    session.dispose();
    return code;
  }

  const session = new Session({ root, config, promptsState, agentId, interactive: true });
  return await session.repl({ showBanner: !opts.noBanner });
}

async function runCheck(config, root) {
  process.stdout.write(`\n${renderHeader()}\n\n`);
  const chain = buildProviderChain(config);
  const spin = spinner('probing providers');
  const results = await probeProviders({ config, chain });
  spin.stop();
  process.stdout.write(fg('muted', `  keys: ${JSON.stringify({ openai: Boolean(config.keys.OPENAI_API_KEY), openrouter: Boolean(config.keys.OPENROUTER_API_KEY) })}\n\n`));
  for (const r of results) {
    const mark = r.ok ? fg('primary', '✔') : fg('error', '✖');
    process.stdout.write(
      `  ${mark} ${padEnd(r.provider, 14)} ${padEnd(r.model || '', 42)} ${fg('muted', `${String(r.status).padEnd(4)} ${r.ms}ms  ${r.note}`)}\n`,
    );
  }
  const usable = results.filter((r) => r.ok);
  process.stdout.write('\n');
  if (usable.length) {
    process.stdout.write(ok(`${usable.length} endpoint(s) reachable - ${FREE_GATEWAY_NOTICE}\n`));
  } else {
    process.stdout.write(warn('No endpoint reachable from this machine.\n'));
    process.stdout.write(fg('muted', '  Offline? Use a local model:  ollama serve && ollama pull llama3.2\n'));
  }
  process.stdout.write(fg('muted', `  config: ${configPath(root)}\n\n`));
  return usable.length ? 0 : 1;
}

/* -------------------------------------------------------------- session */

export class Session {
  constructor({ root, config, promptsState, agentId, interactive = true, timeout = null }) {
    this.root = root;
    this.config = config;
    this.promptsState = promptsState;
    this.agentId = agentId;
    this.interactive = interactive;
    this.timeout = timeout;
    this.messages = [];
    this.transcript = [];
    this.context = [];
    this.workdir = root;
    this.sessionId = makeSessionId();
    this.ac = null;
    this.busy = false;
    this.pendingAsk = null;
    this.deferred = [];
    this.watcher = null;
    this.rl = null;
    this.exitRequested = false;
    this.sigintArmed = false;
  }

  /* -------------------------------------------------- prompt hot reload */

  startPromptWatcher() {
    const file = this.promptsState.file || findPromptsFile(this.root) || promptsPath(this.root);
    if (!fs.existsSync(path.dirname(file))) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) saveSystemPrompts(DEFAULT_PROMPTS, file);
      } catch {
        /* read-only? keep defaults */
      }
    }
    this.watcher = watchSystemPrompts(file, (loaded) => {
      this.promptsState = loaded;
      if (loaded.error) {
        this.say(warn(`system-prompts.json is invalid: ${loaded.error} (still using last good prompts)`));
        return;
      }
      this.say(ok('system prompts reloaded from disk - agents updated, no restart needed'));
    });
  }

  systemMessage() {
    const context = this.context.splice(0);
    const extra = [
      `Working directory: ${this.workdir}`,
      `Platform: ${process.platform}`,
      context.length ? `Fresh local tool output for this turn (real, not invented):\n${context.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return { role: 'system', content: buildSystemPrompt(this.agentId, this.promptsState.prompts, { extra }) };
  }

  wireMessages() {
    const history = this.messages.slice(-24);
    return [this.systemMessage(), ...history.map(({ role, content }) => ({ role, content }))];
  }

  say(text = '') {
    process.stdout.write(text + '\n');
    this.transcript.push({ role: 'system', text });
  }

  /* ---------------------------------------------------------- streaming */

  async send(userText) {
    const agent = getAgent(this.agentId);
    this.messages.push({ role: 'user', content: userText });

    // KAI safety path: local discovery runs before any model call.
    if (agent?.id === 'kai' && /^(scan|run\s+scan|scan\s+(all\s+)?networks?|scan\s+all\s+network\s+around|scan\s+wifi)\b/i.test(userText.trim())) {
      const result = await this.runScanWorkflow();
      if (result) return result;
    }

    const chain = buildProviderChain(this.config);
    if (!chain.length) {
      this.say(error('No provider configured. Run /check, or add an API key in ' + configPath(this.root)));
      return 1;
    }

    const spin = spinner('thinking');
    this.ac = new AbortController();
    let started = false;
    let streamed = '';
    process.stdout.write(`\n${agentTag(this.agentId)} ${fg('muted', '›')} `);
    try {
      const result = await streamCompletion({
        messages: this.wireMessages(),
        config: this.config,
        chain,
        signal: this.ac.signal,
        timeoutMs: this.timeout || undefined,
        onProvider: (entry) => spin.update(`connecting ${entry.label}`),
        onToken: (token) => {
          if (!started) {
            spin.stop();
            started = true;
          }
          streamed += token;
          process.stdout.write(token);
        },
      });
      if (!started) spin.stop();
      process.stdout.write('\n');
      const badge = result.keyless ? 'keyless' : 'your key';
      this.say(fg('muted', `  ⚡ ${result.provider} · ${result.model} · ${badge}`));
      this.messages.push({ role: 'assistant', content: result.text });
      this.transcript.push({ role: 'assistant', text: result.text, provider: result.provider, model: result.model });
      if (result.attempts?.length) {
        this.say(fg('muted', `  (fell back after: ${result.attempts.map((a) => `${a.provider}${a.status ? ` ${a.status}` : ''}`).join(', ')})`));
      }
      this.persist();
      return 0;
    } catch (err) {
      spin.stop();
      if (!started) process.stdout.write('\n');
      if (err.name === 'AbortError' || this.ac?.signal.aborted) {
        process.stdout.write('\n');
        this.say(warn('cancelled'));
        if (streamed.trim()) this.messages.push({ role: 'assistant', content: streamed });
        return 130;
      }
      if (err instanceof GatewayError) {
        this.say(error('No provider could answer this turn.'));
        this.say(fg('muted', err.message.replace(/^/gm, '  ')));
      } else {
        this.say(error(err.message));
      }
      // Do not keep a dangling user turn with no answer.
      this.messages.pop();
      return 1;
    } finally {
      this.ac = null;
    }
  }

  async runScanWorkflow() {
    process.stdout.write('\n');
    try {
      const result = await runKaiWorkflow({
        ask: (q) => this.askUser(q),
        say: (line) => this.say(line),
        onStatus: (text) => process.stdout.write(dim(`  ${text}…`) + '\n'),
        root: this.root,
      });
      if (result.authorised && result.gateway) {
        this.context.push(
          [
            `KAI authorised scan of the user's own device "${result.picked.ssid}"`,
            `gateway ${result.gateway}`,
            `open ports: ${result.openPorts?.length ? result.openPorts.map((p) => `${p.port}/${p.service}(${p.risk})`).join(', ') : 'none of the common ones'}`,
            result.findings?.passphrase ? `own passphrase strength: ${result.findings.passphrase.verdict} (~${result.findings.passphrase.bits} bits)` : '',
            `audit log: ${auditLogPath(this.root)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        this.say('');
        this.say(fg('muted', '  Real scan results are now in context - ask KAI to explain or fix anything.'));
      }
      this.transcript.push({ role: 'scan', text: JSON.stringify({ authorised: result.authorised, reason: result.reason, ssid: result.picked?.ssid || null }) });
      return 0;
    } catch (err) {
      this.say(error(`scan workflow failed: ${err.message}`));
      return 1;
    }
  }

  /* -------------------------------------------------------------- REPL */

  promptText() {
    const agent = getAgent(this.agentId);
    return `${fg('primary', 'freecode')} ${fg('muted', `[${agent.name}]`)} ${fg('primary', '❯')} `;
  }

  askUser(question) {
    return new Promise((resolve) => {
      process.stdout.write(`\n${fg('warn', '?')} ${bold(question)}\n${fg('primary', '  ❯ ')}`);
      this.pendingAsk = (answer) => resolve(answer === '\u0003' ? '' : answer);
    });
  }

  repl({ showBanner = true } = {}) {
    ensureState(this.root);
    this.startPromptWatcher();

    if (showBanner) {
      process.stdout.write(
        renderBanner({ version: VERSION, provider: this.providerLabel(), agent: getAgent(this.agentId)?.name }) + '\n',
      );
      process.stdout.write(
        fg('muted', `  ${FREE_GATEWAY_NOTICE}\n  root ${this.root}\n\n`),
      );
    }

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 300,
      terminal: true,
      completer: (line) => {
        if (line.startsWith('/')) {
          const hits = CMD_NAMES.filter((c) => c.startsWith(line));
          return [hits.length ? hits : CMD_NAMES, line];
        }
        return [[], line];
      },
    });

    this.rl.setPrompt(this.promptText());
    this.rl.prompt();

    return new Promise((resolve) => {
      this.rl.on('line', async (raw) => {
        const line = raw.trim();

        if (this.pendingAsk) {
          const resolver = this.pendingAsk;
          this.pendingAsk = null;
          resolver(line);
          return;
        }

        if (this.busy) {
          if (line) this.deferred.push(line);
          return;
        }
        if (!line) {
          this.rl.prompt();
          return;
        }

        this.busy = true;
        await this.handleLine(line);
        this.busy = false;

        if (this.exitRequested) {
          this.dispose();
          resolve(0);
          return;
        }
        while (this.deferred.length && !this.exitRequested) {
          const queued = this.deferred.shift();
          await this.handleLine(queued);
        }
        if (this.exitRequested) {
          this.dispose();
          resolve(0);
          return;
        }
        if (!this.pendingAsk) {
          process.stdout.write('\n');
          this.rl.setPrompt(this.promptText());
          this.rl.prompt();
        }
      });

      this.rl.on('close', () => {
        this.dispose();
        resolve(0);
      });

      this.rl.on('SIGINT', () => {
        if (this.pendingAsk) {
          const resolver = this.pendingAsk;
          this.pendingAsk = null;
          resolver('n');
          return;
        }
        if (this.ac) {
          this.ac.abort();
          return;
        }
        if (this.busy) return;
        if (!this.sigintArmed) {
          this.sigintArmed = true;
          process.stdout.write(`\n${fg('muted', '  press Ctrl+C again (or /exit) to leave')}\n`);
          this.rl.prompt();
          setTimeout(() => {
            this.sigintArmed = false;
          }, 2000);
          return;
        }
        this.exitRequested = true;
        this.rl.close();
      });
    });
  }

  async handleLine(line) {
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = line.slice(cmd.length).trim();
      await this.handleCommand(cmd.toLowerCase(), arg, rest);
      return;
    }
    await this.send(line);
  }

  /* ---------------------------------------------------------- commands */

  async handleCommand(cmd, arg, parts) {
    const out = (text) => this.say(text);
    switch (cmd) {
      case '/help':
        out(helpText());
        break;
      case '/agents':
        out('');
        for (const agent of AGENTS) {
          out(`${agentTag(agent.id)} ${fg('muted', agent.title)} ${agent.id === this.agentId ? fg('primary', '← active') : ''}`);
          out(fg('muted', `  ${agent.description}`));
        }
        out('');
        break;
      case '/agent': {
        const agent = getAgent(arg);
        if (!agent) {
          out(warn(`Unknown agent "${arg || ''}". Use: ${AGENTS.map((a) => a.id).join(', ')}`));
          break;
        }
        this.agentId = agent.id;
        this.config.agent = agent.id;
        try {
          saveConfig(this.config, this.root);
        } catch {
          /* read-only config is fine */
        }
        out(ok(`agent switched to ${agent.name} - ${agent.title}`));
        break;
      }
      case '/scan': {
        await this.runScanWorkflow();
        break;
      }
      case '/providers': {
        const chain = buildProviderChain(this.config);
        out('');
        out(header('Provider chain (first working one answers)'));
        chain.forEach((entry, i) => {
          out(`  ${fg('primary', String(i + 1))}. ${padEnd(entry.label, 30)} ${fg('muted', entry.model)}`);
        });
        out('');
        out(fg('muted', `  keyless: ${chain.some((c) => c.keyless) ? 'yes' : 'no'}  |  config: ${configPath(this.root)}`));
        out(fg('muted', `  ${FREE_GATEWAY_NOTICE}`));
        out('');
        break;
      }
      case '/check': {
        await runCheck(this.config, this.root);
        break;
      }
      case '/prompts': {
        out('');
        out(fg('muted', `  file: ${this.promptsState.file || promptsPath(this.root)}`));
        for (const key of ['global', ...AGENTS.map((a) => a.promptKey)]) {
          const label = key === 'global' ? 'GLOBAL' : key.toUpperCase();
          out(box(renderMarkdown(this.promptsState.prompts[key] || ''), { title: label }));
        }
        out(fg('muted', '  edit with /preset <agent> <text>, or open the file and it reloads live.'));
        break;
      }
      case '/prompt': {
        const key = arg === 'global' ? 'global' : getAgent(arg)?.promptKey;
        if (!key) {
          out(warn('usage: /prompt global|jim|kai|alex'));
          break;
        }
        out('');
        out(box(renderMarkdown(this.promptsState.prompts[key] || ''), { title: key.toUpperCase() }));
        break;
      }
      case '/preset': {
        const [who, ...words] = arg.split(/\s+/);
        const key = who === 'global' ? 'global' : getAgent(who)?.promptKey;
        const text = words.join(' ').trim();
        if (!key || !text) {
          out(warn('usage: /preset <global|jim|kai|alex> <new prompt text>'));
          break;
        }
        const next = { ...this.promptsState.prompts, [key]: text };
        const file = this.promptsState.file || promptsPath(this.root);
        saveSystemPrompts(next, file);
        this.promptsState = loadSystemPrompts(file);
        out(ok(`saved ${key} prompt to ${file} - agents reloaded`));
        break;
      }
      case '/reload': {
        this.promptsState = loadSystemPrompts(this.promptsState.file || findPromptsFile(this.root));
        if (this.promptsState.error) out(error(`invalid JSON: ${this.promptsState.error}`));
        else out(ok(`prompts reloaded (${this.promptsState.file || 'defaults'})`));
        break;
      }
      case '/config': {
        out('');
        out(header('Configuration'));
        out(keyValue([
          ['root', this.root],
          ['state dir', stateDir(this.root)],
          ['config', configPath(this.root)],
          ['prompts', this.promptsState.file || promptsPath(this.root)],
          ['audit log', auditLogPath(this.root)],
          ['agent', this.agentId],
          ['provider', this.config.provider || 'auto (free gateway)'],
          ['model', this.config.model || 'provider default'],
          ['temperature', String(this.config.temperature)],
          ['max tokens', String(this.config.maxTokens)],
          ['openai key', this.config.keys.OPENAI_API_KEY ? 'set' : 'not set'],
          ['openrouter key', this.config.keys.OPENROUTER_API_KEY ? 'set' : 'not set'],
        ]));
        out('');
        break;
      }
      case '/set': {
        const [pair] = arg.split(/\s+/);
        const [key, ...valueParts] = (pair || '').split('=');
        const value = valueParts.join('=');
        if (!key || value === undefined) {
          out(warn('usage: /set agent=alex | /set model=gpt-4o-mini | /set provider=pollinations | /set temperature=0.4'));
          break;
        }
        if (key === 'agent') {
          const agent = getAgent(value);
          if (!agent) {
            out(warn('unknown agent'));
            break;
          }
          this.agentId = agent.id;
          this.config.agent = agent.id;
        } else if (['temperature', 'maxTokens'].includes(key)) {
          const num = Number(value);
          if (Number.isNaN(num)) {
            out(warn(`${key} must be a number`));
            break;
          }
          this.config[key] = num;
        } else if (['model', 'provider'].includes(key)) {
          this.config[key] = value === 'auto' ? null : value;
        } else if (key.startsWith('keys.')) {
          this.config.keys[key.slice(5)] = value;
        } else {
          out(warn(`unknown setting "${key}"`));
          break;
        }
        const file = saveConfig(this.config, this.root);
        out(ok(`saved ${key} → ${file}`));
        break;
      }
      case '/run': {
        if (!arg) {
          out(warn('usage: /run <command>'));
          break;
        }
        if (DESTRUCTIVE.test(arg)) {
          const answer = await this.askUser(`This command looks destructive:\n  ${arg}\nRun it anyway? (y/N)`);
          if (!/^y(es)?$/i.test(answer.trim())) {
            out(warn('not run'));
            break;
          }
        }
        out(fg('muted', `  $ ${arg}`));
        const result = await runCommand(arg, { cwd: this.workdir });
        out('');
        out(
          `${result.code === 0 ? ok('exit 0') : error(`exit ${result.code}`)}${result.timedOut ? fg('warn', ' (timed out)') : ''}`,
        );
        if (result.stdout || result.stderr) {
          this.context.push(
            `Command the user ran${result.code === 0 ? '' : ` (exit ${result.code})`}: ${arg}\nOutput:\n\`\`\`\n${(result.stdout + '\n' + result.stderr).slice(-4000)}\n\`\`\``,
          );
          out(fg('muted', '  output added to context - ask a follow-up to analyse it'));
        }
        break;
      }
      case '/read': {
        if (!arg) {
          out(warn('usage: /read <file>'));
          break;
        }
        try {
          const file = readTextFile(arg, { root: this.root });
          const lines = file.content.split('\n');
          out('');
          lines.slice(0, 400).forEach((text, i) => out(`${fg('muted', String(i + 1).padStart(4))} ${text}`));
          if (lines.length > 400) out(fg('muted', `  … ${lines.length - 400} more lines`));
          if (file.truncated) out(warn(`  truncated at 400 KB (file is ${(file.bytes / 1024).toFixed(1)} KB)`));
          this.context.push(`File the user asked you to read: ${arg}\n\`\`\`\n${file.content.slice(0, 12000)}\n\`\`\``);
          out(fg('muted', '  added to context'));
        } catch (err) {
          out(error(err instanceof ToolError ? err.message : String(err)));
        }
        break;
      }
      case '/write': {
        if (!arg) {
          out(warn('usage: /write <file>   then paste content, end with a line containing only "."'));
          break;
        }
        out(fg('muted', '  paste content now, end with a single "." on its own line'));
        const lines = [];
        for (;;) {
          const next = await this.askUser('');
          if (next.trim() === '.') break;
          lines.push(next);
          if (lines.length > 2000) {
            out(warn('too many lines, stopping at 2000'));
            break;
          }
        }
        const content = lines.join('\n') + (lines.length ? '\n' : '');
        try {
          const result = writeTextFile(arg, content, { root: this.root });
          const stat = diffStat(result.before || '', content);
          out(
            ok(`${result.created ? 'created' : 'updated'} ${arg} (${content.length} bytes, +${stat.added} -${stat.removed})`) +
              (result.created ? '' : fg('muted', '  backup kept as .bak')),
          );
        } catch (err) {
          out(error(err instanceof ToolError ? err.message : String(err)));
        }
        break;
      }
      case '/ls': {
        try {
          const rows = listDir(arg || '.', { root: this.root, depth: arg ? 2 : 1 });
          out('');
          for (const row of rows.slice(0, 250)) {
            const isDir = row.type === 'dir';
            out(`  ${isDir ? fg('primary', '▸') : ' '} ${isDir ? fg('primary', row.rel) : row.rel}${isDir ? '' : fg('muted', `  ${row.size}b`)}`);
          }
          if (rows.length > 250) out(fg('muted', `  … ${rows.length - 250} more`));
          this.context.push(`Directory listing of ${arg || '.'}:\n${rows.slice(0, 250).map((r) => r.rel).join('\n')}`);
          out('');
        } catch (err) {
          out(error(err instanceof ToolError ? err.message : String(err)));
        }
        break;
      }
      case '/cd': {
        if (!arg) {
          out(fg('muted', `  ${this.workdir}`));
          break;
        }
        try {
          const next = resolveInside(arg, this.root);
          if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) {
            out(error(`not a directory: ${arg}`));
            break;
          }
          this.workdir = next;
          out(ok(`workdir → ${next}`));
        } catch (err) {
          out(error(err.message));
        }
        break;
      }
      case '/new': {
        this.messages = [];
        this.context = [];
        this.transcript = [];
        out(ok('fresh conversation - system prompts and agent kept'));
        break;
      }
      case '/history': {
        if (!this.transcript.length) {
          out(fg('muted', '  empty'));
          break;
        }
        out('');
        for (const entry of this.transcript) {
          if (entry.role === 'user') out(`${fg('primary', 'you ›')} ${entry.text}`);
          else if (entry.role === 'assistant') out(`${agentTag(this.agentId)} ${fg('muted', '›')} ${entry.text.slice(0, 400)}${entry.text.length > 400 ? ' …' : ''}`);
          else if (entry.role === 'scan') out(fg('muted', `scan: ${entry.text}`));
        }
        out('');
        break;
      }
      case '/save': {
        const target = resolveInside(arg || path.join('.freecode', `${this.sessionId}.md`), this.root);
        const md = [
          `# FreeCode session ${this.sessionId}`,
          '',
          `- agent: ${getAgent(this.agentId)?.name}`,
          `- date: ${new Date().toISOString()}`,
          `- root: ${this.root}`,
          '',
          ...this.messages.map((m) => `## ${m.role}\n\n${m.content}\n`),
        ].join('\n');
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, md, 'utf8');
          out(ok(`saved ${target}`));
        } catch (err) {
          out(error(err.message));
        }
        break;
      }
      case '/clear':
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(renderHeader() + '\n');
        break;
      case '/theme': {
        out('');
        out(fg('primary', '  primary   #00FF88'));
        out(band('primary', 'background', '  background text on green  '));
        out(fg('muted', '  background #0A0A0A   panel #1A1A1A   border #00FF88'));
        out(fg('muted', '  colour is ' + (colorEnabled() ? 'on' : 'off (piped or --no-color)')));
        out('');
        break;
      }
      case '/logo': {
        out('');
        out(renderLogo());
        out('');
        for (const file of ['freecode-icon.svg', 'freecode-full.svg', 'freecode-icon.png', 'freecode-full.png']) {
          const full = path.join(LOGO_DIR, file);
          out(`  ${fs.existsSync(full) ? fg('primary', '✔') : fg('muted', '·')} ${full}`);
        }
        out('');
        break;
      }
      case '/status': {
        out('');
        out(header('Status'));
        out(keyValue([
          ['version', VERSION],
          ['root', this.root],
          ['workdir', this.workdir],
          ['agent', `${getAgent(this.agentId)?.name} (${this.agentId})`],
          ['provider chain', buildProviderChain(this.config).map((c) => c.id).join(' → ')],
          ['turns', String(this.messages.length)],
          ['prompts file', this.promptsState.file || 'defaults'],
          ['audit log', auditLogPath(this.root)],
          ['ports scanned', COMMON_PORTS.map((p) => p.port).join(', ')],
        ]));
        out('');
        break;
      }
      case '/exit':
      case '/quit': {
        this.say(fg('primary', '  bye - stay green.'));
        this.exitRequested = true;
        try {
          this.rl.close();
        } catch {
          /* already closed */
        }
        break;
      }
      default:
        out(warn(`unknown command ${cmd} - try /help`));
        break;
    }
  }

  providerLabel() {
    const chain = buildProviderChain(this.config);
    const keyless = chain.find((c) => c.keyless);
    return chain[0] ? `${chain[0].id}${keyless && chain[0].keyless ? ' (keyless)' : ''}` : 'no provider';
  }

  /* ------------------------------------------------------------ one-shot */

  async oneShot(text) {
    this.startPromptWatcher();
    const code = await this.send(text);
    this.dispose();
    return code;
  }

  persist() {
    try {
      const dir = path.join(stateDir(this.root), 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${this.sessionId}.json`),
        JSON.stringify({ id: this.sessionId, agent: this.agentId, root: this.root, messages: this.messages }, null, 2),
        'utf8',
      );
    } catch {
      /* persistence is best-effort */
    }
  }

  dispose() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.ac) this.ac.abort();
    if (this.rl && !this.exitRequested) {
      try {
        this.rl.close();
      } catch {
        /* noop */
      }
    }
  }
}
