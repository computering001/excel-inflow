#!/usr/bin/env node
/**
 * P4.1a — the never-zero coercions in opening-instrument provenance (D11) and
 * the untyped `lease_liability` refusal (D12).
 *
 * WHAT THIS SUITE EXISTS TO PROVE, and why P4.1's own 30-check suite did not:
 * P4.1 proved the *shape* of the opening source inventory — candidate ids,
 * source rows, a typed not-selected register, replayability. It never asked
 * what happens when the declared opening balance is not a number at all. The
 * generated cohort (P7.3) did, and found four coercions inside freshly sealed
 * code:
 *
 *     typedDeclaredAmount(" ")   -> reported_zero      (Number(" ")   === 0)
 *     typedDeclaredAmount(false) -> reported_zero      (Number(false) === 0)
 *     typedDeclaredAmount([])    -> reported_zero      (Number([])    === 0)
 *     typedDeclaredAmount(true)  -> reported_number 1  (Number(true)  === 1)
 *
 * and — worse — all four were then SELECTED into the opening register with a
 * numeric basis amount and contributed to `reporting_total`. That violates the
 * CENTRAL invariant of the typed financial value model: missing, blank, nil
 * and unparseable are NEVER zero and never any other number.
 *
 * `instrument_period_state.mjs` carried a NEVER-ZERO comment naming
 * `Number(false)` as a defended coercion, but the guard tested an ALLOW-LIST of
 * two absence states (`nil`, `reported_blank`). The defence was incomplete, not
 * absent — which is precisely why an allow-list is the wrong shape for this
 * gate. Section 4 below is a MUTATION proof that the repaired guard cannot
 * regress to an allow-list without this suite going red.
 *
 * Sections:
 *   1. the four coercions read as never-zero typed states (pure oracle);
 *   2. none of the four can be SELECTED, and each is registered not-selected
 *      with a reason from P4.1's sealed 10-reason vocabulary;
 *   3. `reporting_total` — both the state's and the one replayed from the
 *      recorded provenance alone — excludes them;
 *   4. MUTATION: the allow-list guard is reinstated in a copy of the module and
 *      must be caught (the gate has teeth);
 *   5. the validator refuses a SELECTED candidate standing on a non-value-
 *      bearing declared amount, whatever number the selection records;
 *   6. D12: the `lease_liability` instrument-class refusal carries a registered
 *      reason code and a `typed_internal_outcome`, and the contract claim
 *      mismatch that makes the refusal reachable is pinned.
 *
 * Reasons vocabulary decision: REUSED, not extended. `opening_balance_unresolved`
 * already means "the declared opening balance did not resolve to a number";
 * a boolean, array, object or whitespace-only cell is exactly that. The
 * 10-reason vocabulary is unchanged.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compileInstrumentPeriodState,
  compileOpeningInstrumentState,
} from "./lib/instrument_period_state.mjs";
import {
  OPENING_INSTRUMENT_NOT_SELECTED_REASONS,
  replayOpeningInstrumentSelection,
  typedDeclaredAmount,
  validateOpeningInstrumentProvenance,
} from "./lib/opening_instrument_provenance.mjs";
import {
  NEVER_ZERO_STATES,
  VALUE_BEARING_STATES,
  numericValueOf,
} from "./lib/typed_financial_value.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libDir = path.join(root, "scripts", "lib");
let checks = 0;
// Honest mutation accounting: the D11 MUTATION proofs each reinstate or
// remove a load-bearing guard line inside a COPY of the module and are
// counted CAUGHT only when production refuses the mutant while it is active;
// a surviving mutant rethrows and no count line is printed.
let mutations_total = 0;
let mutations_caught = 0;
const isMutationLabel = (label) => /^D11 MUTATION/.test(label);
const check = (label, fn) => {
  const isMutation = isMutationLabel(label);
  if (isMutation) mutations_total += 1;
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${label}: ${error.message}`);
    throw error;
  }
  checks += 1;
  if (isMutation) mutations_caught += 1;
};
const checkAsync = async (label, fn) => {
  const isMutation = isMutationLabel(label);
  if (isMutation) mutations_total += 1;
  try {
    await fn();
  } catch (error) {
    console.error(`FAIL ${label}: ${error.message}`);
    throw error;
  }
  checks += 1;
  if (isMutation) mutations_caught += 1;
};

const clone = (value) => structuredClone(value);
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), "utf8"));

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
    include_in_gross_debt: true,
    include_in_net_debt: true,
    ...overrides,
  };
}

/**
 * One clean instrument carrying a real 500 balance, plus one whose declared
 * opening balance is the coercion under test. The clean row makes the
 * reporting-total proof sharp: the total must be exactly 500, never 500 + 0
 * (the zero coercions) and never 500 + 1 (the `true` coercion).
 */
