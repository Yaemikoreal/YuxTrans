"""
首次启动配置向导
让用户选择翻译模式
"""

import sys
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import yaml
except ImportError:
    yaml = None


CONFIG_DIR = Path.home() / ".yuxtrans"
CONFIG_FILE = CONFIG_DIR / "config.yaml"


def is_first_run() -> bool:
    """检测是否首次运行"""
    return not CONFIG_FILE.exists()


def run_setup_wizard() -> Dict[str, Any]:
    """运行配置向导"""
    print("\n" + "=" * 50)
    print("    YuxTrans 首次启动配置")
    print("=" * 50 + "\n")

    config = {"version": "0.1.0", "translation": {}, "ui": {}}

    print("请选择翻译模式:\n")
    print("  [1] 云端 API (推荐)")
    print("      - 开箱即用，无需本地模型")
    print("      - 需要 API Key\n")
    print("  [2] 本地模型")
    print("      - 隐私优先，离线可用")
    print("      - 需要安装 Ollama + 下载模型 (~4GB)\n")

    while True:
        try:
            choice = input("请输入选择 [1/2]: ").strip()
            if choice in ["1", "2"]:
                break
            print("无效选择，请输入 1 或 2")
        except (EOFError, KeyboardInterrupt):
            print("\n\n配置已取消")
            sys.exit(0)

    if choice == "1":
        config["translation"]["mode"] = "cloud"
        config = _configure_cloud(config)
    else:
        config["translation"]["mode"] = "local"
        config = _configure_local(config)

    _save_config(config)

    print("\n" + "=" * 50)
    print("    配置完成!")
    print("=" * 50 + "\n")

    return config


def _configure_cloud(config: Dict[str, Any]) -> Dict[str, Any]:
    """配置云端模式"""
    print("\n选择云端服务商:\n")
    print("  [1] 通义千问 - 推荐，中文优化")
    print("  [2] OpenAI (ChatGPT)")
    print("  [3] DeepSeek\n")

    providers = {
        "1": {"name": "qwen", "url": "https://dashscope.aliyuncs.com"},
        "2": {"name": "openai", "url": "https://api.openai.com"},
        "3": {"name": "deepseek", "url": "https://api.deepseek.com"},
    }

    while True:
        try:
            choice = input("请输入选择 [1/2/3]: ").strip()
            if choice in providers:
                break
            print("无效选择")
        except (EOFError, KeyboardInterrupt):
            print("\n")
            sys.exit(0)

    provider = providers[choice]
    config["translation"]["provider"] = provider["name"]

    print(f"\n配置 {provider['name'].upper()} API:")
    print(f"  获取地址: {provider['url']}")

    try:
        api_key = input("\n请输入 API Key: ").strip()
        if api_key:
            config["translation"]["api_key"] = api_key
    except (EOFError, KeyboardInterrupt):
        print("\n")
        config["translation"]["api_key"] = ""

    return config


def _configure_local(config: Dict[str, Any]) -> Dict[str, Any]:
    """配置本地模式"""
    print("\n检测 Ollama...")

    import shutil

    if shutil.which("ollama"):
        print("  [✓] Ollama 已安装")

        try:
            import subprocess

            result = subprocess.run(["ollama", "list"], capture_output=True, text=True)
            if result.returncode == 0:
                print("\n可用模型:")
                print(result.stdout)

                try:
                    model = input("输入要使用的模型名称 (默认 qwen2:7b): ").strip()
                    if not model:
                        model = "qwen2:7b"
                    config["translation"]["model"] = model
                except (EOFError, KeyboardInterrupt):
                    config["translation"]["model"] = "qwen2:7b"
        except Exception:
            config["translation"]["model"] = "qwen2:7b"
    else:
        print("  [×] Ollama 未安装")
        print("\n安装指引:")
        print("  Windows: irm https://ollama.com/install.ps1 | iex")
        print("  Mac:     curl -fsSL https://ollama.com/install.sh | sh")
        print("  Linux:   curl -fsSL https://ollama.com/install.sh | sh")
        print("  下载页:  https://ollama.com/download")
        print("\n注意:")
        print("  - 国内网络下载 Ollama 及模型可能较慢，可尝试网络加速或镜像。")
        print("  - 本地模型性能受 CPU/GPU/内存限制，低配机器可能出现卡顿。")
        print("  - 若本地运行不畅，可配置云端供应商作为备用方案。")
        print("\n安装后运行: ollama pull qwen2:7b")
        config["translation"]["model"] = "qwen2:7b"

    return config


def _save_config(config: Dict[str, Any]):
    """保存配置"""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    if yaml:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
    else:
        import json

        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

    print(f"\n配置已保存到: {CONFIG_FILE}")


def load_config() -> Optional[Dict[str, Any]]:
    """加载配置"""
    if not CONFIG_FILE.exists():
        return None

    try:
        if yaml:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
        else:
            import json

            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        return None


def get_config() -> Dict[str, Any]:
    """获取配置（首次运行则启动向导）"""
    config = load_config()
    if config is None:
        config = run_setup_wizard()
    return config


if __name__ == "__main__":
    run_setup_wizard()
