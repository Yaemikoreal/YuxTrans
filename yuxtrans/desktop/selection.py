"""
划词翻译功能
P3-003: 选中文本到显示 < 300ms
"""

import sys
import time
from dataclasses import dataclass
from typing import Optional

from PyQt6.QtCore import QObject, QPoint, QTimer, pyqtSignal
from PyQt6.QtWidgets import QApplication


@dataclass
class SelectionResult:
    """选中文本结果"""

    text: str
    position: QPoint
    timestamp: float


class SelectionManager(QObject):
    """
    选中文本管理器

    支持：
    - 获取当前选中内容
    - 跨应用选中文本
    - 鼠标位置追踪
    """

    selection_changed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)

        self._last_selection: Optional[SelectionResult] = None
        self._monitor_timer = QTimer(self)
        self._monitor_timer.timeout.connect(self._check_selection)
        self._monitor_interval = 500

    def get_selected_text(self) -> Optional[str]:
        """
        获取当前选中的文本

        Returns:
            选中的文本，如果没有则返回 None
        """
        text = None

        if sys.platform == "win32":
            text = self._get_selected_windows()
        elif sys.platform == "darwin":
            text = self._get_selected_macos()
        else:
            text = self._get_selected_linux()

        if text:
            self._last_selection = SelectionResult(
                text=text,
                position=self._get_mouse_position(),
                timestamp=time.time(),
            )

        return text

    def _get_selected_windows(self) -> Optional[str]:
        """Windows 平台获取选中文本"""
        try:
            import pyperclip

            original = pyperclip.paste()

            import subprocess

            subprocess.run(["powershell", "-command", "Set-Clipboard ''"], capture_output=True)

            import keyboard

            keyboard.press_and_release("ctrl+c")

            import time

            time.sleep(0.1)

            text = pyperclip.paste()

            if text and text != original:
                pyperclip.copy(original)
                return text

        except Exception:
            pass

        try:
            import pyautogui

            pyautogui.hotkey("ctrl", "c")

            import time

            time.sleep(0.1)

            clipboard = QApplication.clipboard()
            text = clipboard.text()

            return text if text else None

        except Exception:
            pass

        return None

    def _get_selected_macos(self) -> Optional[str]:
        """macOS 平台获取选中文本（非破坏性：备份并恢复剪贴板）"""
        clipboard = QApplication.clipboard()
        backup = clipboard.text() if clipboard.supportsSelection() else clipboard.text()

        try:
            import subprocess

            subprocess.run(
                [
                    "osascript",
                    "-e",
                    'tell application "System Events" to keystroke "c" using command down',
                ],
                capture_output=True,
                text=True,
            )

            import time

            time.sleep(0.05)

            text = clipboard.text()

            # 如果复制出的文本和备份不同才视为选中内容
            if text and text != backup:
                return text
            return None

        except Exception:
            return None

        finally:
            # 恢复原始剪贴板内容
            try:
                clipboard.setText(backup)
            except Exception:
                pass

    def _get_selected_linux(self) -> Optional[str]:
        """Linux 平台获取选中文本"""
        try:
            import subprocess

            result = subprocess.run(
                ["xclip", "-o", "-selection", "primary"],
                capture_output=True,
                text=True,
            )

            if result.returncode == 0:
                return result.stdout.strip()

        except Exception:
            pass

        return None

    def _get_mouse_position(self) -> QPoint:
        """获取鼠标位置"""
        from PyQt6.QtGui import QCursor

        pos = QCursor.pos()
        return QPoint(pos.x(), pos.y())

    def start_monitoring(self, interval_ms: int = 500):
        """
        开始监控选中文本变化

        Args:
            interval_ms: 检测间隔(毫秒)
        """
        self._monitor_interval = interval_ms
        self._monitor_timer.start(interval_ms)

    def stop_monitoring(self):
        """停止监控"""
        self._monitor_timer.stop()

    def _check_selection(self):
        """检查选中文本变化"""
        current = self.get_selected_text()

        if current and current != (self._last_selection.text if self._last_selection else None):
            self.selection_changed.emit(current)

    def get_last_selection(self) -> Optional[SelectionResult]:
        """获取最后一次选中结果"""
        return self._last_selection


class SelectionButton:
    """
    选中文本悬浮按钮

    在选中文本旁显示翻译按钮
    """

    def __init__(self):
        self._button = None

    def show_at(self, position: QPoint):
        """在指定位置显示按钮"""
        from PyQt6.QtCore import Qt
        from PyQt6.QtWidgets import QPushButton

        if self._button is None:
            self._button = QPushButton("翻译")
            self._button.setWindowFlags(
                Qt.WindowType.WindowStaysOnTopHint
                | Qt.WindowType.FramelessWindowHint
                | Qt.WindowType.Tool
            )
            self._button.setFixedSize(50, 25)

        self._button.move(position.x() + 10, position.y() + 10)
        self._button.show()

    def hide(self):
        """隐藏按钮"""
        if self._button:
            self._button.hide()

    def set_callback(self, callback):
        """设置点击回调"""
        if self._button:
            self._button.clicked.connect(callback)
