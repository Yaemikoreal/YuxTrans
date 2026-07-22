"""
云端API翻译引擎
P2-001: 支持 Qwen/OpenAI/DeepSeek/Anthropic/Groq/Moonshot/Siliconflow
"""

import time
from typing import Any, AsyncGenerator, Dict, Optional

import httpx

from yuxtrans.engine.base import (
    BaseTranslator,
    EngineStatus,
    EngineType,
    TranslationError,
    TranslationRequest,
    TranslationResult,
)


class CloudTranslator(BaseTranslator):
    """
    云端API翻译器

    目标：响应 < 2s，兜底保障

    支持的供应商:
    - qwen: 阿里云通义千问 (DashScope API)
    - openai: OpenAI (ChatGPT)
    - deepseek: DeepSeek
    - anthropic: Anthropic (Claude)
    - groq: Groq (极速推理)
    - moonshot: Moonshot (月之暗面 Kimi)
    - siliconflow: Siliconflow (硅基流动)
    - custom: 自定义 OpenAI 兼容 API
    """

    engine_type = EngineType.CLOUD
    DEFAULT_TIMEOUT_MS = 3000
    DEFAULT_MAX_RETRIES = 3

    # API 端点配置
    API_ENDPOINTS = {
        "qwen": "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
        "openai": "https://api.openai.com/v1/chat/completions",
        "deepseek": "https://api.deepseek.com/v1/chat/completions",
        "anthropic": "https://api.anthropic.com/v1/messages",
        "groq": "https://api.groq.com/openai/v1/chat/completions",
        "moonshot": "https://api.moonshot.cn/v1/chat/completions",
        "siliconflow": "https://api.siliconflow.cn/v1/chat/completions",
    }

    # 供应商格式类型: "openai" 或 "anthropic"
    PROVIDER_FORMATS = {
        "qwen": "qwen",  # 特殊格式
        "openai": "openai",  # OpenAI 格式
        "deepseek": "openai",  # OpenAI 兼容格式
        "anthropic": "anthropic",  # Anthropic 格式
        "groq": "openai",  # OpenAI 兼容格式
        "moonshot": "openai",  # OpenAI 兼容格式
        "siliconflow": "openai",  # OpenAI 兼容格式
        "custom": "openai",  # 默认 OpenAI 兼容格式
    }

    def __init__(
        self,
        provider: str = "qwen",
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        temperature: float = 0.3,
        custom_endpoint: Optional[str] = None,
    ):
        super().__init__()
        self.provider = provider.lower()
        self.api_key = api_key
        self.model = model or self._default_model()
        self.timeout_ms = timeout_ms
        self.temperature = temperature
        self.custom_endpoint = custom_endpoint

        # 获取端点
        if self.provider == "custom" and custom_endpoint:
            self.endpoint = custom_endpoint
        else:
            self.endpoint = self.API_ENDPOINTS.get(self.provider)

        if not self.endpoint:
            raise ValueError(f"不支持的provider: {self.provider}")

        # 获取格式类型
        self.format_type = self.PROVIDER_FORMATS.get(self.provider, "openai")

        if not self.api_key:
            self._status = EngineStatus.UNAVAILABLE
        else:
            self._status = EngineStatus.READY

    def _default_model(self) -> str:
        """各供应商默认模型"""
        defaults = {
            "qwen": "qwen-turbo",
            "openai": "gpt-4o-mini",
            "deepseek": "deepseek-chat",
            "anthropic": "claude-3-5-haiku-latest",
            "groq": "llama-3.1-8b-instant",
            "moonshot": "moonshot-v1-8k",
            "siliconflow": "Qwen/Qwen2.5-7B-Instruct",
            "custom": "gpt-3.5-turbo",
        }
        return defaults.get(self.provider, "qwen-turbo")

    def _build_request_body(self, request: TranslationRequest) -> Dict[str, Any]:
        """根据供应商格式构建请求体"""
        prompt = self._build_prompt(request)

        if self.format_type == "qwen":
            # Qwen 特殊格式 (DashScope)
            return {
                "model": self.model,
                "input": {"messages": [{"role": "user", "content": prompt}]},
                "parameters": {"temperature": self.temperature},
            }
        elif self.format_type == "anthropic":
            # Anthropic Claude 格式
            return {
                "model": self.model,
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            }
        else:
            # OpenAI 兼容格式 (OpenAI/DeepSeek/Groq/Moonshot/Siliconflow/Custom)
            return {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": self.temperature,
                "stream": False,
            }

    def _build_prompt(self, request: TranslationRequest) -> str:
        """构建翻译提示词"""
        # 可以根据供应商优化提示词
        if self.format_type == "anthropic":
            return (
                f"Translate the following text from {request.source_lang} "
                f"to {request.target_lang}. Provide only the translation, "
                f"without any explanation or additional commentary.\n\n"
                f"Text to translate:\n{request.text}"
            )
        return (
            f"Translate the following text from {request.source_lang} "
            f"to {request.target_lang}. Provide only the translation.\n\n"
            f"{request.text}"
        )

    def _get_headers(self) -> Dict[str, str]:
        """根据供应商获取请求头"""
        if self.format_type == "anthropic":
            return {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            }
        elif self.provider == "qwen":
            return {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
        else:
            # OpenAI 兼容格式
            return {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        if not self.is_available:
            raise TranslationError("云端API不可用（未配置API Key）", engine=self.engine_type.value)

        start_time = time.perf_counter()

        try:
            body = self._build_request_body(request)
            headers = self._get_headers()

            async with httpx.AsyncClient(timeout=self.timeout_ms / 1000) as client:
                response = await client.post(
                    self.endpoint,
                    json=body,
                    headers=headers,
                )

                if response.status_code != 200:
                    raise TranslationError(
                        f"API错误: {response.status_code}",
                        engine=self.engine_type.value,
                    )

                data = response.json()
                translated_text = self._extract_translation(data)

            response_time = self._measure_time(start_time)
            self._record_success(response_time)

            return TranslationResult(
                text=translated_text,
                source_lang=request.source_lang,
                target_lang=request.target_lang,
                engine=self.engine_type,
                response_time_ms=response_time,
                cached=False,
                metadata={
                    "provider": self.provider,
                    "model": self.model,
                },
            )

        except Exception as e:
            response_time = self._measure_time(start_time)
            self._record_error()
            raise TranslationError(
                f"云端翻译失败: {str(e)}",
                engine=self.engine_type.value,
                original_error=e,
            )

    def _extract_translation(self, data: Dict[str, Any]) -> str:
        """根据供应商格式提取翻译结果"""
        if self.format_type == "qwen":
            # Qwen DashScope 格式
            return data.get("output", {}).get("text", "")
        elif self.format_type == "anthropic":
            # Anthropic Claude 格式
            content = data.get("content", [])
            if content and len(content) > 0:
                return content[0].get("text", "")
            return ""
        else:
            # OpenAI 兼容格式
            return data.get("choices", [{}])[0].get("message", {}).get("content", "")

    async def translate_stream(self, request: TranslationRequest) -> AsyncGenerator[str, None]:
        if not self.is_available:
            raise TranslationError("云端API不可用", engine=self.engine_type.value)

        body = self._build_request_body(request)
        body["stream"] = True
        headers = self._get_headers()

        try:
            async with httpx.AsyncClient(timeout=self.timeout_ms / 1000) as client:
                async with client.stream(
                    "POST",
                    self.endpoint,
                    json=body,
                    headers=headers,
                ) as response:
                    async for line in response.aiter_lines():
                        if line.strip():
                            chunk = self._parse_stream_chunk(line)
                            if chunk:
                                yield chunk

        except Exception as e:
            raise TranslationError(
                f"流式翻译失败: {str(e)}",
                engine=self.engine_type.value,
                original_error=e,
            )

    def _parse_stream_chunk(self, line: str) -> Optional[str]:
        """解析流式响应块"""
        import json

        if line.startswith("data:"):
            line = line[5:].strip()
        if line == "[DONE]":
            return None
        try:
            data = json.loads(line)
            if self.format_type == "qwen":
                return data.get("output", {}).get("text", "")
            elif self.format_type == "anthropic":
                # Anthropic 流式格式
                if data.get("type") == "content_block_delta":
                    return data.get("delta", {}).get("text", "")
                return ""
            else:
                # OpenAI 兼容格式
                return data.get("choices", [{}])[0].get("delta", {}).get("content", "")
        except json.JSONDecodeError:
            return None

    async def health_check(self) -> bool:
        if not self.api_key:
            return False

        try:
            test_request = TranslationRequest(
                text="Hello",
                source_lang="en",
                target_lang="zh",
            )
            result = await self.translate(test_request)
            return result.is_success
        except Exception:
            return False

    @classmethod
    def get_supported_providers(cls) -> Dict[str, Dict[str, Any]]:
        """获取支持的供应商列表及配置信息"""
        return {
            "qwen": {
                "name": "阿里云通义千问",
                "endpoint": cls.API_ENDPOINTS["qwen"],
                "default_model": "qwen-turbo",
                "format": "qwen",
                "api_key_url": "https://dashscope.console.aliyun.com/apiKey",
            },
            "openai": {
                "name": "OpenAI",
                "endpoint": cls.API_ENDPOINTS["openai"],
                "default_model": "gpt-4o-mini",
                "format": "openai",
                "api_key_url": "https://platform.openai.com/api-keys",
            },
            "deepseek": {
                "name": "DeepSeek",
                "endpoint": cls.API_ENDPOINTS["deepseek"],
                "default_model": "deepseek-chat",
                "format": "openai",
                "api_key_url": "https://platform.deepseek.com/api_keys",
            },
            "anthropic": {
                "name": "Anthropic (Claude)",
                "endpoint": cls.API_ENDPOINTS["anthropic"],
                "default_model": "claude-3-5-haiku-latest",
                "format": "anthropic",
                "api_key_url": "https://console.anthropic.com/settings/keys",
            },
            "groq": {
                "name": "Groq (极速推理)",
                "endpoint": cls.API_ENDPOINTS["groq"],
                "default_model": "llama-3.1-8b-instant",
                "format": "openai",
                "api_key_url": "https://console.groq.com/keys",
            },
            "moonshot": {
                "name": "Moonshot (Kimi)",
                "endpoint": cls.API_ENDPOINTS["moonshot"],
                "default_model": "moonshot-v1-8k",
                "format": "openai",
                "api_key_url": "https://platform.moonshot.cn/console/api-keys",
            },
            "siliconflow": {
                "name": "Siliconflow (硅基流动)",
                "endpoint": cls.API_ENDPOINTS["siliconflow"],
                "default_model": "Qwen/Qwen2.5-7B-Instruct",
                "format": "openai",
                "api_key_url": "https://cloud.siliconflow.cn/account/ak",
            },
            "custom": {
                "name": "自定义 OpenAI 兼容 API",
                "endpoint": "自定义",
                "default_model": "自定义",
                "format": "openai",
                "api_key_url": "自定义",
            },
        }
