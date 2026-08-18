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

const [filingsResponseArg, sourceDumpArg, expectationsArg] = process.argv.slice(2);
if (!filingsResponseArg || !sourceDumpArg || !expectationsArg) {
  throw new Error(
    "Usage: node scripts/run_real_statement_outcome_regression.mjs " +
    "<filings-extraction-response.json> <case-compiler-source-dump.json> " +
    "<run-scoped-real-filing-expectations.json>",
  );
}
const filingsResponse = JSON.parse(await fs.readFile(path.resolve(filingsResponseArg), "utf8"));
const sourceDump = JSON.parse(await fs.readFile(path.resolve(sourceDumpArg), "utf8"));
const expectations = JSON.parse(await fs.readFile(path.resolve(expectationsArg), "utf8"));
assert.equal(
  expectations.schema_version,
  "real-filing-canary-expectations/1.0",
  "real-filing expectations schema changed unexpectedly",
);
const manifests = Object.fromEntries(
  ["income_statement", "cash_flow"].map((section) => [
    section,
    filingsResponse.documents.flatMap((document) =>
      document.face_statement_manifests?.[section] ?? []),
  ]),
);
assert.equal(manifests.income_statement.length, 1, "real filing has no selected income statement");
assert.equal(manifests.cash_flow.length, 1, "real filing has no selected cash-flow statement");
assert.equal(
  manifests.income_statement[0].rows.length,
  expectations.source_statement_rows.income_statement,
  "real-filing income face changed unexpectedly",
);
assert.equal(
  manifests.cash_flow[0].rows.length,
  expectations.source_statement_rows.cash_flow,
  "real-filing cash-flow face changed unexpectedly",
);

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
assert.ok(
  compiled.model_case.statement_structure.income_statement.length >=
    expectations.minimum_visible_rows.income_statement,
  "compiled income surface fell below the external corpus expectation",
);
assert.ok(
  compiled.model_case.statement_structure.cash_flow.length >=
    expectations.minimum_visible_rows.cash_flow,
  "compiled cash-flow surface fell below the external corpus expectation",
);

const incomeLabels = new Set(
  compiled.model_case.statement_structure.income_statement.map((row) => row.label),
);
for (const label of expectations.required_income_labels ?? []) {
  assert(incomeLabels.has(label), `compiled model lost ${label}`);
}

const cashIds = new Set(
  compiled.model_case.statement_structure.cash_flow.map((row) => row.row_id),
);
for (const rowId of expectations.required_cash_flow_row_ids ?? []) {
  assert(cashIds.has(rowId), `compiled model lost cash-flow node ${rowId}`);
}

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
assert.ok(
  visibleIncome.length >= expectations.minimum_visible_rows.income_statement,
  "normalisation collapsed the real-filing income face",
);
assert.ok(
  visibleIncomeData.length >= expectations.minimum_visible_income_data_rows,
  "normalisation collapsed the real-filing income data rows",
);
assert.ok(
  visibleCash.length >= expectations.minimum_visible_rows.cash_flow,
  "normalisation collapsed the real-filing cash-flow face",
);
assert(visibleIncomeData.length > 14 && visibleCash.length > 30, "shadow-model topology was accepted");

console.log(JSON.stringify({
  schema_version: "real-statement-outcome-regression/1.0",
  status: "PASS",
  fixture_id: expectations.fixture_id,
  extracted_rows: {
    income_statement: manifests.income_statement[0].rows.length,
    cash_flow: manifests.cash_flow[0].rows.length,
  },
  compiled_rows: {
    income_statement: compiled.model_case.statement_structure.income_statement.length,
    cash_flow: compiled.model_case.statement_structure.cash_flow.length,
  },
  visible_rows: {
    income_statement: visibleIncome.length,
    income_statement_data: visibleIncomeData.length,
    cash_flow: visibleCash.length,
  },
  shadow_model_14_30_rejected: true,
  violations: 0,
  root: temporary,
}, null, 2));
