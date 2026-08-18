import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

const P = "(?:[A-Za-z_][\\w.-]*:)?";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(xml, name) {
  return decodeXml(new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(xml)?.[1] ?? "");
}

function directItems(xml, tag) {
  return xml.match(new RegExp(`<${P}${tag}\\b[^>]*?/>|<${P}${tag}\\b[^>]*>[\\s\\S]*?</${P}${tag}>`, "g")) ?? [];
}

function inner(xml, tag) {
  return new RegExp(`<${P}${tag}\\b[^>]*>([\\s\\S]*?)</${P}${tag}>`).exec(xml)?.[1] ?? "";
}

function columnNumber(label) {
  let value = 0;
  for (const char of String(label)) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function addressParts(address) {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(String(address ?? "").toUpperCase());
  return match ? { column: columnNumber(match[1]), row: Number(match[2]) } : null;
}

function rangeBounds(reference) {
  const [first, second = first] = String(reference ?? "A1").split(":");
  const start = addressParts(first) ?? { column: 1, row: 1 };
  const end = addressParts(second) ?? start;
  return {
    min_column: Math.min(start.column, end.column),
    max_column: Math.max(start.column, end.column),
    min_row: Math.min(start.row, end.row),
    max_row: Math.max(start.row, end.row),
  };
}

function inside(address, bounds) {
  const point = addressParts(address);
  return Boolean(point && point.column >= bounds.min_column && point.column <= bounds.max_column && point.row >= bounds.min_row && point.row <= bounds.max_row);
}

function relationships(xml, base) {
  const values = new Map();
  for (const item of directItems(xml, "Relationship")) {
    const id = attr(item, "Id");
    const target = attr(item, "Target");
    if (!id || !target) continue;
    values.set(id, {
      id,
      type: attr(item, "Type"),
      target_mode: attr(item, "TargetMode") || null,
      target,
      resolved_target: attr(item, "TargetMode") === "External"
        ? target
        : path.posix.normalize(path.posix.join(base, target)),
    });
  }
  return values;
}

function formulaPrecedents(formula, currentSheet) {
  const precedents = new Set();
  const pattern = /(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_. -]*))!)?\$?([A-Z]{1,3})\$?(\d+)/g;
  for (const match of String(formula ?? "").matchAll(pattern)) {
    const sheet = (match[1]?.replace(/''/g, "'") ?? match[2] ?? currentSheet).trim();
    precedents.add(`${sheet}!${match[3]}${match[4]}`);
  }
  return [...precedents].sort();
}

function styleInventory(stylesXml) {
  const fonts = directItems(inner(stylesXml, "fonts"), "font").map((font) => {
    const colour = new RegExp(`<${P}color\\b([^>]*)/?>`).exec(font)?.[1] ?? "";
    return {
      colour_rgb: attr(colour, "rgb") || null,
      colour_theme: attr(colour, "theme") || null,
      bold: new RegExp(`<${P}b(?:\\s[^>]*)?/?>`).test(font),
      italic: new RegExp(`<${P}i(?:\\s[^>]*)?/?>`).test(font),
    };
  });
  const fills = directItems(inner(stylesXml, "fills"), "fill").map((fill) => {
    const colour = new RegExp(`<${P}fgColor\\b([^>]*)/?>`).exec(fill)?.[1] ?? "";
    return {
      pattern: attr(new RegExp(`<${P}patternFill\\b([^>]*)`).exec(fill)?.[1] ?? "", "patternType") || null,
      colour_rgb: attr(colour, "rgb") || null,
      colour_theme: attr(colour, "theme") || null,
    };
  });
  return directItems(inner(stylesXml, "cellXfs"), "xf").map((xf, styleId) => {
    const alignment = new RegExp(`<${P}alignment\\b([^>]*)/?>`).exec(xf)?.[1] ?? "";
    const fontId = Number(attr(xf, "fontId") || 0);
    const fillId = Number(attr(xf, "fillId") || 0);
    return {
      style_id: styleId,
      font_id: fontId,
      fill_id: fillId,
      border_id: Number(attr(xf, "borderId") || 0),
      number_format_id: Number(attr(xf, "numFmtId") || 0),
      indentation: Number(attr(alignment, "indent") || 0),
      horizontal_alignment: attr(alignment, "horizontal") || null,
      vertical_alignment: attr(alignment, "vertical") || null,
      font: fonts[fontId] ?? null,
      fill: fills[fillId] ?? null,
    };
  });
}

