#!/usr/bin/env node
import assert from "node:assert/strict";
import { compileCase } from "./lib/case_compiler.mjs";
import { proposeCaseSource } from "./lib/case_source_proposer.mjs";
import {
  faceStatementManifestDigest,
  filingManifestCustodyErrors,
} from "./lib/face_statement_manifest.mjs";

function manifest(statement, rows, units = "millions") {
  const value = {
    schema_version: "face-statement-manifest/1.2",
    statement,
    statement_order: 1,
    source_id: `${statement}-precision-fixture`,
    document_sha256: "a".repeat(64),
    page_or_note: "page 1",
    periods: ["2023-12-31", "2024-12-31", "2025-12-31"],
    complete_face_statement: true,
    source_pages: [1],
    reporting_currency: "GBP",
    units,
    source_unit_labels: [`GBP ${units}`],
    row_count: rows.length,
    rows,
  };
  value.rows_sha256 = faceStatementManifestDigest(value);
  return value;
}

function row(sourceLineId, rawLabel, values, valuePrecisions, extra = {}) {
  return {
    source_line_id: sourceLineId,
    ordinal: extra.ordinal,
    raw_label: rawLabel,
    values,
    value_states: values.map((value) =>
      value === null ? "reported_blank" : value === 0 ? "reported_zero" : "reported_number"),
    value_precisions: valuePrecisions,
    structural_role: "body",
    page_or_note: "page 1",
    material: values.some((value) => value !== null && value !== 0),
    hierarchy_level: extra.hierarchy_level ?? 0,
    is_subtotal: extra.is_subtotal ?? false,
  };
}

function compileIncome(incomeRows) {
  incomeRows.forEach((item, index) => { item.ordinal = index + 1; });
  const cashRows = [row("cf.placeholder", "Unclassified cash-flow line", [1, 1, 1], [0, 0, 0], { ordinal: 1 })];
  const income = manifest("income_statement", incomeRows);
  const cashFlow = manifest("cash_flow", cashRows);
  const evidence = {
    face_statement_manifests: {
      income_statement: [income],
      cash_flow: [cashFlow],
    },
    lanes: { broker_pack: { metrics: {} } },
  };
  const source = proposeCaseSource({
    declarations: {
      identity: {
        issuer_name: "Precision Test plc",
        reporting_currency: "GBP",
        units: "millions",
      },
      policies: {},
      answers: [],
    },
    caseEvidence: evidence,
  });
  return {
    source,
    result: compileCase(source, evidence),
    income,
  };
}

const falseHalfUnit = compileIncome([
  row("is.a", "Component A", [100, 120, 140], [0, 0, 0]),
  row("is.b", "Component B", [10, 12, 14], [0, 0, 0]),
  row("is.total", "Operating total", [110.4, 132.4, 154.4], [1, 1, 1], { is_subtotal: true }),
]);
assert.equal(
  falseHalfUnit.result.model_case.statement_structure.income_statement
    .find((item) => item.row_id === "operating_total")?.row_type,
  "input",
  "A one-decimal subtotal was linked under the obsolete half-unit tolerance.",
);

const exactOneDecimal = compileIncome([
  row("is.a", "Component A", [100, 120, 140], [0, 0, 0]),
  row("is.b", "Component B", [10, 12, 14], [0, 0, 0]),
  row("is.total", "Operating total", [110, 132, 154], [1, 1, 1], { is_subtotal: true }),
]);
assert.equal(
  exactOneDecimal.result.model_case.statement_structure.income_statement
    .find((item) => item.row_id === "operating_total")?.row_type,
  "calculation",
  "An exact subtotal stopped compiling when source precision was introduced.",
);

