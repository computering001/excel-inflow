#!/usr/bin/env node
/**
 * P1.2 — Typed financial value tests.
 *
 * Invariant: blank, nil, missing, parse failure and unresolved are never
 * treated as zero.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  typedValue, numericValueOf, VALUE_BEARING_STATES, NEVER_ZERO_STATES,
} from "./lib/typed_financial_value.mjs";
import { validate, ValueState } from "./lib/generated/typed_financial_value_contract.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "typed_financial_value_tests", importMetaUrl: import.meta.url });
const { exec, parsed } = run.runCli(({ option }) => ({ python: option("python", "python3") }));
const python = parsed.python;
const ROOT = run.ROOT;

// 1. All twelve minimum states exist, partitioned completely.
run.check("exactly twelve minimum states", () => {
  assert.ok(ValueState.length === 12);
  return true;
});
run.check("value-bearing and never-zero states partition the twelve", () => {
  assert.ok(VALUE_BEARING_STATES.length + NEVER_ZERO_STATES.length === 12);
  return true;
});

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
  run.check(`${state} must read null`, () => {
    assert.ok(numericValueOf(value) === null);
    return true;
  });
  run.check(`${state} must NEVER read zero`, () => {
    assert.ok(numericValueOf(value) !== 0);
    return true;
  });
  const smuggled = { ...value, value: 0 };
  run.check(`${state} must structurally refuse a smuggled value field`, () => {
    assert.ok(validate(smuggled).length > 0);
    return true;
  });
}

// 3. Value-bearing states read their value; reported_zero is an EXPLICIT zero.
run.check("reported_number reads its value", () => {
  assert.ok(numericValueOf(typedValue("reported_number", { value: -347.5, raw_text: "(347.5)" })) === -347.5);
  return true;
});
run.check("reported_zero reads an explicit zero", () => {
  assert.ok(numericValueOf(typedValue("reported_zero", { value: 0, raw_text: "-" })) === 0);
  return true;
});
run.check("derived_number reads its value", () => {
  assert.ok(numericValueOf(typedValue("derived_number", {
    value: 1053, derivation: { operator: "sum", refs: ["a", "b"] },
  })) === 1053);
  return true;
});
run.check("prior_filing_support reads its value", () => {
  assert.ok(numericValueOf(typedValue("prior_filing_support", {
    value: 42.5,
    provenance: { prior_document_sha256: "a".repeat(64), prior_source_line_id: "is.7", prior_period_index: 0 },
  })) === 42.5);
  return true;
});

// 4. reported_zero cannot carry a non-zero value (const 0).
run.check("reported_zero with a non-zero value must fail", () => {
  assert.ok(validate({ contract_version: "1.0.0", state: "reported_zero", value: 5, raw_text: "5" }).length > 0);
  return true;
});

// 5. An invalid object THROWS on read — no silent null, no silent zero.
{
  let threw = false;
  try { numericValueOf({ state: "reported_number", value: 7 }); } catch { threw = true; }
  run.check("reading an unversioned object must throw", () => {
    assert.ok(threw);
    return true;
  });
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
  run.check(`JS verdict for case ${index} must be ${testCase.valid}`, () => {
    assert.ok(jsValid === testCase.valid);
    return true;
  });
  run.check(`Python verdict for case ${index} must be ${testCase.valid}`, () => {
    assert.ok(pyVerdicts[index] === testCase.valid);
    return true;
  });
  run.check(`JS and Python must agree on case ${index}`, () => {
    assert.ok(jsValid === pyVerdicts[index]);
    return true;
  });
});

run.finish();
