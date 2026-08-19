import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { ECONOMIC_SOLVE_POLICY } from "./economic_solve_policy.mjs";
import {
  CERTIFICATION_TIER_CONTRACT,
  EXCLUDED_NATIVE_HOST,
  NATIVE_CERTIFIED_PACKAGE_MODE,
  PERMANENT_DECLARED_EXCLUSION,
  PHYSICAL_LANE_TERMINAL_DECLARATION,
  PORTABLE_CERTIFIED_PACKAGE_MODE,
  assertCertifiedPackageMode,
} from "./identity_vocabulary.mjs";
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

/**
 * P8.0 — the certification evidence set, split by what a host can produce.
 *
 * NATIVE tier (`certified`): REQUIRED_EVIDENCE, unchanged in membership and in
 * order. Every class is required, every existing check on every class is
 * applied exactly as before. Nothing below relaxes it.
 *
 * PORTABLE tier (`portable_certified`): PORTABLE_REQUIRED_EVIDENCE — the five
 * classes a portable host can actually produce — plus a MANDATORY declared
 * exclusion for each of PERMANENTLY_EXCLUDED_EVIDENCE. The excluded classes are
 * not omitted, not waived and not queued: the portable dossier must name them,
 * with a reason, as permanent. A portable dossier that stays silent about them
 * is refused just as firmly as one that claims them.
 */
export const PORTABLE_REQUIRED_EVIDENCE = Object.freeze([
  "exact_maximal",
  "exact_net_cash",
  "frozen_cohort",
  "finance_proof_mutations",
  "source_parity",
]);

/**
 * The exclusion register. Machine-readable and reason-carrying, in the same
 * idiom as release_journal.mjs's EXCLUDED_INSTALLED_HOST clauses and
 * assets/release-rollback-policy-v1.json: `satisfiability`,
 * `exclusion_reason`, `excluded_from_portable_gate: true`.
 *
 * Three fields exist purely so this can never be read as an unfinished task:
 * `exclusion_disposition` is PERMANENT_DECLARED_EXCLUSION rather than any
 * pending spelling, `is_pending` is literally false, and `revisit_condition` is
 * null — there is no condition under which the class becomes satisfiable here.
 * `portable_substitute` records what the portable tier proves INSTEAD, so the
 * weaker claim is legible rather than merely smaller.
 */
export const PERMANENTLY_EXCLUDED_EVIDENCE = Object.freeze({
  native_excel: Object.freeze({
    evidence_class: "native_excel",
    satisfiability: EXCLUDED_NATIVE_HOST,
    exclusion_disposition: PERMANENT_DECLARED_EXCLUSION,
    excluded_from_portable_gate: true,
    is_pending: false,
    is_waiver: false,
    revisit_condition: null,
    required_host_capability:
      "A licensed native Microsoft Excel installation able to open, recalculate and re-serialise the release workbooks.",
    exclusion_reason:
      "Native-Excel restoration evidence requires opening the candidate workbooks in a licensed native Microsoft Excel installation and reading back its own recalculated bytes. This programme has no such host, by standing directive, and native recalculation cannot be simulated by any portable renderer without the evidence ceasing to be native. The class is therefore unsatisfiable here by construction rather than merely unfinished.",
    portable_substitute:
      "The portable tier proves exact authority replay of the immutable V4 workbooks through the render-evidence/2 producer, the frozen 32-case cohort, the independent finance-proof mutation set and source-intent parity — all bound to the same runtime-code closure. That is a different and strictly weaker claim than native recalculation and is reported as such.",
  }),
  visual_review: Object.freeze({
    evidence_class: "visual_review",
    satisfiability: EXCLUDED_NATIVE_HOST,
    exclusion_disposition: PERMANENT_DECLARED_EXCLUSION,
    excluded_from_portable_gate: true,
    is_pending: false,
    is_waiver: false,
    revisit_condition: null,
    required_host_capability:
      "A human reviewer inspecting every visible sheet of every release profile inside native Microsoft Excel.",
    exclusion_reason:
      "Native visual review is a human judgement made in front of a native Microsoft Excel window: openability, layout geometry, formatting consistency, formula visibility, provenance colours, print setup and screenshot legibility as that application renders them. There is no reviewer and no native host in this programme, and an automated portable check of the same properties would be a different assertion wearing the same name.",
    portable_substitute:
      "The portable tier compares immutable rendered-page baselines for all three visible sheets through scripts/render/check_render.py in comparison-only mode, never writing or removing a baseline. That detects rendered-geometry drift; it does not constitute a human review in native Excel.",
  }),
});

