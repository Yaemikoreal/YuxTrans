我先把这些代码都过一遍，再结合实现给出贴合实际的建议。
代码版本比截图新不少（已经是 v2.0 token 体系了），我继续把剩下的文件读完。
样式部分看完了，再快速扫一下 JS 里的动态 UI 行为，把建议落到实处。
代码全部读完了（design-tokens / popup / options / content 四端 + JS 行为）。先修正我上一轮的判断：**截图是旧版，代码已是「书房衬纸 v2.0」**——token 体系、黄昏书房暗色、铅字开关、省略号加载、段控滑块、危险区、sticky 保存条、首次引导都已经落地，完成度比截图高得多。所以这轮建议不再是"补基础"，而是**在现有体系上做气质收束和细节抛光**。以下每条都对着具体代码说。

---

## 一、三个"气质级"问题（P0，改动小收益大）

**1. 中文伪斜体还留在三处，这是最伤阅读气质的一处。**
`.yuxtrans-bilingual-text`、`.yuxtrans-source`、`.yuxtrans-dict-example-target` 都挂着 `font-style: italic`。整页双语场景下大段中文被机械倾斜，长读会发虚，也与"衬纸批注"的克制相悖。建议：双语译文去掉斜体，仅靠「暮瞳竖线 + 0.9em + 灰墨色」区分（这三个信号已经足够）；原文区如果想弱化，用 `--yxt-text-tertiary` 即可。西文斜体可以保留，用 `:lang(en)` 之类的选择器按语种区分，中英各得其所。

**2. 定义了墨色强调色，却没有任何一个按钮用它。**
tokens 里 `--yxt-accent: var(--yxt-ink)` 摆在那里，但 `.btn-primary`、`.action-btn`、`.yuxtrans-btn` 三个"主按钮"全是纸底 + 15% 墨边——和 `.btn-secondary` 只差一条边框透明度。「翻译整页」「保存并启用档案」「立即下载 ZIP」是各自界面的主动作，现在读起来全是次级。建议把 `.btn-primary` 做成**墨实心 + 纸色字**：`background: var(--yxt-ink); color: var(--yxt-paper); border: none;`，hover 落到 `--yxt-ink-80`。妙处是暗色模式下 ink 反转变浅、paper 变深，这套主按钮**自动适配黄昏书房，一行媒体查询都不用加**。由此形成清晰的三级按钮体系：墨实心（主）/ 描边（次）/ 透明幽灵（三级）。

**3. 暮瞳紫承担了一切强调，"微光"变成了"主灯"。**
现在 dusk 管着：tab 激活条、章节竖线、选中态、focus 环、所有进度条（页翻/模型下载/存储）、词典词性 chip、引导卡描边……README 自己说"暮瞳作微光"，但代码里它是唯一强调色，整个界面其实偏向薰衣草调了。建议重新分层：**墨管行动（主按钮、关键文字、打勾），暮瞳只管"与阅读相关的微光"**——当前句高亮 `.yuxtrans-highlight`、双语竖线、悬停段落描边保留 dusk；模型下载进度条、存储进度条改墨色系（`--yxt-ink-60`）；checkbox 的 `accent-color` 从 dusk 改 ink（墨色打勾比紫色打勾更"书房"）。一个强调色管一切 = 没有强调。

---

## 二、一致性问题（P1）

**4. 开关依然是两套语言。** Popup 的「流式翻译」是自定义 `.paper-toggle`（方头铅字拨杆），而 options 里**同一个「流式输出」**是原生 checkbox + dusk accent。建议把 `.paper-toggle` 的 markup/CSS 提到 tokens 层共享，options 的设置行全部换成它——设置行"左标签右拨杆"比"左标签右小方框"扫读效率高，且两端终于同构。

**5. Toast 有四套实现。** popup 的 `.toast`（底部）、options 的 `.status`（顶部）、content 的 `.yuxtrans-site-rule-toast`（底部）和 `.yuxtrans-page-toast`（顶部，还多一条 dusk 描边）。规格其实已经很接近，建议收敛成一份规范：扩展内部界面统一底部居中，页内注入统一底部居中（避开页控条一侧），success/error 统一走 `*-soft` 底 + 状态色字的模式，删掉 page-toast 那条特立独行的紫边。

**6. 下划线表单在稀疏区好看，在密集区失效。** 单字段场景（语言偏好）下划线确实很编辑感；但「自定义供应商」5 个字段连排、首次引导表单里，无边框输入域的边界感很弱，select 和 input 看起来一模一样。建议：密集表单组内改用完整描边输入框（`--yxt-border` 全边 + focus 时 dusk 描边），稀疏区保留下划线；下拉箭头 SVG 从 10px 提到 12px、描边用 `--yxt-annotation` 实色而非写死的 `#9E968A`。

