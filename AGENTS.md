# YuxTrans — 给 AI 编码助手的项目指南

本文档面向后续维护本项目的 AI 编码助手。阅读本文前，可默认对项目一无所知；本文基于当前仓库实际内容整理，不引入外部假设。

## 1. 项目概述

YuxTrans 是一款面向深阅读的 AI 翻译工具，核心目标是「响应速度是生命，翻译准度是底线」。项目采用「缓存 → 本地模型 → 云端 API」三级路由与自动故障转移架构。

项目为**复合项目**：

- **Python 包**（`yuxtrans/`）— 核心翻译引擎、缓存层、桌面客户端、质量评估与基准测试。
- **浏览器扩展**（`extension/`）— Chrome / Edge 划词翻译插件（Manifest V3），**独立运行，不依赖 Python 后端**，直接在 Service Worker 中调用云端或本地 Ollama API。

当前版本：Python 包 `0.1.0`，浏览器扩展 `0.3.0`。

## 2. 仓库结构（重要）

项目根目录为 `E:/Pythonproject/YuxTrans`。关键目录如下：

```
E:/Pythonproject/YuxTrans
├── yuxtrans/                    # Python 包根目录（唯一生效的源码）
│   ├── __init__.py
│   ├── cache/                   # SQLite + LRU 缓存
│   ├── desktop/                 # PyQt6 桌面客户端（开发暂停）
│   ├── engine/                  # 翻译引擎（本地 / 云端 / 路由）
│   ├── metrics/                 # BLEU / WER / CER 质量评估与性能基准
│   └── utils/                   # 配置、重试、并发、术语库、文本处理等
├── extension/                   # 浏览器扩展源码（Manifest V3）
│   ├── manifest.json
│   ├── background.js            # Service Worker（核心）
│   ├── content.js               # 内容脚本（划词 + 整页翻译）
│   ├── content.css              # 书房衬纸风格样式（详见 docs/UI_DESIGN_SYSTEM.md）
│   ├── popup.html / popup.js    # 弹窗界面
│   └── options.html / options.js# 设置页面
├── tests/                       # 根目录测试（pytest 实际运行的测试集）
├── examples/                    # Python 使用示例
├── benchmark/                   # 性能测试用例
├── docs/                        # 项目文档
├── pyproject.toml               # Python 项目主配置
├── setup.py                     # setuptools 安装脚本
├── pytest.ini                  # pytest 配置
├── requirements.txt            # 精简依赖清单
├── install.sh / install.bat    # 安装脚本
├── package.json                # Node 依赖（仅 jsdom，用于 options 页面简单测试）
├── test-options.js             # 基于 jsdom 的 options.js 加载测试
└── README.md / CHANGELOG.md / CLAUDE.md / PROGRESS.md / COMPLETED.md
```

### 结构注意事项

1. `yuxtrans/` 现在只包含 Python 包源码。之前存在的嵌套 Git 仓库、重复源码副本 `yuxtrans/yuxtrans/`、重复测试 `yuxtrans/tests/` 以及项目级文件副本已被清理。
2. 根目录 `.git` 是唯一的版本控制入口；`yuxtrans/` 内部不再包含独立的 `.git/`。
3. 修改 Python 代码时，只在根级 `yuxtrans/` 下进行；修改测试时，只修改根目录 `tests/`。

## 3. 技术栈

### Python 侧

- **语言**：Python ≥ 3.10
- **异步**：`asyncio` / `async` / `await`
- **HTTP 客户端**：`httpx`
- **配置与序列化**：`pyyaml`
- **可选桌面端**：`PyQt6>=6.4.0`
- **可选本地模型**：`ollama>=0.1.0`
- **开发依赖**：`pytest>=7.0.0`、`pytest-asyncio>=0.21.0`
- **代码检查**：`ruff`（lint + format，配置见 `pyproject.toml`）
- **类型检查**（可选）：`mypy`

### 浏览器扩展侧

- **平台**：Chrome / Edge（Chromium 内核）
- **Manifest**：V3
- **脚本**：原生 JavaScript（无构建步骤）
- **样式**：原生 CSS
- **存储**：`chrome.storage` + IndexedDB
- **测试辅助**：`jsdom`（仅用于 `test-options.js` 简单加载验证）

## 4. 核心架构

### 4.1 Python 翻译引擎

```
TranslationRequest
       │
       ▼
SmartRouter.translate()
       │
       ├── Cache（SQLite + LRU）── 命中则返回（目标 < 10ms）
       ├── LocalTranslator（Ollama，默认 qwen2:7b）── 失败则继续
       └── CloudTranslator（qwen / openai / deepseek / anthropic / groq / moonshot / siliconflow / custom）── 云端兜底
```

关键文件：

