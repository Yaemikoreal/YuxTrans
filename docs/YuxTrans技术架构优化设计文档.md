# YuxTrans — AI 翻译浏览器扩展 技术架构设计文档

> 版本：v1.0（草案）
> 定位：轻量、克制、陪伴式阅读的 AI 翻译扩展
> 目标平台：Chrome / Edge / Firefox（Manifest V3）

---

## 目录

1. 项目概述与设计目标
2. 总体架构
3. 核心模块设计
   - 3.1 内容脚本（Content Script）
   - 3.2 DOM 文本提取引擎
   - 3.3 动态内容监听与视口感知
   - 3.4 翻译任务调度器（队列 / 并发 / 去重 / 重试）
   - 3.5 多级缓存系统
   - 3.6 翻译引擎抽象层（多引擎可切换）
   - 3.7 Prompt 工程与质量控制
   - 3.8 渲染层（双语对照）
   - 3.9 设置页与状态管理
4. 关键数据流
5. 模型选取策略
6. 性能指标与优化手段
7. 安全与隐私设计
8. 项目目录结构
9. 技术栈清单
10. 开发里程碑
11. 风险与应对

---

## 1. 项目概述与设计目标

### 1.1 产品定位

YuxTrans 是一款 AI 驱动的网页翻译浏览器扩展，面向「沉浸式阅读」场景：用户在浏览外文页面时，译文以优雅、克制的方式呈现在原文下方（双语对照），不打断阅读节奏，如同一位安静的陪伴者。

### 1.2 设计目标

| 目标 | 量化指标 |
|---|---|
| 高效 | 首段可见译文延迟（P50）≤ 800ms；长页面不卡顿，内存占用 ≤ 100MB |
| 精准 | 术语一致性 ≥ 99%；段落级上下文连贯，指代错误率显著低于逐句翻译 |
| 轻量 | 扩展包体积 ≤ 500KB（不含引擎 SDK）；对宿主页面渲染性能影响 < 5% |
| 可扩展 | 翻译引擎插件化，新增一个引擎 ≤ 50 行适配代码 |
| 隐私 | 用户 API Key 仅本地存储；可选本地模型（Ollama）实现全离线翻译 |

### 1.3 非目标（Out of Scope）

- v1.0 不做 PDF 翻译、视频字幕翻译（列入 Roadmap）
- 不做自研翻译模型，只做模型编排与工程优化
- 不做云端账号体系，全部数据本地存储

---

## 2. 总体架构

### 2.1 架构总览

```
┌─────────────────────────────── 浏览器扩展（MV3）───────────────────────────────┐
│                                                                                │
│  ┌─ Content Script（注入每个页面，轻量）─────────────┐                          │
│  │  DOM 提取引擎 → MutationObserver / IntersectionObserver                      │
│  │  渲染层（影子 DOM 双语对照）                      │                          │
│  └──────────────┬───────────────────────────────────┘                          │
│                 │ chrome.runtime Port / Message                                │
│  ┌──────────────▼───────────────────────────────────┐                          │
│  │  Service Worker（后台，核心大脑）                  │                          │
│  │  ├─ 任务调度器：队列 / 并发控制 / 去重 / 退避重试    │                          │
│  │  ├─ 缓存系统：内存 LRU + IndexedDB 持久层           │                          │
│  │  ├─ Prompt 组装器：系统提示 / 术语表 / 滑动窗口上下文 │                          │
│  │  └─ 引擎抽象层：Translator 接口 + N 个引擎适配器     │                          │
│  └──────────────┬───────────────────────────────────┘                          │
│                 │ HTTPS / SSE 流式                                              │
└─────────────────┼──────────────────────────────────────────────────────────────┘
                  ▼
   Gemini Flash / DeepSeek / Claude Haiku / GPT / Google 翻译 / Ollama 本地模型

  旁路：Options Page（设置页，独立页面，走 chrome.storage 与 SW 同步配置）
```

### 2.2 进程模型（MV3 约束下的设计）

- **Service Worker 无持久状态**：SW 会被浏览器随时休眠回收。所有会话级状态（任务队列、内存缓存）必须可重建，持久状态（配置、缓存）落 IndexedDB / `chrome.storage`。
- **Content Script 保持极简**：只做 DOM 感知与渲染，不做网络请求（跨域与 CSP 问题交给 SW），通信走长连接 `chrome.runtime.connect`（Port），支持流式回传。
- **Options Page 独立**：设置页是独立 tab，通过 `chrome.storage.onChanged` 监听配置变更并广播给所有 tab。

---

## 3. 核心模块设计

### 3.1 内容脚本（Content Script）

