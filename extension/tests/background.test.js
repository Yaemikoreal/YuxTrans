/**
 * Background Service Worker 核心逻辑单元测试
 * 使用 Node 内置 test runner，无需额外测试框架依赖
 */

const test = require('node:test');
const assert = require('node:assert');

require('./mock-chrome.js');
const bg = require('../background.js');

test('generateCacheKey 拼接规则', () => {
  const k = bg.generateCacheKey('Hello', 'auto', 'zh');
  assert.ok(k.startsWith('v3:p2:'), '含 version + promptVersion');
  assert.ok(k.endsWith(':auto:zh:normal:Hello'), 'lang/style/text 后缀');
  // model 段非空（包装函数注入了当前模型）
  assert.ok(k.split(':')[2].length > 0, 'model 段非空');
  // text 含冒号时 parseCacheKey 仍能正确还原（不被冒号破坏分段）
  const k2 = bg.generateCacheKey('a:b', 'en', 'zh-TW');
  const parsed = bg.parseCacheKey(k2);
  assert.strictEqual(parsed.sourceLang, 'en');
  assert.strictEqual(parsed.targetLang, 'zh-TW');
  assert.strictEqual(parsed.text, 'a:b');
});

test('normalizeCacheKeyText 去除噪声并折叠空白', () => {
  assert.ok(bg.generateCacheKey('  Hello   world  ', 'auto', 'zh').endsWith(':auto:zh:normal:Hello world'));
  assert.ok(bg.generateCacheKey('Hello\u200Bworld', 'auto', 'zh').endsWith(':auto:zh:normal:Helloworld'));
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

test('resolveTargetLanguage 同语种不再翻向对照语言', () => {
  // 同语种文本不再翻转：已是目标语言应由 isSameAsTargetLanguage 跳过，而非翻向对照语言
  assert.strictEqual(bg.resolveTargetLanguage('Hello', 'auto', 'en'), 'en');
  assert.strictEqual(bg.resolveTargetLanguage('你好', 'auto', 'zh'), 'zh');
  // 非 auto 时不做检测
  assert.strictEqual(bg.resolveTargetLanguage('Hello', 'en', 'zh'), 'zh');
});

test('isSameAsTargetLanguage 同语言跳过判定', () => {
  // 中文文本 + 目标中文 -> 跳过
  assert.strictEqual(bg.isSameAsTargetLanguage('你好世界', 'zh'), true);
  // 中文文本 + 目标 zh-CN -> 归一化后跳过
  assert.strictEqual(bg.isSameAsTargetLanguage('你好世界', 'zh-CN'), true);
  // 英文文本 + 目标中文 -> 需翻译
  assert.strictEqual(bg.isSameAsTargetLanguage('Hello world', 'zh'), false);
  // 英文文本 + 目标英文 -> 跳过
  assert.strictEqual(bg.isSameAsTargetLanguage('Hello world', 'en'), true);
  // 无法判定语言时不跳过（交由模型处理）
  assert.strictEqual(bg.isSameAsTargetLanguage('123', 'zh'), false);
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

test('buildBatchSystemPrompt 包含必要格式要求但不注入页面上下文', () => {
  const system = bg.buildBatchSystemPrompt(['Hello', 'World'], 'en', 'zh');
  assert.ok(system.includes('JSON array of strings'));
  assert.ok(system.includes('Simplified Chinese'));
  assert.ok(system.includes('exactly 2'));
  assert.ok(system.includes('HTML tags'));
  // 批量翻译不注入页面上下文，避免模型把任意片段偏向页面标题
  assert.ok(!system.includes('Test Page'));
  assert.ok(!system.includes('example.com'));
});

test('buildBatchPrompt 只包含输入数据与滑动窗口上下文', () => {
  const prompt = bg.buildBatchPrompt(['Hello', 'World'], 'en', 'zh', { pageTitle: 'Test Page', pageUrl: 'https://example.com/path' });
  assert.ok(prompt.includes('Hello'));
  assert.ok(prompt.includes('World'));
  // 规则已移入 system message，user prompt 不含规则文案
  assert.ok(!prompt.includes('JSON array of strings'));
  assert.ok(!prompt.includes('STRICT OUTPUT RULES'));
  // 批量翻译不注入页面上下文
  assert.ok(!prompt.includes('Test Page'));
  assert.ok(!prompt.includes('example.com'));
});

test('buildBatchPrompt 注入上一批滑动窗口上下文（标记勿重译）', () => {
  const prompt = bg.buildBatchPrompt(['Next'], 'en', 'zh', {
    prevContext: { source: 'Previous text', translation: '上一段译文' }
  });
  assert.ok(prompt.includes('Previous segment'));
  assert.ok(prompt.includes('do NOT re-translate'));
  assert.ok(prompt.includes('Previous text'));
  assert.ok(prompt.includes('上一段译文'));
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


test('翻译会话取消：abort 注册的 controller 并标记 cancelled', () => {
  const sid = 'cancel-test-' + Math.random().toString(36).slice(2);
  const ctrl = new AbortController();
  assert.strictEqual(bg.isSessionCancelled(sid), false);
  bg.registerSessionController(sid, ctrl);
  assert.strictEqual(ctrl.signal.aborted, false);
  const aborted = bg.cancelTranslationSession(sid);
  assert.strictEqual(aborted, 1);
  assert.strictEqual(ctrl.signal.aborted, true);
  assert.strictEqual(bg.isSessionCancelled(sid), true);
});

test('isSessionCancelled 对未知 / 空 session 返回 false', () => {
  assert.strictEqual(bg.isSessionCancelled('unknown-' + Math.random().toString(36).slice(2)), false);
  assert.strictEqual(bg.isSessionCancelled(null), false);
  assert.strictEqual(bg.isSessionCancelled(''), false);
});

// ===== R2：ensureInitialized 并发共享 Promise =====

test('ensureInitialized 并发调用只初始化一次（共享 Promise）', async () => {
  bg.__resetInitForTest();
  // loadConfig 每次执行会调用一次 storage.local.get('config')，以此计数初始化次数
  let configLoads = 0;
  const origGet = chrome.storage.local.get;
  chrome.storage.local.get = async (keys) => {
    if (keys === 'config') configLoads++;
    return origGet(keys);
  };

  try {
    await Promise.all([
      bg.ensureInitialized(),
      bg.ensureInitialized(),
      bg.ensureInitialized()
    ]);
    assert.strictEqual(configLoads, 1, '并发冷启动应只触发一次 loadConfig');
    // 初始化完成后再次调用不再重复加载
    await bg.ensureInitialized();
    assert.strictEqual(configLoads, 1, '已初始化后不应重复加载');
  } finally {
    chrome.storage.local.get = origGet;
  }
});

test('ensureInitialized 失败后重置 Promise，允许重试', async () => {
  bg.__resetInitForTest();
  const origGet = chrome.storage.local.get;
  let failOnce = true;
  chrome.storage.local.get = async (keys) => {
    if (failOnce && keys === 'config') {
      failOnce = false;
      throw new Error('storage transient failure');
    }
    return origGet(keys);
  };

  try {
    let firstError = null;
    try {
      await bg.ensureInitialized();
    } catch (e) {
      firstError = e;
    }
    assert.ok(firstError, '首次初始化应失败');
    // Promise 已重置，重试可成功
    await bg.ensureInitialized();
  } finally {
    chrome.storage.local.get = origGet;
  }
});

// ===== R3：僵尸翻译会话清扫 =====

test('僵尸会话清扫：超时会话被 abort 并从 Map 移除', () => {
  const zombieSid = 'zombie-' + Math.random().toString(36).slice(2);
  const freshSid = 'fresh-' + Math.random().toString(36).slice(2);
  const ctrl = new AbortController();
  bg.registerSessionController(zombieSid, ctrl);
  // 人为把会话创建时间拨回 31 分钟前，模拟页面未发 cancel 直接关闭
  const session = bg.getTranslationSession(zombieSid);
  session.createdAt = Date.now() - 31 * 60 * 1000;

  // 新会话创建时顺带清扫僵尸会话
  bg.getTranslationSession(freshSid);

  assert.strictEqual(ctrl.signal.aborted, true, '僵尸会话的 controller 应被 abort');
  assert.strictEqual(
    bg.isSessionCancelled(zombieSid), false,
    '僵尸会话应已从 Map 移除（查询行为等同未知会话）'
  );
  // 新会话本身不受影响
  assert.strictEqual(bg.isSessionCancelled(freshSid), false);
});

test('未超时的活跃会话不被清扫', () => {
  const activeSid = 'active-' + Math.random().toString(36).slice(2);
  const freshSid = 'fresh2-' + Math.random().toString(36).slice(2);
  const ctrl = new AbortController();
  bg.registerSessionController(activeSid, ctrl);

  bg.getTranslationSession(freshSid);

  assert.strictEqual(ctrl.signal.aborted, false, '活跃会话不应被 abort');
  assert.ok(bg.getTranslationSession(activeSid), '活跃会话仍在 Map 中');
});


test('parseDictionaryResult 解析词典 JSON 并降级', () => {
  // 合法 JSON
  const raw = '{"word":"hello","phonetic":"həˈləʊ","senses":[{"pos":"int.","meaning":"你好","examples":[{"source":"Hello!","target":"你好！"}]}]}';
  const dict = bg.parseDictionaryResult(raw, 'hello');
  assert.strictEqual(dict.word, 'hello');
  assert.strictEqual(dict.phonetic, 'həˈləʊ');
  assert.strictEqual(dict.senses.length, 1);
  assert.strictEqual(dict.senses[0].pos, 'int.');
  assert.strictEqual(dict.senses[0].meaning, '你好');
  assert.strictEqual(dict.senses[0].examples[0].source, 'Hello!');
  assert.strictEqual(dict.senses[0].examples[0].target, '你好！');

  // 带 markdown 围栏，正则提取首个 JSON
  const fenced = '```json\n{"word":"hi","senses":[]}\n```';
  const d2 = bg.parseDictionaryResult(fenced, 'hi');
  assert.strictEqual(d2.word, 'hi');
  assert.strictEqual(d2.senses.length, 0);

  // 解析失败降级为 raw
  const broken = 'not a json at all';
  const d3 = bg.parseDictionaryResult(broken, 'word1');
  assert.strictEqual(d3.word, 'word1');
  assert.strictEqual(d3.senses.length, 0);
  assert.strictEqual(d3.raw, broken);

  // 空输入
  assert.strictEqual(bg.parseDictionaryResult('', 'x').word, 'x');
  assert.strictEqual(bg.parseDictionaryResult(null, 'x').senses.length, 0);
});

test('buildDictionaryPrompt 转发 SW 并要求严格 JSON 输出', () => {
  const prompt = bg.buildDictionaryPrompt('hello', 'en', 'zh');
  assert.ok(prompt.includes('JSON'));
  assert.ok(prompt.includes('senses'));
  assert.ok(prompt.includes('hello'));
  // 不注入翻译风格（词典与风格无关）
  assert.ok(!prompt.includes('academic'));
});

test('generateCacheKey 词典模式独立缓存键（dict 段）', () => {
  const word = 'apple';
  const dictKey = bg.generateCacheKey(word, 'en', 'zh', 'dict');
  const normalKey = bg.generateCacheKey(word, 'en', 'zh', 'normal');
  // dict 与 normal 不撞，避免单词词典结果污染普通翻译缓存
  assert.notStrictEqual(dictKey, normalKey);
  assert.ok(dictKey.includes(':dict:'));
});

// ===== 整页流式翻译（SSE）相关 =====

/**
 * 构造一个按行吐出 SSE 数据的假 fetch 响应
 */
function fakeSseResponse(sseLines) {
  const encoder = new TextEncoder();
  let idx = 0;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => (idx < sseLines.length
          ? { done: false, value: encoder.encode(sseLines[idx++]) }
          : { done: true, value: undefined })
      })
    }
  };
}

test('translateWithStream：SSE chunk 聚合为完整译文并逐段推送', async () => {
  const pushed = [];
  const originalTabsSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, msg) => { pushed.push({ tabId, msg }); };

  const originalFetch = global.fetch;
  global.fetch = async () => fakeSseResponse([
    'data: {"message":{"content":"你"}}\n\n',
    'data: {"message":{"content":"好"}}\n\n',
    'data: {"message":{"content":"，世界"}}\n\n',
    'data: [DONE]\n\n'
  ]);

  try {
    const fullText = await bg.translateWithStream(
      'Hello, world', 'en', 'zh', 42,
      { context: null, providerOverride: { provider: 'local', model: 'qwen2', apiEndpoint: '', customProvider: {} }, requestId: 'req-agg-1', sessionId: null }
    );
    // chunk 聚合结果正确
    assert.strictEqual(fullText, '你好，世界');
    // 每段 chunk 都携带 requestId 推送给发起标签页，fullText 为累积值
    const chunks = pushed.filter((p) => p.msg.action === 'streamChunk');
    assert.strictEqual(chunks.length, 3);
    assert.deepStrictEqual(chunks.map((c) => c.msg.chunk), ['你', '好', '，世界']);
    assert.deepStrictEqual(
      chunks.map((c) => c.msg.fullText),
      ['你', '你好', '你好，世界']
    );
    assert.ok(chunks.every((c) => c.msg.requestId === 'req-agg-1' && c.tabId === 42));
  } finally {
    global.fetch = originalFetch;
    chrome.tabs.sendMessage = originalTabsSend;
  }
});

test('translateWithStream：注册控制器到取消会话，cancel 时 abort 在途 SSE', async () => {
  const sessionId = 'yxt-test-abort-1';
  const originalFetch = global.fetch;
  let fetchSignal = null;
  // 永不结束的 reader：abort 后立即抛 AbortError（模拟真实 fetch/reader 行为）
  global.fetch = async (url, opts) => {
    fetchSignal = opts.signal;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise((resolve, reject) => {
            const abortErr = () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            };
            if (opts.signal.aborted) { abortErr(); return; }
            opts.signal.addEventListener('abort', abortErr);
          })
        })
      }
    };
  };

  try {
    const pending = bg.translateWithStream(
      'Long paragraph', 'en', 'zh', 7,
      { context: null, providerOverride: { provider: 'local', model: 'qwen2', apiEndpoint: '', customProvider: {} }, requestId: 'req-abort-1', sessionId }
    ).catch((e) => e);

    // 等待 fetch 发出
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(fetchSignal, 'fetch 应已发出');

    const aborted = bg.cancelTranslationSession(sessionId);
    assert.ok(aborted >= 1, '流式控制器应注册进取消会话');

    const err = await pending;
    assert.ok(err instanceof Error);
    // AbortError 被映射为友好的超时提示
    assert.ok(err.message.includes('超时'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('translateWithStream：google 供应商降级为一次性翻译并以单 chunk 推送', async () => {
  const pushed = [];
  const originalTabsSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, msg) => { pushed.push({ tabId, msg }); };
  const originalFetch = global.fetch;
  const originalNavigator = global.navigator;
  // 测试环境 navigator.onLine 可能未定义，强制在线（避免 google 非 local 被 offline 门禁误拦）
  global.navigator = { onLine: true };
  // googleTranslate 响应：嵌套数组，首段为译文
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [[['你好，世界', 'Hello, world', null, null, 10]]]
  });

  try {
    const fullText = await bg.translateWithStream(
      'Hello, world', 'en', 'zh', 42,
      { providerOverride: { provider: 'google', apiEndpoint: '', customProvider: {} }, requestId: 'req-google-1' }
    );
    // 一次性翻译结果正确
    assert.strictEqual(fullText, '你好，世界');
    // 推送单个 streamChunk（非 SSE 多 chunk），携带 requestId
    const chunks = pushed.filter((p) => p.msg.action === 'streamChunk');
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].msg.chunk, '你好，世界');
    assert.strictEqual(chunks[0].msg.fullText, '你好，世界');
    assert.strictEqual(chunks[0].msg.requestId, 'req-google-1');
  } finally {
    global.fetch = originalFetch;
    chrome.tabs.sendMessage = originalTabsSend;
    global.navigator = originalNavigator;
  }
});