- `yuxtrans/engine/base.py`：抽象基类 `BaseTranslator`，定义 `TranslationRequest`、`TranslationResult`、`TranslationError`。
- `yuxtrans/engine/router.py`：`SmartRouter`，提供 `translate()`、`translate_fast()`、`translate_quality()`、`translate_stream()`。
- `yuxtrans/engine/local.py`：`LocalTranslator`，通过 Ollama 调用本地模型。
- `yuxtrans/engine/cloud.py`：`CloudTranslator`，支持多供应商 API 格式。
- `yuxtrans/cache/database.py`：`TranslationCache`，SQLite 持久化 + 线程安全 LRU。
- `yuxtrans/cache/warmup.py`：`CacheWarmupStrategy`，预加载常用词库。

### 4.2 浏览器扩展

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
| `content.js` | 内容脚本：划词翻译浮窗、整页翻译（保持样式）、批量翻译、可视区域优先、彩虹进度条 |
| `popup.js` | 弹窗快捷翻译 |
| `options.js` | 设置页面：供应商 / 模型 / 语言 / 缓存 / 快捷键 |
| `content.css` | 书房衬纸风格样式（详见 docs/UI_DESIGN_SYSTEM.md） |

### 4.3 关键技术设计

- **双缓存策略**（扩展）：`Map` 内存缓存 + IndexedDB 持久化 + 安装时预置热词库 `BUILTIN_CACHE`。
- **自适应速率限制**（扩展）：根据连续成功/失败次数动态调整并发（1~10）与请求延迟（0~2000ms），429 触发 30s 冷却。
- **批量翻译降级**（扩展）：先筛缓存命中，未命中批量请求 JSON 数组；解析失败则单句并发补全，最多 3 次重试。
- **整页翻译**（扩展）：DOM 文本节点分批处理，`<trans>` 标签替换，可视区域优先，滚动懒加载，可恢复原文。

## 5. 构建、安装与运行命令

### 5.1 Python 包

```bash
# 安装核心依赖与开发依赖（推荐）
pip install -e ".[dev]"

# 安装桌面端依赖（可选）
pip install -e ".[desktop]"

# 安装本地模型依赖（可选）
pip install -e ".[local]"

# 或运行安装脚本
./install.sh        # Linux / macOS / Git Bash
install.bat         # Windows
```

> 注意：`pyproject.toml` 中 `[project.scripts]` 的 entry point 已被注释；`setup.py` 仍定义 `yuxtrans = yuxtrans.desktop.app:main`。桌面客户端在 `pyproject.toml` 注释中标记为「暂停桌面客户端开发」。

### 5.2 浏览器扩展

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

### 5.3 Node 依赖（扩展测试辅助）

```bash
npm install       # 仅安装 jsdom
node test-options.js
```

## 6. 测试策略与命令

### 6.1 Python 测试

测试位于根目录 `tests/`，使用 `pytest`：

```bash
pytest                              # 运行全部测试
pytest -v                           # 详细输出
pytest --tb=short                   # 简短错误回溯
pytest tests/test_cache.py          # 单个文件
pytest -k "test_cache_hit"          # 按名称匹配
```

当前测试覆盖：

- `tests/test_cache.py`：缓存 miss/hit、命中率、过期清理、LRU 淘汰、统计。
- `tests/test_engine_base.py`：请求校验、结果模型、Mock 翻译器、流式、健康检查、错误。
- `tests/test_integration.py`：完整翻译流程、重试机制、限流、并发控制、配置读写、BLEU 质量、基准测试。
- `tests/test_quality.py`：BLEU、WER、CER、质量阈值与报告。

验证结果（当前环境）：`35 passed`。

### 6.2 代码检查

```bash
ruff check yuxtrans/                # Lint 检查
ruff format yuxtrans/               # 格式化代码
ruff check --fix yuxtrans/          # 自动修复部分问题
```

配置：

- `pyproject.toml`：`[tool.ruff]` 行长度 100，目标 Python 3.10，lint 规则 `E`、`F`、`I`、`W`。
- `pyproject.toml`：`[tool.black]` 行长度 100，目标 Python 3.10。
- `pyproject.toml`：`[tool.mypy]` Python 3.10，启用 `warn_return_any`、`warn_unused_ignores`。

### 6.3 扩展测试

目前只有 `test-options.js` 一个基于 jsdom 的简陋加载测试，没有系统化的扩展单元测试框架。修改 `options.js`、`background.js`、`content.js` 后，建议在真实浏览器中加载扩展并手动验证核心路径。

## 7. 代码风格与开发约定

- **语言**：代码注释、docstring、用户文档以中文为主；README 少量英文标题；AGENTS.md 沿用中文。
- **字符串引号**：Python 使用双引号；JS 使用单引号（扩展代码以单引号为主）。
- **行长度**：Python 100 字符。
- **导入排序**：ruff `I` 规则会自动处理。
- **异步**：Python 引擎层全面使用 `async/await`；缓存层使用 `sqlite3` + `threading.RLock` 做同步访问，但对外暴露 `async` 接口。
- **错误处理**：统一使用 `TranslationError`，包含 `engine` 与 `original_error`。
- **常量与配置**：扩展将常量集中放在文件顶部（`API_ENDPOINTS`、`DEFAULT_MODELS`、`STYLE_PROMPTS` 等）。
- **日志**：扩展使用 `console.log / console.warn` 并带 `[YuxTrans]` 前缀。
- **扩展视觉系统**：统一遵循 `docs/UI_DESIGN_SYSTEM.md` 定义的「书房衬纸」风格。核心文件为 `extension/design-tokens.css`，所有新增样式需优先使用 `--yxt-*` 变量；禁止引入纯黑/纯白、高饱和色、大圆角胶囊、iOS 开关、旋转 Spinner 等与该气质冲突的元素。

