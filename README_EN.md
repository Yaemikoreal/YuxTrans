<p align="center">
  <sub><a href="README.md">简体中文</a> · <b>English</b></sub>
</p>

<p align="center">
  <img src="logo/logo.png" width="96" alt="YuxTrans">
</p>

<h1 align="center">YuxTrans</h1>

<p align="center">
  <em>Translation recedes to the margin; reading stays at the center.</em><br>
  <span>An AI translation extension for deep reading.</span><br>
  <em>一款面向深阅读的 AI 翻译浏览器扩展</em>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Yaemikoreal/YuxTrans?color=d8a051&label=Version" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-fdf6ec.svg?labelColor=d8a051" alt="License">
</p>

---

## About

YuxTrans is a pure browser extension with no backend of its own. The Service Worker connects directly to a local Ollama instance or a cloud API, performs translation at the edge of the page, and lays the result back beside the original as a margin annotation.

It is not built for feature density. It answers a single question: in long-form reading, how can a translation interrupt the train of thought as little as possible. Around that question it does three things, and tries to do them quietly--

- **Local first.** Native Ollama support keeps sensitive text on the machine; reading works offline.
- **Steady by design.** When the local model is unavailable or the cloud throttles, it falls back to a spare provider; a 200 MB IndexedDB cache returns cached results in milliseconds.
- **Profile-based management.** Save multiple provider profiles (provider, credentials, model) in the settings page, and switch between them in the popup.

## Design intent

The visual language follows a "study paper" principle: ink as the bone, warm paper as the ground, dusk as a faint glow. The interface is never the subject--it is a thin sheet of paper laid at the edge of the page. Translations are marked with a thin vertical line on the left, like a margin note; the loading state is an unfinished ellipsis, not a spinning ring.

Saturation is deliberately held low: no pure black or white, no high-saturation tech color, no capsule buttons or skeleton screens. Every motion carries the weight of a turning page, yet never stalls. The rule is a single sentence: let the reader forget they are using a tool.

## Preview

The screenshots below use the LangGraph documentation site, tracing the path from setup to full-page translation.

### Configure a provider profile

The settings page opens as a sidebar table of contents beside a folded leaf, where "provider profiles" (provider, API key, model) are saved and switched with one click. Credentials stay in the browser only.

![Settings - provider profile](logo/使用样例-设置.png)

### Popup control panel

The toolbar icon opens a small booklet: connection status, model switch, full-page translation, translation mode (translation-only / bilingual), streaming toggle, and a usage and cache panel.

![Popup control panel](logo/使用样例-弹窗板.png)

### Full-page translation: original -> bilingual -> translation-only

**Before**, the page is plain English:

![Untranslated English original](logo/使用样例-未翻译的原文.png)

**Bilingual mode** appends each translation inline after its source as a light italic, preserving the original layout and rhythm; the progress bar at the foot records batch progress and cache / API hits:

![Bilingual result](logo/使用样例-双语结果.png)

**Translation-only mode** replaces the whole page with the translation, and the original can be restored with one click:

![Translation-only result](logo/使用样例-仅译文结果.png)

---

## Install

1. Download the repository and unzip it.
2. Open Chrome / Edge and visit `chrome://extensions/` or `edge://extensions/`.
3. Enable "Developer mode" in the top-right.
4. Click "Load unpacked" and select the `extension/` folder in the project.
5. The icon appears in the toolbar once loaded.

> Alternatively, download the latest `YuxTrans-extension-v*.zip` from [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) and load it after unzipping.

---

## Configure

Click the extension icon -> "Settings", then open the "Translation service" tab:

| Type | Action |
| :--- | :--- |
| Local Ollama | Set Provider to `local`, enter a model name (e.g. `qwen3.5:0.8b`), and ensure Ollama is running. |
| Cloud provider | Choose `qwen` / `openai` / `deepseek` / `anthropic` / `groq` / `moonshot` / `siliconflow`, and enter the API key and model. |
| Custom provider | Choose `custom`, and enter the endpoint, API key, API format, and model; any OpenAI-compatible interface works. |

Click "Save and activate profile" when done. The API key and configuration are stored in the browser only and never synced to a cloud account.

## Usage

### Selection translation

- Select text on a page, release the mouse, and click the floating label to translate.
- Shortcut `Ctrl + Shift + T` (macOS `⌘ + Shift + T`).
- Right-click the selection -> "Translate selection".

### Full-page translation

- Shortcut `Ctrl + Shift + P` (macOS `⌘ + Shift + P`).
- Right-click an empty area of the page -> "Translate page".

Text is replaced in batches, prioritizing the visible region. Bilingual is the default; switch to translation-only or restore the original from the floating panel.

### Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + Shift + T` / `⌘ + Shift + T` | Translate selection |
| `Ctrl + Shift + P` / `⌘ + Shift + P` | Translate page |

Both can be customized at `chrome://extensions/shortcuts`.

---

## License

Released under the [MIT License](LICENSE).

<p align="center">
  <em>YuxTrans -- Translation recedes to the margin; reading stays at the center.</em>
</p>
