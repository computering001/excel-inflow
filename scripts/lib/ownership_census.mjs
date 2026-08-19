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

function forecastOwner(row, authority, forecastIndex) {
  if (row?.row_type === "header" || authority?.method === "not_applicable") return "not_applicable";
  // A broker-waterfall strip is a receipted intermediate state: the very next
  // compile mints the row-owned fallback and clears the marker. The census
  // records the transition instead of blocking a deterministic next step.
  if (row?.forecast_waterfall_pending === true && !authority) return "waterfall_pending";
  const capturedThisPeriod = authority?.method === "not_separately_forecast";
  if (capturedThisPeriod) return "captured";
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
  if (owner === "waterfall_pending") return "pending_recompile";
  return "not_applicable";
}

function statementRows(modelCase) {
  return ["income_statement", "cash_flow"].flatMap((section) =>
    (modelCase?.statement_structure?.[section] ?? []).map((row) => ({ section, row })),
  );
}

function sourceIds(value) {
  return [...new Set([
    ...(value?.source_line_ids ?? []),
    ...(value?.source_line_id ? [value.source_line_id] : []),
    ...(value?.instrument_id ? [`instrument:${value.instrument_id}`] : []),
  ])].sort();
}

/**
 * The economically-owned SCHEDULE surface: one definition per debt, interest,
 * lease, RCF, acquisition and leverage/liquidity cell the model owns outside
 * the two statements. Exported (P3.2) so the forecast completion census
 * enumerates the SAME surface this census does — one inventory, two views,
 * no room for the schedule half to exist in one census and not the other.
 */
export function economicRegionDefinitions(modelCase) {
  const definitions = [];
  for (const instrument of modelCase?.instruments ?? []) {
    definitions.push({
      row_id: `instrument.${instrument.instrument_id}.ending_balance`,
      model_node_id: `instrument:${instrument.instrument_id}:ending_balance`,
      section: "debt_schedule",
      visible_region: "debt_schedule",
      cell_class: "instrument_balance",
      historical_owner: "source_input",
      forecast_owner: "schedule_owned",
      formula_schedule_owner: `instrument:${instrument.instrument_id}`,
      source_evidence: sourceIds(instrument),
    });
  }
  const scheduleRows = [
    ["gross_debt_excluding_leases", "debt_schedule"],
    ["gross_debt_including_leases", "debt_schedule"],
    ["lease_liability", "debt_schedule"],
    ["acquisition_debt", "debt_schedule"],
    ["rcf_capacity", "rcf_waterfall"],
    ["rcf_draw", "rcf_waterfall"],
    ["rcf_repayment", "rcf_waterfall"],
    ["ending_rcf", "rcf_waterfall"],
    ["liquidity_shortfall", "rcf_waterfall"],
    ["gross_interest_expense", "interest_schedule"],
    ["net_interest_expense", "interest_schedule"],
    ["lease_interest", "interest_schedule"],
    ["rcf_interest", "interest_schedule"],
    ["rcf_commitment_fee", "interest_schedule"],
  ];
  for (const [row_id, section] of scheduleRows) {
    definitions.push({
      row_id,
      model_node_id: row_id,
      section,
      visible_region: section,
      cell_class: "schedule_amount",
      historical_owner: ["rcf_draw", "rcf_repayment", "ending_rcf", "liquidity_shortfall", "acquisition_debt"].includes(row_id)
        ? "not_applicable"
        : "derived_formula",
      forecast_owner: "schedule_owned",
      formula_schedule_owner: section,
      source_evidence: [],
    });
  }
  for (const instrument of (modelCase?.instruments ?? []).filter((item) => item?.class !== "rcf")) {
    definitions.push({
      row_id: `instrument.${instrument.instrument_id}.interest_expense`,
      model_node_id: `instrument:${instrument.instrument_id}:interest_expense`,
      section: "interest_schedule",
      visible_region: "interest_schedule",
      cell_class: "schedule_amount",
      historical_owner: "not_applicable",
      forecast_owner: "schedule_owned",
      formula_schedule_owner: `instrument:${instrument.instrument_id}:interest`,
      source_evidence: sourceIds(instrument),
    });
  }
  for (const row_id of [
    "gross_debt_excluding_leases", "gross_debt_including_leases",
    "net_debt_excluding_leases", "net_debt_including_leases",
    "adjusted_ebitda_denominator", "net_debt_to_adjusted_ebitda",
    "net_debt_including_leases_to_adjusted_ebitda", "total_liquidity",
  ]) {
    definitions.push({
      row_id,
      model_node_id: `leverage_liquidity:${row_id}`,
      section: "leverage_liquidity",
      visible_region: "leverage_liquidity",
      cell_class: row_id.includes("_to_") ? "ratio" : "schedule_amount",
      historical_owner: "derived_formula",
      forecast_owner: "schedule_owned",
      formula_schedule_owner: "leverage_liquidity",
      source_evidence: [],
    });
  }
  return definitions;
}

