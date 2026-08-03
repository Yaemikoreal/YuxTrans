/**
 * 划词翻译浮窗方法（content 拆分模块）
 * 依赖：content.js 先注入（YuxTransContent 类）
 */
(function () {
  const Ctor = (typeof YuxTransContent !== 'undefined' ? YuxTransContent : null)
    || (typeof globalThis !== 'undefined' ? globalThis.YuxTransContent : null);
  if (!Ctor) return;
  Object.assign(Ctor.prototype, {
    /**
     * F4b：双档案对照--用对照档案翻译同一文本，结果显示在钉住的对照浮窗
     * 复用 showPopup 骨架；主浮窗若未 pin 则自动 pin 后再开对照浮窗
     */
    translateWithCompareProfile(text, sourceLang, targetLang, context) {
      const profileId = this.config.compareProfileId;
      if (!profileId) return;
      // 先记录主浮窗位置（pinPopup 内部会置 this.popup = null，须提前取值）
      const mainPopup = this.popup;
      const mainLeft = mainPopup ? parseFloat(mainPopup.style.left) : NaN;
      const mainTop = mainPopup ? parseFloat(mainPopup.style.top) : NaN;
      // 主浮窗钉住（保留主译文），再开对照浮窗
      if (mainPopup && mainPopup.dataset.pinned !== '1') {
        // #5 对照模式替换语义：自动 pin 新主浮窗前，移除上一次对照自动 pin 的主浮窗
        // （仅自动 pin 的那个，用户手动 pin 的浮窗不动），避免 pinned 浮窗无限累积
        if (this._compareMainPopup && this._compareMainPopup !== mainPopup) {
          this.closePopup(this._compareMainPopup);
        }
        this.pinPopup();
        this._compareMainPopup = mainPopup;
      }
      // 对照浮窗：在主浮窗左侧偏移定位；无主浮窗时回退默认
      const baseX = !isNaN(mainLeft) ? mainLeft - 340 : 100;
      const baseY = !isNaN(mainTop) ? mainTop : 100;
      this.showPopup(Math.max(16, baseX), baseY, text);
      if (!this.popup) return;
      // 标记为对照浮窗
      this.popup.dataset.compare = '1';
      this._updatePopupTitle('compare');
      const comparePopup = this.popup;

      chrome.runtime.sendMessage(
        { action: 'translateWithProfile', text, sourceLang, targetLang, context, profileId },
        (response) => {
          // #4：对照浮窗已销毁则丢弃响应，避免写入其他浮窗
          if (!this._isPopupAlive(comparePopup)) return;
          if (response && response.success) {
            this.updatePopup(response.text, false, response.engine || 'compare', text, comparePopup);
          } else {
            this.updatePopup((response && response.error) || '对照翻译失败', false, 'error', text, comparePopup);
          }
        }
      );
    },

    handleMouseUp(e) {
      if (this._eventClosest(e, '.yuxtrans-popup, .yuxtrans-float-btn')) return;
      if (!this.isSiteAllowed()) return;

      // F5：输入框翻译--input/textarea 选区不走 window.getSelection，单独处理
      const inputEl = this._eventClosest(e, 'input, textarea');
      if (inputEl) {
        if (!this.config.inputTranslate) return;
        // #14：input 分支补齐触发模式语义（此前 contextMenu/icon 模式下也直接弹窗）
        const inputMode = this.helpers.resolveTriggerAction
          ? this.helpers.resolveTriggerAction(this.config.triggerMode)
          : (this.config.triggerMode || 'auto');
        if (inputMode === 'contextMenu') return; // 仅右键菜单触发
        // modifier 模式：输入框内划选同样要求按住修饰键
        if (inputMode === 'modifier' &&
            !this.helpers.isSelectionModifierPressed(e, this.config.selectionModifier)) return;
        const sel = this._getInputSelection(inputEl);
        if (!sel) { this._lastInputElement = null; return; }
        this._lastInputElement = inputEl;
        // 跳过无翻译价值文本（纯数字/符号）
        if (!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(sel)) return;
        if (inputMode === 'icon') {
          // icon 模式出浮钮，点击后翻译；_lastInputElement 已设，F5 插入能力保留
          this.showFloatButton(e.clientX, e.clientY, sel);
          return;
        }
        // 单词走词典，否则普通翻译
        const isWord = this.config.dictMode && this.helpers.isSingleWord(sel);
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
        // #8B：译文区域（悬停译文/双语译文/流式临时译文）的再次划选不触发翻译
        if (sel.rangeCount > 0) {
          const node = sel.getRangeAt(0).commonAncestorContainer;
          const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          if (el && el.closest('input, textarea, [contenteditable="true"], code, pre, kbd, samp, ' +
              '.yuxtrans-hover-translation, .yuxtrans-bilingual-text, .yuxtrans-streaming-text')) {
            this.hideFloatButton();
            return;
          }
        }

        // 跳过纯数字、纯符号、URL 等无翻译价值文本
        if (!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(selection)) {
          this.hideFloatButton();
          return;
        }

        // #1：双击单词且双击查词开启时交给 _handleDblClick 统一处理，避免划词+双击双请求
        if (e.detail >= 2 && this.config.dictDblclick && this.config.dictMode &&
            this.helpers.isSingleWord(selection)) {
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
        if (mode === 'modifier') {
          this.hideFloatButton();
          // 松手瞬间校验修饰键：未按住则静默（不干扰复制/全选/链接点击等原生行为）
          if (!this.helpers.isSelectionModifierPressed(e, this.config.selectionModifier)) return;
          this.translateText(selection, e.clientX, e.clientY);
          return;
        }
        if (mode === 'auto') {
          this.hideFloatButton();
          this.translateText(selection, e.clientX, e.clientY);
          return;
        }
        // icon
        this.showFloatButton(e.clientX, e.clientY, selection);
      }, YuxContentConsts.SELECTION_READ_DELAY_MS);
    },

    handleMouseDown(e) {
      // #3：点击自有 UI（浮窗/浮钮/整页控制条/悬停译文/悬停引导）不关闭浮窗
      if (!this._eventClosest(e, '.yuxtrans-popup, .yuxtrans-float-btn, .yuxtrans-page-control, ' +
          '.yuxtrans-hover-translation, .yuxtrans-hover-guide')) {
        this.hidePopup();
      }
    },

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
    },

    hideFloatButton() {
      if (this.floatBtn) {
        this.floatBtn.remove();
        this.floatBtn = null;
      }
    },

    translateText(text, x, y) {
      if (!this.isSiteAllowed()) return;
      // F2：单词词典模式--选中单个词时走词典卡片
      if (this.config.dictMode) {
        const isWord = this.helpers.isSingleWord(text);
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
      const popup = this.popup;
      this.isTranslating = true;
      // #11：70s 看门狗——SW 不回包时复位在途标志，避免永久卡死
      clearTimeout(this._translateWatchdog);
      this._translateWatchdog = setTimeout(() => {
        this._translateWatchdog = null;
        this.isTranslating = false;
        console.warn('[YuxTrans] 划词翻译 70s 无响应，已复位在途标志');
      }, YuxContentConsts.WATCHDOG_TIMEOUT_MS);
      if (this._translateWatchdog.unref) this._translateWatchdog.unref(); // Node 测试环境不阻塞进程退出
      // F5：输入框触发时显示"插入译文"按钮
      this._toggleInsertBtn();

      const sourceLang = this.config.sourceLang || 'auto';
      const targetLang = this.config.targetLang || 'zh';
      const context = this.getPageContext();
      const action = this.helpers.resolveTranslateAction
        ? this.helpers.resolveTranslateAction(this.config.enableStreaming)
        : (this.config.enableStreaming === false ? 'translate' : 'translateStream');

      // #4：登记 requestId -> 浮窗映射，响应与流式 chunk 路由回捕获的浮窗（pin 或快速连划不串台）
      const requestId = this._registerPopupRequest(popup);
      chrome.runtime.sendMessage(
        {
          action,
          text,
          sourceLang,
          targetLang,
          context,
          requestId
        },
        (response) => {
          clearTimeout(this._translateWatchdog);
          this._translateWatchdog = null;
          this.isTranslating = false;

          // #4：响应路由回捕获的浮窗；浮窗已销毁则丢弃
          const target = this._takePopupForRequest(requestId);
          if (!target) return;

          const isLocal = (this.config.provider === 'local');

          if (response && response.success) {
            this.updatePopup(response.text, response.cached, response.engine, text, target);
            // F4b：双档案对照--主翻译成功后用对照档案再译，结果钉到对照浮窗
            // （仅当前浮窗触发；pinned 浮窗的迟到响应不再重复开对照浮窗）
            if (this.config.compareProfileId && target === this.popup) {
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
              this.updatePopup('请先配置 API Key\n打开设置 → 服务档案', false, 'warning', undefined, target);
            } else {
              this.updatePopup(errorMsg, false, 'error', undefined, target);
            }
          }
        }
      );
    },

    showPopup(x, y, sourceText) {
      // #2：新浮窗出现时清除可能残留的悬浮按钮（icon 模式）
      this.hideFloatButton();
      // #4：清理映射中已销毁浮窗的条目，避免 Map 泄漏
      this._sweepPopupRequests();
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
      // eslint-disable-next-line no-unsanitized/property -- 静态模板，用户源文本经 escapeHtml
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
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-pin-btn" title="钉住浮窗，不被新划词覆盖" aria-label="钉住浮窗"><svg class="yuxtrans-pin-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.042l-3.043 3.043-.022.531a2 2 0 0 1-.586 1.379l-1.414 1.414a.5.5 0 0 1-.707 0l-2.829-2.828-2.828 2.828a.5.5 0 1 1-.707-.707l2.828-2.829-2.828-2.828a.5.5 0 0 1 0-.707l1.414-1.414a2 2 0 0 1 1.379-.586l.531-.022 3.043-3.043a2.02 2.02 0 0 1-.042-.46c0-.431.107-1.023.588-1.503a.5.5 0 0 1 .353-.146z"/></svg></button>
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-insert-btn" hidden title="将译文插入输入框">插入</button>
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-copy-btn">复制</button>
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-bad-btn" title="标记差译并清除缓存">差译</button>
          </div>
        </div>
      `;

      document.body.appendChild(popup);
      this.popup = popup;
      this.popup.dataset.sourceText = sourceText;

      // header 换真实信息：语言对 + 供应商（替换品牌噪音 YuxTrans）
      this._updatePopupTitle();

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

      // 浮窗拖拽：按住 header 拖动（含已 pin 浮窗），拖拽不触发 mousedown 关闭
      popup.querySelector('.yuxtrans-popup-header').addEventListener('mousedown', (e) => {
        this._startPopupDrag(e, popup);
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
    },

    /**
     * #4：登记浮窗请求映射（requestId -> 浮窗元素），响应与流式 chunk 按此路由回对应浮窗
     */
    _registerPopupRequest(popup) {
      const requestId = 'popup-' + (++this._popupReqSeq);
      this._popupRequests.set(requestId, popup);
      return requestId;
    },

    /**
     * #4：浮窗是否仍可写入（真实 DOM 用 isConnected；测试环境退化到 parentNode/pinned 判定）
     */
    _isPopupAlive(popup) {
      if (!popup) return false;
      if (typeof popup.isConnected === 'boolean') return popup.isConnected;
      return popup === this.popup || !!popup.parentNode || this.pinnedPopups.includes(popup);
    },

    /**
     * #4：按 requestId 取出目标浮窗并移除映射；浮窗已销毁则丢弃响应
     */
    _takePopupForRequest(requestId) {
      const popup = this._popupRequests.get(requestId);
      this._popupRequests.delete(requestId);
      return this._isPopupAlive(popup) ? popup : null;
    },

    /**
     * #4：流式 chunk 专用——按 requestId 查看目标浮窗（不取走映射，chunk 会多次到达）；
     * 浮窗已销毁则清理映射并返回 null
     */
    _peekPopupForRequest(requestId) {
      const popup = this._popupRequests.get(requestId);
      if (!popup) return null;
      if (!this._isPopupAlive(popup)) {
        this._popupRequests.delete(requestId);
        return null;
      }
      return popup;
    },

    /**
     * #4：清理映射中已销毁浮窗的条目，避免 Map 泄漏（showPopup/pinPopup/hidePopup 时调用）
     */
    _sweepPopupRequests() {
      for (const [id, popup] of this._popupRequests) {
        if (!this._isPopupAlive(popup)) this._popupRequests.delete(id);
      }
    },

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
    },

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
      // #4：pin 的浮窗仍在 DOM 中，其在途请求映射保留；仅清理其他已销毁浮窗的条目
      this._sweepPopupRequests();
      // 解绑当前 Esc handler（pin 后无当前浮窗；下次划词 showPopup 重绑）
      if (this._popupEscHandler) {
        document.removeEventListener('keydown', this._popupEscHandler);
        this._popupEscHandler = null;
      }
    },

    /**
     * 浮窗拖拽：按住 header 左键拖动，松开结束；约束在可视区域内
     * 适用于当前浮窗与已 pin 浮窗（pin 后仍可自由移动）
     */
    _startPopupDrag(e, popup) {
      if (e.button !== 0) return; // 仅左键
      // 关闭按钮不触发拖拽
      if (this._eventClosest(e, '.yuxtrans-popup-close')) return;
      if (!popup) return;
      e.preventDefault(); // 避免拖拽时选中文本

      const rect = popup.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      // 切换为 fixed 定位以保证拖拽后位置稳定（showPopup 初始用 rAF 设 left/top）
      popup.style.position = 'fixed';

      const onMove = (ev) => {
        const w = rect.width;
        const h = rect.height;
        const left = Math.max(0, Math.min(ev.clientX - offsetX, window.innerWidth - w));
        const top = Math.max(0, Math.min(ev.clientY - offsetY, window.innerHeight - h));
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },

    /**
     * 同步划词浮窗 header 真实信息：语言对 + 供应商（对照浮窗追加「对照」标记）
     * @param {string} [engine]
     * @param {Element|null} [popupEl] - #4 目标浮窗（缺省 this.popup）
     */
    _updatePopupTitle(engine, popupEl) {
      const popup = popupEl || this.popup;
      if (!popup) return;
      const titleEl = popup.querySelector('.yuxtrans-popup-title');
      if (!titleEl || !this.helpers.popupTitleText) return;
      const src = this.config.sourceLang || 'auto';
      const tgt = this.config.targetLang || 'zh';
      const base = this.helpers.popupTitleText(
        engine === 'compare' ? null : this.config.provider, src, tgt
      );
      titleEl.textContent = engine === 'compare' ? `${base} · 对照` : base;
    },

    updatePopup(translatedText, cached, engine, sourceText, popupEl) {
      const popup = popupEl || this.popup;
      if (!popup) return;

      // header 同步真实信息（语言对 + 供应商 / 对照）
      this._updatePopupTitle(engine, popup);

      const targetEl = popup.querySelector('.yuxtrans-target');
      targetEl.textContent = translatedText;
      const isError = engine === 'error' || engine === 'warning';
      targetEl.classList.toggle('is-error', isError);

      const statusEl = popup.querySelector('.yuxtrans-status');
      const badgeClass = this._getStatusBadgeClass(cached, engine);
      let statusText = '完成';
      if (isError) statusText = engine === 'warning' ? '需配置' : '失败';
      else if (cached || engine === 'cache' || engine === 'glossary') {
        statusText = engine === 'glossary' ? '术语表' : '缓存命中';
      } else if (engine === 'local') statusText = '本地模型';
      else if (engine) statusText = String(engine);
      // eslint-disable-next-line no-unsanitized/property -- 状态文本经 escapeHtml
      statusEl.innerHTML = `<span class="yuxtrans-status-badge ${badgeClass}">${this.escapeHtml(String(statusText))}</span>`;

      // 保存当前译文，供复制使用
      popup.dataset.translation = translatedText;
      if (sourceText) popup.dataset.sourceText = sourceText;

      // 复制 / 差译常驻可见（差译仅在有译文时可用）
      const badBtn = popup.querySelector('.yuxtrans-bad-btn');
      const copyBtn = popup.querySelector('.yuxtrans-copy-btn');
      if (badBtn) {
        badBtn.hidden = false;
        badBtn.disabled = isError;
      }
      if (copyBtn) {
        copyBtn.hidden = false;
        copyBtn.disabled = false;
      }

      // 自动复制（如果用户开启；仅当前浮窗，避免 pinned 浮窗响应触发误复制）
      if (!isError && this.config.autoCopy && popup === this.popup) {
        this.copyPopupTranslation();
      }
    },

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
          // eslint-disable-next-line no-unsanitized/property -- 静态字符串分支
          statusEl.innerHTML = res?.removed
            ? '<span class="yuxtrans-status-badge cache">已清除缓存</span>'
            : '<span class="yuxtrans-status-badge warning">无缓存条目</span>';
        }
      } catch (e) {
        console.warn('[YuxTrans] 报告差译失败:', e);
      }
    },

    _getStatusBadgeClass(cached, engine) {
      if (cached) return 'cache';
      if (engine === 'local' || engine === 'ollama') return 'local';
      if (engine === 'error' || engine === 'warning') return engine;
      return 'cloud';
    },

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
        // eslint-disable-next-line no-unsanitized/property -- 静态字符串；originalHtml 为自有渲染产物回写
        if (this.popup) statusEl.innerHTML = originalHtml;
      }, 2000);
    },

    hidePopup() {
      if (this.popup) {
        this.popup.remove();
        this.popup = null;
      }
      // #4：浮窗销毁后清理其在途请求映射，迟到响应将被丢弃
      this._sweepPopupRequests();
      if (this._popupEscHandler) {
        document.removeEventListener('keydown', this._popupEscHandler);
        this._popupEscHandler = null;
      }
    }
  });
})();
