/**
 * 整页翻译「段落粒度」单元测试（W1/W2/W4/W5）
 * 使用 Node 内置 test runner + 最小化 DOM/chrome mock（与 content.test.js 同款）。
 * 覆盖：块聚合分组、nodeSpans 偏移、切句白名单边界、超长段句级拆分、
 * 三种回写模式（block/inline/replace）、句级回写、restore 恢复原文。
 */

const { test } = require('node:test');
const assert = require('node:assert');

// 提供与运行时一致的 helpers（manifest 中 product-helpers.js 先于 content.js 加载）
global.YuxTransHelpers = require('../lib/product-helpers.js');

// ===== 最小化 DOM mock（与 content.test.js 同款） =====

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建测试实例（chrome mock + 打桩控制条/指标上报，核心翻译链路保持真实逻辑）
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
    enableStreaming: false,
    bilingualMode: true,
    profiles: [],
    activeProfileId: ''
  }, configOverrides);

  const sent = [];
  const handlers = {};
  handlers.getConfig = () => configResponse;

  global.chrome = {
    runtime: {
      id: 'yuxtrans-test',
      onMessage: { addListener: () => {} },
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
  return { instance, sent, handlers };
}

/** 创建文本节点并挂到父元素下 */
function makeTextNode(parent, text) {
  const node = {
    nodeType: 3,
    parentElement: parent,
    parentNode: parent,
    textContent: text,
    nextSibling: null
  };
  parent.childNodes.push(node);
  return node;
}

/**
 * 构造一个块容器 p（子元素 closest 命中 p），内含若干「内联父元素 + 文本节点」，
 * 并走真实 _groupNodesIntoParagraphs 聚合为段落对象。
 * pieces: string[] —— 每段文本一个内联元素（模拟被 <a>/<b> 切碎的句子）
 */
function makeParagraph(instance, pieces, { blocked = true, isInViewport = true } = {}) {
  const p = new FakeElement('p');
  const infos = [];
  pieces.forEach((text, i) => {
    const inline = new FakeElement(i % 2 === 0 ? 'span' : 'b');
    p.appendChild(inline);
    if (blocked) inline.closest = () => p;
    const node = makeTextNode(inline, text);
    infos.push({
      node,
      text: text.trim(),
      isInViewport,
      rect: { top: i * 10, bottom: i * 10 + 5 }
    });
  });
  const paragraphs = instance._groupNodesIntoParagraphs(infos);
  return { p, infos, paragraph: paragraphs[0] };
}

/** 在元素下查找双语译文 span */
function findBilingualSpans(el) {
  return el.childNodes.filter(
    (c) => c instanceof FakeElement && c.className === 'yuxtrans-bilingual-text'
  );
}

/** 在块容器下查找段落对照译文块 body */
function blockTrBody(blockEl) {
  const div = blockEl.childNodes.find(
    (c) => c instanceof FakeElement && c.className === 'yuxtrans-block-tr'
  );
  if (!div) return null;
  return div.childNodes.find((c) => c.className === 'yuxtrans-block-tr-body') || null;
}

// ===== W1：块聚合分组与 nodeSpans 偏移 =====

test('W1 块聚合：同块内多文本节点聚合为一个段落，nodeSpans 偏移正确', async () => {
  const { instance } = setup();
  await sleep(20);

  const { p, paragraph } = makeParagraph(instance, ['Hello', 'brave', 'world']);
  assert.ok(paragraph, '应聚合出一个段落');
  assert.strictEqual(paragraph.text, 'Hello brave world', '组内节点按 DOM 序单空格拼接');
  assert.strictEqual(paragraph.nodes.length, 3);
  assert.strictEqual(paragraph.blockEl, p, 'blockEl 为块容器');
  assert.strictEqual(paragraph.node, paragraph.nodes[0], 'node 别名为段首节点');
  // 偏移：'Hello'[0,5) 'brave'[6,11) 'world'[12,17)
  assert.deepStrictEqual(
    paragraph.nodeSpans.map((s) => [s.start, s.end]),
    [[0, 5], [6, 11], [12, 17]]
  );
  assert.strictEqual(paragraph.isInViewport, true);
});

test('W1 块聚合：不同块容器分组为不同段落；任一节点可视即段可视', async () => {
  const { instance } = setup();
  await sleep(20);

  // 两个块容器，各自两个文本节点；第二块所有节点不可视
  const { infos: infos1 } = makeParagraph(instance, ['First', 'block']);
  const { infos: infos2 } = makeParagraph(instance, ['Second', 'block'], { isInViewport: false });
  const paragraphs = instance._groupNodesIntoParagraphs([...infos1, ...infos2]);

  assert.strictEqual(paragraphs.length, 2, '两个块容器应分为两个段落');
  assert.strictEqual(paragraphs[0].text, 'First block');
  assert.strictEqual(paragraphs[1].text, 'Second block');
  assert.strictEqual(paragraphs[0].isInViewport, true);
  assert.strictEqual(paragraphs[1].isInViewport, false, '块内全部节点不可视则段不可视');

  // 无块容器时回退按父元素分组
  const lone = new FakeElement('div');
  const loneNode = makeTextNode(lone, 'lone text');
  const res = instance._groupNodesIntoParagraphs([
    { node: loneNode, text: 'lone text', isInViewport: true, rect: { top: 0, bottom: 1 } }
  ]);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].blockEl, null, '无块容器时 blockEl 为 null');
});

