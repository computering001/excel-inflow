#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compileAttachmentIngress } from "./lib/attachment_ingress.mjs";
import { acquireFilingsSources } from "./lib/filings_acquisition.mjs";
import {
  DEFAULT_REMOTE_INGRESS_AUTHORITY,
  addressIsPublic,
  fetchOfficialFile,
  resolveApprovedRegularFile,
  validateOfficialUrl,
} from "./lib/source_ingress_security.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-ingress-security-"));
let checks = 0;

async function rejects(action, pattern, label) {
  await assert.rejects(action, pattern, label);
  checks += 1;
}

try {
  const approved = path.join(temporary, "approved");
  const outside = path.join(temporary, "outside");
  await fs.mkdir(approved);
  await fs.mkdir(outside);
  const valid = path.join(approved, "filing.pdf");
  const secret = path.join(outside, "secret.pdf");
  await fs.writeFile(valid, "%PDF-1.7\nvalid");
  await fs.writeFile(secret, "%PDF-1.7\nsecret");
  assert.equal(
    await resolveApprovedRegularFile({ candidate: valid, approvedRoots: [approved], label: "valid filing" }),
    await fs.realpath(valid),
  );
  checks += 1;
  await rejects(
    () => resolveApprovedRegularFile({ candidate: secret, approvedRoots: [approved], label: "traversal filing" }),
    /leaves its controller-approved local roots/,
    "parent traversal was accepted",
  );
  const escape = path.join(approved, "escape.pdf");
  await fs.symlink(secret, escape);
  await rejects(
    () => resolveApprovedRegularFile({ candidate: escape, approvedRoots: [approved], label: "symlink filing" }),
    /symbolic link|resolves outside/,
    "symlink escape was accepted",
  );
  await rejects(
    () => resolveApprovedRegularFile({ candidate: approved, approvedRoots: [approved], label: "directory filing" }),
    /regular file/,
    "directory input was accepted",
  );
  await rejects(
    () => resolveApprovedRegularFile({ candidate: "/dev/null", approvedRoots: ["/dev"], label: "device filing" }),
    /regular file/,
    "device input was accepted",
  );
  const acquisitionBase = {
    schema_version: "filings-acquisition-request/2.0",
    source_mode: "user_supplied",
    run_id: "security-test",
    company: { name: "Security Test" },
    filing_facts: {},
    sources: [{
      document_id: "annual-report",
      attachment_id: "annual-report",
      source_id: "annual-report",
      origin: "user_supplied",
      path: "../outside/secret.pdf",
      media_type: "application/pdf",
      filing_kind: "annual_report",
      filing_date: "2025-12-31",
      covered_periods: ["2025-12-31"],
      section_coverage: ["income_statement"],
      restatement_basis: "as_reported",
    }],
  };
  await rejects(
    () => acquireFilingsSources({
      request: acquisitionBase,
      requestPath: path.join(approved, "request.json"),
      outDir: path.join(temporary, "acquired"),
      extractionRequestSchema: {},
    }),
    /controller-approved local roots/,
    "filings acquisition accepted a local root escape",
  );
  const evidencePath = path.join(approved, "evidence.json");
  const ingressPath = path.join(approved, "ingress.json");
  await fs.writeFile(evidencePath, JSON.stringify({
    source_inventory: [{ source_id: "annual_report", kind: "company_annual_report" }],
  }));
  await fs.writeFile(ingressPath, JSON.stringify({
    schema_version: "attachment-ingress/1.0",
    evidence_run_path: "evidence.json",
    attachments: [{
      attachment_id: "annual-report",
      source_ids: ["annual_report"],
      path: "../outside/secret.pdf",
      media_type: "application/pdf",
      adapter: {
        domain: "document_extraction",
        format: "pdf",
        extraction_path: "unused.json",
      },
    }],
  }));
  await rejects(
    () => compileAttachmentIngress({ specPath: ingressPath }),
    /controller-approved local roots/,
    "attachment ingress accepted a local root escape",
  );

  const authority = Object.freeze({
    authority_id: "test-official-authority",
    allowed_domains: Object.freeze(["filings.test"]),
    max_redirects: 2,
    max_bytes: 64,
    timeout_ms: 321,
  });
  const publicAddress = "93.184.216.34";
  assert.equal(addressIsPublic("::ffff:127.0.0.1"), false);
  assert.equal(addressIsPublic("::ffff:7f00:1"), false);
  assert.equal(addressIsPublic("fd00:ec2::254"), false);
  assert.equal(addressIsPublic("2606:4700:4700::1111"), true);
  checks += 4;
  const publicLookup = async () => [{ address: publicAddress, family: 4 }];
  const validResponse = async ({ maxBytes, timeoutMs }) => {
    assert.equal(maxBytes, 64, "controller byte bound was not passed to transport");
    assert(timeoutMs > 0 && timeoutMs <= 321, "controller time bound was not passed to transport");
    return {
      statusCode: 200,
      headers: { "content-type": "application/pdf" },
      bytes: Buffer.from("%PDF-1.7\nvalid"),
      remoteAddress: publicAddress,
    };
  };
  const validRemote = await fetchOfficialFile({
    rawUrl: "https://filings.test/report.pdf",
    declaredMediaType: "application/pdf",
    authority,
    lookupFn: publicLookup,
    requestOnce: validResponse,
  });
  assert(validRemote.bytes.subarray(0, 5).equals(Buffer.from("%PDF-")));
  checks += 3;
  let redirectLookups = 0;
  let redirectRequests = 0;
  const redirected = await fetchOfficialFile({
    rawUrl: "https://filings.test/report.pdf",
    declaredMediaType: "application/pdf",
    authority,
    lookupFn: async () => {
      redirectLookups += 1;
      return [{ address: publicAddress, family: 4 }];
    },
    requestOnce: async () => {
      redirectRequests += 1;
      return redirectRequests === 1
        ? {
            statusCode: 302,
            headers: { location: "https://cdn.filings.test/report.pdf" },
            bytes: Buffer.alloc(0),
            remoteAddress: publicAddress,
          }
        : {
            statusCode: 200,
            headers: { "content-type": "application/pdf" },
            bytes: Buffer.from("%PDF-1.7\nredirected"),
            remoteAddress: publicAddress,
          };
    },
  });
  assert.equal(redirectLookups, 2, "allowed redirect was not DNS-revalidated");
  assert.equal(redirectRequests, 2, "allowed redirect was not fetched exactly once per hop");
  assert(redirected.bytes.includes(Buffer.from("redirected")));
  checks += 3;

  await rejects(
    () => fetchOfficialFile({
      rawUrl: "https://filings.test/report.pdf",
      declaredMediaType: "application/pdf",
      authority,
      lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
      requestOnce: validResponse,
    }),
    /private, local, metadata or non-routable/,
    "metadata-service DNS answer was accepted",
  );
  await rejects(
    () => fetchOfficialFile({
      rawUrl: "https://filings.test/report.pdf",
      declaredMediaType: "application/pdf",
      authority: { ...authority, timeout_ms: 10 },
      lookupFn: async () => await new Promise(() => {}),
      requestOnce: validResponse,
    }),
    /exceeded 10ms during DNS validation/,
    "unbounded DNS lookup did not time out",
  );
  await rejects(
    () => fetchOfficialFile({
      rawUrl: "https://filings.test/report.pdf",
      declaredMediaType: "application/pdf",
      authority,
      lookupFn: publicLookup,
      requestOnce: async () => ({
        statusCode: 200,
        headers: { "content-type": "application/pdf" },
        bytes: Buffer.from("%PDF-1.7\nvalid"),
        remoteAddress: "127.0.0.1",
      }),
    }),
    /connection peer differs/,
    "DNS rebinding peer was accepted",
  );
  await rejects(
    () => fetchOfficialFile({
      rawUrl: "https://filings.test/report.pdf",
      declaredMediaType: "application/pdf",
      authority,
      lookupFn: publicLookup,
      requestOnce: async () => ({
        statusCode: 302,
        headers: { location: "https://evil.test/steal" },
        bytes: Buffer.alloc(0),
        remoteAddress: publicAddress,
      }),
    }),
    /outside controller-owned HTTPS authority/,
    "off-authority redirect was accepted",
  );
  await rejects(
    () => fetchOfficialFile({
      rawUrl: "https://filings.test/report.pdf",
      declaredMediaType: "application/pdf",
      authority,
      lookupFn: publicLookup,
      requestOnce: async () => ({
        statusCode: 200,
        headers: { "content-type": "application/pdf" },
        bytes: Buffer.alloc(65, 0x41),
        remoteAddress: publicAddress,
      }),
    }),
    /exceeds 64 bytes/,
    "oversize response was accepted",
  );
  await rejects(
    () => fetchOfficialFile({
      rawUrl: "https://filings.test/report.pdf",
      declaredMediaType: "application/pdf",
      authority,
      lookupFn: publicLookup,
      requestOnce: async () => ({
        statusCode: 200,
        headers: { "content-type": "text/html" },
        bytes: Buffer.from("<html>login</html>"),
        remoteAddress: publicAddress,
      }),
    }),
    /content-type/,
    "HTML response was accepted as a PDF",
  );
  await rejects(
    () => fetchOfficialFile({
      rawUrl: "https://filings.test/report.pdf",
      declaredMediaType: "application/pdf",
      authority,
      lookupFn: publicLookup,
      requestOnce: async () => ({
        statusCode: 200,
        headers: { "content-type": "application/pdf" },
        bytes: Buffer.from("not-a-pdf"),
        remoteAddress: publicAddress,
      }),
    }),
    /magic bytes/,
    "wrong magic bytes were accepted",
  );
  assert.throws(
    () => validateOfficialUrl("https://example.com/report.pdf", DEFAULT_REMOTE_INGRESS_AUTHORITY),
    /outside controller-owned HTTPS authority/,
    "caller-selected domain escaped the independent authority",
  );
  checks += 1;
  const callerDomainRequest = structuredClone(acquisitionBase);
  callerDomainRequest.source_mode = "internal";
  callerDomainRequest.sources[0] = {
    ...callerDomainRequest.sources[0],
    origin: "official_declarative_url",
    url: "https://evil.test/report.pdf",
    publisher_name: "Untrusted caller declaration",
    allowed_domains: ["evil.test"],
  };
  delete callerDomainRequest.sources[0].path;
  await rejects(
    () => acquireFilingsSources({
      request: callerDomainRequest,
      requestPath: path.join(approved, "request.json"),
      outDir: path.join(temporary, "remote-acquired"),
      extractionRequestSchema: {},
    }),
    /exceeds controller-owned official-domain authority/,
    "caller-selected domain replaced controller authority",
  );

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
