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
    'lib/sw/translate-core.js',
    'lib/sw/scheduler.js'
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
    require('./lib/sw/scheduler.js');
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
const CACHE_KEY_VERSION = SW.CACHE_KEY_VERSION || 'v3';

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

/**
 * 全局出站 API 并发闸门（信号量）：所有出站请求（单句 / 流式 / 批量）发送前必须 acquire。
 * 上限在每次放行决策时动态读取 getRateLimitParams()，429 限速把 concurrentLimit
 * 降下来后对主流量即时生效——这是自适应并发的真正全局上限。
 * 与 content.js 自管并发（整页批量 50 / 流式 4）是叠加关系：content 只负责提交，
 * 此处兜底。例如流式 4 路并发遇上限速到 1，流式段落会被闸门串行化——这是限速期的预期效果。
 */
const apiConcurrencyGate = SW.createConcurrencyGate(() => getRateLimitParams().maxConcurrent);

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
  // 用户自定义风格提示词（仅存与默认不同的键；键为 normal|academic|technical|literary）
  stylePrompts: {},
  triggerMode: 'modifier', // 'modifier'(默认 修饰键+划选) | 'auto' | 'icon' | 'contextMenu'
  selectionModifier: 'ctrl', // 'ctrl' | 'alt' | 'shift'（triggerMode=modifier 时生效）
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
  siteModePrefs: {},

  // F1 悬停段落翻译
  hoverTranslate: true,
  hoverModifier: 'alt', // 'alt' | 'ctrl'
  // F2 单词词典模式
  dictMode: true,
  dictDblclick: true,
  // F3 译文显示样式：原文呈现 normal | fade | blur
  originalStyle: 'normal',
  // F5 输入框翻译
  inputTranslate: false,
  // F6 正文区域识别（整页翻译只翻正文区）
  smartContentDetection: false,
  // F4b：双档案对照--对照档案 ID（为空则不对照）
  compareProfileId: ''
};

let cache = new Map();        // 内存热缓存 key -> value；Map 的插入顺序即 LRU 顺序（最旧在前）
let cacheBytes = 0;           // 内存热缓存字节数（UTF-16 估算）
// Q3：全量统计（热缓存 + 仅存于 IndexedDB 的冷数据），供占用展示与总量限额判断。
// 会话内为近似值（冷键被覆写时会轻微高估），每次 SW 启动 loadCacheFromDB 按 getAll 重算校准
let totalCacheCount = 0;
let totalCacheBytes = 0;
let cacheStats = { wordCount: 0, sizeBytes: 0 };
let pendingCacheWrites = new Set(); // 待写入 IndexedDB 的键
let pendingCacheDeletes = new Set(); // 待从 IndexedDB 删除的键
let db = null;

// 缓存落盘控制：减少 IndexedDB 事务频率，同时避免 Service Worker 终止前大量丢失。
// 已知取舍（勿当 bug 修）：3s flush 窗口内 SW 若休眠，pending 写入仅靠 onSuspend 兜底，
// 而 onSuspend 中的 async IndexedDB 写不被平台保证完成——可能丢失最近几条缓存。
// 缓存本就易失（miss 后重译即可），此取舍可接受；如要根治需关键写入同步 flush，代价是事务频率上升。
const CACHE_FLUSH_MAX_PENDING = 100; // 累计多少条待写入后强制 flush
const CACHE_FLUSH_DELAY_MS = 3000;   // 定时 flush 间隔
let flushTimer = null;               // 定时 flush 句柄

// Q3：内存热缓存上限（字节估算）。冷数据留 IndexedDB，getFromCache 内存未命中时
// 单键回查并提升为热条目，避免 SW 每次唤醒把整库（上限为用户限额）一次性读入内存
const MEM_CACHE_MAX_BYTES = 32 * 1024 * 1024;

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
  // 区分 CJK 与 Latin：CJK 约 1.5 字符/token，Latin 约 4 字符/token
  let cjk = 0, other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||  // CJK 统一表意
        (code >= 0x3040 && code <= 0x30FF) ||  // 平假名+片假名
        (code >= 0xAC00 && code <= 0xD7AF) ||  // 韩文音节
        (code >= 0x3400 && code <= 0x4DBF)) {  // CJK 扩展A
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
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
          totalCacheCount = 0;
          totalCacheBytes = 0;
          pendingCacheWrites.clear();
          pendingCacheDeletes.clear();

          // 按时间戳从新到旧排序：优先把最新条目装进内存热缓存、优先保留最新条目
          items.sort((a, b) => b.timestamp - a.timestamp);
          const maxBytes = (config.maxCacheMB || 200) * 1024 * 1024;
          const hot = [];
          let invalidCount = 0;
          for (const item of items) {
            const validation = validateCacheEntry(item.key, item.value);
            if (!validation.valid) {
              pendingCacheDeletes.add(item.key);
              invalidCount++;
              continue;
            }
            const entryBytes = item.key.length * 2 + item.value.length * 2;
            // 用户限额针对总量（热+冷）：超出部分直接物理删除最旧条目
            if (totalCacheBytes + entryBytes > maxBytes) {
              pendingCacheDeletes.add(item.key);
              continue;
            }
            totalCacheCount++;
            totalCacheBytes += entryBytes;
            // Q3：内存只装最热的一段，其余有效条目留在 IndexedDB 作为冷数据按需回查
            if (cacheBytes + entryBytes <= MEM_CACHE_MAX_BYTES) {
              hot.push(item);
              cacheBytes += entryBytes;
            }
          }
          // hot 当前为新→旧顺序；反转为旧→新插入，使最新项位于 Map 末尾
          //（LRU 淘汰取 Map 首部 = 最旧项。此前实现按新→旧直接插入，首部反而是最新项，
          //  裁剪时会先删最新缓存，属既有 bug，随 Q3 一并修正）
          for (let i = hot.length - 1; i >= 0; i--) {
            cache.set(hot[i].key, hot[i].value);
          }
          if (invalidCount > 0) {
            console.log(`[YuxTrans] 加载缓存时跳过 ${invalidCount} 条无效/旧版本记录`);
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
  // Q3：对外展示全量（热+冷），而非仅内存热条目
  cacheStats = { wordCount: totalCacheCount, sizeBytes: totalCacheBytes };
}

// ===== 缓存操作 =====

/**
 * Q3：单键回查 IndexedDB 冷数据（内存未命中时调用）
 * @returns {Promise<string|undefined>} 命中返回 value，未命中/出错返回 undefined
 */
async function getColdEntryFromDB(key) {
  try {
    return await withDbRetry(async () => {
      const database = await openDatabase();
      return await new Promise((resolve) => {
        const request = database.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key);
        request.onsuccess = () => {
          const record = request.result;
          resolve(record && typeof record.value === 'string' ? record.value : undefined);
        };
        request.onerror = () => {
          console.error('[YuxTrans] 冷缓存回查失败:', request.error);
          resolve(undefined);
        };
      });
    });
  } catch (e) {
    console.error('[YuxTrans] 冷缓存回查异常:', e);
    return undefined;
  }
}

