#!/bin/bash

echo ""
echo "╔════════════════════════════════════╗"
echo "║     YuxTrans v0.1.0 安装程序      ║"
echo "║     AI 翻译工具 - 轻量版          ║"
echo "╚════════════════════════════════════╝"
echo ""

# 检测 Python
if ! command -v python3 &> /dev/null; then
    echo "[×] 未检测到 Python3"
    echo "请先安装 Python 3.10 或更高版本"
    exit 1
fi

PYVER=$(python3 --version 2>&1 | awk '{print $2}')
echo "[✓] 检测到 Python $PYVER"
echo ""

# 安装核心依赖
echo "[1/4] 安装核心依赖..."
pip3 install httpx pyyaml -q
echo "    完成!"
echo ""

# 询问桌面端
read -p "是否安装桌面端? (y/N): " install_desktop
if [ "$install_desktop" = "y" ] || [ "$install_desktop" = "Y" ]; then
    echo "[2/4] 安装桌面端 (PyQt6)..."
    pip3 install PyQt6 -q

    # macOS 额外安装 pynput（全局热键）
    if [ "$(uname)" = "Darwin" ]; then
        echo "    检测到 macOS，安装全局快捷键支持..."
        pip3 install pynput -q
    fi

    echo "    完成!"
else
    echo "[2/4] 跳过桌面端安装"
fi
echo ""

# 安装 yuxtrans
echo "[3/4] 安装 YuxTrans..."
pip3 install -e . -q
echo "    完成!"
echo ""

# 浏览器插件提示
echo "[4/4] 浏览器插件安装指引:"
echo "  1. 打开 Chrome 浏览器"
echo "  2. 地址栏输入: chrome://extensions/"
echo "  3. 开启开发者模式"
echo "  4. 加载 extension 目录"
echo ""

echo "╔════════════════════════════════════╗"
echo "║          安装完成!                ║"
echo "╠════════════════════════════════════╣"
echo "║  使用方法:                        ║"
echo "║    命令行: yuxtrans --help        ║"
echo "║    桌面端: yuxtrans               ║"
echo "╚════════════════════════════════════╝"