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
  if (!modelCase?.modules?.historical_normalisation) {
    return {
      model_case: modelCase,
      receipt: {
        applied: false,
        entity_ids: [],
        metrics: [],
      },
    };
  }

  const normalizedCase = cloneCase(modelCase);
  const combined = combineHistoricalEntities(
    normalizedCase.historical_entities,
  );
  const receipt = {
    applied: true,
    entity_ids: normalizedCase.historical_entities.map(
      (entity) => entity.entity_id,
    ),
    metrics: [],
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

  return { model_case: normalizedCase, receipt };
}
