/**
 * P6.5 — the declared resource limits that bound evidence-lane parallelism,
 * the mandatory-over-optional budget priority, and the per-lane resource
 * receipt.
 *
 * Three things this module exists to make impossible.
 *
 *  1. A pool sized by however many lanes happen to exist. Worker count derives
 *     from DECLARED cpu/memory limits (assets/lane-resource-policy-v1.json),
 *     following stage 4's `validator_concurrency` precedent — the same
 *     "size concurrency from a measured resource" convention, moved out of a
 *     ternary and into a declaration that both runtimes read.
 *
 *  2. Optional work spending budget that mandatory work needs. Both classes
 *     used to draw on one flat budgets_ms. Here the optional class may only
 *     draw on the SURPLUS above a mandatory reserve, and that reserve is
 *     derived from P6.1's own clock constants — never a second convention and
 *     never a second clock. The remaining budget is READ from P6.1's persisted
 *     ledger; this module never writes it.
 *
 *  3. A lane that closed without saying what it consumed. Every lane compiles
 *     a receipt naming its class, its worker slot, its reservation, what it
 *     was granted and what it actually used — and a lane with no receipt is a
 *     refusal, not a silence.
 *
 * The lane's priority CLASS is not declared here: it is read from the product
 * constitution's `evidence_lanes.<lane>.criticality`, so there is one place
 * that says the broker lane is optional.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STAGE_FLOOR_MS, STAGE_FLOOR_STAGE_COUNT } from "./run_deadline.mjs";
import { DEFAULT_RUNTIME_BUDGETS_MS } from "./runtime_budget_policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

export const LANE_RESOURCE_POLICY_SCHEMA = "excel-inflow-lane-resource-policy/1.0";
export const LANE_RESOURCE_PLAN_SCHEMA = "lane-resource-plan/1.0";
export const LANE_RESOURCE_RECEIPT_SCHEMA = "lane-resource-receipt/1.0";

export const LANE_RESOURCE_POLICY_PATH = path.join(ROOT, "assets", "lane-resource-policy-v1.json");
export const PRODUCT_CONSTITUTION_PATH = path.join(ROOT, "assets", "product-constitution-v1.json");

export const CPU_ATTRIBUTIONS = Object.freeze(["exclusive", "pool_shared"]);
export const BUDGET_SOURCES = Object.freeze(["declared_only", "run_deadline_ledger"]);

function readJson(target, label) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message ?? error}`);
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** The declared limits, validated. A malformed policy is never used. */
export function loadLaneResourcePolicy(target = LANE_RESOURCE_POLICY_PATH) {
  const policy = readJson(target, "lane resource policy");
  const violations = validateLaneResourcePolicy(policy);
  if (violations.length > 0) {
    throw new Error(`Lane resource policy is invalid: ${violations.join("; ")}`);
  }
  return policy;
}

/**
 * A policy is only usable when its numbers agree with the runtime governance
 * they claim to derive from. Two floors that drift apart are two conventions.
 */
