#!/usr/bin/env python3
"""Map every acquisition policy, writer, formula and validator before repair."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "references/acquisition.md",
    "references/model-intent.md",
    "references/runtime-core.md",
    "references/validation.md",
    "scripts/lib/acquisition_policy.mjs",
    "scripts/lib/case_compiler.mjs",
    "scripts/lib/solver.mjs",
    "scripts/lib/row_plan.mjs",
    "scripts/build_dynamic_model.mjs",
    "scripts/verify/finance_proof.py",
    "scripts/verify/workbook_semantic_oracle.py",
    "scripts/verify/validate_dynamic_model.py",
    "scripts/run_equation_graph_tests.mjs",
    "scripts/verify/run_finance_proof_mutations.py",
]
TERMS = [
    "transaction_enterprise_value",
    "transaction value",
    "acquisition_debt",
    "acquisition debt",
    "purchase consideration",
    "consideration",
    "debt proceeds",
    "financing proceeds",
    "direct transaction cash",
    "acquisition cash",
    "target_ebitda",
    "target revenue",
    "close_month",
    "close year",
]


def git(*args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True, check=False)
    return completed.stdout


def contexts(path: str) -> list[dict[str, Any]]:
    target = ROOT / path
    if not target.is_file():
        return []
    lines = target.read_text("utf-8", errors="ignore").splitlines()
    hits = []
    seen = set()
    for number, line in enumerate(lines, 1):
        if not any(term.casefold() in line.casefold() for term in TERMS):
            continue
        start = max(1, number - 12)
        end = min(len(lines), number + 12)
        key = (start, end)
        if key in seen:
            continue
        seen.add(key)
        excerpt = "\n".join(f"{index:05d}: {lines[index - 1]}" for index in range(start, end + 1))
        hits.append({"line": number, "start": start, "end": end, "excerpt": excerpt})
    return hits


def function_spans(path: str) -> list[dict[str, Any]]:
    target = ROOT / path
    if not target.is_file():
        return []
    text = target.read_text("utf-8", errors="ignore")
    result = []
    if target.suffix == ".py":
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or not hasattr(node, "end_lineno"):
                continue
            body = "\n".join(text.splitlines()[node.lineno - 1:node.end_lineno])
            if "acquisition" in body.casefold() or "transaction" in body.casefold():
                result.append({"name": node.name, "start": node.lineno, "end": node.end_lineno, "sha256": hashlib.sha256(body.encode()).hexdigest(), "body": body})
        return result
    pattern = re.compile(r"(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{")
    for match in pattern.finditer(text):
        depth = 0
        end = None
        quote = None
        escaped = False
        for index in range(match.end() - 1, len(text)):
            char = text[index]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
                continue
            if char in {"'", '"', '`'}:
                quote = char
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        if end is None:
            continue
        body = text[match.start():end]
        if "acquisition" not in body.casefold() and "transaction" not in body.casefold():
            continue
        result.append({
            "name": match.group(1),
            "start": text.count("\n", 0, match.start()) + 1,
            "end": text.count("\n", 0, end) + 1,
            "sha256": hashlib.sha256(body.encode()).hexdigest(),
            "body": body,
        })
    return result


def zero_sites(path: str) -> list[dict[str, Any]]:
    target = ROOT / path
    if not target.is_file():
        return []
    lines = target.read_text("utf-8", errors="ignore").splitlines()
    result = []
    for number, line in enumerate(lines, 1):
        window = "\n".join(lines[max(0, number - 8):min(len(lines), number + 7)])
        lower = window.casefold()
        if "acquisition" not in lower and "transaction" not in lower:
            continue
        if not re.search(r"(?:\b0\b|,0\)|:\s*0\b|=>\s*0\b)", line):
            continue
        role = "other_zero"
        if "proceeds" in lower and "debt" in lower:
            role = "debt_proceeds_zero"
        elif "consideration" in lower or "direct" in lower and "cash" in lower:
            role = "consideration_or_direct_cash_zero"
        elif "operating profit" in lower or "cost of sales" in lower:
            role = "presentation_zero"
        result.append({"line": number, "role": role, "text": line, "context": window})
    return result


def historical_candidates() -> list[dict[str, Any]]:
    raw = git("log", "--all", "--format=%H%x1f%aI%x1f%s", "--", *FILES)
    commits = []
    seen = set()
    for line in raw.splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) != 3 or parts[0] in seen:
            continue
        seen.add(parts[0])
        commits.append({"sha": parts[0], "date": parts[1], "title": parts[2]})
    result = []
    for entry in commits[:300]:
        pieces = []
        for path in FILES:
            completed = subprocess.run(["git", "show", f"{entry['sha']}:{path}"], cwd=ROOT, text=True, capture_output=True, check=False)
            if completed.returncode == 0:
                pieces.append(completed.stdout)
        text = "\n".join(pieces)
        flags = {
            "zero_direct_cash": bool(re.search(r"zero direct transaction cash-flow effect|zero direct cash", text, re.I)),
            "consideration": bool(re.search(r"purchase consideration|transaction value.{0,80}consideration|acquisition consideration", text, re.I | re.S)),
            "debt_proceeds": bool(re.search(r"acquisition debt.{0,80}proceeds|financing proceeds", text, re.I | re.S)),
            "solver_cash": bool(re.search(r"cash_from_investing|cashFromInvesting", text)) and bool(re.search(r"acquisition|transaction", text, re.I)),
        }
        score = 4 * flags["consideration"] + 4 * flags["debt_proceeds"] + 2 * flags["solver_cash"] - 5 * flags["zero_direct_cash"]
        result.append({**entry, "flags": flags, "score": score})
    return sorted(result, key=lambda item: (-item["score"], item["date"]))


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Excel Inflow acquisition execution map",
        "",
        f"Report SHA-256: `{report['report_sha256']}`",
        "",
        "## Current writers and validators",
        "",
    ]
    for file in report["files"]:
        lines += [f"### `{file['path']}`", ""]
        lines.append(f"- Acquisition-aware functions: {len(file['functions'])}")
        lines.append(f"- Acquisition-context zero sites: {len(file['zero_sites'])}")
        for site in file["zero_sites"]:
            lines.append(f"  - line {site['line']} `{site['role']}` — `{site['text'].strip()}`")
        lines.append("")
    lines += ["## Highest-scoring historical funded candidates", "", "| Commit | Date | Score | Consideration | Debt proceeds | Solver cash | Zero direct cash | Title |", "|---|---|---:|---|---|---|---|---|"]
    for item in report["historical_candidates"][:30]:
        flags = item["flags"]
        lines.append(f"| `{item['sha'][:12]}` | {item['date']} | {item['score']} | {flags['consideration']} | {flags['debt_proceeds']} | {flags['solver_cash']} | {flags['zero_direct_cash']} | {item['title']} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "schema_version": "excel-inflow-acquisition-execution-map/1.0",
        "files": [
            {"path": path, "contexts": contexts(path), "functions": function_spans(path), "zero_sites": zero_sites(path)}
            for path in FILES
        ],
        "historical_candidates": historical_candidates(),
    }
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "acquisition-execution-map.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    (output / "acquisition-execution-map.md").write_text(markdown(report), "utf-8")
    print(json.dumps({"status": "PASS", "files": len(report["files"]), "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
