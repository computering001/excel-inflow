#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  DELIVERY_CONSTITUTION,
  assertBrokerFailureDegrades,
  classifyDeliveryFinding,
} from "./lib/delivery_constitution.mjs";

const run = createRunner({
  name: "delivery_constitution_tests",
  importMetaUrl: import.meta.url,
});
const schema = JSON.parse(
  await fs.readFile(path.join(run.ROOT, "assets", "delivery-constitution-v1.schema.json"), "utf8"),
);

const schemaErrors = validateJsonSchema(DELIVERY_CONSTITUTION, schema);
run.check("delivery constitution validates against its schema", () => schemaErrors.length === 0);
run.eq(DELIVERY_CONSTITUTION.ownership_order, ["LOG", "DEGRADE", "ASK", "BLOCK"], "ownership order");

run.eq(classifyDeliveryFinding({
  lane: "filings",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: false,
  finite_user_resolution_available: false,
}), "BLOCK", "unresolvable material finding blocks");

run.eq(classifyDeliveryFinding({
  lane: "debt",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: false,
  finite_user_resolution_available: true,
}), "ASK", "user-resolvable finding asks");

run.eq(classifyDeliveryFinding({
  lane: "debt",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: true,
  finite_user_resolution_available: true,
}), "DEGRADE", "alternative-path finding degrades");

const brokerReasons = DELIVERY_CONSTITUTION.degrade_reasons.filter((entry) => entry.startsWith("broker_"));
for (const reason of brokerReasons) {
  run.check(`broker failure degrades: ${reason}`, () => assertBrokerFailureDegrades(reason) === "DEGRADE");
}

const mutated = structuredClone(DELIVERY_CONSTITUTION);
mutated.lanes.broker = "mandatory";
run.check("mutated broker lane fails schema validation", () => validateJsonSchema(mutated, schema).length > 0);
run.eq(classifyDeliveryFinding({
  lane: "broker",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: false,
  finite_user_resolution_available: false,
}), "DEGRADE", "mutated broker lane still degrades, never blocks");
run.check("mutation actually changed the broker lane", () => mutated.lanes.broker !== DELIVERY_CONSTITUTION.lanes.broker);

run.finish({
  schema_errors: schemaErrors.length,
  broker_degradation_mutations: brokerReasons.length,
  total_violations: 0,
});
