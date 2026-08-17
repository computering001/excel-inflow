import { hashValue } from "./run_store.mjs";

export const FACE_STATEMENT_SECTIONS = Object.freeze([
  "income_statement",
  "cash_flow",
]);

/**
 * Hash the complete ordered face-statement extraction without hashing the
 * digest field itself.  The source document hash is part of the projection so
 * identical rows extracted from different bytes never share an authority.
 */
export function faceStatementManifestDigest(manifest) {
  return hashValue({
    schema_version: manifest?.schema_version ?? null,
    statement: manifest?.statement ?? null,
    statement_order: manifest?.statement_order ?? null,
    source_id: manifest?.source_id ?? null,
    document_sha256: manifest?.document_sha256 ?? null,
    page_or_note: manifest?.page_or_note ?? null,
    periods: manifest?.periods ?? null,
    complete_face_statement: manifest?.complete_face_statement ?? null,
    ...(Array.isArray(manifest?.source_pages)
      ? { source_pages: manifest.source_pages }
      : {}),
    ...(manifest?.reporting_currency
      ? { reporting_currency: manifest.reporting_currency }
      : {}),
    ...(manifest?.units ? { units: manifest.units } : {}),
    ...(Array.isArray(manifest?.source_unit_labels)
      ? { source_unit_labels: manifest.source_unit_labels }
      : {}),
    rows: (manifest?.rows ?? []).map((row) => ({
      source_line_id: row?.source_line_id ?? null,
      ordinal: row?.ordinal ?? null,
      raw_label: row?.raw_label ?? null,
      values: row?.values ?? null,
      ...(Array.isArray(row?.value_states)
        ? { value_states: row.value_states }
        : {}),
      ...(row?.structural_role
        ? { structural_role: row.structural_role }
        : {}),
      page_or_note: row?.page_or_note ?? null,
      material: row?.material ?? null,
      parent_source_line_id: row?.parent_source_line_id ?? null,
      hierarchy_level: row?.hierarchy_level ?? null,
      is_subtotal: row?.is_subtotal ?? null,
    })),
  });
}

export const FACE_STATEMENT_MANIFEST_VERSIONS = Object.freeze([
  "face-statement-manifest/1.0",
  "face-statement-manifest/1.1",
]);

const TYPED_VALUE_STATES = new Set([
  "reported_number",
  "reported_zero",
  "reported_dash",
  "reported_blank",
  "not_applicable",
  "unresolved",
]);

function valueStateMatches(value, state) {
  if (state === "reported_number") return Number.isFinite(value) && value !== 0;
  if (state === "reported_zero") return value === 0;
  return value === null;
}

/**
 * Validate the exact manifest contract used by the production filings lane.
 * Version 1.0 remains readable for sealed legacy evidence. Version 1.1 is the
 * only manifest emitted by the current extractor and fails closed unless page
 * continuity, reporting basis, source units and typed cell states are present.
 */
