/**
 * Content Script
 * 处理页面内翻译、划词翻译、整页翻译
 * 支持并行翻译、样式保持、可视区域优先
 */

class YuxTransContent {
  constructor() {
    this.popup = null;
    this.isTranslating = false;
    this.pageTranslationState = {
      isTranslated: false,
      originalTexts: new Map(), // node -> { text, styles }
      translatedNodes: []
    };
    this.progressIndicator = null;
    this.config = {
      concurrency: 5, // 并发请求数
      batchSize: 10,  // 批量大小
      minTextLength: 2, // 最小翻译文本长度
      preserveStyles: true // 保持样式
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
        this.config.sourceLang = response.sourceLang || 'auto';
        this.config.targetLang = response.targetLang || 'zh';
      }
    } catch (e) {
      // 使用默认配置
    }
  }

  createStyles() {
    if (document.getElementById('yuxtrans-styles')) return;

    const style = document.createElement('style');
    style.id = 'yuxtrans-styles';
    style.textContent = `
      /* =========================================
         YuxTrans 划词翻译全局样式 - 黄铜纸本风格
         ========================================= */
      
      .yuxtrans-popup {
        position: fixed;
        z-index: 2147483647;
        background: #fdfbf7;
        background-image: radial-gradient(circle at 50% 50%, #fefcf9 0%, #f2ede4 100%);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(61, 55, 51, 0.1);
        border-radius: 20px;
        box-shadow: 0 16px 40px rgba(61, 55, 51, 0.15);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        font-size: 14px;
        max-width: 420px;
        min-width: 280px;
        color: #3d3733;
        overflow: hidden;
        animation: yuxtrans-slideIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      @keyframes yuxtrans-slideIn {
        from { opacity: 0; transform: translateY(12px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      /* 深色模式：深夜书房 */
      @media (prefers-color-scheme: dark) {
        .yuxtrans-popup {
          background: #1a1817;
          background-image: radial-gradient(circle at 50% 0%, #2a2725 0%, #151312 100%);
          border-color: rgba(244, 240, 230, 0.1);
          color: #e6e0d8;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
        }
        .yuxtrans-popup-header { background: rgba(0,0,0,0.2); border-color: rgba(255,255,255,0.05); }
        .yuxtrans-popup-title { color: #d8a051 !important; }
        .yuxtrans-source { color: #9e958a; border-color: rgba(255,255,255,0.05); }
        .yuxtrans-target { color: #f4f0e6; }
        .yuxtrans-popup-footer { background: rgba(0,0,0,0.2); border-color: rgba(255,255,255,0.05); }
        .yuxtrans-btn-secondary { background: rgba(255,255,255,0.05); color: #e6e0d8; }
      }

      .yuxtrans-popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        background: rgba(140, 130, 121, 0.03);
        border-bottom: 1px solid rgba(61, 55, 51, 0.05);
      }

      .yuxtrans-popup-title {
        font-weight: 800;
        font-size: 14px;
        color: #d8a051;
        letter-spacing: -0.2px;
        text-transform: uppercase;
      }

      .yuxtrans-popup-close {
        background: none;
        border: none;
        font-size: 18px;
        color: #8c8279;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        transition: all 0.2s;
      }

      .yuxtrans-popup-close:hover {
        background: rgba(61, 55, 51, 0.08);
        color: #3d3733;
      }

      .yuxtrans-popup-content {
        padding: 20px;
      }

      .yuxtrans-source {
        color: #8c8279;
        font-size: 13px;
        margin-bottom: 16px;
        padding-bottom: 16px;
        border-bottom: 1px solid rgba(61, 55, 51, 0.06);
        line-height: 1.6;
        font-style: italic;
      }

      .yuxtrans-target {
        color: #3d3733;
        line-height: 1.8;
        font-size: 15px;
        font-weight: 500;
      }

      .yuxtrans-popup-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 18px;
        background: rgba(140, 130, 121, 0.03);
        border-top: 1px solid rgba(61, 55, 51, 0.05);
        font-size: 11px;
        font-weight: 600;
        color: #8c8279;
      }

      .yuxtrans-btn {
        background: linear-gradient(135deg, #dfab66 0%, #d19747 100%);
        color: white;
        border: none;
        border-radius: 10px;
        padding: 8px 16px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
        font-weight: 700;
        box-shadow: 0 4px 12px rgba(216, 160, 81, 0.2);
      }

      .yuxtrans-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(216, 160, 81, 0.3);
      }

      .yuxtrans-btn-secondary {
        background: rgba(140, 130, 121, 0.08);
        color: #3d3733;
        box-shadow: none;
      }

      .yuxtrans-loading {
        display: flex;
        align-items: center;
        gap: 10px;
        color: #d8a051;
        font-weight: 600;
      }

      .yuxtrans-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(216, 160, 81, 0.15);
        border-top-color: #d8a051;
        border-radius: 50%;
        animation: yuxtrans-spin 0.8s linear infinite;
      }

      @keyframes yuxtrans-spin {
        to { transform: rotate(360deg); }
      }

      /* =========================================
         划词翻译浮动按钮 - 黄铜宝石质感
         ========================================= */
      
      .yuxtrans-float-btn {
        position: absolute;
        z-index: 2147483646;
        background: linear-gradient(135deg, #dfab66 0%, #d19747 100%);
        color: white;
        border: none;
        border-radius: 12px;
        padding: 9px 18px;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(216, 160, 81, 0.3);
        transition: all 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.2);
      }

      .yuxtrans-float-btn:hover {
        transform: translateY(-4px) scale(1.05);
        box-shadow: 0 12px 32px rgba(216, 160, 81, 0.45);
      }

      .yuxtrans-float-btn:active {
        transform: translateY(-1px) scale(0.96);
      }

      /* 进度条指示器同步 */
      .yuxtrans-progress {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        background: #fdfbf7;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(61, 55, 51, 0.1);
        border-radius: 16px;
        padding: 16px 20px;
        box-shadow: 0 12px 32px rgba(61, 55, 51, 0.15);
        font-family: inherit;
        min-width: 260px;
      }
      .yuxtrans-progress-bar-bg {
        width: 100%; height: 6px; background: rgba(0,0,0,0.05); border-radius: 3px; margin-bottom: 10px; overflow: hidden;
      }
      .yuxtrans-progress-bar {
        height: 100%; background: linear-gradient(135deg, #dfab66 0%, #d19747 100%); transition: width 0.3s ease;
      }
      .yuxtrans-progress-text { font-size: 12px; color: #8c8279; display: flex; justify-content: space-between; }
    `;
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
      } else if (request.action === 'translatePage') {
        this.translatePage();
      } else if (request.action === 'streamChunk') {
        // 流式输出：逐字更新弹窗
        this.handleStreamChunk(request.chunk, request.fullText);
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
   */
  handleStreamChunk(chunk, fullText) {
    if (!this.popup) return;
    const targetEl = this.popup.querySelector('.yuxtrans-target');
    if (targetEl) {
      targetEl.textContent = fullText;
    }
  }

  handleMouseUp(e) {
    if (e.target.closest('.yuxtrans-popup')) return;

    setTimeout(() => {
      const selection = window.getSelection().toString().trim();
      if (selection && selection.length > 0) {
        this.showFloatButton(e.clientX, e.clientY, selection);
      } else {
        this.hideFloatButton();
      }
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
    btn.style.left = `${x + 10}px`;
    btn.style.top = `${y + 10}px`;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.translateText(text, x, y);
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

    // 使用流式输出：逐字显示翻译结果
    chrome.runtime.sendMessage(
      {
        action: 'translateStream',
        text,
        sourceLang,
        targetLang,
        context
      },
      (response) => {
        this.isTranslating = false;

        if (response && response.success) {
          this.updatePopup(response.text, response.cached, response.engine);
        } else {
          const errorMsg = response?.error || '未知错误';
          if (errorMsg.includes('API Key') || errorMsg.includes('请先配置')) {
            this.updatePopup('⚠️ 请先在设置中配置 API Key\n\n点击右上角设置图标进行配置', false, 'warning');
          } else {
            this.updatePopup('翻译失败: ' + errorMsg, false, 'error');
          }
        }
      }
    );
  }

  showPopup(x, y, sourceText) {
    this.hidePopup();

    const popup = document.createElement('div');
    popup.className = 'yuxtrans-popup';
    popup.innerHTML = `
      <div class="yuxtrans-popup-header">
        <span class="yuxtrans-popup-title">YuxTrans</span>
        <button class="yuxtrans-popup-close">&times;</button>
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
        <span class="yuxtrans-status"></span>
        <div class="yuxtrans-popup-actions">
          <button class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-copy-btn">复制</button>
        </div>
      </div>
    `;

    const maxX = window.innerWidth - 420;
    const maxY = window.innerHeight - 300;
    popup.style.left = `${Math.min(x, maxX)}px`;
    popup.style.top = `${Math.min(y, maxY)}px`;

    popup.querySelector('.yuxtrans-popup-close').addEventListener('click', () => {
      this.hidePopup();
    });

    document.body.appendChild(popup);
    this.popup = popup;
  }

  updatePopup(translatedText, cached, engine) {
    if (!this.popup) return;

    const targetEl = this.popup.querySelector('.yuxtrans-target');
    targetEl.textContent = translatedText;

    const statusEl = this.popup.querySelector('.yuxtrans-status');
    const statusText = cached ? '缓存' : engine;
    statusEl.textContent = statusText;

    this.popup.querySelector('.yuxtrans-copy-btn').addEventListener('click', async () => {
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
      statusEl.textContent = '已复制';
      setTimeout(() => {
        statusEl.textContent = statusText;
      }, 2000);
    });
  }

  hidePopup() {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
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
          if (parent.closest('script, style, noscript, iframe, canvas, svg, code, pre, .yuxtrans-progress, .yuxtrans-popup, [contenteditable="true"]')) {
            return NodeFilter.FILTER_REJECT;
          }

          // 排除输入元素
          if (parent.closest('input, textarea, select')) {
            return NodeFilter.FILTER_REJECT;
          }

          // 排除已翻译节点
          if (parent.classList.contains('yuxtrans-translated')) {
            return NodeFilter.FILTER_REJECT;
          }

          // 最小文本长度
          const text = node.textContent.trim();
          if (text.length < this.config.minTextLength) {
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
   */
  async translateBatchParallel(items, onProgress) {
    const { concurrency } = this.config || { concurrency: 5 };
    const BATCH_SIZE = 10;
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

    const worker = async () => {
      while (queue.length > 0 && this.pageTranslationState.isTranslating) {
        const batchIndex = queue.shift();
        const batch = batches[batchIndex];
        const texts = batch.nodes.map(item => item.text);

        try {
          const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                action: 'translateBatch',
                texts: texts,
                sourceLang: this.config.sourceLang || 'auto',
                targetLang: this.config.targetLang || 'zh',
                context: this.getPageContext()
              },
              resolve
            );
          });

          if (response && response.success && response.results) {
            response.results.forEach((res, localIdx) => {
              const globalIdx = batch.indices[localIdx];
              if (res && res.success) {
                results[globalIdx] = { success: true, translated: res.text, cached: res.cached };
              } else {
                results[globalIdx] = { success: false, error: res?.error };
              }
            });
          } else {
            batch.indices.forEach(globalIdx => {
              results[globalIdx] = { success: false, error: response?.error || 'Batch failed' };
            });
          }
        } catch (error) {
           batch.indices.forEach(globalIdx => {
              results[globalIdx] = { success: false, error: error.message };
           });
        }

        completed += batch.nodes.length;
        if (onProgress) {
          onProgress(completed, items.length);
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
    const parent = node.parentElement;

    if (!parent) return false;

    // 保存原文、样式和双语节点引用
    const originalData = {
      text: node.textContent,
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
      bilingualSpan.textContent = `  ${translatedText}`;
      
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
   * 整页翻译主函数
   */
  async translatePage() {
    // 如果已翻译，恢复原文
    if (this.pageTranslationState.isTranslated) {
      this.restoreOriginalTexts();
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

    // ===== 文本去重优化 =====
    const uniqueTexts = new Map(); // text -> { indices: [], translation: null }
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
        uniqueTexts.set(text, { indices: [index], translation: null });
        dedupedItems.push({ text, originalIndex: index });
      }
    });

    // 显示进度指示器（显示去重后的数量）
    const displayTotal = nodesInfo.length;
    this.showProgressIndicator(displayTotal);
    const startTime = Date.now();

    // 并行翻译（只翻译去重后的文本）
    const results = await this.translateBatchParallel(
      dedupedItems,
      (completed, total) => {
        // 进度修正：用去重后的实际完成数，按比例映射到总节点数
        const ratio = dedupedItems.length > 0 ? nodesInfo.length / dedupedItems.length : 1;
        const actualCompleted = Math.min(Math.round(completed * ratio), nodesInfo.length);
        this.updateProgressIndicator(actualCompleted, displayTotal, startTime);
      }
    );

    // 构建翻译结果映射
    const translationMap = new Map();
    dedupedItems.forEach((item, i) => {
      const result = results[i];
      if (result && result.success) {
        translationMap.set(item.text, result.translated);
      }
    });

    // 应用翻译结果（包括重复文本）
    let successCount = 0;
    for (let i = 0; i < nodesInfo.length; i++) {
      const nodeInfo = nodesInfo[i];
      const translated = translationMap.get(nodeInfo.text);
      if (translated) {
        if (this.applyTranslation(nodeInfo, translated)) {
          successCount++;
        }
      }
    }

    // 翻译完成
    this.pageTranslationState.isTranslated = true;
    this.pageTranslationState.isTranslating = false;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const savedPercent = dedupedItems.length > 0
      ? Math.round((1 - dedupedItems.length / nodesInfo.length) * 100)
      : 0;
    this.showProgressComplete(successCount, nodesInfo.length, elapsed, duplicateCount);
  }

  showProgressIndicator(total) {
    this.hideProgressIndicator();

    const progress = document.createElement('div');
    progress.className = 'yuxtrans-progress';
    progress.innerHTML = `
      <div class="yuxtrans-progress-title">
        <div class="yuxtrans-spinner"></div>
        <span>正在翻译页面...</span>
      </div>
      <div class="yuxtrans-progress-bar-bg">
        <div class="yuxtrans-progress-bar" style="width: 0%"></div>
      </div>
      <div class="yuxtrans-progress-text">
        <span class="yuxtrans-progress-count">0 / ${total} 段</span>
        <span class="yuxtrans-progress-percent">0%</span>
      </div>
      <div class="yuxtrans-progress-speed">预计时间: 计算中...</div>
      <div class="yuxtrans-progress-actions">
        <button class="yuxtrans-progress-btn secondary" id="yuxtrans-cancel-btn">取消翻译</button>
      </div>
    `;

    document.body.appendChild(progress);
    this.progressIndicator = progress;

    // 取消按钮
    progress.querySelector('#yuxtrans-cancel-btn').addEventListener('click', () => {
      this.pageTranslationState.isTranslating = false;
      this.restoreOriginalTexts();
      this.hideProgressIndicator();
    });
  }

  updateProgressIndicator(current, total, startTime) {
    if (!this.progressIndicator) return;

    const percent = Math.round((current / total) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const speed = current / elapsed;
    const remaining = speed > 0 ? ((total - current) / speed).toFixed(0) : '--';

    const bar = this.progressIndicator.querySelector('.yuxtrans-progress-bar');
    const count = this.progressIndicator.querySelector('.yuxtrans-progress-count');
    const percentEl = this.progressIndicator.querySelector('.yuxtrans-progress-percent');
    const speedEl = this.progressIndicator.querySelector('.yuxtrans-progress-speed');

    if (bar) bar.style.width = `${percent}%`;
    if (count) count.textContent = `${current} / ${total} 段`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (speedEl) speedEl.textContent = `速度: ${speed.toFixed(1)} 段/秒 · 预计剩余: ${remaining}秒`;
  }

  showProgressComplete(successCount, totalCount, elapsed, duplicateCount = 0) {
    if (!this.progressIndicator) return;

    const savedInfo = duplicateCount > 0
      ? `<br><span style="color: #27ae60;">去重节省 ${duplicateCount} 次 API 调用</span>`
      : '';

    this.progressIndicator.innerHTML = `
      <div class="yuxtrans-progress-title">
        <span style="color: #27ae60;">✓</span>
        <span>翻译完成</span>
      </div>
      <div class="yuxtrans-progress-text">
        <span>成功翻译 ${successCount} / ${totalCount} 段${savedInfo}</span>
      </div>
      <div class="yuxtrans-progress-speed">耗时: ${elapsed} 秒</div>
      <div class="yuxtrans-progress-actions">
        <button class="yuxtrans-progress-btn primary" id="yuxtrans-restore-btn">恢复原文</button>
        <button class="yuxtrans-progress-btn secondary" id="yuxtrans-close-btn">关闭</button>
      </div>
    `;

    // 恢复原文按钮
    this.progressIndicator.querySelector('#yuxtrans-restore-btn').addEventListener('click', () => {
      this.restoreOriginalTexts();
      this.hideProgressIndicator();
    });

    // 关闭按钮
    this.progressIndicator.querySelector('#yuxtrans-close-btn').addEventListener('click', () => {
      this.hideProgressIndicator();
    });

    // 5秒后自动关闭
    setTimeout(() => {
      this.hideProgressIndicator();
    }, 5000);
  }

  restoreOriginalTexts() {
    // 恢复所有原文和样式
    for (const [node, originalData] of this.pageTranslationState.originalTexts) {
      const parent = node.parentElement;
      if (parent) {
        if (originalData.bilingualNode && originalData.bilingualNode.parentNode === parent) {
          // 清理双语接点
          parent.removeChild(originalData.bilingualNode);
          parent.classList.remove('yuxtrans-translated-bilingual');
        } else {
          // 恢复替换的文本
          node.textContent = originalData.text;
          parent.classList.remove('yuxtrans-translated');
        }

        // 清除添加的内联样式
        if (originalData.styles) {
          parent.style.removeProperty('font-weight');
          parent.style.removeProperty('font-style');
        }
      }
    }

    // 重置状态
    this.pageTranslationState.originalTexts.clear();
    this.pageTranslationState.translatedNodes = [];
    this.pageTranslationState.isTranslated = false;
  }

  hideProgressIndicator() {
    if (this.progressIndicator) {
      this.progressIndicator.remove();
      this.progressIndicator = null;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

new YuxTransContent();