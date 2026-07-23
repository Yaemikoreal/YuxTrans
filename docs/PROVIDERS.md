# 云端 API 供应商配置指南

YuxTrans 浏览器扩展 v0.5.0 支持以下翻译服务：

---

## 支持的供应商

| 供应商 | ID | API 格式 | 默认模型 | 特点 |
|--------|-----|----------|----------|------|
| 阿里云通义千问 | `qwen` | openai (DashScope 兼容) | `qwen-turbo` | 国内稳定，中文优化 |
| OpenAI | `openai` | openai | `gpt-4o` | 国际标准，多语言 |
| DeepSeek | `deepseek` | openai | `deepseek-chat` | 国内性价比高 |
| Anthropic | `anthropic` | anthropic | `claude-3-5-sonnet-latest` | 高质量推理 |
| Groq | `groq` | openai | `llama-3.3-70b-versatile` | 极速推理 |
| Moonshot | `moonshot` | openai | `moonshot-v1-8k` | 长文本支持 |
| SiliconFlow | `siliconflow` | openai | `Qwen/Qwen2.5-7B-Instruct` | 多模型选择 |
| 谷歌免费翻译 | `google` | google (translate_a/single) | `gtx` | 免 Key，开箱即用 |
| 本地 Ollama | `local` | ollama | 自定义 | 离线、隐私 |
| 自定义 | `custom` | openai / anthropic / qwen | 自定义 | OpenAI 兼容 API |

---

## 浏览器扩展中配置供应商

1. 点击扩展图标 → **设置** → **AI 模型服务**。
2. 选择供应商类型，填写 API Key、端点（可选）与模型。
3. 点击 **保存并启用档案**，当前配置会成为一个 ProviderProfile。
4. 在 **档案管理** 列表或 popup 下拉栏中切换已保存的档案。

> API Key 仅保存在浏览器本地（`chrome.storage.local` + IndexedDB），不会同步到云端账号。

### 本地 Ollama

确保 Ollama 已启动（默认 `http://localhost:11434`）。推荐模型分档（可按机器配置选择）：

| 档位 | 模型 | 约大小 | 适用 |
|------|------|--------|------|
| 最快 | `qwen3.5:0.8b` | 约 1GB | 低配 / 纯 CPU |
| 推荐 | `translategemma:4b` | 约 3.3GB | 专用翻译模型 |
| 最佳质量 | `translategemma:12b` | 约 8GB | 高端机 / GPU |

```bash
ollama pull qwen3.5:0.8b          # 或 translategemma:4b / translategemma:12b
```

也可使用扩展自带的脚本（支持参数指定模型）：

```bash
extension/setup-ollama.bat translategemma:4b   # Windows
./extension/setup-ollama.sh translategemma:4b  # macOS / Linux
```

### 谷歌免费翻译

`google` 供应商走谷歌免费接口（`translate.googleapis.com`），**无需 API Key**，开箱即用。适合无配置快速体验，但翻译质量与可控性低于云端 LLM，且无词典模式结构化输出能力（词典卡片会降级为纯文本）。

### 自定义供应商

适用于本地 vLLM、OneAPI 或其他 OpenAI 兼容服务。填写完整端点地址，例如：

```
https://api.example.com/v1/chat/completions
```

---

## API 格式说明

### OpenAI 兼容格式

适用于：`openai`, `qwen`, `deepseek`, `groq`, `moonshot`, `siliconflow`, `custom`

```json
{
  "model": "gpt-4o",
  "messages": [{"role": "user", "content": "..."}],
  "temperature": 0.3,
  "stream": false
}
```

响应：

```json
{
  "choices": [{"message": {"content": "翻译结果"}}]
}
```

### Anthropic 格式（Claude）

适用于：`anthropic`

请求头：

```json
{
  "x-api-key": "your-api-key",
  "anthropic-version": "2023-06-01",
  "Content-Type": "application/json"
}
```

请求体：

```json
{
  "model": "claude-3-5-sonnet-latest",
  "max_tokens": 4096,
  "messages": [{"role": "user", "content": "..."}]
}
```

响应：

```json
{
  "content": [{"text": "翻译结果"}]
}
```

---

## API Key 获取地址

| 供应商 | 获取地址 |
|--------|----------|
| Qwen | https://dashscope.console.aliyun.com/apiKey |
| OpenAI | https://platform.openai.com/api-keys |
| DeepSeek | https://platform.deepseek.com/api_keys |
| Anthropic | https://console.anthropic.com/settings/keys |
| Groq | https://console.groq.com/keys |
| Moonshot | https://platform.moonshot.cn/console/api-keys |
| SiliconFlow | https://cloud.siliconflow.cn/account/ak |

---

## 推荐配置

| 场景 | 推荐 | 原因 |
|------|------|------|
| 国内用户 | `qwen` 或 `deepseek` | 稳定、中文优化、性价比 |
| 国际用户 | `openai` 或 `anthropic` | 质量、多语言 |
| 极速响应 | `groq` | 推理速度快 |
| 长文本 | `moonshot` | 支持 200K token |
| 多模型 | `siliconflow` | Qwen/Llama/GLM 等多选择 |
| 本地部署 | `local` 或 `custom` | 离线、隐私、可控 |
