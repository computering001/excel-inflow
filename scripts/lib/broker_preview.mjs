import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  coreConsumptionIds,
  headlineAnchorIds,
  requiredPrimaryHouseIds,
} from "./broker_metric_dictionary.mjs";
import { hashFile, hashValue } from "./run_store.mjs";

export const BROKER_PREVIEW_SCHEMA_VERSION = "broker-preview/1.0";
export const BROKER_PREVIEW_CONFIRMATION_SCHEMA_VERSION =
  "broker-preview-confirmation/1.0";

const SHA256 = /^[a-f0-9]{64}$/;
const PERIODS = Object.freeze([0, 1, 2]);

const finite = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value));

function sameNumber(left, right, tolerance = 1e-8) {
  return finite(left) && finite(right) && Math.abs(Number(left) - Number(right)) <= tolerance;
}

function previewBody(preview) {
  const { preview_sha256: _ignored, ...body } = preview;
  return body;
}

export function brokerPreviewSha256(preview) {
  return hashValue(previewBody(preview));
}

function requireBindings(bindingHashes, values) {
  const defaults = {
    broker_pack_sha256: hashValue(values.brokerPack),
    broker_source_tables_sha256: hashValue(values.sourceTables),
    broker_crosswalk_receipt_sha256: hashValue(values.crosswalkReceipt),
  };
  const result = { ...defaults, ...(bindingHashes ?? {}) };
  for (const [field, value] of Object.entries(result)) {
    if (!SHA256.test(String(value))) {
      throw new Error(`${field} must be a sha256 digest.`);
    }
  }
  return result;
}

function series(house, metricId) {
  const values = house?.estimates?.[metricId];
  return PERIODS.map((index) => finite(values?.[index]) ? Number(values[index]) : null);
}

function complete(house, metricId) {
  return series(house, metricId).every(finite);
}

function globalHeadlineAnchor(brokerPack) {
  const anchors = [...headlineAnchorIds()];
  const order = ["ebit", "adjusted_ebitda"];
  const coverage = Object.fromEntries(anchors.map((metricId) => {
    const byPeriod = PERIODS.map((index) =>
      (brokerPack?.houses ?? []).filter((house) => finite(house?.estimates?.[metricId]?.[index])).length);
    return [metricId, {
      by_period: byPeriod,
      minimum: Math.min(...byPeriod),
      total: byPeriod.reduce((sum, value) => sum + value, 0),
    }];
  }));
  const selected = [...anchors].sort((left, right) =>
    coverage[right].minimum - coverage[left].minimum ||
    coverage[right].total - coverage[left].total ||
    order.indexOf(left) - order.indexOf(right))[0] ?? null;
  return { selected, coverage };
}

function headlineAnchorForHouse(house, globalSelection) {
  const completeAnchors = [...headlineAnchorIds()].filter((metricId) =>
    complete(house, metricId));
  if (completeAnchors.includes(globalSelection)) return globalSelection;
  if (completeAnchors.includes("ebit")) return "ebit";
  return completeAnchors[0] ?? null;
}

function sourceIndex(sourceTables) {
  const houses = new Map();
  const tables = new Map();
  const cells = new Map();
  for (const house of sourceTables?.houses ?? []) {
    houses.set(house.house_id, house);
    for (const table of house.tables ?? []) {
      tables.set(table.table_id, { house, table });
      for (const authority of table.cell_authorities ?? []) {
        cells.set(
          `${table.table_id}|${authority.row}|${authority.column}`,
          authority,
        );
      }
    }
  }
  return { houses, tables, cells };
}

function mappingIndex(receipt) {
  const result = new Map();
  for (const mapping of receipt?.mappings ?? []) {
    const key = `${mapping.house_id}|${mapping.metric_id}|${mapping.period_index}`;
    const list = result.get(key) ?? [];
    list.push(mapping);
    result.set(key, list);
  }
  return result;
}

function sourceCellStatus(index, component) {
  const tableRecord = index.tables.get(component.table_id);
  if (!tableRecord) {
    return { status: "missing_table", selectable: false, table: null };
  }
  const authority = index.cells.get(
    `${component.table_id}|${component.row}|${component.column}`,
  );
  const status = authority?.status ?? "verified_native";
  const analytical =
    (tableRecord.table.workbook_presentation ?? "analytical_table") ===
    "analytical_table";
  return {
    status,
    selectable: analytical && status !== "quarantined_conflict",
    table: tableRecord.table,
    conflict_id: authority?.conflict_id ?? null,
  };
}

function mappingProvenance(mapping, source) {
  const components = (mapping?.components ?? []).map((component) => {
    const cell = sourceCellStatus(source, component);
    return {
      table_id: component.table_id,
      row: component.row,
      column: component.column,
      source_ref: component.source_ref,
      raw_value: component.raw_value,
      coefficient: component.coefficient,
      contribution: component.contribution,
      cell_authority_status: cell.status,
      selectable: cell.selectable,
      ...(cell.conflict_id ? { conflict_id: cell.conflict_id } : {}),
      artifact_link:
        `broker-source-tables.json#table=${encodeURIComponent(component.table_id)}` +
        `&row=${component.row}&column=${component.column}`,
    };
  });
  return {
    mapping_id: mapping?.mapping_id ?? null,
    definition_id: mapping?.definition_id ?? null,
    review_status: mapping?.review_status ?? null,
    rationale: mapping?.rationale ?? null,
    components,
  };
}

