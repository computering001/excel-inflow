#!/usr/bin/env node
// Focused regression and mutation tests for the evidence-first statement mapper.
import fs from "node:fs/promises";
import process from "node:process";
import {
  classifyStatementLine,
  planStatementClassificationQuestions,
} from "./lib/statement_classifier.mjs";
import { assessCoverage } from "./lib/coverage.mjs";
import { validateCaseShape } from "./lib/solver.mjs";
import { compileRowPlan, normaliseStatementRows } from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import { compileStatementTopology } from "./lib/statement_topology.mjs";

function assert(condition, message) { if (!condition) throw new Error(message); }
function clone(value) { return structuredClone(value); }
function hasBlock(report, prefix) {
  return report.checks.some((check) => check.status === "BLOCK" && check.id.startsWith(prefix));
}

const classifierVersion = "statement-semantic-taxonomy.v1";

function accepted(line) {
  const result = classifyStatementLine({ numeric_type: "currency", ...line });
  assert(result.status === "accepted", `Expected accepted ${line.label}: ${JSON.stringify(result)}`);
  return {
    classification_status: "accepted",
    classified_role: result.classified_role,
    classification_confidence: result.confidence,
    classification_evidence: result.evidence,
    classification_candidates: result.candidates,
    classification_review_status: "auto_accepted",
    classifier_version: classifierVersion,
  };
}

