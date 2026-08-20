import { compileBrokerConsensusMetric } from "./broker_consensus.mjs";

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
 * Values are scale-derived, not issuer-specific: target EBITDA is one per cent
 * of the first usable forecast EBITDA, rounded to two significant figures; EV
 * is 10.0x that amount and acquisition debt is 50% of EV.  The illustrative
 * close is the first forecast year at mid-year and the debt rate is 5.0%.
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
  const modelConsensus = (metricId) =>
    compileBrokerConsensusMetric(modelCase, metricId)?.periods.map(
      (period) => period.model_consensus,
    );
  return (
    firstPositive(
      modelCase.operating_metrics?.adjusted_ebitda?.values?.slice(3),
    ) ??
    firstPositive(
      modelConsensus("adjusted_ebitda"),
    ) ??
    firstPositive(
      modelCase.operating_metrics?.ebitda?.values?.slice(3),
    ) ??
    firstPositive(modelConsensus("ebitda")) ??
    null
  );
}

function forecastYears(modelCase) {
  return (modelCase.periods ?? [])
    .filter((period) => period.status === "forecast")
    .map((period) => new Date(period.date).getUTCFullYear())
    .filter(Number.isFinite);
}

export const ACQUISITION_VALUATION_AUTHORITY =
  "transaction_enterprise_value_and_entry_ev_to_ebitda/1.0";

const FORBIDDEN_TARGET_EBITDA_INPUTS = Object.freeze([
  "target_ebitda",
  "target_adjusted_ebitda",
  "target_ebitda_input",
]);

/**
 * The canonical overlay has exactly two valuation inputs. Target EBITDA is an
 * answer, never a third editable assumption. Keeping this contract in one
 * module prevents the solver, renderer and intake validation from developing
 * separate definitions of the same transaction value.
 */
export function acquisitionValuationErrors(modelCase) {
  const errors = [];
  const acquisition = modelCase?.acquisition;
  if (!acquisition || typeof acquisition !== "object") return errors;
  const isV2 = Number(modelCase?.contract_version) === 2;

  for (const field of FORBIDDEN_TARGET_EBITDA_INPUTS) {
    if (Object.hasOwn(acquisition, field)) {
      errors.push(
        `acquisition.${field} is forbidden: target EBITDA must be derived from transaction_enterprise_value / entry_ev_to_ebitda.`,
      );
    }
  }

  if (Number(acquisition.enabled ?? 0) === 1) {
    if (
      isV2 &&
      !(Number(acquisition.transaction_enterprise_value) > 0)
    ) {
      errors.push(
        "Enabled acquisition needs transaction_enterprise_value greater than zero.",
      );
    }
    if (!(Number(acquisition.entry_ev_to_ebitda) > 0)) {
      errors.push(
        "Enabled acquisition needs entry_ev_to_ebitda greater than zero.",
      );
    }
    if (!/^[A-Z]{3}$/.test(String(modelCase?.issuer?.reporting_currency ?? ""))) {
      errors.push(
        "Enabled acquisition needs issuer.reporting_currency so transaction amounts have an explicit currency.",
      );
    }
    if (!new Set(["units", "thousands", "millions"]).has(modelCase?.issuer?.units)) {
      errors.push(
        "Enabled acquisition needs issuer.units so transaction amounts have an explicit scale.",
      );
    }
  }
  return errors;
}

export function acquisitionValuation(modelCase) {
  const acquisition = modelCase?.acquisition ?? {};
  const enterpriseValue = Number(acquisition.transaction_enterprise_value);
  const entryMultiple = Number(acquisition.entry_ev_to_ebitda);
  return Object.freeze({
    authority: ACQUISITION_VALUATION_AUTHORITY,
    transaction_enterprise_value: enterpriseValue,
    entry_ev_to_ebitda: entryMultiple,
    target_ebitda:
      enterpriseValue > 0 && entryMultiple > 0
        ? enterpriseValue / entryMultiple
        : 0,
    reporting_currency: String(modelCase?.issuer?.reporting_currency ?? ""),
    units: String(modelCase?.issuer?.units ?? ""),
  });
}

export function acquisitionAmountLabel(modelCase, label) {
  const valuation = acquisitionValuation(modelCase);
  return `${label} (${valuation.reporting_currency}, ${valuation.units})`;
}

export function acquisitionTargetEbitdaFormula(
  enterpriseValueCell,
  entryMultipleCell,
) {
  // Invalid valuation inputs must remain visible spreadsheet errors.  The case
  // gate and face validations stop non-positive entries before build/use; an
  // IFERROR fallback here would turn a corrupted denominator into fake zero
  // EBITDA and let every downstream acquisition formula continue apparently
  // clean.
  return `=${enterpriseValueCell}/${entryMultipleCell}`;
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
    (forecastEbitda(modelCase) ?? 100) * 0.01,
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
        : years[0] ??
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


export const ACQUISITION_TRANSACTION_MODE = "funded_transaction";

function finiteAcquisitionValue(value, fallback = 0) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
}
function acquisitionInput(modelCase, names, fallback = null) {
  const roots = [modelCase?.acquisition, modelCase?.acquisition_case, modelCase?.acquisition_overlay, modelCase?.transaction, modelCase?.controls, modelCase?.assumptions];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const name of names) if (root[name] !== undefined && root[name] !== null) return root[name];
    for (const value of Object.values(root)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const name of names) if (value[name] !== undefined && value[name] !== null) return value[name];
    }
  }
  return fallback;
}
export function acquisitionTransactionFlows(modelCase, forecastIndex) {
  const periods = (modelCase?.periods ?? []).filter((period) => period?.status === "forecast");
  const period = periods[forecastIndex];
  const closeYear = Number(acquisitionInput(modelCase, ["close_year", "acquisition_close_year"], 0));
  const periodYear = Number(String(period?.date ?? period?.label ?? "").slice(0, 4));
  const enabledRaw = acquisitionInput(modelCase, ["enabled", "adjustment_columns_on", "acquisition_on", "acquisition_case"], false);
  const enabled = enabledRaw === true || enabledRaw === 1 || String(enabledRaw).toLowerCase() === "on";
  const atClose = enabled && periodYear === closeYear;
  const consideration = atClose ? finiteAcquisitionValue(acquisitionInput(modelCase, ["transaction_enterprise_value", "transaction_value", "enterprise_value"], 0)) : 0;
  const debtProceeds = atClose ? finiteAcquisitionValue(acquisitionInput(modelCase, ["acquisition_debt_amount", "acquisition_debt", "debt_amount"], 0)) : 0;
  return {
    schema_version: "funded-acquisition-transaction/1.0",
    mode: ACQUISITION_TRANSACTION_MODE,
    forecast_index: forecastIndex,
    at_close: atClose,
    consideration_cash_flow: -Math.abs(consideration),
    acquisition_debt_proceeds: Math.abs(debtProceeds),
    direct_transaction_cash_flow: -Math.abs(consideration),
    net_direct_cash_flow: -Math.abs(consideration) + Math.abs(debtProceeds),
    residual_cash_or_rcf_funding: Math.max(0, Math.abs(consideration) - Math.abs(debtProceeds)),
  };
}
