#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  compileInstrumentPeriodState,
  definitionBasisValuesForPeriod,
  mandatoryRepaymentForPeriod,
  validateInstrumentPeriodStateArtifact,
} from "./lib/instrument_period_state.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { validateSemanticArtifacts } from "./lib/validation_invariants.mjs";

const periods = [
  { date: "2023-12-31", status: "historical" },
  { date: "2024-12-31", status: "historical" },
  { date: "2025-12-31", status: "historical" },
  { date: "2026-12-31", status: "forecast" },
  { date: "2027-12-31", status: "forecast" },
  { date: "2028-12-31", status: "forecast" },
];

function instrument(instrumentId, overrides = {}) {
  return {
    instrument_id: instrumentId,
    class: "bond_fixed",
    currency: "GBP",
    balance_basis: "native_principal",
    opening_balance: 100,
    new_issuance: [0, 0, 0],
    scheduled_amortisation: [0, 0, 0],
    rate_type: "fixed",
    coupon_or_all_in_rate: [0.05, 0.05, 0.05],
    cash_interest: true,
    include_in_gross_debt: true,
    include_in_net_debt: true,
    maturity_treatment: "non_maturing_within_forecast",
    ...overrides,
  };
}

const modelCase = {
  case_id: "instrument_period_state_fixture",
  issuer: { reporting_currency: "GBP" },
  periods,
  controls: { debt_maturities_roll: 1, circularity: 1 },
  rcf_policy: { instrument_id: "liquidity_rcf" },
  instruments: [
    instrument("bullet"),
    instrument("amortising", { scheduled_amortisation: [15, 10, 5] }),
    instrument("maturing", { maturity_date: "2026-06-30", maturity_treatment: "contractual" }),
    instrument("zero_balance_maturing", {
      opening_balance: 0,
      maturity_date: "2027-09-15",
      maturity_treatment: "contractual",
    }),
    instrument("issued_before_maturity", {
      opening_balance: 0,
      new_issuance: [0, 75, 0],
      new_issuance_dates: [null, "2027-02-01", null],
      maturity_date: "2027-09-15",
      maturity_treatment: "contractual",
    }),
    instrument("evergreen_dated", {
      maturity_date: "2026-06-30",
      maturity_treatment: "non_maturing_within_forecast",
    }),
    instrument("issuance", {
      opening_balance: 0,
      new_issuance: [120, 0, 0],
      new_issuance_dates: ["2026-04-01", null, null],
      non_cash_movement_components: { fair_value: [3, 0, 0], other: [2, 0, 0] },
    }),
    instrument("pik_note", { cash_interest: false, pik_rate: [0.1, 0.1, 0.1] }),
    instrument("liquidity_rcf", {
      class: "rcf",
      opening_balance: 40,
      maturity_date: "2026-03-31",
      maturity_treatment: "contractual",
    }),
    instrument("bilateral_revolver", {
      class: "rcf",
      opening_balance: 30,
      maturity_date: "2027-06-30",
      maturity_treatment: "contractual",
    }),
    instrument("eur_native", {
      currency: "EUR",
      opening_balance: 50,
      balance_basis: "native_principal",
    }),
    instrument("usd_carrying", {
      currency: "USD",
      opening_balance: 80,
      balance_basis: "reporting_currency_carrying_value",
    }),
  ],
  lease_policy: {
    mode: "simple_roll_forward",
    historical_liabilities: [34, 37, 40],
    principal_repayment: [8, 9, 10],
    additions: [12, 10, 11],
    effective_rate: [0.05, 0.05, 0.05],
    interest_basis: "total_liability",
    include_in_gross_debt: true,
    include_in_net_debt: true,
    include_in_leverage: true,
  },
  historical_supplement: {
    reported_net_debt_basis_status: "reconciled_difference",
    reported_net_debt_adjustment: [
      { label: "Unamortized fair-value adjustment", values: [0, 0, 0, -2, -1, 0] },
    ],
  },
  fx: {
    EUR: {
      quote: "reporting_per_native",
      average_rates: [1.35, 1.4, 1.45, 1.5, 1.55, 1.6],
      period_end_rates: [1.4, 1.45, 1.5, 1.6, 1.65, 1.7],
    },
    USD: {
      quote: "reporting_per_native",
      average_rates: [7, 7, 7, 9, 9, 9],
      period_end_rates: [8, 8, 8, 10, 10, 10],
    },
  },
};

