/**
 * Closed, typed statement-formula vocabulary.
 *
 * Model reasoning supplies semantic references and an operator.  This module
 * alone turns that typed expression into Excel syntax, so arbitrary formula
 * strings cannot enter the statement compiler.  Schedule mechanics keep their
 * own declared emitters, but their output is inspected independently after
 * emission.
 *
 * The Excel text is no longer assembled here. Each operator builds a typed
 * expression tree from `formula_ast.mjs` and `renderExpression` is the single
 * place a formula becomes characters. That buys three things the string
 * concatenation could not give:
 *
 *   - `ast_depth` is COMPUTED from the tree instead of declared, so the
 *     complexity budget describes the formula that was actually emitted.
 *   - The tree is available beside the text, so a caller can verify that the
 *     text it is about to ship is what the tree renders (`verifyFormulaAst`).
 *   - Every declared operator is now either backed by a tree builder or listed
 *     in `UNSUPPORTED_FORMULA_OPERATORS` with a typed refusal. The union is
 *     checked against `FORMULA_OPERATORS` at import, so an operator can never
 *     again be declared and then silently reach a fall-through default.
 */

import {
  astDepth,
  binary,
  call,
  conditional,
  group,
  literal,
  opaqueRef,
  range,
  ref,
  renderExpression,
  renderFormula,
} from "./formula_ast.mjs";
import {
  TAX_RATE_POLICY_OPERATORS,
  TAX_RATE_POLICY_OPERATOR_LIST,
  TAX_RATE_POLICY_OWNED_ROLE,
} from "./tax_rate_policy.mjs";

export {
  FORMULA_AST_NODE_KINDS,
  FormulaAstError,
  astDepth,
  astReferences,
  renderExpression,
  renderFormula,
  verifyFormulaAst,
} from "./formula_ast.mjs";

