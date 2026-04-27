#!/usr/bin/env python3
"""
LLM Code Completion 실험 러너 (Phase 1 v1 — Step 1-3 완료)

논문 "Improving LLM-based code completion using LR parsing" (J. Comp. Lang. 84, 2025)
의 실험을 재현하는 스크립트.

위치: code-completion-extension/evaluation/
  - secrets.json, resources/*, prompts.ts 와 동일 프로젝트 내에 위치

사용법:
  # Dry-run (API 호출 없음, 프롬프트 생성/검증용)
  python3 run_llm_experiment.py smallbasic --mode with-ideal --dry-run --limit 3

  # 실제 실행 (논문 설정: n=3, T=1.0, gpt-3.5-turbo-0125)
  python3 run_llm_experiment.py smallbasic --mode with-ideal --humanize-tokens

  # 초기 검증 (저비용, 1파일, n=1)
  python3 run_llm_experiment.py smallbasic --mode with-ideal \\
      --limit 1 --n-samples 1 --humanize-tokens --budget-usd 0.10

출력 (evaluation/ 내부):
  llm_experiments/<lang>/<mode>/<safe_name>.jsonl   # 커서별 기록
  llm_cache/<model>/<hash>.json                     # API 응답 캐시
"""

import argparse
import csv
import datetime
import glob
import json
import os
import re
import sys
from pathlib import Path

from llm_utils import (
    DiskCache,
    LLMClient,
    load_api_key,
    sacrebleu_1gram,
    seq_ratio,
    compute_cost_usd,
)

# =================[ 경로 & 설정 ]=================
ROOT = "/home/hyeonjin/PL"
TS_DIR = os.path.join(ROOT, "tree-sitter")
EXT_DIR = os.path.join(ROOT, "code-completion-extension")
EVAL_DIR = os.path.join(EXT_DIR, "evaluation")

# Input (tree-sitter 파이프라인 산출물)
REPORTS_DIR = os.path.join(TS_DIR, "reports")
TEST_DIR = os.path.join(ROOT, "codecompletion_benchmarks")
CONFIG_PATH = os.path.join(TS_DIR, "lang_config.json")

# Input (extension 자원)
RESOURCES_DIR = os.path.join(EXT_DIR, "resources")
SECRETS_PATH = os.path.join(EXT_DIR, "secrets.json")

# Output (evaluation/ 내부)
EXPERIMENTS_DIR = os.path.join(EVAL_DIR, "llm_experiments")
CACHE_DIR = os.path.join(EVAL_DIR, "llm_cache")

# 언어별 LLM 프롬프트용 display name
LANG_DISPLAY = {
    "smallbasic": "Microsoft Small Basic",
    "c":          "C",
    "cpp":        "C++",
    "haskell":    "Haskell",
    "java":       "Java",
    "javascript": "JavaScript",
    "php":        "PHP",
    "python":     "Python",
    "ruby":       "Ruby",
    "typescript": "TypeScript",
}

# =================[ SYSTEM_ROLE (extension prompts.ts 와 동일) ]=================
# code-completion-extension/src/prompts.ts 의 SYSTEM_ROLE 과 한 자 단위로 동일하게 유지.
SYSTEM_ROLE = """
You are a strict code completion engine.
Your goal is to generate code based on a provided syntax structure.

RULES:
1. Output ONLY the code snippet.
2. DO NOT include conversational text (e.g., "Here is the code", "Sure").
3. DO NOT include markdown backticks.
4. DO NOT explain the code.
5. If the context is insufficient, generate a plausible dummy variable or value (e.g., "x", "10", "Hello").
"""


