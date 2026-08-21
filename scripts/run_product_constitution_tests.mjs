#!/usr/bin/env node

import fs from "node:fs/promises";

import { createRunner } from "./lib/test_harness.mjs";
import {
  causalFindingDisposition,
  PRODUCT_CONSTITUTION_SHA256,
} from "./lib/run_constitution_graph.mjs";
import {
  compileBrokerForecastWaterfallFallback,
  validateBrokerPreview,
} from "./lib/broker_preview.mjs";
import { assertDeliveryBlocker } from "./lib/workflow_state.mjs";

const run = createRunner({
  name: "product_constitution_tests",
  importMetaUrl: import.meta.url,
});

const product = JSON.parse(
  await fs.readFile(new URL("../assets/product-constitution-v1.json", import.meta.url), "utf8"),
);
run.check("product constitution sha is a sha256", () => PRODUCT_CONSTITUTION_SHA256.length === 64);
run.eq(product.visible_milestones, [
  "company", "filings", "brokers", "debt", "build", "deliver",
], "visible milestones");
run.check("broker lane is optional", () => product.evidence_lanes.broker.criticality === "optional");
run.check("broker lane needs no full-document semantic closure", () => product.evidence_lanes.broker.full_document_semantic_closure_required === false);
run.check("visible intake checkpoint required", () => product.broker_rules.visible_intake_checkpoint_required === true);
run.check("zero files does not imply skip", () => product.broker_rules.zero_files_implies_skip === false);
run.eq(product.broker_rules.valid_intake_states_before_debt, [
  "supplied", "explicitly_skipped",
], "valid intake states before debt");
run.eq(product.broker_rules.explicit_skip_phrase, "continue without brokers", "explicit skip phrase");

const causalMatrix = [
  [{ unresolved: false, reachable_to_material_output: true, alternative_authority_path: false }, "LOG"],
  [{ unresolved: true, reachable_to_material_output: false, alternative_authority_path: false }, "LOG"],
  [{ unresolved: true, reachable_to_material_output: true, alternative_authority_path: true }, "DEGRADE"],
  [{ unresolved: true, reachable_to_material_output: true, alternative_authority_path: false, user_resolvable: true }, "ASK_ONCE"],
  [{ unresolved: true, reachable_to_material_output: true, alternative_authority_path: false }, "BLOCK"],
];
for (const [input, expected] of causalMatrix) {
  run.eq(causalFindingDisposition(input), expected, `causal disposition ${expected}`);
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
run.check("zero-broker fallback preview validates", () => validateBrokerPreview(fallback).valid === true);
run.eq(fallback.selection_mode, "forecast_waterfall", "fallback selection mode");
run.eq(fallback.selected_value_count, 0, "zero-broker fallback selects no values");
run.eq(fallback.evidence_only_quarantine.unresolved_selected_candidate_count, 0, "quarantine count");

for (const domain of [
  "broker_capture",
  "broker_table_reconciliation",
  "broker_semantics",
  "broker_coverage",
]) {
  run.check(`delivery blocker rejects domain ${domain}`, () => {
    try {
      assertDeliveryBlocker({ blocked: true, fatalReason: "workbook_delivery_failed", domain });
      return false;
    } catch {
      return true;
    }
  });
}

run.finish({
  product_constitution_sha256: PRODUCT_CONSTITUTION_SHA256,
  causal_matrix_checks: causalMatrix.length,
  broker_delivery_block_mutations: 4,
  zero_broker_fallback: "PASS",
  total_violations: 0,
});
