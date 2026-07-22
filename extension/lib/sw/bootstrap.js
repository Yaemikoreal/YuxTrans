/**
 * Service Worker 模块命名空间引导
 * 在其他 lib/sw/* 文件之前加载
 */
(function (root) {
  const g = root || (typeof globalThis !== 'undefined' ? globalThis : this);
  g.YuxTransSW = g.YuxTransSW || {};
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
