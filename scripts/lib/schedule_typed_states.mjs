/**
 * P4.3 — typed schedule states.
 *
 * Every RCF period quantity (draw, repayment, ending balance), acquisition
 * debt/cash amount and cash-bucket balance the solver produces carries a
 * TYPED financial value (P1.2 vocabulary) with provenance, attached ALONGSIDE
 * the numeric schedule as a dual-read shadow (the P1.8 adapter pattern). The
 * shadow never changes a solved number.
 *
 * Invariants:
 *  - blank / nil / missing / unresolved inputs NEVER surface as typed zero —
 *    a non-finite quantity becomes state `unresolved`, which reads as null;
 *  - an absent facility or disabled acquisition is `not_applicable`, never a
 *    fabricated zero balance;
 *  - the schedule may only claim `derived_number`, `not_applicable` or
 *    `unresolved` — it cannot mint reported_* provenance it does not have;
 *  - cash aggregate membership/weighting is DECLARED DATA
 *    (CASH_AGGREGATE_SELECTORS), evaluated structurally — never prose
 *    string matching against the definition graph's source_selector text;
 *  - the period count derives from the case's forecast periods, never a
 *    hard-wired 3.
 */
import { numericValueOf, typedValue } from "./typed_financial_value.mjs";

export const SCHEDULE_TYPED_STATE_SCHEMA_VERSION = "schedule-typed-states/1.0";

/** The only states a solved schedule quantity may lawfully claim. */
export const SCHEDULE_ALLOWED_STATES = Object.freeze([
  "derived_number",
  "not_applicable",
  "unresolved",
]);

/**
 * Declared, machine-evaluable form of the cash definition-basis selectors
 * this module computes. The prose `source_selector` strings on the definition
 * graph remain documentation; membership and weighting here are structural
 * fields. `definition_basis_node` ties a selector to the definition-basis DAG
 * node it realises (null when the aggregate has no graph node).
 */
export const CASH_AGGREGATE_SELECTORS = Object.freeze([
  Object.freeze({
    aggregate_id: "reported_cash",
    definition_basis_node: null,
    membership: null,
    weight_field: null,
  }),
  Object.freeze({
    aggregate_id: "cash_flow_cash",
    definition_basis_node: null,
    membership: Object.freeze({ field: "included_in_cash_flow_cash", equals: true }),
    weight_field: null,
  }),
  Object.freeze({
    aggregate_id: "liquidity_cash",
    definition_basis_node: "liquidity_cash",
    membership: Object.freeze({ field: "available_for_liquidity", equals: true }),
    weight_field: null,
  }),
  Object.freeze({
    aggregate_id: "net_debt_eligible_cash",
    definition_basis_node: "eligible_cash",
    membership: null,
    weight_field: "net_debt_eligible_percentage",
  }),
  Object.freeze({
    aggregate_id: "interest_eligible_cash",
    definition_basis_node: null,
    membership: null,
    weight_field: "interest_eligible_percentage",
  }),
]);

const AGGREGATE_TOLERANCE = 1e-6;

/** The case's forecast periods — the period count derives from THIS, not 3. */
export function forecastPeriodsOf(modelCase) {
  return (modelCase?.periods ?? []).filter(
    (period) => period?.status === "forecast",
  );
}

/** Structural membership test for one declared selector over one bucket row. */
export function selectorIncludesBucket(selector, bucket) {
  if (!selector.membership) return true;
  return bucket?.[selector.membership.field] === selector.membership.equals;
}

/** Structural weight for one declared selector over one bucket row. */
export function selectorWeightForBucket(selector, bucket) {
  if (!selector.weight_field) return 1;
  const weight = Number(bucket?.[selector.weight_field]);
  return Number.isFinite(weight) ? weight : Number.NaN;
}

/**
 * A solved schedule quantity as a typed value. Anything that is not a finite
 * number the producer actually holds — null, undefined, blank, NaN, a string
 * — is `unresolved`, NEVER zero.
 */
function typedScheduleAmount(raw, operator, refs) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return typedValue("unresolved");
  }
  return typedValue("derived_number", {
    value: raw,
    derivation: { operator, refs: refs.map(String) },
  });
}

function notApplicable() {
  return typedValue("not_applicable");
}

