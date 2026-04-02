"""
系统托盘应用
P3-001: 启动 < 2s，内存 < 100MB
"""

import asyncio
import sys
from pathlib import Path
from typing import Optional

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QAction, QFont, QIcon
from PyQt6.QtWidgets import (
    QApplication,
    QMainWindow,
    QMenu,
    QSystemTrayIcon,
)

from yuxtrans.cache.database import TranslationCache
from yuxtrans.cache.warmup import CacheWarmupStrategy
from yuxtrans.engine.router import SmartRouter
from yuxtrans.utils.config import ConfigManager


class AsyncWorker(QThread):
    """异步工作线程"""

    finished = pyqtSignal(object)
    error = pyqtSignal(str)

    def __init__(self, coro, parent=None):
        super().__init__(parent)
        self.coro = coro

    def run(self):
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            result = loop.run_until_complete(self.coro)
            self.finished.emit(result)
        except Exception as e:
            self.error.emit(str(e))
        finally:
            loop.close()


class TrayIcon(QSystemTrayIcon):
    """
    系统托盘图标

    功能：
    - 常驻托盘
    - 右键菜单
    - 状态指示
    """

    def __init__(self, router: SmartRouter, config: ConfigManager, parent=None):
        super().__init__(parent)

        self.router = router
        self.config = config

        self._setup_icon()
        self._setup_menu()
        self._connect_signals()

    def _setup_icon(self):
        """设置托盘图标"""
        icon_path = Path(__file__).parent / "icons" / "tray.png"

        if icon_path.exists():
            self.setIcon(QIcon(str(icon_path)))
        else:
            self.setIcon(self._create_default_icon())

        self.setToolTip("YuxTrans - AI翻译工具")

    def _create_default_icon(self) -> QIcon:
        """创建默认图标"""
        from PyQt6.QtGui import QColor, QPainter, QPen, QPixmap

        pixmap = QPixmap(64, 64)
        pixmap.fill(QColor(0, 0, 0, 0))

        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        painter.setBrush(QColor(52, 152, 219))
        painter.setPen(QPen(QColor(41, 128, 185), 2))
        painter.drawEllipse(4, 4, 56, 56)

        font = QFont("Arial", 28, QFont.Weight.Bold)
        painter.setFont(font)
        painter.setPen(QColor(255, 255, 255))
        painter.drawText(pixmap.rect(), 0x0084, "Y")

        painter.end()

        return QIcon(pixmap)

    def _setup_menu(self):
        """设置右键菜单"""
        menu = QMenu()
        menu.setStyleSheet("""
            QMenu {
                background-color: white;
                border: 1px solid #dfe6e9;
                border-radius: 8px;
                padding: 8px 0;
            }
            QMenu::item {
                padding: 8px 24px;
                border-radius: 4px;
                margin: 0 4px;
            }
            QMenu::item:selected {
                background-color: #e8f4fd;
            }
            QMenu::separator {
                height: 1px;
                background: #ecf0f1;
                margin: 4px 12px;
            }
        """)

        self.translate_action = QAction("翻译剪贴板 (Ctrl+Shift+T)", self)
        self.translate_action.triggered.connect(self._on_translate_clipboard)
        menu.addAction(self.translate_action)

        self.selection_action = QAction("划词翻译", self)
        self.selection_action.triggered.connect(self._on_selection_translate)
        menu.addAction(self.selection_action)

        menu.addSeparator()

        self.status_action = QAction("状态: 就绪", self)
        self.status_action.setEnabled(False)
        menu.addAction(self.status_action)

        # API Key 快捷配置
        self.api_action = QAction("配置 API Key...", self)
        self.api_action.triggered.connect(self._on_config_api)
        menu.addAction(self.api_action)

        menu.addSeparator()

        settings_action = QAction("设置", self)
        settings_action.triggered.connect(self._on_settings)
        menu.addAction(settings_action)

        menu.addSeparator()

        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self._on_quit)
        menu.addAction(quit_action)

        self.setContextMenu(menu)

    def _connect_signals(self):
        """连接信号"""
        self.messageClicked.connect(self._on_message_clicked)

    def _on_translate_clipboard(self):
        """翻译剪贴板内容"""
        from PyQt6.QtWidgets import QApplication as QtApp

        clipboard = QtApp.clipboard()
        text = clipboard.text()

        if text:
            self.translate_requested.emit(text)

    def _on_selection_translate(self):
        """划词翻译"""
        self.selection_requested.emit()

    def _on_config_api(self):
        """配置 API Key"""
        self.api_config_requested.emit()

    def _on_settings(self):
        """打开设置"""
        self.settings_requested.emit()

    def _on_quit(self):
        """退出应用"""
        from PyQt6.QtWidgets import QApplication

        QApplication.quit()

    def _on_message_clicked(self):
        """点击通知消息"""
        pass

    def set_status(self, status: str):
        """设置状态"""
        self.status_action.setText(f"状态: {status}")

    def show_notification(self, title: str, message: str):
        """显示通知"""
        self.showMessage(title, message, QSystemTrayIcon.MessageIcon.Information, 3000)

    def show_error(self, title: str, message: str):
        """显示错误"""
        self.showMessage(title, message, QSystemTrayIcon.MessageIcon.Critical, 5000)

    translate_requested = pyqtSignal(str)
    selection_requested = pyqtSignal()
    settings_requested = pyqtSignal()
    api_config_requested = pyqtSignal()


