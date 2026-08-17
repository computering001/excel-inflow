#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  DELIVERY_CONSTITUTION,
  assertBrokerFailureDegrades,
  classifyDeliveryFinding,
} from "./lib/delivery_constitution.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "delivery-constitution-v1.schema.json"), "utf8"),
);

const schemaErrors = validateJsonSchema(DELIVERY_CONSTITUTION, schema);
assert.deepEqual(schemaErrors, []);
assert.deepEqual(DELIVERY_CONSTITUTION.ownership_order, ["LOG", "DEGRADE", "ASK", "BLOCK"]);

assert.equal(classifyDeliveryFinding({
  lane: "filings",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: false,
  finite_user_resolution_available: false,
}), "BLOCK");

assert.equal(classifyDeliveryFinding({
  lane: "debt",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: false,
  finite_user_resolution_available: true,
}), "ASK");

assert.equal(classifyDeliveryFinding({
  lane: "debt",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: true,
  finite_user_resolution_available: true,
}), "DEGRADE");

for (const reason of DELIVERY_CONSTITUTION.degrade_reasons.filter((entry) => entry.startsWith("broker_"))) {
  assert.equal(assertBrokerFailureDegrades(reason), "DEGRADE");
}

const mutated = structuredClone(DELIVERY_CONSTITUTION);
mutated.lanes.broker = "mandatory";
assert.ok(validateJsonSchema(mutated, schema).length > 0);
assert.equal(classifyDeliveryFinding({
  lane: "broker",
  unresolved: true,
  material: true,
  reachable_to_material_output: true,
  alternative_authority_path_exists: false,
  finite_user_resolution_available: false,
}), "DEGRADE");
assert.notEqual(mutated.lanes.broker, DELIVERY_CONSTITUTION.lanes.broker);

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  schema_errors: schemaErrors.length,
  broker_degradation_mutations: DELIVERY_CONSTITUTION.degrade_reasons.filter((entry) => entry.startsWith("broker_")).length,
  total_violations: 0,
}, null, 2)}\n`);
