#!/usr/bin/env node
// P3.6a — proofs for the two proven latent row/node-identity defects.
//
// Defect 1 (J9): semantic_graph joined instruments to debt/interest group
// subtotal nodes by NORMALISING THE HUMAN LABEL (display_group). The
// unclassified-review group's label "Unclassified — review required"
// normalises to `unclassified_review_required`, which is not the group key
// `unclassified_review`, and link() silently dropped the edge — every
// instrument in that group lost its subtotal edges with no violation.
//
// Defect 2 (S6): row_plan rows_by_id had 26 mint sites and only the statement
// allocator guarded duplicates. The interest-schedule mint silently overwrote
// the statement row `cash_interest_paid` (masked by the statement-first
// fallback at build_dynamic_model.mjs:1251-1258); a NEW collision would be
// silently masked the same way with no consumer-side protection.
//
// This suite was written RED against the pre-repair tree (constitution:
// failing proof first) and now pins the repaired behaviour.

import fs from "node:fs";
import {
  compileRowPlan,
  DEBT_PRESENTATION_GROUPS,
  KNOWN_ROW_ID_COLLISIONS,
} from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import { compileInstrumentPeriodState } from "./lib/instrument_period_state.mjs";

let checks = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}
// Honest mutation accounting: each mutation() below applies a real defect to
// a COPY of a compiled artefact (or mints an unlawful row) and is counted
// CAUGHT only when production throws while the mutant is active. A surviving
// mutant throws out of the suite, which exits non-zero without a count line.
let mutations_total = 0;
let mutations_caught = 0;
function mutation(fn) {
  mutations_total += 1;
  fn();
  mutations_caught += 1;
}

const FIXTURES = new URL("../test-fixtures/cases/", import.meta.url);
function loadCase(name) {
  return JSON.parse(fs.readFileSync(new URL(name, FIXTURES), "utf8"));
}

