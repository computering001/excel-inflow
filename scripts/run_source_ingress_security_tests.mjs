#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { compileAttachmentIngress } from "./lib/attachment_ingress.mjs";
import { acquireFilingsSources } from "./lib/filings_acquisition.mjs";
import { stageHashBoundTestSource } from "./lib/hash_bound_source_staging.mjs";
import {
  DEFAULT_REMOTE_INGRESS_AUTHORITY,
  addressIsPublic,
  fetchOfficialFile,
  resolveApprovedRegularFile,
  validateOfficialUrl,
} from "./lib/source_ingress_security.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-ingress-security-"));
const exec = promisify(execFile);
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

  const stagedRoot = path.join(temporary, "controller-run", "raw-inputs");
  const validBytes = await fs.readFile(valid);
  const validSha256 = createHash("sha256").update(validBytes).digest("hex");
  const staged = await stageHashBoundTestSource({
    sourcePath: valid,
    destinationPath: path.join(stagedRoot, "filing.pdf"),
    expectedSha256: validSha256,
    label: "canary filing",
  });
  assert.equal(staged.sha256, validSha256);
  assert.equal(
    await resolveApprovedRegularFile({
      candidate: staged.path,
      approvedRoots: [stagedRoot],
      label: "staged canary filing",
    }),
    staged.path,
  );
  checks += 2;
  const mismatchDestination = path.join(stagedRoot, "digest-mismatch.pdf");
  await rejects(
    () => stageHashBoundTestSource({
      sourcePath: valid,
      destinationPath: mismatchDestination,
      expectedSha256: "0".repeat(64),
      label: "digest mutation",
    }),
    /SHA-256 does not match/,
    "hash-mismatched test source entered the controller run root",
  );
  await assert.rejects(() => fs.stat(mismatchDestination), /ENOENT/);
  checks += 1;
  const sourceSymlink = path.join(outside, "source-link.pdf");
  await fs.symlink(valid, sourceSymlink);
  await rejects(
    () => stageHashBoundTestSource({
      sourcePath: sourceSymlink,
      destinationPath: path.join(stagedRoot, "source-link.pdf"),
      expectedSha256: validSha256,
      label: "source symlink mutation",
    }),
    /must not be a symbolic link/,
    "symlinked test source entered the controller run root",
  );
  const destinationSymlink = path.join(stagedRoot, "destination-link.pdf");
  await fs.symlink(secret, destinationSymlink);
  await rejects(
    () => stageHashBoundTestSource({
      sourcePath: valid,
      destinationPath: destinationSymlink,
      expectedSha256: validSha256,
      label: "destination symlink mutation",
    }),
    /EEXIST/,
    "source staging overwrote a destination symlink",
  );
  assert.equal(await fs.readFile(secret, "utf8"), "%PDF-1.7\nsecret");
  checks += 1;

  // A controller may persist a canonical artifact path while retaining an
  // alias spelling for the approved root (/private/var vs /var on macOS).
  // Prove this generically with an explicit directory alias on every host.
  const canonicalApproved = path.join(temporary, "canonical-approved");
  const approvedAlias = path.join(temporary, "approved-alias");
  await fs.mkdir(canonicalApproved);
  await fs.symlink(canonicalApproved, approvedAlias);
  const canonicalArtifact = path.join(canonicalApproved, "canonical-filing.pdf");
  await fs.writeFile(canonicalArtifact, "%PDF-1.7\ncanonical");
  assert.equal(
    await resolveApprovedRegularFile({
      candidate: await fs.realpath(canonicalArtifact),
      approvedRoots: [approvedAlias],
      label: "canonical alias filing",
    }),
    await fs.realpath(canonicalArtifact),
  );
  checks += 1;
  const aliasArtifact = path.join(approvedAlias, "canonical-filing.pdf");
  assert.equal(
    await resolveApprovedRegularFile({
      candidate: aliasArtifact,
      approvedRoots: [canonicalApproved],
      label: "artifact alias filing",
    }),
    await fs.realpath(canonicalArtifact),
  );
  checks += 1;
  await rejects(
    () => resolveApprovedRegularFile({ candidate: secret, approvedRoots: [approved], label: "traversal filing" }),
    /leaves its controller-approved local roots/,
    "parent traversal was accepted",
  );
  await rejects(
    () => resolveApprovedRegularFile({
      candidate: secret,
      approvedRoots: [approvedAlias],
      label: "canonical alias escape",
    }),
    /leaves its controller-approved local roots|resolves outside/,
    "canonical approved-root alias widened custody to an outside file",
  );
  const escape = path.join(approved, "escape.pdf");
  await fs.symlink(secret, escape);
  await rejects(
    () => resolveApprovedRegularFile({ candidate: escape, approvedRoots: [approved], label: "symlink filing" }),
    /symbolic link|resolves outside/,
    "symlink escape was accepted",
  );
  const nestedEscape = path.join(approved, "nested-escape");
  await fs.symlink(outside, nestedEscape);
  await rejects(
    () => resolveApprovedRegularFile({
      candidate: path.join(nestedEscape, "secret.pdf"),
      approvedRoots: [approved],
      label: "intermediate symlink filing",
    }),
    /resolves outside/,
    "an intermediate symlink escaped canonical containment",
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
  const fifo = path.join(approved, "filing.fifo");
  await exec("mkfifo", [fifo]);
  await rejects(
    () => resolveApprovedRegularFile({ candidate: fifo, approvedRoots: [approved], label: "FIFO filing" }),
    /regular file/,
    "FIFO input was accepted",
  );
  // Keep the Unix-domain path below the conservative 104-byte sockaddr_un
  // limit used by several supported hosts; the main test root can be longer.
  const socketRoot = await fs.mkdtemp("/tmp/excel-inflow-socket-");
  const socketPath = path.join(socketRoot, "filing.sock");
  const socketServer = net.createServer();
  await new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(socketPath, resolve);
  });
  try {
    await rejects(
      () => resolveApprovedRegularFile({ candidate: socketPath, approvedRoots: [socketRoot], label: "Unix socket filing" }),
      /regular file/,
      "Unix socket input was accepted",
    );
  } finally {
    await new Promise((resolve, reject) => socketServer.close((error) => error ? reject(error) : resolve()));
    await fs.rm(socketRoot, { recursive: true, force: true });
  }
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
      authority: { ...authority, timeout_ms: 10 },
      lookupFn: publicLookup,
      requestOnce: async () => await new Promise((resolve) => setTimeout(() => resolve({
        statusCode: 200,
        headers: { "content-type": "application/pdf" },
        bytes: Buffer.from("%PDF-1.7 delayed response body"),
        remoteAddress: "93.184.216.34",
      }), 50)),
    }),
    /exceeded 10ms during response body/,
    "slow response body escaped the controller deadline",
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
