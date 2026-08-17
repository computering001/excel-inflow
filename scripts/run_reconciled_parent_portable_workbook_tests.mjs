#!/usr/bin/env node

/** Prove a reconciled reported parent remains formula-owned in the workbook. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import JSZip from "jszip";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PYTHON = process.env.DEBT_OVERLAY_PYTHON ?? "python3";

async function run(executable, args, { allowFailure = false } = {}) {
  try {
    return await exec(executable, args, {
      cwd: ROOT,
      env: process.env,
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return { error, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function sourceRecord(rowId, label) {
  return {
    source_line_id: `is.${rowId}`,
    label,
    document: "Neutral reconciled-parent workbook mutation fixture",
    page_or_note: `Synthetic specification, income_statement line ${rowId}`,
    face_statement: true,
    material: true,
    disposition: "mapped",
    mapped_row_ids: [rowId],
    mapping_method: "exact",
  };
}

function provenance(label) {
  return [0, 1, 2].map((periodIndex) => ({
    period_index: periodIndex,
    document: "Neutral reconciled-parent workbook mutation fixture",
    publication_date: "2026-08-17",
    page_or_note: `Synthetic arithmetic witness for ${label}`,
    units: "USD millions",
    source_label: label,
    transformation: "Neutral issuer-independent test data; not a real company.",
  }));
}

function reconciledCase(base) {
  const modelCase = structuredClone(base);
  modelCase.execution_profile = "reference_parity";
  modelCase.case_id = "neutral_reconciled_parent";
  modelCase.issuer = {
    ...modelCase.issuer,
    name: "Neutral Reconciled Parent Test Co",
    accounting_basis: "IFRS",
  };
  const rows = modelCase.statement_structure.income_statement;
  const parentIndex = rows.findIndex((row) => row.row_id === "revenue");
  assert(parentIndex >= 0);
  const parent = rows[parentIndex];
  delete parent.values;
  Object.assign(parent, {
    label: "Issuer-defined aggregate X",
    row_type: "calculation",
    calculation: {
      operator: "sum",
      refs: ["issuer_component_alpha", "issuer_component_beta"],
    },
    historical_authority: "reported_total_reconciled",
    reported_historical_values: [1000, 1000, 1000],
    reported_historical_value_states: [
      "reported_number",
      "reported_number",
      "reported_number",
    ],
    aggregation_authority: "derived_from_children",
    forecast_treatment: "formula",
  });
  const children = [
    {
      row_id: "issuer_component_alpha",
      label: "Component Alpha",
      row_type: "input",
      values: [400, 500, 600, 600, 600, 600],
      forecast_treatment: "hardcode",
      parent_row_id: "revenue",
      aggregation_role: "contributing_child",
      economic_class: "other_operating",
      style_role: "body",
    },
    {
      row_id: "issuer_component_beta",
      label: "Component Beta",
      row_type: "input",
      values: [600, 500, 400, 400, 400, 400],
      forecast_treatment: "hardcode",
      parent_row_id: "revenue",
      aggregation_role: "contributing_child",
      economic_class: "other_operating",
      style_role: "body",
    },
  ];
  rows.splice(parentIndex, 0, ...children);
  modelCase.source_coverage.income_statement.splice(
    0,
    0,
    sourceRecord("issuer_component_alpha", "Component Alpha"),
    sourceRecord("issuer_component_beta", "Component Beta"),
  );
  modelCase.source_coverage.income_statement.find(
    (record) => record.source_line_id === "is.revenue",
  ).label = "Issuer-defined aggregate X";
  modelCase.provenance.issuer_component_alpha = provenance("Component Alpha");
  modelCase.provenance.issuer_component_beta = provenance("Component Beta");
  modelCase.provenance.revenue = provenance("Issuer-defined aggregate X");
  return modelCase;
}

function cellBody(xml, address) {
  const match = new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>([\\s\\S]*?)<\\/c>`).exec(xml);
  assert(match, `Missing ${address}`);
  return match[1];
}

function removeFormula(xml, address) {
  const expression = new RegExp(
    `(<c\\b[^>]*\\br="${address}"[^>]*>)([\\s\\S]*?)(<\\/c>)`,
  );
  const match = expression.exec(xml);
  assert(match && /<f(?:\s[^>]*)?>[\s\S]*?<\/f>/.test(match[2]), `No formula in ${address}`);
  return xml.replace(expression, (_all, open, body, close) =>
    `${open}${body.replace(/<f(?:\s[^>]*)?>[\s\S]*?<\/f>/, "")}${close}`);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reconciled-parent-workbook-"));
  let succeeded = false;
  try {
    const base = JSON.parse(await fs.readFile(
      path.join(ROOT, "test-fixtures", "cases", "standard-net-cash-v2.json"),
      "utf8",
    ));
    const casePath = path.join(root, "case.json");
    const workbook = path.join(root, "model.xlsx");
    const plan = `${workbook}.plan.json`;
    await fs.writeFile(casePath, `${JSON.stringify(reconciledCase(base), null, 2)}\n`);
    await run(process.execPath, [
      path.join(HERE, "build_dynamic_model.mjs"),
      casePath,
      "--out", workbook,
      "--plan-only",
    ]);
    await run(PYTHON, [
      path.join(HERE, "emit", "__main__.py"),
      "build", plan,
      "--out", workbook,
    ]);

    const rowMap = JSON.parse(await fs.readFile(`${workbook}.row-map.json`, "utf8"));
    const rows = new Map(rowMap.statement_rows.income_statement.map((row) => [row.row_id, row]));
    const parent = rows.get("revenue");
    const alpha = rows.get("issuer_component_alpha");
    const beta = rows.get("issuer_component_beta");
    assert(parent && alpha && beta);
    assert.equal(parent.historical_authority, "reported_total_reconciled");
    assert.deepEqual(parent.reported_historical_values, [1000, 1000, 1000]);
    assert.deepEqual(parent.calculation?.refs, ["issuer_component_alpha", "issuer_component_beta"]);
    assert.equal(alpha.parent_row_id, "revenue");
    assert.equal(beta.parent_row_id, "revenue");

    const bytes = await fs.readFile(workbook);
    const zip = await JSZip.loadAsync(bytes);
    const sheetPath = "xl/worksheets/sheet1.xml";
    const xml = await zip.file(sheetPath).async("string");
    const historicalColumns = rowMap.columns.historical;
    for (const column of historicalColumns) {
      const address = `${column}${parent.row}`;
      const formula = cellBody(xml, address);
      assert(formula.includes(`${column}${alpha.row}`), `${address} omits alpha child`);
      assert(formula.includes(`${column}${beta.row}`), `${address} omits beta child`);
    }

    const parityPath = path.join(root, "cache-parity.json");
    await run(process.execPath, [
      path.join(HERE, "validate_cache_parity.mjs"),
      workbook,
      "--json", parityPath,
    ]);
    const parity = JSON.parse(await fs.readFile(parityPath, "utf8"));
    assert.equal(parity.status, "PASS");
    assert.equal(parity.disagreements, 0);

    const oraclePath = path.join(root, "semantic-oracle.json");
    await run(PYTHON, [
      path.join(HERE, "verify", "workbook_semantic_oracle.py"),
      "--xlsx", workbook,
      "--contract", `${workbook}.workbook-proof-contract.json`,
      "--out", oraclePath,
    ]);
    const oracle = JSON.parse(await fs.readFile(oraclePath, "utf8"));
    assert.equal(oracle.status, "PASS");

    const mutated = path.join(root, "mutated-hardcode.xlsx");
    zip.file(sheetPath, removeFormula(xml, `${historicalColumns[1]}${parent.row}`));
    await fs.writeFile(mutated, await zip.generateAsync({ type: "nodebuffer" }));
    const mutationOraclePath = path.join(root, "mutation-oracle.json");
    const mutation = await run(PYTHON, [
      path.join(HERE, "verify", "workbook_semantic_oracle.py"),
      "--xlsx", mutated,
      "--contract", `${workbook}.workbook-proof-contract.json`,
      "--model-ir", `${workbook}.model-ir-v3.json`,
      "--out", mutationOraclePath,
    ], { allowFailure: true });
    assert(mutation.error, "Hardcoded parent mutation unexpectedly passed");
    const mutationOracle = JSON.parse(await fs.readFile(mutationOraclePath, "utf8"));
    assert.equal(mutationOracle.status, "BLOCK");
    assert(mutationOracle.findings.some(
      (finding) => finding.code === "OOXML_PROTECTED_IDENTITY_FORMULA_REQUIRED",
    ));

    console.log(JSON.stringify({
      status: "PASS",
      checks: 15,
      historical_formula_cells: historicalColumns.length,
      hardcode_mutation: "BLOCKED",
      cache_parity: parity.status,
      semantic_oracle: oracle.status,
    }, null, 2));
    succeeded = true;
  } finally {
    if (succeeded) await fs.rm(root, { recursive: true, force: true });
    else console.error(`Preserved failed fixture at ${root}`);
  }
}

await main();
