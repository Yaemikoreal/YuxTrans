# 交互功能冲突修复 — 设计文档

> 日期：2026-07-28
> 状态：范围已获用户批准（全量修复，2026-07-27）
> 依据：对 `extension/content.js`（2631 行）的全量事件/DOM/状态/配置冲突排查，共 17 个有代码证据的冲突点

## 1. 背景

content.js 单类承载划词、词典、悬停、整页、双语、动态观察、输入框 7 个功能域，功能叠加后出现事件链路、修饰键、DOM、状态、配置联动五类冲突。用户反馈「交互和显示几个功能点之间偶有冲突」。本文档定义全部修复策略。

## 2. 冲突清单与修复策略

### 高严重度

**#4 浮窗串台（响应写错浮窗）**
- 现状：所有响应回调写 `this.popup` 而非捕获的浮窗引用（content.js:514-522、720-728、887-915）；`requestId: 'popup'` 恒路由到当前浮窗。翻译在途时 pin 或快速连划 → 旧响应写进新浮窗。
- 修复：每请求生成唯一 `requestId`（`popup-<递增计数>`）；content 维护 `_popupRequests: Map<requestId, popupElement>`；`translateText`/`lookupWord` 发出请求时登记，回调/流式 chunk 按 requestId 查映射写入捕获的浮窗；浮窗不在 DOM 时丢弃响应并清理映射；`showPopup`/`pinPopup`/`hidePopup` 时同步清理无效映射。需先确认 SW 在 translateStream 的 streamChunk 与 translate/lookupWord 响应中原样回传 requestId（若 SW 不回传则在 SW 补透传）。

**#6 hoverModifier 与 selectionModifier 同键冲突**
- 现状：`_handleHoverMouseMove`（content.js:328-347）不检查鼠标按键状态，划选拖动中悬停 300ms 即触发悬停翻译，插入 DOM 块破坏选区并永久打 `yxtHoverDone`。
- 修复：① content 侧 `_handleHoverMouseMove` 增加 `e.buttons !== 0` 守卫（按键按下即划选/拖拽中，不触发悬停）；② options 侧 `syncInteractionSubcontrols` 检测 hoverTranslate 开 + triggerMode=modifier + 两键相同 → 在划选修饰键行显示警告文案（不阻断保存）。

**#5 对照模式 pinned 浮窗无限累积**
- 现状：`translateWithCompareProfile` 每次划词自动 pin 主浮窗（content.js:631），只增不减。
- 修复：替换语义——记录 `this._compareMainPopup`，新一次对照 pin 主浮窗前先移除旧对照主浮窗（仅自动 pin 的那个，手动 pin 不动）。

### 中严重度

**#11 isTranslating 共享静默吞操作**
- 现状：单标志被 `lookupWord`（:495）与 `translateText`（:855）共用，一方在途另一方静默 return；SW 不回包则永久卡死。
- 修复：拆为 `isTranslating`（划词）与 `isDictLookingUp`（词典）两个独立标志，各自只守本入口；各配 70s 看门狗定时器（对齐流式超时 65s，到点复位并 `console.warn('[YuxTrans] ...')`），请求完成时清除。

**#14 inputTranslate 无视 triggerMode**
- 现状：input 分支（content.js:736-751）在 contextMenu/icon 模式下也直接弹窗。
- 修复：input 分支补齐模式语义——`contextMenu` 直接 return；`icon` 走 `showFloatButton`（点击后翻译，`_lastInputElement` 已设，F5 插入能力保留）；`auto` 直译；`modifier` 维持修饰键门槛。

**#17 悬停翻译绕过站点黑白名单**
- 修复：hover 入口（`_handleHoverMouseMove` 或 `_translateHoverParagraph`）补 `isSiteAllowed()` 检查。

**#1 双击双触发**
- 现状：双击的第二次 mouseup 先触发划词逻辑，10ms 后 dblclick 再触发查词，可能双请求。
- 修复：`handleMouseUp` 利用 `e.detail >= 2`（连击计数）——双击且 dictDblclick 开且选区为单词 → 跳过，交给 `_handleDblClick` 统一处理。

