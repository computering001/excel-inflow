import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  atomicWriteJson,
  atomicWriteText,
  canonicalPathThroughExistingAncestor,
  initializeOrVerifyRunIdentity,
  normaliseIssuerIdentity,
  validateRunId,
} from "./runtime_isolation.mjs";

export const RUN_CARRIER_SCHEMA = "debt-model-run-carrier/2.0";
export const RUN_CARRIER_FILE = "run-carrier.json";

const SHA256 = /^[a-f0-9]{64}$/;
const STAGES = Object.freeze(["inputs", "evidence_review", "decisions", "build_checks", "delivery"]);

function canonicalise(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalise(value), null, 2);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target) {
  return sha256Bytes(await fs.readFile(target));
}

function carrierBody(carrier) {
  const { carrier_hash: _ignored, ...body } = carrier;
  return body;
}

function isEqualToOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireToken(workspaceToken) {
  if (typeof workspaceToken !== "string" || workspaceToken.trim() === "") {
    throw new Error("A non-empty workspace/session token is required for a run carrier.");
  }
  return workspaceToken.trim();
}

async function requireRegularFile(target, label) {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file.`);
}

function relativeDescriptor(runRoot, target, sha256) {
  const relative = path.relative(runRoot, target).split(path.sep).join("/");
  if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Carrier member is outside the canonical run root: ${target}`);
  }
  return { path: relative, sha256 };
}

