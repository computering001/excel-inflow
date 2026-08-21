/**
 * The optional broker lane's circuit breaker.
 *
 * P6.5: this was a ONE-SHOT fallback wearing the name of a breaker — no
 * failure counter, no threshold, no remaining-budget input, no open/half-open
 * state, and a `{circuit_breaker_used, reason_code}` return that its only
 * production call site discarded. It is now a real breaker:
 *
 *  - it COUNTS failures and compares them against a declared threshold,
 *    carrying a prior attempt's count forward instead of starting at zero on
 *    every invocation;
 *  - it takes the REMAINING RUN BUDGET as an input, so an optional lane can be
 *    refused BEFORE it is started rather than after it has spent budget that
 *    mandatory work needed (the minimum is P6.1's stage floor, not a second
 *    number);
 *  - it has three states — closed, open, half-open — and an open breaker
 *    grants exactly ONE trial attempt when budget returns;
 *  - it emits a RECEIPT that can be validated and cannot be silently dropped
 *    (`assertBreakerReceiptCarried`), and it crosswalks its lane-level degrade
 *    reason to the registered terminal reason code, so the four degrade
 *    literals do not need four new registry entries.
 *
 * Defaults reproduce the previous behaviour exactly: one attempt, threshold
 * one, no budget input. Nothing on the certified path changes shape.
 */
import { assertBrokerFailureDegrades } from "./delivery_constitution.mjs";
import { STAGE_FLOOR_MS } from "./run_deadline.mjs";
import { hashValue } from "./run_store.mjs";

const CLOSED = new Set(["PASS", "PASS_DEGRADED"]);

export const BROKER_BREAKER_RECEIPT_SCHEMA = "optional-broker-breaker-receipt/1.1";

/**
 * The declared breaker policy. `minimum_budget_ms` is P6.1's stage floor: an
 * optional lane that cannot be given at least a floor's worth of compute is
 * not started at all.
 */
export const OPTIONAL_BROKER_BREAKER_POLICY = Object.freeze({
  failure_threshold: 1,
  max_attempts: 1,
  minimum_budget_ms: STAGE_FLOOR_MS,
});

/**
 * The four lane-level degrade literals below are DELIVERY-CONSTITUTION degrade
 * reasons, not terminal reason codes. This is the crosswalk to the registered
 * code that already exists, so the breaker's outcome is expressible in the one
 * terminal vocabulary without minting four new codes.
 */
export const BROKER_DEGRADE_REGISTRY_REASON = "DEGRADED.broker_evidence_unavailable";

export const BREAKER_STATES = Object.freeze(["closed", "open", "half_open"]);
export const BREAKER_OPEN_REASONS = Object.freeze(["failure_threshold", "budget_starved"]);

function stateSha256(state) {
  return state && typeof state === "object" && !Array.isArray(state)
    ? hashValue(state)
    : null;
}

function mandatoryLaneBindings(state) {
  return Object.entries(state?.lane_states ?? {})
    .filter(([lane]) => lane !== "broker")
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([lane, laneState]) => ({
      lane,
      pipeline_status: laneState?.pipeline_status ?? null,
      state_sha256: stateSha256(laneState),
    }));
}

function sealReceipt(body) {
  return { ...body, receipt_sha256: hashValue(body) };
}

export function optionalBrokerFailureReason({ error = null, state = null } = {}) {
  const message = String(
    error?.message ?? state?.summary?.message ?? state?.summary?.terminal_reason ?? "",
  ).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "broker_timeout";
  if (state && typeof state === "object" && !Array.isArray(state)) {
    if (state.summary?.terminal_reason === "broker_controller_exception") {
      return "broker_controller_exception";
    }
    if (state.summary?.terminal_reason === "invalid_lane_state") return "broker_invalid_state";
    return "broker_optional_close_failure";
  }
  return error ? "broker_controller_exception" : "broker_invalid_state";
}

function nonNegativeIntegerOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Whether this invocation may attempt the optional primary at all, and in
 * which breaker state it starts. Pure, so the decision is inspectable without
 * running anything.
 */
