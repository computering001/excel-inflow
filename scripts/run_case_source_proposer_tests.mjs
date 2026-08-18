#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  proposeCaseSource,
  writeRuntimeEvidenceLanes,
} from "./lib/case_source_proposer.mjs";
import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";
import { compileCase, sourceHistoricalSumMatches } from "./lib/case_compiler.mjs";

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
  { source_line_id: "is.rev", ordinal: 1, raw_label: "Total net sales", values: [100, 110, 120], material: true },
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

const inclusiveCashChange = { values: [9, 12, 15] };
const activityCashFlows = [
  { values: [10, 20, 30] },
  { values: [-3, -6, -9] },
  { values: [1, -4, -9] },
];
const filedFxCash = { values: [1, 2, 3] };
assert.equal(
  sourceHistoricalSumMatches(inclusiveCashChange, [...activityCashFlows, filedFxCash]),
  true,
  "A filed cash-change total that includes FX was not proved from its source histories.",
);
assert.equal(
  sourceHistoricalSumMatches(inclusiveCashChange, activityCashFlows),
  false,
  "A cash-change total including FX was misread as an activity-only subtotal.",
);
const fxMutation = structuredClone(filedFxCash);
fxMutation.values[2] = 4;
assert.equal(
  sourceHistoricalSumMatches(inclusiveCashChange, [...activityCashFlows, fxMutation]),
  false,
  "A one-period FX mutation survived the source cash-change identity proof.",
);

assert.equal(result.statement_map.income_statement.length, 5);
assert.equal(result.statement_map.cash_flow.length, 10);
assert.equal(result.statement_map.income_statement[0].role, "revenue");
assert.equal(result.statement_map.income_statement[0].broker_metric_id, "revenue");
assert.equal(result.statement_map.income_statement[2].role, "ebit");
assert.equal(result.statement_map.income_statement[3].role, "is_da_expense");
assert.equal(result.statement_map.income_statement[4].role, "net_income");
assert.equal(result.statement_map.cash_flow[0].role, "cash_flow_net_income");
assert.equal(result.statement_map.cash_flow[1].role, "cash_flow_da");
assert.equal(result.statement_map.cash_flow[2].role, "cash_flow_tax_addback");
assert.equal(result.statement_map.cash_flow[3].role, "cash_generated_from_operations");
assert.equal(result.statement_map.cash_flow[4].role, "cash_from_operations");
assert.equal(result.statement_map.cash_flow[6].role, undefined);
assert.equal(result.statement_map.cash_flow[6].row_id, "ppe_purchases");
assert.equal(result.statement_map.cash_flow[7].role, "lease_principal");
assert.equal(result.statement_map.cash_flow[8].role, "net_change_in_cash");
assert.equal(result.statement_map.cash_flow[9].role, "ending_cash");
assert.equal(result.statement_map.income_statement[1].disposition, "keep");

const dualEbitIncome = manifest("income_statement", [
  { source_line_id: "is.revenue", ordinal: 1, raw_label: "Revenue", values: [100, 110, 120], material: true },
  { source_line_id: "is.ebit", ordinal: 2, raw_label: "EBIT", values: [20, 21, 24], material: true },
  { source_line_id: "is.operating_profit", ordinal: 3, raw_label: "Operating profit", values: [19, 20, 23], material: true },
]);
const dualEbitSource = proposeCaseSource({
  declarations: { identity: { issuer_name: "Dual EBIT Test plc", reporting_currency: "GBP" } },
  caseEvidence: {
    face_statement_manifests: { income_statement: [dualEbitIncome], cash_flow: [cashFlow] },
    lanes: {},
  },
});
assert.deepEqual(
  dualEbitSource.statement_map.income_statement.map((row) => row.role).filter(Boolean),
  ["revenue", "ebit", "operating_profit"],
  "A distinct printed EBIT mutation collapsed the separate operating-profit surface.",
);
assert.equal(result.statement_map.income_statement[1].role, undefined);
assert.equal(result.statement_map.cash_flow[5].parent_source_line_id, "cf.cfo");
assert.equal(result.evidence_refs.face_statement_manifests.income_statement[0].digest, income.rows_sha256);
assert.equal(new Set([
  ...result.statement_map.income_statement,
  ...result.statement_map.cash_flow,
].map((row) => row.row_id)).size, 15);

