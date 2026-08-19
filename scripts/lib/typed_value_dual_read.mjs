/**
 * P1.8 — The explicit dual-read adapter from legacy stored objects to the
 * typed financial value model.
 *
 * Invariant: legacy nullable objects can be read during migration but no new
 * canonical object writes an ambiguous nullable number — and the projection
 * NEVER invents state: a legacy null is `missing` unless the row's own
 * declared vocabulary (historical_authority, value_states, capture marks)
 * says something more precise. Blank/nil/missing never become zero: a legacy
 * literal 0 projects to reported_zero ONLY because the legacy object stored
 * an explicit 0 — silence stays missing.
 */
import { typedValue } from "./typed_financial_value.mjs";

/**
 * Project one legacy statement-row period value into a typed financial
 * value. `periodIndex` 0-2 = historical, 3-5 = forecast.
 */
export function projectLegacyRowValue(row, periodIndex) {
  const raw = row?.values?.[periodIndex];
  // Extractor-vocabulary value_states (face manifests) take precedence when
  // present — they are the closest thing legacy objects have to typed state.
  const declaredState = row?.value_states?.[periodIndex];
  if (declaredState === "period_support_required") {
    return typedValue("period_support_required", {
      period: row?.periods?.[periodIndex] ?? `period_${periodIndex}`,
    });
  }
  if (declaredState === "prior_filing_support") {
    const provenance = row?.period_support_provenance?.[row?.periods?.[periodIndex]] ?? {};
    return typedValue("prior_filing_support", {
      value: Number(raw),
      provenance: {
        prior_document_sha256: provenance.prior_document_sha256 ?? "0".repeat(64),
        prior_source_line_id: String(provenance.prior_source_line_id ?? "unknown"),
        prior_period_index: Number(provenance.prior_period_index ?? -1),
      },
    });
  }
  if (declaredState === "reported_blank") return typedValue("reported_blank");
  if (declaredState === "nil") return typedValue("nil", { raw_text: String(raw ?? "nil") });
  if (row?.forecast_capture_parent_id && periodIndex >= 3) {
    return typedValue("captured", { capture_parent_id: String(row.forecast_capture_parent_id) });
  }
  if (raw === null || raw === undefined) {
    if (row?.historical_authority === "not_applicable" && periodIndex < 3) {
      return typedValue("not_applicable");
    }
    return typedValue("missing");
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return typedValue("parse_failure", {
      raw_text: String(raw),
      failure_reason: "legacy value is not a finite number",
    });
  }
  if (numeric === 0) {
    return typedValue("reported_zero", { value: 0, raw_text: String(raw) });
  }
  if (periodIndex >= 3 || row?.row_type === "calculation" || row?.row_type === "subtotal") {
    return typedValue("derived_number", {
      value: numeric,
      derivation: {
        operator: row?.calculation?.operator ?? "legacy_forecast",
        refs: row?.calculation?.refs ?? [],
      },
    });
  }
  return typedValue("reported_number", { value: numeric, raw_text: String(raw) });
}

/**
 * The legacy view of a typed value — what a nullable-number consumer would
 * see. Lossless in the only lawful direction: value-bearing states expose
 * their number; every absence state exposes null, NEVER zero.
 */
export function legacyViewOf(typed) {
  return ["reported_number", "reported_zero", "prior_filing_support", "derived_number"]
    .includes(typed.state)
    ? typed.value
    : null;
}
