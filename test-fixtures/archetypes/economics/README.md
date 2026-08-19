# Economics archetype cases (P7.1b)

Every case in this directory is **synthetic**: it was authored for work package P7.1b of the
v3.7.7 programme from the "P7.1b synthetic archetype specification v1 — NOT A REAL COMPANY"
named in each file's `source_coverage.review_evidence` and `provenance`, and there is no issuer,
filing, broker note or third-party research behind any figure — the specification IS the source,
which is why each `issuer.name` carries the NOT A REAL COMPANY label and every case declares
`execution_profile: "reference_parity"`. Each file is a minimal, schema-valid v2 model case that
isolates exactly ONE accounting, period, tax or schedule shape that a naive implementation gets
wrong; the shape, the failure it provokes and the typed expectations asserted against the compiled
artifacts are recorded per case in `assets/archetype-catalogue-economics-v1.json` and enforced by
`scripts/run_archetype_economics_tests.mjs`. These cases prove ECONOMICS only: every catalogue
entry carries `extraction_evidence_still_required: true`, because a real filing is still needed to
prove the product can READ the shape. They deliberately live here and never in
`test-fixtures/cases/`, which other suites glob and whose derived synthetic donor is hash-pinned in
`scripts/lib/raw_canary_fixture.mjs`.
