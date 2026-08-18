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
    rows: (manifest?.rows ?? []).map((row) => ({
      source_line_id: row?.source_line_id ?? null,
      ordinal: row?.ordinal ?? null,
      raw_label: row?.raw_label ?? null,
      values: row?.values ?? null,
      page_or_note: row?.page_or_note ?? null,
      material: row?.material ?? null,
      parent_source_line_id: row?.parent_source_line_id ?? null,
      hierarchy_level: row?.hierarchy_level ?? null,
      is_subtotal: row?.is_subtotal ?? null,
    })),
  });
}

export function flattenFaceStatementManifests(filings, section) {
  return (filings?.face_statement_manifests?.[section] ?? [])
    .flatMap((manifest) =>
      (manifest?.rows ?? []).map((row) => ({ manifest, row })),
    );
}

export default {
  FACE_STATEMENT_SECTIONS,
  faceStatementManifestDigest,
  flattenFaceStatementManifests,
};
