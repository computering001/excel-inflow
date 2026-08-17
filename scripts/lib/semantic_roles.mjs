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

/**
 * EBITDA is not one interchangeable concept.  The selected credit denominator
 * must retain the issuer's economic definition even though older schedule IDs
 * still contain the words `adjusted_ebitda` for file-format compatibility.
 */
export const EBITDA_SEMANTIC_ROLES = Object.freeze([
  "adjusted_ebitda",
  "reported_ebitda",
]);

export function isEbitdaSemanticRole(value) {
  return EBITDA_SEMANTIC_ROLES.includes(canonicalSemanticRole(value));
}

export function selectedEbitdaRow(rows = []) {
  for (const role of EBITDA_SEMANTIC_ROLES) {
    const row = (rows ?? []).find(
      (candidate) => candidate?.semantic_role === role,
    );
    if (row) return row;
  }
  return null;
}

export function ebitdaBasis(row) {
  const semanticRole = row?.semantic_role;
  if (!EBITDA_SEMANTIC_ROLES.includes(semanticRole)) return null;
  const adjusted = semanticRole === "adjusted_ebitda";
  return {
    semantic_role: semanticRole,
    label: adjusted ? "Adjusted EBITDA" : "EBITDA",
    margin_label: adjusted ? "Adjusted EBITDA margin" : "EBITDA margin",
    adjustment_basis: adjusted ? "company_adjusted" : "reported",
  };
}

export function selectedEbitdaBasis(rows = []) {
  const row = selectedEbitdaRow(rows);
  return row ? { row, ...ebitdaBasis(row) } : null;
}

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

export default {
  canonicalSemanticRole,
  isStructuredEventRole,
  selectedEbitdaRow,
  selectedEbitdaBasis,
  ebitdaBasis,
  isEbitdaSemanticRole,
  EBITDA_SEMANTIC_ROLES,
  SEMANTIC_ROLE_ALIASES,
  STRUCTURED_EVENT_ROLES,
};