// ===== 安全修复 S1：getConfig 脱敏 + onMessage sender 校验 =====

/**
 * 通过 onMessage 模拟一次消息收发（沿用 mock-chrome 的 _trigger）
 * @param {object} request
 * @param {object} sender
 * @returns {Promise<object>}
 */
function sendSwMessage(request, sender) {
  return new Promise((resolve) => {
    chrome.runtime.onMessage._trigger(request, sender, resolve);
  });
}

test('getConfig 响应脱敏：profiles 不含明文 apiKey，仅带 hasApiKey', async () => {
  const profileId = bg.addOrUpdateProfile({
    provider: 'qwen',
    apiKey: 'sk-secret-should-not-leak',
    model: 'qwen-turbo-s1-test'
  });

  // 本扩展 content script（带 tab）调用
  const res = await sendSwMessage(
    { action: 'getConfig' },
    { id: chrome.runtime.id, tab: { id: 1 } }
  );
  assert.ok(res, '应返回配置');
  const leaked = JSON.stringify(res);
  assert.ok(!leaked.includes('sk-secret-should-not-leak'), '响应任何位置都不应含明文 Key');

  const profile = (res.profiles || []).find((p) => p.id === profileId);
  assert.ok(profile, '响应中应包含该档案');
  assert.strictEqual(profile.apiKey, '');
  assert.strictEqual(profile.hasApiKey, true);
  assert.strictEqual(profile.customProvider.apiKey, '');
  assert.strictEqual(profile.customProvider.hasApiKey, false);
  // 顶层旧版 apiKey 字段同样不回吐
  assert.strictEqual(res.apiKey, '');

  // SW 内部配置不受影响，仍持有真实 Key（翻译 / 缓存键不受影响）
  assert.strictEqual(bg.getActiveProfile().apiKey, 'sk-secret-should-not-leak');
});