# =================[ TokenMapper (mapLoader.ts Python port) ]=================
class TokenMapper:
    """
    code-completion-extension/src/mapLoader.ts 의 Python 포팅.
    구조 후보 문자열의 트리시터 내부 토큰 이름을 사람이 읽기 쉬운 형태로 변환.
    예: "preproc_include_token1" → "#include" (PATTERN 해석)
         "Stmt_token1" → "While" (대소문자 무시 패턴 해석)
         "(" → "(" (STRING 그대로)
         "identifier" → "identifier" (의미 있는 이름 유지)
    """
    _GEN_NAME_RX = re.compile(r"_token\d+$")
    _CASE_INSENS_RX = re.compile(r"\[(.)[^\]]*\]")
    _PURE_WORD_RX = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_ ]*$")
    _ALPHANUM_RX = re.compile(r"^[a-zA-Z0-9]+$")

    def __init__(self, json_path: str):
        self.mapping = {}
        if os.path.exists(json_path):
            try:
                with open(json_path) as f:
                    self.mapping = json.load(f)
            except Exception:
                pass

    def humanize_token(self, token: str) -> str:
        info = self.mapping.get(token)
        if not info:
            return token
        ttype = info.get("type")
        content = info.get("content", "")
        if ttype == "STRING":
            return content
        if ttype == "PATTERN":
            if self._GEN_NAME_RX.search(token):
                return self._clean_regex(content, token)
            return token
        return token  # COMPLEX: keep as-is

    def _clean_regex(self, regex: str, original: str) -> str:
        if self._PURE_WORD_RX.match(regex):
            return regex
        if "[" in regex:
            simplified = self._CASE_INSENS_RX.sub(r"\1", regex)
            if self._ALPHANUM_RX.match(simplified):
                return simplified
        if regex == r"\r\n" or regex == r"\n":
            return "<CR>"
        return original

    def humanize_candidate(self, candidate: str) -> str:
        """공백으로 구분된 토큰 나열을 humanize."""
        tokens = candidate.split()
        return " ".join(self.humanize_token(t) for t in tokens)


# =================[ 프롬프트 템플릿 ]=================
# 두 가지 방식 지원:
#  (a) --paper-strict: 논문 repo (monircse061/ChatGPT-Code-Completion-Work) 와
#      byte 단위로 동일한 포맷 (16칸 들여쓰기, "programming language code:" 등).
#  (b) default: 논문 Fig. 5 대로 깔끔한 멀티라인.

# -------- (a) 논문 repo 엄밀 재현 --------
# 주의: 16칸 leading whitespace, "**once**" 포함 문구, 끝 이중 마침표(..) 모두 의도적.
_PAPER_PROMPT_WITH_GUIDE = """
                This is the incomplete {prog_lan} programming language code:
                {prefix}
                '{struct}'
                Complete the '{struct}' part of the code **once** per response. Do not include more than one completion in each response..
                """
_PAPER_PROMPT_WITHOUT_GUIDE = """
                This is the incomplete {prog_lan} programming language code:
                {prefix}
                'next token or line'
                Complete the 'next token or line' part of the code **once** per response. Do not include more than one completion in each response.
                """


def build_paper_prompt_with_guide(lang_display: str, prefix: str, structural: str) -> str:
    return _PAPER_PROMPT_WITH_GUIDE.format(
        prog_lan=lang_display, prefix=prefix, struct=structural
    )


def build_paper_prompt_without_guide(lang_display: str, prefix: str) -> str:
    return _PAPER_PROMPT_WITHOUT_GUIDE.format(prog_lan=lang_display, prefix=prefix)


# -------- (b) 깔끔한 Fig. 5 스타일 (기본) --------
def build_prompt_with_guide(lang_display: str, prefix: str, structural: str) -> str:
    return (
        f"This is the incomplete {lang_display} code:\n"
        f"{prefix}\n"
        f"'{structural}'\n"
        f"Complete the '{structural}' part of the code "
        f"in the {lang_display}.\n"
        f"Just show your answer in place of '{structural}'."
    )


