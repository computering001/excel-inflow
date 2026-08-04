// Stage 2 — the filings side, and the reconciliation stop: the one other way
// the flow comes back to the user.
//
// WHAT USED TO BE HERE AND IS NOT ANY MORE
//
//   Stage-1 shape validation. `validateIntakeShape` was a second, weaker N0
//   living beside the real one. `scripts/lib/intake.mjs` is N0 and is the only
//   N0; everything this file used to check about the uploads is checked there,
//   against the declared `dcs-export.schema.json` / `broker-pack.schema.json`
//   contracts and with a `remedy` on every finding. The one check that was
//   genuinely only here — the company name — moved into intake.mjs rather than
//   being dropped.
//
//   Entity matching. Moved to `flow_entity.mjs`, which N2 owns. See the header
//   there for why N0 cannot do it.
//
//   The DCS export adapter. There is now ONE vocabulary: the one
//   `assets/dcs-export.schema.json` declares. `intake.export` carries
//   `instruments[]` with `outstanding_amount`, `next_call_date`,
//   `facility_limit`, `as_of` and `entity.name`, and every consumer reads those
//   names. The two derivations the adapter used to perform are still needed and
//   are still here — `outstandingAmount` and `includedInGrossDebt` — but they
//   are named computations over the authoritative shape, not a rename of it.
//
// THE ORDERING with entity matching is load-bearing and belongs to the caller:
// entity is checked BEFORE the residual is diagnosed, because an export for the
// predecessor entity produces a residual that looks exactly like a date problem
// and is not.

import { formatMoney, renderReconciliationScreen } from "./flow_screens.mjs";

// ── reading the authoritative export shape ─────────────────────────────────

/**
 * What an export row contributes to gross debt.
 *
 * For a revolver, `outstanding_amount` and `drawn_amount` are the same number
 * and the schema carries both so that a file populating only one is still
 * usable. `drawn_amount` wins where the two disagree, because the facility
 * SIZE has its own field and a revolver's contribution to debt is what is
 * actually drawn on it.
 */
export function outstandingAmount(instrument) {
  if (instrument?.instrument_type === "rcf") {
    return Number(instrument.drawn_amount ?? instrument.outstanding_amount ?? 0);
  }
  return Number(instrument?.outstanding_amount ?? 0);
}

/**
 * model-case-v2 derives include_in_gross_debt from the instrument class;
 * `debt_classification` in the export is the override for the rows where the
 * filing's own definition differs. Default true, per the schema.
 */
export function includedInGrossDebt(instrument) {
  return instrument?.debt_classification?.include_in_gross_debt ?? true;
}

/** The instrument rows of an intake bundle, in the authoritative vocabulary. */
export function exportInstruments(intake) {
  const rows = intake?.export?.instruments;
  return Array.isArray(rows) ? rows : [];
}

// ── stage 2: the filings, which are not a stage-1 input ────────────────────

/**
 * N2's own shape gate.
 *
 * These three checks used to sit inside stage-1 shape validation, where they
 * were wrong: the filings are read at N2, so demanding them at N0 would fail an
 * intake that is perfectly good. They are not dropped — they are asserted at
 * the node that actually consumes them, which is where a failure is
 * actionable.
 */
export function validateFilings(intake) {
  const errors = [];
  const filings = intake?.filings;
  if (!filings) {
    errors.push(
      "No filings were read. The audited totals — reported gross debt, cash, " +
        "reported gross interest — come from the filings and from nowhere else; " +
        "the export is never authoritative for them.",
    );
    return { ok: false, errors };
  }
  if (filings.reported_gross_debt === undefined || filings.reported_gross_debt === null) {
    errors.push(
      "The filings do not give reported gross debt. Instruments from the export " +
        "must foot to it, so without it there is nothing to reconcile against and " +
        "a partial export cannot announce itself.",
    );
  }
  if (!filings.fiscal_year_end_date) {
    errors.push(
      "The filings do not give a fiscal year end date, so I cannot tell whether " +
        "the export's as-at date is the last reported period end.",
    );
  }
  return { ok: errors.length === 0, errors };
}

// ── stage 2: the reconciliation ────────────────────────────────────────────

export function fiscalLabel(filings) {
  if (filings?.fiscal_label) return filings.fiscal_label;
  const year = String(filings?.fiscal_year_end_date ?? "").slice(2, 4);
  return year ? `FY${year}` : "the";
}

/**
 * Instruments from the export must foot to reported gross debt in the filing.
 * Where they do not, the residual gets its own line and is never absorbed
 * silently. A stale or partial export then announces itself as a large
 * unexplained residual instead of producing a model that looks complete and is
 * wrong.
 */
export function reconcileExport(intake, { maximumResidualPercentage } = {}) {
  const rows = exportInstruments(intake);
  const exportTotal = rows
    .filter((row) => includedInGrossDebt(row))
    .reduce((total, row) => total + outstandingAmount(row), 0);
  const reported = Number(intake?.filings?.reported_gross_debt ?? 0);
  const residual = reported - exportTotal;
  const tolerance =
    maximumResidualPercentage ??
    Number(intake?.filings?.maximum_residual_percentage ?? 0.01);
  const limit = Math.abs(reported) * tolerance;
  const reconciles = Math.abs(residual) <= limit;

  const exportDate = intake?.export?.as_of ?? null;
  const yearEnd = intake?.filings?.fiscal_year_end_date ?? null;
  const dateMismatch = Boolean(exportDate && yearEnd && exportDate !== yearEnd);

  return {
    export_total: exportTotal,
    reported_gross_debt: reported,
    residual,
    residual_percentage: reported === 0 ? null : Math.abs(residual) / Math.abs(reported),
    tolerance,
    limit,
    reconciles,
    date_mismatch: dateMismatch,
    export_as_of_date: exportDate,
    fiscal_year_end_date: yearEnd,
    fiscal_label: fiscalLabel(intake?.filings),
  };
}

export function reconciliationStop(intake, options = {}) {
  const result = reconcileExport(intake, options);
  // A DATE MISMATCH STOPS EVEN WHEN THE RESIDUAL IS SMALL.
  //
  // This is the merge of two checks that each caught half the fault. The
  // residual test catches a stale export whose balances have moved; N0's
  // as_of assertion catches one whose balances happen not to have. Neither
  // alone is sufficient: an export struck three weeks after year end on a
  // company that issued nothing in between foots to the accounts and is still
  // the wrong file, and the model built from it would look complete and be
  // wrong for reasons nobody could find later. Reconciling is evidence, not
  // proof; the declared date is the proof.
  if (result.reconciles && !result.date_mismatch) return { stop: false, ...result };
  const label = result.fiscal_label;
  const diagnosis = result.date_mismatch
    ? result.reconciles
      ? `The export is struck at ${result.export_as_of_date}, not ${label} year end. It happens to foot within tolerance, but balances at the wrong date are the wrong balances — a company that issued or repaid nothing in the gap is indistinguishable here from one whose export is simply correct.`
      : `Too large for accrued interest or fees. The export was taken at ${result.export_as_of_date}, not ${label} year end.`
    : `Too large for accrued interest or fees. The export is probably a summary rather than the full DCS debt detail.`;
  return {
    stop: true,
    ...result,
    diagnosis,
    screen: renderReconciliationScreen({
      export_total: result.export_total,
      reported_gross_debt: result.reported_gross_debt,
      residual: result.residual,
      fiscal_label: label,
      diagnosis,
      options: [
        `I'll re-export from FactSet at ${label} year end`,
      ],
    }),
  };
}
