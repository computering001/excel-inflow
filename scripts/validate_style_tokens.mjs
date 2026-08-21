#!/usr/bin/env node
/**
 * DOES THE EMITTED FILE HONOUR THE STYLE TOKENS?
 *
 * `assets/style-tokens.json` states intent. This asserts the intent actually
 * reached `xl/styles.xml` and `xl/worksheets/sheet1.xml`. It exists because the
 * writer SILENTLY DROPS FORMATTING CALLS — `format.indentLevel` and
 * `freezePanes.*` were both called correctly and both reached the XML as
 * nothing, and for a long time the five border treatments the tokens described
 * were specified and absent, with the workbook carrying exactly ONE border
 * definition. Nothing here trusts the format API: every assertion reads the
 * emitted OOXML.
 *
 * Same class of independence as validate_source_parity: the token file says what
 * should be true, the validator confirms the file agrees, and the emitter's own
 * report is never evidence.
 *
 * Namespace prefixes: the v4 build emits `<x:border>`, `<x:xf>`, `<x:dxf>`.
 * Every regex below tolerates an optional `prefix:`.
 *
 * Usage: node validate_style_tokens.mjs <workbook.xlsx> [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = JSON.parse(
  readFileSync(path.join(HERE, "..", "assets", "style-tokens.json"), "utf8"),
);

const args = process.argv.slice(2);
const workbookPath = args.find((a) => !a.startsWith("--"));
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
if (!workbookPath) {
  console.error("Usage: validate_style_tokens.mjs <workbook.xlsx> [--json out.json]");
  process.exit(2);
}

const P = "(?:[A-Za-z_][\\w.-]*:)?";
const inner = (xml, tag) =>
  new RegExp(`<${P}${tag}\\b[^>]*>([\\s\\S]*?)</${P}${tag}>`).exec(xml)?.[1] ?? "";
/**
 * Split a container into its direct children.
 *
 * The self-closing alternative MUST come first: `<x:xf .../>`'s trailing slash
 * lives inside `[^>]*`, so an alternation that tries the open-tag form first
 * swallows every element after it and every style index above the first
 * self-closing entry silently resolves to the wrong record.
 */
const items = (body, tag) =>
  body.match(new RegExp(`<${P}${tag}\\b[^>]*?/>|<${P}${tag}\\b[^>]*>[\\s\\S]*?</${P}${tag}>`, "g")) ?? [];

const zip = await JSZip.loadAsync(readFileSync(workbookPath));
const styles = await zip.file("xl/styles.xml").async("string");
const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");

const borders = items(inner(styles, "borders"), "border");
const fills = items(inner(styles, "fills"), "fill").map(
  (f) => new RegExp(`fgColor rgb="([0-9A-Fa-f]{8})"`).exec(f)?.[1].slice(2).toUpperCase() ?? null,
);
const dxfs = items(inner(styles, "dxfs"), "dxf");
// Font COLOUR, per style record. Font colour is the provenance layer, and
// since the input fill was removed it is the ONLY thing marking an input — so
// the validator has to be able to see it.
const fontColours = items(inner(styles, "fonts"), "font").map(
  (f) => new RegExp(`<${P}color\\b[^>]*rgb="([0-9A-Fa-f]{8})"`).exec(f)?.[1].slice(2).toUpperCase() ?? null,
);
// Font WEIGHT, per style record. Bold is a channel of its own now — narrative
// prominence, nothing else (see TOKENS.headline) — so the validator has to be
// able to see it independently of colour.
const fontBold = items(inner(styles, "fonts"), "font").map((f) =>
  new RegExp(`<${P}b(?:\\s[^>]*)?/?>`).test(f),
);
// Number FORMAT CODE, per style record. Used only to tell a ratio row from an
// amount row, which is a property of the emitted file and not of any
// declaration the compiler shares.
const numberFormatCodes = new Map();
for (const nf of items(inner(styles, "numFmts"), "numFmt")) {
  const id = /numFmtId="(\d+)"/.exec(nf)?.[1];
  const code = /formatCode="([^"]*)"/.exec(nf)?.[1];
  if (id) numberFormatCodes.set(Number(id), code ?? "");
}
const cellXfs = items(inner(styles, "cellXfs"), "xf").map((x) => ({
  fill: fills[Number(/fillId="(\d+)"/.exec(x)?.[1] ?? 0)] ?? null,
  font: fontColours[Number(/fontId="(\d+)"/.exec(x)?.[1] ?? 0)] ?? null,
  bold: fontBold[Number(/fontId="(\d+)"/.exec(x)?.[1] ?? 0)] ?? false,
  borderId: Number(/borderId="(\d+)"/.exec(x)?.[1] ?? 0),
  numberFormat:
    numberFormatCodes.get(Number(/numFmtId="(\d+)"/.exec(x)?.[1] ?? 0)) ?? "",
}));