const fxCashFlow = manifest("cash_flow", [
  {
    source_line_id: "cf.fx_effect",
    ordinal: 1,
    raw_label: "Effect of exchange rate changes on cash",
    values: [1, -2, 3],
    material: true,
  },
]);
const fxEvidence = structuredClone(evidence);
fxEvidence.face_statement_manifests.cash_flow = [fxCashFlow];
const fxSource = proposeCaseSource({
  declarations: {
    identity: { issuer_name: "FX Identity Test plc", reporting_currency: "GBP" },
  },
  caseEvidence: fxEvidence,
});
assert.equal(
  fxSource.statement_map.cash_flow[0].role,
  "fx_effect_on_cash",
  "A filed FX effect line lost the semantic role required by the cash identity.",
);

const restrictedCashFlow = manifest("cash_flow", [
  {
    source_line_id: "cf.opening_restricted_cash",
    ordinal: 1,
    raw_label: "Cash, cash equivalents, and restricted cash and cash equivalents, beginning balances",
    values: [8, 9, 10],
    material: true,
  },
  {
    source_line_id: "cf.ending_restricted_cash",
    ordinal: 2,
    raw_label: "Cash, cash equivalents, and restricted cash and cash equivalents, ending balances",
    values: [9, 10, 11],
    material: true,
  },
]);
const restrictedCashSource = proposeCaseSource({
  declarations: {
    identity: { issuer_name: "Restricted Cash Test plc", reporting_currency: "USD" },
  },
  caseEvidence: {
    face_statement_manifests: { income_statement: [income], cash_flow: [restrictedCashFlow] },
    lanes: {},
  },
});
assert.deepEqual(
  restrictedCashSource.statement_map.cash_flow.map((row) => row.role),
  ["opening_cash", "ending_cash"],
  "Canonical restricted-cash balance captions were not mapped to the cash bridge.",
);

const genericUsGaapIncome = manifest("income_statement", [{
  source_line_id: "is.total_revenues",
  ordinal: 1,
  raw_label: "Total revenues",
  values: [100, 110, 120],
  material: true,
}, {
  source_line_id: "is.pre_tax",
  ordinal: 2,
  raw_label: "Income before income tax expense and income from equity method investments",
  values: [20, 21, 22],
  material: true,
}]);
const genericUsGaapCashFlow = manifest("cash_flow", [
  { source_line_id: "cf.dda", ordinal: 1, raw_label: "Depreciation, depletion and amortization", values: [4, 5, 6], material: true },
  { source_line_id: "cf.capex", ordinal: 2, raw_label: "Purchases of property, plant and equipment, and intangibles", values: [-5, -6, -7], material: true },
  { source_line_id: "cf.debt_issuance", ordinal: 3, raw_label: "Proceeds from debt issuances", values: [8, 9, 10], material: true },
  { source_line_id: "cf.debt_repayment", ordinal: 4, raw_label: "Payments on debt", values: [-3, -4, -5], material: true },
  { source_line_id: "cf.financing", ordinal: 5, raw_label: "Net cash provided by (used in) financing activities", values: [5, 5, 5], material: true },
  { source_line_id: "cf.change", ordinal: 6, raw_label: "Increase (decrease) in cash and cash equivalents, including restricted cash", values: [2, -1, 3], material: true },
  { source_line_id: "cf.open", ordinal: 7, raw_label: "Cash and cash equivalents and restricted cash at the beginning of year", values: [8, 10, 9], material: true },
  { source_line_id: "cf.end", ordinal: 8, raw_label: "Cash and cash equivalents and restricted cash at the end of year", values: [10, 9, 12], material: true },
]);
const genericUsGaapSource = proposeCaseSource({
  declarations: { identity: { issuer_name: "Generic US GAAP Test", reporting_currency: "USD" } },
  caseEvidence: {
    face_statement_manifests: {
      income_statement: [genericUsGaapIncome],
      cash_flow: [genericUsGaapCashFlow],
    },
    lanes: {},
  },
});
assert.deepEqual(
  genericUsGaapSource.statement_map.income_statement.map((row) => row.role),
  ["revenue", "pre_tax_income"],
  "Generic US-GAAP revenue and pre-tax captions did not retain their economic roles.",
);
assert.deepEqual(
  genericUsGaapSource.statement_map.cash_flow.map((row) => row.role),
  ["cash_flow_da", "capex", "debt_issuance", "debt_repayment", "cash_from_financing", "net_change_in_cash", "opening_cash", "ending_cash"],
  "Generic US-GAAP face-statement captions did not retain their exact economic roles.",
);
const impairmentMutation = structuredClone(genericUsGaapCashFlow);
impairmentMutation.rows[0].raw_label = "Depreciation, depletion, amortization and impairment";
impairmentMutation.rows_sha256 = faceStatementManifestDigest(impairmentMutation);
const impairmentMutationSource = proposeCaseSource({
  declarations: { identity: { issuer_name: "Generic US GAAP Mutation", reporting_currency: "USD" } },
  caseEvidence: {
    face_statement_manifests: {
      income_statement: [genericUsGaapIncome],
      cash_flow: [impairmentMutation],
    },
    lanes: {},
  },
});
assert.notEqual(
  impairmentMutationSource.statement_map.cash_flow[0].role,
  "cash_flow_da",
  "Adding impairment to a DDA caption was still admitted as pure D&A.",
);

