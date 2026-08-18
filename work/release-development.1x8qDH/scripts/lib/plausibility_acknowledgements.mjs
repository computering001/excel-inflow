const ANSWER_PREFIX = "plausibility.";

export function plausibilityFindingIds(solution, blockName = "standalone") {
  const findings = [];
  for (const [index, period] of (solution?.forecast ?? []).entries()) {
    const shortfall = Number(period?.liquidity_shortfall ?? 0);
    const endingCash = period?.ending_cash;
    const endingRcf = Number(period?.ending_rcf ?? 0);
    const undrawnRcf = Number(period?.undrawn_rcf ?? 0);
    if (shortfall > 0.5) {
      findings.push(`${blockName}_liquidity_shortfall_period_${index + 1}`);
    }
    if (endingCash !== null && endingCash !== undefined && Number(endingCash) < -0.5) {
      findings.push(`${blockName}_negative_ending_cash_period_${index + 1}`);
    }
    const commitment = endingRcf + undrawnRcf;
    if (commitment > 0.5 && endingRcf / commitment >= 0.95) {
      findings.push(`${blockName}_rcf_near_exhaustion_period_${index + 1}`);
    }
  }
  return findings;
}

export function explicitPlausibilityAcknowledgements(modelCase) {
  const direct = Array.isArray(modelCase?.plausibility_acknowledgements)
    ? modelCase.plausibility_acknowledgements
    : [];
  const settledAnswers = Object.entries(modelCase?.stage_three_answers ?? {})
    .filter(([key, value]) => key.startsWith(ANSWER_PREFIX) && value === "acknowledged")
    .map(([key]) => key.slice(ANSWER_PREFIX.length))
    .filter(Boolean);
  return [...new Set([...direct, ...settledAnswers])].sort();
}

export function acknowledgeSyntheticLiquidityStress(modelCase, solution) {
  modelCase.stage_three_answers ??= {};
  const standalone = plausibilityFindingIds(solution, "standalone");
  const proForma = plausibilityFindingIds(solution, "pro_forma");
  for (const finding of [...standalone, ...proForma]) {
    modelCase.stage_three_answers[`${ANSWER_PREFIX}${finding}`] = "acknowledged";
  }
  return [...standalone, ...proForma];
}