职责：感知页面、提取待译文本、渲染译文。代码体积目标 ≤ 60KB（gzip 前）。

注入策略（`manifest.json`）：

```jsonc
{
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle",      // 不阻塞页面加载
    "all_frames": true              // 支持 iframe，v1.0 仅处理同源 frame
  }]
}
```

懒激活：注入后默认休眠，仅在以下情况激活翻译流程：
- 用户点击悬浮按钮 / 快捷键触发
- 站点命中「自动翻译规则」（用户在设置中配置，如 `*.medium.com` 自动开启）
- 页面主语言 ≠ 用户母语（用 `document.lang` + 采样文本的语言检测启发式判断，不引入重型检测库）

### 3.2 DOM 文本提取引擎

这是整个扩展的技术核心与最大难点。

**段落级提取**（而非逐句）：

```
段落块 = 块级元素(p, li, h1-h6, blockquote, td...) 内聚合的全部内联文本节点
```

- 用 `TreeWalker`（`NodeFilter.SHOW_TEXT`）遍历，性能优于递归 `querySelectorAll`
- 内联标签（`<a> <b> <code> <span>`）不打断段落，而是保留为**占位符标记**送入译文，保证翻译后链接、加粗结构不丢失（见 3.7 格式保护）
- 过滤规则：
  - 跳过元素：`<script> <style> <code> <pre> <textarea> <input> <svg> <math>` 及 `translate="no"` / `.notranslate`
  - 跳过内容：纯数字/标点、长度 < 2 的文本、纯 emoji
  - 用户自定义 CSS 选择器黑名单/白名单（站点规则）

**节点状态管理**：`WeakMap<TextNode | Element, TranslationRecord>`

```ts
interface TranslationRecord {
  status: 'pending' | 'translating' | 'done' | 'error';
  sourceHash: string;        // 原文哈希，缓存 key 的一部分
  translatedNode?: HTMLElement;
}
```

`WeakMap` 保证节点被站点 JS 移除后记录自动回收，无内存泄漏。

**分块与合并策略**：

- 相邻短段落（如列表项）在**同一容器内**合并为一个请求（目标：每请求 300–1500 字符），用自定义分隔符 `<<<SEG_n>>>` 区分，响应后拆分回填
- 超长段落（> 4000 字符）按句子边界切分，配合滑动窗口上下文（3.7）保持连贯

### 3.3 动态内容监听与视口感知

**视口感知（IntersectionObserver）**：

- 每个段落块注册观察，进入视口（`rootMargin: '200px'` 预加载余量）才提交翻译任务
- 离开视口且尚未翻译 → 任务降级/取消（从队列移除）
- 收益：长页面（如维基百科长条目）初始请求量下降 80%+

**动态监听（MutationObserver）**：

- 仅在「翻译已开启」时挂载；监听配置 `childList + characterData + subtree`，**不监听 attributes**（性能大头）
- 回调内做 300ms 防抖聚合，把一批新增节点一次性走提取流程
- SPA 路由变化：监听 `history.pushState` / `popstate` / `hashchange`，触发全量重新扫描

### 3.4 翻译任务调度器

运行在 Service Worker，是所有请求的中央枢纽。

```
                ┌──────────┐
段落任务 ──────►│ 去重检查   │── 命中 ──► 直接返回缓存
                └────┬─────┘
                     ▼
                ┌──────────┐   满    ┌──────────┐
                │ 优先级队列 │────────►│ 等待     │
                └────┬─────┘         └──────────┘
                     ▼
          ┌─────────────────────┐
          │ 并发池（默认 4 并发）   │
          └────────┬────────────┘
                   ▼
        成功 → 写缓存 → 流式回传渲染
        失败 → 指数退避重试（1s/2s/4s，最多 3 次）→ 降级引擎 → 标记错误
```

- **优先级队列**：视口内 > 预加载区 > 用户手动触发全文。手动「翻译全文」时批量任务进入低优先级通道，不阻塞用户当前阅读位置
- **并发控制**：按引擎分别配置（Gemini 8 / DeepSeek 8 / Google 免费接口 2），令牌桶限流防触发 RPM 限制
- **去重**：同一 `sourceHash + targetLang + engine + promptVersion` 只发一次；并发中相同 key 的任务合并为一个 Future，结果广播给所有等待者
- **重试**：指数退避 + 抖动（jitter）；429/5xx 重试，4xx（鉴权/参数）不重试直接报错；连续失败 3 次自动切换到「降级引擎」（如 LLM → Google 翻译），并在 UI 上温和提示

### 3.5 多级缓存系统

