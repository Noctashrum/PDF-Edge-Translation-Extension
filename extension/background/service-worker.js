/**
 * background/service-worker.js — MV3 后台（ES module）
 *
 * 职责：
 *   1) 拦截 PDF 导航，把标签页换成本扩展自带的阅读器（viewer/viewer.html）——
 *      只有 PDF 渲染在我们自己的页面里，文本层才在我们的 DOM 中，划词才拿得到“选中的是哪个词”。
 *      · 第一跳（快）：webRequest.onBeforeRequest，地址以 .pdf 结尾时请求还没发出去就换页，几乎无闪烁；
 *      · 第二跳（全）：webRequest.onHeadersReceived，看 Content-Type: application/pdf，
 *        覆盖 arxiv.org/pdf/2401.12345 这类不带 .pdf 后缀的地址。
 *      备注：最初想用 declarativeNetRequest 的 redirect + regexSubstitution 做重定向，
 *      实测 Chromium 不支持 extensionPath 配合 regexSubstitution（`\0` 会原样留在地址里、
 *      拿不到原始 URL），因此弃用 DNR，改用上面两条 webRequest 判断。
 *   2) 代所有页面做翻译请求（扩展进程不受页面 CORS 限制，dict.youdao.com 不返回 CORS 头也能取），带本地缓存。
 *   3) 右键菜单 / 快捷键 / 弹窗 / 设置页的消息入口。
 */

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings.js';
import { lookup, ENGINE_IDS, normalizeQuery } from '../shared/providers.js';
import { cacheGet, cachePut, cacheClear, cacheStats } from '../shared/cache.js';

const VIEWER_PATH = 'viewer/viewer.html';
const MENU_SELECTION = 'pdft-translate-selection';
const MENU_OPEN_PDF = 'pdft-open-in-viewer';
const BYPASS_KEY = 'bypassUrls';
const EMBEDDED_KEY = 'embeddedPdfs';
/** 用户点过「用 Edge 打开」的地址，半小时内不再打扰（浏览器重启即清空） */
const BYPASS_TTL = 30 * 60_000;
const PDF_URL_RE = /\.pdf([?#].*)?$/i;
const CONTENT_TYPE_PDF_RE = /^\s*application\/(x-)?pdf\b/i;
const MAX_TAKEOVER_ATTEMPTS = 4;

/** 同一个标签页最近一次的接管尝试，用来去重 + 允许失败后重试 */
const takeovers = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let settings = { ...DEFAULT_SETTINGS };

const settingsReady = loadSettings()
  .then((s) => {
    settings = s;
  })
  .catch((err) => console.warn('[PDF划词翻译] 初始化设置失败', err));

/**
 * 启动补扫：把「还停在 .pdf 地址上、没被接管」的标签页补一次接管。
 *
 * 为什么需要：service worker 冷启动的那一瞬间监听器还没注册好，
 * 恰好落在这个窗口里的导航（首次安装、浏览器启动时批量恢复标签页）事件会丢，
 * 表现就是 PDF 时好时坏地仍由 Edge 原生阅读器打开。补扫几秒内兜住这种情况。
 */
async function sweepPdfTabs(reason) {
  if (!settings.enabled || !settings.interceptPdf) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    const url = tab.url || '';
    if (!tab.id || !url || !PDF_URL_RE.test(url)) continue;
    if (url.startsWith(chrome.runtime.getURL(''))) continue;
    console.info(`[PDF划词翻译] 补扫（${reason}）发现未接管的 PDF：`, url);
    void takeoverTab(tab.id, url);
  }
}

void settingsReady.then(() => {
  void sweepPdfTabs('启动');
  // 冷启动窗口可能刚好盖住这次导航，稍后再补两次
  setTimeout(() => void sweepPdfTabs('启动+1.5s'), 1500);
  setTimeout(() => void sweepPdfTabs('启动+4s'), 4000);
});

/* ── 监听器必须同步注册（MV3 事件唤醒要求）─────────────────────────── */

chrome.runtime.onInstalled.addListener((details) => {
  ensureContextMenus();
  void settingsReady.then(() => sweepPdfTabs('安装后'));
  if (details.reason === 'install') {
    // 首次安装时打开设置页做一次说明
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenus();
  void settingsReady.then(() => sweepPdfTabs('浏览器启动'));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' && area !== 'local') return;
  if (!Object.keys(changes).some((k) => k in DEFAULT_SETTINGS)) return;
  void loadSettings().then((s) => {
    settings = s;
  });
});

// 第一跳：地址本身就是 .pdf → 请求发出前就换标签页
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (!settings.enabled || !settings.interceptPdf) return;
      if (details.tabId < 0 || details.type !== 'main_frame') return;
      if (!PDF_URL_RE.test(details.url)) return;
      void takeoverTab(details.tabId, details.url);
    } catch (err) {
      console.warn('[PDF划词翻译] onBeforeRequest 处理失败', err);
    }
  },
  { urls: ['<all_urls>'] },
);

