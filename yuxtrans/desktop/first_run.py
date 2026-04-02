"""
首次运行配置向导
简约美观的 GUI 引导界面
"""

from pathlib import Path
from typing import Optional

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QFont, QIcon, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpacerItem,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from yuxtrans.engine.cloud import CloudTranslator
from yuxtrans.utils.config import ConfigManager


class WelcomePage(QWidget):
    """欢迎页面"""

    next_requested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(20)
        layout.setContentsMargins(40, 40, 40, 40)

        # 标题
        title = QLabel("欢迎使用 YuxTrans")
        title.setFont(QFont("Microsoft YaHei", 24, QFont.Weight.Bold))
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setStyleSheet("color: #2c3e50;")
        layout.addWidget(title)

        # 副标题
        subtitle = QLabel("响应速度是生命，翻译准度是底线")
        subtitle.setFont(QFont("Microsoft YaHei", 12))
        subtitle.setAlignment(Qt.AlignmentFlag.AlignCenter)
        subtitle.setStyleSheet("color: #7f8c8d;")
        layout.addWidget(subtitle)

        layout.addSpacing(40)

        # 功能介绍
        features = QLabel(
            "✓ 智能路由：缓存 → 本地 → 云端\n"
            "✓ 8+ 云端 API 支持\n"
            "✓ 本地模型离线可用\n"
            "✓ 划词翻译，极速响应"
        )
        features.setFont(QFont("Microsoft YaHei", 11))
        features.setStyleSheet("color: #34495e; line-height: 1.8;")
        features.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(features)

        layout.addStretch()

        # 下一步按钮
        next_btn = QPushButton("开始配置")
        next_btn.setFont(QFont("Microsoft YaHei", 12))
        next_btn.setFixedHeight(44)
        next_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        next_btn.setStyleSheet("""
            QPushButton {
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 6px;
                padding: 10px 40px;
            }
            QPushButton:hover {
                background-color: #2980b9;
            }
        """)
        next_btn.clicked.connect(self.next_requested.emit)
        layout.addWidget(next_btn, alignment=Qt.AlignmentFlag.AlignCenter)