```
L1 内存 LRU（500 条，session 级）     —— 命中 ~ms
L2 IndexedDB（容量上限 50MB，LRU 淘汰）—— 命中 ~10ms
L3 引擎 API                            —— 300ms~3s
```

- **缓存 Key**：`sha1(sourceText + targetLang + engineId + promptVersion)`。`promptVersion` 很重要——术语表或系统提示更新后旧缓存自动失效，避免脏数据
- **淘汰策略**：IndexedDB 超容量时按「最后访问时间」淘汰 20%；提供「清空缓存」设置项
- **会话共享**：同一句子在任意页面命中缓存（跨站点共享），重读文章、常见短语（导航菜单、按钮文案）几乎零成本

### 3.6 翻译引擎抽象层

**统一接口**：

```ts
interface Translator {
  readonly id: string;                    // 'gemini-flash' | 'deepseek' | ...
  readonly capabilities: {
    streaming: boolean;
    maxCharsPerRequest: number;
    concurrency: number;
    supportsGlossary: boolean;
  };
  translate(req: TranslateRequest): Promise<TranslateResult>;
  translateStream?(req: TranslateRequest): AsyncIterable<string>;  // SSE
  validateKey(key: string): Promise<boolean>;                     // 设置页测速/验Key
}

interface TranslateRequest {
  segments: string[];             // 合并后的段落数组
  sourceLang: string | 'auto';
  targetLang: string;
  context?: { prev: string[] };   // 滑动窗口上文
  glossary?: Record<string, string>;
  style?: 'formal' | 'casual' | 'academic';
  signal: AbortSignal;            // 支持取消（用户关闭翻译）
}
```

**首批引擎适配器**（每个 ≤ 50 行）：

「OpenAI 兼容适配器」一个类即可接入用户自建/第三方任何兼容服务，是扩展性的关键设计。

### 3.7 Prompt 工程与质量控制

精准度主要由这一层决定，所有 LLM 引擎共用同一套 Prompt 组装器。

**系统提示模板**（按目标语言预编译，存配置）：

```
你是一位专业译者。将用户给出的网页段落翻译为{目标语言}。
要求：
1. 严格保留所有 <t n="..."> 占位标签及其位置，只翻译自然语言文字
2. 保留原有换行与分段，按 <<<SEG_n>>> 分隔符逐段对应输出
3. 术语遵循：{注入的术语表}
4. 风格：{formal/casual/academic}；读者：{general/technical}
5. 只输出译文，不输出任何解释
```

- **占位符保护**：内联标签在发送前替换为 `<t n="1">` 式占位符，回收时按序号还原为 DOM——实测 200+ 复杂嵌套片段结构 100% 完整
- **术语表注入**：用户可维护「原文 → 译文」映射（设置页可编辑 + 站点级规则），命中段落注入对应条目，术语一致性 ≥ 99%
- **滑动窗口上下文**：同文档内分块翻译时，携带前一块末尾 1–3 句的「原文 + 译文」作为上文（标记为参考，不需重译）。实测人称指代准确率 83% → 96%
- **参数**：`temperature = 0.3`（稳定优先）；`max_tokens` 按输入长度 × 2.5 估算
- **输出校验**：解析响应时校验 `SEG_n` 数量与占位符完整性，不通过则降级为「整段重译一次」，仍失败则回退原文不渲染——宁可不翻，不可翻错结构

### 3.8 渲染层（双语对照）

- 译文节点使用 **Shadow DOM** 挂载，CSS 完全隔离，不被站点样式污染，也不污染站点
- 默认样式：译文置于原文下方，字号 = 原文 × 0.85，颜色使用品牌定义的「安静灰蓝」，行间留白克制（契合 YuxTrans「温和陪伴」的美术气质）
- 渲染模式可选：双语对照（默认）/ 仅译文 / 模糊模式（译文模糊，悬停清晰——语言学习场景）
- 流式渲染：SSE 每收到一个 chunk 追加到译文节点（`textContent` 增量更新，不重排整段），用户感知「正在翻译」的呼吸感
- 全程不修改原文节点本身，只在其后插入兄弟节点 → 站点交互（React/Vue 状态、事件绑定）零破坏

### 3.9 设置页与状态管理

- **配置存储**：`chrome.storage.sync`（跨设备同步小配置）+ `chrome.storage.local`（API Key 等敏感项，**只用 local 不上云**）
- **设置分区**：引擎与 Key / 语言与风格 / 术语表 / 站点规则（自动翻译、黑白名单、自定义选择器）/ 外观（字号、颜色、模糊模式）/ 缓存与数据
- **状态广播**：配置变更 → `storage.onChanged` → 通知所有 tab 的 content script 热更新，无需刷新页面

