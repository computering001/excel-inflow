import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import { validateJsonSchema } from "./json_schema.mjs";
import { inspectWorkbookSemantics } from "./workbook_semantic_inventory.mjs";

const SCHEMA = JSON.parse(fsSync.readFileSync(
  new URL("../../assets/local-workbook-review-evidence-v1.schema.json", import.meta.url),
  "utf8",
));

export const REVIEW_MODES = Object.freeze(["values", "show_formulas"]);
export const REVIEW_SECTIONS = Object.freeze([
  "control_panel",
  "income_statement",
  "ebitda_bridge",
  "cash_flow",
  "debt_schedule",
  "leverage_liquidity",
  "rcf_sweep",
  "interest_schedule",
  "adjustment_columns",
  "pro_forma_columns",
  "broker_sheets",
  "quality_panel",
]);

const P = "(?:[A-Za-z_][\\w.-]*:)?";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function finding(code, message, detail = {}) {
  return { code, message, ...detail };
}

function attr(xml, name) {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(xml)?.[1] ?? "";
}

function directItems(xml, tag) {
  return xml.match(new RegExp(`<${P}${tag}\\b[^>]*?/>|<${P}${tag}\\b[^>]*>[\\s\\S]*?</${P}${tag}>`, "g")) ?? [];
}

function inner(xml, tag) {
  return new RegExp(`<${P}${tag}\\b[^>]*>([\\s\\S]*?)</${P}${tag}>`).exec(xml)?.[1] ?? "";
}

function relationships(xml, base) {
  const result = new Map();
  for (const item of directItems(xml, "Relationship")) {
    const id = attr(item, "Id");
    const target = attr(item, "Target");
    if (id && target) result.set(
      id,
      target.startsWith("/")
        ? path.posix.normalize(target.replace(/^\/+/, ""))
        : path.posix.normalize(path.posix.join(base, target)),
    );
  }
  return result;
}

function resolveRecord(record, root) {
  return path.isAbsolute(record.path) ? record.path : path.resolve(root, record.path);
}

async function verifyFile(record, root, code, findings) {
  if (!record || typeof record.path !== "string") {
    findings.push(finding(`${code}_PATH_MISSING`, "Evidence file path is required."));
    return null;
  }
  const filename = resolveRecord(record, root);
  try {
    const bytes = await fs.readFile(filename);
    const actual = sha256(bytes);
    if (record.sha256 !== actual) {
      findings.push(finding(`${code}_HASH_MISMATCH`, "Evidence file hash does not match its bound digest.", {
        expected: record.sha256 ?? null,
        actual,
      }));
    }
    if (Number(record.bytes) !== bytes.length) {
      findings.push(finding(`${code}_SIZE_MISMATCH`, "Evidence file size does not match its bound size.", {
        expected: record.bytes ?? null,
        actual: bytes.length,
      }));
    }
    return { filename, bytes, sha256: actual };
  } catch (error) {
    findings.push(finding(`${code}_UNREADABLE`, "Evidence file cannot be read.", { error: String(error) }));
    return null;
  }
}

async function workbookSheets(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new Error("Workbook or workbook relationships part is absent.");
  const rels = relationships(relsXml, "xl");
  const sheets = [];
  for (const descriptor of directItems(inner(workbookXml, "sheets"), "sheet")) {
    const relationshipId = attr(descriptor, "r:id");
    const part = rels.get(relationshipId);
    if (!part) throw new Error(`Worksheet relationship is absent for ${attr(descriptor, "name")}.`);
    sheets.push({
      name: attr(descriptor, "name"),
      state: attr(descriptor, "state") || "visible",
      part,
    });
  }
  return { zip, sheets };
}

function showFormulasValues(xml) {
  const values = [];
  for (const view of directItems(inner(xml, "sheetViews"), "sheetView")) {
    values.push(attr(/^<[^>]+>/.exec(view)?.[0] ?? view, "showFormulas") || "0");
  }
  return values.length ? values : ["0"];
}

function neutraliseShowFormulas(xml) {
  return String(xml).replace(/\s+showFormulas="(?:0|1|false|true)"/g, "");
}

