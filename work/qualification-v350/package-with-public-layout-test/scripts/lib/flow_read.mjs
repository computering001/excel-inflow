// Stage 5 — the plain-English read, and the report behind it.
//
// Every validator in this skill checks INTERNAL CONSISTENCY. None of them checks
// whether the output is PLAUSIBLE. A model can tie to the last decimal and still
// say something absurd, and the only thing that catches that today is a human
// reading the output. This module is that reading, written down.
//
// The read is generated from the solved values. It is deliberately not a prose
// template with numbers substituted in: the sentence structure itself is chosen
// by what the numbers do — a net-cash company gets a different sentence from a
// levered one, a company whose leverage rises gets a different verb, a facility
// that is drawn gets named. A template would keep saying "leverage falls" after
// the case changed, which is the exact failure the read exists to catch.
//
// It is non-blocking. It reports and does not wait, so a batch of ten does not
// stall overnight.

import { leaseOpeningLiability } from "./solver.mjs";
import { formatMoney, formatTurns } from "./flow_screens.mjs";
import { resolveBrokerForecastSelection } from "./broker_anchor.mjs";
import { resolveForecastAuthority } from "./forecast_authority.mjs";
import { resolveHistoricalInterestAuthority } from "./historical_interest_authority.mjs";

function pct(value, { decimals = 0 } = {}) {
  return `${(Number(value) * 100).toFixed(decimals)}%`;
}

function isRealDebt(instrument) {
  return instrument.class !== "rcf" && instrument.class !== "lease";
}

// The last historical period end. Column I of the workbook, index 2 of every
// six-period series, and the period the forecast opens from.
const LAST_ACTUAL = 2;

/**
 * THE RATE A NATIVE BALANCE IS TRANSLATED AT FOR THE LAST ACTUAL COLUMN.
 *
 * The read used to add native USD, EUR and GBP opening balances together and
 * divide the total by EBITDA. The sum of three currencies is not a currency, so
 * the opening leverage the analyst was shown disagreed with the opening
 * leverage on the face of the model by 528 of net debt on Smurfit, 904 on
 * AstraZeneca and 463 on the maximal case — the same three figures
 * `coverage.mjs` names in its own note on this defect, which it fixed for the
 * reconciliation gate and not here.
 *
 * The rate is the LAST HISTORICAL PERIOD-END rate — index 2 of
 * `period_end_rates` — because the balance being translated is a balance at
 * that date. It is the rate `solver.mjs` opens the forecast roll-forward on
 * (`fxRate(currency, 2, "period_end")`), the rate `coverage.mjs` reconciles the
 * instrument register at, and the cell `build_dynamic_model.mjs` points column
 * I at (`=$D{row} * {FX row}`). None of the three exports it, so the rule is
 * stated here once and identically rather than reached for through a module
 * this change does not own; the shape mirrors solver.mjs's `fxRate`, including
 * the throw, so a case that cannot be translated fails the same way in both.
 */
function openingFxRate(modelCase, currency) {
  if (!currency || currency === modelCase.issuer?.reporting_currency) return 1;
  const pair = modelCase.fx?.[currency];
  if (!pair) throw new Error(`Missing FX assumptions for ${currency}.`);
  const raw = Number(pair.period_end_rates?.[LAST_ACTUAL]);
  if (!(raw > 0)) {
    throw new Error(`Invalid period_end FX rate for ${currency}.`);
  }
  return pair.quote === "reporting_per_native" ? raw : 1 / raw;
}

// The operators that can carry a MONETARY subtotal. A statement row folded up
// by any other rule — a ratio, a growth rate, a period reference — is not an
// amount and is refused rather than guessed at, exactly as plan_values.mjs
// refuses a formula outside its closed vocabulary. Sourced from the operator
// table `build_dynamic_model.mjs` writes the historical columns from, which is
// what makes the two the same definition.
const MONETARY_AGGREGATES = new Set([
  "sum",
  "link",
  "subtract",
  "negate",
  "negate_sum",
]);

