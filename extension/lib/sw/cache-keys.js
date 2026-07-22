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
   * 解析缓存键
   * @param {string} key
   * @returns {{version:string,sourceLang:string,targetLang:string,style:string,text:string}}
   */
  function parseCacheKey(key) {
    const parts = String(key || '').split(':');
    return {
      version: parts[0] || '',
      sourceLang: parts[1] || 'auto',
      targetLang: parts[2] || 'zh',
      style: parts[3] || 'normal',
      text: parts.slice(4).join(':')
    };
  }

  /**
   * 生成缓存键
   * @param {string} text
   * @param {string} sourceLang
   * @param {string} targetLang
   * @param {string} [style]
   * @returns {string}
   */
  function generateCacheKey(text, sourceLang, targetLang, style) {
    const resolvedStyle = style || 'normal';
    const version = SW.CACHE_KEY_VERSION || 'v2';
    return `${version}:${sourceLang}:${targetLang}:${resolvedStyle}:${normalizeCacheKeyText(text)}`;
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
  SW.parseCacheKey = parseCacheKey;
  SW.generateCacheKey = generateCacheKey;
  SW.getCacheKeyTextPart = getCacheKeyTextPart;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizeCacheKeyText,
      parseCacheKey,
      generateCacheKey,
      getCacheKeyTextPart
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
