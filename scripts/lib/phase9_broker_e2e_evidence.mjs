import { hashValue } from "./run_store.mjs";

export const PHASE9_EVIDENCE_VERSION = "phase9-broker-end-to-end-evidence/1.0";
export const PHASE9_SCENARIOS = Object.freeze([
  "no_broker_supplied",
  "explicit_broker_skip",
  "one_clean_house",
  "three_clean_houses",
  "conflicting_houses",
  "different_kpi_definitions",
  "missing_periods",
  "scanned_pdf",
  "native_table_timeout",
  "one_failed_optional_broker",
  "all_brokers_unusable",
  "resumed_broker_run",
  "v1_demand_migrated_to_v2",
]);

const SHA256 = /^[a-f0-9]{64}$/;

function bodyOf(receipt) {
  const { receipt_sha256: _ignored, ...body } = receipt ?? {};
  return body;
}

export function sealPhase9Evidence(body) {
  return { ...body, receipt_sha256: hashValue(body) };
}

export function verifyPhase9Evidence(receipt) {
  const errors = [];
  const body = bodyOf(receipt);
  if (receipt?.schema_version !== PHASE9_EVIDENCE_VERSION) {
    errors.push("Phase 9 receipt schema is absent or unsupported.");
  }
  if (receipt?.status !== "PASS") errors.push("Phase 9 receipt is not PASS.");
  if (receipt?.evidence_classification !== "SYNTHETIC_PORTABLE_TEST_EVIDENCE") {
    errors.push("Phase 9 evidence is not explicitly classified as synthetic portable test evidence.");
  }
  if (receipt?.external_broker_research_used !== false) {
    errors.push("Phase 9 synthetic proof must not claim external broker research.");
  }
  if (receipt?.native_excel_claimed !== false) {
    errors.push("Phase 9 portable proof must not claim native Excel review.");
  }
  if (!SHA256.test(String(receipt?.receipt_sha256 ?? "")) || receipt.receipt_sha256 !== hashValue(body)) {
    errors.push("Phase 9 receipt self-hash is stale.");
  }
  const scenarios = receipt?.scenarios ?? [];
  if (scenarios.length !== PHASE9_SCENARIOS.length) {
    errors.push(`Phase 9 receipt must contain exactly ${PHASE9_SCENARIOS.length} scenarios.`);
  }
  const ids = scenarios.map((scenario) => scenario?.scenario_id);
  if (JSON.stringify(ids) !== JSON.stringify(PHASE9_SCENARIOS)) {
    errors.push("Phase 9 scenario inventory or order differs from the required matrix.");
  }
  for (const scenario of scenarios) {
    const label = scenario?.scenario_id ?? "unknown scenario";
    for (const field of ["case_sha256", "plan_sha256", "ledger_sha256", "economic_signature_sha256"]) {
      if (!SHA256.test(String(scenario?.[field] ?? ""))) errors.push(`${label} has no valid ${field}.`);
    }
    if (scenario?.compile_status !== "clean" || scenario?.workbook_plan_status !== "PLANNED") {
      errors.push(`${label} did not traverse a clean compiler and workbook-plan route.`);
    }
    if (scenario?.quality_panel?.authority_ledger_reconciliation !== "PASS") {
      errors.push(`${label} quality panel does not reconcile to the selected authority ledger.`);
    }
    const traces = scenario?.selected_metric_traces ?? [];
    if (scenario?.usable_broker_authority === true && traces.length < 1) {
      errors.push(`${label} claims usable broker authority without a visible linked metric.`);
    }
    if (scenario?.usable_broker_authority === false && traces.length !== 0) {
      errors.push(`${label} selected broker values despite a zero-authority outcome.`);
    }
    for (const trace of traces) {
      for (const field of [
        "demand_concept",
        "source_page_cell",
        "house",
        "period",
        "units",
        "definition",
        "workbook_destination",
        "final_formula",
      ]) {
        if (trace?.[field] === null || trace?.[field] === undefined || trace?.[field] === "") {
          errors.push(`${label} selected trace omits ${field}.`);
        }
      }
      if (!Number.isFinite(trace?.compatibility_score) || !Number.isFinite(trace?.selection_score)) {
        errors.push(`${label} selected trace omits numeric compatibility or selection score.`);
      }
      if (!Number.isFinite(Number(trace?.selected_value))) {
        errors.push(`${label} selected trace omits its selected numeric value.`);
      }
      if (!/^Operating Model![A-Z]+\d+$/.test(String(trace?.workbook_destination ?? ""))) {
        errors.push(`${label} selected trace has no exact Operating Model destination.`);
      }
      if (!/Brokers/.test(String(trace?.final_formula ?? ""))) {
        errors.push(`${label} selected trace final formula is not a visible Brokers link.`);
      }
    }
    if (scenario?.broker_degradation_expected === true && scenario?.broker_degradation_visible !== true) {
      errors.push(`${label} expected broker degradation but did not expose it in the workbook panel.`);
    }
  }
  return { valid: errors.length === 0, errors };
}
