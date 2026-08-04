#!/usr/bin/env node
/**
 * Independent source-parity validator.
 *
 * Answers one question the existing validator cannot: did a cell that the
 * SOURCE derived with a formula survive as a formula in the built workbook?
 *
 * It reads the lineage ledger (derived from the source manifest) — NOT the
 * case's own row classifications. That independence is the whole point: the
 * compiler must not be able to excuse its own output. In the failure this
 * replaces, a row marked forecast_treatment:"hardcode" was both the cause of
 * the defect and the reason the arithmetic check skipped it.
 *
 * It runs TWO passes, and the second exists because the first cannot see far
 * enough:
 *
 *  1. A ledger pass, over the cells the lineage ledger maps onto the Operating
 *     Model sheet. It is the only pass that can judge INTENT — whether a cell
 *     the source derived survived as a formula — because only the ledger knows
 *     what the source did.
 *  2. A workbook-wide link-colour sweep, over every formula in every sheet,
 *     ledger-tracked or not. It judges only what the emitted file says about
 *     itself: a formula referencing another sheet must be green, and one that
 *     does not must not be. It needs no ledger, so it covers the Brokers and
 *     Forward Curves sheets, every non-Smurfit case, and every row the
 *     crosswalk has not mapped.
 *
 * Pass 1 alone reported 2 link-colour violations on a workbook that had 26,
 * because the other 24 were on a sheet the ledger says nothing about. A check
 * that only confirms what it already knows about is not a check.
 *
 * Portable: JSZip + raw OOXML only, no legacy workbook library dependency.
 *
 * Usage: node validate_source_parity.mjs <workbook.xlsx> <row-map.json> <ledger.json> [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const [, , workbookPath, rowMapPath, ledgerPath, ...rest] = process.argv;
if (!workbookPath || !rowMapPath || !ledgerPath) {
  console.error("usage: validate_source_parity.mjs <workbook.xlsx> <row-map.json> <ledger.json> [--json out]");
  process.exit(2);
}
const jsonOut = rest.includes("--json") ? rest[rest.indexOf("--json") + 1] : null;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LINEAGE_EXCEPTIONS_PATH = resolve(
  SCRIPT_DIR,
  "../assets/lineage-exceptions.json",
);
const lineageRegistry = existsSync(LINEAGE_EXCEPTIONS_PATH)
  ? JSON.parse(readFileSync(LINEAGE_EXCEPTIONS_PATH, "utf8"))
  : { lineage_redirects: [], exceptions: [] };
const lineageRedirects = Array.isArray(lineageRegistry.lineage_redirects)
  ? lineageRegistry.lineage_redirects
  : [];
const fileSha256 = (filename) =>
  createHash("sha256").update(readFileSync(filename)).digest("hex");

const PERIOD_COLUMN = {
  historical_1: "G", historical_2: "H", historical_3: "I",
  forecast_1: "J", forecast_2: "K", forecast_3: "L",
  adjustment_1: "N", adjustment_2: "O", adjustment_3: "P",
  pro_forma_historical: "R",
  pro_forma_1: "S", pro_forma_2: "T", pro_forma_3: "U",
};
const BLUE = new Set(["FF0000FF", "0000FF", "FF0070C0"]);
const GREEN = new Set(["FF008000", "008000"]);

const columnNumber = (letters) =>
  [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const columnLetters = (n) => {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
};

/** Shift a shared-formula master into a slave cell's frame of reference. */
function shiftSharedFormula(text, base, target) {
  const b = /^([A-Z]+)(\d+)$/.exec(base), t = /^([A-Z]+)(\d+)$/.exec(target);
  if (!b || !t) return text;
  const dc = columnNumber(t[1]) - columnNumber(b[1]);
  const dr = Number(t[2]) - Number(b[2]);
  return text.split(/("(?:[^"]|"")*")/).map((seg, i) => i % 2 === 1 ? seg :
    seg.replace(/(?<![A-Za-z0-9_.!])(\$?)([A-Z]{1,3})(\$?)(\d+)/g,
      (m, ac, col, ar, row) => {
        const c = ac ? col : columnLetters(columnNumber(col) + dc);
        const r = ar ? Number(row) : Number(row) + dr;
        return (!c || r < 1) ? m : `${ac}${c}${ar}${r}`;
      })).join("");
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const zip = await JSZip.loadAsync(readFileSync(workbookPath));

