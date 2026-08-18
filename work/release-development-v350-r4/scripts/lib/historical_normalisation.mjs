function asHistoricalSeries(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((item) => !Number.isFinite(Number(item)))
  ) {
    throw new Error(`${label} must contain three numeric historical values.`);
  }
  return value.map(Number);
}

function cloneCase(modelCase) {
  return JSON.parse(JSON.stringify(modelCase));
}

function finiteHistorical(values) {
  return (
    Array.isArray(values) &&
    values.length >= 3 &&
    values.slice(0, 3).every((value) => Number.isFinite(Number(value)))
  );
}

function closeSeries(left, right) {
  return left.every((value, index) => {
    const expected = Number(right[index]);
    const actual = Number(value);
    return Math.abs(actual - expected) <=
      Math.max(1e-7, Math.abs(expected) * 1e-10);
  });
}

const INFERABLE_TOTAL_ROLES = new Set([
  "revenue",
  "ebit",
  "adjusted_ebitda",
  "pre_tax_income",
  "net_income",
  "cash_from_operations",
  "cash_from_investing",
  "cash_from_financing",
  "net_change_in_cash",
  "ending_cash",
]);

function isInferableReportedTotal(row) {
  return (
    row?.historical_authority === "source_input" &&
    finiteHistorical(row.values) &&
    !(row.calculation?.refs?.length > 0) &&
    (row.style_role === "total" ||
      row.row_type === "subtotal" ||
      INFERABLE_TOTAL_ROLES.has(row.semantic_role))
  );
}

/**
 * Discover a filed total's visible dependency run when the source supplied the
 * answer but omitted the arithmetic metadata.
 *
 * The search is deliberately narrow: it walks the contiguous numeric run
 * immediately above a declared total, accepts the shortest suffix that
 * reconciles in all three historical periods, and stops after crossing the
 * first earlier total. This captures issuer-specific shapes without guessing
 * from labels or reaching across an unrelated statement family.
 */
function inferExactContiguousTotalDependencies(modelCase) {
  const inferred = [];
  for (const section of ["income_statement", "cash_flow"]) {
    const rows = modelCase.statement_structure?.[section] ?? [];
    const byId = new Map(rows.map((row) => [row.row_id, row]));
    const reaches = (fromId, targetId, visiting = new Set()) => {
      if (fromId === targetId) return true;
      if (visiting.has(fromId)) return false;
      const next = new Set(visiting).add(fromId);
      const row = byId.get(fromId);
      return (row?.calculation?.refs ?? []).some((reference) =>
        reaches(reference, targetId, next),
      );
    };
    const memo = new Map();
    const resolve = (rowId, visiting = new Set()) => {
      if (memo.has(rowId)) return memo.get(rowId);
      if (visiting.has(rowId)) return null;
      const row = byId.get(rowId);
      if (!row) return null;
      const values = declaredHistoricalSeries(
        row,
        resolve,
        new Set(visiting).add(rowId),
      );
      memo.set(rowId, values);
      return values;
    };

    for (let index = 0; index < rows.length; index += 1) {
      const total = rows[index];
      if (!isInferableReportedTotal(total)) continue;
      const filed = total.values.slice(0, 3).map(Number);
      const refs = [];
      const running = [0, 0, 0];
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = rows[cursor];
        if (candidate.row_type === "header") break;
        // A numerically reconciling suffix is not a valid definition when one
        // of its members already depends (directly or transitively) on the
        // total being inferred. Accepting that inverse identity creates a
        // cycle despite perfect historical arithmetic—for example reported
        // Adjusted EBITDA = operating profit + D&A beside an operating-profit
        // total that happens to equal Adjusted EBITDA - D&A.
        if (reaches(candidate.row_id, total.row_id)) break;
        const values = resolve(candidate.row_id);
        if (!values || candidate.number_format === "percentage") continue;
        refs.unshift(candidate.row_id);
        for (let period = 0; period < 3; period += 1) {
          running[period] += Number(values[period]);
        }
        if (refs.length >= 2 && closeSeries(running, filed)) {
          total.calculation = { operator: "sum", refs: [...refs] };
          inferred.push({
            section,
            row_id: total.row_id,
            dependency_row_ids: [...refs],
          });
          break;
        }
        if (
          candidate.style_role === "total" ||
          candidate.row_type === "subtotal" ||
          INFERABLE_TOTAL_ROLES.has(candidate.semantic_role)
        ) {
          break;
        }
      }
    }
  }
  return inferred;
}

