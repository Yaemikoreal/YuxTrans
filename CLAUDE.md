# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

YuxTrans 是面向深阅读的 AI 翻译工具，「响应速度是生命，翻译准度是底线」。复合项目：

- **浏览器扩展** (`extension/`) — Manifest V3 划词/整页翻译插件，**独立完整应用，不依赖 Python 后端**，Service Worker 直连云端 API 或本地 Ollama。**当前开发重心在此。**
- **Python 包** (`yuxtrans/`) — 翻译引擎 + 缓存（缓存→本地→云端三层路由）。**当前暂停维护**（见 `CONTEXT.md` 边界上下文），无明确需求不要改动。

详细维护指南见 `AGENTS.md`（供应商扩展步骤、安全注意事项等）；领域术语（缓存键语义、有效命中定义等）见 `CONTEXT.md`。

## 常用命令

```bash
# Python（需先 cd yuxtrans 上层根目录）
pip install -e ".[dev]"            # 开发依赖（pytest + pytest-asyncio）
pip install -e ".[local]"          # 本地模型依赖（ollama）
pytest                             # 全部测试（配置在 pytest.ini，asyncio_mode=auto）
pytest tests/test_cache.py         # 单文件
pytest -k "test_cache_hit"         # 按名称匹配

# Lint / 格式化
ruff check yuxtrans/
ruff check --fix yuxtrans/
ruff format yuxtrans/              # 行宽 100，规则 E/F/I/W，目标 py310

# 扩展单元测试（Node 内置 test runner，无额外依赖）
npm test                           # 等价 node --test extension/tests/*.test.js
node --test extension/tests/       # 同上

# 扩展本身无构建步骤：chrome://extensions/ 开发者模式 → 加载 extension/ 目录
```

改 `background.js`/`content.js`/`options.js` 后，除跑 node 测试外仍需在真实浏览器加载验证端到端路径。

## 架构要点

### 浏览器扩展（当前重心）

```
划词/右键/快捷键 → content.js ──chrome.runtime.sendMessage──► background.js (SW)
                        ▲                                          │
              翻译浮窗 / 整页覆盖 ◄────────────────────────────────┘
                                                       IndexedDB 缓存 / 云端 API / Ollama
```

- **`background.js`（~3200 行）是核心**：配置管理、双缓存（Map 内存 LRU + IndexedDB 持久化，200MB 物理定额）、流式输出（SSE → `chrome.tabs.sendMessage` 逐 chunk 推送）、自适应速率限制（并发 1~10、延迟 0~2000ms，429 触发 30s 冷却）、批量翻译降级（批量 JSON 解析失败 → 单句并发补全，最多 3 次重试）、右键菜单、GitHub Release 更新检测。
- **SW 模块化拆分**：`background.js` 顶部通过 `importScripts`（Node 测试走 `require` 双通道）加载 `extension/lib/sw/` 下的纯函数模块，挂到 `globalThis.YuxTransSW`；`lib/product-helpers.js` 挂到 `YuxTransHelpers`。模块按依赖顺序加载：`bootstrap → constants → cache-keys → providers-core → lang → message-actions → translate-core → scheduler`（`placeholders.js` 仅测试加载）。**新增可单测的纯逻辑应放进 `lib/sw/` 对应模块，而非塞进 background.js。**
- **content.js**：划词浮窗 + 整页翻译（DOM 文本节点分批 batchSize=20/concurrency=10，`<trans>` 标注替换保持样式，可视区域优先 + 滚动懒翻译 + 可恢复原文，彩虹进度条）。
- **`BUILTIN_CACHE` 内置热词库已清空**：严格缓存策略下短词/固定译法属于近似命中，不再预加载。不要恢复预载逻辑。
- 消息通道：`translate` / `translateStream` / `translateBatch`（content→bg）；`translateSelection` / `translatePage`（bg→content）；`getConfig` / `setConfig` / `getCacheStats` / `clearCache`。

### 领域概念（改缓存/配置前必读 `CONTEXT.md`）

- **缓存键**：`sourceLang:targetLang:style:text`；归一化仅做 NFC + 去零宽字符 + 折叠空白，**不同标点/引号/全角半角视为不同键**（刻意不做近似命中）。
- **有效命中**三条件：键精确匹配 + 译文质量可接受 + 当前页面上下文合适。Cache Validator 在读写前执行启发式拦截；源文 < `MIN_CACHE_SOURCE_LENGTH`（12 字符）不入缓存。核心指标是 **Bad-Hit Rate**。
- **ProviderProfile**（供应商档案：provider+凭据+端点+模型模板，可存多组一键切换）与 **ActiveConfig**（当前生效全局配置）是两个独立概念，都在 options 页管理。

### Python 引擎（暂停维护）

`SmartRouter` 按序尝试：`TranslationCache`（SQLite + 线程安全 LRU，对外 async 接口）→ `LocalTranslator`（Ollama，默认 qwen2:7b）→ `CloudTranslator`（多供应商）。路由模式：`translate()`（标准）/ `translate_fast()`（仅缓存+本地）/ `translate_quality()`（优先云端）/ `translate_stream()`。

## 开发约定

- **issues 驱动**：发现问题/需求/bug → 先提交 git issue → 计划并解决 → `pytest tests/ -v` 全部通过 → push 并关闭 issue。
- **供应商配置三处同步**：新增/改云端供应商时，`background.js`（`API_ENDPOINTS`/`DEFAULT_MODELS`）、`options.js`（`DEFAULT_ENDPOINTS`/`DEFAULT_MODELS` + UI）、`manifest.json`（`host_permissions`）必须同步更新。Python 侧对应 `yuxtrans/engine/cloud.py`。
- **视觉系统**：统一遵循 `docs/UI_DESIGN_SYSTEM.md`「书房衬纸」风格，样式优先用 `extension/design-tokens.css` 的 `--yxt-*` 变量；禁止纯黑/纯白、高饱和色、大圆角胶囊、iOS 开关、旋转 Spinner。
- **引号风格**：Python 双引号（行宽 100），JS 单引号。扩展日志带 `[YuxTrans]` 前缀。
- 扩展常量集中在文件/模块顶部（`API_ENDPOINTS`、`DEFAULT_MODELS`、`STYLE_PROMPTS` 等）。
- Python 错误统一用 `TranslationError`（含 `engine` 与 `original_error`）。

## 其他资源

- `docs/`：`UI_DESIGN_SYSTEM.md`（设计规范）、`PROVIDERS.md`（供应商详情）、`PRODUCT_OPTIMIZATION.md`、`adr/`（架构决策记录）
- `benchmark/results/`：基准测试结果；`scripts/generate_extension_icons.py`：图标生成
- `extension/setup-ollama.bat` / `.sh`：Ollama 环境准备脚本
