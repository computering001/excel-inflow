#!/usr/bin/env node
/**
 * One model-first controller: raw evidence transaction -> model decisions ->
 * sealed authority resolution -> existing workbook build and delivery.
 *
 * The proven case compiler, economic graph, solver, renderer and validators
 * remain unchanged. This controller replaces host-side stage choreography and
 * emits one typed outcome instead of surfacing internal lane states.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  authorityQualitySummary,
  validatePreBrokerDemandCoverage,
} from "./lib/run_constitution_graph.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTROLLER_VERSION = "excel-inflow-vnext/1.0";
let ACTIVE_RUNTIME_CLOSURE = null;
const STATE_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "excel-inflow-vnext-run.schema.json"), "utf8"),
);
const PRE_BROKER_DEMAND_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "pre-broker-model-demand-v1.schema.json"), "utf8"),
);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    options[key] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target) {
  return digestBytes(await fs.readFile(target));
}

async function runtimeClosure() {
  const profile = await readJson(path.join(ROOT, "assets", "deployment-profile.json"), "deployment profile");
  const members = [
    ...(profile.script_allowlist ?? []).map((item) => path.join("scripts", item)),
    ...(profile.python_module_allowlist ?? []).map((item) => path.join("scripts", item)),
    ...(profile.asset_allowlist ?? []).map((item) => path.join("assets", item)),
    ...(profile.reference_allowlist ?? []).map((item) => path.join("references", item)),
    "assets/deployment-profile.json",
    "assets/runtime-manifest.json",
    "release-manifest.json",
    "SKILL.md",
    "central-instructions.md",
  ];
  const hashes = {};
  for (const relative of [...new Set(members)].sort()) {
    const target = path.join(ROOT, relative);
    if (await fs.stat(target).then((entry) => entry.isFile()).catch(() => false)) {
      hashes[relative] = await sha256File(target);
    }
  }
  return digestBytes(canonicalJson(hashes));
}

async function readJson(target, label) {
  const value = JSON.parse(await fs.readFile(path.resolve(target), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value;
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, canonicalJson(value));
  await fs.rename(temporary, target);
}

function run(command, args, { cwd = ROOT, env = process.env, timeout = 3_600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out after ${timeout} ms.`));
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function checkpoint(id, status, target = null) {
  return {
    checkpoint_id: id,
    status,
    sha256: target && await fs.stat(target).then((entry) => entry.isFile()).catch(() => false)
      ? await sha256File(target)
      : null,
  };
}

async function finish({ out, runId, status, qualityMode, blockerClass, checkpoints, artifacts, summary }) {
  const artifactHashes = {};
  for (const [name, target] of Object.entries(artifacts)) {
    if (await fs.stat(target).then((entry) => entry.isFile()).catch(() => false)) {
      artifactHashes[name] = await sha256File(target);
    }
  }
  const state = {
    schema_version: "excel-inflow-vnext-run/1.0",
    controller_version: CONTROLLER_VERSION,
    runtime_closure_sha256: ACTIVE_RUNTIME_CLOSURE,
    run_id: runId,
    status,
    quality_mode: qualityMode,
    blocker_class: blockerClass,
    user_blocking: ["USER_DECISION", "FATAL_SOURCE"].includes(blockerClass),
    checkpoints,
    artifacts,
    artifact_sha256: artifactHashes,
    summary,
  };
  const errors = validateJsonSchema(state, STATE_SCHEMA);
  if (errors.length > 0) throw new Error(`vNext state failed schema: ${errors[0]}`);
  const statePath = path.join(out, "excel-inflow-vnext-run-state.json");
  await writeJson(statePath, state);
  process.stdout.write(`${JSON.stringify({ ...state, state: statePath }, null, 2)}\n`);
  return state;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = path.resolve(String(options.out ?? ""));
  if (!options.out || (!options["attachment-spec"] && !options["evidence-run"])) {
    throw new Error(
      "Usage: run_excel_inflow_vnext.mjs (--attachment-spec <controller-spec.json> | " +
      "--evidence-run <evidence-run.json>) --out <run-folder> [--answers <answers.json>] " +
      "[--attachment-state <state.json>] [--python <python>] [--soffice <path>] " +
      "[--workspace-token <token>]",
    );
  }
  if (out === ROOT || out.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("vNext run output must be outside the immutable skill tree.");
  }
  await fs.mkdir(out, { recursive: true });
  ACTIVE_RUNTIME_CLOSURE = await runtimeClosure();
  const pythonCommand = String(options.python ?? process.env.PYTHON ?? "python3");
  const pythonProbe = await run(pythonCommand, [
    "-c",
    "import os, openpyxl; print(os.path.dirname(os.path.dirname(openpyxl.__file__)))",
  ], { timeout: 30_000 });
  const pythonSite = pythonProbe.code === 0 ? pythonProbe.stdout.trim() : "";
  const runtimeEnv = pythonSite
    ? {
        ...process.env,
        PYTHONPATH: [pythonSite, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      }
    : process.env;
  const checkpoints = [];
  const artifacts = {};
  let evidencePath;
  let attachmentState = null;

  if (options["attachment-spec"]) {
    const attachmentOut = path.join(out, "evidence");
    await run(pythonCommand, [
      path.join(HERE, "run_attachment_evidence_pipeline.py"),
      path.resolve(String(options["attachment-spec"])),
      "--out",
      attachmentOut,
    ], { timeout: 3_600_000, env: runtimeEnv });
    const attachmentStatePath = path.join(attachmentOut, "attachment-evidence-run-state.json");
    attachmentState = await readJson(attachmentStatePath, "attachment evidence state");
    artifacts.attachment_state = attachmentStatePath;
    checkpoints.push(await checkpoint("raw_evidence", attachmentState.pipeline_status, attachmentStatePath));
    if (attachmentState.pipeline_status !== "PASS") {
      const fatal = attachmentState.blocker_class === "FATAL_SOURCE" || attachmentState.user_blocking === true;
      return finish({
        out,
        runId: attachmentState.run_id ?? "vnext-run",
        status: fatal ? "BLOCKED" : "NEEDS_INTERNAL_WORK",
        qualityMode: fatal ? "FATAL" : "INTERNAL_WORK",
        blockerClass: fatal ? "FATAL_SOURCE" : "INTERNAL_WORK",
        checkpoints,
        artifacts,
        summary: {
          message: fatal
            ? "A fatal raw-source boundary remains."
            : "The controller retains internal work; no user response or re-upload is requested.",
          lane_statuses: Object.fromEntries(Object.entries(attachmentState.lane_states ?? {}).map(([lane, state]) => [lane, state.pipeline_status])),
        },
      });
    }
    evidencePath = attachmentState.artifacts?.evidence_run;
    if (!evidencePath) throw new Error("PASS attachment state has no evidence_run artifact.");
    if (attachmentState.lane_states?.broker && attachmentState.lane_states?.filings) {
      const preBrokerDemandPath = attachmentState.artifacts?.pre_broker_model_demand;
      if (!preBrokerDemandPath) {
        throw new Error("PASS raw evidence omitted the filings-derived pre-broker demand artifact.");
      }
      artifacts.pre_broker_model_demand = preBrokerDemandPath;
      checkpoints.push(await checkpoint("pre_broker_demand", "PASS", preBrokerDemandPath));
    }
  } else {
    evidencePath = path.resolve(String(options["evidence-run"]));
    if (options["attachment-state"]) {
      const attachmentStatePath = path.resolve(String(options["attachment-state"]));
      attachmentState = await readJson(attachmentStatePath, "attachment evidence state");
      artifacts.attachment_state = attachmentStatePath;
    }
    checkpoints.push(await checkpoint("raw_evidence", "SUPPLIED", evidencePath));
  }

  const evidenceRun = await readJson(evidencePath, "evidence run");
  const runId = String(evidenceRun.run_id ?? "vnext-run");
  artifacts.evidence_run = evidencePath;
  const userFlowOut = path.join(out, "model");
  const workspaceToken = String(options["workspace-token"] ?? `vnext:${digestBytes(out).slice(0, 24)}`);
  const firstArgs = [
    path.join(HERE, "run_user_flow.mjs"),
    evidencePath,
    "--out",
    userFlowOut,
    "--workspace-token",
    workspaceToken,
    "--stop-after",
    "decisions",
    "--json",
  ];
  if (options.answers) firstArgs.push("--answers", path.resolve(String(options.answers)));
  if (options.python) firstArgs.push("--python", String(options.python));
  if (options.soffice) firstArgs.push("--soffice", String(options.soffice));
  await run(process.execPath, firstArgs, { timeout: 3_600_000, env: runtimeEnv });
  const userFlowResultPath = path.join(userFlowOut, "user-flow-result.json");
  let userFlowResult = await readJson(userFlowResultPath, "user-flow decision result");
  artifacts.user_flow_result = userFlowResultPath;
  checkpoints.push(await checkpoint("model_decisions", userFlowResult.status, userFlowResultPath));
  if (userFlowResult.status === "ACTION_REQUIRED") {
    return finish({
      out,
      runId,
      status: "ACTION_REQUIRED",
      qualityMode: "INPUT_REQUIRED",
      blockerClass: "USER_DECISION",
      checkpoints,
      artifacts,
      summary: {
        message: "One consolidated set of genuine model decisions remains.",
        question_count: userFlowResult.question_count ?? null,
        carrier: userFlowResult.carrier ?? null,
      },
    });
  }
  if (userFlowResult.status !== "PAUSED" || userFlowResult.stage !== "decisions") {
    const internal = userFlowResult.blocker_class !== "FATAL_SOURCE";
    return finish({
      out,
      runId,
      status: internal ? "NEEDS_INTERNAL_WORK" : "BLOCKED",
      qualityMode: internal ? "INTERNAL_WORK" : "FATAL",
      blockerClass: internal ? "INTERNAL_WORK" : "FATAL_SOURCE",
      checkpoints,
      artifacts,
      summary: {
        message: userFlowResult.message ?? "The existing model controller did not reach the build boundary.",
        outcome: userFlowResult.outcome ?? null,
      },
    });
  }

  const decisionsRoot = path.join(userFlowOut, "stages", "decisions");
  const forecastPlanPath = path.join(decisionsRoot, "forecast-plan.json");
  const demandGraphPath = path.join(decisionsRoot, "model-demand-graph.json");
  const authorityContractPath = path.join(decisionsRoot, "selected-authority-contract.json");
  const runGraphPath = path.join(decisionsRoot, "run-constitution-graph.json");
  const authorityContract = await readJson(
    authorityContractPath,
    "selected authority contract",
  );
  const modelDemandGraph = await readJson(demandGraphPath, "model demand graph");
  if (artifacts.pre_broker_model_demand) {
    const preBrokerDemand = await readJson(
      artifacts.pre_broker_model_demand,
      "pre-broker model demand",
    );
    const schemaErrors = validateJsonSchema(preBrokerDemand, PRE_BROKER_DEMAND_SCHEMA);
    const coverage = validatePreBrokerDemandCoverage(preBrokerDemand, modelDemandGraph);
    if (schemaErrors.length > 0 || !coverage.valid) {
      return finish({
        out,
        runId,
        status: "NEEDS_INTERNAL_WORK",
        qualityMode: "INTERNAL_WORK",
        blockerClass: "INTERNAL_WORK",
        checkpoints: [
          ...checkpoints,
          await checkpoint("pre_broker_demand_binding", "BLOCKED", demandGraphPath),
        ],
        artifacts,
        summary: {
          message: "The filings-derived demand graph did not survive intact into final authority resolution.",
          violations: [...schemaErrors, ...coverage.errors],
        },
      });
    }
    checkpoints.push(await checkpoint("pre_broker_demand_binding", "PASS", demandGraphPath));
  }
  const runGraph = await readJson(runGraphPath, "run constitution graph");
  const qualitySummary = authorityQualitySummary(authorityContract);
  artifacts.forecast_plan = forecastPlanPath;
  artifacts.model_demand_graph = demandGraphPath;
  artifacts.selected_authority_contract = authorityContractPath;
  artifacts.run_constitution_graph = runGraphPath;
  checkpoints.push(await checkpoint("authority_resolution", "PASS", runGraphPath));

  const resumeArgs = [
    path.join(HERE, "run_user_flow.mjs"),
    "--carrier",
    path.resolve(userFlowResult.carrier),
    "--out",
    userFlowOut,
    "--workspace-token",
    workspaceToken,
    "--json",
  ];
  if (options.python) resumeArgs.push("--python", String(options.python));
  if (options.soffice) resumeArgs.push("--soffice", String(options.soffice));
  await run(process.execPath, resumeArgs, { timeout: 3_600_000, env: runtimeEnv });
  userFlowResult = await readJson(userFlowResultPath, "user-flow delivery result");
  checkpoints.push(await checkpoint("build_and_delivery", userFlowResult.status, userFlowResultPath));
  if (userFlowResult.status !== "PASS_PENDING_MANUAL") {
    return finish({
      out,
      runId,
      status: userFlowResult.blocker_class === "FATAL_SOURCE" ? "BLOCKED" : "NEEDS_INTERNAL_WORK",
      qualityMode: userFlowResult.blocker_class === "FATAL_SOURCE" ? "FATAL" : "INTERNAL_WORK",
      blockerClass: userFlowResult.blocker_class === "FATAL_SOURCE" ? "FATAL_SOURCE" : "INTERNAL_WORK",
      checkpoints,
      artifacts,
      summary: {
        message: userFlowResult.message ?? "Workbook build or delivery validation did not close.",
        outcome: userFlowResult.outcome ?? null,
      },
    });
  }
  artifacts.delivery_file = userFlowResult.delivery_file;
  artifacts.live_delivery_attestation = userFlowResult.live_delivery_attestation;
  return finish({
    out,
    runId,
    status: "PASS_PENDING_MANUAL",
    qualityMode: authorityContract.quality_mode,
    blockerClass: null,
    checkpoints,
    artifacts,
    summary: {
      message: "The model was built and independently validated; native Excel review remains the declared manual gate.",
      delivery_file: userFlowResult.delivery_file,
      workbook_sha256: userFlowResult.delivery_file_sha256,
      quality_receipt_sha256: runGraph.graph_sha256,
      quarantined_evidence_count: qualitySummary.quarantined_evidence_count,
      fallback_count: qualitySummary.fallback_count,
      total_violations: userFlowResult.total_violations,
    },
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
