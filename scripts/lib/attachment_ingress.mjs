import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { validateJsonSchema } from "./json_schema.mjs";
import { canonicalise, canonicalJson, hashValue } from "./run_store.mjs";
import {
  FACE_STATEMENT_SECTIONS,
  faceStatementManifestDigest,
} from "./face_statement_manifest.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const execFileAsync = promisify(execFile);
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
const BROKER_CROSSWALK_SCHEMA = schema("broker-crosswalk.schema.json");
const BROKER_CROSSWALK_RECEIPT_SCHEMA = schema("broker-crosswalk-receipt.schema.json");
const BROKER_SOURCE_TABLES_SCHEMA = schema("broker-source-tables.schema.json");
const BROKER_SEMANTIC_REPORT_SCHEMA = schema("broker-semantic-verification-report.schema.json");
const BROKER_CANDIDATE_MANIFEST_SCHEMA = schema("broker-candidate-manifest.schema.json");
const BROKER_SURFACE_CENSUS_SCHEMA = schema("broker-surface-census.schema.json");
const DCS_SOURCE_TABLES_SCHEMA = schema("dcs-source-tables-v1.schema.json");
const DCS_CANDIDATE_MANIFEST_SCHEMA = schema("dcs-candidate-manifest-v1.schema.json");
const DCS_CROSSWALK_SCHEMA = schema("dcs-crosswalk-v1.schema.json");
const DCS_PROJECTION_SCHEMA = schema("dcs-projection-v1.schema.json");
const DCS_EVIDENCE_RECEIPT_SCHEMA = schema("dcs-evidence-receipt-v1.schema.json");
const DCS_INDEPENDENT_REPORT_SCHEMA = schema("dcs-independent-verification-v1.schema.json");

export const INGRESS_SCHEMA_VERSION = "attachment-ingress/1.0";
export const INGRESS_COMPILER_VERSION = "attachment-ingress/1.0";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalCompactSha256(value) {
  return sha256(Buffer.from(`${JSON.stringify(canonicalise(value))}\n`, "utf8"));
}

async function rerunPythonVerifier(scriptPath, argv, supplied, label) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "excel-inflow-independent-verifier-"),
  );
  const output = path.join(temporary, "report.json");
  try {
    await execFileAsync("python3", [scriptPath, ...argv, "--out", output], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const regenerated = await readJsonFile(output, `${label} regenerated report`);
    if (canonicalJson(regenerated) !== canonicalJson(supplied)) {
      throw new Error(
        `${label} does not equal a fresh run of the shipped independent verifier.`,
      );
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function canonicalPayloadSha256(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalise(value)), "utf8"));
}

/**
 * Project the lossless broker-page inventory onto the values-only workbook
 * evidence sheets.  The run artifact retains every reviewed table; the model
 * case carries only tables explicitly dispositioned `analytical_table`.
 * House metadata is retained even when a house has no presentable table so the
 * projection cannot silently remove a supplied broker document.
 */
function brokerWorkbookTableProjection(sourceTables) {
  return (sourceTables?.houses ?? []).map((house) => ({
    ...structuredClone(house),
    tables: (house.tables ?? [])
      .filter((table) => table.workbook_presentation === "analytical_table")
      .map((table) => structuredClone(table)),
  }));
}

function parseBrokerNumber(value, label) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null || value === undefined) {
    throw new Error(`${label} is not numeric.`);
  }
  const text = String(value).trim();
  const match = text.match(/^\s*(\()?\s*[-+]?[$€£¥]?\s*(\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.(\d+))?\s*(%)?\s*\)?\s*$/);
  if (!match) throw new Error(`${label} is not an unambiguous numeric cell.`);
  const negative = Boolean(match[1]) || text.startsWith("-");
  const cleaned = text.replace(/[$€£¥,%() ]/g, "");
  let number = Number(cleaned);
  if (!Number.isFinite(number)) throw new Error(`${label} is not finite.`);
  if (negative) number = -Math.abs(number);
  if (match[4]) number /= 100;
  return number;
}

