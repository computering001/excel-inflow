import { resolveBrokerForecastSelection } from "./broker_anchor.mjs";

/**
 * Forecast authority is selected per row AND per forecast period.  It is not a
 * formatting label: this module converts the selected evidence path into the
 * mechanism the solver and workbook compiler must use.
 *
 * The order below is the independent-input evidence waterfall.  Formula and
 * schedule ownership are resolved before this ladder; intentionally absent
 * rows are gated before it.  A lower number is stronger authority.
 */
export const FORECAST_AUTHORITY_PRIORITY = Object.freeze({
  actual_plus_remainder: 10,
  contractual_commitment: 20,
  company_guidance: 30,
  company_indication: 40,
  broker_consensus: 50,
  user_assumption: 60,
  driver_formula: 70,
  roll_forward: 75,
  seasonal_run_rate: 80,
  historical_average: 90,
  historical_trend: 100,
  carry_forward: 110,
  explicit_zero: 120,
  unresolved: 999,
});

export const FORECAST_AUTHORITY_METHODS = Object.freeze([
  "schedule_link",
  "accounting_identity",
  ...Object.keys(FORECAST_AUTHORITY_PRIORITY),
  "not_separately_forecast",
  "not_applicable",
]);

const FORMULA_METHODS = new Set([
  "schedule_link",
  "accounting_identity",
  "driver_formula",
  "roll_forward",
]);

const HARDCODE_METHODS = new Set([
  "actual_plus_remainder",
  "contractual_commitment",
  "company_guidance",
  "company_indication",
  "user_assumption",
  "seasonal_run_rate",
  "historical_average",
  "historical_trend",
  "carry_forward",
]);

const UNCALCULATED_METHODS = new Set([
  "not_separately_forecast",
  "not_applicable",
]);

const SCHEDULE_OWNED_ROLES = new Set([
  "interest_income",
  "interest_expense",
  "cash_interest_paid",
  "cash_interest_received",
  "debt_issuance",
  "debt_repayment",
  "change_in_debt",
  "rcf_draw",
  "rcf_repayment",
  "lease_principal",
  "opening_cash",
  "ending_cash",
  "net_change_in_cash",
  "non_balancing_cash_bucket_movement",
]);

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function periodRule(row, forecastIndex) {
  if (Array.isArray(row?.forecast_period_calculations)) {
    return row.forecast_period_calculations[forecastIndex] ?? null;
  }
  return row?.forecast_calculation ?? null;
}

function rowSeriesValue(modelCase, row, forecastIndex) {
  const periodIndex = forecastIndex + 3;
  if (finite(row?.values?.[periodIndex])) return Number(row.values[periodIndex]);
  const metric = row?.semantic_role
    ? modelCase?.operating_metrics?.[row.semantic_role]
    : null;
  if (finite(metric?.values?.[periodIndex])) return Number(metric.values[periodIndex]);
  return null;
}

function directRowValue(row, forecastIndex) {
  const value = row?.values?.[forecastIndex + 3];
  return finite(value) ? Number(value) : null;
}

function metricDefinition(modelCase, semanticRole) {
  return semanticRole ? modelCase?.operating_metrics?.[semanticRole] ?? null : null;
}

function explicitAuthority(modelCase, row, forecastIndex) {
  if (Array.isArray(row?.forecast_period_authorities)) {
    return row.forecast_period_authorities[forecastIndex] ?? null;
  }
  const metric = metricDefinition(modelCase, row?.semantic_role);
  return Array.isArray(metric?.forecast_period_authorities)
    ? metric.forecast_period_authorities[forecastIndex] ?? null
    : null;
}

function authorityValue(modelCase, row, forecastIndex, authority) {
  if (authority?.method === "actual_plus_remainder") {
    const reported = authority.partial_period?.reported_to_date;
    const remainder = authority.partial_period?.forecast_remainder;
    if (finite(reported) && finite(remainder)) {
      return Number(reported) + Number(remainder);
    }
  }
  if (finite(authority?.guidance_range?.selected)) {
    return Number(authority.guidance_range.selected);
  }
  if (finite(authority?.value)) return Number(authority.value);
  return rowSeriesValue(modelCase, row, forecastIndex);
}

function mechanismForMethod(method) {
  if (FORMULA_METHODS.has(method)) return "formula";
  if (HARDCODE_METHODS.has(method)) return "hardcode";
  if (method === "broker_consensus") return "broker";
  if (method === "explicit_zero") return "zero";
  if (UNCALCULATED_METHODS.has(method)) return "uncalculated";
  return "block";
}

