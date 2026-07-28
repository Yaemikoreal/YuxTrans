# 修饰键+划选触发模式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第四种划词触发模式 `modifier`（按住修饰键+划选才翻译，默认 Ctrl），设为默认触发模式，结构性规避快捷键冲突。

**Architecture:** 检测逻辑下沉为 `lib/product-helpers.js` 纯函数（可 Node 单测）；`content.js` 仅在现有 `handleMouseUp` 触发点加门槛判断，不拦截/不 preventDefault 任何事件；options 页复用 `hoverModifierRow` 的 sub-row 显隐模式。设计依据：`docs/superpowers/specs/2026-07-27-modifier-select-trigger-design.md`。

**Tech Stack:** Chrome MV3 原生 JS，无构建；Node `node:test` 单测（`npm test`）。

**注意：** 全程不执行任何 git 提交操作（未获授权），改动留在工作区，完成后由用户决定是否提交。

---

### Task 1: product-helpers 纯函数 + 测试

**Files:**
- Modify: `extension/lib/product-helpers.js:17-46`（resolveTriggerAction 区）、`:508-531`（OPTIONS_MODULE_KEYS）、`:646-682`（导出表）
- Test: `extension/tests/product-helpers.test.js`

- [ ] **Step 1: 写失败测试**

在 `extension/tests/product-helpers.test.js` 中先 Grep 现有 `resolveTriggerAction` 用例，把「未知值兜底 `'auto'`」的既有断言改为兜底 `'modifier'`（spec 决策），并新增：

```js
  // modifier 触发模式：解析与修饰键判定
  assert.strictEqual(Helpers.resolveTriggerAction('modifier'), 'modifier');
  assert.strictEqual(Helpers.resolveTriggerAction('Modifier'), 'modifier');
  assert.strictEqual(Helpers.resolveTriggerAction(undefined), 'modifier'); // 新默认兜底
  assert.strictEqual(Helpers.resolveTriggerAction('auto'), 'auto'); // 旧值不受影响
  assert.strictEqual(Helpers.shouldRequireModifier('modifier'), true);
  assert.strictEqual(Helpers.shouldRequireModifier('auto'), false);
  assert.strictEqual(Helpers.shouldRequireModifier('icon'), false);
  // isSelectionModifierPressed：ctrl/alt/shift 正反例 + 防御
  assert.strictEqual(Helpers.isSelectionModifierPressed({ ctrlKey: true }, 'ctrl'), true);
  assert.strictEqual(Helpers.isSelectionModifierPressed({ ctrlKey: false, altKey: true }, 'ctrl'), false);
  assert.strictEqual(Helpers.isSelectionModifierPressed({ altKey: true }, 'alt'), true);
  assert.strictEqual(Helpers.isSelectionModifierPressed({ shiftKey: true }, 'shift'), true);
  assert.strictEqual(Helpers.isSelectionModifierPressed({}, 'ctrl'), false);
  assert.strictEqual(Helpers.isSelectionModifierPressed(null, 'ctrl'), false);
  assert.strictEqual(Helpers.isSelectionModifierPressed({ altKey: true }, 'unknown-mod'), false); // 未知修饰键按 ctrl
  assert.strictEqual(Helpers.isSelectionModifierPressed({ ctrlKey: true }, 'unknown-mod'), true);
  // OPTIONS_MODULE_KEYS.interaction 含 selectionModifier
  assert.ok(Helpers.OPTIONS_MODULE_KEYS.interaction.includes('selectionModifier'));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test extension/tests/product-helpers.test.js`
Expected: FAIL（`shouldRequireModifier is not a function` 等）

- [ ] **Step 3: 实现**

`extension/lib/product-helpers.js` 中替换 `resolveTriggerAction` 并新增两个函数：

```js
  /**
   * 解析划词触发模式动作
   * @param {string} triggerMode - modifier | auto | icon | contextMenu
   * @returns {'modifier'|'auto'|'icon'|'contextMenu'}
   */
  function resolveTriggerAction(triggerMode) {
    const mode = (triggerMode || '').toLowerCase();
    if (mode === 'auto') return 'auto';
    if (mode === 'icon') return 'icon';
    if (mode === 'contextmenu' || mode === 'context_menu' || mode === 'context' || mode === 'menu') {
      return 'contextMenu';
    }
    // modifier 为新默认模式：显式 'modifier' 与未知值均兜底到此
    return 'modifier';
  }

  /**
   * 该触发模式是否要求按住修饰键划选才触发
   * @param {string} triggerMode
   * @returns {boolean}
   */
  function shouldRequireModifier(triggerMode) {
    return resolveTriggerAction(triggerMode) === 'modifier';
  }

  /**
   * 事件上是否按住了配置的划选修饰键
   * @param {{ctrlKey?:boolean, altKey?:boolean, shiftKey?:boolean}|null|undefined} eventLike
   * @param {string} selectionModifier - 'ctrl' | 'alt' | 'shift'（未知值按 'ctrl'）
   * @returns {boolean}
   */
  function isSelectionModifierPressed(eventLike, selectionModifier) {
    if (!eventLike) return false;
    const mod = ['ctrl', 'alt', 'shift'].includes(selectionModifier) ? selectionModifier : 'ctrl';
    return !!eventLike[mod + 'Key'];
  }
```

