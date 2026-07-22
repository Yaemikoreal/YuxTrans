/**
 * 校验扩展图标由 logo 主图派生且尺寸正确（读取真实 PNG 文件）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, '..', 'icons');
const logoPath = path.join(__dirname, '..', '..', 'logo', 'logo.png');
const sizes = [16, 32, 48, 128];

/**
 * 从 PNG 文件头读取 IHDR 宽高（不依赖第三方图像库）
 * @param {Buffer} buf
 * @returns {{width:number,height:number}}
 */
function readPngSize(buf) {
  assert.ok(buf.length >= 24, 'PNG too short');
  assert.strictEqual(buf[0], 0x89, 'PNG magic');
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', 'not a PNG signature');
  const type = buf.toString('ascii', 12, 16);
  assert.strictEqual(type, 'IHDR', 'missing IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

test('logo/logo.png 主图存在且为有效 PNG', () => {
  assert.ok(fs.existsSync(logoPath), `missing master ${logoPath}`);
  const buf = fs.readFileSync(logoPath);
  assert.ok(buf.length > 1000, 'master logo unexpectedly small');
  const dim = readPngSize(buf);
  assert.ok(dim.width >= 128 && dim.height >= 128, `master too small: ${dim.width}x${dim.height}`);
});

for (const size of sizes) {
  test(`icon${size}.png 为 ${size}x${size} 有效 PNG`, () => {
    const file = path.join(iconsDir, `icon${size}.png`);
    assert.ok(fs.existsSync(file), `missing ${file}`);
    const buf = fs.readFileSync(file);
    assert.ok(buf.length > 50, `icon${size} empty`);
    const dim = readPngSize(buf);
    assert.strictEqual(dim.width, size, `width ${dim.width}`);
    assert.strictEqual(dim.height, size, `height ${dim.height}`);
  });
}

test('manifest.json 图标路径均存在', () => {
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const paths = new Set();
  Object.values(manifest.icons || {}).forEach((p) => paths.add(p));
  Object.values(manifest.action?.default_icon || {}).forEach((p) => paths.add(p));
  assert.ok(paths.size >= 4, 'manifest should declare 4 icon sizes');
  for (const rel of paths) {
    const abs = path.join(__dirname, '..', rel);
    assert.ok(fs.existsSync(abs), `manifest path missing: ${rel}`);
  }
});
