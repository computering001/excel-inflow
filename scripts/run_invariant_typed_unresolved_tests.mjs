#!/usr/bin/env node
/**
 * Invariant prover P3 — typed schedule states never smuggle silent zeros.
 *
 * An ABSENT solver input (undefined / null / NaN) must compile to the typed
 * `unresolved` state — which reads as null — and a DISABLED facility to
 * `not_applicable`; neither may surface as a fabricated zero. The validator
 * must also FLAG a typed zero standing where the numeric schedule field is
 * absent (the adversarial direction).
 *
 * Single-line JSON result: {"status":"PASS","checks":N}.
 */
import assert from "node:assert/strict";
import {
  compileScheduleTypedStates,
  validateScheduleTypedStates,
} from "./lib/schedule_typed_states.mjs";
import { numericValueOf, typedValue } from "./lib/typed_financial_value.mjs";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const PERIOD = { period_id: "2028", period_index: 1, period_count: 3 };

// GREEN — absent inputs compile to `unresolved`, reading as null, never 0.
const absent = compileScheduleTypedStates({
  ...PERIOD,
  rcf: { enabled: true, instrument_id: "rcf-1" },
});
for (const field of ["opening_balance", "draw", "repayment", "ending_balance"]) {
  check(absent.rcf[field].state === "unresolved", `absent rcf.${field} is unresolved`);
  check(numericValueOf(absent.rcf[field]) === null, `absent rcf.${field} reads as null`);
}
check(
  !Object.values(absent.rcf).some((v) => v === 0),
  "no bare zero is minted anywhere in the absent-input shadow",
);
check(numericValueOf(absent.cash.ending_cash) === null, "absent ending_cash reads as null");

// A disabled facility is not_applicable — still never a fabricated balance.
check(
  compileScheduleTypedStates({ ...PERIOD, rcf: { enabled: false } }).rcf.draw.state ===
    "not_applicable",
  "disabled facility is not_applicable",
);

// NaN input is as absent as a missing one.
check(
  compileScheduleTypedStates({ ...PERIOD, cash: { ending_cash: Number.NaN } }).cash.ending_cash
    .state === "unresolved",
  "NaN ending_cash is unresolved",
);

// RED — a fabricated typed zero where the numeric field is absent is flagged.
const adversarial = structuredClone(absent);
adversarial.rcf.draw = typedValue("derived_number", {
  value: 0,
  derivation: { operator: "smuggled_zero", refs: [] },
});
const errors = validateScheduleTypedStates(adversarial, { "rcf.draw": undefined });
check(errors.length > 0, "a typed zero over an absent field must be flagged");
check(
  errors.some((e) => e.includes("rcf.draw") && e.includes("never surface")),
  "the flag names the slot and the never-zero rule",
);

console.log(JSON.stringify({ status: "PASS", checks }));
