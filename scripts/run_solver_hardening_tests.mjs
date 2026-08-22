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

import {
  assertCommitmentFeeConventionAdmitted,
  assertRcfAverageFxUsable,
  detectTwoCycle,
  initMonotoneBoundaryBracket,
  leaseHistoricalLiabilities,
  leaseOpeningLiability,
  solveCase,
} from "./lib/solver.mjs";
import {
  isFiniteFinancialNumber,
  leaseInterestCashSplitErrors,
  leaseOpeningLiabilityState,
} from "./lib/lease_policy.mjs";
import { selectStandardisedProfile } from "./lib/design_contract.mjs";
import { validateRcfSweep } from "./lib/fixed_point_constitution.mjs";

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
// mp2-D1 — normalized financial numbers must be genuine finite numbers.
// JavaScript's Number(null), Number("") and Number(false) are all zero; none
// of those representations is a declared economic zero.
// ---------------------------------------------------------------------------

const caught = (action) => {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
};
const invalidFinancialValues = [
  undefined,
  null,
  "",
  "   ",
  "0",
  false,
  true,
  [],
  {},
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];
const financialValueLabel = (value) => {
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
};

for (const value of invalidFinancialValues) {
  const label = financialValueLabel(value);
  check(
    !isFiniteFinancialNumber(value),
    `D1: ${label} is not a finite financial number`,
  );
  check(
    caught(() => leaseHistoricalLiabilities({
      lease_policy: { historical_liabilities: [1, 2, value] },
    })) instanceof Error,
    `D1: historical lease series refuses ${label}`,
  );
  check(
    caught(() => selectStandardisedProfile({
      instruments: [],
      lease_policy: { historical_liabilities: [0, 0, value] },
      cash_policy: { opening_cash: 0, eligible_cash_percentage: 1 },
      acquisition: { enabled: 0 },
    })) instanceof Error,
    `D1: design profile refuses lease ${label}`,
  );
  const splitErrors = leaseInterestCashSplitErrors({
    cash_interest_paid: 0,
    gross_interest: 0,
    lease_interest: value,
    non_cash_interest: 0,
    non_cash_instrument_interest: 0,
  });
  check(
    splitErrors.length === 1 && /unresolved/.test(splitErrors[0]),
    `D1: cash-interest split refuses lease leg ${label}`,
  );
  if (value !== undefined) {
    check(
      caught(() => leaseOpeningLiabilityState({ opening_liability: value })) instanceof Error,
      `D1: scalar lease opening refuses ${label}`,
    );
  }
  if (value !== undefined && value !== null) {
    const publishedErrors = leaseInterestCashSplitErrors({
      cash_interest_paid: value,
      gross_interest: 0,
      lease_interest: 0,
      non_cash_interest: 0,
      non_cash_instrument_interest: 0,
    });
    check(
      publishedErrors.length === 1 && /must be a finite financial number/.test(publishedErrors[0]),
      `D1: published cash-interest value refuses ${label}`,
    );
  }
}

check(isFiniteFinancialNumber(0), "D1: numeric zero remains a declared financial number");
check(
  leaseOpeningLiabilityState({ opening_liability: 0 }).state === "declared" &&
    Object.is(leaseOpeningLiabilityState({ opening_liability: 0 }).value, 0),
  "D1: explicit numeric-zero opening liability remains declared",
);
check(
  leaseOpeningLiability({ lease_policy: {} }) === 0,
  "D1: omitted optional lease opening remains the typed carried state",
);
check(
  leaseInterestCashSplitErrors({
    cash_interest_paid: 0,
    gross_interest: 0,
    lease_interest: 0,
    non_cash_interest: 0,
    non_cash_instrument_interest: 0,
  }).length === 0,
  "D1: an all-declared numeric-zero cash-interest split remains valid",
);

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
// B8 — an undeclared benchmark floor raises ASK; an explicit [0,0,0] is silent.
// ---------------------------------------------------------------------------

