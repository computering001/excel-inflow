#!/usr/bin/env node
/**
 * P7.1b — archetype catalogue runner, ECONOMICS group.
 *
 * Invariant under test: every entry in assets/archetype-catalogue-economics-v1.json
 * names ONE accounting shape a naive implementation gets wrong, binds it to a
 * minimal synthetic v2 case under test-fixtures/archetypes/economics/, and
 * declares TYPED expectations that this runner ASSERTS against compiled
 * artifacts. A case that merely compiles proves nothing, so:
 *
 *   1. the catalogue is validated against the shared schema
 *      (assets/archetype-case-catalogue-v1.schema.json, owned jointly with the
 *      presentation group — read only here);
 *   2. every entry must carry at least one expectation whose kind is not
 *      compiles_clean;
 *   3. every declared expectation must have an IMPLEMENTED check — an
 *      expectation with no bound check fails the run (mutation-proved below);
 *   4. every check must actually assert something — a check that runs no
 *      assertion fails the run (mutation-proved below);
 *   5. every {dimension, value} pair claimed under proves_envelope_values must
 *      resolve in assets/support-envelope-v377.json, and every typed_refusal /
 *      unsupported_profile_early_stop expectation must name a reason code
 *      registered in assets/terminal-reason-registry-v1.json.
 *
 * The cases live in test-fixtures/archetypes/economics/ and NOWHERE else:
 * test-fixtures/cases/ is globbed by other suites and its derived synthetic
 * donor is hash-pinned in scripts/lib/raw_canary_fixture.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import { validateCaseShape, solveCase } from "./lib/solver.mjs";
import { compileInstrumentPeriodState } from "./lib/instrument_period_state.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import { compileModelIrV3, assertModelIrV3Pass } from "./lib/model_ir_v3.mjs";
import {
  validateFiscalPeriods,
  validateSolutionInvariants,
} from "./lib/validation_invariants.mjs";
import {
  normaliseHistoricalEffectiveTaxRates,
  taxRatePolicyCandidate,
} from "./lib/tax_rate_policy.mjs";
import { classifySupport, loadSupportEnvelope } from "./lib/support_envelope.mjs";
import { compileOpeningDebtBridge } from "./lib/opening_debt_bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CATALOGUE_PATH = path.join(REPO, "assets/archetype-catalogue-economics-v1.json");
const SCHEMA_PATH = path.join(REPO, "assets/archetype-case-catalogue-v1.schema.json");
const REGISTRY_PATH = path.join(REPO, "assets/terminal-reason-registry-v1.json");
const MODEL_CASE_SCHEMA_PATH = path.join(REPO, "assets/model-case-v2.schema.json");
const CASE_DIRECTORY_PREFIX = "test-fixtures/archetypes/economics/";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const near = (left, right, tolerance = 1e-9) =>
  Number.isFinite(Number(left)) &&
  Number.isFinite(Number(right)) &&
  Math.abs(Number(left) - Number(right)) <= tolerance;

// ---------------------------------------------------------------------------
// Compilation. Every entry's case is compiled the same way; an entry whose
// shape the product refuses is still compiled, and the refusal is what its
// expectation asserts.
function compileArchetype(modelCase) {
  const shapeErrors = validateCaseShape(modelCase);
  const result = {
    shapeErrors,
    ok: false,
    error: null,
    solution: null,
    instrumentPeriodState: null,
    rowPlan: null,
    semanticManifest: null,
    modelIr: null,
    solutionInvariants: null,
    fiscalErrors: validateFiscalPeriods(modelCase),
  };
  if (shapeErrors.length > 0) return result;
  try {
    result.solution = solveCase(modelCase);
    result.instrumentPeriodState = compileInstrumentPeriodState(modelCase);
    result.rowPlan = compileRowPlan(modelCase, {
      instrumentPeriodState: result.instrumentPeriodState,
    });
    result.semanticManifest = compileSemanticManifest(modelCase, result.rowPlan, {
      instrumentPeriodState: result.instrumentPeriodState,
    });
    result.modelIr = compileModelIrV3({
      modelCase,
      rowPlan: result.rowPlan,
      semanticManifest: result.semanticManifest,
      instrumentPeriodState: result.instrumentPeriodState,
    });
    assertModelIrV3Pass(result.modelIr);
    result.solutionInvariants = validateSolutionInvariants(result.solution);
    result.ok = true;
  } catch (error) {
    result.error = error;
  }
  return result;
}

const ENVELOPE = loadSupportEnvelope();
const REGISTRY = readJson(REGISTRY_PATH);
const MODEL_CASE_SCHEMA = readJson(MODEL_CASE_SCHEMA_PATH);

/** A complete, honest intake descriptor for a synthetic case: no broker pack. */
const descriptor = (overrides = {}) => ({
  accounting_framework: "ifrs",
  entity_type: "non_financial_corporate",
  filing_language_format: "english_text_pdf",
  historical_periods: "three_or_more",
  statement_topology: "standard_three_statement",
  cash_flow_method: "indirect",
  fiscal_calendar: "fixed_date",
  debt_instruments: "within_declared_matrix",
  broker_availability: "broker_pack_absent",
  acquisition_overlay: "none",
  restructuring_complexity: "none",
  ...overrides,
});

const DAY_MS = 86400000;
const spanDays = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
/** Every property NAME anywhere in a case: what the contract can declare. */
function declaredKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) declaredKeys(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      declaredKeys(item, into);
    }
  }
  return into;
}
const noDeclaredKeyMatching = (modelCase, pattern) =>
  [...declaredKeys(modelCase)].filter((key) => pattern.test(key));
const clone = (value) => JSON.parse(JSON.stringify(value));
const forecast = (context) => context.compiled.solution.forecast;
const instrument = (period, id) =>
  period.instrument_results.find((result) => result.instrument_id === id);
const taxLedger = (context) =>
  normaliseHistoricalEffectiveTaxRates(context.modelCase);
const taxCandidate = (context) =>
  taxRatePolicyCandidate(
    context.modelCase,
    { semantic_role: "effective_tax_rate", row_id: "effective_tax_rate" },
    0,
  );
const RATE_ROW = { semantic_role: "effective_tax_rate", row_id: "effective_tax_rate" };

