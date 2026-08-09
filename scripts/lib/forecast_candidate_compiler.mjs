import crypto from "node:crypto";

import {
  forecastRowMateriality,
  isScheduleOwnedForecastRole,
  resolveForecastAuthority,
  selectForecastAuthority,
} from "./forecast_authority.mjs";
import { observationsForConcept } from "./forecast_observation.mjs";
import { resolveBrokerForecastSelection } from "./broker_anchor.mjs";

const FORMULA_METHODS = new Set(["accounting_identity", "driver_formula", "roll_forward", "historical_average", "historical_trend", "seasonal_run_rate", "carry_forward"]);
const OBSERVATION_METHOD = Object.freeze({
  company_guidance: "company_guidance",
  broker_estimate: "broker_consensus",
  user_input: "user_assumption",
});

function finite(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function forecastPlanSha256(plan) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(plan))).digest("hex");
}

function periods(modelCase) {
  const result = (modelCase?.periods ?? []).filter((period) => period?.status === "forecast").map((period) => period.date);
  if (result.length !== 3) throw new Error(`Forecast candidate compiler requires exactly three forecast periods; received ${result.length}.`);
  return result;
}

function sourceBindings(candidate) {
  return [...new Set([
    candidate.source_id,
    candidate.reported_source_id,
    candidate.remainder_source_id,
    ...(candidate.source_bindings ?? []),
  ].filter(Boolean))].sort();
}

function producerAndRender(method) {
  if (method === "schedule_link") return ["schedule", "formula"];
  if (FORMULA_METHODS.has(method)) return ["formula", "formula"];
  if (method === "actual_plus_remainder") return ["formula", "formula"];
  if (method === "broker_consensus") return ["broker_link", "link"];
  if (["contractual_commitment", "company_guidance", "company_indication", "user_assumption"].includes(method)) return ["source_assumption", "input"];
  if (method === "explicit_zero") return ["explicit_zero", "zero"];
  if (method === "not_separately_forecast") return ["captured", "blank_grey"];
  if (method === "not_applicable") return ["not_applicable", "blank_grey"];
  return ["unresolved", "block"];
}

function historicalValues(row) {
  return (row?.values ?? []).slice(0, 3).map((value) => finite(value) ? Number(value) : null);
}

function historicalCandidate(row, behavior, forecastIndex) {
  const history = historicalValues(row);
  const observed = history.filter((value) => value !== null);
  if (observed.length === 0) return null;
  if (observed.every((value) => Math.abs(value) <= 1e-12)) {
    return { method: "explicit_zero", origin: "historical_inference", source_kind: "historical_inference", value: 0, note: "All three comparable historical observations are zero." };
  }
  if (!["recurring_flow", "driver_linked_flow", "seasonal_flow"].includes(behavior)) return null;
  const last = observed.at(-1);
  if (behavior === "seasonal_flow") {
    return { method: "seasonal_run_rate", origin: "historical_inference", source_kind: "historical_inference", value: last, formula_spec: { operator: "seasonal_run_rate", row_id: row.row_id, forecast_index: forecastIndex }, note: "Comparable-period seasonality applied through a visible formula." };
  }
  if (observed.length === 3 && Math.sign(observed[0]) === Math.sign(observed[1]) && Math.sign(observed[1]) === Math.sign(observed[2])) {
    const firstDelta = observed[1] - observed[0];
    const secondDelta = observed[2] - observed[1];
    const scale = Math.max(1, ...observed.map(Math.abs));
    if (Math.abs(secondDelta - firstDelta) / scale <= 0.15) {
      const slope = (firstDelta + secondDelta) / 2;
      return { method: "historical_trend", origin: "historical_inference", source_kind: "historical_inference", value: last + slope * (forecastIndex + 1), formula_spec: { operator: "linear_historical_trend", row_id: row.row_id, historical_period_count: 3, forecast_index: forecastIndex }, note: "Stable comparable-basis historical slope extended through a visible formula." };
    }
    const average = observed.reduce((total, value) => total + value, 0) / observed.length;
    const dispersion = Math.max(...observed.map((value) => Math.abs(value - average))) / Math.max(1, Math.abs(average));
    if (dispersion <= 0.35) {
      return { method: "historical_average", origin: "historical_inference", source_kind: "historical_inference", value: average, formula_spec: { operator: "historical_average", row_id: row.row_id, historical_period_count: 3 }, note: "Three-year comparable-basis average applied through a visible formula." };
    }
  }
  return { method: "carry_forward", origin: "historical_inference", source_kind: "historical_inference", value: last, formula_spec: { operator: "prior_period", refs: [row.row_id] }, note: "Latest comparable reported value carried through a visible formula because no stronger stable inference exists." };
}

