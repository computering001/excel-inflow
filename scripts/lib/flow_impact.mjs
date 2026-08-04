// Impact analysis for stage-3 questions.
//
// Two independent views of the same thing, deliberately:
//
//   1. G2 forward reachability — structural. Starting from the cells an answer
//      would change, which headline cells can be reached? This says WHAT moves.
//   2. Differential solve — behavioural. Solve the case twice, once under each
//      answer, and difference the headline series. This says BY HOW MUCH.
//
// The money consequence printed on a question comes from (2). (1) is kept as a
// cross-check: if a metric moved in the differential solve that the graph says
// is unreachable from the answer, either the graph is wrong or the solver is,
// and the run records the disagreement instead of quietly preferring one. That
// is §7's independence rule and L7's mutation/reachability pairing applied to
// the question machinery.
//
// G2 is the canonical semantic manifest itself. Statement, instrument, debt,
// liquidity, lease, acquisition and interest dependencies are all compiled in
// `lib/semantic_graph.mjs`; this consumer is forbidden from adding a second
// reachability graph. The structural and behavioural views therefore remain
// genuinely independent without disagreeing about which graph is authoritative.

import { compileSemanticManifest } from "./semantic_graph.mjs";
import { compileRowPlan } from "./row_plan.mjs";
import { solveCase } from "./solver.mjs";

// The headline set a question consequence may be expressed in, mapped to the G2
// node that carries it and to the solver field that measures it.
export const HEADLINE_METRICS = Object.freeze({
  total_liquidity: Object.freeze({
    node_id: "mechanical.total_liquidity",
    field: "total_liquidity",
    unit: "money",
    noun: "liquidity",
  }),
  net_debt: Object.freeze({
    node_id: "mechanical.net_debt_including_leases",
    field: "net_debt",
    unit: "money",
    noun: "net debt",
  }),
  gross_debt: Object.freeze({
    node_id: "mechanical.gross_debt_including_leases",
    field: "gross_debt",
    unit: "money",
    noun: "gross debt",
  }),
  net_leverage: Object.freeze({
    node_id: "mechanical.net_debt_to_adjusted_ebitda",
    field: "net_leverage",
    unit: "turns",
    noun: "leverage",
  }),
  gross_interest: Object.freeze({
    node_id: "mechanical.interest_identified_total",
    field: "gross_interest",
    unit: "money",
    noun: "interest",
  }),
  ending_cash: Object.freeze({
    node_id: "mechanical.year_end_cash",
    field: "ending_cash",
    unit: "money",
    noun: "year-end cash",
  }),
});

// The bar, stated as numbers rather than as judgement.
//
// A question qualifies only if the two answers produce MATERIALLY different
// output. "Materially" has to mean something checkable or the cap of five is
// decided by taste. Each threshold is scale-relative except leverage, which is
// already a ratio and where a tenth of a turn is the smallest difference a
// credit committee would act on.
export const MATERIALITY_POLICY = Object.freeze({
  net_leverage: Object.freeze({
    kind: "absolute",
    threshold: 0.1,
    label: "0.1x of leverage",
  }),
  total_liquidity: Object.freeze({
    kind: "relative",
    scale_field: "total_liquidity",
    threshold: 0.02,
    label: "2% of liquidity",
  }),
  net_debt: Object.freeze({
    kind: "relative",
    scale_field: "gross_debt",
    threshold: 0.01,
    label: "1% of gross debt",
  }),
  gross_debt: Object.freeze({
    kind: "relative",
    scale_field: "gross_debt",
    threshold: 0.01,
    label: "1% of gross debt",
  }),
  gross_interest: Object.freeze({
    kind: "relative",
    scale_field: "gross_interest",
    threshold: 0.02,
    label: "2% of gross interest",
  }),
  ending_cash: Object.freeze({
    kind: "relative",
    scale_field: "total_liquidity",
    threshold: 0.02,
    label: "2% of liquidity",
  }),
});

// Order in which a consequence is preferred when an answer moves several
// headline metrics at once. Liquidity first because the commonest stage-3
// ambiguity is a facility commitment and "€400m drops out of liquidity" is the
// sentence that makes the question answerable; leverage last because it is a
// derived ratio and a reader wants the cause, not the symptom.
const CONSEQUENCE_PREFERENCE = Object.freeze([
  "total_liquidity",
  "net_debt",
  "gross_debt",
  "gross_interest",
  "ending_cash",
  "net_leverage",
]);

// ── G2 ─────────────────────────────────────────────────────────────────────

// The arithmetic of the debt, liquidity and interest blocks, written once, in
// the manifest's `depends_on` convention (consumer depends on precedent). Every
// pair is dropped unless both endpoints exist in the compiled manifest, so a
// profile that omits a block simply produces fewer edges rather than dangling
// ones.
// Mechanical dependencies are compiled by semantic_graph.mjs. This module
// consumes that single authority and never augments or repairs it.

// Compile the graph once per case and index it in both directions.
export function compileImpactGraph(modelCase, rowPlan = null) {
  const plan = rowPlan ?? compileRowPlan(modelCase);
  const manifest = compileSemanticManifest(modelCase, plan);
  // The semantic manifest is the sole graph authority. Mechanical edges used
  // to be reconstructed here, which meant the user-flow reachability test knew
  // dependencies the model manifest itself did not. Keep the count in the
  // report for compatibility, but it must remain zero.
  const augmented = [];
  const edges = manifest.edges;
  const forward = new Map(); // precedent -> consumers
  const addForward = (from, to) => {
    if (!forward.has(from)) forward.set(from, new Set());
    forward.get(from).add(to);
  };
  for (const edge of edges) {
    if (edge.edge_type === "depends_on") {
      // from depends on to, so a change in `to` propagates to `from`.
      addForward(edge.to, edge.from);
    } else if (
      edge.edge_type === "accrues_interest_to" ||
      edge.edge_type === "changes_balance"
    ) {
      addForward(edge.from, edge.to);
    }
  }
  return {
    manifest,
    augmented_edge_count: augmented.length,
    manifest_edge_count: manifest.edges.length,
    node_ids: new Set(manifest.nodes.map((node) => node.node_id)),
    forward,
  };
}

