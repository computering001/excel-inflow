#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalSha256, validateArchiveOnlyReport } from "./lib/exact_head_package_ci.mjs";
import { parseUstarArchive } from "./lib/package_ab_comparison.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parse(argv) {
  const allowed = new Set(["archive", "attestation", "out", "python", "soffice"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.startsWith("--") ? argv[index].slice(2) : null;
    if (!allowed.has(key) || argv[index + 1] === undefined) throw new Error(`Unknown or incomplete argument ${argv[index]}.`);
    result[key] = argv[index + 1];
  }
  return result;
}

async function regularFile(target, label) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be one regular non-symlink file.`);
  return { stat, bytes: await fs.readFile(target) };
}

function safeMemberName(name) {
  if (!name || name.includes("\\") || path.posix.isAbsolute(name) || name.split("/").includes("..") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe archive member ${JSON.stringify(name)}.`);
  }
  return name.replace(/^\.\//, "");
}

async function unpackArchive(archiveBytes, destination) {
  const parsed = parseUstarArchive(archiveBytes, "downloaded package archive");
  const names = new Set();
  await fs.mkdir(destination, { recursive: false });
  for (const member of parsed.members) {
    const name = safeMemberName(member.name);
    if (names.has(name)) throw new Error(`Duplicate archive member ${name}.`);
    names.add(name);
    const target = path.resolve(destination, ...name.split("/"));
    if (target !== destination && !target.startsWith(`${destination}${path.sep}`)) throw new Error(`Archive member escaped destination: ${name}.`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, member.bytes, { flag: "wx", mode: 0o644 });
  }
  return parsed;
}

