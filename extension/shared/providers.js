/**
 * providers.js —— 纯翻译服务层（PDF 划词翻译扩展）
 *
 * 设计约束（务必遵守，否则 MV3 service worker 会炸）：
 *   1. 纯 ESM，无任何 chrome.* / DOM / node 专用 API；只用 fetch / AbortController / URL 等标准 API。
 *      因此本文件可以直接在 node 里 `import` 跑测试。
 *   2. 网络请求全部走 fetch，每个请求都有 AbortController 超时。
 *   3. 解析全部是防御式的（可选链 + 类型检查 + 多字段名兼容），任何字段缺失都不允许抛异常；
 *      只有「查询为空」「所有引擎都失败」才 throw（错误信息为中文）。
 *
 * 实测结论（2026-02，node fetch 直连）：
 *   - 有道 jsonapi：国内直连可用，单词信息最全（ec / phrs / blng_sents_part / web_trans / simple）。
 *   - 有道 aidemo 整句翻译：可用；fanyi.youdao.com/translate 目前返回 HTML（已不返回 JSON），仅作死马当活马医的兜底。
 *   - MyMemory：可用，仅整句。
 *   - Google translate.googleapis.com：本机不可达（超时）——设计上必须能优雅降级到下一个引擎。
 *   - CORS：dict.youdao.com 不返回 Access-Control-Allow-Origin，必须在有 host_permissions 的
 *     service worker 里 fetch（manifest 已声明 <all_urls>）；content script 里直接 fetch 会被 CORS 拦。
 */

/* ============================================================
 * 引擎清单（顺序即 ENGINES 声明顺序；ENGINE_IDS 是兜底顺序）
 * ============================================================ */

export const ENGINES = [
  { id: 'youdao', label: '有道词典', hint: '国内可直连，释义/音标/例句最全', dict: true },
  { id: 'google', label: 'Google 翻译', hint: '需要能访问 translate.googleapis.com', dict: true },
  { id: 'mymemory', label: 'MyMemory', hint: '免费整句翻译，仅作兜底', dict: false },
];

/** 兜底顺序（第一个为默认引擎） */
export const ENGINE_IDS = ['youdao', 'google', 'mymemory'];

/* ============================================================
 * 常量
 * ============================================================ */

const DEFAULT_TIMEOUT_MS = 9000;
const MAX_EXAMPLES = 3;
const MAX_PHRASES = 6;
const MAX_DICT_WORDS = 5;
const MAX_DICT_LEN = 48;

const URL_YD_JSONAPI = 'https://dict.youdao.com/jsonapi?q=';
const URL_YD_AIDEMO = 'https://aidemo.youdao.com/trans';
const URL_YD_FANYI = 'https://fanyi.youdao.com/translate';
const URL_YD_TTS = 'https://dict.youdao.com/dictvoice?audio=';
const URL_YD_RESULT = 'https://dict.youdao.com/result?word=';
const URL_GOOGLE_GTX = 'https://translate.googleapis.com/translate_a/single';
const URL_MYMEMORY_API = 'https://api.mymemory.translated.net/get';

