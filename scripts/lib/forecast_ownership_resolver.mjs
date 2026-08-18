import { canonicalJson, hashValue } from "./run_store.mjs";
import { verifyOwnershipCensus } from "./ownership_census.mjs";
import { SCHEDULE_PRODUCER_BY_ROLE } from "./forecast_producer_contract.mjs";
import {
  compareForecastAuthorityCandidates,
  forecastAuthorityDecidingDimension,
  forecastRowMateriality,
} from "./forecast_authority.mjs";

export const FORECAST_OWNERSHIP_PREFLIGHT_VERSION =
  "forecast-ownership-preflight/1.0";

const ABSENT_METHODS = new Set([
  "not_separately_forecast",
  "not_applicable",
  "unresolved",
]);
const IDENTITY_METHODS = new Set(["accounting_identity"]);
const SCHEDULE_METHODS = new Set(["schedule_link"]);

function seal(body) {
  return { ...body, receipt_sha256: hashValue(body) };
}

function rowsBySection(modelCase) {
  return ["income_statement", "cash_flow"].map((section) => ({
    section,
    rows: modelCase?.statement_structure?.[section] ?? [],
  }));
}

function material(row) {
  return row?.row_type !== "header" && row?.material !== false &&
    row?.is_material !== false;
}

function sourceOwnedMateriality(modelCase, row) {
  const mapped = forecastRowMateriality(modelCase, row);
  return typeof mapped === "boolean" ? mapped : material(row);
}

