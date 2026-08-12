const DAY_MS = 86_400_000;
const EPSILON = 1e-9;

const FAMILY_BY_CLASS = Object.freeze({
  fixed_bond: "bond",
  floating_loan: "term_loan",
  commercial_paper: "commercial_paper",
  securitisation: "securitisation",
  rcf: "revolving_credit_facility",
  other_debt: "other_debt",
  lease_liability: "lease",
});

const DEFINITION_NODE_TEMPLATES = Object.freeze([
  {
    node_id: "gross_debt_instruments_excluding_leases",
    basis: "model_lease_exclusive",
    operation: "sum_states",
    dependencies: [],
    source_selector: "states[*].ending_post_repayment.reporting_amount where inclusion.gross_debt=true and family!=lease",
  },
  {
    node_id: "lease_liabilities",
    basis: "model_lease_inclusive",
    operation: "sum_states",
    dependencies: [],
    source_selector: "states[*].ending_post_repayment.reporting_amount where family=lease",
  },
  {
    node_id: "model_gross_debt_excluding_leases",
    basis: "model_lease_exclusive",
    operation: "add",
    dependencies: ["gross_debt_instruments_excluding_leases"],
    source_selector: null,
  },
  {
    node_id: "model_gross_debt_including_leases",
    basis: "model_lease_inclusive",
    operation: "add",
    dependencies: ["model_gross_debt_excluding_leases", "lease_liabilities"],
    source_selector: null,
  },
  {
    node_id: "model_gross_debt",
    basis: "model",
    operation: "select",
    dependencies: ["model_gross_debt_excluding_leases", "model_gross_debt_including_leases"],
    source_selector: "select model_gross_debt_including_leases when lease_policy.include_in_gross_debt=true else model_gross_debt_excluding_leases",
  },
  {
    node_id: "eligible_cash",
    basis: "cash_eligibility",
    operation: "sum_cash_buckets",
    dependencies: [],
    source_selector: "cash_policy.buckets[*].period_end_balance * net_debt_eligible_percentage; legacy cash uses period_end_balance * eligible_cash_percentage",
  },
  {
    node_id: "liquidity_cash",
    basis: "cash_liquidity",
    operation: "sum_cash_buckets",
    dependencies: [],
    source_selector: "cash_policy.buckets[*].period_end_balance where available_for_liquidity=true; legacy cash uses balancing period_end_balance",
  },
  {
    node_id: "model_net_debt_excluding_leases",
    basis: "model_lease_exclusive",
    operation: "subtract",
    dependencies: ["model_gross_debt_excluding_leases", "eligible_cash"],
    source_selector: null,
  },
  {
    node_id: "model_net_debt_including_leases",
    basis: "model_lease_inclusive",
    operation: "subtract",
    dependencies: ["model_gross_debt_including_leases", "eligible_cash"],
    source_selector: null,
  },
  {
    node_id: "model_net_debt",
    basis: "model",
    operation: "select",
    dependencies: ["model_net_debt_excluding_leases", "model_net_debt_including_leases"],
    source_selector: "select model_net_debt_including_leases when lease_policy.include_in_net_debt=true else model_net_debt_excluding_leases",
  },
  {
    node_id: "reported_net_debt_adjustments",
    basis: "company_reported",
    operation: "sum_adjustments",
    dependencies: [],
    source_selector: "historical_supplement.reported_net_debt_adjustment[*].values[3:6] using each named signed component exactly once",
  },
  {
    node_id: "reported_net_debt",
    basis: "company_reported",
    operation: "add",
    dependencies: ["model_net_debt", "reported_net_debt_adjustments"],
    source_selector: null,
  },
  {
    node_id: "leverage_debt",
    basis: "leverage",
    operation: "sum_states",
    dependencies: [],
    source_selector: "states[*].ending_post_repayment.reporting_amount where inclusion.leverage=true",
  },
  {
    node_id: "leverage_numerator",
    basis: "leverage",
    operation: "subtract",
    dependencies: ["leverage_debt", "eligible_cash"],
    source_selector: null,
  },
]);

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric.`);
  return parsed;
}

function series3(value, label, fallback = 0) {
  if (value === undefined || value === null) return [fallback, fallback, fallback];
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${label} must contain exactly three values.`);
  }
  return value.map((item, index) => number(item, `${label}[${index}]`));
}

function date(value, label) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return parsed;
}

