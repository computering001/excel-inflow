import { canonicalJson, hashValue } from "./run_store.mjs";
import { verifyOwnershipCensus } from "./ownership_census.mjs";
import { SCHEDULE_PRODUCER_BY_ROLE } from "./forecast_producer_contract.mjs";
import {
  aggregateForecastFamilyRankVector,
  compareForecastAuthorityCandidates,
  compareForecastRankVectors,
  forecastAuthorityDecidingDimension,
  forecastAuthorityRankVector,
  forecastRankVectorDecidingDimension,
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

const OWNERSHIP_RECOVERY_MODES = Object.freeze(["historical_average"]);

/**
 * P3.4 — the bounded downstream-only recovery pass is a DECLARED code path.
 * A case (or the controller, through its legacy environment gate, which is
 * normalised here into the same typed declaration) must declare the recovery
 * mode; the declaration and whether it was applied are sealed into the
 * period-scoring ledger so a recovered run is receipt-visible, never an
 * invisible environment side effect. An unregistered mode fails closed.
 */
export function declaredOwnershipRecovery(modelCase) {
  const declared = modelCase?.forecast_ownership_recovery;
  if (declared !== undefined && declared !== null) {
    if (!OWNERSHIP_RECOVERY_MODES.includes(declared?.mode)) {
      throw new Error(
        `forecast ownership recovery declares unsupported mode ${JSON.stringify(declared?.mode ?? null)}; ` +
          `declared recovery paths: ${OWNERSHIP_RECOVERY_MODES.join(", ")}`,
      );
    }
    return {
      mode: declared.mode,
      origin: "case_declaration",
      note: declared.note ?? "Bounded downstream-only recovery declared on the case.",
    };
  }
  if (process.env.EXCEL_INFLOW_OWNERSHIP_DEGRADE === "historical_average") {
    return {
      mode: "historical_average",
      origin: "controller_environment",
      note: "Legacy controller environment gate normalised into the typed recovery declaration.",
    };
  }
  return { mode: "none", origin: "undeclared", note: null };
}

/** The resolver's single period-authority writer (recovery fills and
 * child-owned period pins both route through here). */
function writePeriodAuthority(row, forecastIndex, authority) {
  row.forecast_period_authorities ??= [null, null, null];
  row.forecast_period_authorities[forecastIndex] = authority;
}

const PIN_SOURCE_KINDS = Object.freeze({
  broker_consensus: "broker",
  schedule_link: "schedule",
  accounting_identity: "formula",
  roll_forward: "formula",
  driver_formula: "formula",
  user_assumption: "user_supplied",
  carry_forward: "historical_inference",
  historical_average: "historical_inference",
  historical_trend: "historical_inference",
  seasonal_run_rate: "historical_inference",
  explicit_zero: "none",
});

/**
 * A capture mark is a row-level fact, but ownership is a per-period fact.
 * When a family captures a child in SOME periods while other periods remain
 * lawfully child-owned, any period whose ownership was only inferred (broker
 * link, live calculation, supplied value) must be pinned as an explicit
 * per-period authority — otherwise the row-level mark silently collapses the
 * child-owned periods to "not separately forecast".
 */
function pinnedPeriodAuthority(modelCase, child, forecastIndex, state) {
  const base = state.authority ?? {};
  const pinned = {
    method: state.method,
    source_kind: base.source_kind ?? PIN_SOURCE_KINDS[state.method] ?? "none",
    source_id:
      base.source_id ??
      base.stable_id ??
      `ownership-period-pin:${child.row_id}:fy${forecastIndex + 1}`,
    material:
      typeof base.material === "boolean"
        ? base.material
        : sourceOwnedMateriality(modelCase, child),
    note:
      base.note ??
      `FY${forecastIndex + 1} remains child-owned; the resolver pinned the row's ` +
        `${state.method} authority explicitly so a sibling-period capture cannot collapse this period.`,
  };
  if (base.value !== undefined && base.value !== null) pinned.value = base.value;
  if (base.as_of_date !== undefined) pinned.as_of_date = base.as_of_date;
  return pinned;
}


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

function strongestDirectChild(childStates) {
  return childStates
    .filter(({ owner_class }) => owner_class === "direct")
    .map(({ row, authority }) => ({ row, authority }))
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
  const recovery = declaredOwnershipRecovery(modelCase);
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
      // PHASE 1 — decide every period from a PRE-TRANSITION snapshot. Each
      // period's ownership classes and authorities are read before any of
      // this family's captures apply, so a capture in one period can no
      // longer reclassify a sibling period's lawful owner (the row-level
      // forecast_capture_parent_id mark previously turned an inferred broker
      // or calculation child into "absent" for EVERY period — the
      // collapsed-period defect this package repairs). Mutations from
      // earlier families stay visible: the snapshot is per family.
      const snapshotStates = new Map(children.map((row) => [
        row.row_id,
        [0, 1, 2].map((snapshotIndex) => {
          const method = methodAt(row, snapshotIndex);
          return {
            method,
            owner_class: ownershipClass(method),
            authority: authorityAt(row, snapshotIndex),
          };
        }),
      ]));
      const decisions = [];
      for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
        const parentMethod = methodAt(parent, forecastIndex);
        // A parent authority whose formula is spelled over this family's own
        // structural children is the family IDENTITY dressed as a driver:
        // selecting it as "direct" evidence would capture the very children
        // the formula consumes and materialise a sum over blanks. Ownership
        // classes decide who stands down, so the class must reflect the
        // evidence's true independence, not the method label the waterfall
        // stamped on it.
        const parentAuthorityForClass = authorityAt(parent, forecastIndex);
        // The sealed authority entry drops the candidate's formula_spec, so a
        // formula-kind authority is resolved against the formula the row will
        // actually execute for this period.
        const parentFormulaRefs =
          parentAuthorityForClass?.formula_spec?.refs ??
          (parentAuthorityForClass?.source_kind === "formula"
            ? (parent?.forecast_period_calculations?.[forecastIndex] ??
                parent?.forecast_calculation ??
                parent?.calculation)?.refs
            : null) ??
          [];
        const parentFormulaIsFamilyIdentity =
          parentFormulaRefs.length > 0 &&
          parentFormulaRefs.every((reference) =>
            structural_child_ids.has(reference),
          );
        const parentClass =
          ownershipClass(parentMethod) === "direct" &&
          parentFormulaIsFamilyIdentity
            ? "identity"
            : ownershipClass(parentMethod);
        const childStates = children.map((row) => ({
          row,
          ...snapshotStates.get(row.row_id)[forecastIndex],
        }));
        const materialChildStates = childStates.filter(({ row }) =>
          sourceOwnedMateriality(modelCase, row)
        );
        let completeMaterialChildren = materialChildStates.every(
          ({ owner_class }) => owner_class !== "absent",
        );
        const strongestChild = strongestDirectChild(materialChildStates);
        const parentAuthority = authorityAt(parent, forecastIndex);
        const parentRankVector = forecastAuthorityRankVector(parentAuthority);
        const parentHasCompilableIdentity =
          parent?.calculation?.operator === "sum" &&
          Array.isArray(parent.calculation.refs) &&
          parent.calculation.refs.length > 0;
        // Family-level ownership: children may take the aggregate only when
        // the material family is COMPLETE (no absent member) — that is the
        // completeness half of the constitution, enforced above — and the
        // FAMILY AGGREGATE over ALL direct material children substantively
        // outranks the parent. The aggregate takes each rank dimension from
        // the family's strongest evidence for that dimension, so a complete
        // child set competes with its combined strength — never just its
        // single strongest member — while weaker-but-present siblings still
        // cannot drag a lawful family below its strongest child (the sealed
        // contract shape where strong FY1 company evidence owns a complete
        // child set whose siblings carry weaker-but-present authorities).
        const familyAggregate = aggregateForecastFamilyRankVector(
          materialChildStates
            .filter(({ owner_class }) => owner_class === "direct")
            .map(({ authority }) => authority),
        );
        const familyRankDimension = familyAggregate
          ? forecastRankVectorDecidingDimension(familyAggregate, parentRankVector)
          : null;
        const strongerDirectChildren = Boolean(
          completeMaterialChildren &&
          parentHasCompilableIdentity &&
          strongestChild &&
          !["stable_id", "exact_tie"].includes(familyRankDimension) &&
          compareForecastRankVectors(familyAggregate, parentRankVector) < 0,
        );
        let selectedMode = null;
        if (parentClass === "schedule") selectedMode = "schedule_owned";
        else if (parentClass === "direct") {
          selectedMode = strongerDirectChildren ? "children_owned" : "parent_owned";
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

        // The DECLARED bounded downstream-only recovery pass (typed above,
        // receipt-visible in the period-scoring ledger). It fills only
        // genuinely missing material children with a deterministic
        // historical-average authority when three historical observations
        // exist; it never overwrites a selected source or turns unresolved
        // evidence into zero.
        if (
          !selectedMode &&
          recovery.mode === "historical_average" &&
          parentHasCompilableIdentity
        ) {
          for (const state of materialChildStates) {
            if (state.owner_class !== "absent") continue;
            // A nil observation is MISSING, not zero: it must not enter the
            // average (Number(null) would coerce to 0 and silently zero-bias
            // the fill).
            const history = (state.row.values ?? []).slice(0, 3)
              .filter((value) => value !== null && value !== undefined)
              .map(Number)
              .filter(Number.isFinite);
            if (history.length !== 3) continue;
            writePeriodAuthority(state.row, forecastIndex, {
              method: "historical_average",
              source_kind: "historical_inference",
              source_id: `ownership-degradation:${state.row.row_id}:fy${forecastIndex + 1}`,
              value: history.reduce((sum, value) => sum + value, 0) / history.length,
              note:
                `Declared ownership recovery (${recovery.origin}) filled this ` +
                `genuinely missing period from three historical observations.`,
            });
            Object.assign(state, {
              method: "historical_average",
              owner_class: "direct",
              authority: authorityAt(state.row, forecastIndex),
            });
            degradedAuthorities.push({
              row_id: state.row.row_id,
              forecast_index: forecastIndex,
              method: "historical_average",
            });
          }
          completeMaterialChildren = materialChildStates.every(
            ({ owner_class }) => owner_class !== "absent",
          );
          if (completeMaterialChildren) selectedMode = "children_owned";
        }

        // The capture plan for THIS period is decided here against the
        // snapshot and applied in phase 2.
        const capturePlan = new Set();
        if (["parent_owned", "schedule_owned"].includes(selectedMode)) {
          for (const state of childStates) {
            const permittedSchedule = state.owner_class === "schedule" &&
              state.row.forecast_schedule_coownership_permitted === true;
            // A calculation dependency is not automatically owned detail.
            // Shared statement building blocks (for example operating profit
            // and D&A) must remain live for their other accounting identities.
            // Only the declared structural children belong to this parent's
            // capture scope.
            const formulaDependencyOnly = !structural_child_ids.has(state.row.row_id);
            const parentRankDimension = forecastAuthorityDecidingDimension(
              parentAuthority,
              state.authority,
            );
            const parentSubstantivelyStronger =
              !["stable_id", "exact_tie"].includes(parentRankDimension) &&
              compareForecastAuthorityCandidates(
                parentAuthority,
                state.authority,
              ) < 0;
            const reusableFormulaDependency = formulaDependencyOnly &&
              (
                state.owner_class !== "direct" ||
                shared_formula_child_ids.has(state.row.row_id) ||
                !parentSubstantivelyStronger
              );
            if (!permittedSchedule && !reusableFormulaDependency) {
              capturePlan.add(state.row.row_id);
            }
          }
        }

        if (!selectedMode) {
          violations.push(
            `${section}:${parent.row_id}:fy${forecastIndex + 1} has unresolved material ownership ` +
              `(parent=${parentMethod}; children=${childStates.map(({ row, method, owner_class }) => `${row.row_id}:${method}:${owner_class}`).join(",")})`,
          );
        }
        decisions.push({
          forecastIndex,
          selectedMode,
          parentMethod,
          parentClass,
          parentAuthority,
          parentRankVector,
          familyAggregate,
          familyRankDimension,
          childStates,
          capturePlan,
        });
      }
      const capturedChildIds = new Set(
        decisions.flatMap(({ capturePlan }) => [...capturePlan]),
      );
      // PHASE 2 — THE PERIOD LOOP applies each period's decided transition,
      // persists that period's rank vectors on the ledger, and SEALS
      // CERTIFICATES INSIDE THE LOOP so the certificate state is re-proved
      // against each period's final authorities as that period lands, not
      // once after the whole family completes.
      for (const decision of decisions) {
        const {
          forecastIndex,
          selectedMode,
          parentMethod,
          parentClass,
          parentRankVector,
          familyAggregate,
          familyRankDimension,
          childStates,
          capturePlan,
        } = decision;
        if (["parent_owned", "schedule_owned"].includes(selectedMode)) {
          for (const state of childStates) {
            if (capturePlan.has(state.row.row_id)) {
              captureAuthority(modelCase, parent, state.row, forecastIndex, rejectedAuthorities);
            }
          }
        } else if (selectedMode === "children_owned") {
          if (parentClass === "direct") {
            const decidingDimension = familyRankDimension ??
              "complete_child_identity";
            const rejectedParentAuthority =
              structuredClone(parent.forecast_period_authorities?.[forecastIndex]);
            // The rejected parent authority carries its own period rank proof
            // into the sealed receipt (the authority object is the receipt's
            // open surface for exactly this evidence).
            if (rejectedParentAuthority && typeof rejectedParentAuthority === "object") {
              rejectedParentAuthority.selection_rank ??= parentRankVector;
            }
            rejectedAuthorities.push({
              row_id: parent.row_id,
              forecast_index: forecastIndex,
              authority: rejectedParentAuthority,
              rejection_reason:
                `Complete compatible children own the aggregate identity; ` +
                `the family aggregate authority over all ` +
                `${familyAggregate?.aggregated_member_count ?? 0} children wins on ${decidingDimension}.`,
            });
          }
          setParentIdentity(modelCase, parent, forecastIndex);
          // A child captured in a SIBLING period keeps this period's live
          // ownership only through an explicit per-period authority: pin the
          // snapshot's inferred authority so the row-level capture mark
          // cannot collapse a lawfully child-owned period.
          for (const state of childStates) {
            if (!capturedChildIds.has(state.row.row_id)) continue;
            if (state.owner_class === "absent") continue;
            if (state.row.forecast_period_authorities?.[forecastIndex]?.method) continue;
            writePeriodAuthority(
              state.row,
              forecastIndex,
              pinnedPeriodAuthority(modelCase, state.row, forecastIndex, state),
            );
          }
        }
        resolutions.push({
          section,
          parent_row_id: parent.row_id,
          forecast_index: forecastIndex,
          selected_mode: selectedMode ?? "unresolved",
          child_row_ids: children.map((row) => row.row_id).sort(),
        });
        // Persist THIS period's rank vectors on the rows (selection_rank is
        // the schema's canonical per-period rank slot, and the sealed
        // forecast-authority ledger republishes it per row per period). Only
        // entries whose method still matches the adjudicated authority are
        // stamped — a rewritten entry (capture, identity rebuild over a
        // rejected direct parent) carries its rank through the certificate or
        // the rejected-authority evidence instead — and a rank sealed by an
        // earlier selector is never overwritten.
        const parentEntry = parent.forecast_period_authorities?.[forecastIndex];
        if (
          parentEntry &&
          typeof parentEntry === "object" &&
          parentEntry.method === parentMethod
        ) {
          parentEntry.selection_rank ??= structuredClone(parentRankVector);
        }
        for (const state of childStates) {
          if (capturePlan.has(state.row.row_id)) continue;
          const childEntry = state.row.forecast_period_authorities?.[forecastIndex];
          if (
            childEntry &&
            typeof childEntry === "object" &&
            childEntry.method === state.method
          ) {
            childEntry.selection_rank ??= forecastAuthorityRankVector(state.authority);
          }
        }
        for (const child of children) {
          sealCaptureCertificates(modelCase, parent, child);
        }
      }
      for (const child of children) {
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
    const error = new Error(`forecast ownership preflight B blocked: ${violations.join("; ")}`);
    error.typed_internal_outcome = {
      reason_code: "INTERNAL.forecast_ownership_blocked",
      earliest_responsible_layer: "forecast_ownership_resolver",
      downstream_invalidation_scope: "forecast_ownership_and_below",
      violation_count: violations.length,
      first_violation: violations[0] ?? null,
    };
    throw error;
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

/**
 * Validate (never repair) the persisted per-period ownership scoring:
 * against the sealed selected-ownership receipt, every family resolution is
 * period-explicit on the rows — a children-owned period keeps every material
 * child alive (a row-level capture mark may not collapse it), a
 * resolver-authored authority (pin or declared recovery fill) carries its
 * per-period selection_rank vector, and a rejected direct parent's period
 * rank proof is sealed inside the receipt's rejected-authority evidence.
 */
export function verifyPeriodOwnershipScoring(modelCase) {
  const receipt = verifySelectedForecastOwnership(modelCase);
  const rowsBySectionName = new Map(
    rowsBySection(modelCase).map(({ section, rows }) => [
      section,
      new Map(rows.filter((row) => row?.row_id).map((row) => [row.row_id, row])),
    ]),
  );
  for (const resolution of receipt.resolutions ?? []) {
    const localRows = rowsBySectionName.get(resolution.section);
    for (const childId of resolution.child_row_ids ?? []) {
      const child = localRows?.get(childId);
      if (!child) continue;
      const method = methodAt(child, resolution.forecast_index);
      if (
        resolution.selected_mode === "children_owned" &&
        sourceOwnedMateriality(modelCase, child) &&
        ownershipClass(method) === "absent" &&
        !child.forecast_schedule_coownership_permitted
      ) {
        throw new Error(
          `period ownership scoring violation: ${resolution.section}:${childId}:fy${resolution.forecast_index + 1} ` +
            `is absent inside a children-owned period (a sibling-period capture collapsed it)`,
        );
      }
    }
  }
  for (const { rows } of rowsBySection(modelCase)) {
    for (const row of rows) {
      (row?.forecast_period_authorities ?? []).forEach((authority, index) => {
        const resolverAuthored =
          typeof authority?.source_id === "string" &&
          (authority.source_id.startsWith("ownership-period-pin:") ||
            authority.source_id.startsWith("ownership-degradation:"));
        if (resolverAuthored && !authority.selection_rank) {
          throw new Error(
            `period ownership scoring violation: ${row.row_id}:fy${index + 1} ` +
              `resolver-authored authority lacks its persisted selection_rank vector`,
          );
        }
      });
    }
  }
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
