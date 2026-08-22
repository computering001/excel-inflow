#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { resolvePythonExecutable } from "./lib/process_tree.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { installedCapabilityReceiptDigest } from "./lib/runtime_doctor.mjs";
import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";
import { assertRawCanaryEvidenceDigest } from "./lib/raw_canary_fixture.mjs";
import { identitySha256 } from "./lib/identity_vocabulary.mjs";
import { completePackageInventoryIdentity } from "./lib/release_package_attestation.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const pythonSelection =
  process.env.EXCEL_INFLOW_TEST_PYTHON ?? process.env.EXCEL_INFLOW_PYTHON ??
  process.env.PYTHON ?? "python3";
const python = path.isAbsolute(pythonSelection)
  ? pythonSelection
  : await resolvePythonExecutable(pythonSelection, { env: process.env });
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1 && (!process.argv[outIndex + 1] || process.argv[outIndex + 1].startsWith("--"))) {
  throw new Error("--out requires a file path");
}
const outputPath = outIndex === -1 ? null : path.resolve(process.argv[outIndex + 1]);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "installed-filings-capability-tests-"));
let checks = 0;
const mutations = [];
let doctorInvocation = 0;
const EXPECTED_MUTATIONS_BASE = Object.freeze([
  "extractor-permission",
  "functional-libreoffice-profile-residue",
  "installed-inline-xbrl-cleanup-failure",
  "installed-inline-xbrl-fixture-tamper",
  "installed-inline-xbrl-missing-worker",
  "installed-inline-xbrl-timeout",
  "installed-extractor-byte-drift",
  "invalid-temp-root",
  "invalid-work-root",
  "missing-fixture",
  "missing-release-manifest",
  "missing-runtime-doctor",
  "package-change-after-receipt",
  "packaged-inline-xbrl-contradiction",
  "packaged-inline-xbrl-worker-missing",
  "poisoned-path",
  "relocated-extractor",
  "run-root-symlink-into-skill",
  "runtime-compatibility-violation",
  "selected-python-missing-fitz",
  "selected-python-missing-lxml",
  "selected-python-missing-openpyxl",
  "symlinked-extractor",
  "unexpected-package-member",
  "unexpected-package-symlink",
  "wrong-interpreter",
]);

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

async function execute(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    return {
      code: Number(error.code ?? -1),
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

async function writeIdentityRecord(target, body, hashField) {
  const record = { ...body, [hashField]: identitySha256(body) };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.writeFile(target, bytes);
  return { record, rawSha256: createHash("sha256").update(bytes).digest("hex") };
}

async function authorCandidateInstallState(packageRoot, archivePath, name) {
  const stateRoot = path.join(scratch, name);
  await fs.mkdir(stateRoot);
  const [manifest, inventory, archiveBytes] = await Promise.all([
    fs.readFile(path.join(packageRoot, "release-manifest.json"), "utf8").then(JSON.parse),
    completePackageInventoryIdentity(packageRoot),
    fs.readFile(archivePath),
  ]);
  const source = manifest.identity.source;
  const packageIdentity = manifest.identity.package;
  const closure = packageIdentity.runtime_code_closure;
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  await fs.writeFile(path.join(stateRoot, "package-archive.tar"), archiveBytes);
  const installation = await writeIdentityRecord(
    path.join(stateRoot, "installation-receipt.json"),
    {
      schema_version: "excel-inflow-installation-receipt/1.0",
      installation_identity: "installed-filings-clean-candidate",
      installation_generation: 1,
      slot_id: "candidate-under-test",
      installed_at: new Date(Date.now() - 120_000).toISOString(),
      package: {
        source_commit: source.commit_sha,
        source_tree: source.tree_sha,
        package_mode: packageIdentity.mode,
        package_inventory_sha256: inventory.sha256,
        archive_sha256: archiveSha256,
        runtime_closure_sha256: closure.sha256,
        certified_runtime_closure_sha256: closure.certified_sha256 ?? null,
        installed_package_sha256: inventory.sha256,
      },
    },
    "receipt_sha256",
  );
  await writeIdentityRecord(
    path.join(stateRoot, "active-install-pointer.json"),
    {
      schema_version: "excel-inflow-active-install-pointer/1.0",
      generation: 1,
      slot_id: "already-active-production-slot",
      installation_identity: "already-active-production-installation",
      installation_receipt_sha256: "1".repeat(64),
      package_inventory_sha256: "2".repeat(64),
      archive_sha256: "3".repeat(64),
      runtime_closure_sha256: "4".repeat(64),
      promotion_receipt_sha256: "5".repeat(64),
      previous_slot_id: "previous-production-slot",
      rollback_package_sha256: "6".repeat(64),
      activated_at: new Date(Date.now() - 60_000).toISOString(),
    },
    "pointer_sha256",
  );
  return { stateRoot, installation };
}

function companySessionArgs(label) {
  const root = path.join(scratch, `company-session-${label}`);
  return [
    "--screen-session-receipt", path.join(root, "screen-session.json"),
    "--screen-session-id", `installed-filings-${label}`,
    "--screen-session-secret", `installed-filings-${label}-0123456789-abcdef-0123456789`,
  ];
}

async function runDoctor(packageRoot, {
  selectedPython = python,
  runRoot = path.join(scratch, "prospective-run"),
  env = process.env,
  lanes = "evidence,workbook",
  tempRoot = null,
} = {}) {
  doctorInvocation += 1;
  const artifactRoot = path.join(scratch, `doctor-${doctorInvocation}`);
  await fs.mkdir(artifactRoot, { recursive: true });
  const reportPath = path.join(artifactRoot, "runtime-doctor-report.json");
  const receiptPath = path.join(artifactRoot, "installed-capability-receipt.json");
  const result = await execute(process.execPath, [
    path.join(packageRoot, "scripts", "run_runtime_doctor.mjs"),
    "--run-root", runRoot,
    "--lane", lanes,
    "--python", selectedPython,
    ...(tempRoot ? ["--temp-root", tempRoot] : []),
    "--out", reportPath,
    "--capability-receipt", receiptPath,
    "--json",
  ], {
    cwd: packageRoot,
    env: {
      ...env,
      EXCEL_INFLOW_PYTHON: selectedPython,
      PYTHON: selectedPython,
    },
  });
  const report = result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout) : null;
  const reportBytes = await fs.readFile(reportPath).catch(() => null);
  const receiptBytes = await fs.readFile(receiptPath).catch(() => null);
  const receipt = receiptBytes ? JSON.parse(receiptBytes.toString("utf8")) : null;
  return { ...result, report, reportBytes, receipt, receiptBytes, reportPath, receiptPath };
}

async function clonePackage(source, name) {
  const destination = path.join(scratch, name);
  await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  return destination;
}

async function packageMemberSet(root) {
  const members = [];
  const walk = async (directory, prefix = "") => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else members.push(`${entry.isSymbolicLink() ? "symlink:" : "file:"}${relative}`);
    }
  };
  await walk(root);
  return members.sort();
}

function inlineXbrlHtml(periods, factSpecs) {
  const contexts = periods.map((end, index) => `
    <xbrli:context id="D${index}">
      <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier></xbrli:entity>
      <xbrli:period><xbrli:startDate>${end.slice(0, 4)}-01-01</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period>
    </xbrli:context>
    <xbrli:context id="DSEG${index}">
      <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier></xbrli:entity>
      <xbrli:period><xbrli:startDate>${end.slice(0, 4)}-01-01</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period>
      <xbrli:scenario><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">test:SegmentMember</xbrldi:explicitMember></xbrli:scenario>
    </xbrli:context>`).join("\n");
  const facts = factSpecs.map(({ concept, values, dimensioned = false }) =>
    values.map((value, index) => {
      const context = dimensioned ? `DSEG${index}` : `D${index}`;
      const sign = value < 0 ? " sign=\"-\"" : "";
      return `<td><ix:nonFraction name="${concept}" contextRef="${context}" unitRef="usd" decimals="-6" scale="6"${sign}>${Math.abs(value)}</ix:nonFraction></td>`;
    }).join(""),
  ).join("\n");
  return `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<body><div style="display:none">${contexts}
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
</div><table><tr>${facts}</tr></table></body></html>\n`;
}

