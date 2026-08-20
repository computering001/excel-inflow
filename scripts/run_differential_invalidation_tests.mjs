#!/usr/bin/env node
/**
 * P6.4 — DIFFERENTIAL INVALIDATION, AND THE HONESTY OF A REUSE CLAIM.
 *
 * Invariant under test: a change invalidates exactly the work it should — no
 * more, no less — and the reuse a run CLAIMS is the reuse it actually
 * performed.
 *
 * The reds this suite pins, every one of them measured on the real controller
 * before the repair:
 *
 *  RED 1  `reused_stages` was not honest. On a warm answered run against the
 *         acquisition fixture the controller reported
 *         `["inputs","evidence_review","decisions"]` while FIVE nodes inside
 *         those three stages re-executed: `answered_case_recompile` (148ms) and
 *         `intake_replay` (80ms) in `decisions`, and all three
 *         `evidence_review` nodes (1032ms). The stage-3 reuse check sat BELOW
 *         the answered-case recompile and the decision replay, so both ran, and
 *         both results were then thrown away in favour of the cached
 *         `model-case.json`. Part G proves the recompile and the replay are now
 *         SKIPPED, and Part F proves a claim that cannot be backed is refused.
 *  RED 2  `CHANGE_INVALIDATION` and `earliestInvalidatedStage` had ZERO callers
 *         anywhere in the repository — a dead twelve-entry literal that nothing
 *         had ever compared with the work that exists. When it was finally
 *         checked against P6.3's measured node graph, EIGHT of the twelve
 *         entries disagreed, every one of them in the UNSAFE direction (they
 *         named a LATER stage than the work keyed on the change, i.e. they
 *         licensed reuse of work the change had already invalidated). Part B is
 *         that comparison; Part H drives one of the eight through the real
 *         controller end to end.
 *  RED 3  There was no error classification table at all: no class, no retry
 *         count, no cache-reuse rule, no downstream invalidation scope, and no
 *         binding from a failure to the terminal-reason registry. Parts C and D.
 *  RED 4  There were no attempt receipts, and the only lane in the repository
 *         with any retry story was the broker supervisor. Part E is a retry
 *         idempotency proof in the EVIDENCE half, deliberately outside it.
 *
 * WHAT THIS SUITE DOES NOT RE-PROVE: P6.3's work graph, reason vocabulary and
 * node receipts (`run_evidence_work_graph_tests.mjs`), P6.2's stage recipes
 * (`run_stage_recipe_tests.mjs`), P6.1's clock (`run_hard_clock_tests.mjs`) and
 * stage 4's own resume (`run_stage4_checkpoint_tests.mjs`). Stage 4 is not
 * touched by this package at all.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CHANGE_KEY_COMPONENTS,
  EVIDENCE_WORK_GRAPH_DIR,
  EVIDENCE_WORK_DECISION_FILE,
  EVIDENCE_WORK_NODES,
  createEvidenceWorkGraph,
  invalidatedNodesForChange,
  reuseClaimLedger,
} from "./lib/evidence_work_graph.mjs";
import {
  ATTEMPT_LEDGER_FILE,
  ATTEMPT_REFUSALS,
  ERROR_CLASSES,
  assertClassifiedError,
  classifyError,
  createAttemptLedger,
  errorClassificationTable,
  validateErrorClassificationTable,
} from "./lib/error_classification.mjs";
import {
  CHANGE_INVALIDATION,
  SUPERSEDED_CHANGE_INVALIDATION,
  changeInvalidationDisagreements,
  earliestInvalidatedStage,
  measuredEarliestInvalidatedStage,
} from "./lib/flow_runtime.mjs";
import { hashValue } from "./lib/run_store.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const cases = path.resolve(
  process.argv[2] ??
    process.env.DEBT_OVERLAY_CASES_DIR ??
    fileURLToPath(new URL("../test-fixtures/cases", import.meta.url)),
);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dmu-differential-invalidation-"));

let checks = 0;
const violations = [];
function check(condition, message) {
  checks += 1;
  if (!condition) violations.push(message);
}

async function command(script, args) {
  return exec(process.execPath, [path.join(HERE, script), ...args], {
    cwd: ROOT,
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}

// ---------------------------------------------------------------------------
// PART A — THE HOIST IS IN THE SOURCE, AND IN THE RIGHT ORDER.
//
// A structural pin, because the ordering IS the repair: if the stage-3 reuse
// check ever slides back below the recompile or the replay, the run starts
// paying for work it then discards, and no output changes to say so.
// ---------------------------------------------------------------------------
const controllerSource = await fs.readFile(path.join(ROOT, "scripts", "run_user_flow.mjs"), "utf8");
const stage3CheckAt = controllerSource.indexOf('stageId: "decisions",\n    inputHashes: stage3Inputs');
const recompileAt = controllerSource.indexOf('id: "answered_case_recompile"');
const replayAt = controllerSource.indexOf('id: "intake_replay"');
check(stage3CheckAt > 0, "the stage-3 reuse check is no longer identifiable in the controller");
check(recompileAt > 0, "the answered-case recompile node call site is gone");
check(replayAt > 0, "the intake replay node call site is gone");
check(
  stage3CheckAt < recompileAt,
  "the stage-3 reuse check runs AFTER the answered-case recompile: the run pays for work it discards",
);
check(
  stage3CheckAt < replayAt,
  "the stage-3 reuse check runs AFTER the intake replay: the run pays for work it discards",
);
check(
  /if \(!cached3\.reusable && intakeResult\.outcome === "questions"\)/.test(controllerSource),
  "the answered-decision branch is no longer guarded by the stage-3 reuse decision",
);
// The stage-1 check was already hoisted; the stage-2 one cannot be, and the
// reason is recorded rather than left as an omission (see Part G).
check(
  /sealReuseClaim\(/.test(controllerSource),
  "the controller never seals its reuse claim against what the work graph recorded",
);
check(
  /createAttemptLedger\(/.test(controllerSource),
  "the controller opens no attempt ledger",
);

// ---------------------------------------------------------------------------
// PART B — THE INVALIDATION MAP, MEASURED RATHER THAN TRUSTED.
// ---------------------------------------------------------------------------
check(
  changeInvalidationDisagreements().length === 0,
  `the declared invalidation map disagrees with the measured work graph: ${JSON.stringify(changeInvalidationDisagreements())}`,
);
check(
  Object.keys(CHANGE_INVALIDATION).length === 12,
  `the invalidation map no longer declares twelve change types: ${Object.keys(CHANGE_INVALIDATION).length}`,
);
for (const change of Object.keys(CHANGE_INVALIDATION)) {
  check(
    Object.hasOwn(CHANGE_KEY_COMPONENTS, change),
    `${change} is declared in the invalidation map but names no cache-key components`,
  );
}

// THE RED, PINNED. The historical literal must be REFUSED by the checker, and
// refused for the right reason on the right eight entries.
const historical = changeInvalidationDisagreements(SUPERSEDED_CHANGE_INVALIDATION);
check(
  historical.length === 8,
  `the historical invalidation literal no longer disagrees on eight entries: ${historical.length}`,
);
check(
  historical.every((entry) => entry.direction === "later_than_measured"),
  `a historical disagreement is not in the unsafe direction: ${JSON.stringify(historical)}`,
);
for (const change of [
  "source_file",
  "filing",
  "debt_export",
  "broker_forecast",
  "prior_case",
  "user_answer",
  "assumption",
  "transaction_input",
]) {
  const entry = historical.find((candidate) => candidate.change === change);
  check(entry !== undefined, `the historical literal's error on ${change} is no longer detected`);
}
for (const change of ["source_file", "filing", "debt_export", "broker_forecast", "prior_case"]) {
  check(
    measuredEarliestInvalidatedStage(change).id === "inputs",
    `${change} does not measure back to the inputs stage: ${measuredEarliestInvalidatedStage(change).id}`,
  );
}
check(
  measuredEarliestInvalidatedStage("user_answer").id === "decisions",
  "an answer no longer measures back to the decisions stage",
);
check(
  measuredEarliestInvalidatedStage("controller_code").id === "inputs",
  "a controller-code change no longer invalidates the whole evidence half",
);
check(
  measuredEarliestInvalidatedStage("delivery_wording").id === "delivery",
  "delivery wording no longer floors at the delivery stage",
);
// `earliestInvalidatedStage` now has callers; it must still refuse an unknown
// change type rather than answering for one.
let unknownChangeRefused = false;
try {
  earliestInvalidatedStage("a_change_nobody_declared");
} catch {
  unknownChangeRefused = true;
}
check(unknownChangeRefused, "an undeclared change type was given an invalidation answer");

// EXACTLY THE EXPECTED NODES, AND NO OTHERS — at graph level, for every
// declared change type.
const allNodeIds = EVIDENCE_WORK_NODES.map((node) => node.id);
const EXPECTED_INVALIDATED = Object.freeze({
  // the envelope hash is the first node's only key, so the whole DAG falls
  company_name: allNodeIds,
  source_file: allNodeIds,
  filing: allNodeIds,
  debt_export: allNodeIds,
  broker_forecast: allNodeIds,
  prior_case: allNodeIds,
  controller_code: allNodeIds,
  // an answer touches the decisions half and nothing above it
  user_answer: [
    "answered_case_recompile",
    "intake_replay",
    "statement_normalisation",
    "forecast_behavior_map",
    "model_demand_graph",
    "forecast_plan",
    "selected_authority_contract",
    "run_constitution_graph",
  ],
  assumption: [
    "statement_normalisation",
    "forecast_behavior_map",
    "model_demand_graph",
    "forecast_plan",
    "selected_authority_contract",
    "run_constitution_graph",
  ],
  transaction_input: [
    "answered_case_recompile",
    "intake_replay",
    "statement_normalisation",
    "forecast_behavior_map",
    "model_demand_graph",
    "forecast_plan",
    "selected_authority_contract",
    "run_constitution_graph",
  ],
  formatting: [],
  delivery_wording: [],
});
for (const [change, expected] of Object.entries(EXPECTED_INVALIDATED)) {
  const measured = invalidatedNodesForChange(change);
  check(
    JSON.stringify(measured) === JSON.stringify(expected),
    `${change} does not invalidate exactly the expected nodes: ${JSON.stringify(measured)} != ${JSON.stringify(expected)}`,
  );
  const surplus = measured.filter((id) => !expected.includes(id));
  check(surplus.length === 0, `${change} invalidates nodes it should not: ${surplus.join(", ")}`);
}
// A dependent may never survive its dependency falling.
for (const node of EVIDENCE_WORK_NODES) {
  for (const change of Object.keys(CHANGE_KEY_COMPONENTS)) {
    const fallen = new Set(invalidatedNodesForChange(change));
    if (node.depends_on.some((dependency) => fallen.has(dependency))) {
      check(
        fallen.has(node.id),
        `${change} invalidates a dependency of ${node.id} but leaves ${node.id} standing`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// PART C — THE ERROR CLASSIFICATION TABLE, BOUND TO THE REGISTRY.
// ---------------------------------------------------------------------------
const registry = await readJson(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"));
const tableViolations = validateErrorClassificationTable(registry, {
  changeInvalidationStage: (change) => earliestInvalidatedStage(change)?.id ?? null,
});
check(
  tableViolations.length === 0,
  `the error classification table is not bound to the terminal-reason registry: ${tableViolations.join("; ")}`,
);
const REQUIRED_CLASSES = [
  "transient",
  "timeout",
  "malformed",
  "conflict",
  "parser",
  "schema",
  "policy",
  "version",
  "assumption",
];
for (const id of REQUIRED_CLASSES) {
  const entry = ERROR_CLASSES.find((candidate) => candidate.id === id);
  check(entry !== undefined, `the classification table declares no ${id} class`);
  if (!entry) continue;
  check(Number.isInteger(entry.retry_count) && entry.retry_count >= 0, `${id} declares no retry count`);
  check(["permitted", "refused"].includes(entry.cache_reuse), `${id} declares no cache reuse rule`);
  check(typeof entry.reason_code === "string" && entry.reason_code.length > 0, `${id} names no reason code`);
  check(typeof entry.terminal_state === "string" && entry.terminal_state.length > 0, `${id} names no terminal state`);
  check(
    Object.hasOwn(registry.reason_codes, entry.reason_code),
    `${id} invents a reason code the registry does not declare: ${entry.reason_code}`,
  );
  check(
    (registry.reason_codes[entry.reason_code].allowed_terminal_states ?? []).includes(entry.terminal_state),
    `${id} maps to a terminal state the registry forbids for ${entry.reason_code}`,
  );
}
check(
  ERROR_CLASSES.length === REQUIRED_CLASSES.length,
  `the classification table declares an undeclared class: ${ERROR_CLASSES.map((entry) => entry.id).join(", ")}`,
);
// Every class must produce a computable downstream invalidation scope, and the
// scope must be the one the corrected map measures — the table may not restate
// invalidation in its own words.
const table = errorClassificationTable({
  changeInvalidationStage: (change) => earliestInvalidatedStage(change)?.id ?? null,
});
for (const row of table) {
  check(
    typeof row.downstream_invalidation_scope === "string" && row.downstream_invalidation_scope.length > 0,
    `${row.class} has no downstream invalidation scope`,
  );
  const entry = ERROR_CLASSES.find((candidate) => candidate.id === row.class);
  check(
    row.downstream_invalidation_scope === measuredEarliestInvalidatedStage(entry.invalidation_change).id,
    `${row.class} states an invalidation scope the graph does not measure: ${row.downstream_invalidation_scope}`,
  );
}
// The registry's own misclassification firewall: an internal category may never
// terminate in a user-owned terminal state.
for (const entry of ERROR_CLASSES) {
  const category = registry.reason_codes[entry.reason_code]?.category;
  const lawful = registry.category_to_user_owned_terminals?.[category] ?? [];
  check(
    lawful.includes(entry.terminal_state),
    `${entry.id} breaks the registry firewall: ${category} may not terminate in ${entry.terminal_state}`,
  );
}
// A table that named a state the registry forbids must be REFUSED, not warned
// about. Mutation, run against the real validator.
const forbidden = validateErrorClassificationTable(
  { ...registry, reason_codes: { ...registry.reason_codes, "USER.material_economic_choice": { ...registry.reason_codes["USER.material_economic_choice"], allowed_terminal_states: ["INTERNAL_FAILURE"] } } },
  {},
);
check(
  forbidden.length > 0,
  "the table validator accepted a class whose terminal state the registry does not allow",
);

// ---------------------------------------------------------------------------
// PART D — AN UNCLASSIFIED ERROR IS REFUSED.
// ---------------------------------------------------------------------------
check(classifyError(Object.assign(new Error("x"), { error_class: "timeout" }))?.id === "timeout", "an explicitly marked error was not classified");
check(classifyError(Object.assign(new Error("x"), { code: "ECONNRESET" }))?.id === "transient", "a reset connection was not classified transient");
check(classifyError(new Error("the stage timed out after 30s"))?.id === "timeout", "a timeout message was not classified");
check(classifyError(new Error("the pack is not valid JSON"))?.id === "malformed", "an unparseable pack was not classified malformed");
check(classifyError(Object.assign(new Error("x"), { code: "EEXIST" }))?.id === "conflict", "a contended artifact was not classified conflict");
check(classifyError(new Error("receipt schema user-stage-receipt/1.0 is superseded"))?.id === "schema", "a superseded schema was not classified");
check(
  classifyError(new Error("something nobody has ever looked at happened")) === null,
  "an unrecognised error was silently given a class",
);
check(
  classifyError(Object.assign(new Error("x"), { error_class: "not_a_declared_class" })) === null,
  "an invented class marker was accepted",
);
let refusedUnclassified = false;
let refusalNamesRepair = false;
try {
  assertClassifiedError(new Error("something nobody has ever looked at happened"), "evidence_validation");
} catch (error) {
  refusedUnclassified = true;
  refusalNamesRepair = /repair:/.test(error.message) && /evidence_validation/.test(error.message);
}
check(refusedUnclassified, "an unclassified error was admitted to the retry and terminal machinery");
check(refusalNamesRepair, "the unclassified-error refusal names neither the site nor the repair");

// The refusal in the LEDGER: recorded, never retried, and rethrown UNCHANGED.
const ledgerDir = path.join(workspace, "ledger-unclassified");
const unclassifiedLedger = createAttemptLedger({
  runDir: ledgerDir,
  runId: "run-unclassified",
  controllerVersion: "six-milestone/3.0",
});
const opaque = new Error("an entirely opaque failure");
let ledgerRethrew = null;
try {
  await unclassifiedLedger.attempt("opaque_work", { inputDigest: "a".repeat(64), action: () => { throw opaque; } });
} catch (error) {
  ledgerRethrew = error;
}
check(ledgerRethrew === opaque, "the ledger did not rethrow the unclassified error unchanged");
const unclassifiedRecords = unclassifiedLedger.records();
check(unclassifiedRecords.length === 1, `an unclassified failure was retried: ${unclassifiedRecords.length} attempts`);
check(
  unclassifiedRecords[0].refusal === "attempt.unclassified_error",
  `the unclassified failure was not refused: ${unclassifiedRecords[0].refusal}`,
);
check(unclassifiedRecords[0].error_class === null, "an unclassified failure was given a class anyway");
check(unclassifiedRecords[0].terminal_state === null, "an unclassified failure was mapped to a terminal outcome");
check(typeof unclassifiedRecords[0].repair === "string", "the refusal receipt names no repair");
for (const record of unclassifiedRecords) {
  check(
    record.refusal === null || ATTEMPT_REFUSALS.includes(record.refusal),
    `an attempt recorded a refusal outside the vocabulary: ${record.refusal}`,
  );
}
// A class the table forbids to retry is not retried, however many times it fails.
const strictLedger = createAttemptLedger({ runDir: path.join(workspace, "ledger-strict"), runId: "run-strict", controllerVersion: "six-milestone/3.0" });
let schemaAttempts = 0;
try {
  await strictLedger.attempt("schema_work", {
    inputDigest: "b".repeat(64),
    action: () => { schemaAttempts += 1; throw new Error("receipt schema user-stage-receipt/1.0 is superseded"); },
  });
} catch { /* refused, recorded, rethrown */ }
check(schemaAttempts === 1, `a zero-retry class was retried ${schemaAttempts} times`);
check(
  strictLedger.records()[0].refusal === "attempt.class_forbids_retry",
  `a zero-retry class was not refused a retry: ${strictLedger.records()[0].refusal}`,
);
check(
  strictLedger.records()[0].terminal_state === "INTERNAL_FAILURE",
  "a classified failure carried no registered terminal outcome",
);

