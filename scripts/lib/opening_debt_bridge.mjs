/**
 * P4.2 — Opening-debt reconciliation bridge.
 *
 * The GAP this closes: the opening-debt reconciliation lived as ONE signed
 * residual scalar compared against ONE visible pool row — no schema-validated
 * artifact, no taxonomy, no FX line, years 1-2 asserted invisibly, and the
 * failure surfaced as an untyped BLOCK string rather than the registered
 * terminal reason code.
 *
 * This module is a PURE COMPILER: canonical opening-instrument state + case
 * facts in, one structured bridge artifact out
 * (assets/opening-debt-bridge-v1.schema.json). It validates and decomposes;
 * it never repairs. Missing or blank inputs stay null — an absent reported
 * anchor is not zero, and an untranslatable register is NOT_EVALUABLE rather
 * than a pretended reconciliation.
 *
 * Taxonomy: every explained unit of the reported figure is a line —
 *   instrument_opening   the instrument's own basis amount (native or carrying)
 *   fx_translation       the named period-end translation delta per instrument
 *   classification_move  a register row held OUT of reported gross debt
 *                        (zero bridge contribution, stated visibly)
 *   residual_pool        the declared visible residual pool row
 *   unexplained_residual whatever no source explains — ALWAYS stated as a
 *                        line, and above tolerance it is a typed refusal
 *                        (SOURCE.opening_debt_unresolved), never absorbed.
 */

import { compileOpeningInstrumentState } from "./instrument_period_state.mjs";

export const OPENING_DEBT_BRIDGE_SCHEMA_VERSION = "opening-debt-bridge/1.0";

/** Registered in assets/terminal-reason-registry-v1.json (owner: debt_reconciliation). */
export const OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE =
  "SOURCE.opening_debt_unresolved";

export const OPENING_DEBT_BRIDGE_LINE_KINDS = Object.freeze([
  "instrument_opening",
  "fx_translation",
  "classification_move",
  "residual_pool",
  "unexplained_residual",
]);

// Below this, a difference is floating-point dust from re-summing the same
// doubles, not an economic残; stating it as a line would be noise, not honesty.
const FLOAT_DUST = 1e-9;

function reportedAnchor(modelCase) {
  const declared = modelCase?.debt_reconciliation?.reported_opening_gross_debt;
  if (Array.isArray(declared) && declared.length === 3) {
    const series = declared.map((value) =>
      Number.isFinite(Number(value)) ? Number(value) : null,
    );
    return { form: "series3", series, reported: series[2] };
  }
  if (
    declared !== undefined &&
    declared !== null &&
    declared !== "" &&
    Number.isFinite(Number(declared))
  ) {
    return {
      form: "scalar",
      series: [null, null, Number(declared)],
      reported: Number(declared),
    };
  }
  return { form: "absent", series: [null, null, null], reported: null };
}

function yearRows(anchor) {
  return [0, 1, 2].map((index) => ({
    year_index: index + 1,
    reported: Number.isFinite(anchor.series[index]) ? anchor.series[index] : null,
    basis:
      index === 2
        ? "instrument_register_bridge"
        : anchor.form === "series3"
          ? "asserted_no_instrument_history"
          : "absent",
  }));
}

/**
 * Compile the opening-debt bridge artifact for one model case.
 *
 * @param {object} modelCase   the (shape-valid) model case
 * @param {object} [openingState] optional pre-compiled opening-instrument
 *        state (compileOpeningInstrumentState output) to avoid recompiling
 * @returns the opening-debt-bridge/1.0 artifact; never throws for missing or
 *          untranslatable inputs — those become NO_REPORTED_ANCHOR or
 *          NOT_EVALUABLE verdicts with errors carried on the artifact.
 */
