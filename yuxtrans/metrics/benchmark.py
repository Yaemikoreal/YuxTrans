"""
性能测试框架
P0-001: 可测量响应时间、内存、CPU
"""

import asyncio
import json
import statistics
import time
import tracemalloc
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import psutil

from yuxtrans.engine.base import BaseTranslator, TranslationRequest


@dataclass
class PerformanceMetric:
    """单次性能指标"""

    test_name: str
    response_time_ms: float
    memory_before_mb: float
    memory_after_mb: float
    memory_delta_mb: float
    cpu_percent: float
    success: bool
    error: Optional[str] = None
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class BenchmarkResult:
    """基准测试结果"""

    test_name: str
    total_requests: int
    successful_requests: int
    failed_requests: int

    avg_response_time_ms: float
    min_response_time_ms: float
    max_response_time_ms: float
    p50_response_time_ms: float
    p95_response_time_ms: float
    p99_response_time_ms: float

    avg_memory_mb: float
    max_memory_mb: float

    avg_cpu_percent: float
    max_cpu_percent: float

    success_rate: float
    throughput_rps: float

    metrics: List[PerformanceMetric] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        return result

    def passes_threshold(self, thresholds: Dict[str, float]) -> bool:
        """检查是否通过性能阈值"""
        checks = [
            self.avg_response_time_ms <= thresholds.get("avg_response_ms", float("inf")),
            self.p95_response_time_ms <= thresholds.get("p95_response_ms", float("inf")),
            self.avg_memory_mb <= thresholds.get("avg_memory_mb", float("inf")),
            self.max_memory_mb <= thresholds.get("max_memory_mb", float("inf")),
            self.success_rate >= thresholds.get("success_rate", 0.0),
        ]
        return all(checks)