export function validateLaneResourcePolicy(policy) {
  const violations = [];
  if (!policy || typeof policy !== "object") return ["the policy is not an object"];
  if (policy.schema_version !== LANE_RESOURCE_POLICY_SCHEMA) {
    violations.push(`schema_version must be ${LANE_RESOURCE_POLICY_SCHEMA}`);
  }
  const reservation = policy.worker_reservation ?? {};
  for (const field of ["cpu_per_worker", "memory_mib_per_worker", "reserved_cpu", "reserved_memory_mib"]) {
    if (field === "reserved_cpu" || field === "reserved_memory_mib") {
      if (nonNegativeInteger(reservation[field]) === null) violations.push(`worker_reservation.${field} must be a non-negative integer`);
    } else if (positiveInteger(reservation[field]) === null) {
      violations.push(`worker_reservation.${field} must be a positive integer`);
    }
  }
  const tiers = policy.worker_tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    violations.push("worker_tiers must be a non-empty array");
  } else {
    if (tiers[0].min_usable_memory_mib !== 0) violations.push("worker_tiers must start at min_usable_memory_mib 0");
    tiers.forEach((tier, index) => {
      if (positiveInteger(tier?.max_workers) === null) violations.push(`worker_tiers[${index}].max_workers must be a positive integer`);
      if (nonNegativeInteger(tier?.min_usable_memory_mib) === null) violations.push(`worker_tiers[${index}].min_usable_memory_mib must be a non-negative integer`);
      if (index > 0) {
        const previous = tiers[index - 1];
        if (!(tier.min_usable_memory_mib > previous.min_usable_memory_mib && tier.max_workers > previous.max_workers)) {
          violations.push(`worker_tiers[${index}] must ascend in both columns`);
        }
      }
    });
  }
  if (positiveInteger(policy.max_workers_ceiling) === null) violations.push("max_workers_ceiling must be a positive integer");
  if (positiveInteger(policy.assumed_total_memory_mib) === null) violations.push("assumed_total_memory_mib must be a positive integer");
  if (!Array.isArray(policy.optional_criticalities) || policy.optional_criticalities.length === 0) {
    violations.push("optional_criticalities must be a non-empty array");
  }
  if (typeof policy.criticality_source !== "string" || !policy.criticality_source.includes("product-constitution")) {
    violations.push("criticality_source must name the product constitution");
  }

  const priority = policy.budget_priority ?? {};
  // The floor, the reserve and the optional envelope are all DERIVED numbers.
  // Restating them here is only legal while they still agree with the source.
  if (priority.mandatory_floor_ms !== STAGE_FLOOR_MS) {
    violations.push(`budget_priority.mandatory_floor_ms must equal STAGE_FLOOR_MS (${STAGE_FLOOR_MS})`);
  }
  if (priority.optional_floor_ms !== STAGE_FLOOR_MS) {
    violations.push(`budget_priority.optional_floor_ms must equal STAGE_FLOOR_MS (${STAGE_FLOOR_MS})`);
  }
  if (priority.mandatory_reserve_stage_count !== STAGE_FLOOR_STAGE_COUNT - 2) {
    violations.push(
      `budget_priority.mandatory_reserve_stage_count must be the stages still downstream of the evidence half (${STAGE_FLOOR_STAGE_COUNT - 2})`,
    );
  }
  if (priority.mandatory_reserve_ms !== STAGE_FLOOR_MS * (STAGE_FLOOR_STAGE_COUNT - 2)) {
    violations.push("budget_priority.mandatory_reserve_ms must be the floor times the downstream mandatory stage count");
  }
  if (priority.optional_envelope_ms !== DEFAULT_RUNTIME_BUDGETS_MS.broker_global) {
    violations.push("budget_priority.optional_envelope_ms must equal the declared broker_global budget");
  }
  const classes = priority.classes ?? {};
  if (classes.mandatory?.may_be_starved !== false) violations.push("mandatory work may never be declared starvable");
  if (classes.optional?.may_be_starved !== true) violations.push("optional work must be declared starvable");
  if (!(Number(classes.mandatory?.rank) < Number(classes.optional?.rank))) {
    violations.push("the mandatory class must rank ahead of the optional class");
  }
  if (policy.budget_clock?.reader_only !== true) {
    violations.push("the lane policy must read P6.1's clock and never write it");
  }
  return violations;
}

/** The criticality each evidence lane is declared with, from the constitution. */
export function laneCriticalities(target = PRODUCT_CONSTITUTION_PATH) {
  const constitution = readJson(target, "product constitution");
  const lanes = constitution.evidence_lanes ?? {};
  return Object.fromEntries(
    Object.entries(lanes).map(([lane, declaration]) => [lane, String(declaration?.criticality ?? "")]),
  );
}

/**
 * Optional only when the constitution says so. Anything unrecognised is
 * treated as mandatory: a lane can never become starvable by accident.
 */
