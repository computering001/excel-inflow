#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalSha256,
  compareExactHeadPackageBuilds,
  compilePackageBuildReceipt,
  validateArchiveOnlyReport,
} from "./lib/exact_head_package_ci.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-exact-head-ci-tests-"));
let checks = 0;
const mutations = [];
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

async function fixture(label, variant = {}) {
  const root = path.join(scratch, `package-${label}-${variant.name ?? "clean"}`);
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "release-manifest.json"), `${JSON.stringify({
    skillVersion: "9.9.9",
    packageMode: "development",
    deploymentStatus: "not_installed",
    generatedAt: new Date(Number(variant.epoch ?? "1787270400") * 1000).toISOString(),
    identity: {
      source: { commit_sha: variant.commit ?? "1".repeat(40), tree_sha: variant.tree ?? "2".repeat(40) },
      package: { mode: "development", runtime_code_closure: { sha256: "9".repeat(64) } },
      deployment: { status: "not_installed" },
    },
  })}\n`);
  await fs.writeFile(path.join(root, "scripts", "entry.mjs"), variant.entry ?? "export const value = 1;\n");
  await fs.chmod(path.join(root, "scripts", "entry.mjs"), variant.mode ?? 0o644);
  if (variant.extra) await fs.writeFile(path.join(root, variant.extra), "extra\n");
  const archive = path.join(scratch, `archive-${label}-${variant.name ?? "clean"}.tar`);
  const attestation = path.join(scratch, `attestation-${label}-${variant.name ?? "clean"}.json`);
  const log = path.join(scratch, `build-${label}-${variant.name ?? "clean"}.log`);
  await fs.writeFile(archive, variant.archive ?? "identical archive bytes");
  await fs.writeFile(attestation, "{\"status\":\"PASS\"}\n");
  await fs.writeFile(log, "build exit=0\n");
  return compilePackageBuildReceipt({
    label,
    packageRoot: root,
    archivePath: archive,
    attestationPath: attestation,
    buildLogPath: log,
    sourceCommit: variant.commit ?? "1".repeat(40),
    sourceTree: variant.tree ?? "2".repeat(40),
    sourceDateEpoch: variant.epoch ?? "1787270400",
    checkoutInstanceId: variant.checkout ?? `checkout-${label}-${variant.name ?? "clean"}`,
    toolchain: variant.toolchain ?? { node: "v24.0.0", python: "3.13.0", soffice: "26.2.0" },
    buildInputs: { smoke_case: { path: "/external/smoke-case.json", size: 17, sha256: "8".repeat(64) } },
    buildExitCode: 0,
  });
}

function mutate(receipt, mutation) {
  const changed = structuredClone(receipt);
  mutation(changed);
  const body = Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "receipt_sha256"));
  changed.receipt_sha256 = canonicalSha256(body);
  return changed;
}

function caught(id, a, b) {
  const report = compareExactHeadPackageBuilds(a, b);
  check(report.status === "FAIL" && report.findings.length > 0, `${id} escaped the comparator`);
  mutations.push(id);
}

