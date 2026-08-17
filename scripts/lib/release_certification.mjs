import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { ECONOMIC_SOLVE_POLICY } from "./economic_solve_policy.mjs";
import { validateJsonSchema } from "./json_schema.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const TOLERANCE_POLICY = {
  currency_abs: 1e-6,
  ratio_abs: 1e-9,
  percentage_abs: 1e-10,
  control_abs: 0,
  default_abs: 1e-9,
  relative: 1e-12,
};
const DRIFT_CLASSES = ["currency", "ratio", "percentage", "control", "default"];
const REQUIRED_EVIDENCE = [
  "exact_maximal",
  "exact_net_cash",
  "native_excel",
  "visual_review",
  "frozen_cohort",
  "finance_proof_mutations",
  "source_parity",
];
const REQUIRED_PROFILES = ["standard_maximal", "standard_net_cash", "acquisition", "stressed_liquidity"];
const REQUIRED_SHEETS = ["Operating Model", "Brokers", "Forward Curves"];
const AUTHORITY = Object.freeze({
  "standard-maximal": Object.freeze({
    profile: "maximal",
    workbook_sha256: "02acdc52c8984d47adb5f7304a8c28147dd6424941140fa790259df4222b8df2",
    exact_replay_fingerprint_sha256: "ed1ada6db93d8c1b530c2aba96f59731cbbede2147200d6931daa474dbf93a18",
  }),
  "standard-net-cash": Object.freeze({
    profile: "net_cash",
    workbook_sha256: "df030788213d7d3cee24fb38e46866cf2cdf8e6bb2dc335e2d65255c832083e7",
    exact_replay_fingerprint_sha256: "409154d260466504ca165174f9cc644f3aec7ac19cf9e2c1d4ea9a9ed84bd814",
  }),
});

function assetSchema(name) {
  return JSON.parse(fsSync.readFileSync(new URL(`../../assets/${name}`, import.meta.url), "utf8"));
}

const MANIFEST_SCHEMA = assetSchema("release-certification-evidence-v1.schema.json");
const VISUAL_REVIEW_SCHEMA = assetSchema("release-visual-review-evidence-v1.schema.json");
const NATIVE_EXCEL_SCHEMA = assetSchema("native-excel-evidence-v3.schema.json");
const DESIGN_RUNTIME_V4 = assetSchema("standardised-design-runtime.v4.json");

