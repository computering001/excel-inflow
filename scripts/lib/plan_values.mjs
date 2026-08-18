/**
 * plan_values.mjs — the cached value of a formula the solver does not state.
 *
 * WHY THIS EXISTS. A cached value is the number a reader sees BEFORE Excel
 * recalculates, and for most of the model the solver already knows it: it
 * solved the case. But the solver's horizon is the three FORECAST years, and it
 * says nothing about three other populations of formula cell:
 *
 *   * the HISTORICAL columns, whose subtotals (`SUM(G19,G20,G21)`) are
 *     arithmetic over hardcoded reported figures and were never solved because
 *     they were never forecast;
 *   * the PRO-FORMA-HISTORICAL column, every cell of which is `=I{row}` after
 *     the terminal rewrite — an alias, not a calculation;
 *   * the BROKERS sheet, whose selector picks one of the pack's own rows.
 *
 * Those values used to come from LibreOffice, which made a converter the SOURCE
 * of a third of the workbook's cached numbers rather than a check on them. They
 * are computed here instead, from the plan's OWN cells, so that the whole of
 * the cached layer is Node-side and LibreOffice becomes an independent second
 * opinion.
 *
 * THE SCOPE IS DELIBERATELY CLOSED. This is not a spreadsheet engine and must
 * never grow into one. It evaluates the vocabulary this emitter actually
 * writes — IF, IFERROR, SUM, MIN, MAX, ROUND, ABS, DATE, arithmetic, comparison,
 * concatenation, cell and range references including cross-sheet ones — and
 * REFUSES anything else by name. A formula it does not understand is reported,
 * not guessed at: a wrong cached value is worse than an absent one, because a
 * reader has no way to tell it apart from a right one.
 *
 * CIRCULARITY IS NOT EVALUATED, BY DESIGN. The interest / debt balance / cash
 * sweep loop is a declared circularity (ARCHITECTURE G2, `iterate="1"` in
 * calcPr) and iterating it here would be a second, silently divergent
 * implementation of the solver. Every cell inside the loop already carries the
 * SOLVER's value, which terminates the walk; a cell that still closes a cycle
 * is reported as unresolved and named.
 */

import { compareExcelValues } from "./excel_value_semantics.mjs";

const EMPTY = Symbol("empty");

class FormulaError {
  constructor(code) {
    this.code = code;
  }
}

const DIV0 = new FormulaError("#DIV/0!");
const VALUE = new FormulaError("#VALUE!");
const REF = new FormulaError("#REF!");

const isError = (value) => value instanceof FormulaError;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function columnNumberOf(name) {
  let total = 0;
  for (const character of name) total = total * 26 + (character.charCodeAt(0) - 64);
  return total;
}

function columnNameOf(number) {
  let name = "";
  let value = number;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

const FUNCTIONS = new Set([
  "IF", "IFERROR", "AND", "OR", "SUM", "AVERAGE", "COUNT", "MIN", "MAX", "ROUND", "ABS", "DATE",
]);

// A reference, with an optional quoted sheet name and an optional second
// corner. `$` is anchoring and carries no meaning once the formula is written.
const REFERENCE =
  /^(?:'((?:[^']|'')+)'!|([A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Z]{1,3}\$?\d{1,7})(?::(\$?[A-Z]{1,3}\$?\d{1,7}))?/;

