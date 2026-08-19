#!/usr/bin/env node
/**
 * P0.4 — Support-envelope classification tests.
 *
 * Invariant: every case is classified CERTIFIED, SUPPORTED_DEGRADED,
 * EXPERIMENTAL or UNSUPPORTED before expensive source processing, from
 * intake facts alone.
 */
import { loadSupportEnvelope, classifySupport } from "./lib/support_envelope.mjs";

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

const { contract, sha256, version } = loadSupportEnvelope();
check(version === "3.7.7", "envelope version must be 3.7.7");
check(/^[0-9a-f]{64}$/.test(sha256), "envelope digest must bind");

// 1. Table-driven: every declared dimension value classifies to its table class.
for (const [dimension, spec] of Object.entries(contract.dimensions)) {
  for (const [value, expected] of Object.entries(spec.values)) {
    const descriptor = certifiedBaseline();
    descriptor[dimension] = value;
    const result = classifySupport(contract, descriptor);
    check(
      result.dimension_verdicts[dimension].class === expected,
      `${dimension}=${value} must classify ${expected}, got ${result.dimension_verdicts[dimension].class}`,
    );
  }
  // Unknown value takes the declared unknown class — silence is classified.
  const descriptor = certifiedBaseline();
  delete descriptor[dimension];
  const result = classifySupport(contract, descriptor);
  check(
    result.dimension_verdicts[dimension].class === spec.unknown_value_class &&
      result.dimension_verdicts[dimension].declared === false,
    `${dimension}=unknown must classify ${spec.unknown_value_class}`,
  );
}

function certifiedBaseline() {
  return {
    accounting_framework: "us_gaap",
    entity_type: "non_financial_corporate",
    filing_language_format: "english_text_pdf",
    historical_periods: "three_or_more",
    statement_topology: "standard_three_statement",
    cash_flow_method: "indirect",
    fiscal_calendar: "fixed_date",
    debt_instruments: "within_declared_matrix",
    broker_availability: "broker_pack_present",
    acquisition_overlay: "none",
    restructuring_complexity: "none",
  };
}

// 2. Aggregation is worst-of.
{
  const result = classifySupport(contract, certifiedBaseline());
  check(result.support_class === "CERTIFIED" && !result.early_stop.stopped,
    "the certified baseline must classify CERTIFIED with no stop");
  const degraded = { ...certifiedBaseline(), broker_availability: "broker_pack_absent" };
  const degradedResult = classifySupport(contract, degraded);
  check(degradedResult.support_class === "SUPPORTED_DEGRADED" &&
    degradedResult.degraded_dimensions.includes("broker_availability"),
    "one degraded dimension must degrade the whole class and be named");
  const experimental = { ...degraded, cash_flow_method: "direct" };
  check(classifySupport(contract, experimental).support_class === "EXPERIMENTAL",
    "EXPERIMENTAL must dominate SUPPORTED_DEGRADED");
  const unsupported = { ...experimental, accounting_framework: "other_or_unknown" };
  check(classifySupport(contract, unsupported).support_class === "UNSUPPORTED",
    "UNSUPPORTED must dominate everything");
}

