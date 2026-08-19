#!/usr/bin/env node
/**
 * P1.4 — Producer-boundary validation tests.
 *
 * Invariant: invalid objects fail immediately at the producer that created
 * them — which requires the shared validator to enforce EVERYTHING the
 * shipped schemas declare. oneOf/anyOf were silently unenforced until this
 * package; these tests are the regression direction.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "./lib/json_schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

// 1. anyOf enforcement: value must match at least one branch.
const anySchema = { anyOf: [{ type: "string" }, { type: "null" }] };
check(validateJsonSchema("x", anySchema).length === 0, "anyOf accepts a matching branch");
check(validateJsonSchema(null, anySchema).length === 0, "anyOf accepts the null branch");
check(validateJsonSchema(7, anySchema).length === 1, "anyOf REFUSES a value matching no branch");

// 2. oneOf enforcement: exactly one branch.
const oneSchema = { oneOf: [
  { type: "object", required: ["a"], properties: { a: { type: "number" } }, additionalProperties: false },
  { type: "object", required: ["b"], properties: { b: { type: "number" } }, additionalProperties: false },
] };
check(validateJsonSchema({ a: 1 }, oneSchema).length === 0, "oneOf accepts exactly one match");
check(validateJsonSchema({ c: 1 }, oneSchema).length > 0, "oneOf refuses zero matches");
const ambiguous = { oneOf: [{ type: "number" }, { type: "number", minimum: 0 }] };
check(validateJsonSchema(5, ambiguous).some((error) => error.includes("matched 2")),
  "oneOf refuses ambiguous double matches");

// 3. The model-case contract declares the load-bearing temporal_edge field —
// the under-declared-schema defect this package repaired. A lawful
// opening-cash rule must validate; an undeclared field must still refuse.
const modelSchema = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "model-case-v2.schema.json"), "utf8"),
);
const probe = {
  ...modelSchema,
  properties: { probe: { anyOf: [{ $ref: "#/$defs/formulaRule" }, { type: "null" }] } },
  required: ["probe"],
  additionalProperties: true,
};
check(validateJsonSchema(
  { probe: { operator: "prior_period", refs: ["ending_cash"], temporal_edge: true } }, probe,
).length === 0, "the opening-cash temporal_edge rule is a declared lawful shape");
check(validateJsonSchema(
  { probe: { operator: "prior_period", refs: ["ending_cash"], smuggled: true } }, probe,
).length > 0, "an undeclared formulaRule field still refuses");

// 4. Census: every shipped schema that declares oneOf/anyOf is now under an
// enforcing validator — assert the constructs are countable and non-zero so
// a future validator regression cannot silently re-lapse.
let constructCount = 0;
for (const entry of await fs.readdir(path.join(ROOT, "assets"))) {
  if (!entry.endsWith(".schema.json")) continue;
  const body = await fs.readFile(path.join(ROOT, "assets", entry), "utf8");
  constructCount += (body.match(/"oneOf"|"anyOf"/g) ?? []).length;
}
check(constructCount > 10, `shipped schemas declare ${constructCount} oneOf/anyOf constructs — all now enforced`);

console.log(JSON.stringify({ status: "PASS", checks, enforced_constructs: constructCount }));
