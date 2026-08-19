#!/usr/bin/env node
/**
 * P2.7 — policy-registry contract tests.
 *
 * Invariant: every model-owned assumption family binds to a versioned
 * registry entry {policy_id, version, owned_assumption, evidence_hierarchy};
 * the case-level policy objects (rcf/cash/lease) carry the binding, and a
 * registry version change is receipt-visible on the sealed case.
 *
 * Vocabulary discipline: evidence_hierarchy rungs resolve into
 * FORECAST_AUTHORITY_PRIORITY; owned_assumption resolves into the canonical
 * model graph's modules and SCHEDULE_PRODUCER_BY_ROLE — never a new ladder.
 *
 * Prints a single-line JSON {"status":"PASS","checks":N} on success; exits
 * nonzero on any failure.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import { FORECAST_AUTHORITY_PRIORITY } from "./lib/forecast_authority.mjs";
import { SCHEDULE_PRODUCER_BY_ROLE } from "./lib/forecast_producer_contract.mjs";
import {
  POLICY_REGISTRY,
  POLICY_REGISTRY_SCHEMA,
  boundPolicyEntry,
  stampPolicyBindings,
  validatePolicyRegistry,
} from "./lib/policy_registry.mjs";
import { RCF_POLICY_ID, RCF_POLICY_VERSION } from "./lib/rcf_policy.mjs";
import { LEASE_POLICY_ID, LEASE_POLICY_VERSION } from "./lib/lease_policy.mjs";
import { hashValue } from "./lib/run_store.mjs";
import { compileCase } from "./lib/case_compiler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const clone = (value) => structuredClone(value);

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

const registry = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "policy-registry-v1.json"), "utf8"),
);
check(registry.schema_version === "excel-inflow-policy-registry/1.0", "registry schema_version");
check(validateJsonSchema(registry, POLICY_REGISTRY_SCHEMA).length === 0, "registry satisfies its schema");
check(validatePolicyRegistry(registry).length === 0, "registry passes semantic validation");
check(hashValue(registry) === hashValue(POLICY_REGISTRY), "frozen POLICY_REGISTRY equals the asset on disk");

// 1. Completeness: every entry carries the full binding contract, and the
// vocabularies are the existing ones.
const CANONICAL_MODULES = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "canonical-model-graph-v2.json"), "utf8"),
).modules;
const entries = Object.entries(registry.entries);
check(entries.length >= 16, `at least the 16 inventoried families are declared (got ${entries.length})`);
for (const [key, entry] of entries) {
  for (const field of ["policy_id", "version", "owned_assumption", "evidence_hierarchy", "binding_status"]) {
    check(field in entry, `${key} lacks ${field}`);
  }
  check(entry.policy_id === key, `${key}: policy_id must equal its key`);
  check(/^[0-9]+\.[0-9]+$/.test(entry.version), `${key}: version must be MAJOR.MINOR`);
  const owned = entry.owned_assumption;
  if (owned.scope === "model") {
    check(CANONICAL_MODULES.includes(owned.module), `${key}: module ${owned.module} not in canonical-model-graph`);
  } else {
    check(owned.module === null && owned.schedule_roles.length === 0,
      `${key}: runtime scope must carry null module and no schedule roles`);
  }
  for (const role of owned.schedule_roles) {
    check(role in SCHEDULE_PRODUCER_BY_ROLE, `${key}: schedule role ${role} not in SCHEDULE_PRODUCER_BY_ROLE`);
  }
  let previous = -Infinity;
  for (const rung of entry.evidence_hierarchy) {
    const priority = FORECAST_AUTHORITY_PRIORITY[rung];
    check(priority !== undefined, `${key}: rung ${rung} not in FORECAST_AUTHORITY_PRIORITY`);
    check(priority > previous, `${key}: hierarchy must descend strictly in authority at ${rung}`);
    previous = priority;
  }
  check(entry.evidence_hierarchy.length > 0 || entry.system_owned === true,
    `${key}: empty evidence_hierarchy is legal only for system_owned constants`);
}

// 2. The three case policy objects are bound; every other family is
// explicitly declared_only — coverage is stated, never implied.
const bound = entries.filter(([, entry]) => entry.binding_status === "bound");
check(bound.length === 3, `exactly three bound families (got ${bound.length})`);
check(
  JSON.stringify(bound.map(([key]) => key).sort()) ===
    JSON.stringify(["cash_policy", "lease_policy", "rcf_policy"]),
  "bound families are rcf/cash/lease",
);
for (const [key, entry] of bound) {
  check(entry.case_binding === key, `${key}: bound entry must name its case key`);
}
for (const [key, entry] of entries) {
  if (entry.binding_status === "declared_only") {
    check(entry.case_binding === null, `${key}: declared_only must carry a null case_binding`);
  }
}

// 3. Code-side declarations agree with the asset.
check(RCF_POLICY_ID === "rcf_policy" && registry.entries.rcf_policy.version === RCF_POLICY_VERSION,
  "rcf_policy.mjs POLICY_ID/VERSION match the registry");
check(LEASE_POLICY_ID === "lease_policy" && registry.entries.lease_policy.version === LEASE_POLICY_VERSION,
  "lease_policy.mjs POLICY_ID/VERSION match the registry");

// 4. Mutation negatives: the validator REFUSES each corruption (validators
// validate, never repair; none of these may ever be weakened).
function refused(mutate, label) {
  const mutated = clone(registry);
  mutate(mutated);
  check(validatePolicyRegistry(mutated).length > 0, `mutation MUST be refused: ${label}`);
}
refused((m) => { m.entries.rcf_policy.evidence_hierarchy = ["board_gut_feel"]; }, "an invented rung");
refused((m) => { m.entries.rcf_policy.evidence_hierarchy = ["user_assumption", "contractual_commitment"]; }, "a strengthening hierarchy");
refused((m) => { m.entries.rcf_policy.owned_assumption.module = "liquidity_magic"; }, "an unknown module");
refused((m) => { m.entries.rcf_policy.owned_assumption.schedule_roles = ["rcf_teleport"]; }, "an unknown schedule role");
refused((m) => { m.entries.rcf_policy.case_binding = null; }, "a bound family with no case binding");
refused((m) => { m.entries.tax_rate_policy.evidence_hierarchy = []; }, "an empty hierarchy on a non-system family");
refused((m) => { m.entries.rcf_policy.policy_id = "revolver_policy"; }, "a key/policy_id mismatch");
refused((m) => {
  m.entries.tax_rate_policy.binding_status = "bound";
  m.entries.tax_rate_policy.case_binding = "rcf_policy";
}, "two entries claiming one case key");
refused((m) => { delete m.entries.rcf_policy.version; }, "a versionless entry");
refused((m) => { m.entries.rcf_policy.version = "v1"; }, "a malformed version");

// 5. Proof-A resolution: the certified fixtures accept a stamped binding and
// the schema stays exactly as strict everywhere else.
const modelCaseSchema = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "model-case-v2.schema.json"), "utf8"),
);
for (const fixtureName of ["standard-maximal-v2.json", "standard-net-cash-v2.json"]) {
  const fixture = JSON.parse(
    await fs.readFile(path.join(ROOT, "test-fixtures", "cases", fixtureName), "utf8"),
  );
  check(validateJsonSchema(fixture, modelCaseSchema).length === 0, `${fixtureName} validates unstamped`);
  const stamped = stampPolicyBindings({
    rcf_policy: clone(fixture.rcf_policy),
    cash_policy: clone(fixture.cash_policy),
    lease_policy: clone(fixture.lease_policy),
  });
  const bold = { ...clone(fixture), ...stamped };
  check(validateJsonSchema(bold, modelCaseSchema).length === 0,
    `${fixtureName} validates with stamped policy bindings (proof A resolved)`);
  for (const family of ["rcf_policy", "cash_policy", "lease_policy"]) {
    check(
      stamped[family].policy_binding.policy_id === family &&
        stamped[family].policy_binding.version === registry.entries[family].version,
      `${fixtureName}: ${family} binding matches its registry entry`,
    );
  }
  // The schema was opened for the binding and NOTHING else.
  const smuggled = clone(bold);
  smuggled.rcf_policy.covenant_holiday = true;
  check(validateJsonSchema(smuggled, modelCaseSchema).length > 0,
    `${fixtureName}: an unknown rcf_policy property is still refused`);
  const wrongId = clone(bold);
  wrongId.cash_policy.policy_binding = { policy_id: "rcf_policy", version: "1.0" };
  check(validateJsonSchema(wrongId, modelCaseSchema).length > 0,
    `${fixtureName}: a cross-family policy_id is refused`);
  const versionless = clone(bold);
  delete versionless.lease_policy.policy_binding.version;
  check(validateJsonSchema(versionless, modelCaseSchema).length > 0,
    `${fixtureName}: a versionless binding is refused`);
  const padded = clone(bold);
  padded.lease_policy.policy_binding.registry_note = "extra";
  check(validateJsonSchema(padded, modelCaseSchema).length > 0,
    `${fixtureName}: an extra binding field is refused`);
}

// 6. Stamp seam: a policy object with no bound registry family must throw —
// missing/nil never defaults to an unversioned seal.
check(boundPolicyEntry("rcf_policy").policy_id === "rcf_policy", "boundPolicyEntry resolves rcf");
check(boundPolicyEntry("acquisition") === null, "declared_only families expose no bound entry");
{
  let threw = false;
  try {
    stampPolicyBindings({ dividend_policy: {} });
  } catch {
    threw = true;
  }
  check(threw, "stamping an unregistered family MUST throw");
}

// 7. Receipt visibility (the version-bump mutation): bumping a registry
// version changes the sealed policy objects — and therefore any receipt
// hashed over them. Same input, same registry stays byte-stable.
{
  const fixture = JSON.parse(
    await fs.readFile(path.join(ROOT, "test-fixtures", "cases", "standard-maximal-v2.json"), "utf8"),
  );
  const policiesOf = (activeRegistry) =>
    stampPolicyBindings(
      {
        rcf_policy: clone(fixture.rcf_policy),
        cash_policy: clone(fixture.cash_policy),
        lease_policy: clone(fixture.lease_policy),
      },
      activeRegistry,
    );
  const sealedV10 = hashValue(policiesOf(registry));
  check(sealedV10 === hashValue(policiesOf(registry)), "identical registry seals identically");
  const bumped = clone(registry);
  bumped.entries.rcf_policy.version = "1.1";
  check(validatePolicyRegistry(bumped).length === 0, "a lawful version bump still validates");
  const stampedBumped = policiesOf(bumped);
  check(stampedBumped.rcf_policy.policy_binding.version === "1.1", "the bump reaches the stamped binding");
  check(hashValue(stampedBumped) !== sealedV10,
    "a registry version bump MUST change the sealed policy receipt");
}

// 8. End-to-end through the production compiler: a keel-derived certified
// pair compiles with all three bindings stamped and schema-legal. Skipped
// visibly (never silently) where the custody corpus is absent (CI).
const custodyCases = path.join(ROOT, "fixtures/external/Codex/2026-07-24/ok/work/v2-certification/cases");
let custodyE2E = "skipped_custody_absent";
if (existsSync(custodyCases)) {
  const CASE_NAME = "standard-net-cash-v2.json";
  const dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), "policy-registry-"));
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts", "run_case_compiler_equivalence.mjs"), custodyCases, CASE_NAME],
      { env: { ...process.env, KEEL_WRITE_SOURCE: dumpDir }, stdio: "ignore" },
    );
    const pair = JSON.parse(await fs.readFile(path.join(dumpDir, `source-${CASE_NAME}`), "utf8"));
    const compiled = compileCase(pair.caseSource, pair.evidence).model_case;
    for (const family of ["rcf_policy", "cash_policy", "lease_policy"]) {
      check(
        compiled[family]?.policy_binding?.policy_id === family &&
          compiled[family]?.policy_binding?.version === registry.entries[family].version,
        `compiled case seals a ${family} binding matching the registry`,
      );
    }
    check(validateJsonSchema(compiled, modelCaseSchema).length === 0,
      "the compiled, binding-stamped case satisfies model-case-v2");
    custodyE2E = "run";
  } finally {
    await fs.rm(dumpDir, { recursive: true, force: true });
  }
}

const declaredOnly = entries.filter(([, entry]) => entry.binding_status === "declared_only").length;
console.log(JSON.stringify({
  status: "PASS",
  checks,
  families: entries.length,
  bound: bound.length,
  declared_only: declaredOnly,
  custody_e2e: custodyE2E,
}));