/**
 * A historical figure on the basis the WORKBOOK states it.
 *
 * The solver resolves a value through `statement_structure` first and the
 * `operating_metrics` series only after that. For Adjusted EBITDA the statement
 * row wins and carries no stated values of its own: it is a CALCULATION over
 * the bridge — operating profit, the non-trading addback, D&A and whatever else
 * the case bridges through — and column I of the workbook prints that sum. The
 * read used to skip the whole ladder and take `operating_metrics.values[2]`
 * directly, which is a number the historical columns never show and nothing in
 * the emitted model reads.
 *
 * So the row is resolved the way it is emitted: a stated value where the row
 * has one, otherwise its calculation walked over its refs. `visiting` stops a
 * malformed structure recursing without end. A row the walk cannot value
 * returns null and the caller falls back to the metric series — the solver's
 * own last rung, kept so that a case with no statement structure at all reads
 * exactly as it did.
 */
function statementHistoricalValue(modelCase, semanticRole, periodIndex) {
  const rowsById = new Map();
  let target = null;
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (!rowsById.has(row.row_id)) rowsById.set(row.row_id, row);
      if (target === null && row.semantic_role === semanticRole) target = row;
    }
  }
  if (target === null) return null;
  const visiting = new Set();
  const walk = (row) => {
    if (!row) return null;
    const stated = row.values?.[periodIndex];
    if (stated !== null && stated !== undefined) return Number(stated);
    const rule = row.calculation;
    if (!rule || !MONETARY_AGGREGATES.has(rule.operator)) return null;
    if (visiting.has(row.row_id)) return null;
    visiting.add(row.row_id);
    const parts = [];
    for (const ref of rule.refs ?? []) {
      const value = walk(rowsById.get(ref));
      if (value === null) {
        visiting.delete(row.row_id);
        return null;
      }
      parts.push(value);
    }
    visiting.delete(row.row_id);
    if (rule.operator === "sum") {
      return parts.reduce((total, part) => total + part, 0);
    }
    if (rule.operator === "link") return parts[0] ?? 0;
    if (rule.operator === "subtract") {
      return parts.slice(1).reduce((total, part) => total - part, parts[0] ?? 0);
    }
    if (rule.operator === "negate") return -(parts[0] ?? 0);
    return -parts.reduce((total, part) => total + part, 0);
  };
  return walk(target);
}

/**
 * Historical Adjusted EBITDA, on the workbook's basis, oldest year first.
 *
 * One function for both readers — the opening position and the growth
 * comparison in `plausibilityChecks` — so the leverage the read states and the
 * history it is compared against can never come off different bases.
 */
function historicalAdjustedEbitda(modelCase, periodIndex) {
  const fromStatement = statementHistoricalValue(
    modelCase,
    "adjusted_ebitda",
    periodIndex,
  );
  if (fromStatement !== null) return fromStatement;
  const metric = modelCase.operating_metrics?.adjusted_ebitda?.values?.[
    periodIndex
  ];
  return metric === null || metric === undefined ? 0 : Number(metric);
}

