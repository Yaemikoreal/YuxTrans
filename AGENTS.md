# YuxTrans — 给 AI 编码助手的项目指南

本文档面向后续维护本项目的 AI 编码助手。阅读本文前，可默认对项目一无所知；本文基于当前仓库实际内容整理，不引入外部假设。

## 1. 项目概述

YuxTrans 是一款面向深阅读的 AI 翻译工具，核心目标是「响应速度是生命，翻译准度是底线」。

当前唯一产品是**浏览器扩展**（`extension/`）— Chrome / Edge 划词翻译插件（Manifest V3），**独立运行，无后端**，直接在 Service Worker 中调用云端 API 或本地 Ollama。Python 包已移除；安卓端为后续版本 roadmap 选项之一，设计与实现计划留存于 `docs/superpowers/`。

当前版本：浏览器扩展 `0.4.1`。

## 2. 仓库结构（重要）

项目根目录为 `E:/Pythonproject/YuxTrans`。关键目录如下：

```
E:/Pythonproject/YuxTrans
├── extension/                   # 浏览器扩展源码（Manifest V3，唯一产品）
│   ├── manifest.json
│   ├── background.js            # Service Worker（核心）
│   ├── lib/sw/                  # SW 纯函数模块（constants / cache-keys / providers-core / lang / translate-core / message-actions 等）
│   ├── content.js               # 内容脚本（划词 + 整页翻译）
│   ├── content.css              # 书房衬纸风格样式（详见 docs/UI_DESIGN_SYSTEM.md）
│   ├── design-tokens.css        # 设计令牌（--yxt-* 变量）
│   ├── popup.html / popup.js    # 弹窗界面
│   ├── options.html / options.js# 设置页面
│   └── tests/                   # 扩展单元测试（node --test）
├── docs/                        # 项目文档
│   └── superpowers/             # 安卓端 spec 与实现计划（roadmap，未实现）
├── logo/                        # 品牌资源与使用样例
├── scripts/                     # 工具脚本（如 generate_extension_icons.py）
├── package.json                 # Node 测试脚本（node --test）
└── README.md / CHANGELOG.md / CLAUDE.md / CONTEXT.md
```

### 结构注意事项

1. 根目录 `.git` 是唯一的版本控制入口。
2. 修改扩展代码只在 `extension/` 下进行；扩展单元测试只修改 `extension/tests/`。

## 3. 技术栈

- **平台**：Chrome / Edge（Chromium 内核）
- **Manifest**：V3
- **脚本**：原生 JavaScript（无构建步骤）
- **样式**：原生 CSS
- **存储**：`chrome.storage` + IndexedDB
- **测试**：Node 内置 test runner（`node:test`）

## 4. 核心架构

扩展是**完整的独立应用**：

```
划词 / 右键 / 快捷键
       │
       ▼
content.js ── chrome.runtime.sendMessage ──► background.js (Service Worker)
       ▲                                            │
       └──────── 翻译浮窗 / 整页覆盖 ◄──────────────┘
                                                  │
                                    IndexedDB 缓存 / 云端 API / 本地 Ollama
```

核心文件职责：

| 文件 | 职责 |
|------|------|
| `background.js` | Service Worker：配置管理、IndexedDB 缓存、API 调用、流式输出、自适应速率限制、右键菜单、版本更新检测 |
| `lib/sw/` | SW 纯函数模块（可单测）：常量、缓存键、供应商判断、语言检测、prompt 构建、消息路由 |
| `content.js` | 内容脚本：划词翻译浮窗、整页翻译（保持样式）、批量翻译、可视区域优先、进度条 |
| `popup.js` | 弹窗快捷翻译 |
| `options.js` | 设置页面：供应商 / 模型 / 语言 / 缓存 / 快捷键 |
| `content.css` | 书房衬纸风格样式（详见 docs/UI_DESIGN_SYSTEM.md） |

### 关键技术设计

- **双缓存策略**：`Map` 内存缓存 + IndexedDB 持久化（缓存键格式 `v3:p1:<modelSlug>:<src>:<tgt>:<style>:<归一化文本>`，详见 CONTEXT.md）。
- **自适应速率限制**：根据连续成功/失败次数动态调整并发（1~10）与请求延迟（0~2000ms），429 触发 30s 冷却。
- **批量翻译降级**：先筛缓存命中，未命中批量请求 JSON 数组；解析失败则单句并发补全，最多 3 次重试。
- **整页翻译**：DOM 文本节点分批处理，双语 `<span>` 跟在原文后，可视区域优先，动态内容增量翻译，可恢复原文。

## 5. 构建、安装与运行命令

