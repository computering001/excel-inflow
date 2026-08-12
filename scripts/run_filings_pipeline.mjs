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

import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
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

function manifestErrors(manifest, document, section, globalLineIds) {
  const errors = [];
  const rows = manifest?.rows ?? [];
  if (manifest?.schema_version !== "face-statement-manifest/1.0") errors.push(`${section} manifest has the wrong schema version`);
  if (manifest?.statement !== section) errors.push(`${section} manifest declares ${manifest?.statement}`);
  if (manifest?.source_id !== document.source_id) errors.push(`${section} manifest source_id is detached from ${document.document_id}`);
  if (manifest?.document_sha256 !== document.raw_sha256) errors.push(`${section} manifest document hash is detached from ${document.document_id}`);
  if (manifest?.complete_face_statement !== true) errors.push(`${section} manifest is not marked complete`);
  if (!Array.isArray(manifest?.periods) || manifest.periods.length !== 3) errors.push(`${section} manifest does not carry exactly three periods`);
  if (!Array.isArray(rows) || rows.length === 0 || manifest?.row_count !== rows.length) errors.push(`${section} row_count is not exact`);
  for (const [index, row] of rows.entries()) {
    if (row?.ordinal !== index + 1) errors.push(`${section}.${row?.source_line_id ?? index} ordinal is not contiguous`);
    if (!row?.source_line_id || globalLineIds.has(row.source_line_id)) errors.push(`${section} repeats or omits source_line_id ${row?.source_line_id ?? ""}`);
    else globalLineIds.add(row.source_line_id);
    if (typeof row?.raw_label !== "string" || row.raw_label.trim() === "") errors.push(`${section}.${row?.source_line_id ?? index} has no exact label`);
    if (!Array.isArray(row?.values) || row.values.length !== 3 || row.values.some((item) => item !== null && !Number.isFinite(Number(item)))) {
      errors.push(`${section}.${row?.source_line_id ?? index} does not carry three numeric/null values`);
    }
    if (typeof row?.page_or_note !== "string" || row.page_or_note.trim() === "") errors.push(`${section}.${row?.source_line_id ?? index} has no source location`);
  }
  if (manifest?.rows_sha256 !== faceStatementManifestDigest(manifest)) errors.push(`${section} rows_sha256 does not bind the ordered rows`);
  return errors;
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
        errors.push(...manifestErrors(manifest, document, section, globalLineIds));
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
  const filings = {
    ...structuredClone(response.filing_facts ?? {}),
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
    throw new Error("Usage: run_filings_pipeline.mjs <request.json> --out <folder> [--responses <response.json>]");
  }
  const outputRoot = path.resolve(process.argv[outIndex + 1]);
  let responsePath = responseIndex >= 0 ? path.resolve(process.argv[responseIndex + 1]) : null;
  await fs.mkdir(outputRoot, { recursive: true });
  const statePath = path.join(outputRoot, "filings-run-state.json");
  const request = await readJson(requestPath, "filings extraction request");
  const requestErrors = validateJsonSchema(request, REQUEST_SCHEMA);
  if (requestErrors.length > 0) throw new Error(`Filings request is invalid: ${requestErrors[0]}`);
  const requestHash = await sha256File(requestPath);
  const runtimeHash = await runtimeClosure();
  const sourceHashes = {};
  const sourceFailures = [];
  const requestBase = path.dirname(requestPath);
  const identities = new Set();
  for (const document of request.documents) {
    const identity = `${document.document_id}|${document.attachment_id}|${document.source_id}`;
    if (identities.has(identity)) sourceFailures.push(`duplicate filing document identity ${identity}`);
    identities.add(identity);
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
    const completed = await execFileAsync(
      "python3",
      [path.join(HERE, "extract_filing_statements.py"), requestPath, "--out", nativeRoot],
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
          request_path: requestPath,
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
