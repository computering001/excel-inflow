#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalSha256, compileSourceIdentityReceipt } from "./lib/external_ci_evidence.mjs";
import { compareExactHeadPackageBuilds } from "./lib/exact_head_package_ci.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "exact_head_ci_job_receipt_tests", importMetaUrl: import.meta.url });
const { exec } = run.runCli();
const ROOT = run.ROOT;
const CLI = path.join(ROOT, "scripts", "compile_exact_head_ci_job_receipt.mjs");
const SHA = "a".repeat(64);
const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "exact-head-ci-receipt-"));
let mutations = 0;

async function write(name, value) {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}
// Awaited CLI attempt outside any check body (check bodies are synchronous).
// Returns { ok, error }: `ok` false means the CLI rejected the invocation.
async function attempt(mode, options) {
  const argv = [CLI, mode];
  for (const [key, value] of Object.entries(options)) argv.push(`--${key}`, value);
  try {
    await exec(process.execPath, argv, { cwd: ROOT });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
// A valid receipt must compile; a compile failure fails the check (and the suite).
function accepted(desc, outcome) {
  run.check(desc, () => {
    if (!outcome.ok) throw outcome.error;
    return true;
  });
}
// A mutated receipt must be refused; a survivor is an unexpected crash-grade failure
// and stays out of the counted checks, matching the pre-harness counting.
async function refused(mode, options, label) {
  const outcome = await attempt(mode, options);
  if (outcome.ok) throw new Error(`${mode} mutation survived: ${label}`);
  mutations += 1;
}
function seal(value, field) { return { ...value, [field]: canonicalSha256(value) }; }

const toolchain = { node: process.version, python: "Python 3.12.9", soffice: "LibreOffice 24.2" };
const source = compileSourceIdentityReceipt({
  github_sha: COMMIT, source_commit: COMMIT, source_tree: TREE, repository: "owner/repo", ref: "refs/heads/feature",
  event_name: "pull_request", run: { id: "7", attempt: 1 }, runner: { os: "Linux", arch: "X64", image: "ubuntu" },
  toolchain, worktree: { clean: true, status_sha256: SHA }, recorded_at: "2026-08-21T00:00:00.000Z",
});
const sourcePath = await write("source.json", source);
const logA = path.join(root, "a.log");
const logB = path.join(root, "b.log");
await fs.writeFile(logA, "A build\n");
await fs.writeFile(logB, "B build\n");
const logHash = (await import("node:crypto")).createHash("sha256").update("A build\n").digest("hex");
const logHashB = (await import("node:crypto")).createHash("sha256").update("B build\n").digest("hex");
function rawPackage(label, log, logSha, checkout) {
  const body = {
    schema_version: "exact-head-package-build-receipt/1.0", label,
    source: { commit: COMMIT, tree: TREE, worktree_clean: true }, build_origin: "independent_clean_checkout",
    checkout_instance_id: checkout, source_date_epoch: "1700000000", toolchain, build_exit_code: 0,
    package_identity: {
      candidate_version: "9.9.9", package_mode: "development", deployment_status: "not_installed",
      build_timestamp_policy: { kind: "SOURCE_DATE_EPOCH", source_date_epoch: 1700000000, generated_at: new Date(1700000000 * 1000).toISOString() },
    },
    build_inputs: { smoke_case: { path: "/tmp/smoke.json", size: 10, sha256: "f".repeat(64) } },
    package: { root: `/tmp/${label}`, runtime_code_closure_sha256: "3".repeat(64), release_manifest_sha256: "4".repeat(64), inventory_sha256: "5".repeat(64), inventory_rows: [{ path: "x", type: "file", mode: 420, size: 1, sha256: "6".repeat(64) }] },
    archive: { path: `/tmp/${label}.tar`, size: 2048, sha256: "7".repeat(64) },
    attestation: { path: `/tmp/${label}.json`, size: 100, sha256: "8".repeat(64) },
    build_log: { path: log, size: 8, sha256: logSha },
  };
  return seal(body, "receipt_sha256");
}
const rawA = rawPackage("A", logA, logHash, "checkout-A");
const rawB = rawPackage("B", logB, logHashB, "checkout-B");
const rawAPath = await write("raw-a.json", rawA);
const rawBPath = await write("raw-b.json", rawB);
const outA = path.join(root, "package-a.json");
const outB = path.join(root, "package-b.json");
accepted("package A job receipt compiles", await attempt("package", { "source-identity": sourcePath, raw: rawAPath, "job-id": "package_a", out: outA }));
accepted("package B job receipt compiles", await attempt("package", { "source-identity": sourcePath, raw: rawBPath, "job-id": "package_b", out: outB }));

const badToolchain = seal({ ...rawA, toolchain: { ...toolchain, python: "Python 0" }, receipt_sha256: undefined }, "receipt_sha256");
delete badToolchain.receipt_sha256;
const badToolchainSealed = seal(badToolchain, "receipt_sha256");
await refused("package", { "source-identity": sourcePath, raw: await write("bad-toolchain.json", badToolchainSealed), "job-id": "package_a", out: path.join(root, "bad.json") }, "tampered toolchain");

const repro = compareExactHeadPackageBuilds(rawA, rawB);
run.check("A/B package builds reproduce byte-identically", () => {
  assert.equal(repro.status, "PASS");
  return true;
});
const reproPath = await write("repro.json", repro);
accepted("reproducibility job receipt compiles", await attempt("reproducibility", { "source-identity": sourcePath, raw: reproPath, "package-a": rawAPath, "package-b": rawBPath, out: path.join(root, "repro-receipt.json") }));
await refused("reproducibility", { "source-identity": sourcePath, raw: reproPath, "package-a": rawAPath, "package-b": rawAPath, out: path.join(root, "bad-repro.json") }, "non-reproducing pair");

const archiveBody = {
  schema_version: "archive-only-capability-proof/1.0", archive: "/tmp/a.tar", archive_sha256: "7".repeat(64), attestation: "/tmp/a.json", attestation_sha256: "8".repeat(64),
  unpacked_package: { root: "/tmp/unpacked", source_checkout_present: false, member_count: 2, inventory_sha256: "9".repeat(64) },
  lanes: {
    public_bootstrap: { status: "PASS", log_sha256: SHA, report_sha256: "a".repeat(64) },
    installed_capability: { status: "PASS", log_sha256: SHA, report_sha256: "b".repeat(64) },
    independent_oracle: { status: "PASS", log_sha256: SHA, report_sha256: "c".repeat(64) },
  },
  installed_capability_receipt: { path: "/tmp/receipt.json", sha256: "d".repeat(64) }, source_checkout_used: false,
  production_promotion_eligible: false, findings: [], status: "PASS",
};
const archive = seal(archiveBody, "report_sha256");
const projectedA = JSON.parse(await fs.readFile(outA, "utf8"));
accepted("archive-capability job receipt compiles", await attempt("archive-capability", { "source-identity": sourcePath, raw: await write("archive.json", archive), "package-a": outA, out: path.join(root, "archive-receipt.json") }));
await refused("archive-capability", { "source-identity": sourcePath, raw: await write("archive-source.json", seal({ ...archiveBody, source_checkout_used: true }, "report_sha256")), "package-a": outA, out: path.join(root, "bad-archive.json") }, "source-checkout leakage");

const mutation = {
  schema_version: "excel-inflow-mutation-adequacy/1.0", source_identity: { commit: COMMIT, worktree_dirty: false },
  zero_survivor_gate: { status: "PASS", members_without_a_reported_count: [], unproven_members: [] },
  score: { measured_mutations: 12, killed: 12, survived: 0 }, survivors: [],
  corpus: { registry_mutation_suites: 5, suites_reporting_a_mutation_count: 3, measurement_coverage: 0.6 },
  measurement_gaps: [{ test_id: "gap-a" }, { test_id: "gap-b" }],
};
const mutationPath = await write("mutation.json", mutation);
accepted("mutation-measurement job receipt compiles", await attempt("mutation-measurement", { "source-identity": sourcePath, raw: mutationPath, out: path.join(root, "mutation-receipt.json") }));
await refused("mutation-measurement", { "source-identity": sourcePath, raw: await write("survivor.json", { ...mutation, score: { measured_mutations: 12, killed: 11, survived: 1 }, survivors: [{}] }), out: path.join(root, "bad-mutation.json") }, "mutation survivor admitted");

const merge = { schema_version: "ci-merge-compatibility-identity/1.0", expected_role: "merge_test", candidate_source_commit: COMMIT, checked_out_commit: "3".repeat(40), checked_out_tree: "4".repeat(40), parent_commits: ["0".repeat(40), COMMIT], classification: "COMPATIBILITY_EVIDENCE_NOT_PACKAGE_SOURCE", errors: [], status: "PASS" };
accepted("synthetic-merge job receipt compiles", await attempt("synthetic-merge", { "source-identity": sourcePath, raw: await write("merge.json", merge), out: path.join(root, "merge-receipt.json") }));
await refused("synthetic-merge", { "source-identity": sourcePath, raw: await write("bad-merge.json", { ...merge, parent_commits: ["0".repeat(40)] }), out: path.join(root, "bad-merge-receipt.json") }, "rewritten merge parents");

run.check("projected package receipt preserves the archive sha", () => {
  assert.equal(projectedA.archive_sha256, rawA.archive.sha256);
  return true;
});
await fs.rm(root, { recursive: true, force: true });
run.finish({ mutations_caught: mutations });