test('getProfiles 响应同样脱敏', async () => {
  const res = await sendSwMessage(
    { action: 'getProfiles' },
    { id: chrome.runtime.id }
  );
  assert.strictEqual(res.success, true);
  assert.ok(!JSON.stringify(res).includes('sk-secret-should-not-leak'));
  const withKey = res.profiles.find((p) => p.hasApiKey);
  assert.ok(withKey, '已存 Key 的档案应带 hasApiKey: true');
  assert.strictEqual(withKey.apiKey, '');
});

test('addOrUpdateProfile：空 apiKey 视为不修改，保留原 Key', () => {
  const id = bg.addOrUpdateProfile({ provider: 'deepseek', apiKey: 'sk-ds-keep', model: 'deepseek-s1-test' });
  // 模拟页面保存：表单留空（不回显），apiKey 为空字符串
  bg.addOrUpdateProfile({ id, provider: 'deepseek', apiKey: '', model: 'deepseek-s1-test', label: '更新标签' });
  assert.strictEqual(bg.getActiveProfile().apiKey, 'sk-ds-keep');
  assert.strictEqual(bg.getActiveProfile().label, '更新标签');
  // 非空 apiKey 正常覆盖
  bg.addOrUpdateProfile({ id, provider: 'deepseek', apiKey: 'sk-ds-new', model: 'deepseek-s1-test' });
  assert.strictEqual(bg.getActiveProfile().apiKey, 'sk-ds-new');
});

