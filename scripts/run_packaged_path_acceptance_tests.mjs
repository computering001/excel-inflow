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

import { validateJsonSchema } from "./lib/json_schema.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const bootstrapRelative = "scripts/run_excel_inflow_bootstrap.mjs";
const COMPANY_HEADER = "+=[ EXCEL INFLOW ]==============================[ COMPANY ]=+";
const pythonInput = process.argv[2] ?? process.env.EXCEL_INFLOW_TEST_PYTHON ??
  process.env.EXCEL_INFLOW_PYTHON ?? process.env.PYTHON;
const sofficeInput = process.argv[3] ?? process.env.SOFFICE_BIN;
if (!pythonInput || !sofficeInput) {
  throw new Error("usage: run_packaged_path_acceptance_tests.mjs <python> <soffice>");
}
const python = path.resolve(pythonInput);
const soffice = await fs.realpath(path.resolve(sofficeInput));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-packaged-paths-"));
const compiledRoot = path.join(scratch, "compiled donor package");
let checks = 0;
const cases = [
  { id: "spaces", relative: ["paths with spaces", "Excel Inflow Candidate"] },
  { id: "unicode", relative: ["unicode paths", "Excel 流入 Δ кандидат"] },
  { id: "percent", relative: ["literal % paths", "candidate %20 %E2%9C%93 100%"] },
  { id: "parentheses", relative: ["parentheses", "Excel Inflow (candidate) (v3.7.9)"] },
  {
    id: "nested-long",
    relative: [
      `nested-${"a".repeat(48)}`,
      `segment-${"b".repeat(48)}`,
      `segment-${"c".repeat(48)}`,
      "Excel Inflow long-path package",
    ],
  },
];
const passedCases = [];
const mutationIds = ["direct-import-meta-pathname"];
const caught = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function execute(command, args, options = {}) {
  try {
    const done = await execFileAsync(command, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
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

function lastJson(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines.slice(index).join("\n")); } catch { /* continue */ }
  }
  try { return JSON.parse(String(stdout)); } catch { return null; }
}

async function treeIdentity(root) {
  const records = {};
  const walk = async (directory, prefix = "") => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, relative);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(target);
        records[relative] = { bytes: bytes.length, sha256: sha256(bytes) };
      } else {
        records[relative] = { unsupported_type: true };
      }
    }
  };
  await walk(root);
  return records;
}

async function packageCustody(packageRoot) {
  const archive = await fs.readFile(`${packageRoot}.tar`);
  const attestation = await fs.readFile(`${packageRoot}.attestation.json`);
  return {
    files: await treeIdentity(packageRoot),
    archive: { bytes: archive.length, sha256: sha256(archive) },
    attestation: { bytes: attestation.length, sha256: sha256(attestation) },
  };
}

async function copyActualPackage(packageRoot) {
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(compiledRoot, packageRoot, { recursive: true, force: false, errorOnExist: true });
  await Promise.all([
    fs.copyFile(`${compiledRoot}.tar`, `${packageRoot}.tar`),
    fs.copyFile(`${compiledRoot}.attestation.json`, `${packageRoot}.attestation.json`),
  ]);
}

function checkById(report, id) {
  const matches = report.checks.filter((entry) => entry.precondition_id === id);
  check(matches.length === 1, `runtime report has ${matches.length} ${id} checks`);
  return matches[0];
}

async function canonicalProspective(target) {
  let cursor = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(cursor), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
}

async function assertPhysicalFacts(facts, expectedRoot, purpose, label) {
  check(facts.purpose === purpose, `${label} purpose drifted`);
  check(facts.requested_root === path.resolve(expectedRoot), `${label} requested path was URL-decoded or encoded`);
  check(
    facts.canonical_requested_root === await canonicalProspective(expectedRoot),
    `${label} canonical path lost characters`,
  );
  check(facts.outside_immutable_skill_root === true, `${label} was not proven outside package`);
  check(facts.real_run_directory_created === false, `${label} probe created the real run directory`);
  for (const field of [
    "created", "written", "flushed", "closed", "read_back", "bytes_match",
    "renamed", "statted", "deleted", "cleanup_verified",
  ]) {
    check(facts[field] === true, `${label} physical operation ${field} did not pass`);
  }
  check(
    typeof facts.volume_identity?.device_id === "string" &&
      typeof facts.volume_identity?.filesystem_type === "string" &&
      facts.volume_identity?.block_size_bytes > 0,
    `${label} omitted volume identity`,
  );
}

