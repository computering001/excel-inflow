export function balancingRcfMode(modelCase) {
  const policy = modelCase?.rcf_policy;
  if (policy?.mode === "none") return "none";
  return policy?.mode === "balancing_rcf" || policy?.instrument_id
    ? "balancing_rcf"
    : "none";
}

export function hasBalancingRcf(modelCase) {
  return balancingRcfMode(modelCase) === "balancing_rcf";
}

export function balancingRcfId(modelCase) {
  return hasBalancingRcf(modelCase)
    ? modelCase?.rcf_policy?.instrument_id ?? null
    : null;
}

export function isBalancingRcf(modelCase, instrument) {
  return Boolean(
    instrument &&
      instrument.instrument_id === balancingRcfId(modelCase) &&
      instrument.class === "rcf",
  );
}

export function balancingRcfInstrument(modelCase) {
  const id = balancingRcfId(modelCase);
  return (modelCase?.instruments ?? []).find(
    (instrument) => instrument.instrument_id === id,
  );
}

export function validateBalancingRcf(modelCase) {
  const errors = [];
  const policy = modelCase?.rcf_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["rcf_policy must explicitly declare a balancing_rcf or none mode."];
  }
  if (balancingRcfMode(modelCase) === "none") {
    if (policy.instrument_id !== undefined) {
      errors.push("rcf_policy.instrument_id must be absent when mode is none.");
    }
    for (const key of ["capacity", "opening_draw", "commitment_fee_value"]) {
      if (Number(policy[key] ?? 0) !== 0) {
        errors.push(`rcf_policy.${key} must be zero when mode is none.`);
      }
    }
    if ((policy.commitment_fee_convention ?? "none") !== "none") {
      errors.push(
        "rcf_policy.commitment_fee_convention must be none when mode is none.",
      );
    }
    return errors;
  }
  const id = balancingRcfId(modelCase);
  if (!id) {
    return ["rcf_policy.instrument_id must name the balancing liquidity facility."];
  }
  const matches = (modelCase?.instruments ?? []).filter(
    (instrument) => instrument.instrument_id === id,
  );
  if (matches.length !== 1) {
    errors.push(
      `rcf_policy.instrument_id must match exactly one instrument; ${id} matched ${matches.length}.`,
    );
    return errors;
  }
  if (matches[0].class !== "rcf") {
    errors.push(
      `rcf_policy.instrument_id ${id} must identify an instrument whose class is rcf.`,
    );
  }
  return errors;
}
