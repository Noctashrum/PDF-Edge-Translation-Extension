/**
 * content/selection-translate.js — 普通网页上的划词翻译
 *
 * 说明：这个脚本只负责“把气泡装到页面里 + 上报选中的文字”。
 * 真正的翻译请求走 service worker（扩展进程不受页面 CORS/CSP 限制）。
 * 依赖：manifest 里先加载的 shared/bubble.js（提供 globalThis.PDFT_BUBBLE）。
 */
(function () {
  'use strict';

  const Bubble = globalThis.PDFT_BUBBLE?.TranslateBubble;
  if (!Bubble) {
    console.warn('[PDF划词翻译] 气泡组件未加载，跳过');
    return;
  }

  const WATCHED_KEYS = [
    'enabled',
    'enableOnWebPages',
    'engine',
    'targetLang',
    'translateOnSelect',
    'translateOnDoubleClick',
    'showExamples',
    'showPhonetic',
    'maxSelectionLength',
    'viewerTheme',
  ];

  let bubble = null;
  let listenersBound = false;

  async function fetchSettings() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'getSettings' });
      return reply?.settings || {};
    } catch {
      return {}; // 扩展刚更新/被禁用时 sendMessage 会失败，静默降级
    }
  }

  function fakeRect() {
    return {
      left: Math.max(12, window.innerWidth / 2 - 80),
      top: Math.max(12, window.innerHeight * 0.12),
      bottom: Math.max(36, window.innerHeight * 0.12 + 24),
      width: 160,
      height: 24,
    };
  }

  async function init() {
    const settings = await fetchSettings();
    if (settings.enabled === false || settings.enableOnWebPages === false) return;

    bubble = new Bubble({
      onLookup: (text) => chrome.runtime.sendMessage({ type: 'translate', text }),
      loadSettings: async () => settings,
    });
    await bubble.init();
    bubble.attach();

    if (listenersBound) return; // 重新启用时不要再挂一遍监听
    listenersBound = true;

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'translateCurrentSelection') return;
      const live = String(window.getSelection?.()?.toString() || '').trim();
      if (!live && msg.text) {
        bubble.translate(String(msg.text).trim(), fakeRect());
        return;
      }
      bubble.translateCurrentSelection();
    });

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'sync' && area !== 'local') return;
      if (!Object.keys(changes).some((k) => WATCHED_KEYS.includes(k))) return;
      const next = await fetchSettings();
      const wasAllowed = bubble.settings?.enabled !== false && bubble.settings?.enableOnWebPages !== false;
      const nowAllowed = next.enabled !== false && next.enableOnWebPages !== false;
      bubble.updateSettings(next);
      if (wasAllowed && !nowAllowed) {
        bubble.hideButton();
        bubble.hideCard();
        bubble.destroy();
        bubble = null;
      } else if (!wasAllowed && nowAllowed && !bubble) {
        void init();
      }
    });
  }

  void init();
})();
