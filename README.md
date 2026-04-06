# 🌟 YuxTrans

<p align="center">
  <strong>精准而优雅</strong>
</p>

<p align="center">
  一处为您屏除杂讯、只留真意的沉浸式 AI 翻译空间。
</p>

<p align="center">
  <a href="https://github.com/Yaemikoreal/YuxTrans/releases/latest">
    <img src="https://img.shields.io/github/v/release/Yaemikoreal/YuxTrans?color=d8a051&label=Version" alt="Version">
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-fdf6ec.svg?labelColor=d8a051" alt="License">
  </a>
  <a href="https://github.com/Yaemikoreal/YuxTrans/stargazers">
    <img src="https://img.shields.io/github/stars/Yaemikoreal/YuxTrans?color=orange&label=Stars" alt="Stars">
  </a>
</p>

---

## 🕊️ 精准而优雅：翻译的终极形态

在万物皆可 AI 的时代，**YuxTrans** 选择了另一条路 —— 专注于**阅读的深度**与**交互的质感**。我们相信，翻译不应只是文字的转换，而应是意蕴的无缝流动。

### 🚀 **核心突破：Stall-Free 断点免疫**

*   **突围 Qwen 4B**: 针对本地小模型（如 Qwen 3.5 4B）在大规模长页面翻译时的死锁痛点，我们实现了“全自愈模式”。
*   **优雅降级**: 当模型因处理上百段落而疲惫时，系统会自动切入“单句稳步推进”，确保进度条永远向 100% 迈进，杜绝任何形式的页面卡死。

### 💾 **物理定额：200MB 的长效记忆**

*   **让记忆有重量**: 弃用虚浮的段落计数。我们以真实字节核算存储，200MB 的 IndexedDB 定额是专为您打造的私家图书馆。
*   **瞬时响应**: 哪怕是万字长文，只要曾经读过，即便处于离线荒原，译文也会在 0.1ms 内以最精准的姿态重现。

### 🎨 **暖页美学：Warm Paper 设计哲学**

*   **拒绝光污染**: 采用 isometric 圆角与柔和米色调。深夜模式下，文字呈现出墨水般的凝重，而非刺眼的冷白。
*   **人格化引擎**: 
    - **日常版**: 像老友交谈般平实。
    - **学术版**: 保持学者应有的严谨。
    - **技术版**: **精准锁定** API 与核心变量，不翻译、不破坏。
    - **文学版**: 捕捉字里行间的诗意。

---

## 📸 视觉画廊 (Gallery)

> [!TIP]
> **设计初衷**：每一处投影、每一条分割线都经过了克制的推敲，旨在让工具退后，内容向前。
> *[此处展示：极简设置中心]* | *[此处展示：沉浸式浮动弹窗]*

---

## 📦 简易安装指引 (Quiet Installation)

依托“傻瓜式”交付逻辑，仅需三步，即可在浏览器中复刻这一优雅空间：

1.  **取包**: 在 [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) 获取最新的 v0.3.0 源代码并解压。
2.  **点亮**: 开启 Chrome 的 **开发者模式**，点击“加载已解压的扩展程序”，指定项目中的 `extension/` 文件夹。
3.  **连接**: 点击扩展图标，唤起那一抹温暖，连接您的本地 **Ollama** 或 **云端 API**。

---

## 🏠 本地优先架构 (Local-First)

我们坚守隐私的红线。通过 **Hybrid-Router** 架构，本地 **Ollama** 将作为您的第一翻译序列。数据不出户，真意已自达。

| 架构层级 | 响应效率 | 设计初衷 |
| :--- | :--- | :--- |
| **持久层 (Cache)** | < 0.1ms | 零耗时复现已读真意 |
| **本地层 (Ollama)** | < 0.5s | 极速保护隐私的离线翻译 |
| **云端层 (API)** | < 2.0s | 针对极复杂语义的终极保障 |

---

## 🤝 参与这一场关于优雅的实验

如果您也认为翻译不该是一种负担，欢迎开发者与极客共同参与：
- 协助我们优化 4B/7B 模型在不同翻译人格下的 Prompt。
- 完善更多语言对的“精准性”校准。
- 提出更多关于 Warm Paper 质感的 UI 优化。

---

## 许可证

基于 [MIT License](LICENSE) 协议发布。

<p align="center">
  <strong>YuxTrans —— 让极简更深邃，让精准更优雅。</strong>
</p>