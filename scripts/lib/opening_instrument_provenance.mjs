/**
 * P4.1 — the opening instrument source inventory.
 *
 * The GAP this closes: a source inventory existed only for the DCS lane
 * (dcs-source-tables → dcs-candidate-manifest → dcs-crosswalk, where every
 * candidate row and cell carries a typed disposition and a rationale, and
 * unowned cells are a hard zero). At the model lane's opening-debt boundary
 * there was nothing: `compileOpeningInstrumentState` emitted rows with no
 * candidate ids, no source-row refs and no crosswalk binding, and a register
 * row that was skipped — a duplicate instrument id, an untranslatable
 * currency, a blank opening balance — simply vanished from the compiled state
 * behind a prose string in `errors`. Nothing named the rejected candidates and
 * nothing could reproduce the selection.
 *
 * This module is a PURE COMPILER AND VALIDATOR over that boundary. It mints
 * candidate ids, records the source rows considered, records which candidate
 * was selected and why, registers every rejected candidate with a TYPED
 * reason, and seals the whole inventory under a digest — the ledger discipline
 * of forecast_authority_ledger.mjs (entry schema, sealing, digest) applied to
 * the opening-debt register.
 *
 * Invariants:
 *  - the candidate universe is EVERY declared register row, at its contiguous
 *    register position — a candidate cannot be dropped from the inventory;
 *  - every candidate is EXACTLY ONE of selected or registered not-selected;
 *  - every not-selected reason comes from the sealed vocabulary below, with a
 *    non-empty detail; an untyped rejection is a validation error, never a
 *    silent drop;
 *  - the selection REPLAYS from the recorded provenance alone
 *    (`replayOpeningInstrumentSelection` reads the inventory and nothing else);
 *  - a missing, blank or unparseable declared amount is a TYPED never-zero
 *    state from the sealed P1.2 vocabulary — never a zero row;
 *  - this module VALIDATES; it never repairs and never substitutes a number.
 */

import { canonicalJson, hashValue } from "./run_store.mjs";
import { numericValueOf, typedValue } from "./typed_financial_value.mjs";

export const OPENING_INSTRUMENT_PROVENANCE_SCHEMA_VERSION =
  "opening-instrument-provenance/1.0";

/**
 * Declared precedence for the SOURCE-CELL evidence behind one instrument's
 * opening balance. The compiler always reads `instruments[i].opening_balance`;
 * these are the upstream DCS projection fields that produced it, in the exact
 * order `projectDcsInstrument` consumes them (outstanding_amount ?? drawn_amount).
 * First match wins; every later match is registered not-selected as
 * `superseded_by_declared_precedence` so the losing evidence is still named.
 * `opening_balance` is the case-lane self-citation used when no DCS term
 * authority exists for the instrument.
 */
export const OPENING_BALANCE_AUTHORITY_PRECEDENCE = Object.freeze([
  "outstanding_amount",
  "drawn_amount",
  "opening_balance",
]);

/**
 * The ONLY reasons an opening-instrument candidate may be registered
 * not-selected. Every rejection site in the opening-state compiler maps here;
 * `unresolved_compile_defect` is the typed fallback that keeps a NEW throw
 * from ever becoming an untyped silent drop (repair: type that throw).
 */
export const OPENING_INSTRUMENT_NOT_SELECTED_REASONS = Object.freeze([
  "duplicate_instrument_id",
  "instrument_record_malformed",
  "balance_basis_not_declared",
  "opening_balance_unresolved",
  "opening_balance_negative",
  "translation_authority_absent",
  "translation_rate_not_positive",
  "superseded_by_declared_precedence",
  "forecast_boundary_absent",
  "unresolved_compile_defect",
]);

export const OPENING_INSTRUMENT_SOURCE_LANES = Object.freeze([
  "case_instrument_register",
  "dcs_evidence_v1",
]);

const AMOUNT_EPSILON = 1e-9;

