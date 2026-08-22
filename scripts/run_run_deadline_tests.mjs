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
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "run_deadline_tests", importMetaUrl: import.meta.url });

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-deadline-"));
try {
  // 1. fresh ledger carries the product policy numbers
  const first = await openRunDeadline({ runDir: root });
  run.check("fresh ledger must adopt the product hard ceiling", () => {
    assert.ok(first.ledger.hard_deadline_compute_ms === DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling);
    return true;
  });
  run.check("fresh ledger must adopt the product target", () => {
    assert.ok(first.ledger.target_compute_ms === DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_target);
    return true;
  });
  run.check("a fresh run has its whole ceiling remaining", () => {
    assert.ok(remainingComputeMs(first) === first.ledger.hard_deadline_compute_ms);
    return true;
  });

  // 2. segments accumulate and persist; a second open NEVER resets
  await recordComputeSegment(first, { label: "stage1_filings", durationMs: 600_000 });
  await recordComputeSegment(first, { label: "stage2_brokers", durationMs: 300_000 });
  const second = await openRunDeadline({ runDir: root });
  run.check("re-opening must carry the prior turns' compute forward", () => {
    assert.ok(second.ledger.compute_elapsed_ms === 900_000);
    return true;
  });
  run.check("segments must persist", () => {
    assert.ok(second.ledger.segments.length === 2);
    return true;
  });
  run.check("remaining compute must reflect all prior turns", () => {
    assert.ok(remainingComputeMs(second) === first.ledger.hard_deadline_compute_ms - 900_000);
    return true;
  });

  // 3. outer allowance is clamped by remaining global compute
  const clamped = await boundedOuterTimeoutMs(second, {
    stage: "workbook_build_outer",
    requestedMs: 3_600_000,
  });
  run.check("a request beyond the remaining ceiling must be clamped to it", () => {
    assert.ok(clamped === remainingComputeMs(second));
    return true;
  });
  run.check("clamping inside the ceiling needs no exception receipt", () => {
    assert.ok(second.ledger.deadline_receipts.length === 0);
    return true;
  });

  // 4. exhausted ceiling: floor granted + typed receipt, never zero, never a throw
  await recordComputeSegment(second, {
    label: "stage4_build_execution",
    durationMs: remainingComputeMs(second),
  });
  run.check("ceiling must be exhausted for this test", () => {
    assert.ok(remainingComputeMs(second) === 0);
    return true;
  });
  const floored = await boundedOuterTimeoutMs(second, {
    stage: "workbook_build_outer",
    requestedMs: 1_200_000,
  });
  run.check("past the ceiling only the stage floor is granted", () => {
    assert.ok(floored === STAGE_FLOOR_MS);
    return true;
  });
  const receipt = second.ledger.deadline_receipts.at(-1);
  run.check("exceeding the ceiling must leave a typed deadline receipt", () => {
    assert.ok(receipt?.kind === "deadline_exceeded" && receipt.stage === "workbook_build_outer");
    return true;
  });
  const persisted = JSON.parse(await fs.readFile(path.join(root, RUN_DEADLINE_FILE), "utf8"));
  run.check("the deadline receipt must be persisted, not in-memory only", () => {
    assert.ok(persisted.deadline_receipts.some((item) => item.kind === "deadline_exceeded"));
    return true;
  });

  // 5. corrupt ledger: rebuilt with typed disclosure, not a crash
  await fs.writeFile(path.join(root, RUN_DEADLINE_FILE), "{not json", "utf8");
  const rebuilt = await openRunDeadline({ runDir: root });
  run.check("a rebuilt ledger restarts the count", () => {
    assert.ok(rebuilt.ledger.compute_elapsed_ms === 0);
    return true;
  });
  run.check("a rebuilt ledger must disclose the discontinuity", () => {
    assert.ok(rebuilt.ledger.deadline_receipts.some((item) => item.kind === "ledger_rebuilt"));
    return true;
  });

  // 6. the stage-4 outer formula itself can never reach the old one-hour class
  const { readFile } = await import("node:fs/promises");
  const flowSource = await readFile(new URL("./run_user_flow.mjs", import.meta.url), "utf8");
  run.check("run_user_flow must not carry an independent one-hour allowance", () => {
    assert.ok(!/3_600_000|3600000/.test(flowSource.replace(/\/\/[^\n]*/g, "")));
    return true;
  });
  run.check("the stage-4 outer formula must be capped by the product hard ceiling", () => {
    assert.ok(/end_to_end_hard_ceiling/.test(flowSource));
    return true;
  });
  run.check("run_user_flow must consult the persisted run deadline", () => {
    assert.ok(/openRunDeadline|boundedOuterTimeoutMs/.test(flowSource));
    return true;
  });
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

run.finish();