function mappedValue({ houseId, metricId, periodIndex, expected, mappings, source }) {
  const key = `${houseId}|${metricId}|${periodIndex}`;
  const candidates = mappings.get(key) ?? [];
  if (candidates.length !== 1) {
    return {
      selectable: false,
      value: Number(expected),
      violation:
        candidates.length === 0
          ? `No provenance mapping exists for ${key}.`
          : `${candidates.length} provenance mappings exist for ${key}; exactly one is required.`,
      provenance: null,
    };
  }
  const mapping = candidates[0];
  const provenance = mappingProvenance(mapping, source);
  if (!sameNumber(mapping.value, expected)) {
    return {
      selectable: false,
      value: Number(expected),
      violation: `Mapped value for ${key} does not equal the sealed broker-pack value.`,
      provenance,
    };
  }
  const rejected = provenance.components.filter((component) => !component.selectable);
  if (rejected.length > 0) {
    return {
      selectable: false,
      value: Number(expected),
      violation:
        `Selected value ${key} depends on non-selectable source cell(s): ` +
        rejected.map((component) =>
          `${component.table_id}!R${component.row}C${component.column} (${component.cell_authority_status})`).join(", "),
      provenance,
    };
  }
  return { selectable: true, value: Number(expected), violation: null, provenance };
}

function alternateValues({ brokerPack, selectedHouseId, metricId, periodIndex, mappings, source }) {
  return (brokerPack?.houses ?? [])
    .filter((house) => house.house_id !== selectedHouseId)
    .filter((house) => finite(house.estimates?.[metricId]?.[periodIndex]))
    .map((house) => {
      const value = Number(house.estimates[metricId][periodIndex]);
      const mapped = mappedValue({
        houseId: house.house_id,
        metricId,
        periodIndex,
        expected: value,
        mappings,
        source,
      });
      return {
        house_id: house.house_id,
        house_name: house.house_name,
        value,
        status: mapped.selectable ? "verified_alternate" : "evidence_only_alternate",
        ...(mapped.provenance ? { provenance: mapped.provenance } : {}),
        ...(mapped.violation ? { reason: mapped.violation } : {}),
      };
    })
    .sort((left, right) => left.house_id.localeCompare(right.house_id));
}

function primaryMetricIds(brokerPack, house, headlineAnchor) {
  const ids = new Set([...requiredPrimaryHouseIds(), headlineAnchor]);
  for (const metricId of coreConsumptionIds()) {
    if (metricId === "share_buybacks" && series(house, metricId).some(finite)) {
      ids.add(metricId);
    }
  }
  return [...ids].sort();
}

function primarySelectionCase({ brokerPack, house, headlineAnchor, mappings, source }) {
  const violations = [];
  const selectedValues = [];
  const fallbackPeriods = [];
  for (const metricId of primaryMetricIds(brokerPack, house, headlineAnchor)) {
    for (const periodIndex of PERIODS) {
      const value = house.estimates?.[metricId]?.[periodIndex];
      if (!finite(value)) {
        fallbackPeriods.push({
          metric_id: metricId,
          period_index: periodIndex,
          period: brokerPack.forecast_periods?.[periodIndex] ?? null,
          reason: "The selected house publishes no clean value; the ordinary forecast waterfall remains in force for this concept-period.",
        });
        continue;
      }
      const mapped = mappedValue({
        houseId: house.house_id,
        metricId,
        periodIndex,
        expected: value,
        mappings,
        source,
      });
      if (mapped.violation) {
        fallbackPeriods.push({
          metric_id: metricId,
          period_index: periodIndex,
          period: brokerPack.forecast_periods?.[periodIndex] ?? null,
          reason: mapped.violation,
          ...(mapped.provenance ? { provenance: mapped.provenance } : {}),
        });
        continue;
      }
      selectedValues.push({
        selection_kind: "primary_house",
        metric_id: metricId,
        period_index: periodIndex,
        period: brokerPack.forecast_periods?.[periodIndex] ?? null,
        house_id: house.house_id,
        house_name: house.house_name,
        value: Number(value),
        selectable: mapped.selectable,
        provenance: mapped.provenance,
        alternates: alternateValues({
          brokerPack,
          selectedHouseId: house.house_id,
          metricId,
          periodIndex,
          mappings,
          source,
        }),
      });
    }
  }
  return {
    house_id: house.house_id,
    house_name: house.house_name,
    pack_eligibility: house.eligibility ?? null,
    headline_anchor: headlineAnchor,
    status: violations.length === 0 ? "PASS" : "BLOCK",
    selected_values: selectedValues,
    selected_value_count: selectedValues.length,
    fallback_periods: fallbackPeriods,
    violations: [...new Set(violations)].sort(),
  };
}

