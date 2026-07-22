/**
 * Background Service Worker
 * 处理翻译请求、缓存管理、消息路由
 * 支持流式输出、上下文增强 Prompt、热点词库
 *
 * 优先支持：Chrome / Edge（Chromium 内核）
 */

// 加载可测纯函数与 SW 拆分模块（Service Worker: importScripts；Node 测试: require）
/* global importScripts, YuxTransHelpers, YuxTransSW */
(function loadSwModules() {
  const scripts = [
    'lib/product-helpers.js',
    'lib/sw/bootstrap.js',
    'lib/sw/constants.js',
    'lib/sw/cache-keys.js',
    'lib/sw/providers-core.js',
    'lib/sw/lang.js',
    'lib/sw/message-actions.js',
    'lib/sw/translate-core.js'
  ];
  if (typeof importScripts === 'function') {
    try {
      importScripts(...scripts);
    } catch (e) {
      console.warn('[YuxTrans] importScripts SW modules failed:', e);
    }
    return;
  }
  if (typeof require === 'function') {
    // Node 测试路径：按依赖顺序 require
    require('./lib/product-helpers.js');
    require('./lib/sw/bootstrap.js');
    require('./lib/sw/constants.js');
    require('./lib/sw/cache-keys.js');
    require('./lib/sw/providers-core.js');
    require('./lib/sw/lang.js');
    require('./lib/sw/message-actions.js');
    require('./lib/sw/translate-core.js');
  }
})();

const ProductHelpers = (typeof YuxTransHelpers !== 'undefined' ? YuxTransHelpers : null)
  || (typeof require === 'function' ? require('./lib/product-helpers.js') : null)
  || {};

const SW = (typeof YuxTransSW !== 'undefined' ? YuxTransSW : {}) || {};

// ===== 常量配置（来自 lib/sw/constants.js）=====

const API_ENDPOINTS = SW.API_ENDPOINTS || {};
const DEFAULT_MODELS = SW.DEFAULT_MODELS || {};
const STYLE_PROMPTS = SW.STYLE_PROMPTS || {};
const LANG_NAMES = SW.LANG_NAMES || Object.create(null);
const ERROR_MESSAGES = SW.ERROR_MESSAGES || {};
const CLOUD_TIMEOUT_MS = SW.CLOUD_TIMEOUT_MS || 30000;
const LOCAL_TIMEOUT_MS = SW.LOCAL_TIMEOUT_MS || 120000;
const REQUEST_TIMEOUT_MS = SW.REQUEST_TIMEOUT_MS || 30000;
const MAX_BATCH_CHARS = SW.MAX_BATCH_CHARS || 4000;
const DEFAULT_BATCH_SIZE = SW.DEFAULT_BATCH_SIZE || 20;
const CACHE_KEY_VERSION = SW.CACHE_KEY_VERSION || 'v2';

/**
 * 默认模型（providers 模块）
 * @param {string} provider
 * @returns {string}
 */
function getDefaultModel(provider) {
  return SW.getDefaultModel ? SW.getDefaultModel(provider) : '';
}

// 按 provider + model 返回批量参数 { maxBatchChars, batchSize }
function getBatchConfig(providerOverride = null) {
  const p = resolveProviderConfig(providerOverride);
  const provider = p.provider;
  const model = (getModel(p) || '').toLowerCase();

  if (provider === 'local') {
    const localModel = (p.localModel || '').toLowerCase();
    const isSmall = /:\s*(7b|8b|0\.5b|1b|1\.8b|3b|4b)/.test(localModel);
    return isSmall
      ? { maxBatchChars: 4000, batchSize: 20 }
      : { maxBatchChars: 6000, batchSize: 40 };
  }

  if (provider === 'deepseek' || model.includes('deepseek')) {
    if (model.includes('v4-flash')) {
      return { maxBatchChars: 16000, batchSize: 100 };
    }
    return { maxBatchChars: 10000, batchSize: 60 };
  }

  if (provider === 'qwen' || provider === 'openai' || provider === 'groq' ||
      provider === 'moonshot' || provider === 'siliconflow' || provider === 'anthropic') {
    return { maxBatchChars: 8000, batchSize: 50 };
  }

  return { maxBatchChars: 8000, batchSize: 50 };
}

// 速率限制配置
const RATE_LIMIT_CONFIG = {
  MIN_CONCURRENT: 1,        // 最小并发数
  MAX_CONCURRENT: 10,       // 最大并发数
  MIN_DELAY: 0,             // 最小延迟
  MAX_DELAY: 2000,          // 最大延迟（2秒）
  SUCCESS_TO_RECOVER: 5,    // 连续成功多少次后开始恢复
  ERROR_TO_LIMIT: 2,        // 连续错误多少次后开始限速
  RECOVERY_STEP: 2,         // 每次恢复增加的并发数
  LIMIT_STEP: 3,            // 每次限速减少的并发数
  RATE_LIMIT_COOLDOWN: 30000 // rate limit 后的冷却时间（30秒）
};

// ===== 自适应速率限制 =====
let rateLimitState = {
  concurrentLimit: 10,      // 当前并发限制
  requestDelay: 0,          // 当前请求延迟（ms）
  consecutiveSuccess: 0,    // 连续成功次数
  consecutiveErrors: 0,     // 连续错误次数
  lastRateLimitTime: 0,     // 上次遇到 rate limit 的时间
  isRateLimited: false      // 是否处于限速状态
};

const RATE_LIMIT_STATE_KEY = 'rateLimitState';

// ===== 最近请求日志（内存环形容器，用于前端诊断）=====
const MAX_REQUEST_LOGS = 50;
let requestLogs = [];

function logRequest(entry) {
  requestLogs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    ...entry
  });
  if (requestLogs.length > MAX_REQUEST_LOGS) {
    requestLogs = requestLogs.slice(0, MAX_REQUEST_LOGS);
  }
}

function getRequestLogs(limit = MAX_REQUEST_LOGS) {
  return requestLogs.slice(0, Math.max(1, Math.min(limit, MAX_REQUEST_LOGS)));
}

function truncateForLog(value, maxLen = 2000) {
  if (value === undefined || value === null) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `…(${str.length - maxLen} more chars)`;
}

/**
 * 从 storage 恢复速率限制状态（应对 Service Worker 休眠重启）
 */
async function loadRateLimitState() {
  try {
    const stored = await chrome.storage.local.get(RATE_LIMIT_STATE_KEY);
    if (stored[RATE_LIMIT_STATE_KEY]) {
      const saved = stored[RATE_LIMIT_STATE_KEY];
      // 只恢复关键的限速参数，计数器重置以避免过期状态误导
      rateLimitState.concurrentLimit = Math.max(
        RATE_LIMIT_CONFIG.MIN_CONCURRENT,
        Math.min(saved.concurrentLimit || 10, RATE_LIMIT_CONFIG.MAX_CONCURRENT)
      );
      rateLimitState.requestDelay = Math.max(
        RATE_LIMIT_CONFIG.MIN_DELAY,
        Math.min(saved.requestDelay || 0, RATE_LIMIT_CONFIG.MAX_DELAY)
      );
      rateLimitState.isRateLimited = saved.isRateLimited || false;
      rateLimitState.lastRateLimitTime = saved.lastRateLimitTime || 0;
      // 如果已冷却超过 30 秒，主动尝试恢复一点并发
      tryRecoverRateLimit(false);
    }
  } catch (e) {
    console.warn('[YuxTrans] 加载速率限制状态失败:', e);
  }
}

/**
 * 持久化速率限制参数（不包含计数器，避免频繁写入）
 */
async function persistRateLimitState() {
  try {
    const toSave = {
      concurrentLimit: rateLimitState.concurrentLimit,
      requestDelay: rateLimitState.requestDelay,
      isRateLimited: rateLimitState.isRateLimited,
      lastRateLimitTime: rateLimitState.lastRateLimitTime
    };
    await chrome.storage.local.set({ [RATE_LIMIT_STATE_KEY]: toSave });
  } catch (e) {
    console.warn('[YuxTrans] 保存速率限制状态失败:', e);
  }
}

/**
 * 尝试从限速状态中恢复。
 * 当 requireConsecutiveSuccess 为 true 时，需要满足连续成功次数门槛。
 * 返回是否执行了恢复操作。
 */
function tryRecoverRateLimit(requireConsecutiveSuccess = false) {
  if (!rateLimitState.isRateLimited) return false;
  if (Date.now() - rateLimitState.lastRateLimitTime <= RATE_LIMIT_CONFIG.RATE_LIMIT_COOLDOWN) return false;
  if (requireConsecutiveSuccess && rateLimitState.consecutiveSuccess < RATE_LIMIT_CONFIG.SUCCESS_TO_RECOVER) return false;

  rateLimitState.concurrentLimit = Math.min(
    rateLimitState.concurrentLimit + RATE_LIMIT_CONFIG.RECOVERY_STEP,
    RATE_LIMIT_CONFIG.MAX_CONCURRENT
  );
  rateLimitState.requestDelay = Math.max(
    rateLimitState.requestDelay - 200,
    RATE_LIMIT_CONFIG.MIN_DELAY
  );

  if (rateLimitState.concurrentLimit >= RATE_LIMIT_CONFIG.MAX_CONCURRENT &&
      rateLimitState.requestDelay <= RATE_LIMIT_CONFIG.MIN_DELAY) {
    rateLimitState.isRateLimited = false;
  }
  return true;
}

// 更新速率限制状态
function updateRateLimitState(success, isRateLimitError = false) {
  const before = {
    concurrentLimit: rateLimitState.concurrentLimit,
    requestDelay: rateLimitState.requestDelay,
    isRateLimited: rateLimitState.isRateLimited,
    lastRateLimitTime: rateLimitState.lastRateLimitTime
  };

  if (success) {
    rateLimitState.consecutiveSuccess++;
    rateLimitState.consecutiveErrors = 0;

    // 检查是否可以恢复
    if (tryRecoverRateLimit(true)) {
      console.log(`[YuxTrans] 速率恢复: 并发=${rateLimitState.concurrentLimit}, 延迟=${rateLimitState.requestDelay}ms`);
    }
  } else {
    rateLimitState.consecutiveErrors++;
    rateLimitState.consecutiveSuccess = 0;

    // 检测 rate limit (429) 或连续错误
    if (isRateLimitError || rateLimitState.consecutiveErrors >= RATE_LIMIT_CONFIG.ERROR_TO_LIMIT) {
      rateLimitState.isRateLimited = true;
      rateLimitState.lastRateLimitTime = Date.now();

      // 降低速率
      rateLimitState.concurrentLimit = Math.max(
        rateLimitState.concurrentLimit - RATE_LIMIT_CONFIG.LIMIT_STEP,
        RATE_LIMIT_CONFIG.MIN_CONCURRENT
      );
      rateLimitState.requestDelay = Math.min(
        rateLimitState.requestDelay + 500,
        RATE_LIMIT_CONFIG.MAX_DELAY
      );

      console.warn(`[YuxTrans] 速率限制触发: 并发=${rateLimitState.concurrentLimit}, 延迟=${rateLimitState.requestDelay}ms`);
    }
  }

  // 关键限速参数发生变化时持久化
  if (before.concurrentLimit !== rateLimitState.concurrentLimit ||
      before.requestDelay !== rateLimitState.requestDelay ||
      before.isRateLimited !== rateLimitState.isRateLimited ||
      before.lastRateLimitTime !== rateLimitState.lastRateLimitTime) {
    persistRateLimitState();
  }
}

// 获取当前速率限制参数
function getRateLimitParams() {
  return {
    maxConcurrent: rateLimitState.concurrentLimit,
    requestDelay: rateLimitState.requestDelay
  };
}

// 应用请求延迟
async function applyRateDelay() {
  if (rateLimitState.requestDelay > 0) {
    await new Promise(r => setTimeout(r, rateLimitState.requestDelay));
  }
}

// ===== 运行时状态 =====

