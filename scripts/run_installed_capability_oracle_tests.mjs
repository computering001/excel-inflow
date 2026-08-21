#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { declaredSkillVersion } from "./lib/skill_version_declaration.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SKILL_VERSION = declaredSkillVersion(ROOT);
const ORACLE = path.join(HERE, "verify", "installed_capability_oracle.py");
const [pythonInput, sofficeInput] = process.argv.slice(2);
if (!pythonInput || !sofficeInput) {
  throw new Error("usage: run_installed_capability_oracle_tests.mjs <python> <soffice>");
}
const python = path.resolve(pythonInput);
const soffice = await fs.realpath(path.resolve(sofficeInput));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "installed-capability-oracle-tests-"));
const installationIdentity = "installed-candidate:independent-receipt-oracle";
const v13EvaluatedAt = "2026-08-21T12:01:00.000Z";
let checks = 0;
const mutationIds = [
  "report-field",
  "receipt-field",
  "executable-path",
  "fixture-hash",
  "package-hash",
  "timestamp",
  "self-hash",
  "pointer-target",
  "pointer-declared-hash",
];
const caught = [];
const v13MutationIds = [
  "v13-source-null",
  "v13-source-dirty",
  "v13-compatibility-contract-hash",
  "v13-work-fact",
  "v13-temp-fact",
  "v13-work-disk-arithmetic",
  "v13-temp-disk-arithmetic",
  "v13-work-disk-required",
  "v13-temp-disk-required",
  "v13-work-disk-volume",
  "v13-temp-disk-volume",
  "v13-disk-policy-hash",
  "v13-disk-measurement-hash",
  "v13-libreoffice-fixture",
  "v13-libreoffice-result",
  "v13-xbrl-selected-authority",
  "v13-xbrl-dimension-quarantine",
  "v13-freshness-max-age",
  "v13-freshness-expiry-arithmetic",
  "v13-freshness-future-skew",
  "v13-freshness-current-expiry",
];
const v13Caught = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalise(value))}\n`, "utf8");
}

function canonicalIdentityBytes(value) {
  return Buffer.from(JSON.stringify(canonicalise(value)), "utf8");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function execute(command, args, options = {}) {
  try {
    const done = await execFileAsync(command, args, {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: String(done.stdout ?? ""), stderr: String(done.stderr ?? "") };
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : -1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

function lastJsonLine(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* continue */ }
  }
  return null;
}

function oracleArgs(artifactRoot, packageRoot, evaluatedAt = null, { candidate = false } = {}) {
  const args = [
    ORACLE,
    "--artifact-dir", artifactRoot,
    "--package-root", packageRoot,
    "--package-archive", `${packageRoot}.tar`,
    "--package-attestation", `${packageRoot}.attestation.json`,
    "--expected-node-executable", process.execPath,
    "--expected-python-executable", python,
    "--expected-soffice-executable", soffice,
    "--expected-deployment-status", candidate ? "installed_candidate" : "not_installed",
  ];
  if (candidate) args.push("--expected-installation-identity", installationIdentity);
  if (evaluatedAt) args.push("--evaluated-at", evaluatedAt);
  return args;
}

async function runOracle(artifactRoot, packageRoot, evaluatedAt = null, options = {}) {
  const result = await execute(python, oracleArgs(artifactRoot, packageRoot, evaluatedAt, options), {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
    timeout: 120_000,
  });
  return { ...result, report: lastJsonLine(result.stdout) };
}

async function readGeneration(root) {
  const pointerPath = path.join(root, "host-preflight-current.json");
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  const reportPath = path.join(root, pointer.report_file);
  const receiptPath = path.join(root, pointer.receipt_file);
  return {
    root,
    pointerPath,
    pointer,
    reportPath,
    report: JSON.parse(await fs.readFile(reportPath, "utf8")),
    receiptPath,
    receipt: JSON.parse(await fs.readFile(receiptPath, "utf8")),
  };
}

async function resealReport(generation) {
  const bytes = canonicalBytes(generation.report);
  const sha256 = digest(bytes);
  const target = path.join(generation.root, `runtime-doctor-report-${sha256}.json`);
  await fs.writeFile(target, bytes);
  generation.pointer.report_file = path.basename(target);
  generation.pointer.report_sha256 = sha256;
}

async function resealReceipt(generation, { recomputeSelf = true } = {}) {
  if (recomputeSelf) {
    const body = { ...generation.receipt };
    delete body.receipt_sha256;
    generation.receipt.receipt_sha256 = digest(canonicalBytes(body));
  }
  const bytes = canonicalBytes(generation.receipt);
  const sha256 = digest(bytes);
  const target = path.join(generation.root, `installed-capability-receipt-${sha256}.json`);
  await fs.writeFile(target, bytes);
  generation.pointer.receipt_file = path.basename(target);
  generation.pointer.receipt_sha256 = sha256;
  generation.pointer.receipt_self_sha256 = generation.receipt.receipt_sha256;
}

async function writePointer(generation) {
  await fs.writeFile(generation.pointerPath, canonicalBytes(generation.pointer));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reportCheck(report, id) {
  const matches = report.checks.filter((entry) => entry.precondition_id === id);
  assert.equal(matches.length, 1, `expected one ${id} report check`);
  return matches[0];
}

async function packageInventory(packageRoot) {
  const files = {};
  async function walk(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, relative);
      else if (entry.isFile()) files[relative] = digest(await fs.readFile(target));
      else throw new Error(`synthetic package contains unsupported member ${relative}`);
    }
  }
  await walk(packageRoot);
  const ordered = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]));
  return { files: ordered, sha256: digest(canonicalIdentityBytes(ordered)) };
}

async function createSyntheticV13Package(donorPackageRoot) {
  const packageRoot = path.join(scratch, "synthetic-v13-candidate-package");
  await Promise.all([
    fs.mkdir(path.join(packageRoot, "assets"), { recursive: true }),
    fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true }),
  ]);
  for (const relative of [
    "assets/installed-filings-capability-probe-v1.json",
    "assets/runtime-compatibility-v1.json",
    "assets/installed-inline-xbrl-capability-probe-v1.json",
    "assets/inline-xbrl-facts-v1.schema.json",
    "assets/disk-space-policy-v1.schema.json",
    "assets/disk-space-measurement-v1.schema.json",
    "scripts/extract_inline_xbrl.py",
  ]) {
    const sourceRoot = relative.startsWith("assets/disk-space-") ? ROOT : donorPackageRoot;
    await fs.copyFile(path.join(sourceRoot, ...relative.split("/")), path.join(packageRoot, ...relative.split("/")));
  }
  const closureSha256 = "c".repeat(64);
  const sourceCommit = "1".repeat(40);
  const sourceTree = "2".repeat(40);
  const rawManifests = {
    sample_receipts: { schema_version: "disk-space-sample-receipt-manifest/1.0", samples: Array.from({ length: 60 }, (_, index) => `sample-${index + 1}`) },
    filings: { schema_version: "disk-space-corpus-manifest/1.0", kind: "filings", inputs: ["filing"] },
    brokers: { schema_version: "disk-space-corpus-manifest/1.0", kind: "brokers", inputs: ["brokers"] },
    workbook: { schema_version: "disk-space-corpus-manifest/1.0", kind: "workbook", inputs: ["workbook"] },
  };
  const rawPointers = {};
  for (const [name, value] of Object.entries(rawManifests)) {
    const filename = `disk-space-${name}-manifest.json`;
    const bytes = canonicalBytes(value);
    await fs.writeFile(path.join(packageRoot, "assets", filename), bytes);
    rawPointers[name] = { path: filename, sha256: digest(bytes), schema_version: value.schema_version };
  }
  const stats = (sampleCount, median, p95, max) => ({
    statistic_kind: "OBSERVED", sample_count: sampleCount,
    median_bytes: median, p95_bytes: p95, observed_max_bytes: max,
  });
  const cohort = (id, work, temp, shared) => ({
    cohort_id: id, workload_kind: id,
    corpus_manifest_ref: `#/evidence_manifests/corpora/${id}`,
    sample_receipt_manifest_ref: "#/evidence_manifests/sample_receipts",
    sample_count: 20,
    root_statistics: {
      work_root: stats(20, ...work), temp_root: stats(20, ...temp),
      shared_volume_total: stats(20, ...shared),
    },
  });
  const observed = {
    filings: cohort("filings", [50, 80, 100], [40, 70, 90], [90, 150, 190]),
    brokers: cohort("brokers", [100, 150, 200], [90, 140, 180], [190, 290, 380]),
    workbook: cohort("workbook", [150, 220, 300], [140, 210, 280], [290, 430, 580]),
  };
  const derived = (ids) => ({
    derivation_kind: "DERIVED_CONSERVATIVE_BOUND",
    formula: "SUM_OBSERVED_MAXIMA",
    concurrency_assumption: "SUM_WHEN_CONCURRENCY_NOT_DISPROVED",
    input_cohorts: ids,
    bounds: Object.fromEntries(["work_root", "temp_root", "shared_volume_total"].map((rootId) => [rootId, {
      bound_kind: "DERIVED_CONSERVATIVE_BOUND",
      derived_conservative_bound_bytes: ids.reduce(
        (total, id) => total + observed[id].root_statistics[rootId].observed_max_bytes,
        0,
      ),
      input_refs: ids.map((id) => `#/observed_cohorts/${id}/root_statistics/${rootId}`),
    }])),
  });
  const measurement = {
    schema_version: "excel-inflow-disk-space-measurement/1.1",
    measurement_status: "COMPLETE",
    generated_at: "2026-08-21T11:00:00.000Z",
    methodology: {
      units: "bytes", peak_definition: "synthetic oracle contract",
      sampling_interval_ms: 100, quantile_method: "nearest_rank",
      minimum_samples_per_observed_cohort: 20,
      tool: { name: "oracle-fixture", version: "1.0", sha256: "a".repeat(64) },
    },
    measured_source_identity: {
      repository: "computering001/excel-inflow", source_commit: sourceCommit,
      source_tree: sourceTree, runtime_code_closure_sha256: closureSha256,
    },
    host_identity: { os_platform: "synthetic", os_release: "test", architecture: "test" },
    evidence_manifests: {
      sample_receipts: rawPointers.sample_receipts,
      corpora: { filings: rawPointers.filings, brokers: rawPointers.brokers, workbook: rawPointers.workbook },
    },
    observed_cohorts: { ...observed, actual_combined: null },
    derived_bounds: { evidence: derived(["filings", "brokers"]), combined: derived(["filings", "brokers", "workbook"]) },
  };
  const measurementBytes = canonicalBytes(measurement);
  await fs.writeFile(path.join(packageRoot, "assets", "disk-space-measurement-v1.json"), measurementBytes);
  const policySchemaBytes = await fs.readFile(path.join(packageRoot, "assets", "disk-space-policy-v1.schema.json"));
  const measurementSchemaBytes = await fs.readFile(path.join(packageRoot, "assets", "disk-space-measurement-v1.schema.json"));
  const floor = (min, kind, ref, basis, margin) => ({
    min_free_bytes: min, basis_kind: kind, basis_ref: ref,
    basis_bytes: basis, safety_margin_bytes: margin,
  });
  const diskSpacePolicy = {
    schema_version: "excel-inflow-disk-space-policy/1.1",
    policy_schema_sha256: digest(policySchemaBytes),
    policy_status: "SEALED_MEASURED",
    lower_override_action: "REFUSE",
    measured_source_identity: measurement.measured_source_identity,
    measurement_evidence: {
      path: "disk-space-measurement-v1.json", sha256: digest(measurementBytes),
      schema_version: measurement.schema_version,
      schema_path: "disk-space-measurement-v1.schema.json", schema_sha256: digest(measurementSchemaBytes),
      sample_receipt_manifest_sha256: rawPointers.sample_receipts.sha256,
      corpus_manifest_sha256: {
        filings: rawPointers.filings.sha256, brokers: rawPointers.brokers.sha256,
        workbook: rawPointers.workbook.sha256,
      },
    },
    floors: {
      evidence: {
        distinct_volumes: {
          work_root: floor(350, "derived_conservative_bound_plus_safety", "#/derived_bounds/evidence/bounds/work_root", 300, 50),
          temp_root: floor(320, "derived_conservative_bound_plus_safety", "#/derived_bounds/evidence/bounds/temp_root", 270, 50),
        },
        shared_volume: floor(620, "derived_conservative_bound_plus_safety", "#/derived_bounds/evidence/bounds/shared_volume_total", 570, 50),
      },
      workbook: {
        distinct_volumes: {
          work_root: floor(440, "twice_observed_p95", "#/observed_cohorts/workbook/root_statistics/work_root", 440, 0),
          temp_root: floor(420, "twice_observed_p95", "#/observed_cohorts/workbook/root_statistics/temp_root", 420, 0),
        },
        shared_volume: floor(860, "twice_observed_p95", "#/observed_cohorts/workbook/root_statistics/shared_volume_total", 860, 0),
      },
      combined: {
        distinct_volumes: {
          work_root: floor(700, "derived_conservative_bound_plus_safety", "#/derived_bounds/combined/bounds/work_root", 600, 100),
          temp_root: floor(650, "derived_conservative_bound_plus_safety", "#/derived_bounds/combined/bounds/temp_root", 550, 100),
        },
        shared_volume: floor(1250, "derived_conservative_bound_plus_safety", "#/derived_bounds/combined/bounds/shared_volume_total", 1150, 100),
      },
    },
  };
  const syntheticPolicyBytes = canonicalBytes(diskSpacePolicy);
  await fs.writeFile(
    path.join(packageRoot, "assets", "disk-space-policy-v1.json"),
    syntheticPolicyBytes,
  );
  await fs.writeFile(
    path.join(packageRoot, "assets", "deployment-profile.json"),
    canonicalBytes({
      runtime_disk_space_policy: {
        path: "assets/disk-space-policy-v1.json",
        sha256: digest(syntheticPolicyBytes),
      },
    }),
  );
  const manifest = {
    schemaVersion: "release-manifest/4.0",
    skillVersion: SKILL_VERSION,
    sourceWorktreeDirty: false,
    identity: {
      source: {
        repository: "computering001/excel-inflow",
        commit_sha: sourceCommit,
        tree_sha: sourceTree,
      },
      package: {
        mode: "standard_maximal",
        runtime_code_closure: {
          sha256: closureSha256,
          certified_sha256: closureSha256,
        },
      },
      deployment: {
        status: "installed_candidate",
        installation_identity: installationIdentity,
        installed_package: { sha256: null },
      },
    },
  };
  await fs.writeFile(path.join(packageRoot, "release-manifest.json"), canonicalBytes(manifest));
  const archiveBytes = Buffer.from("synthetic receipt-1.3 candidate archive\n", "utf8");
  await fs.writeFile(`${packageRoot}.tar`, archiveBytes);
  const inventory = await packageInventory(packageRoot);
  const archiveSha256 = digest(archiveBytes);
  const productIdentity = {
    schema_version: "product-identity/2.0",
    source: {
      identity_kind: "source_tree",
      repository: manifest.identity.source.repository,
      commit_sha: sourceCommit,
      tree_sha: sourceTree,
    },
    package: {
      mode: manifest.identity.package.mode,
      runtime_code_closure: {
        identity_kind: "runtime_code_closure",
        sha256: closureSha256,
        certified_sha256: closureSha256,
      },
      complete_package_inventory: {
        identity_kind: "complete_package_inventory",
        sha256: inventory.sha256,
      },
      archive: { identity_kind: "archive", sha256: archiveSha256 },
    },
    deployment: {
      status: "installed_candidate",
      installation_identity: installationIdentity,
      installed_package: { identity_kind: "installed_package", sha256: null },
    },
  };
  const attestationBody = {
    schema_version: "release-package-attestation/1.0",
    package: {
      complete_package_inventory: inventory,
      archive: { sha256: archiveSha256 },
      release_manifest_sha256: inventory.files["release-manifest.json"],
      product_identity: productIdentity,
    },
  };
  const attestation = {
    ...attestationBody,
    attestation_sha256: digest(canonicalIdentityBytes(attestationBody)),
  };
  await fs.writeFile(`${packageRoot}.attestation.json`, canonicalBytes(attestation));
  return {
    packageRoot,
    diskSpacePolicy,
    diskSpacePolicySha256: digest(await fs.readFile(path.join(packageRoot, "assets", "disk-space-policy-v1.json"))),
    diskSpacePolicySchemaSha256: digest(policySchemaBytes),
    diskSpaceMeasurementSha256: digest(measurementBytes),
    diskSpaceMeasurementSchemaSha256: digest(measurementSchemaBytes),
    diskSpaceRawManifestSha256: Object.fromEntries(
      Object.entries(rawPointers).map(([name, pointer]) => [name, pointer.sha256]),
    ),
    expectedSource: {
      repository: manifest.identity.source.repository,
      source_commit: sourceCommit,
      source_tree: sourceTree,
      source_worktree_dirty: false,
      skill_version: manifest.skillVersion,
      package_mode: manifest.identity.package.mode,
      deployment_status: "installed_candidate",
      closure_check_status: "match",
      active_runtime_code_closure_sha256: closureSha256,
      declared_runtime_code_closure_sha256: closureSha256,
      complete_package_inventory_sha256: inventory.sha256,
      archive_sha256: archiveSha256,
      release_package_attestation_sha256: attestation.attestation_sha256,
      installation_identity: installationIdentity,
    },
  };
}

