# ADR 0002: Options 页职责拆分为 ProviderProfile 与 ActiveConfig

## 状态
Accepted

## 背景
当前 Options 页同时承担两类职责：

1. **保存供应商配置记录**（`saveProviderBtn`）：把 provider、apiKey、endpoint、model 等写入 IndexedDB，并设为当前 config。
2. **保存通用设置**（`saveBtn`）：保存语言方向、缓存、站点规则、行为开关等。

这导致：
- 用户不清楚应该先点哪个保存按钮。
- 切换 provider 下拉框时，表单不会自动回填对应已保存记录的凭据和模型。
- “模型管理列表”中的“启用”与 provider 下拉框状态不同步。

## 决策
将 Options 页拆分为两个明确的概念：

### ProviderProfile（供应商档案）
- 一条可复用的模板，包含：`provider`、`apiKey`、`apiEndpoint`、`model`、`localModel`、`customProvider`。
- 支持新增、测试连接、保存、删除、在列表中一键启用。
- 多条档案共存，但**只有被 ActiveConfig 引用的那条才生效**。

### ActiveConfig（当前运行配置）
- 引用一个 `activeProfileId`。
- 保存与供应商无关的运行时偏好：`sourceLang`、`targetLang`、`translateStyle`、`bilingualMode`、`triggerMode`、`autoCopy`、`maxCacheMB`、`siteRule`、`siteList`、`autoDetectLang`、`autoFallback`、`enableStreaming`。
- 提供“当前使用”的只读展示，并在切换 profile 时自动刷新。

### UI 调整
- 第一个标签页改为「供应商档案」：左侧列表，右侧表单。
- 第二个标签页改为「通用设置」：语言、风格、行为、缓存、站点规则。
- 删除重复的“保存服务商配置”与“保存设置”按钮，改为每个标签页一个明确的“保存”动作。

## 后果

- `background.js` 的 `config` 对象结构需要调整：引入 `activeProfileId` 和 `profiles`（或继续复用 IndexedDB models 表）。
- 需要向后兼容旧版 `config`：启动时若检测到旧格式，自动迁移为 `activeProfileId + profiles`。
- `popup.js` 的模型下拉栏可直接读取 profiles 列表，切换时修改 `activeProfileId` 并触发测试连接。

## 拒绝的替代方案

- **保留现状，只改文案**：没有解决“两个保存按钮”背后的概念冲突。
- **把所有字段合并到一个巨大的保存按钮**：会让保存动作范围过大，用户不敢点击，且无法管理多套供应商档案。
