#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ECONOMIC_ROLE_REGISTRY,
  STRUCTURED_EVENT_ROLE_SET,
  economicRoleDefinition,
  validateEconomicRoleCoverage,
} from "./lib/economic_role_registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const taxonomy = JSON.parse(
  fs.readFileSync(
    path.join(root, "assets", "statement-semantic-taxonomy.v1.json"),
    "utf8",
  ),
);

const required = [
  "acquisition",
  "acquisition_cost",
  "acquisitions_net_of_cash",
  "acquisition_of_subsidiaries_net_of_cash_acquired",
  "business_combination",
  "business_combinations_net_of_cash_acquired",
  "disposal",
  "asset_disposal",
  "asset_sale",
  "litigation",
  "legal_settlement",
  "restructuring",
  "impairment_loss",
  "exceptional_item",
  "discontinued_operation",
];
assert.deepEqual(validateEconomicRoleCoverage(required), {
  status: "PASS",
  missing: [],
});
for (const role of required) {
  assert.ok(STRUCTURED_EVENT_ROLE_SET.has(role), role);
  assert.equal(economicRoleDefinition(role)?.recurrence, "discrete_event");
  assert.equal(economicRoleDefinition(role)?.structured_event, true);
}
const emittedStructuredRoles = taxonomy.roles
  .map((role) => role.id)
  .filter((role) =>
    /acquisition|combination|disposal|impairment|restructuring|litigation|settlement|exceptional|discontinued/.test(role),
  );
assert.deepEqual(
  validateEconomicRoleCoverage(emittedStructuredRoles),
  { status: "PASS", missing: [] },
);
const mutation = validateEconomicRoleCoverage([
  ...emittedStructuredRoles,
  "invented_unregistered_event",
]);
assert.equal(mutation.status, "FAIL");
assert.deepEqual(mutation.missing, ["invented_unregistered_event"]);

const behaviorSource = fs.readFileSync(
  path.join(root, "scripts", "lib", "forecast_behavior.mjs"),
  "utf8",
);
const authoritySource = fs.readFileSync(
  path.join(root, "scripts", "lib", "forecast_authority.mjs"),
  "utf8",
);
assert.ok(behaviorSource.includes("NON_RECURRING_ROLES = STRUCTURED_EVENT_ROLE_SET"));
assert.ok(authoritySource.includes("STRUCTURAL_EVENT_ROLES = STRUCTURED_EVENT_ROLE_SET"));
assert.equal(/const\s+NON_RECURRING_ROLES\s*=\s*new\s+Set/.test(behaviorSource), false);
assert.equal(/const\s+STRUCTURAL_EVENT_ROLES\s*=\s*new\s+Set/.test(authoritySource), false);

console.log(JSON.stringify({
  status: "PASS",
  role_count: Object.keys(ECONOMIC_ROLE_REGISTRY).length,
  checks: required.length * 3 + 8,
}, null, 2));
