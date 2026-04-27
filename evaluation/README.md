# LLM Code Completion Evaluation

논문 **"Improving LLM-based code completion using LR parsing"** (Journal of Computer Languages 84, 2025) 의 실험을 재현하고 확장하는 평가 스크립트.

## 파일 구조

```
evaluation/
├── run_llm_experiment.py   # 메인 실험 러너
├── llm_utils.py            # DiskCache + LLMClient + 지표
├── llm_cache/              # OpenAI API 응답 디스크 캐시 (자동 생성)
└── llm_experiments/        # 실험 결과 JSONL (자동 생성)
    └── <lang>/<mode>/<file>.jsonl
```

## 의존성

```bash
pip install openai sacrebleu
```

## 입력 데이터

| 데이터 | 위치 | 준비 방법 |
|---|---|---|
| 정답 JSON (state + candidate + candidate_text) | `/home/hyeonjin/PL/tree-sitter/reports/<lang>/*.json` | `to_json_per_file_test.py <lang>` |
| TEST 소스 | `/home/hyeonjin/PL/codecompletion_benchmarks/<lang>/TEST/` | 사전 준비 |
| 구조 후보 DB | `../resources/<lang>/candidates.json` | `to_json_aggregate.py <lang>` |
| 토큰 매핑 | `../resources/<lang>/token_mapping.json` | tree-sitter generate 과정 |
| OpenAI API key | `../secrets.json` | `{"apiKey": "sk-..."}` |

## 사용법

### (A) 논문 엄밀 재현 (SmallBasic, C) — `--paper-strict`

논문 repo (`monircse061/ChatGPT-Code-Completion-Work`) 와 byte 단위 동일한
프롬프트/토큰치환/무(無) 후처리/무(無) SYSTEM_ROLE 로 실행.
논문 Table 2 수치와 직접 비교 가능.

```bash
# WithIdealGuide
python3 run_llm_experiment.py smallbasic --mode with-ideal --paper-strict

# WithoutGuide
python3 run_llm_experiment.py smallbasic --mode without --paper-strict
```

C도 동일:
```bash
python3 run_llm_experiment.py c --mode with-ideal --paper-strict --budget-usd 5.0
python3 run_llm_experiment.py c --mode without --paper-strict --budget-usd 5.0
```

> **주의**: `--paper-strict` 는 토큰 치환을 내부적으로 처리하므로
> `--humanize-tokens` 는 **중복 적용 금지** (paper-strict 가 우선).

### (B) 개선판 (논문 외 언어) — `--humanize-tokens`

SYSTEM_ROLE 유지 + 공격적 후처리 + TokenMapper humanize.

```bash
# with-ideal 모드만 --humanize-tokens 효과 있음
# (without 모드는 프롬프트에 구조 후보가 없으므로 무시됨)
python3 run_llm_experiment.py python --mode with-ideal --humanize-tokens
python3 run_llm_experiment.py python --mode without
```

### 초기 검증 (저비용)

```bash
python3 run_llm_experiment.py smallbasic --mode with-ideal \
    --paper-strict --limit 1 --max-positions 5 --budget-usd 0.05
```

### 주요 CLI 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `<lang>` | (필수) | smallbasic, c, python, ruby, ... |
| `--mode` | (필수) | with-ideal / without / with-top1 / with-top3 |
| `--model` | gpt-3.5-turbo-0125 | OpenAI 모델 (논문 기준) |
| `--n-samples` | 3 | 한 커서당 응답 샘플 수 (논문 기준) |
| `--temperature` | 1.0 | 샘플링 온도 (논문 기본값) |
| `--max-tokens` | 70 | 응답 최대 토큰 (논문 기준) |
| `--humanize-tokens` | off | TokenMapper 로 비단말 이름 humanize (with-ideal 에만 효과) |
| `--paper-strict` | off | 논문 repo 와 byte 단위 동일 모드 (권장: SB/C 재현) |
| `--limit N` | all | 테스트 파일 상한 (디버깅) |
| `--max-positions N` | all | 파일당 커서 상한 (샘플링) |
| `--dry-run` | off | API 호출 없이 프롬프트만 생성 |
| `--budget-usd X` | none | 누적 비용이 X USD 초과 시 자동 중단 |
| `--system-role` | prompts.ts 와 동일 | System message |
| `--no-system-role` | off | SYSTEM_ROLE 비활성화 (논문 raw 재현) |

## JSONL 스키마

```json
{
  "file": "01_HelloWorld.sb",
  "mode": "with-ideal",
  "cursor": 0,
  "state_id": 1,
  "candidate_raw": "ID . ID ( Exprs )",
  "candidate_humanized": "ID . ID ( Exprs )",
  "ground_truth": "TextWindow.WriteLine(\"Hello World\")",
  "prompt": "...",
  "responses": ["s1", "s2", "s3"],
  "raw_responses": ["raw1", "raw2", "raw3"],
  "sacrebleu_1gram": [80.0, 100.0, 60.0],
  "seq_ratio": [0.9, 1.0, 0.7],
  "sacrebleu_1gram_avg": 80.0,
  "sacrebleu_1gram_max": 100.0,
  "seq_ratio_avg": 0.867,
  "seq_ratio_max": 1.0,
  "prompt_tokens": 59,
  "completion_tokens": 9,
  "latency_ms": 1398,
  "cached": false,
  "cost_usd": 0.000043,
  "dry_run": false,
  "error": null,
  "timestamp": "2026-04-22T16:05:12Z"
}
```

## 지표

- **SacreBLEU 1-gram precision** (0~100): `sacrebleu.corpus_bleu(...).precisions[0]`
- **SequenceMatcher ratio** (0~1): `difflib.SequenceMatcher(None, pred, ref).ratio()`

둘 다 논문 Section 3.3 공식과 완전히 동일.

## 자가 검증

```bash
python3 llm_utils.py            # DiskCache + 지표 + 비용
python3 run_llm_experiment.py --self-test   # postprocess 회귀 테스트
```