`OPTIONS_MODULE_KEYS.interaction` 数组中 `'triggerMode',` 后插入 `'selectionModifier',`。导出表（`:646-682`）在 `shouldAutoTranslateOnSelect,` 后追加 `shouldRequireModifier,` 与 `isSelectionModifierPressed,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test extension/tests/product-helpers.test.js`
Expected: PASS

---

### Task 2: 默认值与配置加载（background.js + content.js）

**Files:**
- Modify: `extension/background.js:322`
- Modify: `extension/content.js:49`、`:123`

- [ ] **Step 1: background.js 默认配置**

`extension/background.js:322` 处：

```js
  triggerMode: 'modifier', // 'modifier'(默认 修饰键+划选) | 'auto' | 'icon' | 'contextMenu'
  selectionModifier: 'ctrl', // 'ctrl' | 'alt' | 'shift'（triggerMode=modifier 时生效）
```

（替换原 `triggerMode: 'auto',` 一行。）

- [ ] **Step 2: content.js 配置兜底**

`extension/content.js:49` 处 `triggerMode: 'auto',` 改为：

```js
      triggerMode: 'modifier',
      selectionModifier: 'ctrl', // 'ctrl' | 'alt' | 'shift'
```

`extension/content.js:123` 处 `this.config.triggerMode = response.triggerMode || 'auto';` 改为：

```js
        this.config.triggerMode = response.triggerMode || 'modifier';
        this.config.selectionModifier = ['ctrl', 'alt', 'shift'].includes(response.selectionModifier) ? response.selectionModifier : 'ctrl';
```

- [ ] **Step 3: 全量测试保持绿**

Run: `npm test`
Expected: 全绿（若 background.test.js 有断言默认 `triggerMode === 'auto'` 的用例，按新默认 `'modifier'` 更新并注明原因）

---

### Task 3: content.js 触发门槛

**Files:**
- Modify: `extension/content.js:734-747`（input 分支）、`:774-789`（模式分派）

- [ ] **Step 1: input/textarea 分支加门槛**

`handleMouseUp` 的 input 分支中，`if (!this.config.inputTranslate) return;`（约 :736）之后插入：

```js
      // modifier 模式：输入框内划选同样要求按住修饰键
      if (this.helpers.shouldRequireModifier(this.config.triggerMode) &&
          !this.helpers.isSelectionModifierPressed(e, this.config.selectionModifier)) return;
```

- [ ] **Step 2: 普通文本分支加 modifier 分派**

约 :779-787 处，在 `mode === 'contextMenu'` 分支之后、`mode === 'auto'` 分支之前插入：

```js
      if (mode === 'modifier') {
        this.hideFloatButton();
        // 松手瞬间校验修饰键：未按住则静默（不干扰复制/全选/链接点击等原生行为）
        if (!this.helpers.isSelectionModifierPressed(e, this.config.selectionModifier)) return;
        this.translateText(selection, e.clientX, e.clientY);
        return;
      }
```

- [ ] **Step 3: 全量测试保持绿**

Run: `npm test`
Expected: 全绿

---

### Task 4: options 页面（html + js）

**Files:**
- Modify: `extension/options.html:449-454`（radio 组）
- Modify: `extension/options.js:100-103`（元素引用）、`:426-428`（回显）、`:491-507`（显隐联动与监听）、`:1567`（保存收集）

- [ ] **Step 1: options.html radio 加第四项 + 修饰键下拉行**

`extension/options.html:449-453` radio 组改为（modifier 居首并默认 checked，auto 去掉 checked）：

```html
              <div class="radio-group">
                <label><input type="radio" name="triggerMode" value="modifier" checked> 修饰键 + 划选</label>
                <label><input type="radio" name="triggerMode" value="auto"> 选中后弹出</label>
                <label><input type="radio" name="triggerMode" value="icon"> 悬浮图标</label>
                <label><input type="radio" name="triggerMode" value="contextMenu"> 右键菜单</label>
              </div>
```

紧接该 `setting-row` 之后（:454 `</div>` 后、流式输出行之前）插入：

```html
            <div class="setting-row setting-row--sub" id="selectionModifierRow">
              <div class="setting-info">
                <label class="form-label" for="selectionModifier">划选修饰键</label>
                <p class="setting-desc">按住所选键 + 鼠标划选才触发翻译。macOS 上 Ctrl+点击等效右键，建议选 Alt；Shift 会与「扩展选区」冲突</p>
              </div>
              <select id="selectionModifier" class="setting-control">
                <option value="ctrl">Ctrl</option>
                <option value="alt">Alt</option>
                <option value="shift">Shift</option>
              </select>
            </div>
```