// ---------------------------------------------------------------------------
// Defect 1 — instrument in the unclassified-review group keeps subtotal edges.
// ---------------------------------------------------------------------------
{
  const modelCase = loadCase("standard-maximal-v2.json");
  // Contract-v2 instrument period state rejects `unclassified`, so compile the
  // state from the untouched case, THEN place one instrument in the review
  // group. The presentation grouping is exactly what the defect exercises.
  const instrumentPeriodState = compileInstrumentPeriodState(modelCase);
  const instrument = modelCase.instruments.find(
    (candidate) => candidate.instrument_id === "smc_other_debt_pool",
  );
  assert(instrument, "Fixture must contain smc_other_debt_pool.");
  instrument.class = "unclassified";
  const rowPlan = compileRowPlan(modelCase, { instrumentPeriodState });

  const plan = rowPlan.instruments.find(
    (candidate) => candidate.instrument_id === "smc_other_debt_pool",
  );
  assert(
    plan.display_group === "Unclassified — review required",
    "Label text must be untouched by the repair.",
  );
  assert(
    plan.display_group_key === "unclassified_review",
    "Instrument plan must carry the GROUP KEY alongside the label.",
  );
  const reviewGroup = DEBT_PRESENTATION_GROUPS.find(
    (group) => group.key === "unclassified_review",
  );
  assert(
    reviewGroup?.label === "Unclassified — review required",
    "DEBT_PRESENTATION_GROUPS label must be untouched by the repair.",
  );

  const manifest = compileSemanticManifest(modelCase, rowPlan, {
    instrumentPeriodState,
  });
  assert(
    manifest.nodes.some(
      (node) => node.node_id === "debt_group.unclassified_review.subtotal",
    ),
    "The unclassified-review debt group subtotal node must exist.",
  );
  const balanceNode = manifest.nodes.find(
    (node) => node.node_id === "instrument.smc_other_debt_pool.balance",
  );
  assert(
    balanceNode?.display_group_key === "unclassified_review",
    "Instrument node must carry display_group_key.",
  );
  assert(
    balanceNode?.display_group === "Unclassified — review required",
    "Instrument node must keep the human label unchanged.",
  );
  const hasEdge = (from, to) =>
    manifest.edges.some(
      (edge) =>
        edge.edge_type === "depends_on" && edge.from === from && edge.to === to,
    );
  assert(
    hasEdge(
      "debt_group.unclassified_review.subtotal",
      "instrument.smc_other_debt_pool.balance",
    ),
    "Unclassified-review instrument lost its debt-group subtotal edge (J9).",
  );
  assert(
    hasEdge(
      "interest_group.unclassified_review.subtotal",
      "instrument.smc_other_debt_pool.interest",
    ),
    "Unclassified-review instrument lost its interest-group subtotal edge (J9).",
  );
  // Regression: an ordinary group keeps its edges under the key join.
  assert(
    hasEdge(
      "debt_group.bonds.subtotal",
      "instrument.smc_usd_bond_2029.balance",
    ),
    "Bonds-group instrument must keep its subtotal edge.",
  );

  // MUTATION — a group node absent from the manifest must be a TYPED
  // violation, never a silently dropped edge.
  mutation(() => {
    const tampered = structuredClone(rowPlan);
    for (const candidate of tampered.instruments) {
      if (candidate.instrument_id === "smc_other_debt_pool") {
        candidate.display_group_key = "group_that_was_never_minted";
      }
    }
    let violation = null;
    try {
      compileSemanticManifest(modelCase, tampered, { instrumentPeriodState });
    } catch (error) {
      violation = error;
    }
    assert(
      violation,
      "Absent group subtotal node must surface a violation, not a silent drop.",
    );
    assert(
      violation.violation_code === "ECONOMIC_GRAPH_GROUP_NODE_ABSENT" &&
        String(violation.message).includes("ECONOMIC_GRAPH_GROUP_NODE_ABSENT"),
      `Group-node violation must be typed ECONOMIC_GRAPH_GROUP_NODE_ABSENT, got: ${violation.message}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Defect 2 — rows_by_id duplicate mints throw unless explicitly known-lawful.
// ---------------------------------------------------------------------------
{
  assert(
    Array.isArray(KNOWN_ROW_ID_COLLISIONS) &&
      KNOWN_ROW_ID_COLLISIONS.includes("cash_interest_paid"),
    "KNOWN_ROW_ID_COLLISIONS must be exported and include cash_interest_paid.",
  );

  // MUTATION — a NEW collision must throw at plan compile time.
  mutation(() => {
    const colliding = loadCase("standard-maximal-v2.json");
    colliding.statement_structure.cash_flow.push({
      row_id: "minimum_cash",
      label: "Synthetic colliding memo row",
      row_type: "input",
      style_role: "line",
    });
    let thrown = null;
    try {
      compileRowPlan(colliding);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown,
      "A new rows_by_id collision (statement minimum_cash vs waterfall mint) must throw at compile time (S6).",
    );
    assert(
      String(thrown.message).includes("ROW_PLAN_DUPLICATE_ROW_ID") &&
        String(thrown.message).includes("minimum_cash"),
      `Duplicate-mint violation must be typed ROW_PLAN_DUPLICATE_ROW_ID naming the row_id, got: ${thrown.message}`,
    );
  });

  // The KNOWN collision stays lawful and keeps its current runtime shape: the
  // schedule mint wins in rows_by_id while the statement row survives in
  // statement_rows for the consumer's statement-first fallback
  // (build_dynamic_model.mjs:1251-1258).
  const known = loadCase("standard-maximal-v2.json");
  known.statement_structure.cash_flow.push({
    row_id: "cash_interest_paid",
    label: "Interest paid",
    row_type: "input",
    style_role: "line",
  });
  const knownPlan = compileRowPlan(known);
  const statementRow = Object.values(knownPlan.statement_rows)
    .flat()
    .find((row) => row.row_id === "cash_interest_paid");
  assert(
    statementRow,
    "Statement cash_interest_paid row must survive in statement_rows.",
  );
  assert(
    knownPlan.rows_by_id.cash_interest_paid ===
      knownPlan.interest_summary_rows.cash_interest_paid &&
      knownPlan.rows_by_id.cash_interest_paid !== statementRow.row,
    "Known collision must keep the existing masked shape: schedule row wins in rows_by_id.",
  );

  // Every allowlisted id must actually be re-mintable without a throw — the
  // allowlist may not contain speculative entries beyond the schedule ids.
  for (const rowId of KNOWN_ROW_ID_COLLISIONS) {
    assert(
      knownPlan.interest_summary_rows?.[rowId] !== undefined ||
        knownPlan.waterfall_rows?.[rowId] !== undefined ||
        knownPlan.debt_summary_rows?.[rowId] !== undefined,
      `Allowlisted collision ${rowId} must correspond to a real schedule mint.`,
    );
  }

  // Both shipped fixtures must still compile clean under the guard.
  for (const name of ["standard-maximal-v2.json", "standard-net-cash-v2.json"]) {
    const plan = compileRowPlan(loadCase(name));
    assert(
      plan && typeof plan.rows_by_id === "object",
      `${name} must compile under the duplicate-mint guard.`,
    );
  }
}

console.log(JSON.stringify({ status: "PASS", checks, mutations_total, mutations_caught }));
