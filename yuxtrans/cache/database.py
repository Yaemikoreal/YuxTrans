"""
翻译缓存层
P0-004: SQLite + LRU缓存，命中检测 < 10ms
"""

import hashlib
import json
import sqlite3
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

from yuxtrans.engine.base import (
    BaseTranslator,
    EngineStatus,
    EngineType,
    TranslationError,
    TranslationRequest,
    TranslationResult,
)


@dataclass
class CacheEntry:
    """缓存条目"""

    key: str
    source_text: str
    translated_text: str
    source_lang: str
    target_lang: str
    engine: str
    confidence: Optional[float]
    created_at: datetime
    accessed_at: datetime
    access_count: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "source_text": self.source_text,
            "translated_text": self.translated_text,
            "source_lang": self.source_lang,
            "target_lang": self.target_lang,
            "engine": self.engine,
            "confidence": self.confidence,
            "created_at": self.created_at.isoformat(),
            "accessed_at": self.accessed_at.isoformat(),
            "access_count": self.access_count,
            "metadata": self.metadata,
        }


class LRUCache:
    """线程安全的LRU缓存"""

    def __init__(self, max_size: int = 10000):
        self.max_size = max_size
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = threading.RLock()

    def get(self, key: str) -> Optional[CacheEntry]:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            return None

    def put(self, key: str, entry: CacheEntry):
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                self._cache[key] = entry
            else:
                if len(self._cache) >= self.max_size:
                    self._cache.popitem(last=False)
                self._cache[key] = entry

    def remove(self, key: str):
        with self._lock:
            if key in self._cache:
                del self._cache[key]

    def clear(self):
        with self._lock:
            self._cache.clear()

    @property
    def size(self) -> int:
        return len(self._cache)

    def keys(self) -> List[str]:
        with self._lock:
            return list(self._cache.keys())


