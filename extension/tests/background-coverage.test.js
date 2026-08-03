/**
 * 评判报告高价值盲区补测：
 * 1. validateCacheEntry 缓存命中校验器规则集
 * 2. translateBatchInternal 批量翻译降级链（直解 → 代码块 → 正则 → 单句补全）
 * 3. 自适应速率限制（updateRateLimitState / tryRecoverRateLimit）
 * 使用 Node 内置 test runner，fetch / Date.now / setTimeout 均在测试内 mock 并恢复
 */

const test = require('node:test');
const assert = require('node:assert');

require('./mock-chrome.js');
const bg = require('../background.js');

// ===== validateCacheEntry =====

// 便捷构造：用真实 generateCacheKey 生成 v3 键再校验
const validate = (text, src, tgt, value, style = 'normal') =>
  bg.validateCacheEntry(bg.generateCacheKey(text, src, tgt, style), value);

test('validateCacheEntry：正常译文通过全部规则', () => {
  const r = validate(
    'The quick brown fox jumps over the lazy dog', 'en', 'zh',
    '敏捷的棕色狐狸跳过了懒狗。'
  );
  // 英译中正常译文：长度达标、非拒绝语、非回显、目标文字比例 100%，应判有效
  assert.deepStrictEqual(r, { valid: true, rule: null });
});

test('validateCacheEntry：版本不匹配的旧缓存键直接判无效', () => {
  const r = bg.validateCacheEntry(
    'v2:p1:qwen-turbo:en:zh:normal:this is a long enough sentence',
    '这是一个足够长的测试句子'
  );
  // v2 旧版键即使译文正常也判无效，且规则名为 version_mismatch
  assert.deepStrictEqual(r, { valid: false, rule: 'version_mismatch' });
});

test('validateCacheEntry：API 拒绝 / 错误内容被 refusal 规则拦截', () => {
  const src = 'Please translate the following paragraph for me';
  const cases = [
    "I'm sorry, I cannot translate this document.", // 英文拒绝前缀（I'm sorry / cannot translate）
    'Error 429: rate limit exceeded',                // 错误文本混入缓存（error / 429 / rate limit）
    '<html><body>Bad Gateway</body></html>'          // HTML 错误页混入缓存（<html）
  ];
  for (const value of cases) {
    const r = validate(src, 'en', 'zh', value);
    // 每条拒绝/错误样本都应命中 refusal 规则
    assert.deepStrictEqual(r, { valid: false, rule: 'refusal' }, `应拦截: ${value}`);
  }
  // 反例：不含拒绝模式的正常译文不被误伤
  assert.strictEqual(validate(src, 'en', 'zh', '请为我翻译下面这个段落。').valid, true);
});

test('validateCacheEntry：过短源文被 too_short 拦截', () => {
  // 8 字符源文 < MIN_CACHE_SOURCE_LENGTH(12)，无论译文如何都判无效
  const r = validate('Hi there', 'en', 'zh', '你好，最近怎么样');
  assert.deepStrictEqual(r, { valid: false, rule: 'too_short' });
});

test('validateCacheEntry：短源文极端长度比被 length_ratio 拦截', () => {
  // 12 字符源文（过 too_short、≤ SHORT_SOURCE_THRESHOLD(24)），en→zh 阈值 2：
  // 27 字符译文 / 12 字符源文 ≈ 2.25 超阈值，规则 1 生效（阈值 10 时代为死代码，已修复）
  const r = validate('Hi there pal', 'en', 'zh', '这是一段远远超出原文长度的译文用来构造极端长度比例异常情况');
  assert.deepStrictEqual(r, { valid: false, rule: 'length_ratio' });
});

test('validateCacheEntry：短源文实体漂移被 entity_drift 拦截', () => {
  // 19 字符源文（过 too_short、≤24），译文主体为中文（汉字占比 15/25=0.6 过规则3）
  // 但夹带 .com 域名（实体漂移），长度比 28/19≈1.5 不触发规则1（阈值 10 时代为死代码，已修复）
  const r = validate('How to use the tool', 'en', 'zh', '详情说明请参考官方文档完整内容 github.com/x');
  assert.deepStrictEqual(r, { valid: false, rule: 'entity_drift' });
});

