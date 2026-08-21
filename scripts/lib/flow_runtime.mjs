import { canonicalise, hashValue } from "./run_store.mjs";
import {
  CHANGE_KEY_COMPONENTS,
  invalidatedNodesForChange,
  invalidatedStagesForChange,
} from "./evidence_work_graph.mjs";
import {
  assertWorkflowState,
  VISIBLE_JOURNEY_CONTRACT,
  WORKFLOW_STATE_CONTRACT,
} from "./workflow_state.mjs";

export const FLOW_SCHEMA_VERSION = "debt-user-flow/1.0";
export const FLOW_CONTROLLER_VERSION = "six-milestone/3.0";
/**
 * P6.2: the receipt schema is bumped to /1.1 because a receipt now DECLARES the
 * recipe that produced it. The migration rule is a refusal, not a translation:
 * a `user-stage-receipt/1.0` receipt is read (so a resume can say what it
 * found) but is never REUSED and never reinterpreted. It cannot be, honestly —
 * a /1.0 receipt does not record the code closure, the policy and contract
 * versions, or the input digest that produced it, so there is no evidence that
 * the recipe which wrote it is the recipe now asking to skip the stage. Filling
 * those fields in from the CURRENT run would fabricate exactly the agreement
 * the field exists to check.
 */
export const STAGE_RECEIPT_SCHEMA_VERSION = "user-stage-receipt/1.1";
export const STAGE_RECIPE_SCHEMA_VERSION = "user-stage-recipe/1.0";

/** Receipt schemas that may be READ and reported, but never reused. */
export const SUPERSEDED_STAGE_RECEIPT_SCHEMA_VERSIONS = Object.freeze([
  "user-stage-receipt/1.0",
]);

/**
 * Contract versions the CALLER must name in every recipe. The flow's own
 * schema, receipt schema, journey contract and workflow-state contract are
 * added by this module and cannot be overridden by the caller, so a recipe can
 * never understate the contracts it was compiled against.
 */
export const REQUIRED_STAGE_CONTRACT_VERSIONS = Object.freeze([
  "runtime_integrity_schema",
  "runtime_budget_policy_schema",
]);

export const VISIBLE_MILESTONES = Object.freeze(
  VISIBLE_JOURNEY_CONTRACT.milestones.map((item) => Object.freeze({ ...item })),
);

export const STAGES = Object.freeze([
  Object.freeze({
    number: 1,
    id: "inputs",
    title: "INPUTS",
    contact: "required",
    artifact: "intake-receipt.json",
  }),
  Object.freeze({
    number: 2,
    id: "evidence_review",
    title: "EVIDENCE REVIEW",
    contact: "none unless a genuine model decision survives",
    artifact: "broker-preview.json, evidence-run.json and case-source.json",
  }),
  Object.freeze({
    number: 3,
    id: "decisions",
    title: "DECISIONS",
    contact: "the only normal stop",
    artifact: "case-source.json answers and compiled model-case.json",
  }),
  Object.freeze({
    number: 4,
    id: "build_checks",
    title: "BUILD AND CHECKS",
    contact: "none",
    artifact: "workbook and validation package",
  }),
  Object.freeze({
    number: 5,
    id: "delivery",
    title: "DELIVERY",
    contact: "report",
    artifact: "delivery-receipt.json",
  }),
]);

export const SCREEN_CONTRACT = Object.freeze({
  // User screens remain ASCII by default.  Phase 3 admits exactly one
  // non-ASCII glyph: U+00B7 MIDDLE DOT in the visible, required runtime-mode
  // and fresh-session markers.  No other Unicode character is presentation
  // authority.
  ascii_only: false,
  allowed_non_ascii: Object.freeze(["·"]),
  width: 61,
  max_lines: 70,
  max_questions: 5,
  max_failure_remedies: 5,
  max_delivery_findings_per_section: 12,
});

const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));
const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_STATUSES = Object.freeze([
  "success",
  "action_required",
  "blocked",
  "failed",
]);

