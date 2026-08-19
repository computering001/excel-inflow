#!/usr/bin/env node
/**
 * P8.1 — the A/B reproducibility proof.
 *
 * Builds the release package TWICE, from two independent clean checkouts of the
 * same commit, and compares the two deterministic archives byte for byte.
 *
 * Why two checkouts rather than two builds in one tree: a second build in the
 * same directory shares the absolute paths, the git index, the timestamps and
 * any residue of the first, so it can only prove the build is idempotent — not
 * that it is reproducible. Two `git worktree add --detach` copies at the same
 * commit share nothing but the commit, which is the whole claim.
 *
 * The comparison has no exclusion list. If the archives differ, the receipt
 * carries the SMALLEST DIFFERENCE — which member, which byte offset, which two
 * byte values, and for a JSON member which JSON path — and the proof FAILS.
 * Excluding the member that differs is refused by the comparison API itself.
 *
 * Usage:
 *   run_package_ab_proof.mjs --out <receipt.json>
 *                            [--commit <sha, default HEAD>]
 *                            [--work <dir>] [--keep]
 *                            [--python <interpreter>] [--soffice <soffice>]
 *                            [--smoke-case <case.json>]
 *                            [--overlay <dir>]
 *
 *   --overlay  A directory of files copied over BOTH checkouts, identically,
 *              before either build runs. It exists for pending source changes
 *              that are not yet committed — most importantly deployment-profile
 *              entries. The overlay's own content digest is recorded in the
 *              receipt, so a proof is never silently about a tree other than
 *              the named commit.
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { identitySha256 } from "./lib/identity_vocabulary.mjs";
import { archiveDifference, packageAbProofReceipt, validatePackageInputBindings } from "./lib/package_ab_comparison.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const out = option("out");
if (!out) {
  console.error(
    "Usage: run_package_ab_proof.mjs --out <receipt.json> [--commit <sha>] [--work <dir>] [--keep] [--python <interpreter>] [--soffice <soffice>] [--smoke-case <case.json>] [--overlay <dir>]",
  );
  process.exit(2);
}

const requestedCommit = option("commit");
const keep = option("keep") === true;
const overlayDir = option("overlay");
const pythonOption = option("python");
const sofficeOption = option("soffice");

const { stdout: resolved } = await exec("git", ["rev-parse", requestedCommit ?? "HEAD"], { cwd: root });
const commit = resolved.trim();

const work = option("work") ?? (await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-ab-")));
await fs.mkdir(work, { recursive: true });

async function walk(dir) {
  const found = [];
  async function step(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await step(child);
      else if (entry.isFile()) found.push(child);
    }
  }
  await step(dir);
  return found.sort();
}

async function applyOverlay(target) {
  if (!overlayDir) return null;
  const files = await walk(overlayDir);
  const applied = {};
  for (const file of files) {
    const relative = path.relative(overlayDir, file);
    const destination = path.join(target, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const bytes = await fs.readFile(file);
    await fs.writeFile(destination, bytes);
    applied[relative.split(path.sep).join("/")] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  return applied;
}

const buildEnv = {
  ...process.env,
  ...(pythonOption
    ? {
      PYTHON_BINARY: pythonOption,
      DEBT_OVERLAY_PYTHON: pythonOption,
      EXCEL_INFLOW_TEST_PYTHON: pythonOption,
    }
    : {}),
  ...(sofficeOption ? { SOFFICE_BIN: sofficeOption } : {}),
};
// Both builds see EXACTLY the same environment. Any deliberate override is
// applied to both or to neither, so an environment difference can never be
// mistaken for a source difference.
delete buildEnv.EXCEL_INFLOW_BUILD_TIMESTAMP;
delete buildEnv.SOURCE_DATE_EPOCH;
delete buildEnv.EXCEL_INFLOW_SOURCE_COMMIT;
delete buildEnv.EXCEL_INFLOW_SOURCE_TREE;

const worktrees = [];

async function checkout(label) {
  const dir = path.join(work, `checkout-${label}`);
  await exec("git", ["worktree", "add", "--detach", dir, commit], { cwd: root });
  worktrees.push(dir);
  const { stdout: status } = await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: dir });
  if (status.trim() !== "") {
    throw new Error(`Checkout ${label} is not clean immediately after creation:\n${status}`);
  }
  const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
  const { stdout: tree } = await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir });
  if (head.trim() !== commit) throw new Error(`Checkout ${label} is at ${head.trim()}, not ${commit}.`);
  const overlay = await applyOverlay(dir);
  return { label, dir, source_commit: head.trim(), source_tree: tree.trim(), overlay };
}

async function build(checkoutRecord, smokeCase) {
  const outputDir = path.join(work, `package-${checkoutRecord.label}`);
  const archivePath = path.join(work, `package-${checkoutRecord.label}.tar`);
  const attestationPath = path.join(work, `package-${checkoutRecord.label}.attestation.json`);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });
  await fs.rm(attestationPath, { force: true });
  const started = Date.now();
  const run = await exec(
    process.execPath,
    [
      path.join(checkoutRecord.dir, "scripts", "compile_skill_release.mjs"),
      "--skill", checkoutRecord.dir,
      "--out", outputDir,
      "--development",
      "--smoke-case", smokeCase,
      "--archive-out", archivePath,
      "--attestation-out", attestationPath,
    ],
    { cwd: checkoutRecord.dir, env: buildEnv, timeout: 3600000, maxBuffer: 256 * 1024 * 1024 },
  );
  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "release-manifest.json"), "utf8"));
  const attestation = JSON.parse(await fs.readFile(attestationPath, "utf8"));
  const archive = await fs.readFile(archivePath);
  return {
    label: checkoutRecord.label,
    worktree: `(temporary checkout ${checkoutRecord.label})`,
    source_commit: checkoutRecord.source_commit,
    source_tree: checkoutRecord.source_tree,
    seconds: Math.round((Date.now() - started) / 1000),
    stderr_receipt: `${run.stderr ?? ""}`.trim().split("\n").at(-1) ?? null,
    manifest,
    manifest_path: path.join(outputDir, "release-manifest.json"),
    archive,
    archive_path: archivePath,
    archive_sha256: crypto.createHash("sha256").update(archive).digest("hex"),
    archive_bytes: archive.length,
    complete_package_inventory_sha256: attestation.package?.complete_package_inventory?.sha256 ?? null,
    attestation_sha256: attestation.attestation_sha256 ?? null,
  };
}

let exitCode = 0;
try {
  const checkoutA = await checkout("A");
  const checkoutB = await checkout("B");
  if (identitySha256(checkoutA.overlay ?? null) !== identitySha256(checkoutB.overlay ?? null)) {
    throw new Error("The overlay did not land identically on both checkouts; the comparison would be meaningless.");
  }

  // The smoke case is a BUILD INPUT, so both builds must be handed the same
  // bytes. It is generated once, from checkout A, and reused.
  let smokeCase = option("smoke-case");
  if (!smokeCase) {
    smokeCase = path.join(work, "smoke-case.json");
    await exec(
      process.execPath,
      [
        path.join(checkoutA.dir, "scripts", "run_evidence_run_tests.mjs"),
        path.join(checkoutA.dir, "test-fixtures", "cases"),
        "--emit-compiled-case", smokeCase,
        "--production",
      ],
      { cwd: checkoutA.dir, env: buildEnv, timeout: 900000, maxBuffer: 128 * 1024 * 1024 },
    );
  }
  const smokeCaseSha256 = crypto
    .createHash("sha256")
    .update(await fs.readFile(smokeCase))
    .digest("hex");

  const buildA = await build(checkoutA, smokeCase);
  const buildB = await build(checkoutB, smokeCase);

  const difference = archiveDifference(buildA.archive, buildB.archive, { labelA: "A", labelB: "B" });
  const receipt = packageAbProofReceipt({
    commit,
    labelA: "A",
    labelB: "B",
    buildA,
    buildB,
    difference,
    bindingReceiptA: validatePackageInputBindings(buildA.manifest),
    bindingReceiptB: validatePackageInputBindings(buildB.manifest),
    overlay: overlayDir
      ? {
        source: path.resolve(overlayDir),
        files: checkoutA.overlay,
        sha256: identitySha256(checkoutA.overlay),
        note:
          "Files copied identically over BOTH clean checkouts before building. The proof is about this commit PLUS this overlay, and says so.",
      }
      : null,
  });
  receipt.smoke_case_sha256 = smokeCaseSha256;
  receipt.build_seconds = { A: buildA.seconds, B: buildB.seconds };
  receipt.package_mode = buildA.manifest.packageMode ?? null;
  receipt.input_bindings_sha256 = {
    A: buildA.manifest.inputBindings?.sha256 ?? null,
    B: buildB.manifest.inputBindings?.sha256 ?? null,
  };

  await fs.writeFile(path.resolve(out), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const summary = {
    status: receipt.status,
    verdict: receipt.verdict,
    commit: receipt.commit,
    archive_sha256_a: buildA.archive_sha256,
    archive_sha256_b: buildB.archive_sha256,
    smallest_difference: receipt.smallest_difference
      ? {
        difference_class: receipt.smallest_difference.difference_class,
        member: receipt.smallest_difference.member,
        first_differing_byte_offset_in_member:
          receipt.smallest_difference.first_differing_byte_offset_in_member ?? null,
        total_differing_members: receipt.smallest_difference.total_differing_members ?? null,
      }
      : null,
    receipt: path.resolve(out),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (receipt.status !== "PASS") exitCode = 1;
} finally {
  if (!keep) {
    for (const dir of worktrees) {
      await exec("git", ["worktree", "remove", "--force", dir], { cwd: root }).catch(() => {});
    }
    await exec("git", ["worktree", "prune"], { cwd: root }).catch(() => {});
  } else {
    console.error(JSON.stringify({ kept_worktrees: worktrees, work }));
  }
}
process.exitCode = exitCode;