export function lanePriorityClass(criticality, policy) {
  return (policy?.optional_criticalities ?? []).includes(String(criticality)) ? "optional" : "mandatory";
}

/**
 * The worker count. Bounded by the declared memory tier, the declared
 * per-worker memory reservation, the declared per-worker cpu reservation, the
 * declared ceiling, and finally by the lane count — which is the LAST bound
 * applied, never the first.
 */
export function resolveLaneWorkerCount({ policy, laneCount, cpuCount, totalMemoryMib }) {
  const lanes = positiveInteger(laneCount);
  if (lanes === null) throw new Error("A lane pool needs a positive lane count.");
  const reservation = policy.worker_reservation;
  const cpus = positiveInteger(cpuCount) ?? 1;
  const memoryMib = positiveInteger(totalMemoryMib) ?? policy.assumed_total_memory_mib;

  const usableMemoryMib = Math.max(0, memoryMib - reservation.reserved_memory_mib);
  const tierWorkers = policy.worker_tiers.reduce(
    (best, tier) => (usableMemoryMib >= tier.min_usable_memory_mib ? tier.max_workers : best),
    1,
  );
  const memoryWorkers = Math.max(1, Math.min(tierWorkers, Math.floor(usableMemoryMib / reservation.memory_mib_per_worker)));
  const cpuWorkers = Math.max(1, Math.floor((cpus - reservation.reserved_cpu) / reservation.cpu_per_worker));

  return Math.max(1, Math.min(lanes, memoryWorkers, cpuWorkers, policy.max_workers_ceiling));
}

/** MUTATION GUARD: a pool that runs more workers than the declared limits allow. */
export function assertBoundedWorkerCount({ policy, workers, laneCount, cpuCount, totalMemoryMib }) {
  const bound = resolveLaneWorkerCount({ policy, laneCount, cpuCount, totalMemoryMib });
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error("A lane pool must run at least one worker.");
  }
  if (workers > bound) {
    throw new Error(
      `Lane pool is UNBOUNDED: ${workers} workers exceed the ${bound} the declared resource policy allows `
      + `(${laneCount} lanes, ${cpuCount} cpu, ${totalMemoryMib} MiB). Worker count must come from the resource `
      + "limits, not from the lane count.",
    );
  }
  return bound;
}

/**
 * The two budget caps for this pool, from the ONE remaining reading of P6.1's
 * clock. A null reading means no ledger was handed down: the declared lane
 * budgets then apply unchanged, exactly as before this package.
 */
export function laneBudgetCaps({ policy, remainingComputeMs }) {
  const priority = policy.budget_priority;
  const remaining = Number.isFinite(Number(remainingComputeMs)) && remainingComputeMs !== null
    ? Math.max(0, Math.floor(Number(remainingComputeMs)))
    : null;
  if (remaining === null) {
    return {
      budget_source: "declared_only",
      remaining_compute_ms: null,
      mandatory_reserve_ms: priority.mandatory_reserve_ms,
      mandatory_cap_ms: null,
      optional_cap_ms: null,
    };
  }
  return {
    budget_source: "run_deadline_ledger",
    remaining_compute_ms: remaining,
    mandatory_reserve_ms: priority.mandatory_reserve_ms,
    // Mandatory work is bounded by the clock but never below its floor.
    mandatory_cap_ms: Math.max(priority.mandatory_floor_ms, remaining),
    // Optional work sees only the surplus above the mandatory reserve.
    optional_cap_ms: Math.min(
      priority.optional_envelope_ms,
      Math.max(0, remaining - priority.mandatory_reserve_ms),
    ),
  };
}

