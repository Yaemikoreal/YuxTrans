"""
平台适配工具集

提供跨平台的字体选择、路径规范等工具函数。
macOS 专项优化：PingFang SC 字体、Library/Application Support 路径。
"""

import sys
from pathlib import Path
from typing import Optional


def is_macos() -> bool:
    return sys.platform == "darwin"


def is_windows() -> bool:
    return sys.platform == "win32"


def is_linux() -> bool:
    return sys.platform.startswith("linux")


def chinese_font_name() -> str:
    """返回当前平台最佳中文字体名称"""
    if is_macos():
        return "PingFang SC"
    elif is_windows():
        return "Microsoft YaHei"
    else:
        return "Noto Sans CJK SC"


def ui_font_name() -> str:
    """返回当前平台最佳界面英文字体"""
    if is_macos():
        return ".AppleSystemUIFont"
    elif is_windows():
        return "Segoe UI"
    else:
        return "Ubuntu"


def mono_font_name() -> str:
    """返回当前平台最佳等宽字体"""
    if is_macos():
        return "SF Mono"
    elif is_windows():
        return "Cascadia Code"
    else:
        return "JetBrains Mono"


def get_data_dir() -> Path:
    """
    返回应用数据目录（配置、缓存等）

    macOS:   ~/Library/Application Support/YuxTrans
    Windows: %APPDATA%/YuxTrans
    Linux:   ~/.config/yuxtrans
    """
    if is_macos():
        base = Path.home() / "Library" / "Application Support" / "YuxTrans"
    elif is_windows():
        base = Path.home() / "AppData" / "Roaming" / "YuxTrans"
    else:
        base = Path.home() / ".config" / "yuxtrans"
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_cache_dir() -> Path:
    """返回缓存目录"""
    return get_data_dir() / "cache"
