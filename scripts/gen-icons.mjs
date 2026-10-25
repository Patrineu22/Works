#!/usr/bin/env node
/**
 * Generate FreeCode PNG + ICO assets from the brand geometry, with zero
 * dependencies (no sharp/libvips downloads, works offline on Windows).
 *
 *   node scripts/gen-icons.mjs
 *
 * Outputs
 *   assets/logo/freecode-icon.png        512x512
 *   assets/logo/freecode-full.png        1200x320
 *   packages/desktop/public/logo.png     512x137
 *   packages/desktop/src-tauri/icons/icon.png       512
 *   packages/desktop/src-tauri/icons/128x128.png
 *   packages/desktop/src-tauri/icons/32x32.png
 *   packages/desktop/src-tauri/icons/icon.ico       (16/32/48/64/128/256)
 *
 * The shapes mirror assets/logo/*.svg exactly: #00FF88 on #0A0A0A, rounded
 * frame, chevron and underscore bar.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GREEN = [0x00, 0xff, 0x88];
const BLACK = [0x0a, 0x0a, 0x0a];
const TRANSPARENT = [0, 0, 0, 0];

/* ------------------------------------------------------------- rasteriser */

class Canvas {
  constructor(width, height, background = TRANSPARENT) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    if (background[3]) this.fill(background);
  }

  fill(colour) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = colour[0];
      this.data[i + 1] = colour[1];
      this.data[i + 2] = colour[2];
      this.data[i + 3] = colour[3] ?? 255;
    }
  }

  /** Source-over blend of one pixel with coverage 0..1. */
  blend(x, y, colour, coverage) {
    if (coverage <= 0) return;
    const a = Math.min(1, coverage) * ((colour[3] ?? 255) / 255);
    if (a <= 0) return;
    const i = (y * this.width + x) * 4;
    const dstA = this.data[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    for (let c = 0; c < 3; c += 1) {
      this.data[i + c] = Math.round((colour[c] * a + this.data[i + c] * dstA * (1 - a)) / outA);
    }
    this.data[i + 3] = Math.round(outA * 255);
  }

  /** Paint a signed-distance shape: negative distance = inside. */
  paint(x0, y0, x1, y1, colour, sdf) {
    const minX = Math.max(0, Math.floor(x0));
    const minY = Math.max(0, Math.floor(y0));
    const maxX = Math.min(this.width - 1, Math.ceil(x1));
    const maxY = Math.min(this.height - 1, Math.ceil(y1));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const d = sdf(x + 0.5, y + 0.5);
        const coverage = Math.min(1, Math.max(0, 0.5 - d));
        if (coverage > 0) this.blend(x, y, colour, coverage);
      }
    }
  }

  roundRect(x, y, w, h, r, colour, { stroke = 0 } = {}) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const hw = w / 2;
    const hh = h / 2;
    const rr = Math.min(r, hw, hh);
    const half = stroke / 2;
    const sdf = (px, py) => {
      const qx = Math.abs(px - cx) - (hw - rr);
      const qy = Math.abs(py - cy) - (hh - rr);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      const d = outside + inside - rr;
      return stroke > 0 ? Math.abs(d) - half : d;
    };
    this.paint(x - stroke, y - stroke, x + w + stroke, y + h + stroke, colour, sdf);
  }

  line(points, width, colour) {
    const segs = [];
    for (let i = 0; i < points.length - 1; i += 1) segs.push([points[i], points[i + 1]]);
    const half = width / 2;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const sdf = (px, py) => {
      let best = Infinity;
      for (const [[ax, ay], [bx, by]] of segs) {
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
      }
      return best - half;
    };
    this.paint(
      Math.min(...xs) - width,
      Math.min(...ys) - width,
      Math.max(...xs) + width,
      Math.max(...ys) + width,
      colour,
      sdf,
    );
  }
}

/* --------------------------------------------------------------- geometry */

