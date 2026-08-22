#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createRunner } from "./lib/test_harness.mjs";

import {
  RAW_CANARY_EVIDENCE_SHA256,
  assertRawCanaryEvidenceDigest,
  assertProtectedCashSubtotalCloses,
  bindRawCanaryEvidence,
  prepareSyntheticRawFilingRows,
} from "./lib/raw_canary_fixture.mjs";

const run = createRunner({
  name: "raw_canary_fixture_custody_tests",
  importMetaUrl: import.meta.url,
});
const { exec } = run.runCli();
const out = await fs.mkdtemp(path.join(os.tmpdir(), "raw-canary-fixture-custody-"));
const generated = path.join(out, "clean-evidence-run.json");

await exec(process.execPath, [
  path.join(run.HERE, "run_evidence_run_tests.mjs"),
  path.join(run.ROOT, "test-fixtures", "cases"),
  "--emit-clean", generated,
], { cwd: run.ROOT, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

const generatedBytes = await fs.readFile(generated);
const bound = bindRawCanaryEvidence(generatedBytes);
run.eq(bound.sha256, RAW_CANARY_EVIDENCE_SHA256, "generated fixture binds to the source-owned digest");
run.throws(
  () => assertRawCanaryEvidenceDigest(
    generatedBytes,
    "40d38d82f087a41588fc4da55991cc1374d7c3e9e7fe8d563bcdf082cedfd2d2",
  ),
  /stale or foreign/,
  "The previous source-owned digest still accepted newly generated fixture bytes.",
);
run.check(
  "the clean raw canary does not relabel model-derived house consensus as provider consensus",
  () => Object.values(bound.evidence.broker_pack?.metrics ?? {}).every(
    (metric) => !Object.hasOwn(metric, "provider_consensus"),
  ),
);

const conflatedConsensus = structuredClone(bound.evidence);
conflatedConsensus.broker_pack.metrics.adjusted_ebitda.provider_consensus = [1, 2, 3];
run.throws(
  () => bindRawCanaryEvidence(
    Buffer.from(`${JSON.stringify(conflatedConsensus, null, 2)}\n`, "utf8"),
  ),
  /stale or foreign/,
  "A fixture that reintroduced synthetic provider consensus passed custody binding.",
);

const rows = prepareSyntheticRawFilingRows(bound.evidence);
run.check(
  "protected cash subtotal closes",
  () => {
    assertProtectedCashSubtotalCloses(rows.cash_flow, "cf.cash_generated_from_operations");
    return true;
  },
);
run.eq(
  rows.cash_flow.find((row) => row.source_line_id === "cf.net_finance_result")?.values,
  [0, 0, 0],
  "The out-of-family memo row must remain the source-owned neutral separator.",
);
run.eq(
  rows.cash_flow.find(
    (row) => row.source_line_id === "cf.cash_generated_from_operations",
  )?.values,
  [190, 190, 190],
  "protected cash subtotal values",
);

const foreignBytes = Buffer.from(generatedBytes);
const marker = Buffer.from("Standard Net Cash Co");
const markerOffset = foreignBytes.indexOf(marker);
run.check("could locate the neutral fixture identity for mutation", () => markerOffset >= 0);
foreignBytes[markerOffset + marker.length - 1] ^= 1;
run.throws(
  () => bindRawCanaryEvidence(foreignBytes),
  /stale or foreign/,
  "A changed RAW_CANARY_EVIDENCE artifact passed its source-owned digest binding.",
);

const brokenRows = structuredClone(rows);
brokenRows.cash_flow.find(
  (row) => row.source_line_id === "cf.finance_costs_net_addback",
).values[0] -= 1;
run.throws(
  () => assertProtectedCashSubtotalCloses(
    brokenRows.cash_flow,
    "cf.cash_generated_from_operations",
  ),
  /does not close in period 1/,
  "A protected cash child mutation passed the pre-ingress arithmetic assertion.",
);

run.finish({
  source_owned_clean_evidence_sha256: bound.sha256,
  positive_checks: 5,
  adversarial_mutations: 4,
  total_violations: 0,
});
