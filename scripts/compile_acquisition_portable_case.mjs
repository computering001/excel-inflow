#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { applyFundedAcquisitionRows } from "./lib/funded_acquisition_runtime.mjs";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error("Usage: compile_acquisition_portable_case.mjs <representative-model-case.json> <output.json>");
}
const source = JSON.parse(await fs.readFile(path.resolve(sourceArg), "utf8"));
const modelCase = structuredClone(source);
const forecastYears = (modelCase.periods ?? [])
  .filter((period) => period.status === "forecast")
  .map((period) => Number(String(period.date ?? period.label).slice(0, 4)));
if (forecastYears.length !== 3) throw new Error("Representative case does not contain exactly three forecast years.");
const closeYear = forecastYears[1];
const normalise = (value) => String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
let inputMutationCount = 0;
const seen = new Set();
function visit(node, acquisitionContext = false) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const [key, entry] of Object.entries(node)) {
    const token = normalise(key);
    const context = acquisitionContext || token.includes("acquisition") || token.includes("transaction");
    const assign = (value) => { node[key] = value; inputMutationCount += 1; };
    if (["transaction_enterprise_value", "transaction_value", "enterprise_value"].includes(token) && context) assign(1000);
    else if (["acquisition_debt_amount", "acquisition_debt", "debt_amount"].includes(token) && context) assign(400);
    else if (["close_year", "acquisition_close_year"].includes(token) && context) assign(closeYear);
    else if (["close_month", "acquisition_close_month"].includes(token) && context) assign(6);
    else if (["entry_ev_ebitda", "entry_ev_to_ebitda", "entry_multiple"].includes(token) && context) assign(10);
    else if (["incremental_debt_rate", "acquisition_debt_rate", "incremental_rate"].includes(token) && context) assign(0.05);
    else if (["enabled", "acquisition_on", "adjustment_columns_on", "acquisition_case"].includes(token) && context) {
      assign(typeof entry === "string" ? "On" : true);
    } else visit(entry, context);
  }
}
visit(modelCase);
if (inputMutationCount === 0) {
  throw new Error("Representative case exposes no canonical acquisition input surface.");
}
applyFundedAcquisitionRows(modelCase);
modelCase.run_metadata ??= {};
modelCase.run_metadata.portable_acquisition_case = {
  schema_version: "portable-acquisition-case/1.0",
  transaction_enterprise_value: 1000,
  acquisition_debt_amount: 400,
  close_year: closeYear,
  close_month: 6,
};
await fs.mkdir(path.dirname(path.resolve(outputArg)), { recursive: true });
await fs.writeFile(path.resolve(outputArg), `${JSON.stringify(modelCase, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "PASS", output: path.resolve(outputArg), close_year: closeYear, input_mutations: inputMutationCount }));
