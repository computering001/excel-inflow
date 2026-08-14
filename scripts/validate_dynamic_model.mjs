#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import JSZip from "jszip";
import {
  buildNativeEvidenceBindings,
  embeddedRateLiterals,
  parseCsv,
  sha256,
  validateFiscalPeriods,
  validateNativeEvidence,
  validateSemanticArtifacts,
} from "./lib/validation_invariants.mjs";
import { validateForecastWorkbookCompleteness } from "./lib/forecast_completeness.mjs";
import { ECONOMIC_SOLVE_POLICY } from "./lib/economic_solve_policy.mjs";

const FORECAST_COLUMNS = ["J", "K", "L"];
const ADJUSTMENT_COLUMNS = ["N", "O", "P"];
const PRO_FORMA_COLUMNS = ["S", "T", "U"];
const ALL_MODEL_COLUMNS = [
  "G",
  "H",
  "I",
  ...FORECAST_COLUMNS,
  ...ADJUSTMENT_COLUMNS,
  "R",
  ...PRO_FORMA_COLUMNS,
];

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

function parseNdjson(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function reviewEvidence(filePath, { jsonRequired = false } = {}) {
  if (!filePath) return { supplied: false, passed: false, evidence: null };
  try {
    const contents = await fs.readFile(filePath);
    const isJson = path.extname(filePath).toLowerCase() === ".json";
    if (!isJson) {
      return {
        supplied: true,
        passed: !jsonRequired && contents.length > 0,
        evidence: path.resolve(filePath),
      };
    }
    const parsed = JSON.parse(contents.toString("utf8"));
    const status = String(
      parsed.status ?? parsed.summary?.status ?? "",
    ).toUpperCase();
    return {
      supplied: true,
      passed: status === "PASS",
      data: parsed,
      evidence: {
        path: path.resolve(filePath),
        status: status || null,
      },
    };
  } catch (error) {
    return {
      supplied: true,
      passed: false,
      evidence: {
        path: path.resolve(filePath),
        error: String(error?.message ?? error),
      },
    };
  }
}

function record(id, passed, message, evidence = null, status = null) {
  return {
    id,
    status: status ?? (passed ? "pass" : "fail"),
    severity: status === "manual" ? "manual" : "critical",
    message,
    evidence,
  };
}

function value(sheet, address) {
  return sheet.getRange(address).values?.[0]?.[0] ?? null;
}

function formula(sheet, address) {
  return sheet.getRange(address).formulas?.[0]?.[0] ?? "";
}

function numeric(valueToTest) {
  if (valueToTest instanceof Date) {
    return (
      (valueToTest.getTime() - Date.UTC(1899, 11, 30)) /
      (24 * 60 * 60 * 1000)
    );
  }
  const result = Number(valueToTest ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function approximatelyEqual(left, right, tolerance) {
  return Math.abs(numeric(left) - numeric(right)) <= tolerance;
}

/**
 * DEFECT 0.2 — ONE ABSOLUTE TOLERANCE FOR MONEY AND FOR MULTIPLES.
 *
 * Every numeric comparison in this file used to run through a single constant
 * of 0.05. On `net_leverage` that is 1.7% of a 3.0x headline metric, recorded
 * as agreement; on a 26,971m gross-debt figure the same constant is two parts
 * per million of licensed drift on a comparison that ought to be exact. The
 * two failures are the same failure — a tolerance with no metric class behind
 * it is not a statement about precision, it is a number someone picked.
 *
 * `assets/production-contract-v2.json`'s `tolerances` block now states the
 * bands by class, per check, with the currency floor in currency units scaled
 * through `issuer.units`. `validate_cache_parity.mjs` already distinguishes
 * `--tol` / `--rel` / `--circ-tol`; this follows that pattern.
 */
function classifyMetric(definition) {
  const operators = [
    definition?.calculation?.operator,
    definition?.forecast_calculation?.operator,
  ].filter(Boolean);
  if (operators.some((operator) => /^(ratio|negated_ratio)$/.test(operator))) {
    return "ratio";
  }
  if (
    operators.some((operator) =>
      /(growth|margin|percentage|rate|conversion)/i.test(operator),
    )
  ) {
    return "rate";
  }
  const name = `${definition?.row_id ?? ""} ${definition?.semantic_role ?? ""}`;
  if (/leverage|coverage|to_adjusted_ebitda|_to_net_interest|multiple/i.test(name)) {
    return "ratio";
  }
  if (/rate|margin|growth|percentage|conversion|yield/i.test(name)) {
    return "rate";
  }
  return "currency";
}

function buildToleranceResolver(contract, issuerUnits, cliOverride) {
  const block = contract.tolerances ?? {};
  const unitScale = Number(block.unit_scale?.[issuerUnits ?? "units"] ?? 1);
  const classes = block.metric_classes ?? {};
  const resolved = [];
  const resolve = (checkId, metricClass, magnitude = 0) => {
    if (Number.isFinite(cliOverride)) return cliOverride;
    const mapping = block.checks?.[checkId];
    const className = mapping?.[metricClass] ?? metricClass;
    const definition = classes[className];
    if (!definition) {
      // A check with no declared class is a gap in the contract, not a licence
      // to be permissive: fall back to the tightest band declared anywhere.
      const tightest = Math.min(
        ...Object.values(classes).map((entry) =>
          Number(entry.absolute ?? entry.relative ?? Infinity),
        ),
      );
      return Number.isFinite(tightest) ? tightest : 0;
    }
    let band = Number(definition.absolute ?? 0);
    if (definition.relative !== undefined) {
      const floor =
        Number(definition.absolute_floor_currency_units ?? 0) * unitScale;
      band = Math.max(floor, Math.abs(Number(magnitude)) * Number(definition.relative));
    }
    resolved.push({ check: checkId, metric_class: className, band });
    return band;
  };
  return {
    resolve,
    unitScale,
    issuerUnits: issuerUnits ?? null,
    summary: () => ({
      contract_id: contract.contract_id ?? null,
      issuer_units: issuerUnits ?? null,
      unit_scale: unitScale,
      metric_classes: classes,
      tolerance_override: Number.isFinite(cliOverride) ? cliOverride : null,
      override_note: Number.isFinite(cliOverride)
        ? "--tolerance was supplied on the command line and OVERRODE every contract band. This report was not produced under the production contract's tolerances."
        : null,
    }),
  };
}

function calculationValue(
  definition,
  valuesById,
  priorValuesById,
  calculationOverride = null,
) {
  const calculation = calculationOverride ?? definition.calculation;
  if (!calculation) return null;
  const values = calculation.refs.map((id) => numeric(valuesById.get(id)));
  if (calculation.operator === "sum") {
    return values.reduce((sum, item) => sum + item, 0);
  }
  if (calculation.operator === "link") return values[0] ?? 0;
  if (calculation.operator === "subtract") {
    return values.slice(1).reduce((result, item) => result - item, values[0] ?? 0);
  }
  if (calculation.operator === "negate") return -(values[0] ?? 0);
  if (calculation.operator === "negate_sum") {
    return -values.reduce((sum, item) => sum + item, 0);
  }
  if (calculation.operator === "ratio") {
    return values[1] === 0 ? 0 : values[0] / values[1];
  }
  if (calculation.operator === "negated_ratio") {
    return values[1] === 0 ? 0 : -values[0] / values[1];
  }
  if (calculation.operator === "growth") {
    const prior = numeric(priorValuesById?.get(calculation.refs[0]));
    return prior === 0 ? 0 : values[0] / prior - 1;
  }
  if (calculation.operator === "tax") {
    return values[0] > 0 ? -values[0] * values[1] : 0;
  }
  if (calculation.operator === "prior_period") {
    return numeric(priorValuesById?.get(calculation.refs[0]));
  }
  if (calculation.operator === "prior_period_scaled_by") {
    const priorValue = numeric(priorValuesById?.get(calculation.refs[0]));
    const currentDriver = numeric(valuesById.get(calculation.refs[1]));
    const priorDriver = numeric(priorValuesById?.get(calculation.refs[1]));
    return priorDriver === 0
      ? 0
      : priorValue * currentDriver / priorDriver;
  }
  if (calculation.operator === "average") {
    return values.length === 0
      ? 0
      : values.reduce((sum, item) => sum + item, 0) / values.length;
  }
  return null;
}

function styleMaps(stylesXml, worksheetXml) {
  const fontsBlock =
    stylesXml.match(
      /<(?:[A-Za-z_][\w.-]*:)?fonts\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?fonts>/,
    )?.[1] ?? "";
  const fonts = [];
  const fontPattern =
    /<(?:[A-Za-z_][\w.-]*:)?font\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?font>/g;
  for (const match of fontsBlock.matchAll(fontPattern)) {
    const body = match[1];
    const rgb = body.match(
      /<(?:[A-Za-z_][\w.-]*:)?color\b[^>]*\brgb="([A-Fa-f0-9]{8})"/,
    )?.[1];
    const name = body.match(
      /<(?:[A-Za-z_][\w.-]*:)?name\b[^>]*\bval="([^"]+)"/,
    )?.[1];
    const size = Number(
      body.match(
        /<(?:[A-Za-z_][\w.-]*:)?sz\b[^>]*\bval="([^"]+)"/,
      )?.[1] ?? 0,
    );
    const bold =
      /<(?:[A-Za-z_][\w.-]*:)?b(?:\s[^>]*)?\/>/.test(body) ||
      /<(?:[A-Za-z_][\w.-]*:)?b\b[^>]*>/.test(body);
    fonts.push({
      color: rgb ? rgb.slice(-6).toUpperCase() : "000000",
      name: name ?? null,
      size,
      bold,
    });
  }
  const fillsBlock =
    stylesXml.match(
      /<(?:[A-Za-z_][\w.-]*:)?fills\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?fills>/,
    )?.[1] ?? "";
  const fills = [];
  const fillPattern =
    /<(?:[A-Za-z_][\w.-]*:)?fill\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?fill>/g;
  for (const match of fillsBlock.matchAll(fillPattern)) {
    const body = match[1];
    const rgb = body.match(
      /<(?:[A-Za-z_][\w.-]*:)?fgColor\b[^>]*\brgb="([A-Fa-f0-9]{8})"/,
    )?.[1];
    const pattern = body.match(
      /<(?:[A-Za-z_][\w.-]*:)?patternFill\b[^>]*\bpatternType="([^"]+)"/,
    )?.[1];
    fills.push({
      fillColor: rgb ? rgb.slice(-6).toUpperCase() : null,
      fillPattern: pattern ?? null,
    });
  }
  const customNumberFormats = new Map();
  const numberFormatPattern =
    /<(?:[A-Za-z_][\w.-]*:)?numFmt\b([^>]*)\/?>/g;
  for (const match of stylesXml.matchAll(numberFormatPattern)) {
    const id = Number(match[1].match(/\bnumFmtId="(\d+)"/)?.[1]);
    const code = match[1]
      .match(/\bformatCode="([^"]*)"/)?.[1]
      ?.replaceAll("&quot;", '"');
    if (Number.isFinite(id) && code !== undefined) {
      customNumberFormats.set(id, code);
    }
  }
  const cellXfsBlock =
    stylesXml.match(
      /<(?:[A-Za-z_][\w.-]*:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cellXfs>/,
    )?.[1] ?? "";
  const styleDefinitions = [];
  const xfPattern = /<(?:[A-Za-z_][\w.-]*:)?xf\b([^>]*)\/?>/g;
  for (const match of cellXfsBlock.matchAll(xfPattern)) {
    const fontId = Number(match[1].match(/\bfontId="(\d+)"/)?.[1] ?? 0);
    const fillId = Number(match[1].match(/\bfillId="(\d+)"/)?.[1] ?? 0);
    const numFmtId = Number(match[1].match(/\bnumFmtId="(\d+)"/)?.[1] ?? 0);
    styleDefinitions.push({
      ...(fonts[fontId] ?? {
        color: "000000",
        name: null,
        size: 0,
        bold: false,
      }),
      ...(fills[fillId] ?? { fillColor: null, fillPattern: null }),
      numFmtId,
      numberFormat: customNumberFormats.get(numFmtId) ?? null,
    });
  }
  const cellStyles = new Map();
  const cellPattern =
    /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\/?>/g;
  for (const match of worksheetXml.matchAll(cellPattern)) {
    const address = match[1].match(/\br="([A-Z]+\d+)"/)?.[1];
    if (!address) continue;
    const styleId = Number(match[1].match(/\bs="(\d+)"/)?.[1] ?? 0);
    cellStyles.set(
      address,
      styleDefinitions[styleId] ?? {
        color: "000000",
        name: null,
        size: 0,
        bold: false,
        numFmtId: 0,
        numberFormat: null,
      },
    );
  }
  return cellStyles;
}

function columnNumber(column) {
  return [...column].reduce(
    (total, character) => total * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

function columnLetters(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function shiftSharedFormula(formulaText, baseAddress, targetAddress) {
  const base = baseAddress.match(/^([A-Z]+)(\d+)$/);
  const target = targetAddress.match(/^([A-Z]+)(\d+)$/);
  if (!base || !target) return formulaText;
  const columnDelta = columnNumber(target[1]) - columnNumber(base[1]);
  const rowDelta = Number(target[2]) - Number(base[2]);
  return formulaText
    .split(/("(?:[^"]|"")*")/)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(
        /(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)/g,
        (match, absoluteColumn, column, absoluteRow, row) => {
          const shiftedColumn = absoluteColumn
            ? column
            : columnLetters(columnNumber(column) + columnDelta);
          const shiftedRow = absoluteRow
            ? Number(row)
            : Number(row) + rowDelta;
          if (!shiftedColumn || shiftedRow < 1) return match;
          return `${absoluteColumn}${shiftedColumn}${absoluteRow}${shiftedRow}`;
        },
      );
    })
    .join("");
}

/**
 * DEFECT 0.12, SECOND FORM — THE SELF-CLOSING CELL.
 *
 * An EMPTY cell is emitted self-closing: `<x:c r="G22" s="40"/>`. This lookup
 * used to be a single pattern requiring a `</c>` to close it, so on an empty
 * cell the `[^>]*` before the `>` happily swallowed the `/`, the tag matched as
 * if it were an opening tag, and the non-greedy body ran on to the NEXT cell's
 * `</c>`. The function then returned the FOLLOWING cell's formula as though it
 * belonged to the empty one.
 *
 * That single mis-parse pointed both ways at once:
 *
 *   - `font-colour-contract` demanded GREEN on G22/H22/I22 across the six real
 *     cases because it believed those empty cells held `'Brokers'!D21`. Every
 *     one of the 18 reported violations was a phantom, and they are the reason
 *     that check has been failing.
 *   - `historical-provenance-comments` tests `!cellFormula` before it requires
 *     a source comment. A phantom formula on an empty cell made that condition
 *     false and SUPPRESSED the requirement — the same bug hiding real findings
 *     at the other end.
 *
 * Both forms are handled explicitly below: a self-closing cell has no children
 * and therefore no formula, full stop; a paired cell's body is taken from its
 * own closing tag and no further.
 */
