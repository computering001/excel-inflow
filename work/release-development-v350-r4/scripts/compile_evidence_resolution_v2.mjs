#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  compileEvidenceResolutionV2,
  evidenceResolutionCanonicalJson,
} from "./lib/evidence_resolution_v2.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readJson(target, label, required = true) {
  if (!target) {
    if (required) throw new Error(`${label} path is required.`);
    return null;
  }
  const value = JSON.parse(await fs.readFile(path.resolve(target), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value;
}

async function main() {
  const evidencePath = process.argv[2];
  const outPath = option("out");
  if (!evidencePath || !outPath) {
    throw new Error(
      "Usage: compile_evidence_resolution_v2.mjs <evidence-run.json> " +
      "[--forecast-plan <forecast-plan.json>] [--attachment-state <state.json>] " +
      "[--case-report <report.json>] --out <resolution.json>",
    );
  }
  const evidenceRun = await readJson(evidencePath, "evidence run");
  const forecastPlan = await readJson(option("forecast-plan"), "forecast plan", false);
  const attachmentState = await readJson(option("attachment-state"), "attachment state", false);
  const caseCompileReport = await readJson(option("case-report"), "case compile report", false);
  const laneStates = attachmentState?.lane_states ?? {};
  const result = compileEvidenceResolutionV2({
    evidenceRun,
    forecastPlan,
    laneStates,
    caseCompileReport,
  });
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(path.resolve(outPath), evidenceResolutionCanonicalJson(result));
  process.stdout.write(`${result.status}: ${result.quality_mode} (${result.receipt.resolution_sha256})\n`);
  process.exitCode = ["PASS", "PASS_DEGRADED"].includes(result.status) ? 0 : 2;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