// 3. Early stops: financial institutions and named predicates stop with a
// typed reason BEFORE any document work (the classifier consumes only the
// descriptor — asserted structurally: the certified baseline carries no
// paths, no attachments and no bytes, and classification still completes).
for (const [entity, code] of [
  ["bank", "UNSUPPORTED_PROFILE.financial_institution"],
  ["insurer", "UNSUPPORTED_PROFILE.financial_institution"],
  ["fund", "UNSUPPORTED_PROFILE.financial_institution"],
  ["financial_spv", "UNSUPPORTED_PROFILE.financial_institution"],
  ["investment_company", "UNSUPPORTED_PROFILE.financial_institution"],
]) {
  const result = classifySupport(contract, { ...certifiedBaseline(), entity_type: entity });
  check(result.early_stop.stopped && result.early_stop.reason_code === code &&
    result.support_class === "UNSUPPORTED" &&
    result.early_stop.terminal_state === "UNSUPPORTED_PROFILE",
    `${entity} must stop early with ${code}`);
}
{
  const identity = classifySupport(contract, { ...certifiedBaseline(), identity_verdict: "mismatch" });
  check(identity.early_stop.reason_code === "UNSUPPORTED_PROFILE.irreconcilable_entity_perimeter",
    "irreconcilable identity must stop early");
  const language = classifySupport(contract, { ...certifiedBaseline(), filing_language_format: "non_english" });
  check(language.early_stop.reason_code === "UNSUPPORTED_PROFILE.unadapted_language",
    "unadapted non-English must stop early");
  const adapted = classifySupport(contract, {
    ...certifiedBaseline(), filing_language_format: "non_english", declared_language_adapter: "jp-yuho/1.0",
  });
  check(!adapted.early_stop.stopped, "a declared language adapter lifts the language stop");
  const history = classifySupport(contract, { ...certifiedBaseline(), historical_periods: "fewer_than_two" });
  check(history.early_stop.reason_code === "UNSUPPORTED_PROFILE.insufficient_history",
    "insufficient history must stop early");
  const topology = classifySupport(contract, { ...certifiedBaseline(), statement_topology: "cash_flow_absent" });
  check(topology.early_stop.reason_code === "UNSUPPORTED_PROFILE.cash_flow_absent",
    "an absent cash flow must stop early");
}

// 4. Boundary cases: ordinary corporates and edge entities are not over-rejected.
{
  const reit = classifySupport(contract, { ...certifiedBaseline(), entity_type: "reit" });
  check(reit.support_class === "EXPERIMENTAL" && !reit.early_stop.stopped,
    "a REIT is experimental, never stopped as a financial institution");
  const utility = classifySupport(contract, { ...certifiedBaseline(), entity_type: "utility" });
  check(utility.support_class === "CERTIFIED", "a utility is certified");
  const holding = classifySupport(contract, { ...certifiedBaseline(), entity_type: "holding_company" });
  check(holding.support_class === "SUPPORTED_DEGRADED" && !holding.early_stop.stopped,
    "a holding company is supported with disclosure, never stopped");
  const mixed = classifySupport(contract, {
    ...certifiedBaseline(), entity_type: "mixed_group_predominantly_non_financial",
  });
  check(mixed.support_class === "SUPPORTED_DEGRADED" && !mixed.early_stop.stopped,
    "a predominantly non-financial mixed group is supported with disclosure");
  const stitched = classifySupport(contract, {
    ...certifiedBaseline(), historical_periods: "two_with_prior_filing_support",
  });
  check(stitched.support_class === "SUPPORTED_DEGRADED" && !stitched.early_stop.stopped,
    "two comparatives with prior-filing support degrade, never stop");
}

// 5. Terminal-state mapping: every class names legal terminals; UNSUPPORTED
// maps only to UNSUPPORTED_PROFILE.
for (const supportClass of contract.class_order_worst_first) {
  const mapping = contract.terminal_state_mapping[supportClass];
  check(Array.isArray(mapping?.legal_terminals) && mapping.legal_terminals.length > 0,
    `${supportClass} must map to legal terminal states`);
}
check(
  JSON.stringify(contract.terminal_state_mapping.UNSUPPORTED.legal_terminals) ===
    JSON.stringify(["UNSUPPORTED_PROFILE"]),
  "UNSUPPORTED maps to exactly UNSUPPORTED_PROFILE",
);

// 6. Every early-stop predicate declares positive AND negative examples.
for (const predicate of contract.early_stop_predicates) {
  check(predicate.positive_examples?.length > 0 && predicate.negative_examples?.length > 0,
    `predicate ${predicate.id} must carry positive and negative examples`);
  check(typeof predicate.reason_code === "string" && predicate.reason_code.startsWith("UNSUPPORTED_PROFILE."),
    `predicate ${predicate.id} must carry a typed UNSUPPORTED_PROFILE reason code`);
}

console.log(JSON.stringify({ status: "PASS", checks, envelope_version: version, envelope_sha256: sha256 }));
