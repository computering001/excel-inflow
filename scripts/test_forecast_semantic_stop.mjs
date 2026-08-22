#!/usr/bin/env node
//
// Forecast semantic-status gate — mp2-E1.
//
// A structurally valid forecast plan can still carry material BLOCKED states
// (the compiler marks a material row BLOCKED when its method is unresolved or
// its behavior gate emptied every compatible candidate). Before this gate such
// a plan sailed into selected_authority_contract — the AstraZeneca shape. This
// test pins the lawfulness boundary in three layers:
//
//   1. compiler   — a minimal case whose behavior map forces a material row
//                   unresolved + blocking really compiles to BLOCKED states;
//   2. classifier — classifyForecastSemanticStatus / the typed status artifact
//                   classify those states (and degrade the non-material ones);
//   3. controller — run_user_flow.mjs places the gate between plan validation
//                   and the selected_authority_contract node, returns a typed
//                   BLOCKED/INTERNAL_WORK stop there, writes
//                   forecast-plan-status.json next to the plan artifact, and
//                   never invokes the authority compiler on that path; the
//                   emitted result is lawful through the workflow-state
//                   constitution (normaliseUserFlowResult accepts it).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileForecastPlan, validateForecastPlan } from "./lib/forecast_candidate_compiler.mjs";
import {
  buildForecastPlanStatusArtifact,
  classifyForecastSemanticStatus,
  forecastSemanticStopMessage,
} from "./lib/forecast_plan_status.mjs";
import { normaliseUserFlowResult } from "./lib/workflow_state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — the minimal case. Two material rows, three historical periods and
// three forecast periods. `capex_hole` has real history (so the historical
// inference candidate exists) but its behavior entry declares blocking with an
// allowed-method set that excludes it — the exact shape of the compiler's
// blocking rule — so every compatible candidate is emptied and the row
// compiles unresolved + BLOCKED.
// ---------------------------------------------------------------------------

function minimalCase() {
  return {
    case_id: "semantic-stop-minimal",
    periods: [
      { date: "2024-12-31", status: "historical" },
      { date: "2025-12-31", status: "historical" },
      { date: "2026-12-31", status: "forecast" },
      { date: "2027-12-31", status: "forecast" },
      { date: "2028-12-31", status: "forecast" },
    ],
  };
}

function minimalStatementStructure() {
  return {
    income_statement: [
      { row_id: "header", row_type: "header", label: "Income statement" },
      {
        row_id: "revenue_baseline",
        row_type: "line",
        label: "Revenue",
        material: true,
        values: [1000, 1030, 1060, null, null, null],
      },
    ],
    cash_flow: [
      { row_id: "header", row_type: "header", label: "Cash flow" },
      {
        row_id: "capex_hole",
        row_type: "line",
        label: "Capital expenditure",
        material: true,
        values: [100, 102, 104, null, null, null],
      },
    ],
  };
}

// The blocking behavior map: recurring_flow keeps the historical-average
// candidate alive, allowed_methods strips it, blocking seals the gate.
const blockingBehaviorMap = {
  schema_version: "forecast-behavior-map/1.0",
  rows: [
    {
      row_id: "capex_hole",
      section: "cash_flow",
      behavior: "recurring_flow",
      allowed_methods: ["broker_consensus"],
      blocking: true,
      confidence: 1,
    },
    {
      row_id: "revenue_baseline",
      section: "income_statement",
      behavior: "recurring_flow",
      allowed_methods: [],
      blocking: false,
      confidence: 1,
    },
  ],
};

await test("minimal case: blocking behavior map forces the material row unresolved+BLOCKED", () => {
  const plan = compileForecastPlan(
    minimalCase(),
    minimalStatementStructure(),
    { behaviorMap: blockingBehaviorMap },
  );
  assert.equal(plan.status, "BLOCKED", `plan status ${plan.status}`);
  const blockedStates = plan.states.filter(
    (state) => state.status === "BLOCKED",
  );
  assert.equal(blockedStates.length, 3, `blocked states ${blockedStates.length}`);
  for (const state of blockedStates) {
    assert.equal(state.row_id, "capex_hole");
    assert.equal(state.material, true);
    assert.equal(state.method, "unresolved");
  }
  // The plan must still be STRUCTURALLY valid — the defect is precisely that
  // structural validation alone does not stop this plan.
  const errors = validateForecastPlan(plan, minimalStatementStructure());
  assert.deepEqual(errors, [], `structural validation flagged: ${errors[0]}`);
});

// ---------------------------------------------------------------------------
// Layer 2 — the classifier and the typed artifact.
// ---------------------------------------------------------------------------

