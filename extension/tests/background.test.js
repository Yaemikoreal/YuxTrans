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
  assert.ok(k.startsWith('v3:p1:'), '含 version + promptVersion');
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