function flexSelections({ brokerPack, mappings, source }) {
  const selections = [];
  const violations = [];
  for (const election of brokerPack?.flex_elections ?? []) {
    const metricId = election.metric_id;
    if (election.basis === "attributed") {
      const house = (brokerPack.houses ?? []).find(
        (candidate) => candidate.house_id === election.source_house_id,
      );
      if (!house || !complete(house, metricId)) {
        violations.push(
          `Attributed flex election ${metricId} lacks one complete declared source house.`,
        );
        continue;
      }
      for (const periodIndex of PERIODS) {
        const value = Number(house.estimates[metricId][periodIndex]);
        const mapped = mappedValue({
          houseId: house.house_id,
          metricId,
          periodIndex,
          expected: value,
          mappings,
          source,
        });
        if (mapped.violation) continue;
        selections.push({
          selection_kind: "attributed_flex",
          metric_id: metricId,
          period_index: periodIndex,
          period: brokerPack.forecast_periods?.[periodIndex] ?? null,
          house_id: house.house_id,
          house_name: house.house_name,
          value,
          selectable: mapped.selectable,
          provenance: mapped.provenance,
          alternates: [],
        });
      }
      continue;
    }
    if (election.basis === "consensus") {
      for (const periodIndex of PERIODS) {
        const contributors = (brokerPack.houses ?? [])
          .filter((house) => finite(house.estimates?.[metricId]?.[periodIndex]))
          .map((house) => {
            const value = Number(house.estimates[metricId][periodIndex]);
            const mapped = mappedValue({
              houseId: house.house_id,
              metricId,
              periodIndex,
              expected: value,
              mappings,
              source,
            });
            return {
              house_id: house.house_id,
              house_name: house.house_name,
              value,
              selectable: mapped.selectable,
              provenance: mapped.provenance,
            };
          });
        const selectableContributors = contributors.filter((item) => item.selectable);
        if (selectableContributors.length < 3) continue;
        selections.push({
          selection_kind: "consensus_flex",
          metric_id: metricId,
          period_index: periodIndex,
          period: brokerPack.forecast_periods?.[periodIndex] ?? null,
          house_id: null,
          house_name: "Named-house mean",
          value:
            selectableContributors.reduce((sum, item) => sum + item.value, 0) /
            selectableContributors.length,
          selectable: true,
          contributors: selectableContributors,
          alternates: [],
        });
      }
    }
  }
  return { selections, violations };
}

function tableInventory(sourceTables) {
  let rawCellCount = 0;
  let quarantinedCellCount = 0;
  let analyticalTableCount = 0;
  let evidenceOnlyTableCount = 0;
  const houses = (sourceTables?.houses ?? []).map((house) => ({
    house_id: house.house_id,
    house_name: house.house_name,
    source_id: house.source_id,
    file_name: house.file_name ?? null,
    content_sha256: house.content_sha256,
    tables: (house.tables ?? []).map((table) => {
      const cellCount = (table.rows ?? []).reduce((sum, row) => sum + row.length, 0);
      const quarantined = (table.cell_authorities ?? []).filter(
        (cell) => cell.status === "quarantined_conflict",
      ).length;
      const presentation = table.workbook_presentation ?? "analytical_table";
      rawCellCount += cellCount;
      quarantinedCellCount += quarantined;
      if (presentation === "analytical_table") analyticalTableCount += 1;
      else evidenceOnlyTableCount += 1;
      return {
        table_id: table.table_id,
        title: table.title ?? null,
        source_location: table.source_location,
        workbook_presentation: presentation,
        row_count: (table.rows ?? []).length,
        cell_count: cellCount,
        quarantined_cell_count: quarantined,
        canonical_table_sha256: hashValue(table),
        artifact_link: `broker-source-tables.json#table=${encodeURIComponent(table.table_id)}`,
      };
    }),
  }));
  const rawTableCount = houses.reduce((sum, house) => sum + house.tables.length, 0);
  return {
    source_artifact: "broker-source-tables.json",
    source_artifact_link: "broker-source-tables.json",
    source_artifact_canonical_sha256: hashValue(sourceTables),
    raw_house_count: houses.length,
    raw_table_count: rawTableCount,
    analytical_table_count: analyticalTableCount,
    evidence_only_table_count: evidenceOnlyTableCount,
    raw_cell_count: rawCellCount,
    quarantined_cell_count: quarantinedCellCount,
    houses,
  };
}

/**
 * Compile the deterministic Stage-2 broker preview from already sealed broker
 * artifacts. No PDF, OCR or model-host call is permitted at this boundary.
 */
