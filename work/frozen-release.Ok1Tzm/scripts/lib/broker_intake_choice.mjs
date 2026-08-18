import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const BROKER_SKIP_PHRASE = "continue without brokers";
export const BROKER_INTAKE_SCHEMA = "broker-intake-choice/1.0";

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-z0-9][a-z0-9_.-]*$/;

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
  }
  return value;
}

export function canonicalBrokerIntakeJson(value) {
  return `${JSON.stringify(canonicalise(value))}\n`;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target) {
  return sha256Bytes(await fs.readFile(target));
}

function receiptBody(receipt) {
  const { receipt_sha256: _ignored, ...body } = receipt;
  return body;
}

function normaliseIssuerIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("issuer_identity must be an object");
  }
  const name = String(value.name ?? "").trim();
  if (!name) throw new Error("issuer_identity.name is required");
  return {
    name,
    lei: value.lei == null ? null : String(value.lei).trim() || null,
    ticker: value.ticker == null ? null : String(value.ticker).trim() || null,
  };
}

export async function materialiseBrokerAttachments(attachments = [], baseDirectory = process.cwd()) {
  if (!Array.isArray(attachments)) throw new Error("attachments must be an array");
  if (attachments.length > 10) throw new Error("At most 10 broker reports may be supplied.");
  const output = [];
  const ids = new Set();
  const hashes = new Set();
  for (const declaration of attachments) {
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
      throw new Error("Each broker attachment declaration must be an object.");
    }
    const attachmentId = String(declaration.attachment_id ?? "").trim();
    if (!RUN_ID.test(attachmentId)) throw new Error(`Invalid broker attachment id: ${attachmentId}`);
    if (ids.has(attachmentId)) throw new Error(`Duplicate broker attachment id: ${attachmentId}`);
    ids.add(attachmentId);
    const sourcePath = path.resolve(baseDirectory, String(declaration.path ?? ""));
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size < 1) throw new Error(`Broker attachment is not a non-empty file: ${sourcePath}`);
    const sha256 = await sha256File(sourcePath);
    if (declaration.expected_sha256 && declaration.expected_sha256 !== sha256) {
      throw new Error(`Broker attachment hash does not match for ${attachmentId}.`);
    }
    if (hashes.has(sha256)) throw new Error(`Duplicate broker bytes supplied as another attachment: ${attachmentId}`);
    hashes.add(sha256);
    output.push({
      attachment_id: attachmentId,
      file_name: String(declaration.file_name ?? path.basename(sourcePath)),
      media_type: String(declaration.media_type ?? "application/pdf"),
      byte_length: stat.size,
      sha256,
    });
  }
  return output.sort((left, right) => left.attachment_id.localeCompare(right.attachment_id));
}

export async function brokerIntakeRuntimeClosure(skillRoot) {
  const manifestPath = path.join(skillRoot, "assets", "attachment-evidence-runtime-members.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schema_version !== "attachment-evidence-runtime-members/1.0") {
    throw new Error("Attachment evidence runtime manifest has the wrong schema version.");
  }
  const hashes = {};
  async function addMember(relative) {
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split("/").includes("..")) {
      throw new Error(`Invalid attachment runtime member: ${relative}`);
    }
    hashes[relative] = await sha256File(path.join(skillRoot, relative));
  }
  for (const relative of manifest.members ?? []) await addMember(relative);
  for (const nestedRelative of manifest.runtime_manifests ?? []) {
    await addMember(nestedRelative);
    const nested = JSON.parse(await fs.readFile(path.join(skillRoot, nestedRelative), "utf8"));
    for (const relative of nested.members ?? []) await addMember(relative);
  }
  return sha256Bytes(canonicalBrokerIntakeJson(hashes));
}

