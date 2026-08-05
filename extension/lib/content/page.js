/**
 * 整页翻译 / 动态增量 / 整页控制条方法（content 拆分模块）
 * 依赖：content.js 先注入（YuxTransContent 类）
 */
(function () {
  const Ctor = (typeof YuxTransContent !== 'undefined' ? YuxTransContent : null)
    || (typeof globalThis !== 'undefined' ? globalThis.YuxTransContent : null);
  if (!Ctor) return;

  // v2.1 段落对照：译文聚合的块级容器保守选择器（找不到匹配祖先则回退行内注脚）
  const BLOCK_TR_CONTAINER_SELECTOR =
    'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, dd, dt, figcaption, summary';
  // compareDocumentPosition 掩码常量（Node 全局在测试 mock 中可能缺常量定义）
  const POS_FOLLOWING = 4;
  const POS_PRECEDING = 2;

  Object.assign(Ctor.prototype, {
    /**
     * 流式翻译单个段落（整页流式路径的最小单元，逐段渲染）
     * 过程：插入临时 span → SW 经 streamChunk 消息按 requestId 推送 fullText 实时刷新 →
     * 最终响应到达后移除临时 span，由 applyTranslation 落为双语/仅译文节点。
     * v2.1 段落对照（bilingualStyle=block）时临时 span 挂在所在块的 block-tr 内，
     * 找不到块容器则退回行内流式。
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

      // v2.1：段落对照模式下流式译文直接流入所在块的 block-tr（找不到块退回行内流式）
      const streamBlockEl = this._useBlockStyle() ? this._findBlockContainer(node) : null;
      if (streamBlockEl) {
        const entry = this._ensureBlockTr(streamBlockEl);
        entry.el.appendChild(tempSpan);
      } else if (node.nextSibling) {
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
          // v2.1：流式超时未落地译文时，清理可能残留的空 block-tr
          if (streamBlockEl) this._pruneBlockTr(streamBlockEl);
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
              } else if (streamBlockEl) {
                // v2.1：取消后译文不落地，清理可能残留的空 block-tr
                this._pruneBlockTr(streamBlockEl);
              }
              resolve({ success: !cancelled, text: response.text, cached: response.cached });
            } else {
              // v2.1：流式失败未落地译文时，清理可能残留的空 block-tr
              if (streamBlockEl) this._pruneBlockTr(streamBlockEl);
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
     * 收集可翻译的文本节点并按块容器聚合为段落，按可视区域排序（粒度：段落）。
     * Q1：两阶段执行——TreeWalker 先纯收集（不触发布局），再分批读取 getBoundingClientRect，
     * 批间让出主线程，避免大页面数千节点连续同步布局读取造成启动长卡顿。
     * W1：过滤后的文本节点按所属块容器聚合——同一块内的节点按 DOM 序拼接为段落文本，
     * 记录 nodeSpans 偏移映射，句子不再被 <a>/<b> 等内联标签切碎。
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
              '.yuxtrans-block-tr', // v2.1：段落对照译文块不被再次收集翻译
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

      // W1：按块容器聚合为段落（过滤规则不变，粒度由文本节点换成段落）
      const paragraphs = this._groupNodesIntoParagraphs(nodes);

      // 排序：可视区域优先（段落粒度——段内任一节点可视即段可视）
      paragraphs.sort((a, b) => {
        if (a.isInViewport && !b.isInViewport) return -1;
        if (!a.isInViewport && b.isInViewport) return 1;
        return a.rect.top - b.rect.top; // 按页面位置排序
      });

      return paragraphs;
    },

    /**
     * W1：把过滤后的文本节点按所属块容器聚合为段落。
     * 分组键：_findBlockContainer 命中的块级容器；无块容器时回退父元素。
     * 组内节点按 DOM 序以单空格拼接为段落文本（避免内联标签切碎句子、
     * 也避免直接拼接造成的词粘连），并记录 nodeSpans 偏移映射供句级拆分与回写。
     * @param {Array} nodes - [{ node, text, isInViewport, rect }]（DOM 序）
     * @returns {Array} 段落数组 [{ text, sentences, nodes, node, nodeSpans, isInViewport, rect, blockEl }]
     */
    _groupNodesIntoParagraphs(nodes) {
      const groups = new Map(); // containerEl -> paragraph
      const paragraphs = [];
      for (const info of nodes) {
        const blockEl = this._findBlockContainer(info.node);
        const key = blockEl || info.node.parentElement;
        if (!key) continue;
        let p = groups.get(key);
        if (!p) {
          p = {
            text: '',
            sentences: [],
            nodes: [],
            node: null, // 段首节点（兼容旧调用方按 node 取父元素）
            nodeSpans: [],
            isInViewport: false,
            rect: null,
            blockEl: blockEl || null
          };
          groups.set(key, p);
          paragraphs.push(p);
        }
        const start = p.text.length + (p.text ? 1 : 0); // 组内拼接的单空格计入偏移
        p.text += (p.text ? ' ' : '') + info.text;
        p.nodeSpans.push({ node: info.node, start, end: start + info.text.length });
        p.nodes.push(info.node);
        if (!p.node) p.node = info.node;
        // 段内任一节点可视即段可视
        if (info.isInViewport) p.isInViewport = true;
        if (!p.rect) p.rect = info.rect;
      }
      for (const p of paragraphs) {
        // rect 取块容器位置（无块容器时沿用段内首个节点 rect）
        if (p.blockEl && typeof p.blockEl.getBoundingClientRect === 'function') {
          const r = p.blockEl.getBoundingClientRect();
          p.rect = { top: r.top, bottom: r.bottom };
        }
        // W4：段内预切句（供超长段落句级拆分与句级译文回写）
        p.sentences = this._splitSentences(p.text, p.nodeSpans);
      }
      return paragraphs;
    },

    /**
     * W4：段落预切句——按句末标点（. ! ? 。！？）切分，后续引号/右括号归属前句。
     * 白名单防护：常见英文缩写（Dr./Mr./e.g./i.e./etc./vs./U.S. 等）、数字小数点（3.14）、
     * 省略号（.../…）不切。返回 [{ text, start, end, nodeSpans }]，start/end 为段内偏移，
     * nodeSpans 记录该句覆盖的节点及节点内偏移（供句级译文回写定位）。
     */
    _splitSentences(text, nodeSpans) {
      if (!text) return [];
      // 常见英文缩写白名单（小写、含内部点写法），其句点不作句末
      const ABBR = new Set([
        'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
        'e.g', 'i.e', 'u.s', 'u.k', 'u.n', 'ph.d', 'm.d', 'b.a', 'm.a',
        'a.m', 'p.m', 'no', 'fig', 'cf', 'ca', 'approx', 'est',
        'inc', 'ltd', 'co', 'vol', 'pp', 'ed', 'al'
      ]);
      // 句末标点后归属前句的引号/右括号
      const CLOSERS = '\'"”’)]}》〉」』';
      const len = text.length;
      const boundaries = []; // 各句的结束偏移（不含尾随空白）
      let i = 0;
      while (i < len) {
        const ch = text[i];
        const isCjkEnd = ch === '。' || ch === '！' || ch === '？';
        const isAsciiDot = ch === '.';
        const isAsciiBang = ch === '!' || ch === '?';
        if (!isCjkEnd && !isAsciiDot && !isAsciiBang) { i++; continue; }

        if (isAsciiDot) {
          // 省略号（...）内部不切
          if ((i + 1 < len && text[i + 1] === '.') || (i > 0 && text[i - 1] === '.')) { i++; continue; }
          // 数字小数点（3.14）不切
          if (i > 0 && i + 1 < len && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) { i++; continue; }
          // 英文缩写白名单：取点前的字母词（允许内部带点，如 U.S. / e.g.）
          let j = i - 1;
          while (j >= 0 && /[A-Za-z.]/.test(text[j])) j--;
          const token = text.slice(j + 1, i).replace(/^\.+|\.+$/g, '').toLowerCase();
          if (token && ABBR.has(token)) { i++; continue; }
        }
        // 吸收后续引号/右括号
        let end = i + 1;
        while (end < len && CLOSERS.includes(text[end])) end++;
        // ASCII 句点要求句末紧跟空白或文本结尾（防 mid-word 误切）；
        // CJK 标点与 !? 后直接成句（CJK 行文句后常无空白）
        if (isAsciiDot && end < len && !/\s/.test(text[end])) { i++; continue; }
        boundaries.push(end);
        i = end;
      }
      // 末尾无句末标点的余段归入最后一句
      if (boundaries.length === 0 || boundaries[boundaries.length - 1] < len) {
        boundaries.push(len);
      }
      // 由边界生成句条目并映射 nodeSpans（节点内偏移）
      const sentences = [];
      let prev = 0;
      for (const rawEnd of boundaries) {
        let start = prev;
        let end = rawEnd;
        prev = rawEnd;
        while (start < end && /\s/.test(text[start])) start++;
        while (end > start && /\s/.test(text[end - 1])) end--;
        if (end <= start) continue;
        const spans = [];
        for (const ns of (nodeSpans || [])) {
          const s = Math.max(start, ns.start);
          const e = Math.min(end, ns.end);
          if (e > s) spans.push({ node: ns.node, start: s - ns.start, end: e - ns.start });
        }
        sentences.push({ text: text.slice(start, end), start, end, nodeSpans: spans });
      }
      return sentences;
    },

    /**
     * W4：段落展开为发送条目——段落文本超过句级阈值且可切多句时拆为句条目
     * （每句一条、带段落归属引用；SW 逐条缓存，句级缓存粒度自动生效），否则整段一条。
     * @returns {Array} [{ text, nodeInfo }]，句级条目的 nodeInfo 带 isSentence/paragraph/sentence 引用
     */
    _expandToEntries(paragraph) {
      const threshold = YuxContentConsts.SENTENCE_SPLIT_THRESHOLD_CHARS;
      if (paragraph && paragraph.text && paragraph.text.length > threshold &&
          paragraph.sentences && paragraph.sentences.length > 1) {
        return paragraph.sentences
          .filter((s) => s.nodeSpans && s.nodeSpans.length > 0)
          .map((s) => ({
            text: s.text,
            nodeInfo: {
              isSentence: true,
              paragraph,
              sentence: s,
              node: s.nodeSpans[0].node,
              text: s.text,
              isInViewport: !!paragraph.isInViewport
            }
          }));
      }
      return [{ text: paragraph.text, nodeInfo: paragraph }];
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

      // 动态调整：本地模型强制串行，云端模型维持高并发。
      // 流式模式每条请求是一个 SSE 长连接（存活时间远长于批量短请求），并发过高会迅速
      // 堆满连接并触发供应商 429；SW 侧自适应速率上限为 10 并发（RATE_LIMIT_CONFIG.MAX_CONCURRENT），
      // 故整页流式云端固定 4 并发（与首屏 viewportConcurrency 持平，并为划词流式等请求留余量），
      // 本地 Ollama 与批量路径一致保持串行。
      const concurrency = isLocal
        ? 1
        : streaming
          ? (options.concurrency || 4)
          : (options.concurrency || configConcurrency);

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

      // W2：装填层收敛——content 层不再按固定条数硬打包。
      // 云端：段落/句条目数组整体作为一次 translateBatch 发给 SW（SW 侧按字符数二次切分装填）；
      // 本地 Ollama：逐段单发（并发=1 串行），连续失败降级拆单逻辑保留兜底。
      const batches = [];
      if (isLocal) {
        for (let i = 0; i < items.length; i++) {
          batches.push({ indices: [i], nodes: [items[i]] });
        }
      } else if (items.length > 0) {
        batches.push({ indices: items.map((_, i) => i), nodes: items.slice() });
      }

      const queue = [...batches.keys()];

      let failsInARow = 0;
      let fallbackMode = false; // 是否已进入单句翻译降级模式

      const worker = async () => {
        // #13：整页主流程（isTranslating）或动态增量（_dynamicTranslating）任一活跃即继续
        while (queue.length > 0 && (this.pageTranslationState.isTranslating || this._dynamicTranslating) && !this.pageTranslationState.cancelRequested) {
          const batchIndex = queue.shift();
          const batch = batches[batchIndex];

          // 如果进入了降级模式，且当前 batch 包含多项，则将其重新拆分为单个段落（或句级条目）送回队列
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
                  // 页面上下文仅以「风格参考」身份注入 SW 的 system prompt（buildBatchSystemPrompt），
                  // 不进入 user 输入，避免早期版本把片段偏向页面标题的污染问题。
                  context: { pageTitle: document.title, domain: location.hostname },
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
     * hover 译文联动高亮所在原文块（配对：originalTexts node <-> bilingualNode）
     * 初始创建（applyTranslation）与模式切换重渲染（applyBilingualRender）两处共用
     */
    _bindPairHover(bilingualSpan, parent) {
      bilingualSpan.addEventListener('mouseenter', () => parent.classList.add('yuxtrans-pair-hover'));
      bilingualSpan.addEventListener('mouseleave', () => parent.classList.remove('yuxtrans-pair-hover'));
    },

    /**
     * v2.1：当前是否按「段落对照」呈现（双语开 + bilingualStyle=block）
     */
    _useBlockStyle() {
      return this.config.bilingualMode !== false && this.config.bilingualStyle === 'block';
    },

    /**
     * v2.1：为文本节点找最近的块级容器（保守选择器）；找不到返回 null → 调用方回退行内模式
     */
    _findBlockContainer(node) {
      const parent = node && node.parentElement;
      if (!parent || typeof parent.closest !== 'function') return null;
      return parent.closest(BLOCK_TR_CONTAINER_SELECTOR);
    },

    /**
     * v2.1：取（或创建）块容器末尾的 div.yuxtrans-block-tr。
     * 结构：div.yuxtrans-block-tr > span.yuxtrans-block-tr-body（聚合译文）；
     * 流式期间临时 span.yuxtrans-streaming-text 亦挂在此 div 内，body 刷新不触碰流式节点。
     */
    _ensureBlockTr(blockEl) {
      let entry = this._blockTrMap.get(blockEl);
      if (entry && entry.el.parentNode) return entry;
      const div = document.createElement('div');
      div.className = 'yuxtrans-block-tr';
      const body = document.createElement('span');
      body.className = 'yuxtrans-block-tr-body';
      div.appendChild(body);
      blockEl.appendChild(div);
      entry = { el: div, body, nodes: new Set() };
      this._blockTrMap.set(blockEl, entry);
      blockEl.classList.add('yuxtrans-translated-block');
      // pair-hover：hover 段落译文块联动高亮原文块（与行内同一思路）
      this._bindPairHover(div, blockEl);
      return entry;
    },

    /**
     * v2.1：块容器无已译节点且无在途流式节点时移除空 block-tr，避免残留空壳
     */
    _pruneBlockTr(blockEl) {
      const entry = this._blockTrMap.get(blockEl);
      if (!entry) return;
      if (entry.nodes.size > 0) return;
      // 真实 DOM 的 childNodes 是 NodeList（无 .some），统一用 for 循环判定
      let hasStreaming = false;
      for (const c of entry.el.childNodes) {
        if (c.className === 'yuxtrans-streaming-text') { hasStreaming = true; break; }
      }
      if (hasStreaming) return;
      if (entry.el.parentNode) entry.el.remove();
      this._blockTrMap.delete(blockEl);
      blockEl.classList.remove('yuxtrans-translated-block');
    },

    /**
     * W5：段落的展示译文——句级条目时按句序拼接已译句（未完成的句跳过），否则整段译文
     */
    _paragraphDisplayText(data) {
      if (data.sentenceTranslated && data.sentenceTranslated.size > 0) {
        const parts = [];
        for (const s of (data.paragraph.sentences || [])) {
          const t = data.sentenceTranslated.get(s);
          if (t) parts.push(t);
        }
        if (parts.length > 0) return parts.join(' ');
      }
      return typeof data.translated === 'string' ? data.translated : '';
    },

    /**
     * v2.1：按 DOM 顺序聚合块内全部已译段落的译文（空格连接）写入 body
     * W5：聚合粒度由文本节点换成段落（originalTexts 键为段落对象）
     */
    _refreshBlockTr(blockEl) {
      const entry = this._blockTrMap.get(blockEl);
      if (!entry) return;
      const parts = [];
      for (const [paragraph, data] of this.pageTranslationState.originalTexts) {
        if (data.blockContainer !== blockEl) continue;
        const text = this._paragraphDisplayText(data);
        if (text) parts.push({ node: paragraph.nodes[0], text });
      }
      parts.sort((a, b) => {
        if (typeof a.node.compareDocumentPosition !== 'function') return 0;
        const pos = a.node.compareDocumentPosition(b.node);
        if (pos & POS_FOLLOWING) return -1;
        if (pos & POS_PRECEDING) return 1;
        return 0;
      });
      entry.body.textContent = parts.map((p) => p.text).join(' ');
    },

    /**
     * v2.1：段落译文纳入所在块的聚合呈现（块容器→段落映射维护于此）
     */
    _applyBlockTranslation(paragraph, blockEl, originalData) {
      originalData.blockContainer = blockEl;
      const entry = this._ensureBlockTr(blockEl);
      entry.nodes.add(paragraph);
      this._refreshBlockTr(blockEl);
    },

    /**
     * v2.1：段落从块聚合中摘除（切仅译文/行内双语/恢复原文前置）；空块随之清理
     */
    _removeFromBlock(paragraph, data) {
      const blockEl = data.blockContainer;
      data.blockContainer = null;
      if (!blockEl) return;
      const entry = this._blockTrMap.get(blockEl);
      if (!entry) return;
      entry.nodes.delete(paragraph);
      if (entry.nodes.size === 0) {
        if (entry.el.parentNode) entry.el.remove();
        this._blockTrMap.delete(blockEl);
        blockEl.classList.remove('yuxtrans-translated-block');
      } else {
        this._refreshBlockTr(blockEl);
      }
    },

    /**
     * W5：清理段落的已渲染呈现，恢复为原文态（幂等）。
     * 供 applyTranslation 重绘、applyBilingualRender 模式切换、restoreOriginalTexts 共用。
     */
    _cleanParagraphRender(paragraph, data) {
      // 移除行内双语 span（段落级 + 句级）
      if (data.bilingualNode) {
        if (data.bilingualNode.parentNode) data.bilingualNode.remove();
        data.bilingualNode = null;
      }
      if (data.sentenceSpans) {
        for (const span of data.sentenceSpans.values()) {
          if (span.parentNode) span.remove();
        }
        data.sentenceSpans = null;
      }
      // 从块聚合摘除（空块随之清理）
      if (data.blockContainer) this._removeFromBlock(paragraph, data);
      // 恢复段内节点原文
      if (data.nodeTexts) {
        paragraph.nodes.forEach((n, idx) => {
          if (idx < data.nodeTexts.length) n.textContent = data.nodeTexts[idx];
        });
      }
      // 清理标记类与原文样式类
      const markEl = data.markEl || paragraph.blockEl ||
        (paragraph.nodes[0] && paragraph.nodes[0].parentElement);
      if (markEl && markEl.classList) {
        markEl.classList.remove(
          'yuxtrans-translated', 'yuxtrans-translated-bilingual',
          'yuxtrans-original-fade', 'yuxtrans-original-blur', 'yuxtrans-failed'
        );
      }
      data.markEl = null;
    },

    /**
     * W5：按目标模式渲染段落译文（假定 DOM 已为原文态，配合 _cleanParagraphRender 使用）。
     * 三种呈现：block 聚合块尾 block-tr；inline 段落级/句级 span 插到段末/句末节点后；
     * replace 译文写入段首节点（句级写句首节点）、同段（句）其余节点置空。
     * @param {object} paragraph - 段落对象
     * @param {object} data - originalTexts 中的段落数据
     * @param {boolean} isBilingual - 双语（true）或仅译文（false）
     */
    _renderParagraph(paragraph, data, isBilingual) {
      const firstNode = paragraph.nodes[0];
      const parent = firstNode && firstNode.parentElement;
      if (!parent) return;
      const wantBlock = isBilingual && this.config.bilingualStyle === 'block';
      const blockEl = wantBlock ? (paragraph.blockEl || this._findBlockContainer(firstNode)) : null;
      // 标记类挂在块容器上（无块容器时挂段首节点父元素）
      const markEl = blockEl || paragraph.blockEl || parent;
      data.markEl = markEl;
      const hasSentences = !!(data.sentenceTranslated && data.sentenceTranslated.size > 0);

      if (isBilingual && blockEl) {
        // 段落对照模式：不插行内 span，译文聚合到块容器末尾的 block-tr
        if (this._paragraphDisplayText(data)) {
          this._applyBlockTranslation(paragraph, blockEl, data);
        }
        markEl.classList.add('yuxtrans-translated-bilingual');
        // F3：原文呈现样式（弱化/模糊原文）
        this._applyOriginalStyle(markEl);
        return;
      }

      if (isBilingual) {
        // 双语对照模式（行内注脚）：句级条目逐句插 span 到句末节点后，否则整段插到段末节点后
        const insertSpanAfter = (anchorNode, text) => {
          const anchorParent = anchorNode && anchorNode.parentElement;
          if (!anchorParent) return null;
          const span = document.createElement('span');
          span.className = 'yuxtrans-bilingual-text';
          span.textContent = text;
          if (anchorNode.nextSibling) anchorParent.insertBefore(span, anchorNode.nextSibling);
          else anchorParent.appendChild(span);
          // pair-hover：hover 译文联动高亮句/段原文所在块（无块容器时高亮锚点父元素）
          this._bindPairHover(span, paragraph.blockEl || anchorParent);
          return span;
        };
        if (hasSentences) {
          data.sentenceSpans = new Map();
          for (const s of paragraph.sentences) {
            const text = data.sentenceTranslated.get(s);
            if (!text) continue;
            const anchor = s.nodeSpans[s.nodeSpans.length - 1].node;
            const span = insertSpanAfter(anchor, text);
            if (span) data.sentenceSpans.set(s, span);
          }
        } else if (data.translated) {
          const anchor = paragraph.nodes[paragraph.nodes.length - 1];
          data.bilingualNode = insertSpanAfter(anchor, data.translated);
        }
        markEl.classList.add('yuxtrans-translated-bilingual');
        // F3：原文呈现样式（弱化/模糊原文）
        this._applyOriginalStyle(markEl);
        return;
      }

      // 仅译文模式：译文写入段首节点（句级写句首节点）、同段（句）其余节点置空。
      // 段内 <a> 的 href 不动，锚文本随译文替换（已确认的取舍）。
      // 按句序处理，避免共享节点（句末/句首跨节点）被后到的句覆盖。
      if (hasSentences) {
        for (const s of paragraph.sentences) {
          const text = data.sentenceTranslated.get(s);
          if (!text) continue;
          s.nodeSpans[0].node.textContent = text;
          for (let k = 1; k < s.nodeSpans.length; k++) {
            s.nodeSpans[k].node.textContent = '';
          }
        }
      } else if (data.translated) {
        paragraph.nodes[0].textContent = data.translated;
        for (let k = 1; k < paragraph.nodes.length; k++) {
          paragraph.nodes[k].textContent = '';
        }
      }
      markEl.classList.add('yuxtrans-translated');
    },

    /**
     * 应用翻译结果，保持样式。
     * W5：最小单位为段落（nodeInfo 为段落对象）或句级条目
     * （nodeInfo.isSentence，带 paragraph/sentence 引用）；originalTexts 键为段落对象。
     */
    applyTranslation(nodeInfo, translatedText) {
      const isSentence = !!nodeInfo.isSentence;
      const paragraph = isSentence ? nodeInfo.paragraph : nodeInfo;
      // 兼容旧节点粒度输入（动态路径/测试遗留的 { text, node } 形状）：补全段落结构
      if (!paragraph.nodes) {
        paragraph.nodes = paragraph.node ? [paragraph.node] : [];
        paragraph.nodeSpans = paragraph.nodeSpans ||
          (paragraph.node ? [{ node: paragraph.node, start: 0, end: (paragraph.text || '').length }] : []);
        paragraph.sentences = paragraph.sentences || [];
        if (typeof paragraph.blockEl === 'undefined') paragraph.blockEl = null;
      }

      // 防止对同一段落（或同一句）重复应用（例如批量回调与最终循环重叠）
      let originalData = this.pageTranslationState.originalTexts.get(paragraph);
      if (originalData && originalData.error) {
        // 失败重试成功：清除失败标记条目，按新翻译落地
        if (originalData.markEl && originalData.markEl.classList) {
          originalData.markEl.classList.remove('yuxtrans-failed');
        }
        this.pageTranslationState.originalTexts.delete(paragraph);
        originalData = null;
      }
      if (!isSentence && originalData) return false;
      if (isSentence && originalData && originalData.sentenceTranslated &&
          originalData.sentenceTranslated.has(nodeInfo.sentence)) {
        return false;
      }

      const firstNode = paragraph.nodes[0];
      const parent = firstNode && firstNode.parentElement;
      if (!parent) return false;

      // 首次落地：保存原文、样式和呈现引用（W5：键为段落对象）
      if (!originalData) {
        originalData = {
          paragraph,
          text: paragraph.text,
          nodeTexts: paragraph.nodes.map((n) => n.textContent), // 段内各节点原文（恢复用）
          translated: null, // 段落级译文（支持动态切换）
          sentenceTranslated: null, // Map<sentence, text>：句级译文（W4 超长段拆分）
          styles: this.getElementStyles(parent),
          bilingualNode: null, // 段落级行内注脚 span
          sentenceSpans: null, // Map<sentence, span>：句级行内注脚 span
          blockContainer: null, // v2.1：段落对照模式下所属的块容器元素
          markEl: null // 承载 yuxtrans-translated* 标记类的元素
        };
        this.pageTranslationState.originalTexts.set(paragraph, originalData);
        this.pageTranslationState.translatedNodes.push(...paragraph.nodes);
      }

      if (isSentence) {
        if (!originalData.sentenceTranslated) originalData.sentenceTranslated = new Map();
        originalData.sentenceTranslated.set(nodeInfo.sentence, translatedText);
      } else {
        originalData.translated = translatedText;
      }

      // 清理旧呈现后按当前模式重渲染（句级条目增量到达时幂等重绘）
      this._cleanParagraphRender(paragraph, originalData);
      this._renderParagraph(paragraph, originalData, this.config.bilingualMode !== false);

      // 保持样式（W5：适配到段首节点 parent）
      const styles = originalData.styles;
      if (styles) {
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
      // W5：标记类挂在 data.markEl 上（块容器或段首节点父元素）
      for (const [, data] of this.pageTranslationState.originalTexts) {
        const el = data && data.markEl;
        if (el && el.classList.contains('yuxtrans-translated-bilingual')) {
          this._applyOriginalStyle(el);
        }
      }
    },

    /**
     * 标记翻译失败的段落（W5：originalTexts 键为段落对象）
     */
    markFailedNode(nodeInfo, error) {
      const paragraph = nodeInfo.isSentence ? nodeInfo.paragraph : nodeInfo;
      if (!paragraph.nodes) {
        paragraph.nodes = paragraph.node ? [paragraph.node] : [];
      }
      const firstNode = paragraph.nodes[0];
      const parent = firstNode && firstNode.parentElement;
      if (!parent) return;

      // 仅当未被标记过才保存原文，防止覆盖已有错误记录
      if (!this.pageTranslationState.originalTexts.has(paragraph)) {
        const markEl = paragraph.blockEl || parent;
        markEl.classList.add('yuxtrans-failed');
        this.pageTranslationState.originalTexts.set(paragraph, {
          paragraph,
          text: paragraph.text,
          nodeTexts: paragraph.nodes.map((n) => n.textContent),
          styles: this.getElementStyles(parent),
          markEl,
          error: error
        });
      }
    },

    /**
     * 整页翻译主函数
     */
    async translatePage() {
      // 同步锁：防止快速重复触发（如双击、消息重入）导致套娃翻译。
      // 任务进行中再次触发：取消在途翻译并恢复原文（快捷键/右键/控制条的切换语义），
      // 不再静默忽略——此前持锁直接 return，连点表现为"无响应"。
      if (this._pageTranslateLocked) {
        if (this.pageTranslationState.isTranslating || this._dynamicTranslating) {
          this.restoreOriginalTexts();
          this.setPageControlRestoredState();
          this._showPageToast('已终止翻译并恢复原文');
        }
        return;
      }
      this._pageTranslateLocked = true;

      try {
        // 每次触发都重新拉取配置，确保模式开关实时生效
        await this.loadConfig();

        // 站点规则控制
        if (!this.isSiteAllowed()) {
          this._showPageToast('本站已禁用 YuxTrans 翻译');
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

      // 收集期间收到终止请求（popup 终止翻译 / 重入取消）：直接退出，不启动本轮任务
      if (this.pageTranslationState.cancelRequested) return;

      // 初始化状态
      this.pageTranslationState.translatedNodes = [];
      this.pageTranslationState.isTranslating = true;
      this.pageTranslationState.cancelRequested = false;
      this.pageTranslationState.originalTexts.clear();
      this.pageTranslationState.streamingNodes.clear();
      this.pageTranslationState.failedItems = [];
      this.pageTranslationState.cacheHits = 0;
      this.pageTranslationState.apiCount = 0;
      // 分配本轮会话 id，供 SW 侧取消链路使用。
      // 必须全局唯一：实例级计数器在多标签页/页面重载后会撞号，
      // 撞上 SW 侧已取消会话（cancelTranslationSession 记录保留在 Map 中）会导致新任务被静默取消。
      this._pageSessionId = 'yxt-page-' + Date.now().toString(36) + '-' +
        Math.random().toString(36).slice(2, 8) + '-' + (++this._pageSessionCounter);

      // 禁用控制条上的翻译/重新翻译按钮，防止任务进行中重复点击
      this.setPageControlTranslateDisabled(true);

      // ===== 文本去重优化 =====
      // W4：超长段落（> SENTENCE_SPLIT_THRESHOLD_CHARS）先拆为句级条目再参与去重与发送，
      // 实现句级缓存粒度（SW 逐条缓存，自动生效）；普通段落整段一条
      const entries = [];
      for (const paragraph of nodesInfo) {
        entries.push(...this._expandToEntries(paragraph));
      }

      const uniqueTexts = new Map(); // text -> { indices: [], translation: null, error: null }
      const dedupedItems = [];
      let duplicateCount = 0;

      entries.forEach((entry, index) => {
        const text = entry.text;
        if (uniqueTexts.has(text)) {
          // 记录重复文本的索引
          uniqueTexts.get(text).indices.push(index);
          duplicateCount++;
        } else {
          // 新文本
          uniqueTexts.set(text, { indices: [index], translation: null, error: null });
          dedupedItems.push({ text, originalIndex: index, nodeInfo: entry.nodeInfo });
        }
      });

      // 区分首屏与后续段落
      const viewportItems = dedupedItems.filter(item => item.nodeInfo.isInViewport);
      const belowFoldItems = dedupedItems.filter(item => !item.nodeInfo.isInViewport);

      const displayTotal = nodesInfo.length;
      this.showPageControl(displayTotal);
      const startTime = Date.now();
      let completedUnits = 0;

      const reportProgress = (delta) => {
        completedUnits += delta;
        // W4：去重以句/段条目计，展示以段落计；比率换算后封顶到段落总数
        const ratio = dedupedItems.length > 0 ? entries.length / dedupedItems.length : 1;
        const actualCompleted = Math.min(Math.round(completedUnits * ratio), displayTotal);
        this.updatePageControl(actualCompleted, displayTotal, startTime);
      };

      try {
        // A: 首屏段落优先翻译（W2：云端整批一次 translateBatch，SW 按字符数二次切分）
        const isLocal = this.config.provider === 'local';
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
              // 批次完成立即渲染，保证首屏感知
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
              : { concurrency: viewportConcurrency }
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
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const nodeInfo = entry.nodeInfo;
          const paragraph = nodeInfo.isSentence ? nodeInfo.paragraph : nodeInfo;
          const item = uniqueTexts.get(entry.text);
          if (item.translation) {
            // 每个段落/句条目都尝试应用译文，确保重复文本的每个出现位置也纳入 originalTexts，
            // 从而支持双语/仅译文切换时同步更新所有出现位置
            const applied = this.applyTranslation(nodeInfo, item.translation);
            if (applied || this.pageTranslationState.originalTexts.has(paragraph)) {
              if (!appliedTexts.has(entry.text)) {
                successCount++;
                appliedTexts.add(entry.text);
              }
            }
          } else if (item.error) {
            // 失败项可视化标记
            this.markFailedNode(nodeInfo, item.error);
            this.pageTranslationState.failedItems.push({ nodeInfo, text: entry.text, error: item.error });
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

      // Stage F：控制条挂进 shadow host，bottom/right 定位由 host 承载
      const { host, root } = this.createShadowHost('yuxtrans-host-page-control');
      control._yxtHost = host;
      root.appendChild(control);
      document.body.appendChild(host);
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
          // 简短提示（复用页面级 toast；原借用 yuxtrans-page-control 类的裸 div 在 Stage F
          // 剥离页面级定位后已无法自定位，故收敛到既有 toast 机制）
          this._showPageToast(`已禁用本站（${hostname}）`);
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
      // W5：段落粒度重渲染——每段先清理回原文态，再按目标模式重绘（幂等）
      for (const [paragraph, data] of this.pageTranslationState.originalTexts) {
        if (data.error) continue; // 失败标记条目不参与重渲染
        this._cleanParagraphRender(paragraph, data);
        this._renderParagraph(paragraph, data, isBilingual);
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

      // 恢复所有原文和样式（W5：originalTexts 键为段落对象，逐段清理呈现并恢复节点原文）
      for (const [paragraph, originalData] of this.pageTranslationState.originalTexts) {
        this._cleanParagraphRender(paragraph, originalData);

        // 清除添加的内联样式（段首节点父元素）
        if (originalData.styles) {
          const parent = paragraph.nodes[0] && paragraph.nodes[0].parentElement;
          if (parent) {
            parent.style.removeProperty('font-weight');
            parent.style.removeProperty('font-style');
          }
        }
      }

      // v2.1：段落对照模式——移除全部 block-tr 元素，确保恢复原文后无残留空壳
      for (const [blockEl, entry] of this._blockTrMap) {
        if (entry.el.parentNode) entry.el.remove();
        blockEl.classList.remove('yuxtrans-translated-block');
      }
      this._blockTrMap.clear();

      // 重置状态
      this.pageTranslationState.originalTexts.clear();
      this.pageTranslationState.translatedNodes = [];
      this.pageTranslationState.isTranslated = false;
      this._stopDynamicObserver();
      // F1：恢复原文时清理所有悬停翻译块，重置 hover-done 标记，并取消进行中的 hover 状态
      this._cancelHover();
      // Stage F：悬停译文块在 shadow host 内，document 直查类名不可达，改由 _hoverBlocks 引用清理
      for (const host of this._hoverBlocks) {
        if (host.parentNode) host.remove();
      }
      this._hoverBlocks.clear();
      document.querySelectorAll('[data-yxt-hover-done]').forEach((el) => { delete el.dataset.yxtHoverDone; });
      // F4：清理所有已 pin 的浮窗（连同 shadow host）
      this.pinnedPopups.forEach((p) => this._removeFloatingUI(p));
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
          if (pendingBatch.length === 0) {
            // 没有待翻译项：仅当全部处理完才结束，否则继续等待 viewport observer
            if (pending.size === 0 && activeBatches === 0) finish();
            return;
          }
          const batch = pendingBatch;
          pendingBatch = [];
          activeBatches++;
          try {
            if (!this.pageTranslationState.cancelRequested && this.pageTranslationState.isTranslating) {
              await this.translateBatchParallel(batch, null, onBatchResult, batchOptions || {});
            }
          } catch (e) { /* 单批异常不中断整体 */ }
          activeBatches--;
          // await 期间 fallback/observer 可能又添加了新项到 pendingBatch，继续处理避免遗留
          if (pendingBatch.length > 0) {
            submit();
            return;
          }
          // 全部完成才结束；pending 还有项时继续等待 viewport observer 触发新批次
          if (pending.size === 0 && activeBatches === 0) {
            finish();
          }
        };

        // 超时回退：6s 后把视口外剩余项一次性提交，避免用户不滚动导致 await 卡死
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
          // 跳过已翻译或已失败的段落，避免重复请求（W5：originalTexts 键为段落对象）
          if (this.pageTranslationState.originalTexts.has(ni)) continue;
          const pNodes = ni.nodes || (ni.node ? [ni.node] : []);
          if (pNodes.some((n) => this.pageTranslationState.translatedNodes.includes(n))) continue;
          // W4：超长段落拆为句级条目（与整页主路径同规则）
          for (const entry of this._expandToEntries(ni)) {
            if (seen.has(entry.text)) continue;
            seen.add(entry.text);
            items.push({ text: entry.text, nodeInfo: entry.nodeInfo });
          }
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
        this._removeFloatingUI(this.pageControl);
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
      // Stage F：收起只隐藏 shadow host（内部 display:none 亦可，但 host 层面更彻底）
      (this.pageControl._yxtHost || this.pageControl).style.display = 'none';
      this.removeSideTab();

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'yuxtrans-side-tab';
      tab.textContent = '译';
      tab.setAttribute('aria-label', '展开整页翻译控制条');
      tab.title = '展开整页翻译控制条';
      tab.addEventListener('click', () => this.expandPageControlFromTab());
      // Stage F：挂耳挂进 shadow host，右缘定位与垂直居中 transform 由 host 承载
      const { host, root } = this.createShadowHost('yuxtrans-host-side-tab');
      tab._yxtHost = host;
      root.appendChild(tab);
      document.body.appendChild(host);
      this.sideTab = tab;
    },

    /**
     * #54：点击挂耳重新展开原控制条（状态保持），挂耳自身移除
     */
    expandPageControlFromTab() {
      this.removeSideTab();
      if (this.pageControl) {
        (this.pageControl._yxtHost || this.pageControl).style.display = '';
      }
    },

    removeSideTab() {
      if (this.sideTab) {
        this._removeFloatingUI(this.sideTab);
        this.sideTab = null;
      }
    }
  });
})();
