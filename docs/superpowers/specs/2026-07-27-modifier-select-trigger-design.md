# 修饰键+划选触发模式 — 设计文档

> 日期：2026-07-27
> 状态：已获用户批准（2026-07-27）
> 依据：用户反馈「按住 Ctrl（或自定义按键）+ 鼠标左键划选才触发划词翻译，体验更好，需解决快捷键冲突」

## 1. 背景与目标

当前划词触发模式三选一（`triggerMode`）：`auto`（选中即译，默认）/ `icon`（悬浮图标）/ `contextMenu`（右键菜单）。`auto` 模式下任何划选都会立即发起翻译，对「划选只是为了复制/阅读」的用户造成打扰与配额浪费。

新增第四种触发模式 `modifier`：**仅当按住修饰键划选时才触发翻译**，平时划选完全静默。该模式设为新的**默认**触发模式。

### 目标

- 触发模式变为四项单选：修饰键+划选（默认）/ 选中即译 / 悬浮图标 / 右键菜单。
- 修饰键可自定义：Ctrl / Alt / Shift，默认 Ctrl。
- 触发成功后行为与 `auto` 一致：直接弹出译文浮窗（不出浮钮）。
- 结构性规避快捷键冲突：不与复制、全选、链接点击、扩展选区等原生行为打架。

### 非目标（YAGNI）

- 不做「mousedown 武装 + 过程跟踪」的宽容检测（允许先松键后松鼠标）——后续如反馈手感问题再增强。
- 不支持 macOS Cmd（metaKey）修饰键选项；mac 用户引导至 Alt。
- 不改动 F1 悬停翻译、F2 双击词典、整页翻译的任何行为。
- 不删除 `auto` 模式；老用户 storage 中已存的 `triggerMode` 值不受影响。

## 2. 触发检测方案（已批准：方案 A）

**松手瞬间校验修饰键状态**。在 `content.js` 现有 `handleMouseUp` 触发点中，当模式为 `modifier` 时校验事件上的修饰键（按配置取 `e.ctrlKey / e.altKey / e.shiftKey`），按住才进入直译路径，否则静默返回。

不 `preventDefault`、不 `stopPropagation`、不注册任何键盘监听——浏览器与系统的全部快捷键行为保持原生。

### 冲突规避矩阵

| 场景 | 为何不冲突 |
|------|-----------|
| Ctrl+C 复制 | 划选时未按 Ctrl → 松手不触发；复制是其后的键盘事件，无 mouseup |
| Ctrl+A 全选 | 纯键盘操作，无 mouseup |
| Ctrl+V 粘贴 | 键盘事件，无选区变化触发链路 |
| Ctrl+点击链接（新标签打开） | 未产生选区 → 不触发 |
| Alt 激活浏览器菜单 | 触发条件是「Alt 单独按下并松开」；划选伴随鼠标操作，不满足 |
| Shift+点击扩展选区 | **已知权衡**：选 Shift 为修饰键时，扩展选区动作会触发翻译（有选区+按着 Shift）。设置 UI 中注明，默认 Ctrl 不受影响 |
| macOS Ctrl+左键 = 右键菜单 | **已知平台限制**：macOS 上 Ctrl+点击等效右键，会打断划选。设置 UI 注明「macOS 建议选 Alt」 |
| F1 悬停翻译修饰键 | 手势不同（悬停 vs 划选），互不干扰；两者可独立配置为不同键 |

### 输入框（F5）一致性

`handleMouseUp` 的 input/textarea 分支（F5 输入框翻译）同样加修饰键门槛：`modifier` 模式下，输入框内划选也须按住修饰键才触发，行为与普通文本一致。

## 3. 配置 schema

| 键 | 取值 | 默认 | 说明 |
|----|------|------|------|
| `triggerMode` | `'modifier' \| 'auto' \| 'icon' \| 'contextMenu'` | `'modifier'`（**由 `'auto'` 变更**） | 已有键，新增枚举值 |
| `selectionModifier` | `'ctrl' \| 'alt' \| 'shift'` | `'ctrl'` | 新增键 |

默认值变更点（需同步）：

- `extension/background.js` DEFAULT_CONFIG（约 322 行）：`triggerMode: 'auto'` → `'modifier'`，新增 `selectionModifier: 'ctrl'`
- `extension/content.js` 配置兜底（约 49 行）：同上
- `extension/lib/product-helpers.js` 偏好字段表（约 511 行）：加入 `selectionModifier`

注意：仅改**默认常量**。老用户 `chrome.storage` 中已持久化的 `triggerMode: 'auto'` 在升级后继续生效，不会被强制迁移——是否对老用户也改默认，取决于产品决定；本设计选择不动存量配置（保守，避免改变老用户既有行为）。

## 4. 实现要点

### 4.1 纯函数（`extension/lib/product-helpers.js`）