// ---------------------------------------------------------------------------
// One implemented check per declared expectation. The key is
// archetype_id -> expectation_id; a declared expectation with no entry here
// fails the run, and a check that asserts nothing fails the run.
const CHECKS = {
  // ------------------------------------------------------ period / calendar --
  fiscal_53_week_year: {
    week_series_validates(context) {
      const { modelCase, compiled } = context;
      check(modelCase.issuer.fiscal_calendar === "52_53_week", "calendar must be declared 52_53_week");
      check(compiled.fiscalErrors.length === 0, `52/53-week series must validate clean, got ${JSON.stringify(compiled.fiscalErrors)}`);
      const dates = modelCase.periods.map((period) => period.date);
      const weeks = dates.slice(1).map((date, index) => spanDays(dates[index], date) / 7);
      check(weeks.every((count) => Number.isInteger(count)), `every span must be whole weeks, got ${JSON.stringify(weeks)}`);
      check(weeks.filter((count) => count === 53).length === 1, `exactly one 53-week year, got ${JSON.stringify(weeks)}`);
      check(weeks.filter((count) => count === 52).length === weeks.length - 1, "every other span must be 52 weeks");
      const weekdays = new Set(dates.map((date) => new Date(`${date}T00:00:00Z`).getUTCDay()));
      check(weekdays.size === 1, `one closing weekday, got ${JSON.stringify([...weekdays])}`);
      // The two contracts name the same calendar differently — recorded, not repaired.
      const envelopeValues = Object.keys(ENVELOPE.contract.dimensions.fiscal_calendar.values);
      check(envelopeValues.includes("week_52_53"), "the envelope spells the calendar week_52_53");
      check(!envelopeValues.includes(modelCase.issuer.fiscal_calendar),
        `while the case spells it ${modelCase.issuer.fiscal_calendar}: no string join relates the case field to the envelope dimension value`);
    },
    fixed_date_declaration_bites(context) {
      const asFixed = clone(context.modelCase);
      asFixed.issuer.fiscal_calendar = "fixed_date";
      const fixedErrors = validateFiscalPeriods(asFixed);
      check(fixedErrors.length === 6, `same dates as fixed_date must flag all six periods, got ${fixedErrors.length}`);
      check(fixedErrors.every((error) => error.id === "periods.fiscal_year_end_mismatch"), "fixed-date failures must be the typed year-end mismatch");
      const slipped = clone(context.modelCase);
      slipped.periods[2].date = new Date(Date.parse(slipped.periods[2].date) + DAY_MS)
        .toISOString().slice(0, 10);
      const slippedIds = new Set(validateFiscalPeriods(slipped).map((error) => error.id));
      check(slippedIds.has("periods.52_53_week_span"), "a one-day slip must fail the whole-week span test");
      check(slippedIds.has("periods.52_53_week_weekday_drift"), "a one-day slip must fail the single-weekday test");
    },
    extra_week_is_unnormalised(context) {
      const { modelCase } = context;
      const weekFields = noDeclaredKeyMatching(modelCase, /week|days|length|annualis/i);
      check(weekFields.length === 0, `the case contract carries no week-count or period-length field, found ${JSON.stringify(weekFields)}`);
      check(modelCase.periods.every((period) => Object.keys(period).join(",") === "date,status"),
        "a period states only its end date and status: there is nowhere to say how long it was");
      const revenueRow = modelCase.statement_structure.income_statement.find((row) => row.semantic_role === "revenue");
      const filed = revenueRow.values.slice(0, 3);
      const growth = filed[2] / filed[1] - 1;
      const fiftyTwoWeekEquivalent = filed[2] * (52 / 53) / filed[1] - 1;
      check(growth > fiftyTwoWeekEquivalent + 0.015,
        `the 53-week year's reported growth (${growth.toFixed(4)}) exceeds its 52-week equivalent (${fiftyTwoWeekEquivalent.toFixed(4)}) and nothing states the difference`);
      const solved = forecast(context).map((period) => period.revenue);
      check(solved.every((value, index) => near(value, revenueRow.values[index + 3])),
        "the solved revenue series is the filed nominal series unchanged");
    },
  },
  stub_short_first_period: {
    stub_period_is_typed(context) {
      const errors = context.compiled.fiscalErrors;
      check(errors.length === 1, `exactly one typed period error, got ${JSON.stringify(errors)}`);
      check(errors[0].id === "periods.fiscal_year_end_mismatch", "the error must be the typed year-end mismatch");
      check(errors[0].period_index === 0, "the flagged period must be the stub column");
      check(errors[0].expected_month_day === "12-31", "the error must name the expected year end");
    },
    stub_span_is_not_annualised(context) {
      const dates = context.modelCase.periods.map((period) => period.date);
      const spans = dates.slice(1).map((date, index) => spanDays(dates[index], date));
      check(spans[0] < 300, `the stub span must be short, got ${spans[0]} days`);
      check(spans.slice(1).every((span) => span >= 365 && span <= 366), `every later span must be a full year, got ${JSON.stringify(spans)}`);
      const stubFields = noDeclaredKeyMatching(context.modelCase, /annualis|days|length|stub|months/i);
      check(stubFields.length === 0, `no annualisation, period-length or stub field exists to declare, found ${JSON.stringify(stubFields)}`);
      check(context.compiled.ok, "the case still compiles: the stub is carried into growth arithmetic as if it were a year");
    },
  },
  changed_fiscal_year_end: {
    new_anchor_flags_old_periods(context) {
      const errors = context.compiled.fiscalErrors;
      check(errors.length === 2, `exactly two typed period errors, got ${JSON.stringify(errors)}`);
      check(errors.every((error) => error.id === "periods.fiscal_year_end_mismatch"), "both must be the typed year-end mismatch");
      check(errors.map((error) => error.period_index).join(",") === "0,1", "the two pre-change periods must be the flagged ones");
    },
    no_single_anchor_describes_the_series(context) {
      const oldAnchor = clone(context.modelCase);
      oldAnchor.issuer.fiscal_year_end = "06-30";
      const oldErrors = validateFiscalPeriods(oldAnchor);
      check(oldErrors.length === 4, `the pre-change anchor flags the other four periods, got ${oldErrors.length}`);
      check(oldErrors.map((error) => error.period_index).join(",") === "2,3,4,5", "the mismatch must move to the post-change periods");
      const asWeeks = clone(context.modelCase);
      asWeeks.issuer.fiscal_calendar = "52_53_week";
      const weekErrors = validateFiscalPeriods(asWeeks);
      check(weekErrors.some((error) => error.id === "periods.52_53_week_span"),
        "declaring a week calendar fails the whole-week span test, so no declared calendar describes a changed year end");
    },
  },

  // ------------------------------------------------------------------- tax ---
  loss_making_no_nol_stock: {
    loss_year_tax_is_exactly_zero(context) {
      const rate = context.modelCase.forecast_assumptions.effective_tax_rate;
      check(rate.every((value) => value === 0.25), "the case must declare a 25% rate so the clamp is the only reason tax is zero");
      const periods = forecast(context);
      const lossYears = periods.filter((period) => period.pre_tax_income < 0);
      check(lossYears.length === 2, `two forecast loss years, got ${lossYears.length}`);
      for (const period of lossYears) {
        check(period.tax === 0, `${period.period}: tax must be exactly 0 on negative PBT, got ${period.tax}`);
        const naive = -period.pre_tax_income * 0.25;
        check(naive > 0, `${period.period}: the naive rate x PBT would fabricate a credit of ${naive.toFixed(3)}`);
      }
    },
    loss_year_net_income_equals_pbt(context) {
      for (const period of forecast(context).filter((item) => item.pre_tax_income < 0)) {
        check(near(period.net_income, period.pre_tax_income), `${period.period}: net income must equal pre-tax income on a loss`);
      }
    },
    recovery_year_carries_no_nol_shield(context) {
      const periods = forecast(context);
      const recovery = periods.filter((period) => period.pre_tax_income > 0);
      check(recovery.length === 1, `exactly one recovery year, got ${recovery.length}`);
      const year = recovery[0];
      check(near(year.tax, year.pre_tax_income * 0.25, 1e-9),
        `${year.period}: recovered profit is taxed at the full declared rate (${year.tax}) with no carryforward offset`);
      const priorLosses = periods
        .filter((period) => period.pre_tax_income < 0)
        .reduce((total, period) => total + period.pre_tax_income, 0);
      check(-priorLosses > year.pre_tax_income,
        `accumulated forecast losses (${(-priorLosses).toFixed(3)}) exceed the recovered profit (${year.pre_tax_income.toFixed(3)}) yet none shelters it`);
      const contractFields = [
        ...Object.keys(MODEL_CASE_SCHEMA.properties),
        ...Object.keys(MODEL_CASE_SCHEMA.$defs.metricSeries.properties),
      ].filter((name) => /nol|carryforward|tax_loss|loss_carry/i.test(name));
      check(contractFields.length === 0,
        `the model-case contract carries no NOL or tax-loss stock to declare, found ${JSON.stringify(contractFields)}`);
    },
  },
  all_loss_history_tax_policy: {
    loss_periods_excluded_from_rate_inference(context) {
      const ledger = taxLedger(context);
      check(ledger.periods.length === 3, "the ledger records every filed period");
      for (const period of ledger.periods) {
        check(["loss_with_tax_charge", "loss_tax_benefit"].includes(period.classification),
          `period ${period.period_index} must be classified a loss shape, got ${period.classification}`);
        check(/loss period/.test(String(period.exclusion_reason)), `period ${period.period_index} must record the loss-policy exclusion reason`);
        check(period.usable === false, `period ${period.period_index} must not be usable for rate inference`);
      }
      check(ledger.usable_rates.length === 0, "no usable rate may be inferred from an all-loss history");
    },
    loss_case_policy_is_declared_not_silent(context) {
      const candidate = taxCandidate(context);
      check(candidate !== null, "the loss-case policy must supply a candidate rather than nothing");
      check(candidate.method === "explicit_zero", `method must be explicit_zero, got ${candidate.method}`);
      check(candidate.formula_spec.operator === "tax_rate_policy_loss_case", `operator must be tax_rate_policy_loss_case, got ${candidate.formula_spec.operator}`);
      check(candidate.value === 0, "the declared policy value is zero");
      check(candidate.source_kind === "historical_inference", "the rung is a historical inference, not a user assumption");
      check(/loss rule/.test(candidate.note), "the candidate must state the loss rule rather than leaving a bare 0%");
    },
  },
  negative_effective_tax_rate: {
    credit_year_is_classified_and_excluded(context) {
      const ledger = taxLedger(context);
      const credit = ledger.periods[2];
      check(credit.classification === "tax_credit_on_profit", `the credit year must be classified tax_credit_on_profit, got ${credit.classification}`);
      check(credit.usable === false, "a credit against positive pre-tax income is not a usable rate");
      check(/not a recurring rate/.test(String(credit.exclusion_reason)), "the exclusion reason must be recorded");
      check(ledger.periods.slice(0, 2).every((period) => period.classification === "normal_rate" && period.usable),
        "the two ordinary years must be usable normal rates");
      check(ledger.filing_convention === "expense_negative", "the filing convention is inferred from profit periods");
    },
    selected_rate_is_positive_median(context) {
      const candidate = taxCandidate(context);
      const usable = taxLedger(context).usable_rates;
      check(candidate.method === "historical_average", `method must be historical_average, got ${candidate.method}`);
      check(candidate.formula_spec.operator === "tax_rate_policy_median", "operator must be tax_rate_policy_median");
      check(near(candidate.value, (usable[0] + usable[1]) / 2), `value must be the median of the usable rates, got ${candidate.value}`);
      check(candidate.value > 0, "no negative rate may reach the forecast");
      check(candidate.value > Math.min(...usable) - 1e-12 && candidate.value < Math.max(...usable) + 1e-12,
        "the selected rate sits between the two usable observations");
    },
  },
  tax_holiday_zero_rate: {
    no_rate_is_invented(context) {
      const candidate = taxCandidate(context);
      check(candidate === null, `the policy must decline to state a rate, got ${JSON.stringify(candidate && candidate.method)}`);
      const ledger = taxLedger(context);
      check(ledger.usable_rates.length === 0, "no usable rate exists");
      check(!ledger.periods.some((period) => ["loss_with_tax_charge", "loss_tax_benefit"].includes(period.classification)),
        "no loss shape exists either, so the loss rung cannot fire: the row escalates");
    },
    reported_zero_is_misclassified_as_a_credit(context) {
      const ledger = taxLedger(context);
      const rows = context.modelCase.statement_structure.income_statement;
      const filedTax = rows.find((row) => row.semantic_role === "tax_expense").values.slice(0, 3);
      const filedPbt = rows.find((row) => row.semantic_role === "pre_tax_income").values.slice(0, 3);
      check(filedTax.every((value) => value === 0), "the filed tax expense is a reported zero in every period");
      check(filedPbt.every((value) => value > 0), "every filed period is profitable");
      for (const period of ledger.periods) {
        check(period.classification === "tax_credit_on_profit",
          `DEFECT: a reported zero rate is classified ${period.classification} rather than a reported zero`);
        check(/tax credit/.test(String(period.exclusion_reason)),
          "the exclusion reason calls a nil charge a credit");
      }
      const vocabulary = MODEL_CASE_SCHEMA.$defs.statementRow.properties.historical_value_states.items.enum;
      check(vocabulary.includes("reported_zero"),
        "the row-level value-state vocabulary DOES carry reported_zero, so the tax ledger's collapse of zero into credit is a gap, not a missing concept");
    },
  },
  etr_above_usable_ceiling: {
    distorted_years_excluded_by_ceiling(context) {
      const ledger = taxLedger(context);
      const distorted = ledger.periods.slice(0, 2);
      for (const period of distorted) {
        check(period.classification === "distorted_rate", `period ${period.period_index} must be classified distorted_rate, got ${period.classification}`);
        check(/exceeds the usable ceiling 0.6/.test(String(period.exclusion_reason)), "the exclusion reason must name the ceiling");
        check(period.raw_rate > 0.6, `the observed rate ${period.raw_rate} must be above the ceiling`);
      }
      check(ledger.periods[2].classification === "normal_rate" && ledger.periods[2].usable, "only the ordinary year is usable");
    },
    single_observation_is_carried_forward(context) {
      const candidate = taxCandidate(context);
      const usable = taxLedger(context).usable_rates;
      check(usable.length === 1, `exactly one usable observation, got ${usable.length}`);
      check(candidate.method === "carry_forward", `method must be carry_forward, got ${candidate.method}`);
      check(candidate.formula_spec.operator === "tax_rate_policy_latest", "operator must be tax_rate_policy_latest");
      check(near(candidate.value, usable[0]), "the carried rate is the single usable observation");
      check(candidate.value < 0.6, "the carried rate is inside the usable ceiling");
    },
  },

  // -------------------------------------------------------- debt / schedule --
  pik_only_debt: {
    pik_accretes_the_principal(context) {
      const periods = forecast(context);
      let previousEnding = null;
      for (const period of periods) {
        const result = instrument(period, "pik_note");
        check(near(result.ending_native, result.opening_native + result.pik_interest_native),
          `${period.period}: ending balance must be opening plus PIK accretion`);
        if (previousEnding !== null) {
          check(near(result.opening_native, previousEnding), `${period.period}: opening balance must roll from the prior ending balance`);
        }
        previousEnding = result.ending_native;
      }
      const first = instrument(periods[0], "pik_note");
      check(near(first.pik_interest_native, (300 * 0.08) / (1 - 0.08 / 2), 1e-9),
        `first-year accretion must be the closed-form average-balance fixed point, got ${first.pik_interest_native}`);
    },
    pik_is_non_cash_interest(context) {
      for (const period of forecast(context)) {
        const result = instrument(period, "pik_note");
        check(result.cash_coupon_interest_reporting === 0, `${period.period}: no cash coupon may be paid`);
        check(result.cash_repayment_reporting === 0, `${period.period}: no cash repayment may occur`);
        check(near(period.non_cash_instrument_interest, result.pik_interest_native), `${period.period}: the charge must be reported as non-cash instrument interest`);
        check(near(period.gross_interest, result.pik_interest_native), `${period.period}: gross interest must carry the PIK charge`);
        check(near(period.cash_from_operations, period.net_income + period.depreciation_and_amortisation + period.non_cash_instrument_interest + period.change_in_working_capital),
          `${period.period}: operating cash flow must add the non-cash charge back`);
      }
    },
    roll_forward_invariant_accounts_for_pik(context) {
      const violations = context.compiled.solutionInvariants;
      const rollForward = violations.filter((item) => item.id === "debt.instrument_roll_forward");
      check(rollForward.length === 0,
        `the release invariant must agree with the solver's PIK roll-forward, got ${rollForward.length} violation(s)`);
      for (const period of forecast(context)) {
        const result = instrument(period, "pik_note");
        check(near(
          result.ending_native,
          result.opening_native
            + (result.issuance_native ?? 0)
            + (result.fair_value_movement_native ?? 0)
            + (result.other_non_cash_movement_native ?? 0)
            + (result.pik_interest_native ?? 0)
            - (result.amortisation_native ?? 0)
            - (result.maturity_repayment_native ?? 0),
        ), `${period.period}: the seven-term identity must reconcile the solver's ending balance`);
      }
      const source = fs.readFileSync(path.join(REPO, "scripts/lib/validation_invariants.mjs"), "utf8");
      const identity = source.slice(source.indexOf("const expectedEnding ="), source.indexOf("debt.instrument_roll_forward"));
      check(identity.includes("pik_interest_native"), "the invariant's expected-ending identity includes pik_interest_native");
      check(identity.includes("fair_value_movement_native"), "and includes fair_value_movement_native");
    },
  },
  zero_coupon_accreting_to_par: {
    maturity_repays_the_accreted_balance(context) {
      const periods = forecast(context);
      const maturityIndex = periods.findIndex((period) => instrument(period, "zero_note").maturity_repayment_native > 0);
      check(maturityIndex === 1, `the note must mature in forecast year two, got index ${maturityIndex}`);
      const maturing = instrument(periods[maturityIndex], "zero_note");
      check(near(maturing.maturity_repayment_native, maturing.opening_native + maturing.pik_interest_native),
        "the repayment must be the accreted balance, not the original face");
      check(maturing.maturity_repayment_native > 200 + 1e-6, `the accreted repayment (${maturing.maturity_repayment_native}) must exceed the 200 face`);
      check(near(maturing.ending_native, 0), "the ending balance must be exactly zero");
      const after = instrument(periods[2], "zero_note");
      check(near(after.pik_interest_native, 0) && near(after.interest_reporting, 0) && near(after.ending_native, 0),
        "no accretion, interest or balance may survive redemption");
    },
    accretion_roll_forward_invariant_accounts_for_pik(context) {
      const rollForward = context.compiled.solutionInvariants.filter((item) => item.id === "debt.instrument_roll_forward");
      check(rollForward.length === 0,
        `the invariant must agree through both accreting years, got ${rollForward.length} violation(s)`);
      const periods = forecast(context);
      const maturityIndex = periods.findIndex((period) => instrument(period, "zero_note").maturity_repayment_native > 0);
      const maturing = instrument(periods[maturityIndex], "zero_note");
      check(near(
        maturing.ending_native,
        maturing.opening_native + (maturing.pik_interest_native ?? 0) - (maturing.maturity_repayment_native ?? 0),
      ), "accretion and repayment of the accreted balance reconcile within the maturity period");
    },
  },
  revolver_fully_drawn_at_open: {
    no_draw_beyond_capacity(context) {
      const capacity = context.modelCase.rcf_policy.capacity;
      check(context.modelCase.rcf_policy.opening_draw === capacity, "the facility must open fully drawn");
      for (const period of forecast(context)) {
        check(near(period.undrawn_rcf, 0), `${period.period}: undrawn capacity must be zero`);
        check(near(period.rcf_draw, 0), `${period.period}: no draw may occur beyond capacity`);
        check(near(period.ending_rcf, capacity), `${period.period}: the balance stays at capacity`);
        check(period.liquidity_shortfall > 0, `${period.period}: the funding gap must be reported as a shortfall`);
      }
    },
    shortfall_identity_and_gates(context) {
      for (const period of forecast(context)) {
        check(near(period.liquidity_shortfall, Math.max(0, period.minimum_cash - period.ending_cash)),
          `${period.period}: shortfall must equal minimum cash less ending cash`);
        for (const gate of ["rcf_within_bounds", "minimum_cash_or_shortfall", "liquidity_shortfall_visible", "rcf_draw_repayment_mutually_exclusive", "shortfall_only_when_capacity_exhausted"]) {
          check(period.checks[gate] === true, `${period.period}: solved check ${gate} must hold`);
        }
      }
      check(context.compiled.solutionInvariants.length === 0,
        `solution invariants must be clean, got ${JSON.stringify(context.compiled.solutionInvariants)}`);
    },
    commitment_fee_on_zero_undrawn(context) {
      check(context.modelCase.rcf_policy.commitment_fee_convention === "bps_on_undrawn", "the case must declare a bps-on-undrawn fee");
      check(context.modelCase.rcf_policy.commitment_fee_value === 35, "the declared fee must be 35bp");
      for (const period of forecast(context)) {
        check(near(period.rcf_commitment_fee, 0), `${period.period}: the fee follows the undrawn balance, so it must be zero`);
      }
    },
  },
  revolver_undrawn_commitment_fee_only: {
    fee_is_bps_on_undrawn_only(context) {
      const capacity = context.modelCase.rcf_policy.capacity;
      const rate = context.modelCase.rcf_policy.commitment_fee_value / 10000;
      for (const period of forecast(context)) {
        check(near(period.undrawn_rcf, capacity), `${period.period}: the whole facility must be undrawn`);
        check(near(period.rcf_commitment_fee, capacity * rate), `${period.period}: the fee must be bps on undrawn (${capacity * rate})`);
        check(period.rcf_commitment_fee > 0, `${period.period}: an unused committed facility still costs money`);
        check(near(period.rcf_interest, 0), `${period.period}: no drawn interest may be charged`);
        check(near(period.gross_interest, period.rcf_commitment_fee), `${period.period}: gross interest is the fee alone`);
      }
    },
  },
  floating_benchmark_floor_binding: {
    floor_replaces_the_reference_leg(context) {
      const loan = context.modelCase.instruments.find((item) => item.instrument_id === "term_loan_b");
      const spread = loan.spread_bps / 10000;
      for (const [index, period] of forecast(context).entries()) {
        const floor = loan.benchmark_floor[index];
        const benchmark = loan.benchmark_rate[index];
        check(floor > benchmark, `${period.period}: the floor must bind`);
        const result = instrument(period, "term_loan_b");
        const implied = result.interest_reporting / result.opening_native;
        check(near(implied, floor + spread, 1e-9), `${period.period}: the all-in rate must be floor plus spread (${floor + spread}), got ${implied}`);
        check(!near(implied, benchmark + spread), `${period.period}: it must NOT be benchmark plus spread (${benchmark + spread})`);
        check(near(result.interest_reporting, result.opening_native * (floor + spread)), `${period.period}: interest must be the floored rate on the balance`);
      }
    },
  },
  multi_tranche_mixed_balance_basis: {
    only_native_principal_is_translated(context) {
      const rates = context.modelCase.fx.EUR.period_end_rates;
      for (const [index, period] of forecast(context).entries()) {
        const native = instrument(period, "eur_native_notes");
        const carrying = instrument(period, "eur_carrying_notes");
        check(near(native.ending_reporting, native.ending_native * rates[index + 3]),
          `${period.period}: the native-principal tranche must be translated at the period-end rate`);
        check(Math.abs(native.fx_non_cash_movement) > 1e-9, `${period.period}: the native tranche must carry an FX movement`);
        check(near(carrying.ending_reporting, carrying.ending_native), `${period.period}: the carrying-value tranche must not be translated`);
        check(near(carrying.fx_non_cash_movement, 0), `${period.period}: the carrying-value tranche's FX movement must be exactly zero`);
      }
      const carryingInstrument = context.modelCase.instruments.find((item) => item.instrument_id === "eur_carrying_notes");
      check(carryingInstrument.currency === "EUR" && carryingInstrument.balance_basis === "reporting_currency_carrying_value",
        "the untranslated tranche is still denominated in EUR: denomination never implies basis");
    },
  },
  fx_debt_translation_non_cash: {
    translation_never_enters_financing_cash(context) {
      const rates = context.modelCase.fx.EUR.period_end_rates;
      let moved = 0;
      for (const [index, period] of forecast(context).entries()) {
        const result = instrument(period, "eur_notes");
        const priorRate = rates[index + 2];
        const rate = rates[index + 3];
        if (Math.abs(rate - priorRate) > 1e-12) {
          check(Math.abs(result.fx_non_cash_movement) > 1e-9, `${period.period}: a moving curve must produce an FX movement`);
          moved += 1;
        } else {
          check(near(result.fx_non_cash_movement, 0), `${period.period}: a static curve must produce no FX movement`);
        }
        check(near(result.cash_repayment_reporting, 0), `${period.period}: translation must not create a cash repayment`);
        check(near(period.non_rcf_debt_repayment, 0), `${period.period}: financing cash flow must be untouched`);
      }
      check(moved === 2, `the curve must move in exactly two of the three years, got ${moved}`);
    },
    native_principal_is_unchanged(context) {
      const opening = context.modelCase.instruments.find((item) => item.instrument_id === "eur_notes").opening_balance;
      const reporting = new Set();
      for (const period of forecast(context)) {
        const result = instrument(period, "eur_notes");
        check(near(result.ending_native, opening), `${period.period}: native principal must be unchanged at ${opening}`);
        reporting.add(Number(result.ending_reporting.toFixed(6)));
      }
      check(reporting.size > 1, "the reporting-currency balance must move even though native principal does not");
    },
  },
  debt_maturing_mid_forecast: {
    interest_is_day_weighted_then_ceases(context) {
      const periods = forecast(context);
      const note = context.modelCase.instruments.find((item) => item.instrument_id === "senior_notes");
      const rate = note.coupon_or_all_in_rate[0];
      const full = instrument(periods[0], "senior_notes");
      check(near(full.interest_reporting, note.opening_balance * rate), `year one must carry a full year of interest, got ${full.interest_reporting}`);
      const maturing = instrument(periods[1], "senior_notes");
      const days = spanDays("2027-01-01", note.maturity_date) + 1;
      check(maturing.interest_reporting < full.interest_reporting, "the maturity year must carry less than a full year of interest");
      check(near(maturing.interest_reporting, note.opening_balance * rate * (days / 365), 1e-6),
        `the maturity year must be day-weighted to ${note.maturity_date}, got ${maturing.interest_reporting}`);
      const after = instrument(periods[2], "senior_notes");
      check(near(after.interest_reporting, 0), "no interest may be charged after redemption");
      check(near(after.ending_native, 0), "the balance must stay at zero");
    },
    repayment_appears_once_in_financing(context) {
      const periods = forecast(context);
      const repayments = periods.map((period) => instrument(period, "senior_notes").maturity_repayment_native);
      check(repayments.filter((value) => value > 0).length === 1, `the repayment must occur exactly once, got ${JSON.stringify(repayments)}`);
      check(near(repayments[1], 500), `the repayment must be the full 500 balance, got ${repayments[1]}`);
      check(near(periods[1].non_rcf_debt_repayment, 500), "financing cash flow must carry the repayment once");
      check(near(periods[0].non_rcf_debt_repayment, 0) && near(periods[2].non_rcf_debt_repayment, 0), "and in no other year");
      check(near(instrument(periods[1], "senior_notes").ending_native, 0), "the instrument ends at zero from the maturity year");
    },
  },
  minimum_cash_floor_binding: {
    floor_binds_only_when_cash_is_short(context) {
      const periods = forecast(context);
      const floor = context.modelCase.cash_policy.minimum_cash_override;
      check(floor === 150, "the case must declare a 150 minimum-cash floor");
      for (const period of periods) {
        const short = period.cash_after_mandatory_repayment < floor - 1e-9;
        if (short) {
          check(period.rcf_draw > 0, `${period.period}: a short year must draw`);
          check(near(period.ending_cash, floor), `${period.period}: ending cash must be pinned to the floor`);
          check(near(period.rcf_draw, floor - period.cash_after_mandatory_repayment, 1e-6),
            `${period.period}: the draw must be exactly the gap to the floor`);
        } else {
          check(near(period.rcf_draw, 0), `${period.period}: a year with enough cash must not draw`);
        }
      }
      const bound = periods.filter((period) => period.cash_after_mandatory_repayment < floor - 1e-9);
      const unbound = periods.filter((period) => period.cash_after_mandatory_repayment >= floor - 1e-9);
      check(bound.length >= 1 && unbound.length >= 1, "the case must exercise both a binding and a non-binding year");
      check(unbound.some((period) => period.ending_cash > floor + 1), "a non-binding year must be allowed to hold cash above the floor");
    },
    draw_and_repayment_never_coexist(context) {
      const periods = forecast(context);
      let previous = context.modelCase.rcf_policy.opening_draw;
      for (const period of periods) {
        check(!(period.rcf_draw > 1e-9 && period.rcf_repayment > 1e-9), `${period.period}: draw and repayment must not coexist`);
        check(near(period.ending_rcf, previous + period.rcf_draw - period.rcf_repayment, 1e-6),
          `${period.period}: the revolver must roll forward from the prior balance`);
        previous = period.ending_rcf;
      }
      check(context.compiled.solutionInvariants.length === 0, `solution invariants must be clean, got ${JSON.stringify(context.compiled.solutionInvariants)}`);
    },
  },

  // ---------------------------------------------------------------- leases ---
  finance_lease_in_debt_and_leverage: {
    lease_roll_forward_identity(context) {
      const policy = context.modelCase.lease_policy;
      let opening = policy.historical_liabilities[2];
      for (const [index, period] of forecast(context).entries()) {
        check(period.lease_interest > 0, `${period.period}: lease interest must accrete`);
        check(near(period.lease_additions, policy.additions[index]), `${period.period}: additions must be the declared series`);
        check(near(period.lease_principal, policy.principal_repayment[index]), `${period.period}: principal must be the declared series`);
        check(near(period.ending_lease, opening + period.lease_additions - period.lease_principal + period.lease_interest, 1e-9),
          `${period.period}: ending lease must be opening + additions - principal + interest`);
        opening = period.ending_lease;
      }
    },
    lease_basis_separation_in_definition_graph(context) {
      const funded = context.modelCase.instruments.reduce((total, item) => total + item.opening_balance, 0);
      for (const period of forecast(context)) {
        const basis = period.definition_basis.values;
        check(near(basis.model_gross_debt_including_leases - basis.model_gross_debt_excluding_leases, period.ending_lease),
          `${period.period}: the two bases must differ by exactly the lease liability`);
        check(near(basis.model_gross_debt_excluding_leases, funded), `${period.period}: the excluding basis must be the funded debt alone`);
        check(near(basis.leverage_debt, basis.model_gross_debt_including_leases),
          `${period.period}: the leverage denominator must use the including basis`);
        check(near(basis.lease_liabilities, period.ending_lease), `${period.period}: the graph must state the lease liability`);
      }
    },
  },
  sale_and_leaseback: {
    proceeds_land_in_investing(context) {
      const proceeds = context.modelCase.operating_metrics.other_investing.values.slice(3);
      const periods = forecast(context);
      check(proceeds[0] === 200 && proceeds[1] === 0 && proceeds[2] === 0, "the proceeds must arrive in the first forecast year only");
      for (const [index, period] of periods.entries()) {
        check(near(period.cash_from_investing, period.capex + proceeds[index]),
          `${period.period}: investing cash flow must be capex plus the disposal proceeds`);
      }
      check(periods[0].cash_from_investing > 0, "the leaseback year's investing line must be a net inflow");
    },
    liability_offsets_the_cash(context) {
      const policy = context.modelCase.lease_policy;
      const proceeds = context.modelCase.operating_metrics.other_investing.values[3];
      const first = forecast(context)[0];
      check(near(first.lease_additions, proceeds), `the lease addition (${first.lease_additions}) must equal the proceeds (${proceeds})`);
      const opening = policy.historical_liabilities[2];
      check(near(first.ending_lease, opening + first.lease_additions - first.lease_principal + first.lease_interest, 1e-9),
        "the liability roll-forward must hold in the leaseback year");
      check(first.ending_lease - opening > 0.9 * proceeds,
        `the liability rises by ${(first.ending_lease - opening).toFixed(3)} against a ${proceeds} inflow: the cash is not free`);
      check(near(first.definition_basis.values.model_gross_debt_including_leases - first.definition_basis.values.model_gross_debt_excluding_leases, first.ending_lease),
        "and the new liability sits inside gross debt");
    },
  },
  lease_only_no_funded_debt: {
    no_funded_debt_is_a_declared_degradation() {
      const verdict = classifySupport(ENVELOPE.contract, descriptor({ debt_instruments: "none_disclosed" }));
      check(verdict.support_class === "SUPPORTED_DEGRADED", `class must be SUPPORTED_DEGRADED, got ${verdict.support_class}`);
      check(verdict.dimension_verdicts.debt_instruments.class === "SUPPORTED_DEGRADED", "the debt_instruments dimension carries the degradation");
      check(verdict.dimension_verdicts.debt_instruments.value === "none_disclosed", "the declared value must be none_disclosed");
      check(verdict.degraded_dimensions.includes("debt_instruments"), "the degraded dimension must be named");
      check(verdict.early_stop.stopped === false, "a degraded dimension must not stop the run");
      check(/quality disclosure/.test(ENVELOPE.contract.terminal_state_mapping.SUPPORTED_DEGRADED.disclosure),
        "the envelope requires the degradation to be disclosed in the workbook");
    },
    ex_lease_net_cash_versus_lease_leverage(context) {
      for (const period of forecast(context)) {
        const basis = period.definition_basis.values;
        check(near(basis.model_gross_debt_excluding_leases, 0), `${period.period}: there is no funded debt`);
        check(basis.model_gross_debt_including_leases > 1000, `${period.period}: the lease portfolio exceeds 1000`);
        check(basis.model_net_debt_excluding_leases < 0, `${period.period}: ex-leases the issuer is net cash (${basis.model_net_debt_excluding_leases})`);
        check(basis.model_net_debt_including_leases > 0, `${period.period}: including leases the issuer is strongly net debt`);
        check(period.net_leverage > 4, `${period.period}: declared-basis leverage must exceed 4x, got ${period.net_leverage}`);
      }
    },
  },
  lease_liability_instrument_class_refused: {
    lane_disagreement_refused_source_owned(context) {
      const { modelCase, compiled } = context;
      check(compiled.shapeErrors.length === 0, `validateCaseShape accepts the case, got ${JSON.stringify(compiled.shapeErrors)}`);
      check(compiled.ok === false, "yet the case cannot be compiled on the debt register lane");
      check(compiled.error instanceof Error, "compilation fails with an Error");
      check(/Unsupported debt class lease_liability/.test(compiled.error.message), `the message names the refused class, got ${compiled.error.message}`);
      check(compiled.error.code === "UNSUPPORTED_INSTRUMENT_CLASS",
        `the refusal is typed (P4.1a, defect D12), got ${JSON.stringify(compiled.error.code)}`);
      const outcome = compiled.error.typed_internal_outcome;
      check(outcome !== undefined && outcome.reason_code === "SOURCE.lease_declared_on_debt_register",
        `the refusal names its registered reason, got ${JSON.stringify(outcome?.reason_code)}`);
      // P7.11: WHOSE fault. A lease in the borrowings table is a fact in the
      // user's own debt export, resolvable by the lease disclosure — never an
      // internal defect, and never a material economic choice.
      const registered = REGISTRY.reason_codes[outcome.reason_code];
      check(registered !== undefined, "the reason code is registered");
      check(registered.category === "source", `the refusal is source-owned, got ${registered.category}`);
      check(JSON.stringify(registered.allowed_terminal_states) === JSON.stringify(["SOURCE_REQUIRED"]),
        `the registry allows exactly SOURCE_REQUIRED, got ${JSON.stringify(registered.allowed_terminal_states)}`);
      check(outcome.earliest_responsible_layer === "debt_reconciliation",
        `the earliest responsible layer is debt_reconciliation, got ${outcome.earliest_responsible_layer}`);
      // The class stays DECLARED, because a real debt note produces it. What
      // the contract now adds is the LANE that keeps the promise.
      const declaredClass = modelCase.instruments[0].class;
      const matrix = ENVELOPE.contract.dimensions.debt_instruments;
      check(MODEL_CASE_SCHEMA.$defs.instrument.properties.class.enum.includes(declaredClass),
        "the refused class is still admitted by the model-case schema enum");
      check(matrix.declared_matrix.includes(declaredClass),
        "and still promised by the support envelope's declared debt matrix");
      check(matrix.declared_matrix_lanes?.[declaredClass] === "lease_policy",
        `the envelope declares the lane that delivers it, got ${JSON.stringify(matrix.declared_matrix_lanes?.[declaredClass])}`);
      check(matrix.declared_matrix.every((item) => matrix.declared_lanes?.[matrix.declared_matrix_lanes?.[item]] !== undefined),
        "every promised class names a declared lane");
    },
  },
  opening_debt_unreconciled_refusal: {
    typed_source_refusal(context) {
      const { compiled } = context;
      check(compiled.shapeErrors.length === 0, "the case is schema-valid");
      check(compiled.ok === false, "the compile must refuse");
      check(compiled.error.code === "OPENING_DEBT_UNRESOLVED", `the error must carry the typed code, got ${compiled.error.code}`);
      const outcome = compiled.error.typed_internal_outcome;
      check(outcome !== undefined, "the refusal must carry a typed outcome payload");
      check(outcome.reason_code === "SOURCE.opening_debt_unresolved", `the reason code must be the registered SOURCE code, got ${outcome.reason_code}`);
      check(outcome.earliest_responsible_layer === "debt_reconciliation", "the payload must name the responsible layer");
      const registered = REGISTRY.reason_codes[outcome.reason_code];
      check(registered !== undefined, "the reason code must be registered");
      check(registered.allowed_terminal_states.join(",") === "SOURCE_REQUIRED", "the registry allows exactly SOURCE_REQUIRED for it");
      check(registered.category === "source", "and classifies it as source-owned, never internal");
    },
    residual_is_stated_not_absorbed(context) {
      const bridge = compileOpeningDebtBridge(context.modelCase);
      check(bridge.verdict === "REFUSE_UNEXPLAINED_RESIDUAL", `verdict must refuse, got ${bridge.verdict}`);
      const reported = context.modelCase.debt_reconciliation.reported_opening_gross_debt;
      const register = context.modelCase.instruments.reduce((total, item) => total + item.opening_balance, 0);
      check(near(bridge.totals.unexplained_residual, reported - register), `the residual must be the whole gap (${reported - register})`);
      const stated = bridge.lines.filter((line) => line.line_kind === "unexplained_residual");
      check(stated.length === 1, "the residual must be a stated line");
      check(near(stated[0].amount, reported - register), "the stated line must carry the residual amount, never absorbed into a pool row");
      check(bridge.refusal.reason_code === "SOURCE.opening_debt_unresolved", "and the artifact carries the registered code");
    },
  },

  // ------------------------------------------------------------- perimeter ---
  impairment_excluded_from_ebitda: {
    ebitda_excludes_ebit_includes(context) {
      for (const period of forecast(context)) {
        const impairment = period.statement_values.impairment;
        const ebitda = period.statement_values.adjusted_ebitda;
        check(near(ebitda, period.adjusted_ebitda), `${period.period}: the declared EBITDA row is the solved credit denominator`);
        check(near(period.ebit, ebitda - period.depreciation_and_amortisation + impairment),
          `${period.period}: operating profit must equal EBITDA less depreciation plus the (negative) impairment`);
        if (impairment < 0) {
          check(period.ebit < ebitda - period.depreciation_and_amortisation, `${period.period}: the impairment must reduce operating profit`);
          check(near(ebitda, 230), `${period.period}: and must leave adjusted EBITDA untouched at 230`);
        }
      }
    },
    impairment_is_reversed_in_cash_flow(context) {
      const addBack = context.modelCase.operating_metrics.other_non_cash.values.slice(3);
      for (const [index, period] of forecast(context).entries()) {
        const impairment = period.statement_values.impairment;
        check(near(addBack[index], -impairment), `${period.period}: the non-cash add-back must equal the impairment`);
        check(near(period.cash_from_operations, period.net_income + period.depreciation_and_amortisation + addBack[index] + period.change_in_working_capital),
          `${period.period}: operating cash flow must reverse the charge exactly once`);
      }
      const impaired = forecast(context)[0];
      check(impaired.statement_values.impairment < 0, "the first forecast year carries the impairment");
      check(impaired.cash_from_operations > impaired.net_income, "and cash from operations exceeds profit because the charge moved no cash");
    },
  },
  discontinued_operations_disclosed: {
    perimeter_change_is_a_declared_degradation() {
      const verdict = classifySupport(ENVELOPE.contract, descriptor({ restructuring_complexity: "discontinued_operations_disclosed" }));
      check(verdict.support_class === "SUPPORTED_DEGRADED", `class must be SUPPORTED_DEGRADED, got ${verdict.support_class}`);
      check(verdict.dimension_verdicts.restructuring_complexity.class === "SUPPORTED_DEGRADED", "the restructuring dimension carries the degradation");
      check(verdict.degraded_dimensions.includes("restructuring_complexity"), "the degraded dimension must be named");
      check(verdict.legal_terminals.includes("DELIVERED_DEGRADED"), "degraded delivery is lawful");
      check(!verdict.legal_terminals.includes("DELIVERED_VERIFIED"), "but unqualified verified delivery is not");
    },
    continuing_metrics_exclude_the_disposal_group(context) {
      const rows = context.modelCase.statement_structure.income_statement;
      const discontinued = rows.find((row) => row.semantic_role === "discontinued_operation");
      check(discontinued.operation_scope === "discontinued", "the disposal group must be scoped discontinued");
      check(rows.filter((row) => row.operation_scope === "continuing").length >= 3, "the continuing rows must be scoped continuing");
      const first = forecast(context)[0];
      check(first.statement_values.discontinued_result < 0, "the first forecast year still carries the disposal group");
      check(near(first.adjusted_ebitda, first.statement_values.adjusted_ebitda), "the credit denominator is the continuing EBITDA row");
      check(near(first.ebit, first.adjusted_ebitda - first.depreciation_and_amortisation),
        "operating profit excludes the discontinued result entirely");
      check(near(first.other_non_operating, first.statement_values.discontinued_result),
        "the discontinued result enters only below the operating line");
      check(near(first.pre_tax_income, first.ebit + first.interest_income - first.gross_interest + first.other_non_operating, 1e-6),
        "and reaches pre-tax income exactly once");
    },
  },
  non_controlling_interests: {
    parent_plus_nci_equals_group_profit(context) {
      const rows = context.modelCase.statement_structure.income_statement;
      const netIncomeIndex = rows.findIndex((row) => row.semantic_role === "net_income");
      const nciIndex = rows.findIndex((row) => row.semantic_role === "non_controlling_interests");
      check(nciIndex > netIncomeIndex, "the NCI attribution must sit below group profit, not inside it");
      for (const period of forecast(context)) {
        const values = period.statement_values;
        check(near(values.owners_of_parent, values.net_income + values.non_controlling_interests),
          `${period.period}: owners of the parent plus NCI must equal group profit`);
        check(values.non_controlling_interests < 0, `${period.period}: the NCI share must be an attribution out of group profit`);
      }
    },
    cash_flow_starts_from_group_profit(context) {
      for (const period of forecast(context)) {
        const values = period.statement_values;
        check(near(period.net_income, values.net_income), `${period.period}: the solved profit is the GROUP figure`);
        check(near(period.cash_from_operations, values.net_income + period.depreciation_and_amortisation + period.change_in_working_capital),
          `${period.period}: operating cash flow must start from group profit`);
        const parentOnly = values.owners_of_parent + period.depreciation_and_amortisation + period.change_in_working_capital;
        check(near(period.cash_from_operations - parentOnly, -values.non_controlling_interests),
          `${period.period}: a parent-only start would understate cash by the NCI share (${-values.non_controlling_interests})`);
      }
    },
  },
  equity_method_associates: {
    associate_income_is_below_ebitda(context) {
      const share = context.modelCase.statement_structure.income_statement
        .find((row) => row.row_id === "share_of_associates").values.slice(3);
      for (const [index, period] of forecast(context).entries()) {
        check(share[index] > 0, `${period.period}: the associate share must be profit`);
        check(near(period.adjusted_ebitda, period.statement_values.adjusted_ebitda), `${period.period}: EBITDA is the declared operating row`);
        check(near(period.other_non_operating, share[index]), `${period.period}: the share must arrive through the below-the-line channel`);
        check(near(period.pre_tax_income, period.ebit + period.interest_income - period.gross_interest + share[index], 1e-6),
          `${period.period}: pre-tax income must carry the share exactly once`);
        check(!near(period.adjusted_ebitda, period.statement_values.adjusted_ebitda + share[index]),
          `${period.period}: and EBITDA must not include it`);
      }
    },
    associate_income_is_reversed_in_cash_flow(context) {
      const reversal = context.modelCase.operating_metrics.other_non_cash.values.slice(3);
      const share = context.modelCase.statement_structure.income_statement
        .find((row) => row.row_id === "share_of_associates").values.slice(3);
      for (const [index, period] of forecast(context).entries()) {
        check(near(reversal[index], -share[index]), `${period.period}: the non-cash reversal must equal the associate share`);
        check(near(period.cash_from_operations, period.net_income + period.depreciation_and_amortisation + reversal[index] + period.change_in_working_capital),
          `${period.period}: operating cash flow must exclude the non-cash profit share`);
      }
    },
  },

  // ----------------------------------------------------------------- other ---
  deferred_revenue_ratable: {
    working_capital_is_a_positive_inflow(context) {
      const movements = forecast(context).map((period) => period.change_in_working_capital);
      check(movements.every((value) => value > 0), `every forecast working-capital movement must be an inflow, got ${JSON.stringify(movements)}`);
      check(movements[1] > movements[0] && movements[2] > movements[1], "the deferred-revenue balance must keep growing");
      for (const period of forecast(context)) {
        check(period.cash_from_operations > period.adjusted_ebitda,
          `${period.period}: operating cash flow (${period.cash_from_operations.toFixed(2)}) must exceed accrual EBITDA (${period.adjusted_ebitda})`);
      }
    },
    deferred_inflow_counted_once(context) {
      for (const period of forecast(context)) {
        check(near(period.cash_from_operations, period.net_income + period.depreciation_and_amortisation + period.change_in_working_capital),
          `${period.period}: the cash-flow identity must hold exactly, so the inflow is counted once`);
        check(near(period.revenue, period.statement_values.revenue), `${period.period}: recognised revenue is the declared ratable series, not billings`);
      }
    },
  },
  capitalised_interest_into_asset: {
    whole_coupon_hits_finance_costs(context) {
      const note = context.modelCase.instruments[0];
      const capex = context.modelCase.operating_metrics.capex.values.slice(3);
      for (const [index, period] of forecast(context).entries()) {
        check(near(period.gross_interest, note.opening_balance * note.coupon_or_all_in_rate[index]),
          `${period.period}: the whole coupon must be charged as finance cost (${note.opening_balance * note.coupon_or_all_in_rate[index]})`);
        check(near(period.capex, -capex[index]), `${period.period}: capex must be exactly the declared series with no interest added`);
      }
    },
    no_declarable_capitalisation_state(context) {
      const instrumentProperties = Object.keys(MODEL_CASE_SCHEMA.$defs.instrument.properties);
      const capitalisation = instrumentProperties.filter((name) => /capitalis|capitaliz/.test(name));
      check(capitalisation.length === 0, `no instrument field names borrowing-cost capitalisation, got ${JSON.stringify(capitalisation)}`);
      const pik = MODEL_CASE_SCHEMA.$defs.instrument.properties.pik_rate;
      check(/capitalised-interest/.test(pik.description), "the only capitalisation vocabulary is pik_rate");
      check(/accrues into principal/i.test(pik.description), "which capitalises into PRINCIPAL, not into an asset");
      check(/included in interest expense/i.test(pik.description), "and stays inside interest expense, so it cannot express IAS 23");
      const metrics = Object.keys(context.modelCase.operating_metrics);
      check(!metrics.some((name) => /capitalis|capitaliz/.test(name)), "and no operating metric can carry it either");
    },
  },
  net_cash_interest_income_dominant: {
    net_finance_result_is_income(context) {
      for (const period of forecast(context)) {
        check(period.interest_income > period.gross_interest, `${period.period}: interest income must exceed interest expense`);
        check(period.net_interest < 0, `${period.period}: the net finance result must be income, got ${period.net_interest}`);
        check(period.net_debt < 0, `${period.period}: net debt must be negative, got ${period.net_debt}`);
        check(near(period.net_debt, period.gross_debt - period.eligible_cash), `${period.period}: net debt must be gross debt less eligible cash`);
      }
    },
    negative_leverage_is_stated_not_clamped(context) {
      for (const period of forecast(context)) {
        check(period.adjusted_ebitda > 0, `${period.period}: EBITDA must be positive so the sign comes from net debt alone`);
        check(period.net_leverage < 0, `${period.period}: leverage must be stated negative, not clamped, got ${period.net_leverage}`);
        check(near(period.net_leverage, period.net_debt / period.adjusted_ebitda, 1e-9),
          `${period.period}: the quotient identity must hold`);
      }
    },
  },
  negative_ebitda_leverage_not_meaningful: {
    negative_denominator_produces_negative_multiple(context) {
      for (const period of forecast(context)) {
        check(period.adjusted_ebitda < 0, `${period.period}: EBITDA must be negative`);
        check(period.net_debt > 0, `${period.period}: net debt must be positive`);
        check(period.net_leverage < 0, `${period.period}: the multiple must come out negative, got ${period.net_leverage}`);
        check(near(period.net_leverage, period.net_debt / period.adjusted_ebitda, 1e-9), `${period.period}: the quotient identity must hold`);
      }
      const cash = forecast(context)[0];
      check(cash.net_leverage < 0 && cash.net_debt > 0,
        "a negative multiple on positive net debt is indistinguishable from a net-cash multiple: the sign carries no information");
    },
    shortfall_rather_than_an_invented_facility(context) {
      check(!context.modelCase.instruments.some((item) => item.class === "rcf"), "no revolver may be declared");
      check(context.modelCase.rcf_policy.mode === "none", "and the policy must state no balancing facility");
      for (const period of forecast(context)) {
        check(near(period.rcf_draw, 0), `${period.period}: no draw may be manufactured`);
        check(period.liquidity_shortfall > 0, `${period.period}: the funding gap must be stated as a shortfall`);
        check(near(period.liquidity_shortfall, Math.max(0, period.minimum_cash - period.ending_cash)),
          `${period.period}: the shortfall identity must hold`);
        check(period.minimum_cash > 0, `${period.period}: the minimum cash is derived from the filed history, not zero`);
        check(period.ending_cash < 0, `${period.period}: cash is allowed to go negative rather than being plugged`);
      }
    },
  },
  hyperinflationary_reporting: {
    unsupported_class_without_an_early_stop() {
      const verdict = classifySupport(ENVELOPE.contract, descriptor({ accounting_framework: "other_or_unknown" }));
      check(verdict.support_class === "UNSUPPORTED", `class must be UNSUPPORTED, got ${verdict.support_class}`);
      check(verdict.dimension_verdicts.accounting_framework.class === "UNSUPPORTED", "the framework dimension carries the UNSUPPORTED verdict");
      check(verdict.legal_terminals.join(",") === "UNSUPPORTED_PROFILE", "its only legal terminal is UNSUPPORTED_PROFILE");
      check(verdict.early_stop.stopped === true,
        "the run STOPS, so the class's only legal terminal is reachable (P2.11, defect D13)");
      check(verdict.early_stop.reason_code === "UNSUPPORTED_PROFILE.unsupported_accounting_framework",
        `the stop names its registered reason code, got ${JSON.stringify(verdict.early_stop.reason_code)}`);
      const predicates = ENVELOPE.contract.early_stop_predicates.map((item) => item.id);
      check(predicates.includes("unsupported_accounting_framework_stop"),
        `a named early-stop predicate covers an UNSUPPORTED accounting framework, got ${JSON.stringify(predicates)}`);
      check(!Object.keys(ENVELOPE.contract.dimensions).some((name) => /inflation|price_index|restat/.test(name)),
        "and the envelope declares no hyperinflation dimension at all");
    },
    no_restatement_plane_in_the_economics(context) {
      const periods = forecast(context);
      check(context.compiled.ok, "the case compiles: nothing refuses a hyperinflationary series");
      const ratios = periods.map((period) => period.depreciation_and_amortisation / period.revenue);
      check(ratios[0] > ratios[1] && ratios[1] > ratios[2], `depreciation as a share of revenue must collapse, got ${JSON.stringify(ratios)}`);
      check(ratios[0] / ratios[2] > 4, `the collapse must be material (${(ratios[0] / ratios[2]).toFixed(1)}x): historical-cost depreciation is never restated`);
      const ebitMargin = periods.map((period) => period.ebit / period.revenue);
      const ebitdaMargin = periods.map((period) => period.adjusted_ebitda / period.revenue);
      check(ebitMargin[2] > ebitMargin[0], "so the operating margin rises with inflation alone");
      check(ebitdaMargin.every((value, index) => value > ebitMargin[index]), "converging on the EBITDA margin");
      const restatementFields = noDeclaredKeyMatching(context.modelCase, /price_index|restat|purchasing|inflation|index/i);
      check(restatementFields.length === 0,
        `and no price-index, restatement or purchasing-power field exists to declare it, found ${JSON.stringify(restatementFields)}`);
    },
  },
  depletion_unit_of_production: {
    company_assumption_authority_is_honoured(context) {
      const declared = context.modelCase.operating_metrics.depreciation_and_amortisation;
      check(declared.forecast_method === "company_assumption", "the depletion series must be a company assumption");
      check(declared.source_kind === "company_reported", "sourced from the company, not inferred");
      const ratios = [];
      for (const [index, period] of forecast(context).entries()) {
        check(near(period.depreciation_and_amortisation, declared.values[index + 3]),
          `${period.period}: the declared depletion charge must be carried exactly (${declared.values[index + 3]})`);
        ratios.push(period.depreciation_and_amortisation / period.revenue);
      }
      check(Math.max(...ratios) - Math.min(...ratios) > 0.05,
        `the depreciation-to-revenue ratio must vary materially, got ${JSON.stringify(ratios.map((value) => Number(value.toFixed(4))))}`);
      check(!(ratios[1] > ratios[0] && ratios[2] > ratios[1]) && !(ratios[1] < ratios[0] && ratios[2] < ratios[1]),
        "and must be non-monotonic, as unit-of-production depletion is: no revenue-ratio default overwrote it");
    },
  },
  regulated_asset_base_depreciation: {
    utility_entity_type_is_certified() {
      const verdict = classifySupport(ENVELOPE.contract, descriptor({ entity_type: "utility" }));
      check(verdict.dimension_verdicts.entity_type.class === "CERTIFIED", `a utility must be CERTIFIED, got ${verdict.dimension_verdicts.entity_type.class}`);
      check(verdict.dimension_verdicts.entity_type.declared === true, "the value must be declared, not an unknown fallback");
      check(!verdict.degraded_dimensions.includes("entity_type"), "and must not be named as a degraded dimension");
      check(verdict.early_stop.stopped === false, "a utility must never hit the financial-institution stop");
    },
    capex_exceeds_depreciation_and_fcf_is_negative(context) {
      for (const period of forecast(context)) {
        const capex = Math.abs(period.capex);
        check(capex > 2.5 * period.depreciation_and_amortisation,
          `${period.period}: capex (${capex}) must exceed 2.5x depreciation (${period.depreciation_and_amortisation})`);
        const freeCashFlow = period.cash_from_operations + period.capex;
        check(freeCashFlow < 0, `${period.period}: free cash flow must be negative, got ${freeCashFlow.toFixed(3)}`);
      }
      const periods = forecast(context);
      check(periods[2].adjusted_ebitda > periods[0].adjusted_ebitda, "while EBITDA grows across the forecast");
      check(periods[2].cash_from_operations + periods[2].capex < periods[0].cash_from_operations + periods[0].capex,
        "and the cash absorption deepens: steady-state capex-equals-depreciation is wrong here");
    },
  },
};