class TranslationCache(BaseTranslator):
    """
    翻译缓存系统
    SQLite持久化 + LRU内存缓存
    """

    engine_type = EngineType.CACHE

    DEFAULT_DB_PATH = "~/.yuxtrans/cache/translations.db"
    DEFAULT_LRU_SIZE = 10000
    DEFAULT_TTL_DAYS = 30
    HIT_TARGET_MS = 10

    def __init__(
        self,
        db_path: Optional[str] = None,
        lru_size: int = DEFAULT_LRU_SIZE,
        ttl_days: int = DEFAULT_TTL_DAYS,
        preload_popular: bool = True,
        popular_threshold: int = 5,
    ):
        super().__init__()
        self.db_path = Path(db_path or self.DEFAULT_DB_PATH).expanduser()
        self.lru_size = lru_size
        self.ttl_days = ttl_days
        self.popular_threshold = popular_threshold

        self._lru_cache = LRUCache(max_size=lru_size)
        self._db_lock = threading.RLock()
        self._hit_count = 0
        self._miss_count = 0

        self._init_database()
        self._status = EngineStatus.READY

        if preload_popular:
            self._preload_popular()

    def _init_database(self):
        """初始化数据库"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS translations (
                    key TEXT PRIMARY KEY,
                    source_text TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    source_lang TEXT NOT NULL,
                    target_lang TEXT NOT NULL,
                    engine TEXT NOT NULL,
                    confidence REAL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    access_count INTEGER DEFAULT 1,
                    metadata TEXT
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_source_target
                ON translations(source_lang, target_lang)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_access_count
                ON translations(access_count DESC)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_accessed_at
                ON translations(accessed_at)
            """)
            conn.commit()

    def _preload_popular(self):
        """预加载热门翻译到LRU缓存"""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                SELECT key, source_text, translated_text, source_lang,
                       target_lang, engine, confidence, created_at,
                       accessed_at, access_count, metadata
                FROM translations
                WHERE access_count >= ?
                ORDER BY access_count DESC
                LIMIT ?
            """,
                (self.popular_threshold, self.lru_size),
            )

            for row in cursor:
                entry = CacheEntry(
                    key=row[0],
                    source_text=row[1],
                    translated_text=row[2],
                    source_lang=row[3],
                    target_lang=row[4],
                    engine=row[5],
                    confidence=row[6],
                    created_at=self._parse_datetime(row[7]),
                    accessed_at=self._parse_datetime(row[8]),
                    access_count=row[9],
                    metadata=json.loads(row[10]) if row[10] else {},
                )
                self._lru_cache.put(entry.key, entry)

    @staticmethod
    def _parse_datetime(dt_str: Optional[str]) -> datetime:
        if dt_str:
            try:
                return datetime.fromisoformat(dt_str)
            except ValueError:
                pass
        return datetime.now()

    @staticmethod
    def _generate_key(text: str, source_lang: str, target_lang: str) -> str:
        """生成缓存键"""
        content = f"{source_lang}:{target_lang}:{text}"
        return hashlib.sha256(content.encode()).hexdigest()

    async def translate(self, request: TranslationRequest) -> TranslationResult:
        """从缓存获取翻译"""
        start_time = time.perf_counter()

        if not request.use_cache:
            raise TranslationError("缓存已禁用", engine="cache")

        key = self._generate_key(request.text, request.source_lang, request.target_lang)

        entry = await self._get_from_cache(key)

        if entry:
            self._hit_count += 1
            response_time = self._measure_time(start_time)
            self._record_success(response_time)

            return TranslationResult(
                text=entry.translated_text,
                source_lang=entry.source_lang,
                target_lang=entry.target_lang,
                engine=EngineType.CACHE,
                response_time_ms=response_time,
                cached=True,
                confidence=entry.confidence,
                metadata=entry.metadata,
            )

        self._miss_count += 1
        raise TranslationError("缓存未命中", engine="cache")

    async def translate_stream(self, request: TranslationRequest) -> AsyncGenerator[str, None]:
        """缓存不支持流式输出，直接返回完整结果"""
        result = await self.translate(request)
        yield result.text

    async def _get_from_cache(self, key: str) -> Optional[CacheEntry]:
        """从缓存获取（先LRU，后SQLite）"""
        entry = self._lru_cache.get(key)
        if entry:
            return entry

        entry = await self._get_from_db(key)
        if entry:
            self._lru_cache.put(key, entry)

        return entry

    async def _get_from_db(self, key: str) -> Optional[CacheEntry]:
        """从SQLite获取"""
        with self._db_lock:
            try:
                with sqlite3.connect(self.db_path) as conn:
                    cursor = conn.execute(
                        """
                        SELECT key, source_text, translated_text, source_lang,
                               target_lang, engine, confidence, created_at,
                               accessed_at, access_count, metadata
                        FROM translations
                        WHERE key = ?
                    """,
                        (key,),
                    )

                    row = cursor.fetchone()
                    if row:
                        conn.execute(
                            """
                            UPDATE translations
                            SET accessed_at = CURRENT_TIMESTAMP,
                                access_count = access_count + 1
                            WHERE key = ?
                        """,
                            (key,),
                        )
                        conn.commit()

                        return CacheEntry(
                            key=row[0],
                            source_text=row[1],
                            translated_text=row[2],
                            source_lang=row[3],
                            target_lang=row[4],
                            engine=row[5],
                            confidence=row[6],
                            created_at=self._parse_datetime(row[7]),
                            accessed_at=self._parse_datetime(row[8]),
                            access_count=row[9],
                            metadata=json.loads(row[10]) if row[10] else {},
                        )
                    return None
            except Exception:
                return None

    async def store(self, request: TranslationRequest, result: TranslationResult) -> bool:
        """存储翻译结果到缓存"""
        key = self._generate_key(request.text, request.source_lang, request.target_lang)

        entry = CacheEntry(
            key=key,
            source_text=request.text,
            translated_text=result.text,
            source_lang=result.source_lang,
            target_lang=result.target_lang,
            engine=result.engine.value,
            confidence=result.confidence,
            created_at=datetime.now(),
            accessed_at=datetime.now(),
            access_count=1,
            metadata=result.metadata,
        )

        self._lru_cache.put(key, entry)

        return await self._store_to_db(entry)

    async def _store_to_db(self, entry: CacheEntry) -> bool:
        """存储到SQLite"""
        with self._db_lock:
            try:
                with sqlite3.connect(self.db_path) as conn:
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO translations
                        (key, source_text, translated_text, source_lang,
                         target_lang, engine, confidence, created_at,
                         accessed_at, access_count, metadata)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                        (
                            entry.key,
                            entry.source_text,
                            entry.translated_text,
                            entry.source_lang,
                            entry.target_lang,
                            entry.engine,
                            entry.confidence,
                            entry.created_at.isoformat(),
                            entry.accessed_at.isoformat(),
                            entry.access_count,
                            json.dumps(entry.metadata) if entry.metadata else None,
                        ),
                    )
                    conn.commit()
                return True
            except Exception:
                return False

    async def clear_expired(self) -> int:
        """清理过期缓存"""
        expired_date = datetime.now() - timedelta(days=self.ttl_days)
        deleted = 0

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                DELETE FROM translations
                WHERE accessed_at < ?
            """,
                (expired_date.isoformat(),),
            )
            deleted = cursor.rowcount
            conn.commit()

        for key in self._lru_cache.keys():
            entry = self._lru_cache.get(key)
            if entry and entry.accessed_at < expired_date:
                self._lru_cache.remove(key)

        return deleted

    async def clear_all(self):
        """清空所有缓存"""
        self._lru_cache.clear()

        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM translations")
            conn.commit()

    @property
    def hit_rate(self) -> float:
        """缓存命中率"""
        total = self._hit_count + self._miss_count
        if total == 0:
            return 0.0
        return self._hit_count / total

    @property
    def stats(self) -> Dict[str, Any]:
        """缓存统计信息"""
        return {
            "lru_size": self._lru_cache.size,
            "lru_max_size": self.lru_size,
            "hit_count": self._hit_count,
            "miss_count": self._miss_count,
            "hit_rate": self.hit_rate,
            "total_requests": self._total_requests,
            "avg_response_time_ms": self.avg_response_time_ms,
        }

    def close(self):
        """关闭缓存，释放资源"""
        self._lru_cache.clear()
        # Force close all SQLite connections by creating a final connection
        # and explicitly closing it with WAL mode checkpoint
        try:
            conn = sqlite3.connect(self.db_path)
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.close()
        except Exception:
            pass
        # Force garbage collection to release any lingering file handles
        import gc

        gc.collect()

    async def get_popular_translations(self, limit: int = 100) -> List[CacheEntry]:
        """获取热门翻译"""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                SELECT key, source_text, translated_text, source_lang,
                       target_lang, engine, confidence, created_at,
                       accessed_at, access_count, metadata
                FROM translations
                ORDER BY access_count DESC
                LIMIT ?
            """,
                (limit,),
            )

            return [
                CacheEntry(
                    key=row[0],
                    source_text=row[1],
                    translated_text=row[2],
                    source_lang=row[3],
                    target_lang=row[4],
                    engine=row[5],
                    confidence=row[6],
                    created_at=self._parse_datetime(row[7]),
                    accessed_at=self._parse_datetime(row[8]),
                    access_count=row[9],
                    metadata=json.loads(row[10]) if row[10] else {},
                )
                for row in cursor
            ]
