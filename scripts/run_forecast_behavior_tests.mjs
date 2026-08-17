#!/usr/bin/env node
import {
  ALLOWED_METHODS_BY_BEHAVIOR,
  classifyForecastBehavior,
  compileForecastBehaviorMap,
  validateForecastBehaviorMap,
} from "./lib/forecast_behavior.mjs";
import {
  compileForecastPlan,
  materializeForecastPlan,
  validateForecastPlan,
  validateForecastPlanCaseParity,
} from "./lib/forecast_candidate_compiler.mjs";
import { validateForecastAuthorities } from "./lib/forecast_authority.mjs";

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
for (const method of ["historical_average", "historical_trend", "carry_forward"]) {
  assert(
    byId(map, "working_capital_bridge").allowed_methods.includes(method),
    `Driver-linked flow lost the ${method} fallback rung when no driver evidence exists.`,
  );
}
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

const directAuthorities = (prefix) => [0, 1, 2].map((forecastIndex) => ({
  method: "user_assumption",
  source_kind: "user_supplied",
  source_id: `${prefix}-${forecastIndex + 1}`,
  as_of_date: "2025-12-31",
  value: 100 + forecastIndex,
  material: true,
  note: "Synthetic direct forecast authority for aggregate-ownership mutation testing.",
}));
const duplicateAggregateRows = [
  {
    row_id: "issuer_aggregate",
    label: "Issuer-defined aggregate",
    row_type: "subtotal",
    calculation: { operator: "sum", refs: ["component_alpha", "component_beta"] },
    historical_authority: "reported_total_reconciled",
    reported_historical_values: [100, 110, 120],
    source_line_ids: ["is.issuer_aggregate"],
    forecast_period_authorities: directAuthorities("aggregate"),
  },
  {
    row_id: "component_alpha",
    label: "Component alpha",
    row_type: "input",
    values: [40, 44, 48, null, null, null],
    historical_authority: "source_input",
    source_line_ids: ["is.component_alpha"],
    forecast_period_authorities: directAuthorities("alpha"),
  },
  {
    row_id: "component_beta",
    label: "Component beta",
    row_type: "input",
    values: [60, 66, 72, null, null, null],
    historical_authority: "source_input",
    source_line_ids: ["is.component_beta"],
    forecast_period_authorities: directAuthorities("beta"),
  },
];
const duplicateAggregateCase = {
  statement_structure: { income_statement: duplicateAggregateRows, cash_flow: [] },
};
assert(
  validateForecastAuthorities(duplicateAggregateCase, duplicateAggregateRows)
    .some((error) => error.includes("mixed aggregate forecast ownership")),
  "A reported aggregate and its complete children retained independent forecasts.",
);
const childrenOwnAggregateRows = clone(duplicateAggregateRows);
delete childrenOwnAggregateRows[0].forecast_period_authorities;
assert(
  !validateForecastAuthorities(
    { statement_structure: { income_statement: childrenOwnAggregateRows, cash_flow: [] } },
    childrenOwnAggregateRows,
  ).some((error) => error.includes("aggregate forecast ownership")),
  "A valid children-own forecast mode was rejected.",
);
const parentOwnAggregateRows = clone(duplicateAggregateRows);
for (const child of parentOwnAggregateRows.slice(1)) {
  delete child.forecast_period_authorities;
  child.row_type = "uncalculated";
  child.forecast_treatment = "uncalculated";
  child.forecast_capture_parent_id = "issuer_aggregate";
}
assert(
  !validateForecastAuthorities(
    { statement_structure: { income_statement: parentOwnAggregateRows, cash_flow: [] } },
    parentOwnAggregateRows,
  ).some((error) => error.includes("aggregate forecast ownership")),
  "A valid parent-own forecast mode was rejected.",
);

