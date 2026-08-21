#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalSha256, verifySourceIdentityReceipt } from "./lib/external_ci_evidence.mjs";
import { compareExactHeadPackageBuilds, validateArchiveOnlyReport } from "./lib/exact_head_package_ci.mjs";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MODES = new Set(["package", "reproducibility", "archive-capability", "mutation-measurement", "synthetic-merge"]);

function parse(argv) {
  const mode = argv[0];
  if (!MODES.has(mode)) throw new Error(`First argument must be one of ${[...MODES].join(", ")}.`);
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token?.startsWith("--") || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Invalid option ${token ?? "<missing>"}.`);
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}.`);
    options[key] = argv[index + 1];
  }
  return { mode, options };
}

function exactOptions(options, required) {
  const actual = Object.keys(options).sort();
  const expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Options must be exactly ${expected.join(", ")}; received ${actual.join(", ")}.`);
}

async function readJson(file, label) {
  try { return JSON.parse(await fs.readFile(path.resolve(file), "utf8")); }
  catch (error) { throw new Error(`${label} is not readable JSON: ${error.message}`); }
}

async function writeJson(file, value) {
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, target);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sourceBinding(source) {
  return {
    github_sha: source.github_sha,
    source_tree: source.source_tree,
    ref: source.ref,
    event_name: source.event_name,
    run_id: source.run.id,
    run_attempt: source.run.attempt,
  };
}

function selfHash(value, field, label) {
  if (!SHA256.test(String(value?.[field]))) throw new Error(`${label} has no canonical ${field}.`);
  const unsigned = { ...value };
  delete unsigned[field];
  if (canonicalSha256(unsigned) !== value[field]) throw new Error(`${label} self-hash mismatch.`);
}

async function compilePackage(source, raw, jobId) {
  if (!["package_a", "package_b"].includes(jobId)) throw new Error("Package job-id must be package_a or package_b.");
  const expectedLabel = jobId === "package_a" ? "A" : "B";
  if (raw.schema_version !== "exact-head-package-build-receipt/1.0" || raw.label !== expectedLabel) throw new Error("Raw package build receipt has wrong schema or label.");
  selfHash(raw, "receipt_sha256", "raw package build receipt");
  if (raw.source?.commit !== source.github_sha || raw.source?.tree !== source.source_tree || raw.source?.worktree_clean !== true) throw new Error("Package build is not the exact clean source identity.");
  if (raw.build_origin !== "independent_clean_checkout" || raw.build_exit_code !== 0) throw new Error("Package build origin/result is not independently clean PASS.");
  if (!/^\d+\.\d+\.\d+$/.test(String(raw.package_identity?.candidate_version)) ||
      raw.package_identity?.package_mode !== "development" || raw.package_identity?.deployment_status !== "not_installed") {
    throw new Error("Package build does not carry the expected pre-install candidate identity.");
  }
  if (raw.package_identity?.build_timestamp_policy?.kind !== "SOURCE_DATE_EPOCH" ||
      raw.package_identity?.build_timestamp_policy?.source_date_epoch !== Number(raw.source_date_epoch) ||
      raw.package_identity?.build_timestamp_policy?.generated_at !== new Date(Number(raw.source_date_epoch) * 1000).toISOString()) {
    throw new Error("Package build timestamp policy does not join the exact SOURCE_DATE_EPOCH.");
  }
  if (canonicalSha256(raw.toolchain) !== canonicalSha256(source.toolchain)) throw new Error("Package build toolchain differs from Job 1.");
  if (!SHA256.test(String(raw.build_inputs?.smoke_case?.sha256)) || !Number.isInteger(raw.build_inputs?.smoke_case?.size) || raw.build_inputs.smoke_case.size < 1) {
    throw new Error("Package build does not bind the exact smoke-case bytes.");
  }
  for (const value of [raw.package?.inventory_sha256, raw.package?.runtime_code_closure_sha256, raw.archive?.sha256, raw.build_log?.sha256]) {
    if (!SHA256.test(String(value))) throw new Error("Package build receipt contains an invalid digest.");
  }
  const logPath = path.resolve(raw.build_log.path);
  const logBytes = await fs.readFile(logPath);
  if (sha256(logBytes) !== raw.build_log.sha256 || logBytes.length !== raw.build_log.size) throw new Error("Package build log custody mismatch.");
  return {
    schema_version: "excel-inflow-ci-package-build-receipt/1.0", job_id: jobId, status: "PASS",
    source_binding: sourceBinding(source), clean_checkout: true, toolchain_sha256: source.toolchain_sha256,
    candidate_version: raw.package_identity.candidate_version,
    package_mode: raw.package_identity.package_mode,
    deployment_status: raw.package_identity.deployment_status,
    build_timestamp_policy: raw.package_identity.build_timestamp_policy,
    package_inventory_sha256: raw.package.inventory_sha256, archive_sha256: raw.archive.sha256,
    archive_bytes: raw.archive.size, runtime_closure_sha256: raw.package.runtime_code_closure_sha256,
    build_log: { path: path.basename(logPath), sha256: raw.build_log.sha256, bytes: raw.build_log.size },
  };
}

function compileReproducibility(source, raw, a, b) {
  selfHash(raw, "report_sha256", "package reproducibility report");
  const recomputed = compareExactHeadPackageBuilds(a, b);
  if (canonicalSha256(recomputed) !== canonicalSha256(raw)) throw new Error("Package reproducibility report does not equal an independent recomputation over A and B.");
  if (raw.status !== "PASS" || raw.source_commit !== source.github_sha || raw.source_tree !== source.source_tree || raw.findings?.length !== 0 || raw.file_differences?.length !== 0) {
    throw new Error("Package reproducibility report is not exact-head PASS.");
  }
  if (raw.archive_byte_equal !== true || raw.inventory_byte_equal !== true || a.archive?.sha256 !== b.archive?.sha256 || a.package?.inventory_sha256 !== b.package?.inventory_sha256) {
    throw new Error("Package A and B are not byte/inventory identical.");
  }
  selfHash(a, "receipt_sha256", "raw package A receipt");
  selfHash(b, "receipt_sha256", "raw package B receipt");
  if (raw.package_a_receipt_sha256 !== a.receipt_sha256 || raw.package_b_receipt_sha256 !== b.receipt_sha256) throw new Error("Reproducibility report does not bind the two raw package receipts.");
  return {
    schema_version: "excel-inflow-ci-package-reproducibility-receipt/1.0", job_id: "package_reproducibility", status: "PASS",
    source_binding: sourceBinding(source), archive_a_sha256: a.archive.sha256, archive_b_sha256: b.archive.sha256,
    inventory_a_sha256: a.package.inventory_sha256, inventory_b_sha256: b.package.inventory_sha256,
    paths_types_bytes_sha_modes_identical: true, archives_byte_identical: true, inventories_identical: true,
    source_date_epoch: Number(raw.source_date_epoch),
  };
}

function compileArchive(source, raw, packageA) {
  const findings = validateArchiveOnlyReport(raw);
  if (findings.length || raw.status !== "PASS" || raw.archive_sha256 !== packageA.archive_sha256 || raw.source_checkout_used !== false) {
    throw new Error(`Archive-only proof is incomplete: ${findings.join(", ")}.`);
  }
  return {
    schema_version: "excel-inflow-ci-archive-capability-receipt/1.0", job_id: "archive_capability", status: "PASS",
    source_binding: sourceBinding(source), archive_sha256: raw.archive_sha256, source_checkout_used: false,
    public_bootstrap_status: raw.lanes.public_bootstrap.status,
    installed_capability_status: raw.lanes.installed_capability.status,
    independent_oracle_status: raw.lanes.independent_oracle.status,
    capability_report_sha256: raw.lanes.installed_capability.report_sha256,
    capability_receipt_sha256: raw.installed_capability_receipt.sha256,
    independent_oracle_report_sha256: raw.lanes.independent_oracle.report_sha256,
  };
}

function compileMutation(source, raw, rawBytes) {
  if (raw.schema_version !== "excel-inflow-mutation-adequacy/1.0" || raw.source_identity?.commit !== source.github_sha || raw.source_identity?.worktree_dirty !== false) {
    throw new Error("Mutation report is not bound to a clean exact-head source checkout.");
  }
  if (raw.zero_survivor_gate?.status !== "PASS" || raw.score?.survived !== 0 || raw.survivors?.length !== 0) throw new Error("Mutation report has a surviving mutation.");
  if (raw.zero_survivor_gate?.members_without_a_reported_count?.length !== 0 || raw.zero_survivor_gate?.unproven_members?.length !== 0) {
    throw new Error("P0 mutation evidence is not fully measured.");
  }
  const totalSuites = raw.corpus?.registry_mutation_suites;
  const measuredSuites = raw.corpus?.suites_reporting_a_mutation_count;
  const unmeasuredSuites = raw.measurement_gaps?.length;
  const applied = raw.score?.measured_mutations;
  if (![totalSuites, measuredSuites, unmeasuredSuites, applied, raw.score?.killed].every(Number.isInteger) ||
      totalSuites < 1 || measuredSuites < 1 || totalSuites !== measuredSuites + unmeasuredSuites ||
      raw.corpus.measurement_coverage !== Number((measuredSuites / totalSuites).toFixed(4)) || applied < 1 || raw.score.killed !== applied) {
    throw new Error("Mutation suite/count coverage is internally inconsistent.");
  }
  return {
    schema_version: "excel-inflow-ci-mutation-measurement-receipt/1.0", job_id: "mutation_measurement", status: "PASS",
    source_binding: sourceBinding(source), total_mutation_suites: totalSuites, measured_mutation_suites: measuredSuites,
    unmeasured_mutation_suites: unmeasuredSuites, measurement_coverage: measuredSuites / totalSuites,
    measured_mutations_applied: applied, measured_mutations_caught: raw.score.killed, measured_mutations_survived: 0,
    p0_fully_measured: true, p0_status: "PASS",
    report_sha256: sha256(rawBytes),
  };
}

function compileSyntheticMerge(source, raw) {
  if (raw.schema_version !== "ci-merge-compatibility-identity/1.0" || raw.status !== "PASS" || raw.expected_role !== "merge_test") throw new Error("Synthetic merge report is not PASS merge evidence.");
  if (raw.candidate_source_commit !== source.github_sha || raw.checked_out_commit === source.github_sha || !raw.parent_commits?.includes(source.github_sha)) throw new Error("Synthetic merge is not a separate merge object with the candidate as parent.");
  if (!SHA1.test(raw.checked_out_commit) || !SHA1.test(raw.checked_out_tree)) throw new Error("Synthetic merge identity is malformed.");
  return {
    schema_version: "excel-inflow-ci-synthetic-merge-receipt/1.0", job_id: "synthetic_merge", status: "PASS",
    source_binding: sourceBinding(source), candidate_commit: source.github_sha, candidate_tree: source.source_tree,
    merge_commit: raw.checked_out_commit, merge_tree: raw.checked_out_tree, candidate_is_parent: true,
  };
}

const { mode, options } = parse(process.argv.slice(2));
const source = verifySourceIdentityReceipt(await readJson(options["source-identity"], "source identity"));
let receipt;
if (mode === "package") {
  exactOptions(options, ["source-identity", "raw", "job-id", "out"]);
  const raw = await readJson(options.raw, "raw package receipt");
  receipt = await compilePackage(source, raw, options["job-id"]);
} else if (mode === "reproducibility") {
  exactOptions(options, ["source-identity", "raw", "package-a", "package-b", "out"]);
  receipt = compileReproducibility(source, await readJson(options.raw, "raw reproducibility report"), await readJson(options["package-a"], "package A receipt"), await readJson(options["package-b"], "package B receipt"));
} else if (mode === "archive-capability") {
  exactOptions(options, ["source-identity", "raw", "package-a", "out"]);
  receipt = compileArchive(source, await readJson(options.raw, "raw archive-only report"), await readJson(options["package-a"], "package A receipt"));
} else if (mode === "mutation-measurement") {
  exactOptions(options, ["source-identity", "raw", "out"]);
  const rawBytes = await fs.readFile(path.resolve(options.raw));
  receipt = compileMutation(source, JSON.parse(rawBytes), rawBytes);
} else {
  exactOptions(options, ["source-identity", "raw", "out"]);
  receipt = compileSyntheticMerge(source, await readJson(options.raw, "synthetic merge report"));
}
await writeJson(options.out, receipt);
process.stdout.write(`${JSON.stringify({ status: receipt.status, schema_version: receipt.schema_version, out: path.resolve(options.out) })}\n`);
