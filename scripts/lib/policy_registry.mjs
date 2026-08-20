/**
 * P2.7 — versioned policy registry (load-validate-freeze).
 *
 * Every model-owned assumption family binds to a registry entry
 * {policy_id, version, owned_assumption, evidence_hierarchy}.  The case-level
 * policy objects carry the binding (stamped at the compilePolicies attach
 * seam) so a version change is receipt-visible on the sealed case.
 *
 * Vocabularies are the EXISTING ones — never a second ladder:
 *   evidence_hierarchy rungs  -> FORECAST_AUTHORITY_PRIORITY (forecast_authority.mjs)
 *   owned_assumption.module   -> assets/canonical-model-graph-v2.json modules
 *   owned_assumption roles    -> SCHEDULE_PRODUCER_BY_ROLE (forecast_producer_contract.mjs)
 *
 * Validators validate, never repair: a malformed registry throws at load; a
 * policy object without a bound entry throws at stamp time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./json_schema.mjs";
import { FORECAST_AUTHORITY_PRIORITY } from "./forecast_authority.mjs";
import { SCHEDULE_PRODUCER_BY_ROLE } from "./forecast_producer_contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../assets");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ASSETS, name), "utf8"));
}

export const POLICY_REGISTRY_SCHEMA = readJson("policy-registry-v1.schema.json");

const CANONICAL_MODULES = Object.freeze(readJson("canonical-model-graph-v2.json").modules);
const SCHEDULE_ROLES = new Set(Object.keys(SCHEDULE_PRODUCER_BY_ROLE));

export function validatePolicyRegistry(registry) {
  const errors = validateJsonSchema(registry, POLICY_REGISTRY_SCHEMA);
  if (errors.length > 0) return errors;
  for (const [key, entry] of Object.entries(registry.entries)) {
    if (entry.policy_id !== key) {
      errors.push(`entries.${key}.policy_id must equal its key; got ${JSON.stringify(entry.policy_id)}.`);
    }
    const owned = entry.owned_assumption;
    if (owned.scope === "model") {
      if (!CANONICAL_MODULES.includes(owned.module)) {
        errors.push(`entries.${key}.owned_assumption.module ${JSON.stringify(owned.module)} is not a canonical-model-graph module.`);
      }
    } else if (owned.module !== null) {
      errors.push(`entries.${key}.owned_assumption.module must be null when scope is runtime.`);
    }
    const seenRoles = new Set();
    for (const role of owned.schedule_roles) {
      if (!SCHEDULE_ROLES.has(role)) {
        errors.push(`entries.${key}.owned_assumption.schedule_roles: ${JSON.stringify(role)} is not a SCHEDULE_PRODUCER_BY_ROLE role.`);
      }
      if (seenRoles.has(role)) errors.push(`entries.${key}.owned_assumption.schedule_roles duplicates ${role}.`);
      seenRoles.add(role);
    }
    if (owned.scope === "runtime" && owned.schedule_roles.length > 0) {
      errors.push(`entries.${key}: a runtime-scoped family may not claim schedule roles.`);
    }
    // Evidence hierarchy: rungs must exist on the one true ladder and descend
    // in strength (strictly increasing priority number). Empty only for
    // engineering-owned constants — declared, never silent.
    if (entry.evidence_hierarchy.length === 0) {
      if (entry.system_owned !== true) {
        errors.push(`entries.${key}.evidence_hierarchy may be empty only when system_owned is true.`);
      }
    } else if (entry.system_owned === true) {
      errors.push(`entries.${key}: a system_owned constant declares no case evidence_hierarchy; got ${entry.evidence_hierarchy.length} rung(s).`);
    }
    let previousPriority = -Infinity;
    for (const rung of entry.evidence_hierarchy) {
      const priority = FORECAST_AUTHORITY_PRIORITY[rung];
      if (priority === undefined) {
        errors.push(`entries.${key}.evidence_hierarchy rung ${JSON.stringify(rung)} is not a FORECAST_AUTHORITY_PRIORITY method.`);
        continue;
      }
      if (priority <= previousPriority) {
        errors.push(`entries.${key}.evidence_hierarchy must descend strictly in authority; ${rung} (${priority}) does not weaken the previous rung (${previousPriority}).`);
      }
      previousPriority = priority;
    }
    if (entry.binding_status === "bound" && entry.case_binding === null) {
      errors.push(`entries.${key} is bound but names no case_binding key.`);
    }
    if (entry.binding_status === "declared_only" && entry.case_binding !== null) {
      errors.push(`entries.${key} is declared_only but names case_binding ${JSON.stringify(entry.case_binding)}.`);
    }
  }
  const bindings = Object.values(registry.entries)
    .map((entry) => entry.case_binding)
    .filter((binding) => binding !== null);
  for (const binding of bindings) {
    if (bindings.indexOf(binding) !== bindings.lastIndexOf(binding)) {
      errors.push(`case_binding ${binding} is claimed by more than one registry entry.`);
    }
  }
  return errors;
}

const registry = readJson("policy-registry-v1.json");
const registryErrors = validatePolicyRegistry(registry);
if (registryErrors.length > 0) {
  throw new Error(`Invalid policy registry:\n- ${registryErrors.join("\n- ")}`);
}

export const POLICY_REGISTRY = Object.freeze(registry);

/** The registry entry bound to a model-case policy key, or null. */
export function boundPolicyEntry(caseBindingKey, activeRegistry = POLICY_REGISTRY) {
  return (
    Object.values(activeRegistry.entries).find(
      (entry) => entry.binding_status === "bound" && entry.case_binding === caseBindingKey,
    ) ?? null
  );
}

/**
 * Stamp {policy_id, version} bindings onto compiled case policy objects.
 * Called at the compilePolicies attach seam.  A policy object with no bound
 * registry entry is an engineering defect: throw, never default — a missing
 * binding must never seal as an unversioned policy.
 */
export function stampPolicyBindings(policies, activeRegistry = POLICY_REGISTRY) {
  for (const [key, policyObject] of Object.entries(policies)) {
    if (policyObject === null || typeof policyObject !== "object" || Array.isArray(policyObject)) {
      throw new Error(`Policy object ${key} must be an object to carry a policy binding.`);
    }
    const entry = boundPolicyEntry(key, activeRegistry);
    if (!entry) {
      throw new Error(
        `No bound policy-registry entry claims case key ${key}; register the family in assets/policy-registry-v1.json before sealing it.`,
      );
    }
    policyObject.policy_binding = {
      policy_id: entry.policy_id,
      version: entry.version,
    };
  }
  return policies;
}
