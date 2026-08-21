/**
 * Independent raw-evidence compiler for disk-space measurement cohorts.
 *
 * The production measurement may describe medians, p95s and maxima, but it may
 * not author them. This module reopens every hash-bound raw sample receipt,
 * recomputes the statistics and requires the distilled measurement to agree.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./json_schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE_MANIFEST_SCHEMA = path.resolve(
  HERE, "..", "..", "assets", "disk-space-sample-receipt-manifest-v1.schema.json",
);
const DEFAULT_CORPUS_MANIFEST_SCHEMA = path.resolve(
  HERE, "..", "..", "assets", "disk-space-corpus-manifest-v1.schema.json",
);

export const DISK_SPACE_SAMPLE_MANIFEST_VERSION =
  "excel-inflow-disk-space-sample-receipt-manifest/1.2";
export const DISK_SPACE_RESOURCE_SAMPLE_VERSION =
  "excel-inflow-component-resource-sample-portable/1.0";
export const DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION =
  "excel-inflow-component-resource-sample/1.0";
export const DISK_SPACE_PORTABLE_PROJECTION_VERSION =
  "excel-inflow-disk-space-path-portable-projection/1.0";
export const DISK_SPACE_CORPUS_MANIFEST_VERSION =
  "excel-inflow-disk-space-corpus-manifest/1.1";
export const DISK_SPACE_COHORTS = Object.freeze(["filings", "brokers", "workbook"]);
export const DISK_SPACE_ROOTS = Object.freeze([
  "work_root", "temp_root", "shared_volume_total",
]);

const SHA256 = /^[a-f0-9]{64}$/;
export const DISK_SPACE_RESOURCE_COHORT_MAP = Object.freeze({
  filings: "real-astra-filings",
  brokers: "broker-82-pages",
  workbook: "standard-maximal-workbook",
});
export const DISK_SPACE_FROZEN_MEASUREMENT_SOURCE = Object.freeze({
  commit: "e8eb91f958e1f7c12007a27ffd01be159799772f",
  tree: "cd27d731cb74320b54dd3f0cbad4b286d686aee0",
  working_source_digest_sha256: "ae19458df80ed55f7f64914ab3b8efae859f32603ac42dd9a5c37822d59aa562",
  file_count: 900,
  worktree_status_bytes: 0,
  worktree_status_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
});

export class DiskSpaceRawEvidenceError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "DiskSpaceRawEvidenceError";
    this.code = code;
    this.detail = detail;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalise(value), null, 2)}\n`, "utf8");
}

const FORBIDDEN_LOCAL_METADATA = Object.freeze([
  { id: "posix-absolute", pattern: /(?:^|[\s"'=])\/(?!\/)[^\s"']+/ },
  { id: "posix-home", pattern: /(?:^|[\s"'=])\/(?:Users|home)\//i },
  { id: "posix-temp", pattern: /(?:^|[\s"'=])\/(?:private\/)?(?:var\/folders|tmp)(?:\/|\b)/i },
  { id: "posix-host-volume", pattern: /(?:^|[\s"'=])\/(?:dev|System\/Volumes)(?:\/|\b)/i },
  { id: "home-shortcut", pattern: /(?:^|[\s"'=])~[\\/]/ },
  { id: "windows-drive-absolute", pattern: /(?:^|[\s"'=])[A-Za-z]:[\\/]/ },
  { id: "windows-drive-relative", pattern: /(?:^|[\s"'=])[A-Za-z]:(?![\\/\s])/ },
  { id: "windows-unc", pattern: /(?:^|[\s"'=])\\\\[^\\\s]+\\/ },
  { id: "author-username", pattern: /archiepreston/i },
  { id: "author-workspace", pattern: /Documents[\\/]Codex/i },
]);

function forbiddenLocalMetadata(value) {
  if (typeof value !== "string") return null;
  return FORBIDDEN_LOCAL_METADATA.find((rule) => rule.pattern.test(value))?.id ?? null;
}

function walkStrings(value, visit, pointer = "") {
  if (typeof value === "string") return visit(value, pointer);
  if (Array.isArray(value)) return value.map((item, index) => walkStrings(item, visit, `${pointer}/${index}`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      walkStrings(item, visit, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`),
    ]));
  }
  return value;
}

function assertPortableStrings(value, label) {
  const findings = [];
  walkStrings(value, (text, pointer) => {
    const rule = forbiddenLocalMetadata(text);
    if (rule) findings.push({ pointer, rule });
    return text;
  });
  if (findings.length > 0) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_PORTABLE_PATH_VIOLATION",
      `${label} contains ${findings.length} host-specific path or local-metadata value(s).`,
      { findings },
    );
  }
}

function projectionSelfHash(receipt) {
  const unsigned = structuredClone(receipt);
  delete unsigned.portable_projection.projection_sha256;
  return digest(canonicalBytes(unsigned));
}

export function projectPortableDiskSpaceResourceSample(rawBytes) {
  const sourceBytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  const source = parseJson(sourceBytes, "source resource sample");
  if (source?.schema_version !== DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_SOURCE_SAMPLE_SCHEMA_INVALID",
      "Portable projection requires an original component resource-sample/1.0 receipt.",
    );
  }
  const sensitive = new Set();
  walkStrings(source, (text) => {
    if (forbiddenLocalMetadata(text)) sensitive.add(text);
    return text;
  });
  const tokens = new Map([...sensitive].sort().map((text, index) => [text, `portable://local/${String(index + 1).padStart(4, "0")}`]));
  const projected = walkStrings(structuredClone(source), (text) => tokens.get(text) ?? text);
  projected.schema_version = DISK_SPACE_RESOURCE_SAMPLE_VERSION;
  projected.portable_projection = {
    contract_version: DISK_SPACE_PORTABLE_PROJECTION_VERSION,
    source_schema_version: DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION,
    source_receipt_sha256: digest(sourceBytes),
    redacted_value_count: tokens.size,
    projection_sha256: null,
  };
  projected.portable_projection.projection_sha256 = projectionSelfHash(projected);
  assertPortableStrings(projected, "portable resource sample projection");
  return Object.freeze({
    value: Object.freeze(projected),
    bytes: canonicalBytes(projected),
    source_receipt_sha256: projected.portable_projection.source_receipt_sha256,
    projection_sha256: projected.portable_projection.projection_sha256,
    redacted_value_count: tokens.size,
  });
}

async function writePortableJson(target, value) {
  const bytes = canonicalBytes(value);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: "wx" });
  return Object.freeze({ bytes, sha256: digest(bytes) });
}

async function copyBoundFile(sourceRoot, outputRoot, pointer, label) {
  const source = await boundBytes(sourceRoot, pointer, label);
  const target = path.resolve(outputRoot, pointer.path);
  const relative = path.relative(outputRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DiskSpaceRawEvidenceError("DISK_SPACE_PORTABLE_OUTPUT_ESCAPE", `${label} output escapes the bundle.`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source.bytes, { flag: "wx" });
  return source;
}

export async function compilePortableDiskSpaceEvidenceBundle({
  sourceBundleRoot,
  outputRoot,
  policySchemaPath = path.resolve(HERE, "..", "..", "assets", "disk-space-policy-v1.schema.json"),
} = {}) {
  const sourceRoot = path.resolve(String(sourceBundleRoot));
  const targetRoot = path.resolve(String(outputRoot));
  if (sourceRoot === targetRoot) {
    throw new DiskSpaceRawEvidenceError("DISK_SPACE_PORTABLE_OUTPUT_ALIASES_SOURCE", "Portable bundle output must be a new directory.");
  }
  await fs.mkdir(targetRoot, { recursive: true });
  if ((await fs.readdir(targetRoot)).length !== 0) {
    throw new DiskSpaceRawEvidenceError("DISK_SPACE_PORTABLE_OUTPUT_NOT_EMPTY", "Portable bundle output directory must be empty.");
  }

  const sourceManifestBytes = await stableRegularBytes(path.join(sourceRoot, "sample-receipts.json"));
  const sourceManifest = parseJson(sourceManifestBytes, "source sample receipt manifest");
  if (sourceManifest?.schema_version !== "excel-inflow-disk-space-sample-receipt-manifest/1.1" ||
      !Array.isArray(sourceManifest.samples) || sourceManifest.samples.length !== 60) {
    throw new DiskSpaceRawEvidenceError("DISK_SPACE_SOURCE_MANIFEST_INVALID", "Source bundle must contain the frozen 60-receipt raw manifest/1.1.");
  }

  const corpora = {};
  for (const cohortId of DISK_SPACE_COHORTS) {
    const copied = await copyBoundFile(sourceRoot, targetRoot, sourceManifest.corpora[cohortId], `${cohortId} corpus`);
    const value = parseJson(copied.bytes, `${cohortId} corpus`);
    assertPortableStrings(value, `${cohortId} corpus`);
    corpora[cohortId] = { ...sourceManifest.corpora[cohortId] };
  }

  const pointers = [];
  let redactedValueCount = 0;
  for (const pointer of sourceManifest.samples) {
    if (pointer.resource_sample_schema_version !== DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION) {
      throw new DiskSpaceRawEvidenceError("DISK_SPACE_SOURCE_SAMPLE_SCHEMA_INVALID", `Source pointer ${pointer.sample_id} is not raw resource-sample/1.0.`);
    }
    const raw = await boundBytes(sourceRoot, pointer, `source sample ${pointer.sample_id}`);
    const projection = projectPortableDiskSpaceResourceSample(raw.bytes);
    const target = path.resolve(targetRoot, pointer.path);
    const relative = path.relative(targetRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new DiskSpaceRawEvidenceError("DISK_SPACE_PORTABLE_OUTPUT_ESCAPE", `Sample ${pointer.sample_id} output escapes the bundle.`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, projection.bytes, { flag: "wx" });
    redactedValueCount += projection.redacted_value_count;
    pointers.push({
      sample_id: pointer.sample_id,
      cohort_id: pointer.cohort_id,
      resource_cohort_id: pointer.resource_cohort_id,
      resource_sample_id: pointer.resource_sample_id,
      path: pointer.path,
      sha256: digest(projection.bytes),
      resource_sample_schema_version: DISK_SPACE_RESOURCE_SAMPLE_VERSION,
      source_resource_sample_schema_version: DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION,
      source_receipt_sha256: projection.source_receipt_sha256,
    });
  }

  const manifest = {
    schema_version: DISK_SPACE_SAMPLE_MANIFEST_VERSION,
    generated_at: sourceManifest.generated_at,
    corpora,
    samples: pointers,
  };
  const manifestWritten = await writePortableJson(path.join(targetRoot, "sample-receipts.json"), manifest);

  const sourceMeasurementBytes = await stableRegularBytes(path.join(sourceRoot, "disk-space-measurement.json"));
  const measurement = parseJson(sourceMeasurementBytes, "source disk-space measurement");
  measurement.evidence_manifests.sample_receipts = {
    path: "sample-receipts.json",
    sha256: manifestWritten.sha256,
    schema_version: DISK_SPACE_SAMPLE_MANIFEST_VERSION,
  };
  measurement.host_identity = {
    ...measurement.host_identity,
    os_release: "PORTABLE_PROJECTION_REDACTED",
  };
  assertPortableStrings(measurement, "portable disk-space measurement");
  const measurementWritten = await writePortableJson(path.join(targetRoot, "disk-space-measurement.json"), measurement);

  const measurementSchemaBytes = await stableRegularBytes(path.join(sourceRoot, "disk-space-measurement-v1.schema.json"));
  await fs.writeFile(path.join(targetRoot, "disk-space-measurement-v1.schema.json"), measurementSchemaBytes, { flag: "wx" });

  const sourcePolicyBytes = await stableRegularBytes(path.join(sourceRoot, "disk-space-policy.json"));
  const policy = parseJson(sourcePolicyBytes, "source disk-space policy");
  policy.measurement_evidence.sha256 = measurementWritten.sha256;
  policy.measurement_evidence.sample_receipt_manifest_sha256 = manifestWritten.sha256;
  policy.measurement_evidence.schema_sha256 = digest(measurementSchemaBytes);
  policy.policy_schema_sha256 = digest(await stableRegularBytes(path.resolve(policySchemaPath)));
  assertPortableStrings(policy, "portable disk-space policy");
  const policyWritten = await writePortableJson(path.join(targetRoot, "disk-space-policy.json"), policy);

  const recomputed = await recomputeDiskSpaceObservedCohorts({
    sampleManifestPath: path.join(targetRoot, "sample-receipts.json"),
  });
  assertMeasurementObservedCohortsMatchRaw({ measurement, recomputed });
  return Object.freeze({
    status: "PASS",
    total_violations: 0,
    source_sample_manifest_sha256: digest(sourceManifestBytes),
    portable_sample_manifest_sha256: manifestWritten.sha256,
    measurement_sha256: measurementWritten.sha256,
    policy_sha256: policyWritten.sha256,
    sample_count: pointers.length,
    redacted_value_count: redactedValueCount,
    observed_cohorts: recomputed.observed_cohorts,
  });
}

export function assertPortableDiskSpaceArtifact(value, label = "disk-space artifact") {
  assertPortableStrings(value, label);
  return Object.freeze({ status: "PASS", total_violations: 0 });
}

function validatePortableProjection(receipt, pointer) {
  const projection = receipt?.portable_projection;
  const portableTokens = new Set();
  walkStrings(receipt, (text) => {
    if (/^portable:\/\/local\/[0-9]{4}$/.test(text)) portableTokens.add(text);
    return text;
  });
  if (!exactKeys(projection, [
    "contract_version", "source_schema_version", "source_receipt_sha256",
    "redacted_value_count", "projection_sha256",
  ]) || projection.contract_version !== DISK_SPACE_PORTABLE_PROJECTION_VERSION ||
      projection.source_schema_version !== DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION ||
      !SHA256.test(String(projection.source_receipt_sha256)) ||
      !Number.isSafeInteger(projection.redacted_value_count) || projection.redacted_value_count < 1 ||
      portableTokens.size !== projection.redacted_value_count ||
      !SHA256.test(String(projection.projection_sha256)) ||
      projection.projection_sha256 !== projectionSelfHash(receipt) ||
      projection.source_receipt_sha256 !== pointer.source_receipt_sha256 ||
      pointer.source_resource_sample_schema_version !== DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_PORTABLE_PROJECTION_INVALID",
      `Sample ${pointer.sample_id} has an invalid or unbound portable projection receipt.`,
    );
  }
  assertPortableStrings(receipt, `sample ${pointer.sample_id}`);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonicalise(left)) === JSON.stringify(canonicalise(right));
}

function unsafeRelative(value) {
  return typeof value !== "string" || value.length === 0 ||
    path.isAbsolute(value) || path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) || /^[/\\]{2}/.test(value) ||
    value.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..");
}

async function stableRegularBytes(target) {
  const before = await fs.lstat(target).catch((error) => {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_EVIDENCE_MISSING",
      `Raw disk evidence is unavailable: ${error.code ?? error.message}.`,
      { target },
    );
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_EVIDENCE_UNSAFE",
      "Raw disk evidence must be one regular non-symlink file.",
      { target },
    );
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const finalPath = await fs.lstat(target);
    if (
      !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs || after.dev !== finalPath.dev ||
      after.ino !== finalPath.ino || finalPath.isSymbolicLink()
    ) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_RAW_EVIDENCE_UNSTABLE",
        "Raw disk evidence changed identity or bytes during read.",
        { target },
      );
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function boundBytes(root, pointer, label) {
  if (!pointer || unsafeRelative(pointer.path) || !SHA256.test(String(pointer.sha256 ?? ""))) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_POINTER_INVALID",
      `${label} must carry one safe relative path and SHA-256.`,
      { pointer },
    );
  }
  const canonicalRoot = await fs.realpath(root);
  const segments = pointer.path.split(/[\\/]/);
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const metadata = await fs.lstat(ancestor).catch((error) => {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_RAW_EVIDENCE_MISSING",
        `${label} ancestor is unavailable: ${error.code ?? error.message}.`,
        { ancestor },
      );
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_RAW_POINTER_ANCESTOR_UNSAFE",
        `${label} contains a non-directory or symlink ancestor.`,
        { ancestor },
      );
    }
  }
  const target = path.resolve(root, ...segments);
  const canonicalTarget = await fs.realpath(target).catch((error) => {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_EVIDENCE_MISSING",
      `${label} is unavailable: ${error.code ?? error.message}.`,
      { target },
    );
  });
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_POINTER_ESCAPE",
      `${label} escapes the manifest directory.`,
      { target },
    );
  }
  const bytes = await stableRegularBytes(target);
  const sha256 = digest(bytes);
  if (sha256 !== pointer.sha256) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_HASH_MISMATCH",
      `${label} bytes do not match the declared SHA-256.`,
      { target, declared_sha256: pointer.sha256, observed_sha256: sha256 },
    );
  }
  return { target, bytes, sha256 };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_JSON_INVALID",
      `${label} is not JSON: ${error.message}.`,
    );
  }
}

function schemaAssert(value, schema, label) {
  const findings = validateJsonSchema(value, schema);
  if (findings.length > 0) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RAW_SCHEMA_INVALID",
      `${label} violates its schema.`,
      { findings },
    );
  }
}

function validateCorpusSemantics(corpus, expectedCohort) {
  if (
    corpus.workload_kind !== expectedCohort ||
    corpus.resource_cohort_id !== DISK_SPACE_RESOURCE_COHORT_MAP[expectedCohort]
  ) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_CORPUS_COHORT_MISMATCH",
      `Corpus ${corpus.corpus_id} does not map ${expectedCohort} to the frozen resource cohort.`,
    );
  }
  const ids = new Set();
  for (const source of corpus.sources) {
    if (ids.has(source.source_id)) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_CORPUS_DUPLICATE_SOURCE",
        `Corpus ${corpus.corpus_id} repeats source ${source.source_id}.`,
      );
    }
    ids.add(source.source_id);
  }
}

function validateResourceSourceIdentity(receipt, pointer) {
  for (const field of ["source_pre", "source_post"]) {
    if (!same(receipt[field], DISK_SPACE_FROZEN_MEASUREMENT_SOURCE)) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_RESOURCE_SAMPLE_SOURCE_MISMATCH",
        `Sample ${pointer.sample_id} ${field} is not the frozen e8eb measurement source.`,
      );
    }
  }
  if (!same(receipt.source_pre, receipt.source_post) || receipt.source_stable_and_clean !== true) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RESOURCE_SAMPLE_SOURCE_UNSTABLE",
      `Sample ${pointer.sample_id} changed source identity during measurement.`,
    );
  }
}

function validateResourceInputs(receipt, pointer) {
  if (
    receipt.inputs_stable_and_bound !== true ||
    !Array.isArray(receipt.input_pre) || receipt.input_pre.length === 0 ||
    !same(receipt.input_pre, receipt.input_post)
  ) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RESOURCE_SAMPLE_INPUT_UNSTABLE",
      `Sample ${pointer.sample_id} input custody did not close before and after execution.`,
    );
  }
  for (const item of receipt.input_pre) {
    if (
      item?.matches !== true || !SHA256.test(String(item?.actual_sha256 ?? "")) ||
      item.actual_sha256 !== item.expected_sha256 ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
      typeof item.path !== "string" || item.path.length === 0
    ) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_RESOURCE_SAMPLE_INPUT_UNBOUND",
        `Sample ${pointer.sample_id} contains an input not bound to its expected bytes.`,
      );
    }
  }
}

function validateResourceTopology(receipt, pointer) {
  if (receipt.same_volume !== true) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RESOURCE_SAMPLE_TOPOLOGY_INVALID",
      `Sample ${pointer.sample_id} is not an observed same-volume measurement.`,
    );
  }
  const volumes = [
    receipt.run_volume_pre, receipt.run_volume_post,
    receipt.temp_volume_pre, receipt.temp_volume_post,
  ];
  const deviceId = volumes[0]?.device_id;
  const blockSize = volumes[0]?.block_size;
  if (
    typeof deviceId !== "string" || deviceId.length === 0 ||
    !Number.isSafeInteger(blockSize) || blockSize < 1 ||
    volumes.some((volume) =>
      volume?.device_id !== deviceId || volume?.block_size !== blockSize ||
      volume?.df_exit_code !== 0)
  ) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RESOURCE_SAMPLE_TOPOLOGY_INVALID",
      `Sample ${pointer.sample_id} has inconsistent run/temp device identity.`,
    );
  }
}

function deriveResourcePeaks(receipt, pointer) {
  if (!Array.isArray(receipt.samples) || receipt.samples.length === 0 ||
      receipt.sample_count !== receipt.samples.length) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RESOURCE_SAMPLE_SERIES_INVALID",
      `Sample ${pointer.sample_id} has no complete raw observation series.`,
    );
  }
  const run = [];
  const temp = [];
  const shared = [];
  for (const observation of receipt.samples) {
    const runBytes = observation?.run?.allocated_bytes;
    const tempBytes = observation?.temp?.allocated_bytes;
    if (
      !Number.isSafeInteger(runBytes) || runBytes < 0 ||
      !Number.isSafeInteger(tempBytes) || tempBytes < 0
    ) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_RESOURCE_SAMPLE_SERIES_INVALID",
        `Sample ${pointer.sample_id} has an invalid allocated-byte observation.`,
      );
    }
    run.push(runBytes);
    temp.push(tempBytes);
    shared.push(runBytes + tempBytes);
  }
  const peaks = Object.freeze({
    work_root: Math.max(...run),
    temp_root: Math.max(...temp),
    shared_volume_total: Math.max(...shared),
  });
  if (
    receipt?.peak?.run?.allocated_bytes !== peaks.work_root ||
    receipt?.peak?.temp?.allocated_bytes !== peaks.temp_root ||
    receipt?.peak?.same_volume_total?.allocated_bytes !== peaks.shared_volume_total
  ) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RESOURCE_SAMPLE_PEAK_MISMATCH",
      `Sample ${pointer.sample_id} summary peak disagrees with its raw observation series.`,
      { derived: peaks },
    );
  }
  return peaks;
}

function validateResourceSample(receipt, pointer, corpusHash) {
  if (
    receipt.schema_version !== DISK_SPACE_RESOURCE_SAMPLE_VERSION ||
    receipt.schema_version !== pointer.resource_sample_schema_version ||
    receipt.sample_id !== pointer.resource_sample_id ||
    receipt.cohort_id !== pointer.resource_cohort_id ||
    pointer.sample_id !== `${pointer.resource_cohort_id}/${pointer.resource_sample_id}` ||
    pointer.resource_cohort_id !== DISK_SPACE_RESOURCE_COHORT_MAP[pointer.cohort_id]
  ) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_SAMPLE_IDENTITY_MISMATCH",
      `Sample pointer, measurement cohort and resource receipt identity disagree for ${pointer.sample_id}.`,
    );
  }
  validatePortableProjection(receipt, pointer);
  if (!SHA256.test(String(corpusHash ?? ""))) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_SAMPLE_CORPUS_HASH_MISMATCH",
      `Sample ${pointer.sample_id} has no hash-bound cohort corpus manifest.`,
    );
  }
  if (
    receipt.status !== "PASS" || receipt.exit_code !== 0 || receipt.timed_out !== false ||
    receipt?.assertions?.pass !== true
  ) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_RESOURCE_SAMPLE_NOT_PASS",
      `Sample ${pointer.sample_id} is not a successful resource measurement.`,
    );
  }
  validateResourceSourceIdentity(receipt, pointer);
  validateResourceInputs(receipt, pointer);
  validateResourceTopology(receipt, pointer);
  return deriveResourcePeaks(receipt, pointer);
}

function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_STATISTIC_EMPTY",
      "A cohort statistic cannot be computed from zero samples.",
    );
  }
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * ordered.length));
  return ordered[rank - 1];
}

function observedStats(values) {
  return Object.freeze({
    statistic_kind: "OBSERVED",
    sample_count: values.length,
    median_bytes: nearestRank(values, 0.5),
    p95_bytes: nearestRank(values, 0.95),
    observed_max_bytes: Math.max(...values),
  });
}

export async function recomputeDiskSpaceObservedCohorts({
  sampleManifestPath,
  sampleManifestSchemaPath = DEFAULT_SAMPLE_MANIFEST_SCHEMA,
  corpusManifestSchemaPath = DEFAULT_CORPUS_MANIFEST_SCHEMA,
  minimumSamplesPerCohort = 20,
} = {}) {
  if (!Number.isSafeInteger(minimumSamplesPerCohort) || minimumSamplesPerCohort < 20) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_MINIMUM_SAMPLE_RULE_INVALID",
      "At least 20 independently referenced samples are required per observed cohort.",
    );
  }
  const manifestTarget = path.resolve(String(sampleManifestPath));
  const [manifestBytes, sampleSchemaBytes, corpusSchemaBytes] = await Promise.all([
    stableRegularBytes(manifestTarget),
    stableRegularBytes(path.resolve(sampleManifestSchemaPath)),
    stableRegularBytes(path.resolve(corpusManifestSchemaPath)),
  ]);
  const manifest = parseJson(manifestBytes, "sample receipt manifest");
  const sampleSchema = parseJson(sampleSchemaBytes, "sample receipt manifest schema");
  const corpusSchema = parseJson(corpusSchemaBytes, "corpus manifest schema");
  schemaAssert(manifest, sampleSchema, "sample receipt manifest");
  const root = path.dirname(manifestTarget);

  const corpora = {};
  for (const cohortId of DISK_SPACE_COHORTS) {
    const bound = await boundBytes(root, manifest.corpora[cohortId], `${cohortId} corpus manifest`);
    const corpus = parseJson(bound.bytes, `${cohortId} corpus manifest`);
    schemaAssert(corpus, corpusSchema, `${cohortId} corpus manifest`);
    validateCorpusSemantics(corpus, cohortId);
    corpora[cohortId] = Object.freeze({ ...bound, value: corpus });
  }

  const sampleIds = new Set();
  const samplePaths = new Set();
  const observations = Object.fromEntries(DISK_SPACE_COHORTS.map((cohort) => [
    cohort,
    Object.fromEntries(DISK_SPACE_ROOTS.map((rootId) => [rootId, []])),
  ]));
  const samples = [];
  for (const pointer of manifest.samples) {
    if (sampleIds.has(pointer.sample_id) || samplePaths.has(pointer.path)) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_SAMPLE_DUPLICATE",
        `Sample ${pointer.sample_id} or its receipt path appears more than once.`,
      );
    }
    sampleIds.add(pointer.sample_id);
    samplePaths.add(pointer.path);
    const bound = await boundBytes(root, pointer, `sample ${pointer.sample_id}`);
    const receipt = parseJson(bound.bytes, `sample ${pointer.sample_id}`);
    const peaks = validateResourceSample(receipt, pointer, corpora[pointer.cohort_id].sha256);
    for (const rootId of DISK_SPACE_ROOTS) {
      observations[pointer.cohort_id][rootId].push(peaks[rootId]);
    }
    samples.push(Object.freeze({
      sample_id: pointer.sample_id,
      cohort_id: pointer.cohort_id,
      path: bound.target,
      sha256: bound.sha256,
    }));
  }

  const observedCohorts = {};
  for (const cohortId of DISK_SPACE_COHORTS) {
    const count = observations[cohortId].work_root.length;
    if (count < minimumSamplesPerCohort) {
      throw new DiskSpaceRawEvidenceError(
        "DISK_SPACE_OBSERVED_COHORT_TOO_SMALL",
        `Cohort ${cohortId} has ${count} raw samples; ${minimumSamplesPerCohort} are required.`,
      );
    }
    observedCohorts[cohortId] = Object.freeze({
      cohort_id: cohortId,
      workload_kind: cohortId,
      corpus_manifest_ref: `#/evidence_manifests/corpora/${cohortId}`,
      sample_receipt_manifest_ref: "#/evidence_manifests/sample_receipts",
      sample_count: count,
      root_statistics: Object.freeze(Object.fromEntries(
        DISK_SPACE_ROOTS.map((rootId) => [rootId, observedStats(observations[cohortId][rootId])]),
      )),
    });
  }
  return Object.freeze({
    schema_version: "excel-inflow-disk-space-raw-recomputation/1.0",
    sample_manifest_sha256: digest(manifestBytes),
    sample_manifest_schema_sha256: digest(sampleSchemaBytes),
    corpus_manifest_schema_sha256: digest(corpusSchemaBytes),
    corpus_manifest_sha256: Object.freeze(Object.fromEntries(
      DISK_SPACE_COHORTS.map((cohortId) => [cohortId, corpora[cohortId].sha256]),
    )),
    observed_cohorts: Object.freeze(observedCohorts),
    samples: Object.freeze(samples.sort((left, right) =>
      left.sample_id.localeCompare(right.sample_id))),
  });
}

export function assertMeasurementObservedCohortsMatchRaw({ measurement, recomputed }) {
  const findings = [];
  const samplePointer = measurement?.evidence_manifests?.sample_receipts;
  if (
    samplePointer?.schema_version !== DISK_SPACE_SAMPLE_MANIFEST_VERSION ||
    samplePointer?.sha256 !== recomputed?.sample_manifest_sha256
  ) {
    findings.push(Object.freeze({
      code: "DISK_SPACE_MEASUREMENT_SAMPLE_MANIFEST_MISMATCH",
      path: "measurement.evidence_manifests.sample_receipts",
      expected_schema_version: DISK_SPACE_SAMPLE_MANIFEST_VERSION,
      expected_sha256: recomputed?.sample_manifest_sha256,
      observed: samplePointer,
    }));
  }
  for (const cohortId of DISK_SPACE_COHORTS) {
    const corpusPointer = measurement?.evidence_manifests?.corpora?.[cohortId];
    if (
      corpusPointer?.schema_version !== DISK_SPACE_CORPUS_MANIFEST_VERSION ||
      corpusPointer?.sha256 !== recomputed?.corpus_manifest_sha256?.[cohortId]
    ) {
      findings.push(Object.freeze({
        code: "DISK_SPACE_MEASUREMENT_CORPUS_MANIFEST_MISMATCH",
        path: `measurement.evidence_manifests.corpora.${cohortId}`,
        expected_schema_version: DISK_SPACE_CORPUS_MANIFEST_VERSION,
        expected_sha256: recomputed?.corpus_manifest_sha256?.[cohortId],
        observed: corpusPointer,
      }));
    }
  }
  for (const cohortId of DISK_SPACE_COHORTS) {
    const observed = measurement?.observed_cohorts?.[cohortId];
    const expected = recomputed?.observed_cohorts?.[cohortId];
    if (!same(observed, expected)) {
      findings.push(Object.freeze({
        code: "DISK_SPACE_MEASUREMENT_RAW_RECOMPUTATION_MISMATCH",
        path: `measurement.observed_cohorts.${cohortId}`,
        expected,
        observed,
      }));
    }
  }
  if (findings.length > 0) {
    throw new DiskSpaceRawEvidenceError(
      "DISK_SPACE_MEASUREMENT_RAW_RECOMPUTATION_MISMATCH",
      `Measurement disagrees with raw recomputation for ${findings.length} cohort(s).`,
      { findings },
    );
  }
  return Object.freeze({
    status: "PASS",
    total_violations: 0,
    sample_manifest_sha256: recomputed.sample_manifest_sha256,
    observed_cohorts: recomputed.observed_cohorts,
  });
}

export default {
  DISK_SPACE_SAMPLE_MANIFEST_VERSION,
  DISK_SPACE_RESOURCE_SAMPLE_VERSION,
  DISK_SPACE_SOURCE_RESOURCE_SAMPLE_VERSION,
  DISK_SPACE_PORTABLE_PROJECTION_VERSION,
  DISK_SPACE_CORPUS_MANIFEST_VERSION,
  DISK_SPACE_COHORTS,
  DISK_SPACE_ROOTS,
  DISK_SPACE_RESOURCE_COHORT_MAP,
  DISK_SPACE_FROZEN_MEASUREMENT_SOURCE,
  DiskSpaceRawEvidenceError,
  projectPortableDiskSpaceResourceSample,
  compilePortableDiskSpaceEvidenceBundle,
  assertPortableDiskSpaceArtifact,
  recomputeDiskSpaceObservedCohorts,
  assertMeasurementObservedCohortsMatchRaw,
};
