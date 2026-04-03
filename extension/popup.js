/**
 * Popup Script
 * 处理翻译请求、更新检查、UI交互
 */

document.addEventListener('DOMContentLoaded', async () => {
  const getById = (id) => document.getElementById(id);

  // ===== 元素引用 =====
  const inputText = getById('inputText');
  const translateBtn = getById('translateBtn');
  const resultArea = getById('resultArea');
  const resultText = getById('resultText');
  const copyBtn = getById('copyBtn');
  const clearBtn = getById('clearBtn');
  const statusText = getById('statusText');
  const settingsBtn = getById('settingsBtn');
  const versionBadge = getById('versionBadge');
  const updateToast = getById('updateToast');
  
  const currentSourceLang = getById('currentSourceLang');
  const currentTargetLang = getById('currentTargetLang');
  const switchLangBtn = getById('switchLangBtn');

  // ===== 语言映射 =====
  const langNames = {
    'auto': '自动检测', 'zh': '中文', 'zh-TW': '繁体中文',
    'en': '英文', 'ja': '日文', 'ko': '韩文',
    'fr': '法文', 'de': '德文', 'es': '西班牙文',
    'ru': '俄文', 'pt': '葡萄牙文', 'it': '意大利文',
    'ar': '阿拉伯文', 'th': '泰文', 'vi': '越南文'
  };

  function updateLangDisplay() {
    currentSourceLang.textContent = langNames[config.sourceLang] || config.sourceLang;
    currentTargetLang.textContent = langNames[config.targetLang] || config.targetLang;
  }

  if (versionBadge) {
    const manifest = chrome.runtime.getManifest();
    versionBadge.textContent = `v${manifest.version}`;
  }

  // ===== 加载配置 =====
  let config = await chrome.runtime.sendMessage({ action: 'getConfig' });
  updateLangDisplay();

  // ===== 语言切换 =====
  switchLangBtn.addEventListener('click', async () => {
    let newSource = config.targetLang;
    let newTarget = config.sourceLang;
    
    // 如果原先源语言是'自动检测'，则翻转后目标语言应该是对立的语言，而不是变为'auto'
    if (newTarget === 'auto') {
      newTarget = newSource.startsWith('zh') ? 'en' : 'zh';
    }
    
    config.sourceLang = newSource;
    config.targetLang = newTarget;
    
    updateLangDisplay();
    await chrome.runtime.sendMessage({ action: 'setConfig', config });
    showToast('语言方向已切换');
  });

  updateLangDisplay();

  // ===== 翻译功能 (核心修复：增加 null 检查) =====
  if (translateBtn) {
    translateBtn.addEventListener('click', async () => {
      const text = inputText ? inputText.value.trim() : '';
      if (!text) {
        showToast('请输入要翻译的文本', true);
        return;
      }

      translateBtn.disabled = true;
      translateBtn.textContent = '翻译中...';
      
      // 立即显示结果区以承接流式输出
      if (resultText) resultText.textContent = '';
      if (statusText) statusText.textContent = '连接中...';
      if (resultArea) resultArea.style.display = 'block';

      const startTime = Date.now();

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'translateStream',
          text: text,
          sourceLang: config.sourceLang || 'auto',
          targetLang: config.targetLang || 'zh'
        });

        const elapsed = Date.now() - startTime;

        if (response && response.success) {
          if (resultText) resultText.textContent = response.text;

          const engineText = response.cached ? '缓存' : response.engine;
          if (statusText) statusText.textContent = `翻译完成 · ${elapsed}ms · ${engineText}`;

          // 自动复制
          if (config.autoCopy) {
            await copyToClipboard(response.text);
            if (statusText) statusText.textContent += ' · 已复制';
          }
        } else {
          if (resultArea) resultArea.style.display = 'none';
          showToast(response?.error || '翻译失败', true);
        }
      } catch (error) {
        showToast(`翻译出错: ${error.message}`, true);
      } finally {
        translateBtn.disabled = false;
        translateBtn.textContent = '翻译';
      }
    });
  }

  // ===== 复制结果 =====
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = resultText ? resultText.textContent : '';
      if (text) {
        await copyToClipboard(text);
        showToast('已复制到剪贴板');
      }
    });
  }

  // ===== 清空 =====
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (inputText) {
        inputText.value = '';
        inputText.focus();
      }
      if (resultText) resultText.textContent = '';
      if (resultArea) resultArea.style.display = 'none';
    });
  }

  // ===== 快捷键绑定 =====
  inputText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      translateBtn.click();
    }
  });

  // 移除反馈按钮监听（UI 已精简）
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // ===== 快捷键 =====
  inputText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      translateBtn.click();
    }
  });

  // ===== 工具函数 =====
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 降级方案
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return true;
    }
  }

  function showToast(message, isError = false) {
    updateToast.textContent = message;
    updateToast.className = `update-toast show ${isError ? 'error' : ''}`;

    setTimeout(() => {
      updateToast.className = 'update-toast';
    }, 3000);
  }

  // ===== 监听事件传递 =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'configUpdated') {
      config = request.config;
    } else if (request.action === 'streamChunk') {
      // 流式输出实时渲染
      resultText.textContent = request.fullText;
      statusText.textContent = '翻译中...';
    }
  });

  // ===== 初始化焦点 =====
  inputText.focus();
});
