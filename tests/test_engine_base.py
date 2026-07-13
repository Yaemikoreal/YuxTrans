"""单元测试 - 翻译引擎基类"""

import time

import pytest

from yuxtrans.engine.base import (
    BaseTranslator,
    EngineStatus,
    EngineType,
    TranslationError,
    TranslationRequest,
    TranslationResult,
)


class MockTranslator(BaseTranslator):
    """模拟翻译器用于测试"""

    engine_type = EngineType.LOCAL

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        start_time = time.perf_counter()
        response_time = (time.perf_counter() - start_time) * 1000
        self._record_success(response_time)
        return TranslationResult(
            text=f"翻译: {request.text}",
            source_lang=request.source_lang,
            target_lang=request.target_lang,
            engine=self.engine_type,
            response_time_ms=100.0,
        )

    async def translate_stream(self, request):
        yield "翻译"
        yield ": "
        yield request.text


@pytest.mark.asyncio
async def test_translation_request_validation():
    with pytest.raises(TranslationError):
        TranslationRequest(text="")

    with pytest.raises(TranslationError):
        TranslationRequest(text="   ")

    valid_request = TranslationRequest(text="Hello")
    assert valid_request.text == "Hello"


@pytest.mark.asyncio
async def test_translation_result_is_success():
    success_result = TranslationResult(
        text="你好",
        source_lang="en",
        target_lang="zh",
        engine=EngineType.LOCAL,
        response_time_ms=100.0,
    )
    assert success_result.is_success

    empty_result = TranslationResult(
        text="",
        source_lang="en",
        target_lang="zh",
        engine=EngineType.LOCAL,
        response_time_ms=100.0,
    )
    assert not empty_result.is_success


@pytest.mark.asyncio
async def test_mock_translator():
    translator = MockTranslator()
    request = TranslationRequest(text="Hello", source_lang="en", target_lang="zh")

    result = await translator.translate(request)

    assert result.text == "翻译: Hello"
    assert result.engine == EngineType.LOCAL
    assert translator._total_requests == 1


@pytest.mark.asyncio
async def test_translator_stream():
    translator = MockTranslator()
    request = TranslationRequest(text="Hello")

    chunks = []
    async for chunk in translator.translate_stream(request):
        chunks.append(chunk)

    assert chunks == ["翻译", ": ", "Hello"]


@pytest.mark.asyncio
async def test_translator_health_check():
    translator = MockTranslator()

    is_healthy = await translator.health_check()
    assert is_healthy


@pytest.mark.asyncio
async def test_translator_stats():
    translator = MockTranslator()

    for i in range(10):
        request = TranslationRequest(text=f"test_{i}")
        await translator.translate(request)

    assert translator._total_requests == 10
    assert translator.avg_response_time_ms > 0
    assert translator.error_rate == 0.0


@pytest.mark.asyncio
async def test_translator_status():
    translator = MockTranslator()

    assert translator.status == EngineStatus.READY
    assert translator.is_available


@pytest.mark.asyncio
async def test_translation_error():
    error = TranslationError(
        "测试错误", engine="local", original_error=ValueError("原始错误")
    )

    assert str(error) == "测试错误"
    assert error.engine == "local"
    assert isinstance(error.original_error, ValueError)
