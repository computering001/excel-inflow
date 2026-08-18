#!/usr/bin/env node
/**
 * Portable, resumable release orchestration for user-flow Stage 4.
 *
 * The visible user flow remains five stages. This controller subdivides only
 * BUILD AND CHECKS into silent, content-addressed checkpoints so a killed deployment host
 * invocation resumes from the last verified boundary. A later process may
 * reuse those checkpoints only when the immutable run identity and
 * workspace/session token match; the outer run carrier owns fresh-chat handoff.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  RELEASE_CHECKPOINT_CONTROLLER,
  ReleaseCheckpointStore,
} from "./lib/release_checkpoint_store.mjs";
import { runReleaseN0N9 } from "./lib/release_nodes.mjs";
import {
  canonicalJson,
  comparePortablePaths,
  hashDirectory,
  hashFile,
  hashFiles,
  hashValue,
} from "./lib/run_store.mjs";
import { runProcessTree } from "./lib/process_tree.mjs";
import {
  RuntimeStageBudgetLedger,
  stage4BudgetStage,
  validateRuntimeBudgetPolicy,
} from "./lib/runtime_budget_policy.mjs";
import { resolveActiveSourceIdentity } from "./lib/source_identity.mjs";
import {
  acquireRunLease,
  assertRunRootOutsideSkill,
  assertRuntimeIntegrityUnchanged,
  atomicWriteJson as writeIsolationJson,
  captureRuntimeIntegrity,
  initializeOrVerifyRunIdentity,
  releaseRunLease,
  validateRunId,
} from "./lib/runtime_isolation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ASSETS = path.join(ROOT, "assets");
let COMMAND_CWD = process.cwd();
let COMMAND_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
let ACTIVE_RUN_GUARD = null;
let ACTIVE_STAGE4_BUDGET = null;
let ACTIVE_STAGE4_BUDGET_TOKEN = null;
let ACTIVE_STAGE4_BUDGET_RECEIPT_PATH = null;
const CHECKPOINT_ORDER = Object.freeze([
  "semantic_gates",
  "plan",
  "emit",
  "recalculate",
  "terminal_patch",
  "verify_dynamic",
  "verify_style",
  "verify_cache",
  "verify_finance",
  "verify_semantic",
  "verify_aggregate",
  "render",
  "publish",
]);
const SIDECAR_SUFFIXES = Object.freeze([
  ".plan.json",
  ".row-map.json",
  ".solution.json",
  ".coverage.json",
  ".semantic-manifest.json",
  ".source-crosswalk.csv",
  ".forecast-receipt.json",
  ".forecast-receipt.csv",
  ".shadow-comparison.json",
  ".model-ir-v3.json",
  ".transformation-receipt.json",
  ".workbook-proof-contract.json",
]);

const fail = (message, detail = {}) => ({ status: "BLOCKED", message, ...detail });

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

async function json(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function command(binary, args, options = {}) {
  let timeout = options.timeout ?? 180000;
  const stage = ACTIVE_STAGE4_BUDGET_TOKEN?.stage ?? null;
  if (stage && ACTIVE_STAGE4_BUDGET) {
    const activeElapsed = Math.max(0, Date.now() - ACTIVE_STAGE4_BUDGET_TOKEN.started);
    const remaining = Math.max(0, ACTIVE_STAGE4_BUDGET.remaining(stage) - activeElapsed);
    timeout = Math.max(1, Math.min(Number(timeout), remaining));
  }
  const result = await runProcessTree(binary, args, {
    cwd: options.cwd ?? COMMAND_CWD,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env: options.env ?? COMMAND_ENV,
  });
  if (stage) ACTIVE_STAGE4_BUDGET?.noteProcessResult(stage, result);
  return result;
}

function sizeAwareTimeout(bytes, {
  baseMs = 180000,
  perMiBMs = 30000,
  maximumMs = 900000,
} = {}) {
  const mebibytes = Math.max(1, Math.ceil(Number(bytes ?? 0) / (1024 * 1024)));
  return Math.min(maximumMs, baseMs + mebibytes * perMiBMs);
}

async function workbookExecutionPolicy(workbook) {
  const stat = await fs.stat(workbook);
  const timeoutMs = sizeAwareTimeout(stat.size);
  return {
    workbook_bytes: stat.size,
    timeout_ms: timeoutMs,
    validator_concurrency: stat.size >= 20 * 1024 * 1024 ? 1 : stat.size >= 8 * 1024 * 1024 ? 2 : 3,
  };
}

async function visibleWorkbookSheets(python, workbook) {
  const probe = await command(python.path, [
    "-c",
    [
      "import json,sys",
      "from openpyxl import load_workbook",
      "book=load_workbook(sys.argv[1], read_only=True, data_only=False)",
      "print(json.dumps([sheet.title for sheet in book.worksheets if sheet.sheet_state == 'visible']))",
      "book.close()",
    ].join(";"),
    workbook,
  ], { timeout: 60_000 });
  if (!probe.ok) {
    throw new Error(`Visible-sheet inventory failed: ${(probe.stderr || probe.stdout).slice(-2000)}`);
  }
  const sheets = JSON.parse(probe.stdout.trim());
  if (!Array.isArray(sheets) || sheets.length === 0 || sheets.some((item) => typeof item !== "string" || !item)) {
    throw new Error("Visible-sheet inventory returned no usable sheet names.");
  }
  return sheets;
}

function renderLeafId(index) {
  return `render_sheet_${String(index + 1).padStart(2, "0")}`;
}

async function resolveSoffice(explicit) {
  const candidates = [
    explicit,
    process.env.SOFFICE_BIN,
    "soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = await command(candidate, ["--version"], { timeout: 30000 });
    if (probe.ok) {
      const version = probe.stdout.trim() || probe.stderr.trim();
      return {
        path: candidate,
        version,
        identity: hashValue({ path: candidate, version }),
      };
    }
  }
  return null;
}

async function resolvePython(explicit) {
  const candidate = explicit ?? "python3";
  const probe = await command(candidate, [
    "-c",
    "import json,platform,sys; import openpyxl; print(json.dumps({'python':platform.python_version(),'implementation':platform.python_implementation(),'openpyxl':openpyxl.__version__},sort_keys=True))",
  ], { timeout: 30000 });
  if (!probe.ok) return null;
  let runtime;
  try {
    runtime = JSON.parse(probe.stdout.trim());
  } catch {
    return null;
  }
  return {
    path: candidate,
    runtime,
    identity: hashValue({ path: candidate, runtime }),
  };
}

async function recalcWithSoffice(soffice, sourceWorkbook, targetWorkbook, workDir, timeoutMs) {
  await fs.mkdir(workDir, { recursive: true });
  await fs.copyFile(sourceWorkbook, targetWorkbook);
  const recalcDir = await fs.mkdtemp(path.join(workDir, "recalc-"));
  const profile = await fs.mkdtemp(path.join(workDir, "soffice-profile-"));
  try {
    const result = await command(soffice, [
      "--headless",
      `-env:UserInstallation=file://${profile}`,
      "--norestore",
      "--invisible",
      "--nologo",
      "--nolockcheck",
      "--nodefault",
      "--nofirststartwizard",
      "--convert-to",
      "xlsx",
      "--outdir",
      recalcDir,
      targetWorkbook,
    ], { timeout: timeoutMs });
    const converted = path.join(recalcDir, path.basename(targetWorkbook));
    if (!result.ok) return fail("LibreOffice recalculation failed.", { stderr: result.stderr.slice(-4000) });
    await fs.access(converted);
    await fs.copyFile(converted, targetWorkbook);
    return {
      status: "PASS",
      detail: {
        timeout_ms: timeoutMs,
        stdout: result.stdout.slice(-4000),
        stderr: result.stderr.slice(-4000),
      },
    };
  } catch (error) {
    return fail("LibreOffice did not produce a recalculated workbook.", { error: error.message });
  } finally {
    await fs.rm(recalcDir, { recursive: true, force: true });
    await fs.rm(profile, { recursive: true, force: true });
  }
}

async function exactEnvironmentProbe({ python, soffice, integrity, runDir }) {
  const profile = await json(path.join(ASSETS, "deployment-profile.json"));
  const violations = [];
  const minimumPython = profile.python_runtime?.minimum_version ?? [3, 9];
  const actualPython = String(python.runtime?.python ?? "0.0")
    .split(".")
    .slice(0, 2)
    .map(Number);
  if (
    actualPython[0] < minimumPython[0]
    || (actualPython[0] === minimumPython[0] && actualPython[1] < minimumPython[1])
  ) {
    violations.push({
      code: "PYTHON_VERSION_UNSUPPORTED",
      expected_minimum: minimumPython.join("."),
      actual: python.runtime?.python ?? null,
    });
  }
  const expectedOpenpyxl = profile.allowed_python_third_party_imports?.openpyxl?.host_version;
  if (expectedOpenpyxl && python.runtime?.openpyxl !== expectedOpenpyxl) {
    violations.push({
      code: "OPENPYXL_VERSION_MISMATCH",
      expected: expectedOpenpyxl,
      actual: python.runtime?.openpyxl ?? null,
    });
  }

  const dependencyProbe = await command(python.path, [
    "-c",
    [
      "import json,os,sys",
      `sys.path.insert(0, ${JSON.stringify(HERE)})`,
      "import importlib.util,PIL,numpy",
      "fitz=__import__('pymupdf' if importlib.util.find_spec('pymupdf') else 'fitz')",
      "from render.textfit import load_font_set",
      "fonts=load_font_set()",
      "print(json.dumps({'fitz':getattr(fitz,'VersionBind',None) or getattr(fitz,'__version__',None),'pillow':PIL.__version__,'numpy':numpy.__version__,'font_regular':fonts.regular_path,'font_bold':fonts.bold_path},sort_keys=True))",
    ].join(";"),
  ], {
    timeout: 30000,
    env: { ...COMMAND_ENV, SOFFICE_BIN: soffice.path },
  });
  let dependencies = null;
  if (!dependencyProbe.ok) {
    violations.push({
      code: "RENDER_DEPENDENCY_PROBE_FAILED",
      stderr: dependencyProbe.stderr.slice(-4000),
    });
  } else {
    try {
      // New PyMuPDF releases may emit a deprecation notice before a legacy
      // `fitz` import. The capability probe owns only its final JSON record;
      // diagnostic prose must not turn an installed renderer into a false
      // missing-dependency block.
      const payload = dependencyProbe.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      dependencies = JSON.parse(payload);
    } catch (error) {
      violations.push({ code: "RENDER_DEPENDENCY_PROBE_INVALID", detail: error.message });
    }
  }
  if (!dependencies?.fitz) violations.push({ code: "PYMUPDF_MISSING" });
  if (!dependencies?.font_regular || !dependencies?.font_bold) {
    violations.push({ code: "METRIC_COMPATIBLE_FONT_SET_INCOMPLETE", dependencies });
  }

  const releaseManifestPath = path.join(ROOT, "release-manifest.json");
  let releaseManifest = null;
  let releaseManifestSha256 = null;
  const sourceCheckout = await fs.stat(path.join(ROOT, ".git"))
    .then(() => true)
    .catch(() => false);
  try {
    releaseManifest = await json(releaseManifestPath);
    releaseManifestSha256 = await hashFile(releaseManifestPath);
  } catch {
    if (!sourceCheckout) violations.push({ code: "RELEASE_MANIFEST_MISSING" });
  }
  let activeSourceIdentity = null;
  try {
    activeSourceIdentity = await resolveActiveSourceIdentity({ skillRoot: ROOT });
  } catch (error) {
    violations.push({ code: "ACTIVE_SOURCE_IDENTITY_INVALID", detail: error.message });
  }
  const body = {
    schema_version: "stage4-environment-probe/1.0",
    status: violations.length ? "BLOCKED" : "PASS",
    runtime_snapshot_sha256: integrity.digest,
    release_manifest_sha256: releaseManifestSha256,
    release_identity: activeSourceIdentity ? {
      name: activeSourceIdentity.release_name,
      skill_version: activeSourceIdentity.skill_version,
      package_mode: activeSourceIdentity.package_mode,
      deployment_status: activeSourceIdentity.deployment_status,
      runtime_code_closure_sha256: activeSourceIdentity.runtime_code_closure_sha256,
      certified_runtime_code_closure_sha256:
        activeSourceIdentity.certified_runtime_code_closure_sha256,
      complete_package_inventory_sha256:
        activeSourceIdentity.product_identity?.package?.complete_package_inventory?.sha256 ?? null,
    } : null,
    node: process.version,
    python: python.runtime,
    soffice: { path: soffice.path, version: soffice.version, identity: soffice.identity },
    dependencies,
    resources: {
      logical_cpu_count: os.cpus().length,
      total_memory_bytes: os.totalmem(),
    },
    violations,
  };
  const target = path.join(runDir, "environment-probe.json");
  await writeIsolationJson(target, body);
  return { ...body, artifact: target };
}

async function copySidecars(sourceWorkbook, targetWorkbook) {
  for (const suffix of SIDECAR_SUFFIXES) {
    await fs.copyFile(`${sourceWorkbook}${suffix}`, `${targetWorkbook}${suffix}`);
  }
}

async function atomicCopyFile(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function atomicReplaceDirectory(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${target}.${process.pid}.${randomUUID()}.previous`;
  let movedPrevious = false;
  try {
    await fs.cp(source, temporary, { recursive: true });
    try {
      await fs.rename(target, previous);
      movedPrevious = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(temporary, target);
    if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (movedPrevious) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      await fs.rename(previous, target).catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    await fs.rm(previous, { recursive: true, force: true }).catch(() => {});
  }
}

async function fileManifest(root, base = root) {
  const entries = [];
  for (const item of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => comparePortablePaths(a.name, b.name))) {
    const target = path.join(root, item.name);
    if (item.isDirectory()) entries.push(...await fileManifest(target, base));
    else if (item.isFile()) {
      entries.push({
        path: path.relative(base, target).split(path.sep).join("/"),
        sha256: await hashFile(target),
        bytes: (await fs.stat(target)).size,
      });
    }
  }
  return entries;
}

function sidecarOutputs(workbook) {
  return Object.fromEntries(SIDECAR_SUFFIXES.map((suffix) => [suffix.slice(1), `${workbook}${suffix}`]));
}

async function runtimeSourceDigests() {
  const profile = await json(path.join(ASSETS, "deployment-profile.json"));
  const scripts = (profile.script_allowlist ?? []).map((item) => path.join(HERE, item));
  const python = (profile.python_module_allowlist ?? []).map((item) => path.join(HERE, item));
  const assets = (profile.asset_allowlist ?? []).map((item) => path.join(ASSETS, item));
  const jsLibs = scripts.filter((target) => target.includes(`${path.sep}lib${path.sep}`));
  const planScripts = scripts.filter((target) =>
    target.endsWith(`${path.sep}build_dynamic_model.mjs`) || target.includes(`${path.sep}lib${path.sep}`));
  const verifyScripts = scripts.filter((target) =>
    /(?:validate_(cache_parity|style_tokens|source_parity|structure)|recalc_second_opinion)\.mjs$/.test(target));
  const emitPython = python.filter((target) => target.includes(`${path.sep}emit${path.sep}`));
  const verifyPython = python.filter((target) => target.includes(`${path.sep}verify${path.sep}`));
  const renderPython = python.filter((target) => target.includes(`${path.sep}render${path.sep}`));
  const digest = async (paths) => hashValue(await hashFiles(paths, ROOT));
  return {
    controller: await digest([
      path.join(HERE, "orchestrate_release.mjs"),
      path.join(HERE, "lib", "release_checkpoint_store.mjs"),
      path.join(HERE, "lib", "run_store.mjs"),
      path.join(HERE, "lib", "runtime_isolation.mjs"),
      path.join(HERE, "lib", "process_tree.mjs"),
    ]),
    semantic: await digest([
      path.join(HERE, "lib", "release_nodes.mjs"),
      path.join(HERE, "lib", "release_module_registry.mjs"),
      ...jsLibs,
      ...assets,
    ]),
    plan: await digest([...planScripts, ...assets]),
    emit: await digest(emitPython),
    verify: await digest([...verifyScripts, ...verifyPython]),
    render: await digest(renderPython),
  };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (!positional[0] || !options.out) {
    throw new Error(
      "Usage: orchestrate_release.mjs <case.json> --out <run-dir> " +
      "[--dcs-export <json>] [--broker-pack <json>] [--filings <json>] " +
      "[--model-demand-graph <json>] [--selected-authority-contract <json>] " +
      "[--run-constitution-graph <json>] " +
      "[--case-only] [--python <python>] [--soffice <path>] " +
      "[--runtime-budget-policy <resolved-policy.json>] " +
      "[--workspace-token <token>] [--json]",
    );
  }

  const casePath = path.resolve(positional[0]);
  const isolated = await assertRunRootOutsideSkill({ skillRoot: ROOT, runRoot: options.out });
  const runDir = isolated.run_root;
  await fs.mkdir(runDir, { recursive: true });
  if (typeof options["runtime-budget-policy"] === "string") {
    const runtimePolicy = await json(path.resolve(options["runtime-budget-policy"]));
    const policyErrors = validateRuntimeBudgetPolicy(runtimePolicy);
    if (policyErrors.length > 0) {
      throw new Error(`Stage-4 runtime budget policy is invalid: ${policyErrors.join(", ")}`);
    }
    ACTIVE_STAGE4_BUDGET = new RuntimeStageBudgetLedger(runtimePolicy);
    ACTIVE_STAGE4_BUDGET_RECEIPT_PATH = path.join(runDir, "stage4-runtime-budget-receipt.json");
  }
  const modelCase = await json(casePath);
  const authorityOptionPaths = {
    model_demand_graph: options["model-demand-graph"]
      ? path.resolve(options["model-demand-graph"])
      : null,
    selected_authority_contract: options["selected-authority-contract"]
      ? path.resolve(options["selected-authority-contract"])
      : null,
    run_constitution_graph: options["run-constitution-graph"]
      ? path.resolve(options["run-constitution-graph"])
      : null,
  };
  const expectedAuthorityHashes = {
    model_demand_graph: modelCase.model_demand_graph_sha256 ?? null,
    selected_authority_contract: modelCase.selected_authority_contract_sha256 ?? null,
    run_constitution_graph: modelCase.run_constitution_graph_sha256 ?? null,
  };
  const authorityRequired = Object.values(expectedAuthorityHashes).some(Boolean);
  if (
    authorityRequired &&
    Object.values(authorityOptionPaths).some((target) => !target)
  ) {
    throw new Error(
      "A graph-bound model case requires all three Stage-3 authority artifacts.",
    );
  }
  const authorityArtifacts = {};
  if (authorityRequired) {
    for (const [name, target] of Object.entries(authorityOptionPaths)) {
      const value = await json(target);
      const actual =
        value.graph_sha256 ?? value.contract_sha256 ?? null;
      if (actual !== expectedAuthorityHashes[name]) {
        throw new Error(`${name} does not match the hash sealed into model-case.json.`);
      }
      authorityArtifacts[name] = { path: target, value };
    }
    if (
      authorityArtifacts.selected_authority_contract.value.model_demand_graph_sha256 !==
      expectedAuthorityHashes.model_demand_graph
    ) {
      throw new Error("Selected-authority contract is not bound to the supplied demand graph.");
    }
    if (
      authorityArtifacts.run_constitution_graph.value.model_demand_graph_sha256 !==
        expectedAuthorityHashes.model_demand_graph ||
      authorityArtifacts.run_constitution_graph.value.selected_authority_contract_sha256 !==
        expectedAuthorityHashes.selected_authority_contract
    ) {
      throw new Error("Run constitution graph is not bound to the supplied authority artifacts.");
    }
  }
  const caseHash = await hashFile(casePath);
  const runId = validateRunId(String(options["run-id"] ?? `stage4-${caseHash.slice(0, 24)}`));
  const workspaceToken = String(
    options["workspace-token"] ?? process.env.EXCEL_INFLOW_WORKSPACE_TOKEN ?? `workspace:${path.dirname(runDir)}`,
  );
  const identity = await initializeOrVerifyRunIdentity({
    skillRoot: ROOT,
    runRoot: runDir,
    runId,
    controllerVersion: RELEASE_CHECKPOINT_CONTROLLER,
    workspaceToken,
    issuerIdentity: { name: modelCase.issuer?.name ?? "Unknown issuer" },
  });
  const lease = await acquireRunLease(runDir, {
    owner: `orchestrate_release:${runId}`,
    sessionId: workspaceToken,
  });
  const integrity = await captureRuntimeIntegrity(ROOT);
  ACTIVE_RUN_GUARD = { runDir, identity, lease, integrity };
  const runtimeHome = path.join(runDir, ".runtime-home");
  const runtimeTmp = path.join(runDir, ".runtime-tmp");
  await fs.mkdir(runtimeHome, { recursive: true });
  await fs.mkdir(runtimeTmp, { recursive: true });
  COMMAND_CWD = runDir;
  COMMAND_ENV = {
    ...process.env,
    HOME: runtimeHome,
    TMPDIR: runtimeTmp,
    PYTHONDONTWRITEBYTECODE: "1",
    EXCEL_INFLOW_WORKSPACE_TOKEN: workspaceToken,
  };
  const store = await ReleaseCheckpointStore.open(runDir);
  const dcsPath = typeof options["dcs-export"] === "string" ? path.resolve(options["dcs-export"]) : null;
  const brokerPath = typeof options["broker-pack"] === "string" ? path.resolve(options["broker-pack"]) : null;
  const filingsPath = typeof options.filings === "string" ? path.resolve(options.filings) : null;
  const dcsExport = dcsPath ? await json(dcsPath) : null;
  const brokerPack = brokerPath ? await json(brokerPath) : null;
  const filings = filingsPath ? await json(filingsPath) : null;
  const caseOnly = options["case-only"] === true;

  const python = await resolvePython(typeof options.python === "string" ? options.python : null);
  if (!python) return fail("Python with openpyxl is required for the portable renderer and was not available.");
  const soffice = await resolveSoffice(typeof options.soffice === "string" ? options.soffice : null);
  if (!soffice) return fail("N11 is BLOCKED: LibreOffice is required for recalculation and was not available.");
  const environment = await exactEnvironmentProbe({
    python,
    soffice,
    integrity,
    runDir,
  });
  if (environment.status !== "PASS") {
    return fail("Stage 4 environment preflight did not pass.", {
      environment_probe: environment.artifact,
      violations: environment.violations,
    });
  }

  const evidenceHashes = {
    dcs_export: dcsPath ? await hashFile(dcsPath) : "absent",
    broker_pack: brokerPath ? await hashFile(brokerPath) : "absent",
    filings: filingsPath ? await hashFile(filingsPath) : "absent",
  };
  const source = await runtimeSourceDigests();
  const reusedCheckpoints = [];
  const executedCheckpoints = [];
  const checkpointReceipts = {};
  const timingsMs = {};

  async function checkpoint({ id, recipe, inputs, outputs, action }) {
    const inputHashes = {
      controller: source.controller,
      runtime_snapshot: integrity.digest,
      ...inputs,
    };
    const inspected = await store.inspect({ checkpointId: id, recipe, inputHashes, outputs });
    if (inspected.reusable) {
      const reusedBudgetStage = stage4BudgetStage(id);
      const reusedBudgetToken = ACTIVE_STAGE4_BUDGET?.begin(reusedBudgetStage) ?? null;
      ACTIVE_STAGE4_BUDGET?.end(reusedBudgetToken, { outcome: "PASS" });
      reusedCheckpoints.push(id);
      checkpointReceipts[id] = inspected.receipt.receipt_hash;
      timingsMs[id] = 0;
      return { ok: true, receipt: inspected.receipt, reused: true };
    }

    await store.reset(id);
    const budgetStage = stage4BudgetStage(id);
    let budgetToken = null;
    try {
      budgetToken = ACTIVE_STAGE4_BUDGET?.begin(budgetStage) ?? null;
    } catch (error) {
      return {
        ok: false,
        result: fail(`Independent ${budgetStage} runtime budget was exhausted before checkpoint ${id}.`, {
          checkpoint: id,
          budget_stage: budgetStage,
          timed_out: true,
          checkpoint_preserved: true,
          evidence_retained: true,
        }),
      };
    }
    ACTIVE_STAGE4_BUDGET_TOKEN = budgetToken;
    const started = process.hrtime.bigint();
    let result;
    try {
      result = await action(store.workDir(id));
    } catch (error) {
      result = fail(`Checkpoint ${id} threw before its gate completed.`, { error: error.stack ?? error.message });
    } finally {
      ACTIVE_STAGE4_BUDGET_TOKEN = null;
    }
    timingsMs[id] = Number(process.hrtime.bigint() - started) / 1e6;
    ACTIVE_STAGE4_BUDGET?.end(budgetToken, {
      outcome: result?.status === "PASS" ? "PASS" : "FAIL",
      checkpointPreserved: true,
      evidenceRetained: true,
    });
    executedCheckpoints.push(id);
    const passed = result?.status === "PASS";
    const receipt = await store.persist({
      checkpointId: id,
      recipe,
      status: passed ? "success" : "blocked",
      inputHashes,
      outputs,
      detail: passed ? result.detail ?? null : result,
    });
    checkpointReceipts[id] = receipt.receipt_hash;
    if (!passed) {
      return {
        ok: false,
        result: {
          ...result,
          checkpoint: id,
          checkpointing: {
            controller: RELEASE_CHECKPOINT_CONTROLLER,
            reused: reusedCheckpoints,
            executed: executedCheckpoints,
            receipts: checkpointReceipts,
          },
        },
      };
    }
    return { ok: true, receipt, reused: false };
  }

  const semanticDir = store.workDir("semantic_gates");
  const semanticResultPath = path.join(semanticDir, "n0-n9-gates.json");
  let step = await checkpoint({
    id: "semantic_gates",
    recipe: "release-semantic-gates/1.0",
    inputs: { case: caseHash, ...evidenceHashes, case_only: hashValue(caseOnly), code: source.semantic },
    outputs: { semantic_gates: semanticResultPath },
    action: async (workDir) => {
      const result = runReleaseN0N9({ modelCase, dcsExport, brokerPack, filings, caseOnly });
      await fs.writeFile(path.join(workDir, "n0-n9-gates.json"), `${canonicalJson(result)}\n`, "utf8");
      if (result.status !== "PASS") {
        return {
          ...fail("Portable semantic gates N0-N9 did not pass."),
          semantic_gates: {
            status: result.status,
            failed: result.gates
              .filter((entry) => entry.status !== "PASS")
              .map((entry) => ({ id: entry.id, status: entry.status })),
            artifact: semanticResultPath,
          },
        };
      }
      return { status: "PASS", detail: { gate_status: result.status, gate_count: result.gates.length } };
    },
  });
  if (!step.ok) return step.result;
  const n0n9 = await json(semanticResultPath);
  const semanticSummary = {
    status: n0n9.status,
    gate_count: n0n9.gates.length,
    failed_gate_count: n0n9.gates.filter((entry) => entry.status !== "PASS").length,
    artifact: path.join(runDir, "n0-n9-gates.json"),
  };

  const planDir = store.workDir("plan");
  const planWorkbook = path.join(planDir, "model.xlsx");
  const planPath = `${planWorkbook}.plan.json`;
  const planOutputs = { plan: planPath, ...sidecarOutputs(planWorkbook) };
  step = await checkpoint({
    id: "plan",
    recipe: "release-plan/1.0",
    inputs: { case: caseHash, semantic_receipt: checkpointReceipts.semantic_gates, code: source.plan, node: hashValue(process.version) },
    outputs: planOutputs,
    action: async () => {
      const result = await command(process.execPath, [
        path.join(HERE, "build_dynamic_model.mjs"),
        casePath,
        "--plan-only",
        "--out",
        planWorkbook,
      ]);
      if (!result.ok) return fail("N10 plan-only compiler failed.", { stderr: result.stderr.slice(-4000) });
      return { status: "PASS", detail: { plan: "model.xlsx.plan.json" } };
    },
  });
  if (!step.ok) return step.result;

  const emitDir = store.workDir("emit");
  const emittedWorkbook = path.join(emitDir, "model.xlsx");
  step = await checkpoint({
    id: "emit",
    recipe: "release-python-emit/1.0",
    inputs: { plan: await hashFile(planPath), plan_receipt: checkpointReceipts.plan, code: source.emit, python: python.identity },
    outputs: { emitted_workbook: emittedWorkbook },
    action: async () => {
      const validate = await command(python.path, [path.join(HERE, "emit", "__main__.py"), "validate", planPath]);
      if (!validate.ok) return fail("N10 plan schema validation failed.", { stderr: validate.stderr.slice(-4000) });
      const emitted = await command(python.path, [path.join(HERE, "emit", "__main__.py"), "build", planPath, "--out", emittedWorkbook]);
      if (!emitted.ok) return fail("N10 portable renderer failed.", { stderr: emitted.stderr.slice(-4000) });
      return { status: "PASS", detail: { renderer: "python-openpyxl" } };
    },
  });
  if (!step.ok) return step.result;

  const recalcDir = store.workDir("recalculate");
  const rawRecalculatedWorkbook = path.join(recalcDir, "model.raw-after.xlsx");
  const beforeCacheMap = path.join(recalcDir, "formula-caches.before.json");
  const rawAfterCacheMap = path.join(recalcDir, "formula-caches.raw-after.json");
  const recalcSecondOpinion = path.join(recalcDir, "libreoffice-recalc-receipt.json");
  step = await checkpoint({
    id: "recalculate",
    recipe: "release-recalculate-second-opinion/2.0",
    inputs: {
      emitted_workbook: await hashFile(emittedWorkbook),
      emit_receipt: checkpointReceipts.emit,
      verifier_code: source.verify,
      soffice: soffice.identity,
    },
    outputs: {
      raw_recalculated_workbook: rawRecalculatedWorkbook,
      before_cache_map: beforeCacheMap,
      raw_after_cache_map: rawAfterCacheMap,
      recalc_second_opinion: recalcSecondOpinion,
    },
    action: async (workDir) => {
      const execution = await workbookExecutionPolicy(emittedWorkbook);
      const recalculated = await recalcWithSoffice(
        soffice.path,
        emittedWorkbook,
        rawRecalculatedWorkbook,
        workDir,
        execution.timeout_ms,
      );
      if (recalculated.status !== "PASS") return recalculated;
      const secondOpinion = await command(process.execPath, [
        path.join(HERE, "verify", "recalc_second_opinion.mjs"),
        "--before", emittedWorkbook,
        "--after", rawRecalculatedWorkbook,
        "--before-map", beforeCacheMap,
        "--after-map", rawAfterCacheMap,
        "--out", recalcSecondOpinion,
        "--soffice-identity", soffice.identity,
      ], { timeout: Math.max(60000, Math.floor(execution.timeout_ms / 2)) });
      if (!secondOpinion.ok) {
        return fail("N11 LibreOffice second-opinion receipt did not pass.", {
          stdout: secondOpinion.stdout.slice(-4000),
          stderr: secondOpinion.stderr.slice(-4000),
        });
      }
      const receipt = await json(recalcSecondOpinion);
      if (receipt.status !== "PASS" || Number(receipt.violations?.length ?? 0) !== 0) {
        return fail("N11 LibreOffice second-opinion receipt contains violations.", {
          receipt_status: receipt.status,
          violations: receipt.violations ?? [],
        });
      }
      return {
        status: "PASS",
        detail: {
          formula_cells: receipt.formula_cells,
          compared_formula_cells: receipt.compared_formula_cells,
          package_changed: receipt.package_changed,
          producer: receipt.producer,
          maximum_observed_drift: receipt.maximum_observed_drift,
          execution,
        },
      };
    },
  });
  if (!step.ok) return step.result;

  const patchDir = store.workDir("terminal_patch");
  const patchedWorkbook = path.join(patchDir, "model.xlsx");
  const patchOutputs = { patched_workbook: patchedWorkbook, ...sidecarOutputs(patchedWorkbook) };
  step = await checkpoint({
    id: "terminal_patch",
    recipe: "release-terminal-patch/2.0",
    inputs: {
      raw_recalculated_workbook: await hashFile(rawRecalculatedWorkbook),
      recalculate_receipt: checkpointReceipts.recalculate,
      recalc_second_opinion: await hashFile(recalcSecondOpinion),
      plan: await hashFile(planPath),
      code: source.emit,
      python: python.identity,
    },
    outputs: patchOutputs,
    action: async () => {
      await fs.copyFile(rawRecalculatedWorkbook, patchedWorkbook);
      await copySidecars(planWorkbook, patchedWorkbook);
      const patched = await command(python.path, [path.join(HERE, "emit", "__main__.py"), "patch", planPath, "--out", patchedWorkbook]);
      if (!patched.ok) return fail("N12 terminal patch after LibreOffice failed.", { stderr: patched.stderr.slice(-4000) });
      return {
        status: "PASS",
        detail: {
          terminal_patch: true,
          raw_recalc_receipt_sha256: await hashFile(recalcSecondOpinion),
        },
      };
    },
  });
  if (!step.ok) return step.result;

  const executionPolicy = await workbookExecutionPolicy(patchedWorkbook);
  const validationDir = store.workDir("verify_dynamic");
  const validationReport = path.join(validationDir, "validation-report.json");
  step = await checkpoint({
    id: "verify_dynamic",
    recipe: "release-verify-dynamic/2.0",
    inputs: {
      workbook: await hashFile(patchedWorkbook),
      terminal_patch_receipt: checkpointReceipts.terminal_patch,
      code: source.verify,
      python: python.identity,
      execution_policy: hashValue(executionPolicy),
    },
    outputs: { validation_report: validationReport },
    action: async (workDir) => {
      const result = await command(python.path, [
        path.join(HERE, "verify", "validate_dynamic_model.py"),
        patchedWorkbook,
        "--out", workDir,
      ], { timeout: executionPolicy.timeout_ms });
      if (!result.ok) return fail("N13 portable independent validation failed.", { stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      const report = await json(validationReport);
      const violations = Number(report.total_violations ?? report.summary?.total_violations ?? 0);
      if (report.status !== "PASS_PENDING_MANUAL" || violations !== 0) {
        return fail("N13 portable validation must remain explicitly pending native Excel and visual review.", { report_status: report.status, total_violations: violations });
      }
      return {
        status: "PASS",
        detail: {
          report_status: report.status,
          evidence_class: "AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY",
          release_gate_status: "PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW",
          total_violations: violations,
          execution: executionPolicy,
        },
      };
    },
  });
  if (!step.ok) return step.result;

  const styleDir = store.workDir("verify_style");
  const styleReport = path.join(styleDir, "style-tokens.json");
  step = await checkpoint({
    id: "verify_style",
    recipe: "release-verify-style/2.0",
    inputs: { workbook: await hashFile(patchedWorkbook), terminal_patch_receipt: checkpointReceipts.terminal_patch, code: source.verify, node: hashValue(process.version) },
    outputs: { style_report: styleReport },
    action: async () => {
      const result = await command(process.execPath, [path.join(HERE, "validate_style_tokens.mjs"), patchedWorkbook, "--json", styleReport], { timeout: executionPolicy.timeout_ms });
      if (!result.ok) return fail("N13 style-token validation failed.", { stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      const report = await json(styleReport);
      if (report.status !== "PASS") return fail("N13 style-token report did not pass.", { report_status: report.status });
      return { status: "PASS", detail: { report_status: report.status } };
    },
  });
  if (!step.ok) return step.result;

  const cacheDir = store.workDir("verify_cache");
  const cacheReport = path.join(cacheDir, "cache-parity.json");
  step = await checkpoint({
    id: "verify_cache",
    recipe: "release-verify-cache/2.0",
    inputs: { workbook: await hashFile(patchedWorkbook), terminal_patch_receipt: checkpointReceipts.terminal_patch, code: source.verify, node: hashValue(process.version) },
    outputs: { cache_report: cacheReport },
    action: async () => {
      const result = await command(process.execPath, [path.join(HERE, "validate_cache_parity.mjs"), patchedWorkbook, "--json", cacheReport], { timeout: executionPolicy.timeout_ms });
      if (!result.ok) return fail("N13 cache parity failed.", { stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      const report = await json(cacheReport);
      const blind = Object.fromEntries(
        ["unsupported", "parse_errors", "eval_errors", "no_cache"].map((key) => [key, (report[key] ?? []).length]),
      );
      const strict = report.status === "PASS"
        && Number(report.disagreements ?? 0) === 0
        && Number(report.stats?.formula_cells ?? 0) > 0
        && Number(report.stats?.checked ?? 0) > 0
        && Object.values(blind).every((count) => count === 0);
      if (!strict) return fail("N13 strict cache coverage did not clear.", { report_status: report.status, blind, stats: report.stats ?? null });
      return { status: "PASS", detail: { report_status: report.status, blind, stats: report.stats } };
    },
  });
  if (!step.ok) return step.result;

  const financeDir = store.workDir("verify_finance");
  const financeReport = path.join(financeDir, "finance-proof.json");
  step = await checkpoint({
    id: "verify_finance",
    recipe: "release-verify-finance/2.0",
    inputs: { workbook: await hashFile(patchedWorkbook), case: caseHash, terminal_patch_receipt: checkpointReceipts.terminal_patch, code: source.verify, python: python.identity },
    outputs: { finance_report: financeReport },
    action: async () => {
      const result = await command(python.path, [path.join(HERE, "verify", "finance_proof.py"), casePath, patchedWorkbook, "--out", financeReport], { timeout: executionPolicy.timeout_ms });
      if (!result.ok) return fail("N13 independent finance proof failed.", { stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      const report = await json(financeReport);
      const violations = Number(report.summary?.violations ?? report.total_violations ?? 0);
      const comparisons = Number(report.summary?.comparisons ?? report.comparisons ?? 0);
      if (report.status !== "PASS" || violations !== 0 || comparisons <= 0) {
        return fail("N13 independent finance proof did not clear.", { report_status: report.status, total_violations: violations, comparisons });
      }
      return { status: "PASS", detail: { report_status: report.status, total_violations: violations, comparisons } };
    },
  });
  if (!step.ok) return step.result;

  const semanticOracleDir = store.workDir("verify_semantic");
  const semanticOracleReport = path.join(semanticOracleDir, "workbook-semantic-oracle.json");
  step = await checkpoint({
    id: "verify_semantic",
    recipe: "release-verify-semantic/2.0",
    inputs: { workbook: await hashFile(patchedWorkbook), proof_contract: await hashFile(`${patchedWorkbook}.workbook-proof-contract.json`), terminal_patch_receipt: checkpointReceipts.terminal_patch, code: source.verify, python: python.identity },
    outputs: { semantic_oracle_report: semanticOracleReport },
    action: async () => {
      const result = await command(python.path, [
        path.join(HERE, "verify", "workbook_semantic_oracle.py"),
        "--xlsx", patchedWorkbook,
        "--contract", `${patchedWorkbook}.workbook-proof-contract.json`,
        "--out", semanticOracleReport,
      ], { timeout: executionPolicy.timeout_ms });
      if (!result.ok) return fail("N13 independent workbook-semantic oracle failed.", { stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      const report = await json(semanticOracleReport);
      if (report.status !== "PASS") return fail("N13 workbook-semantic oracle report did not pass.", { report_status: report.status });
      return { status: "PASS", detail: { report_status: report.status } };
    },
  });
  if (!step.ok) return step.result;

  const verifyAggregateDir = store.workDir("verify_aggregate");
  const verificationSummary = path.join(verifyAggregateDir, "verification-summary.json");
  step = await checkpoint({
    id: "verify_aggregate",
    recipe: "release-verify-aggregate/2.0",
    inputs: {
      dynamic: checkpointReceipts.verify_dynamic,
      style: checkpointReceipts.verify_style,
      cache: checkpointReceipts.verify_cache,
      finance: checkpointReceipts.verify_finance,
      semantic: checkpointReceipts.verify_semantic,
    },
    outputs: { verification_summary: verificationSummary },
    action: async () => {
      const report = {
        schema_version: "stage4-verification-summary/1.0",
        status: "PASS_PENDING_MANUAL",
        evidence_class: "AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY",
        release_gate_status: "PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW",
        total_violations: 0,
        execution_policy: executionPolicy,
        reports: {
          validation: { path: validationReport, sha256: await hashFile(validationReport) },
          style: { path: styleReport, sha256: await hashFile(styleReport) },
          cache: { path: cacheReport, sha256: await hashFile(cacheReport) },
          finance: { path: financeReport, sha256: await hashFile(financeReport) },
          semantic: { path: semanticOracleReport, sha256: await hashFile(semanticOracleReport) },
        },
      };
      await writeIsolationJson(verificationSummary, report);
      return {
        status: "PASS",
        detail: {
          report_status: report.status,
          evidence_class: report.evidence_class,
          release_gate_status: report.release_gate_status,
          report_count: 5,
          total_violations: 0,
        },
      };
    },
  });
  if (!step.ok) return step.result;

  const rowMap = await json(`${patchedWorkbook}.row-map.json`);
  const baselineCase = { maximal: "standard-maximal", net_cash: "standard-net-cash" }[rowMap.authority_profile];
  if (!baselineCase) return fail("N14 is BLOCKED: the row map does not resolve to an approved reusable visual authority.", { authority_profile: rowMap.authority_profile ?? null });
  const visibleSheets = await visibleWorkbookSheets(python, patchedWorkbook);
  const renderLeafIds = [];
  const renderLeafDirectories = [];
  for (let index = 0; index < visibleSheets.length; index += 1) {
    const sheetName = visibleSheets[index];
    const leafId = renderLeafId(index);
    const leafDir = store.workDir(leafId);
    const leafIndex = path.join(leafDir, "render-evidence-index.json");
    step = await checkpoint({
      id: leafId,
      recipe: "release-structural-render-sheet/1.0",
      inputs: {
        workbook: await hashFile(patchedWorkbook),
        row_map: await hashFile(`${patchedWorkbook}.row-map.json`),
        verify_receipt: checkpointReceipts.verify_aggregate,
        code: source.render,
        render_mode: hashValue("structural-only-no-pixel-baseline"),
        baseline_case: hashValue(baselineCase),
        sheet: hashValue(sheetName),
        python: python.identity,
        soffice: soffice.identity,
      },
      outputs: { render_directory: { path: leafDir, kind: "directory" } },
      action: async (workDir) => {
        const rendered = await command(python.path, [
          path.join(HERE, "render", "check_render.py"),
          patchedWorkbook,
          "--out", workDir,
          "--sheet", sheetName,
          "--baseline-case", baselineCase,
          "--structural-only",
          "--soffice", soffice.path,
          "--timeout", String(Math.max(60, Math.floor(executionPolicy.timeout_ms / 1000))),
        ], { timeout: executionPolicy.timeout_ms + 60_000 });
        if (!rendered.ok) {
          return fail(`N14 render validation failed for ${sheetName}.`, {
            stdout: rendered.stdout.slice(-4000),
            stderr: rendered.stderr.slice(-4000),
          });
        }
        const indexReport = await json(leafIndex);
        const entry = (indexReport.cases ?? [])[0];
        if (
          (indexReport.cases ?? []).length !== 1 ||
          entry?.verdict !== "PASS" ||
          JSON.stringify(entry?.sheets_examined ?? []) !== JSON.stringify([sheetName])
        ) {
          return fail(`N14 render evidence did not prove exactly ${sheetName}.`, {
            cases: indexReport.cases ?? [],
          });
        }
        return {
          status: "PASS",
          detail: {
            sheet: sheetName,
            page_count: entry.page_count_total ?? entry.page_count ?? null,
            execution: executionPolicy,
          },
        };
      },
    });
    if (!step.ok) return step.result;
    renderLeafIds.push(leafId);
    renderLeafDirectories.push({ id: leafId, sheet: sheetName, path: leafDir });
  }
  const renderDir = store.workDir("render");
  const renderIndex = path.join(renderDir, "render-evidence-index.json");
  step = await checkpoint({
    id: "render",
    recipe: "release-structural-render-aggregate/2.0",
    inputs: {
      ...Object.fromEntries(renderLeafIds.map((id) => [id, checkpointReceipts[id]])),
      visible_sheets: hashValue(visibleSheets),
    },
    outputs: { render_directory: { path: renderDir, kind: "directory" } },
    action: async (workDir) => {
      const cases = [];
      for (const leaf of renderLeafDirectories) {
        const target = path.join(workDir, leaf.id);
        await fs.cp(leaf.path, target, { recursive: true });
        const leafIndex = await json(path.join(target, "render-evidence-index.json"));
        const entry = (leafIndex.cases ?? [])[0];
        if (!entry || entry.verdict !== "PASS") {
          return fail(`N14 aggregate found a non-PASS render leaf for ${leaf.sheet}.`, {
            entry: entry ?? null,
          });
        }
        cases.push({ ...entry, evidence_root: leaf.id });
      }
      await writeIsolationJson(renderIndex, {
        schema: "render-evidence-index/2",
        aggregation: "per-visible-sheet-resumable/1.0",
        visible_sheets: visibleSheets,
        cases,
      });
      return {
        status: "PASS",
        detail: {
          baseline_case: baselineCase,
          mode: "structural-only-no-pixel-baseline",
          cases: cases.length,
          sheets: visibleSheets,
          execution: executionPolicy,
        },
      };
    },
  });
  if (!step.ok) return step.result;

  const finalWorkbook = path.join(runDir, "model.xlsx");
  const finalVerifyDir = path.join(runDir, "verify");
  const finalRenderDir = path.join(runDir, "render");
  const finalSemantic = path.join(runDir, "n0-n9-gates.json");
  // Publication is a first-class Stage-4 artifact, not checkpoint-private
  // scratch state. Keep it at a deterministic build-root path so the outer
  // flow can hash, resume and attest it without knowing the checkpoint store
  // layout.
  const publicationPath = path.join(runDir, "publication.json");
  const finalAuthorityDir = path.join(runDir, "authority");
  const publishOutputs = {
    workbook: finalWorkbook,
    semantic_gates: finalSemantic,
    verify: { path: finalVerifyDir, kind: "directory" },
    render: { path: finalRenderDir, kind: "directory" },
    publication: publicationPath,
    ...(authorityRequired
      ? { authority: { path: finalAuthorityDir, kind: "directory" } }
      : {}),
    ...sidecarOutputs(finalWorkbook),
  };
  step = await checkpoint({
    id: "publish",
    recipe: "release-publish-artifacts/2.0",
    inputs: {
      render_receipt: checkpointReceipts.render,
      verify_receipt: checkpointReceipts.verify_aggregate,
      recalculate_receipt: checkpointReceipts.recalculate,
      terminal_patch_receipt: checkpointReceipts.terminal_patch,
      environment_probe: await hashFile(environment.artifact),
      ...Object.fromEntries(
        await Promise.all(
          Object.entries(authorityArtifacts).map(async ([name, artifact]) => [
            name,
            await hashFile(artifact.path),
          ]),
        ),
      ),
    },
    outputs: publishOutputs,
    action: async (workDir) => {
      await atomicCopyFile(patchedWorkbook, finalWorkbook);
      for (const suffix of SIDECAR_SUFFIXES) {
        await atomicCopyFile(`${patchedWorkbook}${suffix}`, `${finalWorkbook}${suffix}`);
      }
      await atomicCopyFile(semanticResultPath, finalSemantic);
      const verificationBundle = path.join(workDir, "verification-bundle");
      await fs.rm(verificationBundle, { recursive: true, force: true });
      await fs.mkdir(verificationBundle, { recursive: true });
      for (const [sourcePath, name] of [
        [validationReport, "validation-report.json"],
        [styleReport, "style-tokens.json"],
        [cacheReport, "cache-parity.json"],
        [financeReport, "finance-proof.json"],
        [semanticOracleReport, "workbook-semantic-oracle.json"],
        [verificationSummary, "verification-summary.json"],
        [recalcSecondOpinion, "libreoffice-recalc-receipt.json"],
        [beforeCacheMap, "formula-caches.before.json"],
        [rawAfterCacheMap, "formula-caches.raw-after.json"],
        [environment.artifact, "environment-probe.json"],
      ]) {
        await fs.copyFile(sourcePath, path.join(verificationBundle, name));
      }
      await atomicReplaceDirectory(verificationBundle, finalVerifyDir);
      await atomicReplaceDirectory(renderDir, finalRenderDir);
      if (authorityRequired) {
        const authorityBundle = path.join(workDir, "authority-bundle");
        await fs.mkdir(authorityBundle, { recursive: true });
        for (const [name, artifact] of Object.entries(authorityArtifacts)) {
          await fs.copyFile(artifact.path, path.join(authorityBundle, `${name}.json`));
        }
        await atomicReplaceDirectory(authorityBundle, finalAuthorityDir);
      }
      const sidecars = Object.fromEntries(
        await Promise.all(SIDECAR_SUFFIXES.map(async (suffix) => [
          suffix.slice(1),
          {
            path: `model.xlsx${suffix}`,
            sha256: await hashFile(`${finalWorkbook}${suffix}`),
            bytes: (await fs.stat(`${finalWorkbook}${suffix}`)).size,
          },
        ])),
      );
      const priorCheckpointReceipts = Object.fromEntries(
        await Promise.all(
          Object.entries(checkpointReceipts)
            .filter(([id]) => id !== "publish")
            .map(async ([id, receiptHash]) => {
              const receiptPath = store.receiptPath(id);
              return [id, {
                receipt_hash: receiptHash,
                sha256: await hashFile(receiptPath),
              }];
            }),
        ),
      );
      await writeIsolationJson(publicationPath, {
        schema_version: "stage4-publication/2.0",
        workbook: {
          path: "model.xlsx",
          sha256: await hashFile(finalWorkbook),
          bytes: (await fs.stat(finalWorkbook)).size,
        },
        authority_profile: rowMap.authority_profile,
        automated_status: "PASS_PENDING_MANUAL",
        total_violations: 0,
        runtime_snapshot_sha256: integrity.digest,
        release_manifest_sha256: environment.release_manifest_sha256,
        sidecars,
        semantic_gates: {
          path: "n0-n9-gates.json",
          sha256: await hashFile(finalSemantic),
        },
        verification_files: await fileManifest(finalVerifyDir),
        render_files: await fileManifest(finalRenderDir),
        checkpoint_receipts: priorCheckpointReceipts,
        authority_files: authorityRequired
          ? await fileManifest(finalAuthorityDir)
          : [],
      });
      return {
        status: "PASS",
        detail: {
          workbook: "model.xlsx",
          total_violations: 0,
          sidecar_count: Object.keys(sidecars).length,
          verification_file_count: (await fileManifest(finalVerifyDir)).length,
          render_file_count: (await fileManifest(finalRenderDir)).length,
        },
      };
    },
  });
  if (!step.ok) return step.result;

  return {
    status: "PASS_PENDING_MANUAL",
    semantic_gates: semanticSummary,
    workbook: finalWorkbook,
    total_violations: 0,
    checkpointing: {
      controller: RELEASE_CHECKPOINT_CONTROLLER,
      workspace_bound_resume: true,
      order: [
        ...CHECKPOINT_ORDER.slice(0, CHECKPOINT_ORDER.indexOf("render")),
        ...renderLeafIds,
        ...CHECKPOINT_ORDER.slice(CHECKPOINT_ORDER.indexOf("render")),
      ],
      reused: reusedCheckpoints,
      executed: executedCheckpoints,
      receipts: checkpointReceipts,
      timings_ms: timingsMs,
    },
    evidence: {
      plan: `${finalWorkbook}.plan.json`,
      verify: finalVerifyDir,
      render: finalRenderDir,
      publication: publicationPath,
    },
  };
}

async function guardedMain() {
  try {
    let result = await main();
    if (ACTIVE_STAGE4_BUDGET && ACTIVE_STAGE4_BUDGET_RECEIPT_PATH) {
      const receipt = ACTIVE_STAGE4_BUDGET.receipt({
        requireAll: result?.status === "PASS_PENDING_MANUAL",
      });
      await writeIsolationJson(ACTIVE_STAGE4_BUDGET_RECEIPT_PATH, receipt);
      result = {
        ...result,
        runtime_budget: {
          status: receipt.status,
          policy_sha256: receipt.policy_sha256,
          receipt: ACTIVE_STAGE4_BUDGET_RECEIPT_PATH,
          receipt_sha256: await hashFile(ACTIVE_STAGE4_BUDGET_RECEIPT_PATH),
          stage_executions: receipt.stage_executions,
          violations: receipt.violations,
        },
      };
      if (result.status === "PASS_PENDING_MANUAL" && receipt.status !== "PASS") {
        result = fail("Independent Stage-4 runtime budgets did not close.", {
          runtime_budget: result.runtime_budget,
        });
      }
    }
    if (ACTIVE_RUN_GUARD) {
      const closing = await assertRuntimeIntegrityUnchanged(ACTIVE_RUN_GUARD.integrity, ROOT);
      await writeIsolationJson(path.join(ACTIVE_RUN_GUARD.runDir, "skill-integrity.json"), {
        schema_version: "skill-integrity-evidence/1.0",
        status: "PASS",
        opening_digest: ACTIVE_RUN_GUARD.integrity.digest,
        closing_digest: closing.digest,
        file_count: closing.file_count,
      });
    }
    return result;
  } finally {
    if (ACTIVE_RUN_GUARD) {
      let integrityError = null;
      try {
        await assertRuntimeIntegrityUnchanged(ACTIVE_RUN_GUARD.integrity, ROOT);
      } catch (error) {
        integrityError = error;
      }
      await releaseRunLease(ACTIVE_RUN_GUARD.runDir, ACTIVE_RUN_GUARD.lease.token);
      ACTIVE_RUN_GUARD = null;
      if (integrityError) throw integrityError;
    }
  }
}

guardedMain().then((result) => {
  const machine = JSON.stringify(result, null, 2);
  if (process.argv.includes("--json")) console.log(machine);
  else console.log(`${result.status}: ${result.workbook ?? result.message ?? "see gate evidence"}`);
  process.exitCode = result.status === "PASS_PENDING_MANUAL" ? 0 : 1;
}).catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
