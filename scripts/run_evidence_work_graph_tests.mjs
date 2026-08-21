#!/usr/bin/env node
/**
 * P6.3 — THE EVIDENCE-HALF WORK DAG, AND THE REASON EVERY CACHE DECISION HAS.
 *
 * Invariant under test: expensive work in the EVIDENCE half is a declared graph
 * of nodes, each with declared inputs, outputs, a cache key and an invalidation
 * rule — and every cache decision records its REASON (hit, miss with the
 * component that moved, or invalid with why), rather than being observable only
 * as elapsed time.
 *
 * The reds this suite pins, all measured before the repair:
 *
 *  RED 1  There was NO work DAG over the evidence half. The only real
 *         cache-keyed work graph in the repository was stage 4's `checkpoint()`
 *         (scripts/orchestrate_release.mjs:626-703). Stages 1-3 ran
 *         `validateEvidenceRun`, `compileBrokerPreview`, `compileCase`,
 *         `runIntake`, `compileForecastBehaviorMap`, `compileModelDemandGraph`,
 *         `compileForecastPlan`, `compileSelectedAuthorityContract` and
 *         `compileRunConstitutionGraph` as ONE indivisible block per stage
 *         behind ONE stage receipt, with no node identity, no per-node cache key
 *         and no per-node invalidation rule. The decisions stage was the worst:
 *         a single receipt covered seven distinct compilations.
 *  RED 2  Hit/miss/invalid REASONS were never recorded. P6.2 gave the STAGE a
 *         miss record (`stages/<id>/_miss.json`) — this package does not redo
 *         that — but a HIT recorded nothing at all, an INVALID receipt recorded
 *         nothing distinguishable from a miss, and no node below stage
 *         granularity recorded anything. Whether the intake replay was reused
 *         or recomputed was observable ONLY as elapsed time.
 *  RED 3  Documentation drift. SKILL.md, central-instructions.md and
 *         references/runtime-core.md all said the Build milestone has
 *         "thirteen silent leaf checkpoints" and enumerated thirteen. The real
 *         count is FOURTEEN top-level checkpoints plus one render leaf per
 *         rendered sheet; `verify_ownership_physical` was missing from the
 *         enumeration entirely. Nothing checked the claim, which is how it
 *         drifted. Part D of this suite is that check.
 *
 * What this suite deliberately does NOT re-prove: P6.2's stage recipe, the
 * derived stage closure and the stage-level `_miss.json` are covered by
 * `run_stage_recipe_tests.mjs`; stage 4's own resume behaviour is covered by
 * `run_stage4_checkpoint_tests.mjs` (`stage4-content-addressed-resume`).
 * Stage 4 is READ here — its `checkpoint()` is the shape the evidence graph
 * reuses — and never edited.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  EVIDENCE_WORK_DECISION_FILE,
  EVIDENCE_WORK_GRAPH_DIR,
  EVIDENCE_WORK_NODES,
  EVIDENCE_WORK_NODE_SCHEMA,
  EVIDENCE_WORK_REASONS,
  SUPERSEDED_EVIDENCE_WORK_NODE_SCHEMAS,
  createEvidenceWorkGraph,
  documentedCheckpointClaimViolations,
  releaseCheckpointInventory,
  validateEvidenceWorkGraph,
} from "./lib/evidence_work_graph.mjs";
import { hashValue } from "./lib/run_store.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const cases = path.resolve(
  process.argv[2] ??
    process.env.DEBT_OVERLAY_CASES_DIR ??
    fileURLToPath(new URL("../test-fixtures/cases", import.meta.url)),
);

let checks = 0;
const failures = [];
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}
async function rejects(message, callback, pattern) {
  checks += 1;
  try {
    await callback();
    failures.push(`${message}: no refusal was raised`);
  } catch (error) {
    if (pattern && !pattern.test(String(error.message))) {
      failures.push(`${message}: refused with the wrong reason: ${error.message}`);
    }
  }
}

async function command(script, args, { allowFailure = false } = {}) {
  try {
    return await exec(process.execPath, [path.join(HERE, script), ...args], {
      cwd: ROOT,
      timeout: 900000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-work-graph-tests-"));

// ---------------------------------------------------------------------------
// PART A — the DECLARATION. A node without a cache key is not a node.
// ---------------------------------------------------------------------------
const EVIDENCE_HALF_STAGES = new Set(["inputs", "evidence_review", "decisions"]);

check(EVIDENCE_WORK_NODES.length >= 12, `the evidence work graph declares too few nodes: ${EVIDENCE_WORK_NODES.length}`);

const declaredIds = EVIDENCE_WORK_NODES.map((node) => node.id);
check(new Set(declaredIds).size === declaredIds.length, "the evidence work graph declares a duplicate node id");

const seen = new Set();
for (const node of EVIDENCE_WORK_NODES) {
  check(
    typeof node.id === "string" && /^[a-z][a-z0-9_]*$/.test(node.id),
    `node id is not a stable identifier: ${node.id}`,
  );
  check(
    EVIDENCE_HALF_STAGES.has(node.stage),
    `node ${node.id} is not declared against an evidence-half stage: ${node.stage}`,
  );
  check(
    typeof node.recipe === "string" && /\/\d+\.\d+$/.test(node.recipe),
    `node ${node.id} has no versioned recipe: ${node.recipe}`,
  );
  check(
    Array.isArray(node.key_components) && node.key_components.length > 0,
    `node ${node.id} declares no cache key`,
  );
  check(
    Array.isArray(node.outputs) && node.outputs.length > 0,
    `node ${node.id} declares no outputs`,
  );
  check(
    typeof node.invalidated_by === "string" && node.invalidated_by.length > 20,
    `node ${node.id} declares no invalidation rule`,
  );
  check(
    Array.isArray(node.depends_on) && node.depends_on.every((dep) => seen.has(dep)),
    `node ${node.id} depends on a node that is not declared before it: ${JSON.stringify(node.depends_on)}`,
  );
  seen.add(node.id);
}

// The declaration is topologically ordered, so it is acyclic by construction.
// Prove the graph is CONNECTED to the evidence half's real shape: at least one
// node per evidence-half stage, and the seven decisions-stage compilations that
// P3.7 left behind ONE indivisible receipt are seven distinct nodes.
for (const stage of EVIDENCE_HALF_STAGES) {
  check(
    EVIDENCE_WORK_NODES.some((node) => node.stage === stage),
    `no evidence work node is declared for stage ${stage}`,
  );
}
const decisionNodes = EVIDENCE_WORK_NODES.filter((node) => node.stage === "decisions");
check(
  decisionNodes.length >= 7,
  `the decisions stage still collapses its compilations into ${decisionNodes.length} node(s); P3.7 named seven`,
);
for (const required of [
  "answered_case_recompile",
  "intake_replay",
  "statement_normalisation",
  "forecast_behavior_map",
  "model_demand_graph",
  "forecast_plan",
  "selected_authority_contract",
  "run_constitution_graph",
]) {
  check(
    declaredIds.includes(required),
    `the decisions-stage compilation ${required} is not a declared work node`,
  );
}

check(validateEvidenceWorkGraph(EVIDENCE_WORK_NODES).length === 0, "the shipped declaration does not validate");

// MUTATION — a node with no declared cache key must be REFUSED by the validator.
const keylessDeclaration = EVIDENCE_WORK_NODES.map((node) =>
  node.id === "forecast_plan" ? { ...node, key_components: [] } : node,
);
const keylessViolations = validateEvidenceWorkGraph(keylessDeclaration);
check(
  keylessViolations.some((violation) => /forecast_plan/.test(violation) && /cache key/i.test(violation)),
  `a node with no declared cache key was admitted: ${JSON.stringify(keylessViolations)}`,
);

// MUTATION — a node that depends on itself, or on an undeclared node, is refused.
check(
  validateEvidenceWorkGraph(
    EVIDENCE_WORK_NODES.map((node) =>
      node.id === "forecast_plan" ? { ...node, depends_on: ["forecast_plan"] } : node,
    ),
  ).length > 0,
  "a self-dependent node was admitted",
);
check(
  validateEvidenceWorkGraph(
    EVIDENCE_WORK_NODES.map((node) =>
      node.id === "forecast_plan" ? { ...node, depends_on: ["no_such_node"] } : node,
    ),
  ).length > 0,
  "a node depending on an undeclared node was admitted",
);
// MUTATION — a node with no invalidation rule is refused.
check(
  validateEvidenceWorkGraph(
    EVIDENCE_WORK_NODES.map((node) =>
      node.id === "forecast_plan" ? { ...node, invalidated_by: "" } : node,
    ),
  ).length > 0,
  "a node with no invalidation rule was admitted",
);

// The reason vocabulary is CLOSED and every listed reason has a producer.
const graphSource = await fs.readFile(path.join(ROOT, "scripts", "lib", "evidence_work_graph.mjs"), "utf8");
check(EVIDENCE_WORK_REASONS.length >= 12, `the reason vocabulary is too small: ${EVIDENCE_WORK_REASONS.length}`);
for (const reason of EVIDENCE_WORK_REASONS) {
  check(
    /^(hit|miss|invalid)\.[a-z_]+$/.test(reason),
    `reason ${reason} is not categorised as hit/miss/invalid`,
  );
  check(
    graphSource.split(`"${reason}"`).length - 1 >= 2,
    `reason ${reason} is declared but has no producer in the module`,
  );
}
for (const category of ["hit", "miss", "invalid"]) {
  check(
    EVIDENCE_WORK_REASONS.some((reason) => reason.startsWith(`${category}.`)),
    `the reason vocabulary records no ${category} reason`,
  );
}

// ---------------------------------------------------------------------------
// PART B — the GRAPH. Every decision, and the reason it carries.
// ---------------------------------------------------------------------------
const RUN_ID = "20260820T000000Z-p63-unit";
const CLOSURE = "closure-digest-aaaa";

async function openGraph(runDir, { runId = RUN_ID, runtimeDigest = CLOSURE } = {}) {
  return createEvidenceWorkGraph({
    runDir,
    runId,
    controllerVersion: "test-controller/1.0",
    runtimeDigest,
  });
}

const unitRun = path.join(workspace, "unit-run");
await fs.mkdir(unitRun, { recursive: true });

function decisionFor(graph, id) {
  return graph.decisions().find((entry) => entry.node === id) ?? null;
}

// Three nodes drawn from the real declaration, along a real declared edge:
// `forecast_plan` depends on `forecast_behavior_map`, so a change confined to
// the behaviour map's own input must reach the plan as a DEPENDENCY move and
// nothing else. `forecast_plan`'s own key components are held constant, so the
// two miss reasons cannot be confused.
async function driveTwoNodes(graph, { evidenceHash, behaviorParam = "b0" }) {
  const validation = await graph.runNode({
    id: "evidence_validation",
    recipe: nodeById("evidence_validation").recipe,
    inputs: { evidence_run: evidenceHash },
    outputs: { evidence_validation: null },
    action: () => ({ ok: true, from: evidenceHash }),
  });
  const behavior = await graph.runNode({
    id: "forecast_behavior_map",
    recipe: nodeById("forecast_behavior_map").recipe,
    inputs: { planning_case: hashValue({ behaviorParam }) },
    outputs: { forecast_behavior_map: null },
    action: () => ({ map: behaviorParam }),
  });
  const plan = await graph.runNode({
    id: "forecast_plan",
    recipe: nodeById("forecast_plan").recipe,
    inputs: {
      planning_case: "a-constant-planning-case",
      observation_ledger: "none",
      source_inventory: "none",
    },
    outputs: { forecast_plan: null },
    action: () => ({ status: "PASS" }),
  });
  return { validation, behavior, plan };
}

function nodeById(id) {
  return EVIDENCE_WORK_NODES.find((node) => node.id === id);
}

// COLD — every node misses because nothing was recorded.
let graph = await openGraph(unitRun);
let driven = await driveTwoNodes(graph, { evidenceHash: "evidence-aaaa" });
await graph.close();
check(driven.plan.decision === "MISS", `a cold downstream node did not MISS: ${driven.plan.decision}`);
check(driven.validation.decision === "MISS", `a cold node did not MISS: ${driven.validation.decision}`);
check(
  driven.validation.reason === "miss.no_prior_receipt",
  `a cold miss did not name the absent receipt: ${driven.validation.reason}`,
);
check(driven.validation.reused === false, "a cold node reported itself reused");

// WARM, UNCHANGED — the node must HIT, and say why.
graph = await openGraph(unitRun);
driven = await driveTwoNodes(graph, { evidenceHash: "evidence-aaaa" });
await graph.close();
check(driven.validation.decision === "HIT", `an unchanged node did not HIT: ${driven.validation.decision} / ${driven.validation.reason}`);
check(
  driven.validation.reason === "hit.inputs_unchanged",
  `an unchanged node's hit carries no reason: ${driven.validation.reason}`,
);
check(driven.plan.decision === "HIT", `an unchanged downstream node did not HIT: ${driven.plan.decision}`);

// CHANGED INPUT — the node must MISS, and NAME the component that moved. The
// change is confined to the evidence node and to the behaviour map, so the plan
// may only miss on its dependency.
graph = await openGraph(unitRun);
driven = await driveTwoNodes(graph, { evidenceHash: "evidence-bbbb", behaviorParam: "b1" });
await graph.close();
check(driven.validation.decision === "MISS", "a node whose input moved did not MISS");
check(
  driven.validation.reason === "miss.input_component_moved",
  `a changed-input miss is not categorised: ${driven.validation.reason}`,
);
check(
  driven.validation.moved.some((entry) => entry.startsWith("files.evidence_run:")),
  `the miss does not name the component that moved: ${JSON.stringify(driven.validation.moved)}`,
);
check(
  driven.validation.moved.some((entry) => entry.includes("evidence-aaaa".slice(0, 12))),
  `the miss does not carry the prior value of the moved component: ${JSON.stringify(driven.validation.moved)}`,
);
// The downstream node's OWN inputs did not move — only its dependency's output
// did. It must miss for that reason and no other.
check(
  driven.plan.decision === "MISS" && driven.plan.reason === "miss.dependency_output_moved",
  `a downstream node did not miss on its dependency: ${driven.plan.decision} / ${driven.plan.reason}`,
);
check(
  driven.plan.moved.every((entry) => entry.startsWith("deps.")) &&
    driven.plan.moved.some((entry) => entry.startsWith("deps.forecast_behavior_map:")),
  `the downstream miss does not name the dependency that moved: ${JSON.stringify(driven.plan.moved)}`,
);
check(
  driven.behavior.decision === "MISS" &&
    driven.behavior.moved.some((entry) => entry.startsWith("files.planning_case:")),
  `the behaviour map did not miss on its own component: ${JSON.stringify(driven.behavior)}`,
);

// CHANGED RECIPE — bumping a node's declared recipe version invalidates the
// receipts written under the old one, with its own reason.
graph = await openGraph(unitRun);
await driveTwoNodes(graph, { evidenceHash: "evidence-bbbb", behaviorParam: "b1" });
await graph.close();
const bumped = await createEvidenceWorkGraph({
  runDir: unitRun,
  runId: RUN_ID,
  controllerVersion: "test-controller/1.0",
  runtimeDigest: CLOSURE,
  nodes: EVIDENCE_WORK_NODES.map((node) =>
    node.id === "evidence_validation" ? { ...node, recipe: "evidence-validation/2.0" } : node,
  ),
});
const recipeChanged = await bumped.runNode({
  id: "evidence_validation",
  recipe: "evidence-validation/2.0",
  inputs: { evidence_run: "evidence-bbbb" },
  outputs: { evidence_validation: null },
  action: () => ({ ok: true, from: "evidence-bbbb" }),
});
await bumped.close();
check(
  recipeChanged.decision === "MISS" && recipeChanged.reason === "miss.recipe_changed",
  `a recipe change is not reported as its own miss: ${recipeChanged.decision} / ${recipeChanged.reason}`,
);
check(
  recipeChanged.moved.some((entry) => entry.startsWith("recipe:")),
  `the recipe miss does not name the recipe: ${JSON.stringify(recipeChanged.moved)}`,
);

// Re-establish a clean warm baseline for the INVALID mutations.
async function warmBaseline() {
  const graphA = await openGraph(unitRun);
  await driveTwoNodes(graphA, { evidenceHash: "evidence-aaaa" });
  await graphA.close();
}
const receiptPath = path.join(unitRun, "stages", EVIDENCE_WORK_GRAPH_DIR, "evidence_validation", "_receipt.json");

async function mutateReceipt(mutate) {
  await warmBaseline();
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const mutated = mutate(receipt);
  await fs.writeFile(receiptPath, typeof mutated === "string" ? mutated : `${JSON.stringify(mutated, null, 2)}\n`, "utf8");
  const graphB = await openGraph(unitRun);
  const result = await driveTwoNodes(graphB, { evidenceHash: "evidence-aaaa" });
  await graphB.close();
  return result.validation;
}

for (const [label, mutate, expected] of [
  ["a receipt from a foreign run", (receipt) => ({ ...receipt, run_id: "20260101T000000Z-other" }), "invalid.receipt_foreign_run"],
  ["a receipt whose status is not success", (receipt) => ({ ...receipt, status: "blocked" }), "invalid.receipt_not_success"],
  ["an unreadable receipt", () => "{ this is not json", "invalid.receipt_unreadable"],
  [
    "a receipt on a superseded schema",
    (receipt) => ({ ...receipt, schema_version: SUPERSEDED_EVIDENCE_WORK_NODE_SCHEMAS[0] ?? "evidence-work-node/0.9" }),
    "invalid.receipt_schema_superseded",
  ],
  [
    "a receipt whose body was tampered with",
    (receipt) => ({ ...receipt, input_digest: "0".repeat(64) }),
    "invalid.receipt_tampered",
  ],
]) {
  const decision = await mutateReceipt(mutate);
  check(
    decision.decision === "INVALID" && decision.reason === expected,
    `${label} was not recorded as ${expected}: ${decision.decision} / ${decision.reason}`,
  );
}

// A DISHONEST cache key: the node HITs, but re-executing produces a different
// output. The graph RECORDS the violation; it never repairs it and never
// changes the run's outcome.
await warmBaseline();
graph = await openGraph(unitRun);
const dishonest = await graph.runNode({
  id: "evidence_validation",
  recipe: nodeById("evidence_validation").recipe,
  inputs: { evidence_run: "evidence-aaaa" },
  outputs: { evidence_validation: null },
  action: () => ({ ok: true, from: "evidence-aaaa", nondeterministic: Math.random() }),
});
await graph.close();
check(
  dishonest.decision === "INVALID" && dishonest.reason === "invalid.output_digest_mismatch",
  `a cache key that agreed while the output moved was not recorded: ${dishonest.decision} / ${dishonest.reason}`,
);
check(
  dishonest.value !== null && dishonest.value !== undefined,
  "the honesty check discarded the freshly computed value",
);

// A node that throws is RECORDED and then RETHROWN — the graph never converts a
// failure into a cache decision, and never changes what the run does.
await fs.rm(path.join(unitRun, "stages", EVIDENCE_WORK_GRAPH_DIR), { recursive: true, force: true });
graph = await openGraph(unitRun);
await rejects(
  "a throwing node must rethrow",
  async () =>
    graph.runNode({
      id: "evidence_validation",
      recipe: nodeById("evidence_validation").recipe,
      inputs: { evidence_run: "evidence-aaaa" },
      outputs: { evidence_validation: null },
      action: () => {
        throw new Error("deliberate node failure");
      },
    }),
  /deliberate node failure/,
);
check(
  decisionFor(graph, "evidence_validation")?.reason === "invalid.node_threw",
  `a throwing node recorded no reason: ${JSON.stringify(decisionFor(graph, "evidence_validation"))}`,
);
await graph.close();

// REFUSALS — the three ways a call site can fail to declare a cache key.
await fs.rm(path.join(unitRun, "stages", EVIDENCE_WORK_GRAPH_DIR), { recursive: true, force: true });
graph = await openGraph(unitRun);
await rejects(
  "an undeclared node id must be refused",
  async () =>
    graph.runNode({
      id: "not_a_declared_node",
      recipe: "whatever/1.0",
      inputs: { x: "y" },
      outputs: { z: null },
      action: () => 1,
    }),
  /not a declared evidence work node/i,
);
await rejects(
  "a node whose call site omits a declared cache-key component must be refused",
  async () =>
    graph.runNode({
      id: "forecast_plan",
      recipe: nodeById("forecast_plan").recipe,
      inputs: {},
      outputs: { forecast_plan: null },
      action: () => 1,
    }),
  /planning_case/,
);
await rejects(
  "a node whose call site contradicts the declared recipe must be refused",
  async () =>
    graph.runNode({
      id: "forecast_plan",
      recipe: "some-other-recipe/1.0",
      inputs: { planning_case: "a", observation_ledger: "b", source_inventory: "c" },
      outputs: { forecast_plan: null },
      action: () => 1,
    }),
  /recipe/i,
);
await rejects(
  "a node whose call site invents an output name must be refused",
  async () =>
    graph.runNode({
      id: "forecast_plan",
      recipe: nodeById("forecast_plan").recipe,
      inputs: { planning_case: "a", observation_ledger: "b", source_inventory: "c" },
      outputs: { not_declared: null },
      action: () => 1,
    }),
  /output/i,
);
await graph.close();

// reuseStage records the stage-level hit for nodes that did NOT execute, and
// never overwrites a decision a node already recorded for itself.
await fs.rm(path.join(unitRun, "stages", EVIDENCE_WORK_GRAPH_DIR), { recursive: true, force: true });
graph = await openGraph(unitRun);
await graph.runNode({
  id: "evidence_validation",
  recipe: nodeById("evidence_validation").recipe,
  inputs: { evidence_run: "evidence-aaaa" },
  outputs: { evidence_validation: null },
  action: () => ({ ok: true }),
});
await graph.reuseStage("inputs");
await graph.reuseStage("decisions");
await graph.close();
check(
  decisionFor(graph, "evidence_validation")?.reason === "miss.no_prior_receipt",
  "reuseStage overwrote a decision the node had already recorded for itself",
);
check(
  decisionFor(graph, "forecast_plan")?.decision === "HIT" &&
    decisionFor(graph, "forecast_plan")?.reason === "hit.stage_receipt_reused",
  `reuseStage did not record the stage-level hit: ${JSON.stringify(decisionFor(graph, "forecast_plan"))}`,
);

// The decision log is PERSISTED, and every record is complete.
const decisionLog = JSON.parse(
  await fs.readFile(path.join(unitRun, "stages", EVIDENCE_WORK_GRAPH_DIR, EVIDENCE_WORK_DECISION_FILE), "utf8"),
);
check(decisionLog.schema_version === EVIDENCE_WORK_NODE_SCHEMA, "the decision log declares no schema");
check(decisionLog.run_id === RUN_ID, "the decision log does not identify its run");
check(Array.isArray(decisionLog.decisions) && decisionLog.decisions.length > 0, "the decision log is empty");
for (const record of decisionLog.decisions) {
  check(
    ["HIT", "MISS", "INVALID"].includes(record.decision),
    `a decision record carries no decision: ${JSON.stringify(record)}`,
  );
  check(
    EVIDENCE_WORK_REASONS.includes(record.reason),
    `a decision record carries a reason outside the vocabulary: ${record.reason}`,
  );
  check(typeof record.node === "string" && declaredIds.includes(record.node), `a decision names an undeclared node: ${record.node}`);
  check(Array.isArray(record.moved), `a decision record has no moved list: ${JSON.stringify(record)}`);
  check(typeof record.stage === "string", `a decision record names no stage: ${JSON.stringify(record)}`);
}
check(
  decisionLog.summary && typeof decisionLog.summary.hit === "number" &&
    typeof decisionLog.summary.miss === "number" && typeof decisionLog.summary.invalid === "number",
  "the decision log carries no hit/miss/invalid summary",
);

// The graph must NOT enact reuse in this release: a work DAG that skips work
// changes what is computed, which is out of scope for P6.3 and is P6.4's.
check(
  /enact:\s*false/.test(graphSource) || /ENACT_EVIDENCE_REUSE\s*=\s*false/.test(graphSource),
  "the evidence work graph does not declare that it does not enact reuse",
);

// ---------------------------------------------------------------------------
// PART C — the WIRING. Every declared node has a real call site, and the real
// controller records real decisions.
// ---------------------------------------------------------------------------
const controllerSource = await fs.readFile(path.join(ROOT, "scripts", "run_user_flow.mjs"), "utf8");
check(
  /createEvidenceWorkGraph/.test(controllerSource),
  "the controller does not open an evidence work graph",
);
const callSiteIds = [...controllerSource.matchAll(/runNode\(\{\s*\n\s*id:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
for (const id of declaredIds) {
  check(callSiteIds.includes(id), `declared work node ${id} has no call site in the controller`);
}
for (const id of new Set(callSiteIds)) {
  check(declaredIds.includes(id), `the controller runs an undeclared work node: ${id}`);
}
check(
  /graph\.reuseStage\(|workGraph\.reuseStage\(/.test(controllerSource),
  "the controller never records a stage-level reuse against the work graph",
);

// END TO END — the real controller, the real evidence, the real decisions.
const cleanEvidence = path.join(workspace, "clean-evidence-run.json");
await command("run_evidence_run_tests.mjs", [cases, "--emit-clean", cleanEvidence]);

const coldRun = path.join(workspace, "cold-run");
const cold = JSON.parse(
  (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", coldRun, "--stop-after", "decisions", "--json"])).stdout,
);
check(cold.status === "PAUSED", `the end-to-end cold run did not pause after decisions: ${cold.status}`);
check((cold.reused_stages ?? []).length === 0, `the cold run reused a stage: ${JSON.stringify(cold.reused_stages)}`);

const coldLogPath = path.join(coldRun, "stages", EVIDENCE_WORK_GRAPH_DIR, EVIDENCE_WORK_DECISION_FILE);
const coldLog = JSON.parse(await fs.readFile(coldLogPath, "utf8"));
check(coldLog.run_id === cold.run_id, "the work-graph decision log does not identify the real run");
const coldByNode = new Map(coldLog.decisions.map((record) => [record.node, record]));
for (const id of ["evidence_validation", "intake_plan", "forecast_plan", "run_constitution_graph"]) {
  check(coldByNode.has(id), `the cold run recorded no decision for ${id}`);
  check(
    coldByNode.get(id)?.decision === "MISS",
    `the cold run did not MISS ${id}: ${JSON.stringify(coldByNode.get(id))}`,
  );
}
// `invalid.node_threw` is not a cache defect: it is the controller's own
// pre-existing degradation path (the broker preview compiler throws on this
// fixture and the catch installs the forecast-waterfall fallback). The graph
// RECORDS that throw instead of hiding it; what a clean run may never record is
// a cache-integrity violation.
const CACHE_INTEGRITY_VIOLATIONS = (log) =>
  log.decisions.filter((record) => record.decision === "INVALID" && record.reason !== "invalid.node_threw");
check(
  CACHE_INTEGRITY_VIOLATIONS(coldLog).length === 0,
  `a clean cold run recorded a cache-integrity violation: ${JSON.stringify(CACHE_INTEGRITY_VIOLATIONS(coldLog))}`,
);
check(
  coldLog.decisions.some((record) => record.node === "broker_preview" && record.reason === "invalid.node_threw"),
  "the controller's silent broker-preview degradation is still not recorded by the work graph",
);
check(
  coldLog.summary.hit === 0 && coldLog.summary.miss > 0,
  `the cold run summary is not all-miss: ${JSON.stringify(coldLog.summary)}`,
);

// The cold run's own emitted numbers, for the additivity comparison below.
const coldCase = JSON.parse(await fs.readFile(path.join(coldRun, "stages", "decisions", "model-case.json"), "utf8"));
const coldStage3 = JSON.parse(await fs.readFile(path.join(coldRun, "stages", "decisions", "_receipt.json"), "utf8"));

// WARM — the same evidence into the SAME run directory. The stages reuse, and
// the work the controller still performs unconditionally is now visible as a
// HIT with a reason rather than only as elapsed time.
const warm = JSON.parse(
  (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", coldRun, "--stop-after", "decisions", "--json"])).stdout,
);
check(warm.status === "PAUSED", `the end-to-end warm run did not pause after decisions: ${warm.status}`);
check(
  (warm.reused_stages ?? []).includes("inputs"),
  `the warm run did not reuse the inputs stage: ${JSON.stringify(warm.reused_stages)}`,
);
const warmLog = JSON.parse(await fs.readFile(coldLogPath, "utf8"));
const warmByNode = new Map(warmLog.decisions.map((record) => [record.node, record]));
check(warmLog.summary.hit > 0, `the warm run recorded no cache hit at all: ${JSON.stringify(warmLog.summary)}`);
check(
  CACHE_INTEGRITY_VIOLATIONS(warmLog).length === 0,
  `a clean warm run recorded a cache-integrity violation: ${JSON.stringify(CACHE_INTEGRITY_VIOLATIONS(warmLog))}`,
);
// `runIntake` runs unconditionally BEFORE the stage-2 reuse check. That is
// P6.4's hoist to make; P6.3's job is that it stops being invisible.
check(
  warmByNode.get("intake_plan")?.decision === "HIT" &&
    warmByNode.get("intake_plan")?.reason === "hit.inputs_unchanged",
  `the unconditional intake work is still not recorded as a hit: ${JSON.stringify(warmByNode.get("intake_plan"))}`,
);

// ADDITIVE — the warm run's emitted numbers are the cold run's.
const warmCase = JSON.parse(await fs.readFile(path.join(coldRun, "stages", "decisions", "model-case.json"), "utf8"));
const warmStage3 = JSON.parse(await fs.readFile(path.join(coldRun, "stages", "decisions", "_receipt.json"), "utf8"));
check(hashValue(warmCase) === hashValue(coldCase), "the work graph changed the model case between runs");
check(
  hashValue(warmStage3.detail) === hashValue(coldStage3.detail),
  `the work graph changed a stage receipt's emitted numbers: ${JSON.stringify(coldStage3.detail)} -> ${JSON.stringify(warmStage3.detail)}`,
);

// A STAGE cache loss without an input change, end to end. Deleting the stage-1
// receipt forces the evidence node to execute again on byte-identical evidence:
// the node-level key must survive the stage-level loss and record a HIT with a
// reason. This is the granularity the stage receipt could not express.
const stage1ReceiptPath = path.join(coldRun, "stages", "inputs", "_receipt.json");
await fs.rm(stage1ReceiptPath, { force: true });
const restaged = JSON.parse(
  (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", coldRun, "--stop-after", "decisions", "--json"])).stdout,
);
check(restaged.status === "PAUSED", `the re-staged run did not pause after decisions: ${restaged.status}`);
check(
  !(restaged.reused_stages ?? []).includes("inputs"),
  "deleting the stage-1 receipt did not force the inputs stage to re-run",
);
const restagedLog = JSON.parse(await fs.readFile(coldLogPath, "utf8"));
const restagedByNode = new Map(restagedLog.decisions.map((record) => [record.node, record]));
check(
  restagedByNode.get("evidence_validation")?.decision === "HIT" &&
    restagedByNode.get("evidence_validation")?.reason === "hit.inputs_unchanged",
  `the evidence node did not survive the stage cache loss: ${JSON.stringify(restagedByNode.get("evidence_validation"))}`,
);

// A CHANGED node input, end to end, driven through the REAL controller: move
// one recorded cache-key component in the node receipt (re-sealing the receipt
// so it is a genuine key move rather than tampering) and re-run. The node must
// MISS and NAME the component.
const evidenceNodeReceiptPath = path.join(
  coldRun, "stages", EVIDENCE_WORK_GRAPH_DIR, "evidence_validation", "_receipt.json",
);
const evidenceNodeReceipt = JSON.parse(await fs.readFile(evidenceNodeReceiptPath, "utf8"));
evidenceNodeReceipt.input_components.files.evidence_run = "0".repeat(64);
evidenceNodeReceipt.input_digest = hashValue(evidenceNodeReceipt.input_components);
delete evidenceNodeReceipt.receipt_hash;
evidenceNodeReceipt.receipt_hash = hashValue(evidenceNodeReceipt);
await fs.rm(stage1ReceiptPath, { force: true });
await fs.writeFile(evidenceNodeReceiptPath, `${JSON.stringify(evidenceNodeReceipt, null, 2)}\n`, "utf8");
const changed = JSON.parse(
  (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", coldRun, "--stop-after", "decisions", "--json"])).stdout,
);
check(changed.status === "PAUSED", `the moved-component run did not pause after decisions: ${changed.status}`);
const changedLog = JSON.parse(await fs.readFile(coldLogPath, "utf8"));
const changedByNode = new Map(changedLog.decisions.map((record) => [record.node, record]));
check(
  changedByNode.get("evidence_validation")?.decision === "MISS" &&
    changedByNode.get("evidence_validation")?.reason === "miss.input_component_moved",
  `a moved cache-key component did not miss the evidence node: ${JSON.stringify(changedByNode.get("evidence_validation"))}`,
);
check(
  (changedByNode.get("evidence_validation")?.moved ?? []).some((entry) => entry.startsWith("files.evidence_run:")),
  `the end-to-end miss does not name the component that moved: ${JSON.stringify(changedByNode.get("evidence_validation")?.moved)}`,
);

// ---------------------------------------------------------------------------
// PART D — the DOCUMENTED CHECKPOINT COUNT. A documented number that nothing
// verifies is how this drifted in the first place.
// ---------------------------------------------------------------------------
const orchestratorSource = await fs.readFile(path.join(ROOT, "scripts", "orchestrate_release.mjs"), "utf8");
const inventory = releaseCheckpointInventory(orchestratorSource);

check(inventory.ids.length === 14, `stage 4 no longer has 14 top-level checkpoints: ${inventory.ids.length}`);
check(
  inventory.leaf_generator === "renderLeafId",
  `the per-sheet render leaf generator was not found: ${inventory.leaf_generator}`,
);
check(
  inventory.ids.includes("verify_ownership_physical"),
  "the checkpoint the documentation dropped is no longer in the orchestrator",
);
for (const id of [
  "semantic_gates", "plan", "emit", "recalculate", "terminal_patch",
  "verify_ownership_physical", "verify_dynamic", "verify_style", "verify_cache",
  "verify_finance", "verify_semantic", "verify_aggregate", "render", "publish",
]) {
  check(inventory.ids.includes(id), `stage-4 checkpoint ${id} is missing from the inventory`);
}

const DOC_FILES = ["SKILL.md", "central-instructions.md", path.join("references", "runtime-core.md")];
for (const relative of DOC_FILES) {
  const text = await fs.readFile(path.join(ROOT, relative), "utf8");
  const violations = documentedCheckpointClaimViolations(text, inventory);
  check(violations.length === 0, `${relative} misstates the checkpoint inventory: ${violations.join("; ")}`);
}

// MUTATION — the historical wording must be REFUSED. This is RED 3, pinned.
const skillText = await fs.readFile(path.join(ROOT, "SKILL.md"), "utf8");
const driftedBack = skillText.replace(
  /The Build milestone has fourteen silent leaf checkpoints/,
  "The Build milestone has thirteen silent leaf checkpoints",
);
check(driftedBack !== skillText, "the corrected sentence was not found in SKILL.md");
check(
  documentedCheckpointClaimViolations(driftedBack, inventory).some((violation) => /thirteen|13/.test(violation)),
  "the historical 'thirteen' wording is still admitted by the checker",
);

// MUTATION — dropping the checkpoint the documentation used to omit must be refused.
const droppedName = skillText.replace(/forecast-ownership physical verification;\s*/, "");
check(droppedName !== skillText, "the restored checkpoint name was not found in SKILL.md");
check(
  documentedCheckpointClaimViolations(droppedName, inventory).length > 0,
  "a documentation surface that omits a real checkpoint is still admitted",
);

