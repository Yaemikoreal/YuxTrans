/**
 * Options Script
 * 支持完整的设置功能：自定义供应商、语言设置、操作行为、历史记录
 */

// 默认 API 端点和模型
const DEFAULT_ENDPOINTS = {
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  moonshot: 'https://api.moonshot.cn/v1/chat/completions',
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  local: 'http://localhost:11434/api/chat'
};

const DEFAULT_MODELS = {
  qwen: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-max-longcontext'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  deepseek: ['deepseek-chat', 'deepseek-coder'],
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V2.5'],
  local: []
};

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
  const customModelInput = getById('customModel');

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

  // 6. 统计看板
  const totalTranslatesCountEl = getById('totalTranslatesCount');
  const cacheHitsCountEl = getById('cacheHitsCount');
  const cacheHitRateEl = getById('cacheHitRate');
  let cacheStatsInterval;

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
    console.error('加载系统配置失败:', error);
  }

  if (config) {
    if (providerSelect) providerSelect.value = config.provider || 'qwen';
    if (apiKeyInput) apiKeyInput.value = config.apiKey || '';
    if (apiEndpointInput) apiEndpointInput.value = config.apiEndpoint || '';
    if (localModelInput) localModelInput.value = config.localModel || 'qwen2:7b';
    if (cacheEnabledInput) cacheEnabledInput.checked = config.cacheEnabled !== false;
    if (maxCacheMBInput) maxCacheMBInput.value = config.maxCacheMB || 200;

    // 自定义
    if (config.customProvider) {
      if (customNameInput) customNameInput.value = config.customProvider.name || '';
      if (customEndpointInput) customEndpointInput.value = config.customProvider.endpoint || '';
      if (customApiKeyInput) customApiKeyInput.value = config.customProvider.apiKey || '';
      if (customFormatSelect) customFormatSelect.value = config.customProvider.format || 'openai';
      if (customModelInput) customModelInput.value = config.customProvider.model || '';
    }

    // 语言与风格
    if (sourceLangSelect) sourceLangSelect.value = config.sourceLang || 'auto';
    if (targetLangSelect) targetLangSelect.value = config.targetLang || 'zh';
    translateStyleRadios.forEach(radio => {
      radio.checked = radio.value === (config.translateStyle || 'normal');
    });

    // 行为
    triggerModeRadios.forEach(radio => {
      radio.checked = radio.value === (config.triggerMode || 'auto');
    });
    if (autoCopyCheckbox) autoCopyCheckbox.checked = config.autoCopy || false;
    if (siteRuleSelect) siteRuleSelect.value = config.siteRule || 'all';
    if (siteListTextarea) siteListTextarea.value = (config.siteList || []).join('\n');
    if (autoDetectLangInput) autoDetectLangInput.checked = config.autoDetectLang !== false;
  }

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
    const models = DEFAULT_MODELS[provider] || [];
    modelSelect.innerHTML = '';
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '请先获取模型列表';
      modelSelect.appendChild(opt);
      return;
    }
    models.forEach(m => {
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
    if (!isLocal && !isCustom) loadModelOptions(provider, config?.model);
  }

  providerSelect?.addEventListener('change', updateProviderUI);

  // ===== 连接测试 (通用) =====
  async function handleTestConnection(provider, btnEl) {
    const apiKey = apiKeyInput.value.trim();
    const endpoint = apiEndpointInput.value.trim() || DEFAULT_ENDPOINTS[provider];

    if (!apiKey && provider !== 'local') {
      showStatus('请先填写 API Key', 'error'); return;
    }

    btnEl.disabled = true;
    const originalText = btnEl.textContent;
    btnEl.textContent = '测试中...';

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'fetchModels',
        config: { provider, apiKey, endpoint }
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

  // ===== 刷新列表 (通用) =====
  async function handleFetchModels(provider, btnEl, targetSelect) {
    const apiKey = apiKeyInput.value.trim();
    const endpoint = apiEndpointInput.value.trim() || DEFAULT_ENDPOINTS[provider];

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
        const finalModels = [...new Set([...(DEFAULT_MODELS[provider] || []), ...res.models])];
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

  localModelSelect?.addEventListener('change', () => {
    localModelInput.value = localModelSelect.value;
  });

  // ===== 保存设置 =====
  saveBtn?.addEventListener('click', async () => {
    try {
      const getVal = (el) => el?.value || '';
      const getChecked = (el) => el?.checked || false;

      const newConfig = {
        provider: getVal(providerSelect) || 'qwen',
        apiKey: getVal(apiKeyInput),
        apiEndpoint: getVal(apiEndpointInput),
        model: getVal(modelSelect),
        localModel: getVal(localModelInput),
        cacheEnabled: cacheEnabledInput ? getChecked(cacheEnabledInput) : true,
        maxCacheMB: parseInt(getVal(maxCacheMBInput) || '200', 10),
        customProvider: {
          name: getVal(customNameInput).trim(),
          endpoint: getVal(customEndpointInput).trim(),
          apiKey: getVal(customApiKeyInput).trim(),
          format: getVal(customFormatSelect),
          model: getVal(customModelInput).trim()
        },
        sourceLang: getVal(sourceLangSelect) || 'auto',
        targetLang: getVal(targetLangSelect) || 'zh',
        translateStyle: document.querySelector('input[name="translateStyle"]:checked')?.value || 'normal',
        triggerMode: document.querySelector('input[name="triggerMode"]:checked')?.value || 'auto',
        autoCopy: getChecked(autoCopyCheckbox),
        siteRule: getVal(siteRuleSelect) || 'all',
        siteList: getVal(siteListTextarea).split('\n').map(s => s.trim()).filter(Boolean),
        autoDetectLang: autoDetectLangInput ? getChecked(autoDetectLangInput) : true
      };

      const res = await chrome.runtime.sendMessage({ action: 'setConfig', config: newConfig });
      if (res?.success) { 
        showStatus('设置已安全保存', 'success'); 
        config = newConfig; 
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
});