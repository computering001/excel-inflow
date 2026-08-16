#!/usr/bin/env python3
"""Find or build one portable clean fixture accepted by the raw-input canary."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_HINTS = {
    "entity_name", "company_name", "historical_periods", "forecast_periods",
    "reported_gross_debt", "reported_cash", "reporting_currency", "units",
}
EXCLUDED_NAMES = {
    "release-manifest.json", "deployment-profile.json", "development-test-registry.json",
}


def nested_keys(value: Any) -> set[str]:
    result: set[str] = set()
    if isinstance(value, dict):
        for key, entry in value.items():
            result.add(str(key))
            result.update(nested_keys(entry))
    elif isinstance(value, list):
        for entry in value[:100]:
            result.update(nested_keys(entry))
    return result


def candidates() -> list[tuple[int, Path]]:
    result = []
    for path in ROOT.rglob("*.json"):
        if ".git" in path.parts or "node_modules" in path.parts or "audit/generated" in path.as_posix():
            continue
        if path.name.endswith(".schema.json") or path.name in EXCLUDED_NAMES or path.stat().st_size > 5_000_000:
            continue
        try:
            value = json.loads(path.read_text("utf-8"))
        except Exception:
            continue
        keys = nested_keys(value)
        score = len(keys & REQUIRED_HINTS)
        schema_version = str(value.get("schema_version") if isinstance(value, dict) else "")
        if "model-case" in schema_version or "evidence-run" in schema_version:
            score += 8
        if "flow-fixtures" in path.as_posix():
            score += 3
        if score >= 3:
            result.append((score, path))
    return sorted(result, key=lambda item: (-item[0], item[1].as_posix()))


def run_canary(candidate: Path, python: str, soffice: str, output: Path, timeout: int) -> dict[str, Any]:
    command = [
        shutil.which("node") or "node",
        str(ROOT / "scripts" / "run_raw_input_local_semantic_canary.mjs"),
        str(candidate), python, soffice,
        "--broker-state", "explicit_skip",
        "--dcs-balance-basis", "native_principal",
    ]
    started = time.monotonic()
    try:
        completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False, timeout=timeout, env={**os.environ, "EXCEL_INFLOW_TEST_PYTHON": python})
        receipt = None
        if completed.returncode == 0:
            try:
                receipt = json.loads(completed.stdout)
            except Exception:
                receipt = None
        return {
            "candidate": str(candidate.relative_to(ROOT)),
            "status": "PASS" if completed.returncode == 0 and isinstance(receipt, dict) and receipt.get("status") == "PASS" else "FAIL",
            "exit_code": completed.returncode,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": completed.stdout[-40000:],
            "stderr": completed.stderr[-40000:],
            "receipt": receipt,
        }
    except subprocess.TimeoutExpired as error:
        return {"candidate": str(candidate.relative_to(ROOT)), "status": "TIMEOUT", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000, 3), "stdout": error.stdout[-40000:] if isinstance(error.stdout, str) else "", "stderr": error.stderr[-40000:] if isinstance(error.stderr, str) else "", "receipt": None}


def generated_candidates(output: Path) -> list[Path]:
    generated = []
    script = ROOT / "scripts" / "compile_synthetic_cohort.mjs"
    if not script.is_file():
        return generated
    target = output / "synthetic-cohort"
    target.mkdir(parents=True, exist_ok=True)
    commands = [
        [shutil.which("node") or "node", str(script), "--out", str(target)],
        [shutil.which("node") or "node", str(script), str(target)],
    ]
    for command in commands:
        completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False, timeout=300)
        if completed.returncode == 0:
            generated.extend(path for path in target.rglob("*.json") if path.is_file() and not path.name.endswith(".schema.json"))
            if generated:
                break
    return sorted(set(generated))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--soffice", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--max-candidates", type=int, default=30)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    attempts = []
    scored = candidates()
    paths = [path for _score, path in scored[:args.max_candidates]]
    paths += [path for path in generated_candidates(output) if path not in paths]
    selected = None
    selected_receipt = None
    for candidate in paths[:args.max_candidates]:
        attempt = run_canary(candidate, args.python, args.soffice, output, args.timeout)
        attempts.append(attempt)
        if attempt["status"] == "PASS":
            selected = candidate
            selected_receipt = attempt["receipt"]
            break
    report = {
        "schema_version": "portable-canary-fixture-discovery/1.0",
        "status": "PASS" if selected else "FAIL",
        "selected_fixture": str(selected.resolve()) if selected else None,
        "selected_fixture_repository_path": str(selected.relative_to(ROOT)) if selected and ROOT in selected.resolve().parents else None,
        "selected_receipt": selected_receipt,
        "attempts": attempts,
    }
    (output / "portable-canary-fixture-discovery.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    if selected:
        (output / "selected-fixture-path.txt").write_text(str(selected.resolve()) + "\n", "utf-8")
    print(json.dumps({"status": report["status"], "attempts": len(attempts), "selected": report["selected_fixture_repository_path"]}, sort_keys=True))
    return 0 if selected else 1


if __name__ == "__main__":
    raise SystemExit(main())
