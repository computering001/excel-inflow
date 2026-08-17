#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  forecastAuthorityDecidingDimension,
  forecastAuthorityRankVector,
  selectForecastAuthority,
} from "./lib/forecast_authority.mjs";
import {
  compileForecastPlan,
  forecastPlanSha256,
  materializeForecastPlan,
  validateForecastPlan,
} from "./lib/forecast_candidate_compiler.mjs";
import {
  sealForecastAuthorityLedger,
  verifyForecastAuthorityLedger,
} from "./lib/forecast_authority_ledger.mjs";

const baseCandidate = {
  method: "company_guidance",
  source_kind: "company_guidance",
  definition_compatible: true,
  period_compatible: true,
  period_completeness: 1,
  units_compatible: true,
  freshness_date: "2026-01-01",
  confidence: 0.9,
  completeness: 1,
};

function candidate(sourceId, overrides = {}) {
  return { ...baseCandidate, source_id: sourceId, stable_id: sourceId, ...overrides };
}

function expectWinner(name, winnerOverrides, rejectedOverrides, dimension) {
  const winner = candidate("z_economic_winner", winnerOverrides);
  const rejected = candidate("a_lexical_winner", rejectedOverrides);
  assert.equal(
    selectForecastAuthority([rejected, winner]).source_id,
    winner.source_id,
    `${name} fell through to stable identifier ordering.`,
  );
  assert.equal(
    selectForecastAuthority([winner, rejected]).source_id,
    winner.source_id,
    `${name} changed after candidate insertion order reversed.`,
  );
  assert.equal(
    forecastAuthorityDecidingDimension(winner, rejected),
    dimension,
    `${name} did not retain its deciding rank dimension.`,
  );
}

expectWinner(
  "definition compatibility",
  { definition_compatible: true },
  { definition_compatible: false },
  "definition_score",
);
expectWinner(
  "period compatibility",
  { period_compatible: true, period_completeness: 1 },
  { period_compatible: false, period_completeness: 0 },
  "period_score",
);
expectWinner(
  "unit compatibility",
  { units_compatible: true },
  { units_compatible: false },
  "units_score",
);
expectWinner(
  "freshness",
  { freshness_date: "2026-08-01" },
  { freshness_date: "2025-01-01" },
  "freshness_timestamp",
);
expectWinner(
  "confidence",
  { confidence: 0.99 },
  { confidence: 0.2 },
  "confidence_score",
);
expectWinner(
  "series completeness",
  { completeness: 1 },
  { completeness: 1 / 3 },
  "completeness_score",
);

const exactTieA = candidate("a_final_tie");
const exactTieZ = candidate("z_final_tie");
assert.equal(selectForecastAuthority([exactTieZ, exactTieA]).source_id, "a_final_tie");
assert.equal(selectForecastAuthority([exactTieA, exactTieZ]).source_id, "a_final_tie");
assert.equal(
  forecastAuthorityDecidingDimension(exactTieA, exactTieZ),
  "stable_id",
);
assert.equal(forecastAuthorityRankVector(exactTieA).stable_id, "a_final_tie");

const periods = [
  "2023-12-31",
  "2024-12-31",
  "2025-12-31",
  "2026-12-31",
  "2027-12-31",
  "2028-12-31",
].map((date, index) => ({
  date,
  status: index < 3 ? "historical" : "forecast",
}));
const forecastPeriods = periods.slice(3).map((period) => period.date);

const declaredGuidance = [0, 1, 2].map(() => ({
  method: "company_guidance",
  source_kind: "company_guidance",
  material: true,
  note: "The authority class is declared; the candidate compiler resolves the executable source.",
}));
const rows = {
  income_statement: [
    {
      row_id: "ranked_guidance",
      semantic_role: "ranked_guidance",
      row_type: "input",
      historical_authority: "source_input",
      values: [100, 110, 120, null, null, null],
      forecast_period_authorities: declaredGuidance,
    },
    {
      row_id: "partial_revenue",
      semantic_role: "partial_revenue",
      row_type: "input",
      historical_authority: "source_input",
      values: [200, 220, 240, null, null, null],
    },
  ],
  cash_flow: [],
};
const modelCase = {
  case_id: "forecast_authority_ranking",
  issuer: {
    reporting_currency: "USD",
    units: "millions",
  },
  periods,
  source_coverage: {
    income_statement: [
      {
        source_line_id: "is.ranked_guidance",
        mapped_row_ids: ["ranked_guidance"],
        material: true,
      },
      {
        source_line_id: "is.partial_revenue",
        mapped_row_ids: ["partial_revenue"],
        material: true,
      },
    ],
    cash_flow: [],
  },
};
const behaviorMap = {
  rows: rows.income_statement.map((row) => ({
    section: "income_statement",
    row_id: row.row_id,
    behavior: "recurring_flow",
    allowed_methods: [
      "actual_plus_remainder",
      "company_guidance",
      "historical_average",
      "historical_trend",
      "carry_forward",
    ],
    blocking: false,
  })),
};
const sourceInventory = [
  {
    source_id: "a_stale_source",
    publication_date: "2025-01-01",
  },
  {
    source_id: "z_fresh_source",
    publication_date: "2026-08-01",
  },
  {
    source_id: "y_wrong_currency_source",
    publication_date: "2026-12-01",
  },
  {
    source_id: "reported_interim",
    publication_date: "2026-07-15",
  },
];

function annualObservation({
  observationId,
  concept,
  sourceId,
  periodEnd,
  value,
  units = "USDm",
}) {
  const year = Number(periodEnd.slice(0, 4));
  return {
    observation_id: observationId,
    economic_concept_id: concept,
    definition_id: `${concept}.reported`,
    units,
    sign_convention: "positive_income",
    period_basis: "annual",
    period_start: `${year}-01-01`,
    period_end: periodEnd,
    reported_through: null,
    value,
    observation_kind: "company_guidance",
    source_id: sourceId,
  };
}