// ---------------------------------------------------------------------------
// PART E — A RETRY IS IDEMPOTENT, IN THE EVIDENCE LANE (NOT THE BROKER LANE).
//
// Driven through the REAL createEvidenceWorkGraph with the REAL attempt ledger,
// so what is proved is the production path, not a model of it.
// ---------------------------------------------------------------------------
const RETRY_NODES = Object.freeze([
  Object.freeze({
    id: "flaky_compile",
    stage: "decisions",
    recipe: "flaky-compile/1.0",
    depends_on: Object.freeze([]),
    key_components: Object.freeze(["planning_case"]),
    outputs: Object.freeze(["compiled"]),
    invalidated_by: "a change in the planning case",
  }),
]);

async function driveRetryNode(label, { failures }) {
  const runDir = path.join(workspace, label);
  const ledger = createAttemptLedger({ runDir, runId: `run-${label}`, controllerVersion: "six-milestone/3.0" });
  const graph = createEvidenceWorkGraph({
    runDir,
    runId: `run-${label}`,
    controllerVersion: "six-milestone/3.0",
    runtimeDigest: "c".repeat(64),
    nodes: RETRY_NODES,
    attemptLedger: ledger,
  });
  let calls = 0;
  const result = await graph.runNode({
    id: "flaky_compile",
    recipe: "flaky-compile/1.0",
    inputs: { planning_case: "d".repeat(64) },
    outputs: {},
    action: () => {
      calls += 1;
      if (calls <= failures) {
        throw Object.assign(new Error("the compile lane is temporarily unavailable"), { error_class: "transient" });
      }
      // Deterministic in its inputs, which is what makes a retry lawful.
      return { compiled: true, members: [3, 1, 2].sort(), source: "d".repeat(64) };
    },
  });
  return { result, calls, ledger, runDir };
}