/** Deterministic candidate id: the register position plus the declared id. */
export function mintOpeningCandidateId(ordinal, instrumentId) {
  const position = String(Number(ordinal)).padStart(3, "0");
  const id = instrumentId === null || instrumentId === undefined || instrumentId === ""
    ? "(absent-instrument-id)"
    : String(instrumentId);
  return `oi.${position}.${id}`;
}

/**
 * The typed reading of a declared opening balance. Missing, nil, blank and
 * unparseable are DISTINCT never-zero states — none of them is zero.
 */
export function typedDeclaredAmount(raw) {
  if (raw === undefined) return typedValue("missing");
  if (raw === null) return typedValue("nil", { raw_text: "null" });
  if (raw === "") return typedValue("reported_blank");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return typedValue("parse_failure", {
      raw_text: String(raw),
      failure_reason: "declared opening balance is not a finite number",
    });
  }
  if (parsed === 0) return typedValue("reported_zero", { value: 0, raw_text: String(raw) });
  return typedValue("reported_number", { value: parsed, raw_text: String(raw) });
}

/**
 * Type a rejection raised inside the opening-state compiler. Reasons carried
 * on the error win; otherwise the shared helpers' exact messages are mapped.
 * Anything unmapped becomes `unresolved_compile_defect` — typed, named and
 * visible, rather than an untyped disappearance.
 */
export function classifyOpeningRejection(error) {
  if (error?.opening_candidate_reason) {
    if (!OPENING_INSTRUMENT_NOT_SELECTED_REASONS.includes(error.opening_candidate_reason)) {
      return "unresolved_compile_defect";
    }
    return error.opening_candidate_reason;
  }
  const message = String(error?.message ?? error ?? "");
  if (/must be positive/.test(message) && /FX rate/.test(message)) {
    return "translation_rate_not_positive";
  }
  if (
    /Missing FX assumptions for/.test(message) ||
    /Missing (average|period_end) FX rate/.test(message) ||
    /Unsupported FX quote convention/.test(message)
  ) {
    return "translation_authority_absent";
  }
  if (/balance_basis must be explicit/.test(message)) return "balance_basis_not_declared";
  if (/opening_balance must be non-negative/.test(message)) return "opening_balance_negative";
  if (/opening_balance must be numeric/.test(message)) return "opening_balance_unresolved";
  if (/Cannot read properties of|is not an object/.test(message)) {
    return "instrument_record_malformed";
  }
  return "unresolved_compile_defect";
}

/** Attach a typed rejection reason to an error the compiler raises itself. */
export function openingRejection(reason, message) {
  const error = new Error(message);
  error.opening_candidate_reason = reason;
  return error;
}

/**
 * Resolve the source-cell evidence behind one instrument's opening balance.
 * Returns the SELECTED authority plus every superseded authority, so the
 * losing evidence is registered rather than dropped.
 */
export function resolveOpeningBalanceAuthority(termAuthorities, instrumentId) {
  const declared = (termAuthorities ?? []).filter(
    (authority) =>
      authority?.instrument_id === instrumentId &&
      OPENING_BALANCE_AUTHORITY_PRECEDENCE.includes(String(authority?.model_field)),
  );
  const ordered = declared
    .map((authority) => ({
      model_field: String(authority.model_field),
      source_cells: [...(authority.source_cells ?? [])].map(String),
      authority_kind: authority.authority_kind ?? null,
      precision: authority.precision ?? null,
      rank: OPENING_BALANCE_AUTHORITY_PRECEDENCE.indexOf(String(authority.model_field)),
    }))
    .sort((left, right) => left.rank - right.rank || left.model_field.localeCompare(right.model_field));
  if (ordered.length === 0) {
    return {
      considered_model_fields: ["opening_balance"],
      selected: {
        model_field: "opening_balance",
        source_cells: [],
        authority_kind: "declared_register_field",
        precision: "exact",
      },
      not_selected: [],
    };
  }
  const [winner, ...losers] = ordered;
  return {
    considered_model_fields: ordered.map((entry) => entry.model_field),
    selected: {
      model_field: winner.model_field,
      source_cells: winner.source_cells,
      authority_kind: winner.authority_kind,
      precision: winner.precision,
    },
    not_selected: losers.map((entry) => ({
      model_field: entry.model_field,
      source_cells: entry.source_cells,
      reason: "superseded_by_declared_precedence",
      detail:
        `${entry.model_field} is lower precedence than ${winner.model_field} for the ` +
        "opening-balance basis amount; it is evidence, not the selected authority.",
    })),
  };
}

