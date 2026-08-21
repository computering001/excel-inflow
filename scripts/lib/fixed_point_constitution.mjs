import { ECONOMIC_SOLVE_POLICY } from "./economic_solve_policy.mjs";
import {
  compileEquationGraphState,
  validateSolverEquationGraphEvidence,
} from "./equation_graph.mjs";

function finite(value) {
  return Number.isFinite(Number(value));
}

function near(left, right, tolerance) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value ?? 0), 0);
}

function statementValue(period, ...roles) {
  for (const role of roles) {
    if (Object.hasOwn(period.statement_values ?? {}, role)) {
      return Number(period.statement_values[role] ?? 0);
    }
  }
  return 0;
}

/**
 * Independently project a solved forecast period onto every canonical
 * zero-when-off economic role.  The projection deliberately consumes the
 * solver's public economic outputs rather than an assertion emitted by the
 * solver itself.
 */
export function circularityZeroRoleValues(period) {
  const instruments = period.instrument_results ?? [];
  const instrumentCashInterest = sum(
    instruments.map((item) => item.cash_coupon_interest_reporting),
  );
  const instrumentPikInterest = sum(
    instruments.map((item) => item.pik_interest_reporting),
  );
  return {
    instrument_cash_interest: instrumentCashInterest,
    instrument_pik_interest: instrumentPikInterest,
    instrument_pik_principal_accretion: sum(
      instruments.map((item) => item.pik_balance_movement_reporting),
    ),
    rcf_interest: Number(period.rcf_interest ?? 0),
    rcf_commitment_fee: Number(period.rcf_commitment_fee ?? 0),
    lease_interest: Number(period.lease_interest ?? 0),
    acquisition_interest: Number(period.acquisition_interest ?? 0),
    other_interest: Number(period.other_interest ?? 0),
    noncash_interest: Number(period.non_cash_interest ?? 0),
    cash_interest_income: Number(period.interest_income ?? 0),
    gross_interest_expense: Number(period.gross_interest ?? 0),
    interest_income: Number(period.interest_income ?? 0),
    net_interest_expense: Number(period.net_interest ?? 0),
    cash_interest_paid: statementValue(
      period,
      "cash_interest_paid",
      "finance_costs_paid",
    ),
    cash_interest_received: statementValue(
      period,
      "cash_interest_received",
      "finance_income_received",
    ),
    noncash_interest_addback:
      Number(period.non_cash_interest ?? 0) +
      Number(period.non_cash_instrument_interest ?? 0),
    net_finance_addback: statementValue(
      period,
      "net_finance_addback",
      "finance_costs_net_addback",
    ),
    income_statement_finance_expense: statementValue(
      period,
      "interest_expense",
    ),
    income_statement_finance_income: statementValue(
      period,
      "interest_income",
    ),
  };
}

/** Public evidence that every live-when-off mechanic still has a runtime
 * value. Instrument-level amortisation and maturity are kept as vectors so a
 * multi-currency case is never falsely aggregated across native currencies. */
export function circularityLiveRoleValues(period) {
  const instruments = period.instrument_results ?? [];
  return {
    debt_issuance: Number(period.non_rcf_debt_issuance ?? 0),
    scheduled_amortisation: instruments.map((item) =>
      Number(item.amortisation_native ?? 0)),
    maturity_repayment: instruments.map((item) =>
      Number(item.maturity_repayment_native ?? 0)),
    lease_principal: Number(period.lease_principal ?? 0),
    mandatory_repayment: Number(period.mandatory_repayment ?? 0),
    minimum_cash: Number(period.minimum_cash ?? 0),
    rcf_capacity: Number(period.rcf_capacity_native ?? 0),
    rcf_draw: Number(period.rcf_draw ?? 0),
    rcf_repayment: Number(period.rcf_repayment ?? 0),
    ending_rcf: Number(period.ending_rcf ?? 0),
    ending_cash: Number(period.ending_cash ?? 0),
    liquidity_shortfall: Number(period.liquidity_shortfall ?? 0),
  };
}

