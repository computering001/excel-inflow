#!/usr/bin/env node
/**
 * P3.7 — Typed resumable internal outcomes.
 *
 * Invariant: an internal forecast/solve failure carries a registered reason
 * code and the registry's five payload fields; a bare stack print is not a
 * terminal state.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sealEconomicStageParity } from "./lib/forecast_completion_constitution.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

const registry = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"),
);
const PAYLOAD_FIELDS = registry.internal_failure_payload_requirements;

// 1. The parity seal's refusal is a TYPED outcome with a registered code.
{
  const escalating = {
    case_id: "typed-outcome-probe",
    statement_structure: {
      income_statement: [{
        row_id: "revenue", row_type: "input", material: true,
        values: [1, 2, 3, null, null, null],
      }],
      cash_flow: [],
    },
  };
  let caught = null;
  try { sealEconomicStageParity(escalating); } catch (error) { caught = error; }
  check(caught !== null, "an escalating case must refuse the parity seal");
  const typed = caught.typed_internal_outcome;
  check(typed?.reason_code === "INTERNAL.forecast_completion_escalated",
    "the refusal must carry its registered reason code");
  check(typed.reason_code in registry.reason_codes,
    "the reason code must exist in the terminal-reason registry");
  check(registry.reason_codes[typed.reason_code].allowed_terminal_states.join() === "INTERNAL_FAILURE",
    "an internal category maps only to INTERNAL_FAILURE");
  check(typeof typed.earliest_responsible_layer === "string" &&
    typeof typed.downstream_invalidation_scope === "string",
    "the typed outcome names its layer and invalidation scope");
}

// 2. The other two typed throw sites carry REGISTERED codes (static proof —
// triggering a real solver non-convergence or ownership block needs a full
// pathological case; the code contract is what this invariant pins).
for (const [file, code] of [
  ["scripts/lib/forecast_ownership_resolver.mjs", "INTERNAL.forecast_ownership_blocked"],
  ["scripts/lib/solver.mjs", "INTERNAL.equation_system_unsolved"],
]) {
  const body = await fs.readFile(path.join(ROOT, file), "utf8");
  check(body.includes(`reason_code: "${code}"`),
    `${file} must attach the typed outcome ${code}`);
  check(code in registry.reason_codes, `${code} must be registered`);
}

// 3. END-TO-END: the terminal catch serialises internal-failure.json with all
// five registry payload fields — proven by driving run_user_flow into a real
// internal failure (an unreadable evidence file) and reading the artifact.
{
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "internal-outcome-"));
  const evidencePath = path.join(out, "broken-evidence.json");
  await fs.writeFile(evidencePath, "{\"schema_version\": \"not-an-evidence-run\"}", "utf8");
  const runDir = path.join(out, "run");
  await exec(process.execPath, [
    path.join(HERE, "test-support", "authenticated_controller_test_harness.mjs"),
    "user_flow",
    evidencePath, "--out", runDir, "--stop-after", "decisions", "--json",
  ], { cwd: ROOT, timeout: 120000 }).catch(() => {});
  const artifactPath = path.join(runDir, "internal-failure.json");
  const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8").catch(() => "null"));
  check(artifact !== null, "an internal failure must serialise internal-failure.json");
  for (const field of PAYLOAD_FIELDS) {
    check(field in artifact, `internal-failure.json must carry ${field}`);
  }
  check(artifact.reason_code in registry.reason_codes,
    "the serialised reason code must be registered");
  await fs.rm(out, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "PASS", checks }));
