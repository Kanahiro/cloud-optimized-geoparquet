#!/usr/bin/env python3
"""Benchmark two cogp binaries on the same input GeoParquet file.

The benchmark measures conversion wall time, output size, row-group bbox
shape/selectivity, and row-group index continuity for synthetic bbox queries.

Requires pyarrow:

    python3 -m pip install pyarrow
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

try:
    import pyarrow.parquet as pq
except ImportError as exc:  # pragma: no cover - startup dependency guard
    raise SystemExit(
        "pyarrow is required for footer/statistics analysis. "
        "Install it with: python3 -m pip install pyarrow"
    ) from exc


@dataclass(frozen=True)
class Impl:
    label: str
    bin: Path
    output: Path


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    i = int(p * (len(values) - 1))
    return sorted(values)[i]


def mean(values: Iterable[float]) -> float:
    values = list(values)
    return statistics.mean(values) if values else 0.0


def bbox_area(b: tuple[float, float, float, float]) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def bbox_aspect(b: tuple[float, float, float, float]) -> float:
    w = max(1e-12, b[2] - b[0])
    h = max(1e-12, b[3] - b[1])
    return max(w / h, h / w)


def intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def run_command(cmd: list[str]) -> tuple[float, str, str]:
    start = time.perf_counter()
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(
            f"command failed with exit code {proc.returncode}: {' '.join(cmd)}\n"
            f"--- stdout ---\n{proc.stdout}\n"
            f"--- stderr ---\n{proc.stderr}"
        )
    return elapsed, proc.stdout, proc.stderr


def convert_and_validate(impl: Impl, input_path: Path, extra_convert_args: list[str]) -> dict:
    impl.output.parent.mkdir(parents=True, exist_ok=True)
    if impl.output.exists():
        impl.output.unlink()

    elapsed, stdout, stderr = run_command(
        [str(impl.bin), "convert", str(input_path), str(impl.output), *extra_convert_args]
    )
    validate_elapsed, validate_stdout, validate_stderr = run_command(
        [str(impl.bin), "validate", str(impl.output)]
    )
    return {
        "convert_seconds": elapsed,
        "convert_stdout": stdout,
        "convert_stderr": stderr,
        "validate_seconds": validate_elapsed,
        "validate_stdout": validate_stdout,
        "validate_stderr": validate_stderr,
    }


def column_index(row_group, path: str) -> int:
    for i in range(row_group.num_columns):
        if row_group.column(i).path_in_schema == path:
            return i
    raise KeyError(f"column path not found in parquet footer: {path}")


def row_group_bboxes(path: Path) -> dict:
    pf = pq.ParquetFile(path)
    if pf.metadata.num_row_groups == 0:
        raise ValueError(f"{path} has no row groups")

    first_rg = pf.metadata.row_group(0)
    paths = {
        "xmin": column_index(first_rg, "bbox.xmin"),
        "ymin": column_index(first_rg, "bbox.ymin"),
        "xmax": column_index(first_rg, "bbox.xmax"),
        "ymax": column_index(first_rg, "bbox.ymax"),
    }

    bboxes: list[tuple[float, float, float, float]] = []
    rows: list[int] = []
    compressed_bytes: list[int] = []
    for rg_i in range(pf.metadata.num_row_groups):
        rg = pf.metadata.row_group(rg_i)
        stats = {name: rg.column(idx).statistics for name, idx in paths.items()}
        if any(s is None or s.min is None or s.max is None for s in stats.values()):
            raise ValueError(f"{path} row group {rg_i} is missing bbox min/max statistics")
        bboxes.append(
            (
                float(stats["xmin"].min),
                float(stats["ymin"].min),
                float(stats["xmax"].max),
                float(stats["ymax"].max),
            )
        )
        rows.append(rg.num_rows)
        compressed_bytes.append(
            sum(rg.column(i).total_compressed_size for i in range(rg.num_columns))
        )

    metadata = pf.metadata.metadata or {}
    if b"cogp" not in metadata:
        raise ValueError(f"{path} has no cogp metadata")
    cogp = json.loads(metadata[b"cogp"].decode("utf-8"))
    return {
        "row_group_bboxes": bboxes,
        "row_group_rows": rows,
        "row_group_compressed_bytes": compressed_bytes,
        "levels": cogp["levels"],
        "num_rows": pf.metadata.num_rows,
        "num_row_groups": pf.metadata.num_row_groups,
    }


def contiguity(indexes: list[int]) -> dict:
    if not indexes:
        return {
            "runs": 0,
            "longest_run": 0,
            "hits_per_run": 0.0,
            "span_over_hits": 0.0,
        }

    runs = 1
    longest = 1
    current = 1
    for a, b in zip(indexes, indexes[1:]):
        if b == a + 1:
            current += 1
            longest = max(longest, current)
        else:
            runs += 1
            current = 1

    span = indexes[-1] - indexes[0] + 1
    return {
        "runs": runs,
        "longest_run": longest,
        "hits_per_run": len(indexes) / runs,
        "span_over_hits": span / len(indexes),
    }


def gap_clusters(indexes: list[int], gap: int) -> int:
    if not indexes:
        return 0
    clusters = 1
    for a, b in zip(indexes, indexes[1:]):
        if b - a - 1 > gap:
            clusters += 1
    return clusters


def level_scope_end(levels: list[dict], scope: str, num_row_groups: int) -> int:
    if scope == "all":
        return num_row_groups
    if not scope.startswith("up_to_"):
        raise ValueError(f"invalid scope: {scope}")
    level_i = int(scope.removeprefix("up_to_"))
    if level_i < 0 or level_i >= len(levels):
        raise ValueError(f"scope {scope} is out of range for {len(levels)} levels")
    return int(levels[level_i]["row_group_end"]) + 1


def make_queries(
    extent: tuple[float, float, float, float],
    query_fracs: list[float],
    query_count: int,
    seed: int,
) -> dict[str, list[tuple[float, float, float, float]]]:
    rng = random.Random(seed)
    xmin, ymin, xmax, ymax = extent
    width = xmax - xmin
    height = ymax - ymin
    queries: dict[str, list[tuple[float, float, float, float]]] = {}
    for frac in query_fracs:
        qwidth = width * frac
        qheight = height * frac
        label = f"{frac:g}"
        queries[label] = []
        for _ in range(query_count):
            x = rng.uniform(xmin, xmax - qwidth)
            y = rng.uniform(ymin, ymax - qheight)
            queries[label].append((x, y, x + qwidth, y + qheight))
    return queries


def analyze_queries(
    footer: dict,
    queries: dict[str, list[tuple[float, float, float, float]]],
    scopes: list[str],
    coalesce_gaps: list[int],
) -> dict:
    bboxes = footer["row_group_bboxes"]
    compressed_bytes = footer["row_group_compressed_bytes"]
    levels = footer["levels"]
    results = {}

    for scope in scopes:
        end = level_scope_end(levels, scope, footer["num_row_groups"])
        scoped_bboxes = bboxes[:end]
        scope_results = {}
        for frac, qs in queries.items():
            hits: list[float] = []
            mb: list[float] = []
            runs: list[float] = []
            longest: list[float] = []
            hits_per_run: list[float] = []
            span_over_hits: list[float] = []
            clusters_by_gap = {gap: [] for gap in coalesce_gaps}

            for q in qs:
                indexes = [i for i, b in enumerate(scoped_bboxes) if intersects(q, b)]
                c = contiguity(indexes)
                hits.append(float(len(indexes)))
                mb.append(sum(compressed_bytes[i] for i in indexes) / 1_000_000.0)
                runs.append(float(c["runs"]))
                longest.append(float(c["longest_run"]))
                hits_per_run.append(float(c["hits_per_run"]))
                span_over_hits.append(float(c["span_over_hits"]))
                for gap in coalesce_gaps:
                    clusters_by_gap[gap].append(float(gap_clusters(indexes, gap)))

            scope_results[frac] = {
                "avg_hits": mean(hits),
                "p95_hits": percentile(hits, 0.95),
                "avg_compressed_mb": mean(mb),
                "avg_runs": mean(runs),
                "p95_runs": percentile(runs, 0.95),
                "avg_longest_run": mean(longest),
                "avg_hits_per_run": mean(hits_per_run),
                "avg_span_over_hits": mean(span_over_hits),
                "avg_clusters_by_gap": {
                    str(gap): mean(vals) for gap, vals in clusters_by_gap.items()
                },
            }
        results[scope] = scope_results
    return results


def summarize_footer(path: Path, footer: dict) -> dict:
    bboxes = footer["row_group_bboxes"]
    areas = [bbox_area(b) for b in bboxes]
    aspects = [bbox_aspect(b) for b in bboxes]
    return {
        "path": str(path),
        "size_bytes": path.stat().st_size,
        "num_rows": footer["num_rows"],
        "num_row_groups": footer["num_row_groups"],
        "num_levels": len(footer["levels"]),
        "compressed_bytes": sum(footer["row_group_compressed_bytes"]),
        "bbox_area_sum": sum(areas),
        "bbox_area_median": statistics.median(areas),
        "bbox_area_p95": percentile(areas, 0.95),
        "bbox_aspect_median": statistics.median(aspects),
        "bbox_aspect_p95": percentile(aspects, 0.95),
        "bbox_aspect_max": max(aspects),
        "levels": footer["levels"],
    }


def global_extent(footers: list[dict]) -> tuple[float, float, float, float]:
    bboxes = [b for footer in footers for b in footer["row_group_bboxes"]]
    return (
        min(b[0] for b in bboxes),
        min(b[1] for b in bboxes),
        max(b[2] for b in bboxes),
        max(b[3] for b in bboxes),
    )


def delta(candidate: float, baseline: float) -> dict:
    if candidate is None or baseline is None:
        return {"absolute": None, "relative": 0.0}
    absolute = candidate - baseline
    relative = (absolute / baseline) if baseline else 0.0
    return {"absolute": absolute, "relative": relative}


def add_comparison(results: dict, baseline: str, candidate: str) -> None:
    b = results["implementations"][baseline]
    c = results["implementations"][candidate]
    comparison = {
        "convert_seconds": delta(c["convert_seconds"], b["convert_seconds"]),
        "size_bytes": delta(c["summary"]["size_bytes"], b["summary"]["size_bytes"]),
        "compressed_bytes": delta(
            c["summary"]["compressed_bytes"], b["summary"]["compressed_bytes"]
        ),
        "bbox_area_sum": delta(c["summary"]["bbox_area_sum"], b["summary"]["bbox_area_sum"]),
        "bbox_area_median": delta(
            c["summary"]["bbox_area_median"], b["summary"]["bbox_area_median"]
        ),
        "bbox_aspect_median": delta(
            c["summary"]["bbox_aspect_median"], b["summary"]["bbox_aspect_median"]
        ),
        "bbox_aspect_p95": delta(c["summary"]["bbox_aspect_p95"], b["summary"]["bbox_aspect_p95"]),
        "bbox_aspect_max": delta(c["summary"]["bbox_aspect_max"], b["summary"]["bbox_aspect_max"]),
        "queries": {},
    }
    for scope, b_scope in b["queries"].items():
        c_scope = c["queries"][scope]
        comparison["queries"][scope] = {}
        for frac, b_metrics in b_scope.items():
            c_metrics = c_scope[frac]
            comparison["queries"][scope][frac] = {
                "avg_hits": delta(c_metrics["avg_hits"], b_metrics["avg_hits"]),
                "avg_compressed_mb": delta(
                    c_metrics["avg_compressed_mb"], b_metrics["avg_compressed_mb"]
                ),
                "avg_runs": delta(c_metrics["avg_runs"], b_metrics["avg_runs"]),
                "avg_hits_per_run": delta(
                    c_metrics["avg_hits_per_run"], b_metrics["avg_hits_per_run"]
                ),
                "avg_clusters_by_gap": {
                    gap: delta(c_metrics["avg_clusters_by_gap"][gap], b_value)
                    for gap, b_value in b_metrics["avg_clusters_by_gap"].items()
                },
            }
    results["comparison"] = comparison


def pct(value: float) -> str:
    return f"{value * 100:+.2f}%"


def render_markdown(results: dict, baseline: str, candidate: str) -> str:
    b = results["implementations"][baseline]
    c = results["implementations"][candidate]
    comp = results["comparison"]

    def seconds(value) -> str:
        return "reused" if value is None else f"{value:.3f}"

    lines = [
        "# COGP Benchmark",
        "",
        f"- input: `{results['input']}`",
        f"- baseline: `{baseline}`",
        f"- candidate: `{candidate}`",
        f"- query_count: `{results['query_count']}`",
        f"- seed: `{results['seed']}`",
        "",
        "## Conversion / Footer",
        "",
        "| metric | baseline | candidate | delta |",
        "|---|---:|---:|---:|",
        (
            f"| convert seconds | {seconds(b['convert_seconds'])} | "
            f"{seconds(c['convert_seconds'])} | {pct(comp['convert_seconds']['relative'])} |"
        ),
        (
            f"| output MB | {b['summary']['size_bytes'] / 1_000_000:.3f} | "
            f"{c['summary']['size_bytes'] / 1_000_000:.3f} | {pct(comp['size_bytes']['relative'])} |"
        ),
        (
            f"| compressed MB | {b['summary']['compressed_bytes'] / 1_000_000:.3f} | "
            f"{c['summary']['compressed_bytes'] / 1_000_000:.3f} | "
            f"{pct(comp['compressed_bytes']['relative'])} |"
        ),
        (
            f"| row groups | {b['summary']['num_row_groups']} | "
            f"{c['summary']['num_row_groups']} |  |"
        ),
        (
            f"| levels | {b['summary']['num_levels']} | {c['summary']['num_levels']} |  |"
        ),
        (
            f"| bbox area sum | {b['summary']['bbox_area_sum']:.6f} | "
            f"{c['summary']['bbox_area_sum']:.6f} | {pct(comp['bbox_area_sum']['relative'])} |"
        ),
        (
            f"| bbox area median | {b['summary']['bbox_area_median']:.6f} | "
            f"{c['summary']['bbox_area_median']:.6f} | "
            f"{pct(comp['bbox_area_median']['relative'])} |"
        ),
        (
            f"| bbox aspect median | {b['summary']['bbox_aspect_median']:.3f} | "
            f"{c['summary']['bbox_aspect_median']:.3f} | "
            f"{pct(comp['bbox_aspect_median']['relative'])} |"
        ),
        (
            f"| bbox aspect p95 | {b['summary']['bbox_aspect_p95']:.3f} | "
            f"{c['summary']['bbox_aspect_p95']:.3f} | "
            f"{pct(comp['bbox_aspect_p95']['relative'])} |"
        ),
        (
            f"| bbox aspect max | {b['summary']['bbox_aspect_max']:.3f} | "
            f"{c['summary']['bbox_aspect_max']:.3f} | "
            f"{pct(comp['bbox_aspect_max']['relative'])} |"
        ),
        "",
        "## Query Selectivity / Continuity",
        "",
        (
            "`runs` is the number of strictly contiguous row-group ranges. "
            "`gap4` is the number of ranges after coalescing gaps of up to 4 skipped row groups."
        ),
        "",
    ]

    for scope, b_scope in b["queries"].items():
        lines.extend(
            [
                f"### {scope}",
                "",
                (
                    "| query frac | baseline hits | candidate hits | hits delta | "
                    "baseline MB | candidate MB | MB delta | baseline runs | candidate runs | "
                    "runs delta | baseline gap4 | candidate gap4 | gap4 delta |"
                ),
                "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
            ]
        )
        for frac, b_metrics in b_scope.items():
            c_metrics = c["queries"][scope][frac]
            q_comp = comp["queries"][scope][frac]
            b_gap4 = b_metrics["avg_clusters_by_gap"].get("4", b_metrics["avg_runs"])
            c_gap4 = c_metrics["avg_clusters_by_gap"].get("4", c_metrics["avg_runs"])
            gap4_delta = delta(c_gap4, b_gap4)
            lines.append(
                f"| {frac} | {b_metrics['avg_hits']:.3f} | {c_metrics['avg_hits']:.3f} | "
                f"{pct(q_comp['avg_hits']['relative'])} | "
                f"{b_metrics['avg_compressed_mb']:.3f} | {c_metrics['avg_compressed_mb']:.3f} | "
                f"{pct(q_comp['avg_compressed_mb']['relative'])} | "
                f"{b_metrics['avg_runs']:.3f} | {c_metrics['avg_runs']:.3f} | "
                f"{pct(q_comp['avg_runs']['relative'])} | "
                f"{b_gap4:.3f} | {c_gap4:.3f} | {pct(gap4_delta['relative'])} |"
            )
        lines.append("")
    return "\n".join(lines)


def parse_csv_floats(value: str) -> list[float]:
    return [float(v) for v in value.split(",") if v]


def parse_csv_ints(value: str) -> list[int]:
    return [int(v) for v in value.split(",") if v]


def parse_csv_strings(value: str) -> list[str]:
    return [v for v in value.split(",") if v]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Input GeoParquet file")
    parser.add_argument("--baseline-bin", required=True, type=Path, help="Baseline cogp binary")
    parser.add_argument("--candidate-bin", required=True, type=Path, help="Candidate cogp binary")
    parser.add_argument("--baseline-label", default="baseline")
    parser.add_argument("--candidate-label", default="candidate")
    parser.add_argument("--output-dir", default=Path("/tmp/cogp-bench"), type=Path)
    parser.add_argument(
        "--baseline-output",
        type=Path,
        help="Expected/explicit baseline COGP output path",
    )
    parser.add_argument(
        "--candidate-output",
        type=Path,
        help="Expected/explicit candidate COGP output path",
    )
    parser.add_argument("--query-count", default=5000, type=int)
    parser.add_argument("--query-fracs", default="0.005,0.01,0.02,0.05,0.1,0.2")
    parser.add_argument("--scopes", default="all,up_to_6,up_to_8,up_to_9")
    parser.add_argument("--coalesce-gaps", default="0,1,2,4,8")
    parser.add_argument("--seed", default=23, type=int)
    parser.add_argument(
        "--extra-convert-arg",
        action="append",
        default=[],
        help="Additional argument passed to both `cogp convert` commands. Repeat as needed.",
    )
    parser.add_argument(
        "--reuse-outputs",
        action="store_true",
        help="Skip convert/validate if expected output files already exist.",
    )
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--markdown-out", type=Path)
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(f"input file does not exist: {args.input}")
    if not args.baseline_bin.exists():
        raise SystemExit(f"baseline binary does not exist: {args.baseline_bin}")
    if not args.candidate_bin.exists():
        raise SystemExit(f"candidate binary does not exist: {args.candidate_bin}")

    query_fracs = parse_csv_floats(args.query_fracs)
    scopes = parse_csv_strings(args.scopes)
    coalesce_gaps = parse_csv_ints(args.coalesce_gaps)

    input_stem = args.input.name.removesuffix(".parquet")
    baseline = Impl(
        args.baseline_label,
        args.baseline_bin,
        args.baseline_output
        or args.output_dir / f"{input_stem}.{args.baseline_label}.cogp.parquet",
    )
    candidate = Impl(
        args.candidate_label,
        args.candidate_bin,
        args.candidate_output
        or args.output_dir / f"{input_stem}.{args.candidate_label}.cogp.parquet",
    )

    results = {
        "input": str(args.input),
        "query_count": args.query_count,
        "query_fracs": query_fracs,
        "scopes": scopes,
        "coalesce_gaps": coalesce_gaps,
        "seed": args.seed,
        "extra_convert_args": args.extra_convert_arg,
        "implementations": {},
    }

    footers = {}
    for impl in (baseline, candidate):
        print(f"[bench] {impl.label}: output={impl.output}", file=sys.stderr)
        if args.reuse_outputs and impl.output.exists():
            run_info = {
                "convert_seconds": None,
                "convert_stdout": "",
                "convert_stderr": "reused existing output",
                "validate_seconds": None,
                "validate_stdout": "",
                "validate_stderr": "skipped by --reuse-outputs",
            }
        else:
            run_info = convert_and_validate(impl, args.input, args.extra_convert_arg)
        footer = row_group_bboxes(impl.output)
        footers[impl.label] = footer
        results["implementations"][impl.label] = {
            **run_info,
            "binary": str(impl.bin),
            "summary": summarize_footer(impl.output, footer),
        }

    extent = global_extent(list(footers.values()))
    queries = make_queries(extent, query_fracs, args.query_count, args.seed)
    results["query_extent"] = extent

    for impl in (baseline, candidate):
        results["implementations"][impl.label]["queries"] = analyze_queries(
            footers[impl.label], queries, scopes, coalesce_gaps
        )

    add_comparison(results, baseline.label, candidate.label)

    json_text = json.dumps(results, indent=2, sort_keys=True)
    markdown_text = render_markdown(results, baseline.label, candidate.label)

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json_text + "\n")
    if args.markdown_out:
        args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_out.write_text(markdown_text + "\n")

    print(markdown_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
