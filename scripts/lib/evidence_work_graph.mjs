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
 * WHAT THIS GRAPH DOES NOT DO, AND WHY
 * ------------------------------------
 * It does not ENACT reuse. `ENACT_EVIDENCE_REUSE = false`: a node's action runs
 * on every pass, and a HIT means "the cache key agreed", not "the work was
 * skipped". Two reasons, and the second is the stronger one:
 *
 *  1. Skipping upstream work changes WHAT IS COMPUTED. P6.3 is additive by
 *     constitution — no run's outcome or emitted number may change. Hoisting
 *     the evidence-half work behind its cache keys is differential invalidation,
 *     which is P6.4's package, sequenced after this one precisely because it
 *     changes behaviour.
 *  2. Because the action always runs, every HIT is CHECKED against a real
 *     recomputation: the freshly computed output is digested and compared with
 *     the digest the receipt recorded. A cache key that agreed while the output
 *     moved is a DISHONEST key, and it is recorded as
 *     `invalid.output_digest_mismatch`. An enacting cache cannot notice that at
 *     all — it would silently serve the stale answer. This graph therefore
 *     spends the work to earn the right to skip it later, and P6.4 inherits
 *     cache keys whose honesty has been measured rather than assumed.
 *
 * A validator validates. Nothing here repairs a receipt, rewrites a key, or
 * changes a value the controller computed. A node that throws is RECORDED and
 * then RETHROWN unchanged.
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
 * P6.3 does not enact reuse; see the header. The suite pins this constant, so
 * flipping it is a deliberate, reviewed behaviour change and not a drift.
 */
export const ENACT_EVIDENCE_REUSE = false;

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
  "invalid.node_threw",
]);

const DECISION_OF_REASON = Object.freeze({
  hit: "HIT",
  miss: "MISS",
  invalid: "INVALID",
});

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
        decisions,
      })}\n`,
    );
  }

  async function record({ node, reason, moved = [], detail = null, durationMs = null }) {
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
      enacted_reuse: false,
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

    // ENACT_EVIDENCE_REUSE is false: the action runs on every pass, so a HIT is
    // CHECKED rather than trusted. See the module header.
    const started = process.hrtime.bigint();
    let value;
    try {
      value = await action(path.join(graphDir, id));
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
    outputDigests.set(id, outputDigest);

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
      output_files: outputFiles,
      output_digest: outputDigest,
      decision,
      reason,
    };
    const receipt = { ...body, receipt_hash: hashValue(body) };
    await atomicWrite(receiptPath(id), `${canonicalJson(receipt)}\n`);
    nodeReceipts[id] = receipt.receipt_hash;
    const recorded = await record({ node, reason, moved, detail, durationMs });

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
   */
  async function reuseStage(stageId) {
    const pending = nodes.filter((node) => node.stage === stageId && !decided.has(node.id));
    for (const node of pending) {
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
        duration_ms: 0,
        detail: { stage: stageId },
      });
      decided.add(node.id);
      reusedNodes.push(node.id);
    }
    if (pending.length > 0) await flush();
    return pending.map((node) => node.id);
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

  return {
    runNode,
    reuseStage,
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
