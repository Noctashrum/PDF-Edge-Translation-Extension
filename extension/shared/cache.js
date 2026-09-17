/**
 * shared/cache.js — 翻译结果本地缓存（chrome.storage.local）
 *
 * 划词翻译会被反复触发（同一个词看很多次），缓存能省掉绝大多数网络请求。
 * 结构：`tc:<key>` → { t: 时间戳, v: 结果 }，另用 `tc_index` 保存写入顺序用于淘汰。
 */

const PREFIX = 'tc:';
const INDEX_KEY = 'tc_index';
const MAX_ENTRIES = 1200;
const PRUNE_COUNT = 300;

async function readIndex() {
  const got = await chrome.storage.local.get(INDEX_KEY);
  const idx = got?.[INDEX_KEY];
  return Array.isArray(idx) ? idx : [];
}

/** 读缓存，未命中返回 null */
export async function cacheGet(key) {
  if (!key) return null;
  const k = PREFIX + key;
  const got = await chrome.storage.local.get(k);
  const entry = got?.[k];
  return entry && typeof entry === 'object' && entry.v ? entry.v : null;
}

/** 写缓存（超上限时淘汰最旧的一批） */
export async function cachePut(key, value) {
  if (!key || !value) return;
  const k = PREFIX + key;
  await chrome.storage.local.set({ [k]: { t: Date.now(), v: value } });

  let idx = await readIndex();
  idx = idx.filter((x) => x !== key);
  idx.push(key);
  if (idx.length > MAX_ENTRIES) {
    const drop = idx.slice(0, PRUNE_COUNT);
    idx = idx.slice(PRUNE_COUNT);
    await chrome.storage.local.remove(drop.map((x) => PREFIX + x));
  }
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
}

/** 清空缓存 */
export async function cacheClear() {
  const idx = await readIndex();
  await chrome.storage.local.remove([...idx.map((x) => PREFIX + x), INDEX_KEY]);
}

/** 缓存条目数 */
export async function cacheStats() {
  const idx = await readIndex();
  return { count: idx.length, max: MAX_ENTRIES };
}
