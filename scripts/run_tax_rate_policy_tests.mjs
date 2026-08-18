#!/usr/bin/env node
/**
 * Effective-tax-rate role-policy regression (the §6.5 matrix).
 *
 * The live failure class: the candidate compiler correctly refuses the
 * circular historical identity for the ETR row, and nothing else guaranteed
 * an authority, so an ordinary supported company terminated at Build. This
 * suite proves the policy closes that obligation for every named shape, and
 * that the policy candidate LOSES to guidance/broker/user authorities.
 */

import assert from "node:assert/strict";

import {
  normaliseHistoricalEffectiveTaxRates,
  taxRatePolicyCandidate,
} from "./lib/tax_rate_policy.mjs";
import { forecastAuthorityRankVector, selectForecastAuthority } from "./lib/forecast_authority.mjs";

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function caseWith({ taxes, pbts }) {
  return {
    statement_structure: {
      income_statement: [
        { row_id: "pre_tax_income", row_type: "calculation", values: [...pbts, null, null, null] },
        {
          row_id: "effective_tax_rate",
          row_type: "input",
          semantic_role: "effective_tax_rate",
          values: [null, null, null, null, null, null],
        },
        { row_id: "tax_expense", row_type: "calculation", values: [...taxes, null, null, null] },
      ],
      cash_flow: [],
    },
  };
}

const etrRow = (modelCase) =>
  modelCase.statement_structure.income_statement.find((row) => row.row_id === "effective_tax_rate");

// 1. ordinary positive PBT, three clean years -> median, stable, no trend
{
  const modelCase = caseWith({ taxes: [-190, -210, -230], pbts: [1000, 1050, 1100] });
  const candidate = taxRatePolicyCandidate(modelCase, etrRow(modelCase), 0);
  check(candidate?.method === "historical_average", "clean history must produce the median rung");
  check(Math.abs(candidate.value - 0.2) < 0.011, `median must be the middle normalized rate, got ${candidate.value}`);
  check(candidate.formula_spec.operator === "tax_rate_policy_median", "the policy formula must be named");
  check(candidate.tax_rate_normalization.periods.every((period) => period.usable), "all three periods usable");
  const fy3 = taxRatePolicyCandidate(modelCase, etrRow(modelCase), 2);
  check(Math.abs(fy3.value - candidate.value) < 1e-12,
    "the policy rate must be identical across forecast periods — no accelerating trend on a rate");
}

// 2. one distorted historical year (rate above ceiling) -> excluded with reason, median of the rest
{
  const modelCase = caseWith({ taxes: [-190, -900, -230], pbts: [1000, 1050, 1100] });
  const candidate = taxRatePolicyCandidate(modelCase, etrRow(modelCase), 0);
  check(candidate?.method === "historical_average", "two usable periods still reach the median rung");
  const excluded = candidate.tax_rate_normalization.periods[1];
  check(excluded.usable === false && /ceiling/.test(excluded.exclusion_reason),
    "the distorted year must be excluded with its reason recorded");
}

// 3. exactly one usable year -> latest usable carried forward
{
  const modelCase = caseWith({ taxes: [-900, null, -230], pbts: [1000, 1050, 1100] });
  const candidate = taxRatePolicyCandidate(modelCase, etrRow(modelCase), 1);
  check(candidate?.method === "carry_forward", "one usable period carries forward");
  check(Math.abs(candidate.value - 230 / 1100) < 1e-9, "the carried rate is the usable year's rate");
}

// 4. near-zero PBT year excluded
{
  const modelCase = caseWith({ taxes: [-190, -1, -230], pbts: [1000, 2, 1100] });
  const normalization = normaliseHistoricalEffectiveTaxRates(modelCase);
  check(normalization.periods[1].classification === "near_zero_pbt",
    "a near-zero PBT period is classified, not ratio'd");
  check(normalization.usable_rates.length === 2, "the remaining periods stay usable");
}

// 5. tax credit against positive PBT excluded
{
  const modelCase = caseWith({ taxes: [-190, 40, -230], pbts: [1000, 1050, 1100] });
  const normalization = normaliseHistoricalEffectiveTaxRates(modelCase);
  const period = normalization.periods[1];
  check(period.usable === false && period.classification === "tax_credit_on_profit",
    "a credit year is recorded and excluded");
}

// 6. positive-expense filing convention normalized and usable
{
  const modelCase = caseWith({ taxes: [190, 210, 230], pbts: [1000, 1050, 1100] });
  const candidate = taxRatePolicyCandidate(modelCase, etrRow(modelCase), 0);
  check(candidate?.method === "historical_average", "positive-expense convention still normalizes");
  check(
    candidate.tax_rate_normalization.periods.every(
      (period) => period.classification === "positive_expense_convention",
    ),
    "the convention is recorded on every period",
  );
}

// 7. all-loss history -> explicit loss-case policy, never a silent invented rate
{
  const modelCase = caseWith({ taxes: [60, 45, 30], pbts: [-400, -300, -200] });
  const candidate = taxRatePolicyCandidate(modelCase, etrRow(modelCase), 0);
  check(candidate?.method === "explicit_zero", "the loss case resolves explicitly");
  check(candidate.formula_spec.operator === "tax_rate_policy_loss_case", "the loss policy is named");
  check(/loss/.test(candidate.note), "the note must explain the loss policy");
  check(
    candidate.tax_rate_normalization.periods.every(
      (period) => period.classification === "loss_tax_benefit",
    ),
    "loss periods are classified as tax benefit shapes",
  );
}

// 8. missing dependencies everywhere -> the policy stays silent (row escalates
//    to a decision, it does not invent a rate)
{
  const modelCase = caseWith({ taxes: [null, null, null], pbts: [null, null, null] });
  check(taxRatePolicyCandidate(modelCase, etrRow(modelCase), 0) === null,
    "no usable history and no loss shape must yield no candidate");
}

// 9. hierarchy: broker/guidance/user candidates all outrank the policy rung
{
  const modelCase = caseWith({ taxes: [-190, -210, -230], pbts: [1000, 1050, 1100] });
  const policy = taxRatePolicyCandidate(modelCase, etrRow(modelCase), 0);
  for (const method of ["company_guidance", "broker_consensus", "user_assumption"]) {
    const stronger = {
      method,
      origin: "test",
      source_kind: "test",
      value: 0.21,
      definition_compatible: true,
      units_compatible: true,
      period_compatible: true,
    };
    for (const candidate of [stronger, policy]) {
      candidate.rank_vector = forecastAuthorityRankVector(candidate);
    }
    const selected = selectForecastAuthority([policy, stronger]);
    check(selected === stronger, `${method} must outrank the tax-rate policy`);
  }
}

// 10. the sign-mutation guard: flipping PBT sign flips the classification
{
  const modelCase = caseWith({ taxes: [-190, -210, -230], pbts: [1000, -1050, 1100] });
  const normalization = normaliseHistoricalEffectiveTaxRates(modelCase);
  check(normalization.periods[1].classification === "loss_with_tax_charge",
    "a mutated loss period must be reclassified, not averaged");
  check(normalization.usable_rates.length === 2, "the clean periods survive the mutation");
}

console.log(JSON.stringify({ checks, status: "PASS" }));
