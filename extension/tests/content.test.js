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
  addEventListener() {}
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
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

const { YuxTransContent } = require('../content.js');

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
