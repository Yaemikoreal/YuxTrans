/**
 * Background Service Worker
 * 处理翻译请求、缓存管理、消息路由
 * 支持流式输出、上下文增强 Prompt、热点词库
 *
 * 优先支持：Chrome / Edge（Chromium 内核）
 */

// ===== 常量配置 =====

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
  academic: 'Use an academic and formal style with precise terminology.',
  technical: 'Preserve technical accuracy, keep technical terms and code references intact.',
  literary: 'Use literary elegance and artistic expression.'
};

// 语言代码 → 自然语言名称（用于 Prompt）
const LANG_NAMES = {
  'zh': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
  'en': 'English', 'ja': 'Japanese', 'ko': 'Korean',
  'fr': 'French', 'de': 'German', 'es': 'Spanish',
  'ru': 'Russian', 'pt': 'Portuguese', 'it': 'Italian',
  'ar': 'Arabic', 'th': 'Thai', 'vi': 'Vietnamese'
};

// 友好错误提示映射
const ERROR_MESSAGES = {
  401: 'API Key 无效或已过期，请在设置中检查',
  403: '无权限访问该模型，请确认 API Key 权限',
  429: '请求过于频繁，请稍后再试',
  500: '服务器内部错误，请稍后重试',
  502: '网关错误，请检查网络连接',
  503: '服务暂时不可用，请稍后重试',
  504: '请求超时，请检查网络或更换模型'
};

// 请求超时时间（毫秒）
const CLOUD_TIMEOUT_MS = 30000;
const LOCAL_TIMEOUT_MS = 120000;
const REQUEST_TIMEOUT_MS = 30000;