const typedIncome = manifest("income_statement", [
  {
    source_line_id: "is.unresolved_body",
    ordinal: 1,
    raw_label: "Unresolved operating movement",
    values: [null, null, null],
    value_states: ["unresolved", "unresolved", "unresolved"],
    structural_role: "body",
    material: true,
  },
  {
    source_line_id: "is.positive_heading",
    ordinal: 2,
    raw_label: "Operating components",
    values: [null, null, null],
    value_states: ["reported_blank", "reported_blank", "reported_blank"],
    structural_role: "header",
    material: false,
  },
  {
    source_line_id: "is.explicit_zero",
    ordinal: 3,
    raw_label: "Explicit nil movement",
    values: [0, 0, 0],
    value_states: ["reported_zero", "reported_zero", "reported_zero"],
    structural_role: "body",
    material: false,
  },
  {
    source_line_id: "is.core_operating_profit",
    ordinal: 4,
    raw_label: "Core operating profit",
    values: [11, 12, 13],
    value_states: ["reported_number", "reported_number", "reported_number"],
    structural_role: "body",
    material: true,
  },
  {
    source_line_id: "is.combined_da_impairment",
    ordinal: 5,
    raw_label: "Depreciation, amortisation and impairment",
    values: [-4, -5, -6],
    value_states: ["reported_number", "reported_number", "reported_number"],
    structural_role: "body",
    material: true,
  },
]);
const typedEvidence = structuredClone(evidence);
typedEvidence.face_statement_manifests.income_statement = [typedIncome];
const typedSource = proposeCaseSource({
  declarations: {
    identity: { issuer_name: "Typed Value Test plc", reporting_currency: "GBP" },
  },
  caseEvidence: typedEvidence,
});
assert.equal(
  typedSource.statement_map.income_statement[0].header,
  undefined,
  "An unresolved body row was promoted to a presentation header.",
);
assert.equal(
  typedSource.statement_map.income_statement[1].header,
  true,
  "Positive structural header evidence was not preserved.",
);
assert.notEqual(
  faceStatementManifestDigest({
    ...typedIncome,
    rows: typedIncome.rows.map((row, index) =>
      index === 0
        ? { ...row, value_states: ["reported_zero", "unresolved", "unresolved"] }
        : row,
    ),
  }),
  typedIncome.rows_sha256,
  "The manifest seal did not bind typed value states.",
);
assert.deepEqual(
  typedIncome.rows[2].values,
  [0, 0, 0],
  "Explicit reported zero was not preserved as numeric zero.",
);
assert.equal(
  typedSource.statement_map.income_statement[3].role,
  "adjusted_ebit",
  "Company-adjusted operating profit collapsed into statutory EBIT.",
);
assert.equal(
  typedSource.statement_map.income_statement[4].role,
  "depreciation_amortisation_and_impairment",
  "A combined impairment line was admitted as pure D&A.",
);

