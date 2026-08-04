/**
 * Portable, content-addressed checkpoints for user-flow Stage 4.
 *
 * Receipts are deliberately separate from work directories. A process killed
 * while writing an output can therefore leave only an incomplete work tree;
 * without a verified success receipt that tree is cleared and rebuilt. A
 * success receipt is reusable only when its recipe, named input hashes and
 * exact output hashes still agree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  hashDirectory,
  hashFile,
  hashValue,
} from "./run_store.mjs";

export const RELEASE_CHECKPOINT_SCHEMA = "stage4-checkpoint/1.0";
export const RELEASE_CHECKPOINT_CONTROLLER = "portable-stage4/1.0";

async function atomicWriteJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readJsonIfPresent(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

function receiptBody(receipt) {
  const { receipt_hash: _ignored, ...body } = receipt;
  return body;
}

export async function hashCheckpointOutputs(outputs) {
  const hashes = {};
  for (const [name, descriptor] of Object.entries(outputs ?? {}).sort()) {
    const target = typeof descriptor === "string" ? descriptor : descriptor.path;
    const kind = typeof descriptor === "string" ? "file" : descriptor.kind ?? "file";
    try {
      hashes[name] = kind === "directory"
        ? (await hashDirectory(target)).hash
        : await hashFile(target);
    } catch {
      hashes[name] = "absent";
    }
  }
  return hashes;
}

export class ReleaseCheckpointStore {
  constructor(runDir) {
    this.runDir = path.resolve(runDir);
    this.root = path.join(this.runDir, ".stage4");
    this.workRoot = path.join(this.root, "work");
    this.receiptRoot = path.join(this.root, "receipts");
  }

  static async open(runDir) {
    const store = new ReleaseCheckpointStore(runDir);
    await fs.mkdir(store.workRoot, { recursive: true });
    await fs.mkdir(store.receiptRoot, { recursive: true });
    return store;
  }

  workDir(checkpointId) {
    return path.join(this.workRoot, checkpointId);
  }

  receiptPath(checkpointId) {
    return path.join(this.receiptRoot, `${checkpointId}.json`);
  }

  async reset(checkpointId) {
    await fs.rm(this.workDir(checkpointId), { recursive: true, force: true });
    await fs.rm(this.receiptPath(checkpointId), { force: true });
    await fs.mkdir(this.workDir(checkpointId), { recursive: true });
  }

  async inspect({ checkpointId, recipe, inputHashes, outputs }) {
    const receipt = await readJsonIfPresent(this.receiptPath(checkpointId));
    if (!receipt) return { reusable: false, reasons: ["receipt is absent"], receipt: null };

    const outputHashes = await hashCheckpointOutputs(outputs);
    const reasons = [];
    if (receipt.schema_version !== RELEASE_CHECKPOINT_SCHEMA) reasons.push("schema version changed");
    if (receipt.controller_version !== RELEASE_CHECKPOINT_CONTROLLER) reasons.push("controller version changed");
    if (receipt.checkpoint_id !== checkpointId) reasons.push("checkpoint id changed");
    if (receipt.recipe !== recipe) reasons.push("recipe changed");
    if (receipt.status !== "success") reasons.push(`receipt status is ${receipt.status ?? "missing"}`);
    if (hashValue(receipt.input_hashes ?? {}) !== hashValue(inputHashes ?? {})) reasons.push("input hashes changed");
    if (hashValue(receipt.output_hashes ?? {}) !== hashValue(outputHashes)) reasons.push("output hashes changed");
    if (receipt.receipt_hash !== hashValue(receiptBody(receipt))) reasons.push("receipt hash is invalid");
    if (Object.values(outputHashes).includes("absent")) reasons.push("a declared output is absent");

    return {
      reusable: reasons.length === 0,
      reasons,
      receipt,
      output_hashes: outputHashes,
    };
  }

  async persist({ checkpointId, recipe, status, inputHashes, outputs, detail = null }) {
    const outputHashes = await hashCheckpointOutputs(outputs);
    if (status === "success" && Object.values(outputHashes).includes("absent")) {
      throw new Error(`Cannot persist successful checkpoint ${checkpointId}: a declared output is absent`);
    }
    const body = {
      schema_version: RELEASE_CHECKPOINT_SCHEMA,
      controller_version: RELEASE_CHECKPOINT_CONTROLLER,
      checkpoint_id: checkpointId,
      recipe,
      status,
      input_hashes: inputHashes ?? {},
      output_hashes: outputHashes,
      detail,
    };
    const receipt = { ...body, receipt_hash: hashValue(body) };
    await atomicWriteJson(this.receiptPath(checkpointId), receipt);
    return receipt;
  }
}
