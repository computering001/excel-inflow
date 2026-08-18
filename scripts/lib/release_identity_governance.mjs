const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function requireGitSha(value, label, errors) {
  if (!GIT_SHA.test(String(value ?? ""))) errors.push(`${label} is not a full lowercase Git object id.`);
}

function requireSha256(value, label, errors) {
  if (!SHA256.test(String(value ?? ""))) errors.push(`${label} is not a lowercase SHA-256 digest.`);
}

export function validateIdentityConvergence(record, {
  expectedVersion,
  expectedSourceCommit,
  expectedSourceTree,
  limitationsExists,
} = {}) {
  const errors = [];
  if (record?.schema_version !== "current-identity-convergence/2.0") errors.push("schema_version is not current-identity-convergence/2.0.");
  if (record?.release?.skill_version !== expectedVersion) errors.push("release version does not equal the frozen remediation version.");
  if (record?.release?.deployment_status !== "not_installed") errors.push("development identity must remain not_installed.");

  const base = record?.remediation_base ?? {};
  const head = record?.identity_roles?.candidate_pr_head ?? {};
  const merge = record?.identity_roles?.pr_merge_test ?? {};
  const packageSource = record?.identity_roles?.package_source ?? {};
  const packageOnly = record?.identity_roles?.package_only_commit ?? {};
  const installed = record?.identity_roles?.installed_package ?? {};
  for (const [value, label] of [
    [base.commit, "remediation_base.commit"],
    [head.commit, "candidate_pr_head.commit"],
    [merge.commit, "pr_merge_test.commit"],
    [packageSource.commit, "package_source.commit"],
    [packageOnly.commit, "package_only_commit.commit"],
  ]) requireGitSha(value, label, errors);
  for (const [value, label] of [
    [base.tree, "remediation_base.tree"],
    [head.tree, "candidate_pr_head.tree"],
    [merge.tree, "pr_merge_test.tree"],
    [packageSource.tree, "package_source.tree"],
    [packageOnly.tree, "package_only_commit.tree"],
  ]) requireGitSha(value, label, errors);

  if (base.commit !== expectedSourceCommit || head.commit !== expectedSourceCommit) errors.push("candidate source commit differs from the frozen remediation source.");
  if (base.tree !== expectedSourceTree || head.tree !== expectedSourceTree) errors.push("candidate source tree differs from the frozen remediation tree.");
  if (packageSource.commit !== head.commit || packageSource.tree !== head.tree) errors.push("package source does not equal the candidate PR head and tree.");
  if (merge.commit === packageSource.commit) errors.push("merge-test commit masquerades as package source.");
  if (merge.classification !== "COMPATIBILITY_EVIDENCE_NOT_PACKAGE_SOURCE") errors.push("merge-test identity is not explicitly non-authoritative for packaging.");
  if (!Array.isArray(merge.parents) || !merge.parents.includes(head.commit)) errors.push("merge-test commit is not bound to the candidate head as a parent.");
  if (packageOnly.commit === packageSource.commit) errors.push("package-only commit is not distinguished from package source.");
  if (packageOnly.classification !== "PACKAGE_BYTES_CUSTODY_NOT_SOURCE_AUTHORITY") errors.push("package-only commit is not explicitly non-authoritative for source.");
  if (installed.deployment_status !== "not_installed" || installed.sha256 !== null || installed.installation_identity !== null) errors.push("installed identity claims evidence that is held or absent.");
  if (!limitationsExists || record?.active_evidence?.known_limitations !== "KNOWN_LIMITATIONS.md") errors.push("KNOWN_LIMITATIONS.md is absent from active documentation governance.");

  for (const [key, value] of Object.entries(record?.package_identity ?? {})) {
    if (key.endsWith("_sha256")) requireSha256(value, `package_identity.${key}`, errors);
  }
  for (const [key, value] of Object.entries(record?.frozen_input_hashes ?? {})) {
    requireSha256(value, `frozen_input_hashes.${key}`, errors);
  }
  if (record?.package_identity?.tag_resolves_to !== expectedSourceCommit) errors.push("development tag does not resolve to the frozen source commit.");
  if (record?.status !== "PASS_DEVELOPMENT_IDENTITY_CONVERGED") errors.push("active identity record status is not PASS_DEVELOPMENT_IDENTITY_CONVERGED.");
  return errors;
}

