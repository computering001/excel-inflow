#!/usr/bin/env node

import { createRunner } from "./lib/test_harness.mjs";
import { applyHistoricalNormalisation } from "./lib/historical_normalisation.mjs";

// A filed Adjusted EBITDA can sit directly below a filed operating-profit row
// whose declared identity already depends on Adjusted EBITDA. The historical
// numbers reconcile both ways, but inferring the inverse total would create:
// adjusted EBITDA -> operating profit -> adjusted EBITDA.
const inverseIdentityCase = {
  case_id: "historical_inverse_identity_cycle",
  execution_profile: "production_model",
  statement_authority_contract_version: "authority_v1",
  source_coverage: { classification_contract_version: "evidence_v1" },
  modules: { historical_normalisation: false },
  statement_structure: {
    income_statement: [
      {
        row_id: "depreciation_and_amortisation",
        semantic_role: "depreciation_and_amortisation",
        row_type: "input",
        historical_authority: "source_input",
        values: [20, 21, 22, null, null, null],
      },
      {
        row_id: "ebit",
        semantic_role: "ebit",
        row_type: "input",
        style_role: "total",
        historical_authority: "source_input",
        values: [100, 105, 110, null, null, null],
        calculation: {
          operator: "subtract",
          refs: ["adjusted_ebitda", "depreciation_and_amortisation"],
        },
      },
      {
        row_id: "adjusted_ebitda",
        semantic_role: "adjusted_ebitda",
        row_type: "input",
        style_role: "total",
        historical_authority: "source_input",
        values: [120, 126, 132, null, null, null],
      },
    ],
    cash_flow: [],
  },
};

const run = createRunner({ name: "historical_normalisation_tests", importMetaUrl: import.meta.url });

const normalized = applyHistoricalNormalisation(inverseIdentityCase);
const income = new Map(
  normalized.model_case.statement_structure.income_statement.map((row) => [row.row_id, row]),
);
run.eq(
  income.get("adjusted_ebitda").calculation,
  undefined,
  "A numerically exact inverse identity was inferred into a historical dependency cycle.",
);
run.eq(
  income.get("adjusted_ebitda").values.slice(0, 3),
  [120, 126, 132],
  "The filed Adjusted EBITDA authority was not preserved after rejecting the inverse identity.",
);
run.eq(
  income.get("ebit").calculation.refs,
  ["adjusted_ebitda", "depreciation_and_amortisation"],
  "The valid one-way operating-profit identity was changed.",
);
run.ok(
  normalized.receipt.exact_reported_total_promotions.some((item) => item.row_id === "ebit"),
  "The valid exact reported operating-profit identity was not promoted.",
);
run.ok(
  !normalized.receipt.exact_reported_total_promotions.some(
    (item) => item.row_id === "adjusted_ebitda" && item.dependency_inferred,
  ),
  "The inverse Adjusted EBITDA dependency was recorded as inferred.",
);

run.finish({
  inverse_identity_cycle_rejected: true,
  valid_one_way_identity_preserved: true,
});