{
  const makeCase = (withDeclaredFloor) => {
    const modelCase = readCase(path.join(CASES, "standard-maximal-v2.json"));
    const pool = modelCase.instruments ?? modelCase.debt_instruments;
    const target = pool[pool.length - 1];
    target.rate_type = "floating";
    target.benchmark_rate = [0.03, 0.03, 0.03];
    target.spread_bps = 250;
    if (withDeclaredFloor) target.benchmark_floor = [0, 0, 0];
    else delete target.benchmark_floor;
    return modelCase;
  };
  const undeclared = solveCase(makeCase(false));
  const declared = solveCase(makeCase(true));
  check("B8: every forecast period raises exactly one deduped ASK finding", () => {
    const findings = undeclared.solver_findings.filter(
      (finding) => finding.code === "benchmark_floor_undeclared",
    );
    assert.equal(findings.length, undeclared.forecast.length);
    for (const finding of findings) {
      assert.equal(finding.severity, "ASK");
      assert.ok(finding.instrument_id, "finding names the instrument");
      assert.equal(finding.applied_floor, 0);
      assert.ok(
        undeclared.forecast.some((p) => p.period === finding.period),
        `finding period ${finding.period} matches a forecast period`,
      );
    }
  });
  check("B8: an explicitly declared [0,0,0] floor stays silent", () => {
    assert.equal(
      declared.solver_findings.filter(
        (finding) => finding.code === "benchmark_floor_undeclared",
      ).length,
      0,
    );
  });
}

// ---------------------------------------------------------------------------
// B12 — the unusable RCF average FX rate refuses with the typed transport.
// ---------------------------------------------------------------------------

check("B12: non-positive/non-finite average FX refuses typed", () => {
  for (const bad of [Number.NaN, 0, -1.2]) {
    assert.throws(
      () => assertRcfAverageFxUsable(bad, { caseId: "c1", period: "2026-12-31", currency: "EUR" }),
      (error) =>
        error.code === "SOLVER_RCF_FX_INVALID" &&
        error.message.startsWith("SOLVER_RCF_FX_INVALID:") &&
        error.typed_internal_outcome.reason_code === "SOLVER_RCF_FX_INVALID" &&
        error.typed_internal_outcome.earliest_responsible_layer === "fx_assumptions" &&
        error.typed_internal_outcome.downstream_invalidation_scope ===
          "solve_and_below" &&
        error.typed_internal_outcome.rcf_average_fx === bad,
      `average fx ${bad} must refuse`,
    );
  }
});
check("B12: usable rates pass through untouched", () => {
  assert.doesNotThrow(() => assertRcfAverageFxUsable(1.0875, {}));
  assert.doesNotThrow(() => assertRcfAverageFxUsable("1.0875", {}));
});

// ---------------------------------------------------------------------------
// B21(twin) — reporting-unit sweep rows are judged at fx-scaled tolerance.
// ---------------------------------------------------------------------------

{
  const sweepPeriod = {
    rcf_currency: "EUR",
    rcf_average_fx: 15,
    rcf_opening_native: 100,
    rcf_capacity_native: 500,
    cash_after_mandatory_repayment: -50,
    minimum_cash: 0,
    // deficit = 50 -> draw native = 50/15 = 3.333… ; draw reporting = 50.
    rcf_draw_native: 50 / 15,
    rcf_repayment_native: 0,
    rcf_ending_native: 100 + 50 / 15,
    rcf_draw: 50 + 1e-7, // > native tolerance, < tolerance × 15
    rcf_repayment: 0,
    ending_cash: -50 + 50 + 1e-7,
    liquidity_shortfall: 0,
  };
  const errorsAtScaledTolerance = [];
  validateRcfSweep(sweepPeriod, 1e-8, "twin", errorsAtScaledTolerance);
  check("B21(twin): sub-tolerance reporting-unit noise passes at fx scale", () => {
    assert.deepEqual(errorsAtScaledTolerance, []);
  });
  check("B21(twin): the same noise FAILS against the unscaled native tolerance", () => {
    // Prove the test discriminates the regression: the pre-fix behaviour is
    // recovered by re-running with averageFx normalised away.
    const strictErrors = [];
    validateRcfSweep(
      { ...sweepPeriod, rcf_currency: "", rcf_average_fx: undefined },
      1e-8,
      "strict",
      strictErrors,
    );
    assert.ok(strictErrors.length >= 2);
  });
  check("B21(twin): a genuinely wrong native row is still caught", () => {
    const errors = [];
    validateRcfSweep(
      { ...sweepPeriod, rcf_draw_native: 50 / 15 + 1e-6 },
      1e-8,
      "native",
      errors,
    );
    assert.ok(errors.some((e) => e.includes("rcf_draw_native")));
  });
}