export function compileOpeningDebtBridge(modelCase, openingState = null) {
  const anchor = reportedAnchor(modelCase);
  const artifact = {
    schema_version: OPENING_DEBT_BRIDGE_SCHEMA_VERSION,
    case_id: String(modelCase?.case_id ?? "unknown_case"),
    reporting_currency: modelCase?.issuer?.reporting_currency ?? null,
    as_of: null,
    reported_form: anchor.form,
    lines: [],
    totals: {
      reported_opening_gross_debt: anchor.reported,
      identified_instrument_total: null,
      fx_translation_total: null,
      residual_pool_total: null,
      explained_total: null,
      unexplained_residual: null,
    },
    tolerance: null,
    verdict: "NOT_EVALUABLE",
    refusal: null,
    years: yearRows(anchor),
    errors: [],
  };
  if (anchor.form === "absent") {
    artifact.verdict = "NO_REPORTED_ANCHOR";
    artifact.errors.push(
      "debt_reconciliation.reported_opening_gross_debt is absent; an absent anchor is not zero and nothing can be bridged against it.",
    );
    return artifact;
  }
  let state = openingState;
  if (!state) {
    try {
      state = compileOpeningInstrumentState(modelCase);
    } catch (error) {
      artifact.errors.push(`opening-instrument-state: ${error.message}`);
      return artifact; // NOT_EVALUABLE — coverage owns the structural BLOCK.
    }
  }
  artifact.as_of = state.as_of ?? null;
  artifact.reporting_currency = state.reporting_currency ?? artifact.reporting_currency;
  if (state.status !== "PASS") {
    artifact.errors.push(...(state.errors ?? []));
    if (artifact.errors.length === 0) {
      artifact.errors.push(
        "opening-instrument-state did not PASS and carried no error detail.",
      );
    }
    return artifact; // NOT_EVALUABLE — an untranslatable register cannot bridge.
  }

  const reportingCurrency = state.reporting_currency;
  const lines = [];
  let identifiedTotal = 0;
  let fxTotal = 0;
  let poolTotal = 0;
  for (const row of state.rows) {
    if (!row.include_in_gross_debt) {
      lines.push({
        line_kind: "classification_move",
        instrument_id: row.instrument_id,
        amount: 0,
        currency: reportingCurrency,
        source_ref:
          `instruments[${row.instrument_id}].include_in_gross_debt=false holds ` +
          `${row.reporting_amount} ${reportingCurrency} outside reported gross debt`,
      });
      continue;
    }
    lines.push({
      line_kind: row.is_residual_pool ? "residual_pool" : "instrument_opening",
      instrument_id: row.instrument_id,
      amount: row.basis_amount,
      currency: row.basis_currency,
      source_ref: `instruments[${row.instrument_id}].opening_balance (${row.balance_basis})`,
    });
    if (row.basis_currency !== reportingCurrency) {
      const fxAmount = row.reporting_amount - row.basis_amount;
      lines.push({
        line_kind: "fx_translation",
        instrument_id: row.instrument_id,
        amount: fxAmount,
        currency: reportingCurrency,
        source_ref:
          `1 ${row.basis_currency} = ${row.translation_rate} ${reportingCurrency} ` +
          `period-end at ${state.as_of} (${row.translation_method})`,
      });
      fxTotal += fxAmount;
    }
    if (row.is_residual_pool) poolTotal += row.reporting_amount;
    else identifiedTotal += row.reporting_amount;
  }

  const explainedTotal = identifiedTotal + poolTotal;
  const unexplained = anchor.reported - explainedTotal;
  // Same money tolerance the reconciliation gate applies to a translated sum.
  const tolerance = Math.max(0.01, Math.abs(anchor.reported) * 1e-9);
  if (Math.abs(unexplained) > FLOAT_DUST) {
    lines.push({
      line_kind: "unexplained_residual",
      instrument_id: null,
      amount: unexplained,
      currency: reportingCurrency,
      source_ref:
        "debt_reconciliation.reported_opening_gross_debt less every explained bridge line; no source explains this残",
    });
  }
  artifact.lines = lines;
  artifact.totals = {
    reported_opening_gross_debt: anchor.reported,
    identified_instrument_total: identifiedTotal,
    fx_translation_total: fxTotal,
    residual_pool_total: poolTotal,
    explained_total: explainedTotal,
    unexplained_residual: unexplained,
  };
  artifact.tolerance = tolerance;
  if (Math.abs(unexplained) > tolerance) {
    artifact.verdict = "REFUSE_UNEXPLAINED_RESIDUAL";
    artifact.refusal = {
      reason_code: OPENING_DEBT_BRIDGE_REFUSAL_REASON_CODE,
      unexplained_residual: unexplained,
      tolerance,
    };
  } else {
    artifact.verdict = "RECONCILED";
  }
  return artifact;
}