/** The lane and crosswalk binding for one case's instrument register. */
export function openingInstrumentSourceLane(modelCase) {
  const authorities = modelCase?.instrument_term_authorities;
  const bound = Array.isArray(authorities) && authorities.length > 0;
  return {
    source_lane:
      modelCase?.instrument_authority_contract_version === "dcs_evidence_v1"
        ? "dcs_evidence_v1"
        : "case_instrument_register",
    // A case with no field-level authority set has NO crosswalk. Recording a
    // hash of nothing would be a fabricated binding; null is the honest value.
    term_authority_crosswalk_sha256: bound ? hashValue(authorities) : null,
  };
}

/**
 * Build the pre-selection candidate record for one register position.
 *
 * Every declared register row becomes a candidate at its own ordinal BEFORE
 * anything is decided about it, so the universe cannot lose a row: a candidate
 * starts `not_selected` with no reason and the compiler must either select it
 * or register a typed rejection.
 */
export function openingInstrumentCandidateRecord({
  ordinal,
  instrument,
  sourceLane,
  termAuthorities = [],
}) {
  const instrumentId = instrument?.instrument_id ?? null;
  const authority = resolveOpeningBalanceAuthority(termAuthorities, instrumentId);
  const declaredSourceLineIds = Array.isArray(instrument?.source_line_ids)
    ? instrument.source_line_ids.map(String)
    : [];
  return {
    candidate_id: mintOpeningCandidateId(ordinal, instrumentId),
    ordinal: Number(ordinal),
    instrument_id: instrumentId,
    source_lane: sourceLane,
    // WHERE it came from: the register position always, plus the DCS source
    // cells behind the selected opening-balance authority and any declared
    // upstream source line ids.
    source_row_refs: [
      instrumentId === null
        ? `instruments[${ordinal}]`
        : `instruments[${ordinal}].${instrumentId}`,
      ...authority.selected.source_cells,
      ...declaredSourceLineIds,
    ],
    source_line_ids: declaredSourceLineIds,
    declared: {
      opening_balance: typedDeclaredAmount(instrument?.opening_balance),
      balance_basis: instrument?.balance_basis ?? null,
      currency: instrument?.currency ?? null,
      class: instrument?.class ?? null,
      include_in_gross_debt: instrument?.include_in_gross_debt !== false,
      is_residual_pool: instrument?.is_residual_pool === true,
    },
    opening_balance_authority_fields: authority.considered_model_fields,
    opening_balance_authority: authority.selected,
    not_selected_field_authorities: authority.not_selected,
    outcome: "not_selected",
    selection: null,
    not_selected: null,
  };
}

/** Seal an inventory body under its own canonical digest (ledger discipline). */
export function sealOpeningInstrumentSourceInventory(body) {
  const { inventory_sha256: _ignored, ...bare } = body ?? {};
  return { ...bare, inventory_sha256: hashValue(bare) };
}

/**
 * Reproduce the selection from the recorded provenance ALONE.
 *
 * This function reads the inventory and NOTHING else — no model case, no FX
 * block, no instrument register. If its output matches the compiled rows, the
 * recorded provenance is genuinely sufficient to reproduce the selection.
 */