const CLEAN_BASIS = 500;
function coercionCase(raw) {
  return {
    case_id: "opening-amount-typing-defect",
    contract_version: 2,
    issuer: { reporting_currency: "GBP", units: "millions" },
    periods,
    statement_structure: { income_statement: [], cash_flow: [] },
    instruments: [
      instrument("clean_gbp", { opening_balance: CLEAN_BASIS }),
      instrument("coerced_gbp", { opening_balance: raw }),
    ],
    fx: {},
    debt_reconciliation: {
      reported_opening_gross_debt: [CLEAN_BASIS, CLEAN_BASIS, CLEAN_BASIS],
      maximum_residual_percentage: 0.01,
    },
    controls: { debt_maturities_roll: 1, circularity: 1 },
    cash_policy: { opening_cash: 0, minimum_cash: [0, 0, 0] },
    lease_policy: { mode: "exclude" },
    broker_pack: { metrics: {} },
    source_coverage: {},
  };
}

/**
 * The four cohort-found coercions, each with the seed that found it, the state
 * it WRONGLY produced, and the never-zero state it must produce instead.
 * `parse_failure` is the lawful existing state for a declared value that is
 * present but carries no parseable number; `reported_blank` is the lawful state
 * for a cell that is blank — and a whitespace-only cell is a blank cell in
 * every spreadsheet sense. No new typed state is invented.
 */
const COERCIONS = [
  {
    label: "whitespace_only",
    seed: 7730022,
    raw: " ",
    defectState: "reported_zero",
    expectedState: "reported_blank",
  },
  {
    label: "boolean_false",
    seed: 7730012,
    raw: false,
    defectState: "reported_zero",
    expectedState: "parse_failure",
  },
  {
    label: "empty_array",
    seed: 7730000,
    raw: [],
    defectState: "reported_zero",
    expectedState: "parse_failure",
  },
  {
    label: "boolean_true",
    seed: 7730034,
    raw: true,
    defectState: "reported_number",
    expectedState: "parse_failure",
  },
];

// ---------------------------------------------------------------------------
// 1. THE FOUR COERCIONS. Pure oracle over typedDeclaredAmount.
// ---------------------------------------------------------------------------
for (const coercion of COERCIONS) {
  check(`D11 ${coercion.label}: typedDeclaredAmount is never a numeric state (seed ${coercion.seed})`, () => {
    const typed = typedDeclaredAmount(clone(coercion.raw));
    assert.notEqual(
      typed.state,
      coercion.defectState,
      `${coercion.label} still coerces to ${coercion.defectState}; ` +
        `Number(${JSON.stringify(coercion.raw)}) is not evidence of a reported amount.`,
    );
    assert.ok(
      NEVER_ZERO_STATES.includes(typed.state),
      `${coercion.label} typed as ${typed.state}, which is not one of P1.2's never-zero states.`,
    );
    assert.ok(
      !VALUE_BEARING_STATES.includes(typed.state),
      `${coercion.label} typed as a value-bearing state (${typed.state}).`,
    );
    assert.equal(typed.state, coercion.expectedState);
    assert.equal(
      numericValueOf(typed),
      null,
      `${coercion.label} reads as a number (${numericValueOf(typed)}); the only lawful reading is null.`,
    );
    assert.notEqual(numericValueOf(typed), 0);
  });
}