const control = await driveRetryNode("retry-control", { failures: 0 });
const retried = await driveRetryNode("retry-transient", { failures: 1 });
check(control.calls === 1, `the control run executed the node ${control.calls} times`);
check(retried.calls === 2, `the retried run did not retry exactly once: ${retried.calls} executions`);
check(
  retried.result.output_digest === control.result.output_digest,
  `the retry produced a different result from the run that never failed: ${retried.result.output_digest} != ${control.result.output_digest}`,
);
check(
  retried.result.receipt.input_digest === control.result.input_digest ||
    retried.result.receipt.input_digest === control.result.receipt.input_digest,
  "the retried node was keyed differently from the control node",
);
const retriedRecords = retried.ledger.records();
check(retriedRecords.length === 2, `the retry produced ${retriedRecords.length} attempt receipts, not two`);
check(retriedRecords[0].status === "failed" && retriedRecords[0].error_class === "transient", `the first attempt was not recorded as a transient failure: ${JSON.stringify(retriedRecords[0])}`);
check(retriedRecords[0].refusal === null, "a retryable transient failure was refused a retry");
check(retriedRecords[0].retries_remaining >= 1, "the transient failure recorded no remaining retry budget");
check(retriedRecords[1].status === "success" && retriedRecords[1].attempt === 2, "the second attempt was not recorded as the succeeding retry");
check(
  retriedRecords[0].input_digest === retriedRecords[1].input_digest,
  "the retry was not the same work: its input digest moved between attempts",
);
check(
  retriedRecords.every((record) => record.first_input_digest === retriedRecords[0].input_digest),
  "an attempt did not record the first attempt's input digest",
);
// EXACTLY ONE node receipt, and it is the receipt of the SUCCEEDING attempt: a
// retry must not leave a trail of half-sealed receipts behind it.
const retriedGraphDir = path.join(retried.runDir, "stages", EVIDENCE_WORK_GRAPH_DIR);
const retriedReceipt = await readJson(path.join(retriedGraphDir, "flaky_compile", "_receipt.json"));
check(retriedReceipt.status === "success", "the retried node sealed a non-success receipt");
check(
  retriedReceipt.output_digest === control.result.output_digest,
  "the retried node's receipt records an output the control run did not produce",
);
const retriedDecisions = await readJson(path.join(retriedGraphDir, EVIDENCE_WORK_DECISION_FILE));
check(
  retriedDecisions.decisions.filter((record) => record.node === "flaky_compile").length === 1,
  "a retry left more than one decision record for the same node",
);
// The retry budget is the CLASS's, and it is finite.
const exhausted = createAttemptLedger({ runDir: path.join(workspace, "retry-exhausted"), runId: "run-exhausted", controllerVersion: "six-milestone/3.0" });
let exhaustedCalls = 0;
try {
  await exhausted.attempt("always_transient", {
    inputDigest: "e".repeat(64),
    action: () => { exhaustedCalls += 1; throw Object.assign(new Error("temporarily unavailable"), { error_class: "transient" }); },
  });
} catch { /* budget exhausted, recorded, rethrown */ }
check(exhaustedCalls === 3, `the transient class did not stop at two retries: ${exhaustedCalls} executions`);
check(
  exhausted.records().at(-1).refusal === "attempt.retry_budget_exhausted",
  `an exhausted retry budget was not recorded as such: ${exhausted.records().at(-1).refusal}`,
);
// A retry whose INPUTS moved is not a retry. Refused.
const moved = createAttemptLedger({ runDir: path.join(workspace, "retry-moved"), runId: "run-moved", controllerVersion: "six-milestone/3.0" });
let movedRefused = false;
await moved.attempt("moving_work", { inputDigest: "1".repeat(64), action: () => ({ ok: true }) });
try {
  await moved.attempt("moving_work", { inputDigest: "2".repeat(64), action: () => ({ ok: true }) });
} catch (error) {
  movedRefused = /inputs moved/.test(error.message);
}
check(movedRefused, "a retry whose inputs moved was allowed to pass as the same work");
check(
  moved.records().some((record) => record.refusal === "attempt.retry_input_moved"),
  "a retry whose inputs moved was not recorded as a refusal",
);