function recomputeBrokerReceipt({ extraction, sourceTables, crosswalk, semanticReport }) {
  const extractedTables = new Map();
  for (const document of extraction.documents ?? []) {
    for (const table of document.tables ?? []) {
      if (extractedTables.has(table.table_id)) {
        throw new Error(`Broker extraction duplicates table_id ${table.table_id}.`);
      }
      extractedTables.set(table.table_id, { house_id: document.house_id, table });
    }
  }
  const sourceTableMap = new Map();
  for (const house of sourceTables.houses ?? []) {
    for (const table of house.tables ?? []) {
      if (sourceTableMap.has(table.table_id)) {
        throw new Error(`Broker source tables duplicate table_id ${table.table_id}.`);
      }
      sourceTableMap.set(table.table_id, { house_id: house.house_id, table });
    }
  }
  if (
    extractedTables.size !== sourceTableMap.size ||
    [...extractedTables.keys()].some((tableId) => !sourceTableMap.has(tableId))
  ) {
    throw new Error("Broker source-table universe does not exactly match the verified extraction tables.");
  }
  for (const [tableId, source] of sourceTableMap) {
    const extracted = extractedTables.get(tableId);
    const scalarRows = (extracted.table.rows ?? []).map((row) =>
      row.map((cell) => cell?.value ?? null),
    );
    if (
      source.house_id !== extracted.house_id ||
      JSON.stringify(canonicalise(source.table.rows ?? [])) !==
        JSON.stringify(canonicalise(scalarRows))
    ) {
      throw new Error(`Broker source table ${tableId} does not reproduce the verified extraction cells.`);
    }
  }

  const mappings = [];
  const mappingIds = new Set();
  for (const [index, mapping] of (crosswalk.mappings ?? []).entries()) {
    if (mappingIds.has(mapping.mapping_id)) {
      throw new Error(`Broker crosswalk duplicates mapping_id ${mapping.mapping_id}.`);
    }
    mappingIds.add(mapping.mapping_id);
    let total = Number(mapping.constant ?? 0);
    const components = [];
    for (const [componentIndex, component] of (mapping.sources ?? []).entries()) {
      const source = sourceTableMap.get(component.table_id);
      const extracted = extractedTables.get(component.table_id);
      if (!source || !extracted || source.house_id !== mapping.house_id) {
        throw new Error(`Broker mapping ${mapping.mapping_id} cites an absent or cross-house table.`);
      }
      const row = Number(component.row);
      const column = Number(component.column);
      const sourceValue = source.table.rows?.[row - 1]?.[column - 1];
      const extractedCell = extracted.table.rows?.[row - 1]?.[column - 1];
      if (
        extractedCell === undefined ||
        JSON.stringify(canonicalise(sourceValue ?? null)) !==
          JSON.stringify(canonicalise(extractedCell.value ?? null))
      ) {
        throw new Error(
          `Broker mapping ${mapping.mapping_id} component ${componentIndex} is detached from its source table cell.`,
        );
      }
      const rawValue = parseBrokerNumber(
        sourceValue,
        `${component.table_id}!R${row}C${column}`,
      );
      const coefficient = Number(component.coefficient ?? 0);
      if (!Number.isFinite(coefficient)) {
        throw new Error(`Broker mapping ${mapping.mapping_id} has a non-finite coefficient.`);
      }
      const contribution = rawValue * coefficient;
      total += contribution;
      components.push({
        table_id: component.table_id,
        row,
        column,
        source_ref: requireString(
          extractedCell.source_ref,
          `Broker mapping ${mapping.mapping_id} source_ref`,
        ),
        raw_value: rawValue,
        coefficient,
        contribution,
      });
    }
    const multiplier = Number(mapping.multiplier ?? 1);
    if (!Number.isFinite(total) || !Number.isFinite(multiplier)) {
      throw new Error(`Broker mapping ${mapping.mapping_id} has a non-finite transform.`);
    }
    total *= multiplier;
    mappings.push({
      mapping_id: mapping.mapping_id,
      house_id: mapping.house_id,
      metric_id: mapping.metric_id,
      definition_id: mapping.definition_id,
      period_index: mapping.period_index,
      components,
      constant: Number(mapping.constant ?? 0),
      multiplier,
      value: total,
      rationale: mapping.rationale,
      review_status: mapping.review_status ?? "reviewed",
    });
  }

  const dispositionCounts = {};
  const coveredCandidateIds = new Set();
  for (const entry of crosswalk.coverage_ledger ?? []) {
    const disposition = String(entry.disposition ?? "");
    dispositionCounts[disposition] = (dispositionCounts[disposition] ?? 0) + 1;
    coveredCandidateIds.add(String(entry.candidate_id ?? ""));
  }
  const manifestCandidates = extraction.candidate_manifest?.candidates ?? [];
  const manifestCandidateIds = new Set(
    manifestCandidates.map((entry) =>
      String(entry.candidate_id ?? ""),
    ),
  );
  const candidateCount = manifestCandidates.length;
  const unresolvedCandidateCount = [...manifestCandidateIds].filter(
    (candidateId) => !coveredCandidateIds.has(candidateId),
  ).length;
  const coverageLedger = (crosswalk.coverage_ledger ?? []).map((entry) => {
    const source = sourceTableMap.get(entry.table_id);
    const extracted = extractedTables.get(entry.table_id);
    if (!source || !extracted || source.house_id !== entry.house_id) {
      throw new Error(`Broker coverage candidate ${entry.candidate_id} cites an absent or cross-house table.`);
    }
    return {
      ...structuredClone(entry),
      source_cells: (entry.source_cells ?? []).map((reference) => {
        const row = Number(reference.row);
        const column = Number(reference.column);
        const sourceValue = source.table.rows?.[row - 1]?.[column - 1];
        const extractedCell = extracted.table.rows?.[row - 1]?.[column - 1];
        if (
          extractedCell === undefined ||
          JSON.stringify(canonicalise(sourceValue ?? null)) !==
            JSON.stringify(canonicalise(extractedCell.value ?? null))
        ) {
          throw new Error(
            `Broker coverage candidate ${entry.candidate_id} is detached from ${entry.table_id}!R${row}C${column}.`,
          );
        }
        return {
          row,
          column,
          source_ref: requireString(
            extractedCell.source_ref,
            `Broker coverage candidate ${entry.candidate_id} source_ref`,
          ),
          raw_value: sourceValue ?? null,
        };
      }),
    };
  });
  const expectedSummary = {
    table_count: sourceTableMap.size,
    table_review_count: crosswalk.table_reviews?.length ?? 0,
    detected_forecast_candidate_count: candidateCount,
    coverage_entry_count: crosswalk.coverage_ledger?.length ?? 0,
    unresolved_candidate_count: unresolvedCandidateCount,
    semantic_quality_violation_count: Number(semanticReport?.total_violation_count ?? 0),
    candidate_manifest_count: candidateCount,
    candidate_authority: "deterministic_manifest",
    mapping_count: mappings.length,
    derived_mapping_count: crosswalk.derived_mappings?.length ?? 0,
    disposition_counts: Object.fromEntries(
      Object.entries(dispositionCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  return {
    mappings,
    coverageLedger,
    expectedSummary,
    tableReviewsSha256: canonicalPayloadSha256(crosswalk.table_reviews ?? []),
    coverageLedgerSha256: canonicalPayloadSha256(crosswalk.coverage_ledger ?? []),
    crosswalkCanonicalSha256: canonicalPayloadSha256(crosswalk),
  };
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
  const semanticReport = declaration.semantic_verification_path
    ? await artifact(
        "semantic_verification_path",
        "Broker independent semantic verification report",
      )
    : null;
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
  const candidateErrors = validateJsonSchema(
    extraction.json.candidate_manifest,
    BROKER_CANDIDATE_MANIFEST_SCHEMA,
  );
  if (candidateErrors.length > 0) {
    throw new Error(
      `Broker immutable candidate manifest fails its contract: ${candidateErrors[0]}`,
    );
  }
  if (
    extraction.json.candidate_manifest.gate_status !== "PASS" ||
    extraction.json.candidate_manifest.candidates.length === 0 ||
    extraction.json.candidate_manifest.canonical_tables_sha256 !==
      extraction.json.canonical_tables_sha256
  ) {
    throw new Error(
      "Broker candidate manifest is empty, non-PASS or detached from the canonical tables.",
    );
  }
  const artifactRoot = path.resolve(
    requireString(extraction.json.artifact_root, "Broker extraction artifact_root"),
  );
  let censusCount = 0;
  for (const document of extraction.json.documents ?? []) {
    const artifacts = new Map(
      (document.artifacts ?? []).map((entry) => [entry.artifact_id, entry]),
    );
    for (const surface of document.surfaces ?? []) {
      const artifact = artifacts.get(surface.surface_census_artifact_id);
      if (!artifact || artifact.kind !== "surface_census") {
        throw new Error(
          `Broker surface ${surface.surface_id} lacks its independent census artifact.`,
        );
      }
      const censusPath = path.resolve(artifactRoot, artifact.path);
      if (
        censusPath !== artifactRoot &&
        !censusPath.startsWith(`${artifactRoot}${path.sep}`)
      ) {
        throw new Error(
          `Broker surface census path for ${surface.surface_id} escapes artifact_root.`,
        );
      }
      const censusBytes = await fs.readFile(censusPath);
      if (sha256(censusBytes) !== artifact.sha256) {
        throw new Error(
          `Broker surface census hash for ${surface.surface_id} does not match its bytes.`,
        );
      }
      const census = JSON.parse(censusBytes.toString("utf8"));
      const censusErrors = validateJsonSchema(
        census,
        BROKER_SURFACE_CENSUS_SCHEMA,
      );
      if (censusErrors.length > 0) {
        throw new Error(
          `Broker surface census for ${surface.surface_id} fails its contract: ${censusErrors[0]}`,
        );
      }
      if (
        census.document_id !== document.document_id ||
        census.surface_id !== surface.surface_id ||
        census.kind !== surface.kind ||
        census.whole_surface_numeric_token_count !==
          surface.whole_surface_numeric_token_count ||
        canonicalJson(census.source_table_numeric_tokens ?? []) !==
          canonicalJson(surface.source_table_numeric_tokens ?? []) ||
        canonicalJson(census.table_discovery_lanes) !==
          canonicalJson(surface.table_discovery_lanes) ||
        canonicalJson(census.uncovered_numeric_regions) !==
          canonicalJson(surface.uncovered_numeric_regions) ||
        census.material_uncovered_region_count !== 0
      ) {
        throw new Error(
          `Broker surface ${surface.surface_id} is not a zero-uncovered-region, census-bound surface.`,
        );
      }
      censusCount += 1;
    }
  }
  if (
    censusCount !== extraction.json.summary.surface_count ||
    extraction.json.summary.material_uncovered_region_count !== 0
  ) {
    throw new Error(
      "Broker extraction PASS does not cover every surface with a clean independent census.",
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
  const crosswalkErrors = validateJsonSchema(
    crosswalk.json,
    BROKER_CROSSWALK_SCHEMA,
  );
  if (crosswalkErrors.length > 0) {
    throw new Error(
      `Broker crosswalk fails its contract: ${crosswalkErrors[0]}`,
    );
  }
  const receiptErrors = validateJsonSchema(
    receipt.json,
    BROKER_CROSSWALK_RECEIPT_SCHEMA,
  );
  if (receiptErrors.length > 0) {
    throw new Error(
      `Broker crosswalk receipt fails its contract: ${receiptErrors[0]}`,
    );
  }
  const newSemanticContract =
    crosswalk.json.schema_version === "broker-crosswalk/1.2" ||
    extraction.json.candidate_manifest !== undefined;
  const supportedPair =
    (crosswalk.json.schema_version === "broker-crosswalk/1.1" &&
      receipt.json.schema_version === "broker-crosswalk-receipt/1.1") ||
    (crosswalk.json.schema_version === "broker-crosswalk/1.2" &&
      receipt.json.schema_version === "broker-crosswalk-receipt/1.2");
  if (!supportedPair || receipt.json.status !== "PASS") {
    throw new Error("Broker crosswalk or its receipt is not a supported PASS artifact.");
  }
  if (newSemanticContract) {
    if (!semanticReport) {
      throw new Error(
        "Broker candidate-manifest evidence requires an independent semantic verification report.",
      );
    }
    const semanticErrors = validateJsonSchema(
      semanticReport.json,
      BROKER_SEMANTIC_REPORT_SCHEMA,
    );
    if (semanticErrors.length > 0) {
      throw new Error(
        `Broker independent semantic report fails its contract: ${semanticErrors[0]}`,
      );
    }
    if (
      semanticReport.json.status !== "PASS" ||
      semanticReport.json.total_violation_count !== 0 ||
      receipt.json.candidate_manifest_sha256 !==
        semanticReport.json.candidate_manifest_sha256 ||
      receipt.json.independent_semantic_report_sha256 !== semanticReport.sha256
    ) {
      throw new Error(
        "Broker semantic receipt is not independently proven PASS and hash-bound to the immutable candidate manifest.",
      );
    }
    await rerunPythonVerifier(
      path.resolve(HERE, "..", "verify_broker_semantics.py"),
      [extraction.path, crosswalk.path],
      semanticReport.json,
      "Broker semantic report",
    );
  }
  const receiptClosure = recomputeBrokerReceipt({
    extraction: extraction.json,
    sourceTables: sourceTables.json,
    crosswalk: crosswalk.json,
    semanticReport: semanticReport?.json ?? null,
  });
  if (
    receipt.json.mapping_count !== receiptClosure.mappings.length ||
    JSON.stringify(canonicalise(receipt.json.mappings)) !==
      JSON.stringify(canonicalise(receiptClosure.mappings))
  ) {
    throw new Error(
      "Broker crosswalk receipt mappings do not exactly reproduce the supplied crosswalk and source tables.",
    );
  }
  if (
    receipt.json.table_reviews_sha256 !== receiptClosure.tableReviewsSha256 ||
    receipt.json.coverage_ledger_sha256 !== receiptClosure.coverageLedgerSha256
  ) {
    throw new Error(
      "Broker crosswalk receipt review or coverage-ledger hash is stale.",
    );
  }
  if (
    JSON.stringify(canonicalise(receipt.json.coverage_summary)) !==
      JSON.stringify(canonicalise(receiptClosure.expectedSummary))
  ) {
    throw new Error(
      "Broker crosswalk receipt coverage summary does not match the supplied evidence universe.",
    );
  }
  if (
    crosswalk.json.schema_version === "broker-crosswalk/1.2" &&
    JSON.stringify(canonicalise(receipt.json.coverage_ledger)) !==
      JSON.stringify(canonicalise(receiptClosure.coverageLedger))
  ) {
    throw new Error(
      "Broker crosswalk receipt coverage ledger does not exactly reproduce the reviewed source evidence.",
    );
  }
  if (
    JSON.stringify(canonicalise(receipt.json.derived_mappings ?? [])) !==
      JSON.stringify(canonicalise(crosswalk.json.derived_mappings ?? []))
  ) {
    throw new Error(
      "Broker crosswalk receipt derived mappings do not exactly reproduce the crosswalk.",
    );
  }
  if (
    newSemanticContract &&
    (
      receipt.json.crosswalk_canonical_sha256 !==
        receiptClosure.crosswalkCanonicalSha256 ||
      semanticReport.json.crosswalk_sha256 !==
        receiptClosure.crosswalkCanonicalSha256 ||
      receipt.json.independent_semantic_report_sha256 !== semanticReport.sha256
    )
  ) {
    throw new Error(
      "Broker semantic receipt, crosswalk and independent report do not form one canonical hash closure.",
    );
  }
  if (
    receipt.json.coverage_summary?.unresolved_candidate_count !== 0 ||
    receipt.json.coverage_summary?.semantic_quality_violation_count !== 0 ||
    receipt.json.coverage_summary?.table_count !==
      receipt.json.coverage_summary?.table_review_count ||
    !Array.isArray(receipt.json.coverage_ledger) ||
    receipt.json.coverage_ledger.length === 0
  ) {
    throw new Error(
      "Broker crosswalk PASS receipt lacks complete, zero-unresolved semantic coverage evidence.",
    );
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
  if (semanticReport) {
    evidence.broker_semantic_verification = semanticReport.json;
  }
  const workbookTables = brokerWorkbookTableProjection(sourceTables.json);
  const workbookTableIds = new Set(
    workbookTables.flatMap((house) =>
      (house.tables ?? []).map((table) => table.table_id),
    ),
  );
  for (const mapping of receipt.json.mappings ?? []) {
    for (const component of mapping.components ?? []) {
      if (!workbookTableIds.has(component.table_id)) {
        throw new Error(
          `Broker mapping ${mapping.mapping_id ?? `${mapping.house_id}.${mapping.metric_id}.${mapping.period_index}`} uses ${component.table_id}, but that table is not dispositioned analytical_table for workbook presentation.`,
        );
      }
    }
  }
  evidence.model_case.broker_pack.raw_tables = workbookTables;
  evidence.model_case.broker_pack.source_mappings = structuredClone(
    receipt.json.mappings,
  );
  return {
    extraction_bundle_sha256: extraction.sha256,
    source_tables_sha256: sourceTables.sha256,
    crosswalk_sha256: crosswalk.sha256,
    crosswalk_receipt_sha256: receipt.sha256,
    ...(semanticReport
      ? { semantic_verification_sha256: semanticReport.sha256 }
      : {}),
  };
}

export async function compileDcsEvidence({
  declaration,
  specDir,
  evidence,
  sourceAttachment,
}) {
  if (!declaration) return null;
  if (typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new Error("dcs_evidence must be an object when supplied.");
  }
  const artifact = async (field, label) => {
    const artifactPath = resolved(specDir, declaration[field], `dcs_evidence.${field}`);
    const bytes = await fs.readFile(artifactPath);
    return {
      path: artifactPath,
      bytes,
      sha256: sha256(bytes),
      json: await readJsonFile(artifactPath, label),
    };
  };
  const sourceTables = await artifact("source_tables_path", "DCS source tables");
  const manifest = await artifact("candidate_manifest_path", "DCS candidate manifest");
  const crosswalk = await artifact("crosswalk_path", "DCS crosswalk");
  const projection = await artifact("projection_path", "DCS projection");
  const receipt = await artifact("evidence_receipt_path", "DCS evidence receipt");
  const independent = await artifact(
    "independent_verification_path",
    "DCS independent verification report",
  );

  for (const [label, artifactValue, contract] of [
    ["DCS source tables", sourceTables, DCS_SOURCE_TABLES_SCHEMA],
    ["DCS candidate manifest", manifest, DCS_CANDIDATE_MANIFEST_SCHEMA],
    ["DCS crosswalk", crosswalk, DCS_CROSSWALK_SCHEMA],
    ["DCS projection", projection, DCS_PROJECTION_SCHEMA],
    ["DCS evidence receipt", receipt, DCS_EVIDENCE_RECEIPT_SCHEMA],
    ["DCS independent verification", independent, DCS_INDEPENDENT_REPORT_SCHEMA],
  ]) {
    const errors = validateJsonSchema(artifactValue.json, contract);
    if (errors.length > 0) {
      throw new Error(`${label} fails its contract: ${errors[0]}`);
    }
  }
  await rerunPythonVerifier(
    path.resolve(HERE, "..", "verify", "dcs_evidence_oracle.py"),
    [
      "--source", sourceTables.path,
      "--manifest", manifest.path,
      "--crosswalk", crosswalk.path,
      "--projection", projection.path,
      "--receipt", receipt.path,
    ],
    independent.json,
    "DCS independent verification report",
  );
  if (
    receipt.json.status !== "PASS" ||
    receipt.json.counts?.violations !== 0 ||
    receipt.json.counts?.unowned_cells !== 0 ||
    receipt.json.counts?.double_owned_cells !== 0 ||
    independent.json.status !== "PASS" ||
    independent.json.counts?.violations !== 0
  ) {
    throw new Error(
      "DCS evidence is not a zero-violation, zero-unowned-cell PASS under both the compiler and independent verifier.",
    );
  }

  const canonicalHashes = {
    source_tables_sha256: canonicalCompactSha256(sourceTables.json),
    candidate_manifest_sha256: canonicalCompactSha256(manifest.json),
    crosswalk_sha256: canonicalCompactSha256(crosswalk.json),
    projection_sha256: canonicalCompactSha256(projection.json),
  };
  for (const [field, expected] of Object.entries(canonicalHashes)) {
    if (receipt.json[field] !== expected) {
      throw new Error(`DCS evidence receipt ${field} is not bound to the supplied artifact.`);
    }
  }
  if (
    projection.json.source_tables_sha256 !== canonicalHashes.source_tables_sha256 ||
    projection.json.candidate_manifest_sha256 !== canonicalHashes.candidate_manifest_sha256 ||
    projection.json.crosswalk_sha256 !== canonicalHashes.crosswalk_sha256
  ) {
    throw new Error("DCS projection is not bound to the supplied source, manifest and crosswalk.");
  }

  const independentHashes = independent.json.artifact_hashes ?? {};
  for (const [field, actual] of [
    ["source", sourceTables.sha256],
    ["manifest", manifest.sha256],
    ["crosswalk", crosswalk.sha256],
    ["projection", projection.sha256],
    ["receipt", receipt.sha256],
  ]) {
    if (independentHashes[field] !== actual) {
      throw new Error(`DCS independent verifier is not byte-bound to ${field}.`);
    }
  }

  const dcsAttachments = [
    ...new Map(
      [...sourceAttachment.values()]
        .filter((entry) => entry.adapter?.domain === "factset_dcs")
        .map((entry) => [entry.attachment_id, entry]),
    ).values(),
  ];
  if (dcsAttachments.length !== 1) {
    throw new Error(
      `DCS evidence requires exactly one raw FactSet DCS attachment; found ${dcsAttachments.length}.`,
    );
  }
  const rawAttachment = dcsAttachments[0];
  if (
    sourceTables.json.source?.sha256 !== rawAttachment.raw_sha256 ||
    projection.json.source_sha256 !== rawAttachment.raw_sha256 ||
    receipt.json.source_sha256 !== rawAttachment.raw_sha256 ||
    independent.json.source_sha256 !== rawAttachment.raw_sha256
  ) {
    throw new Error("DCS evidence artifacts are not bound to the supplied raw export bytes.");
  }
  const projectionCompatibilityView = structuredClone(projection.json.dcs_export);
  const normalizedByInstrument = new Map(
    (evidence.dcs_export?.instruments ?? []).map((instrument) => [
      instrument.instrument_id,
      instrument,
    ]),
  );
  for (const instrument of projectionCompatibilityView.instruments ?? []) {
    delete instrument.maturity_source_value;
    delete instrument.maturity_timing_convention;
    delete instrument.pricing_treatment;
    delete instrument.pricing_treatment_reason;
    if (!Object.hasOwn(normalizedByInstrument.get(instrument.instrument_id) ?? {}, "maturity_treatment")) {
      delete instrument.maturity_treatment;
    }
  }
  if (
    canonicalJson(projection.json.dcs_export) !== canonicalJson(evidence.dcs_export) &&
    canonicalJson(projectionCompatibilityView) !== canonicalJson(evidence.dcs_export)
  ) {
    throw new Error("DCS projection does not exactly reproduce evidence-run.dcs_export.");
  }
  if (
    projection.json.instrument_authority_contract_version !== "dcs_evidence_v1" ||
    !Array.isArray(projection.json.term_authorities) ||
    projection.json.term_authorities.length === 0
  ) {
    throw new Error("DCS projection lacks the field-level dcs_evidence_v1 authority contract.");
  }

  evidence.dcs_source_tables = sourceTables.json;
  evidence.dcs_candidate_manifest = manifest.json;
  evidence.dcs_crosswalk = crosswalk.json;
  evidence.dcs_projection = projection.json;
  evidence.dcs_export = structuredClone(projection.json.dcs_export);
  evidence.dcs_evidence_receipt = receipt.json;
  evidence.dcs_independent_verification = independent.json;
  evidence.model_case.instrument_authority_contract_version = "dcs_evidence_v1";
  evidence.model_case.instrument_term_authorities = structuredClone(
    projection.json.term_authorities,
  );
  const modelInstruments = new Map(
    (evidence.model_case.instruments ?? []).map((instrument) => [
      instrument.instrument_id,
      instrument,
    ]),
  );
  for (const projected of projection.json.dcs_export.instruments ?? []) {
    const instrument = modelInstruments.get(projected.instrument_id);
    if (!instrument) continue;
    instrument.maturity_date = projected.maturity_date;
    instrument.maturity_precision = projected.maturity_precision;
    instrument.maturity_source_value = projected.maturity_source_value;
    instrument.maturity_timing_convention = projected.maturity_timing_convention;
    instrument.maturity_treatment = projected.maturity_treatment;
    instrument.pricing_treatment = projected.pricing_treatment ?? "source_terms";
    instrument.pricing_treatment_reason = projected.pricing_treatment_reason;
    if (projected.rate_type === "unpriced") {
      instrument.rate_type = "unpriced";
      delete instrument.coupon_or_all_in_rate;
      delete instrument.benchmark;
      delete instrument.benchmark_rate;
      delete instrument.spread_bps;
      if (projected.instrument_type === "rcf" && evidence.model_case.rcf_policy) {
        evidence.model_case.rcf_policy.commitment_fee_convention = "captured_in_residual";
        evidence.model_case.rcf_policy.commitment_fee_value = 0;
      }
    }
  }
  return {
    source_tables_sha256: sourceTables.sha256,
    candidate_manifest_sha256: manifest.sha256,
    crosswalk_sha256: crosswalk.sha256,
    projection_sha256: projection.sha256,
    evidence_receipt_sha256: receipt.sha256,
    independent_verification_sha256: independent.sha256,
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
  const hasRawDcsAttachment = [...sourceAttachment.values()].some(
    (entry) => entry.adapter?.domain === "factset_dcs",
  );
  if (hasRawDcsAttachment && !spec.dcs_evidence) {
    throw new Error(
      "A raw FactSet DCS attachment requires lossless dcs_evidence; a separately normalized JSON file is not proof of source fidelity.",
    );
  }
  const dcsEvidence = await compileDcsEvidence({
    declaration: spec.dcs_evidence,
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
    ...(dcsEvidence ? { dcs_evidence: dcsEvidence } : {}),
  };
  return { evidence, manifest, manifest_sha256: manifestHash };
}
