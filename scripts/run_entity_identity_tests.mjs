#!/usr/bin/env node

import { matchEntities } from "./lib/flow_entity.mjs";

let checks = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

assert(matchEntities("AstraZeneca PLC", "AstraZeneca").verdict === "match", "legal form match failed");
assert(matchEntities(
  { name: "GSK plc", identifiers: { lei: "5493000...ABC" } },
  { name: "GlaxoSmithKline plc", identifiers: { lei: "5493000ABC" } },
).verdict === "match", "stable identifier did not resolve renamed issuer");
assert(matchEntities(
  { name: "Issuer Holdings", identifiers: { factset_entity_id: "000AAA" } },
  { name: "Issuer Holdings", identifiers: { factset_entity_id: "000BBB" } },
).verdict === "mismatch", "conflicting stable identifiers did not block");
assert(matchEntities(
  { name: "International Consolidated Airlines Group", aliases: ["IAG"] },
  { name: "IAG plc" },
).verdict === "match", "declared alias did not match");
assert(matchEntities("Alpha plc", "Beta plc").verdict === "mismatch", "unrelated entities matched");
assert(matchEntities("Issuer Holdings", "Issuer Operating Company").verdict === "ambiguous", "group ambiguity disappeared");

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
