#!/usr/bin/env node
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  assertPhysicalOwnershipPreflight,
  compilePhysicalOwnershipPreflight,
  compileStructuralOwnershipPreflight,
  resolveSelectedForecastOwnership,
  verifyForecastOwnershipReceipt,
  verifySelectedForecastOwnership,
} from "./lib/forecast_ownership_resolver.mjs";
import { sealOwnershipCensus } from "./lib/ownership_census.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import fs from "node:fs";

const receiptSchema = JSON.parse(fs.readFileSync(
  new URL("../assets/forecast-ownership-preflight-v1.schema.json", import.meta.url),
  "utf8",
));

const periods = [
  "2023-12-31", "2024-12-31", "2025-12-31",
  "2026-12-31", "2027-12-31", "2028-12-31",
].map((date, index) => ({ date, status: index < 3 ? "historical" : "forecast" }));

function authority(method, sourceId, value, sourceKind = null) {
  const source_kind = sourceKind ?? (
    method === "broker_consensus" ? "broker" :
      method === "company_guidance" ? "company_guidance" :
        method === "schedule_link" ? "schedule" :
          method === "accounting_identity" ? "formula" :
            method === "not_separately_forecast" ? "none" :
              method === "historical_average" ? "historical_inference" :
                "user_supplied"
  );
  return {
    method,
    source_kind,
    source_id: sourceId,
    value,
    material: true,
    note: `${sourceId} selected`,
  };
}

function authorities(method, prefix, values = [1, 2, 3]) {
  return values.map((value, index) => authority(method, `${prefix}.fy${index + 1}`, value));
}

function workingCapitalFixture() {
  return {
    case_id: "neutral_wcr_blocker",
    periods: structuredClone(periods),
    instruments: [],
    statement_structure: {
      income_statement: [],
      cash_flow: [
        {
          row_id: "working_capital_total",
          label: "Movement in operating balances",
          semantic_role: "change_in_working_capital",
          row_type: "subtotal",
          material: true,
          aggregation_authority: "reported_parent",
          historical_authority: "reported_total_reconciled",
          source_line_ids: ["filing.cf.20"],
          source_precision: "reported_units",
          calculation: {
            operator: "sum",
            refs: ["receivable_movement", "inventory_movement", "payable_movement"],
          },
          broker_metric_id: "change_in_working_capital",
          values: [-10, -12, -14, -15, -16, -17],
          forecast_period_authorities: authorities(
            "broker_consensus",
            "broker.wc",
            [-15, -16, -17],
          ),
        },
        {
          row_id: "receivable_movement",
          label: "Trade asset movement",
          row_type: "input",
          material: true,
          parent_row_id: "working_capital_total",
          historical_authority: "source_input",
          source_line_ids: ["filing.cf.21"],
          source_precision: "reported_units",
          broker_metric_id: "receivables",
          values: [-4, -5, -6, -7, -8, -9],
          forecast_period_authorities: authorities("historical_average", "fallback.recv", [-5, -5, -5]),
        },
        {
          row_id: "inventory_movement",
          label: "Stock movement",
          row_type: "input",
          material: true,
          parent_row_id: "working_capital_total",
          historical_authority: "source_input",
          source_line_ids: ["filing.cf.22"],
          source_precision: "reported_units",
          broker_metric_id: "inventory",
          values: [-3, -3, -4, -4, -4, -4],
          forecast_period_authorities: authorities("user_assumption", "user.inventory", [-4, -4, -4]),
        },
        {
          row_id: "payable_movement",
          label: "Supplier balance movement",
          row_type: "input",
          material: true,
          parent_row_id: "working_capital_total",
          historical_authority: "source_input",
          source_line_ids: ["filing.cf.23"],
          source_precision: "reported_units",
          values: [-3, -4, -4, -4, -4, -4],
          forecast_period_authorities: authorities("historical_average", "fallback.pay", [-4, -4, -4]),
        },
      ],
    },
  };
}

