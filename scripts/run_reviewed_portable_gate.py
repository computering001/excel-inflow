#!/usr/bin/env python3
"""Run the self-contained reviewed repair matrix with no silent skips."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str], test_id: str, output: Path, timeout: int = 900) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        check=False,
    )
    record = {
        "id": test_id,
        "command": command,
        "exit_code": completed.returncode,
        "duration_ms": round((time.monotonic() - started) * 1000, 3),
        "status": "PASS" if completed.returncode == 0 else "FAIL",
        "stdout": completed.stdout[-12000:],
        "stderr": completed.stderr[-12000:],
    }
    (output / f"{test_id}.json").write_text(json.dumps(record, indent=2) + "\n", "utf-8")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--soffice", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)

    # Portability and custody are test preconditions, not warnings.
    violations = []
    for path in sorted((ROOT / "scripts").rglob("*")):
        if path.is_file() and path.suffix in {".py", ".mjs", ".js", ".json"}:
            if re.search(r"/Users/|[A-Za-z]:\\\\Users\\\\", path.read_text("utf-8")):
                violations.append(str(path.relative_to(ROOT)))
    for name in ("standard-maximal-v2.json", "standard-net-cash-v2.json"):
        target = ROOT / "parity-fixtures" / name
        if not target.is_file():
            violations.append(f"missing:{target.relative_to(ROOT)}")
        else:
            json.loads(target.read_text("utf-8"))
    if violations:
        raise SystemExit("Portable custody failed: " + ", ".join(violations))

    python_tests: list[tuple[str, list[str]]] = [
        ("source-arithmetic", [args.python, "scripts/run_source_arithmetic_tests.py"]),
        ("broker-native-eligibility", [args.python, "scripts/run_broker_native_eligibility_tests.py"]),
        ("broker-demand-selection", [args.python, "scripts/run_broker_demand_selection_tests.py"]),
        ("broker-selected-cell", [args.python, "scripts/run_broker_selected_cell_recovery_tests.py"]),
        ("broker-degraded-close", [args.python, "scripts/run_broker_degraded_close_tests.py"]),
        ("broker-house-exclusion", [args.python, "scripts/run_broker_house_exclusion_tests.py"]),
        ("broker-physical-reconciliation", [args.python, "scripts/run_broker_physical_reconciliation_tests.py"]),
        ("broker-period-headers", [args.python, "scripts/run_broker_period_header_tests.py"]),
        ("broker-table-engine", [args.python, "scripts/run_broker_table_engine_tests.py"]),
        ("broker-work-graph", [args.python, "scripts/run_broker_work_graph_tests.py"]),
        ("internal-fixed-point", [args.python, "scripts/run_internal_fixed_point_tests.py"]),
        ("dcs-evidence", [args.python, "scripts/run_dcs_evidence_tests.py", "--out", str(output / "dcs-evidence")]),
        ("dcs-pipeline", [args.python, "scripts/run_dcs_pipeline_tests.py", "--out", str(output / "dcs-pipeline")]),
        ("acquisition-workbook", [args.python, "scripts/run_acquisition_workbook_tests.py"]),
    ]
    node_tests: list[tuple[str, list[str]]] = [
        ("reviewed-contracts", ["node", "scripts/run_reviewed_repair_contract_tests.mjs"]),
        ("acquisition-solver", ["node", "scripts/run_acquisition_solver_case_tests.mjs"]),
        ("carrier-identity", ["node", "scripts/run_carrier_identity_tests.mjs"]),
        ("equation-graph", ["node", "scripts/run_equation_graph_tests.mjs"]),
        ("instrument-period-state", ["node", "scripts/run_instrument_period_state_tests.mjs"]),
        ("opening-debt", ["node", "scripts/run_opening_debt_reconciliation_tests.mjs"]),
        ("product-constitution", ["node", "scripts/run_product_constitution_tests.mjs"]),
        ("delivery-constitution", ["node", "scripts/run_delivery_constitution_tests.mjs"]),
        ("workflow-state", ["node", "scripts/run_workflow_state_tests.mjs"]),
        ("user-flow", ["node", "scripts/run_user_flow_tests.mjs"]),
        ("forecast-behavior", ["node", "scripts/run_forecast_behavior_tests.mjs"]),
        ("forecast-topology", ["node", "scripts/run_forecast_topology_tests.mjs"]),
        ("case-equivalence", ["node", "scripts/run_case_compiler_equivalence.mjs", "parity-fixtures"]),
        ("degraded-delivery", ["node", "scripts/run_degraded_broker_delivery_tests.mjs", "parity-fixtures"]),
        (
            "stage4-resume",
            [
                "node", "scripts/run_stage4_checkpoint_tests.mjs",
                "--cases", "parity-fixtures",
                "--python", args.python,
                "--soffice", args.soffice,
            ],
        ),
    ]

    # Integration scripts may add focused headline and telemetry tests. They are
    # mandatory when present in the final tree and are never silently ignored.
    for path in sorted((ROOT / "scripts").glob("*headline*test*.mjs")):
        node_tests.append((f"focused-{path.stem}", ["node", str(path.relative_to(ROOT))]))
    for path in sorted((ROOT / "scripts").glob("*telemetry*test*.mjs")):
        node_tests.append((f"focused-{path.stem}", ["node", str(path.relative_to(ROOT))]))

    required_paths = {
        command[1]
        for _, command in python_tests + node_tests
        if len(command) > 1 and command[1].startswith("scripts/")
    }
    missing = sorted(path for path in required_paths if not (ROOT / path).is_file())
    if missing:
        raise SystemExit("Required test entrypoints missing: " + ", ".join(missing))

    records = []
    for test_id, command in python_tests + node_tests:
        records.append(run(command, test_id, output))
    failures = [record for record in records if record["status"] != "PASS"]
    report = {
        "schema_version": "reviewed-portable-gate/1.0",
        "status": "PASS" if not failures else "FAIL",
        "selected_test_count": len(records),
        "pass_count": len(records) - len(failures),
        "fail_count": len(failures),
        "silently_skipped_count": 0,
        "external_certification_requirements": [
            "installed Rogo model-host usable-broker canary",
            "native Excel off/on/off/on restoration",
            "human visual review",
            "joined user-submission-to-download performance cohort",
        ],
        "records": records,
    }
    (output / "reviewed-portable-gate.json").write_text(
        json.dumps(report, indent=2) + "\n", "utf-8"
    )
    print(json.dumps({key: report[key] for key in (
        "status", "selected_test_count", "pass_count", "fail_count", "silently_skipped_count"
    )}))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
