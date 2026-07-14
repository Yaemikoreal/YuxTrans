/**
 * Options Script
 * 支持完整的设置功能：自定义供应商、语言设置、操作行为、历史记录
 */

document.addEventListener('DOMContentLoaded', async () => {
  // ===== 元素引用 (增加防御性) =====
  const getById = (id) => document.getElementById(id);
  const getAll = (sel) => document.querySelectorAll(sel);

  const tabs = getAll('.tab');
  const tabContents = getAll('.tab-content');

  // 1. 翻译引擎
  const providerSelect = getById('provider');
  const apiKeyInput = getById('apiKey');
  const apiEndpointInput = getById('apiEndpoint');
  const modelSelect = getById('modelSelect');
  const fetchModelsBtn = getById('fetchModelsBtn');
  const testProviderBtn = getById('testProviderBtn');
  const localModelInput = getById('localModel');
  const localModelSelect = getById('localModelSelect'); // 新增
  const fetchLocalModelsBtn = getById('fetchLocalModelsBtn'); // 新增
  const testLocalBtn = getById('testLocalBtn'); // 新增
  const cacheEnabledInput = getById('cacheEnabled');
  const maxCacheMBInput = getById('maxCacheMB');
  const storageProgressBar = getById('storageProgressBar');
  const storageText = getById('storageText');
  const updateBanner = getById('updateBanner');
  const updateTitle = getById('updateTitle');
  const downloadZipBtn = getById('downloadZipBtn');
  const showGuideBtn = getById('showGuideBtn');
  const apiKeyGroup = getById('apiKeyGroup');
  const endpointGroup = getById('endpointGroup');
  const modelSelectGroup = getById('modelSelectGroup');
  const localModelGroup = getById('localModelGroup');
  const customProviderSection = getById('customProviderSection');

  // 2. 自定义供应商
  const customNameInput = getById('customName');
  const customEndpointInput = getById('customEndpoint');
  const customApiKeyInput = getById('customApiKey');
  const customFormatSelect = getById('customFormat');
  const customModelSelect = getById('customModelSelect');
  const customModelManual = getById('customModelManual');

  // 获取当前实际选中的模型值（下拉框或手动输入）
  function getCustomModelValue() {
    if (customModelSelect.value === '__manual__') {
      return customModelManual.value.trim();
    }
    return customModelSelect.value;
  }

  // 3. 版本号
  const versionBadge = getById('versionBadge');
  if (versionBadge) {
    try {
      const manifest = chrome.runtime.getManifest();
      versionBadge.textContent = `YuxTrans v${manifest.version}`;
    } catch(e) {}
  }

  // 4. 语言设置
  const sourceLangSelect = getById('sourceLang');
  const targetLangSelect = getById('targetLang');
  const translateStyleRadios = getAll('input[name="translateStyle"]');

  // 5. 动作行为设置
  const triggerModeRadios = getAll('input[name="triggerMode"]');
  const autoCopyCheckbox = getById('autoCopy');
  const siteRuleSelect = getById('siteRule');
  const siteListTextarea = getById('siteList');
  const autoDetectLangInput = getById('autoDetectLang');
  const autoFallbackInput = getById('autoFallback');
  const enableStreamingInput = getById('enableStreaming');

  // 6. 统计看板
  const totalTranslatesCountEl = getById('totalTranslatesCount');
  const cacheHitsCountEl = getById('cacheHitsCount');
  const cacheHitRateEl = getById('cacheHitRate');
  let cacheStatsInterval;

  // 8. 诊断数据
  const metricsTotalEl = getById('metricsTotal');
  const metricsSuccessRateEl = getById('metricsSuccessRate');
  const metricsCacheRateEl = getById('metricsCacheRate');
  const metricsAvgLatencyEl = getById('metricsAvgLatency');
  const metricsProviderTableEl = getById('metricsProviderTable');
  const metricsSwInitCountEl = getById('metricsSwInitCount');
  const metricsSwInitAvgEl = getById('metricsSwInitAvg');
  const metricsRecentErrorsEl = getById('metricsRecentErrors');
  const refreshMetricsBtn = getById('refreshMetricsBtn');

  // 9. 请求日志
  const requestLogsContainer = getById('requestLogsContainer');
  const refreshRequestLogsBtn = getById('refreshRequestLogsBtn');

  // 7. 辅助
  const saveBtn = getById('saveBtn');
  const clearCacheBtn = getById('clearCacheBtn');
  const updateBtn = getById('updateBtn');
  const statusEl = getById('status');
  let statusTimeout = null;

  // 工具：状态提示 (高级滑入效果 - 解决竞态冲突)
  function showStatus(message, type) {
    if (!statusEl) return;
    
    // 1. 清理之前的定时器与状态类
    if (statusTimeout) clearTimeout(statusTimeout);
    statusEl.classList.remove('success', 'error');
    
    // 2. 注入新内容并强制重绘以触发动画 (可选)
    statusEl.textContent = message;
    
    // 3. 延迟一小段确保类名移除生效后再添加 (对于 transition 更有利)
    requestAnimationFrame(() => {
      statusEl.classList.add(type);
      statusTimeout = setTimeout(() => {
        statusEl.classList.remove('success', 'error');
        statusTimeout = null;
      }, 3000);
    });
  }

  // ===== 检查更新逻辑 =====
  if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
      updateBtn.disabled = true;
      const originalText = updateBtn.textContent;
      updateBtn.textContent = '检查中...';

      try {
        const result = await chrome.runtime.requestUpdateCheck();
        switch (result.status) {
          case 'update_available':
            showStatus('发现新版本，正在后台更新...', 'success');
            updateBtn.textContent = '发现更新';
            break;
          case 'no_update':
            showStatus('当前已是最新版本', 'success');
            updateBtn.textContent = '检查更新';
            break;
          case 'throttled':
            showStatus('请求太频繁，请稍后再试', 'error');
            updateBtn.textContent = '检查更新';
            break;
          default:
            showStatus('检查状态未知', 'error');
            updateBtn.textContent = '检查更新';
        }
      } catch (error) {
        showStatus(`检查失败: ${error.message}`, 'error');
        updateBtn.textContent = originalText;
      } finally {
        setTimeout(() => { updateBtn.disabled = false; }, 1000);
      }
    });
  }

  // ===== 启动时检查更新状态 (傻瓜式) =====
  chrome.storage.local.get(['updateAvailable'], (data) => {
    if (data.updateAvailable && updateBanner) {
      const info = data.updateAvailable;
      updateBanner.style.display = 'block';
      if (updateTitle) updateTitle.textContent = `发现新版本 v${info.version}`;
      if (downloadZipBtn) downloadZipBtn.href = info.zipUrl || info.url;
      
      // 指引弹窗逻辑
      showGuideBtn?.addEventListener('click', () => {
        const guideHtml = `
          <div style="padding: 20px;">
            <h3 style="margin-top: 0; color: #d8a051; margin-bottom: 20px;">傻瓜式更新指引</h3>
            <div class="guide-step">
              <div class="step-num">1</div>
              <div class="step-content">点击<strong>“立即下载 ZIP”</strong>获取最新代码包，并解压到您的电脑。</div>
            </div>
            <div class="guide-step">
              <div class="step-num">2</div>
              <div class="step-content">在浏览器地址栏输入 <strong>chrome://extensions</strong> 进入扩展管理页。</div>
            </div>
            <div class="guide-step">
              <div class="step-num">3</div>
              <div class="step-content">找到 YuxTrans 插件卡片，点击右下角的<strong>“刷新”图标</strong>（或删除旧版重新拖入）。</div>
            </div>
            <p style="font-size: 12px; color: #999; margin-top: 20px; text-align: center;">更新后，您的 200MB 翻译缓存将自动同步（只要不清除浏览器数据）。</p>
          </div>
        `;
        showModal(guideHtml);
      });
    }
  });

  function showModal(html) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.innerHTML = `
      <div style="background:#fdfbf7; width:450px; border-radius:24px; box-shadow:0 12px 40px rgba(0,0,0,0.2); position:relative; overflow:hidden;">
        ${html}
        <button id="closeModalBtn" class="btn-secondary" style="width:100%; border-radius:0; padding:16px; border:none; background:#f2ede4; color:#3d3733; cursor:pointer; font-weight:600;">我知道了</button>
      </div>
    `;
    document.body.appendChild(modal);
    getById('closeModalBtn')?.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  // ===== 加载配置 =====
  let config = null;
  try {
    config = await chrome.runtime.sendMessage({ action: 'getConfig' });
  } catch (error) {
    console.error('[YuxTrans] 加载系统配置失败:', error);
  }

  // 从 background 获取供应商默认端点与模型列表（单一来源）
  const defaults = { endpoints: {}, models: {} };
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getProviderDefaults' });
    if (res?.success) {
      defaults.endpoints = res.endpoints || {};
      defaults.models = res.models || {};
    }
  } catch (error) {
    console.error('[YuxTrans] 加载供应商默认配置失败:', error);
  }

  function getActiveProfile(cfg) {
    if (!cfg) return null;
    if (cfg.profiles && cfg.activeProfileId) {
      return cfg.profiles.find((p) => p.id === cfg.activeProfileId) || null;
    }
    return null;
  }

  function applyProfileToForm(profile) {
    const fallback = profile || {};
    if (providerSelect) providerSelect.value = fallback.provider || 'qwen';
    if (apiKeyInput) apiKeyInput.value = fallback.apiKey || '';
    if (apiEndpointInput) apiEndpointInput.value = fallback.apiEndpoint || '';
    if (localModelInput) localModelInput.value = fallback.localModel || 'qwen3.5:0.8b';

    const cp = fallback.customProvider || {};
    if (customNameInput) customNameInput.value = cp.name || '';
    if (customEndpointInput) customEndpointInput.value = cp.endpoint || '';
    if (customApiKeyInput) customApiKeyInput.value = cp.apiKey || '';
    if (customFormatSelect) customFormatSelect.value = cp.format || 'openai';

    const savedModel = cp.model || '';
    if (customModelSelect) {
      customModelSelect.innerHTML = '';
      if (savedModel) {
        const opt = document.createElement('option');
        opt.value = savedModel;
        opt.textContent = savedModel;
        customModelSelect.appendChild(opt);
      }
      const manualOpt = document.createElement('option');
      manualOpt.value = '__manual__';
      manualOpt.textContent = '✏️ 手动输入...';
      customModelSelect.appendChild(manualOpt);
      if (savedModel) {
        customModelSelect.value = savedModel;
        if (customModelManual) customModelManual.style.display = 'none';
      } else {
        customModelSelect.value = '__manual__';
        if (customModelManual) customModelManual.style.display = 'block';
      }
    }
    if (customModelManual) customModelManual.value = savedModel;
  }

  if (config) {
    const activeProfile = getActiveProfile(config);
    applyProfileToForm(activeProfile || config);

    if (cacheEnabledInput) cacheEnabledInput.checked = config.cacheEnabled !== false;
    if (maxCacheMBInput) maxCacheMBInput.value = config.maxCacheMB || 200;

    // 语言与风格
    if (sourceLangSelect) sourceLangSelect.value = config.sourceLang || 'auto';
    if (targetLangSelect) targetLangSelect.value = config.targetLang || 'zh';
    translateStyleRadios.forEach((radio) => {
      radio.checked = radio.value === (config.translateStyle || 'normal');
    });

    // 行为
    triggerModeRadios.forEach((radio) => {
      radio.checked = radio.value === (config.triggerMode || 'auto');
    });
    if (autoCopyCheckbox) autoCopyCheckbox.checked = config.autoCopy || false;
    if (siteRuleSelect) siteRuleSelect.value = config.siteRule || 'all';
    if (siteListTextarea) siteListTextarea.value = (config.siteList || []).join('\n');
    if (autoDetectLangInput) autoDetectLangInput.checked = config.autoDetectLang !== false;
    if (autoFallbackInput) autoFallbackInput.checked = config.autoFallback !== false;
    if (enableStreamingInput) enableStreamingInput.checked = config.enableStreaming !== false;
    renderActiveConfig();
  }

  // 渲染当前使用（ActiveConfig 可点击展示）
  function renderActiveConfig() {
    const nameEl = getById('activeProfileName');
    const detailEl = getById('activeProfileDetail');
    if (!nameEl || !detailEl) return;
    const activeProfile = getActiveProfile(config);
    if (!activeProfile) {
      nameEl.textContent = '未选择供应商档案';
      detailEl.textContent = '请在「供应商档案」标签页配置并保存一个档案';
      return;
    }
    const providerLabel = PROVIDER_NAMES[activeProfile.provider] || activeProfile.provider;
    const modelLabel = activeProfile.model || activeProfile.localModel || '';
    nameEl.textContent = activeProfile.label || `${providerLabel} - ${modelLabel || 'default'}`;
    detailEl.textContent = `${providerLabel}${modelLabel ? ' · ' + modelLabel : ''} · ${config.sourceLang || 'auto'} → ${config.targetLang || 'zh'} · ${config.translateStyle || 'normal'}`;
  }

  // 点击「当前使用」卡片跳转到供应商档案标签页
  getById('activeConfigCard')?.addEventListener('click', () => {
    const profileTab = document.querySelector('.tab[data-tab="profiles"]');
    if (profileTab) profileTab.click();
  });

  // 初始化 UI
  updateProviderUI();
  startCacheStatsUpdate();

  // ===== 标签页切换 =====
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      getById(`tab-${targetId}`)?.classList.add('active');
    });
  });

  // ===== 模型列表逻辑 =====
  function loadModelOptions(provider, selectedModel = '') {
    if (!modelSelect) return;
    const models = defaults.models[provider] || [];
    modelSelect.innerHTML = '';
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '请先获取模型列表';
      modelSelect.appendChild(opt);
      return;
    }
    // 如果 selectedModel 不在默认列表中，将其添加到列表头部
    const allModels = selectedModel && !models.includes(selectedModel)
      ? [selectedModel, ...models] : [...models];
    allModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if (m === selectedModel) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }

  function updateProviderUI() {
    const provider = providerSelect.value;
    const isLocal = provider === 'local';
    const isCustom = provider === 'custom';
    if (apiKeyGroup) apiKeyGroup.style.display = (isLocal || isCustom) ? 'none' : 'block';
    if (endpointGroup) endpointGroup.style.display = (isLocal || isCustom) ? 'none' : 'block';
    if (modelSelectGroup) modelSelectGroup.style.display = (isLocal || isCustom) ? 'none' : 'block';
    if (localModelGroup) localModelGroup.style.display = isLocal ? 'block' : 'none';
    if (customProviderSection) customProviderSection.style.display = isCustom ? 'block' : 'none';
    const activeProfile = getActiveProfile(config);
    const selectedModel = activeProfile?.model || config?.model || '';
    if (!isLocal && !isCustom) loadModelOptions(provider, selectedModel);
  }

  providerSelect?.addEventListener('change', updateProviderUI);

  // ===== Ollama 状态检测 =====
  const OLLAMA_API = 'http://localhost:11434';
  const RECOMMENDED_MODEL = 'qwen3.5:0.8b';

  async function checkOllamaStatus() {
    const statusIcon = getById('ollamaStatusIcon');
    const statusText = getById('ollamaStatusText');
    const statusAction = getById('ollamaStatusAction');
    const downloadBtn = getById('downloadModelBtn');
    const copyBtn = getById('copyPullCmdBtn');

    if (!statusIcon || !statusText) return;

    // 阶段 1：检测 Ollama 服务
    statusIcon.className = 'ollama-status-dot checking';
    statusText.textContent = '正在检测 Ollama 服务...';
    if (statusAction) statusAction.style.display = 'none';

    let ollamaRunning = false;
    let models = [];

    try {
      const resp = await fetch(`${OLLAMA_API}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json();
        models = (data.models || []).map(m => m.name);
        ollamaRunning = true;
      }
    } catch (e) {
      ollamaRunning = false;
    }

    if (!ollamaRunning) {
      statusIcon.className = 'ollama-status-dot error';
      statusText.innerHTML = 'Ollama 服务未运行。Windows 可在 PowerShell 执行 <code>irm https://ollama.com/install.ps1 | iex</code> 安装，或运行 <code>setup-ollama.bat</code> 一键配置。国内下载可能较慢；低配机器本地运行可能卡顿，可在设置中启用云端供应商作为备用。';
      if (statusAction) {
        statusAction.style.display = 'block';
        if (downloadBtn) downloadBtn.style.display = 'none';
        if (copyBtn) {
          copyBtn.style.display = 'inline-block';
          copyBtn.textContent = '复制安装命令';
          copyBtn.onclick = () => {
            navigator.clipboard.writeText('irm https://ollama.com/install.ps1 | iex');
            copyBtn.textContent = '已复制 ✓';
            setTimeout(() => { copyBtn.textContent = '复制安装命令'; }, 2000);
          };
        }
      }
      updateRecommendationCards(models, false);
      return;
    }

    // 阶段 2：检测推荐模型
    const hasRecommended = models.some(name => name.includes(RECOMMENDED_MODEL) || name.includes('qwen3.5'));

    if (hasRecommended) {
      statusIcon.className = 'ollama-status-dot ok';
      statusText.innerHTML = `Ollama 运行中 · 推荐模型已就绪`;
      if (statusAction) statusAction.style.display = 'none';
    } else {
      statusIcon.className = 'ollama-status-dot warn';
      statusText.innerHTML = `Ollama 运行中 · 推荐模型未下载`;
      if (statusAction) {
        statusAction.style.display = 'block';
        if (downloadBtn) downloadBtn.style.display = 'none';
        if (copyBtn) {
          copyBtn.style.display = 'inline-block';
          copyBtn.textContent = '复制 pull 命令';
          copyBtn.onclick = () => {
            navigator.clipboard.writeText(`ollama pull ${RECOMMENDED_MODEL}`);
            copyBtn.textContent = '已复制 ✓';
            setTimeout(() => { copyBtn.textContent = '复制 pull 命令'; }, 2000);
          };
        }
      }
    }

    // 同步更新推荐卡片状态
    updateRecommendationCards(models, true);
  }

  // ===== 轻量模型推荐卡片 =====
  function updateRecommendationCards(installedModels, ollamaRunning) {
    const cards = document.querySelectorAll('.model-card');
    cards.forEach(card => {
      const modelName = card.dataset.model;
      const downloadBtn = card.querySelector('.model-download-btn');
      const cancelBtn = card.querySelector('.model-cancel-btn');
      const copyBtn = card.querySelector('.model-copy-btn');
      const isInstalled = installedModels.some(name => name === modelName || name.startsWith(modelName + ':'));

      if (isInstalled) {
        card.classList.add('installed');
        if (downloadBtn) {
          downloadBtn.textContent = '已就绪';
          downloadBtn.disabled = true;
        }
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (copyBtn) copyBtn.style.display = 'none';
      } else {
        card.classList.remove('installed');
        if (downloadBtn) {
          // 若正在下载中，不覆盖按钮文字（由 pullModel 管理）
          if (downloadBtn.textContent !== '下载中') {
            downloadBtn.textContent = '下载';
            downloadBtn.disabled = !ollamaRunning;
          }
        }
        if (copyBtn) copyBtn.style.display = 'inline-block';
      }
    });
  }

  const activePulls = new Map();

  async function pullModel(modelName, btn) {
    const card = btn.closest('.model-card');
    const progressEl = card?.querySelector('.model-card-progress');
    const progressBar = card?.querySelector('.model-progress-bar');
    const progressText = card?.querySelector('.model-progress-text');
    const cancelBtn = card?.querySelector('.model-cancel-btn');
    const copyBtn = card?.querySelector('.model-copy-btn');

    const controller = new AbortController();
    activePulls.set(modelName, controller);

    btn.textContent = '下载中';
    btn.disabled = true;
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    if (copyBtn) copyBtn.style.display = 'none';
    if (progressEl) progressEl.style.display = 'flex';
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = '0%';

    try {
      const response = await fetch(`${OLLAMA_API}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(`Ollama 返回 ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (typeof data.completed === 'number' && typeof data.total === 'number' && data.total > 0) {
              const percent = Math.min(100, Math.round((data.completed / data.total) * 100));
              if (progressBar) progressBar.style.width = `${percent}%`;
              if (progressText) progressText.textContent = `${percent}%`;
            }
            if (data.status && data.status.includes('error')) {
              throw new Error(data.error || data.status);
            }
          } catch (e) {
            // 忽略不可解析行，错误已在上面抛出
            if (e.message !== 'Unexpected end of JSON input') throw e;
          }
        }
      }

      btn.textContent = '已就绪';
      btn.disabled = true;
      if (cancelBtn) cancelBtn.style.display = 'none';
      card?.classList.add('installed');
      showStatus(`${modelName} 下载完成`, 'success');

      // 刷新本地模型列表
      const success = await handleFetchModels('local', fetchLocalModelsBtn, localModelSelect);
      // 如果当前输入框为空，自动填入刚下载的模型
      if (success && localModelInput && !localModelInput.value.trim()) {
        localModelInput.value = modelName;
      }
      // 刷新 Ollama 状态与卡片
      checkOllamaStatus();
    } catch (error) {
      if (error.name === 'AbortError') {
        btn.textContent = '下载';
        showStatus(`${modelName} 下载已取消`, 'info');
      } else {
        console.error('[YuxTrans] 拉取模型失败:', error);
        btn.textContent = '重试';
        showStatus(`下载 ${modelName} 失败: ${error.message}`, 'error');
      }
      btn.disabled = false;
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (copyBtn) copyBtn.style.display = 'inline-block';
      if (progressEl) progressEl.style.display = 'none';
    } finally {
      activePulls.delete(modelName);
    }
  }

  function bindRecommendationCards() {
    document.querySelectorAll('.model-download-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const modelName = btn.dataset.model;
        if (!modelName || btn.disabled) return;
        pullModel(modelName, btn);
      });
    });

    document.querySelectorAll('.model-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const modelName = btn.dataset.model;
        const controller = activePulls.get(modelName);
        if (controller) controller.abort();
      });
    });

    document.querySelectorAll('.model-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const modelName = btn.dataset.model;
        if (!modelName) return;
        navigator.clipboard.writeText(`ollama pull ${modelName}`).then(() => {
          const originalText = btn.textContent;
          btn.textContent = '已复制 ✓';
          setTimeout(() => { btn.textContent = originalText; }, 2000);
        });
      });
    });
  }

  // 切换到 local 时自动检测
  const _origUpdateProviderUI = updateProviderUI;
  function updateProviderUIWithCheck() {
    _origUpdateProviderUI();
    if (providerSelect.value === 'local') {
      checkOllamaStatus();
    }
  }
  providerSelect?.removeEventListener('change', updateProviderUI);
  providerSelect?.addEventListener('change', updateProviderUIWithCheck);

  // 页面加载时绑定推荐卡片
  bindRecommendationCards();

  // 页面加载时如果当前是 local 也检测
  if (providerSelect?.value === 'local') {
    checkOllamaStatus();
  }

  // ===== 连接测试（使用真实翻译端点） =====
  async function handleTestConnection(provider, btnEl, customConfig) {
    let apiKey, endpoint, model;
    if (customConfig) {
      // 自定义供应商使用独立字段
      apiKey = customConfig.apiKey;
      endpoint = customConfig.endpoint;
      model = customConfig.model;
    } else {
      apiKey = apiKeyInput.value.trim();
      endpoint = apiEndpointInput.value.trim() || defaults.endpoints[provider];
      model = modelSelect.value || '';
    }

    if (!apiKey && provider !== 'local') {
      showStatus('请先填写 API Key', 'error'); return;
    }

    btnEl.disabled = true;
    const originalText = btnEl.textContent;
    btnEl.textContent = '测试中...';

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'testProviderConnection',
        config: { provider, apiKey, endpoint, model }
      });
      if (res?.success) showStatus(provider === 'local' ? 'Ollama 服务连接正常' : '连接测试成功：服务响应正常', 'success');
      else showStatus(`连接失败: ${res?.error || '未知错误'}`, 'error');
    } catch (err) {
      showStatus('网络连接异常', 'error');
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = originalText;
    }
  }

  testProviderBtn?.addEventListener('click', () => handleTestConnection(providerSelect.value, testProviderBtn));
  testLocalBtn?.addEventListener('click', () => handleTestConnection('local', testLocalBtn));

  // 自定义供应商连接测试
  const testCustomBtn = getById('testCustomBtn');
  testCustomBtn?.addEventListener('click', () => {
    handleTestConnection('custom', testCustomBtn, {
      apiKey: customApiKeyInput.value.trim(),
      endpoint: customEndpointInput.value.trim(),
      model: getCustomModelValue()
    });
  });

  // 自定义供应商测试结果显示
  const customTestResult = getById('customTestResult');
  // 复用 showStatus 的逻辑，但输出到 customTestResult 而非浮动层
  function showCustomTestResult(msg, type) {
    if (!customTestResult) return;
    customTestResult.className = '';
    customTestResult.textContent = msg;
    if (type === 'success') {
      customTestResult.style.cssText = 'margin-top:12px; padding:10px 16px; border-radius:10px; background:rgba(46,204,113,0.1); color:#27ae60; font-size:13px; font-weight:600;';
    } else {
      customTestResult.style.cssText = 'margin-top:12px; padding:10px 16px; border-radius:10px; background:rgba(231,76,60,0.1); color:#c0392b; font-size:13px; font-weight:600;';
    }
  }

  // ===== 刷新列表 (通用) =====
  async function handleFetchModels(provider, btnEl, targetSelect) {
    const apiKey = apiKeyInput.value.trim();
    const endpoint = apiEndpointInput.value.trim() || defaults.endpoints[provider];

    if (!apiKey && provider !== 'local') {
      showStatus('请先填写 API Key', 'error'); return;
    }

    btnEl.disabled = true;
    const originalText = btnEl.textContent;
    btnEl.textContent = '获取中...';

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'fetchModels',
        config: { provider, apiKey, endpoint }
      });
      if (res?.success && res.models) {
        const finalModels = [...new Set([...(defaults.models[provider] || []), ...res.models])];
        targetSelect.innerHTML = '';
        finalModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m; opt.textContent = m;
          targetSelect.appendChild(opt);
        });
        targetSelect.style.display = 'block';
        showStatus(`成功同步 ${finalModels.length} 个模型`, 'success');
        return true;
      } else {
        showStatus(res?.error || '获取失败', 'error');
        return false;
      }
    } catch (err) {
      showStatus('网路请求失败', 'error');
      return false;
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = originalText;
    }
  }

  fetchModelsBtn?.addEventListener('click', () => handleFetchModels(providerSelect.value, fetchModelsBtn, modelSelect));
  
  fetchLocalModelsBtn?.addEventListener('click', async () => {
    const success = await handleFetchModels('local', fetchLocalModelsBtn, localModelSelect);
    if (success && localModelSelect.options.length > 0) {
      localModelInput.value = localModelSelect.value;
    }
  });

  // 自定义供应商获取模型列表
  const fetchCustomModelsBtn = getById('fetchCustomModelsBtn');
  fetchCustomModelsBtn?.addEventListener('click', async () => {
    const endpoint = customEndpointInput.value.trim();
    const apiKey = customApiKeyInput.value.trim();

    if (!endpoint) { showStatus('请先填写 API 端点地址', 'error'); return; }
    if (!apiKey) { showStatus('请先填写 API Key', 'error'); return; }

    fetchCustomModelsBtn.disabled = true;
    const originalText = fetchCustomModelsBtn.textContent;
    fetchCustomModelsBtn.textContent = '获取中...';

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'fetchModels',
        config: { provider: 'custom', apiKey, endpoint }
      });

      if (res?.success && res.models && res.models.length > 0) {
        // 清空下拉框并填入模型列表
        customModelSelect.innerHTML = '';
        res.models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m; opt.textContent = m;
          customModelSelect.appendChild(opt);
        });
        // 添加手动输入选项
        const manualOpt = document.createElement('option');
        manualOpt.value = '__manual__'; manualOpt.textContent = '✏️ 手动输入...';
        customModelSelect.appendChild(manualOpt);

        customModelSelect.style.display = 'block';
        customModelManual.style.display = 'none';
        customModelSelect.value = res.models[0] || '';
        showStatus(`获取到 ${res.models.length} 个模型，请从下拉列表选择`, 'success');
      } else {
        showStatus(res?.error || '未获取到可用模型', 'error');
      }
    } catch (err) {
      showStatus('获取模型列表失败', 'error');
    } finally {
      fetchCustomModelsBtn.disabled = false;
      fetchCustomModelsBtn.textContent = originalText;
    }
  });

  // 选择"手动输入"时显示文本输入框
  customModelSelect?.addEventListener('change', () => {
    if (customModelSelect.value === '__manual__') {
      customModelManual.style.display = 'block';
      customModelManual.focus();
    } else {
      customModelManual.style.display = 'none';
    }
  });

  localModelSelect?.addEventListener('change', () => {
    localModelInput.value = localModelSelect.value;
  });

  // ===== 保存 ProviderProfile =====
  const saveProviderBtn = getById('saveProviderBtn');
  saveProviderBtn?.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const isLocal = provider === 'local';
    const isCustom = provider === 'custom';
    const modelId = isLocal
      ? localModelInput.value.trim()
      : (isCustom ? getCustomModelValue() : (modelSelect.value || ''));

    if (!modelId) {
      showStatus(isLocal ? '请填写本地模型名称' : '请先选择一个模型', 'error');
      return;
    }

    const profile = {
      provider,
      label: `${PROVIDER_NAMES[provider] || provider} - ${modelId || 'default'}`,
      apiKey: isLocal || isCustom ? '' : apiKeyInput.value.trim(),
      apiEndpoint: isLocal || isCustom ? '' : apiEndpointInput.value.trim(),
      model: isLocal ? '' : modelId,
      localModel: isLocal ? modelId : '',
      customProvider: isCustom
        ? {
            name: customNameInput.value.trim(),
            endpoint: customEndpointInput.value.trim(),
            apiKey: customApiKeyInput.value.trim(),
            format: customFormatSelect.value,
            model: modelId
          }
        : { name: '', endpoint: '', apiKey: '', format: 'openai', model: '' }
    };

    try {
      const res = await chrome.runtime.sendMessage({ action: 'saveProfile', profile });
      if (res?.success) {
        config = await chrome.runtime.sendMessage({ action: 'getConfig' });
        showStatus('档案已保存并启用', 'success');
        loadModelList();
        renderActiveConfig();
      } else {
        showStatus(`保存失败: ${res?.error || '未知错误'}`, 'error');
      }
    } catch (err) {
      showStatus(`保存异常: ${err.message}`, 'error');
    }
  });

  // ===== ProviderProfile 管理 =====

  let modelRecords = []; // 当前所有 ProviderProfile

  async function loadModelList() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getProfiles' });
      if (res?.success) {
        modelRecords = res.profiles || [];
        if (res.activeProfileId) config.activeProfileId = res.activeProfileId;
      }
    } catch (e) {
      modelRecords = [];
    }
    renderModelList();
  }

  function renderModelList() {
    const container = getById('modelList');
    if (!container) return;

    if (!modelRecords || modelRecords.length === 0) {
      container.innerHTML = '<div class="model-list-empty">暂无档案，请在上方配置并保存后在此管理。</div>';
      return;
    }

    const currentId = config?.activeProfileId || '';

    container.innerHTML = modelRecords.map((m, idx) => {
      const isActive = m.id === currentId;
      const providerLabel = PROVIDER_NAMES[m.provider] || m.provider;
      const modelLabel = m.model || m.localModel || '';
      return `
        <div class="model-list-item ${isActive ? 'active' : ''}">
          <div class="model-list-info">
            <div class="model-list-name">${m.label || m.id}</div>
            <div class="model-list-detail">${providerLabel} · ${modelLabel}</div>
          </div>
          <div class="model-list-actions">
            ${!isActive ? `<button class="btn-test" data-activate="${idx}">启用</button>` : '<span class="model-list-active-badge">当前使用</span>'}
            <button class="btn-test" data-remove="${idx}">移除</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-activate]').forEach((btn) => {
      btn.addEventListener('click', () => activateModel(parseInt(btn.dataset.activate, 10)));
    });
    container.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => removeModel(parseInt(btn.dataset.remove, 10)));
    });
  }

  async function activateModel(idx) {
    const record = modelRecords[idx];
    if (!record) return;

    try {
      const res = await chrome.runtime.sendMessage({ action: 'setActiveProfile', profileId: record.id });
      if (res?.success) {
        config = await chrome.runtime.sendMessage({ action: 'getConfig' });
        applyProfileToForm(getActiveProfile(config));
        updateProviderUI();
        renderModelList();
        renderActiveConfig();
        showStatus(`已切换至 ${record.label || record.id}`, 'success');
      } else {
        showStatus(`切换失败: ${res?.error || '未知错误'}`, 'error');
      }
    } catch (err) {
      showStatus(`切换失败: ${err.message}`, 'error');
    }
  }

  async function removeModel(idx) {
    const record = modelRecords[idx];
    if (!record) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'deleteProfile', profileId: record.id });
      if (res?.success) {
        config = await chrome.runtime.sendMessage({ action: 'getConfig' });
        modelRecords.splice(idx, 1);
        renderModelList();
        renderActiveConfig();
        showStatus(`已移除 ${record.label || record.id}`, 'success');
      } else {
        showStatus(`移除失败: ${res?.error || '未知错误'}`, 'error');
      }
    } catch (err) {
      showStatus(`移除失败: ${err.message}`, 'error');
    }
  }

  loadModelList();

  // ===== 保存 ActiveConfig（与供应商无关的通用设置） =====
  saveBtn?.addEventListener('click', async () => {
    try {
      const getVal = (el) => el?.value || '';
      const getChecked = (el) => el?.checked || false;

      const activeConfig = {
        cacheEnabled: cacheEnabledInput ? getChecked(cacheEnabledInput) : true,
        maxCacheMB: parseInt(getVal(maxCacheMBInput) || '200', 10),
        sourceLang: getVal(sourceLangSelect) || 'auto',
        targetLang: getVal(targetLangSelect) || 'zh',
        translateStyle: document.querySelector('input[name="translateStyle"]:checked')?.value || 'normal',
        triggerMode: document.querySelector('input[name="triggerMode"]:checked')?.value || 'auto',
        autoCopy: getChecked(autoCopyCheckbox),
        siteRule: getVal(siteRuleSelect) || 'all',
        siteList: getVal(siteListTextarea).split('\n').map((s) => s.trim()).filter(Boolean),
        autoDetectLang: autoDetectLangInput ? getChecked(autoDetectLangInput) : true,
        autoFallback: autoFallbackInput ? getChecked(autoFallbackInput) : true,
        enableStreaming: enableStreamingInput ? getChecked(enableStreamingInput) : true
      };

      const res = await chrome.runtime.sendMessage({ action: 'setConfig', config: activeConfig });
      if (res?.success) {
        showStatus('通用设置已保存', 'success');
        config = { ...config, ...activeConfig };
        renderActiveConfig();
      } else {
        showStatus(`保存失败: ${res?.error || '未知响应'}`, 'error');
      }
    } catch (err) {
      console.error('[YuxTrans] Save Error:', err);
      showStatus(`运行异常: ${err.message}`, 'error');
    }
  });

  // ===== 导入/导出 =====
  getById('exportConfigBtn')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `yuxtrans-config-${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  });

  getById('importConfigInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        await chrome.runtime.sendMessage({ action: 'setConfig', config: imported });
        showStatus('配置已导入，正在刷新...', 'success');
        setTimeout(() => window.location.reload(), 1000);
      } catch (err) { showStatus('无效格式', 'error'); }
    };
    reader.readAsText(file);
  });

  // ===== 清除缓存 =====
  clearCacheBtn?.addEventListener('click', async () => {
    if (!confirm('确定清除本地数据吗？')) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'clearCache' });
      if (res?.success) { showStatus('数据已清空', 'success'); updateStatsInternal(); }
    } catch(e) {}
  });

  // ===== 统计逻辑 =====
  function startCacheStatsUpdate() {
    updateStatsInternal();
    cacheStatsInterval = setInterval(updateStatsInternal, 4000);
  }

  function updateStatsInternal() {
    chrome.runtime.sendMessage({ action: 'getCacheStats' }, (res) => {
      if (!res?.success) return;
      
      const { usage, stats } = res;
      if (totalTranslatesCountEl) totalTranslatesCountEl.textContent = usage.totalCount || 0;
      if (cacheHitsCountEl) cacheHitsCountEl.textContent = usage.cacheHits || 0;
      if (cacheHitRateEl) {
        const rate = usage.totalCount > 0 ? Math.round((usage.cacheHits / usage.totalCount) * 100) : 0;
        cacheHitRateEl.textContent = `${rate}%`;
      }

      // 更新物理存储进度条
      if (storageProgressBar && storageText && stats) {
        const maxMB = config?.maxCacheMB || 200;
        const usedMB = stats.sizeMB || 0;
        const percent = Math.min(Math.round((usedMB / maxMB) * 100), 100);
        
        storageProgressBar.style.width = `${percent}%`;
        storageText.textContent = `${usedMB} MB / ${maxMB} MB`;
        
        // 根据占用率改变颜色 (可选气泡感)
        if (percent > 90) {
          storageProgressBar.style.background = 'linear-gradient(90deg, #d85151, #e67d7d)';
        } else {
          storageProgressBar.style.background = 'linear-gradient(90deg, #d8a051, #e6b87d)';
        }
      }
    });
  }

  // ===== 诊断数据渲染 =====
  function loadMetrics() {
    if (metricsRecentErrorsEl) {
      metricsRecentErrorsEl.innerHTML = '<p class="hint">加载中...</p>';
    }
    chrome.runtime.sendMessage({ action: 'getMetrics', limit: 1000, days: 7 }, (res) => {
      if (chrome.runtime.lastError) {
        console.error('[YuxTrans] 加载诊断数据失败:', chrome.runtime.lastError);
        if (metricsRecentErrorsEl) {
          metricsRecentErrorsEl.innerHTML = `<p class="hint">加载失败: ${chrome.runtime.lastError.message}</p>`;
        }
        return;
      }
      if (!res?.success) {
        console.error('[YuxTrans] 诊断数据返回失败:', res?.error);
        if (metricsRecentErrorsEl) {
          metricsRecentErrorsEl.innerHTML = `<p class="hint">加载失败: ${res?.error || '未知错误'}</p>`;
        }
        return;
      }
      renderMetrics(res);
    });
  }

  function renderMetrics(data) {
    const { summary, byProvider, metrics } = data;
    if (metricsTotalEl) metricsTotalEl.textContent = summary?.total || 0;
    if (metricsSuccessRateEl) {
      const rate = summary?.total > 0 ? Math.round((summary.success / summary.total) * 100) : 0;
      metricsSuccessRateEl.textContent = `${rate}%`;
    }
    if (metricsCacheRateEl) {
      const rate = summary?.total > 0 ? Math.round((summary.cacheHits / summary.total) * 100) : 0;
      metricsCacheRateEl.textContent = `${rate}%`;
    }
    if (metricsAvgLatencyEl) {
      metricsAvgLatencyEl.textContent = `${summary?.avgLatency || 0}ms`;
    }

    // SW 启动统计
    const swInitMetrics = (metrics || []).filter(m => m.action === 'swInit');
    if (metricsSwInitCountEl) metricsSwInitCountEl.textContent = swInitMetrics.length;
    if (metricsSwInitAvgEl) {
      const avg = swInitMetrics.length > 0
        ? Math.round(swInitMetrics.reduce((sum, m) => sum + (m.latencyMs || 0), 0) / swInitMetrics.length)
        : 0;
      metricsSwInitAvgEl.textContent = `${avg}ms`;
    }

    // 供应商分布表
    if (metricsProviderTableEl) {
      const tbody = metricsProviderTableEl.querySelector('tbody');
      if (tbody) {
        const rows = Object.entries(byProvider || {})
          .sort((a, b) => b[1].count - a[1].count)
          .map(([provider, item]) => {
            const label = PROVIDER_NAMES[provider] || provider;
            return `
              <tr>
                <td>${label}</td>
                <td>${item.count}</td>
                <td>${item.success}</td>
                <td>${item.failure}</td>
                <td>${item.cacheHits}</td>
                <td>${item.avgLatency}ms</td>
              </tr>
            `;
          }).join('');
        tbody.innerHTML = rows || '<tr><td colspan="6" style="text-align:center;color:var(--yxt-text-tertiary);">暂无数据</td></tr>';
      }
    }

    // 最近失败
    if (metricsRecentErrorsEl) {
      const failures = (metrics || [])
        .filter(m => !m.success)
        .slice(0, 10);
      if (failures.length === 0) {
        metricsRecentErrorsEl.innerHTML = '<p class="hint">暂无失败记录</p>';
      } else {
        metricsRecentErrorsEl.innerHTML = failures.map(m => {
          const time = new Date(m.timestamp).toLocaleString('zh-CN');
          const actionLabel = { translate: '翻译', translateStream: '流式', translateBatch: '批量', swInit: 'SW 启动' }[m.action] || m.action;
          const providerLabel = PROVIDER_NAMES[m.provider] || m.provider || 'unknown';
          return `
            <div class="metrics-error-item">
              <div class="error-time">${time}</div>
              <div>
                <span class="error-action">${actionLabel} · ${providerLabel}</span>
                <span class="error-type">${m.errorType || 'unknown'}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // ===== 请求日志渲染 =====
  function loadRequestLogs() {
    if (requestLogsContainer) {
      requestLogsContainer.innerHTML = '<p class="hint">加载中...</p>';
    }
    chrome.runtime.sendMessage({ action: 'getRequestLogs', limit: 50 }, (res) => {
      if (chrome.runtime.lastError) {
        console.error('[YuxTrans] 加载请求日志失败:', chrome.runtime.lastError);
        if (requestLogsContainer) {
          requestLogsContainer.innerHTML = `<p class="hint">加载失败: ${chrome.runtime.lastError.message}</p>`;
        }
        return;
      }
      if (!res?.success) {
        if (requestLogsContainer) {
          requestLogsContainer.innerHTML = `<p class="hint">加载失败: ${res?.error || '未知错误'}</p>`;
        }
        return;
      }
      renderRequestLogs(res.logs || []);
    });
  }

  function renderRequestLogs(logs) {
    if (!requestLogsContainer) return;
    if (logs.length === 0) {
      requestLogsContainer.innerHTML = '<p class="hint">暂无请求日志</p>';
      return;
    }

    requestLogsContainer.innerHTML = logs.map(log => {
      const time = new Date(log.timestamp).toLocaleString('zh-CN');
      const actionLabel = { translate: '单句', translateStream: '流式', translateBatch: '批量' }[log.action] || log.action;
      const providerLabel = PROVIDER_NAMES[log.provider] || log.provider || 'unknown';
      const statusClass = log.success ? 'success' : 'error';
      const statusText = log.success ? '成功' : '失败';
      const errorBlock = log.error
        ? `<div class="log-label">错误</div><div class="log-block">${escapeHtml(log.error)}</div>`
        : '';
      const outputBlock = log.response
        ? `<div class="log-label">响应</div><div class="log-block">${escapeHtml(log.response)}</div>`
        : (log.outputSample
          ? `<div class="log-label">输出样例</div><div class="log-block">${escapeHtml(log.outputSample)}</div>`
          : '');
      const parseErrorBlock = log.parseError
        ? `<div class="log-label">解析异常</div><div class="log-block">${escapeHtml(log.parseError)}</div>`
        : '';

      return `
        <div class="request-log-item">
          <div class="log-header">
            <span class="log-meta">${time} · ${actionLabel} · ${providerLabel}${log.model ? ' · ' + log.model : ''} · ${log.latencyMs || 0}ms</span>
            <span class="log-status ${statusClass}">${statusText}</span>
          </div>
          <div class="log-label">Prompt</div>
          <div class="log-block">${escapeHtml(log.prompt || '')}</div>
          ${log.inputSample ? `<div class="log-label">输入样例</div><div class="log-block">${escapeHtml(log.inputSample)}</div>` : ''}
          ${outputBlock}
          ${parseErrorBlock}
          ${errorBlock}
        </div>
      `;
    }).join('');
  }

  function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  refreshMetricsBtn?.addEventListener('click', loadMetrics);
  refreshRequestLogsBtn?.addEventListener('click', loadRequestLogs);

  // 切换到诊断标签页时刷新数据
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'diagnostics') {
        loadMetrics();
        loadRequestLogs();
      }
    });
  });
});