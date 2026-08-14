#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  causalFindingDisposition,
  PRODUCT_CONSTITUTION_SHA256,
} from "./lib/run_constitution_graph.mjs";
import {
  compileBrokerForecastWaterfallFallback,
  validateBrokerPreview,
} from "./lib/broker_preview.mjs";
import { assertDeliveryBlocker } from "./lib/workflow_state.mjs";

const product = JSON.parse(
  await fs.readFile(new URL("../assets/product-constitution-v1.json", import.meta.url), "utf8"),
);
assert.equal(PRODUCT_CONSTITUTION_SHA256.length, 64);
assert.deepEqual(product.visible_milestones, [
  "company", "filings", "brokers", "debt", "build", "deliver",
]);
assert.equal(product.evidence_lanes.broker.criticality, "optional");
assert.equal(product.evidence_lanes.broker.full_document_semantic_closure_required, false);

const causalMatrix = [
  [{ unresolved: false, reachable_to_material_output: true, alternative_authority_path: false }, "LOG"],
  [{ unresolved: true, reachable_to_material_output: false, alternative_authority_path: false }, "LOG"],
  [{ unresolved: true, reachable_to_material_output: true, alternative_authority_path: true }, "DEGRADE"],
  [{ unresolved: true, reachable_to_material_output: true, alternative_authority_path: false, user_resolvable: true }, "ASK_ONCE"],
  [{ unresolved: true, reachable_to_material_output: true, alternative_authority_path: false }, "BLOCK"],
];
for (const [input, expected] of causalMatrix) {
  assert.equal(causalFindingDisposition(input), expected);
}

const fallback = compileBrokerForecastWaterfallFallback({
  brokerPack: {
    schema_version: "broker-pack/1.0",
    forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
    houses: [],
  },
  sourceTables: {
    schema_version: "broker-source-tables/1.0",
    run_id: "product-constitution-test",
    houses: [],
  },
  crosswalkReceipt: {
    schema_version: "broker-crosswalk-receipt/1.2",
    status: "PASS",
    coverage_summary: {
      unresolved_candidate_count: 12,
      unresolved_selected_candidate_count: 12,
      terminal_quarantined_candidate_count: 12,
    },
    terminal_recovery: { quarantined_candidates: [] },
  },
  reasons: ["Adversarial optional-lane failure."],
});
assert.equal(validateBrokerPreview(fallback).valid, true);
assert.equal(fallback.selection_mode, "forecast_waterfall");
assert.equal(fallback.selected_value_count, 0);
assert.equal(fallback.evidence_only_quarantine.unresolved_selected_candidate_count, 0);

for (const domain of [
  "broker_capture",
  "broker_table_reconciliation",
  "broker_semantics",
  "broker_coverage",
]) {
  assert.throws(
    () => assertDeliveryBlocker({ blocked: true, fatalReason: "workbook_delivery_failed", domain }),
  );
}

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  product_constitution_sha256: PRODUCT_CONSTITUTION_SHA256,
  causal_matrix_checks: causalMatrix.length,
  broker_delivery_block_mutations: 4,
  zero_broker_fallback: "PASS",
  total_violations: 0,
}, null, 2)}\n`);