class PerformanceBenchmark:
    """性能基准测试"""

    DEFAULT_THRESHOLDS = {
        "cache": {
            "avg_response_ms": 10,
            "p95_response_ms": 50,
            "avg_memory_mb": 100,
            "max_memory_mb": 200,
            "success_rate": 0.99,
        },
        "local": {
            "avg_response_ms": 500,
            "p95_response_ms": 1000,
            "avg_memory_mb": 200,
            "max_memory_mb": 300,
            "success_rate": 0.95,
        },
        "cloud": {
            "avg_response_ms": 2000,
            "p95_response_ms": 3000,
            "avg_memory_mb": 50,
            "max_memory_mb": 100,
            "success_rate": 0.98,
        },
    }

    def __init__(self, output_dir: Optional[str] = None):
        self.output_dir = Path(output_dir or "benchmark/results")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.process = psutil.Process()

    async def run_benchmark(
        self,
        translator: BaseTranslator,
        test_cases: List[TranslationRequest],
        test_name: str = "benchmark",
        warmup: int = 3,
        iterations: int = 10,
        concurrent: int = 1,
    ) -> BenchmarkResult:
        """
        运行基准测试

        Args:
            translator: 翻译器实例
            test_cases: 测试用例列表
            test_name: 测试名称
            warmup: 预热次数
            iterations: 每个测试用例的迭代次数
            concurrent: 并发数

        Returns:
            BenchmarkResult: 基准测试结果
        """
        for _ in range(warmup):
            for case in test_cases[: min(3, len(test_cases))]:
                try:
                    await translator.translate(case)
                except Exception:
                    pass

        metrics: List[PerformanceMetric] = []

        semaphore = asyncio.Semaphore(concurrent)

        async def run_single_test(request: TranslationRequest, idx: int):
            async with semaphore:
                return await self._measure_single(translator, request, f"{test_name}_{idx}")

        tasks = [run_single_test(case, i) for i, case in enumerate(test_cases * iterations)]

        metrics = await asyncio.gather(*tasks)

        return self._aggregate_results(test_name, metrics)

    async def _measure_single(
        self, translator: BaseTranslator, request: TranslationRequest, test_name: str
    ) -> PerformanceMetric:
        """测量单次翻译性能"""
        tracemalloc.start()

        mem_before = self.process.memory_info().rss / 1024 / 1024
        cpu_start = time.perf_counter()

        error = None
        success = False

        try:
            result = await translator.translate(request)
            success = result.is_success
        except Exception as e:
            error = str(e)

        cpu_end = time.perf_counter()
        cpu_percent = self.process.cpu_percent()
        mem_after = self.process.memory_info().rss / 1024 / 1024

        current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        return PerformanceMetric(
            test_name=test_name,
            response_time_ms=(cpu_end - cpu_start) * 1000,
            memory_before_mb=mem_before,
            memory_after_mb=mem_after,
            memory_delta_mb=mem_after - mem_before,
            cpu_percent=cpu_percent,
            success=success,
            error=error,
        )

    def _aggregate_results(
        self, test_name: str, metrics: List[PerformanceMetric]
    ) -> BenchmarkResult:
        """聚合测试结果"""
        successful = [m for m in metrics if m.success]
        failed = [m for m in metrics if not m.success]

        response_times = [m.response_time_ms for m in successful]
        memory_afters = [m.memory_after_mb for m in metrics]
        cpu_percents = [m.cpu_percent for m in metrics]

        total_time = sum(m.response_time_ms for m in metrics) / 1000
        throughput = len(successful) / total_time if total_time > 0 else 0

        return BenchmarkResult(
            test_name=test_name,
            total_requests=len(metrics),
            successful_requests=len(successful),
            failed_requests=len(failed),
            avg_response_time_ms=statistics.mean(response_times) if response_times else 0,
            min_response_time_ms=min(response_times) if response_times else 0,
            max_response_time_ms=max(response_times) if response_times else 0,
            p50_response_time_ms=self._percentile(response_times, 50) if response_times else 0,
            p95_response_time_ms=self._percentile(response_times, 95) if response_times else 0,
            p99_response_time_ms=self._percentile(response_times, 99) if response_times else 0,
            avg_memory_mb=statistics.mean(memory_afters) if memory_afters else 0,
            max_memory_mb=max(memory_afters) if memory_afters else 0,
            avg_cpu_percent=statistics.mean(cpu_percents) if cpu_percents else 0,
            max_cpu_percent=max(cpu_percents) if cpu_percents else 0,
            success_rate=len(successful) / len(metrics) if metrics else 0,
            throughput_rps=throughput,
            metrics=metrics,
        )

    @staticmethod
    def _percentile(data: List[float], percentile: int) -> float:
        """计算百分位数"""
        if not data:
            return 0.0
        sorted_data = sorted(data)
        idx = int(len(sorted_data) * percentile / 100)
        return sorted_data[min(idx, len(sorted_data) - 1)]

    def save_result(self, result: BenchmarkResult, filename: Optional[str] = None):
        """保存测试结果"""
        filename = filename or f"{result.test_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        output_path = self.output_dir / filename

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result.to_dict(), f, ensure_ascii=False, indent=2)

        return output_path

    def compare_results(
        self, baseline: BenchmarkResult, current: BenchmarkResult
    ) -> Dict[str, Any]:
        """对比基准结果"""
        return {
            "test_name": current.test_name,
            "response_time_change": {
                "avg": current.avg_response_time_ms - baseline.avg_response_time_ms,
                "avg_percent": (
                    (current.avg_response_time_ms - baseline.avg_response_time_ms)
                    / baseline.avg_response_time_ms
                    * 100
                    if baseline.avg_response_time_ms > 0
                    else 0
                ),
            },
            "memory_change": {
                "avg": current.avg_memory_mb - baseline.avg_memory_mb,
                "avg_percent": (
                    (current.avg_memory_mb - baseline.avg_memory_mb) / baseline.avg_memory_mb * 100
                    if baseline.avg_memory_mb > 0
                    else 0
                ),
            },
            "success_rate_change": current.success_rate - baseline.success_rate,
            "throughput_change": current.throughput_rps - baseline.throughput_rps,
            "regression_detected": (
                current.avg_response_time_ms > baseline.avg_response_time_ms * 1.1
                or current.avg_memory_mb > baseline.avg_memory_mb * 1.2
                or current.success_rate < baseline.success_rate * 0.95
            ),
        }

    async def run_stress_test(
        self,
        translator: BaseTranslator,
        request: TranslationRequest,
        duration_seconds: int = 60,
        concurrent: int = 10,
    ) -> BenchmarkResult:
        """
        压力测试

        Args:
            translator: 翻译器
            request: 翻译请求
            duration_seconds: 持续时间(秒)
            concurrent: 并发数

        Returns:
            BenchmarkResult: 压力测试结果
        """
        metrics: List[PerformanceMetric] = []
        start_time = time.time()

        async def stress_worker():
            while time.time() - start_time < duration_seconds:
                metric = await self._measure_single(translator, request, "stress_test")
                metrics.append(metric)
                await asyncio.sleep(0.01)

        await asyncio.gather(*[stress_worker() for _ in range(concurrent)])

        return self._aggregate_results("stress_test", metrics)
