#!/usr/bin/env node
// P4.5 — FORMULA AST.
//
// The invariant this suite proves: workbook formulas are built from a typed
// expression AST — ref / range / literal / binary / unary / call / conditional
// / group — that renders deterministically to A1 text; `ast_depth` is COMPUTED
// from the tree rather than declared; and every one of the twenty declared DSL
// operators is either rendered from an AST or refused with a TYPED refusal that
// names the missing emitter. No declared operator may fall through to an
// untyped throw, and no operator may be silently mis-rendered.
//
// The render-equivalence half of the suite is the byte-identity guard: a frozen
// verbatim copy of the pre-AST string emitter (`legacyCompile` below) is run
// beside the AST route over every rule shape the DSL supports, and the two must
// agree character for character. The mutation half tampers a compiled AST and
// demands the verifier catch that the tree no longer renders to the text.
import assert from "node:assert/strict";

import {
  ASSOCIATIVE_RENDER_OPERATORS,
  FORMULA_AST_NODE_KINDS,
  FORMULA_FUNCTIONS,
  FormulaAstError,
  astDepth,
  binary,
  call,
  conditional,
  group,
  literal,
  range,
  ref,
  renderExpression,
  renderFormula,
  verifyFormulaAst,
} from "./lib/formula_ast.mjs";
import {
  FORMULA_COMPLEXITY_BUDGET,
  FORMULA_OPERATORS,
  UNSUPPORTED_FORMULA_OPERATORS,
  UnsupportedFormulaOperatorError,
  canonicalSumExpression,
  compactA1References,
  compileStatementFormula,
  compileStatementFormulaAst,
  formulaOperatorSupport,
  formulaRuleComplexity,
  sumExpressionAst,
} from "./lib/formula_dsl.mjs";

let checks = 0;
const check = (fn) => {
  fn();
  checks += 1;
};

