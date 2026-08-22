#!/usr/bin/env node
/**
 * P6.2 — THE STAGE RECIPE AND THE DERIVED STAGE CLOSURE.
 *
 * Invariant under test: every stage receipt declares the RECIPE that produced
 * it — a versioned identity covering the stage's code closure, the policy and
 * contract versions it read, and its input hashes — so a receipt from a
 * different recipe is not reusable, and a cache miss can be EXPLAINED rather
 * than merely observed.
 *
 * The four reds this suite pins, all measured before the repair:
 *
 *  RED 1  `user-stage-receipt/1.0` had NO recipe field. Reuse was guarded by
 *         `FLOW_CONTROLLER_VERSION` — a hand-edited string — plus a runtime
 *         digest whose membership was a hand-maintained list.
 *  RED 2  That list (`STAGE_RUNTIME_MEMBERS`, run_user_flow.mjs) was not closed
 *         over the real import graph. Its `inputs` entry named 13 JavaScript
 *         modules; the transitive closure of those same 13 modules is 98. So a
 *         change to solver.mjs, run_deadline.mjs, semantic_graph.mjs — all
 *         genuinely executed — left the stage receipt reusable.
 *  RED 3  `build_checks` was a catch-all: every declared runtime file except
 *         `references/`. SKILL.md was therefore a build input, so editing the
 *         README cold-started the whole build.
 *  RED 4  Stage-3 blocked paths keyed on `{ stage2_receipt }` or
 *         `{ stage2_receipt, answers }` while the success path keyed on four
 *         components, and the stage-4 refusal path keyed on three of eight. The
 *         two keys were not comparable, so a miss could never be explained.
 *
 * The authoritative ES import scanner (scripts/lib/release_js_import_scanner.mjs)
 * is used HERE, not in the shipped controller: it is not a declared runtime
 * member, and the release compiler reconciles `script_allowlist` against the
 * import closure in both directions, so a shipped module may only import
 * shipped modules. The production derivation therefore uses a deliberately
 * WIDER path-token scan, and this suite proves the wider scan admits every edge
 * the authoritative grammar finds.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FLOW_CONTROLLER_VERSION,
  FLOW_SCHEMA_VERSION,
  REQUIRED_STAGE_CONTRACT_VERSIONS,
  STAGE_RECEIPT_SCHEMA_VERSION,
  STAGE_RECIPE_SCHEMA_VERSION,
  SUPERSEDED_STAGE_RECEIPT_SCHEMA_VERSIONS,
  createStageRecipe,
  createStageReceipt,
  verifyStageReceipt,
} from "./lib/flow_runtime.mjs";
import {
  STAGE_CLOSURE_ENTRYPOINTS,
  STAGE_RUNTIME_CLOSURE_SCHEMA,
  bindStageRecipes,
  deriveStageRuntimeClosure,
  releaseStageRecipes,
  stageRecipeFor,
} from "./lib/user_flow_controller.mjs";
import { canonicalise, hashValue } from "./lib/run_store.mjs";
import { captureRuntimeIntegrity } from "./lib/runtime_isolation.mjs";
import { RUNTIME_BUDGET_POLICY_SCHEMA } from "./lib/runtime_budget_policy.mjs";
import {
  hasNonLiteralDynamicImport,
  specifiersOf,
} from "./lib/release_js_import_scanner.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const cases = path.resolve(
  process.argv[2] ??
    process.env.DEBT_OVERLAY_CASES_DIR ??
    fileURLToPath(new URL("../test-fixtures/cases", import.meta.url)),
);

let checks = 0;
const failures = [];
// Honest mutation accounting: every MUTATION-declared check applies one real
// defect (a moved closure, a foreign policy version, a rewritten hash, a
// downgraded schema, a stripped recipe) to a copy of a receipt/recipe pair
// and is counted CAUGHT only when production refuses it while the mutant is
// active; a surviving mutant lands in failures and fails the suite.
let mutations_total = 0;
let mutations_caught = 0;
function check(condition, message) {
  const isMutation = typeof message === "string" && /^MUTATION/.test(message);
  if (isMutation) mutations_total += 1;
  checks += 1;
  if (!condition) failures.push(message);
  else if (isMutation) mutations_caught += 1;
}
function rejects(message, callback, pattern) {
  const isMutation = typeof message === "string" && /^MUTATION/.test(message);
  if (isMutation) mutations_total += 1;
  checks += 1;
  try {
    callback();
    failures.push(`${message}: no refusal was raised`);
  } catch (error) {
    if (pattern && !pattern.test(String(error.message))) {
      failures.push(`${message}: refused with the wrong reason: ${error.message}`);
      return;
    }
    if (isMutation) mutations_caught += 1;
  }
}

async function command(script, args, { allowFailure = false } = {}) {
  try {
    return await exec(process.execPath, [path.join(HERE, script), ...args], {
      cwd: ROOT,
      timeout: 600000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "stage-recipe-tests-"));

// The list P6.2 deleted from run_user_flow.mjs, pinned so RED 2 stays proved.
const HISTORICAL_INPUTS_MEMBERS = Object.freeze([
  "scripts/run_user_flow.mjs",
  "scripts/lib/evidence_run.mjs",
  "scripts/lib/case_compiler.mjs",
  "scripts/lib/face_statement_manifest.mjs",
  "scripts/lib/forecast_observation.mjs",
  "scripts/lib/json_schema.mjs",
  "scripts/lib/flow_runtime.mjs",
  "scripts/lib/user_flow_controller.mjs",
  "scripts/lib/run_store.mjs",
  "scripts/lib/process_tree.mjs",
  "scripts/lib/runtime_isolation.mjs",
  "scripts/lib/run_carrier.mjs",
  "scripts/lib/broker_intake_choice.mjs",
]);

const JS_MEMBER = /\.(?:mjs|cjs|js)$/;

try {
  const integrity = await captureRuntimeIntegrity(ROOT);
  const closure = await deriveStageRuntimeClosure({ skillRoot: ROOT, integrity });
  const contractVersions = {
    runtime_integrity_schema: integrity.schema_version,
    runtime_budget_policy_schema: RUNTIME_BUDGET_POLICY_SCHEMA,
  };
  bindStageRecipes({ closure, contractVersions });

  // ------------------------------------------------------------------
  // GROUP D — the closure is DERIVED, and the derivation is provably complete.
  // ------------------------------------------------------------------
  check(closure.schema_version === STAGE_RUNTIME_CLOSURE_SCHEMA, "closure schema is not declared");
  check(closure.member_count === closure.members.length, "closure member count disagrees with its members");
  check(closure.member_count > 200, `closure is implausibly small: ${closure.member_count}`);
  check(
    STAGE_CLOSURE_ENTRYPOINTS.includes("scripts/orchestrate_release.mjs"),
    "stage 4 spawns the release orchestrator but it is not a closure entrypoint",
  );
  const inventory = integrity.runtime_code_closure.files;
  check(
    closure.members.every((member) => Object.hasOwn(inventory, member)),
    "a closure member is not a declared runtime-code member",
  );

  // D — transitive closure, proved with the AUTHORITATIVE scanner.
  const executable = closure.executable_members.filter((member) => JS_MEMBER.test(member));
  const memberSet = new Set(closure.members);
  const unresolvedEdges = [];
  const unclosedEdges = [];
  const opaqueMembers = [];
  const bareSpecifiers = new Set();
  for (const member of executable) {
    const source = await fs.readFile(path.join(ROOT, ...member.split("/")), "utf8");
    if (hasNonLiteralDynamicImport(source)) opaqueMembers.push(member);
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith(".")) {
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(member), specifier),
        );
        if (!Object.hasOwn(inventory, resolved)) unresolvedEdges.push(`${member} -> ${specifier}`);
        else if (!memberSet.has(resolved)) unclosedEdges.push(`${member} -> ${resolved}`);
        continue;
      }
      if (specifier.startsWith("node:")) continue;
      bareSpecifiers.add(specifier);
    }
  }
  check(executable.length > 90, `too few executable members derived: ${executable.length}`);
  check(
    unclosedEdges.length === 0,
    `the derived closure is not closed over the real import graph: ${unclosedEdges.slice(0, 5).join(", ")}`,
  );
  check(
    unresolvedEdges.length === 0,
    `a closure member imports something outside the declared runtime: ${unresolvedEdges.slice(0, 5).join(", ")}`,
  );
  check(
    opaqueMembers.length === 0,
    `a closure member has a non-literal dynamic import, so its edges cannot be enumerated: ${opaqueMembers.join(", ")}`,
  );
  for (const specifier of bareSpecifiers) {
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    const vendored = Object.keys(inventory).filter((key) =>
      key.startsWith(`node_modules/${name}/`),
    );
    check(vendored.length > 0, `bare specifier ${specifier} has no vendored member`);
    check(
      vendored.every((key) => memberSet.has(key)),
      `vendored bytes for ${specifier} are not all closure members`,
    );
  }

  // RED 2 — the hand-maintained list was a strict, and large, understatement.
  const omittedByHand = executable.filter(
    (member) => !HISTORICAL_INPUTS_MEMBERS.includes(member),
  );
  check(
    HISTORICAL_INPUTS_MEMBERS.every((member) => memberSet.has(member)),
    "the historical hand-maintained list named a module the derived closure does not contain",
  );
  check(
    omittedByHand.length > 60,
    `RED 2 is no longer demonstrable: the hand list omitted only ${omittedByHand.length} executed modules`,
  );
  for (const executed of ["scripts/lib/solver.mjs", "scripts/lib/run_deadline.mjs", "scripts/lib/semantic_graph.mjs"]) {
    check(
      memberSet.has(executed) && !HISTORICAL_INPUTS_MEMBERS.includes(executed),
      `${executed} is executed by the flow but the hand list did not guard it`,
    );
  }

  // RED 3 — instruction files are not build inputs.
  check(
    !closure.members.some((member) => member === "SKILL.md" || member.startsWith("references/")),
    "an instruction file is still a closure member",
  );
  const oldBuildChecksDigest = (files) =>
    hashValue(
      Object.fromEntries(
        Object.entries(files)
          .filter(([key]) => !key.startsWith("references/"))
          .sort(),
      ),
    );
  const withEditedInstructions = {
    ...integrity,
    files: { ...integrity.files, "SKILL.md": "f".repeat(64) },
    runtime_code_closure: {
      ...integrity.runtime_code_closure,
      files: { ...integrity.runtime_code_closure.files },
    },
  };
  const afterInstructionEdit = await deriveStageRuntimeClosure({
    skillRoot: ROOT,
    integrity: withEditedInstructions,
  });
  check(
    afterInstructionEdit.digest === closure.digest,
    "RED 3 is unrepaired: editing SKILL.md still moves the stage closure digest",
  );
  check(
    oldBuildChecksDigest(withEditedInstructions.files) !== oldBuildChecksDigest(integrity.files),
    "RED 3 is no longer demonstrable: the catch-all rule was insensitive to SKILL.md",
  );

  // The narrowing must not have lost anything that matters.
  for (const member of [
    "scripts/lib/solver.mjs",
    "scripts/orchestrate_release.mjs",
    "scripts/emit/plan.py",
    "assets/model-case-v2.schema.json",
    "node_modules/jszip/jszip.min.js",
  ]) {
    check(memberSet.has(member), `${member} must be a stage closure member`);
    const moved = {
      ...integrity,
      files: { ...integrity.files, [member]: "e".repeat(64) },
      runtime_code_closure: {
        ...integrity.runtime_code_closure,
        files: { ...integrity.runtime_code_closure.files, [member]: "e".repeat(64) },
      },
    };
    const after = await deriveStageRuntimeClosure({ skillRoot: ROOT, integrity: moved });
    check(
      after.digest !== closure.digest,
      `a change to ${member} must move the stage closure digest`,
    );
  }

  // Nothing but instruction files and unreachable JavaScript may be excluded.
  const wronglyExcluded = closure.excluded.filter(
    (key) =>
      key !== "SKILL.md" &&
      !key.startsWith("references/") &&
      !JS_MEMBER.test(key),
  );
  check(
    wronglyExcluded.length === 0,
    `the narrowing dropped non-JavaScript runtime bytes: ${wronglyExcluded.slice(0, 5).join(", ")}`,
  );
  check(
    closure.excluded.includes("SKILL.md") && closure.excluded.some((key) => key.startsWith("references/")),
    "the excluded set does not name the instruction files it drops",
  );
  check(
    closure.excluded.filter((key) => JS_MEMBER.test(key)).every((key) => !memberSet.has(key)),
    "a file is both excluded and a member",
  );

  // Determinism and fail-closed entrypoints.
  const again = await deriveStageRuntimeClosure({ skillRoot: ROOT, integrity });
  check(again.digest === closure.digest, "the derivation is not deterministic");
  check(
    hashValue(again.members) === hashValue(closure.members),
    "the derived member list is not stable",
  );
  checks += 1;
  await deriveStageRuntimeClosure({
    skillRoot: ROOT,
    integrity,
    entrypoints: ["scripts/not_a_declared_entrypoint.mjs"],
  }).then(
    () => failures.push("an undeclared entrypoint was accepted"),
    (error) =>
      /not a declared runtime member/.test(String(error.message))
        ? null
        : failures.push(`undeclared entrypoint refused for the wrong reason: ${error.message}`),
  );
  checks += 1;
  await deriveStageRuntimeClosure({ skillRoot: ROOT, integrity: { files: {} } }).then(
    () => failures.push("a missing runtime-code inventory was accepted"),
    () => null,
  );

  // ------------------------------------------------------------------
  // GROUP A — the recipe exists, and it covers the three things it claims.
  // ------------------------------------------------------------------
  check(
    STAGE_RECEIPT_SCHEMA_VERSION === "user-stage-receipt/1.1",
    "the receipt schema was not bumped for the recipe field",
  );
  check(
    SUPERSEDED_STAGE_RECEIPT_SCHEMA_VERSIONS.includes("user-stage-receipt/1.0"),
    "the recipe-less schema is not declared superseded",
  );
  const HASH = "a".repeat(64);
  const inputHashes = { evidence_run: HASH, runtime: closure.digest };
  const recipe = stageRecipeFor({
    stageId: "decisions",
    inputHashes,
    controllerVersion: FLOW_CONTROLLER_VERSION,
  });
  check(recipe.schema_version === STAGE_RECIPE_SCHEMA_VERSION, "recipe schema is not declared");
  check(recipe.code_closure_sha256 === closure.digest, "recipe does not carry the code closure");
  check(
    recipe.code_closure_member_count === closure.member_count,
    "recipe does not carry the closure size",
  );
  check(recipe.input_digest === hashValue(inputHashes), "recipe does not cover the input hashes");
  for (const key of [...REQUIRED_STAGE_CONTRACT_VERSIONS, "flow_schema", "stage_receipt_schema", "visible_journey_contract", "workflow_state_contract"]) {
    check(typeof recipe.policy_versions[key] === "string", `recipe omits the ${key} version`);
  }
  const { recipe_sha256: recipeHash, ...recipeBody } = recipe;
  check(recipeHash === hashValue(canonicalise(recipeBody)), "recipe hash does not cover its body");

  // A caller cannot understate the contracts the recipe was compiled against.
  const forged = createStageRecipe({
    stageId: "decisions",
    codeClosureSha256: closure.digest,
    codeClosureMemberCount: closure.member_count,
    contractVersions: { ...contractVersions, flow_schema: "forged/0.0", workflow_state_contract: "forged/0.0" },
    inputHashes,
  });
  check(
    forged.policy_versions.flow_schema === FLOW_SCHEMA_VERSION,
    "a caller shadowed the flow schema version inside the recipe",
  );
  check(
    forged.policy_versions.workflow_state_contract !== "forged/0.0",
    "a caller shadowed the workflow-state contract version inside the recipe",
  );

  rejects(
    "a recipe without a sha256 closure identity",
    () => createStageRecipe({ stageId: "inputs", codeClosureSha256: "short", codeClosureMemberCount: 1, contractVersions, inputHashes }),
    /sha256 executable-closure identity/,
  );
  rejects(
    "a recipe claiming an empty closure",
    () => createStageRecipe({ stageId: "inputs", codeClosureSha256: closure.digest, codeClosureMemberCount: 0, contractVersions, inputHashes }),
    /positive closure member count/,
  );
  rejects(
    "a recipe that does not name the runtime budget policy",
    () => createStageRecipe({ stageId: "inputs", codeClosureSha256: closure.digest, codeClosureMemberCount: 1, contractVersions: { runtime_integrity_schema: "x/1.0" }, inputHashes }),
    /runtime_budget_policy_schema contract version/,
  );
  rejects(
    "a receipt handed a recipe for a different stage",
    () => createStageReceipt({ runId: "r", stageId: "inputs", status: "success", inputHashes, outputHashes: { out: HASH }, recipe }),
    /invalid recipe/,
  );
  rejects(
    "a receipt handed a recipe for different inputs",
    () => createStageReceipt({ runId: "r", stageId: "decisions", status: "success", inputHashes: { evidence_run: "b".repeat(64) }, outputHashes: { out: HASH }, recipe }),
    /invalid recipe/,
  );

  // The production writer cannot omit the recipe: it has nowhere to get one.
  releaseStageRecipes();
  rejects(
    "MUTATION — a stage receipt written with no bound recipe",
    () => stageRecipeFor({ stageId: "inputs", inputHashes, controllerVersion: FLOW_CONTROLLER_VERSION }),
    /No stage recipe is bound/,
  );
  bindStageRecipes({ closure, contractVersions });

  // ------------------------------------------------------------------
  // GROUP C — a receipt from a DIFFERENT recipe is refused.
  // ------------------------------------------------------------------
  const outputHashes = { model_case: "c".repeat(64) };
  const receipt = createStageReceipt({
    runId: "recipe-run",
    stageId: "decisions",
    status: "success",
    inputHashes,
    outputHashes,
    previousReceiptHash: null,
    recipe,
  });
  check(receipt.recipe?.recipe_sha256 === recipe.recipe_sha256, "receipt does not declare its recipe");
  check(
    verifyStageReceipt(receipt, { runId: "recipe-run", stageId: "decisions", inputHashes, outputHashes, recipe }).resumable,
    "a receipt from the active recipe must remain reusable",
  );

  const movedClosure = createStageRecipe({
    stageId: "decisions",
    codeClosureSha256: "d".repeat(64),
    codeClosureMemberCount: closure.member_count,
    contractVersions,
    inputHashes,
  });
  const movedClosureVerdict = verifyStageReceipt(receipt, {
    runId: "recipe-run",
    stageId: "decisions",
    inputHashes,
    outputHashes,
    recipe: movedClosure,
  });
  check(!movedClosureVerdict.resumable, "MUTATION — a receipt from a different code closure was reusable");
  check(
    movedClosureVerdict.errors.some((reason) => /is not the active recipe/.test(reason)),
    "the refusal did not name the recipe disagreement",
  );

  const movedPolicy = createStageRecipe({
    stageId: "decisions",
    codeClosureSha256: closure.digest,
    codeClosureMemberCount: closure.member_count,
    contractVersions: { ...contractVersions, runtime_budget_policy_schema: "budget/9.9" },
    inputHashes,
  });
  check(
    !verifyStageReceipt(receipt, { runId: "recipe-run", stageId: "decisions", recipe: movedPolicy }).resumable,
    "MUTATION — a receipt from a different policy version was reusable",
  );
  const movedMemberCount = createStageRecipe({
    stageId: "decisions",
    codeClosureSha256: closure.digest,
    codeClosureMemberCount: closure.member_count + 1,
    contractVersions,
    inputHashes,
  });
  check(
    !verifyStageReceipt(receipt, { runId: "recipe-run", stageId: "decisions", recipe: movedMemberCount }).resumable,
    "MUTATION — a receipt claiming a different closure size was reusable",
  );

  // A tampered recipe cannot be made to agree by rewriting its own hash.
  const tampered = {
    ...receipt,
    recipe: { ...receipt.recipe, code_closure_sha256: "d".repeat(64) },
  };
  const tamperedVerdict = verifyStageReceipt(tampered, { runId: "recipe-run", stageId: "decisions" });
  check(!tamperedVerdict.resumable, "MUTATION — a tampered recipe body was reusable");
  check(
    tamperedVerdict.errors.some((reason) => /recipe hash does not match its own body/.test(reason)),
    "a tampered recipe body was not detected",
  );

  // ------------------------------------------------------------------
  // GROUP B — the migration rule: an older receipt is REFUSED, not reinterpreted.
  // ------------------------------------------------------------------
  const downgraded = (() => {
    const { recipe: _dropped, receipt_hash: _hash, ...body } = receipt;
    const legacy = { ...body, schema_version: "user-stage-receipt/1.0" };
    return { ...legacy, receipt_hash: hashValue(legacy) };
  })();
  const legacyVerdict = verifyStageReceipt(downgraded, {
    runId: "recipe-run",
    stageId: "decisions",
    inputHashes,
    outputHashes,
    recipe,
  });
  check(!legacyVerdict.ok, "MUTATION — a user-stage-receipt/1.0 receipt was accepted as current");
  check(!legacyVerdict.resumable, "a user-stage-receipt/1.0 receipt was reusable");
  check(
    legacyVerdict.errors.some((reason) => /superseded by user-stage-receipt\/1\.1/.test(reason)),
    "the refusal did not name the superseded schema",
  );
  check(
    legacyVerdict.errors.some((reason) => /never reinterpreted/.test(reason)),
    "the refusal did not state that an older receipt is not reinterpreted",
  );
  check(
    legacyVerdict.errors.some((reason) => /declares no recipe/.test(reason)),
    "the refusal did not name the missing recipe",
  );

  // Belt and braces: a CURRENT-schema receipt that carries no recipe is also
  // never reusable, and it is refused without being handed an expected recipe.
  const recipeless = createStageReceipt({
    runId: "recipe-run",
    stageId: "decisions",
    status: "success",
    inputHashes,
    outputHashes,
  });
  const recipelessVerdict = verifyStageReceipt(recipeless, { runId: "recipe-run", stageId: "decisions" });
  check(recipeless.recipe === null, "a recipe-less receipt did not record the absence");
  check(!recipelessVerdict.resumable, "MUTATION — a recipe-less receipt was reusable");
  check(
    recipelessVerdict.errors.some((reason) => /never reusable/.test(reason)),
    "a recipe-less receipt was not refused by name",
  );

  // ------------------------------------------------------------------
  // GROUP E — ONE input shape per stage, and an EXPLAINED miss.
  // ------------------------------------------------------------------
  const controllerSource = await fs.readFile(path.join(ROOT, "scripts", "run_user_flow.mjs"), "utf8");
  const ALLOWED_INPUT_SHAPES = /^(stage[1-6]Inputs,|reviewInputs,|stage3InputsFor\()/;
  const inputShapeSites = [...controllerSource.matchAll(/inputHashes:\s*(\S.*)$/gm)].map(
    (match) => match[1].trim(),
  );
  check(inputShapeSites.length >= 15, `too few inputHashes sites found: ${inputShapeSites.length}`);
  const adHocShapes = inputShapeSites.filter((value) => !ALLOWED_INPUT_SHAPES.test(value));
  check(
    adHocShapes.length === 0,
    `a stage receipt is still keyed on an ad-hoc input shape: ${adHocShapes.join(" | ")}`,
  );
  check(
    !controllerSource.includes("STAGE_RUNTIME_MEMBERS"),
    "the hand-maintained stage membership list is still present",
  );
  check(
    controllerSource.indexOf("const stage4Inputs =") <
      controllerSource.indexOf('path.join(stage4Dir, "case-mutation.json")'),
    "the stage-4 input shape is not computed before the first path that can refuse the stage",
  );

  // explainMiss names the component that moved, for each component.
  const controllerLib = await fs.readFile(
    path.join(ROOT, "scripts", "lib", "user_flow_controller.mjs"),
    "utf8",
  );
  check(
    /explainMiss\(/.test(controllerLib) && /nodeInputDigest\(/.test(controllerLib),
    "run_store's miss explanation still has no production caller",
  );
  const runStoreCallers = [];
  for (const directory of ["", "lib", "verify"]) {
    const target = path.join(ROOT, "scripts", directory);
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      if (entry.name === "run_store.mjs" || entry.name === "run_stage_recipe_tests.mjs") continue;
      const source = await fs.readFile(path.join(target, entry.name), "utf8");
      if (/\bRunStore\b/.test(source)) runStoreCallers.push(path.join("scripts", directory, entry.name));
    }
  }
  check(
    runStoreCallers.length === 0,
    `the RunStore dead-code verdict is stale; it now has callers: ${runStoreCallers.join(", ")}`,
  );

  // ------------------------------------------------------------------
  // END TO END — the real controller, the real receipts.
  // ------------------------------------------------------------------
  const cleanEvidence = path.join(workspace, "clean-evidence-run.json");
  const questionEvidence = path.join(workspace, "question-evidence-run.json");
  await command("run_evidence_run_tests.mjs", [
    cases,
    "--emit-clean", cleanEvidence,
    "--emit-acquisition-question", questionEvidence,
  ]);

  const cleanRun = path.join(workspace, "clean-run");
  const first = JSON.parse(
    (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", cleanRun, "--stop-after", "decisions", "--json"])).stdout,
  );
  check(first.status === "PAUSED", `end-to-end run did not pause after decisions: ${first.status}`);
  const persisted = {};
  for (const stageId of ["inputs", "evidence_review", "decisions"]) {
    persisted[stageId] = JSON.parse(
      await fs.readFile(path.join(cleanRun, "stages", stageId, "_receipt.json"), "utf8"),
    );
  }
  for (const [stageId, stageReceipt] of Object.entries(persisted)) {
    check(
      stageReceipt.schema_version === STAGE_RECEIPT_SCHEMA_VERSION,
      `${stageId} receipt is not on the current schema`,
    );
    check(stageReceipt.recipe !== null && stageReceipt.recipe !== undefined, `${stageId} receipt declares no recipe`);
    check(
      stageReceipt.recipe?.input_digest === hashValue(stageReceipt.input_hashes),
      `${stageId} recipe does not cover its own input hashes`,
    );
    check(
      stageReceipt.recipe?.code_closure_sha256 === closure.digest,
      `${stageId} recipe does not name the derived executable closure`,
    );
    check(
      stageReceipt.recipe?.stage_id === stageId,
      `${stageId} recipe names the wrong stage`,
    );
    check(
      verifyStageReceipt(stageReceipt, { runId: stageReceipt.run_id, stageId }).ok,
      `${stageId} receipt does not verify`,
    );
  }
  const closureRecord = JSON.parse(
    await fs.readFile(path.join(cleanRun, "stage-runtime-closure.json"), "utf8"),
  );
  check(closureRecord.digest === closure.digest, "the run journal recorded a different closure");
  check(
    closureRecord.member_count === closure.member_count,
    "the run journal recorded a different closure size",
  );

  // Every stage recorded WHY it could not reuse a receipt on the cold run.
  for (const stageId of ["inputs", "evidence_review", "decisions"]) {
    const miss = JSON.parse(
      await fs.readFile(path.join(cleanRun, "stages", stageId, "_miss.json"), "utf8"),
    );
    check(Array.isArray(miss.moved) && miss.moved.length > 0, `${stageId} miss was observed but not explained`);
    check(
      miss.moved.includes("no recorded input digest"),
      `${stageId} cold miss was not explained as an absent receipt`,
    );
    check(miss.recipe_sha256 === persisted[stageId].recipe.recipe_sha256, `${stageId} miss names a different recipe`);
  }

  // A warm identical run reuses every stage — the tightening did not break reuse.
  const second = JSON.parse(
    (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", cleanRun, "--stop-after", "decisions", "--json"])).stdout,
  );
  check(
    ["inputs", "evidence_review", "decisions"].every((stageId) => second.reused_stages.includes(stageId)),
    `a warm identical run did not reuse every stage: ${JSON.stringify(second.reused_stages)}`,
  );

  // A receipt from a DIFFERENT recipe, on disk, is refused by the real
  // controller — and the refusal is explained as a recipe move.
  const decisionsReceiptPath = path.join(cleanRun, "stages", "decisions", "_receipt.json");
  const original = await fs.readFile(decisionsReceiptPath, "utf8");
  const foreignRecipe = createStageRecipe({
    stageId: "decisions",
    codeClosureSha256: "b".repeat(64),
    codeClosureMemberCount: closure.member_count,
    contractVersions,
    inputHashes: persisted.decisions.input_hashes,
  });
  const rebound = (() => {
    const { receipt_hash: _hash, ...body } = persisted.decisions;
    const next = { ...body, recipe: foreignRecipe };
    return { ...next, receipt_hash: hashValue(next) };
  })();
  await fs.writeFile(decisionsReceiptPath, `${JSON.stringify(rebound, null, 2)}\n`);
  const refused = JSON.parse(
    (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", cleanRun, "--stop-after", "decisions", "--json"])).stdout,
  );
  check(
    !refused.reused_stages.includes("decisions"),
    "a stage receipt from a different recipe was reused by the real controller",
  );
  check(
    refused.reused_stages.includes("inputs"),
    "refusing the stage-3 recipe invalidated stages it does not own",
  );
  const refusedMiss = JSON.parse(
    await fs.readFile(path.join(cleanRun, "stages", "decisions", "_miss.json"), "utf8"),
  );
  check(
    refusedMiss.moved.some((reason) => /^recipe: /.test(reason)),
    `the recipe miss was not explained as a recipe move: ${JSON.stringify(refusedMiss.moved)}`,
  );
  check(
    refusedMiss.moved.some((reason) => /^code\.executable_closure: /.test(reason)),
    "the recipe miss did not localise the moved component to the executable closure",
  );
  check(
    refusedMiss.recorded_recipe_sha256 === foreignRecipe.recipe_sha256,
    "the miss record does not name the recipe it found",
  );

  // A legacy /1.0 receipt on disk is refused, and reported as superseded.
  await fs.writeFile(decisionsReceiptPath, original);
  const legacyOnDisk = (() => {
    const { recipe: _dropped, receipt_hash: _hash, ...body } = persisted.decisions;
    const legacy = { ...body, schema_version: "user-stage-receipt/1.0" };
    return { ...legacy, receipt_hash: hashValue(legacy) };
  })();
  await fs.writeFile(decisionsReceiptPath, `${JSON.stringify(legacyOnDisk, null, 2)}\n`);
  const legacyRun = JSON.parse(
    (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", cleanEvidence, "--out", cleanRun, "--stop-after", "decisions", "--json"])).stdout,
  );
  check(
    !legacyRun.reused_stages.includes("decisions"),
    "a user-stage-receipt/1.0 receipt on disk was reused by the real controller",
  );
  const legacyMiss = JSON.parse(
    await fs.readFile(path.join(cleanRun, "stages", "decisions", "_miss.json"), "utf8"),
  );
  check(
    legacyMiss.recorded_schema_version === "user-stage-receipt/1.0",
    "the miss record does not name the superseded schema it found",
  );
  check(
    legacyMiss.refusals.some((reason) => /superseded/.test(reason)),
    "the miss record does not carry the supersession refusal",
  );

  // RED 4 — the blocked, action-required and success stage-3 receipts are all
  // keyed on the SAME components, so a miss can be diffed across them.
  const questionRun = path.join(workspace, "question-run");
  const questionResult = JSON.parse(
    (await command("test-support/authenticated_controller_test_harness.mjs", ["user_flow", questionEvidence, "--out", questionRun, "--stop-after", "decisions", "--json"])).stdout,
  );
  check(questionResult.status === "ACTION_REQUIRED", `question path did not stop: ${questionResult.status}`);
  const actionRequiredKeys = Object.keys(questionResult.receipt.input_hashes).sort();

  const emptyAnswers = path.join(workspace, "empty-answers.json");
  await fs.writeFile(emptyAnswers, `${JSON.stringify({ answers: {} }, null, 2)}\n`);
  const blockedRun = path.join(workspace, "blocked-run");
  const blockedResult = JSON.parse(
    (await command(
      "test-support/authenticated_controller_test_harness.mjs",
      ["user_flow", questionEvidence, "--out", blockedRun, "--answers", emptyAnswers, "--stop-after", "decisions", "--json"],
      { allowFailure: true },
    )).stdout,
  );
  check(
    blockedResult.stage === "decisions" && blockedResult.receipt?.status === "blocked",
    `incomplete answers did not produce a blocked stage-3 receipt: ${JSON.stringify(blockedResult.status)}`,
  );
  const blockedKeys = Object.keys(blockedResult.receipt.input_hashes).sort();
  const successKeys = Object.keys(persisted.decisions.input_hashes).sort();
  check(
    hashValue(blockedKeys) === hashValue(successKeys),
    `RED 4 is unrepaired: blocked stage-3 keys ${JSON.stringify(blockedKeys)} differ from success keys ${JSON.stringify(successKeys)}`,
  );
  check(
    hashValue(actionRequiredKeys) === hashValue(successKeys),
    `action-required stage-3 keys ${JSON.stringify(actionRequiredKeys)} differ from success keys ${JSON.stringify(successKeys)}`,
  );
  check(
    blockedResult.receipt.input_hashes.answers !== persisted.decisions.input_hashes.answers,
    "the answers component does not distinguish an incomplete answer file from no questions",
  );
  check(
    blockedResult.receipt.recipe?.input_digest === hashValue(blockedResult.receipt.input_hashes),
    "the blocked stage-3 receipt's recipe does not cover its inputs",
  );
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  console.log(JSON.stringify({ status: "FAIL", checks, violations: failures.length }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: "PASS", checks, mutations_total, mutations_caught }));
}