test('onMessage 拒绝外部 sender（其他扩展 / 网页）', async () => {
  const res = await sendSwMessage(
    { action: 'getConfig' },
    { id: 'evil-other-extension-id' }
  );
  assert.strictEqual(res.success, false);
  assert.ok(String(res.error).includes('Forbidden'));
});

test('onMessage 接受本扩展页面（无 sender.tab）与 content script（有 sender.tab）', async () => {
  // 扩展页面（popup / options）：sender 无 tab
  const pageRes = await sendSwMessage(
    { action: 'getProviderDefaults' },
    { id: chrome.runtime.id }
  );
  assert.strictEqual(pageRes.success, true);

  // content script：sender 带 tab
  const csRes = await sendSwMessage(
    { action: 'getConfig' },
    { id: chrome.runtime.id, tab: { id: 7 } }
  );
  assert.ok(csRes && csRes.profiles, 'content script 应能正常获取脱敏配置');
});

// ===== #4 浮窗串台修复：SW 响应透传 requestId =====

test('translate / lookupWord / translateStream 响应透传 requestId', async () => {
  const originalFetch = global.fetch;
  // 500 触发失败路径（failResponse）；有 Key 时走 fetch，无 Key 时前置抛错，两者都应带 requestId
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  try {
    const sender = { id: chrome.runtime.id, tab: { id: 3 } };
    const t = await sendSwMessage(
      { action: 'translate', text: 'requestId passthrough probe', sourceLang: 'en', targetLang: 'zh', requestId: 'popup-42' },
      sender
    );
    assert.strictEqual(t.requestId, 'popup-42', 'translate 响应应透传 requestId');

    const d = await sendSwMessage(
      { action: 'lookupWord', text: 'probe', sourceLang: 'en', targetLang: 'zh', requestId: 'popup-43' },
      sender
    );
    assert.strictEqual(d.requestId, 'popup-43', 'lookupWord 响应应透传 requestId');

    const s = await sendSwMessage(
      { action: 'translateStream', text: 'requestId passthrough probe', sourceLang: 'en', targetLang: 'zh', requestId: 'popup-44' },
      sender
    );
    assert.strictEqual(s.requestId, 'popup-44', 'translateStream 响应应透传 requestId');
  } finally {
    global.fetch = originalFetch;
  }
});
