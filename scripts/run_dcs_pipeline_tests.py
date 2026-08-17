#!/usr/bin/env python3
"""Prove the resumable DCS controller owns structured crosswalk proposal."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from run_dcs_pipeline import classify_extract_receipt
from propose_dcs_crosswalk import classify_type


HERE = Path(__file__).resolve().parent


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", "utf-8")


def run(request: Path, out: Path) -> tuple[int, dict]:
    completed = subprocess.run([sys.executable, str(HERE / "run_dcs_pipeline.py"), str(request), "--out", str(out)], text=True, capture_output=True)
    state = json.loads((out / "dcs-run-state.json").read_text())
    return completed.returncode, state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    root = Path(args.out).resolve()
    if root.exists(): shutil.rmtree(root)
    root.mkdir(parents=True)

    # Every ontology class is reached only from affirmative source semantics;
    # a vague instrument description must remain in the review class.
    classifier_cases = [
        ("fixed bond", "Senior notes", "fixed", "bond_fixed"),
        ("floating bond", "Floating rate notes", "floating", "bond_floating"),
        ("fixed term loan", "Term facility", "fixed", "term_loan_fixed"),
        ("floating term loan", "Bank loan", "floating", "term_loan_floating"),
        ("RCF", "Committed revolving credit facility", "floating", "rcf"),
        ("commercial paper", "Commercial paper programme", "fixed", "commercial_paper"),
        ("securitisation", "Receivables securitisation", "floating", "securitisation"),
        ("finance lease", "Finance lease liability", "fixed", "lease_liability"),
        ("overdraft", "Bank overdraft", "floating", "overdraft"),
        ("other debt", "Other borrowings", "fixed", "other_explicit"),
        ("", "Bespoke funding arrangement", "", "unclassified"),
    ]
    for source_type, description, rate_hint, expected in classifier_cases:
        assert classify_type(source_type, description, rate_hint) == expected

    csv_path = root / "structured.csv"
    rows = [
        ["Security Description", "Security Type", "CCY", "Amount Outstanding", "Maturity Date", "Coupon Rate", "Rate Type", "Balance Basis", "Facility Size", "Amount Drawn", "Committed", "Fee Convention", "Commitment Fee Bps", "Issue Date", "Clean Price", "YTW", "OAS"],
        ["Zero Commercial Paper", "commercial paper", "USD", 0, "2027-06-30", "", "", "reporting_currency_carrying_value", "", "", "", "", "", "2026-01-02", 100, 0.04, 55],
        ["Committed Revolving Credit Facility", "RCF", "USD", 0, "2029-12-31", "", "", "reporting_currency_carrying_value", 1000, 0, "yes", "", "", "2024-05-01", 100, 0.03, 75],
        ["USD 5% Senior Notes", "bond", "USD", 500, "2030-09", 0.05, "fixed", "reporting_currency_carrying_value", "", "", "", "", "", "2025-09-15", 98.5, 0.052, 120],
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as handle: csv.writer(handle).writerows(rows)
    request = root / "request.json"
    write_json(request, {"schema_version": "dcs-extraction-request/1.0", "run_id": "dcs_controller_test", "source_path": str(csv_path), "expected_sha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(), "adapter_metadata": {"as_of": "2025-12-31", "entity_name": "Controlled Issuer", "reporting_currency": "USD", "units": "millions", "system": "FactSet DCS", "date_basis": "last_fiscal_year_end"}})
    code, state = run(request, root / "run")
    assert code == 0 and state["pipeline_status"] == "PASS"
    assert state["summary"]["instrument_count"] == 3 and state["summary"]["total_violation_count"] == 0
    export = json.loads(Path(state["artifacts"]["dcs_export"]).read_text())
    by_description = {item["description"]: item for item in export["instruments"]}
    assert by_description["Zero Commercial Paper"]["outstanding_amount"] == 0
    assert by_description["Committed Revolving Credit Facility"]["facility_limit"] == 1000
    assert by_description["USD 5% Senior Notes"]["maturity_precision"] == "month"
    code, resumed = run(request, root / "run")
    assert code == 0 and all(item["reused"] for item in resumed["checkpoints"])

    # The independent oracle must not trust a coordinated reclassification of
    # a source-labelled bond, even if all carrier hashes are recomputed.
    crosswalk_path = Path(state["artifacts"]["crosswalk"])
    projection_path = Path(state["artifacts"]["projection"])
    receipt_path = Path(state["artifacts"]["compiler_receipt"])
    tampered_root = root / "type-tamper"
    tampered_root.mkdir()
    crosswalk = json.loads(crosswalk_path.read_text())
    bond_id = next(
        item["instrument_id"] for item in crosswalk["instruments"]
        if any(term.get("output_value") == "bond_fixed" for term in item.get("term_authorities", []))
    )
    for instrument in crosswalk["instruments"]:
        if instrument.get("instrument_id") != bond_id: continue
        for term in instrument["term_authorities"]:
            if term.get("model_field") == "instrument_type":
                term["output_value"] = "commercial_paper"
                term["transform"]["value"] = "commercial_paper"
    tampered_crosswalk = tampered_root / "crosswalk.json"
    write_json(tampered_crosswalk, crosswalk)
    compile_root = tampered_root / "compile"
    subprocess.run([
        sys.executable, str(HERE / "compile_dcs_evidence.py"),
        state["artifacts"]["source_tables"], state["artifacts"]["candidate_manifest"],
        str(tampered_crosswalk), "--out", str(compile_root),
    ], check=False, text=True, capture_output=True)
    oracle_report = tampered_root / "oracle.json"
    oracle = subprocess.run([
        sys.executable, str(HERE / "verify" / "dcs_evidence_oracle.py"),
        "--source", state["artifacts"]["source_tables"],
        "--manifest", state["artifacts"]["candidate_manifest"],
        "--crosswalk", str(tampered_crosswalk),
        "--projection", str(compile_root / "dcs-projection.json"),
        "--receipt", str(compile_root / "dcs-evidence-receipt.json"),
        "--out", str(oracle_report),
    ], check=False, text=True, capture_output=True)
    oracle_value = json.loads(oracle_report.read_text())
    assert oracle.returncode != 0 and any(
        item.get("code") == "DCS-ORACLE-INSTRUMENT-TYPE-SEMANTICS"
        for item in oracle_value.get("violations", [])
    )

    deficient = root / "deficient.csv"
    with deficient.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows([rows[0], ["Missing Terms Loan", "loan", "USD", 73, "", "", "", "reporting_currency_carrying_value", "", "", "", "", "", "", "", "", ""]])
    deficient_request = root / "deficient-request.json"
    payload = json.loads(request.read_text()); payload["source_path"] = str(deficient); payload.pop("expected_sha256"); write_json(deficient_request, payload)
    code, blocked = run(deficient_request, root / "deficient-run")
    assert code == 2 and blocked["pipeline_status"] == "BLOCKED_INPUT" and blocked["blocker_class"] == "USER_EVIDENCE"
    unresolved = blocked["tasks"][0]["unresolved"]
    assert len(unresolved) == 1 and "maturity" in unresolved[0]["missing_fields"]
    assert "instrument_type_review" in unresolved[0]["missing_fields"]

    # Receipt failures are owned by the user only when the receipt proves the
    # source has no usable cells.  An unfamiliar/internal extractor finding may
    # not be relabelled as a request for a replacement FactSet export.
    assert classify_extract_receipt({
        "status": "BLOCKED",
        "violations": [{"code": "DCS-EXTRACT-EMPTY"}],
    }) == ("BLOCKED_INPUT", True, "FATAL_SOURCE")
    assert classify_extract_receipt({
        "status": "BLOCKED",
        "violations": [{"code": "DCS-EXTRACT-UNRECOGNISED-LAYOUT"}],
    }) == ("BLOCKED_INTERNAL", False, "INTERNAL_WORK")
    assert classify_extract_receipt({
        "status": "BLOCKED",
        "violations": [
            {"code": "DCS-EXTRACT-EMPTY"},
            {"code": "DCS-EXTRACT-INTERNAL-INVARIANT"},
        ],
    }) == ("BLOCKED_INTERNAL", False, "INTERNAL_WORK")

    summary = {"schema_version": "dcs-pipeline-tests/1.0", "status": "PASS", "positive_checks": 21, "mutation_checks": 6, "resume_reused_all": True}
    write_json(root / "summary.json", summary)
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
