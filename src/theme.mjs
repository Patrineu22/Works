/**
 * FreeCode theme - sharp green on black.
 * Every colour in the app comes from here so the palette stays consistent.
 *
 *   primary  #00FF88   background #0A0A0A   panel #1A1A1A
 */
import process from 'node:process';

export const PALETTE = {
  primary: '#00FF88',
  primaryDim: '#00b862',
  background: '#0A0A0A',
  panel: '#1A1A1A',
  border: '#00FF88',
  text: '#E8E8E8',
  muted: '#7A7A7A',
  error: '#FF4D4D',
  warn: '#FFC24D',
};

export const HEX = {
  primary: [0x00, 0xff, 0x88],
  primaryDim: [0x00, 0xb8, 0x62],
  background: [0x0a, 0x0a, 0x0a],
  panel: [0x1a, 0x1a, 0x1a],
  text: [0xe8, 0xe8, 0xe8],
  muted: [0x7a, 0x7a, 0x7a],
  error: [0xff, 0x4d, 0x4d],
  warn: [0xff, 0xc2, 0x4d],
};

let colourEnabled = null;

/** Colour is on unless NO_COLOR / FREECODE_NO_COLOR is set, or --no-color was passed. */
export function setColorEnabled(value) {
  colourEnabled = Boolean(value);
}

export function colorEnabled(stream = process.stdout) {
  if (colourEnabled !== null) return colourEnabled;
  if (process.env.NO_COLOR || process.env.FREECODE_NO_COLOR) return false;
  return Boolean(stream && stream.isTTY);
}

function rgb(name) {
  const c = HEX[name] || HEX.text;
  return `38;2;${c[0]};${c[1]};${c[2]}`;
}

/** Foreground colour. `fg('primary', 'text')` */
export function fg(name, text) {
  if (!colorEnabled()) return String(text);
  return `\x1b[${rgb(name)}m${text}\x1b[0m`;
}

/** Background + foreground pair, used by the header bar. */
export function band(bgName, fgName, text) {
  if (!colorEnabled()) return String(text);
  const bg = HEX[bgName] || HEX.background;
  return `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m\x1b[${rgb(fgName)}m${text}\x1b[0m`;
}

export function bold(text) {
  if (!colorEnabled()) return String(text);
  return `\x1b[1m${text}\x1b[22m`;
}

export function dim(text) {
  if (!colorEnabled()) return String(text);
  return `\x1b[2m${text}\x1b[22m`;
}

export function reset() {
  return colorEnabled() ? '\x1b[0m' : '';
}

/** Remove ANSI escapes so widths can be measured. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function visibleLength(text) {
  return stripAnsi(text).length;
}

/** Pad to a visible width (ANSI-aware). */
export function padEnd(text, width) {
  const diff = width - visibleLength(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

/** ANSI-aware word wrap, so panels never blow past the terminal width. */
export function wrap(text, width = 88) {
  const limit = Math.max(20, width);
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    if (visibleLength(rawLine) <= limit) {
      out.push(rawLine);
      continue;
    }
    const words = rawLine.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleLength(candidate) > limit && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export function terminalWidth(max = 100) {
  const cols = process.stdout && process.stdout.columns ? process.stdout.columns : 100;
  return Math.max(40, Math.min(max, cols - 4));
}

export const LOGO_GREEN = PALETTE.primary;
export const APP_BACKGROUND = PALETTE.background;