// ---- resolve every sheet part, not just "Operating Model"
const wbXml = await zip.file("xl/workbook.xml").async("string");
const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
// Attribute order varies between writers (this builder emits Target before
// Id), so parse each Relationship tag and read the attributes independently.
const rels = new Map();
for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
  const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
  const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
  if (id && target) rels.set(id, target);
}
const sheetParts = [];
// Attribute order inside <sheet> is not guaranteed, so match the tag then
// pull name and r:id independently rather than assuming a fixed sequence.
for (const m of wbXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?>/g)) {
  const attrs = m[1];
  const name = /\bname="([^"]+)"/.exec(attrs)?.[1];
  const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
  if (!name || !rid) continue;
  const t = rels.get(rid) ?? "";
  const part = t.startsWith("/") ? t.slice(1) : t.startsWith("xl/") ? t : `xl/${t}`;
  sheetParts.push({ name: decodeXml(name), part });
}
const sheetPath = sheetParts.find((s) => s.name === "Operating Model")?.part ?? null;
if (!sheetPath) throw new Error("Operating Model sheet not found");
const sheetXml = await zip.file(sheetPath).async("string");

// ---- font colour per cellXf
const stylesXml = await zip.file("xl/styles.xml").async("string");
const fontBlock = stylesXml.match(/<(?:[A-Za-z_][\w.-]*:)?fonts\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?fonts>/)?.[1] ?? "";
const fontColours = [...fontBlock.matchAll(/<(?:[A-Za-z_][\w.-]*:)?font\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?font>/g)]
  .map((m) => m[1].match(/<(?:[A-Za-z_][\w.-]*:)?color\b[^>]*rgb="([0-9A-Fa-f]{8})"/)?.[1]?.toUpperCase() ?? null);
