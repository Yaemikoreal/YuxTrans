/**
 * SW 常量：端点、默认模型、语言名、错误文案等
 * 依赖：bootstrap.js → YuxTransSW
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  SW.API_ENDPOINTS = {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    moonshot: 'https://api.moonshot.cn/v1/chat/completions',
    siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
    // F7：谷歌免费翻译接口（无需 API Key，非 OpenAI 格式，走专门请求路径）
    google: 'https://translate.googleapis.com/translate_a/single',
    local: 'http://localhost:11434/api/chat'
  };

  SW.DEFAULT_MODELS = {
    qwen: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-max-longcontext'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    deepseek: ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    siliconflow: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V2.5'],
    google: [],
    local: []
  };

  SW.STYLE_PROMPTS = {
    normal: '',
    academic: 'Use an academic and formal style with precise terminology.',
    technical: 'Preserve technical accuracy, keep technical terms and code references intact.',
    literary: 'Use literary elegance and artistic expression.'
  };

  SW.LANG_NAMES = Object.assign(Object.create(null), {
    zh: 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    ru: 'Russian',
    pt: 'Portuguese',
    it: 'Italian',
    ar: 'Arabic',
    th: 'Thai',
    vi: 'Vietnamese'
  });

  SW.ERROR_MESSAGES = {
    401: 'API Key 无效或已过期，请在设置中检查',
    403: '无权限访问该模型，请确认 API Key 权限',
    429: '请求过于频繁，请稍后再试',
    500: '服务器内部错误，请稍后重试',
    502: '网关错误，请检查网络连接',
    503: '服务暂时不可用，请稍后重试',
    504: '请求超时，请检查网络或更换模型',
    RATE_LIMITED: '请求过于频繁，正在自动降速...'
  };

  SW.CLOUD_TIMEOUT_MS = 30000;
  SW.LOCAL_TIMEOUT_MS = 120000;
  SW.REQUEST_TIMEOUT_MS = 30000;
  SW.MAX_BATCH_CHARS = 4000;
  SW.DEFAULT_BATCH_SIZE = 20;
  // Prompt 规则版本：STRICT OUTPUT RULES / 上下文注入等 prompt 结构变更时 bump，
  // 配合 CACHE_KEY_VERSION 让旧缓存自动失效，避免译文错配。
  SW.PROMPT_VERSION = 'p1';
  // v3：键内编入 promptVersion + model，术语表/模型/prompt 变更后旧缓存不再误命中。
  SW.CACHE_KEY_VERSION = 'v3';

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SW;
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
