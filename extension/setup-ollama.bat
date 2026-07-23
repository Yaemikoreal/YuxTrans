@echo off
chcp 65001 >nul
title YuxTrans 本地模型配置

:: F8：模型名参数化，默认 qwen3.5:0.8b，可用首个参数覆盖：setup-ollama.bat translategemma:4b
set MODEL=%1
if "%MODEL%"=="" set MODEL=qwen3.5:0.8b

:: 按模型映射体积
set MODEL_SIZE=约 1GB
if /I "%MODEL%"=="translategemma:4b" set MODEL_SIZE=约 3.3GB
if /I "%MODEL%"=="translategemma:12b" set MODEL_SIZE=约 8GB

echo.
echo ╔══════════════════════════════════════════╗
echo ║  YuxTrans 本地离线模型配置              ║
echo ║  %MODEL% (Ollama)
echo ╚══════════════════════════════════════════╝
echo.

:: ─── 步骤 1：检测 Ollama ───
echo [1/4] 检测 Ollama 是否已安装...
where ollama >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [×] 未检测到 Ollama
    echo.
    echo  请先安装 Ollama：
    echo    PowerShell 一键安装: irm https://ollama.com/install.ps1 ^| iex
    echo    下载地址:              https://ollama.com/download
    echo.
    echo  注意：
    echo    - 国内网络下载 Ollama 及模型可能较慢，可尝试网络加速或镜像。
    echo    - 本地模型性能受 CPU/GPU/内存限制，低配机器可能出现卡顿。
    echo    - 若本地运行不畅，可在扩展设置中切换为云端供应商作为备用。
    echo.
    echo  安装完成后重新运行此脚本。
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('ollama --version 2^>nul') do set OLLAMA_VER=%%i
echo  [✓] %OLLAMA_VER%
echo.

:: ─── 步骤 2：检测 Ollama 服务 ───
echo [2/4] 检测 Ollama 服务是否运行...
curl -s http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo  [!] Ollama 服务未运行，正在启动...
    start "" ollama serve
    timeout /t 5 /nobreak >nul

    :: 再次检测
    curl -s http://localhost:11434/api/tags >nul 2>&1
    if errorlevel 1 (
        echo  [×] 无法启动 Ollama 服务
        echo.
        echo  请手动运行: ollama serve
        echo  然后重新运行此脚本。
        echo.
        pause
        exit /b 1
    )
)
echo  [✓] Ollama 服务运行中
echo.

:: ─── 步骤 3：拉取模型 ───
echo [3/4] 下载 %MODEL% 模型（%MODEL_SIZE%）...
echo      首次下载需要一些时间，请耐心等待...
echo.

ollama pull %MODEL%
if errorlevel 1 (
    echo.
    echo  [×] 模型下载失败
    echo.
    echo  可能的原因：
    echo    - 网络连接问题
    echo    - 磁盘空间不足
    echo.
    echo  请检查后重试: ollama pull %MODEL%
    echo.
    pause
    exit /b 1
)
echo.
echo  [✓] 模型下载完成
echo.

:: ─── 步骤 4：验证模型 ───
echo [4/4] 验证模型可用性...
echo.

echo  测试翻译: "Hello, world!" →
ollama run %MODEL% "Translate to Chinese: Hello, world!" --nowordwrap 2>nul
echo.

:: 提取模型名首段用于列表匹配（处理含 tag 的 model，如 translategemma:4b），随后检查模型列表确认存在
for /f "tokens=1 delims=:" %%m in ("%MODEL%") do set MODEL_PREFIX=%%m
ollama list 2>nul | findstr "%MODEL_PREFIX%" >nul
if errorlevel 1 (
    echo  [!] 模型可能未正确安装，请手动检查: ollama list
) else (
    echo  [✓] 验证通过！模型已就绪。
)

echo.
echo ╔══════════════════════════════════════════╗
echo ║          配置完成!                       ║
echo ╠══════════════════════════════════════════╣
echo ║  接下来：                                ║
echo ║  1. 打开 YuxTrans 扩展设置页            ║
echo ║  2. 服务商选择「本地模型 (Ollama)」      ║
echo ║  3. 确认模型为 %MODEL%
echo ║  4. 点击「保存服务商配置」              ║
echo ║                                          ║
echo ║  现在可以离线使用翻译功能了！            ║
echo ╚══════════════════════════════════════════╝
echo  推荐模型分档（可按需切换，重跑脚本时用参数指定）：
echo    最快（低配 / 纯 CPU）    qwen3.5:0.8b         约 1GB
echo    推荐（专用翻译模型）     translategemma:4b    约 3.3GB
echo    最佳质量（高端机 / GPU） translategemma:12b   约 8GB
echo.
echo  示例: setup-ollama.bat translategemma:4b
echo.
pause