export function validateRcfSweep(period, tolerance, prefix, errors) {
  const averageFx = Number(period.rcf_average_fx ?? 1);
  const openingNative = Number(period.rcf_opening_native ?? 0);
  const capacityNative = Number(period.rcf_capacity_native ?? 0);
  const cashAfterMandatory = Number(period.cash_after_mandatory_repayment ?? 0);
  const minimumCash = Number(period.minimum_cash ?? 0);
  const foreign = String(period.rcf_currency ?? "") !== "" &&
    Math.abs(averageFx - 1) > tolerance;
  const deficit = Math.max(0, minimumCash - cashAfterMandatory);
  const surplus = Math.max(0, cashAfterMandatory - minimumCash);
  const capacityAvailable = Math.max(0, capacityNative - openingNative);
  const expectedDrawNative = foreign
    ? Math.min(deficit / averageFx, capacityAvailable)
    : Math.min(deficit, capacityAvailable);
  const expectedDraw = foreign ? expectedDrawNative * averageFx : expectedDrawNative;
  const expectedRepaymentNative = expectedDraw > tolerance
    ? 0
    : foreign
      ? Math.min(surplus / averageFx, openingNative)
      : Math.min(surplus, openingNative);
  const expectedRepayment = foreign
    ? expectedRepaymentNative * averageFx
    : expectedRepaymentNative;
  const expectedEndingNative =
    openingNative + expectedDrawNative - expectedRepaymentNative;
  const expectedEndingCash =
    cashAfterMandatory + expectedDraw - expectedRepayment;
  const expectedShortfall = Math.max(0, minimumCash - expectedEndingCash);
  for (const [name, actual, expected] of [
    ["rcf_draw_native", period.rcf_draw_native, expectedDrawNative],
    ["rcf_repayment_native", period.rcf_repayment_native, expectedRepaymentNative],
    ["rcf_ending_native", period.rcf_ending_native, expectedEndingNative],
    ["rcf_draw", period.rcf_draw, expectedDraw],
    ["rcf_repayment", period.rcf_repayment, expectedRepayment],
    ["ending_cash", period.ending_cash, expectedEndingCash],
    ["liquidity_shortfall", period.liquidity_shortfall, expectedShortfall],
  ]) {
    // B21(twin) — the reporting-unit rows (draw, repayment, ending cash,
    // shortfall) live in the issuer's reporting currency while the declared
    // tolerance is written against NATIVE units; comparing them unscaled
    // judges those rows `tolerance / averageFx` times stricter than policy
    // intends. Scale the tolerance by |averageFx| for reporting-unit rows —
    // the same state-scale principle P4.9 applies to the convergence
    // criterion — while native rows keep the policy constant untouched.
    const rowTolerance = name.endsWith("_native")
      ? tolerance
      : tolerance * Math.abs(averageFx);
    if (!near(actual, expected, rowTolerance)) {
      errors.push(
        `${prefix}.${name}=${actual} does not match independently recomputed sweep value ${expected}.`,
      );
    }
  }
}