// The opening position, on exactly the basis the workbook's last actual column
// states it, so the first number in the read is comparable with the last AND
// with the model the reader has open in front of them.
export function openingPosition(modelCase) {
  const instruments = modelCase.instruments ?? [];
  // The revolver's opening draw is already a reporting-currency figure in the
  // solver, which starts its own roll-forward from `rcf_policy.opening_draw`
  // untranslated; it is left untranslated here for the same reason.
  const openingDraw = Number(
    modelCase.rcf_policy?.opening_draw ??
      instruments.find((instrument) => instrument.class === "rcf")
        ?.opening_balance ??
      0,
  );
  const translated = (instrument) => {
    const amount = Number(instrument.opening_balance ?? 0);
    if (instrument.balance_basis === "reporting_currency_carrying_value") {
      return amount;
    }
    return amount * openingFxRate(modelCase, instrument.currency);
  };
  const grossExcludingLeases =
    instruments
      .filter(
        (instrument) =>
          isRealDebt(instrument) && instrument.include_in_gross_debt !== false,
      )
      .reduce((total, instrument) => total + translated(instrument), 0) +
    openingDraw;
  const netExcludingLeases =
    instruments
      .filter(
        (instrument) =>
          isRealDebt(instrument) && instrument.include_in_net_debt !== false,
      )
      .reduce((total, instrument) => total + translated(instrument), 0) +
    openingDraw;
  const lease = leaseOpeningLiability(modelCase);
  const policy = modelCase.lease_policy ?? {};
  const leaseActive = policy.mode !== "exclude";
  const cash = Number(modelCase.cash_policy?.opening_cash ?? 0);
  const eligible =
    cash * Number(modelCase.cash_policy?.eligible_cash_percentage ?? 1);
  const ebitda = historicalAdjustedEbitda(modelCase, LAST_ACTUAL);
  const grossDebt =
    grossExcludingLeases +
    (leaseActive && policy.include_in_gross_debt ? lease : 0);
  const netDebt =
    netExcludingLeases +
    (leaseActive && policy.include_in_net_debt ? lease : 0) -
    eligible;
  const leverageDebt =
    netExcludingLeases +
    (leaseActive && policy.include_in_leverage ? lease : 0) -
    eligible;
  return {
    period: modelCase.periods?.[LAST_ACTUAL]?.date ?? null,
    gross_debt: grossDebt,
    net_debt: netDebt,
    cash,
    eligible_cash: eligible,
    adjusted_ebitda: ebitda,
    net_leverage: ebitda === 0 ? null : leverageDebt / ebitda,
  };
}

function cagr(from, to, periods) {
  if (!(from > 0) || !(to > 0) || periods <= 0) return null;
  return (to / from) ** (1 / periods) - 1;
}

/**
 * Two sentences on what the model SAYS.
 *
 * Sentence one: the direction of leverage and what drove it, with the drivers
 * ranked by a decomposition rather than by assertion. Sentence two: the
 * liquidity floor and the state of the revolver.
 */