// ===== 热点词库（安装时预加载） =====
const BUILTIN_CACHE = {
  // --- 基础对话与指令 ---
  'auto:zh:Hello': '你好', 'auto:zh:hello': '你好',
  'auto:zh:World': '世界', 'auto:zh:world': '世界',
  'auto:zh:Thank you': '谢谢', 'auto:zh:thank you': '谢谢',
  'auto:zh:Thanks': '谢谢', 'auto:zh:thanks': '谢谢',
  'auto:zh:Welcome': '欢迎', 'auto:zh:welcome': '欢迎',
  'auto:zh:Sorry': '抱歉', 'auto:zh:sorry': '抱歉',
  'auto:zh:Yes': '是', 'auto:zh:No': '否',
  'auto:zh:OK': '好的', 'auto:zh:ok': '好的',
  'auto:zh:Good': '好', 'auto:zh:Bad': '坏',
  'auto:zh:Error': '错误', 'auto:zh:Success': '成功',
  'auto:zh:Loading': '加载中', 'auto:zh:Search': '搜索',
  'auto:zh:Submit': '提交', 'auto:zh:Cancel': '取消',
  'auto:zh:Confirm': '确认', 'auto:zh:Delete': '删除',
  'auto:zh:Edit': '编辑', 'auto:zh:Save': '保存',
  'auto:zh:Close': '关闭', 'auto:zh:Open': '打开',
  'auto:zh:Back': '返回', 'auto:zh:Next': '下一步',
  'auto:zh:Previous': '上一步', 'auto:zh:Home': '首页',
  'auto:zh:Settings': '设置', 'auto:zh:Help': '帮助',
  'auto:zh:About': '关于', 'auto:zh:Login': '登录',
  'auto:zh:Logout': '登出', 'auto:zh:Sign in': '登录',
  'auto:zh:Sign up': '注册', 'auto:zh:Sign out': '登出',
  'auto:zh:Username': '用户名', 'auto:zh:Password': '密码',
  'auto:zh:Email': '邮箱', 'auto:zh:Name': '名称',
  'auto:zh:Phone': '电话', 'auto:zh:Address': '地址',
  'auto:zh:Description': '描述', 'auto:zh:Title': '标题',
  'auto:zh:Content': '内容', 'auto:zh:Comment': '评论',
  'auto:zh:Reply': '回复', 'auto:zh:Share': '分享',
  'auto:zh:Like': '喜欢', 'auto:zh:Download': '下载',
  'auto:zh:Upload': '上传',
  'auto:zh:Result': '结果', 'auto:zh:Status': '状态',
  'auto:zh:Date': '日期', 'auto:zh:Time': '时间',
  'auto:zh:Today': '今天', 'auto:zh:Tomorrow': '明天',
  'auto:zh:Yesterday': '昨天', 'auto:zh:Week': '周',
  'auto:zh:Month': '月', 'auto:zh:Year': '年',
  'auto:zh:All': '全部', 'auto:zh:None': '无',
  'auto:zh:More': '更多', 'auto:zh:Less': '更少',
  'auto:zh:Show': '显示', 'auto:zh:Hide': '隐藏',
  'auto:zh:Enable': '启用', 'auto:zh:Disable': '禁用',
  'auto:zh:On': '开', 'auto:zh:Off': '关',
  'auto:zh:True': '真', 'auto:zh:False': '假',
  'auto:zh:New': '新建', 'auto:zh:Old': '旧的',
  'auto:zh:Add': '添加', 'auto:zh:Remove': '移除',
  'auto:zh:Clear': '清除', 'auto:zh:Reset': '重置',
  'auto:zh:Filter': '筛选', 'auto:zh:Sort': '排序',
  'auto:zh:Refresh': '刷新', 'auto:zh:Retry': '重试',
  'auto:zh:Continue': '继续', 'auto:zh:Stop': '停止',
  'auto:zh:Pause': '暂停', 'auto:zh:Resume': '恢复',
  'auto:zh:Send': '发送', 'auto:zh:Receive': '接收',
  'auto:zh:Connect': '连接', 'auto:zh:Disconnect': '断开',
  'auto:zh:Online': '在线', 'auto:zh:Offline': '离线',
  'auto:zh:Free': '免费', 'auto:zh:Premium': '高级',
  'auto:zh:Price': '价格', 'auto:zh:Total': '总计',
  'auto:zh:Language': '语言', 'auto:zh:Translate': '翻译',
  'auto:zh:Translation': '翻译', 'auto:zh:Original': '原文',
  'auto:zh:Preview': '预览', 'auto:zh:Publish': '发布',
  'auto:zh:Draft': '草稿', 'auto:zh:Archive': '归档',
  'auto:zh:Notification': '通知', 'auto:zh:Message': '消息',
  'auto:zh:Warning': '警告', 'auto:zh:Info': '信息',
  'auto:zh:Dashboard': '仪表盘', 'auto:zh:Profile': '个人资料',
  'auto:zh:Account': '账户', 'auto:zh:Privacy': '隐私',
  'auto:zh:Security': '安全', 'auto:zh:Terms': '条款',
  'auto:zh:Version': '版本', 'auto:zh:License': '许可证',
  'auto:zh:Copyright': '版权', 'auto:zh:Contact': '联系',
  'auto:zh:Feedback': '反馈', 'auto:zh:Report': '报告',
  'auto:zh:Analytics': '分析', 'auto:zh:Performance': '性能',
  'auto:zh:Overview': '概览', 'auto:zh:Summary': '摘要',
  'auto:zh:Detail': '详情', 'auto:zh:Details': '详情',
  'auto:zh:Feature': '功能', 'auto:zh:Features': '功能',
  'auto:zh:Option': '选项', 'auto:zh:Options': '选项',
  'auto:zh:Configuration': '配置', 'auto:zh:Preferences': '偏好',
  'auto:zh:General': '通用', 'auto:zh:Advanced': '高级',
  'auto:zh:Basic': '基础', 'auto:zh:Custom': '自定义',
  'auto:zh:Default': '默认', 'auto:zh:Required': '必填',
  'auto:zh:Optional': '可选', 'auto:zh:Recommended': '推荐',
  'auto:zh:Popular': '热门', 'auto:zh:Recent': '最近',
  'auto:zh:Trending': '趋势', 'auto:zh:Category': '分类',
  'auto:zh:Tag': '标签', 'auto:zh:Tags': '标签',
  'auto:zh:Label': '标签', 'auto:zh:Note': '备注',
  'auto:zh:Notes': '备注', 'auto:zh:Example': '示例',
  'auto:zh:Sample': '样本', 'auto:zh:Test': '测试',
  'auto:zh:Debug': '调试', 'auto:zh:Log': '日志',
  'auto:zh:History': '历史', 'auto:zh:Bookmark': '书签',
  'auto:zh:Favorite': '收藏', 'auto:zh:Star': '星标',
  // 常用短语
  'auto:zh:Click here': '点击这里',
  'auto:zh:Learn more': '了解更多',
  'auto:zh:Read more': '阅读更多',
  'auto:zh:See more': '查看更多',
  'auto:zh:View all': '查看全部',
  'auto:zh:Show more': '显示更多',
  'auto:zh:Load more': '加载更多',
  'auto:zh:Get started': '开始使用',
  'auto:zh:Try again': '重试',
  'auto:zh:Go back': '返回',
  'auto:zh:Not found': '未找到',
  'auto:zh:No results': '无结果',
  'auto:zh:No data': '无数据',
  'auto:zh:Coming soon': '即将推出',
  'auto:zh:Under construction': '建设中',
  'auto:zh:Terms of Service': '服务条款',
  'auto:zh:Privacy Policy': '隐私政策',
  'auto:zh:All rights reserved': '保留所有权利',
  'auto:zh:Powered by': '技术支持',
  'auto:zh:Made with': '使用创建',
  // 英翻中 - 技术
  'auto:zh:API': 'API',
  'auto:zh:SDK': 'SDK',
  'auto:zh:Bug': '缺陷',
  'auto:zh:Deploy': '部署',
  'auto:zh:Release': '发布',
  'auto:zh:Repository': '仓库',
  'auto:zh:Branch': '分支',
  'auto:zh:Merge': '合并',
  'auto:zh:Pull Request': '拉取请求',
  'auto:zh:Issue': '问题',
  'auto:zh:Commit': '提交',
  // 中翻英
  'auto:en:你好': 'Hello', 'auto:en:谢谢': 'Thank you',
  'auto:en:欢迎': 'Welcome', 'auto:en:再见': 'Goodbye',
  'auto:en:是': 'Yes', 'auto:en:否': 'No',
  'auto:en:好的': 'OK', 'auto:en:搜索': 'Search',
  'auto:en:设置': 'Settings', 'auto:en:帮助': 'Help',
  'auto:en:登录': 'Login', 'auto:en:注册': 'Register',
  'auto:en:确认': 'Confirm', 'auto:en:取消': 'Cancel',
  'auto:en:删除': 'Delete', 'auto:en:编辑': 'Edit',
  'auto:en:保存': 'Save', 'auto:en:提交': 'Submit',
  'auto:en:翻译': 'Translate', 'auto:en:复制': 'Copy',
  
  // --- 深度开发与技术词汇 (面向开发者加速) ---
  'auto:zh:Repository': '仓库', 'auto:zh:Commit': '提交',
  'auto:zh:Branch': '分支', 'auto:zh:Merge': '合并',
  'auto:zh:Pull request': '拉取请求', 'auto:zh:Issue': '工单/问题',
  'auto:zh:Context': '上下文', 'auto:zh:Environment': '环境',
  'auto:zh:Configuration': '配置', 'auto:zh:Deployment': '部署',
  'auto:zh:Build': '构建', 'auto:zh:Production': '生产环境',
  'auto:zh:Development': '开发环境', 'auto:zh:Interface': '接口/界面',
  'auto:zh:Algorithm': '算法', 'auto:zh:Protocol': '协议',
  'auto:zh:Function': '函数', 'auto:zh:Method': '方法',
  'auto:zh:Property': '属性', 'auto:zh:Variable': '变量',
  'auto:zh:Constant': '常量', 'auto:zh:Object': '对象',
  'auto:zh:Array': '数组', 'auto:zh:String': '字符串',
  'auto:zh:Boolean': '布尔值', 'auto:zh:Integer': '整数',
  'auto:zh:Float': '浮点数', 'auto:zh:Double': '双精度',
  'auto:zh:Character': '字符', 'auto:zh:Class': '类',
  'auto:zh:Structure': '结构', 'auto:zh:Template': '模板',
  'auto:zh:Abstract': '抽象', 'auto:zh:Static': '静态',
  'auto:zh:Dynamic': '动态', 'auto:zh:Synchronous': '同步',
  'auto:zh:Asynchronous': '异步', 'auto:zh:Callback': '回调',
  'auto:zh:Promise': '期约', 'auto:zh:Stream': '流',
  'auto:zh:Buffer': '缓冲区', 'auto:zh:Socket': '套接字',
  'auto:zh:Session': '会话', 'auto:zh:Cookie': '缓存',
  'auto:zh:Token': '令牌', 'auto:zh:Header': '头部',
  'auto:zh:Payload': '负载', 'auto:zh:Status Code': '状态码',
  'auto:zh:Endpoint': '端点', 'auto:zh:Authentication': '认证',
  'auto:zh:Authorization': '授权', 'auto:zh:Encryption': '加密',
  'auto:zh:Decryption': '解密', 'auto:zh:Signature': '签名',
  'auto:zh:Certificate': '证书', 'auto:zh:Primary Key': '主键',
  'auto:zh:Foreign Key': '外键', 'auto:zh:Index': '索引',
  'auto:zh:Query': '查询', 'auto:zh:Transaction': '事务',
  'auto:zh:Log': '日志', 'auto:zh:Dependency': '依赖',
  'auto:zh:Plugin': '插件', 'auto:zh:Extension': '扩展',
  'auto:zh:Component': '组件', 'auto:zh:Framework': '框架',
  'auto:zh:Library': '库', 'auto:zh:Module': '模块',
  'auto:zh:Package': '包', 'auto:zh:Namespace': '命名空间',
  'auto:zh:Runtime': '运行时', 'auto:zh:Service': '服务',
  'auto:zh:Middleware': '中间件', 'auto:zh:Pipeline': '流水线'
};

