"""
翻译质量评估指标
P0-002: BLEU、人工评分标准、测试集
"""

import json
import math
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class TranslationTestCase:
    """翻译测试用例"""

    id: str
    source_text: str
    reference_translations: List[str]
    source_lang: str = "auto"
    target_lang: str = "zh"
    category: str = "general"
    difficulty: str = "medium"
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class QualityScore:
    """质量评分结果"""

    test_case_id: str
    candidate: str
    reference: str

    bleu_score: float
    bleu_details: Dict[str, float] = field(default_factory=dict)

    character_error_rate: float = 0.0
    word_error_rate: float = 0.0

    semantic_similarity: float = 0.0

    human_score: Optional[float] = None
    human_comments: Optional[str] = None

    passed: bool = True
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class BLEUScore:
    """
    BLEU (Bilingual Evaluation Understudy) 评分计算

    BLEU = BP * exp(sum(w_n * log(p_n)))
    其中 BP 是简洁惩罚因子，p_n 是 n-gram 精度
    """

    def __init__(self, max_n: int = 4, weights: Optional[List[float]] = None):
        self.max_n = max_n
        self.weights = weights or [1.0 / max_n] * max_n

    def calculate(
        self, candidate: str, references: List[str], tokenize: bool = True
    ) -> Tuple[float, Dict[str, Any]]:
        """
        计算BLEU分数

        Args:
            candidate: 候选翻译
            references: 参考翻译列表
            tokenize: 是否分词

        Returns:
            (bleu_score, details): BLEU分数和详细信息
        """
        if tokenize:
            candidate_tokens = self._tokenize(candidate)
            reference_tokens = [self._tokenize(ref) for ref in references]
        else:
            candidate_tokens = candidate.split()
            reference_tokens = [ref.split() for ref in references]

        if not candidate_tokens:
            return 0.0, {"error": "空候选翻译"}

        precisions = []
        details = {}

        for n in range(1, self.max_n + 1):
            p_n = self._modified_precision(candidate_tokens, reference_tokens, n)
            precisions.append(p_n)
            details[f"precision_{n}"] = p_n

        brevity_penalty = self._brevity_penalty(candidate_tokens, reference_tokens)
        details["brevity_penalty"] = brevity_penalty

        valid_precisions = [(w, p) for w, p in zip(self.weights, precisions) if p > 0]

        if not valid_precisions:
            return 0.0, details

        total_weight = sum(w for w, p in valid_precisions)
        log_sum = sum(w / total_weight * math.log(p) for w, p in valid_precisions)

        bleu = brevity_penalty * math.exp(log_sum)
        details["bleu"] = bleu

        return bleu, details

    @staticmethod
    def _tokenize(text: str) -> List[str]:
        """智能分词 - 支持中英文"""
        import re

        def contains_chinese(s):
            return bool(re.search(r"[\u4e00-\u9fff]", s))

        if contains_chinese(text):
            chinese_chars = re.findall(r"[\u4e00-\u9fff]", text)
            other_parts = re.findall(r"[a-zA-Z0-9]+|[^\u4e00-\u9fff\w\s]", text)
            tokens = chinese_chars + [p.lower() for p in other_parts if p.strip()]
            return tokens
        else:
            text = text.lower()
            text = re.sub(r"[^\w\s]", " ", text)
            return text.split()

    def _modified_precision(
        self, candidate: List[str], references: List[List[str]], n: int
    ) -> float:
        """计算修改后的n-gram精度"""
        candidate_ngrams = self._get_ngrams(candidate, n)
        if not candidate_ngrams:
            return 0.0

        reference_ngrams_list = [self._get_ngrams(ref, n) for ref in references]

        clipped_count = 0
        total_count = sum(candidate_ngrams.values())

        for ngram, count in candidate_ngrams.items():
            max_ref_count = max(
                (ref_ngrams.get(ngram, 0) for ref_ngrams in reference_ngrams_list),
                default=0,
            )
            clipped_count += min(count, max_ref_count)

        return clipped_count / total_count if total_count > 0 else 0.0

    @staticmethod
    def _get_ngrams(tokens: List[str], n: int) -> Counter:
        """获取n-gram计数"""
        ngrams = Counter()
        for i in range(len(tokens) - n + 1):
            ngram = tuple(tokens[i : i + n])
            ngrams[ngram] += 1
        return ngrams

    def _brevity_penalty(self, candidate: List[str], references: List[List[str]]) -> float:
        """计算简洁惩罚因子"""
        c = len(candidate)

        ref_lengths = [len(ref) for ref in references]
        r = min(ref_lengths, key=lambda x: abs(x - c))

        if c >= r:
            return 1.0

        return math.exp(1 - r / c) if c > 0 else 0.0