export function plainEnglishRead(modelCase, solved) {
  const currency = modelCase.issuer?.reporting_currency;
  const opening = openingPosition(modelCase);
  const years = solved.forecast;
  const last = years[years.length - 1];
  const money = (value) => formatMoney(value, currency);

  const netCashThroughout =
    opening.net_debt < 0 && years.every((year) => Number(year.net_debt) < 0);

  const sentences = [];

  if (netCashThroughout) {
    const openingNetCash = -opening.net_debt;
    const closingNetCash = -Number(last.net_debt);
    const flat =
      Math.abs(closingNetCash - openingNetCash) <=
      0.02 * Math.max(Math.abs(openingNetCash), 1);
    sentences.push(
      flat
        ? `The company is net cash throughout the forecast, holding steady at ` +
          `${money(closingNetCash)}, so leverage never becomes a meaningful measure.`
        : `The company is net cash throughout the forecast: net cash ` +
          `${closingNetCash > openingNetCash ? "rises" : "falls"} from ` +
          `${money(openingNetCash)} to ${money(closingNetCash)}, so leverage never ` +
          `becomes a meaningful measure.`,
    );
  } else {
    const openingLeverage = opening.net_leverage;
    const closingLeverage = Number(last.net_leverage);
    const verb =
      closingLeverage < openingLeverage - 0.05
        ? "falls"
        : closingLeverage > openingLeverage + 0.05
          ? "rises"
          : "is broadly flat";
    // Decompose the leverage move into an EBITDA effect and a net debt effect,
    // and name whichever is larger. This is what makes "driven mainly by"
    // a computed claim rather than a guess.
    const ebitdaEffect =
      opening.adjusted_ebitda > 0 && Number(last.adjusted_ebitda) > 0
        ? (opening.net_debt / Number(last.adjusted_ebitda)) -
          opening.net_debt / opening.adjusted_ebitda
        : 0;
    const debtEffect =
      Number(last.adjusted_ebitda) > 0
        ? (Number(last.net_debt) - opening.net_debt) /
          Number(last.adjusted_ebitda)
        : 0;
    const ebitdaGrowth = cagr(
      opening.adjusted_ebitda,
      Number(last.adjusted_ebitda),
      years.length,
    );
    const netDebtMove = Number(last.net_debt) - opening.net_debt;
    const drivers = [];
    if (ebitdaGrowth !== null && Math.abs(ebitdaEffect) > 0.01) {
      drivers.push({
        magnitude: Math.abs(ebitdaEffect),
        // Below half a point a year is not growth or decline, it is noise, and
        // rounding it to "0% p.a. EBITDA decline" would be worse than silent.
        text:
          Math.abs(ebitdaGrowth) < 0.005
            ? "broadly flat EBITDA"
            : `${pct(Math.abs(ebitdaGrowth), { decimals: 0 })} p.a. EBITDA ${ebitdaGrowth >= 0 ? "growth" : "decline"}`,
      });
    }
    if (Math.abs(debtEffect) > 0.01) {
      drivers.push({
        magnitude: Math.abs(debtEffect),
        text:
          netDebtMove < 0
            ? `${money(-netDebtMove)} of net debt repayment`
            : `${money(netDebtMove)} of additional net debt`,
      });
    }
    drivers.sort((left, right) => right.magnitude - left.magnitude);
    const driverText =
      drivers.length === 0
        ? ""
        : drivers.length === 1
          ? `, driven by ${drivers[0].text}`
          : `, driven mainly by ${drivers[0].text} and ${drivers[1].text}`;
    sentences.push(
      verb === "is broadly flat"
        ? `Leverage ${verb} across the forecast at around ${formatTurns(closingLeverage)}${driverText}.`
        : `Leverage ${verb} from ${formatTurns(openingLeverage)} to ${formatTurns(closingLeverage)} over the forecast${driverText}.`,
    );
  }

  const liquidities = years.map((year) => Number(year.total_liquidity));
  const minimumLiquidity = Math.min(...liquidities);
  const minimumYear = years[liquidities.indexOf(minimumLiquidity)].period.slice(0, 4);
  const draws = years.map((year) => Number(year.ending_rcf ?? 0));
  const peakDraw = Math.max(...draws);
  const capacity = Number(modelCase.rcf_policy?.capacity ?? 0);
  const rcfSentence =
    peakDraw <= 1e-6
      ? "The revolver is undrawn throughout."
      : `The revolver peaks at ${money(peakDraw)} drawn in ${years[draws.indexOf(peakDraw)].period.slice(0, 4)}` +
        (capacity > 0 ? `, ${pct(peakDraw / capacity)} of its ${money(capacity)} capacity.` : ".");
  sentences.push(
    `Liquidity never drops below ${money(minimumLiquidity)} (${minimumYear}). ${rcfSentence}`,
  );

  return {
    text: sentences.join(" "),
    sentences,
    opening,
    closing: last,
    minimum_liquidity: minimumLiquidity,
    minimum_liquidity_year: minimumYear,
    peak_rcf_draw: peakDraw,
    net_cash_throughout: netCashThroughout,
  };
}

// ── the report ─────────────────────────────────────────────────────────────