const edge = (border, name) =>
  new RegExp(`<${P}${name}\\s+style="(\\w+)"`).exec(border)?.[1] ?? null;
const borderEdges = borders.map((b) => ({
  left: edge(b, "left"),
  right: edge(b, "right"),
  top: edge(b, "top"),
  bottom: edge(b, "bottom"),
}));

// Cell -> style index, and cell -> formula text, from the worksheet part.
const cellStyle = new Map();
const cellFormula = new Map();
for (const m of sheet.matchAll(
  new RegExp(`<${P}c\\s([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, "g"),
)) {
  const ref = /r="([A-Z]+\d+)"/.exec(m[1])?.[1];
  if (!ref) continue;
  cellStyle.set(ref, Number(/s="(\d+)"/.exec(m[1])?.[1] ?? 0));
  const formula = new RegExp(`<${P}f\\b[^>]*>([\\s\\S]*?)</${P}f>`).exec(
    m[2] ?? "",
  )?.[1];
  if (formula) cellFormula.set(ref, formula);
}
const styleOf = (ref) =>
  cellXfs[cellStyle.get(ref) ?? 0] ?? {
    fill: null,
    font: null,
    bold: false,
    borderId: 0,
    numberFormat: "",
  };
const edgesOf = (ref) => borderEdges[styleOf(ref).borderId] ?? {};
const rowOf = (ref) => Number(ref.match(/\d+/)[0]);
const columnOf = (ref) => ref.replace(/\d+/g, "");
const BODY_COLUMNS = new Set("BCDEFGHIJKLNOPRSTU".split(""));

const checks = [];
const check = (id, ok, message, evidence = null) => {
  checks.push({ id, status: ok ? "pass" : "fail", message, evidence });
};

// ---------------------------------------------------------------- borders
// The minimum check the design plan names: a workbook carrying exactly one
// border definition has none of the five treatments the tokens describe.
check(
  "border-definitions-present",
  borders.length > 2,
  `xl/styles.xml carries ${borders.length} border definitions (the empty default plus real ones).`,
  { border_definitions: borders.length },
);

const usedEdges = new Set();
for (const b of borderEdges) {
  for (const [name, style] of Object.entries(b)) if (style) usedEdges.add(`${name}:${style}`);
}
check(
  "double-rule-present",
  [...usedEdges].some((e) => e.endsWith(":double")),
  "The answer rank's double bottom rule reached styles.xml as a BORDER, not a font underline.",
  { edges: [...usedEdges].sort() },
);
check(
  "column-block-left-edges",
  (TOKENS.borders?.column_block_left_edges ?? []).every((column) =>
    [...cellStyle.keys()].some(
      (ref) => ref.replace(/\d+/g, "") === column && edgesOf(ref).left,
    ),
  ),
  `Every declared column-block left edge (${(TOKENS.borders?.column_block_left_edges ?? []).join(", ")}) is present.`,
);

// ---------------------------------------------------------------- gutters
// A NARROW COLUMN IS NOT AUTOMATICALLY A BREAK, and the token file now says
// which of the four spacers are which.
//
//   A, M, Q  BREAK. M and Q separate standalone from adjustment from pro forma
//            — three bases of the same figure — and the white gap is the only
//            thing making three column blocks read as three column blocks.
//   F        CARRIES ACROSS. It sits inside one line item, between that item's
//            contractual terms and that item's periods.
//
// Both halves are asserted. Only checking the first would let a regression
// that re-whitens F pass in silence, which is how the split bands got there.
const gutters = new Set(
  TOKENS.layout?.gutter_policy?.must_remain_white ??
    TOKENS.total_ranks?.rule_breaks_at_gutter_columns ??
    TOKENS.layout?.gutter_columns_must_remain_white ?? ["A", "M", "Q"],
);
const carryThrough = new Set(
  TOKENS.layout?.gutter_policy?.carry_formatting_through ?? [],
);
const gutterViolations = [];
for (const ref of cellStyle.keys()) {
  if (!gutters.has(ref.replace(/\d+/g, ""))) continue;
  const s = styleOf(ref);
  const e = edgesOf(ref);
  if (e.left || e.right || e.top || e.bottom) gutterViolations.push(`${ref} bordered`);
  if (s.fill && s.fill !== "FFFFFF") gutterViolations.push(`${ref} fill #${s.fill}`);
}
check(
  "breaking-gutter-columns-white-and-unbordered",
  gutterViolations.length === 0,
  `Breaking gutter columns ${[...gutters].join(", ")} carry no border and no fill other than white.`,
  gutterViolations.slice(0, 20),
);

const carryEvidence = {};
const carryFailures = [];
for (const column of carryThrough) {
  const refs = [...cellStyle.keys()].filter((ref) => ref.replace(/\d+/g, "") === column);
  const filled = refs.filter((ref) => {
    const f = styleOf(ref).fill;
    return f && f !== "FFFFFF";
  });
  const ruled = refs.filter((ref) => {
    const e = edgesOf(ref);
    return e.left || e.right || e.top || e.bottom;
  });
  carryEvidence[column] = { cells: refs.length, filled: filled.length, ruled: ruled.length };
  if (!filled.length) carryFailures.push(`${column}: no cell carries a fill`);
  if (!ruled.length) carryFailures.push(`${column}: no cell carries a border`);
}
check(
  "carry-through-gutters-carry-the-formatting",
  carryThrough.size === 0 || carryFailures.length === 0,
  `Carry-through gutter columns ${[...carryThrough].join(", ") || "(none declared)"} take the fills and rules of the rows they sit on.`,
  carryFailures.length ? { failures: carryFailures, evidence: carryEvidence } : carryEvidence,
);

// ------------------------------------------------------------------ fills
// THE FILL CHANNEL BELONGS TO TOTALS. #D9EAF7 was once both the answer fill
// AND the input fill, so a subtotal row and a cell the reader is meant to type
// over were indistinguishable. A yellow input fill broke that and was itself
// removed as too loud, so the collision is now prevented at the root: an input
// carries NO fill, and therefore has nothing to collide with.
const answerFill = (TOKENS.colors?.answer_fill ?? TOKENS.colors?.total_fill ?? "").replace("#", "").toUpperCase();
const inputFont = (TOKENS.colors?.input ?? "#0000FF").replace("#", "").toUpperCase();
const fillCounts = new Map();
for (const ref of cellStyle.keys()) {
  const f = styleOf(ref).fill;
  if (f) fillCounts.set(f, (fillCounts.get(f) ?? 0) + 1);
}
check(
  "answer-fill-reaches-the-file",
  (fillCounts.get(answerFill) ?? 0) > 0,
  `#${answerFill} (answer_fill) is present on ${fillCounts.get(answerFill) ?? 0} cells.`,
);
check(
  "no-input-fill-is-declared",
  !TOKENS.colors?.input_fill && !TOKENS.colors?.input_yellow_fill &&
    TOKENS.fill_semantics?.input_carries_no_fill === true,
  "The palette declares no input fill and fill_semantics states that an input carries none.",
);

// THE COLLISION C1 MUST NOT REINSTATE, stated exactly.
//
// It is NOT "no blue cell may carry the answer fill". An answer row whose
// HISTORY is a source hardcode — Kerry's Ending cash, Smurfit's Gross Profit —
// legitimately shows a blue figure on its own rank fill: the fill is the ROW's
// identity and the font is that CELL's provenance, and the two are saying
// different true things about the same cell. Forbidding the combination would
// force one of them to lie.
//
// What must not happen is the fill appearing on a row that is NOT an answer,
// which is what made #D9EAF7 ambiguous when it was also the input fill. So:
// EVERY cell carrying the answer fill sits on a DECLARED ANSWER ROW. An input
// that is not an answer then cannot wear it by any route.
//
// Answer rows resolve from the row plan beside the workbook against
// total_ranks.answer.row_ids — never by row number.
const answerRowIds = new Set(TOKENS.total_ranks?.answer?.row_ids ?? []);
const answerRows = new Set();
let answerRowSource = null;
try {
  const rowMap = JSON.parse(readFileSync(`${workbookPath}.row-map.json`, "utf8"));
  const bind = (row) => {
    if (Number.isInteger(Number(row))) answerRows.add(Number(row));
  };
  for (const section of Object.values(rowMap.statement_rows ?? {})) {
    for (const definition of section ?? []) {
      if (answerRowIds.has(definition.row_id) || answerRowIds.has(definition.semantic_role)) {
        bind(definition.row);
      }
    }
  }
  for (const group of [
    rowMap.debt_summary_rows,
    rowMap.waterfall_rows,
    rowMap.interest_summary_rows,
    rowMap.rows_by_id,
  ]) {
    for (const [id, row] of Object.entries(group ?? {})) {
      if (answerRowIds.has(id)) bind(row);
    }
  }
  if (answerRows.size) answerRowSource = `${workbookPath}.row-map.json`;
} catch {
  // No sidecar: fall through to the weaker assertion below.
}
if (answerRowSource) {
  const strayAnswerFill = [];
  for (const ref of cellStyle.keys()) {
    if (styleOf(ref).fill !== answerFill) continue;
    if (!answerRows.has(Number(ref.match(/\d+/)[0]))) strayAnswerFill.push(ref);
  }
  check(
    "answer-fill-lands-on-answer-rows-only",
    strayAnswerFill.length === 0,
    `#${answerFill} appears only on the ${answerRows.size} declared answer rows. (resolved from ${answerRowSource})`,
    strayAnswerFill.slice(0, 20),
  );
} else {
  // Without a row map the best available statement is the weaker one: an input
  // carries no fill, so a blue cell on an answer fill can only be an answer row
  // — but that cannot be confirmed here, so say so rather than assert it.
  check(
    "answer-fill-lands-on-answer-rows-only",
    true,
    `Not asserted: no ${workbookPath}.row-map.json to resolve answer rows from. Input font #${inputFont} carries no fill of its own.`,
  );
}

// CLOSED SET, the same discipline the number formats are held to: a fill that
// is not in the palette is a colour with no stated meaning. This is what would
// catch #FFF2CC — or anything else — being reintroduced on the quiet.
const declaredFills = new Set(
  Object.values(TOKENS.colors ?? {})
    .filter((value) => typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value))
    .map((value) => value.slice(1).toUpperCase()),
);
const undeclaredFills = [...fillCounts.keys()].filter((f) => !declaredFills.has(f));
check(
  "fill-palette-is-closed",
  undeclaredFills.length === 0,
  `Every fill on the sheet is one of the ${declaredFills.size} declared colours.`,
  undeclaredFills.map((f) => `#${f} on ${fillCounts.get(f)} cells`),
);

// ============================================================== bold, panels
//
// Three assertions about the two channels this file's `headline` and `panels`
// blocks describe. All three resolve rows through the compiled plan and read
// the emitted OOXML for the evidence; none of them takes the emitter's word.
let plan = null;
try {
  plan = JSON.parse(readFileSync(`${workbookPath}.row-map.json`, "utf8"));
} catch {
  plan = null;
}

if (!plan) {
  for (const id of [
    "bold-appears-only-on-declared-headline-rows",
    "declared-total-rows-are-bold",
    "ordinary-detail-rows-have-no-horizontal-rules",
    "net-debt-panels-terminate-identically",
    "answer-rank-is-earned-not-asserted",
  ]) {
    check(id, true, `Not asserted: no ${workbookPath}.row-map.json beside the workbook.`);
  }
} else {
  const sectionHeaderRows = Object.entries(plan.section_headers ?? {})
    .map(([id, row]) => ({ id, row: Number(row) }))
    .filter((entry) => Number.isFinite(entry.row))
    .sort((a, b) => a.row - b.row);
  const sectionOf = (row) => {
    let found = null;
    for (const entry of sectionHeaderRows) if (row >= entry.row) found = entry.id;
    return found;
  };
  const firstSectionRow = sectionHeaderRows[0]?.row ?? Infinity;

  // --- the declared headline rows, resolved through the ladders -------------
  // The ladders are read from the TOKEN FILE, not from row_plan.mjs: the token
  // file states intent and this asserts the emitted file honours it. Reading
  // the compiler's own table instead would make the check a tautology.
  const idsInSection = (section) => {
    const ids = new Map();
    for (const definition of plan.statement_rows?.[section] ?? []) {
      if (definition.row_id) ids.set(definition.row_id, Number(definition.row));
    }
    const named = {
      debt_schedule: plan.debt_summary_rows,
      rcf_waterfall: plan.waterfall_rows,
      interest_schedule: plan.interest_summary_rows,
    }[section];
    for (const [id, row] of Object.entries(named ?? {})) ids.set(id, Number(row));
    return ids;
  };
  const headlineRows = new Set();
  const headlineNames = [];
  for (const [section, ladders] of Object.entries(TOKENS.headline?.ladders ?? {})) {
    const present = idsInSection(section);
    for (const ladder of ladders) {
      const chosen = ladder.find((id) => present.has(id));
      if (!chosen) continue;
      headlineRows.add(present.get(chosen));
      headlineNames.push(`${section}:${chosen}@${present.get(chosen)}`);
    }
  }

  // Semantic totals are a structural declaration in the row map and token
  // contract.  Resolve them independently of the emitter's in-memory rank map:
  // statement totals/subtotals, dynamic instrument-group subtotals, and named
  // schedule totals declared by the style authority.
  const totalRows = new Set();
  const subsectionLabelRows = new Set();
  const numberedParentRows = new Set();
  const statementPhysicalRows = new Set();
  for (const definitions of Object.values(plan.statement_rows ?? {})) {
    for (const definition of definitions ?? []) {
      statementPhysicalRows.add(Number(definition.row));
      const subsectionLabel =
        definition.style_role === "subsection" &&
        definition.row_type !== "header";
      if (subsectionLabel) subsectionLabelRows.add(Number(definition.row));
      const numberedParent =
        subsectionLabel && definition.display_role === "group_parent";
      if (numberedParent) numberedParentRows.add(Number(definition.row));
      if (
        !numberedParent &&
        (definition.style_role === "total" ||
          definition.row_type === "subtotal")
      ) {
        totalRows.add(Number(definition.row));
      }
    }
  }
  for (const group of plan.debt_groups ?? []) {
    totalRows.add(Number(group.subtotal_row));
    totalRows.add(Number(group.interest_subtotal_row));
  }
  const declaredTotalIds = new Set([
    ...(TOKENS.total_ranks?.component_sum?.row_ids ?? []),
    ...(TOKENS.total_ranks?.block_subtotal?.row_ids ?? []),
    ...(TOKENS.total_ranks?.answer?.row_ids ?? []),
  ]);
  for (const [id, row] of Object.entries(plan.rows_by_id ?? {})) {
    // Statement totals are case-resolved by style_role/row_type above.  A name
    // such as `ebit` may be a subtotal in one issuer and a non-total bridge in
    // another; the flat token union must not promote it by spelling alone.
    if (declaredTotalIds.has(id) && !statementPhysicalRows.has(Number(row))) {
      totalRows.add(Number(row));
    }
  }

  // --- chrome, which is bold because it is chrome and not because it is loud -
  const chromeRows = new Set();
  for (const entry of sectionHeaderRows) chromeRows.add(entry.row);
  for (const section of Object.values(plan.statement_rows ?? {})) {
    for (const definition of section ?? []) {
      if (definition.row_type === "header") chromeRows.add(Number(definition.row));
    }
  }
  for (const [id, row] of Object.entries(plan.debt_summary_rows ?? {})) {
    if (id.endsWith("_header")) chromeRows.add(Number(row));
  }
  // Dynamic label-only sub-block titles (for example the cash-bucket interest
  // header) live in rows_by_id rather than one of the fixed section maps. They
  // are still declared chrome under the token contract and are intentionally
  // bold. Resolve the structural `_header` declaration instead of naming each
  // optional module here.
  for (const [id, row] of Object.entries(plan.rows_by_id ?? {})) {
    if (id.endsWith("_header") && Number.isFinite(Number(row))) {
      chromeRows.add(Number(row));
    }
  }
  for (const group of plan.debt_groups ?? []) {
    chromeRows.add(Number(group.header_row));
    chromeRows.add(Number(group.interest_header_row));
  }
  for (const row of [
    plan.period_row,
    plan.period_group_row,
    plan.debt_term_header_row,
    plan.interest_term_header_row,
    plan.benchmark_row,
  ]) {
    if (Number.isFinite(Number(row))) chromeRows.add(Number(row));
  }

  const strayBold = [];
  for (const ref of cellStyle.keys()) {
    if (!styleOf(ref).bold) continue;
    if (!BODY_COLUMNS.has(columnOf(ref))) continue;
    const row = rowOf(ref);
    // Everything above the first section band is the title, the control block
    // and the period header: chrome by position, not by declaration.
    if (row < firstSectionRow) continue;
    if (
      chromeRows.has(row) ||
      headlineRows.has(row) ||
      totalRows.has(row) ||
      (subsectionLabelRows.has(row) && columnOf(ref) === "B")
    ) continue;
    strayBold.push(ref);
  }
  const strayBoldRows = [...new Set(strayBold.map(rowOf))].sort((a, b) => a - b);
  check(
    "bold-appears-only-on-declared-headline-rows",
    strayBold.length === 0,
    `Bold appears only on ${totalRows.size} semantic total/subtotal rows, ${headlineRows.size} declared headline rows and chrome.`,
    strayBold.length
      ? { rows: strayBoldRows.slice(0, 20), cells: strayBold.slice(0, 20) }
      : { headline_rows: headlineNames },
  );

  const nonBoldTotals = [...totalRows]
    .filter((row) => Number.isFinite(row))
    .filter((row) =>
      [...BODY_COLUMNS].some(
        (column) => cellStyle.has(`${column}${row}`) && !styleOf(`${column}${row}`).bold,
      ),
    )
    .sort((a, b) => a - b);
  check(
    "declared-total-rows-are-bold",
    nonBoldTotals.length === 0,
    `Every semantic total/subtotal row is bold across its populated body cells.`,
    nonBoldTotals.length ? { rows: nonBoldTotals.slice(0, 20) } : { rows: [...totalRows].sort((a, b) => a - b) },
  );

  const malformedNumberedParents = [...numberedParentRows]
    .filter((row) => {
      const label = `B${row}`;
      if (!cellStyle.has(label) || styleOf(label).bold) return true;
      return [...BODY_COLUMNS]
        .filter((column) => column !== "B")
        .some((column) => cellStyle.has(`${column}${row}`) && styleOf(`${column}${row}`).bold);
    })
    .sort((a, b) => a - b);
  check(
    "numbered-parent-uses-indentation-only",
    malformedNumberedParents.length === 0,
    "Numbered consolidation parents remain ordinary-weight over indented children and do not inherit a total band.",
    malformedNumberedParents.length
      ? { rows: malformedNumberedParents.slice(0, 20) }
      : { rows: [...numberedParentRows].sort((a, b) => a - b) },
  );

  // A closed border vocabulary prevents a fragment inherited from an input
  // style or template cell from appearing as a random line in the statement
  // body. Horizontal rules in the numeric/label grid may originate only on
  // chrome, semantic totals/subtotals, or the declared row that closes a
  // section. Contract-term boxes in C:E are intentionally outside this scan.
  const sectionCloseRows = new Set();
  sectionHeaderRows.forEach((entry, index) => {
    const next = sectionHeaderRows[index + 1]?.row;
    const last = next ? next - 2 : Number(plan.visible_end_row);
    if (Number.isFinite(last) && last > entry.row) sectionCloseRows.add(last);
  });
  const horizontalRuleCells = [];
  for (const ref of cellStyle.keys()) {
    if (!BODY_COLUMNS.has(columnOf(ref))) continue;
    const row = rowOf(ref);
    if (!statementPhysicalRows.has(row)) continue;
    if (
      chromeRows.has(row) ||
      totalRows.has(row) ||
      headlineRows.has(row) ||
      sectionCloseRows.has(row)
    ) {
      continue;
    }
    const edges = edgesOf(ref);
    if (edges.top || edges.bottom) horizontalRuleCells.push(ref);
  }
  check(
    "ordinary-detail-rows-have-no-horizontal-rules",
    horizontalRuleCells.length === 0,
    "Ordinary detail rows carry no stray top or bottom border fragments; rules originate only from declared structural roles.",
    horizontalRuleCells.length
      ? {
          rows: [...new Set(horizontalRuleCells.map(rowOf))].slice(0, 20),
          cells: horizontalRuleCells.slice(0, 30),
        }
      : null,
  );

  // --- the two net-debt panels terminate identically ------------------------
  const debt = plan.debt_summary_rows ?? {};
  const treatmentOf = (row) => {
    const columns = ["B", "G", "L", "R"].filter((c) => cellStyle.has(`${c}${row}`));
    return columns.map((c) => {
      const s = styleOf(`${c}${row}`);
      const e = edgesOf(`${c}${row}`);
      return `${c}:${s.fill ?? "-"}/${s.bold ? "B" : "-"}/${e.top ?? "."}/${e.bottom ?? "."}`;
    });
  };
  const pairs = [
    ["net_debt_excluding_leases", "net_debt_company_reported"],
    [
      "net_debt_excluding_leases_to_adjusted_ebitda",
      "net_debt_company_reported_to_adjusted_ebitda",
    ],
    ["net_debt_to_adjusted_ebitda", "net_debt_company_reported_to_adjusted_ebitda"],
  ];
  const asymmetries = [];
  const symmetryEvidence = {};
  let comparedAPair = false;
  for (const [modelId, companyId] of pairs) {
    const modelRow = Number(debt[modelId]);
    const companyRow = Number(debt[companyId]);
    if (!Number.isFinite(modelRow) || !Number.isFinite(companyRow)) continue;
    comparedAPair = true;
    const a = treatmentOf(modelRow).join(" ");
    const b = treatmentOf(companyRow).join(" ");
    symmetryEvidence[`${modelId} vs ${companyId}`] = { model: a, company: b };
    if (a !== b) asymmetries.push(`${modelId}(${modelRow}) != ${companyId}(${companyRow})`);
  }
  // ...and the blank row that keeps the two boxes from sharing an edge.
  const spacerFailures = [];
  const identifiedRows = new Set(
    Object.values(debt).map(Number).filter(Number.isFinite),
  );
  for (const headerId of ["model_basis_header", "company_reported_header"]) {
    const headerRow = Number(debt[headerId]);
    if (!Number.isFinite(headerRow)) continue;
    const above = headerRow - 1;
    if (identifiedRows.has(above)) {
      spacerFailures.push(`${headerId} has no blank row above it (row ${above} is a debt row)`);
      continue;
    }
    for (const column of ["B", "G", "L", "R", "U"]) {
      const ref = `${column}${above}`;
      const s = styleOf(ref);
      const e = edgesOf(ref);
      if (s.fill && s.fill !== "FFFFFF") spacerFailures.push(`${ref} carries fill #${s.fill}`);
      if (e.top || e.bottom) spacerFailures.push(`${ref} carries a rule`);
    }
  }
  check(
    "net-debt-panels-terminate-identically",
    asymmetries.length === 0 && spacerFailures.length === 0,
    comparedAPair
      ? `The model-basis and company-reported panels take the same fill, the same weight and the same closing rule, and a blank row separates the two boxes.`
      : `No company-reported panel on this case (it supplies no reconciling items), so there is nothing to hold symmetric. The model panel's opening blank row is still asserted.`,
    asymmetries.length || spacerFailures.length
      ? { asymmetries, spacer: spacerFailures }
      : symmetryEvidence,
  );

  // --- statement conclusions -------------------------------------------------
  // Formula fan-out is not economic ownership. Attribution rows and analytical
  // appendices can be read more often than the statement conclusion, while a
  // perfectly valid conclusion can have no downstream reader at all. The row
  // plan therefore carries the dependency-graph conclusion, and this style
  // check reads only the emitted OOXML treatment. The separate standard-library
  // workbook semantic oracle binds that physical treatment to the sealed IR, so
  // the renderer is not validating its own classification.
  const conclusionFailures = [];
  const conclusionEvidence = {};
  for (const section of ["income_statement", "cash_flow"]) {
    const declaration = plan.section_conclusions?.[section];
    const header = Number(plan.section_headers?.[section]);
    const nextHeader =
      section === "income_statement"
        ? Number(plan.section_headers?.cash_flow)
        : Number(plan.section_headers?.debt_schedule);
    const expected = Number(declaration?.owner_row);
    const observed = [];
    for (let row = header + 1; row <= nextHeader - 2; row += 1) {
      if (
        ["G", "H", "I", "J", "K", "L"].some(
          (column) => styleOf(`${column}${row}`).fill === answerFill,
        )
      ) observed.push(row);
    }
    conclusionEvidence[section] = { expected, observed };
    if (!Number.isFinite(expected) || observed.length !== 1 || observed[0] !== expected) {
      conclusionFailures.push({ section, expected, observed });
    }
  }
  check(
    "answer-rank-is-earned-not-asserted",
    conclusionFailures.length === 0,
    "Each statement carries exactly one answer treatment and it lands on the dependency-graph conclusion owner; formula fan-out is not used as an ownership proxy.",
    conclusionFailures.length ? conclusionFailures : conclusionEvidence,
  );
}

// ------------------------------------------- conditional format font colour
// ABSOLUTE: a conditional rule may set fill, border, bold/italic and number
// format. It may NEVER set font colour on a BODY cell. Font colour is the
// provenance layer — blue = hardcode, black = same-sheet formula, green =
// cross-sheet link, grey = uncalculated — and a rule that overrides it destroys
// the layer silently, in a state the reader may never see the model in.
//
// The control block is exempt by construction: a toggle is a switch, not a body
// cell, and its On/Off font is part of the switch. Its addresses are RESOLVED
// FROM THE COMPILED ROW PLAN sitting beside the workbook, never hardcoded — the
// control block moves the moment a row is inserted above it. With no row map
// available, fall back to exempting single-cell rules, which is what a control
// rule always is and a body rule never is.
const controlCells = new Set();
let controlSource = "single-cell fallback";
try {
  const rowMap = JSON.parse(readFileSync(`${workbookPath}.row-map.json`, "utf8"));
  for (const row of Object.values(rowMap.controls ?? {})) {
    controlCells.add(`C${row}`);
    controlCells.add(`P${row}`);
  }
  if (controlCells.size) controlSource = `${workbookPath}.row-map.json`;
} catch {
  // No sidecar: the fallback below still holds the line that matters.
}
const isControlSqref = (sqref) =>
  sqref
    .split(/\s+/)
    .every((area) => {
      const [first, last] = area.split(":");
      const single = !last || first === last;
      return controlCells.size ? controlCells.has(first) && single : single;
    });
const dxfSetsFontColour = dxfs.map((d) =>
  new RegExp(`<${P}font\\b[^>]*>[\\s\\S]*?<${P}color\\b`).test(d),
);
const cfFontColourViolations = [];
for (const block of sheet.matchAll(
  new RegExp(`<${P}conditionalFormatting\\b[^>]*sqref="([^"]+)"[^>]*>([\\s\\S]*?)</${P}conditionalFormatting>`, "g"),
)) {
  const sqref = block[1];
  if (isControlSqref(sqref)) continue;
  for (const rule of block[2].matchAll(new RegExp(`<${P}cfRule\\b[^>]*dxfId="(\\d+)"`, "g"))) {
    if (dxfSetsFontColour[Number(rule[1])]) {
      cfFontColourViolations.push(`${sqref} -> dxf ${rule[1]}`);
    }
  }
}
check(
  "conditional-format-sets-no-font-colour-on-body-cells",
  cfFontColourViolations.length === 0,
  `No conditional-formatting rule outside the control block sets a font colour. (controls resolved from ${controlSource})`,
  cfFontColourViolations.slice(0, 20),
);
check(
  "conditional-state-rules-present",
  (sheet.match(new RegExp(`<${P}cfRule\\b`, "g")) ?? []).length >=
    Object.keys(TOKENS.conditional_state?.rules ?? {}).length,
  "The workbook carries at least as many conditional-format rules as the tokens declare states.",
  {
    rules_in_file: (sheet.match(new RegExp(`<${P}cfRule\\b`, "g")) ?? []).length,
    states_declared: Object.keys(TOKENS.conditional_state?.rules ?? {}).length,
  },
);

// ----------------------------------------------------------------- report
const failures = checks.filter((c) => c.status === "fail");
const report = {
  validator: "style-tokens",
  workbook: workbookPath,
  status: failures.length === 0 ? "PASS" : "FAIL",
  checks,
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
for (const c of checks) {
  console.log(`${c.status === "pass" ? "pass" : "FAIL"}  ${c.id}  ${c.message}`);
  if (c.status === "fail" && c.evidence) {
    console.log(`      ${JSON.stringify(c.evidence).slice(0, 400)}`);
  }
}
console.log(`\nstyle-tokens: ${report.status}  (${checks.length - failures.length}/${checks.length} checks)`);
process.exit(failures.length === 0 ? 0 : 1);