**7. content.css 把 tokens 整份抄了一遍。** 注释里自己也承认"与 design-tokens.css 保持一致"——双份维护迟早漂移。manifest 的 `content_scripts.css` 数组是有顺序的，把 `design-tokens.css` 排在 `content.css` 前面注入，删掉 content.css 里的整个 `:root` 块，单一来源。（顺带：popup.css 的 model-select 下划线用 `--yxt-text-secondary`，options 用 `--yxt-annotation-50`，也顺手统一。）

---

## 三、细节完成度（P2，按界面）

**整页页控条（content.js 1944 行起）**
- 翻译完成后条子一直挂着全量文本「完成 29/104 · 缓存 6 / API 57」，建议完成 5 秒后自动收成一枚小 chip（只留「恢复原文 · 双语 · ×」），把页面还给读者——这才配得上"让读者忘记工具"；
- 「恢复原文」是完成后的主动作，给它描边实体化；「双语」加激活态指示（底部 dusk 小短线），现在它是不是激活全靠用户记；「关闭」改成 × 图标降级；
- shimmer 动画 `translateX(-16px → 96px)` 是写死像素，进度条宽度却是百分比——5% 进度时微光基本不可见，改成百分比行程（`::after` 宽 40%，left 从 -40% 走到 100%）。

**流式渲染**
`.yuxtrans-streaming-text` 现在是整段文字呼吸。更符合"正在书写"意象的做法：文字稳定，在流式 span 末尾加一个**暮瞳色细光标 `▍` 闪烁**（`::after` + opacity 动画）。与省略号加载、批注竖线是同一套语言，一套"笔尖"意象闭环。

**划词浮窗**
- header 的「YuxTrans」是品牌噪音，换成「EN → 中 · DeepSeek」这类真实信息，高级感立刻不同；
- 底部四个动作里「差译」是破坏性操作却与「复制」同权重，建议 hover 才显 error 色；
- 词典卡 `.yuxtrans-dict-pos` 是 dusk 字 + dusk-12 底，对比度偏低，改 `--yxt-ink-60`；
- 双语对照阅读时，hover 某句译文可联动高亮对应原文（你们已有配对数据结构，加个 hover class 就行），是"对照"体验的点睛。

**空态**
`.model-list-empty`、「暂无失败记录」「暂无请求日志」目前都是一行灰字。画一枚极简墨线小书签/空卷轴（20 行 inline SVG 以内）+ 一行引导文案，空态也是书房的一部分。

**首次引导**
两处硬 bug：`--yxt-text-muted` 在 tokens 里**根本不存在**（first-run-sub、path-card span、trial-dst 三处引用，实际 fallback 成继承色）；字重 650/600 违反自己定的"克制字重（bold=500）"规范。另外第 3 步试译成功时，结果框可以加一圈 success 细边 + 一个小「译」字印章式的完成标记——第一次成功值得一个克制的小仪式。

---

## 四、顺手抓到的小 bug 与缺口

- `.request-log-item .log-block` 用了 `--yxt-font-mono`，tokens 里**没有定义这个变量**，日志块会掉回衬线字体——定义一个或直接复用 `code` 的等宽栈；
- `.stats-summary::before` 用 ▸/▾ 字符交换，两个 glyph 宽度不同会抖动，改成同一个三角形 `transform: rotate(90deg)`；
- `.yuxtrans-hover-guide` 和 `.yuxtrans-page-control` 都是 `right/bottom: 24px`，首次触发悬停翻译时两者会叠在一起，guide 需要避让偏移；
- options 所有 button 没有 `:focus-visible` 样式，输入控件 `outline: none` 后只剩下划线变色——键盘导航完全不可见，全局补 `--yxt-shadow-glow` 焦点环；
- 全项目没有 `prefers-reduced-motion` 处理，shimmer/pulse/slideIn 应在该媒体查询下关闭；
- popup 的 `.mode-toggle` 有 `role="group"` 但按钮缺 `aria-pressed`；options 的 `.status` toast 缺 `aria-live`（划词浮窗的 loading 有 `aria-live="polite"`，做对了一半）；
- 宿主页是暗色、系统是亮色时，注入的浅暖纸浮窗和灰墨译文会直接"隐身"——值得加一个"跟随页面明暗"的探测或手动开关，这是内容脚本特有的坑。

---

## 落地顺序建议

先做 P0 三件（去中文斜体、墨实心主按钮、暮瞳分层），半天工作量，气质统一度跃升；然后 P1 的开关共享与 toast 收敛；P2 细节随迭代随手做；无障碍那组（focus 环 / reduced-motion / aria）建议单独开一个 commit 集中补，它们是"高级感"里最容易被忽略、但评测和商店审核都会看的部分。

需要的话，我可以直接按这份清单把对应 CSS 改出来给你——比如先出 P0 三件套的具体 diff。