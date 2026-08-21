#!/usr/bin/env node
import fs from "node:fs";

import {
  CANONICAL_DEBT_CLASSES,
  assertCanonicalDebtClass,
  canonicalDebtClass,
  debtClassGroup,
  migrateLegacyDebtClasses,
} from "./lib/debt_class.mjs";
import { assessCoverage } from "./lib/coverage.mjs";
import { applyExplicitSourcePolicies } from "./lib/flow_questions.mjs";
import { instrumentDisplayLabel } from "./lib/instrument_display.mjs";
import {
  DEBT_PRESENTATION_GROUPS,
  debtPresentationGroupKey,
} from "./lib/row_plan.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "debt_class_contract_tests", importMetaUrl: import.meta.url });
const ROOT = new URL("../", import.meta.url);
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(new URL(relative, ROOT), "utf8"));
const canonical = [...CANONICAL_DEBT_CLASSES].sort();
const sameEnum = (actual, label) =>
  run.eq([...actual].sort(), canonical, `${label} has drifted from the debt ontology`);

const dcsSchema = readJson("assets/dcs-export.schema.json");
const modelCaseV2Schema = readJson("assets/model-case-v2.schema.json");
const instrumentStateSchema = readJson("assets/instrument-period-state-v1.schema.json");
const publicTestSchema = readJson("assets/public-test-run-v1.schema.json");
const modelCaseSchema = readJson("assets/model-case.schema.json");
sameEnum(dcsSchema.$defs.exportInstrument.properties.instrument_type.enum, "DCS export");
sameEnum(modelCaseV2Schema.$defs.instrument.properties.class.enum, "model-case-v2");
sameEnum(instrumentStateSchema.$defs.state.properties.class.enum, "instrument-period-state");
sameEnum(publicTestSchema.$defs.instrument.properties.instrument_type.enum, "public test run");
sameEnum(modelCaseSchema.$defs.instrument.properties.class.enum, "legacy model-case schema");

run.eq(canonicalDebtClass("fixed_bond"), "bond_fixed", "legacy alias fixed_bond canonicalises to bond_fixed");
run.eq(canonicalDebtClass("floating_loan"), "term_loan_floating", "legacy alias floating_loan canonicalises to term_loan_floating");
run.eq(canonicalDebtClass("mystery facility"), "unclassified", "unknown free text falls back to unclassified");
run.throws(() => assertCanonicalDebtClass("fixed_bond"), /not canonical/, "canonical guard rejects a legacy alias");
run.throws(() => debtClassGroup("other_debt"), /not canonical/, "group lookup rejects an uncanonical class");

const migrated = {
  instruments: [
    { instrument_id: "old_bond", class: "fixed_bond" },
    { instrument_id: "unknown", class: "bespoke_facility" },
    { instrument_id: "current", class: "rcf" },
  ],
};
const migrationReceipt = migrateLegacyDebtClasses(migrated);
run.eq(migrated.debt_class_contract_version, "debt-class-ontology/1.0", "migration stamps the ontology contract version");
run.eq(
  migrated.instruments.map((instrument) => instrument.class),
  ["bond_fixed", "unclassified", "rcf"],
  "migration maps alias, unknown and current classes correctly",
);
run.eq(
  migrationReceipt.map((item) => item.mapping),
  ["legacy_alias", "unrecognised_to_review"],
  "migration receipt names its mappings",
);
run.eq(migrated.debt_class_migrations, migrationReceipt, "case retains its migration receipt");

const expectedGroups = {
  bond_fixed: "bonds",
  bond_floating: "bonds",
  term_loan_fixed: "bank_debt",
  term_loan_floating: "bank_debt",
  rcf: "bank_debt",
  commercial_paper: "other_debt",
  securitisation: "bank_debt",
  lease_liability: "other_debt",
  overdraft: "bank_debt",
  other_explicit: "other_debt",
  unclassified: "unclassified_review",
};
for (const [debtClass, group] of Object.entries(expectedGroups)) {
  run.eq(debtPresentationGroupKey({ class: debtClass }), group, `${debtClass} presentation group`);
}
run.eq(
  DEBT_PRESENTATION_GROUPS.map(({ key }) => key),
  ["bonds", "bank_debt", "other_debt", "unclassified_review"],
  "presentation group ordering is stable",
);

const fullLegalName = "XS0123456789 Example Holdings plc 3.125 per cent guaranteed notes series 12";
const fixedBond = {
  class: "bond_fixed",
  name: fullLegalName,
  rate_type: "fixed",
  coupon_or_all_in_rate: [0.03125],
  maturity_date: "2027-06-30",
  maturity_precision: "date",
};
run.eq(instrumentDisplayLabel(fixedBond), "Senior Notes 3.125% due Jun-27", "fixed bond renders a compact display label");
run.eq(fixedBond.name, fullLegalName, "presentation changed the sourced legal name");
run.eq(
  instrumentDisplayLabel({
    class: "term_loan_floating",
    rate_type: "floating",
    benchmark: "SOFR",
    spread_bps: 175,
    maturity_date: "2029-12-31",
  }),
  "Floating Term Loan SOFR + 175bp due Dec-29",
 "floating term loan renders a compact display label",);
run.eq(
  instrumentDisplayLabel({
    class: "rcf",
    rate_type: "floating",
    benchmark: "SONIA",
    spread_bps: 110,
    maturity_date: "2030-04-30",
  }),
  "RCF SONIA + 110bp due Apr-30",
 "rcf renders a compact display label",);
run.eq(
  instrumentDisplayLabel({
    class: "overdraft",
    rate_type: "unpriced",
    maturity_treatment: "non_maturing_within_forecast",
  }),
  "Overdraft non-maturing",
 "overdraft renders a compact display label",);

const coverageCase = readJson("test-fixtures/cases/standard-maximal-v2.json");
coverageCase.instruments[0].class = "unclassified";
const classBlock = assessCoverage(coverageCase).checks.find(
  (check) => check.id === `instrument.${coverageCase.instruments[0].instrument_id}.class_review`,
);
run.eq(classBlock?.status, "BLOCK", "unclassified instrument blocks coverage");
run.match(classBlock?.message ?? "", /requires an explicit reviewed debt class/, "class review block explains itself");

const commercialPaperCase = {
  rcf_policy: { mode: "balancing_rcf", instrument_id: "rcf" },
  instruments: [
    { instrument_id: "paper", class: "commercial_paper" },
    { instrument_id: "rcf", class: "rcf" },
  ],
};
applyExplicitSourcePolicies({
  modelCase: commercialPaperCase,
  intake: {
    export: {
      instruments: [
        { instrument_id: "paper", is_backstop_for_paper: false },
      ],
    },
  },
});
run.eq(commercialPaperCase.instruments[0].class, "commercial_paper", "unbacked commercial paper keeps its class");
run.eq(commercialPaperCase.rcf_policy.commercial_paper_backstopped, false, "unbacked paper is not marked backstopped");

const rowPlanSource = fs.readFileSync(new URL("scripts/lib/row_plan.mjs", ROOT), "utf8");
run.eq(rowPlanSource.includes("CRH_DEBT_GROUPS"), false, "row plan carries no CRH_DEBT_GROUPS literal");
run.eq(rowPlanSource.includes("crhDebtGroup"), false, "row plan carries no crhDebtGroup literal");

run.finish();