class ProviderPage(QWidget):
    """选择供应商页面"""

    next_requested = pyqtSignal()
    back_requested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.selected_provider = "qwen"
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(40, 40, 40, 40)

        # 标题
        title = QLabel("选择翻译服务")
        title.setFont(QFont("Microsoft YaHei", 18, QFont.Weight.Bold))
        title.setStyleSheet("color: #2c3e50;")
        layout.addWidget(title)

        subtitle = QLabel("推荐使用云端 API，开箱即用")
        subtitle.setStyleSheet("color: #7f8c8d;")
        layout.addWidget(subtitle)

        layout.addSpacing(20)

        # 供应商列表
        self.providers = {
            "qwen": {"name": "通义千问", "desc": "阿里云，中文优化，推荐", "icon": "🇨🇳"},
            "openai": {"name": "OpenAI", "desc": "国际标准，多语言", "icon": "🇺🇸"},
            "deepseek": {"name": "DeepSeek", "desc": "国内服务，性价比高", "icon": "🇨🇳"},
            "anthropic": {"name": "Claude", "desc": "Anthropic，高质量推理", "icon": "🤖"},
            "groq": {"name": "Groq", "desc": "极速推理 (<100ms)", "icon": "⚡"},
            "local": {"name": "本地模型", "desc": "需要 Ollama，离线可用", "icon": "🏠"},
        }

        self.provider_btns = {}
        for provider_id, info in self.providers.items():
            btn = QPushButton(f"{info['icon']}  {info['name']} - {info['desc']}")
            btn.setFont(QFont("Microsoft YaHei", 11))
            btn.setFixedHeight(50)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #ecf0f1;
                    color: #2c3e50;
                    border: 2px solid transparent;
                    border-radius: 8px;
                    text-align: left;
                    padding-left: 16px;
                }
                QPushButton:hover {
                    background-color: #d5dbdb;
                }
            """)
            btn.clicked.connect(lambda checked, p=provider_id: self._select_provider(p))
            layout.addWidget(btn)
            self.provider_btns[provider_id] = btn

        # 默认选中
        self._select_provider("qwen")

        layout.addStretch()

        # 按钮行
        btn_layout = QHBoxLayout()

        back_btn = QPushButton("上一步")
        back_btn.setFixedHeight(40)
        back_btn.setStyleSheet("""
            QPushButton {
                background-color: #bdc3c7;
                color: white;
                border: none;
                border-radius: 6px;
                padding: 8px 24px;
            }
            QPushButton:hover {
                background-color: #95a5a6;
            }
        """)
        back_btn.clicked.connect(self.back_requested.emit)
        btn_layout.addWidget(back_btn)

        btn_layout.addStretch()

        next_btn = QPushButton("下一步")
        next_btn.setFixedHeight(40)
        next_btn.setStyleSheet("""
            QPushButton {
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 6px;
                padding: 8px 24px;
            }
            QPushButton:hover {
                background-color: #2980b9;
            }
        """)
        next_btn.clicked.connect(self.next_requested.emit)
        btn_layout.addWidget(next_btn)

        layout.addLayout(btn_layout)

    def _select_provider(self, provider_id: str):
        self.selected_provider = provider_id
        for pid, btn in self.provider_btns.items():
            if pid == provider_id:
                btn.setStyleSheet("""
                    QPushButton {
                        background-color: #e8f4fd;
                        color: #2980b9;
                        border: 2px solid #3498db;
                        border-radius: 8px;
                        text-align: left;
                        padding-left: 16px;
                        font-weight: bold;
                    }
                """)
            else:
                btn.setStyleSheet("""
                    QPushButton {
                        background-color: #ecf0f1;
                        color: #2c3e50;
                        border: 2px solid transparent;
                        border-radius: 8px;
                        text-align: left;
                        padding-left: 16px;
                    }
                    QPushButton:hover {
                        background-color: #d5dbdb;
                    }
                """)


class ApiKeyPage(QWidget):
    """API Key 配置页面"""

    next_requested = pyqtSignal()
    back_requested = pyqtSignal()
    skip_requested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(40, 40, 40, 40)

        # 标题
        self.title = QLabel("配置 API Key")
        self.title.setFont(QFont("Microsoft YaHei", 18, QFont.Weight.Bold))
        self.title.setStyleSheet("color: #2c3e50;")
        layout.addWidget(self.title)

        self.subtitle = QLabel("输入您的 API Key，或稍后在设置中配置")
        self.subtitle.setStyleSheet("color: #7f8c8d;")
        layout.addWidget(self.subtitle)

        layout.addSpacing(20)

        # API Key 输入
        key_label = QLabel("API Key:")
        key_label.setStyleSheet("color: #2c3e50; font-weight: bold;")
        layout.addWidget(key_label)

        self.api_key_input = QLineEdit()
        self.api_key_input.setPlaceholderText("粘贴您的 API Key...")
        self.api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.api_key_input.setFixedHeight(44)
        self.api_key_input.setStyleSheet("""
            QLineEdit {
                background-color: #f8f9fa;
                border: 2px solid #dfe6e9;
                border-radius: 8px;
                padding: 0 12px;
                font-size: 14px;
            }
            QLineEdit:focus {
                border-color: #3498db;
            }
        """)
        layout.addWidget(self.api_key_input)

        # 显示/隐藏密码
        show_btn = QPushButton("👁 显示")
        show_btn.setCheckable(True)
        show_btn.setFixedWidth(70)
        show_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                color: #7f8c8d;
                border: none;
            }
        """)
        show_btn.toggled.connect(
            lambda checked: self.api_key_input.setEchoMode(
                QLineEdit.EchoMode.Normal if checked else QLineEdit.EchoMode.Password
            )
        )

        key_layout = QHBoxLayout()
        key_layout.addStretch()
        key_layout.addWidget(show_btn)
        layout.addLayout(key_layout)

        # 获取链接
        self.help_label = QLabel()
        self.help_label.setStyleSheet("color: #3498db;")
        self.help_label.setOpenExternalLinks(True)
        layout.addWidget(self.help_label)

        # 测试结果
        self.test_label = QLabel()
        self.test_label.setStyleSheet("color: #27ae60;")
        layout.addWidget(self.test_label)

        layout.addStretch()

        # 按钮行
        btn_layout = QHBoxLayout()

        back_btn = QPushButton("上一步")
        back_btn.setFixedHeight(40)
        back_btn.setStyleSheet("""
            QPushButton {
                background-color: #bdc3c7;
                color: white;
                border: none;
                border-radius: 6px;
                padding: 8px 24px;
            }
            QPushButton:hover {
                background-color: #95a5a6;
            }
        """)
        back_btn.clicked.connect(self.back_requested.emit)
        btn_layout.addWidget(back_btn)

        btn_layout.addStretch()

        skip_btn = QPushButton("跳过")
        skip_btn.setFixedHeight(40)
        skip_btn.setStyleSheet("""
            QPushButton {
                background-color: transparent;
                color: #7f8c8d;
                border: 1px solid #bdc3c7;
                border-radius: 6px;
                padding: 8px 24px;
            }
            QPushButton:hover {
                background-color: #ecf0f1;
            }
        """)
        skip_btn.clicked.connect(self.skip_requested.emit)
        btn_layout.addWidget(skip_btn)

        complete_btn = QPushButton("完成配置")
        complete_btn.setFixedHeight(40)
        complete_btn.setStyleSheet("""
            QPushButton {
                background-color: #27ae60;
                color: white;
                border: none;
                border-radius: 6px;
                padding: 8px 24px;
            }
            QPushButton:hover {
                background-color: #1e8449;
            }
        """)
        complete_btn.clicked.connect(self.next_requested.emit)
        btn_layout.addWidget(complete_btn)

        layout.addLayout(btn_layout)

    def update_provider(self, provider: str):
        """更新供应商信息"""
        help_links = {
            "qwen": '<a href="https://dashscope.console.aliyun.com/apiKey">获取通义千问 API Key</a>',
            "openai": '<a href="https://platform.openai.com/api-keys">获取 OpenAI API Key</a>',
            "deepseek": '<a href="https://platform.deepseek.com/api_keys">获取 DeepSeek API Key</a>',
            "anthropic": '<a href="https://console.anthropic.com/settings/keys">获取 Claude API Key</a>',
            "groq": '<a href="https://console.groq.com/keys">获取 Groq API Key</a>',
            "local": "无需 API Key，请确保 Ollama 已安装并运行",
        }
        self.help_label.setText(help_links.get(provider, ""))

        if provider == "local":
            self.api_key_input.setPlaceholderText("本地模型无需 API Key")
            self.api_key_input.setEnabled(False)
        else:
            self.api_key_input.setPlaceholderText("粘贴您的 API Key...")
            self.api_key_input.setEnabled(True)

    def get_api_key(self) -> str:
        return self.api_key_input.text().strip()


