// The REVIEW gate: the last look before a workbook is delivered.
//
// Position in the flow: after BUILD AND CHECKS clears its automated gates and
// before the delivery stage runs. The gate is DISPLAY-ONLY by construction —
// it writes no stage receipt, owns no milestone, and changes no artifact. It
// renders what already exists (the plain-English read, the headline numbers,
// how much of the model is broker-sourced, the stated assumptions) and blocks
// until the user replies exactly one of:
//
//     deliver   - the run continues into the ordinary delivery stage unchanged
//     change    - the run stops without delivering; the complaint is recorded
//                 and the change invalidates from the model decisions onward
//
// The fail-closed absolute: this gate has exactly two exits. It can proceed to
// delivery on an explicit `deliver`, or it can invalidate earlier (never
// later). Anything else — no reply, an unrecognised reply, both replies at
// once — leaves the run blocked at the gate.

import { solveCase } from "./solver.mjs";
import { buildDeliveryReport } from "./flow_read.mjs";

/** The only reply that lets the run proceed past the gate. */
export const REVIEW_DELIVER_REPLY = "deliver";
/** Any explicit reply other than `deliver` is a change request. */
export const REVIEW_CHANGE_REPLY = "change";
export const REVIEW_SCHEMA_VERSION = "flow-review/1.0";

function headlineRows(solved, currency) {
  const years = solved?.forecast ?? [];
  return years.map((year) => ({
    period: String(year.period ?? "").slice(0, 4),
    net_debt: year.net_debt ?? null,
    net_leverage: year.net_leverage ?? null,
    total_liquidity: year.total_liquidity ?? null,
    rcf_drawn: year.ending_rcf ?? null,
    currency,
  }));
}

/**
 * Assemble the review brief from artifacts that already exist. Solves the
 * answered case (pure, deterministic — the delivery stage re-solves the same
 * case through its own unchanged path) and reads it the way delivery will.
 */
export function compileReviewBriefing({
  modelCase,
  assumptions = [],
  quality = null,
}) {
  const solved = solveCase(modelCase);
  const report = buildDeliveryReport({ modelCase, solved, assumptions });
  const currency = modelCase?.issuer?.reporting_currency ?? null;
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    issuer: modelCase?.issuer?.name ?? "Issuer",
    reporting_currency: currency,
    periods: (modelCase?.periods ?? [])
      .filter((period) => period?.status === "forecast")
      .map((period) => String(period.date ?? "").slice(0, 4)),
    read: report.read,
    headline: headlineRows(solved, currency),
    quality,
    top_assumptions: report.assumed.slice(0, 5),
    plausible_only: report.plausible_only.slice(0, 5),
  };
}

/**
 * Quality mode for the review screen, from the broker preview the run already
 * selected. VERIFIED: a coherent primary house was selected and nothing was
 * set aside. DEGRADED: the forecast falls back to company evidence and
 * history, or cells failed their checks. Plain words; no policy vocabulary.
 */
export function reviewQualityFrom({ brokerPreview = null } = {}) {
  if (!brokerPreview) {
    return Object.freeze({
      mode: "NOT ASSESSED",
      detail: "No broker research was supplied; the forecast runs on company evidence and history.",
    });
  }
  const quarantined = Number(brokerPreview?.evidence_inventory?.quarantined_cell_count ?? 0);
  const waterfall = brokerPreview?.selection_mode === "forecast_waterfall";
  if (!waterfall && brokerPreview?.status === "PASS" && quarantined === 0) {
    return Object.freeze({
      mode: "VERIFIED",
      detail: "Every forecast number traces to its stated source.",
    });
  }
  return Object.freeze({
    mode: "DEGRADED",
    detail: waterfall
      ? "No single broker house covered the forecast cleanly, so numbers fall back to company evidence and history in a fixed order."
      : "Some broker values failed their checks and were left out; the affected numbers fall back to company evidence and history.",
  });
}

/**
 * Resolve the gate's reply from the controller flags. Exactly one of
 * `--review-deliver` / `--review-change <text|path>` may be supplied; neither
 * means the gate blocks. Returns one of:
 *   { mode: "blocked" }
 *   { mode: "deliver" }
 *   { mode: "change", complaint }
 * and throws on an ambiguous invocation rather than picking a branch.
 */
export function resolveReviewReply({ reviewDeliver = false, reviewChange = null } = {}) {
  if (reviewDeliver && reviewChange !== null && reviewChange !== undefined) {
    throw new Error(
      "The review gate takes one reply, not two: pass --review-deliver or --review-change, never both.",
    );
  }
  if (reviewDeliver) return { mode: "deliver" };
  if (typeof reviewChange === "string" && reviewChange.trim() !== "") {
    return { mode: "change", complaint: reviewChange.trim() };
  }
  if (reviewChange === true) {
    throw new Error(
      "--review-change needs the complaint in words, e.g. --review-change \"the FY3 growth assumption is too aggressive\".",
    );
  }
  return { mode: "blocked" };
}
