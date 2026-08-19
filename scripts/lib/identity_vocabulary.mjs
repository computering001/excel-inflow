import { createHash } from "node:crypto";

export const PRODUCT_IDENTITY_SCHEMA = "product-identity/2.0";
export const RUNTIME_CODE_CLOSURE_SCHEMA = "runtime-code-closure/1.0";
export const DECLARED_RUNTIME_INTEGRITY_SCHEMA = "declared-runtime-integrity/2.0";

/**
 * Package modes. `certified` is the NATIVE certification tier: it claims the
 * full evidence set, including the two classes that only a licensed native
 * Microsoft Excel host can produce. `portable_certified` is a THIRD, weaker,
 * separately named tier minted by P8.0: its evidence set is exactly the
 * evidence a portable host can produce, with the native-Excel and
 * visual-review classes carried as PERMANENT DECLARED EXCLUSIONS.
 *
 * The two certified tiers are deliberately DIFFERENT VALUES rather than a flag
 * on one value, so that every existing `=== "certified"` comparison in this
 * repository keeps meaning "natively certified" and a portable package can
 * never drift into a native claim by default. `portable_certified` is appended
 * last so the assertion message keeps reading "development, certified, ..." for
 * readers and pinned diagnostics alike.
 */
export const PACKAGE_MODES = Object.freeze(["development", "certified", "portable_certified"]);
export const DEVELOPMENT_PACKAGE_MODE = "development";
export const NATIVE_CERTIFIED_PACKAGE_MODE = "certified";
export const PORTABLE_CERTIFIED_PACKAGE_MODE = "portable_certified";
export const CERTIFIED_PACKAGE_MODES = Object.freeze([
  NATIVE_CERTIFIED_PACKAGE_MODE,
  PORTABLE_CERTIFIED_PACKAGE_MODE,
]);

/**
 * The satisfiability token for a capability this repository can never reach
 * because it needs a licensed native Microsoft Excel host. It is the
 * native-host sibling of release_journal.mjs's EXCLUDED_INSTALLED_HOST, and it
 * is used the same way: a DECLARED exclusion carrying a reason, never a waiver
 * and never a pending task.
 */
export const EXCLUDED_NATIVE_HOST = "EXCLUDED_NATIVE_HOST";
export const PERMANENT_DECLARED_EXCLUSION = "PERMANENT_DECLARED_EXCLUSION";

/**
 * What each certification tier is entitled to claim. Code-declared so no asset,
 * dossier or receipt can assert a portable package is natively certified, and
 * so `claims_native_host_evidence` is a single readable fact rather than an
 * inference from which evidence files happen to be present.
 */
export const CERTIFICATION_TIER_CONTRACT = Object.freeze({
  [NATIVE_CERTIFIED_PACKAGE_MODE]: Object.freeze({
    package_mode: NATIVE_CERTIFIED_PACKAGE_MODE,
    tier: "NATIVE_CERTIFIED",
    claims_native_host_evidence: true,
    portable_host_satisfiable: false,
    declares_permanent_exclusions: false,
    supersedes: Object.freeze([PORTABLE_CERTIFIED_PACKAGE_MODE]),
    description:
      "Full certification. Claims every evidence class including native-Excel restoration and native visual review, so it is only reachable on a licensed native Microsoft Excel host.",
  }),
  [PORTABLE_CERTIFIED_PACKAGE_MODE]: Object.freeze({
    package_mode: PORTABLE_CERTIFIED_PACKAGE_MODE,
    tier: "PORTABLE_CERTIFIED",
    claims_native_host_evidence: false,
    portable_host_satisfiable: true,
    declares_permanent_exclusions: true,
    supersedes: Object.freeze([]),
    description:
      "Portable certification. Claims exactly the evidence classes a portable host can produce and carries the native-Excel and visual-review classes as permanent declared exclusions. It is a strictly weaker claim than NATIVE_CERTIFIED and must never be reported as one.",
  }),
});

/**
 * The permanent terminal state of the PHYSICAL lane, declared once, here.
 *
 * `PASS_PENDING_MANUAL` / `PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW` are the
 * success tokens the compiler and the orchestrator already emit and exit 0 on.
 * The word "PENDING" in both tokens is a HISTORICAL MISNOMER: the manual
 * physical lane those tokens wait for — a native Microsoft Excel host and a
 * human visual review — is permanently excluded from this programme by standing
 * directive. Nothing is queued, nobody is going to do it, and no future package
 * will flip these tokens to a non-pending spelling. The tokens themselves are
 * pinned by other suites and are deliberately NOT renamed; this record is the
 * one place that states what they actually mean, so a reader cannot mistake the
 * repository's terminal success state for unfinished work.
 */
export const PHYSICAL_LANE_TERMINAL_DECLARATION = Object.freeze({
  declaration_kind: "physical_lane_terminal_state",
  lane: "manual_physical_verification",
  status_token: "PASS_PENDING_MANUAL",
  release_gate_token: "PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW",
  process_exit_code: 0,
  disposition: PERMANENT_DECLARED_EXCLUSION,
  is_pending: false,
  is_waiver: false,
  revisit_condition: null,
  token_wording_is_historical_misnomer: true,
  tokens_deliberately_unchanged: true,
  tokens_unchanged_reason:
    "The two token strings and the exit-0 contract are pinned by other suites and by the compiler and orchestrator surfaces P8.0 must not touch. Renaming them is a separate, wider change; declaring their meaning is this package's job.",
  excluded_evidence_classes: Object.freeze(["native_excel", "visual_review"]),
  reachable_certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
  reason:
    "Both remaining classes of the manual physical lane require a licensed native Microsoft Excel installation: native-Excel restoration evidence, and a human visual review of every visible sheet in that application. Neither is available to this programme and neither may be simulated, so the lane has no reachable PASS beyond this state.",
});

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

/**
 * A certified package mode of EITHER tier. Use where any certification will do
 * — never where a native claim is being made.
 */
export function assertCertifiedPackageMode(value, label = "certified package mode") {
  if (!CERTIFIED_PACKAGE_MODES.includes(value)) {
    throw new Error(
      `${label} must be one of ${CERTIFIED_PACKAGE_MODES.join(", ")}; got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * The NATIVE certified mode and nothing else. This is the assertion that keeps
 * the portable tier from being an easier way to claim native certification: a
 * `portable_certified` package is refused here by name, with the reason stated,
 * and is directed at the portable gate instead.
 */
export function assertNativeCertifiedPackageMode(value, label = "native certified package mode") {
  if (value === PORTABLE_CERTIFIED_PACKAGE_MODE) {
    throw new Error(
      `${label} must be ${NATIVE_CERTIFIED_PACKAGE_MODE}; got ${JSON.stringify(value)}. ` +
        "A portable-certified package carries the native-Excel and visual-review evidence classes as permanent declared exclusions, so it can never satisfy a native certification check.",
    );
  }
  if (value !== NATIVE_CERTIFIED_PACKAGE_MODE) {
    throw new Error(`${label} must be ${NATIVE_CERTIFIED_PACKAGE_MODE}; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** The code-declared tier contract for a certified package mode. */
export function certificationTierContractFor(packageMode, label = "certification tier") {
  assertCertifiedPackageMode(packageMode, label);
  return CERTIFICATION_TIER_CONTRACT[packageMode];
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