function periodBounds(periods, forecastIndex) {
  const absoluteIndex = periods.findIndex((period, index) =>
    period.status === "forecast" && periods.slice(0, index + 1).filter((item) => item.status === "forecast").length === forecastIndex + 1,
  );
  const end = date(periods[absoluteIndex].date, `periods[${absoluteIndex}].date`);
  const previous = periods[absoluteIndex - 1];
  if (!previous) throw new Error("Each forecast period requires a preceding period end.");
  const start = new Date(date(previous.date, `periods[${absoluteIndex - 1}].date`).getTime() + DAY_MS);
  return { start, end, absoluteIndex };
}

function fractionBetween(start, end, bounds) {
  const boundedStart = new Date(Math.max(start.getTime(), bounds.start.getTime()));
  const boundedEnd = new Date(Math.min(end.getTime(), bounds.end.getTime()));
  if (boundedEnd < boundedStart) return 0;
  return Math.max(0, Math.min(1,
    (boundedEnd.getTime() - boundedStart.getTime() + DAY_MS) /
      (bounds.end.getTime() - bounds.start.getTime() + DAY_MS),
  ));
}

function movementFraction(value, bounds, activeEnd, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = date(value, "instrument movement date");
  return fractionBetween(parsed, activeEnd, bounds);
}

function fxRate(modelCase, currency, absolutePeriodIndex, kind) {
  if (currency === modelCase.issuer.reporting_currency) return 1;
  const pair = modelCase.fx?.[currency];
  if (!pair) throw new Error(`Missing FX assumptions for ${currency}.`);
  if (!["reporting_per_native", "native_per_reporting"].includes(pair.quote)) {
    throw new Error(`Unsupported FX quote convention for ${currency}: ${pair.quote}.`);
  }
  const rates = kind === "average" ? pair.average_rates : pair.period_end_rates;
  if (!Array.isArray(rates) || rates.length <= absolutePeriodIndex) {
    throw new Error(`Missing ${kind} FX rate for ${currency} period ${absolutePeriodIndex}.`);
  }
  const raw = number(rates[absolutePeriodIndex], `fx.${currency}.${kind}[${absolutePeriodIndex}]`);
  if (!(raw > 0)) throw new Error(`FX rate for ${currency} must be positive.`);
  return pair.quote === "reporting_per_native" ? raw : 1 / raw;
}

function openingTranslationFor(modelCase, instrument, bounds) {
  const reporting = modelCase.issuer.reporting_currency;
  const carrying = instrument.balance_basis === "reporting_currency_carrying_value";
  const basisCurrency = carrying ? reporting : instrument.currency;
  const openingAbsoluteIndex = Math.max(0, bounds.absoluteIndex - 1);
  const openingRate = fxRate(modelCase, basisCurrency, openingAbsoluteIndex, "period_end");
  return {
    method: carrying
      ? "reporting_currency_carrying_value_no_translation"
      : basisCurrency === reporting
        ? "reporting_currency_no_translation"
        : "native_principal_to_reporting",
    basis_currency: basisCurrency,
    opening_rate: openingRate,
  };
}

function translationFor(modelCase, instrument, bounds) {
  const opening = openingTranslationFor(modelCase, instrument, bounds);
  const flowRate = fxRate(
    modelCase,
    opening.basis_currency,
    bounds.absoluteIndex,
    "average",
  );
  const closingRate = fxRate(
    modelCase,
    opening.basis_currency,
    bounds.absoluteIndex,
    "period_end",
  );
  return {
    ...opening,
    flow_rate: flowRate,
    closing_rate: closingRate,
  };
}

/**
 * Canonical last-historical opening-debt translation.
 *
 * The opening balance for forecast year one is the closing balance at the
 * final historical period end.  Native principal therefore uses the same
 * period-end FX rate as the first instrument-period state, while a supplied
 * reporting-currency carrying value remains at 1.0 even when the instrument's
 * legal denomination is foreign.  Release and coverage gates consume this
 * artifact instead of independently summing mixed-currency case fields.
 */
