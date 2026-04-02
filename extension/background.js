/**
 * Background Service Worker
 * 处理翻译请求、缓存管理、消息路由、历史记录
 * 支持自定义供应商和连接测试
 */

const API_ENDPOINTS = {
  qwen: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
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

let cache = new Map();
let cacheOrder = [];
let translationHistory = [];

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

function setToCache(key, value) {
  if (!config.cacheEnabled) return;

  if (cache.size >= config.cacheSize) {
    const oldest = cacheOrder.shift();
    cache.delete(oldest);
  }

  cache.set(key, value);
  cacheOrder.push(key);
}

function generateCacheKey(text, sourceLang, targetLang) {
  return `${sourceLang}:${targetLang}:${text}`;
}

async function translateWithCloud(text, sourceLang = 'auto', targetLang = 'zh') {
  const isCustom = config.provider === 'custom';
  const endpoint = isCustom ? config.customProvider.endpoint : API_ENDPOINTS[config.provider];

  const apiKey = isCustom ? config.customProvider.apiKey :
    (config.provider === 'local' ? '' : config.apiKey);

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
  const model = isCustom ? config.customProvider.model : (DEFAULT_MODELS[config.provider] || 'gpt-3.5-turbo');

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
    translatedText = data.output?.text || data.output?.choices?.[0]?.message?.content || '';
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

async function translate(text, sourceLang = 'auto', targetLang = 'zh') {
  const cacheKey = generateCacheKey(text, sourceLang, targetLang);

  const cached = getFromCache(cacheKey);
  if (cached) {
    return { text: cached, cached: true, engine: 'cache' };
  }

  try {
    const translated = await translateWithCloud(text, sourceLang, targetLang);

    setToCache(cacheKey, translated);

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

    if (request.action === 'clearCache') {
      cache.clear();
      cacheOrder = [];
      sendResponse({ success: true });
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