/**
 * Q3：内存热缓存超 MEM_CACHE_MAX_BYTES 时淘汰最旧项
 *（被淘汰项仍保留在 IndexedDB，不加入 pendingCacheDeletes；未落盘的 pending 写入跳过不淘汰）
 */
function trimHotCache() {
  while (cacheBytes > MEM_CACHE_MAX_BYTES && cache.size > 1) {
    let oldestKey = null;
    for (const k of cache.keys()) {
      if (!pendingCacheWrites.has(k)) { oldestKey = k; break; }
    }
    if (oldestKey === null) break;
    const oldestVal = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= oldestKey.length * 2 + oldestVal.length * 2;
  }
}

/**
 * Q3：把冷数据命中提升为内存热条目
 */
function promoteToHotCache(key, value) {
  if (cache.has(key)) {
    const old = cache.get(key);
    cacheBytes -= key.length * 2 + old.length * 2;
    cache.delete(key);
  }
  cache.set(key, value);
  cacheBytes += key.length * 2 + value.length * 2;
  trimHotCache();
}

/**
 * 读缓存（Q3 异步化）：先查内存热缓存，未命中回查 IndexedDB 冷数据并提升。
 * @returns {Promise<string|null>}
 */
async function getFromCache(key) {
  if (!config.cacheEnabled) return null;
  let value = cache.get(key);

  if (value === undefined) {
    // 内存未命中：回查冷数据
    const coldValue = await getColdEntryFromDB(key);
    if (coldValue === undefined) return null;
    // 冷数据只经历完整校验（可能是旧版本/坏条目）；不合格则物理删除
    const validation = validateCacheEntry(key, coldValue);
    if (!validation.valid) {
      pendingCacheDeletes.add(key);
      if (totalCacheCount > 0) totalCacheCount--;
      totalCacheBytes = Math.max(0, totalCacheBytes - (key.length * 2 + coldValue.length * 2));
      updateCacheStats();
      saveCacheToDB();
      return null;
    }
    promoteToHotCache(key, coldValue);
    return coldValue;
  }

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

  // 所有写入均经 Cache Validator；词典键（style='dict'）在 validateCacheEntry
  // 内部分流跳过译文专有规则，不再需要通用 skipValidation 逃生口
  const validation = validateCacheEntry(key, value);
  if (!validation.valid) return;

  const entryBytes = key.length * 2 + value.length * 2;
  const maxBytes = (config.maxCacheMB || 200) * 1024 * 1024;

  // 若 key 已在内存热缓存，先扣除旧字节并删除旧位置
  if (cache.has(key)) {
    const oldValue = cache.get(key);
    const oldBytes = key.length * 2 + oldValue.length * 2;
    cacheBytes -= oldBytes;
    totalCacheCount--;
    totalCacheBytes = Math.max(0, totalCacheBytes - oldBytes);
    cache.delete(key);
  }
  // 注意：key 若以冷数据仅存于 IndexedDB，此处无法廉价感知，总量会轻微高估，
  // 属可接受的近似（下次 SW 启动 loadCacheFromDB 按 getAll 重算校准）

  // 存入新项（内存热缓存 + 待落盘队列）
  cache.set(key, value);
  cacheBytes += entryBytes;
  totalCacheCount++;
  totalCacheBytes += entryBytes;
  pendingCacheWrites.add(key);
  pendingCacheDeletes.delete(key);

  // D: 改为批量 flush，减少 IndexedDB 事务频率
  scheduleCacheFlush();

  // 用户限额针对总量：从最旧的热条目开始物理删除（含冷数据部分的硬保证由启动加载裁剪提供）
  while (totalCacheBytes > maxBytes && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    const oldestVal = cache.get(oldestKey);
    const oldestBytes = oldestKey.length * 2 + oldestVal.length * 2;
    cache.delete(oldestKey);
    cacheBytes -= oldestBytes;
    totalCacheCount--;
    totalCacheBytes = Math.max(0, totalCacheBytes - oldestBytes);
    pendingCacheDeletes.add(oldestKey);
    pendingCacheWrites.delete(oldestKey);
  }

  // 内存热缓存自身限额（Q3）
  trimHotCache();

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
// 短源文规则（length_ratio / entity_drift）的适用上限。必须大于 MIN_CACHE_SOURCE_LENGTH，
// 否则短源文已被 too_short 拦截、两条规则永不可达（历史值 10 < 12 即为死代码，2026-07-28 修正为 24）。
// 12~24 字符的短译文恰是坏缓存最难肉眼分辨的区间，规则在此真正生效。
const SHORT_SOURCE_THRESHOLD = 24;
const RULE3_SAMPLE_THRESHOLD = 200;
const RULE3_SAMPLE_SIZE = 100;
const RULE3_MIN_TARGET_SCRIPT_RATIO = 0.5;

const CJK_LANGS = new Set(['zh', 'ja', 'ko']);
const LATIN_LANGS = new Set(['en', 'vi', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl']);

/**
 * 解析缓存键（cache 模块）
 * @param {string} key
 * @returns {{version:string,promptVersion:string,model:string,sourceLang:string,targetLang:string,style:string,text:string}}
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
  // 词典缓存（style 段为 'dict'）：仅过版本校验，跳过译文专有规则。
  // 词典 JSON 非译文近似命中，单词普遍 <12 字符，不应被 too_short 等译文规则误拦。
  if (parsed.style === 'dict') {
    return { valid: true, rule: null };
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
  const entryBytes = key.length * 2 + value.length * 2;
  cacheBytes -= entryBytes;
  totalCacheCount--;
  totalCacheBytes = Math.max(0, totalCacheBytes - entryBytes);
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
  // 自定义风格提示词改变缓存 style 段，避免与默认提示下的旧译文误命中
  const styleSeg = (resolvedStyle !== 'dict' && SW.styleSegmentForCache)
    ? SW.styleSegmentForCache(resolvedStyle, config.stylePrompts)
    : resolvedStyle;
  // 编入当前 model：不同模型译文各自独立缓存，避免切档案对比时读到旧模型缓存
  const pc = resolveProviderConfig();
  const model = pc.model || pc.localModel || '';
  return SW.generateCacheKey
    ? SW.generateCacheKey(text, sourceLang, targetLang, styleSeg, model)
    : `${CACHE_KEY_VERSION}:${SW.PROMPT_VERSION || 'p1'}:${SW.modelSlug ? SW.modelSlug(model) : (model || '_')}:${sourceLang}:${targetLang}:${styleSeg}:${normalizeCacheKeyText(text)}`;
}

// ===== 翻译会话取消管理 =====
// 整页/动态批量翻译分配 sessionId，用户取消时 abort 在途请求并阻止后续批次，
// 避免停止翻译后继续消耗云端配额。
const translationSessions = new Map(); // sessionId -> { cancelled, controllers, createdAt }
// 页面直接关闭（未发 cancel）的会话无人清理，超过该时长视为僵尸会话
const SESSION_ZOMBIE_TTL_MS = 30 * 60 * 1000; // 30 分钟

// 清扫超时僵尸会话：abort 其 AbortController 后从 Map 移除
function sweepZombieSessions() {
  const now = Date.now();
  for (const [k, v] of translationSessions) {
    if (now - (v.createdAt || 0) > SESSION_ZOMBIE_TTL_MS) {
      for (const c of v.controllers) {
        try { c.abort(); } catch (e) { /* 已 abort 忽略 */ }
      }
      v.controllers.clear();
      translationSessions.delete(k);
    }
  }
}

