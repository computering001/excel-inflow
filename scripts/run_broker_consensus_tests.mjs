#!/usr/bin/env node

import fs from "node:fs";
import { compileForecastPlan } from "./lib/forecast_candidate_compiler.mjs";
import {
  brokerConsensusFormula,
  compareDefinitionSignatures,
  compileBrokerConsensusMetric,
  resolveBrokerConsensusSelection,
  sealBrokerConsensusMembership,
} from "./lib/broker_consensus.mjs";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const signature = Object.freeze({
  metric_id: "adjusted_ebitda",
  accounting_basis: "IFRS",
  operation_scope: "continuing",
  adjustment_basis: "adjusted",
  currency: "GBP",
  units: "millions",
  fiscal_calendar: "fixed_date",
  cash_flow_basis: null,
  lease_basis: "including_leases",
});

function modelCase({
  selection = "Model Consensus",
  brokers = {
    "House A": [100, 110, 120],
    "House B": [102, 112, 122],
    "House C": [104, 114, 124],
  },
  provider = undefined,
  mutateContributor = null,
} = {}) {
  const contributors = Object.keys(brokers).sort().map((houseName) => ({
    house_name: houseName,
    status: "included",
    reasons: [],
    definition_signature: structuredClone(signature),
    period_status: ["included", "included", "included"],
    period_reasons: [[], [], []],
  }));
  if (mutateContributor) mutateContributor(contributors);
  const membership = sealBrokerConsensusMembership({
    schema_version: "broker-consensus-membership/1.0",
    metric_id: "adjusted_ebitda",
    contributors,
  });
  return {
    issuer: {
      accounting_basis: "IFRS",
      reporting_currency: "GBP",
      units: "millions",
      fiscal_calendar: "fixed_date",
    },
    controls: { broker_case: selection },
    broker_pack: {
      metrics: {
        adjusted_ebitda: {
          label: "Adjusted EBITDA",
          definition_signature: structuredClone(signature),
          brokers,
          ...(provider ? { provider_consensus: provider } : {}),
          ...(provider ? {
            provider_consensus_source: {
              source_note: "Neutral provider consensus note",
              period_lineage: ["p1/table/cell", "p2/table/cell", "p3/table/cell"],
            },
          } : {}),
          consensus_membership: membership,
        },
      },
    },
  };
}

let assertions = 0;
const check = (condition, message) => {
  assert(condition, message);
  assertions += 1;
};

check(
  compareDefinitionSignatures(
    { accounting_basis: "ifrs", fiscal_calendar: "52-53 week", currency: "usd" },
    { accounting_basis: "IFRS", fiscal_calendar: "52_53_WEEK", currency: "USD" },
  ).compatible,
  "equivalent definition enum spelling was treated as an economic mismatch",
);
check(
  !compareDefinitionSignatures(
    { accounting_basis: "IFRS", currency: "USD" },
    { accounting_basis: "US_GAAP", currency: "USD" },
  ).compatible,
  "genuinely different accounting bases were normalized together",
);

for (const brokers of [
  { "House A": [100, 110, 120] },
  { "House A": [100, 110, 120], "House B": [102, 112, 122] },
  {
    "House A": [100, 110, 120],
    "House B": [102, 112, 122],
    "House C": [104, 114, 124],
  },
]) {
  const compiled = compileBrokerConsensusMetric(modelCase({ brokers }), "adjusted_ebitda", {
    requireSealed: true,
  });
  check(
    compiled.periods[0].contributor_count === Object.keys(brokers).length,
    "one/two/three-house contributor census drifted",
  );
}

const providerAbsent = compileBrokerConsensusMetric(modelCase(), "adjusted_ebitda");
check(!providerAbsent.provider_consensus_supplied, "absent provider line was manufactured");
const providerDifferent = compileBrokerConsensusMetric(
  modelCase({ provider: [99, 116, 125] }),
  "adjusted_ebitda",
);
check(providerDifferent.provider_consensus_supplied, "supplied provider line disappeared");
check(providerDifferent.periods[0].model_consensus === 102, "model average used provider value");
check(providerDifferent.periods[0].provider_consensus === 99, "provider value changed");
check(providerDifferent.periods[0].difference === -3, "consensus difference is wrong");

