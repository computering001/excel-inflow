#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(root,"assets/development-test-registry.json"),"utf8"));
const matrix = registry.tests.find((row) => row.id === "universal-broker-delivery-matrix");
assert.deepEqual(matrix.arguments, ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]);
assert.deepEqual(matrix.requires, ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]);
const script = fs.readFileSync(path.join(root,"scripts/run_universal_broker_delivery_matrix.mjs"),"utf8");
assert.match(script, /cleanFixtureArg, pythonArg, sofficeArg/);
console.log(JSON.stringify({ status: "PASS", checks: 3 }));
