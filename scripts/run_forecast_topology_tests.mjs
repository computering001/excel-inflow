#!/usr/bin/env node

import {
  compileForecastCaptureTopology,
} from "./lib/case_compiler.mjs";
import {
  compileForecastPlan,
  materializeForecastPlan,
} from "./lib/forecast_candidate_compiler.mjs";
import { validateForecastAuthorities } from "./lib/forecast_authority.mjs";
import {
  canonicalForecastStatementDependencies,
} from "./lib/layered_graph_constitution.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const clone = (value) => structuredClone(value);
const periods = [
  ["2023-12-31", "historical"],
  ["2024-12-31", "historical"],
  ["2025-12-31", "historical"],
  ["2026-12-31", "forecast"],
  ["2027-12-31", "forecast"],
  ["2028-12-31", "forecast"],
].map(([date, status]) => ({ date, status }));
const direct = (base, method = "user_assumption") => [0, 1, 2].map((index) => ({
  method,
  source_kind: "user_supplied",
  source_id: `fixture.${base}`,
  as_of_date: "2025-12-31",
  value: base + index,
  material: true,
  note: "Hash-bound fixture authority for topology testing.",
}));
const row = (row_id, label, values = [1, 2, 3, null, null, null], extra = {}) => ({
  row_id,
  label,
  row_type: "input",
  values,
  source_line_ids: [`src.${row_id}`],
  ...extra,
});