check("D11: a declared value that carries no number never records a numeric field", () => {
  for (const coercion of COERCIONS) {
    const typed = typedDeclaredAmount(clone(coercion.raw));
    assert.ok(
      !("value" in typed),
      `${coercion.label} carries value ${typed.value}; a never-zero state has no numeric field to misread.`,
    );
  }
  // A parse failure must still say WHAT it saw and WHY it failed — a typed
  // refusal that names nothing is a silent drop wearing a state name.
  const fromArray = typedDeclaredAmount([]);
  assert.equal(fromArray.state, "parse_failure");
  assert.equal(fromArray.raw_text, "[]", "an empty array recorded raw_text '' — a false blank-cell claim");
  assert.ok(fromArray.failure_reason.length > 0);
  assert.match(typedDeclaredAmount(false).failure_reason, /boolean/);
  assert.equal(typedDeclaredAmount(false).raw_text, "false");
  assert.equal(typedDeclaredAmount({}).state, "parse_failure");
  assert.equal(typedDeclaredAmount({ amount: 1 }).state, "parse_failure");
  assert.equal(typedDeclaredAmount(() => 1).state, "parse_failure");
});

check("D11: the states typedDeclaredAmount already got right are unchanged", () => {
  assert.equal(typedDeclaredAmount(undefined).state, "missing");
  assert.equal(typedDeclaredAmount(null).state, "nil");
  assert.equal(typedDeclaredAmount("").state, "reported_blank");
  assert.equal(typedDeclaredAmount("not a number").state, "parse_failure");
  assert.equal(typedDeclaredAmount(0).state, "reported_zero");
  assert.equal(typedDeclaredAmount("0").state, "reported_zero");
  assert.equal(typedDeclaredAmount("0.00").state, "reported_zero");
  assert.equal(typedDeclaredAmount(100).state, "reported_number");
  assert.equal(typedDeclaredAmount(100).value, 100);
  // A numeric string with surrounding whitespace is still a stated number.
  assert.equal(typedDeclaredAmount(" 42 ").state, "reported_number");
  assert.equal(typedDeclaredAmount(" 42 ").value, 42);
  assert.equal(typedDeclaredAmount("1e3").value, 1000);
  assert.equal(typedDeclaredAmount(Number.NaN).state, "parse_failure");
  assert.equal(typedDeclaredAmount(Number.POSITIVE_INFINITY).state, "parse_failure");
});

