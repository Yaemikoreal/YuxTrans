# YuxTrans 全方位评判报告

> **执行状态（2026-07-27 更新）**：本报告「阶段一：固本」已全部落地——S1/S2/S3（P0 安全）、F1/F2（P1 功能正确性）、R1/R2/R3/R5（健壮性）、M2（死代码清理）、P5 核心测试补齐、最小 CI 均已完成，`npm test` 91 → **139 项全绿**，详见 `CHANGELOG.md` [Unreleased]。下文缺点清单保留作为记录与阶段二/三依据；其中 P5 测试发现的「`length_ratio`/`entity_drift` 规则阈值不可达」为新确认的实现层疑点，待决策。

> 评判日期：2026-07-27
> 评判对象：浏览器扩展 v0.5.0（唯一产品形态）
> 评判方式：全量代码走查（`extension/` 约 1.35 万行）、`npm test` 实测（**91 passed / 0 failed**）、文档与提交历史回溯、与同类标杆（沉浸式翻译）的产品位对照
> 结论速览：**架构与工程质量明显高于同类个人项目，功能厚度足够；当前最大的风险不在"缺功能"，而在两处安全隐患、三个巨型文件的可维护性、以及核心校验逻辑零测试。**

---

## 1. 总体评判

| 维度 | 评分（5 分制） | 一句话评价 |
|------|:---:|------|
| 功能完整度 | ★★★★☆ | 划词/整页/词典/悬停/输入框/术语表/双档案对照齐备，对标沉浸式翻译的核心场景已基本覆盖 |
| 架构设计 | ★★★★☆ | SW 纯函数模块化 + 双加载路径是亮点；但拆分只做了"皮"，主体仍是巨石 |
| 代码质量 | ★★★☆☆ | 局部精良（缓存、降级链、取消链路），整体受巨型文件与魔法数字拖累 |
| 安全与隐私 | ★★★☆☆ | 渲染侧习惯好（textContent、escapeHtml），但配置回吐 API Key、options 页未转义 innerHTML 是必须修的洞 |
| 性能 | ★★★☆☆ | 视口优先/去重/防抖设计到位；逐节点强制布局与增量全页重扫是大页面硬伤 |
| 可测试性 | ★★★★☆ | 91 项单测、纯函数模块可直接 require；但最关键的 `validateCacheEntry` 零覆盖 |
| 用户体验 | ★★★★☆ | 首次引导、结构化错误、书房衬纸视觉系统完整统一；对新手仍偏"控制台气质" |
| 工程基建 | ★★☆☆☆ | 无构建、无 CI、无 E2E、无 Lint；发布完全靠手动验证 |

**一句话总结**：这是一个"懂生产的个人项目"——缓存版本化、降级链、取消语义、配额治理这些只有踩过坑才会做的设计都到位了；但它正在逼近"单文件能承载的复杂度上限"，下一步的价值不在加功能，而在**补安全、拆巨石、补测试、建 CI**。

---

## 2. 优点（值得保留并继续发扬的）

### 2.1 架构与工程

1. **SW 纯函数模块化 + 双加载路径（最大亮点）**
   `lib/sw/` 9 个模块（constants / cache-keys / lang / translate-core / scheduler / placeholders / message-actions 等）全部无副作用，通过 `bootstrap.js` 命名空间挂载，`importScripts`（SW 运行时）与 `require`（Node 单测）双路径加载（`background.js:11-43`）。这意味着核心业务逻辑不依赖浏览器环境即可测试——这是绝大多数同类扩展做不到的。

2. **缓存体系设计精细，远超"能用"水平**
   - 缓存键编入 `version:promptVersion:modelSlug:src:tgt:style:text`（`lib/sw/cache-keys.js:66-72`），模型或 prompt 升级后旧缓存**自然失效**，无需手动清库；ollama 模型名含冒号的边界也处理了。
   - 自定义风格提示词用 FNV 短哈希编入 style 段，避免与默认风格互撞（`lib/sw/translate-core.js:30-56`）。
   - LRU（借 Map 插入序）+ 字节级限额裁剪 + 增量落盘（只写差集 `pendingCacheWrites`）+ 100 条/3s 批量 flush + `onSuspend` 兜底（`background.js:596-803`）。
   - `validateCacheEntry` 多层拦截坏缓存：拒绝语、长度比、跨语种回显、目标文字比例、实体漂移，词典键内部分流（`background.js:947-1020`）——这是"翻译准度是底线"在工程上的真正落点。