function fixture() {
  const income_statement = [
    row("strange_product_alpha", "Issuer alpha stream"),
    row("strange_product_beta", "Issuer beta stream"),
    row("strange_product_total", "Issuer trading streams", undefined, {
      row_type: "calculation",
      calculation: {
        operator: "sum",
        refs: ["strange_product_alpha", "strange_product_beta"],
      },
    }),
    row("revenue", "Aggregate turnover", [30, 33, 36, 40, 41, 42], {
      row_type: "calculation",
      semantic_role: "revenue",
      calculation: { operator: "sum", refs: ["strange_product_total"] },
      forecast_period_authorities: direct(40),
    }),
    row("revenue_growth", "Revenue growth", undefined, {
      row_type: "calculation",
      calculation: { operator: "growth", refs: ["revenue"] },
    }),
    row("unusual_cost_pool", "Unfamiliar fulfilment outlay", [-4, -5, -6, null, null, null]),
    row("gross_result", "Issuer gross result", undefined, {
      row_type: "calculation",
      calculation: { operator: "sum", refs: ["revenue", "unusual_cost_pool"] },
    }),
    row("mixed_line", "One-period disclosed operating item", [2, 3, 4, 7, null, null], {
      forecast_period_authorities: [
        {
          method: "company_guidance",
          source_kind: "company_guidance",
          source_id: "fixture.guidance",
          as_of_date: "2025-12-31",
          value: 7,
          material: true,
          note: "FY1 company guidance; later periods remain in the headline.",
        },
        null,
        null,
      ],
    }),
    row("is_da_expense", "Depreciation and amortisation expense", undefined, {
      row_type: "calculation",
      semantic_role: "is_da_expense",
      calculation: { operator: "negate", refs: ["depreciation_and_amortisation"] },
    }),
    row("depreciation_and_amortisation", "Depreciation and amortisation", [3, 3, 3, 4, 4, 4], {
      semantic_role: "depreciation_and_amortisation",
      forecast_period_authorities: direct(4),
    }),
    row("ebit", "Issuer operating answer", [12, 13, 14, 20, 21, 22], {
      row_type: "calculation",
      semantic_role: "ebit",
      calculation: { operator: "sum", refs: ["gross_result", "mixed_line", "is_da_expense"] },
      forecast_period_authorities: direct(20),
    }),
    row("ebit_margin", "Issuer operating margin", undefined, {
      row_type: "calculation",
      calculation: { operator: "ratio", refs: ["ebit", "revenue"] },
    }),
    row("interest_expense", "Funding expense", undefined, {
      row_type: "calculation",
      semantic_role: "interest_expense",
      calculation: { operator: "sum", refs: [] },
    }),
    row("pre_tax_income", "Result before taxation", undefined, {
      row_type: "calculation",
      semantic_role: "pre_tax_income",
      calculation: { operator: "sum", refs: ["ebit", "interest_expense"] },
    }),
    row("tax_expense", "Taxation", undefined, {
      row_type: "calculation",
      semantic_role: "tax_expense",
      calculation: { operator: "tax", refs: ["pre_tax_income", "effective_tax_rate"] },
    }),
    row("effective_tax_rate", "Effective rate", [0.2, 0.2, 0.2, null, null, null], {
      semantic_role: "effective_tax_rate",
    }),
    row("net_income", "Profit for the year", undefined, {
      row_type: "calculation",
      semantic_role: "net_income",
      calculation: { operator: "sum", refs: ["pre_tax_income", "tax_expense"] },
    }),
  ];
  const cash_flow = [
    row("odd_operating_cash", "Issuer-specific operating cash movement", [5, 7, 9, null, null, null], {
      movement_type: "operating_cash_flow",
    }),
    row("debt_fees", "Fees on financing transactions", [-3, -1, -4, null, null, null], {
      movement_type: "debt_issuance_cost",
    }),
    row("other_debt_transaction", "Other debt movements, net", [-4, 2, -18, null, null, null], {
      movement_type: "other_cash_debt_movement",
      cash_flow_classification: "financing",
    }),
    row("mixed_cf_identity", "Issuer cash-flow add-back", [2, 3, 4, 8, null, null], {
      row_type: "calculation",
      calculation: { operator: "link", refs: ["net_income"] },
      forecast_period_calculations: [
        null,
        { operator: "link", refs: ["net_income"], forecast_index: 1 },
        { operator: "link", refs: ["net_income"], forecast_index: 2 },
      ],
      forecast_period_authorities: [
        direct(8)[0],
        null,
        null,
      ],
    }),
    row("debt_issuance", "Proceeds from debt", undefined, {
      row_type: "calculation",
      semantic_role: "debt_issuance",
      calculation: { operator: "sum", refs: [] },
    }),
    row("cash_from_financing", "Financing cash", undefined, {
      row_type: "calculation",
      semantic_role: "cash_from_financing",
      calculation: { operator: "sum", refs: ["debt_fees", "debt_issuance"] },
    }),
  ];
  const source_coverage = Object.fromEntries(
    [["income_statement", income_statement], ["cash_flow", cash_flow]].map(
      ([section, rows]) => [section, rows
        .filter((candidate) => candidate.row_type !== "header")
        .map((candidate) => ({
          source_line_id: candidate.source_line_ids[0],
          mapped_row_ids: [candidate.row_id],
          material: true,
        }))],
    ),
  );
  return {
    case_id: "weird_issuer_forecast_topology",
    forecast_authority_contract_version: "waterfall_v1",
    periods,
    controls: { broker_case: "Consensus" },
    broker_pack: { metrics: {} },
    source_coverage,
    statement_structure: { income_statement, cash_flow },
  };
}

const base = fixture();
const topology = compileForecastCaptureTopology(base);
assert(topology.findings.length === 0, `Baseline topology blocked: ${JSON.stringify(topology.findings)}`);
const income = new Map(base.statement_structure.income_statement.map((candidate) => [candidate.row_id, candidate]));
assert(
  JSON.stringify(income.get("strange_product_alpha").forecast_capture_certificates[0].membership_path) ===
    JSON.stringify(["strange_product_alpha", "strange_product_total", "revenue"]),
  "Revenue detail did not receive its complete multi-hop certificate.",
);
assert(
  income.get("strange_product_total").forecast_capture_parent_id === "revenue",
  "Intermediate revenue aggregate was left independently forecastable.",
);
assert(
  income.get("unusual_cost_pool").forecast_capture_parent_id === "ebit",
  "Operating detail did not terminate at the directly forecast EBIT authority.",
);
for (const protectedId of ["revenue", "ebit", "is_da_expense", "depreciation_and_amortisation", "pre_tax_income", "tax_expense", "net_income"]) {
  assert(!income.get(protectedId).forecast_capture_parent_id, `${protectedId} was illegally captured.`);
}
for (const displayId of ["revenue_growth", "ebit_margin"]) {
  assert(
    !income.get(displayId).forecast_capture_parent_id &&
      !income.get(displayId).forecast_capture_certificates,
    `${displayId} was incorrectly captured instead of retaining its visible derived formula.`,
  );
}
const cash = new Map(base.statement_structure.cash_flow.map((candidate) => [candidate.row_id, candidate]));
assert(!cash.get("odd_operating_cash").forecast_capture_parent_id, "The full cash-flow waterfall was blanket-captured.");
assert(!cash.get("debt_issuance").forecast_capture_parent_id, "A schedule-owned cash-flow row was captured.");

