#!/usr/bin/env node
/**
 * P6.0a — Terminal-outcome crash paths.
 *
 * Invariant: no controller path terminates in an uncaught throw or an
 * unlawful category crossing. (a) An internal decision-graph failure surfaces
 * as an internal-owned status, never as user-owned ACTION_REQUIRED
 * (TOC.D crossing 1). (b) The OUTER controller serialises a typed
 * internal-failure payload on its terminal catch exactly as the delegate
 * already does, with one typed summary line — never a stack — on the public
 * stderr (TOC.C vnext gap + TOC.F).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normaliseUserFlowResult } from "./lib/workflow_state.mjs";

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

// 1. The former crossing stays illegal: an internal decision-graph failure
// minted as user-owned ACTION_REQUIRED is rejected by the workflow contract
// (this was the pre-repair mint at run_user_flow.mjs and threw uncaught).
for (const outcome of ["decision_replay_blocked", "decision_graph_blocked"]) {
  let caught = null;
  try {
    normaliseUserFlowResult({
      schema_version: "user-flow-run/1.0",
      run_id: "crash-path-proof",
      status: "ACTION_REQUIRED",
      stage: "decisions",
      outcome,
      blocker_class: "INTERNAL_WORK",
      reused_stages: [],
    });
  } catch (error) {
    caught = error;
  }
  check(
    caught !== null && /ACTION_REQUIRED cannot own blocker class/.test(caught.message),
    `${outcome}: ACTION_REQUIRED+INTERNAL_WORK must stay contract-illegal`,
  );
}

// 2. The repaired mint is lawful: the same internal outcomes surface as the
// internal-owned BLOCKED state with derived non-user-blocking ownership and
// the constitution's declared fatal binding (equation_system_unsolved).
for (const outcome of ["decision_replay_blocked", "decision_graph_blocked"]) {
  const clean = normaliseUserFlowResult({
    schema_version: "user-flow-run/1.0",
    run_id: "crash-path-proof",
    status: "BLOCKED",
    stage: "decisions",
    outcome,
    blocker_class: "INTERNAL_WORK",
    typed_internal_outcome: {
      reason_code: "INTERNAL.equation_system_unsolved",
      earliest_responsible_layer: "decision_graph",
      downstream_invalidation_scope: "decisions_stage_and_descendants",
    },
    reused_stages: [],
  });
  check(clean.user_blocking === false, `${outcome}: internal work must not block the user`);
  check(
    clean.fatal_reason === "equation_system_unsolved" && clean.blocker_domain === "equation_graph",
    `${outcome}: the constitution binding must attach`,
  );
  check(
    clean.typed_internal_outcome.reason_code in registry.reason_codes,
    `${outcome}: the typed reason code must be registered`,
  );
}

// 3. Static pin on the delegate mint branch: the decisions-stage stop routes
// internal blockers away from ACTION_REQUIRED, attaches the registered typed
// outcome, and keeps the genuine user-decision ASK exit intact.
{
  const source = await fs.readFile(path.join(HERE, "run_user_flow.mjs"), "utf8");
  check(
    source.includes('blockerForStoppedOutcome(intakeResult.outcome) === "INTERNAL_WORK"'),
    "the decisions-stage stop must discriminate internal ownership",
  );
  const branch = source.slice(
    source.indexOf("const internalDecisionFailure"),
    source.indexOf("result: decisionStopResult"),
  );
  check(
    branch.includes('status: "BLOCKED"') &&
      branch.includes('reason_code: "INTERNAL.equation_system_unsolved"'),
    "the internal decision-graph mint must be BLOCKED with a registered reason code",
  );
  check(
    branch.includes('status: "ACTION_REQUIRED"') &&
      branch.includes("blocker_class: blockerForStoppedOutcome(intakeResult.outcome)"),
    "the user-owned ASK exit at this site must remain for user-owned outcomes",
  );
}

// 4. END-TO-END: the OUTER controller's terminal catch. Drive the sole public
// bootstrap into run_excel_inflow_vnext and a real early internal failure (an unreadable
// evidence-run) and read the serialised artifact: exit 1, all five registry
// payload fields, the stack preserved in the artifact, and ONE typed summary
// line — no stack frames — on the public stderr.
{
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-crash-path-"));
  const runDir = path.join(out, "run");
  const missingEvidence = path.join(out, "does-not-exist.json");
  const execution = await exec(process.execPath, [
    path.join(HERE, "run_excel_inflow_bootstrap.mjs"),
    "--evidence-run",
    missingEvidence,
    "--out",
    runDir,
  ], { timeout: 120_000 }).then(
    (ok) => ({ code: 0, ...ok }),
    (error) => ({ code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "", killed: error.killed }),
  );
  check(execution.killed !== true, "the failed controller must exit on its own (no hung heartbeat)");
  check(execution.code === 1, `an internal controller failure must exit 1, got ${execution.code}`);
  const artifact = JSON.parse(
    await fs.readFile(path.join(runDir, "internal-failure.json"), "utf8"),
  );
  check(
    artifact.schema_version === "excel-inflow-internal-failure/1.0",
    "the outer catch must serialise the internal-failure schema",
  );
  for (const field of PAYLOAD_FIELDS) {
    check(field in artifact && artifact[field], `internal-failure.json must carry ${field}`);
  }
  check(
    artifact.reason_code === "INTERNAL.compiler_or_graph_defect",
    "an untyped throw must default to the compiler_or_graph_defect reason",
  );
  check(
    artifact.stack.includes("at "),
    "the full stack must be preserved inside the artifact",
  );
  const stderrLines = String(execution.stderr).split("\n");
  const summaryLines = stderrLines.filter((line) => line.startsWith("INTERNAL_FAILURE "));
  check(
    summaryLines.length === 1 && summaryLines[0].includes("INTERNAL.compiler_or_graph_defect"),
    "the public stderr must carry exactly one typed summary line",
  );
  check(
    !stderrLines.some((line) => /^\s+at /.test(line)),
    "no stack frame may reach the public stderr from the terminal catch",
  );
  await fs.rm(out, { recursive: true, force: true });
}

// 5. Static pin on the outer catch: it honors a typed internal outcome when
// the throw carries one and does not print the stack.
{
  const source = await fs.readFile(path.join(HERE, "run_excel_inflow_vnext.mjs"), "utf8");
  const catchBody = source.slice(source.indexOf("main().catch"));
  check(
    catchBody.includes('error?.typed_internal_outcome?.reason_code ?? "INTERNAL.compiler_or_graph_defect"'),
    "the outer catch must honor error.typed_internal_outcome with the registered fallback",
  );
  check(
    !catchBody.includes("process.stderr.write(`${error.stack"),
    "the outer catch must never print the raw stack to the public boundary",
  );
}

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