// ---------------------------------------------------------------------------
// B22 — commitment_fee_convention vocabulary guard + captured_in_residual LOG.
// ---------------------------------------------------------------------------

{
  const base = readCase(path.join(CASES, "standard-maximal-v2.json"));
  const badConvention = structuredClone(base);
  badConvention.rcf_policy.commitment_fee_convention = "percent_of_undrawn";
  check("B22: an unadmitted convention refuses typed (solver guard)", () => {
    assert.throws(
      () =>
        assertCommitmentFeeConventionAdmitted("percent_of_undrawn", {
          caseId: badConvention.case_id,
        }),
      (error) =>
        error.code === "COMMITMENT_FEE_CONVENTION_INVALID" &&
        error.typed_internal_outcome.reason_code ===
          "COMMITMENT_FEE_CONVENTION_INVALID" &&
        error.typed_internal_outcome.declared === "percent_of_undrawn" &&
        error.typed_internal_outcome.downstream_invalidation_scope ===
          "solve_and_below",
      "the typed transport must carry reason/declared/scope",
    );
  });
  check("B22: the case-shape layer also refuses it before the solve", () => {
    assert.throws(
      () => solveCase(badConvention),
      (error) =>
        Array.isArray(error.validationErrors) &&
        error.validationErrors.some((message) =>
          message.includes("commitment_fee_convention"),
        ),
      "schema layer must name the offending field",
    );
  });
  const captured = structuredClone(base);
  captured.rcf_policy.commitment_fee_convention = "captured_in_residual";
  const capturedSolution = solveCase(captured);
  check("B22: captured_in_residual solves, logs one finding per period, fee stays none", () => {
    const findings = capturedSolution.solver_findings.filter(
      (finding) => finding.code === "rcf_commitment_fee_captured_in_residual",
    );
    assert.equal(findings.length, capturedSolution.forecast.length);
    for (const finding of findings) {
      assert.equal(finding.severity, "LOG");
      assert.equal(finding.treated_as, "none");
    }
    for (const period of capturedSolution.forecast) {
      assert.equal(period.rcf_commitment_fee, 0);
    }
  });
}

// ---------------------------------------------------------------------------
// B23 — binding amortisation caps and balance floors raise DEGRADE findings.
// ---------------------------------------------------------------------------

{
  const modelCase = readCase(path.join(CASES, "standard-maximal-v2.json"));
  const pool = modelCase.instruments ?? modelCase.debt_instruments;
  const termLoan = pool.find((item) => item.opening_balance > 0);
  termLoan.scheduled_amortisation = [50000, 50000, 50000];
  const solution = solveCase(modelCase);
  check("B23: every capped period names instrument/period and requested-vs-applied", () => {
    const findings = solution.solver_findings.filter(
      (finding) => finding.code === "scheduled_amortisation_capped_at_balance",
    );
    assert.equal(findings.length, solution.forecast.length);
    for (const finding of findings) {
      assert.equal(finding.severity, "DEGRADE");
      assert.equal(finding.instrument_id, termLoan.instrument_id);
      assert.equal(finding.requested, 50000);
      assert.ok(finding.applied < 50000, "the cap actually bound");
    }
  });
  check("B23: an uncapped twin raises no cap findings", () => {
    const quiet = readCase(path.join(CASES, "standard-maximal-v2.json"));
    const quietSolution = solveCase(quiet);
    assert.equal(
      quietSolution.solver_findings.filter(
        (finding) =>
          finding.code === "scheduled_amortisation_capped_at_balance" ||
          finding.code === "debt_balance_floored_at_zero",
      ).length,
      0,
    );
  });
}