def build_prompt_without_guide(lang_display: str, prefix: str) -> str:
    return (
        f"This is the incomplete {lang_display} code:\n"
        f"{prefix}\n"
        f"'next token or line'\n"
        f"Complete the 'next token or line' part of the code "
        f"in the {lang_display}.\n"
        f"Just show your answer in place of 'next token or line'."
    )


# -------- 논문 repo 토큰 치환 (SB, C 공용) --------
_PAPER_TOKEN_REWRITE = {
    "ID":    "Identifier",
    "STR":   "String",
    "NUM":   "Number",
    "Exprs": "Expression",
    "Expr":  "Expression",
}


def paper_humanize_candidate(candidate: str) -> str:
    """논문 repo 의 `modified_struct_candi` 생성 방식과 동일."""
    words = candidate.split()
    rewritten = [_PAPER_TOKEN_REWRITE.get(w, w) for w in words]
    return " ".join(rewritten)


# =================[ LLM 응답 후처리 ]=================
# 논문 repo 및 우리 extension 의 refineLLMResponse 를 참고한 정제 로직.
# 각 단계는 독립적으로 on/off 가능하도록 구성.

# Markdown 코드 블록 제거 (예: ```python\n...\n```)
_MARKDOWN_FENCE_RX = re.compile(r"```[a-zA-Z0-9_+-]*\s*\n?|\n?```\s*$", re.MULTILINE)

# 인용부호 제거 (hint echo 비교용)
_QUOTE_STRIP_RX = re.compile(r"^[\"'`]+|[\"'`]+$")

# Conversational preamble 패턴 (응답 시작부에만 적용)
# 한 줄 단위로 감지하고 여러 줄 연속 preamble 은 모두 제거.
_PREAMBLE_RX = re.compile(
    r"^(?:"
    r"(?:"
    # 감탄사/수락
    r"Sure|Okay|OK|Certainly|Of course|Absolutely|Alright|Yes|Got it|"
    # Here is / Here's ...
    r"Here(?:'s|\s+is|\s+are|\s+you\s+go)|"
    # 답변 도입
    r"The\s+(?:answer|solution|code|completion)(?:\s+is)?|"
    r"Your\s+(?:answer|solution|code|completion)(?:\s+is)?|"
    r"Answer|Completion|Solution|Output|Result|Response|"
    # You can / could / may / need / should / might / would
    r"You\s+(?:can|could|may|might|should|need|would|will)|"
    # To ... (목적)
    r"To\s+(?:complete|fill|solve|answer|do|make|create|write|implement|get)"
    r"(?:\s+this|\s+the\s+code|\s+the\s+task|\s+in|\s+it)?|"
    # If you ...
    r"If\s+you|"
    # I ...
    r"I\s+(?:will|can|would|could|should|think|believe|understand)|"
    # Let me / Let's
    r"Let(?:\s+me|'s)|"
    # This (code|part|function|...) ...
    r"This\s+(?:code|part|function|snippet|line|example|block|is|will|should|can|would)|"
    # Based on the / Given the
    r"(?:Based|Given)\s+on\s+(?:the|your)|Given\s+(?:the|your)|"
    # Note that / Note:
    r"Note(?:\s+that|:)|"
    # 설명 보조
    r"In\s+Small\s+Basic|In\s+this\s+case|In\s+your\s+code|"
    r"For\s+example"
    r")"
    r"[^\n]*\n+"
    r")+",
    re.IGNORECASE,
)

# Trailing 설명 (응답 뒤쪽 자연어) 탐지용
# 빈 줄(\n\n) 뒤에 자연어 설명이 따라오는 패턴을 잘라냄
_TRAILING_EXPLAIN_RX = re.compile(r"\n\n+[A-Z][a-zA-Z].*\Z", re.DOTALL)


