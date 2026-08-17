#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ECONOMIC_SOLVE_POLICY } from "./lib/economic_solve_policy.mjs";
import { validateReleaseCertificationEvidence } from "./lib/release_certification.mjs";

process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE = "1";

const CLOSURE = "a".repeat(64);
const TOLERANCE_POLICY = {
  currency_abs: 1e-6,
  ratio_abs: 1e-9,
  percentage_abs: 1e-10,
  control_abs: 0,
  default_abs: 1e-9,
  relative: 1e-12,
};
const DRIFT = {
  max_abs_by_class: { currency: 0, ratio: 0, percentage: 0, control: 0, default: 0 },
  max_rel_by_class: { currency: 0, ratio: 0, percentage: 0, control: 0, default: 0 },
};
const PROFILES = ["standard_maximal", "standard_net_cash", "acquisition", "stressed_liquidity"];
const SHEETS = ["Operating Model", "Brokers", "Forward Curves"];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const POLICY_SHA256 = sha(JSON.stringify(canonical(ECONOMIC_SOLVE_POLICY)));
const writeJson = async (filename, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.writeFile(filename, bytes);
  return { path: filename, sha256: sha(bytes) };
};
const writeBlob = async (filename, value) => {
  const bytes = Buffer.from(value, "utf8");
  await fs.writeFile(filename, bytes);
  return { path: filename, sha256: sha(bytes) };
};

function nativeSelfHash(report) {
  const body = { ...report };
  delete body.evidence_sha256;
  report.evidence_sha256 = sha(JSON.stringify(canonical(body)));
}