export function compileBrokerPreview({
  brokerPack,
  sourceTables,
  crosswalkReceipt,
  bindingHashes = null,
}) {
  const bindings = requireBindings(bindingHashes, {
    brokerPack,
    sourceTables,
    crosswalkReceipt,
  });
  const source = sourceIndex(sourceTables);
  const mappings = mappingIndex(crosswalkReceipt);
  const { selected: headlineAnchor, coverage: headlineCoverage } =
    globalHeadlineAnchor(brokerPack);
  const packPrimary = (brokerPack?.houses ?? []).filter(
    (house) => house.eligibility === "primary_eligible",
  );
  const cases = packPrimary.map((house) =>
    primarySelectionCase({
      brokerPack,
      house,
      headlineAnchor: headlineAnchorForHouse(house, headlineAnchor),
      mappings,
      source,
    }));
  const validCases = cases.filter((candidate) => candidate.status === "PASS");
  const packRecommended = brokerPack?.recommended_primary_house_id ?? null;
  const recommended =
    validCases.find((candidate) => candidate.house_id === packRecommended) ??
    validCases[0] ??
    null;
  const flex = flexSelections({ brokerPack, mappings, source });
  for (const candidate of cases) {
    candidate.selected_values.push(...structuredClone(flex.selections));
    candidate.selected_value_count = candidate.selected_values.length;
    if (flex.violations.length > 0) {
      candidate.status = "BLOCK";
      candidate.violations = [...new Set([...candidate.violations, ...flex.violations])].sort();
    }
  }
  const finalValidCases = cases.filter((candidate) => candidate.status === "PASS");
  const finalRecommended =
    finalValidCases.find((candidate) => candidate.house_id === recommended?.house_id) ??
    null;
  const terminalQuarantineCount = Number(
    crosswalkReceipt?.coverage_summary?.terminal_quarantined_candidate_count ??
    crosswalkReceipt?.terminal_recovery?.quarantined_candidates?.length ??
    0,
  );
  const unresolvedSelectedCandidateCount = Number(
    crosswalkReceipt?.coverage_summary?.unresolved_selected_candidate_count ?? 0,
  );
  const topViolations = [];
  const waterfallReasons = [];
  if (crosswalkReceipt?.status !== "PASS") {
    topViolations.push("The broker crosswalk receipt is not PASS.");
  }
  if (unresolvedSelectedCandidateCount !== 0) {
    topViolations.push(
      `The broker receipt has ${unresolvedSelectedCandidateCount} unresolved model-selected candidate(s).`,
    );
  }
  if (!headlineAnchor) waterfallReasons.push("No broker headline anchor is available.");
  if (packPrimary.length === 0) waterfallReasons.push("The sealed pack has no primary-eligible house.");
  if (!packRecommended) {
    waterfallReasons.push("The sealed pack does not declare recommended_primary_house_id.");
  }
  if (packRecommended && !packPrimary.some((house) => house.house_id === packRecommended)) {
    topViolations.push(
      `Pack-recommended house ${packRecommended} is not primary_eligible.`,
    );
  }
  const declaredEligibility = brokerPack?.eligibility_summary ?? null;
  const actualEligibility = {
    primary_eligible_house_count: packPrimary.length,
    supplemental_eligible_house_count: (brokerPack?.houses ?? []).filter(
      (house) => house.eligibility === "supplemental_eligible",
    ).length,
    reference_only_house_count: (brokerPack?.houses ?? []).filter(
      (house) => house.eligibility === "reference_only",
    ).length,
  };
  if (!declaredEligibility) {
    topViolations.push("The sealed pack does not declare eligibility_summary.");
  } else {
    for (const [field, actual] of Object.entries(actualEligibility)) {
      if (Number(declaredEligibility[field]) !== actual) {
        topViolations.push(
          `Pack eligibility_summary.${field} is stale (declared ${declaredEligibility[field]}, actual ${actual}).`,
        );
      }
    }
    if (
      Boolean(declaredEligibility.run_can_continue_without_broker_question) !==
      true
    ) {
      topViolations.push("Pack eligibility_summary continuation flag is stale.");
    }
  }
  const packHouseIds = (brokerPack?.houses ?? []).map((house) => house.house_id).sort();
  const sourceHouseIds = (sourceTables?.houses ?? []).map((house) => house.house_id).sort();
  if (JSON.stringify(packHouseIds) !== JSON.stringify(sourceHouseIds)) {
    topViolations.push("Broker source-table house inventory does not exactly cover the sealed pack.");
  }
  if (Number(crosswalkReceipt?.mapping_count ?? -1) !== (crosswalkReceipt?.mappings ?? []).length) {
    topViolations.push("Broker crosswalk receipt mapping_count is stale.");
  }
  if (!finalRecommended) {
    waterfallReasons.push("No primary-eligible house has a complete selectable coherent series.");
  }
  if (packRecommended && !finalValidCases.some((item) => item.house_id === packRecommended)) {
    waterfallReasons.push(
      `Pack-recommended house ${packRecommended} is unavailable under the exact provenance gate; another clean house or the forecast waterfall is selected.`,
    );
  }
  const selectionMode = finalRecommended ? "primary_house" : "forecast_waterfall";
  const status = topViolations.length === 0 ? "PASS" : "BLOCK";
  const preview = {
    schema_version: BROKER_PREVIEW_SCHEMA_VERSION,
    status,
    selection_mode: selectionMode,
    ...bindings,
    pack_recommended_primary_house_id: packRecommended,
    recommended_primary_house_id: finalRecommended?.house_id ?? null,
    recommended_primary_house_name: finalRecommended?.house_name ?? null,
    headline_anchor: finalRecommended?.headline_anchor ?? headlineAnchor,
    headline_anchor_coverage: headlineCoverage,
    forecast_periods: structuredClone(brokerPack?.forecast_periods ?? []),
    primary_eligible_house_ids: finalValidCases.map((candidate) => candidate.house_id),
    selection_cases: cases,
    selected_value_count: finalRecommended?.selected_value_count ?? 0,
    evidence_inventory: tableInventory(sourceTables),
    evidence_only_quarantine: {
      terminal_quarantined_candidate_count: terminalQuarantineCount,
      unresolved_selected_candidate_count: unresolvedSelectedCandidateCount,
      unresolved_candidate_count: Number(
        crosswalkReceipt?.coverage_summary?.unresolved_candidate_count ?? 0,
      ),
      quarantined_candidates: structuredClone(
        crosswalkReceipt?.terminal_recovery?.quarantined_candidates ?? [],
      ),
      note:
        "Unselected evidence remains visible and sealed. It cannot be promoted by confirmation.",
    },
    forecast_waterfall_reasons: [...new Set(waterfallReasons)].sort(),
    violations: [...new Set(topViolations)].sort(),
  };
  return Object.freeze({ ...preview, preview_sha256: brokerPreviewSha256(preview) });
}

