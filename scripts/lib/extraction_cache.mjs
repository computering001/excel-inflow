/**
 * Content-addressed extraction cache.
 *
 * Filing documents are already bound to their raw bytes by SHA-256 at
 * acquisition time, so an EXTRACTION result can be addressed by the pair
 * (document SHA-256, extractor version): identical bytes extracted by an
 * unchanged extractor must produce the same evidence, whatever run re-reads
 * them. The cache lives under the RUN WORKSPACE (never a global home), every
 * write is recorded in a manifest, and bumping EXTRACTOR_VERSION invalidates
 * every existing entry at once — lookups simply miss on version disagreement,
 * and old entries stay on disk for audit rather than being deleted.
 *
 * This module is pure storage: it never extracts anything itself.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalise } from "./run_store.mjs";

export const EXTRACTION_CACHE_ENTRY_SCHEMA = "extraction-cache-entry/1.0";
export const EXTRACTION_CACHE_MANIFEST_SCHEMA = "extraction-cache-manifest/1.0";

/**
 * Declared identity of the extraction behaviour whose results are cached.
 * ANY change to extraction output — code, prompts, normalisation — must bump
 * this string; that bump is the entire invalidation mechanism.
 */
export const EXTRACTOR_VERSION = "filings-extraction/1.0";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalise(value))}\n`, "utf8");
}

async function atomicWrite(target, bytes) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * The cache directory lives INSIDE one run's workspace: runs never share a
 * cache root, so custody boundaries stay per-run even though addressing is
 * content-based.
 */
export function extractionCacheRoot(runWorkspace) {
  if (typeof runWorkspace !== "string" || runWorkspace.trim() === "") {
    throw new Error("Extraction cache requires a run workspace path.");
  }
  return path.join(path.resolve(runWorkspace), ".extraction-cache");
}

/**
 * Cache key = H(cache domain, extractor version, document SHA-256). The
 * document digest alone is NOT enough: an extractor change must move every
 * key, which this domain-separated derivation guarantees.
 */
export function extractionCacheKey(documentSha256, extractorVersion = EXTRACTOR_VERSION) {
  const digest = String(documentSha256 ?? "");
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`Extraction cache requires a lowercase hex SHA-256 document digest, got ${JSON.stringify(documentSha256)}.`);
  }
  if (typeof extractorVersion !== "string" || extractorVersion === "") {
    throw new Error("Extraction cache requires a declared extractor version.");
  }
  return hashBytes(Buffer.from([
    "extraction-cache-key/1.0",
    extractorVersion,
    digest,
    "",
  ].join("\n"), "utf8"));
}

function entryPath(cacheRoot, key) {
  return path.join(path.resolve(cacheRoot), "entries", `${key}.json`);
}

export function extractionManifestPath(cacheRoot) {
  return path.join(path.resolve(cacheRoot), "manifest.json");
}

function entryBody({ documentSha256, extractorVersion, result }) {
  return {
    schema_version: EXTRACTION_CACHE_ENTRY_SCHEMA,
    document_sha256: documentSha256,
    extractor_version: extractorVersion,
    result,
  };
}

function entryHash(body) {
  const { entry_hash: _ignored, ...rest } = body;
  return hashBytes(canonicalBytes(rest));
}

async function readManifestIfPresent(cacheRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(extractionManifestPath(cacheRoot), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Store one extraction result. Content-addressed: storing the same
 * (document, version, result) twice is idempotent byte-for-byte.
 */
export async function recordExtraction({
  cacheRoot,
  documentSha256,
  extractorVersion = EXTRACTOR_VERSION,
  result,
}) {
  if (!cacheRoot) throw new Error("recordExtraction requires cacheRoot.");
  if (result === undefined) throw new Error("recordExtraction requires an extraction result.");
  const resolved = path.resolve(cacheRoot);
  const key = extractionCacheKey(documentSha256, extractorVersion);
  const body = entryBody({ documentSha256: String(documentSha256), extractorVersion, result });
  const sealed = { ...body, entry_hash: entryHash(body) };
  const sealedBytes = canonicalBytes(sealed);
  await atomicWrite(entryPath(resolved, key), sealedBytes);

  // Manifest records EVERY stored entry (all versions) keyed by document
  // digest, so an auditor can see what is cached and at which extractor
  // version without opening each entry file.
  const manifest = (await readManifestIfPresent(resolved)) ?? {
    schema_version: EXTRACTION_CACHE_MANIFEST_SCHEMA,
    extractor_version: extractorVersion,
    entries: {},
  };
  manifest.schema_version = EXTRACTION_CACHE_MANIFEST_SCHEMA;
  manifest.extractor_version = extractorVersion;
  manifest.entries = {
    ...(manifest.entries && typeof manifest.entries === "object" ? manifest.entries : {}),
    [String(documentSha256)]: {
      key,
      extractor_version: extractorVersion,
      result_sha256: hashBytes(canonicalBytes(result)),
    },
  };
  await atomicWrite(extractionManifestPath(resolved), canonicalBytes(manifest));
  return {
    key,
    extractorVersion,
    entry_path: entryPath(resolved, key),
    result_sha256: manifest.entries[String(documentSha256)].result_sha256,
  };
}

/**
 * Look up a cached extraction. A lookup misses — never throws — when the
 * entry is absent, was written by a DIFFERENT extractor version (the
 * invalidation rule), or fails its own integrity seal. The key already
 * embeds the version, so a bumped extractor lands on an empty address; the
 * manifest is consulted on that miss path to say WHY (version change vs
 * genuinely never extracted).
 */
export async function lookupExtraction({
  cacheRoot,
  documentSha256,
  extractorVersion = EXTRACTOR_VERSION,
}) {
  if (!cacheRoot) throw new Error("lookupExtraction requires cacheRoot.");
  let key;
  try {
    key = extractionCacheKey(documentSha256, extractorVersion);
  } catch (error) {
    return { hit: false, key: null, reason: String(error.message) };
  }
  const resolvedRoot = path.resolve(cacheRoot);
  const target = entryPath(resolvedRoot, key);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    const recorded = (await readManifestIfPresent(resolvedRoot))?.entries?.[String(documentSha256)];
    return {
      hit: false,
      key,
      entry_path: target,
      reason: recorded && recorded.extractor_version !== extractorVersion
        ? "extractor_version_changed"
        : "entry_absent",
    };
  }
  if (parsed?.schema_version !== EXTRACTION_CACHE_ENTRY_SCHEMA) {
    return { hit: false, key, entry_path: target, reason: "schema_version_changed" };
  }
  if (parsed.extractor_version !== extractorVersion) {
    return { hit: false, key, entry_path: target, reason: "extractor_version_changed" };
  }
  if (parsed.document_sha256 !== String(documentSha256)) {
    return { hit: false, key, entry_path: target, reason: "document_digest_changed" };
  }
  if (parsed.entry_hash !== entryHash(parsed)) {
    return { hit: false, key, entry_path: target, reason: "entry_seal_invalid" };
  }
  return {
    hit: true,
    key,
    entry_path: target,
    extractorVersion: parsed.extractor_version,
    result: parsed.result,
    result_sha256: hashBytes(canonicalBytes(parsed.result)),
  };
}

/**
 * The manifest view of everything currently recorded in one cache root.
 */
export async function readExtractionCacheManifest(cacheRoot) {
  return readManifestIfPresent(cacheRoot);
}

export default {
  EXTRACTION_CACHE_ENTRY_SCHEMA,
  EXTRACTION_CACHE_MANIFEST_SCHEMA,
  EXTRACTOR_VERSION,
  extractionCacheKey,
  extractionCacheRoot,
  extractionManifestPath,
  lookupExtraction,
  readExtractionCacheManifest,
  recordExtraction,
};
