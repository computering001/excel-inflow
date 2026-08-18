import { canonicalJson, hashValue } from "./run_store.mjs";
import { verifyOwnershipCensus } from "./ownership_census.mjs";
import { SCHEDULE_PRODUCER_BY_ROLE } from "./forecast_producer_contract.mjs";
import {
  compareForecastAuthorityCandidates,
  forecastAuthorityDecidingDimension,
} from "./forecast_authority.mjs";
import {
  captureAuthority,
  clearFullyCapturedDirectMarkers,
  material,
  methodAt,
  ownershipClass,
  sealCaptureCertificates,
  setParentIdentity,
  sourceOwnedMateriality,
} from "./capture_transition.mjs";

export const FORECAST_OWNERSHIP_PREFLIGHT_VERSION =
  "forecast-ownership-preflight/1.0";


function seal(body) {
  return { ...body, receipt_sha256: hashValue(body) };
}

function rowsBySection(modelCase) {
  return ["income_statement", "cash_flow"].map((section) => ({
    section,
    rows: modelCase?.statement_structure?.[section] ?? [],
  }));
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
  const degradedAuthorities = [];
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
        let childStates = children.map((row) => ({
          row,
          owner_class: ownershipClass(methodAt(row, forecastIndex)),
        }));
        let materialChildStates = childStates.filter(({ row }) =>
          sourceOwnedMateriality(modelCase, row)
        );
        let completeMaterialChildren = materialChildStates.every(
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
        // Family-level ownership: children may take the aggregate only when
        // the material family is COMPLETE (no absent member) — that is the
        // completeness half of the constitution, enforced above — and the
        // strongest child substantively outranks the parent. The sealed
        // contract tests deliberately let strong FY1 company evidence own a
        // complete child set whose siblings carry weaker-but-present
        // authorities; requiring every sibling to beat the parent would
        // reject that lawful shape.
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

        // The controller may make one bounded downstream-only recovery pass.
        // It fills only genuinely missing material children with a deterministic
        // historical-average authority when three historical observations exist;
        // it never overwrites a selected source or turns unresolved evidence into zero.
        if (
          !selectedMode &&
          process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE === "historical_average" &&
          parentHasCompilableIdentity
        ) {
          for (const { row: child, owner_class: ownerClass } of materialChildStates) {
            if (ownerClass !== "absent") continue;
            const history = (child.values ?? []).slice(0, 3)
              .map(Number)
              .filter(Number.isFinite);
            if (history.length !== 3) continue;
            child.forecast_period_authorities ??= [];
            child.forecast_period_authorities[forecastIndex] = {
              method: "historical_average",
              source_kind: "historical_inference",
              source_id: `ownership-degradation:${child.row_id}:fy${forecastIndex + 1}`,
              value: history.reduce((sum, value) => sum + value, 0) / history.length,
            };
            degradedAuthorities.push({
              row_id: child.row_id,
              forecast_index: forecastIndex,
              method: "historical_average",
            });
          }
          childStates = children.map((row) => ({
            row,
            owner_class: ownershipClass(methodAt(row, forecastIndex)),
          }));
          materialChildStates = childStates.filter(({ row }) =>
            sourceOwnedMateriality(modelCase, row)
          );
          completeMaterialChildren = materialChildStates.every(
            ({ owner_class }) => owner_class !== "absent",
          );
          if (completeMaterialChildren) selectedMode = "children_owned";
        }

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
    degraded_authorities: degradedAuthorities,
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