function physicalPlan(modelCase) {
  let row = 20;
  const statement_rows = {};
  const rows_by_id = {};
  for (const section of ["income_statement", "cash_flow"]) {
    statement_rows[section] = (modelCase.statement_structure[section] ?? []).map((definition) => {
      const planned = { ...structuredClone(definition), section, row };
      rows_by_id[planned.row_id] = row;
      row += 1;
      return planned;
    });
  }
  return { statement_rows, rows_by_id };
}

const blocker = workingCapitalFixture();
const structural = compileStructuralOwnershipPreflight(blocker);
assert.equal(structural.status, "PASS");
assert.equal(structural.families.length, 1);
assert.deepEqual(structural.families[0].broker_demand_owner_row_ids, ["working_capital_total"]);
assert.ok(verifyForecastOwnershipReceipt(structural));
assert.deepEqual(validateJsonSchema(structural, receiptSchema), []);

const started = performance.now();
const selected = resolveSelectedForecastOwnership(blocker);
const elapsedMs = performance.now() - started;
assert.equal(selected.status, "PASS");
assert.equal(selected.resolutions.length, 3);
assert.ok(selected.resolutions.every((item) => item.selected_mode === "parent_owned"));
assert.equal(selected.rejected_authorities.length, 9);
assert.deepEqual(selected.controller_signal, {
  action: "continue",
  reason: null,
  resume_from: "selected_forecast_ownership",
});
assert.ok(elapsedMs < 2_000, `ownership resolver exceeded focused SLO: ${elapsedMs}ms`);
for (const child of blocker.statement_structure.cash_flow.slice(1)) {
  assert.ok(child.forecast_period_authorities.every((item) => item.method === "not_separately_forecast"));
  assert.equal(child.broker_metric_id, undefined);
  assert.deepEqual(child.values.slice(3), [null, null, null]);
}
sealOwnershipCensus(blocker);
const physical = assertPhysicalOwnershipPreflight(blocker, physicalPlan(blocker));
assert.equal(physical.status, "PASS");
assert.ok(verifyForecastOwnershipReceipt(physical));
assert.deepEqual(validateJsonSchema(selected, receiptSchema), []);
assert.deepEqual(validateJsonSchema(physical, receiptSchema), []);

// Mixed ownership is explicit per period: parent in FY1, complete children in FY2/FY3.
const mixed = workingCapitalFixture();
mixed.statement_structure.cash_flow[0].forecast_period_authorities = [
  authority("company_guidance", "guidance.wc.fy1", -15),
  authority("accounting_identity", "formula.wc.fy2", null),
  authority("accounting_identity", "formula.wc.fy3", null),
];
const sealedIdentityRank = {
  method_priority: -190,
  definition_score: 1,
  stable_id: "declared_formula:accounting_identity",
};
mixed.statement_structure.cash_flow[0].forecast_period_authorities[1]
  .selection_rank = structuredClone(sealedIdentityRank);
mixed.statement_structure.cash_flow[0].forecast_period_authorities[2]
  .selection_rank = structuredClone(sealedIdentityRank);
mixed.statement_structure.cash_flow[0].forecast_period_authorities[1]
  .material = false;
mixed.statement_structure.cash_flow[0].forecast_period_authorities[2]
  .material = false;
const mixedReceipt = resolveSelectedForecastOwnership(mixed);
assert.deepEqual(
  mixedReceipt.resolutions.map((item) => item.selected_mode),
  ["parent_owned", "children_owned", "children_owned"],
);
for (const child of mixed.statement_structure.cash_flow.slice(1)) {
  assert.equal(child.forecast_period_authorities[0].method, "not_separately_forecast");
  assert.notEqual(child.forecast_period_authorities[1].method, "not_separately_forecast");
}
assert.deepEqual(
  mixed.statement_structure.cash_flow[0].forecast_period_authorities[1]
    .selection_rank,
  sealedIdentityRank,
  "children-owned resolution discarded the sealed formula rank proof",
);
assert.equal(
  mixed.statement_structure.cash_flow[0].forecast_period_authorities[1]
    .material,
  false,
  "children-owned resolution promoted a source-declared immaterial identity",
);
sealOwnershipCensus(mixed);
assert.equal(assertPhysicalOwnershipPreflight(mixed, physicalPlan(mixed)).status, "PASS");

