#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  AGGRESSIVE_RUNTIME_BUDGETS_MS,
  boundedStageTimeout,
  compileOwnershipPreflightControllerAction,
  compileRuntimeBudgetReceipt,
  DEFAULT_RUNTIME_BUDGETS_MS,
  mandatorySequentialBudgetMs,
  ownershipFailureCancellationPlan,
  remainingRuntimeMs,
  resolveRuntimeBudgetPolicy,
  resolveRuntimeBudgets,
  RUNTIME_BUDGET_PROFILES,
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

// --- Budget profiles: default | aggressive ---------------------------------
check(resolveRuntimeBudgets() === DEFAULT_RUNTIME_BUDGETS_MS, "the no-arg profile is not the shipped default declaration");
check(resolveRuntimeBudgets("default") === DEFAULT_RUNTIME_BUDGETS_MS, "profile 'default' is not the shipped default declaration");
const aggressive = resolveRuntimeBudgets("aggressive");
for (const [stage, expected] of Object.entries(AGGRESSIVE_RUNTIME_BUDGETS_MS)) {
  check(aggressive[stage] === expected, `aggressive ${stage} drifted from its declared tightening`);
}
check(
  ["broker_native_extraction_per_document", "broker_semantic_recovery_per_frontier", "broker_global",
    "end_to_end_target", "end_to_end_hard_ceiling", "heartbeat_interval", "ownership_resolution_after_evidence"]
    .every((key) => aggressive[key] === DEFAULT_RUNTIME_BUDGETS_MS[key]),
  "aggressive must tighten only the mandatory path and inherit every other declared budget",
);
check(Object.keys(RUNTIME_BUDGET_PROFILES).sort().join(",") === "aggressive,default", "unexpected runtime budget profiles appeared");

// The ceiling reconciliation holds for BOTH profiles by construction.
const aggressiveMandatory = mandatorySequentialBudgetMs(aggressive);
check(aggressiveMandatory === 780_000, `aggressive mandatory sequential path is ${aggressiveMandatory}, expected 780000`);
check(mandatorySequentialBudgetMs(DEFAULT_RUNTIME_BUDGETS_MS) === 1_410_000, "default mandatory sequential path drifted");
check(
  aggressiveMandatory <= aggressive.end_to_end_target && aggressive.end_to_end_target <= aggressive.end_to_end_hard_ceiling,
  "the aggressive path does not reconcile against its own target and ceiling",
);
const aggressivePolicy = resolveRuntimeBudgetPolicy(structuredClone(JSON.parse(JSON.stringify(aggressive))));
check(validateRuntimeBudgetPolicy(aggressivePolicy).length === 0, "the aggressive policy did not validate clean");
check(aggressivePolicy.policy_sha256 !== policy.policy_sha256, "the aggressive policy shares the default policy identity");
check(boundedStageTimeout({ policy: aggressivePolicy, stage: "solver", requestedMs: 300_000, controllerStartedEpochMs: 0, nowEpochMs: 0 }) === 60_000,
  "the aggressive solver budget was not enforced through the standard bounding rule");

assert.throws(() => resolveRuntimeBudgets("turbo"), /Unknown runtime budget profile/);
checks += 1;
assert.throws(() => resolveRuntimeBudgets(7), /must be a string/);
checks += 1;

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
  "from run_attachment_evidence_pipeline import lane_timeout_budget, lane_command",
  "root=pathlib.Path(tempfile.mkdtemp(prefix='excel-inflow-budget-'))",
  "def request(name,count):",
  " p=root/name; p.write_text(json.dumps({'documents':[{} for _ in range(count)]})); return p",
  "assert lane_timeout_budget('broker',request('broker-one.json',1)) == 300",
  "assert lane_timeout_budget('broker',request('broker-five.json',5)) == 720",
  "assert lane_timeout_budget('broker',request('broker-fifty.json',50)) == 720",
  "broker=request('broker-command.json',2)",
  "broker_command=lane_command('broker',{'request_path':str(broker)},root,root/'out')",
  "assert broker_command[broker_command.index('--native-timeout-ms')+1] == '120000'",
  "assert broker_command[broker_command.index('--semantic-frontier-timeout-ms')+1] == '180000'",
  "filings=request('filings.json',1)",
  "assert lane_timeout_budget('filings',filings) == 630",
  "command=lane_command('filings',{'request_path':str(filings)},root,root/'out')",
  "assert command[command.index('--source-acquisition-timeout-ms')+1] == '120000'",
  "assert command[command.index('--filing-extraction-timeout-ms')+1] == '480000'",
  "assert lane_timeout_budget('dcs',request('dcs.json',1)) == 180",
].join("\n")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
check(laneProbe.status === 0, `attachment lane budget integration failed: ${laneProbe.stderr}`);

console.log(JSON.stringify({ status: "PASS", checks, mutations_rejected: mutations, violations: 0 }, null, 2));
