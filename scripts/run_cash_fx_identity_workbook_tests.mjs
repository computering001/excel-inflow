#!/usr/bin/env node

/** Independent workbook-level proof of inclusive/exclusive cash FX identities. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import JSZip from "jszip";

import { normaliseStatementRows } from "./lib/row_plan.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PYTHON = process.env.DEBT_OVERLAY_PYTHON ?? "python3";

async function run(executable, args) {
  return exec(executable, args, {
    cwd: ROOT,
    env: process.env,
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function roleRow(modelCase, role) {
  const row = modelCase.statement_structure.cash_flow.find(
    (candidate) => candidate.semantic_role === role,
  );
  assert(row, `Missing cash-flow role ${role}`);
  return row;
}

function cashIdentityCase(base, { includesFx, explicitBuckets, fxBump = 0 }) {
  const modelCase = structuredClone(base);
  modelCase.execution_profile = "reference_parity";
  modelCase.case_id = [
    "neutral_cash_fx",
    includesFx ? "inclusive" : "exclusive",
    explicitBuckets ? "buckets" : "legacy",
    fxBump ? "mutated" : "base",
  ].join("_");
  modelCase.issuer = {
    ...modelCase.issuer,
    name: "Neutral Cash FX Identity Test Co",
  };
  modelCase.controls = { ...modelCase.controls, circularity: 0 };
  const scheduledInstrument = modelCase.instruments.find(
    (instrument) => instrument.class !== "rcf",
  );
  scheduledInstrument.new_issuance = [7, 0, 0];
  const cfo = roleRow(modelCase, "cash_from_operations");
  const cfi = roleRow(modelCase, "cash_from_investing");
  const cff = roleRow(modelCase, "cash_from_financing");
  const fx = roleRow(modelCase, "fx_effect_on_cash");
  const net = roleRow(modelCase, "net_change_in_cash");
  const opening = roleRow(modelCase, "opening_cash");
  const ending = roleRow(modelCase, "ending_cash");
  fx.values = [...(fx.values ?? [0, 0, 0]).slice(0, 3), 3 + fxBump, 4, 5];
  fx.row_type = "input";
  fx.forecast_treatment = "hardcode";
  delete fx.forecast_calculation;
  delete fx.forecast_period_calculations;
  net.calculation = {
    operator: "sum",
    refs: [cfo.row_id, cfi.row_id, cff.row_id, ...(includesFx ? [fx.row_id] : [])],
  };
  net.forecast_treatment = "formula";
  delete net.forecast_calculation;
  delete net.forecast_period_calculations;
  ending.calculation = {
    operator: "sum",
    refs: [opening.row_id, net.row_id, ...(!includesFx ? [fx.row_id] : [])],
  };
  ending.forecast_treatment = "formula";
  delete ending.forecast_calculation;
  delete ending.forecast_period_calculations;
  if (explicitBuckets) {
    const history = (ending.values ?? modelCase.cash_policy.historical_year_end_cash)
      .slice(0, 3)
      .map(Number);
    delete modelCase.cash_policy.opening_cash;
    delete modelCase.cash_policy.historical_year_end_cash;
    delete modelCase.cash_policy.eligible_cash_percentage;
    delete modelCase.cash_policy.cash_yield;
    modelCase.cash_policy.buckets = [{
      bucket_id: "unrestricted_cash",
      label: "Cash and cash equivalents",
      historical_year_end: history,
      forecast_treatment: "balancing",
      available_for_liquidity: true,
      net_debt_eligible_percentage: 1,
      interest_eligible_percentage: 1,
      cash_yield: [0, 0, 0],
      source_line_ids: ending.source_line_ids ?? [ending.row_id],
    }];
  }
  return modelCase;
}

function cellBody(xml, address) {
  const match = new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>([\\s\\S]*?)<\\/c>`).exec(xml);
  assert(match, `Missing workbook cell ${address}`);
  return match[1];
}

function formula(xml, address) {
  const match = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(cellBody(xml, address));
  assert(match, `Missing formula in ${address}`);
  return match[1].replaceAll("&amp;", "&");
}

function cachedNumber(xml, address) {
  const match = /<v>([^<]*)<\/v>/.exec(cellBody(xml, address));
  assert(match && Number.isFinite(Number(match[1])), `Missing numeric cache in ${address}`);
  return Number(match[1]);
}

function sameColumnRowRefs(formulaText, column) {
  const rows = [];
  for (const match of formulaText.matchAll(/\b([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?\b/g)) {
    if (match[1] !== column) continue;
    const first = Number(match[2]);
    const last = match[3] === column ? Number(match[4]) : first;
    for (let row = first; row <= last; row += 1) rows.push(row);
  }
  return rows;
}

function declaredRows(rowMap, definition) {
  return definition.calculation.refs.map((rowId) => {
    const row = rowMap.statement_rows.cash_flow.find((candidate) => candidate.row_id === rowId)?.row;
    assert(Number.isInteger(row), `Declared identity references missing ${rowId}`);
    return row;
  });
}

function assertDeclaredFormula(xml, rowMap, definition, column) {
  const actual = sameColumnRowRefs(formula(xml, `${column}${definition.row}`), column);
  const expected = declaredRows(rowMap, definition);
  assert.deepEqual(
    actual,
    expected,
    `${column}${definition.row} does not resolve the case's declared refs`,
  );
}

function declaredCachedSum(xml, rowMap, definition, column, excludedRow = null) {
  return declaredRows(rowMap, definition)
    .filter((row) => row !== excludedRow)
    .reduce((total, row) => total + cachedNumber(xml, `${column}${row}`), 0);
}

function assertDeclaredSumCache(xml, rowMap, definition, column) {
  const actual = cachedNumber(xml, `${column}${definition.row}`);
  const expected = declaredCachedSum(xml, rowMap, definition, column);
  assert(
    Math.abs(actual - expected) <= 1e-6,
    `${column}${definition.row} cache ${actual} does not equal declared SUM ${expected}`,
  );
}

function assertMutationDetected(rowMap, definition, column, formulaText, mutate) {
  const expected = declaredRows(rowMap, definition);
  const mutated = mutate([...sameColumnRowRefs(formulaText, column)]);
  assert.notDeepEqual(mutated, expected, "FX formula mutation escaped the independent ref oracle");
}

async function build(root, modelCase, name) {
  const casePath = path.join(root, `${name}.json`);
  const workbook = path.join(root, `${name}.xlsx`);
  await fs.writeFile(casePath, `${JSON.stringify(modelCase, null, 2)}\n`);
  await run(process.execPath, [
    path.join(HERE, "build_dynamic_model.mjs"),
    casePath,
    "--out", workbook,
    "--plan-only",
  ]);
  await run(PYTHON, [
    path.join(HERE, "emit", "__main__.py"),
    "build", `${workbook}.plan.json`,
    "--out", workbook,
  ]);
  const rowMap = JSON.parse(await fs.readFile(`${workbook}.row-map.json`, "utf8"));
  const zip = await JSZip.loadAsync(await fs.readFile(workbook));
  const xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  return { modelCase, rowMap, xml };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cash-fx-identity-"));
  const base = JSON.parse(await fs.readFile(
    path.join(ROOT, "test-fixtures", "cases", "standard-net-cash-v2.json"),
    "utf8",
  ));
  const zeroHistoryGap = structuredClone(base);
  const zeroGapPreTax = zeroHistoryGap.statement_structure.income_statement.find(
    (row) => row.semantic_role === "pre_tax_income",
  );
  const zeroGapIncome = zeroHistoryGap.statement_structure.income_statement.find(
    (row) => row.semantic_role === "interest_income",
  );
  zeroGapIncome.values = [0, 0, 0, null, null, null];
  zeroGapPreTax.calculation.refs = zeroGapPreTax.calculation.refs.filter(
    (ref) => ref !== zeroGapIncome.row_id,
  );
  for (const rule of zeroGapPreTax.forecast_period_calculations ?? []) {
    rule.refs = rule.refs.filter((ref) => ref !== zeroGapIncome.row_id);
  }
  const repairedZeroGap = normaliseStatementRows(
    zeroHistoryGap,
    "income_statement",
  ).find((row) => row.semantic_role === "pre_tax_income");
  assert.equal(
    repairedZeroGap.calculation.refs.filter((ref) => ref === zeroGapIncome.row_id).length,
    1,
    "Historically-zero schedule interest income was not retained in PBT",
  );
  assert.notDeepEqual(
    repairedZeroGap.calculation.refs.filter((ref) => ref !== zeroGapIncome.row_id),
    repairedZeroGap.calculation.refs,
    "Missing live interest-income mutation escaped the PBT dependency oracle",
  );

  const nestedFinance = structuredClone(base);
  const nestedRows = nestedFinance.statement_structure.income_statement;
  const nestedPreTax = nestedRows.find((row) => row.semantic_role === "pre_tax_income");
  const nestedId = "independent_net_finance_result";
  nestedRows.splice(nestedRows.indexOf(nestedPreTax), 0, {
    row_id: nestedId,
    label: "Net finance result",
    row_type: "calculation",
    calculation: { operator: "sum", refs: ["interest_income", "interest_expense"] },
    forecast_period_calculations: [0, 1, 2].map(() => ({
      operator: "sum",
      refs: ["interest_income", "interest_expense"],
    })),
    historical_authority: "derived_formula",
    forecast_treatment: "formula",
  });
  nestedPreTax.calculation.refs = nestedPreTax.calculation.refs
    .filter((ref) => !["interest_income", "interest_expense"].includes(ref));
  nestedPreTax.calculation.refs.push(nestedId);
  for (const rule of nestedPreTax.forecast_period_calculations ?? []) {
    rule.refs = rule.refs.filter(
      (ref) => !["interest_income", "interest_expense"].includes(ref),
    );
    rule.refs.push(nestedId);
  }
  const preservedNested = normaliseStatementRows(
    nestedFinance,
    "income_statement",
  ).find((row) => row.semantic_role === "pre_tax_income");
  assert(preservedNested.calculation.refs.includes(nestedId));
  assert(!preservedNested.calculation.refs.includes("interest_income"));
  assert(!preservedNested.calculation.refs.includes("interest_expense"));

  const ambiguousFinancing = structuredClone(base);
  const ambiguousRows = ambiguousFinancing.statement_structure.cash_flow;
  const financingIndex = ambiguousRows.findIndex(
    (row) => row.semantic_role === "cash_from_financing",
  );
  ambiguousRows.splice(financingIndex, 0, {
    row_id: "second_cash_from_financing_authority",
    label: "Second financing authority",
    row_type: "calculation",
    semantic_role: "cash_from_financing",
    calculation: { operator: "sum", refs: ["dividends"] },
    historical_authority: "derived_formula",
  });
  assert.throws(
    () => normaliseStatementRows(ambiguousFinancing, "cash_flow"),
    /exactly one cash_from_financing authority/,
    "Ambiguous financing authorities did not fail closed",
  );
  const builds = new Map();
  for (const includesFx of [true, false]) {
    for (const explicitBuckets of [false, true]) {
      const key = `${includesFx ? "inclusive" : "exclusive"}-${explicitBuckets ? "buckets" : "legacy"}`;
      builds.set(key, await build(
        root,
        cashIdentityCase(base, { includesFx, explicitBuckets }),
        key,
      ));
    }
  }

  let formulaChecks = 0;
  let cacheChecks = 0;
  let debtConsolidationChecks = 0;
  for (const [key, built] of builds) {
    const net = built.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "net_change_in_cash",
    );
    const ending = built.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "ending_cash",
    );
    const financing = built.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "cash_from_financing",
    );
    const changeInDebt = built.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "change_in_debt",
    );
    assert(net && ending, `${key} lost a cash identity row`);
    assert(financing && changeInDebt, `${key} lost the financing/debt authority`);
    assert.equal(
      financing.calculation.refs.filter((ref) => ref === changeInDebt.row_id).length,
      1,
      `${key} financing subtotal must consume Change in Debt exactly once`,
    );
    for (const childRole of ["debt_issuance", "debt_repayment", "rcf_draw", "rcf_repayment"]) {
      const child = built.rowMap.statement_rows.cash_flow.find(
        (row) => row.semantic_role === childRole,
      );
      assert(child, `${key} lost ${childRole}`);
      assert.equal(child.forecast_capture_parent_id, changeInDebt.row_id);
      assert(!financing.calculation.refs.includes(child.row_id));
      assert(
        !(child.values ?? []).slice(3, 6).some(
          (value) => value !== null && value !== undefined && Number.isFinite(Number(value)),
        ),
        `${key} ${childRole} retained a separate forecast value below Change in Debt`,
      );
      debtConsolidationChecks += 1;
    }
    const columns = [
      ...built.rowMap.columns.forecast,
      ...built.rowMap.columns.adjustment,
      ...built.rowMap.columns.pro_forma,
    ];
    for (const column of columns) {
      assertDeclaredFormula(built.xml, built.rowMap, ending, column);
      formulaChecks += 1;
      assertDeclaredFormula(built.xml, built.rowMap, financing, column);
      assertDeclaredSumCache(built.xml, built.rowMap, financing, column);
      formulaChecks += 1;
      cacheChecks += 1;
      if (key.endsWith("buckets")) {
        assertDeclaredFormula(built.xml, built.rowMap, net, column);
        assertDeclaredSumCache(built.xml, built.rowMap, net, column);
        formulaChecks += 1;
        cacheChecks += 1;
      } else if (built.rowMap.columns.forecast.includes(column)) {
        assertDeclaredFormula(built.xml, built.rowMap, net, column);
        assertDeclaredSumCache(built.xml, built.rowMap, net, column);
        formulaChecks += 1;
        cacheChecks += 1;
      }
    }

    if (key.endsWith("buckets")) {
      const column = built.rowMap.columns.forecast[0];
      const debtCache = cachedNumber(built.xml, `${column}${changeInDebt.row}`);
      assert.notEqual(debtCache, 0, `${key} debt mutation is vacuous`);
      const missingDebt = declaredCachedSum(
        built.xml,
        built.rowMap,
        financing,
        column,
        changeInDebt.row,
      );
      assert.notEqual(
        missingDebt,
        cachedNumber(built.xml, `${column}${financing.row}`),
        `${key} missing-Change-in-Debt mutation escaped cache parity`,
      );
      debtConsolidationChecks += 1;
    }

    const fx = built.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "fx_effect_on_cash",
    );
    const firstForecast = built.rowMap.columns.forecast[0];
    const netText = formula(built.xml, `${firstForecast}${net.row}`);
    const endingText = formula(built.xml, `${firstForecast}${ending.row}`);
    if (key.startsWith("inclusive")) {
      assertMutationDetected(
        built.rowMap,
        ending,
        firstForecast,
        endingText,
        (refs) => [...refs, fx.row],
      );
      assertMutationDetected(
        built.rowMap,
        net,
        firstForecast,
        netText,
        (refs) => refs.filter((row) => row !== fx.row),
      );
    } else {
      assertMutationDetected(
        built.rowMap,
        net,
        firstForecast,
        netText,
        (refs) => [...refs, fx.row],
      );
      assertMutationDetected(
        built.rowMap,
        ending,
        firstForecast,
        endingText,
        (refs) => refs.filter((row) => row !== fx.row),
      );
    }
  }

  for (const includesFx of [true, false]) {
    const key = `${includesFx ? "inclusive" : "exclusive"}-legacy`;
    const baseline = builds.get(key);
    const mutated = await build(
      root,
      cashIdentityCase(base, { includesFx, explicitBuckets: false, fxBump: 1 }),
      `${key}-fx-plus-one`,
    );
    const baselineEnding = baseline.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "ending_cash",
    );
    const mutatedEnding = mutated.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "ending_cash",
    );
    for (const column of [
      baseline.rowMap.columns.forecast[0],
      baseline.rowMap.columns.pro_forma[0],
    ]) {
      assert.equal(
        cachedNumber(mutated.xml, `${column}${mutatedEnding.row}`) -
          cachedNumber(baseline.xml, `${column}${baselineEnding.row}`),
        1,
        `${key} ending-cash cache did not move exactly +1 with forecast FX`,
      );
    }
  }

  console.log(JSON.stringify({
    status: "PASS",
    formula_checks: formulaChecks,
    conventions: ["inclusive_fx", "exclusive_fx"],
    paths: ["standalone", "adjustment", "pro_forma", "explicit_cash_buckets"],
    cache_checks: cacheChecks,
    debt_consolidation_checks: debtConsolidationChecks + 1,
    interest_dependency_checks: 5,
    mutations: [
      "double_fx",
      "missing_fx",
      "forecast_fx_plus_one",
      "missing_change_in_debt",
    ],
  }, null, 2));
}

await main();
