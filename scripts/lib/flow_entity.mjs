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

const STABLE_IDENTIFIER_KEYS = Object.freeze([
  "lei",
  "factset_entity_id",
  "company_number",
  "isin",
  "cusip",
  "ticker",
]);

// P1.6 — identifier STRENGTH tiers. A registry-grade agreement (LEI,
// FactSet entity, company number) identifies the LEGAL ENTITY and outranks
// any security- or listing-grade disagreement: the same company listed on
// two venues must not mismatch because its ticker carries a market suffix.
// A registry-grade CONFLICT is equally decisive in the other direction.
const IDENTIFIER_TIERS = Object.freeze([
  { grade: "registry", keys: ["lei", "factset_entity_id", "company_number"] },
  { grade: "security", keys: ["isin", "cusip"] },
  { grade: "listing", keys: ["ticker"] },
]);

// A listing ticker's market suffix ("AZN.L", "AAPL US", "BMW-DE") is venue
// notation, not identity. Two tickers are compatible when their normalised
// forms are equal, or when one side is exactly the other's leading symbol
// before the venue separator. Two DIFFERENT suffixed forms (share classes:
// "BRK.A" vs "BRK.B") remain a conflict.
function tickerCompatible(leftRaw, rightRaw) {
  const lead = (value) =>
    String(value ?? "").trim().toUpperCase().split(/[.\s\-:/]+/)[0].replace(/[^A-Z0-9]/g, "");
  const left = normaliseIdentifier(leftRaw);
  const right = normaliseIdentifier(rightRaw);
  if (left === right) return true;
  const leftLead = lead(leftRaw);
  const rightLead = lead(rightRaw);
  return leftLead === rightLead && (left === leftLead || right === rightLead);
}

function normaliseIdentifier(value) {
  const cleaned = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return cleaned || null;
}

function entityDescriptor(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const identifiers = value.identifiers && typeof value.identifiers === "object"
      ? value.identifiers
      : {};
    return {
      name: String(value.name ?? value.entity_name ?? ""),
      identifiers: Object.fromEntries(
        STABLE_IDENTIFIER_KEYS
          .map((key) => [key, normaliseIdentifier(identifiers[key] ?? value[key])])
          .filter(([, identifier]) => identifier !== null),
      ),
      // Raw forms survive for venue-aware comparisons (ticker suffixes are
      // meaning-bearing separators that normalisation erases).
      raw_identifiers: Object.fromEntries(
        STABLE_IDENTIFIER_KEYS
          .map((key) => [key, identifiers[key] ?? value[key] ?? null])
          .filter(([, identifier]) => identifier !== null && identifier !== undefined),
      ),
      aliases: Array.isArray(value.aliases)
        ? value.aliases.map(String).filter(Boolean)
        : [],
      consolidation_level: value.consolidation_level ?? null,
    };
  }
  return {
    name: String(value ?? ""),
    identifiers: {},
    aliases: [],
    consolidation_level: null,
  };
}

export function entityTokens(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !LEGAL_FORMS.has(token));
}

