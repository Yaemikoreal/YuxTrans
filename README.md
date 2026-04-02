# YuxTrans - AI 翻译工具

> 响应速度是生命，翻译准度是底线

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/Yaemikoreal/qwenfy.svg)](https://github.com/Yaemikoreal/qwenfy/releases)

一款**响应速度极快、翻译质量精准**的 AI 翻译工具，支持本地模型和多云端 API。

---

## ✨ 核心特性

- **⚡ 极速响应** - 缓存命中 < 0.1ms，本地模型 < 500ms，云端 API < 2s
- **🔄 智能路由** - 自动选择最快路径：缓存 → 本地 → 云端
- **☁️ 多云端支持** - 支持 8+ 云端 API 供应商
- **🏠 本地优先** - 支持 Ollama 本地模型，离线可用
- **📊 质量评估** - 内置 BLEU/WER/CER 翻译质量指标
- **🖥️ 桌面客户端** - PyQt6 系统托盘应用，全局快捷键
- **🌐 浏览器插件** - Chrome/Edge 扩展，划词翻译

---

## 📦 安装

### 方式一：pip 安装（推荐）

```bash
# 基础安装（核心功能）
pip install yuxtrans

# 桌面客户端（含 GUI）
pip install "yuxtrans[desktop]"

# 完整安装（桌面 + 本地模型支持）
pip install "yuxtrans[desktop,local]"
```

### 方式二：从源码安装

```bash
git clone https://github.com/Yaemikoreal/qwenfy.git
cd qwenfy
pip install -e ".[dev]"
```

---

## 🚀 快速开始

### 1️⃣ 桌面客户端（推荐新手）

安装后直接运行，首次启动会显示配置向导：

```bash
# 安装桌面客户端
pip install "yuxtrans[desktop]"

# 启动应用
yuxtrans
```

**首次运行会自动弹出配置向导**，引导您：
1. 选择翻译服务（云端 API 或本地模型）
2. 配置 API Key（云端 API 需要）
3. 完成配置后即可使用

### 2️⃣ Python API

```python
from yuxtrans import SmartRouter, TranslationRequest
import asyncio

async def main():
    # 初始化路由器
    router = SmartRouter()

    # 翻译
    request = TranslationRequest(
        text="Hello, world!",
        source_lang="en",
        target_lang="zh"
    )
    result = await router.translate(request)
    print(result.text)  # 你好，世界！
    print(f"引擎: {result.engine.value}, 耗时: {result.response_time_ms:.2f}ms")

asyncio.run(main())
```

### 3️⃣ 配置 API Key

**方式 A：桌面客户端配置**
- 右键托盘图标 → 配置 API Key
- 选择供应商 → 粘贴 API Key → 保存

**方式 B：配置文件**
编辑 `~/.yuxtrans/config.yaml`：

```yaml
engine:
  cloud_provider: qwen      # 供应商: qwen/openai/deepseek/anthropic/groq/moonshot/siliconflow
  cloud_api_key: sk-xxx     # 你的 API Key
```

**方式 C：环境变量**
```bash
export YUXTRANS_CLOUD_PROVIDER=qwen
export YUXTRANS_CLOUD_API_KEY=sk-xxx
```

**方式 D：Python 代码**
```python
from yuxtrans.engine.cloud import CloudTranslator

translator = CloudTranslator(
    provider="openai",
    api_key="sk-xxx",
    model="gpt-4o-mini"
)
```

---

## ☁️ 支持的云端 API

| 供应商 | ID | 默认模型 | 特点 |
|--------|-----|----------|------|
| 阿里云通义千问 | `qwen` | qwen-turbo | 国内稳定，中文优化 |
| OpenAI | `openai` | gpt-4o-mini | 国际标准，多语言 |
| DeepSeek | `deepseek` | deepseek-chat | 国内性价比高 |
| Anthropic | `anthropic` | claude-3-5-haiku-latest | 高质量推理 |
| Groq | `groq` | llama-3.1-8b-instant | 极速推理 (<100ms) |
| Moonshot | `moonshot` | moonshot-v1-8k | 长文本支持 |
| Siliconflow | `siliconflow` | Qwen/Qwen2.5-7B-Instruct | 多模型选择 |
| 自定义 | `custom` | 自定义 | OpenAI 兼容 API |

查看详细配置: [docs/PROVIDERS.md](docs/PROVIDERS.md)

---

## 🏗️ 架构

```
用户请求
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    SmartRouter (智能路由)                    │
│                                                              │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                │
│  │  Cache  │ ─► │  Local  │ ─► │  Cloud  │                │
│  │ <0.1ms  │    │ <500ms  │    │  <2s    │                │
│  └─────────┘    └─────────┘    └─────────┘                │
│       │              │              │                       │
│   命中返回       本地推理       云端兜底                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 性能指标

| 指标 | 目标值 | 实测值 | 状态 |
|------|--------|--------|------|
| 缓存命中响应 | < 10ms | **0.04ms** | ✅ |
| 本地模型响应 | < 500ms | 待实测* | ⏳ |
| 云端API响应 | < 2s | 待实测* | ⏳ |
| 缓存命中率 | > 80% | **100%** (预热后) | ✅ |
| BLEU 评分 | 支持 | 中英文正常 | ✅ |

*需要配置 Ollama 或云端 API Key

---

## 📁 项目结构

```
yuxtrans/
├── yuxtrans/              # 核心包
│   ├── engine/            # 翻译引擎
│   │   ├── base.py        # 统一模型接口
│   │   ├── local.py       # Ollama 本地模型
│   │   ├── cloud.py       # 云端 API
│   │   └── router.py      # 智能路由
│   ├── cache/             # 缓存系统
│   │   ├── database.py    # SQLite + LRU
│   │   └── warmup.py      # 预热策略
│   ├── metrics/           # 性能监控
│   │   ├── benchmark.py   # 基准测试
│   │   └── quality.py     # BLEU/WER/CER
│   ├── desktop/           # 桌面客户端
│   │   ├── tray.py        # 系统托盘
│   │   ├── hotkey.py      # 全局快捷键
│   │   ├── window.py      # 翻译窗口
│   │   └── settings.py    # 设置对话框
│   └── utils/             # 工具模块
│       ├── config.py      # 配置管理
│       ├── retry.py       # 重试机制
│       ├── concurrency.py # 并发控制
│       ├── terminology.py # 术语库
│       └── style.py       # 翻译风格
│
├── extension/             # 浏览器插件 (Manifest V3)
├── tests/                 # 单元测试 (35 个)
├── examples/              # 示例脚本
├── docs/                  # 文档
└── benchmark/             # 性能测试用例
```

---

## 🔧 配置

配置文件位置: `~/.yuxtrans/config.yaml`

```yaml
engine:
  prefer_local: true
  local_model: "qwen2:7b"
  cloud_provider: "qwen"
  cloud_model: "qwen-turbo"
  cloud_api_key: "your-api-key"

performance:
  max_retries: 3
  bleu_threshold: 0.70

ui:
  theme: "light"
  language: "zh"
  hotkey_translate: "Ctrl+Shift+T"
```

---

## 🧪 开发

```bash
# 克隆仓库
git clone https://github.com/Yaemikoreal/qwenfy.git
cd qwenfy

# 安装开发依赖
pip install -e ".[dev]"

# 运行测试
pytest

# 代码检查
ruff check yuxtrans/
ruff format yuxtrans/
```

---

## 📝 更新日志

### [v0.1.0] - 2026-04-01

#### 新增
- 翻译引擎统一接口 (`BaseTranslator`)
- Ollama 本地模型支持 (`LocalTranslator`)
- 8 个云端 API 供应商支持 (`CloudTranslator`)
- 智能路由系统 (`SmartRouter`)
- SQLite + LRU 双层缓存
- BLEU/WER/CER 质量评估
- PyQt6 桌面客户端
- Chrome 浏览器插件

#### 性能
- 缓存命中响应: 0.04ms (目标 < 10ms) ✅
- 缓存命中率: 100% (预热后) ✅

详见 [CHANGELOG.md](CHANGELOG.md)

---

## 🤝 贡献

欢迎提交 Issue 和 PR！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

---

## 📄 许可证

[MIT License](LICENSE) © 2026 YuxTrans Contributors

---

## 🙏 致谢

- [Ollama](https://ollama.ai/) - 本地模型推理
- [Qwen](https://tongyi.aliyun.com/) - 通义千问模型
- [OpenAI](https://openai.com/) - GPT 模型
- [Anthropic](https://www.anthropic.com/) - Claude 模型