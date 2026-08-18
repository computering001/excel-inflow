import { assertBrokerFailureDegrades } from "./delivery_constitution.mjs";

const CLOSED = new Set(["PASS", "PASS_DEGRADED"]);

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

export async function executeOptionalBrokerCircuitBreaker({
  runPrimary,
  readState,
  runZeroAuthority,
  fingerprintState = null,
}) {
  const beforeFingerprint = fingerprintState ? await fingerprintState() : null;
  let primaryError = null;
  let primaryExecution = null;
  try {
    primaryExecution = await runPrimary();
    if (primaryExecution && Number(primaryExecution.code) !== 0) {
      primaryError = new Error(
        primaryExecution.stderr || primaryExecution.stdout ||
        `optional broker controller exited ${primaryExecution.code}`,
      );
    }
  } catch (error) {
    primaryError = error;
  }
  let state = await readState().catch(() => null);
  const afterFingerprint = fingerprintState ? await fingerprintState() : null;
  const stateIsFresh = !fingerprintState || (
    afterFingerprint !== null && afterFingerprint !== beforeFingerprint
  );
  const nonClosedBrokerOnly = Boolean(
    state &&
    Object.entries(state.lane_states ?? {}).some(
      ([lane, laneState]) => lane === "broker" &&
        !CLOSED.has(laneState?.pipeline_status) &&
        laneState?.blocker_class === "INTERNAL_WORK",
    ) &&
    Object.entries(state.lane_states ?? {}).every(
      ([lane, laneState]) => lane === "broker" || CLOSED.has(laneState?.pipeline_status),
    ),
  );
  if (state && stateIsFresh && !nonClosedBrokerOnly) {
    return { state, circuit_breaker_used: false, reason_code: null };
  }
  const reasonCode = optionalBrokerFailureReason({ error: primaryError, state });
  assertBrokerFailureDegrades(reasonCode);
  const zeroExecution = await runZeroAuthority(reasonCode);
  if (zeroExecution && Number(zeroExecution.code) !== 0) {
    throw new Error(
      zeroExecution.stderr || zeroExecution.stdout ||
      `zero-broker authority circuit breaker exited ${zeroExecution.code}`,
    );
  }
  state = await readState();
  return { state, circuit_breaker_used: true, reason_code: reasonCode };
}
