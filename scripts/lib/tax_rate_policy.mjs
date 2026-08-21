/**
 * Effective tax rate role policy — the dedicated completion owner for the one
 * driver the candidate compiler deliberately refuses to derive from its own
 * historical identity.
 *
 * The refusal is correct: ETR forecast-as-identity creates the circular pair
 * `tax = PBT × rate` and `rate = tax ÷ PBT`. But blocking the identity
 * creates a completeness OBLIGATION — once the historical ratio may not
 * become the forecast formula, something else must guarantee a lawful
 * forecast authority, or an ordinary supported company terminates at Build
 * with "effective tax rate unresolved" (the exact live failure this module
 * repairs).
 *
 * Position in the waterfall: guidance, broker and user authorities all
 * OUTRANK this policy (they enter the ordinary candidate set and win on
 * method priority). This module owns the rungs below them:
 *
 *   4. median of usable normalized historical ETRs (>= 2 usable periods)
 *   5. latest usable normalized historical ETR   (exactly 1 usable period)
 *   6. explicit loss-case treatment               (documented, never silent 0%)
 *
 * Normalization computes the rate from the FILED tax-expense and PBT rows
 * directly — never from the derived display row, whose values may be null
 * when the ratio row is recreated after topology normalization (the
 * materialisation seam behind the live blocker).
 *
 * Sign convention: the emitted `tax` operator is `PBT > 0 ? -(PBT × rate) : 0`,
 * so a usable rate is a positive fraction. Filed tax expense is normally
 * negative against positive PBT (rate = -tax ÷ PBT); an issuer that files the
 * expense positive is normalized with the convention recorded. Loss periods
 * are classified, recorded, and excluded from rate inference — the model's
 * own loss rule (zero current tax on negative PBT) is the declared loss-case
 * policy, and it is disclosed on the candidate rather than silently applied.
 */

export const TAX_RATE_POLICY_SCHEMA = "excel-inflow-tax-rate-policy/1.0";

/**
 * The policy's OPERATOR VOCABULARY — declared here, once, and consumed by
 * membership everywhere.
 *
 * P3.3: these three names used to be recognised downstream by
 * `operator.startsWith("tax_rate_policy")`. A prefix test is not a
 * declaration: it silently admits any future string that happens to start the
 * same way, it cannot be enumerated, and no validator can prove the set is
 * closed. Every consumer now asks this module whether an operator IS one of
 * its operators, and `formula_dsl.mjs` registers exactly these three names in
 * the declared formula operator vocabulary.
 *
 * The strings themselves are unchanged — the emitted `formula_spec.operator`
 * values below are byte-identical to the ones the prefix test matched.
 */
export const TAX_RATE_POLICY_OPERATORS = Object.freeze({
  median: "tax_rate_policy_median",
  latest: "tax_rate_policy_latest",
  loss_case: "tax_rate_policy_loss_case",
});

/** The closed, ordered list of the policy's operators. */
export const TAX_RATE_POLICY_OPERATOR_LIST = Object.freeze([
  TAX_RATE_POLICY_OPERATORS.median,
  TAX_RATE_POLICY_OPERATORS.latest,
  TAX_RATE_POLICY_OPERATORS.loss_case,
]);

/**
 * The semantic role each operator forecasts. The rate row is the only role
 * this policy owns; declaring it lets the equation-graph proof bind the
 * operator vocabulary to the graph node that carries the rate.
 */
export const TAX_RATE_POLICY_OWNED_ROLE = "effective_tax_rate";

/**
 * Membership, not prefix. `false` for every non-string and for any string —
 * including one that begins "tax_rate_policy" — that is not one of the three
 * declared operators.
 */
export function isTaxRatePolicyOperator(operator) {
  return typeof operator === "string"
    && TAX_RATE_POLICY_OPERATOR_LIST.includes(operator);
}

/** |PBT| below this fraction of the largest observed |PBT| is "near zero":
 * the ratio is arithmetic noise, not an economic rate. */
const NEAR_ZERO_PBT_FRACTION = 0.02;

/** A normal usable rate is a positive fraction with a defensible ceiling.
 * Above this the period is distorted (one-off settlements, valuation
 * allowances) and must be excluded rather than averaged in. */
const MAX_USABLE_RATE = 0.6;

function findRow(modelCase, predicate) {
  return [
    ...(modelCase?.statement_structure?.income_statement ?? []),
    ...(modelCase?.statement_structure?.cash_flow ?? []),
  ].find(predicate) ?? null;
}

function historicalNumbers(row) {
  return [0, 1, 2].map((index) => {
    const value = row?.values?.[index];
    return value === null || value === undefined || !Number.isFinite(Number(value))
      ? null
      : Number(value);
  });
}

/**
 * Evaluate a row's historical value through its accounting calculation when
 * the filed cell is empty — the exact seam behind the live blocker: a
 * recreated or derived row whose values were never materialised. The `tax`
 * operator is deliberately NOT evaluated (it references the effective tax
 * rate itself; following it would recreate the circularity this policy
 * exists to break).
 */
