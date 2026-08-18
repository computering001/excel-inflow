#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  boundedStageTimeout,
  compileOwnershipPreflightControllerAction,
  compileRuntimeBudgetReceipt,
  DEFAULT_RUNTIME_BUDGETS_MS,
  ownershipFailureCancellationPlan,
  remainingRuntimeMs,
  resolveRuntimeBudgetPolicy,
  validateRuntimeBudgetPolicy,
  validateRuntimeBudgetReceipt,
} from "./lib/runtime_budget_policy.mjs";

let checks = 0;
let mutations = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const HERE = path.dirname(fileURLToPath(import.meta.url));

const policy = resolveRuntimeBudgetPolicy();
check(validateRuntimeBudgetPolicy(policy).length === 0, "default runtime budget policy did not validate");
check(policy.budgets_ms.source_acquisition === 120_000, "source acquisition budget drifted");
check(policy.budgets_ms.filing_extraction === 480_000, "filing extraction budget drifted");
check(policy.budgets_ms.broker_native_extraction_per_document === 120_000, "broker document budget drifted");
check(policy.budgets_ms.broker_semantic_recovery_per_frontier === 180_000, "semantic frontier budget drifted");
check(policy.budgets_ms.broker_global === 720_000, "broker global budget drifted");
check(policy.budgets_ms.case_compilation_and_ownership === 90_000, "ownership budget drifted");
check(policy.budgets_ms.solver === 120_000, "solver budget drifted");
check(policy.budgets_ms.workbook_build === 180_000, "workbook budget drifted");
check(policy.budgets_ms.recalculation === 240_000, "recalculation budget drifted");
check(policy.budgets_ms.validation === 180_000, "validation budget drifted");
check(policy.budgets_ms.end_to_end_target === 900_000, "target duration drifted");
check(policy.budgets_ms.end_to_end_hard_ceiling === 1_500_000, "hard ceiling drifted");
check(policy.budgets_ms.heartbeat_interval === 25_000, "heartbeat is not within the required interval");
check(policy.budgets_ms.ownership_resolution_after_evidence === 120_000, "ownership blocker SLO drifted");

const overridden = resolveRuntimeBudgetPolicy({ solver: 90_000 });
check(overridden.budgets_ms.solver === 90_000, "lawful override was ignored");
check(overridden.policy_sha256 !== policy.policy_sha256, "override did not alter policy identity");

const started = 1_000_000;
check(remainingRuntimeMs({ policy, controllerStartedEpochMs: started, nowEpochMs: started + 10_000 }) === 1_490_000, "hard deadline remaining time is wrong");
check(boundedStageTimeout({ policy, stage: "solver", requestedMs: 300_000, controllerStartedEpochMs: started, nowEpochMs: started }) === 120_000, "stage budget was not enforced");
check(boundedStageTimeout({ policy, stage: "solver", requestedMs: 300_000, controllerStartedEpochMs: started, nowEpochMs: started + 1_450_000 }) === 50_000, "hard deadline did not shorten stage budget");

const cancellation = ownershipFailureCancellationPlan({ checkpointSha256: "a".repeat(64), descendantPids: [9, 3, 9] });
check(cancellation.preserve_checkpoint && cancellation.broker_restart_allowed === false, "ownership failure would restart or discard custody");
check(cancellation.cancel_descendant_pids.join(",") === "3,9", "descendant cancellation is not deterministic");
check(cancellation.user_reupload_required === false, "ownership failure asks for a re-upload");

