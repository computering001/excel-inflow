#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DiskSpaceRawEvidenceError,
  assertPortableDiskSpaceArtifact,
  assertMeasurementObservedCohortsMatchRaw,
  projectPortableDiskSpaceResourceSample,
  recomputeDiskSpaceObservedCohorts,
} from "./lib/disk_space_measurement_builder.mjs";
import {
  loadDiskSpacePolicy,
} from "./lib/disk_space_policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SAMPLE_SCHEMA = path.join(
  ROOT, "assets", "disk-space-sample-receipt-manifest-v1.schema.json",
);
const CORPUS_SCHEMA = path.join(
  ROOT, "assets", "disk-space-corpus-manifest-v1.schema.json",
);
const MEASUREMENT_SCHEMA = path.join(
  ROOT, "assets", "disk-space-measurement-v1.schema.json",
);
const POLICY_SCHEMA = path.join(
  ROOT, "assets", "disk-space-policy-v1.schema.json",
);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "disk-space-raw-evidence-tests-"));
const COHORTS = ["filings", "brokers", "workbook"];
const mutations = [
  "invented-count",
  "invented-statistic",
  "fabricated-normalized-peak",
  "omitted-sample",
  "cohort-underfilled",
  "duplicate-sample",
  "wrong-sample-cohort",
  "wrong-corpus-hash",
  "measurement-corpus-hash",
  "raw-sample-status",
  "raw-sample-source",
  "raw-sample-hash",
  "raw-sample-peak-tamper",
  "invalid-shared-volume-measure",
  "candidate-resealed-invented-summary",
  "portable-absolute-posix",
  "portable-posix-home",
  "portable-posix-temp",
  "portable-windows-drive-absolute",
  "portable-windows-drive-relative",
  "portable-windows-unc",
  "portable-home-shortcut",
  "portable-author-identity",
  "portable-source-receipt-binding",
  "portable-projection-self-hash",
  "candidate-resealed-portable-path-leak",
];
const caught = [];
let checks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function canonical(value) {
  const normalise = (item) => Array.isArray(item)
    ? item.map(normalise)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalise(item[key])]))
      : item;
  return Buffer.from(`${JSON.stringify(normalise(value))}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(target, value) {
  const bytes = canonical(value);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return { bytes, sha256: sha256(bytes) };
}

function resealProjection(receipt) {
  const unsigned = clone(receipt);
  delete unsigned.portable_projection.projection_sha256;
  const normalise = (item) => Array.isArray(item)
    ? item.map(normalise)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalise(item[key])]))
      : item;
  receipt.portable_projection.projection_sha256 = sha256(
    Buffer.from(`${JSON.stringify(normalise(unsigned), null, 2)}\n`, "utf8"),
  );
}

async function fixture(name) {
  const root = path.join(scratch, name);
  await fs.mkdir(root, { recursive: true });
  const corpora = {};
  const resourceCohort = {
    filings: "real-astra-filings",
    brokers: "broker-82-pages",
    workbook: "standard-maximal-workbook",
  };
  const frozenSource = {
    commit: "e8eb91f958e1f7c12007a27ffd01be159799772f",
    tree: "cd27d731cb74320b54dd3f0cbad4b286d686aee0",
    working_source_digest_sha256: "ae19458df80ed55f7f64914ab3b8efae859f32603ac42dd9a5c37822d59aa562",
    file_count: 900,
    worktree_status_bytes: 0,
    worktree_status_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  for (const cohortId of COHORTS) {
    const filename = `corpus-${cohortId}.json`;
    const result = await writeJson(path.join(root, filename), {
      schema_version: "excel-inflow-disk-space-corpus-manifest/1.1",
      corpus_id: `${cohortId}-representative-v1`,
      workload_kind: cohortId,
      resource_cohort_id: resourceCohort[cohortId],
      generated_at: "2026-08-21T10:00:00.000Z",
      sources: [{
        source_id: `${cohortId}-source-1`,
        path: `source/${cohortId}-source-1.bin`,
        sha256: sha256(Buffer.from(`${cohortId}-source`, "utf8")),
        bytes: Buffer.byteLength(`${cohortId}-source`),
      }],
    });
    corpora[cohortId] = {
      path: filename,
      sha256: result.sha256,
      schema_version: "excel-inflow-disk-space-corpus-manifest/1.1",
    };
  }

  const samples = [];
  for (const [cohortIndex, cohortId] of COHORTS.entries()) {
    for (let index = 1; index <= 20; index += 1) {
      const sampleId = `${cohortId}-${String(index).padStart(2, "0")}`;
      const resourceSampleId = `sample-${String(index).padStart(2, "0")}`;
      const globalSampleId = `${resourceCohort[cohortId]}/${resourceSampleId}`;
      const filename = `samples/${resourceCohort[cohortId]}/${resourceSampleId}/resource-sample.json`;
      const workPeak = (cohortIndex + 1) * 1000 + index;
      const tempPeak = (cohortIndex + 1) * 2000 + index * 2;
      const rawSeries = [
        {
          elapsed_ms: 0,
          run: { allocated_bytes: Math.floor(workPeak / 2) },
          temp: { allocated_bytes: Math.floor(tempPeak / 2) },
        },
        {
          elapsed_ms: 100,
          run: { allocated_bytes: workPeak },
          temp: { allocated_bytes: tempPeak },
        },
      ];
      const input = [{
        path: `/sealed/${cohortId}-source.bin`,
        bytes: 100 + index,
        expected_sha256: sha256(Buffer.from(`${cohortId}-source-${index}`, "utf8")),
        actual_sha256: sha256(Buffer.from(`${cohortId}-source-${index}`, "utf8")),
        matches: true,
      }];
      const volume = (kind) => ({
        path: `/measurement/${kind}`,
        device_id: "16777233",
        block_size: 4096,
        available_bytes: 500_000_000_000,
        df_exit_code: 0,
        df_stdout: "sealed fixture",
        df_stderr: "",
      });
      const raw = {
        schema_version: "excel-inflow-component-resource-sample/1.0",
        cohort_id: resourceCohort[cohortId],
        sample_id: resourceSampleId,
        status: "PASS",
        exit_code: 0,
        timed_out: false,
        assertions: { pass: true },
        inputs_stable_and_bound: true,
        input_pre: input,
        input_post: JSON.parse(JSON.stringify(input)),
        source_stable_and_clean: true,
        source_pre: frozenSource,
        source_post: { ...frozenSource },
        same_volume: true,
        run_volume_pre: volume("run"),
        run_volume_post: volume("run"),
        temp_volume_pre: volume("temp"),
        temp_volume_post: volume("temp"),
        sample_count: rawSeries.length,
        samples: rawSeries,
        peak: {
          run: { allocated_bytes: workPeak },
          temp: { allocated_bytes: tempPeak },
          same_volume_total: { allocated_bytes: workPeak + tempPeak },
        },
      };
      const rawBytes = canonical(raw);
      const projection = projectPortableDiskSpaceResourceSample(rawBytes);
      await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await fs.writeFile(path.join(root, filename), projection.bytes);
      samples.push({
        sample_id: globalSampleId,
        cohort_id: cohortId,
        resource_cohort_id: resourceCohort[cohortId],
        resource_sample_id: resourceSampleId,
        path: filename,
        sha256: sha256(projection.bytes),
        resource_sample_schema_version: "excel-inflow-component-resource-sample-portable/1.0",
        source_resource_sample_schema_version: "excel-inflow-component-resource-sample/1.0",
        source_receipt_sha256: sha256(rawBytes),
      });
    }
  }
  const manifestPath = path.join(root, "sample-receipts.json");
  const manifest = {
    schema_version: "excel-inflow-disk-space-sample-receipt-manifest/1.2",
    generated_at: "2026-08-21T10:30:00.000Z",
    corpora,
    samples,
  };
  await writeJson(manifestPath, manifest);
  return { root, manifestPath, manifest };
}

async function rewriteManifest(value) {
  await writeJson(value.manifestPath, value.manifest);
}

async function resealSample(value, index, operation) {
  const pointer = value.manifest.samples[index];
  const target = path.join(value.root, ...pointer.path.split("/"));
  const receipt = JSON.parse(await fs.readFile(target, "utf8"));
  operation(receipt);
  resealProjection(receipt);
  const result = await writeJson(target, receipt);
  pointer.sha256 = result.sha256;
  await rewriteManifest(value);
}

async function expectCode(id, action, code) {
  let observed = null;
  try {
    await action();
  } catch (error) {
    observed = error;
  }
  check(observed instanceof DiskSpaceRawEvidenceError, `${id} did not produce a typed refusal`);
  check(observed?.code === code, `${id} produced ${observed?.code}, expected ${code}`);
  caught.push(id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function derivedLane(inputCohorts, observedCohorts) {
  const bounds = {};
  for (const rootId of ["work_root", "temp_root", "shared_volume_total"]) {
    bounds[rootId] = {
      bound_kind: "DERIVED_CONSERVATIVE_BOUND",
      derived_conservative_bound_bytes: inputCohorts.reduce(
        (total, cohortId) => total +
          observedCohorts[cohortId].root_statistics[rootId].observed_max_bytes,
        0,
      ),
      input_refs: inputCohorts.map(
        (cohortId) => `#/observed_cohorts/${cohortId}/root_statistics/${rootId}`,
      ),
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