3. **批量翻译降级链完整**
   语言分组 → 字符切批 → 批内去重 → JSON 三级解析降级（直解 / ```json 块 / 数组正则）→ 重复译文 sanity check → 单句并发补全 3 次重试（`background.js:2543-2748`）。面对 LLM 输出的不确定性，这条链是典型的"被生产毒打过"的设计。

4. **取消与竞态处理认真**
   会话级 `sessionId → AbortController`，取消即 abort 在途 SSE 并阻止后续批次（`background.js:1069-1117`）；整页重入锁；IndexedDB 断连检测 + 重试 + `onversionchange` 协作关闭；同 cacheKey 在途 Promise 去重（`lib/sw/scheduler.js:24-42`）。

5. **content 侧性能意识**
   TreeWalker acceptNode 一次过滤、视口优先排序、IntersectionObserver 200px 预加载区按需翻译、MutationObserver 500ms 防抖增量（`content.js:1287-2548`）。

### 2.2 安全好习惯（已做对的）

- 译文渲染全部走 `textContent`，模型输出不进 `innerHTML`（`content.js:1168` 等）；浮窗用户源文本经 `escapeHtml`（`content.js:1011`）。
- API Key 只存 `chrome.storage.local`，并做一次性迁移清除 sync 区（避免 Key 随浏览器账号同步上云，`background.js:1301-1313`）。
- 自定义端点需 `chrome.permissions` 按需授权后才放行（`background.js:1800-1811`）。
- 请求日志只记 prompt/response，不记 header，Key 不进日志。
- SW 全局 `error`/`unhandledrejection` 捕获。

### 2.3 产品与体验

- **功能厚度**：F1–F8（悬停译段、单词词典、原文弱化/模糊、浮窗钉住、双档案对照、输入框回填、正文区识别、谷歌免 Key、Ollama 分档）对标沉浸式翻译的差异化场景基本补齐。
- **首次三步引导**、结构化用户错误（code / userMessage / actionHint）、配置变更 `storage.onChanged` 实时同步——0.4.x 时代的 P0 体验问题已闭环。
- **视觉系统统一**：`design-tokens.css` 书房衬纸风格贯穿 popup / options / content，尊重 `prefers-reduced-motion`，有明确的设计守门文档（`docs/UI_DESIGN_SYSTEM.md`）。
- **文档纪律好**：CHANGELOG 遵循 Keep a Changelog + SemVer，ADR 记录关键决策，AGENTS.md 对后续维护者（含 AI）高度友好。

---

## 3. 缺点与解决方法（按严重度分级）

### P0 — 安全：必须在下一版本修复

#### S1. `getConfig` 把含 API Key 的完整 profiles 明文回吐，且消息入口无 sender 校验
- **证据**：`background.js:3191-3193` 直接 `sendResponse({ ...config })`，`config.profiles` 内含 `apiKey`；`onMessage` 未校验 `sender`（`background.js:3023`）。网页 JS 因 isolated world 打不进来，但扩展内任何页面/content script 均可读取全部供应商 Key；options 页/popup 拿到的也是全量明文，攻击面被整体放大。
- **解决**：
  1. `getConfig` 增加 `includeSecrets` 参数，默认对 `apiKey` 做脱敏（返回 `***` + `hasKey: true`）；只有"保存/测试连接"类消息按需取 Key，且永不回传。
  2. `onMessage` 入口校验 `sender.id === chrome.runtime.id`，并对来自 content script 的消息做 action 白名单（content 不需要读配置明文，配置应由 SW 推送或按需下发字段子集）。

#### S2. options 页存在未转义的 innerHTML 拼接用户输入
- **证据**：`renderModelList` 把 `m.label` / `modelLabel`（用户填写的模型名、自定义供应商名）直接拼进 `innerHTML`（`options.js:1458-1474`）；`options.js:431` 对照档案下拉同模式。讽刺的是同文件 `options.js:1871` 就有现成的 `escapeHtml`，只是没用。触发面在设置页——而设置页上正好摆着 API Key 表单。
- **解决**：全文检索 options.js 中所有 `innerHTML` 赋值，用户可控字段一律走 `escapeHtml` 或改为 DOM API（`textContent` + `createElement`）；并为该模式补一条单测（用 `<img onerror>` 载荷做回归断言）。

#### S3. 权限与注入面过宽
- **证据**：`host_permissions` 含 `http://localhost:*/*` 全端口（`manifest.json:25`，实际只需 11434）；content script 注入 `<all_urls>`，所有页面常驻 2.6k 行 JS + 1.2k 行 CSS，仅靠运行时 `isSiteAllowed()` 判断。
- **解决**：localhost 权限收窄到 `http://localhost:11434/*`；评估把 content script 注入从静态 `<all_urls>` 改为「默认注入 + 声明式排除」或 `activeTab` + 按需注入（`chrome.scripting`）的可行性——后者还能显著降低 Chrome Web Store 审核阻力。

