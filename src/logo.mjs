/**
 * FreeCode logo - terminal (ASCII) and desktop (SVG) versions share the same
 * #00FF88 on #0A0A0A identity.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fg, band, bold } from './theme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const LOGO_DIR = path.join(REPO_ROOT, 'assets', 'logo');

export const FreeCodeLogo = ` ███████╗██████╗ ███████╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗
 ██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝
 █████╗  ██████╔╝█████╗  █████╗  ██║     ██║   ██║██║  ██║█████╗
 ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██║     ██║   ██║██║  ██║██╔══╝
 ██║     ██║  ██║███████╗███████╗╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
                       >_ freecode v1.0.0 - FreeCode Green`;

/** Green ASCII logo with a rounded-border feel. */
export function renderLogo() {
  const lines = FreeCodeLogo.split('\n');
  const art = lines.slice(0, 6).map((line) => fg('primary', line));
  const tag = lines[6];
  return [...art, bold(fg('primaryDim', tag))].join('\n');
}

/** Header bar: "FREECODE - AI CODING AGENT - GREEN" (green background, black text). */
export function renderHeader(text = ' FREECODE - AI CODING AGENT - GREEN ') {
  return band('primary', 'background', bold(text));
}

/** Full startup banner. */
export function renderBanner({ version = '1.0.0', provider = '', agent = '' } = {}) {
  const out = [];
  out.push('');
  out.push(renderLogo());
  out.push('');
  out.push(renderHeader());
  out.push('');
  out.push(
    [
      fg('muted', '  keyless free forever'),
      fg('primaryDim', '|'),
      fg('muted', 'agents '),
      fg('primary', 'JIM'),
      fg('muted', ' '),
      fg('primary', 'KAI'),
      fg('muted', ' '),
      fg('primary', 'ALEX'),
      provider ? `${fg('primaryDim', '|')}${fg('muted', ' ' + provider)}` : '',
      agent ? `${fg('primaryDim', '|')}${fg('muted', ' agent ')}${fg('primary', agent)}` : '',
    ].join(' '),
  );
  out.push(fg('muted', `  v${version}  /help for commands  /exit to quit`));
  out.push('');
  return out.join('\n');
}

/** Load an SVG asset as text (used by --show-logo / /logo). */
export function readLogoAsset(name) {
  const file = path.join(LOGO_DIR, name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

export const LOGO_FILES = {
  icon: 'freecode-icon.svg',
  full: 'freecode-full.svg',
  iconPng: 'freecode-icon.png',
  fullPng: 'freecode-full.png',
};
