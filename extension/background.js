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
  qwen: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-max-longcontext'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  deepseek: ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4-pro'],
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V2.5'],
  local: []
};

function getDefaultModel(provider) {
  const models = DEFAULT_MODELS[provider];
  return Array.isArray(models) && models.length > 0 ? models[0] : '';
}

const STYLE_PROMPTS = {
  normal: '',
  academic: 'Use an academic and formal style with precise terminology.',
  technical: 'Preserve technical accuracy, keep technical terms and code references intact.',
  literary: 'Use literary elegance and artistic expression.'
};

// 语言代码 → 自然语言名称（用于 Prompt）
// 使用无原型对象防止 __proto__ 等键名污染
const LANG_NAMES = Object.assign(Object.create(null), {
  'zh': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
  'en': 'English', 'ja': 'Japanese', 'ko': 'Korean',
  'fr': 'French', 'de': 'German', 'es': 'Spanish',
  'ru': 'Russian', 'pt': 'Portuguese', 'it': 'Italian',
  'ar': 'Arabic', 'th': 'Thai', 'vi': 'Vietnamese'
});

// 友好错误提示映射
const ERROR_MESSAGES = {
  401: 'API Key 无效或已过期，请在设置中检查',
  403: '无权限访问该模型，请确认 API Key 权限',
  429: '请求过于频繁，请稍后再试',
  500: '服务器内部错误，请稍后重试',
  502: '网关错误，请检查网络连接',
  503: '服务暂时不可用，请稍后重试',
  504: '请求超时，请检查网络或更换模型',
  RATE_LIMITED: '请求过于频繁，正在自动降速...'
};

// 请求超时时间（毫秒）
const CLOUD_TIMEOUT_MS = 30000;
const LOCAL_TIMEOUT_MS = 120000;
const REQUEST_TIMEOUT_MS = 30000;

// 批量翻译单批最大字符数（避免超出模型上下文或导致响应过长）
const MAX_BATCH_CHARS = 4000;

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
      if (rateLimitState.isRateLimited &&
          Date.now() - rateLimitState.lastRateLimitTime > RATE_LIMIT_CONFIG.RATE_LIMIT_COOLDOWN) {
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
      }
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
    if (rateLimitState.isRateLimited &&
        rateLimitState.consecutiveSuccess >= RATE_LIMIT_CONFIG.SUCCESS_TO_RECOVER &&
        Date.now() - rateLimitState.lastRateLimitTime > RATE_LIMIT_CONFIG.RATE_LIMIT_COOLDOWN) {
      // 开始恢复
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
  enableStreaming: true
};

let cache = new Map();
let cacheOrder = [];
let cacheStats = { wordCount: 0, sizeBytes: 0 };
let db = null;

let usageStats = { totalCount: 0, cacheHits: 0, totalTokens: 0 };

// 连接状态轻量缓存，避免 popup 每次打开都发起真实 API 探测
let connectionCache = { profileId: '', timestamp: 0, result: null };
const CONNECTION_CACHE_TTL = 15000;

async function loadUsageStats() {
  const stored = await chrome.storage.local.get('usageStats');
  if (stored.usageStats) usageStats = stored.usageStats;
  // 兼容旧格式：若缺少 totalTokens 字段则补零
  if (typeof usageStats.totalTokens !== 'number') usageStats.totalTokens = 0;
}

function estimateTokens(text) {
  if (!text) return 0;
  // 轻量估算：英文约 1 token / 4 字符，中文约 1 token / 1.5 字符；取折中
  return Math.ceil(text.length / 3);
}

function recordUsage(isCacheHit, count = 1, tokens = 0) {
  usageStats.totalCount += count;
  usageStats.totalTokens += tokens;
  if (isCacheHit) usageStats.cacheHits += count;
  // 简易防抖保存
  chrome.storage.local.set({ usageStats });
}

// ===== IndexedDB（带重连机制） =====