// 第二跳：地址里没有 .pdf（如 arxiv.org/pdf/2401.12345），靠响应头 Content-Type 判断
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      if (details.tabId < 0) return;
      const isPdf = CONTENT_TYPE_PDF_RE.test(headerValue(details.responseHeaders, 'content-type') || '');
      if (!isPdf) return;
      if (details.type === 'main_frame') {
        if (!settings.enabled || !settings.interceptPdf) return;
        void takeoverTab(details.tabId, details.url);
      } else if (details.type === 'sub_frame') {
        // 页面里内嵌的 PDF 不强拆（会破坏正常浏览），只记下来给弹窗一键打开
        void rememberEmbedded(details.tabId, details.url);
      }
    } catch (err) {
      console.warn('[PDF划词翻译] 处理响应头失败', err);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  takeovers.delete(tabId);
  void forgetTab(tabId);
});

/**
 * 第三道保险：万一根据请求/响应头的时机被错过（例如扩展刚被重新加载、
 * 或者标签页是从上次会话恢复出来的），标签页地址还停在 .pdf 上就补一次接管。
 * 接管成功后地址会变成 chrome-extension://…，因此不会反复触发。
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    if (!settings.enabled || !settings.interceptPdf) return;
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    const url = changeInfo.url || tab?.url || '';
    if (!url || !PDF_URL_RE.test(url)) return;
    if (url.startsWith(chrome.runtime.getURL(''))) return;
    void takeoverTab(tabId, url);
  } catch (err) {
    console.warn('[PDF划词翻译] onUpdated 处理失败', err);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true; // 异步响应
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_SELECTION) {
    void askContentScript(tab.id, { type: 'translateCurrentSelection', text: info.selectionText || '' });
  } else if (info.menuItemId === MENU_OPEN_PDF && info.linkUrl) {
    void openInViewer(tab.id, info.linkUrl);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) void askContentScript(tab.id, { type: 'translateCurrentSelection' });
});

/* ── PDF 接管 ──────────────────────────────────────────────────────── */

function viewerUrlFor(target) {
  // 直接拼接原始 URL（不做百分号编码），阅读器端按“file= 之后的全部内容”解析，
  // 这样带 ?a=1&b=2 的地址也不会被拆坏。
  return chrome.runtime.getURL(VIEWER_PATH) + '?file=' + target;
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const hit = headers.find((h) => String(h?.name || '').toLowerCase() === name);
  return hit?.value || '';
}

/**
 * 把标签页切到自带阅读器。
 *
 * 坑：标签页刚创建时第一次导航还在途中，此时 tabs.update 可能被原来那次导航覆盖掉，
 * 结果地址仍停在 .pdf 上（表现为“时好时坏”）。所以这里 update 之后要**校验是否真的生效**，
 * 没生效就隔 700ms 再试，最多 4 次。
 */
