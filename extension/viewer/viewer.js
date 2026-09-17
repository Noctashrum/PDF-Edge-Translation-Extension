/**
 * viewer/viewer.js — 扩展自带的 PDF 阅读器（替代 Edge 内置阅读器）
 *
 * 为什么要自带阅读器：
 *   Edge 内置 PDF 阅读器是浏览器内部页面，扩展无法注入脚本、拿不到“选中的是哪个词”。
 *   只有把 PDF 交给 pdf.js 渲染到我们自己的页面里，文本层（textLayer）才在我们的 DOM 中，
 *   划词、选区、翻译气泡才成立。
 *
 * 依赖：pdfjs-dist 的 core（build/pdf.min.mjs）+ 组件包（web/pdf_viewer.mjs）。
 *   ⚠️ 组件包是 webpack 打的 bundle，启动时会 `const {...} = globalThis.pdfjsLib`，
 *      所以必须先把 core 挂到 globalThis.pdfjsLib，再动态 import 组件包。
 */

import * as pdfjsLib from '../vendor/pdfjs/build/pdf.min.mjs';

globalThis.pdfjsLib = pdfjsLib;
const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = await import(
  '../vendor/pdfjs/web/pdf_viewer.mjs'
);

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.min.mjs');

const CMAP_URL = chrome.runtime.getURL('vendor/pdfjs/cmaps/');
const STANDARD_FONTS_URL = chrome.runtime.getURL('vendor/pdfjs/standard_fonts/');
const WASM_URL = chrome.runtime.getURL('vendor/pdfjs/wasm/');
const ICC_URL = chrome.runtime.getURL('vendor/pdfjs/iccs/');
const IMAGES_URL = chrome.runtime.getURL('vendor/pdfjs/web/images/');

const ZOOM_PRESETS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const ZOOM_KEYWORDS = ['auto', 'page-width', 'page-fit', 'page-actual', 'page-height'];
const CUSTOM_ZOOM = '__custom';

const $ = (id) => document.getElementById(id);

/* ── 极简本地化（pdf.js 组件需要一个 l10n 对象；npm 包不含 locale 文件，自己实现）── */
const ZH = {
  loading: '加载中…',
  loading_error: '加载失败',
  invalid_file_error: '文件无效或已损坏',
  missing_file_error: '文件不存在',
  unexpected_response_error: '服务器返回异常',
  'thumb_page_title': '第 {{page}} 页',
  'thumb_page_canvas': '第 {{page}} 页缩略图',
  'find_match_count_limit[other]': '超过 {{limit}} 个结果',
};
const L10N = {
  async get(ids, args, fallback) {
    const id = Array.isArray(ids) ? ids[0] : ids;
    let text = ZH[String(id)] ?? (typeof fallback === 'string' ? fallback : String(id));
    for (const [k, v] of Object.entries(args || {})) text = text.replaceAll(`{{${k}}}`, String(v));
    return text;
  },
  getDirection: () => 'ltr',
  getLanguage: () => 'zh-CN',
  async translate(element) {
    return element;
  },
  async translateOnce(element) {
    return element;
  },
  async destroy() {},
  pause() {},
  resume() {},
};

/* ── 状态 ───────────────────────────────────────────────────────── */
const state = {
  target: '',
  fileName: 'document.pdf',
  pdfDocument: null,
  loadingTask: null,
  settings: {},
  generation: 0,
  savedPage: 0,
  thumbObserver: null,
  thumbChain: Promise.resolve(),
  saveTimer: null,
};

/* ── pdf.js 组件装配 ────────────────────────────────────────────── */
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
linkService.externalLinkTarget = LinkTarget.BLANK;
linkService.externalLinkRel = 'noopener noreferrer nofollow';

const findController = new PDFFindController({ eventBus, linkService });

const pdfViewer = new PDFViewer({
  container: $('viewerContainer'),
  viewer: $('viewer'),
  eventBus,
  linkService,
  findController,
  l10n: L10N,
  imageResourcesPath: IMAGES_URL,
  removePageBorders: false,
  enablePrintAutoRotate: true,
});
linkService.setViewer(pdfViewer);

