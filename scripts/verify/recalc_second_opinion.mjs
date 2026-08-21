#!/usr/bin/env node
/**
 * Prove that LibreOffice actually opened/recalculated the emitted workbook and
 * independently reproduced every formula cache before the terminal patch.
 * Reads raw OOXML only; it shares no reader or evaluator with emit/.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const P = "(?:[A-Za-z_][\\w.-]*:)?";
const decodeXml = (value) => String(value ?? "")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

async function readCacheMap(workbookPath) {
  const bytes = readFileSync(workbookPath);
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new Error("workbook package has no workbook relationship surface");

  const relationships = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) relationships.set(id, target);
  }
  const sheets = [];
  for (const match of workbookXml.matchAll(new RegExp(`<${P}sheet\\b([^>]*)\\/?>`, "g"))) {
    const name = decodeXml(/\bname="([^"]+)"/.exec(match[1])?.[1]);
    const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1];
    const target = relationships.get(rid) ?? "";
    if (!name || !target) continue;
    const part = target.startsWith("/")
      ? target.slice(1)
      : target.startsWith("xl/") ? target : `xl/${target}`;
    sheets.push({ name, part });
  }
  const cells = {};
  for (const sheet of sheets) {
    const xml = await zip.file(sheet.part)?.async("string");
    if (!xml) throw new Error(`sheet ${sheet.name} resolves to missing part ${sheet.part}`);
    const cellPattern = new RegExp(
      `<${P}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${P}c>)`,
      "g",
    );
    for (const match of xml.matchAll(cellPattern)) {
      const attrs = match[1] ?? "";
      const body = match[2] ?? "";
      const address = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!address || !new RegExp(`<${P}f\\b`).test(body)) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const raw = new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)<\\/${P}v>`).exec(body)?.[1];
      let value = null;
      let valueKind = "blank";
      if (raw !== undefined && raw !== "") {
        if (type === "b") {
          valueKind = "boolean";
          value = raw === "1";
        } else if (type === "e") {
          valueKind = "error";
          value = decodeXml(raw);
        } else if (type === "str" || type === "s") {
          valueKind = "string";
          value = decodeXml(raw);
        } else {
          const numeric = Number(raw);
          valueKind = Number.isFinite(numeric) ? "number" : "string";
          value = Number.isFinite(numeric) ? numeric : decodeXml(raw);
        }
      }
      cells[`${sheet.name}!${address}`] = {
        kind: valueKind,
        value,
        has_cache: raw !== undefined,
      };
    }
  }
  const applicationXml = await zip.file("docProps/app.xml")?.async("string");
  const producer = applicationXml
    ? decodeXml(new RegExp(`<${P}Application\\b[^>]*>([\\s\\S]*?)<\\/${P}Application>`).exec(applicationXml)?.[1] ?? "")
    : "";
  const orderedCells = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => a.localeCompare(b)));
  return canonical({
    schema_version: "formula-cache-map/1.0",
    workbook: path.basename(workbookPath),
    workbook_sha256: sha256(bytes),
    producer,
    formula_cells: Object.keys(orderedCells).length,
    cached_formula_cells: Object.values(orderedCells).filter((cell) => cell.has_cache).length,
    cells: orderedCells,
  });
}

function valuesAgree(before, after, absoluteTolerance, relativeTolerance) {
  const blankEquivalent = (left, right) =>
    left.kind === "blank" && (
      (right.kind === "number" && right.value === 0)
      || (right.kind === "string" && right.value === "")
      || right.kind === "blank"
    );
  if (blankEquivalent(before, after) || blankEquivalent(after, before)) {
    return { agree: true, absolute_drift: 0, relative_drift: 0 };
  }
  if (before.kind !== after.kind) return { agree: false, absolute_drift: null, relative_drift: null };
  if (before.kind !== "number") {
    return { agree: before.value === after.value, absolute_drift: null, relative_drift: null };
  }
  const absoluteDrift = Math.abs(before.value - after.value);
  const scale = Math.max(Math.abs(before.value), Math.abs(after.value), 1);
  const relativeDrift = absoluteDrift / scale;
  return {
    agree: absoluteDrift <= Math.max(absoluteTolerance, relativeTolerance * scale),
    absolute_drift: absoluteDrift,
    relative_drift: relativeDrift,
  };
}

export async function compileRecalcSecondOpinion({
  beforePath,
  rawAfterPath,
  beforeMapPath,
  rawAfterMapPath,
  receiptPath,
  sofficeIdentity = null,
  absoluteTolerance = 1e-9,
  relativeTolerance = 1e-9,
}) {
  const before = await readCacheMap(beforePath);
  const after = await readCacheMap(rawAfterPath);
  const violations = [];
  const beforeKeys = Object.keys(before.cells);
  const afterKeys = Object.keys(after.cells);
  const missingAfter = beforeKeys.filter((key) => !(key in after.cells));
  const extraAfter = afterKeys.filter((key) => !(key in before.cells));
  if (before.formula_cells === 0) violations.push({ code: "FORMULA_SET_EMPTY" });
  if (missingAfter.length) violations.push({ code: "FORMULAS_MISSING_AFTER_RECALC", cells: missingAfter.slice(0, 40) });
  if (extraAfter.length) violations.push({ code: "FORMULAS_ADDED_AFTER_RECALC", cells: extraAfter.slice(0, 40) });
  if (before.workbook_sha256 === after.workbook_sha256) {
    violations.push({ code: "NO_OP_PACKAGE", detail: "LibreOffice output bytes equal the input bytes." });
  }
  if (!/libreoffice/i.test(after.producer)) {
    violations.push({ code: "PRODUCER_NOT_LIBREOFFICE", producer: after.producer });
  }
  if (after.cached_formula_cells !== after.formula_cells) {
    violations.push({
      code: "RAW_AFTER_FORMULA_CACHE_GAP",
      formula_cells: after.formula_cells,
      cached_formula_cells: after.cached_formula_cells,
    });
  }

  let compared = 0;
  let maxAbsoluteDrift = 0;
  let maxRelativeDrift = 0;
  const disagreements = [];
  for (const key of beforeKeys) {
    if (!(key in after.cells)) continue;
    const comparison = valuesAgree(
      before.cells[key],
      after.cells[key],
      absoluteTolerance,
      relativeTolerance,
    );
    compared += 1;
    maxAbsoluteDrift = Math.max(maxAbsoluteDrift, comparison.absolute_drift ?? 0);
    maxRelativeDrift = Math.max(maxRelativeDrift, comparison.relative_drift ?? 0);
    if (!comparison.agree) {
      disagreements.push({
        cell: key,
        before: before.cells[key],
        raw_after: after.cells[key],
        absolute_drift: comparison.absolute_drift,
        relative_drift: comparison.relative_drift,
      });
    }
  }
  if (compared !== before.formula_cells) {
    violations.push({ code: "COMPARISON_COVERAGE_GAP", compared, formula_cells: before.formula_cells });
  }
  if (disagreements.length) {
    violations.push({
      code: "LIBREOFFICE_CACHE_DISAGREEMENT",
      count: disagreements.length,
      examples: disagreements.slice(0, 40),
    });
  }
  const beforeMapText = `${JSON.stringify(before, null, 2)}\n`;
  const rawAfterMapText = `${JSON.stringify(after, null, 2)}\n`;
  const receiptBody = canonical({
    schema_version: "libreoffice-recalc-receipt/1.0",
    status: violations.length ? "FAIL" : "PASS",
    before_workbook_sha256: before.workbook_sha256,
    raw_after_workbook_sha256: after.workbook_sha256,
    before_cache_map_sha256: sha256(Buffer.from(beforeMapText)),
    raw_after_cache_map_sha256: sha256(Buffer.from(rawAfterMapText)),
    soffice_identity: sofficeIdentity,
    producer: after.producer,
    package_changed: before.workbook_sha256 !== after.workbook_sha256,
    formula_cells: before.formula_cells,
    compared_formula_cells: compared,
    disagreements: disagreements.length,
    tolerance: { absolute: absoluteTolerance, relative: relativeTolerance },
    maximum_observed_drift: {
      absolute: maxAbsoluteDrift,
      relative: maxRelativeDrift,
    },
    violations,
  });
  const receipt = {
    ...receiptBody,
    receipt_sha256: sha256(Buffer.from(JSON.stringify(receiptBody))),
  };
  writeFileSync(beforeMapPath, beforeMapText);
  writeFileSync(rawAfterMapPath, rawAfterMapText);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    options[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  for (const required of ["before", "after", "before-map", "after-map", "out"]) {
    if (!options[required]) {
      console.error("usage: recalc_second_opinion.mjs --before emitted.xlsx --after raw-after.xlsx --before-map before.json --after-map after.json --out receipt.json [--soffice-identity sha256]");
      process.exit(2);
    }
  }
  const result = await compileRecalcSecondOpinion({
    beforePath: options.before,
    rawAfterPath: options.after,
    beforeMapPath: options["before-map"],
    rawAfterMapPath: options["after-map"],
    receiptPath: options.out,
    sofficeIdentity: options["soffice-identity"] ?? null,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "PASS" ? 0 : 1;
}