class WordErrorRate:
    """词错误率 (WER) 计算"""

    @staticmethod
    def calculate(candidate: str, reference: str, tokenize: bool = True) -> float:
        """
        计算词错误率

        WER = (S + D + I) / N
        其中 S=替换，D=删除，I=插入，N=参考词数
        """
        if tokenize:
            cand_tokens = BLEUScore._tokenize(candidate)
            ref_tokens = BLEUScore._tokenize(reference)
        else:
            cand_tokens = candidate.split()
            ref_tokens = reference.split()

        if not ref_tokens:
            return 0.0 if not cand_tokens else 1.0

        distances = WordErrorRate._edit_distance_matrix(cand_tokens, ref_tokens)

        return distances[-1][-1] / len(ref_tokens)

    @staticmethod
    def _edit_distance_matrix(s1: List[str], s2: List[str]) -> List[List[int]]:
        """计算编辑距离矩阵"""
        m, n = len(s1), len(s2)
        dp = [[0] * (n + 1) for _ in range(m + 1)]

        for i in range(m + 1):
            dp[i][0] = i
        for j in range(n + 1):
            dp[0][j] = j

        for i in range(1, m + 1):
            for j in range(1, n + 1):
                if s1[i - 1] == s2[j - 1]:
                    dp[i][j] = dp[i - 1][j - 1]
                else:
                    dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])

        return dp


class CharacterErrorRate:
    """字符错误率 (CER) 计算"""

    @staticmethod
    def calculate(candidate: str, reference: str) -> float:
        """计算字符错误率"""
        if not reference:
            return 0.0 if not candidate else 1.0

        distances = WordErrorRate._edit_distance_matrix(list(candidate), list(reference))

        return distances[-1][-1] / len(reference)


