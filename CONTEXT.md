# YuxTrans 领域语言

## 术语表

- **Popup（控制面板）**：浏览器工具栏图标触发的小型浮层。在 YuxTrans 中定位为「控制中心」，提供整页翻译触发、流式模式开关、用量/缓存看板、模型切换与连接状态，而非逐句输入翻译器。
- **Options Page（设置页）**：扩展的全屏配置页面，承担两大职责：
  - **ProviderProfile（供应商档案）**：可复用的 provider + 凭据 + 端点 + 模型模板。
  - **ActiveConfig（当前运行配置）**：当前生效的全局偏好，包括选中的供应商档案、语言方向、行为开关、缓存与站点规则。
- **TranslationCache（翻译缓存）**：以 `sourceLang:targetLang:text` 为键的 IndexedDB 缓存；通过文本归一化提升命中率与准确性。
- **Page Translation（整页翻译）**：内容脚本扫描页面文本节点，批量翻译并以双语标签替换原文，支持恢复原文。
- **Selection Translation（划词翻译）**：用户选中文本后触发的单条翻译，结果以页面内弹窗呈现。
- **Streaming Translation（流式翻译）**：服务端通过 SSE 逐字返回译文，内容由 background 推送到内容脚本弹窗实时显示。

## 边界上下文

- **Browser Extension**：面向用户的所有交互发生地，包含 Popup、Options Page、Content Script、Background Service Worker。
- **Python Package**：当前暂停维护，不提供本次优化范围内的交互入口。