function getTranslationSession(sessionId) {
  if (!sessionId) return null;
  let s = translationSessions.get(sessionId);
  if (!s) {
    // 惰性清理已取消的旧会话，避免 Map 无限增长
    if (translationSessions.size > 16) {
      for (const [k, v] of translationSessions) {
        if (v.cancelled) translationSessions.delete(k);
      }
    }
    // 新会话创建时顺带清扫超时僵尸会话（页面未发 cancel 直接关闭的场景）
    sweepZombieSessions();
    s = { cancelled: false, controllers: new Set(), createdAt: Date.now() };
    translationSessions.set(sessionId, s);
  }
  return s;
}

function isSessionCancelled(sessionId) {
  const s = sessionId ? translationSessions.get(sessionId) : null;
  return !!(s && s.cancelled);
}

function registerSessionController(sessionId, controller) {
  const s = getTranslationSession(sessionId);
  if (!s) return;
  s.controllers.add(controller);
  // controller 结束后从集合移除，避免集合无限增长
  try {
    controller.signal.addEventListener('abort', () => s.controllers.delete(controller));
  } catch (e) { /* 忽略 */ }
}

function cancelTranslationSession(sessionId) {
  const s = translationSessions.get(sessionId);
  if (!s) return 0;
  s.cancelled = true;
  let n = 0;
  for (const c of s.controllers) {
    try { c.abort(); n++; } catch (e) { /* 已 abort 忽略 */ }
  }
  s.controllers.clear();
  // 不立即删除：在途的 translateBatchInternal 循环需读到 cancelled=true 才会中止；
  // 旧会话由后续 getTranslationSession 惰性清理。
  return n;
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
    const existing = config.profiles[idx];
    const merged = { ...existing, ...profile, savedAt: Date.now() };
    // 页面不再回显明文 Key：空字符串视为「不修改」，保留原 Key
    if (!profile.apiKey && existing.apiKey) {
      merged.apiKey = existing.apiKey;
    }
    const existingCp = existing.customProvider || {};
    if (!profile.customProvider?.apiKey && existingCp.apiKey) {
      merged.customProvider = { ...(profile.customProvider || {}), apiKey: existingCp.apiKey };
    }
    config.profiles[idx] = merged;
  } else {
    config.profiles.push({ ...profile, savedAt: Date.now() });
  }
  config.activeProfileId = profile.id;
  return profile.id;
}

/**
 * 脱敏档案：不向外回吐明文 API Key，仅提供 hasApiKey 标志（getConfig / getProfiles 响应用）
 * @param {object} profile
 * @returns {object}
 */
function sanitizeProfileForClient(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const cp = profile.customProvider || {};
  return {
    ...profile,
    apiKey: '',
    hasApiKey: !!(profile.apiKey || cp.apiKey),
    customProvider: {
      name: cp.name || '',
      endpoint: cp.endpoint || '',
      apiKey: '',
      hasApiKey: !!cp.apiKey,
      format: cp.format || 'openai',
      model: cp.model || ''
    }
  };
}

/**
 * 构造对外（content script / 扩展页面）的脱敏配置，SW 内部 config 不受影响
 * @returns {object}
 */
function buildSanitizedConfig() {
  return {
    ...config,
    apiKey: '',
    profiles: (config.profiles || []).map(sanitizeProfileForClient)
  };
}

/**
 * 页面表单不回显明文 Key：当请求未携带 apiKey 时，回退到已保存的同供应商档案 Key
 * @param {string} provider
 * @returns {string}
 */
function getStoredApiKeyForProvider(provider) {
  if (!provider || provider === 'local') return '';
  const profiles = config.profiles || [];
  const active = getActiveProfile();
  const match = (active && active.provider === provider)
    ? active
    : profiles.find((p) => p.provider === provider);
  if (!match) return '';
  return provider === 'custom' ? (match.customProvider?.apiKey || '') : (match.apiKey || '');
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
      context,
      config.stylePrompts || null
    );
  }
  return `Translate to ${targetLang}:\n${text}`;
}

/**
 * F2：构建单词词典查询 Prompt（转发到 SW.buildDictionaryPrompt）
 * 词典模式与翻译风格无关，不注入 style/context；无 SW 实现时降级为普通翻译 prompt
 */
function buildDictionaryPrompt(word, sourceLang, targetLang) {
  if (SW.buildDictionaryPrompt) {
    return SW.buildDictionaryPrompt(word, sourceLang, targetLang);
  }
  return `Translate to ${targetLang}:\n${word}`;
}

/**
 * F2：单词词典查询--结构化词典卡片（音标/义项/例句）
 * 独立缓存键（style 段为 'dict'），单词 <12 字符由 Validator 内部分流放行
 * @param {string} word
 * @param {string} sourceLang
 * @param {string} targetLang
 * @returns {Promise<{dict: object, cached: boolean, engine: string}>}
 */
async function lookupWord(word, sourceLang = 'auto', targetLang = 'zh') {
  const start = performance.now();
  targetLang = resolveTargetLanguage(word, sourceLang, targetLang);
  const resolvedSourceLang = resolveSourceLanguage(word, sourceLang);

  // 缓存键：style 段复用为 mode 段（'dict'），与正常译文（'normal' 等）不撞
  const cacheKey = generateCacheKey(word, sourceLang, targetLang, 'dict');

  // 先查缓存（getFromCache 不检查长度门槛，单词可命中；Q3 起为异步冷热两级）
  const cached = await getFromCache(cacheKey);
  if (cached) {
    recordUsage(true, 1);
    return { dict: safeParseDictJson(cached), cached: true, engine: 'cache' };
  }

  assertOfflineAllowed(false);

  const tokens = estimateTokens(word);
  const activeProvider = resolveProviderConfig().provider;
  try {
    const prompt = buildDictionaryPrompt(word, resolvedSourceLang, targetLang);
    // jsonMode + 自定义 prompt，复用 translateWithCloud 的请求/限流/超时路径
    // 方案 4：词典查询用 0.0 温度，事实性输出最稳
    const raw = await translateWithCloud(word, resolvedSourceLang, targetLang, null, null, {
      promptOverride: prompt,
      jsonMode: true,
      temperature: 0.0
    });
    // 解析降级链：JSON.parse -> 失败则 { word, senses: [], raw } 纯文本降级
    const dict = parseDictionaryResult(raw, word);
    // 缓存：词典 JSON 非译文，由 validateCacheEntry 对 style='dict' 分流放行（单词 <12 字符不被 too_short 误拦）
    await setToCache(cacheKey, JSON.stringify(dict));
    recordUsage(false, 1, tokens);
    recordMetric({
      action: 'lookupWord',
      provider: activeProvider,
      cached: false,
      latencyMs: Math.round(performance.now() - start),
      textLength: word?.length || 0,
      tokens,
      success: true,
      errorType: ''
    });
    return { dict, cached: false, engine: activeProvider };
  } catch (error) {
    recordMetric({
      action: 'lookupWord',
      provider: activeProvider,
      cached: false,
      latencyMs: Math.round(performance.now() - start),
      textLength: word?.length || 0,
      tokens,
      success: false,
      errorType: classifyError(error)
    });
    throw error;
  }
}

