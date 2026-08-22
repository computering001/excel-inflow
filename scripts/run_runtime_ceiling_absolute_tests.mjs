#!/usr/bin/env node
/**
 * MP2 E7 — THE ABSOLUTE RUNTIME CEILING, PAST THE FLOOR ALLOWANCE.
 *
 * Invariant under test: the run's compute ceiling is ABSOLUTE once its finite
 * floor allowance is spent. The audit finding this suite pins (§6.7): a
 * per-call stage floor past an exhausted ceiling was an UNBOUNDED licence —
 * every consult minted a fresh 60 seconds, so N retries bought N minutes.
 * The repair grants floor debt from ONE run-wide allowance
 * (STAGE_FLOOR_TOTAL_ALLOWANCE_MS). This probe exhausts the WHOLE envelope —
 * ceiling first, then every millisecond of the allowance — and proves what
 * remains:
 *
 *  A  NO further compute is granted beyond the allowance. Post-allowance
 *     requests decay to the single-millisecond spawn token (never zero: zero
 *     means "no timeout" at a spawn), regardless of how much is requested,
 *     and the sum of post-allowance grants stays bounded by the request count
 *     rather than growing with the requests.
 *  B  Every overrun is TYPED and LEDGER-ACCOUNTED: each post-allowance grant
 *     carries the registered INTERNAL.runtime_budget_overrun receipt naming
 *     the refused debt, and the receipt SURFACES THE ALLOWANCE CONSTANT so an
 *     external observer can verify ceiling respect from the receipt alone;
 *     the persisted ledger validates as lawful.
 *  C  Mandatory constitutional work still completes or pauses lawfully: after
 *     total exhaustion every user-flow stage can still be consulted without
 *     throwing or being granted zero, the overrun outcome keeps its registry
 *     custody fields (checkpoint_required / evidence_preserved), the
 *     enforcement report reads ENFORCED, and closing releases the clock.
 *
 *   node scripts/run_runtime_ceiling_absolute_tests.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RUN_DEADLINE_FILE,
  RUNTIME_BUDGET_OVERRUN_REASON,
  STAGE_FLOOR_MS,
  STAGE_FLOOR_SPAWN_TOKEN_MS,
  STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
  boundedOuterTimeoutMs,
  closeRunDeadline,
  consultStageBudget,
  openRunDeadline,
  recordComputeSegment,
  remainingComputeMs,
  remainingFloorAllowanceMs,
  runtimeBudgetOverrunOutcome,
  validateRunDeadlineLedger,
} from "./lib/run_deadline.mjs";
import { DEFAULT_RUNTIME_BUDGETS_MS, USER_FLOW_STAGE_BUDGET_KEYS } from "./lib/runtime_budget_policy.mjs";
import { hardCeilingEnforcementReport } from "./lib/runtime_slo.mjs";

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-ceiling-absolute-"));
try {
  // =======================================================================
  // Setup: exhaust the ceiling with a small policy, then drain EVERY
  // millisecond of the run-wide floor allowance.
  // =======================================================================
  const state = await openRunDeadline({
    runDir: root,
    budgets: { ...DEFAULT_RUNTIME_BUDGETS_MS, end_to_end_target: 1_000, end_to_end_hard_ceiling: 2_000 },
    identity: { runId: "absolute_ceiling_run", invocationLabel: "probe" },
  });
  check(state.ledger.floor_allowance_ms === STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    "the ledger must record the run-wide floor allowance constant");
  await recordComputeSegment(state, { label: "burn_the_ceiling", durationMs: remainingComputeMs(state) });
  check(remainingComputeMs(state) === 0, "the ceiling must be exhausted before the allowance is drained");

  const drainGrants = [];
  let drained = 0;
  while (remainingFloorAllowanceMs(state) > 0) {
    const granted = await boundedOuterTimeoutMs(state, {
      stage: `drain_${drainGrants.length}`,
      requestedMs: STAGE_FLOOR_MS,
    });
    drainGrants.push(granted);
    drained += 1;
    check(drained <= STAGE_FLOOR_TOTAL_ALLOWANCE_MS / STAGE_FLOOR_MS + 1,
      "the allowance must be drainable in finitely many full-floor draws");
  }
  check(remainingFloorAllowanceMs(state) === 0 && drained === STAGE_FLOOR_TOTAL_ALLOWANCE_MS / STAGE_FLOOR_MS,
    `the whole allowance must be spendable in ${STAGE_FLOOR_TOTAL_ALLOWANCE_MS / STAGE_FLOOR_MS} full-floor draws`);
  check(drainGrants.every((granted) => granted > 0 && granted <= STAGE_FLOOR_MS),
    "each in-allowance draw grants at most one floor");
  const persistedAfterDrain = JSON.parse(await fs.readFile(path.join(root, RUN_DEADLINE_FILE), "utf8"));
  check(persistedAfterDrain.floor_granted_ms === STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    "every granted floor millisecond must be accounted against the allowance in the persisted ledger");

  // =======================================================================
  // A. Past the exhausted ceiling AND the spent allowance, no compute is
  //    granted: every request decays to the single-millisecond spawn token.
  // =======================================================================
  const POST_ALLOWANCE_CONSULTS = 25;
  const postAllowanceGrants = [];
  for (let attempt = 0; attempt < POST_ALLOWANCE_CONSULTS; attempt += 1) {
    postAllowanceGrants.push(await boundedOuterTimeoutMs(state, {
      stage: `post_allowance_${attempt}`,
      // Vary the ask across four orders of magnitude: greediness must not
      // change what an exhausted run is granted.
      requestedMs: [1_200_000, 3_600_000, 60_000, 5_000][attempt % 4],
    }));
  }
  check(postAllowanceGrants.every((granted) => granted === STAGE_FLOOR_SPAWN_TOKEN_MS),
    `past the spent allowance every grant must collapse to the ${STAGE_FLOOR_SPAWN_TOKEN_MS}ms spawn token, got ${JSON.stringify(postAllowanceGrants)}`);
  const postAllowanceSum = postAllowanceGrants.reduce((total, value) => total + value, 0);
  check(postAllowanceSum === POST_ALLOWANCE_CONSULTS * STAGE_FLOOR_SPAWN_TOKEN_MS,
    `post-allowance compute must be bounded by the consult count (${POST_ALLOWANCE_CONSULTS * STAGE_FLOOR_SPAWN_TOKEN_MS}ms), not by the asks`);
  check(remainingFloorAllowanceMs(state) === 0 && state.ledger.floor_granted_ms === state.ledger.floor_allowance_ms,
    "an exhausted allowance must stay exhausted — no silent reissue");
  const persistedAfterCollapse = JSON.parse(await fs.readFile(path.join(root, RUN_DEADLINE_FILE), "utf8"));
  check(persistedAfterCollapse.floor_granted_ms === STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    "the collapsed grants must not have grown the accounted floor debt");

  // =======================================================================
  // B. Every overrun is typed, ledger-accounted, and self-verifying: the
  //    receipt surfaces the allowance constant so an external observer can
  //    confirm ceiling respect from the receipt alone.
  // =======================================================================
  const overrunReceipts = persistedAfterCollapse.deadline_receipts.filter(
    (receipt) => receipt?.kind === "deadline_exceeded",
  );
  check(overrunReceipts.length === drained + POST_ALLOWANCE_CONSULTS,
    "every grant past the ceiling must leave exactly one deadline_exceeded receipt");
  for (const attempt of Array.from({ length: POST_ALLOWANCE_CONSULTS }, (_, index) => index)) {
    const receipt = overrunReceipts.find((entry) => entry.stage === `post_allowance_${attempt}`);
    check(receipt?.reason_code === RUNTIME_BUDGET_OVERRUN_REASON,
      `post-allowance overrun ${attempt} must carry the registered reason code`);
    check(receipt?.floor_debt_refused_ms > 0 && receipt?.floor_debt_ms === 0,
      `post-allowance overrun ${attempt} must name the refused floor debt, not pretend it was granted`);
    check(receipt?.floor_allowance_ms === STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
      `overrun receipt ${attempt} must surface the allowance constant so observers can verify the ceiling`);
    check(receipt?.floor_granted_ms === STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
      `overrun receipt ${attempt} must surface how much floor has been granted against the allowance`);
    check(
      receipt.checkpoint_required === true && receipt.evidence_preserved === true
        && receipt.earliest_responsible_layer === "runtime_governance",
      `overrun receipt ${attempt} must keep the registry's custody fields`,
    );
  }
  check(validateRunDeadlineLedger(persistedAfterCollapse, {
    expectedRunId: "absolute_ceiling_run",
    priorLedger: persistedAfterDrain,
  }).length === 0, "the fully-exhausted ledger must validate as a lawful successor");

  // The typed outcome helper itself carries the surfaced constants too.
  const outcome = runtimeBudgetOverrunOutcome({ stage: "probe", remainingMs: 0, grantedMs: 1 });
  check(outcome.reason_code === RUNTIME_BUDGET_OVERRUN_REASON && outcome.granted_ms === 1,
    "the typed outcome must identify itself as the registered overrun");

  // =======================================================================
  // C. Mandatory constitutional work still completes or pauses lawfully:
  //    even fully bankrupt, the clock never blocks mandatory work — every
  //    stage is still enterable, the enforcement report reads ENFORCED, and
  //    the invocation can close its claim cleanly.
  // =======================================================================
  for (const stage of Object.keys(USER_FLOW_STAGE_BUDGET_KEYS)) {
    const granted = await consultStageBudget(state, { stage });
    check(Number.isSafeInteger(granted) && granted >= 1,
      `a bankrupt clock must still let mandatory stage ${stage} run lawfully (got ${granted})`);
  }
  const enforcement = hardCeilingEnforcementReport({
    ledger: JSON.parse(await fs.readFile(path.join(root, RUN_DEADLINE_FILE), "utf8")),
    label: "absolute_ceiling_probe",
  });
  check(enforcement.status === "ENFORCED",
    `the fully-exhausted run must read ENFORCED, got violations: ${JSON.stringify(enforcement.violations)}`);
  check(enforcement.observed.floor_allowance_remaining_ms === 0
    && enforcement.observed.grants_past_ceiling > 0
    && enforcement.observed.typed_overrun_receipts >= POST_ALLOWANCE_CONSULTS,
    "the enforcement report must show a drained allowance covered by typed receipts");
  await closeRunDeadline(state);
  const closed = JSON.parse(await fs.readFile(path.join(root, RUN_DEADLINE_FILE), "utf8"));
  check(Object.keys(closed.open_invocations).length === 0,
    "closing after total exhaustion must release the claim on the clock");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks, status: "PASS" }));