// Canonical authority rank is resolved per period, not once for the family.
// Strong company evidence in FY1 owns the complete child set, while the same
// aggregate retakes FY2/FY3 from weaker child inference.
const rankedMixed = workingCapitalFixture();
rankedMixed.statement_structure.cash_flow[2].forecast_period_authorities[0] =
  authority("company_guidance", "guidance.inventory.fy1", -4);
const rankedMixedReceipt = resolveSelectedForecastOwnership(rankedMixed);
assert.deepEqual(
  rankedMixedReceipt.resolutions.map((item) => item.selected_mode),
  ["children_owned", "parent_owned", "parent_owned"],
);
assert.equal(
  rankedMixed.statement_structure.cash_flow[2]
    .forecast_period_authorities[0].method,
  "company_guidance",
  "stronger child guidance was discarded instead of retaining FY1 ownership",
);
assert.ok(
  rankedMixed.statement_structure.cash_flow[2]
    .forecast_period_authorities.slice(1)
    .every((item) => item.method === "not_separately_forecast"),
  "weaker later-period child evidence was not captured by the aggregate",
);
assert.ok(
  rankedMixedReceipt.rejected_authorities.some(
    (item) => item.row_id === "working_capital_total" &&
      item.forecast_index === 0 &&
      item.rejection_reason.includes("method_priority"),
  ),
  "rejected aggregate evidence did not preserve the canonical rank reason",
);

const downgradedChild = workingCapitalFixture();
downgradedChild.statement_structure.cash_flow[2].forecast_period_authorities[0] =
  authority("historical_average", "fallback.inventory.fy1", -4);
const downgradedReceipt = resolveSelectedForecastOwnership(downgradedChild);
assert.ok(
  downgradedReceipt.resolutions.every((item) => item.selected_mode === "parent_owned"),
  "a weaker child mutation incorrectly displaced broker aggregate ownership",
);
const equalRungChild = workingCapitalFixture();
equalRungChild.statement_structure.cash_flow[2].forecast_period_authorities[0] =
  authority("broker_consensus", "aaa-child-stable-id", -4);
const equalRungReceipt = resolveSelectedForecastOwnership(equalRungChild);
assert.equal(
  equalRungReceipt.resolutions[0].selected_mode,
  "parent_owned",
  "an equal-rung child displaced the aggregate only on stable identifier order",
);

// Formula dependencies are reusable calculation inputs, not owned detail.
// A direct parent cannot globally capture them away from a second identity.
const sharedFormulaDependency = workingCapitalFixture();
const sharedRows = sharedFormulaDependency.statement_structure.cash_flow;
for (const child of sharedRows.slice(1)) delete child.parent_row_id;
sharedRows.push({
  row_id: "working_capital_cross_check",
  label: "Movement cross-check",
  semantic_role: "working_capital_cross_check",
  row_type: "subtotal",
  material: true,
  calculation: {
    operator: "sum",
    refs: ["receivable_movement", "inventory_movement", "payable_movement"],
  },
  values: [-10, -12, -14, null, null, null],
});
const sharedReceipt = resolveSelectedForecastOwnership(sharedFormulaDependency);
assert.deepEqual(
  sharedReceipt.resolutions.map((item) => item.selected_mode),
  ["parent_owned", "parent_owned", "parent_owned", "children_owned", "children_owned", "children_owned"],
);
for (const child of sharedRows.slice(1, 4)) {
  assert.ok(
    child.forecast_period_authorities.every(
      (item) => item.method !== "not_separately_forecast",
    ),
    "formula dependency was globally captured away from a second identity",
  );
}
const structurallyOwnedDependency = workingCapitalFixture();
structurallyOwnedDependency.statement_structure.cash_flow.push(
  structuredClone(sharedRows.at(-1)),
);
assert.throws(
  () => resolveSelectedForecastOwnership(structurallyOwnedDependency),
  /preflight B blocked.*unresolved material ownership/,
  "structurally owned detail was incorrectly treated as a reusable formula dependency",
);

