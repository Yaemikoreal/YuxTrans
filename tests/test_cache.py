"""单元测试 - 缓存层"""

import os
import tempfile

import pytest

from yuxtrans.cache.database import TranslationCache
from yuxtrans.engine.base import EngineType, TranslationRequest, TranslationResult


@pytest.fixture
def temp_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_cache.db")
        yield db_path


@pytest.fixture
async def cache(temp_db):
    cache = TranslationCache(db_path=temp_db, preload_popular=False)
    yield cache
    cache.close()


@pytest.mark.asyncio
async def test_cache_miss(cache):
    request = TranslationRequest(
        text="Hello, world!", source_lang="en", target_lang="zh"
    )

    with pytest.raises(Exception):
        await cache.translate(request)


@pytest.mark.asyncio
async def test_cache_store_and_retrieve(cache):
    request = TranslationRequest(
        text="Hello, world!", source_lang="en", target_lang="zh"
    )

    result = TranslationResult(
        text="你好，世界！",
        source_lang="en",
        target_lang="zh",
        engine=EngineType.LOCAL,
        response_time_ms=100.0,
        cached=False,
    )

    await cache.store(request, result)

    cached_result = await cache.translate(request)

    assert cached_result.text == "你好，世界！"
    assert cached_result.cached
    assert cached_result.engine == EngineType.CACHE
    assert cached_result.response_time_ms < 10


@pytest.mark.asyncio
async def test_cache_hit_rate(cache):
    request1 = TranslationRequest(text="test1", source_lang="en", target_lang="zh")
    request2 = TranslationRequest(text="test2", source_lang="en", target_lang="zh")

    result = TranslationResult(
        text="测试",
        source_lang="en",
        target_lang="zh",
        engine=EngineType.LOCAL,
        response_time_ms=100.0,
    )

    await cache.store(request1, result)

    await cache.translate(request1)

    with pytest.raises(Exception):
        await cache.translate(request2)

    assert cache.hit_rate == 0.5


@pytest.mark.asyncio
async def test_cache_clear_expired(cache):
    result = TranslationResult(
        text="测试",
        source_lang="en",
        target_lang="zh",
        engine=EngineType.LOCAL,
        response_time_ms=100.0,
    )

    for i in range(5):
        request = TranslationRequest(
            text=f"test_{i}", source_lang="en", target_lang="zh"
        )
        await cache.store(request, result)

    deleted = await cache.clear_expired()
    assert deleted >= 0


@pytest.mark.asyncio
async def test_cache_stats(cache):
    stats = cache.stats

    assert "lru_size" in stats
    assert "hit_count" in stats
    assert "miss_count" in stats
    assert "hit_rate" in stats


@pytest.mark.asyncio
async def test_lru_cache_eviction():
    cache = TranslationCache(lru_size=100, preload_popular=False)

    result = TranslationResult(
        text="测试",
        source_lang="en",
        target_lang="zh",
        engine=EngineType.LOCAL,
        response_time_ms=100.0,
    )

    for i in range(150):
        request = TranslationRequest(
            text=f"test_{i}", source_lang="en", target_lang="zh"
        )
        await cache.store(request, result)

    assert cache._lru_cache.size <= 100
