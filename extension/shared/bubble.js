/**
 * shared/bubble.js — 划词翻译气泡（普通脚本，非 ES module）
 *
 * 用途：选中文字 → 出现「译」按钮 → 点一下 → 弹出中文释义卡片。
 * 同一份代码同时服务于两个场景：
 *   1) 普通网页（content script 隔离世界，见 content/selection-translate.js）
 *   2) 本扩展的 PDF 阅读器页（viewer/viewer.html 里用 <script src> 直接引入）
 *
 * 能力：
 *   - 卡片顶部文字可直接编辑，回车重译（PDF 框选漏字时手动补）；
 *   - 「扩选整行 / 扩选整段」按视觉行把 PDF 文本层片段重新拼起来；
 *   - 卡片可以拖动左上角手柄「钉」在任意位置，且支持同时开多张（互不干扰）；
 *   - 每张卡片独立保存文档选区 / 请求，慢响应不会覆盖新结果。
 *
 * 实现要点：
 *   - 挂在 Shadow DOM 里，页面样式无法污染，也无法被页面 reset 掉；
 *   - 所有结果文本一律用 DOM API 写入（textContent），不拼 innerHTML，避免词典内容注入；
 *   - 网络请求由外部注入的 onLookup 完成（走 service worker，绕开页面 CORS/CSP）。
 */
