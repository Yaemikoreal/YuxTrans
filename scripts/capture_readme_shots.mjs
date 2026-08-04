/**
 * README 截图重拍脚本（UI v2.1）
 * 用法：node scripts/capture_readme_shots.mjs
 * 以 mock chrome API 渲染 popup（配置完整态）与 options，覆盖 logo/ 下对应样例图。
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_MOCK = `
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '0.6.0' }),
      openOptionsPage: () => Promise.resolve(),
      sendMessage: (msg) => {
        switch (msg && msg.action) {
          case 'getConfig':
            return Promise.resolve({ activeProfileId: 'p1', bilingualMode: true, enableStreaming: true,
              profiles: [{ id: 'p1', provider: 'deepseek' }] });
          case 'getProfiles':
            return Promise.resolve({ success: true, profiles: [
              { id: 'p1', provider: 'deepseek', model: 'deepseek-v4-flash' },
              { id: 'p2', provider: 'qwen', model: 'qwen-turbo' },
              { id: 'p3', provider: 'local', localModel: 'qwen2.5:7b' }
            ] });
          case 'checkConnection':
            return Promise.resolve({ success: true });
          case 'getCacheStats':
            return Promise.resolve({ success: true,
              usage: { sessionTokens: 18320, totalTokens: 245000, totalCount: 128, cacheHits: 96 },
              stats: { wordCount: 342 } });
          case 'setActiveProfile':
          case 'setConfig':
            return Promise.resolve({ success: true });
          default:
            return Promise.resolve({});
        }
      },
      lastError: null
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1 }]),
      sendMessage: () => Promise.resolve({})
    }
  };
`;

(async () => {
  const browser = await chromium.launch();

  // Popup：320px 面板，mock 出配置完整、已连接、有统计的状态
  const popup = await browser.newPage({ viewport: { width: 360, height: 560 } });
  await popup.addInitScript(CHROME_MOCK);
  await popup.goto('file://' + path.join(ROOT, 'extension', 'popup.html').replace(/\\/g, '/'));
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(ROOT, 'logo', '使用样例-弹窗板.png') });
  await popup.close();

  // Options：静态渲染即可（chrome API 缺失不影响布局）
  const options = await browser.newPage({ viewport: { width: 1294, height: 913 } });
  await options.goto('file://' + path.join(ROOT, 'extension', 'options.html').replace(/\\/g, '/'));
  await options.waitForTimeout(800);
  await options.screenshot({ path: path.join(ROOT, 'logo', '使用样例-设置.png') });

  // 「翻译偏好」tab：options.js 依赖 chrome API 无法真实切换，直接 DOM 层切换显隐
  try {
    await options.evaluate(() => {
      document.querySelectorAll('.tab-content').forEach((el) => { el.hidden = true; el.classList.remove('active'); });
      const target = document.querySelector('#tab-preference');
      if (target) { target.hidden = false; target.classList.add('active'); }
      document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === 'preference'));
    });
    await options.waitForTimeout(400);
    const visible = await options.isVisible('#tab-preference');
    if (visible) {
      await options.screenshot({ path: path.join(ROOT, 'logo', '使用样例-设置-2.png') });
      console.log('preference tab captured');
    } else {
      console.log('preference tab not visible, keep old 设置-2');
    }
  } catch (e) {
    console.log('preference tab switch failed, keep old 设置-2:', e.message);
  }

  await browser.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
