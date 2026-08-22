/**
 * why-this-number digest builder.
 *
 * Projects the sealed selected-authority contract (schema
 * `selected-authority-contract/1.0`) into a compact, reader-facing digest:
 * for every modelled row, which authority rung produced each forecast
 * period's number and which source backs it.
 *
 * The contract is the sole economic writer (see
 * `forecast_candidate_compiler.mjs`), so this digest is pure projection —
 * it never consults the pre-contract candidate ledger or the forecast plan.
 *
 * Unknown fields anywhere in the contract are tolerated and ignored: the
 * digest only reads the fields it names below.
 */

const CONTRACT_SCHEMA_VERSION = "selected-authority-contract/1.0";

/**
 * Extract one period entry from a contract authority's selected state.
 * Returns null when the authority carries no usable per-period selection.
 */
function periodEntry(authority, state) {
  if (!state || typeof state !== "object") return null;
  const period = state.period_end ?? state.period ?? null;
  if (typeof period !== "string" || period.length === 0) return null;
  const rung = state.method ?? authority.method ?? null;
  const sourceId =
    (Array.isArray(state.source_bindings) && state.source_bindings[0]) ||
    (Array.isArray(authority.source_bindings) &&
      authority.source_bindings[0]) ||
    (typeof state.producer_witness?.producer_id === "string"
      ? state.producer_witness.producer_id
      : null) ||
    (typeof authority.producer_witness?.producer_id === "string"
      ? authority.producer_witness.producer_id
      : null) ||
    null;
  const entry = { period, rung, source_id: sourceId };
  // Optional confidence: only emitted when the contract states a number.
  // Unknown/extra fields elsewhere are ignored by construction.
  const confidence =
    state.confidence_score ?? authority.confidence_score ?? undefined;
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    entry.confidence_score = confidence;
  }
  return entry;
}

function rowIdOf(authority) {
  const state = authority?.selected_state;
  if (state && typeof state === "object") {
    const rowId = state.row_id ?? authority.row_id ?? null;
    if (typeof rowId === "string" && rowId.length > 0) return rowId;
  }
  return null;
}

/**
 * Build the why-this-number digest.
 *
 * @param {object} args
 * @param {object|null} args.rowPlan - Build pipeline row plan
 *   (`statement_rows.{income_statement,cash_flow}` with `row_id` /
 *   `row_type`). Used only for ordering and to skip header rows; rows in
 *   the contract that are absent from the plan are still emitted.
 * @param {object} args.authorityContract - Sealed
 *   `selected-authority-contract/1.0` artifact.
 * @returns {Array<{row_id: string, periods: Array<{period: string,
 *   rung: string|null, source_id: string|null, confidence_score?: number}>}>}
 */
export function buildWhyThisNumber({ rowPlan, authorityContract }) {
  if (!authorityContract || typeof authorityContract !== "object") {
    throw new Error(
      "buildWhyThisNumber requires an authorityContract object.",
    );
  }
  if (
    typeof authorityContract.schema_version === "string" &&
    authorityContract.schema_version !== CONTRACT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported contract schema ${authorityContract.schema_version}; expected ${CONTRACT_SCHEMA_VERSION}.`,
    );
  }

  // Plan order: data rows in plan sequence, headers skipped. Absent plan ->
  // empty (contract order then governs).
  const planOrder = [];
  const plannedRows = new Set();
  for (const section of ["income_statement", "cash_flow"]) {
    for (const definition of rowPlan?.statement_rows?.[section] ?? []) {
      if (definition?.row_type === "header") continue;
      if (typeof definition?.row_id !== "string") continue;
      if (plannedRows.has(definition.row_id)) continue;
      plannedRows.add(definition.row_id);
      planOrder.push(definition.row_id);
    }
  }

  // Group contract authorities by row, preserving contract order within a
  // row and sorting each row's periods by forecast_index when present.
  const periodsByRow = new Map();
  for (const authority of authorityContract.authorities ?? []) {
    if (!authority || typeof authority !== "object") continue;
    const rowId = rowIdOf(authority);
    if (!rowId) continue;
    const entry = periodEntry(authority, authority.selected_state);
    if (!entry) continue;
    if (!periodsByRow.has(rowId)) periodsByRow.set(rowId, []);
    periodsByRow.get(rowId).push({
      forecastIndex:
        typeof authority.selected_state.forecast_index === "number"
          ? authority.selected_state.forecast_index
          : Number.MAX_SAFE_INTEGER,
      entry,
    });
  }
  for (const entries of periodsByRow.values()) {
    entries.sort((a, b) => a.forecastIndex - b.forecastIndex);
  }

  const digest = [];
  const emitted = new Set();
  for (const rowId of planOrder) {
    if (!periodsByRow.has(rowId)) continue;
    emitted.add(rowId);
    digest.push({
      row_id: rowId,
      periods: periodsByRow.get(rowId).map(({ entry }) => entry),
    });
  }
  // Contract rows outside the plan (or with no plan supplied) keep
  // contract order — the digest never drops a selected authority.
  for (const [rowId, entries] of periodsByRow) {
    if (emitted.has(rowId)) continue;
    digest.push({
      row_id: rowId,
      periods: entries.map(({ entry }) => entry),
    });
  }
  return digest;
}
