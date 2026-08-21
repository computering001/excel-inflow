/**
 * Durable JSON artifact publication.
 *
 * Raw aliases are explicitly non-authoritative and, when requested, publish
 * before immutable objects. Immutable objects are compare-or-create and may
 * never replace different bytes. One atomic, durable pointer rename is the
 * final publication event and is the only authority consumers may follow.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  "EISDIR",
  "EPERM",
  "EINVAL",
  "ENOTSUP",
]);

const targetLocks = new Map();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    );
  }
  return value;
}

export function canonicalJsonBytes(value) {
  const encoded = JSON.stringify(canonicalise(value));
  if (typeof encoded !== "string") {
    throw new Error("A durable JSON artifact must be a JSON object, array or scalar value.");
  }
  return Buffer.from(`${encoded}\n`, "utf8");
}

function safeJsonName(value, label) {
  if (
    typeof value !== "string" || value.length === 0 ||
    value !== path.basename(value) || value.includes("/") || value.includes("\\") ||
    !value.endsWith(".json")
  ) {
    throw new Error(`${label} must be one safe JSON basename.`);
  }
  return value;
}

function safePrefix(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("An immutable artifact prefix must contain only safe basename characters.");
  }
  return value;
}

const DEFAULT_OPERATIONS = Object.freeze({
  mkdir: (...args) => fs.mkdir(...args),
  openTemp: (...args) => fs.open(...args),
  writeChunk: (handle, bytes, offset) => handle.write(bytes, offset, bytes.length - offset, null),
  syncFile: (handle) => handle.sync(),
  closeFile: (handle) => handle.close(),
  link: (...args) => fs.link(...args),
  rename: (...args) => fs.rename(...args),
  readFile: (...args) => fs.readFile(...args),
  lstat: (...args) => fs.lstat(...args),
  remove: (...args) => fs.rm(...args),
  openDirectory: (...args) => fs.open(...args),
  syncDirectory: (handle) => handle.sync(),
  closeDirectory: (handle) => handle.close(),
  randomId: () => randomUUID(),
});

function operations(overrides = {}) {
  return { ...DEFAULT_OPERATIONS, ...overrides };
}

async function presence(target, io) {
  try {
    const metadata = await io.lstat(target);
    return metadata;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRegularBytes(target, expected, io) {
  const metadata = await presence(target, io);
  if (metadata === null) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    const error = new Error(`Durable artifact target is not one regular non-symlink file: ${target}.`);
    error.code = "DURABLE_ARTIFACT_TARGET_UNSAFE";
    throw error;
  }
  const observed = await io.readFile(target);
  if (!Buffer.from(observed).equals(expected)) {
    const error = new Error(`Immutable durable artifact collision at ${target}.`);
    error.code = "DURABLE_ARTIFACT_IMMUTABLE_COLLISION";
    throw error;
  }
  return true;
}

async function withTargetLock(target, work) {
  const prior = targetLocks.get(target) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = prior.then(() => current);
  targetLocks.set(target, queued);
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (targetLocks.get(target) === queued) targetLocks.delete(target);
  }
}

async function syncDirectoryIfSupported(directory, io) {
  let handle = null;
  try {
    handle = await io.openDirectory(directory, "r");
    await io.syncDirectory(handle);
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error?.code)) throw error;
  } finally {
    if (handle) await io.closeDirectory(handle);
  }
}

async function stageSyncedTemp(target, bytes, io) {
  const temporary = `${target}.tmp-${process.pid}-${io.randomId()}`;
  let handle = null;
  let primaryError = null;
  try {
    handle = await io.openTemp(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = await io.writeChunk(handle, bytes, offset);
      const count = Number(written?.bytesWritten);
      if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) {
        const error = new Error(`Durable artifact short write at byte ${offset} of ${bytes.length}.`);
        error.code = "DURABLE_ARTIFACT_SHORT_WRITE";
        throw error;
      }
      offset += count;
    }
    await io.syncFile(handle);
    await io.closeFile(handle);
    handle = null;
    return temporary;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) await io.closeFile(handle).catch(() => {});
    if (primaryError) {
      await io.remove(temporary, { force: true }).catch(() => {});
      if (await presence(temporary, io).catch(() => true)) {
        const residue = new Error(`Durable artifact staging residue remained at ${temporary}.`);
        residue.code = "DURABLE_ARTIFACT_TEMP_RESIDUE";
        residue.cause = primaryError;
        throw residue;
      }
    }
  }
}

async function removeTempOrRefuse(temporary, io) {
  await io.remove(temporary, { force: true }).catch(() => {});
  if (await presence(temporary, io).catch(() => true)) {
    const error = new Error(`Durable artifact staging residue remained at ${temporary}.`);
    error.code = "DURABLE_ARTIFACT_TEMP_RESIDUE";
    throw error;
  }
}

export async function publishDurableImmutableJson({ target, value, operations: overrides = {} }) {
  const absolute = path.resolve(String(target));
  safeJsonName(path.basename(absolute), "immutable artifact target");
  const bytes = canonicalJsonBytes(value);
  const io = operations(overrides);
  await io.mkdir(path.dirname(absolute), { recursive: true });
  return withTargetLock(absolute, async () => {
    if (await assertRegularBytes(absolute, bytes, io)) {
      return Object.freeze({ target: absolute, bytes: bytes.length, sha256: sha256(bytes), created: false });
    }
    const temporary = await stageSyncedTemp(absolute, bytes, io);
    try {
      // A hard-link from the fully synced same-directory temp file is the
      // stdlib atomic no-replace operation. Unlike POSIX rename it cannot
      // clobber a target created by another process between check and commit.
      let created = false;
      try {
        await io.link(temporary, absolute);
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await assertRegularBytes(absolute, bytes, io);
      }
      await syncDirectoryIfSupported(path.dirname(absolute), io);
      if (!(await assertRegularBytes(absolute, bytes, io))) {
        throw new Error(`Durable immutable artifact disappeared after publication: ${absolute}.`);
      }
      return Object.freeze({ target: absolute, bytes: bytes.length, sha256: sha256(bytes), created });
    } finally {
      await removeTempOrRefuse(temporary, io);
    }
  });
}

export async function publishDurableReplaceableJson({ target, value, operations: overrides = {} }) {
  const absolute = path.resolve(String(target));
  safeJsonName(path.basename(absolute), "replaceable artifact target");
  const bytes = canonicalJsonBytes(value);
  const io = operations(overrides);
  await io.mkdir(path.dirname(absolute), { recursive: true });
  return withTargetLock(absolute, async () => {
    const temporary = await stageSyncedTemp(absolute, bytes, io);
    try {
      await io.rename(temporary, absolute);
      await syncDirectoryIfSupported(path.dirname(absolute), io);
      if (!(await assertRegularBytes(absolute, bytes, io))) {
        throw new Error(`Durable replaceable artifact disappeared after publication: ${absolute}.`);
      }
      return Object.freeze({ target: absolute, bytes: bytes.length, sha256: sha256(bytes), created: true });
    } finally {
      await removeTempOrRefuse(temporary, io);
    }
  });
}

/**
 * Publish one JSON generation. `rawAliases` are optional compatibility views,
 * never authority. `pointerFactory` receives immutable filenames/hashes and
 * the pointer is the final write. Omitting rawAliases removes alias ambiguity.
 */