const options = parse(process.argv.slice(2));
if (!options.archive || !options.attestation || !options.out || !options.python || !options.soffice) {
  throw new Error("Usage: run_archive_only_capability_ci.mjs --archive <package.tar> --attestation <json> --out <directory> --python <exe> --soffice <exe>");
}
const archivePath = path.resolve(options.archive);
const attestationPath = path.resolve(options.attestation);
const out = path.resolve(options.out);
const pythonPath = path.resolve(options.python);
const sofficePath = await fs.realpath(path.resolve(options.soffice));
const [{ bytes: archiveBytes }, { bytes: attestationBytes }] = await Promise.all([
  regularFile(archivePath, "Downloaded package archive"),
  regularFile(attestationPath, "Downloaded package attestation"),
]);
const attestation = JSON.parse(attestationBytes.toString("utf8"));
const archiveSha = sha256(archiveBytes);
if (attestation?.status !== "PASS" || attestation?.package?.archive?.sha256 !== archiveSha) {
  throw new Error("Downloaded archive does not match its PASS package attestation.");
}
await fs.mkdir(out, { recursive: true });
const packageRoot = path.join(out, "unpacked-package");
const logsRoot = path.join(out, "test-logs");
await fs.mkdir(logsRoot);
const retainedAttestationPath = path.join(out, "release-candidate-attestation.json");
if (retainedAttestationPath !== attestationPath) await fs.writeFile(retainedAttestationPath, attestationBytes, { flag: "wx" });
const parsed = await unpackArchive(archiveBytes, packageRoot);
if (await fs.lstat(path.join(packageRoot, ".git")).then(() => true, () => false)) throw new Error("Downloaded package contains a source checkout.");
const memberFiles = Object.fromEntries(parsed.members.map((member) => [safeMemberName(member.name), sha256(member.bytes)]));
const expectedFiles = attestation?.package?.complete_package_inventory?.files;
if (!expectedFiles || canonicalSha256(memberFiles) !== canonicalSha256(expectedFiles)) {
  throw new Error("Downloaded archive members do not equal the attested complete package inventory.");
}
await regularFile(path.join(packageRoot, "release-manifest.json"), "Unpacked release manifest");
const env = {
  ...process.env,
  EXCEL_INFLOW_TEST_PYTHON: pythonPath,
  EXCEL_INFLOW_PYTHON: pythonPath,
  PYTHON: pythonPath,
  SOFFICE_BIN: sofficePath,
  PYTHONDONTWRITEBYTECODE: "1",
  EXCEL_INFLOW_RELEASE_PACKAGE_ARCHIVE: archivePath,
  EXCEL_INFLOW_RELEASE_PACKAGE_ATTESTATION: attestationPath,
};
const lanes = {};
const capabilityReportPath = path.join(out, "installed-capability-report.json");
const capabilityReceiptPath = path.join(out, "installed-capability-receipt.json");
const doctorLogPath = path.join(logsRoot, "public-bootstrap-installed-capability.log");
let doctor;
try {
  doctor = await exec(process.execPath, [
    path.join(packageRoot, "scripts", "run_excel_inflow_bootstrap.mjs"),
    "--diagnostic",
    "--run-root", path.join(out, "prospective-run"),
    "--lane", "evidence,workbook",
    "--python", pythonPath,
    "--soffice", sofficePath,
    "--out", capabilityReportPath,
    "--capability-receipt", capabilityReceiptPath,
    "--json",
  ], { cwd: packageRoot, env, timeout: 300_000, maxBuffer: 128 * 1024 * 1024 });
} catch (error) {
  await fs.writeFile(doctorLogPath, `${error.stdout ?? ""}\n${error.stderr ?? error.message}\n`);
  throw new Error(`Installed-capability doctor failed; see ${doctorLogPath}: ${error.message}`);
}
const doctorLogBytes = Buffer.from(`${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}\n`, "utf8");
await fs.writeFile(doctorLogPath, doctorLogBytes, { flag: "wx" });
const doctorReport = JSON.parse(await fs.readFile(capabilityReportPath, "utf8"));
if (doctorReport.verdict !== "HOST_READY") throw new Error("Downloaded archive runtime doctor did not close HOST_READY.");
const capabilityReceiptSha = sha256(await fs.readFile(capabilityReceiptPath));
const capabilityReportSha = sha256(await fs.readFile(capabilityReportPath));
const bootstrapReportBody = {
  schema_version: "archive-only-public-bootstrap-proof/1.0",
  status: "PASS",
  source_checkout_used: false,
  package_bootstrap: "scripts/run_excel_inflow_bootstrap.mjs",
  subordinate_runtime_doctor: "scripts/run_runtime_doctor.mjs",
  runtime_doctor_report_sha256: capabilityReportSha,
  installed_capability_receipt_sha256: capabilityReceiptSha,
  stdout_sha256: sha256(Buffer.from(doctor.stdout ?? "", "utf8")),
  stderr_sha256: sha256(Buffer.from(doctor.stderr ?? "", "utf8")),
};
const bootstrapReport = { ...bootstrapReportBody, report_sha256: canonicalSha256(bootstrapReportBody) };
const bootstrapReportPath = path.join(out, "public-bootstrap-report.json");
await fs.writeFile(bootstrapReportPath, `${JSON.stringify(bootstrapReport, null, 2)}\n`, { flag: "wx" });
lanes.public_bootstrap = {
  status: "PASS",
  command_script: "scripts/run_excel_inflow_bootstrap.mjs",
  report: bootstrapReportPath,
  report_sha256: sha256(await fs.readFile(bootstrapReportPath)),
  log: doctorLogPath,
  log_sha256: sha256(doctorLogBytes),
};
lanes.installed_capability = {
  status: "PASS",
  command_script: "scripts/run_excel_inflow_bootstrap.mjs --diagnostic",
  report: capabilityReportPath,
  report_sha256: capabilityReportSha,
  receipt: capabilityReceiptPath,
  receipt_sha256: capabilityReceiptSha,
  log: doctorLogPath,
  log_sha256: sha256(doctorLogBytes),
};
const oraclePath = path.join(out, "independent-oracle-report.json");
const oracleLogPath = path.join(logsRoot, "independent-oracle.log");
let oracle;
try {
  oracle = await exec(pythonPath, [
    path.join(ROOT, "scripts", "verify", "installed_capability_oracle.py"),
    "--artifact-dir", out,
    "--package-root", packageRoot,
    "--package-archive", archivePath,
    "--package-attestation", attestationPath,
    "--expected-node-executable", process.execPath,
    "--expected-python-executable", pythonPath,
    "--expected-soffice-executable", sofficePath,
    "--expected-deployment-status", "not_installed",
  ], { cwd: packageRoot, env, timeout: 300_000, maxBuffer: 128 * 1024 * 1024 });
} catch (error) {
  await fs.writeFile(oracleLogPath, `${error.stdout ?? ""}\n${error.stderr ?? error.message}\n`);
  throw new Error(`Independent installed-capability oracle failed; see ${oracleLogPath}: ${error.message}`);
}
const oracleLogBytes = Buffer.from(`${oracle.stdout ?? ""}\n${oracle.stderr ?? ""}\n`, "utf8");
await fs.writeFile(oracleLogPath, oracleLogBytes, { flag: "wx" });
const oracleReport = JSON.parse(String(oracle.stdout).trim());
if (oracleReport.audit_status !== "PASS" || oracleReport.total_violations !== 0) {
  throw new Error("Independent oracle did not accept the downloaded archive's exact doctor generation.");
}
await fs.writeFile(oraclePath, `${JSON.stringify(oracleReport, null, 2)}\n`, { flag: "wx" });
lanes.independent_oracle = {
  status: "PASS",
  command_script: "external-independent-oracle:scripts/verify/installed_capability_oracle.py",
  report: oraclePath,
  report_sha256: sha256(await fs.readFile(oraclePath)),
  log: oracleLogPath,
  log_sha256: sha256(oracleLogBytes),
};
const body = {
  schema_version: "archive-only-capability-proof/1.0",
  archive: archivePath,
  archive_sha256: archiveSha,
  attestation: attestationPath,
  attestation_sha256: sha256(attestationBytes),
  unpacked_package: {
    root: packageRoot,
    source_checkout_present: false,
    source_checkout_used_for_package_runtime: false,
    member_count: parsed.member_count,
    inventory_sha256: canonicalSha256(memberFiles),
  },
  lanes: {
    public_bootstrap: lanes.public_bootstrap,
    installed_capability: lanes.installed_capability,
    independent_oracle: lanes.independent_oracle,
  },
  installed_capability_receipt: { path: capabilityReceiptPath, sha256: capabilityReceiptSha },
  source_checkout_used: false,
  source_checkout_use_scope: "external_ci_harness_and_independent_oracle_only",
  production_promotion_eligible: false,
  findings: [],
  status: "PASS",
};
const report = { ...body, report_sha256: canonicalSha256(body) };
const findings = validateArchiveOnlyReport(report);
if (findings.length) throw new Error(`Archive-only report failed self-validation: ${findings.join(", ")}`);
const reportPath = path.join(out, "archive-only-capability-report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "PASS", report: reportPath, archive_sha256: archiveSha, receipt: capabilityReceiptPath })}\n`);
