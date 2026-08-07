/**
 * Closed, typed statement-formula vocabulary.
 *
 * Model reasoning supplies semantic references and an operator.  This module
 * alone turns that typed expression into Excel syntax, so arbitrary formula
 * strings cannot enter the statement compiler.  Schedule mechanics keep their
 * own declared emitters, but their output is inspected independently after
 * emission.
 */

export const FORMULA_OPERATORS = Object.freeze([
  "link",
  "sum",
  "subtract",
  "multiply",
  "ratio",
  "negated_ratio",
  "growth",
  "average",
  "negate",
  "negate_sum",
  "tax",
  "prior_period",
  "prior_period_scaled_by",
  "average_balance_interest",
  "roll_forward",
  "schedule_link",
  "scenario_overlay",
  "toggle_gate",
]);

const ARITY = Object.freeze({
  link: [1, 1],
  sum: [0, Number.POSITIVE_INFINITY],
  subtract: [2, Number.POSITIVE_INFINITY],
  multiply: [2, Number.POSITIVE_INFINITY],
  ratio: [2, 2],
  negated_ratio: [2, 2],
  growth: [1, 1],
  average: [1, Number.POSITIVE_INFINITY],
  negate: [1, 1],
  negate_sum: [1, Number.POSITIVE_INFINITY],
  tax: [2, 2],
  prior_period: [1, 1],
  prior_period_scaled_by: [2, 2],
  average_balance_interest: [3, 4],
  roll_forward: [2, Number.POSITIVE_INFINITY],
  schedule_link: [1, 1],
  scenario_overlay: [2, 3],
  toggle_gate: [2, 3],
});

export const FORMULA_COMPLEXITY_BUDGET = Object.freeze({
  max_ast_depth: 4,
  max_semantic_references: 256,
  max_repeated_references: 0,
  max_excel_characters: 8192,
});

function parseCell(reference) {
  const match = /^(\$?)([A-Z]+)(\$?)(\d+)$/.exec(String(reference));
  if (!match) return null;
  return {
    text: String(reference),
    columnAbsolute: match[1],
    column: match[2],
    rowAbsolute: match[3],
    row: Number(match[4]),
  };
}

export function compactA1References(references) {
  const terms = [];
  for (let index = 0; index < references.length; ) {
    const first = parseCell(references[index]);
    if (!first) {
      terms.push(String(references[index]));
      index += 1;
      continue;
    }
    let last = first;
    let next = index + 1;
    while (next < references.length) {
      const candidate = parseCell(references[next]);
      if (
        !candidate ||
        candidate.column !== first.column ||
        candidate.columnAbsolute !== first.columnAbsolute ||
        candidate.rowAbsolute !== first.rowAbsolute ||
        candidate.row !== last.row + 1
      ) {
        break;
      }
      last = candidate;
      next += 1;
    }
    terms.push(last === first ? first.text : `${first.text}:${last.text}`);
    index = next;
  }
  return terms;
}

export function canonicalSumExpression(references) {
  const terms = compactA1References(references);
  if (terms.length === 0) return "0";
  if (terms.length === 1 && references.length === 1) return terms[0];
  return `SUM(${terms.join(",")})`;
}

export function validateFormulaRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return ["Formula rule must be an object."];
  }
  if (!FORMULA_OPERATORS.includes(rule.operator)) {
    errors.push(`Unsupported formula operator ${rule.operator}.`);
    return errors;
  }
  if (!Array.isArray(rule.refs)) {
    errors.push(`${rule.operator} requires a refs array.`);
    return errors;
  }
  const [minimum, maximum] = ARITY[rule.operator];
  if (rule.refs.length < minimum || rule.refs.length > maximum) {
    errors.push(
      `${rule.operator} requires ${minimum}${minimum === maximum ? "" : `-${maximum}`} references; received ${rule.refs.length}.`,
    );
  }
  const invalid = rule.refs.filter(
    (reference) =>
      typeof reference !== "string" ||
      !/^[a-z0-9][a-z0-9_.-]*$/i.test(reference),
  );
  if (invalid.length > 0) {
    errors.push(`${rule.operator} contains invalid semantic references.`);
  }
  const repeated = rule.refs.filter(
    (reference, index) => rule.refs.indexOf(reference) !== index,
  );
  if (repeated.length > FORMULA_COMPLEXITY_BUDGET.max_repeated_references) {
    errors.push(
      `${rule.operator} repeats semantic references: ${[...new Set(repeated)].join(", ")}.`,
    );
  }
  if (rule.refs.length > FORMULA_COMPLEXITY_BUDGET.max_semantic_references) {
    errors.push(
      `${rule.operator} exceeds the ${FORMULA_COMPLEXITY_BUDGET.max_semantic_references}-reference budget.`,
    );
  }
  return errors;
}