def postprocess_response(
    raw: str,
    prefix: str,
    structural_hint: str,
    *,
    strip_markdown: bool = True,
    strip_preamble: bool = True,
    strip_prefix_echo: bool = True,
    strip_hint_echo: bool = True,
    strip_trailing_explanation: bool = True,
) -> str:
    """
    LLM raw 응답 → 평가 가능한 최종 텍스트.
    순서 중요. 각 플래그로 개별 on/off 가능.
    """
    if not raw:
        return ""
    text = raw

    # 1. Markdown code fence 제거
    if strip_markdown:
        text = _MARKDOWN_FENCE_RX.sub("", text).strip()

    # 2. Conversational preamble 제거 ("Sure, here's the code:" 등)
    if strip_preamble:
        text = _PREAMBLE_RX.sub("", text).lstrip()

    # 3. Hint echo 체크 — 전체가 힌트 반복이면 빈 문자열
    if strip_hint_echo and structural_hint:
        bare = _QUOTE_STRIP_RX.sub("", text.strip())
        hint = _QUOTE_STRIP_RX.sub("", structural_hint.strip())
        if bare.replace(" ", "") == hint.replace(" ", ""):
            return ""

    # 4. Prefix echo 제거 (LLM이 앞부분까지 재생성한 경우)
    if strip_prefix_echo and prefix:
        stripped_prefix = prefix.rstrip()
        if text.startswith(stripped_prefix):
            text = text[len(stripped_prefix):]
        else:
            # 프리픽스 마지막 줄만이라도 반복됐는지 확인
            last_line = prefix.rstrip().split("\n")[-1]
            if last_line and text.startswith(last_line):
                text = text[len(last_line):]

    # 5. Trailing 설명 제거 (빈 줄 + 자연어 문장)
    if strip_trailing_explanation:
        text = _TRAILING_EXPLAIN_RX.sub("", text)

    # 6. 앞뒤 공백 정리 (내부 공백/개행 보존)
    text = text.strip()

    return text


# 자가검증용 테스트 케이스 (--self-test 플래그로 실행)
POSTPROCESS_TESTS = [
    # (raw, prefix, hint, expected)
    ("```python\n.foo()\n```", "bar", ". identifier ( )", ".foo()"),
    ("Sure! Here's the code:\n.foo()", "bar", ". identifier", ".foo()"),
    ("'. identifier'", "bar", ". identifier", ""),
    ("bar.foo()", "bar", ". identifier", ".foo()"),
    (".WriteLine(\"Hi\")\n\nThis code writes a message.", "TextWindow", ". ID ( Exprs )",
     ".WriteLine(\"Hi\")"),
    ("", "x", "hint", ""),
    (".foo()", "", "", ".foo()"),
    # 확장 preamble 케이스
    ("You can use TextWindow.WriteLine here:\n.WriteLine(\"Hi\")", "", "",
     '.WriteLine("Hi")'),
    ("To complete this code:\n.foo()", "", "", ".foo()"),
    ("This code writes Hello:\n.WriteLine(\"Hello\")", "", "",
     '.WriteLine("Hello")'),
    ("Based on the context:\n.foo()", "", "", ".foo()"),
    ("Note that this is a method call.\n.foo()", "", "", ".foo()"),
    ("If you want to print:\n.WriteLine(\"Hi\")", "", "", '.WriteLine("Hi")'),
    # 여러 줄 preamble 연속
    ("Sure!\nYou can do this:\nHere's the code:\n.foo()", "", "", ".foo()"),
]


def _self_test_postprocess():
    print("=== postprocess_response self-test ===")
    fail = 0
    for i, (raw, prefix, hint, expected) in enumerate(POSTPROCESS_TESTS, 1):
        got = postprocess_response(raw, prefix, hint)
        ok = got == expected
        mark = "✓" if ok else "✗"
        print(f"  {mark} case {i}: got={got!r}  expected={expected!r}")
        if not ok:
            fail += 1
    print(f"{len(POSTPROCESS_TESTS) - fail}/{len(POSTPROCESS_TESTS)} passed")
    return fail == 0


