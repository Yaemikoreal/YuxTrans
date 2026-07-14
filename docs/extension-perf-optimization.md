# 浏览器扩展性能优化方案

> 日期：2026-07-14
> 范围：`extension/background.js` + `extension/content.js` 翻译路径优化
> 主力模型：deepseek-v4-flash（1M context window）

---

## 一、当前瓶颈

### 1.1 首屏流式翻译：连接开销过大

**现状** (`content.js:902`)：视口内文本以 `streamConcurrency=12` 路并发流式请求，每个片段一次独立 HTTP POST + SSE 连接。

```
视口 30 个短句 → 12 路并发流式 → 每个句子独立 HTTP 连接
  → 12 次 TCP/TLS 握手（或 Keep-Alive 复用）
  → 12 次完整 prompt 发送
  → 12 次 SSE 流接收
```

**问题**：
- 每个请求都要发送完整 system prompt，前缀重复开销被放大 12 倍
- 流式首字延迟低（~0.3s），但总 token 吞吐远低于非流式 batch
- 同一视口内 20-50 个短句被拆成最多 12 条独立连接，而非 1 次 batch

**影响**：高。视口首屏是用户感知最强烈的阶段。

### 1.2 批量翻译批次偏小

**现状**：
- `content.js`：`batchSize: 20`
- `background.js`：`MAX_BATCH_CHARS = 4000`

**问题**：
- deepseek-v4-flash 拥有 1M context，4000 字符仅占其能力的 0.4%
- API round-trip 次数多，网络延迟占主导
- prompt 前缀重复开销随批次数放大

**影响**：高。整页翻译总耗时线性相关于批次数。

### 1.3 缓存命中校验在热路径上过重

**现状** (`background.js:639-655`)：`getFromCache` 每次命中都调用完整 `validateCacheEntry`。

`validateCacheEntry` 执行内容：
- 版本号校验
- 最短长度检查
- API 拒绝模式扫描（`REFUSAL_PATTERNS`）
- 语言检测（`detectLanguage`，最多 500 字符）
- 长度比例检查（语言对敏感阈值）
- 回显原文检测
- 目标语脚本比例统计（逐字符遍历 Unicode block）
- 源语言回显检测（二次 `detectLanguage`）
- 实体漂移检查（正则匹配 URL/路径/命名实体）

**问题**：命中缓存本应 <1ms，实际 5-10ms。高频整页翻译时累加明显——200 次缓存命中 = 1-2s 额外损耗。

**影响**：中高。缓存命中率越高，影响越大。

### 1.4 语言检测重复计算

**现状**：`resolveTargetLanguage` / `resolveSourceLanguage` 对每个文本独立调 `detectLanguage`。

**问题**：同一批次内（批量翻译 20-150 条），语言方向一致，但每条都做一次语言检测。`detectLanguage` 是相对昂贵的操作（需要遍历字符统计 Unicode block 分布）。

**影响**：中。batch 越大，浪费越明显。

### 1.5 缓存写入过于频繁

**现状** (`background.js:657-681`)：`setToCache` 逐条触发 IndexedDB flush：
- `pendingCacheWrites.size >= 50` → 立即 `await flushCacheToDB()`
- 500ms debounce → 自动 flush

**问题**：整页翻译时短时间内大量写入（200+ 条目），频繁触发 IndexedDB 事务，阻塞主流程。

**影响**：低中。DB 写入本身异步，但事务竞争会拖慢后续读写。

---

## 二、优化方案

### 优先级总览

| # | 优化项 | 风险 | 收益 | 说明 |
|---|--------|------|------|------|
| E | 语言检测去重 | 零 | 中 | 一行改动 |
| C | getFromCache 轻量化 | 极低 | 高 | 热路径，每毫秒值钱 |
| D | 批量 flush | 极低 | 中 | 减少 DB 写入抖动 |
| B | 动态 batch 上限 | 低 | 高 | 利用 deepseek 1M context |
| A | 视口 mini-batch 替代流式 | 中 | 高 | 翻译路径重构 |

**建议分两个 commit**：E+C+D+B 合为 commit 1（低风险高收益），A 单独 commit 2（需实机验证体感）。

---

### E. 语言检测去重

**改动位置**：`background.js` — `translateBatchInternal` 函数入口

**方案**：在批量翻译入口处一次性检测语言方向，后续所有 item 复用：

```javascript
// 入口处算一次
const batchSourceLang = resolveSourceLanguage(items[0].text, sourceLang);
// 对所有 item 复用 batchSourceLang，不再逐条调 detectLanguage
```

**理由**：同一翻译批次内，用户选择的源语言 `auto` 时，第一条文本的检测结果适用于整批。即使混入少量不同语言的文本（如代码注释中的英文），缓存键中的语言标记不影响实际翻译质量。

