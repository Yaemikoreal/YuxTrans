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
      cancelRequested: false, // 用户取消整页/动态翻译：阻止 worker 发起新批次
      originalTexts: new Map(), // node -> { text, styles }
      translatedNodes: [],
      streamingNodes: new Map(), // requestId -> { nodeInfo, tempSpan }
      failedItems: [], // 失败节点，供重试
      cacheHits: 0,
      apiCount: 0
    };
    this._dynamicObserver = null;
    this._addedDebounceTimer = null;
    this._isProcessingAdded = false;
    this._pageSessionId = null; // 当前整页/动态翻译会话 id，用于 SW 侧取消
    this._pageSessionCounter = 0;
    this._viewportObserver = null; // belowFold 视口感知：入视口才提交翻译
    this._viewportCleanup = null; // belowFold 取消回调（放弃未提交项）
    // F1 悬停段落翻译状态
    this._hoverTarget = null; // 当前悬停描边的段落元素
    this._hoverTimer = null; // 300ms 延迟翻译定时器
    this._hoverThrottleTimer = null; // mousemove 节流定时器
    this._lastInputElement = null; // F5：触发翻译的输入框元素（供"插入译文"使用）
    this.pinnedPopups = []; // F4：已 pin 的浮窗列表（不被新划词覆盖，用于结果对照）
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
   * F1：mousemove 节流处理（120ms），按修饰键检测悬停段落
   */
  _handleHoverMouseMove(e) {
    if (!this.config.hoverTranslate) return;
    const modifierKey = this.config.hoverModifier === 'ctrl' ? 'ctrlKey' : 'altKey';
    if (!e[modifierKey]) {
      // 修饰键未按下：清理描边与定时器
      if (this._hoverTarget || this._hoverTimer) this._cancelHover();
      return;
    }
    // 节流：120ms 内只处理一次
    if (this._hoverThrottleTimer) return;
    const target = e.target;
    this._hoverThrottleTimer = setTimeout(() => {
      this._hoverThrottleTimer = null;
      this._resolveHoverTarget(target);
    }, 120);
  }

  /**
   * F1：解析当前悬停目标段落，描边并启动 300ms 延迟翻译
   */
  _resolveHoverTarget(target) {
    const para = this._resolveHoverParagraph(target);
    if (para === this._hoverTarget) return; // 同一元素，无需变化
    if (this._hoverTarget) this._hoverTarget.classList.remove('yuxtrans-hover-target');
    if (this._hoverTimer) { clearTimeout(this._hoverTimer); this._hoverTimer = null; }
    this._hoverTarget = para;
    if (!para) return;
    para.classList.add('yuxtrans-hover-target');
    this._hoverTimer = setTimeout(() => this._translateHoverParagraph(para), 300);
  }

  /**
   * F1：自 target 向上找最近块级段落元素，并用 helpers 判定是否为候选
   * 判定纯逻辑走 helpers.isHoverParagraphCandidate（未就绪时三元兜底内联）
   */
  _resolveHoverParagraph(target) {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return null;
    const blockTags = ['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'DD', 'DT', 'FIGCAPTION'];
    let el = target;
    while (el && el !== document.body && !blockTags.includes(el.tagName)) {
      el = el.parentElement;
    }
    if (!el || el === document.body) return null;
    // 排除：代码块、输入框、自身 UI、已 hover 翻译过、整页双语已覆盖
    const inExcluded = !!(el.closest(
      'pre, code, input, textarea, [contenteditable="true"], ' +
      '.yuxtrans-popup, .yuxtrans-float-btn, .yuxtrans-page-control, ' +
      '.yuxtrans-hover-translation, .yuxtrans-dict'
    ));
    const alreadyDone = el.dataset.yxtHoverDone === '1' ||
      el.classList.contains('yuxtrans-translated') ||
      el.classList.contains('yuxtrans-translated-bilingual');
    const text = (el.textContent || '').trim();
    const isCandidate = this.helpers.isHoverParagraphCandidate
      ? this.helpers.isHoverParagraphCandidate({
          tagName: el.tagName, textLen: text.length, inExcluded, alreadyDone
        })
      : (!inExcluded && !alreadyDone && text.length >= 3 && text.length <= 1500);
    return isCandidate ? el : null;
  }

  /**
   * F1：翻译悬停段落，在段落后插入译文块（v1 非流式，机制预留流式升级）
   */
  _translateHoverParagraph(el) {
    if (el.dataset.yxtHoverDone === '1') return;
    el.dataset.yxtHoverDone = '1';
    el.classList.remove('yuxtrans-hover-target');
    this._hoverTarget = null;
    this._hoverTimer = null;

    const text = (el.textContent || '').trim();
    if (!text) return;

    // 译文块容器：loading 复用现有省略号样式
    const block = document.createElement('div');
    block.className = 'yuxtrans-hover-translation';
    const loading = document.createElement('span');
    loading.className = 'yuxtrans-loading';
    loading.innerHTML = '<span class="yuxtrans-loading-label">翻译中</span>';
    block.appendChild(loading);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'yuxtrans-hover-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭译文');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => block.remove());
    block.appendChild(closeBtn);

    if (el.nextSibling) el.parentNode.insertBefore(block, el.nextSibling);
    else el.parentNode.appendChild(block);

    const sourceLang = this.config.sourceLang || 'auto';
    const targetLang = this.config.targetLang || 'zh';
    // 段落普遍 >12 字符，缓存正常生效；走非流式 translate
    chrome.runtime.sendMessage(
      { action: 'translate', text, sourceLang, targetLang, context: this.getPageContext() },
      (response) => {
        if (loading.parentNode) loading.remove();
        const span = document.createElement('span');
        if (response && response.success) {
          span.textContent = response.text;
        } else {
          span.textContent = (response && response.error) || '翻译失败';
          span.style.color = 'var(--yxt-error)';
        }
        block.insertBefore(span, closeBtn);
      }
    );
  }

  /**
   * F1：取消当前 hover 状态（修饰键释放 / Esc）
   */
  _cancelHover() {
    if (this._hoverTimer) { clearTimeout(this._hoverTimer); this._hoverTimer = null; }
    if (this._hoverTarget) {
      this._hoverTarget.classList.remove('yuxtrans-hover-target');
      this._hoverTarget = null;
    }
  }

  _handleHoverKeyDown(e) {
    if (e.key === 'Escape') this._cancelHover();
  }

  _handleHoverKeyUp(e) {
    const modifierKey = this.config.hoverModifier === 'ctrl' ? 'ctrlKey' : 'altKey';
    if (!e[modifierKey]) this._cancelHover();
  }

  /**
   * F2：双击单词直出词典卡片（icon/contextMenu 模式下也直出，绕过浮钮）
   */
  _handleDblClick(e) {
    if (!this.config.dictDblclick || !this.config.dictMode) return;
    if (e.target.closest('.yuxtrans-popup, .yuxtrans-float-btn')) return;
    this._lastInputElement = null;
    setTimeout(() => {
      const sel = window.getSelection().toString().trim();
      if (!sel) return;
      const isWord = this.helpers.isSingleWord
        ? this.helpers.isSingleWord(sel)
        : (/^\p{L}[\p{L}\p{M}'’-]*\p{L}$/u.test(sel.trim()) && sel.trim().length <= 30 && !/\s/.test(sel.trim()));
      if (isWord) this.lookupWord(sel, e.clientX, e.clientY);
    }, 10);
  }

  /**
   * F2：单词词典查询--走结构化词典卡片（音标/义项/例句）
   */
  lookupWord(word, x, y) {
    if (!this.isSiteAllowed()) return;
    if (this.isTranslating) return;

    const selection = window.getSelection();
    let rect = { left: x || 100, top: y || 100, width: 0, height: 0 };
    if (selection.rangeCount > 0) {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    }
    // 复用浮窗骨架，source 区显示单词原文
    this.showPopup(rect.left, rect.bottom + 10, word);
    this.isTranslating = true;
    this.popup.dataset.mode = 'dict';
    // F5：输入框触发时显示"插入译文"按钮
    this._toggleInsertBtn();

    const sourceLang = this.config.sourceLang || 'auto';
    const targetLang = this.config.targetLang || 'zh';
    chrome.runtime.sendMessage(
      { action: 'lookupWord', text: word, sourceLang, targetLang, context: this.getPageContext() },
      (response) => {
        this.isTranslating = false;
        if (response && response.success) {
          this.renderDictResult(response.dict, response.cached, word);
        } else {
          const userError = response && response.userError;
          const msg = userError
            ? (this.helpers.formatUserErrorCompact ? this.helpers.formatUserErrorCompact(userError) : userError.userMessage)
            : (response && response.error) || '词典查询失败';
          this.updatePopup(msg, false, 'error', word);
        }
      }
    );
  }

  /**
   * F2：渲染词典卡片（结构化结果）
   * @param {Object} dict - {word, phonetic, senses:[{pos, meaning, examples:[{source,target}]}], raw}
   */
  renderDictResult(dict, cached, word) {
    if (!this.popup) return;
    const targetEl = this.popup.querySelector('.yuxtrans-target');
    if (!targetEl) return;
    targetEl.textContent = '';

    const hasSenses = dict && Array.isArray(dict.senses) && dict.senses.length > 0;
    const hasRaw = !!(dict && dict.raw);
    // 无结构化词典 -> 降级纯文本（本地小模型或解析失败）
    if (!hasSenses) {
      this.updatePopup(hasRaw ? dict.raw : ((word || '') + '：暂无词典释义'), cached, 'cache', word);
      return;
    }

    // 隐藏 source（dict.word 大字已显示单词，避免重复）
    const sourceEl = this.popup.querySelector('.yuxtrans-source');
    if (sourceEl) sourceEl.style.display = 'none';

    const container = document.createElement('div');
    container.className = 'yuxtrans-dict';

    if (dict.word) {
      const w = document.createElement('div');
      w.className = 'yuxtrans-dict-word';
      w.textContent = dict.word;
      container.appendChild(w);
    }
    if (dict.phonetic) {
      const p = document.createElement('div');
      p.className = 'yuxtrans-dict-phonetic';
      p.textContent = '/' + dict.phonetic + '/';
      container.appendChild(p);
    }
    dict.senses.forEach((sense) => {
      const s = document.createElement('div');
      s.className = 'yuxtrans-dict-sense';
      if (sense.pos) {
        const pos = document.createElement('span');
        pos.className = 'yuxtrans-dict-pos';
        pos.textContent = sense.pos;
        s.appendChild(pos);
      }
      if (sense.meaning) {
        const m = document.createElement('span');
        m.className = 'yuxtrans-dict-meaning';
        m.textContent = sense.meaning;
        s.appendChild(m);
      }
      (sense.examples || []).forEach((ex) => {
        const e = document.createElement('span');
        e.className = 'yuxtrans-dict-example';
        if (ex.source) e.textContent = ex.source;
        if (ex.target) {
          const t = document.createElement('span');
          t.className = 'yuxtrans-dict-example-target';
          t.textContent = ex.target;
          e.appendChild(t);
        }
        s.appendChild(e);
      });
      container.appendChild(s);
    });

    targetEl.appendChild(container);

    // 状态徽章
    const statusEl = this.popup.querySelector('.yuxtrans-status');
    const badgeClass = cached ? 'cache' : 'cloud';
    statusEl.innerHTML = '<span class="yuxtrans-status-badge ' + badgeClass + '">' +
      (cached ? '缓存命中' : '云端') + '</span>';

    // 复制内容为纯文本版（单词 + 各义项）
    const parts = dict.senses.map((s) =>
      (s.pos ? s.pos + ' ' : '') + (s.meaning || '')
    ).filter(Boolean);
    this.popup.dataset.translation = (dict.word || word || '') + (parts.length ? ' ' + parts.join('; ') : '');

    // 复制 / 差译按钮可见
    const badBtn = this.popup.querySelector('.yuxtrans-bad-btn');
    const copyBtn = this.popup.querySelector('.yuxtrans-copy-btn');
    if (badBtn) { badBtn.hidden = false; badBtn.disabled = false; }
    if (copyBtn) { copyBtn.hidden = false; copyBtn.disabled = false; }

    // 自动复制
    if (this.config.autoCopy) this.copyPopupTranslation();
  }

  /**
   * F4b：双档案对照--用对照档案翻译同一文本，结果显示在钉住的对照浮窗
   * 复用 showPopup 骨架；主浮窗若未 pin 则自动 pin 后再开对照浮窗
   */
  translateWithCompareProfile(text, sourceLang, targetLang, context) {
    const profileId = this.config.compareProfileId;
    if (!profileId) return;
    // 主浮窗钉住（保留主译文），再开对照浮窗
    if (this.popup && this.popup.dataset.pinned !== '1') this.pinPopup();
    // 对照浮窗：在主浮窗左侧偏移定位
    const baseX = this.popup ? parseFloat(this.popup.style.left) - 340 : 100;
    const baseY = this.popup ? parseFloat(this.popup.style.top) : 100;
    this.showPopup(Math.max(16, baseX), baseY, text);
    if (!this.popup) return;
    // 标记为对照浮窗
    this.popup.dataset.compare = '1';
    const titleEl = this.popup.querySelector('.yuxtrans-popup-title');
    if (titleEl) titleEl.textContent = 'YuxTrans · 对照';

    chrome.runtime.sendMessage(
      { action: 'translateWithProfile', text, sourceLang, targetLang, context, profileId },
      (response) => {
        if (response && response.success) {
          this.updatePopup(response.text, false, response.engine || 'compare', text);
        } else {
          this.updatePopup((response && response.error) || '对照翻译失败', false, 'error', text);
        }
      }
    );
  }

  /**
   * F5：取 input/textarea 当前选中文本
   */
  _getInputSelection(inputEl) {
    try {
      const s = inputEl.selectionStart;
      const e = inputEl.selectionEnd;
      if (s == null || e == null || s === e) return null;
      return inputEl.value.substring(s, e);
    } catch (err) {
      return null;
    }
  }

  /**
   * F5：将译文插入触发翻译的输入框（替换选区，或追加到选区位置）
   */
  insertTranslationToInput() {
    if (!this.popup || !this._lastInputElement) return;
    const text = this.popup.dataset.translation || '';
    if (!text) return;
    try {
      const input = this._lastInputElement;
      const s = input.selectionStart;
      const e = input.selectionEnd;
      const before = input.value.substring(0, s);
      const after = input.value.substring(e);
      input.value = before + text + after;
      input.selectionStart = input.selectionEnd = s + text.length;
      input.focus();
      // 触发 input 事件，让前端框架（React/Vue）感知值变化
      input.dispatchEvent(new Event('input', { bubbles: true }));
      this.hidePopup();
    } catch (err) {
      console.warn('[YuxTrans] 插入译文到输入框失败:', err);
    }
  }

  /**
   * F5：根据是否由输入框触发，切换"插入译文"按钮可见性
   */
  _toggleInsertBtn() {
    if (!this.popup) return;
    const btn = this.popup.querySelector('.yuxtrans-insert-btn');
    if (btn) btn.hidden = !this._lastInputElement;
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

    // F5：输入框翻译--input/textarea 选区不走 window.getSelection，单独处理
    const inputEl = e.target.closest && e.target.closest('input, textarea');
    if (inputEl) {
      if (!this.config.inputTranslate) return;
      const sel = this._getInputSelection(inputEl);
      if (!sel) { this._lastInputElement = null; return; }
      this._lastInputElement = inputEl;
      // 跳过无翻译价值文本（纯数字/符号）
      if (!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(sel)) return;
      // 单词走词典，否则普通翻译
      const isWord = this.config.dictMode && (this.helpers.isSingleWord
        ? this.helpers.isSingleWord(sel)
        : (/^\p{L}[\p{L}\p{M}'’-]*\p{L}$/u.test(sel.trim()) && sel.trim().length <= 30 && !/\s/.test(sel.trim())));
      if (isWord) this.lookupWord(sel, e.clientX, e.clientY);
      else this.translateText(sel, e.clientX, e.clientY);
      return;
    }
    this._lastInputElement = null;

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
    // F2：单词词典模式--选中单个词时走词典卡片
    if (this.config.dictMode) {
      const isWord = this.helpers.isSingleWord
        ? this.helpers.isSingleWord(text)
        : (/^\p{L}[\p{L}\p{M}'’-]*\p{L}$/u.test(text.trim()) && text.trim().length <= 30 && !/\s/.test(text.trim()));
      if (isWord) {
        this.lookupWord(text, x, y);
        return;
      }
    }
    if (this.isTranslating) return;

    const selection = window.getSelection();
    let rect = { left: x || 100, top: y || 100, width: 0, height: 0 };

    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      rect = range.getBoundingClientRect();
    }

    this.showPopup(rect.left, rect.bottom + 10, text);
    this.isTranslating = true;
    // F5：输入框触发时显示"插入译文"按钮
    this._toggleInsertBtn();

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
          // F4b：双档案对照--主翻译成功后用对照档案再译，结果钉到对照浮窗
          if (this.config.compareProfileId) {
            this.translateWithCompareProfile(text, sourceLang, targetLang, context);
          }
        } else {
          const userError = response?.userError;
          let errorMsg;
          if (userError) {
            errorMsg = this.helpers.formatUserErrorCompact
              ? this.helpers.formatUserErrorCompact(userError)
              : (this.helpers.formatUserErrorText
                ? this.helpers.formatUserErrorText(userError)
                : `${userError.userMessage}\n${userError.actionHint || ''}`.trim());
          } else {
            errorMsg = response?.error || '未知错误';
          }
          if (!isLocal && (errorMsg.includes('API Key') || errorMsg.includes('请先配置') || userError?.code === 'AUTH')) {
            this.updatePopup('请先配置 API Key\n打开设置 → 服务档案', false, 'warning');
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
    // F4：已 pin 的浮窗保留，仅销毁未 pin 的当前浮窗
    if (this.popup) {
      if (this.popup.dataset.pinned === '1') {
        this.pinnedPopups.push(this.popup);
        this.popup = null;
      } else {
        this.hidePopup();
      }
    }

    const popup = document.createElement('div');
    popup.className = 'yuxtrans-popup';
    popup.innerHTML = `
      <div class="yuxtrans-popup-header">
        <span class="yuxtrans-popup-title">YuxTrans</span>
        <button class="yuxtrans-popup-close" aria-label="关闭" type="button">&times;</button>
      </div>
      <div class="yuxtrans-popup-content">
        <div class="yuxtrans-source">${this.escapeHtml(sourceText)}</div>
        <div class="yuxtrans-target">
          <div class="yuxtrans-loading" aria-live="polite">
            <span class="yuxtrans-loading-label">翻译中</span>
          </div>
        </div>
      </div>
      <div class="yuxtrans-popup-footer">
        <span class="yuxtrans-status"><span class="yuxtrans-status-badge">准备</span></span>
        <div class="yuxtrans-popup-actions">
          <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-pin-btn" title="钉住浮窗，不被新划词覆盖">钉住</button>
          <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-insert-btn" hidden title="将译文插入输入框">插入</button>
          <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-copy-btn">复制</button>
          <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-bad-btn" title="标记差译并清除缓存">差译</button>
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

    // F4：关闭时区分当前浮窗与已 pin 浮窗
    const closeHandler = () => this.closePopup(popup);
    popup.querySelector('.yuxtrans-popup-close').addEventListener('click', closeHandler);

    // 按 Esc 仅关闭当前（非 pin）浮窗
    this._popupEscHandler = (e) => {
      if (e.key === 'Escape') this.hidePopup();
    };
    document.addEventListener('keydown', this._popupEscHandler);

    // F4：钉住当前浮窗，使其不被新划词覆盖
    popup.querySelector('.yuxtrans-pin-btn').addEventListener('click', () => {
      this.pinPopup();
    });

    // 复制按钮只绑定一次
    popup.querySelector('.yuxtrans-copy-btn').addEventListener('click', () => {
      this.copyPopupTranslation();
    });

    popup.querySelector('.yuxtrans-insert-btn').addEventListener('click', () => {
      this.insertTranslationToInput();
    });

    popup.querySelector('.yuxtrans-bad-btn').addEventListener('click', () => {
      this.reportBadPopupTranslation();
    });
  }

  /**
   * F4：关闭指定浮窗（区分当前 this.popup 与已 pin 浮窗）
   */
  closePopup(popup) {
    if (!popup) return;
    if (popup === this.popup) {
      this.hidePopup();
      return;
    }
    // 已 pin 的浮窗：从列表移除并销毁
    const idx = this.pinnedPopups.indexOf(popup);
    if (idx >= 0) this.pinnedPopups.splice(idx, 1);
    if (popup.parentNode) popup.remove();
  }

  /**
   * F4：钉住当前浮窗，使其不被新划词覆盖；钉住后钉住按钮隐藏，Esc 不再关闭它
   */
  pinPopup() {
    if (!this.popup) return;
    this.popup.dataset.pinned = '1';
    this.pinnedPopups.push(this.popup);
    const pinBtn = this.popup.querySelector('.yuxtrans-pin-btn');
    if (pinBtn) pinBtn.hidden = true;
    this.popup = null;
    // 解绑当前 Esc handler（pin 后无当前浮窗；下次划词 showPopup 重绑）
    if (this._popupEscHandler) {
      document.removeEventListener('keydown', this._popupEscHandler);
      this._popupEscHandler = null;
    }
  }

  updatePopup(translatedText, cached, engine, sourceText) {
    if (!this.popup) return;

    const targetEl = this.popup.querySelector('.yuxtrans-target');
    targetEl.textContent = translatedText;
    const isError = engine === 'error' || engine === 'warning';
    targetEl.classList.toggle('is-error', isError);

    const statusEl = this.popup.querySelector('.yuxtrans-status');
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

    // 复制 / 差译常驻可见（差译仅在有译文时可用）
    const badBtn = this.popup.querySelector('.yuxtrans-bad-btn');
    const copyBtn = this.popup.querySelector('.yuxtrans-copy-btn');
    if (badBtn) {
      badBtn.hidden = false;
      badBtn.disabled = isError;
    }
    if (copyBtn) {
      copyBtn.hidden = false;
      copyBtn.disabled = false;
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
  collectTextNodes(root) {
    // F6：正文区域识别--smartContentDetection 开启时只遍历正文根，跳过导航/侧栏/页脚
    if (!root) {
      root = (this.config.smartContentDetection && this.detectMainContent()) || document.body;
    }
    const nodes = [];
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    const walker = document.createTreeWalker(
      root,
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
            '.yuxtrans-bilingual-text', '.yuxtrans-streaming-text',
            '.yuxtrans-hover-translation', '.yuxtrans-dict'
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
   * F6：识别页面正文区域根节点，跳过导航/侧栏/页脚等非正文块
   * 启发式：main > article > 文本密度最高的块级容器 > body
   */
  detectMainContent() {
    try {
      // 1. 语义标签优先（需正文文本量达标，避免空壳 main/article）
      const main = document.querySelector('main') || document.querySelector('[role="main"]');
      if (main && this._collectibleTextLength(main) >= 200) return main;
      const article = document.querySelector('article');
      if (article && this._collectibleTextLength(article) >= 200) return article;

      // 2. 文本密度：body 直系子块级容器中，排除 nav/header/footer/aside，取正文文本量最大者
      const candidates = Array.from(document.body.children).filter((el) =>
        ['DIV', 'SECTION', 'ARTICLE', 'MAIN'].includes(el.tagName)
      );
      let best = null;
      let bestLen = 0;
      for (const el of candidates) {
        if (el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
        const len = this._collectibleTextLength(el);
        if (len > bestLen) { bestLen = len; best = el; }
      }
      // 密度阈值：正文至少 200 字符才采纳，否则回退 body
      if (best && bestLen >= 200) return best;
    } catch (e) {
      // 识别异常时降级到 body，绝不阻断整页翻译
    }
    return document.body;
  }

  /**
   * F6：粗略统计元素内可翻译文本长度（去空白后）
   */
  _collectibleTextLength(el) {
    return (el.textContent || '').replace(/\s+/g, '').length;
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
      while (queue.length > 0 && this.pageTranslationState.isTranslating && !this.pageTranslationState.cancelRequested) {
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
                context: null,
                sessionId: this._pageSessionId
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
      // F3：原文呈现样式（弱化/模糊原文）
      this._applyOriginalStyle(parent);
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
   * F3：按 originalStyle 给原文容器应用弱化/模糊样式
   */
  _applyOriginalStyle(parent) {
    if (!parent) return;
    parent.classList.remove('yuxtrans-original-fade', 'yuxtrans-original-blur');
    const style = this.config.originalStyle || 'normal';
    if (style === 'fade') parent.classList.add('yuxtrans-original-fade');
    else if (style === 'blur') parent.classList.add('yuxtrans-original-blur');
  }

  /**
   * F3：批量重应用原文样式（originalStyle 配置变更后调用，仅双语模式生效）
   */
  applyOriginalStyleToAll() {
    for (const [node] of this.pageTranslationState.originalTexts) {
      const parent = node && node.parentElement;
      if (parent && parent.classList.contains('yuxtrans-translated-bilingual')) {
        this._applyOriginalStyle(parent);
      }
    }
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

    // 防止重入：翻译进行中再次触发则取消在途批次并恢复已译原文
    if (this.pageTranslationState.isTranslating) {
      this.restoreOriginalTexts();
      this.setPageControlRestoredState();
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
    this.pageTranslationState.cancelRequested = false;
    this.pageTranslationState.originalTexts.clear();
    this.pageTranslationState.streamingNodes.clear();
    this.pageTranslationState.failedItems = [];
    this.pageTranslationState.cacheHits = 0;
    this.pageTranslationState.apiCount = 0;
    // 分配本轮会话 id，供 SW 侧取消链路使用
    this._pageSessionId = 'yxt-page-' + (++this._pageSessionCounter);

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

      // 2. belowFold 视口感知翻译：入视口（200px 预加载区）才提交批次，
      //    取代一次性全提交以节省配额；2s 超时回退避免用户不滚动时 await 卡死。
      const appliedTexts = new Set();
      const belowFoldOnBatchResult = (indices, nodes, results) => {
        if (this.pageTranslationState.cancelRequested) return;
        results.forEach((res, localIdx) => {
          const item = nodes[localIdx];
          if (res && res.success) {
            const resultItem = uniqueTexts.get(item.text);
            if (resultItem) resultItem.translation = res.text;
            appliedTexts.add(item.text);
            if (res.cached) this.pageTranslationState.cacheHits++;
            else this.pageTranslationState.apiCount++;
            this.applyTranslation(item.nodeInfo, res.text);
          } else {
            const resultItem = uniqueTexts.get(item.text);
            if (resultItem && !resultItem.translation) resultItem.error = '翻译失败';
          }
        });
      };
      if (belowFoldItems.length > 0 && this.pageTranslationState.isTranslating) {
        await this._translateBelowFoldViaViewport(belowFoldItems, belowFoldOnBatchResult);
      }

      // 取消场景：restoreOriginalTexts 已恢复原文，跳过应用结果与完成收尾
      if (this.pageTranslationState.cancelRequested) return;

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
      // 整页翻译完成后，监听动态新增内容（无限滚动 / SPA 异步加载）
      this._startDynamicObserver();
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
      <button type="button" class="yuxtrans-page-control-btn" id="yuxtrans-cancel-btn">取消</button>
      <button type="button" class="yuxtrans-page-control-btn primary" id="yuxtrans-restore-btn"
        style="display:none">恢复原文</button>
      <button type="button" class="yuxtrans-page-control-btn" id="yuxtrans-bilingual-btn"
        style="display:none">双语</button>
      <button type="button" class="yuxtrans-page-control-btn" id="yuxtrans-close-btn"
        style="display:none">关闭</button>
      <details class="yuxtrans-page-control-more" id="yuxtrans-more" style="display:none">
        <summary>更多</summary>
        <div class="yuxtrans-page-control-more-menu">
          <button type="button" class="yuxtrans-page-control-btn secondary" id="yuxtrans-retry-btn"
            style="display:none">重试失败</button>
          <button type="button" class="yuxtrans-page-control-btn secondary" id="yuxtrans-disable-site-btn"
            title="本站禁用扩展">禁用本站</button>
        </div>
      </details>
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

    const moreEl = this.pageControlElement('yuxtrans-more');
    const actionPlan = (this.helpers.pageControlCompletedActions
      ? this.helpers.pageControlCompletedActions({ hasFailures })
      : { primary: ['restore', 'bilingual', 'close'], secondary: hasFailures ? ['retry', 'disableSite'] : ['disableSite'] });

    if (cancelBtn) cancelBtn.style.display = 'none';
    if (restoreBtn) restoreBtn.style.display = actionPlan.primary.includes('restore') ? 'inline-block' : 'none';
    if (bilingualBtn) {
      bilingualBtn.style.display = actionPlan.primary.includes('bilingual') ? 'inline-block' : 'none';
      bilingualBtn.textContent = isBilingual ? '仅译文' : '双语';
    }
    if (closeBtn) closeBtn.style.display = actionPlan.primary.includes('close') ? 'inline-block' : 'none';
    if (moreEl) moreEl.style.display = actionPlan.secondary.length ? 'inline-block' : 'none';
    if (retryBtn) {
      retryBtn.style.display = actionPlan.secondary.includes('retry') ? 'block' : 'none';
    }
    if (disableBtn) {
      disableBtn.style.display = actionPlan.secondary.includes('disableSite') ? 'block' : 'none';
    }

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
        // F3：切回双语时应用原文呈现样式
        this._applyOriginalStyle(parent);
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
        // F3：仅译文模式无原文，移除原文样式类
        parent.classList.remove('yuxtrans-original-fade', 'yuxtrans-original-blur');
      }
    }
  }

  /**
   * 取消进行中的整页/动态翻译：通知 SW abort 在途请求并阻止后续批次。
   */
  cancelPageTranslation() {
    this.pageTranslationState.cancelRequested = true;
    if (this._pageSessionId) {
      try {
        chrome.runtime.sendMessage({ action: 'cancelTranslate', sessionId: this._pageSessionId });
      } catch (e) { /* SW 未就绪忽略 */ }
      this._pageSessionId = null;
    }
    // 放弃 belowFold 视口感知中未提交的项，让 translatePage 的 await 尽快结束
    if (this._viewportCleanup) {
      const cleanup = this._viewportCleanup;
      this._viewportCleanup = null;
      cleanup();
    }
  }

  restoreOriginalTexts() {
    // 若仍有在途翻译，先取消，避免恢复原文后继续消耗配额
    if (this.pageTranslationState.isTranslating) {
      this.cancelPageTranslation();
    }
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
        parent.classList.remove('yuxtrans-translated', 'yuxtrans-translated-bilingual', 'yuxtrans-original-fade', 'yuxtrans-original-blur');

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
    this._stopDynamicObserver();
    // F1：恢复原文时清理所有悬停翻译块，重置 hover-done 标记，并取消进行中的 hover 状态
    this._cancelHover();
    document.querySelectorAll('.yuxtrans-hover-translation').forEach((b) => b.remove());
    document.querySelectorAll('[data-yxt-hover-done]').forEach((el) => { delete el.dataset.yxtHoverDone; });
    // F4：清理所有已 pin 的浮窗
    this.pinnedPopups.forEach((p) => { if (p.parentNode) p.remove(); });
    this.pinnedPopups = [];
  }

  /**
   * 动态内容翻译：整页翻译完成后监听新增 DOM 节点（无限滚动 / SPA 异步加载），
   * 防抖后复用 collectTextNodes 收集未翻译文本并翻译。
   * collectTextNodes 已排除 yuxtrans-translated 等标记节点，故只会收集真正新增的未翻译文本。
   */
  _startDynamicObserver() {
    if (this._dynamicObserver || typeof MutationObserver === 'undefined') return;
    this._dynamicObserver = new MutationObserver((muts) => this._onMutations(muts));
    this._dynamicObserver.observe(document.body, { childList: true, subtree: true });
  }

  _stopDynamicObserver() {
    if (this._addedDebounceTimer) {
      clearTimeout(this._addedDebounceTimer);
      this._addedDebounceTimer = null;
    }
    if (this._dynamicObserver) {
      this._dynamicObserver.disconnect();
      this._dynamicObserver = null;
    }
  }

  /**
   * 断开 belowFold 视口观察者
   */
  _disconnectViewportObserver() {
    if (this._viewportObserver) {
      this._viewportObserver.disconnect();
      this._viewportObserver = null;
    }
  }

  /**
   * belowFold 视口感知翻译：节点进入视口（200px 预加载区）才提交批次，
   * 取代一次性全提交以节省配额；2s 超时后剩余项回退一次性提交避免 await 卡死。
   * @param {Array} items belowFold 去重后的待译项
   * @param {Function} onBatchResult 每个 batch 完成回调
   * @returns {Promise<void>}
   */
  _translateBelowFoldViaViewport(items, onBatchResult) {
    return new Promise((resolve) => {
      if (!items || items.length === 0) { resolve(); return; }

      // 元素 -> 其下待译项（多文本节点共享同一 parentElement）
      const elementToItems = new Map();
      for (const item of items) {
        const el = item.nodeInfo && item.nodeInfo.node && item.nodeInfo.node.parentElement;
        if (!el) continue;
        if (!elementToItems.has(el)) elementToItems.set(el, []);
        elementToItems.get(el).push(item);
      }
      if (elementToItems.size === 0) { resolve(); return; }

      const pending = new Set(items);
      let pendingBatch = [];
      let submitTimer = null;
      let fallbackTimer = null;
      let activeBatches = 0;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (submitTimer) clearTimeout(submitTimer);
        this._viewportCleanup = null;
        this._disconnectViewportObserver();
        resolve();
      };

      // 取消回调：放弃未提交项，在途批次自行结束后 finish
      this._viewportCleanup = () => {
        pending.clear();
        pendingBatch = [];
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
        if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }
        if (activeBatches === 0) finish();
      };

      const submit = async () => {
        if (pendingBatch.length === 0) { finish(); return; }
        const batch = pendingBatch;
        pendingBatch = [];
        activeBatches++;
        try {
          if (!this.pageTranslationState.cancelRequested && this.pageTranslationState.isTranslating) {
            await this.translateBatchParallel(batch, null, onBatchResult);
          }
        } catch (e) { /* 单批异常不中断整体 */ }
        activeBatches--;
        finish();
      };

      // 超时回退：2s 后把视口外剩余项一次性提交，避免用户不滚动导致 await 卡死
      fallbackTimer = setTimeout(() => {
        for (const it of pending) pendingBatch.push(it);
        pending.clear();
        if (!submitTimer) submit();
      }, 2000);

      this._viewportObserver = new IntersectionObserver((entries) => {
        if (this.pageTranslationState.cancelRequested || resolved) return;
        let added = false;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const its = elementToItems.get(entry.target);
            if (its) {
              for (const it of its) {
                if (pending.has(it)) { pendingBatch.push(it); pending.delete(it); added = true; }
              }
              this._viewportObserver.unobserve(entry.target);
            }
          }
        }
        if (added && !submitTimer) {
          submitTimer = setTimeout(() => { submitTimer = null; submit(); }, 100);
        }
      }, { rootMargin: '200px' });

      for (const el of elementToItems.keys()) this._viewportObserver.observe(el);
    });
  }

  _onMutations(mutations) {
    if (!this.pageTranslationState.isTranslated) return;
    // 主翻译或上一轮动态翻译进行中时，忽略自身插入译文节点触发的 mutation
    if (this._isProcessingAdded || this.pageTranslationState.isTranslating) return;
    const hasAdded = mutations.some((m) => m.addedNodes && m.addedNodes.length > 0);
    if (!hasAdded) return;
    clearTimeout(this._addedDebounceTimer);
    this._addedDebounceTimer = setTimeout(() => {
      this._processAddedNodes();
    }, 500);
  }

  async _processAddedNodes() {
    if (!this.pageTranslationState.isTranslated) return;
    if (this.pageTranslationState.isTranslating) return;
    this.pageTranslationState.isTranslating = true;
    this._isProcessingAdded = true;
    try {
      // collectTextNodes 遍历 body，已翻译节点会被 acceptNode 排除，
      // 因此结果只含动态新增（或之前失败未标记）的未翻译文本
      const nodesInfo = this.collectTextNodes();
      const seen = new Set();
      const items = [];
      for (const ni of nodesInfo) {
        // 跳过已翻译或已失败的节点，避免重复请求
        if (this.pageTranslationState.originalTexts.has(ni.node)) continue;
        if (seen.has(ni.text)) continue;
        seen.add(ni.text);
        items.push({ text: ni.text, nodeInfo: ni });
      }
      if (items.length === 0) return;
      await this.translateBatchParallel(items, null, (_idx, nodes, results) => {
        results.forEach((res, i) => {
          if (res && res.success) this.applyTranslation(nodes[i].nodeInfo, res.text);
        });
      });
    } catch (e) {
      console.error('[YuxTrans] 动态内容翻译异常:', e);
    } finally {
      this.pageTranslationState.isTranslating = false;
      this._isProcessingAdded = false;
    }
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