function evaluatedHistorical(rowsById, rowId, period, seen = new Set()) {
  if (seen.has(rowId)) return null;
  seen.add(rowId);
  const row = rowsById.get(rowId);
  if (!row) return null;
  const raw = row.values?.[period];
  if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) return Number(raw);
  const operator = row.calculation?.operator;
  const refs = row.calculation?.refs ?? [];
  if (!operator || operator === "tax" || refs.length === 0) return null;
  const parts = refs.map((ref) => evaluatedHistorical(rowsById, ref, period, seen));
  if (parts.every((value) => value === null)) return null;
  const numbers = parts.map((value) => Number(value ?? 0));
  switch (operator) {
    case "sum": return numbers.reduce((total, value) => total + value, 0);
    case "link": return numbers[0];
    case "negate": return -numbers[0];
    case "negate_sum": return -numbers.reduce((total, value) => total + value, 0);
    case "subtract": return numbers.slice(1).reduce((value, item) => value - item, numbers[0]);
    default: return null;
  }
}

/**
 * Normalize the filed history into per-period tax-rate observations.
 * Every period gets a record; unusable periods carry their exclusion reason
 * so the selected rate's provenance shows exactly what was left out and why.
 */
export function normaliseHistoricalEffectiveTaxRates(modelCase) {
  const taxRow = findRow(
    modelCase,
    (row) => row.row_id === "tax_expense" || row.semantic_role === "tax_expense",
  );
  const pbtRow = findRow(
    modelCase,
    (row) => row.row_id === "pre_tax_income" || row.semantic_role === "pre_tax_income",
  );
  const rowsById = new Map(
    [
      ...(modelCase?.statement_structure?.income_statement ?? []),
      ...(modelCase?.statement_structure?.cash_flow ?? []),
    ].map((row) => [row.row_id, row]),
  );
  const taxes = historicalNumbers(taxRow).map((value, index) =>
    value !== null ? value : evaluatedHistorical(rowsById, taxRow?.row_id ?? "tax_expense", index),
  );
  const pbts = historicalNumbers(pbtRow).map((value, index) =>
    value !== null ? value : evaluatedHistorical(rowsById, pbtRow?.row_id ?? "pre_tax_income", index),
  );
  const pbtScale = Math.max(1, ...pbts.filter((value) => value !== null).map(Math.abs));
  // The filing convention is a property of the WHOLE history, never of one
  // period: one positive value inside an expense-negative history is a tax
  // credit, not a convention change. Only PROFIT periods anchor the
  // inference (a loss period's tax sign is the benefit question itself);
  // with no profit period the canonical expense-negative shape is assumed.
  const anchorTaxes = taxes.filter(
    (value, index) => value !== null && value !== 0 && pbts[index] !== null && pbts[index] > 0,
  );
  const negativeCount = anchorTaxes.filter((value) => value < 0).length;
  const convention = negativeCount >= anchorTaxes.length - negativeCount
    ? "expense_negative"
    : "expense_positive";
  const periods = [0, 1, 2].map((index) => {
    const tax = taxes[index];
    const pbt = pbts[index];
    const record = {
      period_index: index,
      reported_tax_expense: tax,
      reported_pbt: pbt,
      raw_rate: null,
      usable: false,
      classification: null,
      exclusion_reason: null,
    };
    if (tax === null || pbt === null) {
      record.classification = "dependency_unresolved";
      record.exclusion_reason = "tax expense or pre-tax income is not resolved for this period";
      return record;
    }
    if (Math.abs(pbt) < NEAR_ZERO_PBT_FRACTION * pbtScale) {
      record.classification = "near_zero_pbt";
      record.exclusion_reason = "pre-tax income is too close to zero for the ratio to be an economic rate";
      return record;
    }
    const expenseSign = convention === "expense_negative" ? -1 : 1;
    if (pbt < 0) {
      const isBenefit = Math.sign(tax) !== 0 && Math.sign(tax) !== expenseSign;
      record.classification = isBenefit ? "loss_tax_benefit" : "loss_with_tax_charge";
      record.exclusion_reason = "loss period: the loss-case policy owns this shape, not rate inference";
      return record;
    }
    // PBT > 0. Normalize against the inferred convention; a value on the
    // WRONG side of the convention is a credit year, not a rate.
    if (tax !== 0 && Math.sign(tax) !== expenseSign) {
      record.classification = "tax_credit_on_profit";
      record.exclusion_reason = "a tax credit against positive pre-tax income is not a recurring rate";
      return record;
    }
    const rate = expenseSign === -1 ? -tax / pbt : tax / pbt;
    record.raw_rate = rate;
    if (convention === "expense_positive") record.classification = "positive_expense_convention";
    if (rate <= 0) {
      record.classification = "tax_credit_on_profit";
      record.exclusion_reason = "a tax credit against positive pre-tax income is not a recurring rate";
      return record;
    }
    if (rate > MAX_USABLE_RATE) {
      record.classification = record.classification ?? "distorted_rate";
      record.exclusion_reason = `rate ${rate.toFixed(4)} exceeds the usable ceiling ${MAX_USABLE_RATE}`;
      return record;
    }
    record.usable = true;
    record.classification = record.classification ?? "normal_rate";
    return record;
  });
  // Last resort when the tax/PBT pair cannot be normalized at all: the rate
  // row's OWN filed history. A present, sane display rate is legitimate
  // evidence (it is the issuer's or compiler's materialised ratio); this rung
  // exists for the case where the components are unresolved but the rate
  // itself survived. Classified distinctly so provenance shows which basis
  // produced the selected rate.
  if (!periods.some((period) => period.usable)) {
    const displayRates = historicalNumbers(
      findRow(modelCase, (row) => row.semantic_role === "effective_tax_rate"),
    );
    for (const [index, rate] of displayRates.entries()) {
      const period = periods[index];
      if (period.usable || rate === null) continue;
      // Loss periods stay with the loss policy; every other exclusion may be
      // rescued by a sane filed display rate. The component analysis stays on
      // the ledger (component_exclusion_reason) so provenance shows both
      // bases and why the display rung was used.
      if (["loss_tax_benefit", "loss_with_tax_charge"].includes(period.classification)) continue;
      if (rate > 0 && rate <= MAX_USABLE_RATE) {
        period.raw_rate = rate;
        period.usable = true;
        period.component_exclusion_reason = period.exclusion_reason;
        period.component_classification = period.classification;
        period.classification = "display_row_rate";
        period.exclusion_reason = null;
      }
    }
  }
  return {
    schema_version: TAX_RATE_POLICY_SCHEMA,
    tax_row_id: taxRow?.row_id ?? null,
    pbt_row_id: pbtRow?.row_id ?? null,
    filing_convention: convention,
    periods,
    usable_rates: periods.filter((period) => period.usable).map((period) => period.raw_rate),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The waterfall candidate this policy contributes for one forecast period of
 * the effective-tax-rate row. Returns null when the policy has nothing
 * defensible to say (no usable history and no classifiable loss shape) — in
 * that case the row lawfully escalates to a batched user decision instead of
 * a terminal internal blocker.
 *
 * The candidate deliberately uses the existing `historical_average` /
 * `carry_forward` method rungs so guidance, broker and user authorities keep
 * outranking it without any new ranking vocabulary.
 */
export function taxRatePolicyCandidate(modelCase, row, forecastIndex) {
  if (row?.semantic_role !== "effective_tax_rate") return null;
  const normalization = normaliseHistoricalEffectiveTaxRates(modelCase);
  const usable = normalization.usable_rates;
  if (usable.length >= 2) {
    const value = median(usable);
    return {
      method: "historical_average",
      origin: "tax_rate_policy",
      source_kind: "historical_inference",
      value,
      formula_spec: {
        operator: TAX_RATE_POLICY_OPERATORS.median,
        row_id: row.row_id,
        usable_period_count: usable.length,
        forecast_index: forecastIndex,
      },
      tax_rate_normalization: normalization,
      definition_compatible: true,
      units_compatible: true,
      period_compatible: true,
      note:
        `Median of ${usable.length} usable normalized historical effective tax rates ` +
        `(${usable.map((rate) => rate.toFixed(4)).join(", ")}). Excluded periods and reasons ` +
        "are recorded on the normalization ledger. A deliberately stable rate: no trend " +
        "extrapolation is ever applied to a tax rate.",
    };
  }
  if (usable.length === 1) {
    return {
      method: "carry_forward",
      origin: "tax_rate_policy",
      source_kind: "historical_inference",
      value: usable[0],
      formula_spec: {
        operator: TAX_RATE_POLICY_OPERATORS.latest,
        row_id: row.row_id,
        usable_period_count: 1,
        forecast_index: forecastIndex,
      },
      tax_rate_normalization: normalization,
      definition_compatible: true,
      units_compatible: true,
      period_compatible: true,
      note:
        "The single usable normalized historical effective tax rate is carried forward. " +
        "The other periods' exclusion reasons are recorded on the normalization ledger.",
    };
  }
  const lossShape = normalization.periods.some((period) =>
    ["loss_tax_benefit", "loss_with_tax_charge"].includes(period.classification),
  );
  if (lossShape) {
    // The emitted `tax` operator already recognises no current tax on
    // negative PBT. Declaring the rate policy state (instead of silently
    // writing 0%) keeps "not meaningful" visibly different from "zero".
    return {
      method: "explicit_zero",
      origin: "tax_rate_policy",
      source_kind: "historical_inference",
      value: 0,
      formula_spec: {
        operator: TAX_RATE_POLICY_OPERATORS.loss_case,
        row_id: row.row_id,
        forecast_index: forecastIndex,
      },
      tax_rate_normalization: normalization,
      definition_compatible: true,
      units_compatible: true,
      period_compatible: true,
      note:
        "Loss-case tax policy: every historical period is a loss or distorted shape, so no " +
        "recurring rate exists. The model's declared loss rule (no current tax while pre-tax " +
        "income is negative) owns the forecast; the rate cell records the policy state " +
        "rather than a silently invented percentage.",
    };
  }
  return null;
}
