#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DiskSpacePolicyError,
  evaluateDiskSpacePolicy,
  loadDiskSpaceMeasurementSchema,
  loadDiskSpacePolicy,
  loadDiskSpacePolicySchema,
  validateDiskSpaceMeasurementContract,
  validateDiskSpacePolicyContract,
} from "./lib/disk_space_policy.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "disk-space-policy-v11-tests-"));
const policySchemaPath = path.join(ROOT, "assets", "disk-space-policy-v1.schema.json");
const measurementSchemaPath = path.join(ROOT, "assets", "disk-space-measurement-v1.schema.json");
const SHA = "a".repeat(64);
const measuredSourceIdentity = Object.freeze({
  repository: "computering001/excel-inflow",
  source_commit: "1".repeat(40),
  source_tree: "2".repeat(40),
  measured_certified_code_closure_sha256: "3".repeat(64),
});
let checks = 0;
const caught = [];
const mutationIds = [
  "policy-schema-tamper",
  "measurement-schema-tamper",
  "measurement-schema-omitted",
  "missing-filings-cohort",
  "missing-brokers-cohort",
  "missing-workbook-cohort",
  "derived-as-observed",
  "derived-bound-arithmetic",
  "insufficient-p95-sample",
  "raw-sample-manifest-tamper",
  "raw-corpus-manifest-tamper",
  "windows-drive-absolute-path",
  "windows-drive-relative-path",
  "windows-unc-path",
  "symlinked-parent-escape",
  "stable-read-race",
  "separate-root-floor-swap",
  "shared-volume-floor-undercut",
  "combined-below-component",
  "measured-source-identity-mismatch",
  "candidate-lower-override",
  "one-distinct-root-insufficient",
  "shared-volume-free-mismatch",
  "unsealed-candidate-custody",
];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function writeJson(target, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return { bytes, sha256: sha256(bytes) };
}

function observedStats(sampleCount, median, p95, maximum) {
  return {
    statistic_kind: "OBSERVED",
    sample_count: sampleCount,
    median_bytes: median,
    p95_bytes: p95,
    observed_max_bytes: maximum,
  };
}

function observedCohort(id, values) {
  const sampleCount = 20;
  return {
    cohort_id: id,
    workload_kind: id,
    corpus_manifest_ref: `#/evidence_manifests/corpora/${id}`,
    sample_receipt_manifest_ref: "#/evidence_manifests/sample_receipts",
    sample_count: sampleCount,
    root_statistics: {
      work_root: observedStats(sampleCount, ...values.work_root),
      temp_root: observedStats(sampleCount, ...values.temp_root),
      shared_volume_total: observedStats(sampleCount, ...values.shared_volume_total),
    },
  };
}

function derivedLane(inputCohorts, cohorts) {
  const bounds = {};
  for (const rootId of ["work_root", "temp_root", "shared_volume_total"]) {
    const refs = inputCohorts.map(
      (cohort) => `#/observed_cohorts/${cohort}/root_statistics/${rootId}`,
    );
    bounds[rootId] = {
      bound_kind: "DERIVED_CONSERVATIVE_BOUND",
      derived_conservative_bound_bytes: inputCohorts.reduce(
        (total, cohort) => total + cohorts[cohort].root_statistics[rootId].observed_max_bytes,
        0,
      ),
      input_refs: refs,
    };
  }
  return {
    derivation_kind: "DERIVED_CONSERVATIVE_BOUND",
    formula: "SUM_OBSERVED_MAXIMA",
    concurrency_assumption: "SUM_WHEN_CONCURRENCY_NOT_DISPROVED",
    input_cohorts: inputCohorts,
    bounds,
  };
}