const REQUIRED_EVIDENCE = [
  "exact_maximal",
  "exact_net_cash",
  "native_excel",
  "visual_review",
  "frozen_cohort",
  "finance_proof_mutations",
  "source_parity",
];

export const NATIVE_REQUIRED_EVIDENCE = Object.freeze([...REQUIRED_EVIDENCE]);
export const PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION =
  "release-certification-evidence-portable/1.0";
const EXCLUSION_RECORD_FIELDS = Object.freeze([
  "evidence_class",
  "satisfiability",
  "exclusion_disposition",
  "excluded_from_portable_gate",
  "is_pending",
  "is_waiver",
  "revisit_condition",
  "required_host_capability",
  "exclusion_reason",
]);

// The split must exhaust the native set and never overlap it: a class is either
// producible on a portable host or permanently excluded, never both and never
// neither. Checked at load so the two lists cannot drift apart silently.
{
  const excluded = Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE);
  const union = [...PORTABLE_REQUIRED_EVIDENCE, ...excluded].sort();
  if (JSON.stringify(union) !== JSON.stringify([...REQUIRED_EVIDENCE].sort())) {
    throw new Error(
      "Certification evidence split has drifted: portable-required plus permanently-excluded must be exactly the native required-evidence set.",
    );
  }
  for (const [name, record] of Object.entries(PERMANENTLY_EXCLUDED_EVIDENCE)) {
    if (record.evidence_class !== name || record.satisfiability !== EXCLUDED_NATIVE_HOST ||
        record.exclusion_disposition !== PERMANENT_DECLARED_EXCLUSION ||
        record.excluded_from_portable_gate !== true || record.is_pending !== false ||
        record.is_waiver !== false || record.revisit_condition !== null ||
        typeof record.exclusion_reason !== "string" || record.exclusion_reason.trim().length < 40) {
      throw new Error(`Permanent exclusion register entry ${name} is not a well-formed permanent declared exclusion.`);
    }
  }
  const declared = [...PHYSICAL_LANE_TERMINAL_DECLARATION.excluded_evidence_classes].sort();
  if (JSON.stringify(declared) !== JSON.stringify([...excluded].sort())) {
    throw new Error(
      "The physical-lane terminal declaration and the certification exclusion register name different evidence classes.",
    );
  }
}
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

/**
 * The PORTABLE dossier manifest contract, declared in CODE.
 *
 * assets/release-certification-evidence-v1.schema.json is the NATIVE manifest
 * shape: it requires all seven evidence classes and forbids extra keys, so it
 * can neither describe a portable dossier nor be widened without weakening the
 * native gate. Rather than relax that asset, the portable shape is declared
 * here — the same discipline release_journal.mjs uses for its clause contract —
 * and enforced with the same refuse-never-repair posture. P8.7 should mint the
 * matching JSON schema asset; until then this function IS the schema.
 */
