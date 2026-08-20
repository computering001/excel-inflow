import fs from "node:fs";
import { validateJsonSchema } from "./json_schema.mjs";
import { SCHEDULE_PRODUCER_BY_ROLE } from "./forecast_producer_contract.mjs";
import { canonicalSemanticRole, isStructuredEventRole } from "./semantic_roles.mjs";

const SCHEMA = JSON.parse(fs.readFileSync(
  new URL("../../assets/forecast-behavior-map-v1.schema.json", import.meta.url),
  "utf8",
));

export const FORECAST_BEHAVIOR_SCHEMA_VERSION = "forecast-behavior-map/1.0";
export const FORECAST_BEHAVIOR_CLASSIFIER_VERSION = "forecast-behavior/v1";
export const FORECAST_BEHAVIOR_CONFIDENCE_THRESHOLD = 0.75;

export const FORECAST_BEHAVIORS = Object.freeze([
  "accounting_identity",
  "schedule_owned",
  "recurring_flow",
  "driver_linked_flow",
  "seasonal_flow",
  "contractual_flow",
  "lumpy_discretionary_flow",
  "non_recurring_event",
  "captured_detail",
  "not_applicable",
]);

export const ALLOWED_METHODS_BY_BEHAVIOR = Object.freeze({
  accounting_identity: Object.freeze(["accounting_identity"]),
  schedule_owned: Object.freeze(["schedule_link"]),
  recurring_flow: Object.freeze([
    "actual_plus_remainder", "company_guidance", "company_indication",
    "broker_consensus", "user_assumption", "driver_formula",
    "historical_average", "historical_trend", "carry_forward", "explicit_zero",
  ]),
  driver_linked_flow: Object.freeze([
    "actual_plus_remainder", "company_guidance", "company_indication",
    "broker_consensus", "user_assumption", "driver_formula", "roll_forward",
    // A semantic relationship (tax, working capital, D&A) identifies the
    // preferred mechanism; it does not manufacture a driver that the evidence
    // did not supply. The universal waterfall must still reach its evidenced
    // historical rungs rather than block an otherwise forecastable line.
    "historical_average", "historical_trend", "carry_forward", "explicit_zero",
  ]),
  seasonal_flow: Object.freeze([
    "actual_plus_remainder", "company_guidance", "company_indication",
    "broker_consensus", "user_assumption", "seasonal_run_rate", "explicit_zero",
  ]),
  contractual_flow: Object.freeze([
    "actual_plus_remainder", "contractual_commitment", "company_guidance",
    "company_indication", "user_assumption", "explicit_zero",
  ]),
  lumpy_discretionary_flow: Object.freeze([
    "actual_plus_remainder", "company_guidance", "company_indication",
    "broker_consensus", "user_assumption", "historical_average", "explicit_zero",
  ]),
  non_recurring_event: Object.freeze([
    "actual_plus_remainder", "contractual_commitment", "company_guidance",
    "company_indication", "user_assumption", "explicit_zero",
    "not_separately_forecast",
  ]),
  // Capture is a per-period fallback, not a global eraser. A detail line may
  // have a stronger FY1 observation and still be captured by its headline in
  // FY2/FY3. Historical inference is deliberately excluded: a generic trend
  // is not stronger than a certified top-down authority.
  captured_detail: Object.freeze([
    "actual_plus_remainder", "contractual_commitment", "company_guidance",
    "company_indication", "broker_consensus", "user_assumption",
    "driver_formula", "roll_forward", "not_separately_forecast",
  ]),
  not_applicable: Object.freeze(["not_applicable"]),
});

const SCHEDULE_ROLES = new Set(Object.keys(SCHEDULE_PRODUCER_BY_ROLE));

const IDENTITY_ROLES = new Set([
  "revenue", "gross_profit", "operating_profit", "ebit", "ebitda",
  "adjusted_ebitda", "reported_ebitda", "pre_tax_income", "profit_before_tax", "net_income",
  "cash_generated_from_operations", "cash_from_operations",
  "cash_from_investing", "cash_from_financing", "free_cash_flow",
]);

const NON_RECURRING_ROLES = new Set([
  "acquisitions_net_of_cash", "acquisition", "acquisition_cost", "business_combination", "disposal",
  "contingent_consideration",
  "litigation", "legal_settlement", "restructuring", "impairment_loss",
  "exceptional_item", "discontinued_operation",
]);

