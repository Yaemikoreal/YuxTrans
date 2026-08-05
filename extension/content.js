/**
 * Content Script
 * 处理页面内翻译、划词翻译、整页翻译
 * 支持并行翻译、样式保持、可视区域优先
 */

/* global YuxTransHelpers */

class YuxTransContent {
  constructor() {
    this.popup = null;
    this.isTranslating = false;
    // #11：词典查询独立在途标志（与划词 isTranslating 拆分，互不阻塞）
    this.isDictLookingUp = false;
    // #11：70s 看门狗——SW 不回包时复位在途标志，避免永久卡死（对齐流式 65s 超时）
    this._translateWatchdog = null;
    this._dictWatchdog = null;
    // #4：requestId -> 浮窗元素，翻译响应与流式 chunk 按此路由回对应浮窗，防止串台
    this._popupRequests = new Map();
    this._popupReqSeq = 0;
    // #5：对照模式自动 pin 的主浮窗（替换语义：新对照前移除旧的，只留一个）
    this._compareMainPopup = null;
    // #13：动态增量翻译独立在途标志（不占用整页主流程 isTranslating）
    this._dynamicTranslating = false;
    this.helpers = (typeof YuxTransHelpers !== 'undefined' && YuxTransHelpers) || {};
    this.pageTranslationState = {
      isTranslated: false,
      isTranslating: false,
      cancelRequested: false, // 用户取消整页/动态翻译：阻止 worker 发起新批次
      originalTexts: new Map(), // paragraph -> { text, nodeTexts, translated, ... }（W5：键为段落对象）
      translatedNodes: [],
      streamingNodes: new Map(), // requestId -> { nodeInfo, tempSpan }
      failedItems: [], // 失败节点，供重试
      cacheHits: 0,
      apiCount: 0
    };
    this._dynamicObserver = null;
    this._addedDebounceTimer = null;
    this._isProcessingAdded = false;
    // Q2：防抖窗口内累积的新增子树根，_processAddedNodes 只扫这些子树，不再全页重扫 body
    this._pendingAddedRoots = new Set();
    this._pageSessionId = null; // 当前整页/动态翻译会话 id，用于 SW 侧取消
    this._pageSessionCounter = 0;
    this._streamReqSeq = 0; // 整页流式段落 requestId 自增序号（streamChunk 按此路由到对应 tempSpan）
    this._viewportObserver = null; // belowFold 视口感知：入视口才提交翻译
    this._viewportCleanup = null; // belowFold 取消回调（放弃未提交项）
    // v2.1 段落对照（bilingualStyle=block）：块容器元素 -> { el: div.yuxtrans-block-tr, nodes: Set<paragraph> }
    this._blockTrMap = new Map();
    // F1 悬停段落翻译状态
    this._hoverTarget = null; // 当前悬停描边的段落元素
    this._hoverTimer = null; // 300ms 延迟翻译定时器
    this._hoverThrottleTimer = null; // mousemove 节流定时器
    this._lastInputElement = null; // F5：触发翻译的输入框元素（供"插入译文"使用）
    this.pinnedPopups = []; // F4：已 pin 的浮窗列表（不被新划词覆盖，用于结果对照）
    // Stage F：悬停译文块的 shadow host 集合（restoreOriginalTexts 据此清理，不再 document 直查）
    this._hoverBlocks = new Set();
    this.pageControl = null;
    this.sideTab = null; // #54：整页控制条收起后的右缘挂耳
    this.config = {
      concurrency: 50, // 并发请求数（云端默认 50，本地自动降为 1）
      batchSize: 20,  // 批量大小（减少 API 调用次数）
      minTextLength: 2, // 最小翻译文本长度
      preserveStyles: true, // 保持样式
      sourceLang: 'auto',
      targetLang: 'zh',
      siteRule: 'all',
      siteList: [],
      triggerMode: 'modifier',
      selectionModifier: 'ctrl', // 'ctrl' | 'alt' | 'shift'
      enableStreaming: true,
      bilingualMode: true,
      bilingualStyle: 'inline', // v2.1：双语呈现方式 inline(行内注脚) | block(段落对照)
      offlineMode: false,
      siteModePrefs: {},
      // F1 悬停段落翻译：按修饰键 + 鼠标悬停段落触发
      hoverTranslate: true,
      hoverModifier: 'alt', // 'alt' | 'ctrl'
      // F2 单词词典模式：划到单词或双击单词出词典卡片
      dictMode: true,
      dictDblclick: true,
      // F3 译文显示样式：原文呈现方式 normal(默认) | fade(弱化) | blur(模糊)
      originalStyle: 'normal',
      // F6 正文区域识别：整页翻译只翻正文区，跳过导航/侧栏/页脚
      smartContentDetection: false,
      // F5 输入框翻译：input/textarea 内选中文本允许翻译，浮窗提供"插入译文"按钮
      inputTranslate: false,
      // F4b：双档案对照--对照档案 ID（为空则不对照）
      compareProfileId: ''
    };
    this.init();
  }

