/**
 * The evidence-half work graph — P6.3.
 *
 * Invariant: expensive work in the EVIDENCE half is a declared graph of nodes,
 * each with declared inputs, outputs, a cache key and an invalidation rule —
 * and every cache decision records its REASON (hit, miss with the component
 * that moved, or invalid with why), rather than being observable only as
 * elapsed time.
 *
 * WHY THIS SHAPE, AND NOT A SECOND CONVENTION
 * -------------------------------------------
 * The repository already had exactly ONE real cache-keyed work graph: stage 4's
 * `checkpoint()` in scripts/orchestrate_release.mjs (14 top-level ids plus one
 * render leaf per rendered sheet). It is proven by the registered
 * `stage4-content-addressed-resume` suite, and it is NOT rewritten by this
 * package. `runNode` below therefore takes stage 4's call shape verbatim —
 * `{ id, recipe, inputs, outputs, action }` — injects the same two ambient
 * components stage 4 injects (`controller`, the runtime snapshot), keeps the
 * same `reused`/`executed`/`receipts`/`timings` bookkeeping, and returns stage
 * 4's `{ ok, receipt, reused }`. Reusing the shape means an operator who can
 * read a stage-4 checkpoint receipt can read an evidence-node receipt.
 *
 * WHAT ENACTMENT MEANS HERE, AND WHAT IT COSTS
 * --------------------------------------------
 * `ENACT_EVIDENCE_REUSE = true`: a node that declares `reuse_enactable` and
 * lands on a clean hit (`hit.inputs_unchanged`, success receipt, same run,
 * receipt hash intact) replays its prior receipt instead of re-running its
 * action. Enactment is opt-in PER NODE, never global: only the four pure,
 * acyclic compile nodes declare it (`statement_normalisation`,
 * `forecast_behavior_map`, `model_demand_graph`, `forecast_plan`) — work whose
 * value is a deterministic function of keyed inputs. Every other node keeps
 * P6.3's always-execute semantics unchanged.
 *
 * Two gates stand between a clean hit and a skip, because an enacting cache
 * must not serve what is no longer there:
 *
 *  1. EXISTENCE: every file-backed declared output path must still exist
 *     (`hashDeclaredPaths`, no `absent`). A vanished artifact is not a hit;
 *     the node falls through and does the work again. (This composes naturally
 *     with any downstream absence gating: vanished output ⇒ no clean hit.)
 *  2. A RECORDED VALUE: the prior receipt must carry the `recorded_value` the
 *     successful action produced (sealed into the receipt body by
 *     `receipt_hash`). Without one — a legacy receipt written before this
 *     field existed — there is nothing lawful to return, so the node executes
 *     and writes a replayable receipt for next time.
 *
 * THE COST, STATED PLAINLY: a skipped node is no longer re-computed, so
 * P6.3's dishonest-key detector (`invalid.output_digest_mismatch`) cannot fire
 * for it — a key that agreed while truth moved is now served stale rather than
 * caught. That risk is accepted deliberately, and bounded: the replayed value
 * is the receipt-sealed bytes the honest execution produced, the input key
 * covers the controller version, the runtime closure and every dependency's
 * output digest, and the four opted-in nodes are pure functions of those keys.
 * Non-enactable nodes keep spending the work to earn the right to skip, and
 * their hits stay CHECKED.
 *
 * A validator validates. Nothing here repairs a receipt, rewrites a key, or
 * changes a value the controller computed. A node that throws is RECORDED and
 * then RETHROWN unchanged.
 *
 * WHAT A SUCCESS RECEIPT PROMISES (MP2 E2)
 * ----------------------------------------
 * A node receipt with status "success" is a claim that the node's DECLARED
 * OUTPUTS exist on disk. `runNode` checks that claim on every executed pass:
 * after the action completes, each declared output path the call site named
 * is hashed, and any path that hashes `absent` refuses success — the node is
 * sealed with status "BLOCKED", blocker_class "INTERNAL_WORK" and reason
 * `invalid.declared_output_absent`, naming the missing files, and a typed
 * `EvidenceWorkOutputAbsentError` is thrown so callers fail loudly instead of
 * building downstream work on artifacts that were never written. The same
 * honesty governs reuse claims: `reuseStage` re-verifies that a previously
 * successful node's recorded output paths still exist BEFORE it records a
 * stage-level hit for that node; an output that has vanished since is
 * recorded as `invalid.declared_output_absent`, never as a clean hit.
 *
 * RELATION TO P6.2
 * ----------------
 * P6.2 made `nodeInputDigest`/`explainMiss` live and gave the STAGE a miss
 * record at `stages/<id>/_miss.json`. That is not redone here. This module
 * EXTENDS the same two functions to node granularity and adds the two decision
 * categories a miss record cannot express: a HIT (which recorded nothing at
 * all) and an INVALID (which was indistinguishable from a miss).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalJson, explainMiss, hashFile, hashValue, nodeInputDigest } from "./run_store.mjs";

export const EVIDENCE_WORK_NODE_SCHEMA = "evidence-work-node/1.0";
export const SUPERSEDED_EVIDENCE_WORK_NODE_SCHEMAS = Object.freeze(["evidence-work-node/0.9"]);
export const EVIDENCE_WORK_GRAPH_DIR = "_work_graph";
export const EVIDENCE_WORK_DECISION_FILE = "decisions.json";
export const EVIDENCE_WORK_RECEIPT_FILE = "_receipt.json";

/**
 * Enactment is LIVE, but scoped: see "WHAT ENACTMENT MEANS HERE" in the header.
 * Only nodes declaring `reuse_enactable` replay their receipts, and only past
 * an existence-verified clean hit. The suite pins this constant, so its value
 * is a deliberate, reviewed behaviour change and not a drift.
 */
export const ENACT_EVIDENCE_REUSE = true;

/**
 * The closed reason vocabulary. Three categories, and every reason names the
 * thing that decided the outcome. A decision record whose reason is outside
 * this list is a defect, not a new case.
 */
export const EVIDENCE_WORK_REASONS = Object.freeze([
  // HIT — the key agreed.
  "hit.inputs_unchanged",
  "hit.stage_receipt_reused",
  // MISS — the key moved, and the component that moved is named.
  "miss.no_prior_receipt",
  "miss.recipe_changed",
  "miss.input_component_moved",
  "miss.dependency_output_moved",
  // INVALID — there was a prior receipt, and it may not be believed.
  "invalid.receipt_unreadable",
  "invalid.receipt_schema_superseded",
  "invalid.receipt_foreign_run",
  "invalid.receipt_not_success",
  "invalid.receipt_tampered",
  "invalid.output_digest_mismatch",
  "invalid.output_not_hashable",
  "invalid.declared_output_absent",
  "invalid.node_threw",
]);

