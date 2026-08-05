/**
 * YuxTrans 扩展 E2E：整页翻译全链路
 * 链路：真实 Chromium 加载 MV3 扩展 → 本地 mock Ollama（localhost:11434）→
 *   配置 local 档案 → 派发 translatePage → 断言双语译文落页。
 * 另覆盖：任务进行中重触发（连点）取消恢复、popup 终止翻译、模式切换即时重渲染。
 * mock 覆盖 message.content 与 choices[0].message.content 两种解析路径；
 * 复用 manifest host_permissions 中已授权的 localhost:11434，无需额外权限。
 */

import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../extension');

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>YuxTrans Page E2E Fixture</title></head>
<body>
  <article>
    <p id="para">Deep reading requires long stretches of uninterrupted attention on foreign text.</p>
    <p id="para2">A good translation tool should respect the rhythm of the original paragraph.</p>
  </article>
</body>
</html>`;

const PARA1_SRC = 'Deep reading requires long stretches of uninterrupted attention on foreign text.';
const PARA1_TGT = '深度阅读需要长时间不受干扰地专注于外语文本。';

const MOCK_TRANSLATIONS = {
  [PARA1_SRC]: PARA1_TGT,
  'A good translation tool should respect the rhythm of the original paragraph.':
    '好的翻译工具应当尊重原文段落的节奏。'
};

let pageServer;
let mockApi;
let baseUrl;
let context;
let mockHits = 0;
let mockDelayMs = 0; // >0 时 mock 延迟响应，让任务保持在途（供取消/连点用例）
let mockDelayQueue = []; // 逐请求延迟队列（优先于 mockDelayMs），用于构造"部分译文已落地"场景

test.beforeAll(async () => {
  pageServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${pageServer.address().port}`;

  // mock Ollama：解析请求体中的 Input JSON 数组，按原文映射返回译文数组
  mockApi = http.createServer((req, res) => {
    mockHits++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let translated = [];
      try {
        const payload = JSON.parse(body);
        const userMsg = (payload.messages || []).find((m) => m.role === 'user');
        const m = userMsg && userMsg.content.match(/Input:\n(\[[\s\S]*)$/);
        const inputs = m ? JSON.parse(m[1]) : [];
        translated = inputs.map((t) => MOCK_TRANSLATIONS[t] || `[译]${t}`);
      } catch { /* 保持空数组兜底 */ }
      const content = JSON.stringify(translated);
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: { role: 'assistant', content },
          choices: [{ message: { role: 'assistant', content } }],
          done: true
        }));
      };
      const delay = mockDelayQueue.length > 0 ? mockDelayQueue.shift() : mockDelayMs;
      if (delay > 0) setTimeout(respond, delay);
      else respond();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      mockApi.once('error', reject);
      // 不指定 host（双栈监听），localhost 无论解析到 ::1 还是 127.0.0.1 都能命中
      mockApi.listen(11434, resolve);
    });
  } catch (e) {
    test.skip(true, `127.0.0.1:11434 被占用（可能有真实 Ollama 在运行），跳过整页 e2e：${e.message}`);
    return;
  }

  context = await chromium.launchPersistentContext('', {
    headless: false, // MV3 扩展需要完整浏览器环境
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
});

test.afterAll(async () => {
  if (context) await context.close();
  if (pageServer) await new Promise((resolve) => pageServer.close(resolve));
  if (mockApi) await new Promise((resolve) => mockApi.close(resolve));
});

// ===== 公共助手 =====

function getSw() {
  return context.serviceWorkers()[0] || context.waitForEvent('serviceworker');
}

// 经扩展页（options）向 SW 发送 setConfig；页面主世界无 chrome.runtime，借扩展页做消息通道
async function sendConfig(cfg) {
  const sw = await getSw();
  const extId = new URL(sw.url()).host;
  const optPage = await context.newPage();
  try {
    await optPage.goto(`chrome-extension://${extId}/options.html`);
    const res = await optPage.evaluate(async (c) => {
      const r = await chrome.runtime.sendMessage({ action: 'setConfig', config: c });
      return r && r.success;
    }, cfg);
    return res;
  } finally {
    await optPage.close();
  }
}

function baseProfileConfig(extra = {}) {
  const profile = {
    id: 'local:mock-e2e',
    provider: 'local',
    apiKey: '',
    apiEndpoint: '',
    model: '',
    localModel: 'qwen2:7b',
    customProvider: { name: '', endpoint: '', apiKey: '', format: 'openai', model: '' },
    savedAt: Date.now()
  };
  return {
    profiles: [profile],
    activeProfileId: profile.id,
    provider: 'local',
    localModel: 'qwen2:7b',
    targetLang: 'zh',
    sourceLang: 'auto',
    bilingualMode: true,
    bilingualStyle: 'inline',
    enableStreaming: false,
    ...extra
  };
}

// 经 SW 向当前活动标签页派发消息并返回响应（调用前需先 bringToFront 目标页）
async function dispatchToActiveTab(msg) {
  const sw = await getSw();
  return sw.evaluate(async (m) => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return { __error: 'no active tab' };
    try {
      return await chrome.tabs.sendMessage(tabs[0].id, m);
    } catch (e) {
      return { __error: String(e && e.message || e) };
    }
  }, msg);
}

async function openFixturePage() {
  const page = await context.newPage();
  await page.goto(baseUrl);
  // 等内容脚本完成配置加载（getConfig 往返）
  await page.waitForTimeout(1200);
  await page.bringToFront();
  return page;
}

// ===== 用例 =====

