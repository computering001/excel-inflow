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
    raise AssertionError(f"unknown mutation {mutation_id}")


# The matrix is curated authority, but its two byte bindings are generated.
# This explicit writer is the only supported way to rebind them after the
# oracle or test registry changes; ordinary test execution remains read-only.
if "--record-bindings" in sys.argv:
    recorded = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    recorded["bindings"]["oracle_sha256"] = sha256(Path(__file__))
    recorded["bindings"]["registry_sha256"] = sha256(REGISTRY_PATH)
    MATRIX_PATH.write_text(
        json.dumps(recorded, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "status": "PASS",
        "mode": "record_bindings",
        "oracle_sha256": recorded["bindings"]["oracle_sha256"],
        "registry_sha256": recorded["bindings"]["registry_sha256"],
    }, sort_keys=True))
    raise SystemExit(0)


# mp2-D: read-only binding check for the generated-artifact register. The two
# byte bindings are recomputed here WITHOUT the full matrix run (which requires
# REPRESENTATIVE + SOFFICE resources), so artifact agreement is checkable
# anywhere. Ordinary execution below remains unchanged and read-only.
if "--verify-bindings" in sys.argv:
    candidate = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    expected_oracle = sha256(Path(__file__))
    expected_registry = sha256(REGISTRY_PATH)
    actual = candidate.get("bindings", {})
    oracle_ok = actual.get("oracle_sha256") == expected_oracle
    registry_ok = actual.get("registry_sha256") == expected_registry
    print(json.dumps({
        "status": "PASS" if oracle_ok and registry_ok else "FAIL",
        "mode": "verify_bindings",
        "oracle_sha256_matches": oracle_ok,
        "registry_sha256_matches": registry_ok,
    }, sort_keys=True))
    raise SystemExit(0 if oracle_ok and registry_ok else 1)


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
    physical_binding = candidate.get("physical_mutation_oracle")
    physical_ids: list[str] = []
    for entry in domains:
        assert entry.get("evidence_scope") in {
            "emitted_candidate_artifact", "synthetic_unit_only", "emitted_workbook_cell"
        }
        # Honest scoping: synthetic-unit domains are checked by this same
        # script's hand-written unit facts and therefore carry no independent
        # proof; the matrix must say so explicitly, AND say WHY the domain
        # cannot be proven against the emitted workbook.  A flag with no
        # reason is how a provable domain stays unproven in silence.
        if entry["evidence_scope"] == "synthetic_unit_only":
            assert entry.get("independence") == "NOT_INDEPENDENTLY_PROVEN", (
                f"synthetic_unit_only domain {entry['domain']} must be marked "
                "independence=NOT_INDEPENDENTLY_PROVEN"
            )
            assert len(str(entry.get("unproven_reason") or "")) >= 80, (
                f"synthetic_unit_only domain {entry['domain']} must state WHY it "
                "cannot be proven against the emitted cells"
            )
        # Physical scope: the claim is proven by mutating CELLS of the emitted
        # workbook, so the binding to the suite that does it must exist and the
        # domain must name the mutations it owns.
        if entry["evidence_scope"] == "emitted_workbook_cell":
            assert entry.get("independence") == "PROVEN_AGAINST_EMITTED_CELLS"
            assert physical_binding, (
                f"{entry['domain']} claims the emitted-cell scope but the matrix "
                "binds no physical mutation oracle"
            )
            assert not entry.get("artifact_report_domain")
            physical_ids.extend(mutation["mutation_id"] for mutation in entry["mutations"])
        for mutation in entry.get("physical_cell_mutations") or []:
            assert physical_binding, (
                f"{entry['domain']} declares physical cell mutations but the "
                "matrix binds no physical mutation oracle"
            )
            physical_ids.append(mutation["mutation_id"])
        oracle_ids = entry["independent_oracle_test_ids"]
        assert oracle_ids and len(oracle_ids) == len(set(oracle_ids))
        for oracle_id in oracle_ids:
            oracle = tests[oracle_id]
            if entry["evidence_scope"] == "emitted_candidate_artifact":
                assert oracle["test_class"] in {"independent_economic_oracle", "frozen_authority"}
            else:
                # Both the synthetic and the emitted-cell scopes are driven by
                # THIS script: it runs the physical suite itself, so the
                # registry test that owns the claim is this one.
                assert oracle_id == ORACLE_ID
                assert oracle["test_class"] == "mutation"
    assert len(physical_ids) == len(set(physical_ids)), "duplicate physical mutation id"
    if physical_binding:
        assert physical_ids, "a physical mutation oracle is bound but no domain uses it"
        assert physical_binding["mutation_scope"] == "emitted_workbook_cell"
        for key in ("suite_path", "oracle_path", "reader_path"):
            assert (ROOT / physical_binding[key]).is_file(), physical_binding[key]
        # The oracle JUDGES through P5.4's reader; it must not have grown one.
        assert physical_binding["reader_path"] != physical_binding["oracle_path"]
        # A PENDING_REGISTRATION claim has to stay true: once the registry names
        # the suite, the matrix must say so instead of carrying a stale excuse.
        registered = {test.get("script") for test in registry["tests"]}
        if physical_binding["registry_status"] == "PENDING_REGISTRATION":
            assert Path(physical_binding["suite_path"]).name not in registered, (
                "the physical mutation suite IS registered; registry_status must "
                "no longer claim PENDING_REGISTRATION"
            )
        else:
            assert Path(physical_binding["suite_path"]).name in registered
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
physical_binding = matrix["physical_mutation_oracle"]
with tempfile.TemporaryDirectory(prefix="physical-authority-matrix-") as temporary:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / physical_binding["suite_path"]),
            str(Path(args.representative).resolve()),
            "--out", temporary,
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=900,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout[-4000:] + completed.stderr[-4000:]
    physical_summary = json.loads(
        [line for line in completed.stdout.splitlines() if line.strip()][-1])
    physical_report = json.loads(
        (Path(temporary) / "physical-authority-mutation-report.json").read_text(encoding="utf-8"))
