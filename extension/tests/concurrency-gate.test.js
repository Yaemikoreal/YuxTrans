/**
 * 出站并发闸门测试（评判报告 F2：自适应并发限制名不副实的修复）
 * 1. 信号量单元行为：上限约束 + 优先级放行（划词 > 视口 > 批次）+ 动态上限即时生效
 * 2. 主路径集成：translateWithCloud 过全局闸门，限速到 1 时串行化；
 *    请求出错 / abort 后槽位释放，排队请求不死锁
 * 使用 Node 内置 test runner，fetch 在测试内 mock 并恢复
 */

const test = require('node:test');
const assert = require('node:assert');

require('./mock-chrome.js');
const bg = require('../background.js');

const P = bg.SW.SCHEDULER_PRIORITY;
// 等一轮微任务 + 宏任务，让闸门放行与 fetch 调用落地
const tick = () => new Promise((r) => setImmediate(r));

// ===== 信号量单元行为 =====

test('并发闸门：上限 2 时同时 5 个请求，在途 ≤2 且按优先级放行', async () => {
  const gate = bg.SW.createConcurrencyGate(() => 2);
  const grantOrder = [];
  const acquire = (name, pri) => gate.acquire(pri).then(() => { grantOrder.push(name); });

  // 先到的两个 LOW 立即占满槽位
  const a = acquire('a-low', P.LOW);
  const b = acquire('b-low', P.LOW);
  // 随后的 HIGH / NORMAL / LOW 必须排队
  const c = acquire('c-high', P.HIGH);
  const d = acquire('d-normal', P.NORMAL);
  const e = acquire('e-low', P.LOW);
  await tick();

  assert.deepStrictEqual(grantOrder, ['a-low', 'b-low']);
  assert.strictEqual(gate.activeCount(), 2);
  assert.strictEqual(gate.queuedCount(), 3);

  // 释放一个槽位：跳过先排队的 LOW，放行优先级最高的 c-high
  gate.release();
  await tick();
  assert.deepStrictEqual(grantOrder, ['a-low', 'b-low', 'c-high']);

  // 再释放：NORMAL 先于 LOW
  gate.release();
  await tick();
  assert.deepStrictEqual(grantOrder, ['a-low', 'b-low', 'c-high', 'd-normal']);

  // 全部释放后 e-low 放行，队列清空
  gate.release();
  gate.release();
  await tick();
  assert.deepStrictEqual(grantOrder, ['a-low', 'b-low', 'c-high', 'd-normal', 'e-low']);
  assert.strictEqual(gate.queuedCount(), 0);

  gate.release(); // 收尾归零，避免影响其他断言
  await Promise.all([a, b, c, d, e]);
  assert.strictEqual(gate.activeCount(), 0);
});

test('并发闸门：上限动态读取，限速降到 1 立即串行化', async () => {
  let limit = 3;
  const gate = bg.SW.createConcurrencyGate(() => limit);
  await gate.acquire();
  await gate.acquire();
  assert.strictEqual(gate.activeCount(), 2);

  // 模拟 429 限速：上限降至 1（在途 2 已超上限）
  limit = 1;
  let granted = false;
  const pending = gate.acquire().then(() => { granted = true; });
  await tick();
  assert.strictEqual(granted, false);

  // 释放一个在途后 active=1，仍不小于新上限，继续压住不放行
  gate.release();
  await tick();
  assert.strictEqual(granted, false);

  // 再释放一个才有空位，排队者放行
  gate.release();
  await tick();
  assert.strictEqual(granted, true);

  gate.release();
  await pending;
  assert.strictEqual(gate.activeCount(), 0);
});

test('并发闸门：同级 FIFO，且上限调大后不超发', async () => {
  let limit = 1;
  const gate = bg.SW.createConcurrencyGate(() => limit);
  const order = [];
  const track = (name) => gate.acquire(P.NORMAL).then(() => { order.push(name); });

  const a = track('a');
  const b = track('b');
  const c = track('c');
  await tick();
  assert.deepStrictEqual(order, ['a']);

  // 上限调大到 3：已排队的不会主动唤醒（保守方向），由 release 逐个消化
  limit = 3;
  await tick();
  assert.deepStrictEqual(order, ['a']);

  gate.release();
  await tick();
  // 一次 release 后队列按空位连续放行，b/c 按 FIFO 顺序获得槽位
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  assert.ok(gate.activeCount() <= 3);

  gate.release();
  gate.release();
  gate.release();
  await Promise.all([a, b, c]);
  assert.strictEqual(gate.activeCount(), 0);
});

// ===== 主路径集成 =====

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

// 将共享的 rateLimitState 恢复为默认值（测试间隔离）
function resetRateLimitState() {
  Object.assign(bg.rateLimitState, {
    concurrentLimit: 10,
    requestDelay: 0,
    consecutiveSuccess: 0,
    consecutiveErrors: 0,
    lastRateLimitTime: 0,
    isRateLimited: false
  });
}