async function takeoverTab(tabId, url, attempt = 1) {
  if (!url || url.startsWith(chrome.runtime.getURL(''))) return;

  const previous = takeovers.get(tabId);
  if (attempt === 1) {
    // onBeforeRequest / onHeadersReceived / onUpdated 可能几乎同时触发，去重一下
    if (previous && previous.url === url && Date.now() - previous.t < 600) return;
    takeovers.set(tabId, { url, t: Date.now() });
    setTimeout(() => {
      const cur = takeovers.get(tabId);
      if (cur && cur.url === url && Date.now() - cur.t >= 600) takeovers.delete(tabId);
    }, 10_000);
  }

  try {
  if (await isBypassed(url)) return; // 用户主动要求用 Edge 原生阅读器打开过这个地址
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url?.startsWith(chrome.runtime.getURL(''))) return; // 已经在阅读器里了
    await chrome.tabs.update(tabId, { url: viewerUrlFor(url) });
  } catch (err) {
    console.warn('[PDF划词翻译] 接管 PDF 失败', err);
    return;
  }

  await sleep(700);
  const after = await chrome.tabs.get(tabId).catch(() => null);
  if (!after) return;
  if (after.url.startsWith(chrome.runtime.getURL(''))) {
    console.info('[PDF划词翻译] 已接管 PDF:', url);
    return;
  }
  if (attempt < MAX_TAKEOVER_ATTEMPTS) {
    takeovers.set(tabId, { url, t: Date.now() });
    return takeoverTab(tabId, url, attempt + 1);
  }
  console.warn('[PDF划词翻译] 接管未生效（可能被原导航覆盖），已放弃：', after.url);
}

/* ── 会话级状态：bypass 与内嵌 PDF 记录 ───────────────────────────── */

