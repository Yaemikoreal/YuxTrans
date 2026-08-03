# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> 依据 `docs/PROJECT_EVALUATION.md`（2026-07-27 评判报告）执行的阶段一「固本」：清零 P0 安全与 P1 功能正确性问题，补齐核心测试，建立最小 CI。单测 91 → **142 项全绿**。

### Security

- **getConfig / getProfiles 响应脱敏** — 不再回吐明文 API Key，改返回 `hasApiKey` 标记；options 表单不回显 Key，留空保存保留原 Key；「测试连接 / 获取模型」空 Key 时由 SW 回退已存档案 Key。
- **消息入口 sender 校验** — `onMessage` 拒绝 `sender.id !== chrome.runtime.id` 的外部调用方。
- **options 页自 XSS 修复** — 档案/模型名、错误信息、请求日志等多处用户可控字段统一经 `escapeHtml`（下沉至 `lib/product-helpers.js` 单一来源）后拼入 innerHTML；附载荷级回归测试。
- **manifest 主机权限收窄** — `http://localhost:*/*` → `http://localhost:11434/*`（Ollama 默认端口；自定义端点仍走 optional_host_permissions 按需授权）。

### Added

- **拉丁语系语言检测** — `lib/sw/lang.js` 新增 en/fr/de/es/pt/it 停用词打分（短文本保守兜底 en），修复目标语言为英语时法/德/西/葡/意文本被误判「已是目标语言」而跳过翻译的缺陷。
- **SW 全局并发闸门** — `lib/sw/scheduler.js` 新增 `createConcurrencyGate`：自适应并发上限（1~10）对全部出站翻译请求（云翻/流式/批量）真实生效，按「划词 > 视口 > 批次」优先级排队；abort/出错经 finally 释放槽位。
- **最小 CI** — `.github/workflows/ci.yml`：push/PR 触发 `npm ci` + `npm test` + manifest MV3 校验 + ESLint。
- **ESLint 静态守门（D3）** — `eslint.config.mjs`（flat config）：`no-undef` 与 `no-unsanitized/*` 为 error（后者防 S2 类 options 页 XSS 回归），其余推荐规则以 warn 接入逐步收紧；17 处已验证安全的 innerHTML（静态模板或已 `escapeHtml`）逐点带理由豁免；`npm run lint` 接入 CI。
- **Playwright E2E 冒烟（D3）** — `tests-e2e/smoke.spec.mjs`：真实 Chromium 加载 MV3 扩展 → 本地 HTTP 测试页 → 模拟 Ctrl+划选 → 断言划词浮窗出现且结构完整（不依赖翻译后端）。`npm run test:e2e`（headed 模式；Linux 需 xvfb）。
- **修饰键+划选触发模式** — `triggerMode` 新增 `modifier`（按住修饰键划选才翻译，松手瞬间校验，不拦截任何原生快捷键）；`selectionModifier` 支持 Ctrl/Alt/Shift，默认 Ctrl；输入框划选同门槛。macOS Ctrl+点击等效右键、Shift 与扩展选区冲突已在设置 UI 注明。

### Changed

- **content 侧魔法数字集中（D1c）** — 新建 `lib/content/constants.js`（`YuxContentConsts`，浏览器/Node 双兼容）：流式超时 65s、批量超时 130s、看门狗 70s、悬停延迟 300ms、增量防抖 500ms、视口预加载 200px/回退 2s、布局分批 200 等 11 项调优参数收编；manifest 注入顺序将其置于 content.js 之前。
- **content.js 按功能域拆分（D1b）** — 单类 2917 行拆为 7 文件：核心 `content.js`（类与共享机制，362 行）+ `lib/content/selection.js`（划词浮窗 630）/ `dict.js`（词典 178）/ `hover.js`（悬停 210）/ `input.js`（输入框 58）/ `page.js`（整页与动态增量 1533）/ `init.js`（引导 13）；各域经 `Object.assign(YuxTransContent.prototype, …)` 挂接（浏览器/Node 双兼容 IIFE），`manifest.json` content_scripts 按序注入 8 文件；86 个方法对账无遗漏，逐字比对 PASS，E2E 真实浏览器验证多文件注入可用。
- **消息路由表驱动化（D1a）** — `background.js` 的 `onMessage` 440+ 行 if-else 链重构为监听器内 `messageHandlers` 表分发（25 个 handler 一一对应 action），分支体逐字搬移（脚本逐行比对验证）；`lib/sw/message-actions.js` 注册表与处理器集合核对，发现 `getUsageStats`/`testProvider` 两个注册项无处理器且无发送方（历史残留，未改注册表）。
- **默认触发模式变更** — 新安装默认由「选中即译(auto)」改为「修饰键+划选(modifier)」；老用户已存配置不受影响。`resolveTriggerAction` 未知值兜底随新默认改为 `modifier`。

