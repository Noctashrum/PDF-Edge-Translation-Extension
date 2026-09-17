/**
 * shared/settings.js — 设置读写（MV3 service worker / 阅读器页 / 弹窗 / 设置页共用）
 *
 * 设置存 chrome.storage.sync（跨设备漫游），失败时退回 local。
 */

export const DEFAULT_SETTINGS = {
  /** 总开关：关掉后划词气泡、PDF 接管全部停用 */
  enabled: true,
  /** 自动用本扩展的阅读器接管 PDF（关掉则 PDF 仍由 Edge 内置阅读器打开） */
  interceptPdf: true,
  /** 普通网页上也支持划词翻译 */
  enableOnWebPages: true,
  /** 翻译引擎：youdao | google | mymemory */
  engine: 'youdao',
  /** 目标语言 */
  targetLang: 'zh-CN',
  /** 选中即翻译（不点按钮）——默认关闭 */
  translateOnSelect: false,
  /** 双击单词直接翻译 */
  translateOnDoubleClick: false,
  /** 气泡里显示双语例句 */
  showExamples: true,
  /** 气泡里显示音标 + 发音按钮 */
  showPhonetic: true,
  /** 选区超过这个长度就按“整句翻译”处理 */
  maxSelectionLength: 600,
  /** 阅读器主题：system | light | dark */
  viewerTheme: 'system',
  /** 记住每份 PDF 的阅读位置 */
  rememberPosition: true,
  /** 阅读器默认缩放：auto | page-width | page-fit | page-actual 或数字 */
  defaultZoom: 'auto',
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

function area() {
  return chrome.storage?.sync ?? chrome.storage.local;
}

/** 读取全部设置（缺字段用默认值补齐） */
export async function loadSettings() {
  try {
    const got = await area().get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...got };
  } catch {
    const got = await chrome.storage.local.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...got };
  }
}

/** 局部更新设置 */
export async function saveSettings(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (SETTING_KEYS.includes(k)) clean[k] = v;
  }
  if (!Object.keys(clean).length) return loadSettings();
  try {
    await area().set(clean);
  } catch {
    await chrome.storage.local.set(clean);
  }
  return loadSettings();
}

/** 复位 */
export async function resetSettings() {
  return saveSettings({ ...DEFAULT_SETTINGS });
}

/**
 * 监听设置变化。handler(settings, changedKeys)
 * 返回取消监听的函数。
 */
export function onSettingsChanged(handler) {
  const listener = (changes, areaName) => {
    if (areaName !== 'sync' && areaName !== 'local') return;
    const keys = Object.keys(changes).filter((k) => SETTING_KEYS.includes(k));
    if (!keys.length) return;
    loadSettings().then((s) => handler(s, keys));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
