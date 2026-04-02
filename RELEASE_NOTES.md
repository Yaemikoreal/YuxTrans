# YuxTrans v0.1.0 - AI 翻译工具

> 响应速度是生命，翻译准度是底线

## ✨ 新功能

### 核心引擎
- 翻译引擎统一接口 (`BaseTranslator`)
- Ollama 本地模型支持 (`LocalTranslator`)
- 智能路由系统，自动选择最快路径 (`SmartRouter`)

### 云端 API 支持
支持 **8 个云端 API 供应商**：
- **Qwen** (阿里云通义千问) - DashScope API 格式
- **OpenAI** - OpenAI API 格式
- **DeepSeek** - OpenAI 兼容格式
- **Anthropic** (Claude) - Anthropic API 格式
- **Groq** (极速推理) - OpenAI 兼容格式
- **Moonshot** (Kimi) - OpenAI 兼容格式
- **Siliconflow** (硅基流动) - OpenAI 兼容格式
- **Custom** - 自定义 OpenAI 兼容 API

### 缓存系统
- SQLite + LRU 双层缓存
- 缓存预热策略 (59 个常用词汇)
- **命中响应 < 0.1ms** (目标 < 10ms) ✅

### 质量评估
- BLEU 评分 (支持中英文)
- WER (Word Error Rate)
- CER (Character Error Rate)

### 桌面客户端 (PyQt6)
- 系统托盘常驻
- 全局快捷键 (Ctrl+Shift+T)
- 划词翻译
- 现代化 UI

### 浏览器插件 (Manifest V3)
- 右键菜单翻译
- 划词翻译悬浮按钮
- 整页翻译
- 弹出窗口界面

---

## 📊 性能指标

| 指标 | 目标值 | 实测值 | 状态 |
|------|--------|--------|------|
| 缓存命中响应 | < 10ms | **0.04ms** | ✅ |
| 缓存命中率 | > 80% | **100%** (预热后) | ✅ |
| 测试通过率 | 100% | **35/35** | ✅ |

---

## 📦 安装

```bash
# 基础安装
pip install yuxtrans

# 桌面客户端
pip install "yuxtrans[desktop]"

# 本地模型支持
pip install "yuxtrans[local]"
```

---

## 🚀 快速开始

```python
from yuxtrans import SmartRouter, TranslationRequest
import asyncio

async def main():
    router = SmartRouter()
    request = TranslationRequest(text="Hello, world!", source_lang="en", target_lang="zh")
    result = await router.translate(request)
    print(result.text)  # 你好，世界！

asyncio.run(main())
```

---

## 🔗 链接

- 📖 文档: [README.md](README.md)
- ☁️ 云端API配置: [docs/PROVIDERS.md](docs/PROVIDERS.md)
- 📝 更新日志: [CHANGELOG.md](CHANGELOG.md)
- 🐛 问题反馈: [Issues](https://github.com/Yaemikoreal/qwenfy/issues)