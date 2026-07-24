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

  // 3. 版本号（统一读取 manifest）
  const versionBadge = getById('versionBadge');
  const sidebarVersion = getById('sidebarVersion');
  try {
    const manifest = chrome.runtime.getManifest();
    const verText = `YuxTrans v${manifest.version}`;
    if (versionBadge) versionBadge.textContent = verText;
    if (sidebarVersion) sidebarVersion.textContent = verText;
  } catch (e) {}

  // 4. 语言设置
  const sourceLangSelect = getById('sourceLang');
  const targetLangSelect = getById('targetLang');
  const translateStyleRadios = getAll('input[name="translateStyle"]');
  const stylePromptTextarea = getById('stylePromptText');
  const stylePromptStyleLabel = getById('stylePromptStyleLabel');
  const stylePromptStatusEl = getById('stylePromptStatus');
  const resetStylePromptBtn = getById('resetStylePromptBtn');

  /** 风格中文名 */
  const STYLE_LABELS = {
    normal: '日常模式',
    academic: '学术模式',
    technical: '技术模式',
    literary: '文学模式'
  };
  /** 内置默认提示词（由 getProviderDefaults 覆盖） */
  let defaultStylePrompts = {
    normal: '',
    academic: 'Use an academic and formal style with precise terminology.',
    technical: 'Preserve technical accuracy, keep technical terms and code references intact.',
    literary: 'Use literary elegance and artistic expression.'
  };
  /** 编辑草稿：四风格完整文案（含与默认相同者） */
  let stylePromptsDraft = { ...defaultStylePrompts };

  // 5. 动作行为设置
  const triggerModeRadios = getAll('input[name="triggerMode"]');
  const autoCopyCheckbox = getById('autoCopy');
  const siteRuleSelect = getById('siteRule');
  const siteListTextarea = getById('siteList');
  const autoDetectLangInput = getById('autoDetectLang');
  const autoFallbackInput = getById('autoFallback');
  const enableStreamingInput = getById('enableStreaming');
  const offlineModeInput = getById('offlineMode');
  // F1-F6 新配置元素
  const hoverTranslateInput = getById('hoverTranslate');
  const hoverModifierSelect = getById('hoverModifier');
  const dictModeInput = getById('dictMode');
  const dictDblclickInput = getById('dictDblclick');
  const originalStyleSelect = getById('originalStyle');
  const inputTranslateInput = getById('inputTranslate');
  const smartContentDetectionInput = getById('smartContentDetection');
  // F4b：双档案对照
  const compareProfileIdSelect = getById('compareProfileId');
  const glossaryCountEl = getById('glossaryCount');
  const importGlossaryInput = getById('importGlossaryInput');
  const clearGlossaryBtn = getById('clearGlossaryBtn');

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

  // 7. 辅助（分栏保存：各可写模块独立按钮）
  const savePreferenceBtn = getById('savePreferenceBtn');
  const saveInteractionBtn = getById('saveInteractionBtn');
  const saveDataBtn = getById('saveDataBtn');
  const clearCacheBtn = getById('clearCacheBtn');
  const updateBtn = getById('updateBtn');
  const statusEl = getById('status');
  let statusTimeout = null;
  const Helpers = (typeof YuxTransHelpers !== 'undefined') ? YuxTransHelpers : null;
  /** @type {boolean} firstRunPending 缓存，供 G1 同步判断（须在 config 回填调用前初始化，避免 TDZ） */
  let firstRunPendingFlag = false;

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
          <div class="yxt-guide">
            <h3 class="yxt-guide-title">三步更新指引</h3>
            <div class="guide-step">
              <div class="step-num">1</div>
              <div class="step-content">点击<strong>「立即下载 ZIP」</strong>获取最新代码包并解压。</div>
            </div>
            <div class="guide-step">
              <div class="step-num">2</div>
              <div class="step-content">在地址栏打开 <strong>chrome://extensions</strong> 进入扩展管理。</div>
            </div>
            <div class="guide-step">
              <div class="step-num">3</div>
              <div class="step-content">找到 YuxTrans，点击<strong>重新加载</strong>（或删除后重新加载解压目录）。</div>
            </div>
            <p class="yxt-guide-note">更新后本地翻译缓存会保留（除非清除浏览器数据）。</p>
          </div>
        `;
        showModal(guideHtml);
      });
    }
  });

  function showModal(html) {
    const modal = document.createElement('div');
    modal.className = 'yxt-modal-overlay';
    modal.innerHTML = `
      <div class="yxt-modal-card" role="dialog" aria-modal="true">
        <div class="yxt-modal-body">${html}</div>
        <button type="button" id="closeModalBtn" class="btn-secondary yxt-modal-close">我知道了</button>
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
      if (res.stylePrompts && typeof res.stylePrompts === 'object') {
        defaultStylePrompts = {
          normal: res.stylePrompts.normal || '',
          academic: res.stylePrompts.academic || '',
          technical: res.stylePrompts.technical || '',
          literary: res.stylePrompts.literary || ''
        };
        stylePromptsDraft = { ...defaultStylePrompts };
      }
    }
  } catch (error) {
    console.error('[YuxTrans] 加载供应商默认配置失败:', error);
  }

  /**
   * 当前选中的翻译风格 id
   * @returns {string}
   */
  function getSelectedTranslateStyle() {
    return document.querySelector('input[name="translateStyle"]:checked')?.value || 'normal';
  }

  /**
   * 将草稿中当前风格同步到 textarea（切换风格前应先 flush）
   */
  function flushStylePromptEditorToDraft() {
    if (!stylePromptTextarea) return;
    const style = getSelectedTranslateStyle();
    stylePromptsDraft[style] = stylePromptTextarea.value.slice(0, 2000);
  }

  /**
   * 按选中风格刷新提示词编辑器 UI
   */
  function refreshStylePromptEditor() {
    const style = getSelectedTranslateStyle();
    if (stylePromptStyleLabel) {
      stylePromptStyleLabel.textContent = STYLE_LABELS[style] || style;
    }
    const text = Object.prototype.hasOwnProperty.call(stylePromptsDraft, style)
      ? stylePromptsDraft[style]
      : (defaultStylePrompts[style] || '');
    if (stylePromptTextarea) stylePromptTextarea.value = text;
    const isCustom = text !== (defaultStylePrompts[style] || '');
    if (stylePromptStatusEl) {
      stylePromptStatusEl.textContent = isCustom ? '已自定义（与内置默认不同）' : '使用内置默认';
      stylePromptStatusEl.classList.toggle('is-custom', isCustom);
    }
  }

  /**
   * 从 config 填充风格提示词草稿（覆盖优先，缺省用默认）
   * @param {object} cfg
   */
  function loadStylePromptsDraftFromConfig(cfg) {
    const custom = (cfg && cfg.stylePrompts && typeof cfg.stylePrompts === 'object')
      ? cfg.stylePrompts
      : {};
    stylePromptsDraft = {
      normal: typeof custom.normal === 'string' ? custom.normal : defaultStylePrompts.normal,
      academic: typeof custom.academic === 'string' ? custom.academic : defaultStylePrompts.academic,
      technical: typeof custom.technical === 'string' ? custom.technical : defaultStylePrompts.technical,
      literary: typeof custom.literary === 'string' ? custom.literary : defaultStylePrompts.literary
    };
  }

  /**
   * 导出待保存的 stylePrompts（完整四键，由 SW sanitize 去掉与默认相同者）
   * @returns {object}
   */
  function collectStylePromptsForSave() {
    flushStylePromptEditorToDraft();
    return {
      normal: String(stylePromptsDraft.normal || '').slice(0, 2000),
      academic: String(stylePromptsDraft.academic || '').slice(0, 2000),
      technical: String(stylePromptsDraft.technical || '').slice(0, 2000),
      literary: String(stylePromptsDraft.literary || '').slice(0, 2000)
    };
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
    if (localModelInput) localModelInput.value = fallback.localModel || 'translategemma:4b';

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
    // F8：默认选中推荐模型卡（localModel 未设置时选中 translategemma:4b）
    selectModelCard(localModelInput?.value?.trim() || 'translategemma:4b');
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
    loadStylePromptsDraftFromConfig(config);
    refreshStylePromptEditor();

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
    if (offlineModeInput) offlineModeInput.checked = !!config.offlineMode;
    // F1-F6 配置回填
    if (hoverTranslateInput) hoverTranslateInput.checked = config.hoverTranslate !== false;
    if (hoverModifierSelect) hoverModifierSelect.value = config.hoverModifier === 'ctrl' ? 'ctrl' : 'alt';
    if (dictModeInput) dictModeInput.checked = config.dictMode !== false;
    if (dictDblclickInput) dictDblclickInput.checked = config.dictDblclick !== false;
    if (originalStyleSelect) originalStyleSelect.value = ['normal', 'fade', 'blur'].includes(config.originalStyle) ? config.originalStyle : 'normal';
    if (inputTranslateInput) inputTranslateInput.checked = !!config.inputTranslate;
    if (smartContentDetectionInput) smartContentDetectionInput.checked = !!config.smartContentDetection;
    // F4b：对照档案下拉从 profiles 填充，回填当前值
    if (compareProfileIdSelect) {
      const profiles = Array.isArray(config.profiles) ? config.profiles : [];
      const activeId = config.activeProfileId || '';
      compareProfileIdSelect.innerHTML = '<option value="">不启用对照</option>' +
        profiles
          .filter((p) => p.id !== activeId) // 排除当前激活档案（无需与自身对照）
          .map((p) => {
            const name = PROVIDER_NAMES[p.provider] || p.provider;
            const model = p.model || p.localModel || '';
            const sel = p.id === config.compareProfileId ? ' selected' : '';
            return `<option value="${p.id}"${sel}>${name}${model ? ' · ' + model : ''}</option>`;
          })
          .join('');
    }
    if (glossaryCountEl) glossaryCountEl.textContent = String((config.glossary || []).length);
    renderActiveConfig();
    syncQuickStartVisibility();
    syncInteractionSubcontrols();
  }

  /**
   * G1：按档案与 firstRun 状态显示/隐藏「快速开始」
   */
  function syncQuickStartVisibility() {
    const section = getById('quickStartSection');
    if (!section) return;
    const show = Helpers?.shouldShowOptionsQuickStart
      ? Helpers.shouldShowOptionsQuickStart({
        firstRunPending: firstRunPendingFlag,
        profiles: config?.profiles,
        activeProfileId: config?.activeProfileId
      })
      : (!(config?.profiles || []).length || !config?.activeProfileId);
    section.hidden = !show;
  }

  // 读取 firstRunPending 后刷新上手区
  chrome.storage.local.get('firstRunPending', (fr) => {
    firstRunPendingFlag = !!fr?.firstRunPending;
    syncQuickStartVisibility();
  });

  /**
   * B1：悬停/词典父开关关闭时灰显子选项
   */
  function syncInteractionSubcontrols() {
    const hoverOn = hoverTranslateInput ? hoverTranslateInput.checked : true;
    const dictOn = dictModeInput ? dictModeInput.checked : true;
    if (hoverModifierSelect) {
      hoverModifierSelect.disabled = !hoverOn;
      const row = getById('hoverModifierRow');
      if (row) row.classList.toggle('is-disabled', !hoverOn);
    }
    if (dictDblclickInput) {
      dictDblclickInput.disabled = !dictOn;
      const row = getById('dictDblclickRow');
      if (row) row.classList.toggle('is-disabled', !dictOn);
    }
  }

  hoverTranslateInput?.addEventListener('change', syncInteractionSubcontrols);
  dictModeInput?.addEventListener('change', syncInteractionSubcontrols);

  // 风格提示词：切换风格前写回草稿；输入时更新「已自定义」状态
  translateStyleRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      // 注意：change 触发时 checked 已是新风格，需用 data-prev 记录旧风格
      // 这里改为：先用 textarea 当前值写到「上一次展示的风格」——在 refresh 前读 data-editing-style
      const prev = stylePromptTextarea?.dataset?.editingStyle || 'normal';
      if (stylePromptTextarea) {
        stylePromptsDraft[prev] = stylePromptTextarea.value.slice(0, 2000);
      }
      if (stylePromptTextarea) stylePromptTextarea.dataset.editingStyle = getSelectedTranslateStyle();
      refreshStylePromptEditor();
    });
  });
  if (stylePromptTextarea) {
    stylePromptTextarea.dataset.editingStyle = getSelectedTranslateStyle();
    stylePromptTextarea.addEventListener('input', () => {
      const style = getSelectedTranslateStyle();
      stylePromptsDraft[style] = stylePromptTextarea.value.slice(0, 2000);
      const isCustom = stylePromptsDraft[style] !== (defaultStylePrompts[style] || '');
      if (stylePromptStatusEl) {
        stylePromptStatusEl.textContent = isCustom ? '已自定义（与内置默认不同）' : '使用内置默认';
        stylePromptStatusEl.classList.toggle('is-custom', isCustom);
      }
    });
  }
  resetStylePromptBtn?.addEventListener('click', () => {
    const style = getSelectedTranslateStyle();
    stylePromptsDraft[style] = defaultStylePrompts[style] || '';
    if (stylePromptTextarea) stylePromptTextarea.value = stylePromptsDraft[style];
    if (stylePromptStatusEl) {
      stylePromptStatusEl.textContent = '使用内置默认';
      stylePromptStatusEl.classList.remove('is-custom');
    }
    showStatus(`${STYLE_LABELS[style] || style} 已恢复默认提示词（需点保存生效）`, 'success');
  });

  // 首次安装三步引导（A3：本地/云端 → 配置 → 试译）

  async function initFirstRunWizard() {
    const wizard = getById('firstRunWizard');
    if (!wizard) return;

    let shouldShow = false;
    try {
      const fr = await chrome.storage.local.get('firstRunPending');
      shouldShow = !!fr.firstRunPending;
      firstRunPendingFlag = shouldShow;
      syncQuickStartVisibility();
    } catch (e) {
      shouldShow = false;
    }
    // 无档案时也引导（冷启动补救）
    if (!shouldShow && (!(config?.profiles || []).length)) {
      shouldShow = true;
    }
    if (!shouldShow) return;

    const state = {
      step: 1,
      path: null,
      provider: 'qwen',
      apiKey: '',
      localModel: 'translategemma:4b',
      ollamaOk: false,
      trialOk: false
    };

    const nextBtn = getById('firstRunNextBtn');
    const backBtn = getById('firstRunBackBtn');
    const skipBtn = getById('firstRunSkipBtn');
    const trialBtn = getById('firstRunTrialBtn');
    const trialResult = getById('firstRunTrialResult');
    const cloudForm = getById('firstRunCloudForm');
    const localForm = getById('firstRunLocalForm');
    const ollamaStatus = getById('firstRunOllamaStatus');
    const providerSel = getById('firstRunProvider');
    const apiKeyInputFr = getById('firstRunApiKey');
    const localModelInputFr = getById('firstRunLocalModel');

    wizard.hidden = false;

    function readStateFromDom() {
      state.provider = providerSel?.value || 'qwen';
      state.apiKey = apiKeyInputFr?.value || '';
      state.localModel = localModelInputFr?.value?.trim() || 'translategemma:4b';
    }

    function canAdvance() {
      readStateFromDom();
      if (Helpers?.canAdvanceFirstRunStep) {
        return Helpers.canAdvanceFirstRunStep(state.step, state);
      }
      if (state.step === 1) return !!state.path;
      if (state.step === 2) {
        return state.path === 'local' ? !!state.ollamaOk : !!(state.apiKey && state.provider);
      }
      return !!state.trialOk;
    }

    function syncDots() {
      wizard.querySelectorAll('[data-step-dot]').forEach((dot) => {
        const n = Number(dot.getAttribute('data-step-dot'));
        dot.classList.toggle('active', n === state.step);
        dot.classList.toggle('done', n < state.step);
      });
    }

    function syncPanes() {
      wizard.querySelectorAll('[data-step-pane]').forEach((pane) => {
        const n = Number(pane.getAttribute('data-step-pane'));
        const active = n === state.step;
        pane.hidden = !active;
        pane.classList.toggle('active', active);
      });
      if (cloudForm) cloudForm.hidden = state.path !== 'cloud';
      if (localForm) localForm.hidden = state.path !== 'local';
      if (backBtn) backBtn.hidden = state.step === 1;
      if (nextBtn) {
        nextBtn.disabled = !canAdvance();
        nextBtn.textContent = state.step === 3 ? '完成并开始使用' : '下一步';
      }
      syncDots();
    }

    async function probeOllama() {
      if (ollamaStatus) ollamaStatus.textContent = '正在检测本机 Ollama…';
      state.ollamaOk = false;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        const res = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          state.ollamaOk = true;
          if (ollamaStatus) {
            ollamaStatus.textContent = '已检测到 Ollama。请确认模型已下载（默认 translategemma:4b）。';
          }
        } else {
          if (ollamaStatus) ollamaStatus.textContent = 'Ollama 响应异常，请确认服务已启动。';
        }
      } catch (e) {
        if (ollamaStatus) {
          ollamaStatus.textContent = '未检测到 Ollama。请先安装并运行 ollama serve，或改用云端 API。';
        }
      }
      syncPanes();
    }

    async function saveDraftProfile() {
      readStateFromDom();
      const draft = Helpers?.buildFirstRunProfileDraft
        ? Helpers.buildFirstRunProfileDraft(state)
        : {
            provider: state.path === 'local' ? 'local' : state.provider,
            apiKey: state.path === 'local' ? '' : state.apiKey,
            localModel: state.localModel,
            model: '',
            label: '首次引导'
          };

      const profile = {
        id: `${draft.provider}:${draft.model || draft.localModel || 'default'}`,
        provider: draft.provider,
        apiKey: draft.apiKey || '',
        apiEndpoint: draft.apiEndpoint || '',
        model: draft.model || '',
        localModel: draft.localModel || '',
        customProvider: { name: '', endpoint: '', apiKey: '', format: 'openai', model: '' },
        label: draft.label || '',
        savedAt: Date.now()
      };

      const profiles = Array.isArray(config.profiles) ? config.profiles.slice() : [];
      const idx = profiles.findIndex((p) => p.id === profile.id);
      if (idx >= 0) profiles[idx] = { ...profiles[idx], ...profile };
      else profiles.push(profile);

      await chrome.runtime.sendMessage({
        action: 'setConfig',
        config: {
          profiles,
          activeProfileId: profile.id,
          provider: profile.provider,
          apiKey: profile.apiKey,
          model: profile.model,
          localModel: profile.localModel,
          apiEndpoint: profile.apiEndpoint || ''
        }
      });

      // 同步本地 config 对象
      config.profiles = profiles;
      config.activeProfileId = profile.id;
      config.provider = profile.provider;
      config.apiKey = profile.apiKey;
      config.model = profile.model;
      config.localModel = profile.localModel;

      try {
        await chrome.runtime.sendMessage({
          action: 'saveProfile',
          profile
        });
      } catch (e) {
        // 档案表写入失败不阻断试译
      }
    }

    async function closeWizard(markDone) {
      wizard.hidden = true;
      if (markDone) {
        try {
          await chrome.storage.local.set({ firstRunPending: false });
          firstRunPendingFlag = false;
        } catch (e) {}
      }
      const hint = getById('firstRunHint');
      if (hint && state.trialOk) {
        hint.textContent = '配置已完成：可回到网页划词翻译。需要改供应商请到「服务档案」。';
        hint.style.fontWeight = '600';
      }
      // 刷新档案列表 UI
      try {
        if (typeof loadModels === 'function') await loadModels();
        else if (typeof renderModelList === 'function') renderModelList();
      } catch (e) {}
      renderActiveConfig();
      syncQuickStartVisibility();
    }

    wizard.querySelectorAll('.first-run-path-card').forEach((card) => {
      card.addEventListener('click', () => {
        const path = card.getAttribute('data-path');
        state.path = Helpers?.resolveFirstRunPath
          ? Helpers.resolveFirstRunPath(path)
          : path;
        wizard.querySelectorAll('.first-run-path-card').forEach((c) => {
          c.classList.toggle('selected', c === card);
        });
        syncPanes();
      });
    });

    apiKeyInputFr?.addEventListener('input', () => syncPanes());
    providerSel?.addEventListener('change', () => syncPanes());
    localModelInputFr?.addEventListener('input', () => syncPanes());
    getById('firstRunRecheckOllama')?.addEventListener('click', () => probeOllama());

    backBtn?.addEventListener('click', () => {
      if (state.step > 1) {
        state.step -= 1;
        syncPanes();
      }
    });

    skipBtn?.addEventListener('click', async () => {
      await closeWizard(true);
      const profilesTab = document.querySelector('.tab[data-tab="profiles"]');
      profilesTab?.click();
    });

    nextBtn?.addEventListener('click', async () => {
      if (!canAdvance()) return;
      if (state.step === 1) {
        state.step = 2;
        syncPanes();
        if (state.path === 'local') await probeOllama();
        return;
      }
      if (state.step === 2) {
        try {
          await saveDraftProfile();
        } catch (e) {
          showStatus(`保存配置失败：${e.message || e}`, 'error');
          return;
        }
        state.step = 3;
        state.trialOk = false;
        if (trialResult) {
          trialResult.textContent = '点击下方按钮开始试译';
          trialResult.className = 'first-run-trial-dst';
        }
        syncPanes();
        return;
      }
      if (state.step === 3 && state.trialOk) {
        await closeWizard(true);
      }
    });

    trialBtn?.addEventListener('click', async () => {
      if (trialResult) {
        trialResult.textContent = '试译中…';
        trialResult.className = 'first-run-trial-dst';
      }
      try {
        await saveDraftProfile();
        const trialText = Helpers?.getFirstRunTrialText
          ? Helpers.getFirstRunTrialText()
          : 'Hello';
        const res = await chrome.runtime.sendMessage({
          action: 'translate',
          text: trialText,
          sourceLang: 'en',
          targetLang: 'zh'
        });
        if (res?.success && res.text) {
          state.trialOk = true;
          if (trialResult) {
            trialResult.textContent = res.text;
            trialResult.className = 'first-run-trial-dst ok';
          }
        } else {
          state.trialOk = false;
          const msg = res?.userError?.userMessage || res?.error || '试译失败';
          const hint = res?.userError?.actionHint ? `\n${res.userError.actionHint}` : '';
          if (trialResult) {
            trialResult.textContent = `${msg}${hint}`;
            trialResult.className = 'first-run-trial-dst err';
          }
        }
      } catch (e) {
        state.trialOk = false;
        if (trialResult) {
          trialResult.textContent = `试译异常：${e.message || e}`;
          trialResult.className = 'first-run-trial-dst err';
        }
      }
      syncPanes();
    });

    syncPanes();
  }

  try {
    await initFirstRunWizard();
  } catch (e) {
    console.warn('[YuxTrans] 首次引导初始化失败:', e);
  }

  // 渲染当前使用（ActiveConfig 可点击展示）
  function renderActiveConfig() {
    const nameEl = getById('activeProfileName');
    const detailEl = getById('activeProfileDetail');
    if (!nameEl || !detailEl) return;
    const activeProfile = getActiveProfile(config);
    if (!activeProfile) {
      nameEl.textContent = '未选择服务档案';
      detailEl.textContent = '请在「服务档案」标签页配置并保存一个档案';
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
    // F7：谷歌免费接口零配置（免 Key / 端点 / 模型选择），与 local/custom 一样隐藏配置字段
    const isGoogle = provider === 'google';
    const isNoConfig = isLocal || isCustom || isGoogle;
    if (apiKeyGroup) apiKeyGroup.style.display = isNoConfig ? 'none' : 'block';
    if (endpointGroup) endpointGroup.style.display = isNoConfig ? 'none' : 'block';
    if (modelSelectGroup) modelSelectGroup.style.display = isNoConfig ? 'none' : 'block';
    if (localModelGroup) localModelGroup.style.display = isLocal ? 'block' : 'none';
    if (customProviderSection) customProviderSection.style.display = isCustom ? 'block' : 'none';
    const activeProfile = getActiveProfile(config);
    const selectedModel = activeProfile?.model || config?.model || '';
    if (!isLocal && !isCustom && !isGoogle) loadModelOptions(provider, selectedModel);
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

  // F8：model-card 点击选中（radio 语义）--选中填入 localModelInput 并高亮对应卡
  function selectModelCard(modelName) {
    if (!modelName) return;
    if (localModelInput) localModelInput.value = modelName;
    document.querySelectorAll('.model-card').forEach((card) => {
      const isSel = card.dataset.model === modelName;
      card.classList.toggle('selected', isSel);
      card.setAttribute('aria-checked', isSel ? 'true' : 'false');
    });
  }

  document.querySelectorAll('.model-card').forEach((card) => {
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');
    card.addEventListener('click', () => selectModelCard(card.dataset.model));
  });

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

    // F7：谷歌免费接口免 Key
    if (!apiKey && provider !== 'local' && provider !== 'google') {
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

  // 自定义端点按需申请域名权限（optional_host_permissions，不预先放开全域名）
  async function ensureCustomHostPermission(endpoint) {
    if (!endpoint) return true;
    if (typeof chrome === 'undefined' || !chrome.permissions) return true;
    try {
      const pattern = new URL(endpoint).origin + '/*';
      if (await chrome.permissions.contains({ origins: [pattern] })) return true;
      return await chrome.permissions.request({ origins: [pattern] });
    } catch (e) {
      return false;
    }
  }

  // 自定义供应商连接测试
  const testCustomBtn = getById('testCustomBtn');
  testCustomBtn?.addEventListener('click', async () => {
    const endpoint = customEndpointInput.value.trim();
    if (endpoint && !await ensureCustomHostPermission(endpoint)) {
      showCustomTestResult('未授权该端点域名，已取消测试', 'error');
      return;
    }
    handleTestConnection('custom', testCustomBtn, {
      apiKey: customApiKeyInput.value.trim(),
      endpoint,
      model: getCustomModelValue()
    });
  });

  // 自定义供应商测试结果显示
  const customTestResult = getById('customTestResult');
  // 复用 showStatus 的逻辑，但输出到 customTestResult 而非浮动层
  function showCustomTestResult(msg, type) {
    if (!customTestResult) return;
    customTestResult.removeAttribute('style');
    customTestResult.className = `yxt-inline-status ${type === 'success' ? 'is-success' : 'is-error'}`;
    customTestResult.textContent = msg;
  }

  // ===== 刷新列表 (通用) =====
  async function handleFetchModels(provider, btnEl, targetSelect) {
    const apiKey = apiKeyInput.value.trim();
    const endpoint = apiEndpointInput.value.trim() || defaults.endpoints[provider];

    // F7：谷歌免费接口免 Key
    if (!apiKey && provider !== 'local' && provider !== 'google') {
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
      showStatus('网络请求失败', 'error');
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
    if (!await ensureCustomHostPermission(endpoint)) {
      showStatus('未授权该端点域名，已取消获取', 'error'); return;
    }

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
    // F7：谷歌免费接口零配置，无需模型
    const isGoogle = provider === 'google';
    const modelId = isLocal
      ? localModelInput.value.trim()
      : (isCustom ? getCustomModelValue() : (isGoogle ? 'gtx' : (modelSelect.value || '')));

    if (!modelId && !isGoogle) {
      showStatus(isLocal ? '请填写本地模型名称' : '请先选择一个模型', 'error');
      return;
    }

    const profile = {
      provider,
      label: `${PROVIDER_NAMES[provider] || provider} - ${modelId || 'default'}`,
      apiKey: isLocal || isCustom || isGoogle ? '' : apiKeyInput.value.trim(),
      apiEndpoint: isLocal || isCustom || isGoogle ? '' : apiEndpointInput.value.trim(),
      model: isLocal || isGoogle ? '' : modelId,
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
        syncQuickStartVisibility();
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

  // ===== 分栏保存 ActiveConfig（F1：仅写入本模块字段） =====
  function collectAllModuleValues() {
    const getVal = (el) => el?.value || '';
    const getChecked = (el) => el?.checked || false;
    return {
      cacheEnabled: cacheEnabledInput ? getChecked(cacheEnabledInput) : true,
      maxCacheMB: parseInt(getVal(maxCacheMBInput) || '200', 10),
      sourceLang: getVal(sourceLangSelect) || 'auto',
      targetLang: getVal(targetLangSelect) || 'zh',
      translateStyle: document.querySelector('input[name="translateStyle"]:checked')?.value || 'normal',
      stylePrompts: collectStylePromptsForSave(),
      triggerMode: document.querySelector('input[name="triggerMode"]:checked')?.value || 'auto',
      autoCopy: getChecked(autoCopyCheckbox),
      siteRule: getVal(siteRuleSelect) || 'all',
      siteList: getVal(siteListTextarea).split('\n').map((s) => s.trim()).filter(Boolean),
      autoDetectLang: autoDetectLangInput ? getChecked(autoDetectLangInput) : true,
      autoFallback: autoFallbackInput ? getChecked(autoFallbackInput) : true,
      enableStreaming: enableStreamingInput ? getChecked(enableStreamingInput) : true,
      offlineMode: offlineModeInput ? getChecked(offlineModeInput) : false,
      hoverTranslate: hoverTranslateInput ? getChecked(hoverTranslateInput) : true,
      hoverModifier: getVal(hoverModifierSelect) === 'ctrl' ? 'ctrl' : 'alt',
      dictMode: dictModeInput ? getChecked(dictModeInput) : true,
      dictDblclick: dictDblclickInput ? getChecked(dictDblclickInput) : true,
      originalStyle: ['normal', 'fade', 'blur'].includes(getVal(originalStyleSelect)) ? getVal(originalStyleSelect) : 'normal',
      inputTranslate: inputTranslateInput ? getChecked(inputTranslateInput) : false,
      smartContentDetection: smartContentDetectionInput ? getChecked(smartContentDetectionInput) : false,
      compareProfileId: compareProfileIdSelect ? (getVal(compareProfileIdSelect) || '') : ''
    };
  }

  /**
   * 保存指定模块切片
   * @param {string} moduleId
   * @param {string} successMsg
   */
  async function saveModuleConfig(moduleId, successMsg) {
    try {
      const all = collectAllModuleValues();
      const slice = Helpers?.pickModuleConfig
        ? Helpers.pickModuleConfig(moduleId, all)
        : all;
      if (!slice || !Object.keys(slice).length) {
        showStatus('无可保存字段', 'error');
        return;
      }
      const res = await chrome.runtime.sendMessage({ action: 'setConfig', config: slice });
      if (res?.success) {
        showStatus(successMsg, 'success');
        config = { ...config, ...slice };
        renderActiveConfig();
        syncQuickStartVisibility();
      } else {
        showStatus(`保存失败: ${res?.error || '未知响应'}`, 'error');
      }
    } catch (err) {
      console.error('[YuxTrans] Save Error:', err);
      showStatus(`运行异常: ${err.message}`, 'error');
    }
  }

  savePreferenceBtn?.addEventListener('click', async () => {
    await saveModuleConfig('preference', '翻译偏好已保存');
    // 保存后按服务端清洗结果刷新草稿（与默认相同的键会被去掉）
    if (config) {
      loadStylePromptsDraftFromConfig(config);
      refreshStylePromptEditor();
    }
  });
  saveInteractionBtn?.addEventListener('click', () => {
    saveModuleConfig('interaction', '交互与显示已保存');
  });
  saveDataBtn?.addEventListener('click', () => {
    saveModuleConfig('data', '数据设置已保存');
  });

  // ===== 术语表导入 / 清空 =====
  importGlossaryInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const res = await chrome.runtime.sendMessage({
        action: 'importGlossary',
        raw,
        filename: file.name,
        replace: false
      });
      if (res?.success) {
        config.glossary = res.glossary || [];
        if (glossaryCountEl) glossaryCountEl.textContent = String(res.count || 0);
        showStatus(`已导入术语，当前共 ${res.count || 0} 条`, 'success');
      } else {
        showStatus(`导入失败: ${res?.error || '未知错误'}`, 'error');
      }
    } catch (err) {
      showStatus(`导入异常: ${err.message}`, 'error');
    }
    e.target.value = '';
  });

  clearGlossaryBtn?.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'clearGlossary' });
      if (res?.success) {
        config.glossary = [];
        if (glossaryCountEl) glossaryCountEl.textContent = '0';
        showStatus('术语表已清空', 'success');
      } else {
        showStatus(`清空失败: ${res?.error || ''}`, 'error');
      }
    } catch (err) {
      showStatus(`清空异常: ${err.message}`, 'error');
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
        storageProgressBar.classList.remove('is-high', 'is-warn');
        if (percent > 90) storageProgressBar.classList.add('is-high');
        else if (percent > 70) storageProgressBar.classList.add('is-warn');
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
        metricsRecentErrorsEl.innerHTML = '<div class="yxt-empty">暂无失败记录</div>';
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
      requestLogsContainer.innerHTML = '<div class="yxt-empty">暂无请求日志</div>';
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