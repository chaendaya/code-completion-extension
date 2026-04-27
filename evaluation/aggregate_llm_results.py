#!/usr/bin/env python3
"""
LLM 실험 결과 집계 스크립트.

llm_experiments/<lang>/<mode>/*.jsonl 을 읽어 파일별 평균 → 전체 평균 계산.
논문 Table 2 형태로 With vs Without 비교 출력.

사용법:
  python3 aggregate_llm_results.py smallbasic                  # 1개 언어
  python3 aggregate_llm_results.py smallbasic c                # 다수 언어
  python3 aggregate_llm_results.py --all                       # 사용 가능한 모두
  python3 aggregate_llm_results.py smallbasic --metric max     # avg 대신 max 사용
  python3 aggregate_llm_results.py smallbasic --no-csv          # CSV 저장 생략

출력:
  llm_experiments/<lang>/<mode>/summary.csv   # 파일별 평균
  llm_experiments/<lang>/<mode>/overall.json  # 전체 통계
  stdout                                      # 비교 표
"""

import argparse
import csv
import datetime
import glob
import json
import os
import statistics
import sys

# ================[ 경로 ]================
HERE = os.path.dirname(os.path.abspath(__file__))
EXPERIMENTS_DIR = os.path.join(HERE, "llm_experiments")

# 논문 Table 2 수치 (대조용)
PAPER_TABLE2 = {
    "smallbasic": {
        "with-ideal": {"sacrebleu": 49.790, "seq_ratio": 44.703},
        "without":    {"sacrebleu": 40.798, "seq_ratio": 37.897},
    },
    "c": {
        "with-ideal": {"sacrebleu": 28.368, "seq_ratio": 28.658},
        "without":    {"sacrebleu": 15.472, "seq_ratio": 15.074},
    },
}


# ================[ JSONL 읽기 & 집계 ]================
def load_jsonl(path: str) -> list:
    records = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def summarize_file(records: list, metric: str = "avg") -> dict:
    """
    한 파일의 JSONL 레코드들을 받아 파일 단위 집계.
    metric: "avg" (n개 샘플 평균) 또는 "max" (n개 중 최고)
    """
    if not records:
        return None

    bleu_key = f"sacrebleu_1gram_{metric}"
    ratio_key = f"seq_ratio_{metric}"

    bleus = [r[bleu_key] for r in records if bleu_key in r]
    ratios = [r[ratio_key] for r in records if ratio_key in r]

    # 비용/호출 집계
    cost = sum(r.get("cost_usd", 0.0) or 0.0 for r in records)
    prompt_tok = sum(r.get("prompt_tokens", 0) or 0 for r in records)
    compl_tok = sum(r.get("completion_tokens", 0) or 0 for r in records)
    cached = sum(1 for r in records if r.get("cached"))
    errors = sum(1 for r in records if r.get("error"))

    return {
        "n_cursors": len(records),
        "sacrebleu_mean": statistics.mean(bleus) if bleus else 0.0,
        "sacrebleu_stdev": statistics.stdev(bleus) if len(bleus) > 1 else 0.0,
        "seq_ratio_mean": statistics.mean(ratios) if ratios else 0.0,
        "seq_ratio_stdev": statistics.stdev(ratios) if len(ratios) > 1 else 0.0,
        "cost_usd": cost,
        "prompt_tokens": prompt_tok,
        "completion_tokens": compl_tok,
        "cached_hits": cached,
        "errors": errors,
    }


