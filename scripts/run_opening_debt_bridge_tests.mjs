#!/usr/bin/env node
/**
 * P4.2 — the opening-debt reconciliation is a STRUCTURED BRIDGE artifact,
 * never a signed-residual scalar absorbed into a pool row.
 *
 * Proves:
 *  (a) RED-PROOF MUTATION: an unexplained residual sneaked into the visible
 *      residual-pool row is caught — solveCase refuses with the registered
 *      terminal reason code (SOURCE.opening_debt_unresolved), never absorbs;
 *  (b) FX translation is a named taxonomy line per foreign instrument, not an
 *      implicit rate baked into a scalar;
 *  (c) the emitted artifact validates against
 *      assets/opening-debt-bridge-v1.schema.json via lib/json_schema.mjs,
 *      and the schema actually bites on mutated artifacts;
 * plus: missing anchors never become zero, an untranslatable register is
 * NOT_EVALUABLE (coverage owns that BLOCK), a sub-tolerance残 is STATED as a
 * line, years 1-2 are declared asserted (not silently reconciled), and the
 * numeric solve path stays byte-identical when the bridge fully explains.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  OPENING_DEBT_BRIDGE_LINE_KINDS,
  OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE,
  OPENING_DEBT_BRIDGE_SCHEMA_VERSION,
  compileOpeningDebtBridge,
} from "./lib/opening_debt_bridge.mjs";
import { solveCase } from "./lib/solver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  fs.readFileSync(path.join(root, "assets", "opening-debt-bridge-v1.schema.json"), "utf8"),
);
const registry = JSON.parse(
  fs.readFileSync(path.join(root, "assets", "terminal-reason-registry-v1.json"), "utf8"),
);
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "test-fixtures", "cases", "standard-maximal-v2.json"), "utf8"),
);
// Maintained fixtures are production-shaped custody inputs; every scenario in
// this suite is forensic and identifies itself as such.
fixture.execution_profile = "reference_parity";

const clone = (value) => structuredClone(value);
const near = (left, right, tolerance = 1e-9) =>
  Math.abs(Number(left) - Number(right)) <= tolerance;
let checks = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${label}`);
    throw error;
  }
  checks += 1;
};

const assertSchemaValid = (artifact, label) => {
  const errors = validateJsonSchema(artifact, schema);
  assert.deepEqual(errors, [], `${label}: ${errors.join(" | ")}`);
};

// ---------------------------------------------------------------------------
// 1. The registered reason code EXISTS in the sealed registry and is a source
//    code terminating in SOURCE_REQUIRED — the refusal is typed, not a bare
//    BLOCK string.
check("registry owns the refusal reason code", () => {
  assert.equal(OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE, "SOURCE.opening_debt_unresolved");
  const code = registry.reason_codes[OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE];
  assert.ok(code, "reason code missing from terminal-reason registry");
  assert.equal(code.category, "source");
  assert.equal(code.owner_layer, "debt_reconciliation");
  assert.deepEqual(code.allowed_terminal_states, ["SOURCE_REQUIRED"]);
});

// ---------------------------------------------------------------------------
// 2. Pristine fixture: the bridge RECONCILES and the artifact is schema-valid.
const pristineBridge = compileOpeningDebtBridge(clone(fixture));
check("pristine fixture reconciles as a structured artifact", () => {
  assert.equal(pristineBridge.schema_version, OPENING_DEBT_BRIDGE_SCHEMA_VERSION);
  assert.equal(pristineBridge.verdict, "RECONCILED");
  assert.equal(pristineBridge.refusal, null);
  assertSchemaValid(pristineBridge, "pristine artifact");
});

check("every line kind is taxonomy, no line kind is invented", () => {
  assert.ok(pristineBridge.lines.length > 0);
  for (const line of pristineBridge.lines) {
    assert.ok(
      OPENING_DEBT_BRIDGE_LINE_KINDS.includes(line.line_kind),
      `unregistered line kind ${line.line_kind}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. (b) FX taxonomy lines: one per foreign-currency instrument, amount equal
//    to reporting minus native basis at the last historical period-end rate.
check("FX translation is a named line per foreign instrument", () => {
  const fxLines = pristineBridge.lines.filter((line) => line.line_kind === "fx_translation");
  const foreign = fixture.instruments.filter(
    (instrument) =>
      instrument.currency !== fixture.issuer.reporting_currency &&
      (instrument.balance_basis ?? "native_principal") === "native_principal",
  );
  assert.equal(fxLines.length, foreign.length, "one FX line per translated instrument");
  const eurRate = Number(fixture.fx.EUR.period_end_rates[2]);
  const eurBond = fixture.instruments.find((i) => i.instrument_id === "smc_eur_bond_2027");
  const eurLine = fxLines.find((line) => line.instrument_id === "smc_eur_bond_2027");
  assert.ok(eurLine, "EUR bond has no FX line");
  assert.ok(near(eurLine.amount, eurBond.opening_balance * (eurRate - 1)));
  assert.equal(eurLine.currency, fixture.issuer.reporting_currency);
  assert.match(eurLine.source_ref, /EUR/);
});

check("bridge totals close: reported = instruments + FX + pool + stated残", () => {
  const totals = pristineBridge.totals;
  assert.ok(near(totals.reported_opening_gross_debt, 9335.506));
  const summed = pristineBridge.lines.reduce((total, line) => total + line.amount, 0);
  assert.ok(near(summed, totals.reported_opening_gross_debt, 1e-6));
  assert.ok(
    near(
      totals.identified_instrument_total + totals.residual_pool_total,
      totals.explained_total,
      1e-9,
    ),
  );
  assert.ok(Math.abs(totals.unexplained_residual) <= pristineBridge.tolerance);
});

check("the declared pool is a visible residual_pool line, not an absorber", () => {
  const poolLines = pristineBridge.lines.filter((line) => line.line_kind === "residual_pool");
  assert.equal(poolLines.length, 1);
  assert.equal(poolLines[0].instrument_id, "smc_other_debt_pool");
  assert.ok(near(poolLines[0].amount, 213.641));
});

// ---------------------------------------------------------------------------
// 4. Solver attachment + numeric identity: solving the reconciled case
//    attaches the artifact and leaves every solved number untouched.
check("solveCase attaches the bridge artifact on the reconciled path", () => {
  const solved = solveCase(clone(fixture));
  assert.equal(solved.opening_debt_bridge?.verdict, "RECONCILED");
  assertSchemaValid(solved.opening_debt_bridge, "attached artifact");
  assert.equal(solved.forecast.length, 3);
  assert.equal(solved.converged, true);
  // Byte-identity of the numeric solve path: the solution minus the attached
  // artifact hashes identically across repeated solves of the same case.
  const strip = (solution) => {
    const copy = { ...solution };
    delete copy.opening_debt_bridge;
    return crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
  };
  assert.equal(strip(solved), strip(solveCase(clone(fixture))));
});

// ---------------------------------------------------------------------------
// 5. (a) RED-PROOF MUTATION: an unexplained +50 sneaks into the pool row.
//    The old world absorbed it silently (the pool IS the plug); the bridge
//    refuses with the registered terminal reason code.
check("unexplained residual sneaked into the pool row is refused, typed", () => {
  const sneaked = clone(fixture);
  sneaked.instruments.find((i) => i.instrument_id === "smc_other_debt_pool")
    .opening_balance += 50;
  const bridge = compileOpeningDebtBridge(sneaked);
  assert.equal(bridge.verdict, "REFUSE_UNEXPLAINED_RESIDUAL");
  assert.equal(bridge.refusal?.reason_code, OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE);
  assert.ok(near(bridge.totals.unexplained_residual, -50, 1e-6));
  const stated = bridge.lines.find((line) => line.line_kind === "unexplained_residual");
  assert.ok(stated, "the unexplained residual must be a stated line, not a silent scalar");
  assert.ok(near(stated.amount, -50, 1e-6));
  assertSchemaValid(bridge, "refused artifact");

  assert.throws(
    () => solveCase(sneaked),
    (error) => {
      assert.equal(error.code, "OPENING_DEBT_UNRESOLVED");
      assert.equal(
        error.typed_internal_outcome?.reason_code,
        OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE,
      );
      assert.equal(
        error.opening_debt_bridge?.verdict,
        "REFUSE_UNEXPLAINED_RESIDUAL",
      );
      assertSchemaValid(error.opening_debt_bridge, "thrown artifact");
      return true;
    },
  );
});

// 6. Over-identification (no negative pool exists): typed refusal too.
check("over-identified register refuses typed", () => {
  const overIdentified = clone(fixture);
  overIdentified.instruments.find((i) => i.instrument_id === "smc_usd_bond_2029")
    .opening_balance += 100;
  assert.throws(
    () => solveCase(overIdentified),
    (error) =>
      error.typed_internal_outcome?.reason_code === OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE &&
      near(error.opening_debt_bridge?.totals?.unexplained_residual, -100, 1e-6),
  );
});

// 7. Under-identification the pool does NOT tie: typed refusal.
check("untied under-identification refuses typed", () => {
  const underIdentified = clone(fixture);
  underIdentified.instruments.find((i) => i.instrument_id === "smc_securitisation")
    .opening_balance -= 50;
  assert.throws(
    () => solveCase(underIdentified),
    (error) =>
      error.typed_internal_outcome?.reason_code === OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE &&
      Number(error.opening_debt_bridge?.totals?.unexplained_residual) > 49,
  );
});

// ---------------------------------------------------------------------------
// 8. Absent anchor: never zero, never a refusal invented from nothing.
check("absent reported anchor is NO_REPORTED_ANCHOR with null totals", () => {
  const anchorless = clone(fixture);
  delete anchorless.debt_reconciliation;
  const bridge = compileOpeningDebtBridge(anchorless);
  assert.equal(bridge.verdict, "NO_REPORTED_ANCHOR");
  assert.equal(bridge.totals.reported_opening_gross_debt, null);
  assert.notEqual(bridge.totals.reported_opening_gross_debt, 0);
  assert.equal(bridge.refusal, null);
  assertSchemaValid(bridge, "anchorless artifact");
});

// 9. Untranslatable register: NOT_EVALUABLE (coverage owns that BLOCK), the
//    bridge does not pretend a mixed-currency sum reconciles or refuses.
check("untranslatable register is NOT_EVALUABLE, errors carried", () => {
  const untranslatable = clone(fixture);
  delete untranslatable.fx.EUR;
  const bridge = compileOpeningDebtBridge(untranslatable);
  assert.equal(bridge.verdict, "NOT_EVALUABLE");
  assert.match(bridge.errors.join(" "), /Missing FX assumptions for EUR/);
  assert.equal(bridge.totals.explained_total, null);
  assertSchemaValid(bridge, "untranslatable artifact");
});

// ---------------------------------------------------------------------------
// Synthetic micro-register for classification, years and sub-tolerance残.
const periods = [
  { date: "2023-12-31", status: "historical" },
  { date: "2024-12-31", status: "historical" },
  { date: "2025-12-31", status: "historical" },
  { date: "2026-12-31", status: "forecast" },
  { date: "2027-12-31", status: "forecast" },
  { date: "2028-12-31", status: "forecast" },
];
const microCase = (reported, extra = {}) => ({
  case_id: "opening-debt-bridge-micro",
  contract_version: 2,
  execution_profile: "reference_parity",
  issuer: { reporting_currency: "GBP", units: "millions" },
  periods,
  instruments: [
    {
      instrument_id: "gbp_bond",
      class: "bond_fixed",
      currency: "GBP",
      balance_basis: "native_principal",
      opening_balance: 100,
      include_in_gross_debt: true,
    },
    {
      instrument_id: "excluded_note",
      class: "other_explicit",
      currency: "GBP",
      balance_basis: "native_principal",
      opening_balance: 50,
      include_in_gross_debt: false,
    },
  ],
  debt_reconciliation: {
    reported_opening_gross_debt: reported,
    maximum_residual_percentage: 0.05,
  },
  ...extra,
});

// 10. Classification moves are visible lines contributing exactly nothing.
check("classification move is a stated line with zero bridge contribution", () => {
  const bridge = compileOpeningDebtBridge(microCase(100));
  assert.equal(bridge.verdict, "RECONCILED");
  const move = bridge.lines.find((line) => line.line_kind === "classification_move");
  assert.ok(move, "excluded instrument must appear as a classification_move line");
  assert.equal(move.instrument_id, "excluded_note");
  assert.equal(move.amount, 0);
  assert.match(move.source_ref, /50/);
  assertSchemaValid(bridge, "classification artifact");
});

// 11. A sub-tolerance残 is STATED as a line, never silently absorbed.
check("sub-tolerance residual is stated, not absorbed", () => {
  const bridge = compileOpeningDebtBridge(microCase(100.005));
  assert.equal(bridge.verdict, "RECONCILED");
  const stated = bridge.lines.find((line) => line.line_kind === "unexplained_residual");
  assert.ok(stated, "the sub-tolerance残 must still be a visible line");
  assert.ok(near(stated.amount, 0.005, 1e-9));
  assertSchemaValid(bridge, "sub-tolerance artifact");
});

// 12. Series-form years: years 1-2 are declared asserted, year 3 bridged.
check("years 1-2 are declared asserted, never silently reconciled", () => {
  const bridge = compileOpeningDebtBridge(microCase([90, 95, 100]));
  assert.equal(bridge.reported_form, "series3");
  assert.deepEqual(
    bridge.years.map((year) => year.basis),
    [
      "asserted_no_instrument_history",
      "asserted_no_instrument_history",
      "instrument_register_bridge",
    ],
  );
  assert.deepEqual(bridge.years.map((year) => year.reported), [90, 95, 100]);
  const scalar = compileOpeningDebtBridge(microCase(100));
  assert.equal(scalar.reported_form, "scalar");
  assert.deepEqual(scalar.years.map((year) => year.basis), [
    "absent",
    "absent",
    "instrument_register_bridge",
  ]);
  assert.deepEqual(scalar.years.map((year) => year.reported), [null, null, 100]);
});

// 13. Micro refusal: the残 above tolerance refuses even with no pool at all.
check("unexplained残 above tolerance refuses without any pool row", () => {
  const bridge = compileOpeningDebtBridge(microCase(103));
  assert.equal(bridge.verdict, "REFUSE_UNEXPLAINED_RESIDUAL");
  assert.equal(bridge.refusal?.reason_code, OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE);
  assert.ok(near(bridge.totals.unexplained_residual, 3, 1e-9));
  assertSchemaValid(bridge, "micro refusal artifact");
});

// ---------------------------------------------------------------------------
// 14. (c) The schema BITES: mutated artifacts fail validation.
check("schema rejects an invented line kind", () => {
  const mutated = clone(pristineBridge);
  mutated.lines[0].line_kind = "signed_scalar_plug";
  assert.ok(validateJsonSchema(mutated, schema).length > 0);
});

check("schema rejects non-numeric totals and a missing verdict", () => {
  const stringTotal = clone(pristineBridge);
  stringTotal.totals.unexplained_residual = "0";
  assert.ok(validateJsonSchema(stringTotal, schema).length > 0);
  const noVerdict = clone(pristineBridge);
  delete noVerdict.verdict;
  assert.ok(validateJsonSchema(noVerdict, schema).length > 0);
  const alienVerdict = clone(pristineBridge);
  alienVerdict.verdict = "PASS_DEGRADED";
  assert.ok(validateJsonSchema(alienVerdict, schema).length > 0);
});

check("schema rejects a refusal without the registered reason code", () => {
  const sneaked = clone(fixture);
  sneaked.instruments.find((i) => i.instrument_id === "smc_other_debt_pool")
    .opening_balance += 50;
  const refused = compileOpeningDebtBridge(sneaked);
  const wrongCode = clone(refused);
  wrongCode.refusal.reason_code = "INTERNAL.compiler_or_graph_defect";
  assert.ok(validateJsonSchema(wrongCode, schema).length > 0);
});

console.log(JSON.stringify({ status: "PASS", checks }));