/* ── URL 解析 ───────────────────────────────────────────────────── */
/**
 * 从 `?file=` 后面取出原始 PDF 地址。
 * 我们刻意不做百分号编码（service worker 直接拼原始 URL），所以这里按
 * “file= 之后的全部内容都是 URL” 解析，带 ?a=1&b=2 的地址也不会被拆坏。
 */
function readPdfTarget() {
  const search = location.search.startsWith('?') ? location.search.slice(1) : location.search;
  let value = '';
  const m = /(?:^|&)file=([\s\S]*)$/.exec(search);
  if (m) value = m[1];
  if (!value) return '';
  // 兼容被完整编码过的形式（?file=https%3A%2F%2F...）
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      /* 保持原样 */
    }
  }
  if (location.hash && /^#(page|zoom|nameddest)=/.test(location.hash)) value += location.hash;
  return value;
}

function fileNameOf(url) {
  try {
    const clean = url.split('#')[0].split('?')[0];
    const name = decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1));
    return name || 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

/* ── UI 小工具 ──────────────────────────────────────────────────── */
function toast(message, ms = 2200) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (node.hidden = true), ms);
}

function setProgress(ratio) {
  const bar = $('loadingProgress');
  if (ratio == null) {
    bar.style.width = '30%';
    return;
  }
  bar.style.width = Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
}

function showError(err) {
  const info = describeError(err);
  $('errTitle').textContent = info.title;
  $('errMsg').textContent = info.msg;
  $('errHint').textContent = info.hint || '';
  $('errorOverlay').hidden = false;
  $('loadingBar').style.visibility = 'hidden';
}

function hideError() {
  $('errorOverlay').hidden = true;
  $('loadingBar').style.visibility = 'visible';
}

function describeError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || err || '');
  const localHint = state.target.startsWith('file:')
    ? '\n本地文件需要在 edge://extensions 里为本扩展打开「允许访问文件 URL」。'
    : '';
  if (name === 'InvalidPDFException') {
    return {
      title: '这个地址不是有效的 PDF',
      msg: '文件可能已损坏、需要登录，或者它其实是一个网页。' + localHint,
      hint: '点“用 Edge 内置阅读器打开”可以直接看原始内容。',
    };
  }
  if (name === 'MissingPDFException') {
    return { title: '找不到这个 PDF', msg: '服务器返回 404 或文件不存在。' + localHint, hint: '' };
  }
  if (name === 'UnexpectedResponseException') {
    return {
      title: '服务器拒绝了读取请求',
      msg: `状态码：${err?.status ?? '未知'}。可能需要登录，或站点有防盗链限制。${localHint}`,
      hint: '改用 Edge 内置阅读器打开通常可以正常显示（但那种模式下无法划词翻译）。',
    };
  }
  if (name === 'PasswordException') {
    return { title: '这个 PDF 有密码', msg: '需要正确的密码才能打开。', hint: '' };
  }
  if (/Failed to fetch|NetworkError|ERR_|CORS/i.test(msg)) {
    return {
      title: '无法下载这个 PDF',
      msg: msg + localHint,
      hint: '如果是内网/需要登录的地址，请改用 Edge 内置阅读器打开。',
    };
  }
  return { title: '打不开这个 PDF', msg: msg || '未知错误', hint: localHint };
}

