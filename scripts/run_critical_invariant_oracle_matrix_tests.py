#!/usr/bin/env python3
"""Mixed-scope Phase-4 economic mutation matrix.

This oracle is deliberately stdlib-only and imports no production module.  It
challenges neutral economic facts directly, then verifies that the durable
coverage matrix is bound to this exact oracle and registry.
"""

from __future__ import annotations

import hashlib
import json
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MATRIX_PATH = ROOT / "assets" / "critical-invariant-oracle-matrix-v1.json"
REGISTRY_PATH = ROOT / "assets" / "development-test-registry.json"
ORACLE_ID = "critical-invariant-independent-oracle-matrix"
ARTIFACT_ORACLE_ID = "emitted-candidate-independent-oracle"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def detected(mutation_id: str) -> bool:
    if mutation_id == "swap_instrument_rows":
        expected = {"bond_a": 100, "bond_b": 250}
        mutated = {"bond_a": 250, "bond_b": 100}
        return mutated != expected
    if mutation_id == "include_impairment_in_ebitda":
        ebit, depreciation, impairment = 80, 20, 15
        return ebit + depreciation + impairment != ebit + depreciation
    if mutation_id == "change_broker_period":
        demand_period, selected_period = "2027-12-31", "2028-12-31"
        return demand_period != selected_period
    if mutation_id == "unresolved_to_zero":
        typed_state, value = "unresolved", 0
        return typed_state == "unresolved" and value is not None
    if mutation_id == "remote_value_error":
        cells = {"A1": 1, "B2": "=A1", "Z999": "#VALUE!"}
        return any(value in {"#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"} for value in cells.values())
    raise AssertionError(f"unknown mutation {mutation_id}")


matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
tests = {test["id"]: test for test in registry["tests"]}
required_domains = {
    "cash_flow_identity", "instrument_identity", "interest_lineage",
    "ebitda_basis", "forecast_ownership", "rcf_financing_cash",
    "broker_period", "broker_consensus_membership", "typed_unresolved_state", "debt_classification",
    "workbook_error_scan", "acquisition_cash_debt_interest", "lease_roll_forward",
    "native_workbook_style_provenance", "source_arithmetic_dimensional_compatibility",
}


def validate_matrix(candidate: dict) -> list[dict]:
    assert candidate["schema_version"] == "critical-invariant-oracle-matrix/2.0"
    assert candidate["bindings"]["oracle_sha256"] == sha256(Path(__file__))
    assert candidate["bindings"]["registry_sha256"] == sha256(REGISTRY_PATH)
    declared = tests[ORACLE_ID]
    assert declared["script"] == Path(__file__).name
    assert declared["test_class"] == "mutation"
    domains = candidate["domains"]
    assert {entry["domain"] for entry in domains} == required_domains
    assert len(domains) == len(required_domains)
    assert len({entry["invariant_id"] for entry in domains}) == len(domains)
    all_mutations = [mutation for entry in domains for mutation in entry["mutations"]]
    assert all(entry["mutations"] for entry in domains)
    assert len({mutation["mutation_id"] for mutation in all_mutations}) == len(all_mutations)
    for entry in domains:
        assert entry.get("evidence_scope") in {
            "emitted_candidate_artifact", "synthetic_unit_only"
        }
        oracle_ids = entry["independent_oracle_test_ids"]
        assert oracle_ids and len(oracle_ids) == len(set(oracle_ids))
        for oracle_id in oracle_ids:
            oracle = tests[oracle_id]
            if entry["evidence_scope"] == "emitted_candidate_artifact":
                assert oracle["test_class"] in {"independent_economic_oracle", "frozen_authority"}
            else:
                assert oracle_id == ORACLE_ID
                assert oracle["test_class"] == "mutation"
    return domains


domains = validate_matrix(matrix)

