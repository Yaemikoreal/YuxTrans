"""
简约美观的 API Key 配置对话框
"""

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QComboBox,
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from yuxtrans.engine.cloud import CloudTranslator
from yuxtrans.utils.config import ConfigManager


class ApiKeyDialog(QDialog):
    """
    API Key 配置对话框

    简约美观的单页配置界面
    """

    def __init__(self, config: ConfigManager, parent=None):
        super().__init__(parent)
        self.config = config
        self._testing = False

        self._setup_ui()
        self._load_config()

    def _setup_ui(self):
        self.setWindowTitle("配置 API Key")
        self.setFixedSize(420, 380)
        self.setStyleSheet("background-color: #ffffff;")

        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(32, 28, 32, 28)

        # 标题
        title = QLabel("API Key 配置")
        title.setFont(QFont("Microsoft YaHei", 16, QFont.Weight.Bold))
        title.setStyleSheet("color: #2c3e50;")
        layout.addWidget(title)

        subtitle = QLabel("配置云端翻译服务的 API Key")
        subtitle.setStyleSheet("color: #95a5a6; font-size: 12px;")
        layout.addWidget(subtitle)

        layout.addSpacing(8)

        # 供应商选择
        provider_label = QLabel("服务提供商")
        provider_label.setStyleSheet("color: #34495e; font-weight: bold;")
        layout.addWidget(provider_label)

        self.provider_combo = QComboBox()
        self.provider_combo.addItems([
            "通义千问 (Qwen)",
            "OpenAI",
            "DeepSeek",
            "Claude (Anthropic)",
            "Groq",
            "Moonshot",
            "Siliconflow",
        ])
        self.provider_combo.setFixedHeight(40)
        self.provider_combo.setStyleSheet("""
            QComboBox {
                background-color: #f8f9fa;
                border: 2px solid #dfe6e9;
                border-radius: 8px;
                padding: 0 12px;
                font-size: 13px;
            }
            QComboBox:focus {
                border-color: #3498db;
            }
            QComboBox::drop-down {
                border: none;
                width: 30px;
            }
            QComboBox::down-arrow {
                image: none;
                border-left: 5px solid transparent;
                border-right: 5px solid transparent;
                border-top: 6px solid #7f8c8d;
                margin-right: 10px;
            }
        """)
        self.provider_combo.currentIndexChanged.connect(self._on_provider_changed)
        layout.addWidget(self.provider_combo)

        # API Key 输入
        key_label = QLabel("API Key")
        key_label.setStyleSheet("color: #34495e; font-weight: bold;")
        layout.addWidget(key_label)

        self.api_key_input = QLineEdit()
        self.api_key_input.setPlaceholderText("粘贴您的 API Key...")
        self.api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.api_key_input.setFixedHeight(40)
        self.api_key_input.setStyleSheet("""
            QLineEdit {
                background-color: #f8f9fa;
                border: 2px solid #dfe6e9;
                border-radius: 8px;
                padding: 0 12px;
                font-size: 13px;
            }
            QLineEdit:focus {
                border-color: #3498db;
            }
        """)
        layout.addWidget(self.api_key_input)

        # 获取链接
        self.help_label = QLabel()
        self.help_label.setStyleSheet("color: #3498db; font-size: 12px;")
        self.help_label.setOpenExternalLinks(True)
        layout.addWidget(self.help_label)

        # 测试结果
        self.status_label = QLabel()
        self.status_label.setStyleSheet("font-size: 12px;")
        layout.addWidget(self.status_label)

        layout.addStretch()

        # 按钮行
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(12)

        test_btn = QPushButton("测试连接")
        test_btn.setFixedHeight(38)
        test_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        test_btn.setStyleSheet("""
            QPushButton {
                background-color: #ecf0f1;
                color: #2c3e50;
                border: none;
                border-radius: 6px;
                padding: 0 20px;
                font-size: 13px;
            }
            QPushButton:hover {
                background-color: #d5dbdb;
            }
        """)
        test_btn.clicked.connect(self._test_connection)
        btn_layout.addWidget(test_btn)

        btn_layout.addStretch()

        cancel_btn = QPushButton("取消")
        cancel_btn.setFixedHeight(38)
        cancel_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        cancel_btn.setStyleSheet("""
            QPushButton {
                background-color: transparent;
                color: #7f8c8d;
                border: 1px solid #bdc3c7;
                border-radius: 6px;
                padding: 0 20px;
                font-size: 13px;
            }
            QPushButton:hover {
                background-color: #ecf0f1;
            }
        """)
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)

        save_btn = QPushButton("保存")
        save_btn.setFixedHeight(38)
        save_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        save_btn.setStyleSheet("""
            QPushButton {
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 6px;
                padding: 0 24px;
                font-size: 13px;
            }
            QPushButton:hover {
                background-color: #2980b9;
            }
        """)
        save_btn.clicked.connect(self._save_and_close)
        btn_layout.addWidget(save_btn)

        layout.addLayout(btn_layout)

        # 初始化帮助链接
        self._on_provider_changed(0)

    def _load_config(self):
        """加载当前配置"""
        provider = self.config.get("engine", "cloud_provider")
        api_key = self.config.get("engine", "cloud_api_key")

        provider_map = {
            "qwen": 0,
            "openai": 1,
            "deepseek": 2,
            "anthropic": 3,
            "groq": 4,
            "moonshot": 5,
            "siliconflow": 6,
        }
        self.provider_combo.setCurrentIndex(provider_map.get(provider, 0))

        if api_key:
            self.api_key_input.setText(api_key)

    def _on_provider_changed(self, index: int):
        """供应商切换"""
        help_links = [
            '<a href="https://dashscope.console.aliyun.com/apiKey">获取通义千问 API Key →</a>',
            '<a href="https://platform.openai.com/api-keys">获取 OpenAI API Key →</a>',
            '<a href="https://platform.deepseek.com/api_keys">获取 DeepSeek API Key →</a>',
            '<a href="https://console.anthropic.com/settings/keys">获取 Claude API Key →</a>',
            '<a href="https://console.groq.com/keys">获取 Groq API Key →</a>',
            '<a href="https://platform.moonshot.cn/console/api-keys">获取 Moonshot API Key →</a>',
            '<a href="https://cloud.siliconflow.cn/account/ak">获取 Siliconflow API Key →</a>',
        ]
        self.help_label.setText(help_links[index])
        self.status_label.clear()

    def _test_connection(self):
        """测试 API 连接"""
        if self._testing:
            return

        provider_map = ["qwen", "openai", "deepseek", "anthropic", "groq", "moonshot", "siliconflow"]
        provider = provider_map[self.provider_combo.currentIndex()]
        api_key = self.api_key_input.text().strip()

        if not api_key:
            self.status_label.setStyleSheet("color: #e74c3c; font-size: 12px;")
            self.status_label.setText("❌ 请输入 API Key")
            return

        self._testing = True
        self.status_label.setStyleSheet("color: #7f8c8d; font-size: 12px;")
        self.status_label.setText("⏳ 测试连接中...")

        try:
            # 简单验证 API Key 格式
            translator = CloudTranslator(
                provider=provider,
                api_key=api_key,
            )

            self.status_label.setStyleSheet("color: #27ae60; font-size: 12px;")
            self.status_label.setText("✓ API Key 格式正确")

        except Exception as e:
            self.status_label.setStyleSheet("color: #e74c3c; font-size: 12px;")
            self.status_label.setText(f"❌ 连接失败: {str(e)[:30]}")
        finally:
            self._testing = False

    def _save_and_close(self):
        """保存并关闭"""
        provider_map = ["qwen", "openai", "deepseek", "anthropic", "groq", "moonshot", "siliconflow"]
        provider = provider_map[self.provider_combo.currentIndex()]
        api_key = self.api_key_input.text().strip()

        self.config.update("engine", "cloud_provider", provider)
        if api_key:
            self.config.update("engine", "cloud_api_key", api_key)

        self.accept()