export function compileOpeningInstrumentState(modelCase) {
  if (!modelCase || typeof modelCase !== "object") {
    throw new Error("modelCase is required.");
  }
  if (!Array.isArray(modelCase.instruments)) {
    throw new Error("modelCase.instruments must be an array.");
  }
  const reportingCurrency = modelCase.issuer?.reporting_currency;
  if (!reportingCurrency) {
    throw new Error("issuer.reporting_currency is required.");
  }
  let firstForecastBounds;
  try {
    firstForecastBounds = periodBounds(modelCase.periods ?? [], 0);
  } catch (error) {
    return {
      schema_version: "opening-instrument-state/1.0",
      reporting_currency: reportingCurrency,
      as_of: null,
      status: "BLOCKED",
      rows: [],
      reporting_total: null,
      errors: [error.message],
    };
  }
  const asOf = modelCase.periods[firstForecastBounds.absoluteIndex - 1]?.date ?? null;
  const rows = [];
  const errors = [];
  const ids = new Set();
  for (const instrument of modelCase.instruments) {
    const id = instrument?.instrument_id ?? "unknown";
    if (ids.has(id)) {
      errors.push(`Instrument IDs must be unique; duplicate ${id}.`);
      continue;
    }
    ids.add(id);
    try {
      const balanceBasis = instrument.balance_basis ?? "native_principal";
      if (!["native_principal", "reporting_currency_carrying_value"].includes(balanceBasis)) {
        throw new Error(`${id}.balance_basis must be explicit.`);
      }
      const resolvedInstrument = instrument.balance_basis
        ? instrument
        : { ...instrument, balance_basis: balanceBasis };
      const translation = openingTranslationFor(
        modelCase,
        resolvedInstrument,
        firstForecastBounds,
      );
      const basisAmount = number(instrument.opening_balance, `${id}.opening_balance`);
      if (basisAmount < 0) throw new Error(`${id}.opening_balance must be non-negative.`);
      rows.push({
        instrument_id: id,
        class: instrument.class ?? null,
        legal_currency: instrument.currency ?? null,
        balance_basis: balanceBasis,
        basis_currency: translation.basis_currency,
        basis_amount: basisAmount,
        reporting_currency: reportingCurrency,
        reporting_amount: basisAmount * translation.opening_rate,
        translation_rate: translation.opening_rate,
        translation_method: translation.method,
        include_in_gross_debt: instrument.include_in_gross_debt !== false,
        is_residual_pool: instrument.is_residual_pool === true,
      });
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
    }
  }
  return {
    schema_version: "opening-instrument-state/1.0",
    reporting_currency: reportingCurrency,
    as_of: asOf,
    status: errors.length === 0 ? "PASS" : "BLOCKED",
    rows,
    reporting_total:
      errors.length === 0
        ? rows
            .filter((row) => row.include_in_gross_debt)
            .reduce((total, row) => total + row.reporting_amount, 0)
        : null,
    errors,
  };
}

function amount(basisAmount, rate) {
  return {
    basis_amount: basisAmount,
    reporting_amount: basisAmount * rate,
    translation_rate: rate,
  };
}

function nonCashComponents(instrument) {
  if (instrument.non_cash_movement_components) {
    if (instrument.other_non_cash_movement !== undefined) {
      throw new Error(`${instrument.instrument_id} cannot use aggregate and component non-cash movements together.`);
    }
    return {
      fairValue: series3(instrument.non_cash_movement_components.fair_value, `${instrument.instrument_id}.non_cash_movement_components.fair_value`),
      other: series3(instrument.non_cash_movement_components.other, `${instrument.instrument_id}.non_cash_movement_components.other`),
    };
  }
  return {
    fairValue: [0, 0, 0],
    other: series3(instrument.other_non_cash_movement, `${instrument.instrument_id}.other_non_cash_movement`),
  };
}

function pikAccretion(weightedBase, rate, activeFraction, enabled) {
  if (!enabled || !(rate > 0)) return 0;
  const denominator = 1 - rate * activeFraction / 2;
  if (!(denominator > 0)) throw new Error("PIK rate must remain below 200% under the average-balance convention.");
  return Math.max(0, weightedBase * rate / denominator);
}

function pricingState(instrument, pik) {
  if (instrument.rate_type === "unpriced" || instrument.pricing_treatment === "residual_interest_plug") {
    return "residual_interest_plug";
  }
  const hasCash = instrument.cash_interest !== false && instrument.rate_type !== undefined;
  const hasPik = pik > EPSILON;
  if (hasCash && hasPik) return "priced_cash_and_pik";
  if (hasPik) return "priced_pik";
  if (hasCash) return "priced_cash";
  return "not_interest_bearing";
}

function repaymentState(instrument, scheduled, maturity, balancingRcf = false) {
  if (balancingRcf) return "discretionary_rcf";
  // A contractual date is evidence of *when* a balance repays, not evidence
  // that a repayment exists.  Zero-balance legacy instruments often retain a
  // maturity date in the source export; labelling them "maturity" would put a
  // zero cash flow inside the mandatory-repayment population and contradict
  // the amount-based membership gate below.  Conversely, an issuance before
  // that date produces a positive maturity amount and therefore still enters
  // the pool without any special case.
  if (scheduled > EPSILON && maturity > EPSILON) return "scheduled_and_maturity";
  if (maturity > EPSILON) return "maturity";
  if (scheduled > EPSILON) return "scheduled";
  return "none";
}

/**
 * One predicate owns contractual maturity throughout the instrument graph.
 * A non-maturing declaration is economic authority even when a date is kept
 * as audit evidence, and only the one named balancing RCF is excluded from
 * contractual repayment. Other revolvers remain ordinary instruments.
 */
