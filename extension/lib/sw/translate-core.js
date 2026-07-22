/**
 * SW 翻译核心纯函数：Prompt 构建等
 * 依赖：bootstrap + constants
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  /**
   * 构建翻译 Prompt（无全局 config 依赖）
   * @param {string} text
   * @param {string} sourceLang
   * @param {string} targetLang
   * @param {string} [translateStyle]
   * @param {object|null} [context]
   * @returns {string}
   */
  function buildTranslationPrompt(text, sourceLang, targetLang, translateStyle, context) {
    const langNames = SW.LANG_NAMES || {};
    const stylePrompts = SW.STYLE_PROMPTS || {};
    const targetName = langNames[targetLang] || targetLang;
    const sourceName = sourceLang === 'auto' ? null : (langNames[sourceLang] || sourceLang);
    const styleHint = stylePrompts[translateStyle || 'normal'] || '';

    let prompt = 'You are a professional translator. Translate the following text';
    if (sourceName) {
      prompt += ` from ${sourceName}`;
    }
    prompt += ` to ${targetName}.`;

    if (styleHint) {
      prompt += ` ${styleHint}`;
    }

    prompt += `
STRICT OUTPUT RULES:
- Provide ONLY the translation of the text below. No explanations, notes, markdown, or code fences.
- Translate naturally, not word-by-word.
- Preserve proper nouns, brand names, URLs, and code unchanged.
- Keep numbers, punctuation marks, and formatting intact.
- If the text is already in the target language or contains only proper nouns/code/numbers, return it unchanged.`;

    // 页面上下文可选注入（保持与历史行为兼容：批量路径可不传）
    if (context && (context.title || context.url)) {
      prompt += `\n\nPage context (for disambiguation only, do not translate):`;
      if (context.title) prompt += `\nTitle: ${String(context.title).slice(0, 200)}`;
      if (context.url) prompt += `\nURL: ${String(context.url).slice(0, 200)}`;
    }

    prompt += `\n\nText to translate:\n${text}`;
    return prompt;
  }

  SW.buildTranslationPrompt = buildTranslationPrompt;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildTranslationPrompt };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