class QuickConfigWidget(QWidget):
    """
    快速配置组件
    可嵌入到其他界面中
    """

    def __init__(self, config: ConfigManager, parent=None):
        super().__init__(parent)
        self.config = config
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        # 状态显示
        self.status_label = QLabel()
        self._update_status()
        layout.addWidget(self.status_label)

        # 配置按钮
        config_btn = QPushButton("配置 API Key")
        config_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        config_btn.setStyleSheet("""
            QPushButton {
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 16px;
                font-size: 12px;
            }
            QPushButton:hover {
                background-color: #2980b9;
            }
        """)
        config_btn.clicked.connect(self._show_config_dialog)
        layout.addWidget(config_btn)

    def _update_status(self):
        """更新状态显示"""
        api_key = self.config.get("engine", "cloud_api_key")
        provider = self.config.get("engine", "cloud_provider")

        if api_key:
            self.status_label.setText(f"✓ 已配置: {provider.upper()}")
            self.status_label.setStyleSheet("color: #27ae60;")
        else:
            self.status_label.setText("⚠ 未配置 API Key")
            self.status_label.setStyleSheet("color: #e74c3c;")

    def _show_config_dialog(self):
        """显示配置对话框"""
        dialog = ApiKeyDialog(self.config, self)
        if dialog.exec():
            self._update_status()