#!/usr/bin/env node
/**
 * The β refusal battery: feed compile_case deliberately broken inputs and
 * demand a NAMED finding for every one.  The compiler's promise is not only
 * "same answers from good declarations" — it is "no workbook from bad ones,
 * and the author is told exactly what broke, all at once."
 *
 * Usage: run_case_compiler_mutation_tests.mjs <source-dump.json>
 *   where the dump is written by run_case_compiler_equivalence.mjs with
 *   KEEL_WRITE_SOURCE=<dir> (a {caseSource, evidence} pair for one case).
 */

import fs from "node:fs/promises";
import process from "node:process";

import { compileCase } from "./lib/case_compiler.mjs";

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error("Usage: run_case_compiler_mutation_tests.mjs <source-dump.json>");
  process.exit(1);
}
const base = JSON.parse(await fs.readFile(sourcePath, "utf8"));
const clone = (value) => structuredClone(value);

const results = [];
function check(name, mutate, expectedFindingPattern) {
  const { caseSource, evidence } = clone(base);
  let outcome;
  try {
    mutate(caseSource, evidence);
    const { report } = compileCase(caseSource, evidence);
    const blocks = report.findings.filter((f) => f.severity === "BLOCK");
    const hit = blocks.find((f) =>
      expectedFindingPattern.test(`${f.id}: ${f.message}`),
    );
    outcome = hit
      ? { status: "PASS", detail: hit.id }
      : {
          status: "FAIL",
          detail: blocks.length
            ? `blocks fired but none matched ${expectedFindingPattern}: ${blocks.map((f) => f.id).join(", ").slice(0, 200)}`
            : "compiled CLEAN — the mutation was accepted silently",
        };
  } catch (error) {
    outcome = {
      status: "FAIL",
      detail: `compiler CRASHED instead of reporting: ${error.message.slice(0, 140)}`,
    };
  }
  results.push({ name, ...outcome });
}

// 1. A tampered manifest digest must fail the evidence seal.
check(
  "tampered manifest digest",
  (source) => {
    source.evidence_refs.face_statement_manifests.income_statement[0].digest = "0".repeat(64);
  },
  /seal|digest|evidence/i,
);

// 2. A statement_map entry pointing at a filed line the manifests never carried.
check(
  "map references a phantom filed line",
  (source) => {
    source.statement_map.income_statement.push({
      source_line_id: "is.phantom_line_never_filed",
      disposition: "keep",
      row_id: "phantom_row",
    });
  },
  /unknown|phantom|line|manifest/i,
);

// 3. A corrupted filed subtotal that no longer adds up must fail face additivity.
check(
  "corrupted filed subtotal value",
  (source, evidence) => {
    for (const manifest of evidence.face_statement_manifests.income_statement) {
      for (const row of manifest.rows) {
        if (row.is_subtotal && Array.isArray(row.values) && Number.isFinite(Number(row.values[0]))) {
          row.values = [Number(row.values[0]) + 999.99, ...row.values.slice(1)];
          return;
        }
      }
    }
    throw new Error("fixture has no filed subtotal to corrupt");
  },
  /face_additivity|reconcile|children sum/i,
);

// 4. derive_as pointing at a row nobody declares.
check(
  "derive_as references an unknown row",
  (source) => {
    const entry = source.statement_map.income_statement.find((candidate) => candidate.disposition === "keep");
    entry.derive_as = { operator: "sum", refs: ["row_that_does_not_exist"] };
  },
  /unknown|does_not_exist|refs|missing/i,
);

// 5. A declared derived row over unknown members.
check(
  "derived_rows references unknown members",
  (source) => {
    source.derived_rows = [
      ...(source.derived_rows ?? []),
      { row_id: "bogus_aggregate", section: "income_statement", operator: "sum", refs: ["ghost_a", "ghost_b"] },
    ];
  },
  /derived_rows\.unknown_ref|ghost/i,
);

// 6. Absorption into a line that is not kept.
check(
  "absorb into a missing absorber",
  (source) => {
    const entry = source.statement_map.income_statement.find((candidate) => candidate.disposition === "keep");
    entry.disposition = "absorb";
    delete entry.row_id;
    entry.absorb_into = "is.no_such_absorber";
  },
  /absorb/i,
);

// 7. FR-1: economic numerals outside the answers lane are UNWRITABLE.
check(
  "values smuggled into the statement map",
  (source) => {
    source.statement_map.income_statement[0].values = [100, 200, 300];
  },
  /schema|not an allowed property|additionalProperties|values/i,
);

// 8. FR-3/9: formula text is unwritable anywhere in the source.
check(
  "formula text smuggled into a declaration",
  (source) => {
    source.statement_map.income_statement[0].formula = "=B2+C2";
  },
  /schema|not an allowed property|additionalProperties|formula/i,
);

// 9. A schema-invalid operator cannot enter.
check(
  "unknown derive_as operator",
  (source) => {
    const entry = source.statement_map.income_statement.find((candidate) => candidate.disposition === "keep");
    entry.derive_as = { operator: "multiply_by_vibes", refs: ["revenue"] };
  },
  /schema|enum|operator/i,
);

// 10. add_to_parent pointing at a non-calculating row.
check(
  "membership declared in a non-calculating parent",
  (source) => {
    source.derived_rows = [
      ...(source.derived_rows ?? []),
      {
        row_id: "orphan_shell", section: "cash_flow", operator: "sum", refs: [],
        role: "non_cash_interest_addback", add_to_parent: "row_without_formula_anywhere",
      },
    ];
  },
  /derived_rows\.parent|not a calculating row|unknown/i,
);

let failed = 0;
for (const result of results) {
  const mark = result.status === "PASS" ? "✓" : "✗";
  if (result.status !== "PASS") failed += 1;
  console.log(`${mark} ${result.name} — ${result.detail}`);
}
console.log(JSON.stringify({ status: failed === 0 ? "PASS" : "FAIL", total: results.length, failed }));
process.exit(failed === 0 ? 0 : 1);
