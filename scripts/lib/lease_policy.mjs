/** P2.7: this module's family in assets/policy-registry-v1.json. The suite
 * (run_policy_registry_tests.mjs) holds these equal to the registry entry. */
export const LEASE_POLICY_ID = "lease_policy";
export const LEASE_POLICY_VERSION = "1.0";

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

/** D1/D2 (mp2-D): the lease opening liability as a TYPED state, replacing the
 * bare `[0, 0, Number(policy.opening_liability ?? 0)]` coercion. Exactly one
 * of three states, mirroring the schedule-typed-states vocabulary:
 *   declared   — the policy states historical_liabilities or
 *                opening_liability; value is the finite opening total it
 *                asserts (a non-finite declaration is refused, not coerced);
 *   carried    — the policy declares no lease liability anywhere, so the
 *                zero is a structural carried-forward absence (nothing to
 *                carry), never a blank silently mapped onto zero;
 *   unresolved — unreachable here (declared-but-non-finite throws), kept in
 *                the vocabulary so callers can exhaustive-match.
 */
export function leaseOpeningLiabilityState(policy = {}) {
  if (policy.historical_liabilities) {
    const series = series3(
      policy.historical_liabilities,
      "lease_policy.historical_liabilities",
    );
    return { state: "declared", value: series[2] };
  }
  if (policy.opening_liability !== undefined) {
    const value = Number(policy.opening_liability);
    if (!Number.isFinite(value)) {
      throw new Error(
        `lease_policy.opening_liability must be a finite number; received ${JSON.stringify(policy.opening_liability)}. Blank/nil never coerce to zero — declare the liability or omit the field.`,
      );
    }
    return { state: "declared", value };
  }
  return { state: "carried", value: 0 };
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
  if (errors.length === 0) {
    try {
      errors.push(...leaseProjectionErrors(modelCase));
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

export function leaseForecast(modelCase) {
  const policy = modelCase.lease_policy;
  const basis = resolvedLeaseInterestBasis(modelCase);
  const interestEnabled = modelCase?.controls?.circularity !== 0;
  // mp2-D typed state: declared | carried — see leaseOpeningLiabilityState.
  const openingLiability = leaseOpeningLiabilityState(policy);
  const historicalTotal = policy.historical_liabilities
    ? series3(
        policy.historical_liabilities,
        "lease_policy.historical_liabilities",
      )
    : [0, 0, openingLiability.value];
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
  const otherMovements = series3(
    policy.other_movements,
    "lease_policy.other_movements",
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
    let endingTotal;
    let endingInterestBearing;
    let interest;
    let periodAdditions;
    if (policy.mode === "exclude") {
      endingTotal = 0; endingInterestBearing = 0; interest = 0; periodAdditions = 0;
    } else if (policy.mode === "sourced_balance") {
      endingTotal = sourcedTotal[index];
      endingInterestBearing = basis === "none" ? 0 : basis === "separately_supplied" ? separateForecast[index] : endingTotal;
      interest = basis === "none" || !interestEnabled ? 0 : ((openingInterestBearing + endingInterestBearing) / 2) * rates[index];
      periodAdditions = endingTotal - openingTotal - interest - otherMovements[index] + periodPrincipal;
    } else if (policy.mode === "flat_replacement") {
      endingTotal = openingTotal;
      endingInterestBearing = basis === "none" ? 0 : basis === "separately_supplied" ? separateForecast[index] : endingTotal;
      interest = basis === "none" || !interestEnabled ? 0 : ((openingInterestBearing + endingInterestBearing) / 2) * rates[index];
      periodAdditions = periodPrincipal - interest - otherMovements[index];
    } else if (basis === "total_liability") {
      const preInterestClosing = openingTotal + additions[index] + otherMovements[index] - periodPrincipal;
      const activeRate = interestEnabled ? rates[index] : 0;
      const denominator = 1 - activeRate / 2;
      if (!(denominator > 0)) throw new Error("lease effective rate must remain below 200%");
      endingTotal = Math.max(0, (preInterestClosing + openingInterestBearing * activeRate / 2) / denominator);
      endingInterestBearing = endingTotal;
      interest = ((openingInterestBearing + endingInterestBearing) / 2) * activeRate;
      periodAdditions = additions[index];
    } else {
      endingInterestBearing = basis === "none" ? 0 : separateForecast[index];
      interest = basis === "none" || !interestEnabled ? 0 : ((openingInterestBearing + endingInterestBearing) / 2) * rates[index];
      periodAdditions = additions[index];
      endingTotal = Math.max(0, openingTotal + periodAdditions + interest + otherMovements[index] - periodPrincipal);
    }
    periods.push({
      opening_total: openingTotal,
      additions: periodAdditions,
      other_movements: policy.mode === "exclude" ? 0 : otherMovements[index],
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

/**
 * Independently verify the typed lease schedule rather than trusting the
 * producer that assembled it. A supplied projection makes this a mutation
 * oracle in tests and in any downstream package validator.
 */
export function leaseProjectionErrors(
  modelCase,
  projection = leaseForecast(modelCase),
) {
  const policy = modelCase?.lease_policy ?? {};
  const basis = resolvedLeaseInterestBasis(modelCase);
  const interestEnabled = modelCase?.controls?.circularity !== 0;
  const rates = series3(
    policy.effective_rate,
    "lease_policy.effective_rate",
    [0, 0, 0],
  );
  // mp2-D typed state: declared | carried — see leaseOpeningLiabilityState.
  const openingLiability = leaseOpeningLiabilityState(policy);
  const historicalTotal = policy.historical_liabilities
    ? series3(
        policy.historical_liabilities,
        "lease_policy.historical_liabilities",
      )
    : [0, 0, openingLiability.value];
  const historicalInterestBearing =
    basis === "separately_supplied"
      ? series3(
          policy.historical_interest_bearing_liabilities,
          "lease_policy.historical_interest_bearing_liabilities",
        )
      : historicalTotal;
  const errors = [];
  const tolerance = 1e-8;
  const near = (left, right) =>
    Math.abs(Number(left) - Number(right)) <= tolerance;

  if (!Array.isArray(projection) || projection.length !== 3) {
    return ["lease projection must contain exactly three forecast periods."];
  }

  let expectedOpeningTotal = historicalTotal[2];
  let expectedOpeningInterestBearing = historicalInterestBearing[2];
  for (let index = 0; index < 3; index += 1) {
    const period = projection[index] ?? {};
    const prefix = `lease projection period ${index + 1}`;
    for (const field of [
      "opening_total",
      "additions",
      "other_movements",
      "principal_repayment",
      "ending_total",
      "opening_interest_bearing",
      "ending_interest_bearing",
      "interest",
    ]) {
      if (!Number.isFinite(Number(period[field]))) {
        errors.push(`${prefix} ${field} must be numeric.`);
      }
    }
    if (errors.some((message) => message.startsWith(prefix))) continue;

    if (!near(period.opening_total, expectedOpeningTotal)) {
      errors.push(`${prefix} opening total does not equal the prior closing liability.`);
    }
    if (!near(period.opening_interest_bearing, expectedOpeningInterestBearing)) {
      errors.push(`${prefix} interest-bearing opening does not equal the prior closing basis.`);
    }

    if (policy.mode === "exclude") {
      for (const field of [
        "additions",
        "other_movements",
        "principal_repayment",
        "ending_total",
        "ending_interest_bearing",
        "interest",
      ]) {
        if (!near(period[field], 0)) {
          errors.push(`${prefix} ${field} must be zero when leases are excluded.`);
        }
      }
    } else {
      const expectedEnding =
        Number(period.opening_total) +
        Number(period.additions) +
        Number(period.interest) +
        Number(period.other_movements) -
        Number(period.principal_repayment);
      if (!near(period.ending_total, expectedEnding)) {
        errors.push(
          `${prefix} closing liability does not equal opening + additions + interest + other movements - principal.`,
        );
      }
      const expectedEndingInterestBearing =
        basis === "none"
          ? 0
          : basis === "separately_supplied"
            ? Number(policy.forecast_interest_bearing_liabilities[index])
            : Number(period.ending_total);
      if (!near(period.ending_interest_bearing, expectedEndingInterestBearing)) {
        errors.push(`${prefix} closing interest-bearing basis is inconsistent with ${basis}.`);
      }
      const expectedInterest =
        basis === "none" || !interestEnabled
          ? 0
          : ((Number(period.opening_interest_bearing) +
              Number(period.ending_interest_bearing)) /
              2) *
            rates[index];
      if (!near(period.interest, expectedInterest)) {
        errors.push(`${prefix} interest does not equal average interest-bearing liability times effective rate.`);
      }
    }

    expectedOpeningTotal = Number(period.ending_total);
    expectedOpeningInterestBearing = Number(period.ending_interest_bearing);
  }
  return errors;
}

// B3 — the CASH/ACCRETED interest split. Accreted lease interest raises the
// lease liability and is settled through the principal waterfall, so it must
// NOT also leave as `cash_interest_paid`; paying it twice hits net debt twice
// per period. This validator independently recomputes the published cash
// interest from the gross build-up and refuses any drift. Sign convention: the
// solver publishes `cash_interest_paid` as a NEGATIVE outflow, hence the
// negated right-hand side.
export function leaseInterestCashSplitErrors(
  {
    cash_interest_paid: cashInterestPaid,
    gross_interest: grossInterest,
    lease_interest: leaseInterest,
    non_cash_interest: nonCashInterest,
    non_cash_instrument_interest: nonCashInstrumentInterest,
  } = {},
  tolerance = 1e-8,
) {
  if (
    cashInterestPaid === null ||
    cashInterestPaid === undefined ||
    !Number.isFinite(Number(cashInterestPaid))
  ) {
    // Nothing was published under this role (supplied-absent or unresolvable):
    // there is no split claim to verify.
    return [];
  }
  // mp2-D typed leg resolution: a leg the producer never published (null,
  // undefined, or not a finite number) is UNRESOLVED — never zero. Verifying
  // the identity against fabricated zeros would both mint a drift claim built
  // on numbers nobody asserted and, when the fabricated identity happens to
  // match a published zero outflow, let the split PASS vacuously. An
  // unresolved leg while cash_interest_paid is published therefore refuses
  // with the named legs instead of computing.
  const legs = [
    ["gross_interest", grossInterest],
    ["lease_interest", leaseInterest],
    ["non_cash_interest", nonCashInterest],
    ["non_cash_instrument_interest", nonCashInstrumentInterest],
  ];
  const unresolvedLegs = legs
    .filter(
      ([, raw]) =>
        raw === null || raw === undefined || !Number.isFinite(Number(raw)),
    )
    .map(([name]) => name);
  if (unresolvedLegs.length > 0) {
    return [
      `cash_interest_paid=${Number(cashInterestPaid)} is published but the ` +
        `cash-interest split cannot be verified: ${unresolvedLegs.join(", ")} ` +
        `unresolved (blank/nil/missing never coerce to zero). Publish every ` +
        `leg of the gross build-up to verify the split.`,
    ];
  }
  const [grossDeclared, leaseDeclared, nonCashDeclared, nonCashInstrumentDeclared] =
    legs.map(([, raw]) => Number(raw));
  const expected =
    -(grossDeclared -
      leaseDeclared -
      nonCashDeclared -
      nonCashInstrumentDeclared);
  const errors = [];
  if (Math.abs(Number(cashInterestPaid) - expected) > tolerance) {
    errors.push(
      `cash_interest_paid=${Number(cashInterestPaid)} does not equal ` +
        `-(gross interest ${grossDeclared} - lease interest ` +
        `${leaseDeclared} - non-cash interest ` +
        `${nonCashDeclared} - non-cash instrument interest ` +
        `${nonCashInstrumentDeclared}) = ${expected}; the accreted ` +
        `lease share must stay out of cash interest paid.`,
    );
  }
  return errors;
}