function floor(basisKind, basisRef, basisBytes) {
  return {
    min_free_bytes: basisBytes + 1,
    basis_kind: basisKind,
    basis_ref: basisRef,
    basis_bytes: basisBytes,
    safety_margin_bytes: 1,
  };
}

function topologyFloor(measurementValue, lane) {
  const source = lane === "workbook"
    ? measurementValue.observed_cohorts.workbook.root_statistics
    : measurementValue.derived_bounds[lane].bounds;
  const basisKind = lane === "workbook"
    ? "observed_max_plus_safety"
    : "derived_conservative_bound_plus_safety";
  const refFor = (rootId) => lane === "workbook"
    ? `#/observed_cohorts/workbook/root_statistics/${rootId}`
    : `#/derived_bounds/${lane}/bounds/${rootId}`;
  const bytesFor = (rootId) => lane === "workbook"
    ? source[rootId].observed_max_bytes
    : source[rootId].derived_conservative_bound_bytes;
  return {
    distinct_volumes: {
      work_root: floor(basisKind, refFor("work_root"), bytesFor("work_root")),
      temp_root: floor(basisKind, refFor("temp_root"), bytesFor("temp_root")),
    },
    shared_volume: floor(
      basisKind,
      refFor("shared_volume_total"),
      bytesFor("shared_volume_total"),
    ),
  };
}