### Fixed

- **交互功能冲突批量修复**（依据 `docs/superpowers/specs/2026-07-28-interaction-conflict-fixes-design.md`，13 项修复 + 2 项文档化）：
  - **#4 浮窗串台** — 划词/词典请求改用唯一 requestId（`popup-<递增>`），SW 在 translate/lookupWord/translateStream 响应中原样透传；content 维护 `requestId → 浮窗` 映射，响应与流式 chunk 路由回捕获的浮窗，浮窗已销毁则丢弃并清理映射；对照浮窗响应同样校验存活。修复翻译在途时 pin 或快速连划导致旧响应写进新浮窗。
  - **#11 在途标志拆分** — `isTranslating`（划词）与 `isDictLookingUp`（词典）独立，互不静默吞操作；各配 70s 看门狗（对齐流式 65s 超时），SW 不回包时复位并告警，不再永久卡死。
  - **#6 悬停/划选同键冲突** — 鼠标按键按下（划选/拖拽中）不触发悬停翻译；options 在 hoverTranslate 开 + modifier 模式 + 两键相同时显示同键警告（不阻断保存）。
  - **#1 双击双触发** — 双击（`e.detail >= 2`）且双击查词开启且选区为单词时，划词链路跳过，交由 dblclick 统一查词典。
  - **#2 icon 模式浮钮残留** — `_handleDblClick` 与 `showPopup` 开头清除悬浮按钮。
  - **#5 对照浮窗无限累积** — 对照模式自动 pin 改为替换语义：新对照前移除上一次自动 pin 的主浮窗（手动 pin 不动）。
  - **#14 输入框翻译无视 triggerMode** — input 分支补齐模式语义：contextMenu 不弹窗、icon 出浮钮（保留插入能力）、auto 直译、modifier 维持修饰键门槛。
  - **#17 悬停翻译绕过站点黑白名单** — hover 入口补 `isSiteAllowed()` 检查。
  - **#13 动态增量占用整页标志** — `_processAddedNodes` 改用独立 `_dynamicTranslating`，消除「增量翻译中按 Ctrl+Shift+P 被当作取消整页」；重试/取消/批量 worker 等读取点同步对齐。
  - **#8A/#8B/#8C** — 整页收集跳过悬停引导与页面 toast；译文区域（悬停译文/双语/流式临时）的再次划选不触发翻译；悬停翻译失败清除 done 标记，允许再次悬停重试。
  - **#3 mousedown 误关浮窗** — 点击整页控制条/悬停译文/悬停引导不再关闭浮窗。
  - **#9 MutationObserver 自触发** — 新增节点全部位于自有 UI（`.yuxtrans-*`）内时直接忽略，不进防抖与全页扫描。
  - **#15/#16 文档化** — options 双击查词行补充「右键菜单模式下仍生效；输入框内请划选单词」。
- **缓存校验死规则修复（D4）** — `SHORT_SOURCE_THRESHOLD` 10 → 24（须大于 `MIN_CACHE_SOURCE_LENGTH` 12 才可达），`length_ratio` / `entity_drift` 两条坏缓存拦截规则对 12~24 字符短源文恢复生效；对应用例由「断言不可达」改为「断言拦截」，并新增 too_short 独立用例。
- **flush 取舍文档化（D5）** — 缓存落盘注释与 CONTEXT.md 明确「onSuspend 兜底写不被平台保证完成、可能丢最近几条缓存」为已知取舍，避免后续误当 bug 修。

### Added（issue #54 / #48）