test('validateCacheEntry：跨语种回显原文被 echo 规则拦截', () => {
  // 英译中结果与原文完全一致（非专有名词），判定为回显
  assert.deepStrictEqual(
    validate('this is a simple test sentence', 'en', 'zh', 'this is a simple test sentence'),
    { valid: false, rule: 'echo' }
  );
  // 中日互译同样拦截整句回显
  assert.deepStrictEqual(
    validate('人工智能技术正在改变世界格局', 'zh', 'ja', '人工智能技术正在改变世界格局'),
    { valid: false, rule: 'echo' }
  );
  // 反例：真正译出的中文不触发 echo
  assert.strictEqual(
    validate('this is a simple test sentence', 'en', 'zh', '这是一个简单的测试句子').valid,
    true
  );
});

test('validateCacheEntry：目标文字比例不达标被 target_script 拦截', () => {
  // 英译中结果几乎无中文（汉字比例 < 0.5）
  assert.deepStrictEqual(
    validate(
      'The committee approved the new regulation yesterday', 'en', 'zh',
      'The committee approved the new regulation'
    ),
    { valid: false, rule: 'target_script' }
  );
  // 中译英结果仍是大量中文（拉丁字母比例 < 0.5）
  assert.deepStrictEqual(
    validate(
      '人工智能技术正在深刻改变着我们的生活方式', 'zh', 'en',
      '人工智能正在深刻改变生活'
    ),
    { valid: false, rule: 'target_script' }
  );
  // 反例：全中文译文对 zh 目标比例 100%，不被误伤
  assert.strictEqual(
    validate('The quick brown fox jumps over the lazy dog', 'en', 'zh', '敏捷的棕色狐狸跳过了懒狗。').valid,
    true
  );
});

test('validateCacheEntry：无目标文字校验的语言对回显源语被 source_language_echo 拦截', () => {
  // fr 无对应文字正则（比例校验放行），译文整体仍是中文 → 命中源语言回显
  assert.deepStrictEqual(
    validate('人工智能技术正在深刻改变着我们的生活方式', 'zh', 'fr', '人工智能正在改变生活'),
    { valid: false, rule: 'source_language_echo' }
  );
  // 反例：真正译成法文（拉丁字母）则通过
  assert.strictEqual(
    validate(
      '人工智能技术正在深刻改变着我们的生活方式', 'zh', 'fr',
      "L'intelligence artificielle change profondément notre vie"
    ).valid,
    true
  );
});

test('validateCacheEntry：CJK 互译夹带拉丁字母被 cjk_latin_drift 拦截', () => {
  // 中译日结果混入拉丁字母，判定为漂移
  assert.deepStrictEqual(
    validate('这是一段需要翻译的中文文本内容', 'zh', 'ja', 'これはテストです OK'),
    { valid: false, rule: 'cjk_latin_drift' }
  );
  // 反例：纯日文译文正常通过
  assert.strictEqual(
    validate('这是一段需要翻译的中文文本内容', 'zh', 'ja', 'これは翻訳が必要な中国語のテキストです').valid,
    true
  );
});

test('validateCacheEntry：dict 词典键跳过译文专有启发式，仅保留版本/非空校验', () => {
  // 单词源文（<12 字符）+ 含 'error' 的词典 JSON：普通译文键会被 too_short/refusal 拦截，
  // dict 键在版本校验后直接分流判有效
  assert.deepStrictEqual(
    validate('hello', 'en', 'zh', '{"error":"not found","pos":"n."}', 'dict'),
    { valid: true, rule: null }
  );
  // 反例：dict 键版本不匹配仍被拦截（版本校验在分流之前）
  assert.deepStrictEqual(
    bg.validateCacheEntry('v2:p1:qwen-turbo:en:zh:dict:hello', '{"pos":"n."}'),
    { valid: false, rule: 'version_mismatch' }
  );
});

// ===== 批量翻译降级链 =====

const BATCH_PROMPT_MARK = 'JSON array of strings'; // 批量 prompt 特征（单句 prompt 不含此句）
const FAIL_RESPONSE = { ok: false, status: 500, text: async () => 'server boom', json: async () => ({}) };

function makeOkResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => ''
  };
}

/**
 * 安装 fetch mock：按 URL / prompt 特征区分 批量请求 / 单句请求 / 本地 Ollama 故障转移
 */
function installFetchMock({ batchContent, singles = {}, failSingle = false }) {
  const calls = { batch: 0, single: 0, local: 0 };
  global.fetch = async (url, opts) => {
    // 云端失败后的自动故障转移走本地 Ollama；测试中始终不可用
    if (String(url).includes('11434')) {
      calls.local++;
      return FAIL_RESPONSE;
    }
    const prompt = JSON.parse(opts.body).messages[0].content;
    if (prompt.includes(BATCH_PROMPT_MARK)) {
      calls.batch++;
      return makeOkResponse(batchContent);
    }
    calls.single++;
    if (failSingle) return FAIL_RESPONSE;
    // 按 prompt 中包含的原文匹配对应单句译文
    for (const [src, tgt] of Object.entries(singles)) {
      if (prompt.includes(src)) return makeOkResponse(tgt);
    }
    return makeOkResponse('（未匹配的占位译文）');
  };
  return calls;
}