function tiesToFilings(modelCase, reconciliation) {
  const currency = modelCase.issuer?.reporting_currency;
  const ties = [];
  if (reconciliation) {
    const share =
      reconciliation.residual_percentage === null
        ? "n/a"
        : pct(reconciliation.residual_percentage, { decimals: 2 });
    ties.push(
      `Instruments in the export foot to ${formatMoney(reconciliation.export_total, currency)} ` +
        `against ${formatMoney(reconciliation.reported_gross_debt, currency)} of reported gross debt ` +
        `(${share} unexplained).`,
    );
  }
  const interest = resolveHistoricalInterestAuthority(modelCase);
  if (interest.present && interest.valid) {
    const residuals = interest.unallocated_interest ?? [0, 0, 0];
    const worst = Math.max(...residuals.map(Math.abs), 0);
    ties.push(
      !interest.has_filed_total
        ? `Historical finance expense is supported by identified components only; no filed-total residual is asserted.`
        : worst <= 1e-6
        ? `Interest identified by instrument equals reported gross interest in every historical year.`
        : `Interest identified by instrument leaves at most ${formatMoney(worst, currency)} unallocated in a historical year, carried as its own line.`,
    );
  }
  const cash = modelCase.cash_policy?.historical_year_end_cash;
  if (Array.isArray(cash)) {
    ties.push(
      `Year-end cash for the three historical years is taken from the accounts: ` +
        `${cash.map((value) => formatMoney(value, currency)).join(", ")}.`,
    );
  }
  if (modelCase.broker_pack?.source_label) {
    const houses = modelCase.broker_pack.forecast_periods?.length ?? null;
    ties.push(
      `The forecast anchor comes from ${modelCase.broker_pack.source_label}` +
        (houses ? ` across ${houses} forecast periods.` : "."),
    );
  }
  return ties;
}

function brokerSubstitutions(modelCase) {
  const entries = [];
  const periods = modelCase.broker_pack?.forecast_periods ?? [];
  for (const [metricId, metric] of Object.entries(
    modelCase.broker_pack?.metrics ?? {},
  )) {
    for (let index = 0; index < 3; index += 1) {
      const selection = resolveBrokerForecastSelection(
        modelCase,
        metricId,
        index,
      );
      if (!selection.substituted) continue;
      entries.push(
        `${metric.label ?? metricId} in ${String(periods[index] ?? `forecast ${index + 1}`).slice(0, 4)} uses ${selection.source_name ?? "consensus"} because ${selection.substitution_reason}`,
      );
    }
  }
  return entries;
}

/**
 * What the model carries because it was TYPED, with nothing behind it to derive
 * it from.
 *
 * WHY THIS FUNCTION DOES NOT USE THE LEGACY METRIC-LEVEL FORECAST LABEL.
 *
 * It opened with one claim per operating metric whose `forecast_method` read
 * `supplied_exact`: "X is typed for every year rather than derived. A forecast
 * method that derived it would overwrite the consensus the broker set
 * supplies." Three things were wrong with it, and none is repairable in place.
 *
 *   1. The legacy metric-level `forecast_method` label is not an executable
 *      authority. The executable contract is now the resolved per-row,
 *      per-period waterfall carried by the semantic graph. This function has a
 *      narrower purpose: disclose unscheduled typed finance plugs and residual
 *      debt pools, not restate the forecast authority report below.
 *
 *   2. THE CLAIM WAS FALSE ON EVERY CERTIFICATION CASE. Every one of the eight
 *      marks Revenue and Adjusted EBITDA `supplied_exact`, and every one of the
 *      eight has both in the broker pack — so the forecast columns are
 *      `='Brokers'!D17`, the Brokers selector decides them, and the typed
 *      series is never read. The sentence named as typed precisely the two
 *      metrics that are derived, and then explained the mistake by appealing to
 *      the broker set that had overwritten them.
 *
 *   3. THERE IS NO TRUE CLAIM LEFT AT THE METRIC LEVEL. Correcting the test to
 *      "the broker pack does not reach it" leaves, across all eight cases,
 *      three metrics — and in the only case where they are non-zero the case
 *      states two different typed series for them: `operating_metrics
 *      .other_investing` reads 18.5, 33.75, 41.375 while the `other_investing`
 *      statement row the workbook actually prints reads 14.5, 15.75, 16.375.
 *      A report that picked one would be asserting something it cannot know.
 *
 * So the claim is DROPPED rather than re-sourced. What is left is the three
 * claims that were always grounded in fields the solver and the emitter really
 * read — the two interest plugs and the residual pool — each of which names a
 * figure that is on the face of the model with no instrument behind it. That is
 * what this section is for.
 */