export function validateFixedPointSolution(
  modelCase,
  solution,
  { policy = ECONOMIC_SOLVE_POLICY } = {},
) {
  const errors = [];
  const circularity = Number(modelCase?.controls?.circularity);
  const compiled = compileEquationGraphState({ circularity, policy });
  errors.push(
    ...validateSolverEquationGraphEvidence(solution?.equation_graph_evidence, {
      circularity,
      policy,
    }),
  );
  const declaration = solution?.equation_graph_evidence?.solver_declaration;
  const declaredVector = (declaration?.state_vector ?? []).map((item) => item.node_id);
  const compiledVector = compiled.solver_iteration.state_vector.map(
    (item) => item.node_id,
  );
  if (JSON.stringify(declaredVector) !== JSON.stringify(compiledVector)) {
    errors.push("solver state vector does not exactly equal the compiled active SCC vector.");
  }
  const runtime = solution?.equation_graph_evidence?.solver_runtime ?? {};
  if (Number(runtime.max_iterations) !== Number(policy.solver.max_iterations)) {
    errors.push("solver runtime max_iterations drifted from the canonical solve policy.");
  }
  if (Number(runtime.absolute_tolerance) !== Number(policy.solver.absolute_tolerance)) {
    errors.push("solver runtime absolute_tolerance drifted from the canonical solve policy.");
  }
  if (Number(solution?.convergence_tolerance) !== Number(policy.solver.absolute_tolerance)) {
    errors.push("solution convergence_tolerance drifted from the canonical solve policy.");
  }
  if (solution?.converged !== true) errors.push("solution does not declare convergence.");
  if (!finite(solution?.residual) || Number(solution.residual) > policy.solver.absolute_tolerance) {
    errors.push("solution residual is absent, non-finite or above the canonical tolerance.");
  }
  if (
    !Number.isInteger(Number(solution?.iterations)) ||
    Number(solution.iterations) < 1 ||
    Number(solution.iterations) > policy.solver.max_iterations
  ) {
    errors.push("solution iterations are outside the canonical solve policy.");
  }
  if (circularity === 0 && Number(solution?.iterations) !== 1) {
    errors.push("circularity-off solution must complete one deterministic pass without iteration.");
  }
  if (circularity === 0 && Number(solution?.residual) !== 0) {
    errors.push("circularity-off solution residual must be exactly zero.");
  }

  const zeroRoles = policy.circularity_roles.zero_when_off;
  const liveRoles = policy.circularity_roles.live_when_off;
  for (const [index, period] of (solution?.forecast ?? []).entries()) {
    const prefix = `forecast[${index}]`;
    const zeroValues = circularityZeroRoleValues(period);
    const liveValues = circularityLiveRoleValues(period);
    for (const role of zeroRoles) {
      if (!Object.hasOwn(zeroValues, role) || !finite(zeroValues[role])) {
        errors.push(`${prefix}.${role} has no finite independent role projection.`);
      } else if (
        circularity === 0 &&
        Math.abs(Number(zeroValues[role])) > policy.native_tolerances.currency
      ) {
        errors.push(`${prefix}.${role} is ${zeroValues[role]} with circularity off.`);
      }
    }
    for (const role of liveRoles) {
      const value = liveValues[role];
      const values = Array.isArray(value) ? value : [value];
      if (!Object.hasOwn(liveValues, role) || !values.every(finite)) {
        errors.push(`${prefix}.${role} has no finite live-mechanic evidence.`);
      }
    }
    validateRcfSweep(
      period,
      policy.native_tolerances.currency,
      prefix,
      errors,
    );
  }
  if ((solution?.forecast ?? []).length !== 3) {
    errors.push("fixed-point proof requires exactly three forecast periods.");
  }
  return errors;
}

export function validateCircularityPair(modelCase, onSolution, offSolution) {
  const errors = [];
  const onCase = structuredClone(modelCase);
  onCase.controls.circularity = 1;
  const offCase = structuredClone(modelCase);
  offCase.controls.circularity = 0;
  errors.push(...validateFixedPointSolution(onCase, onSolution).map((item) => `on: ${item}`));
  errors.push(...validateFixedPointSolution(offCase, offSolution).map((item) => `off: ${item}`));
  const tolerance = ECONOMIC_SOLVE_POLICY.native_tolerances.currency;
  const onForecast = onSolution?.forecast ?? [];
  const offForecast = offSolution?.forecast ?? [];
  for (let index = 0; index < Math.min(onForecast.length, offForecast.length); index += 1) {
    const on = onForecast[index];
    const off = offForecast[index];
    for (const field of [
      "non_rcf_debt_issuance",
      "non_rcf_debt_repayment",
      "mandatory_repayment",
      "lease_principal",
    ]) {
      if (!near(on[field], off[field], tolerance)) {
        errors.push(
          `forecast[${index}].${field} changed when only circularity was switched.`,
        );
      }
    }
    const onInstruments = on.instrument_results ?? [];
    const offById = new Map(
      (off.instrument_results ?? []).map((item) => [item.instrument_id, item]),
    );
    for (const item of onInstruments) {
      const other = offById.get(item.instrument_id);
      if (!other) {
        errors.push(`forecast[${index}] lost instrument ${item.instrument_id} in breaker mode.`);
        continue;
      }
      for (const field of [
        "issuance_native",
        "amortisation_native",
        "maturity_repayment_native",
      ]) {
        if (!near(item[field], other[field], tolerance)) {
          errors.push(
            `forecast[${index}].${item.instrument_id}.${field} changed when only circularity was switched.`,
          );
        }
      }
    }
  }
  return errors;
}