export function compileBreakerDecision({
  priorReceipt = null,
  remainingBudgetMs = null,
  budgetSliceMs = null,
  minimumBudgetMs = OPTIONAL_BROKER_BREAKER_POLICY.minimum_budget_ms,
} = {}) {
  const remaining = nonNegativeIntegerOrNull(remainingBudgetMs);
  const slice = nonNegativeIntegerOrNull(budgetSliceMs);
  const carriedFailures = nonNegativeIntegerOrNull(priorReceipt?.failure_count) ?? 0;
  const priorState = BREAKER_STATES.includes(priorReceipt?.breaker_state)
    ? priorReceipt.breaker_state
    : "closed";

  // Budget priority is checked BEFORE any attempt: optional work never starts
  // on budget the mandatory path needs.
  const starved = (remaining !== null && remaining < minimumBudgetMs)
    || (slice !== null && slice < minimumBudgetMs);
  if (starved) {
    return {
      breaker_state: "open",
      may_attempt: false,
      attempt_allowance: 0,
      carried_failures: carriedFailures,
      open_reason: "budget_starved",
      remaining_budget_ms: remaining,
      budget_slice_ms: slice,
    };
  }
  // A previously open breaker gets exactly one trial attempt now that budget
  // is available again.
  const halfOpen = priorState === "open" || priorState === "half_open";
  return {
    breaker_state: halfOpen ? "half_open" : "closed",
    may_attempt: true,
    attempt_allowance: halfOpen ? 1 : null,
    carried_failures: carriedFailures,
    open_reason: null,
    remaining_budget_ms: remaining,
    budget_slice_ms: slice,
  };
}

export function validateBrokerBreakerReceipt(receipt) {
  const violations = [];
  if (!receipt || typeof receipt !== "object") return ["the breaker receipt is not an object"];
  if (receipt.schema_version !== BROKER_BREAKER_RECEIPT_SCHEMA) {
    violations.push(`schema_version must be ${BROKER_BREAKER_RECEIPT_SCHEMA}`);
  }
  if (!BREAKER_STATES.includes(receipt.breaker_state)) violations.push("breaker_state is not a declared state");
  for (const field of ["failure_count", "failure_threshold", "attempts", "max_attempts", "minimum_budget_ms"]) {
    if (nonNegativeIntegerOrNull(receipt[field]) === null) violations.push(`${field} must be a non-negative integer`);
  }
  if (receipt.failure_threshold < 1) violations.push("failure_threshold must be at least one");
  if (typeof receipt.zero_authority_executed !== "boolean") violations.push("zero_authority_executed must be a boolean");
  if (receipt.open_reason !== null && !BREAKER_OPEN_REASONS.includes(receipt.open_reason)) {
    violations.push("open_reason is not a declared open reason");
  }
  if (receipt.breaker_state === "open" && receipt.open_reason === null) {
    violations.push("an open breaker must say why it opened");
  }
  if (receipt.reason_code !== null && receipt.registry_reason_code !== BROKER_DEGRADE_REGISTRY_REASON) {
    violations.push("a breaker that fired must crosswalk to the registered terminal reason code");
  }
  if (![0, 1].includes(receipt.zero_authority_retry_count)) {
    violations.push("zero_authority_retry_count must be zero or one");
  }
  if (receipt.zero_authority_executed !== (receipt.zero_authority_retry_count === 1)) {
    violations.push("zero_authority execution and retry count disagree");
  }
  if (!/^[a-f0-9]{64}$/.test(String(receipt.final_state_sha256 ?? ""))) {
    violations.push("final_state_sha256 is not a SHA-256 digest");
  }
  if (!Array.isArray(receipt.mandatory_lane_bindings)) {
    violations.push("mandatory_lane_bindings must be an array");
  } else {
    for (const binding of receipt.mandatory_lane_bindings) {
      if (!binding?.lane || binding.lane === "broker") violations.push("mandatory lane binding is invalid");
      if (receipt.zero_authority_executed && !CLOSED.has(binding?.pipeline_status)) {
        violations.push("a zero-authority retry left a mandatory lane open");
      }
      if (!/^[a-f0-9]{64}$/.test(String(binding?.state_sha256 ?? ""))) {
        violations.push("mandatory lane binding hash is invalid");
      }
    }
  }
  if (!Array.isArray(receipt.trigger_mandatory_lane_bindings)) {
    violations.push("trigger_mandatory_lane_bindings must be an array");
  } else if (
    receipt.zero_authority_executed
    && receipt.trigger_mandatory_lane_bindings.length > 0
    && hashValue(receipt.trigger_mandatory_lane_bindings)
      !== hashValue(receipt.mandatory_lane_bindings)
  ) {
    violations.push("a zero-authority retry changed mandatory lane state");
  }
  const { receipt_sha256: declaredReceiptSha256, ...receiptBody } = receipt;
  if (declaredReceiptSha256 !== hashValue(receiptBody)) {
    violations.push("receipt_sha256 does not bind the breaker receipt body");
  }
  return violations;
}