export function stageById(stageId) {
  return STAGE_BY_ID.get(stageId) ?? null;
}

export function nextStageId(stageId) {
  const stage = stageById(stageId);
  return stage && stage.number < STAGES.length
    ? STAGES[stage.number].id
    : null;
}

export function visibleJourneyProgress(stageId, status = "in progress") {
  const declaration = VISIBLE_JOURNEY_CONTRACT.checkpoints?.[stageId];
  if (!declaration) {
    throw new Error(`Visible journey has no checkpoint for ${stageId}`);
  }
  const normalisedStatus = String(status ?? "").trim().toLowerCase();
  const completedStage = normalisedStatus === "complete";
  let completed = Number(declaration.completed_milestones);
  let activeMilestone = declaration.active_milestone;
  let nextMilestone = declaration.next_milestone;
  if (completedStage && stageId === "build_checks") {
    completed = 5;
    activeMilestone = null;
    nextMilestone = "deliver";
  } else if (completedStage && stageId === "delivery") {
    completed = 6;
    activeMilestone = null;
    nextMilestone = null;
  }
  const next = VISIBLE_MILESTONES.find((item) => item.id === nextMilestone) ?? null;
  const active = VISIBLE_MILESTONES.find((item) => item.id === activeMilestone) ?? null;
  return Object.freeze({
    schema_version: VISIBLE_JOURNEY_CONTRACT.schema_version,
    checkpoint: declaration.label,
    completed,
    total: VISIBLE_MILESTONES.length,
    active_milestone: active?.id ?? null,
    active_label: active?.label ?? null,
    next_milestone: next?.id ?? null,
    next_label: next?.label ?? null,
  });
}

// The earliest user stage that must be rerun after a targeted change. These
// are user-flow stages, not internal graph nodes. Internal dependency hashes
// still decide which work inside the selected stage can be reused.
//
// P6.4 — THIS MAP WAS WRONG, AND HAD NO CALLER TO FIND OUT.
//
// It was a twelve-entry literal with zero callers anywhere in the repository.
// When it was finally checked against the evidence work graph P6.3 measured,
// EIGHT of the twelve entries disagreed, and every single one disagreed in the
// UNSAFE direction (`later_than_measured`): each named a LATER stage than the
// work actually keyed on the change, which is a licence to reuse work that the
// change has already invalidated. Only the four entries that could not be
// wrong — the two with no evidence-half node keyed on them, the ambient-code
// entry, and `company_name` — agreed.
//
//   source_file, filing, debt_export, broker_forecast, prior_case
//     said `evidence_review`. All five live inside the ONE evidence-run
//     envelope whose file hash is `evidence_validation`'s only declared key
//     component, and `evidence_validation` is a stage-`inputs` node. Measured:
//     adding a single key under `broker_pack` moves `files.evidence_run` and
//     misses `evidence_validation`. The truth is `inputs`.
//   user_answer said `build_checks`, a whole stage too late. Measured: changing
//     one answer misses exactly the eight `decisions` nodes — the answered case
//     recompile, the decision replay and the six compilations below them — and
//     nothing in `inputs` or `evidence_review`. The truth is `decisions`.
//   assumption and transaction_input said `build_checks` for the same reason
//     and are corrected the same way.
//
//
// The literal is kept — a declaration a human can read is worth having — but it
// is no longer TRUSTED: `changeInvalidationDisagreements()` recomputes every
// entry from the measured graph and is pinned at zero by the suite, so an entry
// can never again drift away from the work it is describing.
export const CHANGE_INVALIDATION = Object.freeze({
  company_name: "inputs",
  source_file: "inputs",
  filing: "inputs",
  debt_export: "inputs",
  broker_forecast: "inputs",
  prior_case: "inputs",
  user_answer: "decisions",
  assumption: "decisions",
  transaction_input: "decisions",
  formatting: "build_checks",
  delivery_wording: "delivery",
  controller_code: "inputs",
});

/**
 * The historical literal, kept so the suite can pin the disagreement it had
 * with the measured graph rather than merely asserting the corrected values.
 */