// ---------------------------------------------------------------------------
// Binding and running one expectation. These two functions carry the runner's
// own guarantees and are mutation-proved at the bottom of the file.
function bindCheck(entry, expectation) {
  const group = CHECKS[entry.archetype_id];
  if (!group) {
    throw new Error(
      `archetype ${entry.archetype_id} declares expectations but has no implemented checks in run_archetype_economics_tests.mjs`,
    );
  }
  const implementation = group[expectation.expectation_id];
  if (typeof implementation !== "function") {
    throw new Error(
      `expectation ${entry.archetype_id}.${expectation.expectation_id} has no implemented check in run_archetype_economics_tests.mjs`,
    );
  }
  return implementation;
}

function runExpectation(entry, expectation, context) {
  const implementation = bindCheck(entry, expectation);
  const before = checks;
  implementation(context);
  if (checks === before) {
    throw new Error(
      `expectation ${entry.archetype_id}.${expectation.expectation_id} asserted nothing: a bound check must make at least one assertion`,
    );
  }
}

// ---------------------------------------------------------------------------
// Catalogue-level invariants.
function assertCatalogueInvariants(catalogue) {
  const schema = readJson(SCHEMA_PATH);
  const schemaErrors = validateJsonSchema(catalogue, schema);
  if (schemaErrors.length > 0) {
    throw new Error(`catalogue fails the shared schema: ${JSON.stringify(schemaErrors)}`);
  }
  if (catalogue.catalogue_group !== "economics") {
    throw new Error(`catalogue_group must be economics, got ${catalogue.catalogue_group}`);
  }
  const seen = new Set();
  for (const entry of catalogue.entries) {
    if (seen.has(entry.archetype_id)) throw new Error(`duplicate archetype_id ${entry.archetype_id}`);
    seen.add(entry.archetype_id);
    if (!entry.case_path.startsWith(CASE_DIRECTORY_PREFIX)) {
      throw new Error(`${entry.archetype_id}: case_path must live under ${CASE_DIRECTORY_PREFIX} (never test-fixtures/cases/)`);
    }
    if (!fs.existsSync(path.join(REPO, entry.case_path))) {
      throw new Error(`${entry.archetype_id}: case file ${entry.case_path} does not exist`);
    }
    if (!entry.shape_expectations.some((expectation) => expectation.kind !== "compiles_clean")) {
      throw new Error(`${entry.archetype_id}: a case that merely compiles proves nothing — declare an expectation beyond compiles_clean`);
    }
    const expectationIds = new Set();
    for (const expectation of entry.shape_expectations) {
      if (expectationIds.has(expectation.expectation_id)) {
        throw new Error(`${entry.archetype_id}: duplicate expectation_id ${expectation.expectation_id}`);
      }
      expectationIds.add(expectation.expectation_id);
      if (["typed_refusal", "unsupported_profile_early_stop"].includes(expectation.kind)) {
        const reason = expectation.expected_terminal_reason;
        if (!reason) {
          throw new Error(`${entry.archetype_id}.${expectation.expectation_id}: a ${expectation.kind} must name expected_terminal_reason`);
        }
        const normalised = reason.replace(/^UNSUPPORTED_PROFILE\./, "PROFILE.");
        if (!REGISTRY.reason_codes[normalised]) {
          throw new Error(`${entry.archetype_id}.${expectation.expectation_id}: reason code ${reason} is not registered`);
        }
      }
    }
    for (const pair of entry.proves_envelope_values ?? []) {
      const dimension = ENVELOPE.contract.dimensions[pair.dimension];
      if (!dimension) throw new Error(`${entry.archetype_id}: envelope has no dimension ${pair.dimension}`);
      if (!Object.hasOwn(dimension.values, pair.value)) {
        throw new Error(`${entry.archetype_id}: envelope dimension ${pair.dimension} has no value ${pair.value}`);
      }
    }
  }
  return catalogue;
}