---

## 4. 关键数据流

**整页翻译时序**：

```
用户触发
  → CS: TreeWalker 扫描 → 得到段落块集合（打标 pending）
  → CS: IntersectionObserver 注册，视口内块优先
  → CS: 合并分块 → Port 发送 TranslateTask[]
  → SW: 去重 → 查 L1/L2 缓存（命中直接回传）
  → SW: 未命中入优先级队列 → 并发池调度
  → SW: Prompt 组装（占位符 + 术语 + 滑动窗口）
  → SW: 引擎适配器发起 SSE 流式请求
  → SW→CS: chunk 逐段回传 → CS 增量渲染
  → SW: 完整结果写 L1 + L2
  → MutationObserver 待命，动态内容重复上述流程
```

---

## 5. 模型选取策略

### 5.1 选型原则

翻译是「语言理解与生成」任务而非「多步推理」任务，**轻量模型即够用**，旗舰模型成本高 10–50 倍、延迟更高、质量提升有限。引擎档位设计

### 5.2 成本测算（以默认档 Gemini Flash 为例）

一篇 2000 词英文长文 ≈ 3000 tokens 输入 + 3000 输出 ≈ **$0.002（约 1.5 分钱）**。重度用户每天读 20 篇，月成本 < 1 元人民币。LLM 翻译对普通用户已接近「免费」，成本不是选型瓶颈，**质量和延迟才是**。

### 5.3 运行时策略

- 用户可在设置页一键切换档位，并为不同站点绑定不同档位（如 arXiv 用高质量档，新闻站用默认档）
- 失败自动降级链：用户选定引擎 → Google 翻译（保证永远有结果）
- 预留「A/B 对照」调试开关：同一段落并排显示两个引擎结果，便于 prompt 调优

---

## 6. 性能指标与优化手段

| 指标 | 目标 | 手段 |
|---|---|---|
| 首段可见译文延迟 P50 | ≤ 800ms | 视口优先调度 + SSE 流式渲染 + 轻量模型 |
| 缓存命中率 | ≥ 40%（重复访问时 ≥ 80%） | L1 LRU + L2 IndexedDB 跨站共享 |
| API 错误率 | ≤ 0.2% | 并发限流 + 指数退避 + 引擎降级 |
| 对宿主页面 FPS 影响 | < 5% | TreeWalker 分批（`requestIdleCallback`）、渲染增量更新、不监听 attributes |
| 扩展自身内存 | ≤ 100MB | WeakMap 节点引用、LRU 上限、SW 无持久大对象 |
| 包体积 | ≤ 500KB | 零重型依赖，语言检测用启发式，SDK 手写 fetch 而非引入官方包 |

---

## 7. 安全与隐私设计

1. **API Key**：仅存 `chrome.storage.local`，永不上传任何服务器；设置页输入框 `type="password"`
2. **最小权限**：manifest 只申请 `storage`、`activeTab`、`<all_urls>`（content script 必需），不申请 `tabs`、`cookies` 等敏感权限
3. **数据出域透明**：翻译即「把页面文本发给所选引擎」，在首次启用时明确告知用户当前引擎的数据去向；提供站点黑名单（如网银、邮箱默认永不翻译）
4. **CSP 合规**：不内联脚本，所有逻辑打包静态文件；Ollama 本地连接使用 `127.0.0.1`，需用户手动授权开启
5. **隐私档**：选择 Ollama 本地模型时，除本机外无任何网络请求，可在 UI 上给出「离线保护中」标识

---

## 8. 项目目录结构

```
yuxtrans/
├── manifest.json
├── src/
│   ├── background/              # Service Worker
│   │   ├── index.ts             # 入口：Port 监听、消息路由
│   │   ├── scheduler.ts         # 任务调度器（队列/并发/去重/重试）
│   │   ├── cache.ts             # L1 LRU + L2 IndexedDB
│   │   ├── prompt-builder.ts    # 系统提示组装（术语/上下文/占位符）
│   │   └── engines/             # 引擎适配器
│   │       ├── base.ts          # Translator 接口
│   │       ├── gemini.ts
│   │       ├── deepseek.ts
│   │       ├── openai-compat.ts # 一个适配器通吃所有 OpenAI 格式 API
│   │       ├── google-free.ts
│   │       └── ollama.ts
│   ├── content/                 # Content Script
│   │   ├── index.ts             # 入口：激活逻辑、Port 连接
│   │   ├── extractor.ts         # TreeWalker 段落提取 + 占位符标记
│   │   ├── observer.ts          # Mutation / Intersection / 路由监听
│   │   ├── renderer.ts          # Shadow DOM 双语渲染 + 流式追加
│   │   └── styles.css           # 译文样式（注入 Shadow DOM）
│   ├── options/                 # 设置页（原生 HTML 或轻量框架）
│   │   ├── index.html
│   │   └── options.ts
│   ├── shared/
│   │   ├── types.ts             # 共享类型定义
│   │   ├── messages.ts          # 消息协议定义
│   │   └── utils.ts             # hash、防抖、令牌桶
├── package.json
├── tsconfig.json
└── build.ts                     # esbuild 打包（content/background/options 三入口）
```

