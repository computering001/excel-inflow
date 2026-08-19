import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  DEFAULT_RUNTIME_BUDGETS_MS,
  USER_FLOW_STAGE_BUDGET_KEYS,
  deriveStageBudgetMs,
} from "./runtime_budget_policy.mjs";

/**
 * THE ONE persisted, monotonic, conversation-wide COMPUTE clock.
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
 * Design rules (P6.1 — a deadline can never be extended):
 *  - The ledger only ever grows. Re-opening never resets elapsed compute, and
 *    re-opening with a LARGER policy ceiling never raises the persisted one:
 *    a resume cannot buy budget by supplying a bigger policy.
 *  - There is exactly ONE ledger file per run. Nested controllers share it by
 *    path (RUN_DEADLINE_ENV), and every append re-reads and merges the
 *    persisted reading first, so a child's compute can never be lost by a
 *    parent writing a stale in-memory copy. The merge takes maxima, so a
 *    concurrent write can only over-charge, never under-charge.
 *  - The ledger NAMES the run it belongs to. A ledger found in a reused run
 *    directory under a different run_id is NOT adopted: its ceiling, segments
 *    and receipts are discarded, but its recorded compute is carried forward
 *    as spent, because discarding it would hand the run free budget. The
 *    discontinuity is disclosed as a typed receipt.
 *  - Every interval is measured MONOTONICALLY (performance.now) and
 *    cross-checked against the wall clock; the LARGER of the two is charged and
 *    a disagreement is disclosed, so a clock step cannot create budget.
 *  - An invocation registers itself while it runs. A killed run (SIGKILL, no
 *    handler possible) leaves that registration behind and the NEXT open
 *    charges the abandoned wall span, so kill/retry loops are visible to the
 *    ceiling instead of free.
 *  - Exhausting the ceiling never manufactures a new terminal blocker class:
 *    the deadline clamps the OUTER allowance of future stages, and when the
 *    minimal floor must be granted past the ceiling it records a typed
 *    INTERNAL.runtime_budget_overrun receipt instead of stopping mandatory work
 *    mid-run. (Only the four constitutional fatal reasons may block delivery;
 *    a clock is not one of them.) That floor is a BOUNDED, ledger-accounted
 *    debt: it is granted from a finite run-wide allowance, so a kill/retry loop
 *    can no longer mint a fresh 60 seconds on every attempt.
 *  - Every recorded interval carries a label so no stretch of wall time is
 *    unattributed in the ledger.
 */

export const RUN_DEADLINE_SCHEMA = "excel-inflow-run-deadline/1.1";
/** Ledger schemas that are MIGRATED (compute carried forward), not rebuilt. */
export const RUN_DEADLINE_MIGRATABLE_SCHEMAS = Object.freeze(["excel-inflow-run-deadline/1.0"]);
export const RUN_DEADLINE_FILE = "run-deadline.json";
/** How a nested controller is told which single ledger file to charge. */
export const RUN_DEADLINE_ENV = "EXCEL_INFLOW_RUN_DEADLINE";
/** The registered reason code a clock overrun produces. */
export const RUNTIME_BUDGET_OVERRUN_REASON = "INTERNAL.runtime_budget_overrun";

/** Minimum outer allowance a stage is always granted so a clamped run can
 * still finish the stage it is in and write its receipts. */
export const STAGE_FLOOR_MS = 60_000;

/**
 * The whole run's floor debt allowance: the total compute that may EVER be
 * granted past the exhausted ceiling, across every stage and every retry.
 * One floor per user stage plus the stage-4 outer shell — after that the
 * allowance is spent and later grants decay towards nothing. Without this cap
 * the per-call floor was an unbounded licence: N kills bought N minutes.
 */
export const STAGE_FLOOR_STAGE_COUNT = Object.keys(USER_FLOW_STAGE_BUDGET_KEYS).length + 1;
export const STAGE_FLOOR_TOTAL_ALLOWANCE_MS = STAGE_FLOOR_MS * STAGE_FLOOR_STAGE_COUNT;

