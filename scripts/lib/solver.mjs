import {
  inferMovementType,
  normaliseStatementRows,
} from "./row_plan.mjs";
export { combineHistoricalEntities } from "./historical_normalisation.mjs";
import {
  balancingRcfInstrument,
  validateBalancingRcf,
} from "./rcf_policy.mjs";
import { leaseForecast, validateLeasePolicy } from "./lease_policy.mjs";
import {
  resolveForecastAuthority,
  resolveMetricForecastAuthority,
  validateForecastAuthorities,
} from "./forecast_authority.mjs";

const NORMALISED_STATEMENT_CACHE = new WeakMap();

function normalisedStatementDefinitions(modelCase) {
  if (!NORMALISED_STATEMENT_CACHE.has(modelCase)) {
    NORMALISED_STATEMENT_CACHE.set(modelCase, [
      ...normaliseStatementRows(modelCase, "income_statement"),
      ...normaliseStatementRows(modelCase, "cash_flow"),
    ]);
  }
  return NORMALISED_STATEMENT_CACHE.get(modelCase);
}

function asSeries3(value, fallback = 0) {
  if (Array.isArray(value) && value.length === 3) return value.map(Number);
  return [fallback, fallback, fallback];
}

/**
 * The three reported period-end lease liabilities, oldest first.
 *
 * Returns null when the case has not stated them, in which case only the
 * forecast opening balance is knowable and the historical columns stay blank
 * rather than being back-filled with a copy of a neighbouring year — the
 * failure this field exists to prevent.
 */
export function leaseHistoricalLiabilities(modelCase) {
  const series = modelCase?.lease_policy?.historical_liabilities;
  if (!Array.isArray(series) || series.length !== 3) return null;
  return series.map(Number);
}

/**
 * The opening balance the forecast roll-forward starts from: the LAST reported
 * actual when the historical series is stated, else the legacy scalar.
 */
export function leaseOpeningLiability(modelCase) {
  const historical = leaseHistoricalLiabilities(modelCase);
  if (historical) return Number(historical[2]);
  return Number(modelCase?.lease_policy?.opening_liability ?? 0);
}

function metricSeries(modelCase, metricId) {
  const metric = modelCase.operating_metrics?.[metricId];
  return Array.isArray(metric?.values) ? metric.values : [null, null, null, null, null, null];
}

function brokerForecastValue(modelCase, metricId, forecastIndex) {
  if (Number(modelCase.contract_version) !== 2) return null;
  if (
    metricId === "dividends_and_buybacks" &&
    modelCase.broker_pack?.metrics?.dividends &&
    modelCase.broker_pack?.metrics?.share_buybacks
  ) {
    const dividends = brokerForecastValue(
      modelCase,
      "dividends",
      forecastIndex,
    );
    const buybacks = brokerForecastValue(
      modelCase,
      "share_buybacks",
      forecastIndex,
    );
    if (dividends !== null || buybacks !== null) {
      return Number(dividends ?? 0) + Number(buybacks ?? 0);
    }
  }
  const brokerMetricId =
    metricId === "dividends_and_buybacks" ? "dividends" : metricId;
  return resolveBrokerForecastSelection(
    modelCase,
    brokerMetricId,
    forecastIndex,
  ).value;
}

function metricValue(modelCase, metricId, periodIndex, fallback) {
  if (periodIndex >= 3) {
    const metric = modelCase.operating_metrics?.[metricId];
    if (Array.isArray(metric?.forecast_period_authorities)) {
      const authority = resolveMetricForecastAuthority(
        modelCase,
        metricId,
        periodIndex - 3,
      );
      if (authority.mechanism === "block") {
        throw new Error(
          `Unresolved forecast authority for operating metric ${metricId} in forecast period ${periodIndex - 2}: ${authority.reason ?? authority.method}.`,
        );
      }
      if (authority.mechanism === "uncalculated" || authority.mechanism === "zero") {
        return 0;
      }
      if (authority.mechanism === "broker" && authority.broker_value !== null) {
        return Number(authority.broker_value);
      }
      if (authority.mechanism === "hardcode" && authority.value !== null) {
        return Number(authority.value);
      }
    }
    const brokerValue = brokerForecastValue(
      modelCase,
      metricId,
      periodIndex - 3,
    );
    if (brokerValue !== null && brokerValue !== undefined) {
      return Number(brokerValue);
    }
  }
  const value = metricSeries(modelCase, metricId)[periodIndex];
  return value === null || value === undefined ? fallback : Number(value);
}

function statementRoleValue(modelCase, semanticRole, periodIndex, fallback) {
  for (const section of ["income_statement", "cash_flow"]) {
    const row = modelCase.statement_structure?.[section]?.find(
      (item) => item.semantic_role === semanticRole,
    );
    const value = row?.values?.[periodIndex];
    if (value !== null && value !== undefined) return Number(value);
  }
  return metricValue(modelCase, semanticRole, periodIndex, fallback);
}

// A row whose forecast is SUPPLIED — broker, hardcode, zero or deliberately
// blank — does not fall back to the rule that produced its history. Mirrors the
// resolve() branch in build_dynamic_model.mjs, which decides what the forecast
// columns actually hold; reading `calculation` unconditionally would price a
// forecast off a historical rule the sheet never evaluates there.
const SUPPLIED_FORECAST_TREATMENTS = new Set([
  "broker",
  "hardcode",
  "zero",
  "uncalculated",
]);

function forecastRule(row, forecastIndex = null) {
  if (
    forecastIndex !== null &&
    Array.isArray(row.forecast_period_calculations)
  ) {
    return row.forecast_period_calculations[forecastIndex] ?? null;
  }
  if (row.forecast_calculation) return row.forecast_calculation;
  if (SUPPLIED_FORECAST_TREATMENTS.has(row.forecast_treatment)) return null;
  return row.calculation ?? null;
}

/**
 * Return the normalised statement row that owns a semantic role.
 *
 * Forecast authority is a property of the issuer's declared graph, not of a
 * fixed list of model metrics.  In particular, an issuer may supply PBT and
 * D&A while deriving EBIT and EBITDA backwards through the solved interest
 * lines.  Looking at the normalised graph here keeps the solver aligned with
 * the rows the renderer actually emits.
 */
function statementRowForRole(modelCase, semanticRole) {
  return normalisedStatementDefinitions(modelCase).find(
    (row) => row.semantic_role === semanticRole,
  ) ?? null;
}

function statementRoleIsCalculated(modelCase, semanticRole, forecastIndex) {
  const row = statementRowForRole(modelCase, semanticRole);
  return Boolean(row && forecastRule(row, forecastIndex));
}

// A statement row's own FORECAST figure, resolved the way the workbook writes
// it: the broker pack first when the row names a metric, otherwise the row's
// stated series.
//
// A row whose forecast rule is a prior_period reference to ITSELF is a
// hold-flat chain anchored at the first forecast column (J), with K and L
// carrying `=J{row}` forward. Reading such a row's later stated entries would
// diverge from the chain the sheet actually evaluates, so all three forecast
// periods take the anchor's value. Mirrors isSelfCarry()/the carryAnchor branch
// in build_dynamic_model.mjs.
function statementRowForecastValue(modelCase, row, periodIndex) {
  const forecastIndex = periodIndex - 3;
  const authority = resolveForecastAuthority(modelCase, row, forecastIndex);
  if (authority.mechanism === "block") {
    throw new Error(
      `Unresolved forecast authority for ${row.row_id} in forecast period ${forecastIndex + 1}: ${authority.reason ?? authority.method}.`,
    );
  }
  if (authority.mechanism === "uncalculated" || authority.mechanism === "zero") {
    return 0;
  }
  if (authority.mechanism === "broker" && authority.broker_value !== null) {
    return Number(authority.broker_value);
  }
  if (authority.mechanism === "hardcode" && authority.value !== null) {
    return Number(authority.value);
  }
  const rule = forecastRule(row, forecastIndex);
  const selfCarry =
    !Array.isArray(row.forecast_period_calculations) &&
    !row.forecast_calculation &&
    rule?.operator === "prior_period" &&
    (rule.refs?.length ?? 0) === 1 &&
    rule.refs[0] === row.row_id;
  const index = selfCarry ? 3 : periodIndex;
  if (row.broker_metric_id) {
    const broker = brokerForecastValue(
      modelCase,
      row.broker_metric_id,
      index - 3,
    );
    if (broker !== null && broker !== undefined) return Number(broker);
  }
  const value = row.values?.[index];
  if (value === null || value === undefined) {
    throw new Error(
      `Forecast authority ${authority.method} for ${row.row_id} did not resolve a value in forecast period ${forecastIndex + 1}.`,
    );
  }
  return Number(value);
}

// The roles the solver already prices into pre-tax income by its own route:
// EBIT is the operating anchor and both interest legs are solved by the
// circular block, so a row carrying one of these must NOT be counted again.
const SOLVED_PRE_TAX_ROLES = new Set([
  "ebit",
  "interest_expense",
  "interest_income",
]);

/**
 * Everything the statement folds into Pre-Tax Income BELOW the operating line
 * that the solver has no other channel for — pension non-service cost, other
 * income / (expense), and their kin.
 *
 * The solver's pre-tax income used to be exactly `EBIT - net interest`, which
 * silently asserts that no such row exists. When one does, the cache the solver
 * patches in contradicts the `=SUM(...)` formula underneath it and the number
 * moves the first time Excel recalculates. So the channel is driven off the
 * statement's OWN Pre-Tax Income subtotal: walk its refs, expand nested
 * subtotals, drop the rows the solver already owns, and sum what is left. The
 * two definitions of pre-tax income are then the same definition.
 */
function otherNonOperatingIncome(modelCase, periodIndex) {
  const rows = modelCase.statement_structure?.income_statement ?? [];
  const preTaxRow = rows.find(
    (row) => row.semantic_role === "pre_tax_income",
  );
  if (!preTaxRow) return 0;
  // The subtotal's FORECAST rule, for the same reason the walk below uses it.
  const forecastIndex = periodIndex - 3;
  const preTaxRule = forecastRule(preTaxRow, forecastIndex);
  if (preTaxRule?.operator !== "sum") return 0;
  const rowsById = new Map(rows.map((row) => [row.row_id, row]));
  // One shared visit set: it stops a row referenced from two subtotals being
  // counted twice, and stops a malformed structure recursing without end.
  const visited = new Set();
  const walk = (rowId) => {
    if (visited.has(rowId)) return 0;
    visited.add(rowId);
    const row = rowsById.get(rowId);
    if (!row) return 0;
    if (SOLVED_PRE_TAX_ROLES.has(row.semantic_role)) return 0;
    // Expand a subtotal by the rule that governs its FORECAST columns, not its
    // historical one. A presentation subtotal can restate the operating line —
    // Kerry's "Operating profit" is `EBIT + non-trading items` in the forecast
    // — and folding its value in whole would count EBIT a second time. Walking
    // through it reaches the EBIT row, which the solver already owns and drops.
    const rule = forecastRule(row, forecastIndex);
    if (rule?.operator === "sum") {
      return (rule.refs ?? []).reduce((total, ref) => total + walk(ref), 0);
    }
    if (rule?.operator === "link") return walk(rule.refs?.[0]);
    return statementRowForecastValue(modelCase, row, periodIndex);
  };
  return (preTaxRule.refs ?? []).reduce((total, ref) => total + walk(ref), 0);
}

// Dividends and buybacks are outflows however the source signed them. Mirrors
// the -ABS() the builder applies when it caches those two rows; every other
// financing row is taken as the statement signs it.
const NEGATED_NON_DEBT_FINANCING_ROLES = new Set([
  "dividends",
  "share_buybacks",
]);

/**
 * Non-debt financing read off the rows the statement actually shows, rather
 * than off the `dividends_and_buybacks` aggregate metric.
 *
 * The aggregate is a broker-anchored number: metricValue() resolves it through
 * the broker pack, which carries DIVIDENDS and nothing else, so a case whose
 * financing block also shows share-withholding tax or an other-financing line
 * had those rows priced at zero by the solver while the `=SUM(...)` beneath
 * Net Cash from Financing counted them. The cache then contradicted the
 * formula it sat on. Summing the visible rows makes the two definitions one.
 *
 * Returns null when the statement declares no such rows — a case with no
 * statement structure at all keeps the aggregate-metric route unchanged.
 */
