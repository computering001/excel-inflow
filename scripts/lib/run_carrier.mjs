import { createHash } from "node:crypto";
import { resolveActiveSourceIdentity } from "./source_identity.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PRODUCT_IDENTITY_SCHEMA,
  assertDeploymentStatus,
  assertIdentitySha256,
  assertPackageMode,
  identitySha256,
} from "./identity_vocabulary.mjs";

import {
  atomicWriteJson,
  atomicWriteText,
  canonicalPathThroughExistingAncestor,
  initializeOrVerifyRunIdentity,
  normaliseIssuerIdentity,
  validateRunId,
} from "./runtime_isolation.mjs";

export const RUN_CARRIER_SCHEMA = "debt-model-run-carrier/4.0";
export const LEGACY_RUN_CARRIER_SCHEMA = "debt-model-run-carrier/3.0";
export const RETIRED_RUN_CARRIER_SCHEMA = "debt-model-run-carrier/2.0";
export const RUN_CARRIER_MIGRATION_SCHEMA = "run-carrier-identity-migration/1.0";
export const RUN_CARRIER_FILE = "run-carrier.json";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const STAGES = Object.freeze(["inputs", "evidence_review", "decisions", "build_checks", "delivery"]);
const RESUME_IDENTITY_DIMENSIONS = Object.freeze([
  "source_commit",
  "source_tree",
  "runtime_code_closure_sha256",
  "package_mode",
  "deployment_status",
  "installation_identity",
]);

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

function migrationBody(receipt) {
  const { receipt_hash: _ignored, ...body } = receipt;
  return body;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  return value.trim();
}

function sourceRevision(value, label) {
  const revision = nonEmpty(value, label);
  if (!GIT_OBJECT_ID.test(revision)) {
    throw new Error(`${label} must be a 40- or 64-character lowercase Git object ID.`);
  }
  return revision;
}

function resumeIdentity(productIdentityValue, label = "Product identity") {
  const source = productIdentityValue?.source;
  const packageIdentity = productIdentityValue?.package;
  const deployment = productIdentityValue?.deployment;
  if (productIdentityValue?.schema_version !== PRODUCT_IDENTITY_SCHEMA) {
    throw new Error(`${label} does not use ${PRODUCT_IDENTITY_SCHEMA}.`);
  }
  if (
    source?.identity_kind !== "source_tree" ||
    packageIdentity?.runtime_code_closure?.identity_kind !== "runtime_code_closure"
  ) throw new Error(`${label} has an untyped source or runtime-code closure.`);
  const installationIdentity = deployment?.installation_identity;
  if (installationIdentity !== null && installationIdentity !== undefined) {
    nonEmpty(installationIdentity, `${label} installation identity`);
  }
  return Object.freeze({
    schema_version: "run-resume-product-identity/1.0",
    source_commit: sourceRevision(source.commit_sha, `${label} source commit`),
    source_tree: sourceRevision(source.tree_sha, `${label} source tree`),
    runtime_code_closure_sha256: assertIdentitySha256(
      packageIdentity.runtime_code_closure.sha256,
      `${label} runtime-code closure`,
    ),
    package_mode: assertPackageMode(packageIdentity.mode, `${label} package mode`),
    deployment_status: assertDeploymentStatus(deployment?.status, `${label} deployment status`),
    installation_identity: installationIdentity ?? null,
  });
}

function carrierProductIdentity(carrier) {
  if (carrier.schema_version === RUN_CARRIER_SCHEMA) {
    return carrier.product_identity;
  }
  if (carrier.schema_version === LEGACY_RUN_CARRIER_SCHEMA) {
    if (!carrier.source_identity?.product_identity) {
      throw new Error(
        "Legacy v3 run carrier has no typed product identity and cannot be resumed or migrated safely.",
      );
    }
    return carrier.source_identity.product_identity;
  }
  throw new Error("Run carrier schema does not support typed resume identity.");
}

function identityMismatches(prior, active) {
  return RESUME_IDENTITY_DIMENSIONS.filter(
    (dimension) => canonicalJson(prior[dimension]) !== canonicalJson(active[dimension]),
  );
}

function recomputeStageInvalidation(mismatches) {
  if (!Array.isArray(mismatches) || mismatches.length === 0) return null;
  const sourceAffecting = new Set([
    "source_commit",
    "source_tree",
    "runtime_code_closure_sha256",
    "package_mode",
  ]);
  const earliestStage = mismatches.some((dimension) => sourceAffecting.has(dimension))
    ? "inputs"
    : "build_checks";
  const index = STAGES.indexOf(earliestStage);
  return Object.freeze({
    schema_version: "run-carrier-stage-invalidation/1.0",
    earliest_stage: earliestStage,
    reusable_stages: Object.freeze(STAGES.slice(0, index)),
    invalidated_stages: Object.freeze(STAGES.slice(index)),
  });
}

