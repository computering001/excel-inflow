const METHODS = new Set([
  "zero",
  "explicit_forecast_assumption",
  "historical_residual_carry",
  "broker_or_guidance",
]);

const series3 = (value) =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((item) => Number.isFinite(Number(item)))
    ? value.map(Number)
    : null;

export function validateResidualInterestAuthority(modelCase) {
  const errors = [];
  const values = series3(modelCase?.other_interest);
  if (!values) {
    return ["other_interest must contain three numeric forecast values."];
  }
  const authority = modelCase?.other_interest_authority;
  const nonZero = values.some((value) => Math.abs(value) > 1e-12);
  if (!authority) {
    if (nonZero) {
      errors.push(
        "Non-zero other_interest requires other_interest_authority; a bare residual series has no forecast authority.",
      );
    }
    return errors;
  }
  if (authority.contract_version !== "residual-interest-authority/1.0") {
    errors.push(
      "other_interest_authority.contract_version must be residual-interest-authority/1.0.",
    );
  }
  if (!METHODS.has(authority.method)) {
    errors.push("other_interest_authority.method is not recognised.");
  }
  if (!String(authority.basis_note ?? "").trim()) {
    errors.push("other_interest_authority.basis_note is required.");
  }
  if (authority.method === "zero" && nonZero) {
    errors.push("A zero residual-interest authority cannot support non-zero other_interest.");
  }
  if (
    authority.method === "broker_or_guidance" &&
    (!Array.isArray(authority.source_ids) || authority.source_ids.length === 0)
  ) {
    errors.push("broker_or_guidance residual interest requires at least one source_id.");
  }
  if (
    authority.method === "historical_residual_carry" &&
    !modelCase?.historical_interest_reconciliation
  ) {
    errors.push(
      "historical_residual_carry requires historical_interest_reconciliation.",
    );
  }
  return errors;
}

export function resolvedResidualInterestAuthority(modelCase) {
  const errors = validateResidualInterestAuthority(modelCase);
  if (errors.length > 0) {
    throw new Error(`Residual interest authority is invalid: ${errors.join(" ")}`);
  }
  const authority = modelCase?.other_interest_authority;
  if (authority) return structuredClone(authority);
  return {
    contract_version: "residual-interest-authority/1.0",
    method: "zero",
    basis_note:
      "No forecast residual interest is assumed; the visible series is zero in every forecast period.",
    source_ids: [],
  };
}

export function residualInterestAuthorityLabel(authority) {
  return {
    zero: "zero",
    explicit_forecast_assumption: "explicit assumption",
    historical_residual_carry: "historical residual carry",
    broker_or_guidance: "broker / guidance",
  }[authority?.method] ?? "invalid authority";
}

export default {
  validateResidualInterestAuthority,
  resolvedResidualInterestAuthority,
  residualInterestAuthorityLabel,
};