// MUTATION — a fifteenth checkpoint in the orchestrator must make the docs red.
const fifteenth = orchestratorSource.replace(
  '    id: "publish",',
  '    id: "publish_extra",\n  });\n  step = await checkpoint({\n    id: "publish",',
);
const grownInventory = releaseCheckpointInventory(fifteenth);
check(grownInventory.ids.length === 15, `the inventory did not see the added checkpoint: ${grownInventory.ids.length}`);
check(
  documentedCheckpointClaimViolations(skillText, grownInventory).length > 0,
  "a documentation surface that undercounts a newly added checkpoint is still admitted",
);

// MUTATION — a documentation surface that forgets the per-sheet render leaves.
const noLeaves = skillText.replace(/,\s*plus one further\s*render leaf per rendered sheet/, "");
check(noLeaves !== skillText, "the render-leaf clause was not found in SKILL.md");
check(
  documentedCheckpointClaimViolations(noLeaves, inventory).some((violation) => /render leaf|leaves/i.test(violation)),
  "a documentation surface that omits the per-sheet render leaves is still admitted",
);

// The three surfaces say the SAME thing — central-instructions.md and
// references/runtime-core.md are generated from SKILL.md.
const sentences = [];
for (const relative of DOC_FILES) {
  const text = await fs.readFile(path.join(ROOT, relative), "utf8");
  const match = /The Build milestone has [^.]+\./.exec(text);
  check(match !== null, `${relative} carries no checkpoint-count sentence`);
  sentences.push(match?.[0] ?? "");
}
check(new Set(sentences).size === 1, "the three instruction surfaces disagree about the checkpoint count");

// P6.3 does not rewrite stage 4: the orchestrator's checkpoint() is unchanged
// in shape, and the evidence graph reuses that shape rather than inventing one.
for (const field of ["id", "recipe", "inputs", "outputs", "action"]) {
  check(
    new RegExp(`async function checkpoint\\(\\{[^}]*\\b${field}\\b`).test(orchestratorSource),
    `stage 4's checkpoint() no longer takes ${field}; the evidence graph's shape is no longer verbatim`,
  );
  check(
    new RegExp(`runNode\\(\\{[^}]*\\b${field}\\b`, "s").test(graphSource),
    `the evidence work graph's runNode does not take stage 4's ${field}`,
  );
}

await fs.rm(workspace, { recursive: true, force: true });

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  console.log(JSON.stringify({ status: "FAIL", checks, violations: failures.length }));
  process.exit(1);
}
console.log(JSON.stringify({ status: "PASS", checks }));
assert.ok(checks > 0);
