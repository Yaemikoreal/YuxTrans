/**
 * Options Script
 * 支持完整的设置功能：自定义供应商、语言设置、操作行为、历史记录
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ===== 元素引用 =====
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  // 翻译引擎
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const localModelInput = document.getElementById('localModel');
  const cacheEnabledInput = document.getElementById('cacheEnabled');
  const cacheSizeInput = document.getElementById('cacheSize');
  const apiKeyGroup = document.getElementById('apiKeyGroup');
  const localModelGroup = document.getElementById('localModelGroup');
  const customProviderSection = document.getElementById('customProviderSection');

  // 自定义供应商
  const customNameInput = document.getElementById('customName');
  const customEndpointInput = document.getElementById('customEndpoint');
  const customApiKeyInput = document.getElementById('customApiKey');
  const customFormatSelect = document.getElementById('customFormat');
  const customModelInput = document.getElementById('customModel');

  // 语言设置
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const translateStyleRadios = document.querySelectorAll('input[name="translateStyle"]');

  // 操作行为
  const triggerModeRadios = document.querySelectorAll('input[name="triggerMode"]');
  const autoCopyInput = document.getElementById('autoCopy');
  const showFloatBtnInput = document.getElementById('showFloatBtn');
  const siteRuleSelect = document.getElementById('siteRule');
  const siteListTextarea = document.getElementById('siteList');
  const autoDetectLangInput = document.getElementById('autoDetectLang');

  // 历史记录
  const saveHistoryInput = document.getElementById('saveHistory');
  const historyListEl = document.getElementById('historyList');

  // 按钮
  const saveBtn = document.getElementById('saveBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const testConnectionBtn = document.getElementById('testConnectionBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const exportHistoryBtn = document.getElementById('exportHistoryBtn');
  const statusEl = document.getElementById('status');
  const testResultEl = document.getElementById('testResult');

  // ===== 加载配置 =====
  const config = await chrome.runtime.sendMessage({ action: 'getConfig' });

  if (config) {
    // 翻译引擎
    providerSelect.value = config.provider || 'qwen';
    apiKeyInput.value = config.apiKey || '';
    localModelInput.value = config.localModel || 'qwen2:7b';
    cacheEnabledInput.checked = config.cacheEnabled !== false;
    cacheSizeInput.value = config.cacheSize || 1000;

    // 自定义供应商
    if (config.customProvider) {
      customNameInput.value = config.customProvider.name || '';
      customEndpointInput.value = config.customProvider.endpoint || '';
      customApiKeyInput.value = config.customProvider.apiKey || '';
      customFormatSelect.value = config.customProvider.format || 'openai';
      customModelInput.value = config.customProvider.model || '';
    }

    // 语言设置
    sourceLangSelect.value = config.sourceLang || 'auto';
    targetLangSelect.value = config.targetLang || 'zh';

    const styleValue = config.translateStyle || 'normal';
    translateStyleRadios.forEach(radio => {
      radio.checked = radio.value === styleValue;
    });

    // 操作行为
    const triggerValue = config.triggerMode || 'auto';
    triggerModeRadios.forEach(radio => {
      radio.checked = radio.value === triggerValue;
    });

    autoCopyInput.checked = config.autoCopy === true;
    showFloatBtnInput.checked = config.showFloatBtn !== false;
    siteRuleSelect.value = config.siteRule || 'all';
    siteListTextarea.value = (config.siteList || []).join('\n');
    autoDetectLangInput.checked = config.autoDetectLang !== false;

    // 历史记录
    saveHistoryInput.checked = config.saveHistory !== false;
  }

  // 加载历史记录
  await loadHistory();

  // ===== 标签页切换 =====
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // ===== 供应商 UI 更新 =====
  function updateProviderUI() {
    const provider = providerSelect.value;
    const isLocal = provider === 'local';
    const isCustom = provider === 'custom';

    apiKeyGroup.style.display = isLocal || isCustom ? 'none' : 'block';
    localModelGroup.style.display = isLocal ? 'block' : 'none';
    customProviderSection.classList.toggle('show', isCustom);
  }

  providerSelect.addEventListener('change', updateProviderUI);
  updateProviderUI();

  // ===== 测试连接 =====
  testConnectionBtn.addEventListener('click', async () => {
    const endpoint = customEndpointInput.value.trim();
    const apiKey = customApiKeyInput.value.trim();
    const format = customFormatSelect.value;
    const model = customModelInput.value.trim();

    if (!endpoint) {
      showTestResult(false, '请输入 API 地址');
      return;
    }

    if (!model) {
      showTestResult(false, '请输入模型名称');
      return;
    }

    testConnectionBtn.disabled = true;
    testConnectionBtn.textContent = '🔄 测试中...';
    testResultEl.style.display = 'none';

    const startTime = Date.now();

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testConnection',
        config: { endpoint, apiKey, format, model }
      });

      const elapsed = Date.now() - startTime;

      if (response && response.success) {
        showTestResult(true, `连接成功！响应时间: ${elapsed}ms`, elapsed);
      } else {
        showTestResult(false, response?.error || '连接失败');
      }
    } catch (error) {
      showTestResult(false, `测试失败: ${error.message}`);
    } finally {
      testConnectionBtn.disabled = false;
      testConnectionBtn.textContent = '🔗 测试连接';
    }
  });

  function showTestResult(success, message, time) {
    testResultEl.className = `test-result ${success ? 'success' : 'error'}`;
    testResultEl.innerHTML = `<div>${success ? '✅' : '❌'} ${message}</div>`;
    testResultEl.style.display = 'block';
  }

  // ===== 保存设置 =====
  saveBtn.addEventListener('click', async () => {
    const newConfig = {
      // 翻译引擎
      provider: providerSelect.value,
      apiKey: apiKeyInput.value,
      localModel: localModelInput.value,
      cacheEnabled: cacheEnabledInput.checked,
      cacheSize: parseInt(cacheSizeInput.value, 10),

      // 自定义供应商
      customProvider: {
        name: customNameInput.value.trim(),
        endpoint: customEndpointInput.value.trim(),
        apiKey: customApiKeyInput.value.trim(),
        format: customFormatSelect.value,
        model: customModelInput.value.trim()
      },

      // 语言设置
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      translateStyle: document.querySelector('input[name="translateStyle"]:checked')?.value || 'normal',

      // 操作行为
      triggerMode: document.querySelector('input[name="triggerMode"]:checked')?.value || 'auto',
      autoCopy: autoCopyInput.checked,
      showFloatBtn: showFloatBtnInput.checked,
      siteRule: siteRuleSelect.value,
      siteList: siteListTextarea.value.split('\n').map(s => s.trim()).filter(Boolean),
      autoDetectLang: autoDetectLangInput.checked,

      // 历史记录
      saveHistory: saveHistoryInput.checked
    };

    const response = await chrome.runtime.sendMessage({
      action: 'setConfig',
      config: newConfig
    });

    if (response && response.success) {
      showStatus('设置已保存', 'success');
    } else {
      showStatus('保存失败: ' + (response?.error || '未知错误'), 'error');
    }
  });

  // ===== 清除缓存 =====
  clearCacheBtn.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ action: 'clearCache' });

    if (response && response.success) {
      showStatus('缓存已清除', 'success');
    } else {
      showStatus('清除失败', 'error');
    }
  });

  // ===== 历史记录 =====
  async function loadHistory() {
    const response = await chrome.runtime.sendMessage({ action: 'getHistory' });

    if (response && response.history && response.history.length > 0) {
      historyListEl.innerHTML = response.history.slice(0, 50).map(item => `
        <div class="history-item">
          <div class="history-text">
            <div class="history-source">${escapeHtml(item.source)}</div>
            <div class="history-target">${escapeHtml(item.target)}</div>
          </div>
          <div class="history-time">${formatTime(item.timestamp)}</div>
        </div>
      `).join('');
    } else {
      historyListEl.innerHTML = '<div class="history-empty">暂无翻译历史</div>';
    }
  }

  clearHistoryBtn.addEventListener('click', async () => {
    if (confirm('确定要清除所有翻译历史吗？')) {
      const response = await chrome.runtime.sendMessage({ action: 'clearHistory' });
      if (response && response.success) {
        showStatus('历史记录已清除', 'success');
        await loadHistory();
      }
    }
  });

  exportHistoryBtn.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ action: 'getHistory' });

    if (response && response.history && response.history.length > 0) {
      const data = JSON.stringify(response.history, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `yuxtrans-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();

      URL.revokeObjectURL(url);
      showStatus('历史记录已导出', 'success');
    } else {
      showStatus('暂无历史记录可导出', 'error');
    }
  });

  // ===== 工具函数 =====
  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = 'block';

    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 3000);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return date.toLocaleDateString('zh-CN');
  }
});