def summarize_mode(mode_dir: str, metric: str) -> dict:
    """
    llm_experiments/<lang>/<mode>/ 아래 *.jsonl 들을 모두 읽고 전체 평균 계산.
    논문 집계 방식: 커서 → 파일 평균 → 파일 평균의 평균.
    """
    jsonl_files = sorted(glob.glob(os.path.join(mode_dir, "*.jsonl")))
    if not jsonl_files:
        return None

    per_file = []
    for jp in jsonl_files:
        recs = load_jsonl(jp)
        if not recs:
            continue
        s = summarize_file(recs, metric=metric)
        if s is None:
            continue
        s["file"] = os.path.basename(jp)
        per_file.append(s)

    if not per_file:
        return None

    # 전체 (파일 평균의 평균)
    file_bleus = [f["sacrebleu_mean"] for f in per_file]
    file_ratios = [f["seq_ratio_mean"] for f in per_file]

    total_cost = sum(f["cost_usd"] for f in per_file)
    total_cursors = sum(f["n_cursors"] for f in per_file)
    total_cached = sum(f["cached_hits"] for f in per_file)
    total_errors = sum(f["errors"] for f in per_file)

    # paper_strict 여부 확인 (첫 레코드 기준)
    first_jsonl = jsonl_files[0]
    first_rec = None
    with open(first_jsonl) as f:
        for line in f:
            if line.strip():
                first_rec = json.loads(line)
                break
    paper_strict = first_rec.get("paper_strict", False) if first_rec else False
    model = None
    if first_rec:
        # 캐시나 metadata 에서 모델 추정은 복잡하므로 생략
        pass

    return {
        "n_files": len(per_file),
        "n_cursors_total": total_cursors,
        "sacrebleu_overall": statistics.mean(file_bleus),
        "sacrebleu_stdev_across_files": statistics.stdev(file_bleus) if len(file_bleus) > 1 else 0.0,
        "seq_ratio_overall": statistics.mean(file_ratios),
        "seq_ratio_stdev_across_files": statistics.stdev(file_ratios) if len(file_ratios) > 1 else 0.0,
        "total_cost_usd": total_cost,
        "total_cached_hits": total_cached,
        "total_errors": total_errors,
        "paper_strict": paper_strict,
        "metric": metric,
        "per_file": per_file,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    }


# ================[ 출력 저장 ]================
def write_summary_csv(summary: dict, csv_path: str):
    cols = ["file", "n_cursors",
            "sacrebleu_mean", "sacrebleu_stdev",
            "seq_ratio_mean", "seq_ratio_stdev",
            "cost_usd", "prompt_tokens", "completion_tokens",
            "cached_hits", "errors"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for rec in summary["per_file"]:
            w.writerow({k: rec.get(k) for k in cols})


def write_overall_json(summary: dict, json_path: str):
    # per_file 은 크므로 overall.json 에는 요약만
    out = {k: v for k, v in summary.items() if k != "per_file"}
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)


# ================[ 비교 표 출력 ]================
def format_delta(ours: float, paper: float) -> str:
    d = ours - paper
    sign = "+" if d >= 0 else ""
    return f"{sign}{d:.2f}"


def print_table2(lang_summaries: dict):
    """
    lang_summaries = {
        "smallbasic": {"with-ideal": {...}, "without": {...}},
        "c": {...},
    }
    """
    print()
    print("=" * 84)
    print(f"{'Language':<12} {'Mode':<12} {'n_files':>7} {'cursors':>9} {'SacreBLEU':>10} {'SeqRatio':>10} {'paper_BLEU':>10} {'Δ':>7}")
    print("-" * 84)

    for lang in sorted(lang_summaries.keys()):
        modes = lang_summaries[lang]
        for mode in ("with-ideal", "without", "with-top1", "with-top3"):
            if mode not in modes or modes[mode] is None:
                continue
            s = modes[mode]
            ours_bleu = s["sacrebleu_overall"]
            ours_ratio = s["seq_ratio_overall"] * 100.0  # 0~1 → %
            paper = PAPER_TABLE2.get(lang, {}).get(mode)
            paper_bleu_str = f"{paper['sacrebleu']:>10.2f}" if paper else f"{'-':>10}"
            delta_str = format_delta(ours_bleu, paper["sacrebleu"]) if paper else "-"

            # paper_strict 여부 마커
            mark = " *" if s.get("paper_strict") else ""
            mode_label = f"{mode}{mark}"

            print(f"{lang:<12} {mode_label:<12} "
                  f"{s['n_files']:>7} {s['n_cursors_total']:>9} "
                  f"{ours_bleu:>10.2f} {ours_ratio:>10.2f} "
                  f"{paper_bleu_str} {delta_str:>7}")

    print("-" * 84)
    print("  * = paper-strict 모드로 실행됨 (논문 byte-identical)")
    print()