const artifact = compileInstrumentPeriodState(modelCase);
const schema = JSON.parse(await fs.readFile(
  new URL("../assets/instrument-period-state-v1.schema.json", import.meta.url),
  "utf8",
));
assert.deepEqual(validateJsonSchema(artifact, schema), [], "Compiled artifact does not satisfy its strict schema.");
assert.deepEqual(validateInstrumentPeriodStateArtifact(artifact), []);
assert.equal(artifact.states.length, (modelCase.instruments.length + 1) * 3);

const statesFor = (instrumentId) => artifact.states.filter((state) => state.instrument_id === instrumentId);
assert.deepEqual(statesFor("bullet").map((state) => state.ending_post_repayment.basis_amount), [100, 100, 100]);
assert.deepEqual(statesFor("amortising").map((state) => state.ending_post_repayment.basis_amount), [85, 75, 70]);

const maturity = statesFor("maturing");
assert.equal(maturity[0].maturity, "2026-06-30");
assert.equal(maturity[0].repayment_state, "maturity");
assert.equal(maturity[0].maturity_repayment.basis_amount, 100);
assert.equal(maturity[0].ending_post_repayment.basis_amount, 0);
assert.ok(maturity[0].active_fraction > 0.49 && maturity[0].active_fraction < 0.51);

const zeroBalanceMaturity = statesFor("zero_balance_maturing");
assert.deepEqual(
  zeroBalanceMaturity.map((state) => ({
    repayment_state: state.repayment_state,
    mandatory_repayment: state.inclusion.mandatory_repayment,
    maturity_repayment: state.maturity_repayment.basis_amount,
  })),
  [0, 1, 2].map(() => ({
    repayment_state: "none",
    mandatory_repayment: false,
    maturity_repayment: 0,
  })),
  "A dated zero-balance instrument invented a mandatory maturity state.",
);
assert.ok(
  zeroBalanceMaturity.every((state) => state.interest.basis_amount === 0),
  "A zero-opening instrument with no issuance invented interest.",
);

const issuedBeforeMaturity = statesFor("issued_before_maturity");
assert.equal(issuedBeforeMaturity[0].repayment_state, "none");
assert.equal(issuedBeforeMaturity[1].issuance.basis_amount, 75);
assert.equal(issuedBeforeMaturity[1].maturity_repayment.basis_amount, 75);
assert.equal(issuedBeforeMaturity[1].repayment_state, "maturity");
assert.equal(issuedBeforeMaturity[1].inclusion.mandatory_repayment, true);
assert.equal(issuedBeforeMaturity[1].ending_post_repayment.basis_amount, 0);

const evergreenDated = statesFor("evergreen_dated");
assert.deepEqual(
  evergreenDated.map((state) => state.ending_post_repayment.basis_amount),
  [100, 100, 100],
  "A non-maturing declaration was overridden by an in-horizon audit date.",
);
assert.ok(
  evergreenDated.every(
    (state) =>
      state.repayment_state === "none" &&
      state.maturity_repayment.basis_amount === 0,
  ),
);

const issuance = statesFor("issuance")[0];
assert.equal(issuance.issuance.basis_amount, 120);
assert.equal(issuance.fair_value_movement.basis_amount, 3);
assert.equal(issuance.other_non_cash_movement.basis_amount, 2);
assert.equal(issuance.ending_post_repayment.basis_amount, 125);
assert.ok(issuance.average_interest_balance.basis_amount > 90);
assert.ok(issuance.average_interest_balance.basis_amount < 100);

const pik = statesFor("pik_note")[0];
assert.ok(pik.pik_accretion.basis_amount > 10);
assert.equal(pik.pricing_state, "priced_pik");
assert.equal(pik.ending_post_repayment.basis_amount, 100 + pik.pik_accretion.basis_amount);

