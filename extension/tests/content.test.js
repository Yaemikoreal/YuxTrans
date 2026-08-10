/**
 * Content Script 整页翻译流式路径单元测试
 * 使用 Node 内置 test runner + 最小化 DOM/chrome mock，无额外依赖。
 * 覆盖：enableStreaming 开→整页走 translateStream；关→仍走 translateBatch；
 * 流式 chunk 聚合渲染、失败标记、重复文本去重、取消守卫。
 */

const { test } = require('node:test');
const assert = require('node:assert');

// 提供与运行时一致的 helpers（manifest 中 product-helpers.js 先于 content.js 加载，
// content.js 构造时读取全局 YuxTransHelpers；测试环境同步注入）
global.YuxTransHelpers = require('../lib/product-helpers.js');

// ===== 最小化 DOM mock =====

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...cls) { cls.forEach((c) => this._set.add(c)); }
  remove(...cls) { cls.forEach((c) => this._set.delete(c)); }
  contains(c) { return this._set.has(c); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentElement = null;
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this.id = '';
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.type = '';
  }
  get nextSibling() {
    if (!this.parentElement) return null;
    const sibs = this.parentElement.childNodes;
    const i = sibs.indexOf(this);
    return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
  }
  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child, ref) {
    child.parentElement = this;
    child.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, child);
    else this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  addEventListener(type, fn) {
    if (!this._listeners) this._listeners = {};
    this._listeners[type] = fn;
  }
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains(el) {
    for (const c of this.childNodes) {
      if (c === el) return true;
      if (c instanceof FakeElement && c.contains(el)) return true;
    }
    return false;
  }
}

global.document = {
  getElementById: () => null,
  createElement: (tag) => new FakeElement(tag),
  head: new FakeElement('head'),
  body: new FakeElement('body'),
  addEventListener: () => {},
  querySelectorAll: () => [],
  title: 'Test Page'
};
global.window = {
  getSelection: () => ({ toString: () => '', rangeCount: 0 }),
  getComputedStyle: () => ({
    fontWeight: 'normal', fontStyle: 'normal', color: '#333', fontSize: '16px'
  }),
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: () => {}
};
global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
global.location = { hostname: 'example.com', href: 'https://example.com/article' };

// content.js 拆分模块：Node 下经 globalThis 取类，IIFE 即挂原型（与 manifest 注入顺序一致）
require('../lib/content/constants.js');
const { YuxTransContent } = require('../content.js');
require('../lib/content/selection.js');
require('../lib/content/dict.js');
require('../lib/content/hover.js');
require('../lib/content/input.js');
require('../lib/content/page.js');
require('../lib/content/init.js');

/**
 * 构造一个带父元素的文本节点翻译项（模拟 collectTextNodes 的输出）
 */
function makeNodeInfo(text) {
  const parent = new FakeElement('p');
  const node = {
    nodeType: 3,
    parentElement: parent,
    parentNode: parent,
    textContent: text,
    nextSibling: null
  };
  parent.childNodes.push(node);
  return { text, node, isInViewport: true };
}

/**
 * 在节点的父元素下查找双语译文 span
 */
function findBilingualSpan(nodeInfo) {
  return nodeInfo.node.parentElement.childNodes.find(
    (c) => c instanceof FakeElement && c.className === 'yuxtrans-bilingual-text'
  );
}

/**
 * 创建测试环境：注入 chrome mock 与可配置的 getConfig 响应，实例化内容脚本。
 * 控制条/指标上报等依赖真实 DOM 的方法打桩，核心翻译链路保持真实逻辑。
 */
function setup(configOverrides = {}) {
  const configResponse = Object.assign({
    provider: 'qwen',
    model: 'qwen-turbo',
    sourceLang: 'auto',
    targetLang: 'zh',
    siteRule: 'all',
    siteList: [],
    triggerMode: 'auto',
    enableStreaming: true,
    bilingualMode: true,
    profiles: [],
    activeProfileId: ''
  }, configOverrides);

  const sent = [];
  const handlers = {};
  let messageListener = null;
  handlers.getConfig = () => configResponse;

  global.chrome = {
    runtime: {
      id: 'yuxtrans-test',
      onMessage: { addListener: (fn) => { messageListener = fn; } },
      sendMessage: (msg, cb) => {
        sent.push({ msg, cb });
        const h = handlers[msg.action];
        const result = h ? h(msg) : undefined;
        if (typeof cb === 'function') {
          Promise.resolve(result).then((r) => cb(r));
        }
        return Promise.resolve(result);
      }
    },
    storage: { onChanged: { addListener: () => {} } }
  };

  const instance = new YuxTransContent();
  instance.showPageControl = () => {};
  instance.updatePageControl = () => {};
  instance.showPageControlComplete = () => {};
  instance.logPageMetrics = () => {};

  const mock = {
    sent,
    handlers,
    // 模拟 SW → content 的推送消息（streamChunk 等）
    emitToContent: (msg) => messageListener && messageListener(msg, {}, () => {})
  };
  return { instance, mock };
}

