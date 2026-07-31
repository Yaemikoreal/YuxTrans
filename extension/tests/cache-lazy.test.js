/**
 * Q3 缓存冷热两级单元测试：内存热缓存（32MB LRU）+ IndexedDB 冷数据按需回查。
 * 使用持久化 IndexedDB mock（__enablePersistence）模拟冷数据仅存在于 DB 的场景。
 */

const test = require('node:test');
const assert = require('node:assert');

require('./mock-chrome.js');
global.indexedDB.__enablePersistence(true);
const bg = require('../background.js');

const CACHE_STORE = 'translations'; // 与 background.js 的 CACHE_STORE 一致

const seedCold = (key, value) => {
  global.indexedDB.__getStore(CACHE_STORE)._data.set(key, { key, value, timestamp: Date.now() });
};

test('Q3 getFromCache：内存未命中回查 IndexedDB 冷数据并提升为热条目', async () => {
  const src = 'The quick brown fox jumps over the lazy dog';
  const value = '敏捷的棕色狐狸跳过了懒狗。';
  const key = bg.generateCacheKey(src, 'en', 'zh');
  seedCold(key, value);

  const before = bg.__cacheInternals();
  const hit = await bg.getFromCache(key);
  assert.strictEqual(hit, value, '冷数据命中返回译文');
  const after = bg.__cacheInternals();
  assert.ok(after.size > before.size, '命中后提升为内存热条目');

  // 二次命中走内存：删掉底层 DB 记录后仍应命中
  global.indexedDB.__getStore(CACHE_STORE)._data.delete(key);
  assert.strictEqual(await bg.getFromCache(key), value, '提升后二次命中不再依赖 DB');
});

test('Q3 getFromCache：旧版本冷数据判无效，不提升不命中', async () => {
  const key = 'v2:p1:qwen-turbo:en:zh:normal:this is a long enough sentence';
  seedCold(key, '这是一个足够长的测试句子');
  const before = bg.__cacheInternals();
  const hit = await bg.getFromCache(key);
  assert.strictEqual(hit, null, '旧版本冷数据不命中');
  assert.strictEqual(bg.__cacheInternals().size, before.size, '无效冷数据不进入内存');
});

test('Q3 getFromCache：DB 中不存在时返回 null', async () => {
  const key = bg.generateCacheKey('A sentence that was never cached anywhere', 'en', 'zh');
  assert.strictEqual(await bg.getFromCache(key), null);
});

test('Q3 setToCache：新写入计入全量统计并可立即从内存命中', async () => {
  const src = 'Cache write-through test sentence for Q3';
  const value = '用于 Q3 的缓存写入测试句子。';
  const key = bg.generateCacheKey(src, 'en', 'zh');
  const before = bg.__cacheInternals();
  await bg.setToCache(key, value);
  const after = bg.__cacheInternals();
  assert.strictEqual(after.totalCacheCount, before.totalCacheCount + 1, '总量计数 +1');
  assert.strictEqual(
    after.totalCacheBytes,
    before.totalCacheBytes + key.length * 2 + value.length * 2,
    '总量字节按 UTF-16 估算增加'
  );
  assert.strictEqual(await bg.getFromCache(key), value, '写入后立即命中');
});