export function replayOpeningInstrumentSelection(inventory) {
  const candidates = [...(inventory?.candidates ?? [])].sort(
    (left, right) => Number(left.ordinal) - Number(right.ordinal),
  );
  const rows = [];
  for (const candidate of candidates) {
    if (candidate.outcome !== "selected") continue;
    const selection = candidate.selection ?? {};
    const basisAmount = Number(selection.basis_amount);
    const rate = Number(selection.translation_rate);
    rows.push({
      instrument_id: candidate.instrument_id,
      candidate_id: candidate.candidate_id,
      basis_amount: basisAmount,
      basis_currency: selection.basis_currency ?? null,
      translation_rate: rate,
      translation_method: selection.translation_method ?? null,
      // RECOMPUTED from the recorded basis and rate — not copied from the
      // record, so a fabricated reporting amount cannot replay.
      reporting_amount: basisAmount * rate,
      include_in_gross_debt: selection.include_in_gross_debt === true,
    });
  }
  const reportingTotal = rows
    .filter((row) => row.include_in_gross_debt)
    .reduce((total, row) => total + row.reporting_amount, 0);
  return { rows, reporting_total: reportingTotal };
}

function amountsAgree(left, right) {
  const scale = Math.max(1, Math.abs(Number(left)), Math.abs(Number(right)));
  return Math.abs(Number(left) - Number(right)) <= AMOUNT_EPSILON * scale;
}

/**
 * Validate one opening-instrument state's source inventory.
 *
 * Returns error strings (empty = valid). It VALIDATES ONLY: a state that fails
 * here is reported, never rewritten.
 */
