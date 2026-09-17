/**
 * tests/e2e.mjs — 真机端到端测试（Edge + CDP）
 *
 * 做的是真事，不是 mock：
 *   1. 起一个本地服务器，提供 sample.pdf（带可选文字）、无 .pdf 后缀的 PDF、普通 HTML；
 *   2. 用 --load-extension 把 extension/ 装进真实 Edge（默认 headless=new）；
 *   3. 打开 PDF，断言标签页被换成本扩展的阅读器（chrome-extension://…/viewer.html?file=…）；
 *   4. 用 CDP 派发真实鼠标事件「划词」→ 出现「译」按钮 → 点击 → 断言弹出中文释义卡片；
 *   5. 顺带验证无后缀 PDF 的响应头兜底、普通网页划词、设置页/弹窗页可打开、无 JS 异常；
 *   6. 截图存到 tests/artifacts/ 便于人工核对界面。
 *
 * 用法：
 *   node tests/e2e.mjs                        # headless 跑一遍
 *   node tests/e2e.mjs --headed               # 有界面模式（headless 有问题时用）
 *   node tests/e2e.mjs --headed --keep-open   # 跑完不关 Edge，方便手动体验
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, 'extension');
const ARTIFACTS = join(ROOT, 'tests', 'artifacts');
const DEBUG_PORT = Number(process.env.PDFT_DEBUG_PORT || 9333);
const HEADED = process.argv.includes('--headed');
const KEEP_OPEN = process.argv.includes('--keep-open');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 结果记录 ───────────────────────────────────────────────────── */
const results = [];
const consoleErrors = [];
const exceptions = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

function info(message) {
  console.log(`  · ${message}`);
}

/** 每个场景独立兜错：前面的失败不能让后面的检查跑不到 */
async function scenario(title, fn) {
  console.log('\n' + title);
  try {
    await fn();
  } catch (err) {
    check(`${title}（未抛异常）`, false, err?.message || String(err));
  }
}

/* ── 极简 CDP 客户端 ────────────────────────────────────────────── */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
        return;
      }
      if (msg.method) for (const cb of this.listeners.get(msg.method) || []) cb(msg.params, msg.sessionId);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败：' + url)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30_000);
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/* ── 浏览器控制 ─────────────────────────────────────────────────── */
async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return res.json();
}

async function waitForDevTools(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error('Edge 的调试端口没有就绪');
}

async function openTab(url) {
  let res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error('无法新建标签页：' + res.status);
  const info = await res.json();
  // 必须把标签页切到前台：隐藏标签页里 Chromium 不会跑渲染，pdf.js 会一直停在 loading
  // （这和用户真实用鼠标点开 PDF 的场景一致）
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/activate/${info.id}`).catch(() => {});
  return info;
}

async function closeTab(targetId) {
  try {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${targetId}`);
  } catch {
    /* 忽略 */
  }
}

/** 等待某个 page target 的 URL 满足条件，返回该 target */
async function waitForPage(predicate, { timeout = 20_000, label = 'page' } = {}) {
  const deadline = Date.now() + timeout;
  let seen = [];
  while (Date.now() < deadline) {
    const targets = await listTargets().catch(() => []);
    seen = [];
    for (const t of targets) {
      if (t.type !== 'page') continue;
      if (predicate(t)) return t;
      seen.push(t.url.slice(0, 80));
    }
    await sleep(250);
  }
  throw new Error(`等待 ${label} 超时。当时所有页面标签：\n      - ${seen.join('\n      - ')}`);
}

/** 在某个 page target 上求值（自动 attach 一个扁平会话） */
async function withSession(browser, targetId, fn) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await browser.send('Runtime.enable', {}, sessionId);
    await browser.send('Page.enable', {}, sessionId);
    return await fn(sessionId);
  } finally {
    await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function evalIn(browser, sessionId, expression, { awaitPromise = true } = {}) {
  const r = await browser.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('页面内求值异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function pollEval(browser, sessionId, expression, predicate, { timeout = 20_000, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evalIn(browser, sessionId, expression);
      if (predicate(last)) return last;
    } catch (err) {
      last = String(err.message);
    }
    await sleep(250);
  }
  throw new Error(`等待「${label}」超时，最后一次结果：${JSON.stringify(last)}`);
}

