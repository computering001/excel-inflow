#!/usr/bin/env node
/**
 * P6.1 — THE HARD RUNTIME CLOCK.
 *
 * Invariant under test: there is ONE persisted, monotonic runtime clock. A
 * resume, a new turn or a retry can never restore budget that was already
 * spent; every stage consults the same remaining budget; a killed or thrown run
 * still records what it consumed; and the ledger identifies the run it belongs
 * to, so a stale or foreign ledger cannot be adopted.
 *
 * Every check below was RED before the P6.1 repair. The headline reds:
 *  - a SECOND invocation of the real controller restored the whole ceiling,
 *    because the outer controller measured remaining budget from its own
 *    PROCESS start (ACTIVE_PROGRESS_STARTED_EPOCH_MS) instead of from the
 *    persisted ledger;
 *  - a ledger belonging to ANOTHER run, dropped into a reused run directory,
 *    was adopted verbatim (validateLedger checked only schema_version);
 *  - a killed invocation charged NOTHING, so kill/retry loops were free;
 *  - stages 1/2/3/5 never consulted the budget at all.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  RUN_DEADLINE_ENV,
  RUN_DEADLINE_FILE,
  RUN_DEADLINE_SCHEMA,
  RUNTIME_BUDGET_OVERRUN_REASON,
  STAGE_FLOOR_MS,
  STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
  beginComputeSpan,
  bindRunDeadlineIdentity,
  boundedOuterTimeoutMs,
  closeRunDeadline,
  consultStageBudget,
  endComputeSpan,
  openRunDeadline,
  recordComputeSegment,
  remainingComputeMs,
  remainingFloorAllowanceMs,
  validateRunDeadlineLedger,
} from "./lib/run_deadline.mjs";
import {
  DEFAULT_RUNTIME_BUDGETS_MS,
  MANDATORY_SEQUENTIAL_BUDGET_KEYS,
  USER_FLOW_STAGE_BUDGET_KEYS,
  boundedStageTimeout,
  deriveStageBudgetMs,
  mandatorySequentialBudgetMs,
  remainingRuntimeMs,
  resolveRuntimeBudgetPolicy,
} from "./lib/runtime_budget_policy.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CASES = path.resolve(
  process.argv[2] ?? process.env.DEBT_OVERLAY_CASES_DIR ?? path.join(ROOT, "test-fixtures", "cases"),
);

let checks = 0;
const mutationsRejected = [];
function check(condition, label) {
  assert.ok(condition, label);
  checks += 1;
}
/** A mutation is REJECTED when the validator names at least one error key. */
function rejects(mutate, label, expectedKeyPrefix) {
  const errors = validateRunDeadlineLedger(...mutate());
  assert.ok(
    errors.some((key) => key.startsWith(expectedKeyPrefix)),
    `mutation "${label}" was not rejected (expected ${expectedKeyPrefix}, got ${JSON.stringify(errors)})`,
  );
  mutationsRejected.push(label);
  checks += 1;
}