// ===== W4：切句白名单边界 =====

test('W4 切句：英文缩写 / 小数点 / 省略号白名单防护', async () => {
  const { instance } = setup();

  // 常规切句
  let ss = instance._splitSentences('Dr. Smith went home. He slept.', []);
  assert.deepStrictEqual(ss.map((s) => s.text), ['Dr. Smith went home.', 'He slept.']);

  // 多个缩写连用
  ss = instance._splitSentences('Mr. and Mrs. Smith arrived. They stayed.', []);
  assert.deepStrictEqual(ss.map((s) => s.text), ['Mr. and Mrs. Smith arrived.', 'They stayed.']);

  // e.g. 缩写 + 后句
  ss = instance._splitSentences('Use tools, e.g. hammers. They work.', []);
  assert.deepStrictEqual(ss.map((s) => s.text), ['Use tools, e.g. hammers.', 'They work.']);

  // 小数点不切
  ss = instance._splitSentences('The price is 3.14 dollars today.', []);
  assert.strictEqual(ss.length, 1);
  assert.strictEqual(ss[0].text, 'The price is 3.14 dollars today.');

  // 省略号（...）内部不切
  ss = instance._splitSentences('Wait... what happened?', []);
  assert.strictEqual(ss.length, 1);
  assert.strictEqual(ss[0].text, 'Wait... what happened?');

  // CJK 省略号（……）不切，句末。切
  ss = instance._splitSentences('等等……还有吗。没有了。', []);
  assert.deepStrictEqual(ss.map((s) => s.text), ['等等……还有吗。', '没有了。']);
});

test('W4 切句：引号/右括号归属前句；CJK 无空白也成句；无标点整段一句', async () => {
  const { instance } = setup();

  // 句末标点后引号归属前句
  let ss = instance._splitSentences('He said "Hello." Then left.', []);
  assert.deepStrictEqual(ss.map((s) => s.text), ['He said "Hello."', 'Then left.']);

  // CJK 句后无空白直接成句
  ss = instance._splitSentences('第一句。第二句！第三句？', []);
  assert.deepStrictEqual(ss.map((s) => s.text), ['第一句。', '第二句！', '第三句？']);

  // 无句末标点：整段一句
  ss = instance._splitSentences('Just a fragment without punctuation', []);
  assert.strictEqual(ss.length, 1);
  assert.strictEqual(ss[0].text, 'Just a fragment without punctuation');
});

