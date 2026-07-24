/**
 * SW 翻译核心纯函数：Prompt 构建等
 * 依赖：bootstrap + constants
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  /**
   * 解析某风格生效的风格提示词（用户覆盖优先，否则内置默认）
   * @param {string} [style]
   * @param {object|null|undefined} [customMap] - ActiveConfig.stylePrompts
   * @returns {string}
   */
  function resolveStylePrompt(style, customMap) {
    const key = style || 'normal';
    const defaults = SW.STYLE_PROMPTS || {};
    if (customMap && Object.prototype.hasOwnProperty.call(customMap, key)
        && typeof customMap[key] === 'string') {
      return customMap[key];
    }
    return defaults[key] || '';
  }

  /**
   * 短哈希（缓存 style 段用，避免自定义提示词撞默认缓存）
   * @param {string} s
   * @returns {string}
   */
  function _stylePromptHash(s) {
    let h = 2166136261;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36).slice(0, 8);
  }

  /**
   * 缓存键中的 style 段：默认提示用风格 id；自定义提示附加短哈希
   * dict 等非风格键原样返回
   * @param {string} [style]
   * @param {object|null|undefined} [customMap]
   * @returns {string}
   */
  function styleSegmentForCache(style, customMap) {
    const key = style || 'normal';
    if (key === 'dict') return 'dict';
    const effective = resolveStylePrompt(key, customMap);
    const defaults = SW.STYLE_PROMPTS || {};
    const def = defaults[key] || '';
    if (effective === def) return key;
    // 点号避免与键内冒号分段冲突
    return `${key}.${_stylePromptHash(effective)}`;
  }

  /**
   * 清洗用户风格提示词映射：仅保留已知风格、截断长度；与默认相同的键不写出（表示用默认）
   * @param {object|null|undefined} input
   * @returns {object}
   */
  function sanitizeStylePrompts(input) {
    const ids = SW.STYLE_IDS || ['normal', 'academic', 'technical', 'literary'];
    const defaults = SW.STYLE_PROMPTS || {};
    const out = {};
    if (!input || typeof input !== 'object') return out;
    const maxLen = 2000;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (typeof input[id] !== 'string') continue;
      const v = input[id].slice(0, maxLen);
      const def = defaults[id] || '';
      if (v !== def) out[id] = v;
    }
    return out;
  }

  /**
   * 构建翻译 Prompt（无全局 config 依赖）
   * @param {string} text
   * @param {string} sourceLang
   * @param {string} targetLang
   * @param {string} [translateStyle]
   * @param {object|null} [context]
   * @param {object|null} [customStylePrompts] - ActiveConfig.stylePrompts
   * @returns {string}
   */
  function buildTranslationPrompt(text, sourceLang, targetLang, translateStyle, context, customStylePrompts) {
    const langNames = SW.LANG_NAMES || {};
    const targetName = langNames[targetLang] || targetLang;
    const sourceName = sourceLang === 'auto' ? null : (langNames[sourceLang] || sourceLang);
    const styleHint = resolveStylePrompt(translateStyle || 'normal', customStylePrompts);

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

  SW.resolveStylePrompt = resolveStylePrompt;
  SW.styleSegmentForCache = styleSegmentForCache;
  SW.sanitizeStylePrompts = sanitizeStylePrompts;
  SW.buildTranslationPrompt = buildTranslationPrompt;

  /**
   * F2：构建单词词典查询 Prompt（严格 JSON 输出，与翻译风格无关）
   * @param {string} word - 待查单词
   * @param {string} sourceLang
   * @param {string} targetLang
   * @returns {string}
   */
  function buildDictionaryPrompt(word, sourceLang, targetLang) {
    const langNames = SW.LANG_NAMES || {};
    const targetName = langNames[targetLang] || targetLang;
    const sourceName = sourceLang === 'auto' ? null : (langNames[sourceLang] || sourceLang);

    let prompt = 'You are a bilingual dictionary. Look up the word below';
    if (sourceName) {
      prompt += ` (in ${sourceName})`;
    }
    prompt += ` and provide its meanings in ${targetName}.`;

    prompt += `

STRICT OUTPUT RULES:
- Output ONLY a single JSON object. No explanations, no markdown, no code fences.
- Schema:
  {"word":"...","phonetic":"...","senses":[{"pos":"part of speech","meaning":"...","examples":[{"source":"...","target":"..."}]}]}
- Provide at most 4 senses; each sense with 1-2 example sentence pairs.
- "phonetic" is the IPA or romanization; use empty string if unknown.
- "examples.source" must be in the source language; "examples.target" is its translation in ${targetName}.
- If the input is not a single word, still return valid JSON with "senses": [].

Word to look up:
${word}`;
    return prompt;
  }

  SW.buildDictionaryPrompt = buildDictionaryPrompt;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildTranslationPrompt,
      buildDictionaryPrompt,
      resolveStylePrompt,
      styleSegmentForCache,
      sanitizeStylePrompts
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