const blockedPreflightBody = {
  schema_version: "forecast-ownership-preflight/1.0",
  checkpoint: "B_SELECTED_AUTHORITY",
  status: "BLOCK",
  violations: ["unresolved material ownership"],
  controller_signal: {
    action: "cancel_descendants_preserve_checkpoint",
    reason: "unresolved material ownership",
    resume_from: "selected_forecast_ownership",
  },
};
const blockedPreflight = {
  ...blockedPreflightBody,
  receipt_sha256: createHash("sha256")
    .update(`${JSON.stringify(Object.fromEntries(Object.keys(blockedPreflightBody).sort().map((key) => [key, blockedPreflightBody[key]])))}\n`)
    .digest("hex"),
};
const controllerAction = compileOwnershipPreflightControllerAction({
  preflightReceipt: blockedPreflight,
  checkpointSha256: "c".repeat(64),
  descendantPids: [12, 11],
});
check(controllerAction.controller_signal.resume_from === "selected_forecast_ownership", "controller action lost the preflight resume point");
check(controllerAction.cancellation.broker_restart_allowed === false, "controller action would replay optional broker work");
const forgedPreflight = structuredClone(blockedPreflight);
forgedPreflight.violations.push("forged after sealing");
assert.throws(() => compileOwnershipPreflightControllerAction({
  preflightReceipt: forgedPreflight,
  checkpointSha256: "c".repeat(64),
}));
mutations += 1;

const receipt = compileRuntimeBudgetReceipt({
  policy,
  startedAt: "2026-08-18T09:00:00.000Z",
  endedAt: "2026-08-18T09:01:00.000Z",
  stageExecutions: [{
    stage: "solver",
    budget_ms: policy.budgets_ms.solver,
    duration_ms: 30_000,
    outcome: "PASS",
  }, {
    stage: "broker_global",
    budget_ms: policy.budgets_ms.broker_global,
    duration_ms: 60_000,
    outcome: "TIMEOUT",
    process_tree_termination_verified: true,
    checkpoint_preserved: true,
    evidence_retained: true,
  }],
});
check(validateRuntimeBudgetReceipt(receipt, policy).length === 0, "clean runtime budget receipt did not validate");

for (const mutate of [
  (value) => { value.heartbeat_interval = 30_001; },
  (value) => { value.end_to_end_target = value.end_to_end_hard_ceiling + 1; },
  (value) => { value.ownership_resolution_after_evidence = 120_001; },
  (value) => { value.solver = 0; },
  (value) => { value.unexpected = 1; },
]) {
  const candidate = structuredClone(DEFAULT_RUNTIME_BUDGETS_MS);
  mutate(candidate);
  assert.throws(() => resolveRuntimeBudgetPolicy(candidate));
  mutations += 1;
}

const timeoutWithoutCustody = structuredClone(receipt);
timeoutWithoutCustody.stage_executions[1].process_tree_termination_verified = false;
check(validateRuntimeBudgetReceipt(timeoutWithoutCustody, policy).length > 0, "unverified timeout survivor mutation passed");
mutations += 1;

const stalePolicy = structuredClone(receipt);
stalePolicy.policy_sha256 = "b".repeat(64);
check(validateRuntimeBudgetReceipt(stalePolicy, policy).includes("policy_binding"), "stale policy mutation passed");
mutations += 1;

assert.throws(() => ownershipFailureCancellationPlan({ checkpointSha256: "wrong" }));
mutations += 1;

const python = process.env.EXCEL_INFLOW_TEST_PYTHON ?? process.env.PYTHON ?? "python3";
const laneProbe = spawnSync(python, ["-c", [
  "import json, pathlib, sys, tempfile",
  `sys.path.insert(0, ${JSON.stringify(HERE)})`,
  "from run_attachment_evidence_pipeline import lane_timeout_budget",
  "root=pathlib.Path(tempfile.mkdtemp(prefix='excel-inflow-budget-'))",
  "def request(name,count):",
  " p=root/name; p.write_text(json.dumps({'documents':[{} for _ in range(count)]})); return p",
  "assert lane_timeout_budget('broker',request('broker-one.json',1)) == 300",
  "assert lane_timeout_budget('broker',request('broker-five.json',5)) == 720",
  "assert lane_timeout_budget('broker',request('broker-fifty.json',50)) == 720",
  "assert lane_timeout_budget('filings',request('filings.json',1)) == 600",
  "assert lane_timeout_budget('dcs',request('dcs.json',1)) == 180",
].join("\n")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
check(laneProbe.status === 0, `attachment lane budget integration failed: ${laneProbe.stderr}`);

console.log(JSON.stringify({ status: "PASS", checks, mutations_rejected: mutations, violations: 0 }, null, 2));
