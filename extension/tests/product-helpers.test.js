/**
 * 产品纯函数单元测试 —— 直接驱动 shipped 代码 extension/lib/product-helpers.js
 */
const test = require('node:test');
const assert = require('node:assert');

const H = require('../lib/product-helpers.js');

test('resolveTriggerAction 映射三种触发模式', () => {
  assert.strictEqual(H.resolveTriggerAction('auto'), 'auto');
  assert.strictEqual(H.resolveTriggerAction('icon'), 'icon');
  assert.strictEqual(H.resolveTriggerAction('contextMenu'), 'contextMenu');
  assert.strictEqual(H.resolveTriggerAction('context_menu'), 'contextMenu');
  assert.strictEqual(H.resolveTriggerAction(undefined), 'auto');
});

test('shouldShowFloatButton / shouldAutoTranslateOnSelect 互斥', () => {
  assert.strictEqual(H.shouldShowFloatButton('icon'), true);
  assert.strictEqual(H.shouldAutoTranslateOnSelect('icon'), false);
  assert.strictEqual(H.shouldShowFloatButton('auto'), false);
  assert.strictEqual(H.shouldAutoTranslateOnSelect('auto'), true);
  assert.strictEqual(H.shouldShowFloatButton('contextMenu'), false);
  assert.strictEqual(H.shouldAutoTranslateOnSelect('contextMenu'), false);
});

test('resolveTranslateAction 尊重 enableStreaming', () => {
  assert.strictEqual(H.resolveTranslateAction(true), 'translateStream');
  assert.strictEqual(H.resolveTranslateAction(undefined), 'translateStream');
  assert.strictEqual(H.resolveTranslateAction(false), 'translate');
  assert.strictEqual(H.shouldUseStreaming(false), false);
});

test('buildUserError 映射 AUTH / RATE_LIMIT / LOCAL_MODEL / OFFLINE', () => {
  const auth = H.buildUserError({ message: 'API Key invalid', status: 401 });
  assert.strictEqual(auth.code, 'AUTH');
  assert.ok(auth.actionHint.includes('设置'));

  const rate = H.buildUserError(429, { debugMessage: 'too many' });
  assert.strictEqual(rate.code, 'RATE_LIMIT');

  const local = H.buildUserError(new Error('Failed to fetch'), { provider: 'local' });
  assert.strictEqual(local.code, 'LOCAL_MODEL');

  const offline = H.buildUserError(new Error('离线模式仅允许本地模型与缓存'));
  assert.strictEqual(offline.code, 'OFFLINE');

  const text = H.formatUserErrorText(auth);
  assert.ok(text.includes(auth.userMessage));
  assert.ok(text.includes(auth.actionHint));
});

test('applyGlossary 精确命中强制译名', () => {
  const glossary = [
    { source: 'API Gateway', target: 'API 网关' },
    { source: 'hello', target: '你好' }
  ];
  const hit = H.applyGlossary('API Gateway', glossary);
  assert.strictEqual(hit.hit, true);
  assert.strictEqual(hit.text, 'API 网关');

  const miss = H.applyGlossary('Something else', glossary);
  assert.strictEqual(miss.hit, false);
  assert.strictEqual(miss.text, 'Something else');

  const collapsed = H.applyGlossary('  hello  ', glossary);
  assert.strictEqual(collapsed.hit, true);
  assert.strictEqual(collapsed.text, '你好');
});

test('parseGlossaryImport 支持 CSV 与 JSON', () => {
  const csv = H.parseGlossaryImport('source,target\nOpenAI,开放人工智能\nGPU,图形处理器');
  assert.strictEqual(csv.length, 2);
  assert.strictEqual(csv[0].source, 'OpenAI');
  assert.strictEqual(csv[0].target, '开放人工智能');

  const json = H.parseGlossaryImport(JSON.stringify([
    { source: 'CLI', target: '命令行' },
    ['SDK', '软件开发工具包']
  ]), 'terms.json');
  assert.strictEqual(json.length, 2);
  assert.strictEqual(json[1].target, '软件开发工具包');
});

test('checkOfflineGate 仅放行缓存与本地', () => {
  assert.deepStrictEqual(
    H.checkOfflineGate({ offlineMode: false, provider: 'openai', cached: false }),
    { allowed: true }
  );
  assert.strictEqual(
    H.checkOfflineGate({ offlineMode: true, provider: 'openai', cached: true }).allowed,
    true
  );
  assert.strictEqual(
    H.checkOfflineGate({ offlineMode: true, provider: 'local', cached: false }).allowed,
    true
  );
  const blocked = H.checkOfflineGate({ offlineMode: true, provider: 'openai', cached: false });
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.reason);
});

test('isCloudRequestAllowed', () => {
  assert.strictEqual(H.isCloudRequestAllowed(true, 'openai'), false);
  assert.strictEqual(H.isCloudRequestAllowed(true, 'local'), true);
  assert.strictEqual(H.isCloudRequestAllowed(false, 'openai'), true);
});

test('shouldBlockWhenBrowserOffline 放行本地、拦截云端', () => {
  // 浏览器在线：从不拦截
  assert.strictEqual(H.shouldBlockWhenBrowserOffline(true, 'openai'), false);
  assert.strictEqual(H.shouldBlockWhenBrowserOffline(true, 'local'), false);
  // 浏览器离线：云端拦截，本地放行（Ollama localhost）
  assert.strictEqual(H.shouldBlockWhenBrowserOffline(false, 'openai'), true);
  assert.strictEqual(H.shouldBlockWhenBrowserOffline(false, 'qwen'), true);
  assert.strictEqual(H.shouldBlockWhenBrowserOffline(false, 'local'), false);
});

test('resolveSiteBilingualMode 站点覆盖全局', () => {
  const prefs = { 'example.com': { bilingualMode: false } };
  assert.strictEqual(H.resolveSiteBilingualMode('example.com', prefs, true), false);
  assert.strictEqual(H.resolveSiteBilingualMode('other.com', prefs, true), true);
  // www 前缀回退到无 www 域名偏好
  assert.strictEqual(H.resolveSiteBilingualMode('www.example.com', prefs, true), false);
});

test('addHostnameToList / removeHostnameFromList', () => {
  const a = H.addHostnameToList(['a.com'], 'b.com');
  assert.deepStrictEqual(a, ['a.com', 'b.com']);
  const b = H.addHostnameToList(['a.com'], 'a.com');
  assert.deepStrictEqual(b, ['a.com']);
  const c = H.removeHostnameFromList(['a.com', 'b.com'], 'a.com');
  assert.deepStrictEqual(c, ['b.com']);
});
