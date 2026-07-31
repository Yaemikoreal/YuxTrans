/**
 * 单词词典方法（content 拆分模块）
 * 依赖：content.js 先注入（YuxTransContent 类）
 */
(function () {
  const Ctor = (typeof YuxTransContent !== 'undefined' ? YuxTransContent : null)
    || (typeof globalThis !== 'undefined' ? globalThis.YuxTransContent : null);
  if (!Ctor) return;
  Object.assign(Ctor.prototype, {
    /**
     * F2：双击单词直出词典卡片（icon/contextMenu 模式下也直出，绕过浮钮）
     */
    _handleDblClick(e) {
      if (!this.config.dictDblclick || !this.config.dictMode) return;
      if (this._eventClosest(e, '.yuxtrans-popup, .yuxtrans-float-btn')) return;
      // #2：双击直出词典前清除可能残留的悬浮按钮（icon 模式）
      this.hideFloatButton();
      this._lastInputElement = null;
      setTimeout(() => {
        const sel = window.getSelection().toString().trim();
        if (!sel) return;
        const isWord = this.helpers.isSingleWord(sel);
        if (isWord) this.lookupWord(sel, e.clientX, e.clientY);
      }, YuxContentConsts.SELECTION_READ_DELAY_MS);
    },

    /**
     * F2：单词词典查询--走结构化词典卡片（音标/义项/例句）
     */
    lookupWord(word, x, y) {
      if (!this.isSiteAllowed()) return;
      // #11：词典查询独立在途标志，不再与划词翻译互堵
      if (this.isDictLookingUp) return;

      const selection = window.getSelection();
      let rect = { left: x || 100, top: y || 100, width: 0, height: 0 };
      if (selection.rangeCount > 0) {
        rect = selection.getRangeAt(0).getBoundingClientRect();
      }
      // 复用浮窗骨架，source 区显示单词原文
      this.showPopup(rect.left, rect.bottom + 10, word);
      const popup = this.popup;
      this.isDictLookingUp = true;
      // #11：70s 看门狗——SW 不回包时复位在途标志，避免永久卡死
      clearTimeout(this._dictWatchdog);
      this._dictWatchdog = setTimeout(() => {
        this._dictWatchdog = null;
        this.isDictLookingUp = false;
        console.warn('[YuxTrans] 词典查询 70s 无响应，已复位在途标志');
      }, YuxContentConsts.WATCHDOG_TIMEOUT_MS);
      if (this._dictWatchdog.unref) this._dictWatchdog.unref(); // Node 测试环境不阻塞进程退出
      popup.dataset.mode = 'dict';
      // F5：输入框触发时显示"插入译文"按钮
      this._toggleInsertBtn();

      const sourceLang = this.config.sourceLang || 'auto';
      const targetLang = this.config.targetLang || 'zh';
      // #4：登记 requestId -> 浮窗映射，响应路由回捕获的浮窗（pin 或快速连划不串台）
      const requestId = this._registerPopupRequest(popup);
      chrome.runtime.sendMessage(
        { action: 'lookupWord', text: word, sourceLang, targetLang, context: this.getPageContext(), requestId },
        (response) => {
          clearTimeout(this._dictWatchdog);
          this._dictWatchdog = null;
          this.isDictLookingUp = false;
          const target = this._takePopupForRequest(requestId);
          if (!target) return; // 浮窗已销毁：丢弃响应
          if (response && response.success) {
            this.renderDictResult(response.dict, response.cached, word, target);
          } else {
            const userError = response && response.userError;
            const msg = userError
              ? (this.helpers.formatUserErrorCompact ? this.helpers.formatUserErrorCompact(userError) : userError.userMessage)
              : (response && response.error) || '词典查询失败';
            this.updatePopup(msg, false, 'error', word, target);
          }
        }
      );
    },

    /**
     * F2：渲染词典卡片（结构化结果）
     * @param {Object} dict - {word, phonetic, senses:[{pos, meaning, examples:[{source,target}]}], raw}
     * @param {boolean} cached
     * @param {string} word
     * @param {Element|null} [popupEl] - #4 目标浮窗（缺省 this.popup）
     */
    renderDictResult(dict, cached, word, popupEl) {
      const popup = popupEl || this.popup;
      if (!popup) return;
      const targetEl = popup.querySelector('.yuxtrans-target');
      if (!targetEl) return;
      targetEl.textContent = '';

      const hasSenses = dict && Array.isArray(dict.senses) && dict.senses.length > 0;
      const hasRaw = !!(dict && dict.raw);
      // 无结构化词典 -> 降级纯文本（本地小模型或解析失败）
      if (!hasSenses) {
        this.updatePopup(hasRaw ? dict.raw : ((word || '') + '：暂无词典释义'), cached, 'cache', word, popup);
        return;
      }

      // 隐藏 source（dict.word 大字已显示单词，避免重复）
      const sourceEl = popup.querySelector('.yuxtrans-source');
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
      const statusEl = popup.querySelector('.yuxtrans-status');
      const badgeClass = cached ? 'cache' : 'cloud';
      // eslint-disable-next-line no-unsanitized/property -- 徽标类名与文案均为字面量枚举
      statusEl.innerHTML = '<span class="yuxtrans-status-badge ' + badgeClass + '">' +
        (cached ? '缓存命中' : '云端') + '</span>';

      // 复制内容为纯文本版（单词 + 各义项）
      const parts = dict.senses.map((s) =>
        (s.pos ? s.pos + ' ' : '') + (s.meaning || '')
      ).filter(Boolean);
      popup.dataset.translation = (dict.word || word || '') + (parts.length ? ' ' + parts.join('; ') : '');

      // 复制 / 差译按钮可见
      const badBtn = popup.querySelector('.yuxtrans-bad-btn');
      const copyBtn = popup.querySelector('.yuxtrans-copy-btn');
      if (badBtn) { badBtn.hidden = false; badBtn.disabled = false; }
      if (copyBtn) { copyBtn.hidden = false; copyBtn.disabled = false; }

      // 自动复制（仅当前浮窗，避免 pinned 浮窗响应触发误复制）
      if (this.config.autoCopy && popup === this.popup) this.copyPopupTranslation();
    }
  });
})();
