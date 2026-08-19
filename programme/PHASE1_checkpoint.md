# Phase 1 checkpoint — Canonical contracts, typed values and schema closure

Status: **SEALED (with two declared core-only packages)** — every package carries
an issue card, a registered focused suite and a green ladder at its seal commit.

## Package seals

- **P1.1** `b989037` — canonical contract source (repository-owned IDL; deterministic generator; JS+Python bindings; JS↔Py round trip byte-preserving; unknown versions refused in both languages). SEALED_SHADOW→active with the P0.8 receipt.
- **P1.2** `c5f2ac6` — typed financial value model, **core only**: all twelve states, structural never-zero (absence states cannot carry a value field), 86 checks, 18 cross-language verdicts. REMAINING: producer migration (extractor/evidence/compiler emit typed values) — sequenced after P1.4, tracked on the issue card.
- **P1.3** `c5f2ac6` — typed arithmetic service, **core only**: dimension refusals, policy-recorded missingness, precision-derived tolerances, receipts (20 checks). REMAINING: high-risk call-site migration + Python arithmetic oracle — owners named.
- **P1.4** `c3b620a` — producer-boundary validation: oneOf/anyOf enforcement (18 shipped constructs were silently unenforced), one real latent violation surfaced and repaired at the declaration layer (temporal_edge), full battery green with enforcement live.
- **P1.5** `e957b62` — ETR receipt boundary: the ledger previously VANISHED from sealed cases; now sealed once, hash-bound, referenced by authorities, census-guarded; AZ replay green via the explicit legacy adapter (39-check subagent suite).
- **P1.6** `e957b62` — identifier-strength entity resolution: typed tiers (registry>security>listing), venue-aware tickers (share classes still conflict), declared-perimeter gate; two live defects repaired (a ticker suffix could veto an exact LEI match); 25-check suite.
- **P1.7** `d40456f` — coercion ban: 2,004-check fingerprint linter; 399 lines/436 occurrences inventoried and classified (252 suspect with owner phases assigned — including the verify-oracle's own blank→0.0 reader and the solver committing unresolved as 0); no NEW coercion can enter.
- **P1.8** `f617ce7` — dual-read migration: explicit legacy→typed adapter; 2,023 checks over 1,008 projections across the corpus (external AZ case included); every legacy value survives the round trip, every legacy null reads back null.

## Phase 1 invariants — proof state

1. *Producer validates against the consumer's canonical contract* — P1.1/P1.4 ✔
2. *Blank/nil/missing/parse-failure never zero* — structural in the typed model (P1.2), fingerprint-banned in sources (P1.7), corpus-proven in dual read (P1.8) ✔ — with the inventoried legacy coercions as the tracked migration debt
3. *Currency/unit/scale/period explicit in arithmetic* — service core sealed (P1.3); call-site migration owned ✔ (core)
4. *Identifier strength + perimeter over ticker-string equality* — P1.6 ✔
5. *Legacy readable via explicit adapters; no new ambiguous nullable writes* — P1.8 adapter + P1.5/P1.6 legacy-case adapter ✔

## Known remaining Phase-1 debt (owned, not silent)

- P1.2/P1.3 producer + call-site migrations (owners on issue cards)
- 252 suspect coercions (fingerprint-tracked; top-5 assigned to P4.3/P4.7/P7.6)
- validateJsonSchema's remaining dialect gaps beyond oneOf/anyOf are unaudited (P1.4 card)

## Rollback

Each package is an atomic commit; the Phase-0 baseline tag stands.