async function verifyDerivative(source, derivative, findings) {
  let sourcePackage;
  let derivativePackage;
  try {
    sourcePackage = await workbookSheets(source.bytes);
    derivativePackage = await workbookSheets(derivative.bytes);
  } catch (error) {
    findings.push(finding("SHOW_FORMULAS_DERIVATIVE_UNREADABLE", "Source or derivative OOXML cannot be inspected.", { error: String(error) }));
    return [];
  }
  const sourceNames = Object.keys(sourcePackage.zip.files).filter((name) => !sourcePackage.zip.files[name].dir).sort();
  const derivativeNames = Object.keys(derivativePackage.zip.files).filter((name) => !derivativePackage.zip.files[name].dir).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(derivativeNames)) {
    findings.push(finding("SHOW_FORMULAS_MEMBER_SET_CHANGED", "Review derivative must preserve the exact OOXML member set."));
  }
  if (JSON.stringify(sourcePackage.sheets) !== JSON.stringify(derivativePackage.sheets)) {
    findings.push(finding("SHOW_FORMULAS_SHEET_INVENTORY_CHANGED", "Review derivative must preserve sheet names, order, states and parts."));
  }
  const visibleParts = new Set(sourcePackage.sheets.filter((sheet) => sheet.state === "visible").map((sheet) => sheet.part));
  for (const name of sourceNames) {
    const left = await sourcePackage.zip.file(name)?.async("nodebuffer");
    const right = await derivativePackage.zip.file(name)?.async("nodebuffer");
    if (!left || !right) continue;
    if (!visibleParts.has(name)) {
      if (!left.equals(right)) findings.push(finding("SHOW_FORMULAS_UNAUTHORISED_MEMBER_CHANGE", "Derivative changed an OOXML member outside the visible worksheet set.", { member: name }));
      continue;
    }
    const sourceXml = left.toString("utf8");
    const derivativeXml = right.toString("utf8");
    if (showFormulasValues(sourceXml).some((value) => value === "1" || value === "true")) {
      findings.push(finding("VALUES_SOURCE_ALREADY_SHOWS_FORMULAS", "The attested workbook is not in Values view.", { member: name }));
    }
    if (showFormulasValues(derivativeXml).some((value) => value !== "1" && value !== "true")) {
      findings.push(finding("SHOW_FORMULAS_NOT_ENABLED", "Every view of every visible derivative sheet must enable Show Formulas.", { member: name }));
    }
    if (neutraliseShowFormulas(sourceXml) !== neutraliseShowFormulas(derivativeXml)) {
      findings.push(finding("SHOW_FORMULAS_DERIVATIVE_SCOPE_WIDENED", "Visible worksheet changed beyond the showFormulas view attribute.", { member: name }));
    }
  }
  return sourcePackage.sheets.filter((sheet) => sheet.state === "visible").map((sheet) => sheet.name);
}

function renderPagesFromReport(report, mode, reportRoot) {
  const pages = [];
  for (const sheet of report.sheets ?? []) {
    for (const [index, page] of (sheet.rendered_pages ?? []).entries()) {
      pages.push({
        id: `${mode}:${sheet.sheet}:${index + 1}`,
        sheet: sheet.sheet,
        page_index: index + 1,
        path: path.isAbsolute(page.path) ? page.path : path.resolve(reportRoot, page.path),
        sha256: page.sha256,
        bytes: page.bytes,
      });
    }
  }
  return pages;
}

