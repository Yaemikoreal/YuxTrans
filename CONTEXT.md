# YuxTrans 领域语言

## 术语表

- **Popup（控制面板）**：浏览器工具栏图标触发的小型浮层。在 YuxTrans 中定位为「控制中心」，提供整页翻译触发、流式模式开关、用量/缓存看板、模型切换与连接状态，而非逐句输入翻译器。
- **Options Page（设置页）**：扩展的全屏配置页面。顶栏分为五个模块 Tab（见下），分别编辑 **ProviderProfile** 与 **ActiveConfig** 的不同切片；诊断 Tab 只读。
  - **ProviderProfile（供应商档案）**：可复用的 provider + 凭据 + 端点 + 模型模板。
  - **ActiveConfig（当前运行配置）**：当前生效的全局偏好，包括选中的供应商档案、语言方向、行为开关、缓存与站点规则。逻辑上仍是一份配置；设置页按模块分栏编辑、**分栏保存**，不是多套并行配置。
- **Preference Module（翻译偏好模块）**：设置页中回答「译什么」的栏目——语言方向、翻译风格、风格提示词、离线模式，以及按需显示的当前档案锚点与首次上手引导。_Avoid_: 把触发方式、缓存、站点规则塞进「翻译偏好」。
- **Style Prompt（风格提示词）**：注入翻译指令的风格说明文案，按风格 id（normal / academic / technical / literary）配置。内置默认见 `STYLE_PROMPTS`；用户覆盖保存在 ActiveConfig.`stylePrompts`（仅存与默认不同的键）。自定义后缓存 style 段带短哈希，避免与默认提示下的旧译文误命中。
- **Interaction Module（交互与显示模块）**：设置页中回答「怎么触发、长什么样」的栏目——触发方式、流式、悬停/词典、原文呈现、输入框与正文识别、双档案对照等。默认露出高频项，低频项收在进阶折叠。_Avoid_: 交互设置、行为设置（易与翻译偏好混淆）。
- **Data Module（数据与存储模块）**：设置页中管理术语表、翻译缓存限额与占用、配置导入导出、网站规则/故障转移与危险清除。_Avoid_: 把性能日志与只读诊断看板算作本模块。
- **Diagnostics Module（诊断排障模块）**：设置页中只读的运行观测——用量概览、性能、供应商分布、SW 耗时、失败与请求日志；不写入 ActiveConfig。
- **Module Save（分栏保存）**：每个可写模块 Tab 仅持久化本栏字段；不存在跨栏「保存全部设置」主按钮。服务档案沿用自身档案保存流。
- **Options Atmosphere（设置页氛围层）**：仅作用于 Options 的背景表现——静态纸纹 + 单层缓慢漂移的低对比光晕（尊重 `prefers-reduced-motion`）；不作为翻译浮层或 Popup 的默认背景策略。
- **Zone Accent（分区点缀色）**：设置页导航与块标题使用的极低饱和色相提示，用于缓解单色扫视疲劳；不改变正文大面积书页底，也不等于提高全局品牌主色饱和度。
- **TranslationCache（翻译缓存）**：以 `sourceLang:targetLang:style:text` 为键的 IndexedDB 缓存；归一化仅保留与语义无关的最小处理（NFC、去除零宽字符、折叠空白），不同标点/引号/全角半角视为不同键，避免近似命中。
- **Good Cache Hit（有效缓存命中）**：一次缓存命中必须同时满足三条——(1) 键精确匹配；(2) 译文质量可接受，无张冠李戴或明显幻觉；(3) 在当前页面上下文下仍然合适。单纯的键匹配不等于有效命中。
- **Cache Validator（缓存校验器）**：在缓存写入和读取前执行的启发式规则集，用于把坏命中拦截在返回给用户之前。其中源文长度低于 `MIN_CACHE_SOURCE_LENGTH`（12 字符）的条目直接视为近似命中，不进入缓存。
- **Dictionary Cache（词典缓存）**：F2 单词词典查询的缓存，复用 TranslationCache 键格式但 `style` 段固定为 `'dict'`（与正常译文 `'normal'/'academic'/...` 不撞）。词典 JSON 非译文近似命中，单词普遍 <12 字符是常态，故 Cache Validator 对 `style='dict'` 的键仅做版本号与非空校验，跳过 `too_short`/`refusal`/`length_ratio`/`echo`/`target_script`/`entity_drift` 等译文专有规则。不再有通用 `skipValidation` 逃生口。
- **Bad-Hit Rate（坏命中率）**：`（启发式拦截命中数 + 用户标记坏命中数）/ 总缓存命中数`，衡量缓存命中质量的核心指标。
- **Proper Noun Whitelist（专有名词白名单）**：允许在跨语种翻译中保持原文的专有名词/品牌词列表，减少回显规则误伤。
- **Builtin Cache（内置热词库）**：已清空。严格缓存策略下，短词/固定译法的内置热词属于近似命中，不再预加载。
- **Page Translation（整页翻译）**：内容脚本扫描页面文本节点，批量翻译并以双语标签替换原文，支持恢复原文。
- **Selection Translation（划词翻译）**：用户选中文本后触发的单条翻译，结果以页面内弹窗呈现。
- **Streaming Translation（流式翻译）**：服务端通过 SSE 逐字返回译文，内容由 background 推送到内容脚本弹窗实时显示。

## 边界上下文

- **Browser Extension**：面向用户的所有交互发生地，包含 Popup、Options Page、Content Script、Background Service Worker。
- **Android App（规划，未实现）**：作为后续版本 roadmap 选项之一，设计与实现计划留存于 `docs/superpowers/`。
