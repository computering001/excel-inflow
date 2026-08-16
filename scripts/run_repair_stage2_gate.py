#!/usr/bin/env python3
"""Independent gate for Excel Inflow repair stage 2."""
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
    ("node", "scripts/run_workflow_state_pairing_tests.mjs"),
    ("node", "scripts/run_statement_role_equivalence_tests.mjs"),
    ("node", "scripts/run_run_carrier_source_identity_tests.mjs"),
    ("node", "scripts/run_user_visible_runtime_trace_tests.mjs"),
    ("node", "scripts/run_workflow_state_tests.mjs"),
    ("node", "scripts/run_user_flow_tests.mjs"),
    ("node", "scripts/run_controller_exit_inventory_tests.mjs"),
    ("node", "scripts/run_statement_classifier_tests.mjs"),
    ("node", "scripts/run_forecast_topology_tests.mjs"),
    ("node", "scripts/run_product_constitution_tests.mjs"),
    ("node", "scripts/run_delivery_constitution_tests.mjs"),
    ("node", "scripts/run_run_constitution_graph_tests.mjs"),
    ("node", "scripts/run_test_registry_interface_tests.mjs"),
]


def run(command: list[str], timeout: int, env: dict[str, str]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False, timeout=timeout, env=env)
        return {"command": command, "status": "PASS" if completed.returncode == 0 else "FAIL", "exit_code": completed.returncode, "duration_ms": round((time.monotonic() - started) * 1000, 3), "stdout": completed.stdout[-100000:], "stderr": completed.stderr[-100000:]}
    except subprocess.TimeoutExpired as error:
        return {"command": command, "status": "TIMEOUT", "exit_code": None, "duration_ms": round((time.monotonic() - started) * 1000, 3), "stdout": error.stdout[-100000:] if isinstance(error.stdout, str) else "", "stderr": error.stderr[-100000:] if isinstance(error.stderr, str) else ""}
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
    env = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
        "EXCEL_INFLOW_TEST_PYTHON": sys.executable,
        "EXCEL_INFLOW_SOURCE_COMMIT": "a" * 64,
        "EXCEL_INFLOW_SOURCE_TREE": "b" * 64,
    }
    results = [{"id": "python-compileall", **run([sys.executable, "-m", "compileall", "-q", str(ROOT / "scripts")], 300, env)}]
    for runtime, script in TESTS:
        path = ROOT / script
        if not path.is_file():
            results.append({"id": script, "status": "MISSING", "command": [], "exit_code": None, "duration_ms": 0, "stdout": "", "stderr": "script missing"})
            continue
        results.append({"id": path.name, **run([sys.executable if runtime == "python" else node, str(path)], args.timeout, env)})
    # Canary source must be honest even though installed-host evidence is external.
    canary_source = (ROOT / "scripts" / "run_raw_input_local_semantic_canary.mjs").read_text("utf-8")
    honesty = (
        'installed_host_semantic_seam_exercised: false' in canary_source
        and 'installed_host_certification_claim: false' in canary_source
        and 'test_authored_fixture' in canary_source
    )
    results.append({"id": "canary-honesty-static", "status": "PASS" if honesty else "FAIL", "command": [], "exit_code": 0 if honesty else 1, "duration_ms": 0, "stdout": "", "stderr": "" if honesty else "raw canary still overclaims installed-host coverage"})
    status = "PASS" if all(item["status"] == "PASS" for item in results) else "FAIL"
    report = {"schema_version": "excel-inflow-repair-stage2-gate/1.0", "status": status, "results": results, "counts": {key: sum(item["status"] == key for item in results) for key in ["PASS", "FAIL", "TIMEOUT", "ERROR", "MISSING"]}}
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "stage2-gate.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    with (output / "stage2-gate.md").open("w", encoding="utf-8") as handle:
        handle.write(f"# Excel Inflow repair stage 2 gate\n\nStatus: **{status}**  \nReport SHA-256: `{report['report_sha256']}`\n\n")
        for item in results:
            handle.write(f"## {item['id']} — {item['status']}\n\n")
            if item["status"] != "PASS":
                handle.write("```text\n" + (item.get("stderr") or item.get("stdout") or "")[-12000:] + "\n```\n\n")
    print(json.dumps({"status": status, "counts": report["counts"], "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
