/**
 * SW 翻译调度器：in-flight 去重（相同 cacheKey 共享 Promise）+ 优先级标记
 * 依赖：bootstrap + constants
 * 与限速器正交：限速器管「发多快」，调度器管「相同请求只发一次 + 谁先发」。
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  /** 优先级：数值越小越优先（划词 > 视口内 > 全文/动态批次） */
  const PRIORITY = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 });

  // cacheKey -> { promise, priority }
  const inflight = new Map();

  /**
   * 调度单次翻译：相同 cacheKey 的并发请求合并为共享 Promise，
   * 后到的调用直接复用在途结果，避免重复消耗云端配额。
   * @param {string} cacheKey 缓存键（空则不去重，直接执行）
   * @param {() => Promise<any>} executor 实际翻译执行
   * @param {number} [priority] 优先级，默认 NORMAL
   * @returns {Promise<any>}
   */
  function scheduleTranslation(cacheKey, executor, priority) {
    if (!cacheKey) return Promise.resolve().then(executor);
    const p = (typeof priority === 'number') ? priority : PRIORITY.NORMAL;
    const existing = inflight.get(cacheKey);
    if (existing) {
      // 升级优先级：取更高（数值更小）者
      if (p < existing.priority) existing.priority = p;
      return existing.promise;
    }
    const entry = { priority: p, promise: null };
    entry.promise = Promise.resolve()
      .then(executor)
      .then(
        (result) => { inflight.delete(cacheKey); return result; },
        (err) => { inflight.delete(cacheKey); throw err; }
      );
    inflight.set(cacheKey, entry);
    return entry.promise;
  }

  /** 是否存在指定 cacheKey 的在途翻译 */
  function hasInflight(cacheKey) {
    return !!cacheKey && inflight.has(cacheKey);
  }

  /** 当前在途翻译数量（诊断用） */
  function inflightCount() {
    return inflight.size;
  }

  /** 清空在途表（仅测试 / 卸载时用） */
  function clearInflight() {
    inflight.clear();
  }

  SW.SCHEDULER_PRIORITY = PRIORITY;
  SW.scheduleTranslation = scheduleTranslation;
  SW.hasInflight = hasInflight;
  SW.inflightCount = inflightCount;
  SW.clearInflight = clearInflight;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PRIORITY, scheduleTranslation, hasInflight, inflightCount, clearInflight };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