// ---------------------------------------------------------------------------
// 2. NOT SELECTED. The four must never reach the register with a balance.
// ---------------------------------------------------------------------------
const compiledByLabel = new Map();
for (const coercion of COERCIONS) {
  const compiled = compileOpeningInstrumentState(coercionCase(clone(coercion.raw)));
  compiledByLabel.set(coercion.label, compiled);

  check(`D11 ${coercion.label}: cannot be SELECTED into the opening register`, () => {
    const selected = compiled.rows.map((row) => row.instrument_id);
    assert.ok(
      !selected.includes("coerced_gbp"),
      `coerced_gbp was selected with basis ${JSON.stringify(
        compiled.rows.find((row) => row.instrument_id === "coerced_gbp")?.basis_amount,
      )}; a declared ${coercion.label} is not a balance.`,
    );
    assert.deepEqual(selected, ["clean_gbp"], "the clean instrument must still compile normally");
    assert.equal(compiled.status, "BLOCKED");
    const candidate = compiled.source_inventory.candidates.find(
      (entry) => entry.instrument_id === "coerced_gbp",
    );
    assert.equal(candidate.outcome, "not_selected");
    assert.equal(candidate.selection, null, "a not-selected candidate still records a selection");
    assert.ok(!compiled.source_inventory.selected_candidate_ids.includes(candidate.candidate_id));
  });

  check(`D11 ${coercion.label}: appears in the not-selected register with a typed reason`, () => {
    const entry = compiled.source_inventory.not_selected.find(
      (item) => item.instrument_id === "coerced_gbp",
    );
    assert.ok(entry, "the rejected candidate is absent from the not-selected register");
    assert.ok(
      OPENING_INSTRUMENT_NOT_SELECTED_REASONS.includes(entry.reason),
      `untyped reason ${entry.reason}`,
    );
    // REUSED reason, deliberately: the declared amount did not resolve to a
    // number. The 10-reason vocabulary is not extended by this package.
    assert.equal(entry.reason, "opening_balance_unresolved");
    assert.notEqual(
      entry.reason,
      "unresolved_compile_defect",
      "the typed fallback must not be the answer for a defect we have now named",
    );
    assert.ok(entry.detail.trim().length > 0);
    assert.match(entry.detail, /coerced_gbp/);
    // The compiler must REGISTER, never throw: a throw out of the opening
    // compiler is an untyped drop by another route.
    assert.ok(compiled.errors.some((message) => /coerced_gbp/.test(message)));
    assert.deepEqual(
      validateOpeningInstrumentProvenance(compiled),
      [],
      "the rejection path produced an invalid inventory",
    );
  });
}

check("D11: the four coercions are refused for the SAME structural reason", () => {
  const reasons = new Set(
    COERCIONS.map(
      (coercion) =>
        compiledByLabel
          .get(coercion.label)
          .source_inventory.not_selected.find((entry) => entry.instrument_id === "coerced_gbp")
          .reason,
    ),
  );
  assert.deepEqual(
    [...reasons],
    ["opening_balance_unresolved"],
    "the four coercions must not fan out into four different reasons; they are one defect class",
  );
});

// ---------------------------------------------------------------------------
// 3. REPORTING TOTAL. The refused amounts contribute nothing, on both the
//    compiled state and the total replayed from the provenance alone.
// ---------------------------------------------------------------------------
for (const coercion of COERCIONS) {
  check(`D11 ${coercion.label}: absent from reporting_total`, () => {
    const compiled = compiledByLabel.get(coercion.label);
    // A BLOCKED state publishes NO total: a partial register is not a total.
    assert.equal(
      compiled.reporting_total,
      null,
      `a BLOCKED opening state published a total of ${compiled.reporting_total}`,
    );
    // And the total replayed from the recorded provenance ALONE is exactly the
    // clean row — never 500 + 0, never 500 + 1.
    const replay = replayOpeningInstrumentSelection(compiled.source_inventory);
    assert.equal(replay.rows.length, 1);
    assert.equal(
      replay.reporting_total,
      CLEAN_BASIS,
      `the replayed total is ${replay.reporting_total}; the refused ${coercion.label} still contributes ` +
        `${replay.reporting_total - CLEAN_BASIS}`,
    );
    assert.ok(!replay.rows.some((row) => row.instrument_id === "coerced_gbp"));
  });
}

check("D11 boolean_true: the coercion moved a real number into the total", () => {
  // The sharpest of the four: `Number(true)` is 1, so before the repair the
  // replayed total was 501 — a fabricated pound of debt, not merely a zero row.
  const replay = replayOpeningInstrumentSelection(
    compiledByLabel.get("boolean_true").source_inventory,
  );
  assert.notEqual(replay.reporting_total, CLEAN_BASIS + 1);
  assert.equal(replay.reporting_total, CLEAN_BASIS);
});