/**
 * F2：解析词典 JSON 输出，规范化结构；解析失败降级为 { word, senses: [], raw }
 */
function parseDictionaryResult(raw, word) {
  if (!raw || typeof raw !== 'string') {
    return { word: word || '', phonetic: '', senses: [] };
  }
  // 提取首个 JSON 对象（模型可能带多余前后文本）
  const match = raw.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : raw.trim();
  try {
    const obj = JSON.parse(jsonStr);
    const senses = Array.isArray(obj.senses) ? obj.senses.map((s) => ({
      pos: typeof s.pos === 'string' ? s.pos : '',
      meaning: typeof s.meaning === 'string' ? s.meaning : '',
      examples: Array.isArray(s.examples) ? s.examples.map((ex) => ({
        source: typeof ex.source === 'string' ? ex.source : '',
        target: typeof ex.target === 'string' ? ex.target : ''
      })) : []
    })) : [];
    return {
      word: typeof obj.word === 'string' ? obj.word : (word || ''),
      phonetic: typeof obj.phonetic === 'string' ? obj.phonetic : '',
      senses
    };
  } catch (e) {
    // 解析失败：按纯文本降级（本地小模型可能不输出 JSON）
    return { word: word || '', phonetic: '', senses: [], raw };
  }
}

/**
 * F2：安全解析缓存的词典 JSON（缓存以字符串形式存储）
 */