// ---------------------------------------------------------------------------
// PART F — A REUSE CLAIM IS CHECKED, NOT ACCEPTED.
// ---------------------------------------------------------------------------
const skipped = [
  { node: "answered_case_recompile", stage: "decisions", executed: false, duration_ms: 0 },
  { node: "intake_replay", stage: "decisions", executed: false, duration_ms: 0 },
];
const enacted = reuseClaimLedger(skipped, ["decisions"]);
check(enacted.violations.length === 0, `a genuinely enacted reuse was reported dishonest: ${enacted.violations.join("; ")}`);
check(
  enacted.stages.find((entry) => entry.stage === "decisions").mode === "enacted",
  "a stage whose nodes were all skipped is not reported as enacted",
);
const verified = reuseClaimLedger(
  [{ node: "intake_plan", stage: "evidence_review", executed: true, output_agreed: true, reason: "hit.inputs_unchanged", duration_ms: 790 }],
  ["evidence_review"],
);
check(verified.violations.length === 0, "a recomputed node that reproduced its recorded output was reported dishonest");
check(
  verified.stages.find((entry) => entry.stage === "evidence_review").mode === "verified",
  "a stage that recomputed and agreed is not reported as verified",
);
check(
  verified.stages.find((entry) => entry.stage === "evidence_review").executed_ms === 790,
  "the work performed inside a claimed reuse is not counted",
);
// THE REFUSAL: a claim backed by a node whose output moved.
const dishonest = reuseClaimLedger(
  [{ node: "intake_plan", stage: "evidence_review", executed: true, output_agreed: false, reason: "invalid.output_digest_mismatch", duration_ms: 12 }],
  ["evidence_review"],
);
check(dishonest.violations.length === 1, `a claim backed by a moved output was accepted: ${JSON.stringify(dishonest.violations)}`);
check(
  /intake_plan/.test(dishonest.violations[0]) && /output moved/.test(dishonest.violations[0]),
  `the dishonest-claim violation does not name the node and the reason: ${dishonest.violations[0]}`,
);
// A node whose output MOVED while it missed is still a lie, because there was a
// recorded output for it to contradict.
const movedOnMiss = reuseClaimLedger(
  [{ node: "forecast_plan", stage: "decisions", executed: true, output_agreed: false, reason: "miss.input_component_moved", duration_ms: 4 }],
  ["decisions"],
);
check(movedOnMiss.violations.length === 1, "a claim backed by a node whose output moved was accepted");
// A node with NO prior recorded output cannot contradict the claim, so it is
// not refused — but it does not back it either, and the stage says so. The
// refusal is confined to what is provably false, which is why a first-ever node
// execution inside a still-valid stage receipt does not kill a production run.
const unverified = reuseClaimLedger(
  [{ node: "forecast_plan", stage: "decisions", executed: true, output_agreed: null, reason: "miss.no_prior_receipt", duration_ms: 4 }],
  ["decisions"],
);
check(unverified.violations.length === 0, "an uncheckable claim was refused as though it were a proven lie");
check(
  unverified.stages.find((entry) => entry.stage === "decisions").mode === "unverified",
  "a claim that could not be checked is reported as though it had been",
);
check(
  unverified.stages.find((entry) => entry.stage === "decisions").unrecorded.length === 1,
  "the node that could not back the claim is not named",
);
// The controller's own recorded degradation is neither reuse nor a lie.
const degraded = reuseClaimLedger(
  [{ node: "broker_preview", stage: "evidence_review", executed: true, output_agreed: null, reason: "invalid.node_threw", duration_ms: 1 }],
  ["evidence_review"],
);
check(degraded.violations.length === 0, "a recorded degradation was mistaken for a dishonest reuse claim");
check(
  degraded.stages.find((entry) => entry.stage === "evidence_review").degraded.includes("broker_preview"),
  "a recorded degradation is not reported as one",
);
// A stage-receipt reuse recorded for a stage the run did not claim is also a
// disagreement between the ledger and the claim, and is caught in that
// direction too.
const unclaimed = reuseClaimLedger(
  [{ node: "intake_plan", stage: "evidence_review", executed: false, duration_ms: 0 }],
  [],
);
check(unclaimed.violations.length === 1, "a stage-receipt reuse recorded outside any claim was accepted");

