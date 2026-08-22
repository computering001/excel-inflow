// Semantic-status classification for compiled forecast plans.
//
// A forecast plan can be structurally valid (validateForecastPlan passes) and
// still carry material BLOCKED states: rows whose forecast method the compiler
// could not resolve, or whose behavior gate emptied every compatible candidate
// (see forecast_candidate_compiler's blocking rule). Authority selection
// consumes a plan's state methods as though each were a decided economic
// authority, so a plan in that shape must never reach
// selected_authority_contract. This module classifies the semantic status;
// run_user_flow.mjs enforces it between plan validation and authority
// selection.
//
// Severity vocabulary mirrors the solver findings ledger (lib/solver.mjs):
// a material BLOCKED state stops the flow (typed BLOCKED, owned by
// INTERNAL_WORK — resolving it is compiler work, not a user decision), while a
// non-material BLOCKED state degrades to a DEGRADE finding and the flow
// continues with the effect disclosed.

const NON_MATERIAL_DEGRADE_CODE = "forecast_state_blocked_non_material";

/**
 * Split a compiled plan's BLOCKED states into the two lawful treatments.
 *
 * Returns `{ blocked, degrade_findings }`:
 * - `blocked` — one minimal locator per MATERIAL BLOCKED state
 *   ({ state_id, row_id, period_end }), in plan order. Any entry means the
 *   flow must stop before authority selection.
 * - `degrade_findings` — solver_findings-style DEGRADE records for
 *   NON-material BLOCKED states, deduped per (code, period, scope) exactly
 *   like recordSolverFinding, so per-period repeats cannot flood the list.
 */
export function classifyForecastSemanticStatus(forecastPlan) {
  const blocked = [];
  const degradeFindings = [];
  const seenFindings = new Set();
  for (const state of forecastPlan?.states ?? []) {
    if (state?.status !== "BLOCKED") continue;
    if (state.material === true) {
      blocked.push({
        state_id: state.state_id,
        row_id: state.row_id,
        period_end: state.period_end,
      });
      continue;
    }
    const finding = {
      code: NON_MATERIAL_DEGRADE_CODE,
      severity: "DEGRADE",
      scope: `${state.section ?? "unknown"}.${state.row_id}`,
      period: state.period_end ?? null,
      state_id: state.state_id,
      row_id: state.row_id,
      method: state.method ?? null,
      message:
        state.rationale ??
        "Non-material forecast state is BLOCKED; continuing with the effect disclosed.",
    };
    const key = JSON.stringify([finding.code, finding.period, finding.scope]);
    if (!seenFindings.has(key)) {
      seenFindings.add(key);
      degradeFindings.push(finding);
    }
  }
  return { blocked, degrade_findings: degradeFindings };
}

/**
 * Human-readable stop message naming every blocked row and its period, so the
 * operator can act without opening the plan artifact.
 */
export function forecastSemanticStopMessage(blocked) {
  const named = blocked
    .map((entry) => `${entry.row_id} (${entry.period_end})`)
    .join(", ");
  return (
    `${blocked.length} material forecast state(s) are BLOCKED before ` +
    `authority selection: ${named}. Resolve the forecast compiler gap for ` +
    `these rows; authority selection did not run.`
  );
}

/** The typed artifact written next to the plan when the gate stops the flow. */
export function buildForecastPlanStatusArtifact({ blocked, message }) {
  return {
    schema_version: "forecast-plan-status/1.0",
    status: "BLOCKED",
    blocked: [...blocked],
    message,
  };
}
