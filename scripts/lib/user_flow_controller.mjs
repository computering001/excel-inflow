import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  createStageReceipt,
  createStageRecipe,
  FLOW_CONTROLLER_VERSION,
  stageById,
  verifyStageReceipt,
} from "./flow_runtime.mjs";
import {
  canonicalJson,
  explainMiss,
  hashDirectory,
  hashFile,
  hashValue,
  nodeInputDigest,
} from "./run_store.mjs";

export const USER_FLOW_RESULT = "user-flow-result.json";

async function atomicWrite(target, text) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeJsonAtomic(target, value) {
  await atomicWrite(target, `${canonicalJson(value)}\n`);
  return target;
}

export async function writeTextAtomic(target, value) {
  await atomicWrite(target, String(value));
  return target;
}

export async function readJsonIfPresent(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

export function stageDirectory(runDir, stageId) {
  if (!stageById(stageId)) throw new Error(`Unknown user-flow stage: ${stageId}`);
  return path.join(runDir, "stages", stageId);
}

export function stageReceiptPath(runDir, stageId) {
  return path.join(stageDirectory(runDir, stageId), "_receipt.json");
}

/**
 * Hash declared stage outputs. A directory is represented by one recursive
 * digest; a file by its exact bytes. Missing outputs use the `absent` sentinel
 * so an incomplete or externally removed stage can never be reused.
 */
export async function hashDeclaredOutputs(outputs) {
  const hashes = {};
  for (const [name, descriptor] of Object.entries(outputs ?? {}).sort()) {
    const target = typeof descriptor === "string" ? descriptor : descriptor.path;
    const kind = typeof descriptor === "string" ? "file" : descriptor.kind ?? "file";
    try {
      hashes[name] =
        kind === "directory"
          ? (await hashDirectory(target)).hash
          : await hashFile(target);
    } catch {
      hashes[name] = "absent";
    }
  }
  return hashes;
}

export const STAGE_RUNTIME_CLOSURE_SCHEMA = "user-stage-runtime-closure/1.0";

/**
 * The entrypoints the user flow executes from. The five stages are five phases
 * of ONE process, so there is exactly one JavaScript entry; stage 4 additionally
 * spawns the release orchestrator, which is a process edge rather than an import
 * edge and is therefore named.
 */
export const STAGE_CLOSURE_ENTRYPOINTS = Object.freeze([
  "scripts/run_user_flow.mjs",
  "scripts/orchestrate_release.mjs",
]);

const JS_CLOSURE_MEMBER = /\.(?:mjs|cjs|js)$/;

/**
 * A path-shaped token naming executable bytes: `./lib/flow.mjs`,
 * `orchestrate_release.mjs`, `__main__.py`. ONE regex covers both edge kinds
 * the closure has — the literal import specifier and the process spawn
 * (`command(python.path, [path.join(HERE, "emit", "__main__.py"), ...])`) —
 * because both spell the file out. Tokens are resolved by BASENAME against the
 * declared inventory, and an ambiguous basename admits EVERY candidate, so the
 * scan is deliberately an over-approximation of the real edge set: it can only
 * widen the closure, never narrow it. Tokens inside comments count too, for the
 * same reason.
 */
const CODE_REFERENCE_TOKEN = /[A-Za-z0-9_.$-]+(?:\/[A-Za-z0-9_.$-]+)*\.(?:mjs|cjs|js|py)\b/g;

/**
 * Derive the stage runtime closure from the real edge graph.
 *
 * Membership is DERIVED, not declared. The list that used to live in
 * run_user_flow.mjs was hand-maintained and not closed: its `inputs` entry named
 * 13 modules whose own transitive closure is 99, so an edit to a module the
 * stage genuinely executes left the stage receipt reusable.
 *
 *   1. start at the declared entrypoints;
 *   2. follow every path-shaped executable token, transitively, resolved by
 *      basename against the declared runtime inventory;
 *   3. add EVERY vendored dependency member — a bare specifier such as `jszip`
 *      spells no path, so vendored bytes are never narrowed;
 *   4. add EVERY non-JavaScript declared member — assets, schemas and Python
 *      modules are opened through composed paths no static scan can enumerate,
 *      so they are never narrowed either.
 *
 * Excluded, and ONLY excluded: instruction files, which
 * scripts/lib/source_identity.mjs already declares can never be closure members
 * (they are absent from `runtime_code_closure` by construction), and JavaScript
 * unreachable from the entrypoints.
 *
 * The completeness proof — that this token scan admits every edge the
 * grammar-bounded ES scanner finds, that no member has a non-literal dynamic
 * import, and that no relative specifier leaves the declared runtime — is
 * discharged by scripts/run_stage_recipe_tests.mjs against
 * scripts/lib/release_js_import_scanner.mjs. That scanner is deliberately NOT
 * imported here: it is not a declared runtime member, and the release compiler
 * reconciles `script_allowlist` against the import closure in both directions,
 * so a shipped module may only import shipped modules.
 */
export async function deriveStageRuntimeClosure({
  skillRoot,
  integrity,
  entrypoints = STAGE_CLOSURE_ENTRYPOINTS,
}) {
  const inventory = integrity?.runtime_code_closure?.files;
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error(
      "Stage runtime closure derivation requires a declared runtime-code closure inventory",
    );
  }
  const declared = Object.keys(inventory);
  if (declared.length === 0) {
    throw new Error("Stage runtime closure derivation was handed an empty inventory");
  }
  const byBasename = new Map();
  for (const key of declared) {
    const basename = key.slice(key.lastIndexOf("/") + 1);
    if (!byBasename.has(basename)) byBasename.set(basename, []);
    byBasename.get(basename).push(key);
  }
  const code = new Set();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const key = queue.pop();
    if (code.has(key)) continue;
    if (!Object.hasOwn(inventory, key)) {
      if (entrypoints.includes(key)) {
        throw new Error(
          `Stage runtime closure entrypoint is not a declared runtime member: ${key}`,
        );
      }
      continue;
    }
    code.add(key);
    if (!JS_CLOSURE_MEMBER.test(key)) continue;
    const source = await fs.readFile(path.join(skillRoot, ...key.split("/")), "utf8");
    for (const match of source.matchAll(CODE_REFERENCE_TOKEN)) {
      const token = match[0];
      const basename = token.slice(token.lastIndexOf("/") + 1);
      for (const candidate of byBasename.get(basename) ?? []) queue.push(candidate);
    }
  }
  const members = [...new Set([
    ...code,
    ...declared.filter(
      (key) => !JS_CLOSURE_MEMBER.test(key) || key.startsWith("node_modules/"),
    ),
  ])].sort();
  const selected = {};
  for (const member of members) selected[member] = inventory[member];
  return Object.freeze({
    schema_version: STAGE_RUNTIME_CLOSURE_SCHEMA,
    entrypoints: Object.freeze([...entrypoints]),
    digest: hashValue(selected),
    member_count: members.length,
    members: Object.freeze(members),
    executable_members: Object.freeze([...code].sort()),
    declared_member_count: declared.length,
    excluded: Object.freeze(
      Object.keys(integrity.files ?? inventory)
        .filter((key) => !Object.hasOwn(selected, key))
        .sort(),
    ),
  });
}