export function maturityApplies({
  instrument,
  maturityDate,
  periodEnd,
  debtMaturitiesRoll,
  balancingRcf = false,
}) {
  return Boolean(
    debtMaturitiesRoll === 1 &&
      !balancingRcf &&
      instrument?.maturity_treatment !== "non_maturing_within_forecast" &&
      maturityDate &&
      maturityDate <= periodEnd,
  );
}

function instrumentStates(modelCase, instrument, forecastPeriods) {
  if (!FAMILY_BY_CLASS[instrument.class] || instrument.class === "lease_liability") {
    throw new Error(`Unsupported debt class ${instrument.class} for ${instrument.instrument_id}.`);
  }
  const balanceBasis = instrument.balance_basis ?? "native_principal";
  if (!["native_principal", "reporting_currency_carrying_value"].includes(balanceBasis)) {
    throw new Error(`${instrument.instrument_id}.balance_basis must be explicit.`);
  }
  const resolvedInstrument = instrument.balance_basis
    ? instrument
    : { ...instrument, balance_basis: balanceBasis };
  const issuance = series3(instrument.new_issuance, `${instrument.instrument_id}.new_issuance`);
  const amortisation = series3(instrument.scheduled_amortisation, `${instrument.instrument_id}.scheduled_amortisation`);
  const pikRates = series3(instrument.pik_rate, `${instrument.instrument_id}.pik_rate`);
  const nonCash = nonCashComponents(instrument);
  const balancingRcf =
    instrument.class === "rcf" &&
    modelCase.rcf_policy?.instrument_id === instrument.instrument_id;
  if (balancingRcf && amortisation.some((value) => Math.abs(value) > EPSILON)) {
    throw new Error(`Balancing RCF ${instrument.instrument_id} cannot enter the mandatory repayment pool through scheduled amortisation.`);
  }
  let opening = number(instrument.opening_balance, `${instrument.instrument_id}.opening_balance`);
  const states = [];
  for (let index = 0; index < 3; index += 1) {
    const bounds = periodBounds(modelCase.periods, index);
    const maturityDate = instrument.maturity_date ? date(instrument.maturity_date, `${instrument.instrument_id}.maturity_date`) : null;
    const matures = maturityApplies({
      instrument,
      maturityDate,
      periodEnd: bounds.end,
      debtMaturitiesRoll: modelCase.controls?.debt_maturities_roll,
      balancingRcf,
    });
    const activeEnd = matures && maturityDate < bounds.end ? maturityDate : bounds.end;
    const activeFraction = fractionBetween(bounds.start, activeEnd, bounds);
    const fallbackMovementFraction = activeFraction / 2;
    const issuanceFraction = movementFraction(instrument.new_issuance_dates?.[index], bounds, activeEnd, fallbackMovementFraction);
    const amortisationFraction = movementFraction(instrument.scheduled_amortisation_dates?.[index], bounds, activeEnd, fallbackMovementFraction);
    const periodIssuance = issuance[index];
    const periodFairValue = nonCash.fairValue[index];
    const periodOther = nonCash.other[index];
    const periodAmortisation = Math.min(
      Math.max(0, opening + periodIssuance + periodFairValue + periodOther),
      Math.max(0, amortisation[index]),
    );
    const weightedBase = Math.max(0,
      opening * activeFraction +
      periodIssuance * issuanceFraction +
      (periodFairValue + periodOther) * fallbackMovementFraction -
      periodAmortisation * amortisationFraction,
    );
    const pik = pikAccretion(weightedBase, pikRates[index], activeFraction, modelCase.controls?.circularity === 1);
    const endingPre = Math.max(0, opening + periodIssuance + periodFairValue + periodOther + pik - periodAmortisation);
    const maturityRepayment = matures ? endingPre : 0;
    const endingPost = Math.max(0, endingPre - maturityRepayment);
    const averageBalance = Math.max(0, weightedBase + pik * activeFraction / 2);
    const sourcedEnding = instrument.forecast_ending_balances?.[index];
    if (sourcedEnding !== undefined && Math.abs(number(sourcedEnding, `${instrument.instrument_id}.forecast_ending_balances[${index}]`) - endingPost) > EPSILON) {
      throw new Error(`${instrument.instrument_id} sourced ending balance does not reconcile in ${forecastPeriods[index].date}.`);
    }
    const translation = translationFor(modelCase, resolvedInstrument, bounds);
    const inclusion = {
      gross_debt: instrument.include_in_gross_debt !== false,
      net_debt: instrument.include_in_net_debt !== false,
      leverage: instrument.include_in_net_debt !== false,
      liquidity: balancingRcf,
      mandatory_repayment: !balancingRcf && (periodAmortisation > EPSILON || maturityRepayment > EPSILON),
      interest: pricingState(instrument, pik) !== "not_interest_bearing",
    };
    states.push({
      state_id: `${instrument.instrument_id}:${forecastPeriods[index].date}`,
      instrument_id: instrument.instrument_id,
      period_id: forecastPeriods[index].date,
      period_index: index,
      class: instrument.class,
      family: FAMILY_BY_CLASS[instrument.class],
      currency: instrument.currency,
      balance_basis: balanceBasis,
      opening: amount(opening, translation.opening_rate),
      issuance: amount(periodIssuance, translation.flow_rate),
      fair_value_movement: amount(periodFairValue, translation.closing_rate),
      other_non_cash_movement: amount(periodOther, translation.closing_rate),
      pik_accretion: amount(pik, translation.closing_rate),
      scheduled_amortisation: amount(periodAmortisation, translation.flow_rate),
      maturity_repayment: amount(maturityRepayment, translation.flow_rate),
      ending_pre_repayment: amount(endingPre, translation.closing_rate),
      ending_post_repayment: amount(endingPost, translation.closing_rate),
      average_interest_balance: amount(averageBalance, translation.flow_rate),
      active_fraction: activeFraction,
      repayment_state: repaymentState(
        instrument,
        periodAmortisation,
        maturityRepayment,
        balancingRcf,
      ),
      pricing_state: pricingState(instrument, pik),
      inclusion,
      translation,
    });
    opening = endingPost;
  }
  return states;
}