let config = {
  // ProviderProfile 列表与当前激活档案
  profiles: [],
  activeProfileId: '',

  // 以下字段保留用于旧版兼容及自定义兜底，实际运行时优先取 active profile
  provider: 'qwen',
  apiKey: '',
  apiEndpoint: '',
  model: '',
  localModel: 'qwen3.5:0.8b',
  customProvider: {
    name: '', endpoint: '', apiKey: '', format: 'openai', model: ''
  },

  // ActiveConfig：与供应商无关的运行时偏好
  cacheEnabled: true,
  maxCacheMB: 200, // 物理空间限额提升至 200MB
  sourceLang: 'auto',
  targetLang: 'zh',
  translateStyle: 'normal',
  triggerMode: 'auto',
  autoCopy: false,
  showFloatBtn: true,
  bilingualMode: true,
  siteRule: 'all',
  siteList: [],
  autoDetectLang: true,
  autoFallback: true,
  enableStreaming: true,
  // 离线模式：仅允许 local + 缓存
  offlineMode: false,
  // 用户术语表 [{ source, target }]
  glossary: [],
  // 站点级偏好 { [hostname]: { bilingualMode: boolean } }
  siteModePrefs: {}
};

let cache = new Map();        // key -> value；Map 的插入顺序即 LRU 顺序（最旧在前）
let cacheBytes = 0;           // 当前缓存字节数（UTF-16 估算）
let cacheStats = { wordCount: 0, sizeBytes: 0 };
let pendingCacheWrites = new Set(); // 待写入 IndexedDB 的键
let pendingCacheDeletes = new Set(); // 待从 IndexedDB 删除的键
let db = null;

// 缓存落盘控制：减少 IndexedDB 事务频率，同时避免 Service Worker 终止前大量丢失
const CACHE_FLUSH_MAX_PENDING = 100; // 累计多少条待写入后强制 flush
const CACHE_FLUSH_DELAY_MS = 3000;   // 定时 flush 间隔
let flushTimer = null;               // 定时 flush 句柄

let usageStats = {
  totalCount: 0, cacheHits: 0, totalTokens: 0, sessionTokens: 0,
  blockedHits: 0, userReportedHits: 0, blockedByRule: {}
};
let usageStatsSaveTimer = null;

// 连接状态轻量缓存，避免 popup 每次打开都发起真实 API 探测
let connectionCache = { profileId: '', timestamp: 0, result: null };
const CONNECTION_CACHE_TTL = 15000;

async function loadUsageStats() {
  const stored = await chrome.storage.local.get('usageStats');
  if (stored.usageStats) usageStats = stored.usageStats;
  // 兼容旧格式：补全可能缺失的字段
  if (typeof usageStats.totalTokens !== 'number') usageStats.totalTokens = 0;
  if (typeof usageStats.blockedHits !== 'number') usageStats.blockedHits = 0;
  if (typeof usageStats.userReportedHits !== 'number') usageStats.userReportedHits = 0;
  if (!usageStats.blockedByRule || typeof usageStats.blockedByRule !== 'object') usageStats.blockedByRule = {};
  // 会话 token 数不持久化，每次启动/加载时重置
  usageStats.sessionTokens = 0;
}

function estimateTokens(text) {
  if (!text) return 0;
  // 轻量估算：英文约 1 token / 4 字符，中文约 1 token / 1.5 字符；取折中
  return Math.ceil(text.length / 3);
}

function saveUsageStatsDeferred() {
  if (usageStatsSaveTimer) clearTimeout(usageStatsSaveTimer);
  usageStatsSaveTimer = setTimeout(() => {
    const { sessionTokens, ...toSave } = usageStats;
    chrome.storage.local.set({ usageStats: toSave }).catch(() => {});
    usageStatsSaveTimer = null;
  }, 1000);
}

function recordUsage(isCacheHit, count = 1, tokens = 0) {
  usageStats.totalCount += count;
  usageStats.totalTokens += tokens;
  usageStats.sessionTokens = (usageStats.sessionTokens || 0) + tokens;
  if (isCacheHit) usageStats.cacheHits += count;
  saveUsageStatsDeferred();
}

function recordCacheValidation(rule) {
  usageStats.blockedHits = (usageStats.blockedHits || 0) + 1;
  if (!usageStats.blockedByRule) usageStats.blockedByRule = {};
  usageStats.blockedByRule[rule] = (usageStats.blockedByRule[rule] || 0) + 1;
  saveUsageStatsDeferred();
}

// ===== IndexedDB（带重连机制） =====

const DB_NAME = 'YuxTransDB';
const DB_VERSION = 3;
const CACHE_STORE = 'translations';
const MODELS_STORE = 'models';
const METRICS_STORE = 'metrics';

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
      // 其他上下文（如新的 Service Worker）请求更高版本时，关闭旧连接并重新打开
      db.onversionchange = (event) => {
        db.close();
        db = null;
        openDatabase().catch(() => {});
      };
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) {
        const store = database.createObjectStore(CACHE_STORE, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      // v2: 新增模型管理 objectStore
      if (!database.objectStoreNames.contains(MODELS_STORE)) {
        database.createObjectStore(MODELS_STORE, { keyPath: 'id' });
      }
      // v3: 新增性能指标 objectStore
      if (!database.objectStoreNames.contains(METRICS_STORE)) {
        const metricsStore = database.createObjectStore(METRICS_STORE, { keyPath: 'id', autoIncrement: true });
        metricsStore.createIndex('timestamp', 'timestamp', { unique: false });
        metricsStore.createIndex('success', 'success', { unique: false });
      }
    };
  });
}

/**
 * IndexedDB 操作失败时重置连接并重试一次
 * @param {Function} fn
 */
async function withDbRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (
      /InvalidStateError|database connection is closing|Connection is closing|IndexedDB/i.test(msg) ||
      e?.name === 'InvalidStateError'
    ) {
      db = null;
      await openDatabase();
      return await fn();
    }
    throw e;
  }
}

async function loadCacheFromDB() {
  try {
    await withDbRetry(async () => {
      const database = await openDatabase();
      await new Promise((resolve) => {
        const transaction = database.transaction(CACHE_STORE, 'readonly');
        const store = transaction.objectStore(CACHE_STORE);
        const request = store.getAll();

        request.onsuccess = () => {
          const items = request.result;
          cache.clear();
          cacheBytes = 0;
          pendingCacheWrites.clear();
          pendingCacheDeletes.clear();

          // 按时间戳从新到旧排序，使最近使用的项位于 Map 末尾
          items.sort((a, b) => b.timestamp - a.timestamp);
          let invalidCount = 0;
          for (const item of items) {
            const validation = validateCacheEntry(item.key, item.value);
            if (!validation.valid) {
              pendingCacheDeletes.add(item.key);
              invalidCount++;
              continue;
            }
            cache.set(item.key, item.value);
            cacheBytes += item.key.length * 2 + item.value.length * 2;
          }
          if (invalidCount > 0) {
            console.log(`[YuxTrans] 加载缓存时跳过 ${invalidCount} 条无效/旧版本记录`);
          }

          // 应用缓存字节限额限制 (LRU: 物理空间驱动)
          const maxBytes = (config.maxCacheMB || 200) * 1024 * 1024;
          while (cacheBytes > maxBytes && cache.size > 0) {
            const oldestKey = cache.keys().next().value;
            const oldestVal = cache.get(oldestKey);
            cache.delete(oldestKey);
            cacheBytes -= oldestKey.length * 2 + oldestVal.length * 2;
            pendingCacheDeletes.add(oldestKey);
          }

          updateCacheStats();
          // 若启动加载时裁剪了缓存，立即同步删除到 DB
          if (pendingCacheDeletes.size > 0) {
            saveCacheToDB();
          }
          resolve();
        };

        request.onerror = () => {
          console.error('[YuxTrans] 从 IndexedDB 加载缓存失败:', request.error);
          resolve();
        };
      });
    });
  } catch (error) {
    console.error('[YuxTrans] 打开 IndexedDB 失败:', error);
  }
}

// 批处理写入控制
let pendingCacheSave = false;
let cacheSaveTimer = null;
let isFlushingCache = false;

async function flushCacheToDB() {
  if (isFlushingCache) return;
  isFlushingCache = true;

  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const writes = new Set(pendingCacheWrites);
  const deletes = new Set(pendingCacheDeletes);
  pendingCacheWrites.clear();
  pendingCacheDeletes.clear();

  try {
    if (writes.size === 0 && deletes.size === 0) return;

    await withDbRetry(async () => {
      const database = await openDatabase();
      const transaction = database.transaction(CACHE_STORE, 'readwrite');
      const store = transaction.objectStore(CACHE_STORE);
      const timestamp = Date.now();

      // 1. 删除被淘汰的键
      for (const key of deletes) {
        store.delete(key);
      }

      // 2. 仅写入变更的键，避免全量重写
      for (const key of writes) {
        const value = cache.get(key);
        if (value !== undefined) {
          store.put({ key, value, timestamp });
        }
      }

      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    });
  } catch (error) {
    console.error('[YuxTrans] IndexedDB 写入失败:', error);
    // 出错时把变更重新放回待写入队列，下次再试
    for (const key of writes) pendingCacheWrites.add(key);
    for (const key of deletes) pendingCacheDeletes.add(key);
  } finally {
    isFlushingCache = false;
    pendingCacheSave = false;
  }
}

function saveCacheToDB() {
  if (pendingCacheSave || isFlushingCache) return;
  pendingCacheSave = true;

  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    flushCacheToDB().then(() => {
      cacheSaveTimer = null;
    });
  }, 500);
}

// ===== 模型管理 IndexedDB =====

/**
 * 从 IndexedDB 加载模型列表
 */
async function loadModelsFromDB() {
  try {
    const database = await openDatabase();
    return new Promise((resolve) => {
      const transaction = database.transaction(MODELS_STORE, 'readonly');
      const store = transaction.objectStore(MODELS_STORE);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => {
        console.error('[YuxTrans] 从 IndexedDB 加载模型列表失败:', request.error);
        resolve([]);
      };
    });
  } catch (error) {
    console.error('[YuxTrans] 打开 IndexedDB (models) 失败:', error);
    return [];
  }
}

/**
 * 保存模型列表到 IndexedDB
 */
async function saveModelsToDB(models) {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(MODELS_STORE, 'readwrite');
    const store = transaction.objectStore(MODELS_STORE);
    store.clear();
    models.forEach(m => store.put(m));
  } catch (error) {
    console.error('[YuxTrans] 保存模型列表到 IndexedDB 失败:', error);
  }
}

/**
 * 保存单条服务商配置到 IndexedDB
 */
async function saveProviderRecord(record) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MODELS_STORE, 'readwrite');
    const store = transaction.objectStore(MODELS_STORE);
    store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * 从 IndexedDB 读取所有服务商配置记录
 */
