#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalSemanticRole, isStructuredEventRole } from "./lib/semantic_roles.mjs";
const taxonomy = JSON.parse(fs.readFileSync(new URL("../assets/statement-semantic-taxonomy.v1.json", import.meta.url)));
const emitted = new Set(taxonomy.roles.map((row) => canonicalSemanticRole(row.id)));
assert.equal(canonicalSemanticRole("operating_profit"), "ebit");
assert.equal(canonicalSemanticRole("operating income"), "ebit");
assert.ok(emitted.has("acquisitions_net_of_cash"));
assert.ok(isStructuredEventRole("acquisitions_net_of_cash"));
assert.ok(isStructuredEventRole("business_combination"));
console.log(JSON.stringify({ status: "PASS", checks: 5 }));