// ---------------------------------------------------------------------------
// PART G — END TO END: WARM EQUALS COLD.
//
// This is the whole safety argument for the hoist. Enacting reuse CHANGES what
// a warm run computes; the only thing that makes that lawful is that the run
// which skipped the work produces byte-for-byte what the run which did it
// produced.
// ---------------------------------------------------------------------------
const acquisitionEvidence = path.join(workspace, "acquisition-question-evidence-run.json");
await command("run_evidence_run_tests.mjs", [cases, "--emit-acquisition-question", acquisitionEvidence]);
const answers = path.join(workspace, "answers.json");
await fs.writeFile(answers, `${JSON.stringify({ answers: { acquisition_funding: "debt" } }, null, 2)}\n`);

const runDir = path.join(workspace, "answered-run");
const cold = JSON.parse(
  (await command("run_user_flow.mjs", [acquisitionEvidence, "--out", runDir, "--answers", answers, "--stop-after", "decisions", "--json"])).stdout,
);
check(cold.status === "PAUSED", `the cold answered run did not pause after decisions: ${cold.status}`);
check((cold.reused_stages ?? []).length === 0, `the cold run claimed reuse: ${JSON.stringify(cold.reused_stages)}`);

const DECISION_ARTIFACTS = [
  "model-case.json",
  "forecast-plan.json",
  "forecast-behavior-map.json",
  "model-demand-graph.json",
  "selected-authority-contract.json",
  "run-constitution-graph.json",
  "case-source.json",
  "case-compile-report.json",
];
const coldArtifacts = {};
for (const name of DECISION_ARTIFACTS) {
  coldArtifacts[name] = await fs.readFile(path.join(runDir, "stages", "decisions", name), "utf8");
}
const coldStage3 = await readJson(path.join(runDir, "stages", "decisions", "_receipt.json"));
const coldDecisions = await readJson(path.join(runDir, "stages", EVIDENCE_WORK_GRAPH_DIR, EVIDENCE_WORK_DECISION_FILE));
const coldByNode = new Map(coldDecisions.decisions.map((record) => [record.node, record]));
check(
  coldByNode.get("answered_case_recompile")?.executed === true &&
    coldByNode.get("intake_replay")?.executed === true,
  "the cold answered run did not execute the recompile and the replay, so the warm comparison proves nothing",
);

