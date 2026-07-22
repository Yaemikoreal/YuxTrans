/**
 * SW 拆分模块单元测试（驱动真实 shipped 文件）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const libSw = path.join(__dirname, '..', 'lib', 'sw');

// 按依赖顺序加载真实模块
require(path.join(libSw, 'bootstrap.js'));
require(path.join(libSw, 'constants.js'));
require(path.join(libSw, 'cache-keys.js'));
require(path.join(libSw, 'providers-core.js'));
require(path.join(libSw, 'lang.js'));
require(path.join(libSw, 'message-actions.js'));
require(path.join(libSw, 'translate-core.js'));
require(path.join(libSw, 'scheduler.js'));

const SW = globalThis.YuxTransSW;

test('SW 模块文件均存在', () => {
  const files = [
    'bootstrap.js',
    'constants.js',
    'cache-keys.js',
    'providers-core.js',
    'lang.js',
    'message-actions.js',
    'translate-core.js',
    'scheduler.js'
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(libSw, f)), `missing ${f}`);
  }
});

test('constants：端点与默认模型', () => {
  assert.ok(SW.API_ENDPOINTS.qwen.includes('dashscope'));
  assert.ok(SW.API_ENDPOINTS.local.includes('11434'));
  assert.strictEqual(SW.CACHE_KEY_VERSION, 'v3');
  assert.strictEqual(SW.PROMPT_VERSION, 'p1');
  assert.ok(SW.DEFAULT_MODELS.openai.length > 0);
});

test('cache-keys：归一化与生成', () => {
  assert.strictEqual(SW.normalizeCacheKeyText('  a   b  '), 'a b');
  // 不传 model -> model 段为 '_'
  const key = SW.generateCacheKey('Hello world', 'en', 'zh', 'normal');
  assert.ok(key.startsWith('v3:p1:_:en:zh:normal:'));
  const parsed = SW.parseCacheKey(key);
  assert.strictEqual(parsed.promptVersion, 'p1');
  assert.strictEqual(parsed.model, '_');
  assert.strictEqual(parsed.sourceLang, 'en');
  assert.strictEqual(parsed.targetLang, 'zh');
  assert.strictEqual(parsed.text, 'Hello world');
});

test('cache-keys：model 隔离与 slug 化', () => {
  const t = 'Hello';
  // 不同模型产生不同键（切档案对比效果不被旧模型缓存污染）
  const k1 = SW.generateCacheKey(t, 'en', 'zh', 'normal', 'gpt-4o');
  const k2 = SW.generateCacheKey(t, 'en', 'zh', 'normal', 'qwen-turbo');
  assert.notStrictEqual(k1, k2);
  assert.ok(k1.includes(':gpt-4o:'));
  assert.ok(k2.includes(':qwen-turbo:'));
  // 模型名含冒号（ollama qwen2:7b）被 slug 化，不破坏键分段
  const k3 = SW.generateCacheKey(t, 'en', 'zh', 'normal', 'qwen2:7b');
  assert.ok(k3.includes(':qwen2-7b:'));
  const p3 = SW.parseCacheKey(k3);
  assert.strictEqual(p3.model, 'qwen2-7b');
  assert.strictEqual(p3.text, 'Hello');
});

test('providers-core：默认模型与 JSON mode', () => {
  assert.strictEqual(SW.getDefaultModel('qwen'), 'qwen-turbo');
  assert.strictEqual(SW.supportsJsonMode('openai'), true);
  assert.strictEqual(SW.supportsJsonMode('anthropic'), false);
  assert.strictEqual(SW.isProviderAvailable({ provider: 'local' }), true);
  assert.strictEqual(SW.isProviderAvailable({ provider: 'openai', apiKey: '' }), false);
  assert.strictEqual(SW.makeProfileId('qwen', 'qwen-turbo', ''), 'qwen:qwen-turbo');
});

test('lang：检测与同语种翻转', () => {
  assert.strictEqual(SW.detectLanguage('这是中文句子'), 'zh');
  assert.strictEqual(SW.detectLanguage('Hello world'), 'en');
  assert.strictEqual(SW.resolveSourceLanguage('こんにちは', 'auto'), 'ja');
  assert.strictEqual(SW.flipTargetIfSameLanguage('zh', 'zh'), 'en');
  assert.strictEqual(SW.flipTargetIfSameLanguage('en', 'zh'), 'zh');
});

test('message-actions：注册与归类', () => {
  assert.ok(SW.isKnownMessageAction('translate'));
  assert.ok(SW.isKnownMessageAction('reportBadTranslation'));
  assert.ok(SW.isKnownMessageAction('saveProfile'));
  assert.strictEqual(SW.classifyMessageAction('translateStream'), 'translate');
  assert.strictEqual(SW.classifyMessageAction('setConfig'), 'config');
  assert.strictEqual(SW.classifyMessageAction('importGlossary'), 'glossary');
  assert.strictEqual(SW.classifyMessageAction('disableSite'), 'site');
  assert.strictEqual(SW.classifyMessageAction('not-a-real-action'), 'unknown');
});

test('translate-core：Prompt 含目标语与规则', () => {
  const prompt = SW.buildTranslationPrompt('Hello', 'en', 'zh', 'normal', null);
  assert.ok(prompt.includes('Simplified Chinese') || prompt.includes('zh'));
  assert.ok(prompt.includes('Hello'));
  assert.ok(prompt.includes('STRICT OUTPUT RULES'));
  const withCtx = SW.buildTranslationPrompt('Hi', 'en', 'zh', 'technical', {
    title: 'Docs',
    url: 'https://example.com'
  });
  assert.ok(withCtx.includes('Page context'));
  assert.ok(withCtx.includes('Docs'));
});

test('scheduler：相同 cacheKey 的并发请求合并为一次执行', async () => {
  SW.clearInflight();
  let calls = 0;
  const exec = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return '译'; };
  const [a, b] = await Promise.all([
    SW.scheduleTranslation('k1', exec, SW.SCHEDULER_PRIORITY.NORMAL),
    SW.scheduleTranslation('k1', exec, SW.SCHEDULER_PRIORITY.NORMAL)
  ]);
  assert.strictEqual(calls, 1, '并发同 key 只执行一次');
  assert.strictEqual(a, '译');
  assert.strictEqual(b, '译');
  assert.strictEqual(SW.hasInflight('k1'), false, '完成后从在途表移除');
});

test('scheduler：不同 cacheKey 各自执行；空 key 不去重', async () => {
  SW.clearInflight();
  let calls = 0;
  const exec = async () => { calls++; return 'x'; };
  await Promise.all([
    SW.scheduleTranslation('ka', exec),
    SW.scheduleTranslation('kb', exec),
    SW.scheduleTranslation('', exec)
  ]);
  assert.strictEqual(calls, 3);
});

test('scheduler：失败时从在途表移除并抛出', async () => {
  SW.clearInflight();
  const exec = async () => { throw new Error('boom'); };
  await assert.rejects(() => SW.scheduleTranslation('ke', exec), /boom/);
  assert.strictEqual(SW.hasInflight('ke'), false);
});