## 8. 配置说明

### 8.1 Python 配置

- **优先级**：环境变量 > 配置文件 > 默认值。
- **配置文件**：`~/.yuxtrans/config.yaml`
- **缓存数据库**：`~/.yuxtrans/cache/translations.db`
- **默认本地模型**：`qwen2:7b`
- **默认云端供应商**：`qwen`，模型 `qwen-turbo`

常用环境变量：

| 环境变量 | 作用 |
|----------|------|
| `YUXTRANS_CLOUD_PROVIDER` | 云端供应商 |
| `YUXTRANS_CLOUD_API_KEY` | API Key |
| `YUXTRANS_CLOUD_MODEL` | 云端模型 |
| `YUXTRANS_LOCAL_MODEL` | 本地模型 |
| `YUXTRANS_CACHE_DB_PATH` | 缓存数据库路径 |
| `YUXTRANS_MAX_RETRIES` | 最大重试次数 |
| `YUXTRANS_RATE_LIMIT` | 每秒限流 |
| `YUXTRANS_BLEU_THRESHOLD` | BLEU 阈值 |

### 8.2 扩展配置

扩展配置通过 `chrome.storage` 持久化，`options.js` 提供设置界面，支持：

- 云端供应商（qwen / openai / deepseek / anthropic / groq / moonshot / siliconflow / custom）+ 本地 Ollama
- 源语言 / 目标语言 / 翻译风格（普通 / 学术 / 技术 / 文学）
- 缓存限额（默认 200MB）、触发模式、双语模式、站点黑白名单等

## 9. 安全与隐私注意事项

- **API Key**：Python 端通过环境变量或 `~/.yuxtrans/config.yaml` 读取；扩展端通过 `chrome.storage` 存储。两者均不应提交到仓库。
- **`.gitignore`** 已排除 `*.db`、日志、虚拟环境、构建产物等。
- **扩展权限**：`manifest.json` 申请了 `activeTab`、`storage`、`clipboardWrite`、`contextMenus`，以及多个云端 API 和 `localhost` 的 host 权限。新增供应商时需同步更新 `host_permissions`。
- **本地模型**：扩展默认通过 `http://localhost:11434/api/chat` 访问 Ollama，仅本地可信环境。
- **配置覆盖**：`ConfigManager._apply_env_overrides()` 会读取环境变量并覆盖 YAML 中的值，注意不要在生产环境日志中打印完整配置。

## 10. 如何扩展新云端供应商

### Python 侧

修改 `yuxtrans/engine/cloud.py`：

1. 在 `API_ENDPOINTS` 添加端点。
2. 在 `PROVIDER_FORMATS` 指定格式（`openai` / `anthropic` / `qwen`）。
3. 在 `_default_model()` 添加默认模型。
4. 若格式特殊，调整 `_build_request_body()` 和 `_extract_translation()`。

### 扩展侧

同步修改：

- `extension/background.js` 中的 `API_ENDPOINTS` 与 `DEFAULT_MODELS`
- `extension/options.js` 中的 `DEFAULT_ENDPOINTS`、`DEFAULT_MODELS` 与相关 UI 逻辑
- `extension/manifest.json` 中的 `host_permissions`

## 11. 部署与发布

- **Python 包**：使用 `python -m build` 或 `pip install -e .` 本地安装；`yuxtrans/dist/` 下已有历史构建产物 `yuxtrans-0.1.0-py3-none-any.whl`。
- **浏览器扩展**：直接以「加载已解压的扩展程序」方式分发；发布到 Chrome Web Store 时打包 `extension/` 目录即可。
- **无 CI/CD**：仓库中未发现 `.github/workflows`、`.gitlab-ci.yml` 等持续集成配置，当前为手动构建/加载。

## 12. 给后续维护者的备忘

1. 修改 Python 代码时，优先在根目录 `yuxtrans/` 下进行；`yuxtrans/yuxtrans/` 是重复副本，不是当前生效源码。
2. 修改测试时，优先修改根目录 `tests/`，并运行 `pytest` 验证。
3. 修改扩展时，注意 `background.js`、`options.js`、`manifest.json` 三处供应商/端点/模型配置需要保持一致。
4. 提交前运行 `ruff check yuxtrans/` 和 `pytest`，确保无回归。
5. 桌面客户端（`yuxtrans/desktop/`）当前处于暂停开发状态；若重新启用，需同步恢复 `pyproject.toml` 中的 entry point。
