/**
 * Run store — content-addressed node checkpoints for graph G1.
 *
 * ARCHITECTURE-20260726 §2 makes resumability the mitigation for the unknown
 * deployment host execution timeout: "a node is skipped if its output exists AND its input
 * hash matches the recorded hash." This module is that mechanism.
 *
 * Two decisions worth stating, because they are the difference between a cache
 * that is merely fast and one that is safe to resume from unattended:
 *
 *  1. A node is keyed on the CONTENT of everything it consumes — the case file,
 *     the source of the scripts it executes, its own recipe version, and the
 *     OUTPUT hashes of its upstream nodes. Keying on upstream output rather than
 *     upstream input means a re-run that produces byte-identical output does not
 *     cascade. That is what makes "changing an input invalidates exactly the
 *     downstream nodes" true rather than approximately true.
 *
 *  2. A receipt is written only after the gate has been evaluated, and it
 *     records the gate verdict. A node with a failed gate is never skipped on
 *     resume — only `ok` is resumable. A cache that could replay a failure as a
 *     success would be worse than no cache.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const RECEIPT_FILE = "_receipt.json";

/** Stable JSON: object keys sorted at every depth, so hashes do not depend on
 *  insertion order. Map iteration order is one of the bug classes L4 exists to
 *  catch (§6); a hash that inherited it would hide the very thing it checks. */
export function canonicalise(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalise(value[key]);
  return out;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalise(value), null, 2);
}

export function hashValue(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/** Hash a set of paths into {relative-ish key: sha256}. Missing files hash to
 *  the sentinel `absent`, so a file appearing or disappearing changes the key. */
export async function hashFiles(paths, baseDir = null) {
  const out = {};
  for (const filePath of [...paths].sort()) {
    const key = baseDir ? path.relative(baseDir, filePath) : filePath;
    try {
      out[key] = await hashFile(filePath);
    } catch {
      out[key] = "absent";
    }
  }
  return out;
}

/** Recursive content hash of a directory, excluding the receipt itself. */
export async function hashDirectory(dir, { exclude = [RECEIPT_FILE] } = {}) {
  const rootStat = await fs.lstat(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Directory hash target is not a real directory: ${dir}`);
  }
  const entries = [];
  async function walk(current) {
    const listing = await fs.readdir(current, { withFileTypes: true });
    for (const entry of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (exclude.includes(rel)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await fs.lstat(full);
        entries.push([rel, "file", stat.size, await hashFile(full)]);
      } else {
        throw new Error(`Directory hash refuses non-regular entry: ${full}`);
      }
    }
  }
  await walk(dir);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return { hash: hashValue(entries), files: Object.fromEntries(entries) };
}

/**
 * Resolve the run root. §2 specifies `/workspace/run/<run_id>/<node>/`; §9
 * confirms `/workspace` is RWX in the deployment host tenant. Outside that tenant it does
 * not exist, so fall back rather than refusing to run — but record which root
 * was used, because a run resumed against a different root is not a resume.
 */
export async function resolveRunRoot(explicit) {
  if (explicit) {
    await fs.mkdir(explicit, { recursive: true });
    return path.resolve(explicit);
  }
  const preferred = "/workspace/run";
  try {
    await fs.mkdir(preferred, { recursive: true });
    await fs.access(preferred, (await import("node:fs")).constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), "debt-model-run");
    await fs.mkdir(fallback, { recursive: true });
    return fallback;
  }
}

export class RunStore {
  constructor(runRoot, runId) {
    this.runRoot = runRoot;
    this.runId = runId;
    this.runDir = path.join(runRoot, runId);
  }

  static async open(runRoot, runId) {
    const store = new RunStore(runRoot, runId);
    await fs.mkdir(store.runDir, { recursive: true });
    return store;
  }

  nodeDir(nodeId) {
    return path.join(this.runDir, nodeId);
  }

  receiptPath(nodeId) {
    return path.join(this.nodeDir(nodeId), RECEIPT_FILE);
  }

  async readReceipt(nodeId) {
    try {
      return JSON.parse(await fs.readFile(this.receiptPath(nodeId), "utf8"));
    } catch {
      return null;
    }
  }

  async writeReceipt(nodeId, receipt) {
    const dir = this.nodeDir(nodeId);
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename: a receipt truncated by a mid-write kill would be read
    // on resume as a corrupt JSON and re-run the node, which is safe, but an
    // atomic rename means the far more common case — killed between the work
    // and the receipt — is the only failure mode we actually have to reason
    // about. A partially-written receipt never exists.
    const tmp = path.join(dir, `.${RECEIPT_FILE}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, "wx", 0o600);
      await handle.writeFile(`${canonicalJson(receipt)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tmp, this.receiptPath(nodeId));
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async clearNode(nodeId) {
    await fs.rm(this.nodeDir(nodeId), { recursive: true, force: true });
  }

  async writeJson(nodeId, name, value) {
    const dir = this.nodeDir(nodeId);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    await fs.writeFile(target, `${canonicalJson(value)}\n`, "utf8");
    return target;
  }

  async readJson(nodeId, name) {
    return JSON.parse(await fs.readFile(path.join(this.nodeDir(nodeId), name), "utf8"));
  }

  hasNodeDir(nodeId) {
    return existsSync(this.nodeDir(nodeId));
  }
}

/**
 * The input hash of a node. Every component is named in the digest so that a
 * cache miss can be explained rather than merely observed — `explainMiss` below
 * diffs two of these and says which component moved.
 */
export function nodeInputDigest({ nodeId, recipe, code, files, params, deps }) {
  return {
    node: nodeId,
    recipe,
    code: code ?? {},
    files: files ?? {},
    params: canonicalise(params ?? {}),
    deps: deps ?? {},
  };
}

export function explainMiss(previous, current) {
  if (!previous) return ["no recorded input digest"];
  const reasons = [];
  for (const key of ["recipe"]) {
    if (previous[key] !== current[key]) reasons.push(`${key}: ${previous[key]} -> ${current[key]}`);
  }
  for (const group of ["code", "files", "deps"]) {
    const before = previous[group] ?? {};
    const after = current[group] ?? {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] !== after[key]) {
        reasons.push(`${group}.${key}: ${(before[key] ?? "absent").slice(0, 12)} -> ${(after[key] ?? "absent").slice(0, 12)}`);
      }
    }
  }
  if (hashValue(previous.params ?? {}) !== hashValue(current.params ?? {})) {
    reasons.push("params changed");
  }
  return reasons.length > 0 ? reasons : ["digest changed"];
}
