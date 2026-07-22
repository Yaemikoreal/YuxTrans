/**
 * SW 语言检测与目标语翻转纯函数
 * 依赖：bootstrap
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  const SCRIPT_RANGES = {
    han: /[\u4e00-\u9fff\u3400-\u4dbf]/,
    hiragana: /[\u3040-\u309f]/,
    katakana: /[\u30a0-\u30ff]/,
    hangul: /[\uac00-\ud7af\u1100-\u11ff]/,
    cyrillic: /[\u0400-\u04ff]/,
    arabic: /[\u0600-\u06ff]/,
    thai: /[\u0e00-\u0e7f]/,
    latin: /[\u0041-\u007a\u00c0-\u017f\u0100-\u024f]/,
    vietnamese: /[\u00c0-\u00c3\u00c8-\u00ca\u00cc-\u00cf\u00d2-\u00d5\u00d9-\u00dd\u1ea0-\u1ef9]/
  };

  /**
   * 基于 Unicode 脚本检测语言
   * @param {string} text
   * @returns {string}
   */
  function detectLanguage(text) {
    if (!text || text.trim().length === 0) return 'unknown';

    const sample = text.slice(0, 500);
    const scores = {
      zh: 0, ja: 0, ko: 0, en: 0, ru: 0, ar: 0, th: 0, vi: 0, other: 0
    };

    for (const char of sample) {
      if (SCRIPT_RANGES.han.test(char)) scores.zh++;
      else if (SCRIPT_RANGES.hiragana.test(char) || SCRIPT_RANGES.katakana.test(char)) scores.ja++;
      else if (SCRIPT_RANGES.hangul.test(char)) scores.ko++;
      else if (SCRIPT_RANGES.cyrillic.test(char)) scores.ru++;
      else if (SCRIPT_RANGES.arabic.test(char)) scores.ar++;
      else if (SCRIPT_RANGES.thai.test(char)) scores.th++;
      else if (SCRIPT_RANGES.latin.test(char)) {
        scores.en++;
        if (SCRIPT_RANGES.vietnamese.test(char)) scores.vi++;
      }
    }

    if (scores.ja > 0 && (scores.zh === 0 || scores.ja >= scores.zh * 0.3)) return 'ja';
    if (scores.zh > 0) return 'zh';
    if (scores.ko > 0) return 'ko';
    if (scores.ru > 0) return 'ru';
    if (scores.ar > 0) return 'ar';
    if (scores.th > 0) return 'th';
    if (scores.en > 0) return scores.vi > scores.en * 0.15 ? 'vi' : 'en';
    return 'unknown';
  }

  /**
   * auto 源语言解析
   * @param {string} text
   * @param {string} sourceLang
   * @returns {string}
   */
  function resolveSourceLanguage(text, sourceLang) {
    if (sourceLang !== 'auto') return sourceLang;
    const detected = detectLanguage(text);
    return detected === 'unknown' ? 'auto' : detected;
  }

  /**
   * 同语种时翻转到对照语言（纯逻辑，不含配置开关）
   * @param {string} detected
   * @param {string} targetLang
   * @returns {string}
   */
  function flipTargetIfSameLanguage(detected, targetLang) {
    if (!detected || detected === 'unknown') return targetLang;
    const normalizedTarget = String(targetLang || '').startsWith('zh') ? 'zh' : targetLang;
    if (detected !== normalizedTarget) return targetLang;
    const oppositeMap = {
      zh: 'en',
      ja: 'zh',
      ko: 'zh',
      en: 'zh',
      ru: 'en',
      ar: 'en',
      th: 'en',
      vi: 'en'
    };
    return oppositeMap[detected] || 'en';
  }

  SW.SCRIPT_RANGES = SCRIPT_RANGES;
  SW.detectLanguage = detectLanguage;
  SW.resolveSourceLanguage = resolveSourceLanguage;
  SW.flipTargetIfSameLanguage = flipTargetIfSameLanguage;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SCRIPT_RANGES,
      detectLanguage,
      resolveSourceLanguage,
      flipTargetIfSameLanguage
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
