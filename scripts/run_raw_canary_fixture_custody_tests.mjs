#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  RAW_CANARY_EVIDENCE_SHA256,
  assertRawCanaryEvidenceDigest,
  assertProtectedCashSubtotalCloses,
  bindRawCanaryEvidence,
  prepareSyntheticRawFilingRows,
} from "./lib/raw_canary_fixture.mjs";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = await fs.mkdtemp(path.join(os.tmpdir(), "raw-canary-fixture-custody-"));
const generated = path.join(out, "clean-evidence-run.json");

await exec(process.execPath, [
  path.join(here, "run_evidence_run_tests.mjs"),
  path.join(root, "test-fixtures", "cases"),
  "--emit-clean", generated,
], { cwd: root, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

const generatedBytes = await fs.readFile(generated);
const bound = bindRawCanaryEvidence(generatedBytes);
assert.equal(bound.sha256, RAW_CANARY_EVIDENCE_SHA256);
assert.throws(
  () => assertRawCanaryEvidenceDigest(
    generatedBytes,
    "c93815e9a26aa9b84e05c7b5362af30250f40488b242a2276626b66d293a3a1d",
  ),
  /stale or foreign/,
  "The previous source-owned digest still accepted newly generated fixture bytes.",
);

const rows = prepareSyntheticRawFilingRows(bound.evidence);
assertProtectedCashSubtotalCloses(rows.cash_flow, "cf.cash_generated_from_operations");
assert.deepEqual(
  rows.cash_flow.find((row) => row.source_line_id === "cf.net_finance_result")?.values,
  [0, 0, 0],
  "The out-of-family memo row must remain the source-owned neutral separator.",
);
assert.deepEqual(
  rows.cash_flow.find(
    (row) => row.source_line_id === "cf.cash_generated_from_operations",
  )?.values,
  [190, 190, 190],
);

const foreignBytes = Buffer.from(generatedBytes);
const marker = Buffer.from("Standard Net Cash Co");
const markerOffset = foreignBytes.indexOf(marker);
assert(markerOffset >= 0, "Could not locate the neutral fixture identity for mutation.");
foreignBytes[markerOffset + marker.length - 1] ^= 1;
assert.throws(
  () => bindRawCanaryEvidence(foreignBytes),
  /stale or foreign/,
  "A changed RAW_CANARY_EVIDENCE artifact passed its source-owned digest binding.",
);

const brokenRows = structuredClone(rows);
brokenRows.cash_flow.find(
  (row) => row.source_line_id === "cf.finance_costs_net_addback",
).values[0] -= 1;
assert.throws(
  () => assertProtectedCashSubtotalCloses(
    brokenRows.cash_flow,
    "cf.cash_generated_from_operations",
  ),
  /does not close in period 1/,
  "A protected cash child mutation passed the pre-ingress arithmetic assertion.",
);

console.log(JSON.stringify({
  status: "PASS",
  source_owned_clean_evidence_sha256: bound.sha256,
  positive_checks: 4,
  adversarial_mutations: 3,
  total_violations: 0,
}, null, 2));