function inferredAuthority(modelCase, row, forecastIndex) {
  const rule = periodRule(row, forecastIndex);
  const legacy = modelCase?.forecast_authority_contract_version !== "waterfall_v1";
  const treatment = row?.forecast_treatment;
  const value = rowSeriesValue(modelCase, row, forecastIndex);

  if (row?.row_type === "header") {
    return {
      method: "not_applicable",
      source_kind: "none",
      inferred: true,
      reason: "Presentation-only header.",
    };
  }
  if (row?.operation_scope === "not_applicable") {
    return { method: "not_applicable", source_kind: "none", inferred: true };
  }
  if (
    row?.row_type === "uncalculated" ||
    treatment === "uncalculated" ||
    row?.formula_authority === "intentionally_blank"
  ) {
    return {
      method: "not_separately_forecast",
      source_kind: "none",
      inferred: true,
    };
  }
  if (SCHEDULE_OWNED_ROLES.has(row?.semantic_role)) {
    return { method: "schedule_link", source_kind: "schedule", inferred: true };
  }
  if (rule) {
    const method = ["prior_period", "prior_period_scaled_by"].includes(rule.operator)
      ? "roll_forward"
      : "accounting_identity";
    return { method, source_kind: "formula", inferred: true };
  }
  const selfCarry =
    !Array.isArray(row?.forecast_period_calculations) &&
    !row?.forecast_calculation &&
    row?.calculation?.operator === "prior_period" &&
    row.calculation.refs?.length === 1 &&
    row.calculation.refs[0] === row.row_id;
  if (selfCarry && forecastIndex === 0 && finite(value)) {
    return {
      method: "carry_forward",
      source_kind: "historical_inference",
      value,
      inferred: true,
    };
  }
  if (
    !["broker", "hardcode", "zero", "uncalculated"].includes(treatment) &&
    row?.calculation
  ) {
    const method = ["prior_period", "prior_period_scaled_by"].includes(
      row.calculation.operator,
    )
      ? "roll_forward"
      : "accounting_identity";
    return { method, source_kind: "formula", inferred: true };
  }
  if (treatment === "broker" || row?.broker_metric_id) {
    return { method: "broker_consensus", source_kind: "broker", inferred: true };
  }
  if (treatment === "zero") {
    return { method: "explicit_zero", source_kind: "none", value: 0, inferred: true };
  }
  if (treatment === "hardcode" && finite(value)) {
    return {
      method: legacy ? "user_assumption" : "unresolved",
      source_kind: legacy ? "user_supplied" : "none",
      value,
      inferred: true,
      reason: legacy
        ? "Legacy hardcode inferred from the existing row treatment."
        : "A waterfall-v1 hardcode requires an explicit period authority.",
    };
  }
  if (finite(value)) {
    return {
      method: legacy ? "user_assumption" : "unresolved",
      source_kind: legacy ? "user_supplied" : "none",
      value,
      inferred: true,
      reason: legacy
        ? "Legacy supplied value inferred from the existing case."
        : "A waterfall-v1 supplied value requires an explicit period authority.",
    };
  }
  // Old cases historically converted this state to =0. Preserve that only in
  // legacy mode; waterfall-v1 cases fail closed instead.
  return legacy
    ? {
        method: "explicit_zero",
        source_kind: "none",
        value: 0,
        inferred: true,
        reason: "Legacy implicit zero retained for archived-case compatibility.",
      }
    : {
        method: "unresolved",
        source_kind: "none",
        inferred: true,
        reason: "No forecast authority resolves this row and period.",
      };
}

/** Resolve the one executable forecast path for a row and forecast period. */
export function resolveForecastAuthority(modelCase, row, forecastIndex) {
  if (!Number.isInteger(forecastIndex) || forecastIndex < 0 || forecastIndex > 2) {
    throw new Error(`forecastIndex must be 0, 1 or 2; received ${forecastIndex}.`);
  }
  const selected = explicitAuthority(modelCase, row, forecastIndex) ??
    inferredAuthority(modelCase, row, forecastIndex);
  const method = selected.method;
  const value = authorityValue(modelCase, row, forecastIndex, selected);
  let broker = null;
  if (method === "broker_consensus") {
    broker = resolveBrokerForecastSelection(
      modelCase,
      row?.broker_metric_id ?? row?.semantic_role,
      forecastIndex,
    );
  }
  return {
    ...selected,
    method,
    mechanism: mechanismForMethod(method),
    declared_value: finite(selected?.value) ? Number(selected.value) : null,
    value,
    broker_value: finite(broker?.value) ? Number(broker.value) : null,
    broker_selection: broker,
    forecast_index: forecastIndex,
  };
}

