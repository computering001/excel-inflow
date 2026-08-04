// ENTITY MATCHING — node N2's gate.
//
// "The export and the filings are the same reporting entity" cannot be checked
// at N0. Filings are not a stage-1 input, so N0 sits upstream of the node that
// reads them; N0 carries the export's declared entity forward untouched in
// `handoff.entity` and N2 decides. SHIP-PLAN-20260726.md §1a states the move
// explicitly. ARCHITECTURE-20260726.md §2's gate table still lists "entity
// matches filings" against N0 — that row predates §1a and is the one place the
// two documents disagree; §1a is later and is the one that gives a reason.
//
// This lived in flow_reconcile.mjs, next to the reconciliation, because the
// ORDERING between the two is load-bearing: entity matching runs BEFORE the
// residual is diagnosed. An export for the predecessor entity produces a
// residual that looks exactly like a date problem and is not, and telling the
// user to re-export at the year end when the real fault is that the filings are
// for the merged group sends them round a loop that cannot close. The ordering
// is now owned by the callers (flow.mjs stage 2, and N2's gate), and stated in
// both.

import { renderEntityScreen } from "./flow_screens.mjs";

/** The node that owns this check. N0 reports the export's entity; N2 decides. */
export const NODE_ID = "N2";

const LEGAL_FORMS = new Set([
  "plc",
  "inc",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "llc",
  "lp",
  "nv",
  "bv",
  "sa",
  "se",
  "ag",
  "spa",
  "as",
  "ab",
  "oyj",
  "the",
  "holdings",
  "holding",
  "group",
  "groupe",
  "international",
]);

export function entityTokens(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !LEGAL_FORMS.has(token));
}

/**
 * Compare the entity the export covers with the entity the filings cover.
 *
 * Surface only if ambiguous: an exact match after stripping legal form is a
 * match and says nothing; no overlap at all is a plain mismatch; a partial
 * overlap is the dangerous case — post-merger, holdco/opco, or a predecessor
 * name — and that is what gets shown.
 */
export function matchEntities(exportEntity, filingEntity) {
  const left = entityTokens(exportEntity);
  const right = entityTokens(filingEntity);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const shared = left.filter((token) => rightSet.has(token));
  const onlyExport = left.filter((token) => !rightSet.has(token));
  const onlyFiling = right.filter((token) => !leftSet.has(token));

  if (left.length === 0 || right.length === 0) {
    return { verdict: "unknown", shared, onlyExport, onlyFiling };
  }
  if (onlyExport.length === 0 && onlyFiling.length === 0) {
    return { verdict: "match", shared, onlyExport, onlyFiling };
  }
  if (shared.length === 0) {
    return { verdict: "mismatch", shared, onlyExport, onlyFiling };
  }
  // Shares a name, differs on a distinguishing token in both directions: the
  // signature of a merger or a renamed successor.
  if (onlyExport.length > 0 && onlyFiling.length > 0) {
    return { verdict: "ambiguous", kind: "successor", shared, onlyExport, onlyFiling };
  }
  // One is a strict extension of the other: holdco/opco, or a subsidiary.
  return { verdict: "ambiguous", kind: "subsidiary", shared, onlyExport, onlyFiling };
}

/**
 * The names to compare, resolved from an intake bundle in the authoritative
 * export vocabulary. `export.entity.name` is exactly what N0 hands over.
 */
export function entityNames(intake) {
  return {
    exportEntity: intake?.export?.entity?.name ?? intake?.company_name ?? null,
    filingEntity: intake?.filings?.entity_name ?? intake?.company_name ?? null,
  };
}

export function entityStop(intake) {
  const { exportEntity, filingEntity } = entityNames(intake);
  const match = matchEntities(exportEntity, filingEntity);
  if (match.verdict === "match" || match.verdict === "unknown") {
    return { stop: false, match, export_entity: exportEntity, filing_entity: filingEntity };
  }
  const detail =
    match.kind === "successor"
      ? `Your export is for the predecessor or a different arm of the group. The gap ` +
        `this produces looks like a date problem and is not — re-exporting at the ` +
        `year end will not close it.`
      : match.verdict === "mismatch"
        ? `These share no name in common. One of the two is for the wrong company.`
        : `One of these is a parent or subsidiary of the other. Debt sits at ` +
          `different levels of a group, so the two will not foot.`;
  return {
    stop: true,
    match,
    detail,
    screen: renderEntityScreen({
      export_entity: exportEntity,
      filing_entity: filingEntity,
      detail,
      options: [
        `Re-export from FactSet for ${filingEntity}`,
        `Use filings for ${exportEntity} instead`,
      ],
    }),
    export_entity: exportEntity,
    filing_entity: filingEntity,
  };
}

export default { NODE_ID, entityTokens, matchEntities, entityNames, entityStop };
