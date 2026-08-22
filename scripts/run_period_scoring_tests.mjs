#!/usr/bin/env node
/**
 * P3.4 — Period-specific forecast-ownership scoring.
 *
 * Invariant: forecast-ownership scoring is computed and persisted PER PERIOD
 * (rank vectors on the row and on the sealed evidence, one per forecast
 * period), family scoring is REALISABLE — the family inherits ONE real
 * child's whole rank vector, never a synthetic per-dimension composite (E6) —
 * capture certificates seal inside the period loop, and the
 * recovery pass is a declared, receipt-visible code path — never an
 * environment-variable-only gate.
 *
 * Mutation coverage:
 * - COLLAPSED-PERIOD REGRESSION: the proof fixture has different lawful
 *   winners in FY1 (parent guidance) and FY2/FY3 (complete direct broker
 *   children). The pre-P3.4 resolver collapsed FY2/FY3 to absent through the
 *   row-level capture mark and BLOCKED; reintroducing that collapse fails
 *   the per-period mode assertions below.
 * - ENV-VAR-ONLY RECOVERY GATE: the typed case declaration must activate the
 *   recovery pass with the environment variable deleted, and the fill must
 *   name its declared origin on the row. A mutation that gates recovery on
 *   the environment variable alone fails both assertions.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  declaredOwnershipRecovery,
  resolveSelectedForecastOwnership,
  verifyPeriodOwnershipScoring,
} from "./lib/forecast_ownership_resolver.mjs";
import {
  aggregateForecastFamilyRankVector,
  forecastAuthorityRankVector,
} from "./lib/forecast_authority.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";

const receiptSchema = JSON.parse(fs.readFileSync(
  new URL("../assets/forecast-ownership-preflight-v1.schema.json", import.meta.url),
  "utf8",
));
const caseSchema = JSON.parse(fs.readFileSync(
  new URL("../assets/model-case-v2.schema.json", import.meta.url),
  "utf8",
));
const authorityEntrySchema = {
  ...caseSchema.$defs.forecastAuthority,
  $defs: caseSchema.$defs,
};

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const priorDegradeGate = process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE;
delete process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE;

const periods = [
  "2023-12-31", "2024-12-31", "2025-12-31",
  "2026-12-31", "2027-12-31", "2028-12-31",
].map((date, index) => ({ date, status: index < 3 ? "historical" : "forecast" }));

function guidance(sourceId, value) {
  return {
    method: "company_guidance",
    source_kind: "company_guidance",
    source_id: sourceId,
    value,
    material: true,
    note: `${sourceId} selected`,
  };
}

/** FY1 parent guidance vs FY2/FY3 complete direct broker children: the
 * lawful winners DIFFER per period. */
