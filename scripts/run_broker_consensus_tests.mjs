#!/usr/bin/env node

import {
  brokerConsensusFormula,
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

const stale = modelCase();
stale.broker_pack.metrics.adjusted_ebitda.consensus_membership.contributors[0].status = "rejected";
let staleCaught = false;
try {
  compileBrokerConsensusMetric(stale, "adjusted_ebitda", { requireSealed: true });
} catch (error) {
  staleCaught = /hash/.test(String(error));
}
check(staleCaught, "stale membership mutation escaped its seal");

console.log(JSON.stringify({
  status: "PASS",
  assertions,
  scenarios: 15,
  model_provider_separation: true,
  total_violations: 0,
}, null, 2));