const DECISION_OF_REASON = Object.freeze({
  hit: "HIT",
  miss: "MISS",
  invalid: "INVALID",
});

/**
 * Thrown by `runNode` when a node's action completed but did not write one or
 * more of the output paths the call site declared. A success receipt would be
 * a lie about artifacts that do not exist, so the node is sealed BLOCKED and
 * this typed error is thrown instead — callers fail loudly, never silently
 * onward over work that produced nothing.
 */
export class EvidenceWorkOutputAbsentError extends Error {
  constructor(nodeId, missing) {
    super(
      `Evidence work node ${nodeId} completed without writing its declared output(s): ${missing
        .map((entry) => `${entry.name} (${entry.path ?? "no path declared"})`)
        .join(", ")}`,
    );
    this.name = "EvidenceWorkOutputAbsentError";
    this.code = "invalid.declared_output_absent";
    this.blocker_class = "INTERNAL_WORK";
    this.node_id = nodeId;
    this.missing_outputs = missing;
  }
}

/**
 * The declared evidence-half work DAG.
 *
 * Ordered topologically, so `depends_on` may only name a node declared before
 * it and the graph is acyclic by construction. `key_components` are the
 * node-specific components the CALL SITE must supply; the graph additionally
 * and unconditionally keys every node on the controller version, the derived
 * runtime code closure, and the output digest of each node in `depends_on`, so
 * a call site cannot narrow a key by omission.
 *
 * The decisions stage carries eight nodes. That is the P3.7 deferred follow-on:
 * one stage receipt used to cover the recompile, the decision replay, the
 * statement normalisation, the behaviour map, the demand graph, the forecast
 * plan, the authority contract and the constitution graph indivisibly, so a
 * miss on any of them was reported as a miss on all of them.
 */
export const EVIDENCE_WORK_NODES = Object.freeze([
  Object.freeze({
    id: "evidence_validation",
    stage: "inputs",
    recipe: "evidence-validation/1.0",
    depends_on: Object.freeze([]),
    key_components: Object.freeze(["evidence_run"]),
    outputs: Object.freeze(["evidence_validation", "case_compile_report"]),
    invalidated_by:
      "a byte change in the raw evidence-run envelope, or a change in the derived runtime code closure the controller executes",
  }),
  Object.freeze({
    id: "broker_preview",
    stage: "evidence_review",
    recipe: "broker-preview/1.0",
    depends_on: Object.freeze(["evidence_validation"]),
    key_components: Object.freeze([
      "broker_pack",
      "broker_source_tables",
      "broker_crosswalk_receipt",
    ]),
    outputs: Object.freeze(["broker_preview"]),
    invalidated_by:
      "a change in any of the three broker binding hashes, or in the evidence validation the preview is bound to",
  }),
  Object.freeze({
    id: "broker_selected_case_compile",
    stage: "evidence_review",
    recipe: "broker-selected-case-compile/1.0",
    depends_on: Object.freeze(["broker_preview"]),
    key_components: Object.freeze(["case_source", "case_evidence"]),
    outputs: Object.freeze(["model_case", "case_compile_report"]),
    invalidated_by:
      "a change in the case source, in the broker-projected case evidence, or in the broker preview that selected it",
  }),
  Object.freeze({
    id: "intake_plan",
    stage: "evidence_review",
    recipe: "intake-decision-plan/1.0",
    depends_on: Object.freeze(["evidence_validation", "broker_selected_case_compile"]),
    key_components: Object.freeze(["intake", "draft_case"]),
    outputs: Object.freeze(["intake_result"]),
    invalidated_by:
      "a change in the intake contract, in the draft case the plan is computed over, or in either upstream compilation",
  }),
  Object.freeze({
    id: "answered_case_recompile",
    stage: "decisions",
    recipe: "answered-case-compile/1.0",
    depends_on: Object.freeze(["intake_plan"]),
    key_components: Object.freeze(["answered_case_source", "case_evidence"]),
    outputs: Object.freeze(["model_case", "case_compile_report"]),
    invalidated_by:
      "a change in the case source carrying the recorded answers, in the active case evidence, or in the decision plan that produced the answers",
  }),
  Object.freeze({
    id: "intake_replay",
    stage: "decisions",
    recipe: "intake-decision-replay/1.0",
    depends_on: Object.freeze(["answered_case_recompile"]),
    key_components: Object.freeze(["intake", "recompiled_case", "prior_answers"]),
    outputs: Object.freeze(["intake_result"]),
    invalidated_by:
      "a change in the intake contract, in the freshly recompiled case, or in the recorded prior answers replayed against it",
  }),
  Object.freeze({
    id: "statement_normalisation",
    stage: "decisions",
    recipe: "statement-normalisation/1.0",
    depends_on: Object.freeze(["intake_replay"]),
    key_components: Object.freeze(["answered_case"]),
    outputs: Object.freeze(["statement_structure", "source_coverage"]),
    reuse_enactable: true,
    invalidated_by:
      "a change in the answered case whose income-statement and cash-flow rows are normalised, or in the decision replay that settled it",
  }),
  Object.freeze({
    id: "forecast_behavior_map",
    stage: "decisions",
    recipe: "forecast-behavior-map/1.0",
    depends_on: Object.freeze(["statement_normalisation"]),
    key_components: Object.freeze(["planning_case"]),
    outputs: Object.freeze(["forecast_behavior_map"]),
    reuse_enactable: true,
    invalidated_by:
      "a change in the planning case, or in the normalised statement structure the behaviour map is compiled against",
  }),
  Object.freeze({
    id: "model_demand_graph",
    stage: "decisions",
    recipe: "model-demand-graph/1.0",
    depends_on: Object.freeze(["statement_normalisation"]),
    key_components: Object.freeze(["planning_case"]),
    outputs: Object.freeze(["model_demand_graph"]),
    reuse_enactable: true,
    invalidated_by:
      "a change in the planning case, or in the normalised statement structure the demand graph is compiled against",
  }),
  Object.freeze({
    id: "forecast_plan",
    stage: "decisions",
    recipe: "forecast-plan/1.0",
    depends_on: Object.freeze(["statement_normalisation", "forecast_behavior_map"]),
    key_components: Object.freeze(["planning_case", "observation_ledger", "source_inventory"]),
    outputs: Object.freeze(["forecast_plan"]),
    reuse_enactable: true,
    invalidated_by:
      "a change in the planning case, the forecast observation ledger or the source inventory, or in the behaviour map the plan is compiled from",
  }),
  Object.freeze({
    id: "selected_authority_contract",
    stage: "decisions",
    recipe: "selected-authority-contract/1.0",
    depends_on: Object.freeze(["forecast_plan", "model_demand_graph"]),
    key_components: Object.freeze(["planning_case", "evidence_run"]),
    outputs: Object.freeze(["selected_authority_contract"]),
    invalidated_by:
      "a change in the planning case or the evidence run, or in either the forecast plan or the model-demand graph the contract is selected over",
  }),
  Object.freeze({
    id: "run_constitution_graph",
    stage: "decisions",
    recipe: "run-constitution-graph/1.0",
    depends_on: Object.freeze([
      "forecast_plan",
      "model_demand_graph",
      "selected_authority_contract",
    ]),
    key_components: Object.freeze(["planning_case", "evidence_run"]),
    outputs: Object.freeze(["run_constitution_graph"]),
    invalidated_by:
      "a change in the planning case or the evidence run, or in any of the forecast plan, model-demand graph or selected-authority contract the constitution graph closes over",
  }),
]);

