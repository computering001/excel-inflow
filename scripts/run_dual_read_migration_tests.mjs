#!/usr/bin/env node
/**
 * P1.8 — Dual-read migration proof over the blocker corpus.
 *
 * Invariant: canonical typed contracts are proven against the blocker corpus
 * while legacy stored objects remain readable through explicit adapters, and
 * the legacy view of every projection is value-lossless with nulls preserved
 * (never zero-filled).
 */
import fs from "node:fs/promises";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
import { projectLegacyRowValue, legacyViewOf } from "./lib/typed_value_dual_read.mjs";
import { validate } from "./lib/generated/typed_financial_value_contract.mjs";

const run = createRunner({ name: "dual_read_migration_tests", importMetaUrl: import.meta.url });
const ROOT = run.ROOT;

const CORPUS_CASES = [
  "test-fixtures/cases/standard-maximal-v2.json",
  "test-fixtures/cases/standard-net-cash-v2.json",
];
// The external certification cases join when their custody symlink resolves;
// their absence is typed, never silent.
const EXTERNAL = "fixtures/external/Codex/2026-07-24/ok/work/v2-certification/cases/astrazeneca-v2.json";
const externalPresent = await fs.access(path.join(ROOT, EXTERNAL)).then(() => true, () => false);
const casePaths = externalPresent ? [...CORPUS_CASES, EXTERNAL] : CORPUS_CASES;

let projected = 0;
let valueBearing = 0;
const stateCounts = {};
for (const casePath of casePaths) {
  const modelCase = JSON.parse(await fs.readFile(path.join(ROOT, casePath), "utf8"));
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (row?.row_type === "header") continue;
      for (let periodIndex = 0; periodIndex < 6; periodIndex += 1) {
        const typed = projectLegacyRowValue(row, periodIndex);
        // 1. Every projection validates against the generated contract.
        const errors = validate(typed);
        run.ok(errors.length === 0,
          `${casePath} ${row.row_id}[${periodIndex}]: projection invalid: ${errors[0]}`);
        // 2. The legacy view is value-lossless and null-preserving.
        const raw = row.values?.[periodIndex];
        const view = legacyViewOf(typed);
        if (raw === null || raw === undefined) {
          run.ok(view === null,
            `${row.row_id}[${periodIndex}]: a legacy null must read back null, got ${view}`);
        } else if (Number.isFinite(Number(raw))) {
          run.ok(view === Number(raw),
            `${row.row_id}[${periodIndex}]: value ${raw} must survive the round trip, got ${view}`);
          valueBearing += 1;
        }
        // 3. NEVER-ZERO: absence states cannot read as zero.
        if ((raw === null || raw === undefined) && view === 0) {
          run.ok(false, `${row.row_id}[${periodIndex}]: an absent legacy value read as ZERO`);
        }
        stateCounts[typed.state] = (stateCounts[typed.state] ?? 0) + 1;
        projected += 1;
      }
    }
  }
}
run.ok(projected > 500, `corpus projection must cover a substantial surface (got ${projected})`);
run.ok(valueBearing > 100, `corpus must carry real values (got ${valueBearing})`);
run.ok((stateCounts.missing ?? 0) > 0, "the corpus exercises the missing state");
run.ok((stateCounts.reported_zero ?? 0) > 0 || (stateCounts.derived_number ?? 0) > 0,
  "the corpus exercises value-bearing states");

// 4. Adversarial: a corrupted projection (absence state smuggling a value)
// must be refused by the contract — the dual read cannot launder it.
{
  const smuggled = { contract_version: "1.0.0", state: "missing", value: 0 };
  run.ok(validate(smuggled).length > 0, "a smuggled zero on missing must be refused");
}

// 5. Vocabulary compatibility: extractor value_states map losslessly.
{
  const stitched = projectLegacyRowValue({
    values: [12.5, null, null, null, null, null],
    value_states: ["prior_filing_support"],
    periods: ["2023-03-31"],
    period_support_provenance: { "2023-03-31": {
      prior_document_sha256: "b".repeat(64), prior_source_line_id: "is.4", prior_period_index: 0,
    } },
  }, 0);
  run.ok(stitched.state === "prior_filing_support" && stitched.value === 12.5 &&
    stitched.provenance.prior_document_sha256 === "b".repeat(64),
    "prior-filing support projects with its provenance");
  const owed = projectLegacyRowValue({
    values: [null], value_states: ["period_support_required"], periods: ["2023-03-31"],
  }, 0);
  run.ok(owed.state === "period_support_required" && legacyViewOf(owed) === null,
    "an owed period projects typed and reads null, never zero");
}

run.finish({
  projected,
  value_bearing: valueBearing,
  external_corpus: externalPresent ? "included" : "CUSTODY_ABSENT",
  state_counts: stateCounts,
});