const plan = compileForecastPlan(base, base.statement_structure, {
  behaviorMap: topology.behavior_map,
});
const state = (section, rowId, index) => plan.states.find((candidate) =>
  candidate.section === section &&
  candidate.row_id === rowId &&
  candidate.forecast_index === index,
);
assert(
  [0, 1, 2].every((index) =>
    state("income_statement", "strange_product_alpha", index).method === "not_separately_forecast" &&
    state("income_statement", "strange_product_alpha", index).render_state === "blank_grey" &&
    state("income_statement", "strange_product_alpha", index).value === null,
  ),
  "Captured revenue detail did not compile to blank-grey cells.",
);
assert(
  [0, 1, 2].every((index) =>
    state("income_statement", "strange_product_total", index).method === "not_separately_forecast" &&
    state("income_statement", "strange_product_total", index).render_state === "blank_grey" &&
    state("income_statement", "strange_product_total", index).value === null,
  ),
  "An intermediate historical aggregate remained independently forecast instead of standing down with its captured section.",
);
assert(
  JSON.stringify(canonicalForecastStatementDependencies({
    row_id: "forecast_specific_identity",
    calculation: { operator: "sum", refs: ["historical_component_a", "historical_component_b"] },
    forecast_calculation: { operator: "subtract", refs: ["forecast_headline", "forecast_driver"] },
    forecast_treatment: "formula",
  })) === JSON.stringify(["forecast_driver", "forecast_headline"]),
  "The forecast constitution retained superseded historical dependencies beside the live forecast identity.",
);
assert(
  state("income_statement", "mixed_line", 0).method === "company_guidance" &&
    [1, 2].every((index) => state("income_statement", "mixed_line", index).method === "not_separately_forecast"),
  "Per-period guidance/capture mechanisms were not preserved.",
);
assert(
  [0, 1, 2].every((index) =>
    ["historical_average", "historical_trend", "carry_forward"].includes(
      state("cash_flow", "odd_operating_cash", index).method,
    )),
  "A normal cash-flow line did not remain in the full historical-inference waterfall.",
);
assert(
  state("cash_flow", "mixed_cf_identity", 0).method === "user_assumption" &&
    [1, 2].every((index) =>
      state("cash_flow", "mixed_cf_identity", index).method === "accounting_identity"),
  "A null slot in a period-specific formula vector fell back to the historical identity instead of preserving the supplied-period authority.",
);
assert(
  [0, 1, 2].every((index) =>
    state("cash_flow", "debt_fees", index).method === "explicit_zero" &&
    state("cash_flow", "debt_fees", index).render_state === "zero"),
  "A financing transaction cost was carried forward instead of using the explicit-zero event backstop.",
);
assert(
  [0, 1, 2].every((index) =>
    state("cash_flow", "other_debt_transaction", index).method === "explicit_zero" &&
    state("cash_flow", "other_debt_transaction", index).render_state === "zero"),
  "A residual financing transaction was naively carried forward instead of reaching the event backstop.",
);
const materialized = materializeForecastPlan(base, plan);
const materializedInterest = materialized.statement_structure.income_statement.find(
  (candidate) => candidate.row_id === "interest_expense",
);
const materializedPreTax = materialized.statement_structure.income_statement.find(
  (candidate) => candidate.row_id === "pre_tax_income",
);
const materializedEbit = materialized.statement_structure.income_statement.find(
  (candidate) => candidate.row_id === "ebit",
);
assert(
  JSON.stringify(materializedInterest.values.slice(0, 3)) === JSON.stringify([1, 2, 3]) &&
    materializedPreTax.values.slice(0, 3).every(
      (value, index) => value === materializedEbit.values[index] + materializedInterest.values[index],
    ),
  "A schedule-owned empty-ref historical row was evaluated as zero instead of retaining its filed values.",
);
const mixed = materialized.statement_structure.income_statement.find((candidate) => candidate.row_id === "mixed_line");
assert(mixed.values[3] === 7 && mixed.values[4] === null && mixed.values[5] === null, "Mixed row values were globally blanked or hardcoded.");
assert(mixed.forecast_treatment !== "uncalculated", "A global uncalculated flag erased a live mixed-period authority.");
assert(
  mixed.forecast_capture_certificates[1].membership_path.at(-1) === "ebit",
  "The materialized plan lost its per-period path certificate.",
);
assert(
  validateForecastAuthorities(materialized, [
    ...materialized.statement_structure.income_statement,
    ...materialized.statement_structure.cash_flow,
  ]).length === 0,
  "A valid structured event backstop failed the independent authority gate.",
);
const invalidEventBackstop = clone(materialized);
const invalidTransaction = invalidEventBackstop.statement_structure.cash_flow.find(
  (candidate) => candidate.row_id === "other_debt_transaction",
);
invalidTransaction.forecast_period_authorities[0].source_id = "unsealed:transaction";
assert(
  validateForecastAuthorities(invalidEventBackstop, [
    ...invalidEventBackstop.statement_structure.income_statement,
    ...invalidEventBackstop.statement_structure.cash_flow,
  ]).some((error) => error.includes("explicit_zero")),
  "An unsealed transaction zero escaped the explicit-zero authority gate.",
);