try {
  const a = await fixture("A");
  const b = await fixture("B");
  const clean = compareExactHeadPackageBuilds(a, b);
  check(clean.status === "PASS", `identical independent builds did not pass: ${JSON.stringify(clean.findings)}`);
  check(clean.inventory_byte_equal === true && clean.archive_byte_equal === true, "clean comparison omitted byte-equality claims");
  check(clean.file_differences.length === 0, "clean comparison invented a package difference");
  check(clean.file_comparison.length >= 3 && clean.file_comparison.every((row) => row.equal === true && row.path && row.a.type && Number.isInteger(row.a.mode) && Number.isInteger(row.a.size)), "clean comparison omitted full path/type/mode/size/SHA rows");

  caught("same-checkout", a, mutate(b, (x) => { x.checkout_instance_id = a.checkout_instance_id; }));
  caught("commit-drift", a, mutate(b, (x) => { x.source.commit = "3".repeat(40); }));
  caught("tree-drift", a, mutate(b, (x) => { x.source.tree = "4".repeat(40); }));
  caught("epoch-drift", a, mutate(b, (x) => { x.source_date_epoch = "1787270401"; }));
  caught("candidate-version-drift", a, mutate(b, (x) => { x.package_identity.candidate_version = "9.9.8"; }));
  caught("timestamp-policy-drift", a, mutate(b, (x) => { x.package_identity.build_timestamp_policy.source_date_epoch += 1; }));
  caught("toolchain-drift", a, mutate(b, (x) => { x.toolchain.node = "v25.0.0"; }));
  caught("smoke-case-drift", a, mutate(b, (x) => { x.build_inputs.smoke_case.sha256 = "7".repeat(64); }));
  caught("dirty-origin", a, mutate(b, (x) => { x.source.worktree_clean = false; }));
  caught("overlay-origin", a, mutate(b, (x) => { x.build_origin = "overlay_copy"; }));
  caught("content-drift", a, await fixture("B", { name: "content", entry: "export const value = 2;\n" }));
  caught("mode-drift", a, await fixture("B", { name: "mode", mode: 0o755 }));
  caught("member-added", a, await fixture("B", { name: "extra", extra: "unexpected.txt" }));
  caught("archive-byte-drift", a, await fixture("B", { name: "archive", archive: "different archive bytes" }));
  const tampered = structuredClone(b);
  tampered.package.inventory_rows[1].size += 1;
  caught("receipt-self-hash", a, tampered);

  await assert.rejects(
    compilePackageBuildReceipt({
      label: "A", packageRoot: path.join(scratch, "missing"), sourceCommit: "1".repeat(40),
      sourceTree: "2".repeat(40), sourceDateEpoch: "1", checkoutInstanceId: "checkout-a",
      buildOrigin: "overlay_copy", sourceWorktreeClean: true,
      buildInputs: { smoke_case: { size: 1, sha256: "8".repeat(64) } }, buildExitCode: 0,
    }),
    /independent clean checkout/,
  );
  checks += 1;
  const symlinkRoot = path.join(scratch, "symlink-package");
  await fs.mkdir(symlinkRoot);
  await fs.symlink(path.join(scratch, "build-A-clean.log"), path.join(symlinkRoot, "escaped"));
  await assert.rejects(
    fixture("A", { name: "symlink-control" }).then(async (receipt) => {
      void receipt;
      const archive = path.join(scratch, "archive-A-clean.tar");
      const attestation = path.join(scratch, "attestation-A-clean.json");
      const log = path.join(scratch, "build-A-clean.log");
      return compilePackageBuildReceipt({ label: "A", packageRoot: symlinkRoot, archivePath: archive, attestationPath: attestation, buildLogPath: log, sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40), sourceDateEpoch: "1", checkoutInstanceId: "checkout-symlink", toolchain: {}, buildInputs: { smoke_case: { size: 1, sha256: "8".repeat(64) } }, buildExitCode: 0 });
    }),
    /refuses symlink/,
  );
  checks += 1;

  const comparisonA = path.join(scratch, "a.json");
  const comparisonB = path.join(scratch, "b.json");
  const comparisonOut = path.join(scratch, "comparison.json");
  await fs.writeFile(comparisonA, JSON.stringify(a));
  await fs.writeFile(comparisonB, JSON.stringify(b));
  await exec(process.execPath, [path.join(ROOT, "scripts", "compare_exact_head_package_builds.mjs"), "--a", comparisonA, "--b", comparisonB, "--out", comparisonOut]);
  check(JSON.parse(await fs.readFile(comparisonOut, "utf8")).status === "PASS", "comparator CLI did not consume independent build receipts");
  const rejected = await exec(process.execPath, [path.join(ROOT, "scripts", "run_exact_head_package_build_ci.mjs"), "--overlay", "x"], { cwd: ROOT }).then(() => null, (error) => error);
  check(rejected?.code !== 0 && String(rejected?.stderr).includes("Overlay/copy inputs are prohibited"), "single-build CI accepted an overlay/copy argument");

  const lane = { status: "PASS", log_sha256: "a".repeat(64), report_sha256: "b".repeat(64) };
  const archiveBody = {
    schema_version: "archive-only-capability-proof/1.0",
    archive_sha256: "c".repeat(64),
    unpacked_package: { source_checkout_present: false },
    lanes: { public_bootstrap: lane, installed_capability: lane, independent_oracle: lane },
    installed_capability_receipt: { sha256: "d".repeat(64) },
    status: "PASS",
  };
  const archiveReport = { ...archiveBody, report_sha256: canonicalSha256(archiveBody) };
  check(validateArchiveOnlyReport(archiveReport).length === 0, "clean archive-only custody report was rejected");
  const archiveMutations = {
    "source-checkout-present": (x) => { x.unpacked_package.source_checkout_present = true; },
    "public-bootstrap-fail": (x) => { x.lanes.public_bootstrap.status = "FAIL"; },
    "installed-capability-log-missing": (x) => { x.lanes.installed_capability.log_sha256 = null; },
    "independent-oracle-report-missing": (x) => { x.lanes.independent_oracle.report_sha256 = null; },
    "capability-receipt-missing": (x) => { x.installed_capability_receipt.sha256 = null; },
    "archive-hash-invalid": (x) => { x.archive_sha256 = "wrong"; },
  };
  for (const [id, apply] of Object.entries(archiveMutations)) {
    const changed = structuredClone(archiveReport);
    apply(changed);
    changed.report_sha256 = canonicalSha256(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "report_sha256")));
    check(validateArchiveOnlyReport(changed).length > 0, `${id} escaped archive-only report validation`);
    mutations.push(id);
  }
  const staleSelf = structuredClone(archiveReport);
  staleSelf.status = "FAIL";
  check(validateArchiveOnlyReport(staleSelf).includes("self_hash"), "archive-only self-hash mutation escaped");
  mutations.push("archive-report-self-hash");

  check(mutations.length === 22 && new Set(mutations).size === mutations.length, `mutation table drifted: ${JSON.stringify(mutations)}`);
  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, mutations_declared: mutations.length, mutations_caught: mutations.length, mutation_ids: mutations })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