async function loadProviderRecords() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MODELS_STORE, 'readonly');
    const store = transaction.objectStore(MODELS_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 从 IndexedDB 移除指定服务商配置记录
 */
async function removeProviderRecord(recordId) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MODELS_STORE, 'readwrite');
    const store = transaction.objectStore(MODELS_STORE);
    store.delete(recordId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function updateCacheStats() {
  cacheStats = { wordCount: cache.size, sizeBytes: cacheBytes };
}

// ===== 缓存操作 =====

function getFromCache(key) {
  if (!config.cacheEnabled) return null;
  const value = cache.get(key);
  if (value === undefined) return null;

  // C: 热路径轻量化 —— 仅做版本号与非空检查，完整校验保留给写入时与后台清理
  const parsed = parseCacheKey(key);
  if (parsed.version !== CACHE_KEY_VERSION) {
    evictCacheEntry(key);
    return null;
  }
  if (!value || (typeof value === 'string' && !value.trim())) {
    evictCacheEntry(key);
    return null;
  }

  // LRU: 移到最近位置（Map 插入顺序）
  cache.delete(key);
  cache.set(key, value);
  return value;
}

async function setToCache(key, value) {
  if (!config.cacheEnabled) return;

  const validation = validateCacheEntry(key, value);
  if (!validation.valid) return;

  const entryBytes = key.length * 2 + value.length * 2;
  const maxBytes = (config.maxCacheMB || 200) * 1024 * 1024;

  // 若 key 已存在，先扣除旧字节并删除旧位置
  if (cache.has(key)) {
    const oldValue = cache.get(key);
    cacheBytes -= key.length * 2 + oldValue.length * 2;
    cache.delete(key);
  }

  // 存入新项
  cache.set(key, value);
  cacheBytes += entryBytes;
  pendingCacheWrites.add(key);
  pendingCacheDeletes.delete(key);

  // D: 改为批量 flush，减少 IndexedDB 事务频率
  scheduleCacheFlush();

  // 按 LRU 裁剪最旧的项
  while (cacheBytes > maxBytes && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    const oldestVal = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= oldestKey.length * 2 + oldestVal.length * 2;
    pendingCacheDeletes.add(oldestKey);
    pendingCacheWrites.delete(oldestKey);
  }

  updateCacheStats();
}

/**
 * 调度缓存落盘：优先聚合写入，减少 IndexedDB 事务竞争。
 * 阈值 100 条 / 3 秒，兼顾落盘及时性与 I/O 效率。
 */
function scheduleCacheFlush() {
  if (isFlushingCache) return;

  if (pendingCacheWrites.size >= CACHE_FLUSH_MAX_PENDING) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushCacheToDB();
    return;
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushCacheToDB();
    }, CACHE_FLUSH_DELAY_MS);
  }
}

/**
 * 归一化缓存键文本（cache 模块）
 * @param {string} text
 * @returns {string}
 */
function normalizeCacheKeyText(text) {
  return SW.normalizeCacheKeyText ? SW.normalizeCacheKeyText(text) : String(text || '').trim();
}

// ===== 缓存命中校验器 =====
// 目标：把明显不合理的缓存命中拦截在返回给用户之前，同时避免误伤正常翻译。

const REFUSAL_PATTERNS = [
  "I'm sorry", 'as an AI', 'cannot translate', "can't translate", 'unable to',
  'error', '429', 'rate limit', '<!DOCTYPE', '<html'
];

const PROPER_NOUN_WHITELIST = new Set([
  'github', 'google', 'openai', 'api', 'oauth', 'sdk', 'url', 'html', 'css', 'json',
  'javascript', 'python', 'java', 'react', 'vue', 'docker', 'kubernetes', 'sql', 'git',
  'npm', 'node', 'linux', 'windows', 'macos', 'ios', 'android', 'chatgpt', 'claude',
  'github actions', 'visual studio code', 'vs code'
]);

const MIN_CACHE_SOURCE_LENGTH = 12;   // 低于此长度的源文存在较大歧义，不缓存/不命中
const SHORT_SOURCE_THRESHOLD = 10;
const RULE3_SAMPLE_THRESHOLD = 200;
const RULE3_SAMPLE_SIZE = 100;
const RULE3_MIN_TARGET_SCRIPT_RATIO = 0.5;

const CJK_LANGS = new Set(['zh', 'ja', 'ko']);
const LATIN_LANGS = new Set(['en', 'vi', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl']);

/**
 * 解析缓存键（cache 模块）
 * @param {string} key
 * @returns {{version:string,sourceLang:string,targetLang:string,style:string,text:string}}
 */
function parseCacheKey(key) {
  return SW.parseCacheKey
    ? SW.parseCacheKey(key)
    : { version: '', sourceLang: 'auto', targetLang: 'zh', style: 'normal', text: '' };
}

/**
 * 缓存键文本段（cache 模块）
 * @param {string} key
 * @returns {string}
 */
function getCacheKeyTextPart(key) {
  return SW.getCacheKeyTextPart ? SW.getCacheKeyTextPart(key) : parseCacheKey(key).text;
}

function getLangFamily(lang) {
  if (CJK_LANGS.has(lang)) return 'cjk';
  if (LATIN_LANGS.has(lang)) return 'latin';
  return 'other';
}

function getRatioThreshold(sourceLang, targetLang) {
  const sourceFamily = getLangFamily(sourceLang);
  const targetFamily = getLangFamily(targetLang);
  if (sourceFamily === 'cjk' && targetFamily === 'latin') return 5;
  if (sourceFamily === 'latin' && targetFamily === 'cjk') return 2;
  if (sourceFamily === targetFamily) return 3;
  return 3;
}

function getTargetScriptRegex(targetLang) {
  switch (targetLang) {
    case 'zh': return SCRIPT_RANGES.han;
    case 'ja':
      return new RegExp(`${SCRIPT_RANGES.han.source.slice(1, -1)}${SCRIPT_RANGES.hiragana.source.slice(1, -1)}${SCRIPT_RANGES.katakana.source.slice(1, -1)}`, 'u');
    case 'ko': return SCRIPT_RANGES.hangul;
    case 'en':
    case 'vi':
      return SCRIPT_RANGES.latin;
    case 'ru': return SCRIPT_RANGES.cyrillic;
    case 'ar': return SCRIPT_RANGES.arabic;
    case 'th': return SCRIPT_RANGES.thai;
    default: return null;
  }
}

function getTargetScriptRatio(text, targetLang) {
  const regex = getTargetScriptRegex(targetLang);
  if (!regex) return 1;
  let meaningful = 0;
  let matched = 0;
  for (const char of text) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      meaningful++;
      if (regex.test(char)) matched++;
    }
  }
  return meaningful === 0 ? 1 : matched / meaningful;
}

function getSampleText(text, sampleSize) {
  if (text.length <= sampleSize * 3) return text;
  const half = Math.floor(text.length / 2);
  return (
    text.slice(0, sampleSize) +
    text.slice(half - Math.floor(sampleSize / 2), half + Math.ceil(sampleSize / 2)) +
    text.slice(-sampleSize)
  );
}

function isCjkToCjk(sourceLang, targetLang) {
  return CJK_LANGS.has(sourceLang) && CJK_LANGS.has(targetLang);
}

function isProperNoun(text) {
  const normalized = normalizeCacheKeyText(text).toLowerCase();
  if (PROPER_NOUN_WHITELIST.has(normalized)) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // 单个大写/首字母大写单词，如 OpenAI、TensorFlow
  if (words.length === 1) {
    const original = text.trim();
    return /^[A-Z][a-zA-Z0-9]*$/.test(original) || /^[A-Z0-9]+$/.test(original);
  }
  // 多词且每个单词首字母大写，视为专有名词
  return words.every((w, i) => /^[A-Z0-9]/.test(text.trim().split(/\s+/)[i] || ''));
}

function hasEntityDrift(source, target) {
  // URL / 域名 / 邮箱
  if (/https?:\/\/|www\.|[^\s]+@[^\s]+\.[^\s]+|\.(com|org|net|cn|io|dev|co)\b/i.test(target)) {
    return true;
  }
  // user/repo 路径模式
  if (/\b[^\s/]+\/[^\s/]+\b/.test(target)) return true;
  // 原文没有的 CamelCase / PascalCase 命名实体
  const sourceTokens = new Set(source.toLowerCase().split(/\W+/).filter(Boolean));
  const targetTokens = target.match(/[A-Z][a-z]+[A-Z][a-zA-Z0-9]+/g) || [];
  for (const token of targetTokens) {
    if (!sourceTokens.has(token.toLowerCase())) return true;
  }
  return false;
}

function validateCacheEntry(key, value) {
  const parsed = parseCacheKey(key);
  // 版本不匹配：旧版缓存键直接视为无效
  if (parsed.version !== CACHE_KEY_VERSION) {
    return { valid: false, rule: 'version_mismatch' };
  }
  const sourceLang = parsed.sourceLang;
  const targetLang = parsed.targetLang;
  const normalizedSource = normalizeCacheKeyText(parsed.text);
  const normalizedValue = normalizeCacheKeyText(value);

  // 严格准入：过短源文语义歧义大，不进入缓存
  if (normalizedSource.length < MIN_CACHE_SOURCE_LENGTH) {
    return { valid: false, rule: 'too_short' };
  }

  // 规则 0：API 拒绝 / 错误 / 非翻译内容
  const lowerValue = normalizedValue.toLowerCase();
  for (const pattern of REFUSAL_PATTERNS) {
    if (lowerValue.includes(pattern.toLowerCase())) {
      return { valid: false, rule: 'refusal' };
    }
  }

  const actualSourceLang = detectLanguage(normalizedSource) || sourceLang;

  // 规则 1：短源文长度/比例（语言对敏感）
  if (normalizedSource.length > 0 && normalizedSource.length <= SHORT_SOURCE_THRESHOLD) {
    const ratio = normalizedValue.length / normalizedSource.length;
    const threshold = getRatioThreshold(actualSourceLang, targetLang);
    if (ratio > threshold) {
      return { valid: false, rule: 'length_ratio' };
    }
  }

  // 规则 2：跨语种回显原文
  if (actualSourceLang !== targetLang &&
      normalizedSource === normalizedValue &&
      !isProperNoun(normalizedSource)) {
    return { valid: false, rule: 'echo' };
  }

  // 规则 3：目标语合法性
  if (isCjkToCjk(actualSourceLang, targetLang)) {
    if (/[a-zA-Z]/.test(normalizedValue)) {
      return { valid: false, rule: 'cjk_latin_drift' };
    }
  } else {
    const sample = normalizedValue.length > RULE3_SAMPLE_THRESHOLD
      ? getSampleText(normalizedValue, RULE3_SAMPLE_SIZE)
      : normalizedValue;
    if (getTargetScriptRatio(sample, targetLang) < RULE3_MIN_TARGET_SCRIPT_RATIO) {
      return { valid: false, rule: 'target_script' };
    }
    if (actualSourceLang !== targetLang) {
      const detectedValueLang = detectLanguage(sample);
      if (detectedValueLang === actualSourceLang && detectedValueLang !== 'unknown') {
        return { valid: false, rule: 'source_language_echo' };
      }
    }
  }

  // 规则 4：短源文实体漂移
  if (normalizedSource.length <= SHORT_SOURCE_THRESHOLD && hasEntityDrift(normalizedSource, normalizedValue)) {
    return { valid: false, rule: 'entity_drift' };
  }

  return { valid: true, rule: null };
}

function evictCacheEntry(key) {
  if (!cache.has(key)) return;
  const value = cache.get(key);
  cacheBytes -= key.length * 2 + value.length * 2;
  cache.delete(key);
  pendingCacheDeletes.add(key);
  pendingCacheWrites.delete(key);
  updateCacheStats();
}

async function cleanupInvalidCacheEntries() {
  if (!config.cacheEnabled) return;
  const invalidKeys = [];
  for (const [key, value] of cache.entries()) {
    const result = validateCacheEntry(key, value);
    if (!result.valid) invalidKeys.push(key);
  }
  if (invalidKeys.length === 0) return;
  for (const key of invalidKeys) {
    evictCacheEntry(key);
  }
  await flushCacheToDB();
  console.log(`[YuxTrans] 启动清理：移除 ${invalidKeys.length} 条无效缓存`);
}

/**
 * 生成缓存键（cache 模块；style 默认读全局配置）
 * @param {string} text
 * @param {string} sourceLang
 * @param {string} targetLang
 * @param {string|null} [style]
 * @returns {string}
 */
function generateCacheKey(text, sourceLang, targetLang, style = null) {
  const resolvedStyle = style || config.translateStyle || 'normal';
  return SW.generateCacheKey
    ? SW.generateCacheKey(text, sourceLang, targetLang, resolvedStyle)
    : `${CACHE_KEY_VERSION}:${sourceLang}:${targetLang}:${resolvedStyle}:${normalizeCacheKeyText(text)}`;
}

// ===== 性能指标（轻量本地埋点）=====

const METRICS_RETENTION_DAYS = 7;
const METRICS_MAX_SUCCESS = 1000;
const METRICS_MAX_FAILURE = 200;

