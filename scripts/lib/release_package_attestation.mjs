import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  canonicaliseIdentity,
  identitySha256,
  productIdentity,
} from "./identity_vocabulary.mjs";

export const COMPLETE_PACKAGE_INVENTORY_SCHEMA =
  "complete-package-inventory/1.0";
export const RELEASE_PACKAGE_ATTESTATION_SCHEMA =
  "release-package-attestation/1.0";

const SHA256 = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertExternalArtifactPath(packageRoot, target, label) {
  const root = path.resolve(packageRoot);
  const resolved = path.resolve(target);
  if (isInside(resolved, root)) {
    throw new Error(`${label} must be outside the immutable package directory.`);
  }
  return resolved;
}

async function walkPackageFiles(root, directory = root) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Immutable package contains a symbolic link: ${target}`);
    }
    if (entry.isDirectory()) files.push(...(await walkPackageFiles(root, target)));
    else if (entry.isFile()) files.push(target);
    else throw new Error(`Immutable package contains a non-regular member: ${target}`);
  }
  return files;
}

export async function completePackageInventoryIdentity(packageRoot) {
  const root = path.resolve(packageRoot);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("Package root is not a directory.");
  const files = {};
  for (const target of await walkPackageFiles(root)) {
    const relative = path.relative(root, target).split(path.sep).join("/");
    files[relative] = sha256(await fs.readFile(target));
  }
  const ordered = canonicaliseIdentity(files);
  return Object.freeze({
    schema_version: COMPLETE_PACKAGE_INVENTORY_SCHEMA,
    identity_kind: "complete_package_inventory",
    file_count: Object.keys(ordered).length,
    files: Object.freeze(ordered),
    sha256: identitySha256(ordered),
  });
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > length) throw new Error(`Tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const text = Math.trunc(value).toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error(`Tar numeric field is too large: ${value}`);
  writeTarText(header, offset, length, `${text}\0`);
}