test('整页翻译：enableStreaming 开启走 translateStream 且逐段流式渲染', async () => {
  const { instance, mock } = setup({ enableStreaming: true });
  const nodes = [makeNodeInfo('First paragraph text.'), makeNodeInfo('Second paragraph text.')];
  instance.collectTextNodes = () => nodes;

  // 模拟 SW：先推两段 streamChunk，再回最终响应
  const tempSnapshots = [];
  mock.handlers.translateStream = (msg) => {
    const full = '流式:' + msg.text;
    const half = Math.ceil(full.length / 2);
    const p1 = full.slice(0, half);
    const p2 = full.slice(half);
    mock.emitToContent({ action: 'streamChunk', chunk: p1, fullText: p1, requestId: msg.requestId });
    mock.emitToContent({ action: 'streamChunk', chunk: p2, fullText: full, requestId: msg.requestId });
    const st = instance.pageTranslationState.streamingNodes.get(msg.requestId);
    tempSnapshots.push({ text: msg.text, snap: st ? st.tempSpan.textContent : null });
    return { success: true, text: full, cached: false, engine: 'qwen' };
  };

  await instance.translatePage();

  const streamMsgs = mock.sent.filter((s) => s.msg.action === 'translateStream');
  const batchMsgs = mock.sent.filter((s) => s.msg.action === 'translateBatch');
  assert.strictEqual(streamMsgs.length, 2, '每个段落发送一次 translateStream');
  assert.strictEqual(batchMsgs.length, 0, '不应走批量路径');

  // requestId 唯一、接入取消会话；不携带页面上下文
  assert.notStrictEqual(streamMsgs[0].msg.requestId, streamMsgs[1].msg.requestId);
  assert.ok(streamMsgs.every((s) => /^yxt-page-stream-\d+$/.test(s.msg.requestId)));
  assert.ok(streamMsgs.every((s) => s.msg.sessionId && s.msg.sessionId === instance._pageSessionId));
  assert.ok(streamMsgs.every((s) => s.msg.context === null));

  // chunk 聚合：流式过程中 tempSpan 实时刷新为 fullText
  for (const item of tempSnapshots) {
    assert.strictEqual(item.snap, '流式:' + item.text);
  }

  // 完成后：临时 span 移除，双语译文落地
  for (const ni of nodes) {
    const span = findBilingualSpan(ni);
    assert.ok(span, '双语译文 span 已插入');
    assert.strictEqual(span.textContent, '流式:' + ni.text);
    assert.ok(ni.node.parentElement.classList.contains('yuxtrans-translated-bilingual'));
    assert.ok(!ni.node.parentElement.childNodes.some(
      (c) => c.className === 'yuxtrans-streaming-text'
    ), '临时流式 span 应被清理');
  }
  assert.strictEqual(instance.pageTranslationState.isTranslated, true);
  assert.strictEqual(instance.pageTranslationState.apiCount, 2);
  assert.strictEqual(instance.pageTranslationState.cacheHits, 0);
  assert.strictEqual(instance.pageTranslationState.streamingNodes.size, 0);
});

test('整页翻译：enableStreaming 关闭保持 translateBatch 批量路径', async () => {
  const { instance, mock } = setup({ enableStreaming: false });
  const nodes = [makeNodeInfo('Alpha paragraph one.'), makeNodeInfo('Beta paragraph two.')];
  instance.collectTextNodes = () => nodes;
  mock.handlers.translateBatch = (msg) => ({
    success: true,
    results: msg.texts.map((t) => ({ success: true, text: '批量:' + t, cached: false }))
  });

  await instance.translatePage();

  const batchMsgs = mock.sent.filter((s) => s.msg.action === 'translateBatch');
  const streamMsgs = mock.sent.filter((s) => s.msg.action === 'translateStream');
  assert.strictEqual(batchMsgs.length, 1, '两段文本合并为一次批量请求');
  assert.strictEqual(streamMsgs.length, 0, '不应走流式路径');
  assert.deepStrictEqual(batchMsgs[0].msg.texts, nodes.map((n) => n.text));

  for (const ni of nodes) {
    const span = findBilingualSpan(ni);
    assert.ok(span);
    assert.strictEqual(span.textContent, '批量:' + ni.text);
  }
  assert.strictEqual(instance.pageTranslationState.isTranslated, true);
});

test('ADR 0006：云端 belowFold 改走批量（首屏仍流式）', async () => {
  const { instance, mock } = setup({ provider: 'qwen', enableStreaming: true });
  const viewport = makeNodeInfo('Viewport paragraph.');
  const below = makeNodeInfo('Below fold paragraph.');
  below.isInViewport = false;
  instance.collectTextNodes = () => [viewport, below];
  mock.handlers.translateStream = (msg) => ({
    success: true, text: '流式:' + msg.text, cached: false
  });
  mock.handlers.translateBatch = (msg) => ({
    success: true,
    results: msg.texts.map((t) => ({ success: true, text: '批量:' + t, cached: false }))
  });

  let belowOptions = 'NOT_CALLED';
  instance._translateBelowFoldViaViewport = async (items, onBatchResult, batchOptions) => {
    belowOptions = batchOptions;
    onBatchResult(
      items.map((_, i) => i),
      items,
      items.map((it) => ({ success: true, text: '批量:' + it.text, cached: false }))
    );
  };

  await instance.translatePage();

  assert.strictEqual(belowOptions, null, '云端 belowFold 应走批量（不传 streaming）');
  const streamMsgs = mock.sent.filter((s) => s.msg.action === 'translateStream');
  assert.strictEqual(streamMsgs.length, 1, '首屏视口内仍走流式');
});

test('ADR 0006：本地 Ollama belowFold 保留流式', async () => {
  const { instance, mock } = setup({ provider: 'local', enableStreaming: true });
  const viewport = makeNodeInfo('Local viewport paragraph.');
  const below = makeNodeInfo('Local below fold paragraph.');
  below.isInViewport = false;
  instance.collectTextNodes = () => [viewport, below];
  mock.handlers.translateStream = (msg) => ({
    success: true, text: '流式:' + msg.text, cached: false
  });

  let belowOptions = null;
  instance._translateBelowFoldViaViewport = async (items, onBatchResult, batchOptions) => {
    belowOptions = batchOptions;
  };

  await instance.translatePage();

  assert.deepStrictEqual(belowOptions, { streaming: true }, '本地 Ollama 保留流式');
});