- **整页翻译控制挂耳（#54）** — 整页控制条点「关闭」不再销毁，收起为贴右缘的竖排挂耳 Tab（`.yuxtrans-side-tab`，书房衬纸风格，尊重 prefers-reduced-motion），点击可原状态重新展开；「恢复原文」时控制条与挂耳一并移除。
- **Popup 容器圆角（#48）** — popup 卡片 `border-radius: var(--yxt-radius-xl)` + 外缘细描边；html 根背景与纸底同色，避免 Chrome popup 窗口透明白角。
- **杂项** — `showStatus('info')` 补 `.status.info` 样式（「下载已取消」提示可见）；模型拉取 `data.models` 分支补字母序；清理 options.js 陈旧注释与磁盘 `.pyc` 残留。
- **版本更新检测改用 `chrome.alarms`** — 修复 SW 休眠后 `setInterval` 消失导致检查失效。
- **`ensureInitialized` 并发竞态** — 共享 Promise 模式，SW 冷启动并发消息不再重复全量加载；失败可重试。
- **僵尸翻译会话清理** — 会话带创建时间戳，超过 30 分钟自动 abort 并移出 Map。
- **`isNewerVersion` 支持预发布版本号**（剥离 `-beta.x` 再比较）；`testProviderConnection` 空端点前置校验；`fallbackBatchItems` 末片判断改下标遍历。
- **死代码清理** — 删除退化的 `flipTargetIfSameLanguage` 与 background 内重复的 `SCRIPT_RANGES` fallback；`CACHE_KEY_VERSION` 兜底值对齐 `'v3'`。

### Performance

- **整页收集两阶段布局读取（Q1）** — `collectTextNodes` 改异步：TreeWalker 先纯收集（不触发布局），再每 200 节点一批读取 `getBoundingClientRect`，批间 `scheduler.yield`/`setTimeout(0)` 让出主线程；大页面整页翻译启动不再长卡顿。调用方（整页主流程 / 动态增量）同步 await 化。
- **动态增量翻译只扫新增子树（Q2）** — `_onMutations` 收集防抖窗口内的新增子树根，`_processAddedNodes` 仅对这些子树调 `collectTextNodes`（嵌套根去重、断连根跳过），取代整页重扫 body；无限滚动/SPA 大页面下从 O(页面) 降为 O(新增子树)。
- **缓存冷热两级（Q3）** — 内存热缓存限 32MB LRU，冷数据留 IndexedDB；`getFromCache` 异步化，内存未命中单键回查 DB 并提升为热条目；对外缓存统计改为全量口径（热+冷）。修复加载时 LRU 顺序倒置（新→旧直接插入导致裁剪先删最新）的既有 bug；用户限额（总量）硬保证由启动加载裁剪提供。SW 唤醒不再把整库（最高 200MB）一次性读入内存。

### Tests

- 新增 `cache-lazy.test.js`（4 项）：Q3 冷数据回查提升、旧版本冷数据拒绝、DB miss、写入统计与立即命中；`mock-chrome.js` IndexedDB mock 升级（Map 按键存储、可用的 get/put/delete、事务 oncomplete 触发、可选持久化单例 `__enablePersistence`）。
- 新增 `background-coverage.test.js`（23 项）：`validateCacheEntry` 全规则正反例、批量翻译降级链（直解/代码块/正则/sanity check/单句补全重试上限）、自适应限速与 429 冷却恢复。
- 新增 `concurrency-gate.test.js`（7 项）：闸门并发上限、动态限速即时生效、abort/出错不泄漏槽位。
- 新增 `options-security.test.js`（8 项）：`escapeHtml` 载荷断言 + 源码级防回归。
- 补充 sender 校验、配置脱敏、初始化竞态、僵尸会话等用例；`mock-chrome.js` 增加 `runtime.id` 与 `alarms` mock。
- 已知记录（未改逻辑，测试中标注）：`validateCacheEntry` 的 `length_ratio` 与 `entity_drift` 规则在当前阈值（10 < 12）下不可达，属待决策的实现层疑点。

### User Experience（使用者视角优化）