const LUMPY_ROLES = new Set([
  "capex", "capital_expenditure", "buyback", "share_repurchase",
  "dividends_paid", "special_dividend", "asset_purchase", "asset_disposal",
]);

const DRIVER_ROLES = new Set([
  "acquisition_consideration", "acquisition_debt_proceeds",
  "opening_cash",
  "change_in_working_capital", "cash_taxes", "tax_expense",
  "depreciation_and_amortisation", "depreciation", "amortisation",
  "cost_of_sales", "selling_general_administrative_expense",
]);

const RECURRING_DIRECT_CASH_ROLES = new Set([
  "customer_receipts", "cash_received_from_customers", "supplier_payments",
  "cash_paid_to_suppliers", "employee_payments", "cash_paid_to_employees",
]);

const IDENTITY_OPERATORS = new Set([
  "sum", "link", "subtract", "ratio", "negated_ratio", "growth", "tax", "negate",
  "negate_sum", "average",
]);

const DRIVER_OPERATORS = new Set(["prior_period", "prior_period_scaled_by"]);

function normalise(value) {
  return String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function roleOf(row) {
  return canonicalSemanticRole(row?.semantic_role ?? row?.classified_role ?? row?.role);
}

function sourceRows(modelCase, row, section) {
  const sourceIds = new Set([
    ...(row?.source_line_ids ?? []),
    ...(row?.classification_source_line_ids ?? []),
  ]);
  return (modelCase?.source_coverage?.[section] ?? []).filter((source) =>
    (source?.mapped_row_ids ?? []).includes(row?.row_id) ||
    sourceIds.has(source?.source_line_id),
  );
}

function materiality(modelCase, row, section) {
  if (typeof row?.material === "boolean") return { value: row.material, known: true };
  if (typeof row?.is_material === "boolean") return { value: row.is_material, known: true };
  if (normalise(row?.materiality) === "material") return { value: true, known: true };
  if (normalise(row?.materiality) === "immaterial") return { value: false, known: true };
  const sources = sourceRows(modelCase, row, section);
  if (sources.some((source) => source?.material === true)) return { value: true, known: true };
  if (sources.length > 0 && sources.every((source) => source?.material === false)) {
    return { value: false, known: true };
  }
  // Unknown materiality is treated conservatively.  The map records that the
  // value is not evidenced, so a low-confidence classification cannot pass by
  // merely omitting a material flag.
  return { value: true, known: false };
}

function descriptorText(modelCase, row, section) {
  const sources = sourceRows(modelCase, row, section);
  return normalise([
    row?.label,
    row?.movement_type,
    row?.cash_flow_movement_type,
    row?.forecast_behavior_hint,
    row?.forecast_treatment,
    row?.source_kind,
    row?.evidence_type,
    row?.evidence_description,
    row?.reason,
    row?.note,
    row?.assumption_note,
    ...sources.flatMap((source) => [
      source?.label, source?.classified_role, source?.source_kind,
      source?.evidence_type, source?.reason, source?.note,
    ]),
  ].filter(Boolean).join(" "));
}

function calculationRules(row) {
  return [
    row?.calculation,
    row?.forecast_calculation,
    ...(row?.forecast_period_calculations ?? []),
  ].filter(Boolean);
}

function hasLiveParentCapture(row) {
  return Boolean(row?.forecast_capture_parent_id) &&
    ["uncalculated", "not_separately_forecast", "captured_detail"]
      .includes(normalise(row?.forecast_treatment).replaceAll(" ", "_"));
}

function feature(channel, name, supports, weight) {
  return { channel, feature: name, supports, weight };
}

function classifySignals(modelCase, row, section, rows) {
  const role = roleOf(row);
  const descriptor = descriptorText(modelCase, row, section);
  const rules = calculationRules(row);
  const operators = new Set(rules.map((rule) => normalise(rule?.operator).replaceAll(" ", "_")));
  const referencedIds = new Set(rules.flatMap((rule) => rule?.refs ?? []));
  const referencedRows = (rows ?? []).filter((candidate) => referencedIds.has(candidate?.row_id));
  const referencedRoles = new Set(referencedRows.map(roleOf));
  const result = [];
  const add = (channel, name, supports, weight) => result.push(feature(channel, name, supports, weight));

  if (row?.row_type === "header" || row?.operation_scope === "not_applicable") {
    add("row_semantics", "presentation_or_scope_not_applicable", "not_applicable", 0.99);
    return result;
  }
  if (hasLiveParentCapture(row)) {
    add("calculation_topology", "forecast_captured_by_declared_parent", "captured_detail", 0.98);
    return result;
  }

  const scheduleSection = includesAny(normalise(section), ["debt", "interest", "lease", "rcf", "liquidity"]);
  const scheduleOwner = normalise(row?.calculation_owner ?? row?.forecast_owner ?? row?.owner_schedule);
  if (SCHEDULE_ROLES.has(role) || scheduleSection || includesAny(scheduleOwner, ["debt", "interest", "lease", "rcf", "cash sweep", "liquidity"])) {
    add("row_semantics", "schedule_economic_owner", "schedule_owned", 0.98);
    return result;
  }

  // Effective tax rate is historically derived but forecast as an economic
  // driver. Treating its historical tax/PBT formula as an absolute forecast
  // identity creates the circular pair tax = PBT*rate and rate = tax/PBT
  // whenever broker authority is unavailable. The normal evidence waterfall
  // must instead choose guidance, broker, assumption or historical inference.
  if (role === "effective_tax_rate") {
    add("row_semantics", "forecast_tax_rate_driver", "driver_linked_flow", 0.96);
    return result;
  }

  // A structured driver role outranks incidental words in the filed label.
  // In particular, a combined recurring D&A line may read “depreciation,
  // amortisation and impairment”; the word impairment must not turn the
  // entire recurring bridge into a one-off event and zero its forecast.
  if (DRIVER_ROLES.has(role)) {
    add("row_semantics", "structured_forecast_driver_role", "driver_linked_flow", 0.96);
    return result;
  }

  // A declared forecast roll-forward is temporal authority and outranks an
  // empty or historical same-row identity. This is particularly important at
  // the cash boundary: opening cash reads the preceding period's ending cash,
  // and must never be rejected because its filed historical shell is a
  // calculation row.
  if ([...operators].some((operator) => DRIVER_OPERATORS.has(operator))) {
    add(
      "calculation_topology",
      "explicit_temporal_roll_forward",
      "driver_linked_flow",
      0.99,
    );
    return result;
  }

  const rowTypeIdentity = rules.some((rule) =>
    IDENTITY_OPERATORS.has(normalise(rule?.operator).replaceAll(" ", "_")),
  );
  if (rowTypeIdentity || (IDENTITY_ROLES.has(role) && rules.length > 0)) {
    add("calculation_topology", "formula_identity_over_declared_dependencies", "accounting_identity", 0.96);
    return result;
  }

  if (NON_RECURRING_ROLES.has(role) || isStructuredEventRole(role)) {
    add("row_semantics", "non_recurring_semantic_role", "non_recurring_event", 0.96);
  }
  if (
    ["debt issuance cost", "other cash debt movement"].includes(
      normalise(row?.movement_type),
    )
  ) {
    // Financing transaction movements are discrete events, not a recurring
    // run-rate.  Debt principal issuance/repayment roles are intercepted by
    // schedule ownership above; this signal is for the residual transaction
    // rows that otherwise used to repeat the latest filed cash flow forever.
    add("movement_type", "discrete_financing_transaction", "non_recurring_event", 0.97);
  }
  const structuredEvent =
    (NON_RECURRING_ROLES.has(role) || isStructuredEventRole(role)) ||
    ["debt issuance cost", "other cash debt movement"].includes(
      normalise(row?.movement_type),
    );
  if (!structuredEvent && includesAny(descriptor, [
    "acquisition", "business combination", "merger", "litigation", "legal settlement",
    "restructuring", "impairment", "exceptional", "one off", "one time",
    "non recurring", "discontinued operation", "debt issuance cost",
    "financing transaction cost", "transaction fee",
  ])) {
    // Event-like wording is not evidence that the cash flow ends. Without a
    // structured semantic role or movement declaration, keep it visible as a
    // lumpy line and use the evidenced historical waterfall. Only the
    // structured branches above may activate the zero-event backstop.
    add(
      "source_evidence",
      "event_like_descriptor_without_structured_nonrecurrence_authority",
      "lumpy_discretionary_flow",
      0.9,
    );
  }

  if (includesAny(normalise(row?.movement_type), ["seasonal", "seasonality"]) ||
      includesAny(descriptor, ["seasonal pattern", "seasonality", "seasonal run rate"])) {
    add("movement_type", "seasonal_timing_pattern", "seasonal_flow", 0.92);
  }

  if (includesAny(normalise(row?.movement_type), ["contractual", "committed"]) ||
      includesAny(descriptor, ["contractual commitment", "committed amount", "take or pay", "minimum purchase"])) {
    add("movement_type", "contractual_or_committed_amount", "contractual_flow", 0.9);
  }

  if (LUMPY_ROLES.has(role)) {
    add("row_semantics", "discretionary_lumpy_semantic_role", "lumpy_discretionary_flow", 0.9);
  }
  if (includesAny(descriptor, [
    "capital expenditure", "capex", "share repurchase", "buyback", "special dividend",
    "discretionary", "project spend", "asset purchase",
  ])) {
    add("source_evidence", "lumpy_or_discretionary_descriptor", "lumpy_discretionary_flow", 0.82);
  }

  const driverTopology = [...operators].some((operator) => DRIVER_OPERATORS.has(operator)) ||
    Boolean(row?.forecast_driver_id ?? row?.driver_row_id ?? row?.driver_metric) ||
    includesAny(descriptor, ["percent of revenue", "margin assumption", "linked driver", "roll forward", "days assumption"]);
  if (driverTopology) {
    add("calculation_topology", "explicit_driver_or_roll_forward_dependency", "driver_linked_flow", 0.91);
  } else if (DRIVER_ROLES.has(role) || [...referencedRoles].some((candidate) => ["revenue", "ebit", "ebitda"].includes(candidate))) {
    add("calculation_topology", "semantic_driver_relationship", "driver_linked_flow", 0.78);
  }

  const recurringMovement = includesAny(normalise(row?.movement_type), ["recurring", "operating", "ordinary"]);
  if (recurringMovement || RECURRING_DIRECT_CASH_ROLES.has(role)) {
    add("movement_type", "ordinary_recurring_flow", "recurring_flow", 0.88);
  } else if (includesAny(descriptor, ["recurring", "run rate", "ordinary course", "customer receipts", "supplier payments", "payroll"])) {
    add("source_evidence", "recurring_source_descriptor", "recurring_flow", 0.76);
  } else if (["income_statement", "cash_flow"].includes(section) && row?.row_type === "input") {
    add("statement_context", "independent_statement_flow", "recurring_flow", 0.52);
  }

  if (result.length === 0) {
    add("statement_context", "insufficient_semantic_behavior_evidence", "recurring_flow", 0.3);
  }
  return result;
}

function scoreSignals(signals) {
  const scores = new Map(FORECAST_BEHAVIORS.map((behavior) => [behavior, 0]));
  for (const signal of signals) {
    scores.set(signal.supports, Math.max(scores.get(signal.supports) ?? 0, signal.weight));
  }
  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Classify one semantic row without using issuer identity, workbook address or
 * physical row order.  The result is a behavioral prior only; the existing
 * forecast-authority waterfall still chooses the per-period method and value.
 */
export function classifyForecastBehavior(modelCase, row, { section, rows = [] } = {}) {
  if (!row?.row_id) throw new Error("Forecast behavior classification requires row_id.");
  if (!section) throw new Error(`Forecast behavior classification requires section for ${row.row_id}.`);
  const signals = classifySignals(modelCase, row, section, rows);
  const ranked = scoreSignals(signals);
  const [behavior, topScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const margin = topScore - secondScore;
  const ambiguous = ranked.length > 1 && margin < 0.2;
  const confidence = Number((ambiguous ? Math.min(topScore, 0.69) : topScore).toFixed(2));
  const materialInfo = materiality(modelCase, row, section);
  const blocking = materialInfo.value &&
    (ambiguous || confidence < FORECAST_BEHAVIOR_CONFIDENCE_THRESHOLD);
  const selectedFeatures = signals
    .filter((item) => item.supports === behavior || item.weight >= 0.75)
    .sort((a, b) => b.weight - a.weight || a.feature.localeCompare(b.feature));
  if (!materialInfo.known) {
    selectedFeatures.push(feature("materiality", "materiality_not_evidenced", behavior, 0));
  }
  const rationaleBits = selectedFeatures
    .filter((item) => item.supports === behavior)
    .slice(0, 3)
    .map((item) => item.feature.replaceAll("_", " "));
  const rationale = `${behavior.replaceAll("_", " ")} because ${rationaleBits.join("; ") || "the available row semantics provide only a weak prior"}.`;
  return {
    row_id: row.row_id,
    section,
    behavior,
    confidence,
    rationale,
    allowed_methods: [...ALLOWED_METHODS_BY_BEHAVIOR[behavior]],
    evidence_features: selectedFeatures,
    material: materialInfo.value,
    materiality_known: materialInfo.known,
    ambiguous,
    blocking,
  };
}

function rowViolations(row) {
  const violations = [];
  if (!row.materiality_known && row.material && row.blocking) {
    violations.push({
      code: "MATERIALITY_UNRESOLVED",
      row_id: row.row_id,
      section: row.section,
      message: "Materiality is not evidenced and the behavior classification cannot safely default.",
    });
  }
  if (row.material && row.ambiguous) {
    violations.push({
      code: "AMBIGUOUS_MATERIAL_BEHAVIOR",
      row_id: row.row_id,
      section: row.section,
      message: "Competing forecast behaviors are insufficiently separated for a material row.",
    });
  } else if (row.material && row.confidence < FORECAST_BEHAVIOR_CONFIDENCE_THRESHOLD) {
    violations.push({
      code: "LOW_CONFIDENCE_MATERIAL_BEHAVIOR",
      row_id: row.row_id,
      section: row.section,
      message: `Material row behavior confidence ${row.confidence} is below ${FORECAST_BEHAVIOR_CONFIDENCE_THRESHOLD}.`,
    });
  }
  return violations;
}

/** Compile a deterministic, row-order-independent map for candidate compilers. */
export function compileForecastBehaviorMap(modelCase, rowsBySection) {
  const entries = rowsBySection instanceof Map
    ? [...rowsBySection.entries()]
    : Object.entries(rowsBySection ?? {});
  const rows = entries.flatMap(([section, sectionRows]) =>
    (sectionRows ?? []).map((row) =>
      classifyForecastBehavior(modelCase, row, { section, rows: sectionRows }),
    ),
  ).sort((a, b) => a.section.localeCompare(b.section) || a.row_id.localeCompare(b.row_id));
  const violations = rows.flatMap(rowViolations);
  return {
    schema_version: FORECAST_BEHAVIOR_SCHEMA_VERSION,
    classifier_version: FORECAST_BEHAVIOR_CLASSIFIER_VERSION,
    case_id: modelCase?.case_id ?? null,
    status: violations.length === 0 ? "PASS" : "BLOCK",
    confidence_threshold: FORECAST_BEHAVIOR_CONFIDENCE_THRESHOLD,
    rows,
    violations,
  };
}

/**
 * Validate both the strict JSON shape and the fail-closed semantic contract.
 * Returns evidence rather than throwing so a caller can report every defect.
 */
export function validateForecastBehaviorMap(map) {
  const violations = validateJsonSchema(map, SCHEMA).map((message) => ({
    code: "SCHEMA_VIOLATION",
    message,
  }));
  const seen = new Set();
  for (const row of map?.rows ?? []) {
    const key = `${row?.section}\u0000${row?.row_id}`;
    if (seen.has(key)) violations.push({ code: "DUPLICATE_ROW", message: `Duplicate behavior row ${row.row_id} in ${row.section}.` });
    seen.add(key);
    const expectedMethods = ALLOWED_METHODS_BY_BEHAVIOR[row?.behavior];
    if (expectedMethods && JSON.stringify(row.allowed_methods) !== JSON.stringify([...expectedMethods])) {
      violations.push({ code: "METHOD_BEHAVIOR_MISMATCH", message: `Allowed methods do not match behavior ${row.behavior} for ${row.row_id}.` });
    }
    const expectedBlocking = Boolean(row?.material) && (
      row?.ambiguous === true ||
      Number(row?.confidence) < FORECAST_BEHAVIOR_CONFIDENCE_THRESHOLD
    );
    if (row?.blocking !== expectedBlocking) {
      violations.push({ code: "BLOCKING_FLAG_MISMATCH", message: `Blocking flag is inconsistent for ${row?.row_id ?? "unknown row"}.` });
    }
  }
  const expectedRowViolations = (map?.rows ?? []).flatMap(rowViolations);
  if (JSON.stringify(map?.violations ?? []) !== JSON.stringify(expectedRowViolations)) {
    violations.push({ code: "VIOLATION_LEDGER_MISMATCH", message: "Violation ledger does not match row-level blocking conditions." });
  }
  const expectedStatus = expectedRowViolations.length === 0 ? "PASS" : "BLOCK";
  if (map?.status !== expectedStatus) {
    violations.push({ code: "STATUS_MISMATCH", message: `Artifact status must be ${expectedStatus}.` });
  }
  return {
    status: violations.length === 0 ? "PASS" : "FAIL",
    valid: violations.length === 0,
    total_violations: violations.length,
    violations,
  };
}
