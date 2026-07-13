# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

YuxTrans 是一个 AI 翻译工具，核心目标是「响应速度是生命，翻译准度是底线」。项目采用三层架构：缓存 → 本地模型 → 云端API，自动故障转移。

这是一个复合项目：
- **Python 包** (`yuxtrans/yuxtrans/`) — 核心翻译引擎、缓存系统、桌面客户端
- **浏览器扩展** (`extension/`) — Chrome/Edge 划词翻译插件 (Manifest V3)，**独立运行不依赖 Python 后端**

## 常用命令

```bash
# 进入 Python 包目录
cd yuxtrans

# 安装开发依赖
pip install -e ".[dev]"

# 安装桌面端依赖（可选）
pip install -e ".[desktop]"

# 安装本地模型依赖（可选）
pip install -e ".[local]"

# 运行测试
pytest                                    # 运行所有测试
pytest tests/test_cache.py               # 运行单个测试文件
pytest -k "test_cache_hit"               # 运行匹配名称的测试
pytest -v                                # 详细输出
pytest --tb=short                        # 简短错误回溯

# 代码检查
ruff check yuxtrans/                     # Lint 检查
ruff format yuxtrans/                    # 格式化代码

# 运行桌面客户端
python -m yuxtrans.desktop               # 直接运行
yuxtrans                                 # 安装后运行（entry point）

# 打包浏览器扩展
# 直接加载 extension/ 目录到 Chrome/Edge 即可（开发者模式）
```

## 核心架构

### Python 翻译引擎三层结构

```
用户请求 → SmartRouter → 缓存检查(<10ms) → 本地Ollama(<500ms) → 云端API(<2s)
              ↓                ↓                  ↓                 ↓
           路由策略        命中返回          失败转云端          兜底返回
```

**关键文件**：
- `yuxtrans/yuxtrans/engine/base.py` — 翻译引擎抽象基类，定义 `translate()` 和 `translate_stream()` 接口
- `yuxtrans/yuxtrans/engine/router.py` — 智能路由器，实现 `translate_fast()` 和 `translate_quality()` 两种模式
- `yuxtrans/yuxtrans/engine/local.py` — Ollama 本地模型（默认 qwen2:7b）
- `yuxtrans/yuxtrans/engine/cloud.py` — 云端API（支持 qwen/openai/deepseek/anthropic/groq/moonshot/siliconflow/custom）
- `yuxtrans/yuxtrans/cache/database.py` — SQLite持久化 + LRU内存缓存

### 浏览器扩展内部架构（extension/）

扩展是**独立完整的翻译应用**，不依赖 Python 后端，通过 Service Worker 直接调用云端 API：

```
划词/右键 → content.js → chrome.runtime.sendMessage → background.js (Service Worker)
                ↑                                              ↓
       翻译浮窗 / 页面覆盖                            IndexedDB 缓存 / 云端 API
```

**核心模块**：

| 文件 | 职责 |
|------|------|
| `background.js` | Service Worker，管理配置、IndexedDB 缓存、API 调用、流式输出、自适应速率限制、右键菜单、自动更新检测 |
| `content.js` | 内容脚本，划词翻译浮窗、整页翻译（节点样式保持）、进度指示器、批量翻译（可视区域优先） |
| `popup.js` | 弹窗界面，快捷翻译 |
| `options.js` | 设置页面，供应商/模型/快捷键/缓存管理等 |
| `content.css` | 黄铜纸本风格的浮窗和页面翻译样式 |

### 关键技术设计

**双缓存策略** (background.js)：
- `Map` 内存缓存 (LRU，200MB 物理空间限额) → 毫秒级读写
- IndexedDB 持久化（带连接有效性检查和自动重建）+ 防抖批处理写入（500ms 合并）
- `BUILTIN_CACHE` 热词库（安装时预加载，约 300+ 常用词汇中英互译）

**自适应速率限制** (background.js)：
- 动态调整 `concurrentLimit` (1~10) 和 `requestDelay` (0~2000ms)
- 连续 2 次错误 → 降速；连续 5 次成功 → 恢复
- 429 状态码触发 30s 冷却期

**流式输出** (background.js `translateWithStream`)：
- SSE 流式解析，通过 `chrome.tabs.sendMessage` 逐字推送 chunk
- 同时支持向 content script 和 popup 推送增量结果

**批量翻译 + 智能降级** (background.js `translateBatchInternal`)：
- 先筛缓存命中，未命中项分组（按目标语言分组）
- 批量 API 调用 → JSON 数组解析（3 种回退解析策略）
- 解析失败/无效项 → 单句并发补全（最多 3 次重试）

**整页翻译** (content.js)：
- 遍历 DOM 文本节点，分批处理（batchSize=20，concurrency=10）
- 保持原文样式的 `<trans>` 标注替换
- 可视区域优先 + 滚动懒翻译 + 可逆（恢复原文）
- 彩虹进度条指示器

**自动更新检测** (background.js `checkNewVersion`)：
- 每 12h 检查 GitHub Release，新版本时 badge 显示 "NEW"

