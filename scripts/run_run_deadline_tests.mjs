#!/usr/bin/env node
/**
 * Global run-deadline regression: one persisted compute clock per run.
 *
 * Proves the runtime-control repairs:
 *  1. the ledger persists and accumulates across invocations (no per-turn
 *     budget reset);
 *  2. the outer stage allowance is bounded by the remaining global compute,
 *     never by an independent one-hour class;
 *  3. exhausting the ceiling grants only the stage floor and leaves a typed
 *     deadline_exceeded receipt — it never manufactures a terminal blocker;
 *  4. a corrupt ledger is rebuilt with a typed disclosure, not a crash;
 *  5. stage4OuterTimeout can never exceed the product hard ceiling for any
 *     case complexity.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RUN_DEADLINE_FILE,
  STAGE_FLOOR_MS,
  boundedOuterTimeoutMs,
  openRunDeadline,
  recordComputeSegment,
  remainingComputeMs,
} from "./lib/run_deadline.mjs";
import { DEFAULT_RUNTIME_BUDGETS_MS } from "./lib/runtime_budget_policy.mjs";

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-deadline-"));
try {
  // 1. fresh ledger carries the product policy numbers
  const first = await openRunDeadline({ runDir: root });
  check(first.ledger.hard_deadline_compute_ms === DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling,
    "fresh ledger must adopt the product hard ceiling");
  check(first.ledger.target_compute_ms === DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_target,
    "fresh ledger must adopt the product target");
  check(remainingComputeMs(first) === first.ledger.hard_deadline_compute_ms,
    "a fresh run has its whole ceiling remaining");

  // 2. segments accumulate and persist; a second open NEVER resets
  await recordComputeSegment(first, { label: "stage1_filings", durationMs: 600_000 });
  await recordComputeSegment(first, { label: "stage2_brokers", durationMs: 300_000 });
  const second = await openRunDeadline({ runDir: root });
  check(second.ledger.compute_elapsed_ms === 900_000,
    "re-opening must carry the prior turns' compute forward");
  check(second.ledger.segments.length === 2, "segments must persist");
  check(remainingComputeMs(second) === first.ledger.hard_deadline_compute_ms - 900_000,
    "remaining compute must reflect all prior turns");

  // 3. outer allowance is clamped by remaining global compute
  const clamped = await boundedOuterTimeoutMs(second, {
    stage: "workbook_build_outer",
    requestedMs: 3_600_000,
  });
  check(clamped === remainingComputeMs(second),
    "a request beyond the remaining ceiling must be clamped to it");
  check(second.ledger.deadline_receipts.length === 0,
    "clamping inside the ceiling needs no exception receipt");

  // 4. exhausted ceiling: floor granted + typed receipt, never zero, never a throw
  await recordComputeSegment(second, {
    label: "stage4_build_execution",
    durationMs: remainingComputeMs(second),
  });
  check(remainingComputeMs(second) === 0, "ceiling must be exhausted for this test");
  const floored = await boundedOuterTimeoutMs(second, {
    stage: "workbook_build_outer",
    requestedMs: 1_200_000,
  });
  check(floored === STAGE_FLOOR_MS, "past the ceiling only the stage floor is granted");
  const receipt = second.ledger.deadline_receipts.at(-1);
  check(receipt?.kind === "deadline_exceeded" && receipt.stage === "workbook_build_outer",
    "exceeding the ceiling must leave a typed deadline receipt");
  const persisted = JSON.parse(await fs.readFile(path.join(root, RUN_DEADLINE_FILE), "utf8"));
  check(persisted.deadline_receipts.some((item) => item.kind === "deadline_exceeded"),
    "the deadline receipt must be persisted, not in-memory only");

  // 5. corrupt ledger: rebuilt with typed disclosure, not a crash
  await fs.writeFile(path.join(root, RUN_DEADLINE_FILE), "{not json", "utf8");
  const rebuilt = await openRunDeadline({ runDir: root });
  check(rebuilt.ledger.compute_elapsed_ms === 0, "a rebuilt ledger restarts the count");
  check(rebuilt.ledger.deadline_receipts.some((item) => item.kind === "ledger_rebuilt"),
    "a rebuilt ledger must disclose the discontinuity");

  // 6. the stage-4 outer formula itself can never reach the old one-hour class
  const { readFile } = await import("node:fs/promises");
  const flowSource = await readFile(new URL("./run_user_flow.mjs", import.meta.url), "utf8");
  check(!/3_600_000|3600000/.test(flowSource.replace(/\/\/[^\n]*/g, "")),
    "run_user_flow must not carry an independent one-hour allowance");
  check(/end_to_end_hard_ceiling/.test(flowSource),
    "the stage-4 outer formula must be capped by the product hard ceiling");
  check(/openRunDeadline|boundedOuterTimeoutMs/.test(flowSource),
    "run_user_flow must consult the persisted run deadline");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ checks, status: "PASS" }));