/**
 * 将短延迟定时器加速为立即执行（单句重试退避 1s/2s 不等真实时间），
 * >=30s 的超时定时器保持原样，避免 AbortController 提前 abort
 */
function accelerateShortTimers() {
  const real = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => real(fn, (ms || 0) >= 30000 ? ms : 0, ...args);
  return () => { global.setTimeout = real; };
}

// 批量测试统一以 qwen 档案为当前供应商
function useQwenProfile() {
  bg.addOrUpdateProfile({ provider: 'qwen', apiKey: 'sk-test', model: 'qwen-turbo' });
}

test('批量翻译：合法 JSON 数组直接解析成功', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = [
      'The weather forecast predicts heavy rain tomorrow',
      'Our team will review the proposal on Friday morning',
      'Please remember to submit your expense reports soon'
    ];
    const translations = ['天气预报说明天有大雨', '我们的团队将在周五上午审查提案', '请记得尽快提交您的费用报销单'];
    const calls = installFetchMock({ batchContent: JSON.stringify(translations) });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    // 三条译文按序映射回原位置
    assert.deepStrictEqual(results.map(r => r.text), translations);
    // 全部成功且引擎为当前供应商、非缓存命中
    assert.ok(results.every(r => r.success && r.engine === 'qwen' && r.cached === false));
    // 只发起一次批量请求，未触发任何单句补全
    assert.strictEqual(calls.batch, 1);
    assert.strictEqual(calls.single, 0);
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

test('批量翻译：```json 代码块包裹时走降级解析', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = [
      'International cooperation benefits everyone involved',
      'The museum exhibition attracted thousands of visitors'
    ];
    const calls = installFetchMock({
      batchContent: '```json\n["国际合作惠及每一个参与方", "博物馆展览吸引了数千名访客"]\n```'
    });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    // 代码块中的 JSON 被提取解析，两条译文均成功
    assert.deepStrictEqual(results.map(r => r.text), ['国际合作惠及每一个参与方', '博物馆展览吸引了数千名访客']);
    assert.ok(results.every(r => r.success));
    // 未走单句补全
    assert.strictEqual(calls.single, 0);
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

test('批量翻译：无代码块时用数组正则兜底提取', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = [
      'Regular exercise improves both physical and mental health',
      'The new policy takes effect at the beginning of next month'
    ];
    const calls = installFetchMock({
      batchContent: 'Sure! Here are the translations: ["规律锻炼有益身心健康", "新政策将于下月初生效"] Hope this helps.'
    });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    // 正则从杂散文本中抠出首个 JSON 数组并解析成功
    assert.deepStrictEqual(results.map(r => r.text), ['规律锻炼有益身心健康', '新政策将于下月初生效']);
    assert.ok(results.every(r => r.success));
    assert.strictEqual(calls.single, 0);
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

test('批量翻译：重复译文 sanity check 触发单句并发补全', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = [
      'Quantum computing promises exponential speedups for certain problems',
      'The recipe requires two cups of flour and a pinch of salt',
      'She published her first novel at the age of thirty'
    ];
    const singles = {
      [texts[0]]: '量子计算有望为特定问题带来指数级加速',
      [texts[1]]: '这个食谱需要两杯面粉和一小撮盐',
      [texts[2]]: '她在三十岁时出版了自己的第一部小说'
    };
    // 三条不同原文被译成同一结果（>2 条且去重后 ≤1），应按解析失败处理
    const calls = installFetchMock({
      batchContent: JSON.stringify(['页面标题', '页面标题', '页面标题']),
      singles
    });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    // 重复译文未被采纳，三项全部由单句补全完成
    assert.deepStrictEqual(results.map(r => r.text), Object.values(singles));
    assert.ok(results.every(r => r.success));
    // 一次批量请求 + 三次单句补全，且单句成功未触发本地故障转移
    assert.strictEqual(calls.batch, 1);
    assert.strictEqual(calls.single, 3);
    assert.strictEqual(calls.local, 0);
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

test('批量翻译：JSON 完全解析失败时全部走单句并发补全', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = [
      'The ancient bridge has withstood centuries of flooding',
      'Renewable energy sources are becoming increasingly affordable',
      'He donated his entire collection to the national library'
    ];
    const singles = {
      [texts[0]]: '这座古桥经受住了数百年的洪水',
      [texts[1]]: '可再生能源正变得越来越经济实惠',
      [texts[2]]: '他把全部收藏捐给了国家图书馆'
    };
    // 完全不含 JSON 数组的回复：直解 / 代码块 / 正则三级解析全部落空
    const calls = installFetchMock({ batchContent: 'I apologize, but I cannot process this batch.', singles });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    // 三项全部由单句补全完成
    assert.deepStrictEqual(results.map(r => r.text), Object.values(singles));
    assert.ok(results.every(r => r.success));
    assert.strictEqual(calls.batch, 1);
    assert.strictEqual(calls.single, 3);
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

test('批量翻译：长度不匹配时已解析部分被利用，缺失项单句补全', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = [
      'The lighthouse guided ships safely through the storm',
      'Fresh coffee beans should be ground just before brewing',
      'The committee meets every other Tuesday afternoon'
    ];
    const singles = {
      [texts[1]]: '新鲜咖啡豆应在冲泡前现磨',
      [texts[2]]: '委员会每隔一周的周二下午开会'
    };
    // 只返回 1 条译文（预期 3 条）：第一条直接被利用，其余两条补全
    const calls = installFetchMock({ batchContent: '["灯塔指引船只在风暴中安全航行"]', singles });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    // 已解析的第一条译文被采纳，未浪费
    assert.strictEqual(results[0].text, '灯塔指引船只在风暴中安全航行');
    assert.strictEqual(results[0].success, true);
    // 缺失的两条由单句补全
    assert.deepStrictEqual(results.slice(1).map(r => r.text), Object.values(singles));
    assert.strictEqual(calls.single, 2);
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

test('批量翻译：单句补全重试上限 3 次后标记失败', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = ['This single sentence will keep failing forever'];
    // 批量解析失败 + 单句请求始终 500（含本地故障转移也失败）
    const calls = installFetchMock({ batchContent: 'garbage without array', failSingle: true });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    // 单句重试恰为 3 次（retry 0/1/2），不多不少
    assert.strictEqual(calls.single, 3);
    // 每次失败都尝试了本地 Ollama 故障转移，同样 3 次
    assert.strictEqual(calls.local, 3);
    // 最终结果标记为失败并保留原文与错误信息（500 经 formatError 映射为友好文案）
    assert.strictEqual(results[0].success, false);
    assert.strictEqual(results[0].originalText, texts[0]);
    assert.strictEqual(results[0].error, '服务器内部错误，请稍后重试');
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

// ===== 自适应速率限制 =====

// 将共享的 rateLimitState 恢复为初始默认值（测试间隔离）
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

test('速率限制：连续 2 次普通失败触发限速，单次不触发', () => {
  resetRateLimitState();
  // 第 1 次普通失败：未达 ERROR_TO_LIMIT(2)，不限速
  bg.updateRateLimitState(false, false);
  assert.strictEqual(bg.rateLimitState.isRateLimited, false);
  assert.strictEqual(bg.rateLimitState.concurrentLimit, 10);

  // 第 2 次连续失败：触发限速，并发 10-3=7，延迟 0+500=500
  bg.updateRateLimitState(false, false);
  assert.strictEqual(bg.rateLimitState.isRateLimited, true);
  assert.strictEqual(bg.rateLimitState.concurrentLimit, 7);
  assert.strictEqual(bg.rateLimitState.requestDelay, 500);
  // getRateLimitParams 反映限速后的参数
  assert.deepStrictEqual(bg.getRateLimitParams(), { maxConcurrent: 7, requestDelay: 500 });
  resetRateLimitState();
});

test('速率限制：429 单次立即触发限速并记录冷却起点', () => {
  resetRateLimitState();
  // 429（isRateLimitError=true）不要求连续错误次数，单次即限速
  bg.updateRateLimitState(false, true);
  assert.strictEqual(bg.rateLimitState.isRateLimited, true);
  assert.strictEqual(bg.rateLimitState.concurrentLimit, 7);
  assert.strictEqual(bg.rateLimitState.requestDelay, 500);
  // lastRateLimitTime 记录为当前时间，作为 30s 冷却起点
  assert.ok(bg.rateLimitState.lastRateLimitTime > 0);
  resetRateLimitState();
});

test('速率限制：连续失败时并发降至下限 1、延迟升至上限 2000ms 后封顶', () => {
  resetRateLimitState();
  // 连续 4 次 429：并发 7→4→1→1，延迟 500→1000→1500→2000
  for (let i = 0; i < 4; i++) bg.updateRateLimitState(false, true);
  // 并发不低于 MIN_CONCURRENT(1)
  assert.strictEqual(bg.rateLimitState.concurrentLimit, 1);
  // 延迟不高于 MAX_DELAY(2000)
  assert.strictEqual(bg.rateLimitState.requestDelay, 2000);
  resetRateLimitState();
});

test('速率限制：冷却期内 tryRecoverRateLimit 不恢复', () => {
  resetRateLimitState();
  bg.updateRateLimitState(false, true);
  // 冷却期（30s）内即使不要求连续成功也拒绝恢复
  assert.strictEqual(bg.tryRecoverRateLimit(false), false);
  // 参数保持限速状态不变
  assert.deepStrictEqual(bg.getRateLimitParams(), { maxConcurrent: 7, requestDelay: 500 });
  resetRateLimitState();
});

test('速率限制：冷却期过后按步长恢复并发并降低延迟', () => {
  resetRateLimitState();
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0;
    bg.updateRateLimitState(false, true);

    // 时间推进到冷却期（30s）之后
    Date.now = () => t0 + 31000;
    // 恢复成功：并发 7+2=9，延迟 500-200=300
    assert.strictEqual(bg.tryRecoverRateLimit(false), true);
    assert.deepStrictEqual(bg.getRateLimitParams(), { maxConcurrent: 9, requestDelay: 300 });
    // 未恢复满之前仍保持限速标记
    assert.strictEqual(bg.rateLimitState.isRateLimited, true);
  } finally {
    Date.now = realNow;
  }
  resetRateLimitState();
});

test('速率限制：连续成功满 5 次才恢复，恢复至满并发零延迟后解除限速', () => {
  resetRateLimitState();
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0;
    bg.updateRateLimitState(false, true); // 进入限速：7 并发 / 500ms

    // 冷却期过后，连续 4 次成功仍不达 SUCCESS_TO_RECOVER(5) 门槛，不恢复
    Date.now = () => t0 + 31000;
    for (let i = 0; i < 4; i++) bg.updateRateLimitState(true);
    assert.deepStrictEqual(bg.getRateLimitParams(), { maxConcurrent: 7, requestDelay: 500 });

    // 第 5 次连续成功：满足门槛，恢复一步（9 / 300）
    bg.updateRateLimitState(true);
    assert.deepStrictEqual(bg.getRateLimitParams(), { maxConcurrent: 9, requestDelay: 300 });

    // 第 6 次：再恢复一步（10 / 100），并发封顶 MAX_CONCURRENT
    bg.updateRateLimitState(true);
    assert.deepStrictEqual(bg.getRateLimitParams(), { maxConcurrent: 10, requestDelay: 100 });

    // 第 7 次：并发满 + 延迟归零，解除限速标记
    bg.updateRateLimitState(true);
    assert.deepStrictEqual(bg.getRateLimitParams(), { maxConcurrent: 10, requestDelay: 0 });
    assert.strictEqual(bg.rateLimitState.isRateLimited, false);
  } finally {
    Date.now = realNow;
  }
  resetRateLimitState();
});

// 方案 3：短文本合法同译不触发降级（Settings/Configuration/Preferences -> 设置）
test('批量翻译：短文本统一译文视为合法近义词，不降级单句补全', async () => {
  useQwenProfile();
  const originalFetch = global.fetch;
  const restoreTimers = accelerateShortTimers();
  try {
    const texts = ['Settings', 'Configuration', 'Preferences'];
    const calls = installFetchMock({
      batchContent: JSON.stringify(['设置', '设置', '设置']),
      singles: {}
    });

    const results = await bg.translateBatchInternal(texts, 'en', 'zh', null, null);

    assert.ok(results.every(r => r.success));
    assert.deepStrictEqual(results.map(r => r.text), ['设置', '设置', '设置']);
    assert.strictEqual(calls.batch, 1);
    assert.strictEqual(calls.single, 0);
  } finally {
    global.fetch = originalFetch;
    restoreTimers();
  }
});

// 方案 9：estimateTokens 区分 CJK 与 Latin
test('estimateTokens：CJK 与 Latin 分别估算', () => {
  assert.strictEqual(bg.estimateTokens('你好世界'), 3);
  assert.strictEqual(bg.estimateTokens('Hello World'), 3);
  assert.strictEqual(bg.estimateTokens('Hello 你好'), 3);
  assert.strictEqual(bg.estimateTokens(''), 0);
  assert.strictEqual(bg.estimateTokens('量子计算是未来科技发展的核心方向'), 11);
});
