#!/usr/bin/env node
/**
 * Cache-parity validator — does each formula agree with its own cached result?
 *
 * An .xlsx stores TWO things per formula cell: the formula, and the cached
 * result Excel last computed for it. This pipeline recalculates through
 * LibreOffice and then OVERWRITES the caches with numbers from an independent
 * solver (`patchNumericFormulaCaches`). When the solver and the formula
 * disagree, the workbook DISPLAYS the solver's number while the formula says
 * something else. Every other check in this repo reads the cached value, so
 * every other check passes. Open the file in Excel, let it recalc, and the
 * number moves.
 *
 * This validator is the only thing that looks at both halves. For every
 * formula cell it re-evaluates the formula ONE STEP — from the *cached* values
 * of that cell's own precedents — and compares against that cell's own cached
 * value. One step is deliberate: it localises the blame to the cell whose
 * formula and cache actually contradict each other, instead of smearing a
 * single upstream error across every descendant.
 *
 * Deliberate circularity (the model gates real circularity on a control, and
 * calcPr carries iterate="1") is detected via strongly-connected components and
 * kept in its own bucket, judged against its own tolerance. Cells inside a live
 * cycle are never expected to agree exactly — iteration stops at calcPr's
 * iterateDelta — so residuals within that band are reported as informational
 * noise and never fail the build. A residual FAR outside it is not iteration
 * slop: a converged iterative workbook cannot carry a 136-unit residual, so
 * those are reported as real disagreements, tagged CIRCULAR so a reviewer knows
 * not to expect bit-exact equality. Nothing is ever solved for.
 *
 * Portable: JSZip + raw OOXML only. No private workbook library — this has to run
 * in both the target environment and local certification. Modelled on
 * validate_source_parity.mjs, whose
 * shared-formula rebasing and namespace-prefix-tolerant regexes are reused.
 *
 * Usage:
 *   node scripts/validate_cache_parity.mjs <workbook.xlsx> [options]
 *
 *   --json <out.json>   write the full report
 *   --tol <n>           absolute tolerance (default 1e-6)
 *   --rel <n>           relative tolerance (default 1e-9)
 *   --circ-tol <n>      convergence tolerance for cells inside a cycle
 *                       (default: calcPr iterateDelta, else 1e-3)
 *   --circ-rel <n>      relative convergence tolerance (default 1e-6)
 *   --limit <n>         max mismatches printed per bucket (default 40)
 *   --sheet <name>      restrict to one sheet
 *   --only <A1>         explain a single cell (prints precedent values)
 *   --show-noise        also print circular residuals inside the convergence band
 *
 * Exit 1 if any disagreement is found (acyclic, or circular beyond convergence
 * tolerance), else 0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import JSZip from "jszip";
import { applyExcelComparison } from "./lib/excel_value_semantics.mjs";
import { ECONOMIC_SOLVE_POLICY } from "./lib/economic_solve_policy.mjs";
import { canonicalJsonSha256 } from "./lib/equation_graph.mjs";

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const workbookPath = argv.find((a) => !a.startsWith("--"));
if (!workbookPath) {
  console.error(
    "usage: validate_cache_parity.mjs <workbook.xlsx> [--json out.json] [--tol 1e-6] [--rel 1e-9]\n" +
      "                                 [--limit 40] [--sheet <name>] [--only <A1>] [--show-circular]",
  );
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const jsonOut = opt("json", null);
const ABS_TOL = Number(opt("tol", ECONOMIC_SOLVE_POLICY.native_tolerances.currency));
const REL_TOL = Number(opt("rel", ECONOMIC_SOLVE_POLICY.native_tolerances.default));
const PRINT_LIMIT = Number(opt("limit", 40));
const ONLY_SHEET = opt("sheet", null);
const ONLY_CELL = opt("only", null);
const SHOW_NOISE = flag("show-noise");
const CIRC_TOL_ARG = argv.includes("--circ-tol") ? Number(opt("circ-tol")) : null;
const CIRC_REL = Number(opt("circ-rel", ECONOMIC_SOLVE_POLICY.native_tolerances.relative));

// ---------------------------------------------------------------- OOXML helpers
// Every regex carries an optional `prefix:` — this builder emits <x:c>, <x:f>,
// <x:v>, but LibreOffice round-trips emit bare <c>, <f>, <v>.

const P = "(?:[A-Za-z_][\\w.-]*:)?";
const tag = (name, attrsOnly = false) =>
  attrsOnly
    ? new RegExp(`<${P}${name}\\b([^>]*)\\/?>`, "g")
    : new RegExp(`<${P}${name}\\b[^>]*>([\\s\\S]*?)<\\/${P}${name}>`, "g");
const firstTagText = (xml, name) =>
  new RegExp(`<${P}${name}\\b[^>]*>([\\s\\S]*?)<\\/${P}${name}>`).exec(xml)?.[1] ?? null;

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

const columnNumber = (letters) =>
  [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const columnLetters = (n) => {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - r - 1) / 26;
  }
  return s;
};

/**
 * Shift a shared-formula master into a slave cell's frame of reference.
 * Lifted from validate_source_parity.mjs. A slave carries <f t="shared" si="N"/>
 * with NO text; without this rebase every slave is evaluated at the master's
 * coordinates and the validator is confidently wrong.
 */