function diskSpaceEvaluation(workFacts, tempFacts, synthetic, generatedAt) {
  const policyFloor = synthetic.diskSpacePolicy.floors.combined;
  const declared = {
    distinct_volumes: {
      work_root: policyFloor.distinct_volumes.work_root.min_free_bytes,
      temp_root: policyFloor.distinct_volumes.temp_root.min_free_bytes,
    },
    shared_volume: policyFloor.shared_volume.min_free_bytes,
  };
  const sameVolume = workFacts.volume_identity.device_id === tempFacts.volume_identity.device_id;
  const required = clone(declared);
  const available = sameVolume ? declared.shared_volume + 5_000_000 : null;
  const root = (rootKind, facts) => {
    const requiredBytes = sameVolume ? declared.shared_volume : declared.distinct_volumes[rootKind];
    const availableBytes = sameVolume ? available : requiredBytes + 5_000_000;
    return {
      available_bytes: availableBytes,
      required_bytes: requiredBytes,
      headroom_bytes: availableBytes - requiredBytes,
      status: "PASS",
      volume_identity: clone(facts.volume_identity),
    };
  };
  return {
    status: "PASS",
    schema_version: "excel-inflow-disk-space-evaluation/1.1",
    mode: "candidate",
    requested_lanes: ["evidence", "workbook"],
    selected_lane: "combined",
    selected_volume_topology: sameVolume ? "shared_volume" : "distinct_volumes",
    observed_at: generatedAt,
    policy_floor_bytes: clone(declared),
    override_min_free_bytes: null,
    required_free_bytes: required,
    roots: { work_root: root("work_root", workFacts), temp_root: root("temp_root", tempFacts) },
    policy_evidence: {
      policy_schema_version: synthetic.diskSpacePolicy.schema_version,
      policy_schema_sha256: synthetic.diskSpacePolicySchemaSha256,
      policy_sha256: synthetic.diskSpacePolicySha256,
      policy_sealed: true,
      measurement_evidence_sha256: synthetic.diskSpaceMeasurementSha256,
      measurement_schema_version: "excel-inflow-disk-space-measurement/1.1",
      measurement_schema_sha256: synthetic.diskSpaceMeasurementSchemaSha256,
      raw_manifest_sha256: clone(synthetic.diskSpaceRawManifestSha256),
    },
    total_violations: 0,
    findings: [],
  };
}