function generateMetricId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function classifyError(error) {
  if (!error) return 'unknown';
  const msg = (error.message || String(error)).toLowerCase();
  if (msg.includes('timeout') || msg.includes('abort') || msg.includes('超时')) return 'timeout';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('过于频繁')) return 'rate_limit';
  if (msg.includes('401') || msg.includes('api key') || msg.includes('请先配置')) return 'auth';
  if (msg.includes('network') || msg.includes('断开') || msg.includes('failed to fetch')) return 'network';
  if (msg.includes('json') || msg.includes('parse') || msg.includes('解析')) return 'parse';
  return 'api';
}

async function recordMetric(metric) {
  try {
    const database = await openDatabase();
    if (!database.objectStoreNames.contains(METRICS_STORE)) return;

    const transaction = database.transaction(METRICS_STORE, 'readwrite');
    const store = transaction.objectStore(METRICS_STORE);
    const request = store.put({
      id: generateMetricId(),
      timestamp: Date.now(),
      ...metric
    });

    await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (e) {
    // 埋点失败不应影响主流程
  }
}

async function cleanupMetrics() {
  try {
    const database = await openDatabase();
    if (!database.objectStoreNames.contains(METRICS_STORE)) return;

    const transaction = database.transaction(METRICS_STORE, 'readwrite');
    const store = transaction.objectStore(METRICS_STORE);
    const index = store.index('timestamp');
    const cutoff = Date.now() - METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const counts = { success: 0, failure: 0 };

    // 从新到旧遍历，保留 newest N 条，删除超期/超量的旧数据
    const request = index.openCursor(null, 'prev');
    await new Promise((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        const value = cursor.value;
        const isSuccess = value.success === true;
        const key = isSuccess ? 'success' : 'failure';
        counts[key]++;
        const tooOld = value.timestamp < cutoff;
        const tooMany = counts[key] > (isSuccess ? METRICS_MAX_SUCCESS : METRICS_MAX_FAILURE);
        if (tooOld || tooMany) {
          cursor.delete();
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    // 清理失败不应影响主流程
  }
}

async function getMetrics(limit = 1000, days = METRICS_RETENTION_DAYS) {
  try {
    const database = await openDatabase();
    if (!database.objectStoreNames.contains(METRICS_STORE)) return [];

    const transaction = database.transaction(METRICS_STORE, 'readonly');
    const store = transaction.objectStore(METRICS_STORE);
    const index = store.index('timestamp');
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const range = IDBKeyRange.lowerBound(cutoff);
    const request = index.openCursor(range, 'prev');

    return await new Promise((resolve, reject) => {
      const metrics = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && metrics.length < limit) {
          metrics.push(cursor.value);
          cursor.continue();
        } else {
          resolve(metrics);
        }
      };
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (e) {
    return [];
  }
}

// ===== ProviderProfile / ActiveConfig 解析 =====

function getActiveProfile() {
  if (!config.profiles || !config.activeProfileId) return null;
  return config.profiles.find((p) => p.id === config.activeProfileId) || null;
}

/**
 * 解析实际使用的供应商配置：
 * 1. 若显式传入 providerOverride，优先使用；
 * 2. 否则使用 active profile；
 * 3. 最后回退到 config 顶层字段（旧版兼容）。
 */
function resolveProviderConfig(providerOverride = null) {
  if (providerOverride) return providerOverride;

  const profile = getActiveProfile();
  if (profile) {
    return {
      provider: profile.provider,
      apiKey: profile.apiKey,
      apiEndpoint: profile.apiEndpoint,
      model: profile.model,
      localModel: profile.localModel,
      customProvider: profile.customProvider || {
        name: '', endpoint: '', apiKey: '', format: 'openai', model: ''
      }
    };
  }

  return config;
}

/**
 * 档案 ID（providers 模块）
 * @param {string} provider
 * @param {string} model
 * @param {string} localModel
 * @returns {string}
 */
function makeProfileId(provider, model, localModel) {
  return SW.makeProfileId
    ? SW.makeProfileId(provider, model, localModel)
    : `${provider}:${model || localModel || 'default'}`;
}

function addOrUpdateProfile(profile) {
  if (!profile.id) {
    profile.id = makeProfileId(profile.provider, profile.model, profile.localModel);
  }
  const idx = config.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    config.profiles[idx] = { ...config.profiles[idx], ...profile, savedAt: Date.now() };
  } else {
    config.profiles.push({ ...profile, savedAt: Date.now() });
  }
  config.activeProfileId = profile.id;
  return profile.id;
}

function removeProfile(profileId) {
  config.profiles = config.profiles.filter((p) => p.id !== profileId);
  if (config.activeProfileId === profileId) {
    config.activeProfileId = config.profiles.length > 0 ? config.profiles[0].id : '';
  }
}

// ===== 配置管理 =====

async function loadConfig() {
  // 配置（含 API Key）存储在 local，避免跨设备同步导致密钥泄露
  let stored = await chrome.storage.local.get('config');

  // 一次性迁移：旧版使用 chrome.storage.sync，迁移后删除同步区配置
  if (!stored.config) {
    const syncStored = await chrome.storage.sync.get('config');
    if (syncStored.config) {
      stored = syncStored;
      // 迁移完成后清空同步区敏感配置
      chrome.storage.sync.remove('config').catch(() => {});
    }
  }

  if (stored.config) {
    config = { ...config, ...stored.config };
  }

  // 迁移：旧版 config 将供应商字段直接存在顶层 → 新版 profiles + activeProfileId
  if ((!config.profiles || config.profiles.length === 0) && config.provider) {
    const legacyProfile = {
      id: makeProfileId(config.provider, config.model, config.localModel),
      provider: config.provider,
      apiKey: config.apiKey || '',
      apiEndpoint: config.apiEndpoint || '',
      model: config.model || '',
      localModel: config.localModel || '',
      customProvider: config.customProvider || {
        name: '', endpoint: '', apiKey: '', format: 'openai', model: ''
      },
      savedAt: Date.now()
    };
    config.profiles = [legacyProfile];
    config.activeProfileId = legacyProfile.id;
  }

  // 迁移：旧版 activeModels 格式 → 新版 IndexedDB models 表
  if (config.activeModels && config.activeModels.length > 0) {
    const dbRecords = await loadProviderRecords();
    if (dbRecords.length === 0) {
      // 将旧格式转为新的完整记录格式（旧记录不含 apiKey 等，仅迁移基本信息）
      const migrated = config.activeModels.map(m => ({
        id: m.id || `${m.provider}:${m.model || ''}`,
        provider: m.provider,
        label: m.label || `${m.provider} - ${m.id}`,
        model: m.id,
        localModel: m.provider === 'local' ? m.id : '',
        apiKey: '',
        apiEndpoint: '',
        customProvider: { name: '', endpoint: '', apiKey: '', format: 'openai', model: '' },
        savedAt: Date.now()
      }));
      for (const record of migrated) {
        await saveProviderRecord(record);
      }
    }
    // 清除旧字段
    delete config.activeModels;
    await saveConfig(config);
  }
  await loadCacheFromDB();
}

async function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  await chrome.storage.local.set({ config });
}

// ===== Prompt 构建（上下文增强）=====

/**
 * 构建翻译 Prompt（translate 模块）
 * @param {string} text
 * @param {string} sourceLang
 * @param {string} targetLang
 * @param {object|null} context
 * @returns {string}
 */
function buildTranslationPrompt(text, sourceLang, targetLang, context) {
  if (SW.buildTranslationPrompt) {
    return SW.buildTranslationPrompt(
      text,
      sourceLang,
      targetLang,
      config.translateStyle || 'normal',
      context
    );
  }
  return `Translate to ${targetLang}:\n${text}`;
}

// ===== 翻译核心 =====

function getEndpoint(providerOverride = null) {
  const p = resolveProviderConfig(providerOverride);
  const isCustom = p.provider === 'custom';
  let ep = isCustom
    ? p.customProvider.endpoint
    : (p.apiEndpoint || API_ENDPOINTS[p.provider]);

  // 自动补全路径：若用户只填了基础 URL，追加 /chat/completions
  if (ep && p.provider !== 'anthropic' && p.provider !== 'local' &&
      !ep.endsWith('/chat/completions') && !ep.endsWith('/v1/messages')) {
    ep = ep.replace(/\/+$/, '') + '/chat/completions';
  }
  return ep;
}

function getApiKey(providerOverride = null) {
  const p = resolveProviderConfig(providerOverride);
  const isCustom = p.provider === 'custom';
  return isCustom
    ? p.customProvider.apiKey
    : (p.provider === 'local' ? '' : p.apiKey);
}

function getModel(providerOverride = null) {
  const p = resolveProviderConfig(providerOverride);
  const isCustom = p.provider === 'custom';
  if (isCustom) {
    return p.customProvider?.model || p.model || getDefaultModel(p.provider) || 'gpt-3.5-turbo';
  }
  if (p.provider === 'local') {
    return p.localModel || '';
  }
  // 优先使用用户配置，其次使用供应商默认，最后使用通用兜底（gpt-3.5-turbo 被几乎所有 OpenAI 兼容端点识别）
  return p.model || getDefaultModel(p.provider) || 'gpt-3.5-turbo';
}

function getFormat(providerOverride = null) {
  const p = resolveProviderConfig(providerOverride);
  return p.provider === 'custom' ? p.customProvider.format : p.provider;
}

/**
 * 判断供应商是否支持 OpenAI 风格的 json_object 输出格式
 */
/**
 * 是否支持 JSON mode（providers 模块）
 * @param {string} provider
 * @returns {boolean}
 */
function supportsJsonMode(provider) {
  return SW.supportsJsonMode
    ? SW.supportsJsonMode(provider)
    : ['openai', 'qwen', 'deepseek', 'groq', 'moonshot', 'siliconflow'].includes(provider);
}

/**
 * 构建 API 请求参数
 */
function buildRequest(prompt, stream = false, providerOverride = null, jsonMode = false) {
  const p = resolveProviderConfig(providerOverride);
  const format = getFormat(p);
  const model = getModel(p);
  const apiKey = getApiKey(p);
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
  } else if (p.provider === 'local') {
    body = {
      model,
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
    if (jsonMode && !stream && supportsJsonMode(p.provider)) {
      body.response_format = { type: 'json_object' };
    }
  }

  return { headers, body: JSON.stringify(body) };
}

/**
 * 解析非流式 API 响应
 */
function parseResponse(data, format, providerOverride = null) {
  const p = resolveProviderConfig(providerOverride);
  if (format === 'anthropic') {
    return data.content?.[0]?.text || '';
  } else if (p.provider === 'local') {
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
 * 解析友好错误信息（HTTP 状态映射）
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
 * 将任意错误转为结构化用户错误
 * @param {unknown} error
 * @param {object} [opts]
 * @returns {{ code: string, userMessage: string, actionHint: string, debugMessage: string }}
 */
function toUserError(error, opts = {}) {
  const provider = opts.provider || resolveProviderConfig()?.provider || '';
  if (ProductHelpers.buildUserError) {
    if (typeof error === 'number') {
      return ProductHelpers.buildUserError(error, {
        provider,
        debugMessage: opts.debugMessage || formatError(error, opts.debugMessage || '')
      });
    }
    const msg = error?.message || error?.error || String(error || '');
    // 已映射的 HTTP 友好句优先
    return ProductHelpers.buildUserError(
      { message: msg, status: error?.status, code: error?.code },
      { provider }
    );
  }
  const message = error?.message || String(error || '翻译失败');
  return {
    code: 'UNKNOWN',
    userMessage: message,
    actionHint: '请稍后重试，或打开设置检查服务配置',
    debugMessage: message
  };
}

/**
 * 术语表命中则直接返回译文
 * @param {string} text
 * @returns {string|null}
 */
function lookupGlossary(text) {
  if (!ProductHelpers.applyGlossary) return null;
  const result = ProductHelpers.applyGlossary(text, config.glossary || []);
  return result.hit ? result.text : null;
}

/**
 * 离线门禁检查
 * @param {boolean} cached
 * @param {object|null} providerOverride
 */
function assertOfflineAllowed(cached, providerOverride = null) {
  const provider = resolveProviderConfig(providerOverride).provider;
  const gate = ProductHelpers.checkOfflineGate
    ? ProductHelpers.checkOfflineGate({
        offlineMode: !!config.offlineMode,
        provider,
        cached: !!cached
      })
    : { allowed: true };
  if (!gate.allowed) {
    const err = new Error(gate.reason || '离线模式不允许云端请求');
    err.code = 'OFFLINE';
    throw err;
  }
}

/**
 * 报告差译并剔除缓存
 * @param {object} payload
 * @returns {Promise<{success:boolean, removed:boolean, key?:string}>}
 */
async function reportBadTranslation(payload = {}) {
  const text = payload.text || '';
  const sourceLang = payload.sourceLang || config.sourceLang || 'auto';
  const targetLang = payload.targetLang || config.targetLang || 'zh';
  const style = payload.style || config.translateStyle || 'normal';
  const key = payload.cacheKey || generateCacheKey(text, sourceLang, targetLang, style);

  let removed = false;
  if (key && cache.has(key)) {
    evictCacheEntry(key);
    removed = true;
  }
  // 兼容：按原文扫描可能的键
  if (!removed && text) {
    for (const [k] of cache.entries()) {
      if (k.endsWith(':' + normalizeCacheKeyText(text)) || k.includes(':' + normalizeCacheKeyText(text))) {
        const parsed = parseCacheKey(k);
        if (normalizeCacheKeyText(parsed.text) === normalizeCacheKeyText(text)) {
          evictCacheEntry(k);
          removed = true;
          break;
        }
      }
    }
  }

  if (removed) {
    usageStats.userReportedHits = (usageStats.userReportedHits || 0) + 1;
    saveUsageStatsDeferred();
    await flushCacheToDB();
  }
  return { success: true, removed, key };
}

/**
 * 将当前站点加入黑名单并切换为黑名单模式（若当前为全站启用）
 * @param {string} hostname
 */
async function disableSiteForHostname(hostname) {
  const host = (hostname || '').toLowerCase().trim();
  if (!host) throw new Error('缺少站点域名');
  const list = ProductHelpers.addHostnameToList
    ? ProductHelpers.addHostnameToList(config.siteList || [], host)
    : [...(config.siteList || []), host];
  const next = {
    siteList: list,
    siteRule: config.siteRule === 'whitelist' ? 'whitelist' : 'blacklist'
  };
  // 白名单模式下：从白名单移除
  if (config.siteRule === 'whitelist') {
    next.siteList = ProductHelpers.removeHostnameFromList
      ? ProductHelpers.removeHostnameFromList(config.siteList || [], host)
      : (config.siteList || []).filter((x) => x !== host);
  }
  await saveConfig(next);
  return { success: true, siteRule: config.siteRule, siteList: config.siteList };
}

/**
 * 非流式翻译请求
 * @param {string} text - 待翻译文本
 * @param {string} sourceLang - 源语言
 * @param {string} targetLang - 目标语言
 * @param {object|null} context - 页面上下文
 * @param {object|null} providerOverride - 可选：指定使用的供应商配置，默认使用全局 config
 */
async function translateWithCloud(text, sourceLang = 'auto', targetLang = 'zh', context = null, providerOverride = null) {
  const p = resolveProviderConfig(providerOverride);
  // 本地 Ollama 不依赖公网；浏览器 offline 时仍应允许 localhost
  const blockOffline = ProductHelpers.shouldBlockWhenBrowserOffline
    ? ProductHelpers.shouldBlockWhenBrowserOffline(navigator.onLine, p.provider)
    : (!navigator.onLine && p.provider !== 'local');
  if (blockOffline) {
    throw new Error('网络已断开，请检查网络连接后重试');
  }

  const endpoint = getEndpoint(p);
  const apiKey = getApiKey(p);

  if (!apiKey && p.provider !== 'local' && p.provider !== 'custom') {
    throw new Error('请先配置 API Key');
  }
  if (!endpoint && p.provider === 'custom') {
    throw new Error('请配置自定义 API 地址');
  }

  // 应用速率延迟
  await applyRateDelay();

  const prompt = buildTranslationPrompt(text, sourceLang, targetLang, context);
  const { headers, body } = buildRequest(prompt, false, p);
  const logStart = performance.now();

  // AbortController 超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers, body,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 检测 rate limit (429)
    if (!response.ok) {
      const isRateLimit = response.status === 429;
      updateRateLimitState(false, isRateLimit);
      const errorText = await response.text();
      throw new Error(
        isRateLimit
          ? ERROR_MESSAGES.RATE_LIMITED
          : formatError(response.status, errorText)
      );
    }

    const data = await response.json();
    const translated = parseResponse(data, getFormat(p), p);

    // 成功，更新状态
    updateRateLimitState(true);

    logRequest({
      action: 'translate',
      provider: p.provider,
      model: getModel(p),
      sourceLang,
      targetLang,
      prompt: truncateForLog(prompt),
      response: truncateForLog(translated),
      latencyMs: Math.round(performance.now() - logStart),
      success: true
    });

    return translated.trim();
  } catch (error) {
    clearTimeout(timeoutId);
    const finalError = error.name === 'AbortError'
      ? new Error('请求超时（30秒），请检查网络或更换模型')
      : error;
    logRequest({
      action: 'translate',
      provider: p.provider,
      model: getModel(p),
      sourceLang,
      targetLang,
      prompt: truncateForLog(prompt),
      error: truncateForLog(finalError.message),
      latencyMs: Math.round(performance.now() - logStart),
      success: false
    });
    throw finalError;
  }
}



/**
 * 流式翻译请求（SSE）
 * 通过 chrome.tabs.sendMessage 逐字推送到 content script
 */
async function translateWithStream(text, sourceLang, targetLang, tabId, context = null, providerOverride = null, requestId = null) {
  const p = resolveProviderConfig(providerOverride);
  // 本地 Ollama 不依赖公网；浏览器 offline 时仍应允许 localhost
  const blockOffline = ProductHelpers.shouldBlockWhenBrowserOffline
    ? ProductHelpers.shouldBlockWhenBrowserOffline(navigator.onLine, p.provider)
    : (!navigator.onLine && p.provider !== 'local');
  if (blockOffline) {
    throw new Error('网络已断开，请检查网络连接后重试');
  }

  const endpoint = getEndpoint(p);
  const apiKey = getApiKey(p);

  if (!apiKey && p.provider !== 'local' && p.provider !== 'custom') {
    throw new Error('请先配置 API Key');
  }

  // 应用速率延迟
  await applyRateDelay();

  const format = getFormat(p);
  const prompt = buildTranslationPrompt(text, sourceLang, targetLang, context);
  const { headers, body } = buildRequest(prompt, true, p);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2); // 流式给更多时间

  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers, body,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const isRateLimit = response.status === 429;
      updateRateLimitState(false, isRateLimit);
      const errorText = await response.text();
      throw new Error(
        isRateLimit
          ? ERROR_MESSAGES.RATE_LIMITED
          : formatError(response.status, errorText)
      );
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
          } else if (p.provider === 'local') {
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
                requestId,
                chunk,
                fullText
              }).catch(() => { /* tab 可能已关闭 */ });
            } else {
              chrome.runtime.sendMessage({
                action: 'streamChunk',
                requestId,
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

    // 流式翻译成功，更新速率限制状态
    updateRateLimitState(true);

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

/**
 * Unicode 脚本区间定义（用于轻量语言检测）
 */
const SCRIPT_RANGES = SW.SCRIPT_RANGES || {
  han: /[\u4e00-\u9fff\u3400-\u4dbf]/,
  hiragana: /[\u3040-\u309f]/,
  katakana: /[\u30a0-\u30ff]/,
  hangul: /[\uac00-\ud7af\u1100-\u11ff]/,
  cyrillic: /[\u0400-\u04ff]/,
  arabic: /[\u0600-\u06ff]/,
  thai: /[\u0e00-\u0e7f]/,
  latin: /[\u0041-\u007a\u00c0-\u017f\u0100-\u024f]/,
  vietnamese: /[\u00c0-\u00c3\u00c8-\u00ca\u00cc-\u00cf\u00d2-\u00d5\u00d9-\u00dd\u1ea0-\u1ef9]/
};

/**
 * 基于 Unicode 脚本检测语言（lang 模块）
 * @param {string} text
 * @returns {string}
 */
function detectLanguage(text) {
  return SW.detectLanguage ? SW.detectLanguage(text) : 'unknown';
}

/**
 * 根据检测到的源语言，决定实际目标语言
 * 核心规则：避免「同语种互译」，自动翻向常用对照语种
 * @param {string} text
 * @param {string} sourceLang
 * @param {string} targetLang
 * @returns {string}
 */
function resolveTargetLanguage(text, sourceLang, targetLang) {
  if (!config.autoDetectLang || sourceLang !== 'auto') {
    return targetLang;
  }
  const detected = detectLanguage(text);
  if (SW.flipTargetIfSameLanguage) {
    return SW.flipTargetIfSameLanguage(detected, targetLang);
  }
  return targetLang;
}

/**
 * 当 sourceLang 为 auto 时，返回检测到的源语言代码（lang 模块）
 * @param {string} text
 * @param {string} sourceLang
 * @returns {string}
 */
function resolveSourceLanguage(text, sourceLang) {
  return SW.resolveSourceLanguage
    ? SW.resolveSourceLanguage(text, sourceLang)
    : sourceLang;
}

// ===== 翻译入口 =====

/**
 * 判断某个供应商配置是否可用（本地只需 endpoint，云端需要 API Key）
 */
/**
 * 供应商是否可用（providers 模块）
 * @param {object} providerConfig
 * @returns {boolean}
 */
function isProviderAvailable(providerConfig) {
  return SW.isProviderAvailable
    ? SW.isProviderAvailable(providerConfig)
    : !!(providerConfig && (providerConfig.provider === 'local' || providerConfig.apiKey));
}

/**
 * 根据已保存的 apiEndpoint/apiKey 推断用户偏好的云端供应商
 */
function inferCloudProvider() {
  const active = resolveProviderConfig();
  const ep = active.apiEndpoint || '';
  if (ep.includes('deepseek')) return 'deepseek';
  if (ep.includes('openai')) return 'openai';
  if (ep.includes('anthropic')) return 'anthropic';
  if (ep.includes('groq')) return 'groq';
  if (ep.includes('moonshot')) return 'moonshot';
  if (ep.includes('siliconflow')) return 'siliconflow';
  if (ep.includes('dashscope') || ep.includes('aliyun')) return 'qwen';
  // 无法推断时，若 apiKey 存在则默认尝试 qwen（国内用户最常见）
  return active.apiKey ? 'qwen' : '';
}

/**
 * 构造故障转移用的供应商配置
 * 本地失败 → 使用用户配置的云端供应商；云端失败 → 尝试本地 Ollama
 */
function buildFallbackProvider() {
  const active = resolveProviderConfig();
  if (active.provider === 'local') {
    const fallbackProvider = inferCloudProvider();
    if (!fallbackProvider) return null;
    // 本地失败时回退到用户配置的云端（保留 apiKey/apiEndpoint/model）
    return {
      provider: fallbackProvider,
      apiKey: active.apiKey,
      apiEndpoint: active.apiEndpoint,
      model: active.model,
      customProvider: active.customProvider,
      localModel: active.localModel
    };
  }
  // 云端/自定义失败时回退到本地
  return {
    provider: 'local',
    apiKey: '',
    apiEndpoint: '',
    model: '',
    customProvider: { name: '', endpoint: '', apiKey: '', format: 'openai', model: '' },
    localModel: active.localModel
  };
}

async function translate(text, sourceLang = 'auto', targetLang = 'zh', context = null) {
  const start = performance.now();
  targetLang = resolveTargetLanguage(text, sourceLang, targetLang);
  const resolvedSourceLang = resolveSourceLanguage(text, sourceLang);

  // 术语表优先（强制固定译名）
  const glossaryHit = lookupGlossary(text);
  if (glossaryHit != null) {
    recordUsage(true, 1);
    recordMetric({
      action: 'translate',
      provider: 'glossary',
      cached: true,
      latencyMs: Math.round(performance.now() - start),
      textLength: text?.length || 0,
      tokens: 0,
      success: true,
      errorType: ''
    });
    return { text: glossaryHit, cached: true, engine: 'glossary' };
  }

  const cacheKey = generateCacheKey(text, sourceLang, targetLang);

  const cached = getFromCache(cacheKey);
  if (cached) {
    recordUsage(true, 1);
    recordMetric({
      action: 'translate',
      provider: 'cache',
      cached: true,
      latencyMs: Math.round(performance.now() - start),
      textLength: text?.length || 0,
      tokens: 0,
      success: true,
      errorType: ''
    });
    return { text: cached, cached: true, engine: 'cache' };
  }

  assertOfflineAllowed(false);

  const tokens = estimateTokens(text);
  const activeProvider = resolveProviderConfig().provider;
  try {
    const translated = await translateWithCloud(text, resolvedSourceLang, targetLang, context);
    await setToCache(cacheKey, translated);
    recordUsage(false, 1, tokens);
    recordMetric({
      action: 'translate',
      provider: activeProvider,
      cached: false,
      latencyMs: Math.round(performance.now() - start),
      textLength: text?.length || 0,
      tokens,
      success: true,
      errorType: ''
    });
    return { text: translated, cached: false, engine: activeProvider };
  } catch (error) {
    // 自动故障转移（离线模式下不允许落到云端）
    if (config.autoFallback && !config.offlineMode) {
      const fallback = buildFallbackProvider();
      if (fallback && isProviderAvailable(fallback) && fallback.provider !== activeProvider) {
        console.warn(`[YuxTrans] 主供应商 ${activeProvider} 失败，尝试 ${fallback.provider}:`, error.message);
        try {
          const translated = await translateWithCloud(text, resolvedSourceLang, targetLang, context, fallback);
          await setToCache(cacheKey, translated);
          recordUsage(false, 1, tokens);
          recordMetric({
            action: 'translate',
            provider: fallback.provider,
            cached: false,
            latencyMs: Math.round(performance.now() - start),
            textLength: text?.length || 0,
            tokens,
            success: true,
            errorType: ''
          });
          return { text: translated, cached: false, engine: fallback.provider };
        } catch (fallbackError) {
          console.error('[YuxTrans] 故障转移失败:', fallbackError);
        }
      }
    }
    console.error('[YuxTrans] 翻译错误:', error);
    recordMetric({
      action: 'translate',
      provider: activeProvider,
      cached: false,
      latencyMs: Math.round(performance.now() - start),
      textLength: text?.length || 0,
      tokens,
      success: false,
      errorType: classifyError(error)
    });
    throw error;
  }
}

/**
 * 按字符数上限将文本列表切分为多个子批次
 * 避免单批 prompt 过长导致模型输出截断或上下文溢出
 */
function splitIntoCharBatches(items, maxChars = MAX_BATCH_CHARS) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const item of items) {
    const textChars = item.text?.length || 0;
    // 单个文本超过上限时，独立成批（避免无限拆分，由模型自行处理）
    if (textChars > maxChars && current.length === 0) {
      batches.push([item]);
      continue;
    }
    if (currentChars + textChars > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += textChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * 构建批量翻译 Prompt
 * 统一封装风格、上下文、输出格式要求，便于测试与维护
 */
function buildBatchPrompt(groupTexts, groupSourceLang, groupTargetLang, context = null) {
  const targetName = LANG_NAMES[groupTargetLang] || groupTargetLang;
  const sourceName = groupSourceLang === 'auto' ? null : (LANG_NAMES[groupSourceLang] || groupSourceLang);
  const styleHint = STYLE_PROMPTS[config.translateStyle] || '';

  let prompt = `You are a professional translator. Translate the following JSON array of strings`;
  if (sourceName) prompt += ` from ${sourceName}`;
  prompt += ` to ${targetName}.`;

  if (styleHint) {
    prompt += `\nStyle: ${styleHint}`;
  }

  prompt += `\nSTRICT OUTPUT RULES:
1. Return ONLY a valid JSON array of strings. The array length MUST be exactly ${groupTexts.length} and the order MUST match the input exactly.
2. Translate each item independently. Do not summarize, infer, or reuse text from one item for another.
3. Do NOT include any markdown, code fences, explanations, notes, or page-level context.
4. If an item is already in the target language or contains only proper nouns/code/numbers, return it unchanged.
5. Keep HTML tags, placeholders, formatting and line breaks intact.
6. Violating any of these rules will cause the response to be rejected.`;

  prompt += `\n\nExample:\nInput: ["Hello", "GitHub"]\nOutput: ["你好", "GitHub"]`;

  // 批量翻译不注入任何页面上下文（pageTitle / domain），避免整页文本被模型偏向为标题/描述。
  prompt += `\n\nInput:\n${JSON.stringify(groupTexts)}`;
  return prompt;
}

/**
 * 批量翻译逻辑 (JSON 数组) + 降级处理
 * 额外在 batch 内做文本去重：相同原文只请求一次，结果映射回所有出现位置
 */
async function translateBatchInternal(texts, sourceLang, targetLang, context = null) {
  const batchStart = performance.now();
  const finalResults = new Array(texts.length);
  const missItems = [];

  // E: 语言检测去重 —— 以首条文本代表整批语言方向，避免对每句都调用 detectLanguage
  const batchSourceLang = sourceLang === 'auto'
    ? (resolveSourceLanguage(texts[0] || '', sourceLang))
    : sourceLang;

  // 若整批源语言与用户设置的目标语言相同（如中文页 target=zh），按原策略翻向对照语言
  let batchTargetLang = targetLang;
  if (sourceLang === 'auto' && batchSourceLang !== 'unknown' && batchSourceLang !== 'auto') {
    const normalizedTarget = targetLang.startsWith('zh') ? 'zh' : targetLang;
    if (batchSourceLang === normalizedTarget) {
      const oppositeMap = {
        zh: 'en', ja: 'zh', ko: 'zh', en: 'zh', ru: 'en', ar: 'en', th: 'en', vi: 'en'
      };
      batchTargetLang = oppositeMap[batchSourceLang] || 'en';
    }
  }

  // 1. 筛出未命中的项（术语表 → 缓存 → miss）
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    // E: 复用 batchSourceLang / batchTargetLang，避免对每句都调用 detectLanguage。
    // 假设同一批次内语言方向基本一致；混合语言页面中的少量异语言文本由模型 prompt
    // 规则兜底（"已为目标语则返回不变"）。
    const resolvedTargetLang = resolveTargetLanguage(text, batchSourceLang, batchTargetLang);
    const glossaryHit = lookupGlossary(text);
    if (glossaryHit != null) {
      finalResults[i] = { text: glossaryHit, cached: true, engine: 'glossary', success: true };
      recordUsage(true, 1);
      continue;
    }
    const cacheKey = generateCacheKey(text, sourceLang, resolvedTargetLang);
    const cached = getFromCache(cacheKey);
    if (cached) {
      finalResults[i] = { text: cached, cached: true, engine: 'cache', success: true };
      recordUsage(true, 1);
    } else {
      missItems.push({ text, resolvedTargetLang, resolvedSourceLang: batchSourceLang, tokens: estimateTokens(text), originalIndex: i });
    }
  }

  // 2. 如果全命中缓存/术语表，直接返回
  if (missItems.length === 0) {
    recordBatchMetric(batchStart, texts, finalResults);
    return finalResults;
  }

  // 离线模式下不允许对 miss 项发起云端批量请求
  assertOfflineAllowed(false);

  // 3. 按 (源语言, 目标语言) 分组，让 batch prompt 更精确
  const langGroups = new Map();
  missItems.forEach((item) => {
    const groupKey = `${item.resolvedSourceLang}:${item.resolvedTargetLang}`;
    const group = langGroups.get(groupKey) || [];
    group.push(item);
    langGroups.set(groupKey, group);
  });

  // B: 按当前 provider/model 动态获取 batch 上限
  const { maxBatchChars } = getBatchConfig();

  // 4. 为每个语言组按字符数切分子批次，再分别调用批处理
  for (const [groupKey, groupItems] of langGroups) {
    const [groupSourceLang, groupTargetLang] = groupKey.split(':');
    const subBatches = splitIntoCharBatches(groupItems, maxBatchChars);

    for (const batchItems of subBatches) {
      // 4.1 同一批次内去重：相同原文只发送一次
      const uniqueItems = [];
      const textToUniqueIndex = new Map();
      const uniqueToOriginals = [];

      batchItems.forEach((item) => {
        const existingIndex = textToUniqueIndex.get(item.text);
        if (existingIndex !== undefined) {
          uniqueToOriginals[existingIndex].push(item.originalIndex);
        } else {
          const idx = uniqueItems.length;
          textToUniqueIndex.set(item.text, idx);
          uniqueItems.push(item);
          uniqueToOriginals.push([item.originalIndex]);
        }
      });

      const groupTexts = uniqueItems.map((item) => item.text);
      const prompt = buildBatchPrompt(groupTexts, groupSourceLang, groupTargetLang, context);

      // 发送请求并解析（先应用速率延迟）
      let jsonParsed = false;
      let batchOutput = [];
      let parseError = null;
      const batchLogStart = performance.now();
      await applyRateDelay();
      try {
        const { headers, body } = buildRequest(prompt, false, null, true);
        const endpoint = getEndpoint();
        const timeout = resolveProviderConfig().provider === 'local' ? LOCAL_TIMEOUT_MS : (CLOUD_TIMEOUT_MS * 2);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(endpoint, {
          method: 'POST', headers, body, signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          const rawOutput = parseResponse(data, getFormat()).trim();

          try {
            batchOutput = JSON.parse(rawOutput);
          } catch (e1) {
            const jsonBlockMatch = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonBlockMatch) {
              batchOutput = JSON.parse(jsonBlockMatch[1]);
            } else {
              const arrayMatch = rawOutput.match(/\[[\s\S]*?\]/);
              if (arrayMatch) {
                batchOutput = JSON.parse(arrayMatch[0]);
              }
            }
          }

          if (Array.isArray(batchOutput) && batchOutput.length === groupTexts.length) {
            // Sanity check：如果模型把多段不同原文都译成了同一个结果（常见为页面标题），
            // 说明 prompt 上下文存在偏差，直接按解析失败处理并降级为单句补全。
            const distinctOutputs = new Set(
              batchOutput.map(t => typeof t === 'string' ? t.trim() : '').filter(Boolean)
            );
            if (uniqueItems.length > 2 && distinctOutputs.size <= 1) {
              jsonParsed = false;
              batchOutput = [];
              parseError = '模型返回了重复译文，疑似上下文偏差';
            } else {
              jsonParsed = true;
            }
          } else {
            parseError = `长度不匹配 (预期 ${groupTexts.length}, 实得 ${batchOutput.length})`;
          }
        } else {
          const isRateLimit = response.status === 429;
          updateRateLimitState(false, isRateLimit);
          parseError = `HTTP ${response.status}`;
        }
      } catch (e) {
        parseError = e.message;
        console.warn('[YuxTrans] Batch translation for group ' + groupTargetLang + ' parse error:', e);
      }

      logRequest({
        action: 'translateBatch',
        provider: resolveProviderConfig().provider,
        model: getModel(),
        sourceLang: groupSourceLang,
        targetLang: groupTargetLang,
        prompt: truncateForLog(prompt),
        inputSample: truncateForLog(groupTexts),
        outputSample: truncateForLog(batchOutput),
        parseError: parseError || undefined,
        latencyMs: Math.round(performance.now() - batchLogStart),
        success: jsonParsed
      });

      // 处理结果
      if (jsonParsed && batchOutput.length === groupTexts.length) {
        const invalidUniqueIndices = [];
        batchOutput.forEach((translatedText, i) => {
          const uniqueItem = uniqueItems[i];
          const originalIndices = uniqueToOriginals[i];

          if (translatedText && typeof translatedText === 'string' && translatedText.trim()) {
            const trimmed = translatedText.trim();
            originalIndices.forEach((originalIndex) => {
              finalResults[originalIndex] = { text: trimmed, success: true, engine: resolveProviderConfig().provider, cached: false };
            });
            setToCache(generateCacheKey(uniqueItem.text, sourceLang, uniqueItem.resolvedTargetLang), trimmed);
          } else {
            invalidUniqueIndices.push(i);
          }
        });

        const validOriginalCount = uniqueItems
          .filter((_, i) => !invalidUniqueIndices.includes(i))
          .reduce((sum, item, i) => sum + uniqueToOriginals[i].length, 0);
        const validTokens = uniqueItems
          .filter((_, i) => !invalidUniqueIndices.includes(i))
          .reduce((sum, item) => sum + (item.tokens || 0), 0);
        recordUsage(false, validOriginalCount, validTokens);

        updateRateLimitState(true);

        if (invalidUniqueIndices.length > 0) {
          console.warn(`[YuxTrans] 批处理有 ${invalidUniqueIndices.length} 项无效结果，正在补全...`);
          const invalidItems = invalidUniqueIndices.map((i) => uniqueItems[i]);
          await fallbackBatchItems(invalidItems, sourceLang, context, finalResults);
        }
      } else {
        // 降级：利用已解析的部分结果 + 并发补全缺失项
        console.warn(`[YuxTrans] 批处理部分失败 (目标 ${groupTargetLang}, 预期 ${groupTexts.length}, 实得 ${batchOutput.length}, 原因: ${parseError || '未知'})`);

        const usedUniqueIndices = new Set();
        let usedOriginalCount = 0;
        let usedTokens = 0;
        if (Array.isArray(batchOutput) && batchOutput.length > 0) {
          batchOutput.forEach((translatedText, i) => {
            if (i < uniqueItems.length && translatedText && typeof translatedText === 'string' && translatedText.trim()) {
              const uniqueItem = uniqueItems[i];
              const originalIndices = uniqueToOriginals[i];
              const trimmed = translatedText.trim();
              originalIndices.forEach((originalIndex) => {
                finalResults[originalIndex] = { text: trimmed, success: true, engine: resolveProviderConfig().provider, cached: false };
              });
              setToCache(generateCacheKey(uniqueItem.text, sourceLang, uniqueItem.resolvedTargetLang), trimmed);
              usedUniqueIndices.add(i);
              usedOriginalCount += originalIndices.length;
              usedTokens += uniqueItem.tokens || 0;
            }
          });
          recordUsage(false, usedOriginalCount, usedTokens);
        }

        const needFallbackItems = uniqueItems.filter((_, i) => !usedUniqueIndices.has(i));
        if (needFallbackItems.length === 0) continue;

        console.log(`[YuxTrans] 需要补全 ${needFallbackItems.length} 项...`);
        await fallbackBatchItems(needFallbackItems, sourceLang, context, finalResults);
      }
    }
  }

  recordBatchMetric(batchStart, texts, finalResults);
  return finalResults;
}

function recordBatchMetric(start, texts, finalResults) {
  const latencyMs = Math.round(performance.now() - start);
  const successCount = finalResults.filter(r => r?.success).length;
  const failedCount = finalResults.length - successCount;
  const cacheHitCount = finalResults.filter(r => r?.cached).length;
  const allCached = texts.length > 0 && cacheHitCount === texts.length;
  recordMetric({
    action: 'translateBatch',
    provider: allCached ? 'cache' : resolveProviderConfig().provider,
    cached: allCached,
    latencyMs,
    textLength: texts.reduce((sum, t) => sum + (t?.length || 0), 0),
    tokens: texts.reduce((sum, t) => sum + estimateTokens(t), 0),
    success: failedCount === 0,
    errorType: failedCount > 0 ? 'partial_failure' : '',
    extra: { total: texts.length, success: successCount, failed: failedCount, cacheHits: cacheHitCount }
  });
}

/**
 * 批量翻译失败项的并发补全
 */
async function fallbackBatchItems(uniqueItems, sourceLang, context, finalResults) {
  const { maxConcurrent, requestDelay } = getRateLimitParams();
  const chunks = [];
  for (let i = 0; i < uniqueItems.length; i += maxConcurrent) {
    chunks.push(uniqueItems.slice(i, i + maxConcurrent));
  }

  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (uniqueItem) => {
      const originalIndices = [];
      // 在 fallback 中 uniqueItem 可能不携带 originalIndices，兼容兜底
      if (uniqueItem.originalIndices && uniqueItem.originalIndices.length > 0) {
        originalIndices.push(...uniqueItem.originalIndices);
      } else {
        originalIndices.push(uniqueItem.originalIndex);
      }
      let lastError = null;

      for (let retry = 0; retry < 3; retry++) {
        try {
          if (retry > 0) await new Promise((r) => setTimeout(r, retry * 1000 + requestDelay));
          const res = await translate(uniqueItem.text, sourceLang, uniqueItem.resolvedTargetLang, context);
          originalIndices.forEach((originalIndex) => {
            finalResults[originalIndex] = { ...res, success: true };
          });
          return true;
        } catch (error) {
          lastError = error;
          console.warn(`[YuxTrans] 单句翻译失败 (retry ${retry + 1}):`, error.message);
        }
      }

      originalIndices.forEach((originalIndex) => {
        finalResults[originalIndex] = { success: false, error: lastError?.message, originalText: uniqueItem.text };
      });
      return false;
    });

    await Promise.allSettled(chunkPromises);
    if (chunks.indexOf(chunk) < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, requestDelay !== undefined ? requestDelay : 500));
    }
  }
}