// ---------------------------------------------------------------------------
// FROZEN REFERENCE EMITTER — a verbatim copy of the pre-AST string switch.
// It exists only to be disagreed with. If the AST renderer and this copy ever
// diverge by a single character, the shipped workbook text changed.
// ---------------------------------------------------------------------------
function legacyParseCell(reference) {
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

function legacyCompact(references) {
  const terms = [];
  for (let index = 0; index < references.length; ) {
    const first = legacyParseCell(references[index]);
    if (!first) {
      terms.push(String(references[index]));
      index += 1;
      continue;
    }
    let last = first;
    let next = index + 1;
    while (next < references.length) {
      const candidate = legacyParseCell(references[next]);
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

function legacySum(references) {
  const terms = legacyCompact(references);
  if (terms.length === 0) return "0";
  if (terms.length === 1 && references.length === 1) return terms[0];
  return `SUM(${terms.join(",")})`;
}

function legacyCompile({
  rule,
  column,
  rowForId,
  previousColumn,
  historicalColumns = [],
  roundSumDigits = null,
}) {
  const refs = rule.refs.map((id) => {
    const row = rowForId(id);
    if (!row) throw new Error(`Formula reference ${id} does not resolve.`);
    return `${column}${row}`;
  });
  switch (rule.operator) {
    case "sum": {
      const expression = legacySum(refs);
      return roundSumDigits === null
        ? `=${expression}`
        : `=ROUND(${expression},${roundSumDigits})`;
    }
    case "link":
    case "schedule_link":
      return `=${refs[0]}`;
    case "subtract":
      return `=${refs.slice(1).reduce((value, item) => `${value}-${item}`, refs[0])}`;
    case "multiply":
      return `=${refs.join("*")}`;
    case "negate":
      return `=-${refs[0]}`;
    case "negate_sum":
      return `=-${legacySum(refs)}`;
    case "ratio":
      return `=IFERROR(${refs[0]}/${refs[1]},0)`;
    case "negated_ratio":
      return `=IFERROR(-${refs[0]}/${refs[1]},0)`;
    case "growth": {
      const prior = previousColumn(column);
      if (!prior) return '=""';
      const sourceRow = rowForId(rule.refs[0]);
      return `=IFERROR(${column}${sourceRow}/${prior}${sourceRow}-1,0)`;
    }
    case "tax":
      return `=IF(${refs[0]}>0,-${refs[0]}*${refs[1]},0)`;
    case "prior_period": {
      const prior = previousColumn(column);
      if (!prior) return null;
      return `=${prior}${rowForId(rule.refs[0])}`;
    }
    case "prior_period_scaled_by": {
      const prior = previousColumn(column);
      if (!prior) return null;
      const sourceRow = rowForId(rule.refs[0]);
      const driverRow = rowForId(rule.refs[1]);
      return (
        `=IFERROR(${prior}${sourceRow}*${column}${driverRow}/` +
        `${prior}${driverRow},0)`
      );
    }
    case "average":
      return `=AVERAGE(${refs.join(",")})`;
    case "historical_average": {
      const sourceRow = rowForId(rule.refs[0]);
      return `=AVERAGE(${historicalColumns[0]}${sourceRow}:${historicalColumns[2]}${sourceRow})`;
    }
    case "historical_trend": {
      const sourceRow = rowForId(rule.refs[0]);
      const forecastIndex = Number(rule.forecast_index ?? 0);
      const [h1, h2, h3] = historicalColumns.map((item) => `${item}${sourceRow}`);
      return `=${h3}+((${h2}-${h1})+(${h3}-${h2}))/2*${forecastIndex + 1}`;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Harness — a synthetic row registry, a forecast column with and without a
// prior, and the three historical columns the trend operators require.
// ---------------------------------------------------------------------------
const ROWS = {
  alpha: 11,
  beta: 12,
  gamma: 13,
  delta: 17,
  epsilon: 40,
  zeta: 41,
  eta: 42,
  theta: 43,
  iota: 9,
};
const rowForId = (id) => ROWS[id] ?? null;
const HISTORICAL_COLUMNS = ["D", "E", "F"];
const withPrior = (column) => (column === "H" ? "G" : null);
const withoutPrior = () => null;

const SUPPORTED_OPERATORS = [
  "sum",
  "link",
  "schedule_link",
  "subtract",
  "multiply",
  "negate",
  "negate_sum",
  "ratio",
  "negated_ratio",
  "growth",
  "tax",
  "prior_period",
  "prior_period_scaled_by",
  "average",
  "historical_average",
  "historical_trend",
];
const REFUSED_OPERATORS = [
  "average_balance_interest",
  "roll_forward",
  "scenario_overlay",
  "toggle_gate",
];

// Every rule shape the DSL supports: each operator at its declared arity
// extremes, contiguous and non-contiguous reference runs (the compaction
// branch), with and without a prior column, with and without ROUND.
function ruleShapes() {
  const contiguous = ["epsilon", "zeta", "eta", "theta"]; // rows 40-43
  const scattered = ["alpha", "delta", "epsilon"]; // rows 11, 17, 40
  const shapes = [];
  const push = (rule, options = {}) =>
    shapes.push({
      rule,
      column: "H",
      rowForId,
      previousColumn: options.previousColumn ?? withPrior,
      historicalColumns: HISTORICAL_COLUMNS,
      roundSumDigits: options.roundSumDigits ?? null,
    });

  for (const refs of [
    [],
    ["alpha"],
    ["beta", "gamma"],
    scattered,
    contiguous,
    ["alpha", "beta", "delta"],
    ["alpha", "beta", "gamma", "delta"],
    ["iota", "alpha", "beta", "gamma"],
  ]) {
    push({ operator: "sum", refs });
    push({ operator: "sum", refs }, { roundSumDigits: 6 });
    push({ operator: "sum", refs }, { roundSumDigits: 0 });
    if (refs.length >= 1) push({ operator: "negate_sum", refs });
  }
  for (const operator of ["link", "schedule_link", "negate", "prior_period"]) {
    push({ operator, refs: ["alpha"] });
    push({ operator, refs: ["alpha"] }, { previousColumn: withoutPrior });
  }
  for (const refs of [
    ["alpha", "beta"],
    ["beta", "gamma"],
    scattered,
    contiguous,
  ]) {
    push({ operator: "subtract", refs });
    push({ operator: "multiply", refs });
    push({ operator: "average", refs });
  }
  for (const operator of ["ratio", "negated_ratio", "tax", "prior_period_scaled_by"]) {
    push({ operator, refs: ["alpha", "beta"] });
    push({ operator, refs: ["alpha", "beta"] }, { previousColumn: withoutPrior });
  }
  push({ operator: "growth", refs: ["alpha"] });
  push({ operator: "growth", refs: ["alpha"] }, { previousColumn: withoutPrior });
  push({ operator: "historical_average", refs: ["alpha"] });
  for (const forecast_index of [0, 1, 2]) {
    push({ operator: "historical_trend", refs: ["alpha"], forecast_index });
  }
  return shapes;
}

// ---------------------------------------------------------------------------
// 1. The node vocabulary is a closed, typed set — not free-form objects.
// ---------------------------------------------------------------------------
check(() =>
  assert.deepEqual(
    [...FORMULA_AST_NODE_KINDS].sort(),
    [
      "binary",
      "call",
      "conditional",
      "group",
      "literal",
      "range",
      "ref",
      "unary",
    ],
    "the AST node vocabulary must be exactly the eight kinds the DSL rules need",
  ),
);
check(() =>
  assert.ok(
    Object.isFrozen(FORMULA_AST_NODE_KINDS) && Object.isFrozen(FORMULA_FUNCTIONS),
    "the node-kind and function vocabularies must be frozen",
  ),
);
check(() =>
  assert.throws(
    () => call("VLOOKUP", [ref("A1")]),
    FormulaAstError,
    "a function outside the closed vocabulary must be refused, not rendered",
  ),
);
check(() =>
  assert.throws(
    () => ref("not-a-cell"),
    FormulaAstError,
    "a ref node must hold an A1 address",
  ),
);
check(() =>
  assert.throws(
    () => binary("&", [ref("A1"), ref("A2")]),
    FormulaAstError,
    "an operator outside the closed binary vocabulary must be refused",
  ),
);
check(() =>
  assert.throws(
    () => binary("-", [ref("A1")]),
    FormulaAstError,
    "a binary node needs at least two operands",
  ),
);

// ---------------------------------------------------------------------------
// 2. Rendering is deterministic, minimal-parenthesis and precedence-correct.
// ---------------------------------------------------------------------------
check(() =>
  assert.equal(
    renderExpression(
      binary("-", [binary("/", [ref("H11"), ref("G11")]), literal(1)]),
    ),
    "H11/G11-1",
    "a higher-precedence left operand must not be parenthesised",
  ),
);
check(() =>
  assert.equal(
    renderExpression(
      binary("/", [binary("+", [ref("A1"), ref("A2")]), literal(2)]),
    ),
    "(A1+A2)/2",
    "a lower-precedence left operand must be parenthesised",
  ),
);
check(() =>
  assert.equal(
    renderExpression(binary("-", [ref("A1"), ref("A2"), ref("A3")])),
    "A1-A2-A3",
    "a left-associative chain renders flat, without parentheses",
  ),
);
check(() =>
  assert.equal(
    renderExpression(group(binary("-", [ref("A2"), ref("A1")]))),
    "(A2-A1)",
    "a declared group renders its parentheses verbatim",
  ),
);
check(() => {
  const node = conditional(
    binary(">", [ref("H11"), literal(0)]),
    binary("*", [{ kind: "unary", operator: "-", operand: ref("H11") }, ref("H12")]),
    literal(0),
  );
  assert.equal(renderExpression(node), "IF(H11>0,-H11*H12,0)");
  assert.equal(renderExpression(node), renderExpression(node));
});
check(() =>
  assert.equal(
    renderFormula(call("SUM", [range(ref("H40"), ref("H43"))])),
    "=SUM(H40:H43)",
    "renderFormula prefixes the equals sign and nothing else",
  ),
);
check(() =>
  assert.equal(renderExpression(literal("")), '""', "a string literal is quoted"),
);

// ---------------------------------------------------------------------------
// 3. Depth is COMPUTED from the tree. This is the check the hardcoded
//    `ast_depth: 1` could never pass.
// ---------------------------------------------------------------------------
check(() => assert.equal(astDepth(ref("H11")), 1, "a leaf reference has depth 1"));
check(() =>
  assert.equal(
    astDepth(call("SUM", [ref("H11"), ref("H12")])),
    2,
    "a call over leaves has depth 2",
  ),
);
check(() => {
  // =F11+((E11-D11)+(F11-E11))/2*3 — the deepest shape the DSL emits.
  const trend = compileStatementFormulaAst({
    rule: { operator: "historical_trend", refs: ["alpha"], forecast_index: 2 },
    column: "H",
    rowForId,
    previousColumn: withPrior,
    historicalColumns: HISTORICAL_COLUMNS,
  });
  assert.equal(trend.formula, "=F11+((E11-D11)+(F11-E11))/2*3");
  assert.equal(astDepth(trend.ast), 7, "the trend tree is seven levels deep");
  assert.equal(
    trend.complexity.ast_depth,
    7,
    "formulaRuleComplexity must report the COMPUTED depth, not a constant",
  );
});
check(() => {
  const depths = new Map();
  for (const shape of ruleShapes()) {
    const compiled = compileStatementFormulaAst(shape);
    const computed = compiled.ast === null ? 0 : astDepth(compiled.ast);
    assert.equal(
      compiled.complexity.ast_depth,
      computed,
      `${shape.rule.operator} must report its own tree depth`,
    );
    depths.set(shape.rule.operator, Math.max(depths.get(shape.rule.operator) ?? 0, computed));
  }
  // A constant would collapse every operator onto one value.
  assert.ok(
    new Set(depths.values()).size >= 5,
    "computed depth must vary across operators",
  );
  assert.equal(depths.get("link"), 1);
  assert.equal(depths.get("historical_trend"), 7);
});
check(() => {
  const maximum = Math.max(
    ...ruleShapes().map((shape) => {
      const compiled = compileStatementFormulaAst(shape);
      return compiled.ast === null ? 0 : astDepth(compiled.ast);
    }),
  );
  assert.ok(
    maximum <= FORMULA_COMPLEXITY_BUDGET.max_ast_depth,
    `declared max_ast_depth ${FORMULA_COMPLEXITY_BUDGET.max_ast_depth} must actually bound the emitted trees (deepest ${maximum})`,
  );
  assert.ok(
    FORMULA_COMPLEXITY_BUDGET.max_ast_depth < 32,
    "the depth budget must be a real bound, not an unreachable number",
  );
});
check(() => {
  // The budget is enforced, not decorative: an over-deep tree is out of budget.
  let node = ref("H11");
  for (let i = 0; i < FORMULA_COMPLEXITY_BUDGET.max_ast_depth + 1; i += 1) {
    node = group(node);
  }
  const complexity = formulaRuleComplexity(
    { operator: "sum", refs: ["alpha"] },
    renderFormula(node),
    node,
  );
  assert.ok(complexity.ast_depth > FORMULA_COMPLEXITY_BUDGET.max_ast_depth);
  assert.equal(
    complexity.within_budget,
    false,
    "a tree deeper than the declared budget must fall out of budget",
  );
});

// ---------------------------------------------------------------------------
// 4. RENDER EQUIVALENCE — the byte-identity gate at unit scale. Every rule
//    shape, AST route versus the frozen pre-AST emitter, character for
//    character.
// ---------------------------------------------------------------------------
check(() => {
  const shapes = ruleShapes();
  assert.ok(shapes.length >= 60, "the shape matrix must actually cover the DSL");
  for (const shape of shapes) {
    const expected = legacyCompile(shape);
    const actual = compileStatementFormula(shape).formula;
    assert.equal(
      actual,
      expected,
      `${shape.rule.operator} (refs=${shape.rule.refs.length}, round=${shape.roundSumDigits}) drifted from the frozen emitter`,
    );
    const viaAst = compileStatementFormulaAst(shape);
    assert.equal(viaAst.formula, expected);
    assert.equal(
      viaAst.ast === null ? null : renderFormula(viaAst.ast),
      expected,
      `${shape.rule.operator} formula text must be exactly what its AST renders`,
    );
  }
});
check(() => {
  // Every supported operator is actually exercised by the matrix.
  const covered = new Set(ruleShapes().map((shape) => shape.rule.operator));
  assert.deepEqual([...covered].sort(), [...SUPPORTED_OPERATORS].sort());
});
check(() => {
  // Reference compaction — the range-minting branch — must be untouched.
  const patterns = [
    [],
    ["H11"],
    ["H11", "H12"],
    ["H11", "H12", "H13"],
    ["H11", "H13", "H14", "H15"],
    ["H11", "I12"],
    ["$H$11", "$H$12"],
    ["H11", "$H$12"],
    ["H9", "H10", "H11"],
    ["opaque_token", "H11", "H12"],
    ["H11", "H12", "opaque_token"],
  ];
  for (const pattern of patterns) {
    assert.deepEqual(compactA1References(pattern), legacyCompact(pattern), pattern.join("|"));
    assert.equal(canonicalSumExpression(pattern), legacySum(pattern), pattern.join("|"));
    assert.equal(
      renderExpression(sumExpressionAst(pattern)),
      legacySum(pattern),
      `sum AST for ${pattern.join("|")} must render the canonical text`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. The four unimplemented operators — typed refusal, never a silent
//    mis-render and never an untyped throw.
// ---------------------------------------------------------------------------
check(() =>
  assert.deepEqual(
    Object.keys(UNSUPPORTED_FORMULA_OPERATORS).sort(),
    [...REFUSED_OPERATORS].sort(),
    "the refusal registry must name exactly the four operators with no emitter",
  ),
);
for (const operator of REFUSED_OPERATORS) {
  check(() => {
    const entry = UNSUPPORTED_FORMULA_OPERATORS[operator];
    assert.equal(
      entry.reason_code,
      "formula_operator_requires_schedule_emitter",
      `${operator} refusal needs a registered reason code`,
    );
    for (const field of ["operator", "reason_code", "declared_arity", "emitter", "repair"]) {
      assert.ok(field in entry, `${operator} refusal is missing ${field}`);
    }
    assert.equal(entry.operator, operator);
    assert.equal(formulaOperatorSupport(operator), "refused");
    let error = null;
    try {
      compileStatementFormulaAst({
        rule: { operator, refs: ["alpha", "beta", "gamma"] },
        column: "H",
        rowForId,
        previousColumn: withPrior,
        historicalColumns: HISTORICAL_COLUMNS,
      });
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(
      error instanceof UnsupportedFormulaOperatorError,
      `${operator} must be refused with the typed refusal, not a bare Error`,
    );
    assert.equal(
      error.message,
      `${operator} is a declared DSL operator but requires a schedule-specific emitter.`,
      "the refusal must keep the message the pre-AST emitter threw",
    );
    assert.equal(error.typed_refusal.operator, operator);
    assert.equal(
      error.typed_refusal.reason_code,
      "formula_operator_requires_schedule_emitter",
    );
    assert.ok(error instanceof Error, "the typed refusal is still an Error");
  });
}
check(() => {
  // No declared operator may fall through to an untyped default.
  assert.deepEqual(
    [...FORMULA_OPERATORS].sort(),
    [...SUPPORTED_OPERATORS, ...REFUSED_OPERATORS].sort(),
    "every declared operator must be classified as rendered or refused",
  );
  for (const operator of FORMULA_OPERATORS) {
    const support = formulaOperatorSupport(operator);
    assert.ok(
      support === "supported" || support === "refused",
      `${operator} is unclassified`,
    );
  }
  assert.equal(formulaOperatorSupport("not_an_operator"), "unknown");
});
check(() =>
  assert.deepEqual(
    validateShape({ operator: "not_an_operator", refs: ["alpha"] }),
    ["Unsupported formula operator not_an_operator."],
    "an undeclared operator is still refused by the rule validator",
  ),
);
function validateShape(rule) {
  try {
    compileStatementFormula({
      rule,
      column: "H",
      rowForId,
      previousColumn: withPrior,
      historicalColumns: HISTORICAL_COLUMNS,
    });
    return [];
  } catch (error) {
    return [error.message];
  }
}

// ---------------------------------------------------------------------------
// 6. MUTATION — a tampered AST renders differently and is caught.
// ---------------------------------------------------------------------------
check(() => {
  const compiled = compileStatementFormulaAst({
    rule: { operator: "subtract", refs: ["alpha", "beta", "gamma"] },
    column: "H",
    rowForId,
    previousColumn: withPrior,
    historicalColumns: HISTORICAL_COLUMNS,
  });
  assert.equal(compiled.formula, "=H11-H12-H13");
  assert.deepEqual(verifyFormulaAst(compiled.ast, compiled.formula), []);
  // Flip the operator: same shape, different economics.
  const tampered = structuredClone(compiled.ast);
  tampered.operator = "+";
  const errors = verifyFormulaAst(tampered, compiled.formula);
  assert.equal(errors.length, 1, "a flipped operator must be reported");
  assert.match(errors[0], /=H11\+H12\+H13/);
  assert.match(errors[0], /=H11-H12-H13/);
});
check(() => {
  const compiled = compileStatementFormulaAst({
    rule: { operator: "tax", refs: ["alpha", "beta"] },
    column: "H",
    rowForId,
    previousColumn: withPrior,
    historicalColumns: HISTORICAL_COLUMNS,
  });
  // Swap a reference: the tree no longer renders to the shipped text.
  const tampered = structuredClone(compiled.ast);
  tampered.whenFalse = ref("H99");
  assert.equal(verifyFormulaAst(tampered, compiled.formula).length, 1);
  // Drop a declared group: renders differently even though it is "just" parens.
  const trend = compileStatementFormulaAst({
    rule: { operator: "historical_trend", refs: ["alpha"], forecast_index: 0 },
    column: "H",
    rowForId,
    previousColumn: withPrior,
    historicalColumns: HISTORICAL_COLUMNS,
  });
  const flattened = structuredClone(trend.ast);
  const inner = flattened.operands[1].operands[0].operands[0];
  inner.operands = inner.operands.map((operand) =>
    operand.kind === "group" ? operand.expression : operand,
  );
  assert.notEqual(renderFormula(flattened), trend.formula);
  assert.equal(verifyFormulaAst(flattened, trend.formula).length, 1);
});
check(() => {
  // A structurally invalid node is a typed AST fault, never a rendered string.
  assert.throws(
    () => renderExpression({ kind: "smuggled", text: "=RAND()" }),
    FormulaAstError,
    "an unknown node kind must not render",
  );
  assert.throws(
    () => renderExpression({ kind: "binary", operator: "-", operands: [ref("A1")] }),
    FormulaAstError,
  );
  assert.throws(() => astDepth({ kind: "smuggled" }), FormulaAstError);
  assert.throws(() => verifyFormulaAst({ kind: "smuggled" }, "=1"), FormulaAstError);
});
check(() =>
  assert.ok(
    ASSOCIATIVE_RENDER_OPERATORS.every((operator) =>
      typeof operator === "string" && operator.length <= 2,
    ) && Object.isFrozen(ASSOCIATIVE_RENDER_OPERATORS),
    "the chain-rendering operator set is declared and frozen",
  ),
);

console.log(JSON.stringify({ status: "PASS", checks }));