export async function publishDurableJsonGeneration({
  directory,
  rawAliases = [],
  immutableArtifacts,
  pointerName,
  pointerFactory,
  operations: overrides = {},
  beforePointer = null,
  afterStage = null,
} = {}) {
  const root = path.resolve(String(directory));
  const safePointerName = safeJsonName(pointerName, "pointer name");
  if (!Array.isArray(rawAliases) || !Array.isArray(immutableArtifacts) || immutableArtifacts.length === 0) {
    throw new Error("A durable generation requires arrays and at least one immutable artifact.");
  }
  if (typeof pointerFactory !== "function") {
    throw new Error("A durable generation requires a pointerFactory.");
  }
  if (afterStage !== null && typeof afterStage !== "function") {
    throw new Error("afterStage must be a function when supplied.");
  }
  const io = operations(overrides);
  await io.mkdir(root, { recursive: true });

  const aliases = [];
  for (const alias of rawAliases) {
    const name = safeJsonName(alias?.name, "raw alias name");
    if (name === safePointerName) throw new Error("A raw alias may not own the pointer name.");
    const publishedAlias = await publishDurableReplaceableJson({
      target: path.join(root, name),
      value: alias.value,
      operations: io,
    });
    aliases.push(publishedAlias);
    if (afterStage) await afterStage(Object.freeze({
      stage: "alias_published",
      key: null,
      name,
      target: publishedAlias.target,
    }));
  }

  const immutable = {};
  for (const artifact of immutableArtifacts) {
    const key = String(artifact?.key ?? "");
    if (!/^[a-z][a-z0-9_]*$/.test(key) || Object.hasOwn(immutable, key)) {
      throw new Error(`Invalid or duplicate immutable artifact key: ${JSON.stringify(key)}.`);
    }
    const prefix = safePrefix(artifact.prefix);
    const bytes = canonicalJsonBytes(artifact.value);
    const digest = sha256(bytes);
    const file = `${prefix}${digest}.json`;
    const published = await publishDurableImmutableJson({
      target: path.join(root, file),
      value: artifact.value,
      operations: io,
    });
    immutable[key] = Object.freeze({ file, sha256: digest, bytes: bytes.length, created: published.created });
    if (afterStage) await afterStage(Object.freeze({
      stage: "immutable_published",
      key,
      name: file,
      target: published.target,
    }));
  }

  const pointerValue = await pointerFactory(Object.freeze({ ...immutable }));
  if (beforePointer) await beforePointer({ root, aliases: Object.freeze(aliases), immutable: Object.freeze({ ...immutable }), pointer: pointerValue });
  const pointer = await publishDurableReplaceableJson({
    target: path.join(root, safePointerName),
    value: pointerValue,
    operations: io,
  });
  if (afterStage) await afterStage(Object.freeze({
    stage: "pointer_published",
    key: null,
    name: safePointerName,
    target: pointer.target,
  }));
  return Object.freeze({
    aliases: Object.freeze(aliases),
    immutable: Object.freeze({ ...immutable }),
    pointer: Object.freeze({ ...pointer, value: pointerValue }),
  });
}

export const DURABLE_DIRECTORY_SYNC_UNSUPPORTED = Object.freeze(
  [...UNSUPPORTED_DIRECTORY_SYNC_ERRORS],
);

export default {
  canonicalJsonBytes,
  publishDurableImmutableJson,
  publishDurableReplaceableJson,
  publishDurableJsonGeneration,
};