for (const rcf of statesFor("liquidity_rcf")) {
  assert.equal(rcf.repayment_state, "discretionary_rcf");
  assert.equal(rcf.maturity_repayment.basis_amount, 0);
  assert.equal(rcf.inclusion.mandatory_repayment, false);
  assert.equal(rcf.inclusion.liquidity, true);
}

const bilateral = statesFor("bilateral_revolver");
assert.equal(bilateral[0].repayment_state, "none");
assert.equal(bilateral[0].inclusion.liquidity, false);
assert.equal(bilateral[1].repayment_state, "maturity");
assert.equal(bilateral[1].maturity_repayment.basis_amount, 30);
assert.equal(bilateral[1].inclusion.mandatory_repayment, true);
assert.equal(bilateral[1].ending_post_repayment.basis_amount, 0);

const eur = statesFor("eur_native")[0];
assert.equal(eur.translation.method, "native_principal_to_reporting");
assert.equal(eur.opening.reporting_amount, 75);
assert.equal(eur.ending_post_repayment.reporting_amount, 80);

const carrying = statesFor("usd_carrying")[0];
assert.equal(carrying.currency, "USD");
assert.equal(carrying.translation.basis_currency, "GBP");
assert.equal(carrying.translation.method, "reporting_currency_carrying_value_no_translation");
assert.equal(carrying.opening.reporting_amount, 80);
assert.equal(carrying.ending_post_repayment.reporting_amount, 80);

const leases = statesFor("lease_liability");
assert.equal(leases.length, 3);
assert.ok(leases.every((state) => state.class === "lease_liability" && state.family === "lease"));
assert.deepEqual(leases.map((state) => state.other_non_cash_movement.basis_amount), [0, 0, 0]);
assert.deepEqual(leases.map((state) => state.ending_post_repayment.basis_amount), [
  46.15384615384615,
  49.54635108481262,
  53.112830627623524,
]);
assert.ok(leases.every((state) => state.inclusion.leverage && !state.inclusion.liquidity));

const periodZeroStates = artifact.states.filter((state) => state.period_index === 0);
const rcfEndingOverride = 25;
const eligibleCash = 60;
const definitionBasis = definitionBasisValuesForPeriod(artifact, 0, {
  endingReportingOverrides: { liquidity_rcf: rcfEndingOverride },
  eligibleCash,
  liquidityCash: 75,
});
const manualGrossExcludingLeases = periodZeroStates
  .filter((state) => state.family !== "lease" && state.inclusion.gross_debt)
  .reduce(
    (total, state) =>
      total +
      (state.instrument_id === "liquidity_rcf"
        ? rcfEndingOverride
        : state.ending_post_repayment.reporting_amount),
    0,
  );
const manualLeverageDebt = periodZeroStates
  .filter((state) => state.inclusion.leverage)
  .reduce(
    (total, state) =>
      total +
      (state.instrument_id === "liquidity_rcf"
        ? rcfEndingOverride
        : state.ending_post_repayment.reporting_amount),
    0,
  );
assert.equal(
  definitionBasis.values.model_gross_debt_excluding_leases,
  manualGrossExcludingLeases,
);
assert.equal(
  definitionBasis.values.leverage_numerator,
  manualLeverageDebt - eligibleCash,
);
assert.equal(
  mandatoryRepaymentForPeriod(artifact, 0),
  periodZeroStates
    .filter((state) => state.inclusion.mandatory_repayment)
    .reduce(
      (total, state) =>
        total +
        state.scheduled_amortisation.reporting_amount +
        state.maturity_repayment.reporting_amount,
      0,
    ),
);