assert physical_summary["status"] == "PASS"
assert physical_report["status"] == "PASS"
assert physical_report["production_imports"] == []
# The physical mutations are CELL mutations, and the suite must say so for each.
assert physical_report["mutations"], "the physical suite ran no mutations"
assert all(item["mutation_scope"] == "emitted_workbook_cell" for item in physical_report["mutations"])
assert all(item["address_derivation"] == "derived" for item in physical_report["mutations"]), (
    "a physical mutation used a written-down address")
physical_mutations: dict = {}
for item in physical_report["mutations"]:
    key = (item["domain"], item["mutation_id"])
    physical_mutations[key] = physical_mutations.get(key, True) and item["caught"]

assert artifact_report["status"] == "PASS"
assert artifact_report["artifact_origin"] == "real_candidate_emission_with_sealed_source_arithmetic"
assert artifact_report["production_imports"] == []
artifact_mutations = {
    (item["domain"], item["mutation_id"]): item["caught"]
    for item in artifact_report["mutations"]
}

results = []
total_detected = 0
total_mutations = 0
for entry in domains:
    domain_results = []
    scoped = list(entry["mutations"]) + list(entry.get("physical_cell_mutations") or [])
    for mutation in scoped:
        physical_key = (entry["domain"], mutation["mutation_id"])
        if physical_key in physical_mutations:
            caught = physical_mutations[physical_key]
            evidence = "emitted_workbook_cell"
        elif entry.get("artifact_report_domain"):
            caught = artifact_mutations.get(
                (entry["artifact_report_domain"], mutation["mutation_id"]), False
            )
            evidence = "emitted_candidate_artifact"
        else:
            caught = detected(mutation["mutation_id"])
            evidence = "synthetic_unit_only"
        assert caught, f"{mutation['mutation_id']} escaped {entry['domain']}"
        domain_results.append({
            "mutation_id": mutation["mutation_id"],
            "detected": caught,
            "evidence": evidence,
        })
    detected_count = sum(item["detected"] for item in domain_results)
    domain_rate = detected_count / len(domain_results)
    if entry["evidence_scope"] in ("emitted_candidate_artifact", "emitted_workbook_cell"):
        # Never weaken: an artifact- or cell-scope claim stays a full kill rate;
        # a computed rate below the claimed 1.0 is a FAILURE, not a report line.
        assert domain_rate >= 1.0, (
            f"artifact-scope domain {entry['domain']} computed detection rate "
            f"{domain_rate} fell below the claimed 1.0"
        )
    total_detected += detected_count
    total_mutations += len(domain_results)
    results.append({
        "domain": entry["domain"],
        "detected": detected_count,
        "total": len(domain_results),
        "detection_rate": domain_rate,
        "evidence_scope": entry["evidence_scope"],
        "independence": entry.get("independence", "emitted_candidate_artifact_oracle"),
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
governance_candidates["synthetic_claims_independence"] = json.loads(json.dumps(matrix))
for entry in governance_candidates["synthetic_claims_independence"]["domains"]:
    if entry["evidence_scope"] == "synthetic_unit_only":
        entry.pop("independence", None)
governance_candidates["unproven_without_reason"] = json.loads(json.dumps(matrix))
for entry in governance_candidates["unproven_without_reason"]["domains"]:
    if entry["evidence_scope"] == "synthetic_unit_only":
        entry.pop("unproven_reason", None)
governance_candidates["physical_scope_without_binding"] = json.loads(json.dumps(matrix))
governance_candidates["physical_scope_without_binding"].pop("physical_mutation_oracle", None)
governance_candidates["physical_suite_path_absent"] = json.loads(json.dumps(matrix))
governance_candidates["physical_suite_path_absent"]["physical_mutation_oracle"]["suite_path"] = (
    "scripts/run_physical_authority_mutation_tests_that_do_not_exist.py")
governance_candidates["physical_oracle_is_its_own_reader"] = json.loads(json.dumps(matrix))
governance_candidates["physical_oracle_is_its_own_reader"]["physical_mutation_oracle"]["reader_path"] = (
    governance_candidates["physical_oracle_is_its_own_reader"]["physical_mutation_oracle"]["oracle_path"])
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
    "mutation_detection_rate": total_detected / total_mutations,
    "mutations_detected": total_detected,
    "mutations_total": total_mutations,
    "not_independently_proven_domains": sorted(
        entry["domain"] for entry in domains
        if entry.get("independence") == "NOT_INDEPENDENTLY_PROVEN"
    ),
    "governance_mutations_caught": len(governance_mutations),
    "production_imports": [],
    "artifact_oracle_production_imports": artifact_report["production_imports"],
    "artifact_origin": artifact_report["artifact_origin"],
    "claim_scope": "MIXED_ARTIFACT_PHYSICAL_CELL_AND_EXPLICIT_SYNTHETIC_UNIT_COVERAGE",
    "not_independently_proven_reasons": {
        entry["domain"]: entry["unproven_reason"] for entry in domains
        if entry.get("independence") == "NOT_INDEPENDENTLY_PROVEN"
    },
    "physical_cell_domains": sorted({item["domain"] for item in physical_report["mutations"]}),
    "physical_mutation_suite": physical_binding["suite_path"],
    "physical_mutation_suite_checks": physical_summary["checks"],
    "physical_mutations_caught": physical_report["mutations_caught"],
    "physical_mutations_total": physical_report["mutations_total"],
    "physical_red_proof": physical_report["red_proof"],
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
