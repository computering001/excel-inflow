function series3(value, label, fallback = null) {
  if (value === undefined && fallback !== null) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((item) => !Number.isFinite(Number(item)))
  ) {
    throw new Error(`${label} must contain three numeric values.`);
  }
  return value.map(Number);
}

export function resolvedLeaseInterestBasis(modelCase) {
  const policy = modelCase?.lease_policy ?? {};
  if (policy.mode === "exclude") return "none";
  if (policy.interest_basis) return policy.interest_basis;
  if (modelCase?.issuer?.accounting_basis === "US_GAAP") {
    throw new Error(
      "US GAAP lease modelling requires lease_policy.interest_basis so operating lease cost is not silently duplicated in interest expense.",
    );
  }
  return "total_liability";
}

export function validateLeasePolicy(modelCase) {
  const errors = [];
  const policy = modelCase?.lease_policy ?? {};
  let basis;
  try {
    basis = resolvedLeaseInterestBasis(modelCase);
  } catch (error) {
    errors.push(error.message);
    return errors;
  }

  if (
    modelCase?.issuer?.accounting_basis === "US_GAAP" &&
    basis === "total_liability" &&
    policy.operating_lease_interest_separately_reclassified !== true
  ) {
    errors.push(
      "US GAAP total-liability lease interest is allowed only when operating_lease_interest_separately_reclassified is true; otherwise use separately_supplied or none.",
    );
  }

  if (basis === "separately_supplied") {
    for (const [key, value] of [
      [
        "historical_interest_bearing_liabilities",
        policy.historical_interest_bearing_liabilities,
      ],
      [
        "forecast_interest_bearing_liabilities",
        policy.forecast_interest_bearing_liabilities,
      ],
    ]) {
      try {
        const values = series3(value, `lease_policy.${key}`);
        if (values.some((item) => item < 0)) {
          errors.push(`lease_policy.${key} cannot contain negative balances.`);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  if (policy.mode === "sourced_balance") {
    try {
      const values = series3(
        policy.forecast_liabilities,
        "lease_policy.forecast_liabilities",
      );
      if (values.some((item) => item < 0)) {
        errors.push(
          "lease_policy.forecast_liabilities cannot contain negative balances.",
        );
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

export function leaseForecast(modelCase) {
  const policy = modelCase.lease_policy;
  const basis = resolvedLeaseInterestBasis(modelCase);
  const historicalTotal = policy.historical_liabilities
    ? series3(
        policy.historical_liabilities,
        "lease_policy.historical_liabilities",
      )
    : [0, 0, Number(policy.opening_liability ?? 0)];
  const principal = series3(
    policy.principal_repayment,
    "lease_policy.principal_repayment",
    [0, 0, 0],
  );
  const additions = series3(
    policy.additions,
    "lease_policy.additions",
    [0, 0, 0],
  );
  const rates = series3(
    policy.effective_rate,
    "lease_policy.effective_rate",
    [0, 0, 0],
  );
  const sourcedTotal =
    policy.mode === "sourced_balance"
      ? series3(
          policy.forecast_liabilities,
          "lease_policy.forecast_liabilities",
        )
      : null;
  const separateHistorical =
    basis === "separately_supplied"
      ? series3(
          policy.historical_interest_bearing_liabilities,
          "lease_policy.historical_interest_bearing_liabilities",
        )
      : historicalTotal;
  const separateForecast =
    basis === "separately_supplied"
      ? series3(
          policy.forecast_interest_bearing_liabilities,
          "lease_policy.forecast_interest_bearing_liabilities",
        )
      : null;

  const periods = [];
  let openingTotal = historicalTotal[2];
  let openingInterestBearing = separateHistorical[2];
  for (let index = 0; index < 3; index += 1) {
    const periodPrincipal =
      policy.mode === "exclude" ? 0 : principal[index];
    const endingTotal =
      policy.mode === "exclude"
        ? 0
        : policy.mode === "sourced_balance"
          ? sourcedTotal[index]
          : Math.max(
              0,
              openingTotal +
                (policy.mode === "flat_replacement"
                  ? periodPrincipal
                  : additions[index]) -
                periodPrincipal,
            );
    const endingInterestBearing =
      basis === "none"
        ? 0
        : basis === "separately_supplied"
          ? separateForecast[index]
          : endingTotal;
    const interest =
      basis === "none"
        ? 0
        : ((openingInterestBearing + endingInterestBearing) / 2) *
          rates[index];
    periods.push({
      opening_total: openingTotal,
      additions:
        policy.mode === "flat_replacement"
          ? periodPrincipal
          : policy.mode === "sourced_balance"
            ? endingTotal - openingTotal + periodPrincipal
            : policy.mode === "exclude"
              ? 0
              : additions[index],
      principal_repayment: periodPrincipal,
      ending_total: endingTotal,
      opening_interest_bearing: openingInterestBearing,
      ending_interest_bearing: endingInterestBearing,
      interest,
      interest_basis: basis,
    });
    openingTotal = endingTotal;
    openingInterestBearing = endingInterestBearing;
  }
  return periods;
}
