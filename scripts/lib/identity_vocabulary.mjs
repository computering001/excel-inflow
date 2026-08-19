import { createHash } from "node:crypto";

export const PRODUCT_IDENTITY_SCHEMA = "product-identity/2.0";
export const RUNTIME_CODE_CLOSURE_SCHEMA = "runtime-code-closure/1.0";
export const DECLARED_RUNTIME_INTEGRITY_SCHEMA = "declared-runtime-integrity/2.0";

export const PACKAGE_MODES = Object.freeze(["development", "certified"]);
export const DEPLOYMENT_STATUSES = Object.freeze([
  "not_installed",
  "installed_candidate",
  "active_candidate",
  "production_promoted",
  "rollback",
]);

const SHA256 = /^[a-f0-9]{64}$/;

export function canonicaliseIdentity(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicaliseIdentity);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicaliseIdentity(value[key])]),
  );
}

export function identitySha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicaliseIdentity(value)))
    .digest("hex");
}

export function assertPackageMode(value, label = "package mode") {
  if (!PACKAGE_MODES.includes(value)) {
    throw new Error(`${label} must be one of ${PACKAGE_MODES.join(", ")}; got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function assertDeploymentStatus(value, label = "deployment status") {
  if (!DEPLOYMENT_STATUSES.includes(value)) {
    throw new Error(
      `${label} must be one of ${DEPLOYMENT_STATUSES.join(", ")}; got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function assertIdentitySha256(value, label) {
  if (!SHA256.test(String(value ?? ""))) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

/**
 * Runtime code closure is the executable and machine-contract subset of a
 * package: scripts, assets, declared resources and vendored runtime bytes.
 * Human instructions and release/install receipts are deliberately separate
 * identities. `files` is the exact portable-path -> byte-hash inventory.
 */
export function runtimeCodeClosureIdentity(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Runtime code closure files must be a path-to-sha256 object.");
  }
  const ordered = canonicaliseIdentity(files);
  for (const [name, digest] of Object.entries(ordered)) {
    if (!name || name.startsWith("/") || name.includes("\\")) {
      throw new Error(`Runtime code closure path is not portable: ${JSON.stringify(name)}.`);
    }
    assertIdentitySha256(digest, `Runtime code closure member ${name}`);
  }
  return Object.freeze({
    schema_version: RUNTIME_CODE_CLOSURE_SCHEMA,
    identity_kind: "runtime_code_closure",
    file_count: Object.keys(ordered).length,
    files: Object.freeze(ordered),
    sha256: identitySha256(ordered),
  });
}

export function productIdentity({
  repository,
  sourceCommit,
  sourceTree,
  packageMode,
  deploymentStatus,
  runtimeCodeClosureSha256,
  certifiedRuntimeCodeClosureSha256 = null,
  completePackageInventorySha256 = null,
  archiveSha256 = null,
  installedPackageSha256 = null,
  installationIdentity = null,
}) {
  assertPackageMode(packageMode);
  assertDeploymentStatus(deploymentStatus);
  assertIdentitySha256(runtimeCodeClosureSha256, "Runtime code closure identity");
  for (const [label, value] of [
    ["Certified runtime code closure identity", certifiedRuntimeCodeClosureSha256],
    ["Complete package inventory identity", completePackageInventorySha256],
    ["Archive identity", archiveSha256],
    ["Installed package identity", installedPackageSha256],
  ]) {
    if (value !== null && value !== undefined) assertIdentitySha256(value, label);
  }
  return Object.freeze({
    schema_version: PRODUCT_IDENTITY_SCHEMA,
    source: Object.freeze({
      identity_kind: "source_tree",
      repository: repository ?? null,
      commit_sha: sourceCommit ?? null,
      tree_sha: sourceTree ?? null,
    }),
    package: Object.freeze({
      mode: packageMode,
      runtime_code_closure: Object.freeze({
        identity_kind: "runtime_code_closure",
        sha256: runtimeCodeClosureSha256,
        certified_sha256: certifiedRuntimeCodeClosureSha256,
      }),
      complete_package_inventory: Object.freeze({
        identity_kind: "complete_package_inventory",
        sha256: completePackageInventorySha256,
      }),
      archive: Object.freeze({ identity_kind: "archive", sha256: archiveSha256 }),
    }),
    deployment: Object.freeze({
      status: deploymentStatus,
      installation_identity: installationIdentity,
      installed_package: Object.freeze({
        identity_kind: "installed_package",
        sha256: installedPackageSha256,
      }),
    }),
  });
}