await test("classifier separates material BLOCKED stops from non-material DEGRADE findings", () => {
  const plan = compileForecastPlan(
    minimalCase(),
    minimalStatementStructure(),
    { behaviorMap: blockingBehaviorMap },
  );
  const classified = classifyForecastSemanticStatus(plan);
  assert.equal(classified.blocked.length, 3);
  assert.deepEqual(
    classified.blocked.map((entry) => entry.row_id),
    ["capex_hole", "capex_hole", "capex_hole"],
  );
  for (const entry of classified.blocked) {
    assert.match(entry.state_id, /^cash_flow\.capex_hole\.fy[123]$/);
    assert.match(entry.period_end, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(classified.degrade_findings.length, 0);

  // A non-material BLOCKED state (hand-set: the compiler only BLOCKs
  // non-material rows via invalid-capture origins) must degrade, not stop.
  const mixed = structuredClone(plan);
  const degradedState = mixed.states.find((state) => state.row_id !== "capex_hole");
  degradedState.material = false;
  degradedState.status = "BLOCKED";
  const mixedClassified = classifyForecastSemanticStatus(mixed);
  assert.equal(mixedClassified.blocked.length, 3, "material rows must still stop");
  assert.equal(mixedClassified.degrade_findings.length, 1);
  const finding = mixedClassified.degrade_findings[0];
  assert.equal(finding.code, "forecast_state_blocked_non_material");
  assert.equal(finding.severity, "DEGRADE");
  assert.equal(finding.state_id, degradedState.state_id);
  assert.equal(finding.period, degradedState.period_end);

  // Dedup per (code, period, scope): a repeated non-material BLOCKED state
  // must not flood the findings ledger.
  const twin = structuredClone(mixed);
  twin.states.push(structuredClone(degradedState));
  const deduped = classifyForecastSemanticStatus(twin);
  assert.equal(deduped.degrade_findings.length, 1);
});

await test("typed status artifact and stop message name the blocked rows and periods", () => {
  const plan = compileForecastPlan(
    minimalCase(),
    minimalStatementStructure(),
    { behaviorMap: blockingBehaviorMap },
  );
  const classified = classifyForecastSemanticStatus(plan);
  const message = forecastSemanticStopMessage(classified.blocked);
  assert.match(message, /^3 material forecast state\(s\) are BLOCKED/);
  assert.match(message, /capex_hole \(2026-12-31\)/);
  assert.match(message, /authority selection did not run/);
  const artifact = buildForecastPlanStatusArtifact({
    blocked: classified.blocked,
    message,
  });
  assert.equal(artifact.schema_version, "forecast-plan-status/1.0");
  assert.equal(artifact.status, "BLOCKED");
  assert.equal(artifact.blocked.length, 3);
  assert.equal(artifact.message, message);
});

// ---------------------------------------------------------------------------
// Layer 3 — the controller wiring. The gate must sit between plan validation
// and the selected_authority_contract node, stop the flow there, and never
// run the authority compiler on the blocked path.
// ---------------------------------------------------------------------------

await test("controller gates between plan validation and authority selection", async () => {
  const source = await fs.readFile(
    path.join(HERE, "run_user_flow.mjs"),
    "utf8",
  );
  const validationSite = source.indexOf(
    "const forecastPlanErrors = validateForecastPlan(",
  );
  const gateSite = source.indexOf(
    "classifyForecastSemanticStatus(forecastPlan)",
  );
  const authoritySite = source.indexOf('id: "selected_authority_contract"');
  assert.ok(validationSite > 0, "plan validation site not found");
  assert.ok(gateSite > validationSite, "semantic gate must follow plan validation");
  assert.ok(gateSite < authoritySite, "semantic gate must precede authority selection");

  const gateRegion = source.slice(gateSite, authoritySite);
  for (const token of [
    'status: "BLOCKED"',
    'stage: "decisions"',
    'outcome: "forecast_plan_blocked"',
    'blocker_class: "INTERNAL_WORK"',
    '"forecast-plan-status.json"',
    "buildForecastPlanStatusArtifact",
    "return finish(",
  ]) {
    assert.ok(gateRegion.includes(token), `gate region lacks ${token}`);
  }
  // The blocked path returns before the authority node: the authority
  // compiler must not appear inside the gate region.
  assert.ok(
    !gateRegion.includes("compileSelectedAuthorityContract("),
    "gate region runs the authority compiler",
  );
  // Non-material BLOCKED states degrade to findings and the flow continues.
  assert.ok(
    gateRegion.includes("degrade_findings"),
    "gate region lacks the DEGRADE continuation",
  );
});

await test("the typed stop is lawful through the workflow-state constitution", () => {
  const plan = compileForecastPlan(
    minimalCase(),
    minimalStatementStructure(),
    { behaviorMap: blockingBehaviorMap },
  );
  const classified = classifyForecastSemanticStatus(plan);
  const message = forecastSemanticStopMessage(classified.blocked);
  const normalised = normaliseUserFlowResult({
    schema_version: "user-flow-run/1.0",
    run_id: "semantic_stop_test",
    status: "BLOCKED",
    stage: "decisions",
    outcome: "forecast_plan_blocked",
    blocker_class: "INTERNAL_WORK",
    message,
  });
  assert.equal(normalised.status, "BLOCKED");
  assert.equal(normalised.stage, "decisions");
  assert.equal(normalised.fatal_reason, "equation_system_unsolved");
  assert.equal(normalised.blocker_domain, "equation_graph");
  assert.equal(normalised.user_blocking, false, "INTERNAL_WORK must not be user-blocking");
});

if (failures > 0) {
  console.error(`${failures} test(s) failed.`);
  process.exit(1);
}
console.log("forecast semantic stop: all tests passed.");
