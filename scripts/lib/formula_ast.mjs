/**
 * Typed formula expression AST and its deterministic A1 renderer.
 *
 * `formula_dsl.mjs` used to build Excel text by string concatenation, one flat
 * level per operator, and then declared `ast_depth: 1` because there was no
 * tree to measure. This module is that tree. Every statement formula the
 * compiler ships is now a node graph over a CLOSED vocabulary — eight node
 * kinds, a closed binary-operator set and a closed function set — and the
 * Excel text is produced by exactly one function, `renderExpression`.
 *
 * Two properties matter more than convenience:
 *
 *   1. RENDERING IS TOTAL AND TYPED. An unknown node kind, an operator outside
 *      the declared set, a call to a function outside the declared set or a
 *      malformed arity does not render to a best-effort string — it throws
 *      `FormulaAstError`. Nothing can smuggle arbitrary formula text through a
 *      node.
 *   2. PARENTHESES ARE EITHER REQUIRED OR DECLARED. The renderer inserts the
 *      parentheses precedence demands and no others, so the text is a function
 *      of the tree alone. Where a formula's *meaning* carries grouping that
 *      precedence would not require — the paired period-over-period deltas in
 *      the historical-trend expression — the tree says so with an explicit
 *      `group` node. There is no third source of parentheses, which is what
 *      makes `verifyFormulaAst` able to catch a tampered tree.
 */

export class FormulaAstError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "FormulaAstError";
    this.detail = detail;
  }
}

export const FORMULA_AST_NODE_KINDS = Object.freeze([
  "ref",
  "range",
  "literal",
  "unary",
  "binary",
  "call",
  "conditional",
  "group",
]);

/** Closed Excel function vocabulary. A name outside this list cannot render. */
export const FORMULA_FUNCTIONS = Object.freeze([
  "SUM",
  "AVERAGE",
  "ROUND",
  "IFERROR",
  "MIN",
  "MAX",
  "ABS",
]);

/** Closed binary-operator vocabulary, with Excel's precedence levels. */
const BINARY_PRECEDENCE = Object.freeze({
  "=": 1,
  "<>": 1,
  ">": 1,
  "<": 1,
  ">=": 1,
  "<=": 1,
  "+": 2,
  "-": 2,
  "*": 3,
  "/": 3,
  "^": 4,
});

export const BINARY_OPERATORS = Object.freeze(Object.keys(BINARY_PRECEDENCE));

/**
 * Operators whose n-ary form renders as one flat left-associative chain
 * (`A-B-C`). Restricting chaining to these keeps the renderer from inventing
 * an associativity Excel does not have for comparisons or exponentiation.
 */
export const ASSOCIATIVE_RENDER_OPERATORS = Object.freeze(["+", "-", "*", "/"]);

const UNARY_PRECEDENCE = 5;
const ATOM_PRECEDENCE = 100;
const A1_PATTERN = /^\$?[A-Z]+\$?[0-9]+$/;

// ---------------------------------------------------------------------------
// Node constructors. Each validates eagerly, so a malformed tree cannot be
// built in the first place; the renderer re-validates so a tree assembled or
// mutated by hand is caught too.
// ---------------------------------------------------------------------------

/** An A1 cell address, relative or absolute in either axis. */
export function ref(text) {
  const value = String(text);
  if (!A1_PATTERN.test(value)) {
    throw new FormulaAstError(`${value} is not an A1 cell address.`, {
      kind: "ref",
      text: value,
    });
  }
  return { kind: "ref", text: value, strict: true };
}

/**
 * A reference term the DSL received already formed and could not parse as A1.
 * The pre-AST emitter passed such terms through verbatim; this node keeps that
 * behaviour explicit and inspectable instead of implicit in a string join.
 */
export function opaqueRef(text) {
  const value = String(text);
  if (value.length === 0 || /[,()="]/.test(value)) {
    throw new FormulaAstError(`${value} is not usable as a reference term.`, {
      kind: "ref",
      text: value,
    });
  }
  return { kind: "ref", text: value, strict: false };
}

/** A contiguous cell range, `from:to`. */
export function range(from, to) {
  assertNode(from, "range.from");
  assertNode(to, "range.to");
  return { kind: "range", from, to };
}

/** A number or string constant. Strings render quoted, Excel-escaped. */
export function literal(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new FormulaAstError("A literal must be a number or a string.", {
      kind: "literal",
      type: typeof value,
    });
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new FormulaAstError("A numeric literal must be finite.", {
      kind: "literal",
      value: String(value),
    });
  }
  return { kind: "literal", value };
}

