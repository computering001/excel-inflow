import { canonicalJson, hashValue } from "./run_store.mjs";

export const OWNERSHIP_CENSUS_VERSION = "ownership-census/1.0";

const FALLBACK_METHODS = new Set([
  "historical_average", "historical_trend", "carry_forward", "seasonal_run_rate",
  "driver_formula", "roll_forward", "explicit_zero",
]);
const DIRECT_FORECAST_OWNERS = new Set([
  "guidance_owned", "broker_owned", "user_override", "user_assumption",
  "historical_fallback", "schedule_owned",
]);

function material(row) {
  return row?.row_type !== "header" && row?.material !== false && row?.is_material !== false;
}

function historicalOwner(row) {
  if (row?.row_type === "header") return "not_applicable";
  if (row?.historical_authority) return row.historical_authority;
  if (row?.calculation) return "derived_formula";
  if (row?.row_type === "uncalculated") return "not_applicable";
  if (["input", "subtotal"].includes(row?.row_type) ||
      (row?.values ?? []).slice(0, 3).some((value) => Number.isFinite(Number(value)))) return "source_input";
  return "unresolved";
}

function forecastOwner(row, authority) {
  if (row?.row_type === "header" || authority?.method === "not_applicable") return "not_applicable";
  if (row?.forecast_capture_parent_id || authority?.method === "not_separately_forecast") return "captured";
  if (!authority && (row?.calculation || row?.forecast_calculation || row?.forecast_treatment === "formula")) return "parent_owned";
  if (!authority && ["schedule", "schedule_link"].includes(row?.forecast_treatment)) return "schedule_owned";
  if (!authority && row?.row_type === "uncalculated") return "not_applicable";
  if (authority?.status === "BLOCK" || authority?.method === "unresolved" || !authority) return "blocked";
  if (authority.method === "schedule_link") return "schedule_owned";
  if (["accounting_identity", "formula", "driver_formula", "roll_forward"].includes(authority.method)) {
    return row?.calculation?.refs?.length ? "parent_owned" : "child_owned";
  }
  if (["selected_broker", "broker_consensus"].includes(authority.method)) return "broker_owned";
  if (["company_guidance", "company_indication"].includes(authority.method)) return "guidance_owned";
  if (authority.method === "user_assumption") return authority.user_override === true ? "user_override" : "user_assumption";
  if (FALLBACK_METHODS.has(authority.method)) return "historical_fallback";
  return row?.parent_row_id ? "child_owned" : "parent_owned";
}

function mechanism(owner, authority) {
  if (owner === "source_input") return "source_input";
  if (["derived_formula", "reported_total_reconciled", "parent_owned", "child_owned"].includes(owner)) return "same_sheet_formula";
  if (owner === "schedule_link" || owner === "schedule_owned") return "schedule_link";
  if (owner === "broker_owned") return "broker_link";
  if (["guidance_owned", "user_override", "user_assumption"].includes(owner)) return "visible_hardcode";
  if (owner === "historical_fallback") return "formula_driven_fallback";
  if (owner === "captured") return "captured_by_parent";
  if (owner === "blocked" || owner === "unresolved") return "blocked";
  return "not_applicable";
}

function statementRows(modelCase) {
  return ["income_statement", "cash_flow"].flatMap((section) =>
    (modelCase?.statement_structure?.[section] ?? []).map((row) => ({ section, row })),
  );
}

export function buildOwnershipCensus(modelCase) {
  const periods = modelCase?.periods ?? [];
  if (periods.length !== 6 || periods.filter((period) => period.status === "historical").length !== 3 ||
      periods.filter((period) => period.status === "forecast").length !== 3) {
    throw new Error("ownership census requires exactly three historical and three forecast periods");
  }
  const records = [];
  const violations = [];
  const forecastPeriods = periods.filter((period) => period.status === "forecast");
  for (const { section, row } of statementRows(modelCase)) {
    const rowId = String(row?.row_id ?? "(missing-row-id)");
    const historyOwner = historicalOwner(row);
    for (const [periodIndex, period] of periods.entries()) {
      const isHistorical = period.status === "historical";
      const forecastIndex = isHistorical ? -1 : forecastPeriods.findIndex((candidate) => candidate === period);
      const authority = isHistorical ? null : row?.forecast_period_authorities?.[forecastIndex] ?? null;
      const owner = isHistorical ? historyOwner : forecastOwner(row, authority);
      const status = ["blocked", "unresolved"].includes(owner) && material(row) ? "BLOCK" : "PASS";
      if (status === "BLOCK") violations.push(`${rowId}:${period.date} has unresolved ${period.status} ownership`);
      records.push({
        row_id: rowId,
        model_node_id: row?.model_node_id ?? rowId,
        section,
        period_end: String(period.date),
        period_index: periodIndex,
        period_status: period.status,
        historical_owner: isHistorical ? owner : null,
        forecast_owner: isHistorical ? null : owner,
        source_evidence: [...new Set([
          ...(row?.source_line_ids ?? []),
          ...(row?.source_line_id ? [row.source_line_id] : []),
        ])].sort(),
        formula_schedule_owner:
          row?.formula_authority ??
          row?.schedule_owner ??
          authority?.producer ??
          (row?.calculation || row?.forecast_calculation ? rowId : null),
        capture_parent: row?.forecast_capture_parent_id ?? row?.parent_row_id ?? null,
        selected_evidence: authority ? {
          source_kind: authority.source_kind ?? authority.origin ?? null,
          source_id: authority.source_id ?? null,
          value: authority.value ?? null,
          method: authority.method ?? null,
        } : null,
        fallback_method: authority && FALLBACK_METHODS.has(authority.method) ? authority.method : null,
        visible_mechanism: mechanism(owner, authority),
        material: material(row),
        status,
      });
    }
  }
  const byKey = new Map(records.map((record) => [`${record.section}\0${record.row_id}\0${record.period_end}`, record]));
  for (const record of records) {
    if (record.period_status !== "forecast" || !record.capture_parent ||
        !DIRECT_FORECAST_OWNERS.has(record.forecast_owner)) continue;
    const parent = byKey.get(`${record.section}\0${record.capture_parent}\0${record.period_end}`);
    if (parent && DIRECT_FORECAST_OWNERS.has(parent.forecast_owner)) {
      const finding = `${record.section}:${record.period_end} parent ${parent.row_id} and child ${record.row_id} both own forecasts`;
      violations.push(finding);
      record.status = "BLOCK";
      parent.status = "BLOCK";
    }
  }
  const body = { schema_version: OWNERSHIP_CENSUS_VERSION, case_id: modelCase?.case_id ?? null,
    status: violations.length ? "BLOCK" : "PASS", records, violations };
  return { ...body, census_sha256: hashValue(body) };
}

export function sealOwnershipCensus(modelCase) {
  const census = buildOwnershipCensus(modelCase);
  modelCase.ownership_census_version = OWNERSHIP_CENSUS_VERSION;
  modelCase.ownership_census = census;
  if (census.status !== "PASS") throw new Error(`ownership census blocked: ${census.violations.join("; ")}`);
  return census;
}

export function verifyOwnershipCensus(modelCase) {
  if (modelCase?.ownership_census_version !== OWNERSHIP_CENSUS_VERSION || !modelCase?.ownership_census) {
    throw new Error("ownership census is absent or has the wrong version");
  }
  const expected = buildOwnershipCensus(modelCase);
  if (canonicalJson(expected) !== canonicalJson(modelCase.ownership_census)) throw new Error("ownership census drift");
  return expected;
}
