#!/usr/bin/env node
import assert from "node:assert/strict";

import { projectDcsInstrument } from "./lib/attachment_ingress.mjs";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const projected = {
  instrument_id: "eur-note-2029",
  description: "EUR Notes 3.5% 2029",
  instrument_type: "fixed_bond",
  currency: "EUR",
  outstanding_amount: 825,
  balance_basis: "reporting_currency_carrying_value",
  maturity_date: "2029-06-30",
  maturity_precision: "month",
  maturity_source_value: "2029-06",
  maturity_timing_convention: "month_end",
  maturity_treatment: "contractual",
  rate_type: "fixed",
  coupon_rate: 0.035,
  pricing_treatment: "source_terms",
  source_row: "Debt!17",
};
const authorities = [
  {
    instrument_id: projected.instrument_id,
    model_field: "balance_basis",
    output_value: "reporting_currency_carrying_value",
  },
  {
    instrument_id: projected.instrument_id,
    model_field: "outstanding_amount",
    output_value: 825,
  },
];

const created = projectDcsInstrument({
  projected,
  termAuthorities: authorities,
  displayOrder: 1,
});
const merged = projectDcsInstrument({
  projected,
  existingInstrument: {
    instrument_id: projected.instrument_id,
    display_order: 1,
    name: "stale filing label",
    class: "other_debt",
    currency: "USD",
    opening_balance: 999,
    balance_basis: "native_principal",
    scheduled_amortisation: [0, 0, 0],
    new_issuance: [0, 0, 0],
    other_non_cash_movement: [0, 0, 0],
  },
  termAuthorities: authorities,
  displayOrder: 1,
});

assert.deepEqual(merged, created, "DCS creation and existing-instrument merge drifted");
checks += 1;
check(
  merged.balance_basis === "reporting_currency_carrying_value",
  "existing-instrument merge lost reporting-currency carrying-value basis",
);
check(merged.opening_balance === 825, "DCS opening amount did not own the merged instrument");
check(merged.currency === "EUR", "DCS legal denomination did not own the merged instrument");
check(merged.maturity_precision === "month", "DCS maturity precision was not projected");
check(merged.maturity_timing_convention === "month_end", "DCS timing convention was not projected");
check(merged.source_line_ids[0] === "Debt!17", "DCS source lineage was not projected");
check(merged.coupon_or_all_in_rate.every((value) => value === 0.035), "DCS fixed rate was not projected");

const floating = projectDcsInstrument({
  projected: {
    ...projected,
    instrument_id: "usd-rcf",
    description: "USD Revolving Credit Facility",
    instrument_type: "rcf",
    currency: "USD",
    outstanding_amount: 50,
    drawn_amount: 50,
    balance_basis: "native_principal",
    facility_limit: 1000,
    rate_type: "floating",
    reference_rate: "SOFR 3M",
    margin_bps: 125,
    benchmark_curve: { resolved: [0.03, 0.028, 0.027] },
  },
  termAuthorities: [{
    instrument_id: "usd-rcf",
    model_field: "balance_basis",
    output_value: "native_principal",
  }],
});
check(floating.class === "rcf" && floating.facility_capacity === 1000, "RCF terms were not projected");
check(floating.benchmark === "SOFR 3M" && floating.spread_bps === 125, "floating pricing was not projected");

const unpriced = projectDcsInstrument({
  projected: {
    ...projected,
    instrument_id: "unpriced-loan",
    rate_type: "unpriced",
    pricing_treatment: "residual_interest_plug",
    balance_basis: "native_principal",
  },
  existingInstrument: {
    instrument_id: "unpriced-loan",
    coupon_or_all_in_rate: [0.1, 0.1, 0.1],
    benchmark: "STALE",
    benchmark_rate: [0.1, 0.1, 0.1],
    spread_bps: 999,
  },
  termAuthorities: [{
    instrument_id: "unpriced-loan",
    model_field: "balance_basis",
    output_value: "native_principal",
  }],
});
check(unpriced.rate_type === "unpriced", "unpriced treatment was not retained");
check(
  !("coupon_or_all_in_rate" in unpriced) && !("benchmark" in unpriced),
  "stale pricing survived an unpriced DCS projection",
);

assert.throws(
  () => projectDcsInstrument({
    projected: { ...projected, balance_basis: undefined },
    termAuthorities: [],
  }),
  /balance_basis must be explicit/,
  "missing current DCS balance basis silently defaulted",
);
checks += 1;
assert.throws(
  () => projectDcsInstrument({
    projected,
    termAuthorities: [{
      instrument_id: projected.instrument_id,
      model_field: "balance_basis",
      output_value: "native_principal",
    }],
  }),
  /does not match its DCS term authority/,
  "basis mutation did not fail on model-authority mismatch",
);
checks += 1;

console.log(JSON.stringify({
  schema_version: "dcs-ingress-projection-test-report/1.0",
  status: "PASS",
  checks,
  creation_merge_equivalent: true,
  carrying_value_basis_preserved: true,
  killed_mutations: ["missing_balance_basis", "authority_basis_mismatch"],
}, null, 2));
