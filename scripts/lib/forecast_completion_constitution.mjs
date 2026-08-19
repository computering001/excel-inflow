import { hashValue } from "./run_store.mjs";
import { methodAt, ownershipClass, sourceOwnedMateriality } from "./capture_transition.mjs";

/**
 * The Forecast Completion Constitution (Phase 2) and the economic
 * stage-parity seal (Phase 5).
 *
 * The census answers ONE question the pipeline previously answered only
 * implicitly, gate by gate, failure by failure: for every material statement
 * row and forecast period, which LAWFUL disposition owns it? `unresolved` is
 * not a lawful final state for a supported company — a residual unresolved
 * model-owned cell is either escalated as a genuine batched user decision
 * (when the row is askable) or reported as the compiler totality defect it
 * is, BEFORE expensive downstream work begins.
 *
 * The parity seal binds the census, the authority ledger, the ownership
 * receipts and the case identity into one receipt minted BEFORE Build.
 * Build consumes the sealed graph; it may not select evidence, invent a
 * fallback, capture a child or repair ownership. A Build-stage discovery of
 * an unresolved economic path is a violated contract, not a user problem.
 */

export const FORECAST_COMPLETION_SCHEMA = "forecast-completion-census/1.0";
export const ECONOMIC_STAGE_PARITY_SCHEMA = "economic-stage-parity/1.0";

export const LAWFUL_DISPOSITIONS = Object.freeze([
  "schedule_owned",
  "accounting_identity",
  "direct_evidence_owned",
  "role_policy_owned",
  "historical_fallback_owned",
  "captured_by_parent",
  "not_applicable",
  "genuine_user_decision",
  "unsupported_block",
]);

const DIRECT_EVIDENCE_METHODS = new Set([
  "actual_plus_remainder", "contractual_commitment", "company_guidance",
  "company_indication", "broker_consensus", "user_assumption",
]);
const FALLBACK_METHODS = new Set([
  "historical_average", "historical_trend", "seasonal_run_rate",
  "carry_forward", "explicit_zero", "driver_formula", "roll_forward",
]);

function dispositionFor(row, forecastIndex) {
  const authority = row?.forecast_period_authorities?.[forecastIndex] ?? null;
  const method = authority?.method ?? methodAt(row, forecastIndex);
  if (row?.forecast_waterfall_pending === true && !authority) {
    // A declared broker-waterfall transition: the next compile mints the
    // fallback. At census time this is a lawful pending state only when the
    // census runs BEFORE that recompile; the parity seal refuses it.
    return "genuine_user_decision";
  }
  if (method === "schedule_link") return "schedule_owned";
  if (method === "accounting_identity") return "accounting_identity";
  if (method === "not_separately_forecast") return "captured_by_parent";
  if (method === "not_applicable") return "not_applicable";
  if (
    authority?.tax_rate_normalization ||
    authority?.tax_rate_normalization_ref ||
    authority?.formula_spec?.operator?.startsWith?.("tax_rate_policy")
  ) {
    return "role_policy_owned";
  }
  if (DIRECT_EVIDENCE_METHODS.has(method)) return "direct_evidence_owned";
  if (FALLBACK_METHODS.has(method)) return "historical_fallback_owned";
  return "unresolved";
}

/**
 * Enumerate every material statement row × forecast period and prove exactly
 * one lawful disposition. Residual unresolved MATERIAL cells make the census
 * status ESCALATE (a batched decision is owed) — never a silent pass and
 * never, by itself, a terminal block.
 */