test('ADR 0006：动态增量云端走批量、本地保留流式', async () => {
  // 云端：动态增量不带 streaming
  const cloud = setup({ provider: 'qwen', enableStreaming: true });
  cloud.instance.pageTranslationState.isTranslated = true;
  const cloudRoot = new FakeElement('div');
  cloudRoot.isConnected = true;
  cloud.instance._pendingAddedRoots.add(cloudRoot);
  const cloudNodes = [makeNodeInfo('Dynamic cloud paragraph.')];
  cloud.instance.collectTextNodes = (r) => (r === cloudRoot ? cloudNodes : []);
  const cloudOptions = [];
  cloud.instance.translateBatchParallel = async (items, onProgress, onBatchResult, options) => {
    cloudOptions.push(options);
  };

  await cloud.instance._processAddedNodes();

  assert.deepStrictEqual(cloudOptions[0], {}, '云端动态增量走批量（不带 streaming）');

  // 本地：enableStreaming 开启时保留流式
  const local = setup({ provider: 'local', enableStreaming: true });
  local.instance.pageTranslationState.isTranslated = true;
  const localRoot = new FakeElement('div');
  localRoot.isConnected = true;
  local.instance._pendingAddedRoots.add(localRoot);
  const localNodes = [makeNodeInfo('Dynamic local paragraph.')];
  local.instance.collectTextNodes = (r) => (r === localRoot ? localNodes : []);
  const localOptions = [];
  local.instance.translateBatchParallel = async (items, onProgress, onBatchResult, options) => {
    localOptions.push(options);
  };

  await local.instance._processAddedNodes();

  assert.deepStrictEqual(localOptions[0], { streaming: true }, '本地动态增量保留流式');
});

test('ADR 0006：logPageMetrics 落盘为 recordPageMetrics 指标', () => {
  const { instance, mock } = setup({ provider: 'qwen', model: 'qwen-turbo' });
  // setup 默认打桩了 logPageMetrics，此用例直接验证真实落盘路径
  instance.logPageMetrics = YuxTransContent.prototype.logPageMetrics;
  instance.config = { provider: 'qwen', model: 'qwen-turbo' };
  instance.logPageMetrics({
    totalNodes: 10,
    viewportNodes: 3,
    belowFoldNodes: 7,
    duplicateTexts: 1,
    successCount: 9,
    failCount: 1,
    cacheHits: 2,
    apiCount: 7,
    elapsedSeconds: 3.5,
    viewportDoneMs: 1200
  });

  const msgs = mock.sent.filter((s) => s.msg.action === 'recordPageMetrics');
  assert.strictEqual(msgs.length, 1, '应发送一次 recordPageMetrics');
  const metric = msgs[0].msg.metric;
  assert.strictEqual(metric.provider, 'qwen');
  assert.strictEqual(metric.model, 'qwen-turbo');
  assert.strictEqual(metric.success, false, '存在失败项时 success=false');
  assert.strictEqual(metric.elapsedMs, 3500, '秒转毫秒落盘');
  assert.strictEqual(metric.viewportDoneMs, 1200);
  assert.strictEqual(metric.totalNodes, 10);
  assert.strictEqual(metric.belowFoldNodes, 7);
  assert.strictEqual(metric.cacheHits, 2);
  assert.strictEqual(metric.failCount, 1);
});

test('整页翻译：流式失败段落标记为失败且整体完成', async () => {
  const { instance, mock } = setup({ enableStreaming: true });
  const nodes = [makeNodeInfo('Broken paragraph text.')];
  instance.collectTextNodes = () => nodes;
  mock.handlers.translateStream = () => ({ success: false, error: '服务暂时不可用' });

  await instance.translatePage();

  assert.strictEqual(instance.pageTranslationState.isTranslated, true);
  assert.strictEqual(instance.pageTranslationState.failedItems.length, 1);
  assert.ok(nodes[0].node.parentElement.classList.contains('yuxtrans-failed'));
  assert.strictEqual(findBilingualSpan(nodes[0]), undefined);
});

test('整页翻译：重复文本只发一次流式请求并同步渲染所有出现位置', async () => {
  const { instance, mock } = setup({ enableStreaming: true });
  const nodes = [makeNodeInfo('Same text here.'), makeNodeInfo('Same text here.')];
  instance.collectTextNodes = () => nodes;
  mock.handlers.translateStream = (msg) => ({
    success: true, text: '相同译文', cached: false, engine: 'qwen'
  });

  await instance.translatePage();

  const streamMsgs = mock.sent.filter((s) => s.msg.action === 'translateStream');
  assert.strictEqual(streamMsgs.length, 1, '去重后只请求一次');
  for (const ni of nodes) {
    const span = findBilingualSpan(ni);
    assert.ok(span, '重复文本的每个出现位置都应渲染译文');
    assert.strictEqual(span.textContent, '相同译文');
  }
});

test('handleStreamChunk：段落 chunk 刷新 tempSpan，过期段落 chunk 不污染弹窗', () => {
  const { instance } = setup();
  const tempSpan = new FakeElement('span');
  instance.pageTranslationState.streamingNodes.set('yxt-page-stream-1', { nodeInfo: {}, tempSpan });

  // 段落级流式：按 fullText 实时刷新
  instance.handleStreamChunk('你', '你', 'yxt-page-stream-1');
  instance.handleStreamChunk('好', '你好', 'yxt-page-stream-1');
  assert.strictEqual(tempSpan.textContent, '你好');

  // 过期段落 requestId（streamingNodes 已清理）：忽略，不写入弹窗
  const target = { textContent: '原有译文', querySelector: () => null };
  instance.popup = {
    querySelector: (sel) => (sel === '.yuxtrans-target' ? target : null)
  };
  instance.handleStreamChunk('X', 'X', 'yxt-page-stream-999');
  assert.strictEqual(target.textContent, '原有译文');

  // 弹窗自身的 requestId：正常增量追加
  instance.handleStreamChunk('增', '', 'popup');
  assert.strictEqual(target.textContent, '原有译文增');
});

test('translateStreamForNode：取消后不发起新请求', async () => {
  const { instance, mock } = setup();
  instance.pageTranslationState.isTranslating = true;
  instance.pageTranslationState.cancelRequested = true;

  const res = await instance.translateStreamForNode(makeNodeInfo('Some paragraph text.'), 'yxt-page-stream-x');
  assert.strictEqual(res.success, false);
  assert.strictEqual(
    mock.sent.filter((s) => s.msg.action === 'translateStream').length,
    0,
    '取消后不应再发送流式请求'
  );
});