const warm = JSON.parse(
  (await command("run_user_flow.mjs", [acquisitionEvidence, "--out", runDir, "--answers", answers, "--stop-after", "decisions", "--json"])).stdout,
);
check(warm.status === "PAUSED", `the warm answered run did not pause after decisions: ${warm.status}`);
check(
  JSON.stringify(warm.reused_stages) === JSON.stringify(["inputs", "evidence_review", "decisions"]),
  `the warm answered run did not reuse all three evidence stages: ${JSON.stringify(warm.reused_stages)}`,
);

// WARM EQUALS COLD, byte for byte, on everything the decisions stage emits.
for (const name of DECISION_ARTIFACTS) {
  const warmBytes = await fs.readFile(path.join(runDir, "stages", "decisions", name), "utf8");
  check(
    warmBytes === coldArtifacts[name],
    `enacting reuse changed ${name}: cold ${hashValue(coldArtifacts[name]).slice(0, 12)} -> warm ${hashValue(warmBytes).slice(0, 12)}`,
  );
}
const warmStage3 = await readJson(path.join(runDir, "stages", "decisions", "_receipt.json"));
check(
  hashValue(warmStage3.detail) === hashValue(coldStage3.detail),
  "enacting reuse changed the decisions stage receipt's emitted detail",
);
check(
  hashValue(warmStage3.output_hashes) === hashValue(coldStage3.output_hashes),
  "enacting reuse changed the decisions stage's declared output hashes",
);
check(warm.run_id === cold.run_id, "the warm run is not the same run as the cold one");

