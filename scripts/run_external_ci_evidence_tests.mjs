#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  CI_PREREQUISITE_JOB_IDS,
  canonicalSha256,
  compileRegistrySelectionReceipt,
  compileReleaseCandidateAttestation,
  compileSourceIdentityReceipt,
  compileTestLifecycleReceipt,
  verifyRegistrySelectionReceipt,
  verifyReleaseCandidateAttestation,
  verifySourceIdentityReceipt,
  verifyTestLifecycleReceipt,
} from "./lib/external_ci_evidence.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H = (text) => canonicalSha256({ text });
const C = "1".repeat(40);
const T = "2".repeat(40);
const M = "3".repeat(40);
const MT = "4".repeat(40);
const AT = "2026-08-21T09:00:00.000Z";
const DONE = "2026-08-21T09:00:01.000Z";
let checks = 0;
let mutationsCaught = 0;

function check(condition, message) {
  assert(condition, message);
  checks += 1;
}

function mutation(label, fn, pattern = /./) {
  assert.throws(fn, pattern, `${label} mutation escaped`);
  checks += 1;
  mutationsCaught += 1;
}

function clone(value) {
  return structuredClone(value);
}

function reseal(value, field = "evidence_sha256") {
  const copy = clone(value);
  delete copy[field];
  copy[field] = canonicalSha256(copy);
  return copy;
}

const sourceInput = {
  github_sha: C,
  source_commit: C,
  source_tree: T,
  repository: "computering001/excel-inflow",
  ref: "refs/pull/72/head",
  event_name: "pull_request",
  run: { id: "123456", attempt: 1 },
  runner: { os: "Linux", arch: "X64", image: "ubuntu-24.04" },
  toolchain: { node: "v22.18.0", python: "Python 3.12.11", soffice: "LibreOffice 24.2" },
  worktree: { clean: true, status_sha256: H("") },
  recorded_at: AT,
};
const source = compileSourceIdentityReceipt(sourceInput);
check(source.status === "PASS" && source.github_sha === C && source.toolchain_sha256 === canonicalSha256(sourceInput.toolchain), "source receipt did not bind exact head and toolchain");
verifySourceIdentityReceipt(source);
check(true, "source verifier rejected its compiler output");

const rows = [
  { id: "public-bootstrap", command: ["node", "scripts/run_public_bootstrap_tests.mjs"], timeout_seconds: 900, disposition: "PORTABLE_SELECTED" },
  { id: "runtime-doctor", command: ["node", "scripts/run_runtime_doctor_tests.mjs"], timeout_seconds: 300, disposition: "PORTABLE_SELECTED" },
  { id: "native-excel-custody", command: ["python3", "scripts/run_native_excel_custody_tests.py"], timeout_seconds: 600, disposition: "INSTALLED_HOST_EXCLUDED" },
];
const registry = compileRegistrySelectionReceipt({ source_identity: source, rows, recorded_at: AT });
check(registry.counts.registry === 3 && registry.counts.portable === 2 && registry.counts.installed_host_excluded === 1, "registry counts are not complete");
check(registry.selected_test_ids.join(",") === "public-bootstrap,runtime-doctor" && registry.selected_test_ids_sha256 === canonicalSha256(registry.selected_test_ids), "registry selected IDs/digest are wrong");
verifyRegistrySelectionReceipt(registry, source);
check(true, "registry verifier rejected compiler output");