export function verifyBrokerIntakeChoice(receipt, expected = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, errors: ["choice receipt is not an object"] };
  }
  if (receipt.schema_version !== BROKER_INTAKE_SCHEMA) errors.push("choice receipt schema does not match");
  if (!RUN_ID.test(String(receipt.run_id ?? ""))) errors.push("choice receipt run_id is invalid");
  let issuer;
  try {
    issuer = normaliseIssuerIdentity(receipt.issuer_identity);
  } catch (error) {
    errors.push(error.message);
  }
  if (issuer && receipt.issuer_identity_sha256 !== sha256Bytes(canonicalBrokerIntakeJson(issuer))) {
    errors.push("issuer identity hash does not match");
  }
  if (!SHA256.test(String(receipt.filings_receipt_sha256 ?? ""))) errors.push("filings receipt hash is invalid");
  if (!SHA256.test(String(receipt.runtime_closure_sha256 ?? ""))) errors.push("runtime closure hash is invalid");
  if (!Number.isFinite(Date.parse(String(receipt.recorded_at ?? "")))) errors.push("recorded_at is not RFC3339-compatible");
  if (!Array.isArray(receipt.attachments)) errors.push("attachments is not an array");
  const attachmentCount = Array.isArray(receipt.attachments) ? receipt.attachments.length : 0;
  if (receipt.intake_state === "supplied") {
    if (receipt.choice !== "use_supplied_brokers" || receipt.choice_phrase !== null) errors.push("supplied choice fields disagree");
    if (attachmentCount < 1 || attachmentCount > 10) errors.push("supplied choice must bind 1-10 attachments");
    if (receipt.processing_state !== "not_started" || receipt.authority_state !== "not_resolved") errors.push("supplied state dimensions disagree");
  } else if (receipt.intake_state === "explicitly_skipped") {
    if (receipt.choice !== "continue_without_brokers" || receipt.choice_phrase !== BROKER_SKIP_PHRASE) errors.push("skip choice fields disagree");
    if (attachmentCount !== 0) errors.push("skip choice cannot bind attachments");
    if (receipt.processing_state !== "not_started" || receipt.authority_state !== "zero") errors.push("skip state dimensions disagree");
  } else {
    errors.push("intake_state is invalid");
  }
  for (const item of receipt.attachments ?? []) {
    if (!RUN_ID.test(String(item?.attachment_id ?? ""))) errors.push("attachment id is invalid");
    if (!SHA256.test(String(item?.sha256 ?? ""))) errors.push("attachment hash is invalid");
    if (!Number.isInteger(item?.byte_length) || item.byte_length < 1) errors.push("attachment byte length is invalid");
  }
  const calculated = sha256Bytes(canonicalBrokerIntakeJson(receiptBody(receipt)));
  if (receipt.receipt_sha256 !== calculated) errors.push("choice receipt self-hash does not match");
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && value !== null && receipt[field] !== value) errors.push(`${field} does not match expected value`);
  }
  return { valid: errors.length === 0, errors, receipt };
}

export async function compileBrokerIntakeChoice(
  request,
  { baseDirectory = process.cwd(), runtimeClosureSha256 = null } = {},
) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Broker intake request must be an object.");
  if (request.schema_version !== "broker-intake-request/1.0") throw new Error("Broker intake request schema does not match.");
  const runId = String(request.run_id ?? "").trim();
  if (!RUN_ID.test(runId)) throw new Error("Broker intake request run_id is invalid.");
  const issuerIdentity = normaliseIssuerIdentity(request.issuer_identity);
  const filingsReceiptPath = path.resolve(baseDirectory, String(request.filings_receipt_path ?? ""));
  const filingsReceiptSha256 = await sha256File(filingsReceiptPath);
  const runtimeClosure = runtimeClosureSha256 ?? request.runtime_closure_sha256;
  if (!SHA256.test(String(runtimeClosure ?? ""))) throw new Error("Broker intake request runtime closure hash is invalid.");
  if (
    request.runtime_closure_sha256 !== undefined &&
    runtimeClosureSha256 !== null &&
    request.runtime_closure_sha256 !== runtimeClosureSha256
  ) {
    throw new Error("Broker intake request runtime closure does not match the installed controller.");
  }
  const attachments = await materialiseBrokerAttachments(request.attachments ?? [], baseDirectory);
  const reply = String(request.reply ?? "").trim();
  if (attachments.length > 0 && reply) {
    throw new Error("Do not combine broker attachments with a skip reply in one checkpoint.");
  }
  if (attachments.length === 0 && reply !== BROKER_SKIP_PHRASE) {
    return {
      status: "ACTION_REQUIRED",
      blocker_class: "USER_DECISION",
      user_blocking: true,
      intake_state: "awaiting_choice",
      processing_state: "not_started",
      authority_state: "not_resolved",
      choice_receipt: null,
    };
  }
  const skipped = attachments.length === 0;
  const body = {
    schema_version: BROKER_INTAKE_SCHEMA,
    run_id: runId,
    issuer_identity: issuerIdentity,
    issuer_identity_sha256: sha256Bytes(canonicalBrokerIntakeJson(issuerIdentity)),
    intake_state: skipped ? "explicitly_skipped" : "supplied",
    processing_state: "not_started",
    authority_state: skipped ? "zero" : "not_resolved",
    choice: skipped ? "continue_without_brokers" : "use_supplied_brokers",
    choice_phrase: skipped ? BROKER_SKIP_PHRASE : null,
    attachments,
    filings_receipt_sha256: filingsReceiptSha256,
    runtime_closure_sha256: runtimeClosure,
    recorded_at: String(request.recorded_at ?? new Date().toISOString()),
  };
  const choiceReceipt = { ...body, receipt_sha256: sha256Bytes(canonicalBrokerIntakeJson(body)) };
  const verified = verifyBrokerIntakeChoice(choiceReceipt);
  if (!verified.valid) throw new Error(`Compiled broker intake receipt is invalid: ${verified.errors[0]}`);
  return {
    status: "COMPLETE",
    blocker_class: null,
    user_blocking: false,
    intake_state: choiceReceipt.intake_state,
    processing_state: choiceReceipt.processing_state,
    authority_state: choiceReceipt.authority_state,
    choice_receipt: choiceReceipt,
  };
}