test('主路径闸门：concurrentLimit=1 时 translateWithCloud 全程串行', async () => {
  useQwenProfile();
  resetRateLimitState();
  bg.rateLimitState.concurrentLimit = 1; // 直接压到限速下限
  const originalFetch = global.fetch;

  let inflight = 0;
  let maxInflight = 0;
  const startOrder = [];
  const resolvers = [];
  global.fetch = (url, opts) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    const prompt = JSON.parse(opts.body).messages[0].content;
    startOrder.push(prompt);
    return new Promise((resolve) => {
      resolvers.push(() => {
        inflight--;
        resolve(makeOkResponse('译文'));
      });
    });
  };

  try {
    const r1 = bg.translateWithCloud('First sentence of the gate test', 'en', 'zh');
    const r2 = bg.translateWithCloud('Second sentence of the gate test', 'en', 'zh');
    const r3 = bg.translateWithCloud('Third sentence of the gate test', 'en', 'zh');
    await tick();
    await tick();

    // 上限 1：只有第一个请求真正发出 fetch，其余在闸门排队
    assert.strictEqual(resolvers.length, 1);
    assert.strictEqual(bg.apiConcurrencyGate.activeCount(), 1);
    assert.strictEqual(bg.apiConcurrencyGate.queuedCount(), 2);

    // 完成第一个 → 第二个发出；同级 FIFO（同优先级按提交顺序）
    resolvers[0]();
    await tick();
    await tick();
    assert.strictEqual(resolvers.length, 2);
    assert.ok(startOrder[0].includes('First sentence'));
    assert.ok(startOrder[1].includes('Second sentence'));

    resolvers[1]();
    await tick();
    await tick();
    assert.strictEqual(resolvers.length, 3);

    resolvers[2]();
    assert.deepStrictEqual(await Promise.all([r1, r2, r3]), ['译文', '译文', '译文']);
    // 全程在途不超过 1，且结束后槽位归零
    assert.strictEqual(maxInflight, 1);
    assert.strictEqual(bg.apiConcurrencyGate.activeCount(), 0);
    assert.strictEqual(bg.apiConcurrencyGate.queuedCount(), 0);
  } finally {
    global.fetch = originalFetch;
    resetRateLimitState();
  }
});

test('主路径闸门：429 把限速打到 1 后，闸门即时按新上限串行化', async () => {
  useQwenProfile();
  resetRateLimitState();
  const originalFetch = global.fetch;
  const realNow = Date.now;

  let inflight = 0;
  let maxInflight = 0;
  const resolvers = [];
  global.fetch = () => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    return new Promise((resolve) => {
      resolvers.push(() => {
        inflight--;
        resolve(makeOkResponse('译文'));
      });
    });
  };

  try {
    // 连续 429 将 concurrentLimit 打到 MIN_CONCURRENT(1)（冻结时间避免冷却期干扰）
    const t0 = realNow();
    Date.now = () => t0;
    for (let i = 0; i < 4; i++) bg.updateRateLimitState(false, true);
    assert.strictEqual(bg.getRateLimitParams().maxConcurrent, 1);
    // 限速延迟不影响本测试的时序断言（请求仍过闸门，只是额外串行）
    bg.rateLimitState.requestDelay = 0;

    const r1 = bg.translateWithCloud('Rate limited gate test one', 'en', 'zh');
    const r2 = bg.translateWithCloud('Rate limited gate test two', 'en', 'zh');
    await tick();
    await tick();

    // 新上限 1 即时生效：第二个请求被闸门压住
    assert.strictEqual(resolvers.length, 1);
    resolvers[0]();
    await tick();
    await tick();
    assert.strictEqual(resolvers.length, 2);
    resolvers[1]();

    await Promise.all([r1, r2]);
    assert.strictEqual(maxInflight, 1);
    assert.strictEqual(bg.apiConcurrencyGate.activeCount(), 0);
  } finally {
    Date.now = realNow;
    global.fetch = originalFetch;
    resetRateLimitState();
  }
});

test('主路径闸门：请求 abort 后槽位释放，排队请求不被卡死', async () => {
  useQwenProfile();
  resetRateLimitState();
  bg.rateLimitState.concurrentLimit = 1;
  const originalFetch = global.fetch;

  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      // 模拟会话取消 / 超时导致的 AbortError
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return makeOkResponse('译文');
  };

  try {
    const r1 = bg.translateWithCloud('Abort path gate test one', 'en', 'zh');
    const r2 = bg.translateWithCloud('Abort path gate test two', 'en', 'zh');

    // 第一个请求 abort：转为超时文案抛出，finally 释放槽位
    await assert.rejects(r1, /请求超时/);
    // 排队中的第二个请求随即放行并成功，证明队列未死锁
    assert.strictEqual(await r2, '译文');
    assert.strictEqual(calls, 2);
    assert.strictEqual(bg.apiConcurrencyGate.activeCount(), 0);
    assert.strictEqual(bg.apiConcurrencyGate.queuedCount(), 0);
  } finally {
    global.fetch = originalFetch;
    resetRateLimitState();
  }
});

test('主路径闸门：请求业务报错（非 abort）同样释放槽位', async () => {
  useQwenProfile();
  resetRateLimitState();
  bg.rateLimitState.concurrentLimit = 1;
  const originalFetch = global.fetch;

  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 500, text: async () => 'server boom', json: async () => ({}) };
    return makeOkResponse('译文');
  };

  try {
    const r1 = bg.translateWithCloud('Error path gate test one', 'en', 'zh');
    const r2 = bg.translateWithCloud('Error path gate test two', 'en', 'zh');

    await assert.rejects(r1, /服务器内部错误/);
    assert.strictEqual(await r2, '译文');
    assert.strictEqual(calls, 2);
    assert.strictEqual(bg.apiConcurrencyGate.activeCount(), 0);
    assert.strictEqual(bg.apiConcurrencyGate.queuedCount(), 0);
  } finally {
    global.fetch = originalFetch;
    resetRateLimitState();
  }
});
