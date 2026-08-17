#!/usr/bin/env node

import assert from "node:assert/strict";

import { assessCoverage } from "./lib/coverage.mjs";
import { reconcileExport } from "./lib/flow_reconcile.mjs";
import { compileOpeningInstrumentState } from "./lib/instrument_period_state.mjs";
import { caseOnlyReconciliation } from "./lib/release_nodes.mjs";

const periods = [
  { date: "2023-12-31", status: "historical" },
  { date: "2024-12-31", status: "historical" },
  { date: "2025-12-31", status: "historical" },
  { date: "2026-12-31", status: "forecast" },
  { date: "2027-12-31", status: "forecast" },
  { date: "2028-12-31", status: "forecast" },
];

function instrument(instrumentId, overrides = {}) {
  return {
    instrument_id: instrumentId,
    name: instrumentId,
    class: "bond_fixed",
    currency: "GBP",
    balance_basis: "native_principal",
    opening_balance: 100,
    rate_type: "fixed",
    coupon_or_all_in_rate: [0.05, 0.05, 0.05],
    maturity_treatment: "non_maturing_within_forecast",
    assumption_note: "Test instrument remains outstanding.",
    include_in_gross_debt: true,
    include_in_net_debt: true,
    ...overrides,
  };
}

const modelCase = {
  case_id: "opening-debt-multi-currency",
  contract_version: 2,
  issuer: { reporting_currency: "GBP", units: "millions" },
  periods,
  statement_structure: { income_statement: [], cash_flow: [] },
  instruments: [
    instrument("gbp_native", { opening_balance: 100 }),
    instrument("eur_native", {
      currency: "EUR",
      opening_balance: 200,
    }),
    instrument("usd_legal_gbp_carrying", {
      currency: "USD",
      balance_basis: "reporting_currency_carrying_value",
      opening_balance: 50,
    }),
  ],
  fx: {
    EUR: {
      quote: "reporting_per_native",
      average_rates: [0.75, 0.78, 0.79, 0.81, 0.82, 0.83],
      period_end_rates: [0.76, 0.79, 0.8, 0.82, 0.83, 0.84],
    },
    // This deliberately extreme curve proves the carrying-value instrument
    // is not translated merely because its legal denomination is USD.
    USD: {
      quote: "reporting_per_native",
      average_rates: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
      period_end_rates: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
    },
  },
  debt_reconciliation: {
    reported_opening_gross_debt: [290, 300, 310],
    maximum_residual_percentage: 0.01,
  },
  historical_supplement: {
    prior_gross_debt_excluding_leases: [290, 300],
  },
  controls: { debt_maturities_roll: 1, circularity: 1 },
  cash_policy: { opening_cash: 0, minimum_cash: [0, 0, 0] },
  lease_policy: { mode: "exclude" },
  broker_pack: { metrics: {} },
  source_coverage: {},
};

const opening = compileOpeningInstrumentState(modelCase);
assert.equal(opening.status, "PASS");
assert.equal(opening.as_of, "2025-12-31");
assert.equal(opening.reporting_currency, "GBP");
assert.equal(opening.reporting_total, 310);
assert.notEqual(
  opening.reporting_total,
  modelCase.instruments.reduce(
    (total, row) => total + row.opening_balance,
    0,
  ),
  "The canonical total collapsed back to a mixed-currency native sum.",
);
assert.equal(
  opening.rows.find((row) => row.instrument_id === "eur_native").reporting_amount,
  160,
);
assert.equal(
  opening.rows.find((row) => row.instrument_id === "usd_legal_gbp_carrying").reporting_amount,
  50,
  "A reporting-currency carrying value was exposed to double FX.",
);

const releaseReconciliation = caseOnlyReconciliation(modelCase);
assert.equal(releaseReconciliation.stop, false);
assert.equal(releaseReconciliation.export_total, 310);
assert.equal(releaseReconciliation.residual, 0);

const coverage = assessCoverage(modelCase);
const coverageReconciliation = coverage.checks.find(
  (check) => check.id === "debt_reconciliation",
);
assert.equal(
  coverageReconciliation?.status,
  "PASS",
  "Coverage did not consume the canonical opening-instrument state.",
);
assert.equal(
  coverageReconciliation.detail.opening_instrument_state.reporting_total,
  310,
);

// A raw DCS adapter has already translated every amount column into reporting
// currency. Legal denomination must not trigger a second translation here.
const rawExportReconciliation = reconcileExport({
  export: {
    reporting_currency: "GBP",
    as_of: "2025-12-31",
    instruments: [
      { instrument_type: "bond_fixed", currency: "GBP", outstanding_amount: 100 },
      { instrument_type: "bond_fixed", currency: "EUR", outstanding_amount: 160 },
      { instrument_type: "bond_fixed", currency: "USD", outstanding_amount: 50 },
    ],
  },
  filings: {
    reported_gross_debt: 310,
    fiscal_year_end_date: "2025-12-31",
  },
});
assert.equal(rawExportReconciliation.export_total, 310);
assert.equal(rawExportReconciliation.amount_basis, "reporting_currency_carrying_value");

// Mutation: deleting the EUR pair must fail closed at the opening-state seam,
// and both release and coverage must name an untranslatable reconciliation.
const missingFx = structuredClone(modelCase);
delete missingFx.fx.EUR;
const missingFxState = compileOpeningInstrumentState(missingFx);
assert.equal(missingFxState.status, "BLOCKED");
assert.match(missingFxState.errors.join(" "), /Missing FX assumptions for EUR/);
assert.equal(caseOnlyReconciliation(missingFx).stop, true);
assert.equal(
  assessCoverage(missingFx).checks.find(
    (check) => check.id === "debt_reconciliation.untranslatable",
  )?.status,
  "BLOCK",
);

// Mutation: re-labelling an already translated carrying value as native must
// create a real mismatch rather than being rescued by tolerance or a residual.
const doubleFx = structuredClone(modelCase);
doubleFx.instruments.find(
  (row) => row.instrument_id === "usd_legal_gbp_carrying",
).balance_basis = "native_principal";
assert.equal(compileOpeningInstrumentState(doubleFx).reporting_total, 270);
const doubleFxRelease = caseOnlyReconciliation(doubleFx);
assert.equal(doubleFxRelease.stop, true);
assert.equal(doubleFxRelease.residual, 40);

console.log(JSON.stringify({
  status: "PASS",
  positive: [
    "native_principal_translated_at_last_historical_period_end",
    "reporting_currency_carrying_value_not_double_translated",
    "case_only_release_uses_canonical_opening_state",
    "coverage_uses_canonical_opening_state",
    "raw_dcs_reporting_currency_contract_preserved",
  ],
  mutations: [
    "missing_fx_blocks",
    "incorrect_native_basis_creates_reconciliation_failure",
  ],
}, null, 2));