async function createV13Generation(legacyArtifactRoot, donorPackageRoot) {
  const synthetic = await createSyntheticV13Package(donorPackageRoot);
  const artifactRoot = path.join(scratch, "clean-v13-capability-artifacts");
  await fs.cp(legacyArtifactRoot, artifactRoot, { recursive: true, force: false, errorOnExist: true });
  const generation = await readGeneration(artifactRoot);
  // Exactly +300 seconds proves that the declared future-skew boundary is
  // inclusive; the paired +301-second mutation below must be rejected.
  const generatedAt = "2026-08-21T12:06:00.000Z";
  generation.report.generated_at = generatedAt;
  const sourceCheck = reportCheck(generation.report, "active_source_identity");
  sourceCheck.result = "satisfied";
  sourceCheck.reason = null;
  sourceCheck.detail = clone(synthetic.expectedSource);

  const compatibility = reportCheck(generation.report, "runtime_version_compatibility");
  const contractBytes = await fs.readFile(path.join(synthetic.packageRoot, "assets", "runtime-compatibility-v1.json"));
  compatibility.detail.contract_sha256 = digest(contractBytes);

  const inline = reportCheck(generation.report, "inline_xbrl_host_probe");
  delete inline.detail.compatibility_prerequisite;
  const work = reportCheck(generation.report, "work_root_writable");
  const temp = reportCheck(generation.report, "temp_root_writable");
  const diskEvaluation = diskSpaceEvaluation(work.detail, temp.detail, synthetic, generatedAt);
  const diskCheck = reportCheck(generation.report, "disk_space_policy");
  diskCheck.result = "satisfied";
  diskCheck.reason = null;
  diskCheck.detail = {
    mode: "candidate",
    policy_path: path.join(
      synthetic.packageRoot, "assets", "disk-space-policy-v1.json",
    ),
    expected_policy_sha256: synthetic.diskSpacePolicySha256,
    override_min_free_bytes: null,
    evaluation: clone(diskEvaluation),
  };

  const receipt = generation.receipt;
  receipt.schema_version = "excel-inflow-installed-capability-receipt/1.3";
  receipt.status = "HOST_READY";
  receipt.readiness_scope = "inactive_candidate_slot_only";
  receipt.candidate_slot_ready = true;
  receipt.candidate_slot_refusal_reason = null;
  receipt.production_promotion_eligible = false;
  receipt.production_promotion_refusal_reason =
    "Candidate-slot readiness is not production promotion evidence.";
  receipt.generated_at = generatedAt;
  receipt.source_identity = clone(synthetic.expectedSource);
  receipt.runtime_compatibility = clone(compatibility.detail);
  receipt.inline_xbrl = clone(inline.detail);
  delete receipt.inline_xbrl_probe;
  receipt.filesystem = {
    work_root: { result: "satisfied", facts: clone(work.detail) },
    temp_root: { result: "satisfied", facts: clone(temp.detail) },
    disk_space_evaluation: clone(diskEvaluation),
  };
  receipt.freshness = {
    policy: "activation_transaction",
    max_age_seconds: 3600,
    generated_at: generatedAt,
    expires_at: "2026-08-21T13:06:00.000Z",
    evaluated_at: v13EvaluatedAt,
    status: "FRESH",
  };
  await resealReport(generation);
  receipt.runtime_doctor_sha256 = generation.pointer.report_sha256;
  await resealReceipt(generation);
  await writePointer(generation);
  return { generation, ...synthetic };
}