const log = (id, stream) => ({ path: `test-logs/${id}.${stream}.log`, sha256: H(`${id}:${stream}`), bytes: 12 });
const terminal = (id, status = "PASS") => ({
  id,
  status,
  exit_code: status === "PASS" ? 0 : 1,
  signal: null,
  started_at: AT,
  completed_at: DONE,
  duration_ms: 1000,
  timeout_ms: 60_000,
  timed_out: status === "TIMEOUT",
  stdout_log: log(id, "stdout"),
  stderr_log: log(id, "stderr"),
});
const starts = registry.selected_test_ids.map((id) => ({ id, started_at: AT }));
const terminals = registry.selected_test_ids.map((id) => terminal(id));
const portable = compileTestLifecycleReceipt({
  job_id: "portable_gate", source_identity: source, registry_selection: registry,
  selection_scope: "PORTABLE_ALL", selected_test_ids: registry.selected_test_ids,
  starts, terminals, recorded_at: DONE,
});
check(portable.status === "PASS" && portable.counts.selected === portable.counts.started && portable.counts.started === portable.counts.terminal, "portable lifecycle did not prove selected=started=terminal");
verifyTestLifecycleReceipt(portable, source, registry);
check(true, "lifecycle verifier rejected compiler output");
const targeted = compileTestLifecycleReceipt({
  job_id: "targeted_runtime", source_identity: source, registry_selection: registry,
  selection_scope: "TARGETED", selected_test_ids: ["public-bootstrap"],
  starts: [starts[0]], terminals: [terminals[0]], recorded_at: DONE,
});

const binding = registry.source_binding;
const inventory = H("inventory");
const archiveSha = H("archive");
const closure = H("closure");
const candidateVersion = "9.9.9";
const buildTimestampPolicy = {
  kind: "SOURCE_DATE_EPOCH",
  source_date_epoch: 1_766_000_000,
  generated_at: new Date(1_766_000_000 * 1000).toISOString(),
};
const packageReceipt = (jobId) => ({
  schema_version: "excel-inflow-ci-package-build-receipt/1.0", job_id: jobId, status: "PASS",
  source_binding: binding, clean_checkout: true, toolchain_sha256: source.toolchain_sha256,
  candidate_version: candidateVersion, package_mode: "development", deployment_status: "not_installed",
  build_timestamp_policy: buildTimestampPolicy,
  package_inventory_sha256: inventory, archive_sha256: archiveSha, archive_bytes: 8192,
  runtime_closure_sha256: closure, build_log: log(jobId, "build"),
});
const packageA = packageReceipt("package_a");
const packageB = packageReceipt("package_b");
const reproducibility = {
  schema_version: "excel-inflow-ci-package-reproducibility-receipt/1.0", job_id: "package_reproducibility", status: "PASS",
  source_binding: binding, archive_a_sha256: archiveSha, archive_b_sha256: archiveSha,
  inventory_a_sha256: inventory, inventory_b_sha256: inventory,
  paths_types_bytes_sha_modes_identical: true, archives_byte_identical: true, inventories_identical: true,
  source_date_epoch: 1_766_000_000,
};
const archive = {
  schema_version: "excel-inflow-ci-archive-capability-receipt/1.0", job_id: "archive_capability", status: "PASS",
  source_binding: binding, archive_sha256: archiveSha, source_checkout_used: false,
  public_bootstrap_status: "PASS", installed_capability_status: "PASS", independent_oracle_status: "PASS",
  capability_report_sha256: H("capability-report"), capability_receipt_sha256: H("capability-receipt"),
  independent_oracle_report_sha256: H("oracle"),
};
const mutationReceipt = {
  schema_version: "excel-inflow-ci-mutation-measurement-receipt/1.0", job_id: "mutation_measurement", status: "PASS",
  source_binding: binding, total_mutation_suites: 40, measured_mutation_suites: 30,
  unmeasured_mutation_suites: 10, measurement_coverage: 0.75,
  measured_mutations_applied: 120, measured_mutations_caught: 120, measured_mutations_survived: 0,
  p0_fully_measured: true, p0_status: "PASS", report_sha256: H("mutation-report"),
};
const merge = {
  schema_version: "excel-inflow-ci-synthetic-merge-receipt/1.0", job_id: "synthetic_merge", status: "PASS",
  source_binding: binding, candidate_commit: C, candidate_tree: T, merge_commit: M, merge_tree: MT,
  candidate_is_parent: true,
};
const prerequisites = {
  source_identity: source, registry_selection: registry, targeted_runtime: targeted, portable_gate: portable,
  package_a: packageA, package_b: packageB, package_reproducibility: reproducibility,
  archive_capability: archive, mutation_measurement: mutationReceipt, synthetic_merge: merge,
};
const attestation = compileReleaseCandidateAttestation(prerequisites);
check(attestation.status === "PASS" && Object.keys(attestation.prerequisites).length === 10 && attestation.toolchain_sha256 === source.toolchain_sha256, "final attestation did not consume exactly ten jobs and bind the toolchain");
check(attestation.package.archive_sha256 === archiveSha && attestation.mutation.measured_survived === 0 && attestation.mutation.measurement_coverage === 0.75, "attestation omitted package or honest partial mutation authority");
check(attestation.candidate_version === candidateVersion && attestation.source_commit === C && attestation.source_tree === T &&
  attestation.complete_package_inventory_sha256 === inventory && attestation.archive_sha256 === archiveSha &&
  attestation.runtime_closure_sha256 === closure && attestation.package.package_mode === "development" &&
  attestation.package.deployment_status === "not_installed" && attestation.package.build_timestamp_policy.kind === "SOURCE_DATE_EPOCH",
"attestation omitted the explicit Phase-5 candidate/package identity");
check(attestation.exact_head_ci_run === "github-actions:computering001/excel-inflow:123456:1" &&
  attestation.registry_selection_sha256 === registry.evidence_sha256 &&
  attestation.mutation_report_sha256 === mutationReceipt.report_sha256 &&
  attestation.package_reproducibility_sha256 === canonicalSha256(reproducibility) &&
  attestation.installed_capability_archive_test_sha256 === canonicalSha256(archive) &&
  attestation.created_at === AT,
"attestation omitted an explicit external CI evidence binding");
check(attestation.scope === "EXACT_HEAD_DEVELOPMENT_EVIDENCE_ONLY" && attestation.production_promotion_eligible === false && attestation.full_release_certification === false, "partial exact-head evidence falsely claims promotion or full certification");
verifyReleaseCandidateAttestation(attestation);
check(true, "attestation verifier rejected compiler output");