function tokenMatch(leftName, rightName) {
  const left = entityTokens(leftName);
  const right = entityTokens(rightName);
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
  if (onlyExport.length > 0 && onlyFiling.length > 0) {
    return { verdict: "ambiguous", kind: "successor", shared, onlyExport, onlyFiling };
  }
  return { verdict: "ambiguous", kind: "subsidiary", shared, onlyExport, onlyFiling };
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
  const left = entityDescriptor(exportEntity);
  const right = entityDescriptor(filingEntity);
  // P1.6: an explicitly declared perimeter difference is decisive before any
  // identifier — the same legal group at consolidated vs company level is
  // NOT one model entity. Silence on either side gates nothing.
  if (
    left.consolidation_level &&
    right.consolidation_level &&
    String(left.consolidation_level) !== String(right.consolidation_level)
  ) {
    return {
      verdict: "mismatch",
      kind: "consolidation_perimeter_mismatch",
      left_consolidation_level: left.consolidation_level,
      right_consolidation_level: right.consolidation_level,
      shared: [], onlyExport: [], onlyFiling: [],
    };
  }
  // Tiered identifier resolution: the STRONGEST tier with any shared key
  // decides. A lower-tier disagreement never vetoes a higher-tier agreement;
  // it is recorded as an overridden conflict instead.
  const overridden = [];
  for (const tier of IDENTIFIER_TIERS) {
    const sharedKeys = tier.keys.filter(
      (key) => left.identifiers[key] && right.identifiers[key],
    );
    if (sharedKeys.length === 0) continue;
    const conflicts = sharedKeys.filter((key) =>
      key === "ticker"
        ? !tickerCompatible(left.raw_identifiers?.ticker, right.raw_identifiers?.ticker)
        : left.identifiers[key] !== right.identifiers[key],
    );
    if (conflicts.length > 0) {
      return {
        verdict: "mismatch",
        kind: "stable_identifier_conflict",
        identifier_grade: tier.grade,
        stable_identifiers_compared: sharedKeys,
        conflicting_identifiers: conflicts,
        left_identifiers: left.identifiers,
        right_identifiers: right.identifiers,
        shared: [], onlyExport: [], onlyFiling: [],
      };
    }
    // Agreement at this tier settles the entity; note weaker-tier conflicts
    // for the audit trail without letting them veto.
    for (const lowerTier of IDENTIFIER_TIERS.slice(IDENTIFIER_TIERS.indexOf(tier) + 1)) {
      for (const key of lowerTier.keys) {
        if (!left.identifiers[key] || !right.identifiers[key]) continue;
        const agrees = key === "ticker"
          ? tickerCompatible(left.raw_identifiers?.ticker, right.raw_identifiers?.ticker)
          : left.identifiers[key] === right.identifiers[key];
        if (!agrees) overridden.push({ key, grade: lowerTier.grade });
      }
    }
    return {
      verdict: "match",
      kind: "stable_identifier_match",
      identifier_grade: tier.grade,
      stable_identifiers_compared: sharedKeys,
      ...(overridden.length > 0 ? { overridden_weaker_conflicts: overridden } : {}),
      left_identifiers: left.identifiers,
      right_identifiers: right.identifiers,
      shared: [], onlyExport: [], onlyFiling: [],
    };
  }
  const direct = tokenMatch(left.name, right.name);
  if (direct.verdict === "match") return direct;
  for (const leftName of [left.name, ...left.aliases]) {
    for (const rightName of [right.name, ...right.aliases]) {
      const alias = tokenMatch(leftName, rightName);
      if (alias.verdict === "match") {
        return { ...alias, kind: "declared_alias_match" };
      }
    }
  }
  return direct;
}

/**
 * The names to compare, resolved from an intake bundle in the authoritative
 * export vocabulary. `export.entity.name` is exactly what N0 hands over.
 */
export function entityNames(intake) {
  return {
    exportEntity: intake?.export?.entity ?? intake?.company_name ?? null,
    filingEntity: intake?.filings?.entity ?? (
      intake?.filings?.entity_name
        ? {
            name: intake.filings.entity_name,
            identifiers: intake.filings.entity_identifiers ?? {},
            aliases: intake.filings.entity_aliases ?? [],
            consolidation_level: intake.filings.consolidation_level ?? null,
          }
        : intake?.company_name ?? null
    ),
  };
}

export function entityStop(intake) {
  const { exportEntity, filingEntity } = entityNames(intake);
  const match = matchEntities(exportEntity, filingEntity);
  if (match.verdict === "match" || match.verdict === "unknown") {
    return { stop: false, match, export_entity: exportEntity, filing_entity: filingEntity };
  }
  const detail =
    match.kind === "stable_identifier_conflict"
      ? `The sources carry conflicting stable issuer identifiers (${match.conflicting_identifiers.join(", ")}). ` +
        `Names alone cannot override that conflict.`
      : match.kind === "successor"
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
      export_entity: entityDescriptor(exportEntity).name,
      filing_entity: entityDescriptor(filingEntity).name,
      detail,
      options: [
        `Re-export from FactSet for ${entityDescriptor(filingEntity).name}`,
        `Use filings for ${entityDescriptor(exportEntity).name} instead`,
      ],
    }),
    export_entity: entityDescriptor(exportEntity).name,
    filing_entity: entityDescriptor(filingEntity).name,
  };
}

export default { NODE_ID, entityTokens, matchEntities, entityNames, entityStop };