function tokenise(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === " " || character === "\t" || character === "\n") {
      index += 1;
      continue;
    }
    if (character === '"') {
      let cursor = index + 1;
      let value = "";
      while (cursor < text.length) {
        if (text[cursor] === '"') {
          if (text[cursor + 1] === '"') {
            value += '"';
            cursor += 2;
            continue;
          }
          break;
        }
        value += text[cursor];
        cursor += 1;
      }
      tokens.push({ type: "string", value });
      index = cursor + 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(text[index + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
      tokens.push({ type: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    const twoCharacter = text.slice(index, index + 2);
    if (twoCharacter === "<=" || twoCharacter === ">=" || twoCharacter === "<>") {
      tokens.push({ type: "op", value: twoCharacter });
      index += 2;
      continue;
    }
    if ("+-*/^&=<>(),%".includes(character)) {
      tokens.push({ type: character === "(" || character === ")" || character === "," ? character : "op", value: character });
      index += 1;
      continue;
    }
    const rest = text.slice(index);
    const name = /^[A-Za-z_][A-Za-z0-9_.]*(?=\s*\()/.exec(rest);
    if (name) {
      tokens.push({ type: "function", value: name[0].toUpperCase() });
      index += name[0].length;
      continue;
    }
    const reference = REFERENCE.exec(rest);
    if (reference) {
      tokens.push({
        type: "reference",
        sheet: reference[1] ? reference[1].replace(/''/g, "'") : reference[2] ?? null,
        first: reference[3].replace(/\$/g, ""),
        last: reference[4] ? reference[4].replace(/\$/g, "") : null,
      });
      index += reference[0].length;
      continue;
    }
    const word = /^(TRUE|FALSE)\b/i.exec(rest);
    if (word) {
      tokens.push({ type: "boolean", value: word[0].toUpperCase() === "TRUE" });
      index += word[0].length;
      continue;
    }
    throw new UnsupportedFormula(`unrecognised token at "${rest.slice(0, 24)}"`);
  }
  return tokens;
}

export class UnsupportedFormula extends Error {}

// ---------------------------------------------------------------------------
// Parser — precedence exactly as Excel resolves it.
// ---------------------------------------------------------------------------

function parse(tokens) {
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = (type) => {
    const token = take();
    if (!token || token.type !== type) {
      throw new UnsupportedFormula(`expected ${type}`);
    }
    return token;
  };

  function primary() {
    const token = take();
    if (!token) throw new UnsupportedFormula("unexpected end of formula");
    if (token.type === "op" && (token.value === "-" || token.value === "+")) {
      return { kind: "unary", op: token.value, operand: primary() };
    }
    let node;
    if (token.type === "number") node = { kind: "number", value: token.value };
    else if (token.type === "string") node = { kind: "string", value: token.value };
    else if (token.type === "boolean") node = { kind: "boolean", value: token.value };
    else if (token.type === "reference") node = { kind: "reference", token };
    else if (token.type === "(") {
      node = expression();
      expect(")");
    } else if (token.type === "function") {
      if (!FUNCTIONS.has(token.value)) {
        throw new UnsupportedFormula(`function ${token.value} is outside the closed vocabulary`);
      }
      expect("(");
      const args = [];
      if (peek()?.type !== ")") {
        args.push(expression());
        while (peek()?.type === ",") {
          take();
          args.push(expression());
        }
      }
      expect(")");
      node = { kind: "call", name: token.value, args };
    } else {
      throw new UnsupportedFormula(`unexpected ${token.type}`);
    }
    while (peek()?.type === "op" && peek().value === "%") {
      take();
      node = { kind: "percent", operand: node };
    }
    return node;
  }

  function power() {
    let left = primary();
    while (peek()?.type === "op" && peek().value === "^") {
      take();
      left = { kind: "binary", op: "^", left, right: primary() };
    }
    return left;
  }

  function product() {
    let left = power();
    while (peek()?.type === "op" && (peek().value === "*" || peek().value === "/")) {
      const op = take().value;
      left = { kind: "binary", op, left, right: power() };
    }
    return left;
  }

  function sum() {
    let left = product();
    while (peek()?.type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = take().value;
      left = { kind: "binary", op, left, right: product() };
    }
    return left;
  }

  function concat() {
    let left = sum();
    while (peek()?.type === "op" && peek().value === "&") {
      take();
      left = { kind: "binary", op: "&", left, right: sum() };
    }
    return left;
  }

  function expression() {
    let left = concat();
    while (
      peek()?.type === "op" &&
      ["=", "<>", "<", ">", "<=", ">="].includes(peek().value)
    ) {
      const op = take().value;
      left = { kind: "binary", op, left, right: concat() };
    }
    return left;
  }

  const tree = expression();
  if (position !== tokens.length) throw new UnsupportedFormula("trailing tokens");
  return tree;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function toNumber(value) {
  if (isError(value)) return value;
  if (value === EMPTY) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (value.trim() === "") return VALUE;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : VALUE;
  }
  return VALUE;
}

function toText(value) {
  if (value === EMPTY) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function truthy(value) {
  if (isError(value)) return value;
  if (value === EMPTY) return false;
  if (typeof value === "boolean") return value;
  const numeric = toNumber(value);
  return isError(numeric) ? numeric : numeric !== 0;
}

/**
 * Excel's comparison, including the two blank-cell rules that matter here: a
 * blank equals "" and a blank equals 0. `IF(D6="",D13,D6)` on the Brokers sheet
 * is exactly that test — "did this house publish an estimate" — so getting it
 * wrong would silently pick the wrong broker's number.
 */
function compare(left, right) {
  return compareExcelValues(left, right, { isBlank: (value) => value === EMPTY });
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

class Evaluator {
  constructor(sheets) {
    this.sheets = sheets; // name -> Map(address -> cell)
    this.visiting = new Set();
    this.unresolved = [];
    this.filled = 0;
  }

  cell(sheetName, address) {
    return this.sheets.get(sheetName)?.get(address) ?? null;
  }

  /** The value of one cell, computing and CACHING it if it is a formula. */
  valueOf(sheetName, address) {
    const cell = this.cell(sheetName, address);
    if (!cell) return EMPTY;
    if (cell.formula === undefined) {
      return cell.value === undefined ? EMPTY : cell.value;
    }
    if (cell.cachedValue !== undefined) return cell.cachedValue;
    const key = `${sheetName}!${address}`;
    if (this.visiting.has(key)) {
      // A declared circularity the solver did not terminate. Reported, never
      // iterated: see the note at the top of this file.
      this.unresolved.push({ cell: key, reason: "circular reference not terminated by a solver value" });
      return EMPTY;
    }
    this.visiting.add(key);
    let result;
    try {
      result = this.evaluate(parse(tokenise(cell.formula)), sheetName);
    } catch (error) {
      if (error instanceof UnsupportedFormula) {
        this.unresolved.push({ cell: key, reason: `${error.message}: ${cell.formula}` });
        result = EMPTY;
      } else {
        throw error;
      }
    } finally {
      this.visiting.delete(key);
    }
    if (isError(result)) {
      this.unresolved.push({ cell: key, reason: `formula evaluates to ${result.code}` });
      return result;
    }
    // A FORMULA NEVER RETURNS A BLANK. `=I22` pointing at an empty cell is
    // zero, not nothing, and that is the number a reader sees — so it is the
    // number cached. Only a LITERAL empty cell stays blank, which is what makes
    // `IF(D6="",...)` on the Brokers sheet mean "this house published nothing".
    if (result === EMPTY) result = 0;
    cell.cachedValue = result;
    cell.cachedType =
      typeof result === "number" ? "n" : typeof result === "boolean" ? "b" : "s";
    this.filled += 1;
    return result;
  }

  rangeValues(node, sheetName) {
    const token = node.token;
    const sheet = token.sheet ?? sheetName;
    if (!this.sheets.has(sheet)) return [REF];
    if (!token.last) return [this.valueOf(sheet, token.first)];
    const first = /^([A-Z]+)(\d+)$/.exec(token.first);
    const last = /^([A-Z]+)(\d+)$/.exec(token.last);
    const firstColumn = Math.min(columnNumberOf(first[1]), columnNumberOf(last[1]));
    const lastColumn = Math.max(columnNumberOf(first[1]), columnNumberOf(last[1]));
    const firstRow = Math.min(Number(first[2]), Number(last[2]));
    const lastRow = Math.max(Number(first[2]), Number(last[2]));
    const values = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        values.push(this.valueOf(sheet, columnNameOf(column) + row));
      }
    }
    return values;
  }

  evaluate(node, sheetName) {
    switch (node.kind) {
      case "number":
      case "string":
      case "boolean":
        return node.value;
      case "reference": {
        if (node.token.last) {
          throw new UnsupportedFormula("a range is only meaningful inside SUM, MIN or MAX");
        }
        const sheet = node.token.sheet ?? sheetName;
        if (!this.sheets.has(sheet)) return REF;
        return this.valueOf(sheet, node.token.first);
      }
      case "unary": {
        const operand = toNumber(this.evaluate(node.operand, sheetName));
        if (isError(operand)) return operand;
        return node.op === "-" ? -operand : operand;
      }
      case "percent": {
        const operand = toNumber(this.evaluate(node.operand, sheetName));
        return isError(operand) ? operand : operand / 100;
      }
      case "call":
        return this.call(node, sheetName);
      case "binary":
        return this.binary(node, sheetName);
      default:
        throw new UnsupportedFormula(`unknown node ${node.kind}`);
    }
  }

  binary(node, sheetName) {
    if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
      const left = this.evaluate(node.left, sheetName);
      if (isError(left)) return left;
      const right = this.evaluate(node.right, sheetName);
      if (isError(right)) return right;
      const order = compare(left, right);
      switch (node.op) {
        case "=": return order === 0;
        case "<>": return order !== 0;
        case "<": return order < 0;
        case ">": return order > 0;
        case "<=": return order <= 0;
        default: return order >= 0;
      }
    }
    if (node.op === "&") {
      const left = this.evaluate(node.left, sheetName);
      if (isError(left)) return left;
      const right = this.evaluate(node.right, sheetName);
      if (isError(right)) return right;
      return toText(left) + toText(right);
    }
    const left = toNumber(this.evaluate(node.left, sheetName));
    if (isError(left)) return left;
    const right = toNumber(this.evaluate(node.right, sheetName));
    if (isError(right)) return right;
    switch (node.op) {
      case "+": return left + right;
      case "-": return left - right;
      case "*": return left * right;
      case "/": return right === 0 ? DIV0 : left / right;
      case "^": return left ** right;
      default: throw new UnsupportedFormula(`operator ${node.op}`);
    }
  }

  call(node, sheetName) {
    const { name, args } = node;
    if (name === "IF") {
      const condition = truthy(this.evaluate(args[0], sheetName));
      if (isError(condition)) return condition;
      if (condition) return args[1] ? this.evaluate(args[1], sheetName) : true;
      return args[2] ? this.evaluate(args[2], sheetName) : false;
    }
    if (name === "IFERROR") {
      const value = this.evaluate(args[0], sheetName);
      return isError(value) ? this.evaluate(args[1], sheetName) : value;
    }
    if (name === "AND" || name === "OR") {
      const values = args.map((argument) => truthy(this.evaluate(argument, sheetName)));
      const error = values.find((value) => isError(value));
      if (error) return error;
      return name === "AND" ? values.every(Boolean) : values.some(Boolean);
    }
    if (name === "DATE") {
      const evaluated = args.map((argument) => toNumber(this.evaluate(argument, sheetName)));
      const error = evaluated.find((value) => isError(value));
      if (error) return error;
      const [year, month, day] = evaluated.map((value) => Math.trunc(value));
      if (![year, month, day].every(Number.isFinite)) return VALUE;
      // Excel's 1900 date system uses 1899-12-30 as its serial epoch. Date.UTC
      // deliberately supplies Excel's month/day rollover behaviour as well, so
      // DATE(2026,13,1) and DATE(2026,1,32) remain deterministic.
      return Date.UTC(year, month - 1, day) / 86_400_000 + 25_569;
    }
    if (name === "ABS") {
      const value = toNumber(this.evaluate(args[0], sheetName));
      return isError(value) ? value : Math.abs(value);
    }
    // SUM, MIN and MAX take ranges and ignore text, blanks and booleans inside
    // them — Excel's own rule, and the one that keeps a label in a summed
    // column from becoming a #VALUE!.
    const numbers = [];
    for (const argument of args) {
      const values =
        argument.kind === "reference" ? this.rangeValues(argument, sheetName) : [this.evaluate(argument, sheetName)];
      for (const value of values) {
        if (isError(value)) return value;
        if (value === EMPTY) continue;
        if (typeof value === "string") continue;
        if (typeof value === "boolean") {
          if (argument.kind === "reference") continue;
          numbers.push(value ? 1 : 0);
          continue;
        }
        numbers.push(value);
      }
    }
    if (name === "SUM") {
      let total = 0;
      for (const value of numbers) total += value;
      return total;
    }
    if (name === "AVERAGE") {
      return numbers.length === 0
        ? DIV0
        : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }
    if (name === "COUNT") return numbers.length;
    if (name === "MIN") return numbers.length === 0 ? 0 : Math.min(...numbers);
    if (name === "MAX") return numbers.length === 0 ? 0 : Math.max(...numbers);
    if (name === "ROUND") {
      const [value, digits] = numbers;
      const factor = 10 ** (digits ?? 0);
      // Excel rounds half away from zero; JavaScript's Math.round rounds half
      // up, which differs for negatives.
      const scaled = value * factor;
      const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
      return rounded / factor;
    }
    throw new UnsupportedFormula(`function ${name}`);
  }
}

/**
 * Fill in every cached value the solver did not state.
 *
 * `workbook` is a PlanWorkbook whose solver-supplied caches are already in
 * place; they are treated as ground truth and are never recomputed. Returns the
 * number filled and, crucially, the list of cells that could NOT be filled with
 * the reason for each — a formula shipping without a cache is a blank where a
 * number belongs, and the build says which ones rather than discovering it in
 * a reader's hands.
 */
export function fillCachedValues(workbook, options = {}) {
  const seedFilter = options.seedFilter ?? (() => true);
  const sheets = new Map();
  for (const sheet of workbook.sheets) {
    const cells = new Map();
    for (const address of sheet.cellAddresses()) cells.set(address, sheet.cellAt(address));
    sheets.set(sheet.name, cells);
  }
  const evaluator = new Evaluator(sheets);
  for (const [name, cells] of sheets) {
    for (const [address, cell] of cells) {
      if (cell.formula === undefined || cell.cachedValue !== undefined) continue;
      if (!seedFilter(name, address)) continue;
      evaluator.valueOf(name, address);
    }
  }
  return { filled: evaluator.filled, unresolved: evaluator.unresolved };
}

/**
 * Every numeric value on one sheet, formula caches included.
 *
 * The shape `solverFormulaCaches` expects for its prior-period seed: the first
 * forecast year looks back at the last historical column, and that column is on
 * the sheet rather than inside the solver's horizon. It used to be read out of
 * the recalculated package; it is read out of the plan here, which is what
 * takes LibreOffice off the critical path for producing a plan at all.
 */
export function planNumericCaches(sheet) {
  const values = new Map();
  for (const address of sheet.cellAddresses()) {
    const cell = sheet.cellAt(address);
    const value = cell.formula === undefined ? cell.value : cell.cachedValue;
    if (typeof value === "number" && Number.isFinite(value)) values.set(address, value);
  }
  return values;
}