async function readLedger(runDir) {
  return JSON.parse(await fs.readFile(path.join(runDir, RUN_DEADLINE_FILE), "utf8"));
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-hard-clock-"));
try {
  // =====================================================================
  // 1. THE HEADLINE RED: a new invocation must not restore the ceiling.
  // =====================================================================
  // 1a. The arithmetic, isolated. The PROCESS-start form of the clock hands
  //     every invocation the whole ceiling back; the persisted form does not.
  const policy = resolveRuntimeBudgetPolicy();
  const ceiling = policy.budgets_ms.end_to_end_hard_ceiling;
  const firstInvocationStart = 1_000_000;
  const secondInvocationStart = firstInvocationStart + 600_000;
  const processStartRemaining = remainingRuntimeMs({
    policy,
    controllerStartedEpochMs: secondInvocationStart,
    nowEpochMs: secondInvocationStart,
  });
  check(
    processStartRemaining === ceiling,
    "the process-start form of the clock does restore the full ceiling (this is the defect being removed)",
  );
  const persistedRemaining = remainingRuntimeMs({ policy, consumedComputeMs: 600_000 });
  check(
    persistedRemaining === ceiling - 600_000,
    "the persisted form must subtract compute spent by EARLIER invocations",
  );
  check(
    boundedStageTimeout({ policy, stage: "solver", requestedMs: 300_000, consumedComputeMs: ceiling - 10_000 }) === 10_000,
    "a stage timeout must be clamped by the PERSISTED remaining budget",
  );
  check(
    boundedStageTimeout({ policy, stage: "solver", requestedMs: 300_000, consumedComputeMs: ceiling }) === 0,
    "an exhausted persisted ceiling must leave a stage no budget to request",
  );

  // 1a-bis. A budget that cannot be computed must REFUSE, not return NaN. A
  //     non-finite timeout reaching a spawn means "no timeout" — unbounded
  //     compute, the exact failure this layer exists to prevent.
  assert.throws(
    () => remainingRuntimeMs({ policy }),
    /Remaining runtime cannot be computed/,
    "a budget with no usable input must refuse, not return a non-finite number",
  );
  checks += 1;
  const refusal = (() => {
    try {
      remainingRuntimeMs({ policy, controllerStartedEpochMs: undefined });
      return null;
    } catch (error) {
      return error;
    }
  })();
  check(
    refusal?.typed_internal_outcome?.reason_code === "INTERNAL.compiler_or_graph_defect",
    "the refusal must be typed with a registered reason code, not a bare throw",
  );
  check(
    refusal.typed_internal_outcome.earliest_responsible_layer === "runtime_governance" &&
      refusal.typed_internal_outcome.checkpoint_required === true,
    "the refusal must name its layer and carry the registry's custody fields",
  );
  assert.throws(
    () => boundedStageTimeout({ policy, stage: "solver", requestedMs: 30_000 }),
    /Remaining runtime cannot be computed/,
    "a stage timeout with no usable clock input must refuse too",
  );
  checks += 1;
  for (const consumed of [0, 1, 900_000, ceiling, ceiling + 999_999]) {
    check(
      Number.isFinite(remainingRuntimeMs({ policy, consumedComputeMs: consumed })),
      `remaining runtime must be finite for a consumed reading of ${consumed}`,
    );
  }

  // 1b. Neither controller may derive a run's remaining budget from a PROCESS
  //     start any more. This is the exact line that reset the ceiling.
  const vnextSource = await fs.readFile(path.join(HERE, "run_excel_inflow_vnext.mjs"), "utf8");
  check(
    !/controllerStartedEpochMs\s*:/.test(vnextSource),
    "the outer controller must not size any budget from its own process start",
  );
  check(
    /consumedComputeMs\s*:\s*consumedRunComputeMs\(\)|consumedComputeMs,/.test(vnextSource),
    "the outer controller must size budgets from the persisted run clock",
  );
  check(
    vnextSource.includes("openRunDeadline(") && vnextSource.includes(`[RUN_DEADLINE_ENV]: ACTIVE_RUN_DEADLINE.path`),
    "the outer controller must open the persisted clock and hand the SAME ledger to every delegate",
  );

  // 1b-bis. THE PRE-CLOCK PATH. The screen renderer legitimately runs before
  //     any run clock exists: it belongs to no run, so no RUN budget applies
  //     and its own explicit timeout is the bound. The decision is "no budget
  //     before the clock opens", NOT "fall back to a process-start origin" —
  //     that fallback is the reset this package removes. Regression check: the
  //     controller must render a screen with the clock unopened.
  const screen = await exec(process.execPath, [
    path.join(HERE, "test-support", "authenticated_controller_test_harness.mjs"),
    "vnext",
    "--screen",
    "company",
  ], { cwd: ROOT, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  check(screen.stdout.trim().length > 0, "the screen path must render with no run clock open");
  check(
    !/NaN|non-negative finite/.test(`${screen.stdout}${screen.stderr}`),
    "no budget computation on the pre-clock path may produce a non-finite number",
  );
  check(
    /clockOpen\s*&&\s*budgetStage/.test(vnextSource) && /const clockOpen =/.test(vnextSource),
    "the controller must gate budget computation on the clock actually being open",
  );

  // 1c. Behavioural: the real user-flow controller, run TWICE against the same
  //     run directory. Elapsed compute may only grow; remaining may only fall.
  const cleanEvidence = path.join(workspace, "clean-evidence-run.json");
  await exec(process.execPath, [
    path.join(HERE, "run_evidence_run_tests.mjs"),
    CASES,
    "--emit-clean",
    cleanEvidence,
  ], { cwd: ROOT, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });

  const runDir = path.join(workspace, "twice", "run");
  async function driveFlow(target) {
    return exec(process.execPath, [
      path.join(HERE, "test-support", "authenticated_controller_test_harness.mjs"),
      "user_flow",
      cleanEvidence,
      "--out",
      target,
      "--stop-after",
      "decisions",
      "--json",
    ], { cwd: ROOT, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  }
  await driveFlow(runDir);
  const afterFirst = await readLedger(runDir);
  check(
    afterFirst.schema_version === RUN_DEADLINE_SCHEMA,
    "the delivered ledger must carry the current run-deadline schema",
  );
  check(afterFirst.compute_elapsed_ms > 0, "the first invocation must charge real compute to the clock");
  await driveFlow(runDir);
  const afterSecond = await readLedger(runDir);
  check(
    afterSecond.compute_elapsed_ms > afterFirst.compute_elapsed_ms,
    `a second invocation must ADD to the clock, not restore it (${afterFirst.compute_elapsed_ms} -> ${afterSecond.compute_elapsed_ms})`,
  );
  check(
    afterSecond.hard_deadline_compute_ms === afterFirst.hard_deadline_compute_ms,
    "a second invocation must not move the ceiling",
  );
  check(
    validateRunDeadlineLedger(afterSecond, {
      expectedRunId: afterFirst.run_id,
      priorLedger: afterFirst,
    }).length === 0,
    "the twice-run ledger must validate as a lawful successor",
  );

  // 1d. The ledger NAMES what it is measuring: run, controller, source, policy.
  check(afterSecond.run_id === "standard_net_cash_evidence_test", "the ledger must name the run it belongs to");
  check(
    afterSecond.controller_versions.length >= 1 && afterSecond.controller_versions.every((entry) => typeof entry === "string"),
    "the ledger must record which controller version charged it",
  );
  check(
    afterSecond.source_digests.length >= 1,
    "the ledger must record the source tree that charged it",
  );
  check(
    afterSecond.policy_digests.length >= 1,
    "the ledger must record the budget policy it was opened against",
  );

  // =====================================================================
  // 2. EVERY STAGE consults the same remaining budget.
  // =====================================================================
  const consulted = afterFirst.stage_allowances.map((entry) => entry.stage);
  for (const stage of ["inputs", "evidence_review", "decisions"]) {
    check(consulted.includes(stage), `stage ${stage} must consult the one clock before it runs`);
    check(
      afterFirst.segments.some((entry) => entry.label === `stage:${stage}`),
      `stage ${stage} must charge its consumption to the one clock`,
    );
  }
  const flowSource = await fs.readFile(path.join(HERE, "run_user_flow.mjs"), "utf8");
  for (const stage of Object.keys(USER_FLOW_STAGE_BUDGET_KEYS)) {
    check(
      flowSource.includes(`enterFlowStage("${stage}")`),
      `stage ${stage} must be entered through the single clock`,
    );
  }
  check(
    afterFirst.stage_allowances.every((entry) => entry.remaining_ms_at_consult <= ceiling),
    "no stage may be told it has more than the ceiling remaining",
  );
  // Consults are monotone within one invocation: each stage sees LESS left.
  const firstInvocationConsults = afterFirst.stage_allowances.map((entry) => entry.remaining_ms_at_consult);
  check(
    firstInvocationConsults.every((value, index) => index === 0 || value <= firstInvocationConsults[index - 1]),
    "each later stage must see a smaller remaining budget than the stage before it",
  );
  const secondInvocationConsults = afterSecond.stage_allowances.slice(afterFirst.stage_allowances.length);
  check(
    secondInvocationConsults.length > 0 &&
      secondInvocationConsults[0].remaining_ms_at_consult < firstInvocationConsults[0],
    "the FIRST stage of the SECOND invocation must see less budget than the first invocation did",
  );
  check(
    afterSecond.segments.reduce((total, entry) => total + entry.duration_ms, 0) === afterSecond.compute_elapsed_ms,
    "the ledger must reconcile: elapsed compute IS the sum of its labelled segments",
  );
  check(
    afterSecond.segments.every((entry) => typeof entry.label === "string" && entry.label.trim() !== ""),
    "no interval may be unattributed",
  );
  check(
    Object.keys(afterSecond.open_invocations).length === 0,
    "a controller that finished must release its claim on the clock",
  );

  // =====================================================================
  // 3. A FOREIGN LEDGER IS NOT ADOPTED (and does not hand back budget).
  // =====================================================================
  const foreignDir = path.join(workspace, "foreign", "run");
  await fs.mkdir(foreignDir, { recursive: true });
  const foreign = {
    schema_version: RUN_DEADLINE_SCHEMA,
    run_id: "some_other_run_entirely",
    controller_versions: ["forged/9.9"],
    source_digests: ["deadbeef"],
    policy_digests: ["deadbeef"],
    hard_deadline_compute_ms: ceiling,
    target_compute_ms: policy.budgets_ms.end_to_end_target,
    compute_elapsed_ms: 800_000,
    floor_granted_ms: 0,
    floor_allowance_ms: STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    stage_allowances: [{ stage: "inputs", requested_ms: 1, remaining_ms_at_consult: 1, granted_ms: 1, consulted_at: "x" }],
    open_invocations: {},
    segments: [{ label: "someone_elses_stage", duration_ms: 800_000 }],
    deadline_receipts: [{ kind: "someone_elses_receipt" }],
  };
  await fs.writeFile(path.join(foreignDir, RUN_DEADLINE_FILE), `${JSON.stringify(foreign, null, 2)}\n`, "utf8");
  await driveFlow(foreignDir);
  const afterForeign = await readLedger(foreignDir);
  check(
    afterForeign.run_id === "standard_net_cash_evidence_test",
    "a foreign ledger must be re-identified to the run that is actually executing",
  );
  const mismatch = afterForeign.deadline_receipts.find((entry) => entry.kind === "ledger_identity_mismatch");
  check(
    mismatch?.found_run_id === "some_other_run_entirely" && mismatch.expected_run_id === "standard_net_cash_evidence_test",
    "adopting a foreign ledger must be disclosed as a typed identity mismatch",
  );
  check(
    !afterForeign.segments.some((entry) => entry.label === "someone_elses_stage"),
    "a foreign ledger's segments must NOT be adopted",
  );
  check(
    !afterForeign.deadline_receipts.some((entry) => entry.kind === "someone_elses_receipt"),
    "a foreign ledger's receipts must NOT be adopted",
  );
  check(
    !afterForeign.stage_allowances.some((entry) => entry.consulted_at === "x"),
    "a foreign ledger's stage consults must NOT be adopted",
  );
  check(
    afterForeign.compute_elapsed_ms > 800_000,
    "the compute a foreign ledger recorded must be carried forward as SPENT — discarding it would hand the run free budget",
  );
  check(
    afterForeign.segments.some((entry) => entry.label === "foreign_ledger_carried_forward" && entry.duration_ms === 800_000),
    "the carried-forward compute must be named, not folded into an anonymous total",
  );
  check(
    remainingRuntimeMs({ policy, consumedComputeMs: afterForeign.compute_elapsed_ms }) < ceiling - 800_000,
    "a run that inherited a foreign ledger must have LESS budget left, never more",
  );

  // =====================================================================
  // 4. A KILLED RUN STILL RECORDS WHAT IT CONSUMED.
  // =====================================================================
  const killedDir = path.join(workspace, "killed", "run");
  await fs.mkdir(killedDir, { recursive: true });
  const victimScript = path.join(workspace, "victim.mjs");
  await fs.writeFile(victimScript, [
    `import { openRunDeadline } from ${JSON.stringify(path.join(HERE, "lib", "run_deadline.mjs"))};`,
    `await openRunDeadline({ runDir: ${JSON.stringify(killedDir)}, identity: { runId: "killed_run", invocationLabel: "victim" } });`,
    `process.stdout.write("registered\\n");`,
    // Hold the event loop open so the process is genuinely alive to be killed.
    `setInterval(() => {}, 1_000);`,
  ].join("\n"), "utf8");
  const victim = spawn(process.execPath, [victimScript], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error("the victim never registered on the clock")), 30_000);
    victim.stdout.on("data", (chunk) => {
      seen += String(chunk);
      if (seen.includes("registered")) {
        clearTimeout(timer);
        resolve();
      }
    });
    victim.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("the victim exited before registering"));
    });
  });
  const registered = await readLedger(killedDir);
  check(
    Object.keys(registered.open_invocations).length === 1,
    "a running invocation must hold a visible claim on the clock",
  );
  check(registered.compute_elapsed_ms === 0, "the victim has not charged anything yet");
  // Give the kill something to charge, then SIGKILL: no handler can run.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  check(victim.exitCode === null && victim.signalCode === null, "the victim must still be alive to be killed");
  victim.kill("SIGKILL");
  await new Promise((resolve) => {
    if (victim.exitCode !== null || victim.signalCode !== null) resolve();
    else victim.on("exit", resolve);
  });
  check(victim.signalCode === "SIGKILL", "the victim must have died to an unhandleable signal");
  const afterKill = await openRunDeadline({
    runDir: killedDir,
    identity: { runId: "killed_run", invocationLabel: "successor" },
  });
  const orphanReceipt = afterKill.ledger.deadline_receipts.find((entry) => entry.kind === "invocation_not_closed");
  check(
    orphanReceipt?.label === "victim" && orphanReceipt.abandoned_ms >= 1_000,
    "a SIGKILLed invocation must be charged for the compute it abandoned",
  );
  check(
    afterKill.ledger.compute_elapsed_ms >= 1_000,
    "the killed invocation's compute must reach the ceiling, so kill/retry loops are not free",
  );
  check(
    remainingComputeMs(afterKill) < ceiling,
    "a kill must reduce the budget the next attempt is granted",
  );
  check(
    afterKill.ledger.segments.some((entry) => entry.label.startsWith("orphaned_invocation:")),
    "the abandoned compute must be a named segment, not an anonymous adjustment",
  );
  check(
    validateRunDeadlineLedger(afterKill.ledger, { expectedRunId: "killed_run", priorLedger: registered }).length === 0,
    "the post-kill ledger must validate as a lawful successor",
  );
  await closeRunDeadline(afterKill);

  // A THROWN run charges too: drive the real controller into a hard failure
  // and read the clock afterwards.
  const thrownDir = path.join(workspace, "thrown", "run");
  await exec(process.execPath, [
    path.join(HERE, "test-support", "authenticated_controller_test_harness.mjs"),
    "user_flow",
    path.join(workspace, "does-not-exist.json"),
    "--out",
    thrownDir,
    "--json",
  ], { cwd: ROOT, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).then(
    () => { throw new Error("the controller was expected to fail"); },
    () => null,
  );
  const afterThrow = await readLedger(thrownDir);
  check(
    afterThrow.segments.some((entry) => entry.label === "controller_invocation_overhead"),
    "a thrown run must still record what it consumed",
  );
  check(
    Object.keys(afterThrow.open_invocations).length === 0,
    "a thrown run must release its claim on the clock so its successor is not charged twice",
  );

  // =====================================================================
  // 5. STAGE FLOOR: bounded debt, never an unbounded per-call licence, and
  //    never a silent extension of an EXPLICIT operator budget.
  // =====================================================================
  const floorDir = path.join(workspace, "floor");
  const floorState = await openRunDeadline({
    runDir: floorDir,
    identity: { runId: "floor_run", invocationLabel: "floor" },
  });
  check(
    remainingFloorAllowanceMs(floorState) === STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    "a fresh run starts with its whole floor allowance",
  );
  // An explicit operator budget is honoured EXACTLY while budget remains.
  check(
    await boundedOuterTimeoutMs(floorState, {
      stage: "workbook_build_outer",
      requestedMs: 25_000,
      floorMs: Math.min(60_000, 25_000),
    }) === 25_000,
    "an explicit operator budget must be granted exactly, not lifted to the floor",
  );
  await recordComputeSegment(floorState, { label: "burn", durationMs: ceiling });
  check(remainingComputeMs(floorState) === 0, "the ceiling must be exhausted for the floor tests");
  const floorGrants = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    floorGrants.push(await boundedOuterTimeoutMs(floorState, {
      stage: `retry_${attempt}`,
      requestedMs: 1_200_000,
    }));
  }
  check(floorGrants[0] === STAGE_FLOOR_MS, "the first grant past the ceiling is the full stage floor");
  const grantedTotal = floorGrants.reduce((total, value) => total + value, 0);
  check(
    grantedTotal <= STAGE_FLOOR_TOTAL_ALLOWANCE_MS + floorGrants.length,
    `ten retries past the ceiling must not mint ten fresh floors (got ${JSON.stringify(floorGrants)})`,
  );
  check(
    grantedTotal < floorGrants.length * STAGE_FLOOR_MS,
    "the old behaviour — a fresh full floor on every call — must be gone",
  );
  check(
    floorGrants.at(-1) < STAGE_FLOOR_MS,
    "once the floor allowance is spent, later attempts are granted less, not the same 60 seconds again",
  );
  check(
    floorGrants.every((value) => value >= 1),
    "a grant must never be zero: zero means 'no timeout' at the spawn boundary",
  );
  check(
    remainingFloorAllowanceMs(floorState) === 0,
    "the floor allowance must be visibly exhausted, not silently reissued",
  );
  check(
    floorState.ledger.floor_granted_ms <= floorState.ledger.floor_allowance_ms,
    "granted floor debt can never exceed the run's declared floor allowance",
  );
  // An explicit operator budget is still never LIFTED by the floor.
  check(
    await boundedOuterTimeoutMs(floorState, {
      stage: "explicit_small",
      requestedMs: 5_000,
      floorMs: 60_000,
    }) <= 5_000,
    "the floor must never grant more than the caller actually asked for",
  );

  // =====================================================================
  // 6. INTERNAL.runtime_budget_overrun now HAS a producer.
  // =====================================================================
  const registry = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"),
  );
  const registryReasons = registry.reasons ?? registry.reason_codes ?? registry;
  check(
    Object.hasOwn(registryReasons, RUNTIME_BUDGET_OVERRUN_REASON),
    "the overrun reason must be the REGISTERED code, not a new invention",
  );
  const overrun = floorState.ledger.deadline_receipts.find((entry) => entry.kind === "deadline_exceeded");
  check(
    overrun?.reason_code === RUNTIME_BUDGET_OVERRUN_REASON,
    "exceeding the ceiling must produce the registered runtime_budget_overrun code",
  );
  const declared = registryReasons[RUNTIME_BUDGET_OVERRUN_REASON];
  check(
    overrun.checkpoint_required === declared.checkpoint_required &&
      overrun.evidence_preserved === declared.evidence_preserved,
    "the produced overrun must carry the registry's declared custody fields",
  );
  const persistedFloorLedger = await readLedger(floorDir);
  check(
    persistedFloorLedger.deadline_receipts.some((entry) => entry.reason_code === RUNTIME_BUDGET_OVERRUN_REASON),
    "the produced reason code must reach a persisted run artifact, not only memory",
  );
  await closeRunDeadline(floorState);

  // =====================================================================
  // 7. MONOTONICITY: the charge cannot be reduced by moving the wall clock.
  // =====================================================================
  const skewDir = path.join(workspace, "skew");
  const skewState = await openRunDeadline({
    runDir: skewDir,
    identity: { runId: "skew_run", invocationLabel: "skew" },
  });
  const backwards = beginComputeSpan(skewState, "wall_clock_stepped_backwards");
  // Simulate a wall clock that jumped BACK an hour while the span was open.
  backwards.wall_start_ms += 3_600_000;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const charged = await endComputeSpan(skewState, backwards);
  check(charged > 0, "a backwards wall-clock step must not zero out a real compute charge");
  check(
    skewState.ledger.deadline_receipts.some((entry) => entry.kind === "clock_skew_detected"),
    "a wall-clock/monotonic disagreement must be disclosed",
  );
  const forwards = beginComputeSpan(skewState, "wall_clock_stepped_forwards");
  forwards.wall_start_ms -= 600_000;
  const chargedForwards = await endComputeSpan(skewState, forwards);
  check(
    chargedForwards >= 600_000,
    "a forwards wall-clock step is charged at the LARGER reading: a clock step can never create budget",
  );
  await closeRunDeadline(skewState);

  // =====================================================================
  // 8. BUDGETS ARE DERIVED FROM THE REMAINING DEADLINE, and stage-local
  //    budgets can no longer be declared beyond what the run may spend.
  // =====================================================================
  check(
    mandatorySequentialBudgetMs(DEFAULT_RUNTIME_BUDGETS_MS) <= DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling,
    "the mandatory sequential path must fit inside the hard ceiling",
  );
  check(
    MANDATORY_SEQUENTIAL_BUDGET_KEYS.every((key) => Object.hasOwn(DEFAULT_RUNTIME_BUDGETS_MS, key)),
    "every declared mandatory-path key must exist in the policy",
  );
  assert.throws(
    () => resolveRuntimeBudgetPolicy({ filing_extraction: 1_400_000 }),
    "a stage-budget combination the run may not spend must be refused",
  );
  checks += 1;
  check(
    deriveStageBudgetMs({ budgets: DEFAULT_RUNTIME_BUDGETS_MS, stage: "workbook_build", remainingMs: 20_000 }) === 20_000,
    "a stage budget must be derived from the remaining deadline when that is smaller",
  );
  check(
    deriveStageBudgetMs({ budgets: DEFAULT_RUNTIME_BUDGETS_MS, stage: "workbook_build", remainingMs: 900_000 })
      === DEFAULT_RUNTIME_BUDGETS_MS.workbook_build,
    "a stage may never be granted more than its own declared budget",
  );
  const derivedDir = path.join(workspace, "derived");
  const derivedState = await openRunDeadline({
    runDir: derivedDir,
    identity: { runId: "derived_run", invocationLabel: "derived" },
  });
  await recordComputeSegment(derivedState, { label: "prior_turns", durationMs: ceiling - 15_000 });
  check(
    await consultStageBudget(derivedState, { stage: "evidence_review" }) === 15_000,
    "a stage consulted late in a run must be granted only what the run has left",
  );
  await closeRunDeadline(derivedState);

  // =====================================================================
  // 9. ONE CLOCK: a nested controller charges the same ledger, and neither
  //    side's compute can be lost by the other writing a stale copy.
  // =====================================================================
  const sharedDir = path.join(workspace, "shared");
  const parent = await openRunDeadline({
    runDir: sharedDir,
    identity: { runId: "shared_run", invocationLabel: "parent" },
  });
  const parentSpan = beginComputeSpan(parent, "parent_overhead");
  const child = await openRunDeadline({
    runDir: path.join(workspace, "unrelated-child-dir"),
    ledgerPath: parent.path,
    identity: { runId: "shared_run", invocationLabel: "child" },
  });
  check(child.path === parent.path, "a delegate handed a ledger path must charge THAT ledger");
  await recordComputeSegment(child, { label: "child_work", durationMs: 120_000 });
  await closeRunDeadline(child);
  await endComputeSpan(parent, parentSpan);
  const shared = await readLedger(sharedDir);
  check(
    shared.compute_elapsed_ms >= 120_000,
    "a parent writing after its child must not overwrite the child's compute away",
  );
  check(
    shared.segments.some((entry) => entry.label === "child_work"),
    "the child's segment must survive the parent's write",
  );
  check(
    shared.segments.reduce((total, entry) => total + entry.duration_ms, 0) === shared.compute_elapsed_ms,
    "the shared ledger must still reconcile after concurrent appends",
  );
  await closeRunDeadline(parent);
  const sharedPrior = shared;
  const reopened = await openRunDeadline({
    runDir: sharedDir,
    identity: { runId: "shared_run", invocationLabel: "later_turn" },
  });
  check(
    reopened.ledger.compute_elapsed_ms >= sharedPrior.compute_elapsed_ms,
    "a later turn inherits the whole run's compute, both controllers' included",
  );
  // A resume arriving with a BIGGER ceiling cannot buy budget.
  const inflated = await openRunDeadline({
    runDir: sharedDir,
    budgets: { ...DEFAULT_RUNTIME_BUDGETS_MS, end_to_end_hard_ceiling: ceiling * 4 },
    identity: { runId: "shared_run", invocationLabel: "greedy" },
  });
  check(
    inflated.ledger.hard_deadline_compute_ms === ceiling,
    "a resume arriving with a larger policy ceiling must NOT raise the persisted ceiling",
  );
  check(
    inflated.ledger.deadline_receipts.some((entry) => entry.kind === "ceiling_raise_refused"),
    "a refused ceiling raise must be disclosed",
  );
  const deflated = await openRunDeadline({
    runDir: sharedDir,
    budgets: { ...DEFAULT_RUNTIME_BUDGETS_MS, end_to_end_hard_ceiling: 600_000, end_to_end_target: 300_000 },
    identity: { runId: "shared_run", invocationLabel: "tighter" },
  });
  check(
    deflated.ledger.hard_deadline_compute_ms === 600_000,
    "a resume arriving with a SMALLER ceiling must tighten the clock",
  );
  await closeRunDeadline(deflated);

  // A ledger identity may be bound after the clock is open (the controller
  // reads the evidence after it starts the clock) without ever resetting it.
  const lateBindDir = path.join(workspace, "late-bind");
  const lateBind = await openRunDeadline({ runDir: lateBindDir, identity: { invocationLabel: "unbound" } });
  await recordComputeSegment(lateBind, { label: "before_identity", durationMs: 4_000 });
  await bindRunDeadlineIdentity(lateBind, { runId: "late_run", sourceDigest: "abc123" });
  check(lateBind.ledger.run_id === "late_run", "an unbound ledger is claimed by the run that is executing");
  check(lateBind.ledger.compute_elapsed_ms === 4_000, "binding an identity must not reset the clock");
  await closeRunDeadline(lateBind);

  // =====================================================================
  // 10. MUTATIONS. The validator must reject every dishonest ledger.
  // =====================================================================
  const honest = await readLedger(runDir);
  const honestPrior = afterFirst;

  // (a) A SECOND INVOCATION RESTORING BUDGET — the headline defect.
  rejects(
    () => {
      const value = structuredClone(honest);
      value.compute_elapsed_ms = 0;
      value.segments = [];
      return [value, { expectedRunId: honest.run_id, priorLedger: honestPrior }];
    },
    "a successor ledger that restored the whole ceiling",
    "compute_restored",
  );
  rejects(
    () => {
      const value = structuredClone(honest);
      // Elapsed kept honest, history quietly trimmed so a later audit sees less.
      value.segments = value.segments.slice(0, 1);
      return [value, { expectedRunId: honest.run_id, priorLedger: honestPrior }];
    },
    "a successor ledger with the segment history trimmed",
    "segment",
  );
  rejects(
    () => {
      const value = structuredClone(honest);
      value.hard_deadline_compute_ms = honest.hard_deadline_compute_ms * 2;
      return [value, { expectedRunId: honest.run_id, priorLedger: honestPrior }];
    },
    "a successor ledger that raised its own ceiling",
    "ceiling_raised",
  );

  // (b) A FOREIGN LEDGER ADOPTED.
  rejects(
    () => {
      const value = structuredClone(honest);
      value.run_id = "some_other_run_entirely";
      value.deadline_receipts = value.deadline_receipts.filter(
        (entry) => entry.kind !== "ledger_identity_mismatch",
      );
      return [value, { expectedRunId: honest.run_id }];
    },
    "a ledger from another run adopted without disclosure",
    "foreign_ledger_adopted",
  );

  // (c) A KILLED RUN RECORDING NO CONSUMPTION.
  rejects(
    () => {
      const value = structuredClone(afterKill.ledger);
      const orphan = value.segments.find((entry) => entry.label.startsWith("orphaned_invocation:"));
      value.compute_elapsed_ms -= orphan.duration_ms;
      value.segments = value.segments.filter((entry) => entry !== orphan);
      return [value, { expectedRunId: "killed_run" }];
    },
    "a killed invocation disclosed but never charged",
    "unaccounted_invocation",
  );
  rejects(
    () => {
      const value = structuredClone(afterKill.ledger);
      // The registration is simply dropped: no receipt, no segment, no charge.
      value.deadline_receipts = value.deadline_receipts.filter(
        (entry) => entry.kind !== "invocation_not_closed",
      );
      const orphan = value.segments.find((entry) => entry.label.startsWith("orphaned_invocation:"));
      value.compute_elapsed_ms -= orphan.duration_ms;
      value.segments = value.segments.filter((entry) => entry !== orphan);
      return [value, { expectedRunId: "killed_run", priorLedger: registered }];
    },
    "a killed invocation's claim erased with nothing charged",
    "uncharged_invocation_closure",
  );

  // (d) A STAGE THAT DID NOT CONSULT THE BUDGET.
  rejects(
    () => {
      const value = structuredClone(honest);
      value.stage_allowances = value.stage_allowances.filter((entry) => entry.stage !== "decisions");
      return [value, { expectedRunId: honest.run_id }];
    },
    "a stage that consumed compute without consulting the clock",
    "unconsulted_stage",
  );

  // (e) FLOOR DEBT FORGIVEN OR EXCEEDED.
  rejects(
    () => {
      const value = structuredClone(persistedFloorLedger);
      value.floor_granted_ms = value.floor_allowance_ms + 1;
      return [value, { expectedRunId: "floor_run" }];
    },
    "floor debt granted past the run's declared allowance",
    "floor_debt_unbounded",
  );
  rejects(
    () => {
      const value = structuredClone(persistedFloorLedger);
      value.floor_granted_ms = 0;
      return [value, { expectedRunId: "floor_run", priorLedger: persistedFloorLedger }];
    },
    "floor debt forgiven so the next retry can mint a fresh floor",
    "floor_debt_forgiven",
  );

  // (f) UNATTRIBUTED TIME and a ledger that does not add up.
  rejects(
    () => {
      const value = structuredClone(honest);
      value.segments.push({ label: "   ", duration_ms: 30_000 });
      value.compute_elapsed_ms += 30_000;
      return [value, { expectedRunId: honest.run_id }];
    },
    "an unlabelled interval",
    "unlabelled_segment",
  );
  rejects(
    () => {
      const value = structuredClone(honest);
      value.compute_elapsed_ms = Math.floor(value.compute_elapsed_ms / 2);
      return [value, { expectedRunId: honest.run_id }];
    },
    "elapsed compute understated against its own segments",
    "segment_reconciliation",
  );

  // The honest ledgers themselves must pass every rule above.
  check(
    validateRunDeadlineLedger(honest, { expectedRunId: honest.run_id, priorLedger: honestPrior }).length === 0,
    "the honest twice-run ledger must validate",
  );
  check(
    validateRunDeadlineLedger(afterForeign, { expectedRunId: afterForeign.run_id }).length === 0,
    "the quarantined-foreign ledger must validate",
  );
  check(
    validateRunDeadlineLedger(persistedFloorLedger, { expectedRunId: "floor_run" }).length === 0,
    "the floor-debt ledger must validate",
  );
  check(
    validateRunDeadlineLedger(await readLedger(sharedDir), { expectedRunId: "shared_run" }).length === 0,
    "the shared parent/child ledger must validate",
  );
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "PASS",
  checks,
  mutations_rejected: mutationsRejected.length,
  violations: 0,
}));