function typedNotDerived(modelCase) {
  const currency = modelCase.issuer?.reporting_currency;
  const typed = [];
  const other = modelCase.other_interest ?? [];
  if (other.some((value) => Number(value) !== 0)) {
    typed.push(
      `Other interest of ${other.map((value) => formatMoney(value, currency)).join(", ")} ` +
        `is typed. It is the reported total less the interest identified instrument by ` +
        `instrument, and there is no instrument to derive it from.`,
    );
  }
  const nonCash = modelCase.non_cash_interest ?? [];
  if (nonCash.some((value) => Number(value) !== 0)) {
    typed.push(
      `Non-cash interest of ${nonCash.map((value) => formatMoney(value, currency)).join(", ")} ` +
        `is typed from the note; amortisation of issue costs has no instrument-level driver.`,
    );
  }
  const pool = (modelCase.instruments ?? []).find(
    (instrument) => instrument.is_residual_pool,
  );
  if (pool) {
    typed.push(
      `${formatMoney(pool.opening_balance, currency)} sits in an unexplained residual line ` +
        `because the export did not foot to the accounts. It is on the face of the model, ` +
        `not absorbed into an instrument.`,
    );
  }
  return typed;
}

function forecastAuthorityPath(modelCase) {
  const rows = [
    ...(modelCase.statement_structure?.income_statement ?? []),
    ...(modelCase.statement_structure?.cash_flow ?? []),
  ].filter((row) => row.row_type !== "header");
  const details = [];
  const summary = [];
  for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
    const counts = new Map();
    for (const row of rows) {
      const authority = resolveForecastAuthority(modelCase, row, forecastIndex);
      counts.set(authority.method, (counts.get(authority.method) ?? 0) + 1);
      details.push({
        row_id: row.row_id,
        label: row.label,
        semantic_role: row.semantic_role ?? null,
        forecast_index: forecastIndex,
        period: modelCase.periods?.[forecastIndex + 3]?.date ?? null,
        method: authority.method,
        mechanism: authority.mechanism,
        source_kind: authority.source_kind ?? null,
        source_id: authority.source_id ?? null,
        as_of_date: authority.as_of_date ?? null,
        broker_metric_id:
          authority.mechanism === "broker"
            ? row.broker_metric_id ?? row.semantic_role ?? null
            : null,
        inferred: authority.inferred === true,
      });
    }
    const period = String(
      modelCase.periods?.[forecastIndex + 3]?.date ?? `forecast ${forecastIndex + 1}`,
    ).slice(0, 4);
    const path = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([method, count]) => `${count} ${method.replaceAll("_", " ")}`)
      .join(", ");
    summary.push(`${period}: ${path}.`);
  }
  return { summary, details };
}

/**
 * What the checks could only call plausible rather than confirmed.
 *
 * The live example this exists for: a forward interest plug of 60 against a
 * historical unallocated residual of 0. Nothing in the model is inconsistent —
 * it ties — but a plug that appears only in the forecast has no historical
 * precedent and a reader should be told.
 */
