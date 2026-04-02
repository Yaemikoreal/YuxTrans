/**
 * Popup Script
 * 处理翻译请求、更新检查、UI交互
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ===== 元素引用 =====
  const inputText = document.getElementById('inputText');
  const translateBtn = document.getElementById('translateBtn');
  const resultArea = document.getElementById('resultArea');
  const resultText = document.getElementById('resultText');
  const copyBtn = document.getElementById('copyBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusText = document.getElementById('statusText');
  const settingsBtn = document.getElementById('settingsBtn');
  const updateBtn = document.getElementById('updateBtn');
  const versionBadge = document.getElementById('versionBadge');
  const updateToast = document.getElementById('updateToast');

  // ===== 显示版本号 =====
  const manifest = chrome.runtime.getManifest();
  versionBadge.textContent = `v${manifest.version}`;

  // ===== 加载配置 =====
  let config = await chrome.runtime.sendMessage({ action: 'getConfig' });

  // ===== 翻译功能 =====
  translateBtn.addEventListener('click', async () => {
    const text = inputText.value.trim();
    if (!text) {
      showToast('请输入要翻译的文本', true);
      return;
    }

    translateBtn.disabled = true;
    translateBtn.textContent = '翻译中...';
    resultArea.style.display = 'none';

    const startTime = Date.now();

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'translate',
        text: text,
        sourceLang: config.sourceLang || 'auto',
        targetLang: config.targetLang || 'zh'
      });

      const elapsed = Date.now() - startTime;

      if (response && response.success) {
        resultText.textContent = response.text;
        resultArea.style.display = 'block';

        const engineText = response.cached ? '缓存' : response.engine;
        statusText.textContent = `翻译完成 · ${elapsed}ms · ${engineText}`;

        // 自动复制
        if (config.autoCopy) {
          await copyToClipboard(response.text);
          statusText.textContent += ' · 已复制';
        }
      } else {
        showToast(response?.error || '翻译失败', true);
      }
    } catch (error) {
      showToast(`翻译出错: ${error.message}`, true);
    } finally {
      translateBtn.disabled = false;
      translateBtn.textContent = '翻译';
    }
  });

  // ===== 复制结果 =====
  copyBtn.addEventListener('click', async () => {
    const text = resultText.textContent;
    if (text) {
      await copyToClipboard(text);
      showToast('已复制到剪贴板');
    }
  });

  // ===== 清空 =====
  clearBtn.addEventListener('click', () => {
    inputText.value = '';
    resultArea.style.display = 'none';
    statusText.textContent = '';
  });

  // ===== 设置页面 =====
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ===== 检查更新 =====
  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = '🔄 检查中...';

    try {
      // 使用 Chrome 扩展更新检查 API
      const result = await chrome.runtime.requestUpdateCheck();

      switch (result.status) {
        case 'update_available':
          showToast('发现新版本，正在更新...');
          // Chrome 会自动下载并应用更新
          // 提示用户重启扩展
          setTimeout(() => {
            showToast('更新已下载，点击刷新页面生效', false);
          }, 2000);
          break;

        case 'no_update':
          showToast('当前已是最新版本');
          break;

        case 'throttled':
          showToast('检查太频繁，请稍后再试', true);
          break;

        default:
          showToast('检查结果未知', true);
      }
    } catch (error) {
      // 如果 API 不可用（开发模式），显示提示
      if (error.message.includes('not available')) {
        showToast('开发模式下无法检查更新');
      } else {
        showToast(`检查失败: ${error.message}`, true);
      }
    } finally {
      updateBtn.disabled = false;
      updateBtn.textContent = '🔄 更新';
    }
  });

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

  // ===== 监听配置更新 =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'configUpdated') {
      config = request.config;
    }
  });

  // ===== 初始化焦点 =====
  inputText.focus();
});
