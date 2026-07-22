#!/usr/bin/env python3
"""从 logo/logo.png 生成 extension/icons 下 16/32/48/128 PNG。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise SystemExit("需要 Pillow：pip install Pillow") from exc

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "logo" / "logo.png"
OUT_DIR = ROOT / "extension" / "icons"
SIZES = (16, 32, 48, 128)
CREAM = (245, 241, 234, 255)


def near_bg(px: tuple, bg: tuple, thr: int = 22) -> bool:
    """判断像素是否接近背景色。"""
    return all(abs(px[i] - bg[i]) <= thr for i in range(3))


def crop_card(src: Image.Image) -> Image.Image:
    """裁切主图标卡片（去掉大面积留白与软阴影外缘）。"""
    w, h = src.size
    bg = src.getpixel((2, 2))
    xs: list[int] = []
    ys: list[int] = []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if not near_bg(src.getpixel((x, y)), bg, 22):
                xs.append(x)
                ys.append(y)
    if not xs:
        return src
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    pad = 8
    minx = max(0, minx - pad)
    miny = max(0, miny - pad)
    maxx = min(w - 1, maxx + pad)
    maxy = min(h - 1, maxy + pad)
    side = max(maxx - minx + 1, maxy - miny + 1)
    cx = (minx + maxx) // 2
    cy = (miny + maxy) // 2
    half = side // 2
    left = max(0, cx - half)
    top = max(0, cy - half)
    right = min(w, left + side)
    bottom = min(h, top + side)
    left = max(0, right - side)
    top = max(0, bottom - side)
    return src.crop((left, top, right, bottom))


def flatten_on_cream(im: Image.Image) -> Image.Image:
    """铺到暖纸底，输出 RGB。"""
    rgba = im.convert("RGBA")
    base = Image.new("RGBA", rgba.size, CREAM)
    base.alpha_composite(rgba)
    return base.convert("RGB")


def main() -> int:
    """生成全部尺寸并打印结果。"""
    if not SRC.is_file():
        print(f"缺少主图: {SRC}", file=sys.stderr)
        return 1
    src = Image.open(SRC).convert("RGBA")
    card = flatten_on_cream(crop_card(src))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        out = card.resize((size, size), Image.Resampling.LANCZOS)
        path = OUT_DIR / f"icon{size}.png"
        out.save(path, "PNG", optimize=True)
        check = Image.open(path)
        print(f"{path.relative_to(ROOT)} {check.size[0]}x{check.size[1]} {check.mode} {os.path.getsize(path)}B")
        if check.size != (size, size):
            print("尺寸错误", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