async function fixture(root) {
  await fs.mkdir(root, { recursive: true });
  const maximalWorkbook = await writeBlob(path.join(root, "standard-maximal.xlsx"), "maximal authority");
  const netCashWorkbook = await writeBlob(path.join(root, "standard-net-cash.xlsx"), "net-cash authority");
  const caseFile = await writeBlob(path.join(root, "case.json"), "case");
  const financeWorkbook = await writeBlob(path.join(root, "finance.xlsx"), "finance");
  const financeRowMap = await writeBlob(`${financeWorkbook.path}.row-map.json`, "row map");
  const parityWorkbook = await writeBlob(path.join(root, "parity.xlsx"), "parity");
  const parityRowMap = await writeBlob(path.join(root, "parity.row-map.json"), "parity row map");
  const parityLedger = await writeBlob(path.join(root, "parity-ledger.json"), "parity ledger");
  const nativeCandidates = [];
  for (const [candidateIndex, profile] of ["acquisition", "stressed_liquidity"].entries()) {
    const workbookHash = sha(`native-workbook-${profile}`);
    const testIds = candidateIndex === 0
      ? [
        ["native-excel-circularity-restoration-acquisition-case", "circularity"],
        ["native-excel-acquisition-restoration", "acquisition"],
      ]
      : [
        ["native-excel-circularity-restoration-stressed-case", "circularity"],
        ["native-excel-maturity-restoration", "debt_maturities_roll"],
      ];
    const tests = [];
    for (const [testIndex, [id, controlId]] of testIds.entries()) {
      const files = [];
      for (let state = 1; state <= 5; state += 1) {
        const record = await writeBlob(
          path.join(root, `native-${profile}-${testIndex}-state-${state}.xlsx`),
          `${profile}:${testIndex}:${state}`,
        );
        files.push({ path: path.basename(record.path), sha256: record.sha256 });
      }
      const signature = sha(`${profile}:${testIndex}:signature`);
      tests.push({
        id,
        control_id: controlId,
        status: "PASS",
        control_cell: "Operating Model!$G$9",
        expected_sequence: [1, 0, 1, 0, 1],
        actual_sequence: [1, 0, 1, 0, 1],
        tolerance_policy: TOLERANCE_POLICY,
        economic_solve_policy_sha256: POLICY_SHA256,
        max_observed_drift: DRIFT,
        files,
        formula_cells_compared: 10,
        numeric_cells_compared: 10,
        on_restoration_difference_counts: [0, 0],
        off_restoration_difference_counts: [0],
        on_off_difference_count_excluding_control: 2,
        declared_effect_cells: 2,
        declared_effect_cells_present: 2,
        declared_effect_cells_changed: 2,
        declared_kill_switch_cells: controlId === "debt_maturities_roll" ? 0 : 2,
        declared_kill_switch_nonzero_on: controlId === "debt_maturities_roll" ? 0 : 2,
        declared_kill_switch_bad_off: 0,
        candidate_binding: {
          status: "PASS",
          candidate_workbook_sha256: workbookHash,
          state_1_sha256: files[0].sha256,
          candidate_formula_signature: signature,
          state_1_formula_signature: signature,
          candidate_structure_signature: signature,
          state_1_structure_signature: signature,
          formula_signature_match: true,
          structure_signature_match: true,
          sheet_order_match: true,
          calculation_settings_match: true,
          numeric_difference_count: 0,
          max_observed_drift: DRIFT,
          candidate_control_value: 1,
          state_1_control_value: 1,
          failures: [],
        },
        failures: [],
      });
    }
    nativeCandidates.push({
      profile,
      case_id: `case-${profile}`,
      case_sha256: sha(`case-${profile}`),
      workbook_sha256: workbookHash,
      semantic_manifest_sha256: sha(`semantic-${profile}`),
      row_map_sha256: sha(`row-map-${profile}`),
      candidate_snapshot: {
        sheet_names: SHEETS,
        calculation_settings: { calcMode: "auto", iterate: "true" },
        formula_signature: sha(`formula-${profile}`),
        numeric_signature: sha(`numeric-${profile}`),
        structure_signature: sha(`structure-${profile}`),
      },
      tests,
    });
  }

  const authority = async (name, caseName, workbook) => {
    const sheets = [];
    for (const sheetName of SHEETS) {
      const page = await writeBlob(
        path.join(root, `${name}-${sheetName.replaceAll(" ", "-")}.png`),
        `${name}:${sheetName}`,
      );
      sheets.push({
        sheet: sheetName,
        verdict: "PASS",
        visual_regression: { mode: "compared", baselines_written: [], baselines_removed: [] },
        rendered_pages: [page],
      });
    }
    return {
      schema: "render-evidence/2",
      generated_by: "scripts/render/check_render.py",
      verdict: "PASS",
      comparison_scope: "exact_authority_replay",
      case: caseName,
      baseline_case: caseName,
      certified_closure_sha256: CLOSURE,
      workbook: workbook.path,
      workbook_sha256: workbook.sha256,
      sheets,
    };
  };

  const nativeExcel = {
    schema_version: "native-excel-restoration-evidence/3.1",
    status: "PASS",
    diagnostic_only: false,
    application: "Microsoft Excel for Windows",
    method: "Native Excel F9, save, close and reopen restoration sequence.",
    generated_at: "2026-08-13T00:00:00Z",
    total_violations: 0,
    certified_closure_sha256: CLOSURE,
    tolerance_policy: TOLERANCE_POLICY,
    economic_solve_policy_sha256: POLICY_SHA256,
    release_matrix: {
      status: "PASS",
      required_test_ids: nativeCandidates.flatMap((candidate) => candidate.tests.map((test) => test.id)),
      actual_test_ids: nativeCandidates.flatMap((candidate) => candidate.tests.map((test) => test.id)),
      candidate_profiles: ["acquisition", "stressed_liquidity"],
    },
    candidates: nativeCandidates,
  };
  nativeSelfHash(nativeExcel);

  const visualWorkbooks = [];
  const screenshots = [];
  for (const profile of PROFILES) {
    const workbook = await writeBlob(path.join(root, `visual-${profile}.xlsx`), `visual:${profile}`);
    visualWorkbooks.push({ profile, ...workbook, sheet_names: SHEETS });
    for (const sheet of SHEETS) {
      const screenshot = await writeBlob(
        path.join(root, `visual-${profile}-${sheet.replaceAll(" ", "-")}.png`),
        `visual:${profile}:${sheet}`,
      );
      screenshots.push({ profile, sheet, ...screenshot });
    }
  }

  const reports = {
    exact_maximal: await authority("maximal", "standard-maximal", maximalWorkbook),
    exact_net_cash: await authority("net-cash", "standard-net-cash", netCashWorkbook),
    native_excel: nativeExcel,
    visual_review: {
      schema_version: "release-visual-review-evidence/1.0",
      status: "PASS",
      generated_at: "2026-08-13T00:00:00Z",
      reviewer: "Release certification fixture",
      method: "Native Microsoft Excel review of every visible sheet.",
      total_violations: 0,
      certified_closure_sha256: CLOSURE,
      reviewed_profiles: PROFILES,
      workbooks: visualWorkbooks,
      screenshot_evidence: screenshots,
      checks: {
        workbook_openability: "PASS",
        sheet_completeness: "PASS",
        layout_geometry: "PASS",
        formatting_consistency: "PASS",
        formula_visibility: "PASS",
        provenance_colours: "PASS",
        print_and_panes: "PASS",
        screenshot_legibility: "PASS",
      },
    },
    frozen_cohort: {
      status: "PASS",
      mode: "frozen_cohort_development",
      evidence_class: "AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY",
      release_gate_status: "NOT_EVALUATED",
      certified_closure_sha256: CLOSURE,
      summary: { passed: 32, failed: 0 },
      development_scope: { not_claimed: ["release_readiness"] },
    },
    finance_proof_mutations: {
      kind: "independent_finance_proof_mutations",
      status: "PASS",
      certified_closure_sha256: CLOSURE,
      summary: { passed: 5, failed: 0 },
      case: caseFile.path,
      case_sha256: caseFile.sha256,
      workbook: financeWorkbook.path,
      workbook_sha256: financeWorkbook.sha256,
      row_map: financeRowMap.path,
      row_map_sha256: financeRowMap.sha256,
    },
    source_parity: {
      status: "PASS",
      certified_closure_sha256: CLOSURE,
      ledger_applicable: true,
      coverage: { ledger_pass: "ran" },
      stats: { checked: 4 },
      violations: [],
      bindings: { workbook: parityWorkbook, row_map: parityRowMap, ledger: parityLedger },
    },
  };

  const evidence = {};
  for (const [name, report] of Object.entries(reports)) {
    evidence[name] = await writeJson(path.join(root, `${name}.json`), report);
  }
  const manifestPath = path.join(root, "certification-evidence.json");
  await writeJson(manifestPath, {
    schema_version: "release-certification-evidence/1.0",
    certified_closure_sha256: CLOSURE,
    evidence,
  });
  const authorityHashes = {
    "standard-maximal": { workbook_sha256: maximalWorkbook.sha256, exact_replay_fingerprint_sha256: sha("maximal-fingerprint") },
    "standard-net-cash": { workbook_sha256: netCashWorkbook.sha256, exact_replay_fingerprint_sha256: sha("net-cash-fingerprint") },
  };
  return { manifestPath, reports, evidence, authorityHashes, screenshots };
}