function tarNameParts(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  const separators = [...name.matchAll(/\//g)].map((match) => match.index).reverse();
  for (const separator of separators) {
    const prefix = name.slice(0, separator);
    const base = name.slice(separator + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) {
      return { name: base, prefix };
    }
  }
  throw new Error(`Package path cannot be represented in a portable ustar archive: ${name}`);
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  const parts = tarNameParts(name);
  writeTarText(header, 0, 100, parts.name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  writeTarText(header, 345, 155, parts.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeTarText(header, 148, 8, `${checksumText}\0 `);
  return header;
}

export async function createDeterministicPackageArchive({ packageRoot, archivePath }) {
  const root = path.resolve(packageRoot);
  const target = assertExternalArtifactPath(root, archivePath, "Package archive");
  const chunks = [];
  for (const file of await walkPackageFiles(root)) {
    const name = path.relative(root, file).split(path.sep).join("/");
    const bytes = await fs.readFile(file);
    chunks.push(tarHeader(name, bytes.length), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = Buffer.concat(chunks);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, archive, { flag: "wx", mode: 0o644 });
  return Object.freeze({
    identity_kind: "archive",
    format: "ustar",
    sha256: sha256(archive),
    bytes: archive.length,
  });
}

function attestationBody({
  releaseManifest,
  inventory,
  archive,
  issuedAt,
  certificationEvidenceReceipt,
}) {
  const runtimeCodeClosure =
    releaseManifest?.identity?.package?.runtime_code_closure ?? null;
  if (releaseManifest?.identity?.schema_version !== "product-identity/2.0") {
    throw new Error("Release manifest does not contain product-identity/2.0.");
  }
  if (releaseManifest.identity.package.mode !== "certified") {
    throw new Error("Only a certified package can receive a release-package attestation.");
  }
  if (
    !SHA256.test(String(runtimeCodeClosure?.sha256 ?? "")) ||
    runtimeCodeClosure.sha256 !== runtimeCodeClosure.certified_sha256
  ) {
    throw new Error("Release manifest runtime-code closure is not exactly certified.");
  }
  const evidenceReceipt =
    certificationEvidenceReceipt ?? releaseManifest?.certification?.evidenceReceipt ?? null;
  if (evidenceReceipt?.status !== "PASS") {
    throw new Error("External attestation requires a passing certification evidence receipt.");
  }
  const sealedProductIdentity = productIdentity({
    repository: releaseManifest.identity.source.repository,
    sourceCommit: releaseManifest.identity.source.commit_sha,
    sourceTree: releaseManifest.identity.source.tree_sha,
    packageMode: releaseManifest.identity.package.mode,
    deploymentStatus: releaseManifest.identity.deployment.status,
    runtimeCodeClosureSha256: runtimeCodeClosure.sha256,
    certifiedRuntimeCodeClosureSha256: runtimeCodeClosure.certified_sha256,
    completePackageInventorySha256: inventory.sha256,
    archiveSha256: archive.sha256,
    installedPackageSha256:
      releaseManifest.identity.deployment.installed_package?.sha256 ?? null,
    installationIdentity:
      releaseManifest.identity.deployment.installation_identity ?? null,
  });
  return {
    schema_version: RELEASE_PACKAGE_ATTESTATION_SCHEMA,
    status: "PASS",
    issued_at: issuedAt,
    package: {
      release_name: releaseManifest.releaseName,
      skill_version: releaseManifest.skillVersion,
      product_identity: sealedProductIdentity,
      complete_package_inventory: inventory,
      archive,
      release_manifest_sha256: inventory.files["release-manifest.json"] ?? null,
    },
    certification_evidence: evidenceReceipt,
  };
}

export async function buildReleasePackageAttestation({
  packageRoot,
  archive,
  certificationEvidenceReceipt = null,
  issuedAt = new Date().toISOString(),
}) {
  const root = path.resolve(packageRoot);
  const releaseManifest = JSON.parse(
    await fs.readFile(path.join(root, "release-manifest.json"), "utf8"),
  );
  const inventory = await completePackageInventoryIdentity(root);
  const body = attestationBody({
    releaseManifest,
    inventory,
    archive,
    issuedAt,
    certificationEvidenceReceipt,
  });
  return Object.freeze({ ...body, attestation_sha256: identitySha256(body) });
}

export async function writeExternalReleasePackageAttestation({
  packageRoot,
  attestationPath,
  attestation,
}) {
  const target = assertExternalArtifactPath(
    packageRoot,
    attestationPath,
    "Release-package attestation",
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(attestation, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return target;
}

export async function verifyReleasePackageAttestation({
  packageRoot,
  attestation,
  archivePath = null,
}) {
  const findings = [];
  const body = { ...attestation };
  delete body.attestation_sha256;
  if (attestation?.schema_version !== RELEASE_PACKAGE_ATTESTATION_SCHEMA) {
    findings.push("attestation schema does not match");
  }
  if (attestation?.status !== "PASS") findings.push("attestation status is not PASS");
  if (
    !SHA256.test(String(attestation?.attestation_sha256 ?? "")) ||
    identitySha256(body) !== attestation.attestation_sha256
  ) {
    findings.push("attestation self-hash does not match");
  }

  let inventory = null;
  let releaseManifest = null;
  try {
    inventory = await completePackageInventoryIdentity(packageRoot);
    releaseManifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "release-manifest.json"), "utf8"),
    );
  } catch (error) {
    findings.push(`package cannot be inventoried: ${error.message}`);
  }
  const attestedInventory = attestation?.package?.complete_package_inventory;
  if (
    inventory &&
    (inventory.sha256 !== attestedInventory?.sha256 ||
      identitySha256(inventory.files) !== identitySha256(attestedInventory?.files ?? {}))
  ) {
    findings.push("complete package inventory does not match attestation");
  }
  if (releaseManifest) {
    const manifestClosure = releaseManifest?.identity?.package?.runtime_code_closure ?? null;
    if (
      identitySha256(manifestClosure) !==
      identitySha256(
        attestation?.package?.product_identity?.package?.runtime_code_closure ?? null,
      )
    ) {
      findings.push("runtime-code closure does not match release manifest");
    }
    if (
      attestation?.package?.product_identity?.package?.complete_package_inventory
        ?.sha256 !== attestedInventory?.sha256
    ) {
      findings.push("product identity does not bind complete package inventory");
    }
    if (
      attestation?.package?.product_identity?.package?.archive?.sha256 !==
      attestation?.package?.archive?.sha256
    ) {
      findings.push("product identity does not bind archive identity");
    }
    if (
      inventory?.files?.["release-manifest.json"] !==
      attestation?.package?.release_manifest_sha256
    ) {
      findings.push("release manifest identity does not match attestation");
    }
    try {
      const expectedProductIdentity = productIdentity({
        repository: releaseManifest.identity.source.repository,
        sourceCommit: releaseManifest.identity.source.commit_sha,
        sourceTree: releaseManifest.identity.source.tree_sha,
        packageMode: releaseManifest.identity.package.mode,
        deploymentStatus: releaseManifest.identity.deployment.status,
        runtimeCodeClosureSha256: manifestClosure.sha256,
        certifiedRuntimeCodeClosureSha256: manifestClosure.certified_sha256,
        completePackageInventorySha256: inventory?.sha256 ?? null,
        archiveSha256: attestation?.package?.archive?.sha256 ?? null,
        installedPackageSha256:
          releaseManifest.identity.deployment.installed_package?.sha256 ?? null,
        installationIdentity:
          releaseManifest.identity.deployment.installation_identity ?? null,
      });
      if (
        identitySha256(expectedProductIdentity) !==
        identitySha256(attestation?.package?.product_identity ?? null)
      ) {
        findings.push(
          "sealed product identity does not match release manifest and package identities",
        );
      }
    } catch (error) {
      findings.push(`sealed product identity cannot be recomputed: ${error.message}`);
    }
  }
  if (archivePath) {
    try {
      const bytes = await fs.readFile(archivePath);
      if (sha256(bytes) !== attestation?.package?.archive?.sha256) {
        findings.push("archive identity does not match attestation");
      }
    } catch (error) {
      findings.push(`archive cannot be read: ${error.message}`);
    }
  }
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    total_violations: findings.length,
    findings: Object.freeze(findings),
    complete_package_inventory_sha256: inventory?.sha256 ?? null,
  });
}