def print_costs(lang_summaries: dict):
    print("=" * 60)
    print("비용 / 호출 요약")
    print("-" * 60)
    print(f"{'Language':<12} {'Mode':<14} {'Cost USD':>10} {'Cached':>8} {'Errors':>7}")
    total_cost = 0.0
    for lang in sorted(lang_summaries.keys()):
        for mode, s in lang_summaries[lang].items():
            if s is None:
                continue
            print(f"{lang:<12} {mode:<14} {s['total_cost_usd']:>10.4f} "
                  f"{s['total_cached_hits']:>8} {s['total_errors']:>7}")
            total_cost += s["total_cost_usd"]
    print("-" * 60)
    print(f"{'TOTAL':<26} ${total_cost:>9.4f}")
    print()


# ================[ 메인 ]================
def discover_languages() -> list:
    if not os.path.isdir(EXPERIMENTS_DIR):
        return []
    return sorted(
        d for d in os.listdir(EXPERIMENTS_DIR)
        if os.path.isdir(os.path.join(EXPERIMENTS_DIR, d))
    )


def main():
    parser = argparse.ArgumentParser(description="LLM experiment result aggregator")
    parser.add_argument("langs", nargs="*", help="집계할 언어 (생략 시 --all 필요)")
    parser.add_argument("--all", action="store_true",
                        help="llm_experiments/ 아래 모든 언어 자동 탐지")
    parser.add_argument("--mode", default=None,
                        help="특정 모드만 처리 (기본: 모든 모드)")
    parser.add_argument("--metric", choices=["avg", "max"], default="avg",
                        help="n=3 샘플 집계 방식. avg (논문), max (oracle)")
    parser.add_argument("--no-csv", action="store_true",
                        help="CSV/JSON 파일 저장 생략, 표만 출력")
    args = parser.parse_args()

    # 대상 언어 결정
    if args.all:
        langs = discover_languages()
    else:
        langs = args.langs
    if not langs:
        print("[Error] 언어를 지정하거나 --all 사용.")
        sys.exit(1)

    lang_summaries = {}
    for lang in langs:
        lang_dir = os.path.join(EXPERIMENTS_DIR, lang)
        if not os.path.isdir(lang_dir):
            print(f"[Warn] No experiments for {lang}: {lang_dir}")
            continue
        mode_dirs = sorted(
            d for d in os.listdir(lang_dir)
            if os.path.isdir(os.path.join(lang_dir, d))
        )
        if args.mode:
            mode_dirs = [args.mode] if args.mode in mode_dirs else []

        lang_summaries[lang] = {}
        for mode in mode_dirs:
            mode_dir = os.path.join(lang_dir, mode)
            summary = summarize_mode(mode_dir, args.metric)
            if summary is None:
                print(f"[Warn] {lang}/{mode}: no records")
                continue
            lang_summaries[lang][mode] = summary

            # CSV / overall.json 저장
            if not args.no_csv:
                csv_path = os.path.join(mode_dir, "summary.csv")
                json_path = os.path.join(mode_dir, "overall.json")
                write_summary_csv(summary, csv_path)
                write_overall_json(summary, json_path)
                print(f"[Saved] {csv_path}")
                print(f"[Saved] {json_path}")

    # 비교 표 출력
    print_table2(lang_summaries)
    print_costs(lang_summaries)


if __name__ == "__main__":
    main()