function xmlCellFormula(worksheetXml, address) {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openPattern = new RegExp(
    `<((?:[A-Za-z_][\\w.-]*:)?c)\\b([^>]*\\br="${escaped}"[^>]*?)(\\/)?>`,
  );
  const cell = worksheetXml.match(openPattern);
  // No such cell, or the cell is self-closing and so has no formula child.
  if (!cell || cell[3]) return "";
  const bodyStart = cell.index + cell[0].length;
  const closingTag = `</${cell[1]}>`;
  const bodyEnd = worksheetXml.indexOf(closingTag, bodyStart);
  const inner = bodyEnd === -1 ? "" : worksheetXml.slice(bodyStart, bodyEnd);
  const formulaTag = inner.match(
    /<(?:[A-Za-z_][\w.-]*:)?f\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>|<(?:[A-Za-z_][\w.-]*:)?f\b([^>]*)\/>/,
  );
  if (!formulaTag) return "";
  const directFormula = formulaTag[2] ?? "";
  if (directFormula) return directFormula;
  const formulaAttributes = formulaTag[1] ?? formulaTag[3] ?? "";
  const sharedIndex = formulaAttributes.match(/\bsi="(\d+)"/)?.[1];
  if (!sharedIndex) return "";
  const cellPattern =
    /<(?:[A-Za-z_][\w.-]*:)?c\b[^>]*\br="([A-Z]+\d+)"[^>]*?(?<!\/)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>/g;
  for (const candidate of worksheetXml.matchAll(cellPattern)) {
    const baseFormula = candidate[2].match(
      new RegExp(
        `<(?:[A-Za-z_][\\w.-]*:)?f\\b[^>]*\\bt="shared"[^>]*\\bsi="${sharedIndex}"[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?f>`,
      ),
    )?.[1];
    if (baseFormula) {
      return shiftSharedFormula(baseFormula, candidate[1], address);
    }
  }
  return "";
}

function sameSheetReferences(formulaText) {
  const formulaValue = String(formulaText ?? "").replace(
    /'(?:[^']|'')+'!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?|[A-Za-z_][A-Za-z0-9_.]*!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?/g,
    "",
  );
  const references = [];
  const withoutRanges = formulaValue.replace(
    /(?<![A-Za-z0-9_.])\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)/g,
    (_whole, firstColumn, firstRow, lastColumn, lastRow) => {
      const startColumn = columnNumber(firstColumn);
      const endColumn = columnNumber(lastColumn);
      const startRow = Number(firstRow);
      const endRow = Number(lastRow);
      for (
        let column = Math.min(startColumn, endColumn);
        column <= Math.max(startColumn, endColumn);
        column += 1
      ) {
        for (
          let row = Math.min(startRow, endRow);
          row <= Math.max(startRow, endRow);
          row += 1
        ) {
          references.push(`${columnLetters(column)}${row}`);
        }
      }
      return " ";
    },
  );
  references.push(
    ...[
      ...withoutRanges.matchAll(
        /(?<![A-Za-z0-9_.])\$?([A-Z]{1,3})\$?(\d+)/g,
      ),
    ].map((match) => `${match[1]}${match[2]}`),
  );
  return references;
}

function referencePathCount(sheet, worksheetSource, startAddress, targetAddress) {
  const memo = new Map();
  const active = new Set();
  const walk = (address) => {
    if (address === targetAddress) return 1;
    if (memo.has(address)) return memo.get(address);
    if (active.has(address)) return 0;
    active.add(address);
    const formulaText =
      formula(sheet, address) || xmlCellFormula(worksheetSource, address);
    const total = sameSheetReferences(formulaText).reduce(
      (sum, dependency) => sum + walk(dependency),
      0,
    );
    active.delete(address);
    memo.set(address, total);
    return total;
  };
  return walk(startAddress);
}

function formulaClosure(sheet, worksheetSource, startAddress, maxCells = 250) {
  const queue = [startAddress];
  const visited = new Set();
  const formulas = [];
  const references = new Set();
  while (queue.length > 0 && visited.size < maxCells) {
    const address = queue.shift();
    if (visited.has(address)) continue;
    visited.add(address);
    const formulaText =
      formula(sheet, address) || xmlCellFormula(worksheetSource, address);
    if (!formulaText) continue;
    formulas.push({ address, formula: formulaText });
    for (const reference of sameSheetReferences(formulaText)) {
      references.add(reference);
      if (!visited.has(reference)) queue.push(reference);
    }
  }
  return { formulas, references: [...references] };
}

const { positional, options } = parseArgs(process.argv.slice(2));
const inputPath = path.resolve(positional[0] ?? "");
const outputDirectory = path.resolve(options.out ?? "");
const toleranceOverride =
  options.tolerance === undefined ? null : Number(options.tolerance);
if (!positional[0] || !options.out) {
  throw new Error(
    "Usage: validate_dynamic_model.mjs <workbook.xlsx> --out <folder> [--visual-reviewed <image>] [--finance-reviewed <json>]",
  );
}

await fs.mkdir(outputDirectory, { recursive: true });
const [
  rowMapBuffer,
  solution,
  coverage,
  semanticManifestText,
  sourceCrosswalkText,
  workbookBuffer,
] = await Promise.all([
  fs.readFile(`${inputPath}.row-map.json`),
  fs.readFile(`${inputPath}.solution.json`, "utf8").then(JSON.parse),
  fs.readFile(`${inputPath}.coverage.json`, "utf8").then(JSON.parse),
  fs.readFile(`${inputPath}.semantic-manifest.json`, "utf8"),
  fs.readFile(`${inputPath}.source-crosswalk.csv`, "utf8"),
  fs.readFile(inputPath),
]);
const rowPlan = JSON.parse(rowMapBuffer.toString("utf8"));
const semanticManifest = JSON.parse(semanticManifestText);
const sourceCrosswalk = parseCsv(sourceCrosswalkText);
const productionContract = JSON.parse(
  await fs.readFile(
    new URL("../assets/production-contract-v2.json", import.meta.url),
    "utf8",
  ),
);
const tolerances = buildToleranceResolver(
  productionContract,
  rowPlan.issuer_units,
  toleranceOverride,
);
// Keeps the old single-band call sites honest while they are converted: every
// remaining use has to name a check and a metric class.
const toleranceFor = (checkId, metricClass, magnitude) =>
  tolerances.resolve(checkId, metricClass, magnitude);
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const operatingModel = workbook.worksheets.getItem("Operating Model");
const zip = await JSZip.loadAsync(workbookBuffer);

// DEFECT 0.15 — A PART NAME IS A CONVENTION, A RELATIONSHIP IS A FACT.
//
// `xl/workbook.xml`, `xl/styles.xml`, `xl/comments1.xml`,
// `xl/worksheets/sheet1.xml`, `xl/externalLinks/…`, `xl/drawings/drawing*.xml`
// are all names a producer HAPPENS to choose. OPC says the package's
// `_rels/.rels` names the workbook part, the workbook's own `.rels` names
// styles, shared strings, every worksheet and every external link, and each
// worksheet's `.rels` names its comments and its drawings. Nothing requires any
// of them to be where the guess looks.
//
// This is the FOURTH instance of the same defect in this project — the comments
// part, a sheet asked for by the name "Model", a dangling-reference regex
// anchored on a literal prefix, and these — and the consequence is never a
// crash. `xl/comments1.xml` is what the artifact writer emits and
// `xl/comments/comment1.xml` is what openpyxl emits, so the guess read one
// producer's comments as absent while reporting a clean pass. A missed
// `externalLinks/` prefix reports "no external link" about a workbook that has
// one. Every one of these fails GREEN.
//
// So: resolve through relationships, and make a resolution that finds nothing
// say so loudly rather than hand back an empty string that reads as "clean".
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_OFFICE_DOCUMENT = `${REL}/officeDocument`;
const REL_STYLES = `${REL}/styles`;
const REL_WORKSHEET = `${REL}/worksheet`;
const REL_COMMENTS = `${REL}/comments`;
const REL_DRAWING = `${REL}/drawing`;
const REL_EXTERNAL_LINK = `${REL}/externalLink`;

/** Resolve a relationship Target against the folder of the part declaring it. */
function resolvePart(basePart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const base = basePart.includes("/")
    ? basePart.slice(0, basePart.lastIndexOf("/"))
    : "";
  const segments = base ? base.split("/") : [];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

async function zipText(name) {
  const entry = zip.file(name);
  return entry ? await entry.async("string") : "";
}

/** Every relationship a part declares, as {id, type, target}. */
async function relationships(part) {
  const directory = part.includes("/")
    ? `${part.slice(0, part.lastIndexOf("/"))}/`
    : "";
  const basename = part.slice(part.lastIndexOf("/") + 1);
  const text = await zipText(`${directory}_rels/${basename}.rels`);
  if (!text) return [];
  return [...text.matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((match) => {
      const attributes = match[1];
      const attribute = (name) =>
        attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
      return {
        id: attribute("Id"),
        type: attribute("Type"),
        target: attribute("Target"),
        mode: attribute("TargetMode"),
      };
    })
    .filter(
      (item) =>
        item.target &&
        item.mode !== "External" &&
        !/^https?:/i.test(item.target),
    )
    .map((item) => ({ ...item, target: resolvePart(part, item.target) }));
}

async function relatedParts(part, relationshipType) {
  return (await relationships(part))
    .filter((item) => item.type === relationshipType)
    .map((item) => item.target);
}

/** Read a part that MUST have content, naming the part that failed if not. */
async function requirePart(part, label) {
  if (!part) {
    throw new Error(
      `${label} resolved to no part at all (zip entries: ${Object.keys(zip.files).join(", ")})`,
    );
  }
  const text = await zipText(part);
  if (!text) {
    throw new Error(
      `${label} resolved to "${part}", which is absent or empty (zip entries: ${Object.keys(zip.files).join(", ")})`,
    );
  }
  return text;
}

const workbookPart = (await relatedParts("", REL_OFFICE_DOCUMENT))[0];
const workbookXml = await requirePart(workbookPart, "workbook");
const stylesXml = await requirePart(
  (await relatedParts(workbookPart, REL_STYLES))[0],
  "styles",
);
const workbookRelationships = await relationships(workbookPart);
const worksheetPartsByName = new Map();
for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
  const attributes = match[1];
  const name = attributes.match(/\bname="([^"]*)"/)?.[1];
  const relationshipId = attributes.match(/\b(?:\w+:)?id="([^"]*)"/)?.[1];
  const target = workbookRelationships.find(
    (item) => item.id === relationshipId && item.type === REL_WORKSHEET,
  )?.target;
  if (name && target) worksheetPartsByName.set(name, target);
}
const operatingModelPart = worksheetPartsByName.get("Operating Model");
const worksheetXml = await requirePart(
  operatingModelPart,
  'the "Operating Model" worksheet',
);
// Concatenated rather than "the first": a producer may legally split a sheet's
// comments across parts, and taking only the head is the same under-read in a
// different disguise.
const commentsParts = await relatedParts(operatingModelPart, REL_COMMENTS);
const commentsXml = (
  await Promise.all(commentsParts.map((part) => zipText(part)))
).join("");
const [financeReview, visualReview] = await Promise.all([
  reviewEvidence(options["finance-reviewed"], { jsonRequired: true }),
  reviewEvidence(options["visual-reviewed"]),
]);
const checks = [];

const sheets = parseNdjson(
  (
    await workbook.inspect({
      kind: "sheet",
      include: "id,name",
      maxChars: 10000,
    })
  ).ndjson,
)
  .filter((item) => item.kind === "sheet")
  .map((item) => item.name);
const coreSheets = ["Operating Model", "Brokers", "Forward Curves"];
const isBrokerEvidenceSheet = (name) =>
  name === "> Brokers" || /^B(?:0[1-9]|10)\s/.test(name);
const evidenceSheets = sheets.filter(isBrokerEvidenceSheet);
const unknownSheets = sheets.filter(
  (name) => !coreSheets.includes(name) && !isBrokerEvidenceSheet(name),
);
const coreOrder = sheets.filter((name) => coreSheets.includes(name));
const evidenceContractValid =
  evidenceSheets.length === 0 ||
  evidenceSheets.every((name) => /^B(?:0[1-9]|10)\s/.test(name)) ||
  (evidenceSheets[0] === "> Brokers" &&
    evidenceSheets.slice(1).every((name) => /^B(?:0[1-9]|10)\s/.test(name)));
checks.push(
  record(
    "sheet-contract",
    unknownSheets.length === 0 &&
      JSON.stringify(coreOrder) === JSON.stringify(coreSheets) &&
      evidenceContractValid,
    "Workbook contains the three core sheets plus only an optional declared broker-evidence extension.",
    { sheets, coreSheets, evidenceSheets, unknownSheets },
  ),
);

checks.push(
  record(
    "coverage-gate",
    coverage.ready_to_build === true,
    "The persisted coverage report passed before build.",
    coverage.summary,
  ),
);

const formulaMatrix = operatingModel.getRange(
  `A1:U${Number(rowPlan.visible_end_row)}`,
).formulas ?? [];
const formulaLengths = formulaMatrix
  .flat()
  .filter(
    (value) => typeof value === "string" && value.trim().startsWith("="),
  )
  .map((value) => value.length)
  .sort((left, right) => left - right);
const formulaMaximum = formulaLengths.at(-1) ?? 0;
const formulaP95 = formulaLengths.length
  ? formulaLengths[Math.min(
      formulaLengths.length - 1,
      Math.floor(formulaLengths.length * 0.95),
    )]
  : 0;
checks.push(
  record(
    "formula-complexity-contract",
    formulaMaximum <= 1600 && formulaP95 <= 750,
    "Visible formulas remain auditable: no formula exceeds 1,600 characters and the 95th percentile does not exceed 750 characters.",
    {
      formula_count: formulaLengths.length,
      maximum_characters: formulaMaximum,
      p95_characters: formulaP95,
      maximum_allowed: 1600,
      p95_allowed: 750,
    },
  ),
);

