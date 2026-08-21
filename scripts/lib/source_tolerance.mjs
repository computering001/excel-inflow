/**
 * The single home for what a FILED SOURCE CELL asserts numerically (P2.10).
 *
 * Two questions used to be answered twice, in two files, with two different
 * answers (defect register D5/D6):
 *
 *   1. How far may a computed sum sit from a printed total before the
 *      difference is a mis-footing rather than IEEE754 noise?
 *      `case_compiler.sourceTolerance` returned EXACTLY 0 when the source
 *      declared no precision, while `model_ir_v3.footingTolerance` — whose own
 *      comment claimed to mirror it — added `1e-9 * max(1, |target|)`. On
 *      12.3 + 45.6 against a printed 57.9 the first called it unfooted and the
 *      second called it footed. Both were wrong, in opposite directions.
 *
 *   2. What does an EMPTY filed cell assert? Nothing at all (the filing prints
 *      no figure there), or a reported nil that must foot like any other
 *      number? Skipping every empty cell let a genuine reported nil escape
 *      verification entirely.
 *
 * Both answers now live here, once. Every footing oracle consumes them, so the
 * oracles cannot disagree with each other about identical figures.
 *
 * This module VALIDATES. It never repairs a number, never invents a precision,
 * and never turns a missing, blank or nil cell into a zero.
 */

/** The declared-precision ceiling the case contract admits. */
export const MAX_DECLARED_PRECISION = 12;

/**
 * IEEE754 double unit roundoff, 2^-53. `Number.EPSILON` is 2^-52 — the gap
 * between 1 and the next representable double — and the rounding error of a
 * single operation is at most half of that gap.
 */
const UNIT_ROUNDOFF = Number.EPSILON / 2;

/**
 * Safety factor over the textbook recursive-summation error bound
 * `(n - 1) * u * Σ|x_i|`. Four, not a hand-picked epsilon: the resulting
 * allowance stays around 1e-16 RELATIVE, some seven orders of magnitude below
 * the tightest precision the contract can declare (1e-12 absolute) and
 * therefore incapable of swallowing any quantity a filing can print.
 *
 * The predecessor `1e-9 * max(1, |target|)` was ~4.5 million times looser than
 * this and demonstrably WEAKER than the rounding tolerance it was added to: at
 * a printed total of 500,000,000 with precision 0 it doubled the half-unit
 * allowance to a full unit, so a genuine one-unit break passed the footing
 * pass. Pinned by scripts/run_footing_tolerance_defect_tests.mjs.
 */
const FLOAT_NOISE_SAFETY_FACTOR = 4;

/**
 * Precision is carried under three mutually exclusive names: the face /
 * extraction manifest row uses `value_precisions`, a reconciled filed subtotal
 * uses `reported_historical_value_precisions` (the compiler DELETES the
 * source-row form when it stamps the reconciled one), and a source_input
 * statement row uses `historical_value_precisions`. Reading all three in one
 * place is what stops the two oracles reading different keys off the same row.
 */
const PRECISION_KEYS = Object.freeze([
  "value_precisions",
  "reported_historical_value_precisions",
  "historical_value_precisions",
]);

/**
 * A precision is honoured only if the source DECLARED it as a whole number of
 * printed decimal places inside the contract's range. Anything else is `null`:
 * deriving precision from `String(binaryFloat)` would mint 14-17 fictitious
 * decimal places, so an undeclared cell receives no invented custody stamp.
 */
function normalisePrecision(precision) {
  return Number.isInteger(precision) &&
    precision >= 0 &&
    precision <= MAX_DECLARED_PRECISION
    ? precision
    : null;
}

/** The three declared printed precisions of a row, or three nulls. */
export function declaredPrecisions(row) {
  for (const key of PRECISION_KEYS) {
    const declared = row?.[key];
    if (!Array.isArray(declared) || declared.length !== 3) continue;
    return declared.map(normalisePrecision);
  }
  return [null, null, null];
}