const NODES_BY_ID = new Map(EVIDENCE_WORK_NODES.map((node) => [node.id, node]));

export function evidenceWorkNode(id) {
  return NODES_BY_ID.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// P6.4 — WHAT A CHANGE ACTUALLY INVALIDATES.
//
// `CHANGE_INVALIDATION` in flow_runtime.mjs is a hand-written map from a
// user-flow change type to the earliest stage that must re-run. It had zero
// callers, and nothing had ever checked it against the work that really exists.
// These two declarations are the check. The map below names only the cache-key
// COMPONENTS a change moves — a small, local, falsifiable claim, each one
// demonstrable by moving that component and watching the node miss — and the
// DAG then decides which nodes fall, by keying and by dependency. The stage
// answer is computed from the graph, never asserted twice.
//
// `AMBIENT_KEY_COMPONENTS` are the two components the graph injects into every
// node's key, so a change to either invalidates the entire graph.
// ---------------------------------------------------------------------------
export const AMBIENT_KEY_COMPONENTS = Object.freeze(["code.controller", "code.runtime_closure"]);

export const CHANGE_KEY_COMPONENTS = Object.freeze({
  // Every one of these lives INSIDE the single evidence-run envelope whose
  // file hash is `evidence_validation`'s only declared key component, so each
  // of them moves `evidence_run` whatever else it also moves. Measured: adding
  // one key under `broker_pack` moves `files.evidence_run` and misses
  // `evidence_validation`, a stage-`inputs` node.
  company_name: Object.freeze(["evidence_run", "case_source"]),
  source_file: Object.freeze(["evidence_run", "case_evidence"]),
  filing: Object.freeze(["evidence_run", "case_evidence"]),
  debt_export: Object.freeze(["evidence_run", "case_evidence"]),
  broker_forecast: Object.freeze([
    "evidence_run",
    "broker_pack",
    "broker_source_tables",
    "broker_crosswalk_receipt",
  ]),
  prior_case: Object.freeze(["evidence_run", "case_source"]),
  // An answer is recorded into the answered case source and replayed as a
  // prior answer. Measured: changing one answer misses exactly the eight
  // decisions nodes and nothing in `inputs` or `evidence_review`.
  user_answer: Object.freeze(["answered_case_source", "prior_answers"]),
  assumption: Object.freeze(["answered_case", "planning_case"]),
  transaction_input: Object.freeze(["answered_case_source", "answered_case", "planning_case"]),
  // Nothing in the evidence half is keyed on presentation or wording.
  formatting: Object.freeze([]),
  delivery_wording: Object.freeze([]),
  controller_code: Object.freeze(["code.controller", "code.runtime_closure"]),
});

/**
 * The nodes a change invalidates: every node keyed on a moved component, plus
 * everything transitively downstream of one, because a dependency's output
 * digest is itself a key component. Returns node ids in declaration order.
 */
export function invalidatedNodesForChange(change, nodes = EVIDENCE_WORK_NODES) {
  const moved = CHANGE_KEY_COMPONENTS[change];
  if (!moved) throw new Error(`Unknown user-flow change type: ${change}`);
  const movedSet = new Set(moved);
  const ambient = moved.some((component) => AMBIENT_KEY_COMPONENTS.includes(component));
  const invalidated = new Set();
  for (const node of nodes) {
    if (ambient || node.key_components.some((component) => movedSet.has(component))) {
      invalidated.add(node.id);
      continue;
    }
    if (node.depends_on.some((dependency) => invalidated.has(dependency))) {
      invalidated.add(node.id);
    }
  }
  return nodes.filter((node) => invalidated.has(node.id)).map((node) => node.id);
}

// ---------------------------------------------------------------------------
// P6.4 — IS THE REUSE A RUN CLAIMS THE REUSE IT PERFORMED?
//
// `reused_stages` was a list of stages whose RECEIPT was reused. It said
// nothing about whether the work inside them ran, and on a warm answered run
// two of the eight `decisions` nodes and all three `evidence_review` nodes
// re-executed inside stages the run reported as reused. This function turns the
// claim into something checkable, per stage:
//
//   skipped     the node's action never ran
//   verified    the action ran and reproduced EXACTLY the output the prior
//               receipt recorded — the claim is true about the result even
//               though the work was spent
//   degraded    the action ran, threw, and produced no output either time; the
//               controller's own recorded degradation path, neither reuse nor
//               change
//   unrecorded  the action ran and there was no prior recorded output to
//               compare it with (the node has no receipt yet). This CANNOT
//               contradict the claim, so it is not a lie — but it does not
//               back it either, and a stage carrying one reports `unverified`
//               rather than `verified`.
//
// The one remaining case is a DISHONEST CLAIM and is returned as a violation: a
// node that ran, HAD a recorded output to be measured against, and produced
// something different from it. A stage cannot be reported as reused while a
// node inside it contradicts the receipt the stage is resting on. The refusal
// is deliberately confined to what is PROVABLY false; a claim that merely
// cannot be checked is reported as unchecked, not refused.
// ---------------------------------------------------------------------------
export const REUSE_ENACTMENT_MODES = Object.freeze([
  "enacted",
  "verified",
  "unverified",
  "not_claimed",
]);

export function reuseClaimLedger(decisions, claimedStages, nodes = EVIDENCE_WORK_NODES) {
  const claimed = new Set(claimedStages ?? []);
  const byStage = new Map();
  for (const stage of new Set(nodes.map((node) => node.stage))) {
    byStage.set(stage, {
      stage,
      claimed: claimed.has(stage),
      skipped: [],
      enacted_nodes: [],
      verified: [],
      degraded: [],
      unrecorded: [],
      dishonest: [],
      executed_ms: 0,
    });
  }
  for (const record of decisions ?? []) {
    const bucket = byStage.get(record.stage);
    if (!bucket) continue;
    // Two ways a node can be skipped, and only one of them speaks for a STAGE
    // claim. A stage-receipt reuse (`hit.stage_receipt_reused`) is evidence the
    // stage's claimed work was not entered. A node-receipt replay
    // (`executed: false` with any other reason) is node-level enactment, which
    // is lawful whether or not the stage was claimed — so it is reported in its
    // own bucket and never fabricated into an unclaimed-stage violation.
    if (record.executed === false) {
      if (record.reason === "hit.stage_receipt_reused") bucket.skipped.push(record.node);
      else bucket.enacted_nodes.push(record.node);
      continue;
    }
    bucket.executed_ms += Number(record.duration_ms ?? 0);
    if (record.output_agreed === true) bucket.verified.push(record.node);
    else if (record.reason === "invalid.node_threw" || record.reason === "invalid.output_not_hashable") {
      bucket.degraded.push(record.node);
    } else if (record.output_agreed === false) {
      bucket.dishonest.push(`${record.node}: the output moved (${record.reason})`);
    } else {
      bucket.unrecorded.push(`${record.node}: no prior output to agree with (${record.reason})`);
    }
  }
  const stages = [];
  for (const bucket of byStage.values()) {
    const executed =
      bucket.verified.length + bucket.degraded.length + bucket.unrecorded.length + bucket.dishonest.length;
    stages.push({
      ...bucket,
      mode: !bucket.claimed
        ? "not_claimed"
        : executed === 0
          ? "enacted"
          : bucket.unrecorded.length > 0
            ? "unverified"
            : "verified",
      executed_node_count: executed,
      executed_ms: Number(bucket.executed_ms.toFixed(3)),
    });
  }
  stages.sort((a, b) => a.stage.localeCompare(b.stage));
  const violations = [];
  for (const stage of stages) {
    if (!stage.claimed) {
      if (stage.skipped.length > 0) {
        violations.push(
          `${stage.stage} was not claimed as reused, yet ${stage.skipped.join(", ")} recorded a stage-receipt reuse`,
        );
      }
      continue;
    }
    for (const entry of stage.dishonest) {
      violations.push(`${stage.stage} was claimed as reused, but ${entry}`);
    }
  }
  return { stages, violations };
}

/** The stages those nodes belong to, in graph declaration order. */
export function invalidatedStagesForChange(change, nodes = EVIDENCE_WORK_NODES) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stages = [];
  for (const id of invalidatedNodesForChange(change, nodes)) {
    const stage = byId.get(id)?.stage;
    if (stage && !stages.includes(stage)) stages.push(stage);
  }
  return stages;
}

