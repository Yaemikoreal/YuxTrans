"""单元测试 - 云端与本地引擎（无网络）

覆盖 CloudTranslator 的请求构建、三供应商格式提取、流式解析、API 错误路径，
以及 LocalTranslator 在 mock ollama 下的翻译与流式。本文件不发起任何真实网络请求。
"""

import types

import pytest

from yuxtrans.engine import cloud as cloud_mod
from yuxtrans.engine import local as local_mod
from yuxtrans.engine.base import EngineStatus, EngineType, TranslationError, TranslationRequest
from yuxtrans.engine.cloud import CloudTranslator
from yuxtrans.engine.local import LocalTranslator

# ===== Fake httpx 基础设施 =====


class _FakeResponse:
    """模拟 httpx 同步响应（translate 路径）"""

    def __init__(self, status_code=200, json_data=None):
        self.status_code = status_code
        self._json = json_data or {}

    def json(self):
        return self._json


class _FakeStreamResponse:
    """模拟 httpx 流式响应（translate_stream 路径）"""

    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line


def _patch_async_client(monkeypatch, response=None, stream_lines=None):
    """
    将 cloud 模块中的 httpx.AsyncClient 替换为可控假对象

    Args:
        response: translate 路径返回的 _FakeResponse
        stream_lines: translate_stream 路径逐行返回的文本列表
    """

    class _FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            return response

        def stream(self, *args, **kwargs):
            class _CM:
                async def __aenter__(self_inner):
                    return _FakeStreamResponse(stream_lines or [])

                async def __aexit__(self_inner, *args):
                    return False

            return _CM()

    monkeypatch.setattr(cloud_mod.httpx, "AsyncClient", lambda **kwargs: _FakeClient())


# ===== CloudTranslator: 非流式 translate =====


@pytest.mark.asyncio
async def test_cloud_translate_openai_format(monkeypatch):
    """OpenAI 兼容格式：从 choices[0].message.content 提取"""
    translator = CloudTranslator(provider="openai", api_key="sk-test")
    fake = _FakeResponse(200, {"choices": [{"message": {"content": "你好"}}]})
    _patch_async_client(monkeypatch, response=fake)

    result = await translator.translate(
        TranslationRequest(text="hello", source_lang="en", target_lang="zh")
    )

    assert result.text == "你好"
    assert result.engine == EngineType.CLOUD
    assert not result.cached
    assert translator._total_requests == 1
    assert translator.error_rate == 0.0


@pytest.mark.asyncio
async def test_cloud_translate_qwen_format(monkeypatch):
    """Qwen DashScope 格式：从 output.text 提取"""
    translator = CloudTranslator(provider="qwen", api_key="sk-test")
    fake = _FakeResponse(200, {"output": {"text": "世界"}})
    _patch_async_client(monkeypatch, response=fake)

    result = await translator.translate(
        TranslationRequest(text="world", source_lang="en", target_lang="zh")
    )

    assert result.text == "世界"


@pytest.mark.asyncio
async def test_cloud_translate_anthropic_format(monkeypatch):
    """Anthropic 格式：从 content[0].text 提取"""
    translator = CloudTranslator(provider="anthropic", api_key="sk-test")
    fake = _FakeResponse(200, {"content": [{"text": "函数"}]})
    _patch_async_client(monkeypatch, response=fake)

    result = await translator.translate(
        TranslationRequest(text="function", source_lang="en", target_lang="zh")
    )

    assert result.text == "函数"


@pytest.mark.asyncio
async def test_cloud_translate_api_error(monkeypatch):
    """非 200 响应应抛 TranslationError 并记录错误"""
    translator = CloudTranslator(provider="openai", api_key="sk-test")
    fake = _FakeResponse(401, {"error": "invalid key"})
    _patch_async_client(monkeypatch, response=fake)

    with pytest.raises(TranslationError):
        await translator.translate(TranslationRequest(text="hello"))

    assert translator.error_rate == 1.0
    assert translator._total_requests == 1


@pytest.mark.asyncio
async def test_cloud_not_available_without_api_key():
    """无 API Key 时不可用，translate 应抛错"""
    translator = CloudTranslator(provider="openai", api_key=None)
    assert not translator.is_available
    assert translator.status == EngineStatus.UNAVAILABLE

    with pytest.raises(TranslationError):
        await translator.translate(TranslationRequest(text="hello"))