const protectedCashFlowRows = [
  row("operating_member", "Operating member", [10, 11, 12, null, null, null], {
    forecast_period_authorities: direct(13),
  }),
  row("cash_from_operations", "Operating cash total", undefined, {
    row_type: "calculation",
    semantic_role: "cash_from_operations",
    calculation: { operator: "sum", refs: ["operating_member"] },
  }),
  row("investing_activities", "Investing activities", undefined, {
    row_type: "header",
  }),
  row("investment_alpha", "Investment alpha", [-3, -4, -5, null, null, null], {
    forecast_period_authorities: direct(-6),
  }),
  row("investment_beta", "Investment beta", [-1, -2, -3, null, null, null], {
    forecast_period_authorities: direct(-4),
  }),
  row("cash_from_investing", "Issuer investing total", undefined, {
    row_type: "calculation",
    semantic_role: "cash_from_investing",
    calculation: { operator: "sum", refs: ["investment_alpha", "investment_beta"] },
  }),
  row("cash_before_financing", "Cash before financing", undefined, {
    row_type: "calculation",
    semantic_role: "cash_before_financing",
    calculation: {
      operator: "sum",
      refs: ["cash_from_operations", "cash_from_investing"],
    },
  }),
];
const protectedCashFlowCase = {
  case_id: "protected_cash_flow_identities",
  forecast_authority_contract_version: "waterfall_v1",
  periods,
  source_coverage: {
    income_statement: [],
    cash_flow: protectedCashFlowRows
      .filter((candidate) => candidate.row_type !== "header")
      .map((candidate) => ({
        source_line_id: candidate.source_line_ids[0],
        mapped_row_ids: [candidate.row_id],
        material: true,
      })),
  },
  statement_structure: { income_statement: [], cash_flow: protectedCashFlowRows },
};
assert(
  validateForecastAuthorities(protectedCashFlowCase, protectedCashFlowRows).length === 0,
  "Valid same-period protected cash-flow identities were rejected.",
);
const nestedInvestingCase = clone(protectedCashFlowCase);
const nestedInvestingRows = nestedInvestingCase.statement_structure.cash_flow;
const investingTotalIndex = nestedInvestingRows.findIndex(
  (candidate) => candidate.semantic_role === "cash_from_investing",
);
nestedInvestingRows.splice(investingTotalIndex - 2, 0,
  row("investment_alpha_detail", "Investment alpha detail", [-3, -4, -5, null, null, null], {
    forecast_period_authorities: direct(-6),
  }),
);
nestedInvestingRows.find((candidate) => candidate.row_id === "investment_alpha")
  .calculation = { operator: "sum", refs: ["investment_alpha_detail"] };
