"""集成测试 - 完整翻译流程"""

import asyncio
import os
import tempfile

import pytest

from yuxtrans.cache.database import TranslationCache
from yuxtrans.cache.warmup import CacheWarmupStrategy
from yuxtrans.engine.base import EngineType, TranslationRequest, TranslationResult
from yuxtrans.engine.router import SmartRouter
from yuxtrans.metrics.benchmark import PerformanceBenchmark
from yuxtrans.metrics.quality import BLEUScore, QualityMetrics
from yuxtrans.utils.concurrency import ConcurrencyController, RateLimiter
from yuxtrans.utils.config import AppConfig, ConfigManager
from yuxtrans.utils.retry import RetryConfig, RetryExecutor, RetryStrategy


@pytest.fixture
def temp_config():
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "test_config.yaml")
        yield config_path


@pytest.fixture
async def temp_cache_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_cache.db")
        yield db_path
        # Cleanup: close any open cache connections
        # Note: The test should close the cache, but we also try here
        try:
            import gc
            gc.collect()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_full_translation_pipeline(temp_cache_db):
    """测试完整翻译流程"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        warmup = CacheWarmupStrategy(cache)

        await warmup.warmup_common_words()

        router = SmartRouter(cache=cache)

        requests = [
            TranslationRequest(text="hello", source_lang="en", target_lang="zh"),
            TranslationRequest(text="world", source_lang="en", target_lang="zh"),
            TranslationRequest(text="function", source_lang="en", target_lang="zh"),
        ]

        results = []
        for req in requests:
            result = await router.translate(req)
            results.append(result)

        assert all(r.is_success for r in results)
        assert all(r.engine == EngineType.CACHE for r in results)
        assert all(r.response_time_ms < 10 for r in results)
        assert cache.hit_rate == 1.0
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_retry_mechanism():
    """测试重试机制"""
    config = RetryConfig(
        max_retries=3,
        strategy=RetryStrategy.EXPONENTIAL,
        base_delay_ms=50,
    )

    executor = RetryExecutor(config)

    call_count = 0

    async def failing_func():
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise Exception("temporary timeout error")
        return "success"

    result = await executor.execute(failing_func)

    assert result.success
    assert result.attempts == 3
    assert result.result == "success"


@pytest.mark.asyncio
async def test_retry_max_exceeded():
    """测试重试次数超限"""
    config = RetryConfig(max_retries=2)
    executor = RetryExecutor(config)

    async def always_fail():
        raise Exception("timeout error")

    result = await executor.execute(always_fail)

    assert not result.success
    assert result.attempts == 3


@pytest.mark.asyncio
async def test_rate_limiter():
    """测试限流器"""
    limiter = RateLimiter()

    acquired = []

    for _ in range(5):
        can_proceed = await limiter.acquire()
        acquired.append(can_proceed)

    assert all(acquired)

    status = limiter.get_status()
    assert status["rate"] == 10.0


@pytest.mark.asyncio
async def test_concurrency_controller():
    """测试并发控制器"""
    controller = ConcurrencyController()

    results = []

    async def task(i):
        await asyncio.sleep(0.01)
        return i

    # 启动队列处理任务
    process_task = asyncio.create_task(controller.queue.process_queue())

    try:
        tasks = [controller.execute(task, i) for i in range(5)]
        results = await asyncio.gather(*tasks)

        assert len(results) == 5
        assert set(results) == {0, 1, 2, 3, 4}
    finally:
        process_task.cancel()
        try:
            await process_task
        except asyncio.CancelledError:
            pass


def test_config_manager(temp_config):
    """测试配置管理"""
    manager = ConfigManager(config_path=temp_config)

    config = manager.load()

    assert config.engine.prefer_local
    assert config.engine.local_model == "qwen2:7b"
    assert config.performance.max_retries == 3
    assert config.ui.theme == "light"

    manager.update("engine", "local_model", "qwen2:1.5b")

    updated_config = manager.load()
    assert updated_config.engine.local_model == "qwen2:1.5b"


def test_config_save_and_load(temp_config):
    """测试配置保存和加载"""
    manager = ConfigManager(config_path=temp_config)

    config = AppConfig()
    config.engine.prefer_local = False
    config.performance.bleu_threshold = 0.75

    manager.save(config)

    loaded_config = manager.load()

    assert not loaded_config.engine.prefer_local
    assert loaded_config.performance.bleu_threshold == 0.75


@pytest.mark.asyncio
async def test_quality_with_pipeline(temp_cache_db):
    """测试质量评估与翻译流程"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        warmup = CacheWarmupStrategy(cache)
        await warmup.warmup_common_words()

        QualityMetrics()
        bleu = BLEUScore()

        test_translations = [
            ("hello", "你好"),
            ("world", "世界"),
            ("function", "函数"),
        ]

        for source, expected_target in test_translations:
            req = TranslationRequest(text=source, source_lang="en", target_lang="zh")

            result = TranslationResult(
                text=expected_target,
                source_lang="en",
                target_lang="zh",
                engine=EngineType.LOCAL,
                response_time_ms=100,
            )

            await cache.store(req, result)

            cached_result = await cache.translate(req)

            score, _ = bleu.calculate(cached_result.text, [expected_target])

            assert score >= 0.8
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_benchmark_with_router(temp_cache_db):
    """测试基准测试与路由器"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        warmup = CacheWarmupStrategy(cache)
        await warmup.warmup_common_words()

        router = SmartRouter(cache=cache)

        benchmark = PerformanceBenchmark()

        test_requests = [
            TranslationRequest(text="hello", source_lang="en", target_lang="zh"),
            TranslationRequest(text="world", source_lang="en", target_lang="zh"),
        ]

        result = await benchmark.run_benchmark(
            router,
            test_requests,
            test_name="router_test",
            warmup=1,
            iterations=3,
        )

        assert result.total_requests > 0
        assert result.success_rate >= 0.9
        assert result.avg_response_time_ms < 50
    finally:
        cache.close()


@pytest.mark.asyncio
async def test_cache_stats_tracking(temp_cache_db):
    """测试缓存统计追踪"""
    cache = TranslationCache(db_path=temp_cache_db, preload_popular=False)
    try:
        result = TranslationResult(
            text="你好",
            source_lang="en",
            target_lang="zh",
            engine=EngineType.LOCAL,
            response_time_ms=100,
        )

        req1 = TranslationRequest(text="test1", source_lang="en", target_lang="zh")
        req2 = TranslationRequest(text="test2", source_lang="en", target_lang="zh")
        TranslationRequest(text="test1", source_lang="en", target_lang="zh")

        await cache.store(req1, result)

        await cache.translate(req1)

        with pytest.raises(Exception):
            await cache.translate(req2)

        await cache.translate(req1)

        stats = cache.stats

        assert stats["hit_count"] == 2
        assert stats["miss_count"] == 1
        assert stats["hit_rate"] == 2 / 3
    finally:
        cache.close()