export const SUPERSEDED_CHANGE_INVALIDATION = Object.freeze({
  company_name: "inputs",
  source_file: "evidence_review",
  filing: "evidence_review",
  debt_export: "evidence_review",
  broker_forecast: "evidence_review",
  prior_case: "evidence_review",
  user_answer: "build_checks",
  assumption: "build_checks",
  transaction_input: "build_checks",
  formatting: "build_checks",
  delivery_wording: "delivery",
  controller_code: "inputs",
});

/**
 * The stage floor for a change no evidence-half node is keyed on. A change to
 * presentation or delivery wording invalidates nothing in the evidence half, so
 * the graph cannot answer for it and the declaration is the only answer there
 * is — which is exactly why it is confined to these two.
 */
export const NON_EVIDENCE_CHANGE_FLOOR = Object.freeze({
  formatting: "build_checks",
  delivery_wording: "delivery",
});

/**
 * The MEASURED earliest invalidated stage: which nodes the declared work graph
 * says fall when this change moves, and the earliest user stage those nodes
 * belong to. Computed, never asserted.
 */
export function measuredEarliestInvalidatedStage(change) {
  const stages = invalidatedStagesForChange(change);
  if (stages.length === 0) {
    const floor = NON_EVIDENCE_CHANGE_FLOOR[change];
    if (!floor) {
      throw new Error(
        `${change} invalidates no evidence work node and declares no non-evidence stage floor`,
      );
    }
    return stageById(floor);
  }
  let earliest = null;
  for (const stageId of stages) {
    const stage = stageById(stageId);
    if (!stage) throw new Error(`the work graph names a stage the flow does not declare: ${stageId}`);
    if (!earliest || stage.number < earliest.number) earliest = stage;
  }
  return earliest;
}

/**
 * Every entry whose declared stage does not equal the measured one, with the
 * direction named. `later_than_measured` is the dangerous direction: it permits
 * reuse of work a change has already invalidated.
 */
export function changeInvalidationDisagreements(declared = CHANGE_INVALIDATION) {
  const disagreements = [];
  for (const change of Object.keys(CHANGE_KEY_COMPONENTS)) {
    if (!Object.hasOwn(declared, change)) {
      disagreements.push({ change, declared: null, measured: null, direction: "undeclared" });
      continue;
    }
    const declaredStage = stageById(declared[change]);
    const measured = measuredEarliestInvalidatedStage(change);
    if (!declaredStage) {
      disagreements.push({ change, declared: declared[change], measured: measured.id, direction: "unknown_stage" });
      continue;
    }
    if (declaredStage.id === measured.id) continue;
    disagreements.push({
      change,
      declared: declaredStage.id,
      measured: measured.id,
      nodes: invalidatedNodesForChange(change),
      direction:
        declaredStage.number > measured.number ? "later_than_measured" : "earlier_than_measured",
    });
  }
  for (const change of Object.keys(declared)) {
    if (!Object.hasOwn(CHANGE_KEY_COMPONENTS, change)) {
      disagreements.push({ change, declared: declared[change], measured: null, direction: "no_measured_components" });
    }
  }
  return disagreements;
}

export function earliestInvalidatedStage(changes) {
  const list = Array.isArray(changes) ? changes : [changes];
  if (list.length === 0) return null;
  let earliest = null;
  for (const change of list) {
    const stageId = CHANGE_INVALIDATION[change];
    if (!stageId) throw new Error(`Unknown user-flow change type: ${change}`);
    const stage = stageById(stageId);
    if (!earliest || stage.number < earliest.number) earliest = stage;
  }
  return earliest;
}

