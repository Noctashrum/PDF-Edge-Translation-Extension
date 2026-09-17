#!/usr/bin/env node
/**
 * tools/check-pdfjs-contract.mjs
 *
 * 校验 vendored 的两个 pdf.js 文件的“接口契约”：
 *   web/pdf_viewer.mjs 是 webpack 打的 bundle，顶部会
 *       const { …一堆名字… } = globalThis.pdfjsLib;
 *   也就是说它要求先加载 core（build/pdf.min.mjs）并把核心挂到 globalThis.pdfjsLib。
 * 本脚本检查 core 是否真的导出了这些名字，避免运行时才发现 undefined。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'extension/vendor/pdfjs/build/pdf.min.mjs');
const VIEWER = join(ROOT, 'extension/vendor/pdfjs/web/pdf_viewer.mjs');

const coreSrc = readFileSync(CORE, 'utf8');
const viewerSrc = readFileSync(VIEWER, 'utf8');

/* 1) bundle 需要 core 提供的名字 */
const depMatch = /const\s*\{([\s\S]*?)\}\s*=\s*globalThis\.pdfjsLib\s*;/.exec(viewerSrc);
if (!depMatch) {
  console.error('✗ 没找到 `= globalThis.pdfjsLib` 解构块，pdf_viewer.mjs 结构可能变了');
  process.exit(1);
}
const needed = depMatch[1]
  .split(',')
  .map((s) => s.trim().split(':')[0].trim())
  .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));

/* 2) core 实际导出的名字（取最后一个 export{...}，处理 `x as y`） */
const exportBlocks = [...coreSrc.matchAll(/export\s*\{([^}]*)\}/g)];
if (!exportBlocks.length) {
  console.error('✗ core 里没找到 export{...}');
  process.exit(1);
}
const exported = new Set();
for (const m of exportBlocks) {
  for (const raw of m[1].split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const as = part.split(/\s+as\s+/);
    exported.add((as[1] ?? as[0]).trim());
  }
}

const missing = needed.filter((n) => !exported.has(n));
console.log(`pdf_viewer.mjs 依赖 core 的 ${needed.length} 个成员，core 导出 ${exported.size} 个。`);
if (missing.length) {
  console.error('✗ core 缺少以下被依赖的导出：', missing.join(', '));
  process.exit(1);
}
console.log('✓ 契约一致：先 import core 并挂到 globalThis.pdfjsLib，再加载 pdf_viewer.mjs 即可。');

/* 3) 顺带确认版本一致性（PDFViewer 构造函数会 hard-code 版本号做校验） */
const coreVersion = /pdfjsVersion\s*=\s*([\d.]+)/.exec(coreSrc)?.[1] ?? '(未知)';
const viewerVersion = /const viewerVersion = "([\d.]+)"/.exec(viewerSrc)?.[1] ?? '(未知)';
console.log(`core version=${coreVersion}  viewer 期望=${viewerVersion}`);
if (coreVersion !== viewerVersion) {
  console.error('✗ 版本不一致，PDFViewer 会在构造时抛错');
  process.exit(1);
}
console.log('✓ 版本一致');
