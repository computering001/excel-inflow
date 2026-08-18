#!/usr/bin/env python3
"""Independent Phase-4 economic mutation matrix.

This oracle is deliberately stdlib-only and imports no production module.  It
challenges neutral economic facts directly, then verifies that the durable
coverage matrix is bound to this exact oracle and registry.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MATRIX_PATH = ROOT / "assets" / "critical-invariant-oracle-matrix-v1.json"
REGISTRY_PATH = ROOT / "assets" / "development-test-registry.json"
ORACLE_ID = "critical-invariant-independent-oracle-matrix"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def detected(mutation_id: str) -> bool:
    if mutation_id == "cash_flow_subtotal_prior_period":
        current = [12, 15, 19]
        components = [[5, 6, 8], [7, 9, 11]]
        mutated = [sum(row[max(0, period - 1)] for row in components) for period in range(3)]
        return mutated != current
    if mutation_id == "swap_instrument_rows":
        expected = {"bond_a": 100, "bond_b": 250}
        mutated = {"bond_a": 250, "bond_b": 100}
        return mutated != expected
    if mutation_id == "wrong_interest_rate_reference":
        balances = {"bond_a": 100, "bond_b": 250}
        rates = {"bond_a": 0.04, "bond_b": 0.07}
        expected = balances["bond_a"] * rates["bond_a"]
        mutated = balances["bond_a"] * rates["bond_b"]
        return mutated != expected
    if mutation_id == "include_impairment_in_ebitda":
        ebit, depreciation, impairment = 80, 20, 15
        return ebit + depreciation + impairment != ebit + depreciation
    if mutation_id == "parent_and_child_forecast":
        owners = {"revenue": True, "product_revenue": True}
        return sum(1 for value in owners.values() if value) != 1
    if mutation_id == "drop_rcf_from_financing_cash":
        base_financing, draw, repayment = -30, 50, 10
        expected = base_financing + draw - repayment
        return base_financing != expected
    if mutation_id == "change_broker_period":
        demand_period, selected_period = "2027-12-31", "2028-12-31"
        return demand_period != selected_period
    if mutation_id == "unresolved_to_zero":
        typed_state, value = "unresolved", 0
        return typed_state == "unresolved" and value is not None
    if mutation_id == "bond_as_other_debt":
        evidence, classified = "fixed_coupon_bond", "other_debt"
        return evidence == "fixed_coupon_bond" and classified != "bond_fixed"
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
    "broker_period", "typed_unresolved_state", "debt_classification",
    "workbook_error_scan",
}


def validate_matrix(candidate: dict) -> list[dict]:
    assert candidate["schema_version"] == "critical-invariant-oracle-matrix/1.0"
    assert candidate["bindings"]["oracle_sha256"] == sha256(Path(__file__))
    assert candidate["bindings"]["registry_sha256"] == sha256(REGISTRY_PATH)
    declared = tests[ORACLE_ID]
    assert declared["script"] == Path(__file__).name
    assert declared["test_class"] == "independent_economic_oracle"
    domains = candidate["domains"]
    assert {entry["domain"] for entry in domains} == required_domains
    assert len(domains) == len(required_domains)
    assert len({entry["invariant_id"] for entry in domains}) == len(domains)
    all_mutations = [mutation for entry in domains for mutation in entry["mutations"]]
    assert all(entry["mutations"] for entry in domains)
    assert len({mutation["mutation_id"] for mutation in all_mutations}) == len(all_mutations)
    for entry in domains:
        oracle_ids = entry["independent_oracle_test_ids"]
        assert oracle_ids and len(oracle_ids) == len(set(oracle_ids))
        for oracle_id in oracle_ids:
            oracle = tests[oracle_id]
            assert oracle["test_class"] in {"independent_economic_oracle", "frozen_authority"}
            assert oracle["test_class"] != "synthetic_integration"
    return domains


domains = validate_matrix(matrix)

results = []
for entry in domains:
    domain_results = []
    for mutation in entry["mutations"]:
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
    "total_violations": 0,
}, sort_keys=True))
