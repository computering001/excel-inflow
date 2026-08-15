/**
 * Independently prove that every visible forecast statement cell implements
 * the authority declared for its semantic row and period.
 *
 * The row plan supplies physical rows, the semantic manifest supplies the
 * authority, and the workbook reader supplies the cell that actually shipped.
 * No implicit renderer default can therefore make all three agree.
 */

const GREEN = "008000";
const UNCALCULATED_FILL = "EFEFEF";
const BROKERS_REFERENCE = /(?:'Brokers'|Brokers)!/i;

function blank(value) {
  return value === null || value === undefined || value === "";
}

function finite(value) {
  return !blank(value) && Number.isFinite(Number(value));
}

function normalizedFormula(value) {
  return String(value ?? "").trim().replace(/^=/, "");
}

function normalizedColor(value) {
  const text = String(value ?? "").replace(/^#/, "").toUpperCase();
  return text.length === 8 ? text.slice(-6) : text;
}

function finding(id, rowId, address, message, evidence = {}) {
  return { id, row_id: rowId, address, message, evidence };
}

export function validateForecastWorkbookCompleteness({
  statementRows,
  manifestNodes,
  forecastColumns = ["J", "K", "L"],
  cellAt,
}) {
  const errors = [];
  let visited = 0;
  const nodesByRowId = new Map(
    (manifestNodes ?? [])
      .filter((node) => node?.node_kind === "statement_row" && node.row_id)
      .map((node) => [node.row_id, node]),
  );

  for (const row of statementRows ?? []) {
    if (row?.row_type === "header") continue;
    const node = nodesByRowId.get(row.row_id);
    if (!node) {
      errors.push(finding(
        "forecast.manifest_node_missing",
        row.row_id,
        null,
        "Visible statement row has no semantic-manifest node.",
      ));
      continue;
    }
    if (!Array.isArray(node.forecast_authorities) || node.forecast_authorities.length !== 3) {
      errors.push(finding(
        "forecast.authority_count",
        row.row_id,
        null,
        "Visible statement row does not declare exactly three forecast authorities.",
        { count: node.forecast_authorities?.length ?? null },
      ));
      continue;
    }

    for (const [forecastIndex, column] of forecastColumns.entries()) {
      const address = `${column}${row.row}`;
      const cell = cellAt(address) ?? {};
      const authority = node.forecast_authorities[forecastIndex] ?? {};
      const mechanism = authority.mechanism;
      const formula = normalizedFormula(cell.formula);
      visited += 1;

      if (mechanism === "formula") {
        if (!formula) {
          errors.push(finding(
            "forecast.formula_required",
            row.row_id,
            address,
            "Formula-authority forecast cell shipped without a formula.",
            { method: authority.method, value: cell.value ?? null },
          ));
        }
        continue;
      }

      if (mechanism === "broker") {
        if (!formula || !BROKERS_REFERENCE.test(formula)) {
          errors.push(finding(
            "forecast.broker_link_required",
            row.row_id,
            address,
            "Broker-authority forecast cell must link directly to the Brokers sheet.",
            { formula: formula || null, broker_metric_id: authority.broker_metric_id ?? null },
          ));
        }
        continue;
      }

      if (mechanism === "hardcode") {
        if (!formula || !BROKERS_REFERENCE.test(formula)) {
          errors.push(finding(
            "forecast.assumption_link_required",
            row.row_id,
            address,
            "Independent-input forecast cell must link to the Brokers forecast-assumptions block.",
            { formula: formula || null },
          ));
        }
        if (!finite(cell.value)) {
          errors.push(finding(
            "forecast.assumption_value_required",
            row.row_id,
            address,
            "Linked forecast assumption has no numeric cached value.",
          ));
        }
        if (normalizedColor(cell.fontColor) !== GREEN) {
          errors.push(finding(
            "forecast.assumption_link_green",
            row.row_id,
            address,
            "Forecast assumption link is not green.",
            { actual: normalizedColor(cell.fontColor) || null, expected: GREEN },
          ));
        }
        continue;
      }

      if (mechanism === "zero") {
        if (!formula) {
          errors.push(finding(
            "forecast.zero_formula_required",
            row.row_id,
            address,
            "Explicit zero must ship as a calculated zero, not a blank or hardcode.",
          ));
        }
        if (!finite(cell.value) || Number(cell.value) !== 0) {
          errors.push(finding(
            "forecast.zero_value",
            row.row_id,
            address,
            "Explicit-zero forecast cell does not calculate to zero.",
            { value: cell.value ?? null, formula: formula || null },
          ));
        }
        continue;
      }

      if (mechanism === "uncalculated") {
        if (formula || !blank(cell.value)) {
          errors.push(finding(
            "forecast.uncalculated_not_blank",
            row.row_id,
            address,
            "Intentionally uncalculated forecast cell contains a formula or value.",
            { value: cell.value ?? null, formula: formula || null },
          ));
        }
        if (normalizedColor(cell.fillColor) !== UNCALCULATED_FILL) {
          errors.push(finding(
            "forecast.uncalculated_fill",
            row.row_id,
            address,
            "Intentionally uncalculated forecast cell lacks the required grey fill.",
            { actual: normalizedColor(cell.fillColor) || null, expected: UNCALCULATED_FILL },
          ));
        }
        continue;
      }

      errors.push(finding(
        "forecast.mechanism",
        row.row_id,
        address,
        "Forecast authority has no supported workbook mechanism.",
        { mechanism: mechanism ?? null, method: authority.method ?? null },
      ));
    }
  }

  return { errors, visited };
}
