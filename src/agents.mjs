/**
 * Agent registry (JIM / KAI / ALEX) + hot-reloading system prompts.
 *
 * Prompts live in `.freecode/system-prompts.json` so the user can edit them at
 * any time; the file is watched and agents reload instantly without a restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { promptsPath, stateDir, findProjectRoot } from './config.mjs';

export const DEFAULT_PROMPTS = {
  global: 'You are FreeCode, sharp green AI coding agent',
  jim: 'You are JIM, white-hat mentor, teach simple',
  kai: 'You are KAI, red-team lab assistant for own devices, scan->list->pick->verify',
  alex: 'You are ALEX, coding genius',
};

export const AGENTS = [
  {
    id: 'alex',
    name: 'ALEX',
    title: 'Coding genius',
    promptKey: 'alex',
    colour: 'primary',
    description: 'Builds, debugs and automates. Default everyday agent.',
  },
  {
    id: 'jim',
    name: 'JIM',
    title: 'White-hat mentor',
    promptKey: 'jim',
    colour: 'primaryDim',
    description: 'Defensive security teacher: hardening, CTFs, secure coding, plain language.',
  },
  {
    id: 'kai',
    name: 'KAI',
    title: 'Red-team lab assistant',
    promptKey: 'kai',
    colour: 'warn',
    description: 'Consent-gated testing of devices you own: scan -> list -> pick -> verify -> test.',
  },
];

export function getAgent(id) {
  const key = String(id || '').toLowerCase();
  return AGENTS.find((agent) => agent.id === key || agent.name.toLowerCase() === key) || null;
}

/** Locate an existing prompts file: env override, then .freecode in the project. */
export function findPromptsFile(root = findProjectRoot()) {
  const candidates = [
    process.env.FREECODE_PROMPTS,
    promptsPath(root),
    path.join(stateDir(process.cwd()), 'system-prompts.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Read system prompts. Missing keys fall back to built-in defaults so a partial
 * or hand-edited file never breaks the CLI.
 */
export function loadSystemPrompts(file = findPromptsFile()) {
  if (!file || !fs.existsSync(file)) {
    return { prompts: { ...DEFAULT_PROMPTS }, file: null, error: null, missing: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object with keys global/jim/kai/alex');
    }
    const prompts = { ...DEFAULT_PROMPTS };
    const missing = [];
    for (const key of Object.keys(DEFAULT_PROMPTS)) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) {
        prompts[key] = parsed[key];
      } else {
        missing.push(key);
      }
    }
    // Keep any custom agents the user adds, e.g. "rex": "You are REX ..."
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in DEFAULT_PROMPTS) && typeof value === 'string' && value.trim()) {
        prompts[key] = value;
      }
    }
    return { prompts, file, error: null, missing };
  } catch (err) {
    return { prompts: { ...DEFAULT_PROMPTS }, file, error: err.message, missing: [] };
  }
}

/** Write prompts back to disk (creates the file if needed). */
export function saveSystemPrompts(prompts, file = findPromptsFile() || promptsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = {};
  for (const [key, value] of Object.entries(prompts)) {
    if (typeof value === 'string') clean[key] = value;
  }
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * Watch the prompts file for edits and call onChange(prompts) when it changes.
 * Debounced because editors often fire several events per save.
 */
export function watchSystemPrompts(file, onChange, { debounceMs = 150 } = {}) {
  if (!file) return { close() {} };
  let timer = null;
  let closed = false;
  let watcher;
  const fire = () => {
    if (closed) return;
    const loaded = loadSystemPrompts(file);
    onChange(loaded);
  };
  try {
    watcher = fs.watch(file, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, debounceMs);
    });
  } catch {
    return { close() {} };
  }
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        watcher.close();
      } catch {
        /* already gone */
      }
    },
  };
}

const SHARED_RULES = [
  'You are running inside FreeCode, a terminal coding agent (Node.js CLI, green #00FF88 theme).',
  'Be direct and useful. Answer with short paragraphs, plain language and fenced code blocks.',
  'You cannot run commands yourself: suggest a command and the user runs it with /run <command>.',
  'Never invent file contents or command output you have not been given.',
  'Safety: help only with defensive, legal work on systems the user owns or is authorised to test.',
].join(' ');

/** Compose the system message for a turn: global + agent prompt + shared rules. */
export function buildSystemPrompt(agentId, prompts = DEFAULT_PROMPTS, { extra = '' } = {}) {
  const agent = getAgent(agentId);
  const global = (prompts.global || DEFAULT_PROMPTS.global).trim();
  const specific = agent ? (prompts[agent.promptKey] || DEFAULT_PROMPTS[agent.promptKey]).trim() : '';
  const parts = [global, specific, SHARED_RULES];
  if (agent) parts.push(`Active agent: ${agent.name} (${agent.title}).`);
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join('\n\n');
}