- **快捷键冲突修复** - `Ctrl+Shift+T`（与 Chrome「恢复关闭标签页」冲突）/ `Ctrl+Shift+P`（与 DevTools 命令面板冲突）改为 `Alt+T`（划词）/ `Alt+P`（整页），macOS 统一用相同组合（不再占用 `⌘` 键）。
- **README 同步默认触发模式** - 文档「用法」段由「选中后弹出」更正为「修饰键 + 划选」（v0.5.0 后新默认），消除新用户「划选后无浮窗」的困惑。
- **版本号升级** - manifest 由 `0.5.0` 升至 `0.6.0`，与 Unreleased 代码变更对齐。
- **首次安装引导补全 Ollama 安装链接** - 引导第 2 步本地路径检测到 Ollama 不可用时，提供「前往 Ollama 官网下载」按钮，不再只给出命令行文案。
- **首次安装引导补全供应商 Key 申请链接** - 引导第 2 步云端路径各供应商下拉项标注「Key 申请地址」，降低「不知道去哪拿 Key」的卡点。
- **划词浮窗工具栏图标化** - 钉住 / 复制 / 差译按钮由纯文字升级为图标 + tooltip，提升核心功能的可发现性。

## [0.5.0] - 2026-07-24

> **稳定版（Stable）** — 浏览器扩展为唯一产品形态；相对 0.4.1 完成阅读交互增强、整页流式与配额治理、设置页信息架构重构、可自定义风格提示词与发布前质量门禁。建议从 `v0.5.0-beta.1` 升级至本版本。  
> 自动化验证：`npm test` **91 pass / 0 fail**（双跑一致）；MV3 结构与 Options 五模块门禁通过。

### Highlights（本版一览）

1. **阅读交互升级（F1–F8）** — 悬停译段、单词词典、原文弱化/模糊、浮窗钉住与双档案对照、输入框回填、正文区识别、谷歌免 Key、Ollama 分档推荐。
2. **整页翻译更省、更可控** — 段落级 SSE 流式渲染、会话取消 abort、视口优先（belowFold）、同 key 去重调度、批量滑动窗口上下文。
3. **设置页可维护** — 五模块顶栏 + 分栏保存；风格提示词可编辑/恢复默认；书房氛围层与分区点缀色。
4. **工程收敛** — Service Worker `lib/sw/*` 纯函数拆分；移除 Python 包与桌面端；单测覆盖核心路径；ADR 0005 记录 Options IA。

### Added

#### 阅读与交互（F1–F8）

- **F1 悬停段落翻译** — 修饰键（默认 Alt，可选 Ctrl）+ 悬停段落，300ms 后在段落后插入译文；描边提示、关闭、已译不重复；`hoverTranslate` / `hoverModifier`。
- **F2 单词词典模式** — 划词/双击单词出词典卡片（音标 / 词性 / 义项 / 双语例句）；`lookupWord` + 独立 `dict` 缓存键；`isSingleWord` / 严格 JSON prompt。
- **F3 译文显示样式** — 整页原文 `normal` / `fade` / `blur`（模糊可悬停还原）；`originalStyle` 实时生效。
- **F4 浮窗钉住** — 钉住后不被新划词覆盖，支持多浮窗对照。
- **F4b 双档案对照** — `translateWithProfile` 用对照档案再译并排展示；`compareProfileId`。
- **F5 输入框翻译** — 翻译 input/textarea 选区并可「插入」回填（触发 `input` 事件）。
- **F6 正文区域识别** — 整页优先正文根，跳过导航/侧栏/页脚。
- **F7 谷歌免费翻译** — `google` provider（免 Key）；manifest `host_permissions` 同步。
- **F8 Ollama 推荐模型分档** — 最快 / 推荐 / 最佳质量；`setup-ollama.bat/.sh` 参数化模型名。
- **配置实时同步** — content 监听 `chrome.storage.onChanged`，设置保存后无需刷页。

#### 整页 / 流式 / 配额

- **整页流式翻译** — `enableStreaming` 开启时按段落 SSE 边译边显；失败段落可标记；重复文本去重请求。
- **整页取消链路** — `cancelTranslate` + 会话级 `AbortController`，停止后不再烧配额。
- **belowFold 视口感知** — IntersectionObserver 预加载区，入视口再译；超时回退防卡死。
- **在途去重调度器** — `lib/sw/scheduler.js`：同 cacheKey 合并一次执行（优先级：划词 > 视口 > 批次）。
- **批量滑动窗口上下文** — 上一批末尾原文+译文注入下一批（明确勿重译）。
- **内联标签占位符** — `lib/sw/placeholders.js` 提取/还原 HTML 标签。

