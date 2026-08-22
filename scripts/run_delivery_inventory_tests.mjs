#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRunner } from "./lib/test_harness.mjs";
import { publicationInventoryClosure } from "./lib/live_delivery_attestation.mjs";

const run = createRunner({ name: "delivery_inventory_tests", importMetaUrl: import.meta.url });

const entry = (path) => ({ path, sha256: "0".repeat(64), bytes: 1 });
const base = [
  "Operating Model.png",
  "model-page-1.png",
  "sheet-Operating Model-page-1.png",
  "nested/01-summary.json",
  "nested/A-detail.json",
];

// One counted check per named behaviour; plain asserts inside each body keep
// the count faithful to the pre-harness runner, and each body returns true so
// the harness records success on a clean assert pass.
run.check("permuted manifest order is non-authoritative", () => {
  const receipt = publicationInventoryClosure(base, [...base].reverse().map(entry));
  assert.equal(receipt.ok, true);
  return true;
});

run.check("host locale order is non-authoritative", () => {
  const hostOrdered = [...base].sort((a, b) => a.localeCompare(b, "tr"));
  const checkpointOrdered = [...base].sort();
  assert.equal(publicationInventoryClosure(hostOrdered, checkpointOrdered.map(entry)).ok, true);
  return true;
});

run.check("missing file blocks", () => {
  assert.equal(publicationInventoryClosure(base.slice(1), base.map(entry)).ok, false);
  return true;
});

run.check("extra file blocks", () => {
  assert.equal(publicationInventoryClosure([...base, "unexpected.json"], base.map(entry)).ok, false);
  return true;
});

run.check("duplicate manifest path blocks", () => {
  const receipt = publicationInventoryClosure(base, [...base, base[0]].map(entry));
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.duplicate_manifest_paths, [base[0]]);
  return true;
});

run.check("duplicate actual path blocks", () => {
  const receipt = publicationInventoryClosure([...base, base[0]], base.map(entry));
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.duplicate_actual_paths, [base[0]]);
  return true;
});

for (const invalid of ["../escape.json", "./relative.json", "/absolute.json", "nested\\windows.json", "nested//double.json", ""]) {
  run.check(`invalid portable manifest path blocks: ${JSON.stringify(invalid)}`, () => {
    const receipt = publicationInventoryClosure(base, [...base.slice(1).map(entry), entry(invalid)]);
    assert.equal(receipt.ok, false);
    assert.ok(receipt.invalid_manifest_paths.includes(invalid));
    return true;
  });
}

run.check("unicode spellings remain exact rather than being conflated", () => {
  const composed = "caf\u00e9.json";
  const decomposed = "cafe\u0301.json";
  assert.equal(publicationInventoryClosure([composed], [entry(decomposed)]).ok, false);
  return true;
});

run.finish({
  mutations: 11,
  violations: 0,
});
