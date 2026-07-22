# YuxTrans 扩展图标

源文件：仓库根目录 `logo/logo.png`（产品主视觉）。

本目录由主图裁切圆角书页主体后，经 LANCZOS 缩放生成：

| 文件 | 尺寸 | 用途 |
|------|------|------|
| `icon16.png` | 16×16 | 工具栏 / favicon 级 |
| `icon32.png` | 32×32 | Windows 任务栏等 |
| `icon48.png` | 48×48 | 扩展管理页、Popup/Options 品牌标 |
| `icon128.png` | 128×128 | 商店与 README 主图 |

`manifest.json` 中 `action.default_icon` 与顶层 `icons` 均指向上述路径。

重新生成（需 Pillow）：

```bash
python scripts/generate_extension_icons.py
```

设计说明：狸花猫页边探头 + 暮瞳批注竖条 + 暖纸底，与「书房衬纸」UI 一致。请勿回退为旧版蓝底「Y」或 Ayx 字标。
