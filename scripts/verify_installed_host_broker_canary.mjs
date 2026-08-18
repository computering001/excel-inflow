#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import { resolveActiveSourceIdentity } from "./lib/source_identity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(
  path.join(here, "..", "assets", "installed-host-broker-canary-v2.schema.json"),
  "utf8",
));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function containedRegularArtifact(receiptDirectory, relativePath, label) {
  assert.equal(path.isAbsolute(relativePath), false, `${label} path must be relative to the receipt.`);
  const resolved = path.resolve(receiptDirectory, relativePath);
  const relative = path.relative(receiptDirectory, resolved);
  assert(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${label} path leaves the receipt evidence directory.`);
  const linkStat = fs.lstatSync(resolved);
  assert.equal(linkStat.isSymbolicLink(), false, `${label} must not be a symbolic link.`);
  assert.equal(linkStat.isFile(), true, `${label} must be a regular file.`);
  const canonical = fs.realpathSync(resolved);
  const canonicalRelative = path.relative(fs.realpathSync(receiptDirectory), canonical);
  assert(canonicalRelative !== ".." && !canonicalRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(canonicalRelative), `${label} canonical path leaves the receipt evidence directory.`);
  return fs.readFileSync(canonical);
}

const joinedCellKey = (row) => `${row.metric_id}\0${row.source_cell}`;

export async function verifyInstalledHostBrokerReceipt(receiptPath, { activeSourceIdentity = null } = {}) {
  const resolvedReceipt = path.resolve(receiptPath);
  const receiptStat = fs.lstatSync(resolvedReceipt);
  assert.equal(receiptStat.isSymbolicLink(), false, "Receipt must not be a symbolic link.");
  assert.equal(receiptStat.isFile(), true, "Receipt must be a regular file.");
  const receipt = JSON.parse(fs.readFileSync(resolvedReceipt, "utf8"));
  const schemaErrors = validateJsonSchema(receipt, schema);
  assert.deepEqual(schemaErrors, [], `Installed-host receipt schema failure:\n${schemaErrors.join("\n")}`);

  const receiptDirectory = path.dirname(resolvedReceipt);
  const rawPdf = containedRegularArtifact(receiptDirectory, receipt.artifacts.raw_pdf, "Raw PDF");
  const hostResponse = containedRegularArtifact(receiptDirectory, receipt.artifacts.host_response, "Host response");
  const workbook = containedRegularArtifact(receiptDirectory, receipt.artifacts.workbook, "Workbook");
  assert.equal(rawPdf.subarray(0, 5).toString("ascii"), "%PDF-", "Raw PDF has invalid magic bytes.");
  assert.doesNotThrow(() => JSON.parse(hostResponse.toString("utf8")), "Host response is not valid JSON.");
  assert.equal(workbook.subarray(0, 4).toString("hex"), "504b0304", "Workbook has invalid ZIP magic bytes.");
  assert.equal(sha256(rawPdf), receipt.raw_pdf_sha256, "Raw PDF hash mismatch.");
  assert.equal(sha256(hostResponse), receipt.host_response_sha256, "Host response hash mismatch.");
  assert.equal(sha256(workbook), receipt.workbook_sha256, "Workbook hash mismatch.");
  assert.equal(receipt.source_identity.raw_pdf_sha256, receipt.raw_pdf_sha256, "Source identity is not bound to the raw PDF hash.");
  const active = activeSourceIdentity ?? await resolveActiveSourceIdentity({
    skillRoot: path.join(here, ".."),
  });
  for (const field of [
    "source_commit",
    "source_tree",
    "runtime_code_closure_sha256",
    "package_mode",
    "deployment_status",
    "installation_identity",
  ]) {
    assert.equal(receipt.source_identity[field], active[field], `Receipt source identity does not match active ${field}.`);
  }

  const selected = new Map();
  for (const row of receipt.selected_cells) {
    assert.equal(row.host_response_sha256, receipt.host_response_sha256, `${row.metric_id} is not bound to the host response.`);
    const key = joinedCellKey(row);
    assert.equal(selected.has(key), false, `Duplicate selected cell ${row.metric_id}/${row.source_cell}.`);
    selected.set(key, row.value_sha256);
  }
  const consumed = new Set();
  for (const row of receipt.workbook_consumption) {
    assert.equal(row.workbook_sha256, receipt.workbook_sha256, `${row.metric_id} is not bound to the workbook.`);
    const key = joinedCellKey(row);
    assert(selected.has(key), `Workbook consumption has no selected source cell for ${row.metric_id}/${row.source_cell}.`);
    assert.equal(row.value_sha256, selected.get(key), `${row.metric_id} changed between selection and workbook consumption.`);
    assert.equal(consumed.has(key), false, `Duplicate workbook consumption ${row.metric_id}/${row.source_cell}.`);
    consumed.add(key);
  }
  assert.deepEqual([...consumed].sort(), [...selected.keys()].sort(), "Not every selected source cell is consumed exactly once.");
  return {
    status: "PASS",
    schema_version: receipt.schema_version,
    source_commit: receipt.source_identity.source_commit,
    raw_pdf_sha256: receipt.raw_pdf_sha256,
    host_response_sha256: receipt.host_response_sha256,
    workbook_sha256: receipt.workbook_sha256,
    selected_cells: receipt.selected_cells.length,
    consumed: receipt.workbook_consumption.length,
  };
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const receiptPath = process.argv[2];
  if (!receiptPath) throw new Error("Usage: verify_installed_host_broker_canary.mjs <receipt.json>");
  console.log(JSON.stringify(await verifyInstalledHostBrokerReceipt(receiptPath)));
}
