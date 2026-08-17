/**
 * Controlled filing acquisition.
 *
 * This module never searches the web.  It materialises only caller-declared
 * local/runtime files or explicit HTTPS issuer/regulator URLs, binds their raw
 * bytes by SHA-256, and emits the ordinary filings-extraction request consumed
 * by the existing controller.  User-supplied sources outrank every retrieved
 * source for the same section and period.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { validateJsonSchema } from "./json_schema.mjs";
import { canonicalise } from "./run_store.mjs";

const ORIGIN_RANK = Object.freeze({
  user_supplied: 0,
  official_declarative_url: 1,
  runtime_library: 2,
});
const SECTION_NAMES = new Set(["income_statement", "cash_flow", "debt_notes", "issuer_facts"]);
const RESTATEMENT_RANK = Object.freeze({ restated_comparative: 0, as_reported: 1 });

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalise(value))}\n`, "utf8");
}

async function atomicWrite(target, bytes) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function allowedHost(hostname, domains) {
  const host = String(hostname).toLowerCase();
  return domains.some((domain) => {
    const allowed = String(domain).toLowerCase();
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

async function fetchDeclaredUrl(rawUrl, allowedDomains) {
  let current = new URL(rawUrl);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (current.protocol !== "https:" || !allowedHost(current.hostname, allowedDomains)) {
      throw new Error(`Declared filing URL leaves its allowed official domain set: ${current.href}`);
    }
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "Excel-Inflow-Filings/1.0 controlled-evidence-fetch" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Declared filing URL returned redirect ${response.status} without Location.`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Declared filing URL returned HTTP ${response.status}.`);
    return { bytes: Buffer.from(await response.arrayBuffer()), final_url: current.href };
  }
  throw new Error("Declared filing URL exceeded five controlled redirects.");
}

function acquisitionErrors(request) {
  const errors = [];
  if (!["filings-acquisition-request/1.0", "filings-acquisition-request/2.0"].includes(request?.schema_version)) errors.push("wrong schema_version");
  if (request?.schema_version === "filings-acquisition-request/2.0" && !["internal", "user_supplied", "internal_fallback"].includes(request?.source_mode)) errors.push("source_mode is invalid");
  if (!request?.run_id) errors.push("run_id is absent");
  if (!request?.company?.name) errors.push("company.name is absent");
  if (!request?.filing_facts || typeof request.filing_facts !== "object") errors.push("filing_facts is absent");
  if (!Array.isArray(request?.sources) || request.sources.length === 0) errors.push("sources is empty");
  const identities = new Set();
  for (const [index, source] of (request?.sources ?? []).entries()) {
    const label = `sources[${index}]`;
    const identity = `${source?.document_id}|${source?.attachment_id}|${source?.source_id}`;
    if (!source?.document_id || !source?.attachment_id || !source?.source_id) errors.push(`${label} identity is incomplete`);
    if (identities.has(identity)) errors.push(`${label} duplicates ${identity}`);
    identities.add(identity);
    if (!Object.hasOwn(ORIGIN_RANK, source?.origin)) errors.push(`${label}.origin is unsupported`);
    if (source?.origin === "official_declarative_url") {
      if (!String(source?.url ?? "").startsWith("https://")) errors.push(`${label}.url must be explicit HTTPS`);
      if (!source?.publisher_name) errors.push(`${label}.publisher_name is absent`);
      if (!Array.isArray(source?.allowed_domains) || source.allowed_domains.length === 0) errors.push(`${label}.allowed_domains is empty`);
      if (source?.path) errors.push(`${label} cannot carry path and URL`);
    } else if (!source?.path || source?.url) {
      errors.push(`${label} must carry only a local/runtime path`);
    }
    if (!Array.isArray(source?.covered_periods) || source.covered_periods.length === 0) errors.push(`${label}.covered_periods is empty`);
    if (!Array.isArray(source?.section_coverage) || source.section_coverage.some((item) => !SECTION_NAMES.has(item))) {
      errors.push(`${label}.section_coverage is invalid`);
    }
    if (!Object.hasOwn(RESTATEMENT_RANK, source?.restatement_basis)) errors.push(`${label}.restatement_basis is invalid`);
  }
  return errors;
}

function sourceOrder(left, right) {
  return (
    ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin] ||
    String(right.filing_date).localeCompare(String(left.filing_date)) ||
    RESTATEMENT_RANK[left.restatement_basis] - RESTATEMENT_RANK[right.restatement_basis] ||
    String(left.document_id).localeCompare(String(right.document_id))
  );
}

function extensionFor(source) {
  const declaredPath = source.path ?? new URL(source.url).pathname;
  const suffix = path.extname(declaredPath).toLowerCase();
  if (suffix && /^\.[a-z0-9]{1,8}$/.test(suffix)) return suffix;
  if (source.media_type === "application/pdf") return ".pdf";
  return ".bin";
}

export async function acquireFilingsSources({
  request,
  requestPath,
  outDir,
  extractionRequestSchema,
  sourceRegistrySchema = null,
}) {
  const errors = acquisitionErrors(request);
  if (errors.length > 0) throw new Error(`Filings acquisition request is invalid: ${errors.join("; ")}`);
  const root = path.resolve(outDir);
  const requestBase = path.dirname(path.resolve(requestPath));
  const sourceMode = request.schema_version === "filings-acquisition-request/2.0" ? request.source_mode : "user_supplied";
  const eligibleOrigins = sourceMode === "user_supplied" ? new Set(["user_supplied"]) : sourceMode === "internal" ? new Set(["official_declarative_url", "runtime_library"]) : new Set(["user_supplied"]);
  if (sourceMode === "internal_fallback" && !request.fallback_reason) throw new Error("internal_fallback requires fallback_reason");
  const selectedSources = request.sources.filter((source) => eligibleOrigins.has(source.origin));
  const selectedOrigins = new Set(selectedSources.map((source) => source.origin));
  if (selectedSources.length === 0) throw new Error(`No filing sources are eligible under source_mode=${sourceMode}`);
  const excludedDocumentIds = request.sources.filter((source) => !eligibleOrigins.has(source.origin)).map((source) => source.document_id).sort();
  const materialised = [];
  for (const declaration of selectedSources) {
    let bytes;
    let finalUrl = null;
    let declaredPath = null;
    if (declaration.origin === "official_declarative_url") {
      const fetched = await fetchDeclaredUrl(declaration.url, declaration.allowed_domains);
      bytes = fetched.bytes;
      finalUrl = fetched.final_url;
    } else {
      declaredPath = path.resolve(requestBase, declaration.path);
      bytes = await fs.readFile(declaredPath);
    }
    const digest = hashBytes(bytes);
    if (declaration.expected_sha256 && declaration.expected_sha256 !== digest) {
      throw new Error(`${declaration.document_id} expected_sha256 does not match acquired bytes.`);
    }
    const objectPath = path.join(root, "objects", `${digest}${extensionFor(declaration)}`);
    try {
      const existing = await fs.readFile(objectPath);
      if (hashBytes(existing) !== digest) throw new Error(`Content-addressed object collision at ${objectPath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await atomicWrite(objectPath, bytes);
    }
    materialised.push({
      ...structuredClone(declaration),
      authority_rank: ORIGIN_RANK[declaration.origin],
      raw_sha256: digest,
      object_path: objectPath,
      ...(declaredPath ? { declared_path: declaredPath } : {}),
      ...(finalUrl ? { final_url: finalUrl } : {}),
    });
  }
  materialised.sort(sourceOrder);
  const filingFacts = structuredClone(request.filing_facts);
  filingFacts.entity_name = request.company.name;
  if (request.company.identifiers) filingFacts.entity_identifiers = structuredClone(request.company.identifiers);
  if (request.company.aliases) filingFacts.entity_aliases = structuredClone(request.company.aliases);
  if (request.company.consolidation_level) filingFacts.consolidation_level = request.company.consolidation_level;
  const extractionRequest = {
    schema_version: "filings-extraction-request/1.0",
    run_id: request.run_id,
    documents: materialised.map((source) => ({
      document_id: source.document_id,
      attachment_id: source.attachment_id,
      source_id: source.source_id,
      path: source.object_path,
      media_type: source.media_type,
      expected_sha256: source.raw_sha256,
      origin: source.origin,
      authority_rank: source.authority_rank,
      filing_kind: source.filing_kind,
      filing_date: source.filing_date,
      period_end: source.period_end ?? null,
      covered_periods: source.covered_periods,
      section_coverage: source.section_coverage,
      restatement_basis: source.restatement_basis,
    })),
    filing_facts: filingFacts,
  };
  const requestErrors = validateJsonSchema(extractionRequest, extractionRequestSchema);
  if (requestErrors.length > 0) {
    throw new Error(`Acquired filings request is invalid: ${requestErrors.join("; ")}`);
  }
  const extractionRequestPath = path.join(root, "filings-extraction-request.json");
  await atomicWrite(extractionRequestPath, canonicalBytes(extractionRequest));
  const registryBody = {
    schema_version: request.schema_version === "filings-acquisition-request/2.0" ? "filings-source-registry/2.0" : "filings-source-registry/1.0",
    run_id: request.run_id,
    company: structuredClone(request.company),
    acquisition_policy: request.schema_version === "filings-acquisition-request/2.0" ? {
      search_performed: false,
      source_mode: sourceMode,
      selected_origins: [...selectedOrigins].sort(),
      excluded_document_ids: excludedDocumentIds,
      official_urls_must_be_declarative: true,
      content_addressed: true,
      ordering: ["user_supplied", "official_declarative_url", "runtime_library"],
    } : {
      search_performed: false,
      user_supplied_precedence: true,
      official_urls_must_be_declarative: true,
      content_addressed: true,
      ordering: ["user_supplied", "official_declarative_url", "runtime_library"],
    },
    documents: Object.fromEntries(materialised.map((source) => [source.attachment_id, {
      document_id: source.document_id,
      source_id: source.source_id,
      origin: source.origin,
      authority_rank: source.authority_rank,
      path: source.object_path,
      raw_sha256: source.raw_sha256,
      filing_kind: source.filing_kind,
      filing_date: source.filing_date,
      period_end: source.period_end ?? null,
      covered_periods: source.covered_periods,
      section_coverage: source.section_coverage,
      restatement_basis: source.restatement_basis,
      ...(source.final_url ? { final_url: source.final_url } : {}),
    }])),
    extraction_request_sha256: hashBytes(await fs.readFile(extractionRequestPath)),
  };
  const registry = { ...registryBody, registry_sha256: hashBytes(canonicalBytes(registryBody)) };
  if (sourceRegistrySchema) {
    const registryErrors = validateJsonSchema(registry, sourceRegistrySchema);
    if (registryErrors.length > 0) {
      throw new Error(`Filings source registry is invalid: ${registryErrors.join("; ")}`);
    }
  }
  const registryPath = path.join(root, "filings-source-registry.json");
  await atomicWrite(registryPath, canonicalBytes(registry));
  return { extractionRequest, extractionRequestPath, registry, registryPath };
}

export default { acquireFilingsSources };