test('整页翻译：mock 后端 → 派发 translatePage → 双语译文落页', async () => {
  test.skip(!context, 'mock API 未启动（端口被占用）');
  const page = await openFixturePage();

  expect(await sendConfig(baseProfileConfig())).toBe(true);
  await page.bringToFront(); // sendConfig 的 options 页关闭后焦点归位，确保派发到测试页

  const dispatched = await dispatchToActiveTab({ action: 'translatePage' });
  expect(dispatched && dispatched.success).toBe(true);

  // 双语模式（行内注脚）：译文 span 落到段落后
  const consoleLogs = [];
  page.on('console', (msg) => consoleLogs.push(msg.text()));
  const bilingual = page.locator('.yuxtrans-bilingual-text');
  try {
    await expect(bilingual.first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('body')).toContainText(PARA1_TGT, { timeout: 15000 });
  } catch (e) {
    console.log(`[e2e 诊断] mock 命中次数=${mockHits}`);
    console.log('[e2e 诊断] 页面控制台:', consoleLogs.slice(-15).join('\n'));
    throw e;
  }
  await page.close();
});

test('连点/终止：任务进行中重触发取消并恢复原文，终止翻译停止在途并恢复原文', async () => {
  test.skip(!context, 'mock API 未启动（端口被占用）');
  mockDelayMs = 2500; // 让任务保持在途
  try {
    // --- 场景 1：任务进行中再次触发 translatePage（连点）→ 取消并恢复原文 ---
    const page1 = await openFixturePage();
    // cacheEnabled:false 保证任务真实在途（不受既有缓存影响）
    expect(await sendConfig(baseProfileConfig({ cacheEnabled: false }))).toBe(true);
    await page1.bringToFront();

    const d1 = await dispatchToActiveTab({ action: 'translatePage' });
    expect(d1 && d1.success).toBe(true);
    await page1.waitForTimeout(400); // 等任务进入在途状态
    const st1 = await dispatchToActiveTab({ action: 'getPageTranslationState' });
    expect(st1.isTranslating).toBe(true);

    // 连点第二次：应取消在途任务并恢复原文（而不是静默无响应）
    await dispatchToActiveTab({ action: 'translatePage' });
    await page1.waitForTimeout(mockDelayMs + 1500); // 等延迟响应到达窗口过后
    expect(await page1.locator('.yuxtrans-bilingual-text').count()).toBe(0);
    await expect(page1.locator('#para')).toHaveText(PARA1_SRC);
    const st1After = await dispatchToActiveTab({ action: 'getPageTranslationState' });
    expect(st1After.isTranslating).toBe(false);
    await page1.close();

    // --- 场景 2：popup「终止翻译」→ 停止在途任务并恢复原文（含已落地译文）---
    const page2 = await openFixturePage();
    expect(await sendConfig(baseProfileConfig({ cacheEnabled: false }))).toBe(true);
    await page2.bringToFront();
    // 本地逐段单发：第一段立即返回落地，第二段延迟在途——覆盖"部分译文已渲染时终止"
    mockDelayQueue = [0, 2500];
    const d2 = await dispatchToActiveTab({ action: 'translatePage' });
    expect(d2 && d2.success).toBe(true);
    // 等第一段译文落地（行内注脚出现）后再终止
    await expect(page2.locator('.yuxtrans-bilingual-text').first()).toBeVisible({ timeout: 10000 });

    const cancelRes = await dispatchToActiveTab({ action: 'cancelPageTranslation' });
    expect(cancelRes && cancelRes.success).toBe(true);
    await page2.waitForTimeout(3000); // 等第二段延迟响应窗口过后
    // 已落地译文被清理、恢复原文
    expect(await page2.locator('.yuxtrans-bilingual-text').count()).toBe(0);
    await expect(page2.locator('#para')).toHaveText(PARA1_SRC);
    const st2After = await dispatchToActiveTab({ action: 'getPageTranslationState' });
    expect(st2After.isTranslating).toBe(false);
    await page2.close();
  } finally {
    mockDelayMs = 0;
    mockDelayQueue = [];
  }
});

test('模式切换：popup 流（setConfig + applyBilingualMode）即时重渲染 仅译文 ⟷ 双语', async () => {
  test.skip(!context, 'mock API 未启动（端口被占用）');
  const page = await openFixturePage();
  expect(await sendConfig(baseProfileConfig())).toBe(true);
  await page.bringToFront();

  // 双语模式完成整页翻译
  await dispatchToActiveTab({ action: 'translatePage' });
  const bilingual = page.locator('.yuxtrans-bilingual-text');
  await expect(bilingual.first()).toBeVisible({ timeout: 15000 });

  // 模拟 popup 切「仅译文」：setConfig（触发 content onChanged→loadConfig 竞态路径）+ applyBilingualMode
  expect(await sendConfig(baseProfileConfig({ bilingualMode: false }))).toBe(true);
  await page.bringToFront();
  await dispatchToActiveTab({ action: 'applyBilingualMode', bilingualMode: false });

  // 行内注脚消失，段首节点直接呈现译文（仅译文模式）
  await expect(bilingual).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('#para')).toHaveText(PARA1_TGT);

  // 切回「双语」：注脚 span 重新出现，原文恢复
  expect(await sendConfig(baseProfileConfig({ bilingualMode: true }))).toBe(true);
  await page.bringToFront();
  await dispatchToActiveTab({ action: 'applyBilingualMode', bilingualMode: true });
  await expect(bilingual.first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#para')).toContainText(PARA1_SRC);
  await page.close();
});
