/**
 * YuxTrans 产品逻辑纯函数（可测、无 DOM / chrome API 依赖）
 * 供 Service Worker、content script 与 Node 单元测试共用
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.YuxTransHelpers = api;
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 解析划词触发模式动作
   * @param {string} triggerMode - auto | icon | contextMenu
   * @returns {'auto'|'icon'|'contextMenu'}
   */
  function resolveTriggerAction(triggerMode) {
    const mode = (triggerMode || 'auto').toLowerCase();
    if (mode === 'icon' || mode === 'contextmenu' || mode === 'context_menu') {
      return mode === 'icon' ? 'icon' : 'contextMenu';
    }
    if (mode === 'context' || mode === 'menu') return 'contextMenu';
    return 'auto';
  }

  /**
   * 是否应显示悬浮翻译按钮
   * @param {string} triggerMode
   * @returns {boolean}
   */
  function shouldShowFloatButton(triggerMode) {
    return resolveTriggerAction(triggerMode) === 'icon';
  }

  /**
   * 选中后是否直接发起翻译
   * @param {string} triggerMode
   * @returns {boolean}
   */
  function shouldAutoTranslateOnSelect(triggerMode) {
    return resolveTriggerAction(triggerMode) === 'auto';
  }

  /**
   * 是否使用流式翻译通道
   * @param {boolean|undefined} enableStreaming
   * @returns {boolean}
   */
  function shouldUseStreaming(enableStreaming) {
    return enableStreaming !== false;
  }

  /**
   * 选择翻译消息 action
   * @param {boolean|undefined} enableStreaming
   * @returns {'translateStream'|'translate'}
   */
  function resolveTranslateAction(enableStreaming) {
    return shouldUseStreaming(enableStreaming) ? 'translateStream' : 'translate';
  }

  /**
   * 构建面向用户的结构化错误
   * @param {string|number|Error|object} input
   * @param {object} [opts]
   * @returns {{ code: string, userMessage: string, actionHint: string, debugMessage: string }}
   */
  function buildUserError(input, opts = {}) {
    const provider = opts.provider || '';
    let code = 'UNKNOWN';
    let debugMessage = '';
    let status = null;

    if (input && typeof input === 'object' && !(input instanceof Error)) {
      if (input.code) code = String(input.code).toUpperCase();
      debugMessage = input.debugMessage || input.message || input.error || '';
      if (input.status != null) status = Number(input.status);
    } else if (input instanceof Error) {
      debugMessage = input.message || String(input);
    } else if (typeof input === 'number') {
      status = input;
      debugMessage = opts.debugMessage || String(input);
    } else {
      debugMessage = String(input || '');
    }

    const lower = debugMessage.toLowerCase();

    if (status === 401 || status === 403 || /api key|unauthorized|forbidden|鉴权|密钥/.test(lower)) {
      code = 'AUTH';
    } else if (status === 429 || /rate limit|too many|限流|过于频繁/.test(lower)) {
      code = 'RATE_LIMIT';
    } else if (status === 408 || status === 504 || /timeout|timed out|超时/.test(lower)) {
      code = 'TIMEOUT';
    } else if (/offline mode|离线模式/.test(lower)) {
      code = 'OFFLINE';
    } else if (
      provider === 'local' ||
      /ollama|econnrefused|localhost:11434|failed to fetch|networkerror|network request failed|网络/.test(lower)
    ) {
      if (/ollama|11434|local model|本地模型/.test(lower) || provider === 'local') {
        code = code === 'UNKNOWN' ? 'LOCAL_MODEL' : code;
      } else if (/failed to fetch|networkerror|network|econnrefused|网络/.test(lower)) {
        code = 'NETWORK';
      }
    }

    if (code === 'UNKNOWN' && status && status >= 500) {
      code = 'SERVER';
    }

    const map = {
      AUTH: {
        userMessage: 'API Key 无效或权限不足',
        actionHint: '请打开设置检查并保存服务档案'
      },
      RATE_LIMIT: {
        userMessage: '请求过于频繁，请稍后重试',
        actionHint: '可降低并发或稍后再试'
      },
      TIMEOUT: {
        userMessage: '请求超时',
        actionHint: '请检查网络或更换更快的模型'
      },
      NETWORK: {
        userMessage: '网络连接失败',
        actionHint: '请检查网络或代理设置'
      },
      LOCAL_MODEL: {
        userMessage: '无法连接本地模型服务',
        actionHint: '请确认 Ollama 已启动，并检查模型名称'
      },
      OFFLINE: {
        userMessage: '当前为离线模式，仅可使用本地模型与缓存',
        actionHint: '请在设置中关闭离线模式，或切换到本地 Ollama 档案'
      },
      SERVER: {
        userMessage: '翻译服务暂时不可用',
        actionHint: '请稍后重试或切换其他供应商'
      },
      UNKNOWN: {
        userMessage: '翻译失败',
        actionHint: '请稍后重试，或打开设置检查服务配置'
      }
    };

    const entry = map[code] || map.UNKNOWN;
    // 保留已知友好句（如已映射的 HTTP 文案）作为 userMessage 补充
    let userMessage = entry.userMessage;
    if (debugMessage && /API Key 无效|请求过于频繁|请先配置|网络已断开|离线模式/.test(debugMessage)) {
      userMessage = debugMessage.split('\n')[0];
    }

    return {
      code,
      userMessage,
      actionHint: entry.actionHint,
      debugMessage: debugMessage || userMessage
    };
  }

  /**
   * 格式化用户可见错误字符串（完整，含空行分隔）
   * @param {ReturnType<typeof buildUserError>} err
   * @returns {string}
   */
  function formatUserErrorText(err) {
    if (!err) return '翻译失败';
    if (err.actionHint) return `${err.userMessage}\n\n${err.actionHint}`;
    return err.userMessage || '翻译失败';
  }

  /**
   * 紧凑错误文案：结论一行 + 行动一行（划词浮层用）
   * @param {ReturnType<typeof buildUserError>|object|null} err
   * @param {number} [maxMsg=72]
   * @param {number} [maxHint=56]
   * @returns {string}
   */
  function formatUserErrorCompact(err, maxMsg = 72, maxHint = 56) {
    if (!err) return '翻译失败';
    const rawMsg = String(err.userMessage || err.message || '翻译失败').split('\n')[0].trim();
    const rawHint = String(err.actionHint || '').split('\n')[0].trim();
    const msg = rawMsg.length > maxMsg ? `${rawMsg.slice(0, maxMsg - 1)}…` : rawMsg;
    if (!rawHint) return msg || '翻译失败';
    const hint = rawHint.length > maxHint ? `${rawHint.slice(0, maxHint - 1)}…` : rawHint;
    return `${msg}\n${hint}`;
  }

  /**
   * 整页控制条完成态：哪些按钮应作为主操作可见
   * @param {{ hasFailures?: boolean }} opts
   * @returns {{ primary: string[], secondary: string[] }}
   */
  function pageControlCompletedActions(opts = {}) {
    const primary = ['restore', 'bilingual', 'close'];
    const secondary = ['disableSite'];
    if (opts.hasFailures) secondary.unshift('retry');
    return { primary, secondary };
  }

  /**
   * Popup 用量区是否默认折叠（信息降噪）
   * @returns {boolean}
   */
  function shouldCollapsePopupStats() {
    return true;
  }

  /**
   * 应用术语表：精确匹配优先（归一化空白后）
   * @param {string} text
   * @param {Array<{source:string,target:string}>} glossary
   * @returns {{ hit: boolean, text: string, source?: string, target?: string }}
   */
  function applyGlossary(text, glossary) {
    if (!text || !Array.isArray(glossary) || glossary.length === 0) {
      return { hit: false, text: text || '' };
    }
    const normalized = text.replace(/\s+/g, ' ').trim();
    for (const entry of glossary) {
      if (!entry || !entry.source) continue;
      const src = String(entry.source).replace(/\s+/g, ' ').trim();
      if (!src) continue;
      if (src === normalized || src === text) {
        return {
          hit: true,
          text: String(entry.target ?? ''),
          source: src,
          target: String(entry.target ?? '')
        };
      }
    }
    return { hit: false, text };
  }

  /**
   * 解析 CSV / JSON 术语表文本
   * @param {string} raw
   * @param {string} [filename]
   * @returns {Array<{source:string,target:string}>}
   */
  function parseGlossaryImport(raw, filename = '') {
    const text = (raw || '').trim();
    if (!text) return [];

    const lowerName = (filename || '').toLowerCase();
    if (lowerName.endsWith('.json') || text.startsWith('[') || text.startsWith('{')) {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (data.glossary || data.entries || []);
      return list
        .map((item) => {
          if (Array.isArray(item)) {
            return { source: String(item[0] || ''), target: String(item[1] || '') };
          }
          return {
            source: String(item.source || item.from || item.src || ''),
            target: String(item.target || item.to || item.dst || item.translation || '')
          };
        })
        .filter((e) => e.source && e.target);
    }

    // CSV / TSV：source,target 每行一对；支持跳过表头
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.includes('\t')
        ? line.split('\t')
        : line.split(/,(.+)/).filter((_, idx, arr) => {
            // "a,b,c" -> 简单二分：第一个逗号分割
            return true;
          });
      let source;
      let target;
      if (line.includes('\t')) {
        [source, target] = parts;
      } else {
        const idx = line.indexOf(',');
        if (idx === -1) continue;
        source = line.slice(0, idx);
        target = line.slice(idx + 1);
      }
      source = (source || '').trim().replace(/^"|"$/g, '');
      target = (target || '').trim().replace(/^"|"$/g, '');
      if (i === 0 && /^(source|原文|from)$/i.test(source) && /^(target|译文|to)$/i.test(target)) {
        continue;
      }
      if (source && target) entries.push({ source, target });
    }
    return entries;
  }

  /**
   * 离线模式是否允许发起非缓存云端请求
   * @param {boolean} offlineMode
   * @param {string} provider
   * @returns {boolean} true=允许请求
   */
  function isCloudRequestAllowed(offlineMode, provider) {
    if (!offlineMode) return true;
    return provider === 'local';
  }

  /**
   * 浏览器无网络时是否应拦截请求
   * 本地 Ollama 走 localhost，即使 navigator.onLine=false 也应放行
   * @param {boolean} isOnline - navigator.onLine
   * @param {string} provider
   * @returns {boolean} true=应拦截
   */
  function shouldBlockWhenBrowserOffline(isOnline, provider) {
    if (isOnline) return false;
    return provider !== 'local';
  }

  /**
   * 离线门禁：缓存命中始终放行
   * @param {object} opts
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function checkOfflineGate(opts = {}) {
    const { offlineMode = false, provider = '', cached = false } = opts;
    if (!offlineMode) return { allowed: true };
    if (cached) return { allowed: true };
    if (provider === 'local') return { allowed: true };
    return {
      allowed: false,
      reason: '离线模式仅允许本地模型与缓存，当前档案为云端供应商'
    };
  }

  /**
   * 解析站点级双语偏好
   * @param {string} hostname
   * @param {Record<string,{bilingualMode?:boolean}>} sitePrefs
   * @param {boolean} globalBilingual
   * @returns {boolean}
   */
  function resolveSiteBilingualMode(hostname, sitePrefs, globalBilingual) {
    const global = globalBilingual !== false;
    if (!hostname || !sitePrefs || typeof sitePrefs !== 'object') return global;
    const host = String(hostname).toLowerCase();
    const pref = sitePrefs[host] || sitePrefs[host.replace(/^www\./, '')];
    if (pref && typeof pref.bilingualMode === 'boolean') {
      return pref.bilingualMode;
    }
    return global;
  }

  /**
   * 将当前站点加入黑名单列表
   * @param {string[]} siteList
   * @param {string} hostname
   * @returns {string[]}
   */
  function addHostnameToList(siteList, hostname) {
    const list = Array.isArray(siteList) ? siteList.slice() : [];
    const host = (hostname || '').toLowerCase().trim();
    if (!host) return list;
    if (!list.some((x) => String(x).toLowerCase().trim() === host)) {
      list.push(host);
    }
    return list;
  }

  /**
   * 从列表移除主机名
   * @param {string[]} siteList
   * @param {string} hostname
   * @returns {string[]}
   */
  function removeHostnameFromList(siteList, hostname) {
    const host = (hostname || '').toLowerCase().trim();
    return (Array.isArray(siteList) ? siteList : []).filter(
      (x) => String(x).toLowerCase().trim() !== host
    );
  }

  /** 首次引导试译句 */
  const FIRST_RUN_TRIAL_TEXT = 'Hello';

  /**
   * 解析首次引导路径
   * @param {string} path
   * @returns {'local'|'cloud'|null}
   */
  function resolveFirstRunPath(path) {
    if (path === 'local' || path === 'cloud') return path;
    return null;
  }

  /**
   * 是否可进入下一步
   * @param {1|2|3} step
   * @param {{path?:string,provider?:string,apiKey?:string,ollamaOk?:boolean,localModel?:string,trialOk?:boolean}} state
   * @returns {boolean}
   */
  function canAdvanceFirstRunStep(step, state = {}) {
    if (step === 1) return !!resolveFirstRunPath(state.path);
    if (step === 2) {
      if (state.path === 'local') return !!state.ollamaOk;
      if (state.path === 'cloud') {
        const key = String(state.apiKey || '').trim();
        const provider = state.provider || '';
        return !!(provider && provider !== 'local' && key);
      }
      return false;
    }
    if (step === 3) return !!state.trialOk;
    return false;
  }

  /**
   * 根据引导状态构建档案草稿
   * @param {{path?:string,provider?:string,apiKey?:string,model?:string,localModel?:string}} state
   * @returns {object}
   */
  function buildFirstRunProfileDraft(state = {}) {
    if (state.path === 'local') {
      return {
        provider: 'local',
        localModel: state.localModel || 'translategemma:4b',
        apiKey: '',
        model: '',
        apiEndpoint: '',
        label: '本地 Ollama（首次引导）'
      };
    }
    const provider = state.provider || 'qwen';
    return {
      provider,
      apiKey: String(state.apiKey || '').trim(),
      model: state.model || '',
      localModel: '',
      apiEndpoint: '',
      label: `云端 ${provider}（首次引导）`
    };
  }

  /**
   * 试译原文
   * @returns {string}
   */
  function getFirstRunTrialText() {
    return FIRST_RUN_TRIAL_TEXT;
  }

  /**
   * 将事件 target 规范为可调用 closest 的 Element。
   * 飞书多维表格等复杂编辑器上 mouseup/mousedown 的 target 常为 Text 节点，无 closest。
   * @param {*} target - event.target
   * @returns {object|null} Element-like 或 null
   */
  function resolveEventElement(target) {
    if (!target || typeof target !== 'object') return null;
    // ELEMENT_NODE = 1
    if (target.nodeType === 1) {
      return typeof target.closest === 'function' ? target : null;
    }
    // TEXT_NODE / COMMENT_NODE 等：上溯到父元素
    const parent = target.parentElement || (target.parentNode && target.parentNode.nodeType === 1
      ? target.parentNode
      : null);
    if (parent && typeof parent.closest === 'function') return parent;
    // 无 nodeType 但已有 closest（部分 mock / 宿主对象）
    if (typeof target.closest === 'function') return target;
    return null;
  }

  /**
   * 安全版 Element.closest：从事件 target 解析元素后再匹配选择器
   * @param {*} target - event.target
   * @param {string} selector
   * @returns {object|null}
   */
  function eventTargetClosest(target, selector) {
    const el = resolveEventElement(target);
    if (!el || typeof el.closest !== 'function' || !selector) return null;
    try {
      return el.closest(selector);
    } catch (err) {
      return null;
    }
  }

  /**
   * Options 顶栏五个模块 id（与 data-tab 一致）
   * @type {readonly string[]}
   */
  const OPTIONS_TAB_IDS = Object.freeze([
    'profiles',
    'preference',
    'interaction',
    'data',
    'diagnostics'
  ]);

  /**
   * 各可写模块写入 ActiveConfig 的字段表（分栏保存用）
   * profiles / diagnostics 不在此表
   */
  const OPTIONS_MODULE_KEYS = Object.freeze({
    preference: Object.freeze(['sourceLang', 'targetLang', 'translateStyle', 'offlineMode', 'stylePrompts']),
    interaction: Object.freeze([
      'triggerMode',
      'enableStreaming',
      'originalStyle',
      'hoverTranslate',
      'dictMode',
      'autoCopy',
      'hoverModifier',
      'dictDblclick',
      'inputTranslate',
      'smartContentDetection',
      'compareProfileId'
    ]),
    data: Object.freeze([
      'cacheEnabled',
      'maxCacheMB',
      'siteRule',
      'siteList',
      'autoDetectLang',
      'autoFallback'
    ])
  });

  /**
   * 模块是否具备「保存本页」配置写入口（不含服务档案自身流）
   * @param {string} moduleId
   * @returns {boolean}
   */
  function isOptionsModuleWritable(moduleId) {
    return Object.prototype.hasOwnProperty.call(OPTIONS_MODULE_KEYS, moduleId);
  }

  /**
   * 从扁平值对象中只挑出某模块应写入的字段
   * @param {string} moduleId - preference | interaction | data
   * @param {object} values - 表单收集的完整候选字段
   * @returns {object} 仅含本模块键的切片；未知模块返回 {}
   */
  function pickModuleConfig(moduleId, values) {
    const keys = OPTIONS_MODULE_KEYS[moduleId];
    if (!keys || !values || typeof values !== 'object') return {};
    const out = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (Object.prototype.hasOwnProperty.call(values, k)) {
        out[k] = values[k];
      }
    }
    return out;
  }

  /**
   * G1：设置页「快速开始」三步是否显示
   * @param {{ firstRunPending?: boolean, profiles?: array, activeProfileId?: string }} opts
   * @returns {boolean}
   */
  function shouldShowOptionsQuickStart(opts) {
    const o = opts || {};
    if (o.firstRunPending) return true;
    const profiles = Array.isArray(o.profiles) ? o.profiles : [];
    if (profiles.length === 0) return true;
    const activeId = o.activeProfileId || '';
    if (!activeId) return true;
    const active = profiles.find((p) => p && p.id === activeId);
    if (!active) return true;
    return false;
  }

  // F1：悬停段落翻译的块级元素白名单（content.js 与本函数共用同一份，避免双份维护）
  const HOVER_BLOCK_TAGS = ['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'DD', 'DT', 'FIGCAPTION'];

  /**
   * F1：判断元素是否为悬停段落翻译候选（纯函数，便于单测）
   * @param {object} opts - { tagName, textLen, inExcluded, alreadyDone }
   * @returns {boolean}
   */
  function isHoverParagraphCandidate(opts) {
    if (!opts) return false;
    if (opts.inExcluded || opts.alreadyDone) return false;
    const textLen = typeof opts.textLen === 'number' ? opts.textLen : 0;
    // 过短无翻译价值；超长（>1500）仍作为候选，由调用方截断并标记（spec：超长截断并标记）
    if (textLen < 3) return false;
    return HOVER_BLOCK_TAGS.includes(opts.tagName);
  }

  /**
   * F2：判断文本是否为单个单词（trim 后无内部空白，首尾字母，长度 ≤ 30）
   * @param {string} text
   * @returns {boolean}
   */
  function isSingleWord(text) {
    if (typeof text !== 'string') return false;
    const s = text.trim();
    if (s.length === 0 || s.length > 30) return false;
    if (/\s/.test(s)) return false;
    // 首尾为字母，中间允许字母 / 附加符号 / 撇号 / 连字符
    return /^\p{L}[\p{L}\p{M}'’-]*\p{L}$/u.test(s);
  }

  /**
   * 划词浮窗 header 真实信息：语言对 + 供应商短名（替换品牌噪音 "YuxTrans"）
   * @param {string|null|undefined} provider - 供应商 id（qwen/deepseek/local...）
   * @param {string} sourceLang - 源语言代码（auto/en/zh...）
   * @param {string} targetLang - 目标语言代码
   * @returns {string} 如 "EN -> 中 · DeepSeek"；无语言对时回退 provider 或 "YuxTrans"
   */
  function popupTitleText(provider, sourceLang, targetLang) {
    const LANG = { auto: '自动', en: 'EN', zh: '中', ja: '日', ko: '韩', fr: '法', de: '德', es: '西', ru: '俄' };
    const PROVIDER = {
      qwen: 'Qwen', openai: 'OpenAI', deepseek: 'DeepSeek', anthropic: 'Claude',
      groq: 'Groq', moonshot: 'Moonshot', siliconflow: 'SiliconFlow',
      google: 'Google', local: '本地', custom: '自定义'
    };
    const src = LANG[sourceLang] || (sourceLang ? String(sourceLang).toUpperCase() : '');
    const tgt = LANG[targetLang] || (targetLang ? String(targetLang).toUpperCase() : '');
    const p = PROVIDER[provider] || (provider ? String(provider) : '');
    if (!src && !tgt) return p || 'YuxTrans';
    const pair = `${src} -> ${tgt}`;
    return p ? `${pair} · ${p}` : pair;
  }

  return {
    resolveTriggerAction,
    shouldShowFloatButton,
    shouldAutoTranslateOnSelect,
    shouldUseStreaming,
    resolveTranslateAction,
    isHoverParagraphCandidate,
    isSingleWord,
    popupTitleText,
    HOVER_BLOCK_TAGS,
    buildUserError,
    formatUserErrorText,
    formatUserErrorCompact,
    pageControlCompletedActions,
    shouldCollapsePopupStats,
    applyGlossary,
    parseGlossaryImport,
    isCloudRequestAllowed,
    shouldBlockWhenBrowserOffline,
    checkOfflineGate,
    resolveSiteBilingualMode,
    addHostnameToList,
    removeHostnameFromList,
    FIRST_RUN_TRIAL_TEXT,
    resolveFirstRunPath,
    canAdvanceFirstRunStep,
    buildFirstRunProfileDraft,
    getFirstRunTrialText,
    OPTIONS_TAB_IDS,
    OPTIONS_MODULE_KEYS,
    isOptionsModuleWritable,
    pickModuleConfig,
    shouldShowOptionsQuickStart,
    resolveEventElement,
    eventTargetClosest
  };
});