const positive = [
  ["Turnover", "income_statement", "revenue"],
  ["Cost of revenue", "income_statement", "cost_of_sales"],
  ["Core operating profit", "income_statement", "adjusted_ebit"],
  [
    "Depreciation, amortisation and impairment",
    "income_statement",
    "depreciation_amortisation_and_impairment",
  ],
  ["Exceptional impairment of goodwill", "income_statement", "impairment_loss"],
  ["Finance costs", "income_statement", "interest_expense"],
  ["Interest paid", "cash_flow", "cash_interest_paid"],
  ["Finance income received", "cash_flow", "cash_interest_received"],
  ["Finance income and expense", "cash_flow", "net_finance_addback"],
  ["Income tax charge", "cash_flow", "cash_flow_tax_addback"],
  ["Income taxes paid", "cash_flow", "cash_taxes"],
  ["Repayments of borrowings", "cash_flow", "debt_repayment"],
  ["Effect of exchange rate changes on cash", "cash_flow", "fx_effect_on_cash"],
];
for (const [label, section, role] of positive) {
  const result = classifyStatementLine({ label, section, numeric_type: "currency" });
  assert(result.status === "accepted" && result.classified_role === role,
    `Positive classification failed for ${label}: ${JSON.stringify(result)}`);
}
const aliasOnlyAdjusted = classifyStatementLine({
  label: "Core operating profit",
  section: "income_statement",
});
assert(
  aliasOnlyAdjusted.status !== "accepted",
  "A high-impact adjusted-profit alias became final authority without structural or numeric evidence.",
);
const unfamiliarAdjusted = classifyStatementLine({
  label: "Core operating result",
  section: "income_statement",
  numeric_type: "currency",
  is_subtotal: true,
  neighbouring_labels: ["Operating profit reconciliation"],
});
assert(
  unfamiliarAdjusted.status === "accepted" &&
    unfamiliarAdjusted.classified_role === "adjusted_ebit",
  `Contextually equivalent adjusted EBIT did not classify: ${JSON.stringify(unfamiliarAdjusted)}`,
);
const percentageProfit = classifyStatementLine({
  label: "Core operating profit margin",
  section: "income_statement",
  numeric_type: "percentage",
  is_subtotal: true,
});
assert(
  percentageProfit.classified_role !== "adjusted_ebit",
  "A percentage margin was admitted as a currency adjusted-EBIT row.",
);
for (const [label, section, forbiddenRole] of [
  ["Deferred tax", "cash_flow"],
  ["Impairment charge", "cash_flow", "capex"],
  ["Impairment charge", "income_statement", "other_non_cash"],
  [
    "Depreciation, amortisation and impairment",
    "income_statement",
    "depreciation_and_amortisation",
  ],
  ["Operating lease interest paid", "cash_flow"],
]) {
  const result = classifyStatementLine({ label, section });
  assert(
    forbiddenRole
      ? result.classified_role !== forbiddenRole
      : result.status !== "accepted",
    `Adversarial line was assigned an unsafe role: ${label}`,
  );
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: run_statement_classifier_tests.mjs <representative-v2-case.json>");
const base = JSON.parse(await fs.readFile(inputPath, "utf8"));
const fixture = clone(base);
// This suite mutates source ordering, aliases and hierarchy, so always exercise
// the source compiler even when the supplied representative is a Stage-3
// sealed case from the production user flow.
delete fixture.statement_structure_compiled_version;
fixture.execution_profile = "reference_parity";
fixture.source_coverage.classification_contract_version = "evidence_v1";
for (const section of ["income_statement", "cash_flow"]) {
  for (const source of fixture.source_coverage[section]) {
    Object.assign(source, {
      classification_status: "manual_reviewed",
      classified_role: null,
      classification_confidence: 0.5,
      classification_evidence: [{ channel: "label", detail: "reviewed legacy fixture mapping", score: 0.5 }],
      classification_candidates: [{ role: "reviewed_legacy_mapping", score: 0.5 }],
      classification_review_status: "reviewed",
      classifier_version: classifierVersion,
      reason: source.reason ?? "Reviewed legacy fixture mapping retained for evidence-gate mutation testing.",
    });
  }
}
const incomeRows = fixture.statement_structure.income_statement;
const interestSource = fixture.source_coverage.income_statement.find((source) => (
  source.mapped_row_ids.some((rowId) => {
    const row = incomeRows.find((candidate) => candidate.row_id === rowId);
    return row?.semantic_role === "interest_expense"
      || row?.row_id === "interest_expense"
      || row?.calculation?.refs?.includes("interest_expense");
  })
));
assert(
  interestSource,
  "Representative fixture needs a sourced finance-cost line feeding the interest-expense graph.",
);
Object.assign(interestSource, {
  label: "Finance costs",
  numeric_type: "currency",
  ...accepted({ label: "Finance costs", section: "income_statement" }),
});

assert(validateCaseShape(fixture).length === 0, "Evidence fixture failed schema validation.");
const baselineCoverage = assessCoverage(fixture);
assert(
  baselineCoverage.ready_to_build,
  `Evidence fixture did not pass baseline coverage: ${JSON.stringify(
    baselineCoverage.checks.filter((check) => check.status === "BLOCK"),
  )}`,
);

const orderInversion = clone(fixture);
// Exercise the source-order compiler, not the sealed Stage-4 fast path. A
// sealed statement is deliberately immutable once Stage 3 has accepted it.
delete orderInversion.statement_structure_compiled_version;
const orderedIncomeIds = orderInversion.source_coverage.income_statement
  .flatMap((source) => source.mapped_row_ids ?? [])
  .filter((rowId, index, ids) => ids.indexOf(rowId) === index);
const firstOrderedIndex = orderInversion.statement_structure.income_statement
  .findIndex((row) => row.row_id === orderedIncomeIds[0]);
const lastOrderedIndex = orderInversion.statement_structure.income_statement
  .findIndex((row) => row.row_id === orderedIncomeIds.at(-1));
assert(firstOrderedIndex >= 0 && lastOrderedIndex > firstOrderedIndex,
  "Representative fixture needs at least two ordered income-statement rows.");
[
  orderInversion.statement_structure.income_statement[firstOrderedIndex],
  orderInversion.statement_structure.income_statement[lastOrderedIndex],
] = [
  orderInversion.statement_structure.income_statement[lastOrderedIndex],
  orderInversion.statement_structure.income_statement[firstOrderedIndex],
];
const repairedIncome = normaliseStatementRows(
  orderInversion,
  "income_statement",
);
const repairedTopology = compileStatementTopology(
  orderInversion,
  "income_statement",
  repairedIncome,
);
assert(
  !repairedTopology.errors.some(
    (error) => error.code === "SOURCE_ORDER_INVERSION",
  ),
  "The deterministic statement compiler did not restore a face-statement source-order inversion.",
);
assert(
  assessCoverage(orderInversion).ready_to_build,
  "A repairable source-order inversion remained blocked after deterministic normalization.",
);

for (const section of ["income_statement", "cash_flow"]) {
  const reversedCase = clone(fixture);
  delete reversedCase.statement_structure_compiled_version;
  const rank = new Map();
  reversedCase.source_coverage[section].forEach((source, index) => {
    for (const rowId of source.mapped_row_ids ?? []) {
      if (!rank.has(rowId)) rank.set(rowId, index);
    }
  });
  const rows = reversedCase.statement_structure[section];
  const slots = rows
    .map((row, index) => (rank.has(row.row_id) ? index : -1))
    .filter((index) => index >= 0);
  const reversed = slots.map((index) => rows[index]).reverse();
  slots.forEach((slot, index) => {
    rows[slot] = reversed[index];
  });
  const compiled = normaliseStatementRows(reversedCase, section);
  const topology = compileStatementTopology(reversedCase, section, compiled);
  assert(
    topology.errors.length === 0,
    `${section} full source-sequence reversal was not repaired: ${JSON.stringify(topology.errors)}`,
  );
}

const duplicateAuthority = clone(fixture);
const duplicateRevenue = duplicateAuthority.statement_structure.income_statement
  .find((row) => row.semantic_role !== "revenue" && row.row_type !== "header");
duplicateRevenue.semantic_role = "revenue";
assert(
  hasBlock(assessCoverage(duplicateAuthority), "statement_topology.income_statement"),
  "Two visible revenue authorities were allowed through the topology gate.",
);

const orphanPrefix = clone(fixture);
orphanPrefix.statement_structure.cash_flow.unshift({
  row_id: "orphan_numeric_prefix",
  label: "Unowned cash-flow basis",
  row_type: "input",
  values: [1, 1, 1, null, null, null],
  forecast_treatment: "uncalculated",
});
assert(
  hasBlock(assessCoverage(orphanPrefix), "statement_topology.cash_flow"),
  "An unowned historical row before the cash-flow source tree was allowed through the topology gate.",
);

const bulletLabel = clone(fixture);
bulletLabel.statement_structure.income_statement[0].label =
  `— ${bulletLabel.statement_structure.income_statement[0].label}`;
assert(
  !normaliseStatementRows(bulletLabel, "income_statement")[0].label.startsWith("—"),
  "A source-layout dash survived as literal model label content.",
);

const arbitraryIndent = clone(fixture);
const arbitraryCashRows = arbitraryIndent.statement_structure.cash_flow;
const cashGenerated = arbitraryCashRows.find(
  (row) => row.row_id === "cash_generated_from_operations",
);
const cashGeneratedChildren = cashGenerated.calculation.refs
  .map((rowId) => arbitraryCashRows.find((row) => row.row_id === rowId))
  .filter((row) => row && row.style_role !== "total");
assert(
  cashGeneratedChildren.length >= 2,
  "Representative fixture needs two ordinary cash-generation children.",
);
cashGeneratedChildren[0].indent = 7;
cashGeneratedChildren[1].indent = 0;
const normalisedArbitraryIndent = normaliseStatementRows(
  arbitraryIndent,
  "cash_flow",
);
const normalisedChildIndents = cashGeneratedChildren.slice(0, 2).map(
  (sourceRow) =>
    normalisedArbitraryIndent.find((row) => row.row_id === sourceRow.row_id)
      .indent,
);
assert(
  normalisedChildIndents[0] === normalisedChildIndents[1] &&
    normalisedChildIndents[0] === 1,
  `Source indent metadata overrode the graph: ${normalisedChildIndents.join(", ")}.`,
);
const mutatedCompiledIndent = clone(normalisedArbitraryIndent);
mutatedCompiledIndent.find(
  (row) => row.row_id === cashGeneratedChildren[0].row_id,
).indent += 1;
assert(
  compileStatementTopology(
    arbitraryIndent,
    "cash_flow",
    mutatedCompiledIndent,
  ).errors.some((error) => error.code === "INDENT_NOT_GRAPH_DERIVED"),
  "A post-compile indentation mutation was not rejected by the topology gate.",
);

const arbitraryIncomeIndent = clone(fixture);
const topLevelIncomeSourceRow = arbitraryIncomeIndent.statement_structure.income_statement
  .find((row) => row.row_type !== "header" && !row.parent_row_id);
assert(
  topLevelIncomeSourceRow,
  "Representative fixture needs an ordinary top-level income-statement row.",
);
topLevelIncomeSourceRow.indent = 6;
const normalisedIncomeIndent = normaliseStatementRows(
  arbitraryIncomeIndent,
  "income_statement",
);
const cleanIncomeIndent = normaliseStatementRows(
  fixture,
  "income_statement",
).find((row) => row.row_id === topLevelIncomeSourceRow.row_id).indent;
assert(
  normalisedIncomeIndent.find(
    (row) => row.row_id === topLevelIncomeSourceRow.row_id,
  ).indent === cleanIncomeIndent,
  "An unparented income-statement row retained a section-wide or source-layout indent.",
);

const unsourcedIncomeAlias = clone(fixture);
const canonicalIncomeAuthority = unsourcedIncomeAlias.statement_structure.income_statement
  .find((row) => row.semantic_role === "ebit");
assert(
  canonicalIncomeAuthority,
  "Representative fixture needs an EBIT authority for the generic alias regression.",
);
const canonicalIncomeIndex = unsourcedIncomeAlias.statement_structure.income_statement
  .indexOf(canonicalIncomeAuthority);
unsourcedIncomeAlias.statement_structure.income_statement.splice(
  canonicalIncomeIndex + 1,
  0,
  {
    row_id: "compiler_only_repeated_authority",
    label: "Repeated operating answer",
    row_type: "calculation",
    semantic_role: canonicalIncomeAuthority.semantic_role,
    calculation: { operator: "link", refs: [canonicalIncomeAuthority.row_id] },
    values: [...(canonicalIncomeAuthority.values ?? [])],
    forecast_treatment: "formula",
    forecast_calculation: {
      operator: "link",
      refs: [canonicalIncomeAuthority.row_id],
    },
  },
);
assert(
  !normaliseStatementRows(unsourcedIncomeAlias, "income_statement").some(
    (row) => row.row_id === "compiler_only_repeated_authority",
  ),
  "An unsourced one-reference income-statement alias survived as a second visible authority.",
);

const rejectedBrokerRoleAlias = clone(fixture);
const rejectedBrokerEbit = rejectedBrokerRoleAlias.statement_structure.income_statement
  .find((row) => row.semantic_role === "ebit");
Object.assign(rejectedBrokerEbit, {
  row_type: "input",
  values: [10, 11, 12, null, null, null],
});
delete rejectedBrokerEbit.calculation;
rejectedBrokerEbit.broker_metric_id = "ebit";
rejectedBrokerEbit.forecast_treatment = "formula";
rejectedBrokerRoleAlias.statement_structure.income_statement.splice(
  rejectedBrokerRoleAlias.statement_structure.income_statement.indexOf(
    rejectedBrokerEbit,
  ),
  0,
  {
    row_id: "reported_operating_profit_alias",
    label: "Reported operating profit",
    semantic_role: "operating_profit",
    row_type: "input",
    values: [10, 11, 12, null, null, null],
    source_line_ids: ["is.reported_operating_profit_alias"],
  },
);
const rejectedBrokerProjection = normaliseStatementRows(
  rejectedBrokerRoleAlias,
  "income_statement",
);
const rejectedBrokerSurvivor = rejectedBrokerProjection.find(
  (row) => row.role_aliases?.includes("ebit"),
);
assert(
  rejectedBrokerSurvivor?.broker_metric_id === "ebit",
  "A rejected broker metric lost its evidence binding when EBIT projected into an equivalent operating-profit row.",
);

const projectedRoleAlias = clone(fixture);
const projectedEbitRow = projectedRoleAlias.statement_structure.income_statement
  .find((row) => row.semantic_role === "ebit");
const projectedEbitSource = projectedRoleAlias.source_coverage.income_statement
  .find((source) => source.mapped_row_ids.includes(projectedEbitRow.row_id));
Object.assign(projectedEbitRow, {
  semantic_role: "operating_profit",
  role_aliases: ["ebit"],
});
Object.assign(projectedEbitSource, {
  label: "EBIT",
  numeric_type: "currency",
  ...accepted({ label: "EBIT", section: "income_statement" }),
});
assert(
  !hasBlock(
    assessCoverage(projectedRoleAlias),
    `classification.${projectedEbitSource.source_line_id}.destination`,
  ),
  "A source classification was rejected after its semantic role was preserved as an explicit projection alias.",
);

const unexplainedPostNetRows = normaliseStatementRows(
  fixture,
  "income_statement",
);
const netIncomePosition = unexplainedPostNetRows.findIndex(
  (row) => row.semantic_role === "net_income",
);
assert(netIncomePosition >= 0, "Representative fixture needs a net-income row.");
unexplainedPostNetRows.splice(netIncomePosition + 1, 0, {
  row_id: "unexplained_post_net_row",
  label: "Unexplained post-net calculation",
  row_type: "calculation",
  calculation: {
    operator: "link",
    refs: [unexplainedPostNetRows[netIncomePosition].row_id],
  },
  indent: 0,
});
assert(
  compileStatementTopology(
    fixture,
    "income_statement",
    unexplainedPostNetRows,
  ).errors.some((error) => error.code === "PROJECTION_NECESSITY_UNDECLARED"),
  "A visible post-net-income row without a declared projection reason was not rejected.",
);

const duplicateCashRoot = clone(fixture);
const duplicateRootRows = duplicateCashRoot.statement_structure.cash_flow;
const duplicateRootParent = duplicateRootRows.find(
  (row) => row.row_id === "cash_generated_from_operations",
);
duplicateRootRows.unshift({
  row_id: "generic_unsourced_cash_flow_root",
  label: "Profit for the period",
  row_type: "calculation",
  calculation: { operator: "link", refs: ["pre_tax_income"] },
  indent: 0,
});
duplicateRootParent.calculation.refs.unshift(
  "generic_unsourced_cash_flow_root",
);
const normalisedSingleRoot = normaliseStatementRows(
  duplicateCashRoot,
  "cash_flow",
);
assert(
  !normalisedSingleRoot.some(
    (row) => row.row_id === "generic_unsourced_cash_flow_root",
  ),
  "An unsourced generic P&L root survived beside the sourced cash-flow root.",
);
const singleRootById = new Map(
  normalisedSingleRoot.map((row) => [row.row_id, row]),
);
const singleRootClosure = new Set();
const visitSingleRoot = (rowId) => {
  if (singleRootClosure.has(rowId)) return;
  singleRootClosure.add(rowId);
  for (const ref of singleRootById.get(rowId)?.calculation?.refs ?? []) {
    if (singleRootById.has(ref)) visitSingleRoot(ref);
  }
};
visitSingleRoot("cash_from_operations");
assert(
  normalisedSingleRoot.filter(
    (row) =>
      singleRootClosure.has(row.row_id) &&
      row.calculation?.operator === "link" &&
      row.calculation.refs.some((ref) =>
        ["pre_tax_income", "net_income"].includes(ref),
      ),
  ).length === 1,
  "Cash generation retained more than one visible P&L starting point.",
);

const parentFirstCash = normaliseStatementRows(fixture, "cash_flow");
const capex = parentFirstCash.find((row) => row.semantic_role === "capex");
for (const childId of capex.calculation?.refs ?? []) {
  const child = parentFirstCash.find((row) => row.row_id === childId);
  assert(
    parentFirstCash.indexOf(capex) < parentFirstCash.indexOf(child),
    `Consolidated capex parent did not precede ${childId}.`,
  );
  assert(
    child.indent === capex.indent + 1,
    `Capex child ${childId} did not inherit graph depth.`,
  );
}

const legacyCashTaxCase = clone(fixture);
delete legacyCashTaxCase.statement_structure_compiled_version;
const legacyCashTaxRows = legacyCashTaxCase.statement_structure.cash_flow;
const legacyCashTaxInsert = legacyCashTaxRows.findIndex(
  (row) => row.semantic_role === "cash_from_operations",
);
legacyCashTaxRows.splice(legacyCashTaxInsert < 0 ? legacyCashTaxRows.length : legacyCashTaxInsert, 0, {
  row_id: "income_taxes_paid_policy_regression",
  label: "Income taxes paid",
  row_type: "input",
  values: [-7, -20, -8, null, null, null],
  forecast_treatment: "formula",
  forecast_calculation: { operator: "link", refs: ["tax_expense"] },
  source_line_ids: ["cf.cash_tax_policy_regression"],
});
const normalisedCashTax = normaliseStatementRows(
  legacyCashTaxCase,
  "cash_flow",
).find((row) => row.row_id === "income_taxes_paid_policy_regression");
assert(
  normalisedCashTax?.semantic_role === "cash_taxes" &&
    normalisedCashTax.forecast_calculation?.refs?.[0] !== "tax_expense" &&
    normalisedCashTax.forecast_decision?.method === "carry_forward" &&
    /latest reported value/i.test(normalisedCashTax.forecast_decision.reason),
  `A legacy silent cash-tax-to-P&L-tax link survived source normalization without a disclosed fallback: ${JSON.stringify(normalisedCashTax)}`,
);

const ambiguous = clone(fixture);
Object.assign(ambiguous.source_coverage.income_statement.find((source) => source.source_line_id === interestSource.source_line_id), {
  label: "Interest paid",
  classification_status: "ambiguous",
  classified_role: null,
  classification_confidence: 0.5,
  classification_evidence: [{ channel: "label", detail: "ambiguous cash wording", score: 0.5 }],
  classification_candidates: [{ role: "interest_expense", score: 0.5 }],
  classification_review_status: "needs_question",
});
assert(hasBlock(assessCoverage(ambiguous), "classification."), "Ambiguous material line was allowed to build.");

const stale = clone(fixture);
stale.source_coverage.income_statement.find((source) => source.source_line_id === interestSource.source_line_id).classified_role = "interest_income";
assert(hasBlock(assessCoverage(stale), "classification."), "Stale declared role was allowed to build.");

const noEvidence = clone(fixture);
delete noEvidence.source_coverage.income_statement.find((source) => source.source_line_id === interestSource.source_line_id).classification_evidence;
assert(hasBlock(assessCoverage(noEvidence), "classification."), "Material line without evidence was allowed to build.");

const unusedBrokerMetric = clone(fixture);
unusedBrokerMetric.broker_pack.metrics.unmapped_investing_cash_flow = {
  ...clone(unusedBrokerMetric.broker_pack.metrics.capex),
  label: "Unmapped investing cash flow",
};
assert(
  hasBlock(
    assessCoverage(unusedBrokerMetric),
    "broker_pack.unmapped_investing_cash_flow.consumption",
  ),
  "An accepted broker metric with no model consumer was silently ignored.",
);
unusedBrokerMetric.broker_pack.metrics.unmapped_investing_cash_flow
  .model_disposition = "reference_only";
unusedBrokerMetric.broker_pack.metrics.unmapped_investing_cash_flow
  .model_disposition_reason =
    "Retained for research context and deliberately excluded from the debt-overlay forecast.";
assert(
  !hasBlock(
    assessCoverage(unusedBrokerMetric),
    "broker_pack.unmapped_investing_cash_flow.consumption",
  ),
  "An explicitly rejected broker metric remained blocked.",
);

const questionFixture = clone(fixture);
questionFixture.source_coverage.cash_flow.push({
  source_line_id: "cf.contract_fulfilment_assets",
  label: "Contract fulfilment assets",
  face_statement: true,
  material: true,
  disposition: "mapped",
  mapped_row_ids: [],
  classification_status: "unmapped",
});
const classificationQuestions = planStatementClassificationQuestions(questionFixture);
assert(classificationQuestions.length === 1, "Material ambiguity did not produce one targeted question.");
assert(classificationQuestions[0].source_label === "Contract fulfilment assets", "Targeted question lost the issuer label.");
assert(classificationQuestions[0].resolution_required === true, "Targeted question was not blocking.");

function historicalRowValues(rows, rowId, visiting = new Set()) {
  if (visiting.has(rowId)) throw new Error(`Cycle while resolving ${rowId}.`);
  const row = rows.find((candidate) => candidate.row_id === rowId);
  if (!row) throw new Error(`Missing row ${rowId}.`);
  const direct = row.values?.slice(0, 3);
  if (direct?.length === 3 && direct.every((value) => Number.isFinite(Number(value)))) {
    return direct.map(Number);
  }
  if (row.calculation?.operator !== "sum" || !Array.isArray(row.calculation.refs)) {
    throw new Error(`Cannot resolve historical values for ${rowId}; expected values or a sum calculation.`);
  }
  const next = new Set(visiting).add(rowId);
  return row.calculation.refs
    .map((ref) => historicalRowValues(rows, ref, next))
    .reduce((total, values) => total.map((value, index) => value + values[index]), [0, 0, 0]);
}

function hierarchyFixture(authority) {
  const candidate = clone(fixture);
  candidate.case_id = `statement_hierarchy_${authority}`;
  candidate.issuer.accounting_basis = authority === "reported_parent" ? "IFRS" : "US_GAAP";
  if (candidate.issuer.accounting_basis === "US_GAAP") {
    candidate.lease_policy.interest_basis = "none";
  }
  const rows = candidate.statement_structure.cash_flow;
  const parent = rows.find((row) => row.row_id === "change_in_working_capital");
  const historical = historicalRowValues(rows, parent.row_id);
  Object.assign(parent, {
    aggregation_authority: authority,
    aggregation_role: "standalone",
    economic_class: "working_capital",
    operation_scope: "continuing",
  });
  if (authority === "reported_parent" && parent.row_type !== "input") {
    parent.row_type = "input";
    parent.values = [...historical, 5, 10, 15];
    parent.forecast_treatment = "hardcode";
    delete parent.calculation;
    candidate.provenance[parent.row_id] = historical.map((_, period_index) => ({
      period_index,
      document: "Synthetic hierarchy fixture",
      publication_date: "2026-01-01",
      page_or_note: "working-capital note",
      units: candidate.issuer.units,
      source_label: parent.label,
      transformation: "Synthetic hierarchy authority used only by the classifier mutation test.",
    }));
  }
  const childValues = [
    historical.map((value) => value * 0.6),
    historical.map((value) => value * 0.4),
  ];
  const children = ["trade_receivables", "inventory"].map((suffix, index) => ({
    row_id: `working_capital.${suffix}`,
    label: index === 0 ? "Trade receivables" : "Inventories",
    row_type: "input",
    values: [
      ...childValues[index],
      ...(authority === "derived_from_children"
        ? index === 0 ? [10, 20, 30] : [-5, -10, -15]
        : [null, null, null]),
    ],
    forecast_treatment:
      authority === "derived_from_children" ? "hardcode" : "uncalculated",
    ...(authority === "derived_from_children"
      ? {
          forecast_period_authorities: [0, 1, 2].map((forecastIndex) => ({
            method: "user_assumption",
            source_kind: "user_supplied",
            source_id: `statement-hierarchy-fixture-${forecastIndex + 1}`,
            as_of_date: "2026-01-01",
            material: true,
            value:
              index === 0
                ? [10, 20, 30][forecastIndex]
                : [-5, -10, -15][forecastIndex],
            note: "Synthetic hierarchy mutation input.",
          })),
        }
      : {
          forecast_capture_parent_id: parent.row_id,
          forecast_capture_mode: "semantic_scope",
          forecast_capture_note:
            "Synthetic reported-parent working detail is captured by the visible working-capital authority.",
          forecast_capture_certificates: [0, 1, 2].map((forecastIndex) => ({
            forecast_index: forecastIndex,
            parent_row_id: parent.row_id,
            mode: "semantic_scope",
            material: false,
            membership_path: [`working_capital.${suffix}`, parent.row_id],
            proof:
              "The unique section-local declared hierarchy assigns this working row to the reported parent.",
          })),
        }),
    parent_row_id: parent.row_id,
    aggregation_role:
      authority === "reported_parent" ? "working_child" : "contributing_child",
    economic_class: "working_capital",
    operation_scope: "continuing",
    movement_type: "working_capital_movement",
    cash_flow_classification: "operating",
    source_line_ids: [`cf.hierarchy_${suffix}`],
  }));
  rows.splice(rows.indexOf(parent) + 1, 0, ...children);
  for (const [index, child] of children.entries()) {
    candidate.source_coverage.cash_flow.push({
      source_line_id: child.source_line_ids[0],
      label: child.label,
      document: "Synthetic hierarchy fixture",
      page_or_note: "working-capital note",
      face_statement: false,
      material: false,
      disposition: "mapped",
      mapped_row_ids: [child.row_id],
      mapping_method: "exact",
      classification_status: "manual_reviewed",
      classified_role: "change_in_working_capital",
      classification_confidence: 0.8,
      classification_evidence: [
        {
          channel: "hierarchy",
          detail: "Declared working-capital child beneath the disclosed parent.",
          score: 0.8,
        },
      ],
      classification_candidates: [
        { role: "change_in_working_capital", score: 0.8 },
      ],
      classification_review_status: "reviewed",
      classifier_version: classifierVersion,
      reason: "Reviewed as a working-capital constituent from the disclosed note hierarchy.",
    });
    const parentProvenance = candidate.provenance[parent.row_id] ?? historical.map((_, period_index) => ({
      period_index,
      document: "Synthetic hierarchy fixture",
      publication_date: "2026-01-01",
      page_or_note: "working-capital note",
      units: candidate.issuer.units,
      source_label: parent.label,
      transformation: "Synthetic hierarchy fixture.",
    }));
    candidate.provenance[child.row_id] = parentProvenance.map((entry) => ({ ...entry, source_label: child.label }));
    void index;
  }
  if (authority === "derived_from_children") {
    parent.row_type = "subtotal";
    parent.values = [null, null, null, null, null, null];
    parent.calculation = { operator: "sum", refs: children.map((row) => row.row_id) };
    parent.forecast_treatment = "formula";
    delete candidate.provenance[parent.row_id];
    const parentSource = candidate.source_coverage.cash_flow.find(
      (source) => source.mapped_row_ids.includes(parent.row_id),
    );
    if (parentSource) {
      parentSource.disposition = "aggregated";
      parentSource.mapped_row_ids = children.map((row) => row.row_id);
      parentSource.mapping_method = "split";
      parentSource.reason = "The published total is reconstructed from the disclosed children for this synthetic test.";
    }
  }
  return candidate;
}

for (const authority of ["reported_parent", "derived_from_children"]) {
  const candidate = hierarchyFixture(authority);
  const hierarchySchemaErrors = validateCaseShape(candidate);
  assert(hierarchySchemaErrors.length === 0, `${authority} hierarchy failed schema validation: ${JSON.stringify(hierarchySchemaErrors)}`);
  const coverage = assessCoverage(candidate);
  assert(coverage.ready_to_build, `${authority} hierarchy failed coverage: ${JSON.stringify(coverage.checks.filter((check) => check.status === "BLOCK"))}`);
  const plan = compileRowPlan(candidate);
  const manifest = compileSemanticManifest(candidate, plan);
  const children = manifest.nodes.filter((node) => node.parent_row_id === "change_in_working_capital");
  const expectedEdge = authority === "reported_parent" ? "working_detail_of" : "contributes_to";
  assert(children.length === 2, `${authority} hierarchy lost its children.`);
  assert(
    manifest.edges.filter((edge) => edge.edge_type === expectedEdge).length >= 2,
    `${authority} hierarchy lost its semantic graph edges.`,
  );
  if (authority === "reported_parent") {
    assert(
      plan.statement_rows.cash_flow
        .filter((row) => row.parent_row_id === "change_in_working_capital")
        .every((row) => row.forecast_treatment === "uncalculated"),
      "Reported-parent workings remained live in forecast years.",
    );
  }
}

for (const [name, mutate] of [
  ["missing accounting basis", (caseFile) => { delete caseFile.issuer.accounting_basis; }],
  ["wrong child role", (caseFile) => { caseFile.statement_structure.cash_flow.find((row) => row.parent_row_id).aggregation_role = "contributing_child"; }],
  ["reported parent formula", (caseFile) => { caseFile.statement_structure.cash_flow.find((row) => row.row_id === "change_in_working_capital").calculation = { operator: "sum", refs: ["working_capital.trade_receivables", "working_capital.inventory"] }; }],
  ["working reconciliation", (caseFile) => { caseFile.statement_structure.cash_flow.find((row) => row.row_id === "working_capital.inventory").values[0] += 1; }],
  ["mixed scope", (caseFile) => { caseFile.statement_structure.cash_flow.find((row) => row.row_id === "working_capital.inventory").operation_scope = "discontinued"; }],
  ["parent cycle", (caseFile) => { caseFile.statement_structure.cash_flow.find((row) => row.row_id === "change_in_working_capital").parent_row_id = "working_capital.inventory"; caseFile.statement_structure.cash_flow.find((row) => row.row_id === "change_in_working_capital").aggregation_role = "working_child"; }],
]) {
  const candidate = hierarchyFixture("reported_parent");
  mutate(candidate);
  assert(
    !assessCoverage(candidate).ready_to_build,
    `Hierarchy mutation was allowed: ${name}`,
  );
}

const hierarchyOutput = process.argv[3];
if (hierarchyOutput) {
  await fs.mkdir(hierarchyOutput, { recursive: true });
  for (const authority of ["reported_parent", "derived_from_children"]) {
    await fs.writeFile(
      `${hierarchyOutput}/phase7-statement-${authority}.json`,
      `${JSON.stringify(hierarchyFixture(authority), null, 2)}\n`,
    );
  }
}

console.log(`Statement classifier tests: PASS (${positive.length} positive, 5 adversarial, 3 classification mutations, 1 targeted-question case, 15 topology regressions, 2 hierarchy authorities, 6 hierarchy mutations).`);