### P1 — 功能正确性：影响翻译质量本身

#### F1. 语言检测盲区：拉丁语系全部误判为英语
- **证据**：`detectLanguage` 用 Unicode 脚本区间判断，法/德/西/葡/意全部落到 `'en'`（`lib/sw/lang.js:41-53`）。后果是**功能性缺陷**：targetLang=en 时，法语文本被 `isSameAsTargetLanguage` 误判为"已是目标语言"而跳过翻译。
- **解决**：轻量方案——对拉丁脚本段落加特征词/停用词频率打分（各语言 30-50 个高频词即可覆盖 80% 场景）；或引入 `franc-min` 这类零依赖 n-gram 检测库（注意评估包体与 MV3 CSP 兼容性）。配套补充多语种 detectLanguage 单测。

#### F2. "自适应并发限制"名不副实
- **证据**：`concurrentLimit`（1~10）只在 fallback 补全分片处使用（`background.js:2705-2709`）；主路径 `translateWithCloud` / `translateWithStream` 只有 `applyRateDelay` 延迟，**没有并发闸门**。实际并发由 content.js 自管（批量默认 50，流式 4）。AGENTS.md 的描述与实现不符。
- **解决**：在 SW 的 `lib/sw/scheduler.js` 落地真正的信号量式并发闸门，让自适应并发数对所有出站请求生效；content 侧只负责"提交任务"，不再各自为政。同时修订 AGENTS.md 描述。

### P2 — 性能：大页面/长会话硬伤

#### Q1. `collectTextNodes` 逐节点同步 `getBoundingClientRect` 强制布局
- **证据**：`content.js:1351` 对每个文本节点同步读布局，`getElementStyles` 每节点 `getComputedStyle`（`content.js:1426`）。数千节点的大页面会反复强制同步布局（layout thrashing），整页翻译启动时主线程长卡顿。
- **解决**：分批（如每批 100 节点）+ `requestIdleCallback`/`scheduler.yield` 让出主线程；布局读取集中到同一帧内批量做（先全量读、再全量写，读写分离）；视口外的节点可延迟到 IntersectionObserver 触发时再量。

#### Q2. 动态增量翻译每次全量重扫 body
- **证据**：`_processAddedNodes` 直接调 `collectTextNodes()` 遍历整页（`content.js:2558`），无限滚动页面（Twitter、文档站）会反复 O(页面) 扫描。
- **解决**：以 mutation 的 `addedNodes` 为根做增量收集（只扫新增子树），而不是全页重扫。

#### Q3. 缓存全量载入内存
- **证据**：`loadCacheFromDB` 用 `store.getAll()` 把最多 200MB 缓存一次性读入 Map（`background.js:504-525`），SW 每次唤醒都全量加载。
- **解决**：改为懒加载 + 容量上限的内存 LRU：内存只保留热条目（如 20MB），未命中再查 IndexedDB；或者按 modelSlug+语言对做分片索引，按需载入。

### P3 — 可维护性：正在逼近复杂度上限

#### M1. 三个巨型文件
- **证据**：`background.js` 3594 行（其中消息路由是一条 440 行 if-else 链，`background.js:3023-3469`）、`content.js` 2619 行（一个类承载划词/词典/悬停/整页/双语/动态观察/输入框 7 个功能域）、`options.js` 1892 行 + `options.css` 1819 行。
- **解决**：不需要一步到位引入构建系统，可按"现有 `lib/sw` 双加载模式"渐进外迁：
  1. **路由表驱动**：`lib/sw/message-actions.js` 注册表已存在但目前只用于测试断言——让它真正驱动 `onMessage` 路由，每个 action 一个处理函数模块，440 行 if-else 自然消失。
  2. **content.js 按功能域拆**：selection（划词浮窗）/ dict（词典）/ hover（悬停）/ page（整页）/ input（输入框）各自成文件，MV3 content_scripts 支持多文件按序注入，无需打包器。
  3. 魔法数字集中：`content.js:41`（并发 50）、`:950`（流式超时 65s）、`:1560`（130s）、rootMargin、防抖值等收进 `lib/sw/constants.js` 或 content 侧 config 模块。

