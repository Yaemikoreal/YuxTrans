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

test('首次引导：路径解析与步骤门禁', () => {
  assert.strictEqual(H.resolveFirstRunPath('local'), 'local');
  assert.strictEqual(H.resolveFirstRunPath('cloud'), 'cloud');
  assert.strictEqual(H.resolveFirstRunPath('other'), null);

  assert.strictEqual(H.canAdvanceFirstRunStep(1, { path: 'local' }), true);
  assert.strictEqual(H.canAdvanceFirstRunStep(1, {}), false);

  assert.strictEqual(H.canAdvanceFirstRunStep(2, { path: 'local', ollamaOk: true }), true);
  assert.strictEqual(H.canAdvanceFirstRunStep(2, { path: 'local', ollamaOk: false }), false);
  assert.strictEqual(
    H.canAdvanceFirstRunStep(2, { path: 'cloud', provider: 'qwen', apiKey: 'sk-x' }),
    true
  );
  assert.strictEqual(
    H.canAdvanceFirstRunStep(2, { path: 'cloud', provider: 'qwen', apiKey: '' }),
    false
  );

  assert.strictEqual(H.canAdvanceFirstRunStep(3, { trialOk: true }), true);
  assert.strictEqual(H.canAdvanceFirstRunStep(3, { trialOk: false }), false);
});

test('首次引导：档案草稿与试译句', () => {
  const local = H.buildFirstRunProfileDraft({ path: 'local', localModel: 'phi4-mini:latest' });
  assert.strictEqual(local.provider, 'local');
  assert.strictEqual(local.localModel, 'phi4-mini:latest');

  const cloud = H.buildFirstRunProfileDraft({
    path: 'cloud',
    provider: 'deepseek',
    apiKey: ' sk-test '
  });
  assert.strictEqual(cloud.provider, 'deepseek');
  assert.strictEqual(cloud.apiKey, 'sk-test');
  assert.strictEqual(H.getFirstRunTrialText(), 'Hello');
  assert.strictEqual(H.FIRST_RUN_TRIAL_TEXT, 'Hello');
});

test('formatUserErrorCompact 结论+行动两行且截断', () => {
  const compact = H.formatUserErrorCompact({
    userMessage: 'API Key 无效或权限不足',
    actionHint: '请打开设置检查并保存服务档案'
  });
  assert.ok(compact.includes('API Key'));
  assert.ok(compact.includes('\n'));
  assert.ok(!compact.includes('\n\n'));

  const long = H.formatUserErrorCompact({
    userMessage: 'A'.repeat(100),
    actionHint: 'B'.repeat(80)
  }, 20, 15);
  const [m, h] = long.split('\n');
  assert.ok(m.length <= 20);
  assert.ok(h.length <= 15);
  assert.ok(m.endsWith('…'));
});

test('pageControlCompletedActions 主次分离', () => {
  const ok = H.pageControlCompletedActions({ hasFailures: false });
  assert.deepStrictEqual(ok.primary, ['restore', 'bilingual', 'close']);
  assert.deepStrictEqual(ok.secondary, ['disableSite']);
  assert.ok(!ok.primary.includes('retry'));

  const fail = H.pageControlCompletedActions({ hasFailures: true });
  assert.ok(fail.secondary.includes('retry'));
  assert.ok(fail.secondary.includes('disableSite'));
  assert.ok(!fail.primary.includes('disableSite'));
});

test('shouldCollapsePopupStats 默认折叠用量', () => {
  assert.strictEqual(H.shouldCollapsePopupStats(), true);
});