test('W4 切句：nodeSpans 映射记录句覆盖的节点与节点内偏移', async () => {
  const { instance } = setup();

  const n1 = { nodeType: 3, textContent: 'One.' };
  const n2 = { nodeType: 3, textContent: 'Two.' };
  // 段落文本 'One. Two.'：n1 [0,4)，拼接空格 [4,5)，n2 [5,9)
  const spans = [
    { node: n1, start: 0, end: 4 },
    { node: n2, start: 5, end: 9 }
  ];
  const ss = instance._splitSentences('One. Two.', spans);
  assert.strictEqual(ss.length, 2);
  assert.strictEqual(ss[0].text, 'One.');
  assert.deepStrictEqual(
    ss[0].nodeSpans.map((s) => [s.node, s.start, s.end]),
    [[n1, 0, 4]]
  );
  assert.strictEqual(ss[1].text, 'Two.');
  assert.deepStrictEqual(
    ss[1].nodeSpans.map((s) => [s.node, s.start, s.end]),
    [[n2, 0, 4]]
  );

  // 跨节点句：'Hello brave world.'（n3 'Hello brave' + n4 'world.'）
  const n3 = { nodeType: 3, textContent: 'Hello brave' };
  const n4 = { nodeType: 3, textContent: 'world.' };
  const ss2 = instance._splitSentences('Hello brave world.', [
    { node: n3, start: 0, end: 11 },
    { node: n4, start: 12, end: 18 }
  ]);
  assert.strictEqual(ss2.length, 1);
  assert.deepStrictEqual(
    ss2[0].nodeSpans.map((s) => [s.node, s.start, s.end]),
    [[n3, 0, 11], [n4, 0, 6]]
  );
});

// ===== W4：超长段落句级二次拆分 =====

test('W4 超长段落：超过阈值拆为句级条目，短段落保持整段一条', async () => {
  const { instance } = setup();

  const longText = Array.from({ length: 250 }, (_, i) => 'Sentence number ' + i + ' text.').join(' ');
  const longNode = { nodeType: 3, textContent: longText };
  const longSpans = [{ node: longNode, start: 0, end: longText.length }];
  const longParagraph = {
    text: longText,
    sentences: instance._splitSentences(longText, longSpans),
    nodes: [longNode],
    node: longNode,
    nodeSpans: longSpans,
    isInViewport: true,
    blockEl: null
  };
  assert.ok(longText.length > 4000, '前置：文本超过句级阈值');
  assert.ok(longParagraph.sentences.length > 1, '前置：可切多句');

  const entries = instance._expandToEntries(longParagraph);
  assert.strictEqual(entries.length, longParagraph.sentences.length, '每句一条句级条目');
  for (const e of entries) {
    assert.strictEqual(e.nodeInfo.isSentence, true);
    assert.strictEqual(e.nodeInfo.paragraph, longParagraph, '句级条目带段落归属引用');
    assert.ok(e.nodeInfo.node, '句级条目带句首节点');
  }

  const { paragraph: shortParagraph } = makeParagraph(instance, ['Short paragraph text.']);
  const shortEntries = instance._expandToEntries(shortParagraph);
  assert.strictEqual(shortEntries.length, 1, '短段落整段一条');
  assert.strictEqual(shortEntries[0].nodeInfo, shortParagraph);
});

// ===== W5：三种回写模式（段落级） =====

test('W5 inline 行内注脚：段落译文作为一个 span 插到段末节点之后', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'inline';
  instance.config.preserveStyles = false;

  const { p, paragraph } = makeParagraph(instance, ['Hello', 'world']);
  const ok = instance.applyTranslation(paragraph, '你好世界');
  assert.strictEqual(ok, true);

  const lastInline = paragraph.nodes[2 - 1].parentElement; // 段末节点所在内联元素
  const spans = findBilingualSpans(lastInline);
  assert.strictEqual(spans.length, 1, '段末节点后插入一个译文 span');
  assert.strictEqual(spans[0].textContent, '你好世界');
  assert.ok(spans[0]._listeners && spans[0]._listeners.mouseenter, 'pair-hover 已绑定');
  assert.ok(p.classList.contains('yuxtrans-translated-bilingual'), '标记类挂在块容器上');
  // 原文节点保持不动
  assert.strictEqual(paragraph.nodes[0].textContent, 'Hello');
  assert.strictEqual(paragraph.nodes[1].textContent, 'world');
  // 防重复应用
  assert.strictEqual(instance.applyTranslation(paragraph, '重复译文'), false);
});

