/**
 * providers.test.mjs —— extension/shared/providers.js 的真实联网回归测试
 *
 * 运行：node tests/providers.test.mjs     （Node >= 20，原生 fetch / ESM，无第三方依赖）
 * 全部通过退出码 0；任一失败 process.exitCode = 1。
 *
 * 说明：本机实测 translate.googleapis.com 不可达（超时，属预期），
 * 因此「Google」只验证失败时能优雅降级换下一个引擎，不断言 Google 成功。
 */

import assert from 'node:assert/strict';
import {
  ENGINES,
  ENGINE_IDS,
  normalizeQuery,
  looksChinese,
  isDictCandidate,
  lookup,
} from '../extension/shared/providers.js';

/* ---------------- 极简测试运行器 ---------------- */

let passed = 0;
const failures = [];

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}  (${Date.now() - started}ms)`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}  (${Date.now() - started}ms)`);
    console.log(`      ${err && err.message}`);
  }
}

/* ---------------- 0. 契约：引擎清单 ---------------- */

await test('契约：ENGINES / ENGINE_IDS 形状与顺序', () => {
  assert.deepEqual(
    ENGINES.map((e) => e.id),
    ['youdao', 'google', 'mymemory'],
  );
  assert.deepEqual(ENGINE_IDS, ['youdao', 'google', 'mymemory']);
  for (const e of ENGINES) {
    assert.equal(typeof e.label, 'string');
    assert.ok(e.label.length > 0);
    assert.equal(typeof e.hint, 'string');
    assert.equal(typeof e.dict, 'boolean');
  }
  assert.equal(ENGINES.find((e) => e.id === 'youdao').dict, true);
  assert.equal(ENGINES.find((e) => e.id === 'mymemory').dict, false);
});

/* ---------------- 1. normalizeQuery ---------------- */

await test('normalizeQuery：去软连字符 / 折叠空白 / 去首尾引号标点', () => {
  // 首尾的 “ ” 与软连字符 \u00AD 被去掉，空白折叠；
  // 尾随逗号保留（实测有道 'Running,' 仍能命中 running 词条，便于还原选区原文）
  assert.equal(normalizeQuery('  “Running,”\u00AD  '), 'Running,');
  assert.equal(normalizeQuery('\u200Bhello\uFEFF'), 'hello');
  assert.equal(normalizeQuery('  machine   learning \n'), 'machine learning');
  assert.equal(normalizeQuery('“hello”'), 'hello');
  assert.equal(normalizeQuery('(hello).'), 'hello');
  assert.equal(normalizeQuery('   '), '');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery(undefined), '');
  assert.equal(typeof normalizeQuery(123), 'string');
});

/* ---------------- 2. looksChinese ---------------- */

await test('looksChinese：中文 true / 英文 false', () => {
  assert.equal(looksChinese('你好'), true);
  assert.equal(looksChinese('hello'), false);
  assert.equal(looksChinese('机器学习 machine'), true);
  assert.equal(looksChinese(''), false);
});

/* ---------------- 3. isDictCandidate ---------------- */

await test('isDictCandidate：单词/短短语 true，长句 false', () => {
  assert.equal(isDictCandidate('hello'), true);
  assert.equal(isDictCandidate('machine learning'), true);
  assert.equal(isDictCandidate('this is a much longer sentence with many words in it'), false);
  assert.equal(isDictCandidate(''), false);
  assert.equal(isDictCandidate('   '), false);
  // 6 个词 → 整句
  assert.equal(isDictCandidate('one two three four five six'), false);
});

/* ---------------- 4. 单词查词（有道主力，完整字段） ---------------- */

let helloResult = null;

await test("lookup('hello')：有道词典 mode/释义/音标/翻译/发音/例句或短语", async () => {
  const r = await lookup('hello');
  helloResult = r;
  console.log('\n----- lookup(\'hello\') 完整结果 -----');
  console.log(JSON.stringify(r, null, 2));
  console.log('------------------------------------\n');

  assert.equal(r.query, 'hello');
  assert.equal(r.mode, 'dict');
  assert.equal(r.engine, 'youdao');
  assert.equal(r.engineLabel, '有道词典');
  assert.deepEqual(r.direction, { from: 'en', to: 'zh-CN' });

  assert.ok(Array.isArray(r.meanings), 'meanings 必须是数组');
  assert.ok(r.meanings.length >= 2, `期望 meanings.length >= 2，实际 ${r.meanings.length}`);
  for (const m of r.meanings) {
    assert.equal(typeof m.pos, 'string', 'pos 必须是字符串（无词性时为空串）');
    assert.ok(Array.isArray(m.defs) && m.defs.length > 0, 'defs 必须是非空数组');
    for (const d of m.defs) assert.equal(typeof d, 'string');
  }

  assert.ok(r.phonetic && (r.phonetic.us || r.phonetic.uk), 'phonetic.us / phonetic.uk 至少有一个');
  assert.ok(r.phonetic.us, 'phonetic.us 应存在');

  assert.equal(typeof r.translation, 'string');
  assert.ok(r.translation.length > 0, 'translation 不能为空');

  assert.ok(r.audio && r.audio.us, 'audio.us 应存在');
  assert.ok(r.audio.us.includes('dictvoice'), `audio.us 应包含 dictvoice，实际：${r.audio.us}`);
  assert.ok(r.audio.uk.includes('dictvoice'), 'audio.uk 应包含 dictvoice');

  assert.ok(
    r.examples.length > 0 || r.phrases.length > 0,
    'examples 或 phrases 至少一项非空',
  );
  assert.ok(r.examples.length <= 3, 'examples 最多 3 条');
  assert.ok(r.phrases.length <= 6, 'phrases 最多 6 条');
  for (const e of r.examples) {
    assert.ok(e.en && e.zh, '例句必须同时有 en / zh');
  }
  for (const p of r.phrases) {
    assert.ok(p.en && p.zh, '短语必须同时有 en / zh');
  }

  assert.ok(Array.isArray(r.forms), 'forms 必须是数组');
  assert.ok(r.sourceUrl.startsWith('https://dict.youdao.com/result?word='), 'sourceUrl 应是有道详情页');
  assert.ok(r.sourceUrl.includes('lang=en'));
});