function shiftSharedFormula(text, base, target) {
  const b = /^([A-Z]+)(\d+)$/.exec(base);
  const t = /^([A-Z]+)(\d+)$/.exec(target);
  if (!b || !t) return text;
  const dc = columnNumber(t[1]) - columnNumber(b[1]);
  const dr = Number(t[2]) - Number(b[2]);
  return text
    .split(/("(?:[^"]|"")*")/)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(
            /(?<![A-Za-z0-9_.!])(\$?)([A-Z]{1,3})(\$?)(\d+)/g,
            (m, ac, col, ar, row) => {
              const c = ac ? col : columnLetters(columnNumber(col) + dc);
              const r = ar ? Number(row) : Number(row) + dr;
              return !c || r < 1 ? m : `${ac}${c}${ar}${r}`;
            },
          ),
    )
    .join("");
}

// ---------------------------------------------------------------- load workbook

const zip = await JSZip.loadAsync(readFileSync(workbookPath));

const relsXml = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
const rels = new Map();
for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
  const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
  const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
  if (id && target) rels.set(id, target);
}

const wbXml = await zip.file("xl/workbook.xml").async("string");
const sheetOrder = [];
for (const m of wbXml.matchAll(tag("sheet", true))) {
  const name = /\bname="([^"]+)"/.exec(m[1])?.[1];
  const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1];
  if (!name || !rid) continue;
  const t = rels.get(rid) ?? "";
  const path = t.startsWith("/") ? t.slice(1) : t.startsWith("xl/") ? t : `xl/${t}`;
  sheetOrder.push({ name: decodeXml(name), path });
}
if (!sheetOrder.length) throw new Error("no sheets found in workbook.xml");

const calcPr = /<[A-Za-z_:\w.-]*calcPr\b([^>]*)>/.exec(wbXml)?.[1] ?? "";
const iterationEnabled = /\biterate="(1|true)"/.test(calcPr);
const iterateDelta = Number(
  /\biterateDelta="([^"]+)"/.exec(calcPr)?.[1] ??
    ECONOMIC_SOLVE_POLICY.workbook_calculation.iterate_delta,
);
const calcAttribute = (name) => new RegExp(`\\b${name}="([^"]+)"`).exec(calcPr)?.[1] ?? null;
const expectedCalc = ECONOMIC_SOLVE_POLICY.workbook_calculation;
const calcContractErrors = [];
for (const [name, actual, expected] of [
  ["calcId", calcAttribute("calcId"), String(expectedCalc.calc_id)],
  ["calcMode", calcAttribute("calcMode"), expectedCalc.calc_mode],
  ["fullCalcOnLoad", /^(1|true)$/.test(calcAttribute("fullCalcOnLoad") ?? ""), expectedCalc.full_calc_on_load],
  ["forceFullCalc", /^(1|true)$/.test(calcAttribute("forceFullCalc") ?? ""), expectedCalc.force_full_calc],
  ["iterate", iterationEnabled, expectedCalc.iterate],
  ["iterateCount", Number(calcAttribute("iterateCount")), expectedCalc.iterate_count],
  ["iterateDelta", Number(calcAttribute("iterateDelta")), expectedCalc.iterate_delta],
]) {
  if (actual !== expected) calcContractErrors.push({ attribute: name, actual, expected });
}
// The workbook states its own convergence band. Honour it rather than inventing
// one: anything inside it is iteration slop, anything outside it is a defect.
const CIRC_TOL = CIRC_TOL_ARG ?? Math.max(iterateDelta, ABS_TOL);

// shared strings
const sstXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
const sst = [...sstXml.matchAll(tag("si"))].map((m) =>
  [...m[1].matchAll(tag("t"))].map((x) => decodeXml(x[1])).join(""),
);

const BLANK = Symbol("blank");
const mkErr = (code) => ({ __err: code });
const isErr = (v) => v !== null && typeof v === "object" && "__err" in v;

/** sheetName -> Map<ref, cell> */
const sheets = new Map();

