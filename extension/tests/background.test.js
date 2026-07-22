/**
 * Background Service Worker 核心逻辑单元测试
 * 使用 Node 内置 test runner，无需额外测试框架依赖
 */

const test = require('node:test');
const assert = require('node:assert');

require('./mock-chrome.js');
const bg = require('../background.js');

test('generateCacheKey 拼接规则', () => {
  assert.strictEqual(bg.generateCacheKey('Hello', 'auto', 'zh'), 'v2:auto:zh:normal:Hello');
  assert.strictEqual(bg.generateCacheKey('a:b', 'en', 'zh-TW'), 'v2:en:zh-TW:normal:a:b');
});

test('normalizeCacheKeyText 去除噪声并折叠空白', () => {
  assert.strictEqual(bg.generateCacheKey('  Hello   world  ', 'auto', 'zh'), 'v2:auto:zh:normal:Hello world');
  assert.strictEqual(bg.generateCacheKey('Hello\u200Bworld', 'auto', 'zh'), 'v2:auto:zh:normal:Helloworld');
  assert.strictEqual(
    bg.generateCacheKey('Hello \u200B world', 'auto', 'zh'),
    bg.generateCacheKey('Hello world', 'auto', 'zh')
  );
});

test('generateCacheKey 按翻译风格隔离缓存', () => {
  const text = 'Hello';
  assert.notStrictEqual(
    bg.generateCacheKey(text, 'en', 'zh', 'normal'),
    bg.generateCacheKey(text, 'en', 'zh', 'academic')
  );
});

test('generateCacheKey Unicode 组合变体归一化', () => {
  // NFC 归一化：组合字符与预组合字符视为相同
  assert.strictEqual(
    bg.generateCacheKey('Café', 'auto', 'zh'),
    bg.generateCacheKey('Cafe\u0301', 'auto', 'zh')
  );
  // 严格策略下，引号、破折号、全半角差异视为不同文本
  assert.notStrictEqual(
    bg.generateCacheKey('“Hello”', 'auto', 'zh'),
    bg.generateCacheKey('"Hello"', 'auto', 'zh')
  );
});

test('getDefaultModel 返回供应商默认模型首项', () => {
  assert.strictEqual(bg.getDefaultModel('qwen'), 'qwen-turbo');
  assert.strictEqual(bg.getDefaultModel('openai'), 'gpt-4o');
  assert.strictEqual(bg.getDefaultModel('local'), '');
  assert.strictEqual(bg.getDefaultModel('nonexistent'), '');
});

test('getEndpoint 使用默认端点并自动补全路径', () => {
  assert.strictEqual(
    bg.getEndpoint({ provider: 'qwen', apiEndpoint: '', customProvider: {} }),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  );

  assert.strictEqual(
    bg.getEndpoint({ provider: 'deepseek', apiEndpoint: 'https://api.example.com', customProvider: {} }),
    'https://api.example.com/chat/completions'
  );

  assert.strictEqual(
    bg.getEndpoint({ provider: 'anthropic', apiEndpoint: 'https://custom.anthropic/v1/messages', customProvider: {} }),
    'https://custom.anthropic/v1/messages'
  );

  assert.strictEqual(
    bg.getEndpoint({ provider: 'custom', apiEndpoint: '', customProvider: { endpoint: 'https://custom.ai/v1' } }),
    'https://custom.ai/v1/chat/completions'
  );

  assert.strictEqual(
    bg.getEndpoint({ provider: 'local', apiEndpoint: '', customProvider: {} }),
    'http://localhost:11434/api/chat'
  );
});

test('getApiKey 区分普通 / 本地 / 自定义供应商', () => {
  assert.strictEqual(bg.getApiKey({ provider: 'qwen', apiKey: 'sk-abc', customProvider: {} }), 'sk-abc');
  assert.strictEqual(bg.getApiKey({ provider: 'local', apiKey: 'sk-abc', customProvider: {} }), '');
  assert.strictEqual(
    bg.getApiKey({ provider: 'custom', apiKey: 'sk-abc', customProvider: { apiKey: 'custom-key' } }),
    'custom-key'
  );
});

