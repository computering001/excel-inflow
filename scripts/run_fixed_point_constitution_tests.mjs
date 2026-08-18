#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  validateCircularityPair,
  validateFixedPointSolution,
} from "./lib/fixed_point_constitution.mjs";
import {
  brokerMetricDefinitionSignature,
  sealBrokerConsensusMembership,
} from "./lib/broker_consensus.mjs";
import { migrateLegacyDebtClasses } from "./lib/debt_class.mjs";
import { validateForecastAuthorities } from "./lib/forecast_authority.mjs";
import { validateResidualInterestAuthority } from "./lib/residual_interest_authority.mjs";
import { canonicalSemanticRole } from "./lib/semantic_roles.mjs";
import { solveCase } from "./lib/solver.mjs";

const PROTECTED_CASH_FLOW_ROLES = new Set([
  "cash_generated_from_operations",
  "cash_from_operations",
  "cash_from_investing",
  "cash_before_financing",
  "cash_from_financing",
  "net_change_in_cash",
]);
const SAME_PERIOD_OPERATORS = new Set(["sum", "subtract", "negate_sum", "negate", "link"]);

/**
 * Project only closed, non-economic legacy declarations carried by archived
 * fixed-point evidence. Every unrecognised debt class still fails before the
 * strict solver boundary.
 */
export function adaptLegacyFixedPointCase(modelCase) {
  const priorReceipt = structuredClone(modelCase.debt_class_migrations ?? null);
  const debtMigrations = migrateLegacyDebtClasses(modelCase);
  const unrecognised = debtMigrations.filter(
    (migration) => migration.mapping !== "legacy_alias",
  );
  if (unrecognised.length > 0) {
    throw new Error(
      `Archived fixed-point case contains unrecognised debt classes: ${unrecognised
        .map((migration) => migration.source_class ?? "(blank)")
        .join(", ")}`,
    );
  }
  // Retain the first migration receipt if this adapter is called again. The
  // canonical case and its audit trail must be semantically stable after projection.
  if (debtMigrations.length === 0 && priorReceipt) {
    modelCase.debt_class_migrations = priorReceipt;
  }

  const migrations = debtMigrations.map((migration) => ({
    kind: "debt_class_alias",
    ...migration,
  }));

  // Frozen synthetic fixed-point fixtures pre-date the sealed broker-consensus
  // custody contract. Project only their already-visible houses and already-
  // supplied provider values; never infer a house, value, period or definition.
  for (const [metricId, metric] of Object.entries(modelCase.broker_pack?.metrics ?? {})) {
    const houseNames = Object.keys(metric?.brokers ?? {}).sort();
    if (!metric.consensus_membership) {
      const definitionSignature = brokerMetricDefinitionSignature(modelCase, metricId);
      metric.consensus_membership = sealBrokerConsensusMembership({
        schema_version: "broker-consensus-membership/1.0",
        metric_id: metricId,
        contributors: houseNames.map((houseName) => ({
          house_name: houseName,
          status: "included",
          reasons: [],
          definition_signature: definitionSignature,
          period_status: ["included", "included", "included"],
          period_reasons: [[], [], []],
        })),
      });
      migrations.push({ kind: "sealed_broker_consensus_membership", metric_id: metricId });
    }
    if (!metric.provider_consensus_source) {
      if (
        !Array.isArray(metric.provider_consensus) ||
        metric.provider_consensus.length !== 3 ||
        metric.provider_consensus.some((value) => value !== null && !Number.isFinite(Number(value)))
      ) {
        throw new Error(
          `Archived fixed-point broker metric ${metricId} lacks a valid explicit provider-consensus series.`,
        );
      }
      metric.provider_consensus_source = {
        source_note:
          `Frozen synthetic fixed-point fixture explicitly supplied ${metricId} provider-consensus values; compatibility projection preserves them without re-estimation.`,
        period_lineage: [0, 1, 2].map(
          (periodIndex) =>
            `Frozen synthetic fixed-point fixture | provider_consensus[${periodIndex}]`,
        ),
      };
      migrations.push({ kind: "provider_consensus_source_custody", metric_id: metricId });
    }
  }

  // The archived compiler wrote schedule_link on protected cash-flow totals,
  // even though the row itself already carries the exact same-period formula.
  // Relabel only that closed shape; no formula, member or value is inferred.
  for (const row of modelCase.statement_structure?.cash_flow ?? []) {
    const role = canonicalSemanticRole(row.semantic_role ?? row.row_id);
    const rule = row.calculation;
    const exactSamePeriodRule =
      PROTECTED_CASH_FLOW_ROLES.has(role) &&
      SAME_PERIOD_OPERATORS.has(rule?.operator) &&
      Array.isArray(rule?.refs) &&
      rule.refs.length > 0 &&
      !rule.refs.includes(row.row_id);
    const authorities = row.forecast_period_authorities;
    if (
      !exactSamePeriodRule ||
      !Array.isArray(authorities) ||
      authorities.length !== 3 ||
      !authorities.every((authority) => authority?.method === "schedule_link")
    ) {
      continue;
    }
    row.forecast_period_authorities = authorities.map((authority) => ({
      ...authority,
      method: "accounting_identity",
      source_kind: "formula",
      note: "Archived schedule label migrated to the row's declared same-period accounting identity.",
    }));
    migrations.push({ kind: "protected_cash_identity", row_id: row.row_id });
  }

  // A non-zero series in these archived cases was already an explicit model
  // input. Stamp that fact without re-estimating or reclassifying the values.
  const residual = modelCase.other_interest;
  if (
    !modelCase.other_interest_authority &&
    Array.isArray(residual) &&
    residual.length === 3 &&
    residual.every((value) => Number.isFinite(Number(value))) &&
    residual.some((value) => Math.abs(Number(value)) > 1e-12)
  ) {
    modelCase.other_interest_authority = {
      contract_version: "residual-interest-authority/1.0",
      method: "explicit_forecast_assumption",
      basis_note:
        "The frozen archived case explicitly carries this three-period residual-interest forecast; compatibility projection preserves it without re-estimation.",
      source_ids: [],
    };
    migrations.push({ kind: "residual_interest_authority" });
  }
  return migrations;
}

