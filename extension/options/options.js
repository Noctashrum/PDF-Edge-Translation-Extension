/**
 * options/options.js — 设置页
 */
import { ENGINES } from '../shared/providers.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const BOOLEAN_KEYS = [
  'enabled',
  'interceptPdf',
  'enableOnWebPages',
  'translateOnSelect',
  'translateOnDoubleClick',
  'showPhonetic',
  'showExamples',
  'rememberPosition',
];
const SELECT_KEYS = ['engine', 'targetLang', 'viewerTheme', 'defaultZoom'];

let settings = { ...DEFAULT_SETTINGS };

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, error: '扩展后台未就绪，请重新加载扩展' };
  }
}

function renderEngines() {
  const host = $('engines');
  host.textContent = '';
  for (const engine of ENGINES) {
    const label = document.createElement('label');
    label.className = 'engine' + (settings.engine === engine.id ? ' is-active' : '');
    label.dataset.engine = engine.id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'engine';
    radio.value = engine.id;
    radio.checked = settings.engine === engine.id;
    radio.addEventListener('change', () => void patch('engine', engine.id));

    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = engine.label;
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = engine.hint;
    text.append(name, hint);

    label.append(radio, text);
    host.append(label);
  }
}

function render() {
  for (const key of BOOLEAN_KEYS) {
    const input = $(key);
    if (input) input.checked = settings[key] !== false;
  }
  for (const key of SELECT_KEYS) {
    const select = $(key);
    if (select) select.value = String(settings[key]);
  }
  renderEngines();
}

async function patch(key, value) {
  const reply = await send({ type: 'setSettings', patch: { [key]: value } });
  if (reply?.ok) {
    settings = reply.settings;
    render();
  }
}

async function refreshDiagnostics() {
  const ping = await send({ type: 'ping' });
  const cache = await send({ type: 'cacheStats' });
  const parts = [];
  parts.push('扩展 v' + chrome.runtime.getManifest().version);
  if (ping?.ok) parts.push('PDF 接管：URL 后缀 + 响应头双重判断');
  $('diagnostics').textContent = parts.join(' · ');
  $('cacheCount').textContent = cache?.count != null ? `${cache.count} 条` : '–';
  $('version').textContent = 'PDF 划词翻译 v' + chrome.runtime.getManifest().version + '（基于 pdf.js）';
}

async function runTest() {
  const text = $('testInput').value.trim() || 'hello';
  const box = $('testResult');
  box.hidden = false;
  box.textContent = `正在查询「${text}」…`;
  const reply = await send({ type: 'translate', text });
  if (!reply?.ok) {
    box.textContent = '✗ 失败：' + (reply?.error || '未知错误');
    return;
  }
  const r = reply.result;
  const lines = [
    `引擎：${r.engineLabel || r.engine}${r.cached ? '（缓存命中）' : ''}   模式：${r.mode}`,
    `原文：${r.query}`,
    r.phonetic ? `音标：英 /${r.phonetic.uk || '-'}/  美 /${r.phonetic.us || '-'}/` : null,
    r.translation ? `译文：${r.translation}` : null,
    ...(r.meanings || []).map((m) => `${m.pos || '·'} ${(m.defs || []).join('；')}`),
    (r.forms || []).length ? '词形：' + r.forms.map((f) => `${f.value}(${f.name})`).join('、') : null,
    (r.examples || []).length ? '例句：\n' + r.examples.map((e) => `  ${e.en}\n  ${e.zh || ''}`).join('\n') : null,
  ].filter(Boolean);
  box.textContent = '✓ 成功\n' + lines.join('\n');
}

async function init() {
  const reply = await send({ type: 'getSettings' });
  settings = { ...DEFAULT_SETTINGS, ...(reply?.settings || {}) };
  render();
  await refreshDiagnostics();

  if (new URLSearchParams(location.search).get('welcome') === '1') $('welcome').hidden = false;

  for (const key of BOOLEAN_KEYS) {
    $(key)?.addEventListener('change', (e) => void patch(key, e.target.checked));
  }
  for (const key of SELECT_KEYS) {
    $(key)?.addEventListener('change', (e) => void patch(key, e.target.value));
  }

  $('testBtn').addEventListener('click', () => void runTest());
  $('testInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runTest();
  });

  $('clearCache').addEventListener('click', async () => {
    await send({ type: 'clearCache' });
    await refreshDiagnostics();
    $('cacheCount').textContent = '已清空';
  });

  $('resetBtn').addEventListener('click', async () => {
    const r = await send({ type: 'setSettings', patch: { ...DEFAULT_SETTINGS } });
    if (r?.ok) {
      settings = r.settings;
      render();
    }
  });

  chrome.storage.onChanged.addListener(async () => {
    const next = await send({ type: 'getSettings' });
    if (next?.ok) {
      settings = next.settings;
      render();
    }
  });
}

void init();
