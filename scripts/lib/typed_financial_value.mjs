/**
 * P1.2 — The typed financial value model's accessor discipline.
 *
 * Invariant: blank, nil, missing, parse failure and unresolved are NEVER
 * treated as zero. The only lawful numeric readings are the value-bearing
 * states; every other state reads as null, and arithmetic over null is the
 * caller's explicit decision, never a silent coercion.
 */
import { validate, CONTRACT_VERSION } from "./generated/typed_financial_value_contract.mjs";

export const VALUE_BEARING_STATES = Object.freeze([
  "reported_number", "reported_zero", "prior_filing_support", "derived_number",
]);
export const NEVER_ZERO_STATES = Object.freeze([
  "reported_blank", "nil", "missing", "parse_failure",
  "period_support_required", "captured", "not_applicable", "unresolved",
]);

/**
 * The single lawful numeric reading. A non-value-bearing state returns null —
 * never zero, never NaN-as-zero. An invalid object THROWS: reading a number
 * out of an unvalidated shape is exactly the drift Phase 1 removes.
 */
export function numericValueOf(typedValue) {
  const errors = validate(typedValue);
  if (errors.length > 0) {
    throw new Error(`typed_financial_value invalid: ${errors[0]}`);
  }
  return VALUE_BEARING_STATES.includes(typedValue.state) ? typedValue.value : null;
}

/** Construct a typed value with the current contract version stamped. */
export function typedValue(state, fields = {}) {
  const candidate = { contract_version: CONTRACT_VERSION, state, ...fields };
  const errors = validate(candidate);
  if (errors.length > 0) {
    throw new Error(`typed_financial_value construction invalid (${state}): ${errors[0]}`);
  }
  return candidate;
}
