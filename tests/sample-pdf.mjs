/**
 * tests/sample-pdf.mjs — 手工生成一个带可选文字的 PDF（用于端到端测试）
 *
 * 不引入任何依赖：按 PDF 1.4 语法拼字节，并正确计算 xref 偏移。
 * 文本层使用标准字体 Helvetica，pdf.js 会为它生成 textLayer，因此可以“划词”。
 */

/** @param {number} size 字号 @param {number} x @param {number} y @param {string} text */
function textOp(size, x, y, text) {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  return `BT /F1 ${size} Tf ${x} ${y} Td (${escaped}) Tj ET`;
}

const PAGES = [
  [
    textOp(36, 72, 700, 'hello world'),
    textOp(16, 72, 650, 'The quick brown fox jumps over the lazy dog.'),
    textOp(12, 72, 620, 'Select an English word and click the translate button.'),
  ],
  [
    textOp(36, 72, 700, 'translation'),
    textOp(16, 72, 650, 'Machine translation is the task of translating text automatically.'),
  ],
];

export function makeSamplePdf() {
  const objects = [];
  const pageCount = PAGES.length;
  const pageIds = PAGES.map((_, i) => 3 + i);
  const contentIds = PAGES.map((_, i) => 3 + pageCount + i);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  PAGES.forEach((ops, i) => {
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${3 + pageCount * 2} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
  });
  PAGES.forEach((ops, i) => {
    const stream = ops.join('\n') + '\n';
    objects[contentIds[i]] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`;
  });
  objects[3 + pageCount * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  const total = objects.length; // objects[0] 未使用
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let i = 1; i < total; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** 一个用于测试普通网页划词的 HTML 页面 */
export const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sample page</title></head>
<body style="font: 18px/1.8 system-ui; padding: 40px">
  <h1>Sample article</h1>
  <p id="p1">The word hello appears here for the selection test.</p>
</body></html>`;