async function text(zip, target, required = false) {
  const file = zip.file(target);
  if (!file) {
    if (required) throw new Error(`Workbook part is absent: ${target}`);
    return "";
  }
  return file.async("string");
}

function sheetCells(sheetXml, sheetName, styles, dimension) {
  const bounds = rangeBounds(dimension);
  const cells = [];
  for (const cell of directItems(inner(sheetXml, "sheetData"), "c")) {
    const opening = /^<[^>]+>/.exec(cell)?.[0] ?? cell;
    const address = attr(opening, "r");
    if (!address) continue;
    const formula = decodeXml(new RegExp(`<${P}f\\b[^>]*>([\\s\\S]*?)</${P}f>`).exec(cell)?.[1] ?? "") || null;
    const inline = decodeXml(inner(cell, "t")) || null;
    const cached = decodeXml(new RegExp(`<${P}v\\b[^>]*>([\\s\\S]*?)</${P}v>`).exec(cell)?.[1] ?? "") || null;
    const styleId = Number(attr(opening, "s") || 0);
    cells.push({
      address,
      cell_type: attr(opening, "t") || null,
      style_id: styleId,
      style: styles[styleId] ?? null,
      formula,
      cached_value: cached,
      inline_text: inline,
      formula_precedents: formula ? formulaPrecedents(formula, sheetName) : [],
      inside_declared_dimension: inside(address, bounds),
    });
  }
  return cells.sort((left, right) => {
    const a = addressParts(left.address);
    const b = addressParts(right.address);
    return a.row - b.row || a.column - b.column;
  });
}