export const FORMULA_OPERATORS = Object.freeze([
  "link",
  "sum",
  "subtract",
  "multiply",
  "ratio",
  "negated_ratio",
  "growth",
  "average",
  "historical_average",
  "historical_trend",
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
  historical_average: [1, 1],
  historical_trend: [1, 1],
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

/**
 * Operators this module renders from a tree. Every other declared operator
 * must appear in `UNSUPPORTED_FORMULA_OPERATORS`.
 */
export const SUPPORTED_FORMULA_OPERATORS = Object.freeze([
  "link",
  "schedule_link",
  "sum",
  "subtract",
  "multiply",
  "ratio",
  "negated_ratio",
  "growth",
  "average",
  "historical_average",
  "historical_trend",
  "negate",
  "negate_sum",
  "tax",
  "prior_period",
  "prior_period_scaled_by",
]);

/**
 * Declared operators with no statement-level emitter. Their mechanics live in
 * the schedule builders, which mint their own cells; asked for one here, this
 * module REFUSES with a typed payload rather than approximating the semantics.
 * A wrong interest accrual or a silently dropped toggle is worse than a stop.
 */
export const UNSUPPORTED_FORMULA_OPERATORS = Object.freeze({
  average_balance_interest: Object.freeze({
    operator: "average_balance_interest",
    reason_code: "formula_operator_requires_schedule_emitter",
    declared_arity: Object.freeze([3, 4]),
    emitter: "interest schedule (opening/closing balance pair, rate, optional day count)",
    repair:
      "Emit the accrual from the interest schedule builder, then link the statement row with `link` or `schedule_link`.",
  }),
  roll_forward: Object.freeze({
    operator: "roll_forward",
    reason_code: "formula_operator_requires_schedule_emitter",
    declared_arity: Object.freeze([2, Number.POSITIVE_INFINITY]),
    emitter: "balance roll-forward schedule (opening balance plus signed movements)",
    repair:
      "Build the roll-forward in its schedule, where the opening balance's prior-period column is known, then link the statement row.",
  }),
  scenario_overlay: Object.freeze({
    operator: "scenario_overlay",
    reason_code: "formula_operator_requires_schedule_emitter",
    declared_arity: Object.freeze([2, 3]),
    emitter: "scenario overlay block (base case, overlay delta, optional selector)",
    repair:
      "Resolve the overlay in the scenario block and link its result; the statement layer must not choose a scenario.",
  }),
  toggle_gate: Object.freeze({
    operator: "toggle_gate",
    reason_code: "formula_operator_requires_schedule_emitter",
    declared_arity: Object.freeze([2, 3]),
    emitter: "control-gated schedule block (control cell, gated value, optional fallback)",
    repair:
      "Gate the value where the control cell lives, then link the statement row; a gate minted here would not be audited against the control registry.",
  }),
});

/** Typed refusal for a declared operator this module deliberately will not render. */
export class UnsupportedFormulaOperatorError extends Error {
  constructor(detail) {
    super(`${detail.operator} is a declared DSL operator but requires a schedule-specific emitter.`);
    this.name = "UnsupportedFormulaOperatorError";
    this.typed_refusal = detail;
  }
}

// A declared operator that is neither rendered nor refused would fall through
// to an untyped default. Fail at import rather than at the cell that needs it.
{
  const classified = [
    ...SUPPORTED_FORMULA_OPERATORS,
    ...Object.keys(UNSUPPORTED_FORMULA_OPERATORS),
  ].sort();
  const declared = [...FORMULA_OPERATORS].sort();
  if (
    classified.length !== declared.length ||
    classified.some((operator, index) => operator !== declared[index])
  ) {
    throw new Error(
      "Formula operator classification is incomplete: every declared operator must be " +
        "listed in SUPPORTED_FORMULA_OPERATORS or UNSUPPORTED_FORMULA_OPERATORS. " +
        `Declared ${declared.join(",")}; classified ${classified.join(",")}.`,
    );
  }
}

/**
 * ROLE-POLICY OPERATORS (P3.3).
 *
 * `FORMULA_OPERATORS` above is the STATEMENT-EXPRESSION vocabulary: every
 * member is either rendered to Excel here or registered as a schedule-emitter
 * refusal. The tax-rate policy's three operators are neither. They name a
 * completion AUTHORITY — the rate cell carries a value the policy computed
 * from normalized filed history — so they must never render an expression, and
 * they must never be admitted to the statement set where the import check
 * above would demand an emitter for them.
 *
 * They are nevertheless part of the DECLARED formula operator vocabulary
 * (`DECLARED_FORMULA_OPERATORS`), which is the point: before P3.3 they existed
 * nowhere in this module and downstream consumers recognised them by testing
 * `operator.startsWith("tax_rate_policy")`. A prefix test admits strings
 * nobody declared. This registry is closed, enumerable, and checked at import
 * against the policy module's own list.
 */
export const ROLE_POLICY_FORMULA_OPERATORS = Object.freeze({
  [TAX_RATE_POLICY_OPERATORS.median]: Object.freeze({
    operator: TAX_RATE_POLICY_OPERATORS.median,
    reason_code: "formula_operator_owned_by_role_policy",
    policy: "tax_rate_policy",
    owned_role: TAX_RATE_POLICY_OWNED_ROLE,
    declared_arity: Object.freeze([0, 0]),
    emitter: "tax rate policy (median of the usable normalized historical effective tax rates)",
    repair:
      "Read the rate from the authority the tax rate policy produced; the statement DSL must not re-derive a rate, because `rate = tax ÷ PBT` beside `tax = PBT × rate` is the circular pair the policy exists to break.",
  }),
  [TAX_RATE_POLICY_OPERATORS.latest]: Object.freeze({
    operator: TAX_RATE_POLICY_OPERATORS.latest,
    reason_code: "formula_operator_owned_by_role_policy",
    policy: "tax_rate_policy",
    owned_role: TAX_RATE_POLICY_OWNED_ROLE,
    declared_arity: Object.freeze([0, 0]),
    emitter: "tax rate policy (the single usable normalized historical effective tax rate, carried forward)",
    repair:
      "Read the rate from the authority the tax rate policy produced; the statement DSL must not re-derive a rate from the rate row's own history.",
  }),
  [TAX_RATE_POLICY_OPERATORS.loss_case]: Object.freeze({
    operator: TAX_RATE_POLICY_OPERATORS.loss_case,
    reason_code: "formula_operator_owned_by_role_policy",
    policy: "tax_rate_policy",
    owned_role: TAX_RATE_POLICY_OWNED_ROLE,
    declared_arity: Object.freeze([0, 0]),
    emitter: "tax rate policy (declared loss-case treatment; the model's own loss rule owns the forecast)",
    repair:
      "Read the declared loss-case state from the authority; a rendered 0% here would be indistinguishable from an inferred zero rate.",
  }),
});

/**
 * Every operator this module knows by name: the statement-expression set plus
 * the role-policy set. "Declared" means enumerable and closed — the property a
 * string-prefix test cannot provide.
 */
export const DECLARED_FORMULA_OPERATORS = Object.freeze([
  ...FORMULA_OPERATORS,
  ...Object.keys(ROLE_POLICY_FORMULA_OPERATORS),
]);

// The role-policy registry must name EXACTLY the policy module's declared
// operators, and must stay DISJOINT from the statement-expression set: an
// operator in both would be simultaneously required to render an expression
// and forbidden from rendering one. Fail at import, not at the cell.
{
  const registered = Object.keys(ROLE_POLICY_FORMULA_OPERATORS).sort();
  const declared = [...TAX_RATE_POLICY_OPERATOR_LIST].sort();
  if (
    registered.length !== declared.length ||
    registered.some((operator, index) => operator !== declared[index])
  ) {
    throw new Error(
      "Role-policy formula operator registry drifted from the tax rate policy's declared " +
        `operators: registered ${registered.join(",")}; declared ${declared.join(",")}.`,
    );
  }
  const overlap = registered.filter((operator) => FORMULA_OPERATORS.includes(operator));
  if (overlap.length > 0) {
    throw new Error(
      "A role-policy operator cannot also be a statement-expression operator: " +
        `${overlap.join(",")} appears in both vocabularies.`,
    );
  }
  for (const [key, entry] of Object.entries(ROLE_POLICY_FORMULA_OPERATORS)) {
    if (entry.operator !== key) {
      throw new Error(`Role-policy operator entry ${key} declares operator ${entry.operator}.`);
    }
  }
}

/**
 * Membership in the role-policy vocabulary. This is the predicate that
 * replaces `operator.startsWith("tax_rate_policy")` at every consumer.
 */
export function isRolePolicyFormulaOperator(operator) {
  return typeof operator === "string"
    && Object.hasOwn(ROLE_POLICY_FORMULA_OPERATORS, operator);
}

/**
 * "supported" | "refused" | "role_policy" | "unknown" — a total classification,
 * no defaults. Every answer this returned before P3.3 is unchanged; the three
 * declared role-policy operators moved from "unknown" to "role_policy", which
 * is the whole point: they are now DECLARED rather than unrecognised.
 */
export function formulaOperatorSupport(operator) {
  if (SUPPORTED_FORMULA_OPERATORS.includes(operator)) return "supported";
  if (Object.hasOwn(UNSUPPORTED_FORMULA_OPERATORS, operator)) return "refused";
  if (isRolePolicyFormulaOperator(operator)) return "role_policy";
  return "unknown";
}

export const FORMULA_COMPLEXITY_BUDGET = Object.freeze({
  // The deepest tree any declared operator builds is the historical trend at 7
  // levels (`=F11+((E11-D11)+(F11-E11))/2*3`). Chained associative operators
  // stay at one level whatever their operand count, so this bound no longer
  // moves with the reference count and is now ENFORCED in `within_budget`
  // rather than reported and ignored.
  max_ast_depth: 8,
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

/**
 * Collapse a reference list into term NODES: a run of vertically contiguous
 * cells sharing both absolute markers becomes one `range`, anything else stays
 * a `ref`. A term the caller handed over already formed and unparseable
 * survives as an opaque ref, exactly as the pre-AST emitter passed it through.
 */
export function compactA1ReferenceAsts(references) {
  const terms = [];
  for (let index = 0; index < references.length; ) {
    const first = parseCell(references[index]);
    if (!first) {
      terms.push(opaqueRef(String(references[index])));
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
    terms.push(
      last === first ? ref(first.text) : range(ref(first.text), ref(last.text)),
    );
    index = next;
  }
  return terms;
}

export function compactA1References(references) {
  return compactA1ReferenceAsts(references).map((term) => renderExpression(term));
}

/**
 * The canonical additive expression for a reference list, as a tree. An empty
 * list is the zero literal; a single reference is itself, unwrapped; anything
 * else is `SUM` over the compacted terms.
 */
export function sumExpressionAst(references) {
  const terms = compactA1ReferenceAsts(references);
  if (terms.length === 0) return literal(0);
  if (terms.length === 1 && references.length === 1) return terms[0];
  return call("SUM", terms);
}

export function canonicalSumExpression(references) {
  return renderExpression(sumExpressionAst(references));
}

export function validateFormulaRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return ["Formula rule must be an object."];
  }
  if (!FORMULA_OPERATORS.includes(rule.operator)) {
    // A DECLARED role-policy operator asked to render a statement expression
    // is a different fault from an undeclared name, and says so.
    if (isRolePolicyFormulaOperator(rule.operator)) {
      const entry = ROLE_POLICY_FORMULA_OPERATORS[rule.operator];
      errors.push(
        `${rule.operator} is a declared ${entry.policy} operator for the ${entry.owned_role} ` +
          "role and renders no statement expression.",
      );
      return errors;
    }
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

/**
 * Complexity of one compiled rule. `ast_depth` is measured on the tree the
 * operator actually built — a rule that emitted no expression at all reports
 * depth 0, not the flattering 1 this function used to declare for everything.
 */
export function formulaRuleComplexity(rule, formula = null, ast = null) {
  const repeated = (rule?.refs ?? []).filter(
    (reference, index, all) => all.indexOf(reference) !== index,
  );
  const depth = ast === null || ast === undefined ? 0 : astDepth(ast);
  return {
    ast_depth: depth,
    semantic_references: rule?.refs?.length ?? 0,
    unique_semantic_references: new Set(rule?.refs ?? []).size,
    repeated_references: new Set(repeated).size,
    excel_characters: formula?.length ?? null,
    within_budget:
      depth <= FORMULA_COMPLEXITY_BUDGET.max_ast_depth &&
      (rule?.refs?.length ?? 0) <=
        FORMULA_COMPLEXITY_BUDGET.max_semantic_references &&
      new Set(repeated).size <=
        FORMULA_COMPLEXITY_BUDGET.max_repeated_references &&
      (formula === null ||
        formula.length <= FORMULA_COMPLEXITY_BUDGET.max_excel_characters),
  };
}

const ZERO = () => literal(0);

/**
 * Build the expression TREE for one statement formula. Returns
 * `{ ast, formula, complexity }`; `ast` is null only where the rule emits no
 * formula at all (a prior-period reference in the first column).
 *
 * `formula` is always exactly `renderFormula(ast)` — that is the property
 * `verifyFormulaAst` exists to re-check at any later point in the pipeline.
 */
export function compileStatementFormulaAst({
  rule,
  definition,
  column,
  rowForId,
  previousColumn,
  historicalColumns = [],
  roundSumDigits = null,
}) {
  const errors = validateFormulaRule(rule);
  if (errors.length > 0) throw new Error(errors.join(" "));
  const cells = rule.refs.map((id) => {
    const row = rowForId(id);
    if (!row) throw new Error(`Formula reference ${id} does not resolve.`);
    return `${column}${row}`;
  });
  const cell = (index) => ref(cells[index]);
  let ast;
  switch (rule.operator) {
    case "sum": {
      const expression = sumExpressionAst(cells);
      ast =
        roundSumDigits === null
          ? expression
          : call("ROUND", [expression, literal(roundSumDigits)]);
      break;
    }
    case "link":
    case "schedule_link":
      ast = cell(0);
      break;
    case "subtract":
      ast = binary("-", cells.map((text) => ref(text)));
      break;
    case "multiply":
      ast = binary("*", cells.map((text) => ref(text)));
      break;
    case "negate":
      ast = { kind: "unary", operator: "-", operand: cell(0) };
      break;
    case "negate_sum":
      ast = { kind: "unary", operator: "-", operand: sumExpressionAst(cells) };
      break;
    case "ratio":
      ast = call("IFERROR", [binary("/", [cell(0), cell(1)]), ZERO()]);
      break;
    case "negated_ratio":
      ast = call("IFERROR", [
        binary("/", [
          { kind: "unary", operator: "-", operand: cell(0) },
          cell(1),
        ]),
        ZERO(),
      ]);
      break;
    case "growth": {
      const prior = previousColumn(column);
      if (!prior) {
        const blank = literal("");
        return {
          ast: blank,
          formula: renderFormula(blank),
          complexity: formulaRuleComplexity(rule, renderFormula(blank), blank),
        };
      }
      const sourceRow = rowForId(rule.refs[0]);
      ast = call("IFERROR", [
        binary("-", [
          binary("/", [ref(`${column}${sourceRow}`), ref(`${prior}${sourceRow}`)]),
          literal(1),
        ]),
        ZERO(),
      ]);
      break;
    }
    case "tax":
      ast = conditional(
        binary(">", [cell(0), ZERO()]),
        binary("*", [{ kind: "unary", operator: "-", operand: cell(0) }, cell(1)]),
        ZERO(),
      );
      break;
    case "prior_period": {
      const prior = previousColumn(column);
      if (!prior) {
        return { ast: null, formula: null, complexity: formulaRuleComplexity(rule) };
      }
      ast = ref(`${prior}${rowForId(rule.refs[0])}`);
      break;
    }
    case "prior_period_scaled_by": {
      const prior = previousColumn(column);
      if (!prior) {
        return { ast: null, formula: null, complexity: formulaRuleComplexity(rule) };
      }
      const sourceRow = rowForId(rule.refs[0]);
      const driverRow = rowForId(rule.refs[1]);
      ast = call("IFERROR", [
        binary("/", [
          binary("*", [
            ref(`${prior}${sourceRow}`),
            ref(`${column}${driverRow}`),
          ]),
          ref(`${prior}${driverRow}`),
        ]),
        ZERO(),
      ]);
      break;
    }
    case "average":
      ast = call("AVERAGE", cells.map((text) => ref(text)));
      break;
    case "historical_average": {
      if (historicalColumns.length !== 3) {
        throw new Error("historical_average requires exactly three historical columns.");
      }
      const sourceRow = rowForId(rule.refs[0]);
      ast = call("AVERAGE", [
        range(
          ref(`${historicalColumns[0]}${sourceRow}`),
          ref(`${historicalColumns[2]}${sourceRow}`),
        ),
      ]);
      break;
    }
    case "historical_trend": {
      if (historicalColumns.length !== 3) {
        throw new Error("historical_trend requires exactly three historical columns.");
      }
      const sourceRow = rowForId(rule.refs[0]);
      const forecastIndex = Number(rule.forecast_index ?? 0);
      if (!Number.isInteger(forecastIndex) || forecastIndex < 0 || forecastIndex > 2) {
        throw new Error("historical_trend forecast_index must be 0, 1 or 2.");
      }
      const [h1, h2, h3] = historicalColumns.map((item) => `${item}${sourceRow}`);
      // The two paired deltas are GROUPED deliberately: the expression means
      // "the last actual plus the mean of the two period-over-period deltas",
      // and precedence alone would flatten that reading away.
      ast = binary("+", [
        ref(h3),
        binary("*", [
          binary("/", [
            binary("+", [
              group(binary("-", [ref(h2), ref(h1)])),
              group(binary("-", [ref(h3), ref(h2)])),
            ]),
            literal(2),
          ]),
          literal(forecastIndex + 1),
        ]),
      ]);
      break;
    }
    default:
      // Reached only for a declared operator with no statement emitter. The
      // import-time classification check guarantees this is one of the four
      // registered refusals and never an unclassified fall-through.
      throw new UnsupportedFormulaOperatorError(
        UNSUPPORTED_FORMULA_OPERATORS[rule.operator] ??
          Object.freeze({
            operator: rule.operator,
            reason_code: "formula_operator_unclassified",
            declared_arity: ARITY[rule.operator] ?? null,
            emitter: null,
            repair:
              "Classify this operator in SUPPORTED_FORMULA_OPERATORS or UNSUPPORTED_FORMULA_OPERATORS.",
          }),
      );
  }
  const formula = renderFormula(ast);
  const complexity = formulaRuleComplexity(rule, formula, ast);
  if (!complexity.within_budget) {
    throw new Error(
      `${definition?.row_id ?? "formula"} exceeds the formula complexity budget.`,
    );
  }
  return { ast, formula, complexity };
}

/**
 * Text-only entry point, unchanged in shape for its existing caller. The
 * formula it returns is rendered from the tree above, never concatenated.
 */
export function compileStatementFormula(options) {
  const { formula, complexity } = compileStatementFormulaAst(options);
  return { formula, complexity };
}