const blankCase = modelCase();
blankCase.broker_pack.metrics.adjusted_ebitda.brokers["House C"][1] = null;
const blank = compileBrokerConsensusMetric(blankCase, "adjusted_ebitda");
check(blank.periods[1].contributor_count === 2, "blank house entered the mean");
check(blank.periods[1].model_consensus === 111, "blank-house mean is wrong");

for (const mutateContributor of [
  (contributors) => {
    contributors[1].status = "rejected";
    contributors[1].reasons = ["quality gate rejected"];
  },
  (contributors) => {
    contributors[1].definition_signature.units = "thousands";
  },
  (contributors) => {
    contributors[1].definition_signature.adjustment_basis = "statutory";
  },
  (contributors) => {
    contributors[1].definition_signature.currency = "USD";
  },
  (contributors) => {
    contributors[1].period_status[1] = "wrong_period";
    contributors[1].period_reasons[1] = ["wrong fiscal period"];
  },
]) {
  const compiled = compileBrokerConsensusMetric(
    modelCase({ mutateContributor }),
    "adjusted_ebitda",
  );
  check(compiled.periods[1].contributor_count === 2, "ineligible house entered consensus");
  check(compiled.periods[1].excluded_count === 1, "excluded count did not reconcile");
  const formula = brokerConsensusFormula(
    "E",
    new Map([["House A", 10], ["House B", 11], ["House C", 12]]),
    compiled.periods[1],
  );
  check(formula.startsWith("=IFERROR(AVERAGE("), "Model Consensus is not a formula");
  check(!formula.includes("E11"), "Model Consensus formula retained an excluded house");
}

const named = modelCase({ selection: "House B" });
check(
  resolveBrokerConsensusSelection(named, "adjusted_ebitda", 0).value === 102,
  "named-house selection failed",
);
const selectedModel = modelCase({ selection: "Model Consensus", provider: [99, 116, 125] });
check(
  resolveBrokerConsensusSelection(selectedModel, "adjusted_ebitda", 0).value === 102,
  "Model Consensus selection used Provider Consensus",
);
const selectedLegacy = modelCase({ selection: "Consensus", provider: [99, 116, 125] });
check(
  resolveBrokerConsensusSelection(selectedLegacy, "adjusted_ebitda", 0).value === 102,
  "legacy Consensus alias did not resolve to Model Consensus",
);
const selectedProvider = modelCase({ selection: "Provider Consensus", provider: [99, 116, 125] });
check(
  resolveBrokerConsensusSelection(selectedProvider, "adjusted_ebitda", 0).value === 99,
  "Provider Consensus selection did not preserve the sourced value",
);
const unavailableProvider = modelCase({ selection: "Provider Consensus" });
check(
  resolveBrokerConsensusSelection(unavailableProvider, "adjusted_ebitda", 0).value === null,
  "absent Provider Consensus silently fell back",
);

// mp2-E5 — Forecast Waterfall is a declared authority in its own right, never
// a silent identity with Model Consensus. The consensus compiler carries no
// per-row waterfall composition, so the selection degrades to the compatible-
// house consensus basis and says so.
const selectedWaterfall = modelCase({ selection: "Forecast Waterfall" });
const waterfall = resolveBrokerConsensusSelection(selectedWaterfall, "adjusted_ebitda", 0);
check(
  waterfall.source_kind === "forecast_waterfall",
  `Forecast Waterfall did not disclose its own source kind: ${waterfall.source_kind}`,
);
check(
  waterfall.selected_mode === "Forecast Waterfall",
  "Forecast Waterfall selection lost its selected mode",
);
check(
  waterfall.value === 102,
  `Forecast Waterfall fallback drifted from the consensus value: ${waterfall.value}`,
);
check(
  /waterfall/i.test(waterfall.source_name) && /consensus/i.test(waterfall.source_name),
  `Forecast Waterfall source_name does not name its waterfall basis: ${waterfall.source_name}`,
);
const waterfallDegrades = (waterfall.findings ?? []).filter(
  (finding) => finding.severity === "DEGRADE",
);
check(
  waterfallDegrades.length === 1 &&
    /consensus/i.test(waterfallDegrades[0].message ?? ""),
  "Forecast Waterfall fell back to the consensus basis without exactly one DEGRADE finding naming it",
);
const modelSelectionForContrast = resolveBrokerConsensusSelection(
  modelCase({ selection: "Model Consensus" }),
  "adjusted_ebitda",
  0,
);
check(
  modelSelectionForContrast.source_kind === "model_consensus" &&
    (modelSelectionForContrast.findings ?? []).length === 0,
  "Model Consensus selection was polluted by the Forecast Waterfall split",
);

