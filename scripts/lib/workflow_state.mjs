import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(HERE, "../../assets/workflow-state-contract-v1.json");
export const WORKFLOW_STATE_CONTRACT = Object.freeze(
  JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8")),
);

if (WORKFLOW_STATE_CONTRACT.schema_version !== "workflow-state-contract/1.0") {
  throw new Error("Workflow-state contract has the wrong schema version");
}

const USER_BLOCKERS = new Set(WORKFLOW_STATE_CONTRACT.user_blocking_classes);
const DELIVERY_CONSTITUTION =
  WORKFLOW_STATE_CONTRACT.delivery_blocker_constitution;
const BLOCKED_OUTCOMES =
  DELIVERY_CONSTITUTION?.blocked_outcomes ?? {};
export const DELIVERY_BLOCKED_OUTCOMES = Object.freeze(
  structuredClone(BLOCKED_OUTCOMES),
);

if (
  DELIVERY_CONSTITUTION?.schema_version !==
  "delivery-blocker-constitution/1.0"
) {
  throw new Error("Workflow-state contract has no delivery-blocker constitution");
}

export const DELIVERY_FATAL_REASONS = Object.freeze(
  Object.keys(DELIVERY_CONSTITUTION.fatal_reasons ?? {}),
);

/**
 * Assert the narrow production delivery boundary.
 *
 * Internal controller work remains resumable and broker evidence degrades to
 * the forecast waterfall. A terminal delivery block is legal only when it is
 * assigned to one of the four declared, model-fatal reasons.
 */
export function assertDeliveryBlocker({
  blocked,
  fatalReason = null,
  domain = null,
} = {}) {
  const nonBlocking = new Set(
    DELIVERY_CONSTITUTION.non_delivery_blocking_domains ?? [],
  );
  if (blocked !== true) {
    if (fatalReason !== null) {
      throw new Error("A non-blocked delivery result cannot carry a fatal reason");
    }
    return true;
  }
  if (nonBlocking.has(domain)) {
    throw new Error(`${domain} is a degradation domain, not a delivery blocker`);
  }
  if (!DELIVERY_FATAL_REASONS.includes(fatalReason)) {
    throw new Error(
      `Delivery block must name one declared fatal reason; received ${JSON.stringify(fatalReason)}`,
    );
  }
  return true;
}

export function assertWorkflowState(
  layer,
  { status, blockerClass = null, userBlocking = false, stage = null },
) {
  const declaration = WORKFLOW_STATE_CONTRACT.layers?.[layer];
  if (!declaration) throw new Error(`Unknown workflow-state layer: ${layer}`);
  const state = declaration.states?.[status];
  if (!state) throw new Error(`Unknown ${layer} workflow state: ${status}`);
  if (
    Array.isArray(state.blocker_classes) &&
    !state.blocker_classes.includes(blockerClass)
  ) {
    throw new Error(
      `${layer}.${status} cannot own blocker class ${JSON.stringify(blockerClass)}`,
    );
  }
  if (Object.hasOwn(state, "user_blocking")) {
    const expectedUserBlocking =
      state.user_blocking === null
        ? USER_BLOCKERS.has(blockerClass)
        : state.user_blocking;
    if (userBlocking !== expectedUserBlocking) {
      throw new Error(
        `${layer}.${status} user_blocking=${JSON.stringify(userBlocking)} disagrees with blocker ownership`,
      );
    }
  }
  if (Array.isArray(state.stages) && !state.stages.includes(stage)) {
    throw new Error(`${layer}.${status} cannot occur at stage ${JSON.stringify(stage)}`);
  }
  return true;
}

export function assertWorkflowTransition(
  layer,
  previousStatus,
  nextStatus,
  { reset = false } = {},
) {
  const declaration = WORKFLOW_STATE_CONTRACT.layers?.[layer];
  if (!declaration) throw new Error(`Unknown workflow-state layer: ${layer}`);
  if (!declaration.states?.[nextStatus]) {
    throw new Error(`Unknown ${layer} workflow state: ${nextStatus}`);
  }
  if (previousStatus === null || previousStatus === undefined || reset) return true;
  if (!declaration.states?.[previousStatus]) {
    throw new Error(`Unknown prior ${layer} workflow state: ${previousStatus}`);
  }
  if (!(declaration.transitions?.[previousStatus] ?? []).includes(nextStatus)) {
    throw new Error(
      `Illegal ${layer} workflow transition: ${previousStatus} -> ${nextStatus}`,
    );
  }
  return true;
}

export function normaliseUserFlowResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("User-flow result must be an object");
  }
  const value = { ...result };
  if (value.status === "ACTION_REQUIRED" && value.blocker_class === undefined) {
    value.blocker_class = "USER_DECISION";
  }
  if (value.status === "BLOCKED" && value.blocker_class === undefined) {
    throw new Error(
      `BLOCKED user-flow result at ${value.stage ?? "unknown"} lacks typed blocker ownership`,
    );
  }
  if (value.status === "BLOCKED") {
    const binding = BLOCKED_OUTCOMES[value.outcome];
    if (!binding) {
      throw new Error(
        `BLOCKED user-flow outcome ${JSON.stringify(value.outcome)} is not declared by the delivery-blocker constitution`,
      );
    }
    if (
      value.fatal_reason !== undefined &&
      value.fatal_reason !== binding.fatal_reason
    ) {
      throw new Error(
        `BLOCKED user-flow outcome ${value.outcome} changed its declared fatal reason`,
      );
    }
    if (
      value.blocker_domain !== undefined &&
      value.blocker_domain !== binding.domain
    ) {
      throw new Error(
        `BLOCKED user-flow outcome ${value.outcome} changed its declared blocker domain`,
      );
    }
    value.fatal_reason = binding.fatal_reason;
    value.blocker_domain = binding.domain;
    assertDeliveryBlocker({
      blocked: true,
      fatalReason: value.fatal_reason,
      domain: value.blocker_domain,
    });
  }
  if (["SCREEN", "PAUSED", "PASS_PENDING_MANUAL"].includes(value.status)) {
    if (value.blocker_class !== undefined && value.blocker_class !== null) {
      throw new Error(`${value.status} user-flow result cannot carry a blocker class`);
    }
    value.blocker_class = null;
    if (value.fatal_reason !== undefined || value.blocker_domain !== undefined) {
      throw new Error(`${value.status} user-flow result cannot carry a delivery blocker`);
    }
  }
  value.user_blocking = USER_BLOCKERS.has(value.blocker_class ?? null);
  assertWorkflowState("user_flow", {
    status: value.status,
    blockerClass: value.blocker_class ?? null,
    userBlocking: value.user_blocking,
    stage: value.stage,
  });
  return value;
}