async function verifyMode(modeRecord, expectedMode, expectedWorkbookSha, expectedSheets, evidenceRoot, findings) {
  if (modeRecord?.mode !== expectedMode) {
    findings.push(finding("REVIEW_MODE_ORDER_MISMATCH", "Review modes must be Values then Show Formulas."));
    return [];
  }
  if (modeRecord.workbook_sha256 !== expectedWorkbookSha) {
    findings.push(finding("RENDER_WORKBOOK_BINDING_MISMATCH", "Mode is not bound to the exact expected workbook.", { mode: expectedMode }));
  }
  if (JSON.stringify(modeRecord.visible_sheets) !== JSON.stringify(expectedSheets)) {
    findings.push(finding("RENDER_VISIBLE_SHEET_SET_MISMATCH", "Mode must cover every visible sheet in workbook order.", { mode: expectedMode }));
  }
  const reportFile = await verifyFile(modeRecord.render_report, evidenceRoot, `RENDER_REPORT_${expectedMode.toUpperCase()}`, findings);
  if (!reportFile) return [];
  let report;
  try {
    report = JSON.parse(reportFile.bytes.toString("utf8"));
  } catch (error) {
    findings.push(finding("RENDER_REPORT_INVALID_JSON", "Render report is not JSON.", { mode: expectedMode, error: String(error) }));
    return [];
  }
  if (report.schema !== "render-evidence/2" || report.verdict !== "PASS" || report.comparison_scope !== "structural_company_run") {
    findings.push(finding("RENDER_REPORT_NOT_PORTABLE_PASS", "Local mode requires a PASS structural-company render report.", { mode: expectedMode }));
  }
  if (report.workbook_sha256 !== expectedWorkbookSha) {
    findings.push(finding("STALE_RENDER_WORKBOOK", "Render report belongs to a different workbook.", { mode: expectedMode }));
  }
  if (JSON.stringify(report.sheets_examined) !== JSON.stringify(expectedSheets) ||
      JSON.stringify((report.sheets ?? []).map((sheet) => sheet.sheet)) !== JSON.stringify(expectedSheets)) {
    findings.push(finding("RENDER_SHEET_COVERAGE_INCOMPLETE", "Render report must examine every visible sheet exactly once and in order.", { mode: expectedMode }));
  }
  if ((report.sheets ?? []).some((sheet) => sheet.verdict !== "PASS" || !Number.isInteger(sheet.page_count) || sheet.page_count < 1)) {
    findings.push(finding("RENDER_SHEET_NOT_PASS", "Every visible rendered sheet must PASS and have at least one page.", { mode: expectedMode }));
  }
  const expectedPages = renderPagesFromReport(report, expectedMode, path.dirname(reportFile.filename));
  if (expectedPages.length === 0) findings.push(finding("RENDER_PAGE_RECEIPTS_MISSING", "Every rendered sheet/page requires a hash-bound receipt.", { mode: expectedMode }));
  const contractPages = modeRecord.pages ?? [];
  const canonical = (page) => ({ id: page.id, sheet: page.sheet, page_index: page.page_index, sha256: page.sha256, bytes: page.bytes });
  if (JSON.stringify(contractPages.map(canonical)) !== JSON.stringify(expectedPages.map(canonical))) {
    findings.push(finding("RENDER_PAGE_LEDGER_MISMATCH", "Contract page ledger does not exactly match the render report.", { mode: expectedMode }));
  }
  for (const [index, page] of contractPages.entries()) {
    await verifyFile(page, evidenceRoot, `RENDER_PAGE_${expectedMode.toUpperCase()}_${index + 1}`, findings);
  }
  return contractPages;
}