async function runDiagnostic(packageRoot, caseRoot, id) {
  const artifacts = path.join(caseRoot, `artifacts ${id} % (diagnostic)`);
  const runRoot = path.join(caseRoot, `run root ${id} % (not created)`);
  const tempRoot = path.join(caseRoot, `temp root ${id} % (physical)`);
  await Promise.all([
    fs.mkdir(artifacts, { recursive: true }),
    fs.mkdir(tempRoot, { recursive: true }),
  ]);
  const reportAlias = path.join(artifacts, "runtime doctor report.json");
  const receiptAlias = path.join(artifacts, "installed capability receipt.json");
  const result = await execute(process.execPath, [
    path.join(packageRoot, ...bootstrapRelative.split("/")),
    "--diagnostic",
    "--run-root", runRoot,
    "--temp-root", tempRoot,
    "--lane", "evidence,workbook",
    "--python", python,
    "--soffice", soffice,
    "--out", reportAlias,
    "--capability-receipt", receiptAlias,
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
      PYTHONNOUSERSITE: "1",
    },
  });
  check(result.code === 0, `${id} diagnostic refused: ${result.stdout.slice(-2000)} ${result.stderr.slice(-2000)}`);
  check(result.stderr === "", `${id} diagnostic wrote stderr`);
  const report = lastJson(result.stdout);
  check(report?.verdict === "HOST_READY", `${id} diagnostic did not produce HOST_READY`);
  check(report.run_root === path.resolve(runRoot), `${id} report run-root identity changed`);
  check(report.performed_expensive_work === false, `${id} doctor claimed issuer work`);

  const [receipt, receiptSchema, pointer, pointerSchema] = await Promise.all([
    readJson(receiptAlias),
    readJson(path.join(packageRoot, "assets", "installed-capability-receipt-v1.3.schema.json")),
    readJson(path.join(artifacts, "host-preflight-current.json")),
    readJson(path.join(packageRoot, "assets", "host-preflight-pointer-v1.schema.json")),
  ]);
  check(
    receipt.schema_version === receiptSchema.properties.schema_version.const,
    `${id} receipt is not the package's current schema version`,
  );
  check(validateJsonSchema(receipt, receiptSchema).length === 0, `${id} current receipt is schema-invalid`);
  check(receipt.status === "HOST_READY", `${id} receipt is not HOST_READY`);
  check(validateJsonSchema(pointer, pointerSchema).length === 0, `${id} current pointer is schema-invalid`);
  check(pointer.status === "HOST_READY", `${id} current pointer is not ready`);
  const pointedReceiptBytes = await fs.readFile(path.join(artifacts, pointer.receipt_file));
  check(sha256(pointedReceiptBytes) === pointer.receipt_sha256, `${id} pointer receipt hash drifted`);
  check(JSON.parse(pointedReceiptBytes).receipt_sha256 === pointer.receipt_self_sha256, `${id} pointer self-hash drifted`);
  check(
    receipt.node.executable === process.execPath && receipt.python.executable === python &&
      receipt.workbook.soffice_executable === soffice,
    `${id} selected executable path identity changed`,
  );

  const work = checkById(report, "work_root_writable");
  const temp = checkById(report, "temp_root_writable");
  const disk = checkById(report, "disk_space_policy");
  check(work.result === "satisfied" && temp.result === "satisfied", `${id} physical probes did not satisfy`);
  check(
    disk.result === "satisfied" && disk.detail?.mode === "candidate" &&
      disk.detail?.evaluation?.status === "PASS" &&
      disk.detail?.evaluation?.selected_lane === "combined",
    `${id} measured mandatory disk-space policy did not satisfy`,
  );
  check(
    disk.detail.evaluation.roots.temp_root.available_bytes > 0 &&
      JSON.stringify(disk.detail.evaluation.roots.temp_root.volume_identity) ===
        JSON.stringify(temp.detail.volume_identity),
    `${id} disk-space evaluation did not bind the physical temp-root volume`,
  );
  await assertPhysicalFacts(work.detail, runRoot, "run_root", `${id} work root`);
  await assertPhysicalFacts(temp.detail, tempRoot, "temp_root", `${id} temp root`);
  check(!(await fs.stat(runRoot).then(() => true, () => false)), `${id} diagnostic created prospective run root`);
  return { report, receipt, artifacts, runRoot, tempRoot };
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function runCompany(packageRoot, id) {
  const sessionRoot = path.join(path.dirname(packageRoot), `screen-session-${id}`);
  const result = await execute(process.execPath, [
    path.join(packageRoot, ...bootstrapRelative.split("/")),
    "--screen", "company",
    "--screen-session-receipt", path.join(sessionRoot, "screen-session.json"),
    "--screen-session-id", `packaged-path-${id}`,
    "--screen-session-secret", `packaged-path-${id}-0123456789-abcdef-0123456789`,
    "--python", python,
    "--soffice", soffice,
  ], {
    cwd: packageRoot,
    timeout: 60_000,
    env: {
      ...process.env,
      EXCEL_INFLOW_TEST_PYTHON: python,
      EXCEL_INFLOW_PYTHON: python,
      PYTHON: python,
      SOFFICE_BIN: soffice,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  check(result.code !== 0 && result.stderr === "", `${id} uninstalled package Company route did not refuse`);
  check(
    /REFUSED|INTERNAL_FAILURE/.test(result.stdout) &&
      !result.stdout.includes(`${COMPANY_HEADER}\n`) &&
      !result.stdout.startsWith("```text\n"),
    `${id} uninstalled package displayed a Company screen without verified install state`,
  );
  return result.stdout;
}

try {
  const compiled = await execute(process.execPath, [
    path.join(ROOT, "scripts", "compile_skill_release.mjs"),
    "--skill", ROOT,
    "--out", compiledRoot,
    "--development",
  ], {
    cwd: ROOT,
    timeout: 300_000,
    env: {
      ...process.env,
      EXCEL_INFLOW_TEST_PYTHON: python,
      EXCEL_INFLOW_PYTHON: python,
      PYTHON: python,
      SOFFICE_BIN: soffice,
      EXCEL_INFLOW_SOURCE_REPOSITORY: "computering001/excel-inflow",
      EXCEL_INFLOW_SOURCE_COMMIT: "1".repeat(40),
      EXCEL_INFLOW_SOURCE_TREE: "2".repeat(40),
      EXCEL_INFLOW_BUILD_TIMESTAMP: "2026-08-21T00:00:00.000Z",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  check(compiled.code === 0, `development package compile failed: ${compiled.stdout} ${compiled.stderr}`);
  check(
    await fs.stat(`${compiledRoot}.tar`).then((entry) => entry.isFile(), () => false) &&
      await fs.stat(`${compiledRoot}.attestation.json`).then((entry) => entry.isFile(), () => false),
    "compiler omitted package archive or external attestation",
  );
  const donorIdentity = await packageCustody(compiledRoot);
  const donorBootstrap = await fs.readFile(path.join(compiledRoot, ...bootstrapRelative.split("/")), "utf8");
  check(donorBootstrap.includes("fileURLToPath(import.meta.url)"), "compiled bootstrap lost URL-safe path conversion");
  check(!/import\.meta\.url\)\.pathname/.test(donorBootstrap), "compiled bootstrap already uses direct URL pathname");

  for (const entry of cases) {
    const caseRoot = path.join(scratch, `case ${entry.id} % (root)`);
    const packageRoot = path.join(caseRoot, ...entry.relative);
    await copyActualPackage(packageRoot);
    const before = await packageCustody(packageRoot);
    check(JSON.stringify(before) === JSON.stringify(donorIdentity), `${entry.id} copy changed actual package/sidecars`);
    await runDiagnostic(packageRoot, caseRoot, entry.id);
    await runCompany(packageRoot, entry.id);
    const after = await packageCustody(packageRoot);
    check(JSON.stringify(after) === JSON.stringify(before), `${entry.id} execution mutated package or sidecars`);
    check(!Object.keys(after.files).some((name) => name.includes("__pycache__") || name.endsWith(".pyc")), `${entry.id} created bytecode inside package`);
    passedCases.push(entry.id);
  }

  const faultRoot = path.join(scratch, "fault %20 direct pathname", "Excel Inflow (fault)");
  await copyActualPackage(faultRoot);
  const bootstrapPath = path.join(faultRoot, ...bootstrapRelative.split("/"));
  const original = await fs.readFile(bootstrapPath, "utf8");
  const mutated = original.replace(
    "const BOOTSTRAP_FILE = fileURLToPath(import.meta.url);",
    "const BOOTSTRAP_FILE = new URL(import.meta.url).pathname;",
  );
  check(mutated !== original && mutated.includes("import.meta.url).pathname"), "direct pathname mutation did not apply");
  await fs.writeFile(bootstrapPath, mutated, "utf8");
  const manifestPath = path.join(faultRoot, "release-manifest.json");
  const manifest = await readJson(manifestPath);
  const record = manifest.files.find((item) => item.path === bootstrapRelative);
  const mutatedBytes = await fs.readFile(bootstrapPath);
  record.sha256 = sha256(mutatedBytes);
  record.bytes = mutatedBytes.length;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const faultOut = path.join(scratch, "fault output %20 (typed)");
  const fault = await execute(process.execPath, [
    bootstrapPath,
    "--screen", "company",
    "--out", faultOut,
  ], {
    cwd: faultRoot,
    timeout: 60_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const refusal = lastJson(fault.stdout);
  check(fault.code === 1, "direct pathname fault package unexpectedly ran Company route");
  check(
    refusal?.schema_version === "excel-inflow-runtime-bootstrap-refusal/1.0" &&
      refusal.verdict === "REFUSED" && refusal.subordinate_execution_attempted === false,
    `direct pathname fault did not fail at package-root bootstrap: ${fault.stdout} ${fault.stderr}`,
  );
  check(!fault.stdout.includes(COMPANY_HEADER), "direct pathname fault fell back to a static Company screen");
  caught.push("direct-import-meta-pathname");

  check(passedCases.length === cases.length, "not every hostile packaged path executed");
  check(caught.length === mutationIds.length, "direct pathname mutation did not execute");
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    compiled_packages: 1,
    accepted_paths: passedCases,
    accepted_path_count: passedCases.length,
    mutations_declared: mutationIds.length,
    mutations_applied: caught.length,
    mutations_caught: caught.length,
    mutations_survived: mutationIds.length - caught.length,
    mutation_ids: caught,
    package_bytes_unchanged: true,
    static_fallbacks: 0,
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