#### 设置页与品牌

- **五模块 Options IA（ADR 0005）** — 服务档案 · 翻译偏好 · 交互与显示 · 数据与存储 · 诊断排障；可写模块分栏保存。
- **风格提示词可定制** — 按 normal/academic/technical/literary 编辑并保存；一键恢复默认；仅存与默认不同的覆盖；缓存 style 段带短哈希防误命中。
- **设置页氛围与分区点缀** — D1 缓漂光晕 + 纸纹（尊重 `prefers-reduced-motion`）；E1 低饱和分区色。
- **首次安装三步引导** — 本地/云端 → 配置 → 试译 Hello。
- **品牌 Logo** — `logo/logo.png` → icons 16/32/48/128；Popup/Options 展示。

#### 架构与可测性

- **SW 模块拆分** — `extension/lib/sw/`：`constants` / `cache-keys` / `providers-core` / `lang` / `message-actions` / `translate-core` / `scheduler` / `placeholders`。
- **product-helpers** — 触发模式、术语表、离线门禁、分栏字段表、`eventTargetClosest`、上手区可见性等纯函数 + 单测。

### Changed

- **缓存键 v3** — 编入 `PROMPT_VERSION` + 模型 slug；风格自定义后 style 段隔离。
- **词典缓存校验** — `style=dict` 跳过译文专有启发式，保留版本/非空校验。
- **书房衬纸 UI** — paper-toggle、Popup 用量折叠、整页控制条主次分离、design tokens 统一状态色/阴影。
- **交互与显示默认/进阶** — 高频五件套默认露出，低频进「更多交互选项」；父子开关灰显。
- 扩展单测由约 73 项增至 **91** 项（流式、模块保存、风格提示词、事件 target 安全等）。

### Fixed

- **飞书等多维表格划词崩溃** — `mouseup`/`mousedown` 的 `e.target` 为 Text 节点时无 `.closest`；统一 `resolveEventElement` / `eventTargetClosest`。
- **设置页完全不可用** — `firstRunPendingFlag` 暂时性死区（TDZ）导致初始化抛错；声明提前。
- 清理旋转 spinner 等与书房气质冲突的加载样式残骸。

### Removed

- **Python 包与桌面端** — 删除 `yuxtrans/`、旧 pytest/examples/benchmark、误导性 `install.sh`/`install.bat`；产品唯一路径为浏览器扩展。
- 安卓端仍为 roadmap（`docs/superpowers/`），本版不交付。

### Upgrade notes（从 0.4.x / 0.5.0-beta.1）

1. 在 `chrome://extensions` **重新加载**已解压扩展（或加载本 Release 的 zip）。
2. 原 API Key / 档案 / 缓存一般保留；若风格提示词或模型变更后译文异常，可在「数据与存储」按需清缓存。
3. 设置项已拆至五个 Tab：请分别在「翻译偏好 / 交互与显示 / 数据与存储」点击各页保存。
4. 推荐自测：划词、整页流式开/关、取消整页、词典、悬停译段、自定义风格提示词、飞书类复杂页无控制台 `closest` 报错。

## [0.4.1] - 2026-07-22

### Added

- **配置驱动的划词触发** — `triggerMode` 生效：`auto` 选中即译、`icon` 浮钮、`contextMenu` 仅右键。
- **流式开关贯通 content** — `enableStreaming` 控制划词走 `translateStream` 或 `translate`。
- **首次安装引导** — 安装后打开设置页；Popup 无档案时主按钮变为「去配置翻译服务」。
- **结构化用户错误** — `userError`（code / userMessage / actionHint）并在划词浮窗展示可行动提示。
- **整页失败重试与统计** — 控制条显示「缓存 x / API y」，支持「重试失败」「禁用本站」。
- **术语表** — CSV/JSON 导入；命中时强制译名并跳过模型。
- **差译反馈** — 划词结果可标记差译并剔除对应缓存。
- **站点双语记忆** — 整页控制条切换双语/仅译文后按 hostname 记住。
- **离线模式** — 仅允许本地模型与缓存，禁止云端请求与云端故障转移。
- **可测纯函数模块** — `extension/lib/product-helpers.js` + 扩展单元测试。
- **产品优化方案文档** — `docs/PRODUCT_OPTIMIZATION.md`（Phase A–D 已落地）。