export function validatePerformanceEvidence(record, { expectedSourceCommit, expectedSourceTree } = {}) {
  const errors = [];
  if (record?.schema_version !== "excel-inflow-phase15-full-run-evidence/2.0") errors.push("performance evidence schema is not current.");
  if (record?.source_identity?.commit !== expectedSourceCommit) errors.push("performance receipt belongs to another source commit.");
  if (record?.source_identity?.tree !== expectedSourceTree) errors.push("performance receipt belongs to another source tree.");
  requireSha256(record?.source_identity?.runtime_closure_sha256, "performance source runtime closure", errors);
  requireSha256(record?.durable_receipt?.file_sha256, "performance durable receipt", errors);
  requireSha256(record?.durable_receipt?.internal_receipt_sha256, "performance internal receipt", errors);
  if (record?.performance?.status !== "PASS") errors.push("performance receipt is not PASS.");
  if (record?.performance?.required_leaf_span_count !== record?.performance?.observed_leaf_span_count) errors.push("performance leaf-span coverage is incomplete.");
  if (record?.performance?.root_span_substitution_allowed !== false) errors.push("root span substitution is not prohibited.");
  if (record?.progress?.status !== "PASS" || record?.progress?.maximum_observed_interval_ms > record?.progress?.maximum_allowed_interval_ms) errors.push("progress heartbeat evidence exceeds policy.");
  if (record?.delivery?.total_violations !== 0) errors.push("delivery evidence has violations.");
  if (record?.status !== "PASS_PENDING_MANUAL") errors.push("portable evidence must remain PASS_PENDING_MANUAL until held native gates run.");
  return errors;
}

export function classifyCiIdentityRoles({
  checkedOutCommit,
  checkedOutTree,
  candidateSourceCommit,
  candidateSourceTree,
  mergeTestCommit = null,
  mergeTestTree = null,
  packageSourceCommit,
  packageSourceTree,
}) {
  const errors = [];
  for (const [value, label] of [
    [checkedOutCommit, "checked-out commit"],
    [candidateSourceCommit, "candidate source commit"],
    [packageSourceCommit, "package source commit"],
  ]) requireGitSha(value, label, errors);
  for (const [value, label] of [
    [checkedOutTree, "checked-out tree"],
    [candidateSourceTree, "candidate source tree"],
    [packageSourceTree, "package source tree"],
  ]) requireGitSha(value, label, errors);
  if (mergeTestCommit !== null) requireGitSha(mergeTestCommit, "merge-test commit", errors);
  if (mergeTestTree !== null) requireGitSha(mergeTestTree, "merge-test tree", errors);
  if (checkedOutCommit !== candidateSourceCommit) errors.push("package checkout is not pinned to candidate source head.");
  if (checkedOutTree !== candidateSourceTree) errors.push("package checkout tree differs from candidate source tree.");
  if (packageSourceCommit !== candidateSourceCommit || packageSourceTree !== candidateSourceTree) errors.push("compiled package source identity differs from candidate source identity.");
  if (mergeTestCommit && packageSourceCommit === mergeTestCommit) errors.push("synthetic merge commit was recorded as package source.");
  return {
    roles: {
      candidate_source: { commit: candidateSourceCommit, tree: candidateSourceTree },
      checked_out_package_source: { commit: checkedOutCommit, tree: checkedOutTree },
      pr_merge_test: mergeTestCommit ? { commit: mergeTestCommit, tree: mergeTestTree } : null,
      compiled_package_source: { commit: packageSourceCommit, tree: packageSourceTree },
      package_only_commit: null,
      installed_package: null,
    },
    errors,
    status: errors.length === 0 ? "PASS" : "FAIL",
  };
}