// ===== 连接测试 =====

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
      requestBody = { model: model || getDefaultModel(provider), max_tokens: 100, messages: [{ role: 'user', content: prompt }] };
    } else if (provider === 'local') {
      // Ollama 不需要认证头
      requestBody = { model: model || getDefaultModel(provider), messages: [{ role: 'user', content: prompt }], stream: false };
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
      requestBody = { model: model || getDefaultModel(provider), messages: [{ role: 'user', content: prompt }], temperature: 0.3 };
    }

    // 确保 endpoint 包含完整路径（兼容用户只填写基础 URL 的情况）
    let fullEndpoint = endpoint;
    if (provider !== 'anthropic' && provider !== 'local' && !endpoint.endsWith('/chat/completions') && !endpoint.endsWith('/v1/messages')) {
      fullEndpoint = endpoint.replace(/\/+$/, '') + '/chat/completions';
    }

    const timeout = provider === 'local' ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(fullEndpoint, {
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
      // 兼容多种 endpoint 格式：
      // 1. https://api.example.com/v1/chat/completions → /v1/models
      // 2. https://api.example.com/v1 → /v1/models
      // 3. https://api.example.com → /models
      modelsEndpoint = endpoint.includes('/chat/completions')
        ? endpoint.replace('/chat/completions', '/models')
        : endpoint.replace(/\/+$/, '') + '/models';
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
      return { success: false, error: `获取模型列表失败 (HTTP ${response.status}): ${modelsEndpoint}` };
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

// ===== 事件监听 =====

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    const initStart = performance.now();
    let success = true;
    let errorType = '';
    try {
      await loadConfig();
      await loadUsageStats();
      await loadRateLimitState();
      initialized = true;
      // 首次初始化成功后异步清理旧指标与无效缓存，不阻塞
      cleanupMetrics();
      cleanupInvalidCacheEntries().catch(() => {});
    } catch (error) {
      success = false;
      errorType = classifyError(error);
      throw error;
    } finally {
      recordMetric({
        action: 'swInit',
        provider: resolveProviderConfig()?.provider || 'unknown',
        cached: false,
        latencyMs: Math.round(performance.now() - initStart),
        textLength: 0,
        tokens: 0,
        success,
        errorType
      });
    }
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await loadConfig();
    await loadUsageStats();
    await loadRateLimitState();
    initialized = true;

    // 清理已持久化的无效缓存条目
    cleanupInvalidCacheEntries().catch(() => {});

    // 先移除旧菜单，避免重复创建导致异常
    await new Promise(resolve => chrome.contextMenus.removeAll(resolve));

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

    // 首次安装：打开设置页完成最短成功路径
    if (details?.reason === 'install') {
      try {
        await chrome.storage.local.set({ firstRunPending: true });
        if (chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
        }
      } catch (e) {
        console.warn('[YuxTrans] 打开首次设置页失败:', e);
      }
    }
  } catch (error) {
    console.error('[YuxTrans] onInstalled 初始化失败:', error);
  }
});