// ===== modifier 触发模式：划选门槛行为 =====
// 利用 setup() 的 getConfig 响应下发 triggerMode/selectionModifier，
// 等 loadConfig 微任务落地后直接驱动 handleMouseUp（内部 setTimeout 10ms，等 30ms）。

test('modifier 模式：未按修饰键的划选不发起翻译请求', async () => {
  const { instance, mock } = setup({ triggerMode: 'modifier', selectionModifier: 'ctrl' });
  instance.showPopup = () => {};
  instance.updatePopup = () => {};
  instance._toggleInsertBtn = () => {};

  const prevGetSelection = global.window.getSelection;
  global.window.getSelection = () => ({ toString: () => 'Hello world', rangeCount: 0 });
  try {
    await new Promise((r) => setTimeout(r, 20)); // 等 loadConfig 应用 triggerMode
    instance.handleMouseUp({ target: null, ctrlKey: false, clientX: 10, clientY: 20 });
    await new Promise((r) => setTimeout(r, 30)); // 等 handleMouseUp 内部 setTimeout(10ms)

    const translateMsgs = mock.sent.filter(
      (s) => s.msg.action === 'translate' || s.msg.action === 'translateStream'
    );
    assert.strictEqual(translateMsgs.length, 0, '未按 Ctrl 时不应发起翻译请求');
  } finally {
    global.window.getSelection = prevGetSelection;
  }
});

test('modifier 模式：按住配置修饰键的划选发起 translateText', async () => {
  const { instance, mock } = setup({ triggerMode: 'modifier', selectionModifier: 'ctrl' });
  instance.showPopup = () => {};
  instance.updatePopup = () => {};
  instance._toggleInsertBtn = () => {};

  const prevGetSelection = global.window.getSelection;
  global.window.getSelection = () => ({ toString: () => 'Hello world', rangeCount: 0 });
  try {
    await new Promise((r) => setTimeout(r, 20)); // 等 loadConfig 应用 triggerMode
    instance.handleMouseUp({ target: null, ctrlKey: true, clientX: 10, clientY: 20 });
    await new Promise((r) => setTimeout(r, 30)); // 等 handleMouseUp 内部 setTimeout(10ms)

    const translateMsgs = mock.sent.filter(
      (s) => s.msg.action === 'translate' || s.msg.action === 'translateStream'
    );
    assert.strictEqual(translateMsgs.length, 1, '按住 Ctrl 划选应发起一次翻译请求');
    assert.strictEqual(translateMsgs[0].msg.text, 'Hello world');
  } finally {
    global.window.getSelection = prevGetSelection;
  }
});

// ===== 交互冲突修复（#1/#2/#4/#8B/#11/#14）行为用例 =====

test('#1 双击守卫：detail>=2 + 单词选区 + 双击查词开启 → 不发翻译/查词请求', async () => {
  const { instance, mock } = setup({ triggerMode: 'auto' });
  instance.showPopup = () => {};
  instance.updatePopup = () => {};
  instance._toggleInsertBtn = () => {};

  const prevGetSelection = global.window.getSelection;
  global.window.getSelection = () => ({ toString: () => 'hello', rangeCount: 0 });
  try {
    await new Promise((r) => setTimeout(r, 20)); // 等 loadConfig 落地
    instance.handleMouseUp({ target: null, detail: 2, clientX: 10, clientY: 20 });
    await new Promise((r) => setTimeout(r, 30)); // 等 handleMouseUp 内部 setTimeout(10ms)

    const reqs = mock.sent.filter(
      (s) => ['lookupWord', 'translate', 'translateStream'].includes(s.msg.action)
    );
    assert.strictEqual(reqs.length, 0, '双击单词应交给 _handleDblClick，划词链路不发请求');
  } finally {
    global.window.getSelection = prevGetSelection;
  }
});

test('#1 单击划选单词（detail=1）仍正常走词典查询', async () => {
  const { instance, mock } = setup({ triggerMode: 'auto' });
  instance.showPopup = function () {
    this.popup = { dataset: {}, querySelector: () => null };
  };
  instance.updatePopup = () => {};
  instance.renderDictResult = () => {};
  instance._toggleInsertBtn = () => {};

  const prevGetSelection = global.window.getSelection;
  global.window.getSelection = () => ({ toString: () => 'hello', rangeCount: 0 });
  try {
    await new Promise((r) => setTimeout(r, 20));
    instance.handleMouseUp({ target: null, detail: 1, clientX: 10, clientY: 20 });
    await new Promise((r) => setTimeout(r, 30));

    const dictReqs = mock.sent.filter((s) => s.msg.action === 'lookupWord');
    assert.strictEqual(dictReqs.length, 1, '单击划选单词应发起一次词典查询');
    assert.strictEqual(dictReqs[0].msg.text, 'hello');
  } finally {
    global.window.getSelection = prevGetSelection;
  }
});

test('#14 输入框翻译：contextMenu 模式不弹窗不发请求', async () => {
  const { instance, mock } = setup({ triggerMode: 'contextMenu', inputTranslate: true });
  instance.showPopup = () => {};
  instance.updatePopup = () => {};
  instance._toggleInsertBtn = () => {};

  const inputEl = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    value: 'hello world',
    selectionStart: 0,
    selectionEnd: 5,
    closest(sel) { return sel.includes('textarea') ? this : null; }
  };

  await new Promise((r) => setTimeout(r, 20));
  instance.handleMouseUp({ target: inputEl, clientX: 5, clientY: 5 });
  await new Promise((r) => setTimeout(r, 30));

  const reqs = mock.sent.filter(
    (s) => ['lookupWord', 'translate', 'translateStream'].includes(s.msg.action)
  );
  assert.strictEqual(reqs.length, 0, 'contextMenu 模式输入框划选不应发请求');
  assert.ok(!instance.floatBtn, 'contextMenu 模式不应出浮钮');
});

