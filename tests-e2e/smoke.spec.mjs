/**
 * YuxTrans 扩展 E2E 冒烟测试
 * 链路：真实 Chromium 加载 MV3 扩展 → 打开测试页 → 模拟 Ctrl+划选 → 断言翻译浮窗出现。
 * 不依赖任何翻译后端：浮窗在发起请求前即以「翻译中」加载态渲染，
 * 因此本测试只验证「扩展注入 → 配置加载 → 触发链路 → 浮窗 UI」这一核心通路。
 */

import { test, expect, chromium } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../extension');

// file:// 下扩展默认无访问权（需手动开启），故用本地 HTTP 服务提供测试页
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>YuxTrans E2E Fixture</title></head>
<body>
  <article>
    <p id="para">Deep reading requires long stretches of uninterrupted attention on foreign text.</p>
  </article>
</body>
</html>`;

let server;
let baseUrl;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('冒烟：加载扩展 → Ctrl+划选 → 划词浮窗出现且结构完整', async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false, // MV3 扩展需要完整浏览器环境
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const page = await context.newPage();
    await page.goto(baseUrl);

    // 等内容脚本完成配置加载（getConfig 往返）
    await page.waitForTimeout(1500);

    // 模拟 Ctrl+划选：程序化选中段落文本，再派发带 ctrlKey 的 mouseup
    await page.evaluate(() => {
      const p = document.querySelector('#para');
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, ctrlKey: true, detail: 1, clientX: 100, clientY: 100,
      }));
    });

    const popup = page.locator('.yuxtrans-popup');
    await expect(popup).toBeVisible({ timeout: 8000 });
    // 浮窗结构：标题栏（语言对 · 供应商，内容随配置）+ 原文区（显示选中文本）
    await expect(popup.locator('.yuxtrans-popup-title')).not.toBeEmpty();
    await expect(popup.locator('.yuxtrans-source')).toContainText('Deep reading requires');
  } finally {
    await context.close();
  }
});