/**
 * Deterministically disable all broker model authority while preserving the
 * sealed pack and complete source-table inventory. This is the lawful fallback
 * for an optional broker selection/control-plane defect: no value is invented,
 * promoted or silently mixed across houses.
 */
export function compileBrokerForecastWaterfallFallback({
  brokerPack,
  sourceTables,
  crosswalkReceipt,
  bindingHashes = null,
  reasons = [],
}) {
  const bindings = requireBindings(bindingHashes, {
    brokerPack,
    sourceTables,
    crosswalkReceipt,
  });
  const quarantinedCandidates = structuredClone(
    crosswalkReceipt?.terminal_recovery?.quarantined_candidates ?? [],
  );
  const preview = {
    schema_version: BROKER_PREVIEW_SCHEMA_VERSION,
    status: "PASS",
    selection_mode: "forecast_waterfall",
    ...bindings,
    pack_recommended_primary_house_id:
      brokerPack?.recommended_primary_house_id ?? null,
    recommended_primary_house_id: null,
    recommended_primary_house_name: null,
    headline_anchor: null,
    headline_anchor_coverage: {},
    forecast_periods: structuredClone(brokerPack?.forecast_periods ?? []),
    primary_eligible_house_ids: [],
    selection_cases: [],
    selected_value_count: 0,
    evidence_inventory: tableInventory(sourceTables),
    evidence_only_quarantine: {
      terminal_quarantined_candidate_count: Number(
        crosswalkReceipt?.coverage_summary?.terminal_quarantined_candidate_count ??
        quarantinedCandidates.length,
      ),
      unresolved_selected_candidate_count: 0,
      unresolved_candidate_count: Number(
        crosswalkReceipt?.coverage_summary?.unresolved_candidate_count ?? 0,
      ),
      quarantined_candidates: quarantinedCandidates,
      note:
        "Broker model authority is disabled for this run; all supplied reports remain sealed evidence.",
    },
    forecast_waterfall_reasons: [...new Set([
      ...reasons.map((reason) => String(reason)).filter(Boolean),
      "Broker authority was unavailable or failed its optional selection boundary; the ordinary forecast waterfall owns every model state.",
    ])].sort(),
    violations: [],
  };
  return Object.freeze({ ...preview, preview_sha256: brokerPreviewSha256(preview) });
}

/**
 * Last-resort control-plane breaker. Unlike the normal fallback compiler this
 * function does not inspect source tables, candidates or semantic receipts.
 * It can therefore close a preview compiler defect without granting authority
 * to a single broker value. The content hashes still bind the preserved raw
 * evidence products.
 */
export function compileEmergencyZeroBrokerPreview({
  bindingHashes,
  forecastPeriods = [],
  reasons = [],
}) {
  const bindings = requireBindings(bindingHashes, {
    brokerPack: {},
    sourceTables: {},
    crosswalkReceipt: {},
  });
  const preview = {
    schema_version: BROKER_PREVIEW_SCHEMA_VERSION,
    status: "PASS",
    selection_mode: "forecast_waterfall",
    ...bindings,
    pack_recommended_primary_house_id: null,
    recommended_primary_house_id: null,
    recommended_primary_house_name: null,
    headline_anchor: null,
    headline_anchor_coverage: {},
    forecast_periods: structuredClone(forecastPeriods),
    primary_eligible_house_ids: [],
    selection_cases: [],
    selected_value_count: 0,
    evidence_inventory: {
      source_artifact: "broker-source-tables.json",
      source_artifact_link: "broker-source-tables.json",
      source_artifact_canonical_sha256: bindings.broker_source_tables_sha256,
      raw_house_count: 0,
      raw_table_count: 0,
      analytical_table_count: 0,
      evidence_only_table_count: 0,
      raw_cell_count: 0,
      quarantined_cell_count: 0,
      houses: [],
    },
    evidence_only_quarantine: {
      terminal_quarantined_candidate_count: 0,
      unresolved_selected_candidate_count: 0,
      unresolved_candidate_count: 0,
      quarantined_candidates: [],
      note:
        "The broker control plane failed closed to zero authority; raw reports remain preserved outside model authority.",
    },
    forecast_waterfall_reasons: [...new Set([
      ...reasons.map((reason) => String(reason)).filter(Boolean),
      "The emergency optional-broker circuit breaker selected zero broker authority.",
    ])].sort(),
    violations: [],
  };
  return Object.freeze({ ...preview, preview_sha256: brokerPreviewSha256(preview) });
}