for (const { name, path } of sheetOrder) {
  const file = zip.file(path);
  if (!file) continue;
  const xml = await file.async("string");

  // Shared-formula masters: si -> { text, base }. A master is the <f t="shared"
  // si="N" ref="..."> that actually carries formula text.
  const masters = new Map();
  const cellRe = new RegExp(
    `<${P}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${P}c>)`,
    "g",
  );
  const fRe = new RegExp(`<${P}f\\b([^>]*?)(?:>([\\s\\S]*?)<\\/${P}f>|\\/>)`);
  const vRe = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)<\\/${P}v>`);
  const isRe = new RegExp(`<${P}is\\b[^>]*>([\\s\\S]*?)<\\/${P}is>`);

  for (const m of xml.matchAll(cellRe)) {
    const inner = m[2] ?? "";
    const ref = /\br="([A-Z]+\d+)"/.exec(m[1])?.[1];
    if (!ref) continue;
    const f = fRe.exec(inner);
    if (!f) continue;
    const si = /\bsi="(\d+)"/.exec(f[1] ?? "")?.[1];
    if (si != null && f[2]) masters.set(si, { text: decodeXml(f[2]), base: ref });
  }

  const cells = new Map();
  for (const m of xml.matchAll(cellRe)) {
    const attrs = m[1];
    const inner = m[2] ?? "";
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";

    const f = fRe.exec(inner);
    let formula = null;
    let shared = false;
    if (f) {
      formula = f[2] ? decodeXml(f[2]) : "";
      if (!formula) {
        // Shared-formula slave: text lives on the master and MUST be rebased.
        const si = /\bsi="(\d+)"/.exec(f[1] ?? "")?.[1];
        const master = si != null ? masters.get(si) : null;
        if (master) {
          formula = shiftSharedFormula(master.text, master.base, ref);
          shared = true;
        } else {
          formula = null; // array/dataTable slave we cannot reconstruct
        }
      }
    }

    const raw = vRe.exec(inner)?.[1] ?? null;
    let value;
    if (t === "s") value = raw == null ? BLANK : (sst[Number(raw)] ?? "");
    else if (t === "inlineStr") {
      const is = isRe.exec(inner)?.[1] ?? "";
      value = [...is.matchAll(tag("t"))].map((x) => decodeXml(x[1])).join("");
    } else if (t === "str") value = raw == null ? BLANK : decodeXml(raw);
    else if (t === "b") value = raw === "1";
    else if (t === "e") value = mkErr(raw == null ? "#N/A" : decodeXml(raw));
    else if (raw == null || raw === "") value = BLANK;
    else value = Number(raw);

    // A cell typed "n"/"str" whose stored text is not numeric is still text.
    if ((t === "n" || t === undefined) && typeof value === "number" && Number.isNaN(value)) {
      value = raw;
    }

    cells.set(ref, { ref, sheet: name, formula, shared, value, type: t, hasCache: raw != null });
  }
  sheets.set(name, cells);
}

const primarySheet = sheetOrder[0].name;
const getCell = (sheetName, ref) => sheets.get(sheetName)?.get(ref) ?? null;
const cellValue = (sheetName, ref) => {
  const c = getCell(sheetName, ref);
  return c ? c.value : BLANK;
};

// ---------------------------------------------------------------- tokenizer

const ERROR_LITERALS = ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#NUM!", "#N/A", "#NULL!", "#GETTING_DATA"];

class Unsupported extends Error {}
class ParseError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i += 1; continue; }

    // string literal
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += src[j];
        j += 1;
      }
      if (j >= n) throw new ParseError("unterminated string");
      out.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }

    // error literal
    if (ch === "#") {
      const lit = ERROR_LITERALS.find((e) => src.startsWith(e, i));
      if (!lit) throw new ParseError(`unknown error literal at ${i}`);
      out.push({ k: "err", v: lit });
      i += lit.length;
      continue;
    }

    // number
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }

    // sheet-qualified reference / range
    const qual = /^(?:'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_.]*))!/.exec(src.slice(i));
    if (qual) {
      const sheetName = (qual[1] ?? qual[2]).replace(/''/g, "'");
      const rest = src.slice(i + qual[0].length);
      const rr = /^(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/.exec(rest);
      if (!rr) throw new ParseError(`sheet ref without cell at ${i}`);
      out.push({ k: "ref", sheet: sheetName, a: rr[1], b: rr[2] ?? null });
      i += qual[0].length + rr[0].length;
      continue;
    }

    // bare reference / range — but only when not immediately a function call
    const rr = /^(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/.exec(src.slice(i));
    if (rr && src[i + rr[0].length] !== "(") {
      out.push({ k: "ref", sheet: null, a: rr[1], b: rr[2] ?? null });
      i += rr[0].length;
      continue;
    }

    // identifier (function name / TRUE / FALSE / defined name)
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }

    // operators
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") { out.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>(),%:;".includes(ch)) { out.push({ k: "op", v: ch }); i += 1; continue; }

    throw new ParseError(`unexpected character '${ch}' at ${i}`);
  }
  return out;
}

// ---------------------------------------------------------------- parser
// Precedence follows Excel: unary minus binds tighter than ^ (=-2^2 is 4).

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (k, v) => {
    const t = tokens[p];
    if (!t || t.k !== k || (v !== undefined && t.v !== v)) return null;
    p += 1;
    return t;
  };
  const expect = (k, v) => {
    const t = eat(k, v);
    if (!t) throw new ParseError(`expected ${v ?? k} at token ${p}`);
    return t;
  };

  function primary() {
    const t = peek();
    if (!t) throw new ParseError("unexpected end of formula");
    if (t.k === "num") { p += 1; return { n: "num", v: t.v }; }
    if (t.k === "str") { p += 1; return { n: "str", v: t.v }; }
    if (t.k === "err") { p += 1; return { n: "err", v: t.v }; }
    if (t.k === "ref") { p += 1; return { n: "ref", sheet: t.sheet, a: t.a, b: t.b }; }
    if (t.k === "op" && t.v === "(") {
      p += 1;
      const e = expr();
      expect("op", ")");
      return e;
    }
    if (t.k === "id") {
      p += 1;
      const name = t.v.toUpperCase();
      if (eat("op", "(")) {
        const args = [];
        if (!eat("op", ")")) {
          for (;;) {
            args.push(expr());
            if (eat("op", ",") || eat("op", ";")) continue;
            expect("op", ")");
            break;
          }
        }
        return { n: "call", name, args };
      }
      if (name === "TRUE") return { n: "bool", v: true };
      if (name === "FALSE") return { n: "bool", v: false };
      throw new Unsupported(`defined name or bare identifier '${t.v}'`);
    }
    throw new ParseError(`unexpected token ${JSON.stringify(t)}`);
  }

  function postfix() {
    let e = primary();
    while (peek() && peek().k === "op" && peek().v === "%") { p += 1; e = { n: "pct", a: e }; }
    return e;
  }
  function unary() {
    const t = peek();
    if (t && t.k === "op" && (t.v === "-" || t.v === "+")) {
      p += 1;
      const a = unary();
      return t.v === "-" ? { n: "neg", a } : a;
    }
    return postfix();
  }
  function power() {
    let l = unary();
    while (peek() && peek().k === "op" && peek().v === "^") { p += 1; l = { n: "bin", op: "^", l, r: unary() }; }
    return l;
  }
  function mul() {
    let l = power();
    while (peek() && peek().k === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = tokens[p++].v;
      l = { n: "bin", op, l, r: power() };
    }
    return l;
  }
  function add() {
    let l = mul();
    while (peek() && peek().k === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = tokens[p++].v;
      l = { n: "bin", op, l, r: mul() };
    }
    return l;
  }
  function concat() {
    let l = add();
    while (peek() && peek().k === "op" && peek().v === "&") { p += 1; l = { n: "bin", op: "&", l, r: add() }; }
    return l;
  }
  function expr() {
    let l = concat();
    while (peek() && peek().k === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek().v)) {
      const op = tokens[p++].v;
      l = { n: "bin", op, l, r: concat() };
    }
    return l;
  }

  const root = expr();
  if (p !== tokens.length) throw new ParseError(`trailing tokens at ${p}`);
  return root;
}

const astCache = new Map();
function compile(formula) {
  if (astCache.has(formula)) return astCache.get(formula);
  const body = formula.startsWith("=") ? formula.slice(1) : formula;
  const ast = parse(tokenize(body));
  astCache.set(formula, ast);
  return ast;
}

// ---------------------------------------------------------------- ref helpers

const stripAbs = (r) => r.replace(/\$/g, "");
function expandRange(sheetName, a, b) {
  const A = /^([A-Z]+)(\d+)$/.exec(stripAbs(a));
  const B = /^([A-Z]+)(\d+)$/.exec(stripAbs(b));
  if (!A || !B) return [];
  const c1 = Math.min(columnNumber(A[1]), columnNumber(B[1]));
  const c2 = Math.max(columnNumber(A[1]), columnNumber(B[1]));
  const r1 = Math.min(Number(A[2]), Number(B[2]));
  const r2 = Math.max(Number(A[2]), Number(B[2]));
  const out = [];
  for (let c = c1; c <= c2; c += 1) for (let r = r1; r <= r2; r += 1) out.push(`${columnLetters(c)}${r}`);
  return out;
}

/** All precedent cells of an AST, as {sheet, ref} pairs. */
function precedents(ast, ctxSheet, acc = []) {
  if (!ast || typeof ast !== "object") return acc;
  if (ast.n === "ref") {
    const s = ast.sheet ?? ctxSheet;
    if (ast.b) for (const r of expandRange(s, ast.a, ast.b)) acc.push({ sheet: s, ref: r });
    else acc.push({ sheet: s, ref: stripAbs(ast.a) });
    return acc;
  }
  for (const k of ["a", "l", "r"]) if (ast[k]) precedents(ast[k], ctxSheet, acc);
  if (ast.args) for (const a of ast.args) precedents(a, ctxSheet, acc);
  return acc;
}

// ---------------------------------------------------------------- dates
// Excel serial: day 0 = 1899-12-30 (1900 system). Pre-1900-03-01 dates carry
// the historical leap-year bug; this model deals only in modern dates, so the
// simple epoch is exact for everything it emits.

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;
const toSerial = (y, m, d) => (Date.UTC(y, m - 1, d) - EPOCH) / DAY;
const fromSerial = (s) => new Date(EPOCH + Math.floor(s) * DAY);

// ---------------------------------------------------------------- evaluator

function toNum(v) {
  if (isErr(v)) return v;
  if (v === BLANK) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (v.trim() === "") return 0;
    const n = Number(v);
    return Number.isNaN(n) ? mkErr("#VALUE!") : n;
  }
  return mkErr("#VALUE!");
}
function toBool(v) {
  if (isErr(v)) return v;
  if (v === BLANK) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
    return mkErr("#VALUE!");
  }
  return mkErr("#VALUE!");
}
function toStr(v) {
  if (isErr(v)) return v;
  if (v === BLANK) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return String(v);
}

/** Flatten function arguments; ranges become arrays of raw cell values. */
function flatten(vals) {
  const out = [];
  for (const v of vals) {
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}
/** Numeric members of an argument list, Excel-style (skip blanks/text in ranges). */
function numericArgs(args, rawArgs) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i];
    if (Array.isArray(v)) {
      for (const x of v) {
        if (isErr(x)) return x;
        if (typeof x === "number") out.push(x);
      }
    } else {
      if (isErr(v)) return v;
      if (v === BLANK) {
        // A direct blank reference contributes nothing to SUM/AVERAGE.
        if (rawArgs?.[i]?.n === "ref") continue;
        out.push(0);
      } else if (typeof v === "number") out.push(v);
      else if (typeof v === "boolean") out.push(v ? 1 : 0);
      else if (typeof v === "string") {
        // Literal numeric strings coerce; text inside ranges is ignored.
        const n = Number(v);
        if (!Number.isNaN(n) && v.trim() !== "") out.push(n);
      }
    }
  }
  return out;
}

function xround(x, digits) {
  const f = 10 ** digits;
  const y = x * f;
  const r = y < 0 ? -Math.round(-y + Number.EPSILON * Math.abs(y)) : Math.round(y + Number.EPSILON * Math.abs(y));
  return r / f;
}

function compare(a, b, op) {
  try {
    return applyExcelComparison(a, b, op, {
      isBlank: (value) => value === BLANK,
    });
  } catch {
    return mkErr("#VALUE!");
  }
}

function evalNode(ast, ctxSheet) {
  switch (ast.n) {
    case "num": return ast.v;
    case "str": return ast.v;
    case "bool": return ast.v;
    case "err": return mkErr(ast.v);
    case "ref": {
      const s = ast.sheet ?? ctxSheet;
      if (!sheets.has(s)) return mkErr("#REF!");
      if (ast.b) return expandRange(s, ast.a, ast.b).map((r) => cellValue(s, r));
      return cellValue(s, stripAbs(ast.a));
    }
    case "neg": {
      const v = toNum(evalNode(ast.a, ctxSheet));
      return isErr(v) ? v : -v;
    }
    case "pct": {
      const v = toNum(evalNode(ast.a, ctxSheet));
      return isErr(v) ? v : v / 100;
    }
    case "bin": {
      const l = evalNode(ast.l, ctxSheet);
      const r = evalNode(ast.r, ctxSheet);
      if (isErr(l)) return l;
      if (isErr(r)) return r;
      if (["=", "<>", "<", ">", "<=", ">="].includes(ast.op)) {
        const c = compare(Array.isArray(l) ? l[0] : l, Array.isArray(r) ? r[0] : r, ast.op);
        return c;
      }
      if (ast.op === "&") {
        const a = toStr(Array.isArray(l) ? l[0] : l);
        const b = toStr(Array.isArray(r) ? r[0] : r);
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        return a + b;
      }
      const a = toNum(Array.isArray(l) ? l[0] : l);
      const b = toNum(Array.isArray(r) ? r[0] : r);
      if (isErr(a)) return a;
      if (isErr(b)) return b;
      switch (ast.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? mkErr("#DIV/0!") : a / b;
        case "^": return a ** b;
        default: throw new Unsupported(`operator ${ast.op}`);
      }
    }
    case "call": return evalCall(ast, ctxSheet);
    default: throw new Unsupported(`node ${ast.n}`);
  }
}

function evalCall(ast, ctxSheet) {
  const name = ast.name;
  const ev = (i) => evalNode(ast.args[i], ctxSheet);
  const scalar = (i) => {
    const v = ev(i);
    return Array.isArray(v) ? v[0] : v;
  };

  switch (name) {
    // --- control flow / error handling (must NOT eagerly propagate) ---
    case "IF": {
      const c = toBool(scalar(0));
      if (isErr(c)) return c;
      if (c) return ast.args.length > 1 ? scalar(1) : true;
      return ast.args.length > 2 ? scalar(2) : false;
    }
    case "IFERROR": {
      let v;
      try { v = scalar(0); } catch (e) { if (e instanceof Unsupported) throw e; v = mkErr("#VALUE!"); }
      return isErr(v) ? scalar(1) : v;
    }
    case "IFNA": {
      const v = scalar(0);
      return isErr(v) && v.__err === "#N/A" ? scalar(1) : v;
    }
    case "ISNUMBER": { const v = scalar(0); return typeof v === "number"; }
    case "ISBLANK": { const v = scalar(0); return v === BLANK; }
    case "ISERROR": { const v = scalar(0); return isErr(v); }
    case "ISTEXT": { const v = scalar(0); return typeof v === "string"; }
    case "NA": return mkErr("#N/A");

    // --- aggregation ---
    case "SUM": case "AVERAGE": case "MIN": case "MAX": case "COUNT":
    case "STDEV": case "MEDIAN": case "PRODUCT": {
      const vals = ast.args.map((_, i) => ev(i));
      const nums = numericArgs(vals, ast.args);
      if (isErr(nums)) return nums;
      switch (name) {
        case "SUM": return nums.reduce((a, b) => a + b, 0);
        case "COUNT": return nums.length;
        case "PRODUCT": return nums.reduce((a, b) => a * b, 1);
        case "AVERAGE": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : mkErr("#DIV/0!");
        case "MEDIAN": {
          if (!nums.length) return mkErr("#NUM!");
          const s = [...nums].sort((a, b) => a - b);
          const m = s.length >> 1;
          return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        }
        case "MIN": return nums.length ? Math.min(...nums) : 0;
        case "MAX": return nums.length ? Math.max(...nums) : 0;
        default: {
          if (nums.length < 2) return mkErr("#DIV/0!");
          const mu = nums.reduce((a, b) => a + b, 0) / nums.length;
          return Math.sqrt(nums.reduce((a, b) => a + (b - mu) ** 2, 0) / (nums.length - 1));
        }
      }
    }
    case "SUMPRODUCT": {
      const arrs = ast.args.map((_, i) => { const v = ev(i); return Array.isArray(v) ? v : [v]; });
      const len = arrs[0].length;
      let total = 0;
      for (let i = 0; i < len; i += 1) {
        let prod = 1;
        for (const arr of arrs) {
          const n = toNum(arr[i] ?? 0);
          if (isErr(n)) return n;
          prod *= n;
        }
        total += prod;
      }
      return total;
    }

    // --- logic ---
    case "AND": case "OR": {
      const vals = flatten(ast.args.map((_, i) => ev(i)));
      const bools = [];
      for (const v of vals) {
        if (isErr(v)) return v;
        if (v === BLANK) continue;
        const b = toBool(v);
        if (isErr(b)) return b;
        bools.push(b);
      }
      if (!bools.length) return mkErr("#VALUE!");
      return name === "AND" ? bools.every(Boolean) : bools.some(Boolean);
    }
    case "NOT": { const b = toBool(scalar(0)); return isErr(b) ? b : !b; }

    // --- maths ---
    case "ABS": case "SIGN": case "SQRT": case "INT": case "LN": case "EXP": {
      const x = toNum(scalar(0));
      if (isErr(x)) return x;
      if (name === "ABS") return Math.abs(x);
      if (name === "SIGN") return Math.sign(x);
      if (name === "SQRT") return x < 0 ? mkErr("#NUM!") : Math.sqrt(x);
      if (name === "INT") return Math.floor(x);
      if (name === "LN") return x <= 0 ? mkErr("#NUM!") : Math.log(x);
      return Math.exp(x);
    }
    case "ROUND": case "ROUNDUP": case "ROUNDDOWN": {
      const x = toNum(scalar(0));
      const d = ast.args.length > 1 ? toNum(scalar(1)) : 0;
      if (isErr(x)) return x;
      if (isErr(d)) return d;
      if (name === "ROUND") return xround(x, d);
      const f = 10 ** d;
      return name === "ROUNDUP"
        ? (x < 0 ? -Math.ceil(-x * f) : Math.ceil(x * f)) / f
        : (x < 0 ? -Math.floor(-x * f) : Math.floor(x * f)) / f;
    }
    case "POWER": {
      const a = toNum(scalar(0)); const b = toNum(scalar(1));
      if (isErr(a)) return a; if (isErr(b)) return b;
      return a ** b;
    }

    // --- dates ---
    case "DATE": {
      const y = toNum(scalar(0)); const m = toNum(scalar(1)); const d = toNum(scalar(2));
      if (isErr(y)) return y; if (isErr(m)) return m; if (isErr(d)) return d;
      return toSerial(Math.trunc(y), Math.trunc(m), Math.trunc(d));
    }
    case "YEAR": case "MONTH": case "DAY": {
      const s = toNum(scalar(0));
      if (isErr(s)) return s;
      if (s < 0) return mkErr("#NUM!");
      const dt = fromSerial(s);
      return name === "YEAR" ? dt.getUTCFullYear() : name === "MONTH" ? dt.getUTCMonth() + 1 : dt.getUTCDate();
    }
    case "EDATE": case "EOMONTH": {
      const s = toNum(scalar(0)); const k = toNum(scalar(1));
      if (isErr(s)) return s; if (isErr(k)) return k;
      const dt = fromSerial(s);
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth() + Math.trunc(k);
      if (name === "EOMONTH") return toSerial(y, m + 2, 0);
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return toSerial(y, m + 1, Math.min(dt.getUTCDate(), lastDay));
    }

    // --- text ---
    case "VALUE": {
      const v = scalar(0);
      if (isErr(v)) return v;
      if (typeof v === "number") return v;
      const n = Number(String(v === BLANK ? "" : v).trim());
      return Number.isNaN(n) ? mkErr("#VALUE!") : n;
    }
    case "MID": case "LEFT": case "RIGHT": {
      const s = toStr(scalar(0));
      if (isErr(s)) return s;
      if (name === "MID") {
        const start = toNum(scalar(1)); const len = toNum(scalar(2));
        if (isErr(start)) return start; if (isErr(len)) return len;
        if (start < 1 || len < 0) return mkErr("#VALUE!");
        return s.substr(Math.trunc(start) - 1, Math.trunc(len));
      }
      const len = ast.args.length > 1 ? toNum(scalar(1)) : 1;
      if (isErr(len)) return len;
      return name === "LEFT" ? s.slice(0, Math.trunc(len)) : s.slice(s.length - Math.trunc(len));
    }
    case "LEN": { const s = toStr(scalar(0)); return isErr(s) ? s : s.length; }
    case "TRIM": { const s = toStr(scalar(0)); return isErr(s) ? s : s.trim().replace(/\s+/g, " "); }
    case "CONCATENATE": {
      let out = "";
      for (let i = 0; i < ast.args.length; i += 1) {
        const s = toStr(scalar(i));
        if (isErr(s)) return s;
        out += s;
      }
      return out;
    }

    default:
      // Unknown functions are reported, never guessed. A validator that
      // invents semantics produces false failures and gets switched off.
      throw new Unsupported(`function ${name}()`);
  }
}

// ---------------------------------------------------------------- circularity (Tarjan SCC)

const formulaCells = [];
for (const [sheetName, cells] of sheets) {
  for (const c of cells.values()) if (c.formula) formulaCells.push(c);
}

const key = (s, r) => `${s}!${r}`;
const parsed = new Map(); // key -> {ast} | {error}
for (const c of formulaCells) {
  try {
    parsed.set(key(c.sheet, c.ref), { ast: compile(c.formula) });
  } catch (e) {
    parsed.set(key(c.sheet, c.ref), { error: e });
  }
}

const graph = new Map();
for (const c of formulaCells) {
  const k = key(c.sheet, c.ref);
  const p = parsed.get(k);
  const edges = [];
  if (p?.ast) {
    for (const pr of precedents(p.ast, c.sheet)) {
      const pk = key(pr.sheet, pr.ref);
      if (parsed.has(pk)) edges.push(pk);
    }
  }
  graph.set(k, edges);
}

const circular = new Set();
{
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const nodes = [...graph.keys()];
  // iterative Tarjan — the graph is small but recursion depth is not bounded
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work = [{ v: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.i === 0) {
        idx.set(v, index); low.set(v, index); index += 1;
        stack.push(v); onStack.add(v);
      }
      const edges = graph.get(v) ?? [];
      let recursed = false;
      while (frame.i < edges.length) {
        const w = edges[frame.i]; frame.i += 1;
        if (w === v) { circular.add(v); continue; } // self-reference
        if (!idx.has(w)) { work.push({ v: w, i: 0 }); recursed = true; break; }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      }
      if (recursed) continue;
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        for (;;) {
          const w = stack.pop(); onStack.delete(w); comp.push(w);
          if (w === v) break;
        }
        if (comp.length > 1) for (const w of comp) circular.add(w);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
    }
  }
}
// Anything reachable *into* a cycle is fine to check one-step; only the cycle
// members themselves are exempt.

// ---------------------------------------------------------------- compare

const labelFor = (sheetName, ref) => {
  const row = /\d+$/.exec(ref)?.[0];
  if (!row) return "";
  const b = getCell(sheetName, `B${row}`);
  const v = b?.value;
  return typeof v === "string" ? v.trim() : "";
};

const fmt = (v) => {
  if (v === BLANK) return "(blank)";
  if (isErr(v)) return v.__err;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toPrecision(12).replace(/0+$/, "");
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return JSON.stringify(v);
};

const results = {
  mismatches: [],           // acyclic cells: formula contradicts its own cache
  circular_mismatches: [],  // cells in a live cycle, residual beyond convergence band
  circular_noise: [],       // cells in a live cycle, residual inside convergence band
  unsupported: [],
  parse_errors: [],
  eval_errors: [],
  no_cache: [],
};
const stats = { formula_cells: formulaCells.length, checked: 0, agreed: 0, circular_cells: circular.size, shared_formula_cells: 0 };

for (const c of formulaCells) {
  if (ONLY_SHEET && c.sheet !== ONLY_SHEET) continue;
  if (ONLY_CELL && `${c.sheet}!${c.ref}` !== (ONLY_CELL.includes("!") ? ONLY_CELL : `${primarySheet}!${ONLY_CELL}`)) continue;
  if (c.shared) stats.shared_formula_cells += 1;

  const k = key(c.sheet, c.ref);
  const p = parsed.get(k);
  const rec = {
    sheet: c.sheet, cell: c.ref, ref: k, label: labelFor(c.sheet, c.ref),
    formula: c.formula, shared: c.shared,
  };

  if (p?.error) {
    (p.error instanceof Unsupported ? results.unsupported : results.parse_errors)
      .push({ ...rec, reason: p.error.message });
    continue;
  }
  if (!c.hasCache) { results.no_cache.push(rec); continue; }

  let computed;
  try {
    computed = evalNode(p.ast, c.sheet);
  } catch (e) {
    (e instanceof Unsupported ? results.unsupported : results.eval_errors)
      .push({ ...rec, reason: e.message });
    continue;
  }
  if (Array.isArray(computed)) computed = computed[0];

  stats.checked += 1;

  const cached = c.value;
  let agree;
  let delta = null;
  if (isErr(computed) || isErr(cached)) {
    agree = isErr(computed) && isErr(cached) && computed.__err === cached.__err;
  } else if (typeof computed === "string" || typeof cached === "string") {
    const a = computed === BLANK ? "" : toStr(computed);
    const b = cached === BLANK ? "" : toStr(cached);
    agree = a === b;
  } else {
    const a = computed === BLANK ? 0 : typeof computed === "boolean" ? (computed ? 1 : 0) : computed;
    const b = cached === BLANK ? 0 : typeof cached === "boolean" ? (cached ? 1 : 0) : cached;
    delta = a - b;
    agree = Math.abs(delta) <= Math.max(ABS_TOL, REL_TOL * Math.max(Math.abs(a), Math.abs(b)));
  }

  if (agree) { stats.agreed += 1; continue; }

  const isCircular = circular.has(k);
  const entry = {
    ...rec,
    circular: isCircular,
    cached: cached === BLANK ? null : isErr(cached) ? cached.__err : cached,
    computed: computed === BLANK ? null : isErr(computed) ? computed.__err : computed,
    delta,
    precedent_refs: [...new Set(precedents(p.ast, c.sheet).map((pr) => key(pr.sheet, pr.ref)))],
    precedents: precedents(p.ast, c.sheet).slice(0, 24).map((pr) => ({
      ref: key(pr.sheet, pr.ref),
      value: (() => { const v = cellValue(pr.sheet, pr.ref); return v === BLANK ? null : isErr(v) ? v.__err : v; })(),
    })),
  };

  if (!isCircular) { results.mismatches.push(entry); continue; }

  // Inside a live cycle the cache is only ever as good as the iteration that
  // produced it, so judge against the workbook's own convergence band.
  const withinConvergence =
    delta !== null &&
    Math.abs(delta) <= Math.max(CIRC_TOL, CIRC_REL * Math.abs(entry.cached ?? 0));
  if (withinConvergence) results.circular_noise.push(entry);
  else results.circular_mismatches.push(entry);
}

// Primary vs cascaded: a cell whose precedents are themselves disagreeing is
// usually collateral. Tagging it stops a reviewer chasing 40 symptoms of one
// cause — and stops anyone dismissing the whole report as noise.
{
  const bad = new Set([...results.mismatches, ...results.circular_mismatches].map((m) => m.ref));
  for (const m of [...results.mismatches, ...results.circular_mismatches]) {
    m.cascaded = m.precedent_refs.some((r) => r !== m.ref && bad.has(r));
  }
}

// ---------------------------------------------------------------- report

const sortKey = (a, b) => Math.abs(b.delta ?? Infinity) - Math.abs(a.delta ?? Infinity);
results.mismatches.sort(sortKey);
results.circular_mismatches.sort(sortKey);
results.circular_noise.sort(sortKey);

const total = results.mismatches.length + results.circular_mismatches.length;
const primary = [...results.mismatches, ...results.circular_mismatches].filter((m) => !m.cascaded).length;
const status = total || calcContractErrors.length ? "FAIL" : "PASS";

console.log(`\ncache-parity: ${status}   ${workbookPath}`);
console.log(
  `formula cells ${stats.formula_cells}  checked ${stats.checked}  agreed ${stats.agreed}` +
    `  shared-formula slaves ${stats.shared_formula_cells}`,
);
console.log(
  `DISAGREEMENTS ${total}  (${primary} primary, ${total - primary} cascaded)  ` +
    `= ${results.mismatches.length} acyclic + ${results.circular_mismatches.length} circular-beyond-convergence`,
);
console.log(
  `not checked: unsupported ${results.unsupported.length}, unparsed ${results.parse_errors.length}, ` +
    `eval-error ${results.eval_errors.length}, no-cache ${results.no_cache.length}`,
);
console.log(
  `iterative calc ${iterationEnabled ? "ENABLED" : "off"}; cells in a dependency cycle ${stats.circular_cells}; ` +
    `convergence band +/-${CIRC_TOL} (${results.circular_noise.length} residuals inside it, treated as noise)`,
);
if (calcContractErrors.length) {
  console.log(`calculation policy mismatches ${JSON.stringify(calcContractErrors)}`);
}

if (ONLY_CELL) {
  const all = [...results.mismatches, ...results.circular_mismatches, ...results.circular_noise];
  const c = formulaCells.find((x) => x.ref === ONLY_CELL.replace(/^.*!/, ""));
  console.log(`\n--- ${ONLY_CELL} ---`);
  if (c) console.log(`formula: ${c.formula}\ncached : ${fmt(c.value)}`);
  const m = all[0];
  if (m) {
    console.log(`computed: ${fmt(m.computed)}   delta ${m.delta}`);
    for (const pr of m.precedents) console.log(`   ${pr.ref.padEnd(28)} ${pr.value}`);
  } else console.log("agrees with its cache.");
}

const printBucket = (title, rows, limit = PRINT_LIMIT) => {
  if (!rows.length) return;
  console.log(`\n--- ${title} (${rows.length}) ---`);
  for (const m of rows.slice(0, limit)) {
    console.log(
      `  ${`${m.sheet}!${m.cell}`.padEnd(24)} ${String(m.label).slice(0, 34).padEnd(36)}` +
        ` cached=${fmt(m.cached ?? 0).padStart(16)}  formula=${fmt(m.computed ?? 0).padStart(16)}` +
        `  delta=${m.delta === null ? "n/a" : Number(m.delta.toPrecision(8))}` +
        `${m.cascaded ? "  [cascaded]" : m.cascaded === false ? "  [PRIMARY]" : ""}`,
    );
    console.log(`      = ${String(m.formula).slice(0, 150)}`);
  }
  if (rows.length > limit) console.log(`  ... ${rows.length - limit} more (see --json)`);
};

printBucket("FORMULA / CACHE DISAGREEMENTS — acyclic", results.mismatches);
printBucket(
  `CIRCULAR CELLS BEYOND THE CONVERGENCE BAND (+/-${CIRC_TOL}) — real disagreements, not iteration slop`,
  results.circular_mismatches,
);
if (SHOW_NOISE) printBucket("CIRCULAR residuals inside the convergence band (noise)", results.circular_noise);
else if (results.circular_noise.length)
  console.log(`\n(${results.circular_noise.length} circular residuals inside the convergence band suppressed; --show-noise to list)`);
printBucket("UNSUPPORTED CONSTRUCTS (not checked)", results.unsupported, 15);
printBucket("UNPARSED FORMULAS (not checked)", results.parse_errors, 15);
printBucket("EVALUATION ERRORS (not checked)", results.eval_errors, 15);

// Row-level rollup: a defect usually lands on a whole row, and the row name is
// what a reviewer actually recognises.
if (total) {
  const byRow = new Map();
  for (const m of [...results.mismatches, ...results.circular_mismatches]) {
    const r = `${m.sheet}!row ${/\d+$/.exec(m.cell)?.[0]}  ${m.label}`;
    byRow.set(r, (byRow.get(r) ?? 0) + 1);
  }
  console.log(`\n--- affected rows (${byRow.size}) ---`);
  for (const [r, n] of [...byRow.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}x  ${r}`);
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        workbook: workbookPath,
        status,
        disagreements: total,
        primary,
        tolerance: { abs: ABS_TOL, rel: REL_TOL, circular_abs: CIRC_TOL, circular_rel: CIRC_REL },
        stats,
        iterationEnabled,
        iterateDelta,
        calc_contract_errors: calcContractErrors,
        economic_solve_policy_sha256: canonicalJsonSha256(ECONOMIC_SOLVE_POLICY),
        ...results,
      },
      null,
      1,
    ),
  );
  console.log(`\nreport: ${jsonOut}`);
}

process.exit(status === "FAIL" ? 1 : 0);
