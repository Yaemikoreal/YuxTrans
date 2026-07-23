/**
 * SW 消息 action 注册表（messages 模块）
 * 依赖：bootstrap
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  /** @type {string[]} */
  const MESSAGE_ACTIONS = [
    'translate',
    'translateStream',
    'translateBatch',
    'lookupWord',
    'cancelTranslate',
    'getConfig',
    'getProviderDefaults',
    'setConfig',
    'reportBadTranslation',
    'disableSite',
    'setSiteBilingualMode',
    'importGlossary',
    'clearGlossary',
    'checkConnection',
    'getCacheStats',
    'clearCache',
    'getUsageStats',
    'getMetrics',
    'getRequestLogs',
    'fetchModels',
    'testProvider',
    'testProviderConnection',
    'saveProfile',
    'getProfiles',
    'deleteProfile',
    'setActiveProfile'
  ];

  /**
   * 是否为已注册消息 action
   * @param {string} action
   * @returns {boolean}
   */
  function isKnownMessageAction(action) {
    return MESSAGE_ACTIONS.includes(action);
  }

  /**
   * 按关注点归类 action（便于拆分与测试）
   * @param {string} action
   * @returns {'translate'|'config'|'cache'|'glossary'|'site'|'diagnostics'|'unknown'}
   */
  function classifyMessageAction(action) {
    if (['translate', 'translateStream', 'translateBatch', 'lookupWord', 'cancelTranslate', 'checkConnection', 'testProvider'].includes(action)) {
      return 'translate';
    }
    if (['getConfig', 'setConfig', 'getProviderDefaults', 'saveProfile', 'getProfiles', 'deleteProfile', 'setActiveProfile', 'fetchModels'].includes(action)) {
      return 'config';
    }
    if (['getCacheStats', 'clearCache', 'reportBadTranslation'].includes(action)) {
      return 'cache';
    }
    if (['importGlossary', 'clearGlossary'].includes(action)) {
      return 'glossary';
    }
    if (['disableSite', 'setSiteBilingualMode'].includes(action)) {
      return 'site';
    }
    if (['getUsageStats', 'getMetrics', 'getRequestLogs'].includes(action)) {
      return 'diagnostics';
    }
    return 'unknown';
  }

  SW.MESSAGE_ACTIONS = MESSAGE_ACTIONS;
  SW.isKnownMessageAction = isKnownMessageAction;
  SW.classifyMessageAction = classifyMessageAction;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      MESSAGE_ACTIONS,
      isKnownMessageAction,
      classifyMessageAction
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