class FirstRunWizard(QDialog):
    """首次运行向导"""

    def __init__(self, config: ConfigManager, parent=None):
        super().__init__(parent)
        self.config = config
        self.selected_provider = "qwen"

        self._setup_ui()
        self._connect_signals()

    def _setup_ui(self):
        self.setWindowTitle("YuxTrans 配置向导")
        self.setFixedSize(520, 580)
        self.setStyleSheet("background-color: white;")

        # 移除标题栏按钮
        self.setWindowFlags(
            Qt.WindowType.Dialog | Qt.WindowType.CustomizeWindowHint | Qt.WindowType.WindowTitleHint
        )

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # 页面容器
        self.pages = QStackedWidget()

        self.welcome_page = WelcomePage()
        self.provider_page = ProviderPage()
        self.api_key_page = ApiKeyPage()

        self.pages.addWidget(self.welcome_page)
        self.pages.addWidget(self.provider_page)
        self.pages.addWidget(self.api_key_page)

        layout.addWidget(self.pages)

    def _connect_signals(self):
        # 欢迎页
        self.welcome_page.next_requested.connect(lambda: self.pages.setCurrentIndex(1))

        # 供应商选择页
        self.provider_page.next_requested.connect(self._on_provider_next)
        self.provider_page.back_requested.connect(lambda: self.pages.setCurrentIndex(0))

        # API Key 页
        self.api_key_page.next_requested.connect(self._complete)
        self.api_key_page.back_requested.connect(lambda: self.pages.setCurrentIndex(1))
        self.api_key_page.skip_requested.connect(self._complete)

    def _on_provider_next(self):
        self.selected_provider = self.provider_page.selected_provider
        self.api_key_page.update_provider(self.selected_provider)
        self.pages.setCurrentIndex(2)

    def _complete(self):
        """完成配置"""
        # 保存配置
        api_key = self.api_key_page.get_api_key()

        if self.selected_provider == "local":
            self.config.update("engine", "prefer_local", True)
        else:
            self.config.update("engine", "prefer_local", False)
            self.config.update("engine", "cloud_provider", self.selected_provider)
            if api_key:
                self.config.update("engine", "cloud_api_key", api_key)

        self.accept()


def check_first_run() -> bool:
    """检查是否首次运行"""
    config_path = Path.home() / ".yuxtrans" / "config.yaml"
    return not config_path.exists()


def run_first_run_wizard(config: ConfigManager) -> bool:
    """运行首次配置向导"""
    wizard = FirstRunWizard(config)
    result = wizard.exec()
    return result == QDialog.DialogCode.Accepted