**#2 icon 模式双击后浮钮残留**
- 修复：`_handleDblClick` 开头与 `showPopup` 开头调 `hideFloatButton()`。

### 低严重度

- **#8C 悬停失败不可重试**：`yxtHoverDone` 改为仅翻译成功时打标记，失败显示错误但允许再次悬停重试。
- **#8A 自身 UI 被整页翻译**：`collectTextNodes` skipSelectors 补 `.yuxtrans-hover-guide`、`.yuxtrans-page-toast`。
- **#8B 译文被再次划词翻译**：`handleMouseUp` 排除列表补 `.yuxtrans-hover-translation, .yuxtrans-bilingual-text, .yuxtrans-streaming-text`。
- **#9 MutationObserver 被自身 UI 触发全页扫描**：`_onMutations` 前置过滤——全部 addedNodes 位于自有 UI（`.yuxtrans-*` 容器）内时直接 return，不进防抖与全页扫描。
- **#3 mousedown 误关浮窗**：`handleMouseDown` 排除列表补 `.yuxtrans-page-control`、`.yuxtrans-hover-translation`、`.yuxtrans-hover-guide`。
- **#13 动态增量与整页主流程共用标志**：`_processAddedNodes` 改用独立标志（如 `_dynamicTranslating`），不再占用 `pageTranslationState.isTranslating`，消除「增量翻译中按 Ctrl+Shift+P 被当作取消」的边缘情况。

### 保持现状并文档化

- **#15**：contextMenu 模式下双击查词直出为有意设计（code comment 明言），options 双击查词行的说明文案补充「右键菜单模式下仍生效」。
- **#16**：输入框内双击查词不生效（选区机制限制），同一说明文案注明「输入框内请划选单词」。

## 3. 测试计划

沿用 `extension/tests/content.test.js` 现有 harness（chrome mock + FakeElement + helpers 注入，已验证可驱动 handleMouseUp）：

- 双击守卫：`e.detail=2` + 单词选区 → 不发翻译请求；
- input 分支模式门控：contextMenu 不发请求；icon 出浮钮；
- 译文选择器排除：选区位于 `.yuxtrans-bilingual-text` 内 → 不触发；
- `showPopup` 清除浮钮；
- requestId 映射：模拟两请求交替返回，断言各自写入正确浮窗；浮窗销毁后响应被丢弃；
- 拆分标志：词典在途不阻塞划词（及反向）。
- hover 守卫与 options 同键警告为薄逻辑，浏览器手验。

全程 `npm test` 保持绿。

## 4. 受影响文件

| 文件 | 改动 |
|------|------|
| `extension/content.js` | #1-#6、#8-#14、#17 全部主体修复 |
| `extension/background.js` | 仅当 SW 未透传 requestId 时补透传 |
| `extension/options.js` | #6 同键警告、#15/#16 说明文案（如需） |
| `extension/options.html` | #15/#16 说明文案、#6 警告元素 |
| `extension/tests/content.test.js` | 新增行为用例 |
| `CHANGELOG.md` | [Unreleased] Fixed 条目 |

## 5. 手动验收清单（真实浏览器）

1. 流式划词翻译在途时 pin 浮窗 → 再划词，两浮窗内容不串台。
2. hoverModifier 与 selectionModifier 同设 ctrl：按住 ctrl 划选不再触发悬停翻译；options 出现同键警告。
3. 开双档案对照连续划词 3 次：屏幕最多 1 个对照主浮窗 + 1 个对照浮窗。
4. 划词翻译在途时双击查词：词典正常出，不再静默吞掉。
5. contextMenu 模式选输入框文本：不弹窗；icon 模式：出浮钮。
6. 黑名单站点悬停段落：不触发翻译。
7. 双击单词：只查一次词典；icon 模式双击后无浮钮残留。
8. 悬停翻译失败段落：移开再悬停可重试。
