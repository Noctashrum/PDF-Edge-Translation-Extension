#!/usr/bin/env node
/**
 * tools/vendor-pdfjs.mjs
 *
 * 把 pdfjs-dist 的运行时资源复制到 extension/vendor/pdfjs。
 * 只复制运行时真正需要的文件（跳过 sourcemap / legacy 构建以控制体积）。
 *
 *   node tools/vendor-pdfjs.mjs            # 缺包时自动 npm pack 下载
 *   node tools/vendor-pdfjs.mjs --force    # 强制重新下载并复制
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PDFJS_VERSION = '6.3.289';
const TMP = join(ROOT, '.tmp');
const PKG = join(TMP, 'pdfjs-pkg', 'package');
const OUT = join(ROOT, 'extension', 'vendor', 'pdfjs');

const force = process.argv.includes('--force');

function log(...a) {
  console.log('[vendor-pdfjs]', ...a);
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  if (!statSync(dir).isDirectory()) return statSync(dir).size;
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

/** 下载并解包 pdfjs-dist（npm registry，比 GitHub Release 更稳） */
function ensurePackage() {
  const marker = join(PKG, 'build', 'pdf.min.mjs');
  if (!force && existsSync(marker)) {
    log('使用已缓存的 pdfjs-dist@' + PDFJS_VERSION);
    return;
  }
  rmSync(join(TMP, 'pdfjs-pkg'), { recursive: true, force: true });
  mkdirSync(join(TMP, 'pdfjs-pkg'), { recursive: true });
  log(`npm pack pdfjs-dist@${PDFJS_VERSION} …`);
  const tgz = execFileSync('npm', ['pack', `pdfjs-dist@${PDFJS_VERSION}`, '--loglevel=warn'], {
    cwd: TMP,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
    .trim()
    .split(/\r?\n/)
    .pop();
  log('解包', tgz);
  execFileSync('tar', ['-xzf', tgz, '-C', join(TMP, 'pdfjs-pkg')], {
    cwd: TMP,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  // 解包目录名固定为 package，重命名以免和其它包冲突
  if (!existsSync(marker)) throw new Error('pdfjs-dist 解包失败：找不到 build/pdf.min.mjs');
}

function copy(from, to) {
  const src = join(PKG, from);
  if (!existsSync(src)) {
    log('!! 跳过（不存在）:', from);
    return 0;
  }
  const dest = join(OUT, to ?? from);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => !s.endsWith('.map') && !s.endsWith('.d.mts') && !s.endsWith('.d.ts'),
  });
  return dirSize(dest);
}

ensurePackage();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const copied = [];
// ── 核心 ────────────────────────────────────────────────────────────────
copied.push(['build/pdf.min.mjs', copy('build/pdf.min.mjs')]);
copied.push(['build/pdf.worker.min.mjs', copy('build/pdf.worker.min.mjs')]);
copied.push(['build/pdf.sandbox.mjs（PDF 内嵌 JS 沙箱，可选）', copy('build/pdf.sandbox.mjs')]);
// ── 阅读器组件（我们自己写 UI，用它渲染页面 / 文本层 / 注释层）──────────
copied.push(['web/pdf_viewer.mjs', copy('web/pdf_viewer.mjs')]);
copied.push(['web/pdf_viewer.css', copy('web/pdf_viewer.css')]);
copied.push(['web/images/', copy('web/images')]);
// ── 资源：CMap（中日韩字体）、标准字体、WASM 解码器、ICC 色彩配置 ────────
copied.push(['cmaps/', copy('cmaps')]);
copied.push(['standard_fonts/', copy('standard_fonts')]);
copied.push(['wasm/', copy('wasm')]);
copied.push(['iccs/', copy('iccs')]);
// ── JPX/JBIG2 的 JS 回退实现（WASM 不可用时）────────────────────────────
copied.push(['image_decoders/pdf.image_decoders.min.mjs', copy('image_decoders/pdf.image_decoders.min.mjs')]);
// ── 许可证 ──────────────────────────────────────────────────────────────
copy('LICENSE', 'LICENSE.pdfjs');
writeFileSync(
  join(OUT, 'VERSION'),
  `pdfjs-dist@${PDFJS_VERSION}\nApache License 2.0 — https://github.com/mozilla/pdf.js\n` +
    `vendored by tools/vendor-pdfjs.mjs\n`,
);

log('输出目录:', OUT);
for (const [name, bytes] of copied) log(`  ${String(bytes).padStart(9)} B  ${name}`);
const total = dirSize(OUT);
log(`合计 ${(total / 1024 / 1024).toFixed(2)} MB`);
