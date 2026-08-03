/**
 * options 页 XSS 回归测试（代号 S2）
 * 1) 单测 lib/product-helpers.js 的 escapeHtml（options.js 拼接 innerHTML 的唯一转义来源）
 * 2) 源码级断言：options.js 中已知危险拼接点必须走 escapeHtml，防止后续改动退化为裸插值
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('../lib/product-helpers.js');

test('escapeHtml 转义 <img onerror> 载荷', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const out = H.escapeHtml(payload);
  assert.ok(!out.includes('<img'), '不得保留可解析的 <img 标签');
  assert.strictEqual(out, '&lt;img src=x onerror=alert(1)&gt;');
});

test('escapeHtml 转义 <script> 载荷', () => {
  const payload = '<script>alert(document.cookie)</script>';
  const out = H.escapeHtml(payload);
  assert.ok(!out.includes('<script>'), '不得保留可解析的 <script> 标签');
});

test('escapeHtml 转义引号防属性逃逸', () => {
  // 档案 id 会拼入 value="..."，需防双引号逃逸注入事件属性
  const payload = 'x" onmouseover="alert(1)';
  const out = H.escapeHtml(payload);
  assert.ok(!out.includes('"'), '双引号必须被转义');
  assert.strictEqual(out, 'x&quot; onmouseover=&quot;alert(1)');
  assert.strictEqual(H.escapeHtml("a'b"), 'a&#39;b');
  assert.strictEqual(H.escapeHtml('a&b'), 'a&amp;b');
});

test('escapeHtml 容忍 null / undefined / 非字符串', () => {
  assert.strictEqual(H.escapeHtml(null), '');
  assert.strictEqual(H.escapeHtml(undefined), '');
  assert.strictEqual(H.escapeHtml(42), '42');
});

// ===== 源码级回归：options.js 危险拼接点不得出现裸插值 =====
const optionsSrc = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');

test('options.js：档案列表 renderModelList 必须转义 label / provider / model', () => {
  assert.ok(!optionsSrc.includes('<div class="model-list-name">${m.label'), 'model-list-name 存在裸插值');
  assert.ok(!optionsSrc.includes('${providerLabel} · ${modelLabel}</div>'), 'model-list-detail 存在裸插值');
  assert.ok(optionsSrc.includes('${escapeHtml(m.label || m.id)}'), 'model-list-name 应使用 escapeHtml');
});

test('options.js：对照档案下拉必须转义档案 id / 供应商名 / 模型名', () => {
  assert.ok(!optionsSrc.includes('<option value="${p.id}"'), 'option value 存在裸插值 p.id');
  assert.ok(optionsSrc.includes('<option value="${escapeHtml(p.id)}"'), 'option value 应使用 escapeHtml');
});

test('options.js：诊断/日志区供应商与错误字段必须转义', () => {
  assert.ok(!optionsSrc.includes('${actionLabel} · ${providerLabel}</span>'), '失败记录区存在裸插值');
  assert.ok(!optionsSrc.includes("' · ' + log.model"), '请求日志 header 存在裸插值 log.model');
  assert.ok(optionsSrc.includes('${escapeHtml(m.errorType || \'unknown\')}'), 'errorType 应使用 escapeHtml');
});

test('options.js：escapeHtml 委托 lib 单一来源，不留本地重复实现', () => {
  assert.ok(optionsSrc.includes('Helpers.escapeHtml(str)'), 'options.js 应委托 product-helpers 的 escapeHtml');
});
