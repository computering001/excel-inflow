#!/usr/bin/env node
/**
 * Receipt envelope stability test — proves the helper landed in
 * scripts/lib/receipt_envelope.mjs holds its hash contract before any
 * compiler adopts it (plan P-G S5 foundation slice).
 *
 * Run: node scripts/test_receipt_envelope.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  RECEIPT_ENVELOPE_SCHEMA_VERSION,
  makeEnvelope,
  verifyEnvelope,
} from "./lib/receipt_envelope.mjs";
import { canonicalJson } from "./lib/run_store.mjs";

const FIXED_TIME = "2026-08-21T12:00:00.000Z";
const PAYLOAD = {
  status: "PASS",
  counts: { suites: 236, checks: 1042 },
  notes: ["zero-ref retirement", "envelope foundation"],
  nested: { deep: { deeper: { z: 1, a: 2 } } },
};

// 1. Shape: exact fields, pinned schema version, deterministic issued_at.
{
  const envelope = makeEnvelope("unit-test", PAYLOAD, { now: FIXED_TIME });
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ["issued_at", "payload", "payload_sha256", "schema_version", "type"],
    "envelope carries exactly the five contract fields",
  );
  assert.equal(envelope.schema_version, RECEIPT_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.schema_version, "receipt-envelope/1.0");
  assert.equal(envelope.type, "unit-test");
  assert.equal(envelope.issued_at, FIXED_TIME);
}

// 2. Digest correctness: payload_sha256 == sha256(canonicalJson(payload)),
//    recomputed here independently of the helper's own hashing path.
{
  const envelope = makeEnvelope("digest-check", PAYLOAD);
  const independent = createHash("sha256")
    .update(Buffer.from(canonicalJson(PAYLOAD), "utf8"))
    .digest("hex");
  assert.equal(envelope.payload_sha256, independent);
  assert.match(envelope.payload_sha256, /^[0-9a-f]{64}$/, "lowercase hex sha256");
}

// 3. Insertion-order invariance: same data, different key orders -> one digest.
{
  const a = makeEnvelope("order-check", { alpha: 1, beta: { x: 1, y: 2 } }, { now: FIXED_TIME });
  const b = makeEnvelope("order-check", { beta: { y: 2, x: 1 }, alpha: 1 }, { now: FIXED_TIME });
  assert.equal(a.payload_sha256, b.payload_sha256);
}

// 4. Round-trip: serialize the whole envelope, parse it back, verify.
{
  const original = makeEnvelope("round-trip", PAYLOAD, { now: FIXED_TIME });
  const revived = JSON.parse(JSON.stringify(original));
  assert.equal(revived.payload_sha256, original.payload_sha256, "digest survives serialization");
  assert.ok(verifyEnvelope(revived), "revived envelope verifies");
  // And against an independently rebuilt digest of the revived payload:
  assert.equal(
    createHash("sha256").update(Buffer.from(canonicalJson(revived.payload), "utf8")).digest("hex"),
    revived.payload_sha256,
  );
}

// 5. Tamper detection: any payload mutation breaks verification.
{
  const original = makeEnvelope("tamper", PAYLOAD, { now: FIXED_TIME });
  const tampered = JSON.parse(JSON.stringify(original));
  tampered.payload.status = "FAIL";
  tampered.payload.counts.suites = 999;
  assert.equal(verifyEnvelope(tampered), false, "mutated payload must not verify");
  const digestTampered = JSON.parse(JSON.stringify(original));
  digestTampered.payload_sha256 = "0".repeat(64);
  assert.equal(verifyEnvelope(digestTampered), false, "declared-digest tamper must not verify");
}

// 6. Untrusted shapes are rejected, not thrown: null, arrays, wrong version,
//    missing digest, circular payload.
assert.equal(verifyEnvelope(null), false);
assert.equal(verifyEnvelope([makeEnvelope("arr", {})]), false);
assert.equal(verifyEnvelope({ ...makeEnvelope("v", {}), schema_version: "receipt-envelope/9.9" }), false);
assert.equal(verifyEnvelope({ schema_version: RECEIPT_ENVELOPE_SCHEMA_VERSION, payload: {} }), false);
{
  const circular = {};
  circular.self = circular;
  assert.throws(() => makeEnvelope("circular", circular), TypeError,
    "cyclic payload must be refused with a clear error, not a stack overflow");
  const forged = {
    schema_version: RECEIPT_ENVELOPE_SCHEMA_VERSION,
    type: "forged",
    issued_at: FIXED_TIME,
    payload_sha256: "0".repeat(64),
    payload: circular,
  };
  assert.equal(verifyEnvelope(forged), false,
    "unhashable payload makes the envelope unverifiable");
}

// 7. Input validation errors.
assert.throws(() => makeEnvelope("", {}), TypeError);
assert.throws(() => makeEnvelope(42, {}), TypeError);
assert.throws(() => makeEnvelope("no-payload"), TypeError);

console.log("PASS receipt-envelope: shape, digest, order-invariance, round-trip, tamper, rejection");