function visibleNonDebtFinancing(
  modelCase,
  periodIndex,
  previousValues,
  acquisitionBaseValues = null,
) {
  // Consume the compiler-normalised graph. The raw filing rows do not yet
  // contain the forecast waterfall decisions (carry, broker, formula, blank),
  // so solving against them would price visible carried financing rows at zero
  // while the emitted workbook correctly carried them forward.
  const cashFlowRows = normaliseStatementRows(modelCase, "cash_flow");
  const rowsById = new Map(cashFlowRows.map((row) => [row.row_id, row]));
  const financingTotal = cashFlowRows.find(
    (row) => row.semantic_role === "cash_from_financing",
  );
  const debtOrLiquidityMovements = new Set([
    "debt_issuance",
    "scheduled_amortisation",
    "maturity_repayment",
    "debt_issuance_cost",
    "other_cash_debt_movement",
    "rcf_draw",
    "rcf_repayment",
    "lease_principal",
  ]);
  // Membership comes from the statement topology, not from a label dictionary
  // or an optional movement tag. Every leaf that the declared financing total
  // owns is financing cash. Debt, RCF and lease leaves are solved in their
  // dedicated schedules; every remaining leaf is non-debt financing and must
  // enter liquidity exactly once. This preserves unusual issuer rows such as
  // dividend hedges, NCI purchases or share-withholding cash without requiring
  // the universe of possible labels to be encoded in advance.
  const visited = new Set();
  const rows = [];
  const collect = (rowId) => {
    if (visited.has(rowId)) return;
    visited.add(rowId);
    const row = rowsById.get(rowId);
    if (!row) return;
    const movementType = inferMovementType(row);
    const refs = row.calculation?.operator === "sum"
      ? row.calculation.refs ?? []
      : [];
    if (!movementType && refs.length > 0) {
      for (const ref of refs) collect(ref);
      return;
    }
    if (!debtOrLiquidityMovements.has(movementType)) rows.push(row);
  };
  for (const ref of financingTotal?.calculation?.refs ?? []) collect(ref);
  // Legacy cases without a declared financing subtotal retain the explicit
  // semantic-tag route. Production cases are required to declare the total.
  if (!financingTotal) {
    for (const row of cashFlowRows) {
      if (inferMovementType(row) === "non_debt_financing") collect(row.row_id);
    }
  }
  if (rows.length === 0) return null;
  const statementGraph = declaredStatementPeriod(
    modelCase,
    periodIndex,
    new Map(),
    previousValues,
    acquisitionBaseValues,
  );
  return rows.reduce((total, row) => {
    const value = statementGraph.resolve(row.row_id);
    return (
      total +
      (NEGATED_NON_DEBT_FINANCING_ROLES.has(row.semantic_role)
        ? -Math.abs(value)
        : value)
    );
  }, 0);
}

const NEGATIVE_STATEMENT_ROLES = new Set([
  "capex",
  "dividends",
  "share_buybacks",
]);

function evaluateStatementCalculation(
  calculation,
  resolve,
  previousValues,
) {
  const refs = calculation.refs ?? [];
  // Temporal edges are not current-period dependencies. Resolve them before
  // building the ordinary current-period value array, otherwise a legitimate
  // self carry such as `prior_period(pension_non_service)` recursively asks
  // the current column for itself in forecast years two and three. Coverage
  // already classifies these edges as temporal; the solver must do the same.
  if (calculation.operator === "prior_period") {
    return Number(previousValues.get(refs[0]) ?? 0);
  }
  if (calculation.operator === "prior_period_scaled_by") {
    const priorValue = Number(previousValues.get(refs[0]) ?? 0);
    const currentDriver = Number(resolve(refs[1]) ?? 0);
    const priorDriver = Number(previousValues.get(refs[1]) ?? 0);
    return priorDriver === 0
      ? 0
      : (priorValue * currentDriver) / priorDriver;
  }
  const values = refs.map((rowId) => Number(resolve(rowId) ?? 0));
  switch (calculation.operator) {
    case "sum":
      return values.reduce((sum, value) => sum + value, 0);
    case "link":
      return values[0] ?? 0;
    case "subtract":
      return values.slice(1).reduce(
        (value, item) => value - item,
        values[0] ?? 0,
      );
    case "negate":
      return -(values[0] ?? 0);
    case "negate_sum":
      return -values.reduce((sum, value) => sum + value, 0);
    case "ratio":
      return values[1] === 0 ? 0 : values[0] / values[1];
    case "negated_ratio":
      return values[1] === 0 ? 0 : -values[0] / values[1];
    case "growth": {
      const prior = Number(previousValues.get(refs[0]) ?? 0);
      return prior === 0 ? 0 : (values[0] ?? 0) / prior - 1;
    }
    case "tax":
      return (values[0] ?? 0) > 0
        ? -(values[0] ?? 0) * (values[1] ?? 0)
        : 0;
    case "average":
      return values.length === 0
        ? 0
        : values.reduce((sum, value) => sum + value, 0) / values.length;
    default:
      throw new Error(
        `Unsupported statement calculation operator ${calculation.operator}.`,
      );
  }
}

/**
 * Resolve one forecast period from the issuer's declared statement graph.
 *
 * `semanticOverrides` contains the quantities solved elsewhere in the economic
 * graph (interest, tax, debt and acquisition mechanics). Every other row is
 * evaluated from the case's own dependencies, so an unusual disclosed line is
 * included whenever the issuer's subtotal references it; no global list of
 * possible captions is needed.
 */
function declaredStatementPeriod(
  modelCase,
  periodIndex,
  semanticOverrides,
  previousValues,
  acquisitionBaseValues = null,
) {
  const forecastIndex = periodIndex - 3;
  // The economic graph and the workbook compiler must resolve the same
  // statement. The normaliser adds semantic rows such as the non-cash-interest
  // add-back and consolidated working-capital/debt movements; evaluating the
  // raw case here while rendering the normalised graph makes a cached value
  // contradict its visible formula.
  const definitions = normalisedStatementDefinitions(modelCase);
  const byId = new Map(
    definitions.map((definition) => [definition.row_id, definition]),
  );
  const bySemanticRole = new Map();
  for (const definition of definitions) {
    for (const role of [
      definition.semantic_role,
      definition.acquisition_driver_role,
    ]) {
      if (role && !bySemanticRole.has(role)) {
        bySemanticRole.set(role, definition.row_id);
      }
    }
  }
  const values = new Map();
  for (const definition of definitions) {
    const role =
      definition.acquisition_driver_role ?? definition.semantic_role;
    if (role && semanticOverrides.has(role)) {
      values.set(definition.row_id, Number(semanticOverrides.get(role)));
    }
  }
  // Period-specific rules describe the issuer's STANDALONE forecast chain.
  // The renderer deliberately gives those rows a zero acquisition adjustment;
  // therefore the economic graph must preserve their standalone solved values
  // too. Otherwise a rule such as `prior_period_scaled_by(..., revenue)` would
  // silently scale an issuer-only cost by target revenue in the acquisition
  // case, while the visible adjustment cell correctly remained zero. Seed the
  // rows from the independently solved acquisition-off graph and let every
  // downstream subtotal/link resolve from that shared value.
  if (acquisitionBaseValues) {
    for (const definition of definitions) {
      if (
        Array.isArray(definition.forecast_period_calculations) &&
        acquisitionBaseValues.has(definition.row_id)
      ) {
        values.set(
          definition.row_id,
          Number(acquisitionBaseValues.get(definition.row_id)),
        );
      }
    }
  }
  const visiting = new Set();
  const resolve = (rowId) => {
    if (values.has(rowId)) return values.get(rowId);
    if (visiting.has(rowId)) {
      throw new Error(`Statement dependency cycle at ${rowId}.`);
    }
    const definition = byId.get(rowId);
    if (!definition) return 0;
    visiting.add(rowId);
    const rule = forecastRule(definition, forecastIndex);
    const selfCarry =
      !Array.isArray(definition.forecast_period_calculations) &&
      !definition.forecast_calculation &&
      rule?.operator === "prior_period" &&
      (rule.refs?.length ?? 0) === 1 &&
      rule.refs[0] === definition.row_id;
    let value;
    if (selfCarry && forecastIndex === 0) {
      value = statementRowForecastValue(modelCase, definition, periodIndex);
    } else if (rule) {
      value = evaluateStatementCalculation(rule, resolve, previousValues);
    } else {
      value = statementRowForecastValue(modelCase, definition, periodIndex);
      if (NEGATIVE_STATEMENT_ROLES.has(definition.semantic_role)) {
        value = -Math.abs(value);
      }
    }
    visiting.delete(rowId);
    values.set(rowId, Number(value ?? 0));
    return values.get(rowId);
  };
  const resolveRole = (role) => {
    const rowId = bySemanticRole.get(role);
    return rowId ? resolve(rowId) : null;
  };
  const resolveAll = () => {
    for (const definition of definitions) resolve(definition.row_id);
    return values;
  };
  return { resolve, resolveRole, resolveAll, values };
}

function forecastAssumption(modelCase, key, forecastIndex, fallback = 0) {
  return asSeries3(modelCase.forecast_assumptions?.[key], fallback)[forecastIndex];
}

function fxRate(modelCase, currency, periodIndex, kind) {
  if (currency === modelCase.issuer.reporting_currency) return 1;
  const fx = modelCase.fx?.[currency];
  if (!fx) {
    throw new Error(`Missing FX assumptions for ${currency}.`);
  }
  const rates =
    kind === "average" ? fx.average_rates : fx.period_end_rates;
  const raw = Number(rates[periodIndex]);
  if (!(raw > 0)) throw new Error(`Invalid ${kind} FX rate for ${currency}.`);
  return fx.quote === "reporting_per_native" ? raw : 1 / raw;
}

function instrumentBalanceCurrency(modelCase, instrument) {
  return instrument?.balance_basis === "reporting_currency_carrying_value"
    ? modelCase.issuer.reporting_currency
    : instrument?.currency;
}

function allInRate(instrument, forecastIndex) {
  const manual = asSeries3(instrument.coupon_or_all_in_rate, 0)[forecastIndex];
  if (instrument.rate_type !== "floating") return manual;
  const benchmark = asSeries3(instrument.benchmark_rate, 0)[forecastIndex];
  const floor = asSeries3(instrument.benchmark_floor, 0)[forecastIndex];
  const spread = Number(instrument.spread_bps ?? 0) / 10000;
  // A contractual floor belongs to the reference leg, before the spread. Its
  // omission deliberately preserves the historic zero-floor behaviour.
  return Math.max(floor, benchmark) + spread;
}

function nonCashMovementComponents(instrument, forecastIndex) {
  const components = instrument.non_cash_movement_components;
  if (components && typeof components === "object") {
    return {
      fair_value: asSeries3(components.fair_value, 0)[forecastIndex],
      other: asSeries3(components.other, 0)[forecastIndex],
    };
  }
  return {
    fair_value: 0,
    other: asSeries3(instrument.other_non_cash_movement, 0)[forecastIndex],
  };
}

function solvedPikAccretion(weightedBase, pikRate, activeFraction = 1) {
  const rate = Number(pikRate ?? 0);
  if (!(rate > 0)) return 0;
  // Circularity-off is handled by the caller. PIK accrues on the exact
  // day-weighted principal outstanding before PIK. The accretion itself is
  // assumed to build evenly over the instrument's active part of the period,
  // so its closed-form fixed point is:
  //   PIK = weighted_base * rate / (1 - rate * active_fraction / 2)
  // Full-year undated cases reduce exactly to the historic average-balance
  // convention, while dated maturity/issuance/amortisation cases retain their
  // actual day count.
  const denominator = 1 - (rate * Number(activeFraction ?? 0)) / 2;
  if (!(denominator > 0)) {
    throw new Error("PIK rate must be below 200% under the average-balance convention.");
  }
  return Math.max(0, (Number(weightedBase ?? 0) * rate) / denominator);
}

// REMOVED 2026-07-26 alongside build_dynamic_model.mjs: couponsPerYear() and
// effectiveAnnualRate(). The workbook no longer grosses a coupon up to an
// effective annual rate, so the solver must not either — the stated rate is
// applied directly to the average balance, for every instrument class.

// The floor every acquisition denominator is tested against, matched to
// ACQUISITION_NEAR_ZERO in build_dynamic_model.mjs. Below it a ratio is
// floating-point residue, not an assumption, and dividing by it is how the
// revenue line came out at -1.69e19.
const ACQUISITION_NEAR_ZERO = 1e-9;

function acquisitionDebt(acquisition) {
  if (!acquisition?.enabled) return 0;
  // Enterprise value is an operating-economics input. Only the separately
  // supplied absolute debt amount enters debt, interest and leverage.
  return Number(acquisition.acquisition_debt_amount ?? 0);
}

// A well-shaped case carries exactly six periods, three historical then three
// forecast. Everything downstream indexes on that.
const hasSixPeriods = (modelCase) =>
  Array.isArray(modelCase?.periods) && modelCase.periods.length === 6;

function acquisitionCloseIndex(modelCase) {
  if (!modelCase.acquisition?.enabled) return -1;
  // Point-of-use defence, not the gate. The gate is validateCaseShape, which
  // reports `periods` as a named missing input before anything asks this
  // function to search it. This guard exists so that a caller which skipped
  // the gate gets -1 rather than a `Cannot read properties of undefined
  // (reading 'slice')` stack trace that names neither the case nor the field.
  if (!hasSixPeriods(modelCase)) return -1;
  const closeDate = new Date(
    Date.UTC(
      Number(modelCase.acquisition.close_year),
      Number(modelCase.acquisition.close_month) - 1,
      1,
    ),
  );
  return modelCase.periods
    .slice(3)
    .findIndex((item, forecastIndex) => {
      const end = new Date(item.date);
      const start = periodBounds(modelCase, forecastIndex + 3).start;
      return closeDate >= start && closeDate <= end;
    });
}

export function normalisedCashBuckets(modelCase) {
  const declared = modelCase.cash_policy?.buckets;
  if (Array.isArray(declared)) {
    return declared.map((bucket) => ({
      ...bucket,
      included_in_cash_flow_cash:
        bucket.included_in_cash_flow_cash !== false,
      linked_instrument_ids: [...(bucket.linked_instrument_ids ?? [])],
      historical_year_end: asSeries3(bucket.historical_year_end, 0),
      forecast_values:
        bucket.forecast_values === null ||
        bucket.forecast_values === undefined
          ? null
          : asSeries3(bucket.forecast_values, 0),
      cash_yield: asSeries3(bucket.cash_yield, 0),
    }));
  }
  const cash = modelCase.cash_policy ?? {};
  return [
    {
      bucket_id: "legacy_unrestricted",
      label: "Cash and cash equivalents",
      historical_year_end: asSeries3(cash.historical_year_end_cash, 0),
      opening_balance: Number(cash.opening_cash ?? 0),
      forecast_treatment: "balancing",
      forecast_values: null,
      available_for_liquidity: true,
      included_in_cash_flow_cash: true,
      linked_instrument_ids: [],
      net_debt_eligible_percentage: Number(
        cash.eligible_cash_percentage ?? 1,
      ),
      interest_eligible_percentage: Number(
        cash.eligible_cash_percentage ?? 1,
      ),
      cash_yield: asSeries3(cash.cash_yield, 0),
      source_line_ids: [],
      implicit_legacy: true,
    },
  ];
}