// THE HOIST, MEASURED. The two nodes that used to re-execute inside a claimed
// reuse must now be SKIPPED, and the stage must report zero milliseconds of
// work inside the reuse it claimed.
const warmDecisions = await readJson(path.join(runDir, "stages", EVIDENCE_WORK_GRAPH_DIR, EVIDENCE_WORK_DECISION_FILE));
const warmByNode = new Map(warmDecisions.decisions.map((record) => [record.node, record]));
for (const id of ["answered_case_recompile", "intake_replay"]) {
  check(
    warmByNode.get(id)?.executed === false,
    `${id} still executes inside a stage the warm run reports as reused: ${JSON.stringify(warmByNode.get(id))}`,
  );
  check(
    warmByNode.get(id)?.reason === "hit.stage_receipt_reused",
    `${id} did not record the stage-level reuse it now performs: ${warmByNode.get(id)?.reason}`,
  );
}
const enactment = await readJson(path.join(runDir, "reuse-enactment.json"));
check(enactment.violations.length === 0, `the warm run claimed reuse it did not perform: ${enactment.violations.join("; ")}`);
const decisionsStage = enactment.stages.find((entry) => entry.stage === "decisions");
check(decisionsStage.mode === "enacted", `the decisions stage is still not enacted: ${decisionsStage.mode}`);
check(decisionsStage.executed_ms === 0, `the decisions stage still spends ${decisionsStage.executed_ms}ms inside a claimed reuse`);
check(decisionsStage.skipped.length === 8, `the decisions stage skipped ${decisionsStage.skipped.length} of its eight nodes`);
check(
  enactment.stages.find((entry) => entry.stage === "inputs").mode === "enacted",
  "the inputs stage is no longer enacted",
);
// evidence_review CANNOT be enacted, and the run says so rather than pretending
// otherwise: its own cache key includes the broker confirmation its own work
// produces, and the intake plan it hands downstream carries live option
// handlers that no persisted artifact can hold. It is therefore VERIFIED — the
// work re-runs and is proved to reproduce exactly what the receipt recorded.
const evidenceReviewStage = enactment.stages.find((entry) => entry.stage === "evidence_review");
check(evidenceReviewStage.mode === "verified", `the evidence_review claim is not backed by verification: ${evidenceReviewStage.mode}`);
check(
  evidenceReviewStage.verified.includes("intake_plan"),
  "the unconditional intake work is not verified against the output it claims to reuse",
);
check(
  evidenceReviewStage.executed_ms > 0,
  "the work performed inside the evidence_review reuse claim is recorded as zero",
);

