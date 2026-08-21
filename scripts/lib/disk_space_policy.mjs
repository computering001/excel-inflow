/**
 * Disk-space measurement, policy custody and topology-aware evaluation.
 *
 * Observed cohorts and conservative derived bounds are deliberately distinct.
 * This module ships contracts and arithmetic only; no production measurement
 * or floor values exist until the external cohort is complete and sealed.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./json_schema.mjs";
import {
  assertMeasurementObservedCohortsMatchRaw,
  recomputeDiskSpaceObservedCohorts,
} from "./disk_space_measurement_builder.mjs";

export const DISK_SPACE_POLICY_SCHEMA_VERSION =
  "excel-inflow-disk-space-policy/1.1";
export const DISK_SPACE_MEASUREMENT_SCHEMA_VERSION =
  "excel-inflow-disk-space-measurement/1.1";
export const DISK_SPACE_EVALUATION_SCHEMA_VERSION =
  "excel-inflow-disk-space-evaluation/1.1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_SCHEMA_PATH = path.resolve(
  HERE, "..", "..", "assets", "disk-space-policy-v1.schema.json",
);
const DEFAULT_MEASUREMENT_SCHEMA_PATH = path.resolve(
  HERE, "..", "..", "assets", "disk-space-measurement-v1.schema.json",
);
const LANE_IDS = Object.freeze(["evidence", "workbook", "combined"]);
const OBSERVED_COHORT_IDS = Object.freeze(["filings", "brokers", "workbook"]);
const ROOT_IDS = Object.freeze(["work_root", "temp_root", "shared_volume_total"]);
const SHA256 = /^[a-f0-9]{64}$/;

export class DiskSpacePolicyError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "DiskSpacePolicyError";
    this.code = code;
    this.detail = detail;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function finding(code, pathValue, detail) {
  return Object.freeze({ code, path: pathValue, detail });
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeByteInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function measuredSourceIdentityValid(value) {
  return value && typeof value === "object" &&
    typeof value.repository === "string" && value.repository.length > 0 &&
    /^[a-f0-9]{40}$/.test(String(value.source_commit ?? "")) &&
    /^[a-f0-9]{40}$/.test(String(value.source_tree ?? "")) &&
    SHA256.test(String(value.measured_certified_code_closure_sha256 ?? ""));
}

function expectedObservedRef(cohortId, rootId) {
  return `#/observed_cohorts/${cohortId}/root_statistics/${rootId}`;
}

function expectedDerivedRef(lane, rootId) {
  return `#/derived_bounds/${lane}/bounds/${rootId}`;
}

function validateObservedCohort(measurement, cohortId, cohort, minimumSamples, findings) {
  const prefix = `measurement.observed_cohorts.${cohortId}`;
  if (!cohort || typeof cohort !== "object") {
    findings.push(finding("DISK_SPACE_OBSERVED_COHORT_MISSING", prefix, cohortId));
    return;
  }
  if (cohort.cohort_id !== cohortId || cohort.workload_kind !== cohortId) {
    findings.push(finding("DISK_SPACE_OBSERVED_COHORT_IDENTITY_MISMATCH", prefix, {
      cohort_id: cohort.cohort_id,
      workload_kind: cohort.workload_kind,
    }));
  }
  if (cohort.corpus_manifest_ref !== `#/evidence_manifests/corpora/${cohortId}`) {
    findings.push(finding("DISK_SPACE_CORPUS_MANIFEST_REF_MISMATCH", `${prefix}.corpus_manifest_ref`, cohort.corpus_manifest_ref));
  }
  if (cohort.sample_receipt_manifest_ref !== "#/evidence_manifests/sample_receipts") {
    findings.push(finding("DISK_SPACE_SAMPLE_MANIFEST_REF_MISMATCH", `${prefix}.sample_receipt_manifest_ref`, cohort.sample_receipt_manifest_ref));
  }
  if (!Number.isSafeInteger(cohort.sample_count) || cohort.sample_count < minimumSamples) {
    findings.push(finding("DISK_SPACE_OBSERVED_COHORT_TOO_SMALL", `${prefix}.sample_count`, {
      observed: cohort.sample_count,
      required: minimumSamples,
    }));
  }
  if (!exactKeys(cohort.root_statistics, ROOT_IDS)) {
    findings.push(finding("DISK_SPACE_OBSERVED_ROOTS_INVALID", `${prefix}.root_statistics`, ROOT_IDS));
    return;
  }
  for (const rootId of ROOT_IDS) {
    const stats = cohort.root_statistics[rootId];
    const values = [stats?.median_bytes, stats?.p95_bytes, stats?.observed_max_bytes];
    if (
      stats?.statistic_kind !== "OBSERVED" ||
      stats?.sample_count !== cohort.sample_count ||
      values.some((value) => !safeByteInteger(value))
    ) {
      findings.push(finding("DISK_SPACE_OBSERVED_STATS_INVALID", `${prefix}.root_statistics.${rootId}`, stats));
      continue;
    }
    if (!(stats.median_bytes <= stats.p95_bytes && stats.p95_bytes <= stats.observed_max_bytes)) {
      findings.push(finding("DISK_SPACE_MEASUREMENT_QUANTILES_INVALID", `${prefix}.root_statistics.${rootId}`, stats));
    }
  }
}

function validateDerivedLane(measurement, lane, expectedInputs, findings) {
  const derived = measurement?.derived_bounds?.[lane];
  const prefix = `measurement.derived_bounds.${lane}`;
  if (
    derived?.derivation_kind !== "DERIVED_CONSERVATIVE_BOUND" ||
    derived?.formula !== "SUM_OBSERVED_MAXIMA" ||
    derived?.concurrency_assumption !== "SUM_WHEN_CONCURRENCY_NOT_DISPROVED" ||
    !same([...(derived?.input_cohorts ?? [])].sort(), [...expectedInputs].sort())
  ) {
    findings.push(finding("DISK_SPACE_DERIVATION_CONTRACT_INVALID", prefix, derived));
    return;
  }
  if (!exactKeys(derived.bounds, ROOT_IDS)) {
    findings.push(finding("DISK_SPACE_DERIVED_ROOTS_INVALID", `${prefix}.bounds`, ROOT_IDS));
    return;
  }
  for (const rootId of ROOT_IDS) {
    const bound = derived.bounds[rootId];
    const expectedRefs = expectedInputs.map((cohortId) => expectedObservedRef(cohortId, rootId));
    const expectedBytes = expectedInputs.reduce(
      (total, cohortId) => total + measurement.observed_cohorts[cohortId].root_statistics[rootId].observed_max_bytes,
      0,
    );
    if (
      bound?.bound_kind !== "DERIVED_CONSERVATIVE_BOUND" ||
      !same([...(bound?.input_refs ?? [])].sort(), [...expectedRefs].sort()) ||
      bound?.derived_conservative_bound_bytes !== expectedBytes
    ) {
      findings.push(finding("DISK_SPACE_DERIVED_BOUND_MISMATCH", `${prefix}.bounds.${rootId}`, {
        expected_input_refs: expectedRefs,
        expected_bytes: expectedBytes,
        observed: bound,
      }));
    }
  }
}

function validateMeasurementSemantics(measurement) {
  const findings = [];
  if (measurement?.schema_version !== DISK_SPACE_MEASUREMENT_SCHEMA_VERSION) {
    findings.push(finding("DISK_SPACE_MEASUREMENT_SCHEMA_UNSUPPORTED", "measurement.schema_version", String(measurement?.schema_version)));
  }
  if (measurement?.measurement_status !== "COMPLETE") {
    findings.push(finding("DISK_SPACE_MEASUREMENT_INCOMPLETE", "measurement.measurement_status", String(measurement?.measurement_status)));
  }
  if (!measuredSourceIdentityValid(measurement?.measured_source_identity)) {
    findings.push(finding("DISK_SPACE_MEASUREMENT_SOURCE_IDENTITY_INVALID", "measurement.measured_source_identity", measurement?.measured_source_identity));
  }
  const minimumSamples = measurement?.methodology?.minimum_samples_per_observed_cohort;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 20) {
    findings.push(finding("DISK_SPACE_MEASUREMENT_MINIMUM_SAMPLE_RULE_INVALID", "measurement.methodology.minimum_samples_per_observed_cohort", minimumSamples));
    return findings;
  }
  if (!exactKeys(measurement?.observed_cohorts, [...OBSERVED_COHORT_IDS, "actual_combined"])) {
    findings.push(finding("DISK_SPACE_OBSERVED_COHORT_SET_INVALID", "measurement.observed_cohorts", "filings, brokers, workbook and optional actual_combined are required"));
    return findings;
  }
  for (const cohortId of OBSERVED_COHORT_IDS) {
    validateObservedCohort(measurement, cohortId, measurement.observed_cohorts[cohortId], minimumSamples, findings);
  }
  if (measurement.observed_cohorts.actual_combined !== null) {
    const combined = measurement.observed_cohorts.actual_combined;
    if (combined?.cohort_id !== "actual_combined" || combined?.workload_kind !== "actual_combined") {
      findings.push(finding("DISK_SPACE_ACTUAL_COMBINED_IDENTITY_INVALID", "measurement.observed_cohorts.actual_combined", combined));
    }
    if (!Number.isSafeInteger(combined?.sample_count) || combined.sample_count < minimumSamples) {
      findings.push(finding("DISK_SPACE_ACTUAL_COMBINED_TOO_SMALL", "measurement.observed_cohorts.actual_combined.sample_count", combined?.sample_count));
    }
    if (!exactKeys(combined?.root_statistics, ROOT_IDS)) {
      findings.push(finding("DISK_SPACE_ACTUAL_COMBINED_ROOTS_INVALID", "measurement.observed_cohorts.actual_combined.root_statistics", ROOT_IDS));
    } else {
      if (combined.corpus_manifest_ref !== "#/evidence_manifests/corpora" ||
          combined.sample_receipt_manifest_ref !== "#/evidence_manifests/sample_receipts") {
        findings.push(finding("DISK_SPACE_ACTUAL_COMBINED_MANIFEST_REF_INVALID", "measurement.observed_cohorts.actual_combined", {
          corpus_manifest_ref: combined.corpus_manifest_ref,
          sample_receipt_manifest_ref: combined.sample_receipt_manifest_ref,
        }));
      }
      for (const rootId of ROOT_IDS) {
        const stats = combined.root_statistics[rootId];
        if (
          stats?.statistic_kind !== "OBSERVED" || stats?.sample_count !== combined.sample_count ||
          !safeByteInteger(stats?.median_bytes) || !safeByteInteger(stats?.p95_bytes) ||
          !safeByteInteger(stats?.observed_max_bytes) ||
          !(stats.median_bytes <= stats.p95_bytes && stats.p95_bytes <= stats.observed_max_bytes)
        ) {
          findings.push(finding("DISK_SPACE_ACTUAL_COMBINED_STATS_INVALID", `measurement.observed_cohorts.actual_combined.root_statistics.${rootId}`, stats));
        }
      }
    }
  }
  if (findings.length === 0) {
    validateDerivedLane(measurement, "evidence", ["filings", "brokers"], findings);
    validateDerivedLane(measurement, "combined", ["filings", "brokers", "workbook"], findings);
  }
  return findings;
}

function jsonPointer(value, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("#/")) return undefined;
  let cursor = value;
  for (const encoded of pointer.slice(2).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function allowedBasisRef(lane, rootId, basisRef) {
  if (lane === "evidence") return basisRef === expectedDerivedRef("evidence", rootId);
  if (lane === "workbook") return basisRef === expectedObservedRef("workbook", rootId);
  return basisRef === expectedDerivedRef("combined", rootId) ||
    basisRef === expectedObservedRef("actual_combined", rootId);
}

function validateFloorBasis(measurement, lane, rootId, floor, findings) {
  const prefix = `policy.floors.${lane}.${rootId}`;
  if (!floor || typeof floor !== "object" || !allowedBasisRef(lane, rootId, floor.basis_ref)) {
    findings.push(finding("DISK_SPACE_POLICY_BASIS_REF_INVALID", `${prefix}.basis_ref`, floor?.basis_ref));
    return;
  }
  const basis = jsonPointer(measurement, floor.basis_ref);
  let expectedBasis = null;
  if (floor.basis_kind === "observed_max_plus_safety") {
    expectedBasis = basis?.statistic_kind === "OBSERVED" ? basis.observed_max_bytes : null;
  } else if (floor.basis_kind === "twice_observed_p95") {
    expectedBasis = basis?.statistic_kind === "OBSERVED" ? basis.p95_bytes * 2 : null;
  } else if (floor.basis_kind === "derived_conservative_bound_plus_safety") {
    expectedBasis = basis?.bound_kind === "DERIVED_CONSERVATIVE_BOUND"
      ? basis.derived_conservative_bound_bytes
      : null;
  }
  if (!safeByteInteger(expectedBasis) || floor.basis_bytes !== expectedBasis) {
    findings.push(finding("DISK_SPACE_POLICY_BASIS_BYTES_MISMATCH", `${prefix}.basis_bytes`, {
      basis_ref: floor.basis_ref,
      expected: expectedBasis,
      observed: floor.basis_bytes,
    }));
  }
  const threshold = safeByteInteger(expectedBasis) && safeByteInteger(floor.safety_margin_bytes)
    ? expectedBasis + floor.safety_margin_bytes
    : null;
  if (!Number.isSafeInteger(threshold) || !Number.isSafeInteger(floor.min_free_bytes) || floor.min_free_bytes < threshold) {
    findings.push(finding("DISK_SPACE_POLICY_FLOOR_UNDERSHOOTS_BASIS", `${prefix}.min_free_bytes`, {
      declared: floor?.min_free_bytes,
      required: threshold,
    }));
  }
}

function validatePolicySemantics(policy, measurement = null) {
  const findings = [];
  if (policy?.schema_version !== DISK_SPACE_POLICY_SCHEMA_VERSION) {
    findings.push(finding("DISK_SPACE_POLICY_SCHEMA_UNSUPPORTED", "policy.schema_version", String(policy?.schema_version)));
  }
  if (!SHA256.test(String(policy?.policy_schema_sha256 ?? ""))) {
    findings.push(finding("DISK_SPACE_POLICY_SCHEMA_HASH_INVALID", "policy.policy_schema_sha256", policy?.policy_schema_sha256));
  }
  if (policy?.lower_override_action !== "REFUSE") {
    findings.push(finding("DISK_SPACE_LOWER_OVERRIDE_POLICY_INVALID", "policy.lower_override_action", policy?.lower_override_action));
  }
  if (!measuredSourceIdentityValid(policy?.measured_source_identity)) {
    findings.push(finding("DISK_SPACE_POLICY_SOURCE_IDENTITY_INVALID", "policy.measured_source_identity", policy?.measured_source_identity));
  }
  if (!exactKeys(policy?.floors, LANE_IDS)) {
    findings.push(finding("DISK_SPACE_POLICY_LANES_INVALID", "policy.floors", LANE_IDS));
    return findings;
  }
  if (measurement !== null) {
    findings.push(...validateMeasurementSemantics(measurement));
    if (!same(policy.measured_source_identity, measurement.measured_source_identity)) {
      findings.push(finding("DISK_SPACE_POLICY_SOURCE_IDENTITY_MISMATCH", "policy.measured_source_identity", {
        policy: policy.measured_source_identity,
        measurement: measurement.measured_source_identity,
      }));
    }
    if (findings.length === 0) {
      for (const lane of LANE_IDS) {
        const topology = policy.floors[lane];
        validateFloorBasis(measurement, lane, "work_root", topology?.distinct_volumes?.work_root, findings);
        validateFloorBasis(measurement, lane, "temp_root", topology?.distinct_volumes?.temp_root, findings);
        validateFloorBasis(measurement, lane, "shared_volume_total", topology?.shared_volume, findings);
        const shared = topology?.shared_volume?.min_free_bytes;
        const work = topology?.distinct_volumes?.work_root?.min_free_bytes;
        const temp = topology?.distinct_volumes?.temp_root?.min_free_bytes;
        if (safeByteInteger(shared) && (shared < work || shared < temp)) {
          findings.push(finding("DISK_SPACE_SHARED_VOLUME_FLOOR_TOO_LOW", `policy.floors.${lane}.shared_volume.min_free_bytes`, { shared, work, temp }));
        }
      }
      for (const rootPath of [
        ["distinct_volumes", "work_root"],
        ["distinct_volumes", "temp_root"],
        ["shared_volume"],
      ]) {
        const read = (lane) => rootPath.reduce((value, key) => value?.[key], policy.floors[lane])?.min_free_bytes;
        if (read("combined") < read("evidence") || read("combined") < read("workbook")) {
          findings.push(finding("DISK_SPACE_COMBINED_FLOOR_TOO_LOW", `policy.floors.combined.${rootPath.join(".")}.min_free_bytes`, {
            evidence: read("evidence"), workbook: read("workbook"), combined: read("combined"),
          }));
        }
      }
    }
  }
  return findings;
}

export async function loadDiskSpacePolicySchema(schemaPath = DEFAULT_POLICY_SCHEMA_PATH) {
  return JSON.parse(await fs.readFile(path.resolve(schemaPath), "utf8"));
}

export async function loadDiskSpaceMeasurementSchema(schemaPath = DEFAULT_MEASUREMENT_SCHEMA_PATH) {
  return JSON.parse(await fs.readFile(path.resolve(schemaPath), "utf8"));
}

export function validateDiskSpaceMeasurementContract({ measurement, schema }) {
  const schemaFindings = schema
    ? validateJsonSchema(measurement, schema).map((detail) => finding("DISK_SPACE_MEASUREMENT_SCHEMA_INVALID", "measurement", detail))
    : [];
  return Object.freeze([...schemaFindings, ...validateMeasurementSemantics(measurement)]);
}

export function validateDiskSpacePolicyContract({ policy, schema, measurement = null, measurementSchema = null }) {
  const schemaFindings = schema
    ? validateJsonSchema(policy, schema).map((detail) => finding("DISK_SPACE_POLICY_SCHEMA_INVALID", "policy", detail))
    : [];
  const measurementFindings = measurement && measurementSchema
    ? validateJsonSchema(measurement, measurementSchema).map((detail) =>
      finding("DISK_SPACE_MEASUREMENT_SCHEMA_INVALID", "measurement", detail))
    : [];
  return Object.freeze([...schemaFindings, ...measurementFindings, ...validatePolicySemantics(policy, measurement)]);
}

function declaredPathUnsafe(declaredPath) {
  return typeof declaredPath !== "string" || declaredPath.length === 0 ||
    path.isAbsolute(declaredPath) || path.win32.isAbsolute(declaredPath) ||
    /^[A-Za-z]:/.test(declaredPath) || /^[/\\]{2}/.test(declaredPath) ||
    declaredPath.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..");
}

async function safeEvidenceTarget(policyPath, declaredPath) {
  if (declaredPathUnsafe(declaredPath)) {
    throw new DiskSpacePolicyError("DISK_SPACE_EVIDENCE_POINTER_UNSAFE", "Evidence must be one portable policy-relative path.", { declared_path: declaredPath });
  }
  const parent = path.dirname(policyPath);
  const canonicalParent = await fs.realpath(parent);
  const segments = declaredPath.split(/[\\/]/);
  let cursor = parent;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const metadata = await fs.lstat(cursor).catch((error) => {
      throw new DiskSpacePolicyError("DISK_SPACE_EVIDENCE_MISSING", `Evidence ancestor is unavailable: ${error.code ?? error.message}.`);
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DiskSpacePolicyError("DISK_SPACE_EVIDENCE_ANCESTOR_UNSAFE", "Evidence path contains a non-directory or symlink ancestor.", { ancestor: cursor });
    }
  }
  const target = path.resolve(parent, ...segments);
  const canonicalTarget = await fs.realpath(target).catch((error) => {
    throw new DiskSpacePolicyError("DISK_SPACE_EVIDENCE_MISSING", `Evidence is unavailable: ${error.code ?? error.message}.`, { target });
  });
  const relative = path.relative(canonicalParent, canonicalTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DiskSpacePolicyError("DISK_SPACE_EVIDENCE_POINTER_UNSAFE", "Canonical evidence target escapes the canonical policy directory.", { target, canonical_target: canonicalTarget });
  }
  return target;
}

function stableIdentity(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
}

async function stableRegularBytes(target, missingCode, afterOpen = null) {
  let initial;
  try {
    initial = await fs.lstat(target);
  } catch (error) {
    throw new DiskSpacePolicyError(missingCode, `Required disk-space artifact is unavailable: ${error.code ?? error.message}.`, { target });
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new DiskSpacePolicyError("DISK_SPACE_POLICY_ARTIFACT_UNSAFE", "Disk-space artifact is not one regular non-symlink file.", { target });
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new DiskSpacePolicyError("DISK_SPACE_ARTIFACT_UNSTABLE", "Artifact identity changed between lstat and open.", { target });
    }
    if (typeof afterOpen === "function") await afterOpen(target);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const finalPath = await fs.lstat(target);
    if (stableIdentity(opened) !== stableIdentity(after) ||
        after.dev !== finalPath.dev || after.ino !== finalPath.ino ||
        finalPath.isSymbolicLink()) {
      throw new DiskSpacePolicyError("DISK_SPACE_ARTIFACT_UNSTABLE", "Artifact bytes or path identity changed during the stable read.", { target });
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readBoundEvidence(policyPath, pointer, label, operations = {}) {
  const target = await safeEvidenceTarget(policyPath, pointer?.path);
  const bytes = await stableRegularBytes(
    target,
    `DISK_SPACE_${label}_MISSING`,
    operations.after_artifact_open,
  );
  const observed = digest(bytes);
  if (!SHA256.test(String(pointer?.sha256 ?? "")) || pointer.sha256 !== observed) {
    throw new DiskSpacePolicyError(`DISK_SPACE_${label}_HASH_MISMATCH`, `${label} bytes do not match their declared SHA-256.`, {
      declared_sha256: pointer?.sha256 ?? null, observed_sha256: observed,
    });
  }
  return { target, bytes, sha256: observed };
}

export async function loadDiskSpacePolicy({
  policyPath,
  expectedPolicySha256 = null,
  mode = "development",
  schemaPath = DEFAULT_POLICY_SCHEMA_PATH,
  operations = {},
} = {}) {
  if (!new Set(["development", "candidate"]).has(mode)) {
    throw new DiskSpacePolicyError("DISK_SPACE_POLICY_MODE_INVALID", `Unsupported mode: ${mode}.`);
  }
  const resolvedPolicyPath = path.resolve(String(policyPath));
  const policyBytes = await stableRegularBytes(
    resolvedPolicyPath,
    "DISK_SPACE_POLICY_MISSING",
    operations.after_artifact_open,
  );
  const policySha256 = digest(policyBytes);
  const policySealed = SHA256.test(String(expectedPolicySha256 ?? "")) && expectedPolicySha256 === policySha256;
  if (mode === "candidate" && !policySealed) {
    throw new DiskSpacePolicyError("DISK_SPACE_POLICY_UNSEALED", "Candidate mode requires an expected policy SHA-256 matching the exact policy bytes.", {
      expected_policy_sha256: expectedPolicySha256, observed_policy_sha256: policySha256,
    });
  }
  let policy;
  let policySchema;
  let policySchemaBytes;
  try {
    [policy, policySchemaBytes] = await Promise.all([
      Promise.resolve(JSON.parse(policyBytes.toString("utf8"))),
      stableRegularBytes(
        path.resolve(schemaPath),
        "DISK_SPACE_POLICY_SCHEMA_MISSING",
        operations.after_artifact_open,
      ),
    ]);
    policySchema = JSON.parse(policySchemaBytes.toString("utf8"));
  } catch (error) {
    throw new DiskSpacePolicyError("DISK_SPACE_POLICY_MALFORMED", `Policy or policy schema is not readable JSON: ${error.message}.`);
  }
  const policySchemaSha256 = digest(policySchemaBytes);
  if (policy.policy_schema_sha256 !== policySchemaSha256) {
    throw new DiskSpacePolicyError(
      "DISK_SPACE_POLICY_SCHEMA_HASH_MISMATCH",
      "Policy schema bytes do not match the SHA-256 sealed in the policy.",
      {
        declared_sha256: policy.policy_schema_sha256,
        observed_sha256: policySchemaSha256,
      },
    );
  }
  if (mode === "candidate" && policy.policy_status !== "SEALED_MEASURED") {
    throw new DiskSpacePolicyError("DISK_SPACE_POLICY_UNMEASURED", "Candidate mode requires policy_status=SEALED_MEASURED.");
  }
  const measurementBound = await readBoundEvidence(resolvedPolicyPath, policy?.measurement_evidence, "MEASUREMENT", operations);
  const measurementSchemaBound = await readBoundEvidence(resolvedPolicyPath, {
    path: policy?.measurement_evidence?.schema_path,
    sha256: policy?.measurement_evidence?.schema_sha256,
  }, "MEASUREMENT_SCHEMA", operations);
  let measurement;
  let measurementSchema;
  try {
    measurement = JSON.parse(measurementBound.bytes.toString("utf8"));
    measurementSchema = JSON.parse(measurementSchemaBound.bytes.toString("utf8"));
  } catch (error) {
    throw new DiskSpacePolicyError("DISK_SPACE_MEASUREMENT_MALFORMED", `Measurement or measurement schema is not JSON: ${error.message}.`);
  }
  if (
    policy?.measurement_evidence?.schema_version !== measurement?.schema_version ||
    measurementSchema?.properties?.schema_version?.const !== measurement?.schema_version
  ) {
    throw new DiskSpacePolicyError("DISK_SPACE_MEASUREMENT_SCHEMA_MISMATCH", "Policy pointer, measurement and measurement schema versions disagree.");
  }

  const manifestPointers = {
    sample_receipts: measurement?.evidence_manifests?.sample_receipts,
    filings: measurement?.evidence_manifests?.corpora?.filings,
    brokers: measurement?.evidence_manifests?.corpora?.brokers,
    workbook: measurement?.evidence_manifests?.corpora?.workbook,
  };
  const manifestCustody = {};
  for (const [name, pointer] of Object.entries(manifestPointers)) {
    manifestCustody[name] = await readBoundEvidence(
      resolvedPolicyPath,
      pointer,
      `RAW_${name.toUpperCase()}`,
      operations,
    );
  }
  if (
    policy.measurement_evidence.sample_receipt_manifest_sha256 !== manifestCustody.sample_receipts.sha256 ||
    OBSERVED_COHORT_IDS.some((name) =>
      policy.measurement_evidence.corpus_manifest_sha256[name] !== manifestCustody[name].sha256)
  ) {
    throw new DiskSpacePolicyError("DISK_SPACE_RAW_EVIDENCE_POLICY_MISMATCH", "Policy raw-evidence hashes do not match measurement manifest custody.");
  }

  // Candidate acceptance reopens every sealed path-portable resource-sample
  // projection, verifies its binding to the exact external source-receipt SHA,
  // refuses host-path leakage, and independently recomputes all cohort facts.
  // Hash custody alone is insufficient: the independently compiled 20+20+20
  // observations must reproduce every statistic authored into the measurement.
  let rawRecomputation = null;
  if (mode === "candidate") {
    rawRecomputation = await recomputeDiskSpaceObservedCohorts({
      sampleManifestPath: manifestCustody.sample_receipts.target,
      minimumSamplesPerCohort:
        measurement?.methodology?.minimum_samples_per_observed_cohort,
    });
    assertMeasurementObservedCohortsMatchRaw({
      measurement,
      recomputed: rawRecomputation,
    });
  }

  const findings = validateDiskSpacePolicyContract({
    policy, schema: policySchema, measurement, measurementSchema,
  });
  if (findings.length > 0) {
    throw new DiskSpacePolicyError("DISK_SPACE_POLICY_INVALID", `Disk-space policy failed ${findings.length} validation finding(s).`, { findings });
  }
  return Object.freeze({
    policy,
    measurement,
    custody: Object.freeze({
      policy_path: resolvedPolicyPath,
      policy_sha256: policySha256,
      expected_policy_sha256: expectedPolicySha256,
      policy_sealed: policySealed,
      policy_schema_path: path.resolve(schemaPath),
      policy_schema_sha256: policySchemaSha256,
      policy_schema_sealed: true,
      measurement_evidence_path: measurementBound.target,
      measurement_evidence_sha256: measurementBound.sha256,
      measurement_evidence_sealed: true,
      measurement_schema_path: measurementSchemaBound.target,
      measurement_schema_sha256: measurementSchemaBound.sha256,
      measurement_schema_sealed: true,
      raw_manifests: Object.freeze(Object.fromEntries(
        Object.entries(manifestCustody).map(([name, value]) => [name, Object.freeze({
          path: value.target, sha256: value.sha256, sealed: true,
        })]),
      )),
      raw_recomputation: rawRecomputation === null ? null : Object.freeze({
        schema_version: rawRecomputation.schema_version,
        sample_manifest_sha256: rawRecomputation.sample_manifest_sha256,
        sample_manifest_schema_sha256:
          rawRecomputation.sample_manifest_schema_sha256,
        corpus_manifest_schema_sha256:
          rawRecomputation.corpus_manifest_schema_sha256,
        corpus_manifest_sha256: rawRecomputation.corpus_manifest_sha256,
        sample_count: rawRecomputation.samples.length,
        status: "PASS",
      }),
    }),
  });
}

function selectedLane(requestedLanes) {
  if (!Array.isArray(requestedLanes)) return null;
  const lanes = [...new Set(requestedLanes)].sort();
  if (same(lanes, ["evidence"])) return "evidence";
  if (same(lanes, ["workbook"])) return "workbook";
  if (same(lanes, ["evidence", "workbook"])) return "combined";
  return null;
}

function validVolumeIdentity(value) {
  return value && typeof value === "object" &&
    typeof value.device_id === "string" && value.device_id.length > 0 &&
    typeof value.filesystem_type === "string" && value.filesystem_type.length > 0 &&
    Number.isSafeInteger(value.block_size_bytes) && value.block_size_bytes > 0;
}

function declaredRequirements(policy, lane) {
  const selected = policy?.floors?.[lane];
  return {
    distinct_volumes: {
      work_root: selected?.distinct_volumes?.work_root?.min_free_bytes ?? null,
      temp_root: selected?.distinct_volumes?.temp_root?.min_free_bytes ?? null,
    },
    shared_volume: selected?.shared_volume?.min_free_bytes ?? null,
  };
}

export function evaluateDiskSpacePolicy({
  loadedPolicy,
  mode = "development",
  requestedLanes,
  observations,
  overrideMinFreeBytes = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const findings = [];
  if (!new Set(["development", "candidate"]).has(mode)) findings.push(finding("DISK_SPACE_POLICY_MODE_INVALID", "mode", String(mode)));
  const lane = selectedLane(requestedLanes);
  if (lane === null) findings.push(finding("DISK_SPACE_LANE_SELECTION_INVALID", "requested_lanes", requestedLanes));
  const policy = loadedPolicy?.policy;
  const measurement = loadedPolicy?.measurement;
  const custody = loadedPolicy?.custody ?? {};
  findings.push(...validatePolicySemantics(policy, measurement));
  const rawSealed = custody.raw_manifests && Object.values(custody.raw_manifests).length === 4 &&
    Object.values(custody.raw_manifests).every((item) => item.sealed === true && SHA256.test(String(item.sha256 ?? "")));
  const rawRecomputed = custody.raw_recomputation?.status === "PASS" &&
    custody.raw_recomputation?.sample_count >= 60 &&
    custody.raw_recomputation?.sample_manifest_sha256 ===
      custody.raw_manifests?.sample_receipts?.sha256 &&
    OBSERVED_COHORT_IDS.every((name) =>
      custody.raw_recomputation?.corpus_manifest_sha256?.[name] ===
        custody.raw_manifests?.[name]?.sha256);
  if (mode === "candidate" && (
    policy?.policy_status !== "SEALED_MEASURED" || policy?.lower_override_action !== "REFUSE" ||
    custody.policy_sealed !== true || custody.policy_sha256 !== custody.expected_policy_sha256 ||
    custody.policy_schema_sealed !== true || !SHA256.test(String(custody.policy_schema_sha256 ?? "")) ||
    custody.measurement_evidence_sealed !== true || custody.measurement_schema_sealed !== true ||
    !rawSealed || !rawRecomputed
  )) {
    findings.push(finding("DISK_SPACE_CANDIDATE_POLICY_UNSEALED", "loaded_policy.custody", "candidate requires sealed policy, schema, measurement, raw manifests and independently recomputed raw samples"));
  }
  const declared = lane === null ? declaredRequirements(null, null) : declaredRequirements(policy, lane);
  let required = structuredClone(declared);
  if (overrideMinFreeBytes !== null) {
    if (!Number.isSafeInteger(overrideMinFreeBytes) || overrideMinFreeBytes < 1) {
      findings.push(finding("DISK_SPACE_OVERRIDE_INVALID", "override_min_free_bytes", overrideMinFreeBytes));
    } else {
      const declaredValues = [declared.distinct_volumes.work_root, declared.distinct_volumes.temp_root, declared.shared_volume];
      if (declaredValues.some((value) => Number.isSafeInteger(value) && overrideMinFreeBytes < value)) {
        findings.push(finding("DISK_SPACE_OVERRIDE_BELOW_POLICY", "override_min_free_bytes", { override_bytes: overrideMinFreeBytes, policy_requirements: declared }));
      } else {
        required = { distinct_volumes: { work_root: overrideMinFreeBytes, temp_root: overrideMinFreeBytes }, shared_volume: overrideMinFreeBytes };
      }
    }
  }
  const valid = {};
  for (const rootId of ["work_root", "temp_root"]) {
    const observation = observations?.[rootId];
    valid[rootId] = safeByteInteger(observation?.available_bytes) && validVolumeIdentity(observation?.volume_identity);
    if (!valid[rootId]) findings.push(finding("DISK_SPACE_ROOT_OBSERVATION_INVALID", `observations.${rootId}`, "available bytes and complete volume identity are required"));
  }
  const sameDevice = valid.work_root && valid.temp_root &&
    observations.work_root.volume_identity.device_id === observations.temp_root.volume_identity.device_id;
  let topology = sameDevice ? "shared_volume" : "distinct_volumes";
  if (sameDevice && !same(observations.work_root.volume_identity, observations.temp_root.volume_identity)) {
    findings.push(finding("DISK_SPACE_SHARED_VOLUME_IDENTITY_MISMATCH", "observations", "same device_id has inconsistent filesystem identity"));
  }
  if (sameDevice && observations.work_root.available_bytes !== observations.temp_root.available_bytes) {
    findings.push(finding("DISK_SPACE_SHARED_VOLUME_AVAILABLE_MISMATCH", "observations", "same volume must have one stable free-byte observation"));
  }
  const roots = {};
  for (const rootId of ["work_root", "temp_root"]) {
    const requiredBytes = topology === "shared_volume" ? required.shared_volume : required.distinct_volumes[rootId];
    const available = valid[rootId] ? observations[rootId].available_bytes : null;
    const headroom = Number.isSafeInteger(available) && Number.isSafeInteger(requiredBytes) ? available - requiredBytes : null;
    roots[rootId] = Object.freeze({
      available_bytes: available,
      required_bytes: requiredBytes,
      headroom_bytes: headroom,
      status: headroom === null ? "UNKNOWN" : headroom >= 0 ? "PASS" : "REFUSED",
      volume_identity: valid[rootId] ? Object.freeze({ ...observations[rootId].volume_identity }) : null,
    });
    if (headroom !== null && headroom < 0) findings.push(finding("DISK_SPACE_INSUFFICIENT_FREE_BYTES", `observations.${rootId}.available_bytes`, { available_bytes: available, required_bytes: requiredBytes, headroom_bytes: headroom }));
  }
  return Object.freeze({
    schema_version: DISK_SPACE_EVALUATION_SCHEMA_VERSION,
    status: findings.length === 0 ? "PASS" : "REFUSED",
    mode,
    requested_lanes: Array.isArray(requestedLanes) ? Object.freeze([...new Set(requestedLanes)].sort()) : [],
    selected_lane: lane,
    selected_volume_topology: topology,
    observed_at: observedAt,
    policy_floor_bytes: Object.freeze(declared),
    override_min_free_bytes:
      Number.isSafeInteger(overrideMinFreeBytes) && overrideMinFreeBytes >= 1
        ? overrideMinFreeBytes
        : null,
    required_free_bytes: Object.freeze(required),
    roots: Object.freeze(roots),
    policy_evidence: Object.freeze({
      policy_schema_version: policy?.schema_version ?? null,
      policy_schema_sha256: custody.policy_schema_sha256 ?? null,
      policy_sha256: custody.policy_sha256 ?? null,
      policy_sealed: custody.policy_sealed === true,
      measurement_evidence_sha256: custody.measurement_evidence_sha256 ?? null,
      measurement_schema_version: measurement?.schema_version ?? null,
      measurement_schema_sha256: custody.measurement_schema_sha256 ?? null,
      raw_manifest_sha256: Object.freeze(Object.fromEntries(
        Object.entries(custody.raw_manifests ?? {}).map(([name, value]) => [name, value.sha256]),
      )),
    }),
    total_violations: findings.length,
    findings: Object.freeze(findings),
  });
}

export default {
  DISK_SPACE_POLICY_SCHEMA_VERSION,
  DISK_SPACE_MEASUREMENT_SCHEMA_VERSION,
  DISK_SPACE_EVALUATION_SCHEMA_VERSION,
  DiskSpacePolicyError,
  loadDiskSpacePolicySchema,
  loadDiskSpaceMeasurementSchema,
  validateDiskSpaceMeasurementContract,
  validateDiskSpacePolicyContract,
  loadDiskSpacePolicy,
  evaluateDiskSpacePolicy,
};