// ---------------------------------------------------------------------------
// The active recipe binding. Every stage receipt this controller writes or
// reuses is minted through it, so no call site can persist a receipt without
// naming the recipe that produced it: an unbound controller throws.
// ---------------------------------------------------------------------------
let ACTIVE_STAGE_RECIPE_BINDING = null;

export function bindStageRecipes({ closure, contractVersions }) {
  if (closure?.schema_version !== STAGE_RUNTIME_CLOSURE_SCHEMA) {
    throw new Error("Stage recipes must be bound to a derived stage runtime closure");
  }
  ACTIVE_STAGE_RECIPE_BINDING = Object.freeze({
    closure,
    contract_versions: Object.freeze({ ...contractVersions }),
  });
  return ACTIVE_STAGE_RECIPE_BINDING;
}

export function activeStageRecipeBinding() {
  return ACTIVE_STAGE_RECIPE_BINDING;
}

export function releaseStageRecipes() {
  ACTIVE_STAGE_RECIPE_BINDING = null;
}

export function stageRecipeFor({ stageId, inputHashes, controllerVersion }) {
  const binding = ACTIVE_STAGE_RECIPE_BINDING;
  if (!binding) {
    throw new Error(
      `No stage recipe is bound: ${stageId} may not write or reuse a receipt without declaring the recipe that produced it`,
    );
  }
  return createStageRecipe({
    stageId,
    codeClosureSha256: binding.closure.digest,
    codeClosureMemberCount: binding.closure.member_count,
    contractVersions: binding.contract_versions,
    inputHashes,
    controllerVersion,
  });
}

