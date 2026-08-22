#!/usr/bin/env node
/**
 * P4.1 — opening instrument source inventory.
 *
 * The GAP this suite proves and then guards: a source inventory existed only
 * for the DCS lane. `compileOpeningInstrumentState` carried no source-row
 * provenance, no candidate ids and no crosswalk hash, and there was no
 * NOT-SELECTED register anywhere at the opening-debt boundary — a register row
 * that failed to translate, or was skipped as a duplicate id, simply vanished
 * from the compiled state with only a prose string in `errors`.
 *
 * Invariant asserted here: every opening instrument state records WHERE it came
 * from — the source rows considered (candidate ids), which was selected, and a
 * NOT-SELECTED register naming every rejected candidate with a typed reason —
 * and the selection is REPRODUCIBLE from the recorded provenance alone.
 *
 * Mutations that must be caught:
 *   - a selected instrument with no recorded source;
 *   - a rejected candidate missing from the not-selected register;
 *   - provenance that no longer reproduces the selection.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileOpeningInstrumentState } from "./lib/instrument_period_state.mjs";
import { compileOpeningDebtBridge } from "./lib/opening_debt_bridge.mjs";
import {
  OPENING_BALANCE_AUTHORITY_PRECEDENCE,
  OPENING_INSTRUMENT_NOT_SELECTED_REASONS,
  OPENING_INSTRUMENT_PROVENANCE_SCHEMA_VERSION,
  replayOpeningInstrumentSelection,
  sealOpeningInstrumentSourceInventory,
  validateOpeningInstrumentProvenance,
} from "./lib/opening_instrument_provenance.mjs";
import { numericValueOf } from "./lib/typed_financial_value.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
// Honest mutation accounting: every "mutation:" check applies one real
// defect to a copy of the register and is counted CAUGHT only when
// production refuses it while the mutant is active; a surviving mutant
// rethrows and no count line is printed.
let mutations_total = 0;
let mutations_caught = 0;
const check = (label, fn) => {
  const isMutation = /^mutation:/.test(label);
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

const baseCase = {
  case_id: "opening-instrument-provenance",
  contract_version: 2,
  issuer: { reporting_currency: "GBP", units: "millions" },
  periods,
  statement_structure: { income_statement: [], cash_flow: [] },
  instruments: [
    instrument("gbp_native", { opening_balance: 100 }),
    instrument("eur_native", { currency: "EUR", opening_balance: 200 }),
    instrument("usd_legal_gbp_carrying", {
      currency: "USD",
      balance_basis: "reporting_currency_carrying_value",
      opening_balance: 50,
    }),
    instrument("held_out_of_gross_debt", {
      opening_balance: 25,
      include_in_gross_debt: false,
    }),
  ],
  fx: {
    EUR: {
      quote: "reporting_per_native",
      average_rates: [0.75, 0.78, 0.79, 0.81, 0.82, 0.83],
      period_end_rates: [0.76, 0.79, 0.8, 0.82, 0.83, 0.84],
    },
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
  controls: { debt_maturities_roll: 1, circularity: 1 },
  cash_policy: { opening_cash: 0, minimum_cash: [0, 0, 0] },
  lease_policy: { mode: "exclude" },
  broker_pack: { metrics: {} },
  source_coverage: {},
};

const clone = (value) => structuredClone(value);

// ---------------------------------------------------------------------------
// 1. The GAP assertion itself: the state carries a source inventory.
// ---------------------------------------------------------------------------
const state = compileOpeningInstrumentState(baseCase);

check("state carries a version-stamped source inventory", () => {
  assert.equal(state.status, "PASS");
  assert.equal(
    state.source_inventory?.schema_version,
    OPENING_INSTRUMENT_PROVENANCE_SCHEMA_VERSION,
    "compileOpeningInstrumentState carries no source inventory.",
  );
});

check("every selected row names its candidate id", () => {
  for (const row of state.rows) {
    assert.ok(
      typeof row.provenance?.candidate_id === "string" &&
        row.provenance.candidate_id.length > 0,
      `${row.instrument_id} has no recorded candidate id.`,
    );
  }
});

check("every selected row names at least one source row", () => {
  for (const row of state.rows) {
    assert.ok(
      Array.isArray(row.provenance?.source_row_refs) &&
        row.provenance.source_row_refs.length > 0,
      `${row.instrument_id} records no source rows.`,
    );
    assert.match(
      row.provenance.source_row_refs[0],
      /^instruments\[\d+\]/,
      `${row.instrument_id} source row ref does not name a register position.`,
    );
  }
});

check("the candidate universe is every declared register row", () => {
  const inventory = state.source_inventory;
  assert.equal(inventory.candidate_universe_count, baseCase.instruments.length);
  assert.equal(inventory.candidates.length, baseCase.instruments.length);
  assert.deepEqual(
    inventory.candidates.map((candidate) => candidate.ordinal),
    baseCase.instruments.map((_, index) => index),
    "The candidate ordinals are not the contiguous register positions.",
  );
  assert.equal(
    new Set(inventory.candidates.map((candidate) => candidate.candidate_id)).size,
    inventory.candidates.length,
    "Candidate ids are not unique.",
  );
});

check("selected and not-selected partition the candidate universe", () => {
  const inventory = state.source_inventory;
  const selected = new Set(inventory.selected_candidate_ids);
  const rejected = new Set(inventory.not_selected.map((entry) => entry.candidate_id));
  assert.equal(selected.size + rejected.size, inventory.candidates.length);
  for (const candidate of inventory.candidates) {
    const inSelected = selected.has(candidate.candidate_id);
    const inRejected = rejected.has(candidate.candidate_id);
    assert.ok(
      inSelected !== inRejected,
      `${candidate.candidate_id} is in neither or both registers.`,
    );
  }
  // A row held out of reported gross debt is still a SELECTED opening state —
  // it is a classification move at the bridge, not a rejected candidate.
  assert.ok(selected.has(
    inventory.candidates.find(
      (candidate) => candidate.instrument_id === "held_out_of_gross_debt",
    ).candidate_id,
  ));
});

check("the sealed inventory validates with zero errors", () => {
  assert.deepEqual(validateOpeningInstrumentProvenance(state), []);
});

check("the inventory digest is sealed over its own body", () => {
  const { inventory_sha256: stored, ...body } = state.source_inventory;
  assert.equal(stored, sealOpeningInstrumentSourceInventory(body).inventory_sha256);
  assert.match(stored, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 2. Reproducibility: the selection replays from the provenance ALONE.
// ---------------------------------------------------------------------------
check("the selection replays from the recorded provenance alone", () => {
  // The replay is handed the inventory and NOTHING else — no model case, no FX
  // block, no instrument register. If it reproduces the compiled rows, the
  // provenance is genuinely sufficient.
  const replay = replayOpeningInstrumentSelection(clone(state.source_inventory));
  assert.deepEqual(
    replay.rows.map((row) => row.instrument_id),
    state.rows.map((row) => row.instrument_id),
  );
  for (const [index, row] of replay.rows.entries()) {
    const actual = state.rows[index];
    assert.equal(row.basis_amount, actual.basis_amount);
    assert.equal(row.translation_rate, actual.translation_rate);
    assert.equal(row.reporting_amount, actual.reporting_amount);
    assert.equal(row.include_in_gross_debt, actual.include_in_gross_debt);
  }
  assert.equal(replay.reporting_total, state.reporting_total);
});

check("every not-selected reason is in the typed vocabulary", () => {
  for (const entry of state.source_inventory.not_selected) {
    assert.ok(
      OPENING_INSTRUMENT_NOT_SELECTED_REASONS.includes(entry.reason),
      `${entry.candidate_id} carries untyped reason ${entry.reason}.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. MUTATION — a selected instrument with no recorded source must be caught.
// ---------------------------------------------------------------------------
check("mutation: a selected row with no recorded source is caught", () => {
  const tampered = clone(state);
  delete tampered.rows[0].provenance;
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0, "A selected row without provenance passed.");
  assert.match(errors.join(" | "), /gbp_native/);
  assert.match(errors.join(" | "), /provenance/i);
});

check("mutation: an empty source-row list is caught", () => {
  const tampered = clone(state);
  tampered.rows[1].provenance.source_row_refs = [];
  const inventory = tampered.source_inventory;
  const candidate = inventory.candidates.find(
    (entry) => entry.instrument_id === tampered.rows[1].instrument_id,
  );
  candidate.source_row_refs = [];
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0, "A selected row naming no source row passed.");
  assert.match(errors.join(" | "), /source row/i);
});

// ---------------------------------------------------------------------------
// 4. MUTATION — a rejected candidate missing from the register must be caught.
// ---------------------------------------------------------------------------
const duplicateCase = clone(baseCase);
duplicateCase.instruments.push(instrument("gbp_native", { opening_balance: 999 }));
const duplicateState = compileOpeningInstrumentState(duplicateCase);

check("a duplicate register row is a typed rejected candidate", () => {
  assert.equal(duplicateState.status, "BLOCKED");
  // Behaviour preserved: the legacy error string is byte-identical.
  assert.ok(
    duplicateState.errors.includes(
      "Instrument IDs must be unique; duplicate gbp_native.",
    ),
    "The legacy duplicate-id error string changed.",
  );
  const entry = duplicateState.source_inventory.not_selected.find(
    (item) => item.ordinal === 4,
  );
  assert.equal(entry?.reason, "duplicate_instrument_id");
  assert.equal(entry.instrument_id, "gbp_native");
  assert.ok(entry.detail.length > 0);
  assert.deepEqual(validateOpeningInstrumentProvenance(duplicateState), []);
});

check("mutation: a rejected candidate removed from the register is caught", () => {
  const tampered = clone(duplicateState);
  const removed = tampered.source_inventory.not_selected.pop();
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(
    errors.length > 0,
    "A rejected candidate absent from the not-selected register passed.",
  );
  assert.match(errors.join(" | "), new RegExp(removed.candidate_id.replace(/[.[\]]/g, "\\$&")));
});

check("mutation: a candidate claimed both selected and rejected is caught", () => {
  const tampered = clone(state);
  tampered.source_inventory.not_selected.push({
    candidate_id: tampered.source_inventory.selected_candidate_ids[0],
    instrument_id: tampered.rows[0].instrument_id,
    ordinal: 0,
    reason: "duplicate_instrument_id",
    detail: "fabricated double claim",
  });
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0, "A double-claimed candidate passed.");
});

check("mutation: an alien not-selected reason is caught", () => {
  const tampered = clone(duplicateState);
  tampered.source_inventory.not_selected[0].reason = "looked_wrong_to_me";
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0, "An untyped rejection reason passed.");
  assert.match(errors.join(" | "), /looked_wrong_to_me/);
});

// ---------------------------------------------------------------------------
// 5. MUTATION — provenance must remain sufficient to reproduce the selection.
// ---------------------------------------------------------------------------
check("mutation: a tampered recorded basis amount breaks the replay", () => {
  const tampered = clone(state);
  const candidate = tampered.source_inventory.candidates.find(
    (entry) => entry.instrument_id === "eur_native",
  );
  candidate.selection.basis_amount += 1;
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0, "Provenance that no longer replays passed.");
  assert.match(errors.join(" | "), /eur_native/);
});

check("mutation: a tampered translation rate breaks the replay", () => {
  const tampered = clone(state);
  const candidate = tampered.source_inventory.candidates.find(
    (entry) => entry.instrument_id === "eur_native",
  );
  candidate.selection.translation_rate = 1;
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0, "A fabricated translation rate passed.");
});

check("mutation: a re-sealed tampered inventory is still caught by the digest", () => {
  const tampered = clone(state);
  tampered.source_inventory.candidates[0].selection.basis_amount = 1;
  tampered.source_inventory.inventory_sha256 = "0".repeat(64);
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0);
  assert.match(errors.join(" | "), /digest|sha256/i);
});

// ---------------------------------------------------------------------------
// 6. Typed rejection reasons across every rejection site.
// ---------------------------------------------------------------------------
function rejectionReason(mutate) {
  const mutated = clone(baseCase);
  mutate(mutated);
  const compiled = compileOpeningInstrumentState(mutated);
  assert.deepEqual(
    validateOpeningInstrumentProvenance(compiled),
    [],
    "The rejection path produced an invalid inventory.",
  );
  return { compiled, entries: compiled.source_inventory.not_selected };
}

check("an absent FX pair is typed translation_authority_absent", () => {
  const { compiled, entries } = rejectionReason((value) => {
    delete value.fx.EUR;
  });
  assert.equal(compiled.status, "BLOCKED");
  assert.match(compiled.errors.join(" "), /Missing FX assumptions for EUR/);
  const entry = entries.find((item) => item.instrument_id === "eur_native");
  assert.equal(entry?.reason, "translation_authority_absent");
  assert.ok(
    !compiled.rows.some((row) => row.instrument_id === "eur_native"),
    "An untranslatable instrument still produced an opening row.",
  );
});

check("a blank opening balance is typed unresolved and never zero", () => {
  const { compiled, entries } = rejectionReason((value) => {
    value.instruments[0].opening_balance = null;
  });
  const entry = entries.find((item) => item.instrument_id === "gbp_native");
  assert.equal(entry?.reason, "opening_balance_unresolved");
  const candidate = compiled.source_inventory.candidates.find(
    (item) => item.instrument_id === "gbp_native",
  );
  assert.equal(
    numericValueOf(candidate.declared.opening_balance),
    null,
    "A blank opening balance surfaced as a typed number.",
  );
  assert.notEqual(numericValueOf(candidate.declared.opening_balance), 0);
  assert.equal(candidate.selection, null);
});

check("a negative opening balance is typed opening_balance_negative", () => {
  const { entries } = rejectionReason((value) => {
    value.instruments[0].opening_balance = -5;
  });
  assert.equal(
    entries.find((item) => item.instrument_id === "gbp_native")?.reason,
    "opening_balance_negative",
  );
});

check("an undeclared balance basis is typed balance_basis_not_declared", () => {
  const { entries } = rejectionReason((value) => {
    value.instruments[0].balance_basis = "whatever_the_export_said";
  });
  assert.equal(
    entries.find((item) => item.instrument_id === "gbp_native")?.reason,
    "balance_basis_not_declared",
  );
});

check("a malformed register row is typed instrument_record_malformed", () => {
  const { entries } = rejectionReason((value) => {
    value.instruments.push(null);
  });
  assert.equal(
    entries.find((item) => item.ordinal === 4)?.reason,
    "instrument_record_malformed",
  );
});

check("an absent forecast boundary registers every candidate as rejected", () => {
  const noForecast = clone(baseCase);
  noForecast.periods = periods.filter((period) => period.status === "historical");
  const compiled = compileOpeningInstrumentState(noForecast);
  assert.equal(compiled.status, "BLOCKED");
  assert.deepEqual(compiled.rows, []);
  assert.equal(
    compiled.source_inventory.not_selected.length,
    noForecast.instruments.length,
  );
  for (const entry of compiled.source_inventory.not_selected) {
    assert.equal(entry.reason, "forecast_boundary_absent");
  }
  assert.deepEqual(validateOpeningInstrumentProvenance(compiled), []);
});

// ---------------------------------------------------------------------------
// 7. The DCS term-authority lane: crosswalk hash + field-level candidates.
// ---------------------------------------------------------------------------
const dcsCase = clone(baseCase);
dcsCase.instrument_authority_contract_version = "dcs_evidence_v1";
dcsCase.instrument_term_authorities = [
  {
    instrument_id: "gbp_native",
    model_field: "outstanding_amount",
    output_value: 100,
    source_cells: ["s001!C7"],
    transform: { kind: "direct" },
    authority_kind: "source_cell",
    precision: "exact",
  },
  {
    instrument_id: "gbp_native",
    model_field: "drawn_amount",
    output_value: 100,
    source_cells: ["s001!D7"],
    transform: { kind: "direct" },
    authority_kind: "source_cell",
    precision: "exact",
  },
];
const dcsState = compileOpeningInstrumentState(dcsCase);

check("the DCS lane binds the inventory to a crosswalk digest", () => {
  assert.equal(dcsState.source_inventory.source_lane, "dcs_evidence_v1");
  assert.match(
    dcsState.source_inventory.term_authority_crosswalk_sha256,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    state.source_inventory.term_authority_crosswalk_sha256,
    null,
    "A case with no term authorities fabricated a crosswalk hash.",
  );
  assert.equal(state.source_inventory.source_lane, "case_instrument_register");
});

check("competing field authorities are resolved by declared precedence", () => {
  const candidate = dcsState.source_inventory.candidates.find(
    (entry) => entry.instrument_id === "gbp_native",
  );
  assert.deepEqual(
    candidate.source_row_refs.filter((ref) => ref.includes("!")),
    ["s001!C7"],
    "The selected opening-balance authority does not name its source cells.",
  );
  const superseded = candidate.not_selected_field_authorities;
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].reason, "superseded_by_declared_precedence");
  assert.equal(superseded[0].model_field, "drawn_amount");
  assert.equal(
    OPENING_BALANCE_AUTHORITY_PRECEDENCE.indexOf("outstanding_amount") <
      OPENING_BALANCE_AUTHORITY_PRECEDENCE.indexOf("drawn_amount"),
    true,
  );
  assert.deepEqual(validateOpeningInstrumentProvenance(dcsState), []);
});

check("mutation: a dropped field-authority rejection is caught", () => {
  const tampered = clone(dcsState);
  tampered.source_inventory.candidates.find(
    (entry) => entry.instrument_id === "gbp_native",
  ).not_selected_field_authorities = [];
  const errors = validateOpeningInstrumentProvenance(tampered);
  assert.ok(errors.length > 0, "A dropped field-authority rejection passed.");
  assert.match(errors.join(" | "), /drawn_amount/);
});

// ---------------------------------------------------------------------------
// 8. The provenance is AVAILABLE to the opening-debt bridge (P4.2), unchanged.
// ---------------------------------------------------------------------------
check("every bridge line resolves to a recorded candidate id", () => {
  const bridge = compileOpeningDebtBridge(baseCase, state);
  assert.equal(bridge.verdict, "RECONCILED");
  assert.ok(bridge.lines.length > 0);
  const byInstrument = new Map(
    state.source_inventory.candidates.map((candidate) => [
      candidate.instrument_id,
      candidate.candidate_id,
    ]),
  );
  for (const line of bridge.lines) {
    if (line.instrument_id === null) continue;
    assert.ok(
      byInstrument.has(line.instrument_id),
      `Bridge line ${line.line_kind}/${line.instrument_id} has no candidate id.`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. ADDITIVE ONLY — the maintained fixtures' opening numbers do not move.
// ---------------------------------------------------------------------------
check("the maintained fixtures keep their opening numbers and validate", () => {
  for (const name of ["standard-maximal-v2", "standard-net-cash-v2"]) {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(root, "test-fixtures", "cases", `${name}.json`), "utf8"),
    );
    const compiled = compileOpeningInstrumentState(fixture);
    assert.equal(compiled.status, "PASS", `${name} opening state is not PASS.`);
    assert.deepEqual(
      validateOpeningInstrumentProvenance(compiled),
      [],
      `${name} inventory is invalid.`,
    );
    assert.equal(
      compiled.rows.length,
      fixture.instruments.length,
      `${name} lost or gained an opening row.`,
    );
    const replay = replayOpeningInstrumentSelection(compiled.source_inventory);
    assert.equal(replay.reporting_total, compiled.reporting_total);
    assert.ok(Number.isFinite(compiled.reporting_total));
    for (const row of compiled.rows) {
      assert.ok(row.provenance.source_row_refs.length > 0);
    }
  }
});

check("the maintained fixture opening totals are pinned", () => {
  const maximal = compileOpeningInstrumentState(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "test-fixtures", "cases", "standard-maximal-v2.json"),
        "utf8",
      ),
    ),
  );
  // Pinned pre-change: adding provenance may not move one cent of opening debt.
  // RE-AGREED by E9 (D36 canonicalisation): the naive register-order fold gave
  // 9335.505999999998; canonical summation gives exactly the figure the
  // fixture itself declares (reported_opening_gross_debt, 9335.506) and the
  // bridge's canonical explained_total already carried. The pin moves TO the
  // declared value — toward exactness — not away from it. See
  // references/order-dependence-root-cause.md §5.
  assert.equal(maximal.reporting_total, 9335.506);
  assert.equal(maximal.as_of, "2025-12-31");
  assert.equal(maximal.rows.length, 12);
});

console.log(JSON.stringify({ status: "PASS", checks, mutations_total, mutations_caught }));