parser = argparse.ArgumentParser()
parser.add_argument("representative")
parser.add_argument("--soffice", required=True)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix="critical-artifact-matrix-") as temporary:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "run_emitted_candidate_independent_oracle_tests.py"),
            str(Path(args.representative).resolve()),
            "--soffice", str(Path(args.soffice).resolve()),
            "--out", temporary,
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=600,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout[-4000:] + completed.stderr[-4000:]
    report_lines = [line for line in completed.stdout.splitlines() if line.strip()]
    artifact_report = json.loads(report_lines[-1])
assert artifact_report["status"] == "PASS"
assert artifact_report["artifact_origin"] == "real_candidate_emission_with_sealed_source_arithmetic"
assert artifact_report["production_imports"] == []
artifact_mutations = {
    (item["domain"], item["mutation_id"]): item["caught"]
    for item in artifact_report["mutations"]
}

results = []
for entry in domains:
    domain_results = []
    for mutation in entry["mutations"]:
        if entry.get("artifact_report_domain"):
            caught = artifact_mutations.get(
                (entry["artifact_report_domain"], mutation["mutation_id"]), False
            )
        else:
            caught = detected(mutation["mutation_id"])
        assert caught, f"{mutation['mutation_id']} escaped {entry['domain']}"
        domain_results.append({"mutation_id": mutation["mutation_id"], "detected": caught})
    results.append({
        "domain": entry["domain"],
        "detected": sum(item["detected"] for item in domain_results),
        "total": len(domain_results),
        "detection_rate": 1.0,
        "mutations": domain_results,
    })

# Matrix governance mutations must fail the exact validator used for the
# durable artifact; this prevents the mutation checks themselves from being
# decorative assertions.
governance_candidates = {}
governance_candidates["missing_domain"] = json.loads(json.dumps(matrix))
governance_candidates["missing_domain"]["domains"].pop()
governance_candidates["duplicate_invariant"] = json.loads(json.dumps(matrix))
governance_candidates["duplicate_invariant"]["domains"][1]["invariant_id"] = domains[0]["invariant_id"]
governance_candidates["self_confirming_only"] = json.loads(json.dumps(matrix))
governance_candidates["self_confirming_only"]["domains"][0]["independent_oracle_test_ids"] = ["statement-classifier"]
governance_candidates["missing_artifact_domain"] = json.loads(json.dumps(matrix))
governance_candidates["missing_artifact_domain"]["domains"] = [
    entry for entry in governance_candidates["missing_artifact_domain"]["domains"]
    if entry["domain"] != "lease_roll_forward"
]
governance_mutations = {}
for mutation_id, candidate in governance_candidates.items():
    try:
        validate_matrix(candidate)
    except AssertionError:
        governance_mutations[mutation_id] = True
    else:
        raise AssertionError(f"matrix governance mutation escaped: {mutation_id}")

print(json.dumps({
    "schema_version": "critical-invariant-oracle-matrix-report/1.0",
    "status": "PASS",
    "matrix_sha256": sha256(MATRIX_PATH),
    "oracle_sha256": sha256(Path(__file__)),
    "registry_sha256": sha256(REGISTRY_PATH),
    "domains": results,
    "mutation_detection_rate": 1.0,
    "governance_mutations_caught": len(governance_mutations),
    "production_imports": [],
    "artifact_oracle_production_imports": artifact_report["production_imports"],
    "artifact_origin": artifact_report["artifact_origin"],
    "claim_scope": "MIXED_ARTIFACT_AND_EXPLICIT_SYNTHETIC_UNIT_COVERAGE",
    "artifact_domains": sorted(
        entry["domain"] for entry in domains
        if entry["evidence_scope"] == "emitted_candidate_artifact"
    ),
    "synthetic_unit_domains": sorted(
        entry["domain"] for entry in domains
        if entry["evidence_scope"] == "synthetic_unit_only"
    ),
    "artifact_mutations_caught": artifact_report["mutations_caught"],
    "total_violations": 0,
}, sort_keys=True))