export async function inspectWorkbookSemantics(workbookPath) {
  const bytes = await fs.readFile(workbookPath);
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await text(zip, "xl/workbook.xml", true);
  const workbookRels = relationships(await text(zip, "xl/_rels/workbook.xml.rels", true), "xl");
  const styles = styleInventory(await text(zip, "xl/styles.xml", true));
  const sheets = [];
  const externalRelationships = [];

  for (const descriptor of directItems(inner(workbookXml, "sheets"), "sheet")) {
    const name = attr(descriptor, "name");
    const relationshipId = attr(descriptor, "r:id");
    const relationship = workbookRels.get(relationshipId);
    if (!relationship) throw new Error(`Worksheet relationship is absent for ${name}.`);
    const sheetPath = relationship.resolved_target;
    const sheetXml = await text(zip, sheetPath, true);
    const sheetRelsPath = path.posix.join(path.posix.dirname(sheetPath), "_rels", `${path.posix.basename(sheetPath)}.rels`);
    const sheetRels = relationships(await text(zip, sheetRelsPath), path.posix.dirname(sheetPath));
    for (const rel of sheetRels.values()) {
      if (rel.target_mode === "External") externalRelationships.push({ sheet: name, ...rel });
    }
    const dimension = attr(new RegExp(`<${P}dimension\\b([^>]*)/?>`).exec(sheetXml)?.[1] ?? "", "ref") || "A1";
    const hiddenRows = directItems(inner(sheetXml, "sheetData"), "row")
      .filter((row) => attr(/^<[^>]+>/.exec(row)?.[0] ?? row, "hidden") === "1")
      .map((row) => Number(attr(/^<[^>]+>/.exec(row)?.[0] ?? row, "r")));
    const hiddenColumns = [];
    for (const column of directItems(inner(sheetXml, "cols"), "col")) {
      if (attr(column, "hidden") !== "1") continue;
      hiddenColumns.push({ min: Number(attr(column, "min")), max: Number(attr(column, "max")) });
    }
    const cells = sheetCells(sheetXml, name, styles, dimension);
    const hiddenHardcodes = cells.filter((cell) => {
      if (cell.formula || (cell.cached_value === null && cell.inline_text === null)) return false;
      const point = addressParts(cell.address);
      return hiddenRows.includes(point.row) || hiddenColumns.some((range) => point.column >= range.min && point.column <= range.max);
    }).map((cell) => cell.address);
    const dataValidations = directItems(inner(sheetXml, "dataValidations"), "dataValidation").map((entry) => ({
      type: attr(entry, "type") || null,
      sqref: attr(entry, "sqref") || null,
      error_style: attr(entry, "errorStyle") || null,
      show_error_message: attr(entry, "showErrorMessage") || null,
      formula1: decodeXml(inner(entry, "formula1")) || null,
      formula2: decodeXml(inner(entry, "formula2")) || null,
    }));
    const commentRel = [...sheetRels.values()].find((rel) => rel.type.endsWith("/comments"));
    const commentsXml = commentRel ? await text(zip, commentRel.resolved_target, true) : "";
    const comments = directItems(inner(commentsXml, "commentList"), "comment").map((comment) => ({
      address: attr(comment, "ref"),
      author_id: attr(comment, "authorId") || null,
      text: decodeXml([...comment.matchAll(new RegExp(`<${P}t\\b[^>]*>([\\s\\S]*?)</${P}t>`, "g"))].map((match) => match[1]).join("")),
    }));
    sheets.push({
      name,
      state: attr(descriptor, "state") || "visible",
      part: sheetPath,
      declared_dimension: dimension,
      cell_count: cells.length,
      formula_count: cells.filter((cell) => cell.formula).length,
      cells,
      hidden_rows: hiddenRows,
      hidden_columns: hiddenColumns,
      hidden_hardcoded_cells: hiddenHardcodes,
      merged_cells: directItems(inner(sheetXml, "mergeCells"), "mergeCell").map((entry) => attr(entry, "ref")).filter(Boolean),
      outline_rows: directItems(inner(sheetXml, "sheetData"), "row").map((row) => {
        const opening = /^<[^>]+>/.exec(row)?.[0] ?? row;
        return { row: Number(attr(opening, "r")), level: Number(attr(opening, "outlineLevel") || 0) };
      }).filter((entry) => entry.level > 0),
      outline_columns: directItems(inner(sheetXml, "cols"), "col").map((column) => ({
        min: Number(attr(column, "min")),
        max: Number(attr(column, "max")),
        level: Number(attr(column, "outlineLevel") || 0),
      })).filter((entry) => entry.level > 0),
      comments,
      data_validations: dataValidations,
      formulas_outside_declared_dimension: cells.filter((cell) => cell.formula && !cell.inside_declared_dimension).map((cell) => cell.address),
    });
  }

  for (const rel of workbookRels.values()) {
    if (rel.target_mode === "External") externalRelationships.push({ sheet: null, ...rel });
  }
  const externalParts = Object.keys(zip.files).filter((name) => name.startsWith("xl/externalLinks/") && !name.endsWith("/")).sort();
  const definedNames = directItems(inner(workbookXml, "definedNames"), "definedName").map((entry) => ({
    name: attr(entry, "name"),
    local_sheet_id: attr(entry, "localSheetId") || null,
    hidden: attr(entry, "hidden") === "1",
    refers_to: decodeXml(entry.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "")),
  }));
  const violations = [];
  if (externalParts.length > 0 || externalRelationships.length > 0) violations.push("unexpected_external_links");
  if (sheets.some((sheet) => sheet.formulas_outside_declared_dimension.length > 0)) violations.push("formula_outside_declared_dimension");
  if (sheets.some((sheet) => sheet.hidden_hardcoded_cells.length > 0)) violations.push("hidden_hardcoded_cells");

  return {
    schema_version: "workbook-semantic-inventory/1.0",
    status: violations.length === 0 ? "PASS" : "FAIL",
    workbook_sha256: sha256(bytes),
    workbook_bytes: bytes.length,
    styles,
    defined_names: definedNames,
    external_link_parts: externalParts,
    external_relationships: externalRelationships,
    sheets,
    summary: {
      sheet_count: sheets.length,
      cell_count: sheets.reduce((sum, sheet) => sum + sheet.cell_count, 0),
      formula_count: sheets.reduce((sum, sheet) => sum + sheet.formula_count, 0),
      comment_count: sheets.reduce((sum, sheet) => sum + sheet.comments.length, 0),
      data_validation_count: sheets.reduce((sum, sheet) => sum + sheet.data_validations.length, 0),
      merged_cell_count: sheets.reduce((sum, sheet) => sum + sheet.merged_cells.length, 0),
      hidden_row_count: sheets.reduce((sum, sheet) => sum + sheet.hidden_rows.length, 0),
      hidden_column_range_count: sheets.reduce((sum, sheet) => sum + sheet.hidden_columns.length, 0),
      named_range_count: definedNames.length,
      external_link_count: externalParts.length + externalRelationships.length,
      formula_outside_declared_dimension_count: sheets.reduce((sum, sheet) => sum + sheet.formulas_outside_declared_dimension.length, 0),
      hidden_hardcoded_cell_count: sheets.reduce((sum, sheet) => sum + sheet.hidden_hardcoded_cells.length, 0),
      violations,
    },
  };
}
