#!/usr/bin/env node
/**
 * Structural comparison: SOURCE workbook vs BUILT workbook.
 *
 * The parity validator answers "is this mapped cell a formula?". It cannot
 * answer "is this row mapped correctly?" or "should there be a row here that
 * isn't?" — a row mapped to the wrong semantic role, or omitted entirely, is
 * invisible to it. This closes that half.
 *
 * Compares, for the statement sections:
 *   - presence: every source label appears
 *   - order:    relative sequence preserved
 *   - type:     input vs calculation vs subtotal, inferred from the SOURCE
 *   - fill:     which period cells are populated vs blank
 *
 * Read-only. Diagnostic, not a gate — it reports differences and leaves the
 * judgement to a reviewer.
 *
 * Usage: node validate_structure.mjs <source.xlsx> <built.xlsx>
 *                                    [--source-sheet <name>] [--built-sheet <name>]
 *
 * The sheet on each side is resolved against SHEET_CANDIDATES, or the override
 * flag when one is given. A name that resolves on neither is a stated error
 * that names the sheets the workbook does contain.
 */
import { readFileSync } from "node:fs";
import JSZip from "jszip";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const positionals = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith("--")) { i += 1; continue; }
  positionals.push(argv[i]);
}
const [srcPath, genPath] = positionals;

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(2);
}

if (!srcPath || !genPath) {
  fail(
    "Usage: node validate_structure.mjs <source.xlsx> <built.xlsx> [--source-sheet <name>] [--built-sheet <name>]",
  );
}

/**
 * Sheet-name candidates, in preference order.
 *
 * This used to be a single hardcoded "Model" on the source side. No workbook in
 * this project has ever carried a sheet by that name — they are all "Operating
 * Model" — so `target` stayed null, `zip.file(null)` threw a TypeError before
 * a single row was read, and this gate has never once executed despite being
 * listed as one of N13's four. A name that does not resolve is now a stated
 * error naming the sheets the workbook actually contains, not a stack trace.
 */
const SHEET_CANDIDATES = ["Operating Model", "Model", "Debt Model"];

async function sheet(xlsxPath, wanted) {
  const zip = await JSZip.loadAsync(readFileSync(xlsxPath));
  const wb = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const t = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && t) rels.set(id, t);
  }
  const partByName = new Map();
  for (const m of wb.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?>/g)) {
    const name = /\bname="([^"]+)"/.exec(m[1])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    if (!name || !rid) continue;
    const t = rels.get(rid) ?? "";
    partByName.set(
      name,
      t.startsWith("/") ? t.slice(1) : t.startsWith("xl/") ? t : `xl/${t}`,
    );
  }
  const candidates = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean);
  let chosen = candidates.find((name) => partByName.has(name));
  if (!chosen) {
    const lower = new Map([...partByName.keys()].map((n) => [n.toLowerCase(), n]));
    const ci = candidates.map((n) => lower.get(n.toLowerCase())).find(Boolean);
    if (ci) chosen = ci;
  }
  if (!chosen) {
    fail(
      `${xlsxPath}: none of the candidate sheet names resolved.`,
      `  looked for : ${candidates.join(", ")}`,
      `  workbook has: ${[...partByName.keys()].join(", ") || "(no sheets)"}`,
      "  Pass --source-sheet / --built-sheet, or add the name to SHEET_CANDIDATES.",
    );
  }
  const target = partByName.get(chosen);
  const part = zip.file(target);
  if (!part) {
    fail(
      `${xlsxPath}: sheet "${chosen}" resolves to ${target}, which is not in the package.`,
    );
  }
  const xml = await part.async("string");
  let shared = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const ss = await ssFile.async("string");
    shared = [...ss.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g)]
      .map((m) => [...m[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
        .map((t) => t[1]).join(""));
  }
  // INDENTATION IS A STYLE, so it has to be read out of the stylesheet. The
  // built workbook moved off leading spaces onto `alignment indent`, and a
  // comparison that only counts spaces reports every indented row as flush.
  // Both mechanisms are read here so either workbook can use either.
  const indentByStyle = [];
  const stylesFile = zip.file("xl/styles.xml");
  if (stylesFile) {
    const styles = await stylesFile.async("string");
    const cellXfs = /<(?:[A-Za-z_][\w.-]*:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cellXfs>/
      .exec(styles)?.[1] ?? "";
    for (const m of cellXfs.matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?xf\b[^>]*\/>|<(?:[A-Za-z_][\w.-]*:)?xf\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?xf>/g,
    )) {
      indentByStyle.push(Number(/\bindent="(\d+)"/.exec(m[0])?.[1] ?? 0));
    }
  }
  const cells = new Map();
  const re = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\br="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = `${m[1]} ${m[3]}`;
    const inner = m[4] ?? "";
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null;
    const raw = /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(inner)?.[1] ?? null;
    let value = raw;
    if (type === "s" && raw != null) value = shared[Number(raw)] ?? null;
    const hasFormula = /<(?:[A-Za-z_][\w.-]*:)?f\b/.test(inner);
    const styleIndex = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
    cells.set(m[2], {
      value,
      hasFormula,
      isText: type === "s" || type === "str" || type === "inlineStr",
      // A level of real indentation is worth more than one space, so the two
      // are not summed — whichever mechanism the workbook uses, take it.
      indent: Math.max(
        indentByStyle[styleIndex] ?? 0,
        /^\s+/.exec(String(value ?? ""))?.[0].length ?? 0,
      ),
    });
  }
  return { name: chosen, cells };
}