export function validateBrokerPreview(preview) {
  const violations = [];
  if (preview?.schema_version !== BROKER_PREVIEW_SCHEMA_VERSION) {
    violations.push("Broker preview schema version is unsupported.");
  }
  if (!["primary_house", "forecast_waterfall"].includes(preview?.selection_mode)) {
    violations.push("Broker preview selection_mode is unsupported.");
  }
  if (preview?.preview_sha256 !== brokerPreviewSha256(preview ?? {})) {
    violations.push("Broker preview hash does not match its canonical contents.");
  }
  for (const field of [
    "broker_pack_sha256",
    "broker_source_tables_sha256",
    "broker_crosswalk_receipt_sha256",
  ]) {
    if (!SHA256.test(String(preview?.[field] ?? ""))) {
      violations.push(`Broker preview ${field} is absent or invalid.`);
    }
  }
  const caseIds = new Set();
  for (const candidate of preview?.selection_cases ?? []) {
    if (caseIds.has(candidate.house_id)) {
      violations.push(`Selection case ${candidate.house_id} is duplicated.`);
    }
    caseIds.add(candidate.house_id);
    if (candidate.status === "PASS" && candidate.pack_eligibility !== "primary_eligible") {
      violations.push(
        `Selection case ${candidate.house_id} is PASS without primary_eligible pack status.`,
      );
    }
    const primaryKeys = new Set();
    for (const selected of candidate.selected_values ?? []) {
      const selectionKey =
        `${selected.selection_kind}|${selected.metric_id}|${selected.period_index}`;
      if (primaryKeys.has(selectionKey)) {
        violations.push(
          `Selection case ${candidate.house_id} duplicates ${selectionKey}.`,
        );
      }
      primaryKeys.add(selectionKey);
      if (
        selected.selection_kind === "primary_house" &&
        (selected.house_id !== candidate.house_id ||
          selected.house_name !== candidate.house_name)
      ) {
        violations.push(
          `${candidate.house_id} mixes a primary value from ${selected.house_id ?? "no house"}.`,
        );
      }
      if (
        ["primary_house", "attributed_flex"].includes(selected.selection_kind) &&
        (!selected.provenance ||
          !Array.isArray(selected.provenance.components) ||
          selected.provenance.components.length === 0)
      ) {
        violations.push(
          `Selection case ${candidate.house_id} lacks exact provenance for ${selectionKey}.`,
        );
      }
      if (selected.selection_kind === "attributed_flex") {
        const peers = (candidate.selected_values ?? []).filter(
          (item) =>
            item.selection_kind === "attributed_flex" &&
            item.metric_id === selected.metric_id,
        );
        if (new Set(peers.map((item) => item.house_id)).size !== 1) {
          violations.push(
            `Attributed flex metric ${selected.metric_id} mixes houses across periods.`,
          );
        }
      }
      if (candidate.status === "PASS" && selected.selectable !== true) {
        violations.push(
          `Selection case ${candidate.house_id} contains a non-selectable ${selected.metric_id} period ${selected.period_index + 1}.`,
        );
      }
      for (const component of selected.provenance?.components ?? []) {
        if (
          candidate.status === "PASS" &&
          (component.selectable !== true ||
            component.cell_authority_status === "quarantined_conflict")
        ) {
          violations.push(
            `Selection case ${candidate.house_id} consumes quarantined or evidence-only cell ${component.table_id}!R${component.row}C${component.column}.`,
          );
        }
      }
    }
    for (const metricId of [...requiredPrimaryHouseIds(), candidate.headline_anchor]) {
      for (const periodIndex of PERIODS) {
        const key = `primary_house|${metricId}|${periodIndex}`;
        const hasFallback = (candidate.fallback_periods ?? []).some(
          (item) => item.metric_id === metricId && item.period_index === periodIndex,
        );
        if (candidate.status === "PASS" && !primaryKeys.has(key) && !hasFallback) {
          violations.push(
            `Selection case ${candidate.house_id} omits required coherent value ${metricId} period ${periodIndex + 1}.`,
          );
        }
      }
    }
    if (candidate.selected_value_count !== (candidate.selected_values ?? []).length) {
      violations.push(`Selection case ${candidate.house_id} selected_value_count is stale.`);
    }
  }
  const passIds = (preview?.selection_cases ?? [])
    .filter((candidate) => candidate.status === "PASS")
    .map((candidate) => candidate.house_id)
    .sort();
  const declaredPassIds = [...(preview?.primary_eligible_house_ids ?? [])].sort();
  if (JSON.stringify(passIds) !== JSON.stringify(declaredPassIds)) {
    violations.push("Broker preview eligible-house list does not equal its PASS selection cases.");
  }
  if (
    preview?.status === "PASS" &&
    preview?.selection_mode === "primary_house" &&
    !caseIds.has(preview?.recommended_primary_house_id)
  ) {
    violations.push("PASS preview does not name a present recommended selection case.");
  }
  if (
    preview?.status === "PASS" &&
    preview?.selection_mode === "forecast_waterfall" &&
    (preview?.recommended_primary_house_id !== null ||
      preview?.selected_value_count !== 0 ||
      (preview?.forecast_waterfall_reasons ?? []).length === 0)
  ) {
    violations.push(
      "Forecast-waterfall preview must select no broker values and disclose why broker authority is unavailable.",
    );
  }
  const recommended = (preview?.selection_cases ?? []).find(
    (candidate) => candidate.house_id === preview?.recommended_primary_house_id,
  );
  if (
    recommended &&
    preview?.selected_value_count !== recommended.selected_value_count
  ) {
    violations.push("Broker preview selected_value_count is stale.");
  }
  if (
    preview?.status === "PASS" &&
    preview?.selection_mode === "primary_house" &&
    Number(preview?.evidence_only_quarantine?.unresolved_selected_candidate_count ?? 0) !== 0
  ) {
    violations.push("PASS preview has unresolved selected broker candidates.");
  }
  return { valid: violations.length === 0, violations: [...new Set(violations)] };
}

