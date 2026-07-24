<p align="center">
  <sub><a href="README.md">简体中文</a> · <b>English</b></sub>
</p>

<p align="center">
  <img src="logo/logo.png" width="96" alt="YuxTrans">
</p>

<h1 align="center">YuxTrans</h1>

<p align="center">
  <em>Translation recedes to the margin; reading stays at the center.</em><br>
  <span>An AI translation browser extension for deep reading.</span><br>
  <em>一款面向深阅读的 AI 翻译浏览器扩展</em>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Yaemikoreal/YuxTrans?color=d8a051&label=Version" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-fdf6ec.svg?labelColor=d8a051" alt="License">
</p>

---

## About

YuxTrans is a **pure browser extension** with no backend of its own. The Service Worker connects directly to a local Ollama instance or a cloud API, translates at the edge of the page, and lays the result back beside the original as a margin annotation.

It is not built for feature density. It answers a single question: in long-form reading, how can translation interrupt the train of thought as little as possible. Around that question it does three things, and tries to do them quietly—

- **Local first.** Native Ollama support keeps sensitive text on the machine; reading works offline.
- **Steady by design.** When the local model is unavailable or the cloud throttles, it falls back to a spare provider; a 200 MB IndexedDB cache returns hits in milliseconds.
- **Profile-based management.** Save multiple provider profiles (provider, credentials, model) in Settings, and switch them in the popup.

Current stable release: **v0.5.0**.

## Design intent

The visual language follows a “study paper” principle: ink as the bone, warm paper as the ground, dusk as a faint glow. The interface is never the subject—it is a thin sheet of paper laid at the edge of the page. Translations are marked with a thin vertical line on the left, like a margin note; the loading state is an unfinished ellipsis, not a spinning ring.

Saturation is deliberately low: no pure black or white, no high-saturation tech colors, no capsule buttons or skeleton screens. The rule is a single sentence: let the reader forget they are using a tool.

---

## Preview

Screenshots below use the LangGraph documentation site and follow a real usage path (assets under `logo/`).

### 1. Settings · Service profiles

Five sidebar modules: Service profiles · Translation preferences · Interaction & display · Data & storage · Diagnostics. In **Service profiles**, configure provider, API key, and model; save multiple profiles and activate with one click. Credentials stay in the local browser only.

![Settings — service profiles](logo/使用样例-设置.png)

### 2. Settings · Translation preferences

Active profile summary, offline mode, language direction, and four styles (everyday / academic / technical / literary). Each style can have a custom **style prompt**, saved with preferences.

![Settings — translation preferences](logo/使用样例-设置-2.png)

### 3. Popup control panel

The toolbar icon opens a small booklet: profile switcher, connection status, **Translate page**, translation-only / bilingual, streaming toggle, and a collapsible usage & cache panel.

![Popup control panel](logo/使用样例-弹窗板.png)

### 4. Selection translation

Select page text to open a light floating panel: source and translation, copy or mark a bad hit; pin multiple panels for comparison without blocking reading.

![Selection translation popup](logo/使用样例-划词翻译.png)

### 5. Hover paragraph translation (Alt)

Hold a modifier (default **Alt**, or Ctrl in Settings) and hover a paragraph; the translation appears as a margin sticky note after the paragraph and can be dismissed without selecting text.

![Alt hover paragraph translation](logo/使用样例-Alt快捷键翻译.png)

### 6. Full-page translation: original → bilingual → translation-only

**Before**, the page is plain English:

![Untranslated English original](logo/使用样例-未翻译的原文.png)

**Bilingual mode** appends each translation inline after its source as light italic, preserving layout and rhythm; the control bar records progress and cache / API hits:

![Bilingual result](logo/使用样例-双语结果.png)

**Translation-only mode** replaces the whole page with the translation; restore the original with one click:

![Translation-only result](logo/使用样例-仅译文结果.png)

---

## Install

1. Download the latest `YuxTrans-extension-v*.zip` from [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) and unzip; or clone this repository.
2. Open Chrome / Edge and visit `chrome://extensions/` or `edge://extensions/`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the **`extension/`** folder (must contain `manifest.json`).
5. The toolbar icon appears once loaded.

---

## Configure

Click the extension icon → **Settings**:

| Module | Purpose |
| :--- | :--- |
| **Service profiles** | Local Ollama / cloud providers / custom OpenAI-compatible endpoints; save and activate a profile. |
| **Translation preferences** | Language direction, style, style prompts, offline mode. |
| **Interaction & display** | Selection trigger, streaming, hover / dictionary, original-text style, etc. |
| **Data & storage** | Glossary, cache quota, import/export, site rules. |
| **Diagnostics** | Usage and request logs (read-only). |

| Type | Action |
| :--- | :--- |
| Local Ollama | Provider `local`, model name (e.g. `qwen3.5:0.8b`); ensure Ollama is running. |
| Cloud provider | Choose `qwen` / `openai` / `deepseek` / `anthropic` / `groq` / `moonshot` / `siliconflow` / `google` (no key), etc.; enter API key and model. |
| Custom provider | Choose `custom`; enter endpoint, API key, format, and model. |

Each writable module has its own **Save** button—save only what you changed. API keys and config stay in the browser only.

---

## Usage

### Selection translation

- Select text and release the mouse (default: show popup on select; can switch to floating icon or context menu only in Settings).
- Shortcut `Ctrl + Shift + T` (macOS `⌘ + Shift + T`).
- Right-click selection → **Translate selection**.

### Hover paragraph translation

- Enable **Hover paragraph translation** under Interaction & display.
- Hold **Alt** (or your chosen modifier) and hover a paragraph ~300ms; a translation sticky appears after the block.

### Word dictionary

- With **Word dictionary mode** on, select or double-click a word for a definition card (phonetic, senses, examples).

### Full-page translation

- Popup primary button **Translate page**.
- Shortcut `Ctrl + Shift + P` (macOS `⌘ + Shift + P`).
- Right-click empty page area → **Translate page**.

Viewport-first batching; optional streaming (token-by-token) and cancel; switch bilingual / translation-only or restore original from the control bar.

### Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + Shift + T` / `⌘ + Shift + T` | Translate selection |
| `Ctrl + Shift + P` / `⌘ + Shift + P` | Translate page |
| `Alt` (configurable) + hover | Paragraph translation (must be enabled in Settings) |

Customize the first two at `chrome://extensions/shortcuts`.

---

## Development & tests

```bash
# Extension unit tests (Node built-in runner, no extra deps)
npm test
```

Load via **Install** above; after changing `background.js` / `content.js` / `options.js`, reload the extension. See [AGENTS.md](AGENTS.md) for maintainers and [CHANGELOG.md](CHANGELOG.md) for history.

---

## License

Released under the [MIT License](LICENSE).

<p align="center">
  <em>YuxTrans — Translation recedes to the margin; reading stays at the center.</em>
</p>
