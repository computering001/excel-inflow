import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { validateJsonSchema } from "./json_schema.mjs";
import { canonicalJson, hashValue } from "./run_store.mjs";

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
  if (["pdf", "docx", "text"].includes(format)) {
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
  manifest.sort((left, right) => left.attachment_id.localeCompare(right.attachment_id));
  const manifestHash = hashValue(manifest);
  evidence.attachment_manifest = manifest;
  evidence.ingress = {
    schema_version: INGRESS_SCHEMA_VERSION,
    compiler_version: INGRESS_COMPILER_VERSION,
    manifest_sha256: manifestHash,
  };
  return { evidence, manifest, manifest_sha256: manifestHash };
}