// ===== 运行时状态 =====

let config = {
  provider: 'qwen',
  apiKey: '',
  apiEndpoint: '',
  model: '',
  localModel: 'qwen2:7b',
  cacheEnabled: true,
  maxCacheMB: 200, // 物理空间限额提升至 200MB
  customProvider: {
    name: '', endpoint: '', apiKey: '', format: 'openai', model: ''
  },
  sourceLang: 'auto',
  targetLang: 'zh',
  translateStyle: 'normal',
  triggerMode: 'auto',
  autoCopy: false,
  showFloatBtn: true,
  bilingualMode: true,
  siteRule: 'all',
  siteList: [],
  autoDetectLang: true
};

let cache = new Map();
let cacheOrder = [];
let cacheStats = { wordCount: 0, sizeBytes: 0 };
let db = null;

let usageStats = { totalCount: 0, cacheHits: 0 };

async function loadUsageStats() {
  const stored = await chrome.storage.local.get('usageStats');
  if (stored.usageStats) usageStats = stored.usageStats;
}

function recordUsage(isCacheHit, count = 1) {
  usageStats.totalCount += count;
  if (isCacheHit) usageStats.cacheHits += count;
  // 简易防抖保存
  chrome.storage.local.set({ usageStats });
}

// ===== IndexedDB（带重连机制） =====

const DB_NAME = 'YuxTransDB';
const DB_VERSION = 1;
const CACHE_STORE = 'translations';

