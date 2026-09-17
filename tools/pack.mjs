#!/usr/bin/env node
/**
 * tools/pack.mjs — 把 extension/ 打包成可分发/可离线安装的 zip
 *
 *   node tools/pack.mjs            # 产出 dist/pdf-huaci-translator-<version>.zip
 *   node tools/pack.mjs --crx      # 额外用 Edge 打一个 .crx（同时生成 .pem 私钥）
 *
 * zip 用纯 node 实现（zlib + 手写 ZIP 结构），不依赖任何第三方包，跨平台一致。
 */
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DIST = join(ROOT, 'dist');

/* ── ZIP 写入 ───────────────────────────────────────────────────── */
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

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push({ full, name: relative(base, full).split(sep).join('/') });
  }
  return out;
}

function makeZip(files) {
  const { time, date } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const raw = readFileSync(file.full);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 30); // extra + comment 长度都为 0
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ── 主流程 ─────────────────────────────────────────────────────── */
const version = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')).version;
const files = walk(EXT);
if (!files.some((f) => f.name === 'vendor/pdfjs/build/pdf.worker.min.mjs')) {
  console.error('✗ 缺少 vendor/pdfjs 资源，请先运行：npm run vendor');
  process.exit(1);
}
if (!files.some((f) => f.name === 'icons/icon128.png')) {
  console.error('✗ 缺少图标，请先运行：npm run icons');
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });
const zipPath = join(DIST, `pdf-huaci-translator-${version}.zip`);
const zip = makeZip(files);
writeFileSync(zipPath, zip);
console.log(`✓ 打包完成：${zipPath}`);
console.log(`  ${files.length} 个文件，${(zip.length / 1024 / 1024).toFixed(2)} MB`);

if (process.argv.includes('--crx')) {
  const edge = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
  if (!edge) {
    console.warn('· 没找到 msedge.exe，跳过 .crx');
  } else {
    try {
      execFileSync(edge, [`--pack-extension=${EXT}`, `--pack-extension-key=${join(DIST, 'extension.pem')}`], {
        stdio: 'inherit',
      });
      console.log('· .crx 生成在 extension/ 同级目录（Edge 的 --pack-extension 行为）');
    } catch {
      console.warn('· .crx 打包失败（Edge 版本差异），zip 已可用');
    }
  }
}
console.log('\n安装方式（推荐 Load unpacked）：');
console.log('  Edge → 地址栏输入 edge://extensions → 打开左下角「开发人员模式」→「加载解压缩的扩展」→ 选 ' + EXT);
