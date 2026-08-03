/**
 * 悬停段落翻译方法（content 拆分模块）
 * 依赖：content.js 先注入（YuxTransContent 类）
 */
(function () {
  const Ctor = (typeof YuxTransContent !== 'undefined' ? YuxTransContent : null)
    || (typeof globalThis !== 'undefined' ? globalThis.YuxTransContent : null);
  if (!Ctor) return;
  Object.assign(Ctor.prototype, {
    /**
     * F1：悬停翻译首次新手引导--仅展示一次，用户首次触发悬停翻译或点击「知道了」后关闭
     */
    async _maybeShowHoverGuide() {
      if (!this.config.hoverTranslate) return;
      if (this._hoverGuideChecked) return;
      this._hoverGuideChecked = true;
      try {
        const { hoverGuideShown } = await chrome.storage.local.get('hoverGuideShown');
        if (hoverGuideShown) return;
        this._showHoverGuide();
      } catch (e) { /* storage 不可用时忽略 */ }
    },

    _showHoverGuide() {
      if (this._hoverGuideEl) return;
      const mod = this.config.hoverModifier === 'ctrl' ? 'Ctrl' : 'Alt';
      const guide = document.createElement('div');
      guide.className = 'yuxtrans-hover-guide';
      guide.setAttribute('role', 'dialog');
      // eslint-disable-next-line no-unsanitized/property -- 静态引导模板，仅插值 'Ctrl'/'Alt' 字面量
      guide.innerHTML = `
        <div class="yuxtrans-hover-guide-title">悬停段落翻译已开启</div>
        <div class="yuxtrans-hover-guide-text">按住 <kbd>${mod}</kbd> 键悬停任意段落，停留片刻即显示译文。可在设置中关闭此功能。</div>
        <button type="button" class="yuxtrans-hover-guide-btn">知道了</button>
      `;
      document.body.appendChild(guide);
      this._hoverGuideEl = guide;
      guide.querySelector('.yuxtrans-hover-guide-btn').addEventListener('click', () => this._dismissHoverGuide());
    },

    _dismissHoverGuide() {
      if (this._hoverGuideEl) {
        this._hoverGuideEl.remove();
        this._hoverGuideEl = null;
      }
      try { chrome.storage.local.set({ hoverGuideShown: true }); } catch (e) { /* ignore */ }
    },

    /**
     * F1：mousemove 节流处理（120ms），按修饰键检测悬停段落
     */
    _handleHoverMouseMove(e) {
      if (!this.config.hoverTranslate) return;
      // #17：悬停翻译同样遵守站点黑白名单
      if (!this.isSiteAllowed()) return;
      // #6：鼠标按键按下（划选/拖拽中）不触发悬停翻译，避免插入 DOM 块破坏选区
      if ((e.buttons || 0) !== 0) {
        if (this._hoverTarget || this._hoverTimer) this._cancelHover();
        return;
      }
      const modifierKey = this.config.hoverModifier === 'ctrl' ? 'ctrlKey' : 'altKey';
      if (!e[modifierKey]) {
        // 修饰键未按下：清理描边与定时器
        if (this._hoverTarget || this._hoverTimer) this._cancelHover();
        return;
      }
      // 节流：120ms 内只处理一次
      if (this._hoverThrottleTimer) return;
      // 文本节点无 nodeType===1：先规范为 Element，避免悬停在文字上整段失效
      const raw = e.target;
      const target = this.helpers.resolveEventElement
        ? this.helpers.resolveEventElement(raw)
        : (raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement) || null);
      this._hoverThrottleTimer = setTimeout(() => {
        this._hoverThrottleTimer = null;
        this._resolveHoverTarget(target);
      }, YuxContentConsts.HOVER_THROTTLE_MS);
    },

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
      this._hoverTimer = setTimeout(() => this._translateHoverParagraph(para), YuxContentConsts.HOVER_TRANSLATE_DELAY_MS);
    },

    /**
     * F1：自 target 向上找最近块级段落元素，并用 helpers 判定是否为候选
     * 判定纯逻辑走 helpers.isHoverParagraphCandidate（未就绪时三元兜底内联）
     */
    _resolveHoverParagraph(target) {
      if (!target || target.nodeType !== Node.ELEMENT_NODE) return null;
      const blockTags = this.helpers.HOVER_BLOCK_TAGS;
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
      const isCandidate = this.helpers.isHoverParagraphCandidate({
        tagName: el.tagName, textLen: text.length, inExcluded, alreadyDone
      });
      return isCandidate ? el : null;
    },

    /**
     * F1：翻译悬停段落，在段落后插入译文块（v1 非流式，机制预留流式升级）
     */
    _translateHoverParagraph(el) {
      if (el.dataset.yxtHoverDone === '1') return;
      // #8C：先占位防重入；仅翻译成功保留标记，失败时清除允许再次悬停重试
      el.dataset.yxtHoverDone = '1';
      el.classList.remove('yuxtrans-hover-target');
      this._hoverTarget = null;
      this._hoverTimer = null;
      // 首次触发悬停翻译：关闭新手引导并标记已展示（让用户聚焦译文效果）
      if (this._hoverGuideEl) this._dismissHoverGuide();

      const rawText = (el.textContent || '').trim();
      if (!rawText) return;
      // 超长截断并标记（spec：>1500 字符截断到 1500，避免段落过长拖慢翻译）
      const HOVER_MAX_LEN = 1500;
      const truncated = rawText.length > HOVER_MAX_LEN;
      const text = truncated ? rawText.slice(0, HOVER_MAX_LEN) : rawText;

      // 译文块容器：loading 复用现有省略号样式
      const block = document.createElement('div');
      block.className = 'yuxtrans-hover-translation';
      if (truncated) {
        const tag = document.createElement('div');
        tag.className = 'yuxtrans-hover-truncated';
        tag.textContent = '原文过长，已截断翻译';
        block.appendChild(tag);
      }
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
      // 段落普遍 >12 字符，缓存正常生效；走非流式 translate（spec：携带 requestId 便于未来流式升级路由）
      this._hoverSeq = (this._hoverSeq || 0) + 1;
      const requestId = 'hover-' + this._hoverSeq;
      chrome.runtime.sendMessage(
        { action: 'translate', text, sourceLang, targetLang, context: this.getPageContext(), requestId },
        (response) => {
          if (loading.parentNode) loading.remove();
          const span = document.createElement('span');
          if (response && response.success) {
            span.textContent = response.text;
          } else {
            // #8C：失败清除 done 标记，允许再次悬停重试
            delete el.dataset.yxtHoverDone;
            span.textContent = (response && response.error) || '翻译失败';
            span.style.color = 'var(--yxt-error)';
          }
          block.insertBefore(span, closeBtn);
        }
      );
    },

    /**
     * F1：取消当前 hover 状态（修饰键释放 / Esc）
     */
    _cancelHover() {
      if (this._hoverTimer) { clearTimeout(this._hoverTimer); this._hoverTimer = null; }
      if (this._hoverTarget) {
        this._hoverTarget.classList.remove('yuxtrans-hover-target');
        this._hoverTarget = null;
      }
    },

    _handleHoverKeyDown(e) {
      if (e.key === 'Escape') this._cancelHover();
    },

    _handleHoverKeyUp(e) {
      const modifierKey = this.config.hoverModifier === 'ctrl' ? 'ctrlKey' : 'altKey';
      if (!e[modifierKey]) this._cancelHover();
    }
  });
})();
