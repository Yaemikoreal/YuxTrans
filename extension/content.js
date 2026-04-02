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
      /* 毛玻璃翻译弹窗 */
      .yuxtrans-popup {
        position: fixed;
        z-index: 2147483647;
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        max-width: 400px;
        min-width: 200px;
        overflow: hidden;
        animation: yuxtrans-fadeIn 0.2s ease-out;
      }

      @keyframes yuxtrans-fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* 深色模式 */
      @media (prefers-color-scheme: dark) {
        .yuxtrans-popup {
          background: rgba(30, 30, 30, 0.85);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #fff;
        }
        .yuxtrans-popup-header {
          background: rgba(50, 50, 50, 0.6);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .yuxtrans-popup-title { color: #fff; }
        .yuxtrans-popup-close { color: #aaa; }
        .yuxtrans-popup-close:hover { color: #fff; }
        .yuxtrans-source { color: #aaa; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
        .yuxtrans-target { color: #f0f0f0; }
        .yuxtrans-popup-footer {
          background: rgba(50, 50, 50, 0.6);
          border-top: 1px solid rgba(255, 255, 255, 0.1);
        }
        .yuxtrans-btn-secondary {
          background: rgba(80, 80, 80, 0.8);
          color: #fff;
        }
        .yuxtrans-btn-secondary:hover { background: rgba(100, 100, 100, 0.9); }
      }

      .yuxtrans-popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: rgba(248, 249, 250, 0.6);
        border-bottom: 1px solid rgba(0, 0, 0, 0.05);
      }

      .yuxtrans-popup-title {
        font-weight: 600;
        font-size: 15px;
        color: #333;
      }

      .yuxtrans-popup-close {
        background: none;
        border: none;
        font-size: 20px;
        color: #999;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: all 0.2s;
      }

      .yuxtrans-popup-close:hover {
        color: #333;
        background: rgba(0, 0, 0, 0.05);
      }

      .yuxtrans-popup-content {
        padding: 16px;
      }

      .yuxtrans-source {
        color: #666;
        font-size: 13px;
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(0, 0, 0, 0.08);
        line-height: 1.5;
      }

      .yuxtrans-target {
        color: #333;
        line-height: 1.7;
        font-size: 15px;
      }

      .yuxtrans-popup-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        background: rgba(248, 249, 250, 0.5);
        border-top: 1px solid rgba(0, 0, 0, 0.05);
        font-size: 12px;
        color: #888;
      }

      .yuxtrans-popup-actions {
        display: flex;
        gap: 8px;
      }

      .yuxtrans-btn {
        background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
        font-weight: 500;
      }

      .yuxtrans-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(52, 152, 219, 0.3);
      }

      .yuxtrans-btn-secondary {
        background: rgba(236, 240, 241, 0.8);
        color: #333;
      }

      .yuxtrans-btn-secondary:hover {
        background: rgba(189, 195, 199, 0.9);
        box-shadow: none;
      }

      .yuxtrans-loading {
        display: flex;
        align-items: center;
        gap: 10px;
        color: #888;
      }

      .yuxtrans-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(0, 0, 0, 0.1);
        border-top-color: #3498db;
        border-radius: 50%;
        animation: yuxtrans-spin 0.8s linear infinite;
      }

      @keyframes yuxtrans-spin {
        to { transform: rotate(360deg); }
      }

      .yuxtrans-float-btn {
        position: absolute;
        z-index: 2147483646;
        background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(52, 152, 219, 0.3);
        transition: all 0.2s;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      .yuxtrans-float-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(52, 152, 219, 0.4);
      }

      /* 已翻译文本标记 - 保持原有样式 */
      .yuxtrans-translated {
        background-color: rgba(212, 237, 218, 0.3);
        transition: background-color 0.3s;
      }

      .yuxtrans-translated:hover {
        background-color: rgba(212, 237, 218, 0.5);
      }

      /* 翻译进度指示器 */
      .yuxtrans-progress {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 12px;
        padding: 16px 20px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        min-width: 240px;
        animation: yuxtrans-fadeIn 0.2s ease-out;
      }

      @media (prefers-color-scheme: dark) {
        .yuxtrans-progress {
          background: rgba(30, 30, 30, 0.95);
          border-color: rgba(255, 255, 255, 0.1);
          color: #f0f0f0;
        }
        .yuxtrans-progress-title { color: #f0f0f0; }
        .yuxtrans-progress-bar-bg { background: rgba(255, 255, 255, 0.1); }
      }

      .yuxtrans-progress-title {
        font-size: 14px;
        font-weight: 600;
        color: #333;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .yuxtrans-progress-bar-bg {
        width: 100%;
        height: 6px;
        background: rgba(0, 0, 0, 0.1);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 10px;
      }

      .yuxtrans-progress-bar {
        height: 100%;
        background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
        border-radius: 3px;
        transition: width 0.2s ease;
      }

      .yuxtrans-progress-text {
        font-size: 12px;
        color: #888;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .yuxtrans-progress-actions {
        margin-top: 12px;
        display: flex;
        gap: 8px;
      }

      .yuxtrans-progress-btn {
        flex: 1;
        padding: 8px 12px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }

      .yuxtrans-progress-btn.primary {
        background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
        color: white;
      }

      .yuxtrans-progress-btn.secondary {
        background: rgba(236, 240, 241, 0.8);
        color: #555;
      }

      .yuxtrans-progress-btn:hover {
        transform: translateY(-1px);
      }

      .yuxtrans-progress-speed {
        font-size: 11px;
        color: #aaa;
        margin-top: 6px;
      }
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
      }
      return true;
    });
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

    chrome.runtime.sendMessage(
      { action: 'translate', text, sourceLang: 'auto', targetLang: 'zh' },
      (response) => {
        this.isTranslating = false;

        if (response && response.success) {
          this.updatePopup(response.text, response.cached, response.engine);
        } else {
          this.updatePopup('翻译失败: ' + (response?.error || '未知错误'), false, 'error');
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

    this.popup.querySelector('.yuxtrans-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(translatedText);
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
    const { concurrency } = this.config;
    const results = new Array(items.length);
    let completed = 0;

    // 创建任务队列
    const queue = [...items.keys()];

    // 工作函数
    const worker = async () => {
      while (queue.length > 0 && this.pageTranslationState.isTranslating) {
        const index = queue.shift();
        const item = items[index];

        try {
          const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                action: 'translate',
                text: item.text,
                sourceLang: this.config.sourceLang || 'auto',
                targetLang: this.config.targetLang || 'zh'
              },
              resolve
            );
          });

          if (response && response.success) {
            results[index] = {
              success: true,
              translated: response.text,
              cached: response.cached
            };
          } else {
            results[index] = { success: false, error: response?.error };
          }
        } catch (error) {
          results[index] = { success: false, error: error.message };
        }

        completed++;
        if (onProgress) {
          onProgress(completed, items.length);
        }
      }
    };

    // 启动多个工作线程
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
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

    // 保存原文和样式
    const originalData = {
      text: node.textContent,
      styles: this.getElementStyles(parent)
    };
    this.pageTranslationState.originalTexts.set(node, originalData);

    // 应用翻译
    node.textContent = translatedText;

    // 标记已翻译
    parent.classList.add('yuxtrans-translated');

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

    // 显示进度指示器
    this.showProgressIndicator(nodesInfo.length);
    const startTime = Date.now();

    // 并行翻译
    const results = await this.translateBatchParallel(
      nodesInfo,
      (completed, total) => {
        this.updateProgressIndicator(completed, total, startTime);
      }
    );

    // 应用翻译结果
    let successCount = 0;
    for (let i = 0; i < nodesInfo.length; i++) {
      const result = results[i];
      if (result && result.success) {
        if (this.applyTranslation(nodesInfo[i], result.translated)) {
          successCount++;
        }
      }
    }

    // 翻译完成
    this.pageTranslationState.isTranslated = true;
    this.pageTranslationState.isTranslating = false;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.showProgressComplete(successCount, nodesInfo.length, elapsed);
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

  showProgressComplete(successCount, totalCount, elapsed) {
    if (!this.progressIndicator) return;

    this.progressIndicator.innerHTML = `
      <div class="yuxtrans-progress-title">
        <span style="color: #27ae60;">✓</span>
        <span>翻译完成</span>
      </div>
      <div class="yuxtrans-progress-text">
        <span>成功翻译 ${successCount} / ${totalCount} 段</span>
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
        node.textContent = originalData.text;
        parent.classList.remove('yuxtrans-translated');

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