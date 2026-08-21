#!/usr/bin/env node
/**
 * Solver-hardening regression suite.
 *
 * Kept checks (two-cycle detection) plus one focused test per solver fix in
 * this package:
 *
 *   B3(sign) — `cash_interest_paid` must equal
 *     -(gross_interest - lease_interest - non_cash_interest -
 *       non_cash_instrument_interest). The lease leg sits INSIDE the negation
 *     because `grossInterest` already includes it; subtracting it a second
 *     time outside overstated the cash outflow by 2 × lease interest per
 *     period.
 *   B7 — the PUBLISHED effective tax rate is clamped into [0, MAX_USABLE_RATE]
 *     (the same ceiling tax_rate_policy applies to history); each period where
 *     the clamp binds raises a DEGRADE finding, and the declared charge keeps
 *     its economics.
 *   B25 — a period solved on the forced SINGLE PASS (circularity off =>
 *     iterationLimit === 1) publishes `stale_iteration: true` at period level
 *     and top level, because its `converged: true` never faced an iteration.
 *
 * Single-line JSON result: {"status":"PASS","checks":N}.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectTwoCycle, solveCase } from "./lib/solver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CASES = path.join(REPO, "test-fixtures", "cases");
const ARCHETYPES = path.join(REPO, "test-fixtures", "archetypes", "economics");

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

// A suite is not production, so it must identify itself the way every other
// fixture consumer does rather than impersonating a production run.
const readCase = (file) => {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.execution_profile = "reference_parity";
  return value;
};

// ---------------------------------------------------------------------------
// Legacy hardening checks — two-cycle detection.
// ---------------------------------------------------------------------------

check("detectTwoCycle flags a returning pair", () => {
  assert.equal(detectTwoCycle([1, 2], [2, 3], [1, 2], 1e-8), true);
});
check("detectTwoCycle ignores a settled sweep", () => {
  assert.equal(detectTwoCycle([1, 2], [1, 2], [1, 2], 1e-8), false);
});
check("detectTwoCycle tolerates missing history", () => {
  assert.equal(detectTwoCycle(null, [2], [1], 1e-8), false);
});

// ---------------------------------------------------------------------------
// B3(sign) — the lease leg of cash_interest_paid.
// ---------------------------------------------------------------------------

{
  const modelCase = readCase(path.join(CASES, "standard-maximal-v2.json"));
  // The fixtures carry no cash_interest_paid row, so the calculated override
  // never resolves; declare one so the published value is observable.
  modelCase.statement_structure.cash_flow.push({
    row_id: "cash_interest_paid",
    label: "Cash interest paid",
    row_type: "calculation",
    semantic_role: "cash_interest_paid",
    values: [null, null, null, null, null, null],
  });
  const solution = solveCase(modelCase);
  check("B3: every forecast period publishes the corrected cash-interest identity", () => {
    assert.equal(solution.forecast.length, 3);
    for (const period of solution.forecast) {
      const sv = period.statement_values;
      check(
        Number.isFinite(sv.cash_interest_paid),
        `cash_interest_paid resolved in ${period.period}`,
      );
      // The exact identity the leaseInterestCashSplitErrors validator pins.
      const expected =
        -(period.gross_interest -
          period.lease_interest -
          period.non_cash_interest -
          period.non_cash_instrument_interest);
      assert.ok(
        Math.abs(sv.cash_interest_paid - expected) <= 1e-6,
        `${period.period}: cash_interest_paid ${sv.cash_interest_paid} != -(gross - lease - non-cash - non-cash instrument) ${expected}`,
      );
    }
  });
  check("B3: the split identity is pinned as a period-level solver checks entry", () => {
    // leaseInterestCashSplitErrors must actually run inside solveCase — the
    // receipt's own checks object is the wiring under test here.
    for (const period of solution.forecast) {
      assert.equal(
        period.checks.lease_interest_cash_split,
        true,
        `${period.period}: lease_interest_cash_split check must hold`,
      );
    }
  });
  check("B3: the case actually exercises the fix (lease interest present, sign mattered)", () => {
    for (const period of solution.forecast) {
      assert.ok(period.lease_interest > 0, `lease interest > 0 in ${period.period}`);
      // The pre-fix expression subtracted the lease leg twice; prove the two
      // formulas disagree so this test cannot pass against the regression.
      const wrongFormula =
        -(period.gross_interest -
          period.non_cash_interest -
          period.non_cash_instrument_interest) -
        period.lease_interest;
      assert.ok(
        Math.abs(wrongFormula - period.statement_values.cash_interest_paid) >
          2 * period.lease_interest - 1e-6,
        `${period.period}: pre-fix formula (${wrongFormula}) must be distinguishable`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// B7 — published ETR clamped to [0, MAX_USABLE_RATE] + DEGRADE finding.
// ---------------------------------------------------------------------------

{
  const modelCase = readCase(
    path.join(ARCHETYPES, "etr_above_usable_ceiling.json"),
  );
  // Give the archetype a resolvable ETR disclosure row and a declared charge
  // implying an 85% rate on every forecast period — above the usable ceiling.
  modelCase.statement_structure.income_statement.push({
    row_id: "effective_tax_rate",
    label: "Effective tax rate",
    row_type: "calculation",
    semantic_role: "effective_tax_rate",
    values: [null, null, null, null, null, null],
  });
  const declaredCharge = [-153, -161.5, -170];
  modelCase.statement_structure.income_statement.find(
    (row) => row.row_id === "tax_expense",
  ).values = [
    modelCase.statement_structure.income_statement.find(
      (row) => row.row_id === "tax_expense",
    ).values[0],
    modelCase.statement_structure.income_statement.find(
      (row) => row.row_id === "tax_expense",
    ).values[1],
    modelCase.statement_structure.income_statement.find(
      (row) => row.row_id === "tax_expense",
    ).values[2],
    ...declaredCharge,
  ];
  const solution = solveCase(modelCase);
  check("B7: published ETR is clamped to 0.6 wherever the raw rate exceeds it", () => {
    assert.equal(solution.forecast.length, 3);
    for (const period of solution.forecast) {
      const sv = period.statement_values;
      assert.ok(Number.isFinite(sv.effective_tax_rate));
      assert.equal(
        sv.effective_tax_rate,
        0.6,
        `${period.period}: published ETR must sit at the usable ceiling`,
      );
    }
  });
  check("B7: each binding period raises exactly one DEGRADE finding naming both rates", () => {
    const findings = solution.solver_findings.filter(
      (finding) => finding.code === "effective_tax_rate_clamped",
    );
    assert.equal(findings.length, 3);
    for (const finding of findings) {
      assert.equal(finding.severity, "DEGRADE");
      assert.ok(solution.forecast.some((p) => p.period === finding.period));
      assert.ok(Math.abs(finding.unclamped_value - 0.85) < 1e-9);
      assert.equal(finding.published_value, 0.6);
      assert.deepEqual(finding.bounds, [0, 0.6]);
    }
  });
  check("B7: the clamp touches only the disclosed rate — the declared charge keeps its economics", () => {
    for (const [index, period] of solution.forecast.entries()) {
      assert.equal(
        period.statement_values.tax_expense,
        declaredCharge[index],
        `${period.period}: tax_expense must stay the declared (unclamped) charge`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// B25 — the forced single-pass path publishes stale_iteration.
// ---------------------------------------------------------------------------

{
  const base = readCase(path.join(CASES, "standard-maximal-v2.json"));
  const singlePass = structuredClone(base);
  singlePass.controls.circularity = 0; // solver declaration not required => iterationLimit === 1
  const iterative = solveCase(base);
  const stale = solveCase(singlePass);

  check("B25: circularity-off solves publish stale_iteration at every level", () => {
    assert.equal(stale.iterations, 1);
    assert.equal(stale.converged, true);
    assert.equal(stale.stale_iteration, true);
    assert.equal(stale.forecast.length, 3);
    for (const period of stale.forecast) {
      assert.equal(period.iterations, 1);
      assert.equal(period.stale_iteration, true);
    }
  });
  check("B25: an iterated solve never claims staleness", () => {
    assert.equal(iterative.converged, true);
    assert.equal(iterative.stale_iteration, false);
    for (const period of iterative.forecast) {
      assert.equal(period.stale_iteration, false);
    }
  });
}

console.log(JSON.stringify({ status: "PASS", checks }));