check("D11: a genuinely reported zero is still selected and still totals zero", () => {
  // The repair must not overshoot: a company that genuinely printed 0 has a
  // reported_zero, which IS value-bearing and IS a lawful register row.
  const compiled = compileOpeningInstrumentState(coercionCase(0));
  assert.equal(compiled.status, "PASS");
  assert.deepEqual(compiled.rows.map((row) => row.instrument_id), ["clean_gbp", "coerced_gbp"]);
  assert.equal(compiled.rows[1].basis_amount, 0);
  assert.equal(compiled.reporting_total, CLEAN_BASIS);
  assert.deepEqual(validateOpeningInstrumentProvenance(compiled), []);
  const candidate = compiled.source_inventory.candidates[1];
  assert.equal(candidate.declared.opening_balance.state, "reported_zero");
  assert.equal(numericValueOf(candidate.declared.opening_balance), 0);
});

// ---------------------------------------------------------------------------
// 4. MUTATION. The repair has two load-bearing halves, and each must be proved
//    load-bearing separately:
//      A. the compiler's guard is a property of the SEALED typed vocabulary,
//         not an allow-list of absence states — reinstating the allow-list
//         readmits every coercion that types as `parse_failure`;
//      B. `typedDeclaredAmount` classifies a whitespace-only cell BEFORE the
//         `Number()` coercion — removing that line readmits `" "`, which the
//         guard alone cannot stop because `Number(" ")` is a clean 0.
//    Without both mutants this suite would pin today's behaviour rather than
//    the invariant, which is exactly how D11 survived P4.1's own 30 checks.
// ---------------------------------------------------------------------------
const GUARD_ANCHOR = "const declaredNumber = numericValueOf(declaredAmount);";
const ALLOW_LIST_MUTANT =
  'const declaredNumber = ["nil", "reported_blank"].includes(declaredAmount.state) ' +
  "? null : Number(instrument.opening_balance);";
const WHITESPACE_ANCHOR =
  'if (typeof raw === "string" && raw.trim() === "") return typedValue("reported_blank");';

const guardSource = fs.readFileSync(path.join(libDir, "instrument_period_state.mjs"), "utf8");
const provenanceSource = fs.readFileSync(
  path.join(libDir, "opening_instrument_provenance.mjs"),
  "utf8",
);

check("D11: the guard is derived from the typed vocabulary, not an allow-list", () => {
  assert.ok(
    guardSource.includes(GUARD_ANCHOR),
    "the never-zero guard no longer routes through numericValueOf; a hand-written state list " +
      "readmits every new coercion the way `Number(false)` was readmitted.",
  );
  assert.ok(
    !/\[\s*"nil"\s*,\s*"reported_blank"\s*\]\s*\.includes/.test(guardSource),
    "the two-state allow-list is back in the compiler.",
  );
  assert.ok(provenanceSource.includes(WHITESPACE_ANCHOR));
});

const LOCAL_PROVENANCE = "./opening_instrument_provenance.mutant.mjs";
const LIB_URL = pathToFileURL(libDir).href;

/**
 * Write a two-file mutant of the opening-state compiler into a temp directory
 * and import it. Sibling imports are rewritten to absolute file URLs, EXCEPT
 * the provenance module, which stays local so the mutated pair is what runs.
 * Nothing else about either module changes.
 */
