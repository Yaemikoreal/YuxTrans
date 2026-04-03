/**
 * Background Service Worker
 * 处理翻译请求、缓存管理、消息路由、历史记录
 * 支持自定义供应商和连接测试
 */

const API_ENDPOINTS = {
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
  qwen: 'qwen-turbo',
  openai: 'gpt-4o-mini',
  deepseek: 'deepseek-chat',
  anthropic: 'claude-3-5-haiku-latest',
  groq: 'llama-3.1-8b-instant',
  moonshot: 'moonshot-v1-8k',
  siliconflow: 'Qwen/Qwen2.5-7B-Instruct',
  local: 'qwen2:7b'
};

const STYLE_PROMPTS = {
  normal: '',
  academic: 'Please translate in an academic and formal style, using precise terminology.',
  technical: 'Please translate with technical accuracy, preserving technical terms and code references.',
  literary: 'Please translate with literary elegance and artistic expression.'
};

let config = {
  provider: 'qwen',
  apiKey: '',
  apiEndpoint: '', // 自定义端点
  model: '', // 选中的模型
  localModel: 'qwen2:7b',
  cacheEnabled: true,
  cacheSize: 1000,
  customProvider: {
    name: '',
    endpoint: '',
    apiKey: '',
    format: 'openai',
    model: ''
  },
  sourceLang: 'auto',
  targetLang: 'zh',
  translateStyle: 'normal',
  triggerMode: 'auto',
  autoCopy: false,
  showFloatBtn: true,
  siteRule: 'all',
  siteList: [],
  autoDetectLang: true,
  saveHistory: true
};

let cache = new Map(); // 内存缓存（快速访问）
let cacheOrder = [];
let translationHistory = [];
let cacheStats = { wordCount: 0, sizeBytes: 0 }; // 缓存统计

// ===== 缓存批处理优化 =====
let pendingCacheSave = false;
let cacheSaveTimer = null;

// 从 chrome.storage.local 加载持久化缓存
async function loadCacheFromStorage() {
  const stored = await chrome.storage.local.get(['cacheData', 'cacheOrder']);
  if (stored.cacheData) {
    // 将存储的对象转换为 Map
    const entries = Object.entries(stored.cacheData);
    cache = new Map(entries);
    cacheOrder = stored.cacheOrder || [];
    // 计算缓存统计
    updateCacheStats();
  }
}

// 保存缓存到 chrome.storage.local（批处理优化）
async function saveCacheToStorage() {
  // 延迟保存，避免频繁写入
  if (pendingCacheSave) return;

  pendingCacheSave = true;

  // 清除之前的定时器
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
  }

  // 延迟 500ms 后保存，合并多次修改
  cacheSaveTimer = setTimeout(async () => {
    try {
      const cacheData = Object.fromEntries(cache);
      await chrome.storage.local.set({ cacheData, cacheOrder });
    } catch (error) {
      console.error('保存缓存失败:', error);
    }
    pendingCacheSave = false;
    cacheSaveTimer = null;
  }, 500);
}

// 更新缓存统计
function updateCacheStats() {
  let totalBytes = 0;
  let wordCount = 0;

  for (const [key, value] of cache) {
    // 计算键和值的字节大小
    totalBytes += new Blob([key]).size;
    totalBytes += new Blob([value]).size;
    // 统计词汇数量（每个缓存条目算一个词对）
    wordCount++;
  }

  cacheStats = { wordCount, sizeBytes: totalBytes };
}

async function loadConfig() {
  const stored = await chrome.storage.sync.get('config');
  if (stored.config) {
    config = { ...config, ...stored.config };
  }

  // 加载历史记录
  const historyStored = await chrome.storage.local.get('history');
  if (historyStored.history) {
    translationHistory = historyStored.history;
  }

  // 加载持久化缓存
  await loadCacheFromStorage();
}

async function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  await chrome.storage.sync.set({ config });
}

async function saveHistory() {
  await chrome.storage.local.set({ history: translationHistory });
}

function getFromCache(key) {
  if (!config.cacheEnabled) return null;

  if (cache.has(key)) {
    const value = cache.get(key);
    cacheOrder = cacheOrder.filter(k => k !== key);
    cacheOrder.push(key);
    return value;
  }
  return null;
}

async function setToCache(key, value) {
  if (!config.cacheEnabled) return;

  if (cache.size >= config.cacheSize) {
    const oldest = cacheOrder.shift();
    cache.delete(oldest);
  }

  cache.set(key, value);
  cacheOrder.push(key);

  // 更新统计并持久化保存
  updateCacheStats();
  await saveCacheToStorage();
}

