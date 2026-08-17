#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { FLOW_CONTROLLER_VERSION } from "./lib/flow_runtime.mjs";
import { writeRunCarrierMigrationReceipt } from "./lib/run_carrier.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : null;
}

async function main() {
  const carrierPath = process.argv[2] && !process.argv[2].startsWith("--")
    ? path.resolve(process.argv[2])
    : null;
  const runRoot = option("run-root");
  const outPath = option("out");
  const workspaceToken = option("workspace-token") ?? process.env.EXCEL_INFLOW_WORKSPACE_TOKEN;
  if (!carrierPath || !runRoot || !outPath || !workspaceToken) {
    throw new Error(
      "Usage: migrate_run_carrier.mjs <run-carrier.json> --run-root <run-folder> " +
      "--out <identity-migration-receipt.json> --workspace-token <token>",
    );
  }
  const result = await writeRunCarrierMigrationReceipt({
    skillRoot: ROOT,
    runRoot: path.resolve(runRoot),
    carrierPath,
    controllerVersion: FLOW_CONTROLLER_VERSION,
    workspaceToken,
    outPath: path.resolve(outPath),
  });
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    receipt: result.path,
    receipt_sha256: result.sha256,
    earliest_invalidated_stage: result.receipt.stage_invalidation.earliest_stage,
    invalidated_stages: result.receipt.stage_invalidation.invalidated_stages,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
