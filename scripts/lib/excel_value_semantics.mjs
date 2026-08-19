/**
 * Excel comparison semantics shared by the plan evaluator and cache oracle.
 *
 * Blank-cell comparison is intentionally non-transitive in Excel: a literal
 * blank cell compares equal to both numeric zero and the empty string, while
 * the empty string and numeric zero do not compare equal to each other.  The
 * caller owns its blank sentinel and supplies `isBlank` so independent readers
 * do not need to share an object identity.
 */
export function compareExcelValues(left, right, { isBlank = (value) => value == null } = {}) {
  const leftBlank = isBlank(left);
  const rightBlank = isBlank(right);
  if (leftBlank && rightBlank) return 0;
  if (leftBlank) {
    return typeof right === "string"
      ? ("" < right ? -1 : "" > right ? 1 : 0)
      : compareExcelValues(0, right, { isBlank });
  }
  if (rightBlank) {
    return typeof left === "string"
      ? (left < "" ? -1 : left > "" ? 1 : 0)
      : compareExcelValues(left, 0, { isBlank });
  }

  const leftIsText = typeof left === "string";
  const rightIsText = typeof right === "string";
  if (leftIsText && rightIsText) {
    const a = left.toUpperCase();
    const b = right.toUpperCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (leftIsText !== rightIsText) return leftIsText ? 1 : -1;

  const a = typeof left === "boolean" ? (left ? 1 : 0) : left;
  const b = typeof right === "boolean" ? (right ? 1 : 0) : right;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyExcelComparison(left, right, operator, options = {}) {
  const order = compareExcelValues(left, right, options);
  switch (operator) {
    case "=": return order === 0;
    case "<>": return order !== 0;
    case "<": return order < 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case ">=": return order >= 0;
    default: throw new Error(`unsupported Excel comparison operator ${operator}`);
  }
}
