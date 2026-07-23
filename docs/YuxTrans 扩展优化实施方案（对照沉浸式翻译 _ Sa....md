YuxTrans 扩展优化实施方案（对照沉浸式翻译 / Saladict）                                                                                               │

│                                                                                                                                                      │

│ │ 目标：把上一轮讨论确定的 8 个优化方向落成可执行的代码改动。                                                                                        │

│ │ 全部改动在 extension/ 内，沿用现有架构（SW 纯函数模块 + background 编排 + content 单类），无新依赖、无构建步骤。                                   │

│ │ 分 4 个阶段，每阶段独立可交付、可回归。                                                                                                            │

│                                                                                                                                                      │

│ 现状关键事实（已核实）                                                                                                                               │

│                                                                                                                                                      │

│ • content.js（1723 行，单类 YuxTransContent）：划词 handleMouseUp :203 → translateText :290 → showPopup :414 / updatePopup :475；整页                │

│   collectTextNodes :589、applyTranslation :838；流式走一次性 sendMessage + background 广播 streamChunk；无 storage.onChanged 监听，配置可能过期。    │

│ • background.js：消息 if/else 链 :2744；translate :1973、translateWithStream :1739、translateBatchInternal :2146；buildRequest :1424（支持           │

│   jsonMode）、translateWithCloud :1629（支持 providerOverride）；缓存校验 validateCacheEntry :928，MIN\_CACHE\_SOURCE\_LENGTH=12 :810。                 │

│ • 缓存键 lib/sw/cache-keys.js：v3:p1:\:\:\:\:\，generateCacheKey(text,src,tgt,style,model) 已支持显式 model 参数 →      │

│   style 段可当 mode 段用（dict），无需 bump 版本。                                                                                                   │

│ • 设置：保存按钮制；新设置 = background.js:290 默认 config 加键 + options.html/options.js 加 UI + setConfig 透传。                                   │

│ • 测试：node --test extension/tests/，纯函数放 lib/product-helpers.js / lib/sw/\* 再配 _.test.js。                                                    │_

_│                                                                                                                                                      │_

_│ 阶段总览                                                                                                                                             │_

_│                                                                                                                                                      │_

_│ ┌─────────┬────────────────────────────────────────────────────────────┬────────────────────────────────┐                                            │_

_│ │ 阶段    │ 功能                                                       │ 主要改动面                     │                                            │_

_│ ├─────────┼────────────────────────────────────────────────────────────┼────────────────────────────────┤                                            │_

_│ │ P0 公共 │ 配置变更实时同步 content                                   │ content.js                     │                                            │_

_│ ├─────────┼────────────────────────────────────────────────────────────┼────────────────────────────────┤                                            │_

_│ │ P1      │ F1 悬停段落翻译、F2 单词词典模式                           │ content.js + SW + options      │                                            │_

_│ ├─────────┼────────────────────────────────────────────────────────────┼────────────────────────────────┤                                            │_

_│ │ P2      │ F3 译文显示样式（弱化/模糊原文）、F4 浮窗 pin + 双档案对照 │ content.js/css + SW + options  │                                            │_

_│ ├─────────┼────────────────────────────────────────────────────────────┼────────────────────────────────┤                                            │_

_│ │ P3      │ F5 输入框翻译、F6 正文区域识别                             │ content.js + options           │                                            │_

_│ ├─────────┼────────────────────────────────────────────────────────────┼────────────────────────────────┤                                            │_

_│ │ P4      │ F7 谷歌免费接口、F8 Ollama 推荐分档                        │ SW + options + manifest + 脚本 │                                            │_

_│ └─────────┴────────────────────────────────────────────────────────────┴────────────────────────────────┘                                            │_

_│                                                                                                                                                      │_

_│ ────────────────────────────────────────────────────────────────────────────────                                                                     │_

_│                                                                                                                                                      │_

_│ P0 — 配置变更实时同步（前置小改动）                                                                                                                  │_

_│                                                                                                                                                      │_

_│ 问题：content.js 只在 init() :54 和 translatePage() :939 拉配置；P1–P3 的新开关（hover、dict、显示样式）需要改后即时生效。                           │_

_│                                                                                                                                                      │_

_│ • content.js bindEvents() :143 内新增：                                                                                                              │_

_│   `js                                                                                                                                              │`_

_`   │     chrome.storage.onChanged.addListener((changes, area) => {                                                                                        │`_

_`   │       if (area === 'local' && changes.config) this.loadConfig();                                                                                     │`_

_`   │     });                                                                                                                                              │`_

_`    │    `                                                                                                                                                │_

_│ • loadConfig() :57 已合并默认值，直接复用；注意它内部会覆盖 this.config，确认无并发读写冲突即可（现有调用方均为事件驱动，安全）。                    │_

_│                                                                                                                                                      │_