/** CJK 判断范围：扩展A + 基本区 + 兼容区 + 几个部首/〇 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3005\u3007]/;

/** 需要剥掉的不可见字符：软连字符、零宽字符、BOM、word-joiner */
const INVISIBLE_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** 首部要剥掉的「引号 / 括号 / 标点」 */
const HEAD_TRIM_RE = /^[\s"'`“”‘’「」『』（）()\[\]【】《》〈〉.,;:!?。，、；：！？…·]+/;

/**
 * 尾部要剥掉的字符。
 * 注意：这里**故意不包含逗号**（`,` `，` `、`）——PDF 划词经常选中被逗号截断的片段，
 * 而实测有道词典对 "Running," 依然能正确命中 running 词条，保留逗号可让上层还原选区原文。
 */
const TAIL_TRIM_RE = /[\s"'`“”‘’「」『』（）()\[\]【】《》〈〉.;:!?。；：！？…·]+$/;

/** 词性前缀，如 "int." / "n." / "adj. & adv." */
const POS_RE = /^([a-z]+\.(?:\s*&\s*[a-z]+\.)*)\s*(.*)$/i;

/** 一句话里多条释义的分隔符 */
const DEF_SPLIT_RE = /；|;/;

/** MyMemory 的配额/限长提示会混进 translatedText，需要过滤 */
const MYMEMORY_WARN_RE = /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR|PLEASE SELECT TWO DISTINCT/i;

/* ============================================================
 * 文本清洗 / 判定
 * ============================================================ */

/**
 * 清洗查询文本：去软连字符与零宽字符 → 折叠空白 → 去首尾引号括号标点。
 * 例：normalizeQuery('  “Running,”\u00AD  ') === 'Running,'
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeQuery(raw) {
  let s = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw);
  s = s.replace(INVISIBLE_RE, '');
  // \s 已含 \u00A0？不含，故显式补上不换行空格与全角空格
  s = s.replace(/[\s\u00A0\u3000]+/g, ' ').trim();
  // 首尾成对包裹的引号/括号可能叠加（如 '("hi").'），循环剥到稳定为止
  for (let i = 0; i < 8; i += 1) {
    const before = s;
    s = s.replace(HEAD_TRIM_RE, '').replace(TAIL_TRIM_RE, '').trim();
    if (s === before || s === '') break;
  }
  return s;
}

/**
 * 是否包含中文字符
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksChinese(text) {
  return CJK_RE.test(typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text));
}

/**
 * 是否适合走词典接口：单词，或 ≤5 个词的英文短语，且长度 ≤48
 * @param {unknown} q
 * @returns {boolean}
 */
export function isDictCandidate(q) {
  const t = normalizeQuery(q);
  if (!t) return false;
  if (t.length > MAX_DICT_LEN) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_DICT_WORDS) return false;
  return true;
}

/* ============================================================
 * 通用小工具（全部防御式，绝不抛异常）
 * ============================================================ */

/** 任意值 → 数组（null/undefined → []，非数组 → [v]） */
function arr(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

/** 任意值 → 去掉首尾空白的字符串（非字符串/数字 → ''） */
function asString(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** 去 HTML 标签（有道例句里会带 <b> 高亮） */
function stripTags(s) {
  return asString(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 取第一个非空字符串：支持候选值，元素本身可以是字符串 / 数组 / 有道风格的 {l:{i}} / {'#text':...}
 * @param {...unknown} candidates
 * @returns {string}
 */
function firstString(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    if (Array.isArray(c)) {
      const s = firstString(...c);
      if (s) return s;
      continue;
    }
    if (typeof c === 'object') {
      const s = firstString(c['#text'], c.i, c.value, c.text, c.l);
      if (s) return s;
      continue;
    }
    const s = asString(c);
    if (s) return s;
  }
  return '';
}

/** 把嵌套结构里所有字符串收集成数组（保留顺序，元素可为字符串/数组/{l:{i}}/{'#text'}） */
function collectStrings(v, out = []) {
  if (v === null || v === undefined) return out;
  if (Array.isArray(v)) {
    for (const item of v) collectStrings(item, out);
    return out;
  }
  if (typeof v === 'object') {
    return collectStrings(v['#text'] ?? v.i ?? v.value ?? v.text ?? v.l, out);
  }
  const s = asString(v);
  if (s) out.push(s);
  return out;
}

/** 去重后 push */
function pushUnique(list, values) {
  for (const v of arr(values)) {
    const s = asString(v);
    if (s && !list.includes(s)) list.push(s);
  }
  return list;
}

/** 空结果骨架 */
function emptyPart() {
  return {
    translation: '',
    meanings: [],
    phonetic: null,
    forms: [],
    examples: [],
    phrases: [],
    sourceUrl: '',
  };
}

/** 结果是否可用：有 translation 或 有 meanings 才算成功 */
function isUsable(part) {
  if (!part) return false;
  if (firstString(part.translation)) return true;
  return Array.isArray(part.meanings) && part.meanings.length > 0;
}

/** 把 primary 里缺失的字段用 extra 补齐（用于「词典空 → 整句兜底」的结果合并） */
function mergeParts(primary, extra) {
  if (!extra) return primary;
  if (!primary) return extra;
  return {
    translation: firstString(primary.translation) || firstString(extra.translation),
    meanings: arr(primary.meanings).length ? primary.meanings : arr(extra.meanings),
    phonetic: primary.phonetic ?? extra.phonetic ?? null,
    forms: arr(primary.forms).length ? primary.forms : arr(extra.forms),
    examples: arr(primary.examples).length ? primary.examples : arr(extra.examples),
    phrases: arr(primary.phrases).length ? primary.phrases : arr(extra.phrases),
    sourceUrl: firstString(primary.sourceUrl) || firstString(extra.sourceUrl),
  };
}

/* ============================================================
 * 网络层：带超时的 JSON 请求
 * ============================================================ */

/**
 * 带 AbortController 超时的 fetch + JSON 解析；失败一律抛中文 Error。
 * @param {string} url
 * @param {number} timeoutMs
 * @param {string} label 引擎名，用于错误信息
 * @returns {Promise<any>}
 */
async function fetchJson(url, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutError = () => new Error(`${label} 请求超时（超过 ${timeoutMs} 毫秒），已中止`);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json, text/plain, */*' },
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw timeoutError();
      throw new Error(`${label} 网络请求失败：${(err && err.message) || '未知错误'}`);
    }
    if (!res || !res.ok) {
      throw new Error(`${label} 返回 HTTP ${res ? res.status : '未知'}，接口可能已限流或变更`);
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (err && err.name === 'AbortError') throw timeoutError();
      throw new Error(`${label} 读取响应失败：${(err && err.message) || '未知错误'}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} 返回的不是合法 JSON（可能被反爬拦截或接口已变更）`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * 有道词典解析
 * ============================================================ */

/** 音标：ec.word[0] → simple.word[0] 逐级退化 */
function parsePhonetic(word, simple) {
  const us = firstString(word?.usphone, simple?.usphone);
  const uk = firstString(word?.ukphone, simple?.ukphone);
  if (!us && !uk) return null;
  const out = {};
  if (uk) out.uk = uk;
  if (us) out.us = us;
  return out;
}

/** "int. 喂，你好（…）；喂，你好（…）" → { pos:'int.', defs:[...] } */
function splitTrLine(line) {
  const text = asString(line);
  if (!text) return { pos: '', defs: [] };
  const m = POS_RE.exec(text);
  const pos = m ? asString(m[1]) : '';
  const body = m ? asString(m[2]) : text;
  const defs = body
    .split(DEF_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  return { pos, defs: defs.length ? defs : body ? [body] : [] };
}

/**
 * 释义：ec.word[0].trs[].tr[].l.i[]；相同词性合并。
 * 实测 tr 在 ec 里是数组，但在 ce（中文查词）里 i 可能是混合数组（字符串 + {#text}），都已兼容。
 */
function parseEcMeanings(word) {
  const out = [];
  const index = new Map();
  for (const group of arr(word?.trs)) {
    for (const tr of arr(group?.tr ?? group)) {
      const lines = collectStrings(tr?.l?.i ?? tr?.l ?? tr?.pos ?? tr);
      for (const line of lines) {
        const { pos, defs } = splitTrLine(line);
        if (!defs.length) continue;
        if (index.has(pos)) {
          pushUnique(index.get(pos).defs, defs);
        } else {
          const entry = { pos, defs: defs.slice() };
          index.set(pos, entry);
          out.push(entry);
        }
      }
    }
  }
  return out;
}

/** 词形变化：ec.word[0].wfs[].wf.{name,value}（兼容 wfs 直接是 {name,value}） */
function parseForms(word) {
  const out = [];
  for (const item of arr(word?.wfs)) {
    const wf = item?.wf ?? item;
    const name = firstString(wf?.name);
    const value = firstString(wf?.value);
    if (name && value) out.push({ name, value });
  }
  return out;
}

/**
 * 双语例句：blng_sents_part['sentence-pair'][]
 * 实测字段名：sentence（干净英文）+ sentence-eng（含 <b> 高亮）+ sentence-translation（中文）
 * 其余变体（sentence-en / sentence-zh / translation 等）一并兼容探测。
 */
function parseExamples(blngSentsPart) {
  const pairs = arr(
    blngSentsPart?.['sentence-pair'] ?? blngSentsPart?.['sentence_pair'] ?? blngSentsPart?.sentencePair,
  );
  const out = [];
  for (const p of pairs) {
    const en = stripTags(
      firstString(p?.sentence, p?.['sentence-eng'], p?.['sentence-en'], p?.en, p?.english),
    );
    const zh = stripTags(
      firstString(
        p?.['sentence-translation'],
        p?.['sentence-zh'],
        p?.['sentence-chinese'],
        p?.translation,
        p?.zh,
      ),
    );
    if (en && zh) out.push({ en, zh });
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out;
}

/**
 * 短语搭配：phrs.phrs[]
 * 实测结构（关键！tr 是**对象**不是数组）：
 *   { "phr": { "headword": { "l": { "i": "say hello" } },
 *              "trs": [ { "tr": { "l": { "i": "打招呼；问好" } } } ] } }
 * 而 ec.word[].trs[].tr 才是数组。这里两种都兼容。
 */
function parsePhrases(phrs) {
  const list = arr(phrs?.phrs ?? phrs?.phr ?? phrs);
  const out = [];
  for (const item of list) {
    const phr = item?.phr ?? item;
    const en = stripTags(
      firstString(phr?.headword?.l?.i, phr?.headword, phr?.['return-phrase']?.l?.i, phr?.key),
    );
    const zhList = [];
    for (const t of arr(phr?.trs)) {
      for (const tr of arr(t?.tr ?? t)) {
        pushUnique(zhList, collectStrings(tr?.l?.i ?? tr?.l?.value ?? tr?.['#text'] ?? tr));
      }
    }
    const zh = zhList.join('；');
    if (en && zh) out.push({ en, zh });
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

/**
 * 无 ec 时的兜底：web_trans['web-translation'] → meanings:[{pos:'网络', defs:[...]}]
 * 只取「key 与查询词匹配」的条目（否则会把 Hello Kitty→凯蒂猫 这种串进来）；
 * 一个都不匹配时退化为第一条。
 */
function parseWebTrans(webTrans, query) {
  const entries = arr(webTrans?.['web-translation'] ?? webTrans?.webTranslation ?? webTrans);
  if (!entries.length) return { meanings: [], translation: '' };
  const norm = (s) => asString(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const q = norm(query);
  const matched = entries.filter((e) => q && norm(e?.key) === q);
  const use = matched.length ? matched : entries.slice(0, 1);
  const defs = [];
  for (const e of use) {
    for (const t of arr(e?.trans)) pushUnique(defs, firstString(t?.value, t?.['#text'], t));
  }
  if (!defs.length) return { meanings: [], translation: '' };
  return {
    meanings: [{ pos: '网络', defs: defs.slice(0, 6) }],
    translation: defs[0],
  };
}

/** 解析有道 jsonapi 大 JSON → 统一的内部 part */
function parseYoudaoDict(json, query) {
  const word = arr(json?.ec?.word)[0] ?? null;
  const simple = arr(json?.simple?.word)[0] ?? null;

  const part = emptyPart();
  part.phonetic = parsePhonetic(word, simple);
  part.forms = parseForms(word);
  part.meanings = parseEcMeanings(word);
  part.examples = parseExamples(json?.blng_sents_part);
  part.phrases = parsePhrases(json?.phrs);
  part.translation = part.meanings.length ? firstString(part.meanings[0].defs[0]) : '';

  if (!part.meanings.length) {
    const web = parseWebTrans(json?.web_trans, query);
    if (web.meanings.length) {
      part.meanings = web.meanings;
      part.translation = firstString(web.translation);
    }
  }
  if (part.meanings.length) {
    part.sourceUrl = URL_YD_RESULT + encodeURIComponent(query) + '&lang=en';
  }
  return part;
}

/* ============================================================
 * 有道：整句翻译
 * ============================================================ */

/**
 * aidemo（实测可用）：{ translation: ["..."], errorCode: 0 }
 * 实测坑：语言码必须是 **zh-CHS**，传 zh-CN 会返回 { errorCode: 102 }（无 translation）；
 * 且它不支持中译英（from=zh-CHS&to=en → { errorCode: 411 }）。
 */
async function youdaoAidemo(ctx) {
  const from = mapLangYoudao(ctx.direction.from);
  const to = mapLangYoudao(ctx.direction.to);
  const url =
    `${URL_YD_AIDEMO}?q=${encodeURIComponent(ctx.query)}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const json = await fetchJson(url, ctx.timeoutMs, '有道翻译');
  const code = Number(json?.errorCode);
  if (Number.isFinite(code) && code !== 0) {
    return Object.assign(emptyPart(), { __note: `aidemo 返回 errorCode=${code}` });
  }
  const translation = firstString(collectStrings(json?.translation).join(''), json?.translation);
  if (!translation) return emptyPart();
  const part = emptyPart();
  part.translation = translation;
  // aidemo 偶尔也会带词典信息，能捞就捞（字段可选，缺失不影响）
  const dictWord = arr(json?.dict?.word ?? json?.ec?.word)[0] ?? null;
  if (dictWord) {
    part.meanings = parseEcMeanings(dictWord);
    part.phonetic = parsePhonetic(dictWord, null);
    part.forms = parseForms(dictWord);
  }
  return part;
}

/** fanyi 老接口：{ translateResult: [[{ tgt }]] }（当前实测返回 HTML，只作兜底） */
async function youdaoFanyi(ctx) {
  const type = mapLangYoudao(ctx.direction.from) === 'en' ? 'EN2ZH_CN' : 'ZH_CN2EN';
  const url = `${URL_YD_FANYI}?&doctype=json&type=${type}&i=${encodeURIComponent(ctx.query)}`;
  const json = await fetchJson(url, ctx.timeoutMs, '有道翻译（备用接口）');
  const rows = arr(arr(json?.translateResult)[0]);
  const translation = rows.map((r) => firstString(r?.tgt)).filter(Boolean).join('');
  if (!translation) return emptyPart();
  const part = emptyPart();
  part.translation = translation;
  return part;
}

/** 有道整句：aidemo 优先，失败再试 fanyi（都不支持中译英时快速失败，交给下一个引擎） */
async function youdaoSentence(ctx) {
  const errors = [];
  try {
    const main = await youdaoAidemo(ctx);
    if (isUsable(main)) return main;
    errors.push(firstString(main?.__note) || 'aidemo 未返回译文');
  } catch (err) {
    errors.push((err && err.message) || 'aidemo 失败');
  }
  try {
    const alt = await youdaoFanyi(ctx);
    if (isUsable(alt)) return alt;
    errors.push('备用接口未返回译文');
  } catch (err) {
    errors.push((err && err.message) || '备用接口失败');
  }
  return Object.assign(emptyPart(), { __note: errors.join('；') });
}

/** 有道词典接口（jsonapi）单次尝试 */
async function youdaoDictOnce(ctx) {
  const url = URL_YD_JSONAPI + encodeURIComponent(ctx.query);
  const json = await fetchJson(url, ctx.timeoutMs, '有道词典');
  return parseYoudaoDict(json, ctx.query);
}

/**
 * 有道总入口：词/短语走词典接口，长句走整句接口。
 * 实测 aidemo 不支持中译英、fanyi 已失效，所以任一路径拿不到结果时，
 * 同引擎内再试另一条路径并合并（避免白白丢掉一个可用引擎）。
 */
async function youdaoLookup(ctx) {
  if (ctx.mode === 'dict') {
    let dictPart = emptyPart();
    let dictError = null;
    try {
      dictPart = await youdaoDictOnce(ctx);
    } catch (err) {
      dictError = err;
    }
    if (isUsable(dictPart)) return dictPart;

    // 词典没结果（生僻词 / 未收录短语）：同引擎整句兜底一次
    const sentPart = await youdaoSentence(ctx);
    const merged = mergeParts(sentPart, dictPart);
    if (isUsable(merged)) return merged;
    if (dictError) throw dictError;
    return merged;
  }

  // 长句：整句接口优先
  const sentPart = await youdaoSentence(ctx);
  if (isUsable(sentPart) && firstString(sentPart.translation)) return sentPart;

  // 整句拿不到（如中译英、aidemo 异常）：退化到词典接口（中文词条 web_trans 也能给英文）
  let dictPart = emptyPart();
  let dictError = null;
  try {
    dictPart = await youdaoDictOnce(ctx);
  } catch (err) {
    dictError = err;
  }
  const merged = mergeParts(sentPart, dictPart);
  if (isUsable(merged)) return merged;
  if (dictError) throw dictError;
  return merged;
}

/* ============================================================
 * Google 翻译（备用）
 * ============================================================ */

async function googleLookup(ctx) {
  const sl = mapLangOut(ctx.direction.from);
  const tl = mapLangOut(ctx.direction.to);
  const url =
    `${URL_GOOGLE_GTX}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}` +
    `&dj=1&dt=t&dt=bd&q=${encodeURIComponent(ctx.query)}`;
  const json = await fetchJson(url, ctx.timeoutMs, 'Google 翻译');

  const part = emptyPart();
  const sentences = arr(json?.sentences);
  part.translation = sentences
    .map((s) => firstString(s?.trans, s?.orig))
    .filter(Boolean)
    .join('');
  // 若 sentences 结构异常，退化到最原始的数组形态 [[["译文","原文",...]],...]
  if (!part.translation && Array.isArray(json?.sentences) === false) {
    const raw = arr(arr(json)[0]);
    part.translation = raw.map((r) => firstString(arr(r)[0])).filter(Boolean).join('');
  }
  const meanings = [];
  for (const d of arr(json?.dict)) {
    const defs = collectStrings(d?.terms ?? d?.entry);
    if (defs.length) meanings.push({ pos: firstString(d?.pos), defs });
  }
  part.meanings = meanings;
  if (!part.translation && meanings.length) part.translation = firstString(meanings[0].defs[0]);
  if (isUsable(part)) {
    part.sourceUrl = `https://translate.google.com/?sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&text=${encodeURIComponent(ctx.query)}&op=translate`;
  }
  return part;
}

/* ============================================================
 * MyMemory（最后兜底，仅整句）
 * ============================================================ */

async function mymemoryLookup(ctx) {
  const from = mapLangOut(ctx.direction.from);
  const to = mapLangOut(ctx.direction.to);
  const url =
    `${URL_MYMEMORY_API}?q=${encodeURIComponent(ctx.query)}` +
    `&langpair=${encodeURIComponent(`${from}|${to}`)}`;
  const json = await fetchJson(url, ctx.timeoutMs, 'MyMemory');
  const raw = firstString(json?.responseData?.translatedText);
  const part = emptyPart();
  if (!raw || MYMEMORY_WARN_RE.test(raw)) return part; // 配额/限长提示不算译文
  part.translation = raw;
  part.sourceUrl = `https://mymemory.translated.net/en/${encodeURIComponent(from)}/${encodeURIComponent(to)}/${encodeURIComponent(ctx.query)}`;
  return part;
}

/* ============================================================
 * 引擎调度
 * ============================================================ */

/** 各引擎统一的语言代码（Google / MyMemory 用 zh-CN，有道用 zh-CHS） */
function mapLangOut(code) {
  const c = asString(code);
  const table = {
    'zh-CHS': 'zh-CN',
    'zh-CN': 'zh-CN',
    'zh-TW': 'zh-TW',
    'zh-HK': 'zh-TW',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    fr: 'fr',
    de: 'de',
    es: 'es',
    ru: 'ru',
  };
  return table[c] ?? (c || 'en');
}

/**
 * 有道的语言代码（与 Google 不同！）。
 * 实测 aidemo：to=zh-CHS 才有译文，to=zh-CN 直接 { errorCode: 102 }。
 */
function mapLangYoudao(code) {
  const c = asString(code);
  if (!c) return 'en';
  if (c === 'zh-CN' || c === 'zh-CHS' || c === 'zh-Hans' || c === 'zh') return 'zh-CHS';
  if (c === 'zh-TW' || c === 'zh-HK' || c === 'zh-CHT' || c === 'zh-Hant') return 'zh-CHT';
  return c;
}

/** 引擎元信息 */
function engineMeta(id) {
  return ENGINES.find((e) => e.id === id) ?? { id, label: id, hint: '', dict: false };
}

/** 尝试顺序：[options.engine, ...其余引擎] */
function engineOrder(preferred) {
  const p = asString(preferred);
  const head = p || ENGINE_IDS[0];
  return [head, ...ENGINE_IDS.filter((id) => id !== head)];
}

/** 超时参数归一化：非法值 → 默认 9s，合法值夹到 [500, 60000] */
function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 500), 60000);
}

/**
 * 发音（有道 TTS mp3）。仅当查询不含中文时给出；两个引擎兜底失败也仍可用，故不绑定引擎。
 * @param {string} query
 * @returns {{uk?: string, us?: string} | null}
 */
function buildAudio(query) {
  if (!query || looksChinese(query)) return null;
  const q = encodeURIComponent(query);
  return { uk: `${URL_YD_TTS}${q}&type=1`, us: `${URL_YD_TTS}${q}&type=2` };
}

/** 词典详情页 */
function sourceUrlFor(engineId, ctx) {
  const q = encodeURIComponent(ctx.query);
  if (engineId === 'youdao') return `${URL_YD_RESULT}${q}&lang=en`;
  if (engineId === 'google') {
    const sl = encodeURIComponent(mapLangOut(ctx.direction.from));
    const tl = encodeURIComponent(mapLangOut(ctx.direction.to));
    return `https://translate.google.com/?sl=${sl}&tl=${tl}&text=${q}&op=translate`;
  }
  if (engineId === 'mymemory') {
    const from = encodeURIComponent(mapLangOut(ctx.direction.from));
    const to = encodeURIComponent(mapLangOut(ctx.direction.to));
    return `https://mymemory.translated.net/en/${from}/${to}/${q}`;
  }
  return '';
}

/** 单个引擎调用 */
async function runEngine(engineId, ctx) {
  if (engineId === 'youdao') return youdaoLookup(ctx);
  if (engineId === 'google') return googleLookup(ctx);
  if (engineId === 'mymemory') return mymemoryLookup(ctx);
  throw new Error(`未知的翻译引擎：${engineId}`);
}

/** 内部 part → 对外契约对象 */
function finalize(engineId, meta, ctx, part) {
  return {
    query: ctx.query,
    mode: ctx.mode,
    translation: firstString(part?.translation),
    phonetic: part?.phonetic ?? null,
    meanings: arr(part?.meanings).filter((m) => m && Array.isArray(m.defs) && m.defs.length),
    forms: arr(part?.forms).filter((f) => f && firstString(f.name) && firstString(f.value)),
    examples: arr(part?.examples)
      .filter((e) => e && firstString(e.en) && firstString(e.zh))
      .slice(0, MAX_EXAMPLES),
    phrases: arr(part?.phrases)
      .filter((p) => p && firstString(p.en) && firstString(p.zh))
      .slice(0, MAX_PHRASES),
    audio: buildAudio(ctx.query),
    engine: engineId,
    engineLabel: meta.label,
    sourceUrl: firstString(part?.sourceUrl) || sourceUrlFor(engineId, ctx),
    direction: { from: ctx.direction.from, to: ctx.direction.to },
  };
}

/* ============================================================
 * 对外主函数
 * ============================================================ */

/**
 * 查询并翻译。
 *
 * @param {string} text 选中的原文
 * @param {{ engine?: string, targetLang?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{
 *   query: string, mode: 'dict'|'sentence', translation: string,
 *   phonetic: {uk?: string, us?: string}|null,
 *   meanings: Array<{pos: string, defs: string[]}>,
 *   forms: Array<{name: string, value: string}>,
 *   examples: Array<{en: string, zh: string}>,
 *   phrases: Array<{en: string, zh: string}>,
 *   audio: {uk?: string, us?: string}|null,
 *   engine: string, engineLabel: string, sourceUrl: string,
 *   direction: {from: string, to: string}
 * }>}
 * @throws {Error} 查询为空，或所有引擎都失败（中文错误信息）
 *
 * 已知行为（供 UI 层参考）：
 *   - 有道 aidemo 对「查不到的词」会原样回显，此时 translation === query 且 meanings 为空，
 *     UI 可据此显示「未收录」而不是把原文当译文展示。
 *   - 有道词典（jsonapi）本身只做英译中，options.targetLang 只对 Google / MyMemory 生效。
 */
export async function lookup(text, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const query = normalizeQuery(text);
  if (!query) {
    throw new Error('查询内容为空：请先选中需要翻译的单词或句子。');
  }

  const targetLang = firstString(opts.targetLang) || 'zh-CN';
  const timeoutMs = normalizeTimeout(opts.timeoutMs);
  const mode = isDictCandidate(query) ? 'dict' : 'sentence';
  const direction = looksChinese(query)
    ? { from: 'zh-CHS', to: 'en' }
    : { from: 'en', to: targetLang };

  const ctx = { query, mode, direction, targetLang, timeoutMs };
  const order = engineOrder(opts.engine);
  const attempts = [];

  for (const engineId of order) {
    const meta = engineMeta(engineId);
    try {
      const part = await runEngine(engineId, ctx);
      if (isUsable(part)) return finalize(engineId, meta, ctx, part);
      attempts.push(`${meta.label}：未返回可用结果`);
    } catch (err) {
      attempts.push(`${meta.label}：${(err && err.message) || '未知错误'}`);
    }
  }

  throw new Error(
    `翻译失败：所有引擎均不可用（${attempts.join('；')}）。请检查网络后重试，或在设置里更换翻译引擎。`,
  );
}