/** The icon mark: rounded frame + chevron + underscore, at any size. */
function drawIconMark(canvas, { size = 512, scale = 1, offsetX = 0, offsetY = 0, frame = true } = {}) {
  const s = (value) => value * (size / 512) * scale + (value <= 256 ? offsetX : offsetY) * 0;
  const k = (size / 512) * scale;
  const ox = offsetX;
  const oy = offsetY;

  if (frame) {
    canvas.roundRect(ox, oy, 512 * k, 512 * k, 110 * k, BLACK);
    canvas.roundRect(ox + 16 * k, oy + 16 * k, 480 * k, 480 * k, 94 * k, GREEN, { stroke: 12 * k });
  }

  const gx = ox + 120 * k;
  const gy = oy + 140 * k;
  canvas.line(
    [
      [gx + 20 * k, gy + 60 * k],
      [gx + 110 * k, gy + 135 * k],
      [gx + 20 * k, gy + 210 * k],
    ],
    28 * k,
    GREEN,
  );
  canvas.roundRect(gx + 145 * k, gy + 175 * k, 110 * k, 26 * k, 6 * k, GREEN);
  return { s };
}

/** 5x7 block font, only the letters in FREECODE. */
const GLYPHS = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
};

function drawWordmark(canvas, word, { x = 300, y = 80, scale = 13, gap = 3, colour = GREEN } = {}) {
  let cursor = x;
  for (const letter of word) {
    const glyph = GLYPHS[letter];
    if (!glyph) {
      cursor += (5 + gap) * scale;
      continue;
    }
    glyph.forEach((row, ry) => {
      row.split('').forEach((bit, rx) => {
        if (bit === '1') canvas.roundRect(cursor + rx * scale, y + ry * scale, scale, scale, 1.5, colour);
      });
    });
    cursor += (5 + gap) * scale;
  }
  return cursor;
}

/* ------------------------------------------------------------ PNG encoder */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePng(canvas) {
  const { width, height, data } = canvas;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container with PNG-compressed entries (accepted by Windows Vista+). */
export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  const blobs = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ---------------------------------------------------------------- builders */

function iconCanvas(size) {
  const canvas = new Canvas(size, size, TRANSPARENT);
  drawIconMark(canvas, { size });
  return canvas;
}

function fullCanvas(width = 1200, height = 320) {
  const canvas = new Canvas(width, height, [...BLACK, 255]);
  // Exactly the freecode-full.svg geometry, scaled to the requested width.
  const k = width / 1200;
  const ox = 20 * k;
  const oy = 40 * k;
  canvas.roundRect(ox, oy, 240 * k, 180 * k, 35 * k, GREEN, { stroke: 8 * k });
  canvas.line(
    [
      [ox + 50 * k, oy + 50 * k],
      [ox + 105 * k, oy + 100 * k],
      [ox + 50 * k, oy + 150 * k],
    ],
    10 * k,
    GREEN,
  );
  canvas.roundRect(ox + 120 * k, oy + 130 * k, 60 * k, 12 * k, 3 * k, GREEN);
  drawWordmark(canvas, 'FREECODE', { x: 300 * k, y: 78 * k, scale: 13.6 * k, gap: 3, colour: GREEN });
  return canvas;
}

function devBitmapFontNote() {
  return 'logo text uses a built-in 5x7 mono bitmap scaled up (no font files needed)';
}

function write(file, buffer) {
  const target = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return `${file}  ${(buffer.length / 1024).toFixed(1)} KB`;
}

export function main() {
  const written = [];
  const icon512 = iconCanvas(512);
  written.push(write('assets/logo/freecode-icon.png', encodePng(icon512)));

  const full = fullCanvas(1200, 320);
  written.push(write('assets/logo/freecode-full.png', encodePng(full)));

  const publicLogo = fullCanvas(512, 137);
  written.push(write('packages/desktop/public/logo.png', encodePng(publicLogo)));

  const iconsDir = 'packages/desktop/src-tauri/icons';
  const pngs = new Map();
  for (const size of [512, 256, 128, 64, 48, 32, 16]) {
    const png = encodePng(iconCanvas(size));
    pngs.set(size, png);
    if (size === 512) written.push(write(`${iconsDir}/icon.png`, png));
    if (size === 128) written.push(write(`${iconsDir}/128x128.png`, png));
    if (size === 32) written.push(write(`${iconsDir}/32x32.png`, png));
  }
  const ico = encodeIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngs.get(size) })));
  written.push(write(`${iconsDir}/icon.ico`, ico));

  // website / README previews
  written.push(write('packages/desktop/public/icon.png', pngs.get(256)));

  console.log('FreeCode icons built:');
  for (const line of written) console.log(`  ✔ ${line}`);
  console.log(`  ℹ ${devBitmapFontNote()}`);
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