(function () {
  'use strict';

  const HOST_TAG = 'pdft-bubble-host';
  const MAX_CARDS = 6; // 同时最多几张卡片，超了自动关掉最早的

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
  /* 拖动过（钉住）的卡片给一圈细蓝边，和「跟着选区跑」的卡片区分开 */
  .pdft-card.pinned {
    box-shadow: 0 14px 44px rgba(15, 23, 42, .24), 0 0 0 1.5px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .pdft-card.dragging { cursor: grabbing; }
  .pdft-card.dragging * { cursor: grabbing !important; }

  .pdft-head {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 12px 0;
  }
  .pdft-grip {
    flex: none;
    width: 16px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fg-dim);
    cursor: grab;
    touch-action: none;
  }
  .pdft-grip:hover { color: var(--accent); }
  .pdft-grip svg { width: 12px; height: 12px; }
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

  /* 可编辑的待翻译文字：平时像一个标题，点进去就是输入框 */
  .pdft-editor {
    flex: 1;
    min-width: 0;
    min-height: 26px;
    max-height: 116px;
    padding: 3px 5px;
    font-family: inherit;
    font-size: 15.5px;
    font-weight: 700;
    line-height: 1.35;
    color: var(--fg);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 7px;
    resize: none;
    overflow: auto;
    word-break: break-word;
    cursor: text;
  }
  .pdft-editor::placeholder { font-weight: 400; color: var(--fg-dim); }
  .pdft-editor:hover { background: var(--chip); }
  .pdft-editor:focus { outline: none; background: var(--chip); border-color: var(--accent); }

  .pdft-editbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 7px 12px 0;
  }
  .pdft-act {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg-dim);
    font-family: inherit;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
  }
  .pdft-act:hover { color: var(--accent); border-color: var(--accent); }
  .pdft-act.primary {
    background: var(--accent);
    border-color: transparent;
    color: #fff;
    font-weight: 600;
  }
  .pdft-act.primary:hover { filter: brightness(1.08); }

  /* 右侧提示：没改过时告诉用户“这段文字可以直接编辑”，改过就提示回车重译 */
  .pdft-tip {
    margin-left: auto;
    font-size: 11px;
    color: var(--fg-dim);
    white-space: nowrap;
  }

  .pdft-notice {
    margin: 7px 12px 0;
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 12px;
  }

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

  .pdft-result:empty { display: none; }

  /* ── 多开时的角标：显示卡片数 + 一键全关 ─────────────────── */
  .pdft-stack {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 9;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--bg);
    color: var(--fg-dim);
    box-shadow: var(--shadow);
    font-size: 12px;
    animation: pdft-pop .14s ease-out;
    user-select: none;
  }
  .pdft-stack button {
    border: 0; background: none; padding: 0;
    color: var(--accent); font: inherit; cursor: pointer;
  }
  .pdft-stack button:hover { text-decoration: underline; }
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

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  const ICON = {
    translate:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10M9 3v2c0 4.4-2.2 8-5 9"/><path d="M6 10.5c1.4 2 3.3 3.4 5.5 4.2"/><path d="M13 21l4-10 4 10"/><path d="M14.5 17h5"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    speaker:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 8.5a4.5 4.5 0 0 1 0 7"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>',
    grip:
      '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="4" cy="2.5" r="1.15"/><circle cx="8" cy="2.5" r="1.15"/><circle cx="4" cy="6" r="1.15"/><circle cx="8" cy="6" r="1.15"/><circle cx="4" cy="9.5" r="1.15"/><circle cx="8" cy="9.5" r="1.15"/></svg>',
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

  /* ── 选区扩全：把「选不全」的那部分补回来 ─────────────────────
   *
   * PDF 的文本层是按词/片段切成一堆 span 的，鼠标框选很容易漏掉首尾字符，
   * 或者把词切断。这里按「视觉行」重新拼：同一行的目标（底边基本对齐）归为一组，
   * 组内按 x 排序、按间距补空格，最后把选区换成整行/整段。
   */
  const LINE_BASELINE_TOLERANCE = 0.35; // 底边相差不超过行高的 35% 视为同一行
  const PARAGRAPH_GAP_RATIO = 0.9; // 行间距超过行高的 90% 视为换段
  const MAX_TEXT_NODES = 2000; // 安全上限，避免超大页面卡住
  const WORD_GAP_RATIO = 0.18; // 两个片段之间超过字高的 18% 就补一个空格

  function textNodesIn(scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode() && nodes.length < MAX_TEXT_NODES) {
      const node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.trim()) nodes.push(node);
    }
    return nodes;
  }

  function rectOfNode(node) {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      return rect && (rect.width || rect.height) ? rect : null;
    } catch {
      return null;
    }
  }

  function overlapY(a, b) {
    return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  }

  function sameLine(a, b) {
    const h = Math.max(a.bottom - a.top, b.bottom - b.top, 1);
    return Math.abs(a.bottom - b.bottom) <= LINE_BASELINE_TOLERANCE * h || overlapY(a, b) > 0.6 * h;
  }

  function lineText(line) {
    let text = '';
    let prev = null;
    for (const run of line.runs) {
      const piece = run.node.nodeValue.replace(/\s+/g, ' ').trim();
      if (!piece) continue;
      if (prev) {
        const gap = run.rect.left - prev.rect.right;
        const gapLimit = Math.max(2, Math.min(prev.rect.height || 12, run.rect.height || 12) * WORD_GAP_RATIO);
        if (gap > gapLimit && !/\s$/.test(text)) text += ' ';
      }
      text += piece;
      prev = run;
    }
    return text;
  }

  /** 选区所在的那个「块」：PDF 文本层优先，普通网页退回到最近的块级元素 */
  function scopeFor(range) {
    const start = range.startContainer;
    const element = start.nodeType === 1 ? start : start.parentElement;
    if (!element) return null;
    return (
      element.closest('.textLayer') ||
      element.closest('p, li, blockquote, dd, td, th, h1, h2, h3, h4, h5, h6, article, section') ||
      element.parentElement ||
      document.body
    );
  }

  /**
   * 把 range 扩成整行 / 整段。
   * @returns {{text: string, range: Range, lines: number} | null}
   */
  function expandRange(range, mode = 'line') {
    const scope = scopeFor(range);
    if (!scope) return null;

    const runs = [];
    for (const node of textNodesIn(scope)) {
      const rect = rectOfNode(node);
      if (rect) runs.push({ node, rect });
    }
    if (!runs.length) return null;

    // 1) 按视觉行分组
    const lines = [];
    for (const run of runs) {
      let line = lines.find((l) => sameLine(l, run.rect));
      if (!line) {
        line = { runs: [], top: run.rect.top, bottom: run.rect.bottom, left: run.rect.left, right: run.rect.right };
        lines.push(line);
      }
      line.runs.push(run);
      line.top = Math.min(line.top, run.rect.top);
      line.bottom = Math.max(line.bottom, run.rect.bottom);
      line.left = Math.min(line.left, run.rect.left);
      line.right = Math.max(line.right, run.rect.right);
    }
    for (const line of lines) line.runs.sort((a, b) => a.rect.left - b.rect.left);
    lines.sort((a, b) => a.top - b.top);
    for (const line of lines) line.text = lineText(line);

    // 2) 找到选区落在哪一行
    const selRect = range.getBoundingClientRect();
    let index = lines.findIndex((l) => overlapY(l, selRect) > 0);
    if (index < 0) {
      index = lines.reduce(
        (best, l, i) => (Math.abs(l.top - selRect.top) < Math.abs(lines[best].top - selRect.top) ? i : best),
        0,
      );
    }

    // 3) 整段：向上下吃掉行距正常的相邻行
    let chosen = [lines[index]];
    if (mode === 'paragraph') {
      const near = (a, b) => {
        const gap = a.top < b.top ? b.top - a.bottom : a.top - b.bottom;
        const h = Math.max(a.bottom - a.top, b.bottom - b.top, 1);
        if (gap > h * PARAGRAPH_GAP_RATIO) return false;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        return overlapX > 0.3 * Math.min(a.right - a.left, b.right - b.left);
      };
      let first = index;
      let last = index;
      while (first > 0 && near(lines[first - 1], lines[first])) first--;
      while (last < lines.length - 1 && near(lines[last], lines[last + 1])) last++;
      chosen = lines.slice(first, last + 1);
    }

    // 4) 拼文本 + 生成对应的 Range（让高亮也跟着扩出来）
    const firstRun = chosen[0].runs[0];
    const lastLineRuns = chosen[chosen.length - 1].runs;
    const lastRun = lastLineRuns[lastLineRuns.length - 1];
    let out;
    try {
      out = document.createRange();
      out.setStart(firstRun.node, 0);
      out.setEnd(lastRun.node, lastRun.node.nodeValue.length);
    } catch {
      return null;
    }

    const joiner = mode === 'paragraph' ? ' ' : '';
    const text = chosen
      .map((l) => l.text)
      .filter(Boolean)
      .join(joiner)
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;
    return { text, range: out, lines: chosen.length };
  }

  /* ── 一张翻译卡片 ─────────────────────────────────────────────
   * 每张卡片自己保存：待翻译文字、文档选区、请求序号、位置与钉住状态。
   * 关掉一张不影响其它卡片。
   */
  class BubbleCard {
    /**
     * @param {TranslateBubble} bubble
     * @param {{text: string, anchor: object, auto?: boolean, sourceRange?: Range|null}} init
     */
    constructor(bubble, { text, anchor, auto = false, sourceRange = null }) {
      this.bubble = bubble;
      this.auto = auto;
      this.anchor = anchor;
      this.sourceText = text;
      this.sourceRange = sourceRange ?? null;
      this.lastRange = sourceRange ? sourceRange.cloneRange() : null;
      this.seq = 0;
      this.closed = false;
      this.pinned = false; // 拖动过就钉住，不再跟着选区跑
      this.offset = { dx: 0, dy: 0 }; // 新卡片和旧卡片重叠时的错位
      this.drag = null;

      this.el = this._build();
      this.editor.value = text;
      this._autoGrow();
      this._syncDirty();
      this.bubble.layer.append(this.el);
      this.placeAt(anchor);
    }

    get settings() {
      return this.bubble.settings;
    }

    /* ── 骨架 ─────────────────────────────────────────────────── */
    _build() {
      const grip = el('button', {
        class: 'pdft-grip',
        type: 'button',
        html: ICON.grip,
        title: '按住拖动：把卡片钉在任意位置（多开时会很有用）',
      });
      this.grip = grip;

      const editor = el('textarea', {
        class: 'pdft-editor',
        rows: '1',
        spellcheck: 'false',
        placeholder: '要翻译的文字…',
        title: '可以直接修改要翻译的文字，回车重新翻译',
        oninput: () => {
          this._autoGrow();
          this._syncDirty();
        },
        onkeydown: (event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            this._submitEditor();
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            event.target.blur();
          }
        },
      });
      this.editor = editor;

      const close = el('button', {
        class: 'pdft-close',
        type: 'button',
        title: '关闭这张卡片',
        html: ICON.close,
        onclick: (event) => {
          event.stopPropagation();
          this.bubble.removeCard(this);
        },
      });

      const translateBtn = el('button', {
        class: 'pdft-act primary',
        type: 'button',
        text: '翻译',
        title: '翻译输入框里的文字（回车）',
        onclick: () => this._submitEditor(),
      });
      this.translateBtn = translateBtn;

      const tip = el('span', { class: 'pdft-tip', text: '文字可编辑' });
      this.tipEl = tip;

      const card = el('div', { class: 'pdft-card' }, [
        el('div', { class: 'pdft-head' }, [grip, editor, close]),
        el('div', { class: 'pdft-editbar' }, [
          translateBtn,
          el('button', {
            class: 'pdft-act',
            type: 'button',
            text: '扩选整行',
            title: '把选区补成完整的一行（PDF 文本层是按词切分的，鼠标框选容易漏字）',
            onclick: () => this._expand('line'),
          }),
          el('button', {
            class: 'pdft-act',
            type: 'button',
            text: '扩选整段',
            title: '把选区补成完整的一段',
            onclick: () => this._expand('paragraph'),
          }),
          el('button', {
            class: 'pdft-act',
            type: 'button',
            text: '还原',
            title: '回到鼠标选中的原文',
            onclick: () => this._restoreSource(),
          }),
          tip,
        ]),
        el('div', { class: 'pdft-notice', hidden: true }),
        el('div', { class: 'pdft-result' }),
      ]);

      this.noticeEl = card.querySelector('.pdft-notice');
      this.resultBox = card.querySelector('.pdft-result');

      // 点卡片任意位置把它提到最上层（多开时方便）
      card.addEventListener('pointerdown', () => this.bubble.bringToFront(this));
      this._bindDrag(grip);
      return card;
    }

    /* ── 位置 ─────────────────────────────────────────────────── */
    /** 按锚点摆放（钉住的卡片不动）；offset 是新卡片避让旧卡片的错位 */
    placeAt(anchor) {
      if (anchor) this.anchor = anchor;
      if (this.pinned || this.drag || !this.anchor) return;
      place(this.el, this.anchor, { center: false });
      if (this.offset.dx || this.offset.dy) {
        const left = clamp((parseFloat(this.el.style.left) || 0) + this.offset.dx, 8, window.innerWidth - 40);
        const top = clamp((parseFloat(this.el.style.top) || 0) + this.offset.dy, 8, window.innerHeight - 30);
        this.el.style.left = `${Math.round(left)}px`;
        this.el.style.top = `${Math.round(top)}px`;
      }
    }

    /** 文档里对应选区现在还在不在？在的话返回它当前的屏幕位置 */
    liveRect() {
      for (const range of [this.lastRange, this.sourceRange]) {
        try {
          if (!range || !range.startContainer?.isConnected) continue;
          const rect = range.getBoundingClientRect();
          if (rect && (rect.width || rect.height)) return rect;
        } catch {
          /* 忽略：PDF 重绘后 range 可能失效 */
        }
      }
      return null;
    }

    /* ── 拖动 ─────────────────────────────────────────────────── */
    _bindDrag(grip) {
      grip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || this.closed) return;
        event.preventDefault();
        event.stopPropagation();
        this.bubble.bringToFront(this);

        const box = this.el.getBoundingClientRect();
        const start = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
        let moved = false;

        const onMove = (moveEvent) => {
          const dx = moveEvent.clientX - start.x;
          const dy = moveEvent.clientY - start.y;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          if (!moved) {
            moved = true;
            this.el.classList.add('dragging');
          }
          this.el.style.left = `${Math.round(clamp(start.left + dx, 4, window.innerWidth - 60))}px`;
          this.el.style.top = `${Math.round(clamp(start.top + dy, 4, window.innerHeight - 32))}px`;
        };

        const onUp = () => {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onUp, true);
          this.el.classList.remove('dragging');
          if (!moved) return;
          // 拖过就钉住：不再跟着选区/滚动跑，方便一边留着对比
          this.pinned = true;
          this.offset = { dx: 0, dy: 0 };
          this.el.classList.add('pinned');
          if (this._unpinHintTimer) clearTimeout(this._unpinHintTimer);
          this._flash('已固定在这里；双击手柄可以取消固定', 3200);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
      });

      // 双击手柄：取消固定，让卡片重新跟着选区
      grip.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.pinned) return;
        this.pinned = false;
        this.el.classList.remove('pinned');
        this._flash('已取消固定，重新跟随选区');
        const rect = this.liveRect();
        this.placeAt(rect || this.anchor);
      });
    }

    /* ── 输入框 ───────────────────────────────────────────────── */
    /** 输入框跟着内容长高（最多 116px，再多就内部滚动） */
    _autoGrow() {
      const editor = this.editor;
      if (!editor) return;
      editor.style.height = 'auto';
      editor.style.height = `${Math.min(116, Math.max(26, editor.scrollHeight))}px`;
    }

    /** 文字被改过时把「翻译」按钮点亮，并换掉右侧提示 */
    _syncDirty() {
      if (!this.translateBtn) return;
      const dirty = (this.editor?.value ?? '') !== (this.sourceText ?? '');
      this.translateBtn.classList.toggle('primary', dirty);
      if (this.tipEl) this.tipEl.textContent = dirty ? '回车重译' : '文字可编辑';
    }

    _flash(message, ms = 2800) {
      const node = this.noticeEl;
      if (!node || this.closed) return;
      node.textContent = message;
      node.hidden = false;
      clearTimeout(this._noticeTimer);
      this._noticeTimer = setTimeout(() => {
        node.hidden = true;
        node.textContent = '';
      }, ms);
    }

    _submitEditor() {
      const text = cleanText(this.editor?.value || '');
      if (!text) {
        this._flash('先在输入框里写下要翻译的文字');
        return;
      }
      void this.translate(text, this.anchor, { setEditor: false });
    }

    _restoreSource() {
      if (!this.sourceText) return;
      if (this.sourceRange && this._rangeAlive(this.sourceRange)) this._applyRange(this.sourceRange);
      void this.translate(this.sourceText, this.anchor, { setEditor: true });
    }

    /** 扩选整行 / 整段：把没选全的部分补回来，然后立刻重译 */
    _expand(mode) {
      const base = [this.lastRange, this.sourceRange, this._liveSelectionRange()].find(
        (range) => range && this._rangeAlive(range),
      );
      if (!base) {
        this._flash('原来的选区已经失效了，请重新用鼠标选中文字');
        return;
      }
      const expanded = expandRange(base, mode);
      if (!expanded) {
        this._flash('这里没法自动扩选，直接在输入框里补两下吧');
        return;
      }
      this._applyRange(expanded.range);
      void this.translate(expanded.text, this.anchor, { setEditor: true });
    }

    _rangeAlive(range) {
      try {
        return Boolean(range.startContainer?.isConnected && range.getClientRects().length);
      } catch {
        return false;
      }
    }

    _liveSelectionRange() {
      try {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        return sel.getRangeAt(0);
      } catch {
        return null;
      }
    }

    /** 把页面选区同步成给定 range（高亮会一起扩出来），并更新锚点 */
    _applyRange(range) {
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        this.lastRange = range.cloneRange();
        const rect = range.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) this.anchor = rect;
      } catch {
        /* 选区同步失败不影响翻译 */
      }
    }

    /* ── 翻译与渲染 ───────────────────────────────────────────── */
    /**
     * @param {string} text 要翻译的文字（原样显示在输入框里，过长只截断发给引擎）
     * @param {object} [anchor] 气泡锚点
     * @param {{setEditor?: boolean, sourceRange?: Range|null}} [opts]
     */
    async translate(text, anchor, opts = {}) {
      const { setEditor = true } = opts;
      if (opts.sourceRange !== undefined) {
        this.sourceRange = opts.sourceRange;
        this.lastRange = opts.sourceRange ? opts.sourceRange.cloneRange() : null;
      }
      const maxLen = Number(this.settings.maxSelectionLength) || 600;
      const raw = String(text ?? '');
      const query = raw.length > maxLen ? raw.slice(0, maxLen) : raw;
      const truncated = query.length !== raw.length;

      if (this.closed) return;
      if (anchor) this.anchor = anchor;
      if (setEditor && this.editor && this.editor.value !== raw) {
        this.editor.value = raw;
        this._autoGrow();
      }
      this._syncDirty();
      this.placeAt(this.anchor);
      this._renderLoading(query, truncated);

      const seq = (this.seq += 1);
      let res;
      try {
        res = await this.bubble.onLookup(query, { truncated });
      } catch (err) {
        res = { ok: false, error: err?.message || String(err) };
      }
      // 期间可能被关掉、或者用户又改了词，只认最后一次请求
      if (this.closed || seq !== this.seq) return;
      if (res && res.ok && res.result) this._renderResult(res.result, { query, truncated });
      else this._renderError(res?.error || '查询失败，请稍后重试', { query });
    }

    _renderLoading(query, truncated) {
      const box = this.resultBox;
      if (!box) return;
      box.textContent = '';
      box.append(
        el('div', { class: 'pdft-loading' }, [el('span', { class: 'pdft-spin' }), el('span', { text: '正在查询…' })]),
      );
      if (truncated) {
        box.append(
          el('div', { class: 'pdft-foot' }, [el('span', { text: `文字较长，先翻译前 ${query.length} 个字符` })]),
        );
      }
    }

    _renderError(message, { query }) {
      const box = this.resultBox;
      if (!box) return;
      box.textContent = '';
      box.append(
        el('div', { class: 'pdft-error' }, [
          el('span', { text: '⚠ ' + message }),
          el('button', {
            class: 'pdft-copy retry',
            type: 'button',
            text: '重试',
            onclick: () => void this.translate(this.editor?.value || query, this.anchor, { setEditor: false }),
          }),
        ]),
      );
    }

    _renderResult(r, { query, truncated }) {
      const box = this.resultBox;
      if (!box) return;
      box.textContent = '';
      const isSentence = r.mode === 'sentence' || (r.meanings || []).length === 0;

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
                onclick: (event) => {
                  event.stopPropagation();
                  this._play(audio);
                },
              }),
            );
          }
          row.append(item);
        }
        box.append(row);
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

      box.append(body);

      // 底栏
      const foot = el('div', { class: 'pdft-foot' });
      foot.append(
        el('button', {
          class: 'pdft-copy',
          type: 'button',
          text: '复制',
          onclick: async (event) => {
            event.stopPropagation();
            const btn = event.currentTarget;
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
            onclick: (event) => event.stopPropagation(),
          }),
        );
      }
      if (truncated) {
        foot.append(el('span', { class: 'pdft-copy', text: `仅前 ${query.length} 字` }));
      }
      foot.append(el('span', { class: 'pdft-engine', text: (r.engineLabel || r.engine || '') + (r.cached ? ' · 缓存' : '') }));
      box.append(foot);

      this.placeAt();
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

    /** 关掉这张卡片（不动其它卡片） */
    close() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this._noticeTimer);
      clearTimeout(this._unpinHintTimer);
      this.el.remove();
    }
  }

  /* ── 气泡管理器：选区检测、触发按钮、卡片集合 ───────────────── */
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
      this.destroyed = false;
      /** @type {BubbleCard[]} */
      this.cards = [];
      this.currentText = ''; // 最近一次选中的文字（右键菜单/快捷键兜底用）
      this.anchor = null;
      this._lastRange = null;
      this._zTop = 10;
      this._stackEl = null;
      this._autoTimer = null;

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
      clearTimeout(this._autoTimer);
      this.closeAllCards();
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
      // 注意：这里只收按钮，不关卡片——卡片要能一直留着、能多开
      this.hideButton();
    }

    _onKeyDown(event) {
      if (event.key !== 'Escape') return;
      // 正在输入框里打字时，Esc 只退出输入，不关卡片
      const target = event.composedPath?.()[0];
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      this.hideButton();
      this.closeTopCard();
    }

    _onViewportChange() {
      this.hideButton();
      for (const card of this.cards) {
        if (card.pinned) continue;
        const rect = card.liveRect();
        if (rect) card.placeAt(rect);
      }
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

    _liveSelectionRange() {
      try {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        return sel.getRangeAt(0);
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

      const range = sel.getRangeAt(0);
      this._lastRange = range.cloneRange();
      this.currentText = text;
      this.anchor = rect;
      this.showButton(text, rect, range.cloneRange());
    }

    /** 供右键菜单 / 快捷键使用：直接对当前选区弹一张卡片 */
    translateCurrentSelection() {
      const sel = window.getSelection();
      let text = cleanText(sel?.toString());
      let rect = this._liveSelectionRect();
      const range = this._liveSelectionRange();
      if (range) this._lastRange = range.cloneRange();
      if (!text && this.currentText) {
        text = this.currentText;
        rect = this.anchor;
      }
      if (!text) return false;
      if (!rect) {
        rect = { left: window.innerWidth / 2 - 60, top: 80, bottom: 104, width: 120, height: 24 };
      }
      this.hideButton();
      this.openCard({ text, anchor: rect, sourceRange: range || this._lastRange });
      return true;
    }

    /* ── 触发按钮 ─────────────────────────────────────────────── */
    showButton(text, rect, sourceRange = null) {
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
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.hideButton();
        this.openCard({ text, anchor: rect, sourceRange: sourceRange || this._lastRange });
      });
      this.button = btn;
      this.layer.append(btn);
      place(btn, rect, { center: true });

      if (this.settings.translateOnSelect) {
        clearTimeout(this._autoTimer);
        this._autoTimer = setTimeout(() => {
          this.hideButton();
          this.openCard({ text, anchor: rect, auto: true, sourceRange: sourceRange || this._lastRange });
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

    /* ── 卡片集合 ─────────────────────────────────────────────── */
    /**
     * 开一张新卡片（或复用上一张自动卡片）。
     * @param {{text: string, anchor?: object, auto?: boolean, sourceRange?: Range|null}} init
     */
    openCard({ text, anchor, auto = false, sourceRange = null }) {
      if (this.destroyed) return null;
      const clean = cleanText(text);
      if (!clean) return null;
      const rect = anchor || this.anchor || { left: 40, top: 60, bottom: 84, width: 120, height: 24 };

      // 「选中即译 / 双击即译」这种连续自动触发，复用上一张自动卡片，避免刷屏
      if (auto) {
        const reusable = [...this.cards].reverse().find((c) => c.auto && !c.pinned && !c.closed);
        if (reusable) {
          reusable.translate(clean, rect, { setEditor: true, sourceRange });
          return reusable;
        }
      }

      this._enforceLimit();
      const card = new BubbleCard(this, { text: clean, anchor: rect, auto, sourceRange });
      this.cards.push(card);
      this.bringToFront(card);
      this._avoidOverlap(card);
      this._syncStack();
      void card.translate(clean, rect, { setEditor: true });
      return card;
    }

    /** 超过上限就关掉最早的（先关没被钉住的） */
    _enforceLimit() {
      while (this.cards.length >= MAX_CARDS) {
        const victim = this.cards.find((c) => !c.pinned) || this.cards[0];
        this.removeCard(victim);
      }
    }

    /** 新卡片与已有卡片重叠时错开一点，让人一眼看出是两张 */
    _avoidOverlap(card) {
      // 卡片内容是异步填进来的，刚建好时还很矮，所以按「至少 260px 高」估一下更准
      const box = (node, minHeight = 0) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.top + Math.max(r.height, minHeight) };
      };
      const hits = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
      for (let step = 1; step <= 4; step += 1) {
        const mine = box(card.el, 260);
        const clash = this.cards.some(
          (other) => other !== card && !other.closed && hits(mine, box(other.el, 120)),
        );
        if (!clash) return;
        card.offset = { dx: 22 * step, dy: 26 * step };
        card.placeAt();
      }
    }

    bringToFront(card) {
      if (!card || card.closed) return;
      this._zTop += 1;
      card.el.style.zIndex = String(this._zTop);
    }

    removeCard(card) {
      if (!card || card.closed) return;
      card.close();
      this.cards = this.cards.filter((c) => c !== card);
      this._syncStack();
    }

    /** Esc：关掉最上面那张 */
    closeTopCard() {
      if (!this.cards.length) return false;
      const top = this.cards.reduce((a, b) =>
        Number(a.el.style.zIndex || 0) >= Number(b.el.style.zIndex || 0) ? a : b,
      );
      this.removeCard(top);
      return true;
    }

    closeAllCards() {
      for (const card of [...this.cards]) card.close();
      this.cards = [];
      this._syncStack();
    }

    /** 角标：卡片 ≥ 2 张时出现，显示数量 + 一键全关 */
    _syncStack() {
      const count = this.cards.length;
      if (count < 2) {
        if (this._stackEl) {
          this._stackEl.remove();
          this._stackEl = null;
        }
        return;
      }
      if (!this._stackEl) {
        this._stackEl = el('div', { class: 'pdft-stack' }, [
          el('span', { class: 'pdft-stack-count' }),
          el('button', { type: 'button', text: '全部关闭', onclick: () => this.closeAllCards() }),
        ]);
        this.layer.append(this._stackEl);
      }
      const label = this._stackEl.querySelector('.pdft-stack-count');
      if (label) label.textContent = `${count} 张卡片 · 可拖动`;
    }
  }

  globalThis.PDFT_BUBBLE = { TranslateBubble, BubbleCard, cleanText, version: 2 };
})();
