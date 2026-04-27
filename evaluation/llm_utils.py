#!/usr/bin/env python3
"""
LLM 실험 유틸리티 — 캐시, 지표, 비용 계산.

사용:
  from llm_utils import DiskCache, sacrebleu_1gram, seq_ratio, compute_cost_usd

Self-test:
  python3 llm_utils.py
"""

import hashlib
import json
import os
import tempfile
import time
from difflib import SequenceMatcher

import sacrebleu


# =================[ 디스크 캐시 ]=================
class DiskCache:
    """
    sha256 해시 기반 JSON 파일 캐시.
    - 쓰기: 임시파일 → rename(원자적 저장)
    - 읽기: 손상된 JSON이면 None 반환 (재호출 유도)
    """

    def __init__(self, cache_dir: str):
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)

    def make_key(self, *parts) -> str:
        """여러 요소를 조합해 16자 hex 키 생성. 순서/타입 민감."""
        s = "||".join(self._normalize(p) for p in parts)
        return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _normalize(p):
        if isinstance(p, (dict, list)):
            return json.dumps(p, sort_keys=True, ensure_ascii=False)
        return str(p)

    def _path(self, key: str) -> str:
        return os.path.join(self.cache_dir, key + ".json")

    def get(self, key: str):
        p = self._path(key)
        if not os.path.exists(p):
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None

    def set(self, key: str, value):
        p = self._path(key)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False)
        os.replace(tmp, p)

    def delete(self, key: str):
        p = self._path(key)
        if os.path.exists(p):
            os.remove(p)

    def size(self) -> int:
        """캐시 파일 개수."""
        return sum(1 for _ in os.scandir(self.cache_dir)
                   if _.is_file() and _.name.endswith(".json"))


# =================[ 지표 ]=================
def sacrebleu_1gram(pred: str, ref: str) -> float:
    """
    SacreBLEU 1-gram precision (0~100).
    논문과 동일: bleu.precisions[0] 만 사용.
    - 빈 문자열 처리: 한쪽이라도 빈 경우 0.0
    """
    if not pred or not ref:
        return 0.0
    try:
        bleu = sacrebleu.corpus_bleu([pred], [[ref]])
        return float(bleu.precisions[0])
    except Exception:
        return 0.0


def seq_ratio(pred: str, ref: str) -> float:
    """
    SequenceMatcher ratio (0~1).
    문자 단위 유사도, isjunk=None.
    """
    if not pred or not ref:
        return 0.0
    return SequenceMatcher(None, pred, ref).ratio()


# =================[ 비용 계산 ]=================
# 2026년 기준 OpenAI pricing (USD per 1M tokens).
# 모델 가격 변동 시 업데이트 필요.
MODEL_PRICING = {
    "gpt-3.5-turbo-0125": {"input": 0.50, "output": 1.50},
    "gpt-3.5-turbo":      {"input": 0.50, "output": 1.50},
    "gpt-4o-mini":        {"input": 0.15, "output": 0.60},
    "gpt-4o":             {"input": 2.50, "output": 10.00},
    "gpt-4-turbo":        {"input": 10.00, "output": 30.00},
}


def compute_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    p = MODEL_PRICING.get(model)
    if not p:
        return 0.0
    return (prompt_tokens * p["input"] + completion_tokens * p["output"]) / 1_000_000


# =================[ API Key 로딩 ]=================
def load_api_key(cli_key: str = "", secrets_path: str = "") -> str:
    """우선순위: --api-key → secrets.json → OPENAI_API_KEY env."""
    if cli_key:
        return cli_key
    if secrets_path and os.path.exists(secrets_path):
        try:
            with open(secrets_path) as f:
                s = json.load(f)
            for k in ("apiKey", "api_key", "OPENAI_API_KEY"):
                if s.get(k):
                    return s[k]
        except Exception:
            pass
    return os.environ.get("OPENAI_API_KEY", "")


