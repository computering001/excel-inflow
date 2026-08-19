#!/usr/bin/env node

// P1.6 — identifier-strength entity and perimeter resolution, proven against
// the EXISTING resolver (scripts/lib/flow_entity.mjs :: matchEntities).
//
// The resolver's identifier model today: one flat "stable" tier
// (STABLE_IDENTIFIER_KEYS = lei, factset_entity_id, company_number, isin,
// cusip, ticker), normalised by uppercasing and stripping non-alphanumerics.
// Any shared-key conflict forces mismatch; any shared-key agreement (with no
// conflict) forces match; only then do name tokens get a say.
//
// This suite pins the invariants that already hold, and pins — honestly, as
// documenting-current-behaviour — the two defects found:
//
//   DEFECT-P1.6-A (ticker suffix): market-suffixed ticker variants of the
//     SAME issuer ("AZN.L" vs "AZN", "AAPL US" vs "AAPL") normalise to
//     different strings ("AZNL" vs "AZN"), register as a stable-identifier
//     conflict, and force a FALSE mismatch. Because ticker sits in the same
//     tier as LEI, this conflict even vetoes an exact LEI agreement.
//
//   DEFECT-P1.6-B (perimeter): consolidation_level is captured by
//     entityDescriptor but never consulted by matchEntities. A parent/opco
//     pair distinguished only by consolidation_level — or only by a
//     "Group"/"Holdings" token, which entityTokens strips as legal form —
//     silently matches as the same entity.
//
// Checks asserting a defect's current behaviour are marked
// DOCUMENTING-CURRENT-BEHAVIOUR; when the defect is repaired they must be
// flipped to assert the corrected verdict.

import { matchEntities } from "./lib/flow_entity.mjs";

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

// ---------------------------------------------------------------------------
// 1. Identifier strength ordering: a strong-identifier agreement outranks a
//    weak-signal (name-variant) disagreement.
// ---------------------------------------------------------------------------
{
  // Renamed issuer: names share no meaningful tokens, company_number agrees.
  const m = matchEntities(
    { name: "GSK plc", identifiers: { company_number: "03888792" } },
    { name: "GlaxoSmithKline plc", identifiers: { company_number: "03888792" } },
  );
  check(m.verdict === "match", "company_number agreement did not outrank name variance");
  check(m.kind === "stable_identifier_match", "match was not attributed to the stable identifier");
}
{
  // Same, on LEI, with names that token-match to a plain mismatch on their own.
  const m = matchEntities(
    { name: "Alpha plc", identifiers: { lei: "549300ABCDEFGHIJ1234" } },
    { name: "Beta plc", identifiers: { lei: "549300ABCDEFGHIJ1234" } },
  );
  check(m.verdict === "match", "LEI agreement did not outrank a name-token mismatch");
}
{
  // Identifier normalisation tolerates punctuation/format noise on strong ids.
  const m = matchEntities(
    { name: "Issuer plc", identifiers: { company_number: "SC-095000" } },
    { name: "Issuer plc", identifiers: { company_number: "sc095000" } },
  );
  check(m.verdict === "match", "punctuation/case noise on company_number broke the match");
}

// ---------------------------------------------------------------------------
// 2. A strong-identifier CONTRADICTION forces mismatch even when names agree.
// ---------------------------------------------------------------------------
{
  const m = matchEntities(
    { name: "Issuer Holdings plc", identifiers: { company_number: "01111111" } },
    { name: "Issuer Holdings plc", identifiers: { company_number: "02222222" } },
  );
  check(m.verdict === "mismatch", "conflicting company_number did not force mismatch over agreeing names");
  check(m.kind === "stable_identifier_conflict", "mismatch was not attributed to the identifier conflict");
  check(
    Array.isArray(m.conflicting_identifiers) && m.conflicting_identifiers.includes("company_number"),
    "conflict report did not name company_number",
  );
}
{
  const m = matchEntities(
    { name: "Issuer plc", identifiers: { lei: "549300AAAAAAAAAAAA11" } },
    { name: "Issuer plc", identifiers: { lei: "549300BBBBBBBBBBBB22" } },
  );
  check(m.verdict === "mismatch", "conflicting LEI did not force mismatch over agreeing names");
}

