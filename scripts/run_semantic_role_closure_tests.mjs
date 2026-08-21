#!/usr/bin/env node
import fs from "node:fs";
import { createRunner } from "./lib/test_harness.mjs";
import { canonicalSemanticRole, isStructuredEventRole } from "./lib/semantic_roles.mjs";
import { brokerHeadlineEligibility } from "./lib/broker_headline_policy.mjs";

const run = createRunner({ name: "semantic_role_closure_tests", importMetaUrl: import.meta.url });
const taxonomy = JSON.parse(fs.readFileSync(new URL("../assets/statement-semantic-taxonomy.v1.json", import.meta.url)));
const ontology = JSON.parse(fs.readFileSync(new URL("../assets/economic-ontology-v2.json", import.meta.url)));
const emitted = new Set(taxonomy.roles.map((row) => canonicalSemanticRole(row.id)));
run.eq(canonicalSemanticRole("operating_profit"), "operating_profit");
run.eq(canonicalSemanticRole("operating income"), "operating_profit");
run.ne(canonicalSemanticRole("operating_profit"), canonicalSemanticRole("ebit"));
run.ne(canonicalSemanticRole("adjusted_ebit"), canonicalSemanticRole("ebit"));
run.ok(emitted.has("acquisitions_net_of_cash"));
run.ok(isStructuredEventRole("acquisitions_net_of_cash"));
run.ok(isStructuredEventRole("business_combination"));
run.eq(ontology.profit_concepts.adjusted_ebit.basis, "company_adjusted");
run.eq(ontology.profit_concepts.reported_ebit.basis, "reported");
run.eq(ontology.profit_bridge_components.impairment_loss.pure_ebitda_addback, false);
run.eq(
  brokerHeadlineEligibility(
    { semantic_role: "operating_profit" },
    [{
      observation_kind: "broker_estimate",
      economic_concept_id: "ebit",
      period_end: "2027-12-31",
      value: 100,
    }],
  ),
  { eligible: true, role: "ebit", selected_role: "ebit", reason: null },
  "Statutory operating profit must remain a coherent EBIT-level broker headline locally without collapsing the ontology.",
);
run.finish();
