/**
 * 整页翻译 / 动态增量 / 整页控制条方法（content 拆分模块）
 * 依赖：content.js 先注入（YuxTransContent 类）
 */
(function () {
  const Ctor = (typeof YuxTransContent !== 'undefined' ? YuxTransContent : null)
    || (typeof globalThis !== 'undefined' ? globalThis.YuxTransContent : null);
  if (!Ctor) return;
  Object.assign(Ctor.prototype, {
    /**
     * 流式翻译单个段落（整页流式路径的最小单元，逐段渲染）
     * 过程：插入临时 span → SW 经 streamChunk 消息按 requestId 推送 fullText 实时刷新 →
     * 最终响应到达后移除临时 span，由 applyTranslation 落为双语/仅译文节点。
     * 缓存写入由 SW 侧 translateStream 处理器负责（术语表 → 缓存 → setToCache，
     * 与划词流式同一约定），内容脚本不重复写缓存。
     * @param {object} nodeInfo - { text, node, isInViewport }
     * @param {string} requestId - 段落级唯一请求标识（streamChunk 按此路由到对应 tempSpan）
     * @returns {Promise<{success: boolean, text?: string, cached?: boolean, error?: string}>}
     */
    async translateStreamForNode(nodeInfo, requestId) {
      // 取消后不再发起新请求，避免继续消耗配额
      // #13：动态增量翻译走独立标志 _dynamicTranslating，同样视为活跃会话
      if (this.pageTranslationState.cancelRequested ||
          (!this.pageTranslationState.isTranslating && !this._dynamicTranslating)) {
        return { success: false, error: '翻译已取消' };
      }

      const { text, node } = nodeInfo;
      const parent = node.parentElement;
      if (!parent) return { success: false, error: '父节点丢失' };

      // 创建临时流式译文容器
      const tempSpan = document.createElement('span');
      tempSpan.className = 'yuxtrans-streaming-text';
      tempSpan.textContent = '';

      if (node.nextSibling) {
        parent.insertBefore(tempSpan, node.nextSibling);
      } else {
        parent.appendChild(tempSpan);
      }

      this.pageTranslationState.streamingNodes.set(requestId, { nodeInfo, tempSpan });

      const sourceLang = this.config.sourceLang || 'auto';
      const targetLang = this.config.targetLang || 'zh';

      return new Promise((resolve) => {
        // SW 侧流式超时为 REQUEST_TIMEOUT_MS * 2（60s），这里略宽于它，
        // 确保失败由 SW 回报（可走非流式故障转移），而非内容脚本先超时丢弃结果
        const timeout = setTimeout(() => {
          this.pageTranslationState.streamingNodes.delete(requestId);
          if (tempSpan.parentNode) tempSpan.remove();
          resolve({ success: false, error: '流式翻译超时' });
        }, YuxContentConsts.STREAM_TIMEOUT_MS);

        chrome.runtime.sendMessage(
          {
            action: 'translateStream',
            text,
            sourceLang,
            targetLang,
            // 整页翻译的段落流式请求不再携带页面标题等上下文，避免模型把任意片段偏向页面标题。
            context: null,
            requestId,
            // 接入整页取消链路：用户取消时 SW abort 在途 SSE（与 translateBatch 对齐）
            sessionId: this._pageSessionId || null
          },
          (response) => {
            clearTimeout(timeout);
            this.pageTranslationState.streamingNodes.delete(requestId);
            if (tempSpan.parentNode) tempSpan.remove();

            if (response && response.success) {
              // 已取消/已恢复原文时不再落地译文，避免覆盖用户恢复后的页面状态
              const cancelled = this.pageTranslationState.cancelRequested ||
                (!this.pageTranslationState.isTranslating && !this._dynamicTranslating);
              if (!cancelled) {
                this.applyTranslation(nodeInfo, response.text);
              }
              resolve({ success: !cancelled, text: response.text, cached: response.cached });
            } else {
              resolve({ success: false, error: response?.error || '流式翻译失败' });
            }
          }
        );
      });
    },

    /**
     * 筛选可视区域内的节点
     */
    getViewportNodes(nodesInfo) {
      return nodesInfo.filter(info => info.isInViewport);
    },

    // ===== 整页翻译优化 =====

    /**
     * 收集可翻译的文本节点，按可视区域排序。
     * Q1：两阶段执行——TreeWalker 先纯收集（不触发布局），再分批读取 getBoundingClientRect，
     * 批间让出主线程，避免大页面数千节点连续同步布局读取造成启动长卡顿。
     */
    async collectTextNodes(root) {
      // F6：正文区域识别--smartContentDetection 开启时只遍历正文根，跳过导航/侧栏/页脚
      if (!root) {
        root = (this.config.smartContentDetection && this.detectMainContent()) || document.body;
      }
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;

            // 排除特定元素
            const skipSelectors = [
              'script', 'style', 'noscript', 'iframe', 'canvas', 'svg',
              'code', 'pre', '[contenteditable="true"]',
              '.yuxtrans-progress', '.yuxtrans-popup', '.yuxtrans-page-control',
              '.yuxtrans-side-tab', '.yuxtrans-float-btn', '.yuxtrans-site-rule-toast',
              '.yuxtrans-translated', '.yuxtrans-translated-bilingual',
              '.yuxtrans-bilingual-text', '.yuxtrans-streaming-text',
              '.yuxtrans-hover-translation', '.yuxtrans-dict',
              '.yuxtrans-hover-guide', '.yuxtrans-page-toast' // #8A：自身 UI 不被整页翻译
            ].join(', ');
            if (parent.closest(skipSelectors)) {
              return NodeFilter.FILTER_REJECT;
            }

            // 排除输入元素
            if (parent.closest('input, textarea, select')) {
              return NodeFilter.FILTER_REJECT;
            }

            // 排除已翻译节点（含双语模式）
            const isTranslated = parent.classList.contains('yuxtrans-translated');
            const isBilingual = parent.classList.contains('yuxtrans-translated-bilingual');
            if (isTranslated || isBilingual) {
              return NodeFilter.FILTER_REJECT;
            }

            // 最小文本长度
            const text = node.textContent.trim();
            if (text.length < this.config.minTextLength) {
              return NodeFilter.FILTER_REJECT;
            }

            // 跳过纯数字、纯符号、URL、邮箱等无翻译价值文本
            if (!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) {
              return NodeFilter.FILTER_REJECT;
            }
            if (/^(https?:\/\/|www\.|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.test(text)) {
              return NodeFilter.FILTER_REJECT;
            }

            // 跳过 GitHub 等页面的元数据片段：commit SHA、@mention、#tag、仓库路径、文件名
            if (/^\s*[@#][\w-]+/.test(text)) return NodeFilter.FILTER_REJECT;
            if (/^\s*[a-f0-9]{7,40}(\.{3})?\s*$/i.test(text)) return NodeFilter.FILTER_REJECT;
            if (/^\s*\w+\/\w+/.test(text)) return NodeFilter.FILTER_REJECT;
            if (/^\s*[0-9]+\s*$/.test(text)) return NodeFilter.FILTER_REJECT;
            if (/(?:^|[^\p{L}\d_])\.[a-z0-9]{1,6}$/i.test(text) && !text.includes(' ')) {
              return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      const rawNodes = [];
      while (walker.nextNode()) {
        rawNodes.push(walker.currentNode);
      }

      // 第二阶段：分批读取布局。批内不做任何 DOM 写，布局只计算一次；
      // 批间 yield 让出主线程，长列表不阻塞输入与渲染。
      const nodes = [];
      for (let i = 0; i < rawNodes.length; i++) {
        const node = rawNodes[i];
        const rect = node.parentElement.getBoundingClientRect();

        // 计算节点是否在可视区域
        const isInViewport = (
          rect.bottom > 0 &&
          rect.top < viewportHeight &&
          rect.right > 0 &&
          rect.left < viewportWidth
        );

        nodes.push({
          node,
          text: node.textContent.trim(),
          isInViewport,
          rect: {
            top: rect.top,
            bottom: rect.bottom
          }
        });

        if ((i + 1) % YuxContentConsts.COLLECT_LAYOUT_BATCH_SIZE === 0 && i + 1 < rawNodes.length) {
          await this._yieldToMainThread();
        }
      }

      // 排序：可视区域优先
      nodes.sort((a, b) => {
        if (a.isInViewport && !b.isInViewport) return -1;
        if (!a.isInViewport && b.isInViewport) return 1;
        return a.rect.top - b.rect.top; // 按页面位置排序
      });

      return nodes;
    },

    /**
     * Q1：让出主线程（优先 scheduler.yield，降级 0ms setTimeout）
     */
    _yieldToMainThread() {
      if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield();
      }
      return new Promise((resolve) => setTimeout(resolve, 0));
    },

    /**
     * F6：识别页面正文区域根节点，跳过导航/侧栏/页脚等非正文块
     * 启发式：main > article > 文本密度最高的块级容器 > body
     */
    detectMainContent() {
      try {
        // 1. 语义标签优先（需正文文本量达标，避免空壳 main/article）
        const main = document.querySelector('main') || document.querySelector('[role="main"]');
        if (main && this._collectibleTextLength(main) >= 200) return main;
        const article = document.querySelector('article');
        if (article && this._collectibleTextLength(article) >= 200) return article;

        // 2. 文本密度：body 直系子块级容器中，排除 nav/header/footer/aside，取正文文本量最大者
        const candidates = Array.from(document.body.children).filter((el) =>
          ['DIV', 'SECTION', 'ARTICLE', 'MAIN'].includes(el.tagName)
        );
        let best = null;
        let bestLen = 0;
        for (const el of candidates) {
          if (el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
          const len = this._collectibleTextLength(el);
          if (len > bestLen) { bestLen = len; best = el; }
        }
        // 密度阈值：正文至少 200 字符才采纳，否则回退 body
        if (best && bestLen >= 200) return best;
      } catch (e) {
        // 识别异常时降级到 body，绝不阻断整页翻译
      }
      return document.body;
    },

    /**
     * F6：粗略统计元素内可翻译文本长度（去空白后）
     */
    _collectibleTextLength(el) {
      return (el.textContent || '').replace(/\s+/g, '').length;
    },

    /**
     * 获取元素的重要样式
     */
    getElementStyles(element) {
      if (!this.config.preserveStyles) return null;

      const computed = window.getComputedStyle(element);
      const parent = element.parentElement;

      // 检查是否是特殊标签
      const tagName = element.tagName.toLowerCase();
      const isBold = tagName === 'strong' || tagName === 'b' ||
        computed.fontWeight === 'bold' || parseInt(computed.fontWeight) >= 600;
      const isItalic = tagName === 'em' || tagName === 'i' ||
        computed.fontStyle === 'italic';
      const isLink = tagName === 'a' || (parent && parent.tagName.toLowerCase() === 'a');
      const isCode = tagName === 'code' || (parent && parent.tagName.toLowerCase() === 'code');
      const isMark = tagName === 'mark' || (parent && parent.tagName.toLowerCase() === 'mark');

      return {
        isBold,
        isItalic,
        isLink,
        isCode,
        isMark,
        color: computed.color,
        fontSize: computed.fontSize,
        className: element.className || ''
      };
    },

    /**
     * 并行翻译多个文本
     * @param {Array} items - 待翻译项
     * @param {Function|null} onProgress - 进度回调 (completed, total)
     * @param {Function|null} onBatchResult - 每个 batch 完成时的回调 (indices, nodes, results)
     */
    async translateBatchParallel(items, onProgress, onBatchResult = null, options = {}) {
      const isLocal = this.config.provider === 'local';
      const { concurrency: configConcurrency } = this.config || { concurrency: 10 };

      // 流式模式：整页翻译 enableStreaming 开启时逐段走 translateStream（SSE）
      const streaming = !!options.streaming;

      // 动态调整：本地模型强制串行且减小分片，云端模型维持高并发。
      // 流式模式每条请求是一个 SSE 长连接（存活时间远长于批量短请求），并发过高会迅速
      // 堆满连接并触发供应商 429；SW 侧自适应速率上限为 10 并发（RATE_LIMIT_CONFIG.MAX_CONCURRENT），
      // 故整页流式云端固定 4 并发（与首屏 viewportConcurrency 持平，并为划词流式等请求留余量），
      // 本地 Ollama 与批量路径一致保持串行。
      const concurrency = isLocal
        ? 1
        : streaming
          ? (options.concurrency || 4)
          : (options.concurrency || configConcurrency);
      const BATCH_SIZE = isLocal
        ? 5
        : (options.batchSize || this.config.batchSize || 20);

      const results = new Array(items.length);
      let completed = 0;

      // 流式路径：不打包，每个段落一个 worker 任务，逐段 SSE 渲染
      if (streaming) {
        const queue = items.map((_, i) => i);

        const worker = async () => {
          // #13：整页主流程（isTranslating）或动态增量（_dynamicTranslating）任一活跃即继续
          while (queue.length > 0 && (this.pageTranslationState.isTranslating || this._dynamicTranslating) && !this.pageTranslationState.cancelRequested) {
            const globalIdx = queue.shift();
            const item = items[globalIdx];
            const requestId = 'yxt-page-stream-' + (++this._streamReqSeq);
            let mapped;
            try {
              // translateStreamForNode 内部已完成临时 span 渲染与最终 applyTranslation
              const res = await this.translateStreamForNode(item.nodeInfo, requestId);
              if (res && res.success) {
                results[globalIdx] = { success: true, translated: res.text, cached: res.cached };
                mapped = { success: true, text: res.text, cached: res.cached };
              } else {
                const err = (res && res.error) || '流式翻译失败';
                results[globalIdx] = { success: false, error: err };
                mapped = { success: false, error: err };
              }
              // 与批量路径对齐：逐项回调即时统计/渲染（applyTranslation 幂等，重复调用无副作用）
              if (onBatchResult) {
                onBatchResult([globalIdx], [item], [mapped]);
              }
            } catch (error) {
              results[globalIdx] = { success: false, error: error.message };
            } finally {
              completed++;
              if (onProgress) {
                onProgress(completed, items.length);
              }
            }
          }
        };

        const workers = [];
        for (let i = 0; i < Math.min(concurrency, items.length); i++) {
          workers.push(worker());
        }
        await Promise.all(workers);
        return results;
      }

      // 分块打包
      const batches = [];
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        batches.push({
          indices: Array.from({ length: Math.min(BATCH_SIZE, items.length - i) }, (_, k) => i + k),
          nodes: items.slice(i, i + BATCH_SIZE)
        });
      }

      const queue = [...batches.keys()];

      let failsInARow = 0;
      let fallbackMode = false; // 是否已进入单句翻译降级模式

      const worker = async () => {
        // #13：整页主流程（isTranslating）或动态增量（_dynamicTranslating）任一活跃即继续
        while (queue.length > 0 && (this.pageTranslationState.isTranslating || this._dynamicTranslating) && !this.pageTranslationState.cancelRequested) {
          const batchIndex = queue.shift();
          const batch = batches[batchIndex];

          // 如果进入了降级模式，且当前 batch 包含多项，则将其重新拆分为单个任务送回队列
          if (fallbackMode && batch.indices.length > 1) {
            batch.indices.forEach((idx, i) => {
              batches.push({
                indices: [idx],
                nodes: [batch.nodes[i]]
              });
              queue.push(batches.length - 1);
            });
            continue;
          }

          const texts = batch.nodes.map(item => item.text);

          try {
            const response = await new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ success: false, error: 'Request nested timeout' }), YuxContentConsts.BATCH_REQUEST_TIMEOUT_MS);
              chrome.runtime.sendMessage(
                {
                  action: 'translateBatch',
                  texts: texts,
                  sourceLang: this.config.sourceLang || 'auto',
                  targetLang: this.config.targetLang || 'zh',
                  // 整页批量翻译不携带页面标题，避免模型把所有片段译成同一个标题。
                  context: null,
                  sessionId: this._pageSessionId
                },
                (res) => {
                  clearTimeout(timer);
                  resolve(res);
                }
              );
            });

            if (response && response.success && response.results) {
              failsInARow = 0;
              response.results.forEach((res, localIdx) => {
                const globalIdx = batch.indices[localIdx];
                if (res && res.success) {
                  results[globalIdx] = { success: true, translated: res.text, cached: res.cached };
                } else {
                  results[globalIdx] = { success: false, error: res?.error };
                }
              });
              if (onBatchResult) {
                onBatchResult(batch.indices, batch.nodes, response.results);
              }
            } else {
              throw new Error(response?.error || 'Batch response failed');
            }
          } catch (error) {
            failsInARow++;
            // 如果连续 2 次 Batch 失败，开启降级模式
            if (isLocal && failsInARow >= 2) {
              fallbackMode = true;
            }

            batch.indices.forEach(globalIdx => {
               results[globalIdx] = { success: false, error: error.message };
            });
          } finally {
            completed += batch.nodes.length;
            if (onProgress) {
              onProgress(completed, items.length);
            }
          }
        }
      };

      const workers = [];
      for (let i = 0; i < Math.min(concurrency, batches.length); i++) {
        workers.push(worker());
      }

      await Promise.all(workers);
      return results;
    },

    /**
     * 应用翻译结果，保持样式
     */
    applyTranslation(nodeInfo, translatedText) {
      const { node } = nodeInfo;

      // 防止对同一节点重复应用（例如批量回调与最终循环重叠）
      if (this.pageTranslationState.originalTexts.has(node)) {
        return false;
      }

      const parent = node.parentElement;
      if (!parent) return false;

      // 保存原文、样式和双语节点引用
      const originalData = {
        text: node.textContent,
        translated: translatedText, // 核心：缓存译文，支持动态切换
        styles: this.getElementStyles(parent),
        bilingualNode: null
      };
      this.pageTranslationState.originalTexts.set(node, originalData);

      const useBilingual = this.config.bilingualMode !== false; // 默认开启

      if (useBilingual) {
        // 双语对照模式：新增一个隐藏了部分原样式的 span
        const bilingualSpan = document.createElement('span');
        bilingualSpan.className = 'yuxtrans-bilingual-text';
        // 两端可以加一个细微的空白或破折号分隔
        bilingualSpan.textContent = translatedText;

        if (node.nextSibling) {
          parent.insertBefore(bilingualSpan, node.nextSibling);
        } else {
          parent.appendChild(bilingualSpan);
        }

        originalData.bilingualNode = bilingualSpan;
        parent.classList.add('yuxtrans-translated-bilingual');
        // F3：原文呈现样式（弱化/模糊原文）
        this._applyOriginalStyle(parent);
      } else {
        // 仅译文模式：直接替换并加类名
        node.textContent = translatedText;
        parent.classList.add('yuxtrans-translated');
      }

      // 保持样式（如果需要）
      if (originalData.styles) {
        const styles = originalData.styles;

        // 保持粗体
        if (styles.isBold) {
          parent.style.fontWeight = 'bold';
        }

        // 保持斜体
        if (styles.isItalic) {
          parent.style.fontStyle = 'italic';
        }

        // 保持链接样式
        if (styles.isLink) {
          const linkParent = parent.tagName.toLowerCase() === 'a' ? parent :
            (parent.parentElement?.tagName.toLowerCase() === 'a' ? parent.parentElement : null);
          if (linkParent) {
            linkParent.style.color = styles.color;
            linkParent.style.textDecoration = styles.isLink ? 'underline' : 'none';
          }
        }
      }

      this.pageTranslationState.translatedNodes.push(node);
      return true;
    },

    /**
     * F3：按 originalStyle 给原文容器应用弱化/模糊样式
     */
    _applyOriginalStyle(parent) {
      if (!parent) return;
      parent.classList.remove('yuxtrans-original-fade', 'yuxtrans-original-blur');
      const style = this.config.originalStyle || 'normal';
      if (style === 'fade') parent.classList.add('yuxtrans-original-fade');
      else if (style === 'blur') parent.classList.add('yuxtrans-original-blur');
    },

    /**
     * F3：批量重应用原文样式（originalStyle 配置变更后调用，仅双语模式生效）
     */
    applyOriginalStyleToAll() {
      for (const [node] of this.pageTranslationState.originalTexts) {
        const parent = node && node.parentElement;
        if (parent && parent.classList.contains('yuxtrans-translated-bilingual')) {
          this._applyOriginalStyle(parent);
        }
      }
    },

    /**
     * 标记翻译失败的节点
     */
    markFailedNode(nodeInfo, error) {
      const { node } = nodeInfo;
      const parent = node.parentElement;
      if (!parent) return;

      // 仅当未被标记过才保存原文，防止覆盖已有错误记录
      if (!this.pageTranslationState.originalTexts.has(node)) {
        parent.classList.add('yuxtrans-failed');
        this.pageTranslationState.originalTexts.set(node, {
          text: node.textContent,
          styles: this.getElementStyles(parent),
          error: error
        });
      }
    },

    /**
     * 整页翻译主函数
     */
    async translatePage() {
      // 同步锁：防止快速重复触发（如双击、消息重入）导致套娃翻译
      if (this._pageTranslateLocked) return;
      this._pageTranslateLocked = true;

      try {
        // 每次触发都重新拉取配置，确保模式开关实时生效
        await this.loadConfig();

        // 站点规则控制
        if (!this.isSiteAllowed()) {
          this._showPageToast('本站已禁用 YuxTrans 翻译');
          return;
        }

      // 防止重入：翻译进行中再次触发则取消在途批次并恢复已译原文
      if (this.pageTranslationState.isTranslating) {
        this.restoreOriginalTexts();
        this.setPageControlRestoredState();
        return;
      }

      // 如果已翻译，恢复原文
      if (this.pageTranslationState.isTranslated) {
        this.restoreOriginalTexts();
        this.setPageControlRestoredState();
        this._showPageToast('已恢复原文，再次点击可重新翻译');
        return;
      }

      // 收集文本节点（Q1：异步分批读布局，大页面不卡主线程）
      const nodesInfo = await this.collectTextNodes();

      if (nodesInfo.length === 0) {
        this._showPageToast('未发现可翻译内容');
        return;
      }

      // 初始化状态
      this.pageTranslationState.translatedNodes = [];
      this.pageTranslationState.isTranslating = true;
      this.pageTranslationState.cancelRequested = false;
      this.pageTranslationState.originalTexts.clear();
      this.pageTranslationState.streamingNodes.clear();
      this.pageTranslationState.failedItems = [];
      this.pageTranslationState.cacheHits = 0;
      this.pageTranslationState.apiCount = 0;
      // 分配本轮会话 id，供 SW 侧取消链路使用
      this._pageSessionId = 'yxt-page-' + (++this._pageSessionCounter);

      // 禁用控制条上的翻译/重新翻译按钮，防止任务进行中重复点击
      this.setPageControlTranslateDisabled(true);

      // ===== 文本去重优化 =====
      const uniqueTexts = new Map(); // text -> { indices: [], translation: null, error: null }
      const dedupedItems = [];
      let duplicateCount = 0;

      nodesInfo.forEach((nodeInfo, index) => {
        const text = nodeInfo.text;
        if (uniqueTexts.has(text)) {
          // 记录重复文本的索引
          uniqueTexts.get(text).indices.push(index);
          duplicateCount++;
        } else {
          // 新文本
          uniqueTexts.set(text, { indices: [index], translation: null, error: null });
          dedupedItems.push({ text, originalIndex: index, nodeInfo });
        }
      });

      // 区分首屏与后续节点
      const viewportItems = dedupedItems.filter(item => item.nodeInfo.isInViewport);
      const belowFoldItems = dedupedItems.filter(item => !item.nodeInfo.isInViewport);

      const displayTotal = nodesInfo.length;
      this.showPageControl(displayTotal);
      const startTime = Date.now();
      let completedUnits = 0;

      const reportProgress = (delta) => {
        completedUnits += delta;
        const ratio = dedupedItems.length > 0 ? nodesInfo.length / dedupedItems.length : 1;
        const actualCompleted = Math.min(Math.round(completedUnits * ratio), nodesInfo.length);
        this.updatePageControl(actualCompleted, displayTotal, startTime);
      };

      try {
        // A: 首屏 mini-batch 翻译（用 0.5-0.9s 首字延迟换取总吞吐大幅提升）
        const isLocal = this.config.provider === 'local';
        const viewportBatchSize = isLocal ? 3 : 10;
        const viewportConcurrency = isLocal ? 2 : 4;
        // enableStreaming 开启时整页走流式路径（逐段 SSE 渲染）；关闭时批量路径保持不变
        const useStreaming = this.config.enableStreaming !== false;

        if (viewportItems.length > 0 && this.pageTranslationState.isTranslating) {
          let lastViewportCompleted = 0;
          await this.translateBatchParallel(
            viewportItems,
            (completed, total) => {
              reportProgress(completed - lastViewportCompleted);
              lastViewportCompleted = completed;
            },
            (indices, nodes, results) => {
              // 每个 mini-batch 完成立即渲染，保证首屏感知
              results.forEach((res, localIdx) => {
                const item = nodes[localIdx];
                if (res && res.success) {
                  uniqueTexts.get(item.text).translation = res.text;
                  if (res.cached) this.pageTranslationState.cacheHits++;
                  else this.pageTranslationState.apiCount++;
                  this.applyTranslation(item.nodeInfo, res.text);
                }
              });
            },
            useStreaming
              ? { streaming: true }
              : { batchSize: viewportBatchSize, concurrency: viewportConcurrency }
          );
          // 记录失败项
          viewportItems.forEach((item) => {
            const resultItem = uniqueTexts.get(item.text);
            if (!resultItem.translation && !resultItem.error) {
              resultItem.error = '翻译失败';
            }
          });
        }

        // 2. belowFold 视口感知翻译：入视口（200px 预加载区）才提交批次，
        //    取代一次性全提交以节省配额；2s 超时回退避免用户不滚动时 await 卡死。
        const appliedTexts = new Set();
        const belowFoldOnBatchResult = (indices, nodes, results) => {
          if (this.pageTranslationState.cancelRequested) return;
          results.forEach((res, localIdx) => {
            const item = nodes[localIdx];
            if (res && res.success) {
              const resultItem = uniqueTexts.get(item.text);
              if (resultItem) resultItem.translation = res.text;
              appliedTexts.add(item.text);
              if (res.cached) this.pageTranslationState.cacheHits++;
              else this.pageTranslationState.apiCount++;
              this.applyTranslation(item.nodeInfo, res.text);
            } else {
              const resultItem = uniqueTexts.get(item.text);
              if (resultItem && !resultItem.translation) resultItem.error = '翻译失败';
            }
          });
        };
        if (belowFoldItems.length > 0 && this.pageTranslationState.isTranslating) {
          await this._translateBelowFoldViaViewport(
            belowFoldItems,
            belowFoldOnBatchResult,
            useStreaming ? { streaming: true } : null
          );
        }

        // 取消场景：restoreOriginalTexts 已恢复原文，跳过应用结果与完成收尾
        if (this.pageTranslationState.cancelRequested) return;

        // 3. 应用翻译结果（包括重复文本；applyTranslation 内部已做去重）
        let successCount = 0;
        let failCount = 0;
        for (let i = 0; i < nodesInfo.length; i++) {
          const nodeInfo = nodesInfo[i];
          const item = uniqueTexts.get(nodeInfo.text);
          if (item.translation) {
            // 每个节点都尝试应用译文，确保重复文本节点也纳入 originalTexts，
            // 从而支持双语/仅译文切换时同步更新所有出现位置
            const applied = this.applyTranslation(nodeInfo, item.translation);
            if (applied || this.pageTranslationState.originalTexts.has(nodeInfo.node)) {
              if (!appliedTexts.has(nodeInfo.text)) {
                successCount++;
                appliedTexts.add(nodeInfo.text);
              }
            }
          } else if (item.error) {
            // 失败项可视化标记
            this.markFailedNode(nodeInfo, item.error);
            this.pageTranslationState.failedItems.push({ nodeInfo, text: nodeInfo.text, error: item.error });
            failCount++;
          }
        }

        // 翻译完成
        this.pageTranslationState.isTranslated = true;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        this.logPageMetrics({
          url: location.href,
          provider: this.config.provider,
          model: this.config.model,
          totalNodes: nodesInfo.length,
          viewportNodes: viewportItems.length,
          belowFoldNodes: belowFoldItems.length,
          uniqueTexts: dedupedItems.length,
          duplicateTexts: duplicateCount,
          successCount,
          failCount,
          cacheHits: this.pageTranslationState.cacheHits,
          apiCount: this.pageTranslationState.apiCount,
          elapsedSeconds: parseFloat(elapsed)
        });
        this.showPageControlComplete(
          successCount, nodesInfo.length, elapsed, duplicateCount, failCount
        );
        // 整页翻译完成后，监听动态新增内容（无限滚动 / SPA 异步加载）
        this._startDynamicObserver();
      } catch (error) {
        console.error('[YuxTrans] 整页翻译异常:', error);
      } finally {
        this.pageTranslationState.isTranslating = false;
        this.pageTranslationState.streamingNodes.clear();
        // 任务结束（成功/失败/取消）后重新启用翻译按钮
        this.setPageControlTranslateDisabled(false);
      }
    } finally {
      this._pageTranslateLocked = false;
    }
    },

    /**
     * 页面级轻量提示（2.5s 自动消失），用于整页翻译未启动等场景的用户反馈
     */
    _showPageToast(message) {
      if (!message) return;
      // 复用已有 toast 则更新文本
      let toast = document.querySelector('.yuxtrans-page-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.className = 'yuxtrans-page-toast';
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      // 重置动画
      toast.classList.remove('is-hide');
      toast.classList.add('is-show');
      clearTimeout(this._pageToastTimer);
      this._pageToastTimer = setTimeout(() => {
        if (!toast) return;
        toast.classList.remove('is-show');
        toast.classList.add('is-hide');
        setTimeout(() => toast && toast.remove(), 250);
      }, 2500);
    },

    /**
    * 获取整页翻译控制条内的元素
    */
    pageControlElement(id) {
      return this.pageControl ? this.pageControl.querySelector(`#${id}`) : null;
    },

    /**
     * 禁用/启用控制条上的「翻译整页/重新翻译」按钮
     * 任务进行期间防止用户重复点击导致套娃翻译
     */
    setPageControlTranslateDisabled(disabled) {
      if (!this.pageControl) return;
      const restoreBtn = this.pageControlElement('yuxtrans-restore-btn');
      if (!restoreBtn) return;
      restoreBtn.disabled = disabled;
      if (disabled) {
        if (restoreBtn.textContent === '翻译整页') {
          restoreBtn.textContent = '翻译中...';
        }
      } else {
        if (restoreBtn.textContent === '翻译中...') {
          restoreBtn.textContent = '翻译整页';
        }
      }
    },

    showPageControl(total) {
      this.hidePageControl();

      const control = document.createElement('div');
      control.className = 'yuxtrans-page-control';
      control.id = 'yuxtrans-page-control';
      // eslint-disable-next-line no-unsanitized/property -- 静态模板，total 为数值
      control.innerHTML = `
        <div class="yuxtrans-page-control-progress">
          <div class="yuxtrans-page-control-progress-bar" id="yuxtrans-progress-bar"
            style="width: 0%"></div>
        </div>
        <span class="yuxtrans-page-control-text" id="yuxtrans-progress-text">
          0 / ${total}
        </span>
        <button type="button" class="yuxtrans-page-control-btn" id="yuxtrans-cancel-btn">取消</button>
        <button type="button" class="yuxtrans-page-control-btn primary" id="yuxtrans-restore-btn"
          style="display:none">恢复原文</button>
        <button type="button" class="yuxtrans-page-control-btn" id="yuxtrans-bilingual-btn"
          style="display:none">双语</button>
        <button type="button" class="yuxtrans-page-control-btn" id="yuxtrans-close-btn"
          style="display:none">关闭</button>
        <details class="yuxtrans-page-control-more" id="yuxtrans-more" style="display:none">
          <summary>更多</summary>
          <div class="yuxtrans-page-control-more-menu">
            <button type="button" class="yuxtrans-page-control-btn secondary" id="yuxtrans-retry-btn"
              style="display:none">重试失败</button>
            <button type="button" class="yuxtrans-page-control-btn secondary" id="yuxtrans-disable-site-btn"
              title="本站禁用扩展">禁用本站</button>
          </div>
        </details>
      `;

      document.body.appendChild(control);
      this.pageControl = control;
      this.pageControlListenersBound = false;

      // 取消按钮
      control.querySelector('#yuxtrans-cancel-btn').addEventListener('click', () => {
        this.pageTranslationState.isTranslating = false;
        this.restoreOriginalTexts();
        this.hidePageControl();
      });
    },

    updatePageControl(current, total, startTime) {
      if (!this.pageControl) return;

      const percent = Math.round((current / total) * 100);
      const bar = this.pageControlElement('yuxtrans-progress-bar');
      const text = this.pageControlElement('yuxtrans-progress-text');

      if (bar) bar.style.width = `${percent}%`;
      if (text) text.textContent = `${current} / ${total} · ${percent}%`;
    },

    showPageControlComplete(
      successCount, totalCount, elapsed, duplicateCount = 0, failCount = 0
    ) {
      if (!this.pageControl) return;

      const hasFailures = failCount > 0;
      const isBilingual = this.config.bilingualMode !== false;
      const cacheHits = this.pageTranslationState.cacheHits || 0;
      const apiCount = this.pageTranslationState.apiCount || 0;

      const textEl = this.pageControlElement('yuxtrans-progress-text');
      if (textEl) {
        const failureText = hasFailures ? ` · 失败 ${failCount}` : '';
        textEl.textContent = `完成 ${successCount}/${totalCount}${failureText} · 缓存 ${cacheHits} / API ${apiCount}`;
      }

      const bar = this.pageControlElement('yuxtrans-progress-bar');
      if (bar) bar.style.width = '100%';

      // 隐藏取消，显示恢复原文、双语切换、关闭
      const cancelBtn = this.pageControlElement('yuxtrans-cancel-btn');
      const restoreBtn = this.pageControlElement('yuxtrans-restore-btn');
      const bilingualBtn = this.pageControlElement('yuxtrans-bilingual-btn');
      const closeBtn = this.pageControlElement('yuxtrans-close-btn');
      const retryBtn = this.pageControlElement('yuxtrans-retry-btn');
      const disableBtn = this.pageControlElement('yuxtrans-disable-site-btn');

      const moreEl = this.pageControlElement('yuxtrans-more');
      const actionPlan = (this.helpers.pageControlCompletedActions
        ? this.helpers.pageControlCompletedActions({ hasFailures })
        : { primary: ['restore', 'bilingual', 'close'], secondary: hasFailures ? ['retry', 'disableSite'] : ['disableSite'] });

      if (cancelBtn) cancelBtn.style.display = 'none';
      if (restoreBtn) restoreBtn.style.display = actionPlan.primary.includes('restore') ? 'inline-block' : 'none';
      if (bilingualBtn) {
        bilingualBtn.style.display = actionPlan.primary.includes('bilingual') ? 'inline-block' : 'none';
        bilingualBtn.textContent = isBilingual ? '仅译文' : '双语';
        // 双语激活态指示（底部暮瞳小短线，见 content.css）
        bilingualBtn.classList.toggle('is-active', isBilingual);
      }
      if (closeBtn) {
        closeBtn.style.display = actionPlan.primary.includes('close') ? 'inline-block' : 'none';
        // 关闭降级为 × 图标
        closeBtn.textContent = '×';
        closeBtn.setAttribute('aria-label', '关闭控制条');
      }
      if (moreEl) moreEl.style.display = actionPlan.secondary.length ? 'inline-block' : 'none';
      if (retryBtn) {
        retryBtn.style.display = actionPlan.secondary.includes('retry') ? 'block' : 'none';
      }
      if (disableBtn) {
        disableBtn.style.display = actionPlan.secondary.includes('disableSite') ? 'block' : 'none';
      }

      // 防止重复绑定
      if (this.pageControlListenersBound) return;
      this.pageControlListenersBound = true;

      // 恢复原文按钮
      if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
          if (this.pageTranslationState.isTranslated) {
            this.restoreOriginalTexts();
            // #54：恢复原文即彻底收尾，控制条与挂耳一并移除
            this.hidePageControl();
          } else {
            // 已恢复状态下再次点击，触发重新翻译
            this.translatePage();
          }
        });
      }

      // 双语/仅译文切换按钮
      if (bilingualBtn) {
        bilingualBtn.addEventListener('click', () => {
          const newMode = this.config.bilingualMode === false;
          this.toggleBilingualMode(newMode);
          bilingualBtn.textContent = newMode ? '仅译文' : '双语';
        });
      }

      if (retryBtn) {
        retryBtn.addEventListener('click', () => this.retryFailedPageItems());
      }

      if (disableBtn) {
        disableBtn.addEventListener('click', () => this.disableCurrentSite());
      }

      // 关闭按钮：#54 不销毁，收起为右缘挂耳，点击可重新展开
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          this.collapsePageControlToTab();
        });
      }

      // 完成 5 秒后收成小 chip，把页面还给读者（hover/focus 临时展开）
      if (this._pageCollapseTimer) clearTimeout(this._pageCollapseTimer);
      this._pageCollapseTimer = setTimeout(() => {
        if (this.pageControl) this.pageControl.classList.add('is-collapsed');
      }, 5000);
    },

    /**
     * 重试整页翻译中失败的节点
     */
    async retryFailedPageItems() {
      const failed = this.pageTranslationState.failedItems || [];
      // #13：动态增量翻译进行中同样视为整页任务在途，避免重试与增量交叉写 DOM
      if (failed.length === 0 || this.pageTranslationState.isTranslating || this._dynamicTranslating) return;

      this.pageTranslationState.isTranslating = true;
      this.setPageControlTranslateDisabled(true);
      const retryBtn = this.pageControlElement('yuxtrans-retry-btn');
      if (retryBtn) {
        retryBtn.disabled = true;
        retryBtn.textContent = '重试中...';
      }

      const remaining = [];
      try {
        for (const item of failed) {
          try {
            const response = await chrome.runtime.sendMessage({
              action: 'translate',
              text: item.text,
              sourceLang: this.config.sourceLang || 'auto',
              targetLang: this.config.targetLang || 'zh',
              context: null
            });
            if (response && response.success) {
              // 清除失败标记后应用译文
              const parent = item.nodeInfo?.node?.parentElement;
              if (parent) parent.classList.remove('yuxtrans-failed');
              this.applyTranslation(item.nodeInfo, response.text);
              if (response.cached) this.pageTranslationState.cacheHits++;
              else this.pageTranslationState.apiCount++;
            } else {
              remaining.push(item);
            }
          } catch (e) {
            remaining.push(item);
          }
        }
        this.pageTranslationState.failedItems = remaining;
        const textEl = this.pageControlElement('yuxtrans-progress-text');
        if (textEl) {
          textEl.textContent = remaining.length
            ? `仍有 ${remaining.length} 条失败 · 缓存 ${this.pageTranslationState.cacheHits} / API ${this.pageTranslationState.apiCount}`
            : `重试完成 · 缓存 ${this.pageTranslationState.cacheHits} / API ${this.pageTranslationState.apiCount}`;
        }
        if (retryBtn) {
          retryBtn.style.display = remaining.length ? 'inline-block' : 'none';
          retryBtn.textContent = '重试失败';
          retryBtn.disabled = false;
        }
      } finally {
        this.pageTranslationState.isTranslating = false;
        this.setPageControlTranslateDisabled(false);
      }
    },

    /**
     * 本站禁用扩展（写入黑名单）
     */
    async disableCurrentSite() {
      const hostname = location.hostname;
      if (!hostname) return;
      try {
        const res = await chrome.runtime.sendMessage({ action: 'disableSite', hostname });
        if (res?.success) {
          this.config.siteRule = res.siteRule || 'blacklist';
          this.config.siteList = res.siteList || [];
          this.restoreOriginalTexts();
          this.hidePageControl();
          // 简短提示
          const tip = document.createElement('div');
          tip.className = 'yuxtrans-page-control';
          tip.textContent = `已禁用本站（${hostname}）`;
          document.body.appendChild(tip);
          setTimeout(() => tip.remove(), 2500);
        }
      } catch (e) {
        console.warn('[YuxTrans] 禁用本站失败:', e);
      }
    },

    /**
     * 将控制条切换到「已恢复原文 / 可重新翻译」状态
     */
    setPageControlRestoredState() {
      if (!this.pageControl) return;

      const textEl = this.pageControlElement('yuxtrans-progress-text');
      const bar = this.pageControlElement('yuxtrans-progress-bar');
      const bilingualBtn = this.pageControlElement('yuxtrans-bilingual-btn');
      const restoreBtn = this.pageControlElement('yuxtrans-restore-btn');
      const closeBtn = this.pageControlElement('yuxtrans-close-btn');

      if (textEl) textEl.textContent = '已恢复原文';
      if (bar) bar.style.width = '0%';
      if (bilingualBtn) bilingualBtn.style.display = 'none';
      if (closeBtn) closeBtn.style.display = 'inline-block';
      if (restoreBtn) {
        restoreBtn.textContent = '翻译整页';
        restoreBtn.classList.remove('primary');
      }
      // 如果此时仍有任务在跑，保持按钮禁用；否则确保可点击
      this.setPageControlTranslateDisabled(this.pageTranslationState.isTranslating);
    },

    /**
     * 核心逻辑：动态切换双语对照与纯译文模式
     */
    /**
     * 重渲染已翻译内容的双语/仅译文呈现（纯 DOM，不写站点偏好）
     * 供 popup 全局模式切换与页面内切换共用
     */
    applyBilingualRender(isBilingual) {
      this.config.bilingualMode = isBilingual;
      for (const [node, data] of this.pageTranslationState.originalTexts) {
        const parent = node.parentElement;
        if (!parent) continue;

        if (isBilingual) {
          if (!data.bilingualNode) {
            node.textContent = data.text;
            const span = document.createElement('span');
            span.className = 'yuxtrans-bilingual-text';
            span.textContent = data.translated;
            if (node.nextSibling) parent.insertBefore(span, node.nextSibling);
            else parent.appendChild(span);
            data.bilingualNode = span;
            // hover 译文联动高亮所在原文块（配对：originalTexts node <-> bilingualNode）
            span.addEventListener('mouseenter', () => parent.classList.add('yuxtrans-pair-hover'));
            span.addEventListener('mouseleave', () => parent.classList.remove('yuxtrans-pair-hover'));
          }
          parent.classList.remove('yuxtrans-translated');
          parent.classList.add('yuxtrans-translated-bilingual');
          // F3：切回双语时应用原文呈现样式
          this._applyOriginalStyle(parent);
        } else {
          if (data.bilingualNode) {
            if (data.bilingualNode.parentNode === parent) {
              parent.removeChild(data.bilingualNode);
            }
            data.bilingualNode = null;
          }
          node.textContent = data.translated;
          parent.classList.remove('yuxtrans-translated-bilingual');
          parent.classList.add('yuxtrans-translated');
          // F3：仅译文模式无原文，移除原文样式类
          parent.classList.remove('yuxtrans-original-fade', 'yuxtrans-original-blur');
        }
      }
    },

    toggleBilingualMode(isBilingual) {
      // 重渲染 DOM（含 F3 原文样式）
      this.applyBilingualRender(isBilingual);

      // 记住当前站点偏好（页面内切换才写；popup 全局切换走 applyBilingualRender 不写）
      const hostname = (location.hostname || '').toLowerCase();
      if (hostname) {
        chrome.runtime.sendMessage({
          action: 'setSiteBilingualMode',
          hostname,
          bilingualMode: isBilingual
        }).catch(() => {});
        if (!this.config.siteModePrefs) this.config.siteModePrefs = {};
        this.config.siteModePrefs[hostname] = { bilingualMode: isBilingual };
      }
    },

    /**
     * 取消进行中的整页/动态翻译：通知 SW abort 在途请求并阻止后续批次。
     */
    cancelPageTranslation() {
      this.pageTranslationState.cancelRequested = true;
      if (this._pageSessionId) {
        try {
          chrome.runtime.sendMessage({ action: 'cancelTranslate', sessionId: this._pageSessionId });
        } catch (e) { /* SW 未就绪忽略 */ }
        this._pageSessionId = null;
      }
      // 放弃 belowFold 视口感知中未提交的项，让 translatePage 的 await 尽快结束
      if (this._viewportCleanup) {
        const cleanup = this._viewportCleanup;
        this._viewportCleanup = null;
        cleanup();
      }
    },

    restoreOriginalTexts() {
      // 若仍有在途翻译（整页主流程或动态增量），先取消，避免恢复原文后继续消耗配额
      if (this.pageTranslationState.isTranslating || this._dynamicTranslating) {
        this.cancelPageTranslation();
      }
      // 清理流式翻译中的临时节点
      if (this.pageTranslationState.streamingNodes) {
        for (const state of this.pageTranslationState.streamingNodes.values()) {
          if (state.tempSpan && state.tempSpan.parentNode) {
            state.tempSpan.remove();
          }
        }
        this.pageTranslationState.streamingNodes.clear();
      }

      // 恢复所有原文和样式
      for (const [node, originalData] of this.pageTranslationState.originalTexts) {
        const parent = node.parentElement;
        if (parent) {
          if (originalData.bilingualNode && originalData.bilingualNode.parentNode === parent) {
            // 清理双语节点
            parent.removeChild(originalData.bilingualNode);
          }
          // 无论是否双语，都恢复原文文本并清除翻译标记
          node.textContent = originalData.text;
          parent.classList.remove('yuxtrans-translated', 'yuxtrans-translated-bilingual', 'yuxtrans-original-fade', 'yuxtrans-original-blur');

          // 清除添加的内联样式
          if (originalData.styles) {
            parent.style.removeProperty('font-weight');
            parent.style.removeProperty('font-style');
          }

          // 清理翻译失败标记样式
          parent.classList.remove('yuxtrans-failed');
        }
      }

      // 重置状态
      this.pageTranslationState.originalTexts.clear();
      this.pageTranslationState.translatedNodes = [];
      this.pageTranslationState.isTranslated = false;
      this._stopDynamicObserver();
      // F1：恢复原文时清理所有悬停翻译块，重置 hover-done 标记，并取消进行中的 hover 状态
      this._cancelHover();
      document.querySelectorAll('.yuxtrans-hover-translation').forEach((b) => b.remove());
      document.querySelectorAll('[data-yxt-hover-done]').forEach((el) => { delete el.dataset.yxtHoverDone; });
      // F4：清理所有已 pin 的浮窗
      this.pinnedPopups.forEach((p) => { if (p.parentNode) p.remove(); });
      this.pinnedPopups = [];
      // #5/#4：对照主浮窗引用与浮窗请求映射同步清理
      this._compareMainPopup = null;
      this._sweepPopupRequests();
    },

    /**
     * 动态内容翻译：整页翻译完成后监听新增 DOM 节点（无限滚动 / SPA 异步加载），
     * 防抖后只对新增子树根调用 collectTextNodes 收集未翻译文本并翻译（Q2，不再全页重扫）。
     * collectTextNodes 已排除 yuxtrans-translated 等标记节点，故只会收集真正新增的未翻译文本。
     */
    _startDynamicObserver() {
      if (this._dynamicObserver || typeof MutationObserver === 'undefined') return;
      this._dynamicObserver = new MutationObserver((muts) => this._onMutations(muts));
      this._dynamicObserver.observe(document.body, { childList: true, subtree: true });
    },

    _stopDynamicObserver() {
      if (this._addedDebounceTimer) {
        clearTimeout(this._addedDebounceTimer);
        this._addedDebounceTimer = null;
      }
      this._pendingAddedRoots.clear();
      if (this._dynamicObserver) {
        this._dynamicObserver.disconnect();
        this._dynamicObserver = null;
      }
    },

    /**
     * 断开 belowFold 视口观察者
     */
    _disconnectViewportObserver() {
      if (this._viewportObserver) {
        this._viewportObserver.disconnect();
        this._viewportObserver = null;
      }
    },

    /**
     * belowFold 视口感知翻译：节点进入视口（200px 预加载区）才提交批次，
     * 取代一次性全提交以节省配额；2s 超时后剩余项回退一次性提交避免 await 卡死。
     * @param {Array} items belowFold 去重后的待译项
     * @param {Function} onBatchResult 每个 batch 完成回调
     * @param {object|null} batchOptions 透传给 translateBatchParallel 的选项（如 { streaming: true }）
     * @returns {Promise<void>}
     */
    _translateBelowFoldViaViewport(items, onBatchResult, batchOptions = null) {
      return new Promise((resolve) => {
        if (!items || items.length === 0) { resolve(); return; }

        // 元素 -> 其下待译项（多文本节点共享同一 parentElement）
        const elementToItems = new Map();
        for (const item of items) {
          const el = item.nodeInfo && item.nodeInfo.node && item.nodeInfo.node.parentElement;
          if (!el) continue;
          if (!elementToItems.has(el)) elementToItems.set(el, []);
          elementToItems.get(el).push(item);
        }
        if (elementToItems.size === 0) { resolve(); return; }

        const pending = new Set(items);
        let pendingBatch = [];
        let submitTimer = null;
        let fallbackTimer = null;
        let activeBatches = 0;
        let resolved = false;

        const finish = () => {
          if (resolved) return;
          resolved = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (submitTimer) clearTimeout(submitTimer);
          this._viewportCleanup = null;
          this._disconnectViewportObserver();
          resolve();
        };

        // 取消回调：放弃未提交项，在途批次自行结束后 finish
        this._viewportCleanup = () => {
          pending.clear();
          pendingBatch = [];
          if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
          if (submitTimer) { clearTimeout(submitTimer); submitTimer = null; }
          if (activeBatches === 0) finish();
        };

        const submit = async () => {
          if (pendingBatch.length === 0) { finish(); return; }
          const batch = pendingBatch;
          pendingBatch = [];
          activeBatches++;
          try {
            if (!this.pageTranslationState.cancelRequested && this.pageTranslationState.isTranslating) {
              await this.translateBatchParallel(batch, null, onBatchResult, batchOptions || {});
            }
          } catch (e) { /* 单批异常不中断整体 */ }
          activeBatches--;
          finish();
        };

        // 超时回退：2s 后把视口外剩余项一次性提交，避免用户不滚动导致 await 卡死
        fallbackTimer = setTimeout(() => {
          for (const it of pending) pendingBatch.push(it);
          pending.clear();
          if (!submitTimer) submit();
        }, YuxContentConsts.VIEWPORT_FALLBACK_MS);

        this._viewportObserver = new IntersectionObserver((entries) => {
          if (this.pageTranslationState.cancelRequested || resolved) return;
          let added = false;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const its = elementToItems.get(entry.target);
              if (its) {
                for (const it of its) {
                  if (pending.has(it)) { pendingBatch.push(it); pending.delete(it); added = true; }
                }
                this._viewportObserver.unobserve(entry.target);
              }
            }
          }
          if (added && !submitTimer) {
            submitTimer = setTimeout(() => { submitTimer = null; submit(); }, YuxContentConsts.VIEWPORT_SUBMIT_DEBOUNCE_MS);
          }
        }, { rootMargin: YuxContentConsts.VIEWPORT_ROOT_MARGIN });

        for (const el of elementToItems.keys()) this._viewportObserver.observe(el);
      });
    },

    _onMutations(mutations) {
      if (!this.pageTranslationState.isTranslated) return;
      // 主翻译或上一轮动态翻译进行中时，忽略自身插入译文节点触发的 mutation
      if (this._isProcessingAdded || this._dynamicTranslating || this.pageTranslationState.isTranslating) return;
      // #9：全部新增节点都位于自有 UI（.yuxtrans-* 容器）内时直接忽略，
      // 不进防抖与扫描（浮窗/悬停译文/控制条等自身 UI 不触发增量翻译）
      // Q2：同时收集新增子树根，防抖后只扫这些子树而非全页重扫
      let hasAdded = false;
      for (const m of mutations) {
        for (const n of (m.addedNodes || [])) {
          const el = n.nodeType === 1 ? n : n.parentElement;
          if (el && typeof el.closest === 'function' && !el.closest('[class*="yuxtrans-"]')) {
            hasAdded = true;
            this._pendingAddedRoots.add(el);
          }
        }
      }
      if (!hasAdded) return;
      clearTimeout(this._addedDebounceTimer);
      this._addedDebounceTimer = setTimeout(() => {
        this._processAddedNodes();
      }, YuxContentConsts.ADDED_NODES_DEBOUNCE_MS);
    },

    async _processAddedNodes() {
      if (!this.pageTranslationState.isTranslated) return;
      // #13：动态增量翻译改用独立标志，不占用整页主流程 isTranslating，
      // 消除「增量翻译中按 Ctrl+Shift+P 被当作取消整页」的边缘情况
      if (this._dynamicTranslating || this.pageTranslationState.isTranslating) return;
      this._dynamicTranslating = true;
      this._isProcessingAdded = true;
      try {
        // Q2：只扫描防抖窗口内新增的子树根（无限滚动/SPA 局部更新），
        // 取代全页重扫 body——大页面下从 O(页面) 降为 O(新增子树)。
        // 已断开连接的根跳过；被其他根包含的嵌套根去重，避免重复扫描。
        const roots = [...this._pendingAddedRoots];
        this._pendingAddedRoots.clear();
        const effectiveRoots = roots.filter((r, i) =>
          r.isConnected !== false &&
          !roots.some((other, j) => j !== i && other !== r && typeof other.contains === 'function' && other.contains(r))
        );
        // collectTextNodes 的 acceptNode 已排除 yuxtrans-translated 等标记节点，
        // 因此结果只含动态新增（或之前失败未标记）的未翻译文本
        const nodesInfo = [];
        for (const r of effectiveRoots) {
          nodesInfo.push(...await this.collectTextNodes(r));
        }
        const seen = new Set();
        const items = [];
        for (const ni of nodesInfo) {
          // 跳过已翻译或已失败的节点，避免重复请求
          if (this.pageTranslationState.originalTexts.has(ni.node)) continue;
          if (seen.has(ni.text)) continue;
          seen.add(ni.text);
          items.push({ text: ni.text, nodeInfo: ni });
        }
        if (items.length === 0) return;
        // 动态增量翻译与整页主路径同一开关：enableStreaming 开启时逐段流式渲染
        const useStreaming = this.config.enableStreaming !== false;
        await this.translateBatchParallel(items, null, (_idx, nodes, results) => {
          results.forEach((res, i) => {
            if (res && res.success) this.applyTranslation(nodes[i].nodeInfo, res.text);
          });
        }, useStreaming ? { streaming: true } : {});
      } catch (e) {
        console.error('[YuxTrans] 动态内容翻译异常:', e);
      } finally {
        this._dynamicTranslating = false;
        this._isProcessingAdded = false;
      }
    },

    /**
     * 输出整页翻译结构化性能指标，便于真实浏览器环境验证优化效果。
     * 数据会同时打印到内容脚本控制台，用户可复制粘贴给开发侧分析。
     */
    logPageMetrics(metrics) {
      const report = {
        event: 'YuxTrans.pageTranslation.complete',
        timestamp: new Date().toISOString(),
        ...metrics
      };
      console.log('[YuxTrans] 整页翻译完成:', report);
    },

    hidePageControl() {
      if (this._pageCollapseTimer) {
        clearTimeout(this._pageCollapseTimer);
        this._pageCollapseTimer = null;
      }
      if (this.pageControl) {
        this.pageControl.remove();
        this.pageControl = null;
      }
      this.removeSideTab();
    },

    /**
     * #54：关闭控制条不销毁，收起为贴右缘的竖向挂耳；
     * 控制条仅隐藏并保留引用，进度/统计/按钮状态在重新展开时原样恢复
     */
    collapsePageControlToTab() {
      if (this._pageCollapseTimer) {
        clearTimeout(this._pageCollapseTimer);
        this._pageCollapseTimer = null;
      }
      if (!this.pageControl) return;
      this.pageControl.style.display = 'none';
      this.removeSideTab();

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'yuxtrans-side-tab';
      tab.textContent = '译';
      tab.setAttribute('aria-label', '展开整页翻译控制条');
      tab.title = '展开整页翻译控制条';
      tab.addEventListener('click', () => this.expandPageControlFromTab());
      document.body.appendChild(tab);
      this.sideTab = tab;
    },

    /**
     * #54：点击挂耳重新展开原控制条（状态保持），挂耳自身移除
     */
    expandPageControlFromTab() {
      this.removeSideTab();
      if (this.pageControl) {
        this.pageControl.style.display = '';
      }
    },

    removeSideTab() {
      if (this.sideTab) {
        this.sideTab.remove();
        this.sideTab = null;
      }
    }
  });
})();