function methodAt(row, forecastIndex) {
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

function ownershipClass(method) {
  if (ABSENT_METHODS.has(method)) return "absent";
  if (IDENTITY_METHODS.has(method)) return "identity";
  if (SCHEDULE_METHODS.has(method)) return "schedule";
  return "direct";
}

function familyRows(rows) {
  const byId = new Map(rows.filter((row) => row?.row_id).map((row) => [row.row_id, row]));
  const childrenByParent = new Map();
  const formulaParentsByChild = new Map();
  for (const row of rows) {
    if (!row?.parent_row_id || !byId.has(row.parent_row_id)) continue;
    const children = childrenByParent.get(row.parent_row_id) ?? new Set();
    children.add(row.row_id);
    childrenByParent.set(row.parent_row_id, children);
  }
  const structuralChildrenByParent = new Map(
    [...childrenByParent].map(([parentId, childIds]) => [
      parentId,
      new Set(childIds),
    ]),
  );
  for (const row of rows) {
    if (row?.calculation?.operator !== "sum") continue;
    const children = childrenByParent.get(row.row_id) ?? new Set();
    for (const reference of row.calculation.refs ?? []) {
      if (reference !== row.row_id && byId.has(reference)) {
        children.add(reference);
        const parents = formulaParentsByChild.get(reference) ?? new Set();
        parents.add(row.row_id);
        formulaParentsByChild.set(reference, parents);
      }
    }
    childrenByParent.set(row.row_id, children);
  }
  return rows.flatMap((parent) => {
    const structuralChildIds = new Set(
      structuralChildrenByParent.get(parent?.row_id) ?? [],
    );
    const childIds = [...(childrenByParent.get(parent?.row_id) ?? [])].sort();
    if (childIds.length < 2) return [];
    return [{
      parent,
      children: childIds.map((rowId) => byId.get(rowId)).filter(Boolean),
      structural_child_ids: structuralChildIds,
      formula_child_ids: new Set(
        parent?.calculation?.operator === "sum"
          ? (parent.calculation.refs ?? []).filter((rowId) => byId.has(rowId))
          : childIds,
      ),
      shared_formula_child_ids: new Set(
        childIds.filter(
          (rowId) => (formulaParentsByChild.get(rowId)?.size ?? 0) > 1,
        ),
      ),
    }];
  });
}

function authorityAt(row, forecastIndex) {
  const declared = row?.forecast_period_authorities?.[forecastIndex];
  if (declared?.method) return declared;
  return {
    method: methodAt(row, forecastIndex),
    stable_id: `inferred:${row?.row_id ?? "unknown"}:fy${forecastIndex + 1}`,
  };
}

function strongestDirectChild(childStates, forecastIndex) {
  return childStates
    .filter(({ owner_class }) => owner_class === "direct")
    .map(({ row }) => ({ row, authority: authorityAt(row, forecastIndex) }))
    .sort((left, right) =>
      compareForecastAuthorityCandidates(left.authority, right.authority)
    )[0] ?? null;
}

function topologyProjection(modelCase) {
  return rowsBySection(modelCase).flatMap(({ section, rows }) =>
    rows.map((row) => ({
      section,
      row_id: row?.row_id ?? null,
      parent_row_id: row?.parent_row_id ?? null,
      calculation: row?.calculation ?? null,
      forecast_period_authorities: row?.forecast_period_authorities ?? null,
      forecast_capture_parent_id: row?.forecast_capture_parent_id ?? null,
      forecast_capture_mode: row?.forecast_capture_mode ?? null,
      forecast_capture_certificates: row?.forecast_capture_certificates ?? null,
      forecast_schedule_coownership_permitted:
        row?.forecast_schedule_coownership_permitted ?? null,
      source_line_id: row?.source_line_id ?? null,
      source_line_ids: row?.source_line_ids ?? null,
      source_precision: row?.source_precision ?? null,
      material: sourceOwnedMateriality(modelCase, row),
    })),
  );
}

function familyShape(section, parent, children) {
  const scheduleChildIds = children
    .filter((row) => [0, 1, 2].some((index) => ownershipClass(methodAt(row, index)) === "schedule"))
    .map((row) => row.row_id)
    .sort();
  const candidateDemandRows = [parent, ...children]
    .filter((row) => row?.broker_metric_id)
    .map((row) => row.row_id)
    .sort();
  const parentDemand = candidateDemandRows.includes(parent.row_id);
  const brokerDemandOwnerRowIds = parentDemand
    ? [parent.row_id]
    : candidateDemandRows.filter((rowId) => rowId !== parent.row_id);
  const candidateBrokerDemandNodeIds = [parent, ...children]
    .filter((row) => candidateDemandRows.includes(row.row_id))
    .flatMap((row) => row?.broker_demand_node_ids ?? [])
    .map(String)
    .sort();
  const brokerDemandOwnerNodeIds = [parent, ...children]
    .filter((row) => brokerDemandOwnerRowIds.includes(row.row_id))
    .flatMap((row) => row?.broker_demand_node_ids ?? [])
    .map(String)
    .sort();
  return {
    section,
    parent_row_id: parent.row_id,
    child_row_ids: children.map((row) => row.row_id).sort(),
    schedule_child_row_ids: scheduleChildIds,
    permitted_modes: [
      "parent_owned", "children_owned", "schedule_owned", "captured_by_ancestor",
    ],
    candidate_broker_demand_row_ids: candidateDemandRows,
    broker_demand_owner_row_ids: brokerDemandOwnerRowIds,
    candidate_broker_demand_node_ids: candidateBrokerDemandNodeIds,
    broker_demand_owner_node_ids: brokerDemandOwnerNodeIds,
  };
}

export function compileStructuralOwnershipPreflight(modelCase) {
  const families = [];
  const violations = [];
  for (const { section, rows } of rowsBySection(modelCase)) {
    for (const { parent, children } of familyRows(rows)) {
      const family = familyShape(section, parent, children);
      const parentDemand = family.candidate_broker_demand_row_ids.includes(parent.row_id);
      const childDemand = family.candidate_broker_demand_row_ids.some(
        (rowId) => rowId !== parent.row_id,
      );
      if (parentDemand && childDemand && family.broker_demand_owner_row_ids.length !== 1) {
        violations.push(
          `${section}:${parent.row_id} has simultaneous parent and child broker demand ownership`,
        );
      }
      families.push(family);
    }
  }
  const body = {
    schema_version: FORECAST_OWNERSHIP_PREFLIGHT_VERSION,
    checkpoint: "A_STRUCTURAL",
    case_id: modelCase?.case_id ?? null,
    status: violations.length ? "BLOCK" : "PASS",
    topology_input_sha256: hashValue(topologyProjection(modelCase)),
    families,
    violations,
    controller_signal: {
      action: violations.length ? "cancel_descendants_preserve_checkpoint" : "continue",
      reason: violations[0] ?? null,
      resume_from: "structural_ownership",
    },
  };
  const receipt = seal(body);
  modelCase.forecast_ownership_preflight_version =
    FORECAST_OWNERSHIP_PREFLIGHT_VERSION;
  modelCase.forecast_ownership_preflights ??= {};
  modelCase.forecast_ownership_preflights.structural = receipt;
  return receipt;
}

export function verifyStructuralOwnershipPreflight(modelCase, receipt) {
  if (
    receipt?.schema_version !== FORECAST_OWNERSHIP_PREFLIGHT_VERSION ||
    receipt?.checkpoint !== "A_STRUCTURAL"
  ) {
    throw new Error("structural forecast ownership preflight is absent or has the wrong version");
  }
  const copy = structuredClone(modelCase);
  const expected = compileStructuralOwnershipPreflight(copy);
  if (canonicalJson(expected) !== canonicalJson(receipt)) {
    throw new Error("structural forecast ownership preflight is stale or tampered");
  }
  return receipt;
}

function captureAuthority(modelCase, parent, child, forecastIndex, rejectedAuthorities) {
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

function sealCaptureCertificates(modelCase, parent, child) {
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

function setParentIdentity(modelCase, parent, forecastIndex) {
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

function clearFullyCapturedDirectMarkers(row) {
  const fullyCaptured = [0, 1, 2].every(
    (index) => ownershipClass(methodAt(row, index)) === "absent",
  );
  if (!fullyCaptured) return;
  delete row.broker_metric_id;
  delete row.forecast_calculation;
  delete row.forecast_period_calculations;
  row.forecast_treatment = "uncalculated";
}

export function resolveSelectedForecastOwnership(modelCase) {
  const priorRejectedAuthorities = structuredClone(
    modelCase?.forecast_ownership_preflights?.selected?.rejected_authorities ?? [],
  );
  try {
    return verifySelectedForecastOwnership(modelCase);
  } catch {
    // An absent or stale receipt is rebuilt from the current selected
    // authorities. A valid receipt is immutable and retains its rejected
    // evidence across later ledger seals.
  }
  const structural = compileStructuralOwnershipPreflight(modelCase);
  if (structural.status !== "PASS") {
    throw new Error(`forecast ownership preflight A blocked: ${structural.violations.join("; ")}`);
  }
  const resolutions = [];
  const rejectedAuthorities = [];
  const violations = [];
  for (const { section, rows } of rowsBySection(modelCase)) {
    for (
      const {
        parent,
        children,
        structural_child_ids,
        shared_formula_child_ids,
      } of familyRows(rows)
    ) {
      for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
        const parentMethod = methodAt(parent, forecastIndex);
        const parentClass = ownershipClass(parentMethod);
        const childStates = children.map((row) => ({
          row,
          owner_class: ownershipClass(methodAt(row, forecastIndex)),
        }));
        const materialChildStates = childStates.filter(({ row }) =>
          sourceOwnedMateriality(modelCase, row)
        );
        const completeMaterialChildren = materialChildStates.every(
          ({ owner_class }) => owner_class !== "absent",
        );
        const strongestChild = strongestDirectChild(
          materialChildStates,
          forecastIndex,
        );
        const parentAuthority = authorityAt(parent, forecastIndex);
        const parentHasCompilableIdentity =
          parent?.calculation?.operator === "sum" &&
          Array.isArray(parent.calculation.refs) &&
          parent.calculation.refs.length > 0;
        const childRankDimension = strongestChild
          ? forecastAuthorityDecidingDimension(
            strongestChild.authority,
            parentAuthority,
          )
          : null;
        const strongerDirectChild = Boolean(
          completeMaterialChildren &&
          parentHasCompilableIdentity &&
          strongestChild &&
          !["stable_id", "exact_tie"].includes(childRankDimension) &&
          compareForecastAuthorityCandidates(
            strongestChild.authority,
            parentAuthority,
          ) < 0,
        );
        let selectedMode = null;
        if (parentClass === "schedule") selectedMode = "schedule_owned";
        else if (parentClass === "direct") {
          selectedMode = strongerDirectChild ? "children_owned" : "parent_owned";
        }
        else if (
          ["not_separately_forecast", "not_applicable"].includes(parentMethod) &&
          materialChildStates.every(({ owner_class }) => owner_class === "absent")
        ) selectedMode = "captured_by_ancestor";
        else if (
          parentClass === "identity" &&
          completeMaterialChildren
        ) selectedMode = "children_owned";
        else if (
          completeMaterialChildren
        ) selectedMode = "children_owned";

        if (!selectedMode) {
          violations.push(
            `${section}:${parent.row_id}:fy${forecastIndex + 1} has unresolved material ownership ` +
              `(parent=${parentMethod}; children=${childStates.map(({ row, owner_class }) => `${row.row_id}:${methodAt(row, forecastIndex)}:${owner_class}`).join(",")})`,
          );
          resolutions.push({
            section,
            parent_row_id: parent.row_id,
            forecast_index: forecastIndex,
            selected_mode: "unresolved",
            child_row_ids: children.map((row) => row.row_id).sort(),
          });
          continue;
        }

        if (["parent_owned", "schedule_owned"].includes(selectedMode)) {
          for (const { row: child, owner_class: childClass } of childStates) {
            const permittedSchedule = childClass === "schedule" &&
              child.forecast_schedule_coownership_permitted === true;
            // A calculation dependency is not automatically owned detail.
            // Shared statement building blocks (for example operating profit
            // and D&A) must remain live for their other accounting identities.
            // Only the declared structural children belong to this parent's
            // capture scope.
            const formulaDependencyOnly = !structural_child_ids.has(child.row_id);
            const childAuthority = authorityAt(child, forecastIndex);
            const parentRankDimension = forecastAuthorityDecidingDimension(
              parentAuthority,
              childAuthority,
            );
            const parentSubstantivelyStronger =
              !["stable_id", "exact_tie"].includes(parentRankDimension) &&
              compareForecastAuthorityCandidates(
                parentAuthority,
                childAuthority,
              ) < 0;
            const reusableFormulaDependency = formulaDependencyOnly &&
              (
                childClass !== "direct" ||
                shared_formula_child_ids.has(child.row_id) ||
                !parentSubstantivelyStronger
              );
            if (!permittedSchedule && !reusableFormulaDependency) {
              captureAuthority(modelCase, parent, child, forecastIndex, rejectedAuthorities);
            }
          }
        } else if (selectedMode === "children_owned") {
          if (parentClass === "direct") {
            const decidingDimension = childRankDimension ??
              "complete_child_identity";
            rejectedAuthorities.push({
              row_id: parent.row_id,
              forecast_index: forecastIndex,
              authority: structuredClone(parent.forecast_period_authorities?.[forecastIndex]),
              rejection_reason:
                `Complete compatible children own the aggregate identity; ` +
                `the strongest child authority wins on ${decidingDimension}.`,
            });
          }
          setParentIdentity(modelCase, parent, forecastIndex);
        }
        resolutions.push({
          section,
          parent_row_id: parent.row_id,
          forecast_index: forecastIndex,
          selected_mode: selectedMode,
          child_row_ids: children.map((row) => row.row_id).sort(),
        });
      }
      for (const child of children) {
        sealCaptureCertificates(modelCase, parent, child);
        clearFullyCapturedDirectMarkers(child);
      }
    }
  }
  const retainedRejectedAuthorities = [
    ...priorRejectedAuthorities,
    ...rejectedAuthorities,
  ].filter((item, index, items) =>
    items.findIndex((candidate) => canonicalJson(candidate) === canonicalJson(item)) === index
  );
  const body = {
    schema_version: FORECAST_OWNERSHIP_PREFLIGHT_VERSION,
    checkpoint: "B_SELECTED_AUTHORITY",
    case_id: modelCase?.case_id ?? null,
    status: violations.length ? "BLOCK" : "PASS",
    structural_receipt_sha256: structural.receipt_sha256,
    resolutions,
    rejected_authorities: retainedRejectedAuthorities,
    violations,
    resolved_topology_sha256: hashValue(topologyProjection(modelCase)),
    controller_signal: {
      action: violations.length ? "cancel_descendants_preserve_checkpoint" : "continue",
      reason: violations[0] ?? null,
      resume_from: "selected_forecast_ownership",
    },
  };
  const receipt = seal(body);
  modelCase.forecast_ownership_preflights.selected = receipt;
  if (receipt.status !== "PASS") {
    throw new Error(`forecast ownership preflight B blocked: ${violations.join("; ")}`);
  }
  return receipt;
}

export function verifySelectedForecastOwnership(modelCase) {
  const receipt = modelCase?.forecast_ownership_preflights?.selected;
  if (
    modelCase?.forecast_ownership_preflight_version !==
      FORECAST_OWNERSHIP_PREFLIGHT_VERSION ||
    !receipt
  ) throw new Error("selected forecast ownership preflight is absent or has the wrong version");
  const { receipt_sha256: stored, ...body } = receipt;
  if (stored !== hashValue(body)) throw new Error("selected forecast ownership preflight receipt drift");
  if (receipt.resolved_topology_sha256 !== hashValue(topologyProjection(modelCase))) {
    throw new Error("selected forecast ownership topology is stale");
  }
  for (const { rows } of rowsBySection(modelCase)) {
    for (const row of rows) {
      if (
        row?.broker_metric_id &&
        row?.forecast_capture_parent_id &&
        [0, 1, 2].every((index) => ownershipClass(methodAt(row, index)) === "absent")
      ) {
        throw new Error(
          `captured child retains broker demand id: ${row.row_id}:${row.broker_metric_id}`,
        );
      }
    }
  }
  if (receipt.status !== "PASS") throw new Error("selected forecast ownership preflight is blocked");
  return receipt;
}

export function compilePhysicalOwnershipPreflight(
  modelCase,
  rowPlan,
  { standaloneSolution = null, proFormaSolution = null } = {},
) {
  verifySelectedForecastOwnership(modelCase);
  const violations = [];
  const destinations = [];
  const selectedModes = new Map(
    (modelCase.forecast_ownership_preflights.selected.resolutions ?? []).map(
      (resolution) => [
        `${resolution.section}\0${resolution.parent_row_id}\0${resolution.forecast_index}`,
        resolution.selected_mode,
      ],
    ),
  );
  const plannedCase = {
    ...modelCase,
    statement_structure: {
      income_statement: rowPlan?.statement_rows?.income_statement ?? [],
      cash_flow: rowPlan?.statement_rows?.cash_flow ?? [],
    },
  };
  for (const { section, rows } of rowsBySection(plannedCase)) {
    for (const { parent, children, structural_child_ids } of familyRows(rows)) {
      const parentDestination = Number(parent?.row ?? rowPlan?.rows_by_id?.[parent.row_id]);
      if (!Number.isInteger(parentDestination)) {
        violations.push(`${section}:${parent.row_id} has no physical workbook destination`);
      }
      for (const child of children) {
        const childDestination = Number(child?.row ?? rowPlan?.rows_by_id?.[child.row_id]);
        if (!Number.isInteger(childDestination)) {
          violations.push(`${section}:${child.row_id} has no physical workbook destination`);
        }
      }
      for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
        const parentClass = ownershipClass(methodAt(parent, forecastIndex));
        const selectedMode = selectedModes.get(
          `${section}\0${parent.row_id}\0${forecastIndex}`,
        ) ?? null;
        const liveChildren = children.filter(
          (child) => ownershipClass(methodAt(child, forecastIndex)) !== "absent",
        );
        const directParent = ["direct", "schedule"].includes(parentClass);
        if (directParent && liveChildren.some((child) =>
          structural_child_ids.has(child.row_id) &&
          !(ownershipClass(methodAt(child, forecastIndex)) === "schedule" &&
            child.forecast_schedule_coownership_permitted === true))) {
          violations.push(
            `${section}:${parent.row_id}:fy${forecastIndex + 1} reaches emission with dual parent/child ownership`,
          );
        }
        destinations.push({
          section,
          parent_row_id: parent.row_id,
          parent_destination_row: Number.isInteger(parentDestination) ? parentDestination : null,
          forecast_index: forecastIndex,
          parent_owner_class: parentClass,
          selected_mode: selectedMode,
          child_destination_rows: children.map((child) => ({
            row_id: child.row_id,
            row: Number(child?.row ?? rowPlan?.rows_by_id?.[child.row_id]) || null,
            owner_class: ownershipClass(methodAt(child, forecastIndex)),
          })),
        });
      }
    }
  }
  const census = modelCase?.ownership_census;
  try {
    verifyOwnershipCensus(modelCase);
  } catch (error) {
    violations.push(`sealed ownership census is absent, stale or blocked before emission: ${error.message}`);
  }
  const solverBinding = {
    standalone_forecast_periods: Array.isArray(standaloneSolution?.forecast)
      ? standaloneSolution.forecast.length
      : null,
    pro_forma_forecast_periods: Array.isArray(proFormaSolution?.forecast)
      ? proFormaSolution.forecast.length
      : null,
    standalone_solution_sha256: standaloneSolution ? hashValue(standaloneSolution) : null,
    pro_forma_solution_sha256: proFormaSolution ? hashValue(proFormaSolution) : null,
  };
  if (
    modelCase?.execution_profile === "production_model" &&
    (solverBinding.standalone_forecast_periods !== 3 ||
      solverBinding.pro_forma_forecast_periods !== 3)
  ) {
    violations.push(
      "physical ownership preflight is not bound to both three-period solver results",
    );
  }
  const body = {
    schema_version: FORECAST_OWNERSHIP_PREFLIGHT_VERSION,
    checkpoint: "C_PHYSICAL",
    case_id: modelCase?.case_id ?? null,
    status: violations.length ? "BLOCK" : "PASS",
    selected_receipt_sha256:
      modelCase.forecast_ownership_preflights.selected.receipt_sha256,
    census_sha256: census?.census_sha256 ?? null,
    solver_binding: solverBinding,
    destinations,
    ownership_writer_contract_sha256: hashValue(destinations),
    violations,
    controller_signal: {
      action: violations.length ? "cancel_descendants_preserve_checkpoint" : "continue",
      reason: violations[0] ?? null,
      resume_from: "physical_ownership",
    },
  };
  return seal(body);
}

export function assertPhysicalOwnershipPreflight(modelCase, rowPlan, solverResults = {}) {
  const receipt = compilePhysicalOwnershipPreflight(modelCase, rowPlan, solverResults);
  if (receipt.status !== "PASS") {
    throw new Error(`forecast ownership preflight C blocked: ${receipt.violations.join("; ")}`);
  }
  return receipt;
}

export function verifyForecastOwnershipReceipt(receipt) {
  const { receipt_sha256, ...body } = receipt ?? {};
  return Boolean(
    receipt?.schema_version === FORECAST_OWNERSHIP_PREFLIGHT_VERSION &&
    receipt_sha256 === hashValue(body),
  );
}

export function canonicalForecastOwnershipReceipt(receipt) {
  return canonicalJson(receipt);
}