/**
 * 打开 IndexedDB，带连接有效性检查
 * Service Worker 休眠后 db 引用可能失效
 */
async function openDatabase() {
  if (db) {
    try {
      // 轻量级检查：尝试创建事务验证连接存活
      const tx = db.transaction(CACHE_STORE, 'readonly');
      tx.abort();
      return db;
    } catch (e) {
      // 连接已断开，重置后重新打开
      db = null;
    }
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[YuxTrans] IndexedDB 打开失败:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      // 监听连接关闭事件，自动重置引用
      db.onclose = () => { db = null; };
      db.onerror = () => { db = null; };
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) {
        const store = database.createObjectStore(CACHE_STORE, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

async function loadCacheFromDB() {
  try {
    const database = await openDatabase();
    return new Promise((resolve) => {
      const transaction = database.transaction(CACHE_STORE, 'readonly');
      const store = transaction.objectStore(CACHE_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        const items = request.result;
        cache.clear();
        cacheOrder = [];

        items.sort((a, b) => b.timestamp - a.timestamp);
        for (const item of items) {
          cache.set(item.key, item.value);
          cacheOrder.push(item.key);
        }

        // 应用缓存字节限额限制 (LRU: 物理空间驱动)
        const maxBytes = (config.maxCacheMB || 200) * 1024 * 1024;
        let currentBytes = 0;
        
        // 重新核算字节占用并裁剪
        for (const key of cacheOrder) {
          const value = cache.get(key);
          currentBytes += key.length * 2 + value.length * 2;
        }

        while (currentBytes > maxBytes && cacheOrder.length > 0) {
          const oldestKey = cacheOrder.shift();
          const oldestVal = cache.get(oldestKey);
          currentBytes -= oldestKey.length * 2 + oldestVal.length * 2;
          cache.delete(oldestKey);
        }

        updateCacheStats();
        resolve();
      };

      request.onerror = () => {
        console.error('[YuxTrans] 从 IndexedDB 加载缓存失败:', request.error);
        resolve();
      };
    });
  } catch (error) {
    console.error('[YuxTrans] 打开 IndexedDB 失败:', error);
  }
}

// 批处理写入控制
let pendingCacheSave = false;
let cacheSaveTimer = null;

async function saveCacheToDB() {
  if (pendingCacheSave) return;
  pendingCacheSave = true;

  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);

  cacheSaveTimer = setTimeout(async () => {
    try {
      const database = await openDatabase();
      const transaction = database.transaction(CACHE_STORE, 'readwrite');
      const store = transaction.objectStore(CACHE_STORE);

      store.clear();
      const timestamp = Date.now();
      for (const [key, value] of cache) {
        store.put({ key, value, timestamp });
      }

      transaction.oncomplete = () => {
        pendingCacheSave = false;
        cacheSaveTimer = null;
      };
      transaction.onerror = () => {
        console.error('[YuxTrans] 保存缓存到 IndexedDB 失败');
        pendingCacheSave = false;
        cacheSaveTimer = null;
      };
    } catch (error) {
      console.error('[YuxTrans] IndexedDB 写入失败:', error);
      pendingCacheSave = false;
      cacheSaveTimer = null;
    }
  }, 500);
}

function updateCacheStats() {
  let totalBytes = 0;
  for (const [key, value] of cache) {
    totalBytes += key.length * 2 + value.length * 2; // UTF-16 估算
  }
  cacheStats = { wordCount: cache.size, sizeBytes: totalBytes };
}

// ===== 缓存操作 =====

function getFromCache(key) {
  if (!config.cacheEnabled) return null;
  if (cache.has(key)) {
    const value = cache.get(key);
    // LRU: 移到最近位置
    cacheOrder = cacheOrder.filter(k => k !== key);
    cacheOrder.push(key);
    return value;
  }
  return null;
}

async function setToCache(key, value) {
  if (!config.cacheEnabled) return;
  
  const entryBytes = key.length * 2 + value.length * 2;
  const maxBytes = (config.maxCacheMB || 200) * 1024 * 1024;

  // 1. 存入新项
  cache.set(key, value);
  cacheOrder.push(key);
  
  // 2. 动态统计与裁剪
  let currentBytes = 0;
  for (const k of cacheOrder) {
    const v = cache.get(k);
    currentBytes += k.length * 2 + v.length * 2;
  }

  while (currentBytes > maxBytes && cacheOrder.length > 0) {
    const oldestKey = cacheOrder.shift();
    const oldestVal = cache.get(oldestKey);
    currentBytes -= oldestKey.length * 2 + oldestVal.length * 2;
    cache.delete(oldestKey);
  }

  updateCacheStats();
  await saveCacheToDB();
}

function generateCacheKey(text, sourceLang, targetLang) {
  return `${sourceLang}:${targetLang}:${text}`;
}

// ===== 配置管理 =====

async function loadConfig() {
  const stored = await chrome.storage.sync.get('config');
  if (stored.config) {
    config = { ...config, ...stored.config };
  }
  await loadCacheFromDB();
}

async function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  await chrome.storage.sync.set({ config });
}

// ===== Prompt 构建（上下文增强）=====

function buildTranslationPrompt(text, sourceLang, targetLang, context) {
  const targetName = LANG_NAMES[targetLang] || targetLang;
  const sourceName = sourceLang === 'auto' ? null : (LANG_NAMES[sourceLang] || sourceLang);
  const styleHint = STYLE_PROMPTS[config.translateStyle] || '';

  // 构建上下文提示
  let contextHint = '';
  if (context) {
    if (context.pageTitle) {
      contextHint += `\nPage context: "${context.pageTitle}"`;
    }
    if (context.pageUrl) {
      try {
        const domain = new URL(context.pageUrl).hostname;
        contextHint += ` (${domain})`;
      } catch (e) { /* ignore */ }
    }
  }

  let prompt = `You are a professional translator. Translate the following text`;
  if (sourceName) {
    prompt += ` from ${sourceName}`;
  }
  prompt += ` to ${targetName}.`;

  if (styleHint) {
    prompt += ` ${styleHint}`;
  }

  prompt += `
Rules:
- Provide ONLY the translation, no explanations or notes
- Translate naturally, not word-by-word
- Preserve proper nouns, brand names, URLs, and code unchanged
- Keep numbers, punctuation marks, and formatting intact`;

  if (contextHint) {
    prompt += `\n${contextHint}`;
  }

  prompt += `\n\n${text}`;
  return prompt;
}

// ===== 翻译核心 =====

function getEndpoint() {
  const isCustom = config.provider === 'custom';
  return isCustom
    ? config.customProvider.endpoint
    : (config.apiEndpoint || API_ENDPOINTS[config.provider]);
}

function getApiKey() {
  const isCustom = config.provider === 'custom';
  return isCustom
    ? config.customProvider.apiKey
    : (config.provider === 'local' ? '' : config.apiKey);
}

function getModel() {
  const isCustom = config.provider === 'custom';
  return isCustom
    ? config.customProvider.model
    : (config.model || DEFAULT_MODELS[config.provider] || 'gpt-3.5-turbo');
}

function getFormat() {
  return config.provider === 'custom' ? config.customProvider.format : config.provider;
}

/**
 * 构建 API 请求参数
 */
function buildRequest(prompt, stream = false) {
  const format = getFormat();
  const model = getModel();
  const apiKey = getApiKey();
  let headers = { 'Content-Type': 'application/json' };
  let body;

  if (format === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      max_tokens: 4096,
      stream,
      messages: [{ role: 'user', content: prompt }]
    };
  } else if (config.provider === 'local') {
    body = {
      model: config.localModel,
      messages: [{ role: 'user', content: prompt }],
      stream
    };
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      stream
    };
  }

  return { headers, body: JSON.stringify(body) };
}

