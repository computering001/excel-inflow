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
  return [...formulaText.matchAll(/\b([A-Z]{1,3})(\d+)\b/g)]
    .filter((match) => match[1] === column)
    .map((match) => Number(match[2]));
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
  for (const [key, built] of builds) {
    const net = built.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "net_change_in_cash",
    );
    const ending = built.rowMap.statement_rows.cash_flow.find(
      (row) => row.semantic_role === "ending_cash",
    );
    assert(net && ending, `${key} lost a cash identity row`);
    const columns = [
      ...built.rowMap.columns.forecast,
      ...built.rowMap.columns.adjustment,
      ...built.rowMap.columns.pro_forma,
    ];
    for (const column of columns) {
      assertDeclaredFormula(built.xml, built.rowMap, ending, column);
      formulaChecks += 1;
      if (key.endsWith("buckets")) {
        assertDeclaredFormula(built.xml, built.rowMap, net, column);
        formulaChecks += 1;
      } else if (built.rowMap.columns.forecast.includes(column)) {
        assertDeclaredFormula(built.xml, built.rowMap, net, column);
        formulaChecks += 1;
      }
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
    mutations: ["double_fx", "missing_fx", "forecast_fx_plus_one"],
  }, null, 2));
}

await main();