// Candidate selection is tested on deliberately unfamiliar labels so the
// result depends on semantic ownership and evidence, never caption matching.
const selectionCase = {
  case_id: "forecast_candidate_selection_fixture",
  issuer: {
    reporting_currency: "GBP",
    units: "millions",
    accounting_basis: "IFRS",
    fiscal_calendar: "fixed_date",
  },
  controls: { broker_case: "Consensus" },
  periods: [
    { date: "2023-12-31", status: "historical" },
    { date: "2024-12-31", status: "historical" },
    { date: "2025-12-31", status: "historical" },
    { date: "2026-12-31", status: "forecast" },
    { date: "2027-12-31", status: "forecast" },
    { date: "2028-12-31", status: "forecast" },
  ],
  broker_pack: { metrics: {} },
  source_coverage: {
    income_statement: [
      { source_line_id: "is.driver", mapped_row_ids: ["strange_driver"], material: true },
      { source_line_id: "is.identity", mapped_row_ids: ["strange_identity"], material: true },
      { source_line_id: "is.lumpy", mapped_row_ids: ["strange_lumpy"], material: true },
    ],
    cash_flow: [
      { source_line_id: "cf.seasonal", mapped_row_ids: ["strange_seasonal"], material: true },
      { source_line_id: "cf.child", mapped_row_ids: ["captured_weird_child"], material: false },
      { source_line_id: "cf.bad-child", mapped_row_ids: ["uncertified_child"], material: false },
      { source_line_id: "cf.legacy-live", mapped_row_ids: ["legacy_uncalculated_live"], material: true },
    ],
  },
};
const captureCertificates = [0, 1, 2].map((forecastIndex) => ({
  forecast_index: forecastIndex,
  parent_row_id: "shared_parent",
  mode: "formula_membership",
  material: false,
  proof: "Parent formula contains this row exactly once.",
}));
const selectionRows = {
  income_statement: [
    {
      row_id: "shared_parent",
      label: "Income-side same identifier",
      row_type: "input",
      values: [1, 1, 1, null, null, null],
    },
    {
      row_id: "strange_driver",
      label: "Issuer-defined operating cadence",
      row_type: "input",
      values: [10, 12, 14, null, null, null],
      forecast_calculation: { operator: "prior_period_scaled_by", refs: ["strange_driver"] },
    },
    {
      row_id: "strange_identity",
      label: "Issuer-defined closing arithmetic",
      row_type: "subtotal",
      values: [20, 24, 28, null, null, null],
      calculation: { operator: "sum", refs: ["strange_driver"] },
    },
    {
      row_id: "strange_lumpy",
      label: "Discontinued programme outlay",
      row_type: "input",
      values: [-8, -3, 0, null, null, null],
      forecast_period_authorities: [0, 1, 2].map(() => ({
        method: "explicit_zero",
        source_kind: "company_reported",
        value: 0,
        note: "The company states that the programme has ended.",
      })),
    },
  ],
  cash_flow: [
    {
      row_id: "shared_parent",
      label: "Cash-side aggregation",
      row_type: "subtotal",
      calculation: { operator: "sum", refs: ["captured_weird_child"] },
      forecast_period_authorities: [0, 1, 2].map((forecastIndex) => ({
        method: "user_assumption",
        source_kind: "user_supplied",
        value: 10 + forecastIndex,
        note: "The aggregate has an independent period authority.",
      })),
    },
    {
      row_id: "captured_weird_child",
      label: "Unusual disclosed movement",
      row_type: "uncalculated",
      forecast_treatment: "uncalculated",
      formula_authority: "intentionally_blank",
      parent_row_id: "shared_parent",
      forecast_capture_parent_id: "shared_parent",
      forecast_capture_mode: "formula_membership",
      forecast_capture_certificates: captureCertificates,
      values: [1, 2, 3, null, null, null],
    },
    {
      row_id: "uncertified_parent",
      label: "Uncertified aggregation",
      row_type: "subtotal",
      calculation: { operator: "sum", refs: ["uncertified_child"] },
    },
    {
      row_id: "uncertified_child",
      label: "Uncertified disclosed movement",
      row_type: "uncalculated",
      forecast_treatment: "uncalculated",
      formula_authority: "intentionally_blank",
      parent_row_id: "uncertified_parent",
      forecast_capture_parent_id: "uncertified_parent",
      forecast_capture_mode: "formula_membership",
      forecast_capture_certificates: [
        {
          forecast_index: 0,
          parent_row_id: "uncertified_parent",
          mode: "formula_membership",
          material: false,
          proof: "First conflicting certificate.",
        },
        {
          forecast_index: 0,
          parent_row_id: "uncertified_parent",
          mode: "formula_membership",
          material: false,
          proof: "Second conflicting certificate.",
        },
      ],
      values: [0, 0, 0, null, null, null],
    },
    {
      row_id: "formula_only_parent",
      label: "Formula-only aggregation",
      row_type: "subtotal",
      calculation: { operator: "sum", refs: ["formula_only_child"] },
    },
    {
      row_id: "formula_only_child",
      label: "Detail incorrectly offered to a formula-only parent",
      row_type: "uncalculated",
      forecast_treatment: "uncalculated",
      formula_authority: "intentionally_blank",
      parent_row_id: "formula_only_parent",
      forecast_capture_parent_id: "formula_only_parent",
      forecast_capture_mode: "formula_membership",
      forecast_capture_certificates: [0, 1, 2].map((forecastIndex) => ({
        forecast_index: forecastIndex,
        parent_row_id: "formula_only_parent",
        mode: "formula_membership",
        material: false,
        proof: "The parent formula contains the child once but has no independent forecast.",
      })),
      values: [4, 5, 6, null, null, null],
    },
    {
      row_id: "strange_seasonal",
      label: "Timing-sensitive collections",
      row_type: "input",
      movement_type: "seasonal",
      values: [25, 30, 35, null, null, null],
    },
    {
      row_id: "legacy_uncalculated_live",
      label: "Legacy disclosed operating movement",
      row_type: "uncalculated",
      forecast_treatment: "uncalculated",
      values: [10, 12, 14, null, null, null],
    },
  ],
};
const selectionBehaviors = {
  rows: [
    ["income_statement", "shared_parent", "recurring_flow"],
    ["income_statement", "strange_driver", "driver_linked_flow"],
    ["income_statement", "strange_identity", "accounting_identity"],
    ["income_statement", "strange_lumpy", "lumpy_discretionary_flow"],
    ["cash_flow", "shared_parent", "accounting_identity"],
    ["cash_flow", "captured_weird_child", "captured_detail"],
    ["cash_flow", "uncertified_parent", "accounting_identity"],
    ["cash_flow", "uncertified_child", "captured_detail"],
    ["cash_flow", "formula_only_parent", "accounting_identity"],
    ["cash_flow", "formula_only_child", "captured_detail"],
    ["cash_flow", "strange_seasonal", "seasonal_flow"],
    ["cash_flow", "legacy_uncalculated_live", "recurring_flow"],
  ].map(([section, row_id, behavior]) => ({
    section,
    row_id,
    behavior,
    allowed_methods: [...ALLOWED_METHODS_BY_BEHAVIOR[behavior]],
    blocking: false,
  })),
};
const selectionObservations = [
  {
    observation_id: "guidance-driver-fy1",
    economic_concept_id: "strange_driver",
    observation_kind: "company_guidance",
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    value: 40,
    source_id: "guidance-source",
  },
  {
    observation_id: "guidance-identity-fy1",
    economic_concept_id: "strange_identity",
    observation_kind: "company_guidance",
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    value: 999,
    source_id: "guidance-source",
  },
];
const selectionPlan = compileForecastPlan(selectionCase, selectionRows, {
  observations: selectionObservations,
  behaviorMap: selectionBehaviors,
});
const selectedState = (section, rowId, forecastIndex) =>
  selectionPlan.states.find(
    (state) =>
      state.section === section &&
      state.row_id === rowId &&
      state.forecast_index === forecastIndex,
  );
