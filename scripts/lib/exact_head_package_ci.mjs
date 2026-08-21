import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
  );
  return value;
}

export function canonicalSha256(value) {
  const encoded = JSON.stringify(canonicalise(value));
  return sha256(Buffer.from(encoded === undefined ? "null" : encoded, "utf8"));
}

async function regularBytes(target, label) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be one regular non-symlink file.`);
  return { stat, bytes: await fs.readFile(target) };
}

export async function packageInventory(packageRoot) {
  const root = await fs.realpath(packageRoot);
  const rows = [];
  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Package inventory refuses symlink ${relative}.`);
      if (stat.isDirectory()) {
        rows.push({ path: relative, type: "directory", mode: stat.mode & 0o777, size: 0, sha256: null });
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        rows.push({ path: relative, type: "file", mode: stat.mode & 0o777, size: stat.size, sha256: sha256(await fs.readFile(absolute)) });
      } else throw new Error(`Package inventory refuses non-regular member ${relative}.`);
    }
  }
  await visit(root);
  return Object.freeze({ rows, sha256: canonicalSha256(rows), file_count: rows.filter((row) => row.type === "file").length });
}

export async function compilePackageBuildReceipt({
  label,
  packageRoot,
  archivePath,
  attestationPath,
  buildLogPath,
  sourceCommit,
  sourceTree,
  sourceDateEpoch,
  checkoutInstanceId,
  toolchain,
  buildInputs,
  buildExitCode,
  buildOrigin = "independent_clean_checkout",
  sourceWorktreeClean = true,
} = {}) {
  if (!/^[AB]$/.test(String(label))) throw new Error("Package label must be A or B.");
  if (!GIT_SHA.test(String(sourceCommit)) || !GIT_SHA.test(String(sourceTree))) throw new Error("Build receipt requires Git commit and tree identities.");
  if (!/^\d+$/.test(String(sourceDateEpoch ?? ""))) throw new Error("SOURCE_DATE_EPOCH must be explicit whole seconds.");
  if (buildOrigin !== "independent_clean_checkout" || sourceWorktreeClean !== true) throw new Error("Package build must come from an independent clean checkout.");
  if (typeof checkoutInstanceId !== "string" || checkoutInstanceId.length < 8) throw new Error("Checkout instance identity is missing.");
  if (buildExitCode !== 0) throw new Error("A non-zero package build cannot mint a build receipt.");
  if (!SHA256.test(String(buildInputs?.smoke_case?.sha256)) || !Number.isInteger(buildInputs?.smoke_case?.size)) {
    throw new Error("Package build receipt requires the exact smoke-case bytes.");
  }
  const inventory = await packageInventory(packageRoot);
  const releaseManifestBytes = await fs.readFile(path.join(packageRoot, "release-manifest.json"));
  const releaseManifest = JSON.parse(releaseManifestBytes.toString("utf8"));
  const runtimeClosureSha256 = releaseManifest?.identity?.package?.runtime_code_closure?.sha256;
  if (!SHA256.test(String(runtimeClosureSha256))) throw new Error("Release manifest does not carry a runtime-code-closure SHA-256.");
  if (!/^\d+\.\d+\.\d+$/.test(String(releaseManifest?.skillVersion))) {
    throw new Error("Release manifest does not carry a canonical candidate version.");
  }
  if (releaseManifest?.packageMode !== "development" || releaseManifest?.deploymentStatus !== "not_installed") {
    throw new Error("Exact-head candidate package must be development and not installed.");
  }
  if (
    releaseManifest?.identity?.source?.commit_sha !== sourceCommit ||
    releaseManifest?.identity?.source?.tree_sha !== sourceTree ||
    releaseManifest?.identity?.package?.mode !== releaseManifest.packageMode ||
    releaseManifest?.identity?.deployment?.status !== releaseManifest.deploymentStatus
  ) {
    throw new Error("Release manifest product identity does not join the requested exact-head source and package state.");
  }
  const generatedAt = new Date(Number(sourceDateEpoch) * 1000).toISOString();
  if (releaseManifest?.generatedAt !== generatedAt) {
    throw new Error("Release manifest build timestamp is not the exact SOURCE_DATE_EPOCH policy output.");
  }
  const archive = await regularBytes(archivePath, "Package archive");
  const attestation = await regularBytes(attestationPath, "Package attestation");
  const log = await regularBytes(buildLogPath, "Package build log");
  const body = {
    schema_version: "exact-head-package-build-receipt/1.0",
    label,
    source: { commit: sourceCommit, tree: sourceTree, worktree_clean: true },
    build_origin: buildOrigin,
    checkout_instance_id: checkoutInstanceId,
    source_date_epoch: String(sourceDateEpoch),
    package_identity: {
      candidate_version: releaseManifest.skillVersion,
      package_mode: releaseManifest.packageMode,
      deployment_status: releaseManifest.deploymentStatus,
      build_timestamp_policy: {
        kind: "SOURCE_DATE_EPOCH",
        source_date_epoch: Number(sourceDateEpoch),
        generated_at: generatedAt,
      },
    },
    toolchain,
    build_inputs: buildInputs,
    build_exit_code: 0,
    package: {
      root: path.resolve(packageRoot),
      runtime_code_closure_sha256: runtimeClosureSha256,
      release_manifest_sha256: sha256(releaseManifestBytes),
      inventory_sha256: inventory.sha256,
      inventory_rows: inventory.rows,
    },
    archive: { path: path.resolve(archivePath), size: archive.stat.size, sha256: sha256(archive.bytes) },
    attestation: { path: path.resolve(attestationPath), size: attestation.stat.size, sha256: sha256(attestation.bytes) },
    build_log: { path: path.resolve(buildLogPath), size: log.stat.size, sha256: sha256(log.bytes) },
  };
  return Object.freeze({ ...body, receipt_sha256: canonicalSha256(body) });
}