export function plausibilityChecks(modelCase, solved, read) {
  const currency = modelCase.issuer?.reporting_currency;
  const notes = [];

  const interest = resolveHistoricalInterestAuthority(modelCase);
  const historicalPlug = interest.present && interest.valid
    ? Math.max(
        ...(interest.unallocated_interest ?? []).map(Math.abs),
        0,
      )
    : 0;
  const forwardPlug = Math.max(
    ...(modelCase.other_interest ?? [0]).map((value) => Math.abs(Number(value))),
    0,
  );
  if (forwardPlug > 0 && historicalPlug <= 1e-6) {
    notes.push(
      `The forecast carries ${formatMoney(forwardPlug, currency)} of other interest ` +
        `against a historical unallocated residual of nil. The plug has no historical ` +
        `precedent; it ties, but nothing in the filings supports it recurring.`,
    );
  }

  // Both ends of the comparison come off the model that was built: the opening
  // and the three historical years are the workbook's own EBITDA row, resolved
  // by `historicalAdjustedEbitda`, and the closing figure is the solver's. It
  // used to read `operating_metrics.adjusted_ebitda.values` here — a series the
  // historical columns do not show — so a case whose bridge and whose metric
  // series disagreed would have had its forecast measured against a history the
  // reader could not find in the file.
  const openingEbitda = read.opening.adjusted_ebitda;
  const historicalGrowth = cagr(
    historicalAdjustedEbitda(modelCase, 0),
    historicalAdjustedEbitda(modelCase, LAST_ACTUAL),
    LAST_ACTUAL,
  );
  const forecastGrowth = cagr(
    openingEbitda,
    Number(solved.forecast[solved.forecast.length - 1].adjusted_ebitda),
    solved.forecast.length,
  );
  if (
    historicalGrowth !== null &&
    forecastGrowth !== null &&
    forecastGrowth - historicalGrowth > 0.05
  ) {
    notes.push(
      `Forecast EBITDA grows at ${pct(forecastGrowth)} a year against ${pct(historicalGrowth)} ` +
        `over the three historical years. The forecast is the broker consensus, not the ` +
        `company's own record.`,
    );
  }

  if (!read.net_cash_throughout && read.opening.net_leverage !== null) {
    const swing = Math.abs(
      Number(solved.forecast[solved.forecast.length - 1].net_leverage) -
        read.opening.net_leverage,
    );
    if (swing > 1.5) {
      notes.push(
        `Leverage moves ${swing.toFixed(1)} turns across three years. That is a large ` +
          `swing to carry on forecast assumptions alone.`,
      );
    }
  }

  const capacity = Number(modelCase.rcf_policy?.capacity ?? 0);
  if (capacity > 0 && read.peak_rcf_draw / capacity > 0.9) {
    notes.push(
      `The revolver reaches ${pct(read.peak_rcf_draw / capacity)} drawn. The model has ` +
        `almost no headroom left if any assumption moves against it.`,
    );
  }
  if (capacity > 0 && read.peak_rcf_draw <= 1e-6) {
    notes.push(
      `No forecast year draws the revolver, so the facility mechanics are never ` +
        `exercised by this case.`,
    );
  }

  for (const year of solved.forecast) {
    if (Number(year.liquidity_shortfall ?? 0) > 1e-6) {
      notes.push(
        `${year.period.slice(0, 4)} runs a liquidity shortfall of ` +
          `${formatMoney(year.liquidity_shortfall, currency)} after the revolver is fully drawn.`,
      );
    }
  }

  return notes;
}

/**
 * The whole of stage 5. Non-blocking by construction: it returns, it does not
 * prompt.
 */
export function buildDeliveryReport({
  modelCase,
  solved,
  reconciliation = null,
  assumptions = [],
}) {
  const read = plainEnglishRead(modelCase, solved);
  const forecastAuthorities = forecastAuthorityPath(modelCase);
  return {
    read: read.text,
    read_detail: read,
    ties: tiesToFilings(modelCase, reconciliation),
    broker_substitutions: brokerSubstitutions(modelCase),
    forecast_authority_summary: forecastAuthorities.summary,
    forecast_authority_path: forecastAuthorities.details,
    typed: typedNotDerived(modelCase),
    assumed: assumptions.map((assumption) => assumption.text),
    plausible_only: plausibilityChecks(modelCase, solved, read),
  };
}
