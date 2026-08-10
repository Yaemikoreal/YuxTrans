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

Current stable release: **v0.7.0**.

## Design intent (UI v2.1)

In one sentence: **the skin of study paper, the bones of order.**

- **The skin is paper and ink.** Ink as the bone, warm paper as the ground, dusk as a faint glow. No pure black or white, no high-saturation tech colors, no bouncing animations; the loading state is an unfinished ellipsis, not a spinning ring.
- **The bones are order.** A component skeleton built on system-level visual order—grouped cards as information hierarchy, a "label left / value right" scanning path, 0.5px separators, and exactly one solid primary action per screen. The popup and settings page gain a clear anchor instead of a uniform gray.
- **A three-tier type ramp, calibrated for the eyes.** Primary text in ink (13:1), translations in `#4A453F` (8.6:1, AAA), labels in `#6B655C` (5.1:1, AA); the annotation gray is retired to placeholders and decoration. Long reads stay comfortable; hierarchy survives.
- **Lives in the page without touching it.** Every floating UI element (selection popup, action tag, page control bar) runs inside a Shadow DOM, strictly isolated from the host page's styles.

## Three ways to read bilingually

Deep reading and quick scanning are both legitimate needs. YuxTrans does not choose between them—it offers three modes:

- **Paragraph mirror** (new): the translation follows its source paragraph as a block, leaving the original layout untouched. Read the original paragraph through, then the translation—your eyes never jump. Hovering a translated paragraph washes it in a dusk glow.
- **Inline footnote**: the translation follows each sentence, marked with a dusk vertical rule, for line-by-line comparison.
- **Translation only**: the whole page is replaced with the translation, for pure efficiency, with one-click restore.

Choose in Settings → Interaction & Display → Bilingual style, and switch bilingual / translation-only anytime from the on-page control bar.

---

## Interface

Screenshots follow a real usage path (assets in `logo/`).

### 1. Settings · Profiles

A system settings skeleton: five sidebar modules (Profiles, Preferences, Interaction & Display, Data & Storage, Diagnostics), each with a zone-colored line icon; settings live inside grouped cards, labels on the left, controls on the right. Credentials never leave the local browser.

![Settings — Profiles](logo/使用样例-设置.png)

### 2. Settings · Preferences

Active profile at a glance, offline mode, language direction, and four styles (Daily / Academic / Technical / Literary); each style's prompt can be edited and is saved together with the preferences.

![Settings — Preferences](logo/使用样例-设置-2.png)

### 3. Popup control panel

The toolbar icon opens a small booklet: a single solid primary action "Translate page", grouped cards for connection status, profile switching, a mono/bilingual segmented control, a streaming switch, and a collapsible usage & cache board. Light paper scheme.

![Popup control panel](logo/使用样例-弹窗板.png)

### 4. Selection translation

Select text on any page and a light floating card appears: italic source above, translation below, with a bottom toolbar of line-icon actions (pin / insert / copy). Pinned windows stay for side-by-side comparison without breaking the reading rhythm.

![Selection translation popup](logo/使用样例-划词翻译.png)

### 5. Hover paragraph translation (Alt)

Hold the modifier key (**Alt** by default, configurable to Ctrl) and hover over a paragraph; the translation appears as a margin note after the paragraph, closable individually, no selection needed.

![Alt hover paragraph translation](logo/使用样例-Alt快捷键翻译.png)

### 6. Full-page translation: original → bilingual → translation-only

**Before translation**, the page is plain English:

![Untranslated original](logo/使用样例-未翻译的原文.png)

**Bilingual mode** (inline footnote): each sentence is followed by its translation marked with a dusk rule, preserving the original layout and rhythm; the bottom control bar tracks progress and cache / API hits:

![Bilingual result](logo/使用样例-双语结果.png)

**Translation-only mode**: the whole page is replaced with the translation, restorable in one click:

![Translation-only result](logo/使用样例-仅译文结果.png)

---

## Installation

1. Download the latest `YuxTrans-extension-v*.zip` from [Releases](https://github.com/Yaemikoreal/YuxTrans/releases) and unzip it, or clone this repository.
2. Open Chrome / Edge and visit `chrome://extensions/` or `edge://extensions/`.
3. Enable "Developer mode" in the top-right corner.
4. Click "Load unpacked" and select the **`extension/`** directory (it must contain `manifest.json`).
5. The toolbar icon appears and the extension is ready.

---

## Configuration

Click the extension icon → Settings:

| Module | What it does |
| :--- | :--- |
| **Profiles** | Local Ollama / cloud providers / custom OpenAI-compatible endpoints; save and activate profiles. |
| **Preferences** | Language direction, translation style, style prompts, offline mode. |
| **Interaction & Display** | Selection trigger, streaming, bilingual style (inline footnote / paragraph mirror), hover & dictionary, original-text styling. |
| **Data & Storage** | Glossary, cache quota, import/export, site rules. |
| **Diagnostics** | Usage and request logs (read-only). |

| Type | How |
| :--- | :--- |
| Local Ollama | Set provider to `local`, enter a model name (e.g. `qwen3.5:0.8b`), make sure Ollama is running. |
| Cloud provider | Choose `qwen` / `openai` / `deepseek` / `anthropic` / `groq` / `moonshot` / `siliconflow` / `google` (key-free), then enter API key and model. |
| Custom provider | Choose `custom`, enter endpoint, API key, API format, and model. |

Each module has its own Save button. API keys and configuration are stored only in the local browser.

---

## Usage

### Selection translation

- Default "modifier + select": hold **Ctrl** (configurable to Alt/Shift), select text, release to translate. For translate-on-select, switch to "Popup after selection" in Interaction & Display.
- Shortcut `Alt + T` (same on macOS).
- Right-click selected text → "Translate selection".

### Hover paragraph translation

- Enable "Hover paragraph translation" in Interaction & Display.
- Hold **Alt** (or your configured modifier) and hover over a paragraph for about 300 ms; a translation note appears after the paragraph.

### Word dictionary

- With "Word dictionary mode" enabled, selecting or double-clicking a word pops up a dictionary card (phonetics, senses, examples).

### Full-page translation

- The popup's primary button "Translate page".
- Shortcut `Alt + P` (same on macOS).
- Right-click on an empty area of the page → "Translate page".

Viewport-first, streaming display with cancel support; bilingual style can be "inline footnote" or "paragraph mirror" (Settings → Interaction & Display), and the control bar switches bilingual / translation-only or restores the original.

### Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Alt + T` | Translate selection |
| `Alt + P` | Translate page |
| `Ctrl` (configurable) + select | Selection translation (default trigger) |
| `Alt` (configurable) + hover | Paragraph translation (enable in Settings) |

> **Tip**: If a shortcut does not work (captured by the browser or another extension), customize it at `chrome://extensions/shortcuts`.

---

## Development & testing

```bash
# Unit tests (Node built-in test runner, no extra dependencies)
npm test

# ESLint
npm run lint

# Playwright smoke test: real Chromium loads the extension, simulates selection, asserts the popup
npm run test:e2e
```

See "Installation" above for loading; after changing `background.js` / `content.js` / `options.js`, reload the extension from the extensions page. Maintenance notes live in [AGENTS.md](AGENTS.md), the changelog in [CHANGELOG.md](CHANGELOG.md), and the visual spec in [docs/UI_DESIGN_SYSTEM.md](docs/UI_DESIGN_SYSTEM.md).

---

## License

Released under the [MIT License](LICENSE).

<p align="center">
  <em>YuxTrans — translation recedes to the margin; reading stays at the center.</em>
</p>