function assertHashMap(label, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object of sha256 hashes`);
  }
  for (const [key, hash] of Object.entries(value)) {
    if (!key || !SHA256.test(String(hash))) {
      throw new Error(`${label}.${key || "<empty>"} is not a sha256 hash`);
    }
  }
}

function receiptBody(receipt) {
  const { receipt_hash: _ignored, ...body } = receipt;
  return canonicalise(body);
}

/**
 * THE recipe of a user stage: the versioned identity of everything that decides
 * what the stage produces.
 *
 *  - `code_closure_sha256` — the digest of the DERIVED executable closure the
 *    stage ran (see deriveStageRuntimeClosure in user_flow_controller.mjs). Not
 *    a hand-maintained list of files somebody believed the stage touched.
 *  - `policy_versions` — the contract and policy versions the stage read.
 *  - `input_digest` — the digest of the stage's own input hashes.
 *
 * The recipe hash therefore moves when the code moves, when a contract version
 * moves, or when an input moves; and a receipt whose recipe hash differs from
 * the active recipe is refused for reuse. `explainMiss` (run_store.mjs) can then
 * say WHICH of the three moved, which is the difference between a miss that is
 * explained and a miss that is merely observed.
 */
export function createStageRecipe({
  stageId,
  codeClosureSha256,
  codeClosureMemberCount,
  contractVersions,
  inputHashes,
  controllerVersion = FLOW_CONTROLLER_VERSION,
}) {
  const stage = stageById(stageId);
  if (!stage) throw new Error(`Unknown user-flow stage: ${stageId}`);
  if (!SHA256.test(String(codeClosureSha256))) {
    throw new Error(
      `Stage recipe for ${stage.id} requires a sha256 executable-closure identity`,
    );
  }
  if (!Number.isInteger(codeClosureMemberCount) || codeClosureMemberCount <= 0) {
    throw new Error(
      `Stage recipe for ${stage.id} requires a positive closure member count`,
    );
  }
  assertHashMap(`recipe(${stage.id}).input_hashes`, inputHashes);
  if (
    !contractVersions ||
    typeof contractVersions !== "object" ||
    Array.isArray(contractVersions)
  ) {
    throw new Error(`Stage recipe for ${stage.id} requires declared contract versions`);
  }
  for (const key of REQUIRED_STAGE_CONTRACT_VERSIONS) {
    if (typeof contractVersions[key] !== "string" || contractVersions[key].trim() === "") {
      throw new Error(
        `Stage recipe for ${stage.id} does not declare the ${key} contract version`,
      );
    }
  }
  const body = {
    schema_version: STAGE_RECIPE_SCHEMA_VERSION,
    stage_id: stage.id,
    controller_version: controllerVersion,
    code_closure_sha256: codeClosureSha256,
    code_closure_member_count: codeClosureMemberCount,
    // Caller-declared versions first, then the versions this module owns, so a
    // caller cannot shadow the flow's own contract identities.
    policy_versions: canonicalise({
      ...contractVersions,
      flow_schema: FLOW_SCHEMA_VERSION,
      stage_receipt_schema: STAGE_RECEIPT_SCHEMA_VERSION,
      visible_journey_contract: VISIBLE_JOURNEY_CONTRACT.schema_version,
      workflow_state_contract: WORKFLOW_STATE_CONTRACT.schema_version,
    }),
    input_digest: hashValue(inputHashes),
  };
  return Object.freeze({ ...body, recipe_sha256: hashValue(body) });
}

/**
 * Validate a recipe read off a receipt. Returns the reasons it may not be
 * trusted; an empty array means the recipe is self-consistent AND (when
 * `expectedRecipeSha256` is supplied) is the recipe now asking to reuse it.
 */
export function verifyStageRecipe(
  recipe,
  {
    stageId = null,
    controllerVersion = FLOW_CONTROLLER_VERSION,
    inputHashes = undefined,
    expectedRecipeSha256 = undefined,
  } = {},
) {
  if (recipe === null || recipe === undefined) {
    return [
      "receipt declares no recipe: a receipt that cannot name the recipe that produced it is never reusable",
    ];
  }
  if (typeof recipe !== "object" || Array.isArray(recipe)) {
    return ["receipt recipe is not an object"];
  }
  const errors = [];
  if (recipe.schema_version !== STAGE_RECIPE_SCHEMA_VERSION) {
    errors.push(
      `recipe schema ${recipe.schema_version} is not ${STAGE_RECIPE_SCHEMA_VERSION}`,
    );
  }
  if (stageId !== null && recipe.stage_id !== stageId) {
    errors.push("recipe stage id does not match the receipt stage");
  }
  if (recipe.controller_version !== controllerVersion) {
    errors.push("recipe controller version does not match");
  }
  if (!SHA256.test(String(recipe.code_closure_sha256))) {
    errors.push("recipe executable-closure identity is not a sha256 hash");
  }
  if (
    !Number.isInteger(recipe.code_closure_member_count) ||
    recipe.code_closure_member_count <= 0
  ) {
    errors.push("recipe closure member count is not a positive integer");
  }
  if (
    !recipe.policy_versions ||
    typeof recipe.policy_versions !== "object" ||
    Array.isArray(recipe.policy_versions)
  ) {
    errors.push("recipe declares no policy versions");
  } else {
    for (const key of REQUIRED_STAGE_CONTRACT_VERSIONS) {
      if (typeof recipe.policy_versions[key] !== "string") {
        errors.push(`recipe policy versions omit ${key}`);
      }
    }
  }
  if (inputHashes !== undefined && recipe.input_digest !== hashValue(inputHashes)) {
    errors.push("recipe input digest does not cover the receipt input hashes");
  }
  const { recipe_sha256: _ignored, ...body } = recipe;
  if (recipe.recipe_sha256 !== hashValue(body)) {
    errors.push("recipe hash does not match its own body");
  }
  if (
    expectedRecipeSha256 !== undefined &&
    recipe.recipe_sha256 !== expectedRecipeSha256
  ) {
    errors.push(
      `recipe ${String(recipe.recipe_sha256).slice(0, 12)} is not the active recipe ${String(expectedRecipeSha256).slice(0, 12)}`,
    );
  }
  return errors;
}

export function createStageReceipt({
  runId,
  stageId,
  status,
  inputHashes,
  outputHashes,
  previousReceiptHash = null,
  controllerVersion = FLOW_CONTROLLER_VERSION,
  detail = null,
  recipe = null,
}) {
  const stage = stageById(stageId);
  if (!stage) throw new Error(`Unknown user-flow stage: ${stageId}`);
  if (!runId || typeof runId !== "string") throw new Error("runId is required");
  if (!RECEIPT_STATUSES.includes(status)) {
    throw new Error(`Unsupported stage receipt status: ${status}`);
  }
  assertWorkflowState("stage_receipt", { status, stage: stage.id });
  assertHashMap("input_hashes", inputHashes);
  assertHashMap("output_hashes", outputHashes);
  if (previousReceiptHash !== null && !SHA256.test(previousReceiptHash)) {
    throw new Error("previousReceiptHash is not a sha256 hash");
  }
  // A supplied recipe is validated here: a receipt may declare no recipe (and
  // is then permanently unreusable), but it may never declare a WRONG one.
  if (recipe !== null && recipe !== undefined) {
    const recipeErrors = verifyStageRecipe(recipe, {
      stageId: stage.id,
      controllerVersion,
      inputHashes,
    });
    if (recipeErrors.length > 0) {
      throw new Error(
        `Stage receipt for ${stage.id} was handed an invalid recipe: ${recipeErrors[0]}`,
      );
    }
  }
  const receipt = {
    schema_version: STAGE_RECEIPT_SCHEMA_VERSION,
    flow_version: FLOW_SCHEMA_VERSION,
    controller_version: controllerVersion,
    recipe: recipe === undefined ? null : recipe,
    run_id: runId,
    stage_id: stage.id,
    stage_number: stage.number,
    status,
    input_hashes: canonicalise(inputHashes),
    output_hashes: canonicalise(outputHashes),
    previous_receipt_hash: previousReceiptHash,
    next_stage:
      status === "success"
        ? nextStageId(stage.id)
        : ["action_required", "blocked"].includes(status)
          ? stage.id
          : null,
    detail,
  };
  return Object.freeze({ ...receipt, receipt_hash: hashValue(receipt) });
}

export function verifyStageReceipt(
  receipt,
  {
    runId = null,
    stageId = null,
    controllerVersion = FLOW_CONTROLLER_VERSION,
    previousReceiptHash = undefined,
    inputHashes = undefined,
    outputHashes = undefined,
    recipe = undefined,
  } = {},
) {
  const errors = [];
  // Reasons a receipt may not be REUSED, kept apart from the reasons it is not
  // a valid record. Every reuse reason is additive: this function can only ever
  // refuse more receipts than it did before recipes existed, never fewer.
  const reuseErrors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, resumable: false, errors: ["receipt is not an object"] };
  }
  if (receipt.schema_version !== STAGE_RECEIPT_SCHEMA_VERSION) {
    errors.push(
      SUPERSEDED_STAGE_RECEIPT_SCHEMA_VERSIONS.includes(receipt.schema_version)
        ? `receipt schema ${receipt.schema_version} is superseded by ${STAGE_RECEIPT_SCHEMA_VERSION}: a receipt written before stage recipes existed is refused for reuse, never reinterpreted`
        : "receipt schema version does not match",
    );
  }
  if (receipt.flow_version !== FLOW_SCHEMA_VERSION) {
    errors.push("flow version does not match");
  }
  if (receipt.controller_version !== controllerVersion) {
    errors.push("controller version does not match");
  }
  if (runId !== null && receipt.run_id !== runId) errors.push("run id does not match");
  if (stageId !== null && receipt.stage_id !== stageId) {
    errors.push("stage id does not match");
  }
  const stage = stageById(receipt.stage_id);
  if (!stage || receipt.stage_number !== stage.number) {
    errors.push("stage number does not match stage id");
  }
  if (!RECEIPT_STATUSES.includes(receipt.status)) {
    errors.push("receipt status is invalid");
  } else {
    try {
      assertWorkflowState("stage_receipt", {
        status: receipt.status,
        stage: receipt.stage_id,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  try {
    assertHashMap("input_hashes", receipt.input_hashes);
    assertHashMap("output_hashes", receipt.output_hashes);
  } catch (error) {
    errors.push(error.message);
  }
  if (
    inputHashes !== undefined &&
    hashValue(receipt.input_hashes ?? {}) !== hashValue(inputHashes)
  ) {
    errors.push("input hashes do not match");
  }
  if (
    outputHashes !== undefined &&
    hashValue(receipt.output_hashes ?? {}) !== hashValue(outputHashes)
  ) {
    errors.push("output hashes do not match");
  }
  if (
    previousReceiptHash !== undefined &&
    receipt.previous_receipt_hash !== previousReceiptHash
  ) {
    errors.push("previous receipt hash does not match");
  }
  if (
    receipt.previous_receipt_hash !== null &&
    !SHA256.test(String(receipt.previous_receipt_hash))
  ) {
    errors.push("previous receipt hash is invalid");
  }
  const expectedNext =
    receipt.status === "success"
      ? nextStageId(receipt.stage_id)
      : ["action_required", "blocked"].includes(receipt.status)
        ? receipt.stage_id
        : null;
  if (receipt.next_stage !== expectedNext) errors.push("next stage is invalid");
  const expectedHash = hashValue(receiptBody(receipt));
  if (receipt.receipt_hash !== expectedHash) errors.push("receipt hash does not match");
  reuseErrors.push(
    ...verifyStageRecipe(receipt.recipe, {
      stageId: receipt.stage_id,
      controllerVersion,
      inputHashes: receipt.input_hashes,
      expectedRecipeSha256:
        recipe === undefined ? undefined : recipe?.recipe_sha256 ?? null,
    }),
  );
  return {
    ok: errors.length === 0,
    resumable:
      errors.length === 0 && reuseErrors.length === 0 && receipt.status === "success",
    errors: [...errors, ...reuseErrors],
  };
}
