#!/usr/bin/env bash
# YuxTrans 本地离线模型一键配置脚本
# 模型: Qwen3.5-0.8B (Ollama)

set -euo pipefail

# ─── 颜色定义 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # 无颜色

# F8：模型名参数化，默认 qwen3.5:0.8b，可用首个参数覆盖：./setup-ollama.sh translategemma:4b
MODEL="${1:-qwen3.5:0.8b}"

# 按模型映射体积（三档推荐中的大小）
get_model_size() {
  case "$1" in
    qwen3.5:0.8b)        echo "约 1GB" ;;
    translategemma:4b)  echo "约 3.3GB" ;;
    translategemma:12b) echo "约 8GB" ;;
    *)                  echo "约 1GB" ;;
  esac
}
MODEL_SIZE=$(get_model_size "${MODEL}")

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  YuxTrans 本地离线模型配置              ║${NC}"
echo -e "${CYAN}║  ${MODEL} (Ollama)$(printf '%*s' $((20 - ${#MODEL})) '')║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── 步骤 1：检测 Ollama ───
echo -e "${BOLD}[1/4] 检测 Ollama 是否已安装...${NC}"

if ! command -v ollama &>/dev/null; then
    echo ""
    echo -e "  ${RED}[×] 未检测到 Ollama${NC}"
    echo ""
    echo "  请先安装 Ollama："
    echo "    macOS/Linux: curl -fsSL https://ollama.com/install.sh | sh"
    echo "    下载地址:    https://ollama.com/download"
    echo ""
    echo "  注意："
    echo "    - 国内网络下载 Ollama 及模型可能较慢，可尝试网络加速或镜像。"
    echo "    - 本地模型性能受 CPU/GPU/内存限制，低配机器可能出现卡顿。"
    echo "    - 若本地运行不畅，可在扩展设置中切换为云端供应商作为备用。"
    echo ""
    echo "  安装完成后重新运行此脚本。"
    echo ""
    exit 1
fi

OLLAMA_VER=$(ollama --version 2>/dev/null || echo "unknown")
echo -e "  ${GREEN}[✓]${NC} ${OLLAMA_VER}"
echo ""

# ─── 步骤 2：检测 Ollama 服务 ───
echo -e "${BOLD}[2/4] 检测 Ollama 服务是否运行...${NC}"

if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
    echo -e "  ${YELLOW}[!] Ollama 服务未运行，正在启动...${NC}"

    # 尝试后台启动
    nohup ollama serve &>/dev/null &
    sleep 5

    if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
        echo -e "  ${RED}[×] 无法启动 Ollama 服务${NC}"
        echo ""
        echo "  请在另一个终端运行: ollama serve"
        echo "  然后重新运行此脚本。"
        echo ""
        exit 1
    fi
fi

echo -e "  ${GREEN}[✓]${NC} Ollama 服务运行中"
echo ""

# ─── 步骤 3：拉取模型 ───
echo -e "${BOLD}[3/4] 下载 ${MODEL} 模型（${MODEL_SIZE}）...${NC}"
echo "      首次下载需要一些时间，请耐心等待..."
echo ""

if ollama pull "${MODEL}"; then
    echo ""
    echo -e "  ${GREEN}[✓]${NC} 模型下载完成"
else
    echo ""
    echo -e "  ${RED}[×] 模型下载失败${NC}"
    echo ""
    echo "  可能的原因："
    echo "    - 网络连接问题"
    echo "    - 磁盘空间不足"
    echo ""
    echo "  请检查后重试: ollama pull ${MODEL}"
    echo ""
    exit 1
fi
echo ""

# ─── 步骤 4：验证模型 ───
echo -e "${BOLD}[4/4] 验证模型可用性...${NC}"
echo ""

echo -n '  测试翻译: "Hello, world!" → '
RESULT=$(ollama run "${MODEL}" "Translate to Chinese: Hello, world!" --nowordwrap 2>/dev/null || true)
if [ -n "${RESULT}" ]; then
    echo "${RESULT}"
else
    echo -e "${YELLOW}(无输出，模型可能需要加载)${NC}"
fi
echo ""

# 检查模型列表
if ollama list 2>/dev/null | grep -q "${MODEL%%:*}"; then
    echo -e "  ${GREEN}[✓] 验证通过！模型已就绪。${NC}"
else
    echo -e "  ${YELLOW}[!] 模型可能未正确安装，请检查: ollama list${NC}"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║          配置完成!                       ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║  接下来：                                ║${NC}"
echo -e "${CYAN}║  1. 打开 YuxTrans 扩展设置页            ║${NC}"
echo -e "${CYAN}║  2. 服务商选择「本地模型 (Ollama)」      ║${NC}"
echo -e "${CYAN}║  4. 点击「保存服务商配置」              ║${NC}"
echo -e "${CYAN}║                                          ║${NC}"
echo -e "${CYAN}║  现在可以离线使用翻译功能了！            ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}推荐模型分档（可按需切换，重跑脚本时用参数指定）：${NC}"
echo -e "  ${GREEN}最快（低配 / 纯 CPU）${NC}    qwen3.5:0.8b         约 1GB"
echo -e "  ${YELLOW}推荐（专用翻译模型）${NC}     translategemma:4b    约 3.3GB"
echo -e "  ${CYAN}最佳质量（高端机 / GPU）${NC}  translategemma:12b   约 8GB"
echo ""
echo "  示例: ./setup-ollama.sh translategemma:4b"
echo ""
