"""单元测试 - SmartRouter 故障转移与 preload

覆盖缓存->本地->云端的逐级 fallback、流式路由故障转移，
以及带缓存时 preload() 不再抛 TypeError（回归 bug #4）。
"""

import tempfile

import pytest

from yuxtrans.cache.database import TranslationCache
from yuxtrans.engine.base import EngineType, TranslationError, TranslationRequest, TranslationResult
from yuxtrans.engine.router import SmartRouter


class _StubTranslator:
    """可控的桩翻译器：可指定返回文本或抛 TranslationError"""

    engine_type = EngineType.LOCAL

    def __init__(self, text=None, raise_error=False, stream_chunks=None, available=True):
        self._text = text
        self._raise = raise_error
        self._stream = stream_chunks
        self._available = available
        self._total_requests = 0
        self._error_count = 0
        self._total_time_ms = 0.0

    @property
    def is_available(self):
        return self._available

    @property
    def avg_response_time_ms(self):
        return 0.0

    async def translate(self, request):
        self._total_requests += 1
        if self._raise:
            self._error_count += 1
            raise TranslationError("stub failure", engine="local")
        return TranslationResult(
            text=self._text,
            source_lang=request.source_lang,
            target_lang=request.target_lang,
            engine=self.engine_type,
            response_time_ms=10.0,
        )

    async def translate_stream(self, request):
        self._total_requests += 1
        if self._raise:
            self._error_count += 1
            raise TranslationError("stub stream failure", engine="local")
        for chunk in self._stream or []:
            yield chunk

    async def health_check(self):
        return self._available


@pytest.fixture
def temp_cache_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tempfile.NamedTemporaryFile(dir=tmpdir, suffix=".db", delete=False).name


# ===== 非流式故障转移 =====


@pytest.mark.asyncio
async def test_router_cache_hit_skips_engines(temp_cache_db):
    """缓存命中时不调用 local/cloud"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        req = TranslationRequest(text="hello", source_lang="en", target_lang="zh")
        await cache.store(
            req,
            TranslationResult(
                text="你好",
                source_lang="en",
                target_lang="zh",
                engine=EngineType.CACHE,
                response_time_ms=1,
            ),
        )
        local = _StubTranslator(text="should-not-be-used")
        router = SmartRouter(cache=cache, local_translator=local)

        result = await router.translate(req)

        assert result.text == "你好"
        assert result.engine == EngineType.CACHE
        assert local._total_requests == 0
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_router_fallback_cache_miss_to_local(temp_cache_db):
    """缓存未命中 + local 成功 -> 落 local 并回写缓存"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        req = TranslationRequest(text="fresh_text", source_lang="en", target_lang="zh")
        local = _StubTranslator(text="新鲜译文")
        router = SmartRouter(cache=cache, local_translator=local)

        result = await router.translate(req)

        assert result.text == "新鲜译文"
        assert result.engine == EngineType.LOCAL
        # 回写缓存：再次请求应命中缓存
        again = await router.translate(req)
        assert again.engine == EngineType.CACHE
        assert local._total_requests == 1  # 第二次走缓存，local 未再被调用
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_router_fallback_local_fail_to_cloud():
    """local 失败 -> 转云端"""
    local = _StubTranslator(raise_error=True)
    cloud = _StubTranslator(text="cloud result")
    cloud.engine_type = EngineType.CLOUD
    router = SmartRouter(local_translator=local, cloud_translator=cloud)

    result = await router.translate(
        TranslationRequest(text="hi", source_lang="en", target_lang="zh")
    )

    assert result.text == "cloud result"
    assert result.engine == EngineType.CLOUD


@pytest.mark.asyncio
async def test_router_all_engines_fail_raises():
    """所有引擎均失败 -> 抛 TranslationError"""
    local = _StubTranslator(raise_error=True)
    cloud = _StubTranslator(raise_error=True)
    cloud.engine_type = EngineType.CLOUD
    router = SmartRouter(local_translator=local, cloud_translator=cloud)

    with pytest.raises(TranslationError):
        await router.translate(TranslationRequest(text="hi", source_lang="en", target_lang="zh"))


@pytest.mark.asyncio
async def test_router_no_engines_raises():
    """无任何引擎 -> 抛 TranslationError"""
    router = SmartRouter()

    with pytest.raises(TranslationError):
        await router.translate(TranslationRequest(text="hi", source_lang="en", target_lang="zh"))


# ===== 流式故障转移 =====


@pytest.mark.asyncio
async def test_router_stream_cache_hit(temp_cache_db):
    """流式：缓存命中直接 yield 缓存文本"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        req = TranslationRequest(text="hello", source_lang="en", target_lang="zh")
        await cache.store(
            req,
            TranslationResult(
                text="你好",
                source_lang="en",
                target_lang="zh",
                engine=EngineType.CACHE,
                response_time_ms=1,
            ),
        )
        local = _StubTranslator(stream_chunks=["should", "not", "used"])
        router = SmartRouter(cache=cache, local_translator=local)

        chunks = []
        async for c in router.translate_stream(req):
            chunks.append(c)

        assert chunks == ["你好"]
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_router_stream_local_fail_to_cloud():
    """流式：local 抛错 -> 转云端流式"""
    local = _StubTranslator(raise_error=True)
    cloud = _StubTranslator(stream_chunks=["云", "端"])
    cloud.engine_type = EngineType.CLOUD
    router = SmartRouter(local_translator=local, cloud_translator=cloud)

    chunks = []
    async for c in router.translate_stream(
        TranslationRequest(text="hi", source_lang="en", target_lang="zh")
    ):
        chunks.append(c)

    assert chunks == ["云", "端"]


# ===== preload 回归（bug #4）=====


@pytest.mark.asyncio
async def test_router_preload_with_cache_does_not_crash(temp_cache_db):
    """带缓存的 preload 不再因 _preload_popular 返回 None 入 gather 而 TypeError"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        # local 不可用（无 ollama）-> tasks 为空，gather 不执行，仅同步预热缓存
        router = SmartRouter(cache=cache)

        # 回归点：修复前会抛 TypeError: An asyncio.Future, a coroutine or an awaitable is required
        await router.preload()
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_router_preload_with_local_and_cache(temp_cache_db):
    """local + cache 同时存在：同步预热缓存 + gather 异步 preload_model"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        # 用桩替换 local 的 preload_model 为成功协程
        class _LocalWithPreload(_StubTranslator):
            async def preload_model(self):
                return True

        local = _LocalWithPreload(text="x")
        router = SmartRouter(cache=cache, local_translator=local)

        await router.preload()  # 不应抛 TypeError
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_router_preload_empty_does_not_crash():
    """无 cache 无 local：preload 为空操作，不抛错"""
    router = SmartRouter()
    await router.preload()  # tasks 为空，gather 不调用
