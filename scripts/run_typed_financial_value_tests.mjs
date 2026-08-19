#!/usr/bin/env node
/**
 * P1.2 — Typed financial value tests.
 *
 * Invariant: blank, nil, missing, parse failure and unresolved are never
 * treated as zero.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  typedValue, numericValueOf, VALUE_BEARING_STATES, NEVER_ZERO_STATES,
} from "./lib/typed_financial_value.mjs";
import { validate, ValueState } from "./lib/generated/typed_financial_value_contract.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const python = option("python", "python3");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

// 1. All twelve minimum states exist, partitioned completely.
check(ValueState.length === 12, "exactly twelve minimum states");
check(VALUE_BEARING_STATES.length + NEVER_ZERO_STATES.length === 12,
  "value-bearing and never-zero states partition the twelve");

// 2. NEVER-ZERO: every absence state reads null, not 0 — and the shapes
// structurally REFUSE a value field.
const SAMPLES = {
  reported_blank: {},
  nil: { raw_text: "n/a" },
  missing: {},
  parse_failure: { raw_text: "1.2.3,4", failure_reason: "ambiguous European grouping" },
  period_support_required: { period: "2023-03-31" },
  captured: { capture_parent_id: "change_in_working_capital" },
  not_applicable: {},
  unresolved: {},
};
for (const [state, fields] of Object.entries(SAMPLES)) {
  const value = typedValue(state, fields);
  check(numericValueOf(value) === null, `${state} must read null`);
  check(numericValueOf(value) !== 0, `${state} must NEVER read zero`);
  const smuggled = { ...value, value: 0 };
  check(validate(smuggled).length > 0,
    `${state} must structurally refuse a smuggled value field`);
}

// 3. Value-bearing states read their value; reported_zero is an EXPLICIT zero.
check(numericValueOf(typedValue("reported_number", { value: -347.5, raw_text: "(347.5)" })) === -347.5,
  "reported_number reads its value");
check(numericValueOf(typedValue("reported_zero", { value: 0, raw_text: "-" })) === 0,
  "reported_zero reads an explicit zero");
check(numericValueOf(typedValue("derived_number", {
  value: 1053, derivation: { operator: "sum", refs: ["a", "b"] },
})) === 1053, "derived_number reads its value");
check(numericValueOf(typedValue("prior_filing_support", {
  value: 42.5,
  provenance: { prior_document_sha256: "a".repeat(64), prior_source_line_id: "is.7", prior_period_index: 0 },
})) === 42.5, "prior_filing_support reads its value");

// 4. reported_zero cannot carry a non-zero value (const 0).
check(validate({ contract_version: "1.0.0", state: "reported_zero", value: 5, raw_text: "5" }).length > 0,
  "reported_zero with a non-zero value must fail");

// 5. An invalid object THROWS on read — no silent null, no silent zero.
{
  let threw = false;
  try { numericValueOf({ state: "reported_number", value: 7 }); } catch { threw = true; }
  check(threw, "reading an unversioned object must throw");
}

// 6. Cross-language: Python binding agrees on all fourteen shape verdicts.
const cases = [
  ...Object.entries(SAMPLES).map(([state, fields]) => ({
    object: { contract_version: "1.0.0", state, ...fields }, valid: true,
  })),
  ...Object.entries(SAMPLES).map(([state, fields]) => ({
    object: { contract_version: "1.0.0", state, ...fields, value: 0 }, valid: false,
  })),
  { object: { contract_version: "1.0.0", state: "reported_zero", value: 5, raw_text: "5" }, valid: false },
  { object: { contract_version: "1.0.0", state: "reported_number", value: 1, raw_text: "1" }, valid: true },
];
const payloadPath = path.join(ROOT, "ci", "typed-value-cases.tmp.json");
await fs.writeFile(payloadPath, JSON.stringify(cases), "utf8");
const py = await exec(python, ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "scripts", "generated"))})
from typed_financial_value_contract import validate
cases = json.load(open(sys.argv[1]))
verdicts = [len(validate(case["object"])) == 0 for case in cases]
print(json.dumps(verdicts))
`, payloadPath]);
await fs.unlink(payloadPath);
const pyVerdicts = JSON.parse(py.stdout.trim());
cases.forEach((testCase, index) => {
  const jsValid = validate(testCase.object).length === 0;
  check(jsValid === testCase.valid, `JS verdict for case ${index} must be ${testCase.valid}`);
  check(pyVerdicts[index] === testCase.valid, `Python verdict for case ${index} must be ${testCase.valid}`);
  check(jsValid === pyVerdicts[index], `JS and Python must agree on case ${index}`);
});

console.log(JSON.stringify({ status: "PASS", checks }));
