# YuxTrans Extension v0.5.0 — 稳定版发布说明

**发布日期：** 2026-07-24  
**通道：** Stable（正式版）  
**产品：** 浏览器扩展（Chrome / Edge · Manifest V3）  
**版本号：** `extension/manifest.json` → `0.5.0`

> 相对 `v0.4.1` 的首个**推荐生产使用**的 0.5 线正式版。  
> 若你安装过 `v0.5.0-beta.1`，请升级到本版本；beta 仅供预览。

---

## 一句话

把深阅读翻译从「能用」推进到「好用、可管、可停」：更强的页内交互、更省的整页流式、更清晰的设置架构，以及可自定义的风格提示词。

---

## 本版亮点

### 1. 阅读交互（F1–F8）

| 能力 | 说明 |
|------|------|
| 悬停译段 | Alt/Ctrl + 悬停段落，段落后出译文 |
| 单词词典 | 划词/双击单词 → 音标、义项、双语例句 |
| 原文呈现 | 双语对照 / 弱化 / 模糊（悬停还原） |
| 浮窗钉住 | 多结果对照不互相覆盖 |
| 双档案对照 | 同一句用两个供应商档案并排译 |
| 输入框翻译 | 选区翻译并插入回 input/textarea |
| 正文识别 | 整页跳过导航/侧栏/页脚 |
| 谷歌免 Key | 开箱即用的免费接口 |
| Ollama 分档 | 最快 / 推荐 / 最佳质量模型建议 |

### 2. 整页翻译与配额

- **段落级 SSE 流式**：边译边显示  
- **取消即停**：abort 在途请求，不再后台烧额度  
- **视口优先（belowFold）**：先翻看得见的区域  
- **同文去重调度**：划词与整页撞同一 cacheKey 只请求一次  
- **批量滑动窗口**：跨段指代更连贯  

### 3. 设置页（稳定版关键体验）

- **五个模块**：服务档案 · 翻译偏好 · 交互与显示 · 数据与存储 · 诊断排障  
- **分栏保存**：改哪页存哪页，避免「万能保存」误触  
- **风格提示词**：四种风格各自可改、可恢复默认，写入翻译指令  
- **书房氛围**：缓漂光晕 + 分区点缀色（尊重减少动态偏好）  

### 4. 工程与质量

- Service Worker 纯函数模块化（`extension/lib/sw/*`）  
- 产品收敛为**唯一扩展产品**（Python 包/桌面端已移除）  
- 自动化：`npm test` **91 pass / 0 fail**；结构门禁通过  
- 修复：飞书等多维表格上 Text 节点 `closest` 崩溃；设置页 TDZ 导致无法切换 Tab  

---

## 安装 / 升级

### 新装（推荐 zip）

1. 下载本 Release 附件 `YuxTrans-extension-v0.5.0.zip` 并解压  
2. Chrome / Edge → 扩展管理 → 开发者模式 → **加载已解压的扩展程序**  
3. 选择解压后的 `extension` 目录（或 zip 解压出的根目录，以含 `manifest.json` 为准）  
4. 打开扩展设置，完成服务档案或首次引导  

### 从 0.4.x / beta 升级

1. 覆盖本地扩展目录后，在扩展管理页点 **重新加载**  
2. 打开设置：检查语言/风格、交互开关、缓存与术语表  
3. 各模块分别点一次保存（偏好 / 交互 / 数据）  
4. 若自定义过风格提示词后译文异常，可恢复默认或清理本地缓存  

---

## 验证情况（发版门禁）

| 项 | 结果 |
|----|------|
| `npm test` 双跑 | 91 / 91，fail 0 |
| Manifest MV3 + 入口文件 | 通过 |
| Options 五 Tab + 分栏保存 + 风格编辑器 | 通过 |
| 关键符号（style prompt / event closest / 无 TDZ） | 通过 |

**未纳入自动化、建议人工 5–10 分钟冒烟：**

- 真实网页划词 + 整页（流式开/关 + 取消）  
- 词典 / 悬停译段  
- 自定义风格提示词后译一句  
- 飞书 Base 等复杂页无控制台报错  
- 你日常使用的云端或 Ollama 路径各走一次  

---

## 已知边界

- 扩展**无自有后端**；云端质量与配额取决于你配置的供应商  
- 短文（&lt;12 字符）默认不写译文缓存（词典键除外），属严格命中策略  
- 安卓端仍为 roadmap，不在本包内  

---

## 完整变更列表

见仓库根目录 [CHANGELOG.md](../CHANGELOG.md) 中 **[0.5.0] - 2026-07-24**。

---

## English summary

**YuxTrans Extension v0.5.0 (Stable)** is the first recommended production build of the 0.5 line. It ships F1–F8 reading interactions, full-page streaming with cancel and viewport-aware batching, a five-module Options IA with per-module save, customizable style prompts, Feishu-safe event target handling, SW modularization, and 91 green unit tests. Load the attached zip as an unpacked Chrome/Edge extension and re-test your primary translate paths after upgrade.
