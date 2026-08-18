#!/usr/bin/env node
import assert from "node:assert/strict";

import { openingPosition } from "./lib/flow_read.mjs";

function modelCase(instrument) {
  return {
    issuer: { reporting_currency: "USD" },
    periods: [
      { date: "2023-12-31" },
      { date: "2024-12-31" },
      { date: "2025-12-31" },
    ],
    instruments: [{
      instrument_id: "note",
      class: "fixed_bond",
      include_in_gross_debt: true,
      include_in_net_debt: true,
      ...instrument,
    }],
    rcf_policy: { opening_draw: 0 },
    lease_policy: { mode: "exclude" },
    cash_policy: { opening_cash: 0, eligible_cash_percentage: 1 },
    operating_metrics: {
      adjusted_ebitda: { values: [20, 20, 20, null, null, null] },
    },
  };
}

let checks = 0;
const carrying = openingPosition(modelCase({
  currency: "EUR",
  opening_balance: 100,
  balance_basis: "reporting_currency_carrying_value",
}));
assert.equal(carrying.gross_debt, 100);
assert.equal(carrying.net_debt, 100);
checks += 2;

assert.throws(
  () => openingPosition(modelCase({
    currency: "EUR",
    opening_balance: 100,
    balance_basis: "native_principal",
  })),
  /Missing FX assumptions for EUR/,
);
checks += 1;

const native = modelCase({
  currency: "EUR",
  opening_balance: 100,
  balance_basis: "native_principal",
});
native.fx = {
  EUR: {
    quote: "reporting_per_native",
    period_end_rates: [1.1, 1.15, 1.2],
  },
};
assert.equal(openingPosition(native).gross_debt, 120);
checks += 1;

console.log(JSON.stringify({
  schema_version: "flow-read-balance-basis-test-report/1.0",
  status: "PASS",
  checks,
  carrying_value_not_double_translated: true,
  native_principal_requires_fx: true,
}, null, 2));
