#!/usr/bin/env node
/**
 * Receipt envelope foundation — plan P-G S5 (conservative slice).
 *
 * Every receipt in this repo carries its own integrity proof, but each
 * generator expresses that proof slightly differently. This module is the
 * shared ENVELOPE those receipts can converge on: a thin, versioned wrapper
 * that pins who issued it (`type`), when (`issued_at`), and exactly which
 * payload bytes it covers (`payload_sha256`).
 *
 * Deliberately NOT wired into any existing compiler yet — this lands the
 * helper and its stability test first so future receipt consolidation has a
 * proven foundation to adopt (see commit "feat(receipts): envelope helper").
 *
 * Hash contract: `payload_sha256` is sha256 over the payload's CANONICAL JSON
 * (object keys sorted at every depth), reused from run_store.mjs so the
 * envelope cannot drift from the house hash definition. Two structurally
 * equal payloads therefore produce identical digests regardless of key
 * insertion order — insertion order is not data.
 */

import { hashValue } from "./run_store.mjs";

/** Envelope format version. Bump only for a breaking shape change. */
export const RECEIPT_ENVELOPE_SCHEMA_VERSION = "receipt-envelope/1.0";

/**
 * Wrap `payload` in an integrity envelope.
 *
 * @param {string} type - Receipt type tag, e.g. "release-certification".
 *     Required non-empty string; names the kind of receipt, not its content.
 * @param {unknown} payload - The JSON-serializable receipt body. Must be
 *     defined; hashed canonically (see module doc).
 * @param {{now?: string}} [options] - Test seam: override `issued_at`.
 *     Defaults to wall-clock ISO-8601 UTC at call time.
 * @returns {{schema_version: string, type: string, issued_at: string,
 *     payload_sha256: string, payload: unknown}}
 */
export function makeEnvelope(type, payload, options = {}) {
  if (typeof type !== "string" || type.length === 0) {
    throw new TypeError(
      `makeEnvelope: type must be a non-empty string, received ${JSON.stringify(type)}`,
    );
  }
  if (payload === undefined) {
    throw new TypeError(
      "makeEnvelope: payload must be defined (use null for an empty body); " +
        "an undefined payload has no canonical form to hash",
    );
  }
  const issued_at = options.now ?? new Date().toISOString();

  let payload_sha256;
  try {
    payload_sha256 = hashValue(payload);
  } catch (error) {
    throw new TypeError(
      "makeEnvelope: payload must be JSON-serializable without cycles " +
        `(canonicalisation failed: ${error.message})`,
    );
  }

  return {
    schema_version: RECEIPT_ENVELOPE_SCHEMA_VERSION,
    type,
    issued_at,
    payload_sha256,
    payload,
  };
}

/**
 * Verify an envelope's integrity proof round-trips.
 *
 * Recomputes the digest from the carried payload and compares. Accepts a
 * plain object (e.g. freshly parsed from disk) as long as it declares the
 * expected schema_version — a foreign shape is a verification FAILURE, not a
 * crash, so callers can treat false as "untrusted receipt".
 *
 * @param {unknown} envelope - Candidate envelope (any object or null).
 * @returns {boolean} true iff schema_version matches AND the recomputed
 *     payload digest equals the declared one.
 */
export function verifyEnvelope(envelope) {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    envelope.schema_version !== RECEIPT_ENVELOPE_SCHEMA_VERSION ||
    typeof envelope.payload_sha256 !== "string"
  ) {
    return false;
  }
  try {
    return hashValue(envelope.payload) === envelope.payload_sha256;
  } catch {
    // Unhashable payload (e.g. circular structure): treat as untrusted.
    return false;
  }
}
