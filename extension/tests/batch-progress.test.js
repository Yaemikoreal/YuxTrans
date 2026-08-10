/**
 * Content Script 整页批量增量下发（translateBatchProgress）单元测试
 * 覆盖：增量结果按 index 落地、sessionId 不符丢弃、增量 + 最终响应幂等（完成计数不翻倍）
 * 使用 Node 内置 test runner + 最小化 DOM/chrome mock（与 content.test.js 同套 harness）
 */

const { test } = require('node:test');
const assert = require('node:assert');

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

function findBilingualSpan(nodeInfo) {
  return nodeInfo.node.parentElement.childNodes.find(
    (c) => c instanceof FakeElement && c.className === 'yuxtrans-bilingual-text'
  );
}

/**
 * 创建测试环境：注入 chrome mock，实例化内容脚本并打桩控制条方法
 */
function setup() {
  const handlers = {};
  let messageListener = null;
  handlers.getConfig = () => ({ provider: 'qwen' });

  global.chrome = {
    runtime: {
      id: 'yuxtrans-test',
      onMessage: { addListener: (fn) => { messageListener = fn; } },
      sendMessage: (msg, cb) => {
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
  // 云端非流式批量路径前置状态
  instance.config = { provider: 'qwen', concurrency: 4, sourceLang: 'auto', targetLang: 'zh' };
  instance._pageSessionId = 'sess-A';
  instance.pageTranslationState.isTranslating = true;

  const mock = {
    handlers,
    // 模拟 SW → content 的推送消息（translateBatchProgress 等）
    emitToContent: (msg) => messageListener && messageListener(msg, {}, () => {})
  };
  return { instance, mock };
}

test('增量下发：子批次进度按 index 落地，最终响应幂等不计数翻倍', async () => {
  const { instance, mock } = setup();
  const items = ['P0', 'P1', 'P2'].map((t) => ({ text: t, nodeInfo: makeNodeInfo(t) }));

  // 模拟 SW：translateBatch 请求发出后，先推两波增量进度（index 0 与 2），再回完整最终响应
  mock.handlers.translateBatch = () => {
    mock.emitToContent({
      action: 'translateBatchProgress',
      sessionId: 'sess-A',
      results: [{ index: 0, text: '译文0', cached: false, success: true }]
    });
    mock.emitToContent({
      action: 'translateBatchProgress',
      sessionId: 'sess-A',
      results: [{ index: 2, text: '译文2', cached: false, success: true }]
    });
    return {
      success: true,
      results: [
        { text: '译文0', cached: false, success: true },
        { text: '译文1', cached: false, success: true },
        { text: '译文2', cached: false, success: true }
      ]
    };
  };

  // 与 translatePage 的 onBatchResult 一致：成功即 applyTranslation + 统计
  const applyCounts = [0, 0, 0];
  const onBatchResult = (indices, nodes, results) => {
    results.forEach((res, i) => {
      if (res && res.success) {
        applyCounts[indices[i]]++;
        instance.applyTranslation(nodes[i].nodeInfo, res.text);
      }
    });
  };
  let lastProgress = null;
  const onProgress = (completed, total) => { lastProgress = { completed, total }; };

  const results = await instance.translateBatchParallel(items, onProgress, onBatchResult, {});

  // 每条目的落地回调恰好一次（增量 0/2 + 最终响应补齐 1，不重复）
  assert.deepStrictEqual(applyCounts, [1, 1, 1], '每条目的完成计数只能 +1');
  // 完成数恰好等于条目总数，不因增量 + 最终响应重复计数而超过
  assert.deepStrictEqual(lastProgress, { completed: 3, total: 3 });
  // 三条译文均落地为双语 span
  items.forEach((item, i) => {
    const span = findBilingualSpan(item.nodeInfo);
    assert.ok(span, `第 ${i} 条译文 span 应已插入`);
    assert.strictEqual(span.textContent, '译文' + i);
  });
  assert.ok(results.every((r) => r && r.success));
  // 请求结束后增量登记已清理
  assert.strictEqual(instance._batchProgressHandlers.length, 0, 'finally 应清理增量登记');
});

test('增量下发：sessionId 不符的进度消息整条丢弃', async () => {
  const { instance, mock } = setup();
  const items = ['Q0', 'Q1'].map((t) => ({ text: t, nodeInfo: makeNodeInfo(t) }));

  mock.handlers.translateBatch = () => {
    // 其他会话的进度：应被 content 监听器路由后丢弃
    mock.emitToContent({
      action: 'translateBatchProgress',
      sessionId: 'sess-OTHER',
      results: [{ index: 0, text: '错误译文', cached: false, success: true }]
    });
    return {
      success: true,
      results: [
        { text: '译文0', cached: false, success: true },
        { text: '译文1', cached: false, success: true }
      ]
    };
  };

  const applyCounts = [0, 0];
  const onBatchResult = (indices, nodes, results) => {
    results.forEach((res, i) => {
      if (res && res.success) {
        applyCounts[indices[i]]++;
        instance.applyTranslation(nodes[i].nodeInfo, res.text);
      }
    });
  };
  let lastProgress = null;
  const onProgress = (completed, total) => { lastProgress = { completed, total }; };

  await instance.translateBatchParallel(items, onProgress, onBatchResult, {});

  // 异会话进度未落地：index 0 只被最终响应应用一次，且译文来自最终响应
  assert.deepStrictEqual(applyCounts, [1, 1]);
  assert.deepStrictEqual(lastProgress, { completed: 2, total: 2 });
  assert.strictEqual(findBilingualSpan(items[0].nodeInfo).textContent, '译文0');

  // 直接调用入口：sessionId 为 null / 不符时均不触发任何登记处理器
  assert.doesNotThrow(() => instance.handleBatchProgress(null, [{ index: 0, success: true }]));
  assert.doesNotThrow(() => instance.handleBatchProgress('sess-OTHER', [{ index: 0, success: true }]));
});

test('增量下发：空译文不计成功，最终响应按失败归一化落地', async () => {
  const { instance, mock } = setup();
  const items = ['E0', 'E1'].map((t) => ({ text: t, nodeInfo: makeNodeInfo(t) }));
  const applyCounts = [0, 0];
  const onBatchResult = (indices, nodes, results) => {
    results.forEach((res, i) => {
      if (res && res.success) {
        applyCounts[indices[i]]++;
        instance.applyTranslation(nodes[i].nodeInfo, res.text);
      }
    });
  };
  mock.handlers.translateBatch = () => ({
    success: true,
    results: [
      { text: '', success: true, cached: false },
      { text: '   ', success: true, cached: false }
    ]
  });
  let lastProgress = null;
  const onProgress = (completed, total) => { lastProgress = { completed, total }; };

  const results = await instance.translateBatchParallel(items, onProgress, onBatchResult, {});

  assert.deepStrictEqual(applyCounts, [0, 0], '空译文不应触发渲染');
  assert.strictEqual(findBilingualSpan(items[0].nodeInfo), undefined);
  assert.strictEqual(findBilingualSpan(items[1].nodeInfo), undefined);
  assert.ok(!results[0].success && !results[1].success, '空译文应标记失败');
  assert.deepStrictEqual(lastProgress, { completed: 2, total: 2 }, '完成计数仍推进');
});

test('会话轮换：旧会话最终响应不落地，不污染新会话', async () => {
  const { instance, mock } = setup();
  const items = ['S0', 'S1'].map((t) => ({ text: t, nodeInfo: makeNodeInfo(t) }));
  const applyCounts = [0, 0];
  const onBatchResult = (indices, nodes, results) => {
    results.forEach((res, i) => {
      if (res && res.success) {
        applyCounts[indices[i]]++;
        instance.applyTranslation(nodes[i].nodeInfo, res.text);
      }
    });
  };
  mock.handlers.translateBatch = () => {
    // 请求发出后、最终响应前，主流程轮换了会话 id（动态翻译 → 新整页会话）
    instance._pageSessionId = 'sess-B';
    return {
      success: true,
      results: [
        { text: '译文0', cached: false, success: true },
        { text: '译文1', cached: false, success: true }
      ]
    };
  };
  let lastProgress = null;
  const onProgress = (completed, total) => { lastProgress = { completed, total }; };

  const results = await instance.translateBatchParallel(items, onProgress, onBatchResult, {});

  assert.deepStrictEqual(applyCounts, [0, 0], '旧会话结果不应渲染');
  assert.strictEqual(findBilingualSpan(items[0].nodeInfo), undefined);
  assert.strictEqual(findBilingualSpan(items[1].nodeInfo), undefined);
  assert.strictEqual(results[0], undefined, '旧会话条目不写成功');
  assert.strictEqual(results[1], undefined, '旧会话条目不写成功');
  assert.deepStrictEqual(lastProgress, { completed: 2, total: 2 }, '完成计数由 finally 补齐');
});

test('取消竞速：成功响应在取消后到达时不重新渲染', async () => {
  const { instance, mock } = setup();
  const items = ['C0', 'C1'].map((t) => ({ text: t, nodeInfo: makeNodeInfo(t) }));
  const onBatchResult = (indices, nodes, results) => {
    results.forEach((res, i) => {
      if (res && res.success) instance.applyTranslation(nodes[i].nodeInfo, res.text);
    });
  };
  mock.handlers.translateBatch = () => {
    // 先推送增量（index 0 落地），随后用户在最终响应到达前取消任务
    mock.emitToContent({
      action: 'translateBatchProgress',
      sessionId: 'sess-A',
      results: [{ index: 0, text: '译文0', cached: false, success: true }]
    });
    instance.pageTranslationState.cancelRequested = true;
    instance.pageTranslationState.isTranslating = false;
    return {
      success: true,
      results: [
        { text: '译文0', cached: false, success: true },
        { text: '译文1', cached: false, success: true }
      ]
    };
  };
  let lastProgress = null;
  const onProgress = (completed, total) => { lastProgress = { completed, total }; };

  const results = await instance.translateBatchParallel(items, onProgress, onBatchResult, {});

  assert.ok(findBilingualSpan(items[0].nodeInfo), '取消前已落地的增量保留');
  assert.strictEqual(findBilingualSpan(items[1].nodeInfo), undefined, '取消后响应不重新渲染');
  assert.ok(results[0] && results[0].success);
  assert.strictEqual(results[1], undefined, '取消后未落地条目保持未完成');
  assert.deepStrictEqual(lastProgress, { completed: 2, total: 2 }, '完成计数由 finally 补齐');
});

test('云端批量失败降级：多条目批次拆为单条补全，成功条目不重复请求', async () => {
  const { instance, mock } = setup();
  const items = ['F0', 'F1'].map((t) => ({ text: t, nodeInfo: makeNodeInfo(t) }));
  const batchCalls = [];
  mock.handlers.translateBatch = (msg) => {
    batchCalls.push(msg.texts.slice());
    if (msg.texts.length > 1) return { success: false, error: '模拟批量失败' };
    return {
      success: true,
      results: [{ text: '译文' + msg.texts[0], success: true, cached: false }]
    };
  };
  const onBatchResult = (indices, nodes, results) => {
    results.forEach((res, i) => {
      if (res && res.success) instance.applyTranslation(nodes[i].nodeInfo, res.text);
    });
  };
  let lastProgress = null;
  const onProgress = (completed, total) => { lastProgress = { completed, total }; };

  const results = await instance.translateBatchParallel(items, onProgress, onBatchResult, {});

  assert.strictEqual(batchCalls.length, 3, '1 次整批失败 + 2 次单条补全');
  assert.deepStrictEqual(batchCalls[0], ['F0', 'F1']);
  const singles = batchCalls.slice(1).map((texts) => texts[0]).sort();
  assert.deepStrictEqual(singles, ['F0', 'F1']);
  assert.ok(results[0] && results[0].success, '拆单补全后条目 0 成功');
  assert.ok(results[1] && results[1].success, '拆单补全后条目 1 成功');
  assert.strictEqual(results[0].translated, '译文F0');
  assert.strictEqual(results[1].translated, '译文F1');
  assert.deepStrictEqual(lastProgress, { completed: 2, total: 2 }, '完成计数不翻倍');
});
