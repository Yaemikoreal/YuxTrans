"""
翻译窗口UI
P3-004: 渲染流畅，动画 < 60fps
"""

import asyncio
from typing import Optional

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from yuxtrans.engine.base import TranslationRequest, TranslationResult
from yuxtrans.engine.router import SmartRouter
from yuxtrans.utils.config import ConfigManager
from yuxtrans.utils.platform import chinese_font_name, ui_font_name


class TranslationWorker(QThread):
    """翻译工作线程"""

    finished = pyqtSignal(object)
    error = pyqtSignal(str)

    def __init__(self, router: SmartRouter, request: TranslationRequest, parent=None):
        super().__init__(parent)
        self.router = router
        self.request = request

    def run(self):
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            result = loop.run_until_complete(self.router.translate(self.request))
            self.finished.emit(result)
        except Exception as e:
            self.error.emit(str(e))
        finally:
            loop.close()


class TranslationWindow(QMainWindow):
    """
    翻译窗口

    特性：
    - 快速显示/隐藏动画
    - 实时翻译结果
    - 一键复制
    - 引擎指示
    """

    def __init__(self, router: SmartRouter, config: ConfigManager, parent=None):
        super().__init__(parent)

        self.router = router
        self.config = config

        self._worker: Optional[TranslationWorker] = None

        self._setup_window()
        self._setup_ui()
        self._setup_styles()

    def _setup_window(self):
        """设置窗口属性"""
        self.setWindowFlags(
            Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Tool
        )

        width = self.config.get("ui", "window_width")
        height = self.config.get("ui", "window_height")
        opacity = self.config.get("ui", "window_opacity")

        self.setFixedSize(width, height)
        self.setWindowOpacity(opacity)

        self._is_visible = False

    def _setup_ui(self):
        """设置UI组件"""
        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        layout = QVBoxLayout(central_widget)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._setup_header(layout)
        self._setup_content(layout)
        self._setup_footer(layout)

    def _setup_header(self, layout: QVBoxLayout):
        """设置头部"""
        header = QFrame()
        header.setObjectName("header")
        header.setFixedHeight(40)

        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(10, 5, 10, 5)

        self.title_label = QLabel("YuxTrans")
        self.title_label.setFont(QFont(ui_font_name(), 12, QFont.Weight.Bold))
        header_layout.addWidget(self.title_label)

        header_layout.addStretch()

        self.engine_label = QLabel("")
        self.engine_label.setObjectName("engine_label")
        header_layout.addWidget(self.engine_label)

        self.time_label = QLabel("")
        self.time_label.setObjectName("time_label")
        header_layout.addWidget(self.time_label)

        close_btn = QPushButton("×")
        close_btn.setObjectName("close_btn")
        close_btn.setFixedSize(24, 24)
        close_btn.clicked.connect(self.hide)
        header_layout.addWidget(close_btn)

        layout.addWidget(header)

    def _setup_content(self, layout: QVBoxLayout):
        """设置内容区域"""
        content = QFrame()
        content.setObjectName("content")

        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(10, 10, 10, 10)

        source_label = QLabel("原文")
        source_label.setFont(QFont(ui_font_name(), 10, QFont.Weight.Bold))
        content_layout.addWidget(source_label)

        self.source_text = QTextEdit()
        self.source_text.setObjectName("source_text")
        self.source_text.setReadOnly(True)
        self.source_text.setMaximumHeight(80)
        self.source_text.setFont(QFont(chinese_font_name(), 11))
        content_layout.addWidget(self.source_text)

        target_label = QLabel("译文")
        target_label.setFont(QFont(ui_font_name(), 10, QFont.Weight.Bold))
        content_layout.addWidget(target_label)

        self.target_text = QTextEdit()
        self.target_text.setObjectName("target_text")
        self.target_text.setReadOnly(True)
        self.target_text.setFont(QFont(chinese_font_name(), 12))
        content_layout.addWidget(self.target_text)

        layout.addWidget(content)

    def _setup_footer(self, layout: QVBoxLayout):
        """设置底部"""
        footer = QFrame()
        footer.setObjectName("footer")
        footer.setFixedHeight(50)

        footer_layout = QHBoxLayout(footer)
        footer_layout.setContentsMargins(10, 10, 10, 10)

        self.status_label = QLabel("就绪")
        self.status_label.setObjectName("status_label")
        footer_layout.addWidget(self.status_label)

        footer_layout.addStretch()

        copy_btn = QPushButton("复制")
        copy_btn.setObjectName("copy_btn")
        copy_btn.clicked.connect(self._copy_result)
        footer_layout.addWidget(copy_btn)

        translate_btn = QPushButton("重新翻译")
        translate_btn.setObjectName("translate_btn")
        translate_btn.clicked.connect(self._retranslate)
        footer_layout.addWidget(translate_btn)

        layout.addWidget(footer)

    def _setup_styles(self):
        """设置样式"""
        theme = self.config.get("ui", "theme")

        if theme == "dark":
            self._apply_dark_theme()
        else:
            self._apply_light_theme()

    def _apply_light_theme(self):
        """应用浅色主题"""
        self.setStyleSheet("""
            QMainWindow {
                background-color: #ffffff;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
            }
            
            QFrame#header {
                background-color: #f5f5f5;
                border-bottom: 1px solid #e0e0e0;
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
            }
            
            QLabel {
                color: #333333;
            }
            
            QLabel#engine_label {
                color: #3498db;
                font-size: 10px;
            }
            
            QLabel#time_label {
                color: #95a5a6;
                font-size: 10px;
            }
            
            QPushButton#close_btn {
                background-color: transparent;
                color: #95a5a6;
                border: none;
                font-size: 16px;
            }
            
            QPushButton#close_btn:hover {
                color: #e74c3c;
            }
            
            QTextEdit {
                background-color: #fafafa;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                padding: 5px;
            }
            
            QTextEdit#source_text {
                color: #7f8c8d;
            }
            
            QTextEdit#target_text {
                color: #2c3e50;
            }
            
            QPushButton {
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 12px;
            }
            
            QPushButton:hover {
                background-color: #2980b9;
            }
            
            QLabel#status_label {
                color: #95a5a6;
            }
        """)

    def _apply_dark_theme(self):
        """应用深色主题"""
        self.setStyleSheet("""
            QMainWindow {
                background-color: #2c3e50;
                border: 1px solid #34495e;
                border-radius: 8px;
            }
            
            QFrame#header {
                background-color: #34495e;
                border-bottom: 1px solid #2c3e50;
            }
            
            QLabel {
                color: #ecf0f1;
            }
            
            QLabel#engine_label {
                color: #3498db;
            }
            
            QLabel#time_label {
                color: #95a5a6;
            }
            
            QPushButton#close_btn {
                background-color: transparent;
                color: #95a5a6;
                border: none;
            }
            
            QPushButton#close_btn:hover {
                color: #e74c3c;
            }
            
            QTextEdit {
                background-color: #34495e;
                border: 1px solid #2c3e50;
                border-radius: 4px;
                color: #ecf0f1;
            }
            
            QPushButton {
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 12px;
            }
            
            QPushButton:hover {
                background-color: #2980b9;
            }
        """)

    def show_translation(self, text: str):
        """显示翻译结果"""
        self.source_text.setPlainText(text)
        self.target_text.clear()
        self.status_label.setText("翻译中...")
        self.engine_label.setText("")
        self.time_label.setText("")

        self._show_window()

        self._start_translation(text)

    def _start_translation(self, text: str):
        """开始翻译"""
        if self._worker and self._worker.isRunning():
            self._worker.terminate()

        request = TranslationRequest(
            text=text,
            source_lang="auto",
            target_lang="zh",
        )

        self._worker = TranslationWorker(self.router, request)
        self._worker.finished.connect(self._on_translation_finished)
        self._worker.error.connect(self._on_translation_error)
        self._worker.start()

    def _on_translation_finished(self, result: TranslationResult):
        """翻译完成"""
        self.target_text.setPlainText(result.text)
        self.status_label.setText("完成")
        self.engine_label.setText(result.engine.value)
        self.time_label.setText(f"{result.response_time_ms:.1f}ms")

        if result.cached:
            self.engine_label.setText(f"{result.engine.value} (缓存)")

    def _on_translation_error(self, error: str):
        """翻译错误"""
        self.target_text.setPlainText(f"翻译失败: {error}")
        self.status_label.setText("错误")
        self.engine_label.setText("")

    def _retranslate(self):
        """重新翻译"""
        text = self.source_text.toPlainText()
        if text:
            self._start_translation(text)

    def _copy_result(self):
        """复制翻译结果"""
        text = self.target_text.toPlainText()
        if text:
            clipboard = QApplication.clipboard()
            clipboard.setText(text)
            self.status_label.setText("已复制")

    def _show_window(self):
        """显示窗口"""
        if self._is_visible:
            return

        from PyQt6.QtGui import QCursor

        cursor_pos = QCursor.pos()

        screen = QApplication.screenAt(cursor_pos)
        if screen:
            screen_rect = screen.availableGeometry()

            x = cursor_pos.x() + 10
            y = cursor_pos.y() + 10

            if x + self.width() > screen_rect.right():
                x = cursor_pos.x() - self.width() - 10

            if y + self.height() > screen_rect.bottom():
                y = cursor_pos.y() - self.height() - 10

            self.move(x, y)

        self.show()
        self._is_visible = True

    def hide(self):
        """隐藏窗口"""
        super().hide()
        self._is_visible = False

    def mousePressEvent(self, event):
        """鼠标按下事件 - 支持拖动"""
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, event):
        """鼠标移动事件 - 拖动窗口"""
        if hasattr(self, "_drag_pos"):
            self.move(event.globalPosition().toPoint() - self._drag_pos)
