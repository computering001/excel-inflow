#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonical, effectiveTestMetadata, testProfile } from "./lib/development_gate_contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "assets", "development-test-registry.json");
function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? path.resolve(process.argv[index + 1]) : null;
}
const out = option("out");
const summaryOut = option("summary-out");
const bytes = fs.readFileSync(registryPath);
const registry = JSON.parse(bytes);
const records = registry.tests.map((test) => {
  const metadata = effectiveTestMetadata(registry, test);
  const selfConfirming = ["unit", "component_integration", "cross_layer_integration"].includes(metadata.audit_class);
  return canonical({ id: test.id, phase: test.phase, profile: testProfile(test), ...metadata, self_confirmation_risk: selfConfirming });
});
const countBy = (key, values = [...new Set(records.map((row) => row[key]))].sort()) => Object.fromEntries(values.map((value) => [value, records.filter((row) => row[key] === value).length]));
const report = canonical({
  schema_version: "development-test-classification-census/1.0",
  registry: { path: "assets/development-test-registry.json", sha256: createHash("sha256").update(bytes).digest("hex"), test_count: records.length },
  completeness: {
    every_test_has_owner: records.every((row) => row.owner),
    every_test_has_declared_test_class: records.every((row) => row.declared_test_class),
    every_test_has_audit_class: records.every((row) => row.audit_class),
    every_test_has_expected_exit_contract: records.every((row) => row.expected_exit_contract),
  },
  counts: { by_audit_class: countBy("audit_class", registry.metadata_contract.allowed_audit_classes), by_owner: countBy("owner"), by_profile: countBy("profile"), self_confirmation_risk: countBy("self_confirmation_risk") },
  records,
});
const text = `${JSON.stringify(report, null, 2)}\n`;
if (out) fs.writeFileSync(out, text, "utf8");
else process.stdout.write(text);
if (summaryOut) {
  const summary = canonical({
    schema_version: "development-test-classification-census-summary/1.0",
    registry: report.registry,
    generator: "scripts/compile_test_registry_census.mjs",
    generator_command: `node scripts/compile_test_registry_census.mjs --summary-out ${path.relative(root, summaryOut).split(path.sep).join("/")}`,
    full_record_policy: "The generator emits one owner, declared test class, canonical audit class, expected-exit contract, profile and self-confirmation classification for every registry id.",
    completeness: report.completeness,
    counts: { by_audit_class: report.counts.by_audit_class, by_profile: report.counts.by_profile, self_confirmation_risk: report.counts.self_confirmation_risk },
    interpretation: "This is a classification census, not an assertion that all classes are independent. Unit, component-integration and cross-layer-integration tests are explicitly counted as carrying self-confirmation risk. Installed-host evidence remains custody-bound and may be BLOCKED in portable CI.",
  });
  fs.writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
