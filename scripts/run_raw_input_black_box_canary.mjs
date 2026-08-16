#!/usr/bin/env node

/**
 * Compatibility entrypoint for one transition release.
 *
 * This wrapper authors no semantic response and makes no black-box or
 * installed-host claim.  The invoked target is the explicitly named local
 * simulated-semantic component canary.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "run_raw_input_local_semantic_canary.mjs");
console.error("Deprecated compatibility entrypoint: running the local simulated-semantic canary; this is not installed-host evidence.");
const completed = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (completed.error) throw completed.error;
process.exitCode = completed.status ?? 1;
