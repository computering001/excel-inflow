import { canonicalSemanticRole } from "./semantic_roles.mjs";

const HEADLINES = new Set(["ebit", "adjusted_ebitda"]);
function finite(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)); }
function observationRows(input) {
  if (Array.isArray(input)) return input;
  for (const key of ["observations", "entries", "ledger", "rows"]) {
    if (Array.isArray(input?.[key])) return input[key];
  }
  return [];
}
function conceptOf(observation) {
  return canonicalSemanticRole(
    observation?.economic_concept_id ?? observation?.concept_id ?? observation?.metric_id ??
    observation?.semantic_role ?? observation?.definition_id,
  );
}
function isBroker(observation) {
  return ["broker_estimate", "broker_consensus", "selected_broker"].includes(
    String(observation?.observation_kind ?? observation?.source_kind ?? observation?.authority ?? "").toLowerCase(),
  );
}
function periodOf(observation) {
  return observation?.period_end ?? observation?.period ?? observation?.forecast_period ?? observation?.period_index ?? null;
}

export function brokerHeadlineCoverage(observationInput) {
  const coverage = { ebit: new Set(), adjusted_ebitda: new Set() };
  for (const observation of observationRows(observationInput)) {
    if (!isBroker(observation) || !finite(observation?.value)) continue;
    let concept = conceptOf(observation);
    if (["operating_profit", "operating_income", "operating_loss"].includes(concept)) concept = "ebit";
    if (!HEADLINES.has(concept)) continue;
    coverage[concept].add(String(periodOf(observation) ?? observation?.observation_id ?? coverage[concept].size));
  }
  return {
    ebit: coverage.ebit.size,
    adjusted_ebitda: coverage.adjusted_ebitda.size,
  };
}

export function selectBrokerHeadlineRole(observationInput) {
  const coverage = brokerHeadlineCoverage(observationInput);
  if (coverage.ebit === 0 && coverage.adjusted_ebitda === 0) return null;
  // The better-covered headline owns broker authority. A tie belongs to EBIT,
  // leaving Adjusted EBITDA formula-derived through the visible D&A bridge.
  return coverage.adjusted_ebitda > coverage.ebit ? "adjusted_ebitda" : "ebit";
}

export function brokerHeadlineEligibility(row, observationInput) {
  const role = canonicalSemanticRole(row?.semantic_role ?? row?.role ?? row?.row_id);
  if (!HEADLINES.has(role)) return { eligible: true, role, selected_role: null, reason: null };
  const selected = selectBrokerHeadlineRole(observationInput);
  if (!selected) return { eligible: false, role, selected_role: null, reason: "No verified broker headline observation is available." };
  return {
    eligible: role === selected,
    role,
    selected_role: selected,
    reason: role === selected
      ? null
      : `${role} is formula-derived because ${selected} is the selected coherent broker headline.`,
  };
}

export default { brokerHeadlineCoverage, brokerHeadlineEligibility, selectBrokerHeadlineRole };
