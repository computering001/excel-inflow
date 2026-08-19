#!/usr/bin/env node
/**
 * P4.3 — typed schedule states.
 *
 * Proves:
 *  (a) RED-PROOF: every solved forecast period carries a typed-state shadow
 *      (schedule-typed-states/1.0) for RCF draw/repayment/ending, acquisition
 *      debt/cash amounts and every cash-bucket balance — absent before P4.3;
 *  (b) MUTATION: a bare number smuggled into a typed slot is caught;
 *  (c) MUTATION: an unresolved input NEVER surfaces as a typed zero;
 *  (d) the cash definition-basis selectors are DECLARED DATA evaluated
 *      structurally, tied to the definition-basis DAG node ids — not prose;
 *  (e) the period count derives from the case's forecast periods, not a
 *      hard-wired 3;
 *  (f) the shadow is additive: stripping it leaves the solution byte-identical
 *      across repeated solves (numbers never move).
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CASH_AGGREGATE_SELECTORS,
  SCHEDULE_ALLOWED_STATES,
  SCHEDULE_TYPED_STATE_SCHEMA_VERSION,
  compileScheduleTypedStates,
  forecastPeriodsOf,
  validateScheduleTypedStates,
} from "./lib/schedule_typed_states.mjs";
import { numericValueOf } from "./lib/typed_financial_value.mjs";
import { INSTRUMENT_PERIOD_DEFINITION_NODES } from "./lib/instrument_period_state.mjs";
import { solveCase } from "./lib/solver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loadFixture = (name) => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(root, "test-fixtures", "cases", `${name}.json`), "utf8"),
  );
  // Maintained fixtures are production-shaped custody inputs; every scenario
  // in this suite is forensic and identifies itself as such.
  fixture.execution_profile = "reference_parity";
  return fixture;
};
const maximal = loadFixture("standard-maximal-v2");
const netCash = loadFixture("standard-net-cash-v2");

const clone = (value) => structuredClone(value);
const near = (left, right, tolerance = 1e-6) =>
  Math.abs(Number(left) - Number(right)) <= tolerance;
let checks = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${label}`);
    throw error;
  }
  checks += 1;
};

const solvedMaximal = solveCase(clone(maximal));
const solvedNetCash = solveCase(clone(netCash));

// A minimal, fully-resolved compiler input for direct mutations.
const directInput = () => ({
  period_id: "2026-12-31",
  period_index: 0,
  period_count: 3,
  rcf: {
    enabled: true,
    instrument_id: "smc_rcf",
    opening_balance: 100,
    draw: 25,
    repayment: 0,
    ending_balance: 125,
  },
  acquisition: {
    enabled: true,
    active: true,
    closes_this_period: true,
    debt_addition: 500,
    debt_proceeds: 500,
    cash_consideration: 700,
    debt_repayment: 0,
    debt_ending_balance: 500,
  },
  cash: {
    ending_cash: 80,
    buckets: [
      {
        bucket_id: "operating",
        label: "Operating cash",
        opening_balance: 60,
        ending_balance: 80,
        available_for_liquidity: true,
        included_in_cash_flow_cash: true,
        net_debt_eligible_percentage: 1,
        interest_eligible_percentage: 1,
      },
      {
        bucket_id: "restricted",
        label: "Restricted cash",
        opening_balance: 10,
        ending_balance: 10,
        available_for_liquidity: false,
        included_in_cash_flow_cash: false,
        net_debt_eligible_percentage: 0,
        interest_eligible_percentage: 0,
      },
    ],
    aggregates: {
      reported_cash: 90,
      cash_flow_cash: 80,
      liquidity_cash: 80,
      net_debt_eligible_cash: 80,
      interest_eligible_cash: 80,
    },
  },
});

// ---------------------------------------------------------------------------
// 1. RED-PROOF: the solver's forecast periods carry the typed-state shadow.
//    Before P4.3 these quantities were bare numbers whose absence/zero/
//    unresolved were indistinguishable.
check("every solved forecast period carries a valid typed-state shadow", () => {
  for (const solved of [solvedMaximal, solvedNetCash]) {
    assert.ok(solved.forecast.length > 0);
    for (const period of solved.forecast) {
      const shadow = period.typed_states;
      assert.ok(shadow, `forecast ${period.period} carries no typed_states shadow`);
      assert.equal(shadow.schema_version, SCHEDULE_TYPED_STATE_SCHEMA_VERSION);
      assert.equal(shadow.period_id, period.period);
      assert.deepEqual(validateScheduleTypedStates(shadow), []);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. RCF draw/repayment/ending are typed derived numbers whose readings equal
//    the numeric schedule fields — never bare, never silently zero.
check("RCF period quantities are typed and agree with the numeric schedule", () => {
  for (const solved of [solvedMaximal, solvedNetCash]) {
    solved.forecast.forEach((period, index) => {
      const rcf = period.typed_states.rcf;
      for (const [slot, numericField] of [
        ["draw", period.rcf_draw],
        ["repayment", period.rcf_repayment],
        ["ending_balance", period.ending_rcf],
      ]) {
        assert.equal(rcf[slot].state, "derived_number", `${slot} in period ${index}`);
        assert.ok(near(numericValueOf(rcf[slot]), numericField));
        assert.ok(rcf[slot].derivation.operator.length > 0);
        assert.ok(Array.isArray(rcf[slot].derivation.refs));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Cash-bucket balances and aggregates are typed and agree with the solver.
check("cash-bucket balances and aggregates are typed and agree", () => {
  for (const period of solvedMaximal.forecast) {
    const cash = period.typed_states.cash;
    assert.ok(near(numericValueOf(cash.ending_cash), period.ending_cash));
    assert.ok(cash.buckets.length > 0, "no typed cash buckets");
    for (const bucket of cash.buckets) {
      assert.equal(bucket.ending_balance.state, "derived_number");
    }
    for (const selector of CASH_AGGREGATE_SELECTORS) {
      const typed = cash.aggregates[selector.aggregate_id];
      assert.equal(typed.state, "derived_number", selector.aggregate_id);
    }
    // eligible cash on the solution face equals the typed aggregate reading.
    assert.ok(
      near(numericValueOf(cash.aggregates.net_debt_eligible_cash), period.eligible_cash),
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Acquisition amounts are typed; pre-close and close periods stay
//    distinguishable through the declared close-state provenance; a case with
//    no acquisition is not_applicable, never a fabricated zero.
check("acquisition amounts typed with close-state provenance", () => {
  const closeIndex = solvedMaximal.forecast.findIndex(
    (period) => Number(period.acquisition_debt_addition) > 0,
  );
  assert.ok(closeIndex >= 0, "maximal fixture must close its acquisition");
  solvedMaximal.forecast.forEach((period, index) => {
    const acq = period.typed_states.acquisition;
    for (const slot of [
      "debt_addition",
      "debt_proceeds",
      "cash_consideration",
      "debt_repayment",
      "debt_ending_balance",
    ]) {
      assert.equal(acq[slot].state, "derived_number", `${slot} @ ${index}`);
    }
    assert.ok(near(numericValueOf(acq.debt_ending_balance), period.acquisition_debt));
    const closeState = acq.debt_addition.derivation.refs.find((ref) =>
      ref.startsWith("acquisition_close_state:"),
    );
    assert.equal(
      closeState,
      `acquisition_close_state:${
        index < closeIndex ? "pre_close" : index === closeIndex ? "closes_this_period" : "post_close"
      }`,
    );
  });
  for (const period of solvedNetCash.forecast) {
    const acq = period.typed_states.acquisition;
    assert.equal(acq.debt_ending_balance.state, "not_applicable");
    assert.equal(numericValueOf(acq.debt_ending_balance), null, "not_applicable must read null, not 0");
  }
});

// ---------------------------------------------------------------------------
// 5. A disabled facility is not_applicable — a missing RCF is not a zero draw.
check("no balancing RCF types as not_applicable, never zero", () => {
  const input = directInput();
  input.rcf = { enabled: false, instrument_id: null };
  const shadow = compileScheduleTypedStates(input);
  for (const slot of ["opening_balance", "draw", "repayment", "ending_balance"]) {
    assert.equal(shadow.rcf[slot].state, "not_applicable");
    assert.equal(numericValueOf(shadow.rcf[slot]), null);
  }
});

// ---------------------------------------------------------------------------
// 6. MUTATION: a bare number smuggled into a typed slot is caught.
check("bare-number smuggle into a typed slot is caught", () => {
  const shadow = clone(compileScheduleTypedStates(directInput()));
  shadow.rcf.draw = 123; // the old world: an untyped number
  const errors = validateScheduleTypedStates(shadow);
  assert.ok(errors.some((error) => error.startsWith("rcf.draw is not a typed financial value")));
});

check("alien state smuggled into a schedule slot is caught", () => {
  const shadow = clone(compileScheduleTypedStates(directInput()));
  shadow.cash.ending_cash = {
    contract_version: "1.0.0",
    state: "reported_zero",
    value: 0,
    raw_text: "0",
  };
  const errors = validateScheduleTypedStates(shadow);
  assert.ok(
    errors.some((error) =>
      error.includes(`may only be ${SCHEDULE_ALLOWED_STATES.join(", ")}`),
    ),
  );
});

// ---------------------------------------------------------------------------
// 7. MUTATION: an unresolved input must NOT surface as a typed zero.
check("unresolved inputs become state unresolved, never typed zero", () => {
  const input = directInput();
  input.rcf.draw = undefined;
  input.cash.buckets[0].ending_balance = Number.NaN;
  delete input.cash.aggregates.interest_eligible_cash;
  const shadow = compileScheduleTypedStates(input);
  for (const slot of [
    shadow.rcf.draw,
    shadow.cash.buckets[0].ending_balance,
    shadow.cash.aggregates.interest_eligible_cash,
  ]) {
    assert.equal(slot.state, "unresolved");
    assert.equal(numericValueOf(slot), null, "unresolved must read null, not 0");
  }
  // And the cross-validator refuses a typed number standing in for an
  // unresolved numeric field.
  const drift = clone(compileScheduleTypedStates(directInput()));
  const errors = validateScheduleTypedStates(drift, { "rcf.draw": undefined });
  assert.ok(errors.some((error) => error.includes("can never surface as a typed value")));
});

check("typed reading disagreeing with the numeric schedule field is caught", () => {
  const shadow = clone(compileScheduleTypedStates(directInput()));
  const errors = validateScheduleTypedStates(shadow, { "rcf.draw": 999 });
  assert.ok(errors.some((error) => error.includes("disagrees with the numeric schedule field")));
});

// ---------------------------------------------------------------------------
// 8. Definition-basis selectors are declared data: structural membership and
//    weighting, tied to real definition-basis DAG node ids — and evaluating
//    the declared selectors reproduces the solver's aggregates.
check("cash selectors are declared data tied to the definition-basis DAG", () => {
  const nodeIds = new Set(INSTRUMENT_PERIOD_DEFINITION_NODES.map((node) => node.node_id));
  const cashNodeIds = INSTRUMENT_PERIOD_DEFINITION_NODES.filter(
    (node) => node.operation === "sum_cash_buckets",
  ).map((node) => node.node_id);
  const declaredNodes = CASH_AGGREGATE_SELECTORS.map((s) => s.definition_basis_node).filter(Boolean);
  // every sum_cash_buckets node in the DAG has a declared structural selector
  assert.deepEqual([...declaredNodes].sort(), [...cashNodeIds].sort());
  for (const node of declaredNodes) assert.ok(nodeIds.has(node));
  for (const selector of CASH_AGGREGATE_SELECTORS) {
    // structural fields only — no prose predicate anywhere on the selector
    assert.ok(selector.membership === null || typeof selector.membership.field === "string");
    assert.ok(selector.weight_field === null || typeof selector.weight_field === "string");
  }
});

check("declared selectors reproduce the solver's aggregates over the detail", () => {
  const withBuckets = clone(maximal);
  withBuckets.cash_policy = {
    buckets: [
      {
        bucket_id: "operating",
        label: "Operating cash",
        historical_year_end: withBuckets.cash_policy.historical_year_end_cash,
        forecast_treatment: "balancing",
        available_for_liquidity: true,
        net_debt_eligible_percentage: 1,
        interest_eligible_percentage: 1,
        cash_yield: withBuckets.cash_policy.cash_yield ?? [0, 0, 0],
      },
      {
        bucket_id: "restricted",
        label: "Restricted deposits",
        historical_year_end: [40, 40, 40],
        forecast_treatment: "hardcode",
        forecast_values: [40, 45, 50],
        available_for_liquidity: false,
        net_debt_eligible_percentage: 0,
        interest_eligible_percentage: 0,
        cash_yield: [0, 0, 0],
      },
    ],
    minimum_cash_override: withBuckets.cash_policy.minimum_cash_override,
  };
  const solved = solveCase(withBuckets);
  for (const period of solved.forecast) {
    const shadow = period.typed_states;
    assert.equal(shadow.cash.buckets.length, 2);
    const detail = new Map(
      period.cash_bucket_balances.map((row) => [row.bucket_id, row]),
    );
    for (const bucket of shadow.cash.buckets) {
      assert.ok(
        near(
          numericValueOf(bucket.ending_balance),
          detail.get(bucket.bucket_id).ending_balance,
        ),
      );
    }
    assert.ok(near(numericValueOf(shadow.cash.aggregates.reported_cash), period.reported_cash));
    assert.ok(near(numericValueOf(shadow.cash.aggregates.liquidity_cash), period.liquidity_cash));
    assert.ok(
      near(
        numericValueOf(shadow.cash.aggregates.interest_eligible_cash),
        period.interest_eligible_cash,
      ),
    );
  }
});

// ---------------------------------------------------------------------------
// 9. The period count derives from the case's forecast periods — the compiler
//    refuses a hard-wired/absent count and the shadow declares the derived one.
check("period count derives from the case, not a hard-wired 3", () => {
  assert.equal(forecastPeriodsOf(maximal).length, 3);
  const fourForecasts = {
    periods: [
      { date: "2023-12-31", status: "historical" },
      { date: "2024-12-31", status: "forecast" },
      { date: "2025-12-31", status: "forecast" },
      { date: "2026-12-31", status: "forecast" },
      { date: "2027-12-31", status: "forecast" },
    ],
  };
  assert.equal(forecastPeriodsOf(fourForecasts).length, 4);
  for (const solved of [solvedMaximal, solvedNetCash]) {
    solved.forecast.forEach((period, index) => {
      assert.equal(period.typed_states.period_index, index);
      assert.equal(period.typed_states.period_count, solved.forecast.length);
    });
  }
  assert.throws(
    () => compileScheduleTypedStates({ ...directInput(), period_count: undefined }),
    /case-derived forecast period count/,
  );
  assert.throws(
    () => compileScheduleTypedStates({ ...directInput(), period_index: 3 }),
    /outside the case's 3 forecast periods/,
  );
});

// ---------------------------------------------------------------------------
// 10. Additive shadow: stripping typed_states leaves the solution
//     byte-identical across repeated solves — the numbers never move.
check("typed shadow is additive; stripped solutions hash identically", () => {
  const strip = (solution) => {
    const copy = { ...solution };
    copy.forecast = solution.forecast.map((period) => {
      const bare = { ...period };
      delete bare.typed_states;
      return bare;
    });
    return crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
  };
  assert.equal(strip(solvedMaximal), strip(solveCase(clone(maximal))));
  assert.equal(strip(solvedNetCash), strip(solveCase(clone(netCash))));
});

console.log(JSON.stringify({ status: "PASS", checks }));