/* ---------------- 5. 句中词形 ---------------- */

await test("lookup('running')：至少能拿到 meanings，不抛异常", async () => {
  const r = await lookup('running');
  assert.equal(r.mode, 'dict');
  assert.ok(r.translation || r.meanings.length, 'translation 或 meanings 至少一项非空');
  assert.ok(r.meanings.length >= 1, `期望至少 1 组释义，实际 ${r.meanings.length}`);
  const defText = r.meanings.flatMap((m) => m.defs).join(' ');
  console.log(`      running → [${r.engine}] ${r.translation}`);
  console.log(`      词性：${r.meanings.map((m) => m.pos || '(无)').join(', ')} | 词形 ${r.forms.length} 条 | 例句 ${r.examples.length} 条 | 短语 ${r.phrases.length} 条`);
  assert.match(defText, /[\u4e00-\u9fff]/, '释义里应含中文');
});

/* ---------------- 6. 整句翻译 ---------------- */

await test('lookup(长句)：mode=sentence 且译文含中文', async () => {
  const sentence = 'This paper proposes a new method for machine translation.';
  const r = await lookup(sentence);
  // 注意：normalizeQuery 会去掉句末的 "."（去首尾标点），所以 query 里没有句号
  assert.equal(r.query, normalizeQuery(sentence));
  assert.equal(r.query, 'This paper proposes a new method for machine translation');
  assert.equal(r.mode, 'sentence');
  assert.equal(r.engine, 'youdao');
  assert.equal(typeof r.translation, 'string');
  assert.ok(r.translation.length > 0, 'translation 不能为空');
  assert.match(r.translation, /[\u4e00-\u9fff]/, '译文应含中文字符');
  assert.deepEqual(r.direction, { from: 'en', to: 'zh-CN' });
  console.log(`      整句 → [${r.engine}] ${r.translation}`);
});

/* ---------------- 7. 中文反向 ---------------- */

await test("lookup('机器学习')：方向 zh-CHS→en，不抛异常", async () => {
  const r = await lookup('机器学习');
  assert.deepEqual(r.direction, { from: 'zh-CHS', to: 'en' });
  assert.equal(r.query, '机器学习');
  assert.ok(r.translation || r.meanings.length, 'translation 或 meanings 至少一项非空');
  assert.equal(r.audio, null, '中文查询不给英文 TTS 发音');
  console.log(`      机器学习 → [${r.engine}] ${r.translation}`);
});

/* ---------------- 8. 引擎降级链 ---------------- */

await test("lookup('hello', {engine:'google'})：Google 失败也要降级成功", async () => {
  const started = Date.now();
  const r = await lookup('hello', { engine: 'google', timeoutMs: 4000 });
  assert.ok(ENGINE_IDS.includes(r.engine), `engine 必须是已知引擎，实际：${r.engine}`);
  assert.ok(r.translation || r.meanings.length, '降级后必须仍有结果');
  assert.equal(r.query, 'hello');
  if (r.engine === 'google') {
    console.log(`      （本机 Google 竟然通了，engine=google，${Date.now() - started}ms）`);
  } else {
    assert.ok(r.meanings.length >= 1, '降级到词典引擎时应带 meanings');
    console.log(`      （Google 不可达 → 降级到 ${r.engine} / ${r.engineLabel}，耗时 ${Date.now() - started}ms）`);
  }
});

/* ---------------- 9. 空输入 ---------------- */

await test('空输入 / 纯标点：抛中文错误', async () => {
  await assert.rejects(lookup('   '), (err) => {
    assert.ok(err instanceof Error, '必须 throw Error');
    assert.match(err.message, /[\u4e00-\u9fff]/, '错误信息必须是中文');
    return true;
  });
  await assert.rejects(lookup(''), (err) => err instanceof Error);
  await assert.rejects(lookup('“”  \u00AD'), (err) => err instanceof Error);
});

/* ---------------- 摘要 ---------------- */

console.log('\n==================== 测试摘要 ====================');
console.log(`PASS: ${passed}    FAIL: ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name} → ${f.err && f.err.message}`);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
if (helloResult) {
  console.log(
    `有道 hello 摘要：音标 ${helloResult.phonetic?.us} | 释义 ${helloResult.meanings.length} 组 | ` +
      `词形 ${helloResult.forms.length} | 例句 ${helloResult.examples.length} | 短语 ${helloResult.phrases.length}`,
  );
}