async function authorInlineXbrlControllerInput({ clean, name, factSpecs }) {
  const fixtureRoot = path.join(scratch, `packaged-inline-xbrl-${name}`);
  await fs.mkdir(fixtureRoot, { recursive: true });
  const rawPath = path.join(fixtureRoot, "annual-report.htm");
  await fs.writeFile(
    rawPath,
    inlineXbrlHtml(clean.filings.historical_periods, factSpecs),
    "utf8",
  );
  const rawSha256 = createHash("sha256").update(await fs.readFile(rawPath)).digest("hex");
  const manifests = structuredClone(clean.filings.face_statement_manifests);
  for (const section of ["income_statement", "cash_flow"]) {
    for (const [index, manifest] of manifests[section].entries()) {
      manifest.source_id = "annual_report";
      manifest.document_sha256 = rawSha256;
      manifest.statement_order = index + 1;
      manifest.rows_sha256 = faceStatementManifestDigest(manifest);
    }
  }
  const {
    face_statement_manifests: _manifests,
    income_statement: _income,
    cash_flow: _cash,
    ...filingFacts
  } = clean.filings;
  const request = {
    schema_version: "filings-extraction-request/1.0",
    run_id: `packaged-inline-xbrl-${name}`,
    documents: [{
      document_id: "annual-report",
      attachment_id: "annual-report",
      source_id: "annual_report",
      path: rawPath,
      media_type: "text/html",
      expected_sha256: rawSha256,
    }],
    filing_facts: filingFacts,
  };
  const response = {
    schema_version: "filings-extraction-response/1.0",
    run_id: request.run_id,
    documents: [{
      document_id: "annual-report",
      attachment_id: "annual-report",
      source_id: "annual_report",
      raw_sha256: rawSha256,
      disposition: "selected_face_statement_authority",
      review_reason: "Selected inline-XBRL filing supplies complete three-year face statements.",
      face_statement_manifests: manifests,
    }],
    filing_facts: filingFacts,
  };
  const requestPath = path.join(fixtureRoot, "request.json");
  const responsePath = path.join(fixtureRoot, "response.json");
  const out = path.join(fixtureRoot, "run");
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await fs.writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
  return { requestPath, responsePath, out };
}

