"""
缓存预热与优化策略
P1-003: 热门词汇缓存命中率 > 80%
"""

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from yuxtrans.cache.database import TranslationCache
from yuxtrans.engine.base import EngineType, TranslationRequest, TranslationResult


class CacheWarmupStrategy:
    """
    缓存预热策略

    通过以下方式提高命中率：
    1. 预加载高频词汇
    2. 智能预测用户可能查询的内容
    3. 批量预热常用翻译
    """

    DEFAULT_COMMON_WORDS = [
        ("hello", "你好"),
        ("world", "世界"),
        ("the", "这"),
        ("and", "和"),
        ("is", "是"),
        ("are", "是"),
        ("was", "是"),
        ("were", "是"),
        ("have", "有"),
        ("has", "有"),
        ("will", "将"),
        ("can", "能"),
        ("may", "可能"),
        ("should", "应该"),
        ("would", "会"),
        ("thank you", "谢谢"),
        ("please", "请"),
        ("yes", "是"),
        ("no", "不"),
        ("good", "好"),
        ("bad", "坏"),
        ("big", "大"),
        ("small", "小"),
        ("new", "新"),
        ("old", "旧"),
        ("first", "第一"),
        ("last", "最后"),
        ("next", "下一个"),
        ("previous", "上一个"),
    ]

    TECH_COMMON_WORDS = [
        ("function", "函数"),
        ("variable", "变量"),
        ("class", "类"),
        ("method", "方法"),
        ("object", "对象"),
        ("array", "数组"),
        ("string", "字符串"),
        ("integer", "整数"),
        ("boolean", "布尔值"),
        ("null", "空值"),
        ("error", "错误"),
        ("warning", "警告"),
        ("success", "成功"),
        ("failure", "失败"),
        ("request", "请求"),
        ("response", "响应"),
        ("server", "服务器"),
        ("client", "客户端"),
        ("database", "数据库"),
        ("api", "API"),
        ("interface", "接口"),
        ("implementation", "实现"),
        ("configuration", "配置"),
        ("parameter", "参数"),
        ("return", "返回"),
        ("import", "导入"),
        ("export", "导出"),
        ("debug", "调试"),
        ("test", "测试"),
        ("build", "构建"),
    ]

    def __init__(
        self,
        cache: TranslationCache,
        custom_words: Optional[List[Tuple[str, str]]] = None,
        include_technical: bool = True,
    ):
        self.cache = cache
        self.custom_words = custom_words or []
        self.include_technical = include_technical

    async def warmup_common_words(
        self,
        source_lang: str = "en",
        target_lang: str = "zh",
    ) -> int:
        """
        预热常用词汇

        Returns:
            int: 成功预热的词汇数量
        """
        words = self.DEFAULT_COMMON_WORDS.copy()

        if self.include_technical:
            words.extend(self.TECH_COMMON_WORDS)

        words.extend(self.custom_words)

        warmed_count = 0

        for source_text, translated_text in words:
            request = TranslationRequest(
                text=source_text,
                source_lang=source_lang,
                target_lang=target_lang,
                use_cache=False,
            )

            result = TranslationResult(
                text=translated_text,
                source_lang=source_lang,
                target_lang=target_lang,
                engine=EngineType.CACHE,
                response_time_ms=0,
                cached=False,
                metadata={"warmup": True, "source": "common_words"},
            )

            if await self.cache.store(request, result):
                warmed_count += 1

        return warmed_count

    async def warmup_from_file(
        self,
        filepath: str,
        source_lang: str = "en",
        target_lang: str = "zh",
    ) -> int:
        """
        从文件预热词汇

        文件格式: JSON [{"source": "...", "target": "..."}]
        """
        path = Path(filepath)
        if not path.exists():
            return 0

        warmed_count = 0

        with open(path, "r", encoding="utf-8") as f:
            words = json.load(f)

        for item in words:
            request = TranslationRequest(
                text=item["source"],
                source_lang=source_lang,
                target_lang=target_lang,
                use_cache=False,
            )

            result = TranslationResult(
                text=item["target"],
                source_lang=source_lang,
                target_lang=target_lang,
                engine=EngineType.CACHE,
                response_time_ms=0,
                cached=False,
                metadata={"warmup": True, "source": filepath},
            )

            if await self.cache.store(request, result):
                warmed_count += 1

        return warmed_count

    async def warmup_recent_translations(
        self,
        hours: int = 24,
        min_access_count: int = 2,
    ) -> int:
        """
        预热近期高频访问的翻译

        Args:
            hours: 时间范围(小时)
            min_access_count: 最小访问次数阈值
        """
        recent_entries = await self.cache.get_popular_translations(limit=100)

        threshold_time = datetime.now() - timedelta(hours=hours)

        warmed_count = 0

        for entry in recent_entries:
            if entry.access_count >= min_access_count or entry.accessed_at >= threshold_time:
                request = TranslationRequest(
                    text=entry.source_text,
                    source_lang=entry.source_lang,
                    target_lang=entry.target_lang,
                )

                result = TranslationResult(
                    text=entry.translated_text,
                    source_lang=entry.source_lang,
                    target_lang=entry.target_lang,
                    engine=EngineType(entry.engine),
                    response_time_ms=0,
                )

                if await self.cache.store(request, result):
                    warmed_count += 1

        return warmed_count

    def get_warmup_stats(self) -> Dict[str, Any]:
        """获取预热统计"""
        cache_stats = self.cache.stats

        return {
            "lru_size": cache_stats["lru_size"],
            "hit_rate": cache_stats["hit_rate"],
            "total_requests": cache_stats["total_requests"],
            "common_words_count": len(self.DEFAULT_COMMON_WORDS),
            "technical_words_count": len(self.TECH_COMMON_WORDS) if self.include_technical else 0,
            "custom_words_count": len(self.custom_words),
        }
