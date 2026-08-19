# Presentation / structure archetype probe cases (P7.1c)

## Synthetic provenance — read this first

**Every file in this directory is synthetic. None of them describes a real company.**

Each fixture carries an explicit `synthetic_provenance` string, and the suite
refuses to run a fixture whose provenance declaration is missing or does not
say `NOT A REAL COMPANY`. There is no issuer, no filing, no broker note and no
third-party research behind any figure here. Labels are drawn from ordinary
IFRS/US-GAAP face-statement wording because the shapes under test are wording
and layout shapes; the numbers are chosen only to make one presentation
question decidable (a total that foots by exactly one unit too little, a blank
beside a genuine zero, a sum that crosses a currency boundary). Nothing in this
directory may be quoted as evidence about any issuer, and nothing here is
extraction evidence: see *What these cases do NOT prove* below.

## What lives here

`test-fixtures/archetypes/presentation/*.json` — one **archetype probe case**
per statement-structure, classification, currency, unit or provenance
presentation shape, catalogued in
`assets/archetype-catalogue-presentation-v1.json` and asserted by
`scripts/run_archetype_presentation_tests.mjs`.

These files are deliberately **NOT** in `test-fixtures/cases/`. That directory
is globbed by several suites and the donor derived from it is hash-pinned in
`scripts/lib/raw_canary_fixture.mjs`; adding a case there would silently change
a pinned digest. Nothing in this directory is globbed by any other suite: the
runner reads only the `case_path` values its catalogue declares.

## Fixture shape (`excel-inflow-archetype-presentation-case/1.0`)

```
{
  "schema_version": "excel-inflow-archetype-presentation-case/1.0",
  "archetype_id":   "<matches the catalogue entry>",
  "catalogue_group": "presentation",
  "accounting_shape": "<the one shape this file isolates>",
  "synthetic_provenance": "... NOT A REAL COMPANY ...",
  "issuer": { ... }, "periods": [ ... ],
  "probes": [
    { "probe_id": "...", "probe_kind": "...", "note": "...",
      ...probe payload...,
      "asserts": { "<expectation_id>": <expected fact matcher> } }
  ]
}
```

A probe is a **minimal real input to shipped product code**. The `asserts` map
binds one catalogue `expectation_id` to the fact the product must produce, so
the catalogue's prose and the executable assertion cannot drift: the runner
fails if the catalogue declares an expectation no probe binds, or if a probe
asserts an expectation the catalogue never declared.

| `probe_kind` | product surface it drives | facts it yields |
| --- | --- | --- |
| `support_envelope` | `lib/support_envelope.mjs` `classifySupport` | `support_class`, `stopped`, `early_stop_reason_code`, `registry_reason_code`, `degraded_dimensions`, `legal_terminals` |
| `classification` | `lib/statement_classifier.mjs` `classifyStatementLine` | `status`, `classified_role`, `confidence`, `margin`, `tied_top_roles`, `top_candidates` |
| `statement_topology` | `lib/statement_topology.mjs` materialise + `compileStatementTopology` | `error_codes`, `conclusion_owner`, `presentation_parent_by_row`, `presentation_depth_by_row`, declared vs derived indents |
| `typed_value` | `lib/typed_financial_value.mjs` `typedValue` / `numericValueOf` | `construction` (accepted/refused), `state`, `numeric_reading`, `reads_as_zero`, `is_value_bearing`, `raw_text` |
| `arithmetic` | `lib/typed_arithmetic.mjs` `add`/`subtract`/`multiply`/`negate` | `result_state`, `value`, `refusal`, `unresolved_because`, `partial_recorded` |
| `source_footing` | `lib/case_compiler.mjs` `sourceHistoricalSumMatches` | `matches` |
| `statement_family` | `lib/model_ir_v3.mjs` `compileModelIrV3` P2.5 footing pass | `proof_status`, `family_codes`, unfooted/unfootable periods, filed vs member sums |
| `case_shape` | `lib/solver.mjs` `validateCaseShape` | `errors`, `period_errors`, `currency_errors`, `unit_errors` |
| `fiscal_periods` | `lib/validation_invariants.mjs` `validateFiscalPeriods` | `error_ids` |

Expected facts are **subset matchers**. Plain values compare deeply; the
directive keys `__contains`, `__excludes`, `__length`, `__not` and `__includes`
express set and substring relations. A matcher object mixes directives with
plain keys nowhere — the runner rejects that.

## What these cases do NOT prove

A synthetic probe can prove that the product **reasons** correctly about a
shape. It cannot prove the product can **read** that shape off a real page.
Every catalogue entry whose shape depends on reading a real filing carries
`extraction_evidence_still_required: true`; those entries stay open until a real
filing of that shape passes the raw black-box lane. Layout, scan, printed-unit
and per-share archetypes are all in that set.

Several entries also carry `envelope_extension_candidate: true`: the shape is
real, but `assets/support-envelope-v377.json` declares no dimension value for
it, so the case proves behaviour that the support envelope makes no claim
about. That is recorded as a claim-set gap, not silently dropped.

## Running

```
node scripts/run_archetype_presentation_tests.mjs
```

The suite validates the catalogue against the shared schema
(`assets/archetype-case-catalogue-v1.schema.json`), enforces the coverage gate
in both directions, asserts every declared expectation, and finishes with three
self-mutations proving the gate and the matcher both bite.
