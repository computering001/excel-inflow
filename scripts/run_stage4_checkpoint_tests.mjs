#!/usr/bin/env node

/**
 * Real Stage-4 interruption and recovery test.
 *
 * This is intentionally not a simulated receipt-chain test. It lets the
 * production controller complete semantic gates, planning and emission, then
 * forces the outer Stage-4 timeout while LibreOffice is delayed. The same run
 * is resumed and must reuse exactly the completed internal checkpoints.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(binary, args, { timeout = 300000, allowFailure = false } = {}) {
  try {
    return await exec(binary, args, {
      cwd: ROOT,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, error };
  }
}

async function resolvePython(explicit) {
  const candidates = [
    explicit,
    process.env.DEBT_OVERLAY_PYTHON,
    "fixtures/external/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12",
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = await run(candidate, ["-c", "import openpyxl; print(openpyxl.__version__)"], { timeout: 30000, allowFailure: true });
    if (!probe.error) return candidate;
  }
  throw new Error("No Python runtime with openpyxl was available for the Stage-4 test.");
}

async function resolveSoffice(explicit) {
  const candidates = [
    explicit,
    process.env.SOFFICE_BIN,
    "fixtures/external/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice",
    "soffice",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = await run(candidate, ["--version"], { timeout: 30000, allowFailure: true });
    if (!probe.error) return candidate;
  }
  throw new Error("LibreOffice was unavailable for the Stage-4 test.");
}

async function flow(evidence, runDir, args = [], options = {}) {
  const result = await run(process.execPath, [
    path.join(HERE, "test-support", "authenticated_controller_test_harness.mjs"),
    "user_flow",
    evidence,
    "--out", runDir,
    ...args,
    "--json",
  ], options);
  return JSON.parse(result.stdout);
}

async function sha256(target) {
  const bytes = await fs.readFile(target);
  return createHash("sha256").update(bytes).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const options = parseArgs(process.argv.slice(2));
const out = options.out
  ? path.resolve(options.out)
  : await fs.mkdtemp(path.join(os.tmpdir(), "dmu-stage4-checkpoints-"));
const cases = path.resolve(
  options.cases ??
  process.env.DEBT_OVERLAY_CASES_DIR ??
  "fixtures/external/Codex/2026-07-24/ok/work/v2-certification/cases",
);
const python = await resolvePython(options.python);
const soffice = await resolveSoffice(options.soffice);
await fs.mkdir(out, { recursive: true });

const evidence = path.join(out, "clean-evidence-run.json");
await run(process.execPath, [
  path.join(HERE, "run_evidence_run_tests.mjs"),
  cases,
  "--emit-clean", evidence,
]);

const runDir = path.join(out, "interrupted-run");
const paused = await flow(evidence, runDir, ["--stop-after", "decisions"]);
assert(paused.status === "PAUSED" && paused.stage === "decisions", `Could not establish Stage 3: ${JSON.stringify(paused)}`);

const slowSoffice = path.join(out, "slow-soffice");
await fs.writeFile(slowSoffice, [
  "#!/bin/sh",
  "if [ \"$1\" = \"--version\" ]; then",
  `  exec ${shellQuote(soffice)} \"$@\"`,
  "fi",
  "sleep 30",
  `exec ${shellQuote(soffice)} \"$@\"`,
  "",
].join("\n"), "utf8");
await fs.chmod(slowSoffice, 0o755);

const interrupted = await flow(evidence, runDir, [
  // This timeout measures the deliberately delayed recalculation boundary, not
  // plan/emitter speed. The current graph and provenance gates can legitimately
  // consume more than twelve seconds on a loaded host, so leave 25 seconds for
  // the deterministic pre-recalc checkpoints; the wrapper then sleeps for 30
  // seconds and guarantees the outer controller is still interrupted inside
  // recalculation rather than before a reusable receipt exists.
  "--timeout", "25000",
  "--python", python,
  "--soffice", slowSoffice,
], { allowFailure: true });
assert(interrupted.status === "BLOCKED" && interrupted.stage === "build_checks", `Forced timeout did not block Stage 4: ${JSON.stringify(interrupted)}`);
assert(interrupted.reused_stages.join(",") === "inputs,evidence_review,decisions", "Forced timeout did not retain user Stages 1-3.");

const casePath = path.join(runDir, "stages", "decisions", "model-case.json");
const stage3Case = JSON.parse(await fs.readFile(casePath, "utf8"));
const stage3CashRows = new Map(
  (stage3Case.statement_structure?.cash_flow ?? []).map((row) => [
    row.semantic_role ?? row.row_id,
    row,
  ]),
);
const stage3CashCacheSyncs = (cashRows) => {
  const opening = cashRows.get("opening_cash");
  const movement = cashRows.get("net_change_in_cash");
  const fx = cashRows.get("fx_effect_on_cash");
  const ending = cashRows.get("ending_cash");
  return [0, 1, 2].every(
    (period) =>
      Number(ending?.values?.[period]) ===
        Number(ending?.reported_historical_values?.[period]) &&
      Number(ending?.values?.[period]) ===
        Number(opening?.values?.[period]) +
          Number(movement?.values?.[period]) +
          Number(fx?.values?.[period]),
  );
};
assert(
  stage3CashCacheSyncs(stage3CashRows),
  "Stage 3 materialisation replaced reconciled historical cash caches.",
);
const mutatedStage3CashRows = new Map(
  [...stage3CashRows].map(([role, row]) => [role, structuredClone(row)]),
);
mutatedStage3CashRows.get("ending_cash").values[2] -= 1;
assert(
  !stage3CashCacheSyncs(mutatedStage3CashRows),
  "Stage 3 historical cash cache mutation was not detected.",
);
const caseHash = await sha256(casePath);
const buildDir = path.join(runDir, `build-${caseHash.slice(0, 12)}`);
const receiptDir = path.join(buildDir, ".stage4", "receipts");
for (const id of ["semantic_gates", "plan", "emit"]) {
  const receipt = JSON.parse(await fs.readFile(path.join(receiptDir, `${id}.json`), "utf8"));
  assert(receipt.status === "success", `${id} did not complete before the forced timeout.`);
}
await fs.access(path.join(receiptDir, "recalculate.json")).then(
  () => { throw new Error("recalculate incorrectly wrote a receipt before the killed action completed."); },
  () => {},
);

const recovered = await flow(evidence, runDir, [
  "--python", python,
  "--soffice", soffice,
  // The review gate is fail-closed; the recovery pass replays the user's
  // accept so delivery can complete.
  "--review-deliver",
]);
assert(recovered.status === "PASS_PENDING_MANUAL" && recovered.stage === "delivery", `Recovery did not deliver: ${JSON.stringify(recovered)}`);
const recoveredBuild = JSON.parse(await fs.readFile(path.join(runDir, "stages", "build_checks", "build-result.json"), "utf8"));
assert(recoveredBuild.total_violations === 0, "Recovered build has violations.");
assert(
  ["semantic_gates", "plan", "emit"].every((id) => recoveredBuild.checkpointing.reused.includes(id)),
  `Recovery did not reuse completed checkpoints: ${JSON.stringify(recoveredBuild.checkpointing)}`,
);
assert(
  [
    "recalculate", "terminal_patch", "verify_dynamic", "verify_style",
    "verify_cache", "verify_finance", "verify_semantic", "verify_aggregate",
    "render_sheet_01", "render_sheet_02", "render_sheet_03", "render", "publish",
  ].every((id) => recoveredBuild.checkpointing.executed.includes(id)),
  `Recovery did not restart at recalculation: ${JSON.stringify(recoveredBuild.checkpointing)}`,
);

const workbook = recovered.workbook;
const recoveredWorkbookHash = await sha256(workbook);
const emittedWorkbook = path.join(buildDir, ".stage4", "work", "emit", "model.xlsx");
await fs.rename(emittedWorkbook, `${emittedWorkbook}.missing-output-test`);
const scratchReuse = await flow(evidence, runDir, [
  "--python", python,
  "--soffice", soffice,
  "--review-deliver",
]);
assert(
  scratchReuse.reused_stages.join(",") === "inputs,evidence_review,decisions,build_checks,delivery",
  `Internal scratch loss invalidated a complete published closure: ${JSON.stringify(scratchReuse)}`,
);
assert(await sha256(workbook) === recoveredWorkbookHash, "Internal scratch loss changed the delivered workbook.");

await fs.rename(workbook, `${workbook}.missing-output-test`);
const repaired = await flow(evidence, runDir, [
  "--python", python,
  "--soffice", soffice,
  "--review-deliver",
]);
assert(repaired.status === "PASS_PENDING_MANUAL", `Missing-output repair did not deliver: ${JSON.stringify(repaired)}`);
const repairedBuild = JSON.parse(await fs.readFile(path.join(runDir, "stages", "build_checks", "build-result.json"), "utf8"));
assert(
  repairedBuild.checkpointing.executed.join(",") === "emit,publish",
  `Missing published output did not invalidate only emit and publish: ${JSON.stringify(repairedBuild.checkpointing)}`,
);
assert(
  repairedBuild.checkpointing.reused.length ===
      repairedBuild.checkpointing.order.length - 2 &&
    !repairedBuild.checkpointing.reused.includes("emit") &&
    !repairedBuild.checkpointing.reused.includes("publish"),
  `Unaffected checkpoints were not retained: ${JSON.stringify(repairedBuild.checkpointing)}`,
);
assert(await sha256(workbook) === recoveredWorkbookHash, "Targeted checkpoint repair changed the delivered workbook.");

// Damage one render leaf as well as the published workbook.  The controller
// must rerun that sheet, the aggregate render index and publication, while
// retaining every other rendered sheet and every economic validator.
const renderLeaf = repairedBuild.checkpointing.order.find(
  (id) => id === "render_sheet_02",
);
assert(renderLeaf, "Expected a second visible-sheet render checkpoint.");
const renderLeafOutput = path.join(
  buildDir,
  ".stage4",
  "work",
  renderLeaf,
  "render-evidence-index.json",
);
await fs.rename(renderLeafOutput, `${renderLeafOutput}.missing-output-test`);
await fs.rename(workbook, `${workbook}.render-leaf-test`);
const renderLeafRepair = await flow(evidence, runDir, [
  "--python", python,
  "--soffice", soffice,
]);
assert(
  renderLeafRepair.status === "PASS_PENDING_MANUAL",
  `Render-leaf repair did not deliver: ${JSON.stringify(renderLeafRepair)}`,
);
const renderLeafBuild = JSON.parse(
  await fs.readFile(
    path.join(runDir, "stages", "build_checks", "build-result.json"),
    "utf8",
  ),
);
const expectedLeafExecutions = [renderLeaf, "render", "publish"];
assert(
  renderLeafBuild.checkpointing.executed.join(",") ===
    expectedLeafExecutions.join(","),
  `One damaged render leaf reran unrelated work: ${JSON.stringify(renderLeafBuild.checkpointing)}`,
);
assert(
  ["render_sheet_01", "render_sheet_03", "verify_dynamic", "verify_finance"]
    .every((id) => renderLeafBuild.checkpointing.reused.includes(id)),
  `Unaffected render/economic leaves were not retained: ${JSON.stringify(renderLeafBuild.checkpointing)}`,
);
assert(
  await sha256(workbook) === recoveredWorkbookHash,
  "Render-leaf repair changed the delivered workbook.",
);

const finalReuse = await flow(evidence, runDir, [
  "--python", python,
  "--soffice", soffice,
]);
assert(
  finalReuse.reused_stages.join(",") === "inputs,evidence_review,decisions,build_checks,delivery",
  `Identical final replay did not reuse all five user stages: ${JSON.stringify(finalReuse)}`,
);

const report = {
  schema_version: "stage4-checkpoint-test-report/1.0",
  status: "PASS",
  total_violations: 0,
  tests: [
    { id: "stage3-reconciled-historical-cash-cache", status: "PASS", mutation: "BLOCKED" },
    { id: "real-mid-build-timeout", status: "PASS" },
    { id: "resume-from-last-internal-success", status: "PASS", reused: recoveredBuild.checkpointing.reused },
    { id: "internal-scratch-loss-does-not-invalidate-published-closure", status: "PASS", reused: scratchReuse.reused_stages },
    { id: "missing-published-output-targeted-invalidation", status: "PASS", executed: repairedBuild.checkpointing.executed },
    { id: "single-render-leaf-targeted-invalidation", status: "PASS", executed: renderLeafBuild.checkpointing.executed },
    { id: "delivered-workbook-identity-after-repair", status: "PASS", sha256: recoveredWorkbookHash },
    { id: "five-user-stage-final-reuse", status: "PASS", reused: finalReuse.reused_stages },
  ],
  evidence: {
    run_directory: runDir,
    build_directory: buildDir,
    workbook,
  },
};
await fs.writeFile(path.join(out, "stage4-checkpoint-test-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