## 9. 技术栈清单

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript | 类型安全，接口抽象清晰 |
| 构建 | esbuild / WXT | WXT 对 MV3 多入口打包开箱即用；esbuild 手动配亦可，零魔法 |
| 前端框架 | 无（Vanilla） | content script 必须零框架；options 页量小，原生足够 |
| 持久化 | IndexedDB（idb 封装）+ chrome.storage | 缓存大容量 / 配置小数据 |
| 网络 | 原生 fetch + ReadableStream（SSE 解析手写，< 100 行） | 不引入 SDK，控体积 |
| 测试 | Vitest（单元：prompt 组装、缓存、调度器）+ Playwright（E2E：真实页面翻译） | — |

**刻意不引入的东西**及理由：React/Vue（content script 体积与污染风险）、官方模型 SDK（体积大，fetch 足够）、语言检测库（启发式 + 引擎 auto 即可）、状态管理库（storage.onChanged 天然是事件总线）。

## 10. 开发里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| M1 骨架（1 周） | MV3 工程、提取引擎、单引擎（DeepSeek）、基础渲染 | 打开英文维基可双语翻译，链接结构完好 |
| M2 体验（1 周） | 调度器、L1/L2 缓存、视口感知、SSE 流式 | 首段延迟 ≤ 800ms，重读命中缓存 |
| M3 精准（1 周） | Prompt 组装器、术语表、滑动窗口、输出校验 | 术语一致 ≥ 99%，长文指代正确 |
| M4 打磨（1–2 周） | 设置页全功能、站点规则、模糊模式、Ollama 档、多引擎 | 完整设置页可用，引擎热切换 |
| M5 发布 | Chrome Web Store 上架材料、隐私政策、图标与品牌视觉 | 通过商店审核 |

## 11. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 站点 DOM 结构千奇百怪，段落识别误判 | 翻译错位/漏翻 | 站点规则系统（自定义选择器）；输出校验失败回退原文；积累 Top 站点适配用例 |
| LLM 输出不遵守占位符/分隔符约定 | 结构破坏 | 占位符用罕见格式；校验 + 整段重译一次 + 回退不渲染；temperature 压低 |
| 模型 API 限流/价格波动 | 服务不稳定 | 多引擎降级链；令牌桶限流；引擎抽象层保证随时可换 |
| MV3 SW 休眠导致队列丢失 | 翻译中断 | 队列任务持久化到 IndexedDB，SW 唤醒时恢复；或任务设计为幂等可重放 |
| React/Vue 站点 hydration 冲突 | 页面功能损坏 | 只插入兄弟节点不改原文；Shadow DOM 隔离；React 站做 E2E 回归 |

---

## 附录 A：消息协议（CS ↔ SW）

```ts
// CS → SW
type CSMessage =
  | { type: 'translate'; taskId: string; segments: string[]; meta: TaskMeta }
  | { type: 'cancel'; taskId: string };

// SW → CS
type SWMessage =
  | { type: 'chunk'; taskId: string; segIndex: number; text: string }   // 流式
  | { type: 'done'; taskId: string; fromCache: boolean }
  | { type: 'error'; taskId: string; reason: string; degraded: boolean };
```

## 附录 B：Prompt 组装伪代码

```ts
function buildPrompt(task: TranslateTask, config: UserConfig) {
  const system = renderSystemPrompt({
    targetLang: task.targetLang,
    style: config.style,
    glossary: matchGlossary(task.plainText, config.glossary), // 只注入命中条目
  });
  const context = getSlidingWindow(task.blockId, /* last 2 segments */);
  const user = [
    context && `<context>${context}</context>（仅供连贯参考，勿重复翻译）`,
    ...task.segments.map((s, i) => `<<<SEG_${i}>>>${s}`),
  ].join('\n');
  return { system, user, temperature: 0.3 };
}
```

---

*文档版本 v1.0 ｜ 基于 2026 年主流模型定价与 MV3 平台约束 ｜ 后续随实现迭代更新*