export function verifyBrokerPreviewConfirmation(preview, confirmation) {
  const errors = [];
  const previewValidation = validateBrokerPreview(preview);
  errors.push(...previewValidation.violations);
  if (preview?.status !== "PASS") {
    errors.push("A blocked broker preview cannot be confirmed.");
  }
  if (
    confirmation?.schema_version !==
    BROKER_PREVIEW_CONFIRMATION_SCHEMA_VERSION
  ) {
    errors.push("Broker confirmation schema version is unsupported.");
  }
  const confirmationKeys = Object.keys(confirmation ?? {}).sort();
  const expectedConfirmationKeys = [
    "confirmed",
    "preview_sha256",
    "schema_version",
    "selected_house_id",
  ].sort();
  if (
    JSON.stringify(confirmationKeys) !==
    JSON.stringify(expectedConfirmationKeys)
  ) {
    errors.push(
      "Broker confirmation may contain only schema_version, preview_sha256, selected_house_id and confirmed.",
    );
  }
  if (confirmation?.confirmed !== true) {
    errors.push("Broker confirmation must explicitly set confirmed=true.");
  }
  if (confirmation?.preview_sha256 !== preview?.preview_sha256) {
    errors.push("Broker confirmation is stale: preview_sha256 does not match.");
  }
  const waterfall = preview?.selection_mode === "forecast_waterfall";
  const selected = waterfall
    ? confirmation?.selected_house_id === "FORECAST_WATERFALL"
      ? {
          house_id: "FORECAST_WATERFALL",
          house_name: "Forecast Waterfall",
          status: "PASS",
          selected_values: [],
        }
      : null
    : (preview?.selection_cases ?? []).find(
        (candidate) => candidate.house_id === confirmation?.selected_house_id,
      );
  if (!selected || selected.status !== "PASS") {
    errors.push(
      waterfall
        ? "Broker confirmation must select FORECAST_WATERFALL."
        : "Broker confirmation does not select a primary-eligible PASS house.",
    );
  }
  if (
    selected &&
    !waterfall &&
    !(preview?.primary_eligible_house_ids ?? []).includes(selected.house_id)
  ) {
    errors.push("Selected broker house is not in the preview's eligible set.");
  }
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    selection: errors.length === 0 ? selected : null,
  };
}

export function automaticBrokerPreviewConfirmation(preview) {
  const validation = validateBrokerPreview(preview);
  if (preview?.status !== "PASS" || !validation.valid) return null;
  return {
    schema_version: BROKER_PREVIEW_CONFIRMATION_SCHEMA_VERSION,
    preview_sha256: preview.preview_sha256,
    selected_house_id:
      preview.recommended_primary_house_id ?? "FORECAST_WATERFALL",
    confirmed: true,
  };
}

/**
 * Project a sealed broker selection into compiler evidence without destroying
 * the immutable source lane.  A whole-pack waterfall suppresses every broker
 * observation.  A named-house selection suppresses only the exact
 * concept-periods which the preview proved unavailable or quarantined; every
 * other clean period from that same house remains usable.
 */
export function applyBrokerPreviewSelectionToCaseEvidence(
  caseEvidence,
  preview,
  confirmation,
) {
  const verified = verifyBrokerPreviewConfirmation(preview, confirmation);
  if (!verified.valid) {
    throw new Error(`Broker confirmation is invalid: ${verified.errors.join("; ")}`);
  }
  const projected = structuredClone(caseEvidence);
  projected.lanes = projected.lanes ?? {};
  projected.lanes.controls = {
    ...(projected.lanes.controls ?? {}),
    broker_case: verified.selection.house_name,
  };
  const brokerPack = projected.lanes.broker_pack ?? {};
  const metrics = brokerPack.metrics ?? {};
  let suppressedObservationCount = 0;
  if (verified.selection.house_id === "FORECAST_WATERFALL") {
    brokerPack.metrics = Object.fromEntries(
      Object.entries(metrics).map(([metricId, metric]) => [
        metricId,
        {
          ...metric,
          provider_consensus: [null, null, null],
          brokers: Object.fromEntries(
            Object.keys(metric.brokers ?? {}).map((houseName) => {
              suppressedObservationCount += (metric.brokers?.[houseName] ?? [])
                .filter((value) => value !== null && value !== undefined).length;
              return [houseName, [null, null, null]];
            }),
          ),
        },
      ]),
    );
  } else {
    for (const fallback of verified.selection.fallback_periods ?? []) {
      const metric = metrics[fallback.metric_id];
      const houseSeries = metric?.brokers?.[verified.selection.house_name];
      if (!Array.isArray(houseSeries) || houseSeries.length !== 3) {
        throw new Error(
          `Broker evidence cannot quarantine ${verified.selection.house_name} ` +
          `${fallback.metric_id} period ${fallback.period_index + 1}: the exact series is absent.`,
        );
      }
      if (houseSeries[fallback.period_index] !== null &&
          houseSeries[fallback.period_index] !== undefined) {
        suppressedObservationCount += 1;
      }
      houseSeries[fallback.period_index] = null;
    }
    brokerPack.metrics = metrics;
  }
  projected.lanes.broker_pack = brokerPack;
  return {
    case_evidence: projected,
    selection: verified.selection,
    suppressed_observation_count: suppressedObservationCount,
  };
}