- `resolveTriggerAction(triggerMode)`：支持 `'modifier'`（含 `'modifier'`/`'modifierKey'` 等大小写容错形态按现有风格），未知值兜底 `'modifier'`（与新默认一致——需评估：现有兜底为 `'auto'`。决定：**兜底改为 `'modifier'`**，与新默认对齐；旧值 `'auto'` 显式命中不受影响）。
- 新增 `shouldRequireModifier(triggerMode)`：返回模式是否为 `modifier`。
- 新增 `isSelectionModifierPressed(eventLike, selectionModifier)`：纯函数，入参为含 `ctrlKey/altKey/shiftKey` 布尔字段的对象与修饰键名，返回是否按住；未知修饰键名按 `'ctrl'` 处理。该函数可在 Node 单测中直接用字面量对象测试。

### 4.2 content.js

- 配置加载处（约 123-129 行）：读取 `selectionModifier`（`ctrl|alt|shift` 白名单，兜底 `ctrl`）。
- `handleMouseUp`：
  - input/textarea 分支开头：若 `shouldRequireModifier` 且 `!isSelectionModifierPressed(e, this.config.selectionModifier)` → 返回（不触发）。
  - 普通文本分支的模式分派处（约 774-789 行）：新增 `modifier` 分支——修饰键未按住则 `hideFloatButton()` 后静默返回；按住则走与 `auto` 相同的 `translateText(selection, e.clientX, e.clientY)`。
- 其余链路（translateText → 浮窗 → SW）零改动。

### 4.3 options 页面

- `options.html`（约 450-452 行）：触发模式 radio 组新增 `<input type="radio" name="triggerMode" value="modifier"> 修饰键 + 划选`，置于首位并默认 `checked`（与静态默认一致）；radio 旁或下方加修饰键下拉行（id `selectionModifierRow`，结构复用 `hoverModifierRow` 模式），选项 Ctrl/Alt/Shift，附说明文案：「按住所选键划选才触发翻译。macOS 上 Ctrl+点击等效右键，建议选 Alt；Shift 会与扩展选区冲突」。
- `options.js`：
  - 元素引用、配置回显（约 426-438 行）、保存收集（约 1558 行）同步加 `selectionModifier`；
  - 下拉行显隐联动：仅 `triggerMode === 'modifier'` 时可用/可见（复用 hoverModifier 的 disabled 联动写法，约 494-496 行）。

### 4.4 样式

修饰键下拉行复用现有 `setting-row--sub` 等 class，不新增 CSS（如确需微调，遵守 `design-tokens.css` 的 `--yxt-*` 变量）。

## 5. 测试计划

- `extension/tests/product-helpers.test.js`：
  - `resolveTriggerAction('modifier')` → `'modifier'`；`'auto'/'icon'/'contextMenu'` 原断言不回归；未知值兜底 `'modifier'`。
  - `shouldRequireModifier`：modifier → true，其余 → false。
  - `isSelectionModifierPressed`：ctrl/alt/shift 各正反例；事件对象缺字段（undefined）按 false 处理；未知修饰键名按 ctrl。
  - 偏好字段表包含 `selectionModifier`。
- `extension/tests/content.test.js`（若现有挂载方式允许）：modifier 模式下无修饰键的 mouseup 不发起 sendMessage、按住时发起。若 content 类难以直接实例化，则在汇报中说明，由纯函数层覆盖主要逻辑。
- 全量 `npm test` 必须保持全绿。

## 6. 手动验收清单（真实浏览器）

1. 默认配置下：直接划选静默；按住 Ctrl 划选 → 出译文。
2. Ctrl+C 复制、Ctrl+A 全选、Ctrl+点击链接均不触发翻译。
3. 设置页切换修饰键为 Alt/Shift 生效；切回 auto/icon/contextMenu 原行为不变。
4. 输入框内 Ctrl+划选触发 F5 翻译，不按 Ctrl 不触发。
5. F2 双击词典、右键菜单翻译不受影响。

## 7. 受影响文件清单

| 文件 | 改动 |
|------|------|
| `extension/lib/product-helpers.js` | resolveTriggerAction 支持 modifier + 两个新纯函数 + 字段表 |
| `extension/content.js` | 配置读取 + handleMouseUp 两处门槛/分支 |
| `extension/background.js` | DEFAULT_CONFIG 默认值与 selectionModifier |
| `extension/options.html` | radio 第四项 + 修饰键下拉行 + 说明文案 |
| `extension/options.js` | 回显/保存/显隐联动 |
| `extension/tests/product-helpers.test.js` | 新增用例 |
| `extension/tests/content.test.js` | 视可测性补充 |
| `AGENTS.md` | 第 8 节配置说明同步（触发模式默认值变化） |
| `CHANGELOG.md` | [Unreleased] Added/Changed 条目 |
