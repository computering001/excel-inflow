/**
 * Populate the optional acquisition module with a coherent illustrative case.
 *
 * A debt-overlay workbook always exposes the adjustment/pro-forma block so the
 * reader can test it.  Leaving the transaction controls blank while the switch
 * is off makes that test impossible and turns an ordinary toggle-on into a set
 * of formula errors.  This policy fills only an OFF case; an enabled transaction
 * must remain explicit and will still fail the ordinary shape/coverage gates if
 * an input is absent.
 *
 * Values are scale-derived, not issuer-specific: target EBITDA is ten per cent
 * of the first usable forecast EBITDA, rounded to two significant figures; EV
 * is 10.0x that amount and acquisition debt is 50% of EV.  The illustrative
 * close is the middle forecast year at mid-year and the debt rate is 5.0%.
 */

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function firstPositive(values) {
  for (const value of values ?? []) {
    const number = positive(value);
    if (number !== null) return number;
  }
  return null;
}

function twoSignificantFigures(value) {
  const number = positive(value);
  if (number === null) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(number));
  return Math.max(1, Math.round((number / magnitude) * 10) / 10 * magnitude);
}

function forecastEbitda(modelCase) {
  return (
    firstPositive(
      modelCase.operating_metrics?.adjusted_ebitda?.values?.slice(3),
    ) ??
    firstPositive(
      modelCase.broker_pack?.metrics?.adjusted_ebitda?.provider_consensus,
    ) ??
    firstPositive(
      modelCase.operating_metrics?.ebitda?.values?.slice(3),
    ) ??
    firstPositive(modelCase.broker_pack?.metrics?.ebitda?.provider_consensus) ??
    null
  );
}

function forecastYears(modelCase) {
  return (modelCase.periods ?? [])
    .filter((period) => period.status === "forecast")
    .map((period) => new Date(period.date).getUTCFullYear())
    .filter(Number.isFinite);
}

export function ensureIllustrativeAcquisitionCase(modelCase) {
  if (Number(modelCase?.contract_version) !== 2) return modelCase;
  modelCase.modules ??= {};
  modelCase.modules.acquisition = true;
  const acquisition = { ...(modelCase.acquisition ?? {}) };
  // Never invent inputs for a live transaction.  The normal validation path
  // must surface any missing enabled-case fact to the user.
  if (Number(acquisition.enabled) === 1) {
    modelCase.acquisition = acquisition;
    return modelCase;
  }

  const targetEbitda = twoSignificantFigures(
    (forecastEbitda(modelCase) ?? 100) * 0.1,
  );
  const entryMultiple = positive(acquisition.entry_ev_to_ebitda) ?? 10;
  const enterpriseValue =
    positive(acquisition.transaction_enterprise_value) ??
    targetEbitda * entryMultiple;
  const years = forecastYears(modelCase);
  const closeYear = Number(acquisition.close_year);

  modelCase.acquisition = {
    enabled: 0,
    transaction_enterprise_value: enterpriseValue,
    entry_ev_to_ebitda: entryMultiple,
    acquisition_debt_amount:
      positive(acquisition.acquisition_debt_amount) ?? enterpriseValue * 0.5,
    incremental_rate:
      positive(acquisition.incremental_rate) ?? 0.05,
    close_year:
      Number.isInteger(closeYear) && years.includes(closeYear)
        ? closeYear
        : years[Math.min(1, Math.max(0, years.length - 1))] ??
          new Date().getUTCFullYear() + 1,
    close_month:
      Number.isInteger(Number(acquisition.close_month)) &&
      Number(acquisition.close_month) >= 1 &&
      Number(acquisition.close_month) <= 12
        ? Number(acquisition.close_month)
        : 6,
  };
  return modelCase;
}

