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
    this.helpers = (typeof YuxTransHelpers !== 'undefined' && YuxTransHelpers) || {};
    this.pageTranslationState = {
      isTranslated: false,
      isTranslating: false,
      originalTexts: new Map(), // node -> { text, styles }
      translatedNodes: [],
      streamingNodes: new Map(), // requestId -> { nodeInfo, tempSpan }
      failedItems: [], // 失败节点，供重试
      cacheHits: 0,
      apiCount: 0
    };
    this.pageControl = null;
    this.config = {
      concurrency: 50, // 并发请求数（云端默认 50，本地自动降为 1）
      batchSize: 20,  // 批量大小（减少 API 调用次数）
      minTextLength: 2, // 最小翻译文本长度
      preserveStyles: true, // 保持样式
      sourceLang: 'auto',
      targetLang: 'zh',
      siteRule: 'all',
      siteList: [],
      triggerMode: 'auto',
      enableStreaming: true,
      bilingualMode: true,
      offlineMode: false,
      siteModePrefs: {}
    };
    this.init();
  }

  init() {
    this.createStyles();
    this.bindEvents();
    this.loadConfig();
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
        this.config.triggerMode = response.triggerMode || 'auto';
        this.config.enableStreaming = response.enableStreaming !== false;
        this.config.offlineMode = !!response.offlineMode;
        this.config.siteModePrefs = response.siteModePrefs || {};
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
        if (response.batchConfig) {
          this.config.maxBatchChars = response.batchConfig.maxBatchChars;
          this.config.batchSize = response.batchConfig.batchSize;
        }
      }
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
      @keyframes yuxtrans-spin {
        to { transform: rotate(360deg); }
      }
    ;`
    document.head.appendChild(style);
  }

  bindEvents() {
    document.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    document.addEventListener('mousedown', (e) => this.handleMouseDown(e));

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
      }
      return true;
    });
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
   * 处理流式输出增量文本
   * @param {string} chunk - 本次增量
   * @param {string} fullText - 当前完整文本
   * @param {string|null} requestId - 请求标识（整页翻译时为段落 ID，弹窗为 'popup'）
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

    // 2. 划词弹窗流式（兼容无 requestId 的旧逻辑）
    if (!this.popup) return;
    const targetEl = this.popup.querySelector('.yuxtrans-target');
    if (!targetEl) return;

    // 首次收到流式内容时，清除 loading 占位
    if (targetEl.querySelector('.yuxtrans-loading')) {
      targetEl.textContent = '';
    }
    targetEl.textContent += chunk;
  }

  handleMouseUp(e) {
    if (e.target.closest('.yuxtrans-popup, .yuxtrans-float-btn')) return;
    if (!this.isSiteAllowed()) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const selection = sel.toString().trim();
      if (!selection || selection.length === 0) {
        this.hideFloatButton();
        return;
      }

      // 跳过输入框、代码块、可编辑区域中的选中文本
      if (sel.rangeCount > 0) {
        const node = sel.getRangeAt(0).commonAncestorContainer;
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (el && el.closest('input, textarea, [contenteditable="true"], code, pre, kbd, samp')) {
          this.hideFloatButton();
          return;
        }
      }

      // 跳过纯数字、纯符号、URL 等无翻译价值文本
      if (!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(selection)) {
        this.hideFloatButton();
        return;
      }

      // 按设置的触发模式：auto 直接译 / icon 浮钮 / contextMenu 仅右键
      const mode = this.helpers.resolveTriggerAction
        ? this.helpers.resolveTriggerAction(this.config.triggerMode)
        : (this.config.triggerMode || 'auto');

      if (mode === 'contextMenu') {
        this.hideFloatButton();
        return;
      }
      if (mode === 'auto') {
        this.hideFloatButton();
        this.translateText(selection, e.clientX, e.clientY);
        return;
      }
      // icon
      this.showFloatButton(e.clientX, e.clientY, selection);
    }, 10);
  }

  handleMouseDown(e) {
    if (!e.target.closest('.yuxtrans-popup') && !e.target.closest('.yuxtrans-float-btn')) {
      this.hidePopup();
    }
  }

  showFloatButton(x, y, text) {
    this.hideFloatButton();

    const btn = document.createElement('button');
    btn.className = 'yuxtrans-float-btn';
    btn.textContent = '翻译';

    // 限制在可视区域内，避免贴边
    const btnWidth = 60;
    const btnHeight = 32;
    const padding = 8;
    const left = Math.min(Math.max(padding, x + 10), window.innerWidth - btnWidth - padding);
    const top = Math.min(Math.max(padding, y + 10), window.innerHeight - btnHeight - padding);
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.translateText(text, left, top + btnHeight);
      this.hideFloatButton();
    });

    document.body.appendChild(btn);
    this.floatBtn = btn;
  }

  hideFloatButton() {
    if (this.floatBtn) {
      this.floatBtn.remove();
      this.floatBtn = null;
    }
  }

  translateText(text, x, y) {
    if (!this.isSiteAllowed()) return;
    if (this.isTranslating) return;

    const selection = window.getSelection();
    let rect = { left: x || 100, top: y || 100, width: 0, height: 0 };

    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      rect = range.getBoundingClientRect();
    }

    this.showPopup(rect.left, rect.bottom + 10, text);
    this.isTranslating = true;

    const sourceLang = this.config.sourceLang || 'auto';
    const targetLang = this.config.targetLang || 'zh';
    const context = this.getPageContext();
    const action = this.helpers.resolveTranslateAction
      ? this.helpers.resolveTranslateAction(this.config.enableStreaming)
      : (this.config.enableStreaming === false ? 'translate' : 'translateStream');

    chrome.runtime.sendMessage(
      {
        action,
        text,
        sourceLang,
        targetLang,
        context,
        requestId: 'popup'
      },
      (response) => {
        this.isTranslating = false;

        const isLocal = (this.config.provider === 'local');

        if (response && response.success) {
          this.updatePopup(response.text, response.cached, response.engine, text);
        } else {
          const userError = response?.userError;
          const errorMsg = userError
            ? (this.helpers.formatUserErrorText
              ? this.helpers.formatUserErrorText(userError)
              : `${userError.userMessage}\n\n${userError.actionHint || ''}`)
            : (response?.error || '未知错误');
          if (!isLocal && (errorMsg.includes('API Key') || errorMsg.includes('请先配置') || userError?.code === 'AUTH')) {
            this.updatePopup('⚠️ 请先在设置中配置 API Key\n\n打开扩展设置 → 供应商档案 完成配置', false, 'warning');
          } else {
            this.updatePopup(errorMsg, false, 'error');
          }
        }
      }
    );
  }

  /**
   * 流式翻译单个段落（用于整页首屏逐段渲染）
   */
  async translateStreamForNode(nodeInfo, requestId) {
    const { text, node } = nodeInfo;
    const parent = node.parentElement;
    if (!parent) return { success: false, error: '父节点丢失' };

    // 创建临时流式译文容器
    const tempSpan = document.createElement('span');
    tempSpan.className = 'yuxtrans-streaming-text';
    tempSpan.textContent = '';

    if (node.nextSibling) {
      parent.insertBefore(tempSpan, node.nextSibling);
    } else {
      parent.appendChild(tempSpan);
    }

    this.pageTranslationState.streamingNodes.set(requestId, { nodeInfo, tempSpan });

    const sourceLang = this.config.sourceLang || 'auto';
    const targetLang = this.config.targetLang || 'zh';

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pageTranslationState.streamingNodes.delete(requestId);
        if (tempSpan.parentNode) tempSpan.remove();
        resolve({ success: false, error: '流式翻译超时' });
      }, 25000);

      chrome.runtime.sendMessage(
        {
          action: 'translateStream',
          text,
          sourceLang,
          targetLang,
          // 整页翻译的段落流式请求不再携带页面标题等上下文，避免模型把任意片段偏向页面标题。
          context: null,
          requestId
        },
        (response) => {
          clearTimeout(timeout);
          this.pageTranslationState.streamingNodes.delete(requestId);
          if (tempSpan.parentNode) tempSpan.remove();

          if (response && response.success) {
            this.applyTranslation(nodeInfo, response.text);
            resolve({ success: true, translated: response.text, cached: response.cached });
          } else {
            resolve({ success: false, error: response?.error || '流式翻译失败' });
          }
        }
      );
    });
  }

  /**
   * 筛选可视区域内的节点
   */
  getViewportNodes(nodesInfo) {
    return nodesInfo.filter(info => info.isInViewport);
  }

  showPopup(x, y, sourceText) {
    this.hidePopup();

    const popup = document.createElement('div');
    popup.className = 'yuxtrans-popup';
    popup.innerHTML = `
      <div class="yuxtrans-popup-header">
        <span class="yuxtrans-popup-title">YuxTrans</span>
        <button class="yuxtrans-popup-close" aria-label="关闭">&times;</button>
      </div>
      <div class="yuxtrans-popup-content">
        <div class="yuxtrans-source">${this.escapeHtml(sourceText)}</div>
        <div class="yuxtrans-target">
          <div class="yuxtrans-loading">
            <div class="yuxtrans-spinner"></div>
            <span>翻译中...</span>
          </div>
        </div>
      </div>
      <div class="yuxtrans-popup-footer">
        <span class="yuxtrans-status"><span class="yuxtrans-status-badge">准备</span></span>
        <div class="yuxtrans-popup-actions">
          <button class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-bad-btn" style="display:none" title="标记差译并清除缓存">差译</button>
          <button class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-copy-btn">复制</button>
        </div>
      </div>
    `;

    document.body.appendChild(popup);
    this.popup = popup;
    this.popup.dataset.sourceText = sourceText;

    // 实际尺寸出来后，再定位并限制在可视区域
    requestAnimationFrame(() => {
      if (!this.popup) return;
      const rect = this.popup.getBoundingClientRect();
      const padding = 16;
      const maxX = window.innerWidth - rect.width - padding;
      const maxY = window.innerHeight - rect.height - padding;
      popup.style.left = `${Math.min(Math.max(padding, x), maxX)}px`;
      popup.style.top = `${Math.min(Math.max(padding, y), maxY)}px`;
    });

    const closeHandler = () => this.hidePopup();
    popup.querySelector('.yuxtrans-popup-close').addEventListener('click', closeHandler);

    // 按 Esc 关闭弹窗
    this._popupEscHandler = (e) => {
      if (e.key === 'Escape') closeHandler();
    };
    document.addEventListener('keydown', this._popupEscHandler);

    // 复制按钮只绑定一次
    popup.querySelector('.yuxtrans-copy-btn').addEventListener('click', () => {
      this.copyPopupTranslation();
    });

    popup.querySelector('.yuxtrans-bad-btn').addEventListener('click', () => {
      this.reportBadPopupTranslation();
    });
  }

  updatePopup(translatedText, cached, engine, sourceText) {
    if (!this.popup) return;

    const targetEl = this.popup.querySelector('.yuxtrans-target');
    targetEl.textContent = translatedText;

    const statusEl = this.popup.querySelector('.yuxtrans-status');
    const isError = engine === 'error' || engine === 'warning';
    const badgeClass = this._getStatusBadgeClass(cached, engine);
    let statusText = '完成';
    if (isError) statusText = engine === 'warning' ? '需配置' : '失败';
    else if (cached || engine === 'cache' || engine === 'glossary') {
      statusText = engine === 'glossary' ? '术语表' : '缓存命中';
    } else if (engine === 'local') statusText = '本地模型';
    else if (engine) statusText = String(engine);
    statusEl.innerHTML = `<span class="yuxtrans-status-badge ${badgeClass}">${this.escapeHtml(String(statusText))}</span>`;

    // 保存当前译文，供复制使用
    this.popup.dataset.translation = translatedText;
    if (sourceText) this.popup.dataset.sourceText = sourceText;

    const badBtn = this.popup.querySelector('.yuxtrans-bad-btn');
    if (badBtn) {
      badBtn.style.display = isError ? 'none' : 'inline-block';
    }

    // 自动复制（如果用户开启）
    if (!isError && this.config.autoCopy) {
      this.copyPopupTranslation();
    }
  }

  /**
   * 标记差译：剔除对应缓存条目
   */
  async reportBadPopupTranslation() {
    if (!this.popup) return;
    const text = this.popup.dataset.sourceText || this.popup.querySelector('.yuxtrans-source')?.textContent || '';
    if (!text) return;
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'reportBadTranslation',
        text,
        sourceLang: this.config.sourceLang || 'auto',
        targetLang: this.config.targetLang || 'zh'
      });
      const statusEl = this.popup.querySelector('.yuxtrans-status');
      if (statusEl) {
        statusEl.innerHTML = res?.removed
          ? '<span class="yuxtrans-status-badge cache">已清除缓存</span>'
          : '<span class="yuxtrans-status-badge warning">无缓存条目</span>';
      }
    } catch (e) {
      console.warn('[YuxTrans] 报告差译失败:', e);
    }
  }

  _getStatusBadgeClass(cached, engine) {
    if (cached) return 'cache';
    if (engine === 'local' || engine === 'ollama') return 'local';
    if (engine === 'error' || engine === 'warning') return engine;
    return 'cloud';
  }

  async copyPopupTranslation() {
    if (!this.popup) return;
    const translatedText = this.popup.dataset.translation || this.popup.querySelector('.yuxtrans-target')?.textContent || '';
    if (!translatedText) return;

    try {
      await navigator.clipboard.writeText(translatedText);
    } catch (e) {
      // clipboard API 降级：textarea 方案
      const ta = document.createElement('textarea');
      ta.value = translatedText;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    const statusEl = this.popup.querySelector('.yuxtrans-status');
    const originalHtml = statusEl.innerHTML;
    statusEl.innerHTML = '<span class="yuxtrans-status-badge cache">已复制</span>';
    setTimeout(() => {
      if (this.popup) statusEl.innerHTML = originalHtml;
    }, 2000);
  }

  hidePopup() {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    if (this._popupEscHandler) {
      document.removeEventListener('keydown', this._popupEscHandler);
      this._popupEscHandler = null;
    }
  }

  // ===== 整页翻译优化 =====

  /**
   * 收集可翻译的文本节点，按可视区域排序
   */
  collectTextNodes() {
    const nodes = [];
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          // 排除特定元素
          const skipSelectors = [
            'script', 'style', 'noscript', 'iframe', 'canvas', 'svg',
            'code', 'pre', '[contenteditable="true"]',
            '.yuxtrans-progress', '.yuxtrans-popup', '.yuxtrans-page-control',
            '.yuxtrans-side-tab', '.yuxtrans-float-btn', '.yuxtrans-site-rule-toast',
            '.yuxtrans-translated', '.yuxtrans-translated-bilingual',
            '.yuxtrans-bilingual-text', '.yuxtrans-streaming-text'
          ].join(', ');
          if (parent.closest(skipSelectors)) {
            return NodeFilter.FILTER_REJECT;
          }

          // 排除输入元素
          if (parent.closest('input, textarea, select')) {
            return NodeFilter.FILTER_REJECT;
          }

          // 排除已翻译节点（含双语模式）
          const isTranslated = parent.classList.contains('yuxtrans-translated');
          const isBilingual = parent.classList.contains('yuxtrans-translated-bilingual');
          if (isTranslated || isBilingual) {
            return NodeFilter.FILTER_REJECT;
          }

          // 最小文本长度
          const text = node.textContent.trim();
          if (text.length < this.config.minTextLength) {
            return NodeFilter.FILTER_REJECT;
          }

          // 跳过纯数字、纯符号、URL、邮箱等无翻译价值文本
          if (!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (/^(https?:\/\/|www\.|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.test(text)) {
            return NodeFilter.FILTER_REJECT;
          }

          // 跳过 GitHub 等页面的元数据片段：commit SHA、@mention、#tag、仓库路径、文件名
          if (/^\s*[@#][\w-]+/.test(text)) return NodeFilter.FILTER_REJECT;
          if (/^\s*[a-f0-9]{7,40}(\.{3})?\s*$/i.test(text)) return NodeFilter.FILTER_REJECT;
          if (/^\s*\w+\/\w+/.test(text)) return NodeFilter.FILTER_REJECT;
          if (/^\s*[0-9]+\s*$/.test(text)) return NodeFilter.FILTER_REJECT;
          if (/(?:^|[^\p{L}\d_])\.[a-z0-9]{1,6}$/i.test(text) && !text.includes(' ')) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const rect = node.parentElement.getBoundingClientRect();

      // 计算节点是否在可视区域
      const isInViewport = (
        rect.bottom > 0 &&
        rect.top < viewportHeight &&
        rect.right > 0 &&
        rect.left < viewportWidth
      );

      nodes.push({
        node,
        text: node.textContent.trim(),
        isInViewport,
        rect: {
          top: rect.top,
          bottom: rect.bottom
        }
      });
    }

    // 排序：可视区域优先
    nodes.sort((a, b) => {
      if (a.isInViewport && !b.isInViewport) return -1;
      if (!a.isInViewport && b.isInViewport) return 1;
      return a.rect.top - b.rect.top; // 按页面位置排序
    });

    return nodes;
  }

  /**
   * 获取元素的重要样式
   */
  getElementStyles(element) {
    if (!this.config.preserveStyles) return null;

    const computed = window.getComputedStyle(element);
    const parent = element.parentElement;

    // 检查是否是特殊标签
    const tagName = element.tagName.toLowerCase();
    const isBold = tagName === 'strong' || tagName === 'b' ||
      computed.fontWeight === 'bold' || parseInt(computed.fontWeight) >= 600;
    const isItalic = tagName === 'em' || tagName === 'i' ||
      computed.fontStyle === 'italic';
    const isLink = tagName === 'a' || (parent && parent.tagName.toLowerCase() === 'a');
    const isCode = tagName === 'code' || (parent && parent.tagName.toLowerCase() === 'code');
    const isMark = tagName === 'mark' || (parent && parent.tagName.toLowerCase() === 'mark');

    return {
      isBold,
      isItalic,
      isLink,
      isCode,
      isMark,
      color: computed.color,
      fontSize: computed.fontSize,
      className: element.className || ''
    };
  }

  /**
   * 并行翻译多个文本
   * @param {Array} items - 待翻译项
   * @param {Function|null} onProgress - 进度回调 (completed, total)
   * @param {Function|null} onBatchResult - 每个 batch 完成时的回调 (indices, nodes, results)
   */
  async translateBatchParallel(items, onProgress, onBatchResult = null, options = {}) {
    const isLocal = this.config.provider === 'local';
    const { concurrency: configConcurrency } = this.config || { concurrency: 10 };

    // 动态调整：本地模型强制串行且减小分片，云端模型维持高并发
    const concurrency = isLocal ? 1 : (options.concurrency || configConcurrency);
    const BATCH_SIZE = isLocal
      ? 5
      : (options.batchSize || this.config.batchSize || 20);
    
    const results = new Array(items.length);
    let completed = 0;

    // 分块打包
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      batches.push({
        indices: Array.from({ length: Math.min(BATCH_SIZE, items.length - i) }, (_, k) => i + k),
        nodes: items.slice(i, i + BATCH_SIZE)
      });
    }

    const queue = [...batches.keys()];

    let failsInARow = 0;
    let fallbackMode = false; // 是否已进入单句翻译降级模式

    const worker = async () => {
      while (queue.length > 0 && this.pageTranslationState.isTranslating) {
        const batchIndex = queue.shift();
        const batch = batches[batchIndex];
        
        // 如果进入了降级模式，且当前 batch 包含多项，则将其重新拆分为单个任务送回队列
        if (fallbackMode && batch.indices.length > 1) {
          batch.indices.forEach((idx, i) => {
            batches.push({
              indices: [idx],
              nodes: [batch.nodes[i]]
            });
            queue.push(batches.length - 1);
          });
          continue;
        }

        const texts = batch.nodes.map(item => item.text);

        try {
          const response = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ success: false, error: 'Request nested timeout' }), 130000);
            chrome.runtime.sendMessage(
              {
                action: 'translateBatch',
                texts: texts,
                sourceLang: this.config.sourceLang || 'auto',
                targetLang: this.config.targetLang || 'zh',
                // 整页批量翻译不携带页面标题，避免模型把所有片段译成同一个标题。
                context: null
              },
              (res) => {
                clearTimeout(timer);
                resolve(res);
              }
            );
          });

          if (response && response.success && response.results) {
            failsInARow = 0;
            response.results.forEach((res, localIdx) => {
              const globalIdx = batch.indices[localIdx];
              if (res && res.success) {
                results[globalIdx] = { success: true, translated: res.text, cached: res.cached };
              } else {
                results[globalIdx] = { success: false, error: res?.error };
              }
            });
            if (onBatchResult) {
              onBatchResult(batch.indices, batch.nodes, response.results);
            }
          } else {
            throw new Error(response?.error || 'Batch response failed');
          }
        } catch (error) {
          failsInARow++;
          // 如果连续 2 次 Batch 失败，开启降级模式
          if (isLocal && failsInARow >= 2) {
            fallbackMode = true;
          }

          batch.indices.forEach(globalIdx => {
             results[globalIdx] = { success: false, error: error.message };
          });
        } finally {
          completed += batch.nodes.length;
          if (onProgress) {
            onProgress(completed, items.length);
          }
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, batches.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    return results;
  }

  /**
   * 应用翻译结果，保持样式
   */
  applyTranslation(nodeInfo, translatedText) {
    const { node } = nodeInfo;

    // 防止对同一节点重复应用（例如批量回调与最终循环重叠）
    if (this.pageTranslationState.originalTexts.has(node)) {
      return false;
    }

    const parent = node.parentElement;
    if (!parent) return false;

    // 保存原文、样式和双语节点引用
    const originalData = {
      text: node.textContent,
      translated: translatedText, // 核心：缓存译文，支持动态切换
      styles: this.getElementStyles(parent),
      bilingualNode: null
    };
    this.pageTranslationState.originalTexts.set(node, originalData);

    const useBilingual = this.config.bilingualMode !== false; // 默认开启

    if (useBilingual) {
      // 双语对照模式：新增一个隐藏了部分原样式的 span
      const bilingualSpan = document.createElement('span');
      bilingualSpan.className = 'yuxtrans-bilingual-text';
      // 两端可以加一个细微的空白或破折号分隔
      bilingualSpan.textContent = translatedText;
      
      if (node.nextSibling) {
        parent.insertBefore(bilingualSpan, node.nextSibling);
      } else {
        parent.appendChild(bilingualSpan);
      }
      
      originalData.bilingualNode = bilingualSpan;
      parent.classList.add('yuxtrans-translated-bilingual');
    } else {
      // 仅译文模式：直接替换并加类名
      node.textContent = translatedText;
      parent.classList.add('yuxtrans-translated');
    }

    // 保持样式（如果需要）
    if (originalData.styles) {
      const styles = originalData.styles;

      // 保持粗体
      if (styles.isBold) {
        parent.style.fontWeight = 'bold';
      }

      // 保持斜体
      if (styles.isItalic) {
        parent.style.fontStyle = 'italic';
      }

      // 保持链接样式
      if (styles.isLink) {
        const linkParent = parent.tagName.toLowerCase() === 'a' ? parent :
          (parent.parentElement?.tagName.toLowerCase() === 'a' ? parent.parentElement : null);
        if (linkParent) {
          linkParent.style.color = styles.color;
          linkParent.style.textDecoration = styles.isLink ? 'underline' : 'none';
        }
      }
    }

    this.pageTranslationState.translatedNodes.push(node);
    return true;
  }

  /**
   * 标记翻译失败的节点
   */
  markFailedNode(nodeInfo, error) {
    const { node } = nodeInfo;
    const parent = node.parentElement;
    if (!parent) return;

    // 仅当未被标记过才保存原文，防止覆盖已有错误记录
    if (!this.pageTranslationState.originalTexts.has(node)) {
      parent.classList.add('yuxtrans-failed');
      this.pageTranslationState.originalTexts.set(node, {
        text: node.textContent,
        styles: this.getElementStyles(parent),
        error: error
      });
    }
  }

  /**
   * 整页翻译主函数
   */
  async translatePage() {
    // 同步锁：防止快速重复触发（如双击、消息重入）导致套娃翻译
    if (this._pageTranslateLocked) return;
    this._pageTranslateLocked = true;

    try {
      // 每次触发都重新拉取配置，确保模式开关实时生效
      await this.loadConfig();

      // 站点规则控制
      if (!this.isSiteAllowed()) return;

    // 防止重入：如果正在翻译中，再次触发则恢复原文
    if (this.pageTranslationState.isTranslating) {
      if (this.pageTranslationState.isTranslated) {
        this.restoreOriginalTexts();
        this.setPageControlRestoredState();
      }
      return;
    }

    // 如果已翻译，恢复原文
    if (this.pageTranslationState.isTranslated) {
      this.restoreOriginalTexts();
      this.setPageControlRestoredState();
      return;
    }

    // 收集文本节点
    const nodesInfo = this.collectTextNodes();

    if (nodesInfo.length === 0) {
      return;
    }

    // 初始化状态
    this.pageTranslationState.translatedNodes = [];
    this.pageTranslationState.isTranslating = true;
    this.pageTranslationState.originalTexts.clear();
    this.pageTranslationState.streamingNodes.clear();
    this.pageTranslationState.failedItems = [];
    this.pageTranslationState.cacheHits = 0;
    this.pageTranslationState.apiCount = 0;

    // 禁用控制条上的翻译/重新翻译按钮，防止任务进行中重复点击
    this.setPageControlTranslateDisabled(true);

    // ===== 文本去重优化 =====
    const uniqueTexts = new Map(); // text -> { indices: [], translation: null, error: null }
    const dedupedItems = [];
    let duplicateCount = 0;

    nodesInfo.forEach((nodeInfo, index) => {
      const text = nodeInfo.text;
      if (uniqueTexts.has(text)) {
        // 记录重复文本的索引
        uniqueTexts.get(text).indices.push(index);
        duplicateCount++;
      } else {
        // 新文本
        uniqueTexts.set(text, { indices: [index], translation: null, error: null });
        dedupedItems.push({ text, originalIndex: index, nodeInfo });
      }
    });

    // 区分首屏与后续节点
    const viewportItems = dedupedItems.filter(item => item.nodeInfo.isInViewport);
    const belowFoldItems = dedupedItems.filter(item => !item.nodeInfo.isInViewport);

    const displayTotal = nodesInfo.length;
    this.showPageControl(displayTotal);
    const startTime = Date.now();
    let completedUnits = 0;

    const reportProgress = (delta) => {
      completedUnits += delta;
      const ratio = dedupedItems.length > 0 ? nodesInfo.length / dedupedItems.length : 1;
      const actualCompleted = Math.min(Math.round(completedUnits * ratio), nodesInfo.length);
      this.updatePageControl(actualCompleted, displayTotal, startTime);
    };

    try {
      // A: 首屏 mini-batch 翻译（用 0.5-0.9s 首字延迟换取总吞吐大幅提升）
      const isLocal = this.config.provider === 'local';
      const viewportBatchSize = isLocal ? 3 : 10;
      const viewportConcurrency = isLocal ? 2 : 4;

      if (viewportItems.length > 0 && this.pageTranslationState.isTranslating) {
        let lastViewportCompleted = 0;
        await this.translateBatchParallel(
          viewportItems,
          (completed, total) => {
            reportProgress(completed - lastViewportCompleted);
            lastViewportCompleted = completed;
          },
          (indices, nodes, results) => {
            // 每个 mini-batch 完成立即渲染，保证首屏感知
            results.forEach((res, localIdx) => {
              const item = nodes[localIdx];
              if (res && res.success) {
                uniqueTexts.get(item.text).translation = res.text;
                if (res.cached) this.pageTranslationState.cacheHits++;
                else this.pageTranslationState.apiCount++;
                this.applyTranslation(item.nodeInfo, res.text);
              }
            });
          },
          { batchSize: viewportBatchSize, concurrency: viewportConcurrency }
        );
        // 记录失败项
        viewportItems.forEach((item) => {
          const resultItem = uniqueTexts.get(item.text);
          if (!resultItem.translation && !resultItem.error) {
            resultItem.error = '翻译失败';
          }
        });
      }

      // 2. 后续区域批量翻译（随到随渲染）
      const appliedTexts = new Set();
      let lastBatchCompleted = 0;
      if (belowFoldItems.length > 0 && this.pageTranslationState.isTranslating) {
        await this.translateBatchParallel(
          belowFoldItems,
          (completed, total) => {
            reportProgress(completed - lastBatchCompleted);
            lastBatchCompleted = completed;
          },
          (indices, nodes, results) => {
            // 每个 batch 完成立即渲染
            results.forEach((res, localIdx) => {
              const item = nodes[localIdx];
              if (res && res.success) {
                uniqueTexts.get(item.text).translation = res.text;
                appliedTexts.add(item.text);
                if (res.cached) this.pageTranslationState.cacheHits++;
                else this.pageTranslationState.apiCount++;
                this.applyTranslation(item.nodeInfo, res.text);
              }
            });
          }
        );
        // 记录失败项
        belowFoldItems.forEach((item) => {
          const resultItem = uniqueTexts.get(item.text);
          if (!resultItem.translation && !resultItem.error) {
            resultItem.error = '翻译失败';
          }
        });
      }

      // 3. 应用翻译结果（包括重复文本；applyTranslation 内部已做去重）
      let successCount = 0;
      let failCount = 0;
      for (let i = 0; i < nodesInfo.length; i++) {
        const nodeInfo = nodesInfo[i];
        const item = uniqueTexts.get(nodeInfo.text);
        if (item.translation) {
          // 每个节点都尝试应用译文，确保重复文本节点也纳入 originalTexts，
          // 从而支持双语/仅译文切换时同步更新所有出现位置
          const applied = this.applyTranslation(nodeInfo, item.translation);
          if (applied || this.pageTranslationState.originalTexts.has(nodeInfo.node)) {
            if (!appliedTexts.has(nodeInfo.text)) {
              successCount++;
              appliedTexts.add(nodeInfo.text);
            }
          }
        } else if (item.error) {
          // 失败项可视化标记
          this.markFailedNode(nodeInfo, item.error);
          this.pageTranslationState.failedItems.push({ nodeInfo, text: nodeInfo.text, error: item.error });
          failCount++;
        }
      }

      // 翻译完成
      this.pageTranslationState.isTranslated = true;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logPageMetrics({
        url: location.href,
        provider: this.config.provider,
        model: this.config.model,
        totalNodes: nodesInfo.length,
        viewportNodes: viewportItems.length,
        belowFoldNodes: belowFoldItems.length,
        uniqueTexts: dedupedItems.length,
        duplicateTexts: duplicateCount,
        successCount,
        failCount,
        cacheHits: this.pageTranslationState.cacheHits,
        apiCount: this.pageTranslationState.apiCount,
        elapsedSeconds: parseFloat(elapsed)
      });
      this.showPageControlComplete(
        successCount, nodesInfo.length, elapsed, duplicateCount, failCount
      );
    } catch (error) {
      console.error('[YuxTrans] 整页翻译异常:', error);
    } finally {
      this.pageTranslationState.isTranslating = false;
      this.pageTranslationState.streamingNodes.clear();
      // 任务结束（成功/失败/取消）后重新启用翻译按钮
      this.setPageControlTranslateDisabled(false);
    }
  } finally {
    this._pageTranslateLocked = false;
  }
}

/**
 * 获取整页翻译控制条内的元素
 */
  pageControlElement(id) {
    return this.pageControl ? this.pageControl.querySelector(`#${id}`) : null;
  }

  /**
   * 禁用/启用控制条上的「翻译整页/重新翻译」按钮
   * 任务进行期间防止用户重复点击导致套娃翻译
   */
  setPageControlTranslateDisabled(disabled) {
    if (!this.pageControl) return;
    const restoreBtn = this.pageControlElement('yuxtrans-restore-btn');
    if (!restoreBtn) return;
    restoreBtn.disabled = disabled;
    if (disabled) {
      if (restoreBtn.textContent === '翻译整页') {
        restoreBtn.textContent = '翻译中...';
      }
    } else {
      if (restoreBtn.textContent === '翻译中...') {
        restoreBtn.textContent = '翻译整页';
      }
    }
  }

  showPageControl(total) {
    this.hidePageControl();

    const control = document.createElement('div');
    control.className = 'yuxtrans-page-control';
    control.id = 'yuxtrans-page-control';
    control.innerHTML = `
      <div class="yuxtrans-page-control-progress">
        <div class="yuxtrans-page-control-progress-bar" id="yuxtrans-progress-bar"
          style="width: 0%"></div>
      </div>
      <span class="yuxtrans-page-control-text" id="yuxtrans-progress-text">
        0 / ${total}
      </span>
      <button class="yuxtrans-page-control-btn" id="yuxtrans-cancel-btn">取消</button>
      <button class="yuxtrans-page-control-btn" id="yuxtrans-retry-btn"
        style="display:none">重试失败</button>
      <button class="yuxtrans-page-control-btn" id="yuxtrans-disable-site-btn"
        style="display:none" title="本站禁用扩展">禁用本站</button>
      <button class="yuxtrans-page-control-btn" id="yuxtrans-bilingual-btn"
        style="display:none">双语</button>
      <button class="yuxtrans-page-control-btn primary" id="yuxtrans-restore-btn"
        style="display:none">恢复原文</button>
      <button class="yuxtrans-page-control-btn" id="yuxtrans-close-btn"
        style="display:none">关闭</button>
    `;

    document.body.appendChild(control);
    this.pageControl = control;
    this.pageControlListenersBound = false;

    // 取消按钮
    control.querySelector('#yuxtrans-cancel-btn').addEventListener('click', () => {
      this.pageTranslationState.isTranslating = false;
      this.restoreOriginalTexts();
      this.hidePageControl();
    });
  }

  updatePageControl(current, total, startTime) {
    if (!this.pageControl) return;

    const percent = Math.round((current / total) * 100);
    const bar = this.pageControlElement('yuxtrans-progress-bar');
    const text = this.pageControlElement('yuxtrans-progress-text');

    if (bar) bar.style.width = `${percent}%`;
    if (text) text.textContent = `${current} / ${total} · ${percent}%`;
  }

  showPageControlComplete(
    successCount, totalCount, elapsed, duplicateCount = 0, failCount = 0
  ) {
    if (!this.pageControl) return;

    const hasFailures = failCount > 0;
    const isBilingual = this.config.bilingualMode !== false;
    const cacheHits = this.pageTranslationState.cacheHits || 0;
    const apiCount = this.pageTranslationState.apiCount || 0;

    const textEl = this.pageControlElement('yuxtrans-progress-text');
    if (textEl) {
      const failureText = hasFailures ? ` · 失败 ${failCount}` : '';
      textEl.textContent = `完成 ${successCount}/${totalCount}${failureText} · 缓存 ${cacheHits} / API ${apiCount}`;
    }

    const bar = this.pageControlElement('yuxtrans-progress-bar');
    if (bar) bar.style.width = '100%';

    // 隐藏取消，显示恢复原文、双语切换、关闭
    const cancelBtn = this.pageControlElement('yuxtrans-cancel-btn');
    const restoreBtn = this.pageControlElement('yuxtrans-restore-btn');
    const bilingualBtn = this.pageControlElement('yuxtrans-bilingual-btn');
    const closeBtn = this.pageControlElement('yuxtrans-close-btn');
    const retryBtn = this.pageControlElement('yuxtrans-retry-btn');
    const disableBtn = this.pageControlElement('yuxtrans-disable-site-btn');

    if (cancelBtn) cancelBtn.style.display = 'none';
    if (restoreBtn) restoreBtn.style.display = 'inline-block';
    if (bilingualBtn) {
      bilingualBtn.style.display = 'inline-block';
      bilingualBtn.textContent = isBilingual ? '仅译文' : '双语';
    }
    if (closeBtn) closeBtn.style.display = 'inline-block';
    if (retryBtn) retryBtn.style.display = hasFailures ? 'inline-block' : 'none';
    if (disableBtn) disableBtn.style.display = 'inline-block';

    // 防止重复绑定
    if (this.pageControlListenersBound) return;
    this.pageControlListenersBound = true;

    // 恢复原文按钮
    if (restoreBtn) {
      restoreBtn.addEventListener('click', () => {
        if (this.pageTranslationState.isTranslated) {
          this.restoreOriginalTexts();
          // 不隐藏控制条，切换到可重新翻译状态
          this.setPageControlRestoredState();
        } else {
          // 已恢复状态下再次点击，触发重新翻译
          this.translatePage();
        }
      });
    }

    // 双语/仅译文切换按钮
    if (bilingualBtn) {
      bilingualBtn.addEventListener('click', () => {
        const newMode = this.config.bilingualMode === false;
        this.toggleBilingualMode(newMode);
        bilingualBtn.textContent = newMode ? '仅译文' : '双语';
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.retryFailedPageItems());
    }

    if (disableBtn) {
      disableBtn.addEventListener('click', () => this.disableCurrentSite());
    }

    // 关闭按钮
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.hidePageControl();
      });
    }
  }

  /**
   * 重试整页翻译中失败的节点
   */
  async retryFailedPageItems() {
    const failed = this.pageTranslationState.failedItems || [];
    if (failed.length === 0 || this.pageTranslationState.isTranslating) return;

    this.pageTranslationState.isTranslating = true;
    this.setPageControlTranslateDisabled(true);
    const retryBtn = this.pageControlElement('yuxtrans-retry-btn');
    if (retryBtn) {
      retryBtn.disabled = true;
      retryBtn.textContent = '重试中...';
    }

    const remaining = [];
    try {
      for (const item of failed) {
        try {
          const response = await chrome.runtime.sendMessage({
            action: 'translate',
            text: item.text,
            sourceLang: this.config.sourceLang || 'auto',
            targetLang: this.config.targetLang || 'zh',
            context: null
          });
          if (response && response.success) {
            // 清除失败标记后应用译文
            const parent = item.nodeInfo?.node?.parentElement;
            if (parent) parent.classList.remove('yuxtrans-failed');
            this.applyTranslation(item.nodeInfo, response.text);
            if (response.cached) this.pageTranslationState.cacheHits++;
            else this.pageTranslationState.apiCount++;
          } else {
            remaining.push(item);
          }
        } catch (e) {
          remaining.push(item);
        }
      }
      this.pageTranslationState.failedItems = remaining;
      const textEl = this.pageControlElement('yuxtrans-progress-text');
      if (textEl) {
        textEl.textContent = remaining.length
          ? `仍有 ${remaining.length} 条失败 · 缓存 ${this.pageTranslationState.cacheHits} / API ${this.pageTranslationState.apiCount}`
          : `重试完成 · 缓存 ${this.pageTranslationState.cacheHits} / API ${this.pageTranslationState.apiCount}`;
      }
      if (retryBtn) {
        retryBtn.style.display = remaining.length ? 'inline-block' : 'none';
        retryBtn.textContent = '重试失败';
        retryBtn.disabled = false;
      }
    } finally {
      this.pageTranslationState.isTranslating = false;
      this.setPageControlTranslateDisabled(false);
    }
  }

  /**
   * 本站禁用扩展（写入黑名单）
   */
  async disableCurrentSite() {
    const hostname = location.hostname;
    if (!hostname) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'disableSite', hostname });
      if (res?.success) {
        this.config.siteRule = res.siteRule || 'blacklist';
        this.config.siteList = res.siteList || [];
        this.restoreOriginalTexts();
        this.hidePageControl();
        // 简短提示
        const tip = document.createElement('div');
        tip.className = 'yuxtrans-page-control';
        tip.textContent = `已禁用本站（${hostname}）`;
        document.body.appendChild(tip);
        setTimeout(() => tip.remove(), 2500);
      }
    } catch (e) {
      console.warn('[YuxTrans] 禁用本站失败:', e);
    }
  }

  /**
   * 将控制条切换到「已恢复原文 / 可重新翻译」状态
   */
  setPageControlRestoredState() {
    if (!this.pageControl) return;

    const textEl = this.pageControlElement('yuxtrans-progress-text');
    const bar = this.pageControlElement('yuxtrans-progress-bar');
    const bilingualBtn = this.pageControlElement('yuxtrans-bilingual-btn');
    const restoreBtn = this.pageControlElement('yuxtrans-restore-btn');
    const closeBtn = this.pageControlElement('yuxtrans-close-btn');

    if (textEl) textEl.textContent = '已恢复原文';
    if (bar) bar.style.width = '0%';
    if (bilingualBtn) bilingualBtn.style.display = 'none';
    if (closeBtn) closeBtn.style.display = 'inline-block';
    if (restoreBtn) {
      restoreBtn.textContent = '翻译整页';
      restoreBtn.classList.remove('primary');
    }
    // 如果此时仍有任务在跑，保持按钮禁用；否则确保可点击
    this.setPageControlTranslateDisabled(this.pageTranslationState.isTranslating);
  }

  /**
   * 核心逻辑：动态切换双语对照与纯译文模式
   */
  toggleBilingualMode(isBilingual) {
    this.config.bilingualMode = isBilingual;

    // 记住当前站点偏好
    const hostname = (location.hostname || '').toLowerCase();
    if (hostname) {
      chrome.runtime.sendMessage({
        action: 'setSiteBilingualMode',
        hostname,
        bilingualMode: isBilingual
      }).catch(() => {});
      if (!this.config.siteModePrefs) this.config.siteModePrefs = {};
      this.config.siteModePrefs[hostname] = { bilingualMode: isBilingual };
    }

    for (const [node, data] of this.pageTranslationState.originalTexts) {
      const parent = node.parentElement;
      if (!parent) continue;

      if (isBilingual) {
        if (!data.bilingualNode) {
          node.textContent = data.text;
          const span = document.createElement('span');
          span.className = 'yuxtrans-bilingual-text';
          span.textContent = data.translated;
          if (node.nextSibling) parent.insertBefore(span, node.nextSibling);
          else parent.appendChild(span);
          data.bilingualNode = span;
        }
        parent.classList.remove('yuxtrans-translated');
        parent.classList.add('yuxtrans-translated-bilingual');
      } else {
        if (data.bilingualNode) {
          if (data.bilingualNode.parentNode === parent) {
            parent.removeChild(data.bilingualNode);
          }
          data.bilingualNode = null;
        }
        node.textContent = data.translated;
        parent.classList.remove('yuxtrans-translated-bilingual');
        parent.classList.add('yuxtrans-translated');
      }
    }
  }

  restoreOriginalTexts() {
    // 清理流式翻译中的临时节点
    if (this.pageTranslationState.streamingNodes) {
      for (const state of this.pageTranslationState.streamingNodes.values()) {
        if (state.tempSpan && state.tempSpan.parentNode) {
          state.tempSpan.remove();
        }
      }
      this.pageTranslationState.streamingNodes.clear();
    }

    // 恢复所有原文和样式
    for (const [node, originalData] of this.pageTranslationState.originalTexts) {
      const parent = node.parentElement;
      if (parent) {
        if (originalData.bilingualNode && originalData.bilingualNode.parentNode === parent) {
          // 清理双语节点
          parent.removeChild(originalData.bilingualNode);
        }
        // 无论是否双语，都恢复原文文本并清除翻译标记
        node.textContent = originalData.text;
        parent.classList.remove('yuxtrans-translated', 'yuxtrans-translated-bilingual');

        // 清除添加的内联样式
        if (originalData.styles) {
          parent.style.removeProperty('font-weight');
          parent.style.removeProperty('font-style');
        }

        // 清理翻译失败标记样式
        parent.classList.remove('yuxtrans-failed');
      }
    }

    // 重置状态
    this.pageTranslationState.originalTexts.clear();
    this.pageTranslationState.translatedNodes = [];
    this.pageTranslationState.isTranslated = false;
  }

  /**
   * 输出整页翻译结构化性能指标，便于真实浏览器环境验证优化效果。
   * 数据会同时打印到内容脚本控制台，用户可复制粘贴给开发侧分析。
   */
  logPageMetrics(metrics) {
    const report = {
      event: 'YuxTrans.pageTranslation.complete',
      timestamp: new Date().toISOString(),
      ...metrics
    };
    console.log('[YuxTrans] 整页翻译完成:', report);
  }

  hidePageControl() {
    if (this.pageControl) {
      this.pageControl.remove();
      this.pageControl = null;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

new YuxTransContent();