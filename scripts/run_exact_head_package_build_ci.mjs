#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { compilePackageBuildReceipt } from "./lib/exact_head_package_ci.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "exact_head_package_build_ci", importMetaUrl: import.meta.url });
const { argv, exec } = run.runCli();
const ROOT = run.ROOT;
async function observedVersion(executable, label) {
  if (!executable) return null;
  const result = await exec(path.resolve(executable), ["--version"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const value = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n")[0]?.trim();
  if (!value) throw new Error(`${label} produced no version observation.`);
  return value;
}
function parse(argv) {
  const allowed = new Set(["label", "commit", "source-date-epoch", "smoke-case", "out", "python", "soffice"]);
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith("--") ? argv[i].slice(2) : null;
    if (!allowed.has(key) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete argument ${argv[i]}. Overlay/copy inputs are prohibited.`);
    result[key] = argv[i + 1];
  }
  return result;
}
const options = parse(argv);
if (!/^[AB]$/.test(options.label ?? "") || !/^[a-f0-9]{40}$/.test(options.commit ?? "") || !/^\d+$/.test(options["source-date-epoch"] ?? "") || !options["smoke-case"] || !options.out) {
  throw new Error("Usage: run_exact_head_package_build_ci.mjs --label A|B --commit <40sha> --source-date-epoch <seconds> --smoke-case <json> --out <directory> [--python <exe>] [--soffice <exe>]");
}
const [{ stdout: head }, { stdout: tree }, { stdout: status }] = await Promise.all([
  exec("git", ["rev-parse", "HEAD"], { cwd: ROOT }),
  exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: ROOT }),
  exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: ROOT }),
]);
if (head.trim() !== options.commit) throw new Error("CI checkout is not the exact requested candidate head.");
if (status.trim()) throw new Error("CI package build requires one clean checkout.");
const out = path.resolve(options.out);
const smokeCasePath = path.resolve(options["smoke-case"]);
const smokeCaseStat = await fs.lstat(smokeCasePath);
if (!smokeCaseStat.isFile() || smokeCaseStat.isSymbolicLink()) throw new Error("Smoke case must be one regular non-symlink file.");
const smokeCaseBytes = await fs.readFile(smokeCasePath);
await fs.mkdir(out, { recursive: true });
const lower = options.label.toLowerCase();
const packageRoot = path.join(out, `package-${lower}`);
const archivePath = path.join(out, `package-${lower}.tar`);
const attestationPath = path.join(out, `package-${lower}.attestation.json`);
const logPath = path.join(out, `package-${lower}.build.log`);
const receiptPath = path.join(out, `package-${lower}.build-receipt.json`);
const env = {
  ...process.env,
  SOURCE_DATE_EPOCH: options["source-date-epoch"],
  ...(options.python ? { PYTHON_BINARY: options.python, DEBT_OVERLAY_PYTHON: options.python, EXCEL_INFLOW_TEST_PYTHON: options.python } : {}),
  ...(options.soffice ? { SOFFICE_BIN: options.soffice } : {}),
};
delete env.EXCEL_INFLOW_BUILD_TIMESTAMP;
delete env.EXCEL_INFLOW_SOURCE_COMMIT;
delete env.EXCEL_INFLOW_SOURCE_TREE;
const started = new Date().toISOString();
let build;
try {
  build = await exec(process.execPath, [
    path.join(ROOT, "scripts", "compile_skill_release.mjs"), "--skill", ROOT,
    "--out", packageRoot, "--development", "--smoke-case", smokeCasePath,
    "--archive-out", archivePath, "--attestation-out", attestationPath,
  ], { cwd: ROOT, env, timeout: 3_600_000, maxBuffer: 256 * 1024 * 1024 });
} catch (error) {
  await fs.writeFile(logPath, `${error.stdout ?? ""}\n${error.stderr ?? error.message}\n`);
  throw error;
}
await fs.writeFile(logPath, [
  `started_at=${started}`, `completed_at=${new Date().toISOString()}`,
  `source_commit=${head.trim()}`, `source_tree=${tree.trim()}`,
  `source_date_epoch=${options["source-date-epoch"]}`, "exit_code=0",
  "--- stdout ---", build.stdout ?? "", "--- stderr ---", build.stderr ?? "",
].join("\n"));
const receipt = await compilePackageBuildReceipt({
  label: options.label, packageRoot, archivePath, attestationPath, buildLogPath: logPath,
  sourceCommit: head.trim(), sourceTree: tree.trim(), sourceDateEpoch: options["source-date-epoch"],
  checkoutInstanceId: `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_JOB ?? "job"}:${randomUUID()}`,
  toolchain: {
    node: process.version,
    python: await observedVersion(options.python, "Python"),
    soffice: await observedVersion(options.soffice, "LibreOffice"),
  },
  buildInputs: {
    smoke_case: {
      path: smokeCasePath,
      size: smokeCaseBytes.length,
      sha256: createHash("sha256").update(smokeCaseBytes).digest("hex"),
    },
  },
  buildExitCode: 0,
});
await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: "PASS", label: options.label, receipt: receiptPath, archive: archivePath, package: packageRoot })}\n`);