async function resealV13Generation(generation) {
  await resealReport(generation);
  generation.receipt.runtime_doctor_sha256 = generation.pointer.report_sha256;
  await resealReceipt(generation);
  await writePointer(generation);
}

const mutations = {
  "report-field": async (generation) => {
    generation.report.host.architecture = `${generation.report.host.architecture}-mutated`;
    await resealReport(generation);
  },
  "receipt-field": async (generation) => {
    generation.receipt.host.architecture = `${generation.receipt.host.architecture}-mutated`;
    await resealReceipt(generation);
  },
  "executable-path": async (generation) => {
    generation.receipt.node.executable = path.join(scratch, "not-the-selected-node");
    await resealReceipt(generation);
  },
  "fixture-hash": async (generation) => {
    generation.receipt.mandatory_filings_probe.fixture_sha256 = "0".repeat(64);
    await resealReceipt(generation);
  },
  "package-hash": async (generation) => {
    generation.receipt.source_identity.complete_package_inventory_sha256 = "0".repeat(64);
    await resealReceipt(generation);
  },
  timestamp: async (generation) => {
    generation.receipt.generated_at = new Date(
      Date.parse(generation.receipt.generated_at) + 1000,
    ).toISOString();
    await resealReceipt(generation);
  },
  "self-hash": async (generation) => {
    generation.receipt.receipt_sha256 = "0".repeat(64);
    await resealReceipt(generation, { recomputeSelf: false });
  },
  "pointer-target": async (generation) => {
    const alternate = path.join(generation.root, "alternate-report.json");
    await fs.copyFile(generation.reportPath, alternate);
    generation.pointer.report_file = path.basename(alternate);
  },
  "pointer-declared-hash": async (generation) => {
    generation.pointer.report_sha256 = "0".repeat(64);
  },
};

