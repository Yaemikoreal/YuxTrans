/**
 * SW 供应商核心纯函数
 * 依赖：bootstrap + constants
 */
(function (root) {
  const SW = (root && root.YuxTransSW) || (typeof YuxTransSW !== 'undefined' ? YuxTransSW : null);
  if (!SW) return;

  const JSON_MODE_PROVIDERS = ['openai', 'qwen', 'deepseek', 'groq', 'moonshot', 'siliconflow'];

  /**
   * 默认模型
   * @param {string} provider
   * @returns {string}
   */
  function getDefaultModel(provider) {
    const models = (SW.DEFAULT_MODELS || {})[provider];
    return Array.isArray(models) && models.length > 0 ? models[0] : '';
  }

  /**
   * 是否支持 OpenAI 风格 json_object
   * @param {string} provider
   * @returns {boolean}
   */
  function supportsJsonMode(provider) {
    return JSON_MODE_PROVIDERS.includes(provider);
  }

  /**
   * 判断供应商配置是否可用
   * @param {object} providerConfig
   * @returns {boolean}
   */
  function isProviderAvailable(providerConfig) {
    const p = providerConfig || {};
    if (p.provider === 'local') return true;
    // F7：谷歌免费接口无需 API Key
    if (p.provider === 'google') return true;
    if (p.provider === 'custom') {
      return !!(p.customProvider?.endpoint && p.customProvider?.apiKey);
    }
    return !!(p.apiKey || p.customProvider?.apiKey);
  }

  /**
   * 是否为免配置供应商（无需 API Key / 端点 / 模型选择）
   * local=Ollama、custom=自定义端点（凭据内嵌）、google=免费接口
   * @param {string} provider
   * @returns {boolean}
   */
  function isNoConfigProvider(provider) {
    return provider === 'local' || provider === 'custom' || provider === 'google';
  }

  /**
   * 生成档案 ID
   * @param {string} provider
   * @param {string} model
   * @param {string} localModel
   * @returns {string}
   */
  function makeProfileId(provider, model, localModel) {
    const modelPart = model || localModel || 'default';
    return `${provider}:${modelPart}`;
  }

  SW.JSON_MODE_PROVIDERS = JSON_MODE_PROVIDERS;
  SW.getDefaultModel = getDefaultModel;
  SW.supportsJsonMode = supportsJsonMode;
  SW.isProviderAvailable = isProviderAvailable;
  SW.isNoConfigProvider = isNoConfigProvider;
  SW.makeProfileId = makeProfileId;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getDefaultModel,
      supportsJsonMode,
      isProviderAvailable,
      isNoConfigProvider,
      makeProfileId,
      JSON_MODE_PROVIDERS
    };
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
