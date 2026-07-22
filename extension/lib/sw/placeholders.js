/**
 * SW 内联标签占位符保护：提取阶段将 HTML 标签替换为 <t n="N"> 占位，
 * 翻译后按序号还原，避免模型翻译或破坏内联标签结构。
 *
 * 现状：content.js 的 collectTextNodes 按 TreeWalker 提取纯文本节点，
 * 标签结构已被隐式保护；本模块为「按块级元素合并整段翻译」的提取层
 * 重构（方案 P2-2，建议独立成项 + 浏览器手动回归）提供可复用工具。
 * 依赖：bootstrap
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  // 匹配 HTML 标签：<tag ...>、</tag>、<tag/>
  const TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?\/?>/g;
  // 占位符格式（方案 §3.7 指定 <t n="N">）
  const PLACEHOLDER_RE = /<t n="(\d+)">/g;

  /**
   * 将文本中的 HTML 标签替换为 <t n="N"> 占位符
   * @param {string} text
   * @returns {{text:string, placeholders:string[]}}
   */
  function extractPlaceholders(text) {
    if (!text || typeof text !== 'string') return { text: String(text || ''), placeholders: [] };
    const placeholders = [];
    const out = text.replace(TAG_RE, (tag) => {
      const n = placeholders.length + 1;
      placeholders.push(tag);
      return `<t n="${n}">`;
    });
    return { text: out, placeholders };
  }

  /**
   * 将 <t n="N"> 占位符还原为原标签
   * @param {string} text
   * @param {string[]} placeholders
   * @returns {string}
   */
  function restorePlaceholders(text, placeholders) {
    if (!text || !placeholders || placeholders.length === 0) return text || '';
    return text.replace(PLACEHOLDER_RE, (m, d) => {
      const idx = parseInt(d, 10) - 1;
      return placeholders[idx] != null ? placeholders[idx] : m;
    });
  }

  SW.extractPlaceholders = extractPlaceholders;
  SW.restorePlaceholders = restorePlaceholders;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractPlaceholders, restorePlaceholders };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