test('W5 block 段落对照：段落译文聚合为块尾 block-tr', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'block';
  instance.config.preserveStyles = false;

  const { p, paragraph } = makeParagraph(instance, ['Hello', 'world']);
  instance.applyTranslation(paragraph, '你好世界');

  const body = blockTrBody(p);
  assert.ok(body, '块容器末尾应有 block-tr body');
  assert.strictEqual(body.textContent, '你好世界');
  assert.strictEqual(findBilingualSpans(p).length, 0, 'block 模式不插行内 span');
  assert.ok(p.classList.contains('yuxtrans-translated-block'));
  assert.strictEqual(paragraph.nodes[0].textContent, 'Hello', '原文文本节点保持不动');
});

test('W5 replace 仅译文：译文写入段首节点、同段其余节点置空', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = false;
  instance.config.preserveStyles = false;

  const { p, paragraph } = makeParagraph(instance, ['Hello', 'brave', 'world']);
  instance.applyTranslation(paragraph, '你好勇敢的世界');

  assert.strictEqual(paragraph.nodes[0].textContent, '你好勇敢的世界', '译文写入段首节点');
  assert.strictEqual(paragraph.nodes[1].textContent, '', '同段其余节点置空');
  assert.strictEqual(paragraph.nodes[2].textContent, '');
  assert.ok(p.classList.contains('yuxtrans-translated'));
  assert.strictEqual(findBilingualSpans(p).length, 0);
});

// ===== W5：句级回写 =====

test('W5 句级 inline：逐句插 span 到句末节点后，pair-hover 下沉到句 span', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'inline';
  instance.config.preserveStyles = false;

  const { paragraph } = makeParagraph(instance, ['One.', 'Two.']);
  assert.strictEqual(paragraph.sentences.length, 2, '前置：段内两句');

  const entry1 = {
    isSentence: true, paragraph,
    sentence: paragraph.sentences[0],
    node: paragraph.sentences[0].nodeSpans[0].node,
    text: paragraph.sentences[0].text
  };
  const entry2 = {
    isSentence: true, paragraph,
    sentence: paragraph.sentences[1],
    node: paragraph.sentences[1].nodeSpans[0].node,
    text: paragraph.sentences[1].text
  };

  instance.applyTranslation(entry1, '第一句');
  const inline1 = paragraph.nodes[0].parentElement;
  const inline2 = paragraph.nodes[1].parentElement;
  let spans1 = findBilingualSpans(inline1);
  assert.strictEqual(spans1.length, 1, '首句落地即在句末节点后插 span');
  assert.strictEqual(spans1[0].textContent, '第一句');
  assert.ok(spans1[0]._listeners && spans1[0]._listeners.mouseenter, '句 span 绑定 pair-hover');

  instance.applyTranslation(entry2, '第二句');
  spans1 = findBilingualSpans(inline1);
  const spans2 = findBilingualSpans(inline2);
  assert.strictEqual(spans1.length, 1, '句级重绘幂等，不重复插 span');
  assert.strictEqual(spans2.length, 1);
  assert.strictEqual(spans2[0].textContent, '第二句');
  // 原文保持不动
  assert.strictEqual(paragraph.nodes[0].textContent, 'One.');
  assert.strictEqual(paragraph.nodes[1].textContent, 'Two.');
  // 同一句重复应用被去重
  assert.strictEqual(instance.applyTranslation(entry2, '重复'), false);
});