// An explicit override is the whole candidate list, not the head of it. A named
// sheet that is not in the workbook must be a stated error, never a silent
// fallback onto a different sheet than the one the caller asked for.
const srcSheet = await sheet(srcPath, flag("--source-sheet") ?? SHEET_CANDIDATES);
const genSheet = await sheet(genPath, flag("--built-sheet") ?? SHEET_CANDIDATES);
const src = srcSheet.cells;
const gen = genSheet.cells;
console.log(`source: ${srcPath} [${srcSheet.name}]`);
console.log(`built : ${genPath} [${genSheet.name}]\n`);

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const label = (cells, col, row) => {
  const c = cells.get(`${col}${row}`);
  return c && c.isText && c.value ? String(c.value) : null;
};

// SOURCE: labels in column A. Statement sections run rows 16..100.
const srcRows = [];
for (let r = 16; r <= 100; r += 1) {
  const l = label(src, "A", r);
  if (!l) continue;
  const indent = src.get(`A${r}`).indent;
  // period columns E..J
  const filled = ["E", "F", "G", "H", "I", "J"].map((c) => {
    const cell = src.get(`${c}${r}`);
    return cell && (cell.hasFormula || cell.value != null) ? (cell.hasFormula ? "f" : "v") : ".";
  }).join("");
  srcRows.push({ row: r, label: l.trim(), indent, filled });
}

// GENERATED: labels in column B, period columns G..I (hist) J..L (forecast)
const genRows = [];
for (let r = 1; r <= 280; r += 1) {
  const l = label(gen, "B", r);
  if (!l) continue;
  const indent = gen.get(`B${r}`).indent;
  const filled = ["G", "H", "I", "J", "K", "L"].map((c) => {
    const cell = gen.get(`${c}${r}`);
    return cell && (cell.hasFormula || cell.value != null) ? (cell.hasFormula ? "f" : "v") : ".";
  }).join("");
  genRows.push({ row: r, label: l.trim(), indent, filled });
}

/**
 * Sequential greedy matching, NOT a label lookup.
 *
 * Labels repeat across sections — "Net Income" appears in both the income
 * statement and the cash flow. A plain label map binds the source's
 * income-statement row to whichever built row it happens to find first, which
 * manufactures phantom ordering inversions. Walk both lists in order and
 * consume each built row once, preferring the first unused match at or after
 * the previous match.
 */