chrome.runtime.onStartup.addListener(() => {
  Promise.all([loadConfig(), loadUsageStats(), loadRateLimitState()]).then(() => {
    initialized = true;
    cleanupInvalidCacheEntries().catch(() => {});
  });
});

// Service Worker 即将被终止时（包括扩展重载），立即把未落盘的缓存写入 IndexedDB
if (chrome.runtime && chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    flushCacheToDB().catch(() => {});
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'translate-selection') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'translateSelection',
      text: info.selectionText
    }).catch(() => { /* 内容脚本未注入或标签页已关闭 */ });
  } else if (info.menuItemId === 'translate-page') {
    chrome.tabs.sendMessage(tab.id, { action: 'translatePage' })
      .catch(() => { /* 内容脚本未注入或标签页已关闭 */ });
  } else if (info.menuItemId.startsWith('translate-to-')) {
    const targetLang = info.menuItemId.replace('translate-to-', '');
    chrome.tabs.sendMessage(tab.id, {
      action: 'translateSelection',
      text: info.selectionText,
      targetLang: targetLang
    }).catch(() => { /* 内容脚本未注入或标签页已关闭 */ });
  }
});

/**
 * 构造失败响应（含结构化用户错误）
 * @param {unknown} error
 * @returns {object}
 */
