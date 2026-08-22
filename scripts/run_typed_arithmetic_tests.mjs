#!/usr/bin/env node
/**
 * P1.3 — Typed arithmetic service tests.
 *
 * Invariant: currency, unit, scale, period and context are explicit in
 * source arithmetic; missingness propagates by declared policy.
 */
import assert from "node:assert/strict";
import { typedValue } from "./lib/typed_financial_value.mjs";
import {
  add, subtract, multiply, divide, average, negate, equalWithinTolerance,
} from "./lib/typed_arithmetic.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "typed_arithmetic_tests", importMetaUrl: import.meta.url });

const eur = (value, extra = {}) => ({
  value: typedValue("reported_number", { value, raw_text: String(value), ...extra.value_fields }),
  dimensions: { currency: "EUR", unit_scale: 1e6, period: "2025-12-31", period_kind: "duration", ...extra.dimensions },
});
const usd = (value) => ({
  value: typedValue("reported_number", { value, raw_text: String(value) }),
  dimensions: { currency: "USD", unit_scale: 1e6, period: "2025-12-31", period_kind: "duration" },
});
const missing = () => ({ value: typedValue("missing"), dimensions: { currency: "EUR", unit_scale: 1e6, period: "2025-12-31", period_kind: "duration" } });

// 1. Plain add works and carries a receipt.
{
  const result = add([eur(100), eur(-40.5)]);
  run.check("add computes", () => {
    assert.ok(result.result_state === "derived_number" && result.value === 59.5);
    return true;
  });
  run.check("receipt carries operands", () => {
    assert.ok(result.operands.length === 2 && result.operands[0].currency === "EUR");
    return true;
  });
}

// 2. Currency mismatch is REFUSED, not converted silently.
{
  const result = add([eur(100), usd(100)]);
  run.check("mixed-currency add must refuse", () => {
    assert.ok(result.result_state === "refused" && /mixed currencies/.test(result.refusal));
    return true;
  });
}

// 3. Scale mismatch refused.
{
  const thousands = eur(100); thousands.dimensions.unit_scale = 1e3;
  const result = add([eur(100), thousands]);
  run.check("mixed-scale add must refuse", () => {
    assert.ok(result.result_state === "refused" && /unit scales/.test(result.refusal));
    return true;
  });
}

// 4. Instant×duration mixing refused.
{
  const balance = eur(100); balance.dimensions.period_kind = "instant";
  const result = add([eur(100), balance]);
  run.check("instant+duration must refuse without policy", () => {
    assert.ok(result.result_state === "refused" && /instant and duration/.test(result.refusal));
    return true;
  });
}

// 5. MISSINGNESS: a sum containing missing is unresolved by default…
{
  const result = add([eur(100), missing()]);
  run.check("a sum containing missing must be unresolved, never zero-filled", () => {
    assert.ok(result.result_state === "unresolved" && result.value === null);
    return true;
  });
}
// …and permitted-partial aggregation RECORDS the decision.
{
  const result = add([eur(100), missing()], { partial_aggregation: true });
  run.check("permitted partial aggregation must compute AND record the omission", () => {
    assert.ok(result.result_state === "derived_number" && result.value === 100 &&
      result.partial?.omitted === 1 && result.policy.partial_aggregation === true);
    return true;
  });
}

// 6. Property: for any operand set with >=1 absent state and no policy, the
// result is never a number (missingness propagation over all absence states).
for (const state of ["reported_blank", "nil", "parse_failure", "unresolved", "not_applicable"]) {
  const fields = { reported_blank: {}, nil: { raw_text: "n/a" }, parse_failure: { raw_text: "x", failure_reason: "r" }, unresolved: {}, not_applicable: {} }[state];
  const operand = { value: typedValue(state, fields), dimensions: { currency: "EUR", unit_scale: 1e6, period: "2025-12-31", period_kind: "duration" } };
  const result = add([eur(1), operand]);
  run.check(`${state} must propagate to unresolved`, () => {
    assert.ok(result.result_state === "unresolved");
    return true;
  });
}

// 7. Decimal precision: large values and small precise values.
{
  const large = add([eur(1e12), eur(1)]);
  run.check("large-magnitude addition stays exact in double range", () => {
    assert.ok(large.value === 1e12 + 1);
    return true;
  });
  const a = eur(0.1), b = eur(0.2);
  a.value.precision = 1; b.value.precision = 1;
  const sum = add([a, b]);
  const compare = equalWithinTolerance(
    { value: typedValue("derived_number", { value: sum.value, derivation: { operator: "sum", refs: [] } }), dimensions: a.dimensions },
    { value: typedValue("reported_number", { value: 0.3, raw_text: "0.3", precision: 1 }), dimensions: a.dimensions },
  );
  run.check("0.1+0.2 equals 0.3 within source-precision tolerance", () => {
    assert.ok(compare.value === true);
    return true;
  });
  run.check("tolerance derives from source precision (1dp -> 0.05)", () => {
    assert.ok(compare.tolerance >= 0.05);
    return true;
  });
}

// 8. Division by zero is unresolved, never Infinity or zero.
{
  const result = divide(eur(5), eur(0));
  run.check("divide-by-zero must be unresolved", () => {
    assert.ok(result.result_state === "unresolved");
    return true;
  });
}

// 9. Two currency-bearing operands cannot multiply.
{
  const result = multiply(eur(5), usd(2));
  run.check("currency×currency must refuse", () => {
    assert.ok(result.result_state === "refused");
    return true;
  });
}

// 10. negate + subtract + average sanity with receipts.
run.check("negate", () => {
  assert.ok(negate(eur(7)).value === -7);
  return true;
});
run.check("subtract", () => {
  assert.ok(subtract(eur(10), eur(4)).value === 6);
  return true;
});
run.check("average", () => {
  assert.ok(average([eur(2), eur(4)]).value === 3);
  return true;
});

run.finish();