**预期收益**：200 句整页翻译省去 200 次 `detectLanguage` 调用（每次 ~0.5-2ms，合计节省 ~100-400ms）。

---

### C. getFromCache 轻量化

**改动位置**：`background.js` — `getFromCache` 函数（`line 639`）

**方案**：`getFromCache` 仅做版本号 + 非空检查，移除完整 `validateCacheEntry` 调用：

```javascript
function getFromCache(key) {
  if (!config.cacheEnabled) return null;
  const value = cache.get(key);
  if (value === undefined) return null;

  // 仅快速检查
  const parsed = parseCacheKey(key);
  if (parsed.version !== CACHE_KEY_VERSION) {
    evictCacheEntry(key);
    return null;
  }
  if (!value || !value.trim()) {
    evictCacheEntry(key);
    return null;
  }

  // LRU 位移
  cache.delete(key);
  cache.set(key, value);
  return value;
}
```

**完整校验保留位置**：
- `setToCache`（写入前）—— 防止新增坏条目
- `cleanupInvalidCacheEntries`（Service Worker 启动后台异步扫描）—— 清存量

**理由**：
- 缓存命中场景下，条目在写入时已经过完整校验，重复校验是浪费
- 热路径上的每毫秒节省都直接转化为用户体验提升
- 坏条目即使逃过写入时检查，也会被后台清理任务扫掉，不会持久污染

**预期收益**：单次缓存命中从 5-10ms 降到 <1ms。200 次命中节省 ~1-1.8s。

---

### D. 批量 flush 缓存写入

**改动位置**：`background.js` — `setToCache` / `flushCacheToDB` 触发逻辑

**方案**：
1. 移除 `setToCache` 中的 `pendingCacheWrites.size >= 50 → await flushCacheToDB()` 立即 flush
2. 调整 flush 触发条件：攒到 **200 条** 或 **8 秒** 间隔
3. Service Worker 空闲时主动 flush

```javascript
async function setToCache(key, value) {
  if (!config.cacheEnabled) return;
  const validation = validateCacheEntry(key, value);
  if (!validation.valid) return;
  // ... 内存缓存更新 ...
  pendingCacheWrites.add(key);
  pendingCacheDeletes.delete(key);
  // 不再立即 flush，改为定时/阈值触发
  scheduleCacheFlush();
}

function scheduleCacheFlush() {
  if (pendingCacheSave || isFlushingCache) return;
  // 200 条或 8 秒触发
  if (pendingCacheWrites.size >= 200) {
    flushCacheToDB();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushCacheToDB();
    }, 8000);
  }
}
```

**理由**：
- 减少 IndexedDB 事务次数：200 条一次事务 vs 50 条四次事务，减少了 4x DB 交互
- 8 秒兜底确保用户关闭标签页前数据大概率已落盘
- 不影响缓存读取——读取走内存 `Map`，不依赖 DB 写入是否完成

**预期收益**：200 句整页翻译场景，DB 写入次数从 4 次降到 1 次。单次 IndexedDB 批量写入耗时 ~50-100ms，省 3 次 ≈ 150-300ms。主要收益是减少 I/O 抖动对主线程的影响。

---

### B. 动态 batch 上限（按供应商/模型）

**改动位置**：
- `background.js`：`MAX_BATCH_CHARS` 从常量改为 `getEffectiveBatchConfig()` 函数
- `content.js`：`batchSize` 从配置读取（`background.js` 动态返回）

**方案**：运行时根据 provider + model 查表返回 batch 参数。

| 层级 | MAX_BATCH_CHARS | batchSize | 并发 | 适用 |
|------|-----------------|-----------|------|------|
| deepseek-v4-flash | 24000 | 150 | 2 | 主力，1M context |
| deepseek 其他模型 | 12000 | 80 | 2 | deepseek 全系 context 大 |
| 其他云端 | 8000 | 50 | 2 | qwen/gpt/haiku 等 |
| 本地 Ollama 14B+ | 6000 | 40 | 1 | 离线高性能 |
| 本地 Ollama 7B | 4000 | 20 | 1 | 默认兼容 |

> **上限依据**：deepseek-v4-flash 1M context 输入侧完全不是瓶颈，限制在 24000 chars / 150 条是因为 JSON 数组响应的输出稳定性——超过 150 条时模型偶尔截断 JSON 或格式错乱。现有 3 种 fallback 解析策略能兜底，但降级路径本身就慢，不应作为常态依赖。

**理由**：
- 1M context 的模型用 4000 chars 批次是浪费，一次请求 24000 chars ≈ 3-6 倍吞吐提升
- 按模型能力分段避免劣化——本地 7B 保持小批次防止 OOM
- 非首屏场景用户不关心逐条出现，batch 越大完成越快