// ---------------------------------------------------------------------------
const catalogue = assertCatalogueInvariants(readJson(CATALOGUE_PATH));
check(catalogue.entries.length >= 18, `the catalogue must go broad: ${catalogue.entries.length} archetypes`);
check(/at least one expectation that is not compiles_clean/.test(catalogue.invariant), "the catalogue must state its own invariant");

for (const entry of catalogue.entries) {
  const modelCase = readJson(path.join(REPO, entry.case_path));
  check(modelCase.contract_version === 2, `${entry.archetype_id}: the case must be a v2 model case`);
  check(modelCase.case_id === entry.archetype_id, `${entry.archetype_id}: case_id must match the archetype id, got ${modelCase.case_id}`);
  check(/NOT A REAL COMPANY/.test(modelCase.issuer.name), `${entry.archetype_id}: the synthetic issuer must be labelled`);
  const compiled = compileArchetype(modelCase);
  const context = { entry, modelCase, compiled };
  for (const expectation of entry.shape_expectations) {
    runExpectation(entry, expectation, context);
  }
}

// ---------------------------------------------------------------------------
// MUTATIONS. Each proves one of the runner's own guarantees, so a catalogue
// entry cannot be declared without being asserted.
const sampleEntry = catalogue.entries[0];

// (a) An expectation with no implemented check fails the run.
assert.throws(
  () => bindCheck(sampleEntry, { expectation_id: "not_implemented_anywhere", kind: "value_state", statement: "x" }),
  /has no implemented check/,
  "an unimplemented expectation must fail the run",
);
checks += 1;

