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
  hashDirectory,
  hashFile,
  hashFiles,
  hashValue,
} from "./lib/run_store.mjs";
import { runProcessTree } from "./lib/process_tree.mjs";
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
const CHECKPOINT_ORDER = Object.freeze([
  "semantic_gates",
  "plan",
  "emit",
  "recalculate_patch",
  "verify",
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
  return runProcessTree(binary, args, {
    cwd: options.cwd ?? COMMAND_CWD,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 180000,
    env: options.env ?? COMMAND_ENV,
  });
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
      return {
        path: candidate,
        identity: hashValue({ path: candidate, version: probe.stdout.trim() || probe.stderr.trim() }),
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
  return {
    path: candidate,
    identity: hashValue({ path: candidate, runtime: probe.stdout.trim() }),
  };
}

async function recalcWithSoffice(soffice, sourceWorkbook, targetWorkbook, workDir) {
  await fs.mkdir(workDir, { recursive: true });
  await fs.copyFile(sourceWorkbook, targetWorkbook);
  const recalcDir = await fs.mkdtemp(path.join(workDir, "recalc-"));
  const profile = await fs.mkdtemp(path.join(workDir, "soffice-profile-"));
  try {
    const result = await command(soffice, [
      "--headless",
      `-env:UserInstallation=file://${profile}`,
      "--convert-to",
      "xlsx",
      "--outdir",
      recalcDir,
      targetWorkbook,
    ]);
    const converted = path.join(recalcDir, path.basename(targetWorkbook));
    if (!result.ok) return fail("LibreOffice recalculation failed.", { stderr: result.stderr.slice(-4000) });
    await fs.access(converted);
    await fs.copyFile(converted, targetWorkbook);
    return { status: "PASS" };
  } catch (error) {
    return fail("LibreOffice did not produce a recalculated workbook.", { error: error.message });
  } finally {
    await fs.rm(recalcDir, { recursive: true, force: true });
    await fs.rm(profile, { recursive: true, force: true });
  }
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
    /validate_(cache_parity|style_tokens|source_parity|structure)\.mjs$/.test(target));
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
      "[--case-only] [--python <python>] [--soffice <path>] " +
      "[--workspace-token <token>] [--json]",
    );
  }

  const casePath = path.resolve(positional[0]);
  const isolated = await assertRunRootOutsideSkill({ skillRoot: ROOT, runRoot: options.out });
  const runDir = isolated.run_root;
  await fs.mkdir(runDir, { recursive: true });
  const modelCase = await json(casePath);
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
  const lease = await acquireRunLease(runDir, { owner: `orchestrate_release:${runId}` });
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
      ...inputs,
    };
    const inspected = await store.inspect({ checkpointId: id, recipe, inputHashes, outputs });
    if (inspected.reusable) {
      reusedCheckpoints.push(id);
      checkpointReceipts[id] = inspected.receipt.receipt_hash;
      timingsMs[id] = 0;
      return { ok: true, receipt: inspected.receipt, reused: true };
    }

    await store.reset(id);
    const started = process.hrtime.bigint();
    let result;
    try {
      result = await action(store.workDir(id));
    } catch (error) {
      result = fail(`Checkpoint ${id} threw before its gate completed.`, { error: error.stack ?? error.message });
    }
    timingsMs[id] = Number(process.hrtime.bigint() - started) / 1e6;
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

  const recalcDir = store.workDir("recalculate_patch");
  const patchedWorkbook = path.join(recalcDir, "model.xlsx");
  const recalcOutputs = { patched_workbook: patchedWorkbook, ...sidecarOutputs(patchedWorkbook) };
  step = await checkpoint({
    id: "recalculate_patch",
    recipe: "release-recalculate-patch/1.0",
    inputs: {
      emitted_workbook: await hashFile(emittedWorkbook),
      emit_receipt: checkpointReceipts.emit,
      plan: await hashFile(planPath),
      code: source.emit,
      python: python.identity,
      soffice: soffice.identity,
    },
    outputs: recalcOutputs,
    action: async (workDir) => {
      const recalculated = await recalcWithSoffice(soffice.path, emittedWorkbook, patchedWorkbook, workDir);
      if (recalculated.status !== "PASS") return recalculated;
      await copySidecars(planWorkbook, patchedWorkbook);
      const patched = await command(python.path, [path.join(HERE, "emit", "__main__.py"), "patch", planPath, "--out", patchedWorkbook]);
      if (!patched.ok) return fail("N12 terminal patch after LibreOffice failed.", { stderr: patched.stderr.slice(-4000) });
      return { status: "PASS", detail: { recalculated: true, terminal_patch: true } };
    },
  });
  if (!step.ok) return step.result;

  const verifyDir = store.workDir("verify");
  const validationReport = path.join(verifyDir, "validation-report.json");
  const styleReport = path.join(verifyDir, "style-tokens.json");
  const cacheReport = path.join(verifyDir, "cache-parity.json");
  const financeReport = path.join(verifyDir, "finance-proof.json");
  step = await checkpoint({
    id: "verify",
    recipe: "release-independent-verify/1.0",
    inputs: {
      workbook: await hashFile(patchedWorkbook),
      recalculate_patch_receipt: checkpointReceipts.recalculate_patch,
      code: source.verify,
      python: python.identity,
      node: hashValue(process.version),
    },
    outputs: {
      validation_report: validationReport,
      style_report: styleReport,
      cache_report: cacheReport,
      finance_report: financeReport,
    },
    action: async (workDir) => {
      const [verified, styled, cached, financed] = await Promise.all([
        command(python.path, [path.join(HERE, "verify", "validate_dynamic_model.py"), patchedWorkbook, "--out", workDir]),
        command(process.execPath, [path.join(HERE, "validate_style_tokens.mjs"), patchedWorkbook, "--json", styleReport]),
        command(process.execPath, [path.join(HERE, "validate_cache_parity.mjs"), patchedWorkbook, "--json", cacheReport]),
        command(python.path, [path.join(HERE, "verify", "finance_proof.py"), casePath, patchedWorkbook, "--out", financeReport]),
      ]);
      if (!verified.ok) return fail("N13 portable independent validation failed.", { stdout: verified.stdout.slice(-4000), stderr: verified.stderr.slice(-4000) });
      if (!styled.ok) return fail("N13 style-token validation failed.", { stdout: styled.stdout.slice(-4000), stderr: styled.stderr.slice(-4000) });
      if (!cached.ok) return fail("N13 cache parity failed.", { stdout: cached.stdout.slice(-4000), stderr: cached.stderr.slice(-4000) });
      if (!financed.ok) return fail("N13 independent finance proof failed.", { stdout: financed.stdout.slice(-4000), stderr: financed.stderr.slice(-4000) });
      const [validation, style, cache, finance] = await Promise.all([
        json(validationReport),
        json(styleReport),
        json(cacheReport),
        json(financeReport),
      ]);
      if (!["PASS", "PASS_PENDING_MANUAL"].includes(validation.status) || Number(validation.total_violations ?? validation.summary?.total_violations ?? 0) !== 0) {
        return fail("N13 independent validation report did not clear with zero violations.", { report_status: validation.status, total_violations: validation.total_violations ?? validation.summary?.total_violations ?? null });
      }
      const cacheBlindBuckets = Object.fromEntries(
        ["unsupported", "parse_errors", "eval_errors", "no_cache"].map((key) => [key, (cache[key] ?? []).length]),
      );
      const cacheStrict =
        cache.status === "PASS" &&
        Number(cache.disagreements ?? 0) === 0 &&
        Number(cache.stats?.formula_cells ?? 0) > 0 &&
        Number(cache.stats?.checked ?? 0) > 0 &&
        Object.values(cacheBlindBuckets).every((count) => count === 0);
      const financeViolations = Number(finance.summary?.violations ?? finance.total_violations ?? 0);
      const financeComparisons = Number(finance.summary?.comparisons ?? finance.comparisons ?? 0);
      if (style.status !== "PASS" || !cacheStrict || finance.status !== "PASS" || financeViolations !== 0 || financeComparisons <= 0) {
        return fail("N13 style, strict cache coverage or independent finance proof did not clear.", {
          style_status: style.status,
          cache_status: cache.status,
          cache_disagreements: cache.disagreements ?? null,
          cache_blind_buckets: cacheBlindBuckets,
          cache_formula_cells: cache.stats?.formula_cells ?? null,
          cache_checked: cache.stats?.checked ?? null,
          finance_status: finance.status,
          finance_violations: financeViolations,
          finance_comparisons: financeComparisons,
        });
      }
      return {
        status: "PASS",
        detail: {
          validation_status: validation.status,
          total_violations: validation.total_violations ?? validation.summary?.total_violations ?? 0,
          style_status: style.status,
          cache_status: cache.status,
          cache_blind_buckets: cacheBlindBuckets,
          finance_status: finance.status,
          finance_comparisons: financeComparisons,
        },
      };
    },
  });
  if (!step.ok) return step.result;

  const rowMap = await json(`${patchedWorkbook}.row-map.json`);
  const baselineCase = { maximal: "standard-maximal", net_cash: "standard-net-cash" }[rowMap.authority_profile];
  if (!baselineCase) return fail("N14 is BLOCKED: the row map does not resolve to an approved reusable visual authority.", { authority_profile: rowMap.authority_profile ?? null });
  const renderDir = store.workDir("render");
  const renderIndex = path.join(renderDir, "render-evidence-index.json");
  step = await checkpoint({
    id: "render",
    recipe: "release-structural-render/1.0",
    inputs: {
      workbook: await hashFile(patchedWorkbook),
      row_map: await hashFile(`${patchedWorkbook}.row-map.json`),
      verify_receipt: checkpointReceipts.verify,
      code: source.render,
      render_mode: hashValue("structural-only-no-pixel-baseline"),
      baseline_case: hashValue(baselineCase),
      python: python.identity,
      soffice: soffice.identity,
    },
    outputs: { render_directory: { path: renderDir, kind: "directory" } },
    action: async (workDir) => {
      const rendered = await command(python.path, [
        path.join(HERE, "render", "check_render.py"),
        patchedWorkbook,
        "--out", workDir,
        "--baseline-case", baselineCase,
        "--structural-only",
        "--soffice", soffice.path,
      ]);
      if (!rendered.ok) return fail("N14 render validation failed or was blocked.", { stdout: rendered.stdout.slice(-4000), stderr: rendered.stderr.slice(-4000) });
      const index = await json(renderIndex);
      if ((index.cases ?? []).length === 0 || index.cases.some((entry) => entry.verdict !== "PASS")) {
        return fail("N14 render evidence did not return PASS for every visible sheet.", { cases: index.cases ?? [] });
      }
      return {
        status: "PASS",
        detail: {
          baseline_case: baselineCase,
          mode: "structural-only-no-pixel-baseline",
          cases: index.cases.length,
        },
      };
    },
  });
  if (!step.ok) return step.result;

  const finalWorkbook = path.join(runDir, "model.xlsx");
  const finalVerifyDir = path.join(runDir, "verify");
  const finalRenderDir = path.join(runDir, "render");
  const finalSemantic = path.join(runDir, "n0-n9-gates.json");
  const publicationPath = path.join(store.workDir("publish"), "publication.json");
  const publishOutputs = {
    workbook: finalWorkbook,
    semantic_gates: finalSemantic,
    verify: { path: finalVerifyDir, kind: "directory" },
    render: { path: finalRenderDir, kind: "directory" },
    publication: publicationPath,
    ...sidecarOutputs(finalWorkbook),
  };
  step = await checkpoint({
    id: "publish",
    recipe: "release-publish-artifacts/1.0",
    inputs: {
      render_receipt: checkpointReceipts.render,
      verify_receipt: checkpointReceipts.verify,
      recalculate_patch_receipt: checkpointReceipts.recalculate_patch,
    },
    outputs: publishOutputs,
    action: async (workDir) => {
      await atomicCopyFile(patchedWorkbook, finalWorkbook);
      for (const suffix of SIDECAR_SUFFIXES) {
        await atomicCopyFile(`${patchedWorkbook}${suffix}`, `${finalWorkbook}${suffix}`);
      }
      await atomicCopyFile(semanticResultPath, finalSemantic);
      await atomicReplaceDirectory(verifyDir, finalVerifyDir);
      await atomicReplaceDirectory(renderDir, finalRenderDir);
      await writeIsolationJson(path.join(workDir, "publication.json"), {
        schema_version: "stage4-publication/1.0",
        workbook: "model.xlsx",
        authority_profile: rowMap.authority_profile,
        automated_status: "PASS_PENDING_MANUAL",
        total_violations: 0,
      });
      return { status: "PASS", detail: { workbook: "model.xlsx", total_violations: 0 } };
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
      order: CHECKPOINT_ORDER,
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
    const result = await main();
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
