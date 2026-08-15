#!/usr/bin/env node
/** Prove a real filing cannot collapse into a structurally valid shadow model. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { proposeCaseSource } from "./lib/case_source_proposer.mjs";
import { compileCase } from "./lib/case_compiler.mjs";

const [filingsResponseArg, sourceDumpArg] = process.argv.slice(2);
if (!filingsResponseArg || !sourceDumpArg) {
  throw new Error(
    "Usage: node scripts/run_real_statement_outcome_regression.mjs " +
    "<filings-extraction-response.json> <case-compiler-source-dump.json>",
  );
}
const filingsResponse = JSON.parse(await fs.readFile(path.resolve(filingsResponseArg), "utf8"));
const sourceDump = JSON.parse(await fs.readFile(path.resolve(sourceDumpArg), "utf8"));
const manifests = Object.fromEntries(
  ["income_statement", "cash_flow"].map((section) => [
    section,
    filingsResponse.documents.flatMap((document) =>
      document.face_statement_manifests?.[section] ?? []),
  ]),
);
assert.equal(manifests.income_statement.length, 1, "real filing has no selected income statement");
assert.equal(manifests.cash_flow.length, 1, "real filing has no selected cash-flow statement");
assert.equal(manifests.income_statement[0].rows.length, 20, "real Astra income face changed unexpectedly");
assert.equal(manifests.cash_flow[0].rows.length, 45, "real Astra cash-flow face changed unexpectedly");

const declarations = structuredClone(sourceDump.caseSource);
delete declarations.statement_map;
delete declarations.evidence_refs?.face_statement_manifests;
const evidence = structuredClone(sourceDump.evidence);
evidence.face_statement_manifests = manifests;
const caseSource = proposeCaseSource({
  declarations,
  caseEvidence: evidence,
  filings: filingsResponse.filing_facts,
});
const compiled = compileCase(caseSource, evidence);
assert.equal(compiled.report.status, "clean", JSON.stringify(compiled.report));
assert.equal(compiled.model_case.statement_structure.income_statement.length, 28);
assert.equal(compiled.model_case.statement_structure.cash_flow.length, 55);

const incomeLabels = new Set(
  compiled.model_case.statement_structure.income_statement.map((row) => row.label),
);
for (const label of [
  "Product Sales", "Alliance Revenue", "Product Revenue", "Collaboration Revenue",
  "Total Revenue", "Cost of sales", "Gross profit", "Distribution expense",
  "Research and development expense", "Selling, general and administrative expense",
  "Other operating income and expense", "Operating profit", "Finance income",
  "Finance expense", "Profit before tax", "Taxation", "Profit for the period",
]) assert(incomeLabels.has(label), `compiled model lost ${label}`);

const cashIds = new Set(
  compiled.model_case.statement_structure.cash_flow.map((row) => row.row_id),
);
for (const rowId of [
  "receivables_movement", "inventory_movement", "payables_provisions_movement",
  "change_in_working_capital", "ppe_purchases", "intangible_purchases", "capex",
  "cash_from_operations", "cash_from_investing", "cash_from_financing",
  "net_change_in_cash", "ending_cash",
]) assert(cashIds.has(rowId), `compiled model lost cash-flow node ${rowId}`);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "real-statement-outcome-"));
const casePath = path.join(temporary, "case.json");
const workbookPath = path.join(temporary, "model.xlsx");
await fs.writeFile(casePath, `${JSON.stringify(compiled.model_case, null, 2)}\n`);
execFileSync("node", ["scripts/build_dynamic_model.mjs", casePath, "--out", workbookPath, "--plan-only"], {
  cwd: path.resolve("."),
  stdio: "pipe",
});
const rowMap = JSON.parse(await fs.readFile(`${workbookPath}.row-map.json`, "utf8"));
const visibleIncome = rowMap.statement_rows.income_statement.filter((row) => Number.isInteger(row.row));
const visibleCash = rowMap.statement_rows.cash_flow.filter((row) => Number.isInteger(row.row));
const visibleIncomeData = visibleIncome.filter((row) => row.row_type !== "header");
assert.equal(visibleIncome.length, 25, "normalisation collapsed the real Astra income face");
assert.equal(visibleIncomeData.length, 24, "normalisation collapsed the real Astra income data rows");
assert.equal(visibleCash.length, 55, "normalisation collapsed the real Astra cash-flow face");
assert(visibleIncomeData.length > 14 && visibleCash.length > 30, "shadow-model topology was accepted");

console.log(JSON.stringify({
  schema_version: "real-statement-outcome-regression/1.0",
  status: "PASS",
  extracted_rows: { income_statement: 20, cash_flow: 45 },
  compiled_rows: { income_statement: 28, cash_flow: 55 },
  visible_rows: { income_statement: 25, income_statement_data: 24, cash_flow: 55 },
  shadow_model_14_30_rejected: true,
  violations: 0,
  root: temporary,
}, null, 2));
