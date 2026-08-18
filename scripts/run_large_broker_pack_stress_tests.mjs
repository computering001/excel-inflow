#!/usr/bin/env node
import assert from "node:assert/strict";

import { compileBrokerPreview, validateBrokerPreview } from "./lib/broker_preview.mjs";

const HOUSE_COUNT = 40;
const periods = ["2026-12-31", "2027-12-31", "2028-12-31"];
const concepts = [
  ["revenue", "Revenue", 1200],
  ["ebit", "EBIT", 240],
  ["depreciation_and_amortisation", "D&A", 75],
  ["effective_tax_rate", "Tax rate", 0.2],
  ["capex", "Capex", -100],
  ["change_in_working_capital", "Change in working capital", -20],
  ["dividends", "Dividends", -80],
];
const houses = Array.from({ length: HOUSE_COUNT }, (_, houseIndex) => {
  const houseId = `stress_house_${String(houseIndex + 1).padStart(2, "0")}`;
  const estimates = Object.fromEntries(concepts.map(([metricId, _label, base]) => [
    metricId,
    periods.map((_period, periodIndex) => Number((base * (1 + houseIndex / 1000 + periodIndex / 100)).toFixed(6))),
  ]));
  return {
    house_id: houseId,
    house_name: `Stress House ${houseIndex + 1}`,
    published_date: "2026-08-18",
    document: {
      file_name: `${houseId}.pdf`,
      media_type: "application/pdf",
      text_extractable: true,
      extraction_method: "native_pdf_table",
      extraction_evidence_sha256: String((houseIndex % 9) + 1).repeat(64),
      page_reference: "large-pack stress fixture",
    },
    estimates,
    eligibility: "primary_eligible",
    missing_primary_metrics: [],
  };
});
const sourceTables = {
  schema_version: "broker-source-tables/1.0",
  run_id: "large-broker-pack-stress",
  houses: houses.map((house, houseIndex) => ({
    house_id: house.house_id,
    house_name: house.house_name,
    source_id: `source.${house.house_id}`,
    content_sha256: String(((houseIndex + 4) % 9) + 1).repeat(64),
    published_date: house.published_date,
    file_name: house.document.file_name,
    tables: Array.from({ length: 5 }, (_, tableIndex) => ({
      table_id: `${house.house_id}.p${tableIndex + 1}.t1`,
      title: tableIndex === 0 ? "Forecast summary" : `Supplemental table ${tableIndex}`,
      source_location: `page ${tableIndex + 1}, table 1`,
      units: tableIndex === 0 ? "USD millions except tax rate" : "reference only",
      extraction_method: "native_pdf_table",
      workbook_presentation: tableIndex === 0 ? "analytical_table" : "evidence_only",
      rows: tableIndex === 0
        ? [["Metric", "FY26", "FY27", "FY28"], ...concepts.map(([metricId, label]) => [label, ...house.estimates[metricId]])]
        : [["Reference", "Value"], [`Supplemental ${tableIndex}`, tableIndex + houseIndex]],
    })),
  })),
};
const mappings = houses.flatMap((house) => concepts.flatMap(([metricId], metricIndex) =>
  periods.map((_period, periodIndex) => {
    const value = house.estimates[metricId][periodIndex];
    return {
      mapping_id: `m.${house.house_id}.${metricId}.${periodIndex}`,
      house_id: house.house_id,
      metric_id: metricId,
      definition_id: `metric.${metricId}`,
      period_index: periodIndex,
      components: [{
        table_id: `${house.house_id}.p1.t1`,
        row: metricIndex + 2,
        column: periodIndex + 2,
        source_ref: `${house.document.file_name}#page=1;table=1;r=${metricIndex + 2};c=${periodIndex + 2}`,
        raw_value: value,
        coefficient: 1,
        contribution: value,
      }],
      constant: 0,
      multiplier: 1,
      value,
      rationale: "Direct large-pack stress observation.",
      review_status: "auto_exact",
    };
  })));
const brokerPack = {
  schema_version: "broker-pack/1.0",
  forecast_periods: periods,
  houses,
  flex_elections: [],
  recommended_primary_house_id: houses[0].house_id,
  eligibility_summary: {
    primary_eligible_house_count: HOUSE_COUNT,
    supplemental_eligible_house_count: 0,
    reference_only_house_count: 0,
    run_can_continue_without_broker_question: true,
  },
};
const receipt = {
  schema_version: "broker-crosswalk-receipt/1.2",
  status: "PASS",
  mapping_count: mappings.length,
  mappings,
  coverage_summary: {
    unresolved_candidate_count: 0,
    unresolved_selected_candidate_count: 0,
    terminal_quarantined_candidate_count: 0,
  },
};

const started = performance.now();
const first = compileBrokerPreview({ brokerPack, sourceTables, crosswalkReceipt: receipt });
const durationMs = performance.now() - started;
const second = compileBrokerPreview({ brokerPack, sourceTables, crosswalkReceipt: receipt });
assert.equal(first.status, "PASS", JSON.stringify(first.violations));
assert.equal(validateBrokerPreview(first).valid, true, JSON.stringify(validateBrokerPreview(first).violations));
assert.equal(first.preview_sha256, second.preview_sha256);
assert.equal(first.evidence_inventory.raw_house_count, HOUSE_COUNT);
assert.equal(first.evidence_inventory.raw_table_count, HOUSE_COUNT * 5);
assert.equal(first.selection_cases.length, HOUSE_COUNT);
assert.ok(durationMs < 30_000, `large broker preview exceeded bounded portable budget: ${durationMs}ms`);

const mutatedReceipt = structuredClone(receipt);
mutatedReceipt.mappings.shift();
mutatedReceipt.mapping_count -= 1;
const mutated = compileBrokerPreview({ brokerPack, sourceTables, crosswalkReceipt: mutatedReceipt });
assert.equal(mutated.status, "PASS", "one bad observation should fall back without blocking the large pack");
assert.equal(validateBrokerPreview(mutated).valid, true);
const cleanSelection = first.selection_cases.find((entry) => entry.house_id === houses[0].house_id);
const mutatedSelection = mutated.selection_cases.find((entry) => entry.house_id === houses[0].house_id);
assert.equal(mutatedSelection.selected_value_count, cleanSelection.selected_value_count - 1);
assert.ok(mutatedSelection.fallback_periods.some((entry) => /No provenance mapping/.test(entry.reason)));

console.log(JSON.stringify({
  status: "PASS",
  houses: HOUSE_COUNT,
  source_tables: HOUSE_COUNT * 5,
  selected_observations: mappings.length,
  duration_ms: Number(durationMs.toFixed(3)),
  deterministic: true,
  mutations_safely_contained: 1,
  violations: 0,
}, null, 2));