/**
 * Refuse a declaration that is not a work DAG. A node with no declared cache
 * key is not a node — it is untracked work wearing a name.
 */
export function validateEvidenceWorkGraph(nodes = EVIDENCE_WORK_NODES) {
  const violations = [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return ["the evidence work graph declares no nodes"];
  }
  const declaredSoFar = new Set();
  const allIds = new Set();
  for (const node of nodes) {
    if (allIds.has(node?.id)) violations.push(`duplicate work node id: ${node?.id}`);
    allIds.add(node?.id);
  }
  for (const node of nodes) {
    const id = node?.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_]*$/.test(id)) {
      violations.push(`work node has no stable id: ${JSON.stringify(id)}`);
      continue;
    }
    if (typeof node.stage !== "string" || node.stage.length === 0) {
      violations.push(`${id} declares no stage`);
    }
    if (typeof node.recipe !== "string" || !/\/\d+\.\d+$/.test(node.recipe)) {
      violations.push(`${id} declares no versioned recipe`);
    }
    if (!Array.isArray(node.key_components) || node.key_components.length === 0) {
      violations.push(`${id} declares no cache key`);
    } else if (new Set(node.key_components).size !== node.key_components.length) {
      violations.push(`${id} declares a duplicate cache key component`);
    }
    if (!Array.isArray(node.outputs) || node.outputs.length === 0) {
      violations.push(`${id} declares no outputs`);
    }
    if (typeof node.invalidated_by !== "string" || node.invalidated_by.trim().length === 0) {
      violations.push(`${id} declares no invalidation rule`);
    }
    if (!Array.isArray(node.depends_on)) {
      violations.push(`${id} declares no dependency list`);
    } else {
      for (const dependency of node.depends_on) {
        if (dependency === id) violations.push(`${id} depends on itself`);
        else if (!allIds.has(dependency)) violations.push(`${id} depends on an undeclared node: ${dependency}`);
        else if (!declaredSoFar.has(dependency)) {
          violations.push(`${id} depends on ${dependency}, which is not declared before it (the declaration must be topologically ordered)`);
        }
      }
    }
    declaredSoFar.add(id);
  }
  return violations;
}

function reasonDecision(reason) {
  return DECISION_OF_REASON[String(reason).split(".")[0]] ?? "MISS";
}

/** Digest a node's produced value. A value that cannot be canonicalised is a
 *  recorded fact, never a thrown one: refusing here would change the run. */
function safeOutputDigest(value) {
  try {
    return { digest: hashValue(JSON.parse(JSON.stringify(value ?? null, (_key, item) => (typeof item === "function" ? undefined : item))) ?? null), hashable: true };
  } catch {
    return { digest: "unhashable", hashable: false };
  }
}

/**
 * The replayable form of a successful action's value: the same JSON round-trip
 * `safeOutputDigest` applies, so what is recorded is exactly what was digested.
 * A value that cannot survive the round-trip records as undefined, and a
 * receipt without a recorded value is never replayed — the node re-executes
 * rather than serve something it cannot account for.
 */