function leaseStates(modelCase, forecastPeriods) {
  const policy = modelCase.lease_policy;
  if (!policy || policy.mode === "exclude") return [];
  if ((modelCase.instruments ?? []).some((instrument) => instrument.instrument_id === "lease_liability")) {
    throw new Error("lease_liability is reserved for the separately identified lease state family.");
  }
  const principal = series3(policy.principal_repayment, "lease_policy.principal_repayment");
  const suppliedAdditions = series3(policy.additions, "lease_policy.additions");
  const sourcedEnding = policy.mode === "sourced_balance"
    ? series3(policy.forecast_liabilities, "lease_policy.forecast_liabilities")
    : null;
  const separatelySupplied = policy.interest_basis === "separately_supplied";
  const historicalInterest = separatelySupplied
    ? series3(policy.historical_interest_bearing_liabilities, "lease_policy.historical_interest_bearing_liabilities")
    : null;
  const forecastInterest = separatelySupplied
    ? series3(policy.forecast_interest_bearing_liabilities, "lease_policy.forecast_interest_bearing_liabilities")
    : null;
  let opening = Array.isArray(policy.historical_liabilities)
    ? number(policy.historical_liabilities[2], "lease_policy.historical_liabilities[2]")
    : number(policy.opening_liability, "lease_policy.opening_liability");
  let openingInterest = separatelySupplied ? historicalInterest[2] : opening;
  const states = [];
  for (let index = 0; index < 3; index += 1) {
    const periodPrincipal = Math.min(opening + Math.max(0, suppliedAdditions[index]), Math.max(0, principal[index]));
    const ending = policy.mode === "sourced_balance"
      ? sourcedEnding[index]
      : policy.mode === "flat_replacement"
        ? opening
        : Math.max(0, opening + suppliedAdditions[index] - periodPrincipal);
    const additions = policy.mode === "sourced_balance"
      ? ending - opening + periodPrincipal
      : policy.mode === "flat_replacement"
        ? periodPrincipal
        : suppliedAdditions[index];
    const endingInterest = policy.interest_basis === "none"
      ? 0
      : separatelySupplied
        ? forecastInterest[index]
        : ending;
    const averageInterest = policy.interest_basis === "none" ? 0 : (openingInterest + endingInterest) / 2;
    const translation = {
      method: "reporting_currency_carrying_value_no_translation",
      basis_currency: modelCase.issuer.reporting_currency,
      opening_rate: 1,
      flow_rate: 1,
      closing_rate: 1,
    };
    states.push({
      state_id: `lease_liability:${forecastPeriods[index].date}`,
      instrument_id: "lease_liability",
      period_id: forecastPeriods[index].date,
      period_index: index,
      class: "lease_liability",
      family: "lease",
      currency: modelCase.issuer.reporting_currency,
      balance_basis: "reporting_currency_carrying_value",
      opening: amount(opening, 1),
      issuance: amount(0, 1),
      fair_value_movement: amount(0, 1),
      other_non_cash_movement: amount(additions, 1),
      pik_accretion: amount(0, 1),
      scheduled_amortisation: amount(periodPrincipal, 1),
      maturity_repayment: amount(0, 1),
      ending_pre_repayment: amount(ending, 1),
      ending_post_repayment: amount(ending, 1),
      average_interest_balance: amount(averageInterest, 1),
      active_fraction: 1,
      repayment_state: periodPrincipal > EPSILON ? "lease_principal" : "none",
      pricing_state: policy.interest_basis === "none" ? "not_interest_bearing" : "priced_cash",
      inclusion: {
        gross_debt: policy.include_in_gross_debt === true,
        net_debt: policy.include_in_net_debt === true,
        leverage: policy.include_in_leverage === true,
        liquidity: false,
        mandatory_repayment: periodPrincipal > EPSILON,
        interest: policy.interest_basis !== "none",
      },
      translation,
    });
    opening = ending;
    openingInterest = endingInterest;
  }
  return states;
}