test('#14 输入框翻译：icon 模式出浮钮且不直接翻译', async () => {
  const { instance, mock } = setup({ triggerMode: 'icon', inputTranslate: true });

  const inputEl = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    value: 'hello world',
    selectionStart: 0,
    selectionEnd: 11,
    closest(sel) { return sel.includes('textarea') ? this : null; }
  };

  await new Promise((r) => setTimeout(r, 20));
  instance.handleMouseUp({ target: inputEl, clientX: 5, clientY: 5 });
  await new Promise((r) => setTimeout(r, 30));

  const reqs = mock.sent.filter(
    (s) => ['lookupWord', 'translate', 'translateStream'].includes(s.msg.action)
  );
  assert.strictEqual(reqs.length, 0, 'icon 模式不应直接发翻译请求');
  assert.ok(instance.floatBtn, 'icon 模式应显示悬浮按钮');
  assert.strictEqual(instance._lastInputElement, inputEl, 'F5 插入能力保留（记录触发输入框）');
});

test('#8B 选区位于译文元素（.yuxtrans-bilingual-text）内时不触发翻译', async () => {
  const { instance, mock } = setup({ triggerMode: 'auto' });
  instance.showPopup = () => {};
  instance.updatePopup = () => {};

  const bilingualEl = {
    nodeType: 1,
    closest(sel) { return sel.includes('.yuxtrans-bilingual-text') ? this : null; }
  };
  const prevGetSelection = global.window.getSelection;
  global.window.getSelection = () => ({
    toString: () => '这是译文文本内容',
    rangeCount: 1,
    getRangeAt: () => ({ commonAncestorContainer: bilingualEl })
  });
  try {
    await new Promise((r) => setTimeout(r, 20));
    instance.handleMouseUp({ target: null, clientX: 10, clientY: 20 });
    await new Promise((r) => setTimeout(r, 30));

    const reqs = mock.sent.filter(
      (s) => ['lookupWord', 'translate', 'translateStream'].includes(s.msg.action)
    );
    assert.strictEqual(reqs.length, 0, '译文区域的再次划选不应触发翻译');
  } finally {
    global.window.getSelection = prevGetSelection;
  }
});

test('#2 showPopup 打开浮窗前清除悬浮按钮', () => {
  const { instance } = setup();
  instance.showFloatButton(10, 10, 'hello');
  assert.ok(instance.floatBtn, '浮钮已显示');

  // showPopup 依赖真实 DOM 能力（querySelector/rAF/布局），测试环境打桩最小子集
  const prevRaf = global.requestAnimationFrame;
  const prevQS = FakeElement.prototype.querySelector;
  const hadGBCR = 'getBoundingClientRect' in FakeElement.prototype;
  const prevGBCR = FakeElement.prototype.getBoundingClientRect;
  const domStub = { addEventListener: () => {}, hidden: false };
  global.requestAnimationFrame = (fn) => fn();
  FakeElement.prototype.querySelector = () => domStub;
  FakeElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 });
  try {
    instance.showPopup(10, 10, 'hello');
    assert.strictEqual(instance.floatBtn, null, 'showPopup 应清除浮钮');
  } finally {
    global.requestAnimationFrame = prevRaf;
    FakeElement.prototype.querySelector = prevQS;
    if (hadGBCR) FakeElement.prototype.getBoundingClientRect = prevGBCR;
    else delete FakeElement.prototype.getBoundingClientRect;
    instance.popup = null;
  }
});

test('#4 requestId 路由：响应/流式 chunk 各写入捕获浮窗，销毁浮窗的响应被丢弃', async () => {
  const { instance, mock } = setup({ enableStreaming: false });
  instance._toggleInsertBtn = () => {};
  // 简化 showPopup：创建带 target 子节点的浮窗元素并挂到 body
  instance.showPopup = function (x, y, text) {
    const el = new FakeElement('div');
    el.dataset.sourceText = text;
    const target = new FakeElement('div');
    el.appendChild(target);
    el.querySelector = (sel) => (sel === '.yuxtrans-target' ? target : null);
    document.body.appendChild(el);
    this.popup = el;
  };
  // updatePopup 真实实现依赖完整浮窗 DOM，打桩为直接写 target（仍校验路由目标）
  instance.updatePopup = (text, cached, engine, src, popupEl) => {
    const t = (popupEl || instance.popup).querySelector('.yuxtrans-target');
    t.textContent = text;
  };

  let resolveLookup;
  mock.handlers.translate = (msg) => ({
    success: true, text: '译:' + msg.text, cached: false, engine: 'qwen', requestId: msg.requestId
  });
  mock.handlers.lookupWord = () => new Promise((res) => { resolveLookup = res; });

  await new Promise((r) => setTimeout(r, 20)); // 等 loadConfig 应用 enableStreaming:false（走 translate）
  // 划词翻译在途（popupA），随后双击查词（popupB）——#11 拆分标志后两者可并发
  instance.translateText('first text', 0, 0);
  const popupA = instance.popup;
  const reqA = mock.sent.find((s) => s.msg.action === 'translate').msg.requestId;

  instance.lookupWord('hello', 0, 0);
  const popupB = instance.popup;
  const reqB = mock.sent.find((s) => s.msg.action === 'lookupWord').msg.requestId;
  assert.notStrictEqual(reqA, reqB, '每个请求应有唯一 requestId');

  // 流式 chunk 按 requestId 路由到 popupA（即使当前浮窗已是 popupB）
  instance.handleStreamChunk('块A', '块A', reqA);
  assert.strictEqual(popupA.querySelector('.yuxtrans-target').textContent, '块A');
  assert.strictEqual(popupB.querySelector('.yuxtrans-target').textContent, '');

  // popupB 销毁后，其迟到响应被丢弃并清理映射
  instance.hidePopup(); // 销毁当前浮窗 popupB（真实路径：remove + 清空 this.popup + 清扫映射）
  resolveLookup({ success: true, dict: { word: 'hello', senses: [] }, requestId: reqB });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(instance._popupRequests.has(reqB), false, '销毁浮窗的映射应被清理');
  assert.strictEqual(popupB.querySelector('.yuxtrans-target').textContent, '', '销毁浮窗不应被写入');

  // popupA 的响应正常写回 popupA（而非当前浮窗）
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(popupA.querySelector('.yuxtrans-target').textContent, '译:first text');
  assert.strictEqual(instance._popupRequests.size, 0, '全部响应后映射清空');
});