// What moves if this moves. Breadth-first over the forward index; the graph is
// small (low hundreds of nodes) so this is cheap enough to run per question.
export function forwardReachable(graph, seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of graph.forward.get(current) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  for (const seed of seeds) seen.delete(seed);
  return seen;
}

// Which headline metrics the graph says an answer can reach.
export function reachableHeadlines(graph, seeds) {
  const reached = forwardReachable(graph, seeds);
  const result = new Set();
  for (const [metric, spec] of Object.entries(HEADLINE_METRICS)) {
    if (reached.has(spec.node_id)) result.add(metric);
  }
  return result;
}

// ── differential solve ─────────────────────────────────────────────────────

export function deepClone(value) {
  return structuredClone(value);
}

function solveOrNull(modelCase) {
  try {
    return { solved: solveCase(modelCase), error: null };
  } catch (error) {
    return { solved: null, error: String(error?.message ?? error) };
  }
}

function seriesOf(solved, field) {
  return solved.forecast.map((year) => {
    const value = year[field];
    return value === null || value === undefined ? null : Number(value);
  });
}

function scaleOf(solved, field) {
  const values = seriesOf(solved, field)
    .filter((value) => value !== null)
    .map(Math.abs);
  return values.length > 0 ? Math.max(...values) : 0;
}

// The difference two answers make, measured on the model rather than asserted.
export function differentialImpact(baseCase, optionA, optionB) {
  const caseA = optionA.apply(deepClone(baseCase));
  const caseB = optionB.apply(deepClone(baseCase));
  const runA = solveOrNull(caseA);
  const runB = solveOrNull(caseB);
  if (!runA.solved && !runB.solved) {
    // Neither branch solves. Nothing about this is a question; the draft case is
    // broken and saying so is the only honest output.
    return {
      feasible: false,
      both_infeasible: true,
      infeasible_option: null,
      reason: runA.error,
      metrics: {},
      material: false,
      moved: new Set(),
    };
  }
  if (!runA.solved || !runB.solved) {
    // One branch does not solve at all. That is not an ambiguity the user can
    // settle — it is a fact the model already knows, and the feasible branch is
    // the answer. Recorded, never asked.
    return {
      feasible: false,
      both_infeasible: false,
      infeasible_option: runA.solved ? optionB.id : optionA.id,
      reason: runA.error ?? runB.error,
      metrics: {},
      material: false,
      moved: new Set(),
    };
  }
  const metrics = {};
  const moved = new Set();
  for (const [metric, spec] of Object.entries(HEADLINE_METRICS)) {
    const a = seriesOf(runA.solved, spec.field);
    const b = seriesOf(runB.solved, spec.field);
    let best = null;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] === null || b[index] === null) continue;
      const delta = b[index] - a[index];
      if (best === null || Math.abs(delta) > Math.abs(best.delta)) {
        best = {
          delta,
          period: runA.solved.forecast[index].period,
          period_index: index,
          value_a: a[index],
          value_b: b[index],
        };
      }
    }
    if (!best) continue;
    const policy = MATERIALITY_POLICY[metric];
    let material = false;
    let scale = null;
    if (policy.kind === "absolute") {
      material = Math.abs(best.delta) >= policy.threshold;
    } else {
      scale = Math.max(
        scaleOf(runA.solved, policy.scale_field),
        scaleOf(runB.solved, policy.scale_field),
      );
      material = scale > 0 && Math.abs(best.delta) / scale >= policy.threshold;
    }
    metrics[metric] = { ...best, material, scale, policy: policy.label };
    if (Math.abs(best.delta) > 1e-9) moved.add(metric);
  }
  const material = Object.values(metrics).some((entry) => entry.material);
  return {
    feasible: true,
    infeasible_option: null,
    reason: null,
    metrics,
    material,
    moved,
    solved_a: runA.solved,
    solved_b: runB.solved,
  };
}

// The consequence sentence, generated from the differential rather than typed.
// Every option must be able to state its consequence in money; if this returns
// null the question does not clear rule 3 and must not be asked.
export function consequenceOf(impact, currency, { units = "millions" } = {}) {
  if (!impact.feasible) return null;
  for (const metric of CONSEQUENCE_PREFERENCE) {
    const entry = impact.metrics[metric];
    if (!entry || !entry.material) continue;
    return {
      metric,
      delta: entry.delta,
      period: entry.period,
      unit: HEADLINE_METRICS[metric].unit,
      noun: HEADLINE_METRICS[metric].noun,
      currency,
      units,
    };
  }
  return null;
}

// The independence check. G2 says these metrics can move; the solver says these
// did. A metric that moved but is unreachable is a real disagreement between two
// separately-derived views of the model and is reported, not smoothed over.
export function crossCheckReachability(graph, seeds, impact) {
  const predicted = reachableHeadlines(graph, seeds);
  const observed = impact.moved ?? new Set();
  const moved_but_unreachable = [...observed]
    .filter((metric) => !predicted.has(metric))
    .sort();
  const reachable_but_static = [...predicted]
    .filter((metric) => !observed.has(metric))
    .sort();
  return {
    predicted: [...predicted].sort(),
    observed: [...observed].sort(),
    moved_but_unreachable,
    reachable_but_static,
    agrees: moved_but_unreachable.length === 0,
  };
}