async function readSession(key) {
  try {
    const got = await chrome.storage.session.get(key);
    const v = got?.[key];
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function writeSession(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch {
    /* 忽略 */
  }
}

/**
 * 用户点“用 Edge 打开”后，把这个地址记下来别再抢 —— 按 URL 记而不是按标签页：
 * 同一次导航会触发好几个事件、启动补扫还会在几秒后再来看一次，
 * 按标签页记会被第一个事件“用掉”，结果几秒后又被抢回阅读器。
 */
async function setBypass(url) {
  if (!url) return;
  const map = await readSession(BYPASS_KEY);
  const now = Date.now();
  for (const [k, v] of Object.entries(map)) if (!v || now - v > BYPASS_TTL) delete map[k];
  map[url] = now;
  await writeSession(BYPASS_KEY, map);
}

async function isBypassed(url) {
  if (!url) return false;
  const map = await readSession(BYPASS_KEY);
  const t = map[url];
  return typeof t === 'number' && Date.now() - t <= BYPASS_TTL;
}

/** 用户又主动要求用本扩展打开时，撤销之前的放行 */
async function clearBypass(url) {
  if (!url) return;
  const map = await readSession(BYPASS_KEY);
  if (map[url] != null) {
    delete map[url];
    await writeSession(BYPASS_KEY, map);
  }
}

async function rememberEmbedded(tabId, url) {
  const map = await readSession(EMBEDDED_KEY);
  map[tabId] = { url, t: Date.now() };
  await writeSession(EMBEDDED_KEY, map);
}

async function forgetTab(tabId) {
  const [bypass, embedded] = await Promise.all([readSession(BYPASS_KEY), readSession(EMBEDDED_KEY)]);
  const now = Date.now();
  for (const [k, v] of Object.entries(bypass)) if (!v || now - v > BYPASS_TTL) delete bypass[k];
  const hadEmbedded = Boolean(embedded[tabId]);
  if (hadEmbedded) delete embedded[tabId];
  await Promise.all([writeSession(BYPASS_KEY, bypass), hadEmbedded ? writeSession(EMBEDDED_KEY, embedded) : null]);
}

/* ── 消息处理 ──────────────────────────────────────────────────────── */

async function handleMessage(msg, sender) {
  await settingsReady;
  switch (msg?.type) {
    case 'ping':
      return { ok: true, version: chrome.runtime.getManifest().version, takeoverMode: 'url+content-type' };

    case 'getSettings':
      return { ok: true, settings: { ...settings } };

    case 'setSettings':
      settings = await saveSettings(msg.patch || {});
      return { ok: true, settings };

    case 'translate':
      return doTranslate(msg);

    case 'cacheStats':
      return { ok: true, ...(await cacheStats()) };

    case 'clearCache':
      await cacheClear();
      return { ok: true };

    case 'openNative':
      return openNative(sender, msg.url);

    case 'openInViewer':
      return openInViewer(msg.tabId ?? sender?.tab?.id, msg.url);

    case 'getTabState':
      return getTabState(msg.tabId ?? sender?.tab?.id);

    default:
      return { ok: false, error: '未知消息类型：' + String(msg?.type) };
  }
}

async function doTranslate(msg) {
  const text = normalizeQuery(msg?.text);
  if (!text) return { ok: false, error: '没有选中任何文字' };
  const engine = ENGINE_IDS.includes(msg?.engine) ? msg.engine : settings.engine;
  const targetLang = msg?.targetLang || settings.targetLang || 'zh-CN';
  const key = `${engine}|${targetLang}|${text.toLowerCase()}`;

  const hit = await cacheGet(key);
  if (hit) return { ok: true, result: { ...hit, cached: true } };

  const result = await lookup(text, { engine, targetLang, timeoutMs: 9000 });
  void cachePut(key, result);
  return { ok: true, result: { ...result, cached: false } };
}

async function openNative(sender, url) {
  const tabId = sender?.tab?.id;
  const target = url || sender?.tab?.url;
  if (!target) return { ok: false, error: '拿不到原始地址' };
  if (tabId == null) {
    await chrome.tabs.create({ url: target });
    return { ok: true };
  }
  await setBypass(target);
  await chrome.tabs.update(tabId, { url: target });
  return { ok: true };
}

async function openInViewer(tabId, url) {
  const target = url || (tabId != null ? (await chrome.tabs.get(tabId).catch(() => null))?.url : null);
  if (!target) return { ok: false, error: '当前标签页没有可打开的地址' };
  await clearBypass(target); // 用户这次明确要用本扩展打开
  if (tabId == null) {
    await chrome.tabs.create({ url: viewerUrlFor(target) });
    return { ok: true };
  }
  await chrome.tabs.update(tabId, { url: viewerUrlFor(target) });
  return { ok: true };
}

/** 弹窗用：当前标签页是不是 PDF / 里面有没有内嵌 PDF */
async function getTabState(tabId) {
  if (tabId == null) return { ok: false, error: '缺少 tabId' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: '标签页不存在' };
  const url = tab.url || '';
  const embedded = (await readSession(EMBEDDED_KEY))[tabId]?.url || '';
  return {
    ok: true,
    url,
    isViewer: url.startsWith(chrome.runtime.getURL('')),
    looksLikePdf: PDF_URL_RE.test(url),
    embeddedPdf: embedded,
    takeoverMode: 'url+content-type',
  };
}

/* ── 右键菜单 / 与内容脚本通信 ─────────────────────────────────────── */

function ensureContextMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      { id: MENU_SELECTION, title: '翻译选中的文字', contexts: ['selection'] },
      () => void chrome.runtime.lastError,
    );
    chrome.contextMenus.create(
      {
        id: MENU_OPEN_PDF,
        title: '在划词翻译器中打开这个 PDF',
        contexts: ['link'],
        targetUrlPatterns: ['*://*/*.pdf*'],
      },
      () => void chrome.runtime.lastError,
    );
  });
}

async function askContentScript(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 页面没有内容脚本（比如 Edge 内置 PDF 阅读器、edge:// 页面）——无声忽略
  }
}
