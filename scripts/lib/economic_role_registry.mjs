import fs from "node:fs";

const REGISTRY = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/economic-role-registry-v1.json", import.meta.url),
    "utf8",
  ),
);

if (REGISTRY.schema_version !== "economic-role-registry/1.0") {
  throw new Error("Economic-role registry has the wrong schema version.");
}
if (!REGISTRY.roles || typeof REGISTRY.roles !== "object" || Array.isArray(REGISTRY.roles)) {
  throw new Error("Economic-role registry does not contain one role map.");
}

const VALID_RECURRENCE = new Set([
  "recurring",
  "contractual",
  "discrete_event",
  "not_applicable",
]);
const VALID_VARIABILITY = new Set([
  "stable",
  "driver_linked",
  "seasonal",
  "lumpy",
]);

function validateRole(roleId, role) {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(roleId)) {
    throw new Error(`Economic role id is invalid: ${roleId}`);
  }
  if (!role || typeof role !== "object" || Array.isArray(role)) {
    throw new Error(`Economic role ${roleId} does not have an object definition.`);
  }
  if (!Array.isArray(role.sections) || role.sections.length === 0) {
    throw new Error(`Economic role ${roleId} has no statement section.`);
  }
  if (!VALID_RECURRENCE.has(role.recurrence)) {
    throw new Error(`Economic role ${roleId} has invalid recurrence ${role.recurrence}.`);
  }
  if (!VALID_VARIABILITY.has(role.variability)) {
    throw new Error(`Economic role ${roleId} has invalid variability ${role.variability}.`);
  }
  if (typeof role.structured_event !== "boolean") {
    throw new Error(`Economic role ${roleId} has no structured-event flag.`);
  }
}

for (const [roleId, role] of Object.entries(REGISTRY.roles)) {
  validateRole(roleId, role);
}

export const ECONOMIC_ROLE_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(REGISTRY.roles).map(([roleId, role]) => [
      roleId,
      Object.freeze({ ...role, sections: Object.freeze([...role.sections]) }),
    ]),
  ),
);

export const STRUCTURED_EVENT_ROLE_SET = new Set(
  Object.entries(ECONOMIC_ROLE_REGISTRY)
    .filter(([, role]) => role.structured_event === true)
    .map(([roleId]) => roleId),
);

export function economicRoleDefinition(roleId) {
  return ECONOMIC_ROLE_REGISTRY[String(roleId ?? "").trim().toLowerCase()] ?? null;
}

export function validateEconomicRoleCoverage(roleIds) {
  const missing = [...new Set(roleIds)]
    .filter(Boolean)
    .filter((roleId) => !economicRoleDefinition(roleId))
    .sort();
  return {
    status: missing.length === 0 ? "PASS" : "FAIL",
    missing,
  };
}

export default {
  ECONOMIC_ROLE_REGISTRY,
  STRUCTURED_EVENT_ROLE_SET,
  economicRoleDefinition,
  validateEconomicRoleCoverage,
};