export async function validateLocalWorkbookReview(evidencePath) {
  const absoluteEvidence = path.resolve(evidencePath);
  const evidenceRoot = path.dirname(absoluteEvidence);
  const findings = [];
  let evidence;
  try {
    evidence = JSON.parse(await fs.readFile(absoluteEvidence, "utf8"));
  } catch (error) {
    return { schema_version: "local-workbook-review-validation/1.0", status: "BLOCKED", total_violations: 1, findings: [finding("EVIDENCE_UNREADABLE", String(error))] };
  }
  for (const message of validateJsonSchema(evidence, SCHEMA)) {
    findings.push(finding("EVIDENCE_SCHEMA_INVALID", message));
  }
  if (evidence.evidence_class !== "AUTOMATED_LOCAL_REVIEW_ONLY" ||
      evidence.human_visual_review?.claimed_as_pass !== false ||
      evidence.native_excel_review?.claimed_as_pass !== false) {
    findings.push(finding("REVIEW_CLASS_OVERCLAIMED", "Portable local evidence may never claim human or native Excel review."));
  }
  const source = await verifyFile(evidence.attested_workbook, evidenceRoot, "ATTESTED_WORKBOOK", findings);
  const derivative = await verifyFile(evidence.show_formulas_derivative, evidenceRoot, "SHOW_FORMULAS_DERIVATIVE", findings);
  if (source && evidence.show_formulas_derivative?.source_workbook_sha256 !== source.sha256) {
    findings.push(finding("SHOW_FORMULAS_SOURCE_BINDING_MISMATCH", "Derivative is not bound to the attested source workbook hash."));
  }
  let visibleSheets = [];
  if (source && derivative) visibleSheets = await verifyDerivative(source, derivative, findings);

  const inventoryFile = await verifyFile(evidence.semantic_inventory, evidenceRoot, "SEMANTIC_INVENTORY", findings);
  if (source && inventoryFile) {
    let recorded;
    try {
      recorded = JSON.parse(inventoryFile.bytes.toString("utf8"));
      const actual = await inspectWorkbookSemantics(source.filename);
      if (recorded.schema_version !== "workbook-semantic-inventory/1.0" ||
          recorded.status !== "PASS" ||
          recorded.workbook_sha256 !== source.sha256 ||
          JSON.stringify(recorded) !== JSON.stringify(actual)) {
        findings.push(finding("SEMANTIC_INVENTORY_NOT_EXACT", "Semantic inventory is stale, incomplete, failed, or belongs to another workbook."));
      }
      if ((actual.summary?.violations ?? []).length !== 0) {
        findings.push(finding("SEMANTIC_INVENTORY_VIOLATIONS", "Workbook semantic inventory contains fail-closed violations.", { violations: actual.summary.violations }));
      }
    } catch (error) {
      findings.push(finding("SEMANTIC_INVENTORY_INVALID", "Semantic inventory cannot be independently recomputed.", { error: String(error) }));
    }
  }

  const modePages = new Map();
  if (source && derivative) {
    modePages.set("values", await verifyMode(evidence.modes?.[0], "values", source.sha256, visibleSheets, evidenceRoot, findings));
    modePages.set("show_formulas", await verifyMode(evidence.modes?.[1], "show_formulas", derivative.sha256, visibleSheets, evidenceRoot, findings));
  }
  const expectedChecklist = REVIEW_MODES.flatMap((mode) => REVIEW_SECTIONS.map((section) => `${mode}\u0000${section}`));
  const actualChecklist = (evidence.checklist ?? []).map((record) => `${record.mode}\u0000${record.section}`);
  if (JSON.stringify(actualChecklist) !== JSON.stringify(expectedChecklist)) {
    findings.push(finding("CHECKLIST_COVERAGE_MISMATCH", "All 12 sections are required separately in Values and Show Formulas, in canonical order."));
  }
  for (const [index, record] of (evidence.checklist ?? []).entries()) {
    if (record.status !== "PASS" || record.review_class !== "AUTOMATED_LOCAL" || Object.values(record.checks ?? {}).some((value) => value !== "PASS")) {
      findings.push(finding("CHECKLIST_ITEM_NOT_PASS", "Every portable checklist item must be an explicit automated-local PASS.", { index }));
    }
    const pages = modePages.get(record.mode) ?? [];
    const validIds = new Set(pages.map((page) => page.id));
    const evidenceIds = record.evidence_page_ids ?? [];
    if (evidenceIds.length === 0 || evidenceIds.some((id) => !validIds.has(id))) {
      findings.push(finding("CHECKLIST_PAGE_BINDING_INVALID", "Checklist item cites a missing or cross-mode page receipt.", { index }));
    }
    if (record.section === "broker_sheets") {
      const supportIds = new Set(pages.filter((page) => page.sheet !== "Operating Model").map((page) => page.id));
      if (supportIds.size === 0 || [...supportIds].some((id) => !evidenceIds.includes(id))) {
        findings.push(finding("BROKER_SUPPORT_PAGE_COVERAGE_INCOMPLETE", "Broker-sheets checklist must bind every visible support-sheet page.", { mode: record.mode }));
      }
    } else {
      const operatingIds = pages.filter((page) => page.sheet === "Operating Model").map((page) => page.id);
      if (operatingIds.length === 0 || operatingIds.some((id) => !evidenceIds.includes(id))) {
        findings.push(finding("OPERATING_MODEL_PAGE_COVERAGE_INCOMPLETE", "Operating-model checklist section must bind every Operating Model page.", { mode: record.mode, section: record.section }));
      }
    }
  }
  const renderedPageCount = [...modePages.values()].reduce((sum, pages) => sum + pages.length, 0);
  const passedChecklist = (evidence.checklist ?? []).filter((record) => record.status === "PASS").length;
  if (evidence.summary?.required_checks !== 24 || evidence.summary?.passed_checks !== passedChecklist ||
      evidence.summary?.visible_sheet_count !== visibleSheets.length || evidence.summary?.rendered_page_count !== renderedPageCount) {
    findings.push(finding("REVIEW_SUMMARY_MISMATCH", "Review summary does not match independently counted evidence."));
  }
  if (evidence.status !== "PASS" || Number(evidence.total_violations) !== 0) {
    findings.push(finding("REVIEW_RECEIPT_NOT_PASS", "Submitted local review receipt itself is not PASS with zero violations."));
  }
  return {
    schema_version: "local-workbook-review-validation/1.0",
    status: findings.length === 0 ? "PASS" : "FAIL",
    evidence_class: "AUTOMATED_LOCAL_REVIEW_ONLY",
    native_excel_review: "NOT_PERFORMED",
    human_visual_review: "NOT_PERFORMED",
    attested_workbook_sha256: source?.sha256 ?? null,
    visible_sheet_count: visibleSheets.length,
    rendered_page_count: renderedPageCount,
    checklist_items_checked: evidence.checklist?.length ?? 0,
    total_violations: findings.length,
    findings,
  };
}