test('W5 句级 replace：按句写回句首节点、同句其余节点置空', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = false;
  instance.config.preserveStyles = false;

  // 第二句跨两个节点：'Two big.' 被切成 'Two' + 'big.'
  const { paragraph } = makeParagraph(instance, ['One.', 'Two', 'big.']);
  assert.strictEqual(paragraph.sentences.length, 2, '前置：段内两句');

  const mkEntry = (s) => ({
    isSentence: true, paragraph, sentence: s, node: s.nodeSpans[0].node, text: s.text
  });
  instance.applyTranslation(mkEntry(paragraph.sentences[0]), '第一句');
  instance.applyTranslation(mkEntry(paragraph.sentences[1]), '第二句');

  assert.strictEqual(paragraph.nodes[0].textContent, '第一句', '首句译文写回句首节点');
  assert.strictEqual(paragraph.nodes[1].textContent, '第二句', '跨节点句译文写回该句首节点');
  assert.strictEqual(paragraph.nodes[2].textContent, '', '同句其余节点置空');
});

test('W5 句级 block：部分句到达时聚合已译句，全部到达后完整拼接', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'block';
  instance.config.preserveStyles = false;

  const { p, paragraph } = makeParagraph(instance, ['One.', 'Two.']);
  const mkEntry = (s) => ({
    isSentence: true, paragraph, sentence: s, node: s.nodeSpans[0].node, text: s.text
  });

  instance.applyTranslation(mkEntry(paragraph.sentences[0]), '第一句');
  assert.strictEqual(blockTrBody(p).textContent, '第一句', '部分句到达即聚合已译句');

  instance.applyTranslation(mkEntry(paragraph.sentences[1]), '第二句');
  assert.strictEqual(blockTrBody(p).textContent, '第一句 第二句', '按句序空格拼接');
});

// ===== W5：恢复原文 =====

test('W5 restore：恢复段内各节点原文、移除译文 span 与标记类', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'inline';
  instance.config.preserveStyles = false;

  const { p, paragraph } = makeParagraph(instance, ['Hello', 'world']);
  instance.applyTranslation(paragraph, '你好世界');
  assert.strictEqual(findBilingualSpans(p).length, 0, 'span 插在段末内联元素内');
  const inline2 = paragraph.nodes[1].parentElement;
  assert.strictEqual(findBilingualSpans(inline2).length, 1);

  instance.restoreOriginalTexts();
  assert.strictEqual(paragraph.nodes[0].textContent, 'Hello', '段首节点恢复原文');
  assert.strictEqual(paragraph.nodes[1].textContent, 'world', '段末节点恢复原文');
  assert.strictEqual(findBilingualSpans(inline2).length, 0, '译文 span 已移除');
  assert.ok(!p.classList.contains('yuxtrans-translated-bilingual'));
  assert.strictEqual(instance.pageTranslationState.originalTexts.size, 0);
});

test('W5 restore：replace 模式恢复后原文完整、originalTexts 清空', async () => {
  const { instance } = setup();
  await sleep(20);
  instance.config.bilingualMode = false;
  instance.config.preserveStyles = false;

  const { paragraph } = makeParagraph(instance, ['Hello', 'brave', 'world']);
  instance.applyTranslation(paragraph, '译文');
  assert.strictEqual(paragraph.nodes[0].textContent, '译文');

  instance.restoreOriginalTexts();
  assert.strictEqual(paragraph.nodes[0].textContent, 'Hello');
  assert.strictEqual(paragraph.nodes[1].textContent, 'brave');
  assert.strictEqual(paragraph.nodes[2].textContent, 'world');
  assert.strictEqual(instance.pageTranslationState.originalTexts.size, 0);
});

// ===== W2：装填层收敛（端到端） =====