/** Monotonic-vs-wall disagreement above this is disclosed as clock skew. */
export const CLOCK_SKEW_TOLERANCE_MS = 1_000;

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Run deadline ${label} must be a positive integer of milliseconds.`);
  }
  return number;
}

function nonNegativeInteger(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** A monotonic reading in milliseconds; immune to wall-clock steps. */
export function monotonicNowMs() {
  return performance.now();
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

function segmentSum(ledger) {
  return (ledger.segments ?? []).reduce((total, entry) => total + nonNegativeInteger(entry?.duration_ms), 0);
}

function freshLedger(budgets, identity = {}) {
  return {
    schema_version: RUN_DEADLINE_SCHEMA,
    // Which run this ledger belongs to. A ledger whose run_id names a
    // different run is foreign and is never adopted.
    run_id: identity.runId ?? null,
    controller_versions: identity.controllerVersion ? [String(identity.controllerVersion)] : [],
    source_digests: identity.sourceDigest ? [String(identity.sourceDigest)] : [],
    policy_digests: identity.policyDigest ? [String(identity.policyDigest)] : [],
    hard_deadline_compute_ms: requirePositiveInteger(
      budgets.end_to_end_hard_ceiling,
      "end_to_end_hard_ceiling",
    ),
    target_compute_ms: requirePositiveInteger(budgets.end_to_end_target, "end_to_end_target"),
    compute_elapsed_ms: 0,
    floor_granted_ms: 0,
    floor_allowance_ms: STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    stage_allowances: [],
    open_invocations: {},
    segments: [],
    deadline_receipts: [],
  };
}

function migrateLedger(ledger) {
  const migrated = {
    ...ledger,
    schema_version: RUN_DEADLINE_SCHEMA,
    run_id: ledger.run_id ?? null,
    controller_versions: Array.isArray(ledger.controller_versions) ? ledger.controller_versions : [],
    source_digests: Array.isArray(ledger.source_digests) ? ledger.source_digests : [],
    policy_digests: Array.isArray(ledger.policy_digests) ? ledger.policy_digests : [],
    floor_granted_ms: nonNegativeInteger(ledger.floor_granted_ms),
    floor_allowance_ms: nonNegativeInteger(ledger.floor_allowance_ms) || STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    stage_allowances: Array.isArray(ledger.stage_allowances) ? ledger.stage_allowances : [],
    open_invocations:
      ledger.open_invocations && typeof ledger.open_invocations === "object" && !Array.isArray(ledger.open_invocations)
        ? ledger.open_invocations
        : {},
  };
  migrated.deadline_receipts = [
    ...(Array.isArray(ledger.deadline_receipts) ? ledger.deadline_receipts : []),
    {
      kind: "ledger_migrated",
      from_schema_version: String(ledger.schema_version),
      to_schema_version: RUN_DEADLINE_SCHEMA,
      carried_compute_ms: nonNegativeInteger(ledger.compute_elapsed_ms),
      note: "A schema change never returns compute: the prior reading is carried forward as spent.",
    },
  ];
  return migrated;
}

function structuralErrors(ledger) {
  const errors = [];
  if (ledger?.schema_version !== RUN_DEADLINE_SCHEMA) errors.push("schema_version");
  try {
    requirePositiveInteger(ledger?.hard_deadline_compute_ms, "hard_deadline_compute_ms");
    requirePositiveInteger(ledger?.target_compute_ms, "target_compute_ms");
  } catch (error) {
    errors.push(String(error.message));
  }
  if (!Number.isSafeInteger(ledger?.compute_elapsed_ms) || ledger.compute_elapsed_ms < 0) {
    errors.push("compute_elapsed_ms");
  }
  if (!Array.isArray(ledger?.segments) || !Array.isArray(ledger?.deadline_receipts)) {
    errors.push("arrays");
  }
  if (!Array.isArray(ledger?.stage_allowances)) errors.push("stage_allowances");
  if (
    !ledger?.open_invocations ||
    typeof ledger.open_invocations !== "object" ||
    Array.isArray(ledger.open_invocations)
  ) {
    errors.push("open_invocations");
  }
  return errors;
}

function validateLedger(ledger) {
  const errors = structuralErrors(ledger);
  if (errors.length > 0) {
    throw new Error(`Run deadline ledger is not usable: ${errors.join(", ")}.`);
  }
  return ledger;
}

/**
 * VALIDATE (never repair) one persisted ledger. Returns sorted error keys.
 *
 * `priorLedger` is an earlier reading of the SAME ledger: the successor may
 * never show less compute, a lower-numbered segment history or a raised
 * ceiling, because each of those hands the run budget it already spent.
 * `expectedRunId` is the run the ledger is claimed to belong to.
 */
export function validateRunDeadlineLedger(ledger, { expectedRunId = undefined, priorLedger = null } = {}) {
  const errors = structuralErrors(ledger);
  if (errors.length > 0) return [...new Set(errors)].sort();

  const segments = ledger.segments;
  if (segments.some((entry) => typeof entry?.label !== "string" || entry.label.trim() === "")) {
    errors.push("unlabelled_segment");
  }
  if (segmentSum(ledger) !== ledger.compute_elapsed_ms) errors.push("segment_reconciliation");
  if (nonNegativeInteger(ledger.floor_granted_ms) > nonNegativeInteger(ledger.floor_allowance_ms)) {
    errors.push("floor_debt_unbounded");
  }

  if (priorLedger) {
    if (ledger.compute_elapsed_ms < nonNegativeInteger(priorLedger.compute_elapsed_ms)) {
      errors.push("compute_restored");
    }
    if (segments.length < (priorLedger.segments ?? []).length) errors.push("segments_dropped");
    if (ledger.hard_deadline_compute_ms > Number(priorLedger.hard_deadline_compute_ms)) {
      errors.push("ceiling_raised");
    }
    if (nonNegativeInteger(ledger.floor_granted_ms) < nonNegativeInteger(priorLedger.floor_granted_ms)) {
      errors.push("floor_debt_forgiven");
    }
    // An invocation that held a claim and no longer does must have paid for it:
    // either it closed and charged a segment, or it was killed and the sweep
    // disclosed and charged the span it abandoned. Silently dropping the claim
    // is exactly how a kill/retry loop used to run free.
    const stillOpen = new Set(Object.keys(ledger.open_invocations ?? {}));
    for (const invocationId of Object.keys(priorLedger.open_invocations ?? {})) {
      if (stillOpen.has(invocationId)) continue;
      const swept = ledger.deadline_receipts.some(
        (entry) => entry?.kind === "invocation_not_closed" && entry.invocation_id === invocationId,
      );
      if (!swept && segments.length <= (priorLedger.segments ?? []).length) {
        errors.push("uncharged_invocation_closure");
      }
    }
  }

  if (expectedRunId !== undefined) {
    const adopted = ledger.run_id ?? null;
    const disclosed = ledger.deadline_receipts.some((entry) => entry?.kind === "ledger_identity_mismatch");
    if (adopted !== (expectedRunId ?? null) && !disclosed) errors.push("foreign_ledger_adopted");
  }

  // Every stage that CONSUMED compute must have CONSULTED the same remaining
  // budget first. A stage segment with no allowance record is a stage that ran
  // without asking the clock.
  const consulted = new Set(ledger.stage_allowances.map((entry) => String(entry?.stage ?? "")));
  for (const entry of segments) {
    const label = String(entry?.label ?? "");
    if (label.startsWith("stage:") && !consulted.has(label.slice("stage:".length))) {
      errors.push(`unconsulted_stage:${label.slice("stage:".length)}`);
    }
  }

  // A disclosed abandoned invocation must carry the compute it abandoned.
  for (const receipt of ledger.deadline_receipts) {
    if (receipt?.kind !== "invocation_not_closed") continue;
    const expected = `orphaned_invocation:${receipt.invocation_id}`;
    if (!segments.some((entry) => entry?.label === expected)) errors.push("unaccounted_invocation");
  }

  return [...new Set(errors)].sort();
}

/** The typed outcome a clock overrun produces, in registry payload shape. */
export function runtimeBudgetOverrunOutcome({ stage, remainingMs, grantedMs, floorDebtMs = 0 }) {
  return {
    reason_code: RUNTIME_BUDGET_OVERRUN_REASON,
    earliest_responsible_layer: "runtime_governance",
    downstream_invalidation_scope: `stage:${String(stage)}`,
    checkpoint_required: true,
    evidence_preserved: true,
    remaining_ms: nonNegativeInteger(remainingMs),
    granted_ms: nonNegativeInteger(grantedMs),
    floor_debt_ms: nonNegativeInteger(floorDebtMs),
  };
}

/** Where the single ledger for this run lives. */
export function resolveRunDeadlinePath({ runDir, ledgerPath = null }) {
  if (ledgerPath) return path.resolve(String(ledgerPath));
  return path.join(runDir, RUN_DEADLINE_FILE);
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Charge every invocation that registered itself and never closed. A process
 * killed with SIGKILL cannot record anything itself; this is how its compute
 * still reaches the ceiling.
 */
function sweepAbandonedInvocations(ledger, nowWallMs) {
  const open = ledger.open_invocations ?? {};
  for (const [invocationId, entry] of Object.entries(open)) {
    const startedWall = Number(entry?.started_wall_epoch_ms);
    const stale = !Number.isFinite(startedWall)
      || nowWallMs - startedWall > ledger.hard_deadline_compute_ms;
    if (processAlive(entry?.pid) && !stale) continue;
    const abandoned = Math.min(
      ledger.hard_deadline_compute_ms,
      Number.isFinite(startedWall) ? Math.max(0, nowWallMs - startedWall) : ledger.hard_deadline_compute_ms,
    );
    ledger.segments.push({
      label: `orphaned_invocation:${invocationId}`,
      duration_ms: nonNegativeInteger(abandoned),
    });
    ledger.compute_elapsed_ms += nonNegativeInteger(abandoned);
    ledger.deadline_receipts.push({
      kind: "invocation_not_closed",
      invocation_id: invocationId,
      label: String(entry?.label ?? "unlabelled_invocation"),
      abandoned_ms: nonNegativeInteger(abandoned),
      note: "An invocation was killed or died without closing the clock; its wall span is charged so kill/retry loops are not free.",
    });
    delete open[invocationId];
  }
}

function mergeSets(mine, disk) {
  return [...new Set([...(Array.isArray(mine) ? mine : []), ...(Array.isArray(disk) ? disk : [])])];
}

/**
 * Fold the persisted reading into ours before appending. Maxima only: a
 * concurrent or nested writer can make the clock later, never earlier.
 */
function mergeLedgers(mine, disk) {
  if (!disk || disk === LEDGER_UNREADABLE || disk.schema_version !== RUN_DEADLINE_SCHEMA) return mine;
  const diskElapsed = nonNegativeInteger(disk.compute_elapsed_ms);
  if (diskElapsed >= mine.compute_elapsed_ms) {
    for (const key of ["segments", "deadline_receipts", "stage_allowances"]) {
      if (Array.isArray(disk[key]) && disk[key].length >= (mine[key] ?? []).length) mine[key] = disk[key];
    }
  }
  mine.compute_elapsed_ms = Math.max(mine.compute_elapsed_ms, diskElapsed);
  mine.floor_granted_ms = Math.max(nonNegativeInteger(mine.floor_granted_ms), nonNegativeInteger(disk.floor_granted_ms));
  if (Number.isSafeInteger(disk.hard_deadline_compute_ms) && disk.hard_deadline_compute_ms > 0) {
    mine.hard_deadline_compute_ms = Math.min(mine.hard_deadline_compute_ms, disk.hard_deadline_compute_ms);
  }
  if (Number.isSafeInteger(disk.target_compute_ms) && disk.target_compute_ms > 0) {
    mine.target_compute_ms = Math.min(mine.target_compute_ms, disk.target_compute_ms);
  }
  mine.controller_versions = mergeSets(mine.controller_versions, disk.controller_versions);
  mine.source_digests = mergeSets(mine.source_digests, disk.source_digests);
  mine.policy_digests = mergeSets(mine.policy_digests, disk.policy_digests);
  mine.open_invocations = { ...(disk.open_invocations ?? {}), ...(mine.open_invocations ?? {}) };
  // The ledger must always reconcile: elapsed IS the sum of its labelled
  // segments. If a merge left unexplained compute, name it rather than drop it.
  const sum = segmentSum(mine);
  if (sum < mine.compute_elapsed_ms) {
    mine.segments.push({ label: "unreconciled_prior_compute", duration_ms: mine.compute_elapsed_ms - sum });
  } else {
    mine.compute_elapsed_ms = sum;
  }
  return mine;
}

/** A file that exists but cannot be parsed is NOT the same as no file at all. */
const LEDGER_UNREADABLE = Symbol("run-deadline-ledger-unreadable");

async function readLedger(target) {
  let text;
  try {
    text = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return LEDGER_UNREADABLE;
  }
  try {
    return JSON.parse(text);
  } catch {
    return LEDGER_UNREADABLE;
  }
}

async function persist(state) {
  await atomicWriteJson(state.path, state.ledger);
  return state;
}

/**
 * Resolve WHICH RUN this ledger belongs to.
 *
 * A ledger naming a different run is FOREIGN: nothing of it is adopted — not
 * its ceiling, not its segments, not its receipts — except the compute it says
 * was already spent, because handing that back is exactly the reset this
 * package exists to remove. The discontinuity is disclosed as a typed receipt.
 * Controller version, source digest and policy digest are recorded as
 * append-only observed sets: a version change discloses itself and keeps
 * accumulating rather than returning compute.
 */
function applyLedgerIdentity(ledger, { budgets, identity }) {
  const claimed = ledger.run_id ?? null;
  const expected = identity.runId ?? null;
  if (expected !== null && claimed !== null && claimed !== expected) {
    const carried = nonNegativeInteger(ledger.compute_elapsed_ms);
    const successor = freshLedger(budgets, identity);
    successor.hard_deadline_compute_ms = Math.min(
      successor.hard_deadline_compute_ms,
      ledger.hard_deadline_compute_ms,
    );
    successor.target_compute_ms = Math.min(successor.target_compute_ms, ledger.target_compute_ms);
    successor.compute_elapsed_ms = carried;
    successor.floor_granted_ms = nonNegativeInteger(ledger.floor_granted_ms);
    if (carried > 0) {
      successor.segments.push({ label: "foreign_ledger_carried_forward", duration_ms: carried });
    }
    successor.deadline_receipts.push({
      kind: "ledger_identity_mismatch",
      found_run_id: claimed,
      expected_run_id: expected,
      carried_compute_ms: carried,
      note: "A ledger belonging to another run was found in this run directory. It was NOT adopted: its ceiling, segments and receipts are discarded and only the compute it recorded is carried forward as already spent.",
    });
    return successor;
  }
  if (expected !== null && claimed === null) ledger.run_id = expected;
  const declared = freshLedger(budgets, identity);
  const before = {
    controllers: (ledger.controller_versions ?? []).length,
    sources: (ledger.source_digests ?? []).length,
    policies: (ledger.policy_digests ?? []).length,
  };
  ledger.controller_versions = mergeSets(ledger.controller_versions, declared.controller_versions);
  ledger.source_digests = mergeSets(ledger.source_digests, declared.source_digests);
  ledger.policy_digests = mergeSets(ledger.policy_digests, declared.policy_digests);
  if (
    (before.controllers > 0 && ledger.controller_versions.length > before.controllers) ||
    (before.sources > 0 && ledger.source_digests.length > before.sources) ||
    (before.policies > 0 && ledger.policy_digests.length > before.policies)
  ) {
    ledger.deadline_receipts.push({
      kind: "ledger_version_change",
      controller_versions: ledger.controller_versions,
      source_digests: ledger.source_digests,
      policy_digests: ledger.policy_digests,
      note: "The controller, source tree or budget policy changed mid-run. The clock keeps accumulating: a version change never returns compute.",
    });
  }
  return ledger;
}

/**
 * Bind the run identity once the controller knows which run it is executing.
 * The clock is opened before the evidence is read, so this is the moment a
 * foreign ledger in a reused run directory is caught. Never resets compute.
 */
export async function bindRunDeadlineIdentity(state, identity = {}) {
  mergeLedgers(state.ledger, await readLedger(state.path));
  const merged = { ...state.identity, ...identity };
  const held = state.ledger.open_invocations?.[state.invocationId] ?? null;
  const resolved = applyLedgerIdentity(state.ledger, { budgets: state.budgets, identity: merged });
  if (resolved !== state.ledger && held) {
    // The successor ledger must still know this invocation is running, or a
    // kill here would go uncharged.
    resolved.open_invocations[state.invocationId] = held;
  }
  state.ledger = resolved;
  state.identity = merged;
  await persist(state);
  return state;
}

/**
 * Open (or create) the persisted deadline ledger for one run.
 *
 * Re-opening an existing ledger NEVER resets it: the recorded compute of
 * earlier turns, earlier invocations and killed attempts keeps counting
 * against the same ceiling. `ledgerPath` lets a nested controller charge the
 * SAME file as its parent, which is what makes this the only clock.
 */
export async function openRunDeadline({
  runDir,
  ledgerPath = null,
  budgets = DEFAULT_RUNTIME_BUDGETS_MS,
  identity = {},
}) {
  const target = resolveRunDeadlinePath({ runDir, ledgerPath });
  await fs.mkdir(path.dirname(target), { recursive: true });
  const requested = freshLedger(budgets, identity);
  const raw = await readLedger(target);
  let ledger = requested;
  if (raw !== null) {
    let candidate = raw;
    if (RUN_DEADLINE_MIGRATABLE_SCHEMAS.includes(raw?.schema_version)) candidate = migrateLedger(raw);
    try {
      if (candidate === LEDGER_UNREADABLE) {
        throw new Error("The persisted ledger could not be read as JSON.");
      }
      ledger = validateLedger(candidate);
    } catch (error) {
      // A corrupt ledger must not become a delivery blocker; start a
      // successor ledger and disclose the discontinuity as a typed receipt.
      ledger = freshLedger(budgets, identity);
      ledger.deadline_receipts.push({
        kind: "ledger_rebuilt",
        reason: String(error.message ?? error),
      });
    }
  }

  if (ledger !== requested) {
    // A resume can never buy budget by arriving with a bigger policy: the
    // persisted ceiling only ever ratchets DOWN.
    if (requested.hard_deadline_compute_ms > ledger.hard_deadline_compute_ms) {
      ledger.deadline_receipts.push({
        kind: "ceiling_raise_refused",
        persisted_ceiling_ms: ledger.hard_deadline_compute_ms,
        requested_ceiling_ms: requested.hard_deadline_compute_ms,
        note: "A later invocation asked for a larger ceiling; the persisted ceiling stands.",
      });
    } else if (requested.hard_deadline_compute_ms < ledger.hard_deadline_compute_ms) {
      ledger.hard_deadline_compute_ms = requested.hard_deadline_compute_ms;
    }
    ledger.target_compute_ms = Math.min(ledger.target_compute_ms, requested.target_compute_ms);

    ledger = applyLedgerIdentity(ledger, { budgets, identity });
  }

  const nowWallMs = Date.now();
  sweepAbandonedInvocations(ledger, nowWallMs);

  const invocationId = `${process.pid}-${nowWallMs}-${randomUUID().slice(0, 8)}`;
  ledger.open_invocations[invocationId] = {
    label: String(identity.invocationLabel ?? identity.controllerVersion ?? "controller_invocation"),
    pid: process.pid,
    started_wall_epoch_ms: nowWallMs,
  };

  const state = {
    path: target,
    ledger,
    budgets,
    invocationId,
    identity: { ...identity },
  };
  await persist(state);
  return state;
}

/** Milliseconds of compute still inside the hard ceiling (never negative). */
export function remainingComputeMs(state) {
  return Math.max(
    0,
    state.ledger.hard_deadline_compute_ms - state.ledger.compute_elapsed_ms,
  );
}

/** Floor debt still available past an exhausted ceiling (never negative). */
export function remainingFloorAllowanceMs(state) {
  return Math.max(
    0,
    nonNegativeInteger(state.ledger.floor_allowance_ms) - nonNegativeInteger(state.ledger.floor_granted_ms),
  );
}

/**
 * Record one measured compute segment and persist the ledger. Labels are
 * mandatory: an unlabeled interval is exactly the unattributed time the
 * runtime redesign forbids. The persisted reading is merged first, so a
 * nested controller's compute can never be overwritten away.
 */
export async function recordComputeSegment(state, { label, durationMs }) {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("A compute segment requires a non-empty label.");
  }
  mergeLedgers(state.ledger, await readLedger(state.path));
  const duration = Math.max(0, Math.floor(Number(durationMs) || 0));
  state.ledger.compute_elapsed_ms += duration;
  state.ledger.segments.push({ label, duration_ms: duration });
  await persist(state);
  return state;
}

/** Begin a monotonically measured span against this ledger. */
export function beginComputeSpan(state, label) {
  return {
    label: String(label),
    monotonic_start_ms: monotonicNowMs(),
    wall_start_ms: Date.now(),
    elapsed_at_start_ms: state.ledger.compute_elapsed_ms,
  };
}

/**
 * Close a span and charge what it consumed.
 *
 * The charge is the LARGER of the monotonic and wall readings (a clock step
 * cannot create budget), MINUS whatever the ledger itself grew while the span
 * was open — that growth is compute a nested stage or a child controller
 * already charged to the same clock, so crediting it is what keeps one clock
 * from double-billing.
 */
export async function endComputeSpan(state, span, {
  stage = null,
  allowanceMs = null,
  creditPersistedGrowth = true,
} = {}) {
  if (!span) return 0;
  mergeLedgers(state.ledger, await readLedger(state.path));
  const monotonicDelta = Math.max(0, Math.floor(monotonicNowMs() - span.monotonic_start_ms));
  // The RAW wall delta may be negative — a wall clock that stepped backwards
  // while the span was open. That is skew, not zero elapsed time, so it is
  // compared unclamped and only the CHARGE is floored at zero.
  const wallDeltaRaw = Date.now() - span.wall_start_ms;
  const observed = Math.max(monotonicDelta, wallDeltaRaw, 0);
  const growth = creditPersistedGrowth
    ? Math.max(0, state.ledger.compute_elapsed_ms - nonNegativeInteger(span.elapsed_at_start_ms))
    : 0;
  const charge = Math.max(0, observed - growth);
  // Record FIRST (the record re-merges the persisted reading), then append
  // receipts and persist, so a merge can never discard a fresh disclosure.
  await recordComputeSegment(state, { label: span.label, durationMs: charge });
  if (Math.abs(monotonicDelta - wallDeltaRaw) > CLOCK_SKEW_TOLERANCE_MS) {
    state.ledger.deadline_receipts.push({
      kind: "clock_skew_detected",
      label: span.label,
      monotonic_ms: monotonicDelta,
      wall_ms: wallDeltaRaw,
      charged_ms: observed,
      note: "The wall clock and the monotonic clock disagreed; the larger reading was charged so a clock step cannot create budget.",
    });
    await persist(state);
  }
  if (stage && Number.isFinite(Number(allowanceMs)) && Number(allowanceMs) > 0 && observed > Number(allowanceMs)) {
    state.ledger.deadline_receipts.push({
      kind: "stage_budget_overrun",
      stage: String(stage),
      allowance_ms: Math.floor(Number(allowanceMs)),
      observed_ms: observed,
      ...runtimeBudgetOverrunOutcome({
        stage,
        remainingMs: remainingComputeMs(state),
        grantedMs: Math.floor(Number(allowanceMs)),
      }),
      note: "The stage consumed more than the allowance the single clock granted it. The run is not blocked by a clock, but the overrun is typed and visible to the ceiling.",
    });
    await persist(state);
  }
  return charge;
}

/**
 * The outer allowance for one stage: never more than the stage's own
 * requested/derived budget, never more than the remaining global compute,
 * never less than the (capped) stage floor.
 *
 * The floor may still exceed the remaining ceiling — an EXPLICIT operator
 * budget is a hard promise and checkpoints must be able to close — but it can
 * never exceed what the caller asked for, and it is drawn from a FINITE
 * run-wide floor allowance recorded in the ledger. Every grant past the
 * ceiling leaves a typed INTERNAL.runtime_budget_overrun receipt.
 */
export async function boundedOuterTimeoutMs(state, { stage, requestedMs, floorMs = STAGE_FLOOR_MS }) {
  const requested = requirePositiveInteger(requestedMs, `${stage}:requested`);
  const requestedFloor = requirePositiveInteger(floorMs, `${stage}:floor`);
  // Consult the PERSISTED reading, not a possibly stale in-memory copy.
  mergeLedgers(state.ledger, await readLedger(state.path));
  const remaining = remainingComputeMs(state);
  // A floor can lift a DERIVED budget; it can never lift a stated one.
  const cappedFloor = Math.min(requestedFloor, requested);
  const insideCeiling = Math.min(requested, remaining);
  let granted = Math.max(cappedFloor, insideCeiling);
  const requestedDebt = Math.max(0, granted - remaining);
  if (requestedDebt > 0) {
    const availableDebt = remainingFloorAllowanceMs(state);
    const grantedDebt = Math.min(requestedDebt, availableDebt);
    granted = Math.max(1, remaining + grantedDebt);
    state.ledger.floor_granted_ms = nonNegativeInteger(state.ledger.floor_granted_ms) + grantedDebt;
    state.ledger.deadline_receipts.push({
      kind: "deadline_exceeded",
      stage,
      remaining_ms: remaining,
      granted_ms: granted,
      floor_debt_ms: grantedDebt,
      floor_debt_refused_ms: requestedDebt - grantedDebt,
      floor_debt_remaining_ms: remainingFloorAllowanceMs(state),
      ...runtimeBudgetOverrunOutcome({
        stage,
        remainingMs: remaining,
        grantedMs: granted,
        floorDebtMs: grantedDebt,
      }),
      note: "The global compute ceiling is exhausted; a BOUNDED floor was granted from the run's finite floor allowance so mandatory work can close with receipts instead of terminating. When that allowance is spent, no further floor is minted.",
    });
  }
  state.ledger.stage_allowances.push({
    stage: String(stage),
    requested_ms: requested,
    remaining_ms_at_consult: remaining,
    granted_ms: granted,
    consulted_at: new Date().toISOString(),
  });
  await persist(state);
  return granted;
}

/**
 * Consult the ONE clock for a user stage: derive the stage budget from the
 * policy AND the remaining global compute, then bound it. Every stage calls
 * this, which is what makes the remaining budget shared rather than per-stage.
 */
export async function consultStageBudget(state, { stage, requestedMs = null, floorMs = STAGE_FLOOR_MS }) {
  const budgetKey = USER_FLOW_STAGE_BUDGET_KEYS[stage] ?? null;
  const derived = requestedMs ?? deriveStageBudgetMs({
    budgets: state.budgets ?? DEFAULT_RUNTIME_BUDGETS_MS,
    stage: budgetKey,
    remainingMs: remainingComputeMs(state),
  });
  return boundedOuterTimeoutMs(state, { stage, requestedMs: derived, floorMs });
}

/**
 * Close this invocation's registration. After this the ledger holds no claim
 * on behalf of this process, so a later open will not charge it as abandoned.
 */
export async function closeRunDeadline(state) {
  if (!state?.invocationId) return state;
  mergeLedgers(state.ledger, await readLedger(state.path));
  delete state.ledger.open_invocations[state.invocationId];
  await persist(state);
  return state;
}