test('getModel 按优先级返回模型', () => {
  // 自定义供应商优先 customProvider.model
  assert.strictEqual(
    bg.getModel({ provider: 'custom', model: 'm1', customProvider: { model: 'm2' } }),
    'm2'
  );
  // 普通供应商优先 p.model，其次默认
  assert.strictEqual(bg.getModel({ provider: 'qwen', model: 'qwen-max', customProvider: {} }), 'qwen-max');
  assert.strictEqual(bg.getModel({ provider: 'qwen', model: '', customProvider: {} }), 'qwen-turbo');
  // 无默认时兜底
  assert.strictEqual(bg.getModel({ provider: 'unknown', model: '', customProvider: {} }), 'gpt-3.5-turbo');
});

test('getFormat 返回正确的 API 格式', () => {
  assert.strictEqual(bg.getFormat({ provider: 'qwen', customProvider: { format: 'openai' } }), 'qwen');
  assert.strictEqual(bg.getFormat({ provider: 'custom', customProvider: { format: 'anthropic' } }), 'anthropic');
  assert.strictEqual(bg.getFormat({ provider: 'local', customProvider: {} }), 'local');
});

test('formatError 友好错误映射', () => {
  assert.strictEqual(bg.formatError(429, 'too many'), '请求过于频繁，请稍后再试');
  assert.strictEqual(bg.formatError(401, 'invalid'), 'API Key 无效或已过期，请在设置中检查');
  assert.ok(bg.formatError(418, 'short').includes('418'));
  // 长错误文本截断（使用未在 ERROR_MESSAGES 中定义的状态码）
  const long = 'x'.repeat(500);
  const truncated = bg.formatError(418, long);
  assert.ok(truncated.includes('418'));
  assert.strictEqual(truncated.length, '请求失败 (418): '.length + 200);
});

test('detectLanguage 基于 Unicode 脚本检测', () => {
  assert.strictEqual(bg.detectLanguage('Hello world'), 'en');
  assert.strictEqual(bg.detectLanguage('你好世界'), 'zh');
  assert.strictEqual(bg.detectLanguage('こんにちは'), 'ja');
  assert.strictEqual(bg.detectLanguage('안녕하세요'), 'ko');
  assert.strictEqual(bg.detectLanguage(''), 'unknown');
});

test('resolveTargetLanguage 避免同语种互译', () => {
  // 源语言与目标语言相同（英文→英文）时翻向中文
  assert.strictEqual(bg.resolveTargetLanguage('Hello', 'auto', 'en'), 'zh');
  // 中文→中文时翻向英文
  assert.strictEqual(bg.resolveTargetLanguage('你好', 'auto', 'zh'), 'en');
  // 非 auto 时不做检测
  assert.strictEqual(bg.resolveTargetLanguage('Hello', 'en', 'zh'), 'zh');
});

test('resolveSourceLanguage 自动检测源语言', () => {
  assert.strictEqual(bg.resolveSourceLanguage('Hello', 'auto'), 'en');
  assert.strictEqual(bg.resolveSourceLanguage('你好', 'auto'), 'zh');
  assert.strictEqual(bg.resolveSourceLanguage('Hello', 'en'), 'en');
});

test('splitIntoCharBatches 按字符数切分子批次', () => {
  const items = [
    { text: 'a'.repeat(1000) },
    { text: 'b'.repeat(1000) },
    { text: 'c'.repeat(1000) },
    { text: 'd'.repeat(500) }
  ];
  const batches = bg.splitIntoCharBatches(items, 2500);
  assert.strictEqual(batches.length, 2);
  assert.strictEqual(batches[0].length, 2); // 2000 chars
  assert.strictEqual(batches[1].length, 2); // 1500 chars

  // 单个超长文本独立成批
  const longItem = [{ text: 'x'.repeat(5000) }];
  const single = bg.splitIntoCharBatches(longItem, 4000);
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].length, 1);
});