assert(
  validateForecastAuthorities(nestedInvestingCase, nestedInvestingRows).length === 0,
  "A nested investing detail was misclassified as a second top-level subtotal member.",
);
const unavailableBrokerParent = {
  case_id: "unavailable_broker_parent",
  periods,
  controls: { broker_case: "Forecast Waterfall" },
  broker_pack: {
    metrics: {
      capex: {
        provider_consensus: [null, null, null],
        brokers: { "House A": [null, null, null] },
      },
    },
  },
  statement_structure: {
    income_statement: [],
    cash_flow: [
      row("ppe_detail", "Issuer PP&E purchases", [-1, -2, -3, null, null, null]),
      row("capex_parent", "Issuer capital expenditure", undefined, {
        row_type: "calculation",
        semantic_role: "capex",
        broker_metric_id: "capex",
        calculation: { operator: "sum", refs: ["ppe_detail"] },
      }),
    ],
  },
};
const unavailableBrokerTopology = compileForecastCaptureTopology(
  unavailableBrokerParent,
);
assert(
  !unavailableBrokerParent.statement_structure.cash_flow[0].forecast_capture_parent_id &&
    !unavailableBrokerTopology.behavior_map.some(
      (entry) =>
        entry.row_id === "ppe_detail" && entry.behavior === "captured_detail",
    ),
  "A broker-labelled aggregate with no usable values captured the child needed by its formula fallback.",
);
for (const protectedRole of ["cash_from_investing", "cash_before_financing"]) {
  const mutation = clone(protectedCashFlowCase);
  const protectedRow = mutation.statement_structure.cash_flow.find(
    (candidate) => candidate.semantic_role === protectedRole,
  );
  protectedRow.calculation = {
    operator: "prior_period",
    refs: [protectedRow.row_id],
  };
  protectedRow.forecast_period_authorities = [0, 1, 2].map(() => ({
    method: "carry_forward",
    source_kind: "historical_inference",
    material: true,
    note: "Adversarial prior-period carry on a protected cash-flow identity.",
  }));
  assert(
    validateForecastAuthorities(
      mutation,
      mutation.statement_structure.cash_flow,
    ).some((error) => error.includes("protected cash-flow identity")),
    `${protectedRole} accepted prior-period forecast authority.`,
  );
}

const crossSection = fixture();
crossSection.statement_structure.income_statement[0].forecast_capture_parent_id = "cash_from_financing";
crossSection.statement_structure.income_statement[0].forecast_capture_mode = "semantic_scope";
const crossResult = compileForecastCaptureTopology(crossSection);
assert(
  crossResult.findings.some((finding) => finding.id === "forecast_capture.cross_section"),
  "Cross-statement capture did not block.",
);

const ambiguous = fixture();
ambiguous.statement_structure.income_statement.splice(3, 0,
  row("second_pool", "Second aggregate", undefined, {
    row_type: "calculation",
    calculation: { operator: "sum", refs: ["strange_product_alpha"] },
  }),
);
ambiguous.statement_structure.income_statement.find((candidate) => candidate.row_id === "ebit")
  .calculation.refs.push("second_pool");
const ambiguousResult = compileForecastCaptureTopology(ambiguous);
assert(
  ambiguousResult.findings.some((finding) => finding.id === "forecast_capture.ambiguous_path"),
  "Two different forecast terminals did not block as an ambiguous capture.",
);

const doubleOwned = fixture();
const doubleRows = doubleOwned.statement_structure.income_statement;
doubleRows.splice(3, 0,
  row("parallel_product_total", "Parallel trading aggregation", undefined, {
    row_type: "calculation",
    calculation: { operator: "sum", refs: ["strange_product_alpha"] },
  }),
);
doubleRows.find((candidate) => candidate.row_id === "revenue")
  .calculation.refs.push("parallel_product_total");
const doubleResult = compileForecastCaptureTopology(doubleOwned);
assert(
  doubleResult.findings.some((finding) => finding.id === "forecast_capture.double_ownership"),
  "Two paths to one forecast terminal did not block as double ownership.",
);

console.log(JSON.stringify({
  status: "PASS",
  tests: 32,
  mutations_caught: 6,
  captured_paths: topology.behavior_map.filter((entry) => entry.behavior === "captured_detail").length,
  cash_flow_event_method: state("cash_flow", "debt_fees", 0).method,
}, null, 2));