for (const [caseName, expected] of Object.entries(AUTHORITY)) {
  const declared = DESIGN_RUNTIME_V4.profiles?.[expected.profile];
  if (declared?.immutable_authority_sha256 !== expected.workbook_sha256 ||
      declared?.exact_replay_fingerprint_sha256 !== expected.exact_replay_fingerprint_sha256) {
    throw new Error(`Certification authority identity ${caseName} has drifted from standardised-design-runtime.v4.json.`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const ECONOMIC_SOLVE_POLICY_SHA256 = canonicalSha256(ECONOMIC_SOLVE_POLICY);

function validDateTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function schemaFindings(schema, value, prefix, findings) {
  for (const message of validateJsonSchema(value, schema)) {
    findings.push(finding(`${prefix}.schema`, message));
  }
}

function resolvedBinding(record, root) {
  if (!record || typeof record.path !== "string") return record;
  return {
    ...record,
    path: path.isAbsolute(record.path) ? record.path : path.resolve(root, record.path),
  };
}

function validDrift(value) {
  return value && typeof value === "object" &&
    ["max_abs_by_class", "max_rel_by_class"].every((channel) =>
      value[channel] && DRIFT_CLASSES.every((name) =>
        Number.isFinite(value[channel][name]) && value[channel][name] >= 0));
}

export async function sha256File(filename) {
  return crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex");
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

function finding(id, message, detail = {}) {
  return { id, message, ...detail };
}

async function boundJson(root, entry, id, findings) {
  const record = typeof entry === "string" ? { path: entry } : entry;
  if (!record || typeof record.path !== "string" || !record.path.trim()) {
    findings.push(finding(`${id}.path`, "Evidence path is required."));
    return null;
  }
  const filename = path.isAbsolute(record.path)
    ? record.path
    : path.resolve(root, record.path);
  try {
    const digest = await sha256File(filename);
    if (!SHA256.test(String(record.sha256 ?? "")) || record.sha256 !== digest) {
      findings.push(finding(`${id}.sha256`, "Evidence manifest hash does not match the file.", {
        path: filename,
        expected: record.sha256 ?? null,
        actual: digest,
      }));
    }
    return { filename, sha256: digest, value: await readJson(filename) };
  } catch (error) {
    findings.push(finding(`${id}.read`, "Evidence file could not be read.", {
      path: filename,
      error: error.message,
    }));
    return null;
  }
}

async function verifyFileBinding(record, id, findings) {
  if (!record || typeof record.path !== "string" || !SHA256.test(String(record.sha256 ?? ""))) {
    findings.push(finding(id, "A path and lowercase SHA-256 binding are required."));
    return;
  }
  try {
    const actual = await sha256File(record.path);
    if (actual !== record.sha256) {
      findings.push(finding(id, "Bound file bytes do not match the recorded SHA-256.", {
        path: record.path,
        expected: record.sha256,
        actual,
      }));
    }
  } catch (error) {
    findings.push(finding(id, "Bound file is unavailable.", { path: record.path, error: error.message }));
  }
}

async function exactAuthority(report, reportPath, expectedCase, closureHash, prefix, findings, authorityHashes) {
  const expectedAuthority = authorityHashes[expectedCase];
  const reportRoot = path.dirname(reportPath);
  if (report.schema !== "render-evidence/2" || report.generated_by !== "scripts/render/check_render.py") {
    findings.push(finding(`${prefix}.producer`, "Authority replay must be the render-evidence/2 report emitted by scripts/render/check_render.py."));
  }
  if (report.verdict !== "PASS" || report.comparison_scope !== "exact_authority_replay") {
    findings.push(finding(prefix, "Exact authority replay must be PASS."));
  }
  if (report.case !== expectedCase || report.baseline_case !== expectedCase) {
    findings.push(finding(`${prefix}.case`, "Authority replay case and baseline identity are wrong."));
  }
  if (report.certified_closure_sha256 !== closureHash) {
    findings.push(finding(`${prefix}.closure`, "Authority replay is not bound to this closure."));
  }
  if (report.workbook_sha256 !== expectedAuthority?.workbook_sha256) {
    findings.push(finding(`${prefix}.authority_sha256`, "Authority replay workbook is not the immutable V4 authority.", {
      expected: expectedAuthority?.workbook_sha256 ?? null,
      actual: report.workbook_sha256 ?? null,
      exact_replay_fingerprint_sha256: expectedAuthority?.exact_replay_fingerprint_sha256 ?? null,
    }));
  }
  await verifyFileBinding(
    resolvedBinding({ path: report.workbook, sha256: report.workbook_sha256 }, reportRoot),
    `${prefix}.workbook`,
    findings,
  );
  const sheetNames = (report.sheets ?? []).map((sheet) => sheet.sheet ?? sheet.name);
  if (!Array.isArray(report.sheets) || report.sheets.length !== 3 ||
      JSON.stringify(sheetNames) !== JSON.stringify(REQUIRED_SHEETS) ||
      report.sheets.some((sheet) => sheet.verdict !== "PASS")) {
    findings.push(finding(`${prefix}.sheets`, "All three visible sheets must be present and PASS."));
  }
  for (const [sheetIndex, sheet] of (report.sheets ?? []).entries()) {
    if (sheet.visual_regression?.mode !== "compared" ||
        (sheet.visual_regression?.baselines_written ?? []).length !== 0 ||
        (sheet.visual_regression?.baselines_removed ?? []).length !== 0) {
      findings.push(finding(`${prefix}.sheet.${sheetIndex}.comparison`, "Certification must compare immutable baselines, never update them."));
    }
    if (!Array.isArray(sheet.rendered_pages) || sheet.rendered_pages.length === 0) {
      findings.push(finding(`${prefix}.sheet.${sheetIndex}.rendered_pages`, "Hash-bound rendered page evidence is required."));
    }
    for (const [pageIndex, page] of (sheet.rendered_pages ?? []).entries()) {
      await verifyFileBinding(resolvedBinding(page, reportRoot), `${prefix}.sheet.${sheetIndex}.page.${pageIndex}`, findings);
    }
    if (sheet.pdf_evidence) {
      await verifyFileBinding(resolvedBinding(sheet.pdf_evidence, reportRoot), `${prefix}.sheet.${sheetIndex}.pdf`, findings);
    }
  }
}

async function visualReview(report, reportPath, closureHash, findings) {
  schemaFindings(VISUAL_REVIEW_SCHEMA, report, "visual", findings);
  if (report.status !== "PASS" || Number(report.total_violations) !== 0) {
    findings.push(finding("visual.status", "Native visual review must be PASS with zero violations."));
  }
  if (report.certified_closure_sha256 !== closureHash) {
    findings.push(finding("visual.closure", "Visual review is not bound to this closure."));
  }
  if (!validDateTime(report.generated_at)) {
    findings.push(finding("visual.generated_at", "Visual-review generated_at must be an RFC 3339 date-time."));
  }
  const workbookProfiles = (report.workbooks ?? []).map((workbook) => workbook.profile);
  if (JSON.stringify(workbookProfiles) !== JSON.stringify(REQUIRED_PROFILES)) {
    findings.push(finding("visual.workbooks", "Exactly one reviewed workbook is required for each release profile, in canonical order."));
  }
  const reportRoot = path.dirname(reportPath);
  for (const [index, workbook] of (report.workbooks ?? []).entries()) {
    await verifyFileBinding(resolvedBinding(workbook, reportRoot), `visual.workbook.${index}`, findings);
  }
  const expectedScreenshotKeys = REQUIRED_PROFILES.flatMap((profile) =>
    REQUIRED_SHEETS.map((sheet) => `${profile}\u0000${sheet}`));
  const actualScreenshotKeys = (report.screenshot_evidence ?? []).map((record) => `${record.profile}\u0000${record.sheet}`);
  if (JSON.stringify(actualScreenshotKeys) !== JSON.stringify(expectedScreenshotKeys)) {
    findings.push(finding("visual.screenshots", "Exactly one screenshot of every visible sheet is required for every release profile, in canonical order."));
  }
  for (const [index, screenshot] of (report.screenshot_evidence ?? []).entries()) {
    await verifyFileBinding(resolvedBinding(screenshot, reportRoot), `visual.screenshot.${index}`, findings);
  }
  if (!report.checks || Object.values(report.checks).some((status) => status !== "PASS")) {
    findings.push(finding("visual.checks", "Every declared visual check must be PASS."));
  }
}

async function nativeExcel(report, reportPath, closureHash, findings) {
  schemaFindings(NATIVE_EXCEL_SCHEMA, report, "native_excel", findings);
  if (report.schema_version !== "native-excel-restoration-evidence/3.2" ||
      report.status !== "PASS" || report.diagnostic_only !== false ||
      report.certified_closure_sha256 !== closureHash ||
      Number(report.total_violations) !== 0 ||
      JSON.stringify(report.tolerance_policy) !== JSON.stringify(TOLERANCE_POLICY)) {
    findings.push(finding("native_excel", "Native evidence must be v3.2, closure-bound, non-diagnostic, zero-violation, metric-toleranced and all-cell error-scanned."));
  }
  if (!validDateTime(report.generated_at)) {
    findings.push(finding("native_excel.generated_at", "Native evidence generated_at must be an RFC 3339 date-time."));
  }
  if (report.economic_solve_policy_sha256 !== ECONOMIC_SOLVE_POLICY_SHA256) {
    findings.push(finding("native_excel.economic_solve_policy", "Native evidence is not bound to the current canonical economic-solve policy.", {
      expected: ECONOMIC_SOLVE_POLICY_SHA256,
      actual: report.economic_solve_policy_sha256 ?? null,
    }));
  }
  const hashBody = { ...report };
  delete hashBody.evidence_sha256;
  const actualEvidenceHash = canonicalSha256(hashBody);
  if (report.evidence_sha256 !== actualEvidenceHash) {
    findings.push(finding("native_excel.evidence_sha256", "Native evidence self-hash is missing or wrong."));
  }
  if (report.release_matrix?.status !== "PASS" || !Array.isArray(report.candidates) || report.candidates.length !== 2) {
    findings.push(finding("native_excel.matrix", "The exact two-candidate native restoration matrix must be PASS."));
  }
  const reportRoot = path.dirname(reportPath);
  const expectedProfiles = ["acquisition", "stressed_liquidity"];
  const expectedTests = {
    acquisition: [
      "native-excel-circularity-restoration-acquisition-case",
      "native-excel-acquisition-restoration",
    ],
    stressed_liquidity: [
      "native-excel-circularity-restoration-stressed-case",
      "native-excel-maturity-restoration",
    ],
  };
  const statePaths = new Set();
  for (const [candidateIndex, candidate] of (report.candidates ?? []).entries()) {
    const prefix = `native_excel.candidate.${candidateIndex}`;
    if (candidate.profile !== expectedProfiles[candidateIndex]) {
      findings.push(finding(`${prefix}.profile`, "Native candidate profile or order is wrong."));
    }
    for (const key of ["case_sha256", "workbook_sha256", "semantic_manifest_sha256", "row_map_sha256"]) {
      if (!SHA256.test(String(candidate[key] ?? ""))) {
        findings.push(finding(`${prefix}.${key}`, "Candidate binding hash is required."));
      }
    }
    if (!Array.isArray(candidate.tests) ||
        JSON.stringify(candidate.tests.map((test) => test.id)) !== JSON.stringify(expectedTests[candidate.profile] ?? [])) {
      findings.push(finding(`${prefix}.tests`, "The exact required restoration tests are required in order."));
    }
    for (const [testIndex, test] of (candidate.tests ?? []).entries()) {
      const testPrefix = `${prefix}.test.${testIndex}`;
      if (test.status !== "PASS" || JSON.stringify(test.tolerance_policy) !== JSON.stringify(TOLERANCE_POLICY) ||
          test.economic_solve_policy_sha256 !== ECONOMIC_SOLVE_POLICY_SHA256 ||
          !validDrift(test.max_observed_drift) || test.candidate_binding?.status !== "PASS" ||
          !validDrift(test.candidate_binding?.max_observed_drift) ||
          test.candidate_binding?.candidate_workbook_sha256 !== candidate.workbook_sha256 ||
          test.candidate_binding?.state_1_sha256 !== test.files?.[0]?.sha256 ||
          Number(test.candidate_binding?.numeric_difference_count) !== 0) {
        findings.push(finding(testPrefix, "Restoration test or candidate binding is incomplete or failed."));
      }
      if (!Array.isArray(test.files) || test.files.length !== 5) {
        findings.push(finding(`${testPrefix}.files`, "Exactly five hash-bound native state workbooks are required."));
      }
      for (const [fileIndex, file] of (test.files ?? []).entries()) {
        const absolute = file && typeof file.path === "string"
          ? path.resolve(reportRoot, file.path)
          : null;
        if (!absolute || (absolute !== reportRoot && !absolute.startsWith(`${reportRoot}${path.sep}`))) {
          findings.push(finding(`${testPrefix}.file.${fileIndex}.path`, "Native state evidence must remain under the evidence directory."));
          continue;
        }
        if (!Number.isInteger(file.worksheets_scanned) || file.worksheets_scanned <= 0 ||
            !Number.isInteger(file.used_cells_scanned) || file.used_cells_scanned <= 0 ||
            file.excel_error_count !== 0 || !Array.isArray(file.excel_error_cells) ||
            file.excel_error_cells.length !== 0) {
          findings.push(finding(
            `${testPrefix}.file.${fileIndex}.excel_error_scan`,
            "Every worksheet and serialized used cell must be scanned with zero native Excel error cells.",
          ));
        }
        if (statePaths.has(absolute)) {
          findings.push(finding(`${testPrefix}.file.${fileIndex}.duplicate`, "Each native restoration state must be a distinct evidence file."));
        }
        statePaths.add(absolute);
        const resolved = { ...file, path: absolute };
        await verifyFileBinding(resolved, `${testPrefix}.file.${fileIndex}`, findings);
      }
    }
  }
}

async function financeMutations(report, reportPath, closureHash, findings) {
  if (report.kind !== "independent_finance_proof_mutations" || report.status !== "PASS" ||
      Number(report.summary?.failed) !== 0 || Number(report.summary?.passed) <= 0) {
    findings.push(finding("finance_mutations.status", "Finance-proof mutations must reject every mutation."));
  }
  if (report.certified_closure_sha256 !== closureHash) {
    findings.push(finding("finance_mutations.closure", "Finance-proof mutations are not bound to this closure."));
  }
  const reportRoot = path.dirname(reportPath);
  const caseBinding = resolvedBinding({ path: report.case, sha256: report.case_sha256 }, reportRoot);
  const workbookBinding = resolvedBinding({ path: report.workbook, sha256: report.workbook_sha256 }, reportRoot);
  const rowMapBinding = resolvedBinding({
    path: report.row_map ?? `${report.workbook}.row-map.json`,
    sha256: report.row_map_sha256,
  }, reportRoot);
  await verifyFileBinding(caseBinding, "finance_mutations.case", findings);
  await verifyFileBinding(workbookBinding, "finance_mutations.workbook", findings);
  await verifyFileBinding(rowMapBinding, "finance_mutations.row_map", findings);
}

async function sourceParity(report, reportPath, closureHash, findings) {
  if (report.status !== "PASS" || report.ledger_applicable !== true ||
      report.coverage?.ledger_pass !== "ran" || Number(report.stats?.checked) <= 0 ||
      !Array.isArray(report.violations) || report.violations.length !== 0) {
    findings.push(finding("source_parity.status", "Applicable source-intent parity must be PASS, non-vacuous and violation-free."));
  }
  if (report.certified_closure_sha256 !== closureHash) {
    findings.push(finding("source_parity.closure", "Source-intent parity is not bound to this closure."));
  }
  const reportRoot = path.dirname(reportPath);
  for (const name of ["workbook", "row_map", "ledger"]) {
    await verifyFileBinding(resolvedBinding(report.bindings?.[name], reportRoot), `source_parity.${name}`, findings);
  }
}

function frozenCohort(report, closureHash, findings) {
  if (report.status !== "PASS" || report.mode !== "frozen_cohort_development" ||
      report.evidence_class !== "AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY" ||
      report.release_gate_status !== "NOT_EVALUATED" || Number(report.summary?.passed) !== 32 ||
      Number(report.summary?.failed ?? 0) !== 0 ||
      report.certified_closure_sha256 !== closureHash ||
      !report.development_scope?.not_claimed?.includes("release_readiness")) {
    findings.push(finding("frozen_cohort", "The clean 32-case report must be closure-bound and remain explicitly automated development evidence."));
  }
}

export async function validateReleaseCertificationEvidence({ manifestPath, closureHash, authorityHashes = AUTHORITY }) {
  const findings = [];
  const testOverrideRequested = authorityHashes !== AUTHORITY;
  if (testOverrideRequested && process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE !== "1") {
    findings.push(finding("authority.override", "Immutable V4 authority identities cannot be overridden outside the adversarial contract test."));
    authorityHashes = AUTHORITY;
  }
  if (!SHA256.test(String(closureHash ?? ""))) {
    return { status: "FAIL", total_violations: 1, findings: [finding("closure", "A lowercase SHA-256 closure hash is required.")] };
  }
  const absoluteManifest = path.resolve(manifestPath);
  const root = path.dirname(absoluteManifest);
  let manifest;
  try {
    manifest = await readJson(absoluteManifest);
  } catch (error) {
    return {
      schema_version: "release-certification-evidence-receipt/1.0",
      status: "FAIL",
      total_violations: 1,
      certified_closure_sha256: closureHash,
      manifest: { path: absoluteManifest, sha256: null },
      evidence: {},
      findings: [finding("manifest.read", "Certification-evidence manifest could not be read as JSON.", { error: error.message })],
    };
  }
  schemaFindings(MANIFEST_SCHEMA, manifest, "manifest", findings);
  if (manifest.certified_closure_sha256 !== closureHash) {
    findings.push(finding("manifest.closure", "Evidence manifest is not bound to the computed closure."));
  }
  const entries = {};
  for (const name of REQUIRED_EVIDENCE) {
    entries[name] = await boundJson(root, manifest.evidence?.[name], `evidence.${name}`, findings);
  }
  if (entries.exact_maximal) await exactAuthority(entries.exact_maximal.value, entries.exact_maximal.filename, "standard-maximal", closureHash, "authority.maximal", findings, authorityHashes);
  if (entries.exact_net_cash) await exactAuthority(entries.exact_net_cash.value, entries.exact_net_cash.filename, "standard-net-cash", closureHash, "authority.net_cash", findings, authorityHashes);
  if (entries.native_excel) await nativeExcel(entries.native_excel.value, entries.native_excel.filename, closureHash, findings);
  if (entries.visual_review) await visualReview(entries.visual_review.value, entries.visual_review.filename, closureHash, findings);
  if (entries.frozen_cohort) frozenCohort(entries.frozen_cohort.value, closureHash, findings);
  if (entries.finance_proof_mutations) await financeMutations(entries.finance_proof_mutations.value, entries.finance_proof_mutations.filename, closureHash, findings);
  if (entries.source_parity) await sourceParity(entries.source_parity.value, entries.source_parity.filename, closureHash, findings);
  return {
    schema_version: "release-certification-evidence-receipt/1.0",
    status: findings.length === 0 ? "PASS" : "FAIL",
    total_violations: findings.length,
    certified_closure_sha256: closureHash,
    manifest: { path: absoluteManifest, sha256: await sha256File(absoluteManifest) },
    evidence: Object.fromEntries(Object.entries(entries).filter(([, value]) => value).map(([name, value]) => [name, { path: value.filename, sha256: value.sha256 }])),
    findings,
  };
}
