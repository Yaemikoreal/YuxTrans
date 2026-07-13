/**
 * Popup Script (Control Dashboard)
 * 小巧的控制面板：整页翻译、流式开关、模型切换、连接状态、用量看板
 */

document.addEventListener('DOMContentLoaded', async () => {
  const getById = (id) => document.getElementById(id);

  // ===== 元素引用 =====
  const versionBadge = getById('versionBadge');
  const settingsBtn = getById('settingsBtn');
  const connectionStatus = getById('connectionStatus');
  const connectionText = getById('connectionText');
  const modelSelect = getById('modelSelect');
  const translatePageBtn = getById('translatePageBtn');
  const streamToggle = getById('streamToggle');
  const tokenStat = getById('tokenStat');
  const cacheHitStat = getById('cacheHitStat');
  const hotwordStat = getById('hotwordStat');
  const toast = getById('toast');

  let config = {};
  let modelRecords = [];
  let statsInterval = null;

  // ===== 初始化 =====
  try {
    const manifest = chrome.runtime.getManifest();
    versionBadge.textContent = `v${manifest.version}`;
  } catch (e) {}

  settingsBtn?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ===== 加载配置与 ProviderProfile =====
  async function loadData() {
    try {
      config = await chrome.runtime.sendMessage({ action: 'getConfig' }) || {};
    } catch (e) {
      config = {};
    }

    try {
      const res = await chrome.runtime.sendMessage({ action: 'getProfiles' });
      modelRecords = res?.success ? (res.profiles || []) : [];
    } catch (e) {
      modelRecords = [];
    }
  }

  await loadData();

  // ===== 模型切换下拉栏 =====
  function renderModelSelect() {
    modelSelect.innerHTML = '';

    if (modelRecords.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '请先在设置页添加模型';
      modelSelect.appendChild(opt);
      modelSelect.disabled = true;
      return;
    }

    modelSelect.disabled = false;
    const currentId = config.activeProfileId || '';

    modelRecords.forEach((record) => {
      const opt = document.createElement('option');
      opt.value = record.id;
      const providerLabel = PROVIDER_NAMES[record.provider] || record.provider;
      const modelName = record.model || record.localModel || 'default';
      opt.textContent = `${providerLabel} · ${modelName}`;
      if (record.id === currentId) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }

  function getActiveProfile(cfg) {
    if (!cfg?.profiles || !cfg.activeProfileId) return null;
    return cfg.profiles.find((p) => p.id === cfg.activeProfileId) || null;
  }

  modelSelect?.addEventListener('change', async () => {
    const selectedId = modelSelect.value;
    const record = modelRecords.find((r) => r.id === selectedId);
    if (!record) return;

    try {
      const res = await chrome.runtime.sendMessage({ action: 'setActiveProfile', profileId: record.id });
      if (res?.success) {
        config = await chrome.runtime.sendMessage({ action: 'getConfig' }) || {};
        showToast(`已切换至 ${PROVIDER_NAMES[record.provider] || record.provider}`);
        await checkConnection();
      } else {
        showToast(res?.error || '切换失败', true);
      }
    } catch (e) {
      showToast(`切换异常: ${e.message}`, true);
    }
  });

  // ===== 连接状态检测 =====
  async function checkConnection() {
    setConnectionStatus('checking', '检测中');
    try {
      const res = await chrome.runtime.sendMessage({ action: 'checkConnection' });
      if (res?.success) {
        setConnectionStatus('ok', '可连接');
      } else {
        const msg = res?.error || '连接失败';
        setConnectionStatus('error', msg.length > 8 ? '连接失败' : msg);
      }
    } catch (e) {
      setConnectionStatus('error', '未响应');
    }
  }

  function setConnectionStatus(type, text) {
    connectionStatus.className = `status-pill ${type}`;
    connectionText.textContent = text;
  }

  // ===== 整页翻译 =====
  translatePageBtn?.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showToast('无法获取当前标签页', true);
        return;
      }
      await chrome.tabs.sendMessage(tab.id, { action: 'translatePage' });
      window.close();
    } catch (e) {
      showToast('整页翻译触发失败，请刷新页面后重试', true);
    }
  });

  // ===== 流式翻译开关 =====
  streamToggle.checked = config.enableStreaming !== false;
  streamToggle?.addEventListener('change', async () => {
    try {
      await chrome.runtime.sendMessage({
        action: 'setConfig',
        config: { enableStreaming: streamToggle.checked }
      });
      showToast(streamToggle.checked ? '流式翻译已开启' : '流式翻译已关闭');
    } catch (e) {
      showToast('设置保存失败', true);
    }
  });

  // ===== 用量与缓存看板 =====
  function formatCompact(n) {
    if (n === undefined || n === null || Number.isNaN(n)) return '--';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  async function updateStats() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getCacheStats' });
      if (!res?.success) return;

      const { usage, stats } = res;
      const sessionTokens = usage?.sessionTokens ?? 0;
      const totalTokens = usage?.totalTokens ?? 0;
      tokenStat.textContent = `${formatCompact(sessionTokens)} / ${formatCompact(totalTokens)}`;

      const total = usage?.totalCount || 0;
      const hits = usage?.cacheHits || 0;
      const rate = total > 0 ? Math.round((hits / total) * 100) : 0;
      cacheHitStat.textContent = `${rate}%`;

      hotwordStat.textContent = formatCompact(stats?.wordCount);
    } catch (e) {
      // 静默失败，避免破坏面板
    }
  }

  // ===== 工具函数 =====
  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.className = `toast${isError ? ' error' : ''} show`;
    setTimeout(() => {
      toast.className = 'toast';
    }, 2500);
  }

  // ===== 启动 =====
  renderModelSelect();
  await checkConnection();
  await updateStats();
  statsInterval = setInterval(updateStats, 4000);

  // 面板关闭时清理定时器
  window.addEventListener('unload', () => {
    if (statsInterval) clearInterval(statsInterval);
  });
});
