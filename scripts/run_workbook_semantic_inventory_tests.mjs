#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import { inspectWorkbookSemantics } from "./lib/workbook_semantic_inventory.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="${NS}" xmlns:r="${REL_NS}">
  <sheets><sheet name="Model" sheetId="1" r:id="rId1"/><sheet name="Support" sheetId="2" r:id="rId2"/></sheets>
  <definedNames><definedName name="Model_Area">Model!$A$1:$B$3</definedName></definedNames>
</workbook>`;
}

function workbookRelationships({ external = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="${REL_NS}/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="${REL_NS}/styles" Target="styles.xml"/>
  ${external ? `<Relationship Id="rId4" Type="${REL_NS}/externalLinkPath" Target="https://example.invalid/book.xlsx" TargetMode="External"/>` : ""}
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="${NS}">
  <fonts count="2"><font><color rgb="FF000000"/></font><font><b/><color rgb="FF0000FF"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
  <borders count="1"><border/></borders>
  <cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" numFmtId="0"/><xf fontId="1" fillId="1" borderId="0" numFmtId="0"><alignment indent="2" horizontal="left"/></xf></cellXfs>
</styleSheet>`;
}

function modelSheet({ outsideFormula = false, hiddenHardcode = false } = {}) {
  const extra = outsideFormula ? `<c r="C4"><f>A1</f><v>1</v></c>` : "";
  const hidden = hiddenHardcode ? `<c r="A3" t="n"><v>99</v></c>` : `<c r="A3"><f>A1</f><v>1</v></c>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">
  <dimension ref="A1:B3"/>
  <cols><col min="2" max="2" hidden="1" outlineLevel="1"/></cols>
  <sheetData>
    <row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Input</t></is></c><c r="B1"><f>'Support'!A1+A2</f><v>3</v></c></row>
    <row r="2" outlineLevel="1"><c r="A2"><v>2</v></c></row>
    <row r="3" hidden="1">${hidden}</row>
    ${extra ? `<row r="4">${extra}</row>` : ""}
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
  <dataValidations count="1"><dataValidation type="decimal" sqref="A2" errorStyle="stop" showErrorMessage="1"><formula1>0</formula1><formula2>10</formula2></dataValidation></dataValidations>
</worksheet>`;
}

function supportSheet() {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
}

function sheetRelationships() {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rIdComment" Type="${REL_NS}/comments" Target="../comments1.xml"/></Relationships>`;
}

function commentsXml() {
  return `<?xml version="1.0" encoding="UTF-8"?><comments xmlns="${NS}"><authors><author>Reviewer</author></authors><commentList><comment ref="A1" authorId="0"><text><t>Source note</t></text></comment></commentList></comments>`;
}

async function fixture(target, options = {}) {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", workbookXml());
  zip.file("xl/_rels/workbook.xml.rels", workbookRelationships(options));
  zip.file("xl/styles.xml", stylesXml());
  zip.file("xl/worksheets/sheet1.xml", modelSheet(options));
  zip.file("xl/worksheets/sheet2.xml", supportSheet());
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", sheetRelationships());
  zip.file("xl/comments1.xml", commentsXml());
  await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-semantic-inventory-"));
try {
  const clean = path.join(root, "clean.xlsx");
  await fixture(clean);
  const result = await inspectWorkbookSemantics(clean);
  assert.equal(result.status, "PASS");
  assert.equal(result.summary.sheet_count, 2);
  assert.equal(result.summary.cell_count, 5);
  assert.equal(result.summary.formula_count, 2);
  assert.equal(result.summary.comment_count, 1);
  assert.equal(result.summary.data_validation_count, 1);
  assert.equal(result.summary.merged_cell_count, 1);
  assert.equal(result.summary.hidden_row_count, 1);
  assert.equal(result.summary.hidden_column_range_count, 1);
  assert.equal(result.summary.named_range_count, 1);
  assert.deepEqual(result.sheets[0].cells.find((cell) => cell.address === "B1").formula_precedents, ["Model!A2", "Support!A1"]);
  assert.equal(result.sheets[0].cells.find((cell) => cell.address === "A1").style.font.colour_rgb, "FF0000FF");
  assert.equal(result.sheets[0].cells.find((cell) => cell.address === "A1").style.fill.colour_rgb, "FFFFFF00");
  assert.equal(result.sheets[0].cells.find((cell) => cell.address === "A1").style.indentation, 2);

  const mutations = [
    ["formula outside declared used range", { outsideFormula: true }, "formula_outside_declared_dimension"],
    ["external workbook relationship", { external: true }, "unexpected_external_links"],
    ["hidden hardcoded plug", { hiddenHardcode: true }, "hidden_hardcoded_cells"],
  ];
  for (const [name, options, violation] of mutations) {
    const target = path.join(root, `${violation}.xlsx`);
    await fixture(target, options);
    const mutated = await inspectWorkbookSemantics(target);
    assert.equal(mutated.status, "FAIL", `${name} was accepted`);
    assert.ok(mutated.summary.violations.includes(violation), `${name} did not emit ${violation}`);
  }

  console.log(JSON.stringify({
    status: "PASS",
    positive_checks: 15,
    mutations_rejected: mutations.length,
    violations: 0,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
