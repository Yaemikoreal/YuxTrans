<p align="center">
  <img src="extension/icons/icon128.png" width="88" alt="YuxTrans Logo">
</p>

<h1 align="center">YuxTrans</h1>

<p align="center">
  <strong>轻量 · 准确 · 稳定</strong><br>
  <span>一款面向深阅读的 AI 翻译浏览器扩展</span>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Yaemikoreal/YuxTrans?color=d8a051&label=Version" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-fdf6ec.svg?labelColor=d8a051" alt="License">
</p>

---

## 它是什么

YuxTrans 是一个**纯浏览器扩展**，不需要 Python 后端。它在 Service Worker 中直接连接本地 Ollama 或云端 API，通过「缓存 → 本地 → 云端」三级路由与自动故障转移，为网页阅读提供快速、稳定、可离线使用的翻译体验。

设计目标只有三个：**轻量**、**准确**、**稳定**。

---

## 核心特性

- **本地优先**：原生支持 Ollama，敏感文本不出户，离线也能翻译。
- **自动故障转移**：本地模型不可用或云端限流时，自动切换备用供应商。
- **物理定额缓存**：默认 200MB IndexedDB 缓存 + 预置热词库，命中时毫秒级返回。
- **档案式模型管理**：在设置页保存多组「ProviderProfile」，popup 中一键切换模型。
- **Warm Paper 视觉**：低饱和纸本质感，让工具退后、内容向前。

---

## 安装

### 方式一：加载已解压的扩展（推荐开发/测试）

1. 下载本仓库源码并解压。
2. 打开 Chrome / Edge，访问 `chrome://extensions/` 或 `edge://extensions/`。
3. 开启右上角 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择项目中的 `extension/` 文件夹。
5. 工具栏出现扩展图标后即可使用。

### 方式二：通过 Release 安装

1. 在 [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) 下载最新 `YuxTrans-extension-v0.3.0.zip` 并解压。
2. 按方式一的第 2–4 步加载解压后的 `extension/` 目录。

---

## 使用方式

### 1. 配置翻译服务

点击扩展图标 → **设置**，进入 **翻译服务** 标签页：

| 类型 | 操作 |
| :--- | :--- |
| **本地 Ollama** | 选择 Provider 为 `local`，填写模型名（如 `qwen3.5:0.8b`），确保 Ollama 已启动。 |
| **云端供应商** | 选择 `qwen / openai / deepseek / anthropic / groq / moonshot / siliconflow`，填写 API Key 与模型。 |
| **自定义供应商** | 选择 `custom`，填写端点、API Key、API 格式与模型，支持任意 OpenAI 兼容接口。 |

填写后点击 **保存并启用档案**。每组配置会成为一个独立的 ProviderProfile，可在下方 **模型管理** 列表中启用或移除。

> API Key 与配置仅保存在浏览器本地 `chrome.storage.local` 与 IndexedDB，不会同步到云端账号。

### 2. Popup 控制面板

点击工具栏扩展图标打开小巧的控制面板：

- **模型切换**：下拉栏切换已保存的 ProviderProfile。
- **整页翻译**：一键翻译当前页面。
- **流式翻译开关**：开启后长文本会以流式输出呈现。
- **连接状态**：实时检测当前档案是否可连通。
- **用量看板**：展示累计 token、缓存命中率、词库数量。

### 3. 划词翻译

三种触发方式：

- **鼠标选中**：选中网页文本后松开鼠标，出现金色浮动按钮，点击即可翻译。
- **快捷键**：`Ctrl + Shift + T`（macOS `Command + Shift + T`）。
- **右键菜单**：右键选中文本 → **翻译选中内容**。

### 4. 整页翻译

- **快捷键**：`Ctrl + Shift + P`（macOS `Command + Shift + P`）。
- **右键菜单**：在页面空白处右键 → **翻译整页**。

开始后页面文本会分批替换为译文，可视区域优先处理。默认双语对照，译文以黄铜色左边框区分；可通过浮层面板切换为仅译文或恢复原文。

### 5. 快捷键一览

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + Shift + T` / `⌘ + Shift + T` | 翻译选中内容 |
| `Ctrl + Shift + P` / `⌘ + Shift + P` | 翻译整页 |

可在浏览器 `chrome://extensions/shortcuts` 中修改。

### 6. 站点规则

在设置 → **操作与网站规则** 中配置：

- **全部站点**：所有网页启用翻译。
- **仅白名单**：只在列表中的站点启用。
- **排除黑名单**：在列表中的站点禁用。

每行一个域名，支持精确匹配（`example.com`）或通配子域名（`*.example.com`）。

### 7. 缓存与数据

- 翻译结果自动写入 **IndexedDB**，默认物理上限 **200MB**，达到后按 LRU 淘汰。
- 安装时预置常用热词库，常见短句可毫秒级命中。
- 设置页可查看累计翻译次数、缓存命中次数、命中率与物理空间占用。
- 点击 **清除本地数据** 可一键清空缓存与模型档案。

### 8. 更新

扩展启动时会通过 GitHub API 检查最新版本。发现新版后图标会显示 **[NEW]** 角标，进入设置页点击 **检查更新** 可查看更新指引。

---

## 支持的服务商

| 供应商 | 默认端点 | 默认模型 |
| :--- | :--- | :--- |
| 通义千问 (qwen) | DashScope 兼容模式 | `qwen-turbo` |
| OpenAI | OpenAI API | `gpt-4o` |
| DeepSeek | DeepSeek API | `deepseek-chat` |
| Anthropic | Claude Messages API | `claude-3-5-sonnet-latest` |
| Groq | Groq OpenAI 兼容 | `llama-3.3-70b-versatile` |
| Moonshot | Moonshot API | `moonshot-v1-8k` |
| SiliconFlow | SiliconFlow API | `Qwen/Qwen2.5-7B-Instruct` |
| Ollama (local) | `http://localhost:11434/api/chat` | 自定义 |
| Custom | 用户填写 | 用户填写 |

---

## 本地开发与测试

```bash
# 浏览器扩展核心逻辑单元测试
npm test

# Python 包代码检查与测试
ruff check yuxtrans/ tests/
pytest --tb=short -q
```

当前核心交付形态为浏览器扩展，Python 包处于维护状态。

---

## 贡献

欢迎提交 Issue 与 PR：

- 优化小模型在不同翻译风格下的 Prompt。
- 扩展 Warm Paper 主题或增加深色模式细节。
- 补充更多语言的常用热词缓存。

---

## 许可证

基于 [MIT License](LICENSE) 协议发布。

<p align="center">
  <strong>YuxTrans —— 让翻译更精准，让阅读更优雅。</strong>
</p>
