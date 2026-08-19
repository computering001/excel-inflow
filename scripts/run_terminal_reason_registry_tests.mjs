#!/usr/bin/env node
/**
 * P0.5 — Terminal-reason registry and outcome-compiler contract tests.
 *
 * Invariant: every possible terminal reason has an owner and a legal
 * terminal-state mapping; internal categories can never reach user-owned
 * terminal states.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

const registry = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"),
);
check(registry.schema_version === "excel-inflow-terminal-reason-registry/1.0", "registry schema");

const TERMINALS = Object.keys(registry.declared_terminal_states);
check(TERMINALS.length === 7, "exactly seven declared terminal states");
const USER_OWNED = new Set(["ACTION_REQUIRED", "SOURCE_REQUIRED"]);

// 1. Completeness: every reason code carries the full field contract and
// maps only to declared terminals consistent with its category firewall.
const REQUIRED_FIELDS = [
  "owner_layer", "category", "severity", "materiality", "recoverability",
  "user_action", "source_action", "checkpoint_required", "evidence_preserved",
  "allowed_terminal_states",
];
const firewall = registry.category_to_user_owned_terminals;
for (const [code, spec] of Object.entries(registry.reason_codes)) {
  for (const field of REQUIRED_FIELDS) {
    check(field in spec, `${code} lacks ${field}`);
  }
  for (const terminal of spec.allowed_terminal_states) {
    check(TERMINALS.includes(terminal), `${code} maps to undeclared terminal ${terminal}`);
    const lawful = firewall[spec.category];
    check(Array.isArray(lawful) && lawful.includes(terminal),
      `${code}: category ${spec.category} may not reach ${terminal}`);
  }
  // The misclassification firewall itself: internal/source categories NEVER
  // reach the other side's user-owned terminals.
  if (spec.category === "internal") {
    check(!spec.allowed_terminal_states.some((terminal) => USER_OWNED.has(terminal)),
      `${code}: an internal category reached a user-owned terminal`);
  }
}

// 2. Misclassification negative test: a mutated registry mapping an internal
// category to ACTION_REQUIRED must be detected by the same validator logic.
{
  const mutated = structuredClone(registry);
  mutated.reason_codes["INTERNAL.equation_system_unsolved"].allowed_terminal_states = ["ACTION_REQUIRED"];
  let caught = false;
  for (const [code, spec] of Object.entries(mutated.reason_codes)) {
    for (const terminal of spec.allowed_terminal_states) {
      const lawful = firewall[spec.category];
      if (!lawful?.includes(terminal)) caught = true;
    }
  }
  check(caught, "a mutated internal->ACTION_REQUIRED mapping MUST be detected");
}

// 3. The existing runtime vocabulary is fully covered by the migration map:
// every status/blocker/quality value the vnext boundary can emit has a
// classified migration (preserve/rename/split/remove).
const stateSchema = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "excel-inflow-vnext-run.schema.json"), "utf8"),
);
const migration = registry.legacy_status_migration;
for (const status of stateSchema.properties.status.enum) {
  const covered = status in migration ||
    Object.keys(migration).some((key) => key.startsWith(`${status} `));
  check(covered, `public status ${status} has no migration classification`);
}
for (const blockerClass of stateSchema.properties.blocker_class.enum.filter(Boolean)) {
  const covered = Object.keys(migration).some((key) => key.startsWith(blockerClass));
  check(covered, `blocker_class ${blockerClass} has no migration classification`);
}
for (const [legacy, plan] of Object.entries(migration)) {
  if (legacy === "note") continue;
  check(["preserve", "rename", "split", "remove"].includes(plan.action),
    `migration for ${legacy} must be preserve/rename/split/remove`);
}

// 4. Delivery-blocker constitution alignment: the four sealed fatal reasons
// each resolve to a registry code with the right category split (two SOURCE,
// two INTERNAL) — the historical vocabulary keeps custody, never silently.
const workflowContract = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "workflow-state-contract-v1.json"), "utf8"),
);
const fatalReasons = Object.keys(workflowContract.delivery_blocker_constitution.fatal_reasons);
const fatalMapping = {
  issuer_or_reporting_period_unresolved: "SOURCE.issuer_or_reporting_period_unresolved",
  opening_debt_unresolved: "SOURCE.opening_debt_unresolved",
  equation_system_unsolved: "INTERNAL.equation_system_unsolved",
  workbook_delivery_failed: "INTERNAL.workbook_delivery_failed",
};
for (const fatal of fatalReasons) {
  const code = fatalMapping[fatal];
  check(Boolean(code) && code in registry.reason_codes,
    `delivery fatal reason ${fatal} has no registry code`);
}

// 5. ACTION_REQUIRED legality predicate is complete and names the banned causes.
const predicate = registry.action_required_legality_predicate;
check(predicate.all_of.length >= 5, "the legality predicate carries all five conditions");
for (const banned of ["schema drift", "graph failure", "workbook emission error", "package mismatch"]) {
  check(predicate.explicitly_illegal_causes.includes(banned),
    `${banned} must be an explicitly illegal ACTION_REQUIRED cause`);
}

// 6. INTERNAL_FAILURE payload requirements include the earliest responsible
// layer, checkpoint, preserved hashes and invalidation scope.
for (const field of ["earliest_responsible_layer", "resumable_checkpoint_path", "preserved_source_hashes", "downstream_invalidation_scope", "reason_code"]) {
  check(registry.internal_failure_payload_requirements.includes(field),
    `INTERNAL_FAILURE payload must require ${field}`);
}

// 7. Support-envelope reason codes stay aligned with the envelope contract's
// early-stop predicates (PROFILE.* mirrors UNSUPPORTED_PROFILE.*).
const envelope = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "support-envelope-v377.json"), "utf8"),
);
for (const stopPredicate of envelope.early_stop_predicates) {
  const suffix = stopPredicate.reason_code.replace("UNSUPPORTED_PROFILE.", "");
  check(`PROFILE.${suffix}` in registry.reason_codes,
    `envelope predicate ${stopPredicate.id} has no PROFILE.${suffix} registry code`);
}

console.log(JSON.stringify({ status: "PASS", checks, reason_codes: Object.keys(registry.reason_codes).length }));