async function importMutant({ stateMutation, provenanceMutation }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p41a-mutant-"));
  let state = stateMutation ? stateMutation(guardSource) : guardSource;
  let provenance = provenanceMutation ? provenanceMutation(provenanceSource) : provenanceSource;
  assert.ok(
    (!stateMutation || state !== guardSource) &&
      (!provenanceMutation || provenance !== provenanceSource),
    "a mutation did not apply — the anchor moved and this proof is vacuous",
  );
  state = state
    .replace('from "./opening_instrument_provenance.mjs"', 'from "@@PROVENANCE@@"')
    .replaceAll('from "./', `from "${LIB_URL}/`)
    .replace('from "@@PROVENANCE@@"', `from "${LOCAL_PROVENANCE}"`);
  provenance = provenance.replaceAll('from "./', `from "${LIB_URL}/`);
  fs.writeFileSync(path.join(dir, "opening_instrument_provenance.mutant.mjs"), provenance);
  const file = path.join(dir, "instrument_period_state.mutant.mjs");
  fs.writeFileSync(file, state);
  const loaded = await import(pathToFileURL(file).href);
  return { module: loaded, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function readmittedBy(mutant) {
  const readmitted = [];
  for (const coercion of COERCIONS) {
    const compiled = mutant.compileOpeningInstrumentState(coercionCase(clone(coercion.raw)));
    if (compiled.rows.some((row) => row.instrument_id === "coerced_gbp")) {
      readmitted.push(coercion.label);
    }
  }
  return readmitted;
}

await checkAsync("D11 MUTATION A: reinstating the allow-list guard is caught", async () => {
  const { module: mutant, cleanup } = await importMutant({
    stateMutation: (source) => source.replace(GUARD_ANCHOR, ALLOW_LIST_MUTANT),
  });
  try {
    const readmitted = readmittedBy(mutant);
    // The allow-list knows only `nil` and `reported_blank`, so every coercion
    // that types as `parse_failure` walks straight past it — the same blind
    // spot that let `Number(false)` through the guard whose comment named it.
    assert.deepEqual(
      readmitted.sort(),
      ["boolean_false", "boolean_true", "empty_array"],
      `the allow-list mutant readmitted ${JSON.stringify(readmitted)}; if it readmits nothing, ` +
        "this suite has no teeth and the guard shape is untested",
    );
    // A first-class control: the unmutated pair readmits NOTHING.
    const { module: control, cleanup: cleanControl } = await importMutant({});
    try {
      assert.deepEqual(readmittedBy(control), []);
    } finally {
      cleanControl();
    }
  } finally {
    cleanup();
  }
});

await checkAsync("D11 MUTATION B: dropping the whitespace classification is caught", async () => {
  const { module: mutant, cleanup } = await importMutant({
    provenanceMutation: (source) => source.replace(WHITESPACE_ANCHOR, ""),
  });
  try {
    // The guard is untouched here, and it still cannot save the case: with the
    // whitespace-only line gone, `Number(" ")` is a clean 0 and the declared
    // amount is value-bearing, so the register admits a fabricated zero row.
    assert.deepEqual(
      readmittedBy(mutant),
      ["whitespace_only"],
      "removing the whitespace-only classification no longer readmits ' ' — the two halves of " +
        "the repair are not independently proved",
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. THE VALIDATOR. Selection on a non-value-bearing declared amount must be a
//    validation error, so a future compiler cannot smuggle one back in.
// ---------------------------------------------------------------------------
check("D11: the validator refuses a SELECTED candidate whose declared amount is not a number", () => {
  const clean = compileOpeningInstrumentState(coercionCase(CLEAN_BASIS));
  assert.equal(clean.status, "PASS");
  assert.deepEqual(validateOpeningInstrumentProvenance(clean), []);
  for (const state of ["nil", "reported_blank", "parse_failure", "missing"]) {
    const tampered = clone(clean);
    const candidate = tampered.source_inventory.candidates.find(
      (entry) => entry.instrument_id === "coerced_gbp",
    );
    candidate.declared.opening_balance =
      state === "nil"
        ? { contract_version: "1.0.0", state: "nil", raw_text: "null" }
        : state === "reported_blank"
          ? { contract_version: "1.0.0", state: "reported_blank" }
          : state === "missing"
            ? { contract_version: "1.0.0", state: "missing" }
            : {
                contract_version: "1.0.0",
                state: "parse_failure",
                raw_text: "false",
                failure_reason: "fabricated",
              };
    const errors = validateOpeningInstrumentProvenance(tampered);
    assert.ok(
      errors.length > 0,
      `a candidate selected on a ${state} declared amount validated with zero errors`,
    );
    assert.match(errors.join(" | "), new RegExp(state));
  }
});

// ---------------------------------------------------------------------------
// 6. D12 — the `lease_liability` instrument-class refusal.
// ---------------------------------------------------------------------------
const REGISTRY = readJson("assets", "terminal-reason-registry-v1.json");
const MODEL_CASE_SCHEMA = readJson("assets", "model-case-v2.schema.json");
const ENVELOPE = readJson("assets", "support-envelope-v377.json");

function leaseClassCase() {
  const value = coercionCase(CLEAN_BASIS);
  value.case_id = "lease-liability-on-the-debt-register";
  value.instruments = [instrument("lease_on_debt_register", { class: "lease_liability" })];
  value.debt_reconciliation = {
    reported_opening_gross_debt: [100, 100, 100],
    maximum_residual_percentage: 0.01,
  };
  return value;
}

const leaseThrow = (() => {
  try {
    compileInstrumentPeriodState(leaseClassCase());
    return null;
  } catch (error) {
    return error;
  }
})();

check("D12: the refusal still happens, and still names the refused class", () => {
  assert.ok(leaseThrow instanceof Error, "a lease_liability register row compiled without refusal");
  assert.match(leaseThrow.message, /Unsupported debt class lease_liability/);
});

check("D12: the refusal carries an error code", () => {
  assert.notEqual(leaseThrow.code, undefined, "the refusal carries no error.code");
  assert.equal(typeof leaseThrow.code, "string");
});

check("D12: the refusal carries a typed_internal_outcome reaching a lawful terminal", () => {
  const outcome = leaseThrow.typed_internal_outcome;
  assert.notEqual(
    outcome,
    undefined,
    "the refusal carries no typed_internal_outcome, so the terminal catch can only guess",
  );
  const registered = REGISTRY.reason_codes[outcome.reason_code];
  assert.ok(
    registered !== undefined,
    `${outcome.reason_code} is not in the sealed terminal-reason registry`,
  );
  assert.ok(
    Array.isArray(registered.allowed_terminal_states) && registered.allowed_terminal_states.length > 0,
    "the reason code admits no terminal state",
  );
  for (const field of REGISTRY.internal_failure_payload_requirements) {
    if (field === "resumable_checkpoint_path" || field === "preserved_source_hashes") continue;
    assert.ok(field in outcome, `the payload omits the required field ${field}`);
  }
  assert.equal(typeof outcome.earliest_responsible_layer, "string");
  assert.ok(outcome.earliest_responsible_layer.length > 0);
  assert.equal(typeof outcome.downstream_invalidation_scope, "string");
  // The payload must name WHAT was refused, or the terminal report cannot say.
  assert.equal(outcome.declared_instrument_class, "lease_liability");
});

check("D12: the refusal is NOT the untyped fallback the terminal catch invents", () => {
  // run_user_flow / run_excel_inflow_vnext both fall back to
  // INTERNAL.compiler_or_graph_defect with "unattributed (repair: type this
  // throw)" when a throw carries nothing. This throw must not rely on that.
  const outcome = leaseThrow.typed_internal_outcome;
  assert.doesNotMatch(String(outcome.earliest_responsible_layer), /unattributed/);
  // P7.11 re-owned this refusal. P4.1a could only name the layer that threw,
  // because the contract still promised the class on the register lane and the
  // registry was not P4.1a's to extend. The envelope now declares the LANE that
  // delivers lease_liability (lease_policy), so a register row naming it is a
  // lane disagreement in the SOURCE's debt table, resolvable by the lease
  // disclosure — owned by debt_reconciliation, terminal SOURCE_REQUIRED, never
  // an engineering failure the user is asked to accept as their own.
  assert.equal(outcome.earliest_responsible_layer, "debt_reconciliation");
  assert.equal(outcome.reason_code, "SOURCE.lease_declared_on_debt_register");
  assert.deepEqual(
    REGISTRY.reason_codes[outcome.reason_code].allowed_terminal_states,
    ["SOURCE_REQUIRED"],
  );
});

check("D12: the `unclassified` review sentinel is refused with its OWN registered reason", () => {
  const value = leaseClassCase();
  value.instruments[0].class = "unclassified";
  let thrown = null;
  try {
    compileInstrumentPeriodState(value);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /Unsupported debt class unclassified/);
  // The CODE names what was refused and is shared; the REASON names who owns
  // it, and the two refusals do not have the same owner. An unresolved class is
  // a gap in what the source said, not a lease routed to the wrong lane.
  assert.equal(thrown.code, leaseThrow.code);
  assert.notEqual(thrown.typed_internal_outcome, undefined);
  assert.equal(thrown.typed_internal_outcome.declared_instrument_class, "unclassified");
  assert.equal(
    thrown.typed_internal_outcome.reason_code,
    "SOURCE.instrument_class_unresolved",
  );
  assert.notEqual(
    thrown.typed_internal_outcome.reason_code,
    leaseThrow.typed_internal_outcome.reason_code,
  );
  assert.deepEqual(
    REGISTRY.reason_codes[thrown.typed_internal_outcome.reason_code].allowed_terminal_states,
    ["SOURCE_REQUIRED"],
  );
});

check("D12: the contract now declares the LANE that delivers the refused class", () => {
  // P4.1a pinned this as a CONTRACT CLAIM MISMATCH: both contracts named the
  // class on the debt-instrument register and the compiler refused it, so the
  // product promised a lane it did not have. P7.11 repaired the claim rather
  // than the promise — leases ARE modelled, on the lease_policy lane — so the
  // pin is inverted: the class must still be admitted (a real debt note lists
  // leases among borrowings and attachment_ingress projects the export's
  // instrument_type straight through), and the envelope must now say WHICH
  // lane delivers it.
  assert.ok(
    MODEL_CASE_SCHEMA.$defs.instrument.properties.class.enum.includes("lease_liability"),
    "instruments[].class must still admit the declaration a real debt export produces",
  );
  assert.ok(
    ENVELOPE.dimensions.debt_instruments.declared_matrix.includes("lease_liability"),
    "the envelope still promises the class",
  );
  assert.equal(
    ENVELOPE.dimensions.debt_instruments.declared_matrix_lanes.lease_liability,
    "lease_policy",
    "and must name the lane that keeps the promise",
  );
  for (const declaredClass of ENVELOPE.dimensions.debt_instruments.declared_matrix) {
    const lane = ENVELOPE.dimensions.debt_instruments.declared_matrix_lanes[declaredClass];
    assert.ok(
      lane && ENVELOPE.dimensions.debt_instruments.declared_lanes[lane],
      `${declaredClass} names no declared lane`,
    );
  }
  // And the mismatch is not that leases are unsupported: they are compiled by
  // their OWN lane, which reserves the very id the register would collide with.
  assert.ok(
    /lease_liability is reserved for the separately identified lease state family/.test(guardSource),
    "the lease lane no longer reserves the lease_liability identity",
  );
  const leaseLane = coercionCase(CLEAN_BASIS);
  // The maintained fixture's own lease policy, so the lane is exercised in the
  // shape the product actually ships.
  leaseLane.lease_policy = readJson("test-fixtures", "cases", "standard-maximal-v2.json")
    .lease_policy;
  let laneStates = null;
  try {
    laneStates = compileInstrumentPeriodState(leaseLane).states.filter(
      (state) => state.family === "lease",
    );
  } catch (error) {
    laneStates = { error: error.message };
  }
  assert.ok(
    Array.isArray(laneStates),
    `the lease_policy lane must compile leases, got ${JSON.stringify(laneStates)}`,
  );
  assert.equal(laneStates.length, 3, "the lease lane must emit one state per forecast period");
  for (const state of laneStates) {
    assert.equal(state.class, "lease_liability");
  }
});

console.log(JSON.stringify({ status: "PASS", checks, mutations_total, mutations_caught }));
