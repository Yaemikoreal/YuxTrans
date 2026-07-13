# YuxTrans 浏览器扩展 — 优化路线图

> 基于现状分析，按优先级分三层推进：先稳基础（P0），再提性能（P2），最后拓场景（P3）。

---

## P0：稳定性与基础体验（1–2 周）

> 目标：把基本盘稳住，消灭影响核心使用的问题。

### 1. Service Worker 休眠 + IndexedDB 断开

**现状**：MV3 的 Service Worker 30s 空闲即休眠，唤醒后 IndexedDB 连接断开，需要重新初始化。

**修复方案**：

- [ ] **SW 端统一封装 DB 访问层**
  - 抽象 `CachedbClient` 对象，所有 IndexedDB 操作通过它走
  - 内部维护 `dbReady` Promise，每次操作前 `await dbReady`
  - 捕获 `InvalidStateError` / 连接已关闭 → 自动重新打开 DB 并更新 `dbReady`
  - 关键：不用事件回调里的 `idb.request.onsuccess`，统一 Promise 封装

- [ ] **最小保活策略**（只在有活跃翻译时保活）
  - content.js / popup 有翻译请求时，发 `keepalive` 消息给 SW
  - SW 记录 `lastActivityTime`
  - 用 `chrome.alarms.create('yuxtrans-keepalive', { periodInMinutes: 0.45 })` 定时检查
  - 仅当 `lastActivityTime < 25s` 时重新初始化 DB，否则不做额外操作

- [ ] **UI 柔和提示**
  - popup / content 遇到 DB 不可用时，SW 侧负责重连后回包
  - 2s 内未恢复 → 展示"正在恢复翻译服务…"小提示，而非直接报错

**涉及文件**：`background.js`（openDatabase / loadCacheFromDB / saveCacheToDB）

---

### 2. 友好错误提示

**现状**：API 错误直接抛技术信息（`Failed to fetch`、`HTTP 401`）给用户。

**修复方案**：

- [ ] **定义 YuxTransError 错误体系**
  ```javascript
  class YuxTransError extends Error {
    constructor(code, userMessage, debugMessage) {
      super(debugMessage);
      this.code = code;         // NETWORK / AUTH / RATE_LIMIT / LOCAL_MODEL / UNKNOWN
      this.userMessage = userMessage;
    }
  }
  ```

- [ ] **错误分类映射**
  | 场景 | code | 用户提示 |
  |------|------|----------|
  | 网络断开 | NETWORK | 网络连接失败，请检查网络或代理设置 |
  | 401/403 | AUTH | API Key 无效或权限不足，请检查服务商配置 |
  | 429 | RATE_LIMIT | 请求过于频繁，请稍后重试 |
  | Ollama 连不上 | LOCAL_MODEL | 无法连接本地模型服务，请确认 Ollama 已启动 |
  | 超时 | TIMEOUT | 请求超时，请检查网络或更换模型 |
  | 其他 | UNKNOWN | 翻译服务暂时不可用，请稍后重试 |

- [ ] **content.js / popup.js 只展示 `userMessage`**
  - 控制台输出完整 `debugMessage` 方便排查

**涉及文件**：`background.js`（translateWithCloud / translateWithStream / testConnection）、`content.js`、`popup.js`

---

### 3. 缓存大小设置优化

**现状**：缓存配置单位不直观，用户难以理解实际容量含义。

**修复方案**：

- [ ] **UI 改进**
  - 缓存容量改为 `<input type="range" min="50" max="2000" step="50">` + 数字展示
  - 旁边实时显示"大约可缓存 N 条翻译"

- [ ] **使用量可视化**
  - 进度条：当前使用量 / 总容量
  - 超过 80% 时变色提示"缓存接近上限，旧数据将被自动清理"

**涉及文件**：`options.html`、`options.js`

---

## P1：性能与工程化（2–4 周）

> 目标：提升翻译效率、代码可维护性和开发体验。

### 4. 缓存预热与淘汰策略优化

- [ ] **缓存预热**
  - SW 启动时从 `BUILTIN_CACHE` 预热 300+ 常用词汇（已实现）
  - 扩展：支持用户自定义预热词表（导入 CSV / JSON）
  - 对常用站点（文档站、新闻站）预置示例文本翻译

- [ ] **更精细的 LRU/LFU 混合淘汰**
  - 当前：纯 LRU + 固定容量
  - 增加 `accessCount` + `lastAccessTime` 字段
  - 淘汰时综合排序：`score = recency * 0.6 + frequency * 0.4`
  - 热词长期保留，冷词优先淘汰

**涉及文件**：`background.js`（cache 相关函数）

---

### 5. 路由与并发策略优化