test('#11 拆分在途标志：词典在途不阻塞划词翻译', async () => {
  const { instance, mock } = setup({ enableStreaming: false });
  instance._toggleInsertBtn = () => {};
  instance.showPopup = function () {
    const el = new FakeElement('div');
    document.body.appendChild(el);
    this.popup = el;
  };
  instance.updatePopup = () => {};
  mock.handlers.lookupWord = () => new Promise(() => {}); // 永不返回，模拟 SW 沉默
  mock.handlers.translate = (msg) => ({
    success: true, text: '译:' + msg.text, requestId: msg.requestId
  });

  instance.lookupWord('hello', 0, 0);
  assert.strictEqual(instance.isDictLookingUp, true);
  assert.strictEqual(instance.isTranslating, false, '词典在途不占用划词标志');

  await new Promise((r) => setTimeout(r, 20)); // 等 loadConfig 应用 enableStreaming:false（走 translate）
  instance.translateText('some longer text', 0, 0);
  const translateMsgs = mock.sent.filter((s) => s.msg.action === 'translate');
  assert.strictEqual(translateMsgs.length, 1, '划词翻译不应被词典在途阻塞');

  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(instance.isTranslating, false, '划词响应后标志复位');
  assert.strictEqual(instance.isDictLookingUp, true, '词典仍在途（等待看门狗或响应）');
});

// ===== #54 整页控制条挂耳（side tab） =====
// 利用 setup() 实例 + FakeElement 直接驱动 collapse/expand/hide 三个方法，
// 验证：关闭收起为挂耳、挂耳点击回调重新展开、hidePageControl 两者一并移除。

function makePageControl(instance) {
  const control = new FakeElement('div');
  control.className = 'yuxtrans-page-control';
  document.body.appendChild(control);
  instance.pageControl = control;
  return control;
}

function cleanupPageControl(instance, control) {
  instance.removeSideTab();
  if (control.parentElement) control.remove();
  instance.pageControl = null;
}

test('#54 关闭控制条收起为挂耳：控制条隐藏保留，挂耳出现', () => {
  const { instance } = setup();
  const control = makePageControl(instance);
  try {
    instance.collapsePageControlToTab();

    assert.strictEqual(control.style.display, 'none', '控制条应隐藏而非销毁');
    assert.strictEqual(instance.pageControl, control, '控制条引用保留以维持进度/按钮状态');
    assert.ok(instance.sideTab, '挂耳应已创建');
    assert.strictEqual(instance.sideTab.className, 'yuxtrans-side-tab');
    // Stage F：挂耳元素在 shadow host 内，host 才直接挂在 body 上
    assert.strictEqual(instance.sideTab._yxtHost.parentElement, document.body, '挂耳 shadow host 挂在 body 上');
  } finally {
    cleanupPageControl(instance, control);
  }
});

test('#54 点击挂耳重新展开原控制条并移除挂耳', () => {
  const { instance } = setup();
  const control = makePageControl(instance);
  try {
    instance.collapsePageControlToTab();
    const tab = instance.sideTab;
    assert.ok(tab._listeners && typeof tab._listeners.click === 'function', '挂耳应绑定点击回调');

    tab._listeners.click(); // 模拟点击挂耳

    assert.strictEqual(control.style.display, '', '控制条恢复可见');
    assert.strictEqual(instance.sideTab, null, '挂耳引用已清空');
    assert.ok(!document.body.childNodes.includes(tab), '挂耳节点已从 DOM 移除');
  } finally {
    cleanupPageControl(instance, control);
  }
});

test('#54 hidePageControl（恢复原文/取消/重新翻译前置）将控制条与挂耳一并移除', () => {
  const { instance } = setup();
  const control = makePageControl(instance);
  instance.collapsePageControlToTab();
  const tab = instance.sideTab;

  instance.hidePageControl();

  assert.strictEqual(instance.pageControl, null, '控制条引用已清空');
  assert.ok(!document.body.childNodes.includes(control), '控制条节点已从 DOM 移除');
  assert.strictEqual(instance.sideTab, null, '挂耳引用已清空');
  assert.ok(!document.body.childNodes.includes(tab), '挂耳节点已从 DOM 移除');
});

// ===== Q2：动态增量翻译只扫新增子树（不再全页重扫） =====

test('Q2 _onMutations：收集非自有 UI 的新增根，自有 UI 节点直接忽略', () => {
  const { instance } = setup();
  instance.pageTranslationState.isTranslated = true;

  const realRoot = new FakeElement('div');
  const ownUI = new FakeElement('div');
  ownUI.closest = (sel) => (sel === '[class*="yuxtrans-"]' ? ownUI : null); // 模拟位于 .yuxtrans-* 内

  instance._onMutations([{ addedNodes: [ownUI] }]);
  assert.strictEqual(instance._pendingAddedRoots.size, 0, '自有 UI 新增不进入待扫集合');
  assert.strictEqual(instance._addedDebounceTimer, null, '自有 UI 新增不启动防抖');

  instance._onMutations([{ addedNodes: [realRoot] }]);
  assert.ok(instance._pendingAddedRoots.has(realRoot), '真实新增根进入待扫集合');
  assert.ok(instance._addedDebounceTimer, '真实新增启动防抖');
  clearTimeout(instance._addedDebounceTimer);
  instance._addedDebounceTimer = null;
  instance._pendingAddedRoots.clear();
});