export function compareExactHeadPackageBuilds(a, b) {
  const findings = [];
  const add = (id, left, right) => { if (left !== right) findings.push({ id, a: left ?? null, b: right ?? null }); };
  if (a?.schema_version !== "exact-head-package-build-receipt/1.0" || b?.schema_version !== a?.schema_version) findings.push({ id: "receipt.schema" });
  if (a?.receipt_sha256 !== canonicalSha256(Object.fromEntries(Object.entries(a ?? {}).filter(([key]) => key !== "receipt_sha256")))) findings.push({ id: "receipt.a.self_hash" });
  if (b?.receipt_sha256 !== canonicalSha256(Object.fromEntries(Object.entries(b ?? {}).filter(([key]) => key !== "receipt_sha256")))) findings.push({ id: "receipt.b.self_hash" });
  add("source.commit", a?.source?.commit, b?.source?.commit);
  add("source.tree", a?.source?.tree, b?.source?.tree);
  add("source_date_epoch", a?.source_date_epoch, b?.source_date_epoch);
  add("package_identity", canonicalSha256(a?.package_identity), canonicalSha256(b?.package_identity));
  add("toolchain", canonicalSha256(a?.toolchain), canonicalSha256(b?.toolchain));
  add("build_inputs.smoke_case.sha256", a?.build_inputs?.smoke_case?.sha256, b?.build_inputs?.smoke_case?.sha256);
  add("build_inputs.smoke_case.size", a?.build_inputs?.smoke_case?.size, b?.build_inputs?.smoke_case?.size);
  add("package.runtime_code_closure", a?.package?.runtime_code_closure_sha256, b?.package?.runtime_code_closure_sha256);
  if (a?.build_origin !== "independent_clean_checkout" || b?.build_origin !== "independent_clean_checkout") findings.push({ id: "build.origin" });
  if (a?.checkout_instance_id === b?.checkout_instance_id) findings.push({ id: "build.checkouts_not_independent" });
  if (a?.source?.worktree_clean !== true || b?.source?.worktree_clean !== true) findings.push({ id: "build.dirty_checkout" });
  add("package.inventory", a?.package?.inventory_sha256, b?.package?.inventory_sha256);
  add("archive.sha256", a?.archive?.sha256, b?.archive?.sha256);
  add("archive.size", a?.archive?.size, b?.archive?.size);
  const byPath = (rows) => new Map((rows ?? []).map((row) => [row.path, row]));
  const left = byPath(a?.package?.inventory_rows);
  const right = byPath(b?.package?.inventory_rows);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const file_differences = [];
  const file_comparison = [];
  for (const name of paths) {
    const x = left.get(name);
    const y = right.get(name);
    const row = {
      path: name,
      a: x ? { type: x.type, mode: x.mode, size: x.size, sha256: x.sha256 } : null,
      b: y ? { type: y.type, mode: y.mode, size: y.size, sha256: y.sha256 } : null,
    };
    row.equal = canonicalSha256(row.a) === canonicalSha256(row.b);
    file_comparison.push(row);
    for (const field of ["type", "mode", "size", "sha256"]) if (x?.[field] !== y?.[field]) file_differences.push({ path: name, field, a: x?.[field] ?? null, b: y?.[field] ?? null });
  }
  if (file_differences.length) findings.push({ id: "package.members", count: file_differences.length });
  const body = {
    schema_version: "exact-head-package-reproducibility/1.0",
    source_commit: a?.source?.commit ?? null,
    source_tree: a?.source?.tree ?? null,
    source_date_epoch: a?.source_date_epoch ?? null,
    package_a_receipt_sha256: a?.receipt_sha256 ?? null,
    package_b_receipt_sha256: b?.receipt_sha256 ?? null,
    inventory_byte_equal: a?.package?.inventory_sha256 === b?.package?.inventory_sha256,
    archive_byte_equal: a?.archive?.sha256 === b?.archive?.sha256 && a?.archive?.size === b?.archive?.size,
    file_comparison,
    file_differences,
    findings,
    status: findings.length === 0 ? "PASS" : "FAIL",
  };
  return Object.freeze({ ...body, report_sha256: canonicalSha256(body) });
}

export function validateArchiveOnlyReport(report) {
  const findings = [];
  if (report?.schema_version !== "archive-only-capability-proof/1.0") findings.push("schema");
  if (!SHA256.test(String(report?.archive_sha256))) findings.push("archive_sha256");
  if (report?.unpacked_package?.source_checkout_present !== false) findings.push("source_checkout_present");
  for (const lane of ["public_bootstrap", "installed_capability", "independent_oracle"]) {
    if (
      report?.lanes?.[lane]?.status !== "PASS" ||
      !SHA256.test(String(report?.lanes?.[lane]?.log_sha256)) ||
      !SHA256.test(String(report?.lanes?.[lane]?.report_sha256))
    ) findings.push(lane);
  }
  if (!SHA256.test(String(report?.installed_capability_receipt?.sha256))) findings.push("installed_capability_receipt");
  if (report?.report_sha256 !== canonicalSha256(Object.fromEntries(Object.entries(report ?? {}).filter(([key]) => key !== "report_sha256")))) findings.push("self_hash");
  return findings;
}
