import {
  TAX_RATE_POLICY_OPERATOR_LIST,
  isTaxRatePolicyOperator,
} from "./tax_rate_policy.mjs";

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
    "funded_acquisition_consideration",
    "funded_acquisition_debt_proceeds",
    // Tax-rate role policy: the rate is computed from normalized tax/PBT
    // components and carried on the authority as a value; the spec names the
    // policy basis and source row rather than a self-referential average.
    // P3.3: spread from the policy's DECLARED operator list so this literal
    // copy cannot drift away from the vocabulary the policy actually emits.
    ...TAX_RATE_POLICY_OPERATOR_LIST,
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

/**
 * P3.2 — the operators the producer contract can execute from a row's OWN
 * history, with no external reference: naming the operator and the row is
 * enough to reproduce the number. `driver_formula` and `roll_forward` are
 * deliberately absent — they reference other rows, so an unbound spec leaves
 * them genuinely unwitnessed rather than intrinsically executable.
 */
export const INTRINSIC_ROW_HISTORY_OPERATORS = Object.freeze([
  "historical_average",
  "historical_trend",
  "seasonal_run_rate",
  "carry_forward",
]);

/**
 * The DECLARED schedule regions that write economic cells. A region name is a
 * producer only because it appears here; an unlisted region names no producer
 * and its cells are reported unwitnessed rather than assumed owned.
 */
export const SCHEDULE_REGION_WRITERS = Object.freeze([
  "debt_schedule",
  "interest_schedule",
  "lease_schedule",
  "liquidity_schedule",
  "rcf_waterfall",
  "cash_bucket_schedule",
  "leverage_liquidity",
]);

/** The registered schedule producer for a role, or null — never a guess. */
export function scheduleProducerForRole(role) {
  if (typeof role !== "string" || role.length === 0) return null;
  return Object.hasOwn(SCHEDULE_PRODUCER_BY_ROLE, role)
    ? SCHEDULE_PRODUCER_BY_ROLE[role]
    : null;
}

/**
 * The producer witness for one cell of an economic SCHEDULE region (debt,
 * interest, lease, RCF, acquisition, leverage/liquidity). The producer is the
 * registered role writer, else the instrument-scoped writer, else the declared
 * region writer. `active: false` means the case declares the family absent —
 * a typed not_applicable producer verdict, never a fabricated zero.
 */
export function scheduleRegionProducerWitness(input) {
  const rowId = input?.row_id ?? null;
  const region = input?.region ?? null;
  const owner = input?.schedule_owner ?? null;
  const nodeId = input?.model_node_id ?? null;
  const active = input?.active !== false;
  const registered = scheduleProducerForRole(input?.semantic_role ?? rowId);
  const instrumentWriter =
    typeof owner === "string" && owner.startsWith("instrument:")
      ? nodeId ?? owner
      : null;
  const regionWriter =
    typeof owner === "string" && SCHEDULE_REGION_WRITERS.includes(owner)
      ? `${owner}.${rowId}`
      : null;
  const producerId = registered ?? instrumentWriter ?? regionWriter ?? null;
  const bindingSource = registered
    ? "schedule_role_registry"
    : instrumentWriter
      ? "instrument_schedule_writer"
      : regionWriter
        ? "declared_schedule_region_writer"
        : null;
  if (!active) {
    return {
      producer_kind: "not_applicable",
      producer_id: producerId,
      executable: true,
      binding_source: bindingSource ?? "declared_absent_family",
      family_active: false,
      reason: null,
    };
  }
  return {
    producer_kind: "schedule",
    producer_id: producerId,
    executable: producerId !== null,
    binding_source: bindingSource,
    family_active: true,
    reason: producerId === null
      ? `Schedule region ${region ?? "(unnamed)"} names no executable producer for ${rowId ?? "(unnamed row)"}.`
      : null,
  };
}

function rolePolicyClaim(authority) {
  const operator = authority?.formula_spec?.operator ?? null;
  // P3.3: MEMBERSHIP of the tax policy's declared operator vocabulary, not
  // `startsWith("tax_rate_policy")`. "declaredOperator" now means what it
  // says — an operator the policy module actually declares.
  const declaredOperator = isTaxRatePolicyOperator(operator) ? operator : null;
  const payload = authority?.tax_rate_normalization ?? null;
  const ref = authority?.tax_rate_normalization_ref ?? null;
  if (!payload && !ref && !declaredOperator) return null;
  return { payload, ref, declaredOperator };
}

function statementFormulaSpec(row, authority, forecastIndex) {
  return (
    authority?.formula_spec ??
    row?.forecast_period_calculations?.[forecastIndex] ??
    row?.forecast_calculation ??
    row?.calculation ??
    null
  );
}

