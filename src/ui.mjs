/**
 * Small terminal UI toolkit: boxes, headers, markdown-ish rendering, spinners.
 * No dependencies - truecolor ANSI only, degrades cleanly when piped.
 */
import process from 'node:process';
import { fg, bold, dim, padEnd, visibleLength, colorEnabled, HEX, band, stripAnsi, wrap, terminalWidth } from './theme.mjs';

/** Rounded panel with optional title, green border. */
export function box(text, { title = '', colour = 'primary', padding = 1 } = {}) {
  const maxWidth = terminalWidth() - padding * 2;
  const raw = wrap(String(text), maxWidth);
  const width = Math.max(
    title ? visibleLength(title) + 4 : 0,
    ...raw.map((line) => visibleLength(line)),
  );
  const inner = width + padding * 2;
  const edge = (l, mid, r) => fg(colour, l + mid.repeat(inner) + r);
  const out = [];
  out.push(edge('╭', '─', '╮'));
  if (title) {
    const label = ' ' + bold(fg(colour, title)) + ' ';
    const line = '─'.repeat(Math.max(0, inner - visibleLength(label)));
    out.push(fg(colour, '│') + label + line + fg(colour, '│'));
  }
  const pad = ' '.repeat(padding);
  for (const line of raw) {
    out.push(fg(colour, '│') + pad + padEnd(line, width) + pad + fg(colour, '│'));
  }
  out.push(edge('╰', '─', '╯'));
  return out.join('\n');
}

/** Green section header line. */
export function header(text) {
  return bold(fg('primary', `━━ ${text} `)) + fg('primaryDim', '━'.repeat(Math.max(0, 44 - String(text).length)));
}

export function ok(text) {
  return `${fg('primary', '✔')} ${text}`;
}

export function warn(text) {
  return `${fg('warn', '!')} ${text}`;
}

export function error(text) {
  return `${fg('error', '✖')} ${text}`;
}

export function bullet(text) {
  return `${fg('primary', '•')} ${text}`;
}

/**
 * Lightweight markdown rendering for model output:
 * headings, bullets, inline code, bold, and fenced code blocks with a gutter.
 */
export function renderMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let fenceLang = '';
  for (const line of lines) {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1] || '';
        out.push(fg('primaryDim', `  ╭─ ${fenceLang || 'code'}`));
      } else {
        inFence = false;
        out.push(fg('primaryDim', '  ╰─'));
      }
      continue;
    }
    if (inFence) {
      out.push(fg('primaryDim', '  │ ') + fg('text', line));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(bold(fg('primary', h[2].toUpperCase())));
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      out.push(line.replace(/^(\s*)[-*+]\s+/, (_, ind) => `${ind}${fg('primary', '•')} `));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push(line.replace(/^(\s*)(\d+)\.\s+/, (_, ind, n) => `${ind}${fg('primary', n + '.')} `));
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n');
}

/** Inline `code`, **bold** and *italic* for a single line. */
export function inline(line) {
  let out = String(line);
  out = out.replace(/`([^`]+)`/g, (_, code) => fg('primary', code));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t));
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, (_, pre, t) => `${pre}${dim(t)}`);
  return out;
}

/** Render a table-ish key/value summary. */
export function keyValue(rows, { indent = '  ' } = {}) {
  const w = Math.max(...rows.map(([k]) => visibleLength(k)));
  return rows
    .map(([k, v]) => `${indent}${fg('muted', padEnd(k, w))}  ${v}`)
    .join('\n');
}

/** Simple animated spinner that is silent when not a TTY. */
export function spinner(label = 'thinking') {
  if (!colorEnabled() || !process.stderr.isTTY) {
    return { stop() {}, update() {} };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let current = label;
  const paint = () => {
    process.stderr.write(`\r\x1b[2K${fg('primary', frames[i++ % frames.length])} ${dim(current)}`);
  };
  paint();
  const timer = setInterval(paint, 80);
  return {
    update(next) {
      current = next;
    },
    stop() {
      clearInterval(timer);
      process.stderr.write('\r\x1b[2K');
    },
  };
}

export function bannerLine(text) {
  return band('primary', 'background', ` ${text} `);
}

/** Strip ANSI + trailing spaces for tests / non-tty output. */
export function plain(text) {
  return stripAnsi(text).replace(/\s+$/gm, '');
}

export { HEX };
