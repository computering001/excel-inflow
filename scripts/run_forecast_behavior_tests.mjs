#!/usr/bin/env node
import {
  ALLOWED_METHODS_BY_BEHAVIOR,
  classifyForecastBehavior,
  compileForecastBehaviorMap,
  validateForecastBehaviorMap,
} from "./lib/forecast_behavior.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function clone(value) { return structuredClone(value); }
function byId(map, rowId) { return map.rows.find((row) => row.row_id === rowId); }

const modelCase = {
  case_id: "semantic_forecast_behavior_fixture",
  cash_flow_method: "mixed_test_fixture",
  source_coverage: {
    income_statement: [
      { source_line_id: "is.1", mapped_row_ids: ["revenue_total"], material: true },
      { source_line_id: "is.2", mapped_row_ids: ["legal_event"], material: true, reason: "Discrete litigation settlement." },
    ],
    cash_flow: [
      { source_line_id: "cf.1", mapped_row_ids: ["cash_collected"], material: true },
      { source_line_id: "cf.2", mapped_row_ids: ["working_capital_bridge"], material: true },
      { source_line_id: "cf.3", mapped_row_ids: ["project_investment"], material: true },
      { source_line_id: "cf.4", mapped_row_ids: ["captured_misc"], material: false },
      { source_line_id: "cf.5", mapped_row_ids: ["opaque_material"], material: true },
    ],
  },
};

const rowsBySection = {
  income_statement: [
    {
      row_id: "revenue_total", label: "Aggregate trading inflow", semantic_role: "revenue",
      row_type: "subtotal", calculation: { operator: "sum", refs: ["division_alpha", "division_beta"] },
    },
    {
      row_id: "legal_event", label: "Resolution of historical claims", semantic_role: "litigation",
      row_type: "input", movement_type: "non_recurring",
    },
    { row_id: "section_marker", label: "Earnings", row_type: "header" },
  ],
  cash_flow: [
    {
      row_id: "cash_collected", label: "Collections routed through settlement accounts",
      semantic_role: "cash_received_from_customers", row_type: "input", movement_type: "ordinary operating flow",
    },
    {
      row_id: "working_capital_bridge", label: "Commercial timing bridge",
      semantic_role: "change_in_working_capital", row_type: "input",
      forecast_driver_id: "revenue_total",
    },
    {
      row_id: "project_investment", label: "Programme deployment envelope",
      semantic_role: "capital_expenditure", row_type: "input", evidence_description: "Discretionary project spend",
    },
    {
      row_id: "captured_misc", label: "Minor components", row_type: "uncalculated",
      forecast_treatment: "not_separately_forecast", forecast_capture_parent_id: "working_capital_bridge",
    },
    {
      row_id: "opaque_material", label: "Other cash movement", row_type: "input",
    },
  ],
  debt_schedule: [
    { row_id: "senior_balance", label: "Term funding balance", semantic_role: "ending_debt", row_type: "calculation" },
  ],
  interest_schedule: [
    { row_id: "funding_charge", label: "Financing yield charge", semantic_role: "interest_expense", row_type: "calculation" },
  ],
  acquisition: [
    {
      row_id: "transaction_cost", label: "Combination implementation outlay",
      semantic_role: "acquisition_cost", row_type: "input", movement_type: "one_time",
      material: true,
    },
  ],
};

const map = compileForecastBehaviorMap(modelCase, rowsBySection);
assert(byId(map, "revenue_total").behavior === "accounting_identity", "Renamed subtotal lost accounting-identity semantics.");
assert(byId(map, "cash_collected").behavior === "recurring_flow", "Direct-method customer receipts were not treated as recurring.");
assert(byId(map, "working_capital_bridge").behavior === "driver_linked_flow", "Indirect-method working capital lost its driver path.");
assert(byId(map, "project_investment").behavior === "lumpy_discretionary_flow", "Unusually labelled capex was not classified from semantics.");
assert(byId(map, "captured_misc").behavior === "captured_detail", "Parent-captured detail was not preserved.");
assert(byId(map, "senior_balance").behavior === "schedule_owned", "Debt balance was not schedule owned.");
assert(byId(map, "funding_charge").behavior === "schedule_owned", "Interest expense was not schedule owned.");
assert(byId(map, "transaction_cost").behavior === "non_recurring_event", "M&A cost was not non-recurring.");
assert(byId(map, "legal_event").behavior === "non_recurring_event", "Litigation was not non-recurring.");
assert(byId(map, "section_marker").behavior === "not_applicable", "Header was forecast as an economic row.");
assert(map.status === "BLOCK", "Low-confidence material ambiguity did not block the map.");
assert(map.violations.some((item) => item.row_id === "opaque_material"), "Ambiguous material row has no blocking violation.");

const reordered = Object.fromEntries(
  Object.entries(rowsBySection).reverse().map(([section, rows]) => [section, [...rows].reverse()]),
);
assert(
  JSON.stringify(compileForecastBehaviorMap(modelCase, reordered)) === JSON.stringify(map),
  "Classification changed after sections and rows were reordered.",
);

const renamed = clone(rowsBySection);
renamed.cash_flow.find((row) => row.row_id === "project_investment").label = "Unrecognisable issuer wording";
renamed.income_statement.find((row) => row.row_id === "legal_event").label = "Unusual disclosed line";
const renamedMap = compileForecastBehaviorMap(modelCase, renamed);
assert(byId(renamedMap, "project_investment").behavior === "lumpy_discretionary_flow", "Classification depended on exact capex label.");
assert(byId(renamedMap, "legal_event").behavior === "non_recurring_event", "Classification depended on exact litigation label.");

const seasonal = classifyForecastBehavior(modelCase, {
  row_id: "holiday_receipts", label: "Cash intake", row_type: "input",
  movement_type: "seasonal", material: true,
}, { section: "cash_flow", rows: [] });
assert(seasonal.behavior === "seasonal_flow", "Seasonal movement metadata was ignored.");
const contractual = classifyForecastBehavior(modelCase, {
  row_id: "committed_volume", label: "Volume obligation", row_type: "input",
  movement_type: "contractual commitment", material: true,
}, { section: "cash_flow", rows: [] });
assert(contractual.behavior === "contractual_flow", "Contractual movement metadata was ignored.");

const valid = validateForecastBehaviorMap(map);
assert(valid.status === "PASS" && valid.total_violations === 0, `Baseline artifact is invalid: ${JSON.stringify(valid)}`);

const mutations = [
  ["unknown behavior", (value) => { value.rows[0].behavior = "company_specific_magic"; }],
  ["extra property", (value) => { value.rows[0].cell = "J47"; }],
  ["missing rationale", (value) => { value.rows[0].rationale = ""; }],
  ["method mismatch", (value) => { value.rows[0].allowed_methods = [...ALLOWED_METHODS_BY_BEHAVIOR.schedule_owned]; }],
  ["duplicate row", (value) => { value.rows.push(clone(value.rows[0])); }],
  ["false pass", (value) => { value.status = "PASS"; value.violations = []; }],
  ["suppressed block", (value) => { const row = byId(value, "opaque_material"); row.blocking = false; }],
];
for (const [name, mutate] of mutations) {
  const candidate = clone(map);
  mutate(candidate);
  const result = validateForecastBehaviorMap(candidate);
  assert(result.status === "FAIL" && result.total_violations > 0, `Adversarial mutation was not caught: ${name}`);
}

console.log(JSON.stringify({
  status: "PASS",
  tests: 20 + mutations.length,
  adversarial_mutations_caught: mutations.length,
  total_violations: 0,
}, null, 2));