const semanticArtifactErrors = validateSemanticArtifacts(
  semanticManifest,
  sourceCrosswalk,
);
checks.push(
  record(
    "semantic-artifact-completeness",
    semanticArtifactErrors.length === 0,
    "The semantic manifest and source crosswalk contain no unresolved dependencies or orphan material source rows.",
    semanticArtifactErrors.slice(0, 100),
  ),
);
checks.push(
  record(
    "semantic-artifact-case-binding",
    semanticManifest.case_id === solution.case_id &&
      /^[a-f0-9]{64}$/.test(String(semanticManifest.case_sha256 ?? "")),
    "Semantic artifacts are bound to the solved case by case ID and deterministic case hash.",
    {
      manifest_case_id: semanticManifest.case_id ?? null,
      solution_case_id: solution.case_id ?? null,
      case_sha256: semanticManifest.case_sha256 ?? null,
    },
  ),
);
const fiscalPeriodErrors = validateFiscalPeriods({
  issuer: {
    fiscal_year_end: semanticManifest.fiscal_year_end,
    fiscal_calendar: semanticManifest.fiscal_calendar ?? "fixed_date",
  },
  periods: semanticManifest.periods,
});
checks.push(
  record(
    "fiscal-year-period-contract",
    fiscalPeriodErrors.length === 0,
    "All six periods end on the issuer's declared fiscal year-end, including non-December issuers.",
    fiscalPeriodErrors,
  ),
);
const rcfContract = semanticManifest.rcf_contract ?? {};
const rcfContractErrors = [];
const rcfContractMode = rcfContract.mode ??
  (rcfContract.instrument_id ? "balancing_rcf" : "none");
if (rcfContractMode === "none") {
  for (const key of ["instrument_id", "instrument_opening_balance", "instrument_capacity"]) {
    if (rcfContract[key] !== null && rcfContract[key] !== undefined && rcfContract[key] !== "") {
      rcfContractErrors.push({ id: `none_has_${key}`, value: rcfContract[key] });
    }
  }
  for (const key of ["policy_opening_draw", "policy_capacity"]) {
    if (numeric(rcfContract[key]) !== 0) {
      rcfContractErrors.push({ id: `none_nonzero_${key}`, value: rcfContract[key] });
    }
  }
} else {
  for (const key of [
    "instrument_id",
    "policy_opening_draw",
    "instrument_opening_balance",
    "policy_capacity",
    "instrument_capacity",
  ]) {
    if (
      rcfContract[key] === null ||
      rcfContract[key] === undefined ||
      rcfContract[key] === ""
    ) {
      rcfContractErrors.push({ id: `missing_${key}` });
    }
  }
  if (
    Math.abs(
      numeric(rcfContract.policy_opening_draw) -
        numeric(rcfContract.instrument_opening_balance),
    ) >
    toleranceFor(
      "input-authority",
      "currency",
      numeric(rcfContract.policy_opening_draw),
    )
  ) {
    rcfContractErrors.push({
      id: "opening_draw",
      policy: rcfContract.policy_opening_draw ?? null,
      instrument: rcfContract.instrument_opening_balance ?? null,
    });
  }
  if (
    Math.abs(
      numeric(rcfContract.policy_capacity) -
        numeric(rcfContract.instrument_capacity),
    ) >
    toleranceFor(
      "input-authority",
      "currency",
      numeric(rcfContract.policy_capacity),
    )
  ) {
    rcfContractErrors.push({
      id: "capacity",
      policy: rcfContract.policy_capacity ?? null,
      instrument: rcfContract.instrument_capacity ?? null,
    });
  }
}
checks.push(
  record(
    "single-rcf-input-authority",
    rcfContractErrors.length === 0,
    "The liquidity policy either resolves to one reconciled balancing facility or explicitly proves that no balancing facility exists.",
    rcfContractErrors,
  ),
);

// DEFECT 0.12 — A SEARCH THAT FOUND NOTHING AND A SEARCH THAT RAN NOWHERE
// LOOK IDENTICAL. `matched 0 entries` is the pass condition, so any change to
// the inspector — a renamed sheet, a changed argument name, a silent empty
// result — turns this into an unconditional pass over a workbook it never
// opened. The POSITIVE CONTROL below searches for a string that must exist in
// every workbook this validator will ever be handed (the section headings the
// row plan guarantees). If the control finds nothing, the search engine is not
// reaching the workbook and the error scan proves nothing.
const formulaErrorProbe = await workbook.inspect({
  kind: "match",
  searchTerm: "#(REF!|DIV/0!|VALUE!|NAME\\?|N/A|NUM!)",
  options: { useRegex: true, maxResults: 1000 },
  maxChars: 30000,
});
const formulaErrors = formulaErrorProbe.ndjson;
const searchPositiveControl = (
  await workbook.inspect({
    kind: "match",
    searchTerm: "INCOME STATEMENT",
    options: { useRegex: false, maxResults: 10 },
    maxChars: 10000,
  })
).ndjson;
const searchEngineReachedWorkbook =
  !/matched 0 entries/i.test(searchPositiveControl);
checks.push(
  record(
    "formula-errors",
    searchEngineReachedWorkbook && /matched 0 entries/i.test(formulaErrors),
    searchEngineReachedWorkbook
      ? "No spreadsheet formula errors were found."
      : "The workbook search engine returned ZERO hits for a string every workbook contains — the error scan visited nothing and cannot pass.",
    { positive_control: searchPositiveControl, error_scan: formulaErrors },
  ),
);
// DEFECT 0.12. `!/\[[^\]]+\]/.test(worksheetXml)` is true of the empty string.
// If the worksheet part were ever missing or renamed this reported a clean
// pass over nothing at all, so the visit is now asserted before the absence.
const zipEntryCount = Object.keys(zip.files).length;
// DEFECT 0.15. `startsWith("xl/externalLinks/")` is a naming convention, not
// the fact. An external workbook link is a workbook-level RELATIONSHIP; a
// producer that parks the part elsewhere still has the link and this reported
// "no external-workbook link" about it. The relationship is now the authority,
// and the name-prefix sweep is kept ALONGSIDE it — a part sitting in
// `xl/externalLinks/` that no relationship points at is orphaned rather than
// harmless, and is reported too.
const externalLinkRelationships = await relatedParts(
  workbookPart,
  REL_EXTERNAL_LINK,
);
const externalLinkPartsByName = Object.keys(zip.files).filter((name) =>
  name.startsWith("xl/externalLinks/"),
);
const externalLinkParts = [
  ...new Set([...externalLinkRelationships, ...externalLinkPartsByName]),
];
const bracketedReferences = [
  ...worksheetXml.matchAll(/\[[^\]]+\]/g),
].map((match) => match[0]);
// The relationship scan can only have read the package if the workbook part
// itself resolved, which `requirePart` already guaranteed above.
const externalLinksVisited = zipEntryCount > 0 && worksheetXml.length > 0;
checks.push(
  record(
    "external-workbook-links",
    externalLinksVisited &&
      externalLinkParts.length === 0 &&
      bracketedReferences.length === 0,
    externalLinksVisited
      ? "No external-workbook link was found."
      : "The external-link scan saw no zip entries or an empty worksheet — the check cannot pass on an empty visit.",
    {
      zip_entries_scanned: zipEntryCount,
      worksheet_xml_length: worksheetXml.length,
      workbook_part: workbookPart,
      external_link_relationships: externalLinkRelationships,
      external_link_parts_by_name: externalLinkPartsByName,
      external_link_parts: externalLinkParts,
      bracketed_references: bracketedReferences.slice(0, 20),
    },
  ),
);
// DEFECT 0.15, same shape. `^xl/drawings/drawing[^/]*\.xml$` misses a drawing
// part a producer names anything else, and the check exists precisely to catch
// a shape or chart nobody meant to ship. A drawing is a WORKSHEET relationship;
// every worksheet in the package is asked for its own, and the name sweep is
// kept beside it so an orphaned drawing part is reported as well.
const worksheetParts = [...worksheetPartsByName.values()];
const drawingRelationships = [
  ...new Set(
    (
      await Promise.all(
        worksheetParts.map((part) => relatedParts(part, REL_DRAWING)),
      )
    ).flat(),
  ),
];
const drawingPartsByName = Object.keys(zip.files).filter((name) =>
  /^xl\/drawings\/drawing[^/]*\.xml$/i.test(name),
);
const ordinaryDrawingParts = [
  ...new Set([...drawingRelationships, ...drawingPartsByName]),
];
const permittedBrokerDrawingParts = new Set(
  (
    await Promise.all(
      [...worksheetPartsByName.entries()]
        .filter(([name]) => /^B\d{2} .+/.test(name))
        .map(([, part]) => relatedParts(part, REL_DRAWING)),
    )
  ).flat(),
);
const unintendedDrawingParts = ordinaryDrawingParts.filter(
  (part) => !permittedBrokerDrawingParts.has(part),
);
const invalidBrokerDrawingParts = [];
for (const part of permittedBrokerDrawingParts) {
  const xml = await zipText(part);
  const pictureCount = (xml.match(/<(?:\w+:)?pic\b/g) ?? []).length;
  const anchorCount = (xml.match(/<(?:\w+:)?oneCellAnchor\b/g) ?? []).length;
  const forbidden = xml.match(
    /<(?:\w+:)?(?:graphicFrame|sp|grpSp|twoCellAnchor|absoluteAnchor)\b/g,
  ) ?? [];
  if (pictureCount === 0 || pictureCount !== anchorCount || forbidden.length > 0) {
    invalidBrokerDrawingParts.push(part);
  }
}
// DEFECT 0.12. An empty zip listing, or a package whose sheets never resolved,
// yields an empty filter result — which is the pass condition. Both the listing
// and the worksheet set are asserted non-empty first.
const drawingScanVisited = zipEntryCount > 0 && worksheetParts.length > 0;
checks.push(
  record(
    "no-unintended-drawings",
    drawingScanVisited &&
      unintendedDrawingParts.length === 0 &&
      invalidBrokerDrawingParts.length === 0,
    drawingScanVisited
      ? "No unintended DrawingML part is present; raster evidence is permitted only on Bxx broker source-page sheets."
      : "The drawing-part scan listed ZERO zip entries or resolved ZERO worksheets — the check cannot pass on an empty visit.",
    {
      zip_entries_scanned: zipEntryCount,
      worksheets_scanned: worksheetParts,
      drawing_relationships: drawingRelationships,
      drawing_parts_by_name: drawingPartsByName,
      drawing_parts: ordinaryDrawingParts,
      permitted_broker_drawing_parts: [...permittedBrokerDrawingParts],
      unintended_drawing_parts: unintendedDrawingParts,
      invalid_broker_drawing_parts: invalidBrokerDrawingParts,
    },
  ),
);

const expectedSections = {
  income_statement: "3. INCOME STATEMENT",
  cash_flow: "4. CASH FLOW",
  debt_schedule: "5. DEBT SCHEDULE",
  rcf_waterfall:
    rcfContractMode === "none"
      ? "6. CASH / LIQUIDITY WATERFALL — NO BALANCING FACILITY"
      : "6. RCF CASH SWEEP",
  interest_schedule: "7. INTEREST SCHEDULE",
};
const badSections = Object.entries(expectedSections)
  .map(([id, expected]) => ({
    id,
    row: rowPlan.section_headers[id],
    expected,
    actual: value(operatingModel, `B${rowPlan.section_headers[id]}`),
  }))
  .filter((item) => item.actual !== item.expected);
checks.push(
  record(
    "dynamic-section-map",
    badSections.length === 0,
    "All six CRH sections resolve through the dynamic row plan.",
    badSections,
  ),
);

const periods = ["G", "H", "I", "J", "K", "L"].map((column) =>
  value(operatingModel, `${column}${rowPlan.period_row}`),
);
checks.push(
  record(
    "three-historical-three-forecast",
    periods.every((item) => item !== null && item !== ""),
    "The model contains exactly three historical and three forecast periods.",
    periods,
  ),
);

const controlEvidence = {
  circularity: value(
    operatingModel,
    `C${rowPlan.controls.circularity}`,
  ),
  debt_maturities_roll: value(
    operatingModel,
    `C${rowPlan.controls.debt_maturities_roll}`,
  ),
  adjustments: value(
    operatingModel,
    `P${rowPlan.controls.adjustments_enabled}`,
  ),
};
checks.push(
  record(
    "binary-controls",
    Object.values(controlEvidence).every((item) => [0, 1].includes(item)),
    "Circularity, maturity roll and adjustment-columns controls are numeric 1/0 toggles.",
    controlEvidence,
  ),
);

checks.push(
  record(
    "iteration-contract",
    /\biterate="(1|true)"/.test(workbookXml) &&
      Number(workbookXml.match(/\biterateCount="([^"]+)"/)?.[1]) ===
        ECONOMIC_SOLVE_POLICY.workbook_calculation.iterate_count &&
      Number(workbookXml.match(/\biterateDelta="([^"]+)"/)?.[1]) ===
        ECONOMIC_SOLVE_POLICY.workbook_calculation.iterate_delta,
    `Workbook calculation settings use ${ECONOMIC_SOLVE_POLICY.workbook_calculation.iterate_count} iterations and ${ECONOMIC_SOLVE_POLICY.workbook_calculation.iterate_delta} tolerance.`,
    {
      iterate_enabled: /\biterate="(1|true)"/.test(workbookXml),
      iterate_count:
        workbookXml.match(/\biterateCount="([^"]+)"/)?.[1] ??
        "missing",
      iterate_delta:
        workbookXml.match(/\biterateDelta="([^"]+)"/)?.[1] ??
        "missing",
      expected: ECONOMIC_SOLVE_POLICY.workbook_calculation,
    },
  ),
);
// INVERTED (2026-07-26). This check used to assert that the mechanical
// support block below the interest schedule WAS hidden. The block no longer
// exists: interest is computed on the face of the model, straight off the
// visible debt schedule. The requirement is now the opposite — no row of the
// operating model may be hidden, and nothing may be written below the last
// row the reader can see.
const hiddenRows = [
  ...worksheetXml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*\br="(\d+)"[^>]*\bhidden="1"[^>]*>/g,
  ),
].map((match) => Number(match[1]));
const allWorksheetRows = [
  ...worksheetXml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*\br="(\d+)"[^>]*>/g,
  ),
].map((match) => Number(match[1]));
const rowsBelowVisibleEnd = allWorksheetRows.filter(
  (row) => row > rowPlan.visible_end_row,
);
checks.push(
  record(
    "hidden-mechanics",
    // DEFECT 0.12. The workbook emits <x:row> on some writers and <row> on
    // others. A prefix-naive pattern matches nothing, both arrays come back
    // empty and this reports a clean pass over a sheet it never read.
    allWorksheetRows.length > 0 &&
      hiddenRows.length === 0 &&
      rowsBelowVisibleEnd.length === 0,
    allWorksheetRows.length > 0
      ? "No hidden rows and no content below the last visible row — every mechanical calculation is on the face of the model."
      : "The row scanner matched ZERO rows in the worksheet XML — the check cannot pass on an empty visit.",
    {
      rows_scanned: allWorksheetRows.length,
      hidden_rows: hiddenRows,
      rows_below_visible_end: rowsBelowVisibleEnd,
    },
  ),
);