const attributionIncome = manifest("income_statement", [
  { source_line_id: "is.net", ordinal: 1, raw_label: "Profit for the period", values: [100, 110, 120], material: true },
  { source_line_id: "is.owners", ordinal: 2, raw_label: "Owners of the parent", values: [94, 103, 112], material: true },
  { source_line_id: "is.nci", ordinal: 3, raw_label: "Non-controlling interests", values: [6, 7, 8], material: true },
]);
const attributionEvidence = structuredClone(evidence);
attributionEvidence.face_statement_manifests.income_statement = [attributionIncome];
const attributionSource = proposeCaseSource({
  declarations: {
    identity: { issuer_name: "Attribution Test plc", reporting_currency: "GBP" },
  },
  caseEvidence: attributionEvidence,
});
assert.equal(
  attributionSource.statement_map.income_statement[1].role,
  "owners_of_parent",
  "The proposer did not preserve parent-owner attribution as a semantic output.",
);
assert.equal(
  attributionSource.statement_map.income_statement[2].role,
  "non_controlling_interests",
  "The proposer did not preserve non-controlling attribution as a semantic output.",
);

const sourceProvedAttribution = manifest("income_statement", [
  { source_line_id: "is.net", ordinal: 1, raw_label: "Net income", values: [100, 110, 120], material: true, parent_source_line_id: "is.owner" },
  { source_line_id: "is.redeemable_nci", ordinal: 2, raw_label: "Net income attributable to redeemable noncontrolling interests", values: [-2, -3, -4], material: true, parent_source_line_id: "is.owner" },
  { source_line_id: "is.nci", ordinal: 3, raw_label: "Net income loss attributable to noncontrolling interests", values: [-1, -2, -3], material: true, parent_source_line_id: "is.owner" },
  { source_line_id: "is.owner", ordinal: 4, raw_label: "Net income attributable to Example Group", values: [97, 105, 113], material: true, is_subtotal: true },
]);
const sourceProvedAttributionResult = proposeCaseSource({
  declarations: { identity: { issuer_name: "Example Group", reporting_currency: "USD" } },
  caseEvidence: {
    face_statement_manifests: { income_statement: [sourceProvedAttribution], cash_flow: [cashFlow] },
    lanes: {},
  },
});
assert.deepEqual(
  sourceProvedAttributionResult.statement_map.income_statement.map((row) => row.role),
  ["net_income", "redeemable_non_controlling_interests", "non_controlling_interests", "owners_of_parent"],
  "A source-proved issuer-named owner attribution was not preserved.",
);
const attributionTopologyMutation = structuredClone(sourceProvedAttribution);
delete attributionTopologyMutation.rows[0].parent_source_line_id;
attributionTopologyMutation.rows_sha256 = faceStatementManifestDigest(attributionTopologyMutation);
const attributionTopologyMutationResult = proposeCaseSource({
  declarations: { identity: { issuer_name: "Example Group", reporting_currency: "USD" } },
  caseEvidence: {
    face_statement_manifests: { income_statement: [attributionTopologyMutation], cash_flow: [cashFlow] },
    lanes: {},
  },
});
assert.notEqual(
  attributionTopologyMutationResult.statement_map.income_statement[3].role,
  "owners_of_parent",
  "Issuer wording assigned owner attribution after the source hierarchy proof was removed.",
);

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

const firstRunEvidence = {
  filings: {
    historical_periods: ["2023-12-31", "2024-12-31", "2025-12-31"],
    forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
    historical_gross_debt: [40, 45, 50],
    reported_lease_liability: 7,
    maximum_residual_percentage: 0.02,
  },
  source_inventory: [income, cashFlow].map((item) => ({
    source_id: item.source_id,
    publication_date: "2026-03-01",
  })),
  broker_pack: {},
  case_evidence: structuredClone(evidence),
};
writeRuntimeEvidenceLanes({ evidence: firstRunEvidence, caseSource: result });
const runtimeLanes = firstRunEvidence.case_evidence.lanes;
assert.equal(runtimeLanes.periods.length, 6, "The runtime writer did not author 3H+3F periods.");
assert.deepEqual(
  runtimeLanes.operating_metrics.revenue.values.slice(0, 3),
  [100, 110, 120],
  "The runtime writer did not project filed revenue history.",
);
assert.deepEqual(
  runtimeLanes.operating_metrics.adjusted_ebitda.values.slice(0, 3),
  [24, 26, 30],
  "The runtime writer did not derive the filed EBIT plus D&A bridge.",
);
assert.equal(
  runtimeLanes.selected_ebitda_basis.semantic_role,
  "reported_ebitda",
  "Statutory EBIT plus compatible D&A was mislabeled as adjusted EBITDA.",
);
assert.equal(
  runtimeLanes.selected_ebitda_basis.derivation,
  "reported_ebit_plus_compatible_da",
  "The selected EBITDA derivation was not sealed in provenance.",
);
assert.deepEqual(
  runtimeLanes.operating_metrics.capex.values.slice(0, 3),
  [5, 6, 7],
  "The runtime writer did not project capex on the model outflow basis.",
);
assert.equal(runtimeLanes.policy_evidence.cash.opening_cash, 14);
assert.deepEqual(runtimeLanes.debt_reconciliation.reported_opening_gross_debt, [40, 45, 50]);
assert.deepEqual(
  runtimeLanes.other_interest,
  [0, 0, 0],
  "The runtime writer did not author the required zero residual-interest series.",
);
assert.deepEqual(runtimeLanes.historical_supplement.prior_cash_and_cash_equivalents, [10, 12]);
assert.equal(runtimeLanes.provenance.revenue.length, 3);
assert.equal(runtimeLanes.provenance.revenue[0].document, income.source_id);

