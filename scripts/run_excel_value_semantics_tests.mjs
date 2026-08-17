#!/usr/bin/env node
import {
  applyExcelComparison,
  compareExcelValues,
} from "./lib/excel_value_semantics.mjs";

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

const failures = [];
for (const [name, left, right, operator, expected] of cases) {
  const actual = applyExcelComparison(left, right, operator, options);
  if (actual !== expected) failures.push({ name, expected, actual });
}
if (compareExcelValues(BLANK, "", options) !== 0) {
  failures.push({ name: "three-way blank/empty comparison", expected: 0 });
}

const report = {
  kind: "excel-value-semantics-tests/1.0",
  status: failures.length ? "FAIL" : "PASS",
  total: cases.length + 1,
  violations: failures.length,
  failures,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures.length ? 1 : 0;