test('Q2 _processAddedNodes：只扫描新增子树根，嵌套根去重、断连根跳过', async () => {
  const { instance } = setup();
  instance.pageTranslationState.isTranslated = true;
  instance.translateBatchParallel = async () => {}; // 本用例不断言翻译链路

  const outer = new FakeElement('div');
  outer.isConnected = true;
  const inner = new FakeElement('p');
  inner.isConnected = true;
  outer.appendChild(inner);
  const detached = new FakeElement('div');
  detached.isConnected = false;

  instance._pendingAddedRoots.add(outer);
  instance._pendingAddedRoots.add(inner);     // 被 outer 包含，应去重
  instance._pendingAddedRoots.add(detached);  // 已断连，应跳过

  const scanned = [];
  instance.collectTextNodes = (root) => { scanned.push(root); return []; };

  await instance._processAddedNodes();

  assert.deepStrictEqual(scanned, [outer], '仅扫描最外层有效新增根');
  assert.strictEqual(instance._pendingAddedRoots.size, 0, '待扫集合已排空');
  assert.strictEqual(instance._dynamicTranslating, false, '增量在途标志已复位');
});

test('Q2 _processAddedNodes：新增子树中的未翻译文本照常提交翻译', async () => {
  const { instance } = setup();
  instance.pageTranslationState.isTranslated = true;

  const root = new FakeElement('div');
  root.isConnected = true;
  instance._pendingAddedRoots.add(root);
  const nodes = [makeNodeInfo('Dynamically added paragraph text.')];
  instance.collectTextNodes = (r) => (r === root ? nodes : []);

  const batches = [];
  instance.translateBatchParallel = async (items) => { batches.push(items); };
  instance.applyTranslation = () => {};

  await instance._processAddedNodes();

  assert.strictEqual(batches.length, 1, '提交一次批量翻译');
  assert.strictEqual(batches[0][0].text, 'Dynamically added paragraph text.');
});

// ===== v2.1 段落对照（bilingualStyle=block） =====
// 利用 setup() 实例 + 带块容器 closest 的 FakeElement 直接驱动整页链路，
// 验证：块尾聚合、同块增量更新、行内回退、三态切换、恢复原文无残留、流式直入 block-tr。

/**
 * 构造父元素为 p（closest 命中块容器选择器）的文本节点翻译项
 */
function makeBlockNodeInfo(text) {
  const parent = new FakeElement('p');
  // 模拟真实 DOM：closest 从元素自身起向上匹配，p 命中选择器列表中的 p
  parent.closest = (sel) => (sel.includes('p') ? parent : null);
  const node = {
    nodeType: 3,
    parentElement: parent,
    parentNode: parent,
    textContent: text,
    nextSibling: null
  };
  parent.childNodes.push(node);
  return { text, node, isInViewport: true };
}

/** 在块容器下查找段落对照译文块 */
function findBlockTr(blockEl) {
  return blockEl.childNodes.find(
    (c) => c instanceof FakeElement && c.className === 'yuxtrans-block-tr'
  );
}

function blockTrBody(blockEl) {
  const div = findBlockTr(blockEl);
  if (!div) return null;
  return div.childNodes.find((c) => c.className === 'yuxtrans-block-tr-body') || null;
}

test('段落对照：block 模式译文聚合为块尾 block-tr，不插行内 span', async () => {
  const { instance, mock } = setup({ enableStreaming: false, bilingualStyle: 'block' });
  const nodes = [makeBlockNodeInfo('First block paragraph.'), makeBlockNodeInfo('Second block paragraph.')];
  instance.collectTextNodes = () => nodes;
  mock.handlers.translateBatch = (msg) => ({
    success: true,
    results: msg.texts.map((t) => ({ success: true, text: '块译:' + t, cached: false }))
  });

  await instance.translatePage();

  for (const ni of nodes) {
    const parent = ni.node.parentElement;
    const body = blockTrBody(parent);
    assert.ok(body, '块容器末尾应有 block-tr 且含 body');
    assert.strictEqual(body.textContent, '块译:' + ni.text);
    assert.ok(!findBilingualSpan(ni), 'block 模式不应插行内 span.yuxtrans-bilingual-text');
    assert.ok(parent.classList.contains('yuxtrans-translated-bilingual'));
    assert.ok(parent.classList.contains('yuxtrans-translated-block'));
    assert.strictEqual(ni.node.textContent, ni.text, '原文文本节点保持不动');
  }
  assert.strictEqual(instance.pageTranslationState.isTranslated, true);
});

test('段落对照：同块多文本节点译文按顺序空格拼接并增量更新', async () => {
  const { instance } = setup();
  await new Promise((r) => setTimeout(r, 20)); // 等 loadConfig 落地后覆盖配置
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'block';

  const parent = new FakeElement('p');
  parent.closest = (sel) => (sel.includes('p') ? parent : null);
  const mkNode = (text) => {
    const node = { nodeType: 3, parentElement: parent, parentNode: parent, textContent: text, nextSibling: null };
    parent.childNodes.push(node);
    return { text, node, isInViewport: true };
  };
  const n1 = mkNode('Sentence one.');
  const n2 = mkNode('Sentence two.');

  instance.applyTranslation(n1, '译文一');
  assert.strictEqual(blockTrBody(parent).textContent, '译文一', '首个节点落地即创建 block-tr');

  instance.applyTranslation(n2, '译文二');
  assert.strictEqual(blockTrBody(parent).textContent, '译文一 译文二', '同块译文按顺序空格拼接');
  assert.strictEqual(
    parent.childNodes.filter((c) => c.className === 'yuxtrans-block-tr').length,
    1,
    '同块只维护一个 block-tr 元素'
  );
});

test('段落对照：找不到块容器时回退行内注脚模式', async () => {
  const { instance } = setup();
  await new Promise((r) => setTimeout(r, 20));
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'block';

  // makeNodeInfo 的 FakeElement.closest 默认返回 null（无块容器）
  const ni = makeNodeInfo('Inline fallback paragraph.');
  instance.applyTranslation(ni, '行内译文');

  const span = findBilingualSpan(ni);
  assert.ok(span, '无块容器应回退行内 span');
  assert.strictEqual(span.textContent, '行内译文');
  assert.strictEqual(findBlockTr(ni.node.parentElement), undefined, '不应创建 block-tr');
});

