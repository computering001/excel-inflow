export const INSTALLED_CAPABILITY_RECEIPT_V13 =
  "excel-inflow-installed-capability-receipt/1.3";
export const ACTIVATION_FRESHNESS_MAX_AGE_SECONDS = 3600;
export const ACTIVATION_FUTURE_SKEW_SECONDS = 300;

function timestamp(value, path, findings) {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    findings.push({ path, code: "INVALID_TIMESTAMP" });
    return null;
  }
  return Date.parse(value);
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateDiskSpace(receipt, findings) {
  const filesystem = receipt?.filesystem;
  const evaluation = filesystem?.disk_space_evaluation;
  if (!evaluation) return;
  timestamp(evaluation.observed_at, "filesystem.disk_space_evaluation.observed_at", findings);
  if (!equalJson(
    [...(evaluation.requested_lanes ?? [])].sort(),
    [...(receipt.requested_lanes ?? [])].sort(),
  )) {
    findings.push({
      path: "filesystem.disk_space_evaluation.requested_lanes",
      code: "DISK_SPACE_REQUESTED_LANES_MISMATCH",
    });
  }
  const workDevice = filesystem?.work_root?.facts?.volume_identity?.device_id;
  const tempDevice = filesystem?.temp_root?.facts?.volume_identity?.device_id;
  const expectedTopology = workDevice && tempDevice && workDevice === tempDevice
    ? "shared_volume"
    : "distinct_volumes";
  if (evaluation.selected_volume_topology !== expectedTopology) {
    findings.push({
      path: "filesystem.disk_space_evaluation.selected_volume_topology",
      code: "DISK_SPACE_TOPOLOGY_MISMATCH",
    });
  }
  for (const rootKind of ["work_root", "temp_root"]) {
    const lane = filesystem?.[rootKind];
    const observation = evaluation?.roots?.[rootKind];
    if (!lane?.facts || !observation) continue;
    const prefix = `filesystem.disk_space_evaluation.roots.${rootKind}`;
    if (!equalJson(observation.volume_identity, lane.facts.volume_identity)) {
      findings.push({ path: `${prefix}.volume_identity`, code: "VOLUME_IDENTITY_MISMATCH" });
    }
    const expectedRequired = expectedTopology === "shared_volume"
      ? evaluation?.required_free_bytes?.shared_volume
      : evaluation?.required_free_bytes?.distinct_volumes?.[rootKind];
    if (observation.required_bytes !== expectedRequired) {
      findings.push({ path: `${prefix}.required_bytes`, code: "REQUIRED_BYTES_MISMATCH" });
    }
    const expectedHeadroom = observation.available_bytes - observation.required_bytes;
    if (observation.headroom_bytes !== expectedHeadroom) {
      findings.push({ path: `${prefix}.headroom_bytes`, code: "HEADROOM_ARITHMETIC_MISMATCH" });
    }
    const expectedStatus = expectedHeadroom >= 0 ? "PASS" : "REFUSED";
    if (observation.status !== expectedStatus) {
      findings.push({ path: `${prefix}.status`, code: "FREE_SPACE_STATUS_MISMATCH" });
    }
  }
  if (
    expectedTopology === "shared_volume" &&
    evaluation?.roots?.work_root?.available_bytes !== evaluation?.roots?.temp_root?.available_bytes
  ) {
    findings.push({
      path: "filesystem.disk_space_evaluation.roots",
      code: "SHARED_VOLUME_AVAILABLE_BYTES_MISMATCH",
    });
  }
}

function validateInlineAuthority(receipt, findings) {
  const probe = receipt?.inline_xbrl;
  if (!probe || probe.status !== "PASS") return;
  const authority = probe.selected_non_dimensioned_authority ?? {};
  const selectedContexts = new Set();
  for (const [concept, facts] of Object.entries(authority)) {
    if (!Array.isArray(facts) || facts.length !== 3) continue;
    const periods = facts.map((fact) => fact.period_end);
    const contexts = facts.map((fact) => fact.context_ref);
    if (new Set(periods).size !== 3 || new Set(contexts).size !== 3) {
      findings.push({
        path: `inline_xbrl.selected_non_dimensioned_authority.${concept}`,
        code: "ANNUAL_AUTHORITY_NOT_UNIQUE",
      });
    }
    for (const context of contexts) selectedContexts.add(context);
  }
  if (Object.keys(authority).length !== 2 || selectedContexts.size !== 3) {
    findings.push({
      path: "inline_xbrl.selected_non_dimensioned_authority",
      code: "IS_CF_THREE_CONTEXT_AUTHORITY_MISMATCH",
    });
  }
  if (selectedContexts.has(probe.quarantined_dimensioned_fact?.context_ref)) {
    findings.push({
      path: "inline_xbrl.quarantined_dimensioned_fact.context_ref",
      code: "DIMENSIONED_CONTEXT_ENTERED_AUTHORITY",
    });
  }
}