function balancingCashBucket(modelCase) {
  return normalisedCashBuckets(modelCase).find(
    (bucket) => bucket.forecast_treatment === "balancing",
  );
}

function minimumCash(modelCase) {
  if (Number(modelCase.contract_version) !== 2) {
    return Number(modelCase.cash_policy.minimum_cash);
  }
  const override = modelCase.cash_policy.minimum_cash_override;
  if (override !== null && override !== undefined) return Number(override);
  const balancing = balancingCashBucket(modelCase);
  if (balancing && Array.isArray(modelCase.cash_policy?.buckets)) {
    return Math.min(...asSeries3(balancing.historical_year_end, 0));
  }
  return Math.min(
    ...asSeries3(modelCase.cash_policy.historical_year_end_cash, 0),
  );
}

function legacyPeriodStart(periodEnd) {
  const end = new Date(periodEnd);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

function periodBounds(modelCase, periodIndex) {
  const periodEndDate = new Date(modelCase.periods[periodIndex].date);
  const priorPeriod = modelCase.periods[periodIndex - 1];
  const periodStartDate = priorPeriod
    ? new Date(new Date(priorPeriod.date).getTime() + 86400000)
    : legacyPeriodStart(periodEndDate);
  return { start: periodStartDate, end: periodEndDate };
}

function fractionBetween(start, end, periodStartDate, periodEndDate) {
  const boundedStart = new Date(
    Math.max(periodStartDate.getTime(), new Date(start).getTime()),
  );
  const boundedEnd = new Date(
    Math.min(periodEndDate.getTime(), new Date(end).getTime()),
  );
  if (boundedEnd < boundedStart) return 0;
  const total =
    periodEndDate.getTime() - periodStartDate.getTime() + 86400000;
  const elapsed = boundedEnd.getTime() - boundedStart.getTime() + 86400000;
  return Math.max(0, Math.min(1, elapsed / total));
}

function outstandingFraction(modelCase, periodIndex, startDate, endDate) {
  const bounds = periodBounds(modelCase, periodIndex);
  const start = startDate ?? bounds.start;
  const end = endDate ?? bounds.end;
  return fractionBetween(start, end, bounds.start, bounds.end);
}

function datedMovementFraction(dateValue, bounds, activeEnd, fallbackFraction) {
  if (dateValue === null || dateValue === undefined || dateValue === "") {
    return fallbackFraction;
  }
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return fallbackFraction;
  return fractionBetween(date, activeEnd, bounds.start, bounds.end);
}

function instrumentTiming(modelCase, periodIndex, instrument, {
  opening,
  issuance,
  fairValue,
  otherNonCash,
  amortisation,
} = {}) {
  const bounds = periodBounds(modelCase, periodIndex);
  const maturityRollEnabled = modelCase.controls.debt_maturities_roll === 1;
  const maturity = instrument.maturity_date
    ? new Date(instrument.maturity_date)
    : null;
  const matures =
    maturityRollEnabled &&
    maturity &&
    !Number.isNaN(maturity.getTime()) &&
    maturity <= bounds.end;
  const activeEnd = matures
    ? new Date(Math.min(bounds.end.getTime(), maturity.getTime()))
    : bounds.end;
  const activeFraction = fractionBetween(
    bounds.start,
    activeEnd,
    bounds.start,
    bounds.end,
  );
  const fallbackMovementFraction = activeFraction / 2;
  const forecastIndex = periodIndex - 3;
  const issuanceFraction = datedMovementFraction(
    instrument.new_issuance_dates?.[forecastIndex],
    bounds,
    activeEnd,
    fallbackMovementFraction,
  );
  const amortisationFraction = datedMovementFraction(
    instrument.scheduled_amortisation_dates?.[forecastIndex],
    bounds,
    activeEnd,
    fallbackMovementFraction,
  );
  const weightedBase =
    Number(opening ?? 0) * activeFraction +
    Number(issuance ?? 0) * issuanceFraction +
    (Number(fairValue ?? 0) + Number(otherNonCash ?? 0)) *
      fallbackMovementFraction -
    Number(amortisation ?? 0) * amortisationFraction;
  return {
    activeFraction,
    issuanceFraction,
    amortisationFraction,
    weightedBase: Math.max(0, weightedBase),
    matures,
  };
}

export function validateCaseShape(modelCase) {
  const schema =
    Number(modelCase?.contract_version) === 2
      ? modelCaseV2Schema
      : modelCaseSchema;
  const errors = validateJsonSchema(modelCase, schema);
  const isSeries3 = (value) =>
    Array.isArray(value) && value.length === 3 && value.every((item) => Number.isFinite(Number(item)));
  const isSeries6 = (value) =>
    Array.isArray(value) && value.length === 6 && value.every((item) => item === null || Number.isFinite(Number(item)));
  if (!modelCase || typeof modelCase !== "object") {
    return [...errors, "Case must be an object."];
  }
  if (!modelCase.case_id) errors.push("case_id is required.");
  if (!modelCase.issuer?.name) errors.push("issuer.name is required.");
  if (!/^[A-Z]{3}$/.test(modelCase.issuer?.reporting_currency ?? "")) {
    errors.push("issuer.reporting_currency must be a three-letter code.");
  }
  if (!["units", "thousands", "millions"].includes(modelCase.issuer?.units)) {
    errors.push("issuer.units must be units, thousands or millions.");
  }
  if (!/^\d{2}-\d{2}$/.test(modelCase.issuer?.fiscal_year_end ?? "")) {
    errors.push("issuer.fiscal_year_end must be MM-DD.");
  }
  // Recorded rather than only pushed: several checks below index into periods,
  // and a case that fails here must leave this function with `periods` named as
  // the missing input, not die inside one of them.
  const periodsWellFormed = hasSixPeriods(modelCase);
  if (!periodsWellFormed) {
    errors.push(
      Array.isArray(modelCase.periods)
        ? `periods must contain exactly six periods (three historical then three forecast); this case supplies ${modelCase.periods.length}.`
        : "periods is required and must contain exactly six periods (three historical then three forecast); this case supplies none.",
    );
  } else {
    const statuses = modelCase.periods.map((item) => item.status);
    if (
      statuses.slice(0, 3).some((status) => status !== "historical") ||
      statuses.slice(3).some((status) => status !== "forecast")
    ) {
      errors.push("periods must contain three historical then three forecast periods.");
    }
  }
  if (!Array.isArray(modelCase.instruments)) {
    errors.push("instruments must be an array.");
  }
  for (const metricId of ["revenue", "adjusted_ebitda", "depreciation_and_amortisation", "change_in_working_capital", "capex", "tax"]) {
    const metric = modelCase.operating_metrics?.[metricId];
    if (!metric || !isSeries6(metric.values)) errors.push(`operating_metrics.${metricId}.values must contain six numeric or null values.`);
    if (!metric?.forecast_method) errors.push(`operating_metrics.${metricId}.forecast_method is required.`);
  }
  const cash = modelCase.cash_policy;
  const explicitCashBuckets = Array.isArray(cash?.buckets);
  if (
    !explicitCashBuckets &&
    (!cash ||
      !Number.isFinite(Number(cash.opening_cash)) ||
      Number(cash.opening_cash) < 0)
  ) {
    errors.push("cash_policy.opening_cash is required and must be non-negative.");
  }
  if (Number(modelCase.contract_version) === 2) {
    if (!explicitCashBuckets && !isSeries3(cash?.historical_year_end_cash)) {
      errors.push(
        "cash_policy.historical_year_end_cash must contain three balances.",
      );
    }
    if (
      cash?.minimum_cash_override !== null &&
      cash?.minimum_cash_override !== undefined &&
      (!Number.isFinite(Number(cash.minimum_cash_override)) ||
        Number(cash.minimum_cash_override) < 0)
    ) {
      errors.push(
        "cash_policy.minimum_cash_override must be null or non-negative.",
      );
    }
  } else if (!cash || !Number.isFinite(Number(cash.minimum_cash)) || Number(cash.minimum_cash) < 0) {
    errors.push("cash_policy.minimum_cash is required and must be non-negative.");
  }
  if (!explicitCashBuckets) {
    if (!cash || !Number.isFinite(Number(cash.eligible_cash_percentage)) || Number(cash.eligible_cash_percentage) < 0 || Number(cash.eligible_cash_percentage) > 1) errors.push("cash_policy.eligible_cash_percentage must be between zero and one.");
    if (!isSeries3(cash?.cash_yield)) errors.push("cash_policy.cash_yield must contain three rates.");
  } else {
    const ids = new Set();
    let balancingCount = 0;
    const linkedInstrumentOwners = new Map();
    const instrumentsById = new Map(
      (modelCase.instruments ?? []).map((instrument) => [
        instrument.instrument_id,
        instrument,
      ]),
    );
    for (const bucket of cash.buckets) {
      const id = bucket.bucket_id ?? "unknown";
      if (!bucket.bucket_id || ids.has(bucket.bucket_id)) {
        errors.push(`cash_policy.buckets needs unique bucket_id values; found ${id}.`);
      }
      ids.add(bucket.bucket_id);
      if (!String(bucket.label ?? "").trim()) {
        errors.push(`cash_policy.buckets.${id}.label is required.`);
      }
      if (!isSeries3(bucket.historical_year_end)) {
        errors.push(`cash_policy.buckets.${id}.historical_year_end must contain three balances.`);
      } else if (bucket.historical_year_end.some((value) => Number(value) < 0)) {
        errors.push(`cash_policy.buckets.${id}.historical_year_end cannot be negative.`);
      }
      if (!["balancing", "hardcode", "flat", "linked_debt_addback"].includes(bucket.forecast_treatment)) {
        errors.push(`cash_policy.buckets.${id}.forecast_treatment is invalid.`);
      }
      if (bucket.forecast_treatment === "balancing") balancingCount += 1;
      const shouldBeLiquidityAvailable = bucket.forecast_treatment === "balancing";
      if (bucket.available_for_liquidity !== shouldBeLiquidityAvailable) {
        errors.push(
          `cash_policy.buckets.${id}.available_for_liquidity must be ${shouldBeLiquidityAvailable} ` +
            `when forecast_treatment is ${bucket.forecast_treatment}; only the balancing bucket may drive the minimum-cash/RCF waterfall.`,
        );
      }
      if (
        bucket.forecast_treatment === "hardcode" &&
        !isSeries3(bucket.forecast_values)
      ) {
        errors.push(`cash_policy.buckets.${id}.forecast_values must contain three balances for hardcode treatment.`);
      }
      if (bucket.forecast_treatment === "linked_debt_addback") {
        if (bucket.included_in_cash_flow_cash !== false) {
          errors.push(`cash_policy.buckets.${id}.included_in_cash_flow_cash must be false for linked_debt_addback treatment.`);
        }
        if (bucket.net_debt_eligible_percentage !== 1) {
          errors.push(`cash_policy.buckets.${id}.net_debt_eligible_percentage must be 1 for linked_debt_addback treatment.`);
        }
        if (bucket.interest_eligible_percentage !== 0 ||
            !isSeries3(bucket.cash_yield) ||
            bucket.cash_yield.some((value) => Number(value) !== 0)) {
          errors.push(`cash_policy.buckets.${id} must have zero interest eligibility and zero cash yield for linked_debt_addback treatment.`);
        }
        if (bucket.forecast_values !== undefined && bucket.forecast_values !== null) {
          errors.push(`cash_policy.buckets.${id}.forecast_values must be omitted for linked_debt_addback treatment.`);
        }
        if (!Array.isArray(bucket.linked_instrument_ids) || bucket.linked_instrument_ids.length === 0) {
          errors.push(`cash_policy.buckets.${id}.linked_instrument_ids must name at least one debt instrument.`);
        } else {
          let linkedOpeningReporting = 0;
          for (const instrumentId of bucket.linked_instrument_ids) {
            const instrument = instrumentsById.get(instrumentId);
            if (!instrument) {
              errors.push(`cash_policy.buckets.${id} links unknown instrument ${instrumentId}.`);
              continue;
            }
            if (instrument.class === "rcf") {
              errors.push(`cash_policy.buckets.${id} cannot link balancing RCF instrument ${instrumentId}.`);
            }
            if (instrument.include_in_gross_debt !== true || instrument.include_in_net_debt !== true) {
              errors.push(`cash_policy.buckets.${id} linked instrument ${instrumentId} must be included in both gross debt and net debt.`);
            }
            if (linkedInstrumentOwners.has(instrumentId)) {
              errors.push(`cash_policy.buckets.${id} duplicates linked instrument ${instrumentId} already owned by ${linkedInstrumentOwners.get(instrumentId)}.`);
            } else {
              linkedInstrumentOwners.set(instrumentId, id);
            }
            linkedOpeningReporting +=
              Number(instrument.opening_balance ?? 0) *
              fxRate(
                modelCase,
                instrumentBalanceCurrency(modelCase, instrument),
                2,
                "period_end",
              );
          }
          const latestHistorical = Number(bucket.historical_year_end?.[2] ?? 0);
          if (Math.abs(latestHistorical - linkedOpeningReporting) > 1e-8) {
            errors.push(
              `cash_policy.buckets.${id} latest historical balance ${latestHistorical} must equal the reporting-currency opening balance ${linkedOpeningReporting} of its linked debt instruments.`,
            );
          }
        }
      } else if (Array.isArray(bucket.linked_instrument_ids) && bucket.linked_instrument_ids.length > 0) {
        errors.push(`cash_policy.buckets.${id}.linked_instrument_ids is only valid for linked_debt_addback treatment.`);
      }
      if (
        bucket.forecast_values !== undefined &&
        bucket.forecast_values !== null &&
        (!isSeries3(bucket.forecast_values) ||
          bucket.forecast_values.some((value) => Number(value) < 0))
      ) {
        errors.push(`cash_policy.buckets.${id}.forecast_values must be three non-negative balances.`);
      }
      for (const field of [
        "net_debt_eligible_percentage",
        "interest_eligible_percentage",
      ]) {
        const value = Number(bucket[field]);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          errors.push(`cash_policy.buckets.${id}.${field} must be between zero and one.`);
        }
      }
      if (!isSeries3(bucket.cash_yield)) {
        errors.push(`cash_policy.buckets.${id}.cash_yield must contain three rates.`);
      }
    }
    if (balancingCount !== 1) {
      errors.push(`cash_policy.buckets must contain exactly one balancing bucket; found ${balancingCount}.`);
    }
  }
  if (
    cash?.balance_interest_method &&
    cash.balance_interest_method !== "average_balance"
  ) {
    errors.push(
      "cash_policy.balance_interest_method must be average_balance in the production profile.",
    );
  }
  if (modelCase.modules?.multi_currency && !modelCase.fx) {
    errors.push("Multi-currency module is enabled but FX assumptions are absent.");
  }
  if (
    modelCase.modules?.historical_normalisation &&
    !Array.isArray(modelCase.historical_entities)
  ) {
    errors.push(
      "Historical-normalisation module is enabled but historical_entities are absent.",
    );
  }
  if (modelCase.modules?.historical_normalisation) {
    const historicalEntityIds = new Set();
    for (const entity of modelCase.historical_entities ?? []) {
      if (!entity.entity_id) errors.push("Each historical entity needs entity_id.");
      if (historicalEntityIds.has(entity.entity_id)) {
        errors.push(`Duplicate historical entity_id: ${entity.entity_id}.`);
      }
      historicalEntityIds.add(entity.entity_id);
      if (entity.metrics_basis !== "reporting_currency_calendarised") {
        errors.push(
          `historical_entities.${entity.entity_id ?? "unknown"}.metrics_basis must be reporting_currency_calendarised.`,
        );
      }
      if (
        !Array.isArray(entity.calendarisation_notes) ||
        entity.calendarisation_notes.length !== 3 ||
        entity.calendarisation_notes.some(
          (note) => typeof note !== "string" || note.trim().length === 0,
        )
      ) {
        errors.push(
          `historical_entities.${entity.entity_id ?? "unknown"}.calendarisation_notes must contain three non-empty period notes.`,
        );
      }
      for (const [metricId, values] of Object.entries(entity.metrics ?? {})) {
        if (!isSeries3(values)) {
          errors.push(
            `historical_entities.${entity.entity_id ?? "unknown"}.metrics.${metricId} must contain three reporting-currency values.`,
          );
        }
      }
      for (const [metricId, values] of Object.entries(
        entity.metric_specific_eliminations ?? {},
      )) {
        if (!isSeries3(values)) {
          errors.push(
            `historical_entities.${entity.entity_id ?? "unknown"}.metric_specific_eliminations.${metricId} must contain three reporting-currency values.`,
          );
        }
      }
    }
  }
  const ids = new Set();
  for (const instrument of modelCase.instruments ?? []) {
    if (!instrument.instrument_id) errors.push("Each instrument needs instrument_id.");
    if (ids.has(instrument.instrument_id)) {
      errors.push(`Duplicate instrument_id: ${instrument.instrument_id}.`);
    }
    ids.add(instrument.instrument_id);
    if (!instrument.name) errors.push(`Instrument ${instrument.instrument_id ?? "[unknown]"} needs a name.`);
    if (!/^[A-Z]{3}$/.test(instrument.currency ?? "")) errors.push(`Instrument ${instrument.instrument_id ?? "[unknown]"} needs a three-letter currency.`);
    if (!Number.isFinite(Number(instrument.opening_balance)) || Number(instrument.opening_balance) < 0) errors.push(`Instrument ${instrument.instrument_id ?? "[unknown]"} has an invalid opening_balance.`);
    if (!Number.isInteger(instrument.display_order)) errors.push(`Instrument ${instrument.instrument_id ?? "[unknown]"} needs an integer display_order.`);
    if (!["fixed", "floating", "manual_all_in"].includes(instrument.rate_type)) errors.push(`Instrument ${instrument.instrument_id ?? "[unknown]"} has an invalid rate_type.`);
    if (
      (!instrument.maturity_date ||
        Number.isNaN(new Date(instrument.maturity_date).getTime())) &&
      instrument.class !== "rcf" &&
      instrument.maturity_treatment !== "non_maturing_within_forecast"
    ) {
      errors.push(
        `Material instrument ${instrument.instrument_id} has no maturity_date or documented non_maturing_within_forecast treatment.`,
      );
    }
    if (
      instrument.class !== "rcf" &&
      instrument.maturity_treatment === "non_maturing_within_forecast" &&
      !String(instrument.assumption_note ?? "").trim()
    ) {
      errors.push(
        `Instrument ${instrument.instrument_id} needs an assumption_note for non_maturing_within_forecast treatment.`,
      );
    }
    if (instrument.rate_type === "floating" && !instrument.benchmark_rate) {
      errors.push(`Floating instrument ${instrument.instrument_id} has no benchmark_rate.`);
    }
    if (instrument.rate_type === "floating" && !isSeries3(instrument.benchmark_rate)) errors.push(`Floating instrument ${instrument.instrument_id} needs three benchmark rates.`);
    if (instrument.benchmark_floor !== undefined && instrument.rate_type !== "floating") {
      errors.push(`Instrument ${instrument.instrument_id} declares benchmark_floor but is not floating.`);
    }
    if (instrument.benchmark_floor !== undefined && !isSeries3(instrument.benchmark_floor)) {
      errors.push(`Instrument ${instrument.instrument_id} benchmark_floor must contain three values.`);
    }
    if (
      instrument.benchmark_floor !== undefined &&
      instrument.benchmark_floor.some((value) => !Number.isFinite(Number(value)))
    ) {
      errors.push(`Instrument ${instrument.instrument_id} benchmark_floor contains a non-numeric value.`);
    }
    if (instrument.pik_rate !== undefined && !isSeries3(instrument.pik_rate)) {
      errors.push(`Instrument ${instrument.instrument_id} pik_rate must contain three values.`);
    }
    if (
      instrument.pik_rate !== undefined &&
      instrument.pik_rate.some(
        (value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 2,
      )
    ) {
      errors.push(`Instrument ${instrument.instrument_id} pik_rate must be numeric, non-negative and below 200%.`);
    }
    if (
      instrument.other_non_cash_movement !== undefined &&
      instrument.non_cash_movement_components !== undefined
    ) {
      errors.push(
        `Instrument ${instrument.instrument_id} may use other_non_cash_movement or non_cash_movement_components, not both.`,
      );
    }
    if (
      instrument.other_non_cash_movement !== undefined &&
      !isSeries3(instrument.other_non_cash_movement)
    ) {
      errors.push(`Instrument ${instrument.instrument_id} other_non_cash_movement must contain three values.`);
    }
    if (instrument.non_cash_movement_components !== undefined) {
      const components = instrument.non_cash_movement_components;
      if (!components || typeof components !== "object" || Array.isArray(components)) {
        errors.push(`Instrument ${instrument.instrument_id} non_cash_movement_components must be an object.`);
      } else {
        const allowed = new Set(["fair_value", "other"]);
        const keys = Object.keys(components);
        if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
          errors.push(`Instrument ${instrument.instrument_id} non_cash_movement_components has no valid component or contains an unknown component.`);
        }
        for (const key of keys.filter((item) => allowed.has(item))) {
          if (!isSeries3(components[key])) {
            errors.push(`Instrument ${instrument.instrument_id} non_cash_movement_components.${key} must contain three values.`);
          }
        }
      }
    }
    if (instrument.rate_type !== "floating" && !isSeries3(instrument.coupon_or_all_in_rate)) errors.push(`Instrument ${instrument.instrument_id} needs three coupon/all-in rates.`);
    if (instrument.new_issuance !== undefined && !isSeries3(instrument.new_issuance)) errors.push(`Instrument ${instrument.instrument_id} new_issuance must contain three values.`);
    if (
      instrument.forecast_ending_balances !== undefined &&
      (!isSeries3(instrument.forecast_ending_balances) ||
        instrument.forecast_ending_balances.some((value) => Number(value) < 0))
    ) {
      errors.push(
        `Instrument ${instrument.instrument_id} forecast_ending_balances must contain three non-negative native-currency balances.`,
      );
    }
    if (
      instrument.forecast_ending_balances !== undefined &&
      !String(instrument.balance_authority_note ?? "").trim()
    ) {
      errors.push(
        `Instrument ${instrument.instrument_id} needs balance_authority_note when forecast_ending_balances is supplied.`,
      );
    }
    if (instrument.scheduled_amortisation !== undefined && !isSeries3(instrument.scheduled_amortisation)) errors.push(`Instrument ${instrument.instrument_id} scheduled_amortisation must contain three values.`);
    if (instrument.class === "rcf" && (!Number.isFinite(Number(instrument.facility_capacity)) || Number(instrument.facility_capacity) < 0)) {
      errors.push(`RCF ${instrument.instrument_id} has no facility_capacity.`);
    }
  }
  if (!modelCase.cash_policy) errors.push("cash_policy is required.");
  errors.push(...validateBalancingRcf(modelCase));
  const rcf = balancingRcfInstrument(modelCase);
  const rcfCapacity = modelCase.rcf_policy?.capacity ?? rcf?.facility_capacity;
  if (rcf && (!Number.isFinite(Number(rcfCapacity)) || Number(rcfCapacity) < 0)) errors.push("RCF capacity is required and must be non-negative.");
  if (rcf) {
    if (rcf.forecast_ending_balances !== undefined) {
      errors.push(
        "The balancing RCF cannot supply forecast_ending_balances because the liquidity waterfall solves that balance.",
      );
    }
    const policyOpening = Number(modelCase.rcf_policy?.opening_draw ?? 0);
    const instrumentOpening = Number(rcf.opening_balance ?? 0);
    const policyCapacity = Number(modelCase.rcf_policy?.capacity);
    const instrumentCapacity = Number(rcf.facility_capacity);
    if (Math.abs(policyOpening - instrumentOpening) > 1e-8) {
      errors.push(
        "rcf_policy.opening_draw must equal the RCF instrument opening_balance.",
      );
    }
    if (Math.abs(policyCapacity - instrumentCapacity) > 1e-8) {
      errors.push(
        "rcf_policy.capacity must equal the RCF instrument facility_capacity.",
      );
    }
    if (policyOpening > policyCapacity + 1e-8) {
      errors.push("RCF opening draw cannot exceed facility capacity.");
    }
  }
  if (!modelCase.lease_policy?.mode) {
    errors.push("lease_policy.mode is required.");
  } else if (modelCase.lease_policy.mode !== "exclude") {
    for (const key of [
      "principal_repayment",
      "effective_rate",
      "include_in_gross_debt",
      "include_in_net_debt",
      "include_in_leverage",
    ]) {
      if (modelCase.lease_policy[key] === undefined) {
        errors.push(`lease_policy.${key} is required for the selected mode.`);
      }
    }
    // The opening balance may be stated either as the three reported actuals
    // (preferred — each historical column then carries its own figure) or, for
    // older cases, as a lone scalar. One of the two has to be there.
    const historicalLiabilities =
      modelCase.lease_policy.historical_liabilities;
    if (historicalLiabilities === undefined) {
      if (modelCase.lease_policy.opening_liability === undefined) {
        errors.push(
          "lease_policy requires historical_liabilities (preferred) or opening_liability.",
        );
      }
    } else if (
      !Array.isArray(historicalLiabilities) ||
      historicalLiabilities.length !== 3 ||
      historicalLiabilities.some((value) => !Number.isFinite(Number(value)))
    ) {
      errors.push(
        "lease_policy.historical_liabilities must be three numeric period-end balances.",
      );
    }
    if (
      modelCase.lease_policy.mode === "simple_roll_forward" &&
      modelCase.lease_policy.additions === undefined
    ) {
      errors.push("lease_policy.additions is required for simple_roll_forward.");
    }
  }
  errors.push(...validateLeasePolicy(modelCase));
  if (modelCase.modules?.acquisition && !modelCase.acquisition) {
    errors.push("Acquisition module is enabled but acquisition inputs are absent.");
  }
  if (!modelCase.modules?.acquisition && modelCase.acquisition?.enabled) {
    errors.push(
      "acquisition.enabled cannot be 1 when modules.acquisition is false.",
    );
  }
  if (modelCase.acquisition?.enabled) {
    if (!(acquisitionDebt(modelCase.acquisition) > 0)) {
      errors.push(
        "Enabled acquisition needs acquisition_debt_amount greater than zero.",
      );
    }
    if (!(Number(modelCase.acquisition.entry_ev_to_ebitda) > 0)) {
      errors.push("Enabled acquisition needs entry_ev_to_ebitda greater than zero.");
    }
    if (
      Number(modelCase.contract_version) === 2 &&
      !(Number(modelCase.acquisition.transaction_enterprise_value) > 0)
    ) {
      errors.push(
        "Enabled v2 acquisition needs transaction_enterprise_value greater than zero.",
      );
    }
    if (
      !Number.isInteger(modelCase.acquisition.close_month) ||
      modelCase.acquisition.close_month < 1 ||
      modelCase.acquisition.close_month > 12
    ) {
      errors.push("Enabled acquisition close_month must be between 1 and 12.");
    }
    // Only meaningful once there ARE three forecast periods to fall within.
    // Run against a case with no periods this check used to throw out of
    // acquisitionCloseIndex; run against one with a guard but no gate it would
    // report a close-date problem when the real missing input is `periods`.
    if (
      periodsWellFormed &&
      Number.isInteger(modelCase.acquisition.close_month) &&
      acquisitionCloseIndex(modelCase) < 0
    ) {
      errors.push(
        "Enabled acquisition close date must fall within one of the three forecast periods.",
      );
    }
  }
  const dates = (modelCase.periods ?? []).map((item) =>
    new Date(item.date).getTime(),
  );
  if (dates.some(Number.isNaN)) errors.push("All period dates must be valid.");
  if (dates.some((date, index) => index > 0 && date <= dates[index - 1])) {
    errors.push("Period dates must be strictly increasing.");
  }
  if (Number(modelCase.contract_version) === 2) {
    const referenceParity = modelCase.execution_profile === "reference_parity";
    if (!referenceParity) {
      if (modelCase.execution_profile !== "production_model") {
        errors.push(
          "execution_profile must be production_model for an end-user build; archived and synthetic regression cases must declare reference_parity explicitly.",
        );
      }
      if (
        modelCase.source_coverage?.classification_contract_version !==
        "evidence_v1"
      ) {
        errors.push(
          "production_model requires source_coverage.classification_contract_version=evidence_v1; an absent or legacy evidence contract cannot enter the builder.",
        );
      }
      if (modelCase.statement_authority_contract_version !== "authority_v1") {
        errors.push(
          "production_model requires statement_authority_contract_version=authority_v1.",
        );
      }
      if (modelCase.forecast_authority_contract_version !== "waterfall_v1") {
        errors.push(
          "production_model requires forecast_authority_contract_version=waterfall_v1; legacy blank and implicit-zero forecasts cannot enter the builder.",
        );
      }
    }
    try {
      errors.push(
        ...validateForecastAuthorities(modelCase, [
          ...(modelCase.statement_structure?.income_statement ?? []),
          ...(modelCase.statement_structure?.cash_flow ?? []),
        ]).map((message) => `forecast_authority.${message}`),
      );
    } catch (error) {
      errors.push(`forecast_authority validation failed: ${error.message}`);
    }
  }
  return errors;
}

