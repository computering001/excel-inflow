/**
 * P7.10 — Order-invariant accumulation.
 *
 * The GAP this closes (D32 / MG-5): the opening-debt bridge and the opening
 * instrument register both summed the register in the order the case happened
 * to list its instruments. Floating-point addition is not associative, so the
 * SAME economics traversed in a different order produced a different residual
 * (-943.56 vs -943.5600000000002 on seed 700577). A residual that is not a
 * function of its inputs alone cannot be reproduced, and any future tightening
 * of the bridge tolerance becomes non-deterministic.
 *
 * The invariant this module supplies:
 *
 *   A residual is a function of its inputs. Two accumulations of the same
 *   MULTISET of addends produce a bit-identical result.
 *
 * WHY IT HOLDS — this is a proof, not an assertion:
 *
 *   1. `canonicalSum` never reads the caller's traversal order. It sorts the
 *      addends with `compareCanonicalAddend`, a TOTAL order derived only from
 *      the addend values, and accumulates left-to-right from +0.
 *   2. Sorting a multiset with a total order yields a sequence that is unique
 *      up to permutation of elements the comparator calls equal.
 *   3. `compareCanonicalAddend` returns 0 only for BIT-IDENTICAL doubles: it
 *      orders by numeric value, breaks the one remaining tie in IEEE-754
 *      equality (-0 vs +0) by sign bit, and pins NaN to a fixed position. So
 *      its "equal" class is exactly {x} for each distinct bit pattern.
 *   4. Permuting bit-identical addends cannot change any partial sum, because
 *      `a + x` and `a + x` are the same operation.
 *
 *   (2)+(3)+(4) give: every input permutation of the same multiset produces
 *   the same accumulation sequence of operations, hence the same double. The
 *   result therefore depends on the multiset alone. QED.
 *
 * This is a CANONICALISATION, not a rounding. No addend is altered, nothing is
 * snapped to a tolerance, and the sum's magnitude is unchanged beyond the
 * last-place difference the ordering itself resolves. It also never mints a
 * number: an absent addend must be excluded by the caller before it gets here,
 * and a non-finite addend is carried through rather than defaulted (see
 * `canonicalSum`'s contract below).
 */

/**
 * A total order on doubles whose equality class holds only bit-identical
 * values. NaN sorts last (deterministically; a NaN addend poisons the sum in
 * any order, so its position only has to be fixed, not meaningful).
 */
export function compareCanonicalAddend(left, right) {
  const leftNaN = Number.isNaN(left);
  const rightNaN = Number.isNaN(right);
  if (leftNaN || rightNaN) {
    if (leftNaN && rightNaN) return 0;
    return leftNaN ? 1 : -1;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  // IEEE-754 equality reached: the only distinct bit patterns still here are
  // -0 and +0. Order by sign bit so "comparator-equal" means "bit-identical".
  const leftSign = Object.is(left, -0) ? 0 : 1;
  const rightSign = Object.is(right, -0) ? 0 : 1;
  return leftSign - rightSign;
}

/**
 * The canonical order of a multiset of addends: a pure function of the values.
 * Exposed so a caller (or a test) can inspect the order rather than trust it.
 */
export function canonicalAddendOrder(values) {
  return [...values].sort(compareCanonicalAddend);
}

/**
 * Sum a multiset of doubles in an order derived only from the values.
 *
 * The caller owns absence: this function does NOT coerce `null`, `undefined`,
 * `""` or any other non-number into 0 — doing so would mint a number for an
 * addend that carried none, which is the never-zero violation this repository
 * forbids. A non-number addend THROWS, so an absent value announces itself at
 * the accumulation boundary instead of silently contributing zero.
 *
 * @param {Iterable<number>} values finite (or deliberately non-finite) doubles
 * @param {string} [what] label used in the throw, to name the caller's slot
 * @returns {number} the sum, bit-identical across every input permutation
 */
export function canonicalSum(values, what = "addend") {
  const addends = [];
  for (const value of values) {
    if (typeof value !== "number") {
      throw new Error(
        `canonicalSum received a non-number ${what} (${JSON.stringify(value)}); ` +
          "an absent addend must be excluded by the caller, never coerced to zero.",
      );
    }
    addends.push(value);
  }
  addends.sort(compareCanonicalAddend);
  let total = 0;
  for (const addend of addends) total += addend;
  return total;
}