async function addExistingFile(files, name, runRoot, target, { required = false } = {}) {
  try {
    await requireRegularFile(target, name);
  } catch (error) {
    if (!required && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return;
    throw error;
  }
  files[name] = relativeDescriptor(runRoot, target, await sha256File(target));
}

async function snapshotFile(source, target) {
  await atomicWriteText(target, await fs.readFile(source, "utf8"));
  return target;
}

/**
 * Create a compact, hash-bound handoff. The carrier references only files
 * beneath the canonical run root; evidence and answers are snapshotted there
 * before they are named. Existing receipts remain the authority for whether a
 * stage is reusable.
 */
export async function writeRunCarrier({
  skillRoot,
  runRoot,
  runId,
  controllerVersion,
  workspaceToken,
  issuerIdentity,
  evidencePath,
  answersPath = null,
  brokerIntakeChoicePath = null,
  brokerConfirmationPath = null,
  status,
  artifacts = {},
}) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  const token = requireToken(workspaceToken);
  const identity = await initializeOrVerifyRunIdentity({
    skillRoot,
    runRoot: canonicalRunRoot,
    runId,
    controllerVersion,
    workspaceToken: token,
    issuerIdentity,
  });
  const snapshotDirectory = path.join(canonicalRunRoot, "carrier");
  await fs.mkdir(snapshotDirectory, { recursive: true });
  const canonicalEvidence = await canonicalPathThroughExistingAncestor(evidencePath);
  const evidenceSnapshot = isEqualToOrInside(canonicalEvidence, canonicalRunRoot)
    ? canonicalEvidence
    : await snapshotFile(evidencePath, path.join(snapshotDirectory, "evidence-run.json"));
  let answersSnapshot = null;
  if (answersPath) {
    const extension = path.extname(answersPath).toLowerCase() === ".json" ? ".json" : ".txt";
    answersSnapshot = await snapshotFile(answersPath, path.join(snapshotDirectory, `answers${extension}`));
  }
  let brokerConfirmationSnapshot = null;
  let brokerIntakeChoiceSnapshot = null;
  if (brokerIntakeChoicePath) {
    brokerIntakeChoiceSnapshot = await snapshotFile(
      brokerIntakeChoicePath,
      path.join(snapshotDirectory, "broker-intake-choice.json"),
    );
  }
  if (brokerConfirmationPath) {
    brokerConfirmationSnapshot = await snapshotFile(
      brokerConfirmationPath,
      path.join(snapshotDirectory, "broker-confirmation.json"),
    );
  }

  const files = {};
  await addExistingFile(files, "run_identity", canonicalRunRoot, identity.path);
  await addExistingFile(files, "evidence_run", canonicalRunRoot, evidenceSnapshot);
  if (answersSnapshot) await addExistingFile(files, "answers", canonicalRunRoot, answersSnapshot);
  if (brokerIntakeChoiceSnapshot) {
    await addExistingFile(
      files,
      "broker_intake_choice",
      canonicalRunRoot,
      brokerIntakeChoiceSnapshot,
    );
  }
  if (brokerConfirmationSnapshot) {
    await addExistingFile(
      files,
      "broker_confirmation",
      canonicalRunRoot,
      brokerConfirmationSnapshot,
    );
  }
  await addExistingFile(
    files,
    "model_case",
    canonicalRunRoot,
    path.join(canonicalRunRoot, "stages", "decisions", "model-case.json"),
  );
  await addExistingFile(
    files,
    "case_source",
    canonicalRunRoot,
    path.join(canonicalRunRoot, "stages", "decisions", "case-source.json"),
  );
  await addExistingFile(
    files,
    "case_compile_report",
    canonicalRunRoot,
    path.join(canonicalRunRoot, "stages", "decisions", "case-compile-report.json"),
  );
  for (const stage of STAGES) {
    await addExistingFile(
      files,
      `receipt_${stage}`,
      canonicalRunRoot,
      path.join(canonicalRunRoot, "stages", stage, "_receipt.json"),
    );
  }
  for (const [name, target] of Object.entries(artifacts).sort()) {
    if (typeof target !== "string") throw new Error(`Carrier artifact ${name} path must be a string.`);
    const canonical = await canonicalPathThroughExistingAncestor(target);
    if (!isEqualToOrInside(canonical, canonicalRunRoot) || canonical === canonicalRunRoot) {
      throw new Error(`Carrier artifact ${name} is outside the canonical run root.`);
    }
    await addExistingFile(files, name, canonicalRunRoot, canonical, { required: true });
  }

  const normalisedIssuer = normaliseIssuerIdentity(issuerIdentity);
  const body = {
    schema_version: RUN_CARRIER_SCHEMA,
    run_id: validateRunId(runId),
    controller_version: controllerVersion,
    status: String(status ?? "RESUMABLE"),
    experience_trace_id: process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_ID ?? null,
    workspace_session_token_hash: sha256Bytes(token),
    run_identity_hash: identity.identity.identity_hash,
    issuer_identity: normalisedIssuer,
    issuer_identity_hash: sha256Bytes(canonicalJson(normalisedIssuer)),
    broker_intake_state: brokerIntakeChoiceSnapshot
      ? "choice_recorded"
      : "awaiting_choice",
    files: canonicalise(files),
    new_chat_policy: "Use this carrier and the matching workspace/session token; never use chat memory or Stage-4 internals as state.",
  };
  const carrier = { ...body, carrier_hash: sha256Bytes(canonicalJson(body)) };
  const target = path.join(canonicalRunRoot, RUN_CARRIER_FILE);
  await atomicWriteJson(target, carrier);
  return { path: target, sha256: await sha256File(target), carrier };
}

async function resolveReferencedFile(runRoot, name, descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error(`Carrier file ${name} does not have a valid descriptor.`);
  }
  if (typeof descriptor.path !== "string" || descriptor.path.trim() === "") {
    throw new Error(`Carrier file ${name} does not provide a relative path.`);
  }
  if (path.isAbsolute(descriptor.path)) throw new Error(`Carrier file ${name} uses an absolute path.`);
  if (!SHA256.test(String(descriptor.sha256))) {
    throw new Error(`Carrier file ${name} does not provide a sha256 hash.`);
  }
  const resolved = await canonicalPathThroughExistingAncestor(path.join(runRoot, descriptor.path));
  if (!isEqualToOrInside(resolved, runRoot) || resolved === runRoot) {
    throw new Error(`Carrier file ${name} escapes the canonical run root.`);
  }
  await requireRegularFile(resolved, `Carrier file ${name}`);
  if (await sha256File(resolved) !== descriptor.sha256) {
    throw new Error(`Carrier file ${name} hash does not match.`);
  }
  return resolved;
}

