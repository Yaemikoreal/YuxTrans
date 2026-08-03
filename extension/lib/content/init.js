/**
 * 引导实例化（content 拆分模块）
 * 依赖：content.js 先注入（YuxTransContent 类）
 */
(function () {
  // 仅浏览器环境实例化；Node 测试环境 require 时不实例化（沿用拆分前 content.js 尾部守卫语义）
  if (typeof module !== 'undefined') return;
  const Ctor = (typeof YuxTransContent !== 'undefined' ? YuxTransContent : null)
    || (typeof globalThis !== 'undefined' ? globalThis.YuxTransContent : null);
  if (!Ctor) return;
  new Ctor();
})();