function portableManifestFindings(manifest, findings) {
  if (manifest.schema_version !== PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION) {
    findings.push(finding("manifest.portable.schema_version",
      `A portable dossier must declare schema_version ${PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION}.`,
      { actual: manifest.schema_version ?? null }));
  }
  // A portable dossier must announce its own tier, and must never announce the
  // native one. This is the dossier-level half of the rule that a portable
  // certification is never presentable as a native certification.
  if (manifest.certification_tier !== PORTABLE_CERTIFIED_PACKAGE_MODE) {
    findings.push(finding("manifest.portable.certification_tier",
      `A portable dossier must declare certification_tier ${PORTABLE_CERTIFIED_PACKAGE_MODE}.`,
      { actual: manifest.certification_tier ?? null }));
  }
  if (manifest.package_mode !== PORTABLE_CERTIFIED_PACKAGE_MODE) {
    findings.push(finding("manifest.portable.native_claim",
      `A portable dossier must declare package_mode ${PORTABLE_CERTIFIED_PACKAGE_MODE}; a portable-certified package may never claim the ${NATIVE_CERTIFIED_PACKAGE_MODE} mode, whose evidence set it does not hold.`,
      { actual: manifest.package_mode ?? null }));
  } else {
    try {
      assertCertifiedPackageMode(manifest.package_mode, "portable dossier package_mode");
    } catch (error) {
      findings.push(finding("manifest.portable.package_mode", error.message));
    }
  }
  for (const key of Object.keys(manifest)) {
    if (![
      "schema_version", "certification_tier", "package_mode", "evidence",
      "declared_exclusions", "certified_runtime_code_closure_sha256", "certified_closure_sha256",
    ].includes(key)) {
      findings.push(finding("manifest.portable.unknown_key", `Portable dossier key ${JSON.stringify(key)} is not part of the declared contract.`));
    }
  }

  const evidence = manifest.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    findings.push(finding("manifest.portable.evidence", "A portable dossier requires an evidence object."));
  } else {
    for (const name of Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE)) {
      if (name in evidence) {
        findings.push(finding(`manifest.portable.excluded_presented_as_satisfied.${name}`,
          `Evidence class ${name} is a permanent declared exclusion and must never appear as satisfied evidence in a portable dossier.`,
          { satisfiability: EXCLUDED_NATIVE_HOST }));
      }
    }
    for (const name of PORTABLE_REQUIRED_EVIDENCE) {
      if (!(name in evidence)) {
        findings.push(finding(`manifest.portable.required_missing.${name}`,
          `Portable-required evidence class ${name} is absent; the portable gate set is not optional.`));
      }
    }
    for (const name of Object.keys(evidence)) {
      if (!PORTABLE_REQUIRED_EVIDENCE.includes(name) && !(name in PERMANENTLY_EXCLUDED_EVIDENCE)) {
        findings.push(finding(`manifest.portable.unknown_evidence.${name}`,
          `Evidence class ${JSON.stringify(name)} is not a declared certification evidence class.`));
      }
    }
  }

  const exclusions = manifest.declared_exclusions;
  if (!exclusions || typeof exclusions !== "object" || Array.isArray(exclusions)) {
    findings.push(finding("manifest.portable.declared_exclusions",
      "A portable dossier must DECLARE its permanent exclusions; silence about an excluded evidence class is refused."));
    return;
  }
  for (const name of Object.keys(exclusions)) {
    if (!(name in PERMANENTLY_EXCLUDED_EVIDENCE)) {
      findings.push(finding(`manifest.portable.undeclared_exclusion.${name}`,
        `Evidence class ${JSON.stringify(name)} is not a permanently excluded class and may not be declared as one.`));
    }
  }
  for (const [name, expected] of Object.entries(PERMANENTLY_EXCLUDED_EVIDENCE)) {
    const record = exclusions[name];
    const prefix = `exclusion.${name}`;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      findings.push(finding(prefix, `Evidence class ${name} is permanently excluded and the dossier must declare it, with a reason.`));
      continue;
    }
    for (const key of Object.keys(record)) {
      if (!EXCLUSION_RECORD_FIELDS.includes(key)) {
        findings.push(finding(`${prefix}.unknown_field`, `Exclusion record field ${JSON.stringify(key)} is not part of the declared contract.`));
      }
    }
    for (const key of ["evidence_class", "satisfiability", "required_host_capability"]) {
      if (record[key] !== expected[key]) {
        findings.push(finding(`${prefix}.${key}`, `Exclusion ${key} must equal the code-declared register value.`,
          { expected: expected[key], actual: record[key] ?? null }));
      }
    }
    // An exclusion is PERMANENT. Every spelling of "still to do" is refused
    // here: a pending disposition, is_pending true, a revisit condition, or a
    // waiver. This is the check that makes a declared exclusion impossible to
    // mistake for an unfinished task.
    if (record.exclusion_disposition !== PERMANENT_DECLARED_EXCLUSION) {
      findings.push(finding(`${prefix}.disposition`,
        `Excluded evidence class ${name} must be declared ${PERMANENT_DECLARED_EXCLUSION}; it is a permanent exclusion, not a pending item and not a deferral.`,
        { expected: PERMANENT_DECLARED_EXCLUSION, actual: record.exclusion_disposition ?? null }));
    }
    if (record.is_pending !== false) {
      findings.push(finding(`${prefix}.is_pending`,
        `Excluded evidence class ${name} must carry is_pending: false; nothing is queued to produce it.`,
        { actual: record.is_pending ?? null }));
    }
    if (record.revisit_condition !== null) {
      findings.push(finding(`${prefix}.revisit_condition`,
        `Excluded evidence class ${name} must carry revisit_condition: null; there is no condition under which this host becomes able to produce it.`,
        { actual: record.revisit_condition }));
    }
    if (record.is_waiver !== false) {
      findings.push(finding(`${prefix}.is_waiver`,
        `Excluded evidence class ${name} must carry is_waiver: false; a declared exclusion is a statement about host capability, never permission to skip a reachable check.`,
        { actual: record.is_waiver ?? null }));
    }
    if (record.excluded_from_portable_gate !== true) {
      findings.push(finding(`${prefix}.excluded_from_portable_gate`,
        `Excluded evidence class ${name} must carry excluded_from_portable_gate: true; an excluded class is never counted as a portable-gate pass.`,
        { actual: record.excluded_from_portable_gate ?? null }));
    }
    if (typeof record.exclusion_reason !== "string" || record.exclusion_reason.trim().length < 40) {
      findings.push(finding(`${prefix}.exclusion_reason`,
        `Excluded evidence class ${name} must state which host capability is missing in exclusion_reason.`));
    }
  }
}

