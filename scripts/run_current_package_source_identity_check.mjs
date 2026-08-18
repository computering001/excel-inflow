#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const out = option("out");
if (!out) throw new Error("Usage: run_current_package_source_identity_check.mjs --out <report.json> [--python <python>] [--soffice <soffice>]");
const [{ stdout: commit }, { stdout: tree }, { stdout: status }] = await Promise.all([
  exec("git", ["rev-parse", "HEAD"], { cwd: root }),
  exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }),
  exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
]);
if (status.trim()) throw new Error("Package/source identity check requires a clean worktree.");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-current-package-"));
const packageRoot = path.join(temp, "package");
try {
  const smokeCase = path.join(temp, "smoke-case.json");
  await exec(process.execPath, [
    path.join(root, "scripts", "run_evidence_run_tests.mjs"),
    path.join(root, "test-fixtures", "cases"),
    "--emit-compiled-case", smokeCase,
    "--production",
  ], {
    cwd: root,
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  await exec(process.execPath, [
    path.join(root, "scripts", "compile_skill_release.mjs"),
    "--skill", root,
    "--out", packageRoot,
    "--development",
    "--smoke-case", smokeCase,
  ], {
    cwd: root,
    timeout: 900000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...(option("python") ? { DEBT_OVERLAY_PYTHON: option("python"), EXCEL_INFLOW_TEST_PYTHON: option("python") } : {}),
      ...(option("soffice") ? { SOFFICE_BIN: option("soffice") } : {}),
    },
  });
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "release-manifest.json"), "utf8"));
  const errors = [];
  if (manifest.identity?.source?.commit_sha !== commit.trim()) errors.push("Package source commit does not equal checkout HEAD.");
  if (manifest.identity?.source?.tree_sha !== tree.trim()) errors.push("Package source tree does not equal checkout HEAD tree.");
  if (manifest.packageMode !== "development" || manifest.deploymentStatus !== "not_installed") errors.push("Package is not an uninstalled development package.");
  if (!manifest.identity?.package?.runtime_code_closure?.sha256) errors.push("Package has no runtime closure identity.");
  const report = {
    schema_version: "current-package-source-identity/1.0",
    source_commit: commit.trim(),
    source_tree: tree.trim(),
    package_mode: manifest.packageMode,
    deployment_status: manifest.deploymentStatus,
    skill_version: manifest.skillVersion,
    runtime_code_closure_sha256: manifest.identity?.package?.runtime_code_closure?.sha256 ?? null,
    errors,
    status: errors.length === 0 ? "PASS" : "FAIL",
  };
  await fs.writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