function generateCacheKey(text, sourceLang, targetLang) {
  return `${sourceLang}:${targetLang}:${text}`;
}

async function translateWithCloud(text, sourceLang = 'auto', targetLang = 'zh') {
  const isCustom = config.provider === 'custom';
  // 优先使用自定义端点，否则使用默认端点
  const endpoint = isCustom ? config.customProvider.endpoint :
    (config.apiEndpoint || API_ENDPOINTS[config.provider]);

  const apiKey = isCustom ? config.customProvider.apiKey :
    (config.provider === 'local' ? '' : config.apiKey);

  // 优先使用选中的模型
  const model = isCustom ? config.customProvider.model :
    (config.model || DEFAULT_MODELS[config.provider] || 'gpt-3.5-turbo');

  if (!apiKey && config.provider !== 'local' && !isCustom) {
    throw new Error('请先配置 API Key');
  }

  if (!endpoint && isCustom) {
    throw new Error('请配置自定义 API 地址');
  }

  // 构建翻译提示
  const stylePrompt = STYLE_PROMPTS[config.translateStyle] || '';
  let prompt;
  if (sourceLang === 'auto') {
    prompt = `Translate the following text to ${targetLang === 'zh' ? 'Chinese' : targetLang}. ${stylePrompt} Provide only the translation, without any explanation.\n\n${text}`;
  } else {
    prompt = `Translate the following text from ${sourceLang} to ${targetLang === 'zh' ? 'Chinese' : targetLang}. ${stylePrompt} Provide only the translation, without any explanation.\n\n${text}`;
  }

  let requestBody;
  let headers = { 'Content-Type': 'application/json' };

  const format = isCustom ? config.customProvider.format : config.provider;

  if (format === 'qwen') {
    headers['Authorization'] = `Bearer ${apiKey}`;
    requestBody = {
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    };
  } else if (format === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    requestBody = {
      model: model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    };
  } else if (config.provider === 'local') {
    requestBody = {
      model: config.localModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    };
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
    requestBody = {
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败: ${response.status} - ${errorText.slice(0, 100)}`);
  }

  const data = await response.json();

  let translatedText;
  if (format === 'qwen') {
    translatedText = data.output?.text || data.output?.choices?.[0]?.message?.content || data.choices?.[0]?.message?.content || '';
  } else if (format === 'anthropic') {
    translatedText = data.content?.[0]?.text || '';
  } else if (config.provider === 'local') {
    translatedText = data.message?.content || '';
  } else {
    translatedText = data.choices?.[0]?.message?.content || '';
  }

  return translatedText.trim();
}

async function testConnection(testConfig) {
  const { endpoint, apiKey, format, model } = testConfig;

  if (!endpoint) {
    return { success: false, error: '请输入 API 地址' };
  }

  const testText = 'Hello';
  const prompt = `Translate the following text to Chinese. Provide only the translation.\n\n${testText}`;

  let requestBody;
  let headers = { 'Content-Type': 'application/json' };

  try {
    if (format === 'qwen') {
      headers['Authorization'] = `Bearer ${apiKey}`;
      requestBody = {
        model: model,
        input: { messages: [{ role: 'user', content: prompt }] },
        parameters: { temperature: 0.3 }
      };
    } else if (format === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      requestBody = {
        model: model,
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      };
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      requestBody = {
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText.slice(0, 100)}` };
    }

    return { success: true };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 获取模型列表
async function fetchModels(testConfig) {
  const { provider, apiKey, endpoint } = testConfig;

  if (!apiKey) {
    return { success: false, error: '请先填写 API Key' };
  }

  try {
    // OpenAI 兼容接口获取模型列表
    const modelsEndpoint = endpoint.replace('/chat/completions', '/models');

    const response = await fetch(modelsEndpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return { success: false, error: `获取失败: HTTP ${response.status}` };
    }

    const data = await response.json();

    if (data.data && Array.isArray(data.data)) {
      const models = data.data
        .map(m => m.id)
        .filter(id => id && !id.includes(':')) // 过滤掉一些特殊模型
        .sort();
      return { success: true, models };
    } else if (data.models && Array.isArray(data.models)) {
      // Ollama 格式
      const models = data.models.map(m => m.name || m.model);
      return { success: true, models };
    }

    return { success: false, error: '无法解析模型列表' };
  } catch (error) {
    return { success: false, error: `获取失败: ${error.message}` };
  }
}

// 测试服务商连接
async function testProviderConnection(testConfig) {
  const { provider, apiKey, endpoint, model } = testConfig;

  if (!apiKey) {
    return { success: false, error: '请先填写 API Key' };
  }

  const testText = 'Hello';
  const prompt = `Translate the following text to Chinese. Provide only the translation.\n\n${testText}`;

  try {
    let headers = { 'Content-Type': 'application/json' };
    let requestBody;

    if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      requestBody = {
        model: model || DEFAULT_MODELS[provider],
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      };
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      requestBody = {
        model: model || DEFAULT_MODELS[provider],
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText.slice(0, 100)}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function translate(text, sourceLang = 'auto', targetLang = 'zh') {
  const cacheKey = generateCacheKey(text, sourceLang, targetLang);

  const cached = getFromCache(cacheKey);
  if (cached) {
    return { text: cached, cached: true, engine: 'cache' };
  }

  try {
    const translated = await translateWithCloud(text, sourceLang, targetLang);

    await setToCache(cacheKey, translated);

    // 保存历史记录
    if (config.saveHistory) {
      translationHistory.unshift({
        source: text,
        target: translated,
        sourceLang,
        targetLang,
        timestamp: Date.now()
      });

      // 限制历史记录数量
      if (translationHistory.length > 500) {
        translationHistory = translationHistory.slice(0, 500);
      }

      await saveHistory();
    }

    return { text: translated, cached: false, engine: config.provider };
  } catch (error) {
    console.error('Translation error:', error);
    throw error;
  }
}

// ===== 事件监听 =====

// 确保 service worker 启动时加载配置和历史
let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await loadConfig();
    initialized = true;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loadConfig();

  chrome.contextMenus.create({
    id: 'translate-selection',
    title: '翻译选中内容',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'translate-page',
    title: '翻译整页',
    contexts: ['page']
  });
});

// Service worker 启动时也加载配置
chrome.runtime.onStartup.addListener(() => {
  loadConfig();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate-selection') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'translateSelection',
      text: info.selectionText
    });
  } else if (info.menuItemId === 'translate-page') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'translatePage'
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 确保已初始化
  ensureInitialized().then(() => {
    if (request.action === 'translate') {
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      const targetLang = request.targetLang || config.targetLang || 'zh';

      translate(request.text, sourceLang, targetLang)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    if (request.action === 'getConfig') {
      sendResponse(config);
    }

    if (request.action === 'setConfig') {
      saveConfig(request.config)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    if (request.action === 'testConnection') {
      testConnection(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    if (request.action === 'fetchModels') {
      fetchModels(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    if (request.action === 'testProviderConnection') {
      testProviderConnection(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    if (request.action === 'clearCache') {
      cache.clear();
      cacheOrder = [];
      cacheStats = { wordCount: 0, sizeBytes: 0 };
      // 重置批处理状态
      pendingCacheSave = false;
      if (cacheSaveTimer) {
        clearTimeout(cacheSaveTimer);
        cacheSaveTimer = null;
      }
      // 清除持久化存储
      chrome.storage.local.remove(['cacheData', 'cacheOrder'])
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: true })); // 即使清除失败也返回成功
      return true; // 保持消息通道打开
    }

    if (request.action === 'getCacheStats') {
      // 确保缓存已加载
      updateCacheStats();
      sendResponse({
        success: true,
        stats: {
          wordCount: cacheStats.wordCount,
          sizeBytes: cacheStats.sizeBytes,
          sizeMB: Math.round(cacheStats.sizeBytes / 1024 / 1024 * 100) / 100,
          sizeGB: Math.round(cacheStats.sizeBytes / 1024 / 1024 / 1024 * 100) / 100
        }
      });
    }

    if (request.action === 'getHistory') {
      // 从存储重新加载以确保数据最新
      chrome.storage.local.get('history').then(result => {
        sendResponse({ history: result.history || [] });
      }).catch(error => {
        sendResponse({ history: [], error: error.message });
      });
    }

    if (request.action === 'clearHistory') {
      translationHistory = [];
      saveHistory()
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }
  });
  return true; // 保持消息通道打开
});

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (command === 'translate-selection') {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'translateSelection' });
    } else if (command === 'translate-page') {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'translatePage' });
    }
  });
});

loadConfig();