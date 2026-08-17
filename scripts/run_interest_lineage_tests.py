#!/usr/bin/env python3
"""Mutation tests for the independent instrument-interest lineage oracle."""

from __future__ import annotations

import json

from verify.interest_lineage import interest_lineage_findings


ROW_PLAN = {
    "period_row": 15,
    "controls": {"circularity": 5, "debt_maturities_roll": 6},
    "benchmark_curve_keys": {"loan": "SOFR"},
    "benchmark_rows": {"SOFR": 120},
    "benchmark_floor_rows": {"loan": 121},
}
BOND = {
    "instrument_id": "bond",
    "debt_row": 71,
    "interest_row": 123,
    "maturity_treatment": "contractual",
}
OTHER = {
    "instrument_id": "other",
    "debt_row": 72,
    "interest_row": 124,
    "maturity_treatment": "contractual",
}
LOAN = {
    "instrument_id": "loan",
    "debt_row": 81,
    "issuance_row": 82,
    "amortisation_row": 83,
    "fair_value_row": 84,
    "other_non_cash_row": 85,
    "pik_row": 86,
    "interest_row": 133,
    "pik_interest_row": 134,
    "maturity_treatment": "contractual",
}


def findings(formula, *, plan=BOND, rate_type="FIXED", state=None, maturity=True):
    return interest_lineage_findings(
        formula=formula,
        address="J%d" % plan["interest_row"],
        plan=plan,
        all_plans=[BOND, OTHER, LOAN],
        row_plan=ROW_PLAN,
        rate_type=rate_type,
        period_index=0,
        block="standalone",
        state=state
        or {"currency": "USD", "balance_basis": "native_principal"},
        reporting_currency="USD",
        maturity_value="2030-06-30" if maturity else None,
    )


fixed = (
    "=IF($C$5=0,0,-MAX(0,$D71)*"
    "(IF($C$6=0,1,MAX(0,MIN($E71,J$15)-(I$15+1)+1)/(J$15-(I$15+1)+1)))"
    "*$D$123*1)"
)
assert findings(fixed) == []

floating_foreign = (
    "=IF($C$5=0,0,-MAX(0,$D81+$J82+$J84+$J85-MIN(MAX(0,$D81+$J82+$J84+$J85),$J83)+$J86/2)"
    "*(MAX($J$120,$J$121)+$D$133)*'Forward Curves'!F7*"
    "IF($C$6=0,1,MAX(0,MIN($E81,J$15)-(I$15+1)+1)/(J$15-(I$15+1)+1)))"
)
assert (
    findings(
        floating_foreign,
        plan=LOAN,
        rate_type="FLOATING",
        state={"currency": "EUR", "balance_basis": "native_principal"},
    )
    == []
)

mutations = {
    "wrong-instrument-opening": fixed.replace("$D71", "$D72"),
    "wrong-instrument-rate": fixed.replace("$D$123", "$D$124"),
    "positive-interest-sign": fixed.replace(",0,-MAX", ",0,MAX"),
    "missing-maturity": fixed.replace("MIN($E71,J$15)", "J$15").replace("$C$6=0,1,", ""),
}
results = {}
for mutation_id, formula in mutations.items():
    observed = findings(formula)
    assert observed, "%s escaped the interest-lineage oracle" % mutation_id
    results[mutation_id] = sorted({item["issue"] for item in observed})

floating_mutations = {
    "missing-issuance": floating_foreign.replace("+$J82", ""),
    "missing-amortisation": floating_foreign.replace(
        "-MIN(MAX(0,$D81+$J82+$J84+$J85),$J83)", ""
    ),
    "wrong-benchmark": floating_foreign.replace("$J$120", "$J$122"),
    "missing-floor": floating_foreign.replace("MAX($J$120,$J$121)", "$J$120"),
    "missing-average-fx": floating_foreign.replace("*'Forward Curves'!F7", ""),
}
for mutation_id, formula in floating_mutations.items():
    observed = findings(
        formula,
        plan=LOAN,
        rate_type="FLOATING",
        state={"currency": "EUR", "balance_basis": "native_principal"},
    )
    assert observed, "%s escaped the interest-lineage oracle" % mutation_id
    results[mutation_id] = sorted({item["issue"] for item in observed})

double_fx = findings(
    fixed.replace("*1)", "*'Forward Curves'!F7)"),
    state={
        "currency": "EUR",
        "balance_basis": "reporting_currency_carrying_value",
    },
)
assert any(item["issue"] == "reporting_carrying_value_double_fx" for item in double_fx)
results["reporting-carrying-double-fx"] = sorted(
    {item["issue"] for item in double_fx}
)

summary = {
    "status": "PASS",
    "positive_checks": 2,
    "mutations_caught": len(results),
    "mutations": results,
}
print(json.dumps(summary, indent=2, sort_keys=True))