async function writeCandidatePolicyBundle(value, recomputed, mutateMeasurement = null) {
  const measuredSourceIdentity = {
    repository: "excel-inflow-clean-final",
    source_commit: "e8eb91f958e1f7c12007a27ffd01be159799772f",
    source_tree: "cd27d731cb74320b54dd3f0cbad4b286d686aee0",
    measured_certified_code_closure_sha256: sha256(
      Buffer.from("synthetic certified code closure", "utf8"),
    ),
  };
  const observedCohorts = clone(recomputed.observed_cohorts);
  const measurementValue = {
    schema_version: "excel-inflow-disk-space-measurement/1.1",
    measurement_status: "COMPLETE",
    generated_at: "2026-08-21T10:45:00.000Z",
    methodology: {
      units: "bytes",
      peak_definition: "Maximum simultaneously allocated attributable bytes sampled during one bounded run.",
      sampling_interval_ms: 100,
      quantile_method: "nearest_rank",
      minimum_samples_per_observed_cohort: 20,
      tool: {
        name: "excel-inflow-disk-meter",
        version: "1.0.0-test",
        sha256: sha256(Buffer.from("synthetic disk meter", "utf8")),
      },
    },
    measured_source_identity: measuredSourceIdentity,
    host_identity: {
      os_platform: "synthetic",
      os_release: "candidate-loader-test",
      architecture: "test",
    },
    evidence_manifests: {
      sample_receipts: {
        path: path.basename(value.manifestPath),
        sha256: recomputed.sample_manifest_sha256,
        schema_version: "excel-inflow-disk-space-sample-receipt-manifest/1.2",
      },
      corpora: Object.fromEntries(COHORTS.map((cohortId) => [cohortId, {
        path: value.manifest.corpora[cohortId].path,
        sha256: recomputed.corpus_manifest_sha256[cohortId],
        schema_version: "excel-inflow-disk-space-corpus-manifest/1.1",
      }])),
    },
    observed_cohorts: { ...observedCohorts, actual_combined: null },
    derived_bounds: {
      evidence: derivedLane(["filings", "brokers"], observedCohorts),
      combined: derivedLane(COHORTS, observedCohorts),
    },
  };
  if (mutateMeasurement) mutateMeasurement(measurementValue);

  const localMeasurementSchema = "disk-space-measurement-v1.schema.json";
  await fs.copyFile(MEASUREMENT_SCHEMA, path.join(value.root, localMeasurementSchema));
  const measurementWritten = await writeJson(
    path.join(value.root, "disk-space-measurement.json"),
    measurementValue,
  );
  const measurementSchemaSha256 = sha256(await fs.readFile(MEASUREMENT_SCHEMA));
  const policySchemaSha256 = sha256(await fs.readFile(POLICY_SCHEMA));
  const policyValue = {
    schema_version: "excel-inflow-disk-space-policy/1.1",
    policy_schema_sha256: policySchemaSha256,
    policy_status: "SEALED_MEASURED",
    lower_override_action: "REFUSE",
    measured_source_identity: measuredSourceIdentity,
    measurement_evidence: {
      path: "disk-space-measurement.json",
      sha256: measurementWritten.sha256,
      schema_version: "excel-inflow-disk-space-measurement/1.1",
      schema_path: localMeasurementSchema,
      schema_sha256: measurementSchemaSha256,
      sample_receipt_manifest_sha256: recomputed.sample_manifest_sha256,
      corpus_manifest_sha256: clone(recomputed.corpus_manifest_sha256),
    },
    floors: {
      evidence: topologyFloor(measurementValue, "evidence"),
      workbook: topologyFloor(measurementValue, "workbook"),
      combined: topologyFloor(measurementValue, "combined"),
    },
  };
  const policyPath = path.join(value.root, "disk-space-policy.json");
  const policyWritten = await writeJson(policyPath, policyValue);
  return { policyPath, policySha256: policyWritten.sha256 };
}

