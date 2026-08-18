/**
 * Funded acquisition runtime policy.
 *
 * The transaction is an overlay, not a second authored statement. Standalone
 * J:L forecast authority therefore remains untouched. Sources/uses are
 * carried by the solver and the adjustment-column plan: consideration uses
 * the issuer's existing acquisitions row and debt proceeds use the existing
 * debt-issuance/change-in-debt row. No synthetic cash-flow rows are created.
 */
export function fundedAcquisitionRole(row) {
  const role = String(row?.semantic_role ?? row?.role ?? row?.row_id ?? "")
    .toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["acquisitions_net_of_cash", "acquisition_consideration", "purchase_consideration"].includes(role)) return "consideration";
  if (["debt_issuance", "change_in_debt", "additions_to_debt", "acquisition_debt_proceeds"].includes(role)) return "debt_proceeds";
  return null;
}

// Acquisition transaction cash is not a standalone forecast-authority
// candidate. It lives exclusively in N:P and the pro-forma solve.
export function fundedAcquisitionCandidate() { return null; }

// Kept as a compatibility hook for the case compiler. It is intentionally a
// no-op: adding transaction rows here would contaminate standalone J:L and
// duplicate the existing investing/financing rows.
export function applyFundedAcquisitionRows(modelCase) { return modelCase; }

export default { applyFundedAcquisitionRows, fundedAcquisitionCandidate, fundedAcquisitionRole };