assert(
  selectedState("income_statement", "strange_driver", 0).method === "company_guidance",
  "A driver formula incorrectly outranked FY1 company guidance.",
);
assert(
  selectedState("income_statement", "strange_driver", 1).method === "roll_forward",
  "A declared driver/roll-forward did not remain available after evidence assembly.",
);
assert(
  selectedState("income_statement", "strange_identity", 0).method === "accounting_identity",
  "A source observation displaced a genuine accounting identity.",
);
assert(
  selectedState("income_statement", "strange_lumpy", 0).method === "explicit_zero",
  "A sourced no-recurrence zero lost to a weaker lumpy-flow inference.",
);
assert(
  selectedState("cash_flow", "captured_weird_child", 0).method === "not_separately_forecast",
  "A valid section-local capture certificate did not resolve.",
);
assert(
  selectedState("cash_flow", "uncertified_child", 0).status === "BLOCKED",
  "An uncertified parent capture did not fail closed.",
);
assert(
  [0, 1, 2].every(
    (forecastIndex) =>
      selectedState("cash_flow", "formula_only_child", forecastIndex).status === "BLOCKED",
  ),
  "A formula-summed parent without an independent forecast was allowed to capture its child.",
);
assert(
  selectedState("cash_flow", "strange_seasonal", 0).status === "BLOCKED",
  "Annual history was misrepresented as a seasonal run-rate.",
);
assert(
  validateForecastPlan(selectionPlan, selectionRows).length === 0,
  "The adversarial forecast candidate plan is internally inconsistent.",
);

const materializedSelection = materializeForecastPlan(
  { ...selectionCase, statement_structure: selectionRows },
  selectionPlan,
);
const selectedCaptureCandidates = selectionPlan.candidate_ledger.filter(
  (candidate) =>
    candidate.selected &&
    candidate.state_id.startsWith("cash_flow.captured_weird_child."),
);
assert(
  selectedCaptureCandidates.length === 3 &&
    selectedCaptureCandidates.every((candidate) => candidate.capture_certificate),
  "The sealed plan did not retain one section-local capture certificate per period.",
);
assert(
  validateForecastPlanCaseParity(materializedSelection, selectionPlan).length === 0,
  "Section-qualified materialisation did not preserve the sealed plan.",
);
const promotedLegacyRow = materializedSelection.statement_structure.cash_flow.find(
  (row) => row.row_id === "legacy_uncalculated_live",
);
assert(
  promotedLegacyRow.row_type === "input" &&
    promotedLegacyRow.values.slice(3).every((value) => Number.isFinite(value)) &&
    promotedLegacyRow.forecast_period_calculations.every((rule) =>
      ["historical_average", "historical_trend"].includes(rule?.operator),
    ),
  "A forecastable legacy uncalculated row was left blank instead of being promoted through the sealed waterfall.",
);

const ambiguousSectionlessPlan = compileForecastPlan(selectionCase, selectionRows, {
  behaviorMap: {
    rows: [{
      row_id: "shared_parent",
      behavior: "not_applicable",
      allowed_methods: [...ALLOWED_METHODS_BY_BEHAVIOR.not_applicable],
      blocking: false,
    }],
  },
});
assert(
  ambiguousSectionlessPlan.states
    .filter((state) => state.row_id === "shared_parent")
    .every((state) => state.behavior !== "not_applicable"),
  "A sectionless instruction leaked across duplicate row ids in two statements.",
);

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
  tests: 24 + mutations.length,
  adversarial_mutations_caught: mutations.length,
  total_violations: 0,
}, null, 2));