function safeRecordedValue(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null, (_key, item) => (typeof item === "function" ? undefined : item)));
  } catch {
    return undefined;
  }
}

function receiptBodyHash(receipt) {
  const { receipt_hash: _ignored, ...body } = receipt ?? {};
  return hashValue(body);
}

async function atomicWrite(target, text) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Open the evidence-half work graph for one run.
 *
 * `runNode` takes stage 4's `checkpoint()` call shape verbatim and returns its
 * `{ ok, receipt, reused }`, extended with the fields a recorded reason needs:
 * `{ decision, reason, moved, output_digest, value, duration_ms }`.
 */
export function createEvidenceWorkGraph({
  runDir,
  runId,
  controllerVersion,
  runtimeDigest,
  nodes = EVIDENCE_WORK_NODES,
  // P6.4: the optional attempt ledger. When present, every node execution —
  // first try or retry — gets a receipt, a failure gets a CLASS, and only a
  // class the table permits to retry is retried. The lane is the evidence half,
  // deliberately outside the broker supervisor, which was the only lane in the
  // repository that had a retry story at all.
  attemptLedger = null,
}) {
  const declarationViolations = validateEvidenceWorkGraph(nodes);
  if (declarationViolations.length > 0) {
    throw new Error(`The evidence work graph declaration is not a work DAG: ${declarationViolations[0]}`);
  }
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("The evidence work graph requires the run directory it belongs to");
  }
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("The evidence work graph requires the run identity it belongs to");
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const graphDir = path.join(runDir, "stages", EVIDENCE_WORK_GRAPH_DIR);
  const decisions = [];
  const decided = new Set();
  const outputDigests = new Map();
  const reusedNodes = [];
  const executedNodes = [];
  const nodeReceipts = {};
  const timingsMs = {};
  let reuseClaim = null;

  function summary() {
    const counts = { hit: 0, miss: 0, invalid: 0 };
    for (const record of decisions) counts[record.decision.toLowerCase()] += 1;
    return counts;
  }

  async function flush() {
    await atomicWrite(
      path.join(graphDir, EVIDENCE_WORK_DECISION_FILE),
      `${canonicalJson({
        schema_version: EVIDENCE_WORK_NODE_SCHEMA,
        run_id: runId,
        controller_version: controllerVersion,
        runtime_closure_sha256: runtimeDigest,
        enacts_reuse: ENACT_EVIDENCE_REUSE,
        declared_node_count: nodes.length,
        reason_vocabulary: [...EVIDENCE_WORK_REASONS],
        summary: summary(),
        reuse_claim: reuseClaim,
        decisions,
      })}\n`,
    );
  }

  async function record({
    node,
    reason,
    moved = [],
    detail = null,
    durationMs = null,
    priorOutputDigest = null,
    outputAgreed = null,
    executed = true,
    enactedReuse = false,
  }) {
    if (!EVIDENCE_WORK_REASONS.includes(reason)) {
      throw new Error(`Evidence work node ${node.id} recorded a reason outside the vocabulary: ${reason}`);
    }
    const entry = {
      node: node.id,
      stage: node.stage,
      recipe: node.recipe,
      decision: reasonDecision(reason),
      reason,
      moved: [...moved],
      key_components: [...node.key_components],
      invalidated_by: node.invalidated_by,
      enacted_reuse: enactedReuse,
      // P6.4: a decision record now says whether the node's ACTION RAN, and if
      // it did, whether what it produced is what the prior receipt recorded.
      // Without these two fields a claim of stage reuse cannot be checked at
      // all — a stage whose nodes all re-ran looked exactly like one whose
      // nodes were all skipped.
      executed,
      prior_output_digest: priorOutputDigest,
      output_agreed: outputAgreed,
      duration_ms: durationMs,
      detail,
    };
    const existing = decisions.findIndex((candidate) => candidate.node === node.id);
    if (existing >= 0) decisions[existing] = entry;
    else decisions.push(entry);
    decided.add(node.id);
    await flush();
    return entry;
  }

  function receiptPath(nodeId) {
    return path.join(graphDir, nodeId, EVIDENCE_WORK_RECEIPT_FILE);
  }

  async function readReceipt(nodeId) {
    let raw;
    try {
      raw = await fs.readFile(receiptPath(nodeId), "utf8");
    } catch {
      return { state: "absent" };
    }
    try {
      return { state: "present", receipt: JSON.parse(raw) };
    } catch {
      return { state: "unreadable" };
    }
  }

  /**
   * Hash the declared output paths a call site named. A path that does not
   * exist yet hashes to `absent`, exactly as the stage-receipt output hashing
   * does, so a node's declared artifacts appearing or disappearing moves the
   * recorded output.
   */
  async function hashDeclaredPaths(outputs) {
    const hashes = {};
    for (const [name, target] of Object.entries(outputs ?? {}).sort()) {
      if (typeof target !== "string") continue;
      try {
        hashes[name] = await hashFile(target);
      } catch {
        hashes[name] = "absent";
      }
    }
    return hashes;
  }

  /**
   * The declared output paths the call site named as REAL filesystem targets.
   * A null target declares a name without a file — the unit suites drive nodes
   * that way — so only string targets can be checked for existence, and the
   * absence gate below deliberately applies to them alone.
   */
  function declaredPathTargets(outputs) {
    return Object.entries(outputs ?? {})
      .filter(([, target]) => typeof target === "string")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, target]) => ({ name, path: target }));
  }

  /**
   * The declared string targets that are not readable files right now. A
   * directory is absent too: an output is something `hashFile` can digest, and
   * that is exactly what the success receipt will claim about it.
   */
  async function absentDeclaredPaths(targets) {
    const missing = [];
    for (const entry of targets) {
      try {
        const stat = await fs.stat(entry.path);
        if (!stat.isFile()) missing.push(entry);
      } catch {
        missing.push(entry);
      }
    }
    return missing;
  }

  async function runNode({ id, recipe, inputs, outputs, action }) {
    const node = byId.get(id);
    if (!node) throw new Error(`${id} is not a declared evidence work node`);
    if (recipe !== node.recipe) {
      throw new Error(
        `Evidence work node ${id} was invoked with recipe ${recipe}, but the graph declares ${node.recipe}`,
      );
    }
    const supplied = inputs ?? {};
    for (const component of node.key_components) {
      if (!Object.hasOwn(supplied, component) || supplied[component] === undefined) {
        throw new Error(
          `Evidence work node ${id} was invoked without its declared cache key component ${component}`,
        );
      }
    }
    for (const component of Object.keys(supplied)) {
      if (!node.key_components.includes(component)) {
        throw new Error(
          `Evidence work node ${id} was invoked with the undeclared cache key component ${component}`,
        );
      }
    }
    const declaredOutputs = outputs ?? {};
    for (const name of Object.keys(declaredOutputs)) {
      if (!node.outputs.includes(name)) {
        throw new Error(`Evidence work node ${id} was invoked with the undeclared output ${name}`);
      }
    }
    if (typeof action !== "function") {
      throw new Error(`Evidence work node ${id} was invoked without an action`);
    }

    // Stage 4 injects `controller` and the runtime snapshot into every
    // checkpoint's input hashes. The same two components are injected here, and
    // each dependency's recorded output digest is injected as a third class, so
    // a node cannot be keyed more narrowly than its position in the DAG.
    const dependencyDigests = {};
    for (const dependency of node.depends_on) {
      dependencyDigests[dependency] =
        outputDigests.get(dependency) ?? (await readReceipt(dependency)).receipt?.output_digest ?? "absent";
    }
    const digest = nodeInputDigest({
      nodeId: id,
      recipe,
      code: { controller: controllerVersion, runtime_closure: runtimeDigest },
      files: { ...supplied },
      params: { key_components: [...node.key_components] },
      deps: dependencyDigests,
    });
    const inputDigest = hashValue(digest);

    const prior = await readReceipt(id);
    let reason = null;
    let moved = [];
    if (prior.state === "absent") {
      reason = "miss.no_prior_receipt";
    } else if (prior.state === "unreadable") {
      reason = "invalid.receipt_unreadable";
    } else if (prior.receipt?.schema_version !== EVIDENCE_WORK_NODE_SCHEMA) {
      reason = "invalid.receipt_schema_superseded";
      moved = [`schema_version: ${prior.receipt?.schema_version ?? "absent"} -> ${EVIDENCE_WORK_NODE_SCHEMA}`];
    } else if (prior.receipt.run_id !== runId) {
      reason = "invalid.receipt_foreign_run";
      moved = [`run_id: ${prior.receipt.run_id} -> ${runId}`];
    } else if (prior.receipt.status !== "success") {
      reason = "invalid.receipt_not_success";
      moved = [`status: ${prior.receipt.status}`];
    } else if (prior.receipt.receipt_hash !== receiptBodyHash(prior.receipt)) {
      reason = "invalid.receipt_tampered";
    } else if (prior.receipt.recipe !== recipe) {
      reason = "miss.recipe_changed";
      moved = [`recipe: ${prior.receipt.recipe} -> ${recipe}`];
    } else if (prior.receipt.input_digest !== inputDigest) {
      // P6.2 made `explainMiss` live at stage granularity. The same function
      // names the component here, one level down.
      moved = explainMiss(prior.receipt.input_components, digest);
      reason =
        moved.length > 0 && moved.every((entry) => entry.startsWith("deps."))
          ? "miss.dependency_output_moved"
          : "miss.input_component_moved";
    } else {
      reason = "hit.inputs_unchanged";
    }

    // ENACTMENT. An opted-in node on a clean hit may replay its prior receipt
    // instead of re-running its action — but only past both gates: every
    // file-backed declared output must still exist, and the receipt must carry
    // a recorded value to serve. Anything less and the graph falls through and
    // does the work; a cache that cannot account for what it returns has not
    // earned the right to return it.
    if (
      ENACT_EVIDENCE_REUSE &&
      node.reuse_enactable === true &&
      reason === "hit.inputs_unchanged"
    ) {
      const outputFilesNow = await hashDeclaredPaths(declaredOutputs);
      const outputsPresent =
        Object.keys(outputFilesNow).length === 0 ||
        Object.values(outputFilesNow).every((fileHash) => fileHash !== "absent");
      if (outputsPresent && prior.receipt.recorded_value !== undefined) {
        timingsMs[id] = 0;
        outputDigests.set(id, prior.receipt.output_digest);
        nodeReceipts[id] = prior.receipt.receipt_hash;
        await record({
          node,
          reason,
          moved: [],
          detail: { reuse: "node_receipt_replayed" },
          durationMs: 0,
          priorOutputDigest: prior.receipt.output_digest,
          outputAgreed: null,
          executed: false,
          enactedReuse: true,
        });
        reusedNodes.push(id);
        return {
          ok: true,
          receipt: prior.receipt,
          reused: true,
          decision: "REUSED",
          reason,
          moved: [],
          output_digest: prior.receipt.output_digest,
          duration_ms: 0,
          value: prior.receipt.recorded_value,
        };
      }
      // No replayable receipt (legacy) or a declared artifact vanished: fall
      // through and recompute honestly.
    }

    // The action runs on every pass that reaches here: for non-enactable nodes
    // always, so a HIT is CHECKED rather than trusted; for enactable nodes on
    // any miss, invalid, or unplayable hit. See the module header.
    const started = process.hrtime.bigint();
    let value;
    try {
      value = attemptLedger
        ? (
            await attemptLedger.attempt(`evidence_work_node/${id}`, {
              inputDigest,
              action: () => action(path.join(graphDir, id)),
            })
          ).value
        : await action(path.join(graphDir, id));
    } catch (error) {
      await record({
        node,
        reason: "invalid.node_threw",
        moved,
        detail: { threw: String(error?.message ?? error) },
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
      throw error;
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    timingsMs[id] = durationMs;
    const { digest: outputDigest, hashable } = safeOutputDigest(value);
    const outputFiles = await hashDeclaredPaths(declaredOutputs);

    // MP2 E2 — THE ABSENCE GATE. The action has run; before anything may claim
    // success, every output path the call site declared as a real file must
    // exist. A success receipt is a claim about artifacts, and sealing one over
    // a file that was never written would poison every downstream key that
    // digests this node's outputs. So the node is sealed BLOCKED instead — same
    // body, honest status — the decision is recorded, the value digest is NOT
    // published to dependents (a missing artifact must not look like input for
    // the next node's key), and a typed error is thrown so the caller fails
    // loudly rather than building on nothing.
    const pathTargets = declaredPathTargets(declaredOutputs);
    const missingOutputs = await absentDeclaredPaths(pathTargets);
    if (missingOutputs.length > 0) {
      executedNodes.push(id);
      const blockedBody = {
        schema_version: EVIDENCE_WORK_NODE_SCHEMA,
        node: id,
        stage: node.stage,
        run_id: runId,
        controller_version: controllerVersion,
        recipe,
        status: "BLOCKED",
        blocker_class: "INTERNAL_WORK",
        key_components: [...node.key_components],
        invalidated_by: node.invalidated_by,
        depends_on: [...node.depends_on],
        input_components: digest,
        input_digest: inputDigest,
        output_names: [...node.outputs],
        output_paths: Object.fromEntries(pathTargets.map((entry) => [entry.name, entry.path])),
        output_files: outputFiles,
        output_digest: outputDigest,
        decision: "INVALID",
        reason: "invalid.declared_output_absent",
        moved: missingOutputs.map((entry) => `declared_output ${entry.name}: absent (${entry.path})`),
        missing_outputs: missingOutputs,
      };
      const blockedReceipt = { ...blockedBody, receipt_hash: hashValue(blockedBody) };
      await atomicWrite(receiptPath(id), `${canonicalJson(blockedReceipt)}\n`);
      nodeReceipts[id] = blockedReceipt.receipt_hash;
      await record({
        node,
        reason: "invalid.declared_output_absent",
        moved: blockedBody.moved,
        detail: { missing_outputs: missingOutputs },
        durationMs,
      });
      throw new EvidenceWorkOutputAbsentError(id, missingOutputs);
    }
    const outputPaths = Object.fromEntries(pathTargets.map((entry) => [entry.name, entry.path]));
    outputDigests.set(id, outputDigest);

    // P6.4: the prior recorded output digest, and whether this run's real
    // recomputation agreed with it, are recorded for EVERY executed node — not
    // only for the hit that disagreed. That is what lets a claim of stage reuse
    // be checked against a run that actually re-did the work.
    const priorOutputDigest =
      prior.state === "present" && typeof prior.receipt?.output_digest === "string"
        ? prior.receipt.output_digest
        : null;
    const outputAgreed =
      priorOutputDigest === null || !hashable ? null : priorOutputDigest === outputDigest;

    let detail = null;
    if (!hashable) {
      reason = "invalid.output_not_hashable";
    } else if (reason === "hit.inputs_unchanged" && prior.receipt.output_digest !== outputDigest) {
      // The key agreed and the output moved: the key is DISHONEST. Recorded,
      // never repaired, and the freshly computed value is returned unchanged.
      detail = {
        recorded_output_digest: prior.receipt.output_digest,
        recomputed_output_digest: outputDigest,
      };
      moved = [`output: ${String(prior.receipt.output_digest).slice(0, 12)} -> ${outputDigest.slice(0, 12)}`];
      reason = "invalid.output_digest_mismatch";
    }

    const decision = reasonDecision(reason);
    if (decision === "HIT") reusedNodes.push(id);
    else executedNodes.push(id);

    const body = {
      schema_version: EVIDENCE_WORK_NODE_SCHEMA,
      node: id,
      stage: node.stage,
      run_id: runId,
      controller_version: controllerVersion,
      recipe,
      status: "success",
      key_components: [...node.key_components],
      invalidated_by: node.invalidated_by,
      depends_on: [...node.depends_on],
      input_components: digest,
      input_digest: inputDigest,
      output_names: [...node.outputs],
      output_paths: outputPaths,
      output_files: outputFiles,
      output_digest: outputDigest,
      decision,
      reason,
    };
    // Enactment's enabler: an opted-in node seals WHAT its action produced into
    // the receipt body — inside `receipt_hash` like every other field — so a
    // later existence-verified clean hit can replay this exact value instead of
    // recomputing it. A value that cannot survive the round-trip records no
    // value, and a receipt without one is never replayed.
    if (ENACT_EVIDENCE_REUSE && node.reuse_enactable === true && hashable) {
      const recordedValue = safeRecordedValue(value);
      if (recordedValue !== undefined) body.recorded_value = recordedValue;
    }
    const receipt = { ...body, receipt_hash: hashValue(body) };
    await atomicWrite(receiptPath(id), `${canonicalJson(receipt)}\n`);
    nodeReceipts[id] = receipt.receipt_hash;
    const recorded = await record({
      node,
      reason,
      moved,
      detail,
      durationMs,
      priorOutputDigest,
      outputAgreed,
    });

    return {
      ok: true,
      receipt,
      reused: decision === "HIT",
      decision,
      reason,
      moved: recorded.moved,
      output_digest: outputDigest,
      duration_ms: durationMs,
      value,
    };
  }

  /**
   * A stage whose receipt was reused never enters its nodes' actions, so those
   * nodes record the stage-level hit instead. A node that already recorded a
   * decision for ITSELF this run is never overwritten — the finer reason wins.
   *
   * MP2 E2 — a stage-level hit is a claim about ARTIFACTS, not only about keys,
   * so before the hit is recorded each node's receipt is re-verified against
   * the filesystem: every output path its success receipt named must still
   * exist. An output that has vanished since refuses the hit — the node is
   * recorded INVALID at `invalid.declared_output_absent` (executed:false, the
   * action did not run; the CLAIM was false), it is excluded from the returned
   * reuse list, and it never reaches `reusedNodes`.
   */
  async function reuseStage(stageId) {
    const pending = nodes.filter((node) => node.stage === stageId && !decided.has(node.id));
    const verified = [];
    for (const node of pending) {
      const prior = await readReceipt(node.id);
      const recordedPaths = Object.entries(prior.receipt?.output_paths ?? {}).filter(
        ([, target]) => typeof target === "string",
      );
      const missingOutputs = await absentDeclaredPaths(
        recordedPaths.map(([name, target]) => ({ name, path: target })),
      );
      if (missingOutputs.length > 0) {
        decisions.push({
          node: node.id,
          stage: node.stage,
          recipe: node.recipe,
          decision: "INVALID",
          reason: "invalid.declared_output_absent",
          moved: missingOutputs.map((entry) => `declared_output ${entry.name}: absent (${entry.path})`),
          key_components: [...node.key_components],
          invalidated_by: node.invalidated_by,
          enacted_reuse: false,
          executed: false,
          prior_output_digest: null,
          output_agreed: null,
          duration_ms: 0,
          detail: { stage: stageId, missing_outputs: missingOutputs },
        });
        decided.add(node.id);
        continue;
      }
      decisions.push({
        node: node.id,
        stage: node.stage,
        recipe: node.recipe,
        decision: "HIT",
        reason: "hit.stage_receipt_reused",
        moved: [],
        key_components: [...node.key_components],
        invalidated_by: node.invalidated_by,
        enacted_reuse: true,
        executed: false,
        prior_output_digest: null,
        output_agreed: null,
        duration_ms: 0,
        detail: { stage: stageId },
      });
      decided.add(node.id);
      reusedNodes.push(node.id);
      verified.push(node.id);
    }
    if (pending.length > 0) await flush();
    return verified;
  }

  async function close() {
    await flush();
    return {
      schema_version: EVIDENCE_WORK_NODE_SCHEMA,
      run_id: runId,
      summary: summary(),
      reused: [...reusedNodes],
      executed: [...executedNodes],
      receipts: { ...nodeReceipts },
      timings_ms: { ...timingsMs },
    };
  }

  /**
   * P6.4 — seal the run's reuse CLAIM against what the graph recorded. This is
   * a validator: it computes the per-stage enactment ledger, persists it beside
   * the decisions it is derived from, and REPORTS violations. It repairs
   * nothing and it rewrites no decision. The controller decides what to do with
   * a dishonest claim; hiding one here would be the defect this exists to find.
   */
  async function sealReuseClaim(claimedStages) {
    const ledger = reuseClaimLedger(decisions, claimedStages, nodes);
    reuseClaim = {
      claimed_stages: [...(claimedStages ?? [])],
      stages: ledger.stages,
      violations: ledger.violations,
      enacted_stage_count: ledger.stages.filter((stage) => stage.mode === "enacted").length,
      work_performed_inside_claimed_reuse_ms: Number(
        ledger.stages
          .filter((stage) => stage.claimed)
          .reduce((total, stage) => total + stage.executed_ms, 0)
          .toFixed(3),
      ),
    };
    await flush();
    return reuseClaim;
  }

  return {
    runNode,
    reuseStage,
    sealReuseClaim,
    close,
    decisions: () => decisions.map((entry) => ({ ...entry })),
    summary,
    nodes: () => nodes.map((node) => ({ ...node })),
  };
}

// ---------------------------------------------------------------------------
// The documented stage-4 checkpoint count.
//
// SKILL.md and its two generated surfaces said "thirteen silent leaf
// checkpoints" and enumerated thirteen, against a real 14 top-level ids plus
// one render leaf per rendered sheet — `verify_ownership_physical` had been
// dropped from the prose. Nothing checked the claim, which is how it drifted.
// These two functions are that check; the suite runs them against the real
// orchestrator source and against all three instruction surfaces.
// ---------------------------------------------------------------------------

const NUMBER_WORDS = Object.freeze({
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
});

/**
 * The checkpoint names as the instruction prose spells them, keyed by the
 * orchestrator id they must account for. The prose is not the id list, so the
 * crosswalk is explicit rather than inferred.
 */
export const DOCUMENTED_CHECKPOINT_PHRASES = Object.freeze({
  semantic_gates: "semantic gates",
  plan: "plan",
  emit: "emit",
  recalculate: "LibreOffice recalculation",
  terminal_patch: "terminal patch",
  verify_ownership_physical: "forecast-ownership physical verification",
  verify_dynamic: "dynamic",
  verify_style: "style",
  verify_cache: "cache",
  verify_finance: "finance",
  verify_semantic: "semantic verification",
  verify_aggregate: "verification aggregation",
  render: "structural render",
  publish: "publication",
});

/**
 * Read stage 4's real checkpoint inventory out of the orchestrator source.
 *
 * A top-level checkpoint names its id with a string literal; the per-sheet
 * render leaf names it with a generated variable inside the sheet loop. The two
 * are counted separately, because the documented claim is "N top-level plus one
 * per rendered sheet" and a checker that conflated them could not tell a new
 * top-level checkpoint from another sheet.
 */
export function releaseCheckpointInventory(orchestratorSource) {
  const ids = [];
  let generated = 0;
  let leafGenerator = null;
  for (const match of String(orchestratorSource).matchAll(
    /checkpoint\(\{\s*\n\s*id:\s*(?:"([A-Za-z0-9_]+)"|([A-Za-z_$][A-Za-z0-9_$]*))/g,
  )) {
    if (match[1] !== undefined) ids.push(match[1]);
    else generated += 1;
  }
  const leafMatch = /function\s+(renderLeafId)\s*\(/.exec(String(orchestratorSource));
  if (leafMatch) leafGenerator = leafMatch[1];
  return {
    ids,
    top_level_count: ids.length,
    generated_leaf_sites: generated,
    leaf_generator: leafGenerator,
  };
}

/**
 * Validate one instruction surface's checkpoint-count sentence against the real
 * inventory. Returns violations; it never rewrites the prose.
 */
export function documentedCheckpointClaimViolations(instructionText, inventory) {
  const violations = [];
  const text = String(instructionText);
  const sentence = /The Build milestone has ([^.]+)\./.exec(text);
  if (!sentence) return ["no 'The Build milestone has ...' checkpoint sentence is present"];
  const claim = sentence[1].replace(/\s+/g, " ");
  const countMatch = /^([a-z]+) silent leaf checkpoints/.exec(claim);
  if (!countMatch) {
    violations.push(`the checkpoint sentence does not state a leaf-checkpoint count: ${claim}`);
    return violations;
  }
  const claimed = NUMBER_WORDS[countMatch[1]];
  if (claimed === undefined) {
    violations.push(`the checkpoint count '${countMatch[1]}' is not a recognised number word`);
  } else if (claimed !== inventory.top_level_count) {
    violations.push(
      `the documented count '${countMatch[1]}' (${claimed}) does not match the orchestrator's ${inventory.top_level_count} top-level checkpoints`,
    );
  }
  if (inventory.generated_leaf_sites > 0 && !/render leaf per rendered sheet/.test(claim)) {
    violations.push(
      "the sentence does not state the per-sheet render leaves the orchestrator generates (one render leaf per rendered sheet)",
    );
  }
  for (const id of inventory.ids) {
    const phrase = DOCUMENTED_CHECKPOINT_PHRASES[id];
    if (!phrase) {
      violations.push(`checkpoint ${id} has no documented phrase; the crosswalk is stale`);
      continue;
    }
    if (!claim.includes(phrase)) {
      violations.push(`the sentence does not name checkpoint ${id} ('${phrase}')`);
    }
  }
  return violations;
}
