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
  if (["SCREEN", "PAUSED", "PASS_PENDING_MANUAL"].includes(value.status)) {
    if (value.blocker_class !== undefined && value.blocker_class !== null) {
      throw new Error(`${value.status} user-flow result cannot carry a blocker class`);
    }
    value.blocker_class = null;
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