const missingIsNotZero = compileIncome([
  row("is.a", "Component A", [100, 120, 140], [0, 0, 0]),
  row("is.blank", "Unreported component", [null, null, null], [null, null, null]),
  row("is.total", "Operating total", [100, 120, 140], [0, 0, 0], { is_subtotal: true }),
]);
assert.equal(
  missingIsNotZero.result.model_case.statement_structure.income_statement
    .find((item) => item.row_id === "operating_total")?.row_type,
  "input",
  "A reported blank was coerced to zero to manufacture an accounting identity.",
);

const precisionMutation = structuredClone(exactOneDecimal.income);
precisionMutation.rows[2].value_precisions = [0, 1, 1];
assert.notEqual(
  faceStatementManifestDigest(precisionMutation),
  exactOneDecimal.income.rows_sha256,
  "The face-statement seal did not bind period precision.",
);
assert.deepEqual(
  filingManifestCustodyErrors({
    manifest: exactOneDecimal.income,
    document: {
      source_id: exactOneDecimal.income.source_id,
      raw_sha256: exactOneDecimal.income.document_sha256,
    },
    section: "income_statement",
    filingFacts: { reporting_currency: "GBP", units: "millions" },
  }),
  [],
  "A complete v1.2 precision manifest failed custody.",
);
const invalidPrecision = structuredClone(exactOneDecimal.income);
invalidPrecision.rows[0].value_precisions[0] = null;
invalidPrecision.rows_sha256 = faceStatementManifestDigest(invalidPrecision);
assert(
  filingManifestCustodyErrors({
    manifest: invalidPrecision,
    document: {
      source_id: invalidPrecision.source_id,
      raw_sha256: invalidPrecision.document_sha256,
    },
    section: "income_statement",
    filingFacts: { reporting_currency: "GBP", units: "millions" },
  }).some((message) => message.includes("period precision")),
  "A numeric source cell without printed precision passed v1.2 custody.",
);

const aliasOnly = compileIncome([
  row("is.unresolved_revenue", "Revenue", [null, null, null], [null, null, null]),
  row("is.a", "Component A", [1, 2, 3], [0, 0, 0]),
  row("is.b", "Component B", [4, 5, 6], [0, 0, 0]),
]);
assert.equal(
  aliasOnly.source.statement_map.income_statement[0].role,
  undefined,
  "An exact alias became economic authority after the semantic classifier abstained.",
);

const evidenceBackedAlias = compileIncome([
  row("is.revenue", "Revenue", [100, 110, 120], [0, 0, 0]),
  row("is.a", "Component A", [1, 2, 3], [0, 0, 0]),
  row("is.b", "Component B", [4, 5, 6], [0, 0, 0]),
]);
assert.equal(
  evidenceBackedAlias.source.statement_map.income_statement[0].role,
  "revenue",
  "A numeric, statement-consistent classification lost its semantic role.",
);

const falseAttribution = compileIncome([
  row("is.net", "Profit for the period", [100, 110, 120], [0, 0, 0]),
  row("is.owners", "Owners of the parent", [94.4, 103.4, 112.4], [1, 1, 1]),
  row("is.nci", "Non-controlling interests", [6, 7, 8], [0, 0, 0]),
]);
assert.notEqual(
  falseAttribution.result.model_case.statement_structure.income_statement
    .find((item) => item.semantic_role === "owners_of_parent")
    ?.forecast_calculation?.operator,
  "subtract",
  "A one-decimal attribution row inherited the obsolete half-unit identity.",
);

const exactAttribution = compileIncome([
  row("is.net", "Profit for the period", [100, 110, 120], [0, 0, 0]),
  row("is.owners", "Owners of the parent", [94, 103, 112], [1, 1, 1]),
  row("is.nci", "Non-controlling interests", [6, 7, 8], [0, 0, 0]),
]);
assert.equal(
  exactAttribution.result.model_case.statement_structure.income_statement
    .find((item) => item.semantic_role === "owners_of_parent")
    ?.forecast_calculation?.operator,
  "subtract",
  "An exact attribution identity stopped compiling under period precision.",
);

console.log(JSON.stringify({ status: "PASS", checks: 10, mutations: 6 }, null, 2));