const compiledBasisCase = compileCase(
  result,
  firstRunEvidence.case_evidence,
).model_case;
const compiledIncome = compiledBasisCase.statement_structure.income_statement;
const compiledEbitda = compiledIncome.find(
  (row) => row.semantic_role === "reported_ebitda",
);
assert(compiledEbitda, "The compiler did not type statutory EBIT plus D&A as reported EBITDA.");
assert.equal(compiledEbitda.label, "EBITDA");
assert.equal(compiledBasisCase.selected_ebitda_basis.row_id, compiledEbitda.row_id);
assert.equal(compiledBasisCase.selected_ebitda_basis.impairment_included, false);
const compiledFcfConversion = compiledBasisCase.statement_structure.cash_flow.find(
  (row) => row.row_id === "free_cash_flow_conversion",
);
assert.equal(
  compiledFcfConversion?.calculation?.refs?.[1],
  compiledEbitda.row_id,
  "FCF conversion did not consume the selected reported-EBITDA basis.",
);

function cashConventionManifest(netChangeValues, openingValues, endingValues) {
  const typed = (sourceLineId, ordinal, rawLabel, values) => ({
    source_line_id: sourceLineId,
    ordinal,
    raw_label: rawLabel,
    values,
    value_states: values.map((value) => value === 0 ? "reported_zero" : "reported_number"),
    value_precisions: [0, 0, 0],
    material: true,
  });
  return manifest("cash_flow", [
    typed("cf.cfo", 1, "Net cash provided by operating activities", [10, 20, 30]),
    typed("cf.cfi", 2, "Net cash used in investing activities", [-3, -6, -9]),
    typed("cf.cff", 3, "Net cash used in financing activities", [1, -4, -9]),
    typed("cf.fx", 4, "Effect of exchange rate changes on cash", [1, 2, 3]),
    typed("cf.change", 5, "Net increase in cash and cash equivalents", netChangeValues),
    typed("cf.open", 6, "Cash and cash equivalents at beginning of year", openingValues),
    typed("cf.end", 7, "Cash and cash equivalents at end of year", endingValues),
  ]);
}

function compileCashConvention(cashManifest, issuerName) {
  const caseEvidence = {
    face_statement_manifests: {
      income_statement: [income],
      cash_flow: [cashManifest],
    },
    lanes: structuredClone(firstRunEvidence.case_evidence.lanes),
  };
  const source = proposeCaseSource({
    declarations: {
      identity: { issuer_name: issuerName, reporting_currency: "USD" },
      consumption: {},
      policies: {},
      answers: [],
    },
    caseEvidence,
  });
  return compileCase(source, caseEvidence).model_case;
}

const inclusiveConvention = compileCashConvention(
  cashConventionManifest([9, 12, 15], [100, 109, 121], [109, 121, 136]),
  "Inclusive FX Convention Test Co",
);
const inclusiveCashRows = new Map(
  inclusiveConvention.statement_structure.cash_flow.map((row) => [row.semantic_role, row]),
);
assert(
  inclusiveCashRows.get("net_change_in_cash").calculation.refs.includes(
    inclusiveCashRows.get("fx_effect_on_cash").row_id,
  ),
  "The inclusive source convention omitted FX from net cash change.",
);
assert(
  !inclusiveCashRows.get("ending_cash").calculation.refs.includes(
    inclusiveCashRows.get("fx_effect_on_cash").row_id,
  ),
  "The inclusive source convention double-counted FX in ending cash.",
);