const cleanFixture = await fixture("clean");
const clean = await recomputeDiskSpaceObservedCohorts({
  sampleManifestPath: cleanFixture.manifestPath,
  sampleManifestSchemaPath: SAMPLE_SCHEMA,
  corpusManifestSchemaPath: CORPUS_SCHEMA,
});
for (const [cohortIndex, cohortId] of COHORTS.entries()) {
  const cohort = clean.observed_cohorts[cohortId];
  check(cohort.sample_count === 20, `${cohortId} did not recompute 20 samples`);
  check(cohort.root_statistics.work_root.median_bytes === (cohortIndex + 1) * 1000 + 10,
    `${cohortId} median is not nearest-rank p50`);
  check(cohort.root_statistics.work_root.p95_bytes === (cohortIndex + 1) * 1000 + 19,
    `${cohortId} p95 is not nearest-rank`);
  check(cohort.root_statistics.work_root.observed_max_bytes === (cohortIndex + 1) * 1000 + 20,
    `${cohortId} maximum did not come from raw samples`);
}
const measurement = {
  evidence_manifests: {
    sample_receipts: {
      path: "sample-receipts.json",
      sha256: clean.sample_manifest_sha256,
      schema_version: "excel-inflow-disk-space-sample-receipt-manifest/1.2",
    },
    corpora: Object.fromEntries(COHORTS.map((cohortId) => [cohortId, {
      path: `corpus-${cohortId}.json`,
      sha256: clean.corpus_manifest_sha256[cohortId],
      schema_version: "excel-inflow-disk-space-corpus-manifest/1.1",
    }])),
  },
  observed_cohorts: {
    ...JSON.parse(JSON.stringify(clean.observed_cohorts)), actual_combined: null,
  },
};
const joined = assertMeasurementObservedCohortsMatchRaw({ measurement, recomputed: clean });
check(joined.status === "PASS" && joined.total_violations === 0, "clean raw-to-measurement join failed");

