# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-07-23

### Added

- **F1 悬停段落翻译** - 按修饰键（默认 Alt，可选 Ctrl）+ 鼠标悬停段落，300ms 后在段落后插入译文块；虚线描边提示、× 关闭、已译段落不重复触发；`hoverTranslate`/`hoverModifier` 配置项；纯函数 `isHoverParagraphCandidate`。
- **F2 单词词典模式** - 划到单词或双击单词直出词典卡片（词 / 音标 / 词性义项 / 双语例句）；`buildDictionaryPrompt` 严格 JSON schema；`lookupWord` action + 独立 `dict` 缓存键（绕过 12 字符门槛与译文校验）；解析降级链（JSON 失败回退纯文本）；纯函数 `isSingleWord`。
- **F3 译文显示样式** - 整页双语原文可弱化（`fade`）或模糊（`blur`，悬停还原）；`originalStyle` 配置实时生效；补全 `--yxt-text-xs/sm`、`--yxt-ink-25` 未定义令牌。
- **F4 浮窗钉住** - 钉住当前浮窗使其不被新划词覆盖，便于结果对照；`pinnedPopups` 多浮窗管理；暖色左边线视觉区分。
- **F4b 双档案对照** - `translateWithProfile` action 用指定档案再译同一文本，对照浮窗（黄昏紫边线）并排展示；`compareProfileId` 从已存档案下拉选择。
- **F5 输入框翻译** - `inputTranslate` 开关下 input/textarea 选中文本可翻译，浮窗「插入」按钮将译文回填输入框（触发 input 事件兼容前端框架）。
- **F6 正文区域识别** - `smartContentDetection` 开关下整页翻译只翻正文根（`main`/`article` 或文本密度最高块），跳过导航/侧栏/页脚。
- **F7 谷歌免费翻译接口** - `google` provider，`translate.googleapis.com` 免 Key GET 请求 + 嵌套数组解析；providers-core 免 Key可用判定；manifest `host_permissions` 同步。
- **F8 Ollama 推荐模型分档** - 三档（最快 / 推荐 / 最佳质量）；`setup-ollama.bat/.sh` 模型名参数化（默认 qwen3.5:0.8b，`%1`/`$1` 覆盖），结尾打印三档建议。
- **配置实时同步** - content 侧 `chrome.storage.onChanged` 监听，options 保存后即时生效无需刷新页面。

### Changed

- `translateWithCloud` 新增 `options`（promptOverride + jsonMode）支持词典模式复用请求路径；`setToCache` 新增 `skipValidation` 参数供词典缓存绕过译文校验。
- 扩展单测增至 73 项（新增 F1/F2/F7 纯函数与解析逻辑用例）。

## [Unreleased]

### Added

- **品牌 Logo 适配** — 以 `logo/logo.png` 生成 `extension/icons` 16/32/48/128；Popup/Options 展示品牌标；`scripts/generate_extension_icons.py` 可重生成。
- **首次安装三步引导** — 设置页向导：选本地/云端 → 配置 Key 或检测 Ollama → 试译 Hello。
- **Service Worker 模块拆分** — `extension/lib/sw/`：`constants` / `cache-keys` / `providers-core` / `lang` / `message-actions` / `translate-core`（`importScripts` 加载）。
- **UI 纯策略 helpers** — `formatUserErrorCompact`、`pageControlCompletedActions`、`shouldCollapsePopupStats`。

- **整页翻译用户取消链路** - `cancelTranslate` action + SW 会话级 AbortController：恢复原文/重入时 abort 在途请求并阻止后续批次，停止翻译后不再继续消耗配额。
- **belowFold 视口感知翻译** - 非首屏节点注册 IntersectionObserver（200px 预加载区），入视口才提交批次取代一次性全提交，节省未浏览内容的配额；2s 超时回退避免卡死。
- **在途翻译去重调度器** - `lib/sw/scheduler.js`：相同 cacheKey 的并发请求共享一次结果（划词+整页+动态同文本不重复请求），优先级分级（划词 > 视口 > 批次）。
- **批量翻译滑动窗口上下文** - 上一批末尾原文+译文透传到下一批 prompt（标记勿重译），提升跨段指代与连贯性。
- **内联标签占位符保护工具** - `lib/sw/placeholders.js`：`extractPlaceholders`/`restorePlaceholders` 将 HTML 标签替换为 `<t n="N">` 占位并按序还原。

### Changed

- 扩展单测覆盖首次引导门禁与 SW 模块；`npm test` 覆盖 `extension/tests/*.test.js`。
- **缓存键编入 prompt 版本与模型** - `CACHE_KEY_VERSION` 升至 v3，键内含 `PROMPT_VERSION` + 当前模型 slug，prompt 规则或模型变更后旧缓存自然失效，修复术语表/模型切换后旧译文误命中；顺手清理 `yuxtrans-spin` 关键帧与 spinner 样式残骸。
- **书房衬纸 UI 落地（P0–P1）** — 铅字 paper-toggle；Popup 用量折叠；整页控制条主次分离；设置侧栏任务化中文；状态色/模态走 design tokens；暗色阴影去纯黑胶囊风格。

### Removed

- **归档 Python 桌面客户端与孤岛工具** - 删除 `yuxtrans/desktop/`、六个零调用方 utils（memory / style / terminology / text_processing / startup / setup_wizard）、冗余 `setup.py`、孤儿 `benchmark/` 与 `test-options.js` + jsdom 依赖；Python 包仅保留 engine + cache 作最小可复用库，浏览器扩展为主产品。
- 误导性安装脚本 `install.sh` / `install.bat`（宣传已不存在的 `yuxtrans --help` CLI 与桌面端 entry point）。
- **移除 Python 包** — 删除 `yuxtrans/`、`tests/`、`examples/`、`benchmark/` 及 `pyproject.toml` / `requirements.txt` / `pytest.ini`，项目聚焦浏览器扩展；安卓端设计与实现计划留存于 `docs/superpowers/`，作为后续版本 roadmap 选项之一。

### Fixed

- 修复 `cloud.translate_stream` 用普通 `for` 遍历 httpx 异步生成器导致运行时 `TypeError`（改 `async for`）。
- 修复 `router.preload` 将同步 `_preload_popular()` 返回值（None）塞入 `asyncio.gather` 导致 `TypeError`（改为直接调用同步预热、仅 gather 异步协程）。

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

[Unreleased]: https://github.com/Yaemikoreal/YuxTrans/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.4.1
[0.4.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.4.0
[0.3.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.3.0
[0.2.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.2.0
[0.1.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.1.0