class TrayApplication:
    """
    托盘应用主类

    管理整个应用生命周期
    """

    def __init__(self):
        self.app: Optional[QApplication] = None
        self.tray: Optional[TrayIcon] = None
        self.router: Optional[SmartRouter] = None
        self.config: Optional[ConfigManager] = None
        self.main_window: Optional[QMainWindow] = None

    def initialize(self) -> bool:
        """初始化应用"""
        import time

        start_time = time.time()

        self.app = QApplication(sys.argv)
        self.app.setQuitOnLastWindowClosed(False)
        self.app.setApplicationName("YuxTrans")
        self.app.setApplicationVersion("0.1.0")

        self.config = ConfigManager()
        self.config.load()

        # 检查是否首次运行
        from yuxtrans.desktop.first_run import check_first_run, run_first_run_wizard

        if check_first_run():
            if not run_first_run_wizard(self.config):
                return False

        self._init_router()

        self._init_tray()

        self._init_window()

        init_time = time.time() - start_time

        if init_time > 2:
            print(f"警告: 初始化耗时 {init_time:.2f}s (目标 < 2s)")

        return True

    def _init_router(self):
        """初始化路由器"""
        cache_path = self.config.get("engine", "cache_db_path")

        cache = TranslationCache(
            db_path=cache_path,
            preload_popular=False,
        )

        warmup = CacheWarmupStrategy(cache)

        worker = AsyncWorker(warmup.warmup_common_words())
        worker.start()
        worker.wait()

        self.router = SmartRouter(cache=cache)

    def _init_tray(self):
        """初始化托盘"""
        self.tray = TrayIcon(self.router, self.config)

        self.tray.translate_requested.connect(self._on_translate_requested)
        self.tray.selection_requested.connect(self._on_selection_requested)
        self.tray.settings_requested.connect(self._on_settings_requested)
        self.tray.api_config_requested.connect(self._on_api_config_requested)

        self.tray.show()

    def _init_window(self):
        """初始化主窗口"""
        from yuxtrans.desktop.window import TranslationWindow

        self.main_window = TranslationWindow(self.router, self.config)

        self.tray.translate_requested.connect(self.main_window.show_translation)

    def _on_translate_requested(self, text: str):
        """翻译请求"""
        if self.main_window:
            self.main_window.show_translation(text)

    def _on_selection_requested(self):
        """划词翻译请求"""
        from yuxtrans.desktop.selection import SelectionManager

        selection = SelectionManager()
        text = selection.get_selected_text()

        if text and self.main_window:
            self.main_window.show_translation(text)

    def _on_settings_requested(self):
        """设置请求"""
        from yuxtrans.desktop.settings import SettingsDialog

        dialog = SettingsDialog(self.config, self.main_window)
        dialog.exec()

    def _on_api_config_requested(self):
        """API Key 配置请求"""
        from yuxtrans.desktop.api_key_dialog import ApiKeyDialog

        dialog = ApiKeyDialog(self.config, self.main_window)
        if dialog.exec():
            self.tray.show_notification("YuxTrans", "API Key 已保存")

    def run(self):
        """运行应用"""
        if not self.app:
            return 1

        self.tray.show_notification("YuxTrans", "翻译工具已启动")

        return self.app.exec()


def main():
    """入口函数"""
    app = TrayApplication()

    if not app.initialize():
        return 1

    return app.run()


if __name__ == "__main__":
    sys.exit(main())