/** Verify every carrier reference before returning locally resolved paths. */
export async function verifyRunCarrier({
  skillRoot,
  runRoot,
  carrierPath,
  controllerVersion,
  workspaceToken,
}) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  const canonicalCarrier = await canonicalPathThroughExistingAncestor(carrierPath);
  if (!isEqualToOrInside(canonicalCarrier, canonicalRunRoot) || canonicalCarrier === canonicalRunRoot) {
    throw new Error("Run carrier must be a file beneath the canonical run root.");
  }
  await requireRegularFile(canonicalCarrier, "Run carrier");
  let carrier;
  try {
    carrier = JSON.parse(await fs.readFile(canonicalCarrier, "utf8"));
  } catch (error) {
    throw new Error(`Run carrier is not readable JSON: ${error.message}`);
  }
  if (carrier.schema_version !== RUN_CARRIER_SCHEMA) throw new Error("Run carrier schema does not match.");
  if (carrier.controller_version !== controllerVersion) throw new Error("Run carrier controller version does not match.");
  validateRunId(carrier.run_id);
  if (carrier.carrier_hash !== sha256Bytes(canonicalJson(carrierBody(carrier)))) {
    throw new Error("Run carrier hash does not match its contents.");
  }
  const token = requireToken(workspaceToken);
  if (carrier.workspace_session_token_hash !== sha256Bytes(token)) {
    throw new Error("Run carrier workspace/session token does not match.");
  }
  const issuerIdentity = normaliseIssuerIdentity(carrier.issuer_identity);
  if (carrier.issuer_identity_hash !== sha256Bytes(canonicalJson(issuerIdentity))) {
    throw new Error("Run carrier issuer identity hash does not match.");
  }
  const brokerIntakeState = carrier.broker_intake_state ?? "awaiting_choice";
  if (!["awaiting_choice", "choice_recorded"].includes(brokerIntakeState)) {
    throw new Error("Run carrier broker intake state is invalid.");
  }
  if (brokerIntakeState === "choice_recorded" && !carrier.files?.broker_intake_choice) {
    throw new Error("Run carrier claims a broker choice without its sealed receipt.");
  }
  if (brokerIntakeState === "awaiting_choice" && carrier.files?.broker_intake_choice) {
    throw new Error("Run carrier has a broker choice receipt but still claims awaiting choice.");
  }
  if (!carrier.files || typeof carrier.files !== "object" || Array.isArray(carrier.files)) {
    throw new Error("Run carrier files must be an object.");
  }
  for (const required of ["run_identity", "evidence_run"]) {
    if (!carrier.files[required]) throw new Error(`Run carrier is missing required file ${required}.`);
  }
  const files = {};
  for (const [name, descriptor] of Object.entries(carrier.files).sort()) {
    files[name] = await resolveReferencedFile(canonicalRunRoot, name, descriptor);
  }
  const identity = await initializeOrVerifyRunIdentity({
    skillRoot,
    runRoot: canonicalRunRoot,
    runId: carrier.run_id,
    controllerVersion,
    workspaceToken: token,
    issuerIdentity,
  });
  if (files.run_identity !== identity.path) {
    throw new Error("Run carrier identity path is not the canonical run identity file.");
  }
  if (identity.identity.identity_hash !== carrier.run_identity_hash) {
    throw new Error("Run carrier identity hash does not match the immutable run identity.");
  }
  return {
    carrier,
    carrier_path: canonicalCarrier,
    run_root: canonicalRunRoot,
    files,
    identity,
    broker_intake_state: brokerIntakeState,
    legacy_broker_intake_migration:
      carrier.broker_intake_state === undefined ? "awaiting_choice" : null,
  };
}