// Final sealing may rebuild a redundant identity authority after case
// normalisation removes it. The rebuilt authority must still take its
// materiality from mapped source evidence, not the presentation row default.
const evidenceImmaterialIdentity = workingCapitalFixture();
const evidenceParent = evidenceImmaterialIdentity.statement_structure.cash_flow[0];
delete evidenceParent.forecast_period_authorities;
evidenceImmaterialIdentity.source_coverage = {
  cash_flow: [
    {
      source_line_id: "filing.cf.20",
      mapped_row_ids: ["working_capital_total"],
      material: false,
    },
  ],
};
const evidenceReceipt = resolveSelectedForecastOwnership(evidenceImmaterialIdentity);
assert.ok(
  evidenceReceipt.resolutions.every((item) => item.selected_mode === "children_owned"),
);
assert.ok(
  evidenceParent.forecast_period_authorities.every(
    (item) => item.method === "accounting_identity" && item.material === false,
  ),
  "identity reconstruction promoted mapped immaterial evidence",
);
const staleEvidenceMateriality = structuredClone(evidenceImmaterialIdentity);
staleEvidenceMateriality.statement_structure.cash_flow[0]
  .forecast_period_authorities[1].material = true;
assert.throws(
  () => verifySelectedForecastOwnership(staleEvidenceMateriality),
  /topology is stale/,
  "a changed reconstructed evidence materiality flag survived the ownership receipt",
);

// A schedule child is captured by default; explicit co-ownership is the only exception.
const scheduleCase = workingCapitalFixture();
const scheduleChild = scheduleCase.statement_structure.cash_flow[1];
scheduleChild.forecast_period_authorities = authorities("schedule_link", "schedule.recv");
resolveSelectedForecastOwnership(scheduleCase);
assert.ok(scheduleChild.forecast_period_authorities.every((item) => item.method === "not_separately_forecast"));
const permittedSchedule = workingCapitalFixture();
const permittedChild = permittedSchedule.statement_structure.cash_flow[1];
permittedChild.forecast_schedule_coownership_permitted = true;
permittedChild.forecast_period_authorities = authorities("schedule_link", "schedule.recv");
resolveSelectedForecastOwnership(permittedSchedule);
assert.ok(permittedChild.forecast_period_authorities.every((item) => item.method === "schedule_link"));
sealOwnershipCensus(permittedSchedule);
assert.equal(assertPhysicalOwnershipPreflight(permittedSchedule, physicalPlan(permittedSchedule)).status, "PASS");

// A children-owned family with one material missing child is a bounded ambiguity.
const missingChild = workingCapitalFixture();
missingChild.statement_structure.cash_flow[0].forecast_period_authorities = authorities(
  "accounting_identity",
  "formula.wc",
  [null, null, null],
);
missingChild.statement_structure.cash_flow[3].forecast_period_authorities = authorities(
  "not_separately_forecast",
  "missing.pay",
  [null, null, null],
);
assert.throws(
  () => resolveSelectedForecastOwnership(missingChild),
  /preflight B blocked.*unresolved material ownership/,
);
assert.equal(
  missingChild.forecast_ownership_preflights.selected.controller_signal.action,
  "cancel_descendants_preserve_checkpoint",
);
assert.match(
  missingChild.forecast_ownership_preflights.selected.controller_signal.reason,
  /unresolved material ownership/,
);

// An absent child is not an ownership gap when mapped evidence declares that
// child immaterial. Changing that source declaration must reverse the result.
const immaterialMissingChild = workingCapitalFixture();
immaterialMissingChild.statement_structure.cash_flow[0]
  .forecast_period_authorities = authorities(
    "accounting_identity",
    "formula.wc",
    [null, null, null],
  );
