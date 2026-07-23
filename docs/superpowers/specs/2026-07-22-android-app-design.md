# YuxTrans 安卓端设计文档

日期：2026-07-22
状态：已确认（头脑风暴产出，待实现计划）

## 1. 背景与目标

YuxTrans 当前唯一活跃的产品是浏览器扩展（`extension/`）。本设计为项目衍生安卓端应用，把扩展已验证的核心能力（供应商适配、流式输出、缓存、限速、整页翻译）移植到安卓平台。

**核心定位不变**：响应速度是生命，翻译准度是底线。

**关键决策记录**：

| 决策点 | 结论 |
|--------|------|
| 首发核心场景 | 全局划词悬浮窗翻译 |
| 技术栈 | 原生 Kotlin + Jetpack Compose |
| 翻译链路 | 直连供应商 API（用户自带 key），无自建后端 |
| 分发渠道 | 个人使用 / 侧载 APK，无上架合规压力 |
| 代码归属 | 方案 A：仓库内新建 `android/` 独立 Gradle 项目 |
| Python 包 | 从「暂停维护」改为「彻底移除」 |
| 本地 Ollama | 安卓端不支持（手机上不现实） |
| 整页翻译 | 两种形态都要，分两期（见 §6） |

## 2. 仓库调整（Python 移除）

随安卓端落地同步执行的仓库清理：

- **删除**：`yuxtrans/`、`tests/`、`examples/`、`benchmark/`、`pyproject.toml`、`requirements.txt`、`pytest.ini`、`.pytest_cache/`、`.ruff_cache/`、`.tmp-venv/`。
- **保留**：`extension/`（含 Node 测试）、`docs/`、`logo/`、`scripts/generate_extension_icons.py`（独立的图标生成脚本）、`package.json`。
- **更新**：
  - `AGENTS.md`：结构改为「浏览器扩展 + 安卓 App」双端，删除 Python 相关章节（技术栈、测试命令、供应商扩展流程的 Python 侧等）。
  - `README.md` / `CHANGELOG.md`：记录 Python 包移除与安卓端引入。
  - `CONTEXT.md`：边界上下文中删除「Python Package（暂停维护）」，新增「Android App」。

## 3. 总体架构

单 App，无后端，进程内四个组件：

```
文本选中/复制（任意 App）
        │  CaptureService（无障碍服务）监听
        ▼
OverlayService（悬浮窗）──► TranslationEngine（纯 Kotlin）
   ▲                            │
   │              Room 缓存 → 供应商适配层（直连 API，SSE 流式）
   │                            │
   └──── 流式渲染译文 ◄─────────┘
```

组件职责：

- **CaptureService**：无障碍服务，只负责"拿到原文"，不做翻译、不碰网络。
- **OverlayService**：悬浮窗，只负责呈现（加载态 / 流式译文 / 操作按钮）。
- **TranslationEngine**：纯 Kotlin 层，不依赖 Android UI，可独立单测。移植扩展的供应商适配、SSE 流式、缓存、自适应限速、批量降级策略。
- **Settings UI**（Compose）：供应商档案、语言/风格、触发与黑名单、缓存管理。

## 4. 核心模块设计

### 4.1 CaptureService（无障碍服务）

- 监听 `TYPE_VIEW_TEXT_SELECTION_CHANGED` 事件读取选中文本；监听剪贴板变化作为兜底（部分 App 不上报选择事件）。
- 防抖：连续事件 300ms 内合并，取最后一次稳定文本。
- 触发后通过 startService + extras 通知 OverlayService。
- 包名黑名单（对应扩展的站点黑名单）：密码管理器、银行类 App 等，设置页可维护。

### 4.2 OverlayService（悬浮窗）

- 使用 `TYPE_ACCESSIBILITY_OVERLAY` 类型，挂在无障碍服务下，**无需 `SYSTEM_ALERT_WINDOW` 权限**。
- 三个状态：加载中 → 流式渲染（逐字追加，复刻扩展流式体验）→ 完成态（复制 / 重试 / 关闭）。
- 点击窗外自动消失；支持拖动。
- 视觉遵循「书房衬纸」设计系统（`docs/UI_DESIGN_SYSTEM.md`），色板/字体映射为 Compose theme；禁止纯黑纯白、高饱和色、大圆角胶囊等与气质冲突的元素。

