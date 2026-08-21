#!/usr/bin/env node
import { createRunner } from "./lib/test_harness.mjs";
import { matchEntities } from "./lib/flow_entity.mjs";

const run = createRunner({ name: "entity_identity_tests", importMetaUrl: import.meta.url });

run.ok(matchEntities("AstraZeneca PLC", "AstraZeneca").verdict === "match", "legal form match failed");
run.ok(matchEntities(
  { name: "GSK plc", identifiers: { lei: "5493000...ABC" } },
  { name: "GlaxoSmithKline plc", identifiers: { lei: "5493000ABC" } },
).verdict === "match", "stable identifier did not resolve renamed issuer");
run.ok(matchEntities(
  { name: "Issuer Holdings", identifiers: { factset_entity_id: "000AAA" } },
  { name: "Issuer Holdings", identifiers: { factset_entity_id: "000BBB" } },
).verdict === "mismatch", "conflicting stable identifiers did not block");
run.ok(matchEntities(
  { name: "International Consolidated Airlines Group", aliases: ["IAG"] },
  { name: "IAG plc" },
).verdict === "match", "declared alias did not match");
run.ok(matchEntities("Alpha plc", "Beta plc").verdict === "mismatch", "unrelated entities matched");
run.ok(matchEntities("Issuer Holdings", "Issuer Operating Company").verdict === "ambiguous", "group ambiguity disappeared");

run.finish();
