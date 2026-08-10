# ADR 0006: 整页翻译非首屏路径改批量（belowFold + 动态增量）

## 状态

Accepted

## 背景

整页翻译默认走流式路径（`enableStreaming !== false`），每段一个 SSE 长连接、云端固定 4 并发。首屏视口内与视口外（belowFold）段入视口后**均走流式**（`_translateBelowFoldViaViewport` 透传 `{streaming:true}`）；整页译完后的**动态增量翻译**（`_processAddedNodes`）同样透传 `{streaming:true}`。两者在大段数下均随段数线性增长--200 段约 50 轮串行，实测几十秒。

对照批量路径（`translateBatch` 50 段/请求 × 并发 10），同样页面 1 轮即完，吞吐差约两个量级。流式逐字阅读感在划词/单段场景价值高，但整页 belowFold 与动态增量均非首屏、用户扫读而非逐字，逐字收益小、线性代价大。

## 决策

**首屏视口内保留流式（首字优先），belowFold 与动态增量均改走批量路径。** 改动两处 `batchOptions`：`_translateBelowFoldViaViewport`（page.js:1294-1303）与 `_processAddedNodes`（page.js:2053-2057）从 `{streaming:true}` 改为不传 `streaming`，均经 `translateBatchParallel` 走批量打包（50 段/请求 × 10 并发）。

belowFold 已有的攒批窗口（`VIEWPORT_SUBMIT_DEBOUNCE_MS=100`）、IntersectionObserver 800px 预加载、6s 超时兜底无需改动。动态增量保持全译（不加视口优先）、防抖窗口 500ms 不变--新增段多在视口附近，批量已快，配额浪费有限。

## 后果

- 首屏保持首字优先（流式逐字）；belowFold 与动态增量从逐段 4 并发线性 -> 批量多轮，大页面几十秒降至数秒级。
- 两者段以「整段译完才显示」呈现（非逐字）；均非首屏、用户扫读，取舍可接受。
- 两者批量继承现有降级（批量 JSON 解析失败 -> 单句并发补全，最多 3 次重试）；并发优先级 LOW，不与首屏流式 HIGH 抢 `apiConcurrencyGate`。
- 诊断缺口未解：首字延迟（TTFT）与首屏可读时间当前未埋点，现有 `latencyMs` 是单请求端到端、会误导。本轮不含埋点，列为后续。

## 验证方案

- **基线**：固定标杆页（200+段）+ 同 provider + 5 次 p50，改前改后同条件对比。5 次样本下 p95 无统计意义，判据基于 p50。
- **埋点**（复用 `METRICS_STORE`/`recordMetric`/`getMetrics`，不另起一套）：
  - **TTFT**：SW 侧 `streamStart`->推首个 `streamChunk`，`recordMetric` 加 `ttftMs`（不含消息传输延迟，但 belowFold/动态增量改动不碰首屏流式，验证不回归足够）。
  - **整页完毕**：`logPageMetrics`（page.js:2070）从 `console.log` 改为落盘 `METRICS_STORE`，含 `elapsedSeconds`/`totalNodes`/`viewportNodes`/`belowFoldNodes`/`cacheHits`/`apiCount`。
  - **首屏可读时间**：`viewportItems` 批次完成回调记 `viewportDoneAt`，随 `logPageMetrics` 落盘。
- **诊断页**：现有「性能」区块加 3 指标 p50 + min~max（近 7 天，复用 `getMetrics`）；趋势图/独立区块留后续。
- **通过标准**（相对判据）：整页完毕 p50 降幅 > 60% + TTFT/首屏可读 p50 波动 < ±20%。

## 拒绝的替代方案

- **整页全改批量**：总时间最快，但牺牲整页首字逐字阅读感，与项目「响应速度是生命」对流式的投入冲突。
- **首屏加段数阈值**（视口内 ≤N 走流式、>N 走批量）：更彻底，但增判断逻辑与阈值常量；首屏段多的边界情况留待后续迭代。
- **流式也批量打包**（一个 SSE 翻多段）：需改 SW 流式协议（`streamChunk` 当前按 requestId 路由单段），改动大。
- **提升流式并发 4->8/10**：最简单，但 SSE 长连接高并发易触发 429（代码注释已明示此顾虑），治标不治本。
- **动态增量加视口优先**：复用 belowFold IntersectionObserver，后台预加载大量段时省配额；但增复杂度且新增段多在视口附近、批量已快，配额浪费有限，留后续。