export function filingManifestCustodyErrors({
  manifest,
  document,
  section,
  globalLineIds = new Set(),
  filingFacts,
}) {
  const errors = [];
  const rows = manifest?.rows ?? [];
  const version = manifest?.schema_version;
  const strictCustody = version === "face-statement-manifest/1.1";

  if (!FACE_STATEMENT_MANIFEST_VERSIONS.includes(version)) errors.push(`${section} manifest has the wrong schema version`);
  if (manifest?.statement !== section) errors.push(`${section} manifest declares ${manifest?.statement}`);
  if (manifest?.source_id !== document?.source_id) errors.push(`${section} manifest source_id is detached from ${document?.document_id}`);
  if (manifest?.document_sha256 !== document?.raw_sha256) errors.push(`${section} manifest document hash is detached from ${document?.document_id}`);
  if (manifest?.complete_face_statement !== true) errors.push(`${section} manifest is not marked complete`);
  if (!Array.isArray(manifest?.periods) || manifest.periods.length !== 3) errors.push(`${section} manifest does not carry exactly three periods`);

  const sourcePages = manifest?.source_pages;
  if (strictCustody && (!Array.isArray(sourcePages) || sourcePages.length === 0)) errors.push(`${section} v1.1 manifest omits source_pages`);
  if (Array.isArray(sourcePages)) {
    const orderedPages = [...sourcePages].sort((left, right) => left - right);
    if (
      sourcePages.some((page) => !Number.isInteger(page) || page < 1) ||
      new Set(sourcePages).size !== sourcePages.length ||
      orderedPages.some((page, index) => page !== sourcePages[index]) ||
      orderedPages.some((page, index) => index > 0 && page !== orderedPages[index - 1] + 1)
    ) errors.push(`${section} manifest source_pages are not unique adjacent pages in source order`);
  }

  if (strictCustody && typeof manifest?.reporting_currency !== "string") errors.push(`${section} v1.1 manifest omits reporting_currency`);
  if (manifest?.reporting_currency && manifest.reporting_currency !== filingFacts?.reporting_currency) errors.push(`${section} manifest reporting currency differs from filing_facts`);
  if (strictCustody && typeof manifest?.units !== "string") errors.push(`${section} v1.1 manifest omits units`);
  if (manifest?.units && manifest.units !== filingFacts?.units) errors.push(`${section} manifest units differ from filing_facts`);
  if (strictCustody && !Array.isArray(manifest?.source_unit_labels)) errors.push(`${section} v1.1 manifest omits source_unit_labels`);
  if (Array.isArray(manifest?.source_unit_labels) && manifest.source_unit_labels.some((label) => typeof label !== "string" || label.trim() === "")) errors.push(`${section} manifest has an empty source unit label`);

  if (!Array.isArray(rows) || rows.length === 0 || manifest?.row_count !== rows.length) errors.push(`${section} row_count is not exact`);
  let priorSourcePage = null;
  const representedPages = new Set();
  for (const [index, row] of rows.entries()) {
    if (row?.ordinal !== index + 1) errors.push(`${section}.${row?.source_line_id ?? index} ordinal is not contiguous`);
    if (!row?.source_line_id || globalLineIds.has(row.source_line_id)) errors.push(`${section} repeats or omits source_line_id ${row?.source_line_id ?? ""}`);
    else globalLineIds.add(row.source_line_id);
    if (typeof row?.raw_label !== "string" || row.raw_label.trim() === "") errors.push(`${section}.${row?.source_line_id ?? index} has no exact label`);
    if (!Array.isArray(row?.values) || row.values.length !== 3 || row.values.some((item) => item !== null && !Number.isFinite(item))) errors.push(`${section}.${row?.source_line_id ?? index} does not carry three numeric/null values`);
    if (strictCustody) {
      if (!Array.isArray(row?.value_states) || row.value_states.length !== 3 || row.value_states.some((state) => !TYPED_VALUE_STATES.has(state))) {
        errors.push(`${section}.${row?.source_line_id ?? index} does not carry three typed value states`);
      } else if (Array.isArray(row?.values) && row.values.length === 3 && row.values.some((value, valueIndex) => !valueStateMatches(value, row.value_states[valueIndex]))) {
        errors.push(`${section}.${row?.source_line_id ?? index} value and value-state custody disagree`);
      }
    }
    if (typeof row?.page_or_note !== "string" || row.page_or_note.trim() === "") errors.push(`${section}.${row?.source_line_id ?? index} has no source location`);
    const sourcePage = Number(/^page\s+(\d+)/i.exec(row?.page_or_note ?? "")?.[1] ?? NaN);
    if (strictCustody && !Number.isFinite(sourcePage)) errors.push(`${section}.${row?.source_line_id ?? index} has no typed source page`);
    if (Number.isFinite(sourcePage) && Array.isArray(sourcePages)) {
      representedPages.add(sourcePage);
      if (!sourcePages.includes(sourcePage)) errors.push(`${section}.${row?.source_line_id ?? index} cites a page outside source_pages`);
      if (priorSourcePage !== null && sourcePage < priorSourcePage) errors.push(`${section}.${row?.source_line_id ?? index} reverses source page order`);
      priorSourcePage = sourcePage;
    }
  }
  if (strictCustody && Array.isArray(sourcePages) && sourcePages.some((page) => !representedPages.has(page))) errors.push(`${section} v1.1 manifest has a source page with no retained economic row`);
  if (manifest?.rows_sha256 !== faceStatementManifestDigest(manifest)) errors.push(`${section} rows_sha256 does not bind the ordered rows`);
  return errors;
}

export function flattenFaceStatementManifests(filings, section) {
  return (filings?.face_statement_manifests?.[section] ?? [])
    .flatMap((manifest) =>
      (manifest?.rows ?? []).map((row) => ({ manifest, row })),
    );
}

export default {
  FACE_STATEMENT_SECTIONS,
  FACE_STATEMENT_MANIFEST_VERSIONS,
  faceStatementManifestDigest,
  filingManifestCustodyErrors,
  flattenFaceStatementManifests,
};