/** Resolve an operating metric that is consumed outside a visible statement row. */
export function resolveMetricForecastAuthority(modelCase, metricId, forecastIndex) {
  const metric = metricDefinition(modelCase, metricId);
  if (!metric) {
    return {
      method: "unresolved",
      source_kind: "none",
      mechanism: "block",
      value: null,
      broker_value: null,
      broker_selection: null,
      forecast_index: forecastIndex,
      reason: `Operating metric ${metricId} is absent.`,
    };
  }
  const treatment = metric.forecast_method === "not_applicable"
    ? "uncalculated"
    : metric.source_kind === "broker"
      ? "broker"
      : "hardcode";
  return resolveForecastAuthority(
    modelCase,
    {
      row_id: `operating_metrics.${metricId}`,
      row_type: treatment === "uncalculated" ? "uncalculated" : "input",
      semantic_role: metricId,
      values: metric.values,
      forecast_treatment: treatment,
      broker_metric_id: treatment === "broker" ? metricId : undefined,
      forecast_period_authorities: metric.forecast_period_authorities,
    },
    forecastIndex,
  );
}

/**
 * Select the strongest compatible independent-input candidate. Applicability
 * gates and formula/schedule ownership must be handled before calling this.
 */
export function selectForecastAuthority(candidates) {
  const usable = (candidates ?? []).filter(
    (candidate) =>
      candidate &&
      Object.hasOwn(FORECAST_AUTHORITY_PRIORITY, candidate.method),
  );
  return [...usable].sort(
    (left, right) =>
      FORECAST_AUTHORITY_PRIORITY[left.method] -
        FORECAST_AUTHORITY_PRIORITY[right.method] ||
      String(left.source_id ?? "").localeCompare(String(right.source_id ?? "")),
  )[0] ?? null;
}

