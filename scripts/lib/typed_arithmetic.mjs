/**
 * P1.3 — The centralised typed arithmetic service (shadow core).
 *
 * Invariant: currency, unit, scale, period and context are explicit in
 * source arithmetic, and missingness propagates by declared policy — a sum
 * containing `missing` is unresolved unless partial aggregation is
 * explicitly permitted and recorded.
 *
 * Values are typed_financial_value objects extended with dimension context
 * supplied by the caller: { currency, unit_scale, period, period_kind }.
 * period_kind is "duration" (a flow over a period) or "instant" (a balance
 * at a date); mixing them without an explicit policy is refused.
 *
 * Every operation returns a RECEIPT — operands (state + normalized value +
 * dimensions), operation, policy, result state and tolerance — so the
 * arithmetic is auditable, not just correct.
 */
import { numericValueOf, VALUE_BEARING_STATES } from "./typed_financial_value.mjs";

const ABSENT = "absent";

function dimensionOf(operand) {
  return {
    currency: operand.dimensions?.currency ?? null,
    unit_scale: operand.dimensions?.unit_scale ?? 1,
    period: operand.dimensions?.period ?? null,
    period_kind: operand.dimensions?.period_kind ?? null,
  };
}

function readOperand(operand) {
  const value = numericValueOf(operand.value);
  return {
    state: operand.value.state,
    numeric: value,
    reading: value === null ? ABSENT : "number",
    dimensions: dimensionOf(operand),
    precision: operand.value.precision ?? null,
  };
}

function requireCompatibleAdditive(readings, operation) {
  const currencies = new Set(readings.map((reading) => reading.dimensions.currency));
  if (currencies.size > 1) {
    return `${operation} over mixed currencies ${[...currencies].join(",")} requires explicit conversion evidence`;
  }
  const scales = new Set(readings.map((reading) => reading.dimensions.unit_scale));
  if (scales.size > 1) {
    return `${operation} over mixed unit scales ${[...scales].join(",")} requires explicit scale conversion`;
  }
  const kinds = new Set(readings.map((reading) => reading.dimensions.period_kind).filter(Boolean));
  if (kinds.size > 1) {
    return `${operation} mixes instant and duration facts without an explicit policy`;
  }
  return null;
}

/**
 * Tolerance from source precision + absolute + relative thresholds — never a
 * single global epsilon. `precision` is decimal places of the least precise
 * operand; absent precision defaults conservative (2dp).
 */
export function toleranceFor(readings, { absolute = 0.5, relativePpm = 5 } = {}) {
  const precisions = readings.map((reading) => reading.precision).filter((value) => value !== null);
  const precisionTolerance = precisions.length > 0
    ? 0.5 * 10 ** -Math.min(...precisions)
    : 0.005;
  const magnitude = Math.max(...readings.map((reading) => Math.abs(reading.numeric ?? 0)), 1);
  return Math.max(precisionTolerance, absolute * 1e-6 * magnitude * relativePpm, precisionTolerance);
}

function receipt(operation, readings, policy, result) {
  return {
    schema_version: "excel-inflow-arithmetic-receipt/1.0",
    operation,
    operands: readings.map((reading) => ({
      state: reading.state,
      value: reading.numeric,
      currency: reading.dimensions.currency,
      unit_scale: reading.dimensions.unit_scale,
      period: reading.dimensions.period,
      period_kind: reading.dimensions.period_kind,
      precision: reading.precision,
    })),
    policy,
    ...result,
  };
}

function aggregate(operation, operands, combine, policy = {}) {
  const readings = operands.map(readOperand);
  const incompatibility = requireCompatibleAdditive(readings, operation);
  if (incompatibility) {
    return receipt(operation, readings, policy, {
      result_state: "refused", refusal: incompatibility, value: null,
    });
  }
  const absentReadings = readings.filter((reading) => reading.reading === ABSENT);
  if (absentReadings.length > 0 && policy.partial_aggregation !== true) {
    return receipt(operation, readings, policy, {
      result_state: "unresolved",
      value: null,
      unresolved_because: `${absentReadings.length} operand(s) in state(s) ${[...new Set(absentReadings.map((reading) => reading.state))].join(",")} and partial aggregation is not permitted`,
    });
  }
  const numbers = readings.filter((reading) => reading.reading === "number").map((reading) => reading.numeric);
  if (numbers.length === 0) {
    return receipt(operation, readings, policy, {
      result_state: "unresolved", value: null, unresolved_because: "no numeric operand",
    });
  }
  const value = combine(numbers);
  return receipt(operation, readings, policy, {
    result_state: "derived_number",
    value,
    partial: absentReadings.length > 0 ? { omitted: absentReadings.length, recorded: true } : null,
    tolerance: toleranceFor(readings),
  });
}

export function add(operands, policy) { return aggregate("add", operands, (ns) => ns.reduce((a, b) => a + b, 0), policy); }
export function subtract(a, b, policy) {
  return aggregate("subtract", [a, b], (ns) => ns.length === 2 ? ns[0] - ns[1] : null, policy);
}
export function average(operands, policy) {
  return aggregate("average", operands, (ns) => ns.reduce((x, y) => x + y, 0) / ns.length, policy);
}
export function negate(a) {
  return aggregate("negate", [a], (ns) => -ns[0]);
}

/** Multiplication/division cross dimensions deliberately: currency×ratio etc.
 * Only ONE operand may carry a currency; the result inherits it. */
function multiplicative(operation, a, b, combine) {
  const readings = [a, b].map(readOperand);
  const currencies = readings.map((reading) => reading.dimensions.currency).filter(Boolean);
  // multiply: at most one currency-bearing operand (currency × ratio).
  // divide: same-currency division is a lawful dimensionless ratio; two
  // DIFFERENT currencies need explicit conversion evidence.
  if (operation === "multiply" && currencies.length > 1) {
    return receipt(operation, readings, {}, {
      result_state: "refused", value: null,
      refusal: "multiply over two currency-bearing operands is dimensionally invalid",
    });
  }
  if (operation === "divide" && new Set(currencies).size > 1) {
    return receipt(operation, readings, {}, {
      result_state: "refused", value: null,
      refusal: "divide over two different currencies requires explicit conversion evidence",
    });
  }
  if (readings.some((reading) => reading.reading === ABSENT)) {
    return receipt(operation, readings, {}, {
      result_state: "unresolved", value: null, unresolved_because: "an operand is absent",
    });
  }
  const value = combine(readings[0].numeric, readings[1].numeric);
  return receipt(operation, readings, {}, {
    result_state: value === null ? "unresolved" : "derived_number",
    value,
    tolerance: toleranceFor(readings),
  });
}
export function multiply(a, b) { return multiplicative("multiply", a, b, (x, y) => x * y); }
export function divide(a, b) {
  return multiplicative("divide", a, b, (x, y) => (y === 0 ? null : x / y));
}
export function ratio(a, b) { return divide(a, b); }

/** Tolerance comparison: equal within the derived tolerance of the operands. */
export function equalWithinTolerance(a, b, options) {
  const readings = [a, b].map(readOperand);
  if (readings.some((reading) => reading.reading === ABSENT)) {
    return receipt("compare", readings, {}, {
      result_state: "unresolved", value: null, unresolved_because: "an operand is absent",
    });
  }
  const tolerance = toleranceFor(readings, options);
  const equal = Math.abs(readings[0].numeric - readings[1].numeric) <= tolerance;
  return receipt("compare", readings, {}, { result_state: "derived_number", value: equal, tolerance });
}

export { VALUE_BEARING_STATES };