async function screenshot(browser, sessionId, name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = join(ARTIFACTS, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/* ── 注入页面执行的小脚本 ───────────────────────────────────────── */
const SELECT_WORD = (word) => `(() => {
  const word = ${JSON.stringify(word)};
  let node = null;
  let host = null;
  // 1) pdf.js 文本层
  for (const span of document.querySelectorAll('.textLayer span')) {
    const found = [...span.childNodes].find((n) => n.nodeType === 3 && (n.textContent || '').toLowerCase().includes(word));
    if (found) { node = found; host = span; break; }
  }
  // 2) 普通网页 DOM
  if (!node) {
    const root = document.getElementById('p1') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if ((t.textContent || '').toLowerCase().includes(word)) { node = t; host = t.parentElement; break; }
    }
  }
  if (!node) return { ok: false, reason: '页面上没有找到该词' };
  const at = node.textContent.toLowerCase().indexOf(word);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + word.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const rect = range.getBoundingClientRect();
  host.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true, cancelable: true, button: 0, buttons: 1,
    clientX: rect.left + Math.min(3, rect.width / 2),
    clientY: rect.top + rect.height / 2,
  }));
  return {
    ok: true,
    selected: sel.toString(),
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
})()`;

const WORD_RECT = (word) => `(() => {
  const word = ${JSON.stringify(word)};
  const candidates = [...document.querySelectorAll('.textLayer span, #p1, p, h1')];
  const host = candidates.find((s) => (s.textContent || '').toLowerCase().includes(word));
  if (!host) return null;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || '').toLowerCase().includes(word)) { node = walker.currentNode; break; }
  }
  if (!node) return null;
  const at = node.textContent.toLowerCase().indexOf(word);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + word.length);
  const r = range.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
})()`;

const BUBBLE_STATE = `(() => {
  const host = document.querySelector('pdft-bubble-host');
  const root = host && host.shadowRoot;
  if (!root) return { state: 'no-host' };
  const btn = root.querySelector('.pdft-btn');
  const card = root.querySelector('.pdft-card');
  if (!card) return { state: btn ? 'button' : 'idle' };
  const q = (sel) => card.querySelector(sel)?.textContent?.trim() || '';
  return {
    state: 'card',
    word: q('.pdft-word'),
    engine: q('.pdft-engine'),
    phonetics: q('.pdft-phonetics'),
    error: q('.pdft-error'),
    translation: q('.pdft-sentence'),
    meanings: [...card.querySelectorAll('.pdft-mean')].map((m) => ({
      pos: m.querySelector('.pdft-pos')?.textContent?.trim() || '',
      defs: [...m.querySelectorAll('.pdft-def')].map((d) => d.textContent.trim()),
    })),
    examples: [...card.querySelectorAll('.pdft-ex .en')].map((e) => e.textContent.trim()),
  };
})()`;

const CLICK_TRANSLATE_BUTTON = `(() => {
  const host = document.querySelector('pdft-bubble-host');
  const btn = host?.shadowRoot?.querySelector('.pdft-btn');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

/** 采集某个会话的异常/控制台错误 */
function watchSession(browser, sessionId) {
  browser.on('Runtime.exceptionThrown', (p, s) => {
    if (s === sessionId) exceptions.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });
  browser.on('Runtime.consoleAPICalled', (p, s) => {
    if (s === sessionId && (p.type === 'error' || p.type === 'warning')) {
      consoleErrors.push(`${p.type}: ${(p.args || []).map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
}

/** 走完「选中 → 出按钮 → 点击 → 出中文卡片」全链路 */
async function translateFlow(browser, sessionId, { word, prefix }) {
  const sel = await evalIn(browser, sessionId, SELECT_WORD(word));
  check(`${prefix}选中 ${word}`, sel.ok, sel.ok ? `选中「${sel.selected}」` : sel.reason);
  if (!sel.ok) return null;

  const beforeClick = await pollEval(browser, sessionId, BUBBLE_STATE, (s) => s.state === 'button', {
    timeout: 8000,
    label: `${prefix}出现「译」按钮`,
  });
  check(`${prefix}出现「译」按钮`, beforeClick.state === 'button');

  check(`${prefix}点击「译」按钮`, (await evalIn(browser, sessionId, CLICK_TRANSLATE_BUTTON)) === true);

  const card = await pollEval(
    browser,
    sessionId,
    BUBBLE_STATE,
    (s) => s.state === 'card' && (s.error || s.meanings?.length || s.translation),
    { timeout: 25_000, label: `${prefix}翻译结果卡片` },
  );
  const hasCjk = /[\u4e00-\u9fff]/.test(JSON.stringify(card));
  check(`${prefix}卡片显示中文释义`, !card.error && hasCjk, card.error || card.word);
  return card;
}

/** 某个标签页是否已经变成「本扩展的阅读器 + 指定 PDF」 */
function viewerMatch(extId, needle) {
  return (t) =>
    t.type === 'page' &&
    t.url.startsWith(`chrome-extension://${extId}/viewer/viewer.html`) &&
    decodeURIComponent(t.url).includes(needle);
}

/* ── 场景 ───────────────────────────────────────────────────────── */

async function scenario1PdfTakeover(browser, extId, baseUrl, tabs) {
  tabs.pdf = await openTab(`${baseUrl}/sample.pdf`);
  const viewerTarget = await waitForPage(viewerMatch(extId, '/sample.pdf'), {
    label: '标签页被替换为扩展阅读器',
    timeout: 20_000,
  });
  check('PDF 被本扩展阅读器接管', !!viewerTarget, decodeURIComponent(viewerTarget.url).slice(0, 92));
  check(
    '阅读器地址带上了原始 PDF 地址',
    decodeURIComponent(viewerTarget.url).includes('file=' + baseUrl + '/sample.pdf'),
  );

  await withSession(browser, viewerTarget.id, async (sid) => {
    watchSession(browser, sid);
    // 前台化：后台标签页不渲染（扩展安装时打开的设置页可能把焦点抢走）
    await browser.send('Page.bringToFront', {}, sid).catch(() => {});
    const ping = await evalIn(browser, sid, `chrome.runtime.sendMessage({ type: 'ping' })`).catch(() => null);
    if (ping?.ok) info(`后台自检：v${ping.version}，PDF 接管方式=${ping.takeoverMode}`);

    const pages = await pollEval(
      browser,
      sid,
      `({ pages: document.querySelectorAll('.page').length, count: document.getElementById('pageCount')?.textContent })`,
      (v) => v && v.pages >= 2 && v.count === '2',
      { label: '阅读器渲染出 2 页' },
    );
    check('阅读器完成渲染', pages.pages >= 2, `页元素 ${pages.pages} 个，总页数 ${pages.count}`);

    const textLayer = await pollEval(
      browser,
      sid,
      `(() => {
        const spans = [...document.querySelectorAll('.textLayer span')];
        return { spans: spans.length, text: spans.map((s) => s.textContent).join(' | ').slice(0, 120) };
      })()`,
      (v) => v && v.spans > 0 && v.text.toLowerCase().includes('hello'),
      { timeout: 15_000, label: 'PDF 文本层生成' },
    ).catch(() => ({ spans: 0, text: '' }));
    check(
      'PDF 文本层可用（可选中文字）',
      textLayer.spans > 0 && textLayer.text.toLowerCase().includes('hello'),
      `${textLayer.spans} 个文本块：${textLayer.text.slice(0, 56)}…`,
    );

    // 真实鼠标拖选（走完整事件链路，最能代表用户实际操作）
    const rect = await evalIn(browser, sid, WORD_RECT('hello'));
    if (!rect) {
      check('真实鼠标拖选 → 出现「译」按钮', false, '拿不到 hello 的坐标');
    } else {
      const y = rect.top + rect.height / 2;
      const x0 = rect.left + 2;
      const x1 = rect.left + rect.width - 2;
      const mouse = (type, x, buttons) =>
        browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 }, sid);
      await mouse('mousePressed', x0, 1);
      await mouse('mouseMoved', (x0 + x1) / 2, 1);
      await mouse('mouseMoved', x1, 1);
      await mouse('mouseReleased', x1, 0);
      const dragSelection = (await evalIn(browser, sid, `window.getSelection().toString()`)).trim();
      const afterDrag = await pollEval(browser, sid, BUBBLE_STATE, (s) => s.state === 'button' || s.state === 'card', {
        timeout: 6000,
        label: '真实拖选后出现「译」按钮',
      }).catch(() => null);
      check(
        '真实鼠标拖选 → 出现「译」按钮',
        !!afterDrag && dragSelection.toLowerCase().includes('hello'),
        `选中「${dragSelection}」，气泡状态 ${afterDrag?.state || '无'}`,
      );
    }

    const card = await translateFlow(browser, sid, { word: 'hello', prefix: 'PDF 内' });
    if (card) {
      check('释义带词性', (card.meanings || []).some((m) => /\./.test(m.pos)), (card.meanings || []).map((m) => m.pos).join(','));
      check('显示音标', /\/.+\//.test(card.phonetics || ''), card.phonetics || '无');
      check('标注使用的引擎', !!card.engine, card.engine || '无');
      if (card.examples?.length) info('例句：' + card.examples[0].slice(0, 68));
      info('截图: ' + (await screenshot(browser, sid, 'viewer-translate-card.png')));
    }

    // 翻页
    await evalIn(browser, sid, `document.getElementById('pageNext').click(), true`);
    const pageNo = await pollEval(browser, sid, `document.getElementById('pageNumber').value`, (v) => v === '2', {
      timeout: 6000,
      label: '翻到第 2 页',
    });
    check('翻页可用', pageNo === '2', '当前页码 ' + pageNo);

    // 缩略图侧栏
    await evalIn(browser, sid, `document.getElementById('sidebarToggle').click(), true`);
    const thumbs = await pollEval(
      browser,
      sid,
      `document.querySelectorAll('#thumbnails .thumb').length`,
      (n) => n >= 2,
      { timeout: 8000, label: '缩略图生成' },
    );
    check('缩略图侧栏可用', thumbs >= 2, thumbs + ' 个缩略图');
    info('截图: ' + (await screenshot(browser, sid, 'viewer-sidebar.png')));

    // 搜索
    await evalIn(browser, sid, `document.getElementById('findToggle').click(), true`);
    await evalIn(
      browser,
      sid,
      `(() => { const i = document.getElementById('findInput'); i.value = 'translation'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
    );
    const findCount = await pollEval(browser, sid, `document.getElementById('findCount').textContent`, (v) => /.+\/.+/.test(v || ''), {
      timeout: 10_000,
      label: '搜索结果计数',
    }).catch(() => '无');
    check('文档内搜索可用', /\d+\/\d+/.test(findCount), '匹配 ' + findCount);

    // 「用 Edge 打开」的逃生通道：切回原生阅读器后不能被我们又抢回来
    await evalIn(browser, sid, `document.getElementById('nativeBtn').click(), true`);
  });

  const backToNative = await waitForPage(
    (t) => t.type === 'page' && t.url === `${baseUrl}/sample.pdf`,
    { label: '切回 Edge 原生阅读器', timeout: 15_000 },
  ).catch((err) => ({ error: err.message }));
  check('“用 Edge 打开”能切回原生阅读器', !backToNative.error, backToNative.error || 'ok');
  await sleep(2500); // 观察 2.5 秒，确认没有被重新接管（bypass 生效）
  const stillNative = (await listTargets()).some((t) => t.url === `${baseUrl}/sample.pdf`);
  check('切回原生后不会被再次接管', stillNative, stillNative ? 'ok' : '又被抢回阅读器了');
}

async function scenario2ContentTypeFallback(browser, extId, baseUrl, tabs) {
  await closeTab(tabs.pdf?.id);
  tabs.route = await openTab(`${baseUrl}/pdfroute`);
  const viewer = await waitForPage(viewerMatch(extId, '/pdfroute'), {
    label: '响应头兜底接管',
    timeout: 20_000,
  }).catch((err) => ({ error: err.message }));
  check('没有 .pdf 后缀也能靠响应头接管', !viewer.error, viewer.error ? viewer.error : 'ok');
  await closeTab(tabs.route?.id);
}

async function scenario3WebPage(browser, baseUrl, tabs) {
  tabs.html = await openTab(`${baseUrl}/`);
  const target = await waitForPage((t) => t.id === tabs.html.id, { label: 'HTML 页面' });
  await withSession(browser, target.id, async (sid) => {
    watchSession(browser, sid);
    await browser.send('Page.bringToFront', {}, sid).catch(() => {});
    const card = await translateFlow(browser, sid, { word: 'hello', prefix: '网页上' });
    if (card) info('截图: ' + (await screenshot(browser, sid, 'webpage-translate-card.png')));
  });
  await closeTab(tabs.html?.id);
}

async function scenario4UiPages(browser, extId) {
  for (const [name, path, selector] of [
    ['设置页', 'options/options.html', '.card'],
    ['弹窗页', 'popup/popup.html', '.rows'],
  ]) {
    const tab = await openTab(`chrome-extension://${extId}/${path}`);
    const target = await waitForPage((t) => t.id === tab.id && t.url.includes(path), { label: name });
    const count = await withSession(browser, target.id, async (sid) => {
      watchSession(browser, sid);
      return pollEval(browser, sid, `document.querySelectorAll('${selector}').length`, (n) => n > 0, {
        timeout: 8000,
        label: name + ' 渲染',
      }).catch(() => 0);
    });
    check(`${name}可以正常打开`, count > 0, `${count} 个内容区块`);
    await closeTab(tab.id);
  }
}

function scenario5Health() {
  check('没有未捕获的 JS 异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
  if (consoleErrors.length) {
    info(`（参考）控制台告警 ${consoleErrors.length} 条：` + consoleErrors.slice(0, 3).join(' | '));
  }
}

/* ── 主流程 ─────────────────────────────────────────────────────── */
async function main() {
  console.log('\n=== PDF 划词翻译 · 端到端测试 ===\n');

  // 这些资源是被 .gitignore 忽略的构建产物，新克隆的仓库要先构建一次
  const required = [
    'vendor/pdfjs/build/pdf.min.mjs',
    'vendor/pdfjs/build/pdf.worker.min.mjs',
    'vendor/pdfjs/web/pdf_viewer.mjs',
    'icons/icon128.png',
  ];
  const missing = required.filter((p) => !existsSync(join(EXT_DIR, p)));
  if (missing.length) {
    console.error('✗ 扩展资源还没构建，请先执行：npm run build');
    for (const m of missing) console.error('    缺少 extension/' + m);
    process.exitCode = 1;
    return;
  }

  const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edgePath) throw new Error('没找到 msedge.exe');
  info('Edge: ' + edgePath);
  info('扩展目录: ' + EXT_DIR);

  const { server, url: baseUrl } = await startServer(0);
  info('测试服务器: ' + baseUrl);

  const profile = mkdtempSync(join(tmpdir(), 'pdft-e2e-'));
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=msEdgeFirstRunExperience,msEdgeSidebarV2',
    '--window-size=1280,900',
    'about:blank',
  ];
  if (!HEADED) args.unshift('--headless=new');
  info('启动 Edge（' + (HEADED ? '有界面' : 'headless=new') + '）…');

  const edge = spawn(edgePath, args, { stdio: 'ignore' });
  /** @type {Cdp | null} */
  let browser = null;
  const tabs = {};

  try {
    const version = await waitForDevTools();
    info('浏览器: ' + version.Browser);
    browser = await Cdp.connect(version.webSocketDebuggerUrl);

    // 扩展 ID 从 service worker target 拿
    let extId = '';
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !extId) {
      const targets = await listTargets().catch(() => []);
      const sw = targets.find((t) => t.url?.startsWith('chrome-extension://') && t.url.includes('service-worker.js'));
      if (sw) extId = new URL(sw.url).host;
      else await sleep(300);
    }
    check('扩展已加载（找到 service worker）', !!extId, extId || '未找到 chrome-extension:// target');
    if (!extId) throw new Error('扩展没装上，后续检查无法进行');

    // 盯着 service worker 的异常/日志：后台报错是前面排查中最容易被忽略的一环
    const swTarget = (await listTargets()).find((t) => t.url.includes('service-worker.js'));
    if (swTarget) {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: swTarget.id, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId).catch(() => {});
      watchSession(browser, sessionId);
      browser.on('Runtime.consoleAPICalled', (p, s) => {
        if (s === sessionId && p.type === 'info') {
          info('[后台] ' + (p.args || []).map((a) => a.value ?? a.description).join(' '));
        }
      });
    }

    await scenario('[1] 打开带 .pdf 后缀的地址', () => scenario1PdfTakeover(browser, extId, baseUrl, tabs));
    await scenario('[2] 打开没有 .pdf 后缀、但 Content-Type 是 PDF 的地址', () =>
      scenario2ContentTypeFallback(browser, extId, baseUrl, tabs),
    );
    await scenario('[3] 普通网页划词', () => scenario3WebPage(browser, baseUrl, tabs));
    await scenario('[4] 设置页与弹窗页', () => scenario4UiPages(browser, extId));
    await scenario('[5] 运行期健康检查', async () => scenario5Health());
  } finally {
    if (!KEEP_OPEN) {
      browser?.close();
      try {
        execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        edge.kill();
      }
      server.close();
      await sleep(600);
      rmSync(profile, { recursive: true, force: true });
    } else {
      info(`--keep-open：Edge 保持运行（调试端口 ${DEBUG_PORT}，配置目录 ${profile}）`);
      info('关闭方式：taskkill /IM msedge.exe /F');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    for (const f of failed) console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : ''));
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

main().catch((err) => {
  console.error('\n测试崩溃：', err?.stack || err);
  process.exitCode = 1;
});