function safeParseDictJson(cached) {
  if (cached == null) return null;
  if (typeof cached === 'object') return cached;
  try {
    return JSON.parse(cached);
  } catch (e) {
    return { word: '', phonetic: '', senses: [], raw: String(cached) };
  }
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
 * 方案 1：支持 systemPrompt（批量规则移入 system message，user message 只带数据）
 * 方案 4：支持 temperature 按场景分流
 * @param {string} prompt - user message 内容
 * @param {boolean} stream
 * @param {object|null} [providerOverride]
 * @param {boolean} [jsonMode]
 * @param {string} [systemPrompt] - system message（可选）
 * @param {number} [temperature=0.3] - 采样温度
 */
function buildRequest(prompt, stream = false, providerOverride = null, jsonMode = false, systemPrompt = null, temperature = 0.3) {
  const p = resolveProviderConfig(providerOverride);
  const format = getFormat(p);
  const model = getModel(p);
  const apiKey = getApiKey(p);
  let headers = { 'Content-Type': 'application/json' };
  let body;

  // 构建 messages：有 systemPrompt 时插入 system 角色
  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  if (format === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      max_tokens: 4096,
      stream,
      messages
    };
  } else if (p.provider === 'local') {
    body = {
      model,
      messages,
      stream
    };
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = {
      model,
      messages,
      temperature,
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
async function translateWithCloud(text, sourceLang = 'auto', targetLang = 'zh', context = null, providerOverride = null, options = {}) {
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

  // 免配置供应商（local/custom/google）无需 API Key
  if (!apiKey && !isNoConfigProvider(p.provider)) {
    throw new Error('请先配置 API Key');
  }
  if (!endpoint && p.provider === 'custom') {
    throw new Error('请配置自定义 API 地址');
  }

  // 自定义端点需已授权域名（optional_host_permissions 按需申请，见 options 页测试连接/获取模型）
  if (p.provider === 'custom' && endpoint && typeof chrome !== 'undefined' && chrome.permissions) {
    try {
      const originPattern = new URL(endpoint).origin + '/*';
      const hasHost = await chrome.permissions.contains({ origins: [originPattern] });
      if (!hasHost) {
        throw new Error('该自定义端点域名未授权，请在设置页点击「测试连接」或「获取模型」以授权');
      }
    } catch (permErr) {
      if (permErr && permErr.message && permErr.message.includes('未授权')) throw permErr;
      // URL 解析等异常不阻断，交由后续 fetch 暴露真实错误
    }
  }

  // 应用速率延迟
  await applyRateDelay();

  // 出站并发闸门：槽位持有至请求结束（含超时 abort / 出错），try/finally 保证释放不泄漏
  await apiConcurrencyGate.acquire(options.priority);

  try {
    // F7：谷歌免费接口走专门请求路径（GET + 数组响应，非 OpenAI 格式）
    if (p.provider === 'google') {
      return googleTranslate(text, sourceLang, targetLang, p);
    }

    // F2：词典模式支持自定义 prompt + jsonMode（复用同一 fetch/限流/超时路径）
    const prompt = options.promptOverride || buildTranslationPrompt(text, sourceLang, targetLang, context);
    // 方案 4：温度按场景分流--词典 0.0 / 划词 0.2 / 默认 0.3
    const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
    const { headers, body } = buildRequest(prompt, false, p, options.jsonMode === true, null, temperature);
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
  } finally {
    apiConcurrencyGate.release();
  }
}



/**
 * F7：谷歌免费翻译接口（translate.googleapis.com）
 * 无需 API Key，GET 请求，响应为嵌套数组，提取译文段拼接
 */
async function googleTranslate(text, sourceLang, targetLang, providerOverride = null) {
  const endpoint = API_ENDPOINTS.google || 'https://translate.googleapis.com/translate_a/single';
  const sl = sourceLang === 'auto' ? 'auto' : sourceLang;
  const url = `${endpoint}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const logStart = performance.now();
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const isRateLimit = response.status === 429;
      updateRateLimitState(false, isRateLimit);
      throw new Error(
        isRateLimit
          ? (ERROR_MESSAGES.RATE_LIMITED || '请求过于频繁，请稍后再试')
          : formatError(response.status, await response.text())
      );
    }
    const data = await response.json();
    // 响应格式：[[["译文","原文",null,null,10],...],...]
    const translated = (Array.isArray(data) && Array.isArray(data[0]))
      ? data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string') ? seg[0] : '').join('')
      : '';
    updateRateLimitState(true);
    logRequest({
      action: 'translate',
      provider: 'google',
      model: 'gtx',
      sourceLang,
      targetLang,
      prompt: truncateForLog(text),
      response: truncateForLog(translated),
      latencyMs: Math.round(performance.now() - logStart),
      success: true
    });
    return translated.trim();
  } catch (error) {
    clearTimeout(timeoutId);
    const finalError = error.name === 'AbortError' ? new Error('请求超时（30秒），请检查网络') : error;
    logRequest({
      action: 'translate',
      provider: 'google',
      model: 'gtx',
      sourceLang,
      targetLang,
      prompt: truncateForLog(text),
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
async function translateWithStream(text, sourceLang, targetLang, tabId, options = {}) {
  const { context = null, providerOverride = null, requestId = null, sessionId = null, priority = SW.SCHEDULER_PRIORITY.NORMAL } = options;
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

  // 免配置供应商（local/custom/google）无需 API Key
  if (!apiKey && !isNoConfigProvider(p.provider)) {
    throw new Error('请先配置 API Key');
  }

  // 应用速率延迟
  await applyRateDelay();

  // 出站并发闸门：SSE 流持有槽位直到流读完/出错/abort（会话取消经 finally 释放，不泄漏）
  await apiConcurrencyGate.acquire(priority);

  try {
    // 同语言跳过：文本已是目标语言则推送原文并返回，不调 API（避免把中文翻成英文等互译混用）
    if (isSameAsTargetLanguage(text, targetLang)) {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: 'streamChunk', requestId, chunk: text, fullText: text }).catch(() => { /* tab 可能已关闭 */ });
      } else {
        chrome.runtime.sendMessage({ action: 'streamChunk', requestId, chunk: text, fullText: text }).catch(() => { /* popup 可能未打开 */ });
      }
      return text;
    }

    // F7：google 免费接口无 SSE，降级为一次性翻译并以单 chunk 推送（保持流式调用契约）
    if (p.provider === 'google') {
      const translated = await googleTranslate(text, sourceLang, targetLang, p);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: 'streamChunk', requestId, chunk: translated, fullText: translated }).catch(() => { /* tab 可能已关闭 */ });
      } else {
        chrome.runtime.sendMessage({ action: 'streamChunk', requestId, chunk: translated, fullText: translated }).catch(() => { /* popup 可能未打开 */ });
      }
      return translated;
    }

    const format = getFormat(p);
    const prompt = buildTranslationPrompt(text, sourceLang, targetLang, context);
    // 方案 4：流式翻译保持 0.3（逐字输出的体验感）
    const { headers, body } = buildRequest(prompt, true, p, false, null, 0.3);

    const controller = new AbortController();
    // 接入整页取消会话：用户取消整页流式翻译时 abort 在途 SSE（与批量路径对齐，避免继续消耗配额）
    registerSessionController(sessionId, controller);
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
  } finally {
    apiConcurrencyGate.release();
  }
}

// ===== 智能语言方向检测 =====

/**
 * Unicode 脚本区间定义（用于轻量语言检测）
 * 唯一来源为 lib/sw/lang.js（background 加载时必然已挂载，不再保留重复 fallback）
 */
const SCRIPT_RANGES = SW.SCRIPT_RANGES;

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
 * 同语种不再翻向对照语言：已是目标语言的文本由 isSameAsTargetLanguage 跳过，
 * 统一返回用户设置的目标语言。
 * @param {string} text
 * @param {string} sourceLang
 * @param {string} targetLang
 * @returns {string}
 */
function resolveTargetLanguage(text, sourceLang, targetLang) {
  return targetLang;
}

/**
 * 文本是否已是目标语言（同语言文本跳过翻译，避免中英互译混用）
 * @param {string} text
 * @param {string} targetLang
 * @returns {boolean}
 */
function isSameAsTargetLanguage(text, targetLang) {
  return SW.isSameAsTargetLanguage
    ? SW.isSameAsTargetLanguage(text, targetLang)
    : false;
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
 * 是否为免配置供应商（local/custom/google 无需 API Key）
 * @param {string} provider
 * @returns {boolean}
 */
function isNoConfigProvider(provider) {
  return SW.isNoConfigProvider
    ? SW.isNoConfigProvider(provider)
    : (provider === 'local' || provider === 'custom' || provider === 'google');
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

async function translate(text, sourceLang = 'auto', targetLang = 'zh', context = null, options = {}) {
  // 出站并发闸门优先级：默认 HIGH（划词/弹窗单句）；批量补全经 options 传入 LOW
  const gatePriority = (typeof options.priority === 'number') ? options.priority : SW.SCHEDULER_PRIORITY.HIGH;
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

  // 同语言跳过：文本已是目标语言则原样返回，不调 API（避免把中文翻成英文等互译混用）
  if (isSameAsTargetLanguage(text, targetLang)) {
    recordUsage(true, 1);
    recordMetric({
      action: 'translate',
      provider: 'same-lang',
      cached: true,
      latencyMs: Math.round(performance.now() - start),
      textLength: text?.length || 0,
      tokens: 0,
      success: true,
      errorType: ''
    });
    return { text, cached: true, engine: 'same-lang' };
  }

  const cacheKey = generateCacheKey(text, sourceLang, targetLang);

  const cached = await getFromCache(cacheKey);
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
    // 划词优先级最高；相同 cacheKey 的并发请求（划词+整页批次同文本）共享一次结果
    const translated = SW.scheduleTranslation
      ? await SW.scheduleTranslation(cacheKey, () => translateWithCloud(text, resolvedSourceLang, targetLang, context, null, { priority: gatePriority }), SW.SCHEDULER_PRIORITY.HIGH)
      : await translateWithCloud(text, resolvedSourceLang, targetLang, context, null, { priority: gatePriority });
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
          const translated = await translateWithCloud(text, resolvedSourceLang, targetLang, context, fallback, { priority: gatePriority });
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
 * 构建批量翻译 System Prompt（规则与风格指令，方案 1：移入 system message）
 */
function buildBatchSystemPrompt(groupTexts, groupSourceLang, groupTargetLang) {
  const targetName = LANG_NAMES[groupTargetLang] || groupTargetLang;
  const sourceName = groupSourceLang === 'auto' ? null : (LANG_NAMES[groupSourceLang] || groupSourceLang);
  const styleHint = SW.resolveStylePrompt
    ? SW.resolveStylePrompt(config.translateStyle, config.stylePrompts)
    : (STYLE_PROMPTS[config.translateStyle] || '');

  let system = `You are a professional translator. Translate the following JSON array of strings`;
  if (sourceName) system += ` from ${sourceName}`;
  system += ` to ${targetName}.`;
  if (styleHint) system += `\nStyle: ${styleHint}`;
  system += `\nSTRICT OUTPUT RULES:
1. Return ONLY a valid JSON array of strings. The array length MUST be exactly ${groupTexts.length} and the order MUST match the input exactly.
2. Translate each item independently. Do not summarize, infer, or reuse text from one item for another.
3. Do NOT include any markdown, code fences, explanations, notes, or page-level context.
4. If an item is already in the target language or contains only proper nouns/code/numbers, return it unchanged.
5. Keep HTML tags, placeholders, formatting and line breaks intact.
6. Violating any of these rules will cause the response to be rejected.`;
  system += `\n\nExample:\nInput: ["Hello", "GitHub"]\nOutput: ["你好", "GitHub"]`;
  return system;
}

/**
 * 构建批量翻译 User Prompt（仅输入数据与滑动窗口上下文）
 */
function buildBatchPrompt(groupTexts, groupSourceLang, groupTargetLang, context = null) {
  let prompt = '';
  // 批量翻译不注入页面级上下文（pageTitle / domain），避免整页文本被模型偏向为标题/描述。
  // 但注入上一批末尾的「原文+译文」作为滑动窗口，提升跨段指代与连贯性（明确标记勿重译）。
  if (context && context.prevContext && context.prevContext.source) {
    prompt += `Previous segment (for reference ONLY, do NOT re-translate or include in output):`;
    prompt += `\nSource: ${String(context.prevContext.source).slice(0, 300)}`;
    prompt += `\nTranslation: ${String(context.prevContext.translation || '').slice(0, 300)}\n\n`;
  }
  prompt += `Input:\n${JSON.stringify(groupTexts)}`;
  return prompt;
}

/**
 * 批量翻译逻辑 (JSON 数组) + 降级处理
 * 额外在 batch 内做文本去重：相同原文只请求一次，结果映射回所有出现位置
 */
async function translateBatchInternal(texts, sourceLang, targetLang, context = null, sessionId = null) {
  const batchStart = performance.now();
  const finalResults = new Array(texts.length);
  const missItems = [];

  // E: 语言检测去重 —— 以首条文本代表整批语言方向，避免对每句都调用 detectLanguage
  const batchSourceLang = sourceLang === 'auto'
    ? (resolveSourceLanguage(texts[0] || '', sourceLang))
    : sourceLang;

  // 同语种不再翻向对照语言：已是目标语言的文本在下方循环逐条跳过，避免中英互译混用
  const batchTargetLang = targetLang;

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
    // 同语言跳过：文本已是目标语言则原样返回，不调 API（避免把中文翻成英文等互译混用）
    if (isSameAsTargetLanguage(text, batchTargetLang)) {
      finalResults[i] = { text, cached: true, engine: 'same-lang', success: true };
      recordUsage(true, 1);
      continue;
    }
    const cacheKey = generateCacheKey(text, sourceLang, resolvedTargetLang);
    const cached = await getFromCache(cacheKey);
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
    let windowContext = null; // 该语言组的滑动窗口：上一批末尾原文+译文

    for (const batchItems of subBatches) {
      if (isSessionCancelled(sessionId)) { recordBatchMetric(batchStart, texts, finalResults); return finalResults; }
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
      const prompt = buildBatchPrompt(groupTexts, groupSourceLang, groupTargetLang, { prevContext: windowContext });
      // 方案 1：批量规则移入 system message，user message 只带输入数据
      const batchSystemPrompt = buildBatchSystemPrompt(groupTexts, groupSourceLang, groupTargetLang);

      // 发送请求并解析（先应用速率延迟）
      let jsonParsed = false;
      let batchOutput = [];
      let parseError = null;
      const batchLogStart = performance.now();
      // 方案 2：批次级 429 退避--限流时整批重试，不拆单句，避免请求放大
      let batch429Retries = 0;
      let needRetry429 = false;
      do {
        jsonParsed = false;
        batchOutput = [];
        parseError = null;
        needRetry429 = false;
        await applyRateDelay();
        // 出站并发闸门：批量请求以 LOW 优先级排队（让位划词/流式），同样受限速上限约束
        await apiConcurrencyGate.acquire(SW.SCHEDULER_PRIORITY.LOW);
        try {
          const { headers, body } = buildRequest(prompt, false, null, true, batchSystemPrompt, 0.1);
          const endpoint = getEndpoint();
          const timeout = resolveProviderConfig().provider === 'local' ? LOCAL_TIMEOUT_MS : (CLOUD_TIMEOUT_MS * 2);
          const controller = new AbortController();
          registerSessionController(sessionId, controller);
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
              // 方案 3：sanity check 区分回显 vs 合法同译
              const distinctOutputs = new Set(
                batchOutput.map(t => typeof t === 'string' ? t.trim() : '').filter(Boolean)
              );
              if (uniqueItems.length > 2 && distinctOutputs.size <= 1) {
                // 第一层：译文全部等于原文 -> 回显，判失败（模型未翻译）
                const allEcho = batchOutput.every((t, i) =>
                  typeof t === 'string' && t.trim() === groupTexts[i].trim()
                );
                if (allEcho) {
                  jsonParsed = false;
                  batchOutput = [];
                  parseError = '模型回显原文，未翻译';
                } else {
                  // 第二层：译文统一但不等于原文 -> 按源文长度判断
                  const avgSourceLen = groupTexts.reduce((s, t) => s + t.length, 0) / groupTexts.length;
                  if (avgSourceLen > 20) {
                    // 长文本统一译文：疑似模型上下文偏差，判失败
                    jsonParsed = false;
                    batchOutput = [];
                    parseError = '模型返回了重复译文，疑似上下文偏差';
                  } else {
                    // 短文本统一译文：合法近义词（如 Settings/Configuration/Preferences -> 设置），通过
                    jsonParsed = true;
                  }
                }
              } else {
                jsonParsed = true;
              }
            } else {
              parseError = `长度不匹配 (预期 ${groupTexts.length}, 实得 ${batchOutput.length})`;
            }
          } else {
            const isRateLimit = response.status === 429;
            updateRateLimitState(false, isRateLimit);
            // 方案 2：429 时批次级退避重试，不立即拆单句
            if (isRateLimit && batch429Retries < 2) {
              batch429Retries++;
              needRetry429 = true;
            } else {
              parseError = `HTTP ${response.status}`;
            }
          }
        } catch (e) {
          parseError = e.message;
          console.warn('[YuxTrans] Batch translation for group ' + groupTargetLang + ' parse error:', e);
        } finally {
          // 会话 abort / 网络出错 / 解析异常均经此处释放槽位，不泄漏
          apiConcurrencyGate.release();
        }
        // 429 退避：gate 已释放，sleep 期间不阻塞其他请求
        if (needRetry429 && !isSessionCancelled(sessionId)) {
          await new Promise(r => setTimeout(r, batch429Retries * 5000 + 5000));
        }
      } while (needRetry429 && !isSessionCancelled(sessionId));

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

        // 更新滑动窗口：取本批末尾有效项的原文+译文，供下一批参考（勿重译）
        for (let wi = groupTexts.length - 1; wi >= 0; wi--) {
          const wt = batchOutput[wi];
          if (groupTexts[wi] && wt && typeof wt === 'string' && wt.trim()) {
            windowContext = {
              source: String(groupTexts[wi]).slice(0, 300),
              translation: String(wt).trim().slice(0, 300)
            };
            break;
          }
        }

        const validOriginalCount = uniqueItems
          .filter((_, i) => !invalidUniqueIndices.includes(i))
          .reduce((sum, item, i) => sum + uniqueToOriginals[i].length, 0);
        const validTokens = uniqueItems
          .filter((_, i) => !invalidUniqueIndices.includes(i))
          .reduce((sum, item) => sum + (item.tokens || 0), 0);
        recordUsage(false, validOriginalCount, validTokens);

        updateRateLimitState(true);

        if (invalidUniqueIndices.length > 0) {
          if (isSessionCancelled(sessionId)) { recordBatchMetric(batchStart, texts, finalResults); return finalResults; }
          console.warn(`[YuxTrans] 批处理有 ${invalidUniqueIndices.length} 项无效结果，正在补全...`);
          const invalidItems = invalidUniqueIndices.map((i) => uniqueItems[i]);
          await fallbackBatchItems(invalidItems, sourceLang, context, finalResults, sessionId);
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

        if (isSessionCancelled(sessionId)) { recordBatchMetric(batchStart, texts, finalResults); return finalResults; }
        console.log(`[YuxTrans] 需要补全 ${needFallbackItems.length} 项...`);
        await fallbackBatchItems(needFallbackItems, sourceLang, context, finalResults, sessionId);
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
async function fallbackBatchItems(uniqueItems, sourceLang, context, finalResults, sessionId = null) {
  const { maxConcurrent, requestDelay } = getRateLimitParams();
  const chunks = [];
  for (let i = 0; i < uniqueItems.length; i += maxConcurrent) {
    chunks.push(uniqueItems.slice(i, i + maxConcurrent));
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    if (isSessionCancelled(sessionId)) break;
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
          // 批量补全属批次流量：LOW 优先级过闸门，让位划词/流式（原分片并发由全局闸门取代兜底）
          const res = await translate(uniqueItem.text, sourceLang, uniqueItem.resolvedTargetLang, context, { priority: SW.SCHEDULER_PRIORITY.LOW });
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
    if (chunkIndex < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, requestDelay !== undefined ? requestDelay : 500));
    }
  }
}

// ===== 连接测试 =====

async function testProviderConnection(testConfig) {
  const { provider, endpoint, model } = testConfig;
  // 前置校验：空 endpoint 直接返回结构化错误，不依赖 fetch 抛错兜底
  if (!endpoint || !String(endpoint).trim()) {
    return { success: false, error: '请先填写接口地址（Endpoint）' };
  }
  // 表单不回显明文 Key：未携带 apiKey 时回退到已保存的同供应商档案 Key
  const apiKey = testConfig.apiKey || getStoredApiKeyForProvider(provider);

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
  const { provider, endpoint } = testConfig;
  // 表单不回显明文 Key：未携带 apiKey 时回退到已保存的同供应商档案 Key
  const apiKey = testConfig.apiKey || getStoredApiKeyForProvider(provider);

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
      const models = data.models.map(m => m.name || m.model).sort();
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
// 共享初始化 Promise：SW 冷启动时并发消息只触发一次 loadConfig/loadCacheFromDB；
// 失败后重置为 null，允许后续调用重试（避免永久卡在 rejected 状态）
let initPromise = null;

function ensureInitialized() {
  if (initialized) return Promise.resolve();
  if (!initPromise) {
    initPromise = doInitialize().finally(() => { initPromise = null; });
  }
  return initPromise;
}

async function doInitialize() {
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
  // 安全校验：仅处理本扩展（content script / popup / options）发出的消息，
  // 拒绝其他扩展或网页经 externally_connectable 等途径发来的外部消息
  if (!sender || sender.id !== chrome.runtime.id) {
    try { sendResponse({ success: false, error: 'Forbidden: external sender' }); } catch (e) { /* 消息通道可能已关闭 */ }
    return false;
  }

  const respondOnce = (payload) => {
    try { sendResponse(payload); } catch (e) { /* 消息通道可能已关闭 */ }
  };

  // #4 浮窗串台修复：content 按 requestId 把响应路由回对应浮窗，SW 需原样回传
  const withRequestId = (payload) => ({ ...payload, requestId: request.requestId || null });

  ensureInitialized().then(() => {
    const tabId = sender.tab?.id || null;

    // 表驱动消息分发：每个 action 对应一个处理器方法（分支体逐字搬移，仅重新缩进）
    const messageHandlers = {
      translate({ request, sendResponse, withRequestId }) {
        const sourceLang = request.sourceLang || config.sourceLang || 'auto';
        const targetLang = request.targetLang || config.targetLang || 'zh';
        const context = request.context || null;

        translate(request.text, sourceLang, targetLang, context)
          .then(result => sendResponse(withRequestId({ success: true, ...result })))
          .catch(error => sendResponse(withRequestId(failResponse(error))));
        return;
      },

      translateStream({ request, sendResponse, tabId, withRequestId }) {
        // 整页取消后不再发起新的流式请求（与 translateBatchInternal 的会话检查对齐）
        if (isSessionCancelled(request.sessionId || null)) {
          sendResponse(withRequestId(failResponse(new Error('翻译已取消'))));
          return;
        }
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
          sendResponse(withRequestId({ success: true, text: glossaryHit, cached: true, engine: 'glossary' }));
          return;
        }

        // 先查缓存（Q3：异步——内存未命中时回查 IndexedDB 冷数据）
        getFromCache(cacheKey).then(async (cached) => {
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
            // 方案 6：伪流式回放--缓存命中时将完整译文切块推送，保持与真流式一致的视觉反馈
            const reqId = request.requestId || null;
            const chunks = cached.match(/[\s\S]{1,8}/g) || [cached];
            for (let i = 0; i < chunks.length; i++) {
              const partial = chunks.slice(0, i + 1).join('');
              if (tabId) {
                chrome.tabs.sendMessage(tabId, {
                  action: 'streamChunk', requestId: reqId, chunk: chunks[i], fullText: partial
                }).catch(() => { /* tab 可能已关闭 */ });
              } else {
                chrome.runtime.sendMessage({
                  action: 'streamChunk', requestId: reqId, chunk: chunks[i], fullText: partial
                }).catch(() => { /* popup 可能未打开 */ });
              }
              if (i < chunks.length - 1) {
                await new Promise(r => setTimeout(r, 15));
              }
            }
            sendResponse(withRequestId({ success: true, text: cached, cached: true, engine: 'cache' }));
            return;
          }

          try {
            assertOfflineAllowed(false);
          } catch (offlineErr) {
            sendResponse(withRequestId(failResponse(offlineErr)));
            return;
          }

          translateWithStream(request.text, resolvedSourceLang, targetLang, tabId, {
            context, providerOverride: null, requestId: request.requestId || null, sessionId: request.sessionId || null,
            // 整页流式（带会话）按批次流量 LOW 排队；划词/弹窗流式 HIGH 优先过闸门
            priority: request.sessionId ? SW.SCHEDULER_PRIORITY.LOW : SW.SCHEDULER_PRIORITY.HIGH
          })
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
              sendResponse(withRequestId({ success: true, text: fullText, cached: false, engine: resolveProviderConfig().provider }));
            })
            .catch(async (error) => {
              // 流式失败时，尝试非流式故障转移（用户仍可在弹窗看到最终结果）
              if (config.autoFallback && !config.offlineMode) {
                try {
                  const result = await translate(request.text, sourceLang, targetLang, context);
                  sendResponse(withRequestId({ success: true, ...result }));
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
              sendResponse(withRequestId(failResponse(error)));
            });
        }).catch((error) => sendResponse(withRequestId(failResponse(error))));
        return;
      },

      translateBatch({ request, sendResponse }) {
        const sourceLang = request.sourceLang || config.sourceLang || 'auto';
        // 目标语言由 translateBatchInternal 内部为每个文本单独 resolveTargetLanguage
        // 确保缓存键与 translate() 函数一致
        const targetLang = request.targetLang || config.targetLang || 'zh';
        const context = request.context || null;

        translateBatchInternal(request.texts, sourceLang, targetLang, context, request.sessionId || null)
          .then(results => sendResponse({ success: true, results }))
          .catch(error => sendResponse(failResponse(error)));
        return;
      },

      lookupWord({ request, sendResponse, withRequestId }) {
        // F2：单词词典查询--结构化词典卡片（音标/义项/例句）
        const sourceLang = request.sourceLang || config.sourceLang || 'auto';
        const targetLang = request.targetLang || config.targetLang || 'zh';
        lookupWord(request.text, sourceLang, targetLang)
          .then(result => sendResponse(withRequestId({ success: true, ...result })))
          .catch(error => sendResponse(withRequestId(failResponse(error))));
        return;
      },

      translateWithProfile({ request, sendResponse }) {
        // F4b：双档案对照--用指定 profileId 翻译同一文本，结果在对照浮窗展示
        const sourceLang = request.sourceLang || config.sourceLang || 'auto';
        const targetLang = request.targetLang || config.targetLang || 'zh';
        const context = request.context || null;
        const profileId = request.profileId || '';
        const profile = (config.profiles || []).find((p) => p.id === profileId);
        if (!profile) {
          sendResponse({ success: false, error: '对照档案不存在' });
          return;
        }
        const override = {
          provider: profile.provider,
          apiKey: profile.apiKey,
          apiEndpoint: profile.apiEndpoint,
          model: profile.model,
          localModel: profile.localModel,
          customProvider: profile.customProvider || { name: '', endpoint: '', apiKey: '', format: 'openai', model: '' }
        };
        translateWithCloud(request.text, sourceLang, targetLang, context, override)
          .then((text) => sendResponse({ success: true, text, engine: profile.provider }))
          .catch((error) => sendResponse(failResponse(error)));
        return;
      },

      cancelTranslate({ request, sendResponse }) {
        // 用户停止整页/动态翻译：abort 在途请求并阻止后续批次，避免继续消耗配额
        const aborted = cancelTranslationSession(request.sessionId || null);
        sendResponse({ success: true, aborted });
        return;
      },

      getConfig({ sendResponse }) {
        // 脱敏响应：profiles 不含明文 apiKey，仅提供 hasApiKey 标志
        sendResponse({ ...buildSanitizedConfig(), batchConfig: getBatchConfig() });
      },

      getProviderDefaults({ sendResponse }) {
        sendResponse({
          success: true,
          endpoints: API_ENDPOINTS,
          models: DEFAULT_MODELS,
          stylePrompts: { ...(STYLE_PROMPTS || {}) },
          styleIds: SW.STYLE_IDS || ['normal', 'academic', 'technical', 'literary']
        });
      },

      setConfig({ request, sendResponse }) {
        const payload = { ...(request.config || {}) };
        // 规范化用户风格提示词，避免脏键/超长写入
        if (Object.prototype.hasOwnProperty.call(payload, 'stylePrompts')) {
          payload.stylePrompts = SW.sanitizeStylePrompts
            ? SW.sanitizeStylePrompts(payload.stylePrompts)
            : (payload.stylePrompts || {});
        }
        saveConfig(payload)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return;
      },

      reportBadTranslation({ request, sendResponse }) {
        reportBadTranslation(request)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse(failResponse(error)));
        return;
      },

      disableSite({ request, sendResponse }) {
        disableSiteForHostname(request.hostname || request.host)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse(failResponse(error)));
        return;
      },

      setSiteBilingualMode({ request, sendResponse }) {
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
      },

      importGlossary({ request, sendResponse }) {
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
      },

      clearGlossary({ sendResponse }) {
        saveConfig({ glossary: [] })
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse(failResponse(error)));
        return;
      },

      fetchModels({ request, sendResponse }) {
        fetchModels(request.config)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return;
      },

      testProviderConnection({ request, sendResponse }) {
        testProviderConnection(request.config)
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return;
      },

      checkConnection({ sendResponse }) {
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
      },

      clearCache({ sendResponse }) {
        cache.clear();
        cacheBytes = 0;
        totalCacheCount = 0;
        totalCacheBytes = 0;
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
      },

      getCacheStats({ sendResponse }) {
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
      },

      getMetrics({ request, sendResponse }) {
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
      },

      getRequestLogs({ request, sendResponse }) {
        sendResponse({
          success: true,
          logs: getRequestLogs(request.limit)
        });
        return;
      },

      // ===== ProviderProfile 管理接口 =====
      getProfiles({ sendResponse }) {
        // 与 getConfig 一致脱敏，列表展示仅需非敏感字段
        sendResponse({
          success: true,
          profiles: (config.profiles || []).map(sanitizeProfileForClient),
          activeProfileId: config.activeProfileId
        });
      },

      saveProfile({ request, sendResponse }) {
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
      },

      deleteProfile({ request, sendResponse }) {
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
      },

      setActiveProfile({ request, sendResponse }) {
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

    };

    const ctx = { request, sender, sendResponse, tabId, withRequestId };
    const handler = messageHandlers[request.action];
    if (handler) handler(ctx);
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
const VERSION_CHECK_ALARM = 'yxt-version-check';
const VERSION_CHECK_PERIOD_MINUTES = 12 * 60; // 12 小时

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
  // 剥离预发布后缀（如 0.6.0-beta.1），避免 Number('0-beta') 得 NaN 导致误判
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    if (l[i] > (c[i] || 0)) return true;
    if (l[i] < (c[i] || 0)) return false;
  }
  return false;
}

// 定时检查更新走 chrome.alarms：SW 休眠后 setInterval 会消失，alarms 到点会唤醒 SW
// （测试环境可能没有 chrome.alarms，加守卫）
if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === VERSION_CHECK_ALARM) {
      ensureInitialized().then(() => checkNewVersion());
    }
  });
}

// 启动时加载配置
ensureInitialized().then(() => {
  checkNewVersion(); // 启动后立即检查一次
  if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.create) {
    chrome.alarms.create(VERSION_CHECK_ALARM, { periodInMinutes: VERSION_CHECK_PERIOD_MINUTES });
  }
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
    ensureInitialized,
    // 测试钩子：重置初始化状态，模拟 SW 冷启动
    __resetInitForTest() { initialized = false; initPromise = null; },
    isSessionCancelled,
    cancelTranslationSession,
    getTranslationSession,
    registerSessionController,
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
    isSameAsTargetLanguage,
    isProviderAvailable,
    isNoConfigProvider,
    translateWithCloud,
    translateWithStream,
    apiConcurrencyGate,
    splitIntoCharBatches,
    // 以下仅为测试可测性追加的导出，不改变任何业务逻辑
    validateCacheEntry,
    getFromCache,
    setToCache,
    loadCacheFromDB,
    __cacheInternals: () => ({ size: cache.size, cacheBytes, totalCacheCount, totalCacheBytes }),
    translateBatchInternal,
    updateRateLimitState,
    tryRecoverRateLimit,
    getRateLimitParams,
    rateLimitState,
    RATE_LIMIT_CONFIG,
    buildBatchPrompt,
    buildBatchSystemPrompt,
    buildTranslationPrompt,
    buildDictionaryPrompt,
    lookupWord,
    parseDictionaryResult,
    googleTranslate,
    resolveProviderConfig,
    getActiveProfile,
    addOrUpdateProfile,
    removeProfile,
    makeProfileId,
    sanitizeProfileForClient,
    buildSanitizedConfig,
    getStoredApiKeyForProvider,
    estimateTokens,
    ProductHelpers,
    SW,
    // 便于测试直接调用 helpers / SW modules
    ...ProductHelpers,
    isKnownMessageAction: SW.isKnownMessageAction,
    classifyMessageAction: SW.classifyMessageAction
  };
}