function plainHtmlTablesDocument() {
  // Deliberately marker-free: no ix:nonFraction anywhere, so only the
  // html-tables lane can own these printed <table> facts.
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Annual Report</title></head>
<body>
<h2>Consolidated Statements of Operations</h2>
<table>
  <caption>In thousands</caption>
  <tr><th>Line item</th><th>Year ended December 31, 2025</th><th>Year ended December 31, 2024</th><th>Year ended December 31, 2023</th></tr>
  <tr><td>Total revenue</td><td>$4,321</td><td>$4,000</td><td>$3,750</td></tr>
  <tr><td>Net cash provided by operating activities</td><td>(169)</td><td>150</td><td>121</td></tr>
</table>
</body>
</html>
`;
}

// The packaged plain-HTML route exercises the pipeline's extraction phase
// itself: no caller-supplied response exists, so face-statement authority is
// genuinely owed back to adjudication after the lane binds its fact table.
async function authorHtmlTablesControllerInput({ clean, name }) {
  const fixtureRoot = path.join(scratch, `packaged-html-tables-${name}`);
  await fs.mkdir(fixtureRoot, { recursive: true });
  const rawPath = path.join(fixtureRoot, "annual-report.html");
  await fs.writeFile(rawPath, plainHtmlTablesDocument(), "utf8");
  const {
    face_statement_manifests: _manifests,
    income_statement: _income,
    cash_flow: _cash,
    ...filingFacts
  } = clean.filings;
  const request = {
    schema_version: "filings-extraction-request/1.0",
    run_id: `packaged-html-tables-${name}`,
    documents: [{
      document_id: "annual-report",
      attachment_id: "annual-report",
      source_id: "annual_report",
      path: rawPath,
      media_type: "text/html",
      expected_sha256: createHash("sha256").update(await fs.readFile(rawPath)).digest("hex"),
    }],
    filing_facts: filingFacts,
  };
  const requestPath = path.join(fixtureRoot, "request.json");
  const out = path.join(fixtureRoot, "run");
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return { requestPath, responsePath: null, out };
}

async function runPackagedFilings(packageRoot, fixture, env) {
  return execute(process.execPath, [
    path.join(packageRoot, "scripts", "run_filings_pipeline.mjs"),
    fixture.requestPath,
    "--out", fixture.out,
    ...(fixture.responsePath ? ["--responses", fixture.responsePath] : []),
  ], {
    cwd: packageRoot,
    env,
    timeout: 180_000,
  });
}

try {
  const cleanEvidencePath = path.join(scratch, "source-owned-clean-evidence.json");
  const cleanEvidenceBuild = await execute(process.execPath, [
    path.join(HERE, "run_evidence_run_tests.mjs"),
    path.join(ROOT, "test-fixtures", "cases"),
    "--emit-clean", cleanEvidencePath,
  ], {
    cwd: ROOT,
    env: { ...process.env, EXCEL_INFLOW_PYTHON: python, PYTHON: python },
    timeout: 180_000,
  });
  check(
    cleanEvidenceBuild.code === 0,
    `source-owned clean-evidence fixture did not compile: ${cleanEvidenceBuild.stderr}`,
  );
  const cleanEvidenceBytes = await fs.readFile(cleanEvidencePath);
  const cleanEvidenceSha256 = assertRawCanaryEvidenceDigest(cleanEvidenceBytes);
  const cleanEvidence = JSON.parse(cleanEvidenceBytes.toString("utf8"));
  check(
    /^[a-f0-9]{64}$/.test(cleanEvidenceSha256) &&
      cleanEvidence.schema_version === "evidence-run/1.0" &&
      cleanEvidence.case_source?.identity?.case_id === "standard_net_cash",
    "source-owned clean-evidence fixture is not the bound neutral donor contract",
  );

  // Candidate-mode black-box testing must not pretend a dirty source package
  // is activation-ready. Build the exact current bytes from an isolated clean
  // Git snapshot so the later installed-slot proof is truthful.
  const cleanSource = path.join(scratch, "clean-source-snapshot");
  await fs.cp(ROOT, cleanSource, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git",
  });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Excel Inflow Test",
    GIT_AUTHOR_EMAIL: "excel-inflow-test@local.invalid",
    GIT_COMMITTER_NAME: "Excel Inflow Test",
    GIT_COMMITTER_EMAIL: "excel-inflow-test@local.invalid",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "sealed installed capability fixture"],
  ]) {
    const git = await execute("git", args, { cwd: cleanSource, env: gitEnv });
    check(git.code === 0, `clean source snapshot failed: git ${args[0]}: ${git.stderr}`);
  }
  const packageRoot = path.join(scratch, "compiled-package");
  const compiled = await execute(process.execPath, [
    path.join(cleanSource, "scripts", "compile_skill_release.mjs"),
    "--skill", cleanSource,
    "--out", packageRoot,
    "--development",
  ], {
    cwd: ROOT,
    env: { ...process.env, EXCEL_INFLOW_PYTHON: python, PYTHON: python },
    timeout: 180_000,
  });
  check(compiled.code === 0, `development package compile failed: ${compiled.stderr}`);
  check(
    await fs.stat(path.join(packageRoot, "release-manifest.json")).then(() => true, () => false),
    "compiled package omitted its release manifest",
  );
  check(
    await fs.stat(path.join(packageRoot, ".git")).then(() => false, () => true),
    "archive-only fixture illegally contains a source checkout",
  );
  const packageMembersBeforeDoctor = await packageMemberSet(packageRoot);

  const baseline = await runDoctor(packageRoot);
  check(
    baseline.code === 0 && baseline.report?.verdict === "HOST_READY",
    `archive-only mandatory filing capability did not close: code=${baseline.code}; ` +
      `blocking=${JSON.stringify(baseline.report?.refusal?.unsatisfied_preconditions ?? null)}; ` +
      `stderr=${baseline.stderr.slice(-2000)}`,
  );
  const capabilitySchema = JSON.parse(
    await fs.readFile(path.join(packageRoot, "assets", "installed-capability-receipt-v1.3.schema.json"), "utf8"),
  );
  const bootstrapRefusalSchema = JSON.parse(
    await fs.readFile(path.join(packageRoot, "assets", "runtime-bootstrap-refusal-v1.schema.json"), "utf8"),
  );
  const pointerSchema = JSON.parse(
    await fs.readFile(path.join(packageRoot, "assets", "host-preflight-pointer-v1.schema.json"), "utf8"),
  );
  const terminalReasonRegistry = JSON.parse(
    await fs.readFile(path.join(packageRoot, "assets", "terminal-reason-registry-v1.json"), "utf8"),
  );
  const isTypedBootstrapRefusal = (result, memberPath = null) =>
    result.code === 1 &&
    result.report?.schema_version === "excel-inflow-runtime-bootstrap-refusal/1.0" &&
    result.report?.verdict === "REFUSED" &&
    result.report?.reason_code === "INTERNAL.host_precondition_unsatisfied" &&
    result.report?.subordinate_execution_attempted === false &&
    validateJsonSchema(result.report, bootstrapRefusalSchema).length === 0 &&
    (memberPath === null || result.report.findings.some((finding) => finding.path === memberPath));
  check(
    baseline.receipt?.status === "HOST_READY" &&
      baseline.receipt?.schema_version === "excel-inflow-installed-capability-receipt/1.3" &&
      validateJsonSchema(baseline.receipt, capabilitySchema).length === 0,
    "archive-only full-lane capability receipt was not schema-valid HOST_READY",
  );
  const baselinePointer = JSON.parse(
    await fs.readFile(path.join(path.dirname(baseline.reportPath), "host-preflight-current.json"), "utf8"),
  );
  check(
    baselinePointer.status === "HOST_READY" &&
      validateJsonSchema(baselinePointer, pointerSchema).length === 0,
    "archive-only runtime doctor did not publish one schema-valid READY pointer",
  );
  const releaseManifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, "release-manifest.json"), "utf8"),
  );
  const filingsRuntimeManifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, "assets", "filings-runtime-members.json"), "utf8"),
  );
  check(
    Array.isArray(filingsRuntimeManifest.members) && filingsRuntimeManifest.members.length >= 15,
    "filings runtime membership became vacuous",
  );
  check(
    baseline.receipt.candidate_slot_ready === false &&
      baseline.receipt.production_promotion_eligible === false &&
      baseline.receipt.source_identity.deployment_status === "not_installed",
    "an uninstalled package falsely claimed candidate-slot readiness or production promotion",
  );
  const compiledCandidateInstall = await authorCandidateInstallState(
    packageRoot,
    `${packageRoot}.tar`,
    "compiled-candidate-install-state",
  );
  const inactiveCandidate = await runDoctor(packageRoot, {
    env: {
      ...process.env,
      EXCEL_INFLOW_INSTALL_STATE_ROOT: compiledCandidateInstall.stateRoot,
    },
  });
  check(
    inactiveCandidate.code === 0 && inactiveCandidate.receipt?.status === "HOST_READY" &&
      inactiveCandidate.receipt.candidate_slot_ready === (releaseManifest.sourceWorktreeDirty === false) &&
      inactiveCandidate.receipt.production_promotion_eligible === false,
    "inactive-slot readiness did not require clean source and installed identity, or falsely implied promotion",
  );
  const packageMembersAfterTwoDoctors = await packageMemberSet(packageRoot);
  check(
    JSON.stringify(packageMembersAfterTwoDoctors) === JSON.stringify(packageMembersBeforeDoctor) &&
      !packageMembersAfterTwoDoctors.some((member) =>
        member.includes("/__pycache__/") || member.endsWith(".pyc")),
    "two consecutive doctors mutated the immutable package or created Python bytecode caches",
  );
  check(
    installedCapabilityReceiptDigest(baseline.receipt) === baseline.receipt.receipt_sha256 &&
      createHash("sha256").update(baseline.reportBytes).digest("hex") ===
        baseline.receipt.runtime_doctor_sha256,
    "persisted capability receipt/report bytes were not cryptographically joined",
  );
  check(
    baseline.receipt.source_identity.closure_check_status === "match" &&
      baseline.receipt.source_identity.source_commit &&
      baseline.receipt.source_identity.source_tree &&
      baseline.receipt.source_identity.complete_package_inventory_sha256 &&
      baseline.receipt.node.executable_sha256 &&
      baseline.receipt.python.executable === python &&
      baseline.receipt.python.executable_sha256 &&
      baseline.receipt.workbook.soffice_executable &&
      baseline.receipt.workbook.soffice_executable_sha256 &&
      baseline.receipt.workbook.functional_capability?.status === "PASS" &&
      baseline.receipt.workbook.functional_capability?.output?.cached_result === 12.5 &&
      baseline.receipt.workbook.functional_capability?.cleanup?.profile_removed === true &&
      baseline.receipt.workbook.functional_capability?.cleanup?.workspace_removed === true &&
      baseline.receipt.workbook.functional_capability?.cleanup?.residue_paths?.length === 0 &&
      baseline.receipt.runtime_compatibility?.status === "PASS" &&
      baseline.receipt.runtime_compatibility?.total_violations === 0 &&
      baseline.receipt.runtime_compatibility?.findings?.length === 0 &&
      baseline.receipt.inline_xbrl?.status === "PASS" &&
      baseline.receipt.inline_xbrl?.lxml_worker_execution === "PASS" &&
      baseline.receipt.inline_xbrl?.scratch_removed === true &&
      baseline.receipt.inline_xbrl?.selected_python === python &&
      baseline.receipt.inline_xbrl?.selected_python_sha256 ===
        baseline.receipt.python.executable_sha256 &&
      [
        "fixture_sha256", "html_sha256", "worker_sha256", "result_schema_sha256",
        "result_sha256", "selected_python_sha256",
      ].every((field) => /^[a-f0-9]{64}$/.test(
        baseline.receipt.inline_xbrl?.[field] ?? "",
      )) &&
      Object.keys(
        baseline.receipt.inline_xbrl?.selected_non_dimensioned_authority ?? {},
      ).length === 2 &&
      Object.keys(
        baseline.receipt.inline_xbrl?.quarantined_dimensioned_fact?.dimensions ?? {},
      ).length === 1 &&
      ["fitz", "lxml", "openpyxl", "PIL", "numpy"].every(
        (moduleName) => baseline.receipt.python.per_module[moduleName] === true,
      ) &&
      baseline.receipt.process_spawn === "PASS",
    "capability receipt omitted package identity or one-interpreter full-lane closure",
  );
  const invalidFunctionalCapability = structuredClone(baseline.receipt);
  invalidFunctionalCapability.workbook.functional_capability.cleanup.profile_removed = false;
  check(
    validateJsonSchema(invalidFunctionalCapability, capabilitySchema).some(
      (error) => error.includes("profile_removed"),
    ),
    "the installed receipt schema admitted functional LibreOffice profile residue",
  );
  mutations.push("functional-libreoffice-profile-residue");
  const invalidRuntimeCompatibility = structuredClone(baseline.receipt);
  invalidRuntimeCompatibility.runtime_compatibility.total_violations = 1;
  check(
    validateJsonSchema(invalidRuntimeCompatibility, capabilitySchema).some(
      (error) => error.includes("total_violations"),
    ),
    "the installed receipt schema admitted a nonzero runtime compatibility violation",
  );
  mutations.push("runtime-compatibility-violation");
  const invalidInlineXbrlReceipt = structuredClone(baseline.receipt);
  delete invalidInlineXbrlReceipt.inline_xbrl.selected_non_dimensioned_authority;
  check(
    validateJsonSchema(invalidInlineXbrlReceipt, capabilitySchema).some(
      (error) => error.includes("selected_non_dimensioned_authority"),
    ),
    "the installed receipt schema admitted an Inline XBRL result without selected authority",
  );
  const folderOnly = await clonePackage(packageRoot, "folder-only-package");
  const folderOnlyResult = await runDoctor(folderOnly);
  check(
    folderOnlyResult.code === 0 && folderOnlyResult.receipt?.status === "HOST_READY" &&
      folderOnlyResult.receipt.candidate_slot_ready === false &&
      folderOnlyResult.receipt.production_promotion_eligible === false,
    "folder-only package did not preserve host-capability proof while refusing readiness/promotion",
  );
  check(
    folderOnlyResult.receipt.source_identity.complete_package_inventory_sha256 === null &&
      folderOnlyResult.receipt.source_identity.archive_sha256 === null &&
      folderOnlyResult.receipt.source_identity.release_package_attestation_sha256 === null,
    "folder-only package falsely claimed external whole-package custody",
  );
  const archivePath = `${packageRoot}.tar`;
  const attestationPath = `${packageRoot}.attestation.json`;
  check(
    await fs.stat(archivePath).then((entry) => entry.isFile(), () => false) &&
      await fs.stat(attestationPath).then((entry) => entry.isFile(), () => false),
    "compiler did not emit the actual archive and external attestation",
  );
  const unpackedPackage = path.join(scratch, "unpacked-archive-package");
  await fs.mkdir(unpackedPackage);
  const unpacked = await execute("tar", ["-xf", archivePath, "-C", unpackedPackage]);
  check(unpacked.code === 0, `actual package archive did not unpack: ${unpacked.stderr}`);
  await fs.copyFile(archivePath, `${unpackedPackage}.tar`);
  await fs.copyFile(attestationPath, `${unpackedPackage}.attestation.json`);
  const unpackedDoctor = await runDoctor(unpackedPackage);
  check(
    unpackedDoctor.code === 0 && unpackedDoctor.receipt?.status === "HOST_READY" &&
      unpackedDoctor.receipt.source_identity.archive_sha256 &&
      unpackedDoctor.receipt.source_identity.complete_package_inventory_sha256,
    "freshly unpacked actual archive did not retain whole-package capability custody",
  );

  // Execute the capability module from the actual unpacked archive, then
  // mutate only its bounded external probe inputs. This keeps package custody
  // intact while proving that the installed module itself catches byte drift,
  // a missing worker, a killed lease and incomplete cleanup.
  const installedInlineXbrlModuleUrl = pathToFileURL(path.join(
    unpackedPackage,
    "scripts",
    "lib",
    "installed_inline_xbrl_probe.mjs",
  )).href;
  const { runInstalledInlineXbrlProbe: runPackagedInlineXbrlProbe } = await import(
    `${installedInlineXbrlModuleUrl}?installed-capability-test=${Date.now()}`
  );
  const installedInlineXbrlScratch = path.join(scratch, "installed-inline-xbrl-probe");
  await fs.mkdir(installedInlineXbrlScratch);
  const installedInlineXbrlPositive = await runPackagedInlineXbrlProbe({
    skillRoot: unpackedPackage,
    selectedPython: python,
    tempRoot: installedInlineXbrlScratch,
  });
  check(
    installedInlineXbrlPositive.status === "PASS" &&
      installedInlineXbrlPositive.result_sha256 ===
        unpackedDoctor.receipt.inline_xbrl.result_sha256 &&
      installedInlineXbrlPositive.fixture_sha256 ===
        unpackedDoctor.receipt.inline_xbrl.fixture_sha256 &&
      installedInlineXbrlPositive.worker_sha256 ===
        unpackedDoctor.receipt.inline_xbrl.worker_sha256 &&
      installedInlineXbrlPositive.selected_python_sha256 ===
        unpackedDoctor.receipt.python.executable_sha256 &&
      installedInlineXbrlPositive.scratch_removed === true,
    "the installed archive's real Inline XBRL capability disagreed with the doctor receipt",
  );

  const packagedInlineFixturePath = path.join(
    unpackedPackage,
    "assets",
    "installed-inline-xbrl-capability-probe-v1.json",
  );
  const tamperedInlineFixture = JSON.parse(
    await fs.readFile(packagedInlineFixturePath, "utf8"),
  );
  tamperedInlineFixture.html = tamperedInlineFixture.html.replace(
    ">120</ix:nonFraction>",
    ">121</ix:nonFraction>",
  );
  const tamperedInlineFixturePath = path.join(
    installedInlineXbrlScratch,
    "tampered-inline-xbrl-fixture.json",
  );
  await fs.writeFile(
    tamperedInlineFixturePath,
    `${JSON.stringify(tamperedInlineFixture, null, 2)}\n`,
  );
  const installedInlineXbrlTamper = await runPackagedInlineXbrlProbe({
    skillRoot: unpackedPackage,
    selectedPython: python,
    tempRoot: installedInlineXbrlScratch,
    fixturePath: tamperedInlineFixturePath,
  });
  check(
    installedInlineXbrlTamper.status === "REFUSED" &&
      installedInlineXbrlTamper.reason_code === "INLINE_XBRL_PROBE_FIXTURE_HASH_MISMATCH" &&
      installedInlineXbrlTamper.scratch_removed === true,
    "the installed Inline XBRL probe admitted tampered frozen fixture bytes",
  );
  mutations.push("installed-inline-xbrl-fixture-tamper");

  const installedInlineXbrlMissing = await runPackagedInlineXbrlProbe({
    skillRoot: unpackedPackage,
    selectedPython: python,
    tempRoot: installedInlineXbrlScratch,
    workerPath: path.join(installedInlineXbrlScratch, "missing-inline-xbrl-worker.py"),
  });
  check(
    installedInlineXbrlMissing.status === "REFUSED" &&
      installedInlineXbrlMissing.reason_code === "INLINE_XBRL_PROBE_COMPONENT_MISSING" &&
      installedInlineXbrlMissing.scratch_removed === true,
    "the installed Inline XBRL probe admitted an absent worker",
  );
  mutations.push("installed-inline-xbrl-missing-worker");

  const sleepingInlineWorker = path.join(installedInlineXbrlScratch, "sleeping-worker.py");
  await fs.writeFile(sleepingInlineWorker, "import time\ntime.sleep(30)\n", "utf8");
  const installedInlineXbrlTimeout = await runPackagedInlineXbrlProbe({
    skillRoot: unpackedPackage,
    selectedPython: python,
    tempRoot: installedInlineXbrlScratch,
    workerPath: sleepingInlineWorker,
    timeoutMs: 50,
  });
  check(
    installedInlineXbrlTimeout.status === "REFUSED" &&
      installedInlineXbrlTimeout.reason_code === "INLINE_XBRL_PROBE_TIMEOUT" &&
      installedInlineXbrlTimeout.detail?.termination_verified === true &&
      installedInlineXbrlTimeout.detail?.survivor_pids?.length === 0 &&
      installedInlineXbrlTimeout.scratch_removed === true,
    "the installed Inline XBRL timeout was not killed, typed and cleaned",
  );
  mutations.push("installed-inline-xbrl-timeout");

  const installedInlineXbrlCleanup = await runPackagedInlineXbrlProbe({
    skillRoot: unpackedPackage,
    selectedPython: python,
    tempRoot: installedInlineXbrlScratch,
    removeScratch: async () => { throw new Error("injected installed cleanup failure"); },
  });
  check(
    installedInlineXbrlCleanup.status === "REFUSED" &&
      installedInlineXbrlCleanup.reason_code === "INLINE_XBRL_PROBE_CLEANUP_FAILED" &&
      installedInlineXbrlCleanup.scratch_removed === false,
    "the installed Inline XBRL probe rounded incomplete scratch cleanup into a pass",
  );
  mutations.push("installed-inline-xbrl-cleanup-failure");
  for (const entry of await fs.readdir(installedInlineXbrlScratch)) {
    if (entry.startsWith("excel-inflow-inline-xbrl-probe-")) {
      await fs.rm(path.join(installedInlineXbrlScratch, entry), { recursive: true, force: true });
    }
  }
  const emptyHome = path.join(scratch, "empty-home");
  const isolatedTemp = path.join(scratch, "archive-canary-temp");
  await fs.mkdir(emptyHome);
  await fs.mkdir(isolatedTemp);
  const soffice = unpackedDoctor.receipt.workbook.soffice_executable;
  const candidateInstall = await authorCandidateInstallState(
    unpackedPackage,
    `${unpackedPackage}.tar`,
    "unpacked-candidate-install-state",
  );
  const archiveEnv = {
    HOME: emptyHome,
    TMPDIR: isolatedTemp,
    PATH: [
      path.dirname(process.execPath),
      path.dirname(python),
      path.dirname(soffice),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
    EXCEL_INFLOW_NODE: process.execPath,
    EXCEL_INFLOW_PYTHON: python,
    PYTHON: python,
    SOFFICE_BIN: soffice,
    EXCEL_INFLOW_INSTALL_STATE_ROOT: candidateInstall.stateRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    LANG: "C.UTF-8",
  };

  // Run the same inline-XBRL reconciliation fixture as the source-level test
  // through the controller shipped inside the actual unpacked archive.  This
  // is deliberately distinct from the runtime doctor's PDF-only capability
  // probe: a PASS here proves that the packaged Python worker, crosswalk and
  // taxonomy are all reachable and that their output enters the packaged
  // filings bundle.
  const matchingInlineFacts = [
    { concept: "us-gaap:Revenues", values: [1000, 1000, 1000] },
    { concept: "us-gaap:DepreciationDepletionAndAmortization", values: [50, 50, 50] },
    { concept: "us-gaap:NetCashProvidedByUsedInOperatingActivities", values: [169, 169, 169] },
    // A segment-qualified observation must never become group-row authority.
    { concept: "us-gaap:Revenues", values: [400, 400, 400], dimensioned: true },
  ];
  const packagedInlineFixture = await authorInlineXbrlControllerInput({
    clean: cleanEvidence,
    name: "positive",
    factSpecs: matchingInlineFacts,
  });
  const packagedInline = await runPackagedFilings(
    unpackedPackage,
    packagedInlineFixture,
    archiveEnv,
  );
  if (packagedInline.code !== 0) {
    throw new Error(`packaged inline-XBRL pipeline failed (exit ${packagedInline.code}): ${packagedInline.stderr?.slice(-2000) || packagedInline.stdout?.slice(-2000)}`);
  }
  if (!existsSync(path.join(packagedInlineFixture.out, "filings-run-state.json"))) {
    throw new Error(`packaged inline-XBRL pipeline produced no filings-run-state.json (exit ${packagedInline.code}): ${packagedInline.stderr?.slice(-1500) || packagedInline.stdout?.slice(-1500)}`);
  }
  const packagedInlineState = JSON.parse(
    await fs.readFile(path.join(packagedInlineFixture.out, "filings-run-state.json"), "utf8"),
  );
  const packagedInlineArtifact = JSON.parse(
    await fs.readFile(packagedInlineState.artifacts.xbrl_reconciliation, "utf8"),
  );
  const packagedInlineArtifactSha256 = createHash("sha256")
    .update(await fs.readFile(packagedInlineState.artifacts.xbrl_reconciliation))
    .digest("hex");
  check(
    packagedInline.code === 0 &&
      packagedInlineState.pipeline_status === "PASS" &&
      packagedInlineArtifact.schema_version === "xbrl-reconciliation/1.0" &&
      packagedInlineArtifact.status === "PASS" &&
      packagedInlineArtifact.summary.inline_xbrl_document_count === 1 &&
      packagedInlineArtifact.summary.reconciled_row_count >= 3 &&
      packagedInlineArtifact.summary.material_mismatch_row_count === 0 &&
      packagedInlineState.artifact_sha256.xbrl_reconciliation ===
        packagedInlineArtifactSha256,
    `actual-archive inline-XBRL controller did not reconcile: ${packagedInline.stderr}`,
  );
  const packagedInlineBundle = JSON.parse(
    await fs.readFile(packagedInlineState.artifacts.filings_bundle, "utf8"),
  );
  const packagedRevenue = packagedInlineBundle.filings.income_statement.find(
    (row) => row.source_line_id === "is.revenue",
  );
  const packagedDa = packagedInlineBundle.filings.income_statement.find(
    (row) => row.source_line_id === "is.is_da_expense",
  );
  const packagedCfo = packagedInlineBundle.filings.cash_flow.find(
    (row) => row.source_line_id === "cf.cash_from_operations",
  );
  check(
    packagedRevenue?.xbrl?.status === "reconciled" &&
      packagedRevenue.xbrl.periods.every((period, index) =>
        period.status === "reconciled" &&
        period.concept === "us-gaap:Revenues" &&
        period.context_ref === `D${index}` &&
        period.unit_ref === "usd" &&
        period.decimals === "-6") &&
      packagedDa?.xbrl?.status === "reconciled" &&
      packagedDa.xbrl.periods.every((period) => period.sign_alignment === "inverted") &&
      packagedCfo?.xbrl?.status === "reconciled",
    "actual-archive inline-XBRL output did not carry group-context provenance and sign alignment",
  );

  // Logical red proof: the same packaged controller must surface a material
  // structured-fact/face-row contradiction as typed internal review work.
  const contradictingInlineFacts = structuredClone(matchingInlineFacts);
  contradictingInlineFacts[0] = {
    concept: "us-gaap:Revenues",
    values: [1000, 1000, 4321],
  };
  const packagedContradictionFixture = await authorInlineXbrlControllerInput({
    clean: cleanEvidence,
    name: "contradiction",
    factSpecs: contradictingInlineFacts,
  });
  const packagedContradiction = await runPackagedFilings(
    unpackedPackage,
    packagedContradictionFixture,
    archiveEnv,
  );
  const packagedContradictionState = JSON.parse(
    await fs.readFile(
      path.join(packagedContradictionFixture.out, "filings-run-state.json"),
      "utf8",
    ),
  );
  const contradictionFinding = packagedContradictionState.tasks?.[0]?.findings?.find(
    (finding) => finding.source_line_id === "is.revenue",
  );
  check(
    packagedContradiction.code !== 0 &&
      packagedContradictionState.pipeline_status === "NEEDS_EXTRACTION_REVIEW" &&
      packagedContradictionState.blocker_class === "INTERNAL_WORK" &&
      packagedContradictionState.user_blocking === false &&
      packagedContradictionState.tasks?.[0]?.task_kind ===
        "xbrl_face_reconciliation_review" &&
      contradictionFinding?.code === "XBRL_FACT_FACE_ROW_MISMATCH" &&
      contradictionFinding?.period === cleanEvidence.filings.historical_periods[2] &&
      contradictionFinding?.concept === "us-gaap:Revenues" &&
      contradictionFinding?.context_ref === "D2" &&
      contradictionFinding?.unit_ref === "usd" &&
      contradictionFinding?.decimals === "-6" &&
      contradictionFinding?.printed_value === 1000 &&
      contradictionFinding?.xbrl_value === 4321e6,
    "actual-archive inline-XBRL contradiction did not produce the typed red proof",
  );
  mutations.push("packaged-inline-xbrl-contradiction");

  // Physical red proof: execute the packaged controller after deleting only
  // its inline-XBRL worker.  The marker is still present in the same raw input,
  // so a false non-XBRL fast path cannot make this mutation pass.
  const missingInlineWorkerPackage = await clonePackage(
    unpackedPackage,
    "unpacked-inline-worker-missing",
  );
  await fs.rm(path.join(missingInlineWorkerPackage, "scripts", "extract_inline_xbrl.py"));
  const missingInlineWorkerFixture = await authorInlineXbrlControllerInput({
    clean: cleanEvidence,
    name: "worker-missing",
    factSpecs: matchingInlineFacts,
  });
  const missingInlineWorker = await runPackagedFilings(
    missingInlineWorkerPackage,
    missingInlineWorkerFixture,
    archiveEnv,
  );
  const missingInlineWorkerStateExists = await fs.stat(
    path.join(missingInlineWorkerFixture.out, "filings-run-state.json"),
  ).then(() => true, () => false);
  check(
    missingInlineWorker.code !== 0 &&
      missingInlineWorkerStateExists === false &&
      `${missingInlineWorker.stderr}\n${missingInlineWorker.stdout}`
        .includes("extract_inline_xbrl.py"),
    "deleting the packaged inline-XBRL worker did not break the exercised route",
  );
  mutations.push("packaged-inline-xbrl-worker-missing");

  // Packaged plain-HTML route proof: a filing whose printed <table> cells
  // carry NO Inline XBRL must flow through the packaged html-tables lane
  // (scripts/extract_html_tables.py) and land bound html-table-facts/1.0 fact
  // tables in the run state — while still failing closed into selected
  // face-statement adjudication, because a fallback lane extracts facts, it
  // never mints face-statement authority.
  const packagedHtmlFixture = await authorHtmlTablesControllerInput({
    clean: cleanEvidence,
    name: "positive",
  });
  const packagedHtml = await runPackagedFilings(
    unpackedPackage,
    packagedHtmlFixture,
    archiveEnv,
  );
  const packagedHtmlStateExists = await fs.stat(
    path.join(packagedHtmlFixture.out, "filings-run-state.json"),
  ).then(() => true, () => false);
  check(
    packagedHtml.code === 2 && packagedHtmlStateExists === true,
    `packaged html-tables route did not end in typed adjudication (exit ${packagedHtml.code}): ` +
      `${packagedHtml.stderr?.slice(-2000) || packagedHtml.stdout?.slice(-2000)}`,
  );
  const packagedHtmlState = JSON.parse(
    await fs.readFile(path.join(packagedHtmlFixture.out, "filings-run-state.json"), "utf8"),
  );
  check(
    packagedHtmlState.pipeline_status === "NEEDS_EXTRACTION_REVIEW" &&
      packagedHtmlState.blocker_class === "INTERNAL_WORK" &&
      packagedHtmlState.user_blocking === false &&
      packagedHtmlState.tasks?.[0]?.task_kind === "filing_extraction_adjudication" &&
      Array.isArray(packagedHtmlState.tasks[0].html_table_document_ids) &&
      packagedHtmlState.summary?.html_table_bound_count === 1 &&
      typeof packagedHtmlState.artifacts?.html_table_facts === "string",
    "packaged html-tables run state did not name the html_tables route",
  );
  const packagedHtmlFactFiles = await fs.readdir(packagedHtmlState.artifacts.html_table_facts);
  check(
    packagedHtmlFactFiles.length === 1 &&
      packagedHtmlFactFiles[0].endsWith(".html-table-facts.json"),
    "packaged html-tables route emitted no per-document fact table",
  );
  const packagedHtmlFacts = JSON.parse(await fs.readFile(
    path.join(packagedHtmlState.artifacts.html_table_facts, packagedHtmlFactFiles[0]),
    "utf8",
  ));
  check(
    packagedHtmlFacts.schema_version === "html-table-facts/1.0" &&
      packagedHtmlFacts.ixbrl_present === false &&
      packagedHtmlFacts.source_sha256 ===
        JSON.parse(await fs.readFile(packagedHtmlFixture.requestPath, "utf8"))
          .documents[0].expected_sha256 &&
      packagedHtmlFacts.fact_count >= 4 &&
      packagedHtmlFacts.facts.every((fact) => fact.provenance?.lane === "html_table_fallback") &&
      packagedHtmlFacts.facts.some((fact) => fact.period?.start && fact.period?.end),
    "packaged html-tables output is not source-bound html-table-facts/1.0 provenance",
  );
  mutations.push("packaged-html-tables-route");

  // Physical red proof: delete only the packaged html-tables worker. The
  // declared runtime closure must refuse to run at all — a typed failure
  // naming the missing member and no run state, never a silent fall-through
  // to PDF geometry or an unexplained crash.
  const missingHtmlWorkerPackage = await clonePackage(
    unpackedPackage,
    "unpacked-html-worker-missing",
  );
  await fs.rm(path.join(missingHtmlWorkerPackage, "scripts", "extract_html_tables.py"));
  const missingHtmlWorkerFixture = await authorHtmlTablesControllerInput({
    clean: cleanEvidence,
    name: "html-worker-missing",
  });
  const missingHtmlWorker = await runPackagedFilings(
    missingHtmlWorkerPackage,
    missingHtmlWorkerFixture,
    archiveEnv,
  );
  const missingHtmlWorkerStateExists = await fs.stat(
    path.join(missingHtmlWorkerFixture.out, "filings-run-state.json"),
  ).then(() => true, () => false);
  check(
    missingHtmlWorker.code !== 0 &&
      missingHtmlWorkerStateExists === false &&
      `${missingHtmlWorker.stderr}\n${missingHtmlWorker.stdout}`
        .includes("extract_html_tables.py"),
    "deleting the packaged html-tables worker did not break the exercised route",
  );
  mutations.push("packaged-html-tables-worker-missing");

  const rawCanary = await execute(process.execPath, [
    path.join(unpackedPackage, "scripts", "run_raw_input_black_box_canary.mjs"),
    cleanEvidencePath,
    python,
    soffice,
    "--broker-state", "explicit_skip",
  ], {
    cwd: unpackedPackage,
    timeout: 1_800_000,
    env: archiveEnv,
  });
  const archiveCanary = rawCanary.stdout.trim().startsWith("{")
    ? JSON.parse(rawCanary.stdout)
    : null;
  check(
    rawCanary.code === 0 && archiveCanary?.status === "PASS" &&
      archiveCanary.filings_lane_status === "PASS" &&
      archiveCanary.dcs_lane_status === "PASS" &&
      archiveCanary.branch_receipts?.stage4_started === true &&
      archiveCanary.branch_receipts?.delivery_attested === true &&
      archiveCanary.workbook_bytes > 0 && archiveCanary.economic_signature_sha256,
    `actual-archive raw-input canary did not deliver: ${rawCanary.stderr || rawCanary.stdout}`,
  );
  const filingsCheck = baseline.report.checks.find(
    (entry) => entry.precondition_id === "filings_extraction_probe",
  );
  check(
    filingsCheck?.result === "satisfied" &&
    filingsCheck.detail?.page_count === 2 &&
    filingsCheck.detail?.observed?.cash_flow?.required_rows?.["Change in working capital"]
      ?.value_states?.join(",") === "reported_zero,reported_dash,reported_blank",
    "archive-only probe did not prove real PDF semantics",
  );
  check(
    filingsCheck.detail?.request_sha256 &&
      filingsCheck.detail?.response_sha256 &&
      filingsCheck.detail?.filings_controller_sha256 &&
      filingsCheck.detail?.filings_state_sha256 &&
      filingsCheck.detail?.filings_bundle_sha256 &&
      filingsCheck.detail?.runtime_closure_sha256 &&
      filingsCheck.detail?.semantic_projection_sha256 &&
      filingsCheck.detail?.scratch_removed === true,
    "archive-only probe omitted request/response/semantic/cleanup custody",
  );

  const companyScreen = await execute(process.execPath, [
    path.join(packageRoot, "scripts", "run_excel_inflow_bootstrap.mjs"),
    "--screen", "company",
    ...companySessionArgs("archive-company"),
    "--python", python,
    ...(process.env.SOFFICE_BIN ? ["--soffice", process.env.SOFFICE_BIN] : []),
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      EXCEL_INFLOW_INSTALL_STATE_ROOT: compiledCandidateInstall.stateRoot,
      EXCEL_INFLOW_PYTHON: python,
      PYTHON: python,
    },
    timeout: 180_000,
  });
  check(
    companyScreen.code === 0 && companyScreen.stdout.includes("EXCEL INFLOW") &&
      companyScreen.stdout.includes("COMPANY") &&
      companyScreen.stdout.includes("CANDIDATE SLOT · NOT ACTIVE") &&
      companyScreen.stdout.includes("HOST READY · SESSION "),
    `archive-only top-level Company route did not pass: ${companyScreen.stderr}`,
  );
  const poisonedNodePath = path.join(scratch, "poison-node-path");
  await fs.mkdir(poisonedNodePath);
  await fs.writeFile(path.join(poisonedNodePath, "node"), "#!/bin/sh\nexit 98\n", { mode: 0o700 });
  const companyWithPoisonedPath = await execute(process.execPath, [
    path.join(packageRoot, "scripts", "run_excel_inflow_bootstrap.mjs"),
    "--screen", "company",
    ...companySessionArgs("poisoned-path"),
    "--python", python,
    ...(process.env.SOFFICE_BIN ? ["--soffice", process.env.SOFFICE_BIN] : []),
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PATH: `${poisonedNodePath}${path.delimiter}${process.env.PATH ?? ""}`,
      EXCEL_INFLOW_NODE: process.execPath,
      EXCEL_INFLOW_INSTALL_STATE_ROOT: compiledCandidateInstall.stateRoot,
      EXCEL_INFLOW_PYTHON: python,
      PYTHON: python,
    },
    timeout: 180_000,
  });
  check(
    companyWithPoisonedPath.code === 0 && companyWithPoisonedPath.stdout.includes("COMPANY"),
    "poisoned PATH replaced the sealed absolute Node handoff",
  );
  const deploymentProfile = JSON.parse(
    await fs.readFile(path.join(packageRoot, "assets", "deployment-profile.json"), "utf8"),
  );
  check(
    deploymentProfile.script_entry_points.includes("run_excel_inflow_bootstrap.mjs") &&
      !deploymentProfile.script_entry_points.includes("run_excel_inflow_vnext.mjs") &&
      !deploymentProfile.script_entry_points.includes("run_user_flow.mjs") &&
      deploymentProfile.script_private_roots?.includes("run_excel_inflow_vnext.mjs") &&
      deploymentProfile.script_private_roots?.includes("run_user_flow.mjs") &&
      (await fs.readFile(path.join(packageRoot, "scripts", "run_user_flow.mjs"), "utf8"))
        .includes("consumeControllerHandoff") &&
      (await fs.readFile(path.join(packageRoot, "scripts", "run_user_flow.mjs"), "utf8"))
        .includes("private top-controller capability handoff"),
    "the Company renderer is not bound as a private top-controller delegate",
  );
  const directScreen = await execute(process.execPath, [
    path.join(packageRoot, "scripts", "run_user_flow.mjs"), "--screen", "company",
  ], { cwd: packageRoot, env: { ...process.env, EXCEL_INFLOW_PYTHON: python, PYTHON: python } });
  check(
    directScreen.code !== 0 && !directScreen.stdout.includes("EXCEL INFLOW") &&
      !directScreen.stdout.includes("COMPANY"),
    "a secondary shipped entry point emitted Company without the top-level preflight",
  );

  const missingFixture = await clonePackage(packageRoot, "missing-fixture");
  await fs.rm(path.join(missingFixture, "assets", "installed-filings-capability-probe-v1.json"));
  const missingFixtureResult = await runDoctor(missingFixture);
  check(
    missingFixtureResult.code === 1 && missingFixtureResult.report?.verdict === "REFUSED" &&
      (
        missingFixtureResult.report?.checks?.find(
          (entry) => entry.precondition_id === "active_source_identity",
        )?.result === "unsatisfied" ||
        (
          missingFixtureResult.report?.schema_version ===
            "excel-inflow-runtime-bootstrap-refusal/1.0" &&
          missingFixtureResult.report?.reason_code ===
            "INTERNAL.host_precondition_unsatisfied" &&
          missingFixtureResult.report?.subordinate_execution_attempted === false
        )
      ),
    "deleting the frozen capability probe did not refuse at package integrity",
  );
  mutations.push("missing-fixture");

  const missingReleaseManifest = await clonePackage(packageRoot, "missing-release-manifest");
  await fs.rm(path.join(missingReleaseManifest, "release-manifest.json"));
  const missingReleaseResult = await runDoctor(missingReleaseManifest);
  check(
    missingReleaseResult.code === 1 &&
      missingReleaseResult.report?.schema_version ===
        "excel-inflow-runtime-bootstrap-refusal/1.0" &&
      missingReleaseResult.report?.findings?.some(
        (finding) => finding.path === "release-manifest.json",
      ),
    "an archive package missing release-manifest.json was mistaken for a source checkout",
  );
  mutations.push("missing-release-manifest");

  const unexpectedMember = await clonePackage(packageRoot, "unexpected-package-member");
  await fs.writeFile(
    path.join(unexpectedMember, "scripts", "stale-loader-copy.mjs"),
    "export const stale = true;\n",
  );
  const unexpectedMemberResult = await runDoctor(unexpectedMember);
  check(
    unexpectedMemberResult.code === 1 &&
      unexpectedMemberResult.report?.findings?.some(
        (finding) => finding.path === "scripts/stale-loader-copy.mjs" &&
          finding.issue === "unexpected_package_member",
      ),
    "an undeclared stale package file survived the bootstrap inventory boundary",
  );
  mutations.push("unexpected-package-member");

  const unexpectedSymlink = await clonePackage(packageRoot, "unexpected-package-symlink");
  await fs.symlink(
    "run_runtime_doctor.mjs",
    path.join(unexpectedSymlink, "scripts", "stale-loader-link.mjs"),
  );
  const unexpectedSymlinkResult = await runDoctor(unexpectedSymlink);
  check(
    unexpectedSymlinkResult.code === 1 &&
      unexpectedSymlinkResult.report?.findings?.some(
        (finding) => finding.path === "scripts/stale-loader-link.mjs" &&
          finding.issue === "unexpected_or_symlinked_package_member",
      ),
    "an undeclared package symlink survived the bootstrap inventory boundary",
  );
  mutations.push("unexpected-package-symlink");

  for (const relative of filingsRuntimeManifest.members) {
    const name = `missing-filings-runtime-member:${relative}`;
    const mutated = await clonePackage(
      packageRoot,
      name.replace(/[^A-Za-z0-9_.-]/g, "_"),
    );
    await fs.rm(path.join(mutated, relative));
    const result = await runDoctor(mutated);
    const probe = result.report?.checks?.find(
      (entry) => entry.precondition_id === "filings_extraction_probe",
    );
    const packageIdentity = result.report?.checks?.find(
      (entry) => entry.precondition_id === "active_source_identity",
    );
    check(result.code === 1 && result.report?.verdict === "REFUSED", `${name} did not refuse`);
    const bootstrapRefusal =
      result.report?.schema_version === "excel-inflow-runtime-bootstrap-refusal/1.0" &&
      result.report?.reason_code === "INTERNAL.host_precondition_unsatisfied" &&
      terminalReasonRegistry.reason_codes?.[result.report.reason_code]?.owner_layer ===
        "runtime_governance" &&
      validateJsonSchema(result.report, bootstrapRefusalSchema).length === 0 &&
      result.report?.subordinate_execution_attempted === false &&
      result.report?.findings?.some(
        (finding) => finding.path === relative &&
          ["missing", "absent_from_package_inventory"].includes(finding.issue),
      );
    check(
      bootstrapRefusal ||
        (packageIdentity?.result === "unsatisfied" &&
          probe?.detail?.subordinate_execution_attempted === false),
      `${name} did not refuse at package integrity before subordinate execution`,
    );
    if (bootstrapRefusal) {
      const refusalPointer = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(result.reportPath), "host-preflight-current.json"),
          "utf8",
        ),
      );
      check(
        refusalPointer.status === "REFUSED_BOOTSTRAP" &&
          validateJsonSchema(refusalPointer, pointerSchema).length === 0 &&
          createHash("sha256").update(result.reportBytes).digest("hex") ===
            refusalPointer.report_sha256,
        `${name} did not publish one schema-valid pointer to its typed refusal`,
      );
    }
    mutations.push(name);
  }

  const relocated = await clonePackage(packageRoot, "relocated-extractor");
  await fs.rename(
    path.join(relocated, "scripts", "extract_filing_statements.py"),
    path.join(relocated, "scripts", "extract_filing_statements.relocated.py"),
  );
  const relocationResult = await runDoctor(relocated);
  check(
    isTypedBootstrapRefusal(relocationResult, "scripts/extract_filing_statements.py"),
    "relocating the mandatory extractor did not refuse before execution",
  );
  mutations.push("relocated-extractor");

  const symlinked = await clonePackage(packageRoot, "symlinked-extractor");
  const symlinkTarget = path.join(symlinked, "scripts", "extract_filing_statements.real.py");
  await fs.rename(path.join(symlinked, "scripts", "extract_filing_statements.py"), symlinkTarget);
  await fs.symlink("extract_filing_statements.real.py", path.join(symlinked, "scripts", "extract_filing_statements.py"));
  const symlinkResult = await runDoctor(symlinked);
  check(
    isTypedBootstrapRefusal(symlinkResult, "scripts/extract_filing_statements.py"),
    "a symlinked mandatory extractor did not refuse",
  );
  mutations.push("symlinked-extractor");

  const nonExecutable = await clonePackage(packageRoot, "non-readable-extractor");
  await fs.chmod(path.join(nonExecutable, "scripts", "extract_filing_statements.py"), 0o000);
  const permissionResult = await runDoctor(nonExecutable);
  check(
    isTypedBootstrapRefusal(permissionResult, "scripts/extract_filing_statements.py"),
    "an unreadable mandatory extractor did not refuse",
  );
  mutations.push("extractor-permission");

  const drifted = await clonePackage(packageRoot, "drifted-extractor");
  await fs.appendFile(
    path.join(drifted, "scripts", "extract_filing_statements.py"),
    "\n# installed-package-drift-mutation\n",
    "utf8",
  );
  const driftResult = await runDoctor(drifted);
  const identityCheck = driftResult.report?.checks?.find(
    (entry) => entry.precondition_id === "active_source_identity",
  );
  check(
    isTypedBootstrapRefusal(driftResult, "scripts/extract_filing_statements.py") ||
      (driftResult.code === 1 && identityCheck?.result === "unsatisfied"),
    "installed byte drift did not invalidate HOST_READY",
  );
  mutations.push("installed-extractor-byte-drift");

  const wrongPython = await runDoctor(packageRoot, { selectedPython: process.execPath });
  const closureCheck = wrongPython.report?.checks?.find(
    (entry) => entry.precondition_id === "python_single_interpreter_lane_closure",
  );
  check(wrongPython.code === 1 && wrongPython.report?.verdict === "REFUSED", "wrong interpreter did not refuse");
  check(
    ["unknown", "unsatisfied"].includes(closureCheck?.result),
    "wrong interpreter was not owned by the one-interpreter closure",
  );
  mutations.push("wrong-interpreter");

  const importBlockRoot = path.join(scratch, "import-block");
  await fs.mkdir(importBlockRoot);
  await fs.writeFile(path.join(importBlockRoot, "sitecustomize.py"), [
    "import os, sys",
    "_blocked = os.environ.get('EXCEL_INFLOW_BLOCK_IMPORT')",
    "class _Blocker:",
    "    def find_spec(self, fullname, path=None, target=None):",
    "        if _blocked and fullname.split('.')[0] == _blocked:",
    "            raise ImportError('fault injection blocked ' + _blocked)",
    "        return None",
    "sys.meta_path.insert(0, _Blocker())",
    "",
  ].join("\n"), "utf8");
  for (const blockedModule of ["fitz", "lxml", "openpyxl"]) {
    const splitInterpreter = await runDoctor(packageRoot, {
      env: {
        ...process.env,
        PYTHONPATH: importBlockRoot,
        EXCEL_INFLOW_BLOCK_IMPORT: blockedModule,
      },
    });
    const splitClosure = splitInterpreter.report?.checks?.find(
      (entry) => entry.precondition_id === "python_single_interpreter_lane_closure",
    );
    check(
      splitInterpreter.code === 1 && splitClosure?.result !== "satisfied",
      `one-interpreter closure did not refuse when ${blockedModule} alone was unavailable: ` +
        `${JSON.stringify({ code: splitInterpreter.code, closure: splitClosure, stderr: splitInterpreter.stderr })}`,
    );
    mutations.push(`selected-python-missing-${blockedModule}`);
  }

  const runRootFile = path.join(scratch, "not-a-directory");
  await fs.writeFile(runRootFile, "not a directory", "utf8");
  const badRoot = await runDoctor(packageRoot, { runRoot: path.join(runRootFile, "child") });
  const rootCheck = badRoot.report?.checks?.find(
    (entry) => entry.precondition_id === "work_root_writable",
  );
  check(badRoot.code === 1 && rootCheck?.result === "unsatisfied", "invalid work root did not refuse before work");
  mutations.push("invalid-work-root");

  const tempRootFile = path.join(scratch, "not-a-temp-directory");
  await fs.writeFile(tempRootFile, "not a directory", "utf8");
  const badTemp = await runDoctor(packageRoot, { tempRoot: tempRootFile });
  const tempCheck = badTemp.report?.checks?.find(
    (entry) => entry.precondition_id === "temp_root_writable",
  );
  check(
    badTemp.code === 1 && tempCheck?.result === "unsatisfied",
    "invalid temp root did not refuse before the Company screen",
  );
  mutations.push("invalid-temp-root");

  const poisonBin = path.join(scratch, "poison-bin");
  await fs.mkdir(poisonBin);
  const poisonPython = path.join(poisonBin, "python3");
  await fs.writeFile(poisonPython, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const poisonedPath = await runDoctor(packageRoot, {
    selectedPython: python,
    env: { ...process.env, PATH: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  check(
    poisonedPath.code === 0 &&
    poisonedPath.report?.checks?.find((entry) => entry.precondition_id === "python_interpreter_custody")
      ?.detail?.resolved_executable === python,
    "a poisoned PATH replaced the exact selected interpreter",
  );
  mutations.push("poisoned-path");

  const insideSkillTarget = path.join(packageRoot, "assets");
  const outsideSymlink = path.join(scratch, "outside-run-root-link");
  await fs.symlink(insideSkillTarget, outsideSymlink);
  const symlinkRunRoot = await execute(process.execPath, [
    path.join(packageRoot, "scripts", "run_excel_inflow_bootstrap.mjs"),
    "--evidence-run", path.join(scratch, "not-read-before-root-guard.json"),
    "--out", outsideSymlink,
    "--python", python,
  ], { cwd: packageRoot, env: { ...process.env, EXCEL_INFLOW_PYTHON: python, PYTHON: python } });
  const symlinkRunRootRefusal = JSON.parse(symlinkRunRoot.stdout);
  check(
    symlinkRunRoot.code !== 0 &&
      symlinkRunRootRefusal.reason_code === "INTERNAL.runtime_bootstrap_failed" &&
      symlinkRunRootRefusal.earliest_responsible_layer === "runtime_bootstrap" &&
      symlinkRunRootRefusal.subordinate_execution_attempted === false,
    "an outside-named run-root symlink bypassed the canonical immutable-tree guard",
  );
  check(
    !(await fs.stat(path.join(insideSkillTarget, "host-preflight-current.json")).then(() => true, () => false)),
    "preflight wrote through a run-root symlink into immutable package bytes",
  );
  mutations.push("run-root-symlink-into-skill");

  const noDoctor = await clonePackage(packageRoot, "missing-doctor");
  await fs.rm(path.join(noDoctor, "scripts", "lib", "runtime_doctor.mjs"));
  const noDoctorScreen = await execute(process.execPath, [
    path.join(noDoctor, "scripts", "run_excel_inflow_bootstrap.mjs"),
    "--screen", "company",
    "--python", python,
  ], { cwd: noDoctor, env: { ...process.env, EXCEL_INFLOW_PYTHON: python, PYTHON: python } });
  check(noDoctorScreen.code !== 0, "a package missing its doctor still rendered a screen");
  check(
    !noDoctorScreen.stdout.includes("EXCEL INFLOW") && !noDoctorScreen.stdout.includes("COMPANY"),
    "a package missing its doctor fell back to the static Company screen",
  );
  mutations.push("missing-runtime-doctor");

  const changedAfterReceipt = await clonePackage(packageRoot, "changed-after-receipt");
  await fs.appendFile(
    path.join(changedAfterReceipt, "scripts", "extract_filing_statements.py"),
    "\n# post-receipt mutation\n",
    "utf8",
  );
  const staleHandoff = "a".repeat(64);
  const staleReceiptScreen = await execute(process.execPath, [
    path.join(changedAfterReceipt, "scripts", "run_user_flow.mjs"),
    "--screen", "company",
    "--controller-handoff", staleHandoff,
    "--host-capability-receipt", baseline.receiptPath,
    "--runtime-doctor-report", baseline.reportPath,
  ], {
    cwd: changedAfterReceipt,
    env: { ...process.env, EXCEL_INFLOW_TOP_CONTROLLER_HANDOFF: staleHandoff },
  });
  check(
    staleReceiptScreen.code !== 0 && !staleReceiptScreen.stdout.includes("EXCEL INFLOW") &&
      !staleReceiptScreen.stdout.includes("COMPANY"),
    "package bytes changed after receipt but the Company screen still rendered",
  );
  mutations.push("package-change-after-receipt");

  check(
    new Set(mutations).size === mutations.length &&
      JSON.stringify([...mutations].sort()) === JSON.stringify([
        ...EXPECTED_MUTATIONS_BASE,
        ...filingsRuntimeManifest.members.map((member) =>
          `missing-filings-runtime-member:${member}`),
      ].sort()),
    `mutation set drifted: ${JSON.stringify([...mutations].sort())}`,
  );
  check(checks >= 39, `test became vacuous: only ${checks} checks executed`);
  const result = {
    schema_version: "installed-filings-capability-test/1.0",
    status: "PASS",
    checks,
    mutations,
    archive_only: true,
    clean_evidence_sha256: cleanEvidenceSha256,
    packaged_inline_xbrl: {
      package_source: "actual_unpacked_archive",
      status: packagedInlineArtifact.status,
      reconciliation_sha256: packagedInlineArtifactSha256,
      inline_xbrl_document_count:
        packagedInlineArtifact.summary.inline_xbrl_document_count,
      reconciled_row_count: packagedInlineArtifact.summary.reconciled_row_count,
      material_mismatch_row_count:
        packagedInlineArtifact.summary.material_mismatch_row_count,
      contradiction_mutation_caught: true,
      missing_worker_mutation_caught: true,
    },
    total_violations: 0,
  };
  if (outputPath) await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (!process.env.IFC_KEEP_SCRATCH) await fs.rm(scratch, { recursive: true, force: true });
}
