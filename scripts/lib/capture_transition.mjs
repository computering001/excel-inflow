/**
 * The single legal capture writer.
 *
 * Every operation that transfers a child row's forecast ownership to its
 * aggregate parent — rejecting the losing authority, blanking the captured
 * periods, stamping the capture parent/mode, sealing per-period certificates,
 * clearing stale direct markers, and pinning the winning parent identity —
 * lives HERE and nowhere else. The prior architecture let several layers
 * touch capture state; a row could be marked captured by one layer and
 * considered live by another, and the Build gate discovered the disagreement
 * terminally. One writer makes the transition atomic per family: either the
 * whole parent-owned transaction applies, or none of it does.
 *
 * The ownership RESOLVER decides which mode a family takes; this module only
 * executes the decided transition. No other module may mutate
 * forecast_capture_* fields or write not_separately_forecast authorities.
 */

import { SCHEDULE_PRODUCER_BY_ROLE } from "./forecast_producer_contract.mjs";
import { forecastRowMateriality } from "./forecast_authority.mjs";

export const ABSENT_METHODS = new Set([
  "not_separately_forecast",
  "not_applicable",
  "unresolved",
]);
export const IDENTITY_METHODS = new Set(["accounting_identity"]);
export const SCHEDULE_METHODS = new Set(["schedule_link"]);

export function material(row) {
  return row?.row_type !== "header" && row?.material !== false &&
    row?.is_material !== false;
}

export function sourceOwnedMateriality(modelCase, row) {
  const mapped = forecastRowMateriality(modelCase, row);
  return typeof mapped === "boolean" ? mapped : material(row);
}

export function methodAt(row, forecastIndex) {
  const declared = row?.forecast_period_authorities?.[forecastIndex]?.method;
  if (declared) return declared;
  if (row?.forecast_capture_parent_id) return "not_separately_forecast";
  if (
    row?.forecast_period_calculations?.[forecastIndex] ||
    row?.forecast_calculation ||
    row?.calculation
  ) return "accounting_identity";
  if (row?.broker_metric_id || row?.forecast_treatment === "broker") {
    return "broker_consensus";
  }
  if (row?.forecast_treatment === "zero") return "explicit_zero";
  const directValue = row?.values?.[forecastIndex + 3];
  if (directValue !== null && directValue !== undefined && Number.isFinite(Number(directValue))) {
    return "user_assumption";
  }
  if (["schedule", "schedule_link"].includes(row?.forecast_treatment)) {
    return "schedule_link";
  }
  if (Object.hasOwn(SCHEDULE_PRODUCER_BY_ROLE, row?.semantic_role ?? "")) {
    return "schedule_link";
  }
  return "unresolved";
}

export function ownershipClass(method) {
  if (ABSENT_METHODS.has(method)) return "absent";
  if (IDENTITY_METHODS.has(method)) return "identity";
  if (SCHEDULE_METHODS.has(method)) return "schedule";
  return "direct";
}

export function captureAuthority(modelCase, parent, child, forecastIndex, rejectedAuthorities) {
  const rejected = child?.forecast_period_authorities?.[forecastIndex] ?? null;
  const priorCertificate = (child?.forecast_capture_certificates ?? []).find(
    (certificate) => certificate?.forecast_index === forecastIndex,
  );
  if (rejected && ownershipClass(rejected.method) !== "absent") {
    rejectedAuthorities.push({
      row_id: child.row_id,
      forecast_index: forecastIndex,
      authority: structuredClone(rejected),
      rejection_reason: `Captured by stronger aggregate authority ${parent.row_id}.`,
    });
  }
  child.forecast_period_authorities ??= [null, null, null];
  child.forecast_period_authorities[forecastIndex] = {
    method: "not_separately_forecast",
    source_kind: "none",
    // Capturing changes ownership, not source materiality. Preserve the
    // selected authority's sealed material flag where it exists so the
    // resolver cannot silently promote a source-declared immaterial detail.
    material: typeof rejected?.material === "boolean"
      ? rejected.material
      : typeof priorCertificate?.material === "boolean"
        ? priorCertificate.material
      : sourceOwnedMateriality(modelCase, child),
    note: `Forecast detail is represented once by ${parent.row_id}.`,
  };
  if (Array.isArray(child.values)) child.values[forecastIndex + 3] = null;
  if (Array.isArray(child.forecast_period_calculations)) {
    child.forecast_period_calculations[forecastIndex] = null;
  }
  child.forecast_capture_parent_id = parent.row_id;
  child.forecast_capture_mode = "semantic_scope";
  child.forecast_capture_note =
    `Forecast detail is captured by deterministic ownership resolver in ${parent.row_id}.`;
}