/**
 * P3.2 — the ONE executable producer witness for one statement row × forecast
 * period. Ownership is established by the producer that actually computes the
 * cell (a registered schedule writer, a concrete formula, a named evidence
 * selection, the tax-rate policy module), never by the method label alone.
 *
 * Nothing here is invented: the formula comes from the authority or the row's
 * own calculation, the value from the authority or the row's own forecast
 * column, the schedule producer from the registered role vocabulary, and the
 * role policy from the normalisation receipt the authority carries. When no
 * producer can be named the witness says so — `executable: false` with a
 * reason — and never claims ownership on a label's word.
 *
 * `historical_count` is the case's historical column count; the forecast
 * column is read at `historical_count + forecast_index`, never at a
 * hard-wired offset.
 */
export function forecastCellProducerWitness(input) {
  const row = input?.row ?? null;
  const authority = input?.authority ?? null;
  const section = input?.section ?? null;
  const forecastIndex = Number.isInteger(input?.forecast_index) ? input.forecast_index : 0;
  const historicalCount = Number.isInteger(input?.historical_count) ? input.historical_count : 0;
  const method = input?.method ?? authority?.method ?? "unresolved";
  const rowId = row?.row_id ?? null;

  const policy = rolePolicyClaim(authority);
  if (policy) {
    const basis = policy.declaredOperator ??
      policy.payload?.policy_id ?? policy.payload?.basis ?? "normalisation_receipt";
    const witnessed = Boolean(policy.payload ?? policy.ref);
    return {
      producer_kind: "role_policy",
      producer_id: witnessed ? `tax_rate_policy:${basis}` : null,
      executable: witnessed,
      binding_source: policy.payload
        ? "tax_rate_normalization_payload"
        : policy.ref
          ? "tax_rate_normalization_ref"
          : null,
      reason: witnessed
        ? null
        : "Role-policy authority carries no tax-rate normalisation receipt or reference.",
    };
  }

  if (FORMULA_METHODS.has(method)) {
    const spec = statementFormulaSpec(row, authority, forecastIndex);
    if (spec) {
      const witness = formulaWitness({ method, section, row_id: rowId, formula_spec: spec });
      if (witness.executable) return { ...witness, binding_source: "declared_row_formula" };
    }
    if (INTRINSIC_ROW_HISTORY_OPERATORS.includes(method) && rowId) {
      return {
        producer_kind: "formula",
        producer_id: `formula:${section}.${rowId}:${method}`,
        executable: true,
        binding_source: "intrinsic_row_history",
        formula_spec: { operator: method, row_id: rowId },
        reason: null,
      };
    }
    return {
      producer_kind: spec?.operator === "prior_period" ? "temporal_roll_forward" : "formula",
      producer_id: null,
      executable: false,
      binding_source: null,
      formula_spec: spec ? structuredClone(spec) : null,
      reason:
        `Formula authority (${method}) names no executable producer: neither the authority nor ` +
        `the row carries a referencing formula, and ${method} is not an intrinsic row-history operator.`,
    };
  }

  const evidenceId = authority?.selected_candidate_id ??
    (authority?.source_kind && authority?.source_id
      ? `${authority.source_kind}:${authority.source_id}`
      : null);
  const state = {
    method,
    section,
    row_id: rowId,
    semantic_role: row?.semantic_role ?? null,
    formula_spec: authority?.formula_spec ?? null,
    value: authority?.value ?? row?.values?.[historicalCount + forecastIndex] ?? null,
    selected_candidate_id: evidenceId,
    source_bindings: authority?.source_bindings ??
      (authority?.source_id ? [{ source_id: authority.source_id }] : []),
    rationale: authority?.note ?? null,
  };
  const witness = forecastProducerWitness(state, null);
  const bindingSource = !witness.executable
    ? null
    : method === "schedule_link"
      ? (authority?.formula_spec?.producer_id ? "declared_schedule_producer" : "schedule_role_registry")
      : ["not_separately_forecast", "not_applicable"].includes(method)
        ? "declared_absence"
        : authority?.value === undefined || authority?.value === null
          ? "row_forecast_column"
          : "authority_value";
  return { ...witness, binding_source: bindingSource };
}

export default {
  INTRINSIC_ROW_HISTORY_OPERATORS,
  SCHEDULE_PRODUCER_BY_ROLE,
  SCHEDULE_REGION_WRITERS,
  attachForecastProducerWitness,
  forecastCellProducerWitness,
  forecastProducerWitness,
  scheduleProducerForRole,
  scheduleRegionProducerWitness,
};
