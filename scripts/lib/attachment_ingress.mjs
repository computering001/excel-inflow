import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { validateJsonSchema } from "./json_schema.mjs";
import { canonicalJson, hashValue } from "./run_store.mjs";
import {
  FACE_STATEMENT_SECTIONS,
  faceStatementManifestDigest,
} from "./face_statement_manifest.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ASSETS = path.resolve(HERE, "..", "..", "assets");
const SHA256 = /^[a-f0-9]{64}$/;
const XLSX_MEDIA = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);

const schema = (name) => JSON.parse(readFileSync(path.join(ASSETS, name), "utf8"));
const DCS_SCHEMA = schema("dcs-export.schema.json");
const BROKER_SCHEMA = schema("broker-pack.schema.json");
const BROKER_EXTRACTION_SCHEMA = schema("broker-extraction-bundle.schema.json");
const BROKER_SOURCE_TABLES_SCHEMA = schema("broker-source-tables.schema.json");

export const INGRESS_SCHEMA_VERSION = "attachment-ingress/1.0";
export const INGRESS_COMPILER_VERSION = "attachment-ingress/1.0";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readJsonFile(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  return value.trim();
}

function resolved(specDir, supplied, label) {
  return path.resolve(specDir, requireString(supplied, label));
}

function parseCsv(bytes, label) {
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quoted) throw new Error(`${label} has an unterminated quoted CSV field.`);
  if (cell !== "" || row.length > 0) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  if (rows.length < 2 || rows[0].filter((value) => value.trim() !== "").length === 0) {
    throw new Error(`${label} is not a usable header-and-rows CSV attachment.`);
  }
  return { format: "csv", header: rows[0], row_count: rows.length - 1, table_sha256: hashValue(rows) };
}