export function compileDefinitionBasisGraph(modelCase) {
  return {
    graph_version: "definition-basis-graph/1.0",
    reporting_currency: modelCase.issuer.reporting_currency,
    reported_net_debt_basis_status:
      modelCase.historical_supplement?.reported_net_debt_basis_status ?? "not_disclosed",
    nodes: structuredClone(DEFINITION_NODE_TEMPLATES),
  };
}

export function compileInstrumentPeriodState(modelCase) {
  if (!modelCase || typeof modelCase !== "object") throw new Error("modelCase is required.");
  const forecastPeriods = (modelCase.periods ?? []).filter((period) => period.status === "forecast");
  if (forecastPeriods.length !== 3) {
    throw new Error(`Instrument-period state requires exactly three forecast periods; received ${forecastPeriods.length}.`);
  }
  if (!Array.isArray(modelCase.instruments) || modelCase.instruments.length === 0) {
    throw new Error("Instrument-period state requires at least one semantic instrument.");
  }
  const ids = modelCase.instruments.map((instrument) => instrument.instrument_id);
  if (new Set(ids).size !== ids.length) throw new Error("Instrument IDs must be unique.");
  const residualPriced = modelCase.instruments.filter(
    (instrument) =>
      instrument.rate_type === "unpriced" ||
      instrument.pricing_treatment === "residual_interest_plug",
  );
  if (
    residualPriced.length > 0 &&
    (!Array.isArray(modelCase.other_interest) ||
      modelCase.other_interest.length !== 3 ||
      modelCase.other_interest.some((value) => !Number.isFinite(Number(value))))
  ) {
    throw new Error(
      `Residual-priced instruments (${residualPriced.map((instrument) => instrument.instrument_id).join(", ")}) require an explicit three-period other_interest authority; an absent series cannot become a zero plug.`,
    );
  }
  const states = modelCase.instruments
    .slice()
    .sort((left, right) => left.instrument_id.localeCompare(right.instrument_id))
    .flatMap((instrument) => instrumentStates(modelCase, instrument, forecastPeriods));
  states.push(...leaseStates(modelCase, forecastPeriods));
  const artifact = {
    schema_version: "instrument-period-state/1.0",
    case_id: String(modelCase.case_id ?? "unknown_case"),
    reporting_currency: modelCase.issuer.reporting_currency,
    forecast_period_ids: forecastPeriods.map((period) => period.date),
    states,
    definition_basis_graph: compileDefinitionBasisGraph(modelCase),
  };
  const errors = validateInstrumentPeriodStateArtifact(artifact);
  if (errors.length > 0) throw new Error(`Compiled instrument-period state is invalid: ${errors.join(" | ")}`);
  return artifact;
}