function matchSequential(sourceRows, builtRows) {
  const used = new Set();
  const pairs = new Map();
  let cursor = 0;
  for (const s of sourceRows) {
    const key = norm(s.label);
    let hit = builtRows.findIndex(
      (g, i) => i >= cursor && !used.has(i) && norm(g.label) === key,
    );
    if (hit === -1) {
      hit = builtRows.findIndex((g, i) => !used.has(i) && norm(g.label) === key);
    }
    if (hit === -1) continue;
    used.add(hit);
    cursor = hit;
    pairs.set(s.row, builtRows[hit]);
  }
  return pairs;
}
const matched = matchSequential(srcRows, genRows);

console.log(`source statement rows (16-100): ${srcRows.length}`);
console.log(`built  labelled rows          : ${genRows.length}\n`);

// Vacuity banner. Every count below is a count over the MATCHED rows, so with
// nothing on one side of the comparison they all read zero and the report looks
// like a clean bill of health for a comparison that never happened. This stays
// a diagnostic and still exits 0 by design (references/validation.md), but it
// will not print zeros without saying what they are zeros of.
if (srcRows.length === 0 || genRows.length === 0) {
  console.log(
    [
      "!! NOTHING WAS COMPARED. The zeros below are vacuous, not clean.",
      `   source side found ${srcRows.length} labelled row(s) in column A, rows 16-100.`,
      `   built  side found ${genRows.length} labelled row(s) in column B, rows 1-280.`,
      "   Those ranges and columns are hardcoded for an analyst SOURCE workbook",
      "   against a BUILT one. Feeding two built workbooks, or a source with a",
      "   different layout, empties one side and every finding below goes to 0.",
      "",
    ].join("\n"),
  );
}

const missing = [];
const fillDiff = [];
const indentDiff = [];
let matchedSeq = [];

for (const s of srcRows) {
  const g = matched.get(s.row);
  if (!g) { missing.push(s); continue; }
  matchedSeq.push({ s, g });
  if (s.filled !== g.filled) fillDiff.push({ s, g });
  if ((s.indent > 0) !== (g.indent > 0)) indentDiff.push({ s, g });
}

console.log(`=== MISSING from built model: ${missing.length} ===`);
for (const m of missing) console.log(`  src ${m.row}: ${m.label}`);

// order check: are matched rows monotonically increasing in the built model?
let inversions = 0;
for (let i = 1; i < matchedSeq.length; i += 1) {
  if (matchedSeq[i].g.row < matchedSeq[i - 1].g.row) inversions += 1;
}
console.log(`\n=== ORDER: ${inversions} inversion(s) across ${matchedSeq.length} matched rows ===`);
if (inversions) {
  for (let i = 1; i < matchedSeq.length; i += 1) {
    if (matchedSeq[i].g.row < matchedSeq[i - 1].g.row) {
      console.log(`  "${matchedSeq[i - 1].s.label}" (built ${matchedSeq[i - 1].g.row}) then "${matchedSeq[i].s.label}" (built ${matchedSeq[i].g.row})`);
    }
  }
}

console.log(`\n=== FILL PATTERN differs: ${fillDiff.length} rows ===`);
console.log(`    (f=formula v=value .=blank, six periods: 3 historical + 3 forecast)`);
for (const d of fillDiff.slice(0, 40)) {
  console.log(`  ${d.s.label.slice(0, 44).padEnd(46)} src ${d.s.filled}   built ${d.g.filled}`);
}
if (fillDiff.length > 40) console.log(`  ... +${fillDiff.length - 40} more`);

console.log(`\n=== INDENT level differs: ${indentDiff.length} rows ===`);
for (const d of indentDiff.slice(0, 20)) {
  console.log(`  ${d.s.label.slice(0, 44).padEnd(46)} src indent ${d.s.indent}  built ${d.g.indent}`);
}
