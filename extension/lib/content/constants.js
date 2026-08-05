/**
 * content 侧运行时调优常量（content 拆分模块）
 * 依赖：无（manifest 中须先于 content.js 及 lib/content/* 使用方注入）
 */
(function (root) {
  /**
   * 集中收编的魔法数字（评审 D1c）：超时 / 看门狗 / 节流防抖 / 预加载 / 分批。
   * 值与收编前完全一致；config 默认对象里的用户可配置项（concurrency/batchSize/minTextLength 等）
   * 属配置 schema，不在此列；一次性 UI 提示时长（复制反馈等）亦不收编。
   */
  const Consts = {
    // Q1：collectTextNodes 布局读取的分批大小——每读 N 个节点让出一次主线程
    COLLECT_LAYOUT_BATCH_SIZE: 200,
    // 整页流式段落超时：略宽于 SW 侧 60s，确保失败由 SW 回报（可走非流式故障转移）
    STREAM_TIMEOUT_MS: 65000,
    // 整页批量请求 content 侧兜底超时：SW 长时间无响应时失败收场，避免 Promise 永久悬挂
    BATCH_REQUEST_TIMEOUT_MS: 130000,
    // #11：70s 看门狗——SW 不回包时复位在途标志，避免永久卡死（对齐流式 65s 超时）
    WATCHDOG_TIMEOUT_MS: 70000,
    // 划选/双击后读取选区的延迟：等浏览器完成选区更新再取 selection
    SELECTION_READ_DELAY_MS: 10,
    // F1：悬停段落翻译触发延迟（防误触）
    HOVER_TRANSLATE_DELAY_MS: 300,
    // F1：mousemove 节流——120ms 内只处理一次
    HOVER_THROTTLE_MS: 120,
    // Q2：动态增量翻译的新增节点 MutationObserver 防抖窗口
    ADDED_NODES_DEBOUNCE_MS: 500,
    // belowFold 视口感知的预加载边距：节点入视口前 200px 即提交翻译
    VIEWPORT_ROOT_MARGIN: '200px',
    // belowFold 超时回退：6s 后把视口外剩余项一次性提交，避免用户不滚动导致 await 卡死
    VIEWPORT_FALLBACK_MS: 6000,
    // belowFold 入视口段落的批次提交防抖（合并连续入视口事件）
    VIEWPORT_SUBMIT_DEBOUNCE_MS: 100,
    // W4：超长段落句级二次拆分阈值——段落文本超过此长度时拆为句级条目发送（句级缓存粒度）
    SENTENCE_SPLIT_THRESHOLD_CHARS: 4000
  };

  root.YuxContentConsts = Consts;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Consts;
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