/**
 * 解析非流式 API 响应
 */
function parseResponse(data, format) {
  if (format === 'anthropic') {
    return data.content?.[0]?.text || '';
  } else if (config.provider === 'local') {
    return data.message?.content || '';
  } else {
    // OpenAI / Qwen compatible / DeepSeek / Groq / Moonshot / Siliconflow
    return data.output?.text
      || data.output?.choices?.[0]?.message?.content
      || data.choices?.[0]?.message?.content
      || '';
  }
}

/**
 * 解析友好错误信息
 */
function formatError(status, errorText) {
  const friendly = ERROR_MESSAGES[status];
  if (friendly) return friendly;

  if (errorText && errorText.length > 200) {
    errorText = errorText.slice(0, 200);
  }

  return `请求失败 (${status}): ${errorText || '未知错误'}`;
}

/**
 * 非流式翻译请求
 */
async function translateWithCloud(text, sourceLang = 'auto', targetLang = 'zh', context = null) {
  // 网络检测
  if (!navigator.onLine) {
    throw new Error('网络已断开，请检查网络连接后重试');
  }

  const endpoint = getEndpoint();
  const apiKey = getApiKey();

  if (!apiKey && config.provider !== 'local' && config.provider !== 'custom') {
    throw new Error('请先配置 API Key');
  }
  if (!endpoint && config.provider === 'custom') {
    throw new Error('请配置自定义 API 地址');
  }

  const prompt = buildTranslationPrompt(text, sourceLang, targetLang, context);
  const { headers, body } = buildRequest(prompt, false);

  // AbortController 超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers, body,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(formatError(response.status, errorText));
    }

    const data = await response.json();
    const translated = parseResponse(data, getFormat());
    return translated.trim();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('请求超时（15秒），请检查网络或更换模型');
    }
    throw error;
  }
}

/**
 * 流式翻译请求（SSE）
 * 通过 chrome.tabs.sendMessage 逐字推送到 content script
 */