function measurementFixture(manifestPointers) {
  const cohorts = {
    filings: observedCohort("filings", {
      work_root: [70, 100, 120], temp_root: [60, 80, 90], shared_volume_total: [110, 150, 180],
    }),
    brokers: observedCohort("brokers", {
      work_root: [110, 150, 180], temp_root: [120, 170, 190], shared_volume_total: [220, 280, 330],
    }),
    workbook: observedCohort("workbook", {
      work_root: [150, 200, 300], temp_root: [180, 250, 310], shared_volume_total: [300, 450, 550],
    }),
  };
  return {
    schema_version: "excel-inflow-disk-space-measurement/1.1",
    measurement_status: "COMPLETE",
    generated_at: "2026-08-21T12:00:00.000Z",
    methodology: {
      units: "bytes",
      peak_definition: "Maximum simultaneously allocated attributable bytes sampled during one bounded run.",
      sampling_interval_ms: 100,
      quantile_method: "nearest_rank",
      minimum_samples_per_observed_cohort: 20,
      tool: { name: "excel-inflow-disk-meter", version: "1.0.0", sha256: SHA },
    },
    measured_source_identity: clone(measuredSourceIdentity),
    host_identity: { os_platform: "synthetic", os_release: "test", architecture: "test" },
    evidence_manifests: {
      sample_receipts: manifestPointers.sample_receipts,
      corpora: {
        filings: manifestPointers.filings,
        brokers: manifestPointers.brokers,
        workbook: manifestPointers.workbook,
      },
    },
    observed_cohorts: { ...cohorts, actual_combined: null },
    derived_bounds: {
      evidence: derivedLane(["filings", "brokers"], cohorts),
      combined: derivedLane(["filings", "brokers", "workbook"], cohorts),
    },
  };
}

function floor(minFreeBytes, basisKind, basisRef, basisBytes, safetyMarginBytes) {
  return {
    min_free_bytes: minFreeBytes,
    basis_kind: basisKind,
    basis_ref: basisRef,
    basis_bytes: basisBytes,
    safety_margin_bytes: safetyMarginBytes,
  };
}

function policyFixture(measurementPointer, rawHashes, policySchemaSha256) {
  return {
    schema_version: "excel-inflow-disk-space-policy/1.1",
    policy_schema_sha256: policySchemaSha256,
    policy_status: "SEALED_MEASURED",
    lower_override_action: "REFUSE",
    measured_source_identity: clone(measuredSourceIdentity),
    measurement_evidence: {
      ...measurementPointer,
      schema_version: "excel-inflow-disk-space-measurement/1.1",
      sample_receipt_manifest_sha256: rawHashes.sample_receipts,
      corpus_manifest_sha256: {
        filings: rawHashes.filings,
        brokers: rawHashes.brokers,
        workbook: rawHashes.workbook,
      },
    },
    floors: {
      evidence: {
        distinct_volumes: {
          work_root: floor(330, "derived_conservative_bound_plus_safety", "#/derived_bounds/evidence/bounds/work_root", 300, 30),
          temp_root: floor(310, "derived_conservative_bound_plus_safety", "#/derived_bounds/evidence/bounds/temp_root", 280, 30),
        },
        shared_volume: floor(560, "derived_conservative_bound_plus_safety", "#/derived_bounds/evidence/bounds/shared_volume_total", 510, 50),
      },
      workbook: {
        distinct_volumes: {
          work_root: floor(400, "twice_observed_p95", "#/observed_cohorts/workbook/root_statistics/work_root", 400, 0),
          temp_root: floor(500, "twice_observed_p95", "#/observed_cohorts/workbook/root_statistics/temp_root", 500, 0),
        },
        shared_volume: floor(900, "twice_observed_p95", "#/observed_cohorts/workbook/root_statistics/shared_volume_total", 900, 0),
      },
      combined: {
        distinct_volumes: {
          work_root: floor(700, "derived_conservative_bound_plus_safety", "#/derived_bounds/combined/bounds/work_root", 600, 100),
          temp_root: floor(690, "derived_conservative_bound_plus_safety", "#/derived_bounds/combined/bounds/temp_root", 590, 100),
        },
        shared_volume: floor(1160, "derived_conservative_bound_plus_safety", "#/derived_bounds/combined/bounds/shared_volume_total", 1060, 100),
      },
    },
  };
}

