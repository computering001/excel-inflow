import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONSTITUTION_PATH = path.join(ROOT, "assets", "delivery-constitution-v1.json");

export const DELIVERY_CONSTITUTION = Object.freeze(
  JSON.parse(fs.readFileSync(CONSTITUTION_PATH, "utf8")),
);

function requiredFlag(finding, name) {
  switch (name) {
    case "unresolved": return finding.unresolved === true;
    case "material": return finding.material === true;
    case "reachable_to_material_output": return finding.reachable_to_material_output === true;
    case "no_alternative_authority_path": return finding.alternative_authority_path_exists !== true;
    case "mandatory_evidence_lane": return DELIVERY_CONSTITUTION.lanes[finding.lane] === "mandatory";
    case "finite_user_resolution_available": return finding.finite_user_resolution_available === true;
    default: throw new Error(`Unknown delivery-constitution predicate ${name}.`);
  }
}

function predicatePasses(predicate, finding) {
  return predicate.all.every((name) => requiredFlag(finding, name));
}

export function classifyDeliveryFinding(finding) {
  const laneCriticality = DELIVERY_CONSTITUTION.lanes[finding.lane];
  if (!laneCriticality) throw new Error(`Unknown delivery-constitution lane ${finding.lane}.`);
  if (laneCriticality === "optional") {
    return finding.reachable_to_material_output === true || finding.unresolved === true
      ? "DEGRADE"
      : "LOG";
  }
  if (predicatePasses(DELIVERY_CONSTITUTION.ask_predicate, finding)) return "ASK";
  if (predicatePasses(DELIVERY_CONSTITUTION.block_predicate, finding)) return "BLOCK";
  return finding.reachable_to_material_output === true ? "DEGRADE" : "LOG";
}

export function assertBrokerFailureDegrades(reason) {
  if (!DELIVERY_CONSTITUTION.degrade_reasons.includes(reason)) {
    throw new Error(`Broker failure reason ${reason} is not registered for degradation.`);
  }
  const owner = classifyDeliveryFinding({
    lane: "broker",
    unresolved: true,
    material: true,
    reachable_to_material_output: true,
    alternative_authority_path_exists: false,
    finite_user_resolution_available: false,
  });
  if (owner !== "DEGRADE") {
    throw new Error(`Optional broker failure mutated to ${owner}; DEGRADE is required.`);
  }
  return owner;
}