const membershipMutation = structuredClone(artifact);
for (const state of membershipMutation.states.filter(
  (candidate) => candidate.instrument_id === "bullet",
)) {
  state.inclusion.gross_debt = false;
  state.inclusion.net_debt = false;
  state.inclusion.leverage = false;
}
const mutatedDefinitionBasis = definitionBasisValuesForPeriod(
  membershipMutation,
  0,
  {
    endingReportingOverrides: { liquidity_rcf: rcfEndingOverride },
    eligibleCash,
    liquidityCash: 75,
  },
);
assert.ok(
  Math.abs(
    definitionBasis.values.model_gross_debt_excluding_leases -
      mutatedDefinitionBasis.values.model_gross_debt_excluding_leases -
      100,
  ) < 1e-9,
  "Debt-definition output did not consume compiled gross-debt membership.",
);
assert.ok(
  Math.abs(
    definitionBasis.values.leverage_numerator -
      mutatedDefinitionBasis.values.leverage_numerator -
      100,
  ) < 1e-9,
  "Leverage output did not consume compiled leverage membership.",
);

const mandatoryMembershipMutation = structuredClone(artifact);
const mandatoryMembershipState = mandatoryMembershipMutation.states.find(
  (state) => state.instrument_id === "amortising" && state.period_index === 0,
);
mandatoryMembershipState.inclusion.mandatory_repayment = false;
assert.equal(
  mandatoryRepaymentForPeriod(artifact, 0) -
    mandatoryRepaymentForPeriod(mandatoryMembershipMutation, 0),
  15,
  "Mandatory repayment did not consume compiled repayment membership.",
);

const semanticManifest = {
  schema_version: 1,
  contract_version: 2,
  case_id: modelCase.case_id,
  periods: modelCase.periods.map((period, period_index) => ({
    ...period,
    period_index,
  })),
  instrument_period_state: artifact,
  definition_basis_graph: artifact.definition_basis_graph,
  source_inventory: [],
  edges: [],
  nodes: modelCase.instruments.map((candidate) => {
    const periodStates = statesFor(candidate.instrument_id);
    return {
      node_id: `instrument.${candidate.instrument_id}.balance`,
      node_kind: "debt_instrument",
      instrument_id: candidate.instrument_id,
      instrument_period_state_ids: periodStates.map((state) => state.state_id),
      instrument_period_membership: periodStates.map((state) =>
        structuredClone(state.inclusion),
      ),
    };
  }),
};
assert.deepEqual(validateSemanticArtifacts(semanticManifest, []), []);
const semanticMembershipMutation = structuredClone(semanticManifest);
semanticMembershipMutation.nodes[0].instrument_period_membership[0].gross_debt = false;
assert.ok(
  validateSemanticArtifacts(semanticMembershipMutation, []).some(
    (error) => error.id === "manifest.instrument_period_membership_binding",
  ),
  "Semantic gate did not reject membership drift from compiled state.",
);

const reorderedCase = structuredClone(modelCase);
reorderedCase.instruments.reverse();
assert.deepEqual(compileInstrumentPeriodState(reorderedCase), artifact, "State changed under row reorder.");

const migratedLegacyBasisCase = structuredClone(modelCase);
delete migratedLegacyBasisCase.instruments.find(
  (candidate) => candidate.instrument_id === "bullet",
).balance_basis;
const migratedLegacyBasisState = compileInstrumentPeriodState(
  migratedLegacyBasisCase,
).states.find(
  (state) => state.instrument_id === "bullet" && state.period_index === 0,
);
assert.equal(migratedLegacyBasisState.balance_basis, "native_principal");
assert.equal(
  migratedLegacyBasisState.ending_post_repayment.reporting_amount,
  statesFor("bullet")[0].ending_post_repayment.reporting_amount,
  "Omitted legacy balance basis did not preserve prior native-principal economics.",
);

const noRcfCase = structuredClone(modelCase);
noRcfCase.case_id = "instrument_period_state_no_rcf";
noRcfCase.rcf_policy = {
  mode: "none",
  capacity: 0,
  opening_draw: 0,
  commitment_fee_convention: "none",
  commitment_fee_value: 0,
};
const noRcfArtifact = compileInstrumentPeriodState(noRcfCase);
assert.ok(
  noRcfArtifact.states.every((state) => state.inclusion.liquidity === false),
  "An instrument-only/no-RCF state graph invented a balancing facility.",
);
const ordinaryRevolverMaturity = noRcfArtifact.states.find(
  (state) =>
    state.instrument_id === "liquidity_rcf" && state.period_index === 0,
);
assert.equal(
  ordinaryRevolverMaturity.repayment_state,
  "maturity",
  "A revolver became non-maturing merely because no balancing facility was designated.",
);
assert.equal(
  ordinaryRevolverMaturity.inclusion.mandatory_repayment,
  true,
  "An ordinary revolver was excluded from contractual mandatory repayment.",
);
assert.equal(ordinaryRevolverMaturity.inclusion.liquidity, false);
assert.equal(
  mandatoryRepaymentForPeriod(noRcfArtifact, 0) >= 40,
  true,
  "The no-facility mandatory-repayment pool omitted an ordinary revolver maturity.",
);