// ---------------------------------------------------------------------------
// B15 — monotone-boundary bisection: bracket maths + per-period receipt.
// ---------------------------------------------------------------------------

check("B15: a two-cycle observation brackets; matched images project opposite", () => {
  const sLow = { cash: 100, rcf: 20, native: 20 };
  const sHigh = { cash: 140, rcf: 30, native: 30 };
  const bracket = initMonotoneBoundaryBracket(sLow, sHigh, sHigh, sLow);
  assert.ok(bracket, "an exact two-cycle must bracket");
  assert.equal(bracket.method, "deterministic_bisection");
  assert.equal(Math.sign(bracket.gLo), 1);
  assert.equal(Math.sign(bracket.gHi), -1);
});
check("B15: same-sign or degenerate observations refuse to bracket", () => {
  const s = { cash: 1, rcf: 1, native: 1 };
  const up = { cash: 2, rcf: 2, native: 2 };
  assert.equal(initMonotoneBoundaryBracket(s, up, up, up), null, "same sign");
  assert.equal(
    initMonotoneBoundaryBracket(s, s, structuredClone(s), structuredClone(s)),
    null,
    "zero direction",
  );
});
check("B15: every period publishes a bisection receipt", () => {
  const solution = solveCase(readCase(path.join(CASES, "standard-maximal-v2.json")));
  for (const period of solution.forecast) {
    assert.deepEqual(period.bisection_used, {
      attempted: false,
      applied: false,
      steps: 0,
      method: "deterministic_bisection",
      boundary: "current_cash_rcf",
    });
  }
});

// ---------------------------------------------------------------------------
// B16/B26 — damping discipline flags are published and quiet on clean solves.
// ---------------------------------------------------------------------------

check("B16/B26: mediation flags roll up false when no two-cycle fired", () => {
  const solution = solveCase(readCase(path.join(CASES, "standard-maximal-v2.json")));
  assert.equal(solution.damping_mediation, false);
  for (const period of solution.forecast) {
    assert.equal(period.damping_mediation, false);
  }
});

// ---------------------------------------------------------------------------
// B18 — zero-coupon par discipline.
// ---------------------------------------------------------------------------

{
  const readArchetype = (file) => {
    const value = JSON.parse(
      fs.readFileSync(path.join(ARCHETYPES, file), "utf8"),
    );
    value.execution_profile = "reference_parity";
    return value;
  };
  const clean = solveCase(readArchetype("zero_coupon_accreting_to_par.json"));
  check("B18: the accreting-to-par archetype passes par discipline everywhere", () => {
    for (const period of clean.forecast) {
      assert.equal(period.checks.zero_coupon_par_discipline, true);
    }
    assert.equal(
      clean.solver_findings.filter((finding) =>
        ["zero_coupon_cash_interest_leak", "zero_coupon_below_par_at_maturity"].includes(
          finding.code,
        ),
      ).length,
      0,
    );
    // The discipline must actually have something to look at.
    assert.ok(clean.forecast.some((p) => p.checks.zero_coupon_par_discipline !== undefined));
  });
  check("B18: cash coupon leaking onto a zero-coupon instrument is caught", () => {
    const leaking = readArchetype("zero_coupon_accreting_to_par.json");
    leaking.instruments[0].coupon_or_all_in_rate = [0.05, 0.05, 0.05];
    const solution = solveCase(leaking);
    const leaks = solution.solver_findings.filter(
      (finding) => finding.code === "zero_coupon_cash_interest_leak",
    );
    assert.ok(leaks.length >= 1, "the leak must raise findings");
    for (const finding of leaks) {
      assert.equal(finding.severity, "DEGRADE");
      assert.equal(finding.instrument_id, "zero_note");
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