async function createBundle(id, {
  mutateMeasurement = null,
  mutatePolicy = null,
  mutateSchema = null,
} = {}) {
  const root = path.join(scratch, id);
  await fs.mkdir(root, { recursive: true });
  const rawValues = {
    sample_receipts: { schema_version: "disk-space-sample-receipt-manifest/1.0", samples: Array.from({ length: 60 }, (_, index) => `sample-${index + 1}`) },
    filings: { schema_version: "disk-space-corpus-manifest/1.0", kind: "filings", inputs: ["representative-filing-corpus"] },
    brokers: { schema_version: "disk-space-corpus-manifest/1.0", kind: "brokers", inputs: ["representative-broker-corpus"] },
    workbook: { schema_version: "disk-space-corpus-manifest/1.0", kind: "workbook", inputs: ["maximal-workbook-build"] },
  };
  const rawWritten = {};
  const manifestPointers = {};
  for (const [name, value] of Object.entries(rawValues)) {
    const filename = `${name}-manifest.json`;
    rawWritten[name] = await writeJson(path.join(root, filename), value);
    manifestPointers[name] = {
      path: filename,
      sha256: rawWritten[name].sha256,
      schema_version: value.schema_version,
    };
  }
  const measurementSchema = JSON.parse(await fs.readFile(measurementSchemaPath, "utf8"));
  if (mutateSchema) mutateSchema(measurementSchema);
  const schemaWritten = await writeJson(path.join(root, "disk-space-measurement-v1.schema.json"), measurementSchema);
  const measurement = measurementFixture(manifestPointers);
  if (mutateMeasurement) mutateMeasurement(measurement);
  const measurementWritten = await writeJson(path.join(root, "disk-space-measurement.json"), measurement);
  const localPolicySchemaPath = path.join(root, "disk-space-policy-v1.schema.json");
  await fs.copyFile(policySchemaPath, localPolicySchemaPath);
  const policySchemaSha256 = sha256(await fs.readFile(localPolicySchemaPath));
  const policy = policyFixture({
    path: "disk-space-measurement.json",
    sha256: measurementWritten.sha256,
    schema_path: "disk-space-measurement-v1.schema.json",
    schema_sha256: schemaWritten.sha256,
  }, Object.fromEntries(Object.entries(rawWritten).map(([name, value]) => [name, value.sha256])), policySchemaSha256);
  if (mutatePolicy) mutatePolicy(policy);
  const policyWritten = await writeJson(path.join(root, "disk-space-policy.json"), policy);
  return {
    root,
    policyPath: path.join(root, "disk-space-policy.json"),
    measurementPath: path.join(root, "disk-space-measurement.json"),
    measurementSchemaPath: path.join(root, "disk-space-measurement-v1.schema.json"),
    policySchemaPath: localPolicySchemaPath,
    rawPaths: Object.fromEntries(Object.keys(rawWritten).map((name) => [name, path.join(root, `${name}-manifest.json`)])),
    policy,
    measurement,
    policySha256: policyWritten.sha256,
  };
}

async function loadCandidate(bundle, options = {}) {
  // This narrow contract fixture intentionally uses compact placeholder raw
  // manifests. Exercise schema/custody/arithmetic in development mode here;
  // the independent builder suite owns real 20+20+20 candidate acceptance.
  return loadDiskSpacePolicy({
    policyPath: bundle.policyPath,
    expectedPolicySha256: bundle.policySha256,
    mode: "development",
    schemaPath: bundle.policySchemaPath,
    ...options,
  });
}

async function expectLoadError(id, expectedCodes, callback) {
  let observed = null;
  try { await callback(); } catch (error) { observed = error; }
  const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  check(observed instanceof DiskSpacePolicyError && codes.includes(observed.code), `${id} returned ${observed?.code}`);
  caught.push(id);
}

function observations(workAvailable = 2_000, tempAvailable = 2_000, sameVolume = false) {
  return {
    work_root: {
      available_bytes: workAvailable,
      volume_identity: { device_id: sameVolume ? "shared" : "work", filesystem_type: "fs", block_size_bytes: 4096 },
    },
    temp_root: {
      available_bytes: tempAvailable,
      volume_identity: { device_id: sameVolume ? "shared" : "temp", filesystem_type: "fs", block_size_bytes: 4096 },
    },
  };
}