/** One lane's grant under those caps. */
export function grantLaneBudgetMs({ policy, caps, priorityClass, requestedMs }) {
  const priority = policy.budget_priority;
  const requested = positiveInteger(requestedMs);
  if (requested === null) throw new Error("A lane budget request must be a positive integer of milliseconds.");
  const cap = priorityClass === "optional" ? caps.optional_cap_ms : caps.mandatory_cap_ms;
  if (cap === null) {
    return { requested_ms: requested, granted_ms: requested, starved: false };
  }
  if (priorityClass === "optional") {
    const granted = Math.min(requested, cap);
    // A slice too small to do anything with is not granted at all: the lane is
    // not started and its containment closes it at zero authority.
    if (granted < priority.optional_floor_ms) {
      return { requested_ms: requested, granted_ms: 0, starved: true };
    }
    return { requested_ms: requested, granted_ms: granted, starved: false };
  }
  return {
    requested_ms: requested,
    granted_ms: Math.max(priority.mandatory_floor_ms, Math.min(requested, cap)),
    starved: false,
  };
}

/** Grants for a whole pool at once (the shape the plan and the tests use). */
export function sliceLaneBudgets({ policy, lanes, remainingComputeMs }) {
  const caps = laneBudgetCaps({ policy, remainingComputeMs });
  const granted = {};
  for (const [lane, request] of Object.entries(lanes)) {
    const priorityClass = lanePriorityClass(request.criticality, policy);
    granted[lane] = {
      priority_class: priorityClass,
      criticality: String(request.criticality ?? ""),
      ...grantLaneBudgetMs({ policy, caps, priorityClass, requestedMs: request.requestedMs }),
    };
  }
  return { ...caps, lanes: granted };
}

/**
 * MUTATION GUARD: optional work drawing on budget the mandatory reserve holds,
 * or mandatory work reduced below its floor.
 */
export function assertMandatoryBudgetProtected(slice, policy) {
  const priority = policy.budget_priority;
  if (slice.budget_source === "declared_only") return slice;
  const surplus = Math.max(0, slice.remaining_compute_ms - priority.mandatory_reserve_ms);
  for (const [lane, grant] of Object.entries(slice.lanes ?? {})) {
    if (grant.priority_class === "optional") {
      if (grant.granted_ms > surplus) {
        throw new Error(
          `Optional lane ${lane} was granted ${grant.granted_ms} ms out of a surplus of ${surplus} ms: `
          + `optional work is spending the ${priority.mandatory_reserve_ms} ms reserved for mandatory work.`,
        );
      }
      if (grant.granted_ms > priority.optional_envelope_ms) {
        throw new Error(`Optional lane ${lane} exceeded its declared envelope of ${priority.optional_envelope_ms} ms.`);
      }
    } else {
      if (grant.starved === true) throw new Error(`Mandatory lane ${lane} was starved; mandatory work is never starvable.`);
      if (grant.granted_ms < priority.mandatory_floor_ms) {
        throw new Error(`Mandatory lane ${lane} was granted ${grant.granted_ms} ms, below its ${priority.mandatory_floor_ms} ms floor.`);
      }
    }
  }
  return slice;
}

