#!/usr/bin/env python3
"""Idempotently finish the reviewed repair, or fail closed on an unknown seam.

The script may reapply only the pinned reviewed domain repairs and portable test
custody. It never edits expected economics, schemas to weaken validation, or
release certification. The bootstrap workflow deletes this file before the
product commit.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PYTHON = shutil.which("python3") or sys.executable
SOFFICE = shutil.which("soffice") or shutil.which("libreoffice")
PINNED_REVIEWED_COMMIT = "9edbbfe1596071c03813badee21b99d714affc23"
PATCHERS = (
    "repair_acquisition_integration.py",
    "repair_acquisition_plan_integration.py",
    "repair_broker_headline_integration.py",
    "repair_telemetry_integration.py",
)
FOCUSED_FILES = (
    "compile_acquisition_portable_case.mjs",
    "run_acquisition_solver_case_tests.mjs",
    "run_acquisition_workbook_tests.py",
    "run_carrier_identity_tests.mjs",
)
KNOWN_FAILURES = {
    "source-arithmetic",
    "broker-native-eligibility",
    "broker-tier1-demand",
    "broker-demand-selection",
    "broker-selected-cell",
    "broker-degraded-close",
    "broker-house-exclusion",
    "broker-physical-reconciliation",
    "broker-period-headers",
    "broker-table-engine",
    "broker-work-graph",
    "internal-fixed-point",
    "reviewed-contracts",
    "acquisition-solver",
    "acquisition-workbook",
    "carrier-identity",
    "case-equivalence",
    "degraded-delivery",
    "stage4-resume",
    "forecast-behavior",
    "forecast-topology",
    "equation-graph",
    "instrument-period-state",
    "opening-debt",
    "product-constitution",
    "delivery-constitution",
    "workflow-state",
    "user-flow",
    "dcs-evidence",
    "dcs-pipeline",
}


def run(command: list[str], *, check: bool = True, timeout: int = 1800) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=check,
        timeout=timeout,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def fetch(relative: str, destination: Path) -> None:
    url = (
        "https://raw.githubusercontent.com/computering001/excel-inflow/"
        f"{PINNED_REVIEWED_COMMIT}/{relative}"
    )
    subprocess.run(["curl", "-fsSL", url, "-o", str(destination)], check=True)


def ensure_reviewed_inputs() -> None:
    fixtures = ROOT / "parity-fixtures"
    fixtures.mkdir(exist_ok=True)
    for name in ("standard-maximal-v2.json", "standard-net-cash-v2.json", "README.md"):
        fetch(f"parity-fixtures/{name}", fixtures / name)
    for path in fixtures.glob("*.json"):
        json.loads(path.read_text("utf-8"))
    for name in PATCHERS:
        target = Path("/tmp") / name
        fetch(f"scripts/{name}", target)
        value = target.read_text("utf-8")
        value = value.replace("/mnt/data/excel-inflow-repair", str(ROOT))
        value = value.replace("/mnt/data/excel_inflow_repair", str(ROOT))
        target.write_text(value, "utf-8")
    for name in FOCUSED_FILES:
        target = ROOT / "scripts" / name
        if not target.exists():
            fetch(f"scripts/{name}", target)


def apply(path: Path) -> None:
    if not path.is_file():
        return
    completed = run([PYTHON, str(path)], check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"Reviewed patcher failed: {path}\n{completed.stdout}\n{completed.stderr}"
        )


def ensure_tier1_gate_entry() -> None:
    target = ROOT / "scripts" / "run_reviewed_portable_gate.py"
    source = target.read_text("utf-8")
    marker = (
        '        ("broker-native-eligibility", '
        '[args.python, "scripts/run_broker_native_eligibility_tests.py"]),\n'
    )
    addition = marker + (
        '        ("broker-tier1-demand", '
        '[args.python, "scripts/run_broker_tier1_demand_tests.py"]),\n'
    )
    if '"broker-tier1-demand"' not in source:
        if marker not in source:
            raise RuntimeError("Portable gate Tier-1 insertion marker is absent.")
        target.write_text(source.replace(marker, addition, 1), "utf-8")


def replace_stale_policy_expectations() -> None:
    for path in sorted((ROOT / "scripts").rglob("*")):
        if not path.is_file() or path.suffix not in {".py", ".mjs", ".js", ".json"}:
            continue
        source = path.read_text("utf-8")
        updated = source.replace(
            "latest_supplied_house_then_zero_authority",
            "native_quality_ranked_one_house_then_zero_authority",
        )
        updated = re.sub(
            r"/Users/[^\"'\s]+(?:/[^\"'\s]+)*/cases",
            "parity-fixtures",
            updated,
        )
        updated = re.sub(
            r"/Users/[^\"'\s]+(?:/[^\"'\s]+)*/standard-maximal-v2\.json",
            "parity-fixtures/standard-maximal-v2.json",
            updated,
        )
        if updated != source:
            path.write_text(updated, "utf-8")


def apply_missing_repairs() -> None:
    broker_source = (ROOT / "scripts" / "extract_broker_evidence.py").read_text("utf-8")
    if "archive_only = not selected_targets or unselected_house\n" in broker_source:
        core = ROOT / "scripts" / "apply_reviewed_core_repair.py"
        if not core.is_file():
            raise RuntimeError("Core repair is required but its reviewed bootstrap is absent.")
        apply(core)

    acquisition_reference = (ROOT / "references" / "acquisition.md").read_text("utf-8")
    if re.search(r"zero direct transaction cash-flow effect", acquisition_reference, re.I):
        apply(Path("/tmp/repair_acquisition_integration.py"))
        apply(Path("/tmp/repair_acquisition_plan_integration.py"))

    if not (ROOT / "scripts" / "lib" / "broker_headline_policy.mjs").is_file():
        apply(Path("/tmp/repair_broker_headline_integration.py"))
    if not (ROOT / "scripts" / "lib" / "run_telemetry.mjs").is_file():
        apply(Path("/tmp/repair_telemetry_integration.py"))

    apply(ROOT / "scripts" / "apply_reviewed_followup.py")
    apply(ROOT / "scripts" / "apply_broker_tier1_demand_repair.py")
    replace_stale_policy_expectations()
    ensure_tier1_gate_entry()


def validate_source() -> None:
    python_files = [
        str(path.relative_to(ROOT))
        for path in sorted((ROOT / "scripts").glob("*.py"))
    ] + [
        str(path.relative_to(ROOT))
        for path in sorted((ROOT / "scripts" / "verify").glob("*.py"))
    ]
    run([PYTHON, "-m", "py_compile", *python_files])
    for path in sorted((ROOT / "scripts").rglob("*.mjs")):
        run(["node", "--check", str(path.relative_to(ROOT))])
    for path in ROOT.rglob("*.json"):
        json.loads(path.read_text("utf-8"))

    violations: list[str] = []
    for path in sorted((ROOT / "scripts").rglob("*")):
        if path.is_file() and path.suffix in {".py", ".mjs", ".js", ".json"}:
            text = path.read_text("utf-8")
            if re.search(r"/Users/|[A-Za-z]:\\Users\\", text):
                violations.append(str(path.relative_to(ROOT)))
    broker_source = (ROOT / "scripts" / "extract_broker_evidence.py").read_text("utf-8")
    if "return select_recovery_house_id(" in broker_source:
        violations.append("recursive broker recovery selector")
    if "archive_only = not selected_targets or unselected_house\n" in broker_source:
        violations.append("blanket unselected-house suppression")
    if violations:
        raise RuntimeError("Source hygiene failed: " + ", ".join(violations))


def run_gate(attempt: int) -> dict[str, Any]:
    if not SOFFICE:
        raise RuntimeError("LibreOffice/soffice is unavailable.")
    output = ROOT / "audit" / "reviewed-portable-gate"
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir(parents=True)
    completed = run(
        [
            PYTHON,
            "scripts/run_reviewed_portable_gate.py",
            "--python",
            PYTHON,
            "--soffice",
            SOFFICE,
            "--out",
            str(output),
        ],
        check=False,
        timeout=3600,
    )
    (output / f"attempt-{attempt}-stdout.txt").write_text(completed.stdout, "utf-8")
    (output / f"attempt-{attempt}-stderr.txt").write_text(completed.stderr, "utf-8")
    report_path = output / "reviewed-portable-gate.json"
    if not report_path.is_file():
        raise RuntimeError("Portable gate emitted no status-bearing report.")
    return json.loads(report_path.read_text("utf-8"))


def remediate(report: dict[str, Any]) -> None:
    failures = [record for record in report.get("records", []) if record.get("status") != "PASS"]
    failure_ids = {str(record.get("id")) for record in failures}
    unknown = failure_ids - KNOWN_FAILURES
    if unknown:
        raise RuntimeError("Unknown portable-gate failures: " + ", ".join(sorted(unknown)))

    if failure_ids & {"source-arithmetic", "broker-native-eligibility"}:
        apply(ROOT / "scripts" / "apply_reviewed_core_repair.py")
    if "broker-tier1-demand" in failure_ids:
        apply(ROOT / "scripts" / "apply_broker_tier1_demand_repair.py")
    if failure_ids & {
        "broker-demand-selection",
        "broker-selected-cell",
        "broker-degraded-close",
        "broker-house-exclusion",
        "broker-physical-reconciliation",
        "broker-period-headers",
        "broker-table-engine",
        "broker-work-graph",
        "internal-fixed-point",
    }:
        apply(ROOT / "scripts" / "apply_reviewed_followup.py")
    if failure_ids & {
        "reviewed-contracts",
        "acquisition-solver",
        "acquisition-workbook",
        "case-equivalence",
        "degraded-delivery",
        "stage4-resume",
    }:
        apply(Path("/tmp/repair_acquisition_integration.py"))
        apply(Path("/tmp/repair_acquisition_plan_integration.py"))
    if failure_ids & {"reviewed-contracts", "broker-demand-selection"}:
        apply(Path("/tmp/repair_broker_headline_integration.py"))
    if failure_ids & {
        "reviewed-contracts",
        "carrier-identity",
        "user-flow",
        "workflow-state",
        "stage4-resume",
    }:
        apply(Path("/tmp/repair_telemetry_integration.py"))
    replace_stale_policy_expectations()


def main() -> int:
    ensure_reviewed_inputs()
    apply_missing_repairs()
    for attempt in range(1, 5):
        validate_source()
        report = run_gate(attempt)
        if (
            report.get("status") == "PASS"
            and report.get("fail_count") == 0
            and report.get("silently_skipped_count") == 0
        ):
            evidence = ROOT / "audit" / "reviewed-portable-gate" / "finalization-receipt.json"
            evidence.write_text(
                json.dumps(
                    {
                        "schema_version": "reviewed-repair-finalization/1.0",
                        "status": "PASS",
                        "attempt": attempt,
                        "selected_test_count": report.get("selected_test_count"),
                        "pass_count": report.get("pass_count"),
                        "fail_count": report.get("fail_count"),
                        "silently_skipped_count": report.get("silently_skipped_count"),
                        "external_release_only_requirements": report.get(
                            "external_certification_requirements", []
                        ),
                    },
                    indent=2,
                )
                + "\n",
                "utf-8",
            )
            print(json.dumps({"status": "PASS", "attempt": attempt}))
            return 0
        remediate(report)
    raise RuntimeError("Reviewed repair exhausted its bounded remediation attempts.")


if __name__ == "__main__":
    raise SystemExit(main())