# ===== CloudTranslator: 流式 translate_stream（回归 bug #1）=====


@pytest.mark.asyncio
async def test_cloud_translate_stream(monkeypatch):
    """流式：用 async for 消费 httpx 流式行（回归 for->async for 修复）"""
    translator = CloudTranslator(provider="openai", api_key="sk-test")
    # OpenAI SSE 格式：data: {json}\n\n
    lines = [
        'data: {"choices": [{"delta": {"content": "你"}}]}',
        'data: {"choices": [{"delta": {"content": "好"}}]}',
        "data: [DONE]",
    ]
    _patch_async_client(monkeypatch, stream_lines=lines)

    chunks = []
    async for chunk in translator.translate_stream(
        TranslationRequest(text="hello", source_lang="en", target_lang="zh")
    ):
        chunks.append(chunk)

    assert chunks == ["你", "好"]


@pytest.mark.asyncio
async def test_cloud_stream_unavailable_raises():
    """不可用时流式应抛 TranslationError"""
    translator = CloudTranslator(provider="openai", api_key=None)

    gen = translator.translate_stream(TranslationRequest(text="hello"))
    with pytest.raises(TranslationError):
        await gen.__anext__()


def test_cloud_parse_stream_chunk_formats():
    """_parse_stream_chunk 三格式解析（各 provider 用对应 format_type）"""
    # OpenAI 兼容格式
    t_openai = CloudTranslator(provider="openai", api_key="sk-test")
    assert t_openai._parse_stream_chunk('{"choices":[{"delta":{"content":"hi"}}]}') == "hi"
    # Qwen DashScope 格式
    t_qwen = CloudTranslator(provider="qwen", api_key="sk-test")
    assert t_qwen._parse_stream_chunk('{"output":{"text":"你好"}}') == "你好"
    # Anthropic content_block_delta
    t_anthropic = CloudTranslator(provider="anthropic", api_key="sk-test")
    assert (
        t_anthropic._parse_stream_chunk('{"type":"content_block_delta","delta":{"text":"x"}}')
        == "x"
    )
    # [DONE] 与无效 JSON 应返回 None
    assert t_openai._parse_stream_chunk("[DONE]") is None
    assert t_openai._parse_stream_chunk("not json") is None


# ===== LocalTranslator：mock ollama =====


def _install_fake_ollama(monkeypatch, chat_return):
    """
    注入假 ollama 模块并置 OLLAMA_AVAILABLE=True

    Args:
        chat_return: ollama.chat() 的返回值（dict 或可迭代对象）
    """
    fake = types.ModuleType("ollama")
    fake.chat = lambda **kwargs: chat_return
    monkeypatch.setattr(local_mod, "ollama", fake, raising=False)
    monkeypatch.setattr(local_mod, "OLLAMA_AVAILABLE", True)
    return fake


@pytest.mark.asyncio
async def test_local_translate_with_mock_ollama(monkeypatch):
    """mock ollama.chat 返回翻译内容"""
    _install_fake_ollama(monkeypatch, {"message": {"content": "  你好  "}})
    translator = LocalTranslator()

    assert translator.is_available

    result = await translator.translate(
        TranslationRequest(text="hello", source_lang="en", target_lang="zh")
    )

    assert result.text == "你好"
    assert result.engine == EngineType.LOCAL
    assert translator._total_requests == 1


@pytest.mark.asyncio
async def test_local_translate_stream_with_mock_ollama(monkeypatch):
    """mock ollama.chat(stream=True) 返回分块迭代器"""
    _install_fake_ollama(
        monkeypatch,
        [{"message": {"content": "你"}}, {"message": {"content": "好"}}],
    )
    translator = LocalTranslator()

    chunks = []
    async for chunk in translator.translate_stream(
        TranslationRequest(text="hello", source_lang="en", target_lang="zh")
    ):
        chunks.append(chunk)

    assert chunks == ["你", "好"]


@pytest.mark.asyncio
async def test_local_unavailable_when_ollama_missing():
    """OLLAMA_AVAILABLE=False 时不可用，translate 抛错"""
    translator = LocalTranslator()
    assert not translator.is_available

    with pytest.raises(TranslationError):
        await translator.translate(TranslationRequest(text="hello"))
