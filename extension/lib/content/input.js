/**
 * 输入框翻译方法（content 拆分模块）
 * 依赖：content.js 先注入（YuxTransContent 类）
 */
(function () {
  const Ctor = (typeof YuxTransContent !== 'undefined' ? YuxTransContent : null)
    || (typeof globalThis !== 'undefined' ? globalThis.YuxTransContent : null);
  if (!Ctor) return;
  Object.assign(Ctor.prototype, {
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
    },

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
    },

    /**
     * F5：根据是否由输入框触发，切换"插入译文"按钮可见性
     */
    _toggleInsertBtn() {
      if (!this.popup) return;
      const btn = this.popup.querySelector('.yuxtrans-insert-btn');
      if (btn) btn.hidden = !this._lastInputElement;
    }
  });
})();
