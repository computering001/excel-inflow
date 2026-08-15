#!/usr/bin/env node
import assert from "node:assert/strict";
import { proposeCaseSource } from "./lib/case_source_proposer.mjs";
import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";

function manifest(statement, rows) {
  const value = {
    schema_version: "face-statement-manifest/1.0",
    statement,
    statement_order: 1,
    source_id: `${statement}-filing`,
    document_sha256: "a".repeat(64),
    page_or_note: "face statement",
    periods: ["2023-12-31", "2024-12-31", "2025-12-31"],
    complete_face_statement: true,
    row_count: rows.length,
    rows,
  };
  value.rows_sha256 = faceStatementManifestDigest(value);
  return value;
}

const income = manifest("income_statement", [
  { source_line_id: "is.rev", ordinal: 1, raw_label: "Revenue", values: [100, 110, 120], material: true },
  { source_line_id: "is.weird", ordinal: 2, raw_label: "BioVenture milestone remeasurement", values: [1, -2, 4], material: true },
  { source_line_id: "is.op", ordinal: 3, raw_label: "Operating profit", values: [20, 21, 24], material: true },
  { source_line_id: "is.da", ordinal: 4, raw_label: "Depreciation and amortisation", values: [-4, -5, -6], material: true },
  { source_line_id: "is.net", ordinal: 5, raw_label: "Profit after taxation", values: [12, 13, 15], material: true },
]);
const cashFlow = manifest("cash_flow", [
  { source_line_id: "cf.pbt", ordinal: 1, raw_label: "Profit before taxation", values: [20, 22, 25], material: true },
  { source_line_id: "cf.da", ordinal: 2, raw_label: "Depreciation and amortisation", values: [4, 5, 6], material: true },
  { source_line_id: "cf.tax_addback", ordinal: 3, raw_label: "Income tax charge", values: [3, 4, 5], material: true },
  { source_line_id: "cf.generated", ordinal: 4, raw_label: "Cash generated from operations", values: [24, 27, 31], material: true },
  { source_line_id: "cf.cfo", ordinal: 5, raw_label: "Net cash from operating activities", values: [17, 19, 22], material: true },
  { source_line_id: "cf.odd", ordinal: 6, raw_label: "Strategic collaboration settlements", values: [-2, -1, -3], material: true, parent_source_line_id: "cf.cfo" },
  { source_line_id: "cf.capex", ordinal: 7, raw_label: "Purchase of property, plant and equipment", values: [-5, -6, -7], material: true },
  { source_line_id: "cf.lease", ordinal: 8, raw_label: "Payment of lease liabilities", values: [-1, -1, -1], material: true },
  { source_line_id: "cf.change", ordinal: 9, raw_label: "Net increase/(decrease) in cash and cash equivalents", values: [2, 3, 4], material: true },
  { source_line_id: "cf.end", ordinal: 10, raw_label: "Cash and cash equivalents at end of year", values: [10, 12, 14], material: true },
]);
const evidence = {
  face_statement_manifests: { income_statement: [income], cash_flow: [cashFlow] },
  lanes: { broker_pack: { metrics: { revenue: {} } } },
};
const result = proposeCaseSource({
  declarations: {
    identity: { issuer_name: "Universal Test plc", reporting_currency: "GBP" },
    consumption: {}, policies: {}, answers: [],
  },
  caseEvidence: evidence,
});

assert.equal(result.statement_map.income_statement.length, 5);
assert.equal(result.statement_map.cash_flow.length, 10);
assert.equal(result.statement_map.income_statement[0].role, "revenue");
assert.equal(result.statement_map.income_statement[0].broker_metric_id, "revenue");
assert.equal(result.statement_map.income_statement[2].role, "operating_profit");
assert.equal(result.statement_map.income_statement[3].role, "is_da_expense");
assert.equal(result.statement_map.income_statement[4].role, "net_income");
assert.equal(result.statement_map.cash_flow[0].role, "cash_flow_profit_before_tax");
assert.equal(result.statement_map.cash_flow[1].role, "cash_flow_da");
assert.equal(result.statement_map.cash_flow[2].role, "cash_flow_tax_addback");
assert.equal(result.statement_map.cash_flow[3].role, "cash_generated_from_operations");
assert.equal(result.statement_map.cash_flow[4].role, "cash_from_operations");
assert.equal(result.statement_map.cash_flow[6].role, "capex");
assert.equal(result.statement_map.cash_flow[7].role, "lease_principal");
assert.equal(result.statement_map.cash_flow[8].role, "net_change_in_cash");
assert.equal(result.statement_map.cash_flow[9].role, "ending_cash");
assert.equal(result.statement_map.income_statement[1].disposition, "keep");
assert.equal(result.statement_map.income_statement[1].role, undefined);
assert.equal(result.statement_map.cash_flow[5].parent_source_line_id, "cf.cfo");
assert.equal(result.evidence_refs.face_statement_manifests.income_statement[0].digest, income.rows_sha256);
assert.equal(new Set([
  ...result.statement_map.income_statement,
  ...result.statement_map.cash_flow,
].map((row) => row.row_id)).size, 15);

const dcsBoundEvidence = structuredClone(evidence);
dcsBoundEvidence.lanes.policy_evidence = {
  rcf: { instrument_id: "rcf", commitment_fee_convention: "bps_on_undrawn" },
};
dcsBoundEvidence.lanes.instrument_term_authorities = [{
  instrument_id: "rcf",
  model_field: "commitment_fee_convention",
  output_value: "bps_on_undrawn",
}];
const dcsBound = proposeCaseSource({
  declarations: {
    identity: { issuer_name: "Universal Test plc", reporting_currency: "GBP" },
    policies: { rcf: { commitment_fee_convention: "none" } },
  },
  caseEvidence: dcsBoundEvidence,
});
assert.equal(
  dcsBound.policies.rcf.commitment_fee_convention,
  undefined,
  "A stale declaration overwrote exact DCS commitment-fee authority.",
);

console.log(JSON.stringify({ status: "PASS", checks: 23 }, null, 2));
