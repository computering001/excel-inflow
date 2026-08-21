#!/usr/bin/env node
/**
 * Content-addressed extraction cache — storage contract and invalidation.
 *
 * Proves, over a real temp workspace:
 *   1. keys derive from (document SHA-256, extractor version) and nothing else;
 *   2. store -> lookup round-trips byte-identically and is idempotent;
 *   3. EVERY write lands in the cache manifest;
 *   4. INVALIDATION IS THE VERSION BUMP: bumping EXTRACTOR_VERSION makes every
 *      existing entry miss while its bytes stay on disk for audit;
 *   5. a tampered entry fails its integrity seal and misses;
 *   6. the optional probe wiring in acquireFilingsSources reports misses first
 *      and hits after a record, and stays absent entirely without the option.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTRACTION_CACHE_ENTRY_SCHEMA,
  EXTRACTION_CACHE_MANIFEST_SCHEMA,
  EXTRACTOR_VERSION,
  extractionCacheKey,
  extractionCacheRoot,
  lookupExtraction,
  readExtractionCacheManifest,
  recordExtraction,
} from "./lib/extraction_cache.mjs";
import { acquireFilingsSources } from "./lib/filings_acquisition.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const DOC_A = sha256(Buffer.from("annual-report-2025"));
const DOC_B = sha256(Buffer.from("annual-report-2026"));

// ---------------------------------------------------------------------------
// 1. Key derivation: domain-separated by extractor version and document bytes
// ---------------------------------------------------------------------------
const keyA1 = extractionCacheKey(DOC_A);
check(/^[a-f0-9]{64}$/.test(keyA1), "cache key is a lowercase hex SHA-256");
check(keyA1 === extractionCacheKey(DOC_A, EXTRACTOR_VERSION), "key is stable for the same (document, version)");
check(keyA1 !== extractionCacheKey(DOC_A, "filings-extraction/2.0"), "bumping the extractor version moves the key");
check(keyA1 !== extractionCacheKey(DOC_B), "different document bytes move the key");
assert.throws(() => extractionCacheKey("not-a-digest"), /SHA-256/);
checks += 1;
assert.throws(() => extractionCacheKey(DOC_A, ""), /extractor version/);
checks += 1;

// ---------------------------------------------------------------------------
// 2. The cache directory lives inside the run workspace
// ---------------------------------------------------------------------------
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "extraction-cache-"));
const cacheRoot = extractionCacheRoot(workspace);
check(cacheRoot.startsWith(path.resolve(workspace)) && cacheRoot.endsWith(".extraction-cache"),
  "the cache root is <run-workspace>/.extraction-cache");

// ---------------------------------------------------------------------------
// 3. Store -> lookup round-trip, idempotence, manifest recording
// ---------------------------------------------------------------------------
const result = { disposition: "selected_face_statement_authority", lines: [{ id: "L1", value: 42 }] };
const stored = await recordExtraction({ cacheRoot, documentSha256: DOC_A, result });
check(stored.key === keyA1, "recordExtraction stores under the derived key");
const entryOnDisk = JSON.parse(await fs.readFile(path.join(cacheRoot, "entries", `${keyA1}.json`), "utf8"));
check(entryOnDisk.schema_version === EXTRACTION_CACHE_ENTRY_SCHEMA, "the entry file declares the entry schema");
const hit = await lookupExtraction({ cacheRoot, documentSha256: DOC_A });
check(hit.hit === true, "a stored extraction is found again");
check(hit.result_sha256 === sha256(Buffer.from(`${JSON.stringify(result)}\n`)), "the hit carries the canonical result digest");
assert.deepEqual(hit.result, result);
checks += 1;

// Manifest records every write.
const manifest = await readExtractionCacheManifest(cacheRoot);
check(manifest?.schema_version === EXTRACTION_CACHE_MANIFEST_SCHEMA, "the cache manifest declares its schema");
check(manifest.entries[DOC_A]?.key === keyA1, "the manifest records the entry under the document digest");
check(manifest.entries[DOC_A]?.extractor_version === EXTRACTOR_VERSION, "the manifest records which extractor version produced the entry");

// Content-addressed rewrite is byte-idempotent.
await recordExtraction({ cacheRoot, documentSha256: DOC_A, result });
const reread = await lookupExtraction({ cacheRoot, documentSha256: DOC_A });
check(reread.hit && reread.result_sha256 === hit.result_sha256, "re-storing identical content changes nothing observable");

// ---------------------------------------------------------------------------
// 4. Invalidation IS the version bump
// ---------------------------------------------------------------------------
const nextVersion = "filings-extraction/2.0";
const staleLookup = await lookupExtraction({ cacheRoot, documentSha256: DOC_A, extractorVersion: nextVersion });
check(staleLookup.hit === false, "a bumped extractor version misses");
check(staleLookup.reason === "extractor_version_changed", `the miss names the version change (got ${staleLookup.reason})`);
check(await fs.stat(path.join(cacheRoot, "entries", `${keyA1}.json`)).then(() => true).catch(() => false),
  "invalidated entries stay on disk for audit instead of being deleted");
const fresh = await recordExtraction({ cacheRoot, documentSha256: DOC_A, extractorVersion: nextVersion, result });
check(fresh.key !== keyA1, "the bumped version stores under a new content address");
const refetched = await lookupExtraction({ cacheRoot, documentSha256: DOC_A, extractorVersion: nextVersion });
check(refetched.hit === true, "the new version finds its own entry");
check((await fs.readFile(path.join(cacheRoot, "entries", `${fresh.key}.json`))).includes(nextVersion),
  "each version's entry records its own extractor version");
const manifestAfterBump = await readExtractionCacheManifest(cacheRoot);
check(manifestAfterBump.entries[DOC_A]?.extractor_version === nextVersion,
  "the manifest tracks the latest version recorded for a document");

// ---------------------------------------------------------------------------
// 5. Integrity: a tampered entry must not be served
// ---------------------------------------------------------------------------
const victimPath = path.join(cacheRoot, "entries", `${keyA1}.json`);
const pristine = await fs.readFile(victimPath);
const forged = JSON.parse(pristine.toString("utf8").replace("selected_face_statement_authority", "forged_disposition"));
forged.entry_hash = sha256(Buffer.from("{}\n"));
await fs.writeFile(victimPath, `${JSON.stringify(forged)}\n`, "utf8");
const tampered = await lookupExtraction({ cacheRoot, documentSha256: DOC_A });
check(tampered.hit === false && tampered.reason === "entry_seal_invalid",
  `a tampered entry misses its integrity seal (got ${tampered.reason})`);
await fs.writeFile(victimPath, pristine);

// Different document bytes are a different address and simply absent.
const otherMiss = await lookupExtraction({ cacheRoot, documentSha256: DOC_B });
check(otherMiss.hit === false && otherMiss.reason === "entry_absent", "unknown document bytes miss as absent");

// ---------------------------------------------------------------------------
// 6. Wiring through acquireFilingsSources (opt-in probe)
// ---------------------------------------------------------------------------
const filingBytes = Buffer.from("%PDF-1.4 cached-filing-fixture\n");
const requestDir = path.join(workspace, "request-dir");
await fs.mkdir(requestDir, { recursive: true });
await fs.writeFile(path.join(requestDir, "filing.pdf"), filingBytes);
const acquisitionRequest = {
  schema_version: "filings-acquisition-request/1.0",
  run_id: "extraction-cache-test",
  company: { name: "Cache Test Co" },
  filing_facts: {
    reporting_currency: "USD",
    units: "millions",
    fiscal_calendar_kind: "fixed_date",
    historical_periods: ["2023-12-31", "2024-12-31", "2025-12-31"],
    forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
    reported_gross_debt: 10,
    reported_cash: 5,
  },
  sources: [{
    document_id: "doc",
    attachment_id: "att",
    source_id: "src",
    origin: "user_supplied",
    path: "filing.pdf",
    media_type: "application/pdf",
    filing_kind: "annual_report",
    filing_date: "2025-12-31",
    period_end: "2025-12-31",
    covered_periods: ["2025-12-31"],
    section_coverage: ["income_statement"],
    restatement_basis: "as_reported",
  }],
};
const requestPath = path.join(requestDir, "request.json");
await fs.writeFile(requestPath, JSON.stringify(acquisitionRequest), "utf8");
const extractionRequestSchema = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "filings-extraction-request-v1.schema.json"), "utf8"),
);
const sourceRegistrySchema = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "filings-source-registry-v1.schema.json"), "utf8"),
);
const acquire = (outName, extra = {}) => acquireFilingsSources({
  request: structuredClone(acquisitionRequest),
  requestPath,
  outDir: path.join(workspace, outName),
  extractionRequestSchema,
  sourceRegistrySchema,
  ...extra,
});

// Default path untouched: no option, no annotation.
const plain = await acquire("plain");
check(plain.extraction_cache === undefined, "without the option the acquisition result carries no cache annotation");

// Opt-in: everything misses before anything is cached.
const wiredRoot = extractionCacheRoot(path.join(workspace, "wired-run"));
const firstPass = await acquire("wired-first", { extractionCacheRoot: wiredRoot });
check(firstPass.extraction_cache?.extractor_version === EXTRACTOR_VERSION,
  "the opt-in probe names the declared extractor version");
check(firstPass.extraction_cache.documents.length === 1, "one probed document");
check(firstPass.extraction_cache.documents[0].hit === false && firstPass.extraction_cache.documents[0].reason === "entry_absent",
  "an uncached document reports a miss, not silence");

// Record exactly what the extractor would produce for these bytes, then re-acquire.
const rawDigest = firstPass.extraction_cache.documents[0].raw_sha256;
check(rawDigest === sha256(filingBytes), "the probe keys on the acquired bytes' SHA-256");
const extracted = await recordExtraction({
  cacheRoot: wiredRoot,
  documentSha256: rawDigest,
  result: { disposition: "reviewed_supplemental", manifests: [] },
});
check(extracted.key === extractionCacheKey(rawDigest), "the recorded entry addresses the acquired bytes");
const secondPass = await acquire("wired-second", { extractionCacheRoot: wiredRoot });
const wiredHit = secondPass.extraction_cache.documents[0];
check(wiredHit.hit === true, "re-acquiring unchanged bytes reports a cache hit");
check(wiredHit.result_sha256 === sha256(Buffer.from(`${JSON.stringify({ disposition: "reviewed_supplemental", manifests: [] })}\n`)),
  "the hit carries the cached result's digest");
check(wiredHit.raw_sha256 === rawDigest, "the hit is still bound to the same raw bytes");

console.log(JSON.stringify({
  status: "PASS",
  checks,
  extractor_version: EXTRACTOR_VERSION,
}, null, 2));