**预期收益**：deepseek-v4-flash 下，100 句整页翻译从 ~5 次 API 请求降到 ~1 次。单次 API round-trip 约 1.5-3s，省 4 次 ≈ 6-12s 总耗时下降。

---

### A. 视口 mini-batch 替代流式翻译

**改动位置**：
- `content.js:890-923` — 视口翻译逻辑
- `content.js:617` — `translateBatchParallel` 批量翻译函数

**方案**：取消视口独立流式路径，整页翻译统一走 `translateBatchInternal`，通过 batchSize 区分首屏与非首屏：

```
视口 (viewport):    mini-batch, batchSize=10,  concurrency=4  → 低延迟感知
非首屏 (belowFold): full-batch, batchSize=150, concurrency=2  → 高吞吐
```

两段走同一代码路径（`translateBatchInternal`），仅 batchSize 参数不同。每个 mini-batch 完成后立即通过 `onBatchResult` 回调渲染该 batch 内所有节点。

**流程对比**：

| | 当前 | 优化后 |
|---|------|--------|
| 视口路径 | 12路独立流式 SSE | 4路并发 mini-batch（batchSize=10） |
| 非首屏路径 | batchSize=20 批量 | batchSize=150 批量 |
| API 请求数（视口30句） | 30 次 | 3 次 |
| API 请求数（总计100句） | ~35 次 | ~4 次 |
| 首字延迟 | ~0.3s | ~0.8-1.2s |
| 总完成时间 | 8-15s | 2-5s |

**理由**：
- deepseek-v4-flash 1M context 完全能一次处理 150 句，12 路独立连接是真正的浪费——每路的 system prompt 前缀都被重复传输
- mini-batch=10 保证了首屏感知延迟仍然在 ~1s 以内（一次 HTTP POST + 模型首个 token），体感差异小
- 统一路径消除了流式/非流式两套代码的维护成本
- 保留 `onBatchResult` 回调逐批渲染，首屏不会等到全部完成才出现文本

**风险与缓解**：
- 首字延迟从 0.3s → 1s：对整页翻译场景可接受，用户看的是页面整体是否翻译完而非第一个词
- mini-batch=10 可能某些场景偏小/偏大：后续根据 metrics 数据微调
- 流式路径暂时保留代码但不再被整页翻译调用（保留给弹窗快捷翻译，那里流式首字延迟更重要）

**预期收益**：整页翻译总完成时间从 8-15s 降到 2-5s（deepseek-v4-flash），降幅 60-70%。

---

## 三、实施顺序与验证

### Commit 1：低风险优化（E + C + D + B）

```
改动范围：
  - background.js: detectLanguage 去重、getFromCache 轻量化、批量 flush、动态 batch 上限
  - content.js: batchSize 读取方式（适配动态返回）

验证方式：
  1. node --test extension/tests/  确保缓存逻辑测试通过
  2. 浏览器加载扩展，翻译一个简单页面验证基本功能
  3. console 观察 [YuxTrans] 日志确认 batch 上限生效
```

### Commit 2：翻译路径重构（A）

```
改动范围：
  - content.js: translatePage 视口段从流式改为 translateBatchParallel mini-batch

验证方式：
  1. 翻译一个英文技术文档页面（30-80 个文本节点）
  2. 翻译一个中文新闻页面
  3. 翻译一个中英混合导航站
  4. 对比优化前后的首屏出现时间和总完成时间（console timestamp）
  5. 确认翻译质量不劣化（batch prompt 已有严格约束）
```

### 可回滚设计

优化 B 和 A 均通过配置开关控制：
- `content.js` 中的 `batchSize`、`viewportBatchSize` 从 `background.js` 获取
- `background.js` options 页可增加「性能模式」开关（默认启用新参数，关闭则回退到旧常量）

---

## 四、预期总效果

| 指标 | 优化前 | 优化后 | 降幅 |
|------|--------|--------|------|
| 整页翻译 API 请求数（100句） | ~35 次 | ~4 次 | **-89%** |
| 整页翻译总耗时 | 8-15s | 2-5s | **-60~70%** |
| 缓存命中延迟 | 5-10ms | <1ms | **-80~90%** |
| IndexedDB 写入事务（200句） | 4 次 | 1 次 | **-75%** |
| 语言检测调用（100句 batch） | 100 次 | 1 次 | **-99%** |
| 首字渲染延迟 | 0.3s | 0.8-1.2s | +0.5-0.9s（可接受） |

核心权衡：用约 0.5-0.9s 的首字延迟增加，换取整页完成时间 6-10s 的下降。对整页翻译场景而言是净正向。