immaterialMissingChild.statement_structure.cash_flow[3]
  .forecast_period_authorities = authorities(
    "not_separately_forecast",
    "missing.pay",
    [null, null, null],
  );
immaterialMissingChild.source_coverage = {
  cash_flow: [
    {
      source_line_id: "filing.cf.23",
      mapped_row_ids: ["payable_movement"],
      material: false,
    },
  ],
};
assert.equal(
  resolveSelectedForecastOwnership(immaterialMissingChild).status,
  "PASS",
);
const materialMissingChild = structuredClone(immaterialMissingChild);
delete materialMissingChild.forecast_ownership_preflights;
materialMissingChild.source_coverage.cash_flow[0].material = true;
assert.throws(
  () => resolveSelectedForecastOwnership(materialMissingChild),
  /preflight B blocked.*unresolved material ownership/,
  "material source evidence did not restore the missing-child blocker",
);

// Row order and issuer wording do not change the selected modes.
const reordered = workingCapitalFixture();
const parent = reordered.statement_structure.cash_flow.shift();
reordered.statement_structure.cash_flow.reverse();
reordered.statement_structure.cash_flow.push(parent);
for (const [index, row] of reordered.statement_structure.cash_flow.entries()) {
  row.label = `Unfamiliar disclosure ${index + 1}`;
}
const reorderedReceipt = resolveSelectedForecastOwnership(reordered);
assert.deepEqual(
  reorderedReceipt.resolutions.map(({ parent_row_id, forecast_index, selected_mode }) => ({
    parent_row_id, forecast_index, selected_mode,
  })),
  selected.resolutions.map(({ parent_row_id, forecast_index, selected_mode }) => ({
    parent_row_id, forecast_index, selected_mode,
  })),
);

// Captured children cannot regain broker IDs, precision cannot change under a
// sealed receipt, the census cannot drift, and every row needs a destination.
const staleBroker = structuredClone(blocker);
staleBroker.statement_structure.cash_flow[1].broker_metric_id = "receivables";
assert.throws(() => verifySelectedForecastOwnership(staleBroker), /captured child retains broker demand id/);
const stalePrecision = structuredClone(blocker);
stalePrecision.statement_structure.cash_flow[1].source_precision = "rounded_millions";
assert.throws(() => verifySelectedForecastOwnership(stalePrecision), /topology is stale/);
const staleRankProof = structuredClone(mixed);
staleRankProof.statement_structure.cash_flow[0]
  .forecast_period_authorities[1].selection_rank.method_priority = -189;
assert.throws(
  () => verifySelectedForecastOwnership(staleRankProof),
  /topology is stale/,
  "a changed sealed formula rank proof survived the ownership receipt",
);
const staleMateriality = structuredClone(mixed);
staleMateriality.statement_structure.cash_flow[0]
  .forecast_period_authorities[1].material = true;
assert.throws(
  () => verifySelectedForecastOwnership(staleMateriality),
  /topology is stale/,
  "a changed source-owned materiality flag survived the ownership receipt",
);
const staleCensus = structuredClone(blocker);
staleCensus.ownership_census.records.pop();
assert.equal(compilePhysicalOwnershipPreflight(staleCensus, physicalPlan(staleCensus)).status, "BLOCK");
const missingDestination = physicalPlan(blocker);
delete missingDestination.rows_by_id.inventory_movement;
missingDestination.statement_rows.cash_flow.find((row) => row.row_id === "inventory_movement").row = null;
assert.equal(compilePhysicalOwnershipPreflight(blocker, missingDestination).status, "BLOCK");

console.log(JSON.stringify({
  status: "PASS",
  checks: 48,
  blocker_fixture: "working_capital_parent_broker_children_fallback",
  user_intervention_required: false,
  topology_elapsed_ms: Number(elapsedMs.toFixed(3)),
  topology_slo_ms: 120_000,
  rejected_authorities: selected.rejected_authorities.length,
  checkpoints: [structural.checkpoint, selected.checkpoint, physical.checkpoint],
}));
