import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_RUNTIME_BUDGETS_MS } from "./runtime_budget_policy.mjs";

/**
 * One persisted, monotonic, conversation-wide COMPUTE deadline.
 *
 * The runtime budget policy declares a 15-minute target and a 25-minute hard
 * ceiling for one user run, but a run spans several chat turns and several
 * controller invocations, each of which historically received a fresh budget
 * origin. This module is the missing continuity: a run-scoped ledger that
 * accumulates measured COMPUTE segments (human waiting time is deliberately
 * excluded — the clock only advances while the system works) and survives
 * resume, host transition and new chat turns because it lives in the run
 * directory beside the receipts.
 *
 * Design rules:
 *  - The ledger only ever grows. Re-opening never resets elapsed compute.
 *  - Exhausting the ceiling never manufactures a new terminal blocker class:
 *    the deadline clamps the OUTER allowance of future stages, and when even
 *    the minimal floor must be granted past the ceiling it records a typed
 *    `deadline_exceeded` receipt instead of stopping mandatory work mid-run.
 *    (Only the four constitutional fatal reasons may block delivery; a clock
 *    is not one of them.)
 *  - Every recorded interval carries a label so no stretch of wall time is
 *    unattributed in the ledger.
 */

export const RUN_DEADLINE_SCHEMA = "excel-inflow-run-deadline/1.0";
export const RUN_DEADLINE_FILE = "run-deadline.json";

/** Minimum outer allowance a stage is always granted so a clamped run can
 * still finish the stage it is in and write its receipts. */
export const STAGE_FLOOR_MS = 60_000;

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Run deadline ${label} must be a positive integer of milliseconds.`);
  }
  return number;
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

function freshLedger(budgets) {
  return {
    schema_version: RUN_DEADLINE_SCHEMA,
    hard_deadline_compute_ms: requirePositiveInteger(
      budgets.end_to_end_hard_ceiling,
      "end_to_end_hard_ceiling",
    ),
    target_compute_ms: requirePositiveInteger(budgets.end_to_end_target, "end_to_end_target"),
    compute_elapsed_ms: 0,
    segments: [],
    deadline_receipts: [],
  };
}

function validateLedger(ledger) {
  if (ledger?.schema_version !== RUN_DEADLINE_SCHEMA) {
    throw new Error("Run deadline ledger has the wrong schema version.");
  }
  requirePositiveInteger(ledger.hard_deadline_compute_ms, "hard_deadline_compute_ms");
  requirePositiveInteger(ledger.target_compute_ms, "target_compute_ms");
  if (!Number.isSafeInteger(ledger.compute_elapsed_ms) || ledger.compute_elapsed_ms < 0) {
    throw new Error("Run deadline elapsed compute must be a non-negative integer.");
  }
  if (!Array.isArray(ledger.segments) || !Array.isArray(ledger.deadline_receipts)) {
    throw new Error("Run deadline ledger must carry segment and receipt arrays.");
  }
  return ledger;
}

/**
 * Open (or create) the persisted deadline ledger for one run directory.
 * Re-opening an existing ledger NEVER resets it; the recorded compute of
 * earlier turns keeps counting against the same ceiling.
 */
export async function openRunDeadline({ runDir, budgets = DEFAULT_RUNTIME_BUDGETS_MS }) {
  await fs.mkdir(runDir, { recursive: true });
  const target = path.join(runDir, RUN_DEADLINE_FILE);
  let ledger;
  try {
    ledger = validateLedger(JSON.parse(await fs.readFile(target, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // A corrupt ledger must not become a delivery blocker; start a
      // successor ledger and disclose the discontinuity as a typed receipt.
      ledger = freshLedger(budgets);
      ledger.deadline_receipts.push({
        kind: "ledger_rebuilt",
        reason: String(error.message ?? error),
      });
    } else {
      ledger = freshLedger(budgets);
    }
    await atomicWriteJson(target, ledger);
  }
  return { path: target, ledger };
}

/** Milliseconds of compute still inside the hard ceiling (never negative). */
export function remainingComputeMs(state) {
  return Math.max(
    0,
    state.ledger.hard_deadline_compute_ms - state.ledger.compute_elapsed_ms,
  );
}

/**
 * Record one measured compute segment and persist the ledger. Labels are
 * mandatory: an unlabeled interval is exactly the unattributed time the
 * runtime redesign forbids.
 */
export async function recordComputeSegment(state, { label, durationMs }) {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("A compute segment requires a non-empty label.");
  }
  const duration = Math.max(0, Math.floor(Number(durationMs) || 0));
  state.ledger.compute_elapsed_ms += duration;
  state.ledger.segments.push({ label, duration_ms: duration });
  await atomicWriteJson(state.path, state.ledger);
  return state;
}

/**
 * The outer allowance for one stage: never more than the stage's own
 * requested/derived budget, never more than the remaining global compute,
 * never less than the stage floor. Granting the floor past the ceiling is
 * legal but must leave a typed receipt in the ledger.
 */
export async function boundedOuterTimeoutMs(state, { stage, requestedMs, floorMs = STAGE_FLOOR_MS }) {
  const requested = requirePositiveInteger(requestedMs, `${stage}:requested`);
  const floor = requirePositiveInteger(floorMs, `${stage}:floor`);
  const remaining = remainingComputeMs(state);
  const granted = Math.max(floor, Math.min(requested, remaining));
  if (remaining < floor) {
    state.ledger.deadline_receipts.push({
      kind: "deadline_exceeded",
      stage,
      remaining_ms: remaining,
      granted_ms: granted,
      note: "The global compute ceiling is exhausted; the stage floor was granted so mandatory work can close with receipts instead of terminating.",
    });
    await atomicWriteJson(state.path, state.ledger);
  }
  return granted;
}
