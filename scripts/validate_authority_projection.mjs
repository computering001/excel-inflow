#!/usr/bin/env node

/**
 * Prove that a generated plan is a faithful production projection of one of
 * the two frozen standardised workbook authorities.
 *
 * This is deliberately not a literal workbook replay check. Production has a
 * small, versioned set of approved corrections. Everything else fails closed:
 * physical geometry, row topology, style channels, labels and provenance.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// Match scripts/lib/design_contract.mjs exactly: epoch 4 is the default and
// epochs 2 and 3 are available only through explicit rollback switches.
function selectedDesignEpoch() {
  const raw = process.env.EXCEL_INFLOW_DESIGN_EPOCH;
  if (raw === undefined || raw === "" || raw === "4") return 4;
  if (raw === "2" || raw === "3") return Number(raw);
  throw new Error(
    `Unsupported EXCEL_INFLOW_DESIGN_EPOCH ${JSON.stringify(raw)}; expected 2, 3 or 4.`,
  );
}
const ACTIVE_EPOCH = selectedDesignEpoch();
const DEFAULT_CONTRACT = path.join(
  ROOT,
  "assets",
  `standardised-design-contract.v${ACTIVE_EPOCH}.json`,
);
const DEFAULT_RUNTIME = path.join(
  ROOT,
  "assets",
  `standardised-design-runtime.v${ACTIVE_EPOCH}.json`,
);
const DEFAULT_OVERRIDES = path.join(
  ROOT,
  "assets",
  `authority-projection-overrides.v${ACTIVE_EPOCH}.json`,
);
const OPERATING_MODEL = "Operating Model";
const MAX_COLUMN = 21; // A:U
const EXTERNAL_SHEET_REFERENCE = /(?:'[^']+'|[A-Za-z_][A-Za-z0-9_ ]*)!/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}

function usage() {
  return [
    "Usage: validate_authority_projection.mjs",
    "  --plan <generated.plan.json> --row-map <generated.row-map.json>",
    "  --authority-plan <frozen-authority.plan.json>",
    "  [--contract <design-contract.json>] [--runtime <design-runtime.json>]",
    "  [--overrides <projection-overrides.json>] [--out <report.json>] [--json]",
  ].join("\n");
}

async function readArtifact(filename) {
  const raw = await fs.readFile(filename);
  return {
    filename: path.resolve(filename),
    raw,
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    json: JSON.parse(raw.toString("utf8")),
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) {
  return stable(left) === stable(right);
}

function columnName(index) {
  let current = index;
  let result = "";
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function normalizeColor(value) {
  if (typeof value === "string") return value.toUpperCase().slice(-6);
  if (value && typeof value === "object") {
    const result = { ...value };
    if (result.rgb) result.rgb = String(result.rgb).toUpperCase().slice(-6);
    return result;
  }
  return null;
}

function normalizeStyle(style = {}) {
  const font = style.font ?? {};
  const alignment = style.alignment ?? {};
  const border = style.border ?? {};
  const side = (value) => value
    ? { style: value.style ?? null, color: normalizeColor(value.color) }
    : null;
  return {
    number_format: style.number_format ?? "General",
    font: {
      name: font.name ?? null,
      size: font.size ?? null,
      color: normalizeColor(font.color),
      bold: Boolean(font.bold),
      italic: Boolean(font.italic),
      underline: font.underline ?? null,
    },
    fill: style.fill
      ? {
          pattern: style.fill.pattern ?? null,
          fg_color: normalizeColor(style.fill.fg_color),
          bg_color: normalizeColor(style.fill.bg_color),
        }
      : null,
    border: {
      left: side(border.left),
      right: side(border.right),
      top: side(border.top),
      bottom: side(border.bottom),
    },
    alignment: {
      horizontal: alignment.horizontal ?? null,
      vertical: alignment.vertical ?? null,
      wrap_text: Boolean(alignment.wrap_text),
      shrink_to_fit: Boolean(alignment.shrink_to_fit),
      indent: alignment.indent ?? 0,
      text_rotation: alignment.text_rotation ?? 0,
    },
  };
}

function diffPaths(left, right, prefix = "") {
  if (same(left, right)) return [];
  if (
    left === null || right === null
    || typeof left !== "object" || typeof right !== "object"
    || Array.isArray(left) || Array.isArray(right)
  ) return [prefix || "$root"];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].sort().flatMap((key) => diffPaths(
    left[key],
    right[key],
    prefix ? `${prefix}.${key}` : key,
  ));
}

function sheetByName(plan, name) {
  return plan.workbook?.sheets?.find((sheet) => sheet.name === name) ?? null;
}

function styleAt(plan, sheet, address) {
  const cell = sheet.cells?.[address] ?? {};
  return normalizeStyle(plan.workbook.styles?.[cell.s ?? 0] ?? {});
}

function rowRecord(sheet, row) {
  const record = sheet.rows?.find((item) => item.row === row) ?? {};
  const result = { ...record };
  delete result.row;
  return result;
}

function activeRules(items, profile) {
  return (items ?? []).filter((item) => item.profiles?.includes(profile));
}

function controlMapAfterApprovedReplacement(
  authorityControls,
  replacements,
  additions = [],
) {
  const expected = { ...authorityControls };
  for (const replacement of replacements) {
    expected[replacement.production_key] = expected[replacement.authority_key];
    delete expected[replacement.authority_key];
  }
  for (const addition of additions) {
    expected[addition.production_key] = addition.row;
  }
  return expected;
}

function allowedLabelDifference(rowId, generated, authority, variants) {
  return variants.some((rule) => {
    if (
      rule.row_id === rowId
      && generated === rule.production_label
      && authority === rule.authority_label
    ) return true;
    if (
      rule.row_id_suffix
      && rowId.endsWith(rule.row_id_suffix)
      && generated === rule.production_label
      && String(authority).toLowerCase().endsWith(
        String(rule.authority_label_suffix).toLowerCase(),
      )
    ) return true;
    if (rule.row_id_prefix && rule.authority_text && rule.production_text) {
      if (!rowId.startsWith(rule.row_id_prefix)) return false;
      const escaped = String(rule.authority_text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "gi");
      if (!pattern.test(String(authority))) return false;
      const expected = String(authority).replace(pattern, rule.production_text);
      return generated === expected;
    }
    return false;
  });
}

function allowedStyleDifference(
  context,
  corrections,
  controlReplacements,
  physicalCorrections,
  semanticCorrections,
) {
  const {
    address,
    rowId,
    column,
    generatedCell,
    generatedStyle,
    authorityStyle,
    paths,
  } = context;
  const control = controlReplacements.find((rule) => rule.permitted_style_correction?.cell === address);
  if (control) {
    const correction = control.permitted_style_correction;
    if (
      same(paths, [correction.channel])
      && generatedStyle[correction.channel] === correction.production
      && authorityStyle[correction.channel] === correction.authority
    ) return { kind: "control_style_correction", rule: control };
  }

  for (const rule of physicalCorrections) {
    if (rule.cell !== address) continue;
    if (!same(paths, [rule.channel])) continue;
    if (generatedStyle[rule.channel] !== rule.production) continue;
    if (authorityStyle[rule.channel] !== rule.authority) continue;
    return { kind: "physical_style_correction", rule };
  }

  const styleValue = (style, dottedPath) => dottedPath
    .split(".")
    .reduce((value, key) => value?.[key], style);
  for (const rule of semanticCorrections) {
    if (!(rule.row_ids ?? []).includes(rowId)) continue;
    if (rule.columns && !rule.columns.includes(column)) continue;
    if (!same(paths, rule.paths ?? [])) continue;
    const expected = rule.expected ?? {};
    const matches = Object.entries(expected).every(([stylePath, values]) =>
      same(styleValue(generatedStyle, stylePath), values.production)
      && same(styleValue(authorityStyle, stylePath), values.authority),
    );
    if (!matches) continue;
    return { kind: "semantic_style_correction", rule };
  }

  for (const rule of corrections) {
    if (!same(paths, [rule.only_permitted_style_channel])) continue;
    if (rule.generated_formula_requires_external_sheet_reference && !EXTERNAL_SHEET_REFERENCE.test(generatedCell.f ?? "")) continue;
    if (
      rule.generated_formula_requires_same_sheet_reference
      && (EXTERNAL_SHEET_REFERENCE.test(generatedCell.f ?? "") || !generatedCell.f)
    ) continue;
    if (generatedStyle.font.color !== rule.production_font_color) continue;
    if (authorityStyle.font.color !== rule.authority_font_color) continue;
    return { kind: "formula_provenance_correction", rule };
  }
  return null;
}

function pushViolation(report, code, message, evidence = {}) {
  report.violations.push({ code, message, evidence });
}

function recordApproval(report, kind, evidence = {}) {
  report.approved_differences.push({ kind, evidence });
}

export async function validateAuthorityProjection(input) {
  const [planArtifact, rowMapArtifact, authorityArtifact, contractArtifact, runtimeArtifact, overrideArtifact] = await Promise.all([
    readArtifact(input.plan),
    readArtifact(input.rowMap),
    readArtifact(input.authorityPlan),
    readArtifact(input.contract ?? DEFAULT_CONTRACT),
    readArtifact(input.runtime ?? DEFAULT_RUNTIME),
    readArtifact(input.overrides ?? DEFAULT_OVERRIDES),
  ]);

  const plan = planArtifact.json;
  const rowMap = rowMapArtifact.json;
  const authorityPlan = authorityArtifact.json;
  const contract = contractArtifact.json;
  const runtime = runtimeArtifact.json;
  const overrides = overrideArtifact.json;
  const profile = rowMap.authority_profile;
  const contractProfile = contract.profiles?.[profile];
  const runtimeProfile = runtime.profiles?.[profile];
  const report = {
    schema_version: 1,
    kind: "authority_projection_validation",
    profile,
    status: "FAIL",
    inputs: {
      plan: planArtifact.filename,
      row_map: rowMapArtifact.filename,
      authority_plan: authorityArtifact.filename,
      contract: contractArtifact.filename,
      runtime: runtimeArtifact.filename,
      overrides: overrideArtifact.filename,
    },
    hashes: {
      plan_sha256: planArtifact.sha256,
      row_map_sha256: rowMapArtifact.sha256,
      authority_plan_sha256: authorityArtifact.sha256,
      contract_sha256: contractArtifact.sha256,
      runtime_sha256: runtimeArtifact.sha256,
      overrides_sha256: overrideArtifact.sha256,
    },
    coverage: {
      geometry_fields: 0,
      control_keys: 0,
      physical_rows: 0,
      row_records: 0,
      semantic_rows: 0,
      semantic_labels: 0,
      style_cells: 0,
      formula_cells: 0,
      external_formula_cells: 0,
    },
    approved_differences: [],
    violations: [],
  };

  if (!contractProfile || !runtimeProfile) {
    pushViolation(report, "APROJ-001", `Unknown or missing authority profile: ${profile ?? "[missing]"}.`);
    return report;
  }

  const hashAssertions = [
    ["row-map contract", rowMap.authority_contract_sha256, contractArtifact.sha256],
    ["row-map runtime", rowMap.authority_runtime_contract_sha256, runtimeArtifact.sha256],
    ["override contract", overrides.source_contract_sha256, contractArtifact.sha256],
    ["override runtime", overrides.source_runtime_sha256, runtimeArtifact.sha256],
    ["authority extraction plan", authorityArtifact.sha256, contractProfile.extracted_plan?.sha256],
    ["row-map authority workbook", rowMap.authority_source_sha256, contractProfile.immutable_authority?.sha256],
  ];
  for (const [label, actual, expected] of hashAssertions) {
    if (actual !== expected) pushViolation(report, "APROJ-002", `${label} hash mismatch.`, { actual, expected });
  }

  const generatedOrder = plan.workbook?.sheets?.map((sheet) => sheet.name) ?? [];
  const authorityOrder = authorityPlan.workbook?.sheets?.map((sheet) => sheet.name) ?? [];
  const requiredOrder = runtime.shared_horizontal_grammar?.sheet_order ?? [];
  report.coverage.geometry_fields += 2;
  if (!same(generatedOrder, requiredOrder)) pushViolation(report, "APROJ-003", "Generated sheet order does not match the production authority.", { generatedOrder, requiredOrder });
  if (!same(authorityOrder, requiredOrder)) pushViolation(report, "APROJ-004", "Measured authority-plan sheet order does not match its contract.", { authorityOrder, requiredOrder });

  const geometryKeys = [
    "columns",
    "freeze_pane",
    "show_gridlines",
    "merges",
    "default_row_height",
    "page_margins",
    "outline",
    "data_validations",
  ];
  for (const name of requiredOrder) {
    const generatedSheet = sheetByName(plan, name);
    const authoritySheet = sheetByName(authorityPlan, name);
    if (!generatedSheet || !authoritySheet) continue;
    for (const key of geometryKeys) {
      report.coverage.geometry_fields += 1;
      if (!same(generatedSheet[key] ?? null, authoritySheet[key] ?? null)) {
        pushViolation(report, "APROJ-005", `${name}.${key} differs from the frozen authority.`, {
          generated: generatedSheet[key] ?? null,
          authority: authoritySheet[key] ?? null,
        });
      }
    }
  }

  const generatedSheet = sheetByName(plan, OPERATING_MODEL);
  const authoritySheet = sheetByName(authorityPlan, OPERATING_MODEL);
  if (!generatedSheet || !authoritySheet) {
    pushViolation(report, "APROJ-006", "Operating Model sheet is missing from a required artifact.");
    return report;
  }

  const expectedDimensions = runtime.shared_horizontal_grammar?.column_dimensions ?? [];
  const generatedDimensions = (generatedSheet.columns ?? []).map(({ min, max, width }) => ({ min, max, width }));
  report.coverage.geometry_fields += 1;
  if (!same(generatedDimensions, expectedDimensions)) {
    pushViolation(report, "APROJ-007", "A:U horizontal grammar differs from the production contract.", { generatedDimensions, expectedDimensions });
  }

  const replacements = activeRules(overrides.rules?.control_replacements, profile);
  const controlAdditions = activeRules(
    overrides.rules?.control_additions,
    profile,
  );
  const expectedControls = controlMapAfterApprovedReplacement(
    contractProfile.row_map.controls,
    replacements,
    controlAdditions,
  );
  report.coverage.control_keys = Object.keys(expectedControls).length;
  if (!same(rowMap.controls, expectedControls)) {
    pushViolation(report, "APROJ-008", "Control registry is not the approved production projection of the authority controls.", {
      generated: rowMap.controls,
      expected: expectedControls,
    });
  }
  for (const replacement of replacements) {
    const authorityLabel = authoritySheet.cells?.[replacement.label_cell]?.v;
    const generatedLabel = generatedSheet.cells?.[replacement.label_cell]?.v;
    if (authorityLabel !== replacement.authority_label || generatedLabel !== replacement.production_label) {
      pushViolation(report, "APROJ-009", "Approved acquisition-control replacement is not present exactly as declared.", {
        cell: replacement.label_cell,
        authorityLabel,
        generatedLabel,
        expectedAuthority: replacement.authority_label,
        expectedProduction: replacement.production_label,
      });
    } else {
      recordApproval(report, "control_replacement", {
        authority_key: replacement.authority_key,
        production_key: replacement.production_key,
        label_cell: replacement.label_cell,
      });
    }
  }
  for (const addition of controlAdditions) {
    if (rowMap.controls?.[addition.production_key] !== addition.row) {
      pushViolation(
        report,
        "APROJ-008",
        "Approved production control addition is absent or on the wrong row.",
        {
          production_key: addition.production_key,
          generated_row: rowMap.controls?.[addition.production_key] ?? null,
          expected_row: addition.row,
        },
      );
    } else {
      recordApproval(report, "control_addition", {
        production_key: addition.production_key,
        row: addition.row,
      });
    }
  }

  const authorityTopology = contractProfile.row_map.semantic_topology;
  const authorityRows = authorityTopology.rows_by_id ?? {};
  const generatedRows = rowMap.rows_by_id ?? {};
  const allowedMissingRules = activeRules(overrides.rules?.allowed_missing_semantic_rows, profile);
  const allowedMissingIds = new Set(allowedMissingRules.map((rule) => rule.row_id));
  const allowedAddedRules = activeRules(overrides.rules?.allowed_added_semantic_rows, profile);
  const allowedAddedIds = new Set(allowedAddedRules.map((rule) => rule.row_id));
  const reorderRules = activeRules(overrides.rules?.semantic_reorder_blocks, profile);
  const missing = Object.keys(authorityRows).filter((rowId) => generatedRows[rowId] === undefined);
  const unexpectedMissing = missing.filter((rowId) => !allowedMissingIds.has(rowId));
  const extras = Object.keys(generatedRows).filter((rowId) => authorityRows[rowId] === undefined);
  const unexpectedExtras = extras.filter((rowId) => !allowedAddedIds.has(rowId));
  if (unexpectedMissing.length > 0) pushViolation(report, "APROJ-010", "Undeclared semantic rows are missing.", { row_ids: unexpectedMissing });
  if (unexpectedExtras.length > 0) pushViolation(report, "APROJ-011", "Unexpected semantic rows were added to an authority replay case.", { row_ids: unexpectedExtras });
  for (const rule of allowedMissingRules) {
    if (!missing.includes(rule.row_id)) {
      pushViolation(report, "APROJ-012", "A declared omission is not actually exercised; remove the stale override.", { row_id: rule.row_id });
    } else {
      recordApproval(report, "semantic_row_omission", { row_id: rule.row_id });
    }
  }

  for (const rule of allowedAddedRules) {
    if (!extras.includes(rule.row_id)) {
      pushViolation(report, "APROJ-021", "A declared semantic addition is not actually exercised; remove the stale override.", { row_id: rule.row_id });
      continue;
    }
    const row = generatedRows[rule.row_id];
    const anchor = generatedRows[rule.after_row_id];
    if (!Number.isInteger(anchor) || row !== anchor + 1) {
      pushViolation(report, "APROJ-021", "An approved semantic addition is not at its exact declared anchor.", {
        row_id: rule.row_id,
        generated_row: row,
        after_row_id: rule.after_row_id,
        anchor_row: anchor,
      });
    } else {
      recordApproval(report, "semantic_row_addition", {
        row_id: rule.row_id,
        after_row_id: rule.after_row_id,
      });
    }
  }

  const reorderedIds = new Set();
  for (const rule of reorderRules) {
    const authorityOrder = (rule.authority_order ?? [])
      .filter((rowId) => authorityRows[rowId] !== undefined)
      .sort((left, right) => authorityRows[left] - authorityRows[right]);
    const productionOrder = (rule.production_order ?? [])
      .filter((rowId) => generatedRows[rowId] !== undefined)
      .sort((left, right) => generatedRows[left] - generatedRows[right]);
    if (
      !same(authorityOrder, rule.authority_order)
      || !same(productionOrder, rule.production_order)
    ) {
      pushViolation(report, "APROJ-022", "Approved semantic reorder block is not exercised exactly.", {
        expected_authority_order: rule.authority_order,
        actual_authority_order: authorityOrder,
        expected_production_order: rule.production_order,
        actual_production_order: productionOrder,
      });
      continue;
    }
    for (const rowId of new Set([
      ...(rule.authority_order ?? []),
      ...(rule.production_order ?? []),
    ])) reorderedIds.add(rowId);
    recordApproval(report, "semantic_reorder_block", {
      authority_order: rule.authority_order,
      production_order: rule.production_order,
    });
  }

  const commonRowIds = Object.keys(generatedRows).filter((rowId) => authorityRows[rowId] !== undefined);
  report.coverage.semantic_rows = commonRowIds.length;
  const orderComparableIds = commonRowIds.filter((rowId) => !reorderedIds.has(rowId));
  const authorityOrderBySemanticRow = orderComparableIds.slice().sort((left, right) => authorityRows[left] - authorityRows[right]);
  const generatedOrderBySemanticRow = orderComparableIds.slice().sort((left, right) => generatedRows[left] - generatedRows[right]);
  if (!same(generatedOrderBySemanticRow, authorityOrderBySemanticRow)) {
    pushViolation(report, "APROJ-013", "Semantic row order differs from the authority.", {
      generated: generatedOrderBySemanticRow,
      authority: authorityOrderBySemanticRow,
    });
  }

  const generatedSectionOrder = Object.entries(rowMap.section_headers ?? {}).sort((a, b) => a[1] - b[1]).map(([key]) => key);
  const authoritySectionOrder = Object.entries(authorityTopology.section_headers ?? {}).sort((a, b) => a[1] - b[1]).map(([key]) => key);
  if (!same(generatedSectionOrder, authoritySectionOrder)) {
    pushViolation(report, "APROJ-014", "Section order differs from the authority.", { generatedSectionOrder, authoritySectionOrder });
  }

  const labelVariants = activeRules(overrides.rules?.dynamic_label_variants, profile);
  for (const rowId of commonRowIds) {
    const generatedAddress = `B${generatedRows[rowId]}`;
    const authorityAddress = `B${authorityRows[rowId]}`;
    const generatedLabel = generatedSheet.cells?.[generatedAddress]?.v ?? null;
    const authorityLabel = authoritySheet.cells?.[authorityAddress]?.v ?? null;
    report.coverage.semantic_labels += 1;
    if (generatedLabel !== authorityLabel) {
      if (allowedLabelDifference(rowId, generatedLabel, authorityLabel, labelVariants)) {
        recordApproval(report, "dynamic_label_variant", { row_id: rowId, generatedLabel, authorityLabel });
      } else {
        pushViolation(report, "APROJ-015", "Semantic label differs without an approved dynamic-label rule.", {
          row_id: rowId,
          generated: generatedLabel,
          authority: authorityLabel,
        });
      }
    }
  }

  const authorityVisibleEnd = contractProfile.row_map.visible_end_row;
  const provenanceCorrections = activeRules(overrides.rules?.formula_provenance_corrections, profile);
  const physicalCorrections = activeRules(overrides.rules?.physical_style_corrections, profile);
  const semanticCorrections = activeRules(overrides.rules?.semantic_style_corrections, profile);

  // Reconstruct the production row universe by applying only the exact
  // semantic transactions declared by the override. This preserves physical
  // cell-for-cell comparison after approved omissions, insertions and moves;
  // an unexpected edit cannot hide in a loose positional tolerance.
  const authorityIdByRow = new Map(
    Object.entries(authorityRows).map(([rowId, row]) => [row, rowId]),
  );
  let projectedRows = Array.from({ length: authorityVisibleEnd }, (_, index) => ({
    authorityRow: index + 1,
    rowId: authorityIdByRow.get(index + 1) ?? null,
  }));
  projectedRows = projectedRows.filter(
    (item) => !allowedMissingIds.has(item.rowId),
  );
  for (const rule of allowedAddedRules) {
    const anchorIndex = projectedRows.findIndex(
      (item) => item.rowId === rule.after_row_id,
    );
    if (anchorIndex < 0) continue;
    projectedRows.splice(anchorIndex + 1, 0, {
      authorityRow: null,
      rowId: rule.row_id,
    });
  }
  for (const rule of reorderRules) {
    const blockIds = new Set([
      ...(rule.authority_order ?? []),
      ...(rule.production_order ?? []),
    ]);
    const indexes = projectedRows
      .map((item, index) => (blockIds.has(item.rowId) ? index : -1))
      .filter((index) => index >= 0);
    if (indexes.length !== blockIds.size) continue;
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    if (last - first + 1 !== indexes.length) {
      pushViolation(report, "APROJ-022", "Approved semantic reorder rows are not one contiguous physical block.", {
        production_order: rule.production_order,
        indexes,
      });
      continue;
    }
    const byId = new Map(
      projectedRows.slice(first, last + 1).map((item) => [item.rowId, item]),
    );
    projectedRows.splice(
      first,
      indexes.length,
      ...rule.production_order.map((rowId) => byId.get(rowId)),
    );
  }
  if (projectedRows.length !== rowMap.visible_end_row) {
    pushViolation(report, "APROJ-023", "Approved semantic row transactions do not reconstruct the generated visible row universe.", {
      projected_rows: projectedRows.length,
      generated_visible_end_row: rowMap.visible_end_row,
    });
  }
  for (const [index, item] of projectedRows.entries()) {
    const generatedRow = index + 1;
    if (item.rowId && generatedRows[item.rowId] !== generatedRow) {
      pushViolation(report, "APROJ-023", "Approved semantic row transactions do not reproduce the generated row map.", {
        row_id: item.rowId,
        projected_row: generatedRow,
        generated_row: generatedRows[item.rowId],
      });
    }
  }

  for (const [index, projected] of projectedRows.entries()) {
    if (!Number.isInteger(projected.authorityRow)) continue;
    const authorityRow = projected.authorityRow;
    const generatedRow = index + 1;
    report.coverage.physical_rows += 1;
    report.coverage.row_records += 1;
    const generatedRecord = rowRecord(generatedSheet, generatedRow);
    const authorityRecord = rowRecord(authoritySheet, authorityRow);
    if (!same(generatedRecord, authorityRecord)) {
      pushViolation(report, "APROJ-016", "Physical row properties differ from the authority.", {
        authority_row: authorityRow,
        generated_row: generatedRow,
        generated: generatedRecord,
        authority: authorityRecord,
      });
    }
    for (let column = 1; column <= MAX_COLUMN; column += 1) {
      const letter = columnName(column);
      const generatedAddress = `${letter}${generatedRow}`;
      const authorityAddress = `${letter}${authorityRow}`;
      const generatedCell = generatedSheet.cells?.[generatedAddress] ?? {};
      const authorityCell = authoritySheet.cells?.[authorityAddress] ?? {};
      const generatedStyle = styleAt(plan, generatedSheet, generatedAddress);
      const authorityStyle = styleAt(authorityPlan, authoritySheet, authorityAddress);
      report.coverage.style_cells += 1;
      if (!same(generatedStyle, authorityStyle)) {
        const paths = diffPaths(generatedStyle, authorityStyle);
        const approval = allowedStyleDifference({
          address: generatedAddress,
          rowId: projected.rowId ?? null,
          column: letter,
          generatedCell,
          authorityCell,
          generatedStyle,
          authorityStyle,
          paths,
        }, provenanceCorrections, replacements, physicalCorrections, semanticCorrections);
        if (approval) {
          recordApproval(report, approval.kind, {
            generated_address: generatedAddress,
            authority_address: authorityAddress,
            paths,
          });
        } else {
          pushViolation(report, "APROJ-017", "Physical style differs without an approved correction.", {
            generated_address: generatedAddress,
            authority_address: authorityAddress,
            paths,
            generated_style: generatedStyle,
            authority_style: authorityStyle,
          });
        }
      }
    }
  }

  for (const sheet of plan.workbook?.sheets ?? []) {
    for (const [address, cell] of Object.entries(sheet.cells ?? {})) {
      if (!cell.f) continue;
      report.coverage.formula_cells += 1;
      const color = styleAt(plan, sheet, address).font.color;
      const external = EXTERNAL_SHEET_REFERENCE.test(cell.f);
      if (external) report.coverage.external_formula_cells += 1;
      if (external && color !== "008000") {
        pushViolation(report, "APROJ-018", "Cross-sheet formula is not green.", { sheet: sheet.name, address, formula: cell.f, color });
      }
      if (!external && color === "008000") {
        pushViolation(report, "APROJ-019", "Green formula does not reference another sheet.", { sheet: sheet.name, address, formula: cell.f });
      }
    }
  }

  const minimumCoverage = {
    geometry_fields: 10,
    control_keys: 10,
    physical_rows: 100,
    row_records: 100,
    semantic_rows: 100,
    semantic_labels: 100,
    style_cells: 2100,
    formula_cells: 100,
    external_formula_cells: 1,
  };
  for (const [field, minimum] of Object.entries(minimumCoverage)) {
    if (report.coverage[field] < minimum) {
      pushViolation(report, "APROJ-020", "Projection proof coverage is vacuous or unexpectedly narrow.", {
        field,
        actual: report.coverage[field],
        minimum,
      });
    }
  }

  report.status = report.violations.length === 0 ? "PASS" : "FAIL";
  report.summary = {
    violations: report.violations.length,
    approved_differences: report.approved_differences.length,
  };
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  for (const required of ["plan", "row-map", "authority-plan"]) {
    if (!options[required]) throw new Error(`Missing --${required}.\n${usage()}`);
  }
  const report = await validateAuthorityProjection({
    plan: options.plan,
    rowMap: options["row-map"],
    authorityPlan: options["authority-plan"],
    contract: options.contract,
    runtime: options.runtime,
    overrides: options.overrides,
  });
  if (options.out) await fs.writeFile(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status}: ${report.profile} authority projection`);
    console.log(`${report.summary?.violations ?? report.violations.length} violation(s); ${report.summary?.approved_differences ?? report.approved_differences.length} approved difference instance(s)`);
    console.log(JSON.stringify(report.coverage));
  }
  if (report.status !== "PASS") process.exitCode = 1;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
