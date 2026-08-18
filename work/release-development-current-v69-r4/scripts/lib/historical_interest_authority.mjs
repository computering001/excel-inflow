export const HISTORICAL_INTEREST_BASES = Object.freeze({
  FILED_TOTAL_INCLUDING_LEASES:
    "filed_finance_expense_including_lease_interest",
  REPORTED_DEBT_EXCLUDING_LEASES:
    "reported_debt_interest_excluding_separately_disclosed_lease_interest",
  IDENTIFIED_COMPONENTS_ONLY: "identified_components_only",
});

const LEGACY_BASIS = HISTORICAL_INTEREST_BASES.FILED_TOTAL_INCLUDING_LEASES;

function series3(value) {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => Number.isFinite(Number(item)));
}

function magnitudes(value) {
  return value.map((item) => Math.abs(Number(item)));
}

/**
 * Resolve the historical interest evidence into one unambiguous economic
 * authority.  All returned amounts are positive magnitudes; workbook sign
 * conversion remains the renderer's responsibility.
 *
 * Backwards compatibility is deliberate: a legacy case without an explicit
 * basis retains the schema's original meaning that `reported_interest` and
 * `identified_interest` both include separately presented lease interest.
 * A case whose reported series excludes lease interest must say so.
 */
export function resolveHistoricalInterestAuthority(modelCase) {
  const reconciliation = modelCase?.historical_interest_reconciliation;
  if (!reconciliation) {
    return {
      present: false,
      valid: true,
      errors: [],
      basis: null,
      basis_was_explicit: false,
      has_filed_total: false,
      reported_interest: null,
      identified_interest: null,
      lease_interest: [0, 0, 0],
      filed_finance_expense: null,
      reported_debt_interest: null,
      identified_finance_components: null,
      identified_debt_components: null,
      unallocated_interest: null,
    };
  }

  const errors = [];
  const basis = reconciliation.reported_interest_basis ?? LEGACY_BASIS;
  const allowed = new Set(Object.values(HISTORICAL_INTEREST_BASES));
  if (!allowed.has(basis)) {
    errors.push(`historical_interest_reconciliation.reported_interest_basis is invalid: ${basis}.`);
  }

  const reported = series3(reconciliation.reported_interest)
    ? magnitudes(reconciliation.reported_interest)
    : null;
  const identified = series3(reconciliation.identified_interest)
    ? magnitudes(reconciliation.identified_interest)
    : null;
  const lease = series3(modelCase?.historical_supplement?.lease_interest_expense)
    ? magnitudes(modelCase.historical_supplement.lease_interest_expense)
    : [0, 0, 0];

  if (!identified) {
    errors.push(
      "historical_interest_reconciliation.identified_interest must contain three finite values.",
    );
  }
  if (basis === HISTORICAL_INTEREST_BASES.IDENTIFIED_COMPONENTS_ONLY) {
    if (reported !== null) {
      errors.push(
        "historical_interest_reconciliation.reported_interest must be omitted when reported_interest_basis is identified_components_only.",
      );
    }
  } else if (!reported) {
    errors.push(
      "historical_interest_reconciliation.reported_interest must contain three finite values for a reported-total basis.",
    );
  }

  if (errors.length > 0 || !identified || !allowed.has(basis)) {
    return {
      present: true,
      valid: false,
      errors,
      basis,
      basis_was_explicit:
        typeof reconciliation.reported_interest_basis === "string",
      has_filed_total: false,
      reported_interest: reported,
      identified_interest: identified,
      lease_interest: lease,
      filed_finance_expense: null,
      reported_debt_interest: null,
      identified_finance_components: null,
      identified_debt_components: null,
      unallocated_interest: null,
    };
  }

  let filedFinanceExpense = null;
  let reportedDebtInterest = null;
  let identifiedFinanceComponents = identified;
  let identifiedDebtComponents = null;

  if (basis === HISTORICAL_INTEREST_BASES.FILED_TOTAL_INCLUDING_LEASES) {
    filedFinanceExpense = reported;
    reportedDebtInterest = reported.map((value, index) => value - lease[index]);
    identifiedDebtComponents = identified.map(
      (value, index) => value - lease[index],
    );
  } else if (
    basis === HISTORICAL_INTEREST_BASES.REPORTED_DEBT_EXCLUDING_LEASES
  ) {
    reportedDebtInterest = reported;
    filedFinanceExpense = reported.map((value, index) => value + lease[index]);
    identifiedDebtComponents = identified;
    identifiedFinanceComponents = identified.map(
      (value, index) => value + lease[index],
    );
  } else {
    identifiedDebtComponents = identified.map(
      (value, index) => value - lease[index],
    );
  }

  for (let index = 0; index < 3; index += 1) {
    if (Number(identifiedDebtComponents[index]) < -1e-12) {
      errors.push(
        `Historical interest period ${index + 1} identifies less finance expense than the separately disclosed lease-interest component.`,
      );
    }
    if (
      reportedDebtInterest &&
      Number(reportedDebtInterest[index]) < -1e-12
    ) {
      errors.push(
        `Historical interest period ${index + 1} reports total finance expense below separately disclosed lease interest.`,
      );
    }
  }

  const unallocatedInterest = filedFinanceExpense
    ? filedFinanceExpense.map(
        (value, index) => value - identifiedFinanceComponents[index],
      )
    : [0, 0, 0];

  return {
    present: true,
    valid: errors.length === 0,
    errors,
    basis,
    basis_was_explicit:
      typeof reconciliation.reported_interest_basis === "string",
    has_filed_total: filedFinanceExpense !== null,
    reported_interest: reported,
    identified_interest: identified,
    lease_interest: lease,
    filed_finance_expense: filedFinanceExpense,
    reported_debt_interest: reportedDebtInterest,
    identified_finance_components: identifiedFinanceComponents,
    identified_debt_components: identifiedDebtComponents.map((value) =>
      Math.max(0, value),
    ),
    unallocated_interest: unallocatedInterest,
  };
}

export function historicalInterestBasisLabel(authority) {
  if (!authority?.present) return null;
  if (
    authority.basis === HISTORICAL_INTEREST_BASES.IDENTIFIED_COMPONENTS_ONLY
  ) {
    return "Finance expense from identified components";
  }
  if (
    authority.basis ===
    HISTORICAL_INTEREST_BASES.REPORTED_DEBT_EXCLUDING_LEASES
  ) {
    return "Filed debt interest plus separately disclosed lease interest";
  }
  return "Filed finance expense (statement authority)";
}