function mutateDiskEvaluation(generation, operation) {
  operation(generation.receipt.filesystem.disk_space_evaluation);
  operation(reportCheck(generation.report, "disk_space_policy").detail.evaluation);
}

const v13Mutations = {
  "v13-source-null": async (generation) => {
    generation.receipt.source_identity.source_commit = null;
    reportCheck(generation.report, "active_source_identity").detail.source_commit = null;
  },
  "v13-source-dirty": async (generation) => {
    generation.receipt.source_identity.source_worktree_dirty = true;
    reportCheck(generation.report, "active_source_identity").detail.source_worktree_dirty = true;
  },
  "v13-compatibility-contract-hash": async (generation) => {
    generation.receipt.runtime_compatibility.contract_sha256 = "0".repeat(64);
    reportCheck(generation.report, "runtime_version_compatibility").detail.contract_sha256 = "0".repeat(64);
  },
  "v13-work-fact": async (generation) => {
    generation.receipt.filesystem.work_root.facts.written = false;
    reportCheck(generation.report, "work_root_writable").detail.written = false;
  },
  "v13-temp-fact": async (generation) => {
    generation.receipt.filesystem.temp_root.facts.cleanup_verified = false;
    reportCheck(generation.report, "temp_root_writable").detail.cleanup_verified = false;
  },
  "v13-work-disk-arithmetic": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.roots.work_root.headroom_bytes += 1; },
  ),
  "v13-temp-disk-arithmetic": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.roots.temp_root.headroom_bytes -= 1; },
  ),
  "v13-work-disk-required": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.roots.work_root.required_bytes += 1; },
  ),
  "v13-temp-disk-required": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.roots.temp_root.required_bytes += 1; },
  ),
  "v13-work-disk-volume": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.roots.work_root.volume_identity.device_id += "-wrong"; },
  ),
  "v13-temp-disk-volume": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.roots.temp_root.volume_identity.filesystem_type += "-wrong"; },
  ),
  "v13-disk-policy-hash": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.policy_evidence.policy_sha256 = "0".repeat(64); },
  ),
  "v13-disk-measurement-hash": async (generation) => mutateDiskEvaluation(
    generation, (value) => { value.policy_evidence.measurement_evidence_sha256 = "f".repeat(64); },
  ),
  "v13-libreoffice-fixture": async (generation) => {
    generation.receipt.workbook.functional_capability.fixture.sha256 = "0".repeat(64);
  },
  "v13-libreoffice-result": async (generation) => {
    generation.receipt.workbook.functional_capability.output.sha256 = "0".repeat(64);
  },
  "v13-xbrl-selected-authority": async (generation) => {
    const concept = Object.keys(generation.receipt.inline_xbrl.selected_non_dimensioned_authority)[0];
    generation.receipt.inline_xbrl.selected_non_dimensioned_authority[concept][0].value += 1;
    reportCheck(generation.report, "inline_xbrl_host_probe")
      .detail.selected_non_dimensioned_authority[concept][0].value += 1;
  },
  "v13-xbrl-dimension-quarantine": async (generation) => {
    generation.receipt.inline_xbrl.quarantined_dimensioned_fact.context_ref = "D2025";
    reportCheck(generation.report, "inline_xbrl_host_probe")
      .detail.quarantined_dimensioned_fact.context_ref = "D2025";
  },
  "v13-freshness-max-age": async (generation) => {
    generation.receipt.freshness.max_age_seconds = 3599;
  },
  "v13-freshness-expiry-arithmetic": async (generation) => {
    generation.receipt.freshness.expires_at = "2026-08-21T13:06:01.000Z";
  },
  "v13-freshness-future-skew": async (generation) => {
    const generatedAt = "2026-08-21T12:06:01.000Z";
    generation.report.generated_at = generatedAt;
    generation.receipt.generated_at = generatedAt;
    generation.receipt.freshness.generated_at = generatedAt;
    generation.receipt.freshness.expires_at = "2026-08-21T13:06:01.000Z";
  },
  "v13-freshness-current-expiry": async (generation) => {
    const generatedAt = "2026-08-21T11:00:00.000Z";
    generation.report.generated_at = generatedAt;
    generation.receipt.generated_at = generatedAt;
    generation.receipt.freshness.generated_at = generatedAt;
    generation.receipt.freshness.expires_at = "2026-08-21T12:00:00.000Z";
    generation.receipt.freshness.status = "EXPIRED";
  },
};