async function translateWithStream(text, sourceLang, targetLang, tabId, context = null) {
  if (!navigator.onLine) {
    throw new Error('网络已断开，请检查网络连接后重试');
  }

  const endpoint = getEndpoint();
  const apiKey = getApiKey();

  if (!apiKey && config.provider !== 'local' && config.provider !== 'custom') {
    throw new Error('请先配置 API Key');
  }

  const format = getFormat();
  const prompt = buildTranslationPrompt(text, sourceLang, targetLang, context);
  const { headers, body } = buildRequest(prompt, true);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2); // 流式给更多时间

  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers, body,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(formatError(response.status, errorText));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          let chunk = '';

          if (format === 'anthropic') {
            chunk = parsed.delta?.text || '';
          } else if (config.provider === 'local') {
            chunk = parsed.message?.content || '';
          } else {
            chunk = parsed.choices?.[0]?.delta?.content || '';
          }

          if (chunk) {
            fullText += chunk;
            // 推送增量文本到页面或 Popup
            if (tabId) {
              chrome.tabs.sendMessage(tabId, {
                action: 'streamChunk',
                chunk,
                fullText
              }).catch(() => { /* tab 可能已关闭 */ });
            } else {
              chrome.runtime.sendMessage({
                action: 'streamChunk',
                chunk,
                fullText
              }).catch(() => { /* popup 可能未打开 */ });
            }
          }
        } catch (e) {
          // 忽略不可解析的行
        }
      }
    }

    return fullText.trim();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('请求超时，请检查网络或更换模型');
    }
    throw error;
  }
}

// ===== 智能语言方向检测 =====

function resolveTargetLanguage(text, sourceLang, targetLang) {
  if (!config.autoDetectLang || sourceLang !== 'auto') {
    return targetLang;
  }

  // 简单的汉字检测
  const hasChinese = /[\u4e00-\u9fa5]/.test(text);
  
  if (targetLang.startsWith('zh') && hasChinese) {
    // 目标语言是中文，且文本里有中文，自动转给英文
    return 'en';
  } else if (targetLang === 'en' && !hasChinese) {
    // 目标语言是英文，且文本里没中文（大概率是外文），自动转中文
    return 'zh';
  }
  
  return targetLang;
}

// ===== 翻译入口 =====

async function translate(text, sourceLang = 'auto', targetLang = 'zh', context = null) {
  targetLang = resolveTargetLanguage(text, sourceLang, targetLang);
  
  const cacheKey = generateCacheKey(text, sourceLang, targetLang);

  const cached = getFromCache(cacheKey);
  if (cached) {
    recordUsage(true, 1);
    return { text: cached, cached: true, engine: 'cache' };
  }

  try {
    const translated = await translateWithCloud(text, sourceLang, targetLang, context);
    await setToCache(cacheKey, translated);
    recordUsage(false, 1);
    return { text: translated, cached: false, engine: config.provider };
  } catch (error) {
    console.error('[YuxTrans] 翻译错误:', error);
    throw error;
  }
}

/**
 * 批量翻译逻辑 (JSON 数组) + 降级处理
 */
async function translateBatchInternal(texts, sourceLang, targetLang, context = null) {
  const finalResults = new Array(texts.length);
  const missIndices = [];
  const missTexts = [];

  // 1. 筛出未命中的项
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const cacheKey = generateCacheKey(text, sourceLang, targetLang);
    const cached = getFromCache(cacheKey);
    if (cached) {
      finalResults[i] = { text: cached, cached: true, engine: 'cache', success: true };
      recordUsage(true, 1);
    } else {
      missIndices.push(i);
      missTexts.push(text);
    }
  }

  // 2. 如果全命中缓存，直接返回
  if (missIndices.length === 0) {
    return finalResults;
  }

  // 3. 构建大模型 Batch 请求
  const targetName = LANG_NAMES[targetLang] || targetLang;
  const sourceName = sourceLang === 'auto' ? null : (LANG_NAMES[sourceLang] || sourceLang);
  
  // 专门构造一个强制输出 JSON 的 Prompt
  let prompt = `You are a professional translator. Translate the following JSON array of strings`;
  if (sourceName) prompt += ` from ${sourceName}`;
  prompt += ` to ${targetName}.`;
  
  prompt += `\nRULES:
1. Return ONLY a valid JSON array of strings. Do not include markdown \`\`\`json wrappers.
2. The output array MUST have the exact same length (${missTexts.length}) and order as the input.
3. No explanations, no prefix or suffix.
4. Keep HTML tags intact.`;

  if (context && context.pageTitle) {
    prompt += `\nPage context: "${context.pageTitle}"`;
  }

  prompt += `\n\nInput:\n${JSON.stringify(missTexts)}`;

  // 4. 发送请求并解析
  let jsonParsed = false;
  let batchOutput = [];
  try {
    const { headers, body } = buildRequest(prompt, false);
    const endpoint = getEndpoint();
    const timeout = config.provider === 'local' ? LOCAL_TIMEOUT_MS : (CLOUD_TIMEOUT_MS * 2);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(endpoint, {
      method: 'POST', headers, body, signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data = await response.json();
      const rawOutput = parseResponse(data, getFormat()).trim();
      
      // 提取被 ```json 包裹的内容
      const match = rawOutput.match(/\[[\s\S]*\]/);
      if (match) {
        batchOutput = JSON.parse(match[0]);
        if (Array.isArray(batchOutput) && batchOutput.length === missTexts.length) {
          jsonParsed = true;
        }
      }
    }
  } catch (e) {
    console.warn('[YuxTrans] Batch translation strict mode failed:', e);
  }

  // 5. 将翻译结果写回 finalResults / 错误处理和自动按句降级降维兜底
  if (jsonParsed && batchOutput.length === missTexts.length) {
    batchOutput.forEach((text, i) => {
      const originalIndex = missIndices[i];
      finalResults[originalIndex] = { text, success: true, engine: config.provider, cached: false };
      setToCache(generateCacheKey(missTexts[i], sourceLang, targetLang), text);
    });
    recordUsage(false, batchOutput.length);
    return finalResults;
  } else {
    // 降级：如果 JSON 解析失败，则异步分片并发重试这些漏掉的
    console.warn(`[YuxTrans] 批处理响应不匹配 (预期 ${missTexts.length}, 实得 ${batchOutput.length})，正在降阶处理...`);
    const fallbackPromises = missIndices.map(async (i, j) => {
      try {
        const text = missTexts[j];
        const res = await translate(text, sourceLang, targetLang, context);
        finalResults[i] = { ...res, success: true };
      } catch (error) {
        finalResults[i] = { success: false, error: error.message };
      }
    });
    await Promise.allSettled(fallbackPromises);
  }

  return finalResults;
}

