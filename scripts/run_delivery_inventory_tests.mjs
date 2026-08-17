#!/usr/bin/env node
import assert from "node:assert/strict";

import { publicationInventoryClosure } from "./lib/live_delivery_attestation.mjs";

const entry = (path) => ({ path, sha256: "0".repeat(64), bytes: 1 });
const base = [
  "Operating Model.png",
  "model-page-1.png",
  "sheet-Operating Model-page-1.png",
  "nested/01-summary.json",
  "nested/A-detail.json",
];

const checks = [];
function check(name, action) {
  action();
  checks.push(name);
}

check("permuted manifest order is non-authoritative", () => {
  const receipt = publicationInventoryClosure(base, [...base].reverse().map(entry));
  assert.equal(receipt.ok, true);
});

check("host locale order is non-authoritative", () => {
  const hostOrdered = [...base].sort((a, b) => a.localeCompare(b, "tr"));
  const checkpointOrdered = [...base].sort();
  assert.equal(publicationInventoryClosure(hostOrdered, checkpointOrdered.map(entry)).ok, true);
});

check("missing file blocks", () => {
  assert.equal(publicationInventoryClosure(base.slice(1), base.map(entry)).ok, false);
});

check("extra file blocks", () => {
  assert.equal(publicationInventoryClosure([...base, "unexpected.json"], base.map(entry)).ok, false);
});

check("duplicate manifest path blocks", () => {
  const receipt = publicationInventoryClosure(base, [...base, base[0]].map(entry));
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.duplicate_manifest_paths, [base[0]]);
});

check("duplicate actual path blocks", () => {
  const receipt = publicationInventoryClosure([...base, base[0]], base.map(entry));
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.duplicate_actual_paths, [base[0]]);
});

for (const invalid of ["../escape.json", "./relative.json", "/absolute.json", "nested\\windows.json", "nested//double.json", ""]) {
  check(`invalid portable manifest path blocks: ${JSON.stringify(invalid)}`, () => {
    const receipt = publicationInventoryClosure(base, [...base.slice(1).map(entry), entry(invalid)]);
    assert.equal(receipt.ok, false);
    assert.ok(receipt.invalid_manifest_paths.includes(invalid));
  });
}

check("unicode spellings remain exact rather than being conflated", () => {
  const composed = "caf\u00e9.json";
  const decomposed = "cafe\u0301.json";
  assert.equal(publicationInventoryClosure([composed], [entry(decomposed)]).ok, false);
});

console.log(JSON.stringify({
  status: "PASS",
  checks: checks.length,
  mutations: 11,
  violations: 0,
}, null, 2));