/** The declared printed precision of one historical cell, or null. */
export function declaredPrecisionAt(row, period) {
  return declaredPrecisions(row)[period] ?? null;
}

/**
 * Half a unit in the printed precision — the most a correctly transcribed
 * printed figure can differ from the quantity it rounds. Zero when the source
 * declared no precision: an undeclared cell licenses no rounding slack.
 */
export function roundingTolerance(precision) {
  const declared = normalisePrecision(precision);
  return declared === null ? 0 : 0.5 * 10 ** -declared;
}

/**
 * The IEEE754 noise floor of comparing `Σ terms` against `target` in doubles.
 * This is an arithmetic artefact allowance, NOT a materiality allowance: with
 * no terms and no target it is exactly zero, so exact arithmetic stays exact.
 */
export function floatNoiseTolerance({ target = 0, terms = [] } = {}) {
  const magnitudes = (Array.isArray(terms) ? terms : [])
    .map((value) => Math.abs(Number(value)))
    .filter((value) => Number.isFinite(value));
  const absoluteSum = magnitudes.reduce((sum, value) => sum + value, 0);
  const accumulations = Math.max(0, magnitudes.length - 1);
  const targetMagnitude = Number.isFinite(Number(target))
    ? Math.abs(Number(target))
    : 0;
  return (
    FLOAT_NOISE_SAFETY_FACTOR *
    UNIT_ROUNDOFF *
    (accumulations * absoluteSum + targetMagnitude)
  );
}

/**
 * THE tolerance. Half a printed unit where the source declared a precision,
 * plus the IEEE754 noise floor of the specific comparison being made.
 *
 * `terms`/`target` describe the comparison, not the row: a caller that is
 * testing a single magnitude rather than a sum passes neither and gets the
 * rounding tolerance alone.
 */
export function sourceTolerance({ precision = null, target = 0, terms = [] } = {}) {
  return roundingTolerance(precision) + floatNoiseTolerance({ target, terms });
}

/** `sourceTolerance` with the precision read off the row itself. */
export function rowSourceTolerance(row, period, comparison = {}) {
  return sourceTolerance({
    precision: declaredPrecisionAt(row, period),
    target: comparison.target ?? 0,
    terms: comparison.terms ?? [],
  });
}

// ---------------------------------------------------------------------------
// What an empty filed cell asserts (D6)
// ---------------------------------------------------------------------------

/**
 * The only two states that license a numeric reading. `reported_zero` is a
 * genuine printed nil and MUST foot like any other figure; `reported_number`
 * is an ordinary figure. Mirrors `case_compiler.typedNumericSeries`.
 */
export const VALUE_BEARING_STATES = Object.freeze(
  new Set(["reported_number", "reported_zero"]),
);

/**
 * States that DECLARE an absence: the source prints no figure in this cell, so
 * the cell asserts nothing and no identity can be checked against it. A
 * declared absence is lawful and silent — it is never read as zero, and it is
 * never treated as a defect.
 */
export const DECLARED_ABSENCE_STATES = Object.freeze(
  new Set(["reported_blank", "not_applicable"]),
);

/**
 * Classify one filed historical cell.
 *
 * The critical distinction — the whole of D6 — is between a cell that DECLARES
 * its absence and a cell that declares nothing:
 *
 *   value_bearing    a number (or a genuine reported nil) is asserted here.
 *   declared_absent  the source prints nothing here; asserts nothing. Silent.
 *   unclassified     a glyph exists, or the case simply never said. The
 *                    absence of a classification is itself a defect: without
 *                    it a reported nil is indistinguishable from a blank, and
 *                    the nil escapes every identity check. Typed, never
 *                    guessed and never resolved to zero.
 *   contradiction    the state claims a value the cell does not carry.
 *
 * With no declared state array the state is DERIVED exactly as
 * `case_compiler.typedHistoricalStates` derives it — `""` is a printed blank,
 * an absent/unreadable value is `unresolved` — so the two files cannot disagree
 * about what a raw cell said.
 */
