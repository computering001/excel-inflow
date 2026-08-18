#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import { REVIEW_MODES, REVIEW_SECTIONS, validateLocalWorkbookReview } from "./lib/local_workbook_review.mjs";
import { inspectWorkbookSemantics } from "./lib/workbook_semantic_inventory.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const record = async (filename, root) => {
  const bytes = await fs.readFile(filename);
  return { path: path.relative(root, filename), sha256: digest(bytes), bytes: bytes.length };
};
const writeJson = async (filename, value) => fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);

function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>
<sheet name="Operating Model" sheetId="1" r:id="rId1"/>
<sheet name="Brokers" sheetId="2" r:id="rId2"/>
<sheet name="Forward Curves" sheetId="3" r:id="rId3"/>
</sheets><definedNames><definedName name="Operating_Area">'Operating Model'!$A$1:$B$3</definedName></definedNames></workbook>`;
}

function workbookRels({ external = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}">
<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="${REL_NS}/styles" Target="styles.xml"/>
${external ? `<Relationship Id="rId5" Type="${REL_NS}/externalLinkPath" Target="https://example.invalid/stale.xlsx" TargetMode="External"/>` : ""}
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS}">
<fonts count="2"><font><color rgb="FF000000"/></font><font><color rgb="FF0000FF"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/></patternFill></fill></fills>
<borders count="1"><border/></borders><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" numFmtId="0"/><xf fontId="1" fillId="1" borderId="0" numFmtId="0"><alignment indent="1"/></xf></cellXfs>
</styleSheet>`;
}

function operatingSheet({ hiddenHardcode = false, outsideFormula = false, showFormulas = false } = {}) {
  const hidden = hiddenHardcode ? `<c r="A3"><v>77</v></c>` : `<c r="A3"><f>A2</f><v>2</v></c>`;
  const outside = outsideFormula ? `<row r="4"><c r="C4"><f>A2</f><v>2</v></c></row>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}">
<dimension ref="A1:B3"/><sheetViews><sheetView workbookViewId="0"${showFormulas ? ' showFormulas="1"' : ""}/></sheetViews>
<sheetData><row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Operating Model</t></is></c></row>
<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>A2</f><v>2</v></c></row>
<row r="3" hidden="1">${hidden}</row>${outside}</sheetData>
<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
<dataValidations count="1"><dataValidation type="decimal" sqref="A2"><formula1>0</formula1><formula2>10</formula2></dataValidation></dataValidations>
</worksheet>`;
}