export function validateInstrumentPeriodStateArtifact(artifact) {
  const errors = [];
  if (artifact?.schema_version !== "instrument-period-state/1.0") errors.push("schema_version must be instrument-period-state/1.0.");
  if (!Array.isArray(artifact?.forecast_period_ids) || artifact.forecast_period_ids.length !== 3) errors.push("forecast_period_ids must contain exactly three periods.");
  const states = Array.isArray(artifact?.states) ? artifact.states : [];
  const stateIds = new Set();
  for (const state of states) {
    if (stateIds.has(state.state_id)) errors.push(`Duplicate state_id ${state.state_id}.`);
    stateIds.add(state.state_id);
    const expectedStateId = `${state.instrument_id}:${state.period_id}`;
    if (state.state_id !== expectedStateId) errors.push(`${state.state_id} does not match ${expectedStateId}.`);
    if (state.class === "rcf" && state.inclusion?.liquidity === true) {
      if (state.repayment_state !== "discretionary_rcf") errors.push(`${state.state_id} RCF is not discretionary.`);
      if (state.inclusion?.mandatory_repayment !== false) errors.push(`${state.state_id} RCF entered the mandatory repayment pool.`);
      if (Math.abs(state.maturity_repayment?.basis_amount ?? 0) > EPSILON) errors.push(`${state.state_id} RCF has a maturity repayment.`);
    } else if (state.class === "rcf" && state.repayment_state === "discretionary_rcf") {
      errors.push(`${state.state_id} non-balancing revolver was treated as the liquidity RCF.`);
    }
    if (state.family === "lease" && state.class !== "lease_liability") errors.push(`${state.state_id} lease family is not separately classified.`);
    if (
      state.inclusion?.interest !==
      (state.pricing_state !== "not_interest_bearing")
    ) {
      errors.push(`${state.state_id} interest membership does not match pricing state.`);
    }
    if (
      !(state.class === "rcf" && state.inclusion?.liquidity === true) &&
      state.inclusion?.mandatory_repayment !==
        !["none"].includes(state.repayment_state)
    ) {
      errors.push(`${state.state_id} mandatory repayment membership does not match repayment state.`);
    }
    if (state.balance_basis === "reporting_currency_carrying_value") {
      const translation = state.translation ?? {};
      if (translation.method !== "reporting_currency_carrying_value_no_translation") errors.push(`${state.state_id} carrying value is exposed to double FX translation.`);
      for (const key of ["opening_rate", "flow_rate", "closing_rate"]) {
        if (Math.abs(Number(translation[key]) - 1) > EPSILON) errors.push(`${state.state_id} carrying value has non-unit ${key}.`);
      }
    }
    const amountRates = {
      opening: state.translation?.opening_rate,
      issuance: state.translation?.flow_rate,
      fair_value_movement: state.translation?.closing_rate,
      other_non_cash_movement: state.translation?.closing_rate,
      pik_accretion: state.translation?.closing_rate,
      scheduled_amortisation: state.translation?.flow_rate,
      maturity_repayment: state.translation?.flow_rate,
      ending_pre_repayment: state.translation?.closing_rate,
      ending_post_repayment: state.translation?.closing_rate,
      average_interest_balance: state.translation?.flow_rate,
    };
    for (const [field, expectedRate] of Object.entries(amountRates)) {
      const entry = state[field] ?? {};
      const basisAmount = Number(entry.basis_amount);
      const reportingAmount = Number(entry.reporting_amount);
      const actualRate = Number(entry.translation_rate);
      if (![basisAmount, reportingAmount, actualRate, Number(expectedRate)].every(Number.isFinite)) {
        errors.push(`${state.state_id} ${field} is not a finite translated amount.`);
        continue;
      }
      if (
        Math.abs(actualRate - Number(expectedRate)) > EPSILON ||
        Math.abs(reportingAmount - basisAmount * actualRate) > EPSILON
      ) {
        const prefix = state.balance_basis === "reporting_currency_carrying_value"
          ? "double FX: "
          : "";
        errors.push(`${state.state_id} ${prefix}${field} translation does not reconcile.`);
      }
    }
    const rollForward =
      Number(state.opening?.basis_amount ?? 0) +
      Number(state.issuance?.basis_amount ?? 0) +
      Number(state.fair_value_movement?.basis_amount ?? 0) +
      Number(state.other_non_cash_movement?.basis_amount ?? 0) +
      Number(state.pik_accretion?.basis_amount ?? 0) -
      Number(state.scheduled_amortisation?.basis_amount ?? 0);
    if (Math.abs(rollForward - Number(state.ending_pre_repayment?.basis_amount ?? 0)) > EPSILON) errors.push(`${state.state_id} pre-repayment roll-forward does not close.`);
    if (Math.abs(rollForward - Number(state.maturity_repayment?.basis_amount ?? 0) - Number(state.ending_post_repayment?.basis_amount ?? 0)) > EPSILON) errors.push(`${state.state_id} post-repayment roll-forward does not close.`);
  }
  const instrumentIds = new Set(states.map((state) => state.instrument_id));
  if (instrumentIds.size === 0) errors.push("states must contain at least one instrument family.");
  for (const instrumentId of instrumentIds) {
    const periods = states.filter((state) => state.instrument_id === instrumentId).map((state) => state.period_index).sort();
    if (periods.join(",") !== "0,1,2") errors.push(`${instrumentId} must have exactly one state for each forecast period.`);
  }
  const nodes = artifact?.definition_basis_graph?.nodes ?? [];
  if (JSON.stringify(nodes) !== JSON.stringify(DEFINITION_NODE_TEMPLATES)) errors.push("definition_basis_graph nodes do not match the exact v1 definition DAG.");
  return errors;
}

