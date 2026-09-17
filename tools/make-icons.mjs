#!/usr/bin/env node
/**
 * tools/make-icons.mjs
 *
 * 生成扩展图标（16/32/48/128 PNG），零依赖：自己光栅化 + 自己编码 PNG。
 * 图形：蓝→青渐变圆角方块 + 白色字母 A + 白色右箭头（寓意“把 A 译过去”）。
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension', 'icons');

/* ── PNG 编码 ─────────────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 极简光栅化（设计坐标系 100×100，3×3 超采样抗锯齿）────────────────── */
const SS = 3;

function roundedRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    if (x >= x0 + r && x <= x1 - r) return true;
    if (y >= y0 + r && y <= y1 - r) return true;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
}

function thickLine(ax, ay, bx, by, w) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const h = w / 2;
  return (x, y) => {
    let t = ((x - ax) * dx + (y - ay) * dy) / len2;
    t = Math.min(1, Math.max(0, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    return (x - px) ** 2 + (y - py) ** 2 <= h * h;
  };
}

function triangle(p0, p1, p2) {
  const sign = (x, y, a, b) => (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
  return (x, y) => {
    const d1 = sign(x, y, p0, p1);
    const d2 = sign(x, y, p1, p2);
    const d3 = sign(x, y, p2, p0);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
}

const LAYERS = [
  // 背景：渐变色圆角方块
  {
    inside: roundedRect(4, 4, 96, 96, 22),
    color: (x, y) => {
      const t = Math.min(1, Math.max(0, (x + y) / 200));
      return [Math.round(37 + (14 - 37) * t), Math.round(99 + (165 - 99) * t), Math.round(235 + (233 - 235) * t)];
    },
  },
  // 白色字母 A
  { inside: thickLine(20, 78, 38, 26, 11), color: () => [255, 255, 255] },
  { inside: thickLine(38, 26, 56, 78, 11), color: () => [255, 255, 255] },
  { inside: thickLine(28, 58, 48, 58, 9), color: () => [255, 255, 255] },
  // 白色箭头
  { inside: thickLine(62, 52, 88, 52, 9), color: () => [255, 255, 255] },
  { inside: triangle([80, 40], [96, 52], [80, 64]), color: () => [255, 255, 255] },
];

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 100 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const layer of LAYERS) {
        let hits = 0;
        let cr = 0;
        let cg = 0;
        let cb = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const dx = (x + (sx + 0.5) / SS) * scale;
            const dy = (y + (sy + 0.5) / SS) * scale;
            if (layer.inside(dx, dy)) {
              hits++;
              const c = layer.color(dx, dy);
              cr += c[0];
              cg += c[1];
              cb += c[2];
            }
          }
        }
        if (!hits) continue;
        const n = SS * SS;
        const cov = hits / n;
        const lr = cr / hits;
        const lg = cg / hits;
        const lb = cb / hits;
        // source-over（图层本身不透明，源 alpha = cov）
        const outA = cov + a * (1 - cov);
        r = (lr * cov + r * a * (1 - cov)) / (outA || 1);
        g = (lg * cov + g * a * (1 - cov)) / (outA || 1);
        b = (lb * cov + b * a * (1 - cov)) / (outA || 1);
        a = outA;
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(r);
      px[o + 1] = Math.round(g);
      px[o + 2] = Math.round(b);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, px);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, render(size));
  console.log(`[make-icons] ${file}`);
}
