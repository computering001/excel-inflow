/**
 * BROKER ANCHOR SELECTION — which ONE of EBIT / Adj. EBITDA is the headline
 * forecast authority. D&A is the bridge driver; the other headline is derived.
 *
 * EBITDA = EBIT + D&A is an ARITHMETIC IDENTITY. A forecast that reads all
 * three straight off a broker pack is therefore over-determined, and it never
 * reconciles: consensus is a different mix of houses on every line, so the
 * three series simply do not foot to each other. The model used to absorb the
 * difference in an "Other Adjustments (residual to broker Adj. EBITDA)" row —
 * a silent plug worth about -187 a year on the Smurfit reference case, sitting
 * inside the EBITDA bridge where it read as a company adjustment rather than
 * as a broker disagreement.
 *
 * The rule that replaces it: choose ONE headline metric by HOW MANY NAMED
 * BROKERS ACTUALLY SUPPLY EBIT versus Adj. EBITDA, use D&A as the separate
 * bridge driver, and DERIVE the other headline.  EBIT and Adj. EBITDA can
 * never both be live inputs. Ties resolve toward EBIT, so an evenly supplied
 * pack works upward from EBIT through D&A to Adj. EBITDA.
 *
 * Where the losing metric DOES have a broker series it is not thrown away —
 * it is restated as a memo line beneath the bridge, with the variance against
 * the derived line on the row below it. A visible variance is information; a
 * plug inside the bridge is not.
 *
 * Nothing here is company-specific. Metrics are resolved from the case's own
 * broker pack and semantic roles, never by row number, because this is the
 * flexibility mechanism every future company goes through.
 */

// Statement order, and — not coincidentally — the tie-break order. EBIT first
// is the reviewer's instruction for an evenly supplied pack.
export const ANCHOR_METRIC_IDS = Object.freeze([
  "ebit",
  "adjusted_ebitda",
  "depreciation_and_amortisation",
]);

export const HEADLINE_ANCHOR_METRIC_IDS = Object.freeze([
  "ebit",
  "adjusted_ebitda",
]);

const METRIC_SHORT_LABEL = Object.freeze({
  ebit: "EBIT",
  adjusted_ebitda: "Adj. EBITDA",
  depreciation_and_amortisation: "D&A",
});

/**
 * A broker CONTRIBUTES a metric when it has a usable series, not when it has
 * a key. Packs carry a placeholder entry for every house on every line, so
 * counting keys would score a metric no one actually publishes as fully
 * supplied — on the Smurfit pack that is the difference between D&A scoring
 * seven and scoring its true five.
 */
function contributes(series) {
  return (
    Array.isArray(series) &&
    series.some(
      (value) =>
        value !== null && value !== undefined && Number.isFinite(Number(value)),
    )
  );
}

export function brokerContributorCount(modelCase, metricId) {
  const metric = modelCase?.broker_pack?.metrics?.[metricId];
  if (!metric) return 0;
  return Object.values(metric.brokers ?? {}).filter(contributes).length;
}

/** Contributor coverage by forecast period. A house with FY1 only must not be
 * counted as if it supplied FY2 and FY3 as well. */
export function brokerContributorCounts(modelCase, metricId) {
  const metric = modelCase?.broker_pack?.metrics?.[metricId];
  if (!metric) return [0, 0, 0];
  return [0, 1, 2].map(
    (periodIndex) =>
      Object.values(metric.brokers ?? {}).filter((series) => {
        const value = series?.[periodIndex];
        return value !== null && value !== undefined && Number.isFinite(Number(value));
      }).length,
  );
}

function consensusSelection(metric, forecastIndex) {
  const provider = metric.provider_consensus?.[forecastIndex];
  if (provider !== null && provider !== undefined) {
    return {
      value: Number(provider),
      source_kind: "provider_consensus",
      source_name: "Provider consensus",
      substituted: false,
    };
  }
  const values = Object.entries(metric.brokers ?? {})
    .map(([name, series]) => [name, series?.[forecastIndex]])
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => [name, Number(value)]);
  return {
    value:
      values.length === 0
        ? null
        : values.reduce((total, [, value]) => total + value, 0) / values.length,
    source_kind: "named_house_mean",
    source_name: `${values.length} named-house mean`,
    contributors: values.map(([name]) => name),
    substituted: false,
  };
}