// ===== 连接测试 =====

async function testConnection(testConfig) {
  const { endpoint, apiKey, format, model } = testConfig;

  if (!endpoint) return { success: false, error: '请输入 API 地址' };

  const prompt = 'Translate to Chinese. Provide only the translation.\n\nHello';
  let requestBody;
  let headers = { 'Content-Type': 'application/json' };

  try {
    if (format === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      requestBody = { model, max_tokens: 100, messages: [{ role: 'user', content: prompt }] };
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      requestBody = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 };
    }

    const timeout = config.provider === 'local' ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: formatError(response.status, errorText) };
    }

    return { success: true };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { success: false, error: '连接超时，请检查地址是否正确' };
    }
    return { success: false, error: error.message };
  }
}

async function testProviderConnection(testConfig) {
  const { provider, apiKey, endpoint, model } = testConfig;

  if (!apiKey && provider !== 'local') return { success: false, error: '请先填写 API Key' };

  const prompt = 'Translate to Chinese. Provide only the translation.\n\nHello';

  try {
    let headers = { 'Content-Type': 'application/json' };
    let requestBody;

    if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      requestBody = { model: model || DEFAULT_MODELS[provider], max_tokens: 100, messages: [{ role: 'user', content: prompt }] };
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      requestBody = { model: model || DEFAULT_MODELS[provider], messages: [{ role: 'user', content: prompt }], temperature: 0.3 };
    }

    const timeout = provider === 'local' ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: formatError(response.status, errorText) };
    }
    return { success: true };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { success: false, error: '连接超时' };
    }
    return { success: false, error: error.message };
  }
}

async function fetchModels(testConfig) {
  const { provider, apiKey, endpoint } = testConfig;

  // 本地模型无需 API Key 校验
  if (!apiKey && provider !== 'local') return { success: false, error: '请先填写 API Key' };

  try {
    let modelsEndpoint;
    if (provider === 'local') {
      // Ollama 列表 API
      modelsEndpoint = 'http://localhost:11434/api/tags';
    } else {
      modelsEndpoint = endpoint.replace('/chat/completions', '/models');
    }

    const timeout = provider === 'local' ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(modelsEndpoint, {
      method: 'GET',
      headers: headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `获取失败: HTTP ${response.status}` };
    }

    const data = await response.json();

    // Ollama 结构解析
    if (provider === 'local' && data.models && Array.isArray(data.models)) {
      const models = data.models.map(m => m.name).sort();
      return { success: true, models };
    }

    // 标准 OpenAI 兼容结构解析
    if (data.data && Array.isArray(data.data)) {
      const models = data.data.map(m => m.id).filter(id => id && !id.includes(':')).sort();
      return { success: true, models };
    } else if (data.models && Array.isArray(data.models)) {
      const models = data.models.map(m => m.name || m.model);
      return { success: true, models };
    }

    return { success: false, error: '无法解析模型列表' };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { success: false, error: '获取超时' };
    }
    return { success: false, error: `获取失败: ${error.message}` };
  }
}

// ===== 热点词库预加载 =====

async function preloadBuiltinCache() {
  let loaded = 0;
  for (const [key, value] of Object.entries(BUILTIN_CACHE)) {
    if (!cache.has(key)) {
      cache.set(key, value);
      cacheOrder.push(key);
      loaded++;
    }
  }
  if (loaded > 0) {
    updateCacheStats();
    await saveCacheToDB();
    console.log(`[YuxTrans] 预加载 ${loaded} 个热点词汇`);
  }
}

