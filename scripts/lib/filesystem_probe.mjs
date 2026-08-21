/**
 * Physical filesystem capability probe shared by the runtime doctor lanes.
 *
 * A permission bit is not evidence that a host can complete the write pattern
 * used by a run.  This probe exercises a self-cleaning sibling directory on
 * the actual target volume.  It never creates the proposed run directory.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PROBE_PREFIX = ".excel-inflow-filesystem-probe-";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function pathPresence(target, io) {
  try {
    await io.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function nearestExistingDirectory(requested, io) {
  let current = requested;
  const missing = [];
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      const stat = await io.stat(current);
      if (!stat.isDirectory()) {
        throw new Error(`nearest existing path is not a directory: ${current}`);
      }
      const canonical = await io.realpath(current);
      const orderedMissing = [...missing].reverse();
      return {
        requested,
        existing_path: current,
        canonical_existing_path: canonical,
        missing_segments: orderedMissing,
        canonical_requested_path: path.resolve(canonical, ...orderedMissing),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  throw new Error("nearest existing directory search exceeded 256 levels");
}

async function defaultWriteSynced(target, payload) {
  const handle = await fs.open(target, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    closed = true;
  } finally {
    if (!closed) await handle.close().catch(() => {});
  }
}

const DEFAULT_IO = Object.freeze({
  stat: (...args) => fs.stat(...args),
  statfs: (...args) => fs.statfs(...args),
  realpath: (...args) => fs.realpath(...args),
  lstat: (...args) => fs.lstat(...args),
  mkdtemp: (...args) => fs.mkdtemp(...args),
  writeSynced: defaultWriteSynced,
  readFile: (...args) => fs.readFile(...args),
  rename: (...args) => fs.rename(...args),
  unlink: (...args) => fs.unlink(...args),
  rmdir: (...args) => fs.rmdir(...args),
});

function errorText(error) {
  return String(error?.code ?? error?.message ?? error);
}

/**
 * Exercise the real target filesystem and return a typed, serialisable fact
 * set. `operations` exists for non-vacuous fault-injection tests; production
 * callers always use the default real filesystem implementation.
 */
export async function probePhysicalFilesystem({
  requestedRoot,
  skillRoot,
  purpose,
  operations = {},
  randomBytesFn = randomBytes,
} = {}) {
  if (!new Set(["run_root", "temp_root"]).has(purpose)) {
    throw new Error(`Unsupported filesystem probe purpose: ${JSON.stringify(purpose)}.`);
  }
  const io = { ...DEFAULT_IO, ...operations };
  const requested = path.resolve(String(requestedRoot));
  const immutableSkillRoot = await io.realpath(path.resolve(String(skillRoot)));
  const facts = {
    purpose: String(purpose),
    requested_root: requested,
    requested_run_root: purpose === "run_root" ? requested : null,
    requested_temp_root: purpose === "temp_root" ? requested : null,
    temp_root: purpose === "temp_root" ? requested : null,
    canonical_requested_root: null,
    nearest_existing_ancestor: null,
    canonical_probe_parent: null,
    probe_parent: null,
    immutable_skill_root: immutableSkillRoot,
    outside_immutable_skill_root: false,
    requested_root_existed_before: false,
    requested_root_existed_after: null,
    real_run_directory_created: false,
    volume_identity: null,
    created: false,
    written: false,
    flushed: false,
    closed: false,
    read_back: false,
    bytes_match: false,
    renamed: false,
    statted: false,
    deleted: false,
    cleanup_verified: false,
    probe_payload_bytes: 0,
    probe_payload_sha256: null,
    error: null,
  };
  let probeDirectory = null;
  let probeFile = null;
  let renamedFile = null;
  try {
    facts.requested_root_existed_before = await pathPresence(requested, io);
    if (purpose === "temp_root" && !facts.requested_root_existed_before) {
      throw new Error("the effective temp root does not exist; the doctor will not create it");
    }
    const resolved = await nearestExistingDirectory(requested, io);
    facts.canonical_requested_root = resolved.canonical_requested_path;
    facts.nearest_existing_ancestor = resolved.existing_path;
    facts.canonical_probe_parent = resolved.canonical_existing_path;
    facts.probe_parent = resolved.canonical_existing_path;
    facts.outside_immutable_skill_root = !within(
      immutableSkillRoot,
      resolved.canonical_requested_path,
    );
    if (!facts.outside_immutable_skill_root) {
      throw new Error("canonical requested root resolves inside the immutable skill root");
    }

    const [parentStat, filesystemStat] = await Promise.all([
      io.stat(resolved.canonical_existing_path),
      io.statfs(resolved.canonical_existing_path),
    ]);
    facts.volume_identity = {
      device_id: String(parentStat.dev),
      filesystem_type: String(filesystemStat.type),
      block_size_bytes: Number(filesystemStat.bsize),
    };

    probeDirectory = await io.mkdtemp(
      path.join(resolved.canonical_existing_path, PROBE_PREFIX),
    );
    facts.created = true;
    probeFile = path.join(probeDirectory, "probe.bin");
    renamedFile = path.join(probeDirectory, "probe-renamed.bin");
    const payload = Buffer.from(randomBytesFn(64));
    facts.probe_payload_bytes = payload.length;
    facts.probe_payload_sha256 = sha256(payload);

    await io.writeSynced(probeFile, payload);
    facts.written = true;
    facts.flushed = true;
    facts.closed = true;
    const observed = await io.readFile(probeFile);
    facts.read_back = true;
    facts.bytes_match = Buffer.compare(payload, observed) === 0;
    if (!facts.bytes_match) throw new Error("probe bytes did not read back byte-identical");

    await io.rename(probeFile, renamedFile);
    facts.renamed = true;
    probeFile = null;
    const renamedStat = await io.stat(renamedFile);
    facts.statted = renamedStat.isFile() && renamedStat.size === payload.length;
    if (!facts.statted) throw new Error("renamed probe was not a regular file of the expected size");

    await io.unlink(renamedFile);
    renamedFile = null;
    facts.deleted = true;
    await io.rmdir(probeDirectory);
    const removedDirectory = probeDirectory;
    probeDirectory = null;
    facts.cleanup_verified = !(await pathPresence(removedDirectory, io));
    if (!facts.cleanup_verified) throw new Error("probe directory residue remained after cleanup");
  } catch (error) {
    facts.error = errorText(error);
  } finally {
    // Cleanup is best-effort with the real implementation even when an
    // injected operation failed. A failed required operation still leaves the
    // result failed; the fallback exists only to keep the test/host clean.
    if (probeDirectory !== null) {
      await fs.rm(probeDirectory, { recursive: true, force: true }).catch(() => {});
      const residue = await fs.lstat(probeDirectory).then(() => true).catch((error) => {
        if (error?.code === "ENOENT") return false;
        return true;
      });
      if (residue) facts.cleanup_verified = false;
    }
    facts.requested_root_existed_after = await pathPresence(requested, io).catch(() => null);
    facts.real_run_directory_created =
      !facts.requested_root_existed_before && facts.requested_root_existed_after === true;
  }

  const required = [
    "outside_immutable_skill_root",
    "created",
    "written",
    "flushed",
    "closed",
    "read_back",
    "bytes_match",
    "renamed",
    "statted",
    "deleted",
    "cleanup_verified",
  ];
  const ok = facts.error === null && required.every((field) => facts[field] === true) &&
    facts.real_run_directory_created === false;
  return Object.freeze({ ok, facts: Object.freeze(facts) });
}

export default { probePhysicalFilesystem };