# =================[ LLM Client ]=================
class LLMClient:
    """
    OpenAI Chat Completions API 래퍼.
    - DiskCache 통합 (동일 cache_key 면 API 호출 건너뜀)
    - 지수 백오프 재시도 (1s → 2s → 4s)
    - n 개 응답 샘플 반환 (문자열 리스트)
    """

    def __init__(
        self,
        api_key: str,
        model: str,
        max_tokens: int,
        n: int,
        temperature: float,
        cache: "DiskCache|None" = None,
        system_role: str = "",
        max_retries: int = 3,
    ):
        if not api_key:
            raise ValueError("API key is required.")
        # 지연 import: openai 가 없어도 llm_utils 의 나머지는 동작하도록
        from openai import OpenAI
        self.client = OpenAI(api_key=api_key)
        self.model = model
        self.max_tokens = max_tokens
        self.n = n
        self.temperature = temperature
        self.cache = cache
        self.system_role = system_role
        self.max_retries = max_retries

    def _build_messages(self, prompt: str):
        msgs = []
        if self.system_role:
            msgs.append({"role": "system", "content": self.system_role})
        msgs.append({"role": "user", "content": prompt})
        return msgs

    def _make_cache_key(self, prompt: str) -> str:
        if self.cache is None:
            return ""
        return self.cache.make_key(
            self.model,
            self.system_role,
            prompt,
            f"T={self.temperature}",
            f"n={self.n}",
            f"max={self.max_tokens}",
        )

    def complete(self, prompt: str) -> dict:
        """
        프롬프트 → n개 응답. 반환 포맷:
            {
                "responses": [s1, s2, ..., sn],
                "prompt_tokens": int,
                "completion_tokens": int,
                "latency_ms": int,
                "cached": bool,
                "error": None | str,
            }
        """
        # 1) 캐시 조회
        cache_key = self._make_cache_key(prompt)
        if self.cache and cache_key:
            cached = self.cache.get(cache_key)
            if cached:
                cached["cached"] = True
                cached.setdefault("error", None)
                return cached

        # 2) API 호출 + 지수 백오프
        messages = self._build_messages(prompt)
        last_err = None
        for attempt in range(self.max_retries):
            try:
                t0 = time.time()
                r = self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    max_tokens=self.max_tokens,
                    n=self.n,
                    temperature=self.temperature,
                )
                latency_ms = int((time.time() - t0) * 1000)

                responses = [
                    (c.message.content or "").strip() for c in r.choices
                ]
                prompt_tokens = r.usage.prompt_tokens if r.usage else 0
                completion_tokens = r.usage.completion_tokens if r.usage else 0

                result = {
                    "responses": responses,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "latency_ms": latency_ms,
                    "cached": False,
                    "error": None,
                }

                # 3) 캐시 저장
                if self.cache and cache_key:
                    self.cache.set(cache_key, result)

                return result

            except Exception as e:
                last_err = str(e)
                wait = 2 ** attempt  # 1s → 2s → 4s
                if attempt < self.max_retries - 1:
                    time.sleep(wait)

        # 4) 모든 재시도 실패
        return {
            "responses": [""] * self.n,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "latency_ms": 0,
            "cached": False,
            "error": last_err or "unknown",
        }


# =================[ Self-test ]=================
def _test_cache():
    tdir = tempfile.mkdtemp(prefix="cache_test_")
    try:
        c = DiskCache(tdir)
        assert c.size() == 0

        k1 = c.make_key("model", "prompt text", 3, 0.0)
        k2 = c.make_key("model", "prompt text", 3, 0.0)
        assert k1 == k2, "동일 입력 → 동일 키"
        assert len(k1) == 16

        k3 = c.make_key("model", "prompt text", 3, 1.0)  # temperature 다름
        assert k3 != k1, "파라미터 변경 → 다른 키"

        # 미스
        assert c.get(k1) is None

        # 저장/히트
        c.set(k1, {"responses": ["abc", "def"], "tokens": 42})
        got = c.get(k1)
        assert got == {"responses": ["abc", "def"], "tokens": 42}
        assert c.size() == 1

        # 키 해시 안정성 (리스트/딕트 입력)
        k_list = c.make_key("m", ["a", "b"])
        k_list2 = c.make_key("m", ["a", "b"])
        assert k_list == k_list2

        print("  ✓ DiskCache (키 일관성, get/set, 파라미터 분리)")
    finally:
        import shutil
        shutil.rmtree(tdir, ignore_errors=True)


def _test_metrics():
    # SacreBLEU
    exact = sacrebleu_1gram("hello world", "hello world")
    assert exact >= 99.0, f"exact match 1-gram should be ≈100, got {exact}"

    partial = sacrebleu_1gram("hello there", "hello world")
    assert 20 < partial < 80, f"partial match should be middle, got {partial}"

    assert sacrebleu_1gram("", "hello") == 0.0
    assert sacrebleu_1gram("hello", "") == 0.0
    assert sacrebleu_1gram("", "") == 0.0

    # SequenceMatcher
    assert seq_ratio("hello", "hello") == 1.0
    assert 0.0 < seq_ratio("hello", "hallo") < 1.0
    assert seq_ratio("", "hello") == 0.0
    assert seq_ratio("abc", "xyz") == 0.0

    # 코드 유사한 케이스
    code_high = seq_ratio(
        '.WriteLine("Hello World")',
        '.WriteLine("Hello World")',
    )
    assert code_high == 1.0

    code_mid = seq_ratio(
        '.WriteLine("Hi")',
        '.WriteLine("Hello World")',
    )
    assert 0.4 < code_mid < 0.9

    print("  ✓ Metrics (sacrebleu_1gram, seq_ratio)")


def _test_cost():
    # gpt-3.5-turbo-0125: $0.50/1M input, $1.50/1M output
    c = compute_cost_usd("gpt-3.5-turbo-0125", 1_000_000, 1_000_000)
    assert abs(c - 2.00) < 1e-9, f"1M + 1M = $2.00, got ${c}"

    c2 = compute_cost_usd("gpt-3.5-turbo-0125", 89, 11)
    expected = (89 * 0.5 + 11 * 1.5) / 1_000_000
    assert abs(c2 - expected) < 1e-9

    c3 = compute_cost_usd("unknown-model", 1000, 1000)
    assert c3 == 0.0  # 알 수 없는 모델 → 0

    print("  ✓ Cost (알려진 모델, 알 수 없는 모델)")


def main():
    print("=== llm_utils self-test ===")
    _test_cache()
    _test_metrics()
    _test_cost()
    print("All tests passed.")


if __name__ == "__main__":
    main()