for (const [name, schemaFile, value] of [
  ["source", "ci-source-identity-receipt-v1.schema.json", source],
  ["registry", "ci-registry-selection-receipt-v1.schema.json", registry],
  ["lifecycle", "ci-test-lifecycle-receipt-v1.schema.json", portable],
  ["mutation", "ci-mutation-measurement-receipt-v1.schema.json", mutationReceipt],
  ["attestation", "release-candidate-attestation-v1.schema.json", attestation],
]) {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT, "assets", schemaFile), "utf8"));
  check(validateJsonSchema(value, schema).length === 0, `${name} output is not schema-valid`);
  const extra = { ...value, undeclared: true };
  check(validateJsonSchema(extra, schema).some((error) => error.includes("not an allowed property")), `${name} schema is not closed`);
  mutationsCaught += 1;
}

mutation("source/commit mismatch", () => compileSourceIdentityReceipt({ ...sourceInput, source_commit: M }), /exactly equal/);
mutation("source/dirty worktree", () => compileSourceIdentityReceipt({ ...sourceInput, worktree: { ...sourceInput.worktree, clean: false } }), /clean/);
mutation("source/bad ref", () => compileSourceIdentityReceipt({ ...sourceInput, ref: "main" }), /full Git ref/);
mutation("source/empty toolchain", () => compileSourceIdentityReceipt({ ...sourceInput, toolchain: { ...sourceInput.toolchain, python: "" } }), /non-empty/);
mutation("source/missing event", () => { const value = clone(sourceInput); delete value.event_name; compileSourceIdentityReceipt(value); }, /keys must be exactly/);
mutation("source/extra claim", () => compileSourceIdentityReceipt({ ...sourceInput, deployment_status: "production" }), /keys must be exactly/);
mutation("source/tampered toolchain", () => verifySourceIdentityReceipt(reseal({ ...source, toolchain: { ...source.toolchain, node: "v99" } })), /toolchain digest/);

