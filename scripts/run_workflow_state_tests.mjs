#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStageReceipt,
  verifyStageReceipt,
  visibleJourneyProgress,
} from "./lib/flow_runtime.mjs";
import { inspectScreen, renderStageStatus } from "./lib/flow_screens.mjs";
import {
  assertDeliveryBlocker,
  assertWorkflowState,
  assertWorkflowTransition,
  normaliseUserFlowResult,
  VISIBLE_JOURNEY_CONTRACT,
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
  assert(
    Object.keys(WORKFLOW_STATE_CONTRACT.delivery_blocker_constitution.fatal_reasons).length === 4,
    "delivery blocker constitution must have exactly four fatal reasons",
  );
  assert(
    VISIBLE_JOURNEY_CONTRACT.milestones.length === 6,
    "visible journey must have exactly six milestones",
  );
});

pass("one visible progress scale maps internal checkpoints without leaking stage numbers", () => {
  const evidence = visibleJourneyProgress("evidence_review", "in progress");
  assert(evidence.completed === 4 && evidence.next_milestone === "build", "evidence checkpoint is not positioned before Build");
  const build = visibleJourneyProgress("build_checks", "in progress");
  assert(build.completed === 4 && build.active_milestone === "build", "Build is not the fifth active milestone");
  const buildComplete = visibleJourneyProgress("build_checks", "complete");
  assert(buildComplete.completed === 5 && buildComplete.next_milestone === "deliver", "completed Build does not advance to Deliver");
  const screen = renderStageStatus({
    stageId: "evidence_review",
    status: "in progress",
    summary: "Evidence is being reconciled automatically. No response is required.",
  });
  assert(screen.includes("PROGRESS: 4 OF 6 COMPLETE - BUILD NEXT"), "canonical progress heading is absent");
  assert(!/STAGE\s+\d+\s+OF\s+\d+/i.test(screen), "internal stage numbering leaked to the screen");
});

pass("screen response semantics reject contradictory or ambiguous actions", () => {
  const contradictory = inspectScreen([
    "STATUS: ACTION REQUIRED",
    "No response is required.",
    "NEXT ACTION",
    "Reply CONFIRM.",
  ].join("\n"));
  assert(!contradictory.ok, "contradictory response instructions passed");
  const missingAction = inspectScreen("STATUS: ACTION REQUIRED\nPlease wait.");
  assert(!missingAction.ok, "action-required screen without a reply instrument passed");
  const ambiguousProgress = inspectScreen("STATUS: IN PROGRESS\nPlease wait.");
  assert(!ambiguousProgress.ok, "in-progress screen omitted its no-response contract");
  const competingScale = inspectScreen("STAGE 2 OF 5 - EVIDENCE REVIEW");
  assert(!competingScale.ok, "competing stage scale passed");
});

pass("broker defects degrade and cannot claim a delivery block", () => {
  assertDeliveryBlocker({ blocked: false, domain: "broker_semantics" });
  rejects(
    "broker-only delivery block",
    () => assertDeliveryBlocker({
      blocked: true,
      domain: "broker_table_reconciliation",
      fatalReason: "workbook_delivery_failed",
    }),
    /degradation domain/,
  );
});

pass("only the four declared fatal reasons can block delivery", () => {
  assertDeliveryBlocker({
    blocked: true,
    domain: "economic_graph",
    fatalReason: "equation_system_unsolved",
  });
  rejects(
    "undeclared fatal reason",
    () => assertDeliveryBlocker({
      blocked: true,
      domain: "economic_graph",
      fatalReason: "broker_headers_disagree",
    }),
    /declared fatal reason/,
  );
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

pass("every internal evidence state has a declared route to a closed lane", () => {
  for (const layer of ["broker", "dcs", "filings", "attachment"]) {
    const declaration = WORKFLOW_STATE_CONTRACT.layers[layer];
    const closed = new Set(["PASS", "PASS_DEGRADED"]);
    for (const [state, contract] of Object.entries(declaration.states)) {
      if (contract.user_blocking === true || closed.has(state)) continue;
      const queue = [state];
      const seen = new Set();
      let reachesClosed = false;
      while (queue.length > 0) {
        const current = queue.shift();
        if (seen.has(current)) continue;
        seen.add(current);
        if (closed.has(current)) {
          reachesClosed = true;
          break;
        }
        for (const next of declaration.transitions?.[current] ?? []) queue.push(next);
      }
      assert(reachesClosed, `${layer}.${state} has no declared path to a closed lane`);
    }
  }
});

pass("internal work can never become an action-required user message", () => {
  const action = WORKFLOW_STATE_CONTRACT.layers.user_flow.states.ACTION_REQUIRED;
  assert(
    JSON.stringify(action.blocker_classes) === JSON.stringify(["USER_DECISION"]),
    "ACTION_REQUIRED admits internal work",
  );
  const response = VISIBLE_JOURNEY_CONTRACT.response_contract.ACTION_REQUIRED;
  assert(response.requires_explicit_reply === true, "ACTION_REQUIRED has no reply contract");
  for (const status of ["IN_PROGRESS", "COMPLETE", "BLOCKED_INTERNAL"]) {
    assert(
      VISIBLE_JOURNEY_CONTRACT.response_contract[status].automatic_continuation === true,
      `${status} is not automatic`,
    );
  }
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
    outcome: "broker_preview_blocked",
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
  () => normaliseUserFlowResult({ status: "ACTION_REQUIRED", stage: "build_checks" }),
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
    "from workflow_state import assert_delivery_blocker, assert_state, assert_transition",
    "assert_state('broker', 'NEEDS_VISION', 'INTERNAL_WORK', False)",
    "assert_transition('dcs', 'NEEDS_CROSSWALK', 'PASS')",
    "assert_delivery_blocker(True, 'opening_debt_unresolved', domain='debt')",
    "try:",
    "    assert_delivery_blocker(True, 'workbook_delivery_failed', domain='broker_capture')",
    "except ValueError:",
    "    pass",
    "else:",
    "    raise AssertionError('broker delivery block passed')",
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