function declaredHistoricalSeries(row, resolve, visiting) {
  if (finiteHistorical(row.reported_historical_values)) {
    return row.reported_historical_values.slice(0, 3).map(Number);
  }
  if (finiteHistorical(row.values)) {
    return row.values.slice(0, 3).map(Number);
  }
  return calculatedHistoricalSeries(row, resolve, visiting);
}

function calculatedHistoricalSeries(row, resolve, visiting = new Set()) {
  const rule = row.calculation;
  const refs = rule?.refs ?? [];
  if (!rule?.operator || refs.length === 0) return null;
  const operands = refs.map((ref) => resolve(ref, visiting));
  if (operands.some((values) => !values)) return null;
  const sum = (series) =>
    series.reduce(
      (total, values) => total.map((value, index) => value + values[index]),
      [0, 0, 0],
    );
  if (rule.operator === "sum") return sum(operands);
  if (rule.operator === "link" && operands.length === 1) return operands[0];
  if (rule.operator === "subtract") {
    return operands.slice(1).reduce(
      (total, values) => total.map((value, index) => value - values[index]),
      [...operands[0]],
    );
  }
  if (rule.operator === "negate" && operands.length === 1) {
    return operands[0].map((value) => -value);
  }
  if (rule.operator === "negate_sum") {
    return sum(operands).map((value) => -value);
  }
  return null;
}

function promoteExactReportedTotals(modelCase) {
  const productionAuthority =
    modelCase.execution_profile !== "reference_parity" &&
    modelCase.source_coverage?.classification_contract_version === "evidence_v1" &&
    modelCase.statement_authority_contract_version === "authority_v1";
  if (!productionAuthority) return [];

  const inferredDependencies =
    inferExactContiguousTotalDependencies(modelCase);
  const inferredByRow = new Map(
    inferredDependencies.map((item) => [`${item.section}.${item.row_id}`, item]),
  );
  const rows = [
    ...(modelCase.statement_structure?.income_statement ?? []),
    ...(modelCase.statement_structure?.cash_flow ?? []),
  ];
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const memo = new Map();
  const resolve = (rowId, visiting = new Set()) => {
    if (memo.has(rowId)) return memo.get(rowId);
    if (visiting.has(rowId)) return null;
    const row = byId.get(rowId);
    if (!row) return null;
    const next = new Set(visiting).add(rowId);
    const values = declaredHistoricalSeries(row, resolve, next);
    memo.set(rowId, values);
    return values;
  };

  const promotions = [];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (
        row.historical_authority !== "source_input" ||
        !finiteHistorical(row.values) ||
        (row.calculation?.refs?.length ?? 0) === 0
      ) {
        continue;
      }
      const calculated = calculatedHistoricalSeries(
        row,
        resolve,
        new Set([row.row_id]),
      );
      const filed = row.values.slice(0, 3).map(Number);
      if (!calculated || !closeSeries(calculated, filed)) continue;
      row.reported_historical_values = filed;
      row.values = [null, null, null, ...row.values.slice(3)];
      // The filed number remains preserved as reconciliation evidence, but
      // after exact promotion the visible historical cells are formula-owned.
      // Keeping `row_type: input` beside the newly certified calculation is a
      // contradictory graph declaration and the dependency gate correctly
      // rejects it.  Preserve genuine subtotal presentation; otherwise make
      // the promoted row an ordinary calculation row.
      if (row.row_type !== "subtotal") row.row_type = "calculation";
      row.historical_authority = "reported_total_reconciled";
      memo.set(row.row_id, calculated);
      promotions.push({
        section,
        row_id: row.row_id,
        filed_values: filed,
        calculated_values: calculated,
        dependency_row_ids: [...row.calculation.refs],
        dependency_inferred: inferredByRow.has(`${section}.${row.row_id}`),
      });
    }
  }
  return promotions;
}

