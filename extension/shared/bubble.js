/**
 * shared/bubble.js — 划词翻译气泡（普通脚本，非 ES module）
 *
 * 用途：选中文字 → 出现「译」按钮 → 点一下 → 弹出中文释义卡片。
 * 同一份代码同时服务于两个场景：
 *   1) 普通网页（content script 隔离世界，见 content/selection-translate.js）
 *   2) 本扩展的 PDF 阅读器页（viewer/viewer.html 里用 <script src> 直接引入）
 *
 * 实现要点：
 *   - 挂在 Shadow DOM 里，页面样式无法污染，也无法被页面 reset 掉；
 *   - 所有结果文本一律用 DOM API 写入（textContent），不拼 innerHTML，避免词典内容注入；
 *   - 网络请求由外部注入的 onLookup 完成（走 service worker，绕开页面 CORS/CSP）。
 */
(function () {
  'use strict';

  const HOST_TAG = 'pdft-bubble-host';

  const CSS = `
  :host {
    all: initial;
    position: fixed;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    z-index: 2147483600;
    color-scheme: light dark;
  }
  * { box-sizing: border-box; }

  .pdft-layer {
    position: fixed;
    inset: 0 auto auto 0;
    width: 0;
    height: 0;
    font: 400 13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: var(--fg);
    --bg: #ffffff;
    --fg: #1f2328;
    --fg-dim: #6b7280;
    --line: #e5e7eb;
    --accent: #2563eb;
    --accent-soft: #eff4ff;
    --chip: #f1f3f5;
    --shadow: 0 10px 34px rgba(15, 23, 42, .18), 0 0 0 1px rgba(15, 23, 42, .07);
  }
  @media (prefers-color-scheme: dark) {
    .pdft-layer {
      --bg: #23262b;
      --fg: #e8eaed;
      --fg-dim: #9aa0a6;
      --line: #383c42;
      --accent: #6ea8fe;
      --accent-soft: #2a3240;
      --chip: #2e3238;
      --shadow: 0 10px 34px rgba(0, 0, 0, .5), 0 0 0 1px rgba(255, 255, 255, .08);
    }
  }
  .pdft-layer[data-theme="light"] {
    --bg: #ffffff; --fg: #1f2328; --fg-dim: #6b7280; --line: #e5e7eb;
    --accent: #2563eb; --accent-soft: #eff4ff; --chip: #f1f3f5;
    --shadow: 0 10px 34px rgba(15, 23, 42, .18), 0 0 0 1px rgba(15, 23, 42, .07);
  }
  .pdft-layer[data-theme="dark"] {
    --bg: #23262b; --fg: #e8eaed; --fg-dim: #9aa0a6; --line: #383c42;
    --accent: #6ea8fe; --accent-soft: #2a3240; --chip: #2e3238;
    --shadow: 0 10px 34px rgba(0, 0, 0, .5), 0 0 0 1px rgba(255, 255, 255, .08);
  }

  /* ── 触发按钮 ─────────────────────────────────────────────── */
  .pdft-btn {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font: 600 13px/1 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(37, 99, 235, .38);
    animation: pdft-pop .12s ease-out;
    user-select: none;
    white-space: nowrap;
  }
  .pdft-btn:hover { filter: brightness(1.08); }
  .pdft-btn:active { transform: scale(.97); }
  .pdft-btn svg { width: 14px; height: 14px; display: block; }
  @keyframes pdft-pop { from { opacity: 0; transform: translateY(4px) scale(.9); } }

  /* ── 结果卡片 ─────────────────────────────────────────────── */
  .pdft-card {
    position: fixed;
    width: 348px;
    max-width: calc(100vw - 16px);
    max-height: min(62vh, 560px);
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--bg);
    border-radius: 12px;
    box-shadow: var(--shadow);
    animation: pdft-pop .14s ease-out;
  }
  .pdft-card::-webkit-scrollbar { width: 8px; }
  .pdft-card::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

  .pdft-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 12px 0;
  }
  .pdft-word {
    font-size: 19px;
    font-weight: 700;
    line-height: 1.2;
    word-break: break-word;
  }
  .pdft-close {
    margin-left: auto;
    flex: none;
    width: 24px; height: 24px;
    display: grid; place-items: center;
    border: 0; border-radius: 6px;
    background: transparent; color: var(--fg-dim);
    cursor: pointer;
  }
  .pdft-close:hover { background: var(--chip); color: var(--fg); }
  .pdft-close svg { width: 14px; height: 14px; }

  .pdft-phonetics {
    display: flex; flex-wrap: wrap; gap: 4px 12px;
    padding: 5px 12px 0;
    color: var(--fg-dim);
    font-size: 12.5px;
  }
  .pdft-ph { display: flex; align-items: center; gap: 4px; }
  .pdft-ph b { font-weight: 500; color: var(--fg-dim); }
  .pdft-speak {
    width: 20px; height: 20px;
    display: grid; place-items: center;
    border: 0; border-radius: 50%;
    background: transparent; color: var(--accent);
    cursor: pointer; padding: 0;
  }
  .pdft-speak:hover { background: var(--accent-soft); }
  .pdft-speak svg { width: 13px; height: 13px; }

  .pdft-body { padding: 8px 12px 12px; }
  .pdft-sec { margin-top: 10px; }
  .pdft-sec:first-child { margin-top: 2px; }
  .pdft-sec-title {
    font-size: 11px; font-weight: 600; letter-spacing: .06em;
    color: var(--fg-dim); text-transform: uppercase;
    margin-bottom: 4px;
  }
  .pdft-mean { display: flex; gap: 7px; margin-top: 4px; }
  .pdft-pos {
    flex: none;
    min-width: 30px;
    color: var(--accent);
    font-style: italic;
    font-weight: 600;
  }
  .pdft-defs { flex: 1; min-width: 0; }
  .pdft-def { display: block; }
  .pdft-def + .pdft-def { margin-top: 2px; }

  .pdft-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .pdft-chip {
    background: var(--chip);
    border-radius: 6px;
    padding: 2px 7px;
    font-size: 12px;
    color: var(--fg-dim);
  }
  .pdft-chip em { font-style: normal; color: var(--fg); }

  .pdft-pair { display: flex; gap: 6px; margin-top: 3px; }
  .pdft-pair .en { flex: 1; min-width: 0; }
  .pdft-pair .zh { flex: 1; min-width: 0; color: var(--fg-dim); }
  .pdft-ex { margin-top: 7px; }
  .pdft-ex .en { color: var(--fg); }
  .pdft-ex .zh { color: var(--fg-dim); margin-top: 1px; }
  .pdft-ex mark { background: rgba(37, 99, 235, .16); color: inherit; border-radius: 3px; padding: 0 1px; }

  .pdft-sentence {
    font-size: 14px;
    line-height: 1.7;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .pdft-foot {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--line);
    color: var(--fg-dim);
    font-size: 11.5px;
  }
  .pdft-foot a, .pdft-copy {
    color: var(--fg-dim); text-decoration: none;
    background: none; border: 0; padding: 0; font: inherit; cursor: pointer;
  }
  .pdft-foot a:hover, .pdft-copy:hover { color: var(--accent); text-decoration: underline; }
  .pdft-engine { margin-left: auto; white-space: nowrap; }

  .pdft-loading {
    display: flex; align-items: center; gap: 8px;
    padding: 14px 12px; color: var(--fg-dim);
  }
  .pdft-spin {
    width: 14px; height: 14px; flex: none;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: pdft-rot .7s linear infinite;
  }
  @keyframes pdft-rot { to { transform: rotate(360deg); } }

  .pdft-error { padding: 14px 12px; color: #d93025; }
  .pdft-error .retry { margin-left: 6px; }
  @media (prefers-color-scheme: dark) { .pdft-error { color: #ff8a80; } }
  `;

  /* ── 小工具 ─────────────────────────────────────────────────── */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v; // 仅用于本文件内置的固定 SVG
        else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of [].concat(children ?? [])) {
      if (c == null || c === false) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const ICON = {
    translate:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10M9 3v2c0 4.4-2.2 8-5 9"/><path d="M6 10.5c1.4 2 3.3 3.4 5.5 4.2"/><path d="M13 21l4-10 4 10"/><path d="M14.5 17h5"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    speaker:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 8.5a4.5 4.5 0 0 1 0 7"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>',
  };

  /** 把一个 rect 摆到可视区内（优先在锚点上方） */
  function place(node, rect, opts = {}) {
    const gap = opts.gap ?? 8;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let left = opts.center ? rect.left + rect.width / 2 - w / 2 : rect.left;
    let top = rect.top - h - gap;
    if (top < margin) {
      const below = rect.bottom + gap;
      top = below + h <= vh - margin ? below : Math.max(margin, Math.min(vh - h - margin, below));
    }
    left = Math.max(margin, Math.min(vw - w - margin, left));
    top = Math.max(margin, Math.min(vh - h - margin, top));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  function cleanText(raw) {
    return String(raw ?? '')
      .replace(/\u00AD/g, '') // 软连字符（PDF 断行常见）
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ── 主组件 ─────────────────────────────────────────────────── */
  class TranslateBubble {
    /**
     * @param {object} opts
     * @param {(text: string) => Promise<{ok: boolean, result?: object, error?: string}>} opts.onLookup
     * @param {() => Promise<object>} [opts.loadSettings]
     */
    constructor(opts = {}) {
      this.opts = opts;
      this.onLookup = opts.onLookup;
      this.settings = { maxSelectionLength: 600, showExamples: true, showPhonetic: true, viewerTheme: 'system' };
      this.anchor = null; // 当前选区的 rect
      this.currentText = '';
      this.open = false;
      this.destroyed = false;
      this._lastRange = null;

      this.host = document.createElement(HOST_TAG);
      this.host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483600;';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      this.shadow.append(el('style', { text: CSS }));
      this.layer = el('div', { class: 'pdft-layer' });
      this.shadow.append(this.layer);
      (document.body || document.documentElement).append(this.host);

      this._onMouseUp = this._onMouseUp.bind(this);
      this._onMouseDown = this._onMouseDown.bind(this);
      this._onKeyDown = this._onKeyDown.bind(this);
      this._onViewportChange = this._onViewportChange.bind(this);
    }

    async init() {
      if (this.opts.loadSettings) {
        try {
          const s = await this.opts.loadSettings();
          if (s) this.settings = { ...this.settings, ...s };
        } catch {
          /* 用默认值 */
        }
      }
      this.applyTheme();
      return this;
    }

    applyTheme() {
      const t = this.settings.viewerTheme;
      if (t === 'light' || t === 'dark') this.layer.dataset.theme = t;
      else delete this.layer.dataset.theme;
    }

    updateSettings(patch) {
      this.settings = { ...this.settings, ...(patch || {}) };
      this.applyTheme();
    }

    get enabled() {
      return this.settings.enabled !== false;
    }

    attach() {
      document.addEventListener('mouseup', this._onMouseUp, true);
      document.addEventListener('mousedown', this._onMouseDown, true);
      document.addEventListener('keydown', this._onKeyDown, true);
      window.addEventListener('scroll', this._onViewportChange, true);
      window.addEventListener('resize', this._onViewportChange, true);
      return this;
    }

    destroy() {
      this.destroyed = true;
      document.removeEventListener('mouseup', this._onMouseUp, true);
      document.removeEventListener('mousedown', this._onMouseDown, true);
      document.removeEventListener('keydown', this._onKeyDown, true);
      window.removeEventListener('scroll', this._onViewportChange, true);
      window.removeEventListener('resize', this._onViewportChange, true);
      this.host.remove();
    }

    /* ── 事件 ─────────────────────────────────────────────────── */
    _inside(event) {
      return event.composedPath ? event.composedPath().includes(this.host) : false;
    }

    _onMouseUp(event) {
      if (this.destroyed || event.button !== 0) return;
      if (this._inside(event)) return;
      // 等浏览器把选区更新完
      setTimeout(() => this._handleSelection(event), 0);
    }

    _onMouseDown(event) {
      if (this.destroyed || this._inside(event)) return;
      this.hideButton();
      if (this.open) this.hideCard();
    }

    _onKeyDown(event) {
      if (event.key === 'Escape') {
        this.hideButton();
        this.hideCard();
      }
    }

    _onViewportChange() {
      if (!this.open) {
        this.hideButton();
        return;
      }
      // 卡片打开时跟随选区；选区没了就收起来
      const rect = this._liveSelectionRect();
      if (rect) place(this.card, rect, { center: false });
      else this.hideCard();
    }

    _liveSelectionRect() {
      try {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        const r = sel.getRangeAt(0).getBoundingClientRect();
        return r.width || r.height ? r : null;
      } catch {
        return null;
      }
    }

    _handleSelection(event) {
      if (this.destroyed || !this.enabled) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const text = cleanText(sel.toString());
      if (!text) return;

      // 光标的落点必须在选区附近，避免键盘/程序化选区误触发
      const rect = this._liveSelectionRect();
      if (!rect) return;
      if (event && (event.clientX || event.clientY)) {
        const pad = 24;
        const near =
          event.clientY >= rect.top - pad &&
          event.clientY <= rect.bottom + pad &&
          event.clientX >= rect.left - pad &&
          event.clientX <= rect.right + pad;
        if (!near) return;
      }

      this._lastRange = sel.getRangeAt(0).cloneRange();
      this.showButton(text, rect);
    }

    /** 供右键菜单 / 快捷键使用：直接对当前选区弹卡片 */
    translateCurrentSelection() {
      const sel = window.getSelection();
      let text = cleanText(sel?.toString());
      let rect = this._liveSelectionRect();
      if (!text && this.currentText) {
        text = this.currentText;
        rect = this.anchor;
      }
      if (!text) return false;
      if (!rect) {
        rect = { left: window.innerWidth / 2 - 60, top: 80, bottom: 104, width: 120, height: 24 };
      }
      this.hideButton();
      void this.translate(text, rect);
      return true;
    }

    /* ── 按钮 ─────────────────────────────────────────────────── */
    showButton(text, rect) {
      if (!this.enabled) return;
      this.currentText = text;
      this.anchor = rect;
      this.hideButton();
      const btn = el(
        'button',
        {
          class: 'pdft-btn',
          type: 'button',
          title: `翻译“${text.length > 24 ? text.slice(0, 24) + '…' : text}”`,
          // 阻止默认行为，避免点击按钮时页面选中的高亮被清掉
          onmousedown: (e) => {
            e.preventDefault();
            e.stopPropagation();
          },
        },
        [el('span', { html: ICON.translate }), el('span', { text: '译' })],
      );
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideButton();
        void this.translate(text, rect);
      });
      this.button = btn;
      this.layer.append(btn);
      place(btn, rect, { center: true });

      if (this.settings.translateOnSelect) {
        clearTimeout(this._autoTimer);
        this._autoTimer = setTimeout(() => {
          this.hideButton();
          void this.translate(text, rect);
        }, 260);
      }
    }

    hideButton() {
      clearTimeout(this._autoTimer);
      if (this.button) {
        this.button.remove();
        this.button = null;
      }
    }

    /* ── 卡片 ─────────────────────────────────────────────────── */
    hideCard() {
      if (this.card) {
        this.card.remove();
        this.card = null;
      }
      this.open = false;
    }

    async translate(text, rect) {
      const maxLen = Number(this.settings.maxSelectionLength) || 600;
      let query = text;
      let truncated = false;
      if (query.length > maxLen) {
        query = query.slice(0, maxLen);
        truncated = true;
      }
      this.currentText = text;
      this.anchor = rect;
      this.hideCard();
      this.open = true;

      const card = el('div', { class: 'pdft-card' });
      this.card = card;
      this.layer.append(card);
      place(card, rect, { center: false });
      this._renderLoading(card, query, truncated);

      let res;
      try {
        res = await this.onLookup(query, { truncated });
      } catch (err) {
        res = { ok: false, error: err?.message || String(err) };
      }
      if (this.destroyed) return;
      if (this.card !== card) return; // 期间用户已经关掉/换了别的词
      if (res && res.ok && res.result) this._renderResult(card, res.result, { query, truncated, rect });
      else this._renderError(card, res?.error || '查询失败，请稍后重试', { query, rect });
    }

    _renderLoading(card, query, truncated) {
      card.textContent = '';
      card.append(
        el('div', { class: 'pdft-head' }, [
          el('div', { class: 'pdft-word', text: query.length > 40 ? query.slice(0, 40) + '…' : query }),
          this._closeButton(card),
        ]),
        el('div', { class: 'pdft-loading' }, [el('span', { class: 'pdft-spin' }), el('span', { text: '正在查询…' })]),
        truncated ? el('div', { class: 'pdft-foot' }, [el('span', { text: '选区过长，已截断后翻译' })]) : null,
      );
    }

    _closeButton(card) {
      return el('button', {
        class: 'pdft-close',
        type: 'button',
        title: '关闭 (Esc)',
        html: ICON.close,
        onclick: (e) => {
          e.stopPropagation();
          card.remove();
          if (this.card === card) this.card = null;
          this.open = false;
        },
      });
    }

    _renderError(card, message, { query, rect }) {
      card.textContent = '';
      card.append(
        el('div', { class: 'pdft-head' }, [
          el('div', { class: 'pdft-word', text: query.length > 40 ? query.slice(0, 40) + '…' : query }),
          this._closeButton(card),
        ]),
        el('div', { class: 'pdft-error' }, [
          el('span', { text: '⚠ ' + message }),
          el('button', {
            class: 'pdft-copy retry',
            type: 'button',
            text: '重试',
            onclick: () => void this.translate(query, rect),
          }),
        ]),
      );
    }

    _renderResult(card, r, { query, truncated, rect }) {
      card.textContent = '';
      const isSentence = r.mode === 'sentence' || (r.meanings || []).length === 0;
      const head = el('div', { class: 'pdft-head' }, [
        el('div', { class: 'pdft-word', text: r.query || query }),
        this._closeButton(card),
      ]);
      card.append(head);

      // 音标 + 发音
      if (this.settings.showPhonetic !== false && r.phonetic && (r.phonetic.uk || r.phonetic.us)) {
        const row = el('div', { class: 'pdft-phonetics' });
        for (const [key, label] of [
          ['uk', '英'],
          ['us', '美'],
        ]) {
          const ph = r.phonetic[key];
          if (!ph) continue;
          const item = el('span', { class: 'pdft-ph' }, [
            el('b', { text: label }),
            el('span', { text: `/${ph}/` }),
          ]);
          const audio = r.audio?.[key];
          if (audio) {
            item.append(
              el('button', {
                class: 'pdft-speak',
                type: 'button',
                title: '发音',
                html: ICON.speaker,
                onclick: (e) => {
                  e.stopPropagation();
                  this._play(audio);
                },
              }),
            );
          }
          row.append(item);
        }
        card.append(row);
      }

      const body = el('div', { class: 'pdft-body' });

      if (isSentence) {
        body.append(el('div', { class: 'pdft-sentence', text: r.translation || '（没有返回翻译）' }));
      } else {
        // 释义
        const sec = el('div', { class: 'pdft-sec' });
        for (const m of r.meanings || []) {
          const defs = el('div', { class: 'pdft-defs' });
          for (const d of m.defs || []) defs.append(el('span', { class: 'pdft-def', text: d }));
          sec.append(
            el('div', { class: 'pdft-mean' }, [el('span', { class: 'pdft-pos', text: m.pos || '' }), defs]),
          );
        }
        if (sec.childNodes.length) body.append(sec);
        else if (r.translation) body.append(el('div', { class: 'pdft-sentence', text: r.translation }));

        // 词形变化
        if ((r.forms || []).length) {
          const chips = el('div', { class: 'pdft-chips' });
          for (const f of r.forms.slice(0, 8)) {
            chips.append(
              el('span', { class: 'pdft-chip' }, [el('em', { text: f.value }), document.createTextNode(' ' + (f.name || ''))]),
            );
          }
          body.append(el('div', { class: 'pdft-sec' }, [el('div', { class: 'pdft-sec-title', text: '词形变化' }), chips]));
        }

        // 短语
        if ((r.phrases || []).length) {
          const sec2 = el('div', { class: 'pdft-sec' }, [el('div', { class: 'pdft-sec-title', text: '短语' })]);
          for (const p of r.phrases.slice(0, 6)) {
            sec2.append(
              el('div', { class: 'pdft-pair' }, [
                el('span', { class: 'en', text: p.en }),
                el('span', { class: 'zh', text: p.zh || '' }),
              ]),
            );
          }
          body.append(sec2);
        }

        // 例句
        if (this.settings.showExamples !== false && (r.examples || []).length) {
          const sec3 = el('div', { class: 'pdft-sec' }, [el('div', { class: 'pdft-sec-title', text: '例句' })]);
          for (const ex of r.examples.slice(0, 3)) {
            sec3.append(
              el('div', { class: 'pdft-ex' }, [
                el('div', { class: 'en' }, this._highlight(ex.en, r.query)),
                ex.zh ? el('div', { class: 'zh', text: ex.zh }) : null,
              ]),
            );
          }
          body.append(sec3);
        }
      }

      card.append(body);

      // 底栏
      const foot = el('div', { class: 'pdft-foot' });
      foot.append(
        el('button', {
          class: 'pdft-copy',
          type: 'button',
          text: '复制',
          onclick: async (e) => {
            e.stopPropagation();
            const btn = e.currentTarget;
            const payload = isSentence
              ? r.translation || ''
              : [r.query, r.translation, ...(r.meanings || []).map((m) => `${m.pos} ${(m.defs || []).join('；')}`)]
                  .filter(Boolean)
                  .join('\n');
            try {
              await navigator.clipboard.writeText(payload);
              btn.textContent = '已复制';
            } catch {
              btn.textContent = '复制失败';
            }
            setTimeout(() => (btn.textContent = '复制'), 1400);
          },
        }),
      );
      if (r.sourceUrl) {
        foot.append(
          el('a', {
            href: r.sourceUrl,
            target: '_blank',
            rel: 'noreferrer noopener',
            text: '词典详情',
            onclick: (e) => e.stopPropagation(),
          }),
        );
      }
      foot.append(el('span', { class: 'pdft-engine', text: (r.engineLabel || r.engine || '') + (r.cached ? ' · 缓存' : '') }));
      card.append(foot);

      if (this.card === card) place(card, rect, { center: false });
    }

    /** 例句里高亮查询词（用 DOM 节点拼，不用 innerHTML） */
    _highlight(text, word) {
      const frag = document.createDocumentFragment();
      const src = String(text || '');
      const needle = String(word || '').trim();
      if (!needle) {
        frag.append(document.createTextNode(src));
        return frag;
      }
      const lower = src.toLowerCase();
      const target = needle.toLowerCase();
      let i = 0;
      for (;;) {
        const at = lower.indexOf(target, i);
        if (at < 0) break;
        if (at > i) frag.append(document.createTextNode(src.slice(i, at)));
        frag.append(el('mark', { text: src.slice(at, at + target.length) }));
        i = at + target.length;
      }
      if (i < src.length) frag.append(document.createTextNode(src.slice(i)));
      return frag;
    }

    _play(url) {
      try {
        const audio = new Audio(url);
        audio.volume = 1;
        void audio.play().catch(() => {});
      } catch {
        /* 忽略发音失败 */
      }
    }
  }

  globalThis.PDFT_BUBBLE = { TranslateBubble, cleanText, version: 1 };
})();
