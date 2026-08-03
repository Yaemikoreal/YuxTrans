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

  /**
   * 信号量式出站并发闸门：在途数 < 上限时立即放行，否则按优先级排队（数值小者优先，同级 FIFO）。
   * 上限由 getLimit() 在「每次放行决策」时动态读取（而非创建时固化），
   * 因此限速状态变化（429 冷却把 concurrentLimit 降下来）对后续放行即时生效；
   * 上限调大时不主动唤醒队列，由下一次 acquire/release 自然消化（保守方向，不会超发）。
   * @param {() => number} getLimit 动态上限读取函数
   */
  function createConcurrencyGate(getLimit) {
    let active = 0;
    let seq = 0;
    const queue = []; // { priority, seq, resolve }

    function currentLimit() {
      const n = Number(getLimit());
      // 上限异常时兜底为 1：宁可串行也不放任并发
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    }

    // 取出优先级最高（数值最小）、同级先到先得的等待者
    function takeNext() {
      let best = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].priority < queue[best].priority ||
            (queue[i].priority === queue[best].priority && queue[i].seq < queue[best].seq)) {
          best = i;
        }
      }
      return queue.splice(best, 1)[0];
    }

    function tryDispatch() {
      while (queue.length > 0 && active < currentLimit()) {
        const next = takeNext();
        active++;
        next.resolve();
      }
    }

    /**
     * 申请一个并发槽位；当前在途数 < 动态上限时立即放行，否则按优先级排队
     * @param {number} [priority] 优先级，默认 NORMAL
     * @returns {Promise<void>} 获得槽位时 resolve
     */
    function acquire(priority) {
      const p = (typeof priority === 'number') ? priority : PRIORITY.NORMAL;
      return new Promise((resolve) => {
        queue.push({ priority: p, seq: seq++, resolve });
        tryDispatch();
      });
    }

    /** 释放槽位并放行队首（若有空位）；调用方须用 try/finally 保证配对 */
    function release() {
      if (active > 0) active--;
      tryDispatch();
    }

    return {
      acquire,
      release,
      activeCount: () => active,
      queuedCount: () => queue.length
    };
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
  SW.createConcurrencyGate = createConcurrencyGate;
  SW.scheduleTranslation = scheduleTranslation;
  SW.hasInflight = hasInflight;
  SW.inflightCount = inflightCount;
  SW.clearInflight = clearInflight;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PRIORITY, createConcurrencyGate, scheduleTranslation, hasInflight, inflightCount, clearInflight };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
