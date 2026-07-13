"""单元测试 - 质量评估"""


from yuxtrans.metrics.quality import (
    BLEUScore,
    CharacterErrorRate,
    QualityMetrics,
    TranslationTestCase,
    WordErrorRate,
)


def test_bleu_score_exact_match():
    bleu = BLEUScore()
    score, details = bleu.calculate("你好世界", ["你好世界"])
    assert score == 1.0


def test_bleu_score_partial_match():
    bleu = BLEUScore()
    score, details = bleu.calculate("你好，世界", ["你好世界"])
    assert score > 0.0
    assert score < 1.0


def test_bleu_score_empty_candidate():
    bleu = BLEUScore()
    score, details = bleu.calculate("", ["你好世界"])
    assert score == 0.0


def test_bleu_score_multiple_references():
    bleu = BLEUScore()
    score, details = bleu.calculate(
        "你好，世界！", ["你好世界", "你好，世界", "你好，世界！"]
    )
    assert score > 0.0


def test_word_error_rate_exact_match():
    wer = WordErrorRate()
    score = wer.calculate("你好世界", "你好世界")
    assert score == 0.0


def test_word_error_rate_different():
    wer = WordErrorRate()
    score = wer.calculate("你好世界", "世界你好")
    assert score > 0.0


def test_character_error_rate_exact_match():
    cer = CharacterErrorRate()
    score = cer.calculate("你好世界", "你好世界")
    assert score == 0.0


def test_character_error_rate_different():
    cer = CharacterErrorRate()
    score = cer.calculate("你好世界", "世界你好")
    assert score > 0.0


def test_quality_metrics_evaluation():
    metrics = QualityMetrics()
    score = metrics.evaluate("你好，世界！", ["你好世界", "你好，世界"])

    assert score.bleu_score > 0.0
    assert score.word_error_rate >= 0.0
    assert score.character_error_rate >= 0.0
    assert score.semantic_similarity >= 0.0


def test_quality_metrics_threshold():
    metrics = QualityMetrics()

    high_score = metrics.evaluate(
        "这是一段高质量的翻译结果", ["这是一段高质量的翻译结果"]
    )
    assert high_score.bleu_score >= QualityMetrics.BLEU_THRESHOLD_HIGH

    medium_score = metrics.evaluate("这是一段翻译结果", ["这是一段高质量的翻译结果"])
    assert medium_score.bleu_score < QualityMetrics.BLEU_THRESHOLD_HIGH


def test_quality_metrics_report():
    metrics = QualityMetrics()

    test_cases = [
        TranslationTestCase(
            id="tc_1", source_text="Hello", reference_translations=["你好"]
        ),
        TranslationTestCase(
            id="tc_2", source_text="World", reference_translations=["世界"]
        ),
    ]

    candidates = ["你好", "世界"]

    scores = metrics.evaluate_batch(test_cases, candidates)
    assert len(scores) == 2

    report = metrics.generate_report(scores)

    assert "total_tests" in report
    assert "bleu" in report
    assert "pass_rate" in report