try {
  const oracleSource = await fs.readFile(ORACLE, "utf8");
  check(
    !/sys\.path|importlib|scripts\.lib|from\s+scripts|import\s+scripts/.test(oracleSource),
    "the independent oracle reaches into the candidate or product helper path",
  );
  const imported = [...oracleSource.matchAll(/^(?:from|import)\s+([A-Za-z0-9_]+)/gm)]
    .map((match) => match[1]);
  const allowed = new Set([
    "__future__", "argparse", "base64", "datetime", "hashlib", "json", "os", "pathlib",
    "re", "stat", "sys", "typing",
  ]);
  check(imported.every((name) => allowed.has(name)), `oracle imports non-stdlib modules: ${imported.join(", ")}`);

  const profile = JSON.parse(await fs.readFile(path.join(ROOT, "assets", "deployment-profile.json"), "utf8"));
  check(
    !(profile.script_allowlist ?? []).includes("verify/installed_capability_oracle.py") &&
      !(profile.python_module_allowlist ?? []).includes("verify/installed_capability_oracle.py"),
    "the external audit oracle entered the shipped production allowlist",
  );

  const packageRoot = path.join(scratch, "compiled-capability-package");
  const compile = await execute(process.execPath, [
    path.join(HERE, "compile_skill_release.mjs"),
    "--skill", ROOT,
    "--out", packageRoot,
    "--development",
  ], {
    env: {
      ...process.env,
      EXCEL_INFLOW_TEST_PYTHON: python,
      EXCEL_INFLOW_PYTHON: python,
      PYTHON: python,
      SOFFICE_BIN: soffice,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 300_000,
  });
  check(compile.code === 0, `development capability package did not compile: ${compile.stderr}`);
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "release-manifest.json"), "utf8"));
  check(
    !(manifest.files ?? []).some((entry) => entry.path === "scripts/verify/installed_capability_oracle.py"),
    "the compiled candidate shipped its external audit oracle",
  );

  const artifactRoot = path.join(scratch, "clean-capability-artifacts");
  const runRoot = path.join(scratch, "prospective-run");
  await fs.mkdir(artifactRoot, { recursive: true });
  const doctor = await execute(process.execPath, [
    path.join(packageRoot, "scripts", "run_excel_inflow_bootstrap.mjs"),
    "--diagnostic",
    "--run-root", runRoot,
    "--lane", "evidence,workbook",
    "--python", python,
    "--soffice", soffice,
    "--out", path.join(artifactRoot, "runtime-doctor-report.json"),
    "--capability-receipt", path.join(artifactRoot, "installed-capability-receipt.json"),
    "--json",
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      EXCEL_INFLOW_TEST_PYTHON: python,
      EXCEL_INFLOW_PYTHON: python,
      PYTHON: python,
      SOFFICE_BIN: soffice,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 300_000,
  });
  check(
    doctor.code === 0,
    `clean installed capability artifact did not close (exit ${doctor.code}): ${doctor.stdout} ${doctor.stderr}`,
  );

  const clean = await runOracle(artifactRoot, packageRoot);
  check(
    clean.code === 0 &&
      clean.report?.status === "NOT_ACTIVATION_ELIGIBLE" &&
      clean.report.audit_status === "PASS" &&
      clean.report.activation_eligible === false &&
      clean.report.total_violations === 0,
    `independent oracle rejected the clean generation: ${clean.stdout} ${clean.stderr}`,
  );
  check(
    /^[a-f0-9]{64}$/.test(clean.report.proof.complete_package_inventory_sha256) &&
      clean.report.proof.pointer_final_bytes_stable === true,
    "clean proof omitted independently recomputed inventory or stable final pointer bytes",
  );

  for (const mutationId of mutationIds) {
    const mutationRoot = path.join(scratch, `mutation-${mutationId}`);
    await fs.cp(artifactRoot, mutationRoot, { recursive: true, force: false, errorOnExist: true });
    const generation = await readGeneration(mutationRoot);
    await mutations[mutationId](generation);
    await writePointer(generation);
    const observed = await runOracle(mutationRoot, packageRoot);
    check(
      observed.code === 1 && observed.report?.status === "FAIL" &&
        observed.report.total_violations >= 1,
      `${mutationId} escaped the independent oracle: ${observed.stdout} ${observed.stderr}`,
    );
    caught.push(mutationId);
  }

  const v13 = await createV13Generation(artifactRoot, packageRoot);
  const cleanV13 = await runOracle(
    v13.generation.root,
    v13.packageRoot,
    v13EvaluatedAt,
    { candidate: true },
  );
  check(
    cleanV13.code === 0 && cleanV13.report?.status === "PASS" &&
      cleanV13.report.audit_status === "PASS" &&
      cleanV13.report.activation_eligible === true &&
      cleanV13.report.receipt_schema_version === "excel-inflow-installed-capability-receipt/1.3" &&
      cleanV13.report.total_violations === 0,
    `independent oracle rejected synthetic valid receipt 1.3: ${cleanV13.stdout} ${cleanV13.stderr}`,
  );

  for (const mutationId of v13MutationIds) {
    const mutationRoot = path.join(scratch, `mutation-${mutationId}`);
    await fs.cp(v13.generation.root, mutationRoot, { recursive: true, force: false, errorOnExist: true });
    const generation = await readGeneration(mutationRoot);
    await v13Mutations[mutationId](generation);
    await resealV13Generation(generation);
    const observed = await runOracle(
      mutationRoot,
      v13.packageRoot,
      v13EvaluatedAt,
      { candidate: true },
    );
    check(
      observed.code === 1 && observed.report?.status === "FAIL" &&
        observed.report.total_violations >= 1,
      `${mutationId} escaped the independent v1.3 semantics: ${observed.stdout} ${observed.stderr}`,
    );
    v13Caught.push(mutationId);
  }

  check(caught.length === mutationIds.length, "not every declared receipt mutation executed");
  check(v13Caught.length === v13MutationIds.length, "not every declared v1.3 semantic mutation executed");
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    real_dirty_v13: {
      audit_status: clean.report.audit_status,
      status: clean.report.status,
      activation_eligible: clean.report.activation_eligible,
      oracle_checks: clean.report.checks,
    },
    synthetic_v13: {
      status: cleanV13.report.status,
      activation_eligible: cleanV13.report.activation_eligible,
      oracle_checks: cleanV13.report.checks,
    },
    mutations_declared: mutationIds.length + v13MutationIds.length,
    mutations_applied: caught.length + v13Caught.length,
    mutations_caught: caught.length + v13Caught.length,
    mutations_survived: mutationIds.length + v13MutationIds.length - caught.length - v13Caught.length,
    mutation_ids: [...caught, ...v13Caught],
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
