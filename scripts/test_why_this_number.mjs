#!/usr/bin/env node
/**
 * Inline test for the why-this-number digest builder.
 *
 * Run: node scripts/test_why_this_number.mjs
 */

import assert from "node:assert/strict";
import { buildWhyThisNumber } from "./lib/why_this_number.mjs";

// Minimal synthetic selected-authority contract: two rows x two forecast
// periods, one header-only plan row, plus unknown extra fields everywhere.
const syntheticContract = {
  schema_version: "selected-authority-contract/1.0",
  case_id: "synthetic-case",
  product_constitution_sha256: "a".repeat(64),
  quality_mode: "VERIFIED",
  quarantines: [],
  counts: { authorities: 4, quarantines: 0 },
  // Unknown top-level field — must be tolerated.
  future_field: { anything: true },
  authorities: [
    {
      node_id: "row-b-fy27",
      method: "historical_trend",
      status: "SELECTED",
      selected_candidate_id: "cand-b-1",
      selected_state: {
        state_id: "row-b-fy27-state",
        row_id: "row-b",
        section: "cash_flow",
        forecast_index: 0,
        period_end: "2027-12-31",
        method: "historical_trend",
        value: 110,
        source_bindings: ["src-b-2026"],
        status: "RESOLVED",
        // Unknown state field — tolerated.
        novel_ranking: "xyz",
      },
      selected_candidate: { candidate_id: "cand-b-1" },
      source_bindings: ["src-b-2026"],
      fallback_trace: [],
      producer_witness: {
        producer_kind: "compiler",
        producer_id: "historical_trend",
        executable: true,
        reason: null,
      },
    },
    {
      node_id: "row-b-fy28",
      method: "declared_schedule",
      status: "SELECTED",
      selected_state: {
        row_id: "row-b",
        forecast_index: 1,
        period_end: "2028-12-31",
        method: "declared_schedule",
        source_bindings: ["src-b-schedule", "src-b-2026"],
      },
      source_bindings: ["src-b-schedule"],
      producer_witness: {
        producer_kind: "schedule",
        producer_id: "schedule-b",
        executable: true,
        reason: null,
      },
    },
    {
      node_id: "row-a-fy27",
      method: "broker_anchor",
      status: "SELECTED",
      selected_state: {
        row_id: "row-a",
        forecast_index: 0,
        period_end: "2027-12-31",
        method: "broker_anchor",
        source_bindings: ["obs-a-anchor"],
        confidence_score: 0.9,
      },
      source_bindings: ["obs-a-anchor"],
      producer_witness: {
        producer_kind: "broker",
        producer_id: "obs-a-anchor",
        executable: true,
        reason: null,
      },
    },
    {
      node_id: "row-a-fy28",
      method: "unresolved",
      status: "INPUT_REQUIRED",
      selected_state: {
        row_id: "row-a",
        forecast_index: 1,
        period_end: "2028-12-31",
        method: "unresolved",
        source_bindings: [],
      },
      source_bindings: [],
      producer_witness: {
        producer_kind: "compiler",
        producer_id: null,
        executable: false,
        reason: "no evidence",
      },
    },
  ],
};

const rowPlan = {
  statement_rows: {
    income_statement: [{ row_id: "row-header", row_type: "header", row: 4 }],
    cash_flow: [
      { row_id: "row-a", row_type: "input", row: 10 },
      { row_id: "row-b", row_type: "input", row: 11 },
    ],
  },
};

const digest = buildWhyThisNumber({ rowPlan, authorityContract: syntheticContract });

// 1. Two rows, plan order, headers skipped.
assert.equal(digest.length, 2, `expected 2 rows, got ${digest.length}`);
assert.deepEqual(
  digest.map((row) => row.row_id),
  ["row-a", "row-b"],
  "rows must follow plan order",
);

// 2. Each row carries two periods in forecast_index order.
for (const row of digest) {
  assert.equal(row.periods.length, 2, `${row.row_id}: expected 2 periods`);
  assert.deepEqual(
    row.periods.map((p) => p.period),
    ["2027-12-31", "2028-12-31"],
    `${row.row_id}: periods must be forecast-index ordered`,
  );
}

// 3. Rung + source extraction.
assert.deepEqual(
  digest[0].periods.map((p) => p.rung),
  ["broker_anchor", "unresolved"],
);
assert.equal(digest[0].periods[0].source_id, "obs-a-anchor");
// Empty state bindings fall back to authority bindings, then producer id.
assert.equal(digest[1].periods[0].source_id, "src-b-2026");
assert.equal(digest[1].periods[1].source_id, "src-b-schedule");

// 4. confidence_score only when the contract states a number.
assert.equal(digest[0].periods[0].confidence_score, 0.9);
assert.ok(
  !("confidence_score" in digest[0].periods[1]),
  "no confidence_score without a stated number",
);
assert.ok(
  !("confidence_score" in digest[1].periods[0]),
  "no confidence_score without a stated number",
);

// 5. Unknown-field tolerance: novel fields did not break extraction (reached
// here) and are not copied into the digest.
assert.deepEqual(
  Object.keys(digest[0].periods[0]).sort(),
  ["confidence_score", "period", "rung", "source_id"],
);

// 6. Null plan tolerated: contract order governs.
const noPlan = buildWhyThisNumber({
  rowPlan: null,
  authorityContract: syntheticContract,
});
assert.deepEqual(
  noPlan.map((row) => row.row_id),
  ["row-b", "row-a"],
  "without a plan, contract order governs",
);

// 7. Schema-version mismatch fails loudly.
assert.throws(
  () => buildWhyThisNumber({
    rowPlan,
    authorityContract: { ...syntheticContract, schema_version: "other/9.9" },
  }),
  /Unsupported contract schema/,
);

console.log("PASS scripts/test_why_this_number.mjs — 7 assertions");