function inspectRawFormat(bytes, format, mediaType, label) {
  if (format === "json") {
    try { JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
    return { format: "json" };
  }
  if (format === "csv") return parseCsv(bytes, label);
  if (format === "xlsx") {
    if (!XLSX_MEDIA.has(String(mediaType).toLowerCase())) {
      throw new Error(`${label} declares XLSX but media_type is not an XLSX media type.`);
    }
    if (bytes.length < 4 || bytes.subarray(0, 2).toString("ascii") !== "PK") {
      throw new Error(`${label} is not an XLSX/OOXML zip attachment.`);
    }
    // XLSX is deliberately an adapter seam: sheet selection, headings and units
    // are issuer/export specific. We prove the raw package and require a separate
    // normalized JSON artifact rather than guessing a vendor layout.
    return { format: "xlsx", package_sha256: sha256(bytes), byte_length: bytes.length };
  }
  if (["pdf", "docx", "text", "image"].includes(format)) {
    return { format, byte_length: bytes.length };
  }
  throw new Error(`${label} uses unsupported adapter format ${JSON.stringify(format)}.`);
}

function validateNormalised(value, domain, label) {
  const active = domain === "factset_dcs" ? DCS_SCHEMA : BROKER_SCHEMA;
  const errors = validateJsonSchema(value, active);
  if (errors.length > 0) throw new Error(`${label} does not meet its normalized contract: ${errors[0]}`);
}

function sourceKindAllowed(domain, kind) {
  if (domain === "factset_dcs") return kind === "user_factset_export";
  if (domain === "broker_pack") return kind === "user_broker_research";
  return [
    "company_annual_report", "company_interim_update", "company_debt_document",
    "company_transaction_announcement", "prior_case", "user_answer",
  ].includes(kind);
}

async function compileAttachment({ descriptor, sourceById, specDir, evidence }) {
  const attachmentId = requireString(descriptor.attachment_id, "attachment_id");
  const sourceIds = Array.isArray(descriptor.source_ids) ? descriptor.source_ids.map(String) : [];
  if (sourceIds.length === 0) throw new Error(`Attachment ${attachmentId} must name at least one source_id.`);
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error(`Attachment ${attachmentId} repeats a source_id.`);
  const adapter = descriptor.adapter;
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) throw new Error(`Attachment ${attachmentId} must declare an adapter.`);
  const domain = requireString(adapter.domain, `Attachment ${attachmentId}.adapter.domain`);
  if (!["factset_dcs", "broker_pack", "document_extraction"].includes(domain)) {
    throw new Error(`Attachment ${attachmentId} has unsupported adapter domain ${domain}.`);
  }
  const format = requireString(adapter.format, `Attachment ${attachmentId}.adapter.format`).toLowerCase();
  const rawPath = resolved(specDir, descriptor.path, `Attachment ${attachmentId}.path`);
  const raw = await fs.readFile(rawPath);
  const rawSha256 = sha256(raw);
  if (descriptor.expected_sha256 && descriptor.expected_sha256 !== rawSha256) {
    throw new Error(`Attachment ${attachmentId} expected_sha256 does not match its bytes.`);
  }
  const rawShape = inspectRawFormat(raw, format, descriptor.media_type, `Attachment ${attachmentId}`);
  for (const sourceId of sourceIds) {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`Attachment ${attachmentId} names unknown source_id ${sourceId}.`);
    if (!sourceKindAllowed(domain, source.kind)) {
      throw new Error(`Attachment ${attachmentId} domain ${domain} cannot bind source ${sourceId} of kind ${source.kind}.`);
    }
  }

  let normalized = null;
  let normalizedArtifact = null;
  if (domain === "document_extraction") {
    const extractionPath = resolved(specDir, adapter.extraction_path, `Attachment ${attachmentId}.adapter.extraction_path`);
    const extractionBytes = await fs.readFile(extractionPath);
    const extraction = await readJsonFile(extractionPath, `Extraction for attachment ${attachmentId}`);
    if (extraction.attachment_id !== attachmentId || extraction.raw_sha256 !== rawSha256) {
      throw new Error(`Extraction for attachment ${attachmentId} is not bound to the supplied raw bytes.`);
    }
    if (!Array.isArray(extraction.source_ids) || JSON.stringify([...extraction.source_ids].sort()) !== JSON.stringify([...sourceIds].sort())) {
      throw new Error(`Extraction for attachment ${attachmentId} does not bind the declared source IDs.`);
    }
    normalizedArtifact = { path: path.basename(extractionPath), sha256: sha256(extractionBytes), kind: "explicit_extraction" };
  } else {
    const normalizedPath = format === "json" && !adapter.normalized_path
      ? rawPath
      : resolved(specDir, adapter.normalized_path, `Attachment ${attachmentId}.adapter.normalized_path`);
    const normalisedBytes = await fs.readFile(normalizedPath);
    normalized = await readJsonFile(normalizedPath, `Normalized attachment ${attachmentId}`);
    validateNormalised(normalized, domain, `Normalized attachment ${attachmentId}`);
    normalizedArtifact = { path: path.basename(normalizedPath), sha256: sha256(normalisedBytes), kind: "normalized_json" };
    const expected = domain === "factset_dcs" ? evidence.dcs_export : evidence.broker_pack;
    if (canonicalJson(expected) !== canonicalJson(normalized)) {
      throw new Error(`Attachment ${attachmentId}'s normalized facts do not exactly match evidence-run.${domain === "factset_dcs" ? "dcs_export" : "broker_pack"}.`);
    }
  }
  return {
    attachment_id: attachmentId,
    source_ids: sourceIds.sort(),
    file_name: path.basename(rawPath),
    media_type: requireString(descriptor.media_type, `Attachment ${attachmentId}.media_type`),
    byte_length: raw.length,
    raw_sha256: rawSha256,
    adapter: { domain, format, ...(rawShape.table_sha256 ? { table_sha256: rawShape.table_sha256 } : {}) },
    normalized_artifact: normalizedArtifact,
  };
}