_│ ────────────────────────────────────────────────────────────────────────────────                                                                     │_

_│                                                                                                                                                      │_

_│ P1 — 悬停段落翻译 + 单词词典模式                                                                                                                     │_

_│                                                                                                                                                      │_

_│ F1 悬停段落翻译（对标沉浸式翻译 hover）                                                                                                              │_

_│                                                                                                                                                      │_

_│ 交互：按住修饰键（默认 Alt，可选 Ctrl）+ 鼠标悬停段落 → 段落显示虚线描边 → 停留 300ms 后在段落后插入译文块；译文块带 × 关闭；已译段落不重复触发。    │_

_│                                                                                                                                                      │_

_│ content.js                                                                                                                                           │_

_│ 1. 配置默认值（实例属性 :33-47 区域）：hoverTranslate: true、hoverModifier: 'alt'。                                                                  │_

_│ 2. bindEvents() 新增 mousemove（passive + 120ms 节流）与 keydown/keyup（Esc 取消当前 hover 状态）。mousemove 处理器：                                │_

_│     • this.config.hoverTranslate 且 e.altKey/e.ctrlKey（按 hoverModifier）否则直接返回；                                                             │_

_│     • resolveHoverParagraph(e.target)：自 target 向上找最近块级元素（P, LI, H1-H6, BLOCKQUOTE, TD, DD, DT, FIGCAPTION）；排除：PRE/CODE、自身        │_

_│       UI（.yuxtrans-_）、input/textarea/\[contenteditable]、已 hover 翻译过（data-yxt-hover-done）、整页双语已覆盖节点、文本 \< minTextLength 或 >     │

│       1500 字符（超长截断并标记）。                                                                                                                  │

│ 3. 命中后：元素加 .yuxtrans-hover-target 描边；300ms 定时器内未移出则 translateHoverParagraph(el)：                                                  │

│     • 提取 el.textContent.trim()，发 \{action:'translate', text, sourceLang, targetLang, context: getPageContext(), requestId:'hover-N'}（v1 走非流式 │

│       ，段落普遍 >12 字符缓存正常生效）；                                                                                                            │

│     • 在 el 后插入 \\×\\…\\，流式升级留作后续（streamChunk 按 requestId 路由的机制现成）；                                       │

│     • el.dataset.yxtHoverDone = '1'；restoreOriginalTexts() :1484 末尾追加清理所有 .yuxtrans-hover-translation。                                     │

│ 4. 纯函数下沉 lib/product-helpers.js：isHoverParagraphCandidate(\{tagName, textLen, inExcluded}) 等判定逻辑，配 product-helpers.test.js 用例。        │

│                                                                                                                                                      │

│ content.css（自包含令牌区无需改色）：                                                                                                                │

│ • .yuxtrans-hover-target \{ outline: 1.5px dashed var(--yxt-dusk-40); outline-offset: 2px; }                                                          │

│ • .yuxtrans-hover-translation：左侧 2px solid var(--yxt-dusk-40)、--yxt-paper-98 底、--yxt-text-sm、--yxt-radius-sm，继承书房风格；暗色由令牌自动覆  │

│   盖。                                                                                                                                               │

│                                                                                                                                                      │

│ options.html/options.js：「划词翻译」section 加开关 hoverTranslate + 修饰键 select（Alt/Ctrl），照抄 autoCopy 模式（options.html:402 区域 +          │

│ options.js 回填 :297 区域 + saveBtn 收集 :1286 区域）。                                                                                              │

│                                                                                                                                                      │

│ background.js：默认 config（:290-326）加 hoverTranslate: true, hoverModifier: 'alt'。SW 逻辑零新增。                                                 │

│                                                                                                                                                      │

│ F2 单词词典模式（对标 Saladict 词典面板）                                                                                                            │

│                                                                                                                                                      │

│ 交互：划到单个词 → 浮窗变词典卡片（词 / 音标 / 词性义项 / 双语例句）；双击单词直出词典卡片（跳过浮钮）。LLM 结构化输出，独立缓存键。                 │

│                                                                                                                                                      │

│ content.js                                                                                                                                           │

│ 1. 配置：dictMode: true、dictDblclick: true。                                                                                                        │

