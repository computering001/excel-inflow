#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  validateCircularityPair,
  validateFixedPointSolution,
} from "./lib/fixed_point_constitution.mjs";
import { solveCase } from "./lib/solver.mjs";

function casesFromArguments(arguments_) {
  const paths = [];
  const entries = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const entry = arguments_[index];
    if (entry === "--manifest") {
      const manifestPath = arguments_[index + 1];
      if (!manifestPath) throw new Error("--manifest requires a JSON path.");
      const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
      if (
        manifest.schema_version !== "fixed-point-case-manifest/1.0" ||
        !Array.isArray(manifest.cases) ||
        manifest.cases.length === 0
      ) {
        throw new Error("Fixed-point case manifest is malformed or empty.");
      }
      const base = path.dirname(path.resolve(manifestPath));
      entries.push(...manifest.cases.map((item) => path.resolve(base, String(item))));
      index += 1;
      continue;
    }
    entries.push(entry);
  }
  for (const entry of entries) {
    const resolved = path.resolve(entry);
    if (!fs.existsSync(resolved)) throw new Error(`Case input not found: ${resolved}`);
    if (fs.statSync(resolved).isDirectory()) {
      for (const name of fs.readdirSync(resolved).filter((item) => item.endsWith(".json")).sort()) {
        paths.push(path.join(resolved, name));
      }
    } else {
      paths.push(resolved);
    }
  }
  return paths;
}

const casePaths = casesFromArguments(process.argv.slice(2));
if (casePaths.length === 0) {
  throw new Error(
    "usage: node scripts/run_fixed_point_constitution_tests.mjs <case.json> [case.json ...] | --manifest <fixed-point-cases.json>",
  );
}

const results = [];
let mutationSource = null;
for (const casePath of casePaths) {
  const modelCase = JSON.parse(fs.readFileSync(casePath, "utf8"));
  const onCase = structuredClone(modelCase);
  onCase.controls.circularity = 1;
  const offCase = structuredClone(modelCase);
  offCase.controls.circularity = 0;
  const on = solveCase(onCase);
  const off = solveCase(offCase);
  const errors = validateCircularityPair(modelCase, on, off);
  assert.deepEqual(errors, [], `${modelCase.case_id}: ${errors.join(" | ")}`);
  const materialSweepIndex = off.forecast.findIndex(
    (period) =>
      Math.abs(Number(period.rcf_draw ?? 0)) > 1e-6 ||
      Math.abs(Number(period.rcf_repayment ?? 0)) > 1e-6,
  );
  if (!mutationSource && materialSweepIndex >= 0) {
    mutationSource = { modelCase, off, materialSweepIndex };
  }
  results.push({
    case_id: modelCase.case_id,
    circularity_on: {
      iterations: on.iterations,
      residual: on.residual,
      active_scc_nodes:
        on.equation_graph_evidence.active_sccs[0]?.nodes.length ?? 0,
    },
    circularity_off: {
      iterations: off.iterations,
      residual: off.residual,
      active_scc_nodes: off.equation_graph_evidence.active_sccs.length,
      material_sweep_periods: off.forecast.filter(
        (period) =>
          Math.abs(Number(period.rcf_draw ?? 0)) > 1e-6 ||
          Math.abs(Number(period.rcf_repayment ?? 0)) > 1e-6,
      ).length,
    },
  });
}

const firstCase = JSON.parse(fs.readFileSync(casePaths[0], "utf8"));
firstCase.controls.circularity = 0;
const firstOff = solveCase(firstCase);
const mutations = [];
function mutation(name, mutate, fragment, baseCase = firstCase, baseSolution = firstOff) {
  const candidate = structuredClone(baseSolution);
  mutate(candidate);
  const errors = validateFixedPointSolution(baseCase, candidate);
  assert.ok(
    errors.some((error) => error.includes(fragment)),
    `${name} should fail with ${fragment}; got ${errors.join(" | ")}`,
  );
  mutations.push({ name, status: "PASS", violations: errors.length });
}

mutation(
  "interest survives breaker",
  (solution) => { solution.forecast[0].gross_interest = 1; },
  "gross_interest_expense is 1 with circularity off",
);
mutation(
  "solver vector missing node",
  (solution) => { solution.equation_graph_evidence.solver_declaration.state_vector.push({ node_id: "cash.cfo", tolerance_class: "currency" }); },
  "state_vector",
);
mutation(
  "runtime tolerance drift",
  (solution) => { solution.equation_graph_evidence.solver_runtime.absolute_tolerance = 1e-4; },
  "absolute_tolerance drifted",
);
mutation(
  "reported convergence tolerance drift",
  (solution) => { solution.convergence_tolerance = 1e-4; },
  "convergence_tolerance drifted",
);

assert.ok(
  mutationSource,
  "at least one supplied archetype must exercise a real RCF draw or repayment in breaker mode",
);
{
  const { modelCase, off, materialSweepIndex } = mutationSource;
  const offCase = structuredClone(modelCase);
  offCase.controls.circularity = 0;
  mutation(
    "disabled RCF sweep",
    (solution) => {
      const period = solution.forecast[materialSweepIndex];
      period.rcf_draw = 0;
      period.rcf_draw_native = 0;
      period.rcf_repayment = 0;
      period.rcf_repayment_native = 0;
    },
    "does not match independently recomputed sweep value",
    offCase,
    off,
  );
}

console.log(JSON.stringify({
  status: "PASS",
  archetypes: results,
  mutations,
}, null, 2));