test('getBatchConfig 按 provider/model 返回动态 batch 参数', () => {
  assert.deepStrictEqual(
    bg.getBatchConfig({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: '', customProvider: {} }),
    { maxBatchChars: 16000, batchSize: 100 }
  );
  assert.deepStrictEqual(
    bg.getBatchConfig({ provider: 'deepseek', model: 'deepseek-chat', apiKey: '', customProvider: {} }),
    { maxBatchChars: 10000, batchSize: 60 }
  );
  assert.deepStrictEqual(
    bg.getBatchConfig({ provider: 'qwen', model: 'qwen-turbo', apiKey: '', customProvider: {} }),
    { maxBatchChars: 8000, batchSize: 50 }
  );
  assert.deepStrictEqual(
    bg.getBatchConfig({ provider: 'local', localModel: 'qwen2:7b', customProvider: {} }),
    { maxBatchChars: 4000, batchSize: 20 }
  );
  assert.deepStrictEqual(
    bg.getBatchConfig({ provider: 'local', localModel: 'qwen2:14b', customProvider: {} }),
    { maxBatchChars: 6000, batchSize: 40 }
  );
});

test('buildBatchPrompt 包含必要格式要求但不注入页面上下文', () => {
  const prompt = bg.buildBatchPrompt(['Hello', 'World'], 'en', 'zh', { pageTitle: 'Test Page', pageUrl: 'https://example.com/path' });
  assert.ok(prompt.includes('JSON array of strings'));
  assert.ok(prompt.includes('Hello'));
  assert.ok(prompt.includes('World'));
  assert.ok(prompt.includes('Simplified Chinese'));
  assert.ok(prompt.includes('exactly 2'));
  assert.ok(prompt.includes('HTML tags'));
  // 批量翻译不注入页面上下文，避免模型把任意片段偏向页面标题
  assert.ok(!prompt.includes('Test Page'));
  assert.ok(!prompt.includes('example.com'));
});

test('makeProfileId 生成稳定 ID', () => {
  assert.strictEqual(bg.makeProfileId('qwen', 'qwen-turbo', ''), 'qwen:qwen-turbo');
  assert.strictEqual(bg.makeProfileId('local', '', 'qwen3.5:0.8b'), 'local:qwen3.5:0.8b');
});

test('addOrUpdateProfile / removeProfile 管理档案', () => {
  const id1 = bg.addOrUpdateProfile({ provider: 'qwen', apiKey: 'k1', model: 'qwen-turbo' });
  assert.ok(id1);
  const profile = bg.getActiveProfile();
  assert.strictEqual(profile.provider, 'qwen');
  assert.strictEqual(profile.model, 'qwen-turbo');

  // 更新同一档案
  bg.addOrUpdateProfile({ id: id1, provider: 'qwen', apiKey: 'k2', model: 'qwen-max' });
  const updated = bg.getActiveProfile();
  assert.strictEqual(updated.apiKey, 'k2');
  assert.strictEqual(updated.model, 'qwen-max');

  // 删除后 activeProfileId 自动迁移到剩余档案（旧版迁移会留下默认 legacy profile）
  bg.removeProfile(id1);
  const migrated = bg.getActiveProfile();
  assert.ok(migrated);
  assert.strictEqual(migrated.provider, 'qwen');
});

test('resolveProviderConfig 优先使用 active profile', () => {
  // 未设置 active profile 时回退到 config 顶层
  const fallback = bg.resolveProviderConfig();
  assert.ok(fallback.provider);

  // 设置 profile 后优先取 profile
  bg.addOrUpdateProfile({ provider: 'deepseek', apiKey: 'sk-ds', model: 'deepseek-chat' });
  const active = bg.resolveProviderConfig();
  assert.strictEqual(active.provider, 'deepseek');
  assert.strictEqual(active.apiKey, 'sk-ds');

  // 显式 providerOverride 优先级最高
  const override = bg.resolveProviderConfig({ provider: 'openai', apiKey: 'sk-oa', model: 'gpt-4o', customProvider: {} });
  assert.strictEqual(override.provider, 'openai');
});