const residualPricingCase = structuredClone(modelCase);
const residualInstrument = residualPricingCase.instruments.find(
  (candidate) => candidate.instrument_id === "bullet",
);
residualInstrument.rate_type = "unpriced";
residualInstrument.pricing_treatment = "residual_interest_plug";
delete residualPricingCase.other_interest;
assert.throws(
  () => compileInstrumentPeriodState(residualPricingCase),
  /require an explicit three-period other_interest authority/,
);
residualPricingCase.other_interest = [5, 6, 7];
assert.equal(
  compileInstrumentPeriodState(residualPricingCase).states.find(
    (state) => state.instrument_id === "bullet",
  ).pricing_state,
  "residual_interest_plug",
);

const doubleFxMutation = structuredClone(artifact);
const carryingMutation = doubleFxMutation.states.find((state) => state.instrument_id === "usd_carrying");
carryingMutation.ending_post_repayment.reporting_amount *= 10;
assert.ok(
  validateInstrumentPeriodStateArtifact(doubleFxMutation).some((error) => error.includes("double FX")),
  "Double-FX mutation was not rejected.",
);

const rcfMandatoryMutation = structuredClone(artifact);
const rcfMutation = rcfMandatoryMutation.states.find((state) => state.instrument_id === "liquidity_rcf");
rcfMutation.inclusion.mandatory_repayment = true;
rcfMutation.repayment_state = "maturity";
rcfMutation.maturity_repayment.basis_amount = 40;
assert.ok(
  validateInstrumentPeriodStateArtifact(rcfMandatoryMutation).some((error) => error.includes("mandatory repayment pool")),
  "RCF mandatory-repayment mutation was not rejected.",
);

assert.deepEqual(artifact.definition_basis_graph.nodes.map((node) => node.node_id), [
  "gross_debt_instruments_excluding_leases",
  "lease_liabilities",
  "model_gross_debt_excluding_leases",
  "model_gross_debt_including_leases",
  "model_gross_debt",
  "eligible_cash",
  "liquidity_cash",
  "model_net_debt_excluding_leases",
  "model_net_debt_including_leases",
  "model_net_debt",
  "reported_net_debt_adjustments",
  "reported_net_debt",
  "leverage_debt",
  "leverage_numerator",
]);

assert.throws(
  () => compileInstrumentPeriodState({ ...modelCase, periods: modelCase.periods.slice(0, 5) }),
  /exactly three forecast periods/,
);
assert.throws(
  () => compileInstrumentPeriodState({
    ...modelCase,
    instruments: modelCase.instruments.map((item) =>
      item.instrument_id === "liquidity_rcf"
        ? { ...item, scheduled_amortisation: [1, 0, 0] }
        : item),
  }),
  /cannot enter the mandatory repayment pool/,
);

console.log(JSON.stringify({
  status: "PASS",
  schema_version: artifact.schema_version,
  state_count: artifact.states.length,
  definition_node_count: artifact.definition_basis_graph.nodes.length,
  violations: 0,
  mutations: [
    "double_fx",
    "rcf_mandatory_repayment",
    "definition_membership",
    "mandatory_membership",
    "semantic_membership_binding",
    "legacy_native_basis_migration",
    "non_maturing_with_in_horizon_date",
    "multi_rcf_role_separation",
    "no_rcf_state_graph",
    "no_rcf_ordinary_revolver_maturity",
    "residual_pricing_authority",
    "zero_balance_maturity_exclusion",
    "issuance_before_maturity_inclusion",
  ],
}, null, 2));
