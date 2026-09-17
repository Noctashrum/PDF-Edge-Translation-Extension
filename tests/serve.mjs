/**
 * tests/serve.mjs — 测试用静态服务器
 *
 *   node tests/serve.mjs [port]
 *
 * 路由：
 *   /            普通 HTML 页面（测网页划词）
 *   /sample.pdf  带 .pdf 后缀的 PDF（测 DNR 重定向快路径）
 *   /pdfroute    没有 .pdf 后缀、但 Content-Type 是 application/pdf（测响应头兜底）
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { makeSamplePdf, SAMPLE_HTML } from './sample-pdf.mjs';

export function startServer(port = 0) {
  const pdf = makeSamplePdf();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/sample.pdf' || url.pathname === '/pdfroute') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Cache-Control': 'no-store',
      });
      res.end(pdf);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(SAMPLE_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// 直接 `node tests/serve.mjs` 时启动；被 e2e.mjs import 时只导出 startServer
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 8788;
  const { url } = await startServer(port);
  console.log(`测试服务器已启动：${url}  （PDF: ${url}/sample.pdf，无后缀 PDF: ${url}/pdfroute）`);
}