test('isSingleWord 判定单词边界', () => {
  // 纯字母单词
  assert.strictEqual(H.isSingleWord('hello'), true);
  assert.strictEqual(H.isSingleWord('Translation'), true);
  // 含连字符 / 撇号
  assert.strictEqual(H.isSingleWord('state-of-the-art'), true);
  assert.strictEqual(H.isSingleWord("don't"), true);
  assert.strictEqual(H.isSingleWord("it's"), true);
  // 含空白 -> 非单词
  assert.strictEqual(H.isSingleWord('hello world'), false);
  assert.strictEqual(H.isSingleWord('  hello  '), true); // trim 后单词
  // 长度边界
  assert.strictEqual(H.isSingleWord(''), false);
  assert.strictEqual(H.isSingleWord('a'), false); // 单字符不匹配首尾字母模式
  assert.strictEqual(H.isSingleWord('ab'), true);
  assert.strictEqual(H.isSingleWord('x'.repeat(31)), false); // 超长
  // 非字母开头
  assert.strictEqual(H.isSingleWord('123abc'), false);
  assert.strictEqual(H.isSingleWord('-hello'), false);
  assert.strictEqual(H.isSingleWord(null), false);
  assert.strictEqual(H.isSingleWord(123), false);
});

test('isHoverParagraphCandidate 判定悬停段落候选', () => {
  // 合法块级段落
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'P', textLen: 50, inExcluded: false, alreadyDone: false }), true);
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'LI', textLen: 100, inExcluded: false, alreadyDone: false }), true);
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'BLOCKQUOTE', textLen: 300, inExcluded: false, alreadyDone: false }), true);
  // 非块级标签
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'SPAN', textLen: 50, inExcluded: false, alreadyDone: false }), false);
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'CODE', textLen: 50, inExcluded: false, alreadyDone: false }), false);
  // 排除区 / 已译
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'P', textLen: 50, inExcluded: true, alreadyDone: false }), false);
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'P', textLen: 50, inExcluded: false, alreadyDone: true }), false);
  // 文本长度边界
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'P', textLen: 2, inExcluded: false, alreadyDone: false }), false); // 过短
  // 超长（>1500）仍作为候选，由调用方截断并标记（spec：超长截断并标记）
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'P', textLen: 1501, inExcluded: false, alreadyDone: false }), true);
  assert.strictEqual(H.isHoverParagraphCandidate({ tagName: 'P', textLen: 1500, inExcluded: false, alreadyDone: false }), true); // 上限
  assert.strictEqual(H.isHoverParagraphCandidate(null), false);
  // HOVER_BLOCK_TAGS 白名单导出（content.js 与纯函数共用同一份，避免双份维护）
  assert.ok(Array.isArray(H.HOVER_BLOCK_TAGS));
  assert.ok(H.HOVER_BLOCK_TAGS.includes('P'));
  assert.ok(H.HOVER_BLOCK_TAGS.includes('BLOCKQUOTE'));
});

test('popupTitleText 语言对 + 供应商短名', () => {
  assert.strictEqual(H.popupTitleText('deepseek', 'en', 'zh'), 'EN -> 中 · DeepSeek');
  assert.strictEqual(H.popupTitleText('local', 'auto', 'zh'), '自动 -> 中 · 本地');
  assert.strictEqual(H.popupTitleText('anthropic', 'en', 'ja'), 'EN -> 日 · Claude');
  // 对照浮窗：无 provider，仅语言对
  assert.strictEqual(H.popupTitleText(null, 'en', 'zh'), 'EN -> 中');
  // 无语言对时回退 provider 或品牌名
  assert.strictEqual(H.popupTitleText('qwen', '', ''), 'Qwen');
  assert.strictEqual(H.popupTitleText(null, '', ''), 'YuxTrans');
});

test('OPTIONS_TAB_IDS 为五模块顶栏顺序', () => {
  assert.deepStrictEqual([...H.OPTIONS_TAB_IDS], [
    'profiles',
    'preference',
    'interaction',
    'data',
    'diagnostics'
  ]);
});

test('isOptionsModuleWritable 仅 preference/interaction/data', () => {
  assert.strictEqual(H.isOptionsModuleWritable('preference'), true);
  assert.strictEqual(H.isOptionsModuleWritable('interaction'), true);
  assert.strictEqual(H.isOptionsModuleWritable('data'), true);
  assert.strictEqual(H.isOptionsModuleWritable('profiles'), false);
  assert.strictEqual(H.isOptionsModuleWritable('diagnostics'), false);
});