// (b) An archetype with no check group at all fails the run.
assert.throws(
  () => bindCheck({ archetype_id: "archetype_that_does_not_exist" }, { expectation_id: "any", kind: "value_state", statement: "x" }),
  /has no implemented checks/,
  "an archetype with no bound checks must fail the run",
);
checks += 1;

// (c) A bound check that asserts nothing fails the run.
const vacuous = { archetype_id: "vacuous_probe" };
CHECKS.vacuous_probe = { asserts_nothing() {} };
assert.throws(
  () => runExpectation(vacuous, { expectation_id: "asserts_nothing", kind: "value_state", statement: "x" }, {}),
  /asserted nothing/,
  "a check that makes no assertion must fail the run",
);
delete CHECKS.vacuous_probe;
checks += 1;

// (d) An entry whose only expectation is compiles_clean is rejected.
const compileOnly = clone(catalogue);
compileOnly.entries[0].shape_expectations = [
  { expectation_id: "compiles", kind: "compiles_clean", statement: "it compiles" },
];
assert.throws(
  () => assertCatalogueInvariants(compileOnly),
  /proves nothing/,
  "a compiles-only entry must be rejected",
);
checks += 1;

// (e) A refusal without a registered reason code is rejected.
const badReason = clone(catalogue);
badReason.entries[0].shape_expectations = [
  { expectation_id: "refuses", kind: "typed_refusal", statement: "it refuses", expected_terminal_reason: "SOURCE.invented_code" },
];
assert.throws(() => assertCatalogueInvariants(badReason), /is not registered/, "an unregistered reason code must be rejected");
checks += 1;