/** Resolve one visible broker selection and disclose any named-house fallback. */
export function resolveBrokerForecastSelection(
  modelCase,
  metricId,
  forecastIndex,
) {
  const metric = modelCase?.broker_pack?.metrics?.[metricId];
  if (!metric) {
    return {
      value: null,
      source_kind: "absent",
      source_name: null,
      substituted: false,
    };
  }
  const consensus = () => consensusSelection(metric, forecastIndex);
  const selected = modelCase.controls?.broker_case ?? "Consensus";
  if (selected === "Consensus") return consensus();
  const values = Object.entries(metric.brokers ?? {})
    .map(([name, series]) => [name, series?.[forecastIndex]])
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => [name, Number(value)]);
  if (selected === "High" || selected === "Low") {
    if (values.length === 0) {
      const fallback = consensus();
      return {
        ...fallback,
        substituted: true,
        substituted_from: selected,
        substitution_reason: `No named broker supplies forecast period ${forecastIndex + 1}.`,
      };
    }
    const compare = selected === "High"
      ? (left, right) => right[1] - left[1]
      : (left, right) => left[1] - right[1];
    const [sourceName, value] = [...values].sort(compare)[0];
    return {
      value,
      source_kind: selected.toLowerCase(),
      source_name: sourceName,
      substituted: false,
    };
  }
  const named = metric.brokers?.[selected]?.[forecastIndex];
  if (named !== null && named !== undefined) {
    return {
      value: Number(named),
      source_kind: "named_house",
      source_name: selected,
      substituted: false,
    };
  }
  const fallback = consensus();
  return {
    ...fallback,
    substituted: true,
    substituted_from: selected,
    substitution_reason: `${selected} does not supply forecast period ${forecastIndex + 1}; consensus is used visibly for that period.`,
  };
}

export function selectBrokerAnchor(modelCase) {
  const counts = {};
  const countsByPeriod = {};
  const totals = {};
  for (const metricId of ANCHOR_METRIC_IDS) {
    countsByPeriod[metricId] = brokerContributorCounts(modelCase, metricId);
    counts[metricId] = Math.min(...countsByPeriod[metricId]);
    totals[metricId] = countsByPeriod[metricId].reduce(
      (total, value) => total + value,
      0,
    );
  }
  const rankedHeadlines = [...HEADLINE_ANCHOR_METRIC_IDS].sort(
    (left, right) =>
      counts[right] - counts[left] ||
      totals[right] - totals[left] ||
      HEADLINE_ANCHOR_METRIC_IDS.indexOf(left) -
        HEADLINE_ANCHOR_METRIC_IDS.indexOf(right),
  );
  const headlineAnchor = rankedHeadlines[0];
  const derived = rankedHeadlines[1];
  const da = "depreciation_and_amortisation";
  const anchors = [headlineAnchor, da].sort(
    (left, right) =>
      ANCHOR_METRIC_IDS.indexOf(left) - ANCHOR_METRIC_IDS.indexOf(right),
  );
  const label =
    `Broker headline anchor: ${METRIC_SHORT_LABEL[headlineAnchor]} ` +
    `(${countsByPeriod[headlineAnchor].join("/")} brokers); ${METRIC_SHORT_LABEL[da]} bridge driver ` +
    `(${countsByPeriod[da].join("/")} brokers) — ${METRIC_SHORT_LABEL[derived]} derived` +
    (totals[derived] > 0
      ? `, broker ${METRIC_SHORT_LABEL[derived]} (${countsByPeriod[derived].join("/")} brokers) shown as memo`
      : " (no broker series)");
  return {
    counts,
    counts_by_period: countsByPeriod,
    totals,
    anchors,
    headline_anchor: headlineAnchor,
    bridge_driver: da,
    derived,
    // Exactly one headline plus D&A needs full-period support. We never fall
    // back to using both headline metrics, because doing so merely moves their
    // consensus mismatch into D&A.
    supported: counts[headlineAnchor] > 0 && counts[da] > 0,
    label,
  };
}

/**
 * Locate the EBITDA bridge on a set of income-statement rows and say which of
 * its terms stands for EBIT, which for D&A, and which are the addbacks in
 * between. Resolution is by SEMANTIC ROLE and by the bridge subtotal's own
 * refs — never by row number or label — so a case that bridges through a
 * pass-through row ("Operating profit" linked into the bridge) resolves the
 * same way as one that references the statement row directly.
 */
export function resolveEbitdaBridge(rows) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const roleRow = (role) =>
    rows.find((row) => row.semantic_role === role) ?? null;
  const ebitdaRow = roleRow("adjusted_ebitda");
  const ebitRow = roleRow("ebit");
  const daRow = roleRow("depreciation_and_amortisation");
  if (!ebitdaRow || !ebitRow || !daRow) return null;
  const bridge = ebitdaRow.calculation;
  if (
    bridge?.operator !== "sum" ||
    !Array.isArray(bridge.refs) ||
    bridge.refs.length === 0
  ) {
    return null;
  }
  // A bridge term "stands for" a statement row when it IS that row or when it
  // reaches it through a couple of pass-through hops.
  const standsFor = (refId, targetId, depth = 0) => {
    if (refId === targetId) return true;
    if (depth >= 3) return false;
    const row = byId.get(refId);
    if (!row) return false;
    const refs = [
      ...(row.calculation?.refs ?? []),
      ...(row.forecast_calculation?.refs ?? []),
    ];
    return refs.some((next) => standsFor(next, targetId, depth + 1));
  };
  const ebitTerm =
    bridge.refs.find((ref) => standsFor(ref, ebitRow.row_id)) ?? null;
  const daTerm =
    bridge.refs.find(
      (ref) => ref !== ebitTerm && standsFor(ref, daRow.row_id),
    ) ?? null;
  if (!ebitTerm || !daTerm) return null;
  // A term the model is going to SOLVE FOR has to be the row itself or a
  // straight link to it. Anything else (a term that folds a second line in
  // alongside the metric) would make the rearranged formula wrong by that
  // second line, so the rule declines rather than guesses.
  const solvableFor = (term, row) =>
    term === row.row_id ||
    (byId.get(term)?.calculation?.operator === "link" &&
      byId.get(term)?.calculation?.refs?.[0] === row.row_id);
  return {
    ebitdaRow,
    ebitRow,
    daRow,
    ebitTerm,
    daTerm,
    addbackTerms: bridge.refs.filter(
      (ref) => ref !== ebitTerm && ref !== daTerm,
    ),
    ebitSolvable: solvableFor(ebitTerm, ebitRow),
    daSolvable: solvableFor(daTerm, daRow),
  };
}

