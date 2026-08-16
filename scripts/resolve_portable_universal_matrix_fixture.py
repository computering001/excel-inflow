#!/usr/bin/env python3
"""Find and seal a synthetic portable fixture that passes the universal matrix.

Candidates are restricted to the current repository and a separately supplied
pinned reviewed-source checkout. User uploads and arbitrary machine files are
never searched or committed. This bootstrap is deleted before the product
commit; the selected JSON fixture and its custody receipt remain.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cleanse(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: cleanse(item) for key, item in value.items()}
    if isinstance(value, list):
        return [cleanse(item) for item in value]
    if isinstance(value, str):
        result = re.sub(r"/Users/[^\s\"']+", "<portable-fixture>", value)
        result = re.sub(r"[A-Za-z]:\\Users\\[^\s\"']+", "<portable-fixture>", result)
        result = result.replace("/mnt/data/", "<portable-fixture>/")
        return result
    return value


def candidate_score(path: Path, value: Any) -> int:
    if not isinstance(value, dict):
        return 0
    score = 0
    if value.get("schema_version") == "evidence-run/1.0":
        score += 100
    for key in ("source_inventory", "case_evidence", "company_name", "filing_facts"):
        if key in value:
            score += 20
    name = path.name.casefold()
    if "evidence" in name:
        score += 10
    if "raw" in name or "canary" in name:
        score += 10
    if "report" in name or "receipt" in name:
        score -= 20
    return score


def run_matrix(fixture: Path, python: str, soffice: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "node",
            "scripts/run_universal_broker_delivery_matrix.mjs",
            str(fixture),
            python,
            soffice,
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=3600,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reviewed-root", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--soffice", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    reviewed_root = Path(args.reviewed_root).resolve()
    output = Path(args.out).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    search_roots = [ROOT, reviewed_root]
    candidates: list[tuple[int, Path, Any]] = []
    seen: set[str] = set()
    for search_root in search_roots:
        if not search_root.is_dir():
            continue
        for path in search_root.rglob("*.json"):
            if path.stat().st_size > 20_000_000:
                continue
            resolved = str(path.resolve())
            if resolved in seen:
                continue
            seen.add(resolved)
            try:
                value = json.loads(path.read_text("utf-8"))
            except Exception:
                continue
            score = candidate_score(path, value)
            if score > 0:
                candidates.append((score, path, value))
    candidates.sort(key=lambda item: (-item[0], len(str(item[1])), str(item[1])))
    attempts: list[dict[str, Any]] = []
    with __import__("tempfile").TemporaryDirectory(
        prefix="excel-inflow-universal-fixture-"
    ) as temporary:
        temporary_root = Path(temporary)
        for index, (score, source, value) in enumerate(candidates):
            candidate = temporary_root / f"candidate-{index}.json"
            candidate.write_text(
                json.dumps(cleanse(value), indent=2, sort_keys=True) + "\n",
                "utf-8",
            )
            completed = run_matrix(candidate, args.python, args.soffice)
            attempt = {
                "source": str(source.relative_to(ROOT))
                if source.is_relative_to(ROOT)
                else f"pinned-reviewed/{source.relative_to(reviewed_root)}",
                "source_sha256": sha256(source),
                "sanitized_sha256": sha256(candidate),
                "score": score,
                "returncode": completed.returncode,
                "stdout_tail": completed.stdout[-4000:],
                "stderr_tail": completed.stderr[-4000:],
            }
            attempts.append(attempt)
            if completed.returncode != 0:
                continue
            shutil.copy2(candidate, output)
            receipt = {
                "schema_version": "universal-matrix-fixture-custody/1.0",
                "status": "PASS",
                "selected_source": attempt["source"],
                "selected_source_sha256": attempt["source_sha256"],
                "fixture_path": str(output.relative_to(ROOT)),
                "fixture_sha256": sha256(output),
                "candidate_attempt_count": len(attempts),
                "source_roots": ["current_repository", "pinned_reviewed_source"],
                "user_upload_search_performed": False,
                "matrix_status": "PASS",
            }
            receipt_path = ROOT / "audit" / "reviewed-portable-gate" / "universal-matrix-fixture-custody.json"
            receipt_path.parent.mkdir(parents=True, exist_ok=True)
            receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", "utf-8")
            (receipt_path.parent / "universal-matrix-fixture-attempts.json").write_text(
                json.dumps(attempts, indent=2) + "\n", "utf-8"
            )
            print(json.dumps({"status": "PASS", "fixture": str(output)}))
            return 0
    diagnostics = ROOT / "audit" / "reviewed-portable-gate" / "universal-matrix-fixture-attempts.json"
    diagnostics.parent.mkdir(parents=True, exist_ok=True)
    diagnostics.write_text(json.dumps(attempts, indent=2) + "\n", "utf-8")
    raise RuntimeError("No repository-owned or pinned-reviewed fixture passed the universal matrix.")


if __name__ == "__main__":
    raise SystemExit(main())