export function runCarrierMigrationStageInput(verifiedCarrier, stageId) {
  if (!STAGES.includes(stageId)) throw new Error(`Unknown carrier migration stage ${stageId}.`);
  if (!verifiedCarrier?.stage_invalidation?.invalidated_stages?.includes(stageId)) return {};
  const stageInput = verifiedCarrier?.migration?.receipt?.stage_input_sha256;
  assertIdentitySha256(stageInput, "Carrier migration stage input");
  return { carrier_identity_migration: stageInput };
}

async function readCarrierFile(target) {
  await requireRegularFile(target, "Run carrier");
  let carrier;
  try {
    carrier = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`Run carrier is not readable JSON: ${error.message}`);
  }
  if (carrier.carrier_hash !== sha256Bytes(canonicalJson(carrierBody(carrier)))) {
    throw new Error("Run carrier hash does not match its contents.");
  }
  return carrier;
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
  sourceIdentity = null,
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
  const activeSourceIdentity = await resolveActiveSourceIdentity({ skillRoot });
  const activeResumeIdentity = resumeIdentity(
    activeSourceIdentity.product_identity,
    "Active product identity",
  );
  if (sourceIdentity !== null) {
    const suppliedResumeIdentity = resumeIdentity(
      sourceIdentity.product_identity,
      "Supplied carrier product identity",
    );
    if (identityMismatches(suppliedResumeIdentity, activeResumeIdentity).length > 0) {
      throw new Error("Supplied carrier product identity does not match the active installation.");
    }
  }
  const body = {
    schema_version: RUN_CARRIER_SCHEMA,
    run_id: validateRunId(runId),
    controller_version: controllerVersion,
    status: String(status ?? "RESUMABLE"),
    workspace_session_token_hash: sha256Bytes(token),
    run_identity_hash: identity.identity.identity_hash,
    issuer_identity: normalisedIssuer,
    issuer_identity_hash: sha256Bytes(canonicalJson(normalisedIssuer)),
    product_identity: activeSourceIdentity.product_identity,
    resume_identity_sha256: identitySha256(activeResumeIdentity),
    telemetry_trace_id: process.env.EXCEL_INFLOW_TRACE_ID ?? null,
    user_submitted_at: process.env.EXCEL_INFLOW_USER_SUBMITTED_AT ?? null,
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

function migrationReceiptBody({ carrier, controllerVersion, priorIdentity, activeIdentity, mismatches }) {
  const stageInvalidation = recomputeStageInvalidation(mismatches);
  const body = {
    schema_version: RUN_CARRIER_MIGRATION_SCHEMA,
    controller_version: controllerVersion,
    prior_carrier_schema: carrier.schema_version,
    prior_carrier_hash: carrier.carrier_hash,
    prior_resume_identity_sha256: identitySha256(priorIdentity),
    active_resume_identity_sha256: identitySha256(activeIdentity),
    mismatch_dimensions: [...mismatches],
    stage_invalidation: stageInvalidation,
  };
  return {
    ...body,
    stage_input_sha256: identitySha256(body),
  };
}

/**
 * Mint the only lawful bridge across a carrier/installation identity change.
 * The caller supplies no identity values or invalidation choice: both are
 * recomputed from the hash-valid prior carrier and the active installation.
 */
export async function writeRunCarrierMigrationReceipt({
  skillRoot,
  runRoot,
  carrierPath,
  controllerVersion,
  workspaceToken,
  outPath = null,
}) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  const canonicalCarrier = await canonicalPathThroughExistingAncestor(carrierPath);
  if (!isEqualToOrInside(canonicalCarrier, canonicalRunRoot) || canonicalCarrier === canonicalRunRoot) {
    throw new Error("Run carrier must be a file beneath the canonical run root.");
  }
  const carrier = await readCarrierFile(canonicalCarrier);
  if (![RUN_CARRIER_SCHEMA, LEGACY_RUN_CARRIER_SCHEMA].includes(carrier.schema_version)) {
    throw new Error("Only typed v3 or v4 carriers can receive an identity migration receipt.");
  }
  if (carrier.controller_version !== controllerVersion) {
    throw new Error("Run carrier controller version does not match migration controller.");
  }
  const token = requireToken(workspaceToken);
  if (carrier.workspace_session_token_hash !== sha256Bytes(token)) {
    throw new Error("Run carrier workspace/session token does not match migration controller.");
  }
  const priorIdentity = resumeIdentity(carrierProductIdentity(carrier), "Prior carrier product identity");
  const activeSourceIdentity = await resolveActiveSourceIdentity({ skillRoot });
  const activeIdentity = resumeIdentity(activeSourceIdentity.product_identity, "Active product identity");
  const mismatches = identityMismatches(priorIdentity, activeIdentity);
  if (mismatches.length === 0) {
    throw new Error("Run carrier already matches the active product identity; migration is not permitted.");
  }
  const body = migrationReceiptBody({
    carrier,
    controllerVersion,
    priorIdentity,
    activeIdentity,
    mismatches,
  });
  const receipt = { ...body, receipt_hash: sha256Bytes(canonicalJson(body)) };
  const requestedTarget = outPath ?? path.join(canonicalRunRoot, "carrier", "identity-migration-receipt.json");
  const target = await canonicalPathThroughExistingAncestor(requestedTarget);
  if (!isEqualToOrInside(target, canonicalRunRoot) || target === canonicalRunRoot) {
    throw new Error("Run carrier migration receipt must remain beneath the canonical run root.");
  }
  await atomicWriteJson(target, receipt);
  return { path: target, sha256: await sha256File(target), receipt };
}