export function sealCaptureCertificates(modelCase, parent, child) {
  if (!child.forecast_capture_parent_id) return;
  child.forecast_capture_certificates = [0, 1, 2].map((forecastIndex) => ({
    forecast_index: forecastIndex,
    parent_row_id: parent.row_id,
    mode: "semantic_scope",
    material: sourceOwnedMateriality(modelCase, child),
    membership_path: [child.row_id, parent.row_id],
    proof: ownershipClass(methodAt(child, forecastIndex)) === "absent"
      ? "The child is intentionally blank in this period and its economic scope is represented once by the selected parent authority."
      : "This period remains child-owned; the certificate records the family boundary but does not transfer its live authority.",
  }));
}

export function setParentIdentity(modelCase, parent, forecastIndex) {
  parent.forecast_period_authorities ??= [null, null, null];
  const selectedAuthority = parent.forecast_period_authorities[forecastIndex];
  const selectedIdentity =
    ownershipClass(selectedAuthority?.method) === "identity"
      ? structuredClone(selectedAuthority)
      : {};
  parent.forecast_period_authorities[forecastIndex] = {
    ...selectedIdentity,
    method: "accounting_identity",
    source_kind: "formula",
    material:
      typeof selectedIdentity.material === "boolean"
        ? selectedIdentity.material
        : sourceOwnedMateriality(modelCase, parent),
    note:
      selectedIdentity.note ??
      "The aggregate is calculated from its complete live child set.",
  };
  parent.forecast_period_calculations ??= [null, null, null];
  parent.forecast_period_calculations[forecastIndex] = structuredClone(parent.calculation);
  if (Array.isArray(parent.values)) parent.values[forecastIndex + 3] = null;
  parent.forecast_treatment = "formula";
}

export function clearFullyCapturedDirectMarkers(row) {
  const fullyCaptured = [0, 1, 2].every(
    (index) => ownershipClass(methodAt(row, index)) === "absent",
  );
  if (!fullyCaptured) return;
  delete row.broker_metric_id;
  delete row.forecast_calculation;
  delete row.forecast_period_calculations;
  row.forecast_treatment = "uncalculated";
}

// ---------------------------------------------------------------------------
// P3.5 — SINGLE-WRITER FIELD CUSTODY.
//
// Every write to forecast_capture_parent_id / _mode / _note / _certificates
// anywhere in the compiler goes through the four primitives below. Callers
// keep their own orchestration (eligibility rules, treatment markers), but
// the capture FIELDS have one writing module. The ownership census verifies
// this: a raw assignment outside this file is a defect.
// ---------------------------------------------------------------------------

/** Apply a capture mark. `certificates` is optional (formula-membership
 * marks without sealed certificates keep that shape). */
export function applyCaptureMark(row, { parent_row_id, mode, note, certificates }) {
  row.forecast_capture_parent_id = parent_row_id;
  row.forecast_capture_mode = mode;
  row.forecast_capture_note = note;
  if (certificates !== undefined) {
    row.forecast_capture_certificates = certificates;
  }
  return row;
}

/** Remove every capture field from a row. */
export function clearCaptureMark(row) {
  delete row.forecast_capture_parent_id;
  delete row.forecast_capture_mode;
  delete row.forecast_capture_note;
  delete row.forecast_capture_certificates;
  return row;
}

/** Re-point a capture at a surviving parent (consolidation retargeting). */
export function reassignCaptureParent(row, fromId, toId) {
  if (row.forecast_capture_parent_id === fromId) {
    row.forecast_capture_parent_id = toId;
  }
  return row;
}

/** Migrate a legacy capture's proof mode, preserving lineage. */
export function migrateCaptureMode(row, mode, certificates) {
  row.forecast_capture_mode = mode;
  row.forecast_capture_certificates = certificates;
  return row;
}