const candidateBundle = await writeCandidatePolicyBundle(cleanFixture, clean);
const candidateLoaded = await loadDiskSpacePolicy({
  policyPath: candidateBundle.policyPath,
  expectedPolicySha256: candidateBundle.policySha256,
  mode: "candidate",
  schemaPath: POLICY_SCHEMA,
});
check(candidateLoaded.custody.policy_sealed === true, "candidate policy bytes were not sealed");
check(candidateLoaded.custody.raw_recomputation?.status === "PASS",
  "candidate loader did not independently recompute raw evidence");
check(candidateLoaded.custody.raw_recomputation?.sample_count === 60,
  "candidate loader did not bind all 60 raw resource samples");
check(candidateLoaded.custody.raw_recomputation?.sample_manifest_sha256 ===
  candidateLoaded.custody.raw_manifests.sample_receipts.sha256,
"candidate loader raw recomputation did not join to sample-manifest custody");

await expectCode("invented-count", async () => {
  const invented = JSON.parse(JSON.stringify(measurement));
  invented.observed_cohorts.filings.sample_count = 21;
  assertMeasurementObservedCohortsMatchRaw({ measurement: invented, recomputed: clean });
}, "DISK_SPACE_MEASUREMENT_RAW_RECOMPUTATION_MISMATCH");

await expectCode("invented-statistic", async () => {
  const invented = JSON.parse(JSON.stringify(measurement));
  invented.observed_cohorts.brokers.root_statistics.temp_root.p95_bytes += 1;
  assertMeasurementObservedCohortsMatchRaw({ measurement: invented, recomputed: clean });
}, "DISK_SPACE_MEASUREMENT_RAW_RECOMPUTATION_MISMATCH");