export function combineHistoricalEntities(entities) {
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error(
      "historical_entities must contain at least one entity when historical normalisation is enabled.",
    );
  }

  const metricIds = new Set();
  for (const entity of entities) {
    for (const metricId of Object.keys(entity.metrics ?? {})) {
      metricIds.add(metricId);
    }
    for (const metricId of Object.keys(
      entity.metric_specific_eliminations ?? {},
    )) {
      metricIds.add(metricId);
    }
  }

  const combined = {};
  for (const metricId of [...metricIds].sort()) {
    const total = [0, 0, 0];
    for (const entity of entities) {
      const values = entity.metrics?.[metricId]
        ? asHistoricalSeries(
            entity.metrics[metricId],
            `historical_entities.${entity.entity_id}.metrics.${metricId}`,
          )
        : [0, 0, 0];
      const eliminations = entity.metric_specific_eliminations?.[metricId]
        ? asHistoricalSeries(
            entity.metric_specific_eliminations[metricId],
            `historical_entities.${entity.entity_id}.metric_specific_eliminations.${metricId}`,
          )
        : [0, 0, 0];
      for (let index = 0; index < 3; index += 1) {
        total[index] += values[index] - eliminations[index];
      }
    }
    combined[metricId] = total;
  }
  return combined;
}

function replaceHistoricalValues(target, values, label) {
  if (!Array.isArray(target.values) || target.values.length !== 6) {
    throw new Error(
      `${label}.values must contain six periods before historical normalisation can replace the three actuals.`,
    );
  }
  target.values = [...values, ...target.values.slice(3)];
}

/**
 * Compile predecessor/calendarised historical entities into the canonical case.
 *
 * Entity metrics use semantic IDs, never presentation labels. An exact row_id is
 * preferred; semantic_role is the fallback. Every supplied metric must resolve to
 * an operating metric or a visible statement row, otherwise production blocks.
 */
export function applyHistoricalNormalisation(modelCase) {
  const productionAuthority =
    modelCase?.execution_profile !== "reference_parity" &&
    modelCase?.source_coverage?.classification_contract_version === "evidence_v1" &&
    modelCase?.statement_authority_contract_version === "authority_v1";
  if (!modelCase?.modules?.historical_normalisation && !productionAuthority) {
    return {
      model_case: modelCase,
      receipt: {
        applied: false,
        entity_ids: [],
        metrics: [],
        exact_reported_total_promotions: [],
      },
    };
  }

  const normalizedCase = cloneCase(modelCase);
  const historicalEntityNormalisation = Boolean(
    normalizedCase.modules?.historical_normalisation,
  );
  const combined = historicalEntityNormalisation
    ? combineHistoricalEntities(normalizedCase.historical_entities)
    : {};
  const receipt = {
    applied: historicalEntityNormalisation,
    entity_ids: historicalEntityNormalisation
      ? normalizedCase.historical_entities.map((entity) => entity.entity_id)
      : [],
    metrics: [],
    exact_reported_total_promotions: [],
  };

  for (const [metricId, values] of Object.entries(combined)) {
    const destinations = [];
    const operatingMetric = normalizedCase.operating_metrics?.[metricId];
    if (operatingMetric) {
      replaceHistoricalValues(
        operatingMetric,
        values,
        `operating_metrics.${metricId}`,
      );
      destinations.push(`operating_metrics.${metricId}`);
    }

    for (const statementName of ["income_statement", "cash_flow"]) {
      const rows = normalizedCase.statement_structure?.[statementName] ?? [];
      const exactRows = rows.filter((row) => row.row_id === metricId);
      const matchedRows =
        exactRows.length > 0
          ? exactRows
          : rows.filter((row) => row.semantic_role === metricId);
      for (const row of matchedRows) {
        if (row.values === undefined) continue;
        replaceHistoricalValues(
          row,
          values,
          `statement_structure.${statementName}.${row.row_id}`,
        );
        destinations.push(
          `statement_structure.${statementName}.${row.row_id}`,
        );
      }
    }

    if (destinations.length === 0) {
      throw new Error(
        `Historical-normalisation metric ${metricId} has no canonical operating metric or statement-row destination.`,
      );
    }
    receipt.metrics.push({
      metric_id: metricId,
      values,
      destinations: [...new Set(destinations)].sort(),
    });
  }

  receipt.exact_reported_total_promotions =
    promoteExactReportedTotals(normalizedCase);

  return { model_case: normalizedCase, receipt };
}
