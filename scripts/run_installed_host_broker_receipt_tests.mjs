#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
import { verifyInstalledHostBrokerReceipt } from "./verify_installed_host_broker_canary.mjs";

const run = createRunner({
  name: "installed_host_broker_receipt_tests",
  importMetaUrl: import.meta.url,
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-host-receipt-contract-"));
const rawPdf = Buffer.from("%PDF-1.7\n%%EOF\n");
const hostResponse = Buffer.from('{"schema_version":"host-response/1.0","status":"PASS"}\n');
const workbook = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
fs.writeFileSync(path.join(root, "broker.pdf"), rawPdf);
fs.writeFileSync(path.join(root, "host-response.json"), hostResponse);
fs.writeFileSync(path.join(root, "model.xlsx"), workbook);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const valueSha256 = hash("123.45");
const activeSourceIdentity = {
  source_commit: "a".repeat(40),
  source_tree: "b".repeat(40),
  runtime_code_closure_sha256: "c".repeat(64),
  package_mode: "certified",
  deployment_status: "installed_candidate",
  installation_identity: "installed-v370-test",
};
const receipt = {
  schema_version: "installed-host-broker-canary/2.0",
  status: "PASS",
  source_identity: {
    schema_version: "installed-host-source-identity/2.0",
    ...activeSourceIdentity,
    broker_document_id: "document-1",
    broker_source_id: "source-1",
    broker_house_id: "house-1",
    raw_pdf_sha256: hash(rawPdf),
  },
  artifacts: { raw_pdf: "broker.pdf", host_response: "host-response.json", workbook: "model.xlsx" },
  raw_pdf_sha256: hash(rawPdf),
  host_response_sha256: hash(hostResponse),
  selected_cells: [{ metric_id: "revenue", source_cell: "B12", value_sha256: valueSha256, host_response_sha256: hash(hostResponse) }],
  workbook_sha256: hash(workbook),
  workbook_consumption: [{
    metric_id: "revenue",
    source_cell: "B12",
    workbook_cell: "J20",
    value_sha256: valueSha256,
    workbook_sha256: hash(workbook),
    consumed: true,
  }],
};
const receiptPath = path.join(root, "receipt.json");
const verify = (candidate) => {
  fs.writeFileSync(receiptPath, `${JSON.stringify(candidate, null, 2)}\n`);
  return verifyInstalledHostBrokerReceipt(receiptPath, { activeSourceIdentity });
};

const cleanStatus = (await verify(receipt)).status;
run.check("well-formed installed-host receipt verifies", () => {
  assert.equal(cleanStatus, "PASS");
  return true;
});

const mutations = [
  (value) => { delete value.raw_pdf_sha256; },
  (value) => { value.raw_pdf_sha256 = "not-a-hash"; },
  (value) => { value.source_identity.raw_pdf_sha256 = "d".repeat(64); },
  (value) => { value.source_identity.source_commit = "d".repeat(40); },
  (value) => { value.selected_cells[0].host_response_sha256 = "d".repeat(64); },
  (value) => { value.workbook_consumption[0].workbook_sha256 = "d".repeat(64); },
  (value) => { value.workbook_consumption[0].value_sha256 = "d".repeat(64); },
  (value) => { value.workbook_consumption = []; },
  (value) => { value.schema_version = "installed-host-broker-canary/1.0"; },
  (value) => { value.artifacts.raw_pdf = "../outside.pdf"; },
];
let mutationsCaught = 0;
for (const [index, mutate] of mutations.entries()) {
  const candidate = structuredClone(receipt);
  mutate(candidate);
  const rejected = await verify(candidate).then(
    () => false,
    () => true,
  );
  if (rejected) mutationsCaught += 1;
  run.check(`mutation ${index + 1} is rejected`, () => {
    assert.equal(rejected, true);
    return true;
  });
}

fs.writeFileSync(path.join(root, "broker.pdf"), Buffer.from("%PDF-tampered\n"));
const tamperedRejected = await verify(receipt).then(
  () => false,
  (error) => /hash mismatch/.test(error?.message ?? String(error)),
);
if (tamperedRejected) mutationsCaught += 1;
run.check("tampered broker document fails the receipt hash", () => {
  assert.equal(tamperedRejected, true);
  return true;
});

fs.writeFileSync(path.join(root, "broker.pdf"), rawPdf);
fs.symlinkSync("broker.pdf", path.join(root, "broker-link.pdf"));
const symlinkMutation = structuredClone(receipt);
symlinkMutation.artifacts.raw_pdf = "broker-link.pdf";
const symlinkRejected = await verify(symlinkMutation).then(
  () => false,
  (error) => /symbolic link/.test(error?.message ?? String(error)),
);
if (symlinkRejected) mutationsCaught += 1;
run.check("symbolic-link artifact path is rejected", () => {
  assert.equal(symlinkRejected, true);
  return true;
});

run.finish({ mutations_caught: mutationsCaught });