# =================[ 지표 — llm_utils 에서 import ]=================
# sacrebleu_1gram, seq_ratio 는 llm_utils 에서 실제 구현 사용.


# =================[ 파일 & 데이터 로더 ]=================
def load_lang_config(lang: str) -> dict:
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    if lang not in cfg:
        print(f"[Error] Unknown language: {lang}")
        sys.exit(1)
    common = cfg.get("_common", {})
    langcfg = cfg[lang]
    ignore_dirs = set(common.get("ignore_dirs", []))
    ignore_dirs.update(langcfg.get("extra_ignore_dirs", []))
    exts = langcfg.get("extensions", [])
    if isinstance(exts, str):
        exts = [exts]
    return {
        "extensions": tuple(exts),
        "ignore_dirs": ignore_dirs,
        "display": LANG_DISPLAY.get(lang, lang),
    }


def build_source_map(test_dir: str, extensions: tuple, ignore_dirs: set) -> dict:
    """TEST/*.* → safe_name → full_path 역매핑 (to_json_per_file_test.py 와 동일 규칙)"""
    mapping = {}
    for root, dirs, files in os.walk(test_dir):
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        for fn in files:
            _, ext = os.path.splitext(fn)
            if ext.lower() not in extensions:
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, test_dir)
            safe = rel.replace(os.path.sep, "_").replace("..", "")
            mapping[safe] = full
    return mapping


