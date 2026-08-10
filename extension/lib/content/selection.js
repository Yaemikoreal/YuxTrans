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
      // Stage F：页面级坐标在 shadow host 上
      const mainPopup = this.popup;
      const mainHost = mainPopup ? mainPopup._yxtHost : null;
      const mainLeft = mainHost ? parseFloat(mainHost.style.left) : NaN;
      const mainTop = mainHost ? parseFloat(mainHost.style.top) : NaN;
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
        // modifier 模式：输入框内划选同样要求按住修饰键（mousedown 后备：先松键后松鼠标亦生效）
        if (inputMode === 'modifier' &&
            !this._isModifierActive(e)) return;
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
          // mousedown 后备：用户先松 Ctrl 再松鼠标时仍能生效
          if (!this._isModifierActive(e)) return;
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
      // 记录 mousedown 时的修饰键状态：用户常在划选后先松 Ctrl 再松鼠标，
      // 此时 mouseup.ctrlKey 已为 false。用 mousedown 时的状态作为后备，
      // 只要按下时按住了修饰键即视为有效触发。
      this._mouseDownModifierActive = this.helpers.isSelectionModifierPressed
        ? this.helpers.isSelectionModifierPressed(e, this.config.selectionModifier)
        : false;
    },

    /**
     * 判断 modifier 模式下的修饰键是否生效
     * 优先检查 mouseup 事件属性；若 mousedown 时按住了修饰键也视为生效，
     * 兼容「先松键后松鼠标」的操作习惯。
     * @param {MouseEvent} e - mouseup 事件
     * @returns {boolean}
     */
    _isModifierActive(e) {
      if (!this.helpers || !this.helpers.isSelectionModifierPressed) return false;
      return this.helpers.isSelectionModifierPressed(e, this.config.selectionModifier)
        || !!this._mouseDownModifierActive;
    },

    showFloatButton(x, y, text) {
      this.hideFloatButton();

      // Stage F：浮钮挂进 shadow host，页面级定位由 host 承载
      const { host, root } = this.createShadowHost('yuxtrans-host-float-btn');
      const btn = document.createElement('button');
      btn.className = 'yuxtrans-float-btn';
      btn.textContent = '翻译';

      // 限制在可视区域内，避免贴边
      const btnWidth = 60;
      const btnHeight = 32;
      const padding = 8;
      const left = Math.min(Math.max(padding, x + 10), window.innerWidth - btnWidth - padding);
      const top = Math.min(Math.max(padding, y + 10), window.innerHeight - btnHeight - padding);
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.translateText(text, left, top + btnHeight);
        this.hideFloatButton();
      });

      btn._yxtHost = host;
      root.appendChild(btn);
      document.body.appendChild(host);
      this.floatBtn = btn;
    },

    hideFloatButton() {
      if (this.floatBtn) {
        this._removeFloatingUI(this.floatBtn);
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
      // SW 重启/扩展重载后 chrome.runtime 上下文失效，防御性检查避免抛未捕获异常
      if (!chrome.runtime?.id) {
        clearTimeout(this._translateWatchdog);
        this._translateWatchdog = null;
        this.isTranslating = false;
        this._takePopupForRequest(requestId);
        this.updatePopup('扩展已重新加载，请刷新页面', false, 'error', undefined, popup);
        return;
      }
      try {
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
      } catch (e) {
        // Extension context invalidated：SW 已卸载，清理在途状态与浮窗
        clearTimeout(this._translateWatchdog);
        this._translateWatchdog = null;
        this.isTranslating = false;
        this._takePopupForRequest(requestId);
        this.updatePopup('扩展已重新加载，请刷新页面', false, 'error', undefined, popup);
      }
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
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-pin-btn" title="钉住浮窗，不被新划词覆盖" aria-label="钉住浮窗"><svg class="yuxtrans-pin-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7z"/></svg></button>
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-insert-btn" hidden title="将译文插入输入框" aria-label="插入译文"><svg class="yuxtrans-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-copy-btn" title="复制译文" aria-label="复制译文"><svg class="yuxtrans-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg></button>
            <button type="button" class="yuxtrans-btn yuxtrans-btn-secondary yuxtrans-bad-btn" title="标记差译并清除缓存" aria-label="标记差译"><svg class="yuxtrans-action-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg></button>
          </div>
        </div>
      `;

      // Stage F：浮窗挂进 shadow host，页面级定位（left/top/z-index）由 host 承载
      const { host, root } = this.createShadowHost('yuxtrans-host-popup');
      popup._yxtHost = host;
      root.appendChild(popup);
      document.body.appendChild(host);
      this.popup = popup;
      this.popup.dataset.sourceText = sourceText;

      // 长原文折叠：超过 4 行时默认收起为 3 行 + 展开/收起开关，
      // 避免长段落划词时浮窗超出屏幕（译文区另有 max-height 内部滚动兜底）。
      // rAF 回调在下一帧绘制前执行，折叠 class 于首帧前生效，无全文闪跳
      const sourceEl = popup.querySelector('.yuxtrans-source');
      if (sourceEl) {
        requestAnimationFrame(() => {
          if (!popup.isConnected) return;
          const lineH = parseFloat(getComputedStyle(sourceEl).lineHeight) || 21;
          if (sourceEl.scrollHeight > lineH * 4) {
            sourceEl.classList.add('is-collapsed');
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'yuxtrans-source-toggle';
            toggle.textContent = '展开原文';
            toggle.addEventListener('click', () => {
              const collapsed = sourceEl.classList.toggle('is-collapsed');
              toggle.textContent = collapsed ? '展开原文' : '收起原文';
            });
            sourceEl.after(toggle);
          }
        });
      }

      // header 换真实信息：语言对 + 供应商（替换品牌噪音 YuxTrans）
      this._updatePopupTitle();

      // 实际尺寸出来后，再定位并限制在可视区域（坐标写在 host 上）
      requestAnimationFrame(() => {
        if (!this.popup) return;
        const rect = this.popup.getBoundingClientRect();
        const padding = 16;
        const maxX = window.innerWidth - rect.width - padding;
        const maxY = window.innerHeight - rect.height - padding;
        host.style.left = `${Math.min(Math.max(padding, x), maxX)}px`;
        host.style.top = `${Math.min(Math.max(padding, y), maxY)}px`;
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
      // 已 pin 的浮窗：从列表移除并销毁（连同 shadow host）
      const idx = this.pinnedPopups.indexOf(popup);
      if (idx >= 0) this.pinnedPopups.splice(idx, 1);
      this._removeFloatingUI(popup);
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

      // Stage F：拖拽移动的是 shadow host（页面级坐标所在），内部浮窗保持静态占满 host
      const host = popup._yxtHost || popup;
      const rect = popup.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      // 切换为 fixed 定位以保证拖拽后位置稳定（host 默认已由 yuxtrans-host-popup 置为 fixed）
      host.style.position = 'fixed';

      const onMove = (ev) => {
        const w = rect.width;
        const h = rect.height;
        const left = Math.max(0, Math.min(ev.clientX - offsetX, window.innerWidth - w));
        const top = Math.max(0, Math.min(ev.clientY - offsetY, window.innerHeight - h));
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
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
        this._removeFloatingUI(this.popup);
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