// The attempt ledger is a production artifact, not a test fixture.
const attempts = await readJson(path.join(runDir, "stages", EVIDENCE_WORK_GRAPH_DIR, ATTEMPT_LEDGER_FILE));
check(attempts.schema_version === "work-attempt-receipt/1.0", "the attempt ledger declares no schema");
check(attempts.run_id === warm.run_id, "the attempt ledger does not identify its run");
check(attempts.attempts.length > 0, "the warm run recorded no attempt receipt at all");
for (const record of attempts.attempts) {
  check(typeof record.label === "string" && record.label.length > 0, "an attempt receipt carries no label");
  check(Number.isInteger(record.attempt) && record.attempt >= 1, "an attempt receipt carries no attempt number");
  check(["success", "failed"].includes(record.status), `an attempt receipt carries no status: ${record.status}`);
  check(
    record.refusal === null || ATTEMPT_REFUSALS.includes(record.refusal),
    `an attempt receipt names a refusal outside the vocabulary: ${record.refusal}`,
  );
}
// The controller's own broker-preview throw is a REAL unclassified error, and
// the table refuses it rather than absorbing it. That refusal is a finding, not
// a test fixture: it is a production throw nobody has typed.
check(
  attempts.attempts.some(
    (record) => record.label === "evidence_work_node/broker_preview" && record.refusal === "attempt.unclassified_error",
  ),
  "the controller's untyped broker-preview throw is no longer refused by the classification table",
);
const classification = await readJson(path.join(runDir, "error-classification.json"));
check(classification.classes.length === 9, `the run published ${classification.classes.length} error classes, not nine`);
for (const row of classification.classes) {
  check(
    typeof row.downstream_invalidation_scope === "string",
    `${row.class} was published without a downstream invalidation scope`,
  );
}

// ---------------------------------------------------------------------------
// PART H — END TO END: A CHANGE INVALIDATES EXACTLY WHAT IT SHOULD.
//
// One answer moves. The historical literal said this invalidates back to
// `build_checks`; the graph says it invalidates the eight decisions nodes and
// nothing above them. The real controller settles it.
// ---------------------------------------------------------------------------
const changedAnswers = path.join(workspace, "changed-answers.json");
await fs.writeFile(changedAnswers, `${JSON.stringify({ answers: { acquisition_funding: "equity" } }, null, 2)}\n`);
const changed = JSON.parse(
  (await command("run_user_flow.mjs", [acquisitionEvidence, "--out", runDir, "--answers", changedAnswers, "--stop-after", "decisions", "--json"])).stdout,
);
check(changed.status === "PAUSED", `the changed-answer run did not pause after decisions: ${changed.status}`);
check(
  JSON.stringify(changed.reused_stages) === JSON.stringify(["inputs", "evidence_review"]),
  `a changed answer did not invalidate exactly the decisions stage: ${JSON.stringify(changed.reused_stages)}`,
);
const changedDecisions = await readJson(path.join(runDir, "stages", EVIDENCE_WORK_GRAPH_DIR, EVIDENCE_WORK_DECISION_FILE));
const missedNodes = changedDecisions.decisions
  .filter((record) => record.decision === "MISS")
  .map((record) => record.node)
  .sort();
const expectedMissed = [...invalidatedNodesForChange("user_answer")].sort();
check(
  JSON.stringify(missedNodes) === JSON.stringify(expectedMissed),
  `a changed answer did not invalidate exactly the predicted nodes: ${JSON.stringify(missedNodes)} != ${JSON.stringify(expectedMissed)}`,
);
for (const record of changedDecisions.decisions) {
  if (expectedMissed.includes(record.node)) continue;
  check(
    record.decision !== "MISS",
    `${record.node} was invalidated by a changed answer but the graph does not predict it`,
  );
}
check(
  changedDecisions.decisions.find((record) => record.node === "answered_case_recompile")?.moved?.some((entry) => entry.startsWith("files.answered_case_source:")),
  "the answered-case recompile miss does not name the component that moved",
);
// The corrected map is what the controller's behaviour matches — the historical
// value would have permitted the decisions stage to be reused.
check(
  CHANGE_INVALIDATION.user_answer === "decisions" &&
    SUPERSEDED_CHANGE_INVALIDATION.user_answer === "build_checks",
  "the corrected invalidation entry for a changed answer is not pinned against the historical one",
);
const changedEnactment = await readJson(path.join(runDir, "reuse-enactment.json"));
check(changedEnactment.violations.length === 0, `the changed-answer run claimed reuse it did not perform: ${changedEnactment.violations.join("; ")}`);
check(
  changedEnactment.stages.find((entry) => entry.stage === "decisions").mode === "not_claimed",
  "the invalidated decisions stage was still reported as reused",
);

await fs.rm(workspace, { recursive: true, force: true });

if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`  FAIL  ${violation}\n`);
  process.stdout.write(`${JSON.stringify({ status: "FAIL", checks, violations: violations.length })}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