async function verifyMigrationReceipt({
  receiptPath,
  runRoot,
  carrier,
  controllerVersion,
  priorIdentity,
  activeIdentity,
  mismatches,
}) {
  const canonicalReceipt = await canonicalPathThroughExistingAncestor(receiptPath);
  if (!isEqualToOrInside(canonicalReceipt, runRoot) || canonicalReceipt === runRoot) {
    throw new Error("Run carrier migration receipt must be beneath the canonical run root.");
  }
  await requireRegularFile(canonicalReceipt, "Run carrier migration receipt");
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(canonicalReceipt, "utf8"));
  } catch (error) {
    throw new Error(`Run carrier migration receipt is not readable JSON: ${error.message}`);
  }
  if (receipt.schema_version !== RUN_CARRIER_MIGRATION_SCHEMA) {
    throw new Error("Run carrier migration receipt schema does not match.");
  }
  if (receipt.receipt_hash !== sha256Bytes(canonicalJson(migrationBody(receipt)))) {
    throw new Error("Run carrier migration receipt hash does not match its contents.");
  }
  const expected = migrationReceiptBody({
    carrier,
    controllerVersion,
    priorIdentity,
    activeIdentity,
    mismatches,
  });
  if (canonicalJson(migrationBody(receipt)) !== canonicalJson(expected)) {
    throw new Error("Run carrier migration receipt does not match recomputed identity invalidation.");
  }
  return { receipt, path: canonicalReceipt, stage_invalidation: expected.stage_invalidation };
}

/** Verify every carrier reference before returning locally resolved paths. */
export async function verifyRunCarrier({
  skillRoot,
  runRoot,
  carrierPath,
  controllerVersion,
  workspaceToken,
  migrationReceiptPath = null,
}) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  const canonicalCarrier = await canonicalPathThroughExistingAncestor(carrierPath);
  if (!isEqualToOrInside(canonicalCarrier, canonicalRunRoot) || canonicalCarrier === canonicalRunRoot) {
    throw new Error("Run carrier must be a file beneath the canonical run root.");
  }
  const carrier = await readCarrierFile(canonicalCarrier);
  if (carrier.schema_version === RETIRED_RUN_CARRIER_SCHEMA) {
    throw new Error("Legacy v2 run carriers are retired and cannot establish typed active identity.");
  }
  if (![RUN_CARRIER_SCHEMA, LEGACY_RUN_CARRIER_SCHEMA].includes(carrier.schema_version)) {
    throw new Error("Run carrier schema does not match.");
  }
  if (carrier.controller_version !== controllerVersion) throw new Error("Run carrier controller version does not match.");
  validateRunId(carrier.run_id);
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
  const priorResumeIdentity = resumeIdentity(
    carrierProductIdentity(carrier),
    "Run carrier product identity",
  );
  if (
    carrier.schema_version === RUN_CARRIER_SCHEMA &&
    carrier.resume_identity_sha256 !== identitySha256(priorResumeIdentity)
  ) {
    throw new Error("Run carrier resume identity hash does not bind its typed product identity.");
  }
  const activeSourceIdentity = await resolveActiveSourceIdentity({ skillRoot });
  const activeResumeIdentity = resumeIdentity(
    activeSourceIdentity.product_identity,
    "Active product identity",
  );
  const mismatches = identityMismatches(priorResumeIdentity, activeResumeIdentity);
  let migration = null;
  if (mismatches.length > 0) {
    if (!migrationReceiptPath) {
      throw new Error(
        `Run carrier product identity does not match the active installation: ${mismatches.join(", ")}. ` +
        "An explicit controller-generated migration receipt is required.",
      );
    }
    migration = await verifyMigrationReceipt({
      receiptPath: migrationReceiptPath,
      runRoot: canonicalRunRoot,
      carrier,
      controllerVersion,
      priorIdentity: priorResumeIdentity,
      activeIdentity: activeResumeIdentity,
      mismatches,
    });
  } else if (migrationReceiptPath) {
    throw new Error("Run carrier migration receipt is stale because active identity already matches.");
  }
  return {
    carrier,
    carrier_path: canonicalCarrier,
    run_root: canonicalRunRoot,
    files,
    identity,
    broker_intake_state: brokerIntakeState,
    active_source_identity: activeSourceIdentity,
    migration,
    stage_invalidation: migration?.stage_invalidation ?? null,
    legacy_broker_intake_migration:
      carrier.broker_intake_state === undefined ? "awaiting_choice" : null,
    legacy_carrier_schema_migration:
      carrier.schema_version === LEGACY_RUN_CARRIER_SCHEMA ? "v3_identity_reverified" : null,
  };
}