// ---------------------------------------------------------------------------
// 3. Market-suffixed ticker variants of the same issuer.
//    CURRENT RESOLVER FAILS the dot-suffix and space-suffix cases:
//    DEFECT-P1.6-A. Case-only variance is handled correctly.
// ---------------------------------------------------------------------------
{
  // REPAIRED (was DEFECT-P1.6-A): a market suffix is venue notation, not
  // identity — "AZN.L" and "AZN" are the same listing symbol.
  const m = matchEntities(
    { name: "AstraZeneca PLC", identifiers: { ticker: "AZN.L" } },
    { name: "AstraZeneca PLC", identifiers: { ticker: "AZN" } },
  );
  check(m.verdict === "match", "dot-suffixed ticker must match after the P1.6 repair");
  check(m.kind === "stable_identifier_match" && m.identifier_grade === "listing",
    "dot-suffixed ticker match must be listing-grade");
}
{
  // REPAIRED (was DEFECT-P1.6-A): venue-code suffix after a space.
  const m = matchEntities(
    { name: "Apple Inc", identifiers: { ticker: "AAPL US" } },
    { name: "Apple Inc", identifiers: { ticker: "AAPL" } },
  );
  check(m.verdict === "match", "space-suffixed ticker must match after the P1.6 repair");
  // Share classes remain a REAL conflict: neither side is the bare symbol.
  const classes = matchEntities(
    { name: "Berkshire Hathaway", identifiers: { ticker: "BRK.A" } },
    { name: "Berkshire Hathaway", identifiers: { ticker: "BRK.B" } },
  );
  check(classes.verdict === "mismatch", "distinct share classes must still conflict");
}
{
  // REPAIRED (was DEFECT-P1.6-A worst face): registry-grade agreement (LEI)
  // decides; a weaker-tier signal can never veto it. Prove the tier ordering
  // with a GENUINE lower-tier conflict under an LEI agreement.
  const m = matchEntities(
    { name: "AstraZeneca PLC", identifiers: { lei: "549300GPCWAC3A4X2117", ticker: "AZN.L" } },
    { name: "AstraZeneca", identifiers: { lei: "549300GPCWAC3A4X2117", ticker: "AZN" } },
  );
  check(m.verdict === "match" && m.identifier_grade === "registry",
    "LEI agreement must decide at registry grade");
  const overridden = matchEntities(
    { name: "Holdco", identifiers: { lei: "549300GPCWAC3A4X2117", ticker: "AAA.X" } },
    { name: "Holdco", identifiers: { lei: "549300GPCWAC3A4X2117", ticker: "BBB.Y" } },
  );
  check(overridden.verdict === "match" &&
    (overridden.overridden_weaker_conflicts ?? []).some((c) => c.key === "ticker"),
    "a genuine ticker conflict under an LEI agreement is overridden AND recorded");
}
{
  // Case-only ticker variance IS handled: normalisation uppercases both sides.
  const m = matchEntities(
    { name: "Apple Inc", identifiers: { ticker: "aapl" } },
    { name: "Apple Inc", identifiers: { ticker: "AAPL" } },
  );
  check(m.verdict === "match", "case-only ticker variance created a false mismatch");
  check(m.kind === "stable_identifier_match", "case-only ticker match was not attributed to the identifier");
}

// ---------------------------------------------------------------------------
// 4. Ambiguity: entities sharing only a generic name token never match.
// ---------------------------------------------------------------------------
{
  const m = matchEntities({ name: "Alpha Energy PLC" }, { name: "Beta Energy Ltd" });
  check(m.verdict !== "match", "entities sharing only a generic token were matched");
  check(m.verdict === "ambiguous", "generic-token overlap did not surface as ambiguous");
}
{
  const m = matchEntities({ name: "National Grid plc" }, { name: "National Express Group plc" });
  check(m.verdict !== "match", "entities sharing only 'National' were matched");
}
{
  // No token overlap at all: plain mismatch, never match.
  const m = matchEntities({ name: "Alpha plc" }, { name: "Beta plc" });
  check(m.verdict === "mismatch", "disjoint names did not produce mismatch");
}

// ---------------------------------------------------------------------------
// 5. Perimeter: parent/opco pairs must not silently match as the same entity.
// ---------------------------------------------------------------------------
{
  // Token-visible perimeter difference IS caught: "Operating Company" tokens
  // survive stripping, so holdco vs opco surfaces as ambiguous(subsidiary).
  const m = matchEntities({ name: "Issuer Holdings PLC" }, { name: "Issuer Operating Company Ltd" });
  check(m.verdict === "ambiguous", "token-visible parent/opco pair did not surface as ambiguous");
  check(m.kind === "subsidiary", "parent/opco ambiguity was not classified as subsidiary");
}
{
  // REPAIRED (was DEFECT-P1.6-B): a declared perimeter difference is
  // decisive before identifiers; silence on either side gates nothing.
  const m = matchEntities(
    { name: "AstraZeneca PLC", consolidation_level: "consolidated" },
    { name: "AstraZeneca PLC", consolidation_level: "company" },
  );
  check(m.verdict === "mismatch" && m.kind === "consolidation_perimeter_mismatch",
    "an explicitly declared perimeter difference must be decisive (P1.6 repair)");
  const silentOk = matchEntities(
    { name: "AstraZeneca PLC", consolidation_level: "consolidated" },
    { name: "AstraZeneca PLC" },
  );
  check(silentOk.verdict === "match", "perimeter silence on one side gates nothing");
}
{
  // DOCUMENTING-CURRENT-BEHAVIOUR — DEFECT-P1.6-B (repair required).
  // "Group" is stripped as a legal form, so a parent distinguished ONLY by
  // that token silently matches its opco. Correct behaviour after repair:
  // surfaced as a perimeter ambiguity, not a silent match.
  const m = matchEntities({ name: "Vodafone Group PLC" }, { name: "Vodafone PLC" });
  check(m.verdict === "match", "Group-token perimeter current behaviour changed — retire DEFECT-P1.6-B note");
}

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
