export function balancingRcfId(modelCase) {
  return modelCase?.rcf_policy?.instrument_id ?? null;
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