function assertLegacyFixedPointAdapter() {
  const archived = {
    instruments: [
      {
        instrument_id: "old_bond",
        class: "fixed_bond",
        opening_balance: 125,
        coupon_or_all_in_rate: [0.04],
      },
      { instrument_id: "current_rcf", class: "rcf", opening_balance: 10 },
    ],
    forecast_authority_contract_version: "waterfall_v1",
    other_interest: [1, 2, 3],
    statement_structure: {
      income_statement: [],
      cash_flow: [{
        row_id: "net_change_in_cash",
        semantic_role: "net_change_in_cash",
        row_type: "calculation",
        calculation: { operator: "sum", refs: ["cash_from_operations", "cash_from_investing"] },
        forecast_period_authorities: [0, 1, 2].map(() => ({
          method: "schedule_link",
          source_kind: "schedule",
          material: true,
        })),
      }],
    },
  };
  const economics = archived.instruments.map(({ class: _class, ...instrument }) => instrument);
  const calculationBefore = JSON.stringify(
    archived.statement_structure.cash_flow[0].calculation,
  );
  const residualBefore = JSON.stringify(archived.other_interest);
  const migrations = adaptLegacyFixedPointCase(archived);
  assert.deepEqual(
    archived.instruments.map((instrument) => instrument.class),
    ["bond_fixed", "rcf"],
  );
  assert.deepEqual(
    archived.instruments.map(({ class: _class, ...instrument }) => instrument),
    economics,
    "legacy debt projection changed instrument economics",
  );
  assert.equal(migrations.length, 3, "archived fixed-point projection was vacuous");
  assert.ok(
    migrations.some((migration) => migration.kind === "debt_class_alias") &&
      migrations.some((migration) => migration.kind === "protected_cash_identity") &&
      migrations.some((migration) => migration.kind === "residual_interest_authority"),
    "archived fixed-point migrations were not independently exercised",
  );
  assert.equal(
    JSON.stringify(archived.statement_structure.cash_flow[0].calculation),
    calculationBefore,
    "protected cash-flow migration changed formula membership",
  );
  assert.equal(JSON.stringify(archived.other_interest), residualBefore);
  assert.deepEqual(validateResidualInterestAuthority(archived), []);
  const projected = structuredClone(archived);
  assert.equal(adaptLegacyFixedPointCase(archived).length, 0);
  assert.deepEqual(archived, projected, "legacy debt projection is not idempotent");
  assert.throws(
    () => adaptLegacyFixedPointCase({
      instruments: [{ instrument_id: "mutant", class: "invented_debt_class" }],
    }),
    /unrecognised debt classes/,
    "unknown debt-class mutation must fail closed",
  );

  const temporalMutation = structuredClone(archived);
  const cashIdentity = temporalMutation.statement_structure.cash_flow[0];
  cashIdentity.calculation = { operator: "prior_period", refs: [cashIdentity.row_id] };
  cashIdentity.forecast_period_authorities = cashIdentity.forecast_period_authorities.map(
    (authority) => ({ ...authority, method: "schedule_link", source_kind: "schedule" }),
  );
  adaptLegacyFixedPointCase(temporalMutation);
  assert.ok(
    validateForecastAuthorities(
      temporalMutation,
      temporalMutation.statement_structure.cash_flow,
    ).some((error) => error.includes("protected cash-flow identity")),
    "temporal protected-cash mutation must reach the production validator",
  );

  const residualMutation = structuredClone(archived);
  residualMutation.other_interest = [1, 2];
  delete residualMutation.other_interest_authority;
  adaptLegacyFixedPointCase(residualMutation);
  assert.ok(
    validateResidualInterestAuthority(residualMutation).length > 0,
    "malformed residual-interest mutation must reach the production validator",
  );
}

function readAdaptedCase(casePath) {
  const modelCase = JSON.parse(fs.readFileSync(casePath, "utf8"));
  adaptLegacyFixedPointCase(modelCase);
  return modelCase;
}