│ 2. lib/product-helpers.js 新增纯函数 isSingleWord(text)：trim 后无内部空白、匹配 /^\[\p\{L}]\[\p\{L}\p\{M}'’-]\*\[\p\{L}]$/u、长度 ≤ 30。配测试。 │ │ 3. translateText() :290 入口判断：this.config.dictMode && helpers.isSingleWord(text) → 走 lookupWord(text, x, y)，否则原路径。 │ │ 4. bindEvents() 加 dblclick：dictDblclick 开启时取 window.getSelection().toString()（浏览器双击自动选词），命中 isSingleWord 直接 │ │ lookupWord（triggerMode 为 icon/contextMenu 也直出）。 │ │ 5. lookupWord(word, x, y)：复用 showPopup 骨架，标题区显示单词；.yuxtrans-target 替换为词典容器 .yuxtrans-dict（loading 复用）；发 │ │ {action:'lookupWord', text: word, sourceLang, targetLang, context: getPageContext(), requestId:'popup'}。 │ │ 6. 渲染 renderDictResult(data)：成功且有结构化 dict → 音标行 + 义项列表（pos 徽章 + 释义 + 例句对）；只有 raw → 按纯文本渲染（本地小模型降级 │ │ ）；cached 徽章复用现有状态条。复制按钮复制纯文本版。 │ │ │ │ lib/sw/translate-core.js │ │ • 新增 SW.buildDictionaryPrompt(word, sourceLang, targetLang)：要求严格 JSON 输出，schema： │ │ ```json │ │ {"word":"…","phonetic":"…","senses":[{"pos":"n.","meaning":"…","examples":[{"source":"…","target":"…"}]}]} │ │ ``` │ │ 约束：≤4 个义项、每义项 1–2 条例句、仅输出 JSON。不注入 style/context（词典模式与风格无关）。 │ │ │ │ lib/sw/message-actions.js：MESSAGE_ACTIONS 数组加 'lookupWord'，classifyMessageAction 归入 translate 类。 │ │ │ │ background.js │ │ 1. 默认 config 加 dictMode: true, dictDblclick: true。 │ │ 2. onMessage 链（:2744 起）加分支 → lookupWord(word, sourceLang, targetLang)： │ │ • 缓存键：generateCacheKey(word, src, tgt, 'dict')（style 段复用为 mode 段，格式不变、不撞正常译文）； │ │ • 请求：buildRequest(buildDictionaryPrompt(...), false, null, /*jsonMode*/ true)，复用 translateWithCloud 的请求/限流路径； │ │ • 解析降级链（仿 :2264-2293 批量路径）：JSON.parse → __INLINE_CODE_1__`js │ │ const RECOMMENDED_MODELS = [ │ │ { id: 'qwen3.5:0.8b', label: '最快（低配/纯 CPU）', size: '约 1GB' }, │ │ { id: 'translategemma:4b', label: '推荐（专用翻译模型）', size: '约 3.3GB', recommended: true }, │ │ { id: 'translategemma:12b',label: '最佳质量（高端机/GPU）', size: '约 8GB' } │ │ ]; │ │ ``` │ │ Ollama 状态卡改为分档 radio + 每项「复制拉取命令」；未设置 localModel 时默认选中 translategemma:4b（存量配置不变）。 │ │ • 首次引导文案（options.js:406 区域）同步为分档描述。 │ │ • setup-ollama.bat / setup-ollama.sh：模型名参数化（默认 qwen3.5:0.8b，%1/$1 覆盖），结尾打印三档建议。                                              │

│ • docs/PROVIDERS.md 若含本地模型推荐段落，同步更新。                                                                                                 │

│                                                                                                                                                      │

│ ────────────────────────────────────────────────────────────────────────────────                                                                     │

│                                                                                                                                                      │

│ 收尾（每阶段提交前）                                                                                                                                 │

│                                                                                                                                                      │

│ • node --test extension/tests/ 全绿；新纯函数均有用例。                                                                                              │

│ • 手动浏览器验证清单（每阶段对应功能主路径 + 一次整页翻译回归）。                                                                                    │

│ • 全部完成后：manifest.json version → 0.5.0，CHANGELOG.md 记 0.5.0，docs/PRODUCT\_OPTIMIZATION.md 顶部执行状态追加勾选，AGENTS.md §12 若行为约定有变  │

│   则同步。                                                                                                                                           │

│                                                                                                                                                      │

│ 明确不做                                                                                                                                             │

│                                                                                                                                                      │

│ • PDF / EPUB / 视频字幕（独立工程，维持 PRODUCT\_OPTIMIZATION.md 结论）                                                                               │

│ • Bing 免费接口（Edge token 流程复杂、收益与谷歌重叠）                                                                                               │

│ • 真实词典 API 聚合、生词本 / Anki 同步                                                                                                              │

│ • contenteditable 输入框翻译（v2 再议）                                                                                                              │

│ • 悬停翻译的流式渲染（v1 非流式，机制预留）                                                                                                          │

│                                                                                                                                                      │

│ 实施顺序与工作量预估                                                                                                                                 │

│                                                                                                                                                      │

│                                                                                                                                                  `│`

&#x20;  `│   P0（0.5h）→ P1（1–1.5 天）→ P2（1 天）→ P3（0.5–1 天）→ P4（0.5–1 天）                                                                             │`

&#x20;  `│`                                                                                                                                                  │

│                                                                                                                                                      │

│ 每阶段结束即运行 node --test extension/tests/ + 手动回归，独立可发。
