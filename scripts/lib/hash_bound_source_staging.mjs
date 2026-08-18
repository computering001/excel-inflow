import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Copy a frozen external test source into a controller-owned run directory.
 * The source is opened without following its final path component and its
 * declared digest is checked before any destination is created. Production
 * ingress can then retain its narrow, run-root-only custody boundary.
 */
export async function stageHashBoundTestSource({
  sourcePath,
  destinationPath,
  expectedSha256,
  label = "External test source",
}) {
  const expected = String(expectedSha256 ?? "").toLowerCase();
  if (!SHA256.test(expected)) {
    throw new Error(`${label} requires an exact expected SHA-256.`);
  }
  const lexicalSource = path.resolve(String(sourcePath));
  const sourceLinkStats = await fs.lstat(lexicalSource);
  if (sourceLinkStats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link.`);
  }
  const canonicalSource = await fs.realpath(lexicalSource);
  const sourceHandle = await fs.open(
    canonicalSource,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let bytes;
  try {
    const sourceStats = await sourceHandle.stat();
    if (!sourceStats.isFile()) throw new Error(`${label} must be a regular file.`);
    bytes = await sourceHandle.readFile();
  } finally {
    await sourceHandle.close();
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 does not match its frozen declaration.`);
  }

  const destination = path.resolve(String(destinationPath));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const destinationHandle = await fs.open(
    destination,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await destinationHandle.writeFile(bytes);
  } catch (error) {
    await destinationHandle.close();
    await fs.rm(destination, { force: true });
    throw error;
  }
  await destinationHandle.close();
  const stagedPath = await fs.realpath(destination);
  const stagedBytes = await fs.readFile(stagedPath);
  if (sha256(stagedBytes) !== expected) {
    await fs.rm(destination, { force: true });
    throw new Error(`${label} changed while entering the controller-owned run root.`);
  }
  return {
    path: stagedPath,
    sha256: expected,
    byte_length: stagedBytes.length,
  };
}

export default { stageHashBoundTestSource };
