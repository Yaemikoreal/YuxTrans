# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### [0.3.0] - Planned
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

[0.3.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.3.0
[0.2.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.2.0
[0.1.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.1.0