/* ── 加载文档 ───────────────────────────────────────────────────── */
async function loadDocument(target) {
  const gen = ++state.generation;
  hideError();
  setProgress(0);
  $('loadingBar').hidden = false;

  state.savedPage = await readSavedPage(target);
  state.fileName = fileNameOf(target);
  document.title = `${state.fileName} — PDF 划词翻译`;
  $('fileName').textContent = state.fileName;
  $('fileName').title = target;

  const task = pdfjsLib.getDocument({
    url: target,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
    wasmUrl: WASM_URL,
    iccUrl: ICC_URL,
    useWasm: true,
    useSystemFonts: true,
    withCredentials: true,
    enableXfa: true,
    docBaseUrl: target,
  });
  state.loadingTask = task;

  task.onProgress = ({ loaded, total }) => {
    if (gen !== state.generation) return;
    setProgress(total ? loaded / total : null);
  };
  task.onPassword = (updatePassword, reason) => {
    const first = reason === pdfjsLib.PasswordResponses.NEED_PASSWORD;
    const pw = window.prompt(first ? '这个 PDF 需要密码：' : '密码不对，请重新输入：');
    if (pw == null) {
      void task.destroy();
      showError({ name: 'PasswordException', message: '已取消输入密码' });
      return;
    }
    updatePassword(pw);
  };

  try {
    const pdfDocument = await task.promise;
    if (gen !== state.generation) {
      void pdfDocument.destroy();
      return;
    }
    state.pdfDocument = pdfDocument;
    $('docInfo').textContent = `${pdfDocument.numPages} 页 · 划词翻译已开启`;
    pdfViewer.setDocument(pdfDocument);
    linkService.setDocument(pdfDocument, null);
  } catch (err) {
    if (gen !== state.generation) return;
    console.warn('[PDF划词翻译] 加载失败', err);
    showError(err);
  }
}

/* ── 事件总线 ───────────────────────────────────────────────────── */
eventBus.on('pagesinit', () => {
  const total = state.pdfDocument?.numPages ?? 0;
  $('pageCount').textContent = String(total);
  $('loadingBar').hidden = true;
  applyInitialZoom();
  restorePosition();
  void buildThumbnails();
  void buildOutline();
  updatePageUi();
  $('viewerContainer').focus({ preventScroll: true });
});

eventBus.on('pagechanging', ({ pageNumber }) => {
  updatePageUi(pageNumber);
  markCurrentThumb(pageNumber);
  scheduleSavePage(pageNumber);
});

eventBus.on('scalechanging', () => updateZoomUi());

eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
  if (!matchesCount) return;
  const { current, total } = matchesCount;
  $('findCount').textContent = total ? `${current}/${total}` : '无结果';
});

eventBus.on('updatefindcontrolstate', ({ state: findState, matchesCount }) => {
  if (findState === 1 /* FindState.NOT_FOUND */) $('findCount').textContent = '无结果';
  else if (matchesCount?.total) $('findCount').textContent = `${matchesCount.current}/${matchesCount.total}`;
});

/* ── 缩放 / 翻页 / 旋转 ─────────────────────────────────────────── */
function applyInitialZoom() {
  const want = state.settings.defaultZoom || 'auto';
  try {
    if (ZOOM_KEYWORDS.includes(want)) pdfViewer.currentScaleValue = want;
    else pdfViewer.currentScale = Number(want) || 1;
  } catch {
    pdfViewer.currentScaleValue = 'auto';
  }
  updateZoomUi();
}

function setZoom(value) {
  const v = String(value);
  try {
    if (ZOOM_KEYWORDS.includes(v)) pdfViewer.currentScaleValue = v;
    else pdfViewer.currentScale = Number(v) || 1;
  } catch (err) {
    console.warn('[PDF划词翻译] 设置缩放失败', err);
  }
  updateZoomUi();
}

function zoomBy(direction) {
  const current = pdfViewer.currentScale;
  let next;
  if (direction > 0) next = ZOOM_PRESETS.find((p) => p > current + 1e-4) ?? ZOOM_PRESETS.at(-1);
  else next = [...ZOOM_PRESETS].reverse().find((p) => p < current - 1e-4) ?? ZOOM_PRESETS[0];
  pdfViewer.currentScale = next;
}

function updateZoomUi() {
  const select = $('zoomSelect');
  const raw = pdfViewer.currentScaleValue;
  const keyword = typeof raw === 'string' && Number.isNaN(Number(raw)) ? raw : '';
  if (keyword && ZOOM_KEYWORDS.includes(keyword)) {
    select.value = keyword;
    return;
  }
  const percent = Math.round(pdfViewer.currentScale * 100);
  let custom = select.querySelector(`option[value="${CUSTOM_ZOOM}"]`);
  if (!custom) {
    custom = document.createElement('option');
    custom.value = CUSTOM_ZOOM;
    select.append(custom);
  }
  custom.textContent = `${percent}%`;
  select.value = CUSTOM_ZOOM;
}

