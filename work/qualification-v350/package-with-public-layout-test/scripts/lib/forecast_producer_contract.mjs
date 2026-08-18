const FORMULA_METHODS = new Set([
  "accounting_identity",
  "driver_formula",
  "roll_forward",
  "seasonal_run_rate",
  "historical_average",
  "historical_trend",
  "carry_forward",
]);

const FINITE_VALUE_METHODS = new Set([
  "contractual_commitment",
  "company_guidance",
  "company_indication",
  "user_assumption",
  "broker_consensus",
]);

export const SCHEDULE_PRODUCER_BY_ROLE = Object.freeze({
  opening_debt: "debt_schedule.opening_debt",
  ending_debt: "debt_schedule.ending_debt",
  gross_debt: "debt_schedule.gross_debt",
  net_debt: "debt_schedule.net_debt",
  interest_income: "interest_schedule.interest_income",
  interest_expense: "interest_schedule.interest_expense",
  cash_interest_paid: "interest_schedule.cash_interest_paid",
  cash_interest_received: "interest_schedule.cash_interest_received",
  net_finance_addback: "interest_schedule.net_finance_addback",
  debt_issuance: "debt_schedule.debt_issuance",
  debt_repayment: "debt_schedule.debt_repayment",
  change_in_debt: "debt_schedule.change_in_debt",
  rcf_draw: "liquidity_schedule.rcf_draw",
  rcf_repayment: "liquidity_schedule.rcf_repayment",
  ending_rcf: "liquidity_schedule.ending_rcf",
  lease_principal: "lease_schedule.lease_principal",
  lease_interest: "lease_schedule.lease_interest",
  lease_liability: "lease_schedule.lease_liability",
  liquidity: "liquidity_schedule.liquidity",
  liquidity_shortfall: "liquidity_schedule.liquidity_shortfall",
  commitment_fee: "liquidity_schedule.commitment_fee",
  non_balancing_cash_bucket_movement:
    "cash_bucket_schedule.non_balancing_cash_bucket_movement",
  non_cash_interest_addback: "interest_schedule.non_cash_interest_addback",
});

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function formulaWitness(state, candidate) {
  const spec = state?.formula_spec ?? candidate?.formula_spec ?? null;
  const intrinsicHistorical = [
    "historical_average",
    "linear_historical_trend",
    "historical_trend",
  ].includes(spec?.operator) && Boolean(spec?.row_id ?? state?.row_id);
  const executable = Boolean(
    spec &&
      typeof spec.operator === "string" &&
      spec.operator.length > 0 &&
      (Array.isArray(spec.refs) || intrinsicHistorical),
  );
  return {
    producer_kind:
      spec?.operator === "prior_period" ? "temporal_roll_forward" : "formula",
    producer_id: executable
      ? `formula:${state?.section}.${state?.row_id}:${spec.operator}`
      : null,
    executable,
    formula_spec: spec ? structuredClone(spec) : null,
    reason: executable ? null : "Formula authority has no executable formula specification.",
  };
}

/**
 * Return the one machine-checkable producer witness for a selected forecast
 * state. A semantic label is never a producer: schedule states must identify
 * the concrete schedule writer, and formula states must carry their formula.
 */
export function forecastProducerWitness(state, candidate = null) {
  const method = state?.method ?? "unresolved";
  if (FORMULA_METHODS.has(method)) return formulaWitness(state, candidate);

  if (method === "actual_plus_remainder") {
    const value = finite(state?.value) ? Number(state.value) : null;
    const bindings = state?.source_bindings ?? candidate?.source_bindings ?? [];
    return {
      producer_kind: "evidence_formula",
      producer_id:
        value !== null && bindings.length > 0
          ? state?.selected_candidate_id ?? null
          : null,
      executable: value !== null && bindings.length > 0,
      value,
      reason:
        value !== null && bindings.length > 0
          ? null
          : "Actual-plus-remainder requires a finite output and bound source evidence.",
    };
  }

  if (method === "schedule_link") {
    const role =
      state?.formula_spec?.semantic_role ??
      candidate?.formula_spec?.semantic_role ??
      state?.semantic_role ??
      state?.row_id;
    const producerId =
      state?.formula_spec?.producer_id ??
      candidate?.formula_spec?.producer_id ??
      SCHEDULE_PRODUCER_BY_ROLE[role] ??
      null;
    return {
      producer_kind: "schedule",
      producer_id: producerId,
      executable: Boolean(producerId),
      formula_spec: state?.formula_spec ?? candidate?.formula_spec ?? null,
      reason: producerId
        ? null
        : `Schedule authority for ${role ?? "unknown role"} names no registered schedule producer.`,
    };
  }

  if (FINITE_VALUE_METHODS.has(method)) {
    const value = finite(state?.value) ? Number(state.value) : null;
    return {
      producer_kind: method === "broker_consensus" ? "broker_value" : "evidence_value",
      producer_id: value === null ? null : state?.selected_candidate_id ?? null,
      executable: value !== null,
      value,
      reason: value === null ? `${method} authority has no finite selected value.` : null,
    };
  }

  if (method === "explicit_zero") {
    return {
      producer_kind: "explicit_zero",
      producer_id: state?.selected_candidate_id ?? "explicit_zero",
      executable: true,
      value: 0,
      reason: null,
    };
  }

  if (["not_separately_forecast", "not_applicable"].includes(method)) {
    return {
      producer_kind: method === "not_applicable" ? "not_applicable" : "captured",
      producer_id: state?.selected_candidate_id ?? method,
      executable: true,
      reason: null,
    };
  }

  return {
    producer_kind: "unresolved",
    producer_id: null,
    executable: false,
    reason: state?.rationale ?? "Forecast authority is unresolved.",
  };
}

export function attachForecastProducerWitness(state, candidate = null) {
  const witness = forecastProducerWitness(state, candidate);
  return { ...state, producer_witness: witness };
}

export default {
  SCHEDULE_PRODUCER_BY_ROLE,
  attachForecastProducerWitness,
  forecastProducerWitness,
};