test('段落对照：仅译文/段落双语/恢复原文三态切换行为正确', async () => {
  const { instance } = setup();
  await new Promise((r) => setTimeout(r, 20));
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'block';
  // 测试 mock 的 FakeElement.style 无 removeProperty，关闭样式保持绕过（与实现无关）
  instance.config.preserveStyles = false;

  const ni = makeBlockNodeInfo('Original paragraph text.');
  instance.applyTranslation(ni, '段落译文');
  const parent = ni.node.parentElement;
  assert.ok(blockTrBody(parent), '初始为段落对照');

  // 段落对照 → 仅译文
  instance.applyBilingualRender(false);
  assert.strictEqual(findBlockTr(parent), undefined, '切仅译文后 block-tr 移除');
  assert.strictEqual(ni.node.textContent, '段落译文', '仅译文模式文本节点为译文');
  assert.ok(parent.classList.contains('yuxtrans-translated'));
  assert.ok(!parent.classList.contains('yuxtrans-translated-block'));
  assert.strictEqual(instance._blockTrMap.size, 0, '块映射应清空');

  // 仅译文 → 段落对照
  instance.applyBilingualRender(true);
  assert.ok(blockTrBody(parent), '切回段落对照后 block-tr 重建');
  assert.strictEqual(blockTrBody(parent).textContent, '段落译文');
  assert.strictEqual(ni.node.textContent, 'Original paragraph text.', '原文恢复显示');

  // 恢复原文：DOM 干净无残留
  instance.restoreOriginalTexts();
  assert.strictEqual(findBlockTr(parent), undefined, '恢复原文后无 block-tr 残留');
  assert.strictEqual(ni.node.textContent, 'Original paragraph text.');
  assert.ok(!parent.classList.contains('yuxtrans-translated-bilingual'));
  assert.ok(!parent.classList.contains('yuxtrans-translated-block'));
  assert.strictEqual(instance._blockTrMap.size, 0);
});

test('段落对照：行内双语 → 段落对照 → 行内双语双向迁移', async () => {
  const { instance } = setup();
  await new Promise((r) => setTimeout(r, 20));
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'inline';

  const ni = makeBlockNodeInfo('Migrate paragraph text.');
  instance.applyTranslation(ni, '迁移译文');
  const parent = ni.node.parentElement;
  assert.ok(findBilingualSpan(ni), '初始为行内注脚');

  // 行内 → 块（模拟用户在 options 改 bilingualStyle 后重渲染）
  instance.config.bilingualStyle = 'block';
  instance.applyBilingualRender(true);
  assert.ok(!findBilingualSpan(ni), '行内 span 应移除');
  assert.ok(blockTrBody(parent), 'block-tr 应创建');
  assert.strictEqual(blockTrBody(parent).textContent, '迁移译文');

  // 块 → 行内
  instance.config.bilingualStyle = 'inline';
  instance.applyBilingualRender(true);
  assert.strictEqual(findBlockTr(parent), undefined, 'block-tr 应移除');
  const span = findBilingualSpan(ni);
  assert.ok(span, '行内 span 应重建');
  assert.strictEqual(span.textContent, '迁移译文');
  assert.strictEqual(ni.node.textContent, 'Migrate paragraph text.');
});

test('段落对照：流式期间译文直入 block-tr，完成后聚合落地', async () => {
  const { instance, mock } = setup({ enableStreaming: true, bilingualStyle: 'block' });
  const nodes = [makeBlockNodeInfo('Streaming block paragraph.')];
  instance.collectTextNodes = () => nodes;

  const streamSnapshots = [];
  mock.handlers.translateStream = (msg) => {
    mock.emitToContent({ action: 'streamChunk', chunk: '半', fullText: '半', requestId: msg.requestId });
    const st = instance.pageTranslationState.streamingNodes.get(msg.requestId);
    const parent = msg.text ? nodes[0].node.parentElement : null;
    streamSnapshots.push({
      inBlockTr: !!(st && st.tempSpan.parentElement && st.tempSpan.parentElement.className === 'yuxtrans-block-tr'),
      tempText: st ? st.tempSpan.textContent : null,
      blockTrExists: !!(parent && findBlockTr(parent))
    });
    return { success: true, text: '流式块译文', cached: false, engine: 'qwen' };
  };

  await instance.translatePage();

  assert.strictEqual(streamSnapshots.length, 1);
  assert.ok(streamSnapshots[0].inBlockTr, '流式临时 span 应挂在 block-tr 内');
  assert.strictEqual(streamSnapshots[0].tempText, '半', 'chunk 实时刷新临时 span');

  const parent = nodes[0].node.parentElement;
  const body = blockTrBody(parent);
  assert.ok(body, '完成后 block-tr 保留');
  assert.strictEqual(body.textContent, '流式块译文', '最终译文聚合到 body');
  assert.ok(
    !parent.childNodes.some((c) => c.className === 'yuxtrans-streaming-text') &&
    !findBlockTr(parent).childNodes.some((c) => c.className === 'yuxtrans-streaming-text'),
    '临时流式 span 应被清理'
  );
});

test('段落对照：流式失败清理空 block-tr，不残留空壳', async () => {
  const { instance, mock } = setup({ enableStreaming: true, bilingualStyle: 'block' });
  const nodes = [makeBlockNodeInfo('Failing block paragraph.')];
  instance.collectTextNodes = () => nodes;
  mock.handlers.translateStream = () => ({ success: false, error: '服务暂时不可用' });

  await instance.translatePage();

  const parent = nodes[0].node.parentElement;
  assert.strictEqual(findBlockTr(parent), undefined, '流式失败后空 block-tr 应被清理');
  assert.ok(!parent.classList.contains('yuxtrans-translated-block'));
  assert.strictEqual(instance._blockTrMap.size, 0);
});
