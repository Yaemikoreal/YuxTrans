# YuxTrans

<p align="center">
  <strong>响应速度是生命，翻译准度是底线</strong>
</p>

<p align="center">
  一款极速响应、精准翻译的 AI 翻译工具，支持本地模型和多云端 API
</p>

<p align="center">
  <a href="https://github.com/Yaemikoreal/qwenfy/releases">
    <img src="https://img.shields.io/github/v/release/Yaemikoreal/qwenfy?color=blue&label=version" alt="Version">
  </a>
  <a href="https://www.python.org/downloads/">
    <img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License">
  </a>
  <a href="https://github.com/Yaemikoreal/qwenfy/stargazers">
    <img src="https://img.shields.io/github/stars/Yaemikoreal/qwenfy?color=orange&label=stars" alt="Stars">
  </a>
  <a href="https://github.com/Yaemikoreal/qwenfy/issues">
    <img src="https://img.shields.io/github/issues/Yaemikoreal/qwenfy" alt="Issues">
  </a>
</p>

<p align="center">
  <a href="#安装">安装</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#功能特性">功能特性</a> •
  <a href="#架构">架构</a> •
  <a href="#性能">性能</a> •
  <a href="#贡献">贡献</a>
</p>

---

## 安装

```bash
# 基础安装
pip install yuxtrans

# 桌面客户端
pip install "yuxtrans[desktop]"

# 完整安装（桌面 + 本地模型）
pip install "yuxtrans[desktop,local]"
```

## 快速开始

### Python API

```python
from yuxtrans import SmartRouter, TranslationRequest
import asyncio

async def main():
    router = SmartRouter()
    result = await router.translate(
        TranslationRequest(text="Hello, world!", source_lang="en", target_lang="zh")
    )
    print(result.text)  # 你好，世界！

asyncio.run(main())
```

### 桌面客户端

```bash
pip install "yuxtrans[desktop]"
yuxtrans  # 启动应用，首次运行会显示配置向导
```

### 浏览器插件

1. Chrome 打开 `chrome://extensions/`
2. 启用「开发者模式」
3. 加载 `extension/` 目录

---

## 功能特性

| 特性 | 描述 |
|------|------|
| **⚡ 极速响应** | 缓存命中 < 0.1ms，本地模型 < 500ms，云端 < 2s |
| **🔄 智能路由** | 自动选择最快路径：缓存 → 本地 → 云端 |
| **☁️ 多云端支持** | Qwen、OpenAI、DeepSeek、Anthropic、Groq、Moonshot、Siliconflow |
| **🏠 本地优先** | Ollama 本地模型，离线可用 |
| **📊 质量评估** | BLEU/WER/CER 翻译质量指标 |
| **🖥️ 桌面客户端** | PyQt6 系统托盘，全局快捷键 Ctrl+Shift+T |
| **🌐 浏览器插件** | Chrome/Edge 扩展，划词翻译 |

---

## 架构

```
         ┌──────────────────────────────────────────────┐
         │              SmartRouter                      │
         │                                               │
请求 ──► │  Cache (<0.1ms) → Local (<500ms) → Cloud (<2s) │ ──► 结果
         │                                               │
         │     命中返回        本地推理        云端兜底    │
         └──────────────────────────────────────────────┘
```

**核心模块**：
- `engine/` — 翻译引擎（BaseTranslator、LocalTranslator、CloudTranslator、SmartRouter）
- `cache/` — SQLite + LRU 双层缓存
- `metrics/` — BLEU/WER/CER 质量评估
- `desktop/` — PyQt6 桌面客户端
- `extension/` — Chrome 扩展（Manifest V3）

---

## 性能

| 指标 | 目标 | 实测 |
|------|------|------|
| 缓存命中 | < 10ms | **0.04ms** ✅ |
| 本地模型 | < 500ms | 配置后实测 |
| 云端 API | < 2s | 配置后实测 |
| 缓存命中率 | > 80% | **100%** ✅ |

---

## 支持的云端 API

| 供应商 | ID | 默认模型 |
|--------|-----|----------|
| 通义千问 | `qwen` | qwen-turbo |
| OpenAI | `openai` | gpt-4o-mini |
| DeepSeek | `deepseek` | deepseek-chat |
| Anthropic | `anthropic` | claude-3-5-haiku-latest |
| Groq | `groq` | llama-3.1-8b-instant |
| Moonshot | `moonshot` | moonshot-v1-8k |
| Siliconflow | `siliconflow` | Qwen/Qwen2.5-7B-Instruct |

配置 API Key：
```bash
export YUXTRANS_CLOUD_PROVIDER=qwen
export YUXTRANS_CLOUD_API_KEY=sk-xxx
```

---

## 开发

```bash
git clone https://github.com/Yaemikoreal/qwenfy.git
cd qwenfy
pip install -e ".[dev]"

# 运行测试
pytest

# 代码检查
ruff check yuxtrans/
ruff format yuxtrans/
```

---

## Roadmap

- [ ] OCR 图像翻译
- [ ] 语音翻译
- [ ] PDF 文档翻译
- [ ] 更多语言对

详见 [CHANGELOG.md](CHANGELOG.md)

---

## 贡献

欢迎 Issue 和 PR！

```bash
# Fork → Branch → Commit → Push → PR
git checkout -b feature/AmazingFeature
git commit -m 'Add AmazingFeature'
git push origin feature/AmazingFeature
```

---

## 许可证

[MIT](LICENSE) © 2026 YuxTrans Contributors

---

## 致谢

- [Ollama](https://ollama.ai/) — 本地模型推理
- [Qwen](https://tongyi.aliyun.com/) — 通义千问
- [OpenAI](https://openai.com/) — GPT 模型
- [Anthropic](https://anthropic.com/) — Claude 模型

<p align="center">
  <a href="https://github.com/Yaemikoreal/qwenfy">
    <img src="https://img.shields.io/github/contributors/Yaemikoreal/qwenfy?color=blue" alt="Contributors">
  </a>
</p>