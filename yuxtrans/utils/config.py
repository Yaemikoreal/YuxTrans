"""
配置管理系统
P2-005: YAML配置，用户偏好管理
"""

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import yaml


@dataclass
class EngineConfig:
    """引擎配置"""

    prefer_local: bool = True
    local_model: str = "qwen2:7b"
    local_timeout_ms: int = 5000
    local_temperature: float = 0.3

    cloud_provider: str = "qwen"
    cloud_model: str = "qwen-turbo"
    cloud_timeout_ms: int = 3000
    cloud_temperature: float = 0.3
    cloud_api_key: Optional[str] = None

    cache_enabled: bool = True
    cache_ttl_days: int = 30
    cache_lru_size: int = 10000
    cache_db_path: Optional[str] = None


@dataclass
class PerformanceConfig:
    """性能配置"""

    target_cache_hit_ms: float = 10.0
    target_local_response_ms: float = 500.0
    target_cloud_response_ms: float = 2000.0

    max_retries: int = 3
    retry_delay_ms: int = 100
    retry_strategy: str = "exponential"

    max_concurrent_requests: int = 10
    rate_limit_per_second: float = 10.0

    bleu_threshold: float = 0.70
    success_rate_threshold: float = 0.95


@dataclass
class UIConfig:
    """界面配置"""

    theme: str = "light"
    language: str = "zh"
    show_engine_indicator: bool = True
    show_response_time: bool = True

    hotkey_translate: str = "Ctrl+Shift+T"
    hotkey_paste: str = "Ctrl+Shift+P"

    window_width: int = 400
    window_height: int = 300
    window_opacity: float = 0.95


@dataclass
class AppConfig:
    """应用配置"""

    engine: EngineConfig = field(default_factory=EngineConfig)
    performance: PerformanceConfig = field(default_factory=PerformanceConfig)
    ui: UIConfig = field(default_factory=UIConfig)

    version: str = "0.1.0"
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AppConfig":
        engine = EngineConfig(**data.get("engine", {}))
        performance = PerformanceConfig(**data.get("performance", {}))
        ui = UIConfig(**data.get("ui", {}))

        return cls(
            engine=engine,
            performance=performance,
            ui=ui,
            version=data.get("version", "0.1.0"),
            created_at=data.get("created_at", datetime.now().isoformat()),
            updated_at=data.get("updated_at", datetime.now().isoformat()),
        )


class ConfigManager:
    """
    配置管理器

    支持：
    - YAML文件配置
    - 环境变量
    - 用户偏好持久化
    """

    DEFAULT_CONFIG_PATH = "~/.yuxtrans/config.yaml"
    ENV_PREFIX = "YUXTRANS_"

    def __init__(self, config_path: Optional[str] = None):
        self.config_path = Path(config_path or self.DEFAULT_CONFIG_PATH).expanduser()
        self._config: Optional[AppConfig] = None

    def load(self) -> AppConfig:
        """加载配置"""
        if self.config_path.exists():
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}

                self._config = AppConfig.from_dict(data)

            except Exception:
                self._config = AppConfig()
        else:
            self._config = AppConfig()

        self._apply_env_overrides()

        return self._config

    def save(self, config: Optional[AppConfig] = None):
        """保存配置"""
        config = config or self._config
        if config is None:
            return

        config.updated_at = datetime.now().isoformat()

        self.config_path.parent.mkdir(parents=True, exist_ok=True)

        with open(self.config_path, "w", encoding="utf-8") as f:
            yaml.dump(config.to_dict(), f, default_flow_style=False, allow_unicode=True)

    def _apply_env_overrides(self):
        """应用环境变量覆盖"""
        import os

        if self._config is None:
            return

        env_mappings = {
            "YUXTRANS_LOCAL_MODEL": ("engine", "local_model"),
            "YUXTRANS_LOCAL_TIMEOUT": ("engine", "local_timeout_ms"),
            "YUXTRANS_CLOUD_PROVIDER": ("engine", "cloud_provider"),
            "YUXTRANS_CLOUD_MODEL": ("engine", "cloud_model"),
            "YUXTRANS_CLOUD_API_KEY": ("engine", "cloud_api_key"),
            "YUXTRANS_CACHE_DB_PATH": ("engine", "cache_db_path"),
            "YUXTRANS_MAX_RETRIES": ("performance", "max_retries"),
            "YUXTRANS_RATE_LIMIT": ("performance", "rate_limit_per_second"),
            "YUXTRANS_BLEU_THRESHOLD": ("performance", "bleu_threshold"),
        }

        for env_key, (section, attr) in env_mappings.items():
            value = os.getenv(env_key)
            if value:
                section_obj = getattr(self._config, section)
                current_value = getattr(section_obj, attr)

                if isinstance(current_value, int):
                    setattr(section_obj, attr, int(value))
                elif isinstance(current_value, float):
                    setattr(section_obj, attr, float(value))
                elif isinstance(current_value, bool):
                    setattr(section_obj, attr, value.lower() in ("true", "1", "yes"))
                else:
                    setattr(section_obj, attr, value)

    def update(self, section: str, key: str, value: Any):
        """更新配置项"""
        if self._config is None:
            self.load()

        section_obj = getattr(self._config, section)
        setattr(section_obj, key, value)

        self.save()

    def get(self, section: str, key: str) -> Any:
        """获取配置项"""
        if self._config is None:
            self.load()

        section_obj = getattr(self._config, section)
        return getattr(section_obj, key)

    def reset(self):
        """重置为默认配置"""
        self._config = AppConfig()
        self.save()

    @property
    def config(self) -> AppConfig:
        """获取当前配置"""
        if self._config is None:
            self._config = self.load()
        return self._config

    def export_to_json(self, filepath: str):
        """导出为JSON"""
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(self.config.to_dict(), f, indent=2, ensure_ascii=False)

    def import_from_json(self, filepath: str):
        """从JSON导入"""
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        self._config = AppConfig.from_dict(data)
        self.save()


DEFAULT_CONFIG_YAML = """
# YuxTrans 配置文件
# 响应速度是生命，翻译准度是底线

engine:
  prefer_local: true
  local_model: qwen2:7b
  local_timeout_ms: 5000
  local_temperature: 0.3

  cloud_provider: qwen
  cloud_model: qwen-turbo
  cloud_timeout_ms: 3000
  cloud_temperature: 0.3

  cache_enabled: true
  cache_ttl_days: 30
  cache_lru_size: 10000

performance:
  target_cache_hit_ms: 10.0
  target_local_response_ms: 500.0
  target_cloud_response_ms: 2000.0

  max_retries: 3
  retry_delay_ms: 100
  retry_strategy: exponential

  max_concurrent_requests: 10
  rate_limit_per_second: 10.0

  bleu_threshold: 0.70
  success_rate_threshold: 0.95

ui:
  theme: light
  language: zh
  show_engine_indicator: true
  show_response_time: true

  hotkey_translate: Ctrl+Shift+T
  hotkey_paste: Ctrl+Shift+P

  window_width: 400
  window_height: 300
  window_opacity: 0.95
"""
