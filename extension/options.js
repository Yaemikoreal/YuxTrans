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
  // ===== 元素引用 =====
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  // 翻译引擎
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const apiEndpointInput = document.getElementById('apiEndpoint');
  const modelSelect = document.getElementById('modelSelect');
  const fetchModelsBtn = document.getElementById('fetchModelsBtn');
  const testProviderBtn = document.getElementById('testProviderBtn');
  const providerTestResult = document.getElementById('providerTestResult');
  const localModelInput = document.getElementById('localModel');
  const cacheEnabledInput = document.getElementById('cacheEnabled');
  const cacheSizeInput = document.getElementById('cacheSize');
  const apiKeyGroup = document.getElementById('apiKeyGroup');
  const endpointGroup = document.getElementById('endpointGroup');
  const modelSelectGroup = document.getElementById('modelSelectGroup');
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

  
  // 缓存统计
  const cacheWordCountEl = document.getElementById('cacheWordCount');
  const cacheSizeDisplayEl = document.getElementById('cacheSizeDisplay');

  // 按钮
  const saveBtn = document.getElementById('saveBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const testConnectionBtn = document.getElementById('testConnectionBtn');
  const statusEl = document.getElementById('status');
  const testResultEl = document.getElementById('testResult');

  // ===== 加载配置 =====
  let config = null;
  try {
    config = await chrome.runtime.sendMessage({ action: 'getConfig' });
  } catch (error) {
    console.error('加载配置失败:', error);
  }

  // 默认供应商和请求地址
  const defaultProvider = 'qwen';
  const defaultEndpoint = DEFAULT_ENDPOINTS[defaultProvider];

  if (config) {
    // 翻译引擎
    providerSelect.value = config.provider || defaultProvider;
    apiKeyInput.value = config.apiKey || '';
    localModelInput.value = config.localModel || 'qwen2:7b';
    cacheEnabledInput.checked = config.cacheEnabled !== false;
    cacheSizeInput.value = config.cacheSize || 1000;

    // 自动填充默认请求地址
    const provider = config.provider || defaultProvider;
    if (provider === 'custom' || provider === 'local') {
      apiEndpointInput.value = config.apiEndpoint || '';
    } else {
      // 非自定义/本地供应商：优先用户配置，否则用默认值
      apiEndpointInput.value = config.apiEndpoint || DEFAULT_ENDPOINTS[provider] || defaultEndpoint;
    }

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
  } else {
    // 首次使用：设置默认值
    providerSelect.value = defaultProvider;
    apiEndpointInput.value = defaultEndpoint;
  }

  // 加载缓存统计
  await loadCacheStats();

  // 初始化服务商 UI（在加载配置后）
  updateProviderUI();

  // ===== 标签页切换 =====
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // ===== 加载模型选项 =====
  function loadModelOptions(provider, selectedModel = '') {
    try {
      const models = DEFAULT_MODELS[provider] || [];
      modelSelect.innerHTML = '';

      if (models.length === 0) {
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '请先获取模型列表';
        modelSelect.appendChild(defaultOption);
        return;
      }

      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        if (model === selectedModel) {
          option.selected = true;
        }
        modelSelect.appendChild(option);
      });
    } catch (error) {
      console.error('加载模型选项失败:', error);
    }
  }

  // ===== 供应商 UI 更新 =====
  function updateProviderUI() {
    try {
      const provider = providerSelect.value;
      const isLocal = provider === 'local';
      const isCustom = provider === 'custom';

      // 控制 API Key 组显示
      if (apiKeyGroup) {
        apiKeyGroup.style.display = isLocal || isCustom ? 'none' : 'block';
      }

      // 控制请求地址组显示
      if (endpointGroup) {
        endpointGroup.style.display = isLocal || isCustom ? 'none' : 'block';
      }

      // 控制模型选择组显示
      if (modelSelectGroup) {
        modelSelectGroup.style.display = isLocal || isCustom ? 'none' : 'block';
      }

      // 控制本地模型组显示
      if (localModelGroup) {
        localModelGroup.style.display = isLocal ? 'block' : 'none';
      }

      // 控制自定义供应商区域显示
      if (customProviderSection) {
        customProviderSection.classList.toggle('show', isCustom);
      }

      // 更新请求地址默认值并加载模型
      if (!isLocal && !isCustom) {
        const defaultEndpoint = DEFAULT_ENDPOINTS[provider] || '';
        if (apiEndpointInput && defaultEndpoint) {
          // 切换供应商时：如果当前地址是旧供应商的默认地址，则更新为新供应商的默认地址
          const currentValue = apiEndpointInput.value.trim();
          const allDefaultEndpoints = Object.values(DEFAULT_ENDPOINTS);
          // 如果当前值为空，或者是某个供应商的默认地址，则更新
          if (!currentValue || allDefaultEndpoints.includes(currentValue)) {
            apiEndpointInput.value = defaultEndpoint;
          }
          apiEndpointInput.placeholder = '可自定义修改';
        }
        // 加载默认模型列表
        const savedModel = config && config.model ? config.model : '';
        loadModelOptions(provider, savedModel);
      }
    } catch (error) {
      console.error('更新供应商 UI 失败:', error);
    }
  }

  providerSelect.addEventListener('change', updateProviderUI);

  // ===== 获取模型列表 =====
  fetchModelsBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const endpoint = apiEndpointInput.value.trim() || DEFAULT_ENDPOINTS[provider];

    if (!apiKey) {
      showProviderTestResult(false, '请先填写 API Key');
      return;
    }

    fetchModelsBtn.disabled = true;
    fetchModelsBtn.textContent = '获取中...';

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'fetchModels',
        config: { provider, apiKey, endpoint }
      });

      if (response && response.success && response.models) {
        const defaultModels = DEFAULT_MODELS[provider] || [];

        // 预设模型排在前面，其他模型按字母排序排在后面
        const sortedModels = [
          ...defaultModels,
          ...response.models
            .filter(m => !defaultModels.includes(m))
            .sort()
        ];

        modelSelect.innerHTML = '';
        sortedModels.forEach(model => {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model;
          // 预设模型添加标记
          if (defaultModels.includes(model)) {
            option.textContent = model + ' (推荐)';
          }
          modelSelect.appendChild(option);
        });
        showProviderTestResult(true, `获取成功，共 ${sortedModels.length} 个模型`);
      } else {
        showProviderTestResult(false, response?.error || '获取模型列表失败');
      }
    } catch (error) {
      showProviderTestResult(false, `获取失败: ${error.message}`);
    } finally {
      fetchModelsBtn.disabled = false;
      fetchModelsBtn.textContent = '获取模型';
    }
  });

  // ===== 测试服务商连接 =====
  testProviderBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const endpoint = apiEndpointInput.value.trim() || DEFAULT_ENDPOINTS[provider];
    const model = modelSelect.value;

    if (!apiKey) {
      showProviderTestResult(false, '请先填写 API Key');
      return;
    }

    testProviderBtn.disabled = true;
    testProviderBtn.textContent = '测试中...';
    providerTestResult.style.display = 'none';

    const startTime = Date.now();

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'testProviderConnection',
        config: { provider, apiKey, endpoint, model }
      });

      const elapsed = Date.now() - startTime;

      if (response && response.success) {
        showProviderTestResult(true, `连接成功！响应时间: ${elapsed}ms`);
      } else {
        showProviderTestResult(false, response?.error || '连接失败');
      }
    } catch (error) {
      showProviderTestResult(false, `测试失败: ${error.message}`);
    } finally {
      testProviderBtn.disabled = false;
      testProviderBtn.textContent = '🔗 测试连接';
    }
  });

  function showProviderTestResult(success, message) {
    providerTestResult.className = `test-result ${success ? 'success' : 'error'}`;
    providerTestResult.innerHTML = `<div>${success ? '✅' : '❌'} ${message}</div>`;
    providerTestResult.style.display = 'block';
  }

  // ===== 测试自定义连接 =====
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
      apiEndpoint: apiEndpointInput.value,
      model: modelSelect.value,
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
      autoDetectLang: autoDetectLangInput.checked
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
      await loadCacheStats();
    } else {
      showStatus('清除失败', 'error');
    }
  });

  // ===== 缓存统计 =====
  async function loadCacheStats() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getCacheStats' });

      if (response && response.success) {
        const stats = response.stats;
        cacheWordCountEl.textContent = stats.wordCount;

        // 根据大小选择合适的单位显示
        if (stats.sizeGB >= 0.01) {
          cacheSizeDisplayEl.textContent = `${stats.sizeGB} GB`;
        } else if (stats.sizeMB >= 0.01) {
          cacheSizeDisplayEl.textContent = `${stats.sizeMB} MB`;
        } else {
          const sizeKB = Math.round(stats.sizeBytes / 1024 * 100) / 100;
          cacheSizeDisplayEl.textContent = sizeKB > 0 ? `${sizeKB} KB` : '0 KB';
        }
      } else {
        console.error('获取缓存统计失败:', response);
        cacheWordCountEl.textContent = '0';
        cacheSizeDisplayEl.textContent = '0 KB';
      }
    } catch (error) {
      console.error('加载缓存统计失败:', error);
      // 延迟重试一次
      setTimeout(async () => {
        try {
          const response = await chrome.runtime.sendMessage({ action: 'getCacheStats' });
          if (response && response.success) {
            const stats = response.stats;
            cacheWordCountEl.textContent = stats.wordCount;
            if (stats.sizeGB >= 0.01) {
              cacheSizeDisplayEl.textContent = `${stats.sizeGB} GB`;
            } else if (stats.sizeMB >= 0.01) {
              cacheSizeDisplayEl.textContent = `${stats.sizeMB} MB`;
            } else {
              const sizeKB = Math.round(stats.sizeBytes / 1024 * 100) / 100;
              cacheSizeDisplayEl.textContent = sizeKB > 0 ? `${sizeKB} KB` : '0 KB';
            }
          }
        } catch (e) {
          cacheWordCountEl.textContent = '0';
          cacheSizeDisplayEl.textContent = '0 KB';
        }
      }, 500);
    }
  }

  // ===== 工具函数 =====
  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = 'block';

    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 3000);
  }
});