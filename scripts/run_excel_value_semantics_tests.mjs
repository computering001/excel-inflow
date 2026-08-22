#!/usr/bin/env node

import { createRunner } from "./lib/test_harness.mjs";
import {
  applyExcelComparison,
  compareExcelValues,
} from "./lib/excel_value_semantics.mjs";

const run = createRunner({
  name: "excel_value_semantics_tests",
  importMetaUrl: import.meta.url,
});

const BLANK = Symbol("blank");
const options = { isBlank: (value) => value === BLANK };
const cases = [
  ["blank equals blank", BLANK, BLANK, "=", true],
  ["blank equals empty text", BLANK, "", "=", true],
  ["empty text equals blank", "", BLANK, "=", true],
  ["blank equals zero", BLANK, 0, "=", true],
  ["zero equals blank", 0, BLANK, "=", true],
  ["empty text differs from zero", "", 0, "=", false],
  ["blank differs from one", BLANK, 1, "<>", true],
  ["blank is below one", BLANK, 1, "<", true],
  ["blank is above minus one", BLANK, -1, ">", true],
  ["blank is below text", BLANK, "A", "<", true],
  ["text comparison ignores case", "alpha", "ALPHA", "=", true],
  ["numeric text is not a number", "1", 1, "=", false],
  ["number sorts below text", 1, "1", "<", true],
  ["boolean numeric convention remains stable", true, 1, "=", true],
];

for (const [name, left, right, operator, expected] of cases) {
  run.check(name, () => applyExcelComparison(left, right, operator, options) === expected);
}
run.check("three-way blank/empty comparison", () => compareExcelValues(BLANK, "", options) === 0);

run.finish({
  kind: "excel-value-semantics-tests/1.0",
  total: cases.length + 1,
  violations: 0,
});
