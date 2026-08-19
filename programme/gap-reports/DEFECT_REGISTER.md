# Defect register — found by archetype breadth testing (P7.1c wave, 2026-08-19)

Every entry below was found by a synthetic archetype case, is reproducible, and is
NOT yet fixed. Each needs its own package with a failing proof first. Ordered by
real-world severity. Anchors verified at f412160.

## D1 — the standard IFRS 15 revenue caption cannot classify (SEVERITY: HIGH)
`Revenue from contracts with customers` classifies as `unmapped`: top candidates
`cost_of_sales` and `revenue` TIE at 0.51/0.51, margin 0.00. Acceptance requires a
>=0.15 separation margin, so **a tie is structurally unbreakable** — no amount of
structural, numeric or hierarchy evidence can separate it. `Group revenue` fails
identically. Consequence: the most common modern IFRS revenue caption always forces
a clarification stop on a real filing.
Owner surface: scripts/lib/statement_classifier.mjs (scoring + margin rule) and the
role alias table in scripts/lib/semantic_roles.mjs.
Fix shape (proposal, not yet decided): a tie between a family-parent role and a
family-member role is not a genuine ambiguity — the parent should win when the row's
structural position is the family head. Alternatively add the caption to the alias
table. EITHER WAY the repair must not lower the 0.15 margin (that would weaken the
validator); it must break the tie on evidence.

## D2 — "Net revenues" leads with net_income (SEVERITY: HIGH)
The `net` token pulls the top line toward the bottom line: sole leading candidate
`net_income` at 0.44. A near-miss that would silently mis-anchor an entire model
rather than refusing. Same owner surface as D1.

## D3 — one-word variant of the standard IFRS cash-flow subtotal becomes a 3-way tie (SEVERITY: HIGH)
`Net cash generated from operating activities` ties at 0.72 across
`cash_from_financing` / `cash_from_investing` / `cash_from_operations` (margin 0.00),
while the aliased `Net cash from operating activities` accepts at 0.95. The WRONG
sections tie with the right one. Same owner surface as D1.

## D4 — the taxonomy has no direct-method roles, but the envelope claims direct-method support
assets/statement-semantic-taxonomy.v1.json declares 46 roles, NONE for gross
operating receipts/payments; assets/support-envelope-v377.json nonetheless classifies
`cash_flow_method: direct` as EXPERIMENTAL (a supported value, runnable in a ring).
Every direct-method operating line is therefore unmapped and material-blocking.
Fix: either add the roles (taxonomy work) or demote the envelope claim. This is the
same claim-vs-evidence dishonesty class P7.1a's grid measures.

## D5 — two footing oracles disagree on identical printed figures
scripts/lib/model_ir_v3.mjs:508 `footingTolerance` documents itself as mirroring
`case_compiler.sourceTolerance`, but case_compiler.mjs:176 returns EXACTLY 0 with no
declared precision while footingTolerance adds `1e-9 * max(1,|target|) + 1e-12`.
Proven: members 12.3 + 45.6 vs printed 57.9, no declared precision →
`sourceHistoricalSumMatches` FALSE but `compileModelIrV3` PASS with 0 findings.
Fix: one tolerance function, one home, both callers consuming it.

## D6 — a printed dash left ABSENT escapes the footing pass entirely
`filedNumber(null)` skips the period ("a filed dash asserts nothing"). Proven: total
`[null,null,null]` vs members summing to 30 → PASS, 0 findings; the same dash
classified `reported_zero` → BLOCK on all three periods. The never-zero invariant
correctly stops absence becoming zero, but NOTHING forces a printed dash to be
classified, so a genuine reported nil escapes verification. Fix: require a printed
cell to carry a classification (zero vs absent), and treat an unclassified printed
glyph as a typed finding.

## D7 — three envelope/contract claim mismatches
(a) `historical_periods=three_or_more` is CERTIFIED but `validateCaseShape` admits
EXACTLY three; a 7-period case is refused with an internal schema string, not a
registered terminal reason.
(b) A functional currency distinct from the presentation currency is
UNREPRESENTABLE: `issuer.functional_currency` is refused as a disallowed property.
(c) A per-statement unit scale is UNREPRESENTABLE: `issuer.units` is one enumerated
scalar, so a filing printing £000 and £m in different statements has no lawful
representation — the mismatch can only be caught later, by footing.

## D8 — split ordering authority (finding, lower severity)
`validateFiscalPeriods` returns ZERO errors on a newest-first period series; only
`validateCaseShape` catches it. A caller running fiscal-period validation alone
passes a fully reversed comparative layout.

## D9 — uniform unit mis-scale is invisible (from archetype 23)
A PARTIAL printed-unit mis-scale blocks, but a UNIFORM mis-scale foots perfectly and
is undetectable by footing. Needs an independent unit-label reconciliation (P2.1
landed the label reconciliation; this is the case that shows why it must be
fail-closed on uniform mismatch too).

## Observation (not a defect, but a trap for test authors)
Both certified fixtures report 3 `validateCaseShape` errors AS THEY SIT ON DISK — the
three `production_model` contract-version stamps are absent and supplied by the
evidence/compile lane. Any test asserting `validateCaseShape(fixture).length === 0`
directly on a fixture file is wrong.

## Naming mirror (recorded, deliberate, not a defect)
The envelope emits `UNSUPPORTED_PROFILE.<suffix>`; the registry registers
`PROFILE.<suffix>`. The terminal-registry suite mirrors this deliberately; the
archetype catalogue names the REGISTERED code and resolves the mirror explicitly.
