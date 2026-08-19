#!/usr/bin/env node
/**
 * P2.5 — statement-family residual treatment + protected-identity role pinning.
 *
 * Invariant under test: a material statement-family total that does not foot
 * against its members receives an explicit typed treatment (refusal finding),
 * NEVER a silent pass as source_input; an empty member-set is recorded as a
 * typed finding, never skipped; the protected-identity role set is a declared
 * asset whose membership is pinned here (removing a role = FAIL).
 *
 * Red proof (pre-repair, model_ir_v3.mjs before this work package):
 *   unfooted material reported_parent total [100 vs member sum 90] compiled to
 *   proof.status PASS with 0 blockers and 0 warnings; the empty member-set
 *   variant also compiled PASS with 0 findings. Documented in
 *   programme/P2.5_issue_card.md.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  compileModelIrV3,
  workbookSemanticProofContract,
  PROTECTED_IDENTITY_ROLES,
} from "./lib/model_ir_v3.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import { compileInstrumentPeriodState } from "./lib/instrument_period_state.mjs";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

// ---------------------------------------------------------------------------
// Synthetic statement-family harness. The manifest carries the graph identity;
// the row plan carries the filed numbers the footing pass must judge.
// ---------------------------------------------------------------------------
function statementNode(id, extra = {}) {
  return {
    node_id: `statement.${id}`,
    node_kind: "statement_row",
    row_id: id,
    label: id,
    section: "cash_flow",
    semantic_role: null,
    projection_status: "rendered",
    physical_row: extra.physical_row ?? 10,
    row_type: "input",
    forecast_authorities: [],
    ...extra,
  };
}

function materialAuthority() {
  return [{ forecast_index: 0, method: "user_assumption", material: true }];
}

function compileFamily({ totalValues, memberValues, options = {} }) {
  const nodes = [
    statementNode("family_total", {
      physical_row: 10,
      forecast_authorities: options.immaterial ? [] : materialAuthority(),
      aggregation_authority: "reported_parent",
    }),
  ];
  const planRows = [
    {
      row_id: "family_total",
      row: 10,
      row_type: "input",
      historical_authority: options.totalAuthority ?? "source_input",
      aggregation_authority: "reported_parent",
      ...(options.totalAuthority === "reported_total_reconciled"
        ? {
            reported_historical_values: totalValues,
            calculation: {
              operator: "sum",
              refs: memberValues.map((_, index) => `member_${index}`),
            },
          }
        : { values: totalValues }),
      ...(options.totalPrecisions
        ? { historical_value_precisions: options.totalPrecisions }
        : {}),
    },
  ];
  memberValues.forEach((member, index) => {
    // A plain array is a filed (source_input) member; an object may override
    // the member's historical authority/calculation to model schedule- or
    // formula-owned members whose caches are NOT filed history.
    const spec = Array.isArray(member) ? { values: member } : member;
    const id = `member_${index}`;
    nodes.push(
      statementNode(id, {
        physical_row: 11 + index,
        ...(options.totalAuthority === "reported_total_reconciled"
          ? {}
          : { parent_row_id: "family_total", aggregation_role: "working_child" }),
      }),
    );
    planRows.push({
      row_id: id,
      row: 11 + index,
      row_type: spec.row_type ?? "input",
      historical_authority: spec.historical_authority ?? "source_input",
      ...(spec.calculation ? { calculation: spec.calculation } : {}),
      ...(options.totalAuthority === "reported_total_reconciled"
        ? {}
        : { parent_row_id: "family_total", aggregation_role: "working_child" }),
      values: spec.values,
    });
  });
  const semanticManifest = {
    case_id: "p25-statement-family",
    case_sha256: "0".repeat(64),
    accounting_basis: "ifrs",
    source_inventory: [],
    edges: [],
    nodes,
  };
  const rowPlan = {
    statement_rows: { income_statement: [], cash_flow: planRows },
  };
  return compileModelIrV3({
    modelCase: {},
    rowPlan,
    semanticManifest,
    sourceCrosswalk: [],
  });
}

const codesOf = (findings, code) => findings.filter((item) => item.code === code);

// (1) A footing family passes with no family findings.
{
  const ir = compileFamily({
    totalValues: [90, 90, 90],
    memberValues: [
      [60, 60, 60],
      [30, 30, 30],
    ],
  });
  check(ir.proof.status === "PASS", "footing family must PASS");
  const familyFindings = [
    ...ir.proof.blocking_findings,
    ...ir.proof.warnings,
  ].filter((item) => item.code.startsWith("STATEMENT_FAMILY_"));
  check(familyFindings.length === 0, "footing family mints no family findings");
}

// (2) MUTATION (a): an unfooted MATERIAL total is refused, never a silent
// source_input pass. Pre-repair this exact input compiled PASS/0/0.
{
  const ir = compileFamily({
    totalValues: [100, 100, 100],
    memberValues: [
      [60, 60, 60],
      [30, 30, 30],
    ],
  });
  check(ir.proof.status === "BLOCK", "unfooted material total must BLOCK");
  const found = codesOf(ir.proof.blocking_findings, "STATEMENT_FAMILY_UNFOOTED_TOTAL");
  check(found.length === 3, "one refusal per unfooted historical period");
  check(
    found.every(
      (item) =>
        item.display_ids.includes("family_total") &&
        Number.isFinite(item.filed) &&
        Number.isFinite(item.members_sum) &&
        Number.isInteger(item.period),
    ),
    "refusal carries provenance: display ids, filed total, member sum, period",
  );
}

// (3) An unfooted IMMATERIAL total is recorded (typed warning), not blocked.
{
  const ir = compileFamily({
    totalValues: [100, 100, 100],
    memberValues: [
      [60, 60, 60],
      [30, 30, 30],
    ],
    options: { immaterial: true },
  });
  check(ir.proof.status === "PASS", "immaterial unfooted total does not block");
  check(
    codesOf(ir.proof.warnings, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 3,
    "immaterial unfooted total is still recorded as a typed finding",
  );
}

// (4) Missing member history never becomes zero: the period is recorded as
// unfootable, not summed with nulls coerced and not silently skipped.
{
  const ir = compileFamily({
    totalValues: [100, 100, 100],
    memberValues: [
      [60, 60, 60],
      [40, null, 40],
    ],
  });
  check(
    codesOf(ir.proof.blocking_findings, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 0,
    "a null member value must not be coerced to zero and refused as unfooted",
  );
  const unfootable = codesOf(ir.proof.warnings, "STATEMENT_FAMILY_UNFOOTABLE_PERIOD");
  check(
    unfootable.length === 1 &&
      unfootable[0].period === 1 &&
      unfootable[0].reason === "missing_member_value",
    "the unverifiable period on a material total is recorded as a typed finding",
  );
  check(ir.proof.status === "PASS", "unfootable period records, it does not block");
}

// (5) MUTATION (b): an empty member-set surfaces a typed finding, never a
// silent skip. Pre-repair this compiled PASS with 0 findings.
{
  const ir = compileFamily({ totalValues: [100, 100, 100], memberValues: [] });
  const empty = codesOf(ir.proof.warnings, "STATEMENT_FAMILY_EMPTY_MEMBER_SET");
  check(
    empty.length === 1 && empty[0].display_ids.includes("family_total"),
    "empty member-set is recorded as a typed finding naming the total",
  );
}

// (6) The reconciled variant foots reported_historical_values against the
// minted members; a material mismatch is refused.
{
  const ir = compileFamily({
    totalValues: [95, 95, 95],
    memberValues: [
      [60, 60, 60],
      [30, 30, 30],
    ],
    options: { totalAuthority: "reported_total_reconciled" },
  });
  check(
    ir.proof.status === "BLOCK" &&
      codesOf(ir.proof.blocking_findings, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 3,
    "reconciled total whose reported series does not foot is refused",
  );
}

// (7) Filed rounding is honoured: with precision 0 a 0.4 difference foots,
// a 0.6 difference does not.
{
  const inTolerance = compileFamily({
    totalValues: [90.4, 90, 90],
    memberValues: [
      [60, 60, 60],
      [30, 30, 30],
    ],
    options: { totalPrecisions: [0, 0, 0] },
  });
  check(
    inTolerance.proof.status === "PASS",
    "difference inside the filed rounding tolerance foots",
  );
  const outOfTolerance = compileFamily({
    totalValues: [90.6, 90, 90],
    memberValues: [
      [60, 60, 60],
      [30, 30, 30],
    ],
    options: { totalPrecisions: [0, 0, 0] },
  });
  check(
    outOfTolerance.proof.status === "BLOCK",
    "difference beyond the filed rounding tolerance is refused",
  );
}

// (8) REGRESSION (evidence-derived donor shape, P2.5 follow-up): a member
// whose history is SCHEDULE-owned carries a model-restated cache (the
// waterfall lane stamps interest_expense to -|reported_interest|), not the
// filed series the reported total was printed against. Face footing must be
// recorded as delegated — never refused off compiled caches, and the caches
// must never be summed as if filed. Donor shape: pre_tax_income reported 150
// over [operating_profit 150 filed, interest_income schedule 0,
// interest_expense schedule -5].
{
  const ir = compileFamily({
    totalValues: [150, 150, 150],
    memberValues: [
      [150, 150, 150],
      {
        values: [0, 0, 0],
        historical_authority: "schedule_link",
        row_type: "calculation",
        calculation: { operator: "sum", refs: [] },
      },
      {
        values: [-5, -5, -5],
        historical_authority: "schedule_link",
        row_type: "calculation",
        calculation: { operator: "sum", refs: [] },
      },
    ],
    options: { totalAuthority: "reported_total_reconciled" },
  });
  check(
    ir.proof.status === "PASS" &&
      codesOf(ir.proof.blocking_findings, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 0,
    "schedule-owned member caches are never refused as an unfooted face total",
  );
  const delegated = codesOf(ir.proof.warnings, "STATEMENT_FAMILY_UNFOOTABLE_PERIOD");
  check(
    delegated.length === 3 &&
      delegated.every((item) => item.reason === "non_face_member_history"),
    "schedule-owned member history is recorded as a typed non-face delegation",
  );
}

// (9) REGRESSION (evidence-derived donor shape, CF side): a formula-owned
// member (derived_formula link) carries an evaluated cache, not filed
// history. Donor shape: cash_flow_profit_before_tax reported 150 over
// [cash_flow_net_income link-cache 114, cash_flow_tax_addback 31 filed].
{
  const ir = compileFamily({
    totalValues: [150, 150, 150],
    memberValues: [
      {
        values: [114, 114, 114],
        historical_authority: "derived_formula",
        row_type: "calculation",
        calculation: { operator: "link", refs: ["net_income"] },
      },
      [31, 31, 31],
    ],
    options: { totalAuthority: "reported_total_reconciled" },
  });
  check(
    ir.proof.status === "PASS" &&
      codesOf(ir.proof.blocking_findings, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 0,
    "formula-owned member caches are never refused as an unfooted face total",
  );
  check(
    codesOf(ir.proof.warnings, "STATEMENT_FAMILY_UNFOOTABLE_PERIOD").every(
      (item) => item.reason === "non_face_member_history",
    ) &&
      codesOf(ir.proof.warnings, "STATEMENT_FAMILY_UNFOOTABLE_PERIOD").length === 3,
    "formula-owned member history is recorded as a typed non-face delegation",
  );
}

// (10) The check does NOT weaken: a reconciled-member family still foots in
// the filed domain (member contributes via its own reported series), and a
// filed-domain mismatch still refuses.
{
  const refused = compileFamily({
    totalValues: [150, 150, 150],
    memberValues: [
      [114, 114, 114],
      [31, 31, 31],
    ],
    options: { totalAuthority: "reported_total_reconciled" },
  });
  check(
    refused.proof.status === "BLOCK" &&
      codesOf(refused.proof.blocking_findings, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 3,
    "filed source_input members that genuinely mis-foot still refuse",
  );
}

// ---------------------------------------------------------------------------
// MUTATION (c): protected-identity role set is declared and pinned.
// Removing any role from the declared set fails here; adding roles does not.
// ---------------------------------------------------------------------------
const REQUIRED_PROTECTED_ROLES = [
  "cash_from_operations",
  "cash_from_investing",
  "cash_before_financing",
  "cash_from_financing",
  "net_change_in_cash",
  "ending_cash",
];
{
  check(Array.isArray(PROTECTED_IDENTITY_ROLES), "protected role set is exported");
  for (const role of REQUIRED_PROTECTED_ROLES) {
    check(
      PROTECTED_IDENTITY_ROLES.includes(role),
      `protected-identity role set must keep ${role} (the CHECK never weakens)`,
    );
  }
  check(
    Object.isFrozen(PROTECTED_IDENTITY_ROLES),
    "protected role set is immutable at runtime",
  );
  const asset = JSON.parse(
    await fs.readFile(
      new URL("../assets/protected-identity-roles-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    [...asset.protected_identity_roles].sort(),
    [...PROTECTED_IDENTITY_ROLES].sort(),
    "exported role set must equal the declared asset",
  );
  checks += 1;
}

// ---------------------------------------------------------------------------
// Real-case regression: the certified fixtures still compile PASS with no
// family refusals, and the workbook contract still protects every rendered
// protected-role identity (functional half of mutation (c)).
// ---------------------------------------------------------------------------
for (const name of ["standard-maximal-v2", "standard-net-cash-v2"]) {
  const modelCase = JSON.parse(
    await fs.readFile(new URL(`../test-fixtures/cases/${name}.json`, import.meta.url), "utf8"),
  );
  const instrumentPeriodState = compileInstrumentPeriodState(modelCase);
  const rowPlan = compileRowPlan(modelCase, { instrumentPeriodState });
  const semanticManifest = compileSemanticManifest(modelCase, rowPlan, {
    instrumentPeriodState,
  });
  const ir = compileModelIrV3({
    modelCase,
    rowPlan,
    semanticManifest,
    sourceCrosswalk: [],
  });
  check(ir.proof.status === "PASS", `${name} still compiles PASS`);
  check(
    codesOf(ir.proof.blocking_findings, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 0,
    `${name} mints no family refusals`,
  );
  const contract = workbookSemanticProofContract(ir, rowPlan, {});
  const protectedConceptIds = new Set(
    contract.protected_formula_identities.map((item) => item.concept_id),
  );
  for (const role of [
    "cash_from_operations",
    "cash_from_investing",
    "cash_from_financing",
    "net_change_in_cash",
    "ending_cash",
  ]) {
    check(
      protectedConceptIds.has(role),
      `${name}: contract still protects ${role} (removing a role would drop this identity)`,
    );
  }
  check(
    [...protectedConceptIds].every(
      (conceptId) =>
        PROTECTED_IDENTITY_ROLES.includes(conceptId) ||
        conceptId.startsWith("reported_total_reconciled:"),
    ),
    `${name}: every role-protected identity is authorised by the declared set`,
  );
}

console.log(JSON.stringify({ status: "PASS", checks }));