mutation("registry/duplicate id", () => compileRegistrySelectionReceipt({ source_identity: source, rows: [...rows, { ...rows[0], command: ["node", "different.mjs"] }], recorded_at: AT }), /unique/);
mutation("registry/duplicate suite", () => compileRegistrySelectionReceipt({ source_identity: source, rows: [...rows, { ...rows[0], id: "different-id" }], recorded_at: AT }), /duplicate suite/);
mutation("registry/zero timeout", () => compileRegistrySelectionReceipt({ source_identity: source, rows: rows.map((row, index) => index ? row : { ...row, timeout_seconds: 0 }), recorded_at: AT }), /integer/);
mutation("registry/bad disposition", () => compileRegistrySelectionReceipt({ source_identity: source, rows: rows.map((row, index) => index ? row : { ...row, disposition: "SILENT_SKIP" }), recorded_at: AT }), /invalid disposition/);
mutation("registry/shell string", () => compileRegistrySelectionReceipt({ source_identity: source, rows: rows.map((row, index) => index ? row : { ...row, command: ["node test.mjs", "x"] }), recorded_at: AT }), /shell command/);
mutation("registry/no portable selection", () => compileRegistrySelectionReceipt({ source_identity: source, rows: rows.map((row) => ({ ...row, disposition: "INSTALLED_HOST_EXCLUDED" })), recorded_at: AT }), /selects no portable/);
mutation("registry/tampered selection", () => verifyRegistrySelectionReceipt(reseal({ ...registry, selected_test_ids: ["public-bootstrap"] }), source), /selection|digest/);

const lifecycle = (overrides = {}) => compileTestLifecycleReceipt({
  job_id: "portable_gate", source_identity: source, registry_selection: registry,
  selection_scope: "PORTABLE_ALL", selected_test_ids: registry.selected_test_ids,
  starts, terminals, recorded_at: DONE, ...overrides,
});
check(lifecycle({ starts: starts.slice(0, 1) }).status === "FAIL", "missing start did not fail lifecycle"); mutationsCaught += 1;
check(lifecycle({ terminals: terminals.slice(0, 1) }).status === "FAIL", "missing terminal did not fail lifecycle"); mutationsCaught += 1;
check(lifecycle({ terminals: [terminal("public-bootstrap", "FAIL"), terminals[1]] }).status === "FAIL", "failed test did not fail lifecycle"); mutationsCaught += 1;
check(lifecycle({ terminals: [terminal("public-bootstrap", "BLOCKED"), terminals[1]] }).status === "FAIL", "blocked test did not fail lifecycle"); mutationsCaught += 1;
const timeoutTerminal = { ...terminal("public-bootstrap", "TIMEOUT"), exit_code: null };
check(lifecycle({ terminals: [timeoutTerminal, terminals[1]] }).status === "FAIL", "timeout did not fail lifecycle"); mutationsCaught += 1;
mutation("lifecycle/duplicate start", () => lifecycle({ starts: [...starts, starts[0]] }), /duplicate/);
mutation("lifecycle/missing timeout", () => lifecycle({ terminals: [{ ...terminals[0], timeout_ms: 0 }, terminals[1]] }), /integer/);
mutation("lifecycle/missing log", () => { const value = clone(terminals); delete value[0].stdout_log; lifecycle({ terminals: value }); }, /keys must be exactly/);
mutation("lifecycle/log traversal", () => lifecycle({ terminals: [{ ...terminals[0], stdout_log: { ...terminals[0].stdout_log, path: "../escape.log" } }, terminals[1]] }), /traversal-free/);
mutation("lifecycle/portable omission", () => lifecycle({ selected_test_ids: ["public-bootstrap"], starts: [starts[0]], terminals: [terminals[0]] }), /omits or adds/);
mutation("lifecycle/forged status", () => verifyTestLifecycleReceipt(reseal({ ...portable, status: "FAIL", errors: ["forged"] }), source, registry), /semantics/);

