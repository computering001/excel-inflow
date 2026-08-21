#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..");
}

async function verifyManifest(root, manifest) {
  if (manifest?.schema_version !== "sha256-manifest/1.0" || !Array.isArray(manifest.files) ||
      manifest.file_count !== manifest.files.length || manifest.files.length < 1) {
    throw new Error("v3.7.8 preservation manifest is malformed.");
  }
  const seen = new Set();
  for (const [index, row] of manifest.files.entries()) {
    if (!safeRelative(row?.path) || seen.has(row.path) || !Number.isInteger(row.bytes) || row.bytes < 0 ||
        !SHA256.test(String(row.sha256))) {
      throw new Error(`v3.7.8 preservation row ${index} is invalid or duplicated.`);
    }
    seen.add(row.path);
    const target = path.resolve(root, row.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`v3.7.8 path escapes baseline: ${row.path}.`);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`v3.7.8 member is not one regular file: ${row.path}.`);
    const bytes = await fs.readFile(target);
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) {
      throw new Error(`v3.7.8 bytes changed: ${row.path}.`);
    }
  }
  return { file_count: manifest.files.length };
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--baseline-root") {
  throw new Error("Usage: verify_v378_preservation.mjs --baseline-root <phase0-v378-baseline>.");
}
const root = path.resolve(args[1]);
const manifestPath = path.join(root, "sha256-manifest.json");
const receiptPath = path.join(root, "phase0-baseline-receipt.json");
const [manifestBytes, receiptBytes] = await Promise.all([fs.readFile(manifestPath), fs.readFile(receiptPath)]);
const manifest = JSON.parse(manifestBytes);
const receipt = JSON.parse(receiptBytes);
const result = await verifyManifest(root, manifest);
if (receipt?.schema_version !== "excel-inflow-phase0-baseline/1.0" || receipt?.status !== "PASS" ||
    receipt?.source_identity?.source_commit !== "e8eb91f958e1f7c12007a27ffd01be159799772f" ||
    receipt?.targeted_installed_filings_capability?.package_archive_sha256 !== "789fd971660545cf531619bd1e9a105ff3530cd936714fd757bcdf5abf85340f" ||
    receipt?.targeted_installed_filings_capability?.complete_package_inventory_sha256 !== "33e1b105ad90131e90e14dd11ab90ede722888b92fe878465801a6dc8d1bf837") {
  throw new Error("v3.7.8 preserved source/package identity no longer matches its frozen Phase-0 receipt.");
}

const mutated = structuredClone(manifest);
mutated.files[0].sha256 = "0".repeat(64);
await assert.rejects(verifyManifest(root, mutated), /bytes changed/);

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  preserved_version: "3.7.8",
  source_commit: receipt.source_identity.source_commit,
  source_tree: receipt.source_identity.source_tree,
  archive_sha256: receipt.targeted_installed_filings_capability.package_archive_sha256,
  inventory_sha256: receipt.targeted_installed_filings_capability.complete_package_inventory_sha256,
  manifest_sha256: sha256(manifestBytes),
  receipt_sha256: sha256(receiptBytes),
  files_verified: result.file_count,
  mutations_caught: 1,
})}\n`);