function requirePeriodShape({ period_id, period_index, period_count }) {
  if (typeof period_id !== "string" || period_id.length === 0) {
    throw new Error("schedule typed states require a period_id.");
  }
  if (!Number.isInteger(period_count) || period_count < 1) {
    throw new Error(
      "schedule typed states require the case-derived forecast period count (>= 1); a hard-wired or absent count is refused.",
    );
  }
  if (!Number.isInteger(period_index) || period_index < 0 || period_index >= period_count) {
    throw new Error(
      `schedule typed states period_index ${period_index} is outside the case's ${period_count} forecast periods.`,
    );
  }
}

/**
 * Compile the typed shadow for one solved forecast period.
 *
 * `input` carries the already-solved NUMBERS (the shadow never re-solves):
 *  - rcf: { enabled, instrument_id, opening_balance, draw, repayment, ending_balance }
 *  - acquisition: { enabled, active, closes_this_period, debt_addition,
 *      debt_proceeds, cash_consideration, debt_repayment, debt_ending_balance }
 *  - cash: { ending_cash, buckets: snapshot detail rows, aggregates }
 */
export function compileScheduleTypedStates(input) {
  requirePeriodShape(input);
  const { period_id, period_index, period_count } = input;

  const rcfIn = input.rcf ?? {};
  const rcfRef = `rcf:${rcfIn.instrument_id ?? "none"}`;
  const rcf = rcfIn.enabled
    ? {
        instrument_id: rcfIn.instrument_id ?? null,
        opening_balance: typedScheduleAmount(
          rcfIn.opening_balance,
          "rcf_opening_carryforward",
          [rcfRef, `period:${period_id}`],
        ),
        draw: typedScheduleAmount(rcfIn.draw, "liquidity_waterfall_draw", [
          rcfRef,
          "cash.deficit",
          "rcf.capacity",
        ]),
        repayment: typedScheduleAmount(
          rcfIn.repayment,
          "liquidity_waterfall_repayment",
          [rcfRef, "cash.surplus", "rcf.opening_balance"],
        ),
        ending_balance: typedScheduleAmount(
          rcfIn.ending_balance,
          "rcf_roll_forward",
          ["rcf.opening_balance", "rcf.draw", "rcf.repayment"],
        ),
      }
    : {
        instrument_id: rcfIn.instrument_id ?? null,
        opening_balance: notApplicable(),
        draw: notApplicable(),
        repayment: notApplicable(),
        ending_balance: notApplicable(),
      };

  const acqIn = input.acquisition ?? {};
  const closeState = acqIn.closes_this_period
    ? "closes_this_period"
    : acqIn.active
      ? "post_close"
      : "pre_close";
  const acqRefs = [`acquisition_close_state:${closeState}`, `period:${period_id}`];
  const typedAcq = (raw, operator) =>
    acqIn.enabled ? typedScheduleAmount(raw, operator, acqRefs) : notApplicable();
  const acquisition = {
    debt_addition: typedAcq(acqIn.debt_addition, "acquisition_close_debt_draw"),
    debt_proceeds: typedAcq(acqIn.debt_proceeds, "acquisition_close_debt_proceeds"),
    cash_consideration: typedAcq(
      acqIn.cash_consideration,
      "acquisition_close_cash_consideration",
    ),
    debt_repayment: typedAcq(acqIn.debt_repayment, "acquisition_debt_repayment"),
    debt_ending_balance: typedAcq(
      acqIn.debt_ending_balance,
      "acquisition_debt_roll_forward",
    ),
  };

  const cashIn = input.cash ?? {};
  const bucketRows = Array.isArray(cashIn.buckets) ? cashIn.buckets : [];
  const buckets = bucketRows.map((bucket) => ({
    bucket_id: String(bucket.bucket_id ?? "unknown"),
    label: bucket.label ?? null,
    opening_balance: typedScheduleAmount(
      bucket.opening_balance,
      "cash_bucket_opening_carryforward",
      [`bucket:${bucket.bucket_id}`, `period:${period_id}`],
    ),
    ending_balance: typedScheduleAmount(
      bucket.ending_balance,
      bucket.available_for_liquidity
        ? "liquidity_waterfall_balancing_balance"
        : "cash_bucket_declared_treatment",
      [`bucket:${bucket.bucket_id}`, `period:${period_id}`],
    ),
  }));
  const aggregates = {};
  for (const selector of CASH_AGGREGATE_SELECTORS) {
    const members = bucketRows.filter((bucket) =>
      selectorIncludesBucket(selector, bucket),
    );
    const refs = members.map((bucket) => `bucket:${bucket.bucket_id}`);
    if (selector.weight_field) refs.push(`weight:${selector.weight_field}`);
    const raw = cashIn.aggregates?.[selector.aggregate_id];
    // Structural cross-check: the declared selector, evaluated over the
    // bucket detail, must reproduce the solver's aggregate. A disagreement is
    // a smuggled number, not something to paper over with a typed state.
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const structural = members.reduce((total, bucket) => {
        const ending = Number(bucket.ending_balance);
        return total + ending * selectorWeightForBucket(selector, bucket);
      }, 0);
      if (
        Number.isFinite(structural) &&
        Math.abs(structural - raw) > AGGREGATE_TOLERANCE
      ) {
        throw new Error(
          `cash aggregate ${selector.aggregate_id} (${raw}) does not equal its declared-selector evaluation (${structural}) in ${period_id}.`,
        );
      }
    }
    aggregates[selector.aggregate_id] = typedScheduleAmount(
      raw,
      "cash_bucket_declared_selector_sum",
      refs,
    );
  }
  const cash = {
    ending_cash: typedScheduleAmount(
      cashIn.ending_cash,
      "liquidity_waterfall_balancing_cash",
      [`period:${period_id}`],
    ),
    buckets,
    aggregates,
  };

  const artifact = {
    schema_version: SCHEDULE_TYPED_STATE_SCHEMA_VERSION,
    period_id,
    period_index,
    period_count,
    rcf,
    acquisition,
    cash,
  };
  const errors = validateScheduleTypedStates(artifact);
  if (errors.length > 0) {
    throw new Error(`compiled schedule typed states invalid: ${errors[0]}`);
  }
  return artifact;
}