# =================[ 메인 실행 ]=================
def evaluate_file(
    args,
    lang_cfg: dict,
    src_file: str,
    json_file: str,
    out_jsonl_path: str,
    token_mapper: "TokenMapper|None" = None,
    llm_client: "LLMClient|None" = None,
):
    """한 테스트 파일의 모든 커서 위치를 순회하며 쿼리 실행 & 기록."""
    with open(src_file, "rb") as f:
        source_bytes = f.read()
    with open(json_file) as f:
        data = json.load(f)

    file_name = os.path.basename(src_file)
    lang_display = lang_cfg["display"]

    os.makedirs(os.path.dirname(out_jsonl_path), exist_ok=True)
    mode_w = "w"  # v0: 항상 새로 쓰기. v1 에서 --resume 지원 시 조건부.

    processed = 0
    skipped = 0

    with open(out_jsonl_path, mode_w, encoding="utf-8") as out:
        # cursor 오름차순 정렬
        for cursor_str in sorted(data.keys(), key=lambda x: int(x)):
            cursor = int(cursor_str)
            entries = data[cursor_str]
            if not entries:
                continue
            # 첫 번째 엔트리가 ideal (rank=1). Multi-entry 는 다음 버전에서 처리.
            ideal = entries[0]

            if args.max_positions and processed >= args.max_positions:
                break

            prefix_bytes = source_bytes[:cursor]
            prefix = prefix_bytes.decode("utf-8", errors="replace")
            ground_truth = ideal["candidate_text"]
            structural = ideal["candidate"]

            # --- 모드별 prompt 구성 ---
            if args.mode == "with-ideal":
                # Token humanize
                if args.paper_strict:
                    # 논문 repo 와 동일한 하드코딩 치환 (ID→Identifier 등)
                    struct_for_prompt = paper_humanize_candidate(structural)
                elif token_mapper and args.humanize_tokens:
                    struct_for_prompt = token_mapper.humanize_candidate(structural)
                else:
                    struct_for_prompt = structural
                # 프롬프트 빌더 선택
                if args.paper_strict:
                    prompt = build_paper_prompt_with_guide(lang_display, prefix, struct_for_prompt)
                else:
                    prompt = build_prompt_with_guide(lang_display, prefix, struct_for_prompt)
                hint_used = struct_for_prompt
            elif args.mode == "without":
                if args.paper_strict:
                    prompt = build_paper_prompt_without_guide(lang_display, prefix)
                else:
                    prompt = build_prompt_without_guide(lang_display, prefix)
                hint_used = None
            else:
                # with-top1 / with-top3: v2 에서 구현 (DB lookup + multi-call)
                print(f"[Error] Mode '{args.mode}' not implemented in v0.")
                sys.exit(1)

            # --- LLM 호출 ---
            error_msg = None
            if args.dry_run:
                raw_response_list = [""] * args.n_samples
                cached = False
                prompt_tokens = 0
                completion_tokens = 0
                latency_ms = 0
            else:
                if llm_client is None:
                    print("[Error] llm_client is None in non-dry-run mode.")
                    sys.exit(1)
                result = llm_client.complete(prompt)
                raw_response_list = result["responses"]
                cached = result["cached"]
                prompt_tokens = result["prompt_tokens"]
                completion_tokens = result["completion_tokens"]
                latency_ms = result["latency_ms"]
                error_msg = result["error"]

            # --- 응답 후처리 (n개 샘플 각각) ---
            raw_responses = raw_response_list if isinstance(raw_response_list, list) else []
            responses = []
            for raw in raw_responses:
                if args.paper_strict:
                    # 논문 repo는 raw response 그대로 사용 → 최소 처리만
                    responses.append(raw)
                else:
                    r = postprocess_response(
                        raw, prefix, hint_used or "",
                        strip_markdown=True,
                        strip_preamble=True,
                        strip_prefix_echo=True,
                        strip_hint_echo=True,
                        strip_trailing_explanation=True,
                    )
                    responses.append(r)

            # --- 지표 (샘플별 + 평균/최대) ---
            bleu_per = [sacrebleu_1gram(r, ground_truth) for r in responses]
            ratio_per = [seq_ratio(r, ground_truth) for r in responses]

            def _avg(xs): return sum(xs) / len(xs) if xs else 0.0
            def _max(xs): return max(xs) if xs else 0.0

            # --- 기록 ---
            record = {
                "file": file_name,
                "mode": args.mode,
                "cursor": cursor,
                "state_id": ideal["state_id"],
                "candidate_raw": structural,          # 트리시터 원본 비단말 이름
                "candidate_humanized": hint_used,     # 프롬프트에 쓰인 humanize 버전
                "ground_truth": ground_truth,
                "prompt": prompt,
                "responses": responses,               # n개 샘플 (후처리 후)
                "raw_responses": raw_responses,       # n개 샘플 (원본)
                "sacrebleu_1gram": bleu_per,          # 샘플별 [s1, s2, s3]
                "seq_ratio": ratio_per,
                "sacrebleu_1gram_avg": _avg(bleu_per),
                "sacrebleu_1gram_max": _max(bleu_per),
                "seq_ratio_avg": _avg(ratio_per),
                "seq_ratio_max": _max(ratio_per),
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "latency_ms": latency_ms,
                "cached": cached,
                "dry_run": args.dry_run,
                "paper_strict": args.paper_strict,
                "error": error_msg,
                "cost_usd": compute_cost_usd(args.model, prompt_tokens, completion_tokens),
                "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
            }
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            processed += 1

    return processed, skipped


