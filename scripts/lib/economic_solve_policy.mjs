import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./json_schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../assets");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ASSETS, name), "utf8"));
}

export const ECONOMIC_SOLVE_POLICY_SCHEMA = readJson("economic-solve-policy.v1.schema.json");

function duplicates(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

export function validateEconomicSolvePolicy(policy) {
  const errors = validateJsonSchema(policy, ECONOMIC_SOLVE_POLICY_SCHEMA);
  if (errors.length > 0) return errors;
  const expectedSequence = JSON.stringify([1, 0, 1, 0, 1]);
  for (const [controlId, control] of Object.entries(policy.controls)) {
    if (JSON.stringify(control.allowed_values) !== JSON.stringify([0, 1])) errors.push(`controls.${controlId}.allowed_values must be exactly [0,1].`);
    if (JSON.stringify(control.native_sequence) !== expectedSequence) errors.push(`controls.${controlId}.native_sequence must be exactly [1,0,1,0,1].`);
  }
  if (policy.workbook_calculation.iterate_count !== policy.solver.max_iterations) errors.push("workbook_calculation.iterate_count must equal solver.max_iterations.");
  if (policy.workbook_calculation.iterate_delta !== policy.native_tolerances.currency) errors.push("workbook_calculation.iterate_delta must exactly equal native_tolerances.currency.");
  if (policy.native_tolerances.relative !== policy.solver.relative_tolerance) errors.push("native_tolerances.relative must equal solver.relative_tolerance.");
  for (const role of duplicates(policy.circularity_roles.zero_when_off)) errors.push(`circularity_roles.zero_when_off duplicates ${role}.`);
  for (const role of duplicates(policy.circularity_roles.live_when_off)) errors.push(`circularity_roles.live_when_off duplicates ${role}.`);
  const overlap = policy.circularity_roles.zero_when_off.filter((role) => policy.circularity_roles.live_when_off.includes(role));
  if (overlap.length > 0) errors.push(`Circularity roles cannot be both zero and live when off: ${overlap.join(", ")}.`);
  return errors;
}

const policy = readJson("economic-solve-policy.v1.json");
const policyErrors = validateEconomicSolvePolicy(policy);
if (policyErrors.length > 0) throw new Error(`Invalid economic solve policy:\n- ${policyErrors.join("\n- ")}`);

export const ECONOMIC_SOLVE_POLICY = Object.freeze(policy);
export function solverIterationOptions() { return { tolerance: policy.solver.absolute_tolerance, maxIterations: policy.solver.max_iterations }; }
export function workbookCalcProperties() { return structuredClone(policy.workbook_calculation); }
export function circularityRoleRegistry() { return structuredClone(policy.circularity_roles); }