function updatePageUi(pageNumber = pdfViewer.currentPageNumber) {
  const input = $('pageNumber');
  if (document.activeElement !== input) input.value = String(pageNumber || 1);
}

function goToPage(page) {
  const total = state.pdfDocument?.numPages ?? 0;
  const n = Math.min(Math.max(1, Number(page) || 1), Math.max(1, total));
  pdfViewer.currentPageNumber = n;
}

/* ── 阅读位置记忆 ───────────────────────────────────────────────── */
function posKey(url) {
  return 'pos:' + url.split('#')[0];
}

async function readSavedPage(url) {
  if (state.settings.rememberPosition === false) return 0;
  try {
    const key = posKey(url);
    const got = await chrome.storage.local.get(key);
    const n = Number(got?.[key]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function scheduleSavePage(pageNumber) {
  if (state.settings.rememberPosition === false) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    void chrome.storage.local.set({ [posKey(state.target)]: pageNumber });
  }, 500);
  history.replaceState(null, '', `#page=${pageNumber}`);
}

function restorePosition() {
  const hashPage = /#page=(\d+)/.exec(location.hash)?.[1];
  const page = Number(hashPage) || state.savedPage || 0;
  if (page > 0) goToPage(page);
}

/* ── 缩略图 ─────────────────────────────────────────────────────── */
async function buildThumbnails() {
  const host = $('thumbnails');
  host.textContent = '';
  const doc = state.pdfDocument;
  if (!doc) return;
  const gen = state.generation;

  state.thumbObserver?.disconnect();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        state.thumbChain = state.thumbChain.then(() => renderThumb(entry.target, gen)).catch(() => {});
      }
    },
    { root: host, rootMargin: '240px 0px' },
  );
  state.thumbObserver = observer;

  for (let i = 1; i <= doc.numPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb';
    item.dataset.page = String(i);
    const wrap = document.createElement('div');
    wrap.className = 'thumb-canvas-wrap';
    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = String(i);
    item.append(wrap, label);
    item.addEventListener('click', () => goToPage(i));
    host.append(item);
    observer.observe(item);
  }
  markCurrentThumb(pdfViewer.currentPageNumber);
}

async function renderThumb(item, gen) {
  const doc = state.pdfDocument;
  if (!doc || gen !== state.generation) return;
  const wrap = item.querySelector('.thumb-canvas-wrap');
  if (!wrap || wrap.querySelector('canvas')) return;
  const pageNo = Number(item.dataset.page);
  const page = await doc.getPage(pageNo);
  if (gen !== state.generation) return;

  const base = page.getViewport({ scale: 1 });
  const targetWidth = Math.max(80, wrap.clientWidth || 150);
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';
  wrap.append(canvas);

  try {
    await page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    }).promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('[PDF划词翻译] 缩略图渲染失败', err);
  }
}

function markCurrentThumb(pageNumber) {
  const host = $('thumbnails');
  if (!host) return;
  host.querySelector('.thumb.is-current')?.classList.remove('is-current');
  const current = host.querySelector(`.thumb[data-page="${pageNumber}"]`);
  if (current) {
    current.classList.add('is-current');
    if (!$('sidebar').hidden) {
      const box = host.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (item.top < box.top || item.bottom > box.bottom) current.scrollIntoView({ block: 'nearest' });
    }
  }
}

/* ── 大纲 ───────────────────────────────────────────────────────── */
async function buildOutline() {
  const host = $('outline');
  host.textContent = '';
  const doc = state.pdfDocument;
  if (!doc) return;
  let items = null;
  try {
    items = await doc.getOutline();
  } catch {
    items = null;
  }
  if (!items?.length) {
    const empty = document.createElement('div');
    empty.className = 'side-empty';
    empty.textContent = '这份 PDF 没有书签目录';
    host.append(empty);
    return;
  }
  host.append(renderOutlineItems(items));
}

