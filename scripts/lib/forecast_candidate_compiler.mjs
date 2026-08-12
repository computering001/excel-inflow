import crypto from "node:crypto";

import {
  forecastRowMateriality,
  isScheduleOwnedForecastRole,
  resolveForecastAuthority,
  selectForecastAuthority,
} from "./forecast_authority.mjs";
import { observationsForConcept } from "./forecast_observation.mjs";
import { resolveBrokerForecastSelection, selectBrokerAnchor } from "./broker_anchor.mjs";

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
  if (behavior !== "non_recurring_event") return null;
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

function formulaCandidate(row, behavior, forecastIndex) {
  if (isScheduleOwnedForecastRole(row.semantic_role)) return { method: "schedule_link", origin: "semantic_schedule", source_kind: "schedule", ownership: "absolute", formula_spec: { operator: "schedule_link", semantic_role: row.semantic_role } };
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

function declaredCandidate(row, forecastIndex) {
  const authority = row?.forecast_period_authorities?.[forecastIndex];
  return authority ? { ...structuredClone(authority), origin: "declared_period_authority" } : null;
}

function brokerCandidate(modelCase, row, forecastIndex) {
  // Broker availability is evidence, not a presentation property.  Testing
  // the semantic role even when row planning did not pre-label the row keeps
  // working-capital and other issuer-specific aggregates independent of a
  // hardwired broker treatment while still requiring an actually resolved
  // broker selection.
  const metricIds = [...new Set([
    row?.broker_metric_id,
    row?.semantic_role,
    row?.row_id,
  ].filter(Boolean))];
  for (const metricId of metricIds) {
    const selection = resolveBrokerForecastSelection(modelCase, metricId, forecastIndex);
    if (!finite(selection?.value)) continue;
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
  return null;
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
  if (section !== "income_statement") return null;
  const rowIndex = rows.indexOf(row);
  const revenueIndex = rows.findIndex(
    (candidate) => candidate.semantic_role === "revenue",
  );
  const ebitIndex = rows.findIndex(
    (candidate) => candidate.semantic_role === "ebit",
  );
  const target = rows.find((candidate) => candidate.row_id === targetId);
  if (!target || rowIndex < 0) return null;
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
  const incomeRows = rowsBySection?.income_statement ?? [];
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
  const states = [];
  const ledger = [];
  for (const section of ["income_statement", "cash_flow"]) {
    const sectionRows = rowsBySection?.[section] ?? [];
    for (const row of sectionRows) {
      if (row.row_type === "header") continue;
      const behaviorEntry = behaviorByRow.get(`${section}\u0000${row.row_id}`);
      const declaredCalculation = row.forecast_calculation ?? row.calculation;
      const behavior = behaviorEntry?.behavior ?? (
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
        const formula = formulaCandidate(row, behavior, forecastIndex);
        if (formula) candidates.push(formula);
        // Evidence is assembled independently of formula presence.  Only a
        // genuine accounting identity or schedule link owns the row before
        // this ladder; driver and roll-forward formulas compete at their
        // declared waterfall rungs.
        candidates.push(...observationCandidates(observationInput, row, forecastIndex, windowStarts[forecastIndex], forecastPeriods[forecastIndex]));
        const inferred = historicalCandidate(row, behavior, forecastIndex);
        if (inferred) candidates.push(inferred);
        const eventZero = eventZeroCandidate(modelCase, row, behavior);
        if (eventZero) candidates.push(eventZero);
        if (behavior === "not_applicable") candidates.push({ method: "not_applicable", origin: "behavior", source_kind: "none", material: false, note: "The row is outside the applicable economic scope." });
        if (behavior === "captured_detail" && row.forecast_capture_parent_id) {
          candidates.push(captureCandidate(modelCase, row, sectionRows, forecastIndex, material, section));
        }
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
        const absoluteFormula = formula?.ownership === "absolute";
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
          : absoluteFormula && compatible.includes(formula)
            ? formula
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
              : anchorOwned
                ? "The broker anchor is Tier-1 consumed and outranks the identity formula on the anchor row."
                : absoluteFormula
                  ? "Formula or schedule ownership outranks independent-input candidates."
                  : `Stronger compatible candidate ${selected.method} selected.`,
        }));
        ledger.push(...candidates);
        const selectedRecord = candidates[selectedIndex];
        const [producerType, renderState] = producerAndRender(selectedRecord.method);
        const status =
          selectedRecord.method === "unresolved" &&
          (material || selectedRecord.origin === "invalid_capture_candidate")
            ? "BLOCKED"
            : "RESOLVED";
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
  if (candidate?.zero_basis) authority.zero_basis = candidate.zero_basis;
  return authority;
}

function calculationFromState(state) {
  if (["driver_formula", "roll_forward"].includes(state.method)) {
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

/**
 * Apply a sealed forecast plan to a fresh case. This is the only bridge from
 * the candidate compiler to the existing v2 solver/renderer. It writes
 * semantic period authorities and typed formula rules, never workbook cells.
 */
export function materializeForecastPlan(modelCase, plan) {
  const next = structuredClone(modelCase);
  next.statement_structure_compiled_version = "semantic-statements/1.0";
  const rowsByKey = new Map();
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of next.statement_structure?.[section] ?? []) {
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
      if (state.producer_type === "captured" && !candidate?.capture_certificate) {
        throw new Error(
          `Forecast plan state ${state.state_id} selected capture without a certificate.`,
        );
      }
      if (state.producer_type === "captured") {
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
  }
  return errors;
}