export function formulaRuleComplexity(rule, formula = null) {
  const repeated = (rule?.refs ?? []).filter(
    (reference, index, all) => all.indexOf(reference) !== index,
  );
  return {
    ast_depth: 1,
    semantic_references: rule?.refs?.length ?? 0,
    unique_semantic_references: new Set(rule?.refs ?? []).size,
    repeated_references: new Set(repeated).size,
    excel_characters: formula?.length ?? null,
    within_budget:
      (rule?.refs?.length ?? 0) <=
        FORMULA_COMPLEXITY_BUDGET.max_semantic_references &&
      new Set(repeated).size <=
        FORMULA_COMPLEXITY_BUDGET.max_repeated_references &&
      (formula === null ||
        formula.length <= FORMULA_COMPLEXITY_BUDGET.max_excel_characters),
  };
}

export function compileStatementFormula({
  rule,
  definition,
  column,
  rowForId,
  previousColumn,
  roundSumDigits = null,
}) {
  const errors = validateFormulaRule(rule);
  if (errors.length > 0) throw new Error(errors.join(" "));
  const refs = rule.refs.map((id) => {
    const row = rowForId(id);
    if (!row) throw new Error(`Formula reference ${id} does not resolve.`);
    return `${column}${row}`;
  });
  let formula;
  switch (rule.operator) {
    case "sum": {
      const expression = canonicalSumExpression(refs);
      formula = roundSumDigits === null
        ? `=${expression}`
        : `=ROUND(${expression},${roundSumDigits})`;
      break;
    }
    case "link":
    case "schedule_link":
      formula = `=${refs[0]}`;
      break;
    case "subtract":
      formula = `=${refs.slice(1).reduce((value, ref) => `${value}-${ref}`, refs[0])}`;
      break;
    case "multiply":
      formula = `=${refs.join("*")}`;
      break;
    case "negate":
      formula = `=-${refs[0]}`;
      break;
    case "negate_sum":
      formula = `=-${canonicalSumExpression(refs)}`;
      break;
    case "ratio":
      formula = `=IFERROR(${refs[0]}/${refs[1]},0)`;
      break;
    case "negated_ratio":
      formula = `=IFERROR(-${refs[0]}/${refs[1]},0)`;
      break;
    case "growth": {
      const prior = previousColumn(column);
      if (!prior) return { formula: '=""', complexity: formulaRuleComplexity(rule, '=""') };
      const sourceRow = rowForId(rule.refs[0]);
      formula = `=IFERROR(${column}${sourceRow}/${prior}${sourceRow}-1,0)`;
      break;
    }
    case "tax":
      formula = `=IF(${refs[0]}>0,-${refs[0]}*${refs[1]},0)`;
      break;
    case "prior_period": {
      const prior = previousColumn(column);
      if (!prior) return { formula: null, complexity: formulaRuleComplexity(rule) };
      formula = `=${prior}${rowForId(rule.refs[0])}`;
      break;
    }
    case "prior_period_scaled_by": {
      const prior = previousColumn(column);
      if (!prior) return { formula: null, complexity: formulaRuleComplexity(rule) };
      const sourceRow = rowForId(rule.refs[0]);
      const driverRow = rowForId(rule.refs[1]);
      formula =
        `=IFERROR(${prior}${sourceRow}*${column}${driverRow}/` +
        `${prior}${driverRow},0)`;
      break;
    }
    case "average":
      formula = `=AVERAGE(${refs.join(",")})`;
      break;
    default:
      throw new Error(
        `${rule.operator} is a declared DSL operator but requires a schedule-specific emitter.`,
      );
  }
  const complexity = formulaRuleComplexity(rule, formula);
  if (!complexity.within_budget) {
    throw new Error(
      `${definition?.row_id ?? "formula"} exceeds the formula complexity budget.`,
    );
  }
  return { formula, complexity };
}