async function rewriteEvidence(data, name) {
  data.evidence[name] = await writeJson(data.evidence[name].path, data.reports[name]);
  const manifest = JSON.parse(await fs.readFile(data.manifestPath, "utf8"));
  manifest.evidence[name] = data.evidence[name];
  await writeJson(data.manifestPath, manifest);
}

async function expectFailure(root, mutate, expectedId, { useDefaultAuthorities = false } = {}) {
  const data = await fixture(root);
  await mutate(data);
  const result = await validateReleaseCertificationEvidence({
    manifestPath: data.manifestPath,
    closureHash: CLOSURE,
    ...(useDefaultAuthorities ? {} : { authorityHashes: data.authorityHashes }),
  });
  assert.equal(result.status, "FAIL");
  assert(result.findings.some((item) => item.id.includes(expectedId)), JSON.stringify(result.findings));
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dmu-release-cert-contract-"));
let tests = 0;
try {
  const valid = await fixture(path.join(root, "valid"));
  const pass = await validateReleaseCertificationEvidence({
    manifestPath: valid.manifestPath,
    closureHash: CLOSURE,
    authorityHashes: valid.authorityHashes,
  });
  assert.equal(pass.status, "PASS", JSON.stringify(pass.findings));
  tests += 1;

  delete process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE;
  const deniedOverride = await validateReleaseCertificationEvidence({
    manifestPath: valid.manifestPath,
    closureHash: CLOSURE,
    authorityHashes: valid.authorityHashes,
  });
  assert.equal(deniedOverride.status, "FAIL");
  assert(deniedOverride.findings.some((item) => item.id === "authority.override"));
  process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE = "1";
  tests += 1;

  const mutation = async (name, edit, expectedId, options) => {
    await expectFailure(path.join(root, name), edit, expectedId, options);
    tests += 1;
  };
  await mutation("v4-authority-required", async () => {}, "authority.maximal.authority_sha256", { useDefaultAuthorities: true });
  await mutation("manifest-string-binding", async ({ manifestPath }) => {
    const value = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    value.evidence.exact_maximal = value.evidence.exact_maximal.path;
    await writeJson(manifestPath, value);
  }, "manifest.schema");
  await mutation("manifest-extra-key", async ({ manifestPath }) => {
    const value = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    value.unreviewed_escape_hatch = true;
    await writeJson(manifestPath, value);
  }, "manifest.schema");
  await mutation("manifest-wrong-closure", async ({ manifestPath }) => {
    const value = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    value.certified_closure_sha256 = "b".repeat(64);
    await writeJson(manifestPath, value);
  }, "manifest.closure");
  await mutation("native-schema-missing-application", async (data) => {
    delete data.reports.native_excel.application;
    nativeSelfHash(data.reports.native_excel);
    await rewriteEvidence(data, "native_excel");
  }, "native_excel.schema");
  await mutation("native-policy-mismatch", async (data) => {
    data.reports.native_excel.economic_solve_policy_sha256 = "b".repeat(64);
    nativeSelfHash(data.reports.native_excel);
    await rewriteEvidence(data, "native_excel");
  }, "native_excel.economic_solve_policy");
  await mutation("native-self-hash", async (data) => {
    data.reports.native_excel.method = "Tampered after signing";
    await rewriteEvidence(data, "native_excel");
  }, "native_excel.evidence_sha256");
  await mutation("native-test-policy-mismatch", async (data) => {
    data.reports.native_excel.candidates[0].tests[0].economic_solve_policy_sha256 = "b".repeat(64);
    nativeSelfHash(data.reports.native_excel);
    await rewriteEvidence(data, "native_excel");
  }, "native_excel.candidate.0.test.0");
  await mutation("native-duplicate-state", async (data) => {
    const first = data.reports.native_excel.candidates[0].tests[0].files[0];
    data.reports.native_excel.candidates[0].tests[1].files[1] = { ...first };
    nativeSelfHash(data.reports.native_excel);
    await rewriteEvidence(data, "native_excel");
  }, "duplicate");
  for (const [name, reportName, expectedId] of [
    ["cohort-closure", "frozen_cohort", "frozen_cohort"],
    ["finance-closure", "finance_proof_mutations", "finance_mutations.closure"],
    ["parity-closure", "source_parity", "source_parity.closure"],
  ]) {
    await mutation(name, async (data) => {
      data.reports[reportName].certified_closure_sha256 = "b".repeat(64);
      await rewriteEvidence(data, reportName);
    }, expectedId);
  }
  await mutation("authority-producer", async (data) => {
    data.reports.exact_maximal.generated_by = "untrusted-renderer";
    await rewriteEvidence(data, "exact_maximal");
  }, "authority.maximal.producer");
  await mutation("authority-sheet-coverage", async (data) => {
    data.reports.exact_net_cash.sheets[2].sheet = "Hidden Substitute";
    await rewriteEvidence(data, "exact_net_cash");
  }, "authority.net_cash.sheets");
  await mutation("visual-missing-profile", async (data) => {
    data.reports.visual_review.workbooks.pop();
    await rewriteEvidence(data, "visual_review");
  }, "visual.workbooks");
  await mutation("visual-duplicate-screenshot", async (data) => {
    data.reports.visual_review.screenshot_evidence[11] = { ...data.reports.visual_review.screenshot_evidence[0] };
    await rewriteEvidence(data, "visual_review");
  }, "visual.screenshots");
  await mutation("visual-extra-check", async (data) => {
    data.reports.visual_review.checks.unspecified_manual_check = "PASS";
    await rewriteEvidence(data, "visual_review");
  }, "visual.schema");
  await mutation("tampered-screenshot", async ({ screenshots }) => {
    await fs.appendFile(screenshots[0].path, "tamper", "utf8");
  }, "visual.screenshot.0");
  await mutation("malformed-manifest", async ({ manifestPath }) => {
    await fs.writeFile(manifestPath, "{not json", "utf8");
  }, "manifest.read");

  console.log(JSON.stringify({ status: "PASS", tests }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