function renderOutlineItems(items) {
  const ul = document.createElement('ul');
  ul.className = 'outline-list';
  for (const item of items) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'outline-item';
    link.href = '#';
    link.textContent = item.title || '(无标题)';
    link.title = item.title || '';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      try {
        if (item.dest) linkService.goToDestination(item.dest);
        else if (typeof item.url === 'string') window.open(item.url, '_blank', 'noopener');
        else if (item.url) linkService.goToDestination(item.url);
      } catch (err) {
        console.warn('[PDF划词翻译] 跳转目录失败', err);
      }
    });
    li.append(link);
    if (item.items?.length) li.append(renderOutlineItems(item.items));
    ul.append(li);
  }
  return ul;
}

/* ── 侧栏 ───────────────────────────────────────────────────────── */
function toggleSidebar(force) {
  const open = force ?? $('sidebar').hidden;
  $('sidebar').hidden = !open;
  $('outerContainer').classList.toggle('sidebarOpen', open);
  $('sidebarToggle').setAttribute('aria-pressed', String(open));
  $('sidebarToggle').classList.toggle('is-active', open);
}

function switchSideTab(which) {
  const isThumbs = which === 'thumbs';
  $('tabThumbs').classList.toggle('is-active', isThumbs);
  $('tabOutline').classList.toggle('is-active', !isThumbs);
  $('thumbnails').hidden = !isThumbs;
  $('outline').hidden = isThumbs;
}

/* ── 查找 ───────────────────────────────────────────────────────── */
function dispatchFind(type, findPrevious = false) {
  eventBus.dispatch('find', {
    source: null,
    type,
    query: $('findInput').value,
    caseSensitive: $('findCase').checked,
    entireWord: $('findWord').checked,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
    phraseSearch: true,
  });
}

function openFind() {
  $('findbar').hidden = false;
  const input = $('findInput');
  input.focus();
  input.select();
}

function closeFind() {
  $('findbar').hidden = true;
  $('findCount').textContent = '';
  eventBus.dispatch('findbarclose', { source: null });
  eventBus.dispatch('find', {
    source: null,
    type: 'findbarclose',
    query: '',
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    matchDiacritics: false,
    phraseSearch: true,
  });
}

/* ── 下载 / 打印 / 原生打开 ─────────────────────────────────────── */
async function downloadPdf() {
  try {
    const data = await state.pdfDocument.getData();
    const blob = new Blob([data], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.fileName || 'document.pdf';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    toast('下载失败：' + (err?.message || err));
  }
}

async function openNative() {
  try {
    await chrome.runtime.sendMessage({ type: 'openNative', url: state.target });
  } catch (err) {
    toast('打开失败：' + (err?.message || err));
  }
}

/* ── 划词翻译 ───────────────────────────────────────────────────── */
let bubble = null;

async function setupTranslate() {
  const Bubble = globalThis.PDFT_BUBBLE?.TranslateBubble;
  if (!Bubble) {
    console.warn('[PDF划词翻译] 气泡组件未加载');
    return;
  }
  bubble = new Bubble({
    onLookup: (text) => chrome.runtime.sendMessage({ type: 'translate', text }),
    loadSettings: async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'getSettings' });
      return reply?.settings;
    },
  });
  await bubble.init();
  bubble.attach();
  state.settings = { ...state.settings, ...(bubble.settings || {}) };

  // 双击直接翻译（可选）
  $('viewerContainer').addEventListener('dblclick', () => {
    if (state.settings.translateOnDoubleClick) bubble.translateCurrentSelection();
  });

  // 快捷键 / 右键菜单由 service worker 转发过来
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'translateCurrentSelection') {
      if (!bubble.translateCurrentSelection()) toast('请先用鼠标选中要翻译的文字');
    }
  });
}

/* ── 设置同步 ───────────────────────────────────────────────────── */
const SETTING_KEYS = [
  'enabled',
  'engine',
  'targetLang',
  'translateOnSelect',
  'translateOnDoubleClick',
  'showExamples',
  'showPhonetic',
  'maxSelectionLength',
  'viewerTheme',
  'rememberPosition',
  'defaultZoom',
];

