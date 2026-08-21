#!/usr/bin/env node
/**
 * P6.5 — Bounded parallelism, budget priority and per-lane resource receipts.
 *
 * Invariant: concurrency is bounded by declared RESOURCE limits rather than by
 * however many lanes happen to exist; mandatory work has budget priority over
 * optional work; and every lane records what it consumed.
 *
 * The three mutations this suite must catch:
 *   1. an UNBOUNDED pool (worker count taken from the lane count)
 *   2. OPTIONAL work consuming budget that MANDATORY work needs
 *   3. a lane that closed with NO resource receipt
 *
 * Equivalence obligation: a bounded pool must produce the same evidence as an
 * unbounded one, just with fewer concurrent workers. Proved by driving the real
 * python pool twice over identical lanes at two worker counts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LANE_RESOURCE_PLAN_SCHEMA,
  LANE_RESOURCE_POLICY_SCHEMA,
  LANE_RESOURCE_RECEIPT_SCHEMA,
  assertBoundedWorkerCount,
  assertLaneResourceReceiptsComplete,
  assertMandatoryBudgetProtected,
  grantLaneBudgetMs,
  laneBudgetCaps,
  laneCriticalities,
  lanePriorityClass,
  laneLateEnrichmentEvent,
  loadLaneResourcePolicy,
  resolveLaneWorkerCount,
  sliceLaneBudgets,
  validateLaneResourcePolicy,
  validateLaneResourceReceipt,
} from "./lib/lane_resource_policy.mjs";
import {
  BROKER_DEGRADE_REGISTRY_REASON,
  OPTIONAL_BROKER_BREAKER_POLICY,
  assertBreakerReceiptCarried,
  executeOptionalBrokerCircuitBreaker,
  validateBrokerBreakerReceipt,
} from "./lib/optional_broker_circuit_breaker.mjs";
import { RUN_DEADLINE_ENV, STAGE_FLOOR_MS, openRunDeadline } from "./lib/run_deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// A hard-coded absolute home path shipped in the tree: it names ONE developer's
// venv, so this suite could only ever run on that machine, and the portability
// contract refuses any /Users/... or /home/... string under scripts/. Resolved
// the way run_filings_pipeline.mjs already does it -- declared env first, then
// the generic interpreter -- so the suite is machine-independent and the
// interpreter stays a declared input rather than a local assumption.
const PYTHON = process.env.EXCEL_INFLOW_PYTHON ?? process.env.PYTHON ?? "python3";
const PIPELINE = path.join(HERE, "run_attachment_evidence_pipeline.py");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`BOUNDED_PARALLELISM_FAIL: ${message}`);
  checks += 1;
}
function refuses(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(threw, label);
}

// ---------------------------------------------------------------------------
// 1. The declared resource limits
// ---------------------------------------------------------------------------
const policy = loadLaneResourcePolicy();
check(policy.schema_version === LANE_RESOURCE_POLICY_SCHEMA, "the policy asset declares its schema");
check(validateLaneResourcePolicy(policy).length === 0, "the shipped policy validates clean");
check(
  policy.budget_priority.mandatory_floor_ms === STAGE_FLOOR_MS,
  "the lane budget floor is P6.1's STAGE_FLOOR_MS, not a second convention",
);
const tiers = policy.worker_tiers;
check(tiers.length >= 2 && tiers[0].min_usable_memory_mib === 0, "the memory tier table starts at zero");
check(
  tiers.every((tier, index) => index === 0
    || (tier.min_usable_memory_mib > tiers[index - 1].min_usable_memory_mib
      && tier.max_workers > tiers[index - 1].max_workers)),
  "the memory tier table is strictly ascending in both columns",
);
check(
  !JSON.stringify(policy).includes("\"filings\"") && !JSON.stringify(policy).includes("\"broker\""),
  "the policy declares RESOURCE limits only; lane criticality stays in the product constitution",
);
const driftedFloor = JSON.parse(JSON.stringify(policy));
driftedFloor.budget_priority.mandatory_floor_ms = STAGE_FLOOR_MS + 1;
check(
  validateLaneResourcePolicy(driftedFloor).some((violation) => violation.includes("mandatory_floor_ms")),
  "a policy floor that drifts from P6.1's clock floor is refused",
);

// ---------------------------------------------------------------------------
// 2. Priority class comes from the product constitution
// ---------------------------------------------------------------------------
const criticalities = laneCriticalities();
check(lanePriorityClass(criticalities.filings, policy) === "mandatory", "filings is mandatory");
check(lanePriorityClass(criticalities.dcs, policy) === "mandatory", "dcs is mandatory");
check(lanePriorityClass(criticalities.broker, policy) === "optional", "broker is optional");
check(
  lanePriorityClass("something_unheard_of", policy) === "mandatory",
  "an unrecognised criticality defaults to mandatory (never silently optional)",
);

// ---------------------------------------------------------------------------
// 3. Worker count derives from resources, never from the lane count
// ---------------------------------------------------------------------------
const hosts = [
  { label: "developer host", cpuCount: 10, totalMemoryMib: 16384, laneCount: 2, workers: 2 },
  { label: "small ci box", cpuCount: 2, totalMemoryMib: 2048, laneCount: 2, workers: 1 },
  { label: "one cpu, plenty of memory", cpuCount: 1, totalMemoryMib: 65536, laneCount: 2, workers: 1 },
  { label: "large host, many lanes", cpuCount: 64, totalMemoryMib: 1048576, laneCount: 9, workers: 3 },
  { label: "one lane only", cpuCount: 64, totalMemoryMib: 1048576, laneCount: 1, workers: 1 },
];
for (const host of hosts) {
  const workers = resolveLaneWorkerCount({ policy, ...host });
  check(workers === host.workers, `${host.label}: worker count is ${host.workers}, got ${workers}`);
  check(workers >= 1 && workers <= host.laneCount, `${host.label}: worker count stays in [1, laneCount]`);
}
// MUTATION 1 — an unbounded pool must be caught.
refuses(
  () => assertBoundedWorkerCount({
    policy,
    workers: 2,
    laneCount: 2,
    cpuCount: 2,
    totalMemoryMib: 2048,
  }),
  "MUTATION: a pool sized by lane count on a constrained host must be refused",
);
assertBoundedWorkerCount({ policy, workers: 1, laneCount: 2, cpuCount: 2, totalMemoryMib: 2048 });
checks += 1;

// ---------------------------------------------------------------------------
// 4. Mandatory-vs-optional budget priority against P6.1's clock
// ---------------------------------------------------------------------------
const requests = { filings: 630_000, broker: 720_000, dcs: 180_000 };
function laneRequests(remainingComputeMs) {
  return sliceLaneBudgets({
    policy,
    remainingComputeMs,
    lanes: {
      filings: { criticality: criticalities.filings, requestedMs: requests.filings },
      broker: { criticality: criticalities.broker, requestedMs: requests.broker },
      dcs: { criticality: criticalities.dcs, requestedMs: requests.dcs },
    },
  });
}

// (a) No ledger => today's behaviour exactly.
const noClock = laneRequests(null);
check(noClock.budget_source === "declared_only", "with no ledger the budget source is the declaration");
for (const kind of Object.keys(requests)) {
  check(
    noClock.lanes[kind].granted_ms === requests[kind],
    `with no ledger ${kind} keeps its declared budget (certified-path equivalence)`,
  );
}

// (b) Fresh 25-minute clock => still today's behaviour.
const fresh = laneRequests(1_500_000);
check(fresh.budget_source === "run_deadline_ledger", "a ledger reading is named as the budget source");
for (const kind of Object.keys(requests)) {
  check(
    fresh.lanes[kind].granted_ms === requests[kind],
    `on a fresh clock ${kind} keeps its declared budget (certified-path equivalence)`,
  );
}

// (c) Squeezed clock: the optional lane may only have the surplus.
const reserve = policy.budget_priority.mandatory_reserve_ms;
const squeezed = laneRequests(reserve + 120_000);
check(squeezed.lanes.broker.granted_ms === 120_000, "the optional lane gets the surplus above the reserve only");
check(squeezed.lanes.dcs.granted_ms === requests.dcs, "mandatory dcs is untouched by the squeeze");
check(
  squeezed.lanes.filings.granted_ms === reserve + 120_000,
  "mandatory work is bounded by the CLOCK, never by the optional lane's appetite",
);
check(
  squeezed.lanes.filings.granted_ms > squeezed.lanes.broker.granted_ms,
  "under a squeeze the mandatory lane keeps more budget than the optional one",
);

// (d) Exhausted clock: the optional lane is starved, mandatory keeps its floor.
const exhausted = laneRequests(30_000);
check(exhausted.lanes.broker.granted_ms === 0, "an exhausted clock starves the optional lane");
check(exhausted.lanes.broker.starved === true, "the starved optional lane says so");
check(
  exhausted.lanes.dcs.granted_ms >= policy.budget_priority.mandatory_floor_ms,
  "mandatory work keeps at least the floor even past the ceiling",
);
check(exhausted.lanes.dcs.starved === false, "mandatory work is never starved");

// (e) Below the optional floor the lane is not started at all.
const belowFloor = laneRequests(reserve + policy.budget_priority.optional_floor_ms - 1);
check(belowFloor.lanes.broker.granted_ms === 0, "an optional grant below the optional floor is zero, not a token slice");

// MUTATION 2 — optional work consuming mandatory budget must be caught.
const tampered = JSON.parse(JSON.stringify(squeezed));
tampered.lanes.broker.granted_ms = 600_000;
refuses(
  () => assertMandatoryBudgetProtected(tampered, policy),
  "MUTATION: an optional grant that eats the mandatory reserve must be refused",
);
assertMandatoryBudgetProtected(squeezed, policy);
assertMandatoryBudgetProtected(fresh, policy);
assertMandatoryBudgetProtected(noClock, policy);
checks += 3;

// The caps are monotone in the remaining budget: more clock never means less grant.
let previous = -1;
for (const remaining of [0, 100_000, reserve, reserve + 300_000, 1_500_000]) {
  const caps = laneBudgetCaps({ policy, remainingComputeMs: remaining });
  const granted = grantLaneBudgetMs({
    policy,
    caps,
    priorityClass: "optional",
    requestedMs: requests.broker,
  }).granted_ms;
  check(granted >= previous, "the optional grant is monotone in the remaining budget");
  previous = granted;
}

// ---------------------------------------------------------------------------
// 5. Per-lane resource receipts
// ---------------------------------------------------------------------------
const goodReceipt = {
  schema_version: LANE_RESOURCE_RECEIPT_SCHEMA,
  lane: "broker",
  priority_class: "optional",
  criticality: "optional",
  worker_slot: 1,
  pool_max_workers: 2,
  reserved_cpu: 1,
  reserved_memory_mib: 1536,
  requested_budget_ms: 720_000,
  granted_budget_ms: 720_000,
  budget_source: "run_deadline_ledger",
  remaining_compute_ms_at_grant: 1_500_000,
  consumed_wall_ms: 41_234,
  consumed_cpu_ms: 39_000,
  cpu_attribution: "exclusive",
  peak_children_rss_mib: 812,
  budget_headroom_ms: 678_766,
  starved: false,
  late_enrichment_after_seal: false,
};
check(validateLaneResourceReceipt(goodReceipt).length === 0, "a complete lane resource receipt validates");
for (const field of [
  "priority_class",
  "granted_budget_ms",
  "consumed_wall_ms",
  "worker_slot",
  "budget_source",
  "reserved_memory_mib",
]) {
  const broken = { ...goodReceipt };
  delete broken[field];
  check(
    validateLaneResourceReceipt(broken).some((violation) => violation.includes(field)),
    `a receipt missing ${field} is refused`,
  );
}
check(
  validateLaneResourceReceipt({ ...goodReceipt, consumed_wall_ms: -1 }).length > 0,
  "a receipt with a negative consumption is refused",
);
check(
  validateLaneResourceReceipt({
    ...goodReceipt,
    consumed_wall_ms: goodReceipt.granted_budget_ms + 1,
    budget_headroom_ms: -1,
  }).some((violation) => violation.includes("cannot exceed")),
  "MUTATION: a lane may not consume beyond its grant",
);
check(
  validateLaneResourceReceipt({ ...goodReceipt, budget_headroom_ms: -1 })
    .some((violation) => violation.includes("cannot be negative")),
  "MUTATION: negative budget headroom is a refusal",
);
check(
  validateLaneResourceReceipt({ ...goodReceipt, budget_headroom_ms: 1 })
    .some((violation) => violation.includes("must reconcile")),
  "MUTATION: headroom must equal grant less consumption",
);
check(
  validateLaneResourceReceipt({ ...goodReceipt, cpu_attribution: "guessed" }).length > 0,
  "a receipt with an undeclared cpu attribution is refused",
);
check(
  validateLaneResourceReceipt({ ...goodReceipt, consumed_cpu_ms: 5, cpu_attribution: "pool_shared" }).length > 0,
  "a shared-counter receipt may not claim a per-lane cpu measurement",
);

// MUTATION 3 — a lane with no resource receipt must be caught.
refuses(
  () => assertLaneResourceReceiptsComplete(["filings", "broker", "dcs"], [goodReceipt]),
  "MUTATION: a lane that closed with no resource receipt must be refused",
);
assertLaneResourceReceiptsComplete(
  ["broker"],
  [goodReceipt],
);
checks += 1;

// Late enrichment against sealed authority is an EVENT, not silence.
check(
  laneLateEnrichmentEvent({
    lane: "broker",
    priorityClass: "optional",
    sealedAtMs: 2_000,
    closedAtMs: 1_000,
    authorityEdgeCount: 4,
  }) === null,
  "an optional lane that closed before the seal raises no late-enrichment event",
);
const lateEvent = laneLateEnrichmentEvent({
  lane: "broker",
  priorityClass: "optional",
  sealedAtMs: 1_000,
  closedAtMs: 2_500,
  authorityEdgeCount: 4,
});
check(lateEvent !== null && lateEvent.lane === "broker", "a late optional close with authority raises an event");
check(lateEvent.late_by_ms === 1_500, "the late-enrichment event measures how late it was");
check(
  laneLateEnrichmentEvent({
    lane: "broker",
    priorityClass: "optional",
    sealedAtMs: 1_000,
    closedAtMs: 2_500,
    authorityEdgeCount: 0,
  }) === null,
  "a late close that selected no authority cannot invalidate a seal",
);

// ---------------------------------------------------------------------------
// 6. The real python controller: one policy, two readers
// ---------------------------------------------------------------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "p65-bounded-"));
const driverPath = path.join(scratch, "drive_pool.py");
fs.writeFileSync(driverPath, `
import json, sys, threading, time
sys.path.insert(0, ${JSON.stringify(HERE)})
import run_attachment_evidence_pipeline as pipeline

request = json.loads(sys.stdin.read())
out = {}

policy = pipeline.load_lane_resource_policy()
out["policy_schema_version"] = policy["schema_version"]

out["worker_counts"] = [
    pipeline.resolve_lane_worker_count(policy, host["laneCount"], host["cpuCount"], host["totalMemoryMib"])
    for host in request["hosts"]
]

out["caps"] = [
    pipeline.lane_budget_caps(policy, remaining)
    for remaining in request["remaining_readings"]
]

out["grants"] = [
    [
        pipeline.grant_lane_budget_ms(
            policy, pipeline.lane_budget_caps(policy, remaining), priority_class, requested
        )
        for priority_class in ("mandatory", "optional")
        for requested in (630000, 720000, 180000)
    ]
    for remaining in request["remaining_readings"]
]

out["deadline_env_name"] = pipeline.RUN_DEADLINE_ENV_NAME
out["remaining_from_env"] = pipeline.run_deadline_remaining_ms()

# Drive the REAL bounded pool over identical stub lanes at two worker counts.
def drive(max_workers):
    plan = pipeline.resolve_lane_pool_plan(
        lane_kinds=["broker", "dcs"],
        remaining_compute_ms=1_500_000,
        cpu_count=request["pool_cpu"],
        total_memory_mib=request["pool_memory_mib"],
    )
    plan["max_workers"] = max_workers
    active = []
    peak = [0]
    guard = threading.Lock()

    def execute(kind, declaration):
        with guard:
            active.append(kind)
            peak[0] = max(peak[0], len(active))
        time.sleep(0.05)
        with guard:
            active.remove(kind)
        return ({"pipeline_status": "PASS", "lane": kind}, 5)

    states, durations, observations = pipeline.execute_lane_pool(
        plan=plan,
        declarations={"broker": {"request_path": "b"}, "dcs": {"request_path": "d"}},
        execute=execute,
    )
    return {
        "plan_schema_version": plan["schema_version"],
        "plan_max_workers": plan["max_workers"],
        "observed_peak_concurrency": peak[0],
        "states": states,
        "durations": durations,
        "worker_slots": {kind: value["worker_slot"] for kind, value in observations.items()},
        "attribution": {kind: value["cpu_attribution"] for kind, value in observations.items()},
    }

out["pool_two"] = drive(2)
out["pool_one"] = drive(1)

plan = pipeline.resolve_lane_pool_plan(
    lane_kinds=["broker", "dcs"],
    remaining_compute_ms=1_500_000,
    cpu_count=10,
    total_memory_mib=16384,
)
out["plan"] = plan

receipt = pipeline.compile_lane_resource_receipt(
    plan=plan,
    kind="broker",
    grant={"requested_ms": 720000, "granted_ms": 720000, "starved": False},
    observation={
        "worker_slot": 0,
        "wall_ms": 1200,
        "cpu_ms": 900,
        "cpu_attribution": "exclusive",
        "peak_rss_mib": 400,
    },
)
out["receipt"] = receipt

# Does the GRANT actually reach the lane subprocess's watchdog?
import pathlib, subprocess, tempfile
recorded = []
real_run = pipeline.run

def fake_run(command, *, timeout_seconds=None):
    recorded.append(timeout_seconds)
    return subprocess.CompletedProcess(command, 0, "", "")

pipeline.run = fake_run
scratch = pathlib.Path(tempfile.mkdtemp())
request_file = scratch / "dcs-request.json"
request_file.write_text(json.dumps({"documents": [{"document_id": "a", "path": "x"}]}))
declaration = {"request_path": str(request_file)}
pipeline.run_lane("dcs", declaration, scratch, scratch)
out["ungranted_timeout_seconds"] = recorded[-1]
pipeline.ACTIVE_LANE_BUDGET_MS["dcs"] = 90_000
pipeline.run_lane("dcs", declaration, scratch, scratch)
out["granted_timeout_seconds"] = recorded[-1]
pipeline.ACTIVE_LANE_BUDGET_MS["dcs"] = 9_999_000
pipeline.run_lane("dcs", declaration, scratch, scratch)
out["over_granted_timeout_seconds"] = recorded[-1]
pipeline.ACTIVE_LANE_BUDGET_MS.pop("dcs", None)
pipeline.run = real_run

# Drive the REAL broker lane under a fake monotonic clock. Ten documents request
# the full 720s envelope. Primary consumes 710s, so close may receive only 10s.
broker_request = scratch / "broker-request.json"
broker_request.write_text(json.dumps({
    "documents": [
        {"document_id": f"d{index}", "path": "x"}
        for index in range(10)
    ]
}))
broker_state_path = scratch / "broker" / "broker-run-state.json"
broker_state_path.parent.mkdir(parents=True, exist_ok=True)
broker_recorded = []
clock_ms = [10_000.0]
real_monotonic = pipeline.time.monotonic

def fake_monotonic():
    return clock_ms[0] / 1000

def fake_broker_run(command, *, timeout_seconds=None):
    broker_recorded.append(timeout_seconds)
    closing = "--close-optional" in command
    clock_ms[0] += 10_000 if closing else 710_000
    state = {
        "schema_version": "broker-run-state/1.0",
        "pipeline_status": "PASS_DEGRADED" if closing else "BLOCKED_INTERNAL",
        "user_blocking": False,
        "blocker_class": None if closing else "INTERNAL_WORK",
        "tasks": [],
        "artifacts": {},
        "artifact_sha256": {},
        "summary": {"degraded": closing},
    }
    broker_state_path.write_text(json.dumps(state))
    return subprocess.CompletedProcess(command, 2, "", "")

pipeline.time.monotonic = fake_monotonic
pipeline.run = fake_broker_run
pipeline.ACTIVE_LANE_BUDGET_MS["broker"] = 720_000
broker_result = pipeline.run_lane(
    "broker", {"request_path": str(broker_request)}, scratch, scratch
)
third = pipeline.begin_broker_wall_segment(
    scratch,
    "broker_third_attempt",
    requested_ms=720_000,
    limit_ms=720_000,
    now_wall_epoch_ms=50_000,
    now_monotonic_ms=720_000,
)
broker_ledger = json.loads((scratch / pipeline.BROKER_WALL_BUDGET_FILE).read_text())
out["broker_residual_close"] = {
    "timeouts": broker_recorded,
    "result_status": broker_result["pipeline_status"],
    "consumed_ms": broker_ledger["consumed_ms"],
    "third_started": third["started"],
    "segment_operations": [segment["operation"] for segment in broker_ledger["segments"]],
}
pipeline.ACTIVE_LANE_BUDGET_MS.pop("broker", None)
pipeline.time.monotonic = real_monotonic
pipeline.run = real_run

# Persisted resume: eight minutes spent leaves four. Corrupt bytes fail closed
# to zero remaining instead of minting another twelve-minute envelope.
resume_root = scratch / "resume-budget"
resume_token = pipeline.begin_broker_wall_segment(
    resume_root, "broker_primary", requested_ms=720_000, limit_ms=720_000,
    now_wall_epoch_ms=1_000, now_monotonic_ms=1_000,
)
pipeline.end_broker_wall_segment(
    resume_root, resume_token, outcome="PASS",
    now_wall_epoch_ms=481_000, now_monotonic_ms=481_000,
)
resumed = pipeline.begin_broker_wall_segment(
    resume_root, "broker_resumed", requested_ms=720_000, limit_ms=720_000,
    now_wall_epoch_ms=500_000, now_monotonic_ms=500_000,
)
out["broker_resume_allowance_ms"] = resumed["allowance_ms"]
pipeline.end_broker_wall_segment(
    resume_root, resumed, outcome="PASS",
    now_wall_epoch_ms=500_000, now_monotonic_ms=500_000,
)
(resume_root / pipeline.BROKER_WALL_BUDGET_FILE).write_text("{broken")
corrupt = pipeline.begin_broker_wall_segment(
    resume_root, "broker_after_corruption", requested_ms=720_000, limit_ms=720_000,
    now_wall_epoch_ms=600_000, now_monotonic_ms=600_000,
)
out["broker_corrupt_started"] = corrupt["started"]
out["broker_corrupt_remaining_ms"] = corrupt["remaining_ms"]

try:
    pipeline.assert_lane_resource_receipts_complete(["broker"], [{
        **receipt,
        "consumed_wall_ms": 720_001,
        "budget_headroom_ms": -1,
    }])
    out["python_negative_headroom_refused"] = False
except ValueError:
    out["python_negative_headroom_refused"] = True

# run_lane's four-argument boundary is what the lane test doubles stand on.
import inspect
out["run_lane_arity"] = len(inspect.signature(pipeline.run_lane).parameters)

source = open(${JSON.stringify(PIPELINE)}, "r", encoding="utf-8").read()
out["names_lane_count_workers"] = "max_workers=len(" in source
out["deadline_env_reads"] = source.count("RUN_DEADLINE_ENV_NAME")

print(json.dumps(out))
`, "utf8");

const remainingReadings = [null, 0, 100_000, reserve + 120_000, 1_500_000];
const driverInput = JSON.stringify({
  hosts: hosts.map(({ cpuCount, totalMemoryMib, laneCount }) => ({ cpuCount, totalMemoryMib, laneCount })),
  remaining_readings: remainingReadings,
  pool_cpu: 10,
  pool_memory_mib: 16384,
});

// A REAL P6.1 ledger, opened by P6.1's own writer, handed to python by env.
const ledgerDir = path.join(scratch, "run");
fs.mkdirSync(ledgerDir, { recursive: true });
const deadline = await openRunDeadline({
  runDir: ledgerDir,
  identity: { runId: "p65-bounded-parallelism" },
});
const ledgerPath = deadline.path;

const driverRaw = execFileSync(PYTHON, [driverPath], {
  input: driverInput,
  encoding: "utf8",
  env: { ...process.env, [RUN_DEADLINE_ENV]: ledgerPath },
  maxBuffer: 16 * 1024 * 1024,
});
const drive = JSON.parse(driverRaw.trim().split("\n").pop());

check(
  drive.policy_schema_version === policy.schema_version,
  "the python controller reads the SAME declared policy asset the module reads",
);
check(
  JSON.stringify(drive.worker_counts) === JSON.stringify(hosts.map((host) => host.workers)),
  `python worker derivation matches the module across the host matrix: ${JSON.stringify(drive.worker_counts)}`,
);
for (const [index, remaining] of remainingReadings.entries()) {
  const expected = laneBudgetCaps({ policy, remainingComputeMs: remaining });
  const actual = drive.caps[index];
  check(
    actual.mandatory_cap_ms === expected.mandatory_cap_ms
      && actual.optional_cap_ms === expected.optional_cap_ms
      && actual.budget_source === expected.budget_source,
    `python budget caps match the module at remaining=${remaining}`,
  );
}
for (const [index, remaining] of remainingReadings.entries()) {
  const caps = laneBudgetCaps({ policy, remainingComputeMs: remaining });
  const expected = [];
  for (const priorityClass of ["mandatory", "optional"]) {
    for (const requestedMs of [630_000, 720_000, 180_000]) {
      expected.push(grantLaneBudgetMs({ policy, caps, priorityClass, requestedMs }));
    }
  }
  check(
    JSON.stringify(drive.grants[index]) === JSON.stringify(expected),
    `python lane grants match the module at remaining=${remaining}: ${JSON.stringify(drive.grants[index])}`,
  );
}
check(drive.deadline_env_name === RUN_DEADLINE_ENV, "python charges P6.1's ledger variable, not a second clock");
check(
  drive.remaining_from_env !== null && drive.remaining_from_env > 0,
  "python reads the remaining compute out of the REAL P6.1 ledger it was handed",
);
const ledgerAfter = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
check(
  ledgerAfter.compute_elapsed_ms === 0 && (ledgerAfter.segments ?? []).length === 0,
  "reading the clock from python does not WRITE it: there is still exactly one ledger writer",
);
check(drive.names_lane_count_workers === false, "the controller no longer sizes its pool by lane count");
check(
  drive.ungranted_timeout_seconds === 180,
  "with no grant the lane keeps its own declared watchdog (certified-path equivalence)",
);
check(
  drive.granted_timeout_seconds === 90,
  "the budget GRANT reaches the lane subprocess watchdog, not just the receipt",
);
check(
  drive.over_granted_timeout_seconds === 180,
  "a grant can shorten a lane's watchdog but never lengthen it",
);
check(
  JSON.stringify(drive.broker_residual_close.timeouts) === JSON.stringify([720, 10]),
  `the real broker lane did not subtract primary wall time from close: ${JSON.stringify(drive.broker_residual_close)}`,
);
check(
  drive.broker_residual_close.consumed_ms === 720_000
    && drive.broker_residual_close.third_started === false,
  "the persisted broker ledger did not exhaust exactly once at 720 seconds",
);
check(
  JSON.stringify(drive.broker_residual_close.segment_operations)
    === JSON.stringify(["broker_primary", "broker_optional_close"]),
  "primary and optional close are not charged to the same persisted envelope",
);
check(
  drive.broker_resume_allowance_ms === 240_000,
  "a resumed broker lane received a fresh envelope instead of the four minutes remaining",
);
check(
  drive.broker_corrupt_started === false && drive.broker_corrupt_remaining_ms === 0,
  "a corrupt broker wall ledger restored optional work instead of failing closed",
);
check(drive.python_negative_headroom_refused === true, "the production Python receipt gate accepts negative headroom");
check(
  drive.run_lane_arity === 4,
  "run_lane keeps the four-argument boundary the lane test doubles stand on",
);

check(drive.plan.schema_version === LANE_RESOURCE_PLAN_SCHEMA, "the pool plan is a declared, versioned artifact");
check(drive.plan.max_workers === 2, "on the developer host the two-lane pool still runs two workers");
check(
  drive.plan.caps.mandatory_cap_ms >= drive.plan.caps.optional_cap_ms,
  "the mandatory cap is never below the optional cap",
);
check(drive.plan.lanes.broker.priority_class === "optional", "the plan classifies broker as optional");
check(drive.plan.lanes.dcs.priority_class === "mandatory", "the plan classifies dcs as mandatory");

// Bounded pool == unbounded evidence, fewer workers.
check(drive.pool_two.observed_peak_concurrency === 2, "the two-worker pool really did run two lanes at once");
check(drive.pool_one.observed_peak_concurrency === 1, "the one-worker pool never ran two lanes at once");
check(
  JSON.stringify(drive.pool_two.states) === JSON.stringify(drive.pool_one.states),
  "EQUIVALENCE: the bounded pool produced identical lane states",
);
check(
  JSON.stringify(drive.pool_two.durations) === JSON.stringify(drive.pool_one.durations),
  "EQUIVALENCE: the bounded pool produced identical lane durations",
);
check(
  drive.pool_one.attribution.broker === "exclusive" && drive.pool_one.attribution.dcs === "exclusive",
  "a one-worker pool can attribute cpu per lane exactly",
);
check(
  drive.pool_two.attribution.broker === "pool_shared",
  "a concurrent lane declares its cpu reading as shared instead of claiming a false measurement",
);
check(validateLaneResourceReceipt(drive.receipt).length === 0, "the python-compiled lane receipt validates");
check(drive.receipt.lane === "broker" && drive.receipt.priority_class === "optional", "the receipt names its lane and class");
check(
  drive.receipt.budget_headroom_ms === 720_000 - 1_200,
  "the receipt states the headroom between the grant and the consumption",
);
fs.rmSync(scratch, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 7. A real circuit breaker: counter, threshold, budget input, open/half-open
// ---------------------------------------------------------------------------
function breakerHarness({ failures = 0, ...options } = {}) {
  let primaryRuns = 0;
  let fallbackRuns = 0;
  let state = null;
  const promise = executeOptionalBrokerCircuitBreaker({
    runPrimary: async () => {
      primaryRuns += 1;
      if (primaryRuns <= failures) throw new Error("adapter exploded");
      state = { pipeline_status: "PASS", lane_states: { broker: { pipeline_status: "PASS_DEGRADED" } } };
    },
    readState: async () => state,
    runZeroAuthority: async () => {
      fallbackRuns += 1;
      state = {
        pipeline_status: "PASS",
        lane_states: {
          broker: {
            pipeline_status: "PASS_DEGRADED",
            summary: { fault_contained_to_zero_authority: true },
          },
        },
      };
    },
    ...options,
  });
  return promise.then((result) => ({ result, primaryRuns, fallbackRuns }));
}

// (a) Defaults reproduce today's one-shot behaviour exactly.
const oneShot = await breakerHarness({ failures: 1 });
check(oneShot.primaryRuns === 1, "the default breaker attempts the primary exactly once");
check(oneShot.fallbackRuns === 1, "the default breaker falls back exactly once");
check(oneShot.result.circuit_breaker_used === true, "the default breaker reports that it fired");
check(oneShot.result.reason_code === "broker_controller_exception", "the reason code is unchanged");

// A broker lane can close before its final semantic/declaration bytes are
// joined into attachment ingress. The aggregate state is then internal-failed
// even though broker itself says PASS. That is still a broker counterfactual
// only when every mandatory lane is already closed.
async function statefulBreaker(initialState) {
  let fallbackRuns = 0;
  let state = structuredClone(initialState);
  const result = await executeOptionalBrokerCircuitBreaker({
    runPrimary: async () => ({ code: 2, stderr: "attachment ingress failed" }),
    readState: async () => state,
    runZeroAuthority: async () => {
      fallbackRuns += 1;
      state = {
        pipeline_status: "PASS",
        lane_states: {
          filings: { pipeline_status: "PASS" },
          broker: {
            pipeline_status: "PASS_DEGRADED",
            summary: { fault_contained_to_zero_authority: true },
          },
          dcs: { pipeline_status: "PASS" },
        },
      };
      return { code: 0 };
    },
  });
  return { result, fallbackRuns };
}

const postClose = await statefulBreaker({
  pipeline_status: "BLOCKED_INTERNAL",
  blocker_class: "INTERNAL_WORK",
  user_blocking: false,
  summary: { terminal_reason: "attachment_ingress_failed" },
  lane_states: {
    filings: { pipeline_status: "PASS" },
    broker: { pipeline_status: "PASS" },
    dcs: { pipeline_status: "PASS" },
  },
});
check(postClose.fallbackRuns === 1, "a broker post-close ingress failure did not run the zero-authority counterfactual");
check(postClose.result.circuit_breaker_used === true, "the post-close circuit-breaker outcome was not disclosed");
check(postClose.result.state.pipeline_status === "PASS", "a successful zero-authority counterfactual did not continue delivery");
check(postClose.result.breaker_receipt.zero_authority_executed === true, "the post-close receipt omitted zero-authority execution");

const mandatoryOnly = await statefulBreaker({
  pipeline_status: "BLOCKED_INTERNAL",
  blocker_class: "INTERNAL_WORK",
  user_blocking: false,
  lane_states: {
    filings: { pipeline_status: "BLOCKED_INTERNAL", blocker_class: "INTERNAL_WORK" },
    dcs: { pipeline_status: "PASS" },
  },
});
check(mandatoryOnly.fallbackRuns === 0, "a mandatory failure with no broker lane was hidden by zero authority");
check(mandatoryOnly.result.circuit_breaker_used === false, "a mandatory failure was mislabeled as broker degradation");
check(mandatoryOnly.result.state.pipeline_status === "BLOCKED_INTERNAL", "the mandatory state was not preserved");

const mandatoryOpen = await statefulBreaker({
  pipeline_status: "BLOCKED_INTERNAL",
  blocker_class: "INTERNAL_WORK",
  user_blocking: false,
  lane_states: {
    filings: { pipeline_status: "BLOCKED_INTERNAL", blocker_class: "INTERNAL_WORK" },
    broker: { pipeline_status: "PASS" },
    dcs: { pipeline_status: "PASS" },
  },
});
check(mandatoryOpen.fallbackRuns === 0, "a broker lane hid an unclosed mandatory failure");
check(mandatoryOpen.result.state.lane_states.filings.pipeline_status === "BLOCKED_INTERNAL", "the unclosed mandatory lane was not preserved");

let unchangedState = {
  pipeline_status: "BLOCKED_INTERNAL",
  blocker_class: "INTERNAL_WORK",
  user_blocking: false,
  lane_states: {
    filings: { pipeline_status: "PASS" },
    broker: { pipeline_status: "PASS" },
    dcs: { pipeline_status: "PASS" },
  },
};
await assert.rejects(
  executeOptionalBrokerCircuitBreaker({
    runPrimary: async () => ({ code: 2, stderr: "post-close failure" }),
    readState: async () => unchangedState,
    runZeroAuthority: async () => ({ code: 0 }),
  }),
  /cannot infer zero authority from a successful process exit alone/,
  "a zero-authority process exit without a fresh zero-authority state was accepted",
);
checks += 1;

// (b) The healthy path never opens.
const healthy = await breakerHarness({ failures: 0 });
check(healthy.result.circuit_breaker_used === false, "a healthy primary does not fire the breaker");
check(healthy.fallbackRuns === 0, "a healthy primary never runs zero authority");
check(healthy.result.breaker_receipt.breaker_state === "closed", "a healthy run leaves the breaker closed");
check(healthy.result.breaker_receipt.failure_count === 0, "a healthy run counts zero failures");

// (c) A counter and a threshold, not a one-shot.
const retried = await breakerHarness({ failures: 3, failureThreshold: 2, maxAttempts: 3 });
check(retried.primaryRuns === 2, "the breaker retries the primary up to the failure threshold");
check(retried.result.breaker_receipt.failure_count === 2, "the breaker COUNTS failures");
check(retried.result.breaker_receipt.failure_threshold === 2, "the breaker states the threshold it applied");
check(retried.result.breaker_receipt.breaker_state === "open", "reaching the threshold OPENS the breaker");
check(retried.fallbackRuns === 1, "an open breaker runs zero authority once");
const recovered = await breakerHarness({ failures: 1, failureThreshold: 2, maxAttempts: 3 });
check(recovered.primaryRuns === 2, "a primary that recovers within the threshold is retried and accepted");
check(recovered.result.circuit_breaker_used === false, "a recovered primary does not fire the breaker");

// (d) Remaining budget is an input: a starved breaker never spends what it does not have.
const starved = await breakerHarness({ failures: 0, remainingBudgetMs: 5_000 });
check(starved.primaryRuns === 0, "a budget-starved breaker does not start the optional primary at all");
check(starved.fallbackRuns === 1, "a budget-starved breaker closes through zero authority");
check(starved.result.breaker_receipt.breaker_state === "open", "budget starvation opens the breaker");
check(starved.result.reason_code === "broker_timeout", "budget starvation is reported as a broker timeout");
check(
  starved.result.breaker_receipt.remaining_budget_ms === 5_000,
  "the breaker receipt records the remaining budget it was given",
);
const sliceZero = await breakerHarness({ failures: 0, budgetSliceMs: 0, remainingBudgetMs: 1_500_000 });
check(sliceZero.primaryRuns === 0, "a zero optional slice opens the breaker even on a healthy clock");

// (e) Half-open: a previously open breaker gets ONE trial attempt when budget returns.
const halfOpen = await breakerHarness({
  failures: 0,
  remainingBudgetMs: 1_500_000,
  priorReceipt: { breaker_state: "open", failure_count: 1 },
});
check(halfOpen.primaryRuns === 1, "a half-open breaker allows exactly one trial attempt");
check(halfOpen.result.breaker_receipt.breaker_state === "closed", "a successful trial closes the breaker");
const halfOpenFails = await breakerHarness({
  failures: 3,
  maxAttempts: 3,
  failureThreshold: 3,
  remainingBudgetMs: 1_500_000,
  priorReceipt: { breaker_state: "open", failure_count: 2 },
});
check(halfOpenFails.primaryRuns === 1, "a failing trial is not retried; half-open allows one attempt only");
check(halfOpenFails.result.breaker_receipt.breaker_state === "open", "a failing trial re-opens the breaker");
check(
  halfOpenFails.result.breaker_receipt.failure_count === 3,
  "the failure counter carries the prior receipt's count forward",
);

// (f) The receipt exists, validates, and cannot be silently dropped.
check(validateBrokerBreakerReceipt(oneShot.result.breaker_receipt).length === 0, "the breaker receipt validates");
check(
  oneShot.result.breaker_receipt.registry_reason_code === BROKER_DEGRADE_REGISTRY_REASON,
  "the breaker crosswalks its degrade reason to a REGISTERED terminal reason code",
);
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"));
check(
  Object.keys(registry.reason_codes).includes(BROKER_DEGRADE_REGISTRY_REASON),
  "that registry code already exists: the four degrade literals need a crosswalk, not four new codes",
);
assertBreakerReceiptCarried(oneShot.result);
checks += 1;
refuses(
  () => assertBreakerReceiptCarried({ state: {}, circuit_breaker_used: true, reason_code: "broker_timeout" }),
  "MUTATION: a call site that keeps only .state and drops the breaker receipt must be refused",
);
const publicControllerSource = fs.readFileSync(
  path.join(ROOT, "scripts", "run_excel_inflow_vnext.mjs"),
  "utf8",
);
check(
  publicControllerSource.includes("assertBreakerReceiptCarried(brokerCircuitBreaker)"),
  "the public controller does not validate the breaker receipt it consumes",
);
check(
  publicControllerSource.includes('artifacts.optional_broker_breaker_receipt = brokerBreakerReceiptPath'),
  "the public controller silently drops the breaker receipt instead of preserving it",
);
check(
  publicControllerSource.includes('"optional_broker_circuit_breaker"'),
  "the public controller does not hash-bind the breaker receipt into its checkpoint chain",
);
check(
  publicControllerSource.includes("remainingBudgetMs: remainingRunBudgetMs")
    && publicControllerSource.includes("budgetSliceMs: brokerBudgetSliceMs")
    && publicControllerSource.includes("priorReceipt: usablePriorBrokerBreakerReceipt"),
  "the production breaker call does not receive its real remaining budget, optional slice and prior receipt",
);
check(
  publicControllerSource.includes('stage: "optional_broker_zero_authority_close"')
    && publicControllerSource.includes("requestedMs: STAGE_FLOOR_MS")
    && !/runZeroAuthority:[\s\S]{0,900}timeout:\s*ACTIVE_RUNTIME_BUDGET\.budgets_ms\.broker_global/.test(publicControllerSource),
  "force-zero closure still receives a fresh 720-second broker-processing allowance",
);
check(
  OPTIONAL_BROKER_BREAKER_POLICY.minimum_budget_ms === STAGE_FLOOR_MS,
  "the breaker's minimum optional budget is P6.1's stage floor, not a second number",
);

assert.equal(typeof checks, "number");
process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