- [ ] **Step 2: options.js 元素引用与回显**

:102 `const hoverModifierSelect = getById('hoverModifier');` 后加：

```js
  const selectionModifierSelect = getById('selectionModifier');
```

:438 回显区加：

```js
    if (selectionModifierSelect) selectionModifierSelect.value = ['ctrl', 'alt', 'shift'].includes(config.selectionModifier) ? config.selectionModifier : 'ctrl';
```

- [ ] **Step 3: 显隐联动与事件监听**

`syncInteractionSubcontrols()`（:491-503）函数体内追加：

```js
    // 划选修饰键下拉仅 modifier 模式可用
    const selMode = document.querySelector('input[name="triggerMode"]:checked')?.value || 'modifier';
    const modifierModeOn = selMode === 'modifier';
    if (selectionModifierSelect) {
      selectionModifierSelect.disabled = !modifierModeOn;
      const row = getById('selectionModifierRow');
      if (row) row.classList.toggle('is-disabled', !modifierModeOn);
    }
```

:507 `dictModeInput?.addEventListener('change', syncInteractionSubcontrols);` 后加：

```js
  triggerModeRadios.forEach((radio) => radio.addEventListener('change', syncInteractionSubcontrols));
```

- [ ] **Step 4: 保存收集**

:1567 `hoverModifier: ...` 行后加：

```js
      selectionModifier: ['ctrl', 'alt', 'shift'].includes(getVal(selectionModifierSelect)) ? getVal(selectionModifierSelect) : 'ctrl',
```

- [ ] **Step 5: 全量测试保持绿**

Run: `npm test`
Expected: 全绿

---

### Task 5: content 行为测试（视现有挂载能力）

**Files:**
- Test: `extension/tests/content.test.js`

- [ ] **Step 1: 评估并实施**

先 Read `extension/tests/content.test.js` 现有挂载方式（如何构造 content 实例/DOM mock）。若现有机制允许以低成本构造 `handleMouseUp` 调用（fake event `{ ctrlKey: true, clientX, clientY }` + fake selection），新增两例：

```js
  // modifier 模式：未按修饰键的划选不发起翻译请求
  // modifier 模式：按住配置修饰键的划选发起 translateText（断言 sendMessage 被调用）
```

若需要搭建新 DOM/selection 基础设施才能测，则不新建基础设施——在 content.test.js 顶部加一行中文注释说明「modifier 门槛逻辑由 product-helpers 纯函数层覆盖」，并在完成汇报中注明。

- [ ] **Step 2: 全量测试保持绿**

Run: `npm test`
Expected: 全绿

---

### Task 6: 文档同步

**Files:**
- Modify: `AGENTS.md`（第 8 节配置说明）
- Modify: `CHANGELOG.md`（[Unreleased]）

- [ ] **Step 1: AGENTS.md**

第 8 节「缓存限额（默认 200MB）、触发模式、双语模式、站点黑白名单等」一行中补充触发模式默认值变化，改为类似：

```
- 缓存限额（默认 200MB）、触发模式（默认「修饰键+划选」modifier，可选 auto/icon/contextMenu；划选修饰键 ctrl/alt/shift 默认 ctrl）、双语模式、站点黑白名单等
```

- [ ] **Step 2: CHANGELOG.md [Unreleased]**

`### Added` 加：

```markdown
- **修饰键+划选触发模式** — `triggerMode` 新增 `modifier`（按住修饰键划选才翻译，松手瞬间校验，不拦截任何原生快捷键）；`selectionModifier` 支持 Ctrl/Alt/Shift，默认 Ctrl；输入框划选同门槛。macOS Ctrl+点击等效右键、Shift 与扩展选区冲突已在设置 UI 注明。
```

`### Changed` 加：

```markdown
- **默认触发模式变更** — 新安装默认由「选中即译(auto)」改为「修饰键+划选(modifier)」；老用户已存配置不受影响。`resolveTriggerAction` 未知值兜底随新默认改为 `modifier`。
```

- [ ] **Step 3: 最终全量验证**

Run: `npm test`
Expected: 全绿，汇报最终通过数

---

## Self-Review 记录

- **Spec 覆盖**：spec §3 配置 schema → Task 1（字段表）/2（默认值）；§4.1 纯函数 → Task 1；§4.2 content → Task 2/3；§4.3 options → Task 4；§5 测试 → Task 1/5；§6 手动验收 → 留给用户真实浏览器验证；§7 受影响文件 → Task 1-6 全覆盖（无 CSS 改动，复用现有 class）。
- **命名一致性**：`shouldRequireModifier` / `isSelectionModifierPressed` / `selectionModifier` / `selectionModifierRow` / `selectionModifierSelect` 全文一致。
- **占位符**：无 TBD/TODO；Task 5 的「视能力实施」是 spec §5 已批准的弹性条款，非占位。