// Divergence contract on the pinned standard-maximal-v2 corpus case: under
// Forecast Waterfall every broker-declared row keeps the identical consensus
// rung EXCEPT the anchor row, which the accounting identity derives instead.
const corpusCase = JSON.parse(
  fs.readFileSync(new URL("../test-fixtures/cases/standard-maximal-v2.json", import.meta.url), "utf8"),
);
const brokerDeclaredRowIds = [
  ...(corpusCase.statement_structure.income_statement ?? []),
  ...(corpusCase.statement_structure.cash_flow ?? []),
]
  .filter((row) => row.broker_metric_id || row.forecast_treatment === "broker")
  .map((row) => row.row_id);
const planValuesByMode = (selection) => {
  const scoped = structuredClone(corpusCase);
  scoped.controls.broker_case = selection;
  const plan = compileForecastPlan(scoped, scoped.statement_structure);
  const byRow = new Map();
  for (const state of plan.states ?? []) {
    if (!byRow.has(state.row_id)) byRow.set(state.row_id, { methods: [], values: [] });
    const entry = byRow.get(state.row_id);
    entry.methods.push(state.method);
    entry.values.push(Number.isFinite(Number(state.value)) ? Number(state.value) : null);
  }
  return byRow;
};
const consensusPlan = planValuesByMode("Model Consensus");
const waterfallPlan = planValuesByMode("Forecast Waterfall");
check(consensusPlan.size > 0 && waterfallPlan.size > 0, "forecast plans for the divergence fixture were empty");
const divergedRows = brokerDeclaredRowIds.filter((rowId) => {
  const consensusEntry = consensusPlan.get(rowId);
  const waterfallEntry = waterfallPlan.get(rowId);
  if (!consensusEntry || !waterfallEntry) return true;
  return (
    JSON.stringify(waterfallEntry.methods) !== JSON.stringify(consensusEntry.methods) ||
    JSON.stringify(waterfallEntry.values) !== JSON.stringify(consensusEntry.values)
  );
});
check(
  divergedRows.length === 1 && divergedRows[0] === "adjusted_ebitda",
  `Forecast Waterfall diverged from consensus on unexpected rows: ${divergedRows.join(", ") || "(none)"}`,
);
check(
  (waterfallPlan.get("adjusted_ebitda")?.methods ?? []).every((method) => method === "accounting_identity"),
  "the anchor row under Forecast Waterfall did not move to the accounting-identity derivation",
);
for (const rowId of brokerDeclaredRowIds.filter((id) => id !== "adjusted_ebitda")) {
  check(
    JSON.stringify(waterfallPlan.get(rowId)) === JSON.stringify(consensusPlan.get(rowId)),
    `non-anchor broker row ${rowId} changed under Forecast Waterfall`,
  );
}

const stale = modelCase();
stale.broker_pack.metrics.adjusted_ebitda.consensus_membership.contributors[0].status = "rejected";
let staleCaught = false;
try {
  compileBrokerConsensusMetric(stale, "adjusted_ebitda", { requireSealed: true });
} catch (error) {
  staleCaught = /hash/.test(String(error));
}
check(staleCaught, "stale membership mutation escaped its seal");

const unsealed = modelCase();
delete unsealed.broker_pack.metrics.adjusted_ebitda.consensus_membership;
let unsealedCaught = false;
try {
  compileBrokerConsensusMetric(unsealed, "adjusted_ebitda");
} catch (error) {
  unsealedCaught = /requires sealed consensus membership/.test(String(error));
}
check(unsealedCaught, "an absent membership silently inferred all visible houses");

console.log(JSON.stringify({
  status: "PASS",
  assertions,
  scenarios: 17,
  model_provider_separation: true,
  total_violations: 0,
}, null, 2));
