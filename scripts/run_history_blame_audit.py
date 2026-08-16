#!/usr/bin/env python3
"""History/blame audit for the Excel Inflow repair.

Locates the smallest introducing ranges for the main economic, broker, runtime,
test and release seams and searches prior source for reusable implementations.
Read-only: no checkout, reset, revert or source mutation is performed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

TARGETS = [
    {
        "id": "broker_blanket_unselected_house",
        "file": "scripts/extract_broker_evidence.py",
        "needles": ["archive-only regardless of whether its", "unselected_house = descriptor.get"],
    },
    {
        "id": "broker_date_first_policy",
        "file": "scripts/extract_broker_evidence.py",
        "needles": ["latest_supplied_house_then_zero_authority", "vision_house_id = str(sorted"],
    },
    {
        "id": "filing_subtotal_label_gate",
        "file": "scripts/extract_filing_statements.py",
        "needles": ["def is_subtotal_label", "if row.get(\"is_subtotal\")"],
    },
    {
        "id": "lumpy_historical_average",
        "file": "scripts/lib/forecast_candidate_compiler.mjs",
        "needles": ["three-year historical average used for a lumpy", "behavior === \"lumpy_discretionary_flow\""],
    },
    {
        "id": "acquisition_zero_direct_cash",
        "file": "references/acquisition.md",
        "needles": ["zero direct transaction cash-flow effect"],
    },
    {
        "id": "acquisition_validation_consideration",
        "file": "references/validation.md",
        "needles": ["transaction value is used once as consideration"],
    },
    {
        "id": "simulated_model_host_canary",
        "file": "scripts/run_raw_input_black_box_canary.mjs",
        "needles": ["Simulate the installed model-host semantic response", "zeroCrosswalk.coverage_ledger"],
    },
    {
        "id": "run_carrier_v2",
        "file": "scripts/lib/run_carrier.mjs",
        "needles": ["debt-model-run-carrier/2.0"],
    },
    {
        "id": "universal_matrix_registry",
        "file": "assets/development-test-registry.json",
        "needles": ["universal-broker-delivery-matrix"],
    },
]

ACQUISITION_FILES = [
    "references/acquisition.md",
    "references/validation.md",
    "scripts/lib/acquisition_policy.mjs",
    "scripts/lib/case_compiler.mjs",
    "scripts/lib/solver.mjs",
    "scripts/lib/row_plan.mjs",
    "scripts/build_dynamic_model.mjs",
    "scripts/verify/finance_proof.py",
]


def run(args: list[str], *, check: bool = False) -> str:
    completed = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=False)
    if check and completed.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{completed.stderr}")
    return completed.stdout


def commits_for_path(path: str) -> list[dict[str, Any]]:
    raw = run(["git", "log", "--follow", "--format=%H%x1f%aI%x1f%s", "--", path])
    result = []
    for line in raw.splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) == 3:
            result.append({"sha": parts[0], "date": parts[1], "title": parts[2]})
    return result


def content_at(commit: str, path: str) -> str | None:
    completed = subprocess.run(["git", "show", f"{commit}:{path}"], cwd=ROOT, text=True, capture_output=True, check=False)
    return completed.stdout if completed.returncode == 0 else None


def first_appearance(path: str, needle: str) -> dict[str, Any] | None:
    history = list(reversed(commits_for_path(path)))
    previous = False
    previous_sha = None
    for entry in history:
        text = content_at(entry["sha"], path)
        present = text is not None and needle in text
        if present and not previous:
            return {**entry, "previous_sha": previous_sha, "needle": needle}
        previous = present
        previous_sha = entry["sha"]
    return None


def line_numbers(path: Path, needle: str) -> list[int]:
    return [index for index, line in enumerate(path.read_text("utf-8", errors="ignore").splitlines(), 1) if needle in line]


def blame(path: str, line: int) -> dict[str, Any] | None:
    raw = run(["git", "blame", "--line-porcelain", f"-L{line},{line}", "--", path])
    if not raw:
        return None
    lines = raw.splitlines()
    first = lines[0].split()
    result: dict[str, Any] = {"sha": first[0] if first else None, "line": line}
    for item in lines[1:]:
        if item.startswith("author-time "):
            result["author_time"] = int(item.split(" ", 1)[1])
        elif item.startswith("summary "):
            result["summary"] = item.split(" ", 1)[1]
        elif item.startswith("filename "):
            result["filename"] = item.split(" ", 1)[1]
    return result


def target_audit(target: dict[str, Any]) -> dict[str, Any]:
    path = ROOT / target["file"]
    current = path.read_text("utf-8", errors="ignore") if path.is_file() else ""
    needles = []
    for needle in target["needles"]:
        lines = line_numbers(path, needle) if path.is_file() else []
        needles.append({
            "needle": needle,
            "present": needle in current,
            "lines": lines,
            "blame": [blame(target["file"], line) for line in lines],
            "first_appearance": first_appearance(target["file"], needle),
            "pickaxe": [
                line for line in run([
                    "git", "log", "--all", "--format=%H%x1f%aI%x1f%s", f"-S{needle}", "--", target["file"]
                ]).splitlines()[:50]
            ],
        })
    return {"id": target["id"], "file": target["file"], "path_history": commits_for_path(target["file"]), "needles": needles}


def acquisition_history() -> dict[str, Any]:
    commits = []
    seen = set()
    raw = run(["git", "log", "--all", "--format=%H%x1f%aI%x1f%s", "--", *ACQUISITION_FILES])
    for line in raw.splitlines():
        sha, date, title = (line.split("\x1f", 2) + ["", ""])[:3]
        if sha and sha not in seen:
            seen.add(sha)
            commits.append({"sha": sha, "date": date, "title": title})
    scored = []
    patterns = {
        "zero_direct_cash": re.compile(r"zero direct transaction cash-flow effect|zero direct cash", re.I),
        "consideration": re.compile(r"purchase consideration|transaction value.*consideration|acquisition consideration", re.I),
        "debt_proceeds": re.compile(r"acquisition debt.*proceeds|financing proceeds", re.I),
        "equity_residual": re.compile(r"equity residual|equity funding", re.I),
        "sources_uses": re.compile(r"sources and uses|sources-and-uses", re.I),
    }
    for entry in commits[:250]:
        joined = []
        available = []
        for path in ACQUISITION_FILES:
            text = content_at(entry["sha"], path)
            if text is not None:
                available.append(path)
                joined.append(text)
        body = "\n".join(joined)
        flags = {key: bool(pattern.search(body)) for key, pattern in patterns.items()}
        score = 3 * flags["consideration"] + 3 * flags["debt_proceeds"] - 4 * flags["zero_direct_cash"]
        scored.append({**entry, "available_files": available, "flags": flags, "funded_score": score})
    return {
        "files": ACQUISITION_FILES,
        "candidate_versions": sorted(scored, key=lambda item: (-item["funded_score"], item["date"]), reverse=False)[:100],
        "best_funded_candidates": sorted(scored, key=lambda item: (-item["funded_score"], item["date"]), reverse=False)[:20],
    }


def sunday_comparison() -> dict[str, Any]:
    base = "2853573e98d7400e04f47f3e2bb9cb16ad982f94"
    head = "ee5ae55cb8a0ce2f2d1d1b71810fc405c11416dd"
    summary = run(["git", "diff", "--stat", base, head])
    numstat = run(["git", "diff", "--numstat", base, head])
    rows = []
    for line in numstat.splitlines():
        parts = line.split("\t", 2)
        if len(parts) == 3:
            add, delete, path = parts
            rows.append({"path": path, "additions": int(add) if add.isdigit() else None, "deletions": int(delete) if delete.isdigit() else None})
    commits = []
    for line in run(["git", "log", "--reverse", "--format=%H%x1f%aI%x1f%s", f"{base}..{head}"]).splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) == 3:
            commits.append({"sha": parts[0], "date": parts[1], "title": parts[2]})
    return {
        "base": base,
        "head": head,
        "commit_count": len(commits),
        "commits": commits,
        "diffstat": summary,
        "files": rows,
        "largest_files": sorted(rows, key=lambda item: -((item["additions"] or 0) + (item["deletions"] or 0)))[:80],
    }


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Excel Inflow history and blame audit",
        "",
        f"- Source commit: `{report['source_identity']['commit']}`",
        f"- Source tree: `{report['source_identity']['tree']}`",
        f"- Sunday-to-current commits: {report['sunday_comparison']['commit_count']}",
        f"- Report SHA-256: `{report['report_sha256']}`",
        "",
        "## Defect histories",
        "",
    ]
    for target in report["targets"]:
        lines += [f"### `{target['id']}` — `{target['file']}`", ""]
        for item in target["needles"]:
            first = item.get("first_appearance") or {}
            lines.append(
                f"- `{item['needle']}`: present={item['present']}; lines={item['lines']}; "
                f"first appearance=`{first.get('sha')}` {first.get('date', '')} {first.get('title', '')}"
            )
            for blamed in item.get("blame", []):
                if blamed:
                    lines.append(f"  - blame `{blamed.get('sha')}` — {blamed.get('summary')}")
        lines.append("")
    lines += ["## Acquisition historical candidates", "", "| Commit | Date | Score | Zero cash | Consideration | Debt proceeds | Title |", "|---|---|---:|---|---|---|---|"]
    for item in report["acquisition_history"]["best_funded_candidates"]:
        flags = item["flags"]
        lines.append(
            f"| `{item['sha'][:12]}` | {item['date']} | {item['funded_score']} | {flags['zero_direct_cash']} | "
            f"{flags['consideration']} | {flags['debt_proceeds']} | {item['title']} |"
        )
    lines += ["", "## Sunday-to-current commits", ""]
    for item in report["sunday_comparison"]["commits"]:
        lines.append(f"- `{item['sha']}` — {item['date']} — {item['title']}")
    lines += ["", "## Largest Sunday-to-current file changes", ""]
    for item in report["sunday_comparison"]["largest_files"]:
        lines.append(f"- `{item['path']}` — +{item['additions']} / -{item['deletions']}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-tree", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "schema_version": "excel-inflow-history-blame-audit/1.0",
        "source_identity": {"commit": args.source_commit, "tree": args.source_tree},
        "targets": [target_audit(target) for target in TARGETS],
        "acquisition_history": acquisition_history(),
        "sunday_comparison": sunday_comparison(),
    }
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "history-blame-audit.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    (output / "history-blame-audit.md").write_text(markdown(report), "utf-8")
    print(json.dumps({"status": "PASS", "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
