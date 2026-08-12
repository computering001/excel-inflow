#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStageReceipt, verifyStageReceipt } from "./lib/flow_runtime.mjs";
import {
  assertWorkflowState,
  assertWorkflowTransition,
  normaliseUserFlowResult,
  WORKFLOW_STATE_CONTRACT,
} from "./lib/workflow_state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HASH = "a".repeat(64);
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name, callback) {
  callback();
  passed += 1;
  process.stdout.write(`  PASS  ${name}\n`);
}

function rejects(name, callback, pattern) {
  let error = null;
  try {
    callback();
  } catch (caught) {
    error = caught;
  }
  assert(error && pattern.test(error.message), `${name} did not reject the mutation`);
  passed += 1;
  process.stdout.write(`  PASS  ${name}\n`);
}

pass("canonical contract loads", () => {
  assert(WORKFLOW_STATE_CONTRACT.schema_version === "workflow-state-contract/1.0", "wrong schema");
  for (const layer of ["broker", "dcs", "filings", "attachment", "user_flow", "stage_receipt"]) {
    assert(WORKFLOW_STATE_CONTRACT.layers[layer], `layer registry omits ${layer}`);
  }
});

pass("valid internal and user-owned states are accepted", () => {
  assertWorkflowState("broker", {
    status: "NEEDS_VISION", blockerClass: "INTERNAL_WORK", userBlocking: false,
  });
  assertWorkflowState("dcs", {
    status: "BLOCKED_INPUT", blockerClass: "FATAL_SOURCE", userBlocking: true,
  });
  assertWorkflowState("attachment", {
    status: "PASS", blockerClass: null, userBlocking: false,
  });
  assertWorkflowState("filings", {
    status: "NEEDS_EXTRACTION", blockerClass: "INTERNAL_WORK", userBlocking: false,
  });
});

rejects(
  "internal work cannot masquerade as a user upload blocker",
  () => assertWorkflowState("broker", {
    status: "BLOCKED_INPUT", blockerClass: "INTERNAL_WORK", userBlocking: true,
  }),
  /cannot own blocker class/,
);

rejects(
  "user-blocking boolean cannot disagree with ownership",
  () => assertWorkflowState("dcs", {
    status: "NEEDS_CROSSWALK", blockerClass: "INTERNAL_WORK", userBlocking: true,
  }),
  /disagrees with blocker ownership/,
);

pass("legal resumable transitions are accepted", () => {
  assertWorkflowTransition("broker", "NEEDS_VISION", "NEEDS_CROSSWALK");
  assertWorkflowTransition("dcs", "NEEDS_CROSSWALK_REVIEW", "PASS");
  assertWorkflowTransition("attachment", "BLOCKED_INPUT", "PASS", { reset: true });
  assertWorkflowTransition("filings", "NEEDS_EXTRACTION", "PASS");
  assertWorkflowTransition("user_flow", "ACTION_REQUIRED", "PAUSED");
});

rejects(
  "same-evidence fatal input block cannot silently become pass",
  () => assertWorkflowTransition("attachment", "BLOCKED_INPUT", "PASS"),
  /Illegal attachment workflow transition/,
);

rejects(
  "filing extraction work cannot become a user blocker",
  () => assertWorkflowState("filings", {
    status: "NEEDS_EXTRACTION_REVIEW", blockerClass: "INTERNAL_WORK", userBlocking: true,
  }),
  /disagrees with blocker ownership/,
);

rejects(
  "a delivered run cannot silently regress into an earlier flow state",
  () => assertWorkflowTransition("user_flow", "PASS_PENDING_MANUAL", "BLOCKED"),
  /Illegal user_flow workflow transition/,
);

pass("user-flow normalisation persists typed ownership", () => {
  const decision = normaliseUserFlowResult({
    status: "ACTION_REQUIRED", stage: "decisions", question_count: 1,
  });
  assert(decision.blocker_class === "USER_DECISION", "decision owner missing");
  assert(decision.user_blocking === true, "decision is not user blocking");
  const paused = normaliseUserFlowResult({ status: "PAUSED", stage: "inputs" });
  assert(paused.blocker_class === null && paused.user_blocking === false, "pause owns a blocker");
  const internal = normaliseUserFlowResult({
    status: "BLOCKED", stage: "evidence_review", blocker_class: "INTERNAL_WORK",
  });
  assert(
    internal.user_blocking === false,
    "an internal evidence fixed-point defect surfaced as a user blocker",
  );
});

rejects(
  "an untyped user-flow block is forbidden",
  () => normaliseUserFlowResult({ status: "BLOCKED", stage: "build_checks" }),
  /lacks typed blocker ownership/,
);

rejects(
  "action-required is only legal at the decisions stage",
  () => normaliseUserFlowResult({ status: "ACTION_REQUIRED", stage: "inputs" }),
  /cannot occur at stage/,
);

pass("stage receipts enforce the same stage-state contract", () => {
  const receipt = createStageReceipt({
    runId: "workflow-state-test",
    stageId: "decisions",
    status: "action_required",
    inputHashes: { input: HASH },
    outputHashes: { output: HASH },
  });
  assert(verifyStageReceipt(receipt).ok, "valid receipt failed verification");
});

rejects(
  "stage receipt mutation cannot request a decision at inputs",
  () => createStageReceipt({
    runId: "workflow-state-test",
    stageId: "inputs",
    status: "action_required",
    inputHashes: { input: HASH },
    outputHashes: { output: HASH },
  }),
  /cannot occur at stage/,
);

pass("Python controllers consume the same canonical contract", () => {
  const source = [
    "from workflow_state import assert_state, assert_transition",
    "assert_state('broker', 'NEEDS_VISION', 'INTERNAL_WORK', False)",
    "assert_transition('dcs', 'NEEDS_CROSSWALK', 'PASS')",
    "try:",
    "    assert_state('attachment', 'BLOCKED_INPUT', 'INTERNAL_WORK', True)",
    "except ValueError:",
    "    pass",
    "else:",
    "    raise AssertionError('ownership mutation passed')",
  ].join("\n");
  execFileSync("python3", ["-c", source], {
    cwd: HERE,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: "pipe",
  });
});

process.stdout.write(`\n${passed}/${passed} workflow-state checks passed.\n`);
