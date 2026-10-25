/**
 * FreeCode configuration + state directory.
 *
 * State lives in `<project>/.freecode/` (created on first run):
 *   config.json          local settings + optional API keys (gitignored)
 *   system-prompts.json  editable agent prompts (global, jim, kai, alex)
 *   audit-log.jsonl      KAI own-device authorisations and scans
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

export const STATE_DIRNAME = '.freecode';

export const DEFAULT_CONFIG = {
  agent: 'alex',
  // null = use the keyless free gateway chain
  provider: null,
  model: null,
  maxTokens: 2048,
  temperature: 0.7,
  providers: {
    pollinations: { enabled: true, baseUrl: 'https://text.pollinations.ai/openai', model: 'openai' },
    openrouter: {
      enabled: true,
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-r1:free',
      models: [
        'deepseek/deepseek-r1:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'qwen/qwen-2.5-coder-32b-instruct:free',
      ],
    },
    ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
    openai: { enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  },
  keys: {
    // Prefer environment variables; these are only a convenience for desktop users.
    OPENROUTER_API_KEY: '',
    OPENAI_API_KEY: '',
  },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Project root: nearest ancestor containing .git or .freecode, else cwd. */
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, STATE_DIRNAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

export function stateDir(root = findProjectRoot()) {
  return path.join(root, STATE_DIRNAME);
}

export function configPath(root = findProjectRoot()) {
  return path.join(stateDir(root), 'config.json');
}

export function promptsPath(root = findProjectRoot()) {
  return path.join(stateDir(root), 'system-prompts.json');
}

export function auditLogPath(root = findProjectRoot()) {
  return path.join(stateDir(root), 'audit-log.jsonl');
}

/** Create the state directory and default files if missing. */
export function ensureState(root = findProjectRoot()) {
  const dir = stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = configPath(root);
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({ ...DEFAULT_CONFIG, keys: {} }, null, 2) + '\n', 'utf8');
  }
  return dir;
}

export function loadConfig(root = findProjectRoot()) {
  const file = configPath(root);
  let parsed = {};
  if (fs.existsSync(file)) {
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot parse ${file}: ${err.message}`);
    }
  }
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  // Environment variables always win over the file, and file wins over nothing.
  const envKeys = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  };
  merged.keys = { ...merged.keys, ...Object.fromEntries(Object.entries(envKeys).filter(([, v]) => v)) };
  return merged;
}

export function saveConfig(config, root = findProjectRoot()) {
  const file = configPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return file;
}

export function hasAnyUserKey(config = loadConfig()) {
  const keys = config.keys || {};
  return Boolean(
    keys.OPENROUTER_API_KEY ||
      keys.OPENAI_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.FREECODE_API_KEY,
  );
}

export function homeDir() {
  return os.homedir();
}

export function expandHome(input) {
  if (!input) return input;
  if (input === '~') return homeDir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homeDir(), input.slice(2));
  return input;
}