/**
 * The named components of a stage's cache key, in the shape run_store.mjs's
 * explainMiss diffs. Naming every component is what turns "the stage did not
 * reuse" into "the executable closure moved" or "answers moved" or "the
 * workbook is gone".
 */
function stageCacheDigest({
  stageId,
  recipeSha256,
  closureSha256,
  policyVersions,
  inputHashes,
  outputHashes,
  previousReceiptHash,
}) {
  return nodeInputDigest({
    nodeId: `user-stage/${stageId}`,
    recipe: recipeSha256 ?? "absent",
    code: { executable_closure: closureSha256 ?? "absent" },
    files: inputHashes ?? {},
    params: policyVersions ?? {},
    deps: {
      previous_receipt: previousReceiptHash ?? "none",
      ...Object.fromEntries(
        Object.entries(outputHashes ?? {}).map(([name, hash]) => [
          `output:${name}`,
          hash,
        ]),
      ),
    },
  });
}

export function stageMissPath(runDir, stageId) {
  return path.join(stageDirectory(runDir, stageId), "_miss.json");
}

export async function readUsableStage({
  runDir,
  runId,
  stageId,
  inputHashes,
  previousReceiptHash,
  outputs,
  controllerVersion = FLOW_CONTROLLER_VERSION,
}) {
  const recipe = stageRecipeFor({ stageId, inputHashes, controllerVersion });
  const receipt = await readJsonIfPresent(stageReceiptPath(runDir, stageId));
  const outputHashes = await hashDeclaredOutputs(outputs);
  const current = stageCacheDigest({
    stageId,
    recipeSha256: recipe.recipe_sha256,
    closureSha256: recipe.code_closure_sha256,
    policyVersions: recipe.policy_versions,
    inputHashes,
    outputHashes,
    previousReceiptHash,
  });
  const verified = receipt
    ? verifyStageReceipt(receipt, {
        runId,
        stageId,
        controllerVersion,
        previousReceiptHash,
        inputHashes,
        outputHashes,
        recipe,
      })
    : { resumable: false, errors: ["receipt is absent"] };
  const reusable = verified.resumable === true;
  // A miss is RECORDED, with the component that moved named. This is the caller
  // run_store.mjs's explainMiss was written for and never had.
  const explanation = reusable
    ? []
    : explainMiss(
        receipt
          ? stageCacheDigest({
              stageId,
              recipeSha256: receipt.recipe?.recipe_sha256,
              closureSha256: receipt.recipe?.code_closure_sha256,
              policyVersions: receipt.recipe?.policy_versions,
              inputHashes: receipt.input_hashes,
              outputHashes: receipt.output_hashes,
              previousReceiptHash: receipt.previous_receipt_hash,
            })
          : null,
        current,
      );
  if (!reusable) {
    await writeJsonAtomic(stageMissPath(runDir, stageId), {
      schema_version: "user-stage-cache-miss/1.0",
      stage_id: stageId,
      run_id: runId,
      recipe_sha256: recipe.recipe_sha256,
      recorded_recipe_sha256: receipt?.recipe?.recipe_sha256 ?? null,
      recorded_schema_version: receipt?.schema_version ?? null,
      moved: explanation,
      refusals: verified.errors ?? [],
      current_digest: current,
    });
  }
  return {
    reusable,
    reasons: verified.errors ?? [],
    receipt: receipt ?? null,
    output_hashes: outputHashes,
    recipe,
    moved: explanation,
  };
}

export async function persistStage({
  runDir,
  runId,
  stageId,
  status,
  inputHashes,
  previousReceiptHash,
  outputs,
  controllerVersion = FLOW_CONTROLLER_VERSION,
  detail = null,
}) {
  const outputHashes = await hashDeclaredOutputs(outputs);
  if (status === "success" && Object.values(outputHashes).includes("absent")) {
    throw new Error(`Cannot persist successful ${stageId}: a declared output is absent`);
  }
  const receipt = createStageReceipt({
    runId,
    stageId,
    status,
    inputHashes,
    outputHashes,
    previousReceiptHash,
    controllerVersion,
    detail,
    recipe: stageRecipeFor({ stageId, inputHashes, controllerVersion }),
  });
  await writeJsonAtomic(stageReceiptPath(runDir, stageId), receipt);
  return receipt;
}

export async function writeRunResult(runDir, result) {
  return writeJsonAtomic(path.join(runDir, USER_FLOW_RESULT), result);
}