const observations = [];
for (let index = 0; index < 3; index += 1) {
  observations.push(annualObservation({
    observationId: `a_weak_guidance_fy${index + 1}`,
    concept: "ranked_guidance",
    sourceId: "a_stale_source",
    periodEnd: forecastPeriods[index],
    value: 900 + index,
  }));
  observations.push(annualObservation({
    observationId: `z_strong_guidance_fy${index + 1}`,
    concept: "ranked_guidance",
    sourceId: "z_fresh_source",
    periodEnd: forecastPeriods[index],
    value: 300 + index,
  }));
  observations.push(annualObservation({
    observationId: `y_wrong_currency_guidance_fy${index + 1}`,
    concept: "ranked_guidance",
    sourceId: "y_wrong_currency_source",
    periodEnd: forecastPeriods[index],
    value: 700 + index,
    units: "EURm",
  }));
}
observations.push({
  observation_id: "reported_h1",
  economic_concept_id: "partial_revenue",
  definition_id: "partial_revenue.reported",
  units: "USDm",
  sign_convention: "positive_income",
  period_basis: "h1_ytd",
  period_start: "2026-01-01",
  period_end: "2026-06-30",
  reported_through: "2026-06-30",
  value: 130,
  observation_kind: "company_actual",
  source_id: "reported_interim",
});
observations.push(annualObservation({
  observationId: "a_stale_full_year",
  concept: "partial_revenue",
  sourceId: "a_stale_source",
  periodEnd: "2026-12-31",
  value: 999,
}));
observations.push(annualObservation({
  observationId: "z_fresh_full_year",
  concept: "partial_revenue",
  sourceId: "z_fresh_source",
  periodEnd: "2026-12-31",
  value: 320,
}));

function compile(candidateObservations) {
  return compileForecastPlan(modelCase, structuredClone(rows), {
    behaviorMap,
    observationLedger: {
      schema_version: "forecast-observation-ledger/1.0",
      ledger_id: "ranking",
      observations: candidateObservations,
    },
    sourceInventory,
  });
}

const plan = compile(observations);
const reversedPlan = compile([...observations].reverse());
assert.equal(
  forecastPlanSha256(plan),
  forecastPlanSha256(reversedPlan),
  "Candidate record ordering changed the sealed forecast plan identity.",
);
for (const candidatePlan of [plan, reversedPlan]) {
  assert.deepEqual(validateForecastPlan(candidatePlan, rows), []);
  const guidanceStates = candidatePlan.states.filter(
    (state) => state.row_id === "ranked_guidance",
  );
  assert.deepEqual(guidanceStates.map((state) => state.value), [300, 301, 302]);
  const selectedGuidance = candidatePlan.candidate_ledger.filter(
    (entry) => entry.selected && entry.state_id.includes("ranked_guidance"),
  );
  assert.equal(selectedGuidance.length, 3);
  assert(selectedGuidance.every((entry) => entry.source_id === "z_fresh_source"));
  assert(
    candidatePlan.candidate_ledger
      .filter((entry) => entry.source_id === "y_wrong_currency_source")
      .every((entry) => entry.units_compatible === false),
    "A wrong-currency observation was not identified before freshness ranking.",
  );
  assert(selectedGuidance.every((entry) => entry.rank_vector.freshness_timestamp > 0));

  const partialState = candidatePlan.states.find(
    (state) => state.row_id === "partial_revenue" && state.forecast_index === 0,
  );
  const partialCandidate = candidatePlan.candidate_ledger.find(
    (entry) => entry.candidate_id === partialState.selected_candidate_id,
  );
  assert.equal(partialState.method, "actual_plus_remainder");
  assert.equal(partialState.value, 320);
  assert.equal(
    partialCandidate.formula_spec.full_year_observation_id,
    "z_fresh_full_year",
  );
  assert.equal(partialCandidate.partial_period.forecast_remainder, 190);
}

const materialized = materializeForecastPlan(
  { ...modelCase, statement_structure: structuredClone(rows) },
  plan,
);
const materializedGuidance = materialized.statement_structure.income_statement[0]
  .forecast_period_authorities;
assert(materializedGuidance.every((authority) => authority.source_id === "z_fresh_source"));
assert(materializedGuidance.every((authority) => authority.confidence === 1));
assert(materializedGuidance.every((authority) => authority.selection_rank));
sealForecastAuthorityLedger(materialized);
verifyForecastAuthorityLedger(materialized);
assert(
  materialized.forecast_authority_ledger.rows
    .filter((row) => row.row_id === "ranked_guidance")
    .every((row) => row.selection_rank && row.confidence === 1),
);

const rankTamper = structuredClone(plan);
const tamperedCandidate = rankTamper.candidate_ledger.find((entry) => entry.selected);
tamperedCandidate.rank_vector.confidence_score = 0;
assert(
  validateForecastPlan(rankTamper, rows).some((error) => error.includes("rank proof")),
  "A selected-candidate rank mutation escaped plan validation.",
);

const stateRankTamper = structuredClone(plan);
stateRankTamper.states[0].selected_rank_vector.stable_id = "tampered";
assert(
  validateForecastPlan(stateRankTamper, rows).some((error) => error.includes("rank proof")),
  "A state rank mutation escaped plan validation.",
);

console.log(JSON.stringify({
  status: "PASS",
  direct_rank_dimensions: 6,
  stable_tie_checks: 4,
  compiler_orderings: 2,
  declared_shell_periods: 3,
  actual_plus_remainder_pairings: 2,
  rank_mutations_caught: 2,
  total_violations: 0,
}, null, 2));