function* typedSlots(artifact) {
  for (const field of ["opening_balance", "draw", "repayment", "ending_balance"]) {
    yield [`rcf.${field}`, artifact.rcf?.[field]];
  }
  for (const field of [
    "debt_addition",
    "debt_proceeds",
    "cash_consideration",
    "debt_repayment",
    "debt_ending_balance",
  ]) {
    yield [`acquisition.${field}`, artifact.acquisition?.[field]];
  }
  yield ["cash.ending_cash", artifact.cash?.ending_cash];
  const buckets = artifact.cash?.buckets ?? [];
  for (let index = 0; index < buckets.length; index += 1) {
    yield [`cash.buckets[${index}].opening_balance`, buckets[index]?.opening_balance];
    yield [`cash.buckets[${index}].ending_balance`, buckets[index]?.ending_balance];
  }
  for (const selector of CASH_AGGREGATE_SELECTORS) {
    yield [
      `cash.aggregates.${selector.aggregate_id}`,
      artifact.cash?.aggregates?.[selector.aggregate_id],
    ];
  }
}

/**
 * Validate a typed schedule shadow. Returns error strings (empty = valid).
 *
 * Every quantity slot must be a VALID typed financial value in the schedule's
 * allowed vocabulary — a bare number smuggled into a slot is an error, and a
 * typed zero standing where the paired numeric field says otherwise is an
 * error when `expected` (the numeric schedule fields) is supplied.
 * `expected` maps slot paths (as yielded above) to the untyped numbers.
 */
export function validateScheduleTypedStates(artifact, expected = null) {
  const errors = [];
  if (artifact?.schema_version !== SCHEDULE_TYPED_STATE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEDULE_TYPED_STATE_SCHEMA_VERSION}.`);
    return errors;
  }
  try {
    requirePeriodShape(artifact);
  } catch (error) {
    errors.push(error.message);
  }
  for (const [path, slot] of typedSlots(artifact)) {
    let numeric;
    try {
      numeric = numericValueOf(slot); // throws on anything not a valid typed value
    } catch (error) {
      errors.push(`${path} is not a typed financial value: ${error.message}`);
      continue;
    }
    if (!SCHEDULE_ALLOWED_STATES.includes(slot.state)) {
      errors.push(
        `${path} claims state ${slot.state}; a solved schedule quantity may only be ${SCHEDULE_ALLOWED_STATES.join(", ")}.`,
      );
      continue;
    }
    if (expected && Object.hasOwn(expected, path)) {
      const expectedValue = expected[path];
      if (typeof expectedValue === "number" && Number.isFinite(expectedValue)) {
        if (numeric === null || Math.abs(numeric - expectedValue) > AGGREGATE_TOLERANCE) {
          errors.push(
            `${path} typed reading ${numeric} disagrees with the numeric schedule field ${expectedValue}.`,
          );
        }
      } else if (numeric !== null) {
        errors.push(
          `${path} carries a typed number ${numeric} but the numeric schedule field is unresolved — an unresolved input can never surface as a typed value.`,
        );
      }
    }
  }
  return errors;
}
