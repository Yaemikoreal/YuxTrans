# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

YuxTrans 是一个 AI 翻译工具，核心目标是「响应速度是生命，翻译准度是底线」。项目采用三层架构：缓存 → 本地模型 → 云端API，自动故障转移。

**性能指标**：
- 缓存命中响应 < 50ms（底线 < 100ms）
- 本地模型响应 < 500ms（底线 < 1s）
- 云端API响应 < 2s（底线 < 3s）

## 常用命令

```bash
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

# 代码检查
ruff check yuxtrans/                     # Lint 检查
ruff format yuxtrans/                    # 格式化代码

# 运行桌面客户端
python -m yuxtrans.desktop               # 直接运行
yuxtrans                                 # 安装后运行（entry point）
```

## 核心架构

### 翻译引擎三层结构

```
用户请求 → SmartRouter → 缓存检查(<10ms) → 本地Ollama(<500ms) → 云端API(<2s)
              ↓                ↓                  ↓                 ↓
           路由策略        命中返回          失败转云端          兜底返回
```

**关键文件**：
- `yuxtrans/engine/base.py` — 翻译引擎抽象基类，定义 `translate()` 和 `translate_stream()` 接口
- `yuxtrans/engine/router.py` — 智能路由器，实现 `translate_fast()` 和 `translate_quality()` 两种模式
- `yuxtrans/engine/local.py` — Ollama 本地模型（默认 qwen2:7b）
- `yuxtrans/engine/cloud.py` — 云端API（支持 qwen/openai/deepseek/anthropic/groq/moonshot/siliconflow/custom）
- `yuxtrans/cache/database.py` — SQLite持久化 + LRU内存缓存

### 数据流

1. `TranslationRequest` → `SmartRouter.translate()`
2. Router 按顺序尝试：`TranslationCache` → `LocalTranslator` → `CloudTranslator`
3. 成功后通过 `cache.store()` 写入缓存
4. 返回 `TranslationResult`

### SmartRouter 路由模式

- `translate()` — 标准模式：缓存 → 本地 → 云端，自动故障转移
- `translate_fast()` — 快速模式：仅缓存 + 本地，失败立即报错
- `translate_quality()` — 高质量模式：优先云端API
- `translate_stream()` — 流式模式：支持增量输出

### 扩展新翻译引擎

继承 `BaseTranslator`，实现：
- `async translate(request: TranslationRequest) -> TranslationResult`
- `async translate_stream(request) -> AsyncGenerator[str, None]`
- 设置 `engine_type: EngineType`
- 使用 `_record_success()` 和 `_record_error()` 记录统计

### 扩展新云端供应商

在 `CloudTranslator` 中添加：
1. `API_ENDPOINTS` — API 端点 URL
2. `PROVIDER_FORMATS` — 格式类型（"openai"/"anthropic"/"qwen"）
3. `_default_model()` — 默认模型名称
4. 如需特殊格式，修改 `_build_request_body()` 和 `_extract_translation()`

## 模块结构

```
yuxtrans/
├── engine/          # 翻译引擎（核心）
│   ├── base.py      # 基类 + TranslationRequest/TranslationResult 数据结构
│   ├── router.py    # SmartRouter 智能路由
│   ├── local.py     # Ollama 本地模型
│   └── cloud.py     # 多云端API支持
├── cache/           # 缓存层（SQLite + LRU）
│   ├── database.py  # TranslationCache 主类
│   └── warmup.py    # 预热策略
├── desktop/         # 桌面客户端（PyQt6）
│   ├── app.py       # 主入口 + 系统托盘
│   ├── window.py    # 翻译窗口
│   ├── hotkey.py    # 全局快捷键
│   └── settings.py  # 设置对话框
├── metrics/         # 性能监控与质量评估
│   ├── benchmark.py # 基准测试
│   └── quality.py   # BLEU/WER/CER 计算
├── utils/           # 工具函数
│   ├── config.py    # 配置管理（YAML + 环境变量）
│   ├── retry.py     # 重试机制
│   └── terminology.py # 术语库
└── __init__.py      # 包入口，导出 SmartRouter/TranslationRequest

extension/           # 浏览器插件（Manifest V3）
tests/               # 单元测试
benchmark/           # 性能测试用例
examples/            # 示例脚本
```

## 配置

配置优先级：环境变量 > 配置文件 > 默认值

- 配置文件路径：`~/.yuxtrans/config.yaml`
- 缓存数据库：`~/.yuxtrans/cache/translations.db`
- 默认本地模型：`qwen2:7b`（需安装 Ollama）
- 默认云端API：`qwen-turbo`

**环境变量**：
- `YUXTRANS_CLOUD_PROVIDER` — 云端供应商（qwen/openai/deepseek等）
- `YUXTRANS_CLOUD_API_KEY` — API Key
- `YUXTRANS_CLOUD_MODEL` — 模型名称

## 测试约定

- 使用 pytest + pytest-asyncio（asyncio_mode = "auto"）
- 异步测试无需 `@pytest.mark.asyncio` 装饰器
- 测试文件命名 `test_*.py`
- 使用 tempfile 创建临时数据库进行缓存测试
- 测试文件对应模块：`test_cache.py` → cache/, `test_engine_base.py` → engine/, `test_quality.py` → metrics/