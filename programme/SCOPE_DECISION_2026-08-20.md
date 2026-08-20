# Scope decision — 2026-08-20 (owner)

## Decision
Ship v3.7.7 to GitHub. **Phases 9 and 10 are NOT executed in this programme.** They become
v3.8 work, cut from the v3.7.7 tag.

## Rationale (owner's, recorded as given)
Neither phase adds a capability a user of the workbook would notice. Phase 9 is structural
simplification whose own harness (P9.3 old/new dual-run) exists to prove behaviour is
UNCHANGED. Phase 10 is operational rollout tooling, and with the installed Rogo path excluded
by standing directive it has no substrate — PHASE8_WORK_ORDERS.md line 103 already records
this: "Phase 10 rings/promotion/active-pointer have no substrate with the installed path
excluded."

Refactoring 30,000 lines of the most dangerous code in the repo BEFORE the product has ever
been used is the wrong order.

## What still gets done before the push
1. P5.9 — DONE. CORRECTION: the premise was stale. D23 was already repaired at 102ada3 and the
   build was NEVER blocked at this head; the claim came from two sealed cards that were true when
   written and never revised. P5.9 nonetheless found and fixed a real defect (D35): the
   provenance exemption tested a filed record's EXISTENCE, not its VALUE, so a workbook could
   ship a blue figure claiming a filed source that says something else.
2. Integration of the in-flight wave (deployment profile closure, registry rows, censuses,
   ci/mutation_survivors.json).
3. Head green; skill_version flip to 3.7.7 (P8.9's centralised declaration).
4. P7.8 behavioural freeze and P8.8 immutable tag — RETAINED despite not being needed to USE
   the product. Without them Phase 9 has no reference to prove "I changed nothing" against, and
   v3.8 would be refactoring blind. They are cheap; the option they preserve is not.
5. Package compiles (--development, or --portable-certify for the stronger tier). `--certify`
   can NEVER pass here by design: native_excel and visual_review are permanently excluded, which
   is precisely why P8.0 built the portable tier.

## Standing exclusions unchanged
Rogo-dependent packages (P5.7, P8.3, P8.4, P8.5, the installed half of P8.6, Phase 10 rings)
remain excluded. External custody (private-test-custody, fixtures/external) must NEVER ship in
the repo. P5.6 (charts) stays deferred — the pack says "redesign charts", but charts do not
exist and drawings are actively forbidden.

## Carried into the tag, not fixed
The declared known limitations in KNOWN_LIMITATIONS.md, plus the pinned KNOWN RED custody
cohort (55/98/1/0/0). The v3.8 branch inherits them as declared baseline, not as surprises.