/** Arithmetic negation. */
export function unary(operator, operand) {
  if (operator !== "-") {
    throw new FormulaAstError(`${operator} is not a declared unary operator.`, {
      kind: "unary",
      operator,
    });
  }
  assertNode(operand, "unary.operand");
  return { kind: "unary", operator, operand };
}

/**
 * A binary operation. Two operands is the ordinary case; more than two is the
 * flat left-associative chain the flat DSL rules produce (`subtract`,
 * `multiply`) and is permitted only for the declared associative-render set.
 */
export function binary(operator, operands) {
  if (!Object.hasOwn(BINARY_PRECEDENCE, operator)) {
    throw new FormulaAstError(`${operator} is not a declared binary operator.`, {
      kind: "binary",
      operator,
    });
  }
  if (!Array.isArray(operands) || operands.length < 2) {
    throw new FormulaAstError(`${operator} needs at least two operands.`, {
      kind: "binary",
      operator,
      operands: Array.isArray(operands) ? operands.length : null,
    });
  }
  if (operands.length > 2 && !ASSOCIATIVE_RENDER_OPERATORS.includes(operator)) {
    throw new FormulaAstError(`${operator} cannot render as an n-ary chain.`, {
      kind: "binary",
      operator,
      operands: operands.length,
    });
  }
  operands.forEach((operand, index) => assertNode(operand, `binary.${operator}[${index}]`));
  return { kind: "binary", operator, operands };
}

/** A call to a function in the closed vocabulary. */
export function call(name, args = []) {
  if (!FORMULA_FUNCTIONS.includes(name)) {
    throw new FormulaAstError(`${name} is not a declared formula function.`, {
      kind: "call",
      name,
    });
  }
  if (!Array.isArray(args)) {
    throw new FormulaAstError(`${name} requires an argument array.`, {
      kind: "call",
      name,
    });
  }
  args.forEach((argument, index) => assertNode(argument, `call.${name}[${index}]`));
  return { kind: "call", name, args };
}

/** `IF(test, whenTrue, whenFalse)`. */
export function conditional(test, whenTrue, whenFalse) {
  assertNode(test, "conditional.test");
  assertNode(whenTrue, "conditional.whenTrue");
  assertNode(whenFalse, "conditional.whenFalse");
  return { kind: "conditional", test, whenTrue, whenFalse };
}

/**
 * Declared parentheses. Use only where the grouping carries meaning the
 * precedence rules would not reproduce; the renderer already supplies every
 * parenthesis correctness requires.
 */
export function group(expression) {
  assertNode(expression, "group.expression");
  return { kind: "group", expression };
}

function assertNode(node, where) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new FormulaAstError(`${where} is not a formula AST node.`, { where });
  }
  if (!FORMULA_AST_NODE_KINDS.includes(node.kind)) {
    throw new FormulaAstError(`${where} has unknown node kind ${node.kind}.`, {
      where,
      kind: node.kind ?? null,
    });
  }
  return node;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function precedenceOf(node) {
  switch (node.kind) {
    case "binary":
      return BINARY_PRECEDENCE[node.operator] ?? ATOM_PRECEDENCE;
    case "unary":
      return UNARY_PRECEDENCE;
    default:
      return ATOM_PRECEDENCE;
  }
}