function collapseProofFixture() {
  return {
    case_id: "p34_period_collapse_proof",
    periods: structuredClone(periods),
    statement_structure: {
      income_statement: [],
      cash_flow: [
        {
          row_id: "opex_total",
          label: "Operating expenses",
          row_type: "subtotal",
          material: true,
          aggregation_authority: "reported_parent",
          historical_authority: "reported_total_reconciled",
          source_line_ids: ["filing.cf.30"],
          calculation: { operator: "sum", refs: ["marketing_spend", "admin_spend"] },
          values: [-20, -22, -24, null, null, null],
          forecast_period_authorities: [guidance("guidance.opex.fy1", -25), null, null],
        },
        {
          row_id: "marketing_spend",
          label: "Marketing",
          row_type: "input",
          material: true,
          parent_row_id: "opex_total",
          historical_authority: "source_input",
          source_line_ids: ["filing.cf.31"],
          broker_metric_id: "marketing_spend",
          values: [-12, -13, -14, null, null, null],
        },
        {
          row_id: "admin_spend",
          label: "Administration",
          row_type: "input",
          material: true,
          parent_row_id: "opex_total",
          historical_authority: "source_input",
          source_line_ids: ["filing.cf.32"],
          broker_metric_id: "admin_spend",
          values: [-8, -9, -10, null, null, null],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Collapsed-period regression: winners are period-specific.
// ---------------------------------------------------------------------------
const collapse = collapseProofFixture();
const collapseReceipt = resolveSelectedForecastOwnership(collapse);
check(collapseReceipt.status === "PASS", "the period-differentiated family must resolve");
assert.deepEqual(
  collapseReceipt.resolutions.map((item) => item.selected_mode),
  ["parent_owned", "children_owned", "children_owned"],
  "FY1 parent guidance and FY2/FY3 children broker ownership collapsed to one winner",
);
checks += 1;
const collapseChildren = collapse.statement_structure.cash_flow.slice(1);
for (const child of collapseChildren) {
  check(
    child.forecast_period_authorities[0].method === "not_separately_forecast",
    `${child.row_id} FY1 must be captured by the guidance parent`,
  );
  for (const index of [1, 2]) {
    const pinned = child.forecast_period_authorities[index];
    check(
      pinned?.method === "broker_consensus" && pinned?.source_kind === "broker",
      `${child.row_id} FY${index + 1} must keep explicit broker ownership despite the FY1 capture mark`,
    );
    check(
      Number.isFinite(pinned?.selection_rank?.method_priority),
      `${child.row_id} FY${index + 1} pinned authority must persist its per-period rank vector`,
    );
  }
  check(
    child.broker_metric_id !== undefined,
    `${child.row_id} broker demand id must survive a partial (single-period) capture`,
  );
  // Certificates are sealed per period inside the period loop: the captured
  // period proves intentional blankness, the child-owned periods prove the
  // family boundary without transferring the live authority.
  const certificates = child.forecast_capture_certificates;
  check(
    certificates?.length === 3 &&
      certificates.every((certificate, index) => certificate.forecast_index === index),
    `${child.row_id} must carry one sealed certificate per forecast period`,
  );
  check(
    certificates[0].proof.includes("intentionally blank"),
    `${child.row_id} FY1 certificate must prove the captured period`,
  );
  check(
    certificates[1].proof.includes("child-owned") &&
      certificates[2].proof.includes("child-owned"),
    `${child.row_id} FY2/FY3 certificates must record child ownership`,
  );
}
check(
  verifyPeriodOwnershipScoring(collapse) === collapse.forecast_ownership_preflights.selected,
  "the period-scoring validator must accept the lawfully resolved case",
);
// Parent FY1 authority keeps its per-period rank proof on the row.
check(
  collapse.statement_structure.cash_flow[0]
    .forecast_period_authorities[0].selection_rank?.method_priority === 30,
  "the winning FY1 parent guidance must persist its rank vector on the row",
);
// Resolver-authored entries remain legal per-period authorities under the
// sealed model-case schema (no stray fields such as inferred stable ids).
for (const child of collapseChildren) {
  for (const entry of child.forecast_period_authorities) {
    assert.deepEqual(
      validateJsonSchema(entry, authorityEntrySchema),
      [],
      `${child.row_id} resolver-authored authority must satisfy the sealed case schema`,
    );
  }
  checks += 1;
}
// The selected receipt keeps its sealed v1 shape (rank vectors live on the
// rows and inside the open rejected-authority evidence, never as new receipt
// fields).
assert.deepEqual(validateJsonSchema(collapseReceipt, receiptSchema), []);
checks += 1;
// Tamper evidence: a changed persisted rank vector cannot survive the seal.
const tampered = structuredClone(collapse);
tampered.statement_structure.cash_flow[1]
  .forecast_period_authorities[1].selection_rank.method_priority = 1;
assert.throws(
  () => verifyPeriodOwnershipScoring(tampered),
  /topology is stale|period ownership scoring violation/,
  "a tampered persisted rank vector must be detected",
);
checks += 1;

// ---------------------------------------------------------------------------
// 2. Reverse order: capture in a LATER period must not collapse EARLIER
//    child-owned periods (retroactive pins).
// ---------------------------------------------------------------------------
const reversed = collapseProofFixture();
reversed.case_id = "p34_reverse_capture";
reversed.statement_structure.cash_flow[0].forecast_period_authorities =
  [null, null, guidance("guidance.opex.fy3", -27)];
const reversedReceipt = resolveSelectedForecastOwnership(reversed);
assert.deepEqual(
  reversedReceipt.resolutions.map((item) => item.selected_mode),
  ["children_owned", "children_owned", "parent_owned"],
);
checks += 1;
for (const child of reversed.statement_structure.cash_flow.slice(1)) {
  check(
    [0, 1].every((index) =>
      child.forecast_period_authorities[index]?.method === "broker_consensus"),
    `${child.row_id} FY1/FY2 must stay explicitly child-owned when FY3 captures`,
  );
  check(
    child.forecast_period_authorities[2].method === "not_separately_forecast",
    `${child.row_id} FY3 must be captured`,
  );
}
check(
  verifyPeriodOwnershipScoring(reversed) === reversed.forecast_ownership_preflights.selected,
  "the validator must accept the reverse-order resolution",
);

// ---------------------------------------------------------------------------
// 3. E6 — the family score is REALISABLE: it IS one real child's whole rank
//    vector, never a synthetic per-dimension composite.
//    Part A: when the best WHOLE child substantively outranks the parent on
//    its own evidence, the family still takes ownership (roster + deciding
//    dimension sealed in the rejection receipt).
//    Part B: a family whose only win was borrowing one sibling's freshness
//    onto another sibling's method stays with the parent — that is the
//    phantom profile this package removes.
// ---------------------------------------------------------------------------
function aggregateFixture(freshBestChild = false) {
  const fixture = collapseProofFixture();
  fixture.case_id = "p34_family_aggregate";
  const [parent, marketing, admin] = fixture.statement_structure.cash_flow;
  parent.broker_metric_id = "opex_total";
  parent.forecast_period_authorities = [0, 1, 2].map((index) => ({
    method: "broker_consensus",
    source_kind: "broker",
    source_id: `broker.opex.fy${index + 1}`,
    value: -26 - index,
    material: true,
    note: "parent broker selected",
  }));
  delete marketing.broker_metric_id;
  delete admin.broker_metric_id;
  marketing.forecast_period_authorities = [0, 1, 2].map((index) => ({
    method: "broker_consensus",
    source_kind: "broker",
    source_id: `aaa-broker.marketing.fy${index + 1}`,
    value: -15 - index,
    material: true,
    note: "child broker selected",
    ...(freshBestChild ? { as_of_date: "2026-06-30" } : {}),
  }));
  admin.forecast_period_authorities = [0, 1, 2].map((index) => ({
    method: "user_assumption",
    source_kind: "user_supplied",
    source_id: `user.admin.fy${index + 1}`,
    as_of_date: "2026-06-30",
    value: -11 - index,
    material: true,
    note: "fresh user view",
  }));
  return fixture;
}
const aggregateCase = aggregateFixture(true);
const aggregateReceipt = resolveSelectedForecastOwnership(aggregateCase);
assert.deepEqual(
  aggregateReceipt.resolutions.map((item) => item.selected_mode),
  ["children_owned", "children_owned", "children_owned"],
  "a family whose best REAL child substantively outranks the parent must take ownership",
);
checks += 1;
check(
  aggregateReceipt.rejected_authorities.some(
    (item) =>
      item.row_id === "opex_total" &&
      item.rejection_reason.includes("family aggregate authority over all 2 children") &&
      item.rejection_reason.includes("freshness_timestamp"),
  ),
  "the rejection must name the family aggregate roster and its deciding dimension",
);
check(
  aggregateReceipt.rejected_authorities
    .filter((item) => item.row_id === "opex_total")
    .every((item) => item.authority?.selection_rank?.method_priority === 50),
  "the rejected parent authority must seal its per-period rank vector in the receipt",
);
check(
  new Set(
    aggregateReceipt.rejected_authorities
      .filter((item) => item.row_id === "opex_total")
      .map((item) => item.forecast_index),
  ).size === 3,
  "the parent rejection evidence must exist once per forecast period",
);

// E6 REPAIR PIN — the defect this law removes. Here only the WEAKER sibling
// carries freshness; under per-dimension aggregation the family stitched
// marketing's broker method onto admin's fresher date and overthrew the
// parent with a profile nobody holds. Realisable scoring keeps the family
// with its parent: the best whole child (`aaa-broker.marketing`) differs from
// the parent only on the stable-id rung, which is not substantive evidence.
const borrowedCase = aggregateFixture(false);
const borrowedReceipt = resolveSelectedForecastOwnership(borrowedCase);
assert.deepEqual(
  borrowedReceipt.resolutions.map((item) => item.selected_mode),
  ["parent_owned", "parent_owned", "parent_owned"],
  "a family whose win required borrowing a sibling's dimension must not take ownership",
);
checks += 1;
check(
  borrowedReceipt.rejected_authorities.every((item) => item.row_id !== "opex_total"),
  "an unoverthrown parent leaves no rejection evidence behind",
);

// Aggregate helper law — E6 REALISABILITY: the chosen family profile IS one
// member's actual rank vector; provenance rides beside it, never inside it.
const aggregateCandidates = [
  { method: "broker_consensus", source_id: "a" },
  { method: "user_assumption", source_id: "b", as_of_date: "2026-06-30", confidence: 0.4 },
  { method: "historical_average", source_id: "c", confidence: 0.9 },
];
const aggregateVector = aggregateForecastFamilyRankVector(aggregateCandidates);
check(aggregateVector.aggregated_member_count === 3, "the aggregate must span all children");
assert.deepEqual(aggregateVector.aggregated_member_stable_ids, ["a", "b", "c"]);
checks += 1;
const stripProvenance = ({
  aggregated_member_count: _count,
  aggregated_member_stable_ids: _ids,
  ...rank
}) => rank;
// The whole-vector winner here is the broker candidate "a" (strongest method):
// the family must NOT borrow b's freshness or c's confidence on top of it.
const wholeVectorWinner = aggregateCandidates.find(
  (candidate) => candidate.source_id === aggregateVector.stable_id,
);
check(wholeVectorWinner?.source_id === "a", "the family inherits the strongest WHOLE child");
assert.deepEqual(
  stripProvenance(aggregateVector),
  forecastAuthorityRankVector(wholeVectorWinner),
  "the aggregate's rank dimensions must be exactly one member's actual vector",
);
checks += 1;
check(aggregateForecastFamilyRankVector([]) === null, "an empty family has no aggregate score");

// E6 PROPERTY TEST — for ANY candidate set, the chosen family profile equals
// ONE member's actual vector. Deterministic pseudo-random sweep (LCG), so a
// failure reproduces from the seed in the message.
let propertySeed = 0x2f6e2b1;
const nextRandom = () => {
  propertySeed = (propertySeed * 1103515245 + 12345) % 2147483648;
  return propertySeed / 2147483648;
};
const METHOD_POOL = [
  "actual_plus_remainder", "contractual_commitment", "company_guidance",
  "company_indication", "broker_consensus", "user_assumption",
  "driver_formula", "roll_forward", "seasonal_run_rate", "historical_average",
  "historical_trend", "carry_forward", "explicit_zero",
];
const pickFrom = (list) => list[Math.floor(nextRandom() * list.length)];
for (let iteration = 0; iteration < 250; iteration += 1) {
  const size = 1 + Math.floor(nextRandom() * 5);
  const candidates = Array.from({ length: size }, (_, index) => {
    const candidate = { method: pickFrom(METHOD_POOL), source_id: `prop.${iteration}.${index}` };
    if (nextRandom() < 0.5) candidate.as_of_date = `20${20 + Math.floor(nextRandom() * 10)}-06-30`;
    if (nextRandom() < 0.5) candidate.confidence = nextRandom();
    if (nextRandom() < 0.5) candidate.completeness = nextRandom();
    if (nextRandom() < 0.5) candidate.period_completeness = nextRandom();
    for (const flag of ["definition_compatible", "period_compatible", "units_compatible"]) {
      if (nextRandom() < 0.5) candidate[flag] = nextRandom() < 0.5;
    }
    return candidate;
  });
  const aggregate = aggregateForecastFamilyRankVector(candidates);
  check(
    candidates.some((candidate) => {
      const vector = forecastAuthorityRankVector(candidate);
      return Object.keys(vector).every((key) => aggregate[key] === vector[key]);
    }),
    `family profile must be realisable (seed ${0x2f6e2b1}, iteration ${iteration})`,
  );
}

// ---------------------------------------------------------------------------
// 4. Uniform winners stay a strict no-op of the certified behavior: full
//    capture, cleared broker demand, no pins minted.
// ---------------------------------------------------------------------------
const uniform = aggregateFixture();
uniform.case_id = "p34_uniform_family";
uniform.statement_structure.cash_flow[2].forecast_period_authorities =
  uniform.statement_structure.cash_flow[2].forecast_period_authorities.map((entry, index) => ({
    ...entry,
    method: "historical_average",
    source_kind: "historical_inference",
    source_id: `fallback.admin.fy${index + 1}`,
  }));
delete uniform.statement_structure.cash_flow[2].forecast_period_authorities[0].as_of_date;
delete uniform.statement_structure.cash_flow[2].forecast_period_authorities[1].as_of_date;
delete uniform.statement_structure.cash_flow[2].forecast_period_authorities[2].as_of_date;
uniform.statement_structure.cash_flow[1].forecast_period_authorities =
  uniform.statement_structure.cash_flow[1].forecast_period_authorities.map((entry) => ({
    ...entry,
    method: "historical_average",
    source_kind: "historical_inference",
  }));
const uniformReceipt = resolveSelectedForecastOwnership(uniform);
check(
  uniformReceipt.resolutions.every((item) => item.selected_mode === "parent_owned"),
  "uniformly weaker children must leave the parent owning every period",
);
for (const child of uniform.statement_structure.cash_flow.slice(1)) {
  check(
    child.forecast_period_authorities.every(
      (entry) => entry.method === "not_separately_forecast",
    ),
    `${child.row_id} must be captured in every period`,
  );
  check(
    !JSON.stringify(child).includes("ownership-period-pin"),
    `${child.row_id} must not receive pins when no period is child-owned`,
  );
}

// Determinism under issuer row order.
const reordered = collapseProofFixture();
reordered.statement_structure.cash_flow.reverse();
const reorderedReceipt = resolveSelectedForecastOwnership(reordered);
assert.deepEqual(
  reorderedReceipt.resolutions.map(({ forecast_index, selected_mode }) => ({ forecast_index, selected_mode })),
  collapseReceipt.resolutions.map(({ forecast_index, selected_mode }) => ({ forecast_index, selected_mode })),
);
checks += 1;

// ---------------------------------------------------------------------------
// 5. The recovery pass is a DECLARED code path: typed on the case,
//    receipt-visible on the row, environment gate merely normalised.
// ---------------------------------------------------------------------------
function recoveryFixture() {
  const fixture = collapseProofFixture();
  fixture.case_id = "p34_recovery";
  const [parent, marketing, admin] = fixture.statement_structure.cash_flow;
  parent.forecast_period_authorities = [0, 1, 2].map((index) => ({
    method: "accounting_identity",
    source_kind: "formula",
    source_id: `formula.opex.fy${index + 1}`,
    material: true,
    note: "identity over children",
  }));
  marketing.forecast_period_authorities = [0, 1, 2].map((index) => ({
    method: "user_assumption",
    source_kind: "user_supplied",
    source_id: `user.marketing.fy${index + 1}`,
    value: -15 - index,
    material: true,
    note: "user view",
  }));
  delete marketing.broker_metric_id;
  delete admin.broker_metric_id;
  admin.values = [-8, -9, -10, null, null, null];
  return fixture;
}

// 5a. Typed case declaration activates recovery WITHOUT the environment gate.
check(process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE === undefined, "the environment gate must be absent");
const declaredRecovery = recoveryFixture();
declaredRecovery.forecast_ownership_recovery = {
  mode: "historical_average",
  note: "bounded fill approved for this run",
};
check(
  declaredOwnershipRecovery(declaredRecovery).origin === "case_declaration",
  "a case-declared recovery must be typed as such",
);
const declaredReceipt = resolveSelectedForecastOwnership(declaredRecovery);
check(declaredReceipt.status === "PASS", "the typed declaration must activate the recovery pass");
check(
  declaredReceipt.degraded_authorities.length === 3 &&
    declaredReceipt.degraded_authorities.every((item) => item.method === "historical_average"),
  "the recovery fill must be receipted per period",
);
const declaredFilled = declaredRecovery.statement_structure.cash_flow[2].forecast_period_authorities;
check(
  declaredFilled.every(
    (entry) =>
      entry.method === "historical_average" &&
      entry.source_kind === "historical_inference" &&
      entry.note.includes("case_declaration"),
  ),
  "each fill must name its declared origin on the row",
);
check(
  declaredFilled.every((entry) => entry.value === -9),
  "the fill must be the deterministic three-observation historical average, never zero",
);
check(
  declaredFilled.every((entry) => Number.isFinite(entry.selection_rank?.method_priority)),
  "each fill must persist its per-period rank vector",
);

// 5b. The legacy environment gate still works but is normalised into the
// typed declaration, visible on the row.
const environmentRecovery = recoveryFixture();
process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE = "historical_average";
let environmentReceipt;
try {
  check(
    declaredOwnershipRecovery(environmentRecovery).origin === "controller_environment",
    "the environment gate must be normalised into the typed declaration",
  );
  environmentReceipt = resolveSelectedForecastOwnership(environmentRecovery);
} finally {
  delete process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE;
}
check(environmentReceipt.status === "PASS", "the normalised environment gate must still recover");
check(
  environmentRecovery.statement_structure.cash_flow[2].forecast_period_authorities
    .every((entry) => entry.note.includes("controller_environment")),
  "an environment-activated fill must be attributed to the controller environment",
);

// 5c. An unregistered recovery mode fails closed.
const badMode = recoveryFixture();
badMode.forecast_ownership_recovery = { mode: "assume_zero" };
assert.throws(
  () => resolveSelectedForecastOwnership(badMode),
  /unsupported mode/,
  "an unregistered recovery mode must fail closed",
);
checks += 1;

// 5d. Undeclared recovery blocks; nothing fills, nothing zeroes.
const undeclared = recoveryFixture();
assert.throws(
  () => resolveSelectedForecastOwnership(undeclared),
  /preflight B blocked.*unresolved material ownership/,
);
checks += 1;
check(
  undeclared.statement_structure.cash_flow[2].forecast_period_authorities === undefined,
  "an undeclared recovery must not fill anything",
);

// 5e. Missing observations stay missing: two historicals never become a fill
// (and never a zero).
const shortHistory = recoveryFixture();
shortHistory.forecast_ownership_recovery = { mode: "historical_average" };
shortHistory.statement_structure.cash_flow[2].values = [null, -9, -10, null, null, null];
assert.throws(
  () => resolveSelectedForecastOwnership(shortHistory),
  /preflight B blocked.*unresolved material ownership/,
);
checks += 1;
check(
  !JSON.stringify(shortHistory.statement_structure.cash_flow[2]).includes("explicit_zero") &&
    shortHistory.statement_structure.cash_flow[2].values.slice(3).every((value) => value === null),
  "a two-observation history must stay missing, never zero",
);

if (priorDegradeGate === undefined) delete process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE;
else process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE = priorDegradeGate;

console.log(JSON.stringify({ status: "PASS", checks }));
