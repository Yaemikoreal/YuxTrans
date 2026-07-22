"""
智能路由器
P1-005/P2-002: 本地可用则本地，否则云端兜底
"""

import asyncio
import time
from typing import TYPE_CHECKING, Any, AsyncGenerator, Dict, List, Optional

from yuxtrans.engine.base import (
    BaseTranslator,
    EngineStatus,
    EngineType,
    TranslationError,
    TranslationRequest,
    TranslationResult,
)
from yuxtrans.engine.cloud import CloudTranslator
from yuxtrans.engine.local import LocalTranslator

if TYPE_CHECKING:
    from yuxtrans.cache.database import TranslationCache


class SmartRouter(BaseTranslator):
    """
    智能路由器

    路由策略：
    1. 缓存检查 (< 10ms)
    2. 本地模型 (< 500ms)
    3. 云端兜底 (< 2s)

    自动故障转移和降级
    """

    engine_type = EngineType.LOCAL

    def __init__(
        self,
        cache: Optional["TranslationCache"] = None,
        local_translator: Optional[LocalTranslator] = None,
        cloud_translator: Optional[CloudTranslator] = None,
        prefer_local: bool = True,
        fallback_order: Optional[List[EngineType]] = None,
    ):
        super().__init__()
        self.cache = cache
        self.local = local_translator
        self.cloud = cloud_translator
        self.prefer_local = prefer_local

        self.fallback_order = fallback_order or [
            EngineType.CACHE,
            EngineType.LOCAL,
            EngineType.CLOUD,
        ]

        self._update_status()

    def _update_status(self):
        if self.local and self.local.is_available:
            self._status = EngineStatus.READY
        elif self.cloud and self.cloud.is_available:
            self._status = EngineStatus.READY
        else:
            self._status = EngineStatus.UNAVAILABLE

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        """
        智能路由翻译

        按顺序尝试：缓存 -> 本地 -> 云端
        """
        start_time = time.perf_counter()

        for engine_type in self.fallback_order:
            if engine_type == EngineType.CACHE and self.cache:
                try:
                    result = await self.cache.translate(request)
                    if result.is_success:
                        return result
                except TranslationError:
                    pass

            elif engine_type == EngineType.LOCAL and self.local and self.local.is_available:
                try:
                    result = await self.local.translate(request)
                    if result.is_success:
                        if self.cache:
                            await self.cache.store(request, result)
                        return result
                except TranslationError:
                    pass

            elif engine_type == EngineType.CLOUD and self.cloud and self.cloud.is_available:
                try:
                    result = await self.cloud.translate(request)
                    if result.is_success:
                        if self.cache:
                            await self.cache.store(request, result)
                        return result
                except TranslationError:
                    pass

        self._measure_time(start_time)
        self._record_error()

        raise TranslationError("所有翻译引擎均不可用", engine="router")

    async def translate_stream(self, request: TranslationRequest) -> AsyncGenerator[str, None]:
        """
        流式翻译路由

        优先本地模型流式输出
        """
        if self.cache and request.use_cache:
            try:
                result = await self.cache.translate(request)
                if result.is_success:
                    yield result.text
                    return
            except TranslationError:
                pass

        if self.local and self.local.is_available:
            try:
                collected_text = []
                async for chunk in self.local.translate_stream(request):
                    collected_text.append(chunk)
                    yield chunk

                if self.cache and collected_text:
                    full_result = TranslationResult(
                        text="".join(collected_text),
                        source_lang=request.source_lang,
                        target_lang=request.target_lang,
                        engine=EngineType.LOCAL,
                        response_time_ms=0,
                    )
                    await self.cache.store(request, full_result)
                return
            except TranslationError:
                pass

        if self.cloud and self.cloud.is_available:
            try:
                collected_text = []
                async for chunk in self.cloud.translate_stream(request):
                    collected_text.append(chunk)
                    yield chunk

                if self.cache and collected_text:
                    full_result = TranslationResult(
                        text="".join(collected_text),
                        source_lang=request.source_lang,
                        target_lang=request.target_lang,
                        engine=EngineType.CLOUD,
                        response_time_ms=0,
                    )
                    await self.cache.store(request, full_result)
                return
            except TranslationError:
                pass

        raise TranslationError("所有翻译引擎均不可用", engine="router")

    async def translate_fast(self, request: TranslationRequest) -> TranslationResult:
        """
        快速路径翻译

        仅尝试缓存和本地，失败立即返回错误
        """
        if self.cache:
            try:
                result = await self.cache.translate(request)
                if result.is_success:
                    return result
            except TranslationError:
                pass

        if self.local and self.local.is_available:
            result = await self.local.translate(request)
            if result.is_success:
                if self.cache:
                    await self.cache.store(request, result)
                return result

        raise TranslationError("快速路径不可用（缓存未命中，本地模型不可用）", engine="router")

    async def translate_quality(self, request: TranslationRequest) -> TranslationResult:
        """
        高质量路径翻译

        优先云端API（更准确）
        """
        if self.cloud and self.cloud.is_available:
            result = await self.cloud.translate(request)
            if result.is_success:
                if self.cache:
                    await self.cache.store(request, result)
                return result

        return await self.translate(request)

    @property
    def available_engines(self) -> List[EngineType]:
        """获取可用引擎列表"""
        engines = []
        if self.cache:
            engines.append(EngineType.CACHE)
        if self.local and self.local.is_available:
            engines.append(EngineType.LOCAL)
        if self.cloud and self.cloud.is_available:
            engines.append(EngineType.CLOUD)
        return engines

    async def health_check(self) -> bool:
        checks = []

        if self.local:
            checks.append(await self.local.health_check())

        if self.cloud:
            checks.append(await self.cloud.health_check())

        return any(checks)

    @property
    def stats(self) -> Dict[str, Any]:
        """路由器统计信息"""
        return {
            "available_engines": [e.value for e in self.available_engines],
            "cache_stats": self.cache.stats if self.cache else None,
            "local_avg_time": self.local.avg_response_time_ms if self.local else None,
            "cloud_avg_time": self.cloud.avg_response_time_ms if self.cloud else None,
            "router_requests": self._total_requests,
            "router_errors": self._error_count,
        }

    async def preload(self):
        """预加载模型和缓存"""
        # _preload_popular 是同步方法（返回 None），直接调用填充 LRU，不放入 gather
        if self.cache:
            self.cache._preload_popular()

        tasks = []
        if self.local:
            tasks.append(self.local.preload_model())

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