#### M2. 死代码与不一致
- **证据**：`flipTargetIfSameLanguage` 已退化为恒返回 targetLang 仍保留签名（`lib/sw/lang.js:88-90`）；`background.js:63` 的 `CACHE_KEY_VERSION` 兜底值是 `'v2'` 而 constants 已是 `'v3'`；`SCRIPT_RANGES` 在 `background.js:2099-2109` 有一份 fallback 重复定义。
- **解决**：删除退化函数与重复定义；兜底值与 constants 对齐。AGENTS.md 中"55 passed"已过时（现 91），一并修订。

### P4 — 健壮性：SW 生命周期的经典坑

- **R1. `setInterval(checkNewVersion, 12h)` 在 SW 中不可靠**（`background.js:3530`）：SW 休眠后定时器消失。**解决**：改用 `chrome.alarms`（MV3 唯一可靠的定时机制）。
- **R2. `ensureInitialized` 并发竞态**（`background.js:2878-2908`）：`if (!initialized)` 非原子，冷启动并发消息会重复全量加载。**解决**：把初始化收敛为一个共享 Promise（`initPromise ??= doInit()`）。
- **R3. `translationSessions` 清理不完全**：只惰性清理 cancelled 的；页面直接关闭（未发 cancel）的会话永驻 Map。**解决**：会话条目加时间戳，定期清扫（配合 chrome.alarms）或在 `ensureInitialized`/新会话创建时做容量上限淘汰。
- **R4. flush 竞态**：3s flush 定时器期间 SW 休眠，pending 写入只靠 `onSuspend` 兜底，而 `onSuspend` 中 async IndexedDB 操作不被保证完成——可能丢最近几条缓存。**解决**：可接受现状（缓存本就易失），但建议把 flush 间隔与 onSuspend 行为写进注释/文档，明确"丢最近 N 条"是已知取舍。
- **R5. 小瑕疵**：`fallbackBatchItems` 用 `chunks.indexOf(chunk)` 判断末片（O(n) 且脆弱）；`isNewerVersion` 对预发布版本号 `Number('0-beta')` 得 NaN；`testProviderConnection` 对空 endpoint 依赖 catch 兜底。**解决**：随下次顺手修，均为几行改动。

### P5 — 测试盲区：最该测的没测

当前 91 例全绿，覆盖缓存键/语言检测/prompt/调度器/端点/SSE/词典解析/部分 content 分派，但：

| 盲区 | 风险 | 建议 |
|------|------|------|
| `validateCacheEntry` **零覆盖** | 防坏缓存的核心规则集（refusal/echo/entity_drift/target_script），逻辑最重、边界最多 | 补参数化用例：每条规则至少 1 正 1 反 |
| `translateBatchInternal` 降级链 | JSON 解析失败 → 部分利用 → fallback 补全、重复译文 sanity check | mock fetch 构造畸形 JSON 逐级验证 |
| 自适应限速 `updateRateLimitState` / `tryRecoverRateLimit` | 429 冷却、持久化恢复 | 纯函数，直接可测 |
| IndexedDB 层（flush 差集、失败回滚、重连分支） | 目前只测了"非 DB 错误原样抛出" | 用 fake-indexeddb 或内存 stub |
| `popup.js` / `options.js` **完全无测试** | S2 的 innerHTML 问题正是一次单测能拦住的 | 至少给 escapeHtml 路径与档案读写加测试 |
| `content.js` 仅 7 例 | 悬停、词典卡片渲染、双语切换、`restoreOriginalTexts`、XSS 回归均无 | 优先补 escapeHtml/XSS 与双语渲染 |

### P6 — 工程基建