  init() {
    this.createStyles();
    this.bindEvents();
    this.loadConfig();
    this._detectHostDarkTheme();
  }

  /**
   * 宿主页暗色探测：系统为亮色、但宿主页面强制暗色时，注入的暖纸浮窗与灰墨译文会"隐身"。
   * 探测 body/html 背景亮度，暗则给 documentElement 打 data-yxt-host-dark，
   * 由 content.css 覆盖令牌为黄昏暗色（与系统暗色 prefers-color-scheme 互补）。
   */
  _detectHostDarkTheme() {
    try {
      const lum = this._bgLuminance(document.body) ?? this._bgLuminance(document.documentElement);
      if (lum != null && lum < 0.5) {
        document.documentElement.dataset.yxtHostDark = '1';
      }
    } catch (e) { /* getComputedStyle 不可用时静默忽略 */ }
  }

  /** 取元素背景色的相对亮度（0-1）；透明背景返回 null */
  _bgLuminance(el) {
    if (!el || typeof getComputedStyle !== 'function') return null;
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg && bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((x) => parseFloat(x));
    if (parts.length < 3) return null;
    const alpha = parts.length > 3 ? parts[3] : 1;
    if (alpha === 0) return null; // 透明，无法判定
    const [r, g, b] = parts;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  async loadConfig() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getConfig' });
      if (response) {
        // 优先使用当前激活的 ProviderProfile，兼容旧版顶层字段
        const activeProfile = (response.profiles || []).find(
          (p) => p.id === response.activeProfileId
        );
        const providerSource = activeProfile || response;
        this.config.provider = providerSource.provider || 'qwen';
        this.config.model = providerSource.model || providerSource.localModel || '';
        this.config.sourceLang = response.sourceLang || 'auto';
        this.config.targetLang = response.targetLang || 'zh';
        this.config.siteRule = response.siteRule || 'all';
        this.config.siteList = response.siteList || [];
        this.config.autoCopy = response.autoCopy || false;
        this.config.triggerMode = response.triggerMode || 'modifier';
        this.config.selectionModifier = ['ctrl', 'alt', 'shift'].includes(response.selectionModifier) ? response.selectionModifier : 'ctrl';
        this.config.enableStreaming = response.enableStreaming !== false;
        this.config.offlineMode = !!response.offlineMode;
        this.config.siteModePrefs = response.siteModePrefs || {};
        // F1-F6 新配置字段同步（options 保存后经 storage.onChanged -> loadConfig 实时生效）
        this.config.hoverTranslate = response.hoverTranslate !== false;
        this.config.hoverModifier = response.hoverModifier === 'ctrl' ? 'ctrl' : 'alt';
        this.config.dictMode = response.dictMode !== false;
        this.config.dictDblclick = response.dictDblclick !== false;
        this.config.originalStyle = ['normal', 'fade', 'blur'].includes(response.originalStyle) ? response.originalStyle : 'normal';
        this.config.inputTranslate = !!response.inputTranslate;
        this.config.smartContentDetection = !!response.smartContentDetection;
        this.config.compareProfileId = response.compareProfileId || '';
        // 站点级双语偏好覆盖全局
        const host = (location.hostname || '').toLowerCase();
        if (this.helpers.resolveSiteBilingualMode) {
          this.config.bilingualMode = this.helpers.resolveSiteBilingualMode(
            host,
            this.config.siteModePrefs,
            response.bilingualMode !== false
          );
        } else if (response.bilingualMode !== undefined) {
          this.config.bilingualMode = response.bilingualMode;
        }
        // v2.1：双语呈现方式（双语模式下的子选项，默认行内注脚）
        this.config.bilingualStyle = response.bilingualStyle === 'block' ? 'block' : 'inline';
        if (response.batchConfig) {
          this.config.maxBatchChars = response.batchConfig.maxBatchChars;
          this.config.batchSize = response.batchConfig.batchSize;
        }
      }
      // 悬停翻译首次引导（仅在未展示过且 hoverTranslate 开启时显示）
      this._maybeShowHoverGuide();
    } catch (e) {
      // 使用默认配置
    }
  }

  /**
   * 根据站点规则判断当前页面是否允许使用扩展
   */
  isSiteAllowed() {
    const { siteRule, siteList } = this.config;
    if (siteRule === 'all' || !siteList || siteList.length === 0) {
      return true;
    }

    const hostname = location.hostname.toLowerCase();
    const rules = siteList.map(r => r.toLowerCase().trim()).filter(Boolean);

    const match = rules.some(rule => {
      // 支持精确域名、通配子域名（*.example.com）或包含匹配
      if (rule.startsWith('*.')) {
        const suffix = rule.slice(2);
        return hostname === suffix || hostname.endsWith('.' + suffix);
      }
      return hostname === rule || hostname.includes(rule);
    });

    if (siteRule === 'whitelist') return match;
    if (siteRule === 'blacklist') return !match;
    return true;
  }

  createStyles() {
    if (document.getElementById('yuxtrans-styles')) return;

    const style = document.createElement('style');
    style.id = 'yuxtrans-styles';
    style.textContent = `
      /* 关键动画：避免 content.css 加载完成前出现生硬闪烁 */
      @keyframes yuxtrans-slideIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes yuxtrans-fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    ;`
    document.head.appendChild(style);
  }

  bindEvents() {
    document.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    document.addEventListener('mousedown', (e) => this.handleMouseDown(e));

    // F1 悬停段落翻译：修饰键 + 鼠标悬停段落
    document.addEventListener('mousemove', (e) => this._handleHoverMouseMove(e), { passive: true });
    document.addEventListener('keydown', (e) => this._handleHoverKeyDown(e));
    document.addEventListener('keyup', (e) => this._handleHoverKeyUp(e));

    // F2：双击单词直出词典卡片（浏览器双击自动选词，icon/contextMenu 模式也直出）
    document.addEventListener('dblclick', (e) => this._handleDblClick(e));

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'translateSelection') {
        const selection = window.getSelection().toString().trim();
        if (selection) {
          this.translateText(selection);
        }
        sendResponse({ success: true });
      } else if (request.action === 'translatePage') {
        this.translatePage();
        sendResponse({ success: true });
      } else if (request.action === 'streamChunk') {
        // 流式输出：逐字更新弹窗或整页段落
        this.handleStreamChunk(request.chunk, request.fullText, request.requestId);
      } else if (request.action === 'applyBilingualMode') {
        // popup 翻译模式切换：立即重渲染已翻译内容（不写站点偏好）
        this.applyBilingualRender(request.bilingualMode !== false);
        sendResponse({ success: true });
      } else if (request.action === 'getPageTranslationState') {
        // popup 整页按钮状态机：查询当前页翻译状态
        sendResponse({
          success: true,
          isTranslating: !!(this.pageTranslationState.isTranslating || this._dynamicTranslating || this._pageTranslateLocked),
          isTranslated: !!this.pageTranslationState.isTranslated
        });
      } else if (request.action === 'cancelPageTranslation') {
        // popup「终止翻译」：停止在途任务并恢复原文
        //（restoreOriginalTexts 内部已含在途任务取消链路 cancelPageTranslation）
        this.restoreOriginalTexts();
        if (typeof this.setPageControlRestoredState === 'function') {
          this.setPageControlRestoredState();
        }
        sendResponse({ success: true });
      }
      return true;
    });

    // 配置变更实时同步：options 页保存后即时生效，无需刷新页面
    // P1-P3 的新开关（hover/dict/显示样式）依赖此机制；loadConfig 经 getConfig 拉取最新值覆盖 this.config
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        // F3：originalStyle 变化时实时重应用已渲染译文的原文样式
        const oldStyle = this.config.originalStyle;
        this.loadConfig().then(() => {
          if (this.config.originalStyle !== oldStyle && this.pageTranslationState.isTranslated) {
            this.applyOriginalStyleToAll();
          }
        });
      });
    }
  }

  /**
   * 获取页面上下文信息（用于增强翻译精度）
   */
  getPageContext() {
    return {
      pageTitle: document.title || '',
      pageUrl: location.href || ''
    };
  }

  /**
   * Stage F：Shadow Host 工厂——所有悬浮 UI（划词浮窗/浮钮/页控条/挂耳/悬停译文/引导层）
   * 统一经此创建，样式与宿主页面隔离（docs/UI_DESIGN_SYSTEM.md §9.3）。
   * @param {string} [hostClass] - host 语义类名（如 yuxtrans-host-popup），页面级定位由该类承载
   * @returns {{ host: Element, root: ShadowRoot|Element }}
   *   host 承载页面级坐标（position/left/top/z-index），UI 元素挂进 root；
   *   无 attachShadow 能力的环境（Node 单测）退化为 root === host（不隔离，仅保结构）。
   */
  createShadowHost(hostClass) {
    const host = document.createElement('div');
    host.className = 'yuxtrans-shadow-host' + (hostClass ? ' ' + hostClass : '');
    // 宿主页暗色探测结果同步进 shadow：content.css 以 :host([data-yxt-host-dark="1"]) 覆盖令牌
    if (document.documentElement && document.documentElement.dataset &&
        document.documentElement.dataset.yxtHostDark === '1') {
      host.dataset.yxtHostDark = '1';
    }
    if (typeof host.attachShadow !== 'function' || !chrome?.runtime?.getURL) {
      return { host, root: host }; // 退化路径：Node 单测等无 shadow/getURL 能力环境
    }
    const root = host.attachShadow({ mode: 'open' });
    // shadow 内共享样式：设计令牌 + content.css（页面内嵌样式仍由 manifest 全局注入提供）
    for (const file of ['design-tokens.css', 'content.css']) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL(file);
      root.appendChild(link);
    }
    return { host, root };
  }

  /**
   * Stage F：移除悬浮 UI——连同其 shadow host 一并移除（无 host 引用时退化为自身 remove）
   * @param {Element|null} el - shadow 内的 UI 元素（创建时挂有 _yxtHost 回引）
   */
  _removeFloatingUI(el) {
    if (!el) return;
    const host = el._yxtHost;
    if (host) {
      if (host.parentNode) host.remove();
    } else if (el.parentNode) {
      el.remove();
    }
  }

  /**
   * 安全从事件 target 做 closest（文本节点 / 无 closest 宿主不抛错）
   * Stage F：优先沿 e.composedPath() 逐层 matches——shadow 内事件在 document 监听器中
   * target 会被重定向为 host，直接 closest 会漏掉 shadow 内的自有 UI（浮窗/浮钮等）。
   * @param {Event} e
   * @param {string} selector
   * @returns {Element|null}
   */
  _eventClosest(e, selector) {
    if (e && typeof e.composedPath === 'function') {
      const path = e.composedPath();
      for (const node of path) {
        if (node && node.nodeType === 1 && typeof node.matches === 'function') {
          try {
            if (node.matches(selector)) return node;
          } catch (err) { /* 选择器非法时静默，走兜底 */ }
        }
      }
      return null;
    }
    const target = e && e.target;
    if (this.helpers.eventTargetClosest) {
      return this.helpers.eventTargetClosest(target, selector);
    }
    // helpers 未就绪时的兜底
    if (!target) return null;
    const el = target.nodeType === 1 ? target : (target.parentElement || null);
    if (!el || typeof el.closest !== 'function') return null;
    try {
      return el.closest(selector);
    } catch (err) {
      return null;
    }
  }

  /**
   * 处理流式输出增量文本
   * @param {string} chunk - 本次增量
   * @param {string} fullText - 当前完整文本
   * @param {string|null} requestId - 请求标识（整页翻译时为段落 ID，划词浮窗为 _registerPopupRequest 生成的 ID）
   */
  handleStreamChunk(chunk, fullText, requestId) {
    // 1. 整页翻译段落级流式
    if (requestId && this.pageTranslationState?.streamingNodes?.has(requestId)) {
      const state = this.pageTranslationState.streamingNodes.get(requestId);
      if (state && state.tempSpan) {
        state.tempSpan.textContent = fullText;
      }
      return;
    }

    // 2. #4 划词浮窗流式：按 requestId 路由到对应浮窗（pin 后在途流仍写回原浮窗，不串台）
    if (requestId && this._popupRequests.has(requestId)) {
      const popup = this._peekPopupForRequest(requestId);
      if (!popup) return; // 浮窗已销毁：丢弃 chunk 并清理映射
      const targetEl = popup.querySelector('.yuxtrans-target');
      if (!targetEl) return;

      // 首次收到流式内容时，清除 loading 占位
      if (targetEl.querySelector('.yuxtrans-loading')) {
        targetEl.textContent = '';
      }
      targetEl.textContent += chunk;
      return;
    }

    // 整页段落流式的过期 chunk（取消/完成后 streamingNodes 已清理）：直接忽略，避免污染划词弹窗
    if (requestId && requestId !== 'popup') return;

    // 3. 划词弹窗流式（兼容无 requestId 或 'popup' 的旧逻辑）
    if (!this.popup) return;
    const targetEl = this.popup.querySelector('.yuxtrans-target');
    if (!targetEl) return;

    // 首次收到流式内容时，清除 loading 占位
    if (targetEl.querySelector('.yuxtrans-loading')) {
      targetEl.textContent = '';
    }
    targetEl.textContent += chunk;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Node 测试环境仅导出类；globalThis 供 lib/content/* 拆分模块挂原型（浏览器实例化见 lib/content/init.js）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { YuxTransContent };
}
globalThis.YuxTransContent = YuxTransContent;