function casesFromArguments(arguments_) {
  const paths = [];
  const entries = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const entry = arguments_[index];
    if (entry === "--manifest") {
      const manifestPath = arguments_[index + 1];
      if (!manifestPath) throw new Error("--manifest requires a JSON path.");
      const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
      if (
        manifest.schema_version !== "fixed-point-case-manifest/1.0" ||
        !Array.isArray(manifest.cases) ||
        manifest.cases.length === 0
      ) {
        throw new Error("Fixed-point case manifest is malformed or empty.");
      }
      const base = path.dirname(path.resolve(manifestPath));
      entries.push(...manifest.cases.map((item) => path.resolve(base, String(item))));
      index += 1;
      continue;
    }
    entries.push(entry);
  }
  for (const entry of entries) {
    const resolved = path.resolve(entry);
    if (!fs.existsSync(resolved)) throw new Error(`Case input not found: ${resolved}`);
    if (fs.statSync(resolved).isDirectory()) {
      for (const name of fs.readdirSync(resolved).filter((item) => item.endsWith(".json")).sort()) {
        paths.push(path.join(resolved, name));
      }
    } else {
      paths.push(resolved);
    }
  }
  return paths;
}

const casePaths = casesFromArguments(process.argv.slice(2));
if (casePaths.length === 0) {
  throw new Error(
    "usage: node scripts/run_fixed_point_constitution_tests.mjs <case.json> [case.json ...] | --manifest <fixed-point-cases.json>",
  );
}

assertLegacyFixedPointAdapter();

const results = [];
let mutationSource = null;
for (const casePath of casePaths) {
  const modelCase = readAdaptedCase(casePath);
  const onCase = structuredClone(modelCase);
  onCase.controls.circularity = 1;
  const offCase = structuredClone(modelCase);
  offCase.controls.circularity = 0;
  const on = solveCase(onCase);
  const off = solveCase(offCase);
  const errors = validateCircularityPair(modelCase, on, off);
  assert.deepEqual(errors, [], `${modelCase.case_id}: ${errors.join(" | ")}`);
  const materialSweepIndex = off.forecast.findIndex(
    (period) =>
      Math.abs(Number(period.rcf_draw ?? 0)) > 1e-6 ||
      Math.abs(Number(period.rcf_repayment ?? 0)) > 1e-6,
  );
  if (!mutationSource && materialSweepIndex >= 0) {
    mutationSource = { modelCase, off, materialSweepIndex };
  }
  results.push({
    case_id: modelCase.case_id,
    circularity_on: {
      iterations: on.iterations,
      residual: on.residual,
      active_scc_nodes:
        on.equation_graph_evidence.active_sccs[0]?.nodes.length ?? 0,
    },
    circularity_off: {
      iterations: off.iterations,
      residual: off.residual,
      active_scc_nodes: off.equation_graph_evidence.active_sccs.length,
      material_sweep_periods: off.forecast.filter(
        (period) =>
          Math.abs(Number(period.rcf_draw ?? 0)) > 1e-6 ||
          Math.abs(Number(period.rcf_repayment ?? 0)) > 1e-6,
      ).length,
    },
  });
}

const firstCase = readAdaptedCase(casePaths[0]);
firstCase.controls.circularity = 0;
const firstOff = solveCase(firstCase);
const mutations = [];
function mutation(name, mutate, fragment, baseCase = firstCase, baseSolution = firstOff) {
  const candidate = structuredClone(baseSolution);
  mutate(candidate);
  const errors = validateFixedPointSolution(baseCase, candidate);
  assert.ok(
    errors.some((error) => error.includes(fragment)),
    `${name} should fail with ${fragment}; got ${errors.join(" | ")}`,
  );
  mutations.push({ name, status: "PASS", violations: errors.length });
}

mutation(
  "interest survives breaker",
  (solution) => { solution.forecast[0].gross_interest = 1; },
  "gross_interest_expense is 1 with circularity off",
);
mutation(
  "solver vector missing node",
  (solution) => { solution.equation_graph_evidence.solver_declaration.state_vector.push({ node_id: "cash.cfo", tolerance_class: "currency" }); },
  "state_vector",
);
mutation(
  "runtime tolerance drift",
  (solution) => { solution.equation_graph_evidence.solver_runtime.absolute_tolerance = 1e-4; },
  "absolute_tolerance drifted",
);
mutation(
  "reported convergence tolerance drift",
  (solution) => { solution.convergence_tolerance = 1e-4; },
  "convergence_tolerance drifted",
);

assert.ok(
  mutationSource,
  "at least one supplied archetype must exercise a real RCF draw or repayment in breaker mode",
);
{
  const { modelCase, off, materialSweepIndex } = mutationSource;
  const offCase = structuredClone(modelCase);
  offCase.controls.circularity = 0;
  mutation(
    "disabled RCF sweep",
    (solution) => {
      const period = solution.forecast[materialSweepIndex];
      period.rcf_draw = 0;
      period.rcf_draw_native = 0;
      period.rcf_repayment = 0;
      period.rcf_repayment_native = 0;
    },
    "does not match independently recomputed sweep value",
    offCase,
    off,
  );
}

console.log(JSON.stringify({
  status: "PASS",
  archetypes: results,
  mutations,
}, null, 2));