function validateCandidateIdentity(receipt, findings) {
  if (receipt?.candidate_slot_ready !== true) return;
  const source = receipt.source_identity ?? {};
  if (source.deployment_status !== "installed_candidate") {
    findings.push({ path: "source_identity.deployment_status", code: "NOT_INACTIVE_CANDIDATE" });
  }
  if (source.active_runtime_code_closure_sha256 !== source.declared_runtime_code_closure_sha256) {
    findings.push({ path: "source_identity.active_runtime_code_closure_sha256", code: "ACTIVE_DECLARED_CLOSURE_MISMATCH" });
  }
  for (const field of [
    "active_runtime_code_closure_sha256", "declared_runtime_code_closure_sha256",
    "complete_package_inventory_sha256", "archive_sha256",
    "release_package_attestation_sha256",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(String(source[field] ?? ""))) {
      findings.push({ path: `source_identity.${field}`, code: "CANDIDATE_IDENTITY_SHA_INVALID" });
    }
  }
  for (const field of ["source_commit", "source_tree"]) {
    if (!/^[a-f0-9]{40}$/.test(String(source[field] ?? ""))) {
      findings.push({ path: `source_identity.${field}`, code: "CANDIDATE_GIT_IDENTITY_INVALID" });
    }
  }
}

export function validateInstalledCapabilityReceiptV13Semantics(
  receipt,
  { now = null } = {},
) {
  if (receipt?.schema_version !== INSTALLED_CAPABILITY_RECEIPT_V13) {
    return Object.freeze({
      status: "LEGACY_NOT_ACTIVATION_ELIGIBLE",
      total_violations: 1,
      findings: Object.freeze([Object.freeze({
        path: "schema_version",
        code: "LEGACY_NOT_ACTIVATION_ELIGIBLE",
      })]),
    });
  }

  const findings = [];
  const freshness = receipt.freshness ?? {};
  const generated = timestamp(freshness.generated_at, "freshness.generated_at", findings);
  const expires = timestamp(freshness.expires_at, "freshness.expires_at", findings);
  const evaluated = timestamp(freshness.evaluated_at, "freshness.evaluated_at", findings);
  timestamp(receipt.generated_at, "generated_at", findings);
  if (freshness.policy !== "activation_transaction") {
    findings.push({ path: "freshness.policy", code: "WRONG_FRESHNESS_POLICY" });
  }
  if (freshness.max_age_seconds !== ACTIVATION_FRESHNESS_MAX_AGE_SECONDS) {
    findings.push({ path: "freshness.max_age_seconds", code: "WRONG_MAX_AGE" });
  }
  if (receipt.generated_at !== freshness.generated_at) {
    findings.push({ path: "freshness.generated_at", code: "TOP_LEVEL_TIMESTAMP_MISMATCH" });
  }
  if (generated !== null && expires !== null &&
      expires - generated !== ACTIVATION_FRESHNESS_MAX_AGE_SECONDS * 1000) {
    findings.push({ path: "freshness.expires_at", code: "EXPIRY_ARITHMETIC_MISMATCH" });
  }
  if (generated !== null && evaluated !== null &&
      generated - evaluated > ACTIVATION_FUTURE_SKEW_SECONDS * 1000) {
    findings.push({ path: "freshness.generated_at", code: "FUTURE_SKEW_EXCEEDED" });
  }
  if (generated !== null && expires !== null && evaluated !== null) {
    const expected = generated - evaluated <= ACTIVATION_FUTURE_SKEW_SECONDS * 1000 &&
      evaluated < expires ? "FRESH" : "EXPIRED";
    if (freshness.status !== expected) {
      findings.push({ path: "freshness.status", code: "FRESHNESS_STATUS_MISMATCH" });
    }
  }
  if (receipt.candidate_slot_ready === true && freshness.status !== "FRESH") {
    findings.push({ path: "candidate_slot_ready", code: "STALE_CANDIDATE_READY" });
  }

  if (now !== null) {
    const observedNow = timestamp(
      now instanceof Date ? now.toISOString() : String(now),
      "validation.now",
      findings,
    );
    if (observedNow !== null && generated !== null &&
        generated - observedNow > ACTIVATION_FUTURE_SKEW_SECONDS * 1000) {
      findings.push({ path: "freshness.generated_at", code: "CURRENT_FUTURE_SKEW_EXCEEDED" });
    }
    if (observedNow !== null && expires !== null && observedNow >= expires) {
      findings.push({ path: "freshness.expires_at", code: "CURRENTLY_EXPIRED" });
    }
  }

  validateDiskSpace(receipt, findings);
  validateInlineAuthority(receipt, findings);
  validateCandidateIdentity(receipt, findings);
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    total_violations: findings.length,
    findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
  });
}

export default { validateInstalledCapabilityReceiptV13Semantics };