// ===== 事件监听 =====

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await loadConfig();
    await loadUsageStats();
    initialized = true;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await loadUsageStats();
  initialized = true;

  // 预加载热点词库
  await preloadBuiltinCache();

  // 创建一级菜单
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
  
  // 创建多语言翻译子菜单
  chrome.contextMenus.create({
    id: 'translate-to-sub',
    title: '翻译选中内容至...',
    contexts: ['selection']
  });
  
  const langs = [
    { id: 'en', title: '英文' }, { id: 'zh', title: '中文' }, 
    { id: 'ja', title: '日文' }, { id: 'ko', title: '韩文' }
  ];
  
  langs.forEach(lang => {
    chrome.contextMenus.create({
      id: `translate-to-${lang.id}`,
      title: lang.title,
      parentId: 'translate-to-sub',
      contexts: ['selection']
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  Promise.all([loadConfig(), loadUsageStats()]).then(() => { initialized = true; });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate-selection') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'translateSelection',
      text: info.selectionText
    });
  } else if (info.menuItemId === 'translate-page') {
    chrome.tabs.sendMessage(tab.id, { action: 'translatePage' });
  } else if (info.menuItemId.startsWith('translate-to-')) {
    const targetLang = info.menuItemId.replace('translate-to-', '');
    chrome.tabs.sendMessage(tab.id, {
      action: 'translateSelection',
      text: info.selectionText,
      targetLang: targetLang
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  ensureInitialized().then(() => {
    const tabId = sender.tab?.id || null;

    if (request.action === 'translate') {
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      const targetLang = request.targetLang || config.targetLang || 'zh';
      const context = request.context || null;

      translate(request.text, sourceLang, targetLang, context)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'translateStream') {
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      let targetLang = request.targetLang || config.targetLang || 'zh';
      targetLang = resolveTargetLanguage(request.text, sourceLang, targetLang);
      
      const context = request.context || null;
      const cacheKey = generateCacheKey(request.text, sourceLang, targetLang);

      // 先查缓存
      const cached = getFromCache(cacheKey);
      if (cached) {
        recordUsage(true, 1);
        sendResponse({ success: true, text: cached, cached: true, engine: 'cache' });
        return;
      }

      translateWithStream(request.text, sourceLang, targetLang, tabId, context)
        .then(async (fullText) => {
          await setToCache(cacheKey, fullText);
          recordUsage(false, 1);
          sendResponse({ success: true, text: fullText, cached: false, engine: config.provider });
        })
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'translateBatch') {
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      // 预先决定每一项的最终目标语言对于批处理可能有些复杂，特别是如果有中英混杂的情况。
      // 但对于大多数整页，基调是一致的，我们以文本首项的语言检测为主
      let targetLang = request.targetLang || config.targetLang || 'zh';
      if (request.texts && request.texts.length > 0) {
        targetLang = resolveTargetLanguage(request.texts[0], sourceLang, targetLang);
      }
      
      const context = request.context || null;

      translateBatchInternal(request.texts, sourceLang, targetLang, context)
        .then(results => sendResponse({ success: true, results }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'getConfig') {
      sendResponse(config);
    }

    else if (request.action === 'setConfig') {
      saveConfig(request.config)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'testConnection') {
      testConnection(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'fetchModels') {
      fetchModels(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'testProviderConnection') {
      testProviderConnection(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'clearCache') {
      cache.clear();
      cacheOrder = [];
      cacheStats = { wordCount: 0, sizeBytes: 0 };
      pendingCacheSave = false;
      if (cacheSaveTimer) {
        clearTimeout(cacheSaveTimer);
        cacheSaveTimer = null;
      }
      openDatabase().then(database => {
        const transaction = database.transaction(CACHE_STORE, 'readwrite');
        transaction.objectStore(CACHE_STORE).clear();
        transaction.oncomplete = () => sendResponse({ success: true });
        transaction.onerror = () => sendResponse({ success: true });
      }).catch(() => sendResponse({ success: true }));
      return; // 已经在上面异步返回了
    }

    else if (request.action === 'getCacheStats') {
      updateCacheStats();
      sendResponse({
        success: true,
        stats: {
          wordCount: cacheStats.wordCount,
          sizeBytes: cacheStats.sizeBytes,
          sizeMB: Math.round(cacheStats.sizeBytes / 1024 / 1024 * 100) / 100,
          sizeGB: Math.round(cacheStats.sizeBytes / 1024 / 1024 / 1024 * 100) / 100
        },
        usage: usageStats
      });
    }
  });
  return true; // 保持消息通道打开
});

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    if (command === 'translate-selection') {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'translateSelection' });
    } else if (command === 'translate-page') {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'translatePage' });
    }
  });
});

// ===== 自动更新检测 =====
const GITHUB_REPO = 'Yaemikoreal/YuxTrans';
const CHECK_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 小时

async function checkNewVersion() {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!response.ok) return;

    const data = await response.json();
    const latestVersion = data.tag_name.replace(/^v/, '');
    const currentVersion = chrome.runtime.getManifest().version;

    if (isNewerVersion(latestVersion, currentVersion)) {
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#d85151' });
      chrome.storage.local.set({ 
        updateAvailable: {
          version: latestVersion,
          url: data.html_url,
          zipUrl: data.zipball_url,
          body: data.body
        }
      });
    } else {
      chrome.action.setBadgeText({ text: '' });
      chrome.storage.local.remove('updateAvailable');
    }
  } catch (error) {
    console.error('[YuxTrans] 检查更新失败:', error);
  }
}

function isNewerVersion(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (l[i] > (c[i] || 0)) return true;
    if (l[i] < (c[i] || 0)) return false;
  }
  return false;
}

// 启动时加载配置
ensureInitialized().then(() => {
  checkNewVersion(); // 启动后立即检查一次
  setInterval(checkNewVersion, CHECK_UPDATE_INTERVAL);
});