export function validateOpeningInstrumentProvenance(state) {
  const errors = [];
  const inventory = state?.source_inventory;
  if (!inventory || typeof inventory !== "object") {
    errors.push("The opening instrument state carries no source_inventory.");
    return errors;
  }
  if (inventory.schema_version !== OPENING_INSTRUMENT_PROVENANCE_SCHEMA_VERSION) {
    errors.push(
      `source_inventory.schema_version must be ${OPENING_INSTRUMENT_PROVENANCE_SCHEMA_VERSION}.`,
    );
  }
  if (!OPENING_INSTRUMENT_SOURCE_LANES.includes(inventory.source_lane)) {
    errors.push(`source_inventory.source_lane ${inventory.source_lane} is not a declared lane.`);
  }
  const crosswalk = inventory.term_authority_crosswalk_sha256;
  if (crosswalk !== null && !/^[0-9a-f]{64}$/.test(String(crosswalk ?? ""))) {
    errors.push(
      "source_inventory.term_authority_crosswalk_sha256 must be a sha256 digest or null; a blank binding is not a hash.",
    );
  }
  if (inventory.source_lane === "dcs_evidence_v1" && crosswalk === null) {
    errors.push(
      "The dcs_evidence_v1 lane must bind the inventory to a term-authority crosswalk digest.",
    );
  }
  const { inventory_sha256: storedDigest, ...body } = inventory;
  const expectedDigest = sealOpeningInstrumentSourceInventory(body).inventory_sha256;
  if (storedDigest !== expectedDigest) {
    errors.push(
      `source_inventory digest drift: recorded ${storedDigest}, recomputed ${expectedDigest}.`,
    );
  }

  const candidates = Array.isArray(inventory.candidates) ? inventory.candidates : [];
  if (candidates.length !== Number(inventory.candidate_universe_count)) {
    errors.push(
      `source_inventory records ${inventory.candidate_universe_count} candidates but carries ${candidates.length}.`,
    );
  }
  const ordinals = candidates.map((candidate) => Number(candidate.ordinal));
  const expectedOrdinals = candidates.map((_, index) => index);
  if (canonicalJson([...ordinals].sort((a, b) => a - b)) !== canonicalJson(expectedOrdinals)) {
    errors.push(
      "source_inventory candidate ordinals are not the contiguous register positions; a candidate was dropped from the universe.",
    );
  }
  const seenIds = new Set();
  for (const candidate of candidates) {
    const id = candidate?.candidate_id;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`Candidate at ordinal ${candidate?.ordinal} has no candidate_id.`);
      continue;
    }
    if (seenIds.has(id)) errors.push(`Duplicate candidate_id ${id}.`);
    seenIds.add(id);
    if (!["selected", "not_selected"].includes(candidate.outcome)) {
      errors.push(`${id} carries no selected/not_selected outcome.`);
    }
    // A declared amount is a typed value in the sealed vocabulary — reading it
    // must never coerce absence into zero.
    try {
      numericValueOf(candidate.declared?.opening_balance);
    } catch (error) {
      errors.push(`${id} declared.opening_balance is not a typed value: ${error.message}`);
    }
    const authorityFields = Array.isArray(candidate.opening_balance_authority_fields)
      ? candidate.opening_balance_authority_fields.map(String)
      : [];
    const accountedFields = new Set(
      [
        candidate.opening_balance_authority?.model_field,
        ...(candidate.not_selected_field_authorities ?? []).map((entry) => entry?.model_field),
      ]
        .filter((field) => field !== undefined && field !== null)
        .map(String),
    );
    const unaccounted = authorityFields.filter((field) => !accountedFields.has(field));
    if (unaccounted.length > 0) {
      errors.push(
        `${id} considered opening-balance authorities ${unaccounted.join(", ")} but neither selected nor registered them.`,
      );
    }
    for (const entry of candidate.not_selected_field_authorities ?? []) {
      if (!OPENING_INSTRUMENT_NOT_SELECTED_REASONS.includes(entry?.reason)) {
        errors.push(
          `${id} field authority ${entry?.model_field} carries untyped reason ${entry?.reason}.`,
        );
      }
    }
    if (candidate.outcome === "selected") {
      const refs = Array.isArray(candidate.source_row_refs) ? candidate.source_row_refs : [];
      if (refs.length === 0) {
        errors.push(`${id} was selected but names no source row.`);
      }
      const selection = candidate.selection;
      if (!selection || typeof selection !== "object") {
        errors.push(`${id} was selected but records no selection.`);
      } else {
        for (const field of ["basis_amount", "translation_rate", "reporting_amount"]) {
          if (!Number.isFinite(Number(selection[field]))) {
            errors.push(`${id} selection.${field} is not a finite number.`);
          }
        }
        if (
          Number.isFinite(Number(selection.basis_amount)) &&
          Number.isFinite(Number(selection.translation_rate)) &&
          Number.isFinite(Number(selection.reporting_amount)) &&
          !amountsAgree(
            Number(selection.basis_amount) * Number(selection.translation_rate),
            Number(selection.reporting_amount),
          )
        ) {
          errors.push(
            `${id} recorded reporting amount ${selection.reporting_amount} is not its recorded basis times its recorded rate.`,
          );
        }
        if (typeof selection.basis_field_ref !== "string" || selection.basis_field_ref.length === 0) {
          errors.push(`${id} selection names no basis field.`);
        }
        if (
          typeof selection.translation_source_ref !== "string" ||
          selection.translation_source_ref.length === 0
        ) {
          errors.push(`${id} selection names no translation authority.`);
        }
      }
    } else if (candidate.outcome === "not_selected") {
      const reason = candidate.not_selected?.reason;
      if (!OPENING_INSTRUMENT_NOT_SELECTED_REASONS.includes(reason)) {
        errors.push(`${id} carries untyped not-selected reason ${reason}.`);
      }
      if (candidate.selection !== null && candidate.selection !== undefined) {
        errors.push(`${id} was not selected but still records a selection.`);
      }
    }
  }

  const selectedIds = Array.isArray(inventory.selected_candidate_ids)
    ? inventory.selected_candidate_ids.map(String)
    : [];
  const register = Array.isArray(inventory.not_selected) ? inventory.not_selected : [];
  const registerIds = new Set(register.map((entry) => String(entry?.candidate_id)));
  const selectedSet = new Set(selectedIds);
  for (const candidate of candidates) {
    const id = String(candidate?.candidate_id);
    const claimedSelected = selectedSet.has(id);
    const claimedRejected = registerIds.has(id);
    if (candidate.outcome === "selected" && !claimedSelected) {
      errors.push(`${id} is selected but absent from selected_candidate_ids.`);
    }
    if (candidate.outcome === "not_selected" && !claimedRejected) {
      errors.push(
        `${id} was rejected but is absent from the not-selected register; every rejected candidate must be named.`,
      );
    }
    if (claimedSelected && claimedRejected) {
      errors.push(`${id} is claimed by both the selected list and the not-selected register.`);
    }
  }
  for (const entry of register) {
    if (!OPENING_INSTRUMENT_NOT_SELECTED_REASONS.includes(entry?.reason)) {
      errors.push(
        `Not-selected register entry ${entry?.candidate_id} carries untyped reason ${entry?.reason}.`,
      );
    }
    if (typeof entry?.detail !== "string" || entry.detail.trim().length === 0) {
      errors.push(`Not-selected register entry ${entry?.candidate_id} carries no detail.`);
    }
    if (!seenIds.has(String(entry?.candidate_id))) {
      errors.push(
        `Not-selected register entry ${entry?.candidate_id} is not a candidate in the universe.`,
      );
    }
  }
  if (selectedIds.length + registerIds.size !== candidates.length) {
    errors.push(
      `The selected list (${selectedIds.length}) and not-selected register (${registerIds.size}) do not partition the ${candidates.length} candidates.`,
    );
  }

  // Reproducibility: the compiled rows must be exactly what the recorded
  // provenance replays, and every row must point back at a candidate.
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  const candidateById = new Map(candidates.map((candidate) => [String(candidate.candidate_id), candidate]));
  for (const row of rows) {
    const provenance = row?.provenance;
    if (!provenance || typeof provenance !== "object") {
      errors.push(`${row?.instrument_id} carries no provenance record.`);
      continue;
    }
    const candidate = candidateById.get(String(provenance.candidate_id));
    if (!candidate) {
      errors.push(
        `${row.instrument_id} provenance names candidate ${provenance.candidate_id}, which is not in the universe.`,
      );
      continue;
    }
    if (candidate.outcome !== "selected") {
      errors.push(`${row.instrument_id} is a compiled row but its candidate is not selected.`);
    }
    if (
      !Array.isArray(provenance.source_row_refs) ||
      provenance.source_row_refs.length === 0
    ) {
      errors.push(`${row.instrument_id} provenance names no source row.`);
    }
  }
  const replay = replayOpeningInstrumentSelection(inventory);
  if (replay.rows.length !== rows.length) {
    errors.push(
      `The recorded provenance replays ${replay.rows.length} opening rows but the state carries ${rows.length}.`,
    );
  } else {
    for (const [index, replayed] of replay.rows.entries()) {
      const row = rows[index];
      if (replayed.instrument_id !== row.instrument_id) {
        errors.push(
          `Replay position ${index} is ${replayed.instrument_id} but the state carries ${row.instrument_id}.`,
        );
        continue;
      }
      for (const [field, actual] of [
        ["basis_amount", row.basis_amount],
        ["translation_rate", row.translation_rate],
        ["reporting_amount", row.reporting_amount],
      ]) {
        if (!amountsAgree(replayed[field], actual)) {
          errors.push(
            `${row.instrument_id} ${field} does not replay from its provenance: recorded provenance gives ${replayed[field]}, the state carries ${actual}.`,
          );
        }
      }
      if (replayed.include_in_gross_debt !== (row.include_in_gross_debt === true)) {
        errors.push(
          `${row.instrument_id} gross-debt membership does not replay from its provenance.`,
        );
      }
    }
  }
  if (
    state?.reporting_total !== null &&
    state?.reporting_total !== undefined &&
    !amountsAgree(replay.reporting_total, state.reporting_total)
  ) {
    errors.push(
      `The reporting total does not replay from the recorded provenance: ${replay.reporting_total} vs ${state.reporting_total}.`,
    );
  }
  return errors;
}
