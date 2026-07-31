// ESLint 扁平配置（ESLint 9+）
// 目标：为 1.3 万行手写 JS 建立静态守门——核心是把「用户输入必须转义」从人肉守门
// 变为机器守门（no-unsanitized，防 S2 类 options 页 XSS 回归）。
// 策略：no-undef 与 no-unsanitized 为 error；其余推荐规则先以 warn 接入，逐步收紧。

import js from '@eslint/js';
import globals from 'globals';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

// 扩展跨文件共享的全局符号（manifest 按序注入 content scripts / SW importScripts）
const extensionShared = {
  chrome: 'readonly',
  YuxTransHelpers: 'writable', // lib/product-helpers.js 定义
  YuxTransContent: 'writable', // content.js 定义（lib/content/* 拆分模块挂原型）
  YuxContentConsts: 'readonly', // lib/content/constants.js 定义（content 侧运行时调优常量，D1c 收编）
  SW: 'writable',              // background.js 内聚命名空间
  YuxTransSW: 'writable',      // lib/sw/bootstrap.js 挂载的全局命名空间
  PROVIDER_NAMES: 'readonly',  // common.js 定义（options/popup 共享）
  loadModels: 'readonly',      // 历史遗留防御性引用（options.js typeof 守卫，定义已不存在）
  scheduler: 'readonly',       // window.scheduler（Chrome 115+，content.js Q1 yield）
};

const legacyWarnings = {
  'no-unused-vars': 'warn',
  'no-empty': 'warn',
  'no-constant-condition': 'warn',
  'no-prototype-builtins': 'warn',
  'no-useless-escape': 'warn',
  'no-redeclare': 'warn',
  'no-fallthrough': 'warn',
  'no-async-promise-executor': 'warn',
  'no-cond-assign': 'warn',
  'no-control-regex': 'warn',
  'no-global-assign': 'warn',
  'no-useless-assignment': 'warn',
  'no-unreachable': 'warn',
  'preserve-caught-error': 'warn',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'yuxtrans-promo/**',
      'docs/**',
      'logo/**',
      'scripts/**',
    ],
  },

  // 扩展运行时代码（SW / content / popup / options / lib）
  {
    files: ['extension/**/*.js'],
    ignores: ['extension/tests/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...extensionShared,
        // 双加载模式（SW importScripts / Node require）兼容符号
        module: 'writable',
        require: 'readonly',
        importScripts: 'readonly',
      },
    },
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      ...js.configs.recommended.rules,
      ...legacyWarnings,
      'no-undef': 'error',
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },

  // 扩展单元测试（Node test runner + 自带 DOM/chrome mock）
  {
    files: ['extension/tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...extensionShared,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...legacyWarnings,
      'no-undef': 'error',
    },
  },
];