for (const jobId of CI_PREREQUISITE_JOB_IDS) {
  mutation(`final/missing ${jobId}`, () => { const value = clone(prerequisites); delete value[jobId]; compileReleaseCandidateAttestation(value); }, /keys must be exactly/);
}
mutation("final/package fail", () => compileReleaseCandidateAttestation({ ...prerequisites, package_a: { ...packageA, status: "FAIL" } }), /not PASS/);
mutation("final/package blocked", () => compileReleaseCandidateAttestation({ ...prerequisites, package_a: { ...packageA, status: "BLOCKED" } }), /not PASS/);
mutation("final/wrong source binding", () => compileReleaseCandidateAttestation({ ...prerequisites, package_a: { ...packageA, source_binding: { ...binding, github_sha: M } } }), /different source/);
mutation("final/dirty package", () => compileReleaseCandidateAttestation({ ...prerequisites, package_a: { ...packageA, clean_checkout: false } }), /clean checkout/);
mutation("final/toolchain mismatch", () => compileReleaseCandidateAttestation({ ...prerequisites, package_a: { ...packageA, toolchain_sha256: H("wrong") } }), /toolchain/);
mutation("final/runtime closure mismatch", () => compileReleaseCandidateAttestation({ ...prerequisites, package_b: { ...packageB, runtime_closure_sha256: H("wrong") } }), /join exactly/);
mutation("final/candidate version mismatch", () => compileReleaseCandidateAttestation({ ...prerequisites, package_b: { ...packageB, candidate_version: "9.9.8" } }), /candidate version/);
mutation("final/installed package", () => compileReleaseCandidateAttestation({ ...prerequisites, package_b: { ...packageB, deployment_status: "installed_candidate" } }), /pre-install/);
mutation("final/build timestamp policy mismatch", () => compileReleaseCandidateAttestation({ ...prerequisites, package_b: { ...packageB, build_timestamp_policy: { ...buildTimestampPolicy, source_date_epoch: buildTimestampPolicy.source_date_epoch + 1 } } }), /timestamp policy/);
mutation("final/repro false", () => compileReleaseCandidateAttestation({ ...prerequisites, package_reproducibility: { ...reproducibility, archives_byte_identical: false } }), /not exact/);
mutation("final/repro wrong sha", () => compileReleaseCandidateAttestation({ ...prerequisites, package_reproducibility: { ...reproducibility, archive_b_sha256: H("wrong") } }), /join exactly/);
mutation("final/archive source checkout", () => compileReleaseCandidateAttestation({ ...prerequisites, archive_capability: { ...archive, source_checkout_used: true } }), /incomplete/);
mutation("final/oracle fail", () => compileReleaseCandidateAttestation({ ...prerequisites, archive_capability: { ...archive, independent_oracle_status: "FAIL" } }), /incomplete/);
mutation("final/no measured suites", () => compileReleaseCandidateAttestation({ ...prerequisites, mutation_measurement: { ...mutationReceipt, measured_mutation_suites: 0, unmeasured_mutation_suites: 40, measurement_coverage: 0 } }), /schema-valid|coverage/);
mutation("final/hidden suite gap", () => compileReleaseCandidateAttestation({ ...prerequisites, mutation_measurement: { ...mutationReceipt, unmeasured_mutation_suites: 9 } }), /hides unmeasured/);
mutation("final/false coverage", () => compileReleaseCandidateAttestation({ ...prerequisites, mutation_measurement: { ...mutationReceipt, measurement_coverage: 1 } }), /hides unmeasured/);
mutation("final/measured count mismatch", () => compileReleaseCandidateAttestation({ ...prerequisites, mutation_measurement: { ...mutationReceipt, measured_mutations_caught: 119 } }), /inconsistent/);
mutation("final/mutation survivor", () => compileReleaseCandidateAttestation({ ...prerequisites, mutation_measurement: { ...mutationReceipt, measured_mutations_caught: 119, measured_mutations_survived: 1 } }), /survivor/);
mutation("final/P0 not fully measured", () => compileReleaseCandidateAttestation({ ...prerequisites, mutation_measurement: { ...mutationReceipt, p0_fully_measured: false } }), /schema-valid|P0/);
mutation("final/P0 fail", () => compileReleaseCandidateAttestation({ ...prerequisites, mutation_measurement: { ...mutationReceipt, p0_status: "FAIL" } }), /schema-valid|P0/);
mutation("final/merge equals head", () => compileReleaseCandidateAttestation({ ...prerequisites, synthetic_merge: { ...merge, merge_commit: C } }), /separately bound/);
mutation("final/candidate not parent", () => compileReleaseCandidateAttestation({ ...prerequisites, synthetic_merge: { ...merge, candidate_is_parent: false } }), /separately bound/);
mutation("final/failed portable lifecycle", () => compileReleaseCandidateAttestation({ ...prerequisites, portable_gate: lifecycle({ terminals: [terminal("public-bootstrap", "FAIL"), terminals[1]] }) }), /not PASS/);
mutation("final/tampered attestation", () => verifyReleaseCandidateAttestation({ ...attestation, package: { ...attestation.package, archive_sha256: H("wrong") } }), /does not match/);
mutation("final/forged promotion eligibility", () => verifyReleaseCandidateAttestation({ ...attestation, production_promotion_eligible: true }), /schema-valid/);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "external-ci-evidence-tests-"));
try {
  const inputPath = path.join(scratch, "source-input.json");
  const outPath = path.join(scratch, "source-identity.json");
  await fs.writeFile(inputPath, JSON.stringify(sourceInput));
  const cli = await exec(process.execPath, [path.join(ROOT, "scripts", "compile_external_ci_evidence.mjs"), "source-identity", "--input", inputPath, "--out", outPath]);
  const cliReceipt = JSON.parse(await fs.readFile(outPath, "utf8"));
  check(JSON.parse(cli.stdout).status === "PASS" && cliReceipt.evidence_sha256 === source.evidence_sha256, "source identity CLI disagrees with module compiler");
  const capturedRegistryOut = path.join(scratch, "captured-registry-selection.json");
  await exec(process.execPath, [
    path.join(ROOT, "scripts", "compile_external_ci_evidence.mjs"), "capture-registry-selection",
    "--source-identity", outPath, "--registry", path.join(ROOT, "assets", "development-test-registry.json"),
    "--scripts-root", path.join(ROOT, "scripts"), "--out", capturedRegistryOut,
  ]);
  const capturedRegistry = JSON.parse(await fs.readFile(capturedRegistryOut, "utf8"));
  check(
    capturedRegistry.counts.registry === capturedRegistry.rows.length &&
      capturedRegistry.counts.portable + capturedRegistry.counts.installed_host_excluded === capturedRegistry.counts.registry &&
      capturedRegistry.selected_test_ids_sha256 === canonicalSha256(capturedRegistry.selected_test_ids),
    "capture-registry-selection did not compile the actual development registry without omission",
  );

  const captureRepo = path.join(scratch, "capture-repo");
  await fs.mkdir(captureRepo);
  await fs.writeFile(path.join(captureRepo, "member.txt"), "sealed\n");
  await exec("git", ["init", "-q"], { cwd: captureRepo });
  await exec("git", ["add", "member.txt"], { cwd: captureRepo });
  await exec("git", ["-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid", "commit", "-q", "-m", "fixture"], { cwd: captureRepo });
  const { stdout: capturedHeadOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: captureRepo });
  const capturedHead = capturedHeadOut.trim();
  const captureOut = path.join(scratch, "captured-source-identity.json");
  const captureArgs = [
    path.join(ROOT, "scripts", "compile_external_ci_evidence.mjs"), "capture-source-identity",
    "--repo", captureRepo, "--python", process.execPath, "--soffice", process.execPath, "--out", captureOut,
  ];
  const captureEnv = {
    ...process.env, GITHUB_SHA: capturedHead, GITHUB_REPOSITORY: "test/excel-inflow", GITHUB_REF: "refs/pull/72/head",
    GITHUB_EVENT_NAME: "pull_request", GITHUB_RUN_ID: "999", GITHUB_RUN_ATTEMPT: "2",
    RUNNER_OS: "Linux", RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20260821.1",
  };
  await exec(process.execPath, captureArgs, { env: captureEnv });
  const capturedSource = JSON.parse(await fs.readFile(captureOut, "utf8"));
  check(capturedSource.github_sha === capturedHead && capturedSource.source_commit === capturedHead && capturedSource.worktree.clean === true, "capture-source-identity did not observe exact clean HEAD");
  await fs.writeFile(path.join(captureRepo, "member.txt"), "dirty\n");
  await assert.rejects(exec(process.execPath, captureArgs, { env: captureEnv }), /worktree must be clean/);
  checks += 1;
  mutationsCaught += 1;
  await fs.writeFile(path.join(captureRepo, "member.txt"), "sealed\n");
  await assert.rejects(exec(process.execPath, captureArgs, { env: { ...captureEnv, GITHUB_SHA: M } }), /exactly equal/);
  checks += 1;
  mutationsCaught += 1;
  const registryInputPath = path.join(scratch, "registry-input.json");
  const registryOutPath = path.join(scratch, "registry-selection.json");
  await fs.writeFile(registryInputPath, JSON.stringify({ rows, recorded_at: AT }));
  await exec(process.execPath, [
    path.join(ROOT, "scripts", "compile_external_ci_evidence.mjs"), "registry-selection",
    "--source-identity", outPath, "--input", registryInputPath, "--out", registryOutPath,
  ]);
  const cliRegistry = JSON.parse(await fs.readFile(registryOutPath, "utf8"));
  check(cliRegistry.evidence_sha256 === registry.evidence_sha256, "registry selection CLI disagrees with module compiler");

  const gatePath = path.join(scratch, "gate-report.json");
  const lifecycleOutPath = path.join(scratch, "portable-gate.json");
  await fs.writeFile(gatePath, JSON.stringify({
    selection: { selected_test_ids: registry.selected_test_ids },
    results: terminals,
    completed_at: DONE,
  }));
  await exec(process.execPath, [
    path.join(ROOT, "scripts", "compile_external_ci_evidence.mjs"), "lifecycle-from-gate-report",
    "--source-identity", outPath, "--registry-selection", registryOutPath,
    "--gate-report", gatePath, "--job-id", "portable_gate", "--selection-scope", "PORTABLE_ALL",
    "--out", lifecycleOutPath,
  ]);
  const cliLifecycle = JSON.parse(await fs.readFile(lifecycleOutPath, "utf8"));
  check(cliLifecycle.evidence_sha256 === portable.evidence_sha256, "lifecycle CLI disagrees with module compiler");

  const receiptPaths = {};
  for (const [key, value] of Object.entries(prerequisites)) {
    const receiptPath = path.join(scratch, `${key}.json`);
    await fs.writeFile(receiptPath, JSON.stringify(value));
    receiptPaths[key] = receiptPath;
  }
  const finalOutPath = path.join(scratch, "release-candidate-attestation.json");
  const finalArgs = [path.join(ROOT, "scripts", "compile_external_ci_evidence.mjs"), "final-attestation"];
  for (const jobId of CI_PREREQUISITE_JOB_IDS) finalArgs.push(`--${jobId.replaceAll("_", "-")}`, receiptPaths[jobId]);
  finalArgs.push("--created-at", AT, "--out", finalOutPath);
  await exec(process.execPath, finalArgs);
  const cliAttestation = JSON.parse(await fs.readFile(finalOutPath, "utf8"));
  check(cliAttestation.attestation_sha256 === attestation.attestation_sha256, "final attestation CLI disagrees with module compiler");
  await assert.rejects(
    exec(process.execPath, [path.join(ROOT, "scripts", "compile_external_ci_evidence.mjs"), "source-identity", "--input", inputPath, "--out", outPath, "--unexpected", "yes"]),
    /Options must be exactly/,
    "CLI accepted an undeclared option",
  );
  checks += 1;
  mutationsCaught += 1;
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "PASS",
  checks,
  mutations_caught: mutationsCaught,
  prerequisite_job_count: CI_PREREQUISITE_JOB_IDS.length,
  schemas_validated: 5,
  cli_modes_exercised: ["capture-source-identity", "capture-registry-selection", "source-identity", "registry-selection", "lifecycle-from-gate-report", "final-attestation"],
}));