export async function validateReleaseCertificationEvidence({
  manifestPath,
  runtimeCodeClosureSha256 = null,
  // P8.0 — which certification tier this dossier is being validated AS.
  // Defaults to the NATIVE tier so every existing caller keeps exactly its
  // current, unrelaxed behaviour.
  certificationTier = NATIVE_CERTIFIED_PACKAGE_MODE,
  // Compatibility input for evidence schema v1. New callers must use the
  // identity-specific name so this proof cannot be mistaken for complete
  // package, archive or installed-package certification.
  closureHash = null,
  authorityHashes = AUTHORITY,
}) {
  const findings = [];
  const tierContract = CERTIFICATION_TIER_CONTRACT[
    assertCertifiedPackageMode(certificationTier, "certification tier")
  ];
  const portable = certificationTier === PORTABLE_CERTIFIED_PACKAGE_MODE;
  const requiredEvidence = portable ? PORTABLE_REQUIRED_EVIDENCE : REQUIRED_EVIDENCE;
  const runtimeCodeClosureHash = runtimeCodeClosureSha256 ?? closureHash;
  const testOverrideRequested = authorityHashes !== AUTHORITY;
  if (testOverrideRequested && process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE !== "1") {
    findings.push(finding("authority.override", "Immutable V4 authority identities cannot be overridden outside the adversarial contract test."));
    authorityHashes = AUTHORITY;
  }
  if (!SHA256.test(String(runtimeCodeClosureHash ?? ""))) {
    return { status: "FAIL", total_violations: 1, certification_tier: tierContract.tier, findings: [finding("runtime_code_closure", "A lowercase SHA-256 runtime-code closure identity is required.")] };
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
      certification_tier: tierContract.tier,
      package_mode: tierContract.package_mode,
      certified_runtime_code_closure_sha256: runtimeCodeClosureHash,
      certified_closure_sha256: runtimeCodeClosureHash,
      manifest: { path: absoluteManifest, sha256: null },
      evidence: {},
      findings: [finding("manifest.read", "Certification-evidence manifest could not be read as JSON.", { error: error.message })],
    };
  }
  if (portable) {
    portableManifestFindings(manifest, findings);
  } else {
    schemaFindings(MANIFEST_SCHEMA, manifest, "manifest", findings);
    // A portable dossier fed to the NATIVE gate is refused by name, in addition
    // to the schema refusal it already earns. The native tier claims the
    // native-host evidence classes outright; a manifest that declares
    // exclusions or a portable tier is asserting the opposite.
    if (manifest.declared_exclusions !== undefined ||
        manifest.certification_tier !== undefined ||
        manifest.package_mode !== undefined) {
      findings.push(finding("manifest.native.portable_dossier",
        `A dossier that declares a certification tier, a package mode or permanent exclusions is a portable dossier and can never satisfy ${NATIVE_CERTIFIED_PACKAGE_MODE} certification, which requires the native-Excel and visual-review evidence classes as satisfied evidence.`,
        {
          certification_tier: manifest.certification_tier ?? null,
          package_mode: manifest.package_mode ?? null,
          declared_exclusions: manifest.declared_exclusions === undefined
            ? null
            : Object.keys(manifest.declared_exclusions ?? {}),
        }));
    }
  }
  const manifestRuntimeCodeClosure =
    manifest.certified_runtime_code_closure_sha256 ?? manifest.certified_closure_sha256;
  if (manifestRuntimeCodeClosure !== runtimeCodeClosureHash) {
    findings.push(finding("manifest.closure", "Evidence manifest is not bound to the computed runtime-code closure."));
  }
  const entries = {};
  for (const name of requiredEvidence) {
    entries[name] = await boundJson(root, manifest.evidence?.[name], `evidence.${name}`, findings);
  }
  if (entries.exact_maximal) await exactAuthority(entries.exact_maximal.value, entries.exact_maximal.filename, "standard-maximal", runtimeCodeClosureHash, "authority.maximal", findings, authorityHashes);
  if (entries.exact_net_cash) await exactAuthority(entries.exact_net_cash.value, entries.exact_net_cash.filename, "standard-net-cash", runtimeCodeClosureHash, "authority.net_cash", findings, authorityHashes);
  if (entries.native_excel) await nativeExcel(entries.native_excel.value, entries.native_excel.filename, runtimeCodeClosureHash, findings);
  if (entries.visual_review) await visualReview(entries.visual_review.value, entries.visual_review.filename, runtimeCodeClosureHash, findings);
  if (entries.frozen_cohort) frozenCohort(entries.frozen_cohort.value, runtimeCodeClosureHash, findings);
  if (entries.finance_proof_mutations) await financeMutations(entries.finance_proof_mutations.value, entries.finance_proof_mutations.filename, runtimeCodeClosureHash, findings);
  if (entries.source_parity) await sourceParity(entries.source_parity.value, entries.source_parity.filename, runtimeCodeClosureHash, findings);
  return {
    schema_version: "release-certification-evidence-receipt/1.0",
    status: findings.length === 0 ? "PASS" : "FAIL",
    total_violations: findings.length,
    // The receipt says which tier it certifies and, for the portable tier, which
    // classes were never in scope — so a portable receipt read out of context
    // cannot be mistaken for a native one.
    certification_tier: tierContract.tier,
    package_mode: tierContract.package_mode,
    claims_native_host_evidence: tierContract.claims_native_host_evidence,
    required_evidence: [...requiredEvidence],
    declared_exclusions: portable
      ? Object.fromEntries(Object.entries(PERMANENTLY_EXCLUDED_EVIDENCE).map(([name, record]) => [name, {
        satisfiability: record.satisfiability,
        exclusion_disposition: record.exclusion_disposition,
        excluded_from_portable_gate: record.excluded_from_portable_gate,
        is_pending: record.is_pending,
        is_waiver: record.is_waiver,
        revisit_condition: record.revisit_condition,
        exclusion_reason: record.exclusion_reason,
      }]))
      : null,
    physical_lane_terminal_declaration: portable ? PHYSICAL_LANE_TERMINAL_DECLARATION : null,
    certified_runtime_code_closure_sha256: runtimeCodeClosureHash,
    certified_closure_sha256: runtimeCodeClosureHash,
    manifest: { path: absoluteManifest, sha256: await sha256File(absoluteManifest) },
    evidence: Object.fromEntries(Object.entries(entries).filter(([, value]) => value).map(([name, value]) => [name, { path: value.filename, sha256: value.sha256 }])),
    findings,
  };
}
