/**
 * SW 缓存键纯函数：归一化 / 解析 / 生成
 * 依赖：bootstrap + constants
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  /**
   * 归一化缓存键中的源文
   * @param {string} text
   * @returns {string}
   */
  function normalizeCacheKeyText(text) {
    if (!text) return '';
    return text
      .normalize('NFC')
      .replace(/[\u200B-\u200F\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 将 model id 规整为可安全拼入冒号分隔键的 slug
   * （ollama 模型名常含冒号，如 qwen2:7b，需避免破坏键分段）
   * @param {string} [model]
   * @returns {string}
   */
  function modelSlug(model) {
    const slug = String(model || '')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return slug.slice(0, 64) || '_';
  }

  /**
   * 解析缓存键
   * @param {string} key
   * @returns {{version:string,promptVersion:string,model:string,sourceLang:string,targetLang:string,style:string,text:string}}
   */
  function parseCacheKey(key) {
    const parts = String(key || '').split(':');
    return {
      version: parts[0] || '',
      promptVersion: parts[1] || '',
      model: parts[2] || '',
      sourceLang: parts[3] || 'auto',
      targetLang: parts[4] || 'zh',
      style: parts[5] || 'normal',
      text: parts.slice(6).join(':')
    };
  }

  /**
   * 生成缓存键
   * 编入 promptVersion + model：prompt 规则或模型变更后，旧缓存键自然 miss，
   * 避免不同模型译文混用导致「切档案对比效果」失真。
   * @param {string} text
   * @param {string} sourceLang
   * @param {string} targetLang
   * @param {string} [style]
   * @param {string} [model] 模型 id（含冒号会被 slug 化）
   * @returns {string}
   */
  function generateCacheKey(text, sourceLang, targetLang, style, model) {
    const resolvedStyle = style || 'normal';
    const version = SW.CACHE_KEY_VERSION || 'v3';
    const promptVersion = SW.PROMPT_VERSION || 'p1';
    const m = modelSlug(model);
    return `${version}:${promptVersion}:${m}:${sourceLang}:${targetLang}:${resolvedStyle}:${normalizeCacheKeyText(text)}`;
  }

  /**
   * 提取缓存键中的文本部分
   * @param {string} key
   * @returns {string}
   */
  function getCacheKeyTextPart(key) {
    return parseCacheKey(key).text;
  }

  SW.normalizeCacheKeyText = normalizeCacheKeyText;
  SW.modelSlug = modelSlug;
  SW.parseCacheKey = parseCacheKey;
  SW.generateCacheKey = generateCacheKey;
  SW.getCacheKeyTextPart = getCacheKeyTextPart;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizeCacheKeyText,
      modelSlug,
      parseCacheKey,
      generateCacheKey,
      getCacheKeyTextPart
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