- [ ] **并发数可配置**
  - 设置中增加"并发请求数（1–20）"与"单批文本数（1–50）"
  - 默认：并发 5，批次 10
  - Groq 可调到 15–20，DeepSeek/OpenAI 5–10

- [ ] **供应商感知路由**
  - 维护供应商元数据：`latency`、`errorRate`、`rateLimitRemaining`
  - 路由时优先选择低延迟 + 低错误率 + 充足配额的供应商
  - 本地模型始终优先，但连续 5 次失败则暂时降级

- [ ] **按文本长度选模型**
  - 短文本（< 100 字）→ 小模型（快、便宜）
  - 长文本 / 整页翻译 → 大模型（质量好）
  - router 中增加 `chooseModel(textLength)` 逻辑

**涉及文件**：`background.js`（rateLimitState / translateBatchInternal）、`content.js`

---

### 6. 前端工程化

- [ ] **引入轻量构建（esbuild / Vite）**
  - 打包 content.js / popup.js / options.js
  - 支持 ES6+ 模块引入
  - manifest.json 引用构建产物

- [ ] **开发/生产配置分离**
  - 开发：sourceMap + 热更新
  - 生产：压缩、Tree-shaking、去除 console.log

- [ ] **添加测试**
  - 对 `background.js` 核心逻辑写单元测试
  - 覆盖：缓存读写、错误处理、配置加载、模型管理

**涉及文件**：新增 `vite.config.js` / `package.json` 构建脚本

---

## P2：翻译质量与场景拓展（持续迭代）

> 目标：从"能用"到"好用、爱用"。

### 7. 翻译人格与 Prompt 优化

- [ ] **结构化 Prompt 模板**
  - 每个人格拆成：角色设定 + 术语表 + 风格约束 + 输出格式
  - 支持用户在设置中编辑模板，导入/导出 JSON

- [ ] **自动术语表**
  - 用户上传"术语表 CSV（原文, 译文）"
  - 翻译时优先匹配术语表，未匹配再走模型

- [ ] **A/B 测试**
  - 同一源文本用两种 Prompt/模型翻译
  - 用户选择"更喜欢 A/B"，后台统计胜率

---

### 8. 站点规则与翻译模式

- [ ] **站点规则配置**
  - 按域名设置：是否自动整页翻译、默认人格/模型、忽略区域
  - 规则可导入/导出，社区共享"规则包"

- [ ] **更多翻译模式**
  - 对照模式：左右/上下并排原文与译文
  - 悬浮提示模式：hover 显示译文，不改变页面结构
  - 摘要模式：长文先做摘要翻译，再提供全文

---

### 9. 多端与多场景

- [ ] **移动端浏览器支持**
  - Firefox Android 适配
  - 底部工具栏 + 侧滑面板

- [ ] **桌面端小工具**
  - 利用 `yuxtrans/desktop`，做系统托盘小工具
  - 全局快捷键呼出输入框，翻译剪贴板内容

- [ ] **CLI / SDK**
  - `yuxtrans translate "text"` CLI
  - Python SDK，方便其它项目调用

---

### 10. 安全与隐私

- [ ] **完全离线模式**
  - 设置中增加"离线模式"开关
  - 仅允许本地模型 + 缓存，禁止云端请求

- [ ] **API Key 加密存储**
  - 使用 `crypto.subtle` 加密后存储
  - 支持主密码机制

- [ ] **审计日志**
  - 记录：时间、供应商、文本哈希（不存原文）、是否命中缓存
  - 用户可导出

---

## 任务跟踪

| # | 任务 | 优先级 | 状态 | 关联文件 |
|---|------|--------|------|----------|
| 1 | SW 休眠 + DB 断开修复 | P0 | ⬜ 待开始 | background.js |
| 2 | 友好错误提示体系 | P0 | ⬜ 待开始 | background.js, content.js, popup.js |
| 3 | 缓存设置 UI 优化 | P0 | ⬜ 待开始 | options.html, options.js |
| 4 | 缓存预热与淘汰优化 | P1 | ⬜ 待开始 | background.js |
| 5 | 路由与并发策略 | P1 | ⬜ 待开始 | background.js, content.js |
| 6 | 前端工程化构建 | P1 | ⬜ 待开始 | vite.config.js, package.json |
| 7 | Prompt 模板与术语表 | P2 | ⬜ 待开始 | background.js, options.js |
| 8 | 站点规则配置 | P2 | ⬜ 待开始 | background.js, content.js, options.js |
| 9 | 多端支持 | P2 | ⬜ 待开始 | — |
| 10 | 安全与隐私增强 | P2 | ⬜ 待开始 | background.js |