/**
 * The forecast value of a bridge addback, read from the CASE rather than from
 * the built sheet. The independent solver has to agree with the workbook
 * formula it caches over, and the workbook derives the third metric as
 * "EBITDA less every other bridge term" — so the solver needs those terms too.
 * Only the shapes the bridge actually uses are supported; anything else is
 * reported as unresolvable so the caller can decline the whole rule instead of
 * silently valuing a term at zero.
 */
export function bridgeTermForecastValue(
  modelCase,
  rowId,
  forecastIndex,
  plugRowIds = new Set(),
) {
  const rows = [
    ...(modelCase.statement_structure?.income_statement ?? []),
    ...(modelCase.statement_structure?.cash_flow ?? []),
  ];
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const periodIndex = forecastIndex + 3;
  const stack = new Set();
  const resolve = (id) => {
    if (stack.has(id)) return null;
    stack.add(id);
    try {
      return resolveInner(id);
    } finally {
      stack.delete(id);
    }
  };
  const resolveInner = (id) => {
    const row = byId.get(id);
    if (!row) return null;
    if (row.forecast_treatment === "uncalculated") return 0;
    // A row the anchor rule has just stopped using as a plug reads its own
    // declared input again — which is what the source workbook always had on
    // it — so it is valued here the way the rebuilt sheet will value it, not
    // the way the case still describes it.
    const calculation = plugRowIds.has(id)
      ? null
      : row.forecast_calculation ??
        (["broker", "hardcode", "zero"].includes(row.forecast_treatment)
          ? null
          : row.calculation);
    if (!calculation) {
      const declared = row.values?.[periodIndex];
      if (declared === null || declared === undefined) {
        return row.broker_metric_id ? null : 0;
      }
      return Number(declared);
    }
    if (calculation.operator === "link") return resolve(calculation.refs[0]);
    if (calculation.operator === "negate") {
      const inner = resolve(calculation.refs[0]);
      return inner === null ? null : -inner;
    }
    if (calculation.operator === "sum" || calculation.operator === "subtract") {
      const parts = calculation.refs.map(resolve);
      if (parts.some((part) => part === null)) return null;
      return calculation.operator === "sum"
        ? parts.reduce((total, part) => total + part, 0)
        : parts
            .slice(1)
            .reduce((total, part) => total - part, parts[0] ?? 0);
    }
    return null;
  };
  return resolve(rowId);
}

/**
 * Total of the bridge addbacks between EBIT and Adjusted EBITDA for one
 * forecast period, or null when any of them cannot be resolved from the case.
 */
export function bridgeAddbackTotal(
  modelCase,
  addbackTerms,
  forecastIndex,
  plugRowIds = new Set(),
) {
  let total = 0;
  for (const term of addbackTerms) {
    const value = bridgeTermForecastValue(
      modelCase,
      term,
      forecastIndex,
      plugRowIds,
    );
    if (value === null) return null;
    total += value;
  }
  return total;
}

/**
 * The full anchor decision for a case: the selection, the bridge it applies
 * to, and the addback total per forecast period. Returns null when the rule
 * does not apply, in which case the case is built exactly as authored.
 *
 * `residualPlugRowIds` names the bridge rows the case was using as a plug —
 * a row whose forecast is "Adjusted EBITDA less everything else in the
 * bridge". Those stop being formulas once the bridge is determined.
 */
export function resolveAnchorPlan(modelCase, rows) {
  const selection = selectBrokerAnchor(modelCase);
  if (!selection.supported) return null;
  const bridge = resolveEbitdaBridge(rows);
  if (!bridge) return null;
  if (selection.derived === "ebit" && !bridge.ebitSolvable) return null;
  const residualPlugRowIds = bridge.addbackTerms.filter((term) => {
    const row = rows.find((item) => item.row_id === term);
    const calculation = row?.forecast_calculation;
    return (
      calculation?.operator === "subtract" &&
      calculation.refs?.[0] === bridge.ebitdaRow.row_id
    );
  });
  const plugRowIds = new Set(residualPlugRowIds);
  const addbackTotals = [0, 1, 2].map((forecastIndex) =>
    bridgeAddbackTotal(
      modelCase,
      bridge.addbackTerms,
      forecastIndex,
      plugRowIds,
    ),
  );
  if (addbackTotals.some((total) => total === null)) return null;
  return { selection, bridge, residualPlugRowIds, addbackTotals };
}
