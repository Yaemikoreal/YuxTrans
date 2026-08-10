/**
 * 整页批量翻译：子批次并发池 + 滑动窗口按通道维护 + 子批次完成即增量下发
 * 使用 Node 内置 test runner，mock 方式参考 background-coverage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

require('./mock-chrome.js');
const bg = require('../background.js');

const BATCH_PROMPT_MARK = 'JSON array of strings'; // 批量 prompt 特征（单句 prompt 不含此句）

// 批量测试统一以 qwen 档案为当前供应商（maxBatchChars = 8000）
function useQwenProfile() {
  bg.addOrUpdateProfile({ provider: 'qwen', apiKey: 'sk-test', model: 'qwen-turbo' });
}

function makeOkResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => ''
  };
}

/**
 * 从批量请求体中解析 user prompt 与输入数组（Input 段为 prompt 末尾的 JSON 数组）
 */
function parseBatchPrompt(opts) {
  const messages = JSON.parse(opts.body).messages;
  const userPrompt = messages.map((m) => m.content).find((c) => c.includes('Input:\n'));
  const inputs = JSON.parse(userPrompt.slice(userPrompt.indexOf('Input:\n') + 'Input:\n'.length));
  return { messages, userPrompt, inputs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每个文本 4500 字符：两两相加超过 qwen 的 8000 字符上限，必然各自独立成子批次
function makeLongTexts(count, marker) {
  const texts = [];
  for (let i = 0; i < count; i++) {
    texts.push(`${marker}-T${i}-` + 'x'.repeat(4500));
  }
  return texts;
}

test('子批次并发池：峰值并发 >1 且结果按 originalIndex 正确映射', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const texts = makeLongTexts(6, 'Conc');
  let inFlight = 0;
  let peak = 0;
  try {
    global.fetch = async (url, opts) => {
      const { userPrompt, inputs } = parseBatchPrompt(opts);
      assert.ok(userPrompt.includes(BATCH_PROMPT_MARK) || JSON.parse(opts.body).messages[0].content.includes(BATCH_PROMPT_MARK));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(25);
      inFlight--;
      // 译文携带输入序号，验证乱序完成后仍按 originalIndex 写回
      return makeOkResponse(JSON.stringify(inputs.map((t) => '译:' + t.slice(0, 12))));
    };

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    assert.ok(peak > 1, `峰值并发应 >1（实际 ${peak}）`);
    assert.ok(peak <= 5, `峰值并发不应超过 BATCH_PARALLEL_LANES=5（实际 ${peak}）`);
    assert.strictEqual(results.length, texts.length);
    texts.forEach((t, i) => {
      assert.ok(results[i] && results[i].success, `第 ${i} 条应成功`);
      assert.strictEqual(results[i].text, '译:' + t.slice(0, 12), `第 ${i} 条应按 originalIndex 映射`);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('子批次并发池：滑动窗口共享最近完成子批次，不串全局一条链', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const texts = makeLongTexts(6, 'Win');
  // 记录每个子批次请求携带的滑动窗口来源（Source 段中的文本序号）
  const promptLogs = []; // { inputIdx, prevSrcIdx|null }
  try {
    global.fetch = async (url, opts) => {
      const { userPrompt, inputs } = parseBatchPrompt(opts);
      const inputIdx = Number(inputs[0].match(/Win-T(\d+)-/)[1]);
      const prevMatch = userPrompt.match(/Source: Win-T(\d+)-/);
      promptLogs.push({ inputIdx, prevSrcIdx: prevMatch ? Number(prevMatch[1]) : null });
      // 子批次 0 立即完成：同通道 worker 抢先取走子批次 5；
      // 其余子批次延迟 80ms，保证子批次 5 的窗口只能来自子批次 0（而非全局链的上一批 4）
      await sleep(inputIdx === 0 ? 0 : 80);
      return makeOkResponse(JSON.stringify(inputs.map((t) => '译W:' + t.slice(0, 10))));
    };

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);
    assert.ok(results.every((r) => r && r.success));

    // 首轮 5 个并发子批次均无窗口
    for (let i = 0; i < 5; i++) {
      const log = promptLogs.find((l) => l.inputIdx === i);
      assert.ok(log, `子批次 ${i} 应已请求`);
      assert.strictEqual(log.prevSrcIdx, null, `子批次 ${i} 是通道首批，不应携带窗口`);
    }
    // 子批次 0 先完成并写入共享窗口：子批次 5 随后发出时窗口来自子批次 0，
    // 而不是串行全局链下的子批次 4
    const log5 = promptLogs.find((l) => l.inputIdx === 5);
    assert.ok(log5, '子批次 5 应已请求');
    assert.strictEqual(log5.prevSrcIdx, 0, '子批次 5 的窗口应来自共享的最近完成子批次 0');
  } finally {
    global.fetch = originalFetch;
  }
});

test('增量下发：每个子批次完成后推送 translateBatchProgress 且 index 正确', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const originalTabsSend = chrome.tabs.sendMessage;
  const texts = makeLongTexts(3, 'Prog');
  const pushed = [];
  try {
    chrome.tabs.sendMessage = (tabId, msg) => {
      pushed.push({ tabId, msg });
      return Promise.resolve();
    };
    global.fetch = async (url, opts) => {
      const { inputs } = parseBatchPrompt(opts);
      await sleep(5);
      return makeOkResponse(JSON.stringify(inputs.map((t) => '译P:' + t.slice(0, 10))));
    };

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, 'sess-progress', 777);

    // 3 个子批次 -> 3 次推送，均发往发起标签页并携带会话 id
    assert.strictEqual(pushed.length, 3, '每个子批次完成应各推送一次');
    const pushedIndices = [];
    pushed.forEach(({ tabId, msg }) => {
      assert.strictEqual(tabId, 777);
      assert.strictEqual(msg.action, 'translateBatchProgress');
      assert.strictEqual(msg.sessionId, 'sess-progress');
      assert.ok(Array.isArray(msg.results) && msg.results.length === 1);
      const entry = msg.results[0];
      assert.ok(Number.isInteger(entry.index), '推送条目应携带 originalIndex');
      assert.strictEqual(entry.success, true);
      assert.strictEqual(entry.text, '译P:' + texts[entry.index].slice(0, 10), '推送译文应与该 index 的原文对应');
      pushedIndices.push(entry.index);
    });
    pushedIndices.sort((a, b) => a - b);
    assert.deepStrictEqual(pushedIndices, [0, 1, 2], '全部 index 应各推送一次（乱序完成不影响覆盖）');
    // 最终响应仍为权威完整结果
    assert.ok(results.every((r) => r && r.success));
  } finally {
    global.fetch = originalFetch;
    chrome.tabs.sendMessage = originalTabsSend;
  }
});

test('增量下发：无 tabId 时跳过推送', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const originalTabsSend = chrome.tabs.sendMessage;
  const texts = makeLongTexts(2, 'NoTab');
  const pushed = [];
  try {
    chrome.tabs.sendMessage = (tabId, msg) => {
      pushed.push({ tabId, msg });
      return Promise.resolve();
    };
    global.fetch = async (url, opts) => {
      const { inputs } = parseBatchPrompt(opts);
      return makeOkResponse(JSON.stringify(inputs.map((t) => '译N:' + t.slice(0, 10))));
    };

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, 'sess-no-tab', null);
    assert.ok(results.every((r) => r && r.success));
    assert.strictEqual(pushed.length, 0, '无 tabId 不应推送任何进度消息');
  } finally {
    global.fetch = originalFetch;
    chrome.tabs.sendMessage = originalTabsSend;
  }
});
