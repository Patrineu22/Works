import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/cli.mjs';
import { loadSystemPrompts, saveSystemPrompts, buildSystemPrompt, DEFAULT_PROMPTS, AGENTS, getAgent } from '../src/agents.mjs';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/config.mjs';
import { resolveInside, ToolError, diffStat, listDir, readTextFile, writeTextFile } from '../src/tools.mjs';
import { stripAnsi, visibleLength, padEnd, PALETTE } from '../src/theme.mjs';
import { FreeCodeLogo, renderHeader } from '../src/logo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'freecode.mjs');

test('parseArgs handles flags, values and free text', () => {
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['--agent', 'kai']).agent, 'kai');
  assert.equal(parseArgs(['explain', 'this']).prompt, 'explain this');
  assert.equal(parseArgs(['-p', 'hi']).prompt, 'hi');
  assert.equal(parseArgs(['--no-color', '--check']).color, false);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['--agent']), /needs a value/);
});

test('theme exposes the exact brand colours', () => {
  assert.equal(PALETTE.primary, '#00FF88');
  assert.equal(PALETTE.background, '#0A0A0A');
  assert.equal(PALETTE.panel, '#1A1A1A');
  assert.equal(PALETTE.border, '#00FF88');
});

test('logo is the exact ASCII block with the tagline', () => {
  const lines = FreeCodeLogo.split('\n');
  assert.equal(lines.length, 7);
  assert.match(lines[6], />_ freecode v1\.0\.0 - FreeCode Green/);
  assert.equal(stripAnsi(renderHeader()).trim(), 'FREECODE - AI CODING AGENT - GREEN');
});

test('ansi helpers measure and pad visibly', () => {
  const coloured = '\x1b[38;2;0;255;136mabc\x1b[0m';
  assert.equal(visibleLength(coloured), 3);
  assert.equal(padEnd(coloured, 5), coloured + '  ');
});

test('agent registry has JIM, KAI, ALEX', () => {
  assert.deepEqual(AGENTS.map((a) => a.id).sort(), ['alex', 'jim', 'kai']);
  assert.equal(getAgent('KAI').name, 'KAI');
  assert.equal(getAgent('nope'), null);
  assert.match(DEFAULT_PROMPTS.kai, /VERIFY OWNERSHIP|own devices/i);
});

test('system prompts load, merge defaults, and survive bad json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-prompts-'));
  const file = path.join(dir, 'system-prompts.json');

  const missing = loadSystemPrompts(path.join(dir, 'nope.json'));
  assert.equal(missing.prompts.global, DEFAULT_PROMPTS.global);
  assert.equal(missing.file, null);

  saveSystemPrompts({ global: 'G', jim: 'J', kai: 'K', alex: 'A', custom: 'C' }, file);
  const loaded = loadSystemPrompts(file);
  assert.equal(loaded.prompts.alex, 'A');
  assert.equal(loaded.prompts.custom, 'C');
  assert.equal(loaded.error, null);

  fs.writeFileSync(file, '{ broken');
  const broken = loadSystemPrompts(file);
  assert.match(broken.error, /JSON|Unexpected|property/);
  assert.equal(broken.prompts.global, DEFAULT_PROMPTS.global, 'falls back to defaults');

  fs.writeFileSync(file, JSON.stringify({ global: 'only global' }));
  const partial = loadSystemPrompts(file);
  assert.deepEqual(partial.missing.sort(), ['alex', 'jim', 'kai']);
});

test('buildSystemPrompt composes global + agent + safety rules', () => {
  const prompt = buildSystemPrompt('kai', DEFAULT_PROMPTS, { extra: 'Working directory: /tmp' });
  assert.match(prompt, /^You are FreeCode/);
  assert.match(prompt, /red-team lab assistant/);
  assert.match(prompt, /Active agent: KAI/);
  assert.match(prompt, /Working directory: \/tmp/);
  assert.match(prompt, /defensive, legal work/);
});

test('the shipped .freecode/system-prompts.json is valid and has all four keys', () => {
  const file = path.join(ROOT, '.freecode', 'system-prompts.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['global', 'jim', 'kai', 'alex']) {
    assert.equal(typeof parsed[key], 'string');
    assert.ok(parsed[key].length > 10, `${key} prompt too short`);
  }
  assert.match(parsed.kai, /scan networks/i);
  assert.match(parsed.kai, /VERIFY OWNERSHIP/);
});

test('config defaults keep the keyless gateway enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-config-'));
  const config = loadConfig(dir);
  assert.equal(config.providers.pollinations.enabled, true);
  assert.equal(config.providers.pollinations.baseUrl, 'https://text.pollinations.ai/openai');
  assert.deepEqual(config.providers.openrouter.models, DEFAULT_CONFIG.providers.openrouter.models);

  config.agent = 'jim';
  saveConfig(config, dir);
  assert.equal(loadConfig(dir).agent, 'jim');
});

test('tools refuse to escape the project root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-tools-'));
  assert.throws(() => resolveInside('../etc/passwd', root), ToolError);
  assert.throws(() => resolveInside('/etc/passwd', root), ToolError);
  assert.equal(resolveInside('src/a.js', root), path.join(root, 'src', 'a.js'));

  writeTextFile('src/a.js', 'line1\n', { root });
  const read = readTextFile('src/a.js', { root });
  assert.equal(read.content, 'line1\n');
  assert.equal(read.truncated, false);

  writeTextFile('src/a.js', 'line2\n', { root });
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js.bak'), 'utf8'), 'line1\n');

  assert.deepEqual(diffStat('a\nb', 'a\nc'), { added: 1, removed: 1, changed: true });
  assert.equal(diffStat('a', 'a').changed, false);

  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  assert.throws(() => readTextFile('bin.dat', { root }), /binary/);

  const rows = listDir('.', { root, depth: 2 });
  assert.ok(rows.some((r) => r.rel === 'src/'));
  assert.ok(rows.some((r) => r.rel === 'src/a.js'));
});

/* ---------------------------------------------------- end-to-end CLI smoke */

function run(args, input = undefined) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input,
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60000,
  });
}

test('CLI --version and --help', () => {
  assert.match(run(['--version']), /^freecode 1\.0\.0/m);
  const help = run(['--help']);
  assert.match(help, /FREECODE - AI CODING AGENT - GREEN/);
  assert.match(help, /\/scan/);
  assert.match(help, /--check/);
});

test('CLI --agents and --prompts list all three agents', () => {
  const agents = run(['--agents']);
  for (const name of ['JIM', 'KAI', 'ALEX']) assert.match(agents, new RegExp(name));
  const prompts = run(['--prompts']);
  assert.match(prompts, /GLOBAL/);
  assert.match(prompts, /own devices|own-device/i);
});

test('CLI --logo prints the ASCII logo and asset paths', () => {
  const out = run(['--logo']);
  assert.match(out, /███████╗/);
  assert.match(out, /freecode-icon\.svg/);
});

test('one-shot mode fails gracefully with no network instead of hanging', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-offline-'));
  const scripts = path.join(dir, '.freecode');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(
    path.join(scripts, 'config.json'),
    JSON.stringify({
      provider: 'openai',
      keys: { OPENAI_API_KEY: 'sk-invalid' },
      providers: {
        openai: { baseUrl: 'http://127.0.0.1:1/v1', model: 'x' },
        pollinations: { enabled: false },
        openrouter: { enabled: false },
        ollama: { enabled: false },
      },
    }),
  );
  let result;
  try {
    result = execFileSync(process.execPath, [BIN, '--project', dir, 'hello'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 60000,
    });
  } catch (err) {
    result = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.match(result, /All providers failed|No provider/);
});
