#!/usr/bin/env node
/** Own raw filing review through hash-bound, complete face-statement evidence. */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { filingManifestCustodyErrors } from "./lib/face_statement_manifest.mjs";
import { acquireFilingsSources } from "./lib/filings_acquisition.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { resolvePythonExecutable } from "./lib/process_tree.mjs";
import { canonicalise } from "./lib/run_store.mjs";
import {
  assertWorkflowState,
  assertWorkflowTransition,
} from "./lib/workflow_state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ASSETS = path.join(ROOT, "assets");
const ATTEMPT_LIMIT = 3;
const execFileAsync = promisify(execFile);
const REQUEST_SCHEMA = JSON.parse(readFileSync(path.join(ASSETS, "filings-extraction-request-v1.schema.json"), "utf8"));
const RESPONSE_SCHEMA = JSON.parse(readFileSync(path.join(ASSETS, "filings-extraction-response-v1.schema.json"), "utf8"));
const SOURCE_REGISTRY_SCHEMA = JSON.parse(readFileSync(path.join(ASSETS, "filings-source-registry-v1.schema.json"), "utf8"));
const SOURCE_REGISTRY_SCHEMA_V2 = JSON.parse(readFileSync(path.join(ASSETS, "filings-source-registry-v2.schema.json"), "utf8"));
const RUNTIME_MANIFEST = JSON.parse(readFileSync(path.join(ASSETS, "filings-runtime-members.json"), "utf8"));
const SECTIONS = Object.freeze(["income_statement", "cash_flow"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(target) {
  return sha256(await fs.readFile(target));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalise(value))}\n`, "utf8");
}

async function readJson(target, label) {
  try {
    const value = JSON.parse(await fs.readFile(target, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root is not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

async function atomicJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, canonicalBytes(value), { flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function resolveFrom(base, value) {
  const target = path.resolve(base, String(value ?? ""));
  return target;
}

async function runtimeClosure() {
  if (
    RUNTIME_MANIFEST.schema_version !== "filings-runtime-members/1.0" ||
    !Array.isArray(RUNTIME_MANIFEST.members) ||
    RUNTIME_MANIFEST.members.length === 0 ||
    new Set(RUNTIME_MANIFEST.members).size !== RUNTIME_MANIFEST.members.length
  ) {
    throw new Error("Filings runtime-members manifest is malformed.");
  }
  const members = {};
  for (const relative of RUNTIME_MANIFEST.members) {
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new Error(`Invalid filings runtime member ${JSON.stringify(relative)}.`);
    }
    members[relative] = await sha256File(path.join(ROOT, relative));
  }
  return sha256(canonicalBytes(members));
}

function priorAttempts(prior, cacheKey) {
  if (prior?.cache_key !== cacheKey) {
    return { response_sha256: [], count: 0, limit: ATTEMPT_LIMIT };
  }
  return {
    response_sha256: [...new Set(prior?.attempts?.response_sha256 ?? [])],
    count: Number(prior?.attempts?.count ?? 0),
    limit: ATTEMPT_LIMIT,
  };
}

async function writeState(target, value) {
  assertWorkflowState("filings", {
    status: value.pipeline_status,
    blockerClass: value.blocker_class,
    userBlocking: value.user_blocking,
  });
  const prior = await readJson(target, "prior filings run state").catch(() => null);
  assertWorkflowTransition(
    "filings",
    prior?.pipeline_status,
    value.pipeline_status,
    { reset: prior?.cache_key !== value.cache_key },
  );
  await atomicJson(target, value);
  process.stdout.write(`${JSON.stringify({
    status: value.pipeline_status,
    blocker_class: value.blocker_class,
    user_blocking: value.user_blocking,
    task_count: value.tasks.length,
    state: target,
    ...value.summary,
  })}\n`);
}

function stateBase({ runId, requestHash, sourceHashes, runtimeHash, cacheKey, attempts }) {
  return {
    schema_version: "filings-run-state/1.0",
    run_id: runId,
    request_sha256: requestHash,
    source_sha256: sourceHashes,
    runtime_closure_sha256: runtimeHash,
    cache_key: cacheKey,
    artifacts: {},
    artifact_sha256: {},
    tasks: [],
    attempts,
    summary: {},
  };
}

function deriveLines(manifests) {
  const labels = new Map();
  for (const manifest of manifests) {
    for (const row of manifest.rows ?? []) labels.set(row.source_line_id, row.raw_label);
  }
  return manifests.flatMap((manifest) =>
    (manifest.rows ?? []).map((row) => ({
      source_line_id: row.source_line_id,
      label: row.raw_label,
      values: row.values.map((value) => value === null ? null : Number(value)),
      source_id: manifest.source_id,
      page_or_note: row.page_or_note,
      face_statement: true,
      material: row.material === true,
      ...(row.parent_source_line_id && labels.has(row.parent_source_line_id)
        ? { parent_label: labels.get(row.parent_source_line_id) }
        : {}),
    })),
  );
}

function declarationPriority(declaration) {
  return [
    Number.isInteger(declaration?.authority_rank) ? declaration.authority_rank : 3,
    String(declaration?.filing_date ?? "0000-00-00"),
    declaration?.restatement_basis === "restated_comparative" ? 0 : 1,
    String(declaration?.document_id ?? ""),
  ];
}

function compareDeclarationPriority(left, right) {
  const a = declarationPriority(left);
  const b = declarationPriority(right);
  return a[0] - b[0] || b[1].localeCompare(a[1]) || a[2] - b[2] || a[3].localeCompare(b[3]);
}

function compilePeriodAuthority({ request, response, manifests, errors }) {
  const responseBySource = new Map();
  for (const document of response.documents ?? []) responseBySource.set(document.source_id, document);
  const requestBySource = new Map();
  for (const document of request.documents ?? []) requestBySource.set(document.source_id, document);
  const periods = response.filing_facts?.historical_periods ?? [];
  const authority = {};
  for (const section of SECTIONS) {
    if (manifests[section].length !== 1) {
      errors.push(`${section} must resolve to one canonical complete-face-statement topology; found ${manifests[section].length}`);
      authority[section] = [];
      continue;
    }
    const manifest = manifests[section][0];
    const selected = requestBySource.get(manifest.source_id);
    if (!selected) {
      errors.push(`${section} canonical manifest source ${manifest.source_id} is absent from the request`);
      authority[section] = [];
      continue;
    }
    let selectedOwnsAtLeastOnePeriod = false;
    authority[section] = periods.map((period) => {
      const candidates = (request.documents ?? [])
        .filter((document) =>
          (!document.section_coverage || document.section_coverage.includes(section)) &&
          (!document.covered_periods || document.covered_periods.includes(period)),
        )
        .sort(compareDeclarationPriority);
      const preferred = candidates[0] ?? selected;
      if (preferred.source_id === selected.source_id) selectedOwnsAtLeastOnePeriod = true;
      const authorityResponse = responseBySource.get(preferred.source_id);
      if (
        preferred.source_id !== selected.source_id &&
        authorityResponse?.disposition !== "selected_period_authority_support"
      ) {
        errors.push(
          `${section}.${period} uses ${preferred.source_id} as period authority without selected_period_authority_support disposition`,
        );
      }
      return {
        period,
        source_id: preferred.source_id,
        document_id: preferred.document_id,
        document_sha256: authorityResponse?.raw_sha256 ?? manifest.document_sha256,
        origin: preferred.origin ?? "legacy_direct",
        basis: preferred.restatement_basis ?? "as_reported",
        filing_date: preferred.filing_date ?? null,
        topology_source_id: manifest.source_id,
        reason:
          (preferred.origin ?? "legacy_direct") === "user_supplied"
            ? "User-supplied filing is authoritative ahead of retrieved or runtime-library sources."
            : preferred.restatement_basis === "restated_comparative"
              ? "Latest declared restated comparative is authoritative within the same source tier."
              : "Highest-ranked declared complete filing source is authoritative.",
      };
    });
    if (!selectedOwnsAtLeastOnePeriod) {
      errors.push(
        `${section} topology source ${selected.source_id} is lower-priority for every selected historical period`,
      );
    }
  }
  return authority;
}

function compileResponse({ response, request, sourceHashes }) {
  const errors = validateJsonSchema(response, RESPONSE_SCHEMA);
  if (response.run_id !== request.run_id) errors.push("response run_id does not match request");
  const expected = new Map(request.documents.map((document) => [document.document_id, document]));
  const seen = new Set();
  const globalLineIds = new Set();
  const manifests = { income_statement: [], cash_flow: [] };
  const documentExtractions = [];
  for (const document of response.documents ?? []) {
    const declaration = expected.get(document.document_id);
    if (!declaration || seen.has(document.document_id)) {
      errors.push(`response contains absent or duplicate document ${document.document_id}`);
      continue;
    }
    seen.add(document.document_id);
    if (document.attachment_id !== declaration.attachment_id || document.source_id !== declaration.source_id) {
      errors.push(`response document ${document.document_id} changes attachment/source identity`);
    }
    if (document.raw_sha256 !== sourceHashes[document.document_id]) {
      errors.push(`response document ${document.document_id} is detached from raw bytes`);
    }
    const documentManifests = { income_statement: [], cash_flow: [] };
    for (const section of SECTIONS) {
      const entries = document.face_statement_manifests?.[section] ?? [];
      for (const manifest of entries) {
        errors.push(...filingManifestCustodyErrors({
          manifest,
          document,
          section,
          globalLineIds,
          filingFacts: response.filing_facts,
        }));
        documentManifests[section].push(structuredClone(manifest));
        manifests[section].push(structuredClone(manifest));
      }
    }
    const selectedCount = SECTIONS.reduce((count, section) => count + documentManifests[section].length, 0);
    if (document.disposition === "selected_face_statement_authority" && selectedCount === 0) {
      errors.push(`selected document ${document.document_id} contains no selected face statement`);
    }
    if (document.disposition === "reviewed_supplemental" && selectedCount !== 0) {
      errors.push(`supplemental document ${document.document_id} attempts to contribute selected face statements`);
    }
    if (document.disposition === "selected_period_authority_support" && selectedCount !== 0) {
      errors.push(`period-support document ${document.document_id} attempts to own canonical statement topology`);
    }
    documentExtractions.push({
      schema_version: "document-extraction/1.0",
      attachment_id: document.attachment_id,
      source_ids: [document.source_id],
      raw_sha256: document.raw_sha256,
      disposition: document.disposition,
      review_reason: document.review_reason,
      face_statement_manifests: documentManifests,
    });
  }
  for (const documentId of expected.keys()) {
    if (!seen.has(documentId)) errors.push(`response omits document ${documentId}`);
  }
  for (const section of SECTIONS) {
    if (manifests[section].length === 0) errors.push(`response contains no selected ${section} authority`);
    const orders = manifests[section].map((manifest) => manifest.statement_order).sort((a, b) => a - b);
    if (new Set(orders).size !== orders.length || orders.some((order, index) => order !== index + 1)) {
      errors.push(`${section} statement_order is not unique and contiguous`);
    }
    for (const manifest of manifests[section]) {
      if (JSON.stringify(manifest.periods) !== JSON.stringify(response.filing_facts?.historical_periods)) {
        errors.push(`${section} manifest periods do not equal selected historical periods`);
      }
    }
  }
  const periodAuthority = compilePeriodAuthority({ request, response, manifests, errors });
  const filings = {
    ...structuredClone(response.filing_facts ?? {}),
    period_authority: periodAuthority,
    face_statement_manifests: manifests,
    income_statement: deriveLines(manifests.income_statement),
    cash_flow: deriveLines(manifests.cash_flow),
  };
  return { errors, filings, documentExtractions };
}

async function main() {
  const requestPath = path.resolve(process.argv[2] ?? "");
  const outIndex = process.argv.indexOf("--out");
  const responseIndex = process.argv.indexOf("--responses");
  if (!process.argv[2] || outIndex < 0 || !process.argv[outIndex + 1]) {
    throw new Error("Usage: run_filings_pipeline.mjs <acquisition-or-extraction-request.json> --out <folder> [--responses <response.json>]");
  }
  const outputRoot = path.resolve(process.argv[outIndex + 1]);
  let responsePath = responseIndex >= 0 ? path.resolve(process.argv[responseIndex + 1]) : null;
  await fs.mkdir(outputRoot, { recursive: true });
  const statePath = path.join(outputRoot, "filings-run-state.json");
  const inputRequest = await readJson(requestPath, "filings request");
  const runtimeHash = await runtimeClosure();
  const inputRequestHash = await sha256File(requestPath);
  let request = inputRequest;
  let effectiveRequestPath = requestPath;
  const acquisitionArtifacts = {};
  if (["filings-acquisition-request/1.0", "filings-acquisition-request/2.0"].includes(inputRequest.schema_version)) {
    try {
      const acquired = await acquireFilingsSources({
        request: inputRequest,
        requestPath,
        outDir: path.join(outputRoot, "acquisition"),
        extractionRequestSchema: REQUEST_SCHEMA,
        sourceRegistrySchema: inputRequest.schema_version === "filings-acquisition-request/2.0"
          ? SOURCE_REGISTRY_SCHEMA_V2
          : SOURCE_REGISTRY_SCHEMA,
      });
      request = acquired.extractionRequest;
      effectiveRequestPath = acquired.extractionRequestPath;
      acquisitionArtifacts.filings_source_registry = acquired.registryPath;
      acquisitionArtifacts.acquired_extraction_request = acquired.extractionRequestPath;
    } catch (error) {
      const message = String(error?.message ?? error);
      const fatalSource = /ENOENT|expected_sha256 does not match|HTTP 4(?:00|01|03|04|10)/i.test(message);
      const requestHash = sha256(canonicalBytes({ input_request_sha256: inputRequestHash }));
      const cacheKey = sha256(canonicalBytes({ request: requestHash, sources: {}, runtime: runtimeHash }));
      const prior = await readJson(statePath, "prior filings run state").catch(() => null);
      const attempts = priorAttempts(prior, cacheKey);
      await writeState(statePath, {
        ...stateBase({
          runId: inputRequest.run_id ?? "invalid-filings-acquisition",
          requestHash,
          sourceHashes: {},
          runtimeHash,
          cacheKey,
          attempts,
        }),
        pipeline_status: fatalSource ? "BLOCKED_INPUT" : "BLOCKED_INTERNAL",
        user_blocking: fatalSource,
        blocker_class: fatalSource ? "FATAL_SOURCE" : "INTERNAL_WORK",
        tasks: fatalSource ? [] : [{
          task_kind: "filings_acquisition_repair",
          instruction: "Repair the controlled declarative source registry or acquisition controller; do not search for an undeclared replacement and do not ask for unchanged readable evidence.",
          violation: message,
        }],
        summary: { terminal_reason: fatalSource ? "fatal_source" : "filings_acquisition_failed", message },
      });
      return 2;
    }
  }
  const requestErrors = validateJsonSchema(request, REQUEST_SCHEMA);
  if (requestErrors.length > 0) throw new Error(`Filings request is invalid: ${requestErrors[0]}`);
  const requestHash = sha256(canonicalBytes({
    input_request_sha256: await sha256File(requestPath),
    effective_request_sha256: await sha256File(effectiveRequestPath),
  }));
  const sourceHashes = {};
  const sourceFailures = [];
  const requestBase = path.dirname(requestPath);
  const identities = new Set();
  const documentIds = new Set();
  const attachmentIds = new Set();
  const sourceIds = new Set();
  for (const document of request.documents) {
    const identity = `${document.document_id}|${document.attachment_id}|${document.source_id}`;
    if (identities.has(identity)) sourceFailures.push(`duplicate filing document identity ${identity}`);
    identities.add(identity);
    if (documentIds.has(document.document_id)) sourceFailures.push(`duplicate filing document_id ${document.document_id}`);
    if (attachmentIds.has(document.attachment_id)) sourceFailures.push(`duplicate filing attachment_id ${document.attachment_id}`);
    if (sourceIds.has(document.source_id)) sourceFailures.push(`duplicate filing source_id ${document.source_id}`);
    documentIds.add(document.document_id);
    attachmentIds.add(document.attachment_id);
    sourceIds.add(document.source_id);
    const target = resolveFrom(requestBase, document.path);
    try {
      const digest = await sha256File(target);
      sourceHashes[document.document_id] = digest;
      if (document.expected_sha256 && document.expected_sha256 !== digest) {
        sourceFailures.push(`${document.document_id} expected_sha256 does not match`);
      }
    } catch {
      sourceFailures.push(`${document.document_id} raw filing is absent`);
    }
  }
  const cacheKey = sha256(canonicalBytes({ request: requestHash, sources: sourceHashes, runtime: runtimeHash }));
  const prior = await readJson(statePath, "prior filings run state").catch(() => null);
  const attempts = priorAttempts(prior, cacheKey);
  const base = stateBase({ runId: request.run_id, requestHash, sourceHashes, runtimeHash, cacheKey, attempts });
  if (sourceFailures.length > 0) {
    await writeState(statePath, {
      ...base,
      pipeline_status: "BLOCKED_INPUT",
      user_blocking: true,
      blocker_class: "FATAL_SOURCE",
      summary: { terminal_reason: "fatal_source", violations: sourceFailures },
    });
    return 2;
  }
  const nativeArtifacts = {};
  if (!responsePath) {
    const nativeRoot = path.join(outputRoot, `native-${cacheKey.slice(0, 16)}`);
    const pythonCandidate = process.env.EXCEL_INFLOW_PYTHON ?? process.env.PYTHON ?? "python3";
    if (process.env.EXCEL_INFLOW_PYTHON && !path.isAbsolute(pythonCandidate)) {
      throw new Error("EXCEL_INFLOW_PYTHON must be the top-level resolved absolute executable.");
    }
    const pythonExecutable = process.env.EXCEL_INFLOW_PYTHON
      ? pythonCandidate
      : await resolvePythonExecutable(pythonCandidate, { cwd: HERE, env: process.env });
    const completed = await execFileAsync(
      pythonExecutable,
      [path.join(HERE, "extract_filing_statements.py"), effectiveRequestPath, "--out", nativeRoot],
      { cwd: HERE, maxBuffer: 32 * 1024 * 1024 },
    ).then((value) => ({ ...value, code: 0 })).catch((error) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
      code: error.code ?? 1,
    }));
    const nativeResponse = path.join(nativeRoot, "filings-extraction-response.json");
    const nativeReceiptPath = path.join(nativeRoot, "filings-native-extraction-receipt.json");
    const nativeReceipt = await readJson(nativeReceiptPath, "native filing extraction receipt").catch(() => null);
    if (!nativeReceipt || nativeReceipt.status !== "PASS" || completed.code !== 0) {
      const findings = nativeReceipt?.findings ?? [{
        code: "NATIVE_EXTRACTION_FAILED",
        message: String(completed.stderr || completed.stdout || "native extractor returned no receipt").slice(-4000),
      }];
      await writeState(statePath, {
        ...base,
        pipeline_status: "NEEDS_EXTRACTION_REVIEW",
        user_blocking: false,
        blocker_class: "INTERNAL_WORK",
        artifacts: nativeReceipt ? { native_extraction_receipt: nativeReceiptPath } : {},
        artifact_sha256: nativeReceipt ? { native_extraction_receipt: await sha256File(nativeReceiptPath) } : {},
        tasks: [{
          task_kind: "filing_extraction_adjudication",
          request_path: effectiveRequestPath,
          candidate_response_path: await fs.stat(nativeResponse).then(() => nativeResponse).catch(() => null),
          unresolved_lines: findings,
          instruction: "Adjudicate only the named unresolved statement headings, period columns or lines. Preserve the native candidate's remaining rows byte-for-byte; do not re-author complete statements or ask for unchanged readable filings to be re-uploaded.",
        }],
        summary: {
          document_count: request.documents.length,
          unresolved_line_count: findings.length,
          violations: findings,
        },
      });
      return 2;
    }
    responsePath = nativeResponse;
    nativeArtifacts.native_extraction_receipt = nativeReceiptPath;
  }
  let response;
  let compiled;
  let responseHash = null;
  const responseErrors = [];
  try {
    responseHash = await sha256File(responsePath);
    response = await readJson(responsePath, "filings extraction response");
    compiled = compileResponse({ response, request, sourceHashes });
    if (acquisitionArtifacts.filings_source_registry) {
      compiled.filings.source_registry_sha256 = await sha256File(
        acquisitionArtifacts.filings_source_registry,
      );
    }
    responseErrors.push(...compiled.errors);
  } catch (error) {
    responseErrors.push(error.message);
  }
  attempts.count += 1;
  if (responseHash && !attempts.response_sha256.includes(responseHash)) attempts.response_sha256.push(responseHash);
  if (responseErrors.length > 0) {
    const exhausted = attempts.count >= attempts.limit;
    await writeState(statePath, {
      ...base,
      attempts,
      pipeline_status: exhausted ? "BLOCKED_INTERNAL" : "NEEDS_EXTRACTION_REVIEW",
      user_blocking: false,
      blocker_class: "INTERNAL_WORK",
      tasks: [{
        task_kind: "filing_extraction_repair",
        response_path: responsePath,
        violations: responseErrors,
        instruction: "Repair only the hash-bound filing extraction response. Do not ask for unchanged readable filings to be re-uploaded and do not shorten the selected face statements.",
      }],
      summary: {
        terminal_reason: exhausted ? "bounded_extraction_retry_exhausted" : null,
        violation_count: responseErrors.length,
        violations: responseErrors,
      },
    });
    return 2;
  }
  const extractionRoot = path.join(outputRoot, `compiled-${cacheKey.slice(0, 16)}-${responseHash.slice(0, 12)}`);
  await fs.mkdir(extractionRoot, { recursive: true });
  const registry = {};
  for (const extraction of compiled.documentExtractions) {
    const target = path.join(extractionRoot, `${extraction.attachment_id}.document-extraction.json`);
    await atomicJson(target, extraction);
    registry[extraction.attachment_id] = {
      path: target,
      sha256: await sha256File(target),
    };
  }
  const registryPath = path.join(extractionRoot, "document-extraction-registry.json");
  await atomicJson(registryPath, {
    schema_version: "document-extraction-registry/1.0",
    run_id: request.run_id,
    documents: registry,
  });
  const bundlePath = path.join(extractionRoot, "filings-evidence-bundle.json");
  const bundleBody = {
    schema_version: "filings-evidence-bundle/1.0",
    run_id: request.run_id,
    request_sha256: requestHash,
    source_sha256: sourceHashes,
    response_sha256: responseHash,
    runtime_closure_sha256: runtimeHash,
    documents: response.documents,
    filings: compiled.filings,
    document_extraction_registry_sha256: await sha256File(registryPath),
  };
  await atomicJson(bundlePath, { ...bundleBody, bundle_sha256: sha256(canonicalBytes(bundleBody)) });
  const artifacts = {
    filings_bundle: bundlePath,
    document_extraction_registry: registryPath,
    ...acquisitionArtifacts,
    ...nativeArtifacts,
  };
  await writeState(statePath, {
    ...base,
    attempts,
    pipeline_status: "PASS",
    user_blocking: false,
    blocker_class: null,
    artifacts,
    artifact_sha256: Object.fromEntries(
      await Promise.all(Object.entries(artifacts).map(async ([name, target]) => [name, await sha256File(target)])),
    ),
    summary: {
      document_count: request.documents.length,
      income_statement_manifest_count: compiled.filings.face_statement_manifests.income_statement.length,
      cash_flow_manifest_count: compiled.filings.face_statement_manifests.cash_flow.length,
      income_statement_row_count: compiled.filings.income_statement.length,
      cash_flow_row_count: compiled.filings.cash_flow.length,
      violation_count: 0,
    },
  });
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
