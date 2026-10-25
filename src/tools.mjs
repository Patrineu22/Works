/**
 * Local tools the CLI exposes to the user: list, read, write, run.
 * Every path is confined to the project root, writes keep a .bak copy, and
 * commands are run with an explicit timeout. Nothing here talks to a model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findProjectRoot } from './config.mjs';

export const MAX_READ_BYTES = 400_000;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.freecode', 'dist', 'build', 'target', '.next', '.cache']);

export class ToolError extends Error {}

/** Resolve a user path and refuse anything outside the project root. */
export function resolveInside(target, root = findProjectRoot()) {
  const resolved = path.resolve(root, target || '.');
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(`Path escapes the project root: ${target}`);
  }
  return resolved;
}

export function listDir(target = '.', { root = findProjectRoot(), depth = 1 } = {}) {
  const dir = resolveInside(target, root);
  if (!fs.existsSync(dir)) throw new ToolError(`No such directory: ${target}`);
  const rows = [];
  const walk = (current, level) => {
    if (level > depth) return;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = path.relative(root, path.join(current, entry.name)) || '.';
      if (entry.isDirectory()) {
        rows.push({ rel: `${rel}/`, type: 'dir' });
        walk(path.join(current, entry.name), level + 1);
      } else {
        let size = 0;
        try {
          size = fs.statSync(path.join(current, entry.name)).size;
        } catch {
          /* race with deletion, ignore */
        }
        rows.push({ rel, type: 'file', size });
      }
    }
  };
  walk(dir, 1);
  return rows;
}

export function readTextFile(target, { root = findProjectRoot(), maxBytes = MAX_READ_BYTES } = {}) {
  const file = resolveInside(target, root);
  if (!fs.existsSync(file)) throw new ToolError(`No such file: ${target}`);
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new ToolError(`${target} is a directory (use /ls)`);
  const buf = fs.readFileSync(file);
  const slice = buf.subarray(0, maxBytes);
  if (slice.includes(0)) throw new ToolError(`${target} looks binary; not reading it.`);
  return { content: slice.toString('utf8'), truncated: buf.length > maxBytes, bytes: stat.size, file };
}

export function writeTextFile(target, content, { root = findProjectRoot(), backup = true } = {}) {
  const file = resolveInside(target, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let previous = null;
  if (fs.existsSync(file)) {
    previous = fs.readFileSync(file, 'utf8');
    if (backup) fs.writeFileSync(`${file}.bak`, previous, 'utf8');
  }
  fs.writeFileSync(file, content, 'utf8');
  return { file, created: previous === null, changed: previous !== content, before: previous, after: content };
}

/** Counts for a quick "+n -m" summary. */
export function diffStat(before = '', after = '') {
  if (before === after) return { added: 0, removed: 0, changed: false };
  const oldLines = String(before).split('\n');
  const newLines = String(after).split('\n');
  if (before === '') return { added: newLines.length, removed: 0, changed: true };
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let added = 0;
  let removed = 0;
  for (const line of newLines) if (!oldSet.has(line)) added += 1;
  for (const line of oldLines) if (!newSet.has(line)) removed += 1;
  return { added, removed, changed: true };
}

/** Run a shell command, streaming output, with a timeout and abort support. */
export function runCommand(command, { cwd = findProjectRoot(), timeout = 120_000, signal, shell } = {}) {
  return new Promise((resolve) => {
    const useShell = shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = spawn(useShell, args, { cwd, env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message, timedOut, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
