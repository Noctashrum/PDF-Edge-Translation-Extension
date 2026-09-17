/**
 * popup/popup.js — 工具栏弹窗：总开关、快速开关、当前标签页一键转阅读器
 */
import { ENGINES } from '../shared/providers.js';

const $ = (id) => document.getElementById(id);
let settings = {};
let tab = null;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, error: '扩展后台未就绪' };
  }
}

function renderSettings() {
  $('enabled').checked = settings.enabled !== false;
  $('interceptPdf').checked = settings.interceptPdf !== false;
  $('enableOnWebPages').checked = settings.enableOnWebPages !== false;
  $('engine').value = settings.engine || 'youdao';

  const off = settings.enabled === false;
  $('statusLine').textContent = off
    ? '已暂停'
    : settings.interceptPdf !== false
      ? 'PDF 划词翻译已开启'
      : '仅网页划词（PDF 交给 Edge）';
}

async function renderTabCard() {
  if (!tab?.id) return;
  const reply = await send({ type: 'getTabState', tabId: tab.id });
  const card = $('tabCard');
  card.hidden = false;
  const url = reply?.url || tab.url || '';
  $('tabUrl').textContent = url.length > 120 ? url.slice(0, 120) + '…' : url;

  const btn = $('openViewerBtn');
  const note = $('tabNote');
  btn.hidden = true;
  note.hidden = true;

  if (reply?.isViewer) {
    note.hidden = false;
    note.textContent = '当前已在本扩展的阅读器中，可直接划词翻译。';
  } else if (reply?.embeddedPdf) {
    btn.hidden = false;
    btn.textContent = '打开页面内嵌的 PDF';
    btn.dataset.url = reply.embeddedPdf;
    note.hidden = false;
    note.textContent = '检测到页面里内嵌了 PDF，点上面的按钮可以在翻译阅读器里打开它。';
  } else if (reply?.looksLikePdf || /\.pdf([?#].*)?$/i.test(url)) {
    btn.hidden = false;
    btn.dataset.url = url;
    btn.textContent = '在翻译阅读器中打开';
  } else if (/^edge:|^chrome:|^about:/.test(url)) {
    note.hidden = false;
    note.textContent = '浏览器内部页面不支持扩展划词。';
  } else {
    note.hidden = false;
    note.textContent = '当前页面不是 PDF。在 PDF 标签页里可以一键转入翻译阅读器。';
  }
}

async function patch(key, value) {
  const reply = await send({ type: 'setSettings', patch: { [key]: value } });
  if (reply?.ok) {
    settings = reply.settings;
    renderSettings();
  }
}

async function init() {
  $('engine').append(
    ...ENGINES.map((engine) => {
      const option = document.createElement('option');
      option.value = engine.id;
      option.textContent = engine.label;
      return option;
    }),
  );

  const [reply, tabs] = await Promise.all([
    send({ type: 'getSettings' }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  settings = reply?.settings || {};
  tab = tabs?.[0] || null;
  renderSettings();
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  await renderTabCard();
}

$('enabled').addEventListener('change', (e) => void patch('enabled', e.target.checked));
$('interceptPdf').addEventListener('change', (e) => void patch('interceptPdf', e.target.checked));
$('enableOnWebPages').addEventListener('change', (e) => void patch('enableOnWebPages', e.target.checked));
$('engine').addEventListener('change', (e) => void patch('engine', e.target.value));
$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$('openViewerBtn').addEventListener('click', async (e) => {
  const url = e.currentTarget.dataset.url;
  if (!url) return;
  await send({ type: 'openInViewer', tabId: tab?.id, url });
  window.close();
});

void init();
