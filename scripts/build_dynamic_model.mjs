#!/usr/bin/env node

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
// THE EMITTER'S OWN RECORD OF WHAT IT DECIDED. See scripts/lib/plan_builder.mjs
// for why a plan captured from the finished package is not a plan that can
// ship: legacy workbook library builds that package and cannot go out with the skill.
import { PlanWorkbook } from "./lib/plan_builder.mjs";
// The cached values the SOLVER does not state — the historical columns, the
// pro-forma-historical alias and the Brokers selector. Computed from the plan's
// own cells so that no cached number in the workbook has a converter as its
// source. See scripts/lib/plan_values.mjs.
import { fillCachedValues, planNumericCaches } from "./lib/plan_values.mjs";
import { assessCoverage } from "./lib/coverage.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { instrumentDisplayLabel } from "./lib/instrument_display.mjs";
import { compileInstrumentPeriodState } from "./lib/instrument_period_state.mjs";
import { presentationEpoch, sharedHorizontalGrammar } from "./lib/design_contract.mjs";
// IMPORTED, NOT REIMPLEMENTED. The Brokers sheet states how many named houses
// supply each metric, and the broker-anchor rule DECIDES on that same number. A
// second count written beside the first is a second definition of "contributes",
// and the two would part company the first time either moved.
import { applyTier1AnchorOwnership, brokerContributorCount } from "./lib/broker_anchor.mjs";
import {
  benchmarkCurvePlan,
  compileRowPlan,
  groupSubtotalRank,
  headlineIds,
  isDeclaredStatementTotal,
  RANK_SECTION,
  TOTAL_RANK,
  totalRank,
} from "./lib/row_plan.mjs";
import {
  compileSemanticManifest,
  compileSourceCrosswalk,
  inferMovementType,
  sourceCrosswalkCsv,
} from "./lib/semantic_graph.mjs";
import {
  assertModelIrV3Pass,
  compileModelIrV3,
  forecastDecisionReceipt,
  forecastDecisionReceiptCsv,
  shadowSemanticComparison,
  transformationReceipt,
  workbookSemanticProofContract,
} from "./lib/model_ir_v3.mjs";
import {
  leaseHistoricalLiabilities,
  leaseOpeningLiability,
  normalisedCashBuckets,
  solveCase,
  validateCaseShape,
} from "./lib/solver.mjs";
import { assertWriteTargetOutsideSkill } from "./lib/runtime_isolation.mjs";
import { applyHistoricalNormalisation } from "./lib/historical_normalisation.mjs";
import { ensureIllustrativeAcquisitionCase } from "./lib/acquisition_policy.mjs";
import {
  balancingRcfInstrument,
  isBalancingRcf,
} from "./lib/rcf_policy.mjs";
import {
  leaseForecast,
  resolvedLeaseInterestBasis,
} from "./lib/lease_policy.mjs";
import { resolveForecastAuthority } from "./lib/forecast_authority.mjs";
import { explicitPlausibilityAcknowledgements } from "./lib/plausibility_acknowledgements.mjs";
import { compileStatementFormula } from "./lib/formula_dsl.mjs";
import {
  historicalInterestBasisLabel,
  resolveHistoricalInterestAuthority,
} from "./lib/historical_interest_authority.mjs";
import { workbookCalcProperties } from "./lib/economic_solve_policy.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

/**
 * THIS FILE NAMES NEITHER `private workbook library` NOR THE LOCAL PLAN EXTRACTOR IN
 * ANY IMPORT, AND THAT IS WHAT MAKES IT SHIPPABLE.
 *
 * Both were once reached from here, and between them they were the whole of the
 * deployment host blocker. `private workbook library` is a bare specifier the release compiler
 * refuses and the licence forbids vendoring; `./extract_plan.mjs` is the local
 * extraction tool the release deliberately excludes. Neither is needed to
 * produce a plan — see `synthesisePlan` — but the closure walker follows an
 * import whether or not the branch holding it can ever run, so a dynamic
 * `import()` with a literal specifier hid nothing: it dragged both into the
 * shipped closure exactly as a static import would.
 *
 * They now live in `build_package.mjs`, which is not an entry point, is not in
 * the shipped closure, and is not part of the release. It imports this file and
 * hands `main()` the two things this file cannot name. `--out` therefore still
 * works wherever that file and the private writer both exist, and `--plan-only`
 * runs everywhere.
 *
 * Do not reintroduce either dependency here, in any import form. The check is
 * `compile_skill_release.mjs`: it walks `import` / `export … from` / `import()` /
 * `require()` from every declared entry point, and this file is one of them.
 */
const LOCAL_PACKAGE_WRITER = "build_package.mjs";

/**
 * Hand the whole `--out` run to the local package writer, in its own process.
 *
 * A child process rather than an import on purpose: any import of that file,
 * dynamic or not, would put it — and through it the private writer and the
 * local extractor — back in the shipped closure. `stdio: "inherit"` keeps the
 * contract every existing caller relies on, which is that the JSON status line
 * arrives on this process's stdout.
 */
async function runLocalPackageWriter(argv) {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    LOCAL_PACKAGE_WRITER,
  );
  try {
    await fs.access(script, fsConstants.R_OK);
  } catch {
    throw new Error(
      `Writing an .xlsx directly needs scripts/${LOCAL_PACKAGE_WRITER} and the private ` +
        "artifact writer it loads. Neither is part of the released package. " +
        "Run with --plan-only to emit the render plan instead, and render it with " +
        "`python3 -m emit build <plan.json> --out <workbook.xlsx>`.",
    );
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `scripts/${LOCAL_PACKAGE_WRITER} exited ${signal ? `on ${signal}` : `with status ${code}`}.`,
        ),
      );
    });
  });
}
const COLORS = {
  navy: "#092064",
  white: "#FFFFFF",
  black: "#000000",
  blue: "#0000FF",
  green: "#008000",
  lightBlue: "#D9EAF7",
  subsection: "#EFF5F9",
  grey: "#EFEFEF",
  // NO INPUT FILL. An editable cell is marked by BLUE FONT and nothing else.
  // The yellow #FFF2CC that briefly carried "input" is gone: 411 tinted cells
  // on the Smurfit case turned a reference model into a highlighter exercise.
  // What the yellow was for still has to hold, and now holds differently —
  // #D9EAF7 is the ANSWER fill and ONLY the answer fill, so the collision it
  // was introduced to break (an editable cell and a subtotal sharing a colour)
  // cannot recur: an input carries no fill to collide with.
  // Toggle fills. A toggle is not an entry field, so it does not get the blue
  // input fill: it reads On or Off against its own pair of fills. Green FONT
  // stays reserved for cross-sheet links.
  toggleOn: "#C6EFCE",
  toggleOff: "#F2F2F2",
  // CONDITIONAL STATE. Fill only — a conditional rule may set fill, border,
  // bold/italic and number format, and may NEVER set font colour on a body
  // cell, because font colour is the provenance layer (blue = hardcode,
  // black = same-sheet formula, green = cross-sheet link, grey = uncalculated).
  // These two are the standard Excel amber/red pair, chosen to sit alongside
  // the standard green already used by the toggles.
  stateAmber: "#FFEB9C",
  stateRed: "#FFC7CE",
  border: "#BFBFBF",
  darkBorder: "#7F7F7F",
};
// WHICH GUTTERS BREAK THE FORMATTING, AND WHICH CARRY IT ACROSS.
//
// A, F, M and Q are all narrow spacer columns, but they do not all separate the
// same kind of thing, and until now they were all treated as though they did.
//
//   F separates the instrument TERM columns C:E from the PERIOD GRID G onwards.
//     Both sides of it belong to the SAME line item on the SAME basis: one row
//     is one instrument, and its currency, its nominal and its balance in 2027
//     are three facts about that one thing. A fill or a rule that stops dead at
//     F cuts a single row into two halves that have no reason to be apart, and
//     a section band ends up as a labelled block plus a detached, unexplained
//     rectangle over the period columns. F therefore CARRIES THE FORMATTING
//     ACROSS. The terms/periods boundary is still marked — by the terms block's
//     own vertical edges, which is the right channel for a vertical division.
//
//   M and Q separate the STANDALONE block from the ADJUSTMENT block and the
//     ADJUSTMENT block from PRO FORMA. Those are three different bases of the
//     same figure, and the whole point of the layout is that a reader never
//     confuses one for another. They STAY WHITE: the white gap is what makes
//     three column blocks read as three column blocks.
//
//   A is the sheet's left margin. There is nothing to its left to carry across
//     to, so it stays white for the same reason M and Q do.
//
// This reverses `gutter_columns_must_remain_white` for F only, which is a
// contract change and is recorded as one in assets/style-tokens.json.
const CARRY_THROUGH_GUTTERS = new Set(["F"]);
const columnIndex = (name) =>
  [...name.toUpperCase()].reduce((total, ch) => total * 26 + (ch.charCodeAt(0) - 64), 0);

/**
 * Merge adjacent column blocks that are separated ONLY by carry-through
 * gutters, so ["C:E", "G:L", ...] becomes ["C:L", ...] while N:P and R:U stay
 * apart across M and Q.
 *
 * It is done here, at the one place every fill and rule resolves its ranges,
 * rather than by rewriting each block list: a caller that changes WHERE a rule
 * starts (say from C to B) must not have to know anything about which gutters
 * it may cross, and a change to the gutter policy must not have to find every
 * block list in the file.
 */
function carryThroughGutters(blocks) {
  const merged = [];
  for (const pair of blocks) {
    const [first, last] = pair.split(":");
    const previous = merged[merged.length - 1];
    if (previous) {
      const gap = [];
      for (let index = columnIndex(previous.last) + 1; index < columnIndex(first); index += 1) {
        gap.push(columnName(index));
      }
      if (gap.length && gap.every((column) => CARRY_THROUGH_GUTTERS.has(column))) {
        previous.last = last;
        continue;
      }
    }
    merged.push({ first, last });
  }
  return merged.map(({ first, last }) => `${first}:${last}`);
}

// THREE RANKS OF TOTAL, CARRIED BY LINE WEIGHT.
//
// The rule spans the NUMBER CELLS ONLY and breaks at the gutter columns A, M
// and Q, which stay white and unbordered — but NOT at F, which the rule runs
// straight through (see above). Three separate runs, not one band: a rule that
// closes a run is not a grid, so `borders.body_grid_forbidden` still holds.
const NUMBER_BLOCKS = ["C:E", "G:L", "N:P", "R:U"];
// THE RANK RULE RUNS UNDER THE LABEL IT BELONGS TO.
//
// It used to start at column C, so "Adjusted EBITDA" sat above nothing and the
// rule began a column and a half to its right — a total whose underline does
// not reach its own name reads as an underline belonging to the number block,
// not to the line. Column B is part of the first run for that reason, and
// nothing here needs to know that the run then carries on through F: that is
// carryThroughGutters()'s decision, taken once, in blockRanges().
const RANK_BLOCKS = ["B:E", "G:L", "N:P", "R:U"];
const RANK_TREATMENT = {
  // Loses its fill entirely. Rule plus bold is the whole treatment, and that is
  // what makes three ranks legible rather than two.
  [TOTAL_RANK.COMPONENT]: { fill: null, doubleBottom: false },
  [TOTAL_RANK.BLOCK]: { fill: "#EFF5F9", doubleBottom: false },
  [TOTAL_RANK.ANSWER]: { fill: "#D9EAF7", doubleBottom: true },
};

// THE COLUMN-BLOCK LEFT EDGE IS A PERIMETER, AND A PARTIAL BORDER ASSIGNMENT
// CLEARS PERIMETERS.
//
// `J`, `N` and `S` carry a full-height left edge that makes the forecast,
// adjustment and pro-forma blocks read as blocks. It is drawn once, early, over
// `{column}{period_row}:{column}{visible_end_row}`, and it cannot be redrawn
// late: a `{ left }`-only assignment on a single-column range would clear the
// top and bottom rules of every cell in that column, which is the same trap in
// the other direction.
//
// The trap is usually described as clearing the RIGHT edge, because the ranges
// that hit it usually END on a perimeter column. These do not: `RANK_BLOCKS`,
// `NUMBER_BLOCKS` and `PANEL_BLOCKS` all contain `N:P`, so `N` is the range's
// FIRST column and it is the LEFT edge that a `{ top, bottom }` assignment
// silently takes off. (`J` and `S` survive only because `carryThroughGutters`
// merges them into the interior of `G:L` and `R:U`.) That is what removed the
// adjustment block's left edge from `total_liquidity` and `cash_interest_paid`
// — every rank row, section-close row and header row lost it, and the two
// section-terminal rows are simply where the gap is most visible.
//
// So every partial assignment re-states the edge it would otherwise erase.
// Restating it is safe precisely because these rules only ever touch rows
// inside the window the edge already spans.
const BLOCK_LEFT_EDGE_COLUMNS = new Set(["J", "N", "S"]);

function blockLeftEdge(address) {
  const first = /^([A-Z]+)/.exec(address)?.[1];
  return BLOCK_LEFT_EDGE_COLUMNS.has(first)
    ? { left: { style: "thin", color: COLORS.darkBorder } }
    : {};
}

function blockRanges(row, columns = NUMBER_BLOCKS) {
  return carryThroughGutters(columns).map((pair) => {
    const [first, last] = pair.split(":");
    return `${first}${row}:${last}${row}`;
  });
}
// THE NUMBER FORMAT LADDER. One format per class of content, every class
// named, and nothing left on a bare `0` or a raw `0.0000` that says only how
// many digits someone wanted. `assets/style-tokens.json` states this ladder;
// these constants are what actually reaches `xl/styles.xml`, and the two are
// kept in step deliberately.
//
// INVARIANT the zero section protects: a TRUE ZERO renders as an en-dash on a
// WHITE ground, an UNCALCULATED cell renders GREY. Those are the only two
// signals telling a reader which of the two they are looking at, so they must
// never converge — which is why every format that can hold a computed zero
// carries an explicit zero section, and why grey is a fill and never a format.
const AMOUNT = '#,##0;(#,##0);"–"';
// A policy control must distinguish an intentional zero from an omitted value.
// Body cells keep the authority's dash-for-zero convention; the minimum-cash
// entry alone prints 0 so a reader can see that cash is deliberately allowed
// to run to zero before the RCF draws.
const CONTROL_AMOUNT = '#,##0;(#,##0);0';
// THE MIDDLE TERM OF A + B = C STATES A MOVEMENT, NOT A LEVEL.
//
// N:P is the ADJUSTMENT block: what the transaction adds to the standalone case,
// column by column. It carried `AMOUNT`, the identical format the standalone
// block G:L and the pro-forma block R:U carry, so a figure in P was
// typographically indistinguishable from a figure in L — and the adjustment
// block read as a third complete statement standing beside the other two rather
// than as the delta between them. Three peers, none of them announcing that one
// of the three is the difference of the other two.
//
// An explicit leading `+` is what distinguishes a bridge column from a balance
// column, and it costs one character on the cells that actually move. Negatives
// keep the parentheses the rest of the model uses, so the pair reads `+1,100` /
// `(48)` and the sign is unmissable in both directions.
//
// THE ZERO SECTION IS DELIBERATELY UNCHANGED, and it is an en-dash rather than a
// blank. See `number_format_rules.zero_and_uncalculated_must_not_converge`: an
// en-dash on white says "this row genuinely does not move", an empty cell says
// "there is nothing here", and a grey fill says "this was never computed".
// Blanking a true zero would collapse the first into the second and destroy the
// distinction the whole format ladder exists to protect — a reader could no
// longer tell an unaffected row from an unpopulated one. The block is sparse
// because a dash is almost no ink, not because the cell is empty.
const ADJUSTMENT_DELTA = '"+"#,##0;(#,##0);"–"';
const PERCENT = '0.0%;(0.0%);"–"';
// A COUPON is a contractual all-in rate: quoted to the basis point and read to
// three decimals, because 4.125% and 4.13% are different bonds.
const COUPON = "0.000%";
// A BENCHMARK or a SPREAD is quoted off a curve and two decimals is the market
// convention. Splitting the two apart is the reason `0.000%` — specified in the
// tokens since the beginning — was missing from every emitted file: one shared
// constant could only be one of them, and it was this one.
const BENCHMARK = "0.00%";
const MULTIPLE = '0.0x;(0.0x);"–"';
// An FX rate is a price, not a percentage, and four decimals is the quoting
// convention. It used to ride a raw `0.0000`, which rendered an unpopulated
// pair as a meaningless `0.0000` — indistinguishable from a rate that really
// is zero-ish. The zero section puts it back on the ladder.
const FX_RATE = '0.0000;(0.0000);"–"';
// A close year and a close month are date PARTS, not quantities: fixed width,
// never a thousands separator, never a decimal. They used to share a bare `0`
// with nothing to say what they were.
const YEAR = "0000";
const MONTH = "00";
const TOGGLE = '[=1]"On";[=0]"Off"';
// COLUMN C OF THE INTEREST SCHEDULE IS A CLOSED VOCABULARY, AND IT IS COMPILED.
//
// Nothing a case author writes reaches this column. `rate_type` is a three-value
// enum in the v2 schema and the commitment-fee row's entry is a literal in this
// file, so what the reader sees here is a rendering decision, not source text —
// which is the whole reason it is fixed HERE rather than by widening the column.
//
// `MANUAL_ALL_IN` was `rate_type.toUpperCase()`, an identifier shown to a human.
// At 56.26pt against 50.58pt of usable column it clipped on seven of the eight
// certification cases, and the underscore was never English in the first place.
// `COMMITMENT FEE` clipped harder — 62.26pt, 23% over — on all eight.
//
// Widening C is the alternative and it is a bad trade: C would have to go from
// 10 characters to 13 to hold `COMMITMENT FEE`, pushing D, E and the entire
// period grid right by 15.75pt on every case, to fit two strings this file
// chooses. Shortening them costs nothing and buys headroom: the widest thing
// column C now carries anywhere is `Eligible cash` at 39.55pt — which was
// always there and always fitted — against 50.58pt of usable width.
//
// `UNDRAWN` rather than `COMMITMENT`: the column answers "on what basis is the
// rate in column D struck", and for the fee that basis is the undrawn
// commitment. Column B on that row already reads "RCF commitment fee", so the
// word is not lost — it is the one thing the row does not need to say twice —
// and `COMMITMENT` would have fitted with 1.6pt to spare, which is not a fit.
const RATE_TYPE_LABEL = {
  fixed: "FIXED",
  floating: "FLOATING",
  manual_all_in: "ALL-IN",
  unpriced: "PLUG",
};
const rateTypeLabel = (rateType) =>
  RATE_TYPE_LABEL[String(rateType)] ?? String(rateType).toUpperCase();
const COMMITMENT_FEE_BASIS_LABEL = "UNDRAWN";
const HISTORICAL_COLUMNS = ["G", "H", "I"];
const FORECAST_COLUMNS = ["J", "K", "L"];
const ADJUSTMENT_COLUMNS = ["N", "O", "P"];
const PRO_FORMA_COLUMNS = ["S", "T", "U"];

function asSeries3(value, fallback = 0) {
  if (Array.isArray(value) && value.length === 3) {
    return value.map((item) => Number(item ?? fallback));
  }
  return [fallback, fallback, fallback];
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function columnName(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function columnNumber(name) {
  let value = 0;
  for (const character of name) {
    value = value * 26 + (character.charCodeAt(0) - 64);
  }
  return value;
}

// Keep visible aggregation formulas as short as their semantic membership
// permits. The row plan already decides WHICH cells belong to a total; this
// helper changes only how that exact ordered set is written. Consecutive A1
// references in the same column become one range, while gaps and expression
// terms remain explicit. It therefore never pulls an intervening mechanics row
// into a subtotal merely because that row sits between two selected balances.
function compactCellReferences(cells) {
  const parse = (value) => {
    const text = String(value);
    const match = /^(\$?)([A-Z]+)(\$?)(\d+)$/.exec(text);
    return match
      ? {
          text,
          columnAbsolute: match[1],
          column: match[2],
          rowAbsolute: match[3],
          row: Number(match[4]),
        }
      : null;
  };
  const terms = [];
  for (let index = 0; index < cells.length; ) {
    const first = parse(cells[index]);
    if (!first) {
      terms.push(String(cells[index]));
      index += 1;
      continue;
    }
    let last = first;
    let next = index + 1;
    while (next < cells.length) {
      const candidate = parse(cells[next]);
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

function sumCellExpression(cells) {
  const terms = compactCellReferences(cells);
  if (terms.length === 0) return "0";
  if (terms.length === 1 && cells.length === 1) return terms[0];
  return `SUM(${terms.join(",")})`;
}

function sumCellFormula(cells) {
  return `=${sumCellExpression(cells)}`;
}

// Expand an A1 range into its individual cell addresses. Used by the provenance
// registry, which is keyed per cell because a range write and a cell write have
// to be able to contradict each other in either order.
function rangeCells(address) {
  const [first, last = first] = address.split(":");
  const start = /^([A-Z]+)(\d+)$/.exec(first);
  const end = /^([A-Z]+)(\d+)$/.exec(last);
  if (!start || !end) return [];
  const firstColumn = columnNumber(start[1]);
  const lastColumn = columnNumber(end[1]);
  const firstRow = Number(start[2]);
  const lastRow = Number(end[2]);
  const cells = [];
  for (let column = Math.min(firstColumn, lastColumn); column <= Math.max(firstColumn, lastColumn); column += 1) {
    for (let row = Math.min(firstRow, lastRow); row <= Math.max(firstRow, lastRow); row += 1) {
      cells.push(`${columnName(column)}${row}`);
    }
  }
  return cells;
}

function periodLabel(period, forecast) {
  const date = new Date(period.date);
  return `${date.getUTCFullYear()}${forecast ? "E" : ""}`;
}

function setValue(sheet, address, value) {
  sheet.getRange(address).values = [[value]];
  // Writing a value REMOVES the formula, so the cell has no provenance left to
  // defend. Without this the registry would keep re-greening a cell that is now
  // a hardcode — a historical column overwritten after its forecast formula was
  // laid down is exactly that case.
  releaseFormulaProvenance(sheet, address);
}

// PROVENANCE IS A PROPERTY OF WRITING A FORMULA, NOT OF ONE HELPER.
//
// Font colour is the ONLY provenance marking left on a body cell (blue =
// hardcode, black = same-sheet formula, green = cross-sheet link, white =
// section title), so a cross-sheet link painted black is a false claim: it says
// "this number is derived here" about a number imported from another sheet.
//
// The colour used to be applied by `applyFormula` alone, at the moment the
// formula was written, and it survived only until the next pass that styled a
// range containing it. `buildBrokersSheet` did exactly that — it wrote the
// selected-case link with `applyFormula` and then ran
// `styleFont(B{row}:E{row}, black, { bold: true })` across the whole row to bold
// the label, repainting all three links black. Twenty-four cells on the Smurfit
// case, and nothing in the build could see it, because the colour had already
// been "correctly" applied earlier.
//
// So the colour is no longer applied once and hoped for. Every formula write
// records the address and the provenance colour it demands, and
// `assertFormulaProvenance()` re-asserts every one of them after the last
// styling pass has run. It writes a PARTIAL font patch (`{ color }` only), which
// the writer merges, so bold, size and name set by any later pass survive
// untouched; only the provenance channel is reclaimed. Any future pass that
// blanket-styles a range can no longer strip provenance, whatever order it runs
// in.
const FORMULA_PROVENANCE = new Map();

function recordFormulaProvenance(sheet, address, formula) {
  let cells = FORMULA_PROVENANCE.get(sheet);
  if (!cells) {
    cells = new Map();
    FORMULA_PROVENANCE.set(sheet, cells);
  }
  cells.set(address, formulaColor(formula));
}

// Two things end a cell's claim on the provenance channel, and only two: the
// formula being replaced by a value, and the cell turning out to be CHROME
// rather than a body cell. Chrome is the navy header band, the section bands and
// the period-header row, which carry white text over a navy fill; `R{period_row}
// = I{period_row}` is a formula sitting inside one, and re-greening it would put
// black text on navy and delete a column heading. White is the chrome channel,
// so a pass that paints white is claiming the cell as chrome and takes the font
// colour with it.
function releaseFormulaProvenance(sheet, address) {
  const cells = FORMULA_PROVENANCE.get(sheet);
  if (!cells || cells.size === 0) return;
  for (const cell of rangeCells(address)) cells.delete(cell);
}

function assertFormulaProvenance() {
  let asserted = 0;
  for (const [sheet, cells] of FORMULA_PROVENANCE) {
    for (const [address, color] of cells) {
      sheet.getRange(address).format.font = { color };
      asserted += 1;
    }
  }
  return asserted;
}

function setFormula(sheet, address, formula) {
  const text = formula.startsWith("=") ? formula : `=${formula}`;
  sheet.getRange(address).formulas = [[text]];
  recordFormulaProvenance(sheet, address, text);
}

function setRow(sheet, address, values) {
  sheet.getRange(address).values = [values];
  releaseFormulaProvenance(sheet, address);
}

function styleFont(sheet, address, color, extra = {}) {
  sheet.getRange(address).format.font = {
    name: "Calibri",
    size: 8,
    color,
    ...extra,
  };
  if (color === COLORS.white) releaseFormulaProvenance(sheet, address);
}

// ONE FILL, ONE MEANING — and an input has no fill at all.
//
// `#D9EAF7` was once both the total fill AND the input fill, so a subtotal row
// and a cell the reader is meant to type over were the same colour. That was a
// real provenance collision, and a yellow input fill was one way to break it.
// It is not the way taken: yellow on every editable cell was too loud, and the
// collision is broken more cleanly by giving the fill channel to totals ALONE
// (#EFF5F9 block subtotal, #D9EAF7 answer) and leaving inputs unfilled.
//
// BLUE FONT is therefore the whole marking of an input, which makes the
// provenance layer MORE load-bearing than before, not less: blue = hardcode,
// black = same-sheet formula, green = cross-sheet link, grey fill =
// uncalculated. Nothing in this file may set a font colour on a body cell for
// any reason other than provenance.
//
// Callers may still pass an explicit fill where a cell is an input but also
// something else (a state cell, say) and the other role owns the fill.
function styleInput(sheet, address, fill = null) {
  const range = sheet.getRange(address);
  range.format.font = { name: "Calibri", size: 8, color: COLORS.blue };
  if (fill) range.format.fill = fill;
}

function formulaColor(formula) {
  return /'[^']+'!/.test(formula) ? COLORS.green : COLORS.black;
}

// `applyFormula` still paints at write time so the cell picks up the Calibri 8
// body font as well as its colour. It is no longer the guarantee: the guarantee
// is `assertFormulaProvenance()`, which runs after every styling pass. A caller
// reaching for `setFormula` directly is therefore no longer a provenance bug.
function applyFormula(sheet, address, formula) {
  setFormula(sheet, address, formula);
  styleFont(sheet, address, formulaColor(formula));
}

function activeRanges(row) {
  return [`B${row}:L${row}`, `N${row}:P${row}`, `R${row}:U${row}`];
}

function applyRowFill(sheet, row, fill) {
  for (const address of activeRanges(row)) sheet.getRange(address).format.fill = fill;
}

/**
 * Number-format one row across the period columns, giving the ADJUSTMENT block
 * the delta variant of an amount.
 *
 * Every caller used to write `G{row}:U{row}` in one go, which is why N:P wore
 * the standalone block's format: a single range cannot say that its middle third
 * means something different from its outer two. The base format is still applied
 * across the WHOLE span first, deliberately — that keeps the gutter columns M and
 * Q byte-for-byte as they were, and this is the one place a range is allowed to
 * cross them, because a number format is not a fill or a rule and carries no
 * visual weight of its own.
 *
 * Only AMOUNT is redirected. A percentage, a multiple, a rate or an FX quote in
 * the adjustment block is NOT a delta — `Adjusted EBITDA margin` and `Effective
 * tax rate` restate the pro-forma ratio rather than the change in it, so a `+`
 * in front of one would be a straightforward lie about what the number is.
 */
function setPeriodNumberFormat(sheet, row, format) {
  sheet.getRange(`G${row}:U${row}`).format.numberFormat = format;
  if (format === AMOUNT) {
    sheet.getRange(`N${row}:P${row}`).format.numberFormat = ADJUSTMENT_DELTA;
  }
}

/**
 * Apply the three ranks of total, once, at the very end of the build.
 *
 * It runs LAST on purpose. `adjusted_ebitda`, `Revenue` and `Operating profit`
 * are subtotals whose historical cells are hardcoded inputs, so the input pass
 * paints over them; a rank applied earlier would be half-erased by the time the
 * sheet is written. Running last also means every rule sits on top of whatever
 * else the row picked up.
 *
 * Bold is set through a PARTIAL font assignment (`{ bold: true }`), which the
 * writer merges into the existing font. Assigning a full font object here would
 * reset the colour to black and destroy the provenance of every blue input and
 * every green cross-sheet link sitting on a subtotal row.
 *
 * Bold belongs to every semantic total or subtotal.  This is deliberately tied
 * to the rank map rather than to labels or physical rows: Revenue, Gross Profit,
 * Operating Profit and an unfamiliar issuer-specific total all receive the
 * same treatment because they close arithmetic, not because their names were
 * anticipated. `headlineRows` remains a second route for rare prominent rows
 * that are not totals in the issuer's own presentation.
 */
function applyUncalculatedFill(sheet, row) {
  for (const address of [`J${row}:L${row}`, `N${row}:P${row}`, `S${row}:U${row}`]) {
    sheet.getRange(address).format.fill = COLORS.grey;
  }
}

function applyTotalHierarchy(
  sheet,
  ranks,
  uncalculatedRows = null,
  subsectionRows = null,
  headlineRows = null,
) {
  // Narrative headlines can include a non-total (for example an issuer's EBIT
  // anchor), so apply that small declared set before the rank loop.
  for (const row of [...(headlineRows ?? [])].sort((a, b) => a - b)) {
    for (const address of blockRanges(row, RANK_BLOCKS)) {
      sheet.getRange(address).format.font = { bold: true };
    }
  }
  for (const [row, rank] of [...ranks.entries()].sort((a, b) => a[0] - b[0])) {
    const treatment = RANK_TREATMENT[rank];
    if (!treatment) continue;
    for (const address of blockRanges(row, RANK_BLOCKS)) {
      // Partial assignment preserves blue/black/green provenance underneath.
      sheet.getRange(address).format.font = { bold: true };
      // A component sum loses its fill ENTIRELY — white, not "whatever it had".
      sheet.getRange(address).format.fill = treatment.fill ?? COLORS.white;
    }
    // Grey outranks the rank fill: an uncalculated cell must never be mistaken
    // for a calculated zero, whatever row it sits on.
    if (uncalculatedRows?.has(row)) applyUncalculatedFill(sheet, row);
    // WHERE ONE SECTION ENDS AND THE NEXT BEGINS, CLOSE THE FIRST.
    //
    // The block-subtotal fill and the subsection-header fill are the same
    // colour — one says "this closes a block", the other says "this opens
    // one", and `fill_semantics` gives both #EFF5F9 on purpose. That is fine
    // until they are ADJACENT: "Net Cash from Operations" is immediately
    // followed by "Cash from Investing (CFI)", so two bold rows of identical
    // ground ran together and read as a single two-line banner belonging to
    // neither section. The subtotal takes a closing rule in that case, the
    // same thin dark grey the section-close rule uses, and the two bars
    // separate without either fill having to change meaning.
    const closesASection = subsectionRows?.has(row + 1) ?? false;
    for (const address of blockRanges(row, RANK_BLOCKS)) {
      const borders = {
        ...blockLeftEdge(address),
        top: { style: "thin", color: COLORS.darkBorder },
      };
      if (treatment.doubleBottom) {
        borders.bottom = { style: "double", color: COLORS.darkBorder };
      } else if (closesASection) {
        borders.bottom = { style: "thin", color: COLORS.darkBorder };
      }
      sheet.getRange(address).format.borders = borders;
    }
  }
}

/**
 * CONDITIONAL STATE — what the control block is doing to the face of the model.
 *
 * The three toggles used to change hundreds of numbers and nothing visual: a
 * model with circularity off looked exactly like one that computes no interest.
 * Every rule here works on cells that already exist and sets FILL and ITALIC
 * only.
 *
 * ABSOLUTE CONSTRAINT: a conditional rule may set fill, border, bold/italic and
 * number format. It may NEVER set font colour on a body cell. Font colour is the
 * provenance layer — blue = hardcode, black = same-sheet formula, green =
 * cross-sheet link, grey = intentionally uncalculated — and a rule that
 * overrides it silently destroys the one thing this model exists to protect.
 * Nothing below passes `color` inside a conditional `font`.
 *
 * STRUCTURE MUST NOT DEPEND ON STATE. No rule sets a border, so every rule and
 * every double underline from the permanent hierarchy stays exactly where it is
 * when a toggle flips. Formula text is untouched in both states.
 *
 * Control addresses are resolved from `rowPlan.controls`, never hardcoded: the
 * control block moves the moment a row is inserted above it.
 *
 * Explicitly excluded: red font on negatives. The parenthesis number format
 * already carries sign, and red is reserved by the contract for external links.
 */
function applyConditionalState(sheet, rowPlan, context) {
  const { maxRow, waterfallRows, uncalculatedRows } = context;
  const c = rowPlan.controls;
  const circularityOff = `=$C$${c.circularity}=0`;
  const maturityRollOff = `=$C$${c.debt_maturities_roll}=0`;
  const adjustmentsOff = `=$P$${c.adjustments_enabled}=0`;
  const brokerCase = `$C$${c.broker_case}`;

  // "Suppressed", not "zero". Grey plus italic is the same vocabulary the
  // permanent layer already uses for an intentionally uncalculated cell.
  const recede = (address, formula) => {
    if (!address) return;
    sheet.getRange(address).conditionalFormats.add("expression", {
      formula,
      format: { fill: COLORS.grey, font: { italic: true } },
    });
  };
  const tint = (address, formula, fill) => {
    if (!address) return;
    sheet.getRange(address).conditionalFormats.add("expression", {
      formula,
      format: { fill },
    });
  };

  // --- circularity off ---------------------------------------------------
  // The interest schedule's FORECAST cells recede. History is untouched:
  // history was never circular, it was reported.
  const interestStart = Number(rowPlan.interest_term_header_row) + 1;
  if (Number.isFinite(interestStart) && interestStart <= maxRow) {
    for (const pair of ["J:L", "N:P", "S:U"]) {
      const [first, last] = pair.split(":");
      recede(`${first}${interestStart}:${last}${maxRow}`, circularityOff);
    }
  }

  // --- maturity roll off -------------------------------------------------
  // The maturity column stops binding. Explicit scheduled amortisation remains
  // live because the maturity switch governs automatic contractual roll-off,
  // not a separately supplied amortisation path.
  const debtRows = rowPlan.instruments
    .map((plan) => Number(plan.debt_row))
    .filter(Number.isFinite);
  if (debtRows.length) {
    recede(
      `E${Math.min(...debtRows)}:E${Math.max(...debtRows)}`,
      maturityRollOff,
    );
  }

  // --- adjustment columns off -------------------------------------------
  // N:P recedes. The PRO-FORMA block S:U deliberately stays live: A + B = C
  // means pro forma correctly equals standalone when the adjustment is zero,
  // and greying a column that is stating a true answer would be a lie.
  //
  // `fill_semantics.blanket_adjustment_fill_forbidden` bans a BLANKET fill over
  // the adjustment block. A fill that appears only because a condition holds is
  // not blanket — conditional formatting is the only compliant way to shade a
  // block at all.
  //
  // A ROW THAT IS UNCALCULATED IN EVERY STATE IS NOT MAKING A STATEMENT ABOUT
  // THE TOGGLE, AND MUST NOT BE ASKED TO.
  //
  // The segments below used to be built from the section bands alone, so they
  // swept in every row whose forecast is intentionally uncalculated. Those rows
  // already carry #EFEFEF across J:L, N:P and S:U from applyUncalculatedFill()
  // — permanently, because the row has no forecast at all, not because a switch
  // is off — and the rule paints the SAME #EFEFEF over the top of it. Colour
  // distance zero. On AstraZeneca that was 129 cells, on Kingspan 123, on Kerry
  // 78, and on 126 of AstraZeneca's 129 the cell is also EMPTY, so the italic
  // half of the treatment had no glyph to land on either: flipping the switch
  // changed literally nothing on any of them.
  //
  // The honest reading is that those cells were never in the rule's scope. Grey
  // there means "this line has no forecast", which is true with the adjustment
  // on and true with it off; a second grey saying "and the adjustment is off"
  // has nothing to add and, worse, made a rule that covers 700-odd cells report
  // a fifth of them as marks that do not mark. Excluding them costs nothing
  // visually — the block still reads as one grey field when the switch is off,
  // because the excluded cells are the ones that were already grey — and every
  // cell the rule now covers changes appearance when it fires.
  const sectionHeaderRows = new Set(
    Object.values(rowPlan.section_headers).map(Number),
  );
  const permanentlyUncalculated = uncalculatedRows ?? new Set();
  let segmentStart = null;
  // Start at the first section band, not at the period header: the row between
  // the two is the blank that separates them and has nothing to recede.
  const firstSection = Math.min(...sectionHeaderRows);
  for (let row = firstSection; row <= maxRow + 1; row += 1) {
    const isBody =
      row <= maxRow &&
      !sectionHeaderRows.has(row) &&
      !permanentlyUncalculated.has(row);
    if (isBody && segmentStart === null) segmentStart = row;
    if (!isBody && segmentStart !== null) {
      recede(`N${segmentStart}:P${row - 1}`, adjustmentsOff);
      segmentStart = null;
    }
  }

  // --- state of the revolver, year by year -------------------------------
  // Relative column, absolute row: each column tests its own year.
  const endingRcf = Number(waterfallRows?.ending_rcf);
  if (Number.isFinite(endingRcf)) {
    for (const pair of ["G:L", "N:P", "S:U"]) {
      const [first, last] = pair.split(":");
      tint(
        `${first}${endingRcf}:${last}${endingRcf}`,
        `=${first}$${endingRcf}>0`,
        COLORS.stateAmber,
      );
    }
  }
  const shortfall = Number(waterfallRows?.liquidity_shortfall);
  if (Number.isFinite(shortfall)) {
    for (const pair of ["G:L", "N:P", "S:U"]) {
      const [first, last] = pair.split(":");
      tint(
        `${first}${shortfall}:${last}${shortfall}`,
        `=${first}$${shortfall}>0`,
        COLORS.stateRed,
      );
    }
  }

  // --- the case the model is running -------------------------------------
  //
  // ANSWER THE QUESTION IN BOTH DIRECTIONS. There was one rule here, firing only
  // when the case was NOT consensus, and it tinted the cell #EFF5F9 — the same
  // near-white that carries every subsection header and every block subtotal on
  // the sheet. So on the default case, which is five of the six certification
  // cases, the control that names the forecast basis carried NO MARK AT ALL, and
  // in the other state it carried a mark the reader had already learned to read
  // as "this row is a subtotal". A control that is silent in its default state
  // cannot announce which state it is in; that is the whole complaint.
  //
  // The underlying question IS binary — has the market consensus been overridden
  // or not — so it is answered in the vocabulary the panel already uses for
  // binary state, the same pair the two switches directly beneath it carry:
  // off-fill for the neutral default, on-fill for an override deliberately
  // engaged. The selector now reads as a live setting in both states, and it
  // reads as the same KIND of thing as the switches beside it instead of as text
  // that happens to be sitting in a box.
  //
  // FILL ONLY, and no new colour. `toggleOff` and `toggleOn` are declared under
  // `conditional_controls` precisely as the on/off pair for a control cell, so
  // nothing here spends a fill that means something else elsewhere — in
  // particular NOT `answer_fill`, which validate_style_tokens holds to the
  // declared answer rows and which a control cell may never wear. Font colour is
  // untouched in both states: the cell is a hardcoded input, its blue is its
  // provenance, and the rules below deliberately do not carry the toggles' font
  // colour even though a single-cell control rule would be permitted one.
  tint(
    `C${c.broker_case}`,
    `=${brokerCase}="Consensus"`,
    COLORS.toggleOff,
  );
  tint(
    `C${c.broker_case}`,
    `=${brokerCase}<>"Consensus"`,
    COLORS.toggleOn,
  );
}

/**
 * Indent a label cell OUTSIDE the statement sections.
 *
 * Statement rows carry their level on the row plan already; a schedule row does
 * not, so it records one here. Both are written into the package by
 * patchLabelIndents() after the last LibreOffice pass — `format.indentLevel` is
 * accepted by the writer and reaches the emitted XML as nothing, which is why
 * every one of these rows rendered flush left however it was styled. The API
 * call stays because it is the correct call and costs nothing the day the
 * writer honours it; the recorded level is what actually lands.
 */
function setLabelIndent(sheet, rowPlan, row, level) {
  const depth = Number(level);
  if (!Number.isInteger(depth) || depth < 1) return;
  sheet.getRange(`B${row}`).format.indentLevel = depth;
  if (!rowPlan.label_indents) rowPlan.label_indents = {};
  rowPlan.label_indents[row] = Math.max(rowPlan.label_indents[row] ?? 0, depth);
}

/**
 * A SECTION BAND SPANS THE COLUMNS ITS SECTION ACTUALLY USES.
 *
 * The default is every column block, because that is what every statement
 * section needs: a section that runs across standalone, adjustment and pro
 * forma should be banded across all three. `ranges` exists for the one section
 * that does NOT — the control block, which is a panel occupying B:C on the left
 * and N:P on the right and has no period grid at all. Banded by the default it
 * emitted navy across G:L and again across R:U: ten columns of section header
 * over ten columns of permanently empty sheet, marking nothing, and reading —
 * correctly — as an unexplained coloured rectangle. Filling a column block that
 * a section does not reach is a claim the sheet cannot honour.
 */
function styleSection(sheet, row, label, ranges = null) {
  const addresses =
    ranges?.map((pair) => {
      const [first, last] = pair.split(":");
      return `${first}${row}:${last}${row}`;
    }) ?? activeRanges(row);
  for (const address of addresses) {
    const range = sheet.getRange(address);
    range.format.fill = COLORS.navy;
    range.format.font = {
      name: "Calibri",
      size: 8,
      bold: true,
      color: COLORS.white,
    };
    // A section band is chrome: it owns the font colour of every cell it covers.
    releaseFormulaProvenance(sheet, address);
  }
  setValue(sheet, `B${row}`, label);
}

// A ratio row states a relationship between two rows already on the face —
// a margin, a percentage of sales, a coverage multiple. It is never a total,
// never a section heading, and never something the reader adds up.
function isRatioPresentationRow(definition) {
  if (definition.style_role === "total") return false;
  if (definition.row_type === "header" || definition.row_type === "subtotal") {
    return false;
  }
  return (
    definition.number_format === "percentage" ||
    definition.number_format === "multiple" ||
    definition.number_format === "rate"
  );
}

function styleStatementRow(
  sheet,
  definition,
  ranks = null,
  uncalculatedRows = null,
  section = null,
) {
  const row = definition.row;
  styleFont(sheet, `B${row}:U${row}`, COLORS.black);
  // Indentation is a STYLE, never content. The leading-space fallback that used
  // to live here is gone: it was invisible to the style layer, impossible to
  // restyle globally, and it corrupted column-width measurement. The level is
  // already on the row plan — patchLabelIndents() writes it into the package
  // after the last LibreOffice pass, because the writer drops indentLevel.
  sheet.getRange(`B${row}`).format.indentLevel = Number(definition.indent ?? 0);
  // Epoch 3: a NUMBERED GROUP PARENT is not a ranked total. The consolidation
  // pass types these rows `subtotal` for the formula and outline layers, but
  // marks them `style_role: "subsection"` precisely so the costume decision
  // stays separate — a bold label over indented children is the whole
  // treatment, and the band stays reserved for rows that close a section.
  const isTotal = isDeclaredStatementTotal(
    definition,
    presentationEpoch(),
  );
  // Rank is resolved from the row's OWN identity AND ITS SECTION, never from a
  // row number, and the treatment is applied once at the end of the build by
  // applyTotalHierarchy(). A ratio row can still be an ANSWER — the leverage
  // multiples are — so ask before the ratio branch claims it.
  const rank = ranks
    ? totalRank(definition, isTotal, section)
    : null;
  if (rank) ranks.set(row, rank);
  if (isTotal) {
    // Fill, rules and bold arrive together in the final rank pass; nothing to
    // do here, and provenance colour remains untouched.
  } else if (rank === TOTAL_RANK.ANSWER) {
    // An answer that happens to be a ratio keeps the answer treatment, not the
    // italic commentary treatment.
  } else if (isRatioPresentationRow(definition)) {
    // A margin, a ratio or a percentage-of-sales line is a READING of the row
    // above it, not a figure the model builds up to. Bold and a banded fill
    // gave it the weight of a subtotal and pulled the eye away from the
    // numbers that actually add up. Italic is the whole treatment: it marks
    // the line as commentary and leaves the hierarchy to the totals.
    styleFont(sheet, `B${row}:U${row}`, COLORS.black, { italic: true });
  } else if (
    definition.style_role === "subsection" ||
    definition.row_type === "header"
  ) {
    // A TITLE BAR IS CHROME; A NUMBERED PARENT LINE IS A ROW.
    //
    // `style_role: "subsection"` covers two different things: a label-only row
    // that titles a sub-block (`Cash from Investing (CFI)`) and a NUMBERED
    // parent line whose constituents are indented beneath it (`Change in
    // working capital`, `Capital expenditure`, `Change in Debt`). The banded
    // fill on the numbered parents made a component family read as a key
    // total — the same costume as the rows that close a section. Only the
    // label-only title bar keeps the fill and the weight; a numbered parent
    // remains ordinary-weight and its indented children carry the hierarchy.
    const isTitleBar = definition.row_type === "header";
    if (isTitleBar) {
      applyRowFill(sheet, row, COLORS.subsection);
      styleFont(sheet, `B${row}:U${row}`, COLORS.black, { bold: true });
    } else if (presentationEpoch() < 3) {
      applyRowFill(sheet, row, COLORS.subsection);
      styleFont(sheet, `B${row}:U${row}`, COLORS.black, { bold: false });
    }
  }
  if (
    definition.row_type === "uncalculated" ||
    definition.forecast_treatment === "uncalculated"
  ) {
    // A TRUE ZERO renders as an en-dash on a WHITE ground; an UNCALCULATED cell
    // renders GREY. Those two must never converge — the distinction is the only
    // thing telling a reader which one they are looking at. An uncalculated cell
    // on a SUBTOTAL row therefore keeps its grey: the rank pass runs last and
    // would otherwise repaint it with the subtotal fill, so record the row and
    // let applyTotalHierarchy() put the grey back.
    if (uncalculatedRows) uncalculatedRows.add(row);
    applyUncalculatedFill(sheet, row);
  }
  const format =
    definition.number_format === "percentage"
      ? PERCENT
      : definition.number_format === "rate"
        ? BENCHMARK
        : definition.number_format === "multiple"
          ? MULTIPLE
          : AMOUNT;
  // The adjustment block states the MOVEMENT, so an amount there reads as a
  // signed delta — see ADJUSTMENT_DELTA. A ratio row keeps its own format in all
  // three blocks: `Adjusted EBITDA margin` in N:P is the pro-forma margin
  // restated, not the change in margin, and a `+` in front of it would misread
  // the number entirely.
  sheet.getRange(`G${row}:L${row}`).format.numberFormat = format;
  sheet.getRange(`R${row}:U${row}`).format.numberFormat = format;
  sheet.getRange(`N${row}:P${row}`).format.numberFormat =
    format === AMOUNT ? ADJUSTMENT_DELTA : format;
}

function metricValues(modelCase, metricId) {
  const values = modelCase.operating_metrics?.[metricId]?.values;
  return Array.isArray(values) ? values : [null, null, null, null, null, null];
}

function rowValues(modelCase, definition) {
  if (Array.isArray(definition.values)) return definition.values;
  if (definition.semantic_role) return metricValues(modelCase, definition.semantic_role);
  return [null, null, null, null, null, null];
}

function previousColumn(column) {
  return {
    H: "G",
    I: "H",
    J: "I",
    K: "J",
    L: "K",
    S: "R",
    T: "S",
    U: "T",
  }[column] ?? null;
}

// A prior-period reference to the row ITSELF is a hold-flat FORECAST rule, not
// a statement of how history was reported. Anchoring it at the first HISTORIC
// column (H = G, I = H) overwrote two real reported actuals with the third and
// then dragged that stale figure through the forecast and pro-forma blocks. The
// chain must start at the first FORECAST column, leaving G/H/I as three
// independently sourced actuals and J as the forecast's own anchor.
//
// A prior_period reference to a DIFFERENT row is a genuine roll-forward
// (opening cash = last period's ending cash) and is correct in every column, so
// only the self-referencing case is fenced.
function isSelfCarry(definition, calculation) {
  return (
    calculation?.operator === "prior_period" &&
    (calculation.refs?.length ?? 0) === 1 &&
    calculation.refs[0] === definition.row_id
  );
}

function genericFormula(rowPlan, definition, column, calculationOverride = null) {
  const calculation = calculationOverride ?? definition.calculation;
  if (!calculation) return null;
  return compileStatementFormula({
    rule: calculation,
    definition,
    column,
    rowForId: (id) => rowPlan.rows_by_id[id] ?? null,
    previousColumn,
    historicalColumns: HISTORICAL_COLUMNS,
    // Native iterative calculation can leave sub-cent circularity residue in
    // the cash bridge. Snap only the displayed net cash movement.
    roundSumDigits: definition.semantic_role === "net_change_in_cash" ? 6 : null,
  }).formula;
}

function hasForecastPeriodCalculations(definition) {
  return Array.isArray(definition.forecast_period_calculations);
}

function forecastCalculationForIndex(definition, forecastIndex) {
  if (hasForecastPeriodCalculations(definition)) {
    return definition.forecast_period_calculations[forecastIndex] ?? null;
  }
  return definition.forecast_calculation ?? null;
}

// ONE CELL, ONE THREAD.
//
// Seven places attach a threaded comment, and two of them speak about the same
// cell by design: an emission branch writes the provenance note as it writes
// the hardcode, and `attachInputProvenance()` sweeps the same rows afterwards
// so that a cell no branch happened to cover still gets one. Every one of those
// call sites was wrapped in `try { ... } catch {}` with a comment explaining
// that a duplicate is harmless because the second `addThread` would throw.
//
// IT DOES NOT THROW. The legacy workbook library writer accepts a second thread on a cell
// that already has one and emits both, so EVERY provenance cell shipped with
// the identical note twice — 260 threads over 131 cells on Kerry, 338 over 171
// on Smurfit. In Excel that is two comment cards on one cell saying the same
// thing, and a reviewer resolving one still sees the other.
//
// The intent those catch blocks recorded was first-writer-wins, so that is what
// this enforces, in the one place every caller goes through. Keyed on the sheet
// OBJECT rather than its name: a sheet name is a string this file does not own,
// and two sheets in one workbook may legitimately want a comment on `B12`.
const COMMENTED_CELLS = new WeakMap();

function addCommentOnce(workbook, sheet, address, text) {
  let seen = COMMENTED_CELLS.get(sheet);
  if (!seen) {
    seen = new Set();
    COMMENTED_CELLS.set(sheet, seen);
  }
  if (seen.has(address)) return false;
  seen.add(address);
  workbook.comments.addThread({ cell: sheet.getRange(address) }, text);
  return true;
}

function provenanceComment(entry) {
  const parts = [
    `Source: ${entry.document}`,
    `Published: ${entry.publication_date}`,
    `Page / note: ${entry.page_or_note}`,
    `Source label: ${entry.source_label}`,
    `Units: ${entry.units}`,
  ];
  if (entry.transformation) parts.push(`Transformation: ${entry.transformation}`);
  return parts.join("\n");
}

function forecastAuthorityComment(modelCase, definition, forecastIndex, authority) {
  const provenance = (modelCase.provenance?.[definition.row_id] ?? []).find(
    (entry) => Number(entry.period_index) === forecastIndex + 3,
  );
  if (provenance) return provenanceComment(provenance);
  const parts = [
    `Forecast authority: ${authority.method}`,
    `Source kind: ${authority.source_kind ?? "not declared"}`,
  ];
  if (authority.source_id) parts.push(`Source: ${authority.source_id}`);
  if (authority.as_of_date) parts.push(`As of: ${authority.as_of_date}`);
  if (authority.note) parts.push(authority.note);
  if (authority.inferred && !authority.note) {
    parts.push(
      "Legacy/reference forecast value retained from the case input; no additional source was declared.",
    );
  }
  return parts.join("\n");
}

function brokerNames(modelCase) {
  const names = new Set();
  for (const metric of Object.values(modelCase.broker_pack?.metrics ?? {})) {
    for (const name of Object.keys(metric.brokers ?? {})) names.add(name);
  }
  return [...names].sort();
}

// THE BROKERS SHEET RENDERS WHAT THE MODEL CONSUMES, NOT WHAT THE PACK
// CARRIES. Tier 1 core plus recorded flex elections; every other metric the
// crosswalk preserved stays in the run evidence and on the B01-B10 sheets.
// Rendering the whole candidate universe put a ten-row block on the central
// sheet for every broker line item — six thousand rows on a real pack — and
// an analyst cannot read a consensus grid they cannot see whole.
const TIER1_BROKER_METRIC_IDS = new Set([
  "revenue",
  "ebit",
  "adjusted_ebitda",
  "depreciation_and_amortisation",
  "effective_tax_rate",
  "capex",
  "change_in_working_capital",
  "dividends",
]);

function consumedBrokerMetricIds(modelCase) {
  const elected = new Set(
    (modelCase.broker_pack?.flex_elections ?? []).map((item) => item.metric_id),
  );
  return Object.keys(modelCase.broker_pack?.metrics ?? {}).filter(
    (metricId) => TIER1_BROKER_METRIC_IDS.has(metricId) || elected.has(metricId),
  );
}

function brokerMetricRowMap(modelCase) {
  const names = brokerNames(modelCase);
  const rows = {};
  let row = 5;
  for (const metricId of consumedBrokerMetricIds(modelCase)) {
    rows[metricId] = row;
    row += 1 + names.length + 3 + 1;
  }
  return {
    sheet: "Brokers",
    actual_column: "C",
    forecast_columns: ["D", "E", "F"],
    rows,
  };
}

// WHICH OPERATING-MODEL ROW STATES THIS BROKER METRIC.
//
// Resolved by SEMANTIC ROLE first, `row_id` second, and only then by
// `broker_metric_id`. The order is load-bearing, because the broker-anchor rule
// MOVES `broker_metric_id`: the metric it derives has the id taken off the
// statement line and given to a "Memo: … broker consensus" row, which states
// what the houses say rather than what the company reported. Reading the last
// actual off that memo row would put a BROKER figure in the one column reserved
// for the model's own history, which is exactly the substitution the actual
// column exists to prevent. Semantic role resolves every metric on every case in
// the suite, including the ones whose statement line is named for the company's
// own language (Smurfit reports `ebit` on a row called `operating_profit`).
function operatingModelRowForMetric(rowPlan, metricId) {
  const definitions = statementDefinitions(rowPlan);
  const notAMemo = (definition) =>
    !String(definition.row_id ?? "").endsWith("_broker_memo");
  return (
    definitions.find(
      (definition) => definition.semantic_role === metricId && notAMemo(definition),
    ) ??
    definitions.find(
      (definition) => definition.row_id === metricId && notAMemo(definition),
    ) ??
    definitions.find(
      (definition) =>
        definition.broker_metric_id === metricId && notAMemo(definition),
    ) ??
    null
  );
}

// THE MODEL AND THE PACK STATE CASH USES WITH OPPOSITE SIGNS, and the actual
// column is where the two meet. A broker pack quotes capex, dividends and
// buybacks as positive MAGNITUDES; the cash-flow statement carries them as
// negative MOVEMENTS, which is why `signedBrokerLink` negates exactly these
// three on the way back out. Linking the actual straight across would print a
// negative 2025 beside nine positive forecasts and read as a sign error in the
// pack. The set is deliberately the same one `signedBrokerLink` uses, and keyed
// on the same semantic roles, so the two cannot drift apart.
const BROKER_MAGNITUDE_ROLES = new Set(["capex", "dividends", "share_buybacks"]);

/**
 * THE BROKERS SHEET.
 *
 * Geometry follows the CRH reference: a width-1 gutter in column A, the name in
 * a tight column B, then the period grid opening on the LAST ACTUAL and running
 * across the three forecasts. The reference's own Date column is absent, and
 * absent deliberately — see the column-geometry note below.
 *
 * The block reads TOP DOWN, which is the whole point of the rebuild. The metric
 * row carries the answer the Operating Model actually consumes; the named houses
 * that feed it sit underneath; the derived summaries close the block. Three
 * grounds say which is which without a word of legend — answer fill on the
 * metric row, no fill on a sourced contributor, subsection fill on the derived
 * rows — and all three are colours this model already uses for exactly those
 * three ranks.
 */
function brokerEvidenceSheetName(index, houseName, used) {
  const prefix = `B${String(index + 1).padStart(2, "0")} `;
  const cleaned = String(houseName ?? "Broker")
    .replace(/[\\/\?\*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = `${prefix}${cleaned || "Broker"}`.slice(0, 31);
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    const tail = ` ${suffix}`;
    name = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function compileBrokerEvidenceLayout(modelCase) {
  const houses = modelCase.broker_pack?.raw_tables ?? [];
  const mappings = modelCase.broker_pack?.source_mappings ?? [];
  if (!Array.isArray(houses) || houses.length === 0) return null;
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error(
      "Full broker source tables were supplied without cell-addressed source_mappings.",
    );
  }
  const usedNames = new Set(["Operating Model", "> Brokers", "Brokers", "Forward Curves"]);
  const cellMap = new Map();
  const houseByName = new Map();
  const sheets = houses.map((house, houseIndex) => {
    const name = brokerEvidenceSheetName(houseIndex, house.house_name, usedNames);
    houseByName.set(house.house_name, house);
    let row = 4;
    const presentationTables = (house.tables ?? []).filter(
      (table) => table.workbook_presentation !== "evidence_only",
    );
    const tableLayouts = presentationTables.map((table) => {
      const metaRow = row;
      const dataStartRow = metaRow + 1;
      const maxColumns = Math.max(1, ...(table.rows ?? []).map((values) => values.length));
      const authorityByCell = new Map(
        (table.cell_authorities ?? []).map((entry) => [
          `${Number(entry.row)}|${Number(entry.column)}`,
          entry,
        ]),
      );
      for (let sourceRow = 1; sourceRow <= (table.rows ?? []).length; sourceRow += 1) {
        for (let sourceColumn = 1; sourceColumn <= maxColumns; sourceColumn += 1) {
          const address = `${columnName(sourceColumn + 1)}${dataStartRow + sourceRow - 1}`;
          const key = `${table.table_id}|${sourceRow}|${sourceColumn}`;
          if (cellMap.has(key)) {
            throw new Error(`Broker evidence cell key ${key} is duplicated.`);
          }
          cellMap.set(key, {
            sheetName: name,
            address,
            house_id: house.house_id,
            authority: authorityByCell.get(`${sourceRow}|${sourceColumn}`) ?? null,
          });
        }
      }
      row = dataStartRow + (table.rows ?? []).length + 2;
      return { table, metaRow, dataStartRow, maxColumns, authorityByCell };
    });
    return { house, name, tableLayouts, visibleEndRow: Math.max(3, row - 1) };
  });
  const mappingByKey = new Map();
  for (const mapping of mappings) {
    const key = `${mapping.house_id}|${mapping.metric_id}|${mapping.period_index}`;
    if (mappingByKey.has(key)) {
      throw new Error(`Broker source mapping ${key} is duplicated.`);
    }
    for (const component of mapping.components ?? []) {
      const physical = cellMap.get(
        `${component.table_id}|${component.row}|${component.column}`,
      );
      if (!physical || physical.house_id !== mapping.house_id) {
        throw new Error(
          `Broker mapping ${key} points to a missing or cross-house source cell.`,
        );
      }
      if (physical.authority?.status === "quarantined_conflict") {
        throw new Error(`Broker mapping ${key} points to quarantined source evidence.`);
      }
    }
    mappingByKey.set(key, mapping);
  }
  return {
    dividerName: "> Brokers",
    sheets,
    cellMap,
    mappingByKey,
    houseByName,
  };
}

function brokerEvidenceProofSpec(layout) {
  if (!layout) return null;
  const expectedSourceReferences = [];
  for (const mapping of layout.mappingByKey.values()) {
    for (const component of mapping.components ?? []) {
      const physical = layout.cellMap.get(
        `${component.table_id}|${component.row}|${component.column}`,
      );
      expectedSourceReferences.push({
        sheet: physical.sheetName,
        address: physical.address,
      });
    }
  }
  return {
    divider_sheet: layout.dividerName,
    broker_sheet: "Brokers",
    source_sheets: layout.sheets.map((sheet) => sheet.name),
    expected_source_references: expectedSourceReferences,
  };
}

function brokerEvidenceFormula(layout, houseName, metricId, periodIndex, expectedValue) {
  if (!layout) return null;
  const house = layout.houseByName.get(houseName);
  if (!house) return null;
  const mapping = layout.mappingByKey.get(
    `${house.house_id}|${metricId}|${periodIndex}`,
  );
  if (!mapping) return null;
  if (
    expectedValue !== null &&
    expectedValue !== undefined &&
    Math.abs(Number(mapping.value) - Number(expectedValue)) > 1e-6
  ) {
    throw new Error(
      `Broker source mapping for ${houseName}.${metricId}[${periodIndex}] resolves to ${mapping.value}, not ${expectedValue}.`,
    );
  }
  const terms = (mapping.components ?? []).map((component) => {
    const physical = layout.cellMap.get(
      `${component.table_id}|${component.row}|${component.column}`,
    );
    const reference = `'${physical.sheetName.replace(/'/g, "''")}'!${physical.address}`;
    const coefficient = Number(component.coefficient);
    if (coefficient === 1) return reference;
    if (coefficient === -1) return `-${reference}`;
    return `${reference}*${coefficient}`;
  });
  let expression;
  const constant = Number(mapping.constant ?? 0);
  if (terms.length === 1 && constant === 0) expression = terms[0];
  else {
    const argumentsList = [...terms, ...(constant === 0 ? [] : [String(constant)])];
    expression = `SUM(${argumentsList.join(",")})`;
  }
  const multiplier = Number(mapping.multiplier ?? 1);
  if (multiplier !== 1) expression = `(${expression})*${multiplier}`;
  return `=${expression}`;
}

function buildBrokerEvidenceDivider(workbook, layout) {
  const sheet = workbook.worksheets.add(layout.dividerName);
  sheet.showGridLines = false;
  setValue(sheet, "B2", "BROKER SOURCE EVIDENCE");
  styleFont(sheet, "B2", COLORS.navy, { bold: true });
  setValue(
    sheet,
    "B4",
    "Values-only evidence sheets follow. Model formulas reference them only through the Brokers sheet.",
  );
  styleFont(sheet, "B4", COLORS.grey);
  sheet.getRange("A1:A8").format.columnWidth = 1;
  sheet.getRange("B1:B8").format.columnWidth = 72;
  return sheet;
}

function buildBrokerEvidenceSheets(workbook, layout) {
  for (const sheetLayout of layout.sheets) {
    const { house } = sheetLayout;
    const sheet = workbook.worksheets.add(sheetLayout.name);
    sheet.showGridLines = false;
    setValue(sheet, "B1", `${house.house_name} — source tables`);
    styleFont(sheet, "B1", COLORS.black, { bold: true });
    setValue(
      sheet,
      "B2",
      `${house.file_name} | published ${house.published_date} | source ${house.source_id} | SHA-256 ${house.content_sha256}`,
    );
    styleFont(sheet, "B2", COLORS.grey);
    let globalMaxColumns = 1;
    const maxWidths = new Map();
    for (const { table, metaRow, dataStartRow, maxColumns, authorityByCell } of sheetLayout.tableLayouts) {
      globalMaxColumns = Math.max(globalMaxColumns, maxColumns);
      const lastColumn = columnName(maxColumns + 1);
      setValue(
        sheet,
        `B${metaRow}`,
        [table.title, table.source_location, table.units].filter(Boolean).join(" | ") || table.table_id,
      );
      sheet.getRange(`B${metaRow}:${lastColumn}${metaRow}`).format.fill = COLORS.navy;
      styleFont(sheet, `B${metaRow}:${lastColumn}${metaRow}`, COLORS.white, { bold: true });
      for (let sourceRow = 0; sourceRow < table.rows.length; sourceRow += 1) {
        const values = table.rows[sourceRow];
        for (let sourceColumn = 0; sourceColumn < maxColumns; sourceColumn += 1) {
          const value = sourceColumn < values.length ? values[sourceColumn] : null;
          const address = `${columnName(sourceColumn + 2)}${dataStartRow + sourceRow}`;
          setValue(sheet, address, value);
          const authority = authorityByCell.get(`${sourceRow + 1}|${sourceColumn + 1}`);
          const width = Math.min(30, Math.max(9, String(value ?? "").length + 2));
          maxWidths.set(sourceColumn + 2, Math.max(maxWidths.get(sourceColumn + 2) ?? 0, width));
          if (sourceRow === 0) {
            sheet.getRange(address).format.fill = COLORS.subsection;
            styleFont(sheet, address, COLORS.black, { bold: true });
          } else if (
            typeof value === "number" &&
            Number.isFinite(value)
          ) {
            styleInput(sheet, address);
          } else if (value !== null && value !== undefined && value !== "") {
            styleFont(sheet, address, COLORS.black);
          }
          if (authority?.status === "quarantined_conflict") {
            sheet.getRange(address).format.fill = COLORS.stateAmber;
            styleFont(sheet, address, COLORS.black);
            addCommentOnce(
              workbook,
              sheet,
              address,
              `Source-cell conflict ${authority.conflict_id ?? "unresolved"}. Retained as reference evidence; prohibited from model formulas.`,
            );
          }
        }
      }
    }
    sheet.getRange(`A1:A${sheetLayout.visibleEndRow}`).format.columnWidth = 1;
    for (let column = 2; column <= globalMaxColumns + 1; column += 1) {
      sheet.getRange(`${columnName(column)}1:${columnName(column)}${sheetLayout.visibleEndRow}`).format.columnWidth =
        maxWidths.get(column) ?? (column === 2 ? 24 : 12);
    }
  }
}

function buildBrokersSheet(workbook, modelCase, rowPlan, brokerEvidence = null) {
  const sheet = workbook.worksheets.add("Brokers");
  sheet.showGridLines = false;

  // COLUMN GEOMETRY.
  //
  // B was 42 wide — wider than any broker name in the suite and wider than the
  // Operating Model's own label column — and the grid was three forecast columns
  // with nothing to their left. It is now the reference's shape: A is the
  // sheet's left margin at width 1, the same gutter the Operating Model opens
  // with; B is 27, which fits "BNP Paribas Exane" and "Kepler Cheuvreux" without
  // the run of dead space after them; C is the LAST ACTUAL and D:F the three
  // forecasts, at the Operating Model's own period width of 10.
  //
  // THERE IS NO DATE COLUMN, and that is a finding rather than an omission. The
  // v2 case schema closes `broker_pack` and `brokerMetric` with
  // `additionalProperties: false`, and maps a broker name to exactly a
  // three-number array — so a v2 case CANNOT carry a broker estimate date, and
  // no case in the suite does. `provenance.*.publication_date` is the annual
  // report the HISTORICAL line came from, keyed by statement line and not by
  // house, so it cannot stand in for one. A column of blanks would say the dates
  // are missing from the pack, which is not the same claim as the model having
  // nowhere to put them, so the column is simply not drawn.
  const ACTUAL_COLUMN = "C";
  const FORECAST_COLUMNS_BROKERS = ["D", "E", "F"];
  const LAST_COLUMN = FORECAST_COLUMNS_BROKERS.at(-1);
  // The header sits DIRECTLY under the case control. The explanatory paragraph
  // that used to occupy row 3 is gone at the reviewer's instruction, and the row
  // went with it rather than being left blank: an empty row between the control
  // and the header is not a spacer, it is the hole a deleted sentence left.
  const HEADER_ROW = 3;

  styleFont(sheet, `B1:${LAST_COLUMN}250`, COLORS.black);
  setValue(sheet, "B1", `${modelCase.issuer.name} Broker Forecasts`);
  styleFont(sheet, `B1:${LAST_COLUMN}1`, COLORS.black, { bold: true });

  // WHICH OF THESE IS THE MODEL ACTUALLY USING?
  //
  // This sheet lists every candidate — one row per named broker, then Consensus,
  // High and Low — and every one of them was formatted identically, as a plain
  // row of blue inputs. Nothing on the sheet said which one the model had picked
  // up, so a reader looking at eight brokers had to go back to the Operating
  // Model control block, read the case name, and match it by eye.
  //
  // `C2` states the live case once, at the top, and it is the ONE cross-sheet
  // reference the treatment needs: every rule below then tests a SAME-SHEET
  // absolute (`$C$2`) against the candidate's own name in column B. A
  // conditional-format formula reaching across sheets is the fragile construct
  // here — it is not reliably honoured on a round trip through the writer and
  // LibreOffice — so it is spent exactly once, in an ordinary formula cell where
  // it is robust, rather than repeated inside a rule on every candidate row.
  // Green font on C2 is correct and automatic: applyFormula() colours a formula
  // carrying another sheet's name as a cross-sheet link.
  //
  // The metric row's selector now reads the same cell rather than reaching
  // across the sheet boundary again in every one of its arms. The live case is
  // therefore resolved in ONE place on this sheet instead of twenty-five, and
  // the arithmetic and the highlighting cannot disagree about which case is on.
  const liveCaseCell = `$${ACTUAL_COLUMN}$2`;
  setValue(sheet, "B2", "Broker case");
  applyFormula(
    sheet,
    `${ACTUAL_COLUMN}2`,
    `='Operating Model'!$C$${rowPlan.controls.broker_case}`,
  );
  sheet.getRange(`B2:${ACTUAL_COLUMN}2`).format.font = { bold: true };

  // THERE IS NO NOTE ROW. A paragraph naming the pack, restating how its
  // consensus was arrived at and disclaiming the missing estimate dates used to
  // run across row 3. The reviewer struck it, and the row is struck with it —
  // the sentence and the space it stood in are one deletion, not two.
  setValue(sheet, `B${HEADER_ROW}`, "Broker");
  setValue(
    sheet,
    `${ACTUAL_COLUMN}${HEADER_ROW}`,
    new Date(modelCase.periods[2].date),
  );
  setRow(
    sheet,
    `${FORECAST_COLUMNS_BROKERS[0]}${HEADER_ROW}:${LAST_COLUMN}${HEADER_ROW}`,
    modelCase.periods.slice(3).map((period) => new Date(period.date)),
  );
  // The same two formats the Operating Model's period header wears, so the two
  // sheets date their columns in one language: `Dec-25` is closed, `Dec-26E` is
  // not.
  sheet.getRange(`${ACTUAL_COLUMN}${HEADER_ROW}`).format.numberFormat = "mmm-yy";
  sheet.getRange(
    `${FORECAST_COLUMNS_BROKERS[0]}${HEADER_ROW}:${LAST_COLUMN}${HEADER_ROW}`,
  ).format.numberFormat = 'mmm-yy"E"';
  sheet.getRange(`B${HEADER_ROW}:${LAST_COLUMN}${HEADER_ROW}`).format.fill =
    COLORS.navy;
  styleFont(
    sheet,
    `B${HEADER_ROW}:${LAST_COLUMN}${HEADER_ROW}`,
    COLORS.white,
    { bold: true },
  );

  // THE LIVE ROW LIGHTS UP; THE ALTERNATIVES ARE LEFT ALONE.
  //
  // The mark runs ACROSS a DERIVED row and stops at the NAME on a SOURCED one,
  // and the split is not a compromise — it is the one line `fill_semantics`
  // draws. `Consensus`, `High` and `Low` are calculated here and already carry
  // `subsection_fill` end to end, so a conditional fill replacing it across the
  // same span changes which rank colour the row wears, not whether it wears one;
  // that holds even where a pack supplies its consensus as a hardcode, because
  // the fill is the ROW's identity and the blue font is that CELL's provenance.
  // A named house's C:F cells are its OWN forecast and nothing else, and
  // `input_carries_no_fill` means an input is marked by blue font alone — a
  // fill laid over them, even a conditional one, would put a colour behind an
  // editable cell for the first time since the yellow was removed. So the
  // reviewer's "consensus green bit should be across" is taken across on every
  // row where taking it across is licensed, and no further.
  //
  // The unselected rows are still made subordinate by the live one gaining a
  // mark rather than by the others losing anything: greying eight real broker
  // forecasts would say they were not calculated, which is the one thing
  // `na_fill` is reserved to mean.
  //
  // `toggleOn` is the same fill the Operating Model selector takes when a case is
  // engaged, and it is used here for the same reason — this is the option that
  // is ON.
  const markLiveCase = (labelRow, span = `B${labelRow}`) => {
    sheet.getRange(span).conditionalFormats.add("expression", {
      formula: `=AND(${liveCaseCell}<>"",${liveCaseCell}=$B${labelRow})`,
      format: { fill: COLORS.toggleOn, font: { bold: true } },
    });
  };
  // A derived row's mark spans the whole row; a contributor's stops at its name.
  const markLiveCaseAcross = (labelRow) =>
    markLiveCase(labelRow, `B${labelRow}:${LAST_COLUMN}${labelRow}`);

  const names = brokerNames(modelCase);
  const selectedRows = {};
  const assumptionRows = {};
  const declaredMetricRows = rowPlan.broker_metric_rows?.rows ?? {};
  // Every broker row on the sheet, for the outline pass that collapses the
  // contributors and leaves the metric standing over its three summaries.
  const contributorRows = [];
  // One blank row under the header, then the first block. Every later block is
  // opened by the same single blank row (see the foot of the loop), so the
  // sheet reads as separated units rather than one unbroken column of names.
  let row = HEADER_ROW + 2;
  const consumedIds = new Set(consumedBrokerMetricIds(modelCase));
  for (const [metricId, metric] of Object.entries(
    modelCase.broker_pack.metrics ?? {},
  ).filter(([metricId]) => consumedIds.has(metricId))) {
    const definition = operatingModelRowForMetric(rowPlan, metricId);
    const numberFormat =
      definition?.number_format === "percentage" ? PERCENT : AMOUNT;
    // THE LAST ACTUAL, ON EVERY ROW THAT QUOTES A FORECAST.
    //
    // The reference hardcodes a broker-supplied actual onto every broker row.
    // This is the MODEL's history instead — linked live off the Operating
    // Model's last historical column — and at the reviewer's instruction it is
    // now written on every contributor row as well as on the metric row, so a
    // reader scanning one house's line has that house's three forecasts and the
    // base year they grow off in the same eye movement, without tracking back up
    // the block. Every copy resolves through the SAME semantic role, so the rows
    // cannot disagree, and `BROKER_MAGNITUDE_ROLES` negates capex, dividends and
    // buybacks on every one of them exactly as it does on the metric row: the
    // pack quotes those as positive magnitudes and the cash-flow statement
    // carries them as negative movements, and a single unnegated copy would read
    // as a sign error against the nine forecasts beside it.
    const actualFormula = definition
      ? BROKER_MAGNITUDE_ROLES.has(definition.semantic_role)
        ? `=-'Operating Model'!${HISTORICAL_COLUMNS.at(-1)}${definition.row}`
        : `='Operating Model'!${HISTORICAL_COLUMNS.at(-1)}${definition.row}`
      : null;

    const metricRow = row;
    if (
      declaredMetricRows[metricId] != null &&
      declaredMetricRows[metricId] !== metricRow
    ) {
      throw new Error(
        `Broker metric row drift for ${metricId}: row plan ` +
          `${declaredMetricRows[metricId]}, emitted ${metricRow}.`,
      );
    }
    selectedRows[metricId] = metricRow;
    // THE LABEL IS THE METRIC'S NAME AND NOTHING ELSE.
    //
    // It used to carry a `(6 of 7)` coverage annotation wherever fewer than the
    // full panel supplied the basis. The reviewer struck it: the thin blocks
    // announce themselves — the gaps are visible in the contributor rows
    // directly beneath — and a parenthetical on a row label is a second, weaker
    // statement of what the block already shows. `brokerContributorCount`
    // remains the broker-anchor rule's own count; the sheet simply no longer
    // restates it.
    setValue(sheet, `B${metricRow}`, metric.label);
    row += 1;

    const brokerRows = [];
    for (const name of names) {
      const values = metric.brokers?.[name] ?? [null, null, null];
      brokerRows.push(row);
      contributorRows.push(row);
      setValue(sheet, `B${row}`, name);
      for (let index = 0; index < 3; index += 1) {
        const address = `${FORECAST_COLUMNS_BROKERS[index]}${row}`;
        const sourceFormula = brokerEvidenceFormula(
          brokerEvidence,
          name,
          metricId,
          index,
          values[index],
        );
        if (sourceFormula) applyFormula(sheet, address, sourceFormula);
        else {
          setValue(sheet, address, values[index]);
          styleInput(sheet, address);
        }
      }
      // The link goes down AFTER `styleInput`, which only ever touches D:F, so
      // the actual keeps the green a cross-sheet link is owed rather than the
      // blue of the hardcodes beside it. `assertFormulaProvenance` re-asserts it
      // at the end of the build in any case.
      if (actualFormula) {
        applyFormula(sheet, `${ACTUAL_COLUMN}${row}`, actualFormula);
      }
      // NAME CELL ONLY on a contributor: C:F here are the house's own inputs.
      markLiveCase(row);
      row += 1;
    }

    const consensusRow = row;
    setValue(sheet, `B${row}`, "Consensus");
    if (Array.isArray(metric.provider_consensus)) {
      setRow(
        sheet,
        `${FORECAST_COLUMNS_BROKERS[0]}${row}:${LAST_COLUMN}${row}`,
        metric.provider_consensus,
      );
      styleInput(
        sheet,
        `${FORECAST_COLUMNS_BROKERS[0]}${row}:${LAST_COLUMN}${row}`,
      );
    } else {
      for (let index = 0; index < 3; index += 1) {
        const column = FORECAST_COLUMNS_BROKERS[index];
        const range = brokerRows.length
          ? `${column}${brokerRows[0]}:${column}${brokerRows.at(-1)}`
          : null;
        applyFormula(
          sheet,
          `${column}${row}`,
          range ? `=IFERROR(AVERAGE(${range}),0)` : "=0",
        );
      }
    }
    styleFont(sheet, `B${row}`, COLORS.black, { bold: true });
    markLiveCaseAcross(row);
    row += 1;
    const highRow = row;
    setValue(sheet, `B${row}`, "High");
    const lowRow = row + 1;
    setValue(sheet, `B${lowRow}`, "Low");
    markLiveCaseAcross(highRow);
    markLiveCaseAcross(lowRow);
    for (let index = 0; index < 3; index += 1) {
      const column = FORECAST_COLUMNS_BROKERS[index];
      const range = brokerRows.length
        ? `${column}${brokerRows[0]}:${column}${brokerRows.at(-1)}`
        : `${column}${consensusRow}`;
      applyFormula(sheet, `${column}${highRow}`, `=MAX(${range})`);
      applyFormula(sheet, `${column}${lowRow}`, `=MIN(${range})`);
    }
    row += 2;

    // THE ANSWER, WRITTEN AT THE HEAD OF THE BLOCK.
    //
    // This is the row the Operating Model links to, and it used to sit at the
    // FOOT of the block under the label "Selected case" — so the reader met ten
    // candidates before meeting the number the model was actually using. It is
    // the same selector, resolving the same way; it has simply moved to where
    // the reader looks first, and it now carries the metric's name because the
    // metric row it replaces was an empty label.
    for (let index = 0; index < 3; index += 1) {
      const column = FORECAST_COLUMNS_BROKERS[index];
      let expression =
        `IF(${liveCaseCell}="Consensus",${column}${consensusRow},` +
        `IF(${liveCaseCell}="High",${column}${highRow},` +
        `IF(${liveCaseCell}="Low",${column}${lowRow}`;
      names.forEach((name, nameIndex) => {
        const brokerRow = brokerRows[nameIndex];
        expression +=
          `,IF(${liveCaseCell}="${name.replace(/"/g, '""')}",` +
          `IF(${column}${brokerRow}="",${column}${consensusRow},${column}${brokerRow})`;
      });
      expression += `,${column}${consensusRow}`;
      expression += ")".repeat(3 + names.length);
      applyFormula(sheet, `${column}${metricRow}`, `=${expression}`);
    }
    if (actualFormula) {
      applyFormula(sheet, `${ACTUAL_COLUMN}${metricRow}`, actualFormula);
    }

    // THREE GROUNDS, THREE KINDS OF ROW, NO LEGEND.
    //
    // `Consensus`, `High` and `Low` are DERIVED rows standing in a list of
    // SOURCED ones, and they were formatted identically to a named house. They
    // now carry `subsection_fill`, which is this model's declared ground for a
    // block subtotal — which is exactly what they are, the subtotals of the
    // panel above them. The metric row carries `answer_fill`, which is the
    // ground it inherits from the `Selected case` row it replaces. A contributor
    // carries neither. Nothing new was added to the palette to say it: the block
    // now reads as a banded unit — answer, contributors, summaries — from three
    // colours the model already spends on those three ranks elsewhere.
    sheet.getRange(`B${metricRow}:${LAST_COLUMN}${metricRow}`).format.fill =
      COLORS.lightBlue;
    // PARTIAL font patch on purpose: a full font object here would repaint the
    // green cross-sheet actual and the black selector black-and-plain, and the
    // provenance channel is the only thing on the sheet saying where a number
    // came from. `styleFont` is safe on B alone, which holds a label.
    styleFont(sheet, `B${metricRow}`, COLORS.black, { bold: true });
    sheet.getRange(
      `${ACTUAL_COLUMN}${metricRow}:${LAST_COLUMN}${metricRow}`,
    ).format.font = { bold: true };
    sheet.getRange(`B${consensusRow}:${LAST_COLUMN}${lowRow}`).format.fill =
      COLORS.subsection;

    sheet.getRange(
      `${ACTUAL_COLUMN}${metricRow}:${LAST_COLUMN}${lowRow}`,
    ).format.numberFormat = numberFormat;

    // A BLANK ROW BETWEEN BLOCKS, at the reviewer's instruction ("there should
    // be a space in between each broker"). The blocks ran straight into one
    // another — a metric row sat directly under the previous block's `Low`, with
    // nothing but a change of fill to say a new panel had started. One empty row
    // is the whole separation; it does not go between the contributor rows,
    // which are a list within a block and are held together by being one.
    row += 1;
  }

  // INDEPENDENT FORECAST ASSUMPTIONS LIVE HERE, NOT ON THE MODEL FACE.
  //
  // Guidance, commitments, historical run-rates and user assumptions are
  // genuine inputs, but putting their literal values in the Operating Model
  // makes a forecast indistinguishable from an unexplained hardcode.  This
  // block is the single blue-input authority; the model face links here in
  // green. A row is emitted only when at least one of its three periods is an
  // independent-input authority. Formula, broker, schedule, explicit-zero and
  // intentionally blank paths never appear in this block.
  const statementRows = [
    ...(rowPlan.statement_rows?.income_statement ?? []),
    ...(rowPlan.statement_rows?.cash_flow ?? []),
  ];
  const assumptionDefinitions = statementRows
    .filter((definition) => definition.row_type !== "header")
    .map((definition) => ({
      definition,
      authorities: [0, 1, 2].map((index) =>
        resolveForecastAuthority(modelCase, definition, index),
      ),
    }))
    .filter(({ authorities }) =>
      authorities.some((authority) => authority.mechanism === "hardcode"),
    );
  if (assumptionDefinitions.length > 0) {
    setValue(sheet, `B${row}`, "Forecast assumptions");
    sheet.getRange(`B${row}:${LAST_COLUMN}${row}`).format.fill = COLORS.navy;
    styleFont(sheet, `B${row}:${LAST_COLUMN}${row}`, COLORS.white, { bold: true });
    row += 1;
    for (const { definition, authorities } of assumptionDefinitions) {
      assumptionRows[definition.row_id] = row;
      setValue(sheet, `B${row}`, definition.label);
      applyFormula(
        sheet,
        `${ACTUAL_COLUMN}${row}`,
        `='Operating Model'!I${definition.row}`,
      );
      for (let index = 0; index < 3; index += 1) {
        const authority = authorities[index];
        const address = `${FORECAST_COLUMNS_BROKERS[index]}${row}`;
        if (authority.mechanism !== "hardcode") continue;
        setValue(sheet, address, Number(authority.value));
        styleInput(sheet, address);
        addCommentOnce(
          workbook,
          sheet,
          address,
          forecastAuthorityComment(modelCase, definition, index, authority),
        );
      }
      sheet.getRange(`${ACTUAL_COLUMN}${row}:${LAST_COLUMN}${row}`).format.numberFormat =
        definition.number_format === "percentage" ? PERCENT : AMOUNT;
      row += 1;
    }
    row += 1;
  }

  sheet.getRange(`A1:A${row}`).format.columnWidth = 1;
  sheet.getRange(`B1:B${row}`).format.columnWidth = 27;
  sheet.getRange(`${ACTUAL_COLUMN}1:${LAST_COLUMN}${row}`).format.columnWidth = 10;
  return {
    sheet,
    selectedRows,
    assumptionRows,
    names,
    forecastColumns: FORECAST_COLUMNS_BROKERS,
    headerRow: HEADER_ROW,
    contributorRows,
  };
}

function buildForwardCurvesSheet(workbook, modelCase) {
  const sheet = workbook.worksheets.add("Forward Curves");
  sheet.showGridLines = false;
  styleFont(sheet, "B1:H250", COLORS.black);
  setValue(sheet, "B1", `${modelCase.issuer.name} Forward Curves and FX`);
  styleFont(sheet, "B1:H1", COLORS.black, { bold: true });
  setValue(sheet, "B3", "Curve / FX");
  setRow(
    sheet,
    "C3:H3",
    modelCase.periods.map((period, index) => periodLabel(period, index >= 3)),
  );
  sheet.getRange("B3:H3").format.fill = COLORS.navy;
  styleFont(sheet, "B3:H3", COLORS.white, { bold: true });
  const rows = { benchmarks: {}, manualRates: {}, fx: {}, cashYields: {} };
  let row = 5;
  const explicitCashBuckets = Array.isArray(modelCase.cash_policy?.buckets);
  if (explicitCashBuckets) {
    for (const bucket of normalisedCashBuckets(modelCase)) {
      rows.cashYields[bucket.bucket_id] = row;
      setValue(sheet, `B${row}`, `${bucket.label} — cash yield`);
      setRow(sheet, `F${row}:H${row}`, bucket.cash_yield);
      styleInput(sheet, `F${row}:H${row}`);
      sheet.getRange(`F${row}:H${row}`).format.numberFormat = BENCHMARK;
      row += 1;
    }
  } else {
    rows.cashYield = row;
    setValue(sheet, `B${row}`, "Eligible cash yield");
    setRow(sheet, `F${row}:H${row}`, modelCase.cash_policy.cash_yield);
    styleInput(sheet, `F${row}:H${row}`);
    sheet.getRange(`F${row}:H${row}`).format.numberFormat = BENCHMARK;
    row += 1;
  }
  // ONE ROW PER DISTINCT CURVE. Where two instruments name the same benchmark
  // but declare different `benchmark_rate` series — a swap-adjusted bond
  // against the raw index — each series is stated on its own row and is priced
  // off by its own instruments. Collapsing them onto the name silently gave one
  // of the two the other's rate.
  for (const curve of benchmarkCurvePlan(modelCase).curves) {
    rows.benchmarks[curve.key] = row;
    // The DESCRIPTIVE form. Column B here is 34 characters with C, D and E
    // empty beside it — the rates start at F — so it spills legally to about
    // 70, and this sheet is where the rate is actually entered. The short
    // `label` exists for the 12-character column E on the Operating Model's
    // instrument rows and is not needed anywhere that has room for the name.
    setValue(sheet, `B${row}`, curve.row_label ?? curve.label);
    setRow(sheet, `F${row}:H${row}`, curve.rates);
    styleInput(sheet, `F${row}:H${row}`);
    sheet.getRange(`F${row}:H${row}`).format.numberFormat = BENCHMARK;
    row += 1;
  }
  // A manual all-in rate can still reprice by forecast year. The interest
  // schedule previously displayed the first rate in its compact term column
  // and every forecast formula referenced that one cell, while the independent
  // solver correctly read all three declared rates. State the full series here
  // as visible blue assumptions and link the interest formulas to it, exactly
  // as floating instruments link to their benchmark curves.
  for (const instrument of modelCase.instruments ?? []) {
    if (instrument.rate_type !== "manual_all_in") continue;
    const rates = asSeries3(instrument.coupon_or_all_in_rate, 0);
    rows.manualRates[instrument.instrument_id] = row;
    setValue(sheet, `B${row}`, `${instrument.name} — all-in rate`);
    setRow(sheet, `F${row}:H${row}`, rates);
    styleInput(sheet, `F${row}:H${row}`);
    sheet.getRange(`F${row}:H${row}`).format.numberFormat = BENCHMARK;
    row += 1;
  }
  for (const [currency, pair] of Object.entries(modelCase.fx ?? {})) {
    const averageRow = row;
    const periodEndRow = row + 1;
    rows.fx[currency] = {
      average: averageRow,
      period_end: periodEndRow,
      quote: pair.quote,
    };
    setValue(sheet, `B${averageRow}`, `${currency} average FX`);
    setValue(sheet, `B${periodEndRow}`, `${currency} period-end FX`);
    setRow(sheet, `C${averageRow}:H${averageRow}`, pair.average_rates);
    setRow(sheet, `C${periodEndRow}:H${periodEndRow}`, pair.period_end_rates);
    styleInput(sheet, `C${averageRow}:H${periodEndRow}`);
    sheet.getRange(`C${averageRow}:H${periodEndRow}`).format.numberFormat =
      FX_RATE;
    row += 2;
  }
  sheet.getRange(`B1:B${row}`).format.columnWidth = 34;
  sheet.getRange(`C1:H${row}`).format.columnWidth = 12;
  return { sheet, rows };
}

function fxFormula(modelCase, curveRows, currency, periodIndex, kind) {
  if (currency === modelCase.issuer.reporting_currency) return "1";
  const fx = curveRows.fx[currency];
  if (!fx) throw new Error(`Missing Forward Curves FX row for ${currency}.`);
  const column = columnName(3 + periodIndex);
  const cell = `'Forward Curves'!${column}${fx[kind]}`;
  return fx.quote === "reporting_per_native" ? cell : `(1/${cell})`;
}

/**
 * The rate applied to a drawn balance.
 *
 * FIXED (bonds, fixed bank loans, vendor financing): the stated coupon in
 * column D, flat across the forecast. FLOATING (commercial paper, the
 * securitisation programmes, the farm credit facility, the RCF): the period's
 * benchmark plus the spread in column D, so the line REPRICES every year off
 * the forward curve. That repricing — not the balance basis — is the real
 * economic difference between a 2032 bond and a rolling CP programme.
 *
 * RECOMMENDATION (2026-07-26), overrulable: the reference leg is floored at
 * zero. Every US and European credit agreement, CP dealer agreement and
 * receivables programme written since ~2015 carries a zero floor on the
 * reference rate; without it a negative EURIBOR print would hand the issuer
 * income on drawn debt. It is a no-op on this case's positive curves, so it
 * costs nothing today and stops the model breaking on a curve that dips.
 */
function rateFormula(
  curveRows,
  instrument,
  forecastIndex,
  visibleRateCell = null,
  visibleBenchmarkCell = null,
  curveKey = null,
  visibleFloorCell = null,
) {
  if (instrument.rate_type === "unpriced") return "0";
  if (instrument.rate_type === "manual_all_in") {
    const row = curveRows.manualRates?.[instrument.instrument_id];
    if (row) {
      const column = ["F", "G", "H"][forecastIndex];
      return `'Forward Curves'!${column}${row}`;
    }
  }
  if (instrument.rate_type === "floating") {
    // The instrument's OWN curve row. Resolving by benchmark NAME handed every
    // instrument sharing a name the first one's rate, so a declared
    // per-instrument `benchmark_rate` was honoured by the solver and dropped by
    // the formula.
    const row =
      curveRows.benchmarks[curveKey ?? instrument.benchmark] ??
      curveRows.benchmarks[instrument.benchmark];
    const column = ["F", "G", "H"][forecastIndex];
    const benchmark =
      visibleBenchmarkCell ?? `'Forward Curves'!${column}${row}`;
    const spread = visibleRateCell
      ? visibleRateCell
      : String(Number(instrument.spread_bps ?? 0) / 10000);
    const floor =
      visibleFloorCell ??
      String(Number(instrument.benchmark_floor?.[forecastIndex] ?? 0));
    return `(MAX(${floor},${benchmark})+${spread})`;
  }
  return visibleRateCell
    ? visibleRateCell
    : String(Number(instrument.coupon_or_all_in_rate?.[forecastIndex] ?? 0));
}

// The forecast columns are asked for rather than restated. The Brokers grid now
// opens on the last ACTUAL, so the three forecasts sit one column right of where
// they used to; a literal ["C","D","E"] here would have gone on pointing at the
// actual and the first two forecasts, silently, on every broker-driven row in
// the model.
function brokerLink(brokerRows, metricId, forecastIndex) {
  const row = brokerRows.selectedRows[metricId];
  if (!row) return null;
  return `='Brokers'!${brokerRows.forecastColumns[forecastIndex]}${row}`;
}

function signedBrokerLink(definition, brokerRows, forecastIndex) {
  const link = definition.broker_metric_id
    ? brokerLink(brokerRows, definition.broker_metric_id, forecastIndex)
    : null;
  if (!link) return null;
  if (
    ["capex", "dividends", "share_buybacks"].includes(
      definition.semantic_role,
    )
  ) {
    return `=-ABS(${link.slice(1)})`;
  }
  return link;
}

// REMOVED 2026-07-26: couponsPerYear() and the (1+coupon/n)^n-1 gross-up.
// The reviewer does not want a coupon-frequency input on the face of the
// schedule, and the compounding it drove was false precision on an annual
// three-year model: the stated coupon IS the modelled cost of the bond.
// Column C is back to the rate type. See interestBasisNote() below for the
// single convention that now applies to every class.

function statementDefinitions(rowPlan) {
  return [
    ...(rowPlan.statement_rows?.income_statement ?? []),
    ...(rowPlan.statement_rows?.cash_flow ?? []),
  ];
}

function standaloneColumnFor(column) {
  return FORECAST_COLUMNS[ADJUSTMENT_COLUMNS.indexOf(column)];
}

// THE ACQUISITION CASE'S OPERATING RATIOS, AND WHERE EACH ONE COMES FROM.
//
// The acquisition block above the sheet carries the transaction controls — the
// transaction, not the target's P&L. Growth, margin, D&A, capex and tax are
// DERIVED FROM THE STANDALONE CASE, which is what cutting the controls from
// fourteen was for: the target takes the parent's growth rate, the
// parent's margin, the parent's tax rate, and says so on the face of the model
// rather than in a second declared copy that drifts. In order of preference:
//
//   1. the ratio LINE the company already prints against the driver, read
//      across from the standalone column. It is the visible statement of the
//      assumption and the reader can follow the reference to it;
//   2. the same ratio DERIVED INLINE from the standalone columns, for companies
//      that print no such line.
//
// There is deliberately no hardcoded target-ratio arm. A driver that silently becomes zero —
// `(1+0)^` for growth, a literal `0` for D&A and capex — still foots, still
// ties, and is the worst outcome this module can produce; it was also the
// outcome on every case except the one the module was written against.

// Floating-point noise is not a denominator. The adjustment-column margin used
// to arrive as `pro forma - standalone` on a RATIO row, which is -5.55e-17 when
// the two agree to the last bit; dividing target EBITDA by that produced
// -1.69e19 on the revenue line. Every division in this module tests its
// denominator against this floor first, and the solver applies the same floor,
// so the cell and its cache cannot part company over it.
const ACQUISITION_NEAR_ZERO = 1e-9;
const ACQUISITION_NEAR_ZERO_TEXT = "0.000000001";

function acquisitionDerivedDrivers(modelCase, rowPlan) {
  const definitions = statementDefinitions(rowPlan);
  const byRowId = new Map(
    definitions.map((definition) => [definition.row_id, definition]),
  );
  const byRole = (role) =>
    definitions.find(
      (definition) =>
        definition.acquisition_driver_role === role ||
        definition.semantic_role === role,
    ) ?? null;
  const ratioFor = (driver, kind = "ratio") => {
    if (!driver?.row_id) return null;
    return (
      definitions.find((definition) => {
        // A displayed ratio is only an acquisition driver when it is actually
        // live in the standalone forecast.  The streamlined operating face
        // deliberately leaves many pre-EBIT detail rows blank; selecting one
        // of those rows here makes the acquisition formula divide by an empty
        // cell even though the underlying EBITDA and revenue are available.
        if (
          definition.forecast_treatment === "uncalculated" ||
          definition.formula_authority === "intentionally_blank"
        ) {
          return false;
        }
        const operator = definition.calculation?.operator;
        const matches =
          kind === "growth"
            ? operator === "growth"
            : operator === "ratio" || operator === "negated_ratio";
        return matches && definition.calculation?.refs?.[0] === driver.row_id;
      }) ?? null
    );
  };
  const ebitda = byRole("adjusted_ebitda");
  const drivers = {
    revenue: byRole("revenue"),
    ebitda,
    da: byRole("depreciation_and_amortisation"),
    capex: byRole("capex"),
    working_capital: byRole("change_in_working_capital"),
    margin_ratio: ratioFor(ebitda, "ratio"),
    growth_ratio: ratioFor(ebitda, "growth"),
    da_ratio: ratioFor(byRole("depreciation_and_amortisation")),
    capex_ratio: ratioFor(byRole("capex")),
    tax_rate_ratio: byRole("effective_tax_rate"),
  };
  // A ratio line states itself over SOME denominator, and which one is the
  // filer's choice: D&A over sales here, D&A over EBITDA there. Read it off the
  // line's own calculation instead of assuming sales, or the driver computes
  // `sales x (D&A/EBITDA)` and is wrong by the whole margin.
  const denominatorOf = (ratio) => {
    const reference = ratio?.calculation?.refs?.[1];
    return reference ? (byRowId.get(reference) ?? null) : null;
  };
  drivers.da_ratio_denominator = denominatorOf(drivers.da_ratio);
  drivers.capex_ratio_denominator = denominatorOf(drivers.capex_ratio);
  drivers.standalone_ratio_row_ids = new Set(
    [
      drivers.margin_ratio,
      drivers.growth_ratio,
      drivers.da_ratio,
      drivers.capex_ratio,
      drivers.tax_rate_ratio,
    ]
      .filter(Boolean)
      .map((definition) => definition.row_id),
  );
  return drivers;
}

// The EBITDA margin the target is bought on, as formula text for one adjustment
// column. The printed ratio LINE first — it reads across from the standalone
// column, so the reader can follow the reference to the number it states — then
// the same quotient inline for companies that print no such line.
function acquisitionMarginExpression(drivers, column) {
  const standaloneColumn = standaloneColumnFor(column);
  if (drivers.ebitda && drivers.revenue) {
    return (
      `IFERROR(${standaloneColumn}${drivers.ebitda.row}/` +
      `${standaloneColumn}${drivers.revenue.row},0)`
    );
  }
  // A printed standalone margin is an acceptable fallback, but the adjustment
  // column must never divide by or depend on its own as-yet-unpopulated ratio
  // row. Acquisition operating assumptions always read from standalone
  // authority and then flow through the adjustment case.
  if (drivers.margin_ratio) {
    return `${standaloneColumn}${drivers.margin_ratio.row}`;
  }
  return null;
}

function acquisitionGrowthExpression(drivers, rowPlan, column) {
  if (drivers.growth_ratio) return `${column}${drivers.growth_ratio.row}`;
  if (drivers.ebitda) {
    // The standalone case's own year-on-year EBITDA growth, spelled out where
    // the company prints no growth line. FY1 steps back to the last ACTUAL,
    // which is the same base the printed line uses.
    const index = ADJUSTMENT_COLUMNS.indexOf(column);
    const standaloneColumn = FORECAST_COLUMNS[index];
    const priorColumn =
      index === 0
        ? HISTORICAL_COLUMNS[HISTORICAL_COLUMNS.length - 1]
        : FORECAST_COLUMNS[index - 1];
    const prior = `${priorColumn}${drivers.ebitda.row}`;
    return (
      `IF(ABS(${prior})<${ACQUISITION_NEAR_ZERO_TEXT},0,` +
      `IFERROR(${standaloneColumn}${drivers.ebitda.row}/${prior}-1,0))`
    );
  }
  return null;
}

// D&A and capex, as an AMOUNT in one adjustment column. Same ladder: the
// printed ratio line over its own denominator, then the standalone column's own
// relationship to revenue applied to the target's revenue. There is no second
// set of target-specific hardcodes.
function acquisitionRatioDrivenAmount(drivers, column, kind) {
  const ratio = kind === "da" ? drivers.da_ratio : drivers.capex_ratio;
  const denominator =
    kind === "da" ? drivers.da_ratio_denominator : drivers.capex_ratio_denominator;
  const driver = kind === "da" ? drivers.da : drivers.capex;
  if (ratio && denominator) {
    return `${column}${denominator.row}*${column}${ratio.row}`;
  }
  if (driver && drivers.revenue) {
    const standaloneColumn = standaloneColumnFor(column);
    return (
      `IFERROR(${column}${drivers.revenue.row}*` +
      `ABS(${standaloneColumn}${driver.row})/` +
      `${standaloneColumn}${drivers.revenue.row},0)`
    );
  }
  return null;
}

// What a ratio LINE says in the adjustment column: the standalone case's own
// ratio, read straight across. That IS the assumption — the target takes the
// parent's margin, the parent's growth, the parent's effective rate — and
// stating it here rather than as a control is why the acquisition block is
// eight rows and not fourteen.
function acquisitionRatioRowFormula(definition, column) {
  return `=${standaloneColumnFor(column)}${definition.row}`;
}

// THE NUMERIC TWIN OF THE TWO FUNCTIONS ABOVE.
//
// What every RATE row in the adjustment column caches. It has to reproduce
// `acquisitionRatioRowFormula` arm for arm, and the generic `IFERROR(a/b,0)`
// the emitter writes on every other ratio line, because a cache that disagrees
// with the formula beside it is a number the workbook displays and cannot
// reproduce — which is exactly what put -5.55e-17 under the revenue division.
//
// `null` means "leave the recalculated cache alone": a growth line with no
// prior adjustment column evaluates to an empty string, and no number is the
// honest cache for it.
function acquisitionAdjustmentRatioCaches(
  modelCase,
  rowPlan,
  standaloneValues,
  proFormaValues,
) {
  const values = new Map();
  const drivers = acquisitionDerivedDrivers(modelCase, rowPlan);
  // THE TOGGLE COMES FIRST. Every adjustment cell is wrapped
  // `IF($P$<toggle>=0,0,...)`, so with the module off the whole column is a
  // formula-driven zero and the only honest cache for a rate row is zero too —
  // not the ratio the formula would read across if it were switched on.
  const acquisitionEnabled = Number(modelCase.acquisition?.enabled ?? 0) !== 0;
  // Each of the five driver rate lines reads STRAIGHT ACROSS from the
  // standalone column, so its cache is the standalone value of that same line.
  const readAcross = (ratio) => {
    if (!ratio) return;
    values.set(
      ratio.row,
      acquisitionEnabled
        ? Number(standaloneValues.get(ratio.row_id) ?? 0)
        : 0,
    );
  };
  const adjustmentOf = (rowId) =>
    Number(proFormaValues.get(rowId) ?? 0) -
    Number(standaloneValues.get(rowId) ?? 0);
  readAcross(drivers.margin_ratio);
  readAcross(drivers.growth_ratio);
  readAcross(drivers.tax_rate_ratio);
  readAcross(drivers.da_ratio);
  readAcross(drivers.capex_ratio);
  // Every OTHER rate line runs its own arithmetic on the adjustment column's
  // own constituents — that is the formula the emitter writes there — so the
  // cache is that ratio, not the difference of two ratios. `IFERROR(a/b,0)`
  // returns zero on a zero denominator and this returns zero with it.
  for (const definition of statementDefinitions(rowPlan)) {
    if (values.has(definition.row)) continue;
    const calculation =
      definition.forecast_calculation ?? definition.calculation;
    if (!calculation) continue;
    if (calculation.operator === "growth") {
      values.set(definition.row, null);
      continue;
    }
    if (!["ratio", "negated_ratio"].includes(calculation.operator)) continue;
    const [numeratorId, denominatorId] = calculation.refs;
    if (!numeratorId || !denominatorId) continue;
    const denominator = adjustmentOf(denominatorId);
    const quotient =
      denominator === 0 ? 0 : adjustmentOf(numeratorId) / denominator;
    values.set(
      definition.row,
      calculation.operator === "negated_ratio" ? -quotient : quotient,
    );
  }
  return values;
}

function acquisitionFactorInlineFormula(column, rowPlan) {
  const c = rowPlan.controls;
  const closeDate = `DATE($P$${c.close_year},$P$${c.close_month},1)`;
  const periodEnd = `${column}$${rowPlan.period_row}`;
  const index = ADJUSTMENT_COLUMNS.indexOf(column);
  if (index < 0) {
    throw new Error(`Unknown acquisition adjustment column ${column}.`);
  }
  // Use the actual model period boundary, not EDATE(period-end,-12).  A 52/53
  // week filer can be several days away from a calendar-year approximation;
  // the solver already uses prior period-end + one day, so the visible formula
  // must use that identical authority.
  const priorPeriodColumn =
    index === 0
      ? HISTORICAL_COLUMNS[HISTORICAL_COLUMNS.length - 1]
      : ADJUSTMENT_COLUMNS[index - 1];
  const periodStart = `${priorPeriodColumn}$${rowPlan.period_row}+1`;
  return (
    `IF($P$${c.adjustments_enabled}=0,0,IF(${closeDate}>${periodEnd},0,` +
    `IF(${closeDate}>=${periodStart},MAX(0,(${periodEnd}-${closeDate}+1)/` +
    `(${periodEnd}-(${periodStart})+1)),1)))`
  );
}

function acquisitionFactorFormula(column, rowPlan) {
  const row = rowPlan.controls.acquisition_operating_fraction;
  return Number.isInteger(row)
    ? `${column}$${row}`
    : acquisitionFactorInlineFormula(column, rowPlan);
}

/**
 * The acquisition tranche's DRAW — the separately supplied absolute debt
 * amount, recognised in the year the close date falls in and nowhere else.
 *
 * Factored out of the balance emitter so the interest emitter can state the
 * same thing (DEFECT 0.7): interest is charged on the average of the balance
 * when the tranche comes into existence and the balance at the year end, and
 * the first of those is `prior + draw`, not `prior`.
 */
function acquisitionDrawFormula(column, rowPlan) {
  const c = rowPlan.controls;
  const periodEnd = `${column}$${rowPlan.period_row}`;
  const closeDate = `DATE($P$${c.close_year},$P$${c.close_month},1)`;
  const index = ADJUSTMENT_COLUMNS.indexOf(column);
  if (index < 0) {
    throw new Error(`Unknown acquisition adjustment column ${column}.`);
  }
  const priorPeriodColumn =
    index === 0
      ? HISTORICAL_COLUMNS[HISTORICAL_COLUMNS.length - 1]
      : ADJUSTMENT_COLUMNS[index - 1];
  const periodStart = `${priorPeriodColumn}$${rowPlan.period_row}+1`;
  return (
    `IF(AND(${closeDate}<=${periodEnd},${closeDate}>=${periodStart}),` +
    `$P$${c.acquisition_debt_amount},0)`
  );
}

function acquisitionFullEbitdaInlineFormula(modelCase, column, rowPlan) {
  const c = rowPlan.controls;
  const drivers = acquisitionDerivedDrivers(modelCase, rowPlan);
  const currentIndex = ADJUSTMENT_COLUMNS.indexOf(column);
  if (currentIndex < 0) {
    throw new Error(`Unknown acquisition adjustment column ${column}.`);
  }
  // The close-year EBITDA is the entry EBITDA.  Every full year after close
  // compounds the corresponding standalone EBITDA growth once.  Raising the
  // current year's growth to an elapsed-year exponent was only correct when
  // every forecast growth rate happened to be identical.
  const closeDate = `DATE($P$${c.close_year},$P$${c.close_month},1)`;
  const growthFactors = [];
  for (let index = 1; index <= currentIndex; index += 1) {
    const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
    const growth = acquisitionGrowthExpression(
      drivers,
      rowPlan,
      adjustmentColumn,
    );
    if (!growth && Number(modelCase.acquisition?.enabled ?? 0) === 1) {
      throw new Error(
        "Acquisition target growth requires a standalone adjusted-EBITDA semantic row.",
      );
    }
    const priorPeriodEnd =
      `${ADJUSTMENT_COLUMNS[index - 1]}$${rowPlan.period_row}`;
    growthFactors.push(
      `IF(${closeDate}<=${priorPeriodEnd},1+${growth ?? "0"},1)`,
    );
  }
  if (
    currentIndex === 0 &&
    !drivers.ebitda &&
    Number(modelCase.acquisition?.enabled ?? 0) === 1
  ) {
    throw new Error(
      "Acquisition target growth requires a standalone adjusted-EBITDA semantic row.",
    );
  }
  return `$P$${c.target_ebitda}${growthFactors
    .map((factor) => `*(${factor})`)
    .join("")}`;
}

function acquisitionFullEbitdaFormula(modelCase, column, rowPlan) {
  const row = rowPlan.controls.acquisition_full_year_ebitda;
  return Number.isInteger(row)
    ? `${column}$${row}`
    : acquisitionFullEbitdaInlineFormula(modelCase, column, rowPlan);
}

function acquisitionAdjustmentFormula(modelCase, definition, column, rowPlan) {
  const c = rowPlan.controls;
  const factor = acquisitionFactorFormula(column, rowPlan);
  const fullEbitda = acquisitionFullEbitdaFormula(modelCase, column, rowPlan);
  const drivers = acquisitionDerivedDrivers(modelCase, rowPlan);
  const standaloneColumn = standaloneColumnFor(column);
  // A ratio line that drives an acquisition row reads across from the
  // standalone case. It is the visible statement of the assumption, which is
  // why the assumption is not restated as a control above.
  if (drivers.standalone_ratio_row_ids.has(definition.row_id)) {
    return acquisitionRatioRowFormula(definition, column);
  }
  const role =
    definition.acquisition_driver_role ??
    definition.semantic_role;
  if (role === "revenue") {
    const margin = acquisitionMarginExpression(drivers, column);
    if (!margin) return null;
    // The margin is a DENOMINATOR here, so it is tested before it is used. A
    // margin at or below the floor means the target's revenue is not derivable
    // and the line reads zero — never 1e19.
    return (
      `=IF(${margin}>${ACQUISITION_NEAR_ZERO_TEXT},` +
      `IFERROR(${fullEbitda}/${margin}*${factor},0),0)`
    );
  }
  if (role === "adjusted_ebitda") return `=${fullEbitda}*${factor}`;
  if (role === "depreciation_and_amortisation") {
    // D&A is a percentage of a driver, and the percentage is the target's own —
    // the line sitting against the D&A row when the company prints one, the
    // declared share of the target's EBITDA when it does not.
    const amount = acquisitionRatioDrivenAmount(drivers, column, "da");
    return amount ? `=${amount}` : null;
  }
  if (role === "ebit") {
    if (!drivers.ebitda || !drivers.da) return null;
    return `=${column}${drivers.ebitda.row}-${column}${drivers.da.row}`;
  }
  if (role === "change_in_working_capital") {
    if (!drivers.revenue) return null;
    return (
      `=IFERROR(${column}${drivers.revenue.row}*` +
      `${standaloneColumn}${definition.row}/` +
      `${standaloneColumn}${drivers.revenue.row},0)`
    );
  }
  if (role === "capex") {
    const amount = acquisitionRatioDrivenAmount(drivers, column, "capex");
    return amount ? `=-${amount}` : null;
  }
  if (role === "tax_expense") {
    const statementRows = [
      ...(rowPlan.statement_rows?.income_statement ?? []),
      ...(rowPlan.statement_rows?.cash_flow ?? []),
    ];
    const semanticRow = (semanticRole) =>
      statementRows.find(
        (statementRow) => statementRow.semantic_role === semanticRole,
      )?.row;
    const preTaxIncomeRow = semanticRow("pre_tax_income");
    const effectiveTaxRateRow = semanticRow("effective_tax_rate");
    if (!preTaxIncomeRow || !effectiveTaxRateRow) {
      throw new Error(
        "Acquisition tax calculation requires pre-tax-income and effective-tax-rate semantic roles.",
      );
    }
    // The adjustment column owns the incremental tax effect. The pro-forma
    // statement then remains the transparent identity Standalone + Adjustment,
    // rather than independently recalculating its whole tax charge from the
    // standalone tax-rate cell. This is acyclic and lets every transaction
    // change above PBT flow through exactly once.
    return (
      `=-MAX(0,${column}${preTaxIncomeRow})*` +
      `${standaloneColumn}${effectiveTaxRateRow}`
    );
  }
  return null;
}

function configureOperatingModel(
  workbook,
  sheet,
  modelCase,
  rowPlan,
  brokerRows,
  curveRows,
) {
  // The model ends where the reader can see it end. There is no hidden
  // "MODEL BUILD SUPPORT" block below the interest schedule any more.
  const maxRow = rowPlan.visible_end_row;
  // Physical row -> rank of total. Populated as each block is emitted, from the
  // row's own semantic identity; applied once, last, by applyTotalHierarchy().
  const totalRanks = new Map();
  // Physical rows carrying NARRATIVE prominence — the declared headline of each
  // statement, narrowed to what this case actually reports. A separate channel
  // from rank on purpose: see applyTotalHierarchy().
  const headlineRows = new Set();
  // Resolve a section's declared headlines against the ids that section really
  // compiled, and record the physical rows. Rows are looked up through the plan,
  // never assumed.
  const collectHeadlines = (section, rowsById) => {
    const entries = Object.entries(rowsById).filter(([, row]) =>
      Number.isInteger(Number(row)),
    );
    const wanted = headlineIds(
      section,
      entries.map(([id]) => id),
    );
    for (const [id, row] of entries) {
      if (wanted.has(id)) headlineRows.add(Number(row));
    }
  };
  // Rows whose forecast is intentionally uncalculated, so the rank pass can put
  // their grey back after it repaints the row.
  const uncalculatedRows = new Set();
  // Establish the workbook-wide presentation baseline before applying
  // section-, input- and formula-specific styles.
  styleFont(sheet, `A1:U${maxRow}`, COLORS.black);
  sheet.showGridLines = false;
  workbook.comments.setSelf({ displayName: "User" });
  // ONE title line, and nothing else. The subtitle that used to sit on row 2
  // repeated the currency and units (already stated on the period header), the
  // case id (an internal token) and a contents list of the sections below —
  // none of which a reader needs before the model starts. Row 2 is gone
  // entirely: the sheet reads title, blank, section 1.
  setValue(sheet, "B1", `${modelCase.issuer.name} Operating Model`);
  styleFont(sheet, "B1:U1", COLORS.black);
  styleFont(sheet, "B1", COLORS.black, { bold: true });

  const c = rowPlan.controls;
  // B:E and N:P only. The control block is two panels — the model controls on
  // the left, the acquisition case on the right — and it has no period grid, so
  // the band stops where the panels stop. See styleSection.
  styleSection(sheet, c.header, "1. CONTROL", ["B:E", "N:P"]);
  sheet.getRange(`N${c.adjustments_header}:P${c.adjustments_header}`).unmerge();
  setValue(
    sheet,
    `N${c.adjustments_header}`,
    "2. ACQUISITION CASE",
  );
  styleFont(
    sheet,
    `N${c.adjustments_header}:P${c.adjustments_header}`,
    COLORS.white,
    { bold: true },
  );
  // Two control treatments, deliberately unalike. A toggle reads On or Off and
  // carries the toggle fills; a numeric entry field carries the ordinary input
  // treatment — blue font, yellow fill. Everything used to share one green-ish
  // fill plus a green conditional font, so a rate the user was meant to type
  // over looked exactly like a switch — and green, which means "link to another
  // sheet", meant nothing at all. The entry fill was then #D9EAF7, which is the
  // ANSWER fill: an editable control and a subtotal were the same colour.
  const styleEntryControl = (address, numberFormat = null) => {
    styleInput(sheet, address);
    if (numberFormat) {
      sheet.getRange(address).format.numberFormat = numberFormat;
    }
  };
  // THE THIRD KIND OF CONTROL, and the one that had no treatment of its own.
  //
  // A SELECTOR is neither a switch nor a magnitude: it is a NAMED CHOICE out of
  // a list, and the broker case is the most consequential control in the model —
  // it decides which forecast every column from J rightwards is built on. It was
  // styled as an ordinary entry field, so it sat left-aligned in the body weight
  // while the two mechanical switches directly beneath it were bold, centred and
  // carrying a green fill. The eye went to `Circularity: On`. The line naming the
  // entire forecast basis was the quietest thing in the panel, which is the
  // reviewer's complaint exactly: the selected case does not announce itself.
  //
  // It takes the FIELD half of the toggle treatment — centred and bold, so it
  // reads as a live setting rather than as stray text — and none of the toggle's
  // font colour. It is a hardcoded input, its blue is its provenance, and
  // `{ bold: true }` merges over styleInput()'s blue instead of replacing it.
  // The STATE half arrives conditionally in applyConditionalState(), where the
  // control's value can actually be tested.
  const styleSelectorControl = (address) => {
    styleInput(sheet, address);
    const range = sheet.getRange(address);
    range.format.font = { bold: true };
    range.format.horizontalAlignment = "center";
  };
  const styleToggleControl = (address) => {
    const range = sheet.getRange(address);
    range.dataValidation = {
      rule: { type: "whole", operator: "between", formula1: 0, formula2: 1 },
    };
    range.format.numberFormat = TOGGLE;
    range.format.font = {
      name: "Calibri",
      size: 8,
      bold: true,
      color: COLORS.black,
    };
    range.format.horizontalAlignment = "center";
    range.conditionalFormats.add("cellIs", {
      operator: "equal",
      formula: 1,
      format: { fill: COLORS.toggleOn, font: { color: COLORS.black } },
    });
    range.conditionalFormats.add("cellIs", {
      operator: "equal",
      formula: 0,
      format: { fill: COLORS.toggleOff, font: { color: COLORS.darkBorder } },
    });
  };

  const controls = [
    [c.broker_case, "Broker case", modelCase.controls.broker_case, "selector"],
    [
      c.circularity,
      "Circularity",
      Number(modelCase.controls.circularity),
      "toggle",
    ],
    [
      c.debt_maturities_roll,
      "Debt maturity repayments",
      Number(modelCase.controls.debt_maturities_roll),
      "toggle",
    ],
    [
      // ONE minimum cash row. It ships with a value and the user simply types
      // over it. The previous calculated / override / effective triplet made a
      // reader work out which of three rows was live, and the "calculated" row
      // was a frozen literal anyway.
      c.effective_minimum_cash,
      "Minimum cash",
      modelCase.cash_policy.minimum_cash_override ??
        Math.min(
          ...normalisedCashBuckets(modelCase).find(
            (bucket) => bucket.forecast_treatment === "balancing",
          ).historical_year_end,
        ),
      "entry",
      CONTROL_AMOUNT,
    ],
  ];
  for (const [row, label, value, treatment, numberFormat] of controls) {
    setValue(sheet, `B${row}`, label);
    setValue(sheet, `C${row}`, value);
    if (treatment === "toggle") styleToggleControl(`C${row}`);
    else if (treatment === "selector") styleSelectorControl(`C${row}`);
    else styleEntryControl(`C${row}`, numberFormat ?? null);
  }
  addCommentOnce(
    workbook,
    sheet,
    `C${c.effective_minimum_cash}`,
    modelCase.cash_policy.minimum_cash_override !== null &&
      modelCase.cash_policy.minimum_cash_override !== undefined
      ? "Minimum-cash authority: explicit user override."
      : "Minimum-cash authority: lowest reported year-end balance of the balancing cash bucket across the three historical periods. This is an editable operating-liquidity assumption, not a forecast output.",
  );
  sheet.getRange(`C${c.broker_case}`).dataValidation = {
    rule: {
      type: "list",
      values: ["Consensus", "High", "Low", ...brokerRows.names],
    },
  };

  const acquisition = modelCase.acquisition ?? {};
  const fy1AdjustedEbitda = Number(
    modelCase.operating_metrics?.adjusted_ebitda?.values?.[3] ??
      modelCase.operating_metrics?.ebitda?.values?.[3] ??
      0,
  );
  const illustrativeTargetEbitda = Math.max(1, Math.abs(fy1AdjustedEbitda) * 0.01);
  const illustrativeMultiple = 10;
  const illustrativeEnterpriseValue = illustrativeTargetEbitda * illustrativeMultiple;
  const illustrativeDebt = illustrativeEnterpriseValue * 0.5;
  const illustrativeCloseYear = new Date(
    modelCase.periods?.[3]?.date ?? Date.UTC(new Date().getUTCFullYear(), 11, 31),
  ).getUTCFullYear();
  // The acquisition case is now only the transaction itself: what is bought,
  // at what price, how much of it is debt-funded, at what rate and when. Its
  // operating profile is inherited from the standalone case in the adjustment
  // columns, so nothing here restates a growth rate, a margin or a ratio.
  const acquisitionControls = [
    // The switch is described by what it does to the face of the model — turn
    // the adjustment columns on or off — not by the transaction that happens to
    // populate them.
    [
      c.adjustments_enabled,
      "Adjustment columns",
      acquisition.enabled ?? 0,
      TOGGLE,
      "toggle",
    ],
    [
      c.transaction_enterprise_value,
      "Enterprise value",
      acquisition.transaction_enterprise_value ?? illustrativeEnterpriseValue,
      AMOUNT,
      "entry",
    ],
    [
      c.entry_ev_to_ebitda,
      "Entry EV / EBITDA",
      acquisition.entry_ev_to_ebitda ?? illustrativeMultiple,
      MULTIPLE,
      "entry",
    ],
    [c.target_ebitda, "Target EBITDA", null, AMOUNT, "formula"],
    [
      // Absolute acquisition debt is supplied independently from EV. EV
      // controls inferred EBITDA; this amount alone controls debt economics.
      c.acquisition_debt_amount,
      "Acquisition debt",
      acquisition.acquisition_debt_amount ?? illustrativeDebt,
      AMOUNT,
      "entry",
    ],
    [
      c.incremental_rate,
      "Debt rate",
      acquisition.incremental_rate ?? 0.05,
      // The rate the acquisition debt is struck at is an all-in coupon, not a
      // spread over anything, so it reads to the basis point.
      COUPON,
      "entry",
    ],
    [
      c.close_year,
      "Close year",
      acquisition.close_year ?? illustrativeCloseYear,
      YEAR,
      "entry",
    ],
    [
      c.close_month,
      "Close month",
      acquisition.close_month ?? 6,
      MONTH,
      "entry",
    ],
  ];
  for (const [row, label, value, format, treatment] of acquisitionControls) {
    setValue(sheet, `N${row}`, label);
    if (treatment === "formula") {
      applyFormula(
        sheet,
        `P${row}`,
        `=IFERROR(P${c.transaction_enterprise_value}/P${c.entry_ev_to_ebitda},0)`,
      );
      sheet.getRange(`P${row}`).format.numberFormat = format;
    } else if (treatment === "toggle") {
      setValue(sheet, `P${row}`, value);
      styleToggleControl(`P${row}`);
    } else {
      setValue(sheet, `P${row}`, value);
      styleEntryControl(`P${row}`, format);
    }
  }
  addCommentOnce(
    workbook,
    sheet,
    `N${c.adjustments_enabled}`,
    "Off: every cell in the adjustment columns (N:P) is exactly zero and " +
      "each pro-forma column returns its standalone column unchanged. " +
    "On: the acquisition inputs below populate the adjustment columns and " +
      "pro forma becomes standalone + adjustment. Formulas are present in " +
      "both states — the switch changes the answer, never the workings." +
      (Number(acquisition.enabled ?? 0) === 0
        ? " The populated transaction inputs are illustrative, scale-derived values for testing the module; replace them before using a live transaction case."
        : ""),
  );
  sheet.getRange(`P${c.close_year}`).dataValidation = {
    rule: {
      type: "list",
      values: modelCase.periods
        .slice(3)
        .map((period) => new Date(period.date).getUTCFullYear()),
    },
  };
  sheet.getRange(`P${c.close_month}`).dataValidation = {
    rule: { type: "whole", operator: "between", formula1: 1, formula2: 12 },
  };

  // THREE TITLES, CENTRED ACROSS THREE BLOCKS, AND NOT ONE MERGED CELL.
  //
  // Each title is written into the FIRST column of the block it names and
  // centred across the rest by `horizontal="centerContinuous"`, which
  // patchBlockTitleAlignment() writes into the package — see the note there for
  // why the format API cannot. "Pro Forma" moves from S to R for that reason:
  // the run it centres over is R:U, and centerContinuous centres a run from its
  // leftmost cell. Merging would centre them too, and would also break sorting,
  // copying and every range reference that crosses the row —
  // `layout.merged_calculation_cells_forbidden` exists to stop exactly that.
  setValue(sheet, `G${rowPlan.period_group_row}`, "Standalone");
  setValue(sheet, `N${rowPlan.period_group_row}`, "Adjustment");
  setValue(sheet, `R${rowPlan.period_group_row}`, "Pro Forma");
  for (const address of [
    `G${rowPlan.period_group_row}:L${rowPlan.period_group_row}`,
    `N${rowPlan.period_group_row}:P${rowPlan.period_group_row}`,
    `R${rowPlan.period_group_row}:U${rowPlan.period_group_row}`,
  ]) {
    sheet.getRange(address).format.fill = COLORS.subsection;
    styleFont(sheet, address, COLORS.black, { bold: true });
    // No `format.horizontalAlignment` here on purpose: the writer REJECTS
    // "centerContinuous" outright ("Unsupported horizontal alignment"), and the
    // values it does accept it silently drops — xl/styles.xml carried not one
    // `horizontal="..."` attribute. patchBlockTitleAlignment() is the channel.
  }
  setValue(
    sheet,
    `B${rowPlan.period_row}`,
    `(${modelCase.issuer.reporting_currency} in ${modelCase.issuer.units})`,
  );
  setRow(
    sheet,
    `G${rowPlan.period_row}:I${rowPlan.period_row}`,
    modelCase.periods.slice(0, 3).map((period) => new Date(period.date)),
  );
  setRow(
    sheet,
    `J${rowPlan.period_row}:L${rowPlan.period_row}`,
    modelCase.periods.slice(3).map((period) => new Date(period.date)),
  );
  setRow(
    sheet,
    `N${rowPlan.period_row}:P${rowPlan.period_row}`,
    modelCase.periods.slice(3).map((period) => new Date(period.date)),
  );
  applyFormula(sheet, `R${rowPlan.period_row}`, `=I${rowPlan.period_row}`);
  setRow(
    sheet,
    `S${rowPlan.period_row}:U${rowPlan.period_row}`,
    modelCase.periods.slice(3).map((period) => new Date(period.date)),
  );
  sheet.getRange(`G${rowPlan.period_row}:I${rowPlan.period_row}`).format.numberFormat =
    "mmm-yy";
  for (const address of [
    `J${rowPlan.period_row}:L${rowPlan.period_row}`,
    `N${rowPlan.period_row}:P${rowPlan.period_row}`,
    `S${rowPlan.period_row}:U${rowPlan.period_row}`,
  ]) {
    sheet.getRange(address).format.numberFormat = 'mmm-yy"E"';
  }
  sheet.getRange(`R${rowPlan.period_row}`).format.numberFormat = "mmm-yy";
  styleFont(
    sheet,
    `B${rowPlan.period_row}:U${rowPlan.period_row}`,
    COLORS.white,
    { bold: true },
  );
  for (const address of activeRanges(rowPlan.period_row)) {
    sheet.getRange(address).format.fill = COLORS.navy;
  }

  styleSection(
    sheet,
    rowPlan.section_headers.income_statement,
    "3. INCOME STATEMENT",
  );
  styleSection(sheet, rowPlan.section_headers.cash_flow, "4. CASH FLOW");
  styleSection(
    sheet,
    rowPlan.section_headers.debt_schedule,
    "5. DEBT SCHEDULE",
  );
  styleSection(
    sheet,
    rowPlan.section_headers.rcf_waterfall,
    "6. RCF CASH SWEEP",
  );
  styleSection(
    sheet,
    rowPlan.section_headers.interest_schedule,
    "7. INTEREST SCHEDULE",
  );

  const allStatementRows = [
    ...rowPlan.statement_rows.income_statement,
    ...rowPlan.statement_rows.cash_flow,
  ];
  // Per SECTION, not over the concatenation: rank and headline both resolve
  // against the section a row is being emitted into, and the two statements
  // legitimately disagree about the same id.
  for (const section of [
    RANK_SECTION.INCOME_STATEMENT,
    RANK_SECTION.CASH_FLOW,
  ]) {
    const definitions = rowPlan.statement_rows[section] ?? [];
    for (const definition of definitions) {
      setValue(sheet, `B${definition.row}`, definition.label);
      styleStatementRow(
        sheet,
        definition,
        totalRanks,
        uncalculatedRows,
        section,
      );
    }
    // `row_id` ONLY, never `semantic_role`. A semantic role can legitimately sit
    // on more than one row in a section — a bridge line links back to the row it
    // restates — and a headline is a statement about ONE named line, so matching
    // on the role would let the bolding land on the restatement instead of the
    // line itself.
    collectHeadlines(
      section,
      Object.fromEntries(
        definitions.map((definition) => [definition.row_id, definition.row]),
      ),
    );
  }

  const interestRows = rowPlan.interest_summary_rows;
  const waterfallRows = rowPlan.waterfall_rows;
  const debtRows = rowPlan.debt_summary_rows;
  const cashBucketPlans = rowPlan.cash_buckets ?? [];
  const explicitCashBuckets = cashBucketPlans.length > 0;
  const statementByRole = new Map(
    allStatementRows
      .filter((row) => row.semantic_role)
      .map((row) => [row.semantic_role, row]),
  );
  // A collapsed duplicate answer (one visible EBIT) leaves its role behind
  // as an alias on the surviving row; role lookups must land on the single
  // visible owner. Aliases never displace a row that genuinely owns a role.
  for (const row of allStatementRows) {
    for (const alias of row.role_aliases ?? []) {
      if (!statementByRole.has(alias)) statementByRole.set(alias, row);
    }
  }
  const nonBalancingCashBuckets = cashBucketPlans.filter(
    (bucket) =>
      bucket.forecast_treatment !== "balancing" &&
      bucket.included_in_cash_flow_cash !== false,
  );
  const cashFlowCashFormula = (column) => {
    const cells = cashBucketPlans
      .filter((bucket) => bucket.included_in_cash_flow_cash !== false)
      .map((bucket) => `${column}${bucket.balance_row}`);
    return sumCellFormula(cells);
  };
  const cashReconciliationFormula = (column) => {
    const rows = [
      statementByRole.get("cash_from_operations")?.row,
      statementByRole.get("cash_from_investing")?.row,
      statementByRole.get("cash_from_financing")?.row,
      statementByRole.get("non_balancing_cash_bucket_movement")?.row,
    ].filter(Number.isInteger);
    return sumCellFormula(rows.map((row) => `${column}${row}`));
  };
  const endingCashStatementFormula = (column) => {
    const rows = [
      statementByRole.get("opening_cash")?.row,
      statementByRole.get("net_change_in_cash")?.row,
      statementByRole.get("fx_effect_on_cash")?.row,
    ].filter(Number.isInteger);
    if (rows.length < 2) {
      throw new Error(
        "Ending cash requires opening cash and net change in cash statement roles.",
      );
    }
    return sumCellFormula(rows.map((row) => `${column}${row}`));
  };
  const nonBalancingBucketMovementFormula = (
    column,
    priorColumn,
  ) => {
    const terms = nonBalancingCashBuckets.map(
      (bucket) => `${column}${bucket.balance_row}-${priorColumn}${bucket.balance_row}`,
    );
    return terms.length ? `=${terms.join("+")}` : "=0";
  };
  function standaloneSemanticFormula(definition, column, forecastIndex) {
    const role = definition.semantic_role;
    if (role === "interest_income") {
      return `=${column}${interestRows.interest_income_schedule}`;
    }
    if (role === "interest_expense") {
      return `=${column}${interestRows.gross_interest_expense}`;
    }
    if (role === "cash_interest_paid") {
      return `=${column}${interestRows.cash_interest_paid}`;
    }
    if (role === "cash_interest_received") {
      return `=${column}${interestRows.cash_interest_received}`;
    }
    if (role === "net_finance_addback") {
      return `=-${column}${interestRows.net_interest_expense}`;
    }
    if (role === "non_cash_interest_addback") {
      const nonCashInstrumentRows = rowPlan.instruments
        .flatMap((plan) => {
          const instrument = modelCase.instruments.find(
            (candidate) => candidate.instrument_id === plan.instrument_id,
          );
          return [
            ...(instrument?.cash_interest === false && plan.interest_row
              ? [`${column}${plan.interest_row}`]
              : []),
            ...(plan.pik_interest_row
              ? [`${column}${plan.pik_interest_row}`]
              : []),
          ];
        });
      return (
        `=-(${column}${interestRows.non_cash_interest}` +
        `${nonCashInstrumentRows.length ? `+SUM(${nonCashInstrumentRows.join(",")})` : ""})`
      );
    }
    if (role === "debt_issuance") {
      return Number.isInteger(waterfallRows.non_rcf_debt_proceeds)
        ? `=${column}${waterfallRows.non_rcf_debt_proceeds}`
        : "=0";
    }
    if (role === "debt_repayment") {
      const mandatory = debtRows.mandatory_debt_repayments;
      return Number.isInteger(mandatory) ? `=-${column}${mandatory}` : "=0";
    }
    if (role === "rcf_draw") return `=${column}${waterfallRows.rcf_draw_waterfall}`;
    if (role === "rcf_repayment") {
      return `=-${column}${waterfallRows.rcf_repayment_waterfall}`;
    }
    if (role === "lease_principal") {
      if (modelCase.lease_policy?.mode === "exclude") return "=0";
      const assumptionRow = debtRows.lease_principal_assumption;
      if (!Number.isInteger(assumptionRow)) {
        throw new Error(
          "Lease principal requires a visible lease-principal assumption row.",
        );
      }
      return `=-${column}${assumptionRow}`;
    }
    if (role === "non_balancing_cash_bucket_movement") {
      const prior = forecastIndex === 0 ? "I" : FORECAST_COLUMNS[forecastIndex - 1];
      return nonBalancingBucketMovementFormula(column, prior);
    }
    if (role === "net_change_in_cash" && explicitCashBuckets) {
      return cashReconciliationFormula(column);
    }
    if (role === "opening_cash") {
      const prior = forecastIndex === 0 ? "I" : FORECAST_COLUMNS[forecastIndex - 1];
      return `=${prior}${statementByRole.get("ending_cash").row}`;
    }
    if (role === "ending_cash") {
      // The cash-flow statement owns its own closing cash through the declared
      // opening + movement + FX identity. Cash buckets, liquidity and interest
      // are consumers of that answer; they never push a same-period balance
      // back up into the statement.
      return endingCashStatementFormula(column);
    }
    // The acquisition overlays used to own three rows here and pinned them to
    // zero in the standalone columns. They now ride on company-reported lines,
    // whose standalone columns must keep showing the company's own numbers.
    return null;
  }

  function historicalSemanticFormula(definition, column) {
    if (definition.semantic_role === "cash_tax_rate") {
      const cashTaxes = statementByRole.get("cash_taxes")?.row;
      const preTaxIncome = statementByRole.get("pre_tax_income")?.row;
      if (!cashTaxes || !preTaxIncome) {
        throw new Error(
          "Cash-tax-rate history requires cash-taxes and pre-tax-income semantic rows.",
        );
      }
      return `=IFERROR(-${column}${cashTaxes}/${column}${preTaxIncome},0)`;
    }
    if (definition.semantic_role === "interest_income") {
      return `=${column}${interestRows.interest_income_schedule}`;
    }
    if (definition.semantic_role === "interest_expense") {
      return `=${column}${interestRows.gross_interest_expense}`;
    }
    if (definition.semantic_role === "cash_interest_paid") {
      return `=${column}${interestRows.cash_interest_paid}`;
    }
    if (definition.semantic_role === "cash_interest_received") {
      return `=${column}${interestRows.cash_interest_received}`;
    }
    if (definition.semantic_role === "net_finance_addback") {
      return `=-${column}${interestRows.net_interest_expense}`;
    }
    if (definition.semantic_role === "opening_cash") {
      const index = HISTORICAL_COLUMNS.indexOf(column);
      return index > 0
        ? `=${HISTORICAL_COLUMNS[index - 1]}${statementByRole.get("ending_cash").row}`
        : null;
    }
    if (definition.semantic_role === "ending_cash") {
      // Historical explicit cash buckets are the filed closing-cash
      // decomposition and therefore own the historical total.  Using the
      // cash-flow identity here would make the first-period residual movement
      // depend on closing cash while closing cash simultaneously depended on
      // that residual.  Forecast closing cash remains owned by the cash-flow
      // identity; the balancing bucket consumes that answer downstream.
      return explicitCashBuckets
        ? cashFlowCashFormula(column)
        : endingCashStatementFormula(column);
    }
    if (definition.semantic_role === "non_balancing_cash_bucket_movement") {
      const index = HISTORICAL_COLUMNS.indexOf(column);
      if (index > 0) {
        return nonBalancingBucketMovementFormula(
          column,
          HISTORICAL_COLUMNS[index - 1],
        );
      }
      const ending = statementByRole.get("ending_cash")?.row;
      const opening = statementByRole.get("opening_cash")?.row;
      const cfo = statementByRole.get("cash_from_operations")?.row;
      const cfi = statementByRole.get("cash_from_investing")?.row;
      const cff = statementByRole.get("cash_from_financing")?.row;
      const fx = statementByRole.get("fx_effect_on_cash")?.row;
      const components = [cfo, cfi, cff, fx]
        .filter(Number.isInteger)
        .map((row) => `${column}${row}`);
      return `=${column}${ending}-${column}${opening}-SUM(${components.join(",")})`;
    }
    if (
      definition.semantic_role === "net_change_in_cash" &&
      explicitCashBuckets
    ) {
      return cashReconciliationFormula(column);
    }
    return null;
  }

  for (const definition of allStatementRows) {
    if (definition.row_type === "header") continue;
    const values = rowValues(modelCase, definition);
    // The revolver legs exist only where the forecast waterfall exists. A
    // history with no sourced draw or repayment has nothing to calculate —
    // the cells are structurally empty and render grey-blank, never as
    // white dash-zeros pretending a schedule ran in a year it did not.
    const structurallyEmptyHistory =
      presentationEpoch() >= 3 &&
      ["rcf_draw", "rcf_repayment"].includes(definition.semantic_role) &&
      ![0, 1, 2].some(
        (index) =>
          values[index] !== null &&
          values[index] !== undefined &&
          Math.abs(Number(values[index])) > 1e-9,
      );
    for (let index = 0; index < 3; index += 1) {
      const column = HISTORICAL_COLUMNS[index];
      if (structurallyEmptyHistory) continue;
      const semantic = historicalSemanticFormula(definition, column);
      // The hold-flat chain belongs to the FORECAST. In the historic block the
      // row must state the period's own reported figure, so a self-carry gives
      // way to the sourced value wherever one exists. Without a value there is
      // nothing to state and the carry is still better than a blank.
      const historicalSelfCarry =
        isSelfCarry(definition, definition.calculation) &&
        values[index] !== null &&
        values[index] !== undefined;
      const generic =
        !historicalSelfCarry &&
        (definition.historical_authority === "derived_formula" ||
          definition.historical_authority === "reported_total_reconciled" ||
          definition.row_type === "calculation" ||
          definition.row_type === "subtotal")
          ? genericFormula(rowPlan, definition, column)
          : null;
      const isPlaceholderCalculation =
        definition.row_type === "calculation" &&
        (definition.calculation?.refs?.length ?? 0) === 0;
      if (semantic) {
        applyFormula(sheet, `${column}${definition.row}`, semantic);
      } else if (
        isPlaceholderCalculation &&
        values[index] !== null &&
        values[index] !== undefined
      ) {
        setValue(sheet, `${column}${definition.row}`, Number(values[index]));
        styleInput(sheet, `${column}${definition.row}`);
        const provenance = (modelCase.provenance?.[definition.row_id] ?? []).find(
          (entry) => Number(entry.period_index) === index,
        );
        if (provenance) {
          addCommentOnce(
            workbook,
            sheet,
            `${column}${definition.row}`,
            provenanceComment(provenance),
          );
        }
      } else if (generic) {
        applyFormula(sheet, `${column}${definition.row}`, generic);
      } else if (values[index] !== null && values[index] !== undefined) {
        setValue(sheet, `${column}${definition.row}`, Number(values[index]));
        styleInput(sheet, `${column}${definition.row}`);
        const provenance = (modelCase.provenance?.[definition.row_id] ?? []).find(
          (entry) => Number(entry.period_index) === index,
        );
        if (provenance) {
          addCommentOnce(
            workbook,
            sheet,
            `${column}${definition.row}`,
            provenanceComment(provenance),
          );
        }
      }
    }
    for (let index = 0; index < 3; index += 1) {
      const column = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      const periodForecastCalculation = forecastCalculationForIndex(
        definition,
        index,
      );
      const periodRulesDeclared = hasForecastPeriodCalculations(definition);
      const semantic = standaloneSemanticFormula(
        definition,
        column,
        index,
      );
      const forecastAuthority = resolveForecastAuthority(
        modelCase,
        definition,
        index,
      );
      if (forecastAuthority.mechanism === "block") {
        throw new Error(
          `Unresolved forecast authority for ${definition.row_id} in ${modelCase.periods[index + 3]?.date ?? `forecast period ${index + 1}`}: ${forecastAuthority.reason ?? forecastAuthority.method}.`,
        );
      }
      // A row with a supplied forecast (broker/hardcode/zero) or an
      // intentionally blank one must NOT fall back to its historical
      // calculation here. Rows whose dependency direction reverses between
      // history and forecast — share-based compensation links one way in
      // history and the other in the forecast — otherwise emit a genuine
      // circular reference (J39 = J64 while J64 = J39), which Excel resolves
      // to zero. Mirrors the solver and coverage-gate logic.
      const forecastSupplied =
        !periodForecastCalculation &&
        (periodRulesDeclared ||
          forecastAuthority.mechanism !== "formula");
      // THE CARRY NEEDS SOMETHING TO CARRY. A hold-flat row's first forecast
      // column is the anchor the chain runs from, and the anchor is an
      // assumption — the source states it as its own figure, not as a repeat of
      // the last actual. Emitting `=I{row}` here reached back into history and
      // made the whole forecast a restatement of FY25. J takes the row's own
      // forecast value as a blue input; K and L then carry it forward.
      const forecastCarryAnchor =
        index === 0 &&
        !periodRulesDeclared &&
        !definition.forecast_calculation &&
        isSelfCarry(definition, definition.calculation) &&
        values[3] !== null &&
        values[3] !== undefined;
      const generic =
        !forecastSupplied &&
        !forecastCarryAnchor &&
        (periodForecastCalculation ||
          definition.row_type === "calculation" ||
          definition.row_type === "subtotal")
          ? genericFormula(
              rowPlan,
              definition,
              column,
              periodForecastCalculation,
            )
          : null;
      const brokerFormula = signedBrokerLink(
        definition,
        brokerRows,
        index,
      );
      // n/a OUTRANKS the semantic writer. A row marked uncalculated is one the
      // forecast deliberately does not produce, and a semantic role is not a
      // licence to put a number back on it — the debt-movement constituents
      // beneath Net Change in Debt carry roles the compiler can still resolve,
      // and without this they came back live in the standalone column while
      // reading n/a in the adjustment and pro-forma columns beside them. The
      // pro-forma writer below has always checked n/a first; this matches it.
      if (
        forecastAuthority.mechanism === "uncalculated"
      ) {
        setValue(sheet, `${column}${definition.row}`, null);
      } else if (semantic) {
        applyFormula(sheet, `${column}${definition.row}`, semantic);
      } else if (
        forecastAuthority.mechanism === "broker" &&
        brokerFormula
      ) {
        applyFormula(sheet, `${column}${definition.row}`, brokerFormula);
      } else if (generic) {
        applyFormula(sheet, `${column}${definition.row}`, generic);
      } else if (
        forecastAuthority.mechanism === "hardcode" &&
        forecastAuthority.value !== null
      ) {
        const assumptionRow = brokerRows.assumptionRows?.[definition.row_id];
        if (!Number.isInteger(assumptionRow)) {
          throw new Error(
            `Forecast assumption row missing for ${definition.row_id}.`,
          );
        }
        applyFormula(
          sheet,
          `${column}${definition.row}`,
          `='Brokers'!${brokerRows.forecastColumns[index]}${assumptionRow}`,
        );
      } else if (forecastAuthority.mechanism === "zero") {
        applyFormula(sheet, `${column}${definition.row}`, "=0");
      } else {
        throw new Error(
          `Forecast authority ${forecastAuthority.method} for ${definition.row_id} did not compile to a formula, broker link, input, zero or intentionally blank cell in forecast period ${index + 1}.`,
        );
      }
      const acquisitionFormula = acquisitionAdjustmentFormula(
        modelCase,
        definition,
        adjustmentColumn,
        rowPlan,
      );
      // Intentionally uncalculated issuer rows remain blank in the
      // adjustment block unless a genuine operating acquisition formula
      // applies through their semantic role.
      const forecastUncalculated =
        forecastAuthority.mechanism === "uncalculated";
      // THE ADJUSTMENT IS BUILT, NOT INFERRED.
      //
      // A row whose PRO-FORMA cell links down into a pro-forma schedule (gross
      // interest, ending cash, change in debt) gets an adjustment that links to
      // the SAME row of the ADJUSTMENT block. It is the identical reference,
      // one column-block to the left, so the reader can follow it — and, more
      // to the point, an instrument the acquisition never touches contributes
      // zero to that adjustment block and therefore zero here, BY CONSTRUCTION.
      //
      // What this replaces is `pro forma - standalone`, which made the
      // adjustment an artefact of two independently-computed columns: any
      // discrepancy between them, however unrelated to the transaction, landed
      // in the adjustment column and was read as a deal effect.
      const priorAdjustmentColumn =
        index === 0 ? null : ADJUSTMENT_COLUMNS[index - 1];
      const adjustmentLink = (() => {
        switch (definition.semantic_role) {
          case "interest_income":
            return `=${adjustmentColumn}${interestRows.interest_income_schedule}`;
          case "interest_expense":
            return `=${adjustmentColumn}${interestRows.gross_interest_expense}`;
          case "cash_interest_paid":
            return `=${adjustmentColumn}${interestRows.cash_interest_paid}`;
          case "cash_interest_received":
            return `=${adjustmentColumn}${interestRows.cash_interest_received}`;
          case "net_finance_addback":
            return `=-${adjustmentColumn}${interestRows.net_interest_expense}`;
          case "opening_cash":
            // The pro-forma block opens on the SAME last actual the standalone
            // block opens on, so the acquisition adds nothing to FY1 opening
            // cash. Thereafter it inherits the prior year's closing adjustment.
            return priorAdjustmentColumn
              ? `=${priorAdjustmentColumn}${statementByRole.get("ending_cash").row}`
              : "=0";
          case "ending_cash":
            return endingCashStatementFormula(adjustmentColumn);
          case "rcf_draw":
            return `=${adjustmentColumn}${waterfallRows.rcf_draw_waterfall}`;
          case "rcf_repayment":
            return `=-${adjustmentColumn}${waterfallRows.rcf_repayment_waterfall}`;
          case "non_cash_interest_addback":
            return `=-${adjustmentColumn}${interestRows.non_cash_interest}`;
          case "non_balancing_cash_bucket_movement":
            // The acquisition does not reclassify the issuer's restricted or
            // held-for-sale cash buckets.
            return "=0";
          case "net_change_in_cash":
            return explicitCashBuckets
              ? cashReconciliationFormula(adjustmentColumn)
              : null;
          // A company repayment or issuance line the transaction does not reach
          // is zero in the adjustment column. Where it DOES carry an
          // acquisition overlay the overlay formula above has already claimed
          // the cell, so this only ever fires on untouched rows.
          case "debt_issuance":
          case "debt_repayment":
          case "lease_principal":
            return "=0";
          default:
            return null;
        }
      })();
      if (forecastUncalculated) {
        setValue(sheet, `${adjustmentColumn}${definition.row}`, null);
      } else if (acquisitionFormula) {
        applyFormula(
          sheet,
          `${adjustmentColumn}${definition.row}`,
          acquisitionFormula,
        );
      } else if (adjustmentLink) {
        applyFormula(
          sheet,
          `${adjustmentColumn}${definition.row}`,
          adjustmentLink,
        );
      } else if (periodRulesDeclared) {
        // Period-specific rules describe the source workbook's standalone
        // forecast direction; they never create a transaction adjustment by
        // themselves. Pro forma therefore remains standalone plus zero here.
        applyFormula(
          sheet,
          `${adjustmentColumn}${definition.row}`,
          "=0",
        );
      } else if (periodForecastCalculation) {
        // The row states its own arithmetic; the adjustment column runs that
        // same arithmetic on the adjustment column's own constituents. For the
        // additive rows this is exactly the deal effect; for the ratio rows it
        // is the acquisition case's own ratio, which is what the margin, D&A
        // and capex ratio lines above already show.
        const formula = genericFormula(
          rowPlan,
          definition,
          adjustmentColumn,
          periodForecastCalculation,
        );
        // A roll-forward has no prior adjustment column to read in the first
        // deal period, so its null compilation is a constructed zero. Every
        // other operator that fails to compile is silent degradation of a
        // declared calculation and must stop the build.
        const rollForwardNull = [
          "prior_period",
          "prior_period_scaled_by",
        ].includes(periodForecastCalculation?.operator);
        if ((formula === null || formula === undefined) && !rollForwardNull) {
          throw new Error(
            `Adjustment-column formula for ${definition.row_id} did not compile; ` +
              "a declared calculation may not silently become a live zero.",
          );
        }
        applyFormula(
          sheet,
          `${adjustmentColumn}${definition.row}`,
          formula ?? "=0",
        );
      } else if (
        definition.row_type === "calculation" ||
        definition.row_type === "subtotal"
      ) {
        const formula = genericFormula(
          rowPlan,
          definition,
          adjustmentColumn,
        );
        const rollForwardNull = [
          "prior_period",
          "prior_period_scaled_by",
        ].includes(definition.calculation?.operator);
        if ((formula === null || formula === undefined) && !rollForwardNull) {
          throw new Error(
            `Adjustment-column formula for ${definition.row_id} did not compile; ` +
              "a declared calculation may not silently become a live zero.",
          );
        }
        applyFormula(
          sheet,
          `${adjustmentColumn}${definition.row}`,
          formula ?? "=0",
        );
      } else {
        applyFormula(sheet, `${adjustmentColumn}${definition.row}`, "=0");
      }
      if (forecastUncalculated) {
        setValue(sheet, `${proFormaColumn}${definition.row}`, null);
      } else if (definition.semantic_role === "interest_income") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${proFormaColumn}${interestRows.interest_income_schedule}`,
        );
      } else if (definition.semantic_role === "interest_expense") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${proFormaColumn}${interestRows.gross_interest_expense}`,
        );
      } else if (definition.semantic_role === "cash_interest_paid") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${proFormaColumn}${interestRows.cash_interest_paid}`,
        );
      } else if (definition.semantic_role === "cash_interest_received") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${proFormaColumn}${interestRows.cash_interest_received}`,
        );
      } else if (definition.semantic_role === "net_finance_addback") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=-${proFormaColumn}${interestRows.net_interest_expense}`,
        );
      } else if (
        definition.semantic_role === "non_cash_interest_addback"
      ) {
        const nonCashInstrumentRows = rowPlan.instruments
          .flatMap((plan) => {
            const instrument = modelCase.instruments.find(
              (candidate) => candidate.instrument_id === plan.instrument_id,
            );
            return [
              ...(instrument?.cash_interest === false && plan.interest_row
                ? [`${proFormaColumn}${plan.interest_row}`]
                : []),
              ...(plan.pik_interest_row
                ? [`${proFormaColumn}${plan.pik_interest_row}`]
                : []),
            ];
          });
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=-(${proFormaColumn}${interestRows.non_cash_interest}` +
            `${nonCashInstrumentRows.length ? `+SUM(${nonCashInstrumentRows.join(",")})` : ""})`,
        );
      } else if (definition.semantic_role === "effective_tax_rate") {
        const taxExpenseRow = statementByRole.get("tax_expense")?.row;
        const preTaxIncomeRow = statementByRole.get("pre_tax_income")?.row;
        if (!taxExpenseRow || !preTaxIncomeRow) {
          throw new Error(
            "Effective tax-rate calculation requires tax-expense and pre-tax-income semantic roles.",
          );
        }
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=IFERROR(-${proFormaColumn}${taxExpenseRow}/` +
            `${proFormaColumn}${preTaxIncomeRow},${column}${definition.row})`,
        );
      } else if (definition.semantic_role === "tax_expense") {
        // Pro forma is a presentation identity, not a second tax engine. The
        // incremental tax is calculated once in the adjustment column from
        // incremental PBT; this cell simply carries Standalone + Adjustment.
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${column}${definition.row}+${adjustmentColumn}${definition.row}`,
        );
      } else if (definition.semantic_role === "opening_cash") {
        // This semantic roll-forward outranks a source row's generic period
        // rule.  In every basis, FY1 opens on the shared last actual and later
        // years open on that same basis's prior closing cash.
        const prior =
          index === 0
            ? `R${statementByRole.get("ending_cash").row}`
            : `${PRO_FORMA_COLUMNS[index - 1]}${statementByRole.get("ending_cash").row}`;
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${prior}`,
        );
      } else if (
        definition.forecast_treatment === "broker" &&
        definition.broker_metric_id
      ) {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${column}${definition.row}+${adjustmentColumn}${definition.row}`,
        );
      } else if (periodRulesDeclared) {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${column}${definition.row}+${adjustmentColumn}${definition.row}`,
        );
      } else if (
        definition.semantic_role === "net_change_in_cash" &&
        explicitCashBuckets
      ) {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          cashReconciliationFormula(proFormaColumn),
        );
      } else if (periodForecastCalculation) {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          genericFormula(
            rowPlan,
            definition,
            proFormaColumn,
            periodForecastCalculation,
          ) ?? `=${column}${definition.row}`,
        );
      } else if (definition.semantic_role === "ending_cash") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          endingCashStatementFormula(proFormaColumn),
        );
      } else if (
        definition.semantic_role === "non_balancing_cash_bucket_movement"
      ) {
        const prior = index === 0 ? "R" : PRO_FORMA_COLUMNS[index - 1];
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          nonBalancingBucketMovementFormula(proFormaColumn, prior),
        );
      } else if (
        definition.semantic_role === "net_change_in_cash" &&
        explicitCashBuckets
      ) {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          cashReconciliationFormula(proFormaColumn),
        );
      } else if (definition.semantic_role === "rcf_draw") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${proFormaColumn}${waterfallRows.rcf_draw_waterfall}`,
        );
      } else if (definition.semantic_role === "rcf_repayment") {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=-${proFormaColumn}${waterfallRows.rcf_repayment_waterfall}`,
        );
      } else if (
        [
          "debt_issuance",
          "debt_repayment",
          "lease_principal",
        ].includes(definition.semantic_role)
      ) {
        // Plain A + B = C, overlay or no overlay. Where the row carries an
        // acquisition overlay the adjustment cell holds the acquisition debt
        // draw or its amortisation; where it does not, that cell is a
        // structural zero and the sum still reads as the company line. Writing
        // `=J96` on the untouched rows and `=J96+N96` on the overlaid ones made
        // the same line answer to two different shapes.
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${column}${definition.row}+${adjustmentColumn}${definition.row}`,
        );
      } else if (
        // A self-carry belongs to the STANDALONE block. Re-running it here made
        // the pro-forma block its own hold-flat chain (S = R, T = S, U = T),
        // anchored on the last actual and structurally incapable of ever
        // reaching the adjustment columns. Falling through to the default
        // `standalone + adjustment` puts the row back on the same architecture
        // as every other line.
        !isSelfCarry(definition, definition.calculation) &&
        // Same guard as the forecast writer. Without it the pro-forma columns
        // re-emit the historical calculation for rows whose dependency
        // direction reverses in the forecast, producing genuine circular pairs
        // (S39 = S64 while S64 = S39) that Excel resolves to zero.
        !(
          !periodRulesDeclared &&
          !definition.forecast_calculation &&
          ["broker", "hardcode", "zero", "uncalculated"].includes(
            definition.forecast_treatment,
          )
        ) &&
        (definition.row_type === "calculation" ||
          definition.row_type === "subtotal")
      ) {
        const formula = genericFormula(
          rowPlan,
          definition,
          proFormaColumn,
        );
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          formula ?? `=${column}${definition.row}+${adjustmentColumn}${definition.row}`,
        );
      } else {
        applyFormula(
          sheet,
          `${proFormaColumn}${definition.row}`,
          `=${column}${definition.row}+${adjustmentColumn}${definition.row}`,
        );
      }
    }
    if (structurallyEmptyHistory) {
      // The pro-forma reference column mirrors the last actual; a
      // structurally empty history mirrors as the same grey blank.
      sheet.getRange(`G${definition.row}:I${definition.row}`).format.fill =
        COLORS.grey;
      sheet.getRange(`R${definition.row}`).format.fill = COLORS.grey;
    } else {
      applyFormula(sheet, `R${definition.row}`, `=I${definition.row}`);
    }
  }

  // A HEADING WIDER THAN ITS OWN COLUMN IS CLIPPED IN EXCEL TOO.
  //
  // C, D and E are 10, 10 and 12 characters — 55.5, 55.5 and 66.6pt — and every
  // term-table heading is Calibri 8 bold and CENTRED, so it spills both ways
  // into cells that are always occupied on a heading row. `Nominal amount`
  // measures 56.2pt: wider than the whole of column D before a single point of
  // cell margin, so it clips under LibreOffice's 0.95pt margin and under
  // Excel's wider one. `Coupon / spread` measures 55.4pt, inside the bare
  // column by six hundredths of a point and outside both margins.
  //
  // These strings are COMPILED HERE, not sourced from the case, which is what
  // decides the remedy. Column B took the other treatment — widened from 39 to
  // 45 characters — because the strings it clipped were the case author's
  // instrument names and shortening one would have been editing a source fact
  // to fit a layout. Nothing of the kind applies to a heading this file writes:
  // widening D would push F and the whole period grid right on every case and
  // rewrite every rendered page to buy a word that carries no information the
  // column below it does not already carry. `MANUAL_ALL_IN` -> `ALL-IN` and
  // `COMMITMENT FEE` -> `UNDRAWN` were settled the same way.
  //
  // `Nominal amount` -> `Nominal`: 28.3pt, 46% clear of Excel's usable width.
  // The dropped word is the one the figures beneath it supply.
  //
  // `Coupon / spread` -> `Rate / spread`: 44.9pt, 14% clear. The slash has to
  // survive because the column genuinely holds two different quantities — a
  // coupon on a FIXED row and a spread over the benchmark on a FLOATING one —
  // and column C says which. `Coupon` alone would misname every floating row
  // and `Spread` alone every fixed one. `Coupon/spread` closed up fits by
  // 0.75pt, which is luck rather than headroom, and `Cpn`/`sprd` buy the same
  // room by abbreviating where a whole word is available.
  setValue(sheet, `B${rowPlan.debt_term_header_row}`, "Instrument / facility");
  setRow(sheet, `C${rowPlan.debt_term_header_row}:E${rowPlan.debt_term_header_row}`, [
    "Denom.",
    "Amount",
    "Maturity",
  ]);
  applyRowFill(sheet, rowPlan.debt_term_header_row, COLORS.subsection);
  styleFont(
    sheet,
    `B${rowPlan.debt_term_header_row}:U${rowPlan.debt_term_header_row}`,
    COLORS.black,
    { bold: true },
  );

  // FX on the face of the debt schedule. Each row is stated in
  // reporting-currency-per-native terms so a balance can translate itself with
  // a plain multiply against a visible cell, instead of every balance formula
  // carrying its own 'Forward Curves' round trip and, where the case quotes the
  // pair the other way round, an invisible 1/x.
  const reportingCurrency = modelCase.issuer.reporting_currency;
  const instrumentBalanceCurrency = (instrument) =>
    instrument?.balance_basis === "reporting_currency_carrying_value"
      ? reportingCurrency
      : instrument?.currency;
  const debtFxRows = rowPlan.debt_fx_rows ?? {};
  // No visible row means the row plan found the forecast rate FLAT. The rate is
  // then a single constant and the balances point straight at the one curve cell
  // that supplies it: the last reported period end for the actual column, and
  // the (identical) first forecast period end for all three forecast columns.
  // Because every forecast column resolves to the SAME cell, the roll-forward
  // below can drop its divide-back-to-native round trip entirely.
  const curveFxReference = (currency, column) => {
    const definition = curveRows.fx?.[currency];
    if (!definition) return "1";
    const position = [...HISTORICAL_COLUMNS, ...FORECAST_COLUMNS].indexOf(column);
    const periodIndex = position < 0 ? 2 : position < 3 ? position : 3;
    const source = `'Forward Curves'!${columnName(3 + periodIndex)}$${
      definition.period_end
    }`;
    return modelCase.fx?.[currency]?.quote === "reporting_per_native"
      ? source
      : `(1/${source})`;
  };
  // The pro-forma block restates the SAME periods as the standalone block, so
  // it translates at the same rates: R is the last actual, S/T/U are FY1..FY3.
  // Without this mapping the curve fallback saw an unrecognised column and
  // silently handed every pro-forma cell the last ACTUAL rate.
  const fxPeriodColumn = (column) => {
    if (column === "R") return "I";
    const proForma = PRO_FORMA_COLUMNS.indexOf(column);
    return proForma < 0 ? column : FORECAST_COLUMNS[proForma];
  };
  const fxCell = (currency, column) => {
    const row = debtFxRows[currency];
    if (row) return `${column}$${row}`;
    if (!currency || currency === reportingCurrency) return "1";
    return curveFxReference(currency, fxPeriodColumn(column));
  };
  // TRANSLATION IS NOT A CASH FLOW. Cash movement is compiled later from the
  // visible issuance, repayment and RCF event rows. FX is then the residual
  // needed to reconcile opening and closing gross debt after those cash events
  // and every separately declared non-cash movement. This direction keeps one
  // cash authority and avoids restating the instrument maturity machinery in a
  // second, much longer formula family.
  // Non-cash balance movements are stated on their own instrument rows. They
  // move debt but are never permitted to leak into the financing cash flow.
  // Translate each native-currency input at the period-end rate, exactly as the
  // corresponding balance roll-forward does.
  const otherNonCashExpression = (plans, column) => {
    const terms = plans.flatMap((plan) => {
        const instrument = instrumentById.get(plan.instrument_id);
        const rate = fxCell(instrument?.currency, column);
        return [plan.pik_row, plan.fair_value_row, plan.other_non_cash_row]
          .filter(Number.isInteger)
          .map((row) => {
            const cell = `${column}${row}`;
            return rate === "1" ? cell : `${cell}*${rate}`;
          });
      });
    return terms.length ? terms.join("+") : null;
  };
  for (const [currency, row] of Object.entries(debtFxRows)) {
    const quote = modelCase.fx?.[currency]?.quote;
    setValue(
      sheet,
      `B${row}`,
      `${currency} period-end FX (${reportingCurrency} per ${currency})`,
    );
    setLabelIndent(sheet, rowPlan, row, 1);
    sheet.getRange(`G${row}:U${row}`).format.numberFormat = FX_RATE;
    for (const [index, column] of [
      ...HISTORICAL_COLUMNS,
      ...FORECAST_COLUMNS,
    ].entries()) {
      const source = `'Forward Curves'!${columnName(3 + index)}$${
        curveRows.fx[currency].period_end
      }`;
      applyFormula(
        sheet,
        `${column}${row}`,
        quote === "reporting_per_native" ? `=${source}` : `=1/${source}`,
      );
    }
    applyFormula(sheet, `R${row}`, `=I${row}`);
    for (const [index, column] of PRO_FORMA_COLUMNS.entries()) {
      applyFormula(sheet, `${column}${row}`, `=${FORECAST_COLUMNS[index]}${row}`);
    }
  }

  const instrumentById = new Map(
    modelCase.instruments.map((item) => [item.instrument_id, item]),
  );
  const instrumentPlanById = new Map(
    rowPlan.instruments.map((plan) => [plan.instrument_id, plan]),
  );
  const linkedDebtCashFormula = (bucket, column) => {
    const cells = (bucket.linked_instrument_ids ?? []).map((instrumentId) => {
      const plan = instrumentPlanById.get(instrumentId);
      if (!plan) {
        throw new Error(
          `Cash bucket ${bucket.bucket_id} links instrument ${instrumentId}, but the row plan has no matching debt row.`,
        );
      }
      return `${column}${plan.debt_row}`;
    });
    return sumCellFormula(cells);
  };
  // Forecast cash repayments, in reporting currency, compiled from the same
  // per-instrument mechanics that write the visible debt roll-forward. The RCF
  // waterfall consumes these expressions directly. A balance delta is not a
  // cash-flow proxy: issuance, acquisition additions, FX and other non-cash
  // movements can all change the balance without being a mandatory repayment.
  // Mandatory repayment is a semantic REDUCER, not a hand-written list of
  // bonds. Each period collects the complete eligible opening/movement/closing
  // state by balance currency; the visible answer aggregates those pools once.
  // Adding, removing or reordering instruments therefore changes the reducer's
  // membership, never a manually maintained formula.
  const mandatoryRepaymentPools = Array.from({ length: 3 }, () => new Map());
  const instrumentTimingExpressions = (
    plan,
    instrument,
    index,
    movementColumn,
    openingNative,
  ) => {
    const priorPeriodColumn = index === 0 ? "I" : FORECAST_COLUMNS[index - 1];
    const periodStart = `(${priorPeriodColumn}$${rowPlan.period_row}+1)`;
    const periodEnd = `${FORECAST_COLUMNS[index]}$${rowPlan.period_row}`;
    const periodDays = `(${periodEnd}-${periodStart}+1)`;
    const maturityCell = `$E${plan.debt_row}`;
    const maturityActive =
      `IF($C$${c.debt_maturities_roll}=1,` +
      `IF(ISNUMBER(${maturityCell}),IF(${maturityCell}<=${periodEnd},1,0),0),0)`;
    const activeEnd = `IF(${maturityActive},MIN(${maturityCell},${periodEnd}),${periodEnd})`;
    const activeFraction = `MAX(0,${activeEnd}-${periodStart}+1)/${periodDays}`;
    const fallbackMovementFraction = `((${activeFraction})/2)`;
    const datedFraction = (row) => {
      if (!Number.isInteger(row)) return fallbackMovementFraction;
      const dateCell = `$${["C", "D", "E"][index]}${row}`;
      return `IF(ISNUMBER(${dateCell}),MAX(0,${activeEnd}-MAX(${periodStart},${dateCell})+1)/${periodDays},${fallbackMovementFraction})`;
    };
    const issuance = Number.isInteger(plan.issuance_row)
      ? `$${movementColumn}${plan.issuance_row}`
      : "0";
    const fairValue = Number.isInteger(plan.fair_value_row)
      ? `$${movementColumn}${plan.fair_value_row}`
      : "0";
    const otherNonCash = Number.isInteger(plan.other_non_cash_row)
      ? `$${movementColumn}${plan.other_non_cash_row}`
      : "0";
    const amortisation = Number.isInteger(plan.amortisation_row)
      ? `$${movementColumn}${plan.amortisation_row}`
      : "0";
    const availableBeforeAmortisation =
      `MAX(0,${openingNative}+${issuance}+${fairValue}+${otherNonCash})`;
    const cappedAmortisation =
      `MIN(${availableBeforeAmortisation},${amortisation})`;
    const weightedBase =
      `MAX(0,${openingNative}*(${activeFraction})+` +
      `${issuance}*(${datedFraction(plan.issuance_row)})+` +
      `(${fairValue}+${otherNonCash})*${fallbackMovementFraction}-` +
      `${cappedAmortisation}*(${datedFraction(plan.amortisation_row)}))`;
    return {
      activeFraction,
      cappedAmortisation,
      maturityActive,
      weightedBase,
    };
  };
  for (const group of rowPlan.debt_groups ?? []) {
    setValue(sheet, `B${group.header_row}`, group.label);
    applyRowFill(sheet, group.header_row, COLORS.subsection);
    styleFont(sheet, `B${group.header_row}:U${group.header_row}`, COLORS.black, {
      bold: true,
    });
    setValue(sheet, `B${group.subtotal_row}`, `Total ${group.label}`);
    // Total Bonds / Total Bank Debt / Total Other Debt close a run of
    // instruments and nothing else: component sums, rule and bold, no fill.
    totalRanks.set(group.subtotal_row, groupSubtotalRank());
    setPeriodNumberFormat(sheet, group.subtotal_row, AMOUNT);
  }
  for (const plan of rowPlan.instruments) {
    const instrument = instrumentById.get(plan.instrument_id);
    setValue(
      sheet,
      `B${plan.debt_row}`,
      instrumentDisplayLabel(instrument, modelCase.issuer.reporting_currency),
    );
    setValue(sheet, `C${plan.debt_row}`, instrument.currency);
    // Column C is always legal denomination.  Column D is deliberately called
    // Amount rather than Nominal: it may be native principal, a reporting-
    // currency carrying value, or committed facility capacity.  The cell note
    // states which basis applies so a foreign legal denomination can never make
    // a reporting-currency carrying value look like native principal.
    setValue(
      sheet,
      `D${plan.debt_row}`,
      isBalancingRcf(modelCase, instrument)
        ? Number(
            modelCase.rcf_policy?.capacity ?? instrument.facility_capacity ?? 0,
          )
        : Number(instrument.opening_balance),
    );
    const amountBasisNote = isBalancingRcf(modelCase, instrument)
      ? `Debt amount basis: committed facility capacity in ${instrument.currency}. Legal denomination: ${instrument.currency}.`
      : instrument.balance_basis === "reporting_currency_carrying_value"
        ? `Debt amount basis: opening carrying value in ${reportingCurrency}. Legal denomination: ${instrument.currency}. This amount is already translated and must not pass through FX again.`
        : `Debt amount basis: opening native principal in ${instrument.currency}. Legal denomination: ${instrument.currency}.`;
    addCommentOnce(
      workbook,
      sheet,
      `D${plan.debt_row}`,
      amountBasisNote,
    );
    setValue(
      sheet,
      `E${plan.debt_row}`,
      instrument.maturity_date ? new Date(instrument.maturity_date) : null,
    );
    sheet.getRange(`D${plan.debt_row}`).format.numberFormat = AMOUNT;
    sheet.getRange(`E${plan.debt_row}`).format.numberFormat = "dd-mmm-yy";
    styleInput(sheet, `C${plan.debt_row}:E${plan.debt_row}`);
    setPeriodNumberFormat(sheet, plan.debt_row, AMOUNT);
    for (let index = 0; index < 2; index += 1) {
      sheet.getRange(
        `${HISTORICAL_COLUMNS[index]}${plan.debt_row}`,
      ).format.fill = COLORS.grey;
    }
    applyFormula(
      sheet,
      `I${plan.debt_row}`,
      `=$D${plan.debt_row}*${fxCell(instrumentBalanceCurrency(instrument), "I")}`,
    );
    // R IS THE PRO-FORMA BLOCK'S LAST ACTUAL — IT MUST NOT BE BLANK.
    //
    // Every other row of the pro-forma block carries `R{row} = I{row}` so the
    // block opens on the same actual balance sheet the standalone block opens
    // on. The instrument balance rows were the one omission, and a blank cell
    // is not neutral inside AVERAGE: `-AVERAGE(R132,S132)*rate` silently
    // divided by ONE instead of two, striking pro-forma interest on the
    // closing balance alone. The subtotal rows below (`=SUM(R110..R132)`)
    // summed the same blanks to zero.
    applyFormula(sheet, `R${plan.debt_row}`, `=I${plan.debt_row}`);
    // AN INDENTED CHILD ROW DOES NOT RESTATE ITS PARENT'S NAME.
    //
    // These two labels were `${instrument.name} – issuance` and
    // `${instrument.name} – scheduled amortisation`: the instrument's full name,
    // already spelled out on the row DIRECTLY ABOVE, plus a suffix. On the
    // standard-maximal case that produced
    // `€1,131.25m term loan B due May-2030 (EURIBOR + 225bps) – scheduled
    // amortisation` — 287.99pt of text in 202.83pt of column, 42% over, and the
    // part that got cut was the suffix, the only part that was not already on
    // screen. Two more amortisation rows on that case clipped the same way.
    //
    // The restatement was never carrying information. `setLabelIndent(..., 1)`
    // puts the row one level in, immediately beneath its instrument and above
    // the next one, so "which instrument is this" is answered by position — the
    // same way every other indented child on this sheet answers it. What the
    // label has to say is what KIND of movement the row is, and now that is all
    // it says.
    //
    // This is not the fix for column B generally: the instrument names
    // themselves are the case author's text and are handled by the column
    // width. It is the fix for the part of column B that this file writes.
    if (plan.issuance_row) {
      setValue(sheet, `B${plan.issuance_row}`, "Issuance");
      setLabelIndent(sheet, rowPlan, plan.issuance_row, 1);
      setRow(
        sheet,
        `C${plan.issuance_row}:E${plan.issuance_row}`,
        (instrument.new_issuance_dates ?? [null, null, null]).map((value) =>
          value ? new Date(value) : null,
        ),
      );
      sheet.getRange(`C${plan.issuance_row}:E${plan.issuance_row}`).format.numberFormat =
        "dd-mmm-yy";
      setRow(
        sheet,
        `J${plan.issuance_row}:L${plan.issuance_row}`,
        instrument.new_issuance,
      );
      styleInput(sheet, `C${plan.issuance_row}:E${plan.issuance_row}`);
      styleInput(sheet, `J${plan.issuance_row}:L${plan.issuance_row}`);
      for (let index = 0; index < 3; index += 1) {
        const standaloneColumn = FORECAST_COLUMNS[index];
        const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
        const proFormaColumn = PRO_FORMA_COLUMNS[index];
        applyFormula(sheet, `${adjustmentColumn}${plan.issuance_row}`, "=0");
        applyFormula(
          sheet,
          `${proFormaColumn}${plan.issuance_row}`,
          `=${standaloneColumn}${plan.issuance_row}+${adjustmentColumn}${plan.issuance_row}`,
        );
      }
    }
    if (plan.amortisation_row) {
      setValue(sheet, `B${plan.amortisation_row}`, "Scheduled amortisation");
      setLabelIndent(sheet, rowPlan, plan.amortisation_row, 1);
      setRow(
        sheet,
        `C${plan.amortisation_row}:E${plan.amortisation_row}`,
        (
          instrument.scheduled_amortisation_dates ?? [null, null, null]
        ).map((value) => (value ? new Date(value) : null)),
      );
      sheet.getRange(
        `C${plan.amortisation_row}:E${plan.amortisation_row}`,
      ).format.numberFormat = "dd-mmm-yy";
      setRow(
        sheet,
        `J${plan.amortisation_row}:L${plan.amortisation_row}`,
        instrument.scheduled_amortisation,
      );
      styleInput(
        sheet,
        `C${plan.amortisation_row}:E${plan.amortisation_row}`,
      );
      styleInput(sheet, `J${plan.amortisation_row}:L${plan.amortisation_row}`);
    }
    if (plan.pik_row) {
      setValue(sheet, `B${plan.pik_row}`, "PIK / capitalised interest");
      setLabelIndent(sheet, rowPlan, plan.pik_row, 1);
      setPeriodNumberFormat(sheet, plan.pik_row, AMOUNT);
    }
    if (plan.fair_value_row) {
      setValue(sheet, `B${plan.fair_value_row}`, "Fair-value movement");
      setLabelIndent(sheet, rowPlan, plan.fair_value_row, 1);
      setRow(
        sheet,
        `J${plan.fair_value_row}:L${plan.fair_value_row}`,
        instrument.non_cash_movement_components?.fair_value ?? [0, 0, 0],
      );
      styleInput(sheet, `J${plan.fair_value_row}:L${plan.fair_value_row}`);
    }
    if (plan.other_non_cash_row) {
      setValue(sheet, `B${plan.other_non_cash_row}`, "Other non-cash movement");
      setLabelIndent(sheet, rowPlan, plan.other_non_cash_row, 1);
      setRow(
        sheet,
        `J${plan.other_non_cash_row}:L${plan.other_non_cash_row}`,
        instrument.non_cash_movement_components?.other ??
          instrument.other_non_cash_movement ??
          [0, 0, 0],
      );
      styleInput(
        sheet,
        `J${plan.other_non_cash_row}:L${plan.other_non_cash_row}`,
      );
    }

    if (isBalancingRcf(modelCase, instrument)) {
      const foreignRcf =
        instrumentBalanceCurrency(instrument) !== reportingCurrency;
      setValue(
        sheet,
        `I${plan.debt_row}`,
        foreignRcf
          ? Number(modelCase.rcf_policy.opening_draw) *
              Number(
                (() => {
                  const pair = modelCase.fx?.[instrument.currency];
                  const raw = Number(pair?.period_end_rates?.[2] ?? 0);
                  if (!(raw > 0)) {
                    throw new Error(
                      `Missing positive opening period-end FX for foreign RCF ${instrument.instrument_id}.`,
                    );
                  }
                  return pair.quote === "reporting_per_native" ? raw : 1 / raw;
                })(),
              )
          : Number(modelCase.rcf_policy.opening_draw),
      );
      styleInput(sheet, `I${plan.debt_row}`);
      for (let index = 0; index < 3; index += 1) {
        const column = FORECAST_COLUMNS[index];
        const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
        const proFormaColumn = PRO_FORMA_COLUMNS[index];
        applyFormula(
          sheet,
          `${column}${plan.debt_row}`,
          `=${column}${waterfallRows.ending_rcf}`,
        );
        applyFormula(
          sheet,
          `${proFormaColumn}${plan.debt_row}`,
          `=${proFormaColumn}${waterfallRows.ending_rcf}`,
        );
        // The revolver's drawn balance is solved by the sweep in every block,
        // so the adjustment links to the ADJUSTMENT block's own closing
        // revolver exactly as the standalone and pro-forma cells link to
        // theirs. Same reference, one block left — not a difference of the
        // other two.
        applyFormula(
          sheet,
          `${adjustmentColumn}${plan.debt_row}`,
          `=${adjustmentColumn}${waterfallRows.ending_rcf}`,
        );
      }
      continue;
    }

    // The balance roll-forward is emitted ON THE FACE of the debt schedule.
    // There is no hidden scratch row: the native-currency opening balance is
    // either the visible nominal amount in column D (first forecast year) or
    // the prior visible closing balance translated back at that year's closing
    // rate. Everything the reader needs is on screen.
    for (let index = 0; index < 3; index += 1) {
      const column = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      // Where a visible FX row exists both rates point at it rather than across
      // to 'Forward Curves', and the prior-year rate is the cell one column left
      // of this one — exactly how a reader would find it. Where the forecast
      // rate never moves there is no row, and both rates resolve to the same
      // curve cell.
      const balanceCurrency = instrumentBalanceCurrency(instrument);
      const endFx = fxCell(balanceCurrency, column);
      const averageFx = fxFormula(
        modelCase,
        curveRows,
        balanceCurrency,
        index + 3,
        "average",
      );
      const priorEndFx =
        index === 0
          ? fxFormula(
              modelCase,
              curveRows,
              balanceCurrency,
              2,
              "period_end",
            )
          : fxCell(balanceCurrency, FORECAST_COLUMNS[index - 1]);
      const priorClosing = `$${FORECAST_COLUMNS[index - 1] ?? "I"}${plan.debt_row}`;
      const opening =
        index === 0
          ? `$D${plan.debt_row}`
          : priorEndFx === "1"
            ? priorClosing
            : `(${priorClosing}/${priorEndFx})`;
      const issuance = plan.issuance_row ? `$${column}${plan.issuance_row}` : "0";
      const fairValue = plan.fair_value_row ? `$${column}${plan.fair_value_row}` : "0";
      const otherNonCash = plan.other_non_cash_row
        ? `$${column}${plan.other_non_cash_row}`
        : "0";
      const amortisation = plan.amortisation_row
        ? `$${column}${plan.amortisation_row}`
        : "0";
      const openingMovementTerms = [
        opening,
        issuance,
        fairValue,
        otherNonCash,
      ].filter((term) => term !== "0");
      const openingWithMovements =
        openingMovementTerms.length === 1
          ? openingMovementTerms[0]
          : openingMovementTerms.join("+");
      const availableBeforeAmortisation = `MAX(0,${openingWithMovements})`;
      const cappedAmortisation = plan.amortisation_row
        ? `MIN(${availableBeforeAmortisation},${amortisation})`
        : "0";
      const baseEndingBeforePik = plan.amortisation_row
        ? `MAX(0,${openingWithMovements}-${cappedAmortisation})`
        : availableBeforeAmortisation;
      const matures = instrument.maturity_date
        ? `IF($C$${c.debt_maturities_roll}=1,` +
          `IF($E${plan.debt_row}<=${column}$${rowPlan.period_row},1,0),0)`
        : "0";
      const pikRateRow = rowPlan.pik_rate_rows?.[instrument.instrument_id];
      const pikRate = pikRateRow ? `$${column}$${pikRateRow}` : "0";
      const timing = instrumentTimingExpressions(
        plan,
        instrument,
        index,
        column,
        opening,
      );
      const pikAccretion = plan.pik_row
        ? `IF($C$${c.circularity}=0,0,IF(1-${pikRate}*(${timing.activeFraction})/2<=0,0,` +
          `(${timing.weightedBase})*${pikRate}/(1-${pikRate}*(${timing.activeFraction})/2)))`
        : "0";
      if (plan.pik_row) {
        applyFormula(sheet, `${column}${plan.pik_row}`, `=${pikAccretion}`);
        applyFormula(sheet, `${adjustmentColumn}${plan.pik_row}`, "=0");
        applyFormula(
          sheet,
          `${proFormaColumn}${plan.pik_row}`,
          `=${column}${plan.pik_row}+${adjustmentColumn}${plan.pik_row}`,
        );
      }
      const preMaturity = plan.pik_row
        ? `MAX(0,${baseEndingBeforePik}+$${column}${plan.pik_row})`
        : baseEndingBeforePik;
      // Repayment is read back from the complete visible roll-forward identity
      // rather than rebuilding the maturity test a second time.  This is not a
      // naked balance-delta proxy: issuance, fair-value movement, other
      // non-cash movement, PIK and FX are all explicitly restored before the
      // closing balance is deducted.  Debt balance, financing cash flow and
      // the repayment comment therefore consume one economic mechanism.
      const closingNative =
        endFx === "1"
          ? `$${column}${plan.debt_row}`
          : `($${column}${plan.debt_row}/${endFx})`;
      const simpleBullet =
        !plan.issuance_row &&
        !plan.amortisation_row &&
        !plan.pik_row &&
        !plan.fair_value_row &&
        !plan.other_non_cash_row;
      if (plan.has_mandatory_repayment) {
        const poolKey = balanceCurrency;
        const pool = mandatoryRepaymentPools[index].get(poolKey) ?? {
          currency: poolKey,
          averageFx,
          openingAndMovementTerms: [],
          closingTerms: [],
        };
        pool.openingAndMovementTerms.push(
          opening,
          ...(issuance !== "0" ? [issuance] : []),
          ...(fairValue !== "0" ? [fairValue] : []),
          ...(otherNonCash !== "0" ? [otherNonCash] : []),
          ...(plan.pik_row ? [`$${column}${plan.pik_row}`] : []),
        );
        pool.closingTerms.push(closingNative);
        mandatoryRepaymentPools[index].set(poolKey, pool);
      }
      applyFormula(
        sheet,
        `${column}${plan.debt_row}`,
        simpleBullet
          ? `=${availableBeforeAmortisation}*IF(${matures},0,1)` +
            (endFx === "1" ? "" : `*${endFx}`)
          : `=${preMaturity}*IF(${matures},0,1)` +
            (endFx === "1" ? "" : `*${endFx}`),
      );
      // AN INSTRUMENT THE TRANSACTION DOES NOT TOUCH IS ZERO IN THE ADJUSTMENT
      // COLUMN, AND SAYS SO. The acquisition draws its own tranche, which has
      // its own row in the acquisition block below; it does not add to, repay
      // or reprice a bond the issuer already had outstanding. So the adjustment
      // is a literal zero and the pro-forma balance is standalone plus that
      // zero — A + B = C on the face of the schedule.
      //
      // Deriving the adjustment as `pro forma - standalone` off two separately
      // written roll-forwards made this a coincidence rather than a fact: any
      // difference between the two — a rate cell picked up from the wrong
      // block, an opening balance read from R instead of I — surfaced as an
      // "acquisition adjustment" on an instrument with no acquisition exposure.
      applyFormula(sheet, `${adjustmentColumn}${plan.debt_row}`, "=0");
      applyFormula(
        sheet,
        `${proFormaColumn}${plan.debt_row}`,
        `=${column}${plan.debt_row}+${adjustmentColumn}${plan.debt_row}`,
      );
    }
  }

  for (const group of rowPlan.debt_groups ?? []) {
    const memberPlans = group.instrument_ids
      .map((instrumentId) =>
        rowPlan.instruments.find((plan) => plan.instrument_id === instrumentId),
      )
      .filter(Boolean);
    for (const column of [
      ...HISTORICAL_COLUMNS,
      ...FORECAST_COLUMNS,
      ...ADJUSTMENT_COLUMNS,
      "R",
      ...PRO_FORMA_COLUMNS,
    ]) {
      const cells = memberPlans.map((plan) => `${column}${plan.debt_row}`);
      applyFormula(
        sheet,
        `${column}${group.subtotal_row}`,
        sumCellFormula(cells),
      );
    }
  }

  // The block is split by BASIS. The model block is the standardised
  // calculation and is always present; it states net debt on both lease
  // definitions and divides both by a denominator on the face. The company
  // block is the issuer's own definition, and it only exists when the case
  // supplies at least one named reconciling item that is genuinely non-zero.
  //
  // Nothing is carried in a label suffix any more. The old design named the
  // company basis by appending "— company reporting basis" to whichever model
  // row happened to match, which meant the answer to "is this model or company"
  // lived in the end of a row label, and when the two bases differed the model
  // block's own multiple silently switched to the company numerator — putting
  // it out of step with the solver, which only ever measures the model basis.
  const bridgeComponents = rowPlan.reported_net_debt_bridge ?? [];
  const reportedNetDebtStatus =
    rowPlan.reported_net_debt_basis_status ?? "not_disclosed";
  const reportedBridgeVisible =
    reportedNetDebtStatus === "reconciled_difference" &&
    bridgeComponents.length > 0;
  const bridgeComponentRows = bridgeComponents.map(
    (_, index) => debtRows[`reported_net_debt_adjustment_${index}`],
  );
  const leasesInNetDebt =
    modelCase.lease_policy.include_in_net_debt &&
    modelCase.lease_policy.mode !== "exclude";
  const leasesInLeverage =
    modelCase.lease_policy.include_in_leverage &&
    modelCase.lease_policy.mode !== "exclude";
  const netDebtLeaseBasisRow = (includeLeases) =>
    includeLeases && Number.isInteger(debtRows.net_debt_including_leases)
      ? debtRows.net_debt_including_leases
      : debtRows.net_debt_excluding_leases;
  // The model row the company block starts from, and the model row the model
  // block's headline multiple divides. Both are MODEL rows: the independent
  // solver measures leverage on the include_in_leverage basis and knows nothing
  // about reported adjustments, so the visible model ratio must key off exactly
  // that row for the cache and the formula to agree.
  const companyNetDebtRow = netDebtLeaseBasisRow(leasesInNetDebt);
  const leverageNetDebtRow = netDebtLeaseBasisRow(leasesInLeverage);
  const leaseBasisLabel = (row) =>
    row === debtRows.net_debt_including_leases
      ? "Net debt (incl. leases)"
      : "Net debt (excl. leases)";
  const netDebtExcludingLabel = "Net debt (excl. leases)";
  const netDebtIncludingLabel = "Net debt (incl. leases)";
  const leverageNetDebtLabel = leaseBasisLabel(leverageNetDebtRow);
  // The forecast lease balance is the output of a policy choice, and the choice
  // has to be readable without opening the formula bar. A model that pays lease
  // principal every year while the liability stands still is only defensible if
  // the replacement-additions assumption is stated on the face; a model that
  // amortises should say that it assumes no new leases. Either way the label
  // carries the assumption.
  const leaseAdditionsSeries = asSeries3(modelCase.lease_policy.additions, 0);
  const leaseInterestBasis = resolvedLeaseInterestBasis(modelCase);
  const leaseProjection = leaseForecast(modelCase);
  const leaseAssumesAdditions =
    modelCase.lease_policy.mode === "flat_replacement" ||
    leaseAdditionsSeries.some((value) => Number(value) !== 0);
  const leaseLiabilityLabel =
    modelCase.lease_policy.mode === "exclude"
      ? "Lease liabilities"
      : modelCase.lease_policy.mode === "sourced_balance"
        ? "Lease liabilities — sourced forecast balances"
      : leaseAssumesAdditions
        ? modelCase.lease_policy.mode === "flat_replacement"
          ? "Lease liabilities — assumes new leases replace principal repaid"
          : "Lease liabilities — after assumed new lease additions"
        : "Lease liabilities — amortising, no new leases assumed";
  const debtLabels = {
    acquisition_debt_header: "Acquisition debt",
    acquisition_debt: "Acquisition term debt",
    total_acquisition_debt: "Total acquisition debt",
    gross_debt_excluding_leases: "Gross debt (excl. leases)",
    lease_header: "Leases",
    lease_liability: leaseLiabilityLabel,
    lease_principal_assumption: "Lease principal repayment assumption",
    lease_additions_assumption: "New lease additions assumption",
    lease_interest_bearing_liability:
      "Interest-bearing lease liabilities",
    total_lease_liabilities: "Total lease liabilities",
    gross_debt_including_leases: "Gross debt (incl. leases)",
    cash_bucket_header: "Cash reconciliation",
    reported_cash: "Reported cash",
    liquidity_cash: "Liquidity-eligible cash",
    interest_bearing_cash: "Interest-bearing eligible cash",
    cash_for_net_debt: explicitCashBuckets
      ? "Less: cash eligible for net debt"
      : "Less: cash and cash equivalents",
    net_debt_excluding_leases: netDebtExcludingLabel,
    net_debt_including_leases: netDebtIncludingLabel,
    // One header carries the basis for the whole block. When there is no
    // bridge to draw, it also carries the answer to "so what does the company
    // report, then?" — one row, instead of a company block whose every line
    // would be a zero or a copy.
    model_basis_header:
      reportedNetDebtStatus === "proven_same"
        ? "Net debt and leverage — model basis (proven equal to company basis)"
        : reportedBridgeVisible
          ? "Net debt and leverage — model basis (standardised)"
          : reportedNetDebtStatus === "reported_unreconciled"
            ? "Net debt and leverage — model basis (company basis not reconciled)"
            : "Net debt and leverage — model basis (company basis not disclosed)",
    total_change_in_debt: "Total change in debt — cash movement",
    debt_fx_translation: "(+/-) FX translation on debt (non-cash)",
    // NAMED AS A RECONCILIATION, not as a second model. The company block does
    // not re-derive anything: it starts from the model's own answer, names what
    // the issuer does to it, and lands on the published figure. Saying so in the
    // header is also how the DEBT DYNAMICS question is answered on the face of
    // the model — see the note above `panelBlocks` in the formatting pass for
    // why the movement lines are NOT duplicated on a company basis.
    company_reported_header:
      "Net debt and leverage — company reported (reconciled from model basis)",
    net_debt_model_basis_restated: `${leaseBasisLabel(companyNetDebtRow)} — model basis`,
    net_debt_company_reported: "Net debt (company reported)",
    // Restated, not re-derived: the multiple beneath it divides two rows the
    // reader can see, exactly as the model block's multiples do.
    company_reported_adjusted_ebitda: "Adjusted EBITDA (as above)",
    net_debt_company_reported_to_adjusted_ebitda:
      "Net debt (company reported) / Adjusted EBITDA",
    leverage_adjusted_ebitda: "Adjusted EBITDA",
    net_debt_excluding_leases_to_adjusted_ebitda:
      "Net debt (excl. leases) / Adjusted EBITDA",
    net_debt_to_adjusted_ebitda: `${leverageNetDebtLabel} / Adjusted EBITDA`,
    leverage_net_interest: "Net interest expense",
    adjusted_ebitda_to_net_interest: "Adjusted EBITDA / net interest expense",
    mandatory_debt_repayments: "Mandatory debt repayments",
    ...Object.fromEntries(
      bridgeComponents.map((component, index) => [
        `reported_net_debt_adjustment_${index}`,
        `(+/-) ${component.label}`,
      ]),
    ),
    liquidity_header: "Liquidity",
    undrawn_rcf: "Undrawn RCF",
    drawn_commercial_paper: "Less: drawn commercial paper",
    year_end_cash: explicitCashBuckets
      ? "Liquidity-eligible cash"
      : "Year-end cash",
    total_liquidity: "Total liquidity",
    ...Object.fromEntries(
      cashBucketPlans.map((bucket) => [
        `cash_bucket.${bucket.bucket_id}`,
        bucket.label,
      ]),
    ),
  };
  const debtSubtotalIds = new Set([
    "total_acquisition_debt",
    "gross_debt_excluding_leases",
    "total_lease_liabilities",
    "gross_debt_including_leases",
    "reported_cash",
    "net_debt_excluding_leases",
    "net_debt_including_leases",
    "net_debt_company_reported",
    "mandatory_debt_repayments",
    "total_change_in_debt",
    "total_liquidity",
  ]);
  const debtIndentedIds = new Set([
    "acquisition_debt",
    "lease_liability",
    "lease_principal_assumption",
    "lease_additions_assumption",
    // The translation line is a memo beneath the cash movement it explains,
    // not a second subtotal competing with it.
    "debt_fx_translation",
    "cash_for_net_debt",
    "liquidity_cash",
    "interest_bearing_cash",
    ...cashBucketPlans.map(
      (bucket) => `cash_bucket.${bucket.bucket_id}`,
    ),
    // The two denominator rows are indented under the leverage header: they are
    // memos that feed the ratio beneath them, not part of the debt build-up.
    "leverage_adjusted_ebitda",
    "leverage_net_interest",
    // The company block's restated numerator and denominator are memos too:
    // they carry no new arithmetic, they put the two figures the reported
    // multiple divides where the reader can see them.
    "net_debt_model_basis_restated",
    "company_reported_adjusted_ebitda",
    "undrawn_rcf",
    "drawn_commercial_paper",
    "year_end_cash",
    // Each named reconciling item sits under the model figure it adjusts.
    ...bridgeComponents.map((_, index) => `reported_net_debt_adjustment_${index}`),
  ]);
  const debtRatioIds = new Set([
    "net_debt_excluding_leases_to_adjusted_ebitda",
    "net_debt_to_adjusted_ebitda",
    "adjusted_ebitda_to_net_interest",
    "net_debt_company_reported_to_adjusted_ebitda",
  ]);
  for (const [id, row] of Object.entries(debtRows)) {
    setValue(sheet, `B${row}`, debtLabels[id] ?? id);
    const header = id.endsWith("_header");
    if (header) {
      applyRowFill(sheet, row, COLORS.subsection);
      styleFont(sheet, `B${row}:U${row}`, COLORS.black, { bold: true });
    }
    // Rank, from the row's own id WITHIN THE DEBT SCHEDULE — component sum,
    // block subtotal or answer. The leverage multiples are ANSWERS even though
    // they are not in `debtSubtotalIds`: they are what the reader came for.
    const rank = header
      ? null
      : totalRank(id, debtSubtotalIds.has(id), RANK_SECTION.DEBT_SCHEDULE);
    if (rank) totalRanks.set(row, rank);
    if (debtIndentedIds.has(id)) {
      setLabelIndent(sheet, rowPlan, row, 1);
    }
    // Same treatment as the margins on the income statement: a leverage or
    // coverage multiple is a reading of the two rows above it, and italic says
    // so without competing with the subtotals. An answer is exempt — it carries
    // the rank treatment instead.
    if (debtRatioIds.has(id) && rank !== TOTAL_RANK.ANSWER) {
      styleFont(sheet, `B${row}:U${row}`, COLORS.black, { italic: true });
    }
    setPeriodNumberFormat(
      sheet,
      row,
      debtRatioIds.has(id) ? MULTIPLE : AMOUNT,
    );
    if (!id.endsWith("_header")) {
      applyFormula(sheet, `R${row}`, `=I${row}`);
    }
  }
  collectHeadlines(RANK_SECTION.DEBT_SCHEDULE, debtRows);
  for (const bucket of cashBucketPlans) {
    setValue(sheet, `C${bucket.balance_row}`, bucket.forecast_treatment);
    setValue(
      sheet,
      `D${bucket.balance_row}`,
      bucket.net_debt_eligible_percentage,
    );
    setValue(
      sheet,
      `E${bucket.balance_row}`,
      bucket.interest_eligible_percentage,
    );
    styleInput(sheet, `C${bucket.balance_row}:E${bucket.balance_row}`);
    sheet.getRange(`D${bucket.balance_row}:E${bucket.balance_row}`).format.numberFormat =
      PERCENT;
  }
  const historicalGross =
    modelCase.historical_supplement?.prior_gross_debt_excluding_leases ?? [
      null,
      null,
    ];
  setRow(
    sheet,
    `G${debtRows.gross_debt_excluding_leases}:H${debtRows.gross_debt_excluding_leases}`,
    historicalGross,
  );
  styleInput(
    sheet,
    `G${debtRows.gross_debt_excluding_leases}:H${debtRows.gross_debt_excluding_leases}`,
  );
  // Lease liabilities are stated across ALL THREE actual columns from one
  // series, so each historical year carries its own reported balance. The old
  // split — two years from historical_supplement, the third from a separate
  // opening_liability scalar — is what let a case fill G and H with the same
  // number and leave the earliest actual holding the following year's figure.
  const leaseHistoricalSeries = leaseHistoricalLiabilities(modelCase);
  const historicalLease = leaseHistoricalSeries ?? [
    ...(modelCase.historical_supplement?.prior_lease_liabilities ?? [
      null,
      null,
    ]),
    leaseOpeningLiability(modelCase),
  ];
  setRow(
    sheet,
    `G${debtRows.lease_liability}:I${debtRows.lease_liability}`,
    historicalLease.slice(0, 3),
  );
  styleInput(
    sheet,
    `G${debtRows.lease_liability}:I${debtRows.lease_liability}`,
  );
  if (Number.isInteger(debtRows.lease_interest_bearing_liability)) {
    setRow(
      sheet,
      `G${debtRows.lease_interest_bearing_liability}:I${debtRows.lease_interest_bearing_liability}`,
      modelCase.lease_policy.historical_interest_bearing_liabilities,
    );
    styleInput(
      sheet,
      `G${debtRows.lease_interest_bearing_liability}:I${debtRows.lease_interest_bearing_liability}`,
    );
  }
  const nonRcfPlans = rowPlan.instruments.filter(
    (plan) =>
      !isBalancingRcf(modelCase, instrumentById.get(plan.instrument_id)),
  );
  const rcfPlan = rowPlan.instruments.find(
    (plan) =>
      isBalancingRcf(modelCase, instrumentById.get(plan.instrument_id)),
  );
  const rcfInstrument = balancingRcfInstrument(modelCase);
  const foreignRcf = Boolean(
    instrumentBalanceCurrency(rcfInstrument) !== reportingCurrency,
  );
  const rcfAverageFx = (index) =>
    foreignRcf
      ? fxFormula(
          modelCase,
          curveRows,
          rcfInstrument.currency,
          index + 3,
          "average",
        )
      : "1";
  const rcfOpeningFx = (index, blockColumn) => {
    if (!foreignRcf) return "1";
    if (index === 0) return fxCell(rcfInstrument.currency, "I");
    const priorColumn =
      blockColumn === PRO_FORMA_COLUMNS[index]
        ? PRO_FORMA_COLUMNS[index - 1]
        : FORECAST_COLUMNS[index - 1];
    return fxCell(rcfInstrument.currency, priorColumn);
  };
  const rcfEndingFx = (blockColumn) =>
    foreignRcf ? fxCell(rcfInstrument.currency, blockColumn) : "1";
  const commercialPaperPlans = rowPlan.instruments.filter(
    (plan) =>
      instrumentById.get(plan.instrument_id)?.class === "commercial_paper",
  );
  // Headroom is capacity less drawn, read straight off the facility's own row
  // in the schedule above. There is no undrawn memo row to link to any more,
  // and the reader can check the subtraction against the two figures on the
  // face of the model rather than against a third line that restated them.
  const undrawnRcfFormula = (blockColumn) =>
    rcfPlan
      ? foreignRcf
        ? `=MAX(0,$D$${rcfPlan.debt_row}-${blockColumn}${rcfPlan.debt_row}/${rcfEndingFx(blockColumn)})*${rcfEndingFx(blockColumn)}`
        : `=MAX(0,$D$${rcfPlan.debt_row}-${blockColumn}${rcfPlan.debt_row})`
      : "=0";
  // The facility's committed size is stated ONCE, as the nominal amount on its
  // own row in the debt schedule. Everything that caps a drawdown or sizes a
  // commitment fee reads it from there.
  const rcfCapacityRef = rcfPlan
    ? `$D$${rcfPlan.debt_row}`
    : String(Number(modelCase.rcf_policy?.capacity ?? 0));
  // Gross debt is the same expression in every column: the drawn instrument
  // rows plus the acquisition block. The RCF undrawn memo row is deliberately
  // absent, and so is the old pro-forma-only RCF patch — the pro-forma
  // instrument cells already carry the acquisition-case RCF balance.
  for (const column of [
    "I",
    ...FORECAST_COLUMNS,
    // The ADJUSTMENT column foots exactly the same instrument rows. Gross debt
    // is a total, and a total sums its own block — the adjustment to gross debt
    // is the sum of the adjustments to the instruments beneath it, which is
    // what puts the acquisition tranche into the adjustment column and nothing
    // else with it.
    ...ADJUSTMENT_COLUMNS,
    ...PRO_FORMA_COLUMNS,
  ]) {
    const instrumentCells = nonRcfPlans
      .filter(
        (plan) =>
          instrumentById.get(plan.instrument_id).include_in_gross_debt !== false,
      )
      .map((plan) => `${column}${plan.debt_row}`);
    if (rcfPlan) instrumentCells.push(`${column}${rcfPlan.debt_row}`);
    instrumentCells.push(`${column}${debtRows.total_acquisition_debt}`);
    applyFormula(
      sheet,
      `${column}${debtRows.gross_debt_excluding_leases}`,
      sumCellFormula(instrumentCells),
    );
  }
  // I (the last actual) was written above with G and H, from the same series,
  // so the forecast's opening balance is the same cell the reader sees.
  const statementEndingCashRow = statementByRole.get("ending_cash").row;
  if (explicitCashBuckets) {
    for (const bucket of cashBucketPlans) {
      setRow(
        sheet,
        `G${bucket.balance_row}:I${bucket.balance_row}`,
        bucket.historical_year_end,
      );
      styleInput(sheet, `G${bucket.balance_row}:I${bucket.balance_row}`);
    }
    for (const column of HISTORICAL_COLUMNS) {
      const index = HISTORICAL_COLUMNS.indexOf(column);
      const reportedCells = cashBucketPlans.map(
        (bucket) => `${column}${bucket.balance_row}`,
      );
      const liquidityCells = cashBucketPlans
        .filter((bucket) => bucket.available_for_liquidity)
        .map((bucket) => `${column}${bucket.balance_row}`);
      const interestEligibleTerms = cashBucketPlans.map(
        (bucket) =>
          `${column}${bucket.balance_row}*$E$${bucket.balance_row}`,
      );
      const netDebtEligibleTerms = cashBucketPlans.map(
        (bucket) =>
          `${column}${bucket.balance_row}*$D$${bucket.balance_row}`,
      );
      applyFormula(
        sheet,
        `${column}${debtRows.reported_cash}`,
        sumCellFormula(reportedCells),
      );
      applyFormula(
        sheet,
        `${column}${debtRows.liquidity_cash}`,
        sumCellFormula(liquidityCells),
      );
      applyFormula(
        sheet,
        `${column}${debtRows.interest_bearing_cash}`,
        interestEligibleTerms.length
          ? `=${interestEligibleTerms.join("+")}`
          : "=0",
      );
      applyFormula(
        sheet,
        `${column}${debtRows.cash_for_net_debt}`,
        netDebtEligibleTerms.length
          ? `=-(${netDebtEligibleTerms.join("+")})`
          : "=0",
      );
      void index;
    }
  } else {
    // Historical cash is stated once, in the company cash-flow statement.
    // Net debt reads that visible source row and the visible eligibility
    // assumption exactly as the forecast does.  The old implementation
    // multiplied both case-file values in JavaScript and wrote the three
    // derived answers as blue hardcodes, which duplicated the source and hid
    // the lineage (for AstraZeneca this surfaced as a literal `=-5711`).
    for (const column of HISTORICAL_COLUMNS) {
      applyFormula(
        sheet,
        `${column}${debtRows.cash_for_net_debt}`,
        `=-${column}${statementEndingCashRow}*$D$${interestRows.interest_income_schedule}`,
      );
    }
  }
  // Net debt is stated on BOTH lease definitions, each off the gross-debt row
  // above that carries the same definition, so the reader can see the two
  // numbers a credit committee will ask for without a second schedule.
  //
  // Every column of the net-debt build-up, in one place, so the historic,
  // forecast and pro-forma passes cannot drift apart.
  const netDebtBlockFormulas = (col) => [
    [
      debtRows.net_debt_excluding_leases,
      `=${col}${debtRows.gross_debt_excluding_leases}+${col}${debtRows.cash_for_net_debt}`,
    ],
    ...(Number.isInteger(debtRows.net_debt_including_leases)
      ? [
          [
            debtRows.net_debt_including_leases,
            `=${col}${debtRows.gross_debt_including_leases}+${col}${debtRows.cash_for_net_debt}`,
          ],
        ]
      : []),
  ];
  const cashSummaryFormula = (id, col) => {
    if (!explicitCashBuckets) return null;
    const bucketCells = cashBucketPlans.map(
      (bucket) => `${col}${bucket.balance_row}`,
    );
    if (id === "reported_cash") {
      return sumCellFormula(bucketCells);
    }
    if (id === "liquidity_cash") {
      const cells = cashBucketPlans
        .filter((bucket) => bucket.available_for_liquidity)
        .map((bucket) => `${col}${bucket.balance_row}`);
      return sumCellFormula(cells);
    }
    if (id === "interest_bearing_cash") {
      const terms = cashBucketPlans.map(
        (bucket) =>
          `${col}${bucket.balance_row}*$E$${bucket.balance_row}`,
      );
      return terms.length ? `=${terms.join("+")}` : "=0";
    }
    if (id === "cash_for_net_debt") {
      const terms = cashBucketPlans.map(
        (bucket) =>
          `${col}${bucket.balance_row}*$D$${bucket.balance_row}`,
      );
      return terms.length ? `=-(${terms.join("+")})` : "=0";
    }
    return null;
  };
  // The company-reported block, in the same one-place-per-column shape. It
  // restates the model figure, adds the named items beneath it and lands on the
  // published number — so the bridge is three visible rows of arithmetic rather
  // than a subtraction the reader has to perform. The multiple divides the two
  // rows directly above it, exactly as the model block's multiples do.
  const companyReportedBlockFormulas = (col) =>
    reportedBridgeVisible
      ? [
          [
            debtRows.net_debt_model_basis_restated,
            `=${col}${companyNetDebtRow}`,
          ],
          [
            debtRows.net_debt_company_reported,
            `=${col}${debtRows.net_debt_model_basis_restated}+` +
              bridgeComponentRows.map((row) => `${col}${row}`).join("+"),
          ],
          [
            debtRows.company_reported_adjusted_ebitda,
            `=${col}${debtRows.leverage_adjusted_ebitda}`,
          ],
          [
            debtRows.net_debt_company_reported_to_adjusted_ebitda,
            `=IFERROR(${col}${debtRows.net_debt_company_reported}/` +
              `${col}${debtRows.company_reported_adjusted_ebitda},0)`,
          ],
        ]
      : [];
  // Both ratios divide by a row the reader can see. Adjusted EBITDA and net
  // interest are surfaced on the face immediately above the ratio that consumes
  // them, and the ratio divides by THAT row rather than reaching back into the
  // income statement — so the multiple reconciles on screen. Net interest is
  // shown as a positive cost (the income statement carries it as a negative),
  // which is what makes the coverage ratio read straight off the two rows.
  const leverageEbitdaRow = statementByRole.get("adjusted_ebitda").row;
  const netInterestLegs = ["interest_expense", "interest_income"]
    .map((role) => statementByRole.get(role)?.row)
    .filter(Boolean);
  const leverageBlockFormulas = (col) => [
    [debtRows.leverage_adjusted_ebitda, `=${col}${leverageEbitdaRow}`],
    ...(Number.isInteger(debtRows.net_debt_excluding_leases_to_adjusted_ebitda)
      ? [
          [
            debtRows.net_debt_excluding_leases_to_adjusted_ebitda,
            `=IFERROR(${col}${debtRows.net_debt_excluding_leases}/` +
              `${col}${debtRows.leverage_adjusted_ebitda},0)`,
          ],
        ]
      : []),
    [
      debtRows.net_debt_to_adjusted_ebitda,
      `=IFERROR(${col}${leverageNetDebtRow}/` +
        `${col}${debtRows.leverage_adjusted_ebitda},0)`,
    ],
    [
      debtRows.leverage_net_interest,
      netInterestLegs.length
        ? `=-(${netInterestLegs.map((row) => `${col}${row}`).join("+")})`
        : "=0",
    ],
    [
      debtRows.adjusted_ebitda_to_net_interest,
      `=IFERROR(${col}${debtRows.leverage_adjusted_ebitda}/` +
        `${col}${debtRows.leverage_net_interest},0)`,
    ],
  ];
  for (const column of HISTORICAL_COLUMNS) {
    applyFormula(
      sheet,
      `${column}${debtRows.acquisition_debt}`,
      "=0",
    );
    applyFormula(
      sheet,
      `${column}${debtRows.total_acquisition_debt}`,
      `=${column}${debtRows.acquisition_debt}`,
    );
    applyFormula(
      sheet,
      `${column}${debtRows.total_lease_liabilities}`,
      `=${column}${debtRows.lease_liability}`,
    );
    applyFormula(
      sheet,
      `${column}${debtRows.gross_debt_including_leases}`,
      `=${column}${debtRows.gross_debt_excluding_leases}+${column}${debtRows.total_lease_liabilities}`,
    );
    for (const [row, formula] of netDebtBlockFormulas(column)) {
      applyFormula(sheet, `${column}${row}`, formula);
    }
    for (const [row, formula] of leverageBlockFormulas(column)) {
      applyFormula(sheet, `${column}${row}`, formula);
    }
    for (const [row, formula] of companyReportedBlockFormulas(column)) {
      applyFormula(sheet, `${column}${row}`, formula);
    }
    // The liquidity block also stands up for the last actual column so the
    // reader can see the forecast against a reported starting point.
    if (column === "I") {
      applyFormula(
        sheet,
        `${column}${debtRows.undrawn_rcf}`,
        undrawnRcfFormula(column),
      );
      applyFormula(
        sheet,
        `${column}${debtRows.drawn_commercial_paper}`,
        commercialPaperPlans.length
          ? `=-SUM(${commercialPaperPlans
              .map((plan) => `${column}${plan.debt_row}`)
              .join(",")})`
          : "=0",
      );
      applyFormula(
        sheet,
        `${column}${debtRows.year_end_cash}`,
        explicitCashBuckets
          ? `=${column}${debtRows.liquidity_cash}`
          : `=${column}${statementByRole.get("ending_cash").row}`,
      );
      applyFormula(
        sheet,
        `${column}${debtRows.total_liquidity}`,
        `=${column}${debtRows.undrawn_rcf}+${column}${debtRows.drawn_commercial_paper}+${column}${debtRows.year_end_cash}`,
      );
    }
  }
  // Each named reconciling item is a reported fact, so it is a hardcode in
  // every period — three actuals the issuer published, and a forecast path the
  // case states. There is no formula to derive it from: that is precisely what
  // makes it a company-basis item rather than something the model calculates.
  bridgeComponents.forEach((component, index) => {
    const row = bridgeComponentRows[index];
    setRow(sheet, `G${row}:I${row}`, component.values.slice(0, 3));
    styleInput(sheet, `G${row}:I${row}`);
    if (!component.note) return;
    addCommentOnce(workbook, sheet, `G${row}`, component.note);
  });
  const leasePrincipalAssumptionRow = debtRows.lease_principal_assumption;
  const leaseAdditionsAssumptionRow = debtRows.lease_additions_assumption;
  if (
    Number.isInteger(leasePrincipalAssumptionRow) &&
    Number.isInteger(leaseAdditionsAssumptionRow)
  ) {
    for (const row of [leasePrincipalAssumptionRow, leaseAdditionsAssumptionRow]) {
      setPeriodNumberFormat(sheet, row, AMOUNT);
      for (const column of HISTORICAL_COLUMNS) {
        setValue(sheet, `${column}${row}`, null);
        sheet.getRange(`${column}${row}`).format.fill = COLORS.grey;
      }
      applyFormula(sheet, `R${row}`, `=I${row}`);
    }
    setRow(
      sheet,
      `J${leasePrincipalAssumptionRow}:L${leasePrincipalAssumptionRow}`,
      asSeries3(modelCase.lease_policy.principal_repayment, 0),
    );
    styleInput(
      sheet,
      `J${leasePrincipalAssumptionRow}:L${leasePrincipalAssumptionRow}`,
    );
    for (let index = 0; index < 3; index += 1) {
      const standaloneColumn = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      if (modelCase.lease_policy.mode === "flat_replacement") {
        applyFormula(
          sheet,
          `${standaloneColumn}${leaseAdditionsAssumptionRow}`,
          `=${standaloneColumn}${leasePrincipalAssumptionRow}`,
        );
      } else if (modelCase.lease_policy.mode === "simple_roll_forward") {
        setValue(
          sheet,
          `${standaloneColumn}${leaseAdditionsAssumptionRow}`,
          Number(modelCase.lease_policy.additions?.[index] ?? 0),
        );
        styleInput(
          sheet,
          `${standaloneColumn}${leaseAdditionsAssumptionRow}`,
        );
      } else {
        setValue(sheet, `${standaloneColumn}${leaseAdditionsAssumptionRow}`, null);
        sheet.getRange(
          `${standaloneColumn}${leaseAdditionsAssumptionRow}`,
        ).format.fill = COLORS.grey;
      }
      for (const row of [
        leasePrincipalAssumptionRow,
        leaseAdditionsAssumptionRow,
      ]) {
        applyFormula(sheet, `${adjustmentColumn}${row}`, "=0");
        applyFormula(
          sheet,
          `${proFormaColumn}${row}`,
          `=${standaloneColumn}${row}+${adjustmentColumn}${row}`,
        );
      }
    }
    addCommentOnce(
      workbook,
      sheet,
      `B${leasePrincipalAssumptionRow}`,
      "Visible forecast assumption consumed by the cash-flow statement and lease-liability roll-forward; no formula may embed this amount as a numeric literal.",
    );
  }
  for (let index = 0; index < 3; index += 1) {
    const column = FORECAST_COLUMNS[index];
    const prior =
      index === 0
        ? `I${debtRows.lease_liability}`
        : `${FORECAST_COLUMNS[index - 1]}${debtRows.lease_liability}`;
    const principalCell = Number.isInteger(leasePrincipalAssumptionRow)
      ? `${column}${leasePrincipalAssumptionRow}`
      : "0";
    const additionsCell = Number.isInteger(leaseAdditionsAssumptionRow)
      ? `${column}${leaseAdditionsAssumptionRow}`
      : "0";
    const formula =
      modelCase.lease_policy.mode === "exclude"
        ? "=0"
        : `=MAX(0,${prior}+${additionsCell}-${principalCell})`;
    if (modelCase.lease_policy.mode === "sourced_balance") {
      setValue(
        sheet,
        `${column}${debtRows.lease_liability}`,
        leaseProjection[index].ending_total,
      );
      styleInput(sheet, `${column}${debtRows.lease_liability}`);
    } else {
      applyFormula(sheet, `${column}${debtRows.lease_liability}`, formula);
    }
    if (Number.isInteger(debtRows.lease_interest_bearing_liability)) {
      setValue(
        sheet,
        `${column}${debtRows.lease_interest_bearing_liability}`,
        leaseProjection[index].ending_interest_bearing,
      );
      styleInput(
        sheet,
        `${column}${debtRows.lease_interest_bearing_liability}`,
      );
    }
    applyFormula(
      sheet,
      `${column}${debtRows.total_lease_liabilities}`,
      `=${column}${debtRows.lease_liability}`,
    );
    applyFormula(sheet, `${column}${debtRows.acquisition_debt}`, "=0");
    applyFormula(
      sheet,
      `${column}${debtRows.total_acquisition_debt}`,
      `=${column}${debtRows.acquisition_debt}`,
    );
    applyFormula(
      sheet,
      `${column}${debtRows.gross_debt_including_leases}`,
      `=${column}${debtRows.gross_debt_excluding_leases}+${column}${debtRows.total_lease_liabilities}`,
    );
    const endingCashRow = statementEndingCashRow;
    if (explicitCashBuckets) {
      for (const bucket of cashBucketPlans) {
        if (bucket.forecast_treatment === "balancing") {
          const otherCashFlowBuckets = cashBucketPlans
            .filter(
              (candidate) =>
                candidate !== bucket &&
                candidate.included_in_cash_flow_cash !== false,
            )
            .map((candidate) => `${column}${candidate.balance_row}`);
          applyFormula(
            sheet,
            `${column}${bucket.balance_row}`,
            `=${column}${statementEndingCashRow}` +
              (otherCashFlowBuckets.length
                ? `-SUM(${otherCashFlowBuckets.join(",")})`
                : ""),
          );
        } else if (bucket.forecast_treatment === "hardcode") {
          setValue(
            sheet,
            `${column}${bucket.balance_row}`,
            Number(bucket.forecast_values?.[index] ?? 0),
          );
          styleInput(sheet, `${column}${bucket.balance_row}`);
        } else if (bucket.forecast_treatment === "linked_debt_addback") {
          applyFormula(
            sheet,
            `${column}${bucket.balance_row}`,
            linkedDebtCashFormula(bucket, column),
          );
        } else {
          const priorColumn = index === 0 ? "I" : FORECAST_COLUMNS[index - 1];
          applyFormula(
            sheet,
            `${column}${bucket.balance_row}`,
            `=${priorColumn}${bucket.balance_row}`,
          );
        }
      }
      for (const id of [
        "reported_cash",
        "liquidity_cash",
        "interest_bearing_cash",
        "cash_for_net_debt",
      ]) {
        applyFormula(
          sheet,
          `${column}${debtRows[id]}`,
          cashSummaryFormula(id, column),
        );
      }
    } else {
      applyFormula(
        sheet,
        `${column}${debtRows.cash_for_net_debt}`,
        `=-${column}${endingCashRow}*$D$${interestRows.interest_income_schedule}`,
      );
    }
    bridgeComponents.forEach((component, componentIndex) => {
      const row = bridgeComponentRows[componentIndex];
      setValue(sheet, `${column}${row}`, component.values[3 + index]);
      styleInput(sheet, `${column}${row}`);
    });
    for (const [row, formula] of netDebtBlockFormulas(column)) {
      applyFormula(sheet, `${column}${row}`, formula);
    }
    for (const [row, formula] of leverageBlockFormulas(column)) {
      applyFormula(sheet, `${column}${row}`, formula);
    }
    for (const [row, formula] of companyReportedBlockFormulas(column)) {
      applyFormula(sheet, `${column}${row}`, formula);
    }
    // Liquidity = undrawn RCF - drawn commercial paper + year-end cash.
    applyFormula(
      sheet,
      `${column}${debtRows.undrawn_rcf}`,
      undrawnRcfFormula(column),
    );
    applyFormula(
      sheet,
      `${column}${debtRows.drawn_commercial_paper}`,
      commercialPaperPlans.length
        ? `=-SUM(${commercialPaperPlans
            .map((plan) => `${column}${plan.debt_row}`)
            .join(",")})`
        : "=0",
    );
    applyFormula(
      sheet,
      `${column}${debtRows.year_end_cash}`,
      explicitCashBuckets
        ? `=${column}${debtRows.liquidity_cash}`
        : `=${column}${endingCashRow}`,
    );
    applyFormula(
      sheet,
      `${column}${debtRows.total_liquidity}`,
      `=${column}${debtRows.undrawn_rcf}+${column}${debtRows.drawn_commercial_paper}+${column}${debtRows.year_end_cash}`,
    );

    const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
    const proFormaColumn = PRO_FORMA_COLUMNS[index];
    const factor = acquisitionFactorFormula(adjustmentColumn, rowPlan);
    // THE ACQUISITION DEBT LIVES IN THE ADJUSTMENT COLUMN.
    //
    // This is the row the whole adjustment block exists for, so it is written
    // where the reader looks for it: the ADJUSTMENT cell carries the tranche —
    // the separately supplied debt amount, drawn in the year the deal closes
    // and held flat thereafter — and the pro-forma cell is standalone plus
    // that adjustment, like every other balance on this schedule. The company's
    // own standalone column stays at zero because the standalone case does not
    // do the deal.
    //
    // It used to be the other way round: the tranche was sized in the PRO-FORMA
    // cell and the adjustment cell was handed the leftover `pro forma minus
    // standalone`. That reads backwards — the adjustment column is the deal,
    // not a residual — and it left the one genuinely transaction-driven balance
    // in the model indistinguishable in shape from a rounding difference.
    const priorAcquisitionDebt =
      index === 0
        ? "0"
        : `${ADJUSTMENT_COLUMNS[index - 1]}${debtRows.acquisition_debt}`;
    const acquisitionDraw = acquisitionDrawFormula(adjustmentColumn, rowPlan);
    // The switch is written HERE rather than left to the blanket gate applied
    // to the adjustment columns at the end of the build. That gate is a
    // post-processing pass over the XML, so it lands AFTER the workbook has
    // been recalculated: an ungated tranche draws its full enterprise-value
    // amount during that recalculation and every cached total above it — gross
    // debt, change in debt — keeps the off-state figure it should never have
    // had. Gating the tranche at source makes the off state true from the
    // moment the balance is written.
    applyFormula(
      sheet,
      `${adjustmentColumn}${debtRows.acquisition_debt}`,
      `=IF($P$${c.adjustments_enabled}=0,0,MAX(0,${priorAcquisitionDebt}+` +
        `${acquisitionDraw}))`,
    );
    applyFormula(
      sheet,
      `${proFormaColumn}${debtRows.acquisition_debt}`,
      `=${column}${debtRows.acquisition_debt}+${adjustmentColumn}${debtRows.acquisition_debt}`,
    );
    // ONE shape per row, written into BOTH the adjustment block and the
    // pro-forma block. A subtotal sums its own block's components, a link
    // points at its own block's source row — so the adjustment column states
    // the deal effect on that measure directly, and never as the leftover
    // between two independently-computed columns. Rows the transaction cannot
    // reach (the lease liability, the reported-net-debt bridge) are an explicit
    // zero in the adjustment column and A + B = C in the pro-forma column.
    const blockFormulaFor = (id, row, col) => {
      const leverage = new Map(leverageBlockFormulas(col));
      const netDebt = new Map(netDebtBlockFormulas(col));
      const companyReported = new Map(companyReportedBlockFormulas(col));
      switch (id) {
        case "total_acquisition_debt":
          return `=${col}${debtRows.acquisition_debt}`;
        case "total_lease_liabilities":
          return `=${col}${debtRows.lease_liability}`;
        case "gross_debt_including_leases":
          return (
            `=${col}${debtRows.gross_debt_excluding_leases}+` +
            `${col}${debtRows.total_lease_liabilities}`
          );
        case "cash_for_net_debt":
          return (
            cashSummaryFormula(id, col) ??
            `=-${col}${endingCashRow}*$D$${interestRows.interest_income_schedule}`
          );
        case "reported_cash":
        case "liquidity_cash":
        case "interest_bearing_cash":
          return cashSummaryFormula(id, col);
        case "undrawn_rcf":
          // Headroom is capacity less drawn, and the capacity is the same
          // committed facility in every case — the transaction does not
          // upsize it. So the ADJUSTMENT to headroom is minus the adjustment
          // to the drawn balance; taking `capacity - drawn` literally in the
          // adjustment column would restate the whole facility as a deal
          // effect.
          return ADJUSTMENT_COLUMNS.includes(col)
            ? rcfPlan
              ? `=-${col}${rcfPlan.debt_row}`
              : "=0"
            : undrawnRcfFormula(col);
        case "drawn_commercial_paper":
          return commercialPaperPlans.length
            ? `=-SUM(${commercialPaperPlans
                .map((plan) => `${col}${plan.debt_row}`)
                .join(",")})`
            : "=0";
        case "year_end_cash":
          return explicitCashBuckets
            ? `=${col}${debtRows.liquidity_cash}`
            : `=${col}${endingCashRow}`;
        case "total_liquidity":
          return (
            `=${col}${debtRows.undrawn_rcf}+${col}${debtRows.drawn_commercial_paper}+` +
            `${col}${debtRows.year_end_cash}`
          );
        default:
          return (
            netDebt.get(row) ??
            leverage.get(row) ??
            companyReported.get(row) ??
            null
          );
      }
    };
    // The named reconciling items are reported facts about the company as it
    // stands. An acquisition does not restate them, so each is a structural
    // zero in the adjustment column — same treatment the lease liability gets.
    const structuralZeroIds = new Set([
      "lease_liability",
      "lease_interest_bearing_liability",
      ...bridgeComponents.map(
        (_, componentIndex) => `reported_net_debt_adjustment_${componentIndex}`,
      ),
    ]);
    for (const id of [
      "total_acquisition_debt",
      "gross_debt_excluding_leases",
      "lease_liability",
      "lease_interest_bearing_liability",
      "total_lease_liabilities",
      "gross_debt_including_leases",
      "reported_cash",
      "liquidity_cash",
      "interest_bearing_cash",
      "cash_for_net_debt",
      "net_debt_excluding_leases",
      "net_debt_including_leases",
      "total_change_in_debt",
      "leverage_adjusted_ebitda",
      "net_debt_excluding_leases_to_adjusted_ebitda",
      "net_debt_to_adjusted_ebitda",
      "leverage_net_interest",
      "adjusted_ebitda_to_net_interest",
      "net_debt_model_basis_restated",
      ...bridgeComponents.map(
        (_, componentIndex) => `reported_net_debt_adjustment_${componentIndex}`,
      ),
      "net_debt_company_reported",
      "company_reported_adjusted_ebitda",
      "net_debt_company_reported_to_adjusted_ebitda",
      "undrawn_rcf",
      "drawn_commercial_paper",
      "year_end_cash",
      "total_liquidity",
      ...cashBucketPlans.map(
        (bucket) => `cash_bucket.${bucket.bucket_id}`,
      ),
    ]) {
      const row = debtRows[id];
      if (!Number.isInteger(row)) continue;
      // Gross debt is emitted column-symmetrically above (adjustment column
      // included); change in debt is emitted below, where the first year's
      // reference columns are in scope. Neither is rewritten here.
      if (id === "gross_debt_excluding_leases" || id === "total_change_in_debt") {
        continue;
      }
      if (structuralZeroIds.has(id)) {
        applyFormula(sheet, `${adjustmentColumn}${row}`, "=0");
        applyFormula(
          sheet,
          `${proFormaColumn}${row}`,
          `=${column}${row}+${adjustmentColumn}${row}`,
        );
        continue;
      }
      if (id.startsWith("cash_bucket.")) {
        const bucket = cashBucketPlans.find(
          (candidate) => `cash_bucket.${candidate.bucket_id}` === id,
        );
        if (bucket.forecast_treatment === "balancing") {
          const proFormaOtherCashFlowBuckets = cashBucketPlans
            .filter(
              (candidate) =>
                candidate !== bucket &&
                candidate.included_in_cash_flow_cash !== false,
            )
            .map((candidate) => `${proFormaColumn}${candidate.balance_row}`);
          applyFormula(
            sheet,
            `${proFormaColumn}${row}`,
            `=${proFormaColumn}${statementEndingCashRow}` +
              (proFormaOtherCashFlowBuckets.length
                ? `-SUM(${proFormaOtherCashFlowBuckets.join(",")})`
                : ""),
          );
          applyFormula(
            sheet,
            `${adjustmentColumn}${row}`,
            `=${proFormaColumn}${row}-${column}${row}`,
          );
        } else if (bucket.forecast_treatment === "linked_debt_addback") {
          applyFormula(
            sheet,
            `${adjustmentColumn}${row}`,
            linkedDebtCashFormula(bucket, adjustmentColumn),
          );
          applyFormula(
            sheet,
            `${proFormaColumn}${row}`,
            linkedDebtCashFormula(bucket, proFormaColumn),
          );
        } else {
          applyFormula(sheet, `${adjustmentColumn}${row}`, "=0");
          applyFormula(
            sheet,
            `${proFormaColumn}${row}`,
            `=${column}${row}+${adjustmentColumn}${row}`,
          );
        }
        continue;
      }
      const proFormaFormula = blockFormulaFor(id, row, proFormaColumn);
      if (proFormaFormula) {
        applyFormula(sheet, `${proFormaColumn}${row}`, proFormaFormula);
      }
      const adjustmentFormula = blockFormulaFor(id, row, adjustmentColumn);
      if (adjustmentFormula) {
        applyFormula(sheet, `${adjustmentColumn}${row}`, adjustmentFormula);
      }
    }
    void factor;
  }

  const waterfallLabels = {
    cash_before_debt: "Cash available before debt repayment",
    non_rcf_debt_proceeds: "Non-RCF debt proceeds",
    pre_rcf_debt_cash_flow: "Mandatory debt repayments (pre-RCF)",
    lease_principal_waterfall: "Lease principal repayments",
    cash_before_rcf: "Cash before RCF",
    minimum_cash: "Minimum cash (control)",
    cash_surplus_deficit: "Cash surplus / (deficit) vs minimum cash",
    opening_rcf: "RCF — opening",
    rcf_draw_waterfall: "RCF — drawdown",
    rcf_repayment_waterfall: "RCF — repayment",
    ending_rcf: "RCF — closing",
    liquidity_shortfall: "Residual liquidity shortfall",
  };
  for (const [id, row] of Object.entries(waterfallRows)) {
    setValue(sheet, `B${row}`, waterfallLabels[id]);
    const rank = totalRank(
      id,
      ["cash_before_rcf", "cash_surplus_deficit", "ending_rcf"].includes(id),
      RANK_SECTION.RCF_WATERFALL,
    );
    if (rank) totalRanks.set(row, rank);
    setPeriodNumberFormat(sheet, row, AMOUNT);
    applyFormula(sheet, `R${row}`, `=I${row}`);
  }
  collectHeadlines(RANK_SECTION.RCF_WATERFALL, waterfallRows);

  const cfoRow = statementByRole.get("cash_from_operations")?.row;
  const cfiRow = statementByRole.get("cash_from_investing")?.row;
  const fxCashRow = statementByRole.get("fx_effect_on_cash")?.row;
  const openingCashRow = statementByRole.get("opening_cash")?.row;
  const balancingCashBucket = cashBucketPlans.find(
    (bucket) => bucket.forecast_treatment === "balancing",
  );
  const statementById = new Map(
    allStatementRows.map((definition) => [definition.row_id, definition]),
  );
  const financingDefinition = statementByRole.get("cash_from_financing");
  const financingRows = [];
  const financingRowIds = new Set();
  const collectFinancingRows = (rowId) => {
    const definition = statementById.get(rowId);
    if (!definition) return;
    const movementType = inferMovementType(definition);
    const childRefs = definition.calculation?.refs ?? [];
    if (!movementType && childRefs.length > 0) {
      for (const childId of childRefs) collectFinancingRows(childId);
      return;
    }
    if (!financingRowIds.has(definition.row_id)) {
      financingRowIds.add(definition.row_id);
      financingRows.push(definition);
    }
  };
  for (const rowId of financingDefinition?.calculation?.refs ?? []) {
    collectFinancingRows(rowId);
  }
  const debtMovementTypes = new Set([
    "debt_issuance",
    "scheduled_amortisation",
    "maturity_repayment",
    "debt_issuance_cost",
    "other_cash_debt_movement",
  ]);
  const rcfMovementTypes = new Set(["rcf_draw", "rcf_repayment"]);
  const directFinancingRows = financingRows.filter(
    (definition) => {
      const movementType = inferMovementType(definition);
      return (
        !debtMovementTypes.has(movementType) &&
        movementType !== "lease_principal" &&
        !rcfMovementTypes.has(movementType)
      );
    },
  );
  const debtMovementRows = financingRows.filter((definition) =>
    debtMovementTypes.has(inferMovementType(definition)),
  );
  const mandatoryRepaymentStatementRows = financingRows.filter((definition) => {
    const role = definition.semantic_role;
    const movementType = inferMovementType(definition);
    return (
      role === "debt_repayment" ||
      movementType === "scheduled_amortisation" ||
      movementType === "maturity_repayment"
    );
  });
  // The issuance leg mirrors the repayment leg: the sweep consumes the
  // visible statement issuance child (which itself links to the waterfall
  // proceeds row), so every live financing component enters ending cash
  // through the face of the statement exactly once instead of being
  // bypassed by a direct schedule read.
  const issuanceStatementRows = financingRows.filter((definition) => {
    const role = definition.semantic_role;
    const movementType = inferMovementType(definition);
    return role === "debt_issuance" || movementType === "debt_issuance";
  });
  const leasePrincipalRows = financingRows.filter(
    (definition) => inferMovementType(definition) === "lease_principal",
  );
  const sumCells = (blockColumn, definitions) =>
    sumCellExpression(
      definitions.map((definition) => `${blockColumn}${definition.row}`),
    );
  const nonRcfIssuanceTerms = (blockColumn, forecastIndex) =>
    rowPlan.instruments
      .filter((plan) => {
        const instrument = instrumentById.get(plan.instrument_id);
        return (
          !isBalancingRcf(modelCase, instrument) &&
          Number.isInteger(plan.issuance_row)
        );
      })
      .map((plan) => {
        const instrument = instrumentById.get(plan.instrument_id);
        const cell = `${blockColumn}${plan.issuance_row}`;
        const rate = fxFormula(
          modelCase,
          curveRows,
          instrumentBalanceCurrency(instrument),
          forecastIndex + 3,
          "average",
        );
        return rate === "1" ? cell : `${cell}*${rate}`;
      });
  // Instrument maturity mechanics remain inside each visible balance formula.
  // The schedule exposes one aggregate cash requirement, not a repeated
  // technical helper row beneath every instrument.  The waterfall consumes
  // this one visible answer.
  const compactFormulaTerms = (terms) => {
    const byColumn = new Map();
    const expressions = [];
    for (const term of terms.filter((item) => item && item !== "0")) {
      const match = String(term).match(/^\$?([A-Z]{1,3})\$?(\d+)$/);
      if (!match) {
        expressions.push(term);
        continue;
      }
      const [, column, rowText] = match;
      const rows = byColumn.get(column) ?? [];
      rows.push(Number(rowText));
      byColumn.set(column, rows);
    }
    for (const [column, rawRows] of [...byColumn.entries()].sort()) {
      const rows = [...new Set(rawRows)].sort((left, right) => left - right);
      let start = null;
      let prior = null;
      const flush = () => {
        if (start === null) return;
        expressions.push(
          start === prior
            ? `$${column}${start}`
            : `SUM($${column}${start}:$${column}${prior})`,
        );
      };
      for (const row of rows) {
        if (start === null) {
          start = row;
          prior = row;
        } else if (row === prior + 1) {
          prior = row;
        } else {
          flush();
          start = row;
          prior = row;
        }
      }
      flush();
    }
    return expressions;
  };
  const aggregateTerms = (terms) => {
    const compacted = compactFormulaTerms(terms);
    if (compacted.length === 0) return "0";
    if (compacted.length === 1) return compacted[0];
    return `SUM(${compacted.join(",")})`;
  };
  const mandatoryDebtRow = debtRows.mandatory_debt_repayments;
  if (Number.isInteger(mandatoryDebtRow)) {
    const reportedRepaymentRows = financingRows.filter((definition) => {
      const role = definition.semantic_role;
      const movement = inferMovementType(definition);
      return (
        role === "debt_repayment" ||
        movement === "scheduled_amortisation" ||
        movement === "maturity_repayment"
      );
    });
    for (const historicalColumn of HISTORICAL_COLUMNS) {
      applyFormula(
        sheet,
        `${historicalColumn}${mandatoryDebtRow}`,
        `=-(${sumCells(historicalColumn, reportedRepaymentRows)})`,
      );
    }
    applyFormula(sheet, `R${mandatoryDebtRow}`, `=I${mandatoryDebtRow}`);
    for (let index = 0; index < 3; index += 1) {
      const column = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      const pools = [...mandatoryRepaymentPools[index].values()];
      const expressions = pools.map((pool) => {
        const openingAndMovements = aggregateTerms(
          pool.openingAndMovementTerms,
        );
        const closing = aggregateTerms(pool.closingTerms);
        const nativeRepayment = `MAX(0,${openingAndMovements}-${closing})`;
        return pool.averageFx === "1"
          ? nativeRepayment
          : `${nativeRepayment}*${pool.averageFx}`;
      });
      applyFormula(
        sheet,
        `${column}${mandatoryDebtRow}`,
        expressions.length === 0
          ? "=0"
          : expressions.length === 1
            ? `=${expressions[0]}`
            : `=SUM(${expressions.join(",")})`,
      );
      const repaymentStates = rowPlan.instruments
        .map((plan) => ({
          plan,
          state: plan.repayment_state_by_period?.[index] ?? "zero",
        }))
        .filter(({ state }) => !["zero", "discretionary_rcf"].includes(state));
      addCommentOnce(
        workbook,
        sheet,
        `${column}${mandatoryDebtRow}`,
        repaymentStates.length
          ? [
              "Mandatory repayment state is declared once per instrument and is shared with the debt roll-forward.",
              ...repaymentStates.map(({ plan, state }) => {
                const instrument = instrumentById.get(plan.instrument_id);
                return `${instrument?.name ?? plan.instrument_id}: ${state.replaceAll("_", " ")}`;
              }),
            ].join("\n")
          : "No instrument has a scheduled or maturity repayment state in this period; the consolidated repayment is zero.",
      );
      applyFormula(sheet, `${adjustmentColumn}${mandatoryDebtRow}`, "=0");
      applyFormula(
        sheet,
        `${proFormaColumn}${mandatoryDebtRow}`,
        `=${column}${mandatoryDebtRow}+${adjustmentColumn}${mandatoryDebtRow}`,
      );
    }
  }
  for (let index = 0; index < 3; index += 1) {
    const column = FORECAST_COLUMNS[index];
    const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
    const proFormaColumn = PRO_FORMA_COLUMNS[index];
    const effectiveMinCash = `$C$${c.effective_minimum_cash}`;
    const cashBeforeDebtFormula = (blockColumn) => {
      const openingCash = (() => {
        if (!explicitCashBuckets) return `${blockColumn}${openingCashRow}`;
        if (blockColumn === adjustmentColumn) {
          return index === 0
            ? "0"
            : `${ADJUSTMENT_COLUMNS[index - 1]}${balancingCashBucket.balance_row}`;
        }
        if (blockColumn === proFormaColumn) {
          return index === 0
            ? `R${balancingCashBucket.balance_row}`
            : `${PRO_FORMA_COLUMNS[index - 1]}${balancingCashBucket.balance_row}`;
        }
        return index === 0
          ? `I${balancingCashBucket.balance_row}`
          : `${FORECAST_COLUMNS[index - 1]}${balancingCashBucket.balance_row}`;
      })();
      return `=${openingCash}+${blockColumn}${cfoRow}+${blockColumn}${cfiRow}+` +
      `${fxCashRow ? `${blockColumn}${fxCashRow}+` : ""}` +
      `${sumCells(blockColumn, directFinancingRows)}`;
    };
    // The LINEAR cash bridge runs in all three blocks. The RCF draw and
    // repayment themselves do not: MAX/MIN make the sweep nonlinear. Solving
    // the adjustment deficit as though it were a third company double-counts
    // the standalone cash headroom whenever the standalone has surplus but the
    // pro-forma case has a deficit. The adjustment RCF movement is therefore
    // the explicit pro-forma-minus-standalone delta of the two independently
    // solved sweeps. This is the only identity that guarantees:
    //
    //   standalone RCF movement + adjustment = pro-forma RCF movement
    //
    // while leaving the linear cash bridge fully built from its own
    // constituents.
    for (const blockColumn of [column, adjustmentColumn, proFormaColumn]) {
      const isAdjustment = blockColumn === adjustmentColumn;
      applyFormula(
        sheet,
        `${blockColumn}${waterfallRows.cash_before_debt}`,
        cashBeforeDebtFormula(blockColumn),
      );
      const issuanceTerms = nonRcfIssuanceTerms(blockColumn, index);
      if (Number.isInteger(waterfallRows.non_rcf_debt_proceeds)) {
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.non_rcf_debt_proceeds}`,
          issuanceTerms.length
            ? `=SUM(${issuanceTerms.join(",")})`
            : "=0",
        );
      }
      // The maturity mechanics live once in the visible debt schedule, then
      // flow through the visible financing-statement repayment line(s).  The
      // sweep consumes those statement lines rather than bypassing them and
      // reading the schedule a second time.  This preserves one economic
      // writer while keeping the face of the cash-flow statement fully
      // traceable into ending cash.
      applyFormula(
        sheet,
        `${blockColumn}${waterfallRows.pre_rcf_debt_cash_flow}`,
        mandatoryRepaymentStatementRows.length
          ? `=${sumCells(blockColumn, mandatoryRepaymentStatementRows)}`
          : `=-${blockColumn}${mandatoryDebtRow}`,
      );
      applyFormula(
        sheet,
        `${blockColumn}${waterfallRows.lease_principal_waterfall}`,
        `=${sumCells(blockColumn, leasePrincipalRows)}`,
      );
      applyFormula(
        sheet,
        `${blockColumn}${waterfallRows.cash_before_rcf}`,
        `=${blockColumn}${waterfallRows.cash_before_debt}+` +
          (Number.isInteger(waterfallRows.non_rcf_debt_proceeds)
            ? `${
                issuanceStatementRows.length
                  ? `${sumCells(blockColumn, issuanceStatementRows).replace(/^=/, "")}+`
                  : `${blockColumn}${waterfallRows.non_rcf_debt_proceeds}+`
              }`
            : "") +
          `${blockColumn}${waterfallRows.pre_rcf_debt_cash_flow}+` +
          `${blockColumn}${waterfallRows.lease_principal_waterfall}`,
      );
      // The minimum-cash policy is the same control in every case. The deal
      // does not change it, so the adjustment column is a structural zero
      // rather than a second copy of the control.
      applyFormula(
        sheet,
        `${blockColumn}${waterfallRows.minimum_cash}`,
        isAdjustment ? "=0" : `=${effectiveMinCash}`,
      );
      // ONE signed line, not a deficit row and a surplus row that are the same
      // subtraction with opposite MAX() guards. Positive is headroom above the
      // minimum, negative is the shortfall the revolver has to fund, and the
      // reader gets the answer without cross-checking two rows of which exactly
      // one is always zero.
      applyFormula(
        sheet,
        `${blockColumn}${waterfallRows.cash_surplus_deficit}`,
        `=${blockColumn}${waterfallRows.cash_before_rcf}-${blockColumn}${waterfallRows.minimum_cash}`,
      );
      const priorRcf = isAdjustment
        ? index === 0
          ? "0"
          : `${ADJUSTMENT_COLUMNS[index - 1]}${waterfallRows.ending_rcf}`
        : index === 0
          ? `I${rcfPlan?.debt_row ?? waterfallRows.opening_rcf}`
          : `${blockColumn === column ? FORECAST_COLUMNS[index - 1] : PRO_FORMA_COLUMNS[index - 1]}${waterfallRows.ending_rcf}`;
      applyFormula(
        sheet,
        `${blockColumn}${waterfallRows.opening_rcf}`,
        `=${priorRcf}`,
      );
      // Spare commitment is read inside the draw, not parked on a row of its
      // own: the undrawn-RCF line in the liquidity block above already states
      // the headroom, and a second copy here only invites the reader to check
      // that the two agree.
      // The committed facility is the same size in every case — the deal does
      // not upsize it — so the INCREMENTAL draw is capped by what is left of
      // the commitment after the company's own opening draw, not by the whole
      // facility over again.
      if (isAdjustment) {
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.rcf_draw_waterfall}`,
          `=IF($P$${c.adjustments_enabled}=0,0,` +
            `${proFormaColumn}${waterfallRows.rcf_draw_waterfall}-` +
            `${column}${waterfallRows.rcf_draw_waterfall})`,
        );
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.rcf_repayment_waterfall}`,
          `=IF($P$${c.adjustments_enabled}=0,0,` +
            `${proFormaColumn}${waterfallRows.rcf_repayment_waterfall}-` +
            `${column}${waterfallRows.rcf_repayment_waterfall})`,
        );
      } else {
        if (foreignRcf) {
          const averageFx = rcfAverageFx(index);
          const openingFx = rcfOpeningFx(index, blockColumn);
          const openingNative =
            `(${blockColumn}${waterfallRows.opening_rcf}/${openingFx})`;
          const drawCapacityReporting =
            `MAX(0,${rcfCapacityRef}-${openingNative})*${averageFx}`;
          applyFormula(
            sheet,
            `${blockColumn}${waterfallRows.rcf_draw_waterfall}`,
            `=MIN(MAX(0,-${blockColumn}${waterfallRows.cash_surplus_deficit}),` +
              `${drawCapacityReporting})`,
          );
          applyFormula(
            sheet,
            `${blockColumn}${waterfallRows.rcf_repayment_waterfall}`,
            `=IF(${blockColumn}${waterfallRows.rcf_draw_waterfall}>0,0,` +
              `MIN(MAX(0,${blockColumn}${waterfallRows.cash_surplus_deficit}),` +
              `${openingNative}*${averageFx}))`,
          );
        } else {
          const drawCapacity =
            `MAX(0,${rcfCapacityRef}-${blockColumn}${waterfallRows.opening_rcf})`;
          applyFormula(
            sheet,
            `${blockColumn}${waterfallRows.rcf_draw_waterfall}`,
            `=MIN(MAX(0,-${blockColumn}${waterfallRows.cash_surplus_deficit}),` +
              `${drawCapacity})`,
          );
          applyFormula(
            sheet,
            `${blockColumn}${waterfallRows.rcf_repayment_waterfall}`,
            `=IF(${blockColumn}${waterfallRows.rcf_draw_waterfall}>0,0,` +
              `MIN(MAX(0,${blockColumn}${waterfallRows.cash_surplus_deficit}),` +
              `${blockColumn}${waterfallRows.opening_rcf}))`,
          );
        }
      }
      if (foreignRcf && isAdjustment) {
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.ending_rcf}`,
          `=${proFormaColumn}${waterfallRows.ending_rcf}-${column}${waterfallRows.ending_rcf}`,
        );
      } else if (foreignRcf) {
        const averageFx = rcfAverageFx(index);
        const openingFx = rcfOpeningFx(index, blockColumn);
        const endingFx = rcfEndingFx(blockColumn);
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.ending_rcf}`,
          `=(${blockColumn}${waterfallRows.opening_rcf}/${openingFx}+` +
            `${blockColumn}${waterfallRows.rcf_draw_waterfall}/${averageFx}-` +
            `${blockColumn}${waterfallRows.rcf_repayment_waterfall}/${averageFx})*${endingFx}`,
        );
      } else {
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.ending_rcf}`,
          `=${blockColumn}${waterfallRows.opening_rcf}+${blockColumn}${waterfallRows.rcf_draw_waterfall}-${blockColumn}${waterfallRows.rcf_repayment_waterfall}`,
        );
      }
      if (isAdjustment) {
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.liquidity_shortfall}`,
          `=${proFormaColumn}${waterfallRows.liquidity_shortfall}-` +
            `${column}${waterfallRows.liquidity_shortfall}`,
        );
      } else {
        applyFormula(
          sheet,
          `${blockColumn}${waterfallRows.liquidity_shortfall}`,
          `=MAX(0,${blockColumn}${waterfallRows.minimum_cash}-(` +
            `${blockColumn}${waterfallRows.cash_before_rcf}+` +
            `${blockColumn}${waterfallRows.rcf_draw_waterfall}-` +
            `${blockColumn}${waterfallRows.rcf_repayment_waterfall}))`,
        );
      }
      // The sweep stops at the revolver. Ending cash is a CASH FLOW line and
      // is stated once on that statement; the shortfall remains visible here
      // when committed capacity cannot restore the minimum-cash control.
    }
  }

  // TOTAL CHANGE IN DEBT — the CASH movement, one line, in the debt schedule.
  //
  // On a FORECAST basis it is compiled directly from cash events: non-RCF
  // issuance plus mandatory repayment plus RCF draw less RCF repayment. The
  // cash flow links down to this row, so it must never be inferred from a
  // translated balance delta.
  //
  // The translation it strips out is stated on its own line directly beneath,
  // so the reader can still close the roll-forward by eye:
  //
  //   opening gross debt + total change in debt + FX translation
  //     + instrument-level other non-cash movements
//     = closing gross debt
  //
  // This is the CASH FLOW's "one line, no split beneath it" honoured, not
  // broken: the cash flow still shows a single Net Change in Debt. The split
  // lives in the DEBT SCHEDULE, where the two facts are genuinely different
  // and the reader needs both to follow the balances.
  //
  // On a HISTORIC basis it CONSOLIDATES the company's reported debt cash
  // movements: additions, repayments, issue costs, commercial paper, other
  // movements and both revolver legs. It therefore equals the reported Net
  // Change in Debt to the penny, which is what "ties on a historic basis"
  // means for a line that the cash flow will read from. It deliberately does
  // NOT restate the historic balance movement: debt assumed in an acquisition
  // moves the balance sheet without moving cash, and a line the cash flow
  // links to has to be the cash measure.
  //
  // Leases are excluded on both bases because the cash flow states lease
  // principal on its own line beneath this one.
  if (Number.isInteger(debtRows.total_change_in_debt)) {
    const changeRow = debtRows.total_change_in_debt;
    const fxRow = debtRows.debt_fx_translation;
    const grossDebtRow = debtRows.gross_debt_excluding_leases;
    const rcfCashFlowRows = financingRows.filter((definition) =>
      rcfMovementTypes.has(inferMovementType(definition)),
    );
    const historicDebtCashRows = [...debtMovementRows, ...rcfCashFlowRows];
    for (const historicalColumn of HISTORICAL_COLUMNS) {
      applyFormula(
        sheet,
        `${historicalColumn}${changeRow}`,
        `=${sumCells(historicalColumn, historicDebtCashRows)}`,
      );
    }
    applyFormula(sheet, `R${changeRow}`, `=I${changeRow}`);
    // The instruments the gross-debt subtotal actually adds up. Non-cash
    // movements from these rows are removed from the FX residual below.
    const grossDebtPlans = nonRcfPlans.filter(
      (plan) =>
        instrumentById.get(plan.instrument_id).include_in_gross_debt !== false,
    );
    for (let index = 0; index < 3; index += 1) {
      const column = FORECAST_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const priorColumn = index === 0 ? "I" : FORECAST_COLUMNS[index - 1];
      const priorProFormaColumn =
        index === 0 ? "R" : PRO_FORMA_COLUMNS[index - 1];
      // Pro-forma FY1 opens on the last actual. The R column mirrors it for
      // subtotals but is blank on the individual instrument rows, so the
      // translation reads its opening balances from column I — the same
      // figures, and the only ones on the face.
      const standaloneOtherNonCash = otherNonCashExpression(
        grossDebtPlans,
        column,
      );
      // Existing issuer instruments are unchanged by the transaction, so the
      // same visible non-cash movement rows apply in the pro-forma block.
      const proFormaOtherNonCash = standaloneOtherNonCash;
      const acquisitionDebtDelta =
        `${proFormaColumn}${debtRows.acquisition_debt}-` +
        `${index === 0 ? "R" : PRO_FORMA_COLUMNS[index - 1]}${debtRows.acquisition_debt}`;
      const cashMovementFormula = (blockColumn) => {
        const issuance = nonRcfIssuanceTerms(blockColumn, index);
        const terms = [
          ...issuance,
          `-${blockColumn}${mandatoryDebtRow}`,
          `${blockColumn}${waterfallRows.rcf_draw_waterfall}`,
          `-${blockColumn}${waterfallRows.rcf_repayment_waterfall}`,
        ];
        return `=SUM(${terms.join(",")})`;
      };
      applyFormula(
        sheet,
        `${column}${changeRow}`,
        cashMovementFormula(column),
      );
      applyFormula(
        sheet,
        `${proFormaColumn}${changeRow}`,
        cashMovementFormula(proFormaColumn),
      );
      applyFormula(
        sheet,
        `${adjustmentColumn}${changeRow}`,
        `=${proFormaColumn}${changeRow}-${column}${changeRow}`,
      );
      if (Number.isInteger(fxRow)) {
        applyFormula(
          sheet,
          `${column}${fxRow}`,
          `=${column}${grossDebtRow}-${priorColumn}${grossDebtRow}` +
            `-${column}${changeRow}` +
            `${standaloneOtherNonCash ? `-(${standaloneOtherNonCash})` : ""}`,
        );
        applyFormula(
          sheet,
          `${proFormaColumn}${fxRow}`,
          `=${proFormaColumn}${grossDebtRow}-${priorProFormaColumn}${grossDebtRow}` +
            `-${proFormaColumn}${changeRow}` +
            `${proFormaOtherNonCash ? `-(${proFormaOtherNonCash})` : ""}` +
            `-(${acquisitionDebtDelta})`,
        );
        applyFormula(
          sheet,
          `${adjustmentColumn}${fxRow}`,
          `=${proFormaColumn}${fxRow}-${column}${fxRow}`,
        );
      }
    }
  }

  setValue(sheet, `B${rowPlan.benchmark_row}`, "Reference rates");
  setValue(sheet, `B${rowPlan.interest_term_header_row}`, "Instrument");
  setRow(
    sheet,
    `C${rowPlan.interest_term_header_row}:E${rowPlan.interest_term_header_row}`,
    // See the debt term header above for why D is `Rate / spread` and not
    // `Coupon / spread`.
    ["Rate type", "Rate / spread", "Benchmark"],
  );
  applyRowFill(sheet, rowPlan.benchmark_row, COLORS.subsection);
  applyRowFill(sheet, rowPlan.interest_term_header_row, COLORS.subsection);
  styleFont(
    sheet,
    `B${rowPlan.benchmark_row}:U${rowPlan.interest_term_header_row}`,
    COLORS.black,
    { bold: true },
  );
  // Each reference-rate row states ONE curve. `benchmark_curves` carries the
  // curve's key, its display label and the row it was allocated, so the label a
  // reader sees and the row an instrument points at can never drift apart.
  //
  // TWO LABELS. `row_label` goes in column B of the reference-rate row, which
  // is 45 characters wide with C..F empty beside it; `label` goes in column E
  // of each instrument's interest row, which is 12. Handing E the long one put
  // a 51-character centred string in a 12-character column on AstraZeneca and
  // printed it straight over D. See benchmarkCurvePlan() in lib/row_plan.mjs.
  const benchmarkCurveByKey = new Map(
    (rowPlan.benchmark_curves ?? []).map((curve) => [curve.key, curve]),
  );
  const curveKeyForInstrument = (instrument) =>
    rowPlan.benchmark_curve_keys?.[instrument?.instrument_id] ??
    instrument?.benchmark ??
    null;
  const curveLabelForInstrument = (instrument) =>
    benchmarkCurveByKey.get(curveKeyForInstrument(instrument))?.label ??
    instrument?.benchmark ??
    null;
  for (const [curveKey, row] of Object.entries(rowPlan.benchmark_rows ?? {})) {
    setValue(
      sheet,
      `B${row}`,
      benchmarkCurveByKey.get(curveKey)?.row_label ??
        benchmarkCurveByKey.get(curveKey)?.label ??
        curveKey,
    );
    styleFont(sheet, `B${row}:U${row}`, COLORS.black, { bold: false });
    sheet.getRange(`G${row}:U${row}`).format.numberFormat = BENCHMARK;
    for (let index = 0; index < 3; index += 1) {
      const sourceColumn = ["F", "G", "H"][index];
      const standaloneColumn = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      const sourceRow = curveRows.benchmarks[curveKey];
      applyFormula(
        sheet,
        `${standaloneColumn}${row}`,
        `='Forward Curves'!${sourceColumn}${sourceRow}`,
        COLORS.green,
      );
      applyFormula(sheet, `${adjustmentColumn}${row}`, "=0");
      applyFormula(
        sheet,
        `${proFormaColumn}${row}`,
        `=${standaloneColumn}${row}`,
      );
    }
  }
  for (const floor of rowPlan.benchmark_floors ?? []) {
    const row = floor.row;
    setValue(sheet, `B${row}`, floor.label);
    styleFont(sheet, `B${row}:U${row}`, COLORS.black, { bold: false });
    sheet.getRange(`G${row}:U${row}`).format.numberFormat = BENCHMARK;
    for (let index = 0; index < 3; index += 1) {
      const standaloneColumn = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      setValue(sheet, `${standaloneColumn}${row}`, Number(floor.rates[index] ?? 0));
      styleInput(sheet, `${standaloneColumn}${row}`);
      applyFormula(sheet, `${adjustmentColumn}${row}`, "=0");
      applyFormula(sheet, `${proFormaColumn}${row}`, `=${standaloneColumn}${row}`);
    }
  }
  for (const pik of rowPlan.pik_rates ?? []) {
    const row = pik.row;
    setValue(sheet, `B${row}`, pik.label);
    styleFont(sheet, `B${row}:U${row}`, COLORS.black, { bold: false });
    sheet.getRange(`G${row}:U${row}`).format.numberFormat = BENCHMARK;
    for (let index = 0; index < 3; index += 1) {
      const standaloneColumn = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      setValue(sheet, `${standaloneColumn}${row}`, Number(pik.rates[index] ?? 0));
      styleInput(sheet, `${standaloneColumn}${row}`);
      applyFormula(sheet, `${adjustmentColumn}${row}`, "=0");
      applyFormula(sheet, `${proFormaColumn}${row}`, `=${standaloneColumn}${row}`);
    }
  }
  for (const bucket of cashBucketPlans) {
    setValue(sheet, `B${bucket.rate_row}`, `${bucket.label} — cash yield`);
    styleFont(sheet, `B${bucket.rate_row}:U${bucket.rate_row}`, COLORS.black, {
      bold: false,
    });
    sheet.getRange(`G${bucket.rate_row}:U${bucket.rate_row}`).format.numberFormat =
      BENCHMARK;
    for (let index = 0; index < 3; index += 1) {
      const standaloneColumn = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      applyFormula(
        sheet,
        `${standaloneColumn}${bucket.rate_row}`,
        `='Forward Curves'!${["F", "G", "H"][index]}${curveRows.cashYields[bucket.bucket_id]}`,
      );
      applyFormula(sheet, `${adjustmentColumn}${bucket.rate_row}`, "=0");
      applyFormula(
        sheet,
        `${proFormaColumn}${bucket.rate_row}`,
        `=${standaloneColumn}${bucket.rate_row}`,
      );
    }
  }
  if (cashBucketPlans.length) {
    const headerRow = rowPlan.rows_by_id.cash_bucket_interest_header;
    setValue(sheet, `B${headerRow}`, "Interest income by cash bucket");
    applyRowFill(sheet, headerRow, COLORS.subsection);
    styleFont(sheet, `B${headerRow}:U${headerRow}`, COLORS.black, {
      bold: true,
    });
    for (const bucket of cashBucketPlans) {
      setValue(sheet, `B${bucket.interest_row}`, bucket.label);
      setValue(sheet, `C${bucket.interest_row}`, "Average balance");
      setValue(
        sheet,
        `D${bucket.interest_row}`,
        bucket.interest_eligible_percentage,
      );
      setValue(sheet, `E${bucket.interest_row}`, "Cash yield");
      styleInput(sheet, `D${bucket.interest_row}`);
      sheet.getRange(`D${bucket.interest_row}`).format.numberFormat = PERCENT;
      setPeriodNumberFormat(sheet, bucket.interest_row, AMOUNT);
      setLabelIndent(sheet, rowPlan, bucket.interest_row, 1);
      applyFormula(sheet, `R${bucket.interest_row}`, `=I${bucket.interest_row}`);
    }
  }
  for (const group of rowPlan.debt_groups ?? []) {
    setValue(sheet, `B${group.interest_header_row}`, group.label);
    applyRowFill(sheet, group.interest_header_row, COLORS.subsection);
    styleFont(
      sheet,
      `B${group.interest_header_row}:U${group.interest_header_row}`,
      COLORS.black,
      { bold: true },
    );
    setValue(
      sheet,
      `B${group.interest_subtotal_row}`,
      `${group.label} — subtotal`,
    );
    // A per-group interest subtotal closes a run of instrument interest lines:
    // a component sum, like the balance subtotal it mirrors.
    totalRanks.set(group.interest_subtotal_row, groupSubtotalRank());
    setPeriodNumberFormat(sheet, group.interest_subtotal_row, AMOUNT);
  }
  for (const plan of rowPlan.instruments) {
    // The revolver has no instrument row in this schedule: its drawn interest
    // and its commitment fee are stated once, in the RCF fee block below.
    if (!plan.interest_row) continue;
    const instrument = instrumentById.get(plan.instrument_id);
    setValue(
      sheet,
      `B${plan.interest_row}`,
      plan.pik_interest_row ? `${instrument.name} — cash interest` : instrument.name,
    );
    // Three columns, three different facts. C is the RATE TYPE — which of the
    // two bases applies. D is the COUPON on a fixed instrument or the SPREAD on
    // a floating one. E is the BENCHMARK that spread is added to, and a fixed
    // instrument has none: it used to repeat "FIXED" from column C, so the row
    // said the same word twice and column E carried no information at all.
    // Where the instrument declares its own reference rate, E names THAT row,
    // not the shared index — so the reader can follow the multiply.
    setValue(sheet, `C${plan.interest_row}`, rateTypeLabel(instrument.rate_type));
    setValue(
      sheet,
      `D${plan.interest_row}`,
      instrument.rate_type === "unpriced"
        ? null
        : instrument.rate_type === "floating"
        ? Number(instrument.spread_bps ?? 0) / 10000
        : Number(instrument.coupon_or_all_in_rate?.[0] ?? 0),
    );
    setValue(
      sheet,
      `E${plan.interest_row}`,
      instrument.rate_type === "unpriced"
        ? null
        : instrument.rate_type === "floating"
        ? (curveLabelForInstrument(instrument) ?? null)
        : null,
    );
    if (instrument.rate_type === "unpriced") {
      styleFont(sheet, `C${plan.interest_row}`, COLORS.black);
      sheet.getRange(`D${plan.interest_row}:E${plan.interest_row}`).format.fill = COLORS.grey;
    } else {
      styleInput(sheet, `C${plan.interest_row}:E${plan.interest_row}`);
    }
    // Column D is a coupon on a fixed instrument and a spread on a floating
    // one, so it takes the format of whichever it is holding. One shared rate
    // format could only be right about one of them.
    sheet.getRange(`D${plan.interest_row}`).format.numberFormat =
      instrument.rate_type === "floating" ? BENCHMARK : COUPON;
    setPeriodNumberFormat(sheet, plan.interest_row, AMOUNT);
    if (plan.pik_interest_row) {
      setValue(sheet, `B${plan.pik_interest_row}`, `${instrument.name} — PIK interest`);
      setValue(sheet, `C${plan.pik_interest_row}`, "PIK");
      setValue(sheet, `E${plan.pik_interest_row}`, "PIK rate");
      styleFont(
        sheet,
        `B${plan.pik_interest_row}:E${plan.pik_interest_row}`,
        COLORS.black,
      );
      setLabelIndent(sheet, rowPlan, plan.pik_interest_row, 1);
      setPeriodNumberFormat(sheet, plan.pik_interest_row, AMOUNT);
      applyFormula(sheet, `R${plan.pik_interest_row}`, `=I${plan.pik_interest_row}`);
    }
    applyFormula(sheet, `R${plan.interest_row}`, `=I${plan.interest_row}`);
    for (let index = 0; index < 3; index += 1) {
      const column = FORECAST_COLUMNS[index];
      const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
      const proFormaColumn = PRO_FORMA_COLUMNS[index];
      // ONE CONVENTION FOR EVERY DRAWN INSTRUMENT: stated rate times exact
      // day-weighted native principal, translated at average FX. Dated issuance,
      // amortisation and maturity use the actual period boundaries shown on the
      // face (prior period-end + one day through current period-end). Undated
      // movements retain the midpoint convention.
      //
      // The whole expression sits inside the circularity gate. A stated rate
      // on a scheduled balance is not itself circular, but the CONTROL is a
      // kill switch, not a commentary on which leg of the loop is tightest:
      // the loop is total interest -> net income -> cash -> interest income ->
      // total interest, so leaving instrument interest live while claiming
      // circularity is off leaves the model computing interest in the breaker
      // state. `0` returns zero from every forecast interest line; `1`
      // restores the complete solution; the formula text is identical in both
      // states.
      //
      // It applies unchanged to bonds, commercial paper, bank loans,
      // overdrafts and the securitisation programmes. Term debt amortises or
      // matures mid-year, so the average captures the part-year balance;
      // revolving and undated lines are carried flat, where the average
      // collapses to the balance itself and costs nothing. Where the model
      // does draw or repay a revolver the movement happens through the year,
      // so the average is right there too. What differs by class is the RATE
      // (see rateFormula), not the balance basis — and one shared formula
      // shape means the reader can audit any row in this schedule with the
      // same eye.
      if (isBalancingRcf(modelCase, instrument)) {
        applyFormula(
          sheet,
          `${column}${plan.interest_row}`,
          `=${column}${interestRows.rcf_interest}`,
        );
        applyFormula(
          sheet,
          `${proFormaColumn}${plan.interest_row}`,
          `=${proFormaColumn}${interestRows.rcf_interest}`,
        );
      } else {
        const balanceCurrency = instrumentBalanceCurrency(instrument);
        const standalonePriorFx =
          index === 0
            ? fxFormula(
                modelCase,
                curveRows,
                balanceCurrency,
                2,
                "period_end",
              )
            : fxCell(balanceCurrency, FORECAST_COLUMNS[index - 1]);
        const standaloneOpening =
          index === 0
            ? `$D${plan.debt_row}`
            : standalonePriorFx === "1"
              ? `${FORECAST_COLUMNS[index - 1]}${plan.debt_row}`
              : `(${FORECAST_COLUMNS[index - 1]}${plan.debt_row}/${standalonePriorFx})`;
        const simpleBullet =
          !plan.issuance_row &&
          !plan.amortisation_row &&
          !plan.pik_row &&
          !plan.fair_value_row &&
          !plan.other_non_cash_row;
        const periodStart = `(${index === 0 ? "I" : FORECAST_COLUMNS[index - 1]}$${rowPlan.period_row}+1)`;
        const periodEnd = `${column}$${rowPlan.period_row}`;
        const periodDays = `(${periodEnd}-${periodStart}+1)`;
        const simpleActiveFraction =
          instrument.maturity_date &&
          instrument.maturity_treatment !== "non_maturing_within_forecast"
            ? `IF($C$${c.debt_maturities_roll}=0,1,` +
              `MAX(0,MIN($E${plan.debt_row},${periodEnd})-${periodStart}+1)/${periodDays})`
            : "1";
        const standaloneTiming = simpleBullet
          ? null
          : instrumentTimingExpressions(
              plan,
              instrument,
              index,
              column,
              standaloneOpening,
            );
        const standaloneWeighted = simpleBullet
          ? `MAX(0,${standaloneOpening})*(${simpleActiveFraction})`
          : `(${standaloneTiming.weightedBase}+` +
            `${plan.pik_row ? `${column}${plan.pik_row}` : "0"}*(${standaloneTiming.activeFraction})/2)`;
        const averageFx = fxFormula(
          modelCase,
          curveRows,
          balanceCurrency,
          index + 3,
          "average",
        );
        applyFormula(
          sheet,
          `${column}${plan.interest_row}`,
          `=IF($C$${c.circularity}=0,0,-${standaloneWeighted}*` +
            rateFormula(
              curveRows,
              instrument,
              index,
              `$D$${plan.interest_row}`,
              instrument.rate_type === "floating"
                ? `$${column}$${rowPlan.benchmark_rows?.[curveKeyForInstrument(instrument)]}`
                : null,
              curveKeyForInstrument(instrument),
              rowPlan.benchmark_floor_rows?.[instrument.instrument_id]
                ? `$${column}$${rowPlan.benchmark_floor_rows[instrument.instrument_id]}`
                : null,
            ) + `*${averageFx}` +
            ")",
        );
        // Pro forma LINKS TO THE PRO-FORMA DEBT SCHEDULE. It is not the
        // standalone number plus a bolt-on adjustment.
        const proFormaOpening =
          index === 0
            ? `$D${plan.debt_row}`
            : standalonePriorFx === "1"
              ? `${PRO_FORMA_COLUMNS[index - 1]}${plan.debt_row}`
              : `(${PRO_FORMA_COLUMNS[index - 1]}${plan.debt_row}/${standalonePriorFx})`;
        const proFormaTiming = simpleBullet
          ? null
          : instrumentTimingExpressions(
              plan,
              instrument,
              index,
              column,
              proFormaOpening,
            );
        const proFormaWeighted = simpleBullet
          ? `MAX(0,${proFormaOpening})*(${simpleActiveFraction})`
          : `(${proFormaTiming.weightedBase}+` +
            `${plan.pik_row ? `${proFormaColumn}${plan.pik_row}` : "0"}*(${proFormaTiming.activeFraction})/2)`;
        applyFormula(
          sheet,
          `${proFormaColumn}${plan.interest_row}`,
          `=IF($C$${c.circularity}=0,0,-${proFormaWeighted}*` +
            rateFormula(
              curveRows,
              instrument,
              index,
              `$D$${plan.interest_row}`,
              instrument.rate_type === "floating"
                ? `$${proFormaColumn}$${rowPlan.benchmark_rows?.[curveKeyForInstrument(instrument)]}`
                : null,
              curveKeyForInstrument(instrument),
              rowPlan.benchmark_floor_rows?.[instrument.instrument_id]
                ? `$${proFormaColumn}$${rowPlan.benchmark_floor_rows[instrument.instrument_id]}`
                : null,
            ) + `*${averageFx}` +
            ")",
        );
      }
      // THE ADJUSTMENT IS INTEREST ON THE ADJUSTMENT BALANCE.
      //
      // Same shape as the two columns either side of it — average balance times
      // the instrument's own rate — but read off the ADJUSTMENT column of the
      // debt schedule. An instrument the transaction never touches carries a
      // zero balance adjustment, so its interest adjustment is zero BY
      // CONSTRUCTION, not because two separately-struck interest figures
      // happened to agree. That is the defect this replaces: a senior debenture
      // with no acquisition exposure showed a multi-million "adjustment"
      // wherever the pro-forma and standalone interest lines picked up their
      // opening balance from different cells.
      //
      // The rate is the STANDALONE column's — the deal does not reprice the
      // issuer's existing debt — which is also what makes standalone plus
      // adjustment equal the pro-forma line exactly.
      if (isBalancingRcf(modelCase, instrument)) {
        applyFormula(
          sheet,
          `${adjustmentColumn}${plan.interest_row}`,
          `=${adjustmentColumn}${interestRows.rcf_interest}`,
        );
      } else {
        applyFormula(
          sheet,
          `${adjustmentColumn}${plan.interest_row}`,
          "=0",
        );
      }
      if (plan.pik_interest_row && plan.pik_row) {
        const standalonePikFx = fxFormula(
          modelCase,
          curveRows,
          instrumentBalanceCurrency(instrument),
          index + 3,
          "average",
        );
        const proFormaPikFx = standalonePikFx;
        applyFormula(
          sheet,
          `${column}${plan.pik_interest_row}`,
          `=IF($C$${c.circularity}=0,0,-${column}${plan.pik_row}*${standalonePikFx})`,
        );
        applyFormula(
          sheet,
          `${adjustmentColumn}${plan.pik_interest_row}`,
          "=0",
        );
        applyFormula(
          sheet,
          `${proFormaColumn}${plan.pik_interest_row}`,
          `=IF($C$${c.circularity}=0,0,-${proFormaColumn}${plan.pik_row}*${proFormaPikFx})`,
        );
      }
    }
  }
  for (const group of rowPlan.debt_groups ?? []) {
    const memberPlans = group.instrument_ids
      .map((instrumentId) =>
        rowPlan.instruments.find((plan) => plan.instrument_id === instrumentId),
      )
      .filter(Boolean);
    for (const column of [
      ...HISTORICAL_COLUMNS,
      ...FORECAST_COLUMNS,
      ...ADJUSTMENT_COLUMNS,
      "R",
      ...PRO_FORMA_COLUMNS,
    ]) {
      const cells = memberPlans
        .filter((plan) => plan.interest_row)
        .flatMap((plan) => [
          `${column}${plan.interest_row}`,
          ...(plan.pik_interest_row
            ? [`${column}${plan.pik_interest_row}`]
            : []),
        ]);
      // The revolver has no instrument row in this schedule, so the group it
      // belongs to picks up its whole cost from the RCF fee subtotal below —
      // drawn interest and commitment fee together, in one reference.
      if (
        memberPlans.some(
          (plan) =>
            isBalancingRcf(modelCase, instrumentById.get(plan.instrument_id)),
        )
      ) {
        cells.push(`${column}${interestRows.rcf_total_fees}`);
      }
      applyFormula(
        sheet,
        `${column}${group.interest_subtotal_row}`,
        sumCellFormula(cells),
      );
    }
  }
  const historicalInterestAuthority =
    resolveHistoricalInterestAuthority(modelCase);
  if (!historicalInterestAuthority.valid) {
    throw new Error(
      `Historical interest authority is invalid: ${historicalInterestAuthority.errors.join(" ")}`,
    );
  }
  const interestLabels = {
    instrument_interest: "Instrument-modelled interest",
    acquisition_interest: "Acquisition debt interest",
    rcf_total_fees: "Total RCF fees",
    rcf_interest: "RCF drawn interest",
    rcf_commitment_fee: "RCF commitment fee",
    lease_interest:
      leaseInterestBasis === "none"
        ? "Lease interest — not separately modelled"
        : "Lease interest",
    other_unallocated_interest: "Other / unallocated interest",
    interest_reported_total:
      historicalInterestBasisLabel(historicalInterestAuthority) ??
      "Filed finance expense (statement authority)",
    interest_identified_total: "Less: finance expense identified",
    non_cash_interest: "Non-cash interest",
    gross_interest_expense: "Gross interest expense",
    interest_income_schedule: "Interest income",
    net_interest_expense: "Net P&L interest",
    cash_interest_paid: "Cash interest paid",
    cash_interest_received: "Cash interest received",
  };
  for (const [id, row] of Object.entries(interestRows)) {
    setValue(sheet, `B${row}`, interestLabels[id]);
    const rank = totalRank(
      id,
      [
        "instrument_interest",
        "rcf_total_fees",
        "gross_interest_expense",
        "net_interest_expense",
        "cash_interest_paid",
      ].includes(id),
      RANK_SECTION.INTEREST_SCHEDULE,
    );
    if (rank) totalRanks.set(row, rank);
    setPeriodNumberFormat(sheet, row, AMOUNT);
    applyFormula(sheet, `R${row}`, `=I${row}`);
  }
  for (const id of [
    "rcf_interest",
    "rcf_commitment_fee",
    "interest_reported_total",
    "interest_identified_total",
  ]) {
    if (Number.isInteger(interestRows[id])) {
      setLabelIndent(sheet, rowPlan, interestRows[id], 1);
    }
  }
  collectHeadlines(RANK_SECTION.INTEREST_SCHEDULE, interestRows);
  // "Total RCF fees" sums its two grouped constituents in EVERY column block.
  // The two rows beneath it are outline level 1 (see rowPlan.outline_rows), so
  // the reader can collapse the pair and read one RCF cost line.
  for (const column of [
    ...HISTORICAL_COLUMNS,
    ...FORECAST_COLUMNS,
    ...ADJUSTMENT_COLUMNS,
    ...PRO_FORMA_COLUMNS,
  ]) {
    applyFormula(
      sheet,
      `${column}${interestRows.rcf_total_fees}`,
      `=SUM(${column}${interestRows.rcf_interest}:${column}${interestRows.rcf_commitment_fee})`,
    );
  }
  // Gross interest is THREE contiguous ranges, not one. It takes the "Total RCF
  // fees" subtotal and must skip the two rows grouped beneath it, or the RCF
  // cost would be counted twice; and it takes the unallocated-interest RESIDUAL
  // and must skip the two rows grouped beneath THAT, or reported gross interest
  // would be added to the very components it is being reconciled against.
  const grossInterestFormula = (column) =>
    `=SUM(${column}${interestRows.instrument_interest}:${column}${interestRows.rcf_total_fees})` +
    `+SUM(${column}${interestRows.lease_interest}:${column}${interestRows.other_unallocated_interest})` +
    `+${column}${interestRows.non_cash_interest}`;
  const visibleCommitmentFeeRate =
    modelCase.rcf_policy.commitment_fee_convention === "bps_on_undrawn"
      ? Number(modelCase.rcf_policy.commitment_fee_value ?? 0) / 10000
      : 0;
  const commitmentFeeCapturedInResidual =
    modelCase.rcf_policy.commitment_fee_convention === "captured_in_residual";
  // The revolver now states its own terms here, on the two rows that carry its
  // cost, under the same three column headings as every instrument above:
  // rate type, coupon / spread, benchmark.
  if (rcfInstrument) {
    setValue(
      sheet,
      `C${interestRows.rcf_interest}`,
      rateTypeLabel(rcfInstrument.rate_type),
    );
    setValue(
      sheet,
      `D${interestRows.rcf_interest}`,
      rcfInstrument.rate_type === "unpriced"
        ? null
        : rcfInstrument.rate_type === "floating"
        ? Number(rcfInstrument.spread_bps ?? 0) / 10000
        : Number(rcfInstrument.coupon_or_all_in_rate?.[0] ?? 0),
    );
    setValue(
      sheet,
      `E${interestRows.rcf_interest}`,
      rcfInstrument.rate_type === "unpriced"
        ? null
        : rcfInstrument.rate_type === "floating"
        ? (curveLabelForInstrument(rcfInstrument) ?? null)
        : null,
    );
    if (rcfInstrument.rate_type === "unpriced") {
      styleFont(sheet, `C${interestRows.rcf_interest}`, COLORS.black);
      sheet.getRange(`D${interestRows.rcf_interest}:E${interestRows.rcf_interest}`).format.fill = COLORS.grey;
    } else {
      styleInput(
        sheet,
        `C${interestRows.rcf_interest}:E${interestRows.rcf_interest}`,
      );
    }
    sheet.getRange(`D${interestRows.rcf_interest}`).format.numberFormat =
      rcfInstrument.rate_type === "floating" ? BENCHMARK : COUPON;
  }
  // Column E is the BENCHMARK column. The commitment fee used to park the
  // facility CAPACITY there — 4,500, a balance, sitting under a heading that
  // means "the rate this spread is added to". The capacity is already stated
  // once, as the nominal amount on the facility's own row in the debt
  // schedule, and every formula that needs it now reads it from there.
  setValue(
    sheet,
    `C${interestRows.rcf_commitment_fee}`,
    commitmentFeeCapturedInResidual ? RATE_TYPE_LABEL.unpriced : COMMITMENT_FEE_BASIS_LABEL,
  );
  setValue(
    sheet,
    `D${interestRows.rcf_commitment_fee}`,
    commitmentFeeCapturedInResidual ? null : visibleCommitmentFeeRate,
  );
  setValue(sheet, `E${interestRows.rcf_commitment_fee}`, null);
  if (commitmentFeeCapturedInResidual) {
    styleFont(sheet, `C${interestRows.rcf_commitment_fee}`, COLORS.black);
    sheet.getRange(`D${interestRows.rcf_commitment_fee}:E${interestRows.rcf_commitment_fee}`).format.fill = COLORS.grey;
  } else {
    styleInput(
      sheet,
      `D${interestRows.rcf_commitment_fee}`,
    );
  }
  // A commitment fee is quoted in basis points over the undrawn balance, the
  // same way a margin is. It belongs on the spread rung, not the coupon rung.
  sheet.getRange(`D${interestRows.rcf_commitment_fee}`).format.numberFormat =
    BENCHMARK;
  setRow(
    sheet,
    `C${interestRows.lease_interest}:E${interestRows.lease_interest}`,
    leaseInterestBasis === "none"
      ? [0, 0, 0]
      : asSeries3(modelCase.lease_policy.effective_rate, 0),
  );
  setRow(
    sheet,
    `C${interestRows.other_unallocated_interest}:E${interestRows.other_unallocated_interest}`,
    asSeries3(modelCase.other_interest, 0).map((value) => Math.abs(value)),
  );
  setRow(
    sheet,
    `C${interestRows.non_cash_interest}:E${interestRows.non_cash_interest}`,
    asSeries3(modelCase.non_cash_interest, 0).map((value) => Math.abs(value)),
  );
  for (const row of [
    interestRows.lease_interest,
    interestRows.other_unallocated_interest,
    interestRows.non_cash_interest,
  ]) {
    styleInput(sheet, `C${row}:E${row}`);
  }
  // The lease effective rate is the all-in rate the liability unwinds at — a
  // coupon in everything but name.
  sheet.getRange(
    `C${interestRows.lease_interest}:E${interestRows.lease_interest}`,
  ).format.numberFormat = COUPON;
  sheet.getRange(
    `C${interestRows.other_unallocated_interest}:E${interestRows.non_cash_interest}`,
  ).format.numberFormat = AMOUNT;
  setValue(
    sheet,
    `C${interestRows.interest_income_schedule}`,
    explicitCashBuckets ? "Sum of bucket interest" : "Eligible cash",
  );
  if (!explicitCashBuckets) {
    setValue(
      sheet,
      `D${interestRows.interest_income_schedule}`,
      Number(modelCase.cash_policy.eligible_cash_percentage),
    );
    styleInput(
      sheet,
      `D${interestRows.interest_income_schedule}`,
    );
  }
  // Eligible cash is a SHARE of the balance, not a rate struck on it: the rate
  // itself is the cash yield on the Forward Curves sheet. It sat on the rate
  // format and read as though 100% of cash were a 100.00% interest rate.
  if (!explicitCashBuckets) {
    sheet.getRange(`D${interestRows.interest_income_schedule}`).format.numberFormat =
      PERCENT;
  }
  const historicalIdentifiedInterest =
    historicalInterestAuthority.identified_finance_components ?? [0, 0, 0];
  // THE HISTORICAL COLUMNS BUILD UP THE SAME WAY THE FORECAST DOES.
  //
  // `identified_interest` is the portion of filed finance expense that has
  // been attributed to a named component row; the residual goes to the visible
  // "Other / unallocated interest" plug. The named components that carry their
  // own historical input rows — the RCF commitment fee and non-cash
  // issuance-cost amortisation — and separately disclosed lease interest are
  // all part of that identified finance-expense total and are already inside
  // the gross-interest SUM. "Instrument-modelled interest" is therefore the
  // identified total LESS RCF, non-cash and lease interest.
  //
  // By construction the historical column now foots exactly to the filed
  // finance-expense authority while still displaying lease interest once:
  //   instrument + lease + RCF + non-cash + plug
  //   = (identified - lease - RCF - non-cash) + lease + RCF + non-cash
  //     + (reported - identified)
  //   = filed finance expense.
  const historicalLeaseInterest = historicalInterestAuthority.lease_interest;
  const historicalRcfCommitmentFee =
    modelCase.historical_supplement?.rcf_commitment_fee ?? [0, 0, 0];
  const historicalNonCashInterest =
    modelCase.historical_supplement?.non_cash_interest ?? [0, 0, 0];
  const namedHistoricalDebtComponent = (index) =>
    Math.abs(Number(historicalRcfCommitmentFee[index] ?? 0)) +
    Math.abs(Number(historicalNonCashInterest[index] ?? 0));
  setRow(
    sheet,
    `G${interestRows.instrument_interest}:I${interestRows.instrument_interest}`,
    historicalIdentifiedInterest.map(
      (value, index) =>
        -(
          Math.abs(
            Number(
              historicalInterestAuthority.identified_debt_components?.[
                index
              ] ?? value,
            ),
          ) - namedHistoricalDebtComponent(index)
        ),
    ),
  );
  // THE RESIDUAL IS NOW A DIFFERENCE ON THE FACE, NOT A TYPED NUMBER.
  //
  // `reported interest - identified interest` used to be evaluated here and
  // the answer written into the cell. The number was
  // visible and correctly labelled "Other / unallocated interest", and no
  // reader could check it: both sides of the subtraction lived in the case
  // file and neither reached the sheet. The case has always carried
  // `historical_interest_reconciliation`; it simply was not shown.
  //
  // Reported gross interest is now an input row of its own, the interest the
  // schedule can attribute is summed from the component rows, and the residual
  // is the difference between the two — the same arithmetic, moved out of this
  // file and onto the sheet where it can be audited.
  //
  // HISTORIC COLUMNS ONLY, and deliberately so. A reconciliation proves a
  // build-up foots to an externally REPORTED figure. A forecast year has no
  // reported figure: writing one would invent an authority that does not
  // exist and would make the residual definitionally whatever was typed into
  // the row above it — the same hardcode, one row further up, dressed in a
  // subtraction. In the forecast, "Other / unallocated interest" is an honest
  // forward assumption and stays an input in C:E. The reconciliation rows are
  // blank there because they do not apply, which is itself the useful signal:
  // a reader can now see whether the forward plug is supported by the
  // historical residual or is a judgement standing on its own.
  const filedFinanceExpenseDefinition = statementByRole.get("interest_expense");
  const filedFinanceExpenseRow = filedFinanceExpenseDefinition?.row;
  if (!Number.isInteger(filedFinanceExpenseRow)) {
    throw new Error(
      "Historical interest reconciliation requires a semantic interest_expense statement row.",
    );
  }
  // The interest schedule is the single workbook location at which filed
  // finance values are entered.  The statement links DOWN to it in history and
  // forecast alike.  That preserves the filed statement as source authority
  // without creating two hardcodes or letting the schedule depend on one of
  // its consumers.
  for (const [index, column] of HISTORICAL_COLUMNS.entries()) {
    if (historicalInterestAuthority.has_filed_total) {
      setValue(
        sheet,
        `${column}${interestRows.interest_reported_total}`,
        -Math.abs(
          Number(
            historicalInterestAuthority.filed_finance_expense[index] ?? 0,
          ),
        ),
      );
      styleInput(sheet, `${column}${interestRows.interest_reported_total}`);
      const provenance = (modelCase.provenance?.[
        filedFinanceExpenseDefinition.row_id
      ] ?? []).find((entry) => Number(entry.period_index) === index);
      if (provenance) {
        addCommentOnce(
          workbook,
          sheet,
          `${column}${interestRows.interest_reported_total}`,
          provenanceComment(provenance),
        );
      }
    } else {
      applyFormula(
        sheet,
        `${column}${interestRows.interest_reported_total}`,
        `=${column}${interestRows.interest_identified_total}`,
      );
    }
  }
  // Everything the schedule can name, in the sign convention of the schedule.
  // `non_cash_interest` sits BELOW the residual and is still part of the
  // identified total: it is a named component inside gross interest, so
  // leaving it out would push it into the plug and count it twice.
  const identifiedComponentRows = [
    interestRows.instrument_interest,
    interestRows.acquisition_interest,
    interestRows.rcf_total_fees,
    interestRows.lease_interest,
    interestRows.non_cash_interest,
  ];
  for (const column of HISTORICAL_COLUMNS) {
    applyFormula(
      sheet,
      `${column}${interestRows.interest_identified_total}`,
      `=SUM(${identifiedComponentRows.map((row) => `${column}${row}`).join(",")})`,
    );
    applyFormula(
      sheet,
      `${column}${interestRows.other_unallocated_interest}`,
      historicalInterestAuthority.has_filed_total
        ? `=${column}${interestRows.interest_reported_total}-${column}${interestRows.interest_identified_total}`
        : "=0",
    );
  }
  setRow(
    sheet,
    `G${interestRows.rcf_commitment_fee}:I${interestRows.rcf_commitment_fee}`,
    historicalRcfCommitmentFee.map((value) => -Math.abs(Number(value ?? 0))),
  );
  setRow(
    sheet,
    `G${interestRows.non_cash_interest}:I${interestRows.non_cash_interest}`,
    historicalNonCashInterest.map((value) => -Math.abs(Number(value ?? 0))),
  );
  styleInput(
    sheet,
    `G${interestRows.instrument_interest}:I${interestRows.instrument_interest}`,
  );
  styleInput(
    sheet,
    `G${interestRows.rcf_commitment_fee}:I${interestRows.rcf_commitment_fee}`,
  );
  styleInput(
    sheet,
    `G${interestRows.non_cash_interest}:I${interestRows.non_cash_interest}`,
  );
  const filedInterestIncomeDefinition = statementByRole.get("interest_income");
  const filedInterestIncomeValues = filedInterestIncomeDefinition
    ? rowValues(modelCase, filedInterestIncomeDefinition)
    : [];
  const historicalInterestIncome = HISTORICAL_COLUMNS.map((_, index) => {
    const filed = filedInterestIncomeValues[index];
    return filed !== null && Number.isFinite(Number(filed))
      ? Number(filed)
      : Number(modelCase.historical_supplement?.interest_income?.[index] ?? 0);
  });
  setRow(
    sheet,
    `G${interestRows.interest_income_schedule}:I${interestRows.interest_income_schedule}`,
    historicalInterestIncome,
  );
  styleInput(
    sheet,
    `G${interestRows.interest_income_schedule}:I${interestRows.interest_income_schedule}`,
  );
  if (filedInterestIncomeDefinition) {
    for (const [index, column] of HISTORICAL_COLUMNS.entries()) {
      const provenance = (modelCase.provenance?.[
        filedInterestIncomeDefinition.row_id
      ] ?? []).find((entry) => Number(entry.period_index) === index);
      if (provenance) {
        addCommentOnce(
          workbook,
          sheet,
          `${column}${interestRows.interest_income_schedule}`,
          provenanceComment(provenance),
        );
      }
    }
  }
  setRow(
    sheet,
    `G${interestRows.lease_interest}:I${interestRows.lease_interest}`,
    historicalLeaseInterest.map((value) => -Math.abs(Number(value))),
  );
  styleInput(
    sheet,
    `G${interestRows.lease_interest}:I${interestRows.lease_interest}`,
  );
  const filedCashInterestPaidDefinition =
    statementByRole.get("cash_interest_paid");
  const filedCashInterestReceivedDefinition =
    statementByRole.get("cash_interest_received");
  const filedCashInterestPaidValues = filedCashInterestPaidDefinition
    ? rowValues(modelCase, filedCashInterestPaidDefinition)
    : [];
  const filedCashInterestReceivedValues = filedCashInterestReceivedDefinition
    ? rowValues(modelCase, filedCashInterestReceivedDefinition)
    : [];
  for (const [index, column] of HISTORICAL_COLUMNS.entries()) {
    applyFormula(
      sheet,
      `${column}${interestRows.gross_interest_expense}`,
      grossInterestFormula(column),
    );
    applyFormula(
      sheet,
      `${column}${interestRows.net_interest_expense}`,
      `=${column}${interestRows.gross_interest_expense}+${column}${interestRows.interest_income_schedule}`,
    );
    const filedPaid = filedCashInterestPaidValues[index];
    if (filedPaid !== null && Number.isFinite(Number(filedPaid))) {
      setValue(
        sheet,
        `${column}${interestRows.cash_interest_paid}`,
        Number(filedPaid),
      );
      styleInput(sheet, `${column}${interestRows.cash_interest_paid}`);
      const provenance = (modelCase.provenance?.[
        filedCashInterestPaidDefinition.row_id
      ] ?? []).find((entry) => Number(entry.period_index) === index);
      if (provenance) {
        addCommentOnce(
          workbook,
          sheet,
          `${column}${interestRows.cash_interest_paid}`,
          provenanceComment(provenance),
        );
      }
    } else {
      applyFormula(
        sheet,
        `${column}${interestRows.cash_interest_paid}`,
        `=${column}${interestRows.gross_interest_expense}-${column}${interestRows.non_cash_interest}`,
      );
    }
    const filedReceived = filedCashInterestReceivedValues[index];
    if (filedReceived !== null && Number.isFinite(Number(filedReceived))) {
      setValue(
        sheet,
        `${column}${interestRows.cash_interest_received}`,
        Number(filedReceived),
      );
      styleInput(sheet, `${column}${interestRows.cash_interest_received}`);
      const provenance = (modelCase.provenance?.[
        filedCashInterestReceivedDefinition.row_id
      ] ?? []).find((entry) => Number(entry.period_index) === index);
      if (provenance) {
        addCommentOnce(
          workbook,
          sheet,
          `${column}${interestRows.cash_interest_received}`,
          provenanceComment(provenance),
        );
      }
    } else {
      applyFormula(
        sheet,
        `${column}${interestRows.cash_interest_received}`,
        `=${column}${interestRows.interest_income_schedule}`,
      );
    }
  }
  const leaseInterestBalanceRow =
    leaseInterestBasis === "separately_supplied"
      ? debtRows.lease_interest_bearing_liability
      : debtRows.lease_liability;
  const leaseInterestFormula = (priorBalance, endingBalance, index) =>
    `=IF($C$${c.circularity}=0,0,-AVERAGE(${priorBalance},${endingBalance})*` +
    `$${["C", "D", "E"][index]}$${interestRows.lease_interest})`;
  for (let index = 0; index < 3; index += 1) {
    const column = FORECAST_COLUMNS[index];
    const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
    const proFormaColumn = PRO_FORMA_COLUMNS[index];
    const nonRcfInterestCells = rowPlan.instruments
      .filter(
        (plan) =>
          !isBalancingRcf(modelCase, instrumentById.get(plan.instrument_id)),
      )
      .flatMap((plan) => [
        `${column}${plan.interest_row}`,
        ...(plan.pik_interest_row
          ? [`${column}${plan.pik_interest_row}`]
          : []),
      ]);
    const nonCashInstrumentCellsFor = (targetColumn) =>
      rowPlan.instruments.flatMap((plan) => {
        const instrument = modelCase.instruments.find(
          (candidate) => candidate.instrument_id === plan.instrument_id,
        );
        return [
          ...(instrument?.cash_interest === false && plan.interest_row
            ? [`${targetColumn}${plan.interest_row}`]
            : []),
          ...(plan.pik_interest_row
            ? [`${targetColumn}${plan.pik_interest_row}`]
            : []),
        ];
      });
    applyFormula(
      sheet,
      `${column}${interestRows.instrument_interest}`,
      sumCellFormula(nonRcfInterestCells),
    );
    applyFormula(sheet, `${column}${interestRows.acquisition_interest}`, "=0");
    const priorRcf =
      index === 0
        ? `I${rcfPlan?.debt_row ?? waterfallRows.opening_rcf}`
        : `${FORECAST_COLUMNS[index - 1]}${waterfallRows.ending_rcf}`;
    const rcfPlanForRate = rcfPlan
      ? instrumentById.get(rcfPlan.instrument_id)
      : null;
    // One rate expression per column block: the pro-forma RCF must read the
    // pro-forma benchmark row, not the standalone one.
    const rcfRateFor = (rateColumn) =>
      rcfPlanForRate
        ? rateFormula(
            curveRows,
            rcfPlanForRate,
            index,
            `$D$${interestRows.rcf_interest}`,
            rcfPlanForRate.rate_type === "floating"
              ? `$${rateColumn}$${rowPlan.benchmark_rows?.[curveKeyForInstrument(rcfPlanForRate)]}`
              : null,
            curveKeyForInstrument(rcfPlanForRate),
            rowPlan.benchmark_floor_rows?.[rcfPlanForRate.instrument_id]
              ? `$${rateColumn}$${rowPlan.benchmark_floor_rows[rcfPlanForRate.instrument_id]}`
              : null,
          )
        : "0";
    const rcfRate = rcfRateFor(column);
    const proFormaRcfRate = rcfRateFor(proFormaColumn);
    const foreignRcfInterestFormula = (priorBalance, balanceColumn, rate) => {
      const openingFx = rcfOpeningFx(index, balanceColumn);
      const endingFx = rcfEndingFx(balanceColumn);
      const averageFx = rcfAverageFx(index);
      return `=IF($C$${c.circularity}=0,0,-AVERAGE(${priorBalance}/${openingFx},` +
        `${balanceColumn}${waterfallRows.ending_rcf}/${endingFx})*${rate}*${averageFx})`;
    };
    const foreignRcfCommitmentFeeFormula = (priorBalance, balanceColumn) => {
      const openingFx = rcfOpeningFx(index, balanceColumn);
      const endingFx = rcfEndingFx(balanceColumn);
      const averageFx = rcfAverageFx(index);
      return `=IF($C$${c.circularity}=0,0,-MAX(0,${rcfCapacityRef}-` +
        `AVERAGE(${priorBalance}/${openingFx},${balanceColumn}${waterfallRows.ending_rcf}/${endingFx}))` +
        `*$D$${interestRows.rcf_commitment_fee}*${averageFx})`;
    };
    // THE CIRCULARITY CONTROL IS A KILL SWITCH. `0` returns a formula-driven
    // zero from EVERY forecast interest-expense and interest-income line —
    // instrument, RCF, commitment fee, lease, acquisition, other/unallocated
    // and non-cash — so net interest is zero and the loop
    //   total interest -> net income -> cash -> interest income -> total
    // is broken at every point it touches, not just at its tightest leg.
    // `1` restores the complete solution. The formula text is byte-identical
    // in both states: this is a display/valuation state, never a structural
    // edit, so no toggle ever writes into or removes a formula cell.
    applyFormula(
      sheet,
      `${column}${interestRows.rcf_interest}`,
      foreignRcf
        ? foreignRcfInterestFormula(priorRcf, column, rcfRate)
        : `=IF($C$${c.circularity}=0,0,-AVERAGE(${priorRcf},${column}${waterfallRows.ending_rcf})*${rcfRate})`,
    );
    applyFormula(
      sheet,
      `${column}${interestRows.rcf_commitment_fee}`,
      foreignRcf
        ? foreignRcfCommitmentFeeFormula(priorRcf, column)
        : `=IF($C$${c.circularity}=0,0,-MAX(0,${rcfCapacityRef}-AVERAGE(${priorRcf},${column}${waterfallRows.ending_rcf}))*$D$${interestRows.rcf_commitment_fee})`,
    );
    // Lease interest runs off the contractual lease-liability schedule and the
    // two lines below are straight reads of visible input rows. None of the
    // three is circular in itself — they are gated because the breaker must
    // zero forecast interest ENTIRELY, not because cash feeds them. The raw
    // assumptions in C:E are untouched in both states.
    const priorLease =
      index === 0
        ? `I${leaseInterestBalanceRow}`
        : `${FORECAST_COLUMNS[index - 1]}${leaseInterestBalanceRow}`;
    applyFormula(
      sheet,
      `${column}${interestRows.lease_interest}`,
      leaseInterestFormula(
        priorLease,
        `${column}${leaseInterestBalanceRow}`,
        index,
      ),
    );
    applyFormula(
      sheet,
      `${column}${interestRows.other_unallocated_interest}`,
      `=IF($C$${c.circularity}=0,0,-$${["C", "D", "E"][index]}$${interestRows.other_unallocated_interest})`,
    );
    applyFormula(
      sheet,
      `${column}${interestRows.non_cash_interest}`,
      `=IF($C$${c.circularity}=0,0,-$${["C", "D", "E"][index]}$${interestRows.non_cash_interest})`,
    );
    applyFormula(
      sheet,
      `${column}${interestRows.gross_interest_expense}`,
      grossInterestFormula(column),
    );
    if (explicitCashBuckets) {
      for (const bucket of cashBucketPlans) {
        const openingBucketBalance =
          index === 0
            ? `I${bucket.balance_row}`
            : `${FORECAST_COLUMNS[index - 1]}${bucket.balance_row}`;
        applyFormula(
          sheet,
          `${column}${bucket.interest_row}`,
          `=IF($C$${c.circularity}=0,0,AVERAGE(${openingBucketBalance},${column}${bucket.balance_row})*` +
            `$D$${bucket.interest_row}*${column}${bucket.rate_row})`,
        );
      }
      applyFormula(
        sheet,
        `${column}${interestRows.interest_income_schedule}`,
        `=IF($C$${c.circularity}=0,0,SUM(${cashBucketPlans
          .map((bucket) => `${column}${bucket.interest_row}`)
          .join(",")}))`,
      );
    } else {
      const openingCash =
        index === 0
          ? `I${statementByRole.get("ending_cash").row}`
          : `${FORECAST_COLUMNS[index - 1]}${statementByRole.get("ending_cash").row}`;
      applyFormula(
        sheet,
        `${column}${interestRows.interest_income_schedule}`,
        `=IF($C$${c.circularity}=0,0,AVERAGE(${openingCash},${column}${statementByRole.get("ending_cash").row})*` +
          `$D$${interestRows.interest_income_schedule}*'Forward Curves'!${["F", "G", "H"][index]}${curveRows.cashYield})`,
      );
    }
    applyFormula(
      sheet,
      `${column}${interestRows.net_interest_expense}`,
      `=${column}${interestRows.gross_interest_expense}+${column}${interestRows.interest_income_schedule}`,
    );
    applyFormula(
      sheet,
      `${column}${interestRows.cash_interest_paid}`,
      `=${column}${interestRows.gross_interest_expense}-${column}${interestRows.non_cash_interest}` +
        nonCashInstrumentCellsFor(column)
          .map((cell) => `-${cell}`)
          .join(""),
    );
    applyFormula(
      sheet,
      `${column}${interestRows.cash_interest_received}`,
      `=${column}${interestRows.interest_income_schedule}`,
    );

    // Acquisition debt is a fixed drawing at a stated rate. Both its balance
    // and its coupon are written in the ADJUSTMENT block below, and pro forma
    // reads standalone plus that adjustment like every other line.
    const proFormaPriorRcf =
      index === 0
        ? `I${rcfPlan?.debt_row ?? waterfallRows.opening_rcf}`
        : `${PRO_FORMA_COLUMNS[index - 1]}${waterfallRows.ending_rcf}`;
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.rcf_interest}`,
      foreignRcf
        ? foreignRcfInterestFormula(
            proFormaPriorRcf,
            proFormaColumn,
            proFormaRcfRate,
          )
        : `=IF($C$${c.circularity}=0,0,-AVERAGE(${proFormaPriorRcf},${proFormaColumn}${waterfallRows.ending_rcf})*${proFormaRcfRate})`,
    );
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.rcf_commitment_fee}`,
      foreignRcf
        ? foreignRcfCommitmentFeeFormula(proFormaPriorRcf, proFormaColumn)
        : `=IF($C$${c.circularity}=0,0,-MAX(0,${rcfCapacityRef}-AVERAGE(${proFormaPriorRcf},${proFormaColumn}${waterfallRows.ending_rcf}))*$D$${interestRows.rcf_commitment_fee})`,
    );
    // PRO FORMA IS NOT "STANDALONE + ADJUSTMENT" HERE. Instrument interest
    // foots the pro-forma instrument rows, each of which reads the pro-forma
    // debt schedule; lease interest reads the pro-forma lease liability. Only
    // the two hand-entered plugs read across, because there is nothing in the
    // pro-forma debt schedule for them to link to.
    const proFormaInstrumentInterestCells = rowPlan.instruments
      .filter(
        (plan) =>
          !isBalancingRcf(modelCase, instrumentById.get(plan.instrument_id)),
      )
      .flatMap((plan) => [
        `${proFormaColumn}${plan.interest_row}`,
        ...(plan.pik_interest_row
          ? [`${proFormaColumn}${plan.pik_interest_row}`]
          : []),
      ]);
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.instrument_interest}`,
      sumCellFormula(proFormaInstrumentInterestCells),
    );
    const proFormaPriorLease =
      index === 0
        ? `R${leaseInterestBalanceRow}`
        : `${PRO_FORMA_COLUMNS[index - 1]}${leaseInterestBalanceRow}`;
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.lease_interest}`,
      leaseInterestFormula(
        proFormaPriorLease,
        `${proFormaColumn}${leaseInterestBalanceRow}`,
        index,
      ),
    );
    // Two hand-entered plugs. The transaction does not move either, so they are
    // an explicit zero in the adjustment column and plain A + B = C in the
    // pro-forma column — the same shape as everything around them, rather than
    // a read-across that happens to give the same answer.
    for (const id of ["other_unallocated_interest", "non_cash_interest"]) {
      applyFormula(sheet, `${adjustmentColumn}${interestRows[id]}`, "=0");
      applyFormula(
        sheet,
        `${proFormaColumn}${interestRows[id]}`,
        `=${column}${interestRows[id]}+${adjustmentColumn}${interestRows[id]}`,
      );
    }
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.gross_interest_expense}`,
      grossInterestFormula(proFormaColumn),
    );
    if (explicitCashBuckets) {
      for (const bucket of cashBucketPlans) {
        const proFormaOpeningBalance =
          index === 0
            ? `R${bucket.balance_row}`
            : `${PRO_FORMA_COLUMNS[index - 1]}${bucket.balance_row}`;
        applyFormula(
          sheet,
          `${proFormaColumn}${bucket.interest_row}`,
          `=IF($C$${c.circularity}=0,0,AVERAGE(${proFormaOpeningBalance},${proFormaColumn}${bucket.balance_row})*` +
            `$D$${bucket.interest_row}*${proFormaColumn}${bucket.rate_row})`,
        );
      }
      applyFormula(
        sheet,
        `${proFormaColumn}${interestRows.interest_income_schedule}`,
        `=IF($C$${c.circularity}=0,0,SUM(${cashBucketPlans
          .map((bucket) => `${proFormaColumn}${bucket.interest_row}`)
          .join(",")}))`,
      );
    } else {
      const proFormaOpeningCash =
        index === 0
          ? `R${statementByRole.get("ending_cash").row}`
          : `${PRO_FORMA_COLUMNS[index - 1]}${statementByRole.get("ending_cash").row}`;
      applyFormula(
        sheet,
        `${proFormaColumn}${interestRows.interest_income_schedule}`,
        `=IF($C$${c.circularity}=0,0,AVERAGE(${proFormaOpeningCash},${proFormaColumn}${statementByRole.get("ending_cash").row})*` +
          `$D$${interestRows.interest_income_schedule}*'Forward Curves'!${["F", "G", "H"][index]}${curveRows.cashYield})`,
      );
    }
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.net_interest_expense}`,
      `=${proFormaColumn}${interestRows.gross_interest_expense}+${proFormaColumn}${interestRows.interest_income_schedule}`,
    );
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.cash_interest_paid}`,
      `=${proFormaColumn}${interestRows.gross_interest_expense}-${proFormaColumn}${interestRows.non_cash_interest}` +
        nonCashInstrumentCellsFor(proFormaColumn)
          .map((cell) => `-${cell}`)
          .join(""),
    );
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.cash_interest_received}`,
      `=${proFormaColumn}${interestRows.interest_income_schedule}`,
    );
    // THE ADJUSTMENT INTEREST SCHEDULE, WRITTEN OUT.
    //
    // Every line below is the schedule's own arithmetic applied to the
    // ADJUSTMENT column's balances: interest on the incremental debt, the fee
    // released by the incremental revolver draw, income on the incremental
    // cash. Nothing here is a pro-forma figure with the standalone figure taken
    // off it, so a schedule the transaction does not reach foots to zero
    // because every constituent of it is zero.
    const adjustmentPriorRcf =
      index === 0
        ? "0"
        : `${ADJUSTMENT_COLUMNS[index - 1]}${waterfallRows.ending_rcf}`;
    const adjustmentInstrumentInterestCells = rowPlan.instruments
      .filter(
        (plan) =>
          !isBalancingRcf(modelCase, instrumentById.get(plan.instrument_id)),
      )
      .flatMap((plan) => [
        `${adjustmentColumn}${plan.interest_row}`,
        ...(plan.pik_interest_row
          ? [`${adjustmentColumn}${plan.pik_interest_row}`]
          : []),
      ]);
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.instrument_interest}`,
      sumCellFormula(adjustmentInstrumentInterestCells),
    );
    // The acquisition tranche's own coupon, off the acquisition debt row in the
    // adjustment column directly beside it.
    //
    // Existing acquisition debt earns a full year's coupon; a new draw earns
    // only the visible operating fraction for the close-year stub. Multiplying
    // an average balance by that fraction double-prorated the first year
    // (half-balance times half-year). State the two pieces directly instead.
    const priorAcquisitionDebtCell =
      index === 0
        ? "0"
        : `${ADJUSTMENT_COLUMNS[index - 1]}${debtRows.acquisition_debt}`;
    const acquisitionDraw = acquisitionDrawFormula(adjustmentColumn, rowPlan);
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.acquisition_interest}`,
      `=IF($C$${c.circularity}=0,0,-(${priorAcquisitionDebtCell}+` +
        `${acquisitionDraw}*${acquisitionFactorFormula(adjustmentColumn, rowPlan)})*` +
        `$P$${c.incremental_rate})`,
    );
    applyFormula(
      sheet,
      `${proFormaColumn}${interestRows.acquisition_interest}`,
      `=${column}${interestRows.acquisition_interest}+${adjustmentColumn}${interestRows.acquisition_interest}`,
    );
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.rcf_interest}`,
      foreignRcf
        ? `=IF($C$${c.circularity}=0,0,${proFormaColumn}${interestRows.rcf_interest}-${column}${interestRows.rcf_interest})`
        : `=IF($C$${c.circularity}=0,0,-AVERAGE(${adjustmentPriorRcf},${adjustmentColumn}${waterfallRows.ending_rcf})*${rcfRate})`,
    );
    // A commitment fee is charged on the UNDRAWN commitment, and it is a COST.
    // This cell used to state the incremental DRAWN balance times the fee rate,
    // with no leading minus — the wrong basis and the wrong sign at once, which
    // booked the revolver's commitment fee as income the moment the module was
    // switched on (+1.069 / +2.379 on Kingspan). Both halves below carry the
    // standalone column's own convention, `-MAX(0, commitment - average drawn)
    // x rate`, so the adjustment is the pro-forma fee less the standalone fee:
    // negative where the deal costs fee, positive only where a bigger draw
    // genuinely releases it, and exactly zero when the revolver is untouched.
    const undrawnFee = (priorColumnRef, balanceColumn) =>
      `MAX(0,${rcfCapacityRef}-AVERAGE(${priorColumnRef},${balanceColumn}${waterfallRows.ending_rcf}))` +
      `*$D$${interestRows.rcf_commitment_fee}`;
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.rcf_commitment_fee}`,
      foreignRcf
        ? `=IF($C$${c.circularity}=0,0,${proFormaColumn}${interestRows.rcf_commitment_fee}-${column}${interestRows.rcf_commitment_fee})`
        : `=IF($C$${c.circularity}=0,0,` +
          `-${undrawnFee(proFormaPriorRcf, proFormaColumn)}` +
          `+${undrawnFee(priorRcf, column)})`,
    );
    const adjustmentPriorLease =
      index === 0
        ? "0"
        : `${ADJUSTMENT_COLUMNS[index - 1]}${leaseInterestBalanceRow}`;
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.lease_interest}`,
      leaseInterestFormula(
        adjustmentPriorLease,
        `${adjustmentColumn}${leaseInterestBalanceRow}`,
        index,
      ),
    );
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.gross_interest_expense}`,
      grossInterestFormula(adjustmentColumn),
    );
    if (explicitCashBuckets) {
      for (const bucket of cashBucketPlans) {
        const adjustmentOpeningBalance =
          index === 0
            ? "0"
            : `${ADJUSTMENT_COLUMNS[index - 1]}${bucket.balance_row}`;
        applyFormula(
          sheet,
          `${adjustmentColumn}${bucket.interest_row}`,
          `=IF($C$${c.circularity}=0,0,AVERAGE(${adjustmentOpeningBalance},${adjustmentColumn}${bucket.balance_row})*` +
            `$D$${bucket.interest_row}*${column}${bucket.rate_row})`,
        );
      }
      applyFormula(
        sheet,
        `${adjustmentColumn}${interestRows.interest_income_schedule}`,
        `=IF($C$${c.circularity}=0,0,SUM(${cashBucketPlans
          .map((bucket) => `${adjustmentColumn}${bucket.interest_row}`)
          .join(",")}))`,
      );
    } else {
      const adjustmentOpeningCash =
        index === 0
          ? "0"
          : `${ADJUSTMENT_COLUMNS[index - 1]}${statementByRole.get("ending_cash").row}`;
      applyFormula(
        sheet,
        `${adjustmentColumn}${interestRows.interest_income_schedule}`,
        `=IF($C$${c.circularity}=0,0,AVERAGE(${adjustmentOpeningCash},${adjustmentColumn}${statementByRole.get("ending_cash").row})*` +
          `$D$${interestRows.interest_income_schedule}*'Forward Curves'!${["F", "G", "H"][index]}${curveRows.cashYield})`,
      );
    }
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.net_interest_expense}`,
      `=${adjustmentColumn}${interestRows.gross_interest_expense}+${adjustmentColumn}${interestRows.interest_income_schedule}`,
    );
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.cash_interest_paid}`,
      `=${adjustmentColumn}${interestRows.gross_interest_expense}-${adjustmentColumn}${interestRows.non_cash_interest}` +
        nonCashInstrumentCellsFor(adjustmentColumn)
          .map((cell) => `-${cell}`)
          .join(""),
    );
    applyFormula(
      sheet,
      `${adjustmentColumn}${interestRows.cash_interest_received}`,
      `=${adjustmentColumn}${interestRows.interest_income_schedule}`,
    );
  }

  // The immutable standardised authorities own the horizontal geometry.
  // Company-specific labels may expand the named vertical zones, but the A:U
  // grammar never widens to fit one case.
  const designGrammar = sharedHorizontalGrammar();
  const widths = designGrammar.widths;
  for (const [column, width] of Object.entries(widths)) {
    sheet.getRange(`${column}1:${column}${maxRow}`).format.columnWidth = width;
  }
  sheet.getRange(`A1:U${maxRow}`).format.rowHeight = 12.5;
  for (const row of Object.values(rowPlan.section_headers)) {
    sheet.getRange(`A${row}:U${row}`).format.rowHeight = 15;
  }
  sheet.freezePanes.freezeRows(designGrammar.freeze_pane.y_split);
  sheet.freezePanes.freezeColumns(designGrammar.freeze_pane.x_split);

  // ---------------------------------------------------------------------
  // BORDERS AS FRAMES, NOT GRID
  //
  // Every rule below either closes a run or draws a box round a panel. None of
  // them rules a cell on all four sides in the body, so
  // `borders.body_grid_forbidden` still holds. The gutter columns A, F, M and Q
  // are never touched: they stay white and unbordered, which is what makes the
  // four column blocks read as blocks.
  // ---------------------------------------------------------------------

  // Column-block left edges. J (standalone forecast) already existed; N
  // (adjustment) and S (pro forma) did not, so those two blocks had no left
  // edge at all and ran into the gutter beside them.
  for (const column of ["J", "N", "S"]) {
    sheet.getRange(
      `${column}${rowPlan.period_row}:${column}${rowPlan.visible_end_row}`,
    ).format.borders = { left: { style: "thin", color: COLORS.darkBorder } };
  }

  // The period header floated with nothing anchoring it. One rule per column
  // block, breaking at the gutters.
  for (const address of blockRanges(rowPlan.period_row, [
    "B:E",
    "G:L",
    "N:P",
    "R:U",
  ])) {
    sheet.getRange(address).format.borders = {
      ...blockLeftEdge(address),
      bottom: { style: "thin", color: COLORS.darkBorder },
    };
  }

  // The control block and the acquisition block are INPUT PANELS and should
  // read as panels. The box starts below the navy section band, so it frames
  // the entry fields rather than cutting through the header.
  // `bottomStyle` exists for one reason: a panel whose last row is an ANSWER
  // closes on that answer's DOUBLE rule. The RCF sweep ends on `ending_rcf`, and
  // a plain thin box bottom silently demoted it to an ordinary line — the box
  // would have been drawn at the cost of the one signal saying "this is the
  // figure you came for". The frame and the rank are not in competition: the
  // panel closes with the heavier of the two.
  const boxThin = (address, color, bottomStyle = "thin") => {
    sheet.getRange(address).format.borders = {
      top: { style: "thin", color },
      bottom: { style: bottomStyle, color },
      left: { style: "thin", color },
      right: { style: "thin", color },
    };
  };
  boxThin(
    `B${c.broker_case}:C${c.effective_minimum_cash}`,
    COLORS.darkBorder,
  );
  boxThin(
    `N${c.adjustments_enabled}:P${c.close_month}`,
    COLORS.darkBorder,
  );

  // PANELS. A box is this model's word for "this is one thing". The control
  // block and the acquisition block already use it; `panelBlocks` draws the same
  // box over a run of rows, breaking at the gutter columns A, F, M and Q exactly
  // as the rank rules do, so a panel is four frames across the sheet rather than
  // one band that crosses the gutters and turns the frames back into a grid.
  //
  // It spans B:E, not C:E — a panel that framed the numbers but left the labels
  // outside would be a box round half a section. The rank rules key off
  // NUMBER_BLOCKS and are a separate decision; this constant is deliberately its
  // own, so extending the rank rule to column B cannot silently move a panel
  // edge and moving a panel edge cannot silently extend a rank rule.
  const PANEL_BLOCKS = ["B:E", "G:L", "N:P", "R:U"];
  // A panel's header row is its title bar: the panel's own top edge is above it
  // and this rule closes it off from the body beneath. It is what lifts a BASIS
  // header above an ordinary sub-block header (Leases, Liquidity), which carry
  // fill and bold and nothing else and sit INSIDE a panel rather than opening
  // one.
  //
  // THE HEADER RULE IS DRAWN BEFORE THE BOX, ALWAYS. It is a partial border
  // assignment — bottom only — and a partial assignment silently clears the
  // RIGHT perimeter edge of the range it touches. Drawn after the box it took
  // the panel's right edge off the header row at E, L, P and U, which is the
  // same failure that once took the instrument-terms box apart at column E.
  // Verified by reading the emitted borders: with the rule first and the box
  // second, the header row carries top, bottom, left AND right.
  const panelHeaderRule = (row, color) => {
    if (!Number.isInteger(row)) return;
    for (const address of blockRanges(row, PANEL_BLOCKS)) {
      sheet.getRange(address).format.borders = {
        ...blockLeftEdge(address),
        bottom: { style: "thin", color },
      };
    }
  };
  const panelBlocks = (firstRow, lastRow, color, { headerRule = false } = {}) => {
    if (!Number.isInteger(firstRow) || !Number.isInteger(lastRow)) return false;
    if (lastRow < firstRow) return false;
    if (headerRule) panelHeaderRule(firstRow, color);
    // Through `carryThroughGutters` for the same reason `blockRanges` is: a
    // panel box that stopped at E and restarted at G would put a white slit
    // down the middle of the frame, in the one gutter that carries formatting
    // across, and the panel's own header rule (drawn through blockRanges) would
    // then overshoot the box it belongs to.
    // A panel that ends on an ANSWER closes on the answer's own double rule
    // rather than demoting it to a plain box bottom. `totalRanks` is the same
    // map `applyTotalHierarchy` reads, so the two can never disagree about which
    // row is an answer.
    const bottomStyle =
      totalRanks.get(lastRow) === TOTAL_RANK.ANSWER ? "double" : "thin";
    for (const pair of carryThroughGutters(PANEL_BLOCKS)) {
      const [first, last] = pair.split(":");
      boxThin(`${first}${firstRow}:${last}${lastRow}`, color, bottomStyle);
    }
    return true;
  };

  // Instrument terms C:E — currency, nominal, maturity on the debt schedule and
  // rate type, coupon or spread, benchmark on the interest schedule.
  //
  // These are STATIC CONTRACTUAL TERMS. Every column from G rightwards is a
  // PERIOD. That is the sharpest boundary in meaning anywhere on the sheet, and
  // it used to be marked by the LIGHTEST line in the workbook — a #BFBFBF box,
  // lighter than the J / N / S column-block edges, lighter than every rank rule.
  // A reader scanning left to right therefore hit the boundary without being
  // told. C:E is now treated as what it actually is: a COLUMN BLOCK, the same
  // kind of thing as G:L, N:P and R:U, with left and right edges in the same
  // thin dark grey those blocks carry, its own header rule, and centred fields.
  const termBlockEnd = (rows) => {
    const values = rows.filter((row) => Number.isFinite(Number(row)));
    return values.length ? Math.max(...values.map(Number)) : null;
  };
  const debtTermsEnd = termBlockEnd([
    ...(rowPlan.debt_groups ?? []).map((group) => group.subtotal_row),
    ...rowPlan.instruments.flatMap((plan) => [
      plan.debt_row,
      plan.issuance_row,
      plan.amortisation_row,
      plan.other_non_cash_row,
    ]),
  ]);
  const interestTermsEnd = termBlockEnd([
    ...(rowPlan.debt_groups ?? []).map((group) => group.interest_subtotal_row),
    ...rowPlan.instruments.map((plan) => plan.interest_row),
  ]);
  // Drawn below, AFTER the rank rules — see the note at the call.

  // A TERM IS A FIELD, NOT A DATA POINT. Centring the three headers and the
  // text and date fields beneath them is what separates the terms block from
  // the period blocks at a glance: every period column is right-aligned all the
  // way down because a magnitude is only comparable against the one above it,
  // whereas a currency code, a maturity, a rate type and a benchmark name are
  // labels on the instrument and read as a set when they are centred. The two
  // genuinely numeric terms — nominal amount and coupon — stay RIGHT, for the
  // same reason the period columns do.
  const centreTerms = (address) => {
    sheet.getRange(address).format.horizontalAlignment = "center";
  };

  // AN ATTRIBUTE IS NOT A STEP IN THE ARITHMETIC, SO IT SHOULD NOT READ LIKE ONE.
  //
  // C:E state what an instrument IS — its currency, its face value, when it
  // matures, what it is priced off. Every column from G rightwards states what
  // HAPPENS to it, period by period, and those columns are the left-to-right
  // flow the reader is meant to trace. The terms were upright Calibri 8 with the
  // same weight, and D carried the same `#,##0` format as every period column,
  // so a nominal amount in D was typographically indistinguishable from a
  // balance in J: three columns of static reference data competing with the grid
  // for the same attention, at the head of every row, all the way down the debt
  // and interest schedules. The box already drawn round C:E says where the
  // boundary IS; it cannot say which side of it matters more, which is why the
  // border alone left the block still reading as four more columns of model.
  //
  // Italic is the whole treatment, and it is the vocabulary this sheet already
  // uses for exactly this idea: a ratio row is italic because it is a READING of
  // the arithmetic rather than a term in it (see styleStatementRow). A contract
  // term is the same kind of thing one axis over. It recedes at a glance, costs
  // no colour, no fill and no palette entry, and stays perfectly legible — an
  // italic date is still a date.
  //
  // PARTIAL FONT ASSIGNMENT, and it has to be. Every one of these cells is a
  // hardcoded input carrying BLUE, and a few are formulas carrying black or
  // green. A full font object here would reset all of them to the default colour
  // and destroy the provenance of the entire terms block. `{ italic: true }`
  // merges, exactly as `{ bold: true }` does in applyTotalHierarchy, and
  // assertFormulaProvenance() — which also assigns partially, `{ color }` alone —
  // runs afterwards and reinstates the colours without disturbing the italic.
  const quietTerms = (address) => {
    sheet.getRange(address).format.font = { italic: true };
  };
  if (debtTermsEnd) {
    const head = rowPlan.debt_term_header_row;
    centreTerms(`C${head}:E${head}`);
    // Currency and maturity. D — nominal amount — is a magnitude and stays right.
    centreTerms(`C${head + 1}:C${debtTermsEnd}`);
    centreTerms(`E${head + 1}:E${debtTermsEnd}`);
    // The HEADER keeps its upright bold: it labels the block rather than sitting
    // inside it, and it is the one line in C:E that should hold the eye.
    quietTerms(`C${head + 1}:E${debtTermsEnd}`);
  }
  if (interestTermsEnd) {
    const head = rowPlan.interest_term_header_row;
    centreTerms(`C${head}:E${head}`);
    // Rate type and benchmark name. D — coupon / spread — is a rate and stays right.
    centreTerms(`C${head + 1}:C${interestTermsEnd}`);
    centreTerms(`E${head + 1}:E${interestTermsEnd}`);
    quietTerms(`C${head + 1}:E${interestTermsEnd}`);
  }

  // A section currently ends only because the next navy band begins. A thin
  // rule on its last row closes it without spending a spacer row.
  const sectionRows = Object.values(rowPlan.section_headers)
    .map(Number)
    .filter((row) => Number.isFinite(row))
    .sort((left, right) => left - right);
  sectionRows.forEach((headerRow, index) => {
    const next = sectionRows[index + 1];
    // The row plan leaves exactly one blank row before the next section band,
    // so the section's last content row is two above it.
    const lastRow = next ? next - 2 : maxRow;
    if (lastRow <= headerRow) return;
    // The last section closes on `maxRow`, which can sit BELOW the window the
    // column-block left edge spans, so the edge is only re-stated where it
    // already exists. Restating a perimeter is safe; extending one is not.
    const withinLeftEdge = lastRow <= rowPlan.visible_end_row;
    // A CLOSING RULE RUNS UNDER THE LABEL IT CLOSES.
    //
    // This used the default C-anchored number blocks, so a section closed with
    // a rule that began a column and a half to the right of its own last
    // label — under three empty term columns — and read as a line belonging to
    // the number block rather than to the section. It is the same defect
    // RANK_BLOCKS was introduced to fix, which was fixed for rank rows and
    // never for section closes. Epoch 3 anchors both at column B, so every
    // horizontal rule in the model starts in the same place.
    const closeBlocks = presentationEpoch() >= 3 ? RANK_BLOCKS : NUMBER_BLOCKS;
    for (const address of blockRanges(lastRow, closeBlocks)) {
      sheet.getRange(address).format.borders = {
        ...(withinLeftEdge ? blockLeftEdge(address) : {}),
        bottom: { style: "thin", color: COLORS.darkBorder },
      };
    }
  });

  // EVERY ROW THAT OPENS A SUB-SECTION, resolved from the compiled plan rather
  // than collected by the emitters that paint them. Physical rows are compiled
  // output, so the one place that knows them all is the plan itself: the
  // statement rows carry `style_role` / `row_type`, and the schedules name
  // their header rows directly. applyTotalHierarchy() needs the set to tell a
  // subtotal that closes a section from one that merely sits inside it.
  const subsectionRows = new Set(
    [
      // The same test styleStatementRow() uses to paint a row with the
      // subsection fill, so the two can never drift apart: whatever gets the
      // fill is what can collide with a subtotal's fill.
      ...Object.values(rowPlan.statement_rows ?? {}).flatMap((section) =>
        (section ?? [])
          .filter(
            (definition) =>
              definition.style_role === "subsection" ||
              definition.style_role === "header" ||
              definition.row_type === "header",
          )
          .map((definition) => definition.row),
      ),
      rowPlan.debt_term_header_row,
      rowPlan.interest_term_header_row,
      rowPlan.benchmark_row,
      ...(rowPlan.debt_groups ?? []).flatMap((group) => [
        group.header_row,
        group.interest_header_row,
      ]),
      ...Object.entries(rowPlan.debt_summary_rows ?? {})
        .filter(([id]) => id.endsWith("_header"))
        .map(([, row]) => row),
    ]
      .map(Number)
      .filter(Number.isFinite),
  );

  // Rank last, so it wins over the section-close rule where a section ends on
  // an answer (the RCF waterfall ends on `ending_rcf`, which takes the DOUBLE
  // bottom rule) and over any fill the input pass laid down on a subtotal whose
  // history is hardcoded.
  applyTotalHierarchy(
    sheet,
    totalRanks,
    uncalculatedRows,
    subsectionRows,
    headlineRows,
  );

  // ...and EVERY BOX after THAT, because a partial border assignment clears the
  // RIGHT edge of the range it is applied to. The rank rule spans C:E, so
  // drawing the box first and the rule second stripped the box's right edge at
  // column E off every subtotal row inside it — the box came apart exactly where
  // the eye follows it. Verified by reading the emitted borders, not by trusting
  // the call: with the box drawn last, E keeps both its right edge and the
  // rank's top rule. Every box below obeys the same ordering.
  //
  // The terms block's own header rule goes down BEFORE its box, for the reason
  // spelled out at `panelHeaderRule`. It is confined to C:E, because the terms
  // header row is a header for THREE COLUMNS, not for the sheet: ruling it
  // across G:U would put a line under empty cells and blur the very boundary
  // this treatment exists to draw.
  const termHeaderRule = (row) => {
    if (!Number.isInteger(row)) return;
    sheet.getRange(`C${row}:E${row}`).format.borders = {
      bottom: { style: "thin", color: COLORS.darkBorder },
    };
  };
  if (debtTermsEnd) {
    termHeaderRule(rowPlan.debt_term_header_row);
    boxThin(
      `C${rowPlan.debt_term_header_row}:E${debtTermsEnd}`,
      COLORS.darkBorder,
    );
  }
  if (interestTermsEnd) {
    termHeaderRule(rowPlan.interest_term_header_row);
    boxThin(
      `C${rowPlan.interest_term_header_row}:E${interestTermsEnd}`,
      COLORS.darkBorder,
    );
  }

  // ---------------------------------------------------------------------
  // TWO BASES, TWO PANELS
  //
  // The net-debt block used to distinguish the model basis from the company
  // basis with a label row and nothing else — and that label row was styled
  // identically to `Leases` and `Liquidity`, so the two BASES read as peers of
  // two SUB-BLOCKS. A reader had no way to see the split. Each basis is now a
  // panel: a box, exactly the device already used for the control block, the
  // acquisition block and the instrument terms, with a rule under its header.
  //
  // The company panel exists only when the case supplies named reconciling
  // items. On the five cases that supply none, there is one panel and its
  // header already says the company basis is the same. NO ROW OF ZEROS IS ADDED
  // TO MAKE A SECOND PANEL APPEAR.
  //
  // DEBT DYNAMICS — the decision, and why it is a formatting decision.
  // `total_change_in_debt` and `debt_fx_translation` stay INSIDE the model panel
  // and are NOT restated on a company basis. A cash movement and an FX
  // translation are movements of the model's own balances; the reconciling items
  // that separate the two bases are non-cash reclassifications and carrying-value
  // adjustments, held flat across the forecast, so a company-basis roll-forward
  // would repeat these two rows with a zero delta in every column — the exact
  // row-of-zeros bloat that was ruled out. Worse, `total_change_in_debt` is the
  // line the CASH FLOW reads: duplicating it would leave the reader two
  // candidate lines of which only one ties. One set of dynamics, inside the
  // panel that owns the balances they move, and a company panel whose header
  // says it is reconciled FROM that basis rather than computed beside it.
  // ---------------------------------------------------------------------
  const debtSummary = rowPlan.debt_summary_rows ?? {};
  const modelPanelEnd =
    debtSummary.debt_fx_translation ?? debtSummary.total_change_in_debt;
  panelBlocks(debtSummary.model_basis_header, modelPanelEnd, COLORS.darkBorder, {
    headerRule: true,
  });
  panelBlocks(
    debtSummary.company_reported_header,
    debtSummary.net_debt_company_reported_to_adjusted_ebitda,
    COLORS.darkBorder,
    { headerRule: true },
  );

  // The RCF / cash sweep is the third input-and-answer panel on the sheet and
  // was the only one of the three left unboxed. Like the control and
  // acquisition boxes it starts BELOW the navy section band, so it frames the
  // sweep rather than cutting through the section title.
  panelBlocks(
    waterfallRows?.cash_before_debt,
    waterfallRows?.ending_rcf,
    COLORS.darkBorder,
  );

  // `uncalculatedRows` is the SAME set applyTotalHierarchy() used to put the
  // permanent grey back, passed rather than recomputed so the two can never
  // disagree about which rows are already grey.
  applyConditionalState(sheet, rowPlan, {
    maxRow,
    waterfallRows,
    uncalculatedRows,
  });

  // A, M and Q are forced white LAST, so nothing above can tint them. F is
  // deliberately absent: it carries whatever its row carries (see
  // CARRY_THROUGH_GUTTERS). This line used to be here and was the mechanism
  // that cut every band and every rule in two at column F.
  sheet.getRange(`A1:A${maxRow}`).format.fill = COLORS.white;
  sheet.getRange(`M1:M${maxRow}`).format.fill = COLORS.white;
  sheet.getRange(`Q1:Q${maxRow}`).format.fill = COLORS.white;
}

/**
 * Resolve a worksheet part by SHEET NAME rather than by position.
 *
 * `xl/worksheets/sheet2.xml` is the Brokers sheet only for as long as nothing is
 * inserted ahead of it, and the part index is not the sheet order in any case —
 * it is whatever the writer happened to number the relationship. The name is the
 * only stable handle, and it is the one the parity validators already resolve by.
 */
async function worksheetPartByName(zip, sheetName) {
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip
    .file("xl/_rels/workbook.xml.rels")
    .async("string");
  const relationships = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) relationships.set(id, target);
  }
  for (const match of workbookXml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?>/g,
  )) {
    const name = /\bname="([^"]+)"/.exec(match[1])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1];
    if (!name || !rid) continue;
    const decoded = name
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    if (decoded !== sheetName) continue;
    const target = relationships.get(rid) ?? "";
    if (target.startsWith("/")) return target.slice(1);
    return target.startsWith("xl/") ? target : `xl/${target}`;
  }
  return null;
}

/**
 * THE BROKERS SHEET'S OWN CHROME: a frozen header and a collapsible panel per
 * metric.
 *
 * Both go the way the Operating Model's freeze and grouping went — whatever the
 * writer is told, nothing reaches the emitted XML — so both are written into the
 * package here, after every LibreOffice pass.
 *
 * The GROUPING is what makes the sheet answer a question it could not answer
 * before. Collapse it and every named house folds away, leaving one line per
 * metric — the answer the model is using — over its Consensus, High and Low.
 * That is the whole broker pack on one screen. Expand a metric and the houses
 * behind that one number come back. `summaryBelow="0"` puts the control on the
 * metric row itself, which is where the summary now lives; the reference groups
 * its broker rows exactly the same way.
 */
async function patchBrokersSheetChrome(xlsxPath, freezeRow, contributorRows) {
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const part = await worksheetPartByName(zip, "Brokers");
  if (!part || !zip.file(part)) return 0;
  let xml = await zip.file(part).async("string");
  const prefix = xml.match(/<([A-Za-z_][\w.-]*:)?worksheet\b/)?.[1] ?? "";
  const grouped = new Set(
    (contributorRows ?? []).map(Number).filter((row) => Number.isInteger(row) && row > 0),
  );
  let patched = 0;
  if (grouped.size > 0) {
    xml = xml.replace(
      new RegExp(`<${prefix}row\\b([^>]*?)(/?)>`, "g"),
      (match, attrs, selfClose) => {
        if (/\boutlineLevel=/.test(attrs)) return match;
        const reference = Number(attrs.match(/\br="(\d+)"/)?.[1]);
        if (!grouped.has(reference)) return match;
        patched += 1;
        return `<${prefix}row${attrs} outlineLevel="1"${selfClose}>`;
      },
    );
    if (patched > 0 && !/\boutlineLevelRow=/.test(xml)) {
      xml = xml.replace(
        new RegExp(`<${prefix}sheetFormatPr\\b([^>]*?)(/?)>`),
        (_m, attrs, selfClose) =>
          `<${prefix}sheetFormatPr${attrs} outlineLevelRow="1"${selfClose}>`,
      );
    }
    if (patched > 0 && !new RegExp(`<${prefix}outlinePr\\b`).test(xml)) {
      const outlinePr = `<${prefix}outlinePr summaryBelow="0" summaryRight="0"/>`;
      const selfClosingPr = new RegExp(`<${prefix}sheetPr\\b([^>]*)/>`);
      const openPr = new RegExp(`<${prefix}sheetPr\\b[^>]*>`);
      if (selfClosingPr.test(xml)) {
        xml = xml.replace(
          selfClosingPr,
          (_m, attrs) => `<${prefix}sheetPr${attrs}>${outlinePr}</${prefix}sheetPr>`,
        );
      } else if (openPr.test(xml)) {
        xml = xml.replace(openPr, (m) => `${m}${outlinePr}`);
      } else {
        xml = xml.replace(
          new RegExp(`(<${prefix}worksheet\\b[^>]*>)`),
          (_m, open) => `${open}<${prefix}sheetPr>${outlinePr}</${prefix}sheetPr>`,
        );
      }
    }
  }
  if (!new RegExp(`<${prefix}pane\\b`).test(xml)) {
    const pane =
      `<${prefix}pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" ` +
      `activePane="bottomLeft" state="frozen"/>`;
    const selfClosing = new RegExp(`<${prefix}sheetView\\b([^>]*)/>`);
    const open = new RegExp(`<${prefix}sheetView\\b([^>]*)>`);
    if (selfClosing.test(xml)) {
      xml = xml.replace(
        selfClosing,
        (_m, attrs) => `<${prefix}sheetView${attrs}>${pane}</${prefix}sheetView>`,
      );
    } else if (open.test(xml)) {
      xml = xml.replace(open, (m) => `${m}${pane}`);
    }
  }
  zip.file(part, xml);
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return patched;
}

/**
 * Inject the frozen pane directly into the worksheet part.
 *
 * sheet.freezePanes.freezeRows/freezeColumns never reaches the emitted XML —
 * no <pane> element survives export — so the delivered model scrolled 274 rows
 * with no row labels and no period header visible. Both the style tokens and
 * the Smurfit source require a freeze, so patch it in at the package level,
 * after every LibreOffice pass, per the skill's post-processing rule.
 */
async function patchFreezePane(xlsxPath, rowPlan) {
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!sheetFile) return false;
  let xml = await sheetFile.async("string");
  if (/<([A-Za-z_][\w.-]*:)?pane\b/.test(xml)) return false;
  const prefix = xml.match(/<([A-Za-z_][\w.-]*:)?worksheet\b/)?.[1] ?? "";
  // Freeze below the period header and to the right of the label/terms block,
  // so B:E and the year row stay visible while the period grid scrolls.
  const frozenRow = Number(rowPlan.period_row ?? 21);
  const pane =
    `<${prefix}pane xSplit="6" ySplit="${frozenRow}" ` +
    `topLeftCell="G${frozenRow + 1}" activePane="bottomRight" state="frozen"/>`;
  const selfClosing = new RegExp(`<${prefix}sheetView\\b([^>]*)/>`);
  const open = new RegExp(`<${prefix}sheetView\\b([^>]*)>`);
  if (selfClosing.test(xml)) {
    xml = xml.replace(
      selfClosing,
      (_m, attrs) =>
        `<${prefix}sheetView${attrs}>${pane}</${prefix}sheetView>`,
    );
  } else if (open.test(xml)) {
    xml = xml.replace(open, (m) => `${m}${pane}`);
  } else {
    return false;
  }
  zip.file("xl/worksheets/sheet1.xml", xml);
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return true;
}

/**
 * Inject row outline levels directly into the worksheet part.
 *
 * Grouping goes the way the frozen pane and format.indentLevel went: whatever
 * the writer is told, nothing reaches the emitted XML. The reviewer asked for
 * the run beneath every consolidated line to collapse, so the row plan decides
 * the levels and this writes them, the same package-level post-pass, after
 * every LibreOffice pass.
 *
 * summaryBelow="0" is not cosmetic: a consolidated line sits ABOVE its
 * constituents, and Excel puts the collapse control on the wrong side without
 * it. Other sections can declare groups through `rowPlan.outline_rows` rather
 * than reopening this pass.
 */
/**
 * WHICH ROWS GROUP, AND HOW DEEPLY — decided once.
 *
 * Both the package patch below and the plan the emitter now synthesises need
 * this answer, and two copies of it would be two definitions of "grouped" that
 * part company the first time either moves. The selection is the intent; where
 * it is applied is not.
 */
function rowOutlineLevels(rowPlan) {
  const levels = new Map();
  const note = (row, level) => {
    const target = Number(row);
    const depth = Number(level);
    if (!Number.isInteger(target) || target < 1) return;
    if (!Number.isFinite(depth) || depth < 1) return;
    levels.set(target, Math.max(levels.get(target) ?? 0, Math.min(depth, 7)));
  };
  for (const section of Object.values(rowPlan.statement_rows ?? {})) {
    for (const definition of section ?? []) {
      note(definition.row, definition.outline_level ?? 0);
    }
  }
  for (const entry of rowPlan.outline_rows ?? []) note(entry.row, entry.level);
  return levels;
}

async function patchRowOutlines(xlsxPath, rowPlan) {
  const levels = rowOutlineLevels(rowPlan);
  if (levels.size === 0) return 0;
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!sheetFile) return 0;
  let xml = await sheetFile.async("string");
  const prefix = xml.match(/<([A-Za-z_][\w.-]*:)?worksheet\b/)?.[1] ?? "";
  let patched = 0;
  xml = xml.replace(
    new RegExp(`<${prefix}row\\b([^>]*?)(/?)>`, "g"),
    (match, attrs, selfClose) => {
      if (/\boutlineLevel=/.test(attrs)) return match;
      const reference = Number(attrs.match(/\br="(\d+)"/)?.[1]);
      const level = levels.get(reference);
      if (!level) return match;
      patched += 1;
      return `<${prefix}row${attrs} outlineLevel="${level}"${selfClose}>`;
    },
  );
  if (patched === 0) return 0;
  const maxLevel = Math.max(...levels.values());
  if (!/\boutlineLevelRow=/.test(xml)) {
    xml = xml.replace(
      new RegExp(`<${prefix}sheetFormatPr\\b([^>]*?)(/?)>`),
      (_m, attrs, selfClose) =>
        `<${prefix}sheetFormatPr${attrs} outlineLevelRow="${maxLevel}"${selfClose}>`,
    );
  }
  if (!new RegExp(`<${prefix}outlinePr\\b`).test(xml)) {
    const outlinePr = `<${prefix}outlinePr summaryBelow="0" summaryRight="0"/>`;
    const selfClosingPr = new RegExp(`<${prefix}sheetPr\\b([^>]*)/>`);
    const openPr = new RegExp(`<${prefix}sheetPr\\b[^>]*>`);
    if (selfClosingPr.test(xml)) {
      xml = xml.replace(
        selfClosingPr,
        (_m, attrs) =>
          `<${prefix}sheetPr${attrs}>${outlinePr}</${prefix}sheetPr>`,
      );
    } else if (openPr.test(xml)) {
      xml = xml.replace(openPr, (m) => `${m}${outlinePr}`);
    } else {
      // sheetPr is the first child of worksheet in the schema order.
      xml = xml.replace(
        new RegExp(`<${prefix}worksheet\\b[^>]*>`),
        (m) => `${m}<${prefix}sheetPr>${outlinePr}</${prefix}sheetPr>`,
      );
    }
  }
  zip.file("xl/worksheets/sheet1.xml", xml);
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return patched;
}

/**
 * THE WORKBOOK DEFAULT FONT — `fonts[0]` — MUST BE A FONT EXCEL HAS.
 *
 * Every cell in this build names Calibri 8 explicitly, so it was easy to read
 * `fonts_referenced_by_cells = [Calibri]` and conclude the typography was
 * settled. It was not. `fonts[0]` is not merely the first entry in a list: it is
 * the workbook DEFAULT, the font `cellStyleXfs[0]` points at, and — the reason
 * it matters here — the font whose MAXIMUM DIGIT WIDTH defines the unit every
 * `<col width="...">` is expressed in. The writer emitted `Carlito 11`.
 *
 * Carlito is the metric-compatible clone LibreOffice substitutes FOR Calibri; it
 * is a Linux font, and Excel on Windows or macOS does not have it. Naming it as
 * the default means Excel resolves the width unit against whatever it falls back
 * to, so a column this file declares as 39 characters is 39 characters of some
 * other font's digit. No cell referenced it, which is exactly why it survived:
 * the defect is invisible to any check that only looks at the fonts cells USE.
 *
 * It is a rename and nothing else. Carlito and Calibri are metric-compatible by
 * construction — same advance widths, same max digit width of 7px at 11pt — so
 * every stored column width means the same number of points after this runs as
 * before it, which the build asserts below rather than assuming. `theme1.xml`
 * already declared Calibri as the minor font, so this also stops the package
 * contradicting its own theme.
 */
async function patchDefaultFont(xlsxPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const stylesFile = zip.file("xl/styles.xml");
  if (!stylesFile) return 0;
  const stylesXml = await stylesFile.async("string");
  const prefix = stylesXml.match(/<([A-Za-z_][\w.-]*:)?styleSheet\b/)?.[1] ?? "";
  const fonts = new RegExp(
    `(<${prefix}fonts\\b[^>]*>)([\\s\\S]*?)(</${prefix}fonts>)`,
  ).exec(stylesXml);
  if (!fonts) return 0;
  // Only the FIRST <font> — the default. Every other entry is a real cell font
  // and already says Calibri; a blanket replace would be indistinguishable from
  // this on today's package and would silently rewrite a deliberate choice on
  // tomorrow's.
  const first = new RegExp(
    `<${prefix}font\\b[^>]*/>|<${prefix}font\\b[^>]*>[\\s\\S]*?</${prefix}font>`,
  ).exec(fonts[2]);
  if (!first) return 0;
  const patchedFont = first[0].replace(
    new RegExp(`(<${prefix}name\\b[^>]*\\bval=")[^"]*(")`),
    `$1Calibri$2`,
  );
  if (patchedFont === first[0]) return 0;
  const patchedXml = stylesXml.replace(
    fonts[0],
    `${fonts[1]}${fonts[2].replace(first[0], patchedFont)}${fonts[3]}`,
  );
  zip.file("xl/styles.xml", patchedXml);
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return 1;
}

/**
 * Read back every stored column width, so the default-font rename can be
 * asserted rather than argued. Returns `{ "B": 39, ... }` per sheet, keyed by
 * the worksheet part name — the numbers are what Excel and LibreOffice both
 * multiply by the default font's digit width, so if the rename moved one of
 * them the build must not certify.
 */
async function worksheetColumnWidths(xlsxPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const widths = {};
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name).async("string");
    const perSheet = {};
    for (const match of xml.matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?col\b([^>]*)\/>/g,
    )) {
      const attrs = match[1];
      const min = Number(attrs.match(/\bmin="(\d+)"/)?.[1]);
      const max = Number(attrs.match(/\bmax="(\d+)"/)?.[1]);
      const width = attrs.match(/\bwidth="([^"]+)"/)?.[1];
      if (!Number.isFinite(min) || !Number.isFinite(max) || width === undefined) {
        continue;
      }
      for (let index = min; index <= max; index += 1) perSheet[index] = width;
    }
    widths[name] = perSheet;
  }
  return widths;
}

/**
 * Write REAL indentation — `alignment indent` — onto every label cell.
 *
 * `format.indentLevel` is the third formatting call this writer accepts and
 * discards, after the frozen pane and the row outlines: every one of the 85
 * `cellXfs` entries came out `indent="0"` however the emitter styled them. The
 * old workaround was two literal spaces inside the label string, which is
 * content pretending to be style — invisible to any restyle, and it made every
 * column-width measurement wrong by however deep the row sat.
 *
 * So the level is decided by the row plan and written here, into the package,
 * after the last LibreOffice pass has finished renumbering styles.xml:
 *
 *   1. read the style index each label cell already carries,
 *   2. clone that `xf` once per (style, level) pair actually in use, adding the
 *      alignment — cloning rather than mutating, because one `xf` is shared by
 *      rows sitting at different levels and mutating it would indent all of
 *      them,
 *   3. point the label cell at the clone.
 *
 * Nothing about a value, a formula or a cached result is touched. Every pattern
 * tolerates an optional namespace prefix: this build emits `<x:xf>`.
 */
/** How deep each label sits. One definition, two consumers — see `rowOutlineLevels`. */
function labelIndentLevels(rowPlan) {
  const levels = new Map();
  const note = (row, level) => {
    const target = Number(row);
    const depth = Number(level);
    if (!Number.isInteger(target) || target < 1) return;
    if (!Number.isFinite(depth) || depth < 1) return;
    levels.set(target, Math.max(levels.get(target) ?? 0, Math.min(depth, 15)));
  };
  for (const section of Object.values(rowPlan.statement_rows ?? {})) {
    for (const definition of section ?? []) note(definition.row, definition.indent);
  }
  for (const [row, level] of Object.entries(rowPlan.label_indents ?? {})) {
    note(row, level);
  }
  return levels;
}

async function patchLabelIndents(xlsxPath, rowPlan) {
  const levels = labelIndentLevels(rowPlan);
  if (levels.size === 0) return 0;

  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const stylesFile = zip.file("xl/styles.xml");
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!stylesFile || !sheetFile) return 0;
  let stylesXml = await stylesFile.async("string");
  let sheetXml = await sheetFile.async("string");

  const stylePrefix =
    stylesXml.match(/<([A-Za-z_][\w.-]*:)?styleSheet\b/)?.[1] ?? "";
  const cellXfs = new RegExp(
    `(<${stylePrefix}cellXfs\\b[^>]*>)([\\s\\S]*?)(</${stylePrefix}cellXfs>)`,
  ).exec(stylesXml);
  if (!cellXfs) return 0;
  const xfs =
    cellXfs[2].match(
      new RegExp(
        `<${stylePrefix}xf\\b[^>]*/>|<${stylePrefix}xf\\b[^>]*>[\\s\\S]*?</${stylePrefix}xf>`,
        "g",
      ),
    ) ?? [];
  if (xfs.length === 0) return 0;

  // An xf carries alignment as a child element, so a self-closing one has to be
  // opened up before it can hold any. `applyAlignment` is what makes Excel read
  // the child rather than inherit the cell style's.
  const openTag = new RegExp(`^<${stylePrefix}xf\\b[^>]*?(/?)>`);
  const alignmentTag = new RegExp(
    `<${stylePrefix}alignment\\b[^>]*/>|<${stylePrefix}alignment\\b[^>]*>[\\s\\S]*?</${stylePrefix}alignment>`,
  );
  const withIndent = (xf, depth) => {
    const open = openTag.exec(xf);
    if (!open) return xf;
    const selfClosing = open[1] === "/";
    const head = open[0]
      .replace(/\s+applyAlignment="[^"]*"/, "")
      .replace(/\s*\/?>$/, ' applyAlignment="1">');
    const body = selfClosing
      ? ""
      : xf.slice(open[0].length).replace(new RegExp(`</${stylePrefix}xf>$`), "");
    const existing = alignmentTag.exec(body);
    if (!existing) {
      return `${head}<${stylePrefix}alignment indent="${depth}"/>${body}</${stylePrefix}xf>`;
    }
    // Keep whatever else the alignment already says — horizontal, wrap — and
    // only speak to the indent.
    const aligned = /\bindent="\d+"/.test(existing[0])
      ? existing[0].replace(/\bindent="\d+"/, `indent="${depth}"`)
      : existing[0].replace(/\s*(\/?)>/, ` indent="${depth}"$1>`);
    return `${head}${body.replace(existing[0], aligned)}</${stylePrefix}xf>`;
  };

  const added = [];
  const variants = new Map();
  const variantFor = (baseIndex, depth) => {
    const key = `${baseIndex}:${depth}`;
    if (variants.has(key)) return variants.get(key);
    const base = xfs[baseIndex] ?? xfs[0];
    const index = xfs.length + added.length;
    added.push(withIndent(base, depth));
    variants.set(key, index);
    return index;
  };

  let patched = 0;
  // Built from the SHEET's own prefix, not the stylesheet's: the two parts are
  // separate documents and nothing guarantees they agree.
  const sheetPrefix =
    sheetXml.match(/<([A-Za-z_][\w.-]*:)?worksheet\b/)?.[1] ?? "";
  sheetXml = sheetXml.replace(
    new RegExp(`<${sheetPrefix}c\\b([^>]*)(/?)>`, "g"),
    (match, attrs, selfClose) => {
      const reference = attrs.match(/\br="B(\d+)"/)?.[1];
      if (!reference) return match;
      const depth = levels.get(Number(reference));
      if (!depth) return match;
      const baseIndex = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0);
      const index = variantFor(baseIndex, depth);
      patched += 1;
      const rewritten = /\bs="\d+"/.test(attrs)
        ? attrs.replace(/\bs="\d+"/, `s="${index}"`)
        : `${attrs} s="${index}"`;
      return `<${sheetPrefix}c${rewritten}${selfClose}>`;
    },
  );
  if (patched === 0 || added.length === 0) return 0;

  const body = `${cellXfs[2]}${added.join("")}`;
  const head = cellXfs[1].replace(
    /\bcount="\d+"/,
    `count="${xfs.length + added.length}"`,
  );
  stylesXml = stylesXml.replace(cellXfs[0], `${head}${body}${cellXfs[3]}`);

  zip.file("xl/styles.xml", stylesXml);
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return patched;
}

/**
 * Centre the three block titles across their blocks — WITHOUT MERGING.
 *
 * "Standalone", "Adjustment" and "Pro Forma" name a block of columns each and
 * sat flush left against its first column, so each one read as a label on that
 * single column rather than a heading over six, three and four of them.
 *
 * `horizontal="centerContinuous"` is the mechanism, and merging is not: a merge
 * would centre the text and destroy the row as a range in the process — sorting,
 * copying and every reference that crosses it. `layout.merged_calculation_cells_
 * forbidden` in the style tokens is the standing rule; this is the treatment
 * that honours it.
 *
 * It is patched at package level for the same reason the freeze pane, the row
 * outlines and the label indents are: `format.horizontalAlignment` is the
 * FOURTH formatting call this writer accepts and emits nothing for. The
 * emitted stylesheet carried not one `horizontal="..."` attribute before this
 * pass existed, with the call made correctly on every title cell — verified by
 * reading xl/styles.xml, never by trusting the API.
 *
 * Runs after every LibreOffice pass, and clones rather than mutates each `xf`,
 * because one xf is shared by thousands of cells.
 *
 * Nothing about a value, a formula or a cached result is touched. Every pattern
 * tolerates an optional namespace prefix: this build emits `<x:xf>`.
 */
/**
 * The runs the three block titles centre across.
 *
 * Each must be an unbroken run of centerContinuous cells with the text in its
 * leftmost one, and each must stop before the gutter: a run that crossed F, M
 * or Q would centre the title over the wrong span and put an alignment on a
 * column that carries nothing. One definition, two consumers — see
 * `rowOutlineLevels`.
 */
function blockTitleCells(rowPlan) {
  const row = Number(rowPlan.period_group_row);
  const targets = new Set();
  if (!Number.isInteger(row) || row < 1) return targets;
  for (const [first, last] of [["G", "L"], ["N", "P"], ["R", "U"]]) {
    for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
      targets.add(`${String.fromCharCode(code)}${row}`);
    }
  }
  return targets;
}

async function patchBlockTitleAlignment(xlsxPath, rowPlan) {
  const row = Number(rowPlan.period_group_row);
  if (!Number.isInteger(row) || row < 1) return 0;
  const targets = blockTitleCells(rowPlan);

  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const stylesFile = zip.file("xl/styles.xml");
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!stylesFile || !sheetFile) return 0;
  let stylesXml = await stylesFile.async("string");
  let sheetXml = await sheetFile.async("string");

  const stylePrefix =
    stylesXml.match(/<([A-Za-z_][\w.-]*:)?styleSheet\b/)?.[1] ?? "";
  const cellXfs = new RegExp(
    `(<${stylePrefix}cellXfs\\b[^>]*>)([\\s\\S]*?)(</${stylePrefix}cellXfs>)`,
  ).exec(stylesXml);
  if (!cellXfs) return 0;
  const xfs =
    cellXfs[2].match(
      new RegExp(
        `<${stylePrefix}xf\\b[^>]*/>|<${stylePrefix}xf\\b[^>]*>[\\s\\S]*?</${stylePrefix}xf>`,
        "g",
      ),
    ) ?? [];
  if (xfs.length === 0) return 0;

  const openTag = new RegExp(`^<${stylePrefix}xf\\b[^>]*?(/?)>`);
  const alignmentTag = new RegExp(
    `<${stylePrefix}alignment\\b[^>]*/>|<${stylePrefix}alignment\\b[^>]*>[\\s\\S]*?</${stylePrefix}alignment>`,
  );
  const withCentreContinuous = (xf) => {
    const open = openTag.exec(xf);
    if (!open) return xf;
    const selfClosing = open[1] === "/";
    const head = open[0]
      .replace(/\s+applyAlignment="[^"]*"/, "")
      .replace(/\s*\/?>$/, ' applyAlignment="1">');
    const body = selfClosing
      ? ""
      : xf.slice(open[0].length).replace(new RegExp(`</${stylePrefix}xf>$`), "");
    const existing = alignmentTag.exec(body);
    if (!existing) {
      return `${head}<${stylePrefix}alignment horizontal="centerContinuous"/>${body}</${stylePrefix}xf>`;
    }
    // Keep whatever else the alignment already says — indent, wrap — and only
    // speak to the horizontal.
    const aligned = /\bhorizontal="[^"]*"/.test(existing[0])
      ? existing[0].replace(/\bhorizontal="[^"]*"/, 'horizontal="centerContinuous"')
      : existing[0].replace(/\s*(\/?)>/, ' horizontal="centerContinuous"$1>');
    return `${head}${body.replace(existing[0], aligned)}</${stylePrefix}xf>`;
  };

  const added = [];
  const variants = new Map();
  const variantFor = (baseIndex) => {
    if (variants.has(baseIndex)) return variants.get(baseIndex);
    const base = xfs[baseIndex] ?? xfs[0];
    const index = xfs.length + added.length;
    added.push(withCentreContinuous(base));
    variants.set(baseIndex, index);
    return index;
  };

  let patched = 0;
  const sheetPrefix =
    sheetXml.match(/<([A-Za-z_][\w.-]*:)?worksheet\b/)?.[1] ?? "";
  sheetXml = sheetXml.replace(
    new RegExp(`<${sheetPrefix}c\\b([^>]*)(/?)>`, "g"),
    (match, attrs, selfClose) => {
      const reference = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!reference || !targets.has(reference)) return match;
      const baseIndex = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0);
      const index = variantFor(baseIndex);
      patched += 1;
      const rewritten = /\bs="\d+"/.test(attrs)
        ? attrs.replace(/\bs="\d+"/, `s="${index}"`)
        : `${attrs} s="${index}"`;
      return `<${sheetPrefix}c${rewritten}${selfClose}>`;
    },
  );
  if (patched === 0 || added.length === 0) return 0;

  const body = `${cellXfs[2]}${added.join("")}`;
  const head = cellXfs[1].replace(
    /\bcount="\d+"/,
    `count="${xfs.length + added.length}"`,
  );
  stylesXml = stylesXml.replace(cellXfs[0], `${head}${body}${cellXfs[3]}`);

  zip.file("xl/styles.xml", stylesXml);
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return patched;
}

/**
 * Attach provenance comments to every blue input cell, in one sweep.
 *
 * Comments were previously attached inside individual emission branches, so
 * cells written by the broker branch or into the adjustment / pro-forma
 * columns silently got none — an assumption sitting in the workbook with
 * nothing to say where it came from. Doing it once, after all statement cells
 * exist, means a future emission branch cannot bypass it.
 *
 * A cell qualifies only if it holds no formula: a formula explains itself.
 */
/**
 * MODEL COMMENTARY BELONGS IN A COMMENT, NOT IN A ROW.
 *
 * A row definition carrying `anchor_note` is a row whose CONSTRUCTION needs
 * explaining — currently only Adjusted EBITDA, which says which two broker
 * metrics anchor the forecast and which is derived. That sentence used to be a
 * visible row of its own in the middle of the income statement, explaining the
 * model's machinery in a section made entirely of the company's own figures.
 * It attaches to the LABEL cell, column B, because the note is about the whole
 * row rather than any one period.
 *
 * Generic on purpose: any row plan that sets `anchor_note` gets the same
 * treatment, so the next piece of commentary has somewhere to go that is not
 * the face of the model.
 */
function attachRowNotes(sheet, rowPlan, workbook) {
  const rows = [
    ...(rowPlan.statement_rows?.income_statement ?? []),
    ...(rowPlan.statement_rows?.cash_flow ?? []),
  ];
  let attached = 0;
  for (const definition of rows) {
    if (!definition.anchor_note || !Number.isInteger(definition.row)) continue;
    // A cell already carrying a comment keeps it; the note is not worth
    // destroying provenance for, and it is not worth a second card either.
    if (
      addCommentOnce(
        workbook,
        sheet,
        `B${definition.row}`,
        String(definition.anchor_note),
      )
    ) {
      attached += 1;
    }
  }
  return attached;
}

function attachInputProvenance(sheet, rowPlan, modelCase, workbook) {
  // Adjustment and pro-forma columns mirror the standalone period they sit
  // against, so they inherit that period's provenance.
  const COLUMN_PERIOD_INDEX = {
    G: 0, H: 1, I: 2,
    J: 3, K: 4, L: 5,
    N: 3, O: 4, P: 5,
    R: 2,
    S: 3, T: 4, U: 5,
  };
  const rows = [
    ...(rowPlan.statement_rows?.income_statement ?? []),
    ...(rowPlan.statement_rows?.cash_flow ?? []),
  ];
  let attached = 0;
  for (const definition of rows) {
    // DEFECT 0.11. A row the COMPILER injected has no entry in the case's
    // provenance map — the case never declared it — so it used to reach the
    // sheet as an unexplained blue zero. The compiler's own statement of why
    // the row exists and why it is nil is attached in the same channel, on
    // every historical cell, so the reader gets an answer where they look for
    // one instead of an unsourced hardcode.
    const entries =
      modelCase.provenance?.[definition.row_id] ??
      (definition.compiler_provenance
        ? [0, 1, 2].map((period_index) => ({
            ...definition.compiler_provenance,
            period_index,
          }))
        : null);
    if (!entries?.length) continue;
    for (const [column, periodIndex] of Object.entries(COLUMN_PERIOD_INDEX)) {
      const provenance = entries.find(
        (entry) => Number(entry.period_index) === periodIndex,
      );
      if (!provenance) continue;
      const address = `${column}${definition.row}`;
      const range = sheet.getRange(address);
      const formula = range.formulas?.[0]?.[0] ?? "";
      const value = range.values?.[0]?.[0];
      if (String(formula).startsWith("=")) continue; // derived, self-explaining
      if (value === null || value === undefined || value === "") continue;
      // A cell may already carry a comment from an emission branch; that is the
      // desired end state either way, so this sweep only fills the gaps. It is
      // not a duplicate that gets skipped — a duplicate never gets written.
      if (addCommentOnce(workbook, sheet, address, provenanceComment(provenance))) {
        attached += 1;
      }
    }
  }
  return attached;
}

// ---------------------------------------------------------------------------
// THE TWO FORMULA REWRITES, STATED ONCE.
//
// `patchWorkbookProperties` does not merely patch properties: it REWRITES
// FORMULAS. The adjustment gate wraps every N/O/P cell, and the R column is
// rewritten to `I{row}`. Both change the text that ships, so both are facts the
// L5 plan has to carry — and a plan emitted before them describes a workbook
// that does not exist.
//
// The rule each rewrite follows is therefore stated HERE, once, and read by two
// callers: the patch that applies it to the package, and the declaration the
// build asserts the shipped plan against. Two copies of "which rows are gated"
// is two definitions of the gate, and they would part company the first time
// either moved.
//
// The calcPr block is the third thing that pass writes and is a plain workbook
// property; it is declared alongside them so the plan's `calc_properties` is
// checked against the same literal the package gets.
// ---------------------------------------------------------------------------

const ADJUSTMENT_GATE_COLUMNS = ["N", "O", "P"];

function adjustmentGatePrefix(rowPlan) {
  return `IF($P$${rowPlan.controls.adjustments_enabled}=0,0,`;
}

/**
 * Rows the adjustment gate deliberately skips.
 *
 * Debt-group chrome (headers and subtotals) sums cells that are already gated,
 * so gating it again would double-wrap. An exchange rate is not a quantity the
 * acquisition adjusts: gating it would put a spurious "adjustment to FX" of
 * zero next to the rate and make the pro-forma rate read as a difference.
 */
function adjustmentGateExcludedRows(rowPlan) {
  return new Set([
    ...(rowPlan.debt_groups ?? []).flatMap((group) => [
      group.header_row,
      group.subtotal_row,
      group.interest_header_row,
      group.interest_subtotal_row,
    ]),
    ...Object.values(rowPlan.debt_fx_rows ?? {}),
  ]);
}

/** The face rows either rewrite is allowed to touch. */
function isRewritableFaceRow(rowPlan, row) {
  return row > rowPlan.period_row && row <= rowPlan.visible_end_row;
}

function declaredCalcProperties() {
  return workbookCalcProperties();
}

async function patchWorkbookProperties(
  xlsxPath,
  rowPlan,
) {
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) throw new Error("xl/workbook.xml is missing.");
  let workbookXml = await workbookFile.async("string");
  const workbookPrefix = workbookXml.match(
    /<([A-Za-z_][\w.-]*:)?workbook\b/,
  )?.[1] ?? "";
  const declaredCalc = declaredCalcProperties();
  const calcPr =
    `<${workbookPrefix}calcPr calcId="${declaredCalc.calc_id}" ` +
    `calcMode="${declaredCalc.calc_mode}" ` +
    `fullCalcOnLoad="${declaredCalc.full_calc_on_load ? 1 : 0}" ` +
    `forceFullCalc="${declaredCalc.force_full_calc ? 1 : 0}" ` +
    `iterate="${declaredCalc.iterate ? 1 : 0}" ` +
    `iterateCount="${declaredCalc.iterate_count}" ` +
    `iterateDelta="${declaredCalc.iterate_delta}"/>`;
  const calcPattern =
    /<(?:[A-Za-z_][\w.-]*:)?calcPr\b[^>]*\/>/;
  if (calcPattern.test(workbookXml)) {
    workbookXml = workbookXml.replace(calcPattern, calcPr);
  } else {
    workbookXml = workbookXml.replace(
      new RegExp(`</${workbookPrefix}workbook>`),
      `${calcPr}</${workbookPrefix}workbook>`,
    );
  }
  zip.file("xl/workbook.xml", workbookXml);
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  // DEFECT 0.12 — A PASS THAT VISITED NOTHING IS NOT A PASS. The adjustment
  // gate and the pro-forma-actual rewrite below are the two post-processing
  // passes the acquisition off-state depends on. They used to be wrapped in
  // `if (sheetFile)` and to run as silent no-ops if the pattern matched
  // nothing, which is exactly how a namespace-naive regex hides: the build
  // reports BUILT and the adjustment columns are simply never gated.
  if (!sheetFile) {
    throw new Error(
      "xl/worksheets/sheet1.xml is missing, so the adjustment-column gate and the pro-forma actual rewrite could not run.",
    );
  }
  {
    let xml = await sheetFile.async("string");
    let adjustmentCellsVisited = 0;
    let proFormaActualCellsVisited = 0;
    // The single adjustment-columns switch is applied here, once, to every
    // N/O/P and S/T/U cell on the face — rather than being remembered by each
    // emitter. Off means the adjustment columns are exactly zero and pro forma
    // returns standalone; the formula text is written in both states.
    const excludedRows = adjustmentGateExcludedRows(rowPlan);
    const adjustmentCellPattern =
      /<((?:[A-Za-z_][\w.-]*:)?c)\b([^>]*\br="([NOP])(\d+)"[^>/]*)>([\s\S]*?)<\/\1>/g;
    xml = xml.replace(
      adjustmentCellPattern,
      (fullMatch, cellTag, attributes, column, rowText, innerXml) => {
        const row = Number(rowText);
        adjustmentCellsVisited += 1;
        if (!isRewritableFaceRow(rowPlan, row) || excludedRows.has(row)) {
          return fullMatch;
        }
        const formulaPattern =
          /<((?:[A-Za-z_][\w.-]*:)?f)\b([^>]*)>([\s\S]*?)<\/\1>/;
        const formulaMatch = innerXml.match(formulaPattern);
        if (!formulaMatch) return fullMatch;
        const formula = formulaMatch[3];
        const gate = adjustmentGatePrefix(rowPlan);
        if (formula.startsWith(gate)) return fullMatch;
        const gatedFormula = `${gate}${formula})`;
        const updatedInnerXml = innerXml.replace(
          formulaPattern,
          () =>
            `<${formulaMatch[1]}${formulaMatch[2]}>${gatedFormula}</${formulaMatch[1]}>`,
        );
        return `<${cellTag}${attributes}>${updatedInnerXml}</${cellTag}>`;
      },
    );
    // The PRO-FORMA columns (S/T/U) are deliberately NOT gated. A pro-forma
    // cell reads `=J28+N28`: standalone plus adjustment, plain A + B = C, which
    // is what a reader checks by eye and what a reviewer expects to see in the
    // formula bar. Wrapping it as `IF($P$5=0,J28,J28+N28)` said the same thing
    // twice — the adjustment gate above already forces N/O/P to exactly zero
    // when the switch is off, so `J28+N28` ALREADY equals `J28` in the off
    // state. Pro forma inherits the off-state arithmetically; the switch lives
    // on the adjustment columns alone. Rows that LINK within the model or SUM
    // their own pro-forma components (interest off the pro-forma debt schedule,
    // block subtotals) keep the link/sum their emitter wrote — they were never
    // A + B = C rows, and nothing here flattens them into one.
    //
    // `[^>/]*` before the closing bracket keeps this pattern off SELF-CLOSING
    // cells. Allowing `/` let `<c r="R128" s="5"/>` match as an opening tag, so
    // the non-greedy body ran on to the next `</c>` and swallowed S128 whole —
    // the pro-forma FY1 balance came out as `=I128` (last actual) instead of
    // `=J128`, and the R cell was re-emitted malformed.
    const proFormaActualPattern =
      /<((?:[A-Za-z_][\w.-]*:)?c)\b([^>]*\br="R(\d+)"[^>/]*)>([\s\S]*?)<\/\1>/g;
    xml = xml.replace(
      proFormaActualPattern,
      (fullMatch, cellTag, attributes, rowText, innerXml) => {
        const row = Number(rowText);
        proFormaActualCellsVisited += 1;
        if (!isRewritableFaceRow(rowPlan, row)) return fullMatch;
        const formulaPattern =
          /<((?:[A-Za-z_][\w.-]*:)?f)\b([^>]*)>([\s\S]*?)<\/\1>/;
        const formulaMatch = innerXml.match(formulaPattern);
        if (!formulaMatch) return fullMatch;
        const updatedInnerXml = innerXml.replace(
          formulaPattern,
          () =>
            `<${formulaMatch[1]}${formulaMatch[2]}>I${row}</${formulaMatch[1]}>`,
        );
        return `<${cellTag}${attributes}>${updatedInnerXml}</${cellTag}>`;
      },
    );
    // Nothing on this sheet is hidden. The build used to bury a block of
    // mechanical rows below the interest schedule and hide them here; every
    // one of those calculations now sits on the face of the model, so strip
    // any hidden flag rather than setting one.
    xml = xml.replace(
      /<((?:[A-Za-z_][\w.-]*:)?row)\b([^>]*)>/g,
      (match, tagName, attrs) =>
        /\bhidden="1"/.test(attrs)
          ? `<${tagName}${attrs.replace(/\s+hidden="[^"]*"/g, "")}>`
          : match,
    );
    if (adjustmentCellsVisited === 0 || proFormaActualCellsVisited === 0) {
      throw new Error(
        "The worksheet post-processing passes matched no cells " +
          `(adjustment N/O/P: ${adjustmentCellsVisited}, pro-forma actual R: ${proFormaActualCellsVisited}). ` +
          "The workbook emits namespace-prefixed elements on some writers and bare ones on others; a scanner " +
          "that visits nothing is reporting the shape of its own regex, not the shape of the workbook.",
      );
    }
    zip.file("xl/worksheets/sheet1.xml", xml);
  }
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

function worksheetCellRecords(xml) {
  const records = new Map();
  const cellPattern =
    /<((?:[A-Za-z_][\w.-]*:)?c)\b(?![^>]*\/>)([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const match of xml.matchAll(cellPattern)) {
    const [, , attributes, innerXml] = match;
    const address = attributes.match(/\br="([A-Z]+\d+)"/)?.[1];
    if (!address) continue;
    const valueMatch = innerXml.match(
      /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/,
    );
    records.set(address, {
      has_formula: /<(?:[A-Za-z_][\w.-]*:)?f\b/.test(innerXml),
      type: attributes.match(/\bt="([^"]+)"/)?.[1] ?? null,
      has_value:
        Boolean(valueMatch) ||
        /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*\/>/.test(innerXml),
      value: valueMatch?.[1] ?? "",
    });
  }
  return records;
}

async function syncRecalculatedFormulaCaches(targetPath, recalculatedPath) {
  const targetZip = await JSZip.loadAsync(await fs.readFile(targetPath));
  const recalculatedZip = await JSZip.loadAsync(
    await fs.readFile(recalculatedPath),
  );
  let updated = 0;
  for (const worksheetPath of Object.keys(targetZip.files).filter((name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  )) {
    const targetFile = targetZip.file(worksheetPath);
    const recalculatedFile = recalculatedZip.file(worksheetPath);
    if (!targetFile || !recalculatedFile) continue;
    const recalculatedCells = worksheetCellRecords(
      await recalculatedFile.async("string"),
    );
    const targetXml = await targetFile.async("string");
    const cellPattern =
      /<((?:[A-Za-z_][\w.-]*:)?c)\b(?![^>]*\/>)([^>]*)>([\s\S]*?)<\/\1>/g;
    const updatedXml = targetXml.replace(
      cellPattern,
      (fullMatch, tagName, attributes, innerXml) => {
        const address = attributes.match(/\br="([A-Z]+\d+)"/)?.[1];
        const recalculated = address
          ? recalculatedCells.get(address)
          : null;
        if (
          !recalculated?.has_formula ||
          !recalculated.has_value ||
          !/<(?:[A-Za-z_][\w.-]*:)?f\b/.test(innerXml)
        ) {
          return fullMatch;
        }
        let updatedAttributes = attributes.replace(/\s+t="[^"]*"/, "");
        if (recalculated.type) {
          updatedAttributes += ` t="${recalculated.type}"`;
        }
        const prefix = tagName.includes(":")
          ? `${tagName.split(":")[0]}:`
          : "";
        const valueNode = `<${prefix}v>${recalculated.value}</${prefix}v>`;
        const valuePattern =
          /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?v>|<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*\/>/;
        const updatedInner = valuePattern.test(innerXml)
          ? innerXml.replace(valuePattern, valueNode)
          : `${innerXml}${valueNode}`;
        updated += 1;
        return `<${tagName}${updatedAttributes}>${updatedInner}</${tagName}>`;
      },
    );
    targetZip.file(worksheetPath, updatedXml);
  }
  await fs.writeFile(
    targetPath,
    await targetZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
  return updated;
}

/**
 * Every numeric cache currently sitting on the Operating Model sheet.
 *
 * Read AFTER the recalculation and BEFORE the solver patch, so what comes back
 * is the workbook's own answer for the columns the solver never restates — the
 * three historical years and the pro-forma historical year. Those columns are
 * the missing half of a year-on-year comparison: the solver walks the three
 * FORECAST periods and has no period -1 to hand the first of them, so anything
 * that looks backwards out of the first forecast column had nothing to look at.
 */
async function worksheetNumericCaches(xlsxPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const worksheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!worksheetFile) return new Map();
  const values = new Map();
  for (const [address, record] of worksheetCellRecords(
    await worksheetFile.async("string"),
  )) {
    if (!record.has_value || record.type === "s" || record.type === "str") {
      continue;
    }
    const numeric = Number(record.value);
    if (Number.isFinite(numeric)) values.set(address, numeric);
  }
  return values;
}

async function patchNumericFormulaCaches(xlsxPath, valuesByAddress) {
  const zip = await JSZip.loadAsync(await fs.readFile(xlsxPath));
  const worksheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!worksheetFile) {
    throw new Error("xl/worksheets/sheet1.xml is missing.");
  }
  const cellPattern =
    /<((?:[A-Za-z_][\w.-]*:)?c)\b(?![^>]*\/>)([^>]*)>([\s\S]*?)<\/\1>/g;
  let patched = 0;
  const xml = await worksheetFile.async("string");
  const updated = xml.replace(
    cellPattern,
    (fullMatch, tagName, attributes, innerXml) => {
      const address = attributes.match(/\br="([A-Z]+\d+)"/)?.[1];
      if (
        !address ||
        !valuesByAddress.has(address) ||
        !/<(?:[A-Za-z_][\w.-]*:)?f\b/.test(innerXml)
      ) {
        return fullMatch;
      }
      const numericValue = Number(valuesByAddress.get(address));
      if (!Number.isFinite(numericValue)) return fullMatch;
      const prefix = tagName.includes(":")
        ? `${tagName.split(":")[0]}:`
        : "";
      const valueNode = `<${prefix}v>${numericValue}</${prefix}v>`;
      const valuePattern =
        /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?v>|<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*\/>/;
      const updatedInner = valuePattern.test(innerXml)
        ? innerXml.replace(valuePattern, valueNode)
        : `${innerXml}${valueNode}`;
      patched += 1;
      return `<${tagName}${attributes.replace(/\s+t="[^"]*"/, "")}>${updatedInner}</${tagName}>`;
    },
  );
  zip.file("xl/worksheets/sheet1.xml", updated);
  await fs.writeFile(
    xlsxPath,
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
  return patched;
}

function forecastInput(modelCase, definition, forecastIndex) {
  // Callers use an empty definition only for an optional semantic channel that
  // does not exist in the compiled statement.  No workbook row is being
  // forecast in that state, so zero is the neutral internal contribution — it
  // is not the forbidden fallback that writes `=0` into an unresolved row.
  if (
    !definition?.row_id &&
    !definition?.semantic_role &&
    !definition?.broker_metric_id
  ) {
    return 0;
  }
  const authority = resolveForecastAuthority(
    modelCase,
    definition,
    forecastIndex,
  );
  if (authority.mechanism === "block") {
    throw new Error(
      `Unresolved forecast authority for ${definition.row_id} in forecast period ${forecastIndex + 1}: ${authority.reason ?? authority.method}.`,
    );
  }
  if (authority.mechanism === "uncalculated" || authority.mechanism === "zero") {
    return 0;
  }
  if (authority.mechanism === "broker" && authority.broker_value !== null) {
    return Number(authority.broker_value);
  }
  if (authority.mechanism === "hardcode" && authority.value !== null) {
    return Number(authority.value);
  }
  const metric = definition.broker_metric_id
    ? modelCase.broker_pack.metrics?.[definition.broker_metric_id]
    : null;
  const selectedBroker = modelCase.controls.broker_case;
  let value = null;
  if (
    selectedBroker &&
    !["Consensus", "High", "Low"].includes(selectedBroker)
  ) {
    value = metric?.brokers?.[selectedBroker]?.[forecastIndex];
  }
  if (value === null || value === undefined) {
    value = metric?.provider_consensus?.[forecastIndex];
  }
  if (value === null || value === undefined) {
    value = rowValues(modelCase, definition)[forecastIndex + 3];
  }
  if (value === null || value === undefined) {
    throw new Error(
      `Forecast authority ${authority.method} for ${definition.row_id} did not resolve a value in forecast period ${forecastIndex + 1}.`,
    );
  }
  return Number(value);
}

function genericNumericValue(
  definition,
  valuesById,
  priorValuesById,
  calculationOverride = null,
) {
  const calculation = calculationOverride ?? definition.calculation;
  if (!calculation) return null;
  const values = calculation.refs.map((id) => Number(valuesById.get(id) ?? 0));
  if (calculation.operator === "sum") {
    return values.reduce((sum, value) => sum + value, 0);
  }
  if (calculation.operator === "link") return values[0] ?? 0;
  if (calculation.operator === "subtract") {
    return values.slice(1).reduce((value, item) => value - item, values[0] ?? 0);
  }
  if (calculation.operator === "negate") return -(values[0] ?? 0);
  if (calculation.operator === "negate_sum") {
    return -values.reduce((sum, value) => sum + value, 0);
  }
  if (calculation.operator === "ratio") {
    return values[1] === 0 ? 0 : values[0] / values[1];
  }
  if (calculation.operator === "negated_ratio") {
    return values[1] === 0 ? 0 : -values[0] / values[1];
  }
  if (calculation.operator === "growth") {
    const current = values[0] ?? 0;
    const prior = Number(
      priorValuesById?.get(calculation.refs[0]) ?? 0,
    );
    return prior === 0 ? 0 : current / prior - 1;
  }
  if (calculation.operator === "tax") {
    return values[0] > 0 ? -values[0] * values[1] : 0;
  }
  if (calculation.operator === "prior_period") {
    return Number(priorValuesById?.get(calculation.refs[0]) ?? 0);
  }
  if (calculation.operator === "prior_period_scaled_by") {
    const priorValue = Number(
      priorValuesById?.get(calculation.refs[0]) ?? 0,
    );
    const currentDriver = Number(valuesById.get(calculation.refs[1]) ?? 0);
    const priorDriver = Number(
      priorValuesById?.get(calculation.refs[1]) ?? 0,
    );
    return priorDriver === 0
      ? 0
      : priorValue * currentDriver / priorDriver;
  }
  if (calculation.operator === "average") {
    return values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (calculation.operator === "historical_average") {
    const history = (definition.values ?? []).slice(0, 3).filter(
      (value) => value !== null && value !== undefined && Number.isFinite(Number(value)),
    ).map(Number);
    return history.length === 0
      ? 0
      : history.reduce((sum, value) => sum + value, 0) / history.length;
  }
  if (calculation.operator === "historical_trend") {
    const history = (definition.values ?? []).slice(0, 3).map(Number);
    if (history.length !== 3 || history.some((value) => !Number.isFinite(value))) return 0;
    const slope = ((history[1] - history[0]) + (history[2] - history[1])) / 2;
    return history[2] + slope * (Number(calculation.forecast_index ?? 0) + 1);
  }
  return null;
}

function statementSolverValues(
  modelCase,
  rowPlan,
  solution,
  forecastIndex,
  previousValues,
  acquisitionBaseValues = null,
) {
  const result = solution.forecast[forecastIndex];
  const cashBuckets = normalisedCashBuckets(modelCase);
  const explicitCashBuckets = Array.isArray(modelCase.cash_policy?.buckets);
  const balancingOpeningCash =
    forecastIndex === 0
      ? Number(
          cashBuckets.find(
            (bucket) => bucket.forecast_treatment === "balancing",
          ).opening_balance ??
            cashBuckets.find(
              (bucket) => bucket.forecast_treatment === "balancing",
            ).historical_year_end[2],
        )
      : Number(solution.forecast[forecastIndex - 1].ending_cash);
  const cashFlowOpeningCash = explicitCashBuckets
    ? forecastIndex === 0
      ? cashBuckets.reduce(
          (sum, bucket) =>
            sum +
            (bucket.included_in_cash_flow_cash !== false
              ? Number(bucket.historical_year_end[2] ?? 0)
              : 0),
          0,
        )
      : Number(solution.forecast[forecastIndex - 1].cash_flow_cash)
    : balancingOpeningCash;
  const cashFlowEndingCash = explicitCashBuckets
    ? Number(result.cash_flow_cash)
    : Number(result.ending_cash);
  const nonBalancingCashBucketMovement = explicitCashBuckets
    ? (result.cash_bucket_balances ?? [])
        .filter(
          (bucket) =>
            cashBuckets.find(
              (definition) => definition.bucket_id === bucket.bucket_id,
            )?.forecast_treatment !== "balancing" &&
            cashBuckets.find(
              (definition) => definition.bucket_id === bucket.bucket_id,
            )?.included_in_cash_flow_cash !== false,
        )
        .reduce(
          (sum, bucket) =>
            sum +
            Number(bucket.ending_balance ?? 0) -
            Number(bucket.opening_balance ?? 0),
          0,
        )
    : 0;
  const otherInvesting = Number(
    modelCase.operating_metrics?.other_investing?.values?.[
      forecastIndex + 3
    ] ??
      modelCase.forecast_assumptions?.other_investing?.[forecastIndex] ??
      0,
  );
  const cashFromFinancing =
    result.financing_before_mandatory -
    result.non_rcf_repayment -
    result.lease_principal +
    result.rcf_draw -
    result.rcf_repayment;
  const semantic = new Map([
    ["revenue", result.revenue],
    ["ebit", result.ebit],
    ["interest_income", result.interest_income],
    ["interest_expense", -result.gross_interest],
    ["pre_tax_income", result.pre_tax_income],
    [
      "effective_tax_rate",
      result.pre_tax_income > 0 ? result.tax / result.pre_tax_income : 0,
    ],
    ["tax_expense", -result.tax],
    ["net_income", result.net_income],
    [
      "depreciation_and_amortisation",
      result.depreciation_and_amortisation,
    ],
    ["adjusted_ebitda", result.adjusted_ebitda],
    [
      "recurring_disclosed_adjustments",
      forecastInput(
        modelCase,
        rowPlan.statement_rows.income_statement.find(
          (row) =>
            row.semantic_role === "recurring_disclosed_adjustments",
        ) ?? {},
        forecastIndex,
      ),
    ],
    [
      "cash_flow_da",
      result.depreciation_and_amortisation,
    ],
    [
      "non_cash_interest_addback",
      result.non_cash_interest + result.non_cash_instrument_interest,
    ],
    [
      "other_non_cash",
      Number(
        modelCase.operating_metrics?.other_non_cash?.values?.[
          forecastIndex + 3
        ] ??
          modelCase.forecast_assumptions?.other_non_cash?.[forecastIndex] ??
          0,
      ),
    ],
    ["change_in_working_capital", result.change_in_working_capital],
    ["cash_from_operations", result.cash_from_operations],
    ["capex", result.capex],
    ["other_investing", otherInvesting],
    ["cash_from_investing", result.cash_from_investing],
    ["debt_issuance", result.non_rcf_issuance],
    ["debt_repayment", -result.non_rcf_repayment],
    // The consolidated line is no longer the sum of the rows beneath it — they
    // are all n/a on a forecast basis — so the solver has to be told what it
    // holds, or it reads the blank constituents and caches a zero on the
    // headline debt movement. It is the whole CASH debt movement: scheduled
    // draws and repayments plus both revolver legs. The acquisition overlay is
    // deliberately a non-cash balance addition and is excluded.
    [
      "change_in_debt",
      result.non_rcf_issuance -
        result.non_rcf_repayment +
        result.rcf_draw -
        result.rcf_repayment,
    ],
    ["rcf_draw", result.rcf_draw],
    ["rcf_repayment", -result.rcf_repayment],
    ["lease_principal", -result.lease_principal],
    [
      "dividends",
      -Math.abs(
        forecastInput(
          modelCase,
          rowPlan.statement_rows.cash_flow.find(
            (row) => row.semantic_role === "dividends",
          ) ?? {},
          forecastIndex,
        ),
      ),
    ],
    [
      "share_buybacks",
      -Math.abs(
        forecastInput(
          modelCase,
          rowPlan.statement_rows.cash_flow.find(
            (row) => row.semantic_role === "share_buybacks",
          ) ?? {},
          forecastIndex,
        ),
      ),
    ],
    ["cash_from_financing", cashFromFinancing],
    [
      "non_balancing_cash_bucket_movement",
      nonBalancingCashBucketMovement,
    ],
    ["fx_effect_on_cash", result.fx_effect_on_cash],
    [
      "net_change_in_cash",
      cashFlowEndingCash - cashFlowOpeningCash - result.fx_effect_on_cash,
    ],
    ["opening_cash", cashFlowOpeningCash],
    ["ending_cash", cashFlowEndingCash],
  ]);
  for (const [role, value] of [
    [
      "cash_interest_paid",
      -(
        result.gross_interest -
        result.non_cash_interest -
        result.non_cash_instrument_interest
      ),
    ],
    ["cash_interest_received", result.interest_income],
  ]) {
    const definition = rowPlan.statement_rows.cash_flow.find(
      (row) => row.semantic_role === role,
    );
    if (
      definition &&
      (forecastCalculationForIndex(definition, forecastIndex) ||
        (definition.forecast_treatment === "formula" &&
          definition.calculation))
    ) {
      semantic.set(role, value);
    }
  }
  const definitions = [
    ...rowPlan.statement_rows.income_statement,
    ...rowPlan.statement_rows.cash_flow,
  ];
  const definitionsById = new Map(
    definitions.map((definition) => [definition.row_id, definition]),
  );
  const valuesById = new Map();
  for (const definition of definitions) {
    const solverRole =
      definition.acquisition_driver_role ?? definition.semantic_role;
    const periodRulesDeclared = hasForecastPeriodCalculations(definition);
    const activeCalculation =
      forecastCalculationForIndex(definition, forecastIndex) ??
      (periodRulesDeclared ||
      ["broker", "hardcode", "zero", "uncalculated"].includes(
        definition.forecast_treatment,
      )
        ? null
        : definition.calculation);
    // A visible aggregate formula is the one authoritative writer for its
    // cached subtotal. Solver summaries may seed schedule-owned links and
    // independent inputs, but they must not supply a second answer for a SUM.
    // Otherwise an issuer-specific component can be present in the cell
    // formula yet absent from the solver summary, so the displayed value
    // changes on the first native recalculation. Leave aggregate rows
    // unresolved here; resolve() below evaluates the same dependency graph
    // that emitted the workbook formula. Link, schedule, circular and other
    // specialised formulas retain their explicit semantic cache authority.
    const visibleAggregateOwnsCache =
      solverRole === "cash_from_financing" &&
      activeCalculation?.operator === "sum";
    let value = solverRole && !visibleAggregateOwnsCache
      ? semantic.get(solverRole)
      : undefined;
    if (value !== undefined && value !== null) {
      valuesById.set(definition.row_id, Number(value));
    }
  }
  // Period-specific forecast chains remain standalone in the acquisition
  // overlay. Seed them before resolving links and subtotals so dependants (for
  // example a cash-flow link to an income-statement input) inherit the same
  // zero-adjustment value rather than an acquisition-scaled cache.
  if (acquisitionBaseValues) {
    for (const definition of definitions) {
      if (
        hasForecastPeriodCalculations(definition) &&
        acquisitionBaseValues.has(definition.row_id)
      ) {
        valuesById.set(
          definition.row_id,
          Number(acquisitionBaseValues.get(definition.row_id)),
        );
      }
    }
  }
  const visiting = new Set();
  function resolve(rowId) {
    if (valuesById.has(rowId)) return valuesById.get(rowId);
    if (visiting.has(rowId)) {
      throw new Error(`Statement cache dependency cycle at ${rowId}.`);
    }
    const definition = definitionsById.get(rowId);
    if (!definition) return 0;
    visiting.add(rowId);
    // A row whose forecast is supplied (broker/hardcode/zero) or intentionally
    // blank must NOT fall back to its historical calculation here. Rows whose
    // dependency direction reverses between history and forecast — share-based
    // compensation links one way in history and the other in the forecast —
    // otherwise resolve into a false cycle. Mirrors the coverage-gate logic.
    const periodRulesDeclared = hasForecastPeriodCalculations(definition);
    const periodCalculation = forecastCalculationForIndex(
      definition,
      forecastIndex,
    );
    // Certificate rule, identical to resolveForecastAuthority and the
    // solver's forecastRule: an "uncalculated" treatment suppresses the
    // declared calculation only when the capture transition certified it or
    // the row is structurally uncalculated. An identity row authored grey
    // without proof keeps its identity in the cache exactly as in the cell.
    const uncertifiedIdentityGrey =
      definition.forecast_treatment === "uncalculated" &&
      definition.row_type !== "uncalculated" &&
      !definition.forecast_capture_parent_id &&
      Boolean(definition.calculation);
    const treatmentSuppressesCalculation =
      ["broker", "hardcode", "zero", "uncalculated"].includes(
        definition.forecast_treatment,
      ) && !uncertifiedIdentityGrey;
    const calculation =
      periodCalculation ??
      (periodRulesDeclared || treatmentSuppressesCalculation
        ? null
        : definition.calculation);
    // Mirrors the cell writer: the first forecast period is the hold-flat
    // chain's ANCHOR and takes the row's own forecast input. Reading the prior
    // period here reached back into a column this solver never computes, so the
    // cache came back 0 while the cell beside it said `=I{row}` — the two
    // disagreed and the number changed the moment Excel recalculated.
    const carryAnchor =
      forecastIndex === 0 &&
      !periodRulesDeclared &&
      !definition.forecast_calculation &&
      isSelfCarry(definition, calculation);
    let value;
    if (carryAnchor) {
      value = forecastInput(modelCase, definition, forecastIndex);
    } else if (calculation) {
      const dependencyValues = new Map(valuesById);
      // prior_period reads the PREVIOUS column, which is already solved.
      // Resolving its ref in this column would recurse into the row itself
      // (flat carry) and report a false cycle.
      if (calculation.operator !== "prior_period") {
        const currentPeriodRefs =
          calculation.operator === "prior_period_scaled_by"
            ? calculation.refs.slice(1)
            : calculation.refs;
        for (const reference of currentPeriodRefs) {
          dependencyValues.set(reference, resolve(reference));
        }
      }
      value = genericNumericValue(
        definition,
        dependencyValues,
        previousValues,
        calculation,
      );
    } else {
      value = forecastInput(modelCase, definition, forecastIndex);
      if (
        ["capex", "dividends", "share_buybacks"].includes(
          definition.semantic_role,
        )
      ) {
        value = -Math.abs(value);
      }
    }
    visiting.delete(rowId);
    valuesById.set(rowId, Number(value ?? 0));
    return valuesById.get(rowId);
  }
  for (const definition of definitions) resolve(definition.row_id);
  return valuesById;
}

function solverFormulaCaches(
  modelCase,
  rowPlan,
  standaloneSolution,
  proFormaSolution,
  workbookCaches = null,
) {
  const caches = new Map();
  // THE FIRST FORECAST YEAR HAS A PRIOR YEAR, AND IT IS ON THE SHEET.
  //
  // This loop hands each period the previous period's solved values so that a
  // backward-looking row — `growth`, and any non-self `prior_period` — can be
  // valued. Period 0 used to be handed `null`, because the solver's own horizon
  // starts at the first forecast year. But the CELL does not: `J40` reads
  // `=IFERROR(J38/I38-1,0)` straight back into the last historical column, and
  // `S40` reads back into the pro-forma historical column. With no prior map the
  // `growth` branch took `prior = 0` and returned its zero-denominator answer,
  // so the workbook shipped a cached growth rate of 0 next to a formula that
  // evaluates to 2.8% — invisible until something recalculated.
  //
  // The prior period is seeded from the WORKBOOK'S OWN CACHES for the column the
  // formula actually points at, not from a second evaluation of the case. Those
  // columns were recalculated a moment ago and the solver never overwrites them,
  // so the cache this produces is the number the formula returns BY
  // CONSTRUCTION, rather than a reimplementation that has to be kept in step
  // with how history is emitted.
  const priorColumnValues = (forecastColumn) => {
    const column = previousColumn(forecastColumn);
    if (!column || !workbookCaches) return null;
    const values = new Map();
    for (const definition of [
      ...rowPlan.statement_rows.income_statement,
      ...rowPlan.statement_rows.cash_flow,
    ]) {
      const cached = workbookCaches.get(`${column}${definition.row}`);
      if (cached !== undefined) values.set(definition.row_id, cached);
    }
    return values;
  };
  let priorStandalone = priorColumnValues(FORECAST_COLUMNS[0]);
  let priorProForma = priorColumnValues(PRO_FORMA_COLUMNS[0]);
  const instrumentById = new Map(
    modelCase.instruments.map((instrument) => [
      instrument.instrument_id,
      instrument,
    ]),
  );
  for (let index = 0; index < 3; index += 1) {
    const standalone = standaloneSolution.forecast[index];
    const proForma = proFormaSolution.forecast[index];
    const standaloneValues = statementSolverValues(
      modelCase,
      rowPlan,
      standaloneSolution,
      index,
      priorStandalone,
    );
    const proFormaValues = statementSolverValues(
      modelCase,
      rowPlan,
      proFormaSolution,
      index,
      priorProForma,
      standaloneValues,
    );
    const standaloneColumn = FORECAST_COLUMNS[index];
    const adjustmentColumn = ADJUSTMENT_COLUMNS[index];
    const proFormaColumn = PRO_FORMA_COLUMNS[index];
    for (const definition of [
      ...rowPlan.statement_rows.income_statement,
      ...rowPlan.statement_rows.cash_flow,
    ]) {
      const standaloneValue = standaloneValues.get(definition.row_id) ?? 0;
      // Period-specific forecast rules reproduce the source workbook's
      // standalone dependency direction. They do not create a transaction
      // rule: adjustment is zero and pro forma equals standalone.
      const standaloneOnlyPeriodRule =
        hasForecastPeriodCalculations(definition);
      const proFormaValue = standaloneOnlyPeriodRule
        ? standaloneValue
        : proFormaValues.get(definition.row_id) ?? 0;
      if (standaloneOnlyPeriodRule) {
        proFormaValues.set(definition.row_id, standaloneValue);
      }
      caches.set(`${standaloneColumn}${definition.row}`, standaloneValue);
      caches.set(
        `${adjustmentColumn}${definition.row}`,
        standaloneOnlyPeriodRule ? 0 : proFormaValue - standaloneValue,
      );
      caches.set(`${proFormaColumn}${definition.row}`, proFormaValue);
    }
    // A RATIO IS NOT A DIFFERENCE — the rule the debt block below already
    // applies, applied here too. `pro forma less standalone` is the deal effect
    // on an AMOUNT and nonsense on a RATE: on the EBITDA margin line it is
    // -5.55e-17 when the two blocks agree to the last bit, and the revenue cell
    // that divides by that line then displayed -1.69e19. Every rate row in the
    // adjustment column is re-derived below from what its own formula says.
    for (const [row, value] of acquisitionAdjustmentRatioCaches(
      modelCase,
      rowPlan,
      standaloneValues,
      proFormaValues,
    )) {
      if (value === null) caches.delete(`${adjustmentColumn}${row}`);
      else caches.set(`${adjustmentColumn}${row}`, value);
    }
    const instrumentResults = (result) =>
      new Map(
        result.instrument_results.map((item) => [item.instrument_id, item]),
      );
    const standaloneInstruments = instrumentResults(standalone);
    const proFormaInstruments = instrumentResults(proForma);
    for (const plan of rowPlan.instruments) {
      const instrument = instrumentById.get(plan.instrument_id);
      const standaloneItem = standaloneInstruments.get(plan.instrument_id);
      const proFormaItem = proFormaInstruments.get(plan.instrument_id);
      const standaloneDebt =
        isBalancingRcf(modelCase, instrument)
          ? standalone.ending_rcf
          : Number(standaloneItem?.ending_reporting ?? 0);
      const proFormaDebt =
        isBalancingRcf(modelCase, instrument)
          ? proForma.ending_rcf
          : Number(proFormaItem?.ending_reporting ?? 0);
      caches.set(`${standaloneColumn}${plan.debt_row}`, standaloneDebt);
      caches.set(`${proFormaColumn}${plan.debt_row}`, proFormaDebt);
      caches.set(
        `${adjustmentColumn}${plan.debt_row}`,
        proFormaDebt - standaloneDebt,
      );
      if (plan.pik_row) {
        const standalonePik = Number(standaloneItem?.pik_interest_native ?? 0);
        const proFormaPik = Number(proFormaItem?.pik_interest_native ?? 0);
        caches.set(`${standaloneColumn}${plan.pik_row}`, standalonePik);
        caches.set(`${proFormaColumn}${plan.pik_row}`, proFormaPik);
        caches.set(`${adjustmentColumn}${plan.pik_row}`, proFormaPik - standalonePik);
      }
      // The revolver has no instrument row in the interest schedule; its cost
      // is cached against the dedicated RCF fee rows instead.
      if (!plan.interest_row) continue;
      const standaloneInterest = -Number(
        standaloneItem?.cash_coupon_interest_reporting ??
          standaloneItem?.interest_reporting ??
          0,
      );
      const proFormaInterest = -Number(
        proFormaItem?.cash_coupon_interest_reporting ??
          proFormaItem?.interest_reporting ??
          0,
      );
      caches.set(`${standaloneColumn}${plan.interest_row}`, standaloneInterest);
      caches.set(`${proFormaColumn}${plan.interest_row}`, proFormaInterest);
      caches.set(
        `${adjustmentColumn}${plan.interest_row}`,
        proFormaInterest - standaloneInterest,
      );
      if (plan.pik_interest_row) {
        const standalonePikInterest = -Number(
          standaloneItem?.pik_interest_reporting ?? 0,
        );
        const proFormaPikInterest = -Number(
          proFormaItem?.pik_interest_reporting ?? 0,
        );
        caches.set(
          `${standaloneColumn}${plan.pik_interest_row}`,
          standalonePikInterest,
        );
        caches.set(
          `${proFormaColumn}${plan.pik_interest_row}`,
          proFormaPikInterest,
        );
        caches.set(
          `${adjustmentColumn}${plan.pik_interest_row}`,
          proFormaPikInterest - standalonePikInterest,
        );
      }
    }
    for (const group of rowPlan.debt_groups ?? []) {
      const memberPlans = group.instrument_ids
        .map((instrumentId) =>
          rowPlan.instruments.find(
            (plan) => plan.instrument_id === instrumentId,
          ),
        )
        .filter(Boolean);
      for (const column of [
        standaloneColumn,
        adjustmentColumn,
        proFormaColumn,
      ]) {
        const debtSubtotal = memberPlans.reduce(
          (total, plan) =>
            total + Number(caches.get(`${column}${plan.debt_row}`) ?? 0),
          0,
        );
        // The group that owns the revolver picks up the whole RCF fee subtotal
        // — drawn interest AND commitment fee — because the facility no longer
        // has an instrument row of its own inside the group.
        const rcfCost = (block) =>
          Number(block.rcf_commitment_fee ?? 0) + Number(block.rcf_interest ?? 0);
        const interestSubtotal = memberPlans
          .filter((plan) => plan.interest_row)
          .reduce(
            (total, plan) =>
              total +
              Number(caches.get(`${column}${plan.interest_row}`) ?? 0) +
              Number(
                plan.pik_interest_row
                  ? (caches.get(`${column}${plan.pik_interest_row}`) ?? 0)
                  : 0,
              ),
            0,
          ) +
          (memberPlans.some(
            (plan) =>
              isBalancingRcf(
                modelCase,
                instrumentById.get(plan.instrument_id),
              ),
          )
            ? column === standaloneColumn
              ? -rcfCost(standalone)
              : column === proFormaColumn
                ? -rcfCost(proForma)
                : -rcfCost(proForma) + rcfCost(standalone)
            : 0);
        caches.set(`${column}${group.subtotal_row}`, debtSubtotal);
        caches.set(
          `${column}${group.interest_subtotal_row}`,
          interestSubtotal,
        );
      }
    }
    // The forecast slice of each named reconciling item. The bridge is a set of
    // reported facts, so it is the same figure in the standalone and pro-forma
    // blocks and nets to zero in the adjustment column — which is exactly what
    // the structural `=0` written on the face says.
    const bridgeComponentsForCache = rowPlan.reported_net_debt_bridge ?? [];
    const debtValues = (result) => {
      const lease = Number(result.ending_lease);
      const grossExcludingLeases =
        result.gross_debt -
        (modelCase.lease_policy.include_in_gross_debt ? lease : 0);
      const grossIncludingLeases = grossExcludingLeases + lease;
      const cash = -result.eligible_cash;
      const netExcludingLeases = grossExcludingLeases + cash;
      const netIncludingLeases = grossIncludingLeases + cash;
      const netModelBasis = modelCase.lease_policy.include_in_net_debt
        ? netIncludingLeases
        : netExcludingLeases;
      const componentValues = bridgeComponentsForCache.map((component) =>
        Number(component.values[3 + index] ?? 0),
      );
      const netCompanyReported =
        netModelBasis + componentValues.reduce((total, item) => total + item, 0);
      const companyReported = bridgeComponentsForCache.length
        ? {
            net_debt_model_basis_restated: netModelBasis,
            ...Object.fromEntries(
              componentValues.map((value, componentIndex) => [
                `reported_net_debt_adjustment_${componentIndex}`,
                value,
              ]),
            ),
            net_debt_company_reported: netCompanyReported,
            company_reported_adjusted_ebitda: result.adjusted_ebitda,
            net_debt_company_reported_to_adjusted_ebitda:
              Number(result.adjusted_ebitda) === 0
                ? 0
                : netCompanyReported / Number(result.adjusted_ebitda),
          }
        : {};
      const bucketBalances = Object.fromEntries(
        (result.cash_bucket_balances ?? []).map((bucket) => [
          `cash_bucket.${bucket.bucket_id}`,
          Number(bucket.ending_balance ?? 0),
        ]),
      );
      const debtFxTranslation =
        (result.instrument_results ?? []).reduce((total, item) => {
          const instrument = instrumentById.get(item.instrument_id);
          return instrument?.include_in_gross_debt === false
            ? total
            : total + Number(item.fx_non_cash_movement ?? 0);
        }, 0) + Number(result.rcf_fx_non_cash_movement ?? 0);
      return {
        acquisition_debt: result.acquisition_debt,
        total_acquisition_debt: result.acquisition_debt,
        gross_debt_excluding_leases: grossExcludingLeases,
        lease_liability: lease,
        total_lease_liabilities: lease,
        gross_debt_including_leases: grossIncludingLeases,
        ...(rowPlan.cash_buckets?.length
          ? {
              ...bucketBalances,
              reported_cash: Number(result.reported_cash ?? 0),
              liquidity_cash: Number(result.liquidity_cash ?? 0),
              interest_bearing_cash: Number(
                result.interest_eligible_cash ?? 0,
              ),
            }
          : {}),
        cash_for_net_debt: cash,
        net_debt_excluding_leases: netExcludingLeases,
        net_debt_including_leases: netIncludingLeases,
        ...(Number.isInteger(rowPlan.debt_summary_rows.debt_fx_translation)
          ? { debt_fx_translation: debtFxTranslation }
          : {}),
        ...companyReported,
        // TOTAL CHANGE IN DEBT IS SOLVED, NOT INHERITED.
        //
        // It used to be left to the LibreOffice recalculation on the grounds
        // that "the recalculated cache is the authority". It is not: the
        // recalculation runs BEFORE the solver's caches are written, so this
        // row kept an iterate struck against balances that the very next step
        // overwrote — a sweep one revolver draw short of the delivered answer.
        // The cash flow's own "Change in Debt" is literally `=this row`, and
        // the two printed numbers up to 611 apart because one was solved and
        // the other was a leftover.
        //
        // The value is the CASH debt movement, which is exactly what the
        // visible formula (closing gross debt, less opening, less the
        // translation stated on the row beneath) evaluates to once the
        // balances either side of it carry the solver's numbers. Every leg is
        // taken from the same converged period the balances come from, so the
        // cache cannot be a step behind them.
        total_change_in_debt:
          Number(result.non_rcf_issuance ?? 0) -
          Number(result.non_rcf_repayment ?? 0) +
          Number(result.rcf_draw ?? 0) -
          Number(result.rcf_repayment ?? 0),
        mandatory_debt_repayments: Number(result.non_rcf_repayment ?? 0),
        // The two denominators are cached alongside the ratios that consume
        // them. Without this the visible EBITDA / net interest rows would cache
        // as zero next to a non-zero multiple — precisely the unreconciled
        // block the rows were added to remove.
        leverage_adjusted_ebitda: result.adjusted_ebitda,
        net_debt_excluding_leases_to_adjusted_ebitda:
          Number(result.adjusted_ebitda) === 0
            ? 0
            : netExcludingLeases / Number(result.adjusted_ebitda),
        net_debt_to_adjusted_ebitda: result.net_leverage,
        leverage_net_interest: result.net_interest,
        adjusted_ebitda_to_net_interest:
          Number(result.net_interest) === 0
            ? 0
            : Number(result.adjusted_ebitda) / Number(result.net_interest),
        undrawn_rcf: result.undrawn_rcf,
        drawn_commercial_paper: -Number(result.drawn_commercial_paper ?? 0),
        year_end_cash: Number(
          rowPlan.cash_buckets?.length
            ? result.liquidity_cash
            : result.ending_cash,
        ),
        total_liquidity: result.total_liquidity,
      };
    };
    const standaloneDebtValues = debtValues(standalone);
    const proFormaDebtValues = debtValues(proForma);
    const ratio = (numerator, denominator) =>
      Number(denominator) === 0 ? 0 : Number(numerator) / Number(denominator);
    // The adjustment block on its own terms: every additive measure is the
    // pro-forma figure less the standalone figure, which is what the
    // adjustment column's own subtotals foot to.
    const adjustmentDebtValues = Object.fromEntries(
      Object.keys(standaloneDebtValues).map((key) => [
        key,
        (proFormaDebtValues[key] ?? 0) - standaloneDebtValues[key],
      ]),
    );
    for (const [id, row] of Object.entries(rowPlan.debt_summary_rows)) {
      if (id.endsWith("_header")) continue;
      // A row the solver does not restate keeps the recalculated cache. Forcing
      // a zero here would blank a correct figure the recalculation already put
      // on the face.
      if (standaloneDebtValues[id] === undefined) continue;
      caches.set(`${standaloneColumn}${row}`, standaloneDebtValues[id]);
      caches.set(`${proFormaColumn}${row}`, proFormaDebtValues[id] ?? 0);
      // A RATIO IS NOT A DIFFERENCE. The additive rows of this block genuinely
      // net — the acquisition's own gross debt, cash and EBITDA — but the
      // leverage and coverage multiples divide one adjustment-column row by
      // another, exactly as the visible formula does. Caching "pro-forma
      // multiple less standalone multiple" against a cell whose formula is
      // `=N156/N161` puts a number on the face that the formula bar
      // contradicts the moment Excel recalculates.
      const adjustmentRatio =
        id === "net_debt_excluding_leases_to_adjusted_ebitda"
          ? ratio(
              adjustmentDebtValues.net_debt_excluding_leases,
              adjustmentDebtValues.leverage_adjusted_ebitda,
            )
          : id === "net_debt_to_adjusted_ebitda"
            ? ratio(
                adjustmentDebtValues[
                  modelCase.lease_policy.include_in_leverage &&
                  modelCase.lease_policy.mode !== "exclude"
                    ? "net_debt_including_leases"
                    : "net_debt_excluding_leases"
                ],
                adjustmentDebtValues.leverage_adjusted_ebitda,
              )
            : id === "adjusted_ebitda_to_net_interest"
              ? ratio(
                  adjustmentDebtValues.leverage_adjusted_ebitda,
                  adjustmentDebtValues.leverage_net_interest,
                )
              : id === "net_debt_company_reported_to_adjusted_ebitda"
                ? ratio(
                    adjustmentDebtValues.net_debt_company_reported,
                    adjustmentDebtValues.company_reported_adjusted_ebitda,
                  )
                : null;
      caches.set(
        `${adjustmentColumn}${row}`,
        adjustmentRatio ?? adjustmentDebtValues[id],
      );
    }
    const waterfallValues = (result) => ({
      cash_before_debt: result.cash_before_debt,
      non_rcf_debt_proceeds: result.non_rcf_issuance,
      // Gross proceeds, mandatory repayments and lease principal are separate
      // visible rows. Never net one into another in the cache.
      pre_rcf_debt_cash_flow: -result.non_rcf_repayment,
      lease_principal_waterfall: -result.lease_principal,
      cash_before_rcf: result.cash_before_rcf,
      minimum_cash: result.minimum_cash,
      cash_surplus_deficit: result.cash_before_rcf - result.minimum_cash,
      opening_rcf:
        Number(result.rcf_opening_native ?? 0) *
        Number(result.rcf_opening_fx ?? 1),
      rcf_draw_waterfall: result.rcf_draw,
      rcf_repayment_waterfall: result.rcf_repayment,
      ending_rcf: result.ending_rcf,
      liquidity_shortfall: result.liquidity_shortfall,
    });
    const standaloneWaterfall = waterfallValues(standalone);
    const proFormaWaterfall = waterfallValues(proForma);
    const priorStandaloneRcf =
      Number(standalone.rcf_opening_native ?? 0) *
      Number(standalone.rcf_opening_fx ?? 1);
    const priorProFormaRcf =
      Number(proForma.rcf_opening_native ?? 0) *
      Number(proForma.rcf_opening_fx ?? 1);
    standaloneWaterfall.opening_rcf = priorStandaloneRcf;
    proFormaWaterfall.opening_rcf = priorProFormaRcf;
    for (const [id, row] of Object.entries(rowPlan.waterfall_rows)) {
      caches.set(`${standaloneColumn}${row}`, standaloneWaterfall[id]);
      caches.set(`${proFormaColumn}${row}`, proFormaWaterfall[id]);
      caches.set(
        `${adjustmentColumn}${row}`,
        proFormaWaterfall[id] - standaloneWaterfall[id],
      );
    }
    const interestValues = (result) => ({
      instrument_interest: -result.instrument_interest,
      acquisition_interest: -result.acquisition_interest,
      rcf_total_fees: -(result.rcf_interest + result.rcf_commitment_fee),
      rcf_interest: -result.rcf_interest,
      rcf_commitment_fee: -result.rcf_commitment_fee,
      lease_interest: -result.lease_interest,
      other_unallocated_interest: -result.other_interest,
      non_cash_interest: -result.non_cash_interest,
      gross_interest_expense: -result.gross_interest,
      interest_income_schedule: result.interest_income,
      net_interest_expense: -result.net_interest,
      cash_interest_paid:
        -(
          result.gross_interest -
          result.non_cash_interest -
          result.non_cash_instrument_interest
        ),
      cash_interest_received: result.interest_income,
    });
    const standaloneInterestValues = interestValues(standalone);
    const proFormaInterestValues = interestValues(proForma);
    if (rowPlan.cash_buckets?.length) {
      const bucketInterestById = (result) =>
        new Map(
          (result.cash_bucket_balances ?? []).map((bucket) => [
            bucket.bucket_id,
            Number(bucket.interest_income ?? 0),
          ]),
        );
      const standaloneBucketInterest = bucketInterestById(standalone);
      const proFormaBucketInterest = bucketInterestById(proForma);
      for (const bucket of rowPlan.cash_buckets) {
        const standaloneValue = Number(
          standaloneBucketInterest.get(bucket.bucket_id) ?? 0,
        );
        const proFormaValue = Number(
          proFormaBucketInterest.get(bucket.bucket_id) ?? 0,
        );
        caches.set(
          `${standaloneColumn}${bucket.interest_row}`,
          standaloneValue,
        );
        caches.set(
          `${proFormaColumn}${bucket.interest_row}`,
          proFormaValue,
        );
        caches.set(
          `${adjustmentColumn}${bucket.interest_row}`,
          proFormaValue - standaloneValue,
        );
      }
    }
    for (const [id, row] of Object.entries(rowPlan.interest_summary_rows)) {
      // The historical interest reconciliation has no forecast counterpart —
      // there is no reported figure to reconcile a forecast year against — so
      // those rows carry no forecast cell for a cache to attach to. A row the
      // solver does not restate keeps whatever the recalculation produced.
      if (standaloneInterestValues[id] === undefined) continue;
      caches.set(`${standaloneColumn}${row}`, standaloneInterestValues[id]);
      caches.set(`${proFormaColumn}${row}`, proFormaInterestValues[id]);
      caches.set(
        `${adjustmentColumn}${row}`,
        proFormaInterestValues[id] - standaloneInterestValues[id],
      );
    }
    priorStandalone = standaloneValues;
    priorProForma = proFormaValues;
  }
  return caches;
}

/**
 * DEFECT 0.3 — THE RECALCULATION USED TO FAIL OPEN.
 *
 * This resolver derived its ONLY candidate from a bundled-runtime-relative path
 * and returned `null` when it was not there; `refreshFormulaCaches` then began
 * `if (!sofficePath) return 0;` and the build carried on. The count is printed
 * into the BUILT line and was never asserted, so on any host without that
 * exact layout the build reported BUILT with every formula cache left at
 * whatever the in-process writer happened to put there — a workbook that says
 * one thing in its formulas and another in the numbers a reader sees before
 * Excel recalculates.
 *
 * Resolution order, each step stated so a failure names what was tried:
 *   1. `--soffice <path>` on the command line
 *   2. `SOFFICE_BIN` in the environment
 *   3. `soffice` / `soffice.bin` on PATH
 *   4. a bundled-runtime-relative override
 *   5. the standard macOS and Linux install locations
 * and a throw if none of them exists.
 */
function sofficeCandidates(explicitPath) {
  const candidates = [];
  const add = (value, source) => {
    if (typeof value !== "string" || value.trim() === "") return;
    candidates.push({ path: path.resolve(value), source });
  };
  add(explicitPath, "--soffice flag");
  add(process.env.SOFFICE_BIN, "SOFFICE_BIN environment variable");
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of ["soffice", "soffice.bin"]) {
      candidates.push({
        path: path.join(directory, name),
        source: `PATH entry ${directory}`,
      });
    }
  }
  candidates.push({
    path: path.resolve(
      path.dirname(process.execPath),
      "../../bin/override/soffice",
    ),
    source: "bundled runtime override, relative to the running node binary",
  });
  for (const wellKnown of [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
    "/snap/bin/libreoffice",
  ]) {
    candidates.push({ path: wellKnown, source: "well-known install location" });
  }
  return candidates;
}

async function resolveSoffice(explicitPath) {
  const candidates = sofficeCandidates(explicitPath);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate.path, fsConstants.X_OK);
      return candidate.path;
    } catch {
      // fall through to the next candidate
    }
  }
  throw new Error(
    "LibreOffice (soffice) could not be found, so the workbook's formula caches " +
      "cannot be recalculated and the build cannot be certified. Set --soffice " +
      "<path> or SOFFICE_BIN, or put soffice on PATH. Tried, in order:\n" +
      candidates
        .map((candidate) => `  - ${candidate.path}  [${candidate.source}]`)
        .join("\n"),
  );
}

async function refreshFormulaCaches(outputPath, sofficePath) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(path.dirname(outputPath), ".dynamic-recalc-"),
  );
  try {
    await execFileAsync(
      sofficePath,
      [
        "--headless",
        "--convert-to",
        "xlsx",
        "--outdir",
        temporaryDirectory,
        outputPath,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return syncRecalculatedFormulaCaches(
      outputPath,
      path.join(temporaryDirectory, path.basename(outputPath)),
    );
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// ===========================================================================
// L5 PLAN EMISSION
//
// WHAT THE PLAN IS CAPTURED FROM, AND WHY IT IS NOT SYNTHESISED.
//
// The shipped package is the legacy workbook library writer's package with LibreOffice's
// recalculated caches grafted into it — `syncRecalculatedFormulaCaches` copies
// <v> nodes back and nothing else, so LibreOffice's own file is never shipped.
// That makes two parties, not this emitter, the authority on parts of the
// result:
//
//   * the legacy workbook library writer owns the style table and the cell layout, and
//   * LibreOffice owns every cached value.
//
// Worse, the writer ACCEPTS AND DISCARDS four formatting calls — the frozen
// pane, row outline levels, `format.indentLevel` and
// `format.horizontalAlignment` — which is why those four exist as package
// patches at all. So the emitter's in-process workbook object is not a
// description of what ships; on those four channels it is demonstrably not
// even a description of what it asked for.
//
// The plan is therefore CAPTURED from the finished package, by the same reader
// scripts/extract_plan.mjs uses. One reader behind one contract: a second
// parser would make a disagreement between two parsers indistinguishable from
// a disagreement between two workbooks.
//
// Capture alone would be a build that reports whatever it happens to find, so
// everything this emitter genuinely DECIDES is declared below from the row plan
// and asserted against the captured plan. Anything the emitter chose and the
// package does not show fails the build here rather than surfacing later as a
// render mismatch. The two formula rewrites are the reason this matters: they
// are applied to the package after export, and the assertion is what proves the
// plan describes the formulas that actually ship.
// ===========================================================================

function planCellStyle(plan, sheet, address) {
  const cell = sheet.cells?.[address];
  if (!cell) return null;
  if (cell.s === undefined) return {};
  return plan.workbook.styles[cell.s] ?? null;
}

function planSheet(plan, name) {
  return plan.workbook.sheets.find((sheet) => sheet.name === name) ?? null;
}

/**
 * Compare two plain records by MEANING, not by key order.
 *
 * `JSON.stringify` on two objects that say the same thing in a different order
 * reports a difference no reader can see — and a check that cries wolf about
 * spelling gets its real findings ignored.
 */
function sameRecord(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}

function describe(value) {
  return JSON.stringify(
    value === null || typeof value !== "object"
      ? value
      : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}

/**
 * Every fact this emitter DECIDES about the shipped package, stated from the
 * row plan rather than read back out of the file.
 */
function declareShippedFacts(rowPlan, brokerRows) {
  const outlineLevels = new Map();
  const noteOutline = (row, level) => {
    const target = Number(row);
    const depth = Number(level);
    if (!Number.isInteger(target) || target < 1) return;
    if (!Number.isFinite(depth) || depth < 1) return;
    outlineLevels.set(
      target,
      Math.max(outlineLevels.get(target) ?? 0, Math.min(depth, 7)),
    );
  };
  const indents = new Map();
  const noteIndent = (row, level) => {
    const target = Number(row);
    const depth = Number(level);
    if (!Number.isInteger(target) || target < 1) return;
    if (!Number.isFinite(depth) || depth < 1) return;
    indents.set(target, Math.max(indents.get(target) ?? 0, Math.min(depth, 15)));
  };
  for (const section of Object.values(rowPlan.statement_rows ?? {})) {
    for (const definition of section ?? []) {
      noteOutline(definition.row, definition.outline_level ?? 0);
      noteIndent(definition.row, definition.indent);
    }
  }
  for (const entry of rowPlan.outline_rows ?? []) noteOutline(entry.row, entry.level);
  for (const [row, level] of Object.entries(rowPlan.label_indents ?? {})) {
    noteIndent(row, level);
  }

  // The runs the three block titles centre across. Each stops before a gutter:
  // a run crossing F, M or Q would centre the title over the wrong span.
  const centreContinuous = [];
  const titleRow = Number(rowPlan.period_group_row);
  if (Number.isInteger(titleRow) && titleRow >= 1) {
    for (const [first, last] of [["G", "L"], ["N", "P"], ["R", "U"]]) {
      for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
        centreContinuous.push(`${String.fromCharCode(code)}${titleRow}`);
      }
    }
  }

  const frozenRow = Number(rowPlan.period_row ?? 21);
  const brokerFreezeRow = Number(brokerRows?.headerRow);
  const brokerContributorRows = (brokerRows?.contributorRows ?? [])
    .map(Number)
    .filter((row) => Number.isInteger(row) && row > 0);

  return {
    calc_properties: declaredCalcProperties(),
    default_font_name: "Calibri",
    sheet_order: brokerRows?.sheetOrder ?? ["Operating Model", "Brokers", "Forward Curves"],
    operating_model: {
      freeze_pane: {
        x_split: 6,
        y_split: frozenRow,
        top_left_cell: `G${frozenRow + 1}`,
        active_pane: "bottomRight",
        state: "frozen",
      },
      outline_levels: outlineLevels,
      label_indents: indents,
      centre_continuous: centreContinuous,
      gate_prefix: adjustmentGatePrefix(rowPlan),
      gate_excluded_rows: adjustmentGateExcludedRows(rowPlan),
      period_row: Number(rowPlan.period_row),
      visible_end_row: Number(rowPlan.visible_end_row),
    },
    brokers: {
      freeze_pane: Number.isInteger(brokerFreezeRow) && brokerFreezeRow > 0
        ? {
            y_split: brokerFreezeRow,
            top_left_cell: `A${brokerFreezeRow + 1}`,
            active_pane: "bottomLeft",
            state: "frozen",
          }
        : null,
      outline_rows: brokerContributorRows,
    },
  };
}

/**
 * Check the captured plan against the declaration. Returns violations and the
 * counts each check visited.
 *
 * A count of ZERO is a violation in its own right, on the same reasoning as
 * DEFECT 0.12: a check that visited nothing has described its own selector, not
 * the workbook, and a summary that reads clean because a channel was never
 * looked at is the failure this whole discipline exists to prevent.
 */
function assertShippedPlan(plan, declared) {
  const violations = [];
  const counts = {};

  const order = plan.workbook.sheets.map((sheet) => sheet.name);
  if (JSON.stringify(order) !== JSON.stringify(declared.sheet_order)) {
    violations.push(
      `sheet order is ${JSON.stringify(order)}, declared ${JSON.stringify(declared.sheet_order)}.`,
    );
  }

  const calc = plan.workbook.calc_properties ?? {};
  for (const [key, value] of Object.entries(declared.calc_properties)) {
    if (calc[key] !== value) {
      violations.push(
        `calc_properties.${key} is ${JSON.stringify(calc[key])}, declared ${JSON.stringify(value)}.`,
      );
    }
  }

  const defaultFont = plan.workbook.default_font?.name;
  if (defaultFont !== declared.default_font_name) {
    violations.push(
      `workbook default font is ${JSON.stringify(defaultFont)}, declared ${JSON.stringify(declared.default_font_name)}. ` +
        "fonts[0] is the unit every stored column width is expressed in.",
    );
  }

  // --- Operating Model -----------------------------------------------------
  const face = planSheet(plan, "Operating Model");
  if (!face) {
    violations.push("the plan has no Operating Model sheet.");
    return { violations, counts };
  }
  const spec = declared.operating_model;

  if (!sameRecord(face.freeze_pane, spec.freeze_pane)) {
    violations.push(
      `Operating Model freeze pane is ${describe(face.freeze_pane)}, declared ${describe(spec.freeze_pane)}.`,
    );
  }

  // THE ADJUSTMENT GATE. Every N/O/P formula on a gated face row must carry it,
  // and no cell outside that set may.
  let gated = 0;
  let ungated = 0;
  let strayGate = 0;
  for (const [address, cell] of Object.entries(face.cells)) {
    const parsed = /^([A-Z]+)(\d+)$/.exec(address);
    if (!parsed) continue;
    const [, column, rowText] = parsed;
    const row = Number(rowText);
    if (cell.f === undefined) continue;
    const carries = cell.f.startsWith(spec.gate_prefix);
    const shouldGate =
      ADJUSTMENT_GATE_COLUMNS.includes(column) &&
      row > spec.period_row &&
      row <= spec.visible_end_row &&
      !spec.gate_excluded_rows.has(row);
    if (shouldGate) {
      if (carries) gated += 1;
      else {
        ungated += 1;
        if (ungated <= 5) {
          violations.push(`${address} is a gated adjustment cell but its formula is "${cell.f}".`);
        }
      }
    } else if (carries && !ADJUSTMENT_GATE_COLUMNS.includes(column)) {
      strayGate += 1;
      if (strayGate <= 5) {
        violations.push(`${address} carries the adjustment gate outside columns N/O/P.`);
      }
    }
  }
  counts.adjustment_gate_cells = gated;
  if (gated === 0) {
    violations.push(
      "not one gated adjustment cell was found in the plan. The gate is applied to the package " +
        "after export, and a plan that does not carry it describes formulas that do not ship.",
    );
  }

  // THE PRO-FORMA-HISTORICAL REWRITE. Column R on a face row is `I{row}`.
  let rewrittenR = 0;
  for (const [address, cell] of Object.entries(face.cells)) {
    const parsed = /^R(\d+)$/.exec(address);
    if (!parsed || cell.f === undefined) continue;
    const row = Number(parsed[1]);
    if (row <= spec.period_row || row > spec.visible_end_row) continue;
    if (cell.f === `I${row}`) rewrittenR += 1;
    else if (violations.length < 40) {
      violations.push(`${address} should be the pro-forma historical link "I${row}" but is "${cell.f}".`);
    }
  }
  counts.pro_forma_historical_cells = rewrittenR;
  if (rewrittenR === 0) {
    violations.push(
      "not one pro-forma-historical R cell was found in the plan. The R rewrite is applied to the " +
        "package after export, and a plan that does not carry it describes formulas that do not ship.",
    );
  }

  // ROW OUTLINE LEVELS.
  const faceRows = new Map((face.rows ?? []).map((record) => [record.row, record]));
  let outlined = 0;
  for (const [row, level] of spec.outline_levels) {
    const record = faceRows.get(row);
    if (record?.outline_level === level) outlined += 1;
    else {
      violations.push(
        `Operating Model row ${row} outline level is ${JSON.stringify(record?.outline_level)}, declared ${level}.`,
      );
    }
  }
  for (const record of face.rows ?? []) {
    if (record.outline_level && !spec.outline_levels.has(record.row)) {
      violations.push(`Operating Model row ${record.row} carries an undeclared outline level.`);
    }
  }
  counts.outlined_rows = outlined;

  // summaryBelow=0 is load-bearing: a consolidated line sits ABOVE its run.
  if (spec.outline_levels.size > 0) {
    const outline = face.outline ?? {};
    if (outline.summary_below !== false) {
      violations.push("Operating Model outlinePr summaryBelow is not false.");
    }
    const declaredMax = Math.max(...spec.outline_levels.values());
    if (outline.outline_level_row !== declaredMax) {
      violations.push(
        `Operating Model outlineLevelRow is ${JSON.stringify(outline.outline_level_row)}, declared ${declaredMax}.`,
      );
    }
  }

  // LABEL INDENTS — real `alignment indent`, not spaces inside the string.
  let indented = 0;
  for (const [row, level] of spec.label_indents) {
    const style = planCellStyle(plan, face, `B${row}`);
    if (style?.alignment?.indent === level) indented += 1;
    else {
      violations.push(
        `B${row} indent is ${JSON.stringify(style?.alignment?.indent)}, declared ${level}.`,
      );
    }
  }
  counts.indented_labels = indented;

  // BLOCK TITLES — centerContinuous, never a merge.
  let centred = 0;
  for (const address of spec.centre_continuous) {
    const style = planCellStyle(plan, face, address);
    if (style?.alignment?.horizontal === "centerContinuous") centred += 1;
    else {
      violations.push(
        `${address} horizontal alignment is ${JSON.stringify(style?.alignment?.horizontal)}, declared centerContinuous.`,
      );
    }
  }
  counts.centred_block_titles = centred;

  // --- Brokers -------------------------------------------------------------
  const brokers = planSheet(plan, "Brokers");
  if (!brokers) {
    violations.push("the plan has no Brokers sheet.");
  } else {
    if (!sameRecord(brokers.freeze_pane, declared.brokers.freeze_pane)) {
      violations.push(
        `Brokers freeze pane is ${describe(brokers.freeze_pane)}, declared ${describe(declared.brokers.freeze_pane)}.`,
      );
    }
    const brokerRowRecords = new Map((brokers.rows ?? []).map((r) => [r.row, r]));
    let brokerOutlined = 0;
    for (const row of declared.brokers.outline_rows) {
      if (brokerRowRecords.get(row)?.outline_level === 1) brokerOutlined += 1;
      else {
        violations.push(
          `Brokers row ${row} outline level is ${JSON.stringify(brokerRowRecords.get(row)?.outline_level)}, declared 1.`,
        );
      }
    }
    counts.grouped_broker_rows = brokerOutlined;
  }

  // --- Standing rules, asserted rather than assumed ------------------------
  for (const sheet of plan.workbook.sheets) {
    const merges = sheet.merges ?? [];
    if (merges.length > 0) {
      violations.push(
        `${sheet.name} has ${merges.length} merged range(s); layout.merged_calculation_cells_forbidden is a standing rule.`,
      );
    }
    for (const record of sheet.rows ?? []) {
      if (record.hidden) violations.push(`${sheet.name} row ${record.row} is hidden; nothing in this model is hidden.`);
    }
  }

  return { violations, counts };
}

// ---------------------------------------------------------------------------
// L5 PLAN, SYNTHESISED
//
// Everything below turns the emitter's own record of its decisions into a plan.
// It reads no file and calls no external tool. The five package passes the Node
// pipeline needed — the adjustment gate, the pro-forma-historical rewrite, the
// frozen pane, the row outlines, the label indents and the centred block titles
// — are ordinary recorded facts here, and each one selects its cells through
// the SAME function the package pass uses, so the two cannot disagree about
// which cells they mean.
// ---------------------------------------------------------------------------

/**
 * Apply the adjustment-column gate and the pro-forma-historical rewrite to the
 * plan's own formulas.
 *
 * These are the same two rewrites `patchWorkbookProperties` performs on the
 * package, taken from the same three predicates (`isRewritableFaceRow`,
 * `adjustmentGateExcludedRows`, `adjustmentGatePrefix`). They run AFTER
 * `assertFormulaProvenance()` for the reason the package passes do: the
 * provenance colour is a claim about where a number comes from, and wrapping a
 * same-sheet formula in a gate does not make it a cross-sheet link.
 */
function applyPlanFormulaRewrites(sheet, rowPlan) {
  const excludedRows = adjustmentGateExcludedRows(rowPlan);
  const gate = adjustmentGatePrefix(rowPlan);
  let adjustmentCells = 0;
  let proFormaHistoricalCells = 0;
  for (const address of [...sheet.cellAddresses()]) {
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    if (!match) continue;
    const column = match[1];
    const row = Number(match[2]);
    const cell = sheet.cellAt(address);
    if (!cell || cell.formula === undefined) continue;
    if (column === "N" || column === "O" || column === "P") {
      adjustmentCells += 1;
      if (!isRewritableFaceRow(rowPlan, row) || excludedRows.has(row)) continue;
      if (cell.formula.startsWith(gate)) continue;
      sheet.setFormulaText(address, `${gate}${cell.formula})`);
      continue;
    }
    if (column === "R") {
      if (!isRewritableFaceRow(rowPlan, row)) continue;
      proFormaHistoricalCells += 1;
      sheet.setFormulaText(address, `I${row}`);
    }
  }
  return { adjustmentCells, proFormaHistoricalCells };
}

/**
 * Everything the package passes used to add, added here instead.
 *
 * Returns the same counts the build already reports, so a pass that visited
 * nothing is caught by the same gate: a scanner that matched no cells has
 * described its own selector, not the workbook.
 */
function applyPlanChrome(workbook, rowPlan, brokerRows) {
  const operatingModel = workbook.sheetByName("Operating Model");
  const brokers = workbook.sheetByName("Brokers");
  if (!operatingModel) {
    throw new Error("The synthesised plan has no Operating Model sheet.");
  }

  workbook.setCalcProperties(declaredCalcProperties());

  const rewrites = applyPlanFormulaRewrites(operatingModel, rowPlan);

  // Row outlines. summaryBelow="0" is not cosmetic: a consolidated line sits
  // ABOVE its constituents and Excel puts the collapse control on the wrong
  // side without it.
  let outlinedRows = 0;
  for (const [row, level] of rowOutlineLevels(rowPlan)) {
    if (operatingModel.setRowOutlineLevel(row, level)) outlinedRows += 1;
  }
  if (outlinedRows > 0) {
    operatingModel.setOutlineProperties({
      summary_below: false,
      summary_right: false,
    });
  }

  // Label indents. Real `alignment indent`, on the cell, not two spaces inside
  // the label string.
  let indentedLabels = 0;
  for (const [row, level] of labelIndentLevels(rowPlan)) {
    const address = `B${row}`;
    if (!operatingModel.hasCell(address)) continue;
    operatingModel.getRange(address).format.indentLevel = level;
    indentedLabels += 1;
  }

  // Block titles centred across their blocks WITHOUT merging;
  // `layout.merged_calculation_cells_forbidden` is a standing rule.
  let centredBlockTitles = 0;
  for (const address of blockTitleCells(rowPlan)) {
    if (!operatingModel.hasCell(address)) continue;
    operatingModel.getRange(address).format.horizontalAlignment =
      "centerContinuous";
    centredBlockTitles += 1;
  }

  let groupedBrokerRows = 0;
  if (brokers) {
    for (const row of brokerRows?.contributorRows ?? []) {
      if (brokers.setRowOutlineLevel(row, 1)) groupedBrokerRows += 1;
    }
    if (groupedBrokerRows > 0) {
      brokers.setOutlineProperties({
        summary_below: false,
        summary_right: false,
      });
    }
    const freezeRow = Number(brokerRows?.headerRow);
    if (Number.isInteger(freezeRow) && freezeRow > 0) {
      brokers.freezePanes.freezeRows(freezeRow);
    }
  }

  return {
    adjustment_gate_cells: rewrites.adjustmentCells,
    pro_forma_historical_cells: rewrites.proFormaHistoricalCells,
    outlined_rows: outlinedRows,
    indented_labels: indentedLabels,
    centred_block_titles: centredBlockTitles,
    grouped_broker_rows: groupedBrokerRows,
  };
}

/**
 * Run the emitter against a plan builder and return the plan it decided on.
 *
 * `cachedFormulaCells` / `uncachedFormulaCells` are reported rather than
 * asserted here: the honest statement about a cached value is which cells have
 * one and where it came from, and a builder that silently shipped a formula
 * with no cache would be making the reader's first view of the model a blank.
 */
export function synthesisePlan({
  modelCase,
  rowPlan,
  outputPath,
  standaloneSolution,
  proFormaSolution,
}) {
  const emission = emitWorkbook(() => PlanWorkbook.create(), modelCase, rowPlan);
  const counts = applyPlanChrome(
    emission.workbook,
    rowPlan,
    emission.brokerRows,
  );
  const operatingModel = emission.workbook.sheetByName("Operating Model");

  // PASS ONE — THE HISTORICAL FACE, which the solver's own prior-period seed
  // reads and which nothing solves because nothing forecast it. G, H and I are
  // arithmetic over reported hardcodes; R is the `=I{row}` alias the terminal
  // rewrite leaves behind. All four are acyclic, so they resolve without any
  // solver value to stand on, and they are what makes the seed available before
  // the solver runs rather than after a converter has.
  const historical = fillCachedValues(emission.workbook, {
    seedFilter: (sheet, address) =>
      sheet === "Operating Model" && /^[GHIR]\d+$/.test(address),
  });

  // CACHED VALUES COME FROM THE SOLVER. It already computes every one of them;
  // reading them back out of a package another tool recalculated made that tool
  // the source rather than the check. The prior-period seed is now the plan's
  // own historical columns rather than the recalculated package's.
  const solverCaches = solverFormulaCaches(
    modelCase,
    rowPlan,
    standaloneSolution,
    proFormaSolution,
    planNumericCaches(operatingModel),
  );
  let solverCachedCells = 0;
  for (const [address, value] of solverCaches) {
    if (operatingModel.setCachedValue(address, value)) solverCachedCells += 1;
  }

  // PASS TWO — everything still uncached: the Brokers selector, and any
  // remaining same-sheet arithmetic. Cells inside the declared interest / debt
  // / sweep circularity already carry the solver's value, which is what
  // terminates the walk; see scripts/lib/plan_values.mjs.
  const evaluated = fillCachedValues(emission.workbook);

  const { plan, uncached_formulas: uncachedFormulas } =
    emission.workbook.toPlan({
      caseId: modelCase.case_id,
      // Deterministic on purpose: a wall clock here would make two builds of
      // the same case differ, and the renderer stamps docProps from this field.
      generator: {
        tool: "build_dynamic_model.mjs",
        source: path.basename(outputPath),
        stage: "shipped",
      },
    });
  return {
    plan,
    counts,
    brokerRows: emission.brokerRows,
    solver_caches: solverCaches,
    historical_cached_cells: historical.filled,
    solver_cached_cells: solverCachedCells,
    evaluated_cached_cells: evaluated.filled,
    unresolved_caches: [...historical.unresolved, ...evaluated.unresolved],
    uncached_formula_cells: uncachedFormulas,
  };
}

/**
 * ONE GATE, BOTH PLANS.
 *
 * The captured plan and the synthesised plan are held to the identical
 * standard: every declared shipped fact, and the schema. A synthesised plan
 * checked more loosely than the captured one would be a plan whose only
 * evidence was that it agreed with something that WAS checked.
 */
function gatePlan(plan, rowPlan, brokerRows, planSchema, label) {
  const declaredFacts = declareShippedFacts(rowPlan, brokerRows);
  const { violations, counts } = assertShippedPlan(plan, declaredFacts);
  if (violations.length > 0) {
    throw new Error(
      `The ${label} plan does not describe the workbook this build shipped:\n- ${violations
        .slice(0, 40)
        .join("\n- ")}${violations.length > 40 ? `\n- ...and ${violations.length - 40} more` : ""}`,
    );
  }
  const schemaErrors = validateJsonSchema(plan, planSchema);
  if (schemaErrors.length > 0) {
    throw new Error(
      `The ${label} plan does not conform to assets/plan.schema.json:\n- ${schemaErrors
        .slice(0, 20)
        .join("\n- ")}`,
    );
  }
  const emptyAssertions = Object.entries(counts).filter(
    ([, count]) => !(Number(count) > 0),
  );
  if (emptyAssertions.length > 0) {
    throw new Error(
      `These ${label}-plan assertions visited nothing and cannot be reported as done: ` +
        emptyAssertions.map(([name, count]) => `${name}=${count}`).join(", ") +
        ". A gate check that visited no gated cell has described its own selector.",
    );
  }
  return counts;
}

async function readPlanSchema() {
  return JSON.parse(
    await fs.readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../assets/plan.schema.json",
      ),
      "utf8",
    ),
  );
}

/** The sidecars every mode writes beside the plan. */
async function writeModelSidecars(
  outputPath,
  {
    rowPlan,
    semanticManifest,
    sourceCrosswalk,
    modelIrV3,
    modelIrReceipt,
    forecastReceipt,
    shadowComparison,
    workbookProofContract,
    modelCase,
    standaloneSolution,
    proFormaSolution,
    historicalNormalisationReceipt,
  },
) {
  await fs.writeFile(
    `${outputPath}.row-map.json`,
    `${JSON.stringify(rowPlan, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.forecast-receipt.json`,
    `${JSON.stringify(forecastReceipt, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.forecast-receipt.csv`,
    forecastDecisionReceiptCsv(forecastReceipt),
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.shadow-comparison.json`,
    `${JSON.stringify(shadowComparison, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.semantic-manifest.json`,
    `${JSON.stringify(semanticManifest, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.source-crosswalk.csv`,
    sourceCrosswalkCsv(sourceCrosswalk),
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.model-ir-v3.json`,
    `${JSON.stringify(modelIrV3, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.transformation-receipt.json`,
    `${JSON.stringify(modelIrReceipt, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.workbook-proof-contract.json`,
    `${JSON.stringify(workbookProofContract, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    `${outputPath}.solution.json`,
    `${JSON.stringify(
      {
        case_id: modelCase.case_id,
        standalone: standaloneSolution,
        pro_forma: proFormaSolution,
        all_checks_pass:
          standaloneSolution.all_checks_pass && proFormaSolution.all_checks_pass,
        // Explicit user/case acknowledgements of named plausibility findings
        // (liquidity shortfall, negative ending cash, near-exhausted RCF).
        // The independent validator refuses to pass an unacknowledged
        // finding: a model showing a fictional funding crisis must block,
        // not narrate.
        plausibility_acknowledgements:
          explicitPlausibilityAcknowledgements(modelCase),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (historicalNormalisationReceipt?.applied) {
    await fs.writeFile(
      `${outputPath}.historical-normalisation.json`,
      `${JSON.stringify(historicalNormalisationReceipt, null, 2)}\n`,
      "utf8",
    );
  }
}

/**
 * THE EMITTER'S DECISIONS, ONCE, AGAINST WHATEVER RECEIVES THEM.
 *
 * The whole body of this file writes through one narrow surface —
 * `worksheets.add`, `getRange().values / .formulas / .format.*`,
 * `conditionalFormats.add`, `dataValidation`, `comments.addThread` — and never
 * reads anything back. That is what makes the receiving object substitutable:
 * `Workbook.create()` forwards the decisions to a package writer, and
 * `PlanWorkbook.create()` records them.
 *
 * `FORMULA_PROVENANCE` is keyed on sheet objects and accumulates across calls,
 * so it is cleared here rather than at the call site: a second emission would
 * otherwise re-assert the first emission's cells onto sheets that no longer
 * exist and report a provenance count that describes two workbooks.
 */
function emitWorkbook(makeWorkbook, modelCase, rowPlan) {
  FORMULA_PROVENANCE.clear();
  const workbook = makeWorkbook();
  const commentAuthor = { displayName: "Excel Inflow", initials: "EI" };
  if (typeof workbook.comments?.self?.set === "function") {
    workbook.comments.self.set(commentAuthor);
  } else if (typeof workbook.comments?.setSelf === "function") {
    workbook.comments.setSelf(commentAuthor);
  }
  const brokerEvidence = compileBrokerEvidenceLayout(modelCase);
  const operatingModel = workbook.worksheets.add("Operating Model");
  if (brokerEvidence) buildBrokerEvidenceDivider(workbook, brokerEvidence);
  const brokerRows = buildBrokersSheet(
    workbook,
    modelCase,
    rowPlan,
    brokerEvidence,
  );
  if (brokerEvidence) buildBrokerEvidenceSheets(workbook, brokerEvidence);
  const curveSheet = buildForwardCurvesSheet(workbook, modelCase);
  brokerRows.sheetOrder = brokerEvidence
    ? [
        "Operating Model",
        brokerEvidence.dividerName,
        "Brokers",
        ...brokerEvidence.sheets.map((sheet) => sheet.name),
        "Forward Curves",
      ]
    : ["Operating Model", "Brokers", "Forward Curves"];
  configureOperatingModel(
    workbook,
    operatingModel,
    modelCase,
    rowPlan,
    brokerRows,
    curveSheet.rows,
  );
  attachInputProvenance(operatingModel, rowPlan, modelCase, workbook);
  attachRowNotes(operatingModel, rowPlan, workbook);
  // LAST styling act of the build: reclaim the provenance channel on every cell
  // that holds a formula, whatever any earlier pass painted over it.
  const assertedFormulaProvenance = assertFormulaProvenance();
  workbook.recalculate();
  return {
    workbook,
    operatingModel,
    brokerRows,
    curveSheet,
    assertedFormulaProvenance,
  };
}

/**
 * `packaging` is `null` on the shipping path and supplied by
 * `build_package.mjs` on the local one. It carries the two things this file may
 * not import: `packageWriter`, the private artifact writer, and `extractPlan`,
 * the local reader that recovers a plan from a finished workbook.
 */
async function main(packaging = null) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const casePath = positional[0];
  const requestedOutputPath = options.out;
  if (!casePath || !requestedOutputPath) {
    throw new Error(
      "Usage: build_dynamic_model.mjs <case.json> --out <workbook.xlsx>",
    );
  }
  const outputPath = await assertWriteTargetOutsideSkill({
    skillRoot: SKILL_ROOT,
    target: requestedOutputPath,
  });
  // The package path, invoked without a writer, is handed to the local writer
  // before any work is done — solving the case twice to reach the same place
  // would be waste, and writing the coverage sidecar twice would be a lie about
  // which run produced it.
  if (!options["plan-only"] && packaging === null) {
    await runLocalPackageWriter(process.argv.slice(2));
    return;
  }
  const rawModelCase = JSON.parse(await fs.readFile(casePath, "utf8"));
  const assertThreePlusThree = (candidate, stage) => {
    const periods = candidate?.periods ?? [];
    const statuses = periods.map((period) => period.status);
    const valid =
      periods.length === 6 &&
      statuses.slice(0, 3).every((status) => status === "historical") &&
      statuses.slice(3).every((status) => status === "forecast");
    if (!valid) {
      throw new Error(
        `${stage}: the workbook contract is exactly three historical and three forecast periods; received ${statuses.join(", ") || "no periods"}.`,
      );
    }
  };
  assertThreePlusThree(rawModelCase, "Pre-compile period gate");
  ensureIllustrativeAcquisitionCase(rawModelCase);
  const validationErrors = validateCaseShape(rawModelCase);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid v2 case:\n- ${validationErrors.join("\n- ")}`);
  }
  const {
    model_case: modelCase,
    receipt: historicalNormalisationReceipt,
  } = applyHistoricalNormalisation(rawModelCase);
  assertThreePlusThree(modelCase, "Post-normalisation period gate");
  // Tier 1 before coverage: the anchor stamp changes the case's dependency
  // graph (a broker-treated headline is exogenous), so it must exist before
  // the coverage cycle gate reads that graph.
  applyTier1AnchorOwnership(modelCase);
  const coverage = assessCoverage(modelCase);
  const coveragePath = `${outputPath}.coverage.json`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    coveragePath,
    `${JSON.stringify(coverage, null, 2)}\n`,
    "utf8",
  );
  if (!coverage.ready_to_build) {
    throw new Error(
      `Coverage gate failed with ${coverage.summary.blockers} blocker(s). See ${coveragePath}.`,
    );
  }
  const standaloneCase = structuredClone(modelCase);
  if (standaloneCase.acquisition) {
    standaloneCase.acquisition.enabled = 0;
  }
  const instrumentPeriodState = compileInstrumentPeriodState(modelCase);
  const standaloneSolution = solveCase(standaloneCase, {
    instrumentPeriodState,
  });
  const proFormaSolution = solveCase(modelCase, {
    acquisitionBaseSolution: standaloneSolution,
    instrumentPeriodState,
  });
  const rowPlan = compileRowPlan(modelCase, { instrumentPeriodState });
  rowPlan.broker_metric_rows = brokerMetricRowMap(modelCase);
  const semanticManifest = compileSemanticManifest(modelCase, rowPlan, {
    instrumentPeriodState,
  });
  const sourceCrosswalk = compileSourceCrosswalk(
    modelCase,
    rowPlan,
    semanticManifest,
  );
  const modelIrV3 = compileModelIrV3({
    modelCase,
    rowPlan,
    semanticManifest,
    sourceCrosswalk,
  });
  assertModelIrV3Pass(modelIrV3);
  const modelIrReceipt = transformationReceipt(modelIrV3);
  const forecastReceipt = forecastDecisionReceipt(modelIrV3);
  const shadowComparison = shadowSemanticComparison(
    semanticManifest,
    modelIrV3,
  );
  const workbookProofContract = workbookSemanticProofContract(
    modelIrV3,
    rowPlan,
    { brokerEvidence: brokerEvidenceProofSpec(compileBrokerEvidenceLayout(modelCase)) },
  );
  if (shadowComparison.status !== "PASS") {
    throw new Error(
      `Candidate semantic shadow comparison blocked: ${JSON.stringify(shadowComparison)}`,
    );
  }
  // ---- PLAN ONLY ----------------------------------------------------------
  // The whole point of Phase 2.6. This branch produces a certified render plan
  // for a case the model has never seen, reads no file, runs no converter and
  // never touches private workbook library. `python3 -m emit build <plan> --out
  // <workbook.xlsx>` turns it into the workbook.
  if (options["plan-only"]) {
    const synthesis = synthesisePlan({
      modelCase,
      rowPlan,
      outputPath,
      standaloneSolution,
      proFormaSolution,
    });
    if (synthesis.unresolved_caches.length > 0) {
      throw new Error(
        `${synthesis.unresolved_caches.length} formula cell(s) could not be given a cached value:\n- ` +
          synthesis.unresolved_caches
            .slice(0, 20)
            .map((entry) => `${entry.cell}: ${entry.reason}`)
            .join("\n- "),
      );
    }
    const planCounts = gatePlan(
      synthesis.plan,
      rowPlan,
      synthesis.brokerRows,
      await readPlanSchema(),
      "synthesised",
    );
    const planPath = `${outputPath}.plan.json`;
    await fs.writeFile(
      planPath,
      `${JSON.stringify(synthesis.plan, null, 1)}\n`,
      "utf8",
    );
    await writeModelSidecars(outputPath, {
      rowPlan,
      semanticManifest,
      sourceCrosswalk,
      modelIrV3,
      modelIrReceipt,
      forecastReceipt,
      shadowComparison,
      workbookProofContract,
      modelCase,
      standaloneSolution,
      proFormaSolution,
      historicalNormalisationReceipt,
    });
    console.log(
      JSON.stringify({
        status: "PLANNED",
        plan: path.resolve(planPath),
        case_id: modelCase.case_id,
        instrument_count: rowPlan.instruments.length,
        last_row: rowPlan.visible_end_row,
        historical_cached_cells: synthesis.historical_cached_cells,
        solver_cached_cells: synthesis.solver_cached_cells,
        evaluated_cached_cells: synthesis.evaluated_cached_cells,
        unresolved_caches: synthesis.unresolved_caches.length,
        plan_assertions: planCounts,
        solver_checks_pass:
          standaloneSolution.all_checks_pass && proFormaSolution.all_checks_pass,
      }),
    );
    return;
  }

  const { packageWriter, extractPlan } = packaging;
  const { Workbook, SpreadsheetFile } = packageWriter;
  const { workbook, assertedFormulaProvenance, brokerRows } = emitWorkbook(
    () => Workbook.create(),
    modelCase,
    rowPlan,
  );
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(outputPath);
  await patchWorkbookProperties(outputPath, rowPlan);
  const sofficePath = await resolveSoffice(options.soffice);
  const refreshedFormulaCaches = await refreshFormulaCaches(
    outputPath,
    sofficePath,
  );
  // DEFECT 0.3. The count used to be printed and never tested. A healthy build
  // of any case in the suite recalculates well over a thousand cells; zero
  // means the conversion ran and wrote nothing back, which is indistinguishable
  // in the output from a build that never recalculated at all.
  if (!(refreshedFormulaCaches > 0)) {
    throw new Error(
      `Formula-cache recalculation wrote ${refreshedFormulaCaches} cells using ${sofficePath}. ` +
        "A build whose caches were never recalculated cannot be certified: every number a reader " +
        "sees before Excel recalculates would be the in-process writer's, not the workbook's own formulas'.",
    );
  }
  // Read the recalculated caches BEFORE the solver patch: the historical and
  // pro-forma-historical columns are the prior period the first forecast year
  // looks back at, and they are only authoritative while they are still the
  // recalculation's own output.
  const recalculatedCaches = await worksheetNumericCaches(outputPath);
  const solverCaches = solverFormulaCaches(
    modelCase,
    rowPlan,
    standaloneSolution,
    proFormaSolution,
    recalculatedCaches,
  );
  const solverPatchedFormulaCaches = await patchNumericFormulaCaches(
    outputPath,
    solverCaches,
  );
  await patchWorkbookProperties(outputPath, rowPlan);
  await patchFreezePane(outputPath, rowPlan);
  const outlinedRows = await patchRowOutlines(outputPath, rowPlan);
  const groupedBrokerRows = await patchBrokersSheetChrome(
    outputPath,
    brokerRows.headerRow,
    brokerRows.contributorRows,
  );
  const indentedLabels = await patchLabelIndents(outputPath, rowPlan);
  const centredBlockTitles = await patchBlockTitleAlignment(outputPath, rowPlan);
  // LAST of the package passes, and measured on both sides. `fonts[0]` is the
  // unit every stored column width is expressed in, so the rename is only safe
  // if not one of them moved — and "Carlito and Calibri are metric-compatible"
  // is a claim about two font files, not about what this package now contains.
  const widthsBeforeDefaultFont = await worksheetColumnWidths(outputPath);
  const defaultFontPatched = await patchDefaultFont(outputPath);
  const widthsAfterDefaultFont = await worksheetColumnWidths(outputPath);
  if (
    JSON.stringify(widthsBeforeDefaultFont) !==
    JSON.stringify(widthsAfterDefaultFont)
  ) {
    throw new Error(
      "Renaming the workbook default font to Calibri changed a stored column width. " +
        "That is not a rename, it is a re-layout, and the workbook cannot be certified: " +
        `before ${JSON.stringify(widthsBeforeDefaultFont)} after ${JSON.stringify(widthsAfterDefaultFont)}.`,
    );
  }
  // ---- L5 PLAN ------------------------------------------------------------
  // LAST. The plan describes the workbook AS SHIPPED, so it is captured after
  // every pass that changes a formula, a value or a style — which means after
  // both `patchWorkbookProperties` calls (the adjustment gate and the
  // pro-forma-historical rewrite), after the solver cache patch, and after all
  // five terminal package passes. Emitting it any earlier would describe a
  // workbook that does not exist.
  const planPath = `${outputPath}.plan.json`;
  const plan = await extractPlan(outputPath, { caseId: modelCase.case_id });
  // Deterministic on purpose: a wall clock here would make two builds of the
  // same case differ, and the renderer stamps docProps from this very field.
  plan.generator = {
    tool: "build_dynamic_model.mjs",
    source: path.basename(outputPath),
    stage: "shipped",
  };
  const planSchema = await readPlanSchema();
  const planCounts = gatePlan(plan, rowPlan, brokerRows, planSchema, "captured");
  // ---- L5 PLAN, SYNTHESISED ------------------------------------------------
  // The same emitter run against a plan builder instead of a package writer.
  // Nothing here reads a file: the styles are interned in Node, the cached
  // values come from the solver, and the six facts the package passes used to
  // add are recorded through the same selectors those passes use. This is the
  // plan a machine WITHOUT legacy workbook library can produce.
  const synthesis = synthesisePlan({
    modelCase,
    rowPlan,
    outputPath,
    standaloneSolution,
    proFormaSolution,
  });
  await fs.writeFile(
    `${outputPath}.plan-y.json`,
    `${JSON.stringify(synthesis.plan, null, 1)}\n`,
    "utf8",
  );
  // THE TWO CACHE MAPS MUST AGREE, and this is where they are made to say so.
  // `solverCaches` above was seeded from the RECALCULATED package's historical
  // columns; `synthesis.solver_caches` was seeded from the plan's own. If the
  // plan's arithmetic and LibreOffice's ever parted company on the last
  // historical column, every forecast row that looks backwards out of it would
  // ship a different number — and the only visible symptom would be a growth
  // rate that changes the first time somebody recalculates.
  const cacheDisagreements = [];
  for (const [address, value] of solverCaches) {
    const mine = synthesis.solver_caches.get(address);
    if (mine === undefined) {
      cacheDisagreements.push(`${address}: plan-derived seed produced no value`);
      continue;
    }
    const scale = Math.max(Math.abs(value), Math.abs(mine), 1);
    if (Math.abs(value - mine) > 1e-9 * scale) {
      cacheDisagreements.push(`${address}: package ${value} vs plan ${mine}`);
    }
  }
  if (cacheDisagreements.length > 0) {
    throw new Error(
      "The solver's cached values differ depending on where the prior-period seed came from:\n- " +
        cacheDisagreements.slice(0, 20).join("\n- "),
    );
  }
  if (synthesis.unresolved_caches.length > 0) {
    throw new Error(
      `${synthesis.unresolved_caches.length} formula cell(s) could not be given a cached value:\n- ` +
        synthesis.unresolved_caches
          .slice(0, 20)
          .map((entry) => `${entry.cell}: ${entry.reason}`)
          .join("\n- "),
    );
  }
  // The synthesised plan is held to the SAME gate as the captured one, so the
  // evidence for the plan that can ship is not merely that it agrees with a
  // plan that was checked.
  const synthesisedCounts = gatePlan(
    synthesis.plan,
    rowPlan,
    synthesis.brokerRows,
    planSchema,
    "synthesised",
  );
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 1)}\n`, "utf8");
  await writeModelSidecars(outputPath, {
    rowPlan,
    semanticManifest,
    sourceCrosswalk,
    modelIrV3,
    modelIrReceipt,
    forecastReceipt,
    shadowComparison,
    workbookProofContract,
    modelCase,
    standaloneSolution,
    proFormaSolution,
    historicalNormalisationReceipt,
  });
  // DEFECT 0.12, THE GENERAL DEFENCE. Every one of these counts is a scanner's
  // report of how much of the workbook it managed to see. They were all
  // printed and none was tested — which is how one formula scanner elsewhere
  // in this repository found ZERO formulas in a 1,069-formula workbook and
  // reported a clean pass. A count of zero here is not "nothing needed doing";
  // on any case in the suite it means the pass ran against a shape it did not
  // recognise.
  const emptyScanners = Object.entries({
    asserted_formula_provenance: assertedFormulaProvenance,
    refreshed_formula_caches: refreshedFormulaCaches,
    solver_patched_formula_caches: solverPatchedFormulaCaches,
    outlined_rows: outlinedRows,
    grouped_broker_rows: groupedBrokerRows,
    indented_labels: indentedLabels,
    centred_block_titles: centredBlockTitles,
    default_font_patched: defaultFontPatched,
    // The plan assertions are scanners too, and the same rule binds them: a
    // gate check that visited no gated cell has described its own selector.
    plan_adjustment_gate_cells: planCounts.adjustment_gate_cells,
    plan_pro_forma_historical_cells: planCounts.pro_forma_historical_cells,
    plan_outlined_rows: planCounts.outlined_rows,
    plan_indented_labels: planCounts.indented_labels,
    plan_centred_block_titles: planCounts.centred_block_titles,
    plan_grouped_broker_rows: planCounts.grouped_broker_rows,
    // The synthesised plan's cached layer, counted the same way. `historical`
    // is the acyclic face the solver's horizon does not reach, `solver` is the
    // three forecast years, and `evaluated` is everything that was still
    // uncached after both — the Brokers selector chiefly. A zero in any of
    // them means a population this build believes it filled was never visited.
    synthesised_historical_caches: synthesis.historical_cached_cells,
    synthesised_solver_caches: synthesis.solver_cached_cells,
    synthesised_evaluated_caches: synthesis.evaluated_cached_cells,
    synthesised_adjustment_gate_cells: synthesisedCounts.adjustment_gate_cells,
    synthesised_grouped_broker_rows: synthesisedCounts.grouped_broker_rows,
  }).filter(([, count]) => !(Number(count) > 0));
  if (emptyScanners.length > 0) {
    throw new Error(
      "These build passes visited nothing and cannot be reported as done: " +
        emptyScanners.map(([name, count]) => `${name}=${count}`).join(", ") +
        ". A pass that matched no cells has described its own regex, not the workbook.",
    );
  }
  console.log(
    JSON.stringify({
      status: "BUILT",
      output: path.resolve(outputPath),
      case_id: modelCase.case_id,
      instrument_count: rowPlan.instruments.length,
      hidden_support_rows: 0,
      last_row: rowPlan.visible_end_row,
      asserted_formula_provenance: assertedFormulaProvenance,
      refreshed_formula_caches: refreshedFormulaCaches,
      solver_patched_formula_caches: solverPatchedFormulaCaches,
      outlined_rows: outlinedRows,
      grouped_broker_rows: groupedBrokerRows,
      indented_labels: indentedLabels,
      centred_block_titles: centredBlockTitles,
      default_font_patched: defaultFontPatched,
      plan: path.resolve(planPath),
      plan_assertions: planCounts,
      synthesised_plan: path.resolve(`${outputPath}.plan-y.json`),
      synthesised_caches: {
        historical: synthesis.historical_cached_cells,
        solver: synthesis.solver_cached_cells,
        evaluated: synthesis.evaluated_cached_cells,
        unresolved: synthesis.unresolved_caches.length,
      },
      solver_checks_pass:
        standaloneSolution.all_checks_pass &&
        proFormaSolution.all_checks_pass,
    }),
  );
}

// RUN ONLY WHEN RUN, NOT WHEN IMPORTED — and export the plan declaration so it
// can be tested on its own.
//
// An assertion nobody has ever seen FAIL is not evidence; it is a comment with
// a runtime cost. The gate and the R rewrite are applied to the package after
// export, so the check that the plan carries them is the only thing standing
// between "the plan describes the shipped workbook" and "the plan describes
// whatever the extractor happened to read". Exporting it makes that check
// falsifiable by a negative test rather than only by a build that never fails.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}

// `main` is exported for scripts/build_package.mjs, the local-only `--out`
// driver. It is the same `main()` this file runs when it is invoked directly;
// there is no second copy of the build for the certification path to drift from.
export { assertShippedPlan, declareShippedFacts, main };