/** Remove every broker writer while preserving the broker evidence lane. */
export function projectZeroBrokerAuthorityCaseEvidence(caseEvidence) {
  const projected = structuredClone(caseEvidence);
  projected.lanes = projected.lanes ?? {};
  projected.lanes.controls = {
    ...(projected.lanes.controls ?? {}),
    broker_case: "Forecast Waterfall",
  };
  const brokerPack = projected.lanes.broker_pack;
  let suppressedObservationCount = 0;
  if (brokerPack && typeof brokerPack === "object") {
    brokerPack.recommended_primary_house_id = null;
    brokerPack.metrics = Object.fromEntries(
      Object.entries(brokerPack.metrics ?? {}).map(([metricId, metric]) => [
        metricId,
        {
          ...metric,
          provider_consensus: [null, null, null],
          brokers: Object.fromEntries(
            Object.entries(metric.brokers ?? {}).map(([houseName, series]) => {
              suppressedObservationCount += (series ?? []).filter(
                (value) => value !== null && value !== undefined,
              ).length;
              return [houseName, [null, null, null]];
            }),
          ),
        },
      ]),
    );
    brokerPack.source_mappings = [];
    brokerPack.selected_observations = [];
  }
  for (const ledger of [
    projected.forecast_observation_ledger,
    projected.lanes.forecast_observation_ledger,
  ]) {
    if (Array.isArray(ledger?.observations)) {
      ledger.observations = ledger.observations.filter(
        (observation) =>
          !String(observation?.source_kind ?? observation?.evidence_kind ?? "")
            .toLowerCase()
            .includes("broker"),
      );
    }
  }
  return {
    case_evidence: projected,
    selection: {
      house_id: "FORECAST_WATERFALL",
      house_name: "Forecast Waterfall",
      status: "PASS",
      selected_values: [],
    },
    suppressed_observation_count: suppressedObservationCount,
  };
}

export function applyBrokerPreviewSelection(modelCase, preview, confirmation) {
  const verified = verifyBrokerPreviewConfirmation(preview, confirmation);
  if (!verified.valid) {
    throw new Error(`Broker confirmation is invalid: ${verified.errors.join("; ")}`);
  }
  modelCase.controls = {
    ...(modelCase.controls ?? {}),
    broker_case: verified.selection.house_name,
  };
  if (verified.selection.house_id === "FORECAST_WATERFALL") {
    for (const section of ["income_statement", "cash_flow"]) {
      for (const row of modelCase.statement_structure?.[section] ?? []) {
        delete row.broker_metric_id;
        if (row.forecast_treatment === "broker") {
          delete row.forecast_treatment;
        }
      }
    }
  }
  modelCase.stage_three_answers = {
    ...(modelCase.stage_three_answers ?? {}),
    "broker.primary_house": verified.selection.house_id,
    "broker.preview_sha256": preview.preview_sha256,
  };
  return modelCase;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${token} requires a value.`);
    }
    result[token.slice(2)] = next;
    index += 1;
  }
  return result;
}

async function readJson(target, label) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(target), "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

export async function compileBrokerPreviewFromFiles({
  brokerPackPath,
  sourceTablesPath,
  crosswalkReceiptPath,
}) {
  const [brokerPack, sourceTables, crosswalkReceipt] = await Promise.all([
    readJson(brokerPackPath, "broker pack"),
    readJson(sourceTablesPath, "broker source tables"),
    readJson(crosswalkReceiptPath, "broker crosswalk receipt"),
  ]);
  return compileBrokerPreview({
    brokerPack,
    sourceTables,
    crosswalkReceipt,
    bindingHashes: {
      broker_pack_sha256: await hashFile(path.resolve(brokerPackPath)),
      broker_source_tables_sha256: await hashFile(path.resolve(sourceTablesPath)),
      broker_crosswalk_receipt_sha256: await hashFile(
        path.resolve(crosswalkReceiptPath),
      ),
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const field of ["broker-pack", "source-tables", "receipt", "out"]) {
    if (!args[field]) throw new Error(`--${field} is required.`);
  }
  const preview = await compileBrokerPreviewFromFiles({
    brokerPackPath: args["broker-pack"],
    sourceTablesPath: args["source-tables"],
    crosswalkReceiptPath: args.receipt,
  });
  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(path.resolve(args.out), `${JSON.stringify(preview, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: preview.status,
    preview_sha256: preview.preview_sha256,
    artifact: path.resolve(args.out),
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