try {
  const [policySchema, measurementSchema] = await Promise.all([
    loadDiskSpacePolicySchema(policySchemaPath),
    loadDiskSpaceMeasurementSchema(measurementSchemaPath),
  ]);
  const clean = await createBundle("clean");
  check(validateJsonSchema(clean.policy, policySchema).length === 0, "clean policy violates policy schema");
  check(validateJsonSchema(clean.measurement, measurementSchema).length === 0, "clean measurement violates measurement schema");
  check(validateDiskSpaceMeasurementContract({ measurement: clean.measurement, schema: measurementSchema }).length === 0, "clean observed/derived measurement is semantically invalid");
  check(validateDiskSpacePolicyContract({ policy: clean.policy, schema: policySchema, measurement: clean.measurement, measurementSchema }).length === 0, "clean topology policy is semantically invalid");
  const withActualCombined = clone(clean.measurement);
  withActualCombined.observed_cohorts.actual_combined = observedCohort("actual_combined", {
    work_root: [400, 550, 620], temp_root: [420, 560, 610], shared_volume_total: [800, 1_000, 1_100],
  });
  withActualCombined.observed_cohorts.actual_combined.corpus_manifest_ref = "#/evidence_manifests/corpora";
  check(
    validateDiskSpaceMeasurementContract({ measurement: withActualCombined, schema: measurementSchema }).length === 0,
    "optional actual-combined observed cohort is not representable without entering derived fields",
  );
  const loaded = await loadCandidate(clean);
  check(
    loaded.custody.policy_sealed && loaded.custody.measurement_evidence_sealed &&
      loaded.custody.measurement_schema_sealed &&
      Object.values(loaded.custody.raw_manifests).every((entry) => entry.sealed),
    "candidate did not bind policy, schema, measurement and every raw manifest",
  );
  check(
    loaded.measurement.derived_bounds.evidence.bounds.work_root.derived_conservative_bound_bytes === 300 &&
      loaded.measurement.derived_bounds.combined.bounds.shared_volume_total.derived_conservative_bound_bytes === 1060,
    "derived conservative bounds do not equal their observed-maximum inputs",
  );

  const policySchemaTamper = await createBundle("policy-schema-tamper");
  await fs.appendFile(policySchemaTamper.policySchemaPath, "\n");
  await expectLoadError(
    "policy-schema-tamper",
    "DISK_SPACE_POLICY_SCHEMA_HASH_MISMATCH",
    () => loadCandidate(policySchemaTamper),
  );

  const distinct = evaluateDiskSpacePolicy({
    loadedPolicy: loaded, mode: "development", requestedLanes: ["evidence", "workbook"],
    observations: observations(800, 700),
  });
  check(
    distinct.status === "PASS" && distinct.selected_volume_topology === "distinct_volumes" &&
      distinct.roots.work_root.required_bytes === 700 && distinct.roots.temp_root.required_bytes === 690,
    "distinct volumes did not receive separate combined-lane floors",
  );
  const shared = evaluateDiskSpacePolicy({
    loadedPolicy: loaded, mode: "development", requestedLanes: ["evidence", "workbook"],
    observations: observations(1_200, 1_200, true),
  });
  check(
    shared.status === "PASS" && shared.selected_volume_topology === "shared_volume" &&
      shared.roots.work_root.required_bytes === 1160 && shared.roots.temp_root.required_bytes === 1160,
    "shared device identity did not select one shared-volume conservative floor",
  );

  const schemaTamper = await createBundle("schema-tamper", {
    mutateSchema: (value) => { value.properties.schema_version.const = "tampered"; },
  });
  await expectLoadError("measurement-schema-tamper", "DISK_SPACE_MEASUREMENT_SCHEMA_MISMATCH", () => loadCandidate(schemaTamper));

  const schemaOmitted = await createBundle("schema-omitted");
  await fs.unlink(schemaOmitted.measurementSchemaPath);
  await expectLoadError("measurement-schema-omitted", "DISK_SPACE_EVIDENCE_MISSING", () => loadCandidate(schemaOmitted));

  for (const cohort of ["filings", "brokers", "workbook"]) {
    const bundle = await createBundle(`missing-${cohort}`, {
      mutateMeasurement: (value) => { delete value.observed_cohorts[cohort]; },
    });
    await expectLoadError(`missing-${cohort}-cohort`, "DISK_SPACE_POLICY_INVALID", () => loadCandidate(bundle));
  }

  const derivedAsObserved = await createBundle("derived-as-observed", {
    mutateMeasurement: (value) => { value.derived_bounds.evidence.bounds.work_root.bound_kind = "OBSERVED"; },
  });
  await expectLoadError("derived-as-observed", "DISK_SPACE_POLICY_INVALID", () => loadCandidate(derivedAsObserved));

  const derivedArithmetic = await createBundle("derived-arithmetic", {
    mutateMeasurement: (value) => { value.derived_bounds.combined.bounds.temp_root.derived_conservative_bound_bytes -= 1; },
  });
  await expectLoadError("derived-bound-arithmetic", "DISK_SPACE_POLICY_INVALID", () => loadCandidate(derivedArithmetic));

  const tooSmall = await createBundle("too-small", {
    mutateMeasurement: (value) => {
      value.observed_cohorts.filings.sample_count = 19;
      for (const stats of Object.values(value.observed_cohorts.filings.root_statistics)) stats.sample_count = 19;
    },
  });
  await expectLoadError("insufficient-p95-sample", "DISK_SPACE_POLICY_INVALID", () => loadCandidate(tooSmall));

  const sampleTamper = await createBundle("sample-tamper");
  await fs.appendFile(sampleTamper.rawPaths.sample_receipts, " ");
  await expectLoadError("raw-sample-manifest-tamper", "DISK_SPACE_RAW_SAMPLE_RECEIPTS_HASH_MISMATCH", () => loadCandidate(sampleTamper));

  const corpusTamper = await createBundle("corpus-tamper");
  await fs.appendFile(corpusTamper.rawPaths.brokers, " ");
  await expectLoadError("raw-corpus-manifest-tamper", "DISK_SPACE_RAW_BROKERS_HASH_MISMATCH", () => loadCandidate(corpusTamper));

  for (const [id, unsafe] of [
    ["windows-drive-absolute-path", "C:\\outside\\measurement.json"],
    ["windows-drive-relative-path", "C:measurement.json"],
    ["windows-unc-path", "\\\\server\\share\\measurement.json"],
  ]) {
    const bundle = await createBundle(id, {
      mutatePolicy: (value) => { value.measurement_evidence.path = unsafe; },
    });
    await expectLoadError(id, "DISK_SPACE_EVIDENCE_POINTER_UNSAFE", () => loadCandidate(bundle));
  }

  const symlinkBundle = await createBundle("symlink-parent");
  const outside = path.join(scratch, "outside-evidence");
  await fs.mkdir(outside);
  await fs.copyFile(symlinkBundle.measurementPath, path.join(outside, "measurement.json"));
  await fs.symlink(outside, path.join(symlinkBundle.root, "linked"), "dir");
  symlinkBundle.policy.measurement_evidence.path = "linked/measurement.json";
  const rewrittenSymlinkPolicy = await writeJson(symlinkBundle.policyPath, symlinkBundle.policy);
  symlinkBundle.policySha256 = rewrittenSymlinkPolicy.sha256;
  await expectLoadError("symlinked-parent-escape", "DISK_SPACE_EVIDENCE_ANCESTOR_UNSAFE", () => loadCandidate(symlinkBundle));

  const raceBundle = await createBundle("stable-read-race");
  let raced = false;
  await expectLoadError("stable-read-race", "DISK_SPACE_ARTIFACT_UNSTABLE", () => loadCandidate(raceBundle, {
    operations: {
      after_artifact_open: async (target) => {
        if (!raced && target === raceBundle.measurementPath) {
          raced = true;
          await fs.appendFile(target, " ");
        }
      },
    },
  }));

  const swapped = await createBundle("root-swap", {
    mutatePolicy: (value) => {
      const work = value.floors.evidence.distinct_volumes.work_root;
      value.floors.evidence.distinct_volumes.work_root = value.floors.evidence.distinct_volumes.temp_root;
      value.floors.evidence.distinct_volumes.temp_root = work;
    },
  });
  await expectLoadError("separate-root-floor-swap", "DISK_SPACE_POLICY_INVALID", () => loadCandidate(swapped));

  const sharedUndercut = await createBundle("shared-undercut", {
    mutatePolicy: (value) => { value.floors.combined.shared_volume.min_free_bytes = 1059; },
  });
  await expectLoadError("shared-volume-floor-undercut", "DISK_SPACE_POLICY_INVALID", () => loadCandidate(sharedUndercut));

  const combinedLow = await createBundle("combined-low", {
    mutatePolicy: (value) => {
      value.floors.combined.distinct_volumes.temp_root.min_free_bytes = 490;
      value.floors.combined.distinct_volumes.temp_root.safety_margin_bytes = 0;
    },
  });
  await expectLoadError("combined-below-component", "DISK_SPACE_POLICY_INVALID", () => loadCandidate(combinedLow));

  const identityMismatch = await createBundle("identity-mismatch", {
    mutatePolicy: (value) => { value.measured_source_identity.source_tree = "f".repeat(40); },
  });
  await expectLoadError("measured-source-identity-mismatch", "DISK_SPACE_POLICY_INVALID", () => loadCandidate(identityMismatch));

  const lowerOverride = evaluateDiskSpacePolicy({
    loadedPolicy: loaded, mode: "candidate", requestedLanes: ["evidence"],
    observations: observations(), overrideMinFreeBytes: 559,
  });
  check(
    lowerOverride.status === "REFUSED" &&
      lowerOverride.findings.some((item) => item.code === "DISK_SPACE_OVERRIDE_BELOW_POLICY") &&
      lowerOverride.required_free_bytes.shared_volume === 560,
    "candidate lowered a topology floor through an override",
  );
  caught.push("candidate-lower-override");

  const oneLow = evaluateDiskSpacePolicy({
    loadedPolicy: loaded, mode: "development", requestedLanes: ["workbook"],
    observations: observations(450, 499),
  });
  check(
    oneLow.status === "REFUSED" && oneLow.roots.work_root.status === "PASS" &&
      oneLow.roots.temp_root.status === "REFUSED" && oneLow.roots.temp_root.headroom_bytes === -1,
    "one distinct-volume pass was copied onto the insufficient other volume",
  );
  caught.push("one-distinct-root-insufficient");

  const sharedMismatch = evaluateDiskSpacePolicy({
    loadedPolicy: loaded, mode: "development", requestedLanes: ["evidence"],
    observations: observations(600, 599, true),
  });
  check(
    sharedMismatch.status === "REFUSED" &&
      sharedMismatch.findings.some((item) => item.code === "DISK_SPACE_SHARED_VOLUME_AVAILABLE_MISMATCH"),
    "one shared device admitted two contradictory free-byte observations",
  );
  caught.push("shared-volume-free-mismatch");

  const unsealed = clone(loaded);
  unsealed.custody.policy_sealed = false;
  const unsealedResult = evaluateDiskSpacePolicy({
    loadedPolicy: unsealed, mode: "candidate", requestedLanes: ["evidence"], observations: observations(),
  });
  check(
    unsealedResult.status === "REFUSED" &&
      unsealedResult.findings.some((item) => item.code === "DISK_SPACE_CANDIDATE_POLICY_UNSEALED"),
    "candidate evaluation admitted unsealed custody",
  );
  caught.push("unsealed-candidate-custody");

  check(caught.length === mutationIds.length, `declared ${mutationIds.length} mutations but caught ${caught.length}`);
  check(caught.every((id, index) => id === mutationIds[index]), `mutation order drifted: ${caught.join(",")}`);
  check(
    !(await fs.stat(path.join(ROOT, "assets", "disk-space-policy-v1.json")).then(() => true, () => false)),
    "a final measured production policy was created before cohort bytes arrived",
  );
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    policy_schema_version: clean.policy.schema_version,
    measurement_schema_version: clean.measurement.schema_version,
    observed_cohorts: ["filings", "brokers", "workbook"],
    derived_bounds: ["evidence", "combined"],
    volume_topologies: ["distinct_volumes", "shared_volume"],
    mutations_declared: mutationIds.length,
    mutations_applied: caught.length,
    mutations_caught: caught.length,
    mutations_survived: mutationIds.length - caught.length,
    mutation_ids: caught,
    production_policy_present: false,
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
