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

YuxTrans 是一个**纯浏览器扩展**，不需要 Python 后端。它在 Service Worker 中直接连接本地 Ollama 或云端 API，为网页阅读提供快速、稳定、可离线使用的翻译体验。

设计目标只有三个：**轻量**、**准确**、**稳定**。

---

## 核心特性

- **本地优先**：原生支持 Ollama，敏感文本不出户，离线也能翻译。
- **自动故障转移**：本地模型不可用或云端限流时，自动切换备用供应商。
- **物理定额缓存**：默认 200MB IndexedDB 缓存 + 预置热词库，命中时毫秒级返回。
- **档案式模型管理**：在设置页保存多组「ProviderProfile」，popup 中一键切换模型。
- **现代简约视觉**：清透原生质感，让工具退后、内容向前。

---

## 安装

1. 下载本仓库源码并解压。
2. 打开 Chrome / Edge，访问 `chrome://extensions/` 或 `edge://extensions/`。
3. 开启右上角 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择项目中的 `extension/` 文件夹。
5. 工具栏出现扩展图标后即可使用。

> 也可在 [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) 下载最新 `YuxTrans-extension-v*.zip` 并解压后加载。

---

## 快速使用

### 配置翻译服务

点击扩展图标 → **设置**，进入 **翻译服务** 标签页：

| 类型 | 操作 |
| :--- | :--- |
| **本地 Ollama** | 选择 Provider 为 `local`，填写模型名（如 `qwen3.5:0.8b`），确保 Ollama 已启动。 |
| **云端供应商** | 选择 `qwen / openai / deepseek / anthropic / groq / moonshot / siliconflow`，填写 API Key 与模型。 |
| **自定义供应商** | 选择 `custom`，填写端点、API Key、API 格式与模型，支持任意 OpenAI 兼容接口。 |

填写后点击 **保存并启用档案**。API Key 与配置仅保存在浏览器本地，不会同步到云端账号。

### Popup 控制面板

点击工具栏扩展图标打开控制面板：

- **模型切换**：下拉栏切换已保存的 ProviderProfile。
- **整页翻译**：一键翻译当前页面。
- **连接状态**：实时检测当前档案是否可连通。

### 划词翻译

- **鼠标选中**：选中网页文本后松开鼠标，点击浮动按钮即可翻译。
- **快捷键**：`Ctrl + Shift + T`（macOS `Command + Shift + T`）。
- **右键菜单**：右键选中文本 → **翻译选中内容**。

### 整页翻译

- **快捷键**：`Ctrl + Shift + P`（macOS `Command + Shift + P`）。
- **右键菜单**：在页面空白处右键 → **翻译整页**。

开始后页面文本会分批替换为译文，可视区域优先处理。默认双语对照，可通过浮层面板切换为仅译文或恢复原文。

### 快捷键一览

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + Shift + T` / `⌘ + Shift + T` | 翻译选中内容 |
| `Ctrl + Shift + P` / `⌘ + Shift + P` | 翻译整页 |

可在浏览器 `chrome://extensions/shortcuts` 中修改。

---

## 许可证

基于 [MIT License](LICENSE) 协议发布。

<p align="center">
  <strong>YuxTrans —— 让翻译更精准，让阅读更优雅。</strong>
</p>