export function filedCellAssertion(row, period, rawValue) {
  const declared = declaredStates(row);
  const state = Array.isArray(declared) ? (declared[period] ?? null) : null;
  const numeric = filedNumber(rawValue);
  if (state === null) {
    // Derived, not declared: mirror the case compiler's own reading.
    if (numeric !== null) return { kind: "value_bearing", state: null, value: numeric };
    if (rawValue === "") {
      return { kind: "declared_absent", state: "reported_blank", value: null };
    }
    return { kind: "unclassified", state: null, value: null, reason: "no_declared_classification" };
  }
  if (VALUE_BEARING_STATES.has(state)) {
    return numeric === null
      ? {
          kind: "contradiction",
          state,
          value: null,
          reason: "value_bearing_state_over_empty_cell",
        }
      : { kind: "value_bearing", state, value: numeric };
  }
  if (DECLARED_ABSENCE_STATES.has(state)) {
    return { kind: "declared_absent", state, value: null };
  }
  return {
    kind: "unclassified",
    state,
    value: null,
    reason: "printed_glyph_unclassified",
  };
}

const STATE_KEYS = Object.freeze([
  "value_states",
  "reported_historical_value_states",
  "historical_value_states",
]);

function declaredStates(row) {
  for (const key of STATE_KEYS) {
    const declared = row?.[key];
    if (Array.isArray(declared) && declared.length === 3) return declared;
  }
  return null;
}

/**
 * The numeric reading of a raw filed cell, or null. Null, undefined, the empty
 * string, a boolean and a non-finite value all read as NO NUMBER — never zero.
 */
export function filedNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// ---------------------------------------------------------------------------
// Printed unit magnitude (D9)
// ---------------------------------------------------------------------------

/**
 * Mirror of `UNIT_LABEL_MAGNITUDES` / `UNIT_HEADER_RE` in
 * scripts/extract_filing_statements.py (P2.1). Extraction reconciles the unit
 * HEADER it read off the page; the compile boundary reconciles the unit
 * WITNESS the case carries in `provenance[].units`. Both must read a label the
 * same way, so the vocabulary is transcribed rather than re-invented.
 */
const UNIT_LABEL_MAGNITUDES = Object.freeze({
  unit: "units",
  units: "units",
  thousand: "thousands",
  thousands: "thousands",
  "000": "thousands",
  "000s": "thousands",
  million: "millions",
  millions: "millions",
  m: "millions",
  mm: "millions",
  billion: "billions",
  billions: "billions",
  bn: "billions",
});

const UNIT_HEADER_RE = new RegExp(
  "^\\s*(?:amounts?\\s+)?(?:expressed\\s+)?(?:in\\s+)?" +
    "(?:(?:USD|GBP|EUR|CAD|AUD|NZD|JPY|CHF|SEK|NOK|DKK|ZAR|INR|CNY|RMB|HKD|SGD|" +
    "[$€£¥])\\s*(?:in\\s+)?)?" +
    "(?<magnitude>units?|thousands?|millions?|billions?|000s?|m|mm|bn)" +
    "(?:\\s+unless otherwise stated)?\\s*$",
  "i",
);

/** The printed magnitude a unit label asserts, or null if it does not parse. */
export function printedUnitMagnitude(label) {
  const normalised = String(label ?? "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.–—-]+/, "")
    .replace(/[\s:;,.–—-]+$/, "");
  const match = UNIT_HEADER_RE.exec(normalised);
  if (!match) return null;
  return (
    UNIT_LABEL_MAGNITUDES[String(match.groups.magnitude).toLowerCase()] ?? null
  );
}

/** The magnitude a declared `issuer.units` scalar denotes, or null. */
export function declaredUnitMagnitude(units) {
  if (!units) return null;
  return UNIT_LABEL_MAGNITUDES[String(units).toLowerCase()] ?? null;
}