const xfBlock = stylesXml.match(/<(?:[A-Za-z_][\w.-]*:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cellXfs>/)?.[1] ?? "";
const xfFont = [...xfBlock.matchAll(/<(?:[A-Za-z_][\w.-]*:)?xf\b([^>]*)\/?>/g)]
  .map((m) => Number(/fontId="(\d+)"/.exec(m[1])?.[1] ?? 0));

// ---- index every cell: formula presence (shared-aware) + colour
function indexSheet(xml) {
  const sharedMasters = new Map();
  for (const m of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*\br="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>/g)) {
    const fm = /<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*\bt="shared"[^>]*\bsi="(\d+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>/.exec(m[2]);
    if (fm && fm[2]) sharedMasters.set(fm[1], { text: fm[2], base: m[1] });
  }
  const indexed = new Map();
  const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\br="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g;
  for (const m of xml.matchAll(cellPattern)) {
    const attrs = `${m[1]} ${m[3]}`;
    const ref = m[2];
    const inner = m[4] ?? "";
    const styleId = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const colour = fontColours[xfFont[styleId] ?? 0] ?? null;
    const fTag = /<(?:[A-Za-z_][\w.-]*:)?f\b([^>]*)(?:>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>|\/>)/.exec(inner);
    let hasFormula = Boolean(fTag), formula = fTag?.[2] ?? "";
    if (hasFormula && !formula) {
      const si = /\bsi="(\d+)"/.exec(fTag[1] ?? "")?.[1];
      const master = si != null ? sharedMasters.get(si) : null;
      if (master) formula = shiftSharedFormula(master.text, master.base, ref);
    }
    const isText = /\bt="(s|inlineStr|str)"/.test(attrs);
    const value = /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(inner)?.[1] ?? null;
    indexed.set(ref, { hasFormula, formula: decodeXml(formula), colour, isText, value });
  }
  return indexed;
}
const cells = indexSheet(sheetXml);

// ---- comment-bearing cells (provenance)
const commented = new Set();
for (const name of Object.keys(zip.files)) {
  if (!/comments?\d*\.xml$/i.test(name)) continue;
  const xml = await zip.file(name).async("string");
  for (const m of xml.matchAll(/ref="([A-Z]+\d+)"/g)) commented.add(m[1]);
}

const rowMap = JSON.parse(readFileSync(rowMapPath, "utf8"));
const ledgerRaw = JSON.parse(readFileSync(ledgerPath, "utf8"));
const rowsById = rowMap.rows_by_id ?? {};
const indexedSheets = new Map([["Operating Model", cells]]);
for (const { name, part } of sheetParts) {
  if (indexedSheets.has(name)) continue;
  const file = zip.file(part);
  if (file) indexedSheets.set(name, indexSheet(await file.async("string")));
}

// ---------------------------------------------------------------------------
// IS THIS LEDGER ABOUT THIS WORKBOOK?
//
// The harness passes one ledger to every case, because only one exists. A
// ledger describes ONE build: its entries are keyed on target_row_id values
// taken from ONE crosswalk. Run against a different company's workbook, those
// row ids land on whatever happens to occupy the same semantic slot, or on
// nothing at all, and the pass reports violations that are artefacts of the
// mismatch rather than facts about the file.
//
// That is not a tolerable default. A pass emitting twenty-one phantom findings
// is a pass in which a real finding is invisible — the same failure as a
// scanner that passes on an empty set, inverted. So the pass establishes, from
// the artifacts alone, whether the ledger it was handed describes the workbook
// it was handed, and when it does not it makes NO STATEMENT rather than a false
// one. Silently passing would be equally wrong: a pass that examined nothing
// has not passed.
//
// The test is containment, not similarity, so there is no threshold to tune. A
// ledger is generated FROM a crosswalk, so every target row it names is by
// construction present in that crosswalk's destination_row_id column. If the
// workbook's own .source-crosswalk.csv sidecar does not contain every target
// row the ledger names, this ledger was built from a different crosswalk and
// describes a different build.
const parseCsvLine = (line) => {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
};

function determineLedgerApplicability(entries) {
  const ledgerTargets = new Set(
    entries.map((e) => e.target_row_id).filter(Boolean),
  );
  if (ledgerTargets.size === 0) {
    return {
      applicable: false,
      reason: "the ledger names no target rows at all, so it can make no statement about any workbook",
      ledger_id: ledgerRaw.ledger_id ?? null,
      ledger_target_rows: 0,
    };
  }

  const crosswalkPath = `${workbookPath}.source-crosswalk.csv`;
  let crosswalkText;
  try {
    crosswalkText = readFileSync(crosswalkPath, "utf8");
  } catch {
    // Undetermined is not the same as applicable. Abstain rather than guess.
    return {
      applicable: false,
      reason:
        `cannot establish that this ledger describes this workbook: the sidecar ` +
        `${crosswalkPath.split("/").pop()} is not present beside it`,
      ledger_id: ledgerRaw.ledger_id ?? null,
      ledger_target_rows: ledgerTargets.size,
    };
  }

  const lines = crosswalkText.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "");
  const destIdx = header.indexOf("destination_row_id");
  if (destIdx === -1) {
    return {
      applicable: false,
      reason:
        "cannot establish that this ledger describes this workbook: the workbook's " +
        "source-crosswalk carries no destination_row_id column",
      ledger_id: ledgerRaw.ledger_id ?? null,
      ledger_target_rows: ledgerTargets.size,
    };
  }
  const crosswalkTargets = new Set();
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    if (f[destIdx]) crosswalkTargets.add(f[destIdx]);
  }

  const missing = [...ledgerTargets].filter((t) => !crosswalkTargets.has(t));
  if (missing.length) {
    return {
      applicable: false,
      reason:
        `this ledger (${ledgerRaw.ledger_id ?? "unidentified"}) was built from a different ` +
        `crosswalk: it names ${missing.length} of its ${ledgerTargets.size} target rows that ` +
        `this workbook's own source-crosswalk does not contain, so its row ids do not address ` +
        `this model`,
      ledger_id: ledgerRaw.ledger_id ?? null,
      ledger_target_rows: ledgerTargets.size,
      target_rows_absent_from_this_crosswalk: missing.length,
      examples: missing.slice(0, 8),
    };
  }

  return {
    applicable: true,
    reason: null,
    ledger_id: ledgerRaw.ledger_id ?? null,
    ledger_target_rows: ledgerTargets.size,
    target_rows_absent_from_this_crosswalk: 0,
  };
}

/**
 * Accept both the full work-tree ledger and the compact shipped one.
 * The compact form drops text cells and abbreviates keys; semantics are
 * identical, so normalise rather than maintaining two readers.
 */