/** What a lane must be able to say about what it consumed. */
export function validateLaneResourceReceipt(receipt) {
  const violations = [];
  if (!receipt || typeof receipt !== "object") return ["the receipt is not an object"];
  if (receipt.schema_version !== LANE_RESOURCE_RECEIPT_SCHEMA) {
    violations.push(`schema_version must be ${LANE_RESOURCE_RECEIPT_SCHEMA}`);
  }
  for (const field of ["lane", "priority_class", "criticality", "budget_source", "cpu_attribution"]) {
    if (typeof receipt[field] !== "string" || receipt[field] === "") violations.push(`${field} must be a non-empty string`);
  }
  for (const field of [
    "worker_slot",
    "pool_max_workers",
    "reserved_cpu",
    "reserved_memory_mib",
    "requested_budget_ms",
    "granted_budget_ms",
    "consumed_wall_ms",
  ]) {
    if (nonNegativeInteger(receipt[field]) === null) violations.push(`${field} must be a non-negative integer`);
  }
  if (!Number.isInteger(receipt.budget_headroom_ms)) violations.push("budget_headroom_ms must be an integer");
  if (
    Number.isInteger(receipt.consumed_wall_ms)
    && Number.isInteger(receipt.granted_budget_ms)
    && receipt.consumed_wall_ms > receipt.granted_budget_ms
  ) {
    violations.push("consumed_wall_ms cannot exceed granted_budget_ms");
  }
  if (Number.isInteger(receipt.budget_headroom_ms) && receipt.budget_headroom_ms < 0) {
    violations.push("budget_headroom_ms cannot be negative");
  }
  if (
    Number.isInteger(receipt.budget_headroom_ms)
    && Number.isInteger(receipt.granted_budget_ms)
    && Number.isInteger(receipt.consumed_wall_ms)
    && receipt.budget_headroom_ms !== receipt.granted_budget_ms - receipt.consumed_wall_ms
  ) {
    violations.push("budget_headroom_ms must reconcile grant less consumption");
  }
  for (const field of ["starved", "late_enrichment_after_seal"]) {
    if (typeof receipt[field] !== "boolean") violations.push(`${field} must be a boolean`);
  }
  if (!["mandatory", "optional"].includes(receipt.priority_class)) violations.push("priority_class is not a declared class");
  if (!CPU_ATTRIBUTIONS.includes(receipt.cpu_attribution)) violations.push("cpu_attribution is not a declared attribution");
  if (!BUDGET_SOURCES.includes(receipt.budget_source)) violations.push("budget_source is not a declared source");
  // A shared counter cannot be reported as a per-lane measurement.
  if (receipt.cpu_attribution === "pool_shared" && receipt.consumed_cpu_ms !== null && receipt.consumed_cpu_ms !== undefined) {
    violations.push("consumed_cpu_ms must be null when the cpu reading is pool_shared");
  }
  if (receipt.cpu_attribution === "exclusive" && nonNegativeInteger(receipt.consumed_cpu_ms) === null) {
    violations.push("consumed_cpu_ms must be a non-negative integer when the cpu reading is exclusive");
  }
  if (receipt.starved === true && receipt.granted_budget_ms !== 0) {
    violations.push("a starved lane cannot also hold a budget grant");
  }
  return violations;
}

/** MUTATION GUARD: a lane that closed with no resource receipt at all. */
export function assertLaneResourceReceiptsComplete(laneKinds, receipts) {
  const seen = new Set((receipts ?? []).map((receipt) => receipt?.lane));
  const missing = (laneKinds ?? []).filter((lane) => !seen.has(lane));
  if (missing.length > 0) {
    throw new Error(
      `These lanes ran without a resource receipt: ${missing.join(", ")}. Every lane records what it consumed.`,
    );
  }
  for (const receipt of receipts ?? []) {
    const violations = validateLaneResourceReceipt(receipt);
    if (violations.length > 0) {
      throw new Error(`Lane resource receipt for ${receipt?.lane} is invalid: ${violations.join("; ")}`);
    }
  }
  return receipts;
}

/**
 * An optional lane that closes AFTER the mandatory authority was sealed, and
 * that carries authority of its own, is a late enrichment against a sealed
 * decision. This function only DETECTS and names it; acting on the event
 * (invalidating the sealed authority) is the controller's decision.
 */
export function laneLateEnrichmentEvent({ lane, priorityClass, sealedAtMs, closedAtMs, authorityEdgeCount }) {
  const sealed = Number(sealedAtMs);
  const closed = Number(closedAtMs);
  const edges = Number(authorityEdgeCount) || 0;
  if (priorityClass !== "optional") return null;
  if (!Number.isFinite(sealed) || !Number.isFinite(closed)) return null;
  if (closed <= sealed || edges <= 0) return null;
  return {
    schema_version: "lane-late-enrichment-event/1.0",
    event: "late_enrichment_after_sealed_authority",
    lane: String(lane),
    sealed_at_ms: sealed,
    closed_at_ms: closed,
    late_by_ms: closed - sealed,
    authority_edge_count: edges,
    note: "An optional lane selected authority after the mandatory authority was sealed; the seal must be revalidated before that authority is used.",
  };
}
