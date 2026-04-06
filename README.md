# 🌟 YuxTrans

<p align="center">
  <strong>响应速度是生命，沉浸阅读是灵魂</strong>
</p>

<p align="center">
  一款为极客打造的“深阅读” AI 翻译浏览器扩展。支持本地 Ollama 模型原生加速与海量 200MB 物理定额缓存。
</p>

<p align="center">
  <a href="https://github.com/Yaemikoreal/YuxTrans/releases/latest">
    <img src="https://img.shields.io/github/v/release/Yaemikoreal/YuxTrans?color=d8a051&label=version" alt="Version">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-fdf6ec.svg?labelColor=d8a051" alt="License">
  </a>
  <a href="https://github.com/Yaemikoreal/YuxTrans/stargazers">
    <img src="https://img.shields.io/github/stars/Yaemikoreal/YuxTrans?color=orange&label=stars" alt="Stars">
  </a>
</p>

---

## ✨ v0.3.0 "Deep Reading" 精研版核心特性

- **🚀 本地模型“断点免疫” (Stall Resistance)**: 深度优化 **Qwen 3.5 4B** 等本地模型，攻克长页面翻译死锁。检测到 JSON 异常时全自动降级至“单句稳健模式”，确保 100% 成功率。
- **💾 200MB 级物理定额储存**: 彻底告别段落计数。基于全量字节物理占用进行 LRU 回收，并配有**可视化存储进度看板**。
- **🎨 Warm Paper 护眼美学**: isometric 圆角、柔和米色/深邃暗淡双色模式。不仅是工具，更是浏览器中最优雅的阅读伴侣。
- **🤖 翻译人格定制**: 预设“日常、学术、技术、文学”四类翻译人格，支持保留技术核心术语或追求文学意境。
- **✨ 自动更新感应**: 基于 GitHub API 异步感应，发现新版即刻在图标挂载红色 **[NEW]** 角标，支持“傻瓜式一键换新”。

---

## 📸 视觉大赏 (Visual Showcase)

> [!TIP]
> **Warm Paper UI设计**：我们对设置中心的每一个间距、每一处投影都进行了克制的打磨。
> *[此处应有设置中心截图]* | *[此处应有划词弹窗截图]*

---

## 📦 极简“傻瓜式”安装 (Quick Start)

YuxTrans 目前采用直发 ZIP 模式，三步即刻开启深阅读：

1.  **下载 ZIP**: 在 [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) 页面下载最新的 `Source Code (zip)` 并解压到本地。
2.  **加载扩展**: 
    * 打开 Chrome 浏览器，进入 `chrome://extensions/`。
    * 开启右上角的 **「开发者模式」**。
    * 点击 **「加载已解压的扩展程序」**，选择项目的 `extension/` 目录。
3.  **配置 AI**: 点击扩展图标进入设置，连接您的本地 Ollama 或填入云端 API Key。

---

## 🛠 引擎与架构

YuxTrans 采用 **Hybrid-Router (混合路由)** 架构，确保翻译请求的绝对稳健：

1.  **物理缓存层 (<0.1ms)**: 优先从 200MB 的 IndexedDB 中秒回。
2.  **本地推理层 (<500ms)**: 优先触发本地 **Ollama** 实例。
3.  **云端兜底层 (<2.0s)**: 在本地模型不可用或资源受限时，自动选择配置的云端 Provider。

| 模式 | 核心逻辑偏好 |
| :--- | :--- |
| **日常模式** | 通俗易懂，适合新闻与社交媒体。 |
| **学术模式** | 用词严谨，适合论文阅读与研究报告。 |
| **技术模式** | **极客优化**，核心术语（API/Method）保留英文原词。 |
| **文学模式** | 追求信雅达，适合博文与创意小说。 |

---

## 🌐 支持的云端供应商

| Qwen (通义千问) | DeepSeek | OpenAI | Anthropic |
| :--- | :--- | :--- | :--- |
| Moonshot (Kimi) | Siliconflow | Groq | 各类兼容 OpenAI 格式的地址 |

---

## 🤝 贡献与参与

我们欢迎所有对“沉浸式阅读”有极致追求的开发者加入：
- 提交 Issue 建议新的 UI 配图。
- 参与 4B/7B 本地模型的 Prompt 调优。
- 完善多语言翻译 Persona。

---

## 许可证

基于 [MIT License](LICENSE) 协议发布。

<p align="center">
  Built with ❤️ for Deep Readers.
</p>