### 4.3 TranslationEngine（纯 Kotlin，无 Android 依赖）

- `ProviderAdapter` 接口 + 各供应商实现：对照 `extension/background.js` 的 `API_ENDPOINTS`、`DEFAULT_MODELS`、请求体格式移植；网络层 OkHttp + SSE。
- `TranslationCache`：Room 持久化 + 内存 LRU。键规则与校验器照搬 `CONTEXT.md` 领域定义：
  - 键 = `sourceLang:targetLang:style:text`，归一化仅 NFC、去零宽字符、折叠空白。
  - 源文长度低于 `MIN_CACHE_SOURCE_LENGTH`（12 字符）不入缓存。
  - 坏命中拦截启发式在读写前执行。
- `RateLimiter`：移植扩展自适应限速——按连续成功/失败动态调整并发（1~10）与请求延迟（0~2000ms），429 触发 30s 冷却。
- 路由简化：缓存 → 当前激活供应商。无本地模型层。

## 5. 数据层与设置页

### 5.1 配置存储

- `ProviderProfile` / `ActiveConfig` 概念原样保留。
- 当前配置与供应商档案列表：DataStore（Preferences），档案列表 JSON 序列化。
- API key：EncryptedSharedPreferences（Keystore 加密）单独存储。
- 默认供应商沿用扩展默认值：qwen + qwen-turbo；供应商清单与扩展保持一致（qwen / openai / deepseek / anthropic / groq / moonshot / siliconflow / custom）。

### 5.2 缓存

- Room 表：键哈希、译文、命中次数、创建时间、最近命中时间。
- 容量：默认 50MB / 5000 条（扩展的 200MB 对手机过大），LRU 淘汰，设置页可调。

### 5.3 主界面与设置页（Compose）

- 主界面极简：无障碍服务开启引导（唯一硬性前置）、服务运行状态、最近翻译历史（复用缓存表）。
- 设置页分组：供应商档案 / 语言与风格 / 触发与黑名单 / 缓存管理。

## 6. 整页翻译（分两期）

### v1：内置浏览器整页翻译（PageTranslateActivity）

- WebView + JS 注入：DOM 文本节点扫描、分批、双语标签替换、恢复原文——`extension/content.js` 整页逻辑移植为注入脚本。
- JSInterface 桥接：JS 把文本批次发给 Kotlin TranslationEngine，结果回填页面。
- 入口：App 内地址栏 + 系统「分享链接到 YuxTrans」。

### v1.1：全局屏幕翻译（ScreenTranslate）

- CaptureService 遍历当前窗口无障碍节点树，收集可见文本节点 + 屏幕坐标。
- 批量翻译复用扩展批量降级策略：JSON 数组批量请求 → 解析失败则单句并发补全，最多 3 次重试。
- 悬浮层按坐标原位覆盖译文，点按恢复原文。
- 已知风险：排版还原度差、复杂页面节点量大时性能吃紧、少数 App 屏蔽无障碍读取。需要真机调优，故单独一期。

## 7. 错误处理

- 统一 `TranslationError`（含 engine 与原始错误），沿用项目约定。
- 网络错误 / 429 → 悬浮窗显示可重试错误态；限速器冷却期间重试按钮带倒计时。
- API key 失效 → 提示并跳转设置页。
- 无障碍服务被系统杀掉（国产 ROM 常见）→ 主界面检测服务状态 + 重新引导开启。
- 日志：Android 侧用 `Log` 带 `YuxTrans` tag，对应扩展的 `[YuxTrans]` 前缀约定。

## 8. 测试策略

- TranslationEngine 纯 Kotlin 层：JUnit + MockWebServer 单测，覆盖供应商请求格式、SSE 解析、缓存键规则、校验器拦截、限速器行为——用例对照 `extension/tests/sw-modules.test.js` 移植。
- CaptureService / OverlayService 不做 UI 自动化（个人项目 ROI 低），真机手工验证。
- 命令：`./gradlew test`（Gradle 自带，无额外依赖）。

## 9. 明确不做（后续迭代候选）

- ~~整页翻译~~ → 已纳入 v1 / v1.1
- 拍照 / OCR 翻译
- 全局屏幕翻译（v1 不做，v1.1 做）
- iOS 版
- 自建后端 / 订阅制
- 配置云同步
- 语音输入翻译