## 数据流

### Python 引擎路由
1. `TranslationRequest` → `SmartRouter.translate()`
2. Router 按顺序尝试：`TranslationCache` → `LocalTranslator` → `CloudTranslator`
3. 成功后通过 `cache.store()` 写入缓存
4. 返回 `TranslationResult`

### SmartRouter 路由模式
- `translate()` — 标准模式：缓存 → 本地 → 云端，自动故障转移
- `translate_fast()` — 快速模式：仅缓存 + 本地，失败立即报错
- `translate_quality()` — 高质量模式：优先云端API
- `translate_stream()` — 流式模式：支持增量输出

### Extension 消息通道
| action | 方向 | 用途 |
|--------|------|------|
| `translate` | content → bg | 单句翻译，返回完整结果 |
| `translateStream` | content → bg | 流式翻译，逐 chunk 推送 |
| `translateBatch` | content → bg | 批量翻译（JSON 数组），带自动降级 |
| `translateSelection` | bg → content | 右键菜单触发的划词翻译 |
| `translatePage` | bg → content | 整页翻译触发 |
| `getConfig` / `setConfig` | content/popup → bg | 读写配置 |
| `getCacheStats` / `clearCache` | popup/options → bg | 缓存管理 |

## 浏览器扩展开发

```bash
# 加载扩展到 Chrome/Edge
1. 打开 chrome://extensions/ 或 edge://extensions/
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 extension/ 目录

# 调试扩展
- background.js: 扩展管理页点击「Service Worker」查看日志
- content.js: 在网页上 F12 打开开发者工具查看控制台
- popup.js/options.js: 在弹窗/设置页右键检查查看日志
```

**快捷键**：
- `Ctrl+Shift+T` — 翻译选中内容
- `Ctrl+Shift+P` — 翻译整页

**右键菜单**：
- 「翻译选中内容」— 按当前目标语言翻译
- 「翻译整页」
- 「翻译选中内容至...」— 子菜单：英文/中文/日文/韩文

## 配置

配置优先级：环境变量 > 配置文件 > 默认值

- 配置文件路径：`~/.yuxtrans/config.yaml`
- 缓存数据库：`~/.yuxtrans/cache/translations.db`
- 默认本地模型：`qwen2:7b`（需安装 Ollama）
- 默认云端API：`qwen-turbo`

**环境变量** (Python 引擎)：
- `YUXTRANS_CLOUD_PROVIDER` — 云端供应商
- `YUXTRANS_CLOUD_API_KEY` — API Key
- `YUXTRANS_CLOUD_MODEL` — 模型名称

**Extension 设置页面** (`options.js`) 支持：
- 12 个云端供应商 + 自定义 + 本地 Ollama
- 源语言/目标语言/翻译风格（普通/学术/技术/文学）
- 缓存限额（200MB 默认），触发模式，双语模式

## 扩展新云端供应商

在 Python `CloudTranslator` (`yuxtrans/yuxtrans/engine/cloud.py`) 中添加：
1. `API_ENDPOINTS` — API 端点 URL
2. `PROVIDER_FORMATS` — 格式类型（"openai"/"anthropic"/"qwen"）
3. `_default_model()` — 默认模型名称
4. 如需特殊格式，修改 `_build_request_body()` 和 `_extract_translation()`

扩展 `background.js` 中的对应配置（`API_ENDPOINTS` / `DEFAULT_MODELS`）。

## 模块结构

```
项目根目录 E:\Pythonproject\YuxTrans
├── yuxtrans/                        # Python 包目录
│   ├── yuxtrans/                    # 核心包（源码）
│   │   ├── engine/                  # 翻译引擎（核心）
│   │   ├── cache/                   # 缓存层（SQLite + LRU）
│   │   ├── desktop/                 # 桌面客户端（PyQt6）
│   │   ├── metrics/                 # 性能监控与质量评估
│   │   └── utils/                   # 工具函数
│   ├── tests/                       # 单元测试
│   ├── docs/                        # 文档
│   ├── benchmark/                   # 性能测试用例
│   ├── examples/                    # 示例脚本
│   └── pyproject.toml               # 项目配置
│
├── extension/                       # 浏览器插件（Manifest V3）
│   ├── manifest.json                # 扩展配置
│   ├── background.js                # Service Worker（核心）
│   ├── content.js                   # 内容脚本（划词+整页翻译）
│   ├── content.css                  # 全局翻译样式
│   ├── popup.html / popup.js        # 弹窗界面
│   ├── options.html / options.js    # 设置页面（12供应商+自定义）
│   └── icons/                       # 图标资源
│
├── logo/                            # 项目 logo
├── README.md                        # 项目文档
├── CHANGELOG.md                     # 变更日志
└── COMPLETED.md / PROGRESS.md       # 开发进度跟踪
```

详情见 `yuxtrans/yuxtrans/` 下各子模块的源文件注释和 `yuxtrans/docs/PROVIDERS.md`。