export function compileForecastCompletionCensus(modelCase) {
  const cells = [];
  const escalations = [];
  // P1.5: every tax-rate normalisation reference must resolve to the sealed
  // case receipt BEFORE completion may pass — a dangling or mismatched ref is
  // an internal defect, never a deliverable state.
  const receiptSha = modelCase?.tax_rate_normalization_receipt?.receipt_sha256 ?? null;
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase?.statement_structure?.[section] ?? []) {
      for (const [index, authority] of (row?.forecast_period_authorities ?? []).entries()) {
        const ref = authority?.tax_rate_normalization_ref;
        if (ref && ref !== receiptSha) {
          escalations.push({
            section,
            row_id: row.row_id,
            forecast_index: index,
            reason: receiptSha === null
              ? "tax_rate_normalization_ref does not resolve: the case carries no sealed receipt"
              : "tax_rate_normalization_ref does not match the sealed case receipt hash",
          });
        }
      }
    }
  }
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase?.statement_structure?.[section] ?? []) {
      if (row?.row_type === "header") continue;
      for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
        const disposition = dispositionFor(row, forecastIndex);
        const material = sourceOwnedMateriality(modelCase, row);
        const lawful = LAWFUL_DISPOSITIONS.includes(disposition);
        if (!lawful && material) {
          escalations.push({
            section,
            row_id: row.row_id,
            forecast_index: forecastIndex,
            reason: `no lawful forecast disposition (method=${methodAt(row, forecastIndex)})`,
          });
        }
        cells.push({
          section,
          row_id: row.row_id,
          forecast_index: forecastIndex,
          disposition: lawful ? disposition : "unresolved",
          material,
          ownership_class: ownershipClass(methodAt(row, forecastIndex)),
        });
      }
    }
  }
  const body = {
    schema_version: FORECAST_COMPLETION_SCHEMA,
    case_id: modelCase?.case_id ?? null,
    cell_count: cells.length,
    disposition_counts: cells.reduce((counts, cell) => {
      counts[cell.disposition] = (counts[cell.disposition] ?? 0) + 1;
      return counts;
    }, {}),
    escalations,
    status: escalations.length === 0 ? "PASS" : "ESCALATE",
    cells,
  };
  return { ...body, census_sha256: hashValue(body) };
}

/**
 * Mint the pre-Build parity receipt. Refuses (throws) when the census is not
 * PASS or a waterfall transition is still pending — those states mean the
 * deterministic pre-Build steps have not finished, which is a controller
 * sequencing defect, not a workbook problem.
 */
export function sealEconomicStageParity(modelCase) {
  const census = compileForecastCompletionCensus(modelCase);
  if (census.status !== "PASS") {
    const error = new Error(
      `economic stage parity refused: ${census.escalations.length} model-owned ` +
        `forecast cells lack a lawful disposition (first: ${JSON.stringify(census.escalations[0])})`,
    );
    // P3.7: an internal forecast failure is a typed, resumable outcome —
    // never a bare stack. The terminal catch serialises this payload.
    error.typed_internal_outcome = {
      reason_code: "INTERNAL.forecast_completion_escalated",
      earliest_responsible_layer: "forecast_completion_constitution",
      downstream_invalidation_scope: "forecast_compilation_and_below",
      escalation_count: census.escalations.length,
      first_escalation: census.escalations[0] ?? null,
    };
    throw error;
  }
  const body = {
    schema_version: ECONOMIC_STAGE_PARITY_SCHEMA,
    case_id: modelCase?.case_id ?? null,
    model_case_sha256: hashValue(modelCase),
    completion_census_sha256: census.census_sha256,
    forecast_ledger_sha256: modelCase?.forecast_authority_ledger?.ledger_sha256 ?? null,
    ownership_receipt_sha256:
      modelCase?.forecast_ownership_preflights?.selected?.receipt_sha256 ?? null,
    status: "PASS",
  };
  return { ...body, receipt_sha256: hashValue(body) };
}

/** Verify a previously minted parity receipt against the case about to Build. */
export function verifyEconomicStageParity(modelCase, receipt) {
  const errors = [];
  if (receipt?.schema_version !== ECONOMIC_STAGE_PARITY_SCHEMA) errors.push("schema_version");
  const { receipt_sha256: declared, ...bodyOnly } = receipt ?? {};
  if (declared !== hashValue(bodyOnly)) errors.push("receipt_sha256");
  if (receipt?.model_case_sha256 !== hashValue(modelCase)) errors.push("model_case_sha256");
  return errors;
}