### Changed

- Popup 统计「热词数」改为「缓存条目」。
- 设置页隐私文案改为「本机存储、未额外加密」；侧栏版本号读取 manifest。
- 通用设置增加快速开始 / 高级折叠；目标语言列表与右键菜单对齐。
- 缓存设置补充短文不缓存（&lt;12 字符）说明。
- Service Worker 消息处理统一 `ensureInitialized`；`loadCacheFromDB` / `flushCacheToDB` 经 `withDbRetry` 做 IndexedDB 一次重连。
- 浏览器 `navigator.onLine=false` 时仍允许本地 Ollama（不再误拦 localhost）。
- `.gitignore` 仅忽略根目录 `/lib/`，避免误伤 `extension/lib/`。

### Fixed

- 修复设置中的触发模式与流式开关未驱动 content script 的问题。
- 修复设置页版本号硬编码为 0.3.0 的不一致。

## [0.4.0] - 2026-07-13

### Added

- **整页翻译控制条** — 进度可视化，支持取消 / 恢复原文 / 双语切换 / 关闭。
- **双语 / 仅译文切换** — 整页完成后可一键切换对照与纯译文。

### Changed

- 默认并发提升，加快整页翻译。
- 视觉系统现代化重构；`popup.css` 独立拆分；设计令牌对齐。
- 简化 README，聚焦概况与快速使用。

## [0.3.0] - 2026-07-10

### Added

- **ProviderProfile / ActiveConfig 拆分** - 设置页保存多组翻译服务档案，popup 与内容脚本同步当前激活档案。
- **Popup 控制面板重构** - 去除输入框，新增整页翻译、流式开关、档案切换、连接状态与用量看板。
- **批量翻译去重** - 同一批次内相同原文仅请求一次，结果映射回所有出现位置。
- **批量 JSON 模式** - 对已知 OpenAI 兼容供应商的非流式批量请求附加 `response_format: json_object`，提升 JSON 输出稳定性。
- **连接状态缓存** - popup 连接检测增加 15s 轻量缓存，避免每次打开都发起真实 API 探测。
- **自动复制译文** - 内容脚本支持在设置中开启翻译后自动复制结果。

### Changed

- **缓存键归一化增强** - 新增 NFC、引号、破折号、省略号、全半角统一，提高缓存命中率。
- **压缩 batch prompt** - 精简规则描述，降低 token 消耗与 API 成本。
- **简化设置页文案** - “AI 模型服务”改为“翻译服务”，“模型管理”改为“档案管理”。
- **重写 README 与 PROVIDERS.md** - 使用方式与供应商配置说明同步到当前版本。

### Fixed

- 修复删除档案时 `removeModelRecord` 未定义导致的异常。
- 修复本地 Ollama 连接测试误带 `Authorization` 头的问题。
- 修复内容脚本在输入框、代码块、可编辑区域误触发划词浮按钮的问题。
- 修复内容脚本无翻译价值文本（纯数字、URL、纯符号）进入翻译流程的问题。

### Technical Details

- 扩展核心测试覆盖增加至 21 个用例，覆盖缓存键、档案、JSON 模式、请求构建等。
- `background.js` 导出 `buildRequest` 与 `supportsJsonMode` 供单元测试验证。

## [0.2.0] - 2026-04-04

### Added

#### Cache System
- **IndexedDB persistent cache** - Replaces chrome.storage.local, breaks 5MB limit
- **Built-in hot vocabulary** - 200+ common words preloaded for instant cache hit
- **Cache statistics dashboard** - Real-time display of translation count, cache hits, hit rate
- **Batch write optimization** - Debounce mechanism reduces IndexedDB writes

#### Translation Features
- **Streaming translation** - `translateStream` API for incremental output
- **Language switch button** - One-click swap source/target language in popup
- **Text deduplication** - Same content only translated once

#### Settings UI
- **Dynamic model list** - Fetch available models from API
- **Connection test button** - Validate API Key and endpoint
- **Auto-fill API endpoint** - Auto-populate default endpoint when selecting provider
- **Version display** - Show current version in settings header

### Changed