无需构建，直接加载：

1. 打开 `chrome://extensions/` 或 `edge://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `extension/` 目录

调试：

- `background.js`：扩展管理页点击「Service Worker」查看日志。
- `content.js`：在网页上按 F12 查看控制台。
- `popup.js / options.js`：在弹窗/设置页右键「检查」。

快捷键（可在扩展设置中查看或修改）：

- `Ctrl+Shift+T`（macOS `Command+Shift+T`）：翻译选中内容
- `Ctrl+Shift+P`（macOS `Command+Shift+P`）：翻译整页

## 6. 测试策略与命令

扩展单元测试位于 `extension/tests/`，使用 Node 内置 test runner（`node:test`），无需额外依赖：

```bash
node --test extension/tests/      # 运行全部扩展单元测试
npm test                          # 等价：node --test extension/tests/*.test.js
```

覆盖范围：`product-helpers.test.js`（商品翻译辅助逻辑）、`logo-icons.test.js`（图标资源）、`sw-modules.test.js`（Service Worker 核心模块）。验证结果（当前环境）：`55 passed`。修改 `options.js`、`background.js`、`content.js` 后仍建议在真实浏览器中加载扩展手动验证端到端路径。

## 7. 代码风格与开发约定

- **语言**：代码注释、用户文档以中文为主；README 少量英文标题；AGENTS.md 沿用中文。
- **字符串引号**：JS 使用单引号（扩展代码以单引号为主）。
- **错误处理**：统一使用结构化错误（含 engine 与原始错误信息）。
- **常量与配置**：扩展将常量集中放在 `lib/sw/constants.js`（`API_ENDPOINTS`、`DEFAULT_MODELS`、`STYLE_PROMPTS` 等）。
- **日志**：扩展使用 `console.log / console.warn` 并带 `[YuxTrans]` 前缀。
- **扩展视觉系统**：统一遵循 `docs/UI_DESIGN_SYSTEM.md` 定义的「书房衬纸」风格。核心文件为 `extension/design-tokens.css`，所有新增样式需优先使用 `--yxt-*` 变量；禁止引入纯黑/纯白、高饱和色、大圆角胶囊、iOS 开关、旋转 Spinner 等与该气质冲突的元素。

## 8. 配置说明

扩展配置通过 `chrome.storage` 持久化，`options.js` 提供设置界面，支持：

- 云端供应商（qwen / openai / deepseek / anthropic / groq / moonshot / siliconflow / custom）+ 本地 Ollama
- 源语言 / 目标语言 / 翻译风格（普通 / 学术 / 技术 / 文学）
- 缓存限额（默认 200MB）、触发模式、双语模式、站点黑白名单等

默认云端供应商：`qwen`，模型 `qwen-turbo`；默认本地模型通过 `http://localhost:11434/api/chat` 访问 Ollama。

## 9. 安全与隐私注意事项

- **API Key**：通过 `chrome.storage` 存储，不应提交到仓库。
- **`.gitignore`** 已排除 `*.db`、日志、虚拟环境、构建产物等。
- **扩展权限**：`manifest.json` 申请了 `activeTab`、`storage`、`clipboardWrite`、`contextMenus`，以及多个云端 API 和 `localhost` 的 host 权限。新增供应商时需同步更新 `host_permissions`。
- **本地模型**：仅本地可信环境使用。

## 10. 如何扩展新云端供应商

同步修改：

- `extension/lib/sw/constants.js` 中的 `API_ENDPOINTS` 与 `DEFAULT_MODELS`（若格式特殊，调整 `background.js` 的请求构造与响应解析）
- `extension/options.js` 中的 `DEFAULT_ENDPOINTS`、`DEFAULT_MODELS` 与相关 UI 逻辑
- `extension/manifest.json` 中的 `host_permissions`

## 11. 部署与发布

- 直接以「加载已解压的扩展程序」方式分发；发布到 Chrome Web Store 时打包 `extension/` 目录即可。
- **无 CI/CD**：仓库中未发现 `.github/workflows`、`.gitlab-ci.yml` 等持续集成配置，当前为手动构建/加载。

## 12. 给后续维护者的备忘

1. 修改扩展时，注意 `lib/sw/constants.js`、`options.js`、`manifest.json` 三处供应商/端点/模型配置需要保持一致。
2. 提交前运行 `node --test extension/tests/`，确保无回归。
3. 安卓端为 roadmap 选项：如重启，先读 `docs/superpowers/specs/2026-07-22-android-app-design.md` 与 `docs/superpowers/plans/2026-07-22-android-app-v1.md`，其中包含从扩展精确移植的全部规则与数值。