test('isProviderAvailable 判断供应商可用性', () => {
  assert.strictEqual(bg.isProviderAvailable({ provider: 'local' }), true);
  assert.strictEqual(bg.isProviderAvailable({ provider: 'qwen', apiKey: 'sk-abc' }), true);
  assert.strictEqual(bg.isProviderAvailable({ provider: 'qwen', apiKey: '' }), false);
  assert.strictEqual(
    bg.isProviderAvailable({ provider: 'custom', customProvider: { endpoint: 'https://x', apiKey: 'k' } }),
    true
  );
  assert.strictEqual(
    bg.isProviderAvailable({ provider: 'custom', customProvider: { endpoint: '', apiKey: '' } }),
    false
  );
});

test('supportsJsonMode 仅对已知 OpenAI 兼容供应商返回 true', () => {
  assert.strictEqual(bg.supportsJsonMode('openai'), true);
  assert.strictEqual(bg.supportsJsonMode('deepseek'), true);
  assert.strictEqual(bg.supportsJsonMode('anthropic'), false);
  assert.strictEqual(bg.supportsJsonMode('local'), false);
  assert.strictEqual(bg.supportsJsonMode('custom'), false);
});

test('buildRequest 批量请求为支持的供应商附加 response_format', () => {
  const deepseek = bg.buildRequest('test', false, { provider: 'deepseek', apiKey: 'k', model: 'm', customProvider: {} }, true);
  const body = JSON.parse(deepseek.body);
  assert.strictEqual(body.response_format.type, 'json_object');

  const anthropic = bg.buildRequest('test', false, { provider: 'anthropic', apiKey: 'k', model: 'm', customProvider: {} }, true);
  const anthropicBody = JSON.parse(anthropic.body);
  assert.strictEqual(anthropicBody.response_format, undefined);

  const stream = bg.buildRequest('test', true, { provider: 'openai', apiKey: 'k', model: 'm', customProvider: {} }, true);
  const streamBody = JSON.parse(stream.body);
  assert.strictEqual(streamBody.response_format, undefined);
});

test('toUserError 产出结构化 userError', () => {
  const err = bg.toUserError(new Error('请先配置 API Key'));
  assert.ok(err.code);
  assert.ok(err.userMessage);
  assert.ok(err.actionHint);
});

test('ProductHelpers 经 background 导出可调用', () => {
  assert.strictEqual(typeof bg.resolveTriggerAction, 'function');
  assert.strictEqual(bg.resolveTranslateAction(false), 'translate');
  assert.strictEqual(bg.applyGlossary('x', [{ source: 'x', target: 'y' }]).text, 'y');
});

test('shouldBlockWhenBrowserOffline 经 background 导出且本地离线不拦截', () => {
  assert.strictEqual(typeof bg.shouldBlockWhenBrowserOffline, 'function');
  assert.strictEqual(bg.shouldBlockWhenBrowserOffline(false, 'local'), false);
  assert.strictEqual(bg.shouldBlockWhenBrowserOffline(false, 'openai'), true);
});

test('withDbRetry 成功路径直接返回，失败且非 DB 错误原样抛出', async () => {
  assert.strictEqual(typeof bg.withDbRetry, 'function');
  const ok = await bg.withDbRetry(async () => 42);
  assert.strictEqual(ok, 42);

  let threw = false;
  try {
    await bg.withDbRetry(async () => {
      throw new Error('plain failure');
    });
  } catch (e) {
    threw = true;
    assert.match(e.message, /plain failure/);
  }
  assert.strictEqual(threw, true);
});