await expectCode("fabricated-normalized-peak", async () => {
  const value = await fixture("fabricated-normalized-peak");
  value.manifest.samples[0].normalized_peak_bytes = 1;
  await rewriteManifest(value);
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RAW_SCHEMA_INVALID");

await expectCode("omitted-sample", async () => {
  const value = await fixture("omitted-sample");
  value.manifest.samples.pop();
  await rewriteManifest(value);
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RAW_SCHEMA_INVALID");

await expectCode("cohort-underfilled", async () => {
  const value = await fixture("cohort-underfilled");
  const index = value.manifest.samples.findIndex((item) =>
    item.sample_id === "standard-maximal-workbook/sample-20");
  value.manifest.samples[index].cohort_id = "filings";
  value.manifest.samples[index].resource_cohort_id = "real-astra-filings";
  value.manifest.samples[index].resource_sample_id = "sample-21";
  value.manifest.samples[index].sample_id = "real-astra-filings/sample-21";
  await resealSample(value, index, (receipt) => {
    receipt.cohort_id = "real-astra-filings";
    receipt.sample_id = "sample-21";
  });
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_OBSERVED_COHORT_TOO_SMALL");

await expectCode("duplicate-sample", async () => {
  const value = await fixture("duplicate-sample");
  value.manifest.samples[59] = { ...value.manifest.samples[0] };
  await rewriteManifest(value);
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_SAMPLE_DUPLICATE");

await expectCode("wrong-sample-cohort", async () => {
  const value = await fixture("wrong-sample-cohort");
  value.manifest.samples[0].cohort_id = "brokers";
  await rewriteManifest(value);
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_SAMPLE_IDENTITY_MISMATCH");

await expectCode("wrong-corpus-hash", async () => {
  const value = await fixture("wrong-corpus-hash");
  value.manifest.corpora.filings.sha256 = "0".repeat(64);
  await rewriteManifest(value);
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RAW_HASH_MISMATCH");

await expectCode("measurement-corpus-hash", async () => {
  const invented = JSON.parse(JSON.stringify(measurement));
  invented.evidence_manifests.corpora.workbook.sha256 = "0".repeat(64);
  assertMeasurementObservedCohortsMatchRaw({ measurement: invented, recomputed: clean });
}, "DISK_SPACE_MEASUREMENT_RAW_RECOMPUTATION_MISMATCH");

await expectCode("raw-sample-status", async () => {
  const value = await fixture("raw-sample-status");
  await resealSample(value, 0, (receipt) => {
    receipt.status = "FAIL";
  });
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RESOURCE_SAMPLE_NOT_PASS");

await expectCode("raw-sample-source", async () => {
  const value = await fixture("raw-sample-source");
  await resealSample(value, 0, (receipt) => {
    receipt.source_post.working_source_digest_sha256 = "0".repeat(64);
  });
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RESOURCE_SAMPLE_SOURCE_MISMATCH");

await expectCode("raw-sample-hash", async () => {
  const value = await fixture("raw-sample-hash");
  const pointer = value.manifest.samples[0];
  const target = path.join(value.root, ...pointer.path.split("/"));
  await fs.appendFile(target, " ");
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RAW_HASH_MISMATCH");

await expectCode("raw-sample-peak-tamper", async () => {
  const value = await fixture("raw-sample-peak-tamper");
  await resealSample(value, 0, (receipt) => {
    receipt.peak.run.allocated_bytes += 1;
  });
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RESOURCE_SAMPLE_PEAK_MISMATCH");

await expectCode("invalid-shared-volume-measure", async () => {
  const value = await fixture("invalid-shared-volume-measure");
  await resealSample(value, 0, (receipt) => {
    receipt.temp_volume_post.device_id = "different-device";
  });
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_RESOURCE_SAMPLE_TOPOLOGY_INVALID");

await expectCode("candidate-resealed-invented-summary", async () => {
  const value = await fixture("candidate-resealed-invented-summary");
  const recomputed = await recomputeDiskSpaceObservedCohorts({
    sampleManifestPath: value.manifestPath,
  });
  const bundle = await writeCandidatePolicyBundle(value, recomputed, (measurementValue) => {
    measurementValue.observed_cohorts.brokers.root_statistics.temp_root.p95_bytes += 1;
  });
  await loadDiskSpacePolicy({
    policyPath: bundle.policyPath,
    expectedPolicySha256: bundle.policySha256,
    mode: "candidate",
    schemaPath: POLICY_SCHEMA,
  });
}, "DISK_SPACE_MEASUREMENT_RAW_RECOMPUTATION_MISMATCH");

for (const [id, leakedValue] of [
  ["portable-absolute-posix", "/opt/local/bin/python3"],
  ["portable-posix-home", ["", "Users", "example", "private", "input.pdf"].join("/")],
  ["portable-posix-temp", "/var/folders/ab/local/output"],
  ["portable-windows-drive-absolute", "C:\\Users\\example\\input.pdf"],
  ["portable-windows-drive-relative", "D:private\\input.pdf"],
  ["portable-windows-unc", "\\\\server\\private-share\\input.pdf"],
  ["portable-home-shortcut", "~/private/input.pdf"],
  ["portable-author-identity", "archiepreston/Documents/Codex/private"],
]) {
  await expectCode(id, async () => {
    assertPortableDiskSpaceArtifact({ leaked_value: leakedValue }, id);
  }, "DISK_SPACE_PORTABLE_PATH_VIOLATION");
}

await expectCode("portable-source-receipt-binding", async () => {
  const value = await fixture("portable-source-receipt-binding");
  value.manifest.samples[0].source_receipt_sha256 = "0".repeat(64);
  await rewriteManifest(value);
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_PORTABLE_PROJECTION_INVALID");

await expectCode("portable-projection-self-hash", async () => {
  const value = await fixture("portable-projection-self-hash");
  const pointer = value.manifest.samples[0];
  const target = path.join(value.root, ...pointer.path.split("/"));
  const receipt = JSON.parse(await fs.readFile(target, "utf8"));
  receipt.input_pre[0].path = "portable://local/9999";
  const written = await writeJson(target, receipt);
  pointer.sha256 = written.sha256;
  await rewriteManifest(value);
  await recomputeDiskSpaceObservedCohorts({ sampleManifestPath: value.manifestPath });
}, "DISK_SPACE_PORTABLE_PROJECTION_INVALID");

await expectCode("candidate-resealed-portable-path-leak", async () => {
  const value = await fixture("candidate-resealed-portable-path-leak");
  const pointer = value.manifest.samples[0];
  const target = path.join(value.root, ...pointer.path.split("/"));
  const receipt = JSON.parse(await fs.readFile(target, "utf8"));
  receipt.input_pre[0].path = ["", "Users", "private", "forged-input.pdf"].join("/");
  receipt.input_post[0].path = ["", "Users", "private", "forged-input.pdf"].join("/");
  receipt.portable_projection.redacted_value_count = new Set(
    JSON.stringify(receipt).match(/portable:\/\/local\/[0-9]{4}/g) ?? [],
  ).size;
  resealProjection(receipt);
  const receiptWritten = await writeJson(target, receipt);
  pointer.sha256 = receiptWritten.sha256;
  const manifestWritten = await writeJson(value.manifestPath, value.manifest);
  const resealed = {
    ...clean,
    sample_manifest_sha256: manifestWritten.sha256,
  };
  const bundle = await writeCandidatePolicyBundle(value, resealed);
  await loadDiskSpacePolicy({
    policyPath: bundle.policyPath,
    expectedPolicySha256: bundle.policySha256,
    mode: "candidate",
    schemaPath: POLICY_SCHEMA,
  });
}, "DISK_SPACE_PORTABLE_PATH_VIOLATION");

const reorderedFixture = await fixture("order-invariance");
reorderedFixture.manifest.samples.reverse();
await rewriteManifest(reorderedFixture);
const reordered = await recomputeDiskSpaceObservedCohorts({
  sampleManifestPath: reorderedFixture.manifestPath,
});
check(
  JSON.stringify(reordered.observed_cohorts) === JSON.stringify(clean.observed_cohorts),
  "sample manifest ordering changed recomputed statistics",
);
check(
  reordered.sample_manifest_sha256 !== clean.sample_manifest_sha256,
  "metamorphic fixture did not actually change manifest bytes",
);
check(caught.length === mutations.length, "not every declared raw-evidence mutation executed");
check(caught.every((id, index) => id === mutations[index]), "mutation order drifted");

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  checks,
  sample_manifest_schema: "excel-inflow-disk-space-sample-receipt-manifest/1.2",
  corpus_manifest_schema: "excel-inflow-disk-space-corpus-manifest/1.1",
  portable_resource_sample_schema: "excel-inflow-component-resource-sample-portable/1.0",
  source_resource_sample_schema: "excel-inflow-component-resource-sample/1.0",
  cohorts: Object.fromEntries(COHORTS.map((id) => [id, clean.observed_cohorts[id].sample_count])),
  mutations_declared: mutations.length,
  mutations_caught: caught.length,
  mutations_survived: mutations.length - caught.length,
  mutation_ids: caught,
  metamorphic_order_invariant: true,
})}\n`);

await fs.rm(scratch, { recursive: true, force: true });
