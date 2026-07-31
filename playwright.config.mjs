// Playwright 配置：仅用于扩展 E2E 冒烟（加载 MV3 扩展的真实 Chromium）。
// 注意：headed 模式运行（MV3 内容脚本/Service Worker 需要完整浏览器环境），
// 本地直接 `npm run test:e2e`；Linux/CI 需 xvfb（如 `xvfb-run npm run test:e2e`）。

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  timeout: 60_000,
  workers: 1, // 扩展级测试串行，避免多实例争用
  reporter: 'list',
  use: {
    actionTimeout: 10_000,
  },
});