function renderQuoted(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Render a node to Excel expression text, without the leading `=`. */
export function renderExpression(node) {
  assertNode(node, "expression");
  switch (node.kind) {
    case "ref": {
      const text = String(node.text ?? "");
      if (node.strict === false) return opaqueRef(text).text;
      return ref(text).text;
    }
    case "range":
      return `${renderExpression(assertNode(node.from, "range.from"))}:${renderExpression(
        assertNode(node.to, "range.to"),
      )}`;
    case "literal": {
      const value = literal(node.value).value;
      return typeof value === "number" ? String(value) : renderQuoted(value);
    }
    case "unary": {
      if (node.operator !== "-") {
        throw new FormulaAstError(`${node.operator} is not a declared unary operator.`, {
          kind: "unary",
          operator: node.operator ?? null,
        });
      }
      const operand = assertNode(node.operand, "unary.operand");
      const text = renderExpression(operand);
      return precedenceOf(operand) < UNARY_PRECEDENCE
        ? `-(${text})`
        : `-${text}`;
    }
    case "binary": {
      // Re-run the constructor's checks so a hand-assembled or mutated node
      // cannot render with the wrong arity or an undeclared operator.
      binary(node.operator, node.operands);
      const parent = BINARY_PRECEDENCE[node.operator];
      return node.operands
        .map((operand, index) => {
          const text = renderExpression(operand);
          const child = precedenceOf(operand);
          // Position matters: the first operand of a same-precedence chain
          // needs no parentheses (left associativity), a later one does.
          const needed = index === 0 ? child < parent : child <= parent;
          return needed ? `(${text})` : text;
        })
        .join(node.operator);
    }
    case "call": {
      call(node.name, node.args);
      return `${node.name}(${node.args.map((argument) => renderExpression(argument)).join(",")})`;
    }
    case "conditional":
      return (
        `IF(${renderExpression(assertNode(node.test, "conditional.test"))},` +
        `${renderExpression(assertNode(node.whenTrue, "conditional.whenTrue"))},` +
        `${renderExpression(assertNode(node.whenFalse, "conditional.whenFalse"))})`
      );
    case "group":
      return `(${renderExpression(assertNode(node.expression, "group.expression"))})`;
    default:
      throw new FormulaAstError(`${node.kind} cannot be rendered.`, { kind: node.kind });
  }
}

/** Render a node to a complete Excel formula, `=` included. */
export function renderFormula(node) {
  return `=${renderExpression(node)}`;
}

/**
 * Node count along the longest path. A leaf is depth 1; the value is computed
 * from the tree, never declared. Chained associative operators stay at one
 * level whatever their operand count, so depth measures nesting rather than
 * width — width is what `semantic_references` already counts.
 */
export function astDepth(node) {
  assertNode(node, "expression");
  switch (node.kind) {
    case "ref":
    case "literal":
      return 1;
    case "range":
      return 1 + Math.max(astDepth(node.from), astDepth(node.to));
    case "unary":
      return 1 + astDepth(node.operand);
    case "group":
      return 1 + astDepth(node.expression);
    case "binary":
      return 1 + Math.max(...node.operands.map((operand) => astDepth(operand)));
    case "call":
      return (
        1 +
        (node.args.length === 0
          ? 0
          : Math.max(...node.args.map((argument) => astDepth(argument))))
      );
    case "conditional":
      return (
        1 +
        Math.max(
          astDepth(node.test),
          astDepth(node.whenTrue),
          astDepth(node.whenFalse),
        )
      );
    default:
      throw new FormulaAstError(`${node.kind} has no depth.`, { kind: node.kind });
  }
}

/** Every reference term in the tree, in render order. */
export function astReferences(node) {
  assertNode(node, "expression");
  switch (node.kind) {
    case "ref":
      return [String(node.text)];
    case "range":
      return [`${node.from.text}:${node.to.text}`];
    case "literal":
      return [];
    case "unary":
      return astReferences(node.operand);
    case "group":
      return astReferences(node.expression);
    case "binary":
      return node.operands.flatMap((operand) => astReferences(operand));
    case "call":
      return node.args.flatMap((argument) => astReferences(argument));
    case "conditional":
      return [
        ...astReferences(node.test),
        ...astReferences(node.whenTrue),
        ...astReferences(node.whenFalse),
      ];
    default:
      throw new FormulaAstError(`${node.kind} has no references.`, { kind: node.kind });
  }
}

/**
 * Prove that a tree still renders to the formula text that was shipped with
 * it. Returns an empty array when they agree and a one-line report of both
 * strings when they do not. A structurally invalid tree throws instead of
 * reporting, because there is no rendering to compare.
 */
export function verifyFormulaAst(node, formula) {
  const rendered = renderFormula(node);
  const expected = typeof formula === "string" ? formula : String(formula);
  if (rendered === expected) return [];
  return [
    `Formula AST renders ${rendered} but the accompanying formula text is ${expected}.`,
  ];
}
