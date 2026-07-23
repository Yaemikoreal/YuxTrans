# YuxTrans 领域语言

## 术语表

- **Popup（控制面板）**：浏览器工具栏图标触发的小型浮层。在 YuxTrans 中定位为「控制中心」，提供整页翻译触发、流式模式开关、用量/缓存看板、模型切换与连接状态，而非逐句输入翻译器。
- **Options Page（设置页）**：扩展的全屏配置页面，承担两大职责：
  - **ProviderProfile（供应商档案）**：可复用的 provider + 凭据 + 端点 + 模型模板。
  - **ActiveConfig（当前运行配置）**：当前生效的全局偏好，包括选中的供应商档案、语言方向、行为开关、缓存与站点规则。
- **TranslationCache（翻译缓存）**：以 `sourceLang:targetLang:style:text` 为键的 IndexedDB 缓存；归一化仅保留与语义无关的最小处理（NFC、去除零宽字符、折叠空白），不同标点/引号/全角半角视为不同键，避免近似命中。
- **Good Cache Hit（有效缓存命中）**：一次缓存命中必须同时满足三条——(1) 键精确匹配；(2) 译文质量可接受，无张冠李戴或明显幻觉；(3) 在当前页面上下文下仍然合适。单纯的键匹配不等于有效命中。
- **Cache Validator（缓存校验器）**：在缓存写入和读取前执行的启发式规则集，用于把坏命中拦截在返回给用户之前。其中源文长度低于 `MIN_CACHE_SOURCE_LENGTH`（12 字符）的条目直接视为近似命中，不进入缓存。
- **Bad-Hit Rate（坏命中率）**：`（启发式拦截命中数 + 用户标记坏命中数）/ 总缓存命中数`，衡量缓存命中质量的核心指标。
- **Proper Noun Whitelist（专有名词白名单）**：允许在跨语种翻译中保持原文的专有名词/品牌词列表，减少回显规则误伤。
- **Builtin Cache（内置热词库）**：已清空。严格缓存策略下，短词/固定译法的内置热词属于近似命中，不再预加载。
- **Page Translation（整页翻译）**：内容脚本扫描页面文本节点，批量翻译并以双语标签替换原文，支持恢复原文。
- **Selection Translation（划词翻译）**：用户选中文本后触发的单条翻译，结果以页面内弹窗呈现。
- **Streaming Translation（流式翻译）**：服务端通过 SSE 逐字返回译文，内容由 background 推送到内容脚本弹窗实时显示。

## 边界上下文

- **Browser Extension**：面向用户的所有交互发生地，包含 Popup、Options Page、Content Script、Background Service Worker。
- **Android App（规划，未实现）**：作为后续版本 roadmap 选项之一，设计与实现计划留存于 `docs/superpowers/`。