function observationMatches(observationInput, row, forecastIndex, windowStart, periodEnd) {
  const concepts = new Set([row.row_id, row.semantic_role, ...(row.source_line_ids ?? []), ...(row.classification_source_line_ids ?? [])].filter(Boolean));
  if (observationInput?.schema_version === "forecast-observation-ledger/1.0") {
    const found = new Map();
    for (const concept of concepts) {
      for (const observation of observationsForConcept(observationInput, concept)) {
        if (observation.period_start >= windowStart && observation.period_end <= periodEnd) {
          found.set(observation.observation_id, observation);
        }
      }
    }
    return [...found.values()];
  }
  return (observationInput ?? []).filter((observation) =>
    concepts.has(observation.economic_concept_id) &&
    (!observation.period_end || observation.period_end === periodEnd),
  );
}

function observationCandidates(observationInput, row, forecastIndex, windowStart, periodEnd) {
  const matches = observationMatches(observationInput, row, forecastIndex, windowStart, periodEnd);
  const candidates = [];
  for (const observation of matches) {
    const method = OBSERVATION_METHOD[observation.observation_kind];
    if (!method || !finite(observation.value)) continue;
    candidates.push({ method, origin: "forecast_observation", source_kind: method === "broker_consensus" ? "broker" : method === "user_assumption" ? "user_supplied" : "company_guidance", value: Number(observation.value), source_id: observation.source_id, as_of_date: observation.reported_through ?? observation.period_end, observation_id: observation.observation_id, source_bindings: [observation.source_id], note: `Selected from forecast observation ${observation.observation_id}.` });
  }
  if (forecastIndex === 0) {
    const partials = matches.filter((observation) => observation.observation_kind === "company_actual" && ["h1_ytd", "q3_ytd"].includes(observation.period_basis) && finite(observation.value));
    const fullYear = matches.find((observation) => ["broker_estimate", "company_guidance"].includes(observation.observation_kind) && observation.period_basis === "annual" && finite(observation.value));
    for (const partial of partials) {
      if (!fullYear || partial.definition_id !== fullYear.definition_id || partial.units !== fullYear.units || partial.sign_convention !== fullYear.sign_convention) continue;
      candidates.push({
        method: "actual_plus_remainder",
        origin: "forecast_observation",
        source_kind: "company_reported",
        value: Number(fullYear.value),
        source_id: partial.source_id,
        as_of_date: partial.reported_through,
        source_bindings: [partial.source_id, fullYear.source_id],
        reported_source_id: partial.source_id,
        remainder_source_id: fullYear.source_id,
        partial_period: { reported_to_date: Number(partial.value), forecast_remainder: Number(fullYear.value) - Number(partial.value), reported_through: partial.reported_through, reported_source_id: partial.source_id, remainder_source_id: fullYear.source_id, remainder_method: "full_year_authority_less_reported" },
        formula_spec: { operator: "actual_plus_remainder", reported_observation_id: partial.observation_id, full_year_observation_id: fullYear.observation_id },
        note: `Reported-to-date ${partial.observation_id} plus the compatible remainder implied by ${fullYear.observation_id}.`,
      });
    }
  }
  return candidates;
}

function formulaCandidate(row, behavior) {
  if (isScheduleOwnedForecastRole(row.semantic_role)) return { method: "schedule_link", origin: "semantic_schedule", source_kind: "schedule", formula_spec: { operator: "schedule_link", semantic_role: row.semantic_role } };
  const calculation = row.forecast_calculation ?? row.calculation;
  if (!calculation) return null;
  const method = ["prior_period", "prior_period_scaled_by"].includes(calculation.operator)
    ? "roll_forward"
    : behavior === "driver_linked_flow"
      ? "driver_formula"
      : "accounting_identity";
  return { method, origin: "declared_formula", source_kind: "formula", formula_spec: structuredClone(calculation) };
}

function declaredCandidate(row, forecastIndex) {
  const authority = row?.forecast_period_authorities?.[forecastIndex];
  return authority ? { ...structuredClone(authority), origin: "declared_period_authority" } : null;
}

function brokerCandidate(modelCase, row, forecastIndex) {
  const metricId = row?.broker_metric_id ??
    (row?.forecast_treatment === "broker" ? row?.semantic_role : null);
  if (!metricId) return null;
  const selection = resolveBrokerForecastSelection(modelCase, metricId, forecastIndex);
  if (!finite(selection?.value)) return null;
  return {
    method: "broker_consensus",
    origin: "row_broker_selection",
    source_kind: "broker",
    value: Number(selection.value),
    source_id: "broker-pack",
    source_bindings: ["broker-pack"],
    broker_metric_id: metricId,
    note: `Selected ${metricId} from the declared broker case.`,
  };
}

function candidateId(stateId, index, candidate) { return `${stateId}:${String(index + 1).padStart(2, "0")}:${candidate.origin}:${candidate.method}`; }

export function compileForecastPlan(modelCase, rowsBySection, { observations = [], observationLedger = null, behaviorMap = [] } = {}) {
  const forecastPeriods = periods(modelCase);
  const historicalPeriods = (modelCase?.periods ?? []).filter((period) => period?.status === "historical").map((period) => period.date);
  const windowStarts = forecastPeriods.map((periodEnd, index) => {
    const priorEnd = index === 0 ? historicalPeriods.at(-1) : forecastPeriods[index - 1];
    if (!priorEnd) throw new Error(`Forecast period ${periodEnd} has no preceding period end.`);
    const start = new Date(`${priorEnd}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
    return start.toISOString().slice(0, 10);
  });
  const behaviorRows = Array.isArray(behaviorMap) ? behaviorMap : behaviorMap?.rows ?? [];
  const behaviorByRow = new Map(behaviorRows.map((entry) => [entry.row_id, entry]));
  const observationInput = observationLedger ?? observations;
  const states = [];
  const ledger = [];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of rowsBySection?.[section] ?? []) {
      if (row.row_type === "header") continue;
      const behaviorEntry = behaviorByRow.get(row.row_id);
      const behavior = behaviorEntry?.behavior ?? (isScheduleOwnedForecastRole(row.semantic_role) ? "schedule_owned" : row.calculation ? "accounting_identity" : "recurring_flow");
      const allowedMethods = new Set(behaviorEntry?.allowed_methods ?? []);
      const evidenceMaterial = forecastRowMateriality(modelCase, row);
      const historyMaterial = historicalValues(row).some((value) => value !== null && Math.abs(value) > 1e-9);
      const material = typeof evidenceMaterial === "boolean" ? evidenceMaterial : historyMaterial;
      for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
        const stateId = `${section}.${row.row_id}.fy${forecastIndex + 1}`;
        let candidates = [];
        const declared = declaredCandidate(row, forecastIndex);
        if (declared) candidates.push(declared);
        const broker = brokerCandidate(modelCase, row, forecastIndex);
        if (broker) candidates.push(broker);
        const formula = formulaCandidate(row, behavior);
        if (formula) candidates.push(formula);
        if (!formula) {
          candidates.push(...observationCandidates(observationInput, row, forecastIndex, windowStarts[forecastIndex], forecastPeriods[forecastIndex]));
          const inferred = historicalCandidate(row, behavior, forecastIndex);
          if (inferred) candidates.push(inferred);
        }
        if (behavior === "not_applicable") candidates.push({ method: "not_applicable", origin: "behavior", source_kind: "none", material: false, note: "The row is outside the applicable economic scope." });
        if (behavior === "captured_detail" && row.forecast_capture_parent_id) candidates.push({ method: "not_separately_forecast", origin: "capture_candidate", source_kind: "none", material, note: row.forecast_capture_note ?? `Captured by ${row.forecast_capture_parent_id}.` });
        if (candidates.length === 0) candidates.push({ method: "unresolved", origin: "compiler", source_kind: "none", reason: "No compatible forecast candidate exists." });

        const compatible = candidates.filter((candidate) =>
          candidate.method === "unresolved" ||
          allowedMethods.size === 0 ||
          allowedMethods.has(candidate.method),
        );
        const hasStrongAuthority = candidates.some((candidate) => [
          "declared_period_authority",
          "forecast_observation",
          "row_broker_selection",
          "semantic_schedule",
          "declared_formula",
        ].includes(candidate.origin));
        if (behaviorEntry?.blocking && !hasStrongAuthority) {
          compatible.length = 0;
        }
        let owner = formula && compatible.includes(formula)
          ? formula
          : selectForecastAuthority(compatible);
        if (!owner) {
          const unresolved = {
            method: "unresolved",
            origin: "behavior_gate",
            source_kind: "none",
            reason: behaviorEntry?.blocking && !hasStrongAuthority
              ? `Forecast behavior for ${row.row_id} is unresolved or low confidence.`
              : `No candidate is permitted for behavior ${behavior}.`,
          };
          candidates.push(unresolved);
          owner = unresolved;
        }
        const selected = owner;
        const selectedIndex = candidates.indexOf(selected);
        candidates = candidates.map((candidate, index) => ({
          ...candidate,
          candidate_id: candidateId(stateId, index, candidate),
          state_id: stateId,
          selected: index === selectedIndex,
          rejection_reason: index === selectedIndex
            ? null
            : allowedMethods.size > 0 && !allowedMethods.has(candidate.method)
              ? `Method ${candidate.method} is not permitted for behavior ${behavior}.`
              : formula
                ? "Formula or schedule ownership outranks independent-input candidates."
                : `Stronger compatible candidate ${selected.method} selected.`,
        }));
        ledger.push(...candidates);
        const selectedRecord = candidates[selectedIndex];
        const [producerType, renderState] = producerAndRender(selectedRecord.method);
        const status = selectedRecord.method === "unresolved" && material ? "BLOCKED" : "RESOLVED";
        states.push({
          state_id: stateId,
          row_id: row.row_id,
          section,
          forecast_index: forecastIndex,
          period_end: forecastPeriods[forecastIndex],
          behavior,
          producer_type: producerType,
          method: selectedRecord.method,
          material,
          selected_candidate_id: selectedRecord.candidate_id,
          value: finite(selectedRecord.value) ? Number(selectedRecord.value) : null,
          formula_spec: selectedRecord.formula_spec ?? null,
          source_bindings: sourceBindings(selectedRecord),
          render_state: renderState,
          status,
          rationale: selectedRecord.note ?? selectedRecord.reason ?? `Selected ${selectedRecord.method}.`,
        });
      }
    }
  }
  const unresolvedMaterialCount = states.filter((state) => state.status === "BLOCKED").length;
  return {
    schema_version: "forecast-plan/2.0",
    case_id: modelCase.case_id,
    forecast_periods: forecastPeriods,
    states,
    candidate_ledger: ledger,
    status: unresolvedMaterialCount === 0 ? "PASS" : "BLOCKED",
    unresolved_material_count: unresolvedMaterialCount,
  };
}

export function validateForecastPlan(plan, rowsBySection) {
  const errors = [];
  const expected = [];
  for (const section of ["income_statement", "cash_flow"]) for (const row of rowsBySection?.[section] ?? []) if (row.row_type !== "header") for (let index = 0; index < 3; index += 1) expected.push(`${section}.${row.row_id}.fy${index + 1}`);
  const statesById = new Map();
  for (const state of plan?.states ?? []) {
    if (statesById.has(state.state_id)) errors.push(`Duplicate forecast state ${state.state_id}.`);
    statesById.set(state.state_id, state);
    const selected = (plan.candidate_ledger ?? []).filter((candidate) => candidate.state_id === state.state_id && candidate.selected);
    if (selected.length !== 1) errors.push(`${state.state_id} must have exactly one selected candidate; found ${selected.length}.`);
    if (selected[0]?.candidate_id !== state.selected_candidate_id) errors.push(`${state.state_id} selected candidate does not match the state.`);
    if (state.render_state === "blank_grey" && !["captured", "not_applicable"].includes(state.producer_type)) errors.push(`${state.state_id} may be blank grey only when captured or not applicable.`);
    if (["formula", "schedule", "broker_link", "source_assumption", "explicit_zero"].includes(state.producer_type) && state.render_state === "blank_grey") errors.push(`${state.state_id} has a live producer but is grey.`);
  }
  for (const stateId of expected) if (!statesById.has(stateId)) errors.push(`Missing forecast state ${stateId}.`);
  for (const stateId of statesById.keys()) if (!expected.includes(stateId)) errors.push(`Unexpected forecast state ${stateId}.`);
  const blocked = (plan?.states ?? []).filter((state) => state.status === "BLOCKED").length;
  if (blocked !== plan?.unresolved_material_count) errors.push(`unresolved_material_count ${plan?.unresolved_material_count} does not equal ${blocked}.`);
  if ((blocked === 0 ? "PASS" : "BLOCKED") !== plan?.status) errors.push(`Plan status ${plan?.status} disagrees with blocked states.`);
  return errors;
}

function authorityFromState(state, candidate) {
  const authority = {
    method: state.method,
    source_kind: candidate?.source_kind ?? (
      state.producer_type === "formula" ? "formula" :
        state.producer_type === "schedule" ? "schedule" :
          state.producer_type === "broker_link" ? "broker" :
            state.producer_type === "explicit_zero" || state.producer_type === "captured" || state.producer_type === "not_applicable" ? "none" :
              "user_supplied"
    ),
    material: state.material,
  };
  if (candidate?.source_id) authority.source_id = candidate.source_id;
  if (candidate?.as_of_date) authority.as_of_date = candidate.as_of_date;
  if (candidate?.note ?? state.rationale) authority.note = candidate?.note ?? state.rationale;
  if (finite(state.value) && ["actual_plus_remainder", "contractual_commitment", "company_guidance", "company_indication", "user_assumption", "explicit_zero"].includes(state.method)) authority.value = Number(state.value);
  if (candidate?.partial_period) authority.partial_period = structuredClone(candidate.partial_period);
  if (candidate?.guidance_range) authority.guidance_range = structuredClone(candidate.guidance_range);
  return authority;
}

function calculationFromState(state) {
  if (!["historical_average", "historical_trend", "seasonal_run_rate", "carry_forward"].includes(state.method)) return null;
  if (state.method === "historical_average") return { operator: "historical_average", refs: [state.row_id] };
  if (state.method === "historical_trend") return { operator: "historical_trend", refs: [state.row_id], forecast_index: state.forecast_index };
  if (state.method === "carry_forward") return { operator: "prior_period", refs: [state.row_id] };
  return state.formula_spec?.operator === "seasonal_run_rate"
    ? { operator: "historical_average", refs: [state.row_id] }
    : null;
}

/**
 * Apply a sealed forecast plan to a fresh case. This is the only bridge from
 * the candidate compiler to the existing v2 solver/renderer. It writes
 * semantic period authorities and typed formula rules, never workbook cells.
 */
export function materializeForecastPlan(modelCase, plan) {
  const next = structuredClone(modelCase);
  next.statement_structure_compiled_version = "semantic-statements/1.0";
  const rowsById = new Map([
    ...(next.statement_structure?.income_statement ?? []),
    ...(next.statement_structure?.cash_flow ?? []),
  ].map((row) => [row.row_id, row]));
  const candidatesById = new Map((plan?.candidate_ledger ?? []).map((candidate) => [candidate.candidate_id, candidate]));
  for (const state of plan?.states ?? []) {
    const row = rowsById.get(state.row_id);
    if (!row) throw new Error(`Forecast plan state ${state.state_id} refers to missing row ${state.row_id}.`);
    const candidate = candidatesById.get(state.selected_candidate_id);
    row.forecast_period_authorities ??= [null, null, null];
    row.forecast_period_authorities[state.forecast_index] = authorityFromState(state, candidate);
    const calculation = calculationFromState(state);
    if (calculation) {
      row.forecast_period_calculations ??= [null, null, null];
      row.forecast_period_calculations[state.forecast_index] = calculation;
      row.forecast_treatment = "formula";
    }
    if (finite(state.value)) {
      row.values ??= [null, null, null, null, null, null];
      row.values[state.forecast_index + 3] = Number(state.value);
    }
    if (state.producer_type === "broker_link") {
      row.broker_metric_id ??= candidate?.broker_metric_id ?? row.semantic_role;
      row.forecast_treatment = "broker";
    } else if (state.producer_type === "source_assumption") {
      row.forecast_treatment = "hardcode";
    } else if (state.producer_type === "explicit_zero") {
      row.forecast_treatment = "zero";
      row.values ??= [null, null, null, null, null, null];
      row.values[state.forecast_index + 3] = 0;
    } else if (["captured", "not_applicable"].includes(state.producer_type)) {
      row.forecast_treatment = "uncalculated";
      row.formula_authority = "intentionally_blank";
      row.values ??= [null, null, null, null, null, null];
      row.values[state.forecast_index + 3] = null;
    }
  }
  return next;
}

export function validateForecastPlanCaseParity(modelCase, plan) {
  const errors = [];
  const rowsById = new Map([
    ...(modelCase?.statement_structure?.income_statement ?? []),
    ...(modelCase?.statement_structure?.cash_flow ?? []),
  ].map((row) => [row.row_id, row]));
  for (const state of plan?.states ?? []) {
    const row = rowsById.get(state.row_id);
    if (!row) {
      errors.push(`${state.state_id} row is absent from the materialized case.`);
      continue;
    }
    const resolved = resolveForecastAuthority(modelCase, row, state.forecast_index);
    if (resolved.method !== state.method) errors.push(`${state.state_id} method ${resolved.method} does not match sealed ${state.method}.`);
    if (finite(state.value) && finite(resolved.value) && Math.abs(Number(state.value) - Number(resolved.value)) > 1e-9) errors.push(`${state.state_id} value ${resolved.value} does not match sealed ${state.value}.`);
  }
  return errors;
}