const exclusiveConvention = compileCashConvention(
  cashConventionManifest([8, 10, 12], [100, 108, 118], [109, 120, 133]),
  "Exclusive FX Convention Test Co",
);
const exclusiveCashRows = new Map(
  exclusiveConvention.statement_structure.cash_flow.map((row) => [row.semantic_role, row]),
);
assert(
  !exclusiveCashRows.get("net_change_in_cash").calculation.refs.includes(
    exclusiveCashRows.get("fx_effect_on_cash").row_id,
  ),
  "The exclusive source convention added FX to net cash change.",
);
assert(
  exclusiveCashRows.get("ending_cash").calculation.refs.includes(
    exclusiveCashRows.get("fx_effect_on_cash").row_id,
  ),
  "The exclusive source convention omitted FX from ending cash.",
);

assert.throws(
  () => compileCashConvention(
    cashConventionManifest([9, 10, 15], [100, 109, 119], [109, 121, 137]),
    "Contradictory FX Convention Mutation Co",
  ),
  /mixes inclusive and exclusive FX conventions/,
  "A mixed-period cash FX convention did not fail closed.",
);

const unsupportedIncome = manifest(
  "income_statement",
  income.rows.filter((row) => row.source_line_id !== "is.da"),
);
const unsupportedCashFlow = manifest(
  "cash_flow",
  cashFlow.rows.filter((row) => row.source_line_id !== "cf.da"),
);
const unsupportedCaseEvidence = {
  face_statement_manifests: {
    income_statement: [unsupportedIncome],
    cash_flow: [unsupportedCashFlow],
  },
  lanes: { broker_pack: { metrics: { revenue: {} } } },
};
const unsupportedSource = proposeCaseSource({
  declarations: {
    identity: { issuer_name: "Unsupported EBITDA Test plc", reporting_currency: "GBP" },
    consumption: {}, policies: {}, answers: [],
  },
  caseEvidence: unsupportedCaseEvidence,
});
const unsupportedRun = {
  filings: structuredClone(firstRunEvidence.filings),
  source_inventory: [unsupportedIncome, unsupportedCashFlow].map((item) => ({
    source_id: item.source_id,
    publication_date: "2026-03-01",
  })),
  broker_pack: {},
  case_evidence: unsupportedCaseEvidence,
};
writeRuntimeEvidenceLanes({ evidence: unsupportedRun, caseSource: unsupportedSource });
assert.equal(
  unsupportedRun.case_evidence.lanes.selected_ebitda_basis,
  undefined,
  "The runtime writer invented an EBITDA basis without compatible D&A.",
);
const unsupportedCompiled = compileCase(
  unsupportedSource,
  unsupportedRun.case_evidence,
).model_case;
assert.equal(
  unsupportedCompiled.statement_structure.income_statement.some((row) =>
    ["reported_ebitda", "adjusted_ebitda"].includes(row.semantic_role),
  ),
  false,
  "The compiler invented an unsupported EBITDA row.",
);

const richerEvidence = structuredClone(firstRunEvidence);
const sealedOperatingLane = {
  revenue: {
    values: [999, 999, 999, null, null, null],
    forecast_method: "sealed_fixture",
    source_kind: "independently_verified",
  },
};
richerEvidence.case_evidence.lanes.operating_metrics = structuredClone(sealedOperatingLane);
richerEvidence.case_evidence.lanes.other_interest = [1, 2, 3];
richerEvidence.case_evidence.lanes.other_interest_authority = {
  contract_version: "residual-interest-authority/1.0",
  method: "explicit_forecast_assumption",
  basis_note: "Independently sealed residual-interest mutation.",
  source_ids: ["income_statement-filing"],
};
writeRuntimeEvidenceLanes({ evidence: richerEvidence, caseSource: result });
assert.deepEqual(
  richerEvidence.case_evidence.lanes.operating_metrics,
  sealedOperatingLane,
  "The runtime writer overwrote a richer sealed upstream lane on rebuild.",
);
assert.deepEqual(
  richerEvidence.case_evidence.lanes.other_interest,
  [1, 2, 3],
  "The runtime writer overwrote richer residual-interest evidence.",
);

console.log(JSON.stringify({ status: "PASS", checks: 59 }, null, 2));