function recordForDefinition(definition, period, periodIndex, columnRole) {
  const isHistorical = period.status === "historical";
  const historicalOwner = isHistorical ? definition.historical_owner : null;
  const forecastOwner = isHistorical ? null : definition.forecast_owner;
  const owner = isHistorical ? historicalOwner : forecastOwner;
  return {
    cell_key: `${definition.visible_region}:${definition.row_id}:${columnRole}:${period.date}`,
    row_id: definition.row_id,
    model_node_id: definition.model_node_id ?? definition.row_id,
    section: definition.section,
    visible_region: definition.visible_region,
    cell_class: definition.cell_class,
    column_role: columnRole,
    period_end: String(period.date),
    period_index: periodIndex,
    period_status: period.status,
    historical_owner: historicalOwner,
    forecast_owner: forecastOwner,
    source_evidence: definition.source_evidence ?? [],
    formula_schedule_owner: definition.formula_schedule_owner ?? null,
    capture_parent: null,
    selected_evidence: null,
    fallback_method: null,
    visible_mechanism: mechanism(owner, null),
    material: true,
    status: ["blocked", "unresolved"].includes(owner) ? "BLOCK" : "PASS",
  };
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
      const owner = isHistorical ? historyOwner : forecastOwner(row, authority, forecastIndex);
      const status = ["blocked", "unresolved"].includes(owner) && material(row) ? "BLOCK" : "PASS";
      if (status === "BLOCK") violations.push(`${rowId}:${period.date} has unresolved ${period.status} ownership`);
      records.push({
        cell_key: `${section}:${rowId}:${isHistorical ? "historical" : "forecast"}:${period.date}`,
        row_id: rowId,
        model_node_id: row?.model_node_id ?? rowId,
        section,
        visible_region: section,
        cell_class: "statement_amount",
        column_role: isHistorical ? "historical" : "forecast",
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
        capture_parent:
          owner === "schedule_owned" && row?.forecast_schedule_coownership_permitted === true
            ? null
            : row?.forecast_capture_parent_id ?? row?.parent_row_id ?? null,
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
  for (const definition of economicRegionDefinitions(modelCase)) {
    for (const [periodIndex, period] of periods.entries()) {
      records.push(recordForDefinition(
        definition,
        period,
        periodIndex,
        period.status === "historical" ? "historical" : "forecast",
      ));
    }
  }
  const visibleStatementRows = statementRows(modelCase).filter(({ row }) => row?.row_type !== "header");
  for (const { section, row } of visibleStatementRows) {
    for (const [periodIndex, period] of periods.entries()) {
      if (period.status !== "forecast") continue;
      for (const region of ["adjustment_columns", "pro_forma_columns"]) {
        const definition = {
          row_id: row.row_id,
          model_node_id: `${region}:${row.row_id}`,
          section: region,
          visible_region: region,
          cell_class: region === "adjustment_columns" ? "controlled_adjustment" : "pro_forma_amount",
          historical_owner: "not_applicable",
          forecast_owner: "schedule_owned",
          formula_schedule_owner: region === "adjustment_columns" ? "adjustment_control" : "standalone_plus_adjustment",
          source_evidence: sourceIds(row),
        };
        records.push(recordForDefinition(
          definition,
          period,
          periodIndex,
          region === "adjustment_columns" ? "adjustment" : "pro_forma_forecast",
        ));
      }
    }
    const referencePeriod = periods[2];
    records.push(recordForDefinition({
      row_id: row.row_id,
      model_node_id: `pro_forma_columns:${row.row_id}`,
      section: "pro_forma_columns",
      visible_region: "pro_forma_columns",
      cell_class: "pro_forma_amount",
      historical_owner: "derived_formula",
      forecast_owner: "schedule_owned",
      formula_schedule_owner: "latest_historical_reference",
      source_evidence: sourceIds(row),
    }, referencePeriod, 2, "pro_forma_reference"));
  }
  const seenCellKeys = new Set();
  for (const record of records) {
    if (seenCellKeys.has(record.cell_key)) {
      violations.push(`duplicate ownership census cell ${record.cell_key}`);
      record.status = "BLOCK";
    }
    seenCellKeys.add(record.cell_key);
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