class QualityMetrics:
    """质量评估指标集合"""

    BLEU_THRESHOLD_HIGH = 0.75
    BLEU_THRESHOLD_MEDIUM = 0.70
    BLEU_THRESHOLD_LOW = 0.60

    def __init__(self):
        self.bleu = BLEUScore()
        self.wer = WordErrorRate()
        self.cer = CharacterErrorRate()

    def evaluate(
        self, candidate: str, references: List[str], test_case_id: str = ""
    ) -> QualityScore:
        """
        评估翻译质量

        Args:
            candidate: 候选翻译
            references: 参考翻译列表
            test_case_id: 测试用例ID

        Returns:
            QualityScore: 质量评分结果
        """
        bleu_score, bleu_details = self.bleu.calculate(candidate, references)

        primary_reference = references[0] if references else ""

        wer_score = self.wer.calculate(candidate, primary_reference)
        cer_score = self.cer.calculate(candidate, primary_reference)

        semantic_sim = self._semantic_similarity(candidate, primary_reference)

        passed = bleu_score >= self.BLEU_THRESHOLD_LOW

        return QualityScore(
            test_case_id=test_case_id,
            candidate=candidate,
            reference=primary_reference,
            bleu_score=bleu_score,
            bleu_details=bleu_details,
            word_error_rate=wer_score,
            character_error_rate=cer_score,
            semantic_similarity=semantic_sim,
            passed=passed,
        )

    def evaluate_batch(
        self, test_cases: List[TranslationTestCase], candidates: List[str]
    ) -> List[QualityScore]:
        """批量评估"""
        if len(test_cases) != len(candidates):
            raise ValueError("测试用例数量与候选翻译数量不匹配")

        return [
            self.evaluate(candidate, case.reference_translations, case.id)
            for case, candidate in zip(test_cases, candidates)
        ]

    @staticmethod
    def _semantic_similarity(text1: str, text2: str) -> float:
        """
        简单的语义相似度计算 (基于Jaccard)
        真实的语义相似度需要嵌入模型
        """
        tokens1 = set(BLEUScore._tokenize(text1))
        tokens2 = set(BLEUScore._tokenize(text2))

        if not tokens1 or not tokens2:
            return 0.0

        intersection = len(tokens1 & tokens2)
        union = len(tokens1 | tokens2)

        return intersection / union if union > 0 else 0.0

    def generate_report(self, scores: List[QualityScore]) -> Dict[str, Any]:
        """生成评估报告"""
        if not scores:
            return {}

        bleu_scores = [s.bleu_score for s in scores]
        wer_scores = [s.word_error_rate for s in scores]
        cer_scores = [s.character_error_rate for s in scores]
        semantic_scores = [s.semantic_similarity for s in scores]
        passed_count = sum(1 for s in scores if s.passed)

        return {
            "total_tests": len(scores),
            "passed": passed_count,
            "failed": len(scores) - passed_count,
            "pass_rate": passed_count / len(scores),
            "bleu": {
                "avg": sum(bleu_scores) / len(bleu_scores),
                "min": min(bleu_scores),
                "max": max(bleu_scores),
                "above_0.75": sum(1 for s in bleu_scores if s >= 0.75),
                "above_0.70": sum(1 for s in bleu_scores if s >= 0.70),
                "above_0.60": sum(1 for s in bleu_scores if s >= 0.60),
            },
            "wer": {
                "avg": sum(wer_scores) / len(wer_scores),
                "min": min(wer_scores),
                "max": max(wer_scores),
            },
            "cer": {
                "avg": sum(cer_scores) / len(cer_scores),
                "min": min(cer_scores),
                "max": max(cer_scores),
            },
            "semantic_similarity": {
                "avg": sum(semantic_scores) / len(semantic_scores),
                "min": min(semantic_scores),
                "max": max(semantic_scores),
            },
            "timestamp": datetime.now().isoformat(),
        }

    def save_report(self, report: Dict[str, Any], filename: str):
        """保存报告"""
        path = Path(filename)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)


DEFAULT_TEST_CASES = [
    TranslationTestCase(
        id="tc_001",
        source_text="Hello, world!",
        reference_translations=["你好，世界！", "你好，世界。"],
        category="general",
        difficulty="easy",
    ),
    TranslationTestCase(
        id="tc_002",
        source_text="The quick brown fox jumps over the lazy dog.",
        reference_translations=["敏捷的棕色狐狸跳过了懒狗。"],
        category="general",
        difficulty="medium",
    ),
    TranslationTestCase(
        id="tc_003",
        source_text="Machine learning is a subset of artificial intelligence.",
        reference_translations=["机器学习是人工智能的一个子集。"],
        category="technical",
        difficulty="medium",
    ),
    TranslationTestCase(
        id="tc_004",
        source_text="The conference will be held next Monday at 3 PM.",
        reference_translations=["会议将于下周一下午3点举行。"],
        category="business",
        difficulty="easy",
    ),
    TranslationTestCase(
        id="tc_005",
        source_text=(
            "Despite the challenges, the team remained committed to "
            "delivering high-quality results."
        ),
        reference_translations=["尽管面临挑战，团队仍致力于交付高质量的成果。"],
        category="business",
        difficulty="hard",
    ),
]