const commentRefs = new Set(
  [...commentsXml.matchAll(/\bref="([A-Z]+\d+)"/g)].map(
    (match) => match[1],
  ),
);
const missingComments = [];
let provenanceCellsVisited = 0;
for (const definition of [
  ...rowPlan.statement_rows.income_statement,
  ...rowPlan.statement_rows.cash_flow,
]) {
  for (let index = 0; index < 3; index += 1) {
    const address = `${["G", "H", "I"][index]}${definition.row}`;
    const cellValue = value(operatingModel, address);
    const cellFormula =
      formula(operatingModel, address) ||
      xmlCellFormula(worksheetXml, address);
    const literalHistorical =
      ["input", "uncalculated"].includes(definition.row_type) ||
      (["calculation", "subtotal"].includes(definition.row_type) &&
        (definition.calculation?.refs?.length ?? 0) === 0);
    if (
      literalHistorical &&
      cellValue !== null &&
      cellValue !== "" &&
      !cellFormula
    ) {
      provenanceCellsVisited += 1;
      if (!commentRefs.has(address)) missingComments.push(address);
    }
  }
}
checks.push(
  record(
    "historical-provenance-comments",
    provenanceCellsVisited > 0 && missingComments.length === 0,
    provenanceCellsVisited > 0
      ? "Every populated historical statement hardcode carries a source comment."
      : "The provenance scanner found ZERO historical hardcodes — a model with no reported history is not a model, so this cannot pass on an empty visit.",
    { visited: provenanceCellsVisited, missing: missingComments },
  ),
);