// (f) A case path pointing at the hash-pinned donor directory is rejected
//     (the shared schema's own pattern bites first).
const donorPath = clone(catalogue);
donorPath.entries[0].case_path = "test-fixtures/cases/standard-maximal-v2.json";
assert.throws(
  () => assertCatalogueInvariants(donorPath),
  /does not match required pattern|never test-fixtures\/cases/,
  "the hash-pinned donor directory must be refused",
);
checks += 1;

// (g) A case path inside the PRESENTATION group's directory is rejected: the
//     two catalogue groups never share case files.
const foreignGroupPath = clone(catalogue);
foreignGroupPath.entries[0].case_path = "test-fixtures/archetypes/presentation/borrowed_case.json";
assert.throws(() => assertCatalogueInvariants(foreignGroupPath), /must live under/, "another group's case directory must be refused");
checks += 1;

// (h) An envelope claim naming a value the contract does not declare is rejected.
const badEnvelope = clone(catalogue);
badEnvelope.entries[0].proves_envelope_values = [{ dimension: "fiscal_calendar", value: "lunar" }];
assert.throws(() => assertCatalogueInvariants(badEnvelope), /has no value lunar/, "an undeclared envelope value must be rejected");
checks += 1;

console.log(JSON.stringify({ status: "PASS", checks, archetypes: catalogue.entries.length }));