const ledger = {
  ...ledgerRaw,
  entries: ledgerRaw.entries.map((e) =>
    e.source_cell !== undefined
      ? e
      : {
          source_cell: e.c, source_row: e.r, source_label: e.lbl,
          period_role: e.p, source_formula: e.f, formula_class: e.cls,
          dependencies: e.deps ?? [], target_row_id: e.tid ?? null,
          face_statement: e.fs ?? null, material: e.mat ?? null,
          intended_treatment: e.t, exception_type: e.xt ?? null,
          requires_provenance_comment: Boolean(e.prov),
          is_text: false, target_mapped: Boolean(e.tid),
        },
  ),
};

const violations = [];
const stats = { checked: 0, skipped_no_target_row: 0, skipped_no_column: 0, skipped_empty: 0 };

const ledgerApplicability = determineLedgerApplicability(ledger.entries);

for (const e of ledgerApplicability.applicable ? ledger.entries : []) {
  if (!e.target_mapped || e.is_text || !e.period_role) continue;
  // A redirect is not an exception. It says the source cell's lineage survived
  // intact on a different semantic row, and therefore the full formula/colour
  // test must run against that destination. Keeping the registry outside the
  // ledger matters: the ledger records what the SOURCE did, while this registry
  // records an explicitly reviewed transformation made by the target model.
  const redirect = lineageRedirects.find(
    (candidate) =>
      candidate.target_row_id === e.target_row_id &&
      (candidate.period_roles ?? []).includes(e.period_role) &&
      (!(candidate.source_cells?.length) ||
        candidate.source_cells.includes(e.source_cell)),
  );
  let resolvedTargetRowId = redirect?.redirect_to_row_id ?? e.target_row_id;
  let targetSheet = "Operating Model";
  let physRow = rowsById[resolvedTargetRowId];
  let col = PERIOD_COLUMN[e.period_role];
  if (redirect?.redirect_to_broker_metric_id) {
    const brokerMap = rowMap.broker_metric_rows ?? {};
    const forecastIndex = {
      forecast_1: 0,
      forecast_2: 1,
      forecast_3: 2,
    }[e.period_role];
    targetSheet = brokerMap.sheet ?? "Brokers";
    physRow = brokerMap.rows?.[redirect.redirect_to_broker_metric_id];
    col =
      forecastIndex == null
        ? null
        : brokerMap.forecast_columns?.[forecastIndex];
    resolvedTargetRowId = `broker:${redirect.redirect_to_broker_metric_id}`;
  }
  if (physRow == null) { stats.skipped_no_target_row += 1; continue; }
  if (!col) { stats.skipped_no_column += 1; continue; }
  const ref = `${col}${physRow}`;
  const cell = indexedSheets.get(targetSheet)?.get(ref);
  if (!cell || (!cell.hasFormula && cell.value == null)) { stats.skipped_empty += 1; continue; }
  stats.checked += 1;
  const effectiveTreatment =
    redirect?.target_treatment ?? e.intended_treatment;

  const push = (kind, detail) => violations.push({
    kind,
    target: targetSheet === "Operating Model" ? ref : `${targetSheet}!${ref}`,
    source_cell: e.source_cell, source_label: e.source_label,
    target_row_id: e.target_row_id, period_role: e.period_role,
    intended_treatment: e.intended_treatment, source_formula: e.source_formula,
    face_statement: e.face_statement, material: e.material,
    resolved_target_row_id: resolvedTargetRowId,
    lineage_redirect: redirect
      ? {
          reason: redirect.reason ?? null,
          redirect_to_row_id: resolvedTargetRowId,
          target_sheet: targetSheet,
          target_treatment: effectiveTreatment,
        }
      : null,
    detail,
  });

  switch (effectiveTreatment) {
    case "same_sheet_formula":
      if (!cell.hasFormula) {
        push("FLATTENED_FORMULA", "Source derived this cell from other cells; the build emitted a static value.");
      } else if (BLUE.has(cell.colour)) {
        push("FORMULA_COLOURED_AS_INPUT", "Cell is a formula but is rendered blue, which claims it is a user input.");
      }
      break;
    case "cross_sheet_link":
      if (!cell.hasFormula) push("FLATTENED_LINK", "Source linked to another sheet; the build emitted a static value.");
      else if (!GREEN.has(cell.colour)) push("LINK_NOT_GREEN", `Cross-sheet link rendered ${cell.colour ?? "uncoloured"} rather than green.`);
      break;
    case "genuine_hardcode":
      if (!BLUE.has(cell.colour) && !cell.hasFormula) push("HARDCODE_NOT_BLUE", `Genuine input rendered ${cell.colour ?? "uncoloured"} rather than blue.`);
      // Provenance explains a HARDCODE. A cell the build derived with a
      // formula documents itself, so requiring a comment there is noise.
      if (e.requires_provenance_comment && !cell.hasFormula && !commented.has(ref)) {
        push("MISSING_PROVENANCE", "Hardcode derived from a source constant carries no provenance comment.");
      }
      break;
    case "documented_exception":
      // Same rule: only a hardcode needs the exception spelled out on the cell.
      if (!cell.hasFormula && !commented.has(ref)) {
        push("EXCEPTION_UNDOCUMENTED", `Approved exception (${e.exception_type ?? "unspecified"}) carries no provenance comment.`);
      }
      // A formula here is BETTER than the exception permits — the build
      // reconstructed from visible rows something the exception only allowed
      // to be a hardcode. A same-sheet formula is therefore not a leak.
      // The genuine failure is a reference to a predecessor/support sheet that
      // must not exist in the production workbook at all.
      if (cell.hasFormula && /\b(Legacy_[A-Za-z]+|Broker_Consensus)\s*!/.test(cell.formula)) {
        push("EXCEPTION_LEAKED_COMBINATION", `Cell references a forbidden support sheet: ${cell.formula.slice(0, 60)}`);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// WORKBOOK-WIDE LINK COLOUR SWEEP
//
// The loop above can only see cells the lineage ledger tracks — cells on the
// Operating Model sheet that a Smurfit source cell maps onto. That is why this
// validator reported 2 LINK_NOT_GREEN when the Smurfit workbook actually had 24
// black cross-sheet links: the other 22 sat on the Brokers sheet, which the
// ledger does not describe at all, so the check ran and found nothing wrong
// because it never looked. Confirming what it already knows about and staying
// silent everywhere else is not a check.
//
// This sweep therefore ignores the ledger entirely and audits EVERY formula in
// EVERY sheet of the emitted workbook, from the OOXML alone:
//   * a formula that references another sheet must be green;
//   * a formula that references no other sheet must not be green.
//
// A reference is recognised by matching the workbook's OWN sheet names, quoted
// or bare, so a string literal containing "!" cannot be mistaken for a link and
// a sheet renamed in the case file is followed automatically.
const sheetNames = sheetParts.map((s) => s.name);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bareNames = sheetNames.filter((n) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(n));
const linkPattern = new RegExp(
  `(?:'(?:${sheetNames.map(escape).join("|")})'` +
    (bareNames.length ? `|(?<![A-Za-z0-9_.#])(?:${bareNames.map(escape).join("|")})` : "") +
    `)\\s*!`,
);
// SCOPE IS PART OF THE RESULT, NOT A PROPERTY OF THE READER'S ASSUMPTIONS.
//
// Two independent hand-rolled audits scanned columns G:U only, found nothing,
// and reported "the workbook is clean" — one of them going on to dismiss this
// validator's findings as false positives on that basis. A scoped audit that
// does not publish its scope is indistinguishable from a complete one.
//
// So the sweep records, and prints, exactly what it looked at: how many
// formulas, on which named sheets, spanning which columns and which rows, and
// how many of each verdict. `columns` is OBSERVED, not declared — it is the set
// of columns formulas were actually found in, so it cannot drift away from what
// the loop below did.
const linkStats = {
  formulas: 0,
  cross_sheet: 0,
  not_green: 0,
  false_green: 0,
  sheets: sheetParts.map((s) => s.name),
  columns: [],
  column_filter: "none — every column of every sheet",
  row_filter: "none — every row of every sheet",
  first_row: null,
  last_row: null,
};
const seenColumns = new Set();
for (const { name, part } of sheetParts) {
  const file = zip.file(part);
  if (!file) continue;
  const xml = name === "Operating Model" ? sheetXml : await file.async("string");
  const indexed = name === "Operating Model" ? cells : indexSheet(xml);
  for (const [ref, cell] of indexed) {
    if (!cell.hasFormula || !cell.formula) continue;
    linkStats.formulas += 1;
    const parsed = /^([A-Z]+)(\d+)$/.exec(ref);
    if (parsed) {
      seenColumns.add(parsed[1]);
      const row = Number(parsed[2]);
      if (linkStats.first_row == null || row < linkStats.first_row) linkStats.first_row = row;
      if (linkStats.last_row == null || row > linkStats.last_row) linkStats.last_row = row;
    }
    const isLink = linkPattern.test(cell.formula);
    const isGreen = GREEN.has(cell.colour);
    if (isLink) linkStats.cross_sheet += 1;
    if (isLink && !isGreen) linkStats.not_green += 1;
    if (!isLink && isGreen) linkStats.false_green += 1;
    if (isLink && !isGreen) {
      violations.push({
        kind: "LINK_NOT_GREEN", target: `${name}!${ref}`, sheet: name,
        source_cell: null, source_label: null, target_row_id: null,
        period_role: null, intended_treatment: "cross_sheet_link",
        source_formula: null, face_statement: null, material: null,
        detail: `Cross-sheet link rendered ${cell.colour ?? "uncoloured"} rather than green: ${cell.formula.slice(0, 70)}`,
      });
    } else if (!isLink && isGreen) {
      violations.push({
        kind: "GREEN_NOT_LINK", target: `${name}!${ref}`, sheet: name,
        source_cell: null, source_label: null, target_row_id: null,
        period_role: null, intended_treatment: "same_sheet_formula",
        source_formula: null, face_statement: null, material: null,
        detail: `Same-sheet formula rendered green, which claims it is imported: ${cell.formula.slice(0, 70)}`,
      });
    }
  }
}
// The ledger loop and the sweep both police link colour, so a ledger-tracked
// black link would otherwise be counted twice. The sweep is the superset; drop
// the ledger's duplicate rather than the sweep's, so the reported address is the
// sheet-qualified one.
const sweptLinkCells = new Set(
  violations.filter((v) => v.sheet).map((v) => v.target),
);
for (let i = violations.length - 1; i >= 0; i -= 1) {
  const v = violations[i];
  if (v.kind !== "LINK_NOT_GREEN" || v.sheet) continue;
  if (sweptLinkCells.has(`Operating Model!${v.target}`)) violations.splice(i, 1);
}

const byKind = violations.reduce((m, v) => (m[v.kind] = (m[v.kind] ?? 0) + 1, m), {});
const blocking = violations.filter((v) => v.kind === "FLATTENED_FORMULA" || v.kind === "FLATTENED_LINK");

// The status reflects only the passes that ACTUALLY APPLIED. When the ledger
// pass abstained, its silence is not evidence of correctness, so a clean run is
// not reported as a bare PASS: the status names the abstention, in the same
// spirit as validate_dynamic_model's PASS_PENDING_MANUAL. Exit code follows the
// applied passes alone — there is nothing for an inapplicable pass to fail.
const status = blocking.length
  ? "FAIL"
  : violations.length
    ? "WARN"
    : ledgerApplicability.applicable
      ? "PASS"
      : "PASS_LEDGER_NOT_APPLICABLE";

console.log(`\nsource-parity: ${status}`);
if (ledgerApplicability.applicable) {
  console.log(
    `ledger pass: APPLICABLE (ledger ${ledgerApplicability.ledger_id}, ` +
      `${ledgerApplicability.ledger_target_rows} target rows, all present in this workbook's crosswalk)`,
  );
  console.log(`checked ${stats.checked} mapped cells  (skipped: no-row ${stats.skipped_no_target_row}, no-col ${stats.skipped_no_column}, empty ${stats.skipped_empty})`);
} else {
  console.log(`ledger pass: NOT APPLICABLE — ${ledgerApplicability.reason}`);
  console.log(
    "  this pass made NO STATEMENT about this workbook. It did not pass; it abstained." +
      " Intent — whether a cell the source derived survived as a formula — is UNVERIFIED here.",
  );
}
linkStats.columns = [...seenColumns].sort((a, b) => columnNumber(a) - columnNumber(b));
const columnSpan = linkStats.columns.length
  ? `${linkStats.columns[0]}..${linkStats.columns[linkStats.columns.length - 1]}`
  : "(none)";
const rowSpan =
  linkStats.first_row == null ? "(none)" : `${linkStats.first_row}..${linkStats.last_row}`;
console.log(
  `link sweep: ${linkStats.formulas} formulas across ${sheetParts.length} sheets, ${linkStats.cross_sheet} cross-sheet` +
    ` (${linkStats.not_green} not green, ${linkStats.false_green} false green)`,
);
console.log(
  `  scope: sheets [${linkStats.sheets.join(", ")}]` +
    `  columns ${columnSpan} (${linkStats.columns.join(",") || "-"})  rows ${rowSpan}`,
);
console.log(
  `  column filter: ${linkStats.column_filter}; row filter: ${linkStats.row_filter}` +
    ` — the denominator ${linkStats.formulas} is EVERY formula in the workbook, not a sample`,
);
console.log(`violations: ${violations.length}\n`);
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

if (blocking.length) {
  console.log(`\n--- flattened formulas (${blocking.length}) ---`);
  const seen = new Set();
  for (const v of blocking) {
    const key = v.source_label;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${v.target.padEnd(6)} <- ${v.source_cell.padEnd(5)} ${String(v.source_label).slice(0, 40).padEnd(42)} ${String(v.source_formula).slice(0, 44)}`);
  }
  console.log(`  (${seen.size} distinct rows)`);
}

const colourViolations = violations.filter(
  (v) => v.kind === "LINK_NOT_GREEN" || v.kind === "GREEN_NOT_LINK",
);
if (colourViolations.length) {
  console.log(`\n--- link colour (${colourViolations.length}) ---`);
  for (const v of colourViolations.slice(0, 40)) {
    console.log(`  ${v.kind.padEnd(14)} ${String(v.target).padEnd(28)} ${v.detail}`);
  }
  if (colourViolations.length > 40) console.log(`  ... ${colourViolations.length - 40} more`);
}

// ---------------------------------------------------------------------------
// WHAT THIS RUN ACTUALLY COVERED
//
// Printed unconditionally, because the coverage of a check is part of its
// result. The two passes do not cover the same thing and must not be summarised
// as one number: the sweep is workbook-wide and ran here; the ledger pass judges
// intent and only runs where a ledger for THIS build exists. Saying "source
// parity passed" without saying which of the two spoke is how a hole gets
// reported as a clean bill of health.
console.log("\n--- coverage of this run ---");
console.log(
  `  link sweep (colour of every formula, no ledger needed): RAN — ${linkStats.formulas} formulas, ` +
    `${linkStats.cross_sheet} cross-sheet, ${linkStats.not_green} not green, ${linkStats.false_green} false green`,
);
if (ledgerApplicability.applicable) {
  console.log(
    `  ledger pass (did the source's formula survive): RAN — ${stats.checked} mapped cells judged`,
  );
} else {
  console.log("  ledger pass (did the source's formula survive): ABSTAINED — 0 cells judged");
  console.log(`      reason: ${ledgerApplicability.reason}`);
  console.log(
    "      a lineage ledger can only be derived from a source artifact that records what each",
  );
  console.log(
    "      source CELL did. Where a model was built from filings or from a synthetic specification,",
  );
  console.log(
    "      no such artifact exists and none may be invented to make this pass applicable.",
  );
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        status,
        bindings: {
          workbook: { path: resolve(workbookPath), sha256: fileSha256(workbookPath) },
          row_map: { path: resolve(rowMapPath), sha256: fileSha256(rowMapPath) },
          ledger: { path: resolve(ledgerPath), sha256: fileSha256(ledgerPath) },
        },
        ledger_applicable: ledgerApplicability.applicable,
        ledger_applicability: ledgerApplicability,
        coverage: {
          link_sweep: "ran",
          ledger_pass: ledgerApplicability.applicable ? "ran" : "abstained",
          ledger_cells_judged: ledgerApplicability.applicable ? stats.checked : 0,
        },
        stats,
        linkStats,
        byKind,
        violations,
      },
      null,
      1,
    ),
  );
}
process.exit(status === "FAIL" ? 1 : 0);