export function validateForecastAuthorities(modelCase, rows = []) {
  const errors = [];
  const strict = modelCase?.forecast_authority_contract_version === "waterfall_v1";
  const rowsById = new Map(rows.map((row) => [row?.row_id, row]));
  const allowedSourceKinds = {
    schedule_link: new Set(["schedule", "formula"]),
    accounting_identity: new Set(["formula"]),
    actual_plus_remainder: new Set(["company_reported"]),
    contractual_commitment: new Set(["company_reported", "company_guidance", "user_supplied"]),
    company_guidance: new Set(["company_guidance"]),
    company_indication: new Set(["company_indication", "company_reported"]),
    broker_consensus: new Set(["broker"]),
    user_assumption: new Set(["user_supplied"]),
    driver_formula: new Set(["formula", "user_supplied"]),
    roll_forward: new Set(["formula", "user_supplied"]),
    seasonal_run_rate: new Set(["historical_inference"]),
    historical_average: new Set(["historical_inference"]),
    historical_trend: new Set(["historical_inference"]),
    carry_forward: new Set(["historical_inference"]),
    explicit_zero: new Set(["none", "company_reported", "user_supplied"]),
    not_separately_forecast: new Set(["none"]),
    not_applicable: new Set(["none"]),
    unresolved: new Set(["none"]),
  };
  for (const row of rows) {
    if (row?.row_type === "header") continue;
    const declarations = row?.forecast_period_authorities;
    if (declarations !== undefined && (!Array.isArray(declarations) || declarations.length !== 3)) {
      errors.push(`${row.row_id}.forecast_period_authorities must contain exactly three entries.`);
      continue;
    }
    for (let index = 0; index < 3; index += 1) {
      const authority = resolveForecastAuthority(modelCase, row, index);
      const label = `${row.row_id}.forecast_period_authorities[${index}]`;
      if (!FORECAST_AUTHORITY_METHODS.includes(authority.method)) {
        errors.push(`${label} uses unsupported method ${authority.method}.`);
        continue;
      }
      if (
        authority.source_kind &&
        !allowedSourceKinds[authority.method]?.has(authority.source_kind)
      ) {
        errors.push(
          `${label} uses source_kind ${authority.source_kind}, which is incompatible with ${authority.method}.`,
        );
      }
      if (authority.method === "unresolved") {
        errors.push(`${label} is unresolved: ${authority.reason ?? "no reason supplied"}`);
      }
      if (authority.method === "broker_consensus" && !finite(authority.broker_value)) {
        errors.push(`${label} selects broker consensus but no compatible broker value resolves.`);
      }
      if (HARDCODE_METHODS.has(authority.method) && !finite(authority.value)) {
        errors.push(`${label} selects ${authority.method} but no numeric forecast value resolves.`);
      }
      const statedValue = rowSeriesValue(modelCase, row, index);
      if (
        HARDCODE_METHODS.has(authority.method) &&
        finite(statedValue) &&
        finite(authority.value) &&
        Math.abs(Number(statedValue) - Number(authority.value)) > 1e-9
      ) {
        errors.push(`${label} resolves ${authority.value} but the row carries ${statedValue}.`);
      }
      if (authority.method === "actual_plus_remainder") {
        const partial = authority.partial_period;
        if (!finite(partial?.reported_to_date) || !finite(partial?.forecast_remainder)) {
          errors.push(`${label} requires numeric reported_to_date and forecast_remainder.`);
        }
        if (!partial?.reported_through) {
          errors.push(`${label} requires reported_through.`);
        }
        if (
          finite(authority.declared_value) &&
          finite(partial?.reported_to_date) &&
          finite(partial?.forecast_remainder) &&
          Math.abs(
            Number(authority.declared_value) -
              (Number(partial.reported_to_date) + Number(partial.forecast_remainder)),
          ) > 1e-9
        ) {
          errors.push(`${label} value disagrees with reported_to_date plus forecast_remainder.`);
        }
      }
      if (authority.method === "explicit_zero" && finite(authority.value) && Number(authority.value) !== 0) {
        errors.push(`${label} is explicit_zero but carries ${authority.value}.`);
      }
      if (authority.guidance_range) {
        const low = Number(authority.guidance_range.low);
        const high = Number(authority.guidance_range.high);
        const selected = Number(authority.guidance_range.selected);
        if (!(low <= high && selected >= low && selected <= high)) {
          errors.push(`${label} has an invalid guidance range or selected value outside the range.`);
        }
        const policy = authority.guidance_range.selection_policy;
        const expected = policy === "low"
          ? low
          : policy === "high"
            ? high
            : policy === "midpoint"
              ? (low + high) / 2
              : null;
        if (expected !== null && Math.abs(selected - expected) > 1e-9) {
          errors.push(`${label} selected value does not follow its ${policy} range policy.`);
        }
      }
      if (UNCALCULATED_METHODS.has(authority.method) && finite(directRowValue(row, index))) {
        errors.push(`${label} is ${authority.method} but the forecast cell contains a value.`);
      }
      if (
        strict &&
        authority.inferred &&
        authority.mechanism === "hardcode"
      ) {
        errors.push(`${label} is a hardcode without an explicit waterfall-v1 authority.`);
      }
      if (
        strict &&
        [
          "actual_plus_remainder",
          "contractual_commitment",
          "company_guidance",
          "company_indication",
        ].includes(authority.method) &&
        (!authority.source_id || !authority.as_of_date)
      ) {
        errors.push(`${label} requires source_id and as_of_date for ${authority.method}.`);
      }
      if (
        strict &&
        [
          "user_assumption",
          "seasonal_run_rate",
          "historical_average",
          "historical_trend",
          "carry_forward",
          "explicit_zero",
          "not_separately_forecast",
          "not_applicable",
        ].includes(authority.method) &&
        !authority.note
      ) {
        errors.push(`${label} requires a rationale note for ${authority.method}.`);
      }
      if (strict && authority.method === "not_separately_forecast") {
        const parent = row.parent_row_id ? rowsById.get(row.parent_row_id) : null;
        if (!parent || parent.row_id === row.row_id) {
          errors.push(
            `${label} requires a valid parent_row_id whose forecast captures the unforecast detail.`,
          );
        } else {
          const parentAuthority = resolveForecastAuthority(modelCase, parent, index);
          if (["block", "uncalculated"].includes(parentAuthority.mechanism)) {
            errors.push(
              `${label} points to ${parent.row_id}, but that parent has no calculated forecast authority in the same period.`,
            );
          }
        }
      }
    }
  }

  for (const [metricId, metric] of Object.entries(modelCase?.operating_metrics ?? {})) {
    if (!Array.isArray(metric?.forecast_period_authorities)) continue;
    if (metric.forecast_period_authorities.length !== 3) {
      errors.push(`operating_metrics.${metricId}.forecast_period_authorities must contain exactly three entries.`);
      continue;
    }
    for (let index = 0; index < 3; index += 1) {
      const authority = resolveMetricForecastAuthority(modelCase, metricId, index);
      const label = `operating_metrics.${metricId}.forecast_period_authorities[${index}]`;
      if (authority.mechanism === "block") {
        errors.push(`${label} is unresolved: ${authority.reason ?? authority.method}`);
      }
      if (authority.mechanism === "broker" && !finite(authority.broker_value)) {
        errors.push(`${label} selects broker consensus but no compatible broker value resolves.`);
      }
      if (HARDCODE_METHODS.has(authority.method) && !finite(authority.value)) {
        errors.push(`${label} selects ${authority.method} but no numeric value resolves.`);
      }
    }
  }
  return errors;
}