- **无 CI/CD**：发布前回归全靠手动（AGENTS.md 已自认）。**解决**：加一份最小 GitHub Actions（`node --test` + manifest 校验 + zip 打包），成本极低收益极高。
- **无 E2E**：`options.js`、`background.js`、`content.js` 改动后只能真人浏览器验证。**解决**：中期可用 Playwright 的 MV3 加载能力做一条冒烟链路（加载扩展 → 注入页 → 模拟划词 → 断言浮窗）。
- **无 Lint/格式化**：13.5k 行手写 JS 无静态检查。**解决**：ESLint（推荐 `no-unsanitized` 插件，可直接拦住 S2 类问题）+ Prettier。

---

## 4. 后续更新思路方向

按「先固本、再体验、后扩张」排序，给出三个阶段的建议。

### 阶段一：固本（建议 0.5.x 补丁 / 0.6.0）

目标：把本报告 P0/P1 清零，不引入新功能。

1. 修 S1（配置脱敏 + sender 校验）、S2（innerHTML 转义 + 回归测试）、S3（localhost 权限收窄）。
2. 修 F1（拉丁语系检测）、F2（调度器真并发闸门）。
3. 补 `validateCacheEntry` 与降级链测试（P5 前两项）——这两块是"翻译准度是底线"的守门员。
4. 顺手清理 M2 死代码、R1/R2/R5 小修。
5. 建立最小 CI。

### 阶段二：性能与可维护性（0.6.x）

1. Q1/Q2/Q3 性能三连：布局读写分离与分批、增量收集、缓存懒加载。这三项直接决定"整页翻译大文档"这一核心场景的上限。
2. 巨石拆分 M1：先路由表驱动 background，再按功能域拆 content，全程保持 `npm test` 绿。
3. 引入 ESLint + Prettier，把"转义用户输入"变成机器守门而非人肉守门。
4. 评估 Playwright E2E 冒烟。

### 阶段三：产品与生态（0.7.0+）

按对"深阅读"定位的增益排序：

1. **翻译质量闭环深化**：差译反馈已有雏形（0.4.1），可进一步做"差译自动重译（换风格/换模型）"与术语表命中统计——把"准度底线"从被动校验升级为主动学习。
2. **PDF 与阅读场景**：PDF 站内翻译是沉浸式翻译用户迁移的首要诉求；EPUB/阅读模式友好性可作为差异化。
3. **多译文对照升级**：双档案对照（F4b）已存在，可扩展为"同段多模型并排 + 一键择优写回缓存"，与阶段一的缓存键体系天然兼容。
4. **同步与备份**：profiles/术语表/风格提示词的导出导入（加密可选）——为换机与多设备用户服务，注意 Key 绝不进导出明文。
5. **Chrome Web Store 上架准备**：权限收窄（S3）+ 隐私政策页 + 商店素材；`optional_host_permissions` 的按需授权模式已是加分项。
6. **安卓端（roadmap）**：`docs/superpowers/` 已有完整 spec 与移植规则，建议在扩展侧阶段一、二完成后启动，避免两线同时施工。
7. **谨慎对待的方向**：账号体系、云端同步、团队协作——与"独立运行、无后端、隐私优先"的现有定位冲突，除非明确转型，否则不做。

### 不建议做的事

- **不要急于引入打包器/框架**（Webpack/Vite/React）：现有"无构建 + 纯函数模块 + node:test"是一条自洽且低成本的路径，双加载模式已证明可行；先按现有模式拆文件，真到模块循环依赖压不住时再上构建。
- **不要继续给 content.js 加功能域**：每加一个新交互先拆后加，否则 2.6k 行会变成 4k 行。

---

## 5. 附录：本次评判的验证数据

- 测试：`npm test` → **91 passed / 0 failed**（2026-07-27 实测；`node --test extension/tests/` 目录直跑在本环境失败，npm 脚本通配正常，建议统一文档口径）。
- 代码量：`extension/` JS+CSS+HTML+manifest 合计约 13,525 行；前四大文件 `background.js`(3594) / `content.js`(2619) / `options.js`(1892) / `options.css`(1819) 占总量的 73%。
- 版本线：v0.3.0 → v0.4.0 → v0.4.1 → v0.5.0-beta.1 → v0.5.0（2026-07-24 稳定版），CHANGELOG 完整、遵循 SemVer。
- 引用约定：文中所有 `文件:行号` 均对应 v0.5.0 工作区现状，后续改动后请以检索复核。
