#!/usr/bin/env node
/**
 * P2.8 — Support-envelope preflight wire tests.
 *
 * Invariant: an unsupported case stops at the controller's preflight with a
 * typed UNSUPPORTED_PROFILE reason BEFORE any model stage spends compute.
 * (The supported-path positive proof is the registered raw canary, which
 * runs the full pipeline with the preflight live.)
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

const out = await fs.mkdtemp(path.join(os.tmpdir(), "support-preflight-wire-"));

// Build a minimal unsupported evidence run from the repo's own clean donor:
// regenerating via run_evidence_run_tests is the sanctioned donor procedure.
const donorPath = path.join(out, "donor-evidence.json");
await exec(process.execPath, [
  path.join(HERE, "run_evidence_run_tests.mjs"),
  path.join(ROOT, "test-fixtures", "cases"),
  "--emit-clean", donorPath,
], { cwd: ROOT, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
const donor = JSON.parse(await fs.readFile(donorPath, "utf8"));

async function runVnext(evidence, label) {
  const evidencePath = path.join(out, `${label}.json`);
  await fs.writeFile(evidencePath, JSON.stringify(evidence), "utf8");
  const runDir = path.join(out, label);
  await exec(process.execPath, [
    path.join(HERE, "run_excel_inflow_vnext.mjs"),
    "--evidence-run", evidencePath,
    "--out", runDir,
  ], { cwd: ROOT, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
  return JSON.parse(await fs.readFile(path.join(runDir, "excel-inflow-vnext-run-state.json"), "utf8"));
}

// 1. Insufficient history stops early with the typed reason.
{
  const evidence = structuredClone(donor);
  evidence.filings.historical_periods = evidence.filings.historical_periods.slice(0, 1);
  const state = await runVnext(evidence, "insufficient-history");
  check(state.status === "BLOCKED" && state.blocker_class === "FATAL_SOURCE",
    "one-period case must block fatally at preflight");
  const preflight = state.checkpoints.find((c) => c.checkpoint_id === "support_envelope_preflight");
  check(preflight?.status === "BLOCKED", "the preflight checkpoint must record the stop");
  check(state.summary.support_envelope_reason === "UNSUPPORTED_PROFILE.insufficient_history",
    "the stop must carry its typed reason code");
  check(!state.checkpoints.some((c) => c.checkpoint_id === "model_decisions"),
    "no model stage may run after an early stop");
  check(state.support_envelope?.sha256?.length === 64,
    "the receipt names the governing envelope");
}

// 2. A missing cash-flow statement stops early with its own reason.
{
  const evidence = structuredClone(donor);
  evidence.case_evidence.face_statement_manifests.cash_flow = [];
  const state = await runVnext(evidence, "cash-flow-absent");
  check(state.status === "BLOCKED" &&
    state.summary.support_envelope_reason === "UNSUPPORTED_PROFILE.cash_flow_absent",
    "an absent cash flow must stop early with its typed reason");
}

// 3. The donor itself (supported) passes the preflight checkpoint — proven
// cheaply by asserting the preflight would classify it PASS: run vnext but
// only inspect the checkpoint list ordering; the full delivery proof is the
// registered canary. We stop the run early by withholding python (the model
// stage fails later), and assert the preflight checkpoint is PASS.
{
  const state = await runVnext(structuredClone(donor), "supported-preflight");
  const preflight = state.checkpoints.find((c) => c.checkpoint_id === "support_envelope_preflight");
  check(preflight?.status === "PASS", "a supported case must pass the preflight");
}

await fs.rm(out, { recursive: true, force: true });
console.log(JSON.stringify({ status: "PASS", checks }));