const DB_NAME = 'YuxTransDB';
const DB_VERSION = 2;
const CACHE_STORE = 'translations';
const MODELS_STORE = 'models';

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
      // v2: 新增模型管理 objectStore
      if (!database.objectStoreNames.contains(MODELS_STORE)) {
        database.createObjectStore(MODELS_STORE, { keyPath: 'id' });
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

function normalizeCacheKeyText(text) {
  if (!text) return '';
  return text
    .normalize('NFC')                       // Unicode 组合字符归一化
    .replace(/[\u200B-\u200F\uFEFF]/g, '')   // 去除零宽字符
    .replace(/[\u2018\u2019\u2032]/g, "'")  // 左/右单引号、撇号统一为 '
    .replace(/[\u201C\u201D\u2033]/g, '"')  // 左/右双引号统一为 "
    .replace(/[\u2013\u2014]/g, '-')         // en/em dash 统一为 -
    .replace(/\u2026/g, '...')               // 省略号统一为 ...
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角 ASCII 转半角
    .replace(/\s+/g, ' ')                   // 折叠连续空白
    .trim();
}

function generateCacheKey(text, sourceLang, targetLang, style = null) {
  const resolvedStyle = style || config.translateStyle || 'normal';
  return `${sourceLang}:${targetLang}:${resolvedStyle}:${normalizeCacheKeyText(text)}`;
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

function makeProfileId(provider, model, localModel) {
  const modelPart = model || localModel || 'default';
  return `${provider}:${modelPart}`;
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
function supportsJsonMode(provider) {
  return ['openai', 'qwen', 'deepseek', 'groq', 'moonshot', 'siliconflow'].includes(provider);
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
 * @param {string} text - 待翻译文本
 * @param {string} sourceLang - 源语言
 * @param {string} targetLang - 目标语言
 * @param {object|null} context - 页面上下文
 * @param {object|null} providerOverride - 可选：指定使用的供应商配置，默认使用全局 config
 */
async function translateWithCloud(text, sourceLang = 'auto', targetLang = 'zh', context = null, providerOverride = null) {
  // 网络检测
  if (!navigator.onLine) {
    throw new Error('网络已断开，请检查网络连接后重试');
  }

  const p = resolveProviderConfig(providerOverride);
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
async function translateWithStream(text, sourceLang, targetLang, tabId, context = null, providerOverride = null, requestId = null) {
  if (!navigator.onLine) {
    throw new Error('网络已断开，请检查网络连接后重试');
  }

  const p = resolveProviderConfig(providerOverride);
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
const SCRIPT_RANGES = {
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
 * 基于 Unicode 脚本分布检测文本语言
 * 返回最可能的 ISO-639-1 语言代码，无法判断时返回 'unknown'
 */
function detectLanguage(text) {
  if (!text || text.trim().length === 0) return 'unknown';

  const sample = text.slice(0, 500); // 只检测前 500 字符，足够且轻量
  const scores = {
    zh: 0, ja: 0, ko: 0, en: 0, ru: 0, ar: 0, th: 0, vi: 0, other: 0
  };

  for (const char of sample) {
    if (SCRIPT_RANGES.han.test(char)) scores.zh++;
    else if (SCRIPT_RANGES.hiragana.test(char) || SCRIPT_RANGES.katakana.test(char)) scores.ja++;
    else if (SCRIPT_RANGES.hangul.test(char)) scores.ko++;
    else if (SCRIPT_RANGES.cyrillic.test(char)) scores.ru++;
    else if (SCRIPT_RANGES.arabic.test(char)) scores.ar++;
    else if (SCRIPT_RANGES.thai.test(char)) scores.th++;
    else if (SCRIPT_RANGES.latin.test(char)) {
      scores.en++;
      if (SCRIPT_RANGES.vietnamese.test(char)) scores.vi++;
    }
  }

  // 日文判定：假名 + 少量汉字；纯汉字优先判中文
  if (scores.ja > 0 && (scores.zh === 0 || scores.ja >= scores.zh * 0.3)) return 'ja';
  if (scores.zh > 0) return 'zh';
  if (scores.ko > 0) return 'ko';
  if (scores.ru > 0) return 'ru';
  if (scores.ar > 0) return 'ar';
  if (scores.th > 0) return 'th';
  if (scores.en > 0) return scores.vi > scores.en * 0.15 ? 'vi' : 'en';

  return 'unknown';
}

/**
 * 根据检测到的源语言，决定实际目标语言
 * 核心规则：避免「同语种互译」，自动翻向常用对照语种
 */
function resolveTargetLanguage(text, sourceLang, targetLang) {
  if (!config.autoDetectLang || sourceLang !== 'auto') {
    return targetLang;
  }

  const detected = detectLanguage(text);
  if (detected === 'unknown') {
    return targetLang;
  }

  // 如果源语言已经等于目标语言，翻向常用对照语言
  const normalizedTarget = targetLang.startsWith('zh') ? 'zh' : targetLang;
  if (detected === normalizedTarget) {
    const oppositeMap = {
      zh: 'en',
      ja: 'zh',
      ko: 'zh',
      en: 'zh',
      ru: 'en',
      ar: 'en',
      th: 'en',
      vi: 'en'
    };
    return oppositeMap[detected] || 'en';
  }

  return targetLang;
}

/**
 * 当 sourceLang 为 auto 时，返回检测到的源语言代码
 */
function resolveSourceLanguage(text, sourceLang) {
  if (sourceLang !== 'auto') return sourceLang;
  const detected = detectLanguage(text);
  return detected === 'unknown' ? 'auto' : detected;
}

// ===== 翻译入口 =====

/**
 * 判断某个供应商配置是否可用（本地只需 endpoint，云端需要 API Key）
 */
function isProviderAvailable(providerConfig) {
  const p = providerConfig;
  if (p.provider === 'local') return true;
  if (p.provider === 'custom') return !!(p.customProvider?.endpoint && p.customProvider?.apiKey);
  return !!(p.apiKey || p.customProvider?.apiKey);
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
  targetLang = resolveTargetLanguage(text, sourceLang, targetLang);
  const resolvedSourceLang = resolveSourceLanguage(text, sourceLang);

  const cacheKey = generateCacheKey(text, sourceLang, targetLang);

  const cached = getFromCache(cacheKey);
  if (cached) {
    recordUsage(true, 1);
    return { text: cached, cached: true, engine: 'cache' };
  }

  const tokens = estimateTokens(text);
  const activeProvider = resolveProviderConfig().provider;
  try {
    const translated = await translateWithCloud(text, resolvedSourceLang, targetLang, context);
    await setToCache(cacheKey, translated);
    recordUsage(false, 1, tokens);
    return { text: translated, cached: false, engine: activeProvider };
  } catch (error) {
    // 自动故障转移
    if (config.autoFallback) {
      const fallback = buildFallbackProvider();
      if (fallback && isProviderAvailable(fallback) && fallback.provider !== activeProvider) {
        console.warn(`[YuxTrans] 主供应商 ${activeProvider} 失败，尝试 ${fallback.provider}:`, error.message);
        try {
          const translated = await translateWithCloud(text, resolvedSourceLang, targetLang, context, fallback);
          await setToCache(cacheKey, translated);
          recordUsage(false, 1, tokens);
          return { text: translated, cached: false, engine: fallback.provider };
        } catch (fallbackError) {
          console.error('[YuxTrans] 故障转移失败:', fallbackError);
        }
      }
    }
    console.error('[YuxTrans] 翻译错误:', error);
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

  prompt += `\nRULES:
1. Return ONLY a valid JSON array of strings (same length ${groupTexts.length}, same order).
2. Keep HTML tags, placeholders, formatting and line breaks intact.
3. No explanations or markdown wrappers.`;

  if (context && context.pageTitle) {
    prompt += `\nPage context: "${context.pageTitle}"`;
  }
  if (context && context.pageUrl) {
    try {
      const domain = new URL(context.pageUrl).hostname;
      prompt += ` (${domain})`;
    } catch (e) { /* ignore invalid URL */ }
  }

  prompt += `\n\nInput:\n${JSON.stringify(groupTexts)}`;
  return prompt;
}

/**
 * 批量翻译逻辑 (JSON 数组) + 降级处理
 * 额外在 batch 内做文本去重：相同原文只请求一次，结果映射回所有出现位置
 */
async function translateBatchInternal(texts, sourceLang, targetLang, context = null) {
  const finalResults = new Array(texts.length);
  const missItems = [];

  // 1. 筛出未命中的项 - 每个文本单独 resolve 源/目标语言
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const resolvedTargetLang = resolveTargetLanguage(text, sourceLang, targetLang);
    const resolvedSourceLang = resolveSourceLanguage(text, sourceLang);
    const cacheKey = generateCacheKey(text, sourceLang, resolvedTargetLang);
    const cached = getFromCache(cacheKey);
    if (cached) {
      finalResults[i] = { text: cached, cached: true, engine: 'cache', success: true };
      recordUsage(true, 1);
    } else {
      missItems.push({ text, resolvedTargetLang, resolvedSourceLang, tokens: estimateTokens(text), originalIndex: i });
    }
  }

  // 2. 如果全命中缓存，直接返回
  if (missItems.length === 0) {
    return finalResults;
  }

  // 3. 按 (源语言, 目标语言) 分组，让 batch prompt 更精确
  const langGroups = new Map();
  missItems.forEach((item) => {
    const groupKey = `${item.resolvedSourceLang}:${item.resolvedTargetLang}`;
    const group = langGroups.get(groupKey) || [];
    group.push(item);
    langGroups.set(groupKey, group);
  });

  // 4. 为每个语言组按字符数切分子批次，再分别调用批处理
  for (const [groupKey, groupItems] of langGroups) {
    const [groupSourceLang, groupTargetLang] = groupKey.split(':');
    const subBatches = splitIntoCharBatches(groupItems, MAX_BATCH_CHARS);

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
      await applyRateDelay();
      try {
        const { headers, body } = buildRequest(prompt, false, null, true);
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
            jsonParsed = true;
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

  return finalResults;
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
    await loadRateLimitState();
    initialized = true;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await loadUsageStats();
  await loadRateLimitState();
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
  Promise.all([loadConfig(), loadUsageStats(), loadRateLimitState()]).then(() => { initialized = true; });
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
      const resolvedSourceLang = resolveSourceLanguage(request.text, sourceLang);

      const context = request.context || null;
      const cacheKey = generateCacheKey(request.text, sourceLang, targetLang);
      const streamTokens = estimateTokens(request.text);

      // 先查缓存
      const cached = getFromCache(cacheKey);
      if (cached) {
        recordUsage(true, 1);
        sendResponse({ success: true, text: cached, cached: true, engine: 'cache' });
        return;
      }

      translateWithStream(request.text, resolvedSourceLang, targetLang, tabId, context, null, request.requestId || null)
        .then(async (fullText) => {
          await setToCache(cacheKey, fullText);
          recordUsage(false, 1, streamTokens);
          sendResponse({ success: true, text: fullText, cached: false, engine: resolveProviderConfig().provider });
        })
        .catch(async (error) => {
          // 流式失败时，尝试非流式故障转移（用户仍可在弹窗看到最终结果）
          if (config.autoFallback) {
            try {
              const result = await translate(request.text, sourceLang, targetLang, context);
              sendResponse({ success: true, ...result });
              return;
            } catch (fallbackError) {
              console.error('[YuxTrans] 流式故障转移失败:', fallbackError);
            }
          }
          sendResponse({ success: false, error: error.message });
        });
    }

    else if (request.action === 'translateBatch') {
      const sourceLang = request.sourceLang || config.sourceLang || 'auto';
      // 目标语言由 translateBatchInternal 内部为每个文本单独 resolveTargetLanguage
      // 确保缓存键与 translate() 函数一致
      const targetLang = request.targetLang || config.targetLang || 'zh';
      const context = request.context || null;

      translateBatchInternal(request.texts, sourceLang, targetLang, context)
        .then(results => sendResponse({ success: true, results }))
        .catch(error => sendResponse({ success: false, error: error.message }));
    }

    else if (request.action === 'getConfig') {
      sendResponse(config);
    }

    else if (request.action === 'getProviderDefaults') {
      sendResponse({ success: true, endpoints: API_ENDPOINTS, models: DEFAULT_MODELS });
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
      cacheOrder = [];
      cacheStats = { wordCount: 0, sizeBytes: 0 };
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

    else if (request.action === 'updateActiveModels') {
      config.activeModels = request.models || [];
      // 同时写入 IndexedDB 和 chrome.storage.sync
      saveModelsToDB(config.activeModels);
      saveConfig(config).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    }

    else if (request.action === 'getActiveModels') {
      // 优先从 IndexedDB 读取，回退到 config
      loadModelsFromDB().then(models => {
        if (models.length > 0) {
          sendResponse({ success: true, models });
        } else {
          sendResponse({ success: true, models: config.activeModels || [] });
        }
      });
      return true; // 保持消息通道打开（异步响应）
    }

    // 保存服务商配置到 profiles（旧 action，保留兼容）
    else if (request.action === 'saveProviderConfig') {
      const record = request.record;
      if (!record || !record.provider) {
        sendResponse({ success: false, error: '无效的配置记录' });
        return;
      }
      const profileId = addOrUpdateProfile(record);
      config.activeProfileId = profileId;
      // 保持旧版 IndexedDB 同步
      saveProviderRecord({ ...record, id: profileId });
      saveConfig(config)
        .then(() => sendResponse({ success: true, activeProfileId: profileId }))
        .catch(e => sendResponse({ success: false, error: e.message }));
    }

    // 获取所有服务商配置记录（优先返回 profiles，回退 IndexedDB）
    else if (request.action === 'getModelRecords') {
      if (config.profiles && config.profiles.length > 0) {
        sendResponse({ success: true, records: config.profiles });
        return;
      }
      loadProviderRecords().then(records => {
        sendResponse({ success: true, records });
      }).catch(e => sendResponse({ success: false, error: e.message }));
      return true; // 异步响应
    }

    // 移除指定服务商配置记录
    else if (request.action === 'removeModelRecord') {
      const recordId = request.recordId;
      if (!recordId) {
        sendResponse({ success: false, error: '缺少记录 ID' });
        return;
      }
      removeProfile(recordId);
      removeProviderRecord(recordId).then(() => {
        saveConfig(config).then(() => sendResponse({ success: true }));
      }).catch(e => sendResponse({ success: false, error: e.message }));
    }

    // ===== 新版 ProviderProfile 管理接口 =====
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
    }

    else {
      sendResponse({ success: false, error: `未知 action: ${request.action}` });
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

// 为 Node 测试导出核心函数（Service Worker 中 module 未定义，不会执行）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getDefaultModel,
    getEndpoint,
    getApiKey,
    getModel,
    getFormat,
    buildRequest,
    supportsJsonMode,
    generateCacheKey,
    formatError,
    detectLanguage,
    resolveTargetLanguage,
    resolveSourceLanguage,
    isProviderAvailable,
    splitIntoCharBatches,
    buildBatchPrompt,
    resolveProviderConfig,
    getActiveProfile,
    addOrUpdateProfile,
    removeProfile,
    makeProfileId
  };
}