function applyTheme() {
  const theme = state.settings.viewerTheme;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

async function loadSettings() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'getSettings' });
    state.settings = { ...state.settings, ...(reply?.settings || {}) };
  } catch {
    /* 用默认值 */
  }
  applyTheme();
  bubble?.updateSettings(state.settings);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' && area !== 'local') return;
  if (!Object.keys(changes).some((k) => SETTING_KEYS.includes(k))) return;
  void loadSettings();
});

/* ── 工具栏与键盘 ───────────────────────────────────────────────── */
function wireToolbar() {
  $('sidebarToggle').addEventListener('click', () => toggleSidebar());
  $('tabThumbs').addEventListener('click', () => switchSideTab('thumbs'));
  $('tabOutline').addEventListener('click', () => switchSideTab('outline'));

  $('pagePrev').addEventListener('click', () => pdfViewer.currentPageNumber--);
  $('pageNext').addEventListener('click', () => pdfViewer.currentPageNumber++);
  $('pageNumber').addEventListener('change', (event) => {
    goToPage(event.target.value);
    event.target.blur();
  });
  $('pageNumber').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.target.blur();
  });

  $('zoomIn').addEventListener('click', () => zoomBy(1));
  $('zoomOut').addEventListener('click', () => zoomBy(-1));
  $('zoomSelect').addEventListener('change', (event) => {
    if (event.target.value === CUSTOM_ZOOM) return;
    setZoom(event.target.value);
  });
  $('rotate').addEventListener('click', () => {
    pdfViewer.pagesRotation = (pdfViewer.pagesRotation + 90) % 360;
  });

  $('findToggle').addEventListener('click', () => ($('findbar').hidden ? openFind() : closeFind()));
  $('findClose').addEventListener('click', closeFind);
  $('findPrev').addEventListener('click', () => dispatchFind('again', true));
  $('findNext').addEventListener('click', () => dispatchFind('again', false));
  $('findInput').addEventListener('input', () => dispatchFind(''));
  $('findInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') dispatchFind('again', event.shiftKey);
    else if (event.key === 'Escape') closeFind();
  });
  $('findCase').addEventListener('change', () => dispatchFind(''));
  $('findWord').addEventListener('change', () => dispatchFind(''));

  $('downloadBtn').addEventListener('click', () => void downloadPdf());
  $('printBtn').addEventListener('click', () => window.print());
  $('nativeBtn').addEventListener('click', () => void openNative());
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('errNative').addEventListener('click', () => void openNative());
  $('errRetry').addEventListener('click', () => void loadDocument(state.target));

  // Ctrl + 滚轮缩放（pdf.js 组件不含这层交互，得自己加）
  $('viewerContainer').addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'f') {
      event.preventDefault();
      openFind();
    } else if (mod && (event.key === '=' || event.key === '+')) {
      event.preventDefault();
      zoomBy(1);
    } else if (mod && event.key === '-') {
      event.preventDefault();
      zoomBy(-1);
    } else if (mod && event.key === '0') {
      event.preventDefault();
      setZoom('auto');
    } else if (mod && key === 'b') {
      event.preventDefault();
      toggleSidebar();
    } else if (mod && key === 's') {
      event.preventDefault();
      void downloadPdf();
    } else if (event.key === 'Escape' && !$('findbar').hidden) {
      closeFind();
    } else if (event.key === 'F3') {
      event.preventDefault();
      dispatchFind('again', event.shiftKey);
    }
  });
}

/* ── 启动 ───────────────────────────────────────────────────────── */
async function main() {
  wireToolbar();
  await loadSettings();
  await setupTranslate();

  state.target = readPdfTarget();
  if (!state.target) {
    showError({
      name: 'InvalidPDFException',
      message: '没有在地址里找到 PDF 文件（缺少 ?file= 参数）。',
    });
    return;
  }
  await loadDocument(state.target);

  // 首次进入给一个提示，几秒后淡出
  setTimeout(() => $('hint')?.classList.add('is-gone'), 9000);
}

void main();
