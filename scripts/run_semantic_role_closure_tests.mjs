#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalSemanticRole, isStructuredEventRole } from "./lib/semantic_roles.mjs";
import { brokerHeadlineEligibility } from "./lib/broker_headline_policy.mjs";
const taxonomy = JSON.parse(fs.readFileSync(new URL("../assets/statement-semantic-taxonomy.v1.json", import.meta.url)));
const ontology = JSON.parse(fs.readFileSync(new URL("../assets/economic-ontology-v2.json", import.meta.url)));
const emitted = new Set(taxonomy.roles.map((row) => canonicalSemanticRole(row.id)));
assert.equal(canonicalSemanticRole("operating_profit"), "operating_profit");
assert.equal(canonicalSemanticRole("operating income"), "operating_profit");
assert.notEqual(canonicalSemanticRole("operating_profit"), canonicalSemanticRole("ebit"));
assert.notEqual(canonicalSemanticRole("adjusted_ebit"), canonicalSemanticRole("ebit"));
assert.ok(emitted.has("acquisitions_net_of_cash"));
assert.ok(isStructuredEventRole("acquisitions_net_of_cash"));
assert.ok(isStructuredEventRole("business_combination"));
assert.equal(ontology.profit_concepts.adjusted_ebit.basis, "company_adjusted");
assert.equal(ontology.profit_concepts.reported_ebit.basis, "reported");
assert.equal(
  ontology.profit_bridge_components.impairment_loss.pure_ebitda_addback,
  false,
);
assert.deepEqual(
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
console.log(JSON.stringify({ status: "PASS", checks: 11 }));