export async function compileBrokerEvidence({ declaration, specDir, evidence, sourceAttachment }) {
  if (!declaration) return null;
  if (typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new Error("broker_evidence must be an object when supplied.");
  }
  const artifact = async (field, label) => {
    const artifactPath = resolved(specDir, declaration[field], `broker_evidence.${field}`);
    const bytes = await fs.readFile(artifactPath);
    return {
      path: artifactPath,
      bytes,
      sha256: sha256(bytes),
      json: await readJsonFile(artifactPath, label),
    };
  };
  const extraction = await artifact(
    "extraction_bundle_path",
    "Broker extraction bundle",
  );
  const sourceTables = await artifact(
    "source_tables_path",
    "Broker source tables",
  );
  const crosswalk = await artifact("crosswalk_path", "Broker crosswalk");
  const receipt = await artifact(
    "crosswalk_receipt_path",
    "Broker crosswalk receipt",
  );
  const extractionErrors = validateJsonSchema(
    extraction.json,
    BROKER_EXTRACTION_SCHEMA,
  );
  if (extractionErrors.length > 0) {
    throw new Error(
      `Broker extraction bundle fails its contract: ${extractionErrors[0]}`,
    );
  }
  if (extraction.json.gate_status !== "PASS") {
    throw new Error(
      `Broker extraction bundle is ${extraction.json.gate_status}, not PASS.`,
    );
  }
  const sourceTableErrors = validateJsonSchema(
    sourceTables.json,
    BROKER_SOURCE_TABLES_SCHEMA,
  );
  if (sourceTableErrors.length > 0) {
    throw new Error(
      `Broker source tables fail their contract: ${sourceTableErrors[0]}`,
    );
  }
  if (
    crosswalk.json.schema_version !== "broker-crosswalk/1.0" ||
    receipt.json.schema_version !== "broker-crosswalk-receipt/1.0" ||
    receipt.json.status !== "PASS"
  ) {
    throw new Error("Broker crosswalk or its receipt is not a supported PASS artifact.");
  }
  const runIds = new Set([
    extraction.json.run_id,
    sourceTables.json.run_id,
    crosswalk.json.run_id,
    receipt.json.run_id,
  ]);
  if (runIds.size !== 1) {
    throw new Error("Broker extraction, source tables, crosswalk and receipt do not share one run_id.");
  }
  if (
    receipt.json.bundle_sha256 !== extraction.sha256 ||
    receipt.json.crosswalk_sha256 !== crosswalk.sha256
  ) {
    throw new Error("Broker crosswalk receipt is not hash-bound to the supplied bundle and crosswalk.");
  }

  const packHouses = new Map(
    (evidence.broker_pack?.houses ?? []).map((house) => [house.house_id, house]),
  );
  const extractedByHouse = new Map(
    (extraction.json.documents ?? []).map((document) => [document.house_id, document]),
  );
  for (const house of sourceTables.json.houses ?? []) {
    const packHouse = packHouses.get(house.house_id);
    const extracted = extractedByHouse.get(house.house_id);
    if (!packHouse || packHouse.house_name !== house.house_name) {
      throw new Error(
        `Broker source-table house ${house.house_id} does not match the normalized broker pack.`,
      );
    }
    const source = (evidence.source_inventory ?? []).find(
      (entry) => entry.source_id === house.source_id,
    );
    const attachment = sourceAttachment.get(house.source_id);
    if (
      !source ||
      source.kind !== "user_broker_research" ||
      !attachment ||
      !extracted ||
      extracted.source_id !== house.source_id ||
      extracted.raw_sha256 !== house.content_sha256 ||
      house.content_sha256 !== attachment.raw_sha256 ||
      house.file_name !== attachment.file_name ||
      house.published_date !== packHouse.published_date ||
      source.text_extractable !== packHouse.document?.text_extractable ||
      packHouse.document?.extraction_evidence_sha256 !== extraction.sha256
    ) {
      throw new Error(
        `Broker source-table evidence for ${house.house_name} is not bound to its raw attachment and normalized house metadata.`,
      );
    }
  }
  if (sourceTables.json.houses.length !== packHouses.size) {
    throw new Error("Broker source-table evidence does not cover every normalized broker house exactly once.");
  }
  if (extractedByHouse.size !== packHouses.size) {
    throw new Error("Broker extraction bundle does not cover every normalized broker house exactly once.");
  }
  evidence.broker_source_tables = sourceTables.json;
  evidence.broker_crosswalk_receipt = receipt.json;
  evidence.model_case.broker_pack.raw_tables = structuredClone(
    sourceTables.json.houses,
  );
  evidence.model_case.broker_pack.source_mappings = structuredClone(
    receipt.json.mappings,
  );
  return {
    extraction_bundle_sha256: extraction.sha256,
    source_tables_sha256: sourceTables.sha256,
    crosswalk_sha256: crosswalk.sha256,
    crosswalk_receipt_sha256: receipt.sha256,
  };
}

