/** Canonical semantic-role ownership shared across topology and forecast layers. */
export const SEMANTIC_ROLE_ALIASES = Object.freeze({
  operating_income: "operating_profit",
  operating_loss: "operating_profit",
  acquisition: "acquisitions_net_of_cash",
  acquisition_cost: "acquisitions_net_of_cash",
  business_combination: "acquisitions_net_of_cash",
});

export const STRUCTURED_EVENT_ROLES = Object.freeze(new Set([
  "acquisitions_net_of_cash",
  "disposal",
  "litigation",
  "legal_settlement",
  "restructuring",
  "impairment_loss",
  "exceptional_item",
  "discontinued_operation",
]));

export function canonicalSemanticRole(value) {
  const role = String(value ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return SEMANTIC_ROLE_ALIASES[role] ?? role;
}

export function isStructuredEventRole(value) {
  return STRUCTURED_EVENT_ROLES.has(canonicalSemanticRole(value));
}

export default { canonicalSemanticRole, isStructuredEventRole, SEMANTIC_ROLE_ALIASES, STRUCTURED_EVENT_ROLES };
