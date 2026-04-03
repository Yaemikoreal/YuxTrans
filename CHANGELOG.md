# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.2.0
[0.1.0]: https://github.com/Yaemikoreal/YuxTrans/releases/tag/v0.1.0