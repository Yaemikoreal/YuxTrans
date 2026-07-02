"""
全局快捷键监听
P3-002: 响应延迟 < 100ms
"""

import sys
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Dict, Optional

from PyQt6.QtCore import QObject, pyqtSignal
from yuxtrans.utils.platform import is_macos


class HotkeyState(Enum):
    """快捷键状态"""

    REGISTERED = "registered"
    UNREGISTERED = "unregistered"
    CONFLICT = "conflict"


@dataclass
class Hotkey:
    """快捷键定义"""

    id: str
    key: str
    modifiers: str
    callback: Callable
    description: str
    state: HotkeyState = HotkeyState.UNREGISTERED


class HotkeyManager(QObject):
    """
    全局快捷键管理器

    支持：
    - 全局热键注册
    - 冲突检测
    - 快速响应 (< 100ms)
    """

    hotkey_pressed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)

        self._hotkeys: Dict[str, Hotkey] = {}
        self._enabled = True

        self._init_platform()

    def _init_platform(self):
        """初始化平台相关"""
        self._platform = sys.platform.lower()

        if self._platform == "win32":
            self._init_windows()
        elif self._platform == "darwin":
            self._init_macos()
        else:
            self._init_linux()

    def _init_windows(self):
        """初始化 Windows 平台"""
        try:
            import keyboard

            self._keyboard = keyboard
        except ImportError:
            self._keyboard = None
            print("警告: 未安装 keyboard 库，快捷键功能受限")

    def _init_macos(self):
        """初始化 macOS 平台热键（使用 pynput GlobalHotKeys）"""
        self._macos_bindings: Dict[str, dict] = {}
        self._macos_listener = None
        try:
            from pynput.keyboard import GlobalHotKeys, HotKey, Key, KeyCode

            self._pynput_GlobalHotKeys = GlobalHotKeys
            self._pynput_HotKey = HotKey
            self._pynput_Key = Key
            self._pynput_KeyCode = KeyCode
            self._pynput_available = True
        except ImportError:
            self._pynput_available = False

    def _init_linux(self):
        """初始化 Linux 平台"""
        try:
            import keyboard

            self._keyboard = keyboard
        except ImportError:
            self._keyboard = None

    def register(
        self,
        hotkey_id: str,
        key: str,
        callback: Callable,
        description: str = "",
        modifiers: str = "",
    ) -> bool:
        """
        注册快捷键

        Args:
            hotkey_id: 快捷键ID
            key: 按键 (如 "T", "F1")
            callback: 回调函数
            description: 描述
            modifiers: 修饰键 (如 "Ctrl+Shift")

        Returns:
            bool: 是否注册成功
        """
        full_key = f"{modifiers}+{key}" if modifiers else key

        if hotkey_id in self._hotkeys:
            self.unregister(hotkey_id)

        hotkey = Hotkey(
            id=hotkey_id,
            key=key,
            modifiers=modifiers,
            callback=callback,
            description=description,
        )

        success = self._register_platform(full_key, callback)

        if success:
            hotkey.state = HotkeyState.REGISTERED
            self._hotkeys[hotkey_id] = hotkey
            return True

        hotkey.state = HotkeyState.CONFLICT
        self._hotkeys[hotkey_id] = hotkey
        return False

    def _register_platform(self, key: str, callback: Callable) -> bool:
        """平台相关注册"""
        if self._platform == "win32" and self._keyboard:
            try:
                self._keyboard.add_hotkey(key, callback)
                return True
            except Exception:
                return False

        if self._platform == "darwin" and self._pynput_available:
            return self._register_macos(key, callback)

        return False

    def _unregister_platform(self, key: str) -> bool:
        """平台相关注销"""
        if self._platform == "win32" and self._keyboard:
            try:
                self._keyboard.remove_hotkey(key)
                return True
            except Exception:
                return False

        if self._platform == "darwin" and self._pynput_available:
            return self._unregister_macos(key)

        return False

    # ── macOS 热键实现（pynput GlobalHotKeys） ──────────────────────────

    def _register_macos(self, full_key: str, callback: Callable) -> bool:
        """注册 macOS 全局热键"""
        try:
            pynput_key = self._pynput_key_from_string(full_key)
        except ValueError:
            return False

        self._macos_bindings[full_key] = {
            "pynput_key": pynput_key,
            "callback": callback,
        }
        self._restart_macos_listener()
        return True

    def _unregister_macos(self, full_key: str) -> bool:
        """注销 macOS 全局热键"""
        if full_key not in self._macos_bindings:
            return False
        del self._macos_bindings[full_key]
        self._restart_macos_listener()
        return True

    def _restart_macos_listener(self):
        """重启 GlobalHotKeys 监听器（注册/注销后反映变更）"""
        if self._macos_listener is not None:
            self._macos_listener.stop()
            self._macos_listener = None

        if not self._macos_bindings:
            return

        hotkey_dict = {}
        for entry in self._macos_bindings.values():
            # 用闭包包装回调，使其可被 pynput 线程安全调用
            cb = entry["callback"]
            hotkey_dict[entry["pynput_key"]] = cb

        self._macos_listener = self._pynput_GlobalHotKeys(hotkey_dict)
        self._macos_listener.daemon = True
        self._macos_listener.start()

    @staticmethod
    def _pynput_key_from_string(key_str: str) -> str:
        """
        将 "Ctrl+Shift+T" 转换为 pynput 可识别的 "<ctrl>+<shift>+t"

        支持修饰键: Ctrl, Shift, Alt, Cmd/Super/Win
        特殊键名:  F1-F24, Space, Tab, Enter/Esc/Return, Up/Down/Left/Right
        """
        parts = key_str.lower().split("+")
        pynput_parts = []

        MODIFIER_MAP = {
            "ctrl": "<ctrl>",
            "shift": "<shift>",
            "alt": "<alt>",
            "option": "<alt>",
            "cmd": "<cmd>",
            "command": "<cmd>",
            "super": "<cmd>",
            "win": "<cmd>",
            "meta": "<cmd>",
        }

        SPECIAL_KEYS = {
            "space": "<space>",
            "tab": "<tab>",
            "enter": "<enter>",
            "return": "<enter>",
            "esc": "<esc>",
            "escape": "<esc>",
            "backspace": "<backspace>",
            "delete": "<delete>",
            "home": "<home>",
            "end": "<end>",
            "page_up": "<page_up>",
            "page_down": "<page_down>",
            "insert": "<insert>",
            "menu": "<menu>",
            "pause": "<pause>",
            "print_screen": "<print_screen>",
            "up": "<up>",
            "down": "<down>",
            "left": "<left>",
            "right": "<right>",
        }
        # F1-F24
        for i in range(1, 25):
            SPECIAL_KEYS[f"f{i}"] = f"<f{i}>"

        for part in parts:
            if part in MODIFIER_MAP:
                pynput_parts.append(MODIFIER_MAP[part])
            elif part in SPECIAL_KEYS:
                pynput_parts.append(SPECIAL_KEYS[part])
            elif len(part) == 1:
                # 单字符按键
                pynput_parts.append(part)
            else:
                raise ValueError(f"无法识别的按键: {part}")

        return "+".join(pynput_parts)

    def unregister(self, hotkey_id: str) -> bool:
        """
        注销快捷键

        Args:
            hotkey_id: 快捷键ID

        Returns:
            bool: 是否注销成功
        """
        if hotkey_id not in self._hotkeys:
            return False

        hotkey = self._hotkeys[hotkey_id]
        full_key = f"{hotkey.modifiers}+{hotkey.key}" if hotkey.modifiers else hotkey.key

        success = self._unregister_platform(full_key)

        if success:
            hotkey.state = HotkeyState.UNREGISTERED
            del self._hotkeys[hotkey_id]

        return success

    def unregister_all(self):
        """注销所有快捷键"""
        for hotkey_id in list(self._hotkeys.keys()):
            self.unregister(hotkey_id)

    def enable(self):
        """启用快捷键"""
        self._enabled = True

    def disable(self):
        """禁用快捷键"""
        self._enabled = False

    def get_hotkey(self, hotkey_id: str) -> Optional[Hotkey]:
        """获取快捷键信息"""
        return self._hotkeys.get(hotkey_id)

    def get_all_hotkeys(self) -> Dict[str, Hotkey]:
        """获取所有快捷键"""
        return self._hotkeys.copy()

    def is_registered(self, hotkey_id: str) -> bool:
        """检查是否已注册"""
        hotkey = self._hotkeys.get(hotkey_id)
        return hotkey is not None and hotkey.state == HotkeyState.REGISTERED


class DefaultHotkeys:
    """默认快捷键配置"""

    TRANSLATE_CLIPBOARD = ("translate_clipboard", "T", "Ctrl+Shift", "翻译剪贴板")
    TRANSLATE_SELECTION = ("translate_selection", "S", "Ctrl+Shift", "翻译选中内容")
    SHOW_WINDOW = ("show_window", "Q", "Ctrl+Shift", "显示窗口")
    PASTE_TRANSLATE = ("paste_translate", "P", "Ctrl+Shift", "粘贴并翻译")

    @classmethod
    def register_defaults(cls, manager: HotkeyManager, callbacks: Dict[str, Callable]):
        """注册默认快捷键"""
        defaults = [
            cls.TRANSLATE_CLIPBOARD,
            cls.TRANSLATE_SELECTION,
            cls.SHOW_WINDOW,
            cls.PASTE_TRANSLATE,
        ]

        for hotkey_id, key, modifiers, description in defaults:
            if hotkey_id in callbacks:
                manager.register(
                    hotkey_id=hotkey_id,
                    key=key,
                    modifiers=modifiers,
                    callback=callbacks[hotkey_id],
                    description=description,
                )
