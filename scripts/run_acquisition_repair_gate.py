#!/usr/bin/env python3
"""Gate the funded-acquisition repair before it can be committed."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TESTS = [
    ("node", "scripts/run_funded_acquisition_policy_tests.mjs"),
    ("python", "scripts/run_funded_acquisition_source_tests.py"),
    ("node", "scripts/run_equation_graph_tests.mjs"),
    ("node", "scripts/run_forecast_behavior_tests.mjs"),
    ("node", "scripts/run_forecast_topology_tests.mjs"),
    ("node", "scripts/run_product_constitution_tests.mjs"),
    ("node", "scripts/run_delivery_constitution_tests.mjs"),
    ("node", "scripts/run_run_constitution_graph_tests.mjs"),
    ("node", "scripts/run_case_authorship_boundary_tests.mjs"),
    ("node", "scripts/run_opening_debt_reconciliation_tests.mjs"),
]


def run(command: list[str], timeout: int, env: dict[str, str]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False, timeout=timeout, env=env)
        return {"command": command, "status": "PASS" if completed.returncode == 0 else "FAIL", "exit_code": completed.returncode, "duration_ms": round((time.monotonic() - started) * 1000, 3), "stdout": completed.stdout[-120000:], "stderr": completed.stderr[-120000:]}
    except subprocess.TimeoutExpired as error:
        return {"command": command, "status": "TIMEOUT", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000, 3), "stdout": error.stdout[-120000:] if isinstance(error.stdout, str) else "", "stderr": error.stderr[-120000:] if isinstance(error.stderr, str) else ""}
    except Exception as error:
        return {"command": command, "status": "ERROR", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000, 3), "stdout": "", "stderr": repr(error)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    node = shutil.which("node") or "node"
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "EXCEL_INFLOW_TEST_PYTHON": sys.executable}
    results = [{"id": "python-compileall", **run([sys.executable, "-m", "compileall", "-q", str(ROOT / "scripts")], 300, env)}]
    for runtime, script in TESTS:
        path = ROOT / script
        if not path.is_file():
            results.append({"id": script, "status": "MISSING", "command": [], "exit_code": None, "duration_ms": 0, "stdout": "", "stderr": "script missing"})
            continue
        results.append({"id": path.name, **run([sys.executable if runtime == "python" else node, str(path)], args.timeout, env)})
    acquisition_reference = (ROOT / "references" / "acquisition.md").read_text("utf-8")
    validation_reference = (ROOT / "references" / "validation.md").read_text("utf-8")
    doctrine_ok = (
        "consideration cash flow" in acquisition_reference
        and "acquisition debt proceeds" in acquisition_reference
        and "zero direct transaction cash-flow effect" not in acquisition_reference
        and "transaction value is used once as consideration" in validation_reference
    )
    results.append({"id": "acquisition-doctrine-closure", "status": "PASS" if doctrine_ok else "FAIL", "command": [], "exit_code": 0 if doctrine_ok else 1, "duration_ms": 0, "stdout": "", "stderr": "" if doctrine_ok else "acquisition doctrine remains contradictory"})
    status = "PASS" if all(item["status"] == "PASS" for item in results) else "FAIL"
    report = {"schema_version": "excel-inflow-acquisition-repair-gate/1.0", "status": status, "results": results, "counts": {key: sum(item["status"] == key for item in results) for key in ["PASS", "FAIL", "TIMEOUT", "ERROR", "MISSING"]}}
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "acquisition-gate.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    with (output / "acquisition-gate.md").open("w", encoding="utf-8") as handle:
        handle.write(f"# Funded acquisition repair gate\n\nStatus: **{status}**  \nReport SHA-256: `{report['report_sha256']}`\n\n")
        for item in results:
            handle.write(f"## {item['id']} — {item['status']}\n\n")
            if item["status"] != "PASS":
                handle.write("```text\n" + (item.get("stderr") or item.get("stdout") or "")[-16000:] + "\n```\n\n")
    print(json.dumps({"status": status, "counts": report["counts"], "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
