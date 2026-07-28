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

  // 拉丁语系高频停用词：用于在拉丁脚本内细分 en/fr/de/es/pt/it。
  // 选取原则：高频、含变音特征词（法 à/être、德 ß/über、西 ñ/qué、葡 não、意 è/perché）。
  // 跨语言重叠词（如 de/que/la）允许多语言同时计分，靠「显著领先」阈值抑制误判。
  const LATIN_STOPWORDS = {
    en: ['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on',
      'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we',
      'her', 'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
      'so', 'if', 'about', 'who', 'which', 'when', 'them', 'then', 'than', 'its', 'over'],
    fr: ['le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'est', 'dans', 'à', 'au', 'aux',
      'pour', 'sur', 'avec', 'pas', 'plus', 'qui', 'que', 'ce', 'cette', 'ces', 'il', 'elle',
      'ils', 'nous', 'vous', 'on', 'se', 'son', 'sa', 'par', 'ne', 'mais', 'ou', 'où', 'très',
      'sont', 'était', 'été', 'comme', 'bien', 'sans', 'être', 'après', 'avant', 'donc', 'car'],
    de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'und', 'ist', 'nicht',
      'ich', 'mit', 'für', 'auf', 'zu', 'von', 'sich', 'auch', 'als', 'an', 'nach', 'wie', 'im',
      'über', 'um', 'werden', 'wurde', 'sein', 'haben', 'sie', 'er', 'wir', 'es', 'oder', 'aber',
      'noch', 'nur', 'kann', 'sehr', 'bei', 'aus', 'am', 'vor', 'durch', 'gegen', 'ohne', 'zwischen'],
    es: ['el', 'la', 'los', 'las', 'de', 'del', 'que', 'en', 'y', 'un', 'una', 'es', 'por', 'con',
      'no', 'se', 'su', 'para', 'como', 'más', 'pero', 'sus', 'ya', 'este', 'esta', 'muy', 'sin',
      'sobre', 'también', 'hasta', 'hay', 'donde', 'desde', 'qué', 'está', 'años', 'porque',
      'cuando', 'todo', 'mi', 'ha', 'al', 'lo', 'ni', 'sí', 'él', 'entre', 'después'],
    pt: ['o', 'a', 'os', 'as', 'de', 'do', 'da', 'que', 'em', 'um', 'uma', 'para', 'com', 'não',
      'por', 'se', 'na', 'no', 'dos', 'das', 'ao', 'à', 'mas', 'foi', 'são', 'como', 'mais',
      'já', 'seu', 'sua', 'ou', 'quando', 'muito', 'eu', 'ele', 'ela', 'também', 'sem', 'até',
      'isso', 'esse', 'esta', 'este', 'depois', 'onde', 'está', 'porque', 'ter'],
    it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'un', 'una', 'che', 'e', 'per', 'in', 'con',
      'non', 'si', 'da', 'del', 'della', 'dei', 'delle', 'al', 'alla', 'ai', 'su', 'come', 'ma',
      'più', 'anche', 'questo', 'questa', 'sono', 'era', 'molto', 'mi', 'ti', 'ci', 'ne', 'ho',
      'ha', 'è', 'nel', 'nella', 'sul', 'io', 'noi', 'dopo', 'prima', 'perché', 'dove']
  };

  // 模块加载时构建 Set，避免每次调用重建
  const LATIN_STOPWORD_SETS = {};
  for (const lang in LATIN_STOPWORDS) {
    LATIN_STOPWORD_SETS[lang] = new Set(LATIN_STOPWORDS[lang]);
  }

  const LATIN_WORD_RE = /[\p{L}\p{M}]+/gu;
  // 拉丁细分的最低证据门槛：低于该长度/词数证据不足，直接兜底 en
  const LATIN_DETECT_MIN_CHARS = 10;
  const LATIN_DETECT_MIN_WORDS = 3;
  const LATIN_DETECT_MIN_HITS = 2;

  /**
   * 拉丁脚本语言细分：基于停用词命中打分。
   * 仅当某语言得分 >= LATIN_DETECT_MIN_HITS、超过英语得分、且严格领先其他语言时才改判，
   * 否则返回 'en' 兜底（短文/不确定宁可判 en，避免引入新误判）。
   * @param {string} sample
   * @returns {string}
   */
  function detectLatinLanguage(sample) {
    if (sample.length < LATIN_DETECT_MIN_CHARS) return 'en';
    const words = sample.toLowerCase().match(LATIN_WORD_RE);
    if (!words || words.length < LATIN_DETECT_MIN_WORDS) return 'en';

    const scores = { en: 0, fr: 0, de: 0, es: 0, pt: 0, it: 0 };
    for (const word of words) {
      for (const lang in scores) {
        if (LATIN_STOPWORD_SETS[lang].has(word)) scores[lang]++;
      }
    }

    let bestLang = 'en';
    let best = 0;
    let second = 0;
    for (const lang of ['fr', 'de', 'es', 'pt', 'it']) {
      const s = scores[lang];
      if (s > best) {
        second = best;
        best = s;
        bestLang = lang;
      } else if (s > second) {
        second = s;
      }
    }

    if (best >= LATIN_DETECT_MIN_HITS && best > scores.en && best > second) return bestLang;
    return 'en';
  }

  /**
   * 基于 Unicode 脚本检测语言；拉丁脚本再用停用词打分细分 en/fr/de/es/pt/it（低置信兜底 en）
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
    if (scores.en > 0) {
      if (scores.vi > scores.en * 0.15) return 'vi';
      // 拉丁脚本内细分：法/德/西/葡/意高置信区分，否则保持 'en' 兜底
      return detectLatinLanguage(sample);
    }
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
   * 目标语言归一化：'zh-CN'/'zh-TW' -> 'zh'，便于与 detectLanguage 结果比较
   * @param {string} targetLang
   * @returns {string}
   */
  function normalizeTargetLang(targetLang) {
    const t = String(targetLang || '');
    if (t.startsWith('zh')) return 'zh';
    return t;
  }

  /**
   * 文本是否已是目标语言（按 Unicode 脚本检测）
   * @param {string} text
   * @param {string} targetLang
   * @returns {boolean}
   */
  function isSameAsTargetLanguage(text, targetLang) {
    const detected = detectLanguage(text);
    if (!detected || detected === 'unknown') return false;
    return detected === normalizeTargetLang(targetLang);
  }

  SW.SCRIPT_RANGES = SCRIPT_RANGES;
  SW.detectLanguage = detectLanguage;
  SW.resolveSourceLanguage = resolveSourceLanguage;
  SW.normalizeTargetLang = normalizeTargetLang;
  SW.isSameAsTargetLanguage = isSameAsTargetLanguage;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SCRIPT_RANGES,
      detectLanguage,
      resolveSourceLanguage,
      normalizeTargetLang,
      isSameAsTargetLanguage
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
