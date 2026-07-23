<p align="center">
  <sub><b>简体中文</b> · <a href="README_EN.md">English</a></sub>
</p>

<p align="center">
  <img src="logo/logo.png" width="96" alt="YuxTrans">
</p>

<h1 align="center">YuxTrans</h1>

<p align="center">
  <em>翻译退至页边，阅读留在正中。</em><br>
  <span>一款面向深阅读的 AI 翻译浏览器扩展</span><br>
  <em>A translation extension for deep reading.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Yaemikoreal/YuxTrans?color=d8a051&label=Version" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-fdf6ec.svg?labelColor=d8a051" alt="License">
</p>

---

## 关于 YuxTrans

YuxTrans 是一个纯浏览器扩展，不依赖任何后端服务。Service Worker 直接连接本地 Ollama 或云端 API，在网页边缘完成翻译，再把结果以页边批注的形式落回原文一侧。

它不为功能密度而生，只回应一个问题：在长篇阅读里，翻译如何尽量不打断思路。围绕这个问题，它只做三件事，并努力把它们做安静——

- **本地优先**：原生支持 Ollama，敏感文本不出本机，离线亦可阅读。
- **稳态可依**：本地模型不可用或云端限流时，自动切换备用供应商；默认 200MB IndexedDB 缓存，命中即毫秒返回。
- **档案式管理**：设置页保存多组「供应商档案」（Provider、凭据、模型），popup 中一键切换。

## 设计取向

视觉遵循「书房衬纸」原则：墨韵为骨，暖纸为底，暮瞳作微光。界面不作主角，而像铺在网页边缘的一层薄纸——译文以左侧细竖线标注，如批注栏；加载态是未写完的省略号，而非旋转的环。

色彩饱和度被刻意压低，拒绝纯黑纯白与高饱和科技色，亦不取胶囊按钮与骨架屏。所有动效带有翻书页般的重量感，却不停滞。原则只有一句：让读者忘记自己正在使用一个工具。

## 界面预览

以下截图以 LangGraph 官方文档页为例，呈现从配置到整页翻译的完整过程。

### 配置供应商档案

设置页以侧边目录加折页形式展开，保存「供应商档案」（Provider、API Key、模型），可存多组一键切换。凭据仅留存在浏览器本地。

![设置页 — 供应商档案配置](logo/使用样例-设置.png)

### Popup 控制面板

工具栏图标点开是一方小册：连接状态、模型切换、整页翻译、翻译模式（仅译文 / 双语）、流式开关，以及用量与缓存看板。

![Popup 控制面板](logo/使用样例-弹窗板.png)

### 整页翻译：原文 → 双语 → 仅译文

**翻译前**，页面为纯英文原文：

![未翻译的英文原文](logo/使用样例-未翻译的原文.png)

**双语模式**，每句原文之后以浅色斜体内联追加译文，保留原排版与节奏；底部进度条记录批次进度与缓存 / API 命中：

![双语对照结果](logo/使用样例-双语结果.png)

**仅译文模式**，整页替换为译文，可一键恢复原文：

![仅译文结果](logo/使用样例-仅译文结果.png)

---

## 安装

1. 下载仓库源码并解压。
2. 打开 Chrome / Edge，访问 `chrome://extensions/` 或 `edge://extensions/`。
3. 开启右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择项目中的 `extension/` 文件夹。
5. 工具栏出现图标后即可使用。

> 也可在 [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) 下载最新 `YuxTrans-extension-v*.zip`，解压后加载。

---

## 配置

点击扩展图标 →「设置」，进入「翻译服务」标签页：

| 类型 | 操作 |
| :--- | :--- |
| 本地 Ollama | Provider 选 `local`，填写模型名（如 `qwen3.5:0.8b`），确保 Ollama 已启动。 |
| 云端供应商 | 选 `qwen` / `openai` / `deepseek` / `anthropic` / `groq` / `moonshot` / `siliconflow`，填写 API Key 与模型。 |
| 自定义供应商 | 选 `custom`，填写端点、API Key、API 格式与模型，兼容任意 OpenAI 接口。 |

填写后点击「保存并启用档案」。API Key 与配置仅保存在浏览器本地，不同步至云端账号。

## 用法

### 划词翻译

- 选中网页文本后松开鼠标，点击浮现的标签纸即可翻译。
- 快捷键 `Ctrl + Shift + T`（macOS `⌘ + Shift + T`）。
- 右键选中文本 →「翻译选中内容」。

### 整页翻译

- 快捷键 `Ctrl + Shift + P`（macOS `⌘ + Shift + P`）。
- 页面空白处右键 →「翻译整页」。

页面文本会分批替换为译文，可视区域优先。默认双语对照，可在浮层面板切换为仅译文，或恢复原文。

### 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + Shift + T` / `⌘ + Shift + T` | 翻译选中内容 |
| `Ctrl + Shift + P` / `⌘ + Shift + P` | 翻译整页 |

可在浏览器 `chrome://extensions/shortcuts` 中自定义。

---

## 许可证

基于 [MIT License](LICENSE) 发布。

<p align="center">
  <em>YuxTrans —— 翻译退至页边，阅读留在正中。</em>
</p>