export function solveCase(
  modelCase,
  {
    tolerance = 1e-8,
    maxIterations = 200,
    acquisitionBaseSolution = null,
  } = {},
) {
  const shapeErrors = validateCaseShape(modelCase);
  if (shapeErrors.length > 0) {
    const error = new Error(`Invalid model case:\n- ${shapeErrors.join("\n- ")}`);
    error.validationErrors = shapeErrors;
    throw error;
  }
  const dynamicV2 = Number(modelCase.contract_version) === 2;
  // An acquisition overlay is an adjustment to the issuer's standalone graph,
  // not a second opportunity to reinterpret issuer-only forecast chains. Solve
  // the acquisition-off state once and use it as the explicit base for rows
  // carrying period-specific forecast rules. Callers that already need both
  // states (the workbook builder) can supply the base and avoid duplicate work.
  let resolvedAcquisitionBaseSolution = acquisitionBaseSolution;
  if (
    Number(modelCase.acquisition?.enabled ?? 0) === 1 &&
    !resolvedAcquisitionBaseSolution
  ) {
    const acquisitionOffCase = structuredClone(modelCase);
    acquisitionOffCase.acquisition.enabled = 0;
    resolvedAcquisitionBaseSolution = solveCase(acquisitionOffCase, {
      tolerance,
      maxIterations,
    });
  }
  // Which single EBIT/EBITDA metric anchors the forecast, with D&A as the
  // bridge driver, and what the visible EBITDA bridge adds between them.
  // Resolved once, from the case's own broker pack
  // and semantic roles — never per-issuer, never by row number. Null means the
  // pack is too thin for the rule and the case solves exactly as authored.
  const anchorPlan = requireResolvedAnchorPlan(
    modelCase,
    modelCase.statement_structure?.income_statement ?? [],
  );

  const instruments = [...modelCase.instruments].sort(
    (a, b) =>
      Number(a.display_order) - Number(b.display_order) ||
      String(a.instrument_id).localeCompare(String(b.instrument_id)),
  );
  const rcfInstrument = balancingRcfInstrument({
    ...modelCase,
    instruments,
  });
  if (!rcfInstrument) {
    throw new Error(
      `Balancing RCF ${modelCase.rcf_policy?.instrument_id ?? "[missing]"} is absent.`,
    );
  }
  const foreignRcf =
    rcfInstrument.currency !== modelCase.issuer.reporting_currency;
  const nonRcfInstruments = instruments.filter(
    (item) =>
      item.instrument_id !== rcfInstrument.instrument_id &&
      item.class !== "lease",
  );
  const instrumentBalances = new Map(
    nonRcfInstruments.map((item) => [
      item.instrument_id,
      Number(item.opening_balance ?? 0),
    ]),
  );

  const cashBuckets = normalisedCashBuckets(modelCase);
  const balancingBucket = cashBuckets.find(
    (bucket) => bucket.forecast_treatment === "balancing",
  );
  let cashBucketBalances = new Map(
    cashBuckets.map((bucket) => [
      bucket.bucket_id,
      Number(
        bucket.opening_balance ?? bucket.historical_year_end?.[2] ?? 0,
      ),
    ]),
  );
  let openingCash = Number(
    cashBucketBalances.get(balancingBucket.bucket_id) ?? 0,
  );
  let openingRcfNative = Number(
    modelCase.rcf_policy?.opening_draw ?? rcfInstrument?.opening_balance ?? 0,
  );
  let openingRcf = foreignRcf
    ? openingRcfNative *
      fxRate(modelCase, rcfInstrument.currency, 2, "period_end")
    : openingRcfNative;
  let openingLease = leaseOpeningLiability(modelCase);
  const leaseProjection = leaseForecast(modelCase);
  let openingAcquisitionDebt = 0;
  let priorTargetEbitda = null;
  const closeIndex = acquisitionCloseIndex(modelCase);
  const acquisitionDebtAmount = acquisitionDebt(modelCase.acquisition);
  const results = [];
  // The first forecast column may reference the last historical column through
  // growth or prior-period rules. Reported row values are the authoritative
  // historical state; each solved forecast map replaces this for the next pass.
  let previousStatementValues = new Map(
    [
      ...(modelCase.statement_structure?.income_statement ?? []),
      ...(modelCase.statement_structure?.cash_flow ?? []),
    ].map((definition) => [
      definition.row_id,
      Number(definition.values?.[2] ?? 0),
    ]),
  );
  // The acquisition target inherits the standalone EBITDA growth, so the prior
  // year's standalone EBITDA has to survive into the next pass.
  let priorStandaloneEbitda = metricValue(modelCase, "adjusted_ebitda", 2, 0);

  for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
    const periodIndex = forecastIndex + 3;
    const period = modelCase.periods[periodIndex];
    const acquisitionBaseValues = resolvedAcquisitionBaseSolution
      ? new Map(
          Object.entries(
            resolvedAcquisitionBaseSolution.forecast?.[forecastIndex]
              ?.statement_values ?? {},
          ),
        )
      : null;
    const openingBucketBalances = new Map(cashBucketBalances);
    const fixedEndingBucketBalances = new Map();
    for (const bucket of cashBuckets) {
      if (bucket.bucket_id === balancingBucket.bucket_id) continue;
      const opening = Number(openingBucketBalances.get(bucket.bucket_id) ?? 0);
      fixedEndingBucketBalances.set(
        bucket.bucket_id,
        bucket.forecast_treatment === "hardcode"
          ? Number(bucket.forecast_values?.[forecastIndex] ?? 0)
          : opening,
      );
    }
    const nonBalancingCashBucketMovement = cashBuckets
      .filter(
        (bucket) =>
          bucket.bucket_id !== balancingBucket.bucket_id &&
          bucket.included_in_cash_flow_cash !== false,
      )
      .reduce(
        (total, bucket) =>
          total +
          Number(fixedEndingBucketBalances.get(bucket.bucket_id) ?? 0) -
          Number(openingBucketBalances.get(bucket.bucket_id) ?? 0),
        0,
      );
    const cashBucketSnapshot = (balancingEndingCash) => {
      const balances = new Map(fixedEndingBucketBalances);
      balances.set(balancingBucket.bucket_id, Number(balancingEndingCash));
      let reportedCash = 0;
      let cashFlowCash = 0;
      let liquidityCash = 0;
      let netDebtEligibleCash = 0;
      let interestEligibleCash = 0;
      let interestIncome = 0;
      const detail = [];
      for (const bucket of cashBuckets) {
        const opening = Number(openingBucketBalances.get(bucket.bucket_id) ?? 0);
        const ending = Number(balances.get(bucket.bucket_id) ?? 0);
        const netDebtPercentage = Number(
          bucket.net_debt_eligible_percentage ?? 0,
        );
        const interestPercentage = Number(
          bucket.interest_eligible_percentage ?? 0,
        );
        const yieldRate = Number(bucket.cash_yield?.[forecastIndex] ?? 0);
        reportedCash += ending;
        if (bucket.included_in_cash_flow_cash !== false) cashFlowCash += ending;
        if (bucket.available_for_liquidity) liquidityCash += ending;
        netDebtEligibleCash += ending * netDebtPercentage;
        interestEligibleCash += ending * interestPercentage;
        const bucketInterestIncome =
          ((opening + ending) / 2) * interestPercentage * yieldRate;
        interestIncome += bucketInterestIncome;
        detail.push({
          bucket_id: bucket.bucket_id,
          label: bucket.label,
          opening_balance: opening,
          ending_balance: ending,
          available_for_liquidity: bucket.available_for_liquidity,
          included_in_cash_flow_cash:
            bucket.included_in_cash_flow_cash !== false,
          net_debt_eligible_percentage: netDebtPercentage,
          interest_eligible_percentage: interestPercentage,
          cash_yield: yieldRate,
          interest_income: bucketInterestIncome,
        });
      }
      return {
        balances,
        detail,
        reported_cash: reportedCash,
        cash_flow_cash: cashFlowCash,
        liquidity_cash: liquidityCash,
        net_debt_eligible_cash: netDebtEligibleCash,
        interest_eligible_cash: interestEligibleCash,
        interest_income: interestIncome,
      };
    };
    const previousRevenue =
      forecastIndex === 0
        ? metricValue(modelCase, "revenue", 2, 0)
        : results[forecastIndex - 1].standalone_revenue;
    const revenue = metricValue(
      modelCase,
      "revenue",
      periodIndex,
      previousRevenue *
        (1 + forecastAssumption(modelCase, "revenue_growth", forecastIndex, 0)),
    );
    const adjustments = metricValue(
      modelCase,
      "recurring_disclosed_adjustments",
      periodIndex,
      0,
    );
    // THE BROKER ANCHOR RULE, SOLVED THE SAME WAY THE SHEET STATES IT.
    //
    // EBITDA = EBIT + D&A is an identity, so reading all three off the pack
    // over-determines the forecast and leaves a residual no one owns. The rule
    // anchors the better-supplied headline metric, uses D&A as the bridge
    // driver, and derives the other headline from the VISIBLE EBITDA bridge —
    // Adjusted EBITDA less every other term on it —
    // which is why `bridgeAddbacks` (share-based compensation, restructuring
    // addbacks, and whatever else the case bridges through) appears here: it
    // is what separates the rearranged bridge from the bare identity. The
    // independent solver has to derive it exactly as the workbook formula
    // does, or the cache it writes would contradict the formula beneath it.
    const derivedMetric = anchorPlan?.selection?.derived ?? null;
    const bridgeAddbacks = anchorPlan?.addbackTotals?.[forecastIndex] ?? 0;
    const brokerEbitda = () =>
      metricValue(
        modelCase,
        "adjusted_ebitda",
        periodIndex,
        revenue *
          forecastAssumption(
            modelCase,
            "adjusted_ebitda_margin",
            forecastIndex,
            0,
          ),
      );
    const brokerDa = () =>
      metricValue(
        modelCase,
        "depreciation_and_amortisation",
        periodIndex,
        revenue *
          forecastAssumption(modelCase, "da_to_revenue", forecastIndex, 0),
      );
    let ebitda;
    let da;
    let baseEbit;
    if (derivedMetric === "adjusted_ebitda") {
      da = brokerDa();
      baseEbit = metricValue(modelCase, "ebit", periodIndex, 0);
      ebitda = baseEbit + da + bridgeAddbacks;
    } else {
      ebitda = brokerEbitda();
      da = brokerDa();
      baseEbit =
        derivedMetric === "ebit"
          ? ebitda - da - bridgeAddbacks
          : metricValue(
              modelCase,
              "ebit",
              periodIndex,
              ebitda - da - adjustments,
            );
    }
    // These are the values supplied by the operating-metric / broker-anchor
    // layer.  A declared statement formula may legitimately derive one or more
    // of them from a different authority (for example PBT + solved interest ->
    // EBIT, then EBIT + D&A -> EBITDA).  Keep the supplied values available as
    // leaves, but do not force them over a formula-owned semantic role.
    const suppliedEbitda = ebitda;
    const suppliedDa = da;
    const suppliedEbit = baseEbit;
    const previousEbitda = priorStandaloneEbitda;
    const capexRequirement = Math.abs(
      metricValue(
        modelCase,
        "capex",
        periodIndex,
        revenue *
          forecastAssumption(modelCase, "capex_to_revenue", forecastIndex, 0),
      ),
    );
    const workingCapitalFallback = metricValue(
      modelCase,
      "change_in_working_capital",
      periodIndex,
      -(revenue - previousRevenue) *
        forecastAssumption(
          modelCase,
          "working_capital_to_revenue_change",
          forecastIndex,
          0,
        ),
    );
    // The statement hierarchy is the authority whenever it declares the
    // working-capital row. A reported parent resolves to its broker/input;
    // a derived parent resolves through its contributing children. Reading the
    // aggregate metric unconditionally here would overwrite the latter's live
    // workbook formula with an unrelated broker cache on every recalculation.
    const declaredWorkingCapital = declaredStatementPeriod(
      modelCase,
      periodIndex,
      new Map(),
      previousStatementValues,
      acquisitionBaseValues,
    ).resolveRole("change_in_working_capital");
    const changeInWorkingCapital =
      declaredWorkingCapital === null
        ? workingCapitalFallback
        : declaredWorkingCapital;
    const otherNonCash = metricValue(
      modelCase,
      "other_non_cash",
      periodIndex,
      forecastAssumption(modelCase, "other_non_cash", forecastIndex, 0),
    );
    const otherInvesting = metricValue(
      modelCase,
      "other_investing",
      periodIndex,
      forecastAssumption(modelCase, "other_investing", forecastIndex, 0),
    );
    const dividendsAndBuybacks = -Math.abs(
      metricValue(
        modelCase,
        "dividends_and_buybacks",
        periodIndex,
        forecastAssumption(
          modelCase,
          "dividends_and_buybacks",
          forecastIndex,
          0,
        ),
      ),
    );
    // Statement-driven channels. Both are stated inputs, not solved
    // quantities, so they sit outside the circular block — nothing in the
    // interest/cash loop can move them.
    const otherNonOperating = otherNonOperatingIncome(modelCase, periodIndex);
    const statementNonDebtFinancing = visibleNonDebtFinancing(
      modelCase,
      periodIndex,
      previousStatementValues,
      acquisitionBaseValues,
    );
    const taxRate =
      brokerForecastValue(
        modelCase,
        "effective_tax_rate",
        forecastIndex,
      ) ??
      forecastAssumption(
        modelCase,
        "effective_tax_rate",
        forecastIndex,
        0,
      );

    let nonRcfIssuance = 0;
    let nonRcfRepayment = 0;
    let instrumentInterest = 0;
    let nonCashInstrumentInterest = 0;
    let grossDebtReporting = 0;
    let netDebtReporting = 0;
    const instrumentResults = [];

    for (const instrument of nonRcfInstruments) {
      const openingNative = instrumentBalances.get(instrument.instrument_id) ?? 0;
      const issuanceNative = asSeries3(instrument.new_issuance, 0)[forecastIndex];
      const nonCashComponents = nonCashMovementComponents(
        instrument,
        forecastIndex,
      );
      const fairValueNative = Number(nonCashComponents.fair_value ?? 0);
      const otherNonCashNative = Number(nonCashComponents.other ?? 0);
      const nonPikNonCashNative = fairValueNative + otherNonCashNative;
      const amortisationNative =
        Math.min(
          Math.max(0, openingNative + issuanceNative + nonPikNonCashNative),
          asSeries3(instrument.scheduled_amortisation, 0)[forecastIndex],
        );
      const timing = dynamicV2
        ? instrumentTiming(modelCase, periodIndex, instrument, {
            opening: openingNative,
            issuance: issuanceNative,
            fairValue: fairValueNative,
            otherNonCash: otherNonCashNative,
            amortisation: amortisationNative,
          })
        : null;
      const periodEnd = new Date(period.date).getTime();
      const maturity = instrument.maturity_date
        ? new Date(instrument.maturity_date).getTime()
        : Number.POSITIVE_INFINITY;
      const matures = dynamicV2
        ? timing.matures
        : modelCase.controls.debt_maturities_roll === 1 && periodEnd >= maturity;
      const baseEndingBeforePik = Math.max(
        0,
        openingNative + issuanceNative + nonPikNonCashNative - amortisationNative,
      );
      const pikRate = asSeries3(instrument.pik_rate, 0)[forecastIndex];
      const pikInterestNative =
        modelCase.controls.circularity === 1
          ? dynamicV2
            ? solvedPikAccretion(
                timing.weightedBase,
                pikRate,
                timing.activeFraction,
              )
            : matures
              ? Math.max(0, openingNative * Number(pikRate ?? 0) / 2)
              : solvedPikAccretion(
                  (openingNative + baseEndingBeforePik) / 2,
                  pikRate,
                  1,
                )
          : 0;
      const preMaturityEnding = Math.max(
        0,
        baseEndingBeforePik + pikInterestNative,
      );
      const maturityRepaymentNative =
        matures ? preMaturityEnding : 0;
      const endingNative = preMaturityEnding - maturityRepaymentNative;
      const sourcedEndingNative = instrument.forecast_ending_balances?.[forecastIndex];
      if (
        sourcedEndingNative !== undefined &&
        Math.abs(Number(sourcedEndingNative) - endingNative) > tolerance
      ) {
        throw new Error(
          `Instrument ${instrument.instrument_id} sourced ending balance does not reconcile in ${period.date}: ` +
            `declared ${Number(sourcedEndingNative)}, formula roll-forward ${endingNative}.`,
        );
      }
      const balanceCurrency = instrumentBalanceCurrency(modelCase, instrument);
      const averageFx = fxRate(
        modelCase,
        balanceCurrency,
        periodIndex,
        "average",
      );
      const endingFx = fxRate(
        modelCase,
        balanceCurrency,
        periodIndex,
        "period_end",
      );
      // Cash issuance and repayment are period flows and therefore translate
      // at average FX. Closing debt and non-cash balance movements are stock
      // items and remain at period-end FX. The difference is isolated in the
      // explicit FX residual below; it must never leak into financing cash.
      const flowFx = averageFx;
      const issuanceReporting = issuanceNative * flowFx;
      const repaymentReporting =
        (amortisationNative + maturityRepaymentNative) * flowFx;
      const fairValueReporting = fairValueNative * endingFx;
      const otherNonCashReporting = otherNonCashNative * endingFx;
      const pikBalanceMovementReporting = pikInterestNative * endingFx;
      const pikInterestReporting = pikInterestNative * averageFx;
      const endingReporting = endingNative * endingFx;
      const openingReporting =
        openingNative *
        fxRate(
          modelCase,
          balanceCurrency,
          Math.max(0, periodIndex - 1),
          "period_end",
        );
      const rawCashCouponInterestReporting = dynamicV2
        ? (timing.weightedBase +
            pikInterestNative * timing.activeFraction / 2) *
          allInRate(instrument, forecastIndex) *
          averageFx
        : (maturityRepaymentNative > 0
            ? (openingNative *
                (new Date(instrument.maturity_date).getUTCMonth() + 1)) /
              12
            : (openingNative + preMaturityEnding) / 2) *
          allInRate(instrument, forecastIndex) *
          averageFx;
      const cashCouponInterestReporting =
        modelCase.controls.circularity === 1
          ? rawCashCouponInterestReporting
          : 0;
      const rawInterestReporting =
        rawCashCouponInterestReporting + pikInterestReporting;
      const interestReporting =
        cashCouponInterestReporting + pikInterestReporting;

      nonRcfIssuance += issuanceReporting;
      nonRcfRepayment += repaymentReporting;
      instrumentInterest += interestReporting;
      nonCashInstrumentInterest +=
        pikInterestReporting +
        (instrument.cash_interest === false ? cashCouponInterestReporting : 0);
      if (instrument.include_in_gross_debt !== false) {
        grossDebtReporting += endingReporting;
      }
      if (instrument.include_in_net_debt !== false) {
        netDebtReporting += endingReporting;
      }
      instrumentResults.push({
        instrument_id: instrument.instrument_id,
        opening_native: openingNative,
        issuance_native: issuanceNative,
        fair_value_movement_native: fairValueNative,
        other_non_cash_movement_native: otherNonCashNative,
        pik_interest_native: pikInterestNative,
        total_non_cash_movement_native:
          fairValueNative + otherNonCashNative + pikInterestNative,
        amortisation_native: amortisationNative,
        maturity_repayment_native: maturityRepaymentNative,
        ending_native: endingNative,
        sourced_ending_native:
          sourcedEndingNative === undefined ? null : Number(sourcedEndingNative),
        ending_reporting: endingReporting,
        cash_repayment_reporting: repaymentReporting,
        fair_value_movement_reporting: fairValueReporting,
        other_non_cash_movement_reporting: otherNonCashReporting,
        pik_interest_reporting: pikInterestReporting,
        pik_balance_movement_reporting: pikBalanceMovementReporting,
        total_non_cash_movement_reporting:
          fairValueReporting + otherNonCashReporting + pikBalanceMovementReporting,
        fx_non_cash_movement:
          endingReporting -
          openingNative *
            fxRate(
              modelCase,
              balanceCurrency,
              Math.max(0, periodIndex - 1),
              "period_end",
            ) -
          issuanceReporting +
          repaymentReporting -
          fairValueReporting -
          otherNonCashReporting -
          pikBalanceMovementReporting,
        cash_coupon_interest_reporting: cashCouponInterestReporting,
        raw_cash_coupon_interest_reporting: rawCashCouponInterestReporting,
        interest_reporting: interestReporting,
        raw_interest_reporting: rawInterestReporting,
        cash_interest: instrument.cash_interest !== false,
      });
    }
    const instrumentResultById = new Map(
      instrumentResults.map((item) => [item.instrument_id, item]),
    );
    for (const bucket of cashBuckets) {
      if (bucket.forecast_treatment !== "linked_debt_addback") continue;
      fixedEndingBucketBalances.set(
        bucket.bucket_id,
        bucket.linked_instrument_ids.reduce(
          (sum, instrumentId) =>
            sum + Number(instrumentResultById.get(instrumentId)?.ending_reporting ?? 0),
          0,
        ),
      );
    }

    const leasePeriod = leaseProjection[forecastIndex];
    const leasePrincipal = leasePeriod.principal_repayment;
    const leaseAdditions = leasePeriod.additions;
    const endingLease = leasePeriod.ending_total;
    const rawLeaseInterest = leasePeriod.interest;

    const isV2 = dynamicV2;
    const acquisitionActive =
      modelCase.acquisition?.enabled && closeIndex >= 0 && forecastIndex >= closeIndex;
    const acquisitionCloses = acquisitionActive && forecastIndex === closeIndex;
    const closeMonth = Number(modelCase.acquisition?.close_month ?? 1);
    const closeYear = Number(modelCase.acquisition?.close_year);
    const closeDate = new Date(Date.UTC(closeYear, closeMonth - 1, 1));
    const closeYearFraction = acquisitionCloses
      ? isV2
        ? outstandingFraction(modelCase, periodIndex, closeDate, new Date(period.date))
        : (13 - closeMonth) / 12
      : acquisitionActive
        ? 1
        : 0;
    const acquisitionTiming = acquisitionCloses
      ? closeYearFraction
      : acquisitionActive
        ? 1
        : 0;
    const acquisitionInterestTiming = acquisitionCloses
      ? closeYearFraction
      : acquisitionActive
        ? 1
        : 0;
    const transactionEnterpriseValue = isV2
      ? Number(modelCase.acquisition?.transaction_enterprise_value ?? 0)
      : acquisitionDebtAmount;
    const baseTargetEbitda = acquisitionActive
      ? transactionEnterpriseValue /
        Number(modelCase.acquisition.entry_ev_to_ebitda)
      : 0;
    // EVERY TARGET OPERATING DRIVER RESOLVES THE SAME WAY THE CELLS DO.
    //
    // The standalone case's own ratio first — the target takes the parent's
    // growth, the parent's margin, the parent's capital intensity, which is
    // what removing those six controls from the acquisition block was for — and
    // the case's declared `target_*` only where the standalone quantity does
    // not exist to derive from. This mirrors `acquisitionDerivedDrivers` in the
    // emitter arm for arm; if the two ladders ever part, the cell says one
    // number and its cache says another.
    if (
      acquisitionActive &&
      forecastIndex > closeIndex &&
      Math.abs(previousEbitda) <= ACQUISITION_NEAR_ZERO
    ) {
      throw new Error(
        `Acquisition target growth cannot be inferred in ${period.date}: prior standalone EBITDA is zero or unavailable.`,
      );
    }
    const standaloneEbitdaGrowth =
      Math.abs(previousEbitda) <= ACQUISITION_NEAR_ZERO
        ? 0
        : ebitda / previousEbitda - 1;
    const targetEbitdaGrowth = isV2 ? standaloneEbitdaGrowth : 0;
    // Entry EBITDA is the close-period base.  Thereafter the target compounds
    // each successive standalone EBITDA growth rate exactly once.  This is the
    // numeric twin of acquisitionFullEbitdaFormula; it intentionally avoids
    // the old `current growth ^ elapsed years` shortcut, which drifted whenever
    // the forecast growth rates differed by year.
    const targetEbitda = !acquisitionActive
      ? 0
      : acquisitionCloses
        ? baseTargetEbitda
        : Number(priorTargetEbitda ?? baseTargetEbitda) *
          (1 + targetEbitdaGrowth);
    if (acquisitionActive && Math.abs(revenue) <= ACQUISITION_NEAR_ZERO) {
      throw new Error(
        `Acquisition target ratios cannot be inferred in ${period.date}: standalone revenue is zero or unavailable.`,
      );
    }
    const targetMargin =
      Math.abs(revenue) <= ACQUISITION_NEAR_ZERO ? 0 : ebitda / revenue;
    // A margin of floating-point noise is not a denominator; guarded here
    // exactly as the revenue cell guards it, so neither can produce 1e19.
    const targetRevenue =
      targetMargin > ACQUISITION_NEAR_ZERO ? targetEbitda / targetMargin : 0;
    const targetDa =
      Math.abs(revenue) <= ACQUISITION_NEAR_ZERO
        ? 0
        : targetRevenue * (da / revenue);
    const targetAdjustments = isV2
      ? 0
      : revenue === 0
        ? 0
        : targetRevenue * (adjustments / revenue);
    const targetEbit = targetEbitda - targetDa - targetAdjustments;
    const targetCapex =
      Math.abs(revenue) <= ACQUISITION_NEAR_ZERO
        ? 0
        : targetRevenue * (capexRequirement / revenue);
    const targetWorkingCapital = isV2
      ? targetRevenue *
        (revenue === 0 ? 0 : changeInWorkingCapital / revenue)
      : -targetRevenue *
        (revenue === 0
          ? 0
          : Math.abs(changeInWorkingCapital / revenue));
    const acquisitionDebtAddition = acquisitionCloses ? acquisitionDebtAmount : 0;
    const acquisitionDebtProceeds = 0;
    // The lightweight overlay intentionally has no sources-and-uses,
    // consideration cash or implied equity leg. EV only infers target EBITDA.
    const acquisitionCashConsideration = 0;
    const acquisitionPreMaturityDebt = Math.max(
      0,
      openingAcquisitionDebt + acquisitionDebtAddition,
    );
    const endingAcquisitionDebt = acquisitionActive
      ? acquisitionPreMaturityDebt
      : 0;
    // Existing acquisition debt earns a full period; only the new close-year
    // draw is prorated. Averaging a zero opening with the closing draw and then
    // multiplying by the close-year fraction double-prorates the first year.
    const rawAcquisitionInterest =
      (openingAcquisitionDebt +
        acquisitionDebtAddition * acquisitionInterestTiming) *
      Number(modelCase.acquisition?.incremental_rate ?? 0);
    // Acquisition debt is a fixed drawing at a stated rate, but it is still
    // forecast interest expense, so the breaker zeroes it — matching the gate
    // on the pro-forma acquisition interest formula.
    const acquisitionInterest =
      modelCase.controls.circularity === 1 ? rawAcquisitionInterest : 0;

    const rcfCapacity = Number(
      modelCase.rcf_policy?.capacity ??
        rcfInstrument?.facility_capacity ??
        0,
    );
    const rcfRate = rcfInstrument
      ? allInRate(rcfInstrument, forecastIndex)
      : 0;
    const rcfOpeningFx = foreignRcf
      ? fxRate(modelCase, rcfInstrument.currency, periodIndex - 1, "period_end")
      : 1;
    const rcfAverageFx = foreignRcf
      ? fxRate(modelCase, rcfInstrument.currency, periodIndex, "average")
      : 1;
    const rcfEndingFx = foreignRcf
      ? fxRate(modelCase, rcfInstrument.currency, periodIndex, "period_end")
      : 1;
    const effectiveMinimumCash = minimumCash(modelCase);
    const rawOtherInterest = asSeries3(modelCase.other_interest, 0)[forecastIndex];
    const rawNonCashInterest = asSeries3(
      modelCase.non_cash_interest,
      0,
    )[forecastIndex];

    let endingCash = openingCash;
    let endingRcf = openingRcf;
    let endingRcfNative = openingRcfNative;
    let converged = false;
    let iteration = 0;
    let residual = Number.POSITIVE_INFINITY;
    let lastComputation = null;

    for (iteration = 1; iteration <= maxIterations; iteration += 1) {
      // The circularity switch is a KILL SWITCH. `0` suppresses every forecast
      // interest-expense and interest-income line — instrument, RCF, the
      // commitment fee, lease, acquisition, other/unallocated and non-cash —
      // so net interest is zero. Gating only the tightest leg of the loop
      // would leave the model computing interest while reporting that the
      // breaker is on. Raw assumptions are untouched in both states.
      const interestEnabled = modelCase.controls.circularity === 1;
      const leaseInterest = interestEnabled ? rawLeaseInterest : 0;
      const otherInterest = interestEnabled ? rawOtherInterest : 0;
      const nonCashInterest = interestEnabled ? rawNonCashInterest : 0;
      const rcfInterest = interestEnabled
        ? foreignRcf
          ? ((openingRcfNative + endingRcfNative) / 2) *
            rcfRate *
            rcfAverageFx
          : ((openingRcf + endingRcf) / 2) * rcfRate
        : 0;
      const averageUndrawnRcf = foreignRcf
        ? Math.max(
            0,
            rcfCapacity - (openingRcfNative + endingRcfNative) / 2,
          ) * rcfAverageFx
        : Math.max(0, rcfCapacity - (openingRcf + endingRcf) / 2);
      const commitmentFeeRate =
        modelCase.rcf_policy?.commitment_fee_convention === "bps_on_undrawn"
          ? Number(modelCase.rcf_policy.commitment_fee_value ?? 0) / 10000
          : 0;
      const commitmentFee = interestEnabled
        ? averageUndrawnRcf * commitmentFeeRate
        : 0;
      const interestIncome = interestEnabled
        ? cashBucketSnapshot(endingCash).interest_income
        : 0;
      const grossInterest = interestEnabled
        ? instrumentInterest +
          rcfInterest +
          commitmentFee +
          leaseInterest +
          acquisitionInterest +
          otherInterest +
          nonCashInterest
        : 0;
      const netInterest = grossInterest - interestIncome;
      const standaloneGrossInterest = Math.max(
        0,
        grossInterest - acquisitionInterest,
      );

      // Resolve the operating statement from whichever forecast authorities
      // this issuer actually supplies.  Supplied roles remain leaves; roles
      // with a declared formula are deliberately left to the graph.  This is
      // what permits a PBT-led issuer to derive EBIT backwards through solved
      // interest, and then derive EBITDA through D&A, without inventing an
      // EBITDA hardcode or a company-specific branch.
      const operatingOverrides = new Map([
        ["revenue", revenue],
        ["interest_income", interestIncome],
        ["interest_expense", -standaloneGrossInterest],
        ["recurring_disclosed_adjustments", adjustments],
      ]);
      for (const [role, supplied] of [
        ["adjusted_ebitda", suppliedEbitda],
        ["depreciation_and_amortisation", suppliedDa],
        ["ebit", suppliedEbit],
      ]) {
        if (!statementRoleIsCalculated(modelCase, role, forecastIndex)) {
          operatingOverrides.set(role, supplied);
        }
      }
      const operatingGraph = declaredStatementPeriod(
        modelCase,
        periodIndex,
        operatingOverrides,
        previousStatementValues,
        acquisitionBaseValues,
      );
      baseEbit = Number(
        operatingGraph.resolveRole("ebit") ?? suppliedEbit,
      );
      da = Number(
        operatingGraph.resolveRole("depreciation_and_amortisation") ??
          suppliedDa,
      );
      ebitda = Number(
        operatingGraph.resolveRole("adjusted_ebitda") ?? suppliedEbitda,
      );

      const totalEbit = baseEbit + targetEbit * acquisitionTiming;
      const totalDa = da + targetDa * acquisitionTiming;
      const totalWorkingCapital =
        changeInWorkingCapital + targetWorkingCapital * acquisitionTiming;
      const totalCapex =
        -capexRequirement - targetCapex * acquisitionTiming;
      const declaredStandalonePreTax =
        operatingGraph.resolveRole("pre_tax_income");
      const standalonePreTaxIncome =
        declaredStandalonePreTax === null
          ? baseEbit - (standaloneGrossInterest - interestIncome) +
            otherNonOperating
          : declaredStandalonePreTax;
      const targetPreTaxIncome = Math.max(
        0,
        targetEbit * acquisitionTiming - acquisitionInterest,
      );
      const preTaxIncome = standalonePreTaxIncome + targetPreTaxIncome;
      // Tax and net income belong to the issuer's declared statement graph too.
      // Most cases derive them from PBT and an effective rate, but a legitimate
      // issuer/broker workflow may instead supply net income and tax expense,
      // then derive PBT backwards.  Preserve whichever rows are authorities in
      // that graph instead of silently restoring a global PBT-led hierarchy.
      const declaredStandaloneTaxExpense =
        operatingGraph.resolveRole("tax_expense");
      const standaloneTaxCharge =
        declaredStandaloneTaxExpense === null
          ? Math.max(0, standalonePreTaxIncome) * taxRate
          : -Number(declaredStandaloneTaxExpense);
      const declaredStandaloneNetIncome =
        operatingGraph.resolveRole("net_income");
      const standaloneNetIncome =
        declaredStandaloneNetIncome === null
          ? standalonePreTaxIncome - standaloneTaxCharge
          : Number(declaredStandaloneNetIncome);
      // The acquisition target remains taxed at the standalone effective rate,
      // which is what the adjustment-column tax formula states.
      const targetTaxRate = taxRate;
      const targetTaxCharge = targetPreTaxIncome * targetTaxRate;
      const taxCharge = standaloneTaxCharge + targetTaxCharge;
      const netIncome =
        standaloneNetIncome + targetPreTaxIncome - targetTaxCharge;
      const interestIncomeInInvesting =
        modelCase.cash_policy.interest_income_cash_flow_classification ===
        "investing";
      const fallbackCashFromOperations =
        netIncome +
        totalDa +
        otherNonCash +
        // Forecast interest is absent from net income when the breaker is off,
        // so there is nothing to add back in that state.
        (interestEnabled
          ? nonCashInterest + nonCashInstrumentInterest
          : 0) +
        totalWorkingCapital -
        (interestIncomeInInvesting ? interestIncome : 0);
      const fallbackCashFromInvesting =
        totalCapex +
        otherInvesting -
        acquisitionCashConsideration +
        (interestIncomeInInvesting ? interestIncome : 0);
      const statementOverrides = new Map([
        ["revenue", revenue + targetRevenue * acquisitionTiming],
        ["adjusted_ebitda", ebitda + targetEbitda * acquisitionTiming],
        ["depreciation_and_amortisation", totalDa],
        ["ebit", totalEbit],
        ["interest_income", interestIncome],
        ["interest_expense", -grossInterest],
        ["pre_tax_income", preTaxIncome],
        ["effective_tax_rate", preTaxIncome > 0 ? taxCharge / preTaxIncome : 0],
        ["tax_expense", -taxCharge],
        ["net_income", netIncome],
        ["recurring_disclosed_adjustments", adjustments],
        ["cash_flow_da", totalDa],
        [
          "non_cash_interest_addback",
          interestEnabled
            ? nonCashInterest + nonCashInstrumentInterest
            : 0,
        ],
        ["other_non_cash", otherNonCash],
        ["change_in_working_capital", totalWorkingCapital],
        ["capex", totalCapex],
        ["other_investing", otherInvesting],
        ["non_balancing_cash_bucket_movement", nonBalancingCashBucketMovement],
        ["acquisition_consideration", 0],
      ]);
      if (
        statementRoleIsCalculated(
          modelCase,
          "cash_interest_paid",
          forecastIndex,
        )
      ) {
        statementOverrides.set(
          "cash_interest_paid",
          -(grossInterest - nonCashInterest - nonCashInstrumentInterest),
        );
      }
      if (
        statementRoleIsCalculated(
          modelCase,
          "cash_interest_received",
          forecastIndex,
        )
      ) {
        statementOverrides.set("cash_interest_received", interestIncome);
      }
      const cashFlowGraph = declaredStatementPeriod(
        modelCase,
        periodIndex,
        statementOverrides,
        previousStatementValues,
        acquisitionBaseValues,
      );
      const declaredCashFromOperations =
        cashFlowGraph.resolveRole("cash_from_operations");
      const declaredCashFromInvesting =
        cashFlowGraph.resolveRole("cash_from_investing");
      const cashFromOperations =
        declaredCashFromOperations ?? fallbackCashFromOperations;
      const cashFromInvesting =
        declaredCashFromInvesting ?? fallbackCashFromInvesting;
      const fxOnCash = statementRoleValue(
        modelCase,
        "fx_effect_on_cash",
        periodIndex,
        forecastAssumption(
          modelCase,
          "fx_effect_on_cash",
          forecastIndex,
          0,
        ),
      );
      const nonDebtFinancing =
        statementNonDebtFinancing ?? dividendsAndBuybacks;
      const nonRcfDebtIssuance = nonRcfIssuance;
      const nonRcfDebtRepayment = nonRcfRepayment;
      const cashBeforeDebt =
        openingCash +
        cashFromOperations +
        cashFromInvesting +
        fxOnCash +
        nonDebtFinancing;
      const financingBeforeMandatory =
        nonDebtFinancing + nonRcfDebtIssuance;
      const cashBeforeMandatory =
        cashBeforeDebt + nonRcfDebtIssuance;
      const mandatoryRepayment =
        nonRcfDebtRepayment + leasePrincipal;
      const cashAfterMandatory = cashBeforeMandatory - mandatoryRepayment;
      const preRcfDebtCashFlow =
        nonRcfDebtIssuance - nonRcfDebtRepayment - leasePrincipal;
      const cashBeforeRcf = cashBeforeDebt + preRcfDebtCashFlow;
      const deficit = Math.max(0, effectiveMinimumCash - cashAfterMandatory);
      const surplus = Math.max(0, cashAfterMandatory - effectiveMinimumCash);
      const availableCapacityNative = Math.max(
        0,
        rcfCapacity - openingRcfNative,
      );
      const rcfDrawNative = foreignRcf
        ? Math.min(deficit / rcfAverageFx, availableCapacityNative)
        : Math.min(deficit, availableCapacityNative);
      const rcfDraw = foreignRcf
        ? rcfDrawNative * rcfAverageFx
        : rcfDrawNative;
      const rcfRepaymentNative =
        rcfDraw > tolerance
          ? 0
          : foreignRcf
            ? Math.min(surplus / rcfAverageFx, openingRcfNative)
            : Math.min(surplus, openingRcfNative);
      const rcfRepayment = foreignRcf
        ? rcfRepaymentNative * rcfAverageFx
        : rcfRepaymentNative;
      const nextEndingRcfNative =
        openingRcfNative + rcfDrawNative - rcfRepaymentNative;
      const nextEndingRcf = foreignRcf
        ? nextEndingRcfNative * rcfEndingFx
        : nextEndingRcfNative;
      const rcfFxNonCashMovement =
        nextEndingRcf - openingRcf - rcfDraw + rcfRepayment;
      const nextEndingCash = cashAfterMandatory + rcfDraw - rcfRepayment;
      const nextCashBucketSnapshot = cashBucketSnapshot(nextEndingCash);
      const liquidityShortfall = Math.max(
        0,
        effectiveMinimumCash - nextEndingCash,
      );
      residual = Math.max(
        Math.abs(nextEndingCash - endingCash),
        Math.abs(nextEndingRcf - endingRcf),
      );

      // Finish the declared statement graph with the quantities that only
      // become known after the liquidity solve. This is the complete economic
      // state for the period and becomes the prior-period graph on the next
      // forecast pass.
      const finalStatementOverrides = new Map(statementOverrides);
      for (const [role, value] of [
        ["cash_from_operations", cashFromOperations],
        ["cash_from_investing", cashFromInvesting],
        ["dividends", -Math.abs(statementRoleValue(modelCase, "dividends", periodIndex, 0))],
        ["share_buybacks", -Math.abs(statementRoleValue(modelCase, "share_buybacks", periodIndex, 0))],
        ["lease_principal", -leasePrincipal],
        ["debt_issuance", nonRcfDebtIssuance],
        ["debt_repayment", -nonRcfDebtRepayment],
        ["change_in_debt", nonRcfDebtIssuance - nonRcfDebtRepayment + rcfDraw - rcfRepayment],
        ["rcf_draw", rcfDraw],
        ["rcf_repayment", -rcfRepayment],
        ["acquisition_debt_proceeds", 0],
        ["acquisition_debt_repayment", 0],
        ["fx_effect_on_cash", fxOnCash],
        [
          "opening_cash",
          cashBuckets.reduce(
            (sum, bucket) =>
              sum +
              (bucket.included_in_cash_flow_cash !== false
                ? Number(openingBucketBalances.get(bucket.bucket_id) ?? 0)
                : 0),
            0,
          ),
        ],
        ["ending_cash", nextCashBucketSnapshot.cash_flow_cash],
      ]) {
        finalStatementOverrides.set(role, value);
      }
      const finalStatementGraph = declaredStatementPeriod(
        modelCase,
        periodIndex,
        finalStatementOverrides,
        previousStatementValues,
        acquisitionBaseValues,
      );
      const finalStatementValues = finalStatementGraph.resolveAll();

      lastComputation = {
        standalone_revenue: revenue,
        revenue: revenue + targetRevenue * acquisitionTiming,
        adjusted_ebitda: ebitda + targetEbitda * acquisitionTiming,
        depreciation_and_amortisation: totalDa,
        ebit: totalEbit,
        gross_interest: grossInterest,
        instrument_interest: instrumentInterest,
        non_cash_instrument_interest: nonCashInstrumentInterest,
        rcf_interest: rcfInterest,
        rcf_commitment_fee: commitmentFee,
        lease_interest: leaseInterest,
        acquisition_interest: acquisitionInterest,
        other_interest: otherInterest,
        non_cash_interest: nonCashInterest,
        interest_income: interestIncome,
        net_interest: netInterest,
        other_non_operating: otherNonOperating,
        pre_tax_income: preTaxIncome,
        tax: taxCharge,
        net_income: netIncome,
        change_in_working_capital:
          totalWorkingCapital,
        capex: totalCapex,
        cash_from_operations: cashFromOperations,
        cash_from_investing: cashFromInvesting,
        fx_on_cash: fxOnCash,
        fx_effect_on_cash: fxOnCash,
        non_debt_financing: nonDebtFinancing,
        non_rcf_issuance: nonRcfIssuance,
        non_rcf_repayment: nonRcfRepayment,
        non_rcf_debt_issuance: nonRcfDebtIssuance,
        non_rcf_debt_repayment: nonRcfDebtRepayment,
        cash_before_debt: cashBeforeDebt,
        pre_rcf_debt_cash_flow: preRcfDebtCashFlow,
        cash_before_rcf: cashBeforeRcf,
        financing_before_mandatory: financingBeforeMandatory,
        cash_before_mandatory_repayment: cashBeforeMandatory,
        mandatory_repayment: mandatoryRepayment,
        cash_after_mandatory_repayment: cashAfterMandatory,
        minimum_cash: effectiveMinimumCash,
        rcf_draw: rcfDraw,
        rcf_repayment: rcfRepayment,
        ending_rcf: nextEndingRcf,
        rcf_currency: rcfInstrument.currency,
        rcf_opening_native: openingRcfNative,
        rcf_capacity_native: rcfCapacity,
        rcf_draw_native: rcfDrawNative,
        rcf_repayment_native: rcfRepaymentNative,
        rcf_ending_native: nextEndingRcfNative,
        rcf_opening_fx: rcfOpeningFx,
        rcf_average_fx: rcfAverageFx,
        rcf_ending_fx: rcfEndingFx,
        rcf_fx_non_cash_movement: rcfFxNonCashMovement,
        ending_cash: nextEndingCash,
        ...(Array.isArray(modelCase.cash_policy?.buckets)
          ? {
              reported_cash: nextCashBucketSnapshot.reported_cash,
              liquidity_cash: nextCashBucketSnapshot.liquidity_cash,
              interest_eligible_cash:
                nextCashBucketSnapshot.interest_eligible_cash,
              cash_bucket_balances: nextCashBucketSnapshot.detail,
            }
          : {}),
        liquidity_shortfall: liquidityShortfall,
        lease_principal: leasePrincipal,
        lease_additions: leaseAdditions,
        ending_lease: endingLease,
        lease_interest_basis: leasePeriod.interest_basis,
        opening_interest_bearing_lease:
          leasePeriod.opening_interest_bearing,
        ending_interest_bearing_lease:
          leasePeriod.ending_interest_bearing,
        acquisition_debt: endingAcquisitionDebt,
        acquisition_debt_addition: acquisitionDebtAddition,
        acquisition_cash_consideration: acquisitionCashConsideration,
        acquisition_debt_proceeds: acquisitionDebtProceeds,
        acquisition_debt_repayment: 0,
        instrument_results: instrumentResults,
        statement_values: Object.fromEntries(finalStatementValues),
      };

      if (
        residual <= tolerance
      ) {
        endingCash = nextEndingCash;
        endingRcf = nextEndingRcf;
        endingRcfNative = nextEndingRcfNative;
        converged = true;
        break;
      }
      endingCash = nextEndingCash;
      endingRcf = nextEndingRcf;
      endingRcfNative = nextEndingRcfNative;
    }

    if (!converged) {
      throw new Error(
        `Case ${modelCase.case_id} did not converge in forecast period ${period.date}.`,
      );
    }

    const leaseIncludedInGrossDebt =
      modelCase.lease_policy.include_in_gross_debt &&
      modelCase.lease_policy.mode !== "exclude";
    const leaseIncludedInLeverage =
      modelCase.lease_policy.include_in_leverage &&
      modelCase.lease_policy.mode !== "exclude";
    const leaseIncludedInNetDebt =
      modelCase.lease_policy.include_in_net_debt &&
      modelCase.lease_policy.mode !== "exclude";
    const grossDebt =
      grossDebtReporting +
      endingRcf +
      endingAcquisitionDebt +
      (leaseIncludedInGrossDebt ? endingLease : 0);
    const debtForNetDebt =
      netDebtReporting +
      endingRcf +
      endingAcquisitionDebt +
      (leaseIncludedInNetDebt ? endingLease : 0);
    const debtForLeverage =
      netDebtReporting +
      endingRcf +
      endingAcquisitionDebt +
      (leaseIncludedInLeverage ? endingLease : 0);
    const finalCashBucketSnapshot = cashBucketSnapshot(endingCash);
    const eligibleCash = finalCashBucketSnapshot.net_debt_eligible_cash;
    const netDebt = debtForNetDebt - eligibleCash;
    const leverageNetDebt = debtForLeverage - eligibleCash;
    const undrawnRcf = foreignRcf
      ? Math.max(0, rcfCapacity - endingRcfNative) * rcfEndingFx
      : Math.max(0, rcfCapacity - endingRcf);
    // Liquidity is undrawn commitment LESS drawn commercial paper plus cash:
    // outstanding CP is funded out of the same backstop, so counting the full
    // undrawn RCF while paper is outstanding double-counts the capacity.
    const commercialPaperIds = new Set(
      (modelCase.instruments ?? [])
        .filter((instrument) => instrument.class === "commercial_paper")
        .map((instrument) => instrument.instrument_id),
    );
    const drawnCommercialPaper = (lastComputation.instrument_results ?? [])
      .filter((item) => commercialPaperIds.has(item.instrument_id))
      .reduce((total, item) => total + Number(item.ending_reporting ?? 0), 0);

    const result = {
      period: period.date,
      ...lastComputation,
      gross_debt: grossDebt,
      ...(Array.isArray(modelCase.cash_policy?.buckets)
        ? {
            reported_cash: finalCashBucketSnapshot.reported_cash,
            cash_flow_cash: finalCashBucketSnapshot.cash_flow_cash,
            liquidity_cash: finalCashBucketSnapshot.liquidity_cash,
            interest_eligible_cash:
              finalCashBucketSnapshot.interest_eligible_cash,
            cash_bucket_balances: finalCashBucketSnapshot.detail,
          }
        : {}),
      eligible_cash: eligibleCash,
      net_debt: netDebt,
      net_leverage:
        lastComputation.adjusted_ebitda === 0
          ? null
          : leverageNetDebt / lastComputation.adjusted_ebitda,
      undrawn_rcf: undrawnRcf,
      drawn_commercial_paper: drawnCommercialPaper,
      total_liquidity:
        finalCashBucketSnapshot.liquidity_cash +
        undrawnRcf -
        drawnCommercialPaper,
      iterations: iteration,
      converged,
      residual,
      checks: {
        rcf_within_bounds:
          endingRcfNative >= -tolerance &&
          endingRcfNative <= rcfCapacity + tolerance,
        minimum_cash_or_shortfall:
          endingCash + lastComputation.liquidity_shortfall >=
          effectiveMinimumCash - tolerance,
        liquidity_shortfall_visible:
          Math.abs(
            lastComputation.liquidity_shortfall -
              Math.max(0, effectiveMinimumCash - endingCash),
          ) <= tolerance,
        rcf_draw_repayment_mutually_exclusive:
          !(
            lastComputation.rcf_draw > tolerance &&
            lastComputation.rcf_repayment > tolerance
          ),
        shortfall_only_when_capacity_exhausted:
          lastComputation.liquidity_shortfall <= tolerance ||
          undrawnRcf <= tolerance,
        debt_roll_forward: instrumentResults.every(
          (item) =>
            Math.abs(
              item.ending_native -
                (item.opening_native +
                  item.issuance_native +
                  item.fair_value_movement_native +
                  item.other_non_cash_movement_native +
                  item.pik_interest_native -
                  item.amortisation_native -
                  item.maturity_repayment_native),
            ) <= tolerance,
        ),
      },
    };

    results.push(result);
    priorStandaloneEbitda = Number(lastComputation.adjusted_ebitda ?? 0) -
      targetEbitda * acquisitionTiming;

    previousStatementValues = new Map(
      Object.entries(lastComputation.statement_values ?? {}),
    );

    for (const item of instrumentResults) {
      instrumentBalances.set(item.instrument_id, item.ending_native);
    }
    cashBucketBalances = finalCashBucketSnapshot.balances;
    openingCash = result.ending_cash;
    openingRcf = result.ending_rcf;
    openingRcfNative = result.rcf_ending_native;
    openingLease = endingLease;
    openingAcquisitionDebt = endingAcquisitionDebt;
    if (acquisitionActive) priorTargetEbitda = targetEbitda;
  }

  return {
    case_id: modelCase.case_id,
    issuer: modelCase.issuer,
    periods: modelCase.periods,
    forecast: results,
    converged: results.length === 3 && results.every((result) => result.converged === true),
    iterations: Math.max(0, ...results.map((result) => Number(result.iterations ?? 0))),
    residual: Math.max(0, ...results.map((result) => Number(result.residual ?? Number.POSITIVE_INFINITY))),
    convergence_tolerance: tolerance,
    all_checks_pass: results.every((result) =>
      Object.values(result.checks).every(Boolean),
    ),
  };
}
import fs from "node:fs";
import { validateJsonSchema } from "./json_schema.mjs";
import {
  requireResolvedAnchorPlan,
  resolveBrokerForecastSelection,
} from "./broker_anchor.mjs";

const modelCaseSchema = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/model-case.schema.json", import.meta.url),
    "utf8",
  ),
);
const modelCaseV2Schema = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/model-case-v2.schema.json", import.meta.url),
    "utf8",
  ),
);