function supportSheet(title, showFormulas = false) {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><dimension ref="A1:A1"/><sheetViews><sheetView workbookViewId="0"${showFormulas ? ' showFormulas="1"' : ""}/></sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${title}</t></is></c></row></sheetData></worksheet>`;
}

async function workbook(filename, options = {}, formulaView = false) {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", workbookXml());
  zip.file("xl/_rels/workbook.xml.rels", workbookRels(options));
  zip.file("xl/styles.xml", stylesXml());
  zip.file("xl/worksheets/sheet1.xml", operatingSheet({ ...options, showFormulas: formulaView }));
  zip.file("xl/worksheets/sheet2.xml", supportSheet("Brokers", formulaView));
  zip.file("xl/worksheets/sheet3.xml", supportSheet("Forward Curves", formulaView));
  await fs.writeFile(filename, await zip.generateAsync({ type: "nodebuffer" }));
}

async function buildEvidence(root, options = {}) {
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, "model.xlsx");
  const derivative = path.join(root, "model.show-formulas-review.xlsx");
  await workbook(source, options, false);
  await workbook(derivative, options, true);
  const sourceRecord = await record(source, root);
  const derivativeRecord = await record(derivative, root);
  const inventory = await inspectWorkbookSemantics(source);
  const inventoryPath = path.join(root, "semantic-inventory.json");
  await writeJson(inventoryPath, inventory);
  const modes = [];
  const pagesByMode = new Map();
  for (const mode of REVIEW_MODES) {
    const expectedWorkbookSha = mode === "values" ? sourceRecord.sha256 : derivativeRecord.sha256;
    const sheets = [];
    const pages = [];
    for (const [index, sheet] of ["Operating Model", "Brokers", "Forward Curves"].entries()) {
      const pagePath = path.join(root, `${mode}-${index + 1}.png`);
      await fs.writeFile(pagePath, Buffer.from(`${mode}:${sheet}:rendered-page`));
      const page = await record(pagePath, root);
      sheets.push({ sheet, verdict: "PASS", page_count: 1, rendered_pages: [page] });
      pages.push({ id: `${mode}:${sheet}:1`, sheet, page_index: 1, ...page });
    }
    const report = {
      schema: "render-evidence/2",
      verdict: "PASS",
      comparison_scope: "structural_company_run",
      workbook_sha256: expectedWorkbookSha,
      sheets_examined: ["Operating Model", "Brokers", "Forward Curves"],
      sheets,
      page_count_total: 3,
    };
    const reportPath = path.join(root, `${mode}.render-evidence.json`);
    await writeJson(reportPath, report);
    modes.push({
      mode,
      workbook_sha256: expectedWorkbookSha,
      render_report: await record(reportPath, root),
      visible_sheets: ["Operating Model", "Brokers", "Forward Curves"],
      pages,
    });
    pagesByMode.set(mode, pages);
  }
  const checklist = REVIEW_MODES.flatMap((mode) => REVIEW_SECTIONS.map((section) => {
    const pages = pagesByMode.get(mode);
    return {
      mode,
      section,
      status: "PASS",
      review_class: "AUTOMATED_LOCAL",
      evidence_page_ids: pages.filter((page) => section === "broker_sheets" ? page.sheet !== "Operating Model" : page.sheet === "Operating Model").map((page) => page.id),
      checks: { render_complete: "PASS", semantic_inventory_bound: "PASS", section_evidence_bound: "PASS" },
    };
  }));
  const evidence = {
    schema_version: "local-workbook-review-evidence/1.0",
    status: "PASS",
    evidence_class: "AUTOMATED_LOCAL_REVIEW_ONLY",
    gate_scope: "PORTABLE_NON_NATIVE_PHASE_13",
    total_violations: 0,
    attested_workbook: sourceRecord,
    semantic_inventory: { ...(await record(inventoryPath, root)), inventory_schema_version: "workbook-semantic-inventory/1.0" },
    show_formulas_derivative: {
      ...derivativeRecord,
      source_workbook_sha256: sourceRecord.sha256,
      purpose: "LOCAL_SHOW_FORMULAS_REVIEW_COPY",
      delivery_eligible: false,
      transformation: "SET_SHOW_FORMULAS_ON_EVERY_VISIBLE_SHEET_ONLY",
    },
    modes,
    checklist,
    summary: { required_checks: 24, passed_checks: 24, visible_sheet_count: 3, rendered_page_count: 6 },
    human_visual_review: { status: "NOT_PERFORMED", claimed_as_pass: false },
    native_excel_review: { status: "NOT_PERFORMED", claimed_as_pass: false },
  };
  const evidencePath = path.join(root, "local-workbook-review-evidence.json");
  await writeJson(evidencePath, evidence);
  return { evidence, evidencePath, root, source, derivative };
}

async function rewrite(data) {
  await writeJson(data.evidencePath, data.evidence);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-local-review-"));
try {
  const clean = await buildEvidence(path.join(root, "clean"));
  const cleanResult = await validateLocalWorkbookReview(clean.evidencePath);
  assert.equal(cleanResult.status, "PASS", JSON.stringify(cleanResult.findings, null, 2));
  assert.equal(cleanResult.checklist_items_checked, 24);
  assert.equal(cleanResult.human_visual_review, "NOT_PERFORMED");
  assert.equal(cleanResult.native_excel_review, "NOT_PERFORMED");

  const producerRuns = [];
  const sourceBeforeProducer = digest(await fs.readFile(clean.source));
  for (const suffix of ["a", "b"]) {
    const producerOut = path.join(root, `producer-${suffix}`);
    const completed = spawnSync(
      process.env.PYTHON ?? "python3",
      ["scripts/prepare_local_workbook_review.py", clean.source, "--out", producerOut, "--derivative-only"],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    assert.equal(completed.status, 3, completed.stderr || completed.stdout);
    const diagnostic = JSON.parse(completed.stdout);
    assert.equal(diagnostic.status, "BLOCKED");
    assert.equal(diagnostic.reason, "DERIVATIVE_ONLY_NO_RENDER_OR_REVIEW_CLAIM");
    assert.equal(diagnostic.delivery_eligible, false);
    producerRuns.push(diagnostic.derivative_sha256);
  }
  assert.equal(producerRuns[0], producerRuns[1], "Show Formulas derivative is not deterministic");
  assert.equal(digest(await fs.readFile(clean.source)), sourceBeforeProducer, "producer altered the attested workbook");

  const mutations = [];

  const swapped = await buildEvidence(path.join(root, "swapped"));
  const other = path.join(swapped.root, "other.xlsx");
  await workbook(other, {}, false);
  await fs.appendFile(other, "swapped");
  swapped.evidence.attested_workbook = await record(other, swapped.root);
  await rewrite(swapped);
  mutations.push(["swapped workbook", swapped.evidencePath, ["SEMANTIC_INVENTORY_NOT_EXACT", "SHOW_FORMULAS_SOURCE_BINDING_MISMATCH"]]);

  const stale = await buildEvidence(path.join(root, "stale-render"));
  const staleReportPath = path.join(stale.root, stale.evidence.modes[0].render_report.path);
  const staleReport = JSON.parse(await fs.readFile(staleReportPath, "utf8"));
  staleReport.workbook_sha256 = "f".repeat(64);
  await writeJson(staleReportPath, staleReport);
  stale.evidence.modes[0].render_report = await record(staleReportPath, stale.root);
  await rewrite(stale);
  mutations.push(["stale render", stale.evidencePath, ["STALE_RENDER_WORKBOOK"]]);

  const missing = await buildEvidence(path.join(root, "missing-check"));
  missing.evidence.checklist.splice(12, 1);
  missing.evidence.summary.passed_checks = 23;
  await rewrite(missing);
  mutations.push(["missing section/mode", missing.evidencePath, ["CHECKLIST_COVERAGE_MISMATCH"]]);

  for (const [name, options, expected] of [
    ["external link", { external: true }, "SEMANTIC_INVENTORY_VIOLATIONS"],
    ["hidden hardcode", { hiddenHardcode: true }, "SEMANTIC_INVENTORY_VIOLATIONS"],
    ["formula outside used range", { outsideFormula: true }, "SEMANTIC_INVENTORY_VIOLATIONS"],
  ]) {
    const data = await buildEvidence(path.join(root, name.replaceAll(" ", "-")), options);
    mutations.push([name, data.evidencePath, [expected]]);
  }

  for (const [name, evidencePath, expectedCodes] of mutations) {
    const result = await validateLocalWorkbookReview(evidencePath);
    assert.notEqual(result.status, "PASS", `${name} mutation was accepted`);
    const codes = new Set(result.findings.map((item) => item.code));
    assert.ok(expectedCodes.some((code) => codes.has(code)), `${name} did not produce an expected code: ${JSON.stringify([...codes])}`);
  }

  console.log(JSON.stringify({
    status: "PASS",
    positive_contracts: 1,
    deterministic_derivative_replays: 2,
    checklist_items_per_workbook: 24,
    modes: REVIEW_MODES,
    sections_per_mode: REVIEW_SECTIONS.length,
    mutations_rejected: mutations.map(([name]) => name),
    human_visual_review_claimed: false,
    native_excel_review_claimed: false,
    violations: 0,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