test('W2 整页批量：段落数组整体作为一次 translateBatch 发送（不再按 20 条硬打包）', async () => {
  const { instance, sent, handlers } = setup({ enableStreaming: false });
  // 构造 25 个段落（超过旧的 BATCH_SIZE=20），验证不再二次切包
  const paragraphs = [];
  for (let i = 0; i < 25; i++) {
    const { paragraph } = makeParagraph(instance, [`Paragraph number ${i} text.`]);
    paragraphs.push(paragraph);
  }
  instance.collectTextNodes = async () => paragraphs;
  handlers.translateBatch = (msg) => ({
    success: true,
    results: msg.texts.map((t) => ({ success: true, text: '译:' + t, cached: false }))
  });

  await instance.translatePage();

  const batchMsgs = sent.filter((s) => s.msg.action === 'translateBatch');
  assert.strictEqual(batchMsgs.length, 1, '25 个段落整体作为一次批量请求');
  assert.strictEqual(batchMsgs[0].msg.texts.length, 25);
  assert.deepStrictEqual(batchMsgs[0].msg.texts, paragraphs.map((p) => p.text));
  assert.strictEqual(instance.pageTranslationState.isTranslated, true);
  assert.strictEqual(instance.pageTranslationState.originalTexts.size, 25, '每段一条 originalTexts 记录');
});

test('W2 本地 Ollama：保持逐段单发串行', async () => {
  const { instance, sent, handlers } = setup({ enableStreaming: false, provider: 'local' });
  const paragraphs = [];
  for (let i = 0; i < 3; i++) {
    const { paragraph } = makeParagraph(instance, [`Local paragraph ${i}.`]);
    paragraphs.push(paragraph);
  }
  instance.collectTextNodes = async () => paragraphs;
  handlers.translateBatch = (msg) => ({
    success: true,
    results: msg.texts.map((t) => ({ success: true, text: '译:' + t, cached: false }))
  });

  await instance.translatePage();

  const batchMsgs = sent.filter((s) => s.msg.action === 'translateBatch');
  assert.strictEqual(batchMsgs.length, 3, '本地模型逐段单发');
  assert.ok(batchMsgs.every((s) => s.msg.texts.length === 1));
});

test('W4 端到端：超长段落拆句发送，句级译文逐句落地为行内 span', async () => {
  const { instance, sent, handlers } = setup({ enableStreaming: false });
  await sleep(20);
  instance.config.bilingualMode = true;
  instance.config.bilingualStyle = 'inline';
  // 测试 mock 的 FakeElement.style 无 removeProperty，关闭样式保持绕过（与实现无关）
  instance.config.preserveStyles = false;

  // 句子文本互不相同（相同文本会被去重优化合并）
  const longText = Array.from({ length: 250 }, (_, i) => 'Sentence number ' + i + ' text.').join(' ');
  const parent = new FakeElement('p');
  const longNode = makeTextNode(parent, longText);
  const longSpans = [{ node: longNode, start: 0, end: longText.length }];
  const paragraph = {
    text: longText,
    sentences: instance._splitSentences(longText, longSpans),
    nodes: [longNode],
    node: longNode,
    nodeSpans: longSpans,
    isInViewport: true,
    rect: { top: 0, bottom: 10 },
    blockEl: null
  };
  instance.collectTextNodes = async () => [paragraph];
  handlers.translateBatch = (msg) => ({
    success: true,
    results: msg.texts.map((t) => ({ success: true, text: '译:' + t, cached: false }))
  });

  await instance.translatePage();

  const batchMsgs = sent.filter((s) => s.msg.action === 'translateBatch');
  assert.strictEqual(batchMsgs.length, 1, '句级条目整体一次批量发送');
  assert.strictEqual(batchMsgs[0].msg.texts.length, paragraph.sentences.length, '按句发送');
  assert.strictEqual(batchMsgs[0].msg.texts[0], paragraph.sentences[0].text);

  const spans = findBilingualSpans(parent);
  assert.strictEqual(spans.length, paragraph.sentences.length, '每句一个译文 span');
  assert.strictEqual(spans[0].textContent, '译:' + paragraph.sentences[0].text);
  assert.strictEqual(instance.pageTranslationState.originalTexts.size, 1, '整段一条 originalTexts 记录');
  const data = instance.pageTranslationState.originalTexts.get(paragraph);
  assert.strictEqual(data.sentenceTranslated.size, paragraph.sentences.length, '全部句译文已缓存');

  // 恢复原文：长段单节点原文恢复
  instance.restoreOriginalTexts();
  assert.strictEqual(longNode.textContent, longText);
});