export async function compileAttachmentIngress({ specPath }) {
  const absoluteSpec = path.resolve(specPath);
  const specDir = path.dirname(absoluteSpec);
  const spec = await readJsonFile(absoluteSpec, "Ingress spec");
  if (spec.schema_version !== INGRESS_SCHEMA_VERSION) throw new Error("Unsupported attachment ingress spec.");
  const evidencePath = resolved(specDir, spec.evidence_run_path, "evidence_run_path");
  const evidence = await readJsonFile(evidencePath, "Evidence-run template");
  if (!Array.isArray(spec.attachments) || spec.attachments.length === 0) throw new Error("Ingress spec must include attachments.");
  const sourceById = new Map((evidence.source_inventory ?? []).map((source) => [source.source_id, source]));
  if (sourceById.size !== (evidence.source_inventory ?? []).length) throw new Error("Evidence-run template has duplicate source ids.");
  const manifest = [];
  const attachmentIds = new Set();
  const sourceAttachment = new Map();
  for (const descriptor of spec.attachments) {
    const entry = await compileAttachment({ descriptor, sourceById, specDir, evidence });
    if (attachmentIds.has(entry.attachment_id)) throw new Error(`Duplicate attachment_id ${entry.attachment_id}.`);
    attachmentIds.add(entry.attachment_id);
    for (const sourceId of entry.source_ids) {
      if (sourceAttachment.has(sourceId)) throw new Error(`Source ${sourceId} is bound to more than one raw attachment.`);
      sourceAttachment.set(sourceId, entry);
    }
    manifest.push(entry);
  }
  for (const source of evidence.source_inventory ?? []) {
    const entry = sourceAttachment.get(source.source_id);
    if (!entry) throw new Error(`Inventoried source ${source.source_id} has no raw attachment binding.`);
    source.attachment_id = entry.attachment_id;
    source.content_sha256 = entry.raw_sha256;
  }
  const brokerEvidence = await compileBrokerEvidence({
    declaration: spec.broker_evidence,
    specDir,
    evidence,
    sourceAttachment,
  });

  // The evidence template is intentionally allowed to carry placeholder source
  // hashes.  Bind every face-statement authority to the raw bytes computed by
  // this compiler, then recompute its ordered-row digest before validation.
  for (const section of FACE_STATEMENT_SECTIONS) {
    for (const statement of evidence.filings?.face_statement_manifests?.[section] ?? []) {
      const entry = sourceAttachment.get(statement.source_id);
      if (!entry) {
        throw new Error(`Face-statement manifest ${section}.${statement.source_id} has no raw attachment binding.`);
      }
      statement.document_sha256 = entry.raw_sha256;
      statement.rows_sha256 = faceStatementManifestDigest(statement);
    }
  }

  // A document extraction artifact is not merely proof that some text was
  // read.  When its source owns a selected face statement, it must contain the
  // exact manifest that enters evidence-run; otherwise a caller could prepare
  // a complete extraction artifact but pass a shorter evidence ledger.
  for (const descriptor of spec.attachments) {
    if (descriptor.adapter?.domain !== "document_extraction") continue;
    const sourceIds = new Set((descriptor.source_ids ?? []).map(String));
    const expected = Object.fromEntries(
      FACE_STATEMENT_SECTIONS.map((section) => [
        section,
        (evidence.filings?.face_statement_manifests?.[section] ?? []).filter(
          (statement) => sourceIds.has(statement.source_id),
        ),
      ]),
    );
    const expectedCount = FACE_STATEMENT_SECTIONS.reduce(
      (count, section) => count + expected[section].length,
      0,
    );
    if (expectedCount === 0) continue;
    const extractionPath = resolved(
      specDir,
      descriptor.adapter.extraction_path,
      `Attachment ${descriptor.attachment_id}.adapter.extraction_path`,
    );
    const extraction = await readJsonFile(
      extractionPath,
      `Extraction for attachment ${descriptor.attachment_id}`,
    );
    for (const section of FACE_STATEMENT_SECTIONS) {
      const actual = (extraction.face_statement_manifests?.[section] ?? []).filter(
        (statement) => sourceIds.has(statement.source_id),
      );
      if (canonicalJson(actual) !== canonicalJson(expected[section])) {
        throw new Error(
          `Extraction for attachment ${descriptor.attachment_id} does not exactly bind the selected ${section} face-statement manifest.`,
        );
      }
    }
  }
  manifest.sort((left, right) => left.attachment_id.localeCompare(right.attachment_id));
  const manifestHash = hashValue(manifest);
  evidence.attachment_manifest = manifest;
  evidence.ingress = {
    schema_version: INGRESS_SCHEMA_VERSION,
    compiler_version: INGRESS_COMPILER_VERSION,
    manifest_sha256: manifestHash,
    ...(brokerEvidence ? { broker_evidence: brokerEvidence } : {}),
  };
  return { evidence, manifest, manifest_sha256: manifestHash };
}