test('pickModuleConfig 按模块切片且不串字段', () => {
  const values = {
    sourceLang: 'en',
    targetLang: 'zh',
    translateStyle: 'academic',
    stylePrompts: { academic: 'Custom academic' },
    offlineMode: true,
    triggerMode: 'icon',
    enableStreaming: false,
    originalStyle: 'fade',
    hoverTranslate: true,
    dictMode: false,
    autoCopy: true,
    hoverModifier: 'ctrl',
    dictDblclick: false,
    inputTranslate: true,
    smartContentDetection: true,
    compareProfileId: 'p2',
    cacheEnabled: false,
    maxCacheMB: 300,
    siteRule: 'whitelist',
    siteList: ['a.com'],
    autoDetectLang: false,
    autoFallback: false,
    noise: 'drop-me'
  };
  const pref = H.pickModuleConfig('preference', values);
  assert.deepStrictEqual(Object.keys(pref).sort(), ['offlineMode', 'sourceLang', 'stylePrompts', 'targetLang', 'translateStyle'].sort());
  assert.strictEqual(pref.sourceLang, 'en');
  assert.strictEqual(pref.offlineMode, true);
  assert.deepStrictEqual(pref.stylePrompts, { academic: 'Custom academic' });
  assert.ok(!('triggerMode' in pref));
  assert.ok(!('noise' in pref));

  const inter = H.pickModuleConfig('interaction', values);
  assert.strictEqual(inter.triggerMode, 'icon');
  assert.strictEqual(inter.compareProfileId, 'p2');
  assert.ok(!('sourceLang' in inter));
  assert.ok(!('maxCacheMB' in inter));
  assert.strictEqual(Object.keys(inter).length, H.OPTIONS_MODULE_KEYS.interaction.length);

  const data = H.pickModuleConfig('data', values);
  assert.strictEqual(data.maxCacheMB, 300);
  assert.deepStrictEqual(data.siteList, ['a.com']);
  assert.ok(!('translateStyle' in data));
  assert.deepStrictEqual(H.pickModuleConfig('diagnostics', values), {});
  assert.deepStrictEqual(H.pickModuleConfig('preference', null), {});
});

test('shouldShowOptionsQuickStart G1 可见性', () => {
  assert.strictEqual(H.shouldShowOptionsQuickStart({ firstRunPending: true, profiles: [{ id: 'a' }], activeProfileId: 'a' }), true);
  assert.strictEqual(H.shouldShowOptionsQuickStart({ profiles: [], activeProfileId: '' }), true);
  assert.strictEqual(H.shouldShowOptionsQuickStart({ profiles: [{ id: 'a' }], activeProfileId: '' }), true);
  assert.strictEqual(H.shouldShowOptionsQuickStart({ profiles: [{ id: 'a' }], activeProfileId: 'missing' }), true);
  assert.strictEqual(H.shouldShowOptionsQuickStart({ profiles: [{ id: 'a' }], activeProfileId: 'a' }), false);
});

test('resolveEventElement / eventTargetClosest 兼容 Text 节点 target', () => {
  // 模拟飞书等：mouseup target 为 TEXT_NODE，无 closest
  const parent = {
    nodeType: 1,
    closest(sel) {
      return sel === '.yuxtrans-popup' ? parent : null;
    }
  };
  const textNode = {
    nodeType: 3,
    parentElement: parent,
    parentNode: parent
  };
  assert.strictEqual(H.resolveEventElement(textNode), parent);
  assert.strictEqual(H.eventTargetClosest(textNode, '.yuxtrans-popup'), parent);
  assert.strictEqual(H.eventTargetClosest(textNode, '.other'), null);

  // 已是 Element
  assert.strictEqual(H.resolveEventElement(parent), parent);
  // 非法 target 不抛错
  assert.strictEqual(H.resolveEventElement(null), null);
  assert.strictEqual(H.resolveEventElement(undefined), null);
  assert.strictEqual(H.eventTargetClosest({ nodeType: 3 }, '.x'), null);
  assert.strictEqual(H.eventTargetClosest({ foo: 1 }, '.x'), null);
});