/**
 * MUTATION GUARD: a call site that keeps only `.state` and drops the receipt.
 * Without this the breaker's whole verdict — how many failures, which state,
 * how much budget was left — is unobservable to the run that depended on it.
 */
export function assertBreakerReceiptCarried(result) {
  const violations = validateBrokerBreakerReceipt(result?.breaker_receipt);
  if (violations.length > 0) {
    throw new Error(
      `The optional broker breaker result carries no usable receipt (${violations.join("; ")}). `
      + "A breaker with no receipt cannot be audited or resumed.",
    );
  }
  return result.breaker_receipt;
}

export async function executeOptionalBrokerCircuitBreaker({
  runPrimary,
  readState,
  runZeroAuthority,
  fingerprintState = null,
  failureThreshold = OPTIONAL_BROKER_BREAKER_POLICY.failure_threshold,
  maxAttempts = OPTIONAL_BROKER_BREAKER_POLICY.max_attempts,
  minimumBudgetMs = OPTIONAL_BROKER_BREAKER_POLICY.minimum_budget_ms,
  remainingBudgetMs = null,
  budgetSliceMs = null,
  priorReceipt = null,
}) {
  const threshold = Math.max(1, Math.floor(Number(failureThreshold) || 1));
  const attemptCeiling = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  const decision = compileBreakerDecision({
    priorReceipt,
    remainingBudgetMs,
    budgetSliceMs,
    minimumBudgetMs,
  });

  let failureCount = decision.carried_failures;
  let attempts = 0;
  let state = null;
  let lastError = null;
  let breakerState = decision.breaker_state;
  let openReason = decision.open_reason;

  const receipt = (extra, finalState = state, triggerState = state) => sealReceipt({
    schema_version: BROKER_BREAKER_RECEIPT_SCHEMA,
    run_id: finalState?.run_id ?? triggerState?.run_id ?? null,
    breaker_state: breakerState,
    failure_count: failureCount,
    failure_threshold: threshold,
    attempts,
    max_attempts: attemptCeiling,
    minimum_budget_ms: minimumBudgetMs,
    remaining_budget_ms: decision.remaining_budget_ms,
    budget_slice_ms: decision.budget_slice_ms,
    prior_breaker_state: BREAKER_STATES.includes(priorReceipt?.breaker_state)
      ? priorReceipt.breaker_state
      : null,
    open_reason: openReason,
    trigger_state_sha256: stateSha256(triggerState),
    final_state_sha256: stateSha256(finalState),
    trigger_mandatory_lane_bindings: mandatoryLaneBindings(triggerState),
    mandatory_lane_bindings: mandatoryLaneBindings(finalState),
    ...extra,
  });

  if (decision.may_attempt) {
    // A half-open breaker gets ONE trial attempt; a closed one gets its
    // declared allowance, bounded by the failure threshold.
    const halfOpen = decision.breaker_state === "half_open";
    const allowance = decision.attempt_allowance === null
      ? attemptCeiling
      : Math.min(attemptCeiling, decision.attempt_allowance);
    // A half-open breaker's single trial is granted regardless of the count it
    // carried in; that trial is the whole point of half-open.
    while (attempts < allowance && (halfOpen || failureCount < threshold)) {
      const beforeFingerprint = fingerprintState ? await fingerprintState() : null;
      attempts += 1;
      let primaryError = null;
      try {
        const primaryExecution = await runPrimary();
        if (primaryExecution && Number(primaryExecution.code) !== 0) {
          primaryError = new Error(
            primaryExecution.stderr || primaryExecution.stdout
            || `optional broker controller exited ${primaryExecution.code}`,
          );
        }
      } catch (error) {
        primaryError = error;
      }
      state = await readState().catch(() => null);
      const afterFingerprint = fingerprintState ? await fingerprintState() : null;
      const stateIsFresh = !fingerprintState || (
        afterFingerprint !== null && afterFingerprint !== beforeFingerprint
      );
      const laneEntries = Object.entries(state?.lane_states ?? {});
      const brokerLanePresent = laneEntries.some(([lane]) => lane === "broker");
      const mandatoryLanesClosed = laneEntries.every(
        ([lane, laneState]) => lane === "broker" || CLOSED.has(laneState?.pipeline_status),
      );
      const nonClosedBrokerOnly = Boolean(
        state
        && laneEntries.some(
          ([lane, laneState]) => lane === "broker"
            && !CLOSED.has(laneState?.pipeline_status)
            && laneState?.blocker_class === "INTERNAL_WORK",
        )
        && mandatoryLanesClosed,
      );
      // A broker lane can close successfully and still poison the later
      // semantic/declaration/ingress join.  That exact post-close state is an
      // optional broker failure only when every mandatory lane is already
      // closed and the aggregate controller owns it as non-user internal
      // work.  The zero-authority run is the bounded counterfactual that
      // proves attribution; exception wording is never consulted.
      const postCloseBrokerFailure = Boolean(
        state
        && brokerLanePresent
        && mandatoryLanesClosed
        && state.pipeline_status !== "PASS"
        && state.blocker_class === "INTERNAL_WORK"
        && state.user_blocking !== true,
      );
      const retryableBrokerFailure = nonClosedBrokerOnly || postCloseBrokerFailure;
      if (state && stateIsFresh && state.pipeline_status === "PASS") {
        // A healthy attempt closes the breaker, whatever it carried in.
        breakerState = "closed";
        openReason = null;
        return {
          state,
          circuit_breaker_used: false,
          reason_code: null,
          breaker_receipt: receipt({
            reason_code: null,
            registry_reason_code: null,
            zero_authority_executed: false,
            zero_authority_retry_count: 0,
          }),
        };
      }
      if (state && stateIsFresh && !retryableBrokerFailure) {
        // A fresh mandatory/user-owned failure is not broker evidence.  Return
        // it untouched so the top-level delivery constitution owns the stop;
        // never use zero broker authority to hide an unrelated defect.
        return {
          state,
          circuit_breaker_used: false,
          reason_code: null,
          breaker_receipt: receipt({
            reason_code: null,
            registry_reason_code: null,
            zero_authority_executed: false,
            zero_authority_retry_count: 0,
          }),
        };
      }
      failureCount += 1;
      lastError = primaryError;
    }
    breakerState = "open";
    openReason = "failure_threshold";
  }

  const reasonCode = decision.may_attempt
    ? optionalBrokerFailureReason({ error: lastError, state })
    // No attempt was made: the optional lane ran out of clock before it began.
    : "broker_timeout";
  assertBrokerFailureDegrades(reasonCode);
  const triggerState = state;
  const beforeZeroAuthorityFingerprint = fingerprintState
    ? await fingerprintState()
    : null;
  const zeroExecution = await runZeroAuthority(reasonCode);
  if (zeroExecution && Number(zeroExecution.code) !== 0) {
    throw new Error(
      zeroExecution.stderr || zeroExecution.stdout
      || `zero-broker authority circuit breaker exited ${zeroExecution.code}`,
    );
  }
  state = await readState();
  const afterZeroAuthorityFingerprint = fingerprintState
    ? await fingerprintState()
    : null;
  const zeroAuthorityStateFresh = !fingerprintState || (
    afterZeroAuthorityFingerprint !== null
    && afterZeroAuthorityFingerprint !== beforeZeroAuthorityFingerprint
  );
  const finalLaneEntries = Object.entries(state?.lane_states ?? {});
  const finalBrokerLane = state?.lane_states?.broker ?? null;
  const zeroAuthorityBrokerClosed = Boolean(
    finalBrokerLane
    && finalBrokerLane.pipeline_status === "PASS_DEGRADED"
    && finalBrokerLane.summary?.fault_contained_to_zero_authority === true,
  );
  const finalMandatoryLanesClosed = finalLaneEntries.every(
    ([lane, laneState]) => lane === "broker" || CLOSED.has(laneState?.pipeline_status),
  );
  if (
    !zeroAuthorityStateFresh
    || state?.pipeline_status !== "PASS"
    || !zeroAuthorityBrokerClosed
    || !finalMandatoryLanesClosed
  ) {
    throw new Error(
      "The zero-broker circuit-breaker process returned without one fresh PASS "
      + "state, closed mandatory lanes and an explicit fault-contained "
      + "PASS_DEGRADED broker lane. Delivery cannot infer zero authority from "
      + "a successful process exit alone.",
    );
  }
  return {
    state,
    circuit_breaker_used: true,
    reason_code: reasonCode,
    breaker_receipt: receipt({
      reason_code: reasonCode,
      registry_reason_code: BROKER_DEGRADE_REGISTRY_REASON,
      zero_authority_executed: true,
      zero_authority_retry_count: 1,
    }, state, triggerState),
  };
}