export function instrumentPeriodStateByKey(artifact) {
  const errors = validateInstrumentPeriodStateArtifact(artifact);
  if (errors.length > 0) {
    throw new Error(`Invalid instrument-period state: ${errors.join(" | ")}`);
  }
  return new Map(
    artifact.states.map((state) => [
      `${state.instrument_id}\u0000${state.period_index}`,
      state,
    ]),
  );
}

export function mandatoryRepaymentForPeriod(artifact, periodIndex) {
  if (![0, 1, 2].includes(Number(periodIndex))) {
    throw new Error("periodIndex must be 0, 1 or 2.");
  }
  return artifact.states
    .filter(
      (state) =>
        state.period_index === Number(periodIndex) &&
        state.inclusion?.mandatory_repayment === true,
    )
    .reduce(
      (total, state) =>
        total +
        Number(state.scheduled_amortisation.reporting_amount) +
        Number(state.maturity_repayment.reporting_amount),
      0,
    );
}

export function definitionBasisValuesForPeriod(
  artifact,
  periodIndex,
  {
    endingReportingOverrides = {},
    eligibleCash = 0,
    liquidityCash = 0,
    reportedNetDebtAdjustments = 0,
    additionalDebt = 0,
  } = {},
) {
  if (![0, 1, 2].includes(Number(periodIndex))) {
    throw new Error("periodIndex must be 0, 1 or 2.");
  }
  const nodes = artifact?.definition_basis_graph?.nodes ?? [];
  if (JSON.stringify(nodes) !== JSON.stringify(DEFINITION_NODE_TEMPLATES)) {
    throw new Error("definition_basis_graph does not match the exact v1 definition DAG.");
  }
  const overrides = endingReportingOverrides instanceof Map
    ? endingReportingOverrides
    : new Map(Object.entries(endingReportingOverrides));
  const states = artifact.states.filter(
    (state) => state.period_index === Number(periodIndex),
  );
  const ending = (state) =>
    overrides.has(state.instrument_id)
      ? number(overrides.get(state.instrument_id), `${state.instrument_id} ending override`)
      : Number(state.ending_post_repayment.reporting_amount);
  const grossExcludingLeases =
    states
      .filter(
        (state) => state.family !== "lease" && state.inclusion?.gross_debt === true,
      )
      .reduce((total, state) => total + ending(state), 0) +
    Number(additionalDebt);
  const leaseLiabilities = states
    .filter((state) => state.family === "lease")
    .reduce((total, state) => total + ending(state), 0);
  const includeLeaseInGross = states.some(
    (state) => state.family === "lease" && state.inclusion?.gross_debt === true,
  );
  const includeLeaseInNet = states.some(
    (state) => state.family === "lease" && state.inclusion?.net_debt === true,
  );
  const grossIncludingLeases = grossExcludingLeases + leaseLiabilities;
  const modelGrossDebt = includeLeaseInGross
    ? grossIncludingLeases
    : grossExcludingLeases;
  const netDebtExcludingLeases = grossExcludingLeases - Number(eligibleCash);
  const netDebtIncludingLeases = grossIncludingLeases - Number(eligibleCash);
  const modelNetDebt = includeLeaseInNet
    ? netDebtIncludingLeases
    : netDebtExcludingLeases;
  const leverageDebt =
    states
      .filter((state) => state.inclusion?.leverage === true)
      .reduce((total, state) => total + ending(state), 0) +
    Number(additionalDebt);
  const values = {
    gross_debt_instruments_excluding_leases: grossExcludingLeases,
    lease_liabilities: leaseLiabilities,
    model_gross_debt_excluding_leases: grossExcludingLeases,
    model_gross_debt_including_leases: grossIncludingLeases,
    model_gross_debt: modelGrossDebt,
    eligible_cash: Number(eligibleCash),
    liquidity_cash: Number(liquidityCash),
    model_net_debt_excluding_leases: netDebtExcludingLeases,
    model_net_debt_including_leases: netDebtIncludingLeases,
    model_net_debt: modelNetDebt,
    reported_net_debt_adjustments: Number(reportedNetDebtAdjustments),
    reported_net_debt: modelNetDebt + Number(reportedNetDebtAdjustments),
    leverage_debt: leverageDebt,
    leverage_numerator: leverageDebt - Number(eligibleCash),
  };
  for (const node of nodes) {
    if (!Object.hasOwn(values, node.node_id)) {
      throw new Error(`Definition-basis node ${node.node_id} has no runtime value.`);
    }
  }
  return {
    graph_version: artifact.definition_basis_graph.graph_version,
    period_id: artifact.forecast_period_ids[Number(periodIndex)],
    values,
  };
}

export const INSTRUMENT_PERIOD_DEFINITION_NODES = DEFINITION_NODE_TEMPLATES;
