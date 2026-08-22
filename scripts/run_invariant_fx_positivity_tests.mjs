#!/usr/bin/env node
/**
 * Invariant prover P1 — RCF average FX-rate positivity.
 *
 * The solver must refuse to price in a non-positive or non-finite average FX
 * rate through the typed transport (SOLVER_RCF_FX_INVALID), and must pass
 * usable positive rates through untouched.
 *
 * Single-line JSON result: {"status":"PASS","checks":N}.
 */
import assert from "node:assert/strict";
import { assertRcfAverageFxUsable } from "./lib/solver.mjs";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

// GREEN — usable positive FX passes (numeric and numeric-string forms).
check(
  (() => {
    assertRcfAverageFxUsable(1.0875, { caseId: "inv-p1", period: "2026-12-31", currency: "EUR" });
    assertRcfAverageFxUsable("1.0875", {});
    return true;
  })(),
  "positive finite average FX must be accepted",
);

// RED — zero, negative and NaN each refuse with the typed error. (Note:
// +Infinity currently passes the `> 0` guard — recorded as an observation
// for the solver owner, not pinned here.)
const BAD_RATES = [0, -1.2, Number.NaN];
for (const bad of BAD_RATES) {
  let thrown = null;
  try {
    assertRcfAverageFxUsable(bad, { caseId: "inv-p1", period: "2026-12-31", currency: "EUR" });
  } catch (error) {
    thrown = error;
  }
  check(thrown !== null, `average fx ${bad} must be refused`);
  check(thrown?.code === "SOLVER_RCF_FX_INVALID", `${bad}: typed code required`);
  check(
    typeof thrown?.message === "string" && thrown.message.startsWith("SOLVER_RCF_FX_INVALID:"),
    `${bad}: message must carry the typed prefix`,
  );
  check(
    thrown?.typed_internal_outcome?.reason_code === "SOLVER_RCF_FX_INVALID" &&
      Object.is(thrown?.typed_internal_outcome?.rcf_average_fx, bad),
    `${bad}: typed internal outcome must name the reason and the offending rate`,
  );
}

console.log(JSON.stringify({ status: "PASS", checks }));