function failResponse(error) {
  const userError = toUserError(error);
  return {
    success: false,
    error: ProductHelpers.formatUserErrorText
      ? ProductHelpers.formatUserErrorText(userError)
      : (error?.message || String(error)),
    userError
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const respondOnce = (payload) => {
    try { sendResponse(payload); } catch (e) { /* 消息通道可能已关闭 */ }
  };

  ensureInitialized().then(() => {
    const tabId = sender.tab?.id || null;

    if (request.action === 'translate') {
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      const targetLang = request.targetLang || config.targetLang || 'zh';
      const context = request.context || null;

      translate(request.text, sourceLang, targetLang, context)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse(failResponse(error)));
      return;
    }

    else if (request.action === 'translateStream') {
      const streamStart = performance.now();
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      let targetLang = request.targetLang || config.targetLang || 'zh';
      targetLang = resolveTargetLanguage(request.text, sourceLang, targetLang);
      const resolvedSourceLang = resolveSourceLanguage(request.text, sourceLang);

      const context = request.context || null;
      const cacheKey = generateCacheKey(request.text, sourceLang, targetLang);
      const streamTokens = estimateTokens(request.text);
      const textLength = request.text?.length || 0;

      // 术语表优先
      const glossaryHit = lookupGlossary(request.text);
      if (glossaryHit != null) {
        recordUsage(true, 1);
        sendResponse({ success: true, text: glossaryHit, cached: true, engine: 'glossary' });
        return;
      }

      // 先查缓存
      const cached = getFromCache(cacheKey);
      if (cached) {
        recordUsage(true, 1);
        recordMetric({
          action: 'translateStream',
          provider: 'cache',
          cached: true,
          latencyMs: Math.round(performance.now() - streamStart),
          textLength,
          tokens: 0,
          success: true,
          errorType: ''
        });
        sendResponse({ success: true, text: cached, cached: true, engine: 'cache' });
        return;
      }

      try {
        assertOfflineAllowed(false);
      } catch (offlineErr) {
        sendResponse(failResponse(offlineErr));
        return;
      }

      translateWithStream(request.text, resolvedSourceLang, targetLang, tabId, context, null, request.requestId || null)
        .then(async (fullText) => {
          await setToCache(cacheKey, fullText);
          recordUsage(false, 1, streamTokens);
          recordMetric({
            action: 'translateStream',
            provider: resolveProviderConfig().provider,
            cached: false,
            latencyMs: Math.round(performance.now() - streamStart),
            textLength,
            tokens: streamTokens,
            success: true,
            errorType: ''
          });
          sendResponse({ success: true, text: fullText, cached: false, engine: resolveProviderConfig().provider });
        })
        .catch(async (error) => {
          // 流式失败时，尝试非流式故障转移（用户仍可在弹窗看到最终结果）
          if (config.autoFallback && !config.offlineMode) {
            try {
              const result = await translate(request.text, sourceLang, targetLang, context);
              sendResponse({ success: true, ...result });
              return;
            } catch (fallbackError) {
              console.error('[YuxTrans] 流式故障转移失败:', fallbackError);
            }
          }
          recordMetric({
            action: 'translateStream',
            provider: resolveProviderConfig().provider,
            cached: false,
            latencyMs: Math.round(performance.now() - streamStart),
            textLength,
            tokens: streamTokens,
            success: false,
            errorType: classifyError(error)
          });
          sendResponse(failResponse(error));
        });
      return;
    }

    else if (request.action === 'translateBatch') {
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      // 目标语言由 translateBatchInternal 内部为每个文本单独 resolveTargetLanguage
      // 确保缓存键与 translate() 函数一致
      const targetLang = request.targetLang || config.targetLang || 'zh';
      const context = request.context || null;

      translateBatchInternal(request.texts, sourceLang, targetLang, context)
        .then(results => sendResponse({ success: true, results }))
        .catch(error => sendResponse(failResponse(error)));
      return;
    }

    else if (request.action === 'getConfig') {
      sendResponse({ ...config, batchConfig: getBatchConfig() });
    }

    else if (request.action === 'getProviderDefaults') {
      sendResponse({ success: true, endpoints: API_ENDPOINTS, models: DEFAULT_MODELS });
    }

    else if (request.action === 'setConfig') {
      saveConfig(request.config)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return;
    }

    else if (request.action === 'reportBadTranslation') {
      reportBadTranslation(request)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse(failResponse(error)));
      return;
    }

    else if (request.action === 'disableSite') {
      disableSiteForHostname(request.hostname || request.host)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse(failResponse(error)));
      return;
    }

    else if (request.action === 'setSiteBilingualMode') {
      const host = (request.hostname || '').toLowerCase().trim();
      if (!host) {
        sendResponse({ success: false, error: '缺少 hostname' });
        return;
      }
      const prefs = { ...(config.siteModePrefs || {}) };
      prefs[host] = {
        ...(prefs[host] || {}),
        bilingualMode: request.bilingualMode !== false
      };
      saveConfig({ siteModePrefs: prefs })
        .then(() => sendResponse({ success: true, siteModePrefs: prefs }))
        .catch((error) => sendResponse(failResponse(error)));
      return;
    }

    else if (request.action === 'importGlossary') {
      try {
        const entries = ProductHelpers.parseGlossaryImport
          ? ProductHelpers.parseGlossaryImport(request.raw || '', request.filename || '')
          : [];
        const merged = Array.isArray(request.replace) && request.replace
          ? entries
          : [...(config.glossary || []), ...entries];
        // 按 source 去重，后写覆盖
        const map = new Map();
        for (const e of merged) {
          if (e?.source) map.set(String(e.source).replace(/\s+/g, ' ').trim(), {
            source: String(e.source).replace(/\s+/g, ' ').trim(),
            target: String(e.target ?? '')
          });
        }
        const glossary = Array.from(map.values());
        saveConfig({ glossary })
          .then(() => sendResponse({ success: true, count: glossary.length, glossary }))
          .catch((error) => sendResponse(failResponse(error)));
      } catch (error) {
        sendResponse(failResponse(error));
      }
      return;
    }

    else if (request.action === 'clearGlossary') {
      saveConfig({ glossary: [] })
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse(failResponse(error)));
      return;
    }

    else if (request.action === 'fetchModels') {
      fetchModels(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return;
    }

    else if (request.action === 'testProviderConnection') {
      testProviderConnection(request.config)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return;
    }

    else if (request.action === 'checkConnection') {
      // 使用当前激活档案检测连接状态，供 popup 状态灯使用
      const profile = getActiveProfile() || config;
      const profileId = config.activeProfileId || `${profile.provider}:${profile.model || profile.localModel || ''}`;
      const now = Date.now();
      if (connectionCache.profileId === profileId && now - connectionCache.timestamp < CONNECTION_CACHE_TTL) {
        sendResponse(connectionCache.result);
        return true;
      }

      const testConfig = {
        provider: profile.provider,
        apiKey: getApiKey(),
        endpoint: getEndpoint(),
        model: getModel()
      };
      testProviderConnection(testConfig)
        .then((result) => {
          connectionCache = { profileId, timestamp: Date.now(), result };
          sendResponse(result);
        })
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    }

    else if (request.action === 'clearCache') {
      cache.clear();
      cacheBytes = 0;
      cacheStats = { wordCount: 0, sizeBytes: 0 };
      pendingCacheWrites.clear();
      pendingCacheDeletes.clear();
      pendingCacheSave = false;
      if (cacheSaveTimer) {
        clearTimeout(cacheSaveTimer);
        cacheSaveTimer = null;
      }
      openDatabase().then(database => {
        const transaction = database.transaction([CACHE_STORE, MODELS_STORE], 'readwrite');
        transaction.objectStore(CACHE_STORE).clear();
        transaction.objectStore(MODELS_STORE).clear();
        transaction.oncomplete = () => sendResponse({ success: true });
        transaction.onerror = () => sendResponse({ success: true });
      }).catch(() => sendResponse({ success: true }));
      return; // 已经在上面异步返回了
    }

    else if (request.action === 'getCacheStats') {
      updateCacheStats();
      const cacheHits = usageStats.cacheHits || 0;
      const blockedHits = usageStats.blockedHits || 0;
      const userReportedHits = usageStats.userReportedHits || 0;
      const totalCacheHits = cacheHits + blockedHits;
      const badHitRate = totalCacheHits > 0
        ? Math.round(((blockedHits + userReportedHits) / totalCacheHits) * 100)
        : 0;
      sendResponse({
        success: true,
        stats: {
          wordCount: cacheStats.wordCount,
          sizeBytes: cacheStats.sizeBytes,
          sizeMB: Math.round(cacheStats.sizeBytes / 1024 / 1024 * 100) / 100,
          sizeGB: Math.round(cacheStats.sizeBytes / 1024 / 1024 / 1024 * 100) / 100
        },
        usage: {
          ...usageStats,
          totalCacheHits,
          badHitRate
        }
      });
    }

    else if (request.action === 'getMetrics') {
      const limit = request.limit || 1000;
      const days = request.days || METRICS_RETENTION_DAYS;
      getMetrics(limit, days)
        .then(metrics => {
          // 聚合摘要
          const total = metrics.length;
          const success = metrics.filter(m => m.success).length;
          const failure = total - success;
          const cacheHits = metrics.filter(m => m.cached).length;
          const avgLatency = total > 0
            ? Math.round(metrics.reduce((sum, m) => sum + (m.latencyMs || 0), 0) / total)
            : 0;
          const byProvider = {};
          metrics.forEach(m => {
            const p = m.provider || 'unknown';
            if (!byProvider[p]) byProvider[p] = { count: 0, success: 0, failure: 0, totalLatency: 0, cacheHits: 0 };
            byProvider[p].count++;
            if (m.success) byProvider[p].success++; else byProvider[p].failure++;
            byProvider[p].totalLatency += m.latencyMs || 0;
            if (m.cached) byProvider[p].cacheHits++;
          });
          Object.keys(byProvider).forEach(p => {
            const item = byProvider[p];
            item.avgLatency = item.count > 0 ? Math.round(item.totalLatency / item.count) : 0;
            delete item.totalLatency;
          });
          sendResponse({
            success: true,
            summary: { total, success, failure, cacheHits, avgLatency },
            byProvider,
            metrics: metrics.slice(0, 200) // 返回最近 200 条明细给前端
          });
        })
        .catch(error => sendResponse({ success: false, error: error.message }));
      return;
    }

    else if (request.action === 'getRequestLogs') {
      sendResponse({
        success: true,
        logs: getRequestLogs(request.limit)
      });
      return;
    }

    // ===== ProviderProfile 管理接口 =====
    else if (request.action === 'getProfiles') {
      sendResponse({ success: true, profiles: config.profiles || [], activeProfileId: config.activeProfileId });
    }

    else if (request.action === 'saveProfile') {
      const profile = request.profile;
      if (!profile || !profile.provider) {
        sendResponse({ success: false, error: '无效的供应商档案' });
        return;
      }
      const profileId = addOrUpdateProfile(profile);
      config.activeProfileId = profileId;
      saveProviderRecord({ ...profile, id: profileId });
      saveConfig(config)
        .then(() => sendResponse({ success: true, activeProfileId: profileId }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return;
    }

    else if (request.action === 'deleteProfile') {
      const profileId = request.profileId;
      if (!profileId) {
        sendResponse({ success: false, error: '缺少档案 ID' });
        return;
      }
      removeProfile(profileId);
      removeProviderRecord(profileId).then(() => {
        saveConfig(config).then(() => sendResponse({ success: true }));
      }).catch(e => sendResponse({ success: false, error: e.message }));
      return;
    }

    else if (request.action === 'setActiveProfile') {
      const profileId = request.profileId;
      const exists = config.profiles.some((p) => p.id === profileId);
      if (!exists) {
        sendResponse({ success: false, error: '档案不存在' });
        return;
      }
      config.activeProfileId = profileId;
      saveConfig(config)
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return;
    }

    else {
      sendResponse({ success: false, error: `未知 action: ${request.action}` });
    }
  }).catch(error => {
    console.error('[YuxTrans] 消息处理初始化失败:', error);
    respondOnce({ success: false, error: '扩展初始化失败，请刷新页面后重试' });
  });
  return true; // 保持消息通道打开
});

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    if (command === 'translate-selection') {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'translateSelection' })
        .catch(() => { /* 内容脚本未注入或标签页已关闭 */ });
    } else if (command === 'translate-page') {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'translatePage' })
        .catch(() => { /* 内容脚本未注入或标签页已关闭 */ });
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
      chrome.action.setBadgeText({ text: 'NEW' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#d85151' }).catch(() => {});
      chrome.storage.local.set({
        updateAvailable: {
          version: latestVersion,
          url: data.html_url,
          zipUrl: data.zipball_url,
          body: data.body
        }
      }).catch(() => {});
    } else {
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
      chrome.storage.local.remove('updateAvailable').catch(() => {});
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

// 捕获未处理的异常与 Promise 拒绝，避免 Service Worker 进入坏状态
if (typeof self !== 'undefined') {
  self.addEventListener('error', (event) => {
    console.error('[YuxTrans] Service Worker error:', event.message, event.filename, event.lineno);
  });

  self.addEventListener('unhandledrejection', (event) => {
    console.error('[YuxTrans] Unhandled rejection:', event.reason);
  });
}

// 为 Node 测试导出核心函数（Service Worker 中 module 未定义，不会执行）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getDefaultModel,
    getEndpoint,
    getApiKey,
    getModel,
    getFormat,
    getBatchConfig,
    buildRequest,
    supportsJsonMode,
    generateCacheKey,
    normalizeCacheKeyText,
    parseCacheKey,
    formatError,
    toUserError,
    failResponse,
    lookupGlossary,
    assertOfflineAllowed,
    withDbRetry,
    reportBadTranslation,
    detectLanguage,
    resolveTargetLanguage,
    resolveSourceLanguage,
    isProviderAvailable,
    splitIntoCharBatches,
    buildBatchPrompt,
    buildTranslationPrompt,
    resolveProviderConfig,
    getActiveProfile,
    addOrUpdateProfile,
    removeProfile,
    makeProfileId,
    ProductHelpers,
    SW,
    // 便于测试直接调用 helpers / SW modules
    ...ProductHelpers,
    isKnownMessageAction: SW.isKnownMessageAction,
    classifyMessageAction: SW.classifyMessageAction
  };
}