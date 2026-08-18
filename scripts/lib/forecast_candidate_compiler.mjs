import { brokerHeadlineEligibility } from "./broker_headline_policy.mjs";
import crypto from "node:crypto";

import {
  forecastRowMateriality,
  forecastAuthorityDecidingDimension,
  forecastAuthorityRankVector,
  isScheduleOwnedForecastRole,
  isStructuredSemanticEvent,
  resolveForecastAuthority,
  selectForecastAuthority,
} from "./forecast_authority.mjs";
import { observationsForConcept } from "./forecast_observation.mjs";
import { sealForecastAuthorityLedger } from "./forecast_authority_ledger.mjs";
import {
  brokerMetricDefinitionSignature,
  compareDefinitionSignatures,
  resolveAnchorPlanDecision,
  resolveBrokerForecastSelection,
  selectBrokerAnchor,
  statementMetricDefinitionSignature,
} from "./broker_anchor.mjs";
import {
  SCHEDULE_PRODUCER_BY_ROLE,
  attachForecastProducerWitness,
} from "./forecast_producer_contract.mjs";

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

function sourceInventoryIndex(sourceInventory) {
  return new Map(
    (sourceInventory ?? [])
      .filter((source) => typeof source?.source_id === "string")
      .map((source) => [source.source_id, source]),
  );
}

function canonicalUnit(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (/\bmillions?\b/.test(normalized)) return "millions";
  if (/\bthousands?\b/.test(normalized)) return "thousands";
  if (/\bunits?\b/.test(normalized)) return "units";
  if (["m", "mm", "million", "millions"].includes(normalized)) return "millions";
  if (["k", "000", "thousand", "thousands"].includes(normalized)) return "thousands";
  if (["unit", "units"].includes(normalized)) return "units";
  if (/^[a-z]{3}(m|mm)$/.test(normalized)) return "millions";
  if (/^[a-z]{3}k$/.test(normalized)) return "thousands";
  return normalized || null;
}

function canonicalCurrency(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("£")) return "GBP";
  if (raw.includes("€")) return "EUR";
  if (raw.includes("$")) return "USD";
  const upper = raw.toUpperCase();
  const separated = upper.match(/(?:^|[^A-Z])([A-Z]{3})(?:[^A-Z]|$)/);
  if (separated) return separated[1];
  const compact = upper.match(/^([A-Z]{3})(?:M|MM|K|000|MILLIONS?|THOUSANDS?|UNITS?)$/);
  return compact?.[1] ?? null;
}

function observationUnitsCompatible(modelCase, value) {
  const expectedScale = canonicalUnit(
    modelCase?.issuer?.units ?? modelCase?.units,
  );
  const observedScale = canonicalUnit(value);
  const expectedCurrency = canonicalCurrency(
    modelCase?.issuer?.reporting_currency,
  );
  const observedCurrency = canonicalCurrency(value);
  const scaleCompatible =
    expectedScale && observedScale
      ? expectedScale === observedScale
      : undefined;
  const currencyCompatible =
    expectedCurrency && observedCurrency
      ? expectedCurrency === observedCurrency
      : undefined;
  if (scaleCompatible === false || currencyCompatible === false) return false;
  if (scaleCompatible === true || currencyCompatible === true) return true;
  return undefined;
}

function observationRecords(observationInput) {
  return observationInput?.schema_version === "forecast-observation-ledger/1.0"
    ? observationInput.observations ?? []
    : observationInput ?? [];
}

function isAnnualObservation(observationInput, observation) {
  return (
    observation?.period_basis === "annual" ||
    (observationInput?.schema_version !== "forecast-observation-ledger/1.0" &&
      !observation?.period_basis)
  );
}

function observationSeriesCompleteness(observationInput, observation, forecastPeriods) {
  const covered = new Set(
    observationRecords(observationInput)
      .filter((candidate) =>
        candidate?.source_id === observation?.source_id &&
        candidate?.economic_concept_id === observation?.economic_concept_id &&
        candidate?.definition_id === observation?.definition_id &&
        candidate?.observation_kind === observation?.observation_kind &&
        isAnnualObservation(observationInput, candidate) &&
        forecastPeriods.includes(candidate?.period_end),
      )
      .map((candidate) => candidate.period_end),
  );
  return covered.size / Math.max(1, forecastPeriods.length);
}

function observationQuality(
  modelCase,
  row,
  observation,
  observationInput,
  forecastPeriods,
  sourceById,
) {
  const source = sourceById.get(observation?.source_id) ?? null;
  const expectedDefinition =
    row?.definition_id ?? row?.definition_signature?.definition_id ?? null;
  const exactConcept = [row?.row_id, row?.semantic_role]
    .filter(Boolean)
    .includes(observation?.economic_concept_id);
  return {
    definition_id: observation?.definition_id ?? null,
    units: observation?.units ?? null,
    sign_convention: observation?.sign_convention ?? null,
    period_basis: observation?.period_basis ?? null,
    period_start: observation?.period_start ?? null,
    period_end: observation?.period_end ?? null,
    definition_compatible: expectedDefinition
      ? observation?.definition_id === expectedDefinition
      : exactConcept
        ? true
        : undefined,
    period_compatible: isAnnualObservation(observationInput, observation),
    period_completeness: isAnnualObservation(observationInput, observation) ? 1 : 0,
    units_compatible: observationUnitsCompatible(
      modelCase,
      observation?.units,
    ),
    freshness_date:
      source?.publication_date ??
      source?.as_of_date ??
      observation?.freshness_date ??
      null,
    confidence: finite(observation?.confidence)
      ? Number(observation.confidence)
      : 1,
    completeness: observationSeriesCompleteness(
      observationInput,
      observation,
      forecastPeriods,
    ),
    stable_id: observation?.observation_id ?? observation?.source_id ?? "",
  };
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
  const values = (row?.values ?? []).slice(0, 3);
  const printedFaceSeries =
    row?.historical_authority === "source_input" && values.length === 3;
  return values.map((value) =>
    finite(value) ? Number(value) : printedFaceSeries ? 0 : null,
  );
}

function evaluatedHistoricalValues(
  row,
  rows,
  { preferReportedReconciliations = false } = {},
) {
  const byId = new Map((rows ?? []).map((candidate) => [candidate.row_id, candidate]));
  const evaluate = (candidate, periodIndex, visiting = new Set()) => {
    // Cash-flow totals can depend on schedule-owned rows whose authoritative
    // history is not reconstructible from this statement-local graph.  A
    // reconciled filed total is therefore the terminal value for cash-flow
    // cache materialisation. Income-statement rows deliberately keep the
    // formula walk so the separate finance-authority bridge remains live.
    const reported = preferReportedReconciliations
      ? candidate?.reported_historical_values?.[periodIndex]
      : null;
    if (finite(reported)) return Number(reported);
    const literal = candidate?.values?.[periodIndex];
    if (
      !candidate?.calculation ||
      (candidate.calculation.refs ?? []).length === 0 ||
      visiting.has(candidate.row_id)
    ) {
      return finite(literal)
        ? Number(literal)
        : candidate?.historical_authority === "source_input" &&
            Array.isArray(candidate?.values) &&
            candidate.values.length >= 3
          ? 0
          : null;
    }
    const nextVisiting = new Set(visiting).add(candidate.row_id);
    const operands = (candidate.calculation.refs ?? []).map((rowId) =>
      evaluate(byId.get(rowId), periodIndex, nextVisiting),
    );
    if (operands.some((value) => !finite(value))) {
      return finite(literal) ? Number(literal) : null;
    }
    const operator = candidate.calculation.operator;
    if (operator === "sum") return operands.reduce((sum, value) => sum + value, 0);
    if (operator === "subtract") return operands.slice(1).reduce((value, item) => value - item, operands[0]);
    if (operator === "link") return operands[0] ?? null;
    if (operator === "negate") return -(operands[0] ?? 0);
    if (operator === "negate_sum") return -operands.reduce((sum, value) => sum + value, 0);
    if (operator === "ratio") return Math.abs(operands[1]) > 1e-12 ? operands[0] / operands[1] : null;
    if (operator === "negated_ratio") return Math.abs(operands[1]) > 1e-12 ? -operands[0] / operands[1] : null;
    return null;
  };
  return [0, 1, 2].map((periodIndex) => evaluate(row, periodIndex));
}

function applyFiledFinanceHistoricalAuthority(modelCase, rows) {
  const nextRows = structuredClone(rows ?? []);
  if (modelCase?.controls?.broker_case !== "Forecast Waterfall") {
    return nextRows;
  }
  const interest = modelCase?.historical_interest_reconciliation;
  if (!Array.isArray(interest?.reported_interest)) return nextRows;
  const expense = nextRows.find(
    (row) => row.semantic_role === "interest_expense",
  );
  if (expense) {
    expense.values ??= [null, null, null, null, null, null];
    for (let index = 0; index < 3; index += 1) {
      expense.values[index] = -Math.abs(Number(interest.reported_interest[index] ?? 0));
    }
  }
  return nextRows;
}

function normaliseEvaluatedHistoricalValues(
  rows,
  { preferReportedReconciliations = false } = {},
) {
  const sourceRows = rows ?? [];
  return sourceRows.map((row) => {
    const evaluated = evaluatedHistoricalValues(row, sourceRows, {
      preferReportedReconciliations,
    });
    if (
      row.historical_authority === "reported_total_reconciled" ||
      !row.calculation ||
      (row.calculation.refs ?? []).length === 0 ||
      !evaluated.every(finite)
    ) {
      return row;
    }
    const next = structuredClone(row);
    next.values ??= [null, null, null, null, null, null];
    for (let index = 0; index < 3; index += 1) {
      next.values[index] = Number(evaluated[index]);
    }
    return next;
  });
}

function historicalCandidate(row, behavior, forecastIndex) {
  const history = historicalValues(row);
  const observed = history.filter((value) => value !== null);
  if (observed.length === 0) return null;
  if (
    ![
      "recurring_flow",
      "driver_linked_flow",
      "seasonal_flow",
      "lumpy_discretionary_flow",
    ].includes(behavior)
  ) return null;
  const last = observed.at(-1);
  if (behavior === "seasonal_flow") {
    // Three annual observations contain no within-year shape.  Calling the
    // last annual value a seasonal run-rate used to manufacture evidence and
    // was then silently materialised as a historical average.  A seasonal
    // candidate is emitted only by a real partial-period/remainder authority;
    // annual history alone therefore remains unresolved.
    return null;
  }
  if (behavior === "lumpy_discretionary_flow") {
    if (observed.length !== 3) return null;
    const average = observed.reduce((total, value) => total + value, 0) / 3;
    return {
      method: "historical_average",
      origin: "historical_inference",
      source_kind: "historical_inference",
      value: average,
      formula_spec: {
        operator: "historical_average",
        row_id: row.row_id,
        historical_period_count: 3,
      },
      note:
        `${row.row_id}: three-year historical average used for a lumpy ` +
        "discretionary cash flow after no commitment, guidance, indication, " +
        "broker value or user assumption resolved. It is not represented as a stable trend.",
    };
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
  const comparableHistory = history
    .map((value, index) =>
      value === null ? null : `H${index + 1}=${Number(value)}`,
    )
    .filter(Boolean)
    .join(", ");
  return {
    method: "carry_forward",
    origin: "historical_inference",
    source_kind: "historical_inference",
    value: last,
    formula_spec: { operator: "prior_period", refs: [row.row_id] },
    note:
      `${row.row_id}: latest comparable reported value ${Number(last)} carried ` +
      `through a visible prior-period formula after reviewing ${comparableHistory}; ` +
      "the three-period history did not support the stricter stable-trend or stable-average tests and no stronger authority resolved.",
  };
}

function eventZeroCandidate(modelCase, row, behavior) {
  if (behavior !== "non_recurring_event" || !isStructuredSemanticEvent(row)) {
    return null;
  }
  const lastHistoricalDate = (modelCase.periods ?? [])
    .filter((period) => period.status === "historical")
    .map((period) => period.date)
    .at(-1);
  return {
    method: "explicit_zero",
    origin: "semantic_event_backstop",
    source_kind: "historical_inference",
    source_id: `semantic-event-backstop:${row.row_id}`,
    as_of_date: lastHistoricalDate,
    zero_basis: "semantic_event_nonrecurrence",
    value: 0,
    note:
      `${row.row_id}: no declared commitment, schedule, company indication ` +
      "or user assumption supports recurrence in this period; the discrete " +
      "event is therefore shown as a visible formula-driven zero at the last " +
      "waterfall rung, not carried forward from history.",
  };
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

function observationCandidates(
  modelCase,
  observationInput,
  row,
  forecastIndex,
  windowStart,
  periodEnd,
  forecastPeriods,
  sourceById,
) {
  const matches = observationMatches(observationInput, row, forecastIndex, windowStart, periodEnd);
  const candidates = [];
  for (const observation of matches) {
    const method = OBSERVATION_METHOD[observation.observation_kind];
    if (
      !method ||
      !finite(observation.value) ||
      !isAnnualObservation(observationInput, observation)
    ) continue;
    if (method === "broker_consensus") {
      const headline = brokerHeadlineEligibility(row, observationInput);
      if (
        !headline.eligible &&
        ["ebit", "adjusted_ebitda", "reported_ebitda"].includes(headline.role)
      ) continue;
    }
    candidates.push({
      method,
      origin: "forecast_observation",
      source_kind:
        method === "broker_consensus"
          ? "broker"
          : method === "user_assumption"
            ? "user_supplied"
            : "company_guidance",
      value: Number(observation.value),
      source_id: observation.source_id,
      as_of_date: observation.reported_through ?? observation.period_end,
      observation_id: observation.observation_id,
      source_bindings: [observation.source_id],
      ...observationQuality(
        modelCase,
        row,
        observation,
        observationInput,
        forecastPeriods,
        sourceById,
      ),
      note: `Selected from forecast observation ${observation.observation_id}.`,
    });
  }
  if (forecastIndex === 0) {
    const partials = matches.filter((observation) => observation.observation_kind === "company_actual" && ["h1_ytd", "q3_ytd"].includes(observation.period_basis) && finite(observation.value));
    for (const partial of partials) {
      const compatibleFullYears = matches.filter((observation) =>
        ["broker_estimate", "company_guidance"].includes(
          observation.observation_kind,
        ) &&
        isAnnualObservation(observationInput, observation) &&
        finite(observation.value) &&
        partial.definition_id === observation.definition_id &&
        partial.units === observation.units &&
        partial.sign_convention === observation.sign_convention,
      );
      for (const fullYear of compatibleFullYears) {
        const quality = observationQuality(
          modelCase,
          row,
          fullYear,
          observationInput,
          forecastPeriods,
          sourceById,
        );
        candidates.push({
          method: "actual_plus_remainder",
          origin: "forecast_observation",
          source_kind: "company_reported",
          value: Number(fullYear.value),
          source_id: partial.source_id,
          as_of_date: partial.reported_through,
          observation_id: `${partial.observation_id}+${fullYear.observation_id}`,
          source_bindings: [partial.source_id, fullYear.source_id],
          reported_source_id: partial.source_id,
          remainder_source_id: fullYear.source_id,
          ...quality,
          stable_id: `${partial.observation_id}+${fullYear.observation_id}`,
          partial_period: { reported_to_date: Number(partial.value), forecast_remainder: Number(fullYear.value) - Number(partial.value), reported_through: partial.reported_through, reported_source_id: partial.source_id, remainder_source_id: fullYear.source_id, remainder_method: "full_year_authority_less_reported" },
          formula_spec: { operator: "actual_plus_remainder", reported_observation_id: partial.observation_id, full_year_observation_id: fullYear.observation_id },
          note: `Reported-to-date ${partial.observation_id} plus the compatible remainder implied by ${fullYear.observation_id}.`,
        });
      }
    }
  }
  return candidates;
}

function formulaCandidate(row, behavior, forecastIndex, rows = []) {
  if (row.semantic_role === "opening_cash") {
    const endingCash = rows.find(
      (candidate) => candidate.semantic_role === "ending_cash",
    );
    return endingCash
      ? {
          method: "roll_forward",
          origin: "temporal_cash_roll_forward",
          source_kind: "formula",
          ownership: "absolute",
          formula_spec: {
            operator: "prior_period",
            refs: [endingCash.row_id],
            temporal_edge: true,
          },
          note:
            "Opening cash is produced from the preceding period's ending cash; FY1 crosses the historical/forecast boundary.",
        }
      : null;
  }
  if (isScheduleOwnedForecastRole(row.semantic_role)) {
    const producerId = SCHEDULE_PRODUCER_BY_ROLE[row.semantic_role] ?? null;
    return {
      method: "schedule_link",
      origin: "semantic_schedule",
      source_kind: "schedule",
      ownership: "absolute",
      formula_spec: {
        operator: "schedule_link",
        semantic_role: row.semantic_role,
        producer_id: producerId,
      },
    };
  }
  if (row.semantic_role === "effective_tax_rate") return null;
  // A historical aggregate formula is evidence of membership, not a stronger
  // line-level forecast. Once the topology compiler has certified the row as
  // captured detail, reusing that historical sum would keep the intermediate
  // aggregate live while its children are blank and recreate the very
  // top-down inconsistency capture is meant to remove. Explicit forecast
  // formulas remain eligible; only the implicit fallback to `calculation` is
  // suppressed.
  if (
    behavior === "captured_detail" &&
    !row.forecast_calculation &&
    !(row.forecast_period_calculations ?? []).some(Boolean)
  ) {
    return null;
  }
  // A period-specific rule vector is a complete three-period direction
  // declaration.  A null slot means "this period is supplied by its own
  // waterfall authority", not "fall back to the historical identity".  The
  // solver and renderer already obey this rule; enforcing it here prevents a
  // candidate selected as accounting_identity from reaching a cell for which
  // no formula exists (and prevents cross-statement direction reversals from
  // turning into circularity).
  const periodRulesDeclared = Array.isArray(row.forecast_period_calculations);
  const calculation = periodRulesDeclared
    ? row.forecast_period_calculations[forecastIndex] ?? null
    : row.forecast_calculation ?? row.calculation;
  if (!calculation) return null;
  if (
    behavior === "captured_detail" &&
    (calculation.refs ?? []).some((reference) => {
      const dependency = rows.find((candidate) => candidate.row_id === reference);
      const authority = dependency?.forecast_period_authorities?.[forecastIndex];
      return Boolean(
        dependency?.forecast_capture_parent_id ||
        ["not_separately_forecast", "not_applicable"].includes(authority?.method),
      );
    })
  ) {
    // A formula whose input is deliberately absent is not executable evidence.
    // The certified aggregate capture remains the correct authority; keeping
    // the intermediate formula live would display a partial subtotal that no
    // longer represents the selected parent forecast.
    return null;
  }
  // Formula shape, not a broad row label, determines ownership.  A
  // prior-period rule is a forecast mechanism even when the row was emitted
  // as a calculation row; treating it as an accounting identity made it
  // absolute and prevented guidance or stronger evidence from competing.
  const rollForward = ["prior_period", "prior_period_scaled_by"].includes(
    calculation.operator,
  );
  const method = rollForward
    ? "roll_forward"
    : behavior === "accounting_identity"
      ? "accounting_identity"
      : "driver_formula";
  return {
    method,
    origin: "declared_formula",
    source_kind: "formula",
    ownership: method === "accounting_identity" ? "absolute" : "waterfall",
    formula_spec: structuredClone(calculation),
    note:
      method === "accounting_identity"
        ? "The row is owned by its declared accounting identity."
        : method === "roll_forward"
          ? "The declared per-period roll-forward remains visible and competes at its waterfall rung."
          : "The declared driver formula remains visible and competes at its waterfall rung.",
  };
}

function derivedDisplayCandidate(row) {
  if (
    row?.semantic_role === "effective_tax_rate" ||
    !["growth", "ratio", "negated_ratio"].includes(row?.calculation?.operator)
  ) {
    return null;
  }
  return {
    method: "accounting_identity",
    origin: "derived_display_formula",
    source_kind: "formula",
    ownership: "absolute",
    formula_spec: structuredClone(row.calculation),
    note: "The derived growth, margin or rate row is owned by its visible accounting formula.",
  };
}

function declaredCandidate(row, forecastIndex) {
  const authority = row?.forecast_period_authorities?.[forecastIndex];
  return authority ? { ...structuredClone(authority), origin: "declared_period_authority" } : null;
}

function brokerCandidateResolution(modelCase, row, forecastIndex) {
  // Broker availability is evidence, not a presentation property.  Testing
  // the semantic role even when row planning did not pre-label the row keeps
  // working-capital and other issuer-specific aggregates independent of a
  // hardwired broker treatment while still requiring an actually resolved
  // broker selection.
  const packMetrics = modelCase?.broker_pack?.metrics ?? {};
  const metricIds = [...new Set([
    row?.broker_metric_id,
    row?.semantic_role,
    row?.row_id,
  ].filter((metricId) =>
    Boolean(metricId) &&
    (metricId === row?.broker_metric_id || Object.hasOwn(packMetrics, metricId)),
  ))];
  const rejections = [];
  for (const metricId of metricIds) {
    const metric = packMetrics[metricId];
    if (!metric) {
      rejections.push({
        metric_id: metricId,
        reason: `Declared broker metric ${metricId} is absent from the sealed broker pack.`,
      });
      continue;
    }
    const brokerDefinition = brokerMetricDefinitionSignature(modelCase, metricId);
    const statementDefinition = statementMetricDefinitionSignature(
      modelCase,
      [row],
      metricId,
    );
    const compatibility = compareDefinitionSignatures(
      brokerDefinition,
      statementDefinition,
    );
    if (!compatibility.compatible) {
      rejections.push({
        metric_id: metricId,
        reason: `Broker metric ${metricId} is definition-incompatible with ${row.row_id}.`,
        definition_mismatches: compatibility.mismatches,
      });
      continue;
    }
    const selection = resolveBrokerForecastSelection(modelCase, metricId, forecastIndex);
    if (finite(selection?.value)) {
      const archiveHouses = [
        ...(modelCase?.broker_archive?.page_evidence ?? modelCase?.broker_pack?.page_evidence ?? []),
        ...(modelCase?.broker_archive?.raw_tables ?? modelCase?.broker_pack?.raw_tables ?? []),
      ];
      const houseIdByName = new Map(
        archiveHouses.map((house) => [String(house?.house_name ?? ""), String(house?.house_id ?? "")]),
      );
      const selectedHouseNames = selection.source_kind === "named_house_mean"
        ? [...(selection.contributors ?? [])].map(String)
        : ["named_house", "high", "low"].includes(selection.source_kind)
          ? [String(selection.source_name ?? "")].filter(Boolean)
          : [];
      const selectedHouseIds = selectedHouseNames.map(
        (houseName) => houseIdByName.get(houseName) ?? houseName,
      );
      const selectedMappings = (modelCase?.broker_pack?.source_mappings ?? [])
        .filter((mapping) =>
          mapping?.metric_id === metricId &&
          Number(mapping?.period_index) === forecastIndex &&
          (selectedHouseIds.length === 0 || selectedHouseIds.includes(String(mapping?.house_id ?? ""))),
        );
      const sourcePageCells = [...new Set(selectedMappings.flatMap((mapping) =>
        (mapping?.components ?? []).map((component) => String(component?.source_ref ?? "")).filter(Boolean),
      ))].sort();
      const compatibilityFlags = {
        definition: compatibility.compatible,
        period: true,
        units: true,
      };
      return {
        candidate: {
          method: "broker_consensus",
          origin: "row_broker_selection",
          source_kind: "broker",
          value: Number(selection.value),
          source_id: "broker-pack",
          source_bindings: ["broker-pack"],
          broker_metric_id: metricId,
          broker_selection: structuredClone(selection),
          source_page_cell: sourcePageCells.length > 0 ? sourcePageCells.join(" | ") : null,
          house_id: selectedHouseNames.length > 0
            ? selectedHouseNames.join(", ")
            : String(selection.source_name ?? "Provider consensus"),
          definition_id: metric?.definition_id ?? `dict.${metricId}`,
          units: brokerDefinition.units ?? modelCase?.issuer?.units ?? null,
          compatibility: compatibilityFlags,
          compatibility_score:
            Object.values(compatibilityFlags).filter(Boolean).length /
            Object.values(compatibilityFlags).length,
          note: `Selected ${metricId} from the declared broker case.`,
        },
        rejection: null,
      };
    }
    rejections.push({
      metric_id: metricId,
      reason:
        selection?.substitution_reason ??
        `Broker metric ${metricId} has no usable value for forecast period ${forecastIndex + 1}.`,
      selection: structuredClone(selection),
    });
  }
  return {
    candidate: null,
    rejection: rejections.length > 0
      ? {
          method: "unresolved",
          origin: "row_broker_rejection",
          source_kind: "broker_rejected",
          broker_metric_id: rejections[0].metric_id,
          broker_rejections: rejections,
          reason: rejections.map((item) => item.reason).join(" "),
        }
      : null,
  };
}

function brokerCandidate(modelCase, row, forecastIndex) {
  return brokerCandidateResolution(modelCase, row, forecastIndex).candidate;
}

const INDEPENDENT_CAPTURE_METHODS = new Set([
  "actual_plus_remainder",
  "contractual_commitment",
  "company_guidance",
  "company_indication",
  "broker_consensus",
  "user_assumption",
  "historical_average",
  "historical_trend",
  "seasonal_run_rate",
  "carry_forward",
  "explicit_zero",
]);

function independentlyForecastedParent(modelCase, parent, forecastIndex) {
  if (!parent) return false;
  if (isScheduleOwnedForecastRole(parent.semantic_role)) return true;
  if (brokerCandidate(modelCase, parent, forecastIndex)) return true;
  const declared = declaredCandidate(parent, forecastIndex);
  if (declared && INDEPENDENT_CAPTURE_METHODS.has(declared.method)) return true;
  if (finite(parent.values?.[forecastIndex + 3])) return true;
  if (
    [
      "revenue",
      "ebit",
      "ebitda",
      "adjusted_ebitda",
      "reported_ebitda",
      "depreciation_and_amortisation",
    ].includes(parent.semantic_role) &&
    Boolean(
      parent.forecast_period_calculations?.[forecastIndex]?.refs?.length ??
      parent.forecast_calculation?.refs?.length,
    )
  ) {
    return true;
  }
  // A disclosed aggregate with no component or forecast formula is itself an
  // economic series and will enter the ordinary evidence waterfall. A parent
  // whose formula consumes the child is not independent unless one of the
  // direct authorities above replaces that formula for this period.
  return !(parent.calculation?.refs ?? []).length && !parent.forecast_calculation;
}

const CAPTURE_MEMBERSHIP_OPERATORS = new Set([
  "sum",
  "subtract",
  "negate_sum",
  "negate",
  "link",
]);

function certifiedMembershipPath(row, targetId, rows) {
  const rowsById = new Map(rows.map((candidate) => [candidate.row_id, candidate]));
  const localIds = new Set(rowsById.keys());
  const parentsByChild = new Map();
  for (const parent of rows) {
    if (!CAPTURE_MEMBERSHIP_OPERATORS.has(parent.calculation?.operator)) continue;
    const counts = new Map();
    for (const ref of parent.calculation?.refs ?? []) {
      if (!localIds.has(ref)) continue;
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
    for (const [childId, count] of counts) {
      const parents = parentsByChild.get(childId) ?? [];
      parents.push({ parent_id: parent.row_id, count });
      parentsByChild.set(childId, parents);
    }
  }
  const paths = [];
  const queue = [[row.row_id]];
  let shortest = null;
  let cycle = false;
  while (queue.length > 0) {
    const path = queue.shift();
    const childId = path.at(-1);
    const edges = path.length - 1;
    if (shortest !== null && edges >= shortest) continue;
    for (const parent of parentsByChild.get(childId) ?? []) {
      if (parent.count !== 1) continue;
      if (path.includes(parent.parent_id)) {
        cycle = true;
        continue;
      }
      const next = [...path, parent.parent_id];
      if (parent.parent_id === targetId) {
        const nextEdges = next.length - 1;
        if (shortest === null) shortest = nextEdges;
        if (nextEdges === shortest) paths.push(next);
      } else {
        queue.push(next);
      }
    }
  }
  return {
    status: cycle ? "cycle" : paths.length === 1 ? "exact" : paths.length > 1 ? "ambiguous" : "missing",
    path: paths.length === 1 ? paths[0] : null,
    paths,
  };
}

function semanticStatementBandPath(row, targetId, rows, section) {
  const rowIndex = rows.indexOf(row);
  const target = rows.find((candidate) => candidate.row_id === targetId);
  if (!target || rowIndex < 0) return null;
  if (section === "cash_flow") {
    const headerByTotalRole = {
      cash_from_investing: "investing_activities",
      cash_from_financing: "financing_activities",
    };
    const headerId = headerByTotalRole[target.semantic_role];
    const headerIndex = headerId
      ? rows.findIndex((candidate) => candidate.row_id === headerId)
      : -1;
    const targetIndex = rows.indexOf(target);
    return headerIndex >= 0 && rowIndex > headerIndex && rowIndex < targetIndex
      ? [row.row_id, targetId]
      : null;
  }
  if (section !== "income_statement") return null;
  const revenueIndex = rows.findIndex(
    (candidate) => candidate.semantic_role === "revenue",
  );
  const ebitIndex = rows.findIndex(
    (candidate) => candidate.semantic_role === "ebit",
  );
  if (target.semantic_role === "revenue" && rowIndex < revenueIndex) {
    return [row.row_id, targetId];
  }
  if (
    target.semantic_role === "ebit" &&
    revenueIndex >= 0 &&
    rowIndex > revenueIndex &&
    rowIndex < ebitIndex
  ) {
    return [row.row_id, targetId];
  }
  return null;
}

function captureCandidate(modelCase, row, rows, forecastIndex, material, section) {
  if (!row.forecast_capture_parent_id) return null;
  const parentMatches = rows.filter(
    (candidate) => candidate.row_id === row.forecast_capture_parent_id,
  );
  const suppliedCertificates = (row.forecast_capture_certificates ?? []).filter(
    (certificate) =>
      certificate?.forecast_index === forecastIndex &&
      certificate?.parent_row_id === row.forecast_capture_parent_id,
  );
  const parent = parentMatches[0] ?? null;
  const mode = suppliedCertificates[0]?.mode ?? row.forecast_capture_mode;
  const pathProof = certifiedMembershipPath(
    row,
    row.forecast_capture_parent_id,
    rows,
  );
  const formulaMembership = pathProof.status === "exact";
  const hierarchyMembership = row.parent_row_id === row.forecast_capture_parent_id;
  const statementBandPath = semanticStatementBandPath(
    row,
    row.forecast_capture_parent_id,
    rows,
    section,
  );
  const certifiedPath = pathProof.path ?? (
    hierarchyMembership
      ? [row.row_id, row.forecast_capture_parent_id]
      : statementBandPath
  );
  const membershipProved = mode === "formula_membership"
    ? formulaMembership
    : hierarchyMembership || formulaMembership || Boolean(statementBandPath);
  const suppliedPath = suppliedCertificates[0]?.membership_path;
  const suppliedPathMatches =
    suppliedPath === undefined ||
    (certifiedPath && JSON.stringify(suppliedPath) === JSON.stringify(certifiedPath));
  if (
    parentMatches.length !== 1 ||
    suppliedCertificates.length > 1 ||
    !membershipProved ||
    !suppliedPathMatches ||
    !independentlyForecastedParent(modelCase, parent, forecastIndex)
  ) {
    return {
      method: "unresolved",
      origin: "invalid_capture_candidate",
      source_kind: "none",
      material,
      reason:
        `Capture ${section}.${row.row_id} -> ${row.forecast_capture_parent_id} ` +
        "lacks one unique section-local additive membership path, a matching " +
        "certificate and an independently forecasted aggregate parent for this period.",
    };
  }
  const certificate = {
    ...(suppliedCertificates[0] ?? {}),
    forecast_index: forecastIndex,
    parent_row_id: row.forecast_capture_parent_id,
    mode,
    material,
    membership_path:
      suppliedCertificates[0]?.membership_path ?? structuredClone(certifiedPath),
    proof:
      suppliedCertificates[0]?.proof ?? (
        mode === "formula_membership"
          ? `The unique section-local additive path is ${pathProof.path.join(" -> ")}.`
          : statementBandPath
            ? "The section-local visible-successor band places this row inside the directly forecast headline scope."
            : "The unique section-local declared hierarchy assigns this row to the parent."
      ),
  };
  return {
    method: "not_separately_forecast",
    origin: "capture_candidate",
    source_kind: "none",
    material,
    capture_certificate: structuredClone(certificate),
    note: row.forecast_capture_note ?? `Captured by ${row.forecast_capture_parent_id}.`,
  };
}

function candidateStableKey(candidate) {
  const projection = structuredClone(candidate ?? {});
  for (const field of [
    "candidate_id",
    "rank_vector",
    "selected",
    "rejection_reason",
    "state_id",
  ]) {
    delete projection[field];
  }
  return JSON.stringify(canonical(projection));
}

function candidateId(stateId, candidate) {
  const digest = crypto
    .createHash("sha256")
    .update(candidateStableKey(candidate))
    .digest("hex")
    .slice(0, 16);
  return `${stateId}:${candidate.origin}:${candidate.method}:${digest}`;
}

export function compileForecastPlan(
  modelCase,
  rowsBySection,
  {
    observations = [],
    observationLedger = null,
    sourceInventory = [],
    behaviorMap = [],
  } = {},
) {
  const normalisedRowsBySection = Object.fromEntries(
    ["income_statement", "cash_flow"].map((section) => [
      section,
      normaliseEvaluatedHistoricalValues(
        section === "income_statement"
          ? applyFiledFinanceHistoricalAuthority(
              modelCase,
              rowsBySection?.[section] ?? [],
            )
          : rowsBySection?.[section] ?? [],
        { preferReportedReconciliations: section === "cash_flow" },
      ),
    ]),
  );
  rowsBySection = normalisedRowsBySection;
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
  const sectionsByRowId = new Map();
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of rowsBySection?.[section] ?? []) {
      const sections = sectionsByRowId.get(row.row_id) ?? [];
      sections.push(section);
      sectionsByRowId.set(row.row_id, sections);
    }
  }
  const behaviorByRow = new Map();
  for (const entry of behaviorRows) {
    const declaredSection = entry.section;
    const uniqueSection = (sectionsByRowId.get(entry.row_id) ?? []).length === 1
      ? sectionsByRowId.get(entry.row_id)[0]
      : null;
    const section = declaredSection ?? uniqueSection;
    // A sectionless behavior instruction is accepted only while its row id is
    // globally unique.  Duplicate issuer identifiers in two statements must
    // be section-qualified rather than inheriting whichever entry was last.
    if (section) behaviorByRow.set(`${section}\u0000${entry.row_id}`, entry);
  }
  // Compile the complete headline bridge decision before any row candidate is
  // ranked.  Selecting the broker headline alone is insufficient when a
  // disclosed bridge contains an inverse residual (Adjusted EBITDA less every
  // other bridge term): the residual and the subtotal otherwise define each
  // other and produce a rank-deficient formula cycle.  The anchor decision is
  // the upstream economic authority, so it removes the inverse residual from
  // the derived headline formula and quarantines only that residual as
  // captured detail.  No workbook/presentation pass is allowed to discover
  // or repair this later.
  const incomeRows = rowsBySection?.income_statement ?? [];
  const anchorDecision = resolveAnchorPlanDecision(modelCase, incomeRows);
  const anchorResidualPlugIds = new Set(
    anchorDecision.status === "applied"
      ? anchorDecision.residualPlugRowIds ?? []
      : [],
  );
  if (
    anchorDecision.status === "applied" &&
    anchorDecision.selection?.derived === "adjusted_ebitda"
  ) {
    const derivedHeadline = anchorDecision.bridge.ebitdaRow;
    derivedHeadline.forecast_calculation = {
      operator: derivedHeadline.calculation.operator,
      refs: (derivedHeadline.calculation.refs ?? []).filter(
        (reference) => !anchorResidualPlugIds.has(reference),
      ),
    };
    delete derivedHeadline.forecast_period_calculations;
    delete derivedHeadline.broker_metric_id;
    for (const row of incomeRows) {
      if (!anchorResidualPlugIds.has(row.row_id)) continue;
      delete row.forecast_calculation;
      delete row.forecast_period_calculations;
      row.values = [...(row.values ?? []).slice(0, 3), null, null, null];
      row.forecast_capture_parent_id = derivedHeadline.row_id;
      row.forecast_capture_mode = "formula_membership";
      row.forecast_capture_note =
        "The inverse bridge residual is represented by the authoritative headline and is not forecast as an independent plug.";
    }
  }
  // TIER 1 — THE ANCHOR IS ALWAYS CONSUMED, AND IT OUTRANKS ITS OWN IDENTITY.
  //
  // The headline anchor row is usually a calculation (Adjusted EBITDA as a
  // bridge sum, EBIT as its counterpart), so ordinary ownership hands it to
  // the identity formula and the broker consensus never enters the workbook
  // as a formula. When every other bridge row is an identity too, the trio is
  // mutually defined and nothing pins the level: the emitted equations become
  // a rank-deficient cycle whose solution lives only in cached values. The
  // fix is one deliberate exception, decided by the same anchor selector the
  // downstream bridge rule uses: when broker evidence supports a headline
  // metric with compatible definitions, that ONE row is broker-owned, which
  // both pins the level and makes resolveAnchorPlanDecision applicable so the
  // rest of the bridge is rewired deterministically. Incompatible or
  // unsupported anchors deliberately fall through unchanged — the equation
  // cycle gates then block the build rather than let a cache-pinned identity
  // loop ship.
  const anchorSelection = selectBrokerAnchor(modelCase, incomeRows);
  const anchorOwnedRoles = new Set(
    anchorSelection.supported &&
      anchorSelection.definition_compatibility?.[anchorSelection.headline_anchor]?.compatible
      ? [anchorSelection.headline_anchor]
      : [],
  );
  for (const row of incomeRows) {
    if (anchorOwnedRoles.has(row.semantic_role)) {
      row.broker_metric_id ??= row.semantic_role;
    }
  }
  const observationInput = observationLedger ?? observations;
  const sourceById = sourceInventoryIndex(sourceInventory);
  const states = [];
  const ledger = [];
  for (const section of ["income_statement", "cash_flow"]) {
    const sectionRows = rowsBySection?.[section] ?? [];
    for (const row of sectionRows) {
      if (row.row_type === "header") continue;
      const behaviorEntry = behaviorByRow.get(`${section}\u0000${row.row_id}`);
      const declaredCalculation = row.forecast_calculation ?? row.calculation;
      const behavior = anchorResidualPlugIds.has(row.row_id)
        ? "captured_detail"
        : behaviorEntry?.behavior ?? (
        isScheduleOwnedForecastRole(row.semantic_role)
          ? "schedule_owned"
          : ["prior_period", "prior_period_scaled_by"].includes(
                declaredCalculation?.operator,
              )
            ? "driver_linked_flow"
            : declaredCalculation
              ? "accounting_identity"
              : "recurring_flow"
      );
      const allowedMethods = new Set(
        anchorResidualPlugIds.has(row.row_id)
          ? ["not_separately_forecast"]
          : behaviorEntry?.allowed_methods ?? [],
      );
      const evidenceMaterial = forecastRowMateriality(modelCase, row);
      const historyMaterial = historicalValues(row).some((value) => value !== null && Math.abs(value) > 1e-9);
      const material = typeof evidenceMaterial === "boolean" ? evidenceMaterial : historyMaterial;
      for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
        const stateId = `${section}.${row.row_id}.fy${forecastIndex + 1}`;
        let candidates = [];
        const derivedBrokerHeadline =
          section === "income_statement" &&
          anchorSelection.supported &&
          row.semantic_role === anchorSelection.derived;
        let declared = declaredCandidate(row, forecastIndex);
        if (derivedBrokerHeadline && declared?.method === "broker_consensus") {
          declared = null;
        }
        const brokerResolution = derivedBrokerHeadline
          ? { candidate: null, rejection: null }
          : brokerCandidateResolution(modelCase, row, forecastIndex);
        const broker = brokerResolution.candidate;
        if (
          declared?.method === "broker_consensus" &&
          broker &&
          finite(broker.value)
        ) {
          // The declaration selects the authority class; the resolved broker
          // candidate supplies its executable cell value and exact metric
          // binding. Keeping them as two equal-ranked candidates selected the
          // declaration shell first and produced a broker link with no value.
          Object.assign(declared, {
            value: Number(broker.value),
            source_id: broker.source_id,
            source_bindings: structuredClone(broker.source_bindings ?? []),
            broker_metric_id: broker.broker_metric_id,
          });
        }
        if (declared) candidates.push(declared);
        if (broker) candidates.push(broker);
        if (brokerResolution.rejection) candidates.push(brokerResolution.rejection);
        const formula = formulaCandidate(row, behavior, forecastIndex, sectionRows);
        if (formula) candidates.push(formula);
        const derivedDisplay = derivedDisplayCandidate(row);
        if (derivedDisplay) candidates.push(derivedDisplay);
        // Evidence is assembled independently of formula presence.  Only a
        // genuine accounting identity or schedule link owns the row before
        // this ladder; driver and roll-forward formulas compete at their
        // declared waterfall rungs.
        candidates.push(...observationCandidates(
          modelCase,
          observationInput,
          row,
          forecastIndex,
          windowStarts[forecastIndex],
          forecastPeriods[forecastIndex],
          forecastPeriods,
          sourceById,
        ));
        let inferred = historicalCandidate(row, behavior, forecastIndex);
        if (!inferred && behavior === "driver_linked_flow") {
          const evaluated = evaluatedHistoricalValues(row, sectionRows);
          if (evaluated.every(finite)) {
            inferred = historicalCandidate(
              { ...row, values: evaluated },
              behavior,
              forecastIndex,
            );
            if (inferred) {
              inferred.note =
                `${inferred.note ?? "Historical inference selected."} ` +
                "The comparable history was independently evaluated from the row's filed accounting formula.";
            }
          }
        }
        if (inferred) candidates.push(inferred);
        const eventZero = eventZeroCandidate(modelCase, row, behavior);
        if (eventZero) candidates.push(eventZero);
        if (behavior === "not_applicable") candidates.push({ method: "not_applicable", origin: "behavior", source_kind: "none", material: false, note: "The row is outside the applicable economic scope." });
        if (behavior === "captured_detail" && row.forecast_capture_parent_id) {
          candidates.push(captureCandidate(modelCase, row, sectionRows, forecastIndex, material, section));
        }
        if (declared) {
          const executableTwin = selectForecastAuthority(
            candidates.filter(
              (candidate) =>
                candidate !== declared &&
                candidate.method === declared.method &&
                (finite(candidate.value) ||
                  candidate.formula_spec ||
                  candidate.capture_certificate),
            ),
          );
          if (executableTwin) {
            for (const field of [
              "value",
              "formula_spec",
              "source_id",
              "source_bindings",
              "broker_metric_id",
              "partial_period",
              "guidance_range",
              "capture_certificate",
              "zero_basis",
              "as_of_date",
              "definition_id",
              "units",
              "sign_convention",
              "period_basis",
              "period_start",
              "period_end",
              "definition_compatible",
              "period_compatible",
              "period_completeness",
              "units_compatible",
              "freshness_date",
              "confidence",
              "completeness",
              "stable_id",
              "observation_id",
            ]) {
              if (
                (declared[field] === undefined || declared[field] === null) &&
                executableTwin[field] !== undefined
              ) {
                declared[field] = structuredClone(executableTwin[field]);
              }
            }
          }
        }
        if (candidates.length === 0) candidates.push({ method: "unresolved", origin: "compiler", source_kind: "none", reason: "No compatible forecast candidate exists." });

        // Candidate arrays may arrive from evidence in any record order. Sort
        // by the candidate's complete canonical identity before minting IDs or
        // sealing the plan; array position is not economic evidence and cannot
        // be allowed to change package identity.
        candidates.sort((left, right) =>
          candidateStableKey(left).localeCompare(candidateStableKey(right)),
        );
        for (const candidate of candidates) {
          candidate.rank_vector = forecastAuthorityRankVector(candidate);
        }

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
          "temporal_cash_roll_forward",
          "declared_formula",
        ].includes(candidate.origin));
        if (behaviorEntry?.blocking && !hasStrongAuthority) {
          compatible.length = 0;
        }
        // Tier 1 outranks behaviour-method gating on the anchor row itself:
        // a behaviour map that permits only identity methods for calculation
        // rows would otherwise silently hand the anchor back to its identity
        // formula — which is exactly how an authored broker anchor still
        // emitted as a mutually-defined bridge and shipped an undeclared
        // cycle. The anchor candidate exists only when the selector proved
        // support and definition compatibility, so consuming it here is the
        // doctrine, not an escape hatch.
        const anchorOwned =
          section === "income_statement" &&
          anchorOwnedRoles.has(row.semantic_role) &&
          Boolean(broker);
        // The consumption doctrine deliberately stamps a broker treatment on
        // consumable calculation totals (revenue, capex, working capital,
        // etc.). That is an explicit authority selection, not merely another
        // observation competing with the historical identity. Honour it just
        // like the Tier-1 headline anchor: the broker owns the total and its
        // detailed formula members are captured. If the selected broker value
        // is unavailable, `broker` is null and the accounting identity remains
        // the safe fallback.
        const declaredBrokerOwned =
          (declared?.method === "broker_consensus" ||
            row.forecast_treatment === "broker") &&
          Boolean(broker) && finite(broker.value);
        const absoluteFormula =
          formula?.ownership === "absolute"
            ? formula
            : derivedDisplay?.ownership === "absolute"
              ? derivedDisplay
              : null;
        const invalidCapture = candidates.find(
          (candidate) => candidate.origin === "invalid_capture_candidate",
        );
        // A declared `not_separately_forecast` authority states the intended
        // treatment but does not, by itself, prove exclusive parent coverage.
        // For captured detail, consume the candidate that re-performed that
        // proof against the current section graph and carries its certificate.
        const certifiedCapture = behavior === "captured_detail"
          ? candidates.find(
              (candidate) =>
                candidate.origin === "capture_candidate" &&
                candidate.capture_certificate,
            )
          : null;
        // A capture certificate is a fallback for THIS period. It may never
        // erase a stronger line-level observation/commitment/driver in a mixed
        // FY1/FY2/FY3 row. Historical inference is excluded by the captured
        // behavior's allowed-method set, so in an unevidenced period the
        // certificate still wins over a generic trend/carry.
        const rankedIndependent = selectForecastAuthority(compatible);
        let owner = invalidCapture ?? (anchorOwned
          ? broker
          : declaredBrokerOwned
            ? (declared?.method === "broker_consensus" ? declared : broker)
          : absoluteFormula && compatible.includes(absoluteFormula)
            ? absoluteFormula
            : rankedIndependent ??
              certifiedCapture ??
              // Deliberate absence is a valid owner of last resort: a captured
              // detail or out-of-scope row resolves to its absence declaration
              // instead of falling through to `unresolved`.  The waterfall
              // selector cannot rank these (absence has no evidence priority),
              // which previously made behavior=captured_detail unreachable —
              // every captured row compiled to a block.
              compatible.find((candidate) =>
                ["not_separately_forecast", "not_applicable"].includes(candidate.method),
              ) ??
              null);
        if (!owner) {
          const unresolved = {
            method: "unresolved",
            origin: "behavior_gate",
            source_kind: "none",
            reason: behaviorEntry?.blocking && !hasStrongAuthority
              ? `Forecast behavior for ${row.row_id} is unresolved or low confidence.`
              : `No candidate is permitted for behavior ${behavior}.`,
          };
          unresolved.rank_vector = forecastAuthorityRankVector(unresolved);
          candidates.push(unresolved);
          owner = unresolved;
        }
        const selected = owner;
        const selectedIndex = candidates.indexOf(selected);
        candidates = candidates.map((candidate, index) => ({
          ...candidate,
          candidate_id: candidateId(stateId, candidate),
          state_id: stateId,
          selected: index === selectedIndex,
          rejection_reason: index === selectedIndex
            ? null
            : allowedMethods.size > 0 && !allowedMethods.has(candidate.method)
              ? `Method ${candidate.method} is not permitted for behavior ${behavior}.`
              : anchorOwned
                ? "The broker anchor is Tier-1 consumed and outranks the identity formula on the anchor row."
                : declaredBrokerOwned
                  ? "The declared broker consumption owns this total; its accounting identity remains the fallback when broker evidence is unavailable."
              : absoluteFormula
                ? "Formula or schedule ownership outranks independent-input candidates."
                  : candidate.method === selected.method
                    ? `Equal-rung candidate ranked behind ${selected.method} on ${forecastAuthorityDecidingDimension(selected, candidate)} before stable identifier ordering.`
                    : `Stronger compatible candidate ${selected.method} selected.`,
        }));
        ledger.push(...candidates);
        const selectedRecord = candidates[selectedIndex];
        const brokerRejectionReasons = candidates
          .filter((candidate) => candidate.origin === "row_broker_rejection")
          .flatMap((candidate) =>
            (candidate.broker_rejections ?? []).map((rejection) => rejection.reason),
          );
        const [producerType, renderState] = producerAndRender(selectedRecord.method);
        const status =
          selectedRecord.method === "unresolved" &&
          (material || selectedRecord.origin === "invalid_capture_candidate")
            ? "BLOCKED"
            : "RESOLVED";
        const state = {
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
          selected_rank_vector: structuredClone(selectedRecord.rank_vector),
          value: finite(selectedRecord.value) ? Number(selectedRecord.value) : null,
          formula_spec: selectedRecord.formula_spec ?? null,
          source_bindings: sourceBindings(selectedRecord),
          render_state: renderState,
          status,
          rationale: selectedRecord.note ?? selectedRecord.reason ?? `Selected ${selectedRecord.method}.`,
          broker_rejection_reasons: brokerRejectionReasons,
        };
        const witnessedState = attachForecastProducerWitness(state, selectedRecord);
        witnessedState.status = witnessedState.producer_witness.executable
          ? state.status
          : material
            ? "BLOCKED"
            : state.status;
        states.push(witnessedState);
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
  for (const candidate of plan?.candidate_ledger ?? []) {
    if (
      JSON.stringify(candidate.rank_vector) !==
      JSON.stringify(forecastAuthorityRankVector(candidate))
    ) {
      errors.push(`${candidate.candidate_id ?? "unknown candidate"} rank proof is stale or invalid.`);
    }
  }
  for (const section of ["income_statement", "cash_flow"]) for (const row of rowsBySection?.[section] ?? []) if (row.row_type !== "header") for (let index = 0; index < 3; index += 1) expected.push(`${section}.${row.row_id}.fy${index + 1}`);
  const statesById = new Map();
  for (const state of plan?.states ?? []) {
    if (statesById.has(state.state_id)) errors.push(`Duplicate forecast state ${state.state_id}.`);
    statesById.set(state.state_id, state);
    const selected = (plan.candidate_ledger ?? []).filter((candidate) => candidate.state_id === state.state_id && candidate.selected);
    if (selected.length !== 1) errors.push(`${state.state_id} must have exactly one selected candidate; found ${selected.length}.`);
    if (selected[0]?.candidate_id !== state.selected_candidate_id) errors.push(`${state.state_id} selected candidate does not match the state.`);
    if (
      selected[0] &&
      JSON.stringify(state.selected_rank_vector) !==
        JSON.stringify(selected[0].rank_vector)
    ) {
      errors.push(`${state.state_id} selected rank proof does not match its candidate.`);
    }
    if (!state.producer_witness?.executable && state.material && state.status !== "BLOCKED") {
      errors.push(`${state.state_id} is material but has no executable producer witness.`);
    }
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
  for (const field of [
    "source_page_cell",
    "house_id",
    "definition_id",
    "units",
    "compatibility_score",
  ]) {
    if (candidate?.[field] !== undefined && candidate?.[field] !== null) {
      authority[field] = structuredClone(candidate[field]);
    }
  }
  if (candidate?.as_of_date) authority.as_of_date = candidate.as_of_date;
  if (finite(candidate?.confidence)) authority.confidence = Number(candidate.confidence);
  if (state?.selected_rank_vector) {
    authority.selection_rank = structuredClone(state.selected_rank_vector);
  }
  if (candidate?.note ?? state.rationale) authority.note = candidate?.note ?? state.rationale;
  if (state.broker_rejection_reasons?.length > 0) {
    authority.broker_rejection_reasons = structuredClone(
      state.broker_rejection_reasons,
    );
  }
  if (finite(state.value) && ["actual_plus_remainder", "contractual_commitment", "company_guidance", "company_indication", "broker_consensus", "user_assumption", "explicit_zero"].includes(state.method)) authority.value = Number(state.value);
  if (candidate?.partial_period) authority.partial_period = structuredClone(candidate.partial_period);
  if (candidate?.guidance_range) authority.guidance_range = structuredClone(candidate.guidance_range);
  if (candidate?.zero_basis) authority.zero_basis = candidate.zero_basis;
  return authority;
}

function calculationFromState(state) {
  if (["accounting_identity", "driver_formula", "roll_forward"].includes(state.method)) {
    return state.formula_spec ? structuredClone(state.formula_spec) : null;
  }
  if (!["historical_average", "historical_trend", "seasonal_run_rate", "carry_forward"].includes(state.method)) return null;
  if (state.method === "historical_average") return { operator: "historical_average", refs: [state.row_id] };
  if (state.method === "historical_trend") return { operator: "historical_trend", refs: [state.row_id], forecast_index: state.forecast_index };
  if (state.method === "carry_forward") return { operator: "prior_period", refs: [state.row_id] };
  // Seasonal run-rate is intentionally not approximated by an annual average.
  // The compiler currently admits the method only through an executable
  // partial-period authority; if a future producer emits it directly, it must
  // also teach the formula compiler a real seasonal operator.
  return null;
}

function evaluateMaterializedForecastCalculation(calculation, row) {
  if (
    !["historical_average", "historical_trend"].includes(
      calculation?.operator,
    )
  ) {
    return null;
  }
  const history = (row.values ?? []).slice(0, 3).map(Number);
  if (history.length !== 3 || history.some((value) => !Number.isFinite(value))) {
    return null;
  }
  if (calculation.operator === "historical_average") {
    return history.reduce((sum, value) => sum + value, 0) / history.length;
  }
  const slope = ((history[1] - history[0]) + (history[2] - history[1])) / 2;
  return history[2] + slope * (Number(calculation.forecast_index ?? 0) + 1);
}

/**
 * Apply a sealed forecast plan to a fresh case. This is the only bridge from
 * the candidate compiler to the existing v2 solver/renderer. It writes
 * semantic period authorities and typed formula rules, never workbook cells.
 */
export function materializeForecastPlan(modelCase, plan) {
  const next = structuredClone(modelCase);
  next.statement_structure_compiled_version = "semantic-statements/1.0";
  const rowsByKey = new Map();
  const rowsBySection = new Map();
  for (const section of ["income_statement", "cash_flow"]) {
    const sectionRows = normaliseEvaluatedHistoricalValues(
      section === "income_statement" &&
          next.controls?.broker_case === "Forecast Waterfall"
        ? applyFiledFinanceHistoricalAuthority(
            next,
            next.statement_structure?.[section] ?? [],
          )
        : next.statement_structure?.[section] ?? [],
      { preferReportedReconciliations: section === "cash_flow" },
    );
    next.statement_structure[section] = sectionRows;
    rowsBySection.set(section, sectionRows);
    for (const row of sectionRows) {
      rowsByKey.set(`${section}\u0000${row.row_id}`, row);
    }
  }
  const candidatesById = new Map((plan?.candidate_ledger ?? []).map((candidate) => [candidate.candidate_id, candidate]));
  for (const state of plan?.states ?? []) {
    const row = rowsByKey.get(`${state.section}\u0000${state.row_id}`);
    if (!row) throw new Error(`Forecast plan state ${state.state_id} refers to missing row ${state.row_id}.`);
    const candidate = candidatesById.get(state.selected_candidate_id);
    row.forecast_period_authorities ??= [null, null, null];
    row.forecast_period_authorities[state.forecast_index] = authorityFromState(state, candidate);
    const calculation = calculationFromState(state);
    if (calculation) {
      if (
        ["historical_average", "historical_trend"].includes(calculation.operator)
      ) {
        const evaluated = evaluatedHistoricalValues(
          row,
          rowsBySection.get(state.section) ?? [],
        );
        if (evaluated.every(finite)) {
          // Preserve the historical accounting formula and supply its
          // independently evaluated caches as the observation basis used by
          // both the solver and the emitted G:I-referencing forecast formula.
          // Without this, a derived historical ratio could render correctly
          // in Excel while the solver retained either nulls or an earlier
          // provisional value compiled before the statement topology closed.
          row.values ??= [null, null, null, null, null, null];
          for (let historicalIndex = 0; historicalIndex < 3; historicalIndex += 1) {
            row.values[historicalIndex] = Number(evaluated[historicalIndex]);
          }
        }
      }
      row.forecast_period_calculations ??= [null, null, null];
      row.forecast_period_calculations[state.forecast_index] = calculation;
      row.forecast_treatment = "formula";
    }
    if (finite(state.value)) {
      row.values ??= [null, null, null, null, null, null];
      const evaluatedStateValue = calculation
        ? evaluateMaterializedForecastCalculation(
            calculation,
            row,
          )
        : null;
      row.values[state.forecast_index + 3] = finite(evaluatedStateValue)
        ? Number(evaluatedStateValue)
        : Number(state.value);
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
      if (state.producer_type === "captured" && !candidate?.capture_certificate) {
        throw new Error(
          `Forecast plan state ${state.state_id} selected capture without a certificate.`,
        );
      }
      if (state.producer_type === "captured") {
        row.forecast_capture_parent_id = candidate.capture_certificate.parent_row_id;
        row.forecast_capture_mode = candidate.capture_certificate.mode;
        row.forecast_capture_note =
          candidate.note ?? `Captured by ${candidate.capture_certificate.parent_row_id}.`;
        row.forecast_capture_certificates ??= [null, null, null];
        row.forecast_capture_certificates[state.forecast_index] =
          structuredClone(candidate.capture_certificate);
      }
    }
  }
  // `uncalculated` is a legacy source/presentation classification, not an
  // instruction to discard a subsequently sealed economic forecast.  Promote
  // the row as soon as the plan gives any period an executable authority;
  // rows whose three authorities explicitly certify capture/not-applicability
  // remain deliberately blank.  The case compiler repeats this as a terminal
  // invariant, but the forecast bridge must also be correct in isolation.
  for (const row of rowsByKey.values()) {
    const authorities = row.forecast_period_authorities ?? [];
    const executable = authorities.some((authority) =>
      authority &&
      ![
        "unresolved",
        "not_separately_forecast",
        "not_applicable",
      ].includes(authority.method),
    );
    const allAbsent =
      authorities.length === 3 &&
      authorities.every((authority) =>
        ["not_separately_forecast", "not_applicable"].includes(
          authority?.method,
        ),
      );
    if (allAbsent) {
      row.forecast_treatment = "uncalculated";
      row.formula_authority = "intentionally_blank";
      if (Array.isArray(row.values)) {
        row.values = [...row.values.slice(0, 3), null, null, null];
      }
      delete row.forecast_calculation;
      delete row.forecast_period_calculations;
      // Suppression is fully described by the sealed treatment and capture
      // certificates; do not leak the compiler-only marker into model-case.
      delete row.formula_authority;
      continue;
    }
    // Global row treatment is only a compatibility hint. Mixed-period rows
    // are controlled by their explicit authorities cell by cell; leaving a
    // global `uncalculated` flag would grey and suppress all three periods.
    if (executable) {
      if (row.row_type === "uncalculated") row.row_type = "input";
      if (row.forecast_treatment === "uncalculated") {
        delete row.forecast_treatment;
      }
      if (row.formula_authority === "intentionally_blank") {
        delete row.formula_authority;
      }
    }
    // This marker is compilation scratch state, not a model-case field. The
    // sealed authority is represented by forecast_treatment, period
    // authorities and (for captured rows) the per-period certificates.
    delete row.formula_authority;
  }
  return next;
}

/**
 * Materialise only from the sealed selected-authority contract.
 *
 * The candidate ledger is intentionally projected from the contract rather
 * than accepted from the pre-contract forecast plan.  This makes the contract
 * the economic writer: changing an unselected candidate or the original plan
 * after sealing cannot change the model, while changing the contract hash or
 * any selected state necessarily does.
 */
export function materializeSelectedAuthorityContract(modelCase, contract) {
  if (contract?.schema_version !== "selected-authority-contract/1.0") {
    throw new Error("A selected-authority-contract/1.0 artifact is required for materialisation.");
  }
  const forecastAuthorities = (contract.authorities ?? []).filter(
    (authority) => authority.selected_state !== null,
  );
  if (forecastAuthorities.some((authority) => !authority.selected_state)) {
    throw new Error("Every forecast authority must carry its complete selected state.");
  }
  const states = forecastAuthorities.map((authority) =>
    structuredClone(authority.selected_state));
  const candidateLedger = forecastAuthorities
    .filter((authority) => authority.selected_candidate !== null)
    .map((authority) => structuredClone(authority.selected_candidate));
  const unresolvedMaterialCount = states.filter(
    (state) => state.status === "BLOCKED",
  ).length;
  const sealedPlan = {
    schema_version: "forecast-plan/2.0",
    case_id: contract.case_id,
    forecast_periods: [...new Set(states.map((state) => state.period_end))],
    states,
    candidate_ledger: candidateLedger,
    status: unresolvedMaterialCount === 0 ? "PASS" : "BLOCKED",
    unresolved_material_count: unresolvedMaterialCount,
  };
  const materialized = materializeForecastPlan(modelCase, sealedPlan);
  // This function is the sole selected-authority economic writer. The sealed
  // contract replaces provisional row authorities, so the forecast-authority
  // ledger must be resealed here, at the mutator, before the case can cross
  // into question planning or the solver. Later unreceipted mutations remain
  // fail-closed because verification rebuilds the ledger from the live case.
  sealForecastAuthorityLedger(materialized);
  return materialized;
}

export function validateForecastPlanCaseParity(modelCase, plan) {
  const errors = [];
  const rowsByKey = new Map();
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase?.statement_structure?.[section] ?? []) {
      rowsByKey.set(`${section}\u0000${row.row_id}`, row);
    }
  }
  for (const state of plan?.states ?? []) {
    const row = rowsByKey.get(`${state.section}\u0000${state.row_id}`);
    if (!row) {
      errors.push(`${state.state_id} row is absent from the materialized case.`);
      continue;
    }
    const resolved = resolveForecastAuthority(modelCase, row, state.forecast_index);
    if (resolved.method !== state.method) errors.push(`${state.state_id} method ${resolved.method} does not match sealed ${state.method}.`);
    if (finite(state.value) && finite(resolved.value) && Math.abs(Number(state.value) - Number(resolved.value)) > 1e-9) errors.push(`${state.state_id} value ${resolved.value} does not match sealed ${state.value}.`);
    if (
      JSON.stringify(resolved.selection_rank ?? null) !==
      JSON.stringify(state.selected_rank_vector ?? null)
    ) {
      errors.push(`${state.state_id} materialized rank proof does not match the sealed plan.`);
    }
  }
  return errors;
}
