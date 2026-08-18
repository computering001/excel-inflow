import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  createStageReceipt,
  FLOW_CONTROLLER_VERSION,
  stageById,
  verifyStageReceipt,
} from "./flow_runtime.mjs";
import {
  canonicalJson,
  hashDirectory,
  hashFile,
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

export async function readUsableStage({
  runDir,
  runId,
  stageId,
  inputHashes,
  previousReceiptHash,
  outputs,
  controllerVersion = FLOW_CONTROLLER_VERSION,
}) {
  const receipt = await readJsonIfPresent(stageReceiptPath(runDir, stageId));
  if (!receipt) return { reusable: false, reasons: ["receipt is absent"], receipt: null };
  const outputHashes = await hashDeclaredOutputs(outputs);
  const verified = verifyStageReceipt(receipt, {
    runId,
    stageId,
    controllerVersion,
    previousReceiptHash,
    inputHashes,
    outputHashes,
  });
  return {
    reusable: verified.resumable,
    reasons: verified.errors,
    receipt,
    output_hashes: outputHashes,
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
  });
  await writeJsonAtomic(stageReceiptPath(runDir, stageId), receipt);
  return receipt;
}

export async function writeRunResult(runDir, result) {
  return writeJsonAtomic(path.join(runDir, USER_FLOW_RESULT), result);
}