const styles = styleMaps(stylesXml, worksheetXml);
const forecastCompleteness = validateForecastWorkbookCompleteness({
  statementRows: [
    ...rowPlan.statement_rows.income_statement,
    ...rowPlan.statement_rows.cash_flow,
  ],
  manifestNodes: semanticManifest.nodes,
  forecastColumns: FORECAST_COLUMNS,
  cellAt: (address) => ({
    value: value(operatingModel, address),
    formula:
      formula(operatingModel, address) ||
      xmlCellFormula(worksheetXml, address),
    fontColor: styles.get(address)?.color ?? null,
    fillColor: styles.get(address)?.fillColor ?? null,
    hasComment: commentRefs.has(address),
  }),
});
checks.push(
  record(
    "forecast-authority-workbook-completeness",
    forecastCompleteness.visited > 0 && forecastCompleteness.errors.length === 0,
    forecastCompleteness.visited > 0
      ? "Every visible forecast statement cell implements its declared formula, broker, hardcode, zero or intentionally-uncalculated authority."
      : "The forecast-completeness gate visited zero cells and cannot pass vacuously.",
    {
      visited: forecastCompleteness.visited,
      errors: forecastCompleteness.errors.slice(0, 100),
    },
  ),
);
const colourErrors = [];
let colourCellsVisited = 0;
for (const definition of [
  ...rowPlan.statement_rows.income_statement,
  ...rowPlan.statement_rows.cash_flow,
]) {
  if (definition.row_type === "header") continue;
  for (const column of ALL_MODEL_COLUMNS) {
    const address = `${column}${definition.row}`;
    const cellValue = value(operatingModel, address);
    const cellFormula =
      formula(operatingModel, address) ||
      xmlCellFormula(worksheetXml, address);
    if ((cellValue === null || cellValue === "") && !cellFormula) continue;
    colourCellsVisited += 1;
    const expected = cellFormula
      ? /(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!/.test(cellFormula)
        ? "008000"
        : "000000"
      : "0000FF";
    if (expected && styles.get(address)?.color !== expected) {
      colourErrors.push({
        address,
        expected,
        actual: styles.get(address)?.color ?? null,
        formula: cellFormula,
      });
    }
  }
}
checks.push(
  record(
    "font-colour-contract",
    colourCellsVisited > 0 && colourErrors.length === 0,
    colourCellsVisited > 0
      ? "Historical hardcodes are blue, internal formulas black and cross-sheet formulas green."
      : "The font-colour scanner inspected ZERO populated cells — the check cannot pass on an empty visit.",
    { visited: colourCellsVisited, errors: colourErrors.slice(0, 50) },
  ),
);

const typographyErrors = [];
const redNumberFormats = [];
let typographyCellsVisited = 0;
for (const [address, style] of styles.entries()) {
  const match = address.match(/^([A-Z]+)(\d+)$/);
  if (!match) continue;
  const row = Number(match[2]);
  if (row > rowPlan.visible_end_row) continue;
  const cellValue = value(operatingModel, address);
  const cellFormula =
    formula(operatingModel, address) ||
    xmlCellFormula(worksheetXml, address);
  if ((cellValue === null || cellValue === "") && !cellFormula) continue;
  typographyCellsVisited += 1;
  if (style.name !== "Calibri" || Math.abs(style.size - 8) > 1e-9) {
    typographyErrors.push({
      address,
      expected_name: "Calibri",
      expected_size: 8,
      actual_name: style.name,
      actual_size: style.size,
    });
  }
  if (/\[Red\]/i.test(style.numberFormat ?? "")) {
    redNumberFormats.push({
      address,
      number_format: style.numberFormat,
    });
  }
}
for (const row of Object.values(rowPlan.section_headers)) {
  const style = styles.get(`B${row}`);
  if (
    style &&
    (style.color !== "FFFFFF" || style.bold !== true)
  ) {
    typographyErrors.push({
      address: `B${row}`,
      expected: "white bold section title",
      actual: style,
    });
  }
}
checks.push(
  record(
    "typography-contract",
    // DEFECT 0.12. `styles` is built by a regex over the worksheet XML. If it
    // comes back empty this loop never runs and both of these checks pass
    // having inspected nothing at all.
    typographyCellsVisited > 0 && typographyErrors.length === 0,
    typographyCellsVisited > 0
      ? "Visible populated cells use Calibri 8 and section titles are white and bold."
      : "The typography scanner inspected ZERO styled cells — the check cannot pass on an empty visit.",
    { visited: typographyCellsVisited, errors: typographyErrors.slice(0, 50) },
  ),
);
checks.push(
  record(
    "number-format-colour-contract",
    typographyCellsVisited > 0 && redNumberFormats.length === 0,
    typographyCellsVisited > 0
      ? "Number formats do not override hardcode/formula font-colour semantics."
      : "The number-format scanner inspected ZERO styled cells — the check cannot pass on an empty visit.",
    { visited: typographyCellsVisited, errors: redNumberFormats.slice(0, 50) },
  ),
);

const allStatementRows = [
  ...rowPlan.statement_rows.income_statement,
  ...rowPlan.statement_rows.cash_flow,
];
const arithmeticErrors = [];
let arithmeticVisited = 0;
for (const column of ["G", "H", "I", ...FORECAST_COLUMNS, ...PRO_FORMA_COLUMNS]) {
  const valuesById = new Map(
    allStatementRows.map((definition) => [
      definition.row_id,
      value(operatingModel, `${column}${definition.row}`),
    ]),
  );
  const priorColumn = {
    H: "G",
    I: "H",
    K: "J",
    L: "K",
    T: "S",
    U: "T",
  }[column];
  const priorValues = priorColumn
    ? new Map(
        allStatementRows.map((definition) => [
          definition.row_id,
          value(operatingModel, `${priorColumn}${definition.row}`),
        ]),
      )
    : null;
  for (const definition of allStatementRows.filter((item) => {
    const forecastLike =
      FORECAST_COLUMNS.includes(column) || PRO_FORMA_COLUMNS.includes(column);
    // "hardcode" and "zero" are deliberately NOT skip reasons. Declaring a row
    // a hardcode was previously enough to exempt it from arithmetic checking —
    // so the misclassification that flattened a formula also suppressed the
    // check that would have caught it. Only broker-sourced forecasts and
    // intentionally uncalculated rows legitimately have no calculation.
    const forecastIndex = FORECAST_COLUMNS.includes(column)
      ? FORECAST_COLUMNS.indexOf(column)
      : PRO_FORMA_COLUMNS.indexOf(column);
    const periodRules = item.forecast_period_calculations;
    const activeCalculation = forecastLike
      ? Array.isArray(periodRules)
        ? FORECAST_COLUMNS.includes(column)
          ? periodRules[forecastIndex] ?? null
          : null
        : item.forecast_calculation ??
          (["broker", "uncalculated"].includes(item.forecast_treatment)
            ? null
            : item.calculation)
      : item.calculation;
    return (
      activeCalculation &&
      ![
        "interest_income",
        "interest_expense",
        "opening_cash",
        "ending_cash",
        "debt_issuance",
        "debt_repayment",
        "rcf_draw",
        "rcf_repayment",
        "lease_principal",
        "acquisition_consideration",
        "acquisition_debt_proceeds",
        "non_cash_interest_addback",
      ].includes(item.semantic_role)
    );
  })) {
    const forecastLike =
      FORECAST_COLUMNS.includes(column) || PRO_FORMA_COLUMNS.includes(column);
    const forecastIndex = FORECAST_COLUMNS.includes(column)
      ? FORECAST_COLUMNS.indexOf(column)
      : PRO_FORMA_COLUMNS.indexOf(column);
    const activeCalculation = forecastLike
      ? Array.isArray(definition.forecast_period_calculations)
        ? FORECAST_COLUMNS.includes(column)
          ? definition.forecast_period_calculations[forecastIndex] ?? null
          : null
        : definition.forecast_calculation ?? definition.calculation
      : definition.calculation;
    // growth AND prior_period both read the previous column. Columns G, J and
    // S have no prior, so evaluating them there yields a spurious expected 0
    // against real seeded history.
    if (
      ["growth", "prior_period", "prior_period_scaled_by"].includes(
        activeCalculation.operator,
      ) &&
      !priorValues
    ) {
      continue;
    }
    // A prior_period reference to the row ITSELF is a hold-flat FORECAST rule.
    // History is three separately reported actuals, so asserting H = G and
    // I = H across the historic block would demand the builder overwrite two
    // real figures with the first — which is precisely the defect this fence
    // exists to prevent. A prior_period reference to a DIFFERENT row is a
    // genuine roll-forward and stays checked in every column.
    if (
      !forecastLike &&
      activeCalculation.operator === "prior_period" &&
      activeCalculation.refs?.length === 1 &&
      activeCalculation.refs[0] === definition.row_id
    ) {
      continue;
    }
    const address = `${column}${definition.row}`;
    const actual = valuesById.get(definition.row_id);
    // DEFECT 0.8 — A COMPILED LINK IS NOT A SUM OF ITS DECLARED CONSTITUENTS.
    //
    // `Change in Debt` is declared as the sum of additions, repayments,
    // issuance costs and commercial-paper movements. In the FORECAST the
    // compiler does not write that sum: the constituents read n/a and the
    // consolidated line is emitted as a single LINK down to the debt schedule's
    // own "Total change in debt" — `J60 = J116`. Recomputing it from the blank
    // constituents expects 0 and gets the real movement, so on the maximal case
    // this check reported a 514.511 disagreement against a workbook that is
    // correct and a solver parity that passes. Every real case has a forecast
    // change in debt of exactly zero, which is why it never fired before.
    //
    // Where the emitted formula IS a bare link — one same-sheet reference and
    // nothing else — the check follows it and asserts the two cells agree.
    // That is a stricter statement than the one it replaces, not a weaker one:
    // it fails if the link points somewhere that does not hold the same number.
    const emittedFormula = String(
      formula(operatingModel, address) || xmlCellFormula(worksheetXml, address),
    ).replace(/^=/, "");
    const linkTarget = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(emittedFormula.trim());
    const expected = linkTarget
      ? value(operatingModel, `${linkTarget[1]}${linkTarget[2]}`)
      : calculationValue(
          definition,
          valuesById,
          priorValues,
          activeCalculation,
        );
    arithmeticVisited += 1;
    const band = toleranceFor(
      "statement-arithmetic",
      classifyMetric(definition),
      Math.max(Math.abs(numeric(actual)), Math.abs(numeric(expected))),
    );
    if (!approximatelyEqual(actual, expected, band)) {
      arithmeticErrors.push({
        address,
        row_id: definition.row_id,
        expected,
        actual,
        tolerance: band,
        basis: linkTarget
          ? `compiled link to ${linkTarget[1]}${linkTarget[2]}`
          : `constituents (${activeCalculation.operator})`,
      });
    }
  }
}
checks.push(
  record(
    "statement-arithmetic",
    // A scanner that visited nothing has not passed. See DEFECT 0.12.
    arithmeticVisited > 0 && arithmeticErrors.length === 0,
    arithmeticVisited > 0
      ? "Statement calculations, subtotals, ratios and growth rows recompute from their semantic components, and rows compiled as links resolve to the cell they point at."
      : "Statement arithmetic inspected ZERO rows — the check cannot pass on an empty visit.",
    { visited: arithmeticVisited, errors: arithmeticErrors.slice(0, 50) },
  ),
);

const adjustmentErrors = [];
let adjustmentVisited = 0;
for (let index = 0; index < 3; index += 1) {
  for (const definition of allStatementRows.filter(
    (item) => {
      const operators = [
        item.calculation?.operator,
        item.forecast_calculation?.operator,
      ].filter(Boolean);
      const isDerivedRate = operators.some((operator) =>
        /(ratio|margin|growth|percentage|rate)/i.test(operator),
      );
      return item.row_type !== "header" && !isDerivedRate;
    },
  )) {
    const standalone = value(
      operatingModel,
      `${FORECAST_COLUMNS[index]}${definition.row}`,
    );
    const adjustment = value(
      operatingModel,
      `${ADJUSTMENT_COLUMNS[index]}${definition.row}`,
    );
    const proForma = value(
      operatingModel,
      `${PRO_FORMA_COLUMNS[index]}${definition.row}`,
    );
    adjustmentVisited += 1;
    const band = toleranceFor(
      "standalone-adjustment-pro-forma-tie",
      classifyMetric(definition),
      Math.max(
        Math.abs(numeric(proForma)),
        Math.abs(numeric(standalone)) + Math.abs(numeric(adjustment)),
      ),
    );
    if (
      !approximatelyEqual(
        proForma,
        numeric(standalone) + numeric(adjustment),
        band,
      )
    ) {
      adjustmentErrors.push({
        row_id: definition.row_id,
        period_index: index,
        standalone,
        adjustment,
        pro_forma: proForma,
        tolerance: band,
      });
    }
  }
}
checks.push(
  record(
    "standalone-adjustment-pro-forma-tie",
    adjustmentVisited > 0 && adjustmentErrors.length === 0,
    adjustmentVisited > 0
      ? "Every statement row ties standalone plus adjustment to pro forma."
      : "The pro-forma tie inspected ZERO rows — the check cannot pass on an empty visit.",
    { visited: adjustmentVisited, errors: adjustmentErrors.slice(0, 50) },
  ),
);

const proFormaActualErrors = [];
let proFormaActualVisited = 0;
for (const definition of allStatementRows) {
  if (definition.row_type === "header") continue;
  proFormaActualVisited += 1;
  const actualAddress = `I${definition.row}`;
  const proFormaActualAddress = `R${definition.row}`;
  const proFormaActualFormula =
    formula(operatingModel, proFormaActualAddress) ||
    xmlCellFormula(worksheetXml, proFormaActualAddress);
  const actualValue = value(operatingModel, actualAddress);
  const proFormaActualValue = value(operatingModel, proFormaActualAddress);
  const declaredActual = definition.values?.[2];
  const intentionallyBlankZero =
    actualValue === null &&
    proFormaActualValue === null &&
    !proFormaActualFormula &&
    Number.isFinite(Number(declaredActual)) &&
    Math.abs(Number(declaredActual)) <= toleranceFor(
      "cross-row-equality",
      classifyMetric(definition),
      0,
    );
  if (intentionallyBlankZero) continue;
  // Schedule-owned rows with structurally empty history print greyed blanks
  // in BOTH actual and pro-forma actual — there is no filed number for the
  // pro-forma column to reproduce.
  const structurallyBlankSchedule =
    actualValue === null &&
    proFormaActualValue === null &&
    !proFormaActualFormula &&
    (declaredActual === null || declaredActual === undefined) &&
    definition.historical_authority === "schedule_link";
  if (structurallyBlankSchedule) continue;
  const formulaTies =
    String(proFormaActualFormula).replace(/^=/, "") ===
    `I${definition.row}`;
  if (
    !formulaTies ||
    !approximatelyEqual(
      actualValue,
      proFormaActualValue,
      toleranceFor(
        "cross-row-equality",
        classifyMetric(definition),
        Math.abs(numeric(actualValue)),
      ),
    )
  ) {
    proFormaActualErrors.push({
      row_id: definition.row_id,
      actual_address: actualAddress,
      pro_forma_actual_address: proFormaActualAddress,
      actual: actualValue,
      pro_forma_actual: proFormaActualValue,
      formula: proFormaActualFormula,
    });
  }
}
checks.push(
  record(
    "pro-forma-actual-tie",
    proFormaActualVisited > 0 && proFormaActualErrors.length === 0,
    proFormaActualVisited > 0
      ? "The pro-forma actual column reproduces the latest standalone actual for every statement row."
      : "The pro-forma actual tie inspected ZERO rows — the check cannot pass on an empty visit.",
    { visited: proFormaActualVisited, errors: proFormaActualErrors.slice(0, 50) },
  ),
);

const interestRows = rowPlan.interest_summary_rows;
const waterfallRows = rowPlan.waterfall_rows;
const debtRows = rowPlan.debt_summary_rows;
const statementEndingCashRow = allStatementRows.find(
  (item) => item.semantic_role === "ending_cash",
).row;
const balancingCashRow =
  (rowPlan.cash_buckets ?? []).find(
    (bucket) => bucket.forecast_treatment === "balancing",
  )?.balance_row ?? statementEndingCashRow;
const keyTieErrors = [];
let keyTieVisited = 0;
for (const [index, column] of FORECAST_COLUMNS.entries()) {
  const proFormaColumn = PRO_FORMA_COLUMNS[index];
  for (const blockColumn of [column, proFormaColumn]) {
    const solutionPeriod =
      blockColumn === column
        ? solution.standalone.forecast[index]
        : solution.pro_forma.forecast[index];
    const mainInterestRow = allStatementRows.find(
      (item) => item.semantic_role === "interest_expense",
    ).row;
    const pairs = [
      [
        `${blockColumn}${mainInterestRow}`,
        `${blockColumn}${interestRows.gross_interest_expense}`,
      ],
    ];
    for (const [left, right] of pairs) {
      keyTieVisited += 1;
      if (
        !approximatelyEqual(
          value(operatingModel, left),
          value(operatingModel, right),
          toleranceFor(
            "cross-row-equality",
            "currency",
            Math.abs(numeric(value(operatingModel, left))),
          ),
        )
      ) {
        keyTieErrors.push({ left, right });
      }
    }
    // The sweep governs the single balancing cash bucket.  Reported CFS cash
    // can also include restricted or held-for-sale buckets and therefore must
    // not be forced to equal the sweep.
    const sweptCash =
      numeric(value(operatingModel, `${blockColumn}${waterfallRows.cash_before_rcf}`)) +
      numeric(
        value(operatingModel, `${blockColumn}${waterfallRows.rcf_draw_waterfall}`),
      ) -
      numeric(
        value(
          operatingModel,
          `${blockColumn}${waterfallRows.rcf_repayment_waterfall}`,
        ),
      );
    if (
      !approximatelyEqual(
        numeric(value(operatingModel, `${blockColumn}${balancingCashRow}`)),
        sweptCash,
        toleranceFor("cross-row-equality", "currency", Math.abs(sweptCash)),
      )
    ) {
      keyTieErrors.push({
        left: `${blockColumn}${balancingCashRow}`,
        right: "cash_before_rcf + rcf_draw - rcf_repayment",
        swept: sweptCash,
      });
    }
    const opening = numeric(
      value(operatingModel, `${blockColumn}${waterfallRows.opening_rcf}`),
    );
    const draw = numeric(
      value(operatingModel, `${blockColumn}${waterfallRows.rcf_draw_waterfall}`),
    );
    const repayment = numeric(
      value(
        operatingModel,
        `${blockColumn}${waterfallRows.rcf_repayment_waterfall}`,
      ),
    );
    const ending = numeric(
      value(operatingModel, `${blockColumn}${waterfallRows.ending_rcf}`),
    );
    keyTieVisited += 2;
    const hasNativeRcfAudit = [
      solutionPeriod.rcf_opening_fx,
      solutionPeriod.rcf_average_fx,
      solutionPeriod.rcf_ending_fx,
    ].every((item) => Number.isFinite(Number(item)) && Number(item) > 0);
    const expectedEnding = hasNativeRcfAudit
      ? (opening / numeric(solutionPeriod.rcf_opening_fx) +
          draw / numeric(solutionPeriod.rcf_average_fx) -
          repayment / numeric(solutionPeriod.rcf_average_fx)) *
        numeric(solutionPeriod.rcf_ending_fx)
      : opening + draw - repayment;
    if (
      !approximatelyEqual(
        ending,
        expectedEnding,
        toleranceFor("cross-row-equality", "currency", Math.abs(ending)),
      )
    ) {
      keyTieErrors.push({
        address: `${blockColumn}${waterfallRows.ending_rcf}`,
        opening,
        draw,
        repayment,
        ending,
        expected_ending: expectedEnding,
        rcf_currency: solutionPeriod.rcf_currency ?? null,
      });
    }
  }
}
checks.push(
  record(
    "interest-cash-rcf-ties",
    keyTieVisited > 0 && keyTieErrors.length === 0,
    keyTieVisited > 0
      ? "Interest, ending cash and RCF roll-forward ties hold in standalone and pro forma."
      : "The interest/cash/RCF ties inspected ZERO pairs — the check cannot pass on an empty visit.",
    { visited: keyTieVisited, errors: keyTieErrors },
  ),
);

const isForecastLiveStatementNode = (node) =>
  node.row_type !== "uncalculated" &&
  node.formula_authority !== "intentionally_blank";

const cashComponentNodes = semanticManifest.nodes.filter(
  (node) =>
    node.node_kind === "statement_row" &&
    isForecastLiveStatementNode(node) &&
    ["pre_debt", "non_rcf_debt"].includes(
      node.waterfall_stage,
    ) &&
    !["none", "balance", null, undefined].includes(node.cash_effect),
);
const cashComponentParityErrors = [];
// DEFECT 0.12. This check is three nested loops that only ever PUSH errors, so
// an empty `cashComponentNodes`, `waterfallRows` or `statementRcfNodes` — from
// a renamed movement_type, a manifest schema drift, or a plan that emitted no
// waterfall — produced an empty error array and a green pass over a workbook
// no cell of which was read. Each of the three loops now counts what it
// actually inspected, and the check requires all three to be non-zero.
let cashComponentVisited = 0;
let waterfallRowsVisited = 0;
let statementRcfVisited = 0;
let consolidatedConstituentVisited = 0;
let consolidationTieVisited = 0;
const cashFinancingSubtotalRow = allStatementRows.find(
  (row) => row.semantic_role === "cash_from_financing",
)?.row;
const cashOperatingSubtotalRow = allStatementRows.find(
  (row) => row.semantic_role === "cash_from_operations",
)?.row;
const cashInvestingSubtotalRow = allStatementRows.find(
  (row) => row.semantic_role === "cash_from_investing",
)?.row;
const statementRcfNodes = semanticManifest.nodes.filter(
  (node) =>
    node.node_kind === "statement_row" &&
    isForecastLiveStatementNode(node) &&
    ["rcf_draw", "rcf_repayment"].includes(node.movement_type),
);
const DEBT_BRIDGE_MOVEMENTS = new Set([
  "scheduled_amortisation",
  "maturity_repayment",
  "debt_issuance_cost",
  "other_cash_debt_movement",
  "acquisition_debt_proceeds",
  "acquisition_debt_repayment",
]);
const DEBT_PROCEEDS_MOVEMENTS = new Set(["debt_issuance"]);

// DEFECT 0.14 — A CONSOLIDATED CONSTITUENT CANNOT ENTER ENDING CASH AT ALL,
// AND ASKING IT TO IS NOT A TEST OF THE ECONOMICS.
//
// Until the `xmlCellFormula` regex was given a self-closing branch this check
// was GREEN FOR THE WRONG REASON. Asked for `J61` it matched the self-closing
// `<c r="J61" …/>` OPEN tag, ran on to the NEXT cell's `</c>`, and returned
// that neighbour's formula — a phantom that happened to contain the address
// being looked for, so the reference path it "found" was scraped off a row the
// check was not examining. With the regex fixed the phantom is gone and the
// check began reporting a real design mismatch instead of a manufactured pass.
//
// The mismatch: `row_plan.mjs` consolidates every Change-in-Debt constituent —
// additions, repayments, issuance costs, commercial paper, other movements and
// both revolver legs — onto one line, and marks each constituent
// `forecast_treatment: "uncalculated"`. They are DELIBERATELY blank in the
// forecast. The movement reaches ending cash through the debt schedule, via the
// waterfall's own `pre_rcf_debt_cash_flow` and RCF sweep rows, and the
// consolidated face line links down to the same schedule. So the constituents
// enter the ending-cash path ZERO times by design, and demanding they enter it
// once is demanding something the design guarantees will never happen.
//
// Deleting or softening the assertion is not the answer — that is how a check
// stops looking. What replaces it is STRICTLY STRONGER, and it is stronger in
// the way that matters: it stops counting references and starts reconciling
// numbers. For every consolidated constituent the check now requires ALL of:
//
//   1. the cell really IS blank — a row declared `uncalculated` that still
//      carries a formula or a cached value is a defect the old assertion could
//      not see;
//   2. it is referenced by NO waterfall row (the old form checked one bridge
//      row; this checks all of them);
//   3. it has exactly ONE declared parent, and that parent consolidates the
//      WHOLE run — a half-consolidated subtotal is a defect;
//   4. in the subtotal above, the parent appears EXACTLY ONCE and the
//      constituent appears ZERO times — this is the consolidation itself, and
//      it is asserted rather than assumed;
//   5. the parent's own value RECONCILES NUMERICALLY to the waterfall rows
//      that stand in for its constituents:
//        change in debt == pre-RCF debt movement + RCF draw − RCF repayment;
//   6. and each of those stand-in rows is a LIVE link — it carries a formula
//      that makes at least one same-sheet reference — because (5) compares two
//      numbers and cannot see a hardcode that happens to equal the right one.
//
// (5) is the assertion the reference count was a proxy for, and it is a proxy
// no longer: a reference can be present and the number still be wrong, but this
// cannot pass on a workbook whose consolidated debt movement disagrees with
// what the sweep actually pushes into ending cash. (6) exists because the
// deliberate-breakage run found the one thing (5) alone missed — see the note
// at the loop itself. Every LIVE cash component is still held to the original
// "enters ending cash exactly once".
const statementRowById = new Map(
  allStatementRows.map((definition) => [definition.row_id, definition]),
);
const statementParents = new Map();
for (const definition of allStatementRows) {
  for (const reference of definition.calculation?.refs ?? []) {
    if (!statementParents.has(reference)) statementParents.set(reference, []);
    statementParents.get(reference).push(definition);
  }
}
const manifestRowNodeById = new Map(
  semanticManifest.nodes
    .filter((node) => node.node_kind === "statement_row")
    .map((node) => [node.row_id, node]),
);
// The compiled row plan is the authority on which rows were consolidated: the
// same field the emitter reads to leave the cell blank. Requirement (1) then
// holds the declaration to the workbook, so a row that claims to be
// consolidated but is not, or is blank without claiming it, is a violation
// either way round.
const isConsolidatedConstituent = (rowId) =>
  statementRowById.get(rowId)?.forecast_treatment === "uncalculated" &&
  (statementParents.get(rowId) ?? []).length > 0;
const consolidationParents = [];
for (const node of [...cashComponentNodes, ...statementRcfNodes]) {
  if (!isConsolidatedConstituent(node.row_id)) continue;
  const parents = statementParents.get(node.row_id) ?? [];
  if (parents.length !== 1) continue;
  if (!consolidationParents.includes(parents[0])) {
    consolidationParents.push(parents[0]);
  }
}
const cellFormulaAt = (address) =>
  formula(operatingModel, address) || xmlCellFormula(worksheetXml, address);

/**
 * The waterfall rows that stand in, in the ending-cash path, for a consolidated
 * line's constituents. One aggregate row covers every non-revolver debt
 * movement, so it is counted once however many constituents map to it; the two
 * revolver legs are separate rows and carry their own sign.
 */
function consolidationStandIn(column, constituentRowIds) {
  const contributions = [];
  const untyped = [];
  const unresolved = [];
  let usedPreRcfBridge = false;
  let usedDebtProceedsBridge = false;
  const push = (rowId, waterfallId, sign) => {
    const waterfallRow = waterfallRows[waterfallId];
    if (!Number.isFinite(Number(waterfallRow))) {
      unresolved.push({ row_id: rowId, waterfall_id: waterfallId });
      return;
    }
    contributions.push({
      row_id: rowId,
      waterfall_id: waterfallId,
      address: `${column}${waterfallRow}`,
      sign,
    });
  };
  for (const rowId of constituentRowIds) {
    const node = manifestRowNodeById.get(rowId);
    if (node && !isForecastLiveStatementNode(node)) continue;
    const movementType = node?.movement_type ?? null;
    if (movementType === "rcf_draw") push(rowId, "rcf_draw_waterfall", 1);
    else if (movementType === "rcf_repayment") {
      push(rowId, "rcf_repayment_waterfall", -1);
    } else if (movementType === "lease_principal") {
      push(rowId, "lease_principal_waterfall", 1);
    } else if (DEBT_PROCEEDS_MOVEMENTS.has(movementType)) {
      if (!usedDebtProceedsBridge) {
        usedDebtProceedsBridge = true;
        const proceedsRow = waterfallRows.non_rcf_debt_proceeds;
        const sourceRow = node?.physical_row;
        const sourceValue = Number.isFinite(Number(sourceRow))
          ? numeric(value(operatingModel, `${column}${sourceRow}`))
          : 0;
        if (Number.isFinite(Number(proceedsRow))) {
          push(rowId, "non_rcf_debt_proceeds", 1);
        } else if (Math.abs(sourceValue) > 1e-9) {
          unresolved.push({
            row_id: rowId,
            waterfall_id: "non_rcf_debt_proceeds",
            nonzero_source_value: sourceValue,
          });
        }
      }
    } else if (DEBT_BRIDGE_MOVEMENTS.has(movementType)) {
      if (!usedPreRcfBridge) {
        usedPreRcfBridge = true;
        push(rowId, "pre_rcf_debt_cash_flow", 1);
      }
    } else {
      untyped.push({ row_id: rowId, movement_type: movementType });
    }
  }
  const total = contributions.reduce(
    (sum, item) => sum + item.sign * numeric(value(operatingModel, item.address)),
    0,
  );
  return { contributions, untyped, unresolved, total };
}

/**
 * Requirements (1)–(4) for one consolidated constituent in one column.
 * `waterfallReferences` is every same-sheet reference made by every waterfall
 * row in this column, so (2) covers the whole sweep rather than one bridge.
 */
function auditConsolidatedConstituent(column, node, waterfallReferences) {
  const errors = [];
  const address = `${column}${node.physical_row}`;
  const emitted = cellFormulaAt(address);
  const cached = value(operatingModel, address);
  if (emitted || (cached !== null && cached !== "")) {
    errors.push({
      column,
      id: "consolidated_constituent_is_not_blank",
      semantic_id: node.semantic_id,
      movement_type: node.movement_type,
      address,
      emitted_formula: emitted || null,
      cached_value: cached,
    });
  }
  const waterfallHits = waterfallReferences.filter(
    (reference) => reference === address,
  ).length;
  if (waterfallHits !== 0) {
    errors.push({
      column,
      id: "consolidated_constituent_still_referenced_by_waterfall",
      semantic_id: node.semantic_id,
      address,
      reference_paths_from_ending_cash: waterfallHits,
    });
  }
  const parents = statementParents.get(node.row_id) ?? [];
  if (parents.length !== 1) {
    errors.push({
      column,
      id: "consolidated_constituent_without_unique_parent",
      semantic_id: node.semantic_id,
      address,
      parents: parents.map((parent) => parent.row_id),
    });
    return errors;
  }
  const parent = parents[0];
  const liveSiblings = (parent.calculation?.refs ?? []).filter(
    (reference) => !isConsolidatedConstituent(reference),
  );
  if (liveSiblings.length > 0) {
    errors.push({
      column,
      id: "consolidation_parent_is_only_partly_consolidated",
      semantic_id: node.semantic_id,
      parent_row_id: parent.row_id,
      live_constituents: liveSiblings,
    });
  }
  const subtotals = statementParents.get(parent.row_id) ?? [];
  if (subtotals.length !== 1) {
    errors.push({
      column,
      id: "consolidation_parent_without_unique_subtotal",
      semantic_id: node.semantic_id,
      parent_row_id: parent.row_id,
      subtotals: subtotals.map((subtotal) => subtotal.row_id),
    });
    return errors;
  }
  const subtotal = subtotals[0];
  const subtotalAddress = `${column}${subtotal.row}`;
  const subtotalReferences = sameSheetReferences(
    cellFormulaAt(subtotalAddress),
  );
  const parentAddress = `${column}${parent.row}`;
  const parentCount = subtotalReferences.filter(
    (reference) => reference === parentAddress,
  ).length;
  const constituentCount = subtotalReferences.filter(
    (reference) => reference === address,
  ).length;
  if (parentCount !== 1) {
    errors.push({
      column,
      id: "consolidation_parent_not_summed_once",
      parent_row_id: parent.row_id,
      subtotal_row_id: subtotal.row_id,
      subtotal_address: subtotalAddress,
      parent_address: parentAddress,
      occurrences: parentCount,
    });
  }
  if (constituentCount !== 0) {
    errors.push({
      column,
      id: "consolidated_constituent_still_summed_by_subtotal",
      semantic_id: node.semantic_id,
      subtotal_row_id: subtotal.row_id,
      subtotal_address: subtotalAddress,
      address,
      occurrences: constituentCount,
    });
  }
  return errors;
}

for (const column of [...FORECAST_COLUMNS, ...PRO_FORMA_COLUMNS]) {
  const waterfallReferencesById = new Map(
    Object.entries(waterfallRows).map(([waterfallId, waterfallRow]) => [
      waterfallId,
      sameSheetReferences(cellFormulaAt(`${column}${waterfallRow}`)),
    ]),
  );
  const allWaterfallReferences = [...waterfallReferencesById.values()].flat();
  for (const node of cashComponentNodes) {
    cashComponentVisited += 1;
    const targetAddress = `${column}${node.physical_row}`;
    if (isConsolidatedConstituent(node.row_id)) {
      consolidatedConstituentVisited += 1;
      cashComponentParityErrors.push(
        ...auditConsolidatedConstituent(column, node, allWaterfallReferences),
      );
      continue;
    }
    const debtComponent = DEBT_BRIDGE_MOVEMENTS.has(node.movement_type);
    const debtProceedsComponent = DEBT_PROCEEDS_MOVEMENTS.has(
      node.movement_type,
    );
    if (
      debtProceedsComponent &&
      !Number.isFinite(Number(waterfallRows.non_rcf_debt_proceeds))
    ) {
      const sourceValue = numeric(value(operatingModel, targetAddress));
      if (Math.abs(sourceValue) > 1e-9) {
        cashComponentParityErrors.push({
          column,
          id: "nonzero_debt_proceeds_missing_visible_waterfall_row",
          row_id: node.row_id,
          address: targetAddress,
          actual: sourceValue,
        });
      }
      continue;
    }
    const bridgeAddress =
      node.movement_type === "lease_principal"
        ? `${column}${waterfallRows.lease_principal_waterfall}`
        : debtProceedsComponent
          // The statement issuance child links to the schedule-owned proceeds
          // row; cash_before_rcf is the row that actually consumes that child.
          // Counting the schedule owner therefore asks the wrong edge whether
          // issuance reaches ending cash.
          ? `${column}${waterfallRows.cash_before_rcf}`
          : debtComponent
          ? `${column}${waterfallRows.pre_rcf_debt_cash_flow}`
          : `${column}${waterfallRows.cash_before_debt}`;
    let pathCount;
    if (
      node.cash_flow_classification === "investing" &&
      cashInvestingSubtotalRow
    ) {
      pathCount = referencePathCount(
        operatingModel,
        worksheetXml,
        `${column}${cashInvestingSubtotalRow}`,
        targetAddress,
      );
    } else if (
      node.cash_flow_classification === "operating" &&
      cashOperatingSubtotalRow
    ) {
      // Stop at the filed operating-cash subtotal. Walking through the sweep
      // enters the declared cash/interest cycle and can find the same row again
      // through interest income; that is not a second CFS contribution.
      pathCount = referencePathCount(
        operatingModel,
        worksheetXml,
        `${column}${cashOperatingSubtotalRow}`,
        targetAddress,
      );
    } else {
      const bridgeReferences = sameSheetReferences(
        cellFormulaAt(bridgeAddress),
      );
      pathCount = bridgeReferences.filter(
        (reference) => reference === targetAddress,
      ).length;
    }
    if (pathCount !== 1) {
      cashComponentParityErrors.push({
        column,
        semantic_id: node.semantic_id,
        movement_type: node.movement_type,
        target_address: targetAddress,
        reference_paths_from_ending_cash: pathCount,
      });
    }
  }
  for (const [waterfallId, waterfallRow] of Object.entries(waterfallRows)) {
    waterfallRowsVisited += 1;
    const address = `${column}${waterfallRow}`;
    const references = waterfallReferencesById.get(waterfallId) ?? [];
    if (
      cashFinancingSubtotalRow &&
      references.includes(`${column}${cashFinancingSubtotalRow}`)
    ) {
      cashComponentParityErrors.push({
        column,
        waterfall_id: waterfallId,
        id: "financing_subtotal_used_in_waterfall",
        address,
      });
    }
    for (const rcfNode of statementRcfNodes) {
      if (references.includes(`${column}${rcfNode.physical_row}`)) {
        cashComponentParityErrors.push({
          column,
          waterfall_id: waterfallId,
          id: "statement_rcf_used_to_calculate_waterfall",
          address,
          statement_rcf_row: rcfNode.physical_row,
        });
      }
    }
  }
  for (const rcfNode of statementRcfNodes) {
    statementRcfVisited += 1;
    if (isConsolidatedConstituent(rcfNode.row_id)) {
      consolidatedConstituentVisited += 1;
      cashComponentParityErrors.push(
        ...auditConsolidatedConstituent(column, rcfNode, allWaterfallReferences),
      );
      continue;
    }
    const expectedMechanicalRow =
      rcfNode.movement_type === "rcf_draw"
        ? waterfallRows.rcf_draw_waterfall
        : waterfallRows.rcf_repayment_waterfall;
    const address = `${column}${rcfNode.physical_row}`;
    const references = sameSheetReferences(cellFormulaAt(address));
    if (
      references.filter(
        (reference) => reference === `${column}${expectedMechanicalRow}`,
      ).length !== 1
    ) {
      cashComponentParityErrors.push({
        column,
        id: "cfs_rcf_not_linked_once_to_waterfall",
        movement_type: rcfNode.movement_type,
        address,
        expected_reference: `${column}${expectedMechanicalRow}`,
      });
    }
  }
  // Requirement (5): the consolidated line must reconcile, as a NUMBER, to the
  // waterfall rows that carry its constituents into ending cash.
  for (const parent of consolidationParents) {
    consolidationTieVisited += 1;
    const parentAddress = `${column}${parent.row}`;
    if (!cellFormulaAt(parentAddress)) {
      cashComponentParityErrors.push({
        column,
        id: "consolidation_parent_carries_no_formula",
        parent_row_id: parent.row_id,
        address: parentAddress,
      });
    }
    const standIn = consolidationStandIn(
      column,
      parent.calculation?.refs ?? [],
    );
    if (standIn.untyped.length > 0) {
      cashComponentParityErrors.push({
        column,
        id: "consolidated_constituent_has_no_waterfall_stand_in",
        parent_row_id: parent.row_id,
        constituents: standIn.untyped,
      });
    }
    if (standIn.unresolved.length > 0) {
      cashComponentParityErrors.push({
        column,
        id: "waterfall_stand_in_row_missing",
        parent_row_id: parent.row_id,
        constituents: standIn.unresolved,
      });
      continue;
    }
    if (standIn.contributions.length === 0) continue;
    // A NUMERIC TIE CANNOT SEE A HARDCODE THAT HAPPENS TO BE RIGHT.
    //
    // Requirement (5) compares two numbers, so on a case whose debt movement is
    // exactly zero — standard-net-cash is one — replacing the sweep's debt
    // bridge with a literal `0` changes nothing the comparison can read, and
    // the tie holds over a waterfall that has stopped reading the debt schedule
    // altogether. That is a real defect (a hardcode where a link belongs) and it
    // was MISSED, once, in the deliberate-breakage run that found it.
    //
    // So the stand-in rows are also required to be LIVE: each must carry a
    // formula, and that formula must make at least one same-sheet reference. A
    // constant has none. This is structural rather than numeric and so does not
    // care what the number happens to be.
    for (const contribution of standIn.contributions) {
      // Gross issuance cannot offset itself.  A zero proceeds bridge means
      // there is no active issuance contributor in this period, so the
      // builder's explicit `=0` is valid; non-zero proceeds must remain linked.
      if (
        contribution.waterfall_id === "non_rcf_debt_proceeds" &&
        Math.abs(numeric(value(operatingModel, contribution.address))) <= 1e-9
      ) {
        continue;
      }
      const standInFormula = cellFormulaAt(contribution.address);
      const standInReferences = sameSheetReferences(standInFormula);
      if (standInReferences.length === 0) {
        cashComponentParityErrors.push({
          column,
          id: "waterfall_stand_in_is_not_a_live_link",
          parent_row_id: parent.row_id,
          waterfall_id: contribution.waterfall_id,
          address: contribution.address,
          emitted_formula: standInFormula || null,
        });
      }
    }
    const actual = numeric(value(operatingModel, parentAddress));
    const band = toleranceFor(
      "cfs-waterfall-component-parity",
      "currency",
      Math.max(Math.abs(actual), Math.abs(standIn.total)),
    );
    if (!approximatelyEqual(actual, standIn.total, band)) {
      cashComponentParityErrors.push({
        column,
        id: "consolidation_does_not_reconcile_to_waterfall",
        parent_row_id: parent.row_id,
        address: parentAddress,
        actual,
        expected: standIn.total,
        tolerance: band,
        stand_in: standIn.contributions.map((item) => ({
          row_id: item.row_id,
          waterfall_id: item.waterfall_id,
          address: item.address,
          sign: item.sign,
          value: numeric(value(operatingModel, item.address)),
        })),
      });
    }
  }
}
// A consolidation the check found constituents for but never reconciled is a
// scan that stopped looking. See DEFECT 0.12.
const cashComponentParityVisited =
  cashComponentVisited > 0 &&
  waterfallRowsVisited > 0 &&
  statementRcfVisited > 0 &&
  (consolidatedConstituentVisited === 0 || consolidationTieVisited > 0);
checks.push(
  record(
    "cfs-waterfall-component-parity",
    cashComponentParityVisited && cashComponentParityErrors.length === 0,
    cashComponentParityVisited
      ? "Every live CFS cash component enters ending cash exactly once, and every consolidated constituent is blank, unreferenced by the sweep, summed once through its parent, and reconciles as a number to the waterfall rows that carry it."
      : "One of the CFS parity scans inspected ZERO rows — the check cannot pass on an empty visit.",
    {
      visited: {
        cash_components: cashComponentVisited,
        waterfall_rows: waterfallRowsVisited,
        statement_rcf_rows: statementRcfVisited,
        consolidated_constituents: consolidatedConstituentVisited,
        consolidation_ties: consolidationTieVisited,
      },
      errors: cashComponentParityErrors.slice(0, 100),
    },
  ),
);

const liquidityMechanicErrors = [];
const permittedCapacityShortfalls = [];
let liquidityVisited = 0;
// The sweep's shortfall row is gone; derive shortfall from minimum cash and
// the balancing cash bucket, never from wider reported cash.
for (const [index, forecastColumn] of FORECAST_COLUMNS.entries()) {
  for (const column of [forecastColumn, PRO_FORMA_COLUMNS[index]]) {
  const solutionPeriod =
    column === forecastColumn
      ? solution.standalone.forecast[index]
      : solution.pro_forma.forecast[index];
  const draw = numeric(
    value(operatingModel, `${column}${waterfallRows.rcf_draw_waterfall}`),
  );
  const repayment = numeric(
    value(operatingModel, `${column}${waterfallRows.rcf_repayment_waterfall}`),
  );
  const shortfall = Math.max(
    0,
    numeric(value(operatingModel, `${column}${waterfallRows.minimum_cash}`)) -
      numeric(value(operatingModel, `${column}${balancingCashRow}`)),
  );
  liquidityVisited += 1;
  // These are MATERIALITY thresholds, not equality bands: "is there money
  // here at all". The currency floor — one currency unit in the issuer's own
  // units — is the right reading of that, and it is what the contract states.
  const drawBand = toleranceFor("liquidity-certification", "currency", 0);
  if (draw > drawBand && repayment > drawBand) {
    liquidityMechanicErrors.push({
      column,
      id: "draw_repay_mutual_exclusivity",
      draw,
      repayment,
      tolerance: drawBand,
    });
  }
  if (shortfall > drawBand) {
    const capacityNative = Number(solutionPeriod.rcf_capacity_native);
    const endingNative = Number(solutionPeriod.rcf_ending_native);
    const capacityBand = toleranceFor(
      "liquidity-certification",
      "currency",
      Math.max(Math.abs(capacityNative), Math.abs(endingNative)),
    );
    if (
      !Number.isFinite(capacityNative) ||
      !Number.isFinite(endingNative) ||
      Math.abs(endingNative - capacityNative) > capacityBand
    ) {
      liquidityMechanicErrors.push({
        column,
        id: "liquidity_shortfall_with_spare_capacity",
        shortfall,
        ending_rcf_native: Number.isFinite(endingNative) ? endingNative : null,
        rcf_capacity_native: Number.isFinite(capacityNative)
          ? capacityNative
          : null,
        tolerance: capacityBand,
      });
    } else {
      permittedCapacityShortfalls.push({
        column,
        shortfall,
        ending_rcf_native: endingNative,
        rcf_capacity_native: capacityNative,
      });
    }
  }
  }
}
checks.push(
  record(
    "liquidity-certification",
    liquidityVisited > 0 && liquidityMechanicErrors.length === 0,
    liquidityVisited > 0
      ? "RCF draw and repayment are mutually exclusive; minimum cash is met whenever capacity permits, and residual shortfall is retained only when RCF capacity is exhausted."
      : "Liquidity certification inspected ZERO periods — the check cannot pass on an empty visit.",
    {
      visited: liquidityVisited,
      permitted_capacity_shortfalls: permittedCapacityShortfalls,
      errors: liquidityMechanicErrors,
    },
  ),
);

// REWRITTEN (2026-07-26, second pass). The previous revision narrowed this
// check to "only the genuinely circular lines" — RCF drawn interest, the
// commitment fee and interest income — and actively asserted that instrument,
// lease and other interest must NOT be gated. That reasoning is locally true
// and misses the point of the control. The loop is
//   total interest -> net income -> cash -> interest income -> total interest
// so gating one leg leaves the model computing interest while reporting that
// circularity is off. The contract (SKILL.md, references/model-intent.md) is a
// KILL SWITCH: "0 returns zero from every forecast interest-expense and
// interest-income component; 1 restores the complete interest and cash/RCF
// solution; formula text remains intact in both states."
//
// The check asserts BOTH directions on a single workbook:
//   1. every forecast interest component is downstream of the gate, in the
//      standalone, adjustment and pro-forma column blocks;
//   2. the gated formulas still carry their full arithmetic, so a toggle is a
//      valuation state and never a structural edit;
//   3. the caches agree with the control's own state — everything zero when
//      the switch is off, and a live solution when it is on, so a gate wired
//      permanently shut cannot pass.
const gateErrors = [];
// DEFECT 0.12. Every loop below only ever PUSHES an error, so an empty
// `componentRows` (no instrument carries an interest row, `interestRows` keys
// renamed) or an empty `rowPlan.instruments` yields no errors and a green
// pass over a circularity breaker nobody looked at. Both scans are counted.
let gateCellsVisited = 0;
let gateInstrumentsVisited = 0;
const gateToken = `$C$${rowPlan.controls.circularity}=0`;
const rollToken = `$C$${rowPlan.controls.debt_maturities_roll}=1`;
const cellFormula = (address) =>
  formula(operatingModel, address) || xmlCellFormula(worksheetXml, address);
const circularityOn =
  numeric(value(operatingModel, `C${rowPlan.controls.circularity}`)) === 1;

// A term that is structurally zero whatever the controls say — a literal zero,
// or a control test whose branches are both zero, as an adjustment column uses
// where a line has no acquisition effect. It carries no interest, so it cannot
// leak any past the gate.
function isStructuralZero(address) {
  const text = cellFormula(address);
  if (!text) return numeric(value(operatingModel, address)) === 0;
  const masked = text
    .replace(/^=/, "")
    .replace(/\s+/g, "")
    .replace(/\$?[A-Z]{1,3}\$?\d+/g, "R");
  return /^0$/.test(masked) || /^(IF\(R=0,0,)+0\)+$/.test(masked);
}
// A cell is gated if it carries the wrapper itself, or is a pure link to — or
// sum/difference of — cells that do, ignoring terms that are structurally
// zero. That second case is how a pro-forma line stated as standalone plus
// adjustment, and an RCF instrument row that reads the RCF cost line, inherit
// the switch. Anything with real arithmetic of its own must carry it directly.
const gatedCache = new Map();
function isGated(address, depth = 0) {
  if (gatedCache.has(address)) return gatedCache.get(address);
  if (depth > 4) return false;
  const text = cellFormula(address);
  if (!text) return false;
  let result = text.includes(gateToken);
  if (!result) {
    const body = text.replace(/^=/, "").replace(/\s+/g, "");
    if (/^\$?[A-Z]{1,3}\$?\d+([+-]\$?[A-Z]{1,3}\$?\d+)*$/.test(body)) {
      const references = (body.match(/\$?[A-Z]{1,3}\$?\d+/g) ?? []).map(
        (reference) => reference.replace(/\$/g, ""),
      );
      const gatedReferences = references.filter((reference) =>
        isGated(reference, depth + 1),
      );
      result =
        gatedReferences.length > 0 &&
        references.every(
          (reference) =>
            gatedReferences.includes(reference) ||
            isStructuralZero(reference),
        );
    }
  }
  gatedCache.set(address, result);
  return result;
}

// The forecast interest COMPONENTS — the leaves the contract enumerates.
// Subtotals (rcf_total_fees, gross/net interest, cash interest paid) foot
// these, so they are covered by the cache assertion below rather than by
// demanding a redundant second wrapper on an aggregate.
const componentRows = [
  // An instrument with no interest row of its own carries no interest line to
  // gate — the RCF is stated once, on rcf_interest — so there is nothing here
  // to assert for it.
  ...rowPlan.instruments
    .filter((plan) => Number.isInteger(plan.interest_row))
    .map((plan) => ({
      id: `instrument_interest.${plan.instrument_id}`,
      row: plan.interest_row,
    })),
  ...rowPlan.instruments
    .filter((plan) => Number.isInteger(plan.pik_interest_row))
    .map((plan) => ({
      id: `instrument_pik_interest.${plan.instrument_id}`,
      row: plan.pik_interest_row,
    })),
  ...(rowPlan.cash_buckets ?? [])
    .filter((plan) => Number.isInteger(plan.interest_row))
    .map((plan) => ({
      id: `cash_bucket_interest.${plan.bucket_id}`,
      row: plan.interest_row,
    })),
  ...[
    ...(rcfContractMode === "none"
      ? []
      : ["rcf_interest", "rcf_commitment_fee"]),
    "lease_interest",
    "other_unallocated_interest",
    "non_cash_interest",
    "interest_income_schedule",
  ].map((id) => ({ id, row: interestRows[id] })),
];
const pikPrincipalRows = rowPlan.instruments
  .filter((plan) => Number.isInteger(plan.pik_row))
  .map((plan) => ({
    id: `instrument_pik_accretion.${plan.instrument_id}`,
    row: plan.pik_row,
  }));
for (const { id, row } of componentRows) {
  for (const column of [...FORECAST_COLUMNS, ...PRO_FORMA_COLUMNS]) {
    const address = `${column}${row}`;
    gateCellsVisited += 1;
    if (!isGated(address)) {
      gateErrors.push({
        address,
        issue: `${id}_missing_circularity_gate`,
        formula: cellFormula(address),
      });
    }
  }
}
// PIK is simultaneously non-cash interest and a principal movement. The debt-
// schedule accretion row must therefore carry the same breaker as its interest-
// schedule presentation; otherwise circularity off can report zero interest
// while principal continues to grow.
for (const { id, row } of pikPrincipalRows) {
  for (const column of [...FORECAST_COLUMNS, ...PRO_FORMA_COLUMNS]) {
    const address = `${column}${row}`;
    gateCellsVisited += 1;
    if (!isGated(address)) {
      gateErrors.push({
        address,
        issue: `${id}_missing_circularity_gate`,
        formula: cellFormula(address),
      });
    }
  }
  for (const column of ADJUSTMENT_COLUMNS) {
    const address = `${column}${row}`;
    if (!isGated(address) && !isStructuralZero(address)) {
      gateErrors.push({
        address,
        issue: `${id}_adjustment_missing_circularity_gate`,
        formula: cellFormula(address),
      });
    }
  }
}
// Acquisition interest is carried on the pro-forma columns only; the
// standalone company has no acquisition debt, so J:L is a literal zero.
for (const column of PRO_FORMA_COLUMNS) {
  const address = `${column}${interestRows.acquisition_interest}`;
  if (!isGated(address)) {
    gateErrors.push({
      address,
      issue: "acquisition_interest_missing_circularity_gate",
      formula: cellFormula(address),
    });
  }
}
// The adjustment block is held to the same rule, with one allowance: a line
// with no acquisition effect states an outright zero there, and a zero cannot
// leak interest past a breaker.
for (const { id, row } of [
  ...componentRows,
  { id: "acquisition_interest", row: interestRows.acquisition_interest },
]) {
  for (const column of ADJUSTMENT_COLUMNS) {
    const address = `${column}${row}`;
    if (!isGated(address) && !isStructuralZero(address)) {
      gateErrors.push({
        address,
        issue: `${id}_adjustment_missing_circularity_gate`,
        formula: cellFormula(address),
      });
    }
  }
}

// FORMULA TEXT INTACT. The gate must wrap a live calculation, never replace
// one: strip the wrapper and what is left has to reference other cells. This
// is what stops a "toggle" from being implemented as a structural edit.
for (const { id, row } of [
  ...componentRows,
  { id: "acquisition_interest", row: interestRows.acquisition_interest },
]) {
  for (const column of [...FORECAST_COLUMNS, ...PRO_FORMA_COLUMNS]) {
    const address = `${column}${row}`;
    const text = cellFormula(address);
    if (!text.includes(gateToken)) continue;
    const body = text.slice(text.indexOf(gateToken) + gateToken.length);
    // Everything after the "=0" test: the zero branch, then the calculation.
    const calculation = body.replace(/^,0,/, "");
    const referencesCells = /\$?[A-Z]{1,3}\$?\d+/.test(
      calculation.replace(
        new RegExp(`\\$C\\$${rowPlan.controls.circularity}\\b`, "g"),
        "",
      ),
    );
    const hasCurve = /Forward Curves/i.test(calculation);
    if (!referencesCells && !hasCurve) {
      gateErrors.push({
        address,
        issue: `${id}_gate_wraps_no_calculation`,
        formula: text,
      });
    }
  }
}

// CACHES AGREE WITH THE CONTROL. Off means every forecast interest row on the
// face reads zero — components, subtotals and net interest, across all three
// column blocks. On means the solution is actually live.
const interestFaceRows = [
  ...componentRows.map((entry) => entry.row),
  ...pikPrincipalRows.map((entry) => entry.row),
  interestRows.acquisition_interest,
  interestRows.rcf_total_fees,
  interestRows.gross_interest_expense,
  interestRows.net_interest_expense,
  interestRows.cash_interest_paid,
];
if (!circularityOn) {
  for (const row of interestFaceRows) {
    for (const column of [
      ...FORECAST_COLUMNS,
      ...ADJUSTMENT_COLUMNS,
      ...PRO_FORMA_COLUMNS,
    ]) {
      const address = `${column}${row}`;
      const cached = numeric(value(operatingModel, address));
      if (Math.abs(cached) > 1e-9) {
        gateErrors.push({
          address,
          issue: "forecast_interest_not_zero_with_circularity_off",
          cached,
        });
      }
    }
  }
} else {
  const live = [
    ...FORECAST_COLUMNS.map(
      (column) => `${column}${interestRows.gross_interest_expense}`,
    ),
    ...FORECAST_COLUMNS.map(
      (column) => `${column}${interestRows.interest_income_schedule}`,
    ),
  ].some((address) => Math.abs(numeric(value(operatingModel, address))) > 1e-9);
  if (!live) {
    gateErrors.push({
      address: `J${interestRows.gross_interest_expense}`,
      issue: "circularity_on_but_interest_solution_is_zero",
    });
  }
}

for (const plan of rowPlan.instruments) {
  // The RCF is not a term instrument: its balance is set by the cash sweep and
  // its cost is stated once on rcf_interest, so neither the debt-schedule read
  // nor the maturity roll applies to it. Recognise it by name, by the absence
  // of an interest row of its own, or by an interest formula that links to the
  // RCF cost line.
  if (!Number.isInteger(plan.interest_row)) continue;
  const interestFormula = cellFormula(`J${plan.interest_row}`);
  const isRcf =
    /rcf|revolv/i.test(plan.instrument_id) ||
    interestFormula.includes(`J${interestRows.rcf_interest}`);
  if (isRcf) continue;
  gateInstrumentsVisited += 1;
  // Interest must read the debt schedule, not a scratch row.
  if (!interestFormula.includes(`${plan.debt_row}`)) {
    gateErrors.push({
      address: `J${plan.interest_row}`,
      issue: "interest_does_not_reference_debt_schedule",
      formula: interestFormula,
    });
  }
  // The maturity roll gates the balance on the FACE of the debt schedule.
  const balanceFormula = cellFormula(`J${plan.debt_row}`);
  const governedByMaturityRoll =
    plan.maturity_treatment !== "non_maturing_within_forecast";
  if (
    governedByMaturityRoll &&
    balanceFormula &&
    !balanceFormula.includes(rollToken)
  ) {
    gateErrors.push({
      address: `J${plan.debt_row}`,
      issue: "debt_balance_not_gated_by_maturity_roll",
      formula: balanceFormula,
    });
  }
  if (
    !governedByMaturityRoll &&
    balanceFormula &&
    balanceFormula.includes(rollToken)
  ) {
    gateErrors.push({
      address: `J${plan.debt_row}`,
      issue: "non_maturing_balance_incorrectly_gated_by_maturity_roll",
      formula: balanceFormula,
    });
  }
}
checks.push(
  record(
    "control-formula-gates",
    gateCellsVisited > 0 &&
      gateInstrumentsVisited > 0 &&
      gateErrors.length === 0,
    gateCellsVisited > 0 && gateInstrumentsVisited > 0
      ? "Circularity is a kill switch: every forecast interest-expense and interest-income component is gated with its arithmetic intact and its caches agree with the control state; maturity roll gates the visible debt balance."
      : "The control-gate scan inspected ZERO interest cells or ZERO term instruments — the check cannot pass on an empty visit.",
    {
      visited: {
        gate_cells: gateCellsVisited,
        term_instruments: gateInstrumentsVisited,
      },
      errors: gateErrors.slice(0, 100),
    },
  ),
);

const visibleAssumptionErrors = [];
// DEFECT 0.12. Push-only again: an empty `interestFormulaRows` reports that
// every interest formula references a visible assumption without having read
// one formula. The count is asserted alongside the absence of errors.
let visibleAssumptionVisited = 0;
const visibleRateAssumptionRows = new Set([
  ...Object.values(rowPlan.benchmark_floor_rows ?? {}),
  ...Object.values(rowPlan.pik_rate_rows ?? {}),
  ...(rowPlan.cash_buckets ?? []).map((plan) => plan.rate_row),
].filter(Number.isInteger));
const interestFormulaRows = [
  ...rowPlan.instruments.map((plan) => ({
    id: `instrument_interest.${plan.instrument_id}`,
    row: plan.interest_row,
  })),
  ...rowPlan.instruments
    .filter((plan) => Number.isInteger(plan.pik_interest_row))
    .map((plan) => ({
      id: `instrument_pik_interest.${plan.instrument_id}`,
      row: plan.pik_interest_row,
    })),
  ...(rowPlan.cash_buckets ?? [])
    .filter((plan) => Number.isInteger(plan.interest_row))
    .map((plan) => ({
      id: `cash_bucket_interest.${plan.bucket_id}`,
      row: plan.interest_row,
    })),
  ...pikPrincipalRows,
  ...[
    ...(rcfContractMode === "none"
      ? []
      : ["rcf_interest", "rcf_commitment_fee"]),
    "lease_interest",
    "other_unallocated_interest",
    "non_cash_interest",
    "interest_income_schedule",
  ].map((id) => ({ id, row: interestRows[id] })),
];
for (const { id, row } of interestFormulaRows) {
  for (const column of [...FORECAST_COLUMNS, ...PRO_FORMA_COLUMNS]) {
    const address = `${column}${row}`;
    visibleAssumptionVisited += 1;
    const formulaText =
      formula(operatingModel, address) ||
      xmlCellFormula(worksheetXml, address);
    const closure = formulaClosure(
      operatingModel,
      worksheetXml,
      address,
    );
    const embedded = embeddedRateLiterals(formulaText).map((match) => ({
      ...match,
      formula_address: address,
    }));
    if (embedded.length > 0) {
      visibleAssumptionErrors.push({
        id,
        address,
        issue: "embedded_numeric_assumption",
        embedded,
        formula: formulaText,
      });
    }
    if (FORECAST_COLUMNS.includes(column)) {
      const visibleReferences = closure.references.filter(
        (reference) => {
          const match = reference.match(/^([A-Z]+)(\d+)$/);
          if (!match) return false;
          const referenceColumn = match[1];
          const referenceRow = Number(match[2]);
          return (
            (["C", "D", "E"].includes(referenceColumn) &&
              referenceRow >= rowPlan.interest_term_header_row) ||
            ([...FORECAST_COLUMNS, ...PRO_FORMA_COLUMNS].includes(
              referenceColumn,
            ) && visibleRateAssumptionRows.has(referenceRow)) ||
            (referenceColumn === "P" &&
              referenceRow < rowPlan.period_group_row)
          );
        },
      );
      const hasForwardCurveReference =
        closure.formulas.some((item) =>
          /(?:'Forward Curves'|Forward_Curves|Forward Curves)!/i.test(
            item.formula,
          ),
        );
      if (
        formulaText &&
        visibleReferences.length === 0 &&
        !hasForwardCurveReference
      ) {
        visibleAssumptionErrors.push({
          id,
          address,
          issue: "no_visible_assumption_reference",
          formula: formulaText,
        });
      }
    }
  }
}
for (const column of PRO_FORMA_COLUMNS) {
  const address = `${column}${interestRows.acquisition_interest}`;
  const formulaText =
    formula(operatingModel, address) ||
    xmlCellFormula(worksheetXml, address);
  const closure = formulaClosure(
    operatingModel,
    worksheetXml,
    address,
  );
  const embedded = embeddedRateLiterals(formulaText).map((match) => ({
    ...match,
    formula_address: address,
  }));
  const visibleReferences = closure.references.filter(
    (reference) => /^P\d+$/.test(reference),
  );
  if (embedded.length > 0 || visibleReferences.length === 0) {
    visibleAssumptionErrors.push({
      id: "acquisition_interest",
      address,
      issue:
        embedded.length > 0
          ? "embedded_numeric_assumption"
          : "no_visible_assumption_reference",
      embedded,
      formula: formulaText,
    });
  }
}
checks.push(
  record(
    "visible-interest-assumption-references",
    visibleAssumptionVisited > 0 && visibleAssumptionErrors.length === 0,
    visibleAssumptionVisited > 0
      ? "Interest formulas reference visible term, control or curve inputs and contain no embedded rate or plug assumptions."
      : "The visible-assumption scan read ZERO interest formulas — the check cannot pass on an empty visit.",
    {
      visited: visibleAssumptionVisited,
      errors: visibleAssumptionErrors.slice(0, 100),
    },
  ),
);

const solverErrors = [];
let solverVisited = 0;
const solutionBlocks = [
  [solution.standalone, FORECAST_COLUMNS],
  [solution.pro_forma, PRO_FORMA_COLUMNS],
];
for (const [block, columns] of solutionBlocks) {
  for (let index = 0; index < 3; index += 1) {
    const result = block.forecast[index];
    const column = columns[index];
    const comparisons = [
      [
        "cash_flow_cash",
        value(operatingModel, `${column}${statementEndingCashRow}`),
        result.cash_flow_cash ?? result.reported_cash ?? result.ending_cash,
      ],
      [
        "ending_cash",
        value(operatingModel, `${column}${balancingCashRow}`),
        result.ending_cash,
      ],
      [
        "ending_rcf",
        value(operatingModel, `${column}${waterfallRows.ending_rcf}`),
        result.ending_rcf,
      ],
      [
        "gross_interest",
        -numeric(
          value(
            operatingModel,
            `${column}${interestRows.gross_interest_expense}`,
          ),
        ),
        result.gross_interest,
      ],
      [
        "interest_income",
        value(
          operatingModel,
          `${column}${interestRows.interest_income_schedule}`,
        ),
        result.interest_income,
      ],
      [
        "net_leverage",
        value(
          operatingModel,
          `${column}${debtRows.net_debt_to_adjusted_ebitda}`,
        ),
        result.net_leverage,
      ],
      [
        "total_liquidity",
        value(operatingModel, `${column}${debtRows.total_liquidity}`),
        result.total_liquidity,
      ],
      [
        "rcf_draw",
        value(operatingModel, `${column}${waterfallRows.rcf_draw_waterfall}`),
        result.rcf_draw,
      ],
      [
        "rcf_repayment",
        value(
          operatingModel,
          `${column}${waterfallRows.rcf_repayment_waterfall}`,
        ),
        result.rcf_repayment,
      ],
      [
        "rcf_interest",
        -numeric(value(operatingModel, `${column}${interestRows.rcf_interest}`)),
        result.rcf_interest,
      ],
      [
        "rcf_commitment_fee",
        -numeric(
          value(operatingModel, `${column}${interestRows.rcf_commitment_fee}`),
        ),
        result.rcf_commitment_fee,
      ],
      [
        "undrawn_rcf",
        value(operatingModel, `${column}${debtRows.undrawn_rcf}`),
        result.undrawn_rcf,
      ],
    ];
    if (Number.isFinite(Number(debtRows.reported_cash))) {
      comparisons.push([
        "reported_cash_summary",
        value(operatingModel, `${column}${debtRows.reported_cash}`),
        result.reported_cash ?? result.ending_cash,
      ]);
    }
    if (Number.isFinite(Number(debtRows.liquidity_cash))) {
      comparisons.push([
        "liquidity_cash",
        value(operatingModel, `${column}${debtRows.liquidity_cash}`),
        result.liquidity_cash ?? result.ending_cash,
      ]);
    }
    if (Number.isFinite(Number(debtRows.cash_for_net_debt))) {
      comparisons.push([
        "net_debt_eligible_cash",
        value(operatingModel, `${column}${debtRows.cash_for_net_debt}`),
        -numeric(result.eligible_cash ?? result.ending_cash),
      ]);
    }
    if (Number.isFinite(Number(debtRows.interest_bearing_cash))) {
      comparisons.push([
        "interest_eligible_cash",
        value(operatingModel, `${column}${debtRows.interest_bearing_cash}`),
        result.interest_eligible_cash ?? result.ending_cash,
      ]);
    }
    for (const [metric, actual, expected] of comparisons) {
      solverVisited += 1;
      // net_leverage IS the metric DEFECT 0.2 was written about: a 0.05
      // absolute band on a 3.0x multiple licensed 1.7% of disagreement.
      const metricClass = metric === "net_leverage" ? "ratio" : "currency";
      const band = toleranceFor(
        "independent-solver-parity",
        metricClass,
        Math.max(Math.abs(numeric(actual)), Math.abs(numeric(expected))),
      );
      if (!approximatelyEqual(actual, expected, band)) {
        solverErrors.push({
          column,
          metric,
          metric_class: metricClass,
          actual,
          expected,
          tolerance: band,
        });
      }
    }
  }
}
checks.push(
  record(
    "independent-solver-parity",
    solverVisited > 0 &&
      solverErrors.length === 0 &&
      solution.all_checks_pass === true,
    solverVisited > 0
      ? "Saved workbook values match the independent solver in standalone and pro forma."
      : "Independent solver parity compared ZERO metrics — the check cannot pass on an empty visit.",
    {
      visited: solverVisited,
      solver_all_checks_pass: solution.all_checks_pass,
      differences: solverErrors,
    },
  ),
);

const expectedNativeBindings = buildNativeEvidenceBindings({
  caseId: solution.case_id,
  caseSha256: semanticManifest.case_sha256,
  workbookBytes: workbookBuffer,
  semanticManifestBytes: semanticManifestText,
  rowMapBytes: rowMapBuffer,
});
const nativeEvidenceErrors = financeReview.data
  ? validateNativeEvidence(financeReview.data, expectedNativeBindings)
  : [];
const nativeEvidencePassed =
  financeReview.passed && nativeEvidenceErrors.length === 0;
checks.push(
  record(
    "native-excel-toggle-restoration",
    nativeEvidencePassed,
    nativeEvidencePassed
      ? "Passing native Excel on/off/on/off/on evidence is hash-bound to this case, manifest and workbook."
      : financeReview.supplied
        ? "The supplied native Excel evidence is incomplete or belongs to a different build."
      : "Native Excel on/off/on/off/on restoration remains required.",
    {
      review: financeReview.evidence,
      expected_bindings: expectedNativeBindings,
      errors: nativeEvidenceErrors,
    },
    financeReview.supplied
      ? nativeEvidencePassed
        ? "pass"
        : "fail"
      : "manual",
  ),
);
checks.push(
  record(
    "visual-review",
    visualReview.passed,
    visualReview.passed
      ? "Passing visual-review evidence was supplied."
      : visualReview.supplied
        ? "The supplied visual-review evidence is empty or has not passed."
      : "A human visual review remains required.",
    visualReview.evidence,
    visualReview.supplied
      ? visualReview.passed
        ? "pass"
        : "fail"
      : "manual",
  ),
);

const failures = checks.filter((item) => item.status === "fail");
const manual = checks.filter((item) => item.status === "manual");
const report = {
  schema_version: 1,
  validator: "debt-model-unified-v2",
  // DEFECT 0.2. Stated on the face of every report so a run made under a
  // loosened `--tolerance` can never be mistaken for a contract run.
  tolerances: tolerances.summary(),
  workbook: inputPath,
  status:
    failures.length > 0
      ? "FAIL"
      : manual.length > 0
        ? "PASS_PENDING_MANUAL"
        : "PASS",
  summary: {
    passed: checks.filter((item) => item.status === "pass").length,
    failed: failures.length,
    manual: manual.length,
  },
  checks,
};
await fs.writeFile(
  path.join(outputDirectory, "validation-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(outputDirectory, "validation-report.md"),
  [
    `# Debt Model Unified v2 validation`,
    "",
    `Status: **${report.status}**`,
    "",
    ...checks.map(
      (item) =>
        `- ${item.status.toUpperCase()} — ${item.id}: ${item.message}`,
    ),
    "",
  ].join("\n"),
  "utf8",
);
console.log(
  path.join(outputDirectory, "validation-report.json"),
);
if (failures.length > 0) process.exitCode = 1;