def main():
    parser = argparse.ArgumentParser(description="LLM code completion experiment runner (v0)")
    parser.add_argument("lang", nargs="?", help="언어 (smallbasic, c, ...)")
    parser.add_argument("--mode",
                        choices=["with-ideal", "without", "with-top1", "with-top3"],
                        help="실험 모드")
    parser.add_argument("--dry-run", action="store_true",
                        help="API 호출 없이 prompt/ground_truth 만 기록 (v0 필수)")
    parser.add_argument("--limit", type=int, default=None,
                        help="최대 테스트 파일 수 (디버깅용)")
    parser.add_argument("--max-positions", type=int, default=None,
                        help="파일당 최대 커서 위치 (샘플링용)")
    parser.add_argument("--humanize-tokens", action="store_true",
                        help="구조 후보의 내부 토큰 이름을 TokenMapper로 humanize (권장)")
    parser.add_argument("--paper-strict", action="store_true",
                        help="논문 repo 와 byte 단위 동일한 프롬프트/치환/무(無)후처리. "
                             "이 플래그 설정 시 --no-system-role, 하드코딩 토큰 치환, "
                             "raw response 사용(후처리 최소화).")
    parser.add_argument("--out-dir", default=EXPERIMENTS_DIR,
                        help=f"출력 디렉토리 (기본: {EXPERIMENTS_DIR})")
    # --- LLM 파라미터 (논문 기본값) ---
    parser.add_argument("--model", default="gpt-3.5-turbo-0125",
                        help="OpenAI 모델 (기본: gpt-3.5-turbo-0125)")
    parser.add_argument("--n-samples", type=int, default=3,
                        help="한 커서당 응답 샘플 수 n (기본: 3, 논문 기준)")
    parser.add_argument("--temperature", type=float, default=1.0,
                        help="샘플링 온도 (기본: 1.0, 논문 기본값)")
    parser.add_argument("--max-tokens", type=int, default=70,
                        help="응답 최대 토큰 (기본: 70, 논문 기준)")
    parser.add_argument("--cache-dir", default=CACHE_DIR,
                        help="디스크 캐시 경로")
    parser.add_argument("--api-key", default="",
                        help="OpenAI API key (우선순위 1). 생략 시 secrets.json/환경변수 조회")
    parser.add_argument("--secrets-path", default=SECRETS_PATH,
                        help="secrets.json 경로 (우선순위 2)")
    parser.add_argument("--system-role", default=SYSTEM_ROLE,
                        help="System role 문자열 (기본: prompts.ts와 동일)")
    parser.add_argument("--no-system-role", action="store_true",
                        help="SYSTEM_ROLE 을 비활성화 (논문 default 재현 시)")
    parser.add_argument("--budget-usd", type=float, default=None,
                        help="누적 비용이 이 값 초과하면 자동 중단 (예: 0.5)")
    parser.add_argument("--self-test", action="store_true",
                        help="postprocess_response self-test만 실행하고 종료")
    args = parser.parse_args()

    if args.self_test:
        ok = _self_test_postprocess()
        sys.exit(0 if ok else 1)

    if not args.lang or not args.mode:
        parser.error("lang and --mode are required (unless --self-test)")

    lang_cfg = load_lang_config(args.lang)
    reports_lang_dir = os.path.join(REPORTS_DIR, args.lang)
    test_lang_dir = os.path.join(TEST_DIR, args.lang, "TEST")

    if not os.path.isdir(reports_lang_dir):
        print(f"[Error] Reports dir not found: {reports_lang_dir}")
        print("       → Did you run to_json_per_file_test.py first?")
        sys.exit(1)
    if not os.path.isdir(test_lang_dir):
        print(f"[Error] TEST source dir not found: {test_lang_dir}")
        sys.exit(1)

    source_map = build_source_map(test_lang_dir, lang_cfg["extensions"], lang_cfg["ignore_dirs"])
    print(f"[Info] Source map: {len(source_map)} files")

    # TokenMapper 로드 (humanize 옵션 시)
    token_mapper = None
    if args.humanize_tokens:
        tm_path = os.path.join(RESOURCES_DIR, args.lang, "token_mapping.json")
        if os.path.exists(tm_path):
            token_mapper = TokenMapper(tm_path)
            print(f"[Info] TokenMapper loaded: {len(token_mapper.mapping)} entries")
        else:
            print(f"[Warn] token_mapping.json not found: {tm_path}")

    json_files = sorted(glob.glob(os.path.join(reports_lang_dir, "*.json")))
    if args.limit:
        json_files = json_files[: args.limit]

    out_base = os.path.join(args.out_dir, args.lang, args.mode)
    os.makedirs(out_base, exist_ok=True)
    print(f"[Info] Output dir: {out_base}")
    print(f"[Info] Files: {len(json_files)}  mode: {args.mode}  dry_run: {args.dry_run}")
    print(f"[Info] Model: {args.model}  n={args.n_samples}  T={args.temperature}  max_tokens={args.max_tokens}")

    # LLM Client (dry-run 이 아닐 때만)
    llm_client = None
    cache = None
    if not args.dry_run:
        api_key = load_api_key(args.api_key, args.secrets_path)
        if not api_key:
            print("[Error] API key not found. Provide via --api-key, secrets.json, or OPENAI_API_KEY env.")
            sys.exit(1)
        cache_subdir = os.path.join(args.cache_dir, args.model)
        cache = DiskCache(cache_subdir)
        # --paper-strict 는 SYSTEM_ROLE 자동 비활성화 (논문 repo는 bare user message)
        effective_sys_role = "" if (args.no_system_role or args.paper_strict) else args.system_role
        llm_client = LLMClient(
            api_key=api_key,
            model=args.model,
            max_tokens=args.max_tokens,
            n=args.n_samples,
            temperature=args.temperature,
            cache=cache,
            system_role=effective_sys_role,
            max_retries=3,
        )
        print(f"[Info] SYSTEM_ROLE: {'enabled' if effective_sys_role else 'disabled'}")
        print(f"[Info] Cache: {cache_subdir}  (existing entries: {cache.size()})")

    total_processed = 0
    total_skipped = 0
    missing = 0
    for json_file in json_files:
        json_base = os.path.basename(json_file)
        safe_name = json_base[:-5] if json_base.endswith(".json") else json_base
        source_path = source_map.get(safe_name)
        if source_path is None:
            print(f"[Warn] No source for {json_base}")
            missing += 1
            continue

        out_jsonl = os.path.join(out_base, safe_name + ".jsonl")
        p, s = evaluate_file(args, lang_cfg, source_path, json_file, out_jsonl,
                             token_mapper, llm_client)
        total_processed += p
        total_skipped += s

        # 파일별 간이 비용 합계
        file_cost = 0.0
        file_cached = 0
        file_errors = 0
        if os.path.exists(out_jsonl):
            with open(out_jsonl) as jf:
                for line in jf:
                    r = json.loads(line)
                    file_cost += r.get("cost_usd", 0.0) or 0.0
                    if r.get("cached"):
                        file_cached += 1
                    if r.get("error"):
                        file_errors += 1
        print(f" -> {safe_name}: {p} positions, ${file_cost:.4f}, cached={file_cached}, err={file_errors}")

        # 예산 초과 체크 (누적 비용 계산 후)
        if args.budget_usd is not None and not args.dry_run:
            total_cost_so_far = 0.0
            for jf_name in os.listdir(out_base):
                if jf_name.endswith(".jsonl"):
                    with open(os.path.join(out_base, jf_name)) as jf:
                        for line in jf:
                            total_cost_so_far += json.loads(line).get("cost_usd", 0.0) or 0.0
            if total_cost_so_far > args.budget_usd:
                print(f"[!] Budget exceeded: ${total_cost_so_far:.4f} > ${args.budget_usd:.4f}. Stopping.")
                break

    tag = "DRY-RUN" if args.dry_run else "RUN"
    print()
    print("=" * 60)
    print(f"[{tag} SUMMARY]  mode={args.mode}  lang={args.lang}")
    print(f"  Files processed: {len(json_files) - missing}")
    print(f"  Missing source:  {missing}")
    print(f"  Cursor positions recorded: {total_processed}")
    print(f"  Skipped:                   {total_skipped}")
    print(f"  Output: {out_base}/*.jsonl")
    if cache is not None:
        print(f"  Cache entries total: {cache.size()}")
    print("=" * 60)


if __name__ == "__main__":
    main()