#### API Updates
- Qwen endpoint updated to OpenAI-compatible mode (`/compatible-mode/v1/chat/completions`)
- Added Groq API support (`api.groq.com`)
- Added Anthropic API support (`api.anthropic.com`)

#### Code Quality
- Defensive programming with null checks
- Modular constants (`DEFAULT_ENDPOINTS`, `DEFAULT_MODELS`)
- Error boundaries for async operations

### Fixed

- Settings panel syntax errors
- Request endpoint auto-fill
- Service Worker reconnection after idle
- HTTP error code mapping to friendly Chinese messages
- Request timeout handling (15 seconds)

### Removed

- History module - Simplified UI, focus on core translation

### Technical Details

- **Service Worker reconnection** - Handle MV3 idle disconnection with auto-reconnect
- **Request timeout** - 15 second timeout protection
- **Friendly error messages** - 401/403/429 etc. mapped to Chinese hints
- **i18n framework** - `default_locale: "zh_CN"` for internationalization support

---

## [0.1.0] - 2026-04-01

### Added

#### Core Engine
- Translation engine with unified interface (`BaseTranslator`)
- Local model support via Ollama (`LocalTranslator`)
- Cloud API support for multiple providers (`CloudTranslator`):
  - Qwen (阿里云通义千问) - DashScope API format
  - OpenAI - OpenAI API format
  - DeepSeek - OpenAI-compatible format
  - Anthropic (Claude) - Anthropic API format
  - Groq (极速推理) - OpenAI-compatible format
  - Moonshot (Kimi) - OpenAI-compatible format
  - Siliconflow (硅基流动) - OpenAI-compatible format
  - Custom endpoint for self-hosted models (Ollama, vLLM, etc.)
- Smart routing system with automatic fallback (`SmartRouter`)

#### Cache System
- SQLite + LRU dual-layer cache (`TranslationCache`)
- Cache warmup strategy with 59 common words (`CacheWarmupStrategy`)
- Sub-millisecond cache hit response (< 0.1ms)

#### Quality Metrics
- BLEU score calculation with Chinese/English support (`BLEUScore`)
- Word Error Rate (WER) calculation
- Character Error Rate (CER) calculation
- Comprehensive quality evaluation (`QualityMetrics`)

#### Performance Monitoring
- Benchmark framework with P50/P95/P99 metrics (`PerformanceBenchmark`)
- Memory monitoring and optimization (`MemoryOptimizer`)
- Startup speed optimization (`FastStartup`)

#### Utilities
- Retry mechanism with exponential backoff (`RetryExecutor`)
- Concurrency control with rate limiting (`ConcurrencyController`)
- YAML configuration management (`ConfigManager`)
- Terminology database with 50+ tech terms (`TerminologyDatabase`)
- Translation style management (Formal/Informal/Academic) (`StyleManager`)
- Long text splitting with context preservation (`TextSplitter`)

#### Desktop Application (PyQt6)
- System tray application (`TrayIcon`)
- Global hotkey support (`HotkeyManager`)
- Selection translation (`SelectionManager`)
- Translation window with modern UI (`TranslationWindow`)
- Settings dialog (`SettingsDialog`)

#### Browser Extension (Manifest V3)
- Context menu translation
- Selection translation with floating button
- Full page translation
- Popup interface
- Options page for API configuration

### Performance
- Cache hit response: < 0.1ms (target: < 10ms) ✅
- Cache hit rate: 100% after warmup (target: > 80%) ✅
- BLEU score: 1.0 for exact matches

### Technical Details
- Python 3.10+ support
- Async/await architecture
- Type hints throughout
- Comprehensive error handling
- Modular design

### Known Issues
- Desktop application requires PyQt6 installation
- Browser extension requires API key configuration
- Local model requires Ollama service running

### Breaking Changes
- None (initial release)

### Security
- API keys stored locally in browser extension
- No telemetry or data collection

---

## Roadmap

### [Planned]
- OCR image translation
- Voice translation
- PDF document translation
- More language pairs

### [1.0.0] - Planned
- Production-ready release
- Comprehensive test coverage
- Performance optimization
- Documentation website

---

[Unreleased]: https://github.com/Yaemikoreal/YuxTrans/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.5.0
[0.4.1]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.4.1
[0.4.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.4.0
[0.3.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.3.0
[0.2.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.2.0
[0.1.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.1.0