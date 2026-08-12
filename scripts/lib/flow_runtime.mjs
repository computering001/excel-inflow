import { canonicalise, hashValue } from "./run_store.mjs";
import { assertWorkflowState } from "./workflow_state.mjs";

export const FLOW_SCHEMA_VERSION = "debt-user-flow/1.0";
export const FLOW_CONTROLLER_VERSION = "five-stage/2.2";
export const STAGE_RECEIPT_SCHEMA_VERSION = "user-stage-receipt/1.0";

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
    contact: "none unless the pack is defective",
    artifact: "evidence-run.json and case-source.json",
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
  ascii_only: true,
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

// The earliest user stage that must be rerun after a targeted change. These
// are user-flow stages, not internal graph nodes. Internal dependency hashes
// still decide which work inside the selected stage can be reused.
export const CHANGE_INVALIDATION = Object.freeze({
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

export function createStageReceipt({
  runId,
  stageId,
  status,
  inputHashes,
  outputHashes,
  previousReceiptHash = null,
  controllerVersion = FLOW_CONTROLLER_VERSION,
  detail = null,
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
  const receipt = {
    schema_version: STAGE_RECEIPT_SCHEMA_VERSION,
    flow_version: FLOW_SCHEMA_VERSION,
    controller_version: controllerVersion,
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
  } = {},
) {
  const errors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, resumable: false, errors: ["receipt is not an object"] };
  }
  if (receipt.schema_version !== STAGE_RECEIPT_SCHEMA_VERSION) {
    errors.push("receipt schema version does not match");
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
  return {
    ok: errors.length === 0,
    resumable: errors.length === 0 && receipt.status === "success",
    errors,
  };
}
