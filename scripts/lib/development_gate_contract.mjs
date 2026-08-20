import { createHash } from "node:crypto";

export const CUSTODY_INPUTS = Object.freeze([
  "BROKER_CORPUS",
  "BROKER_REAL_PACK_MANIFEST",
  "FIXED_POINT_CASES_MANIFEST",
  "INSTALLED_HOST_BROKER_RECEIPT",
  "RAW_CANARY_EVIDENCE",
  "REAL_FILING_CORPUS_MANIFEST",
  "REAL_FILINGS_EXPECTATIONS",
  "REAL_FILINGS_REQUEST",
]);

const CUSTODY_INPUT_SET = new Set(CUSTODY_INPUTS);
export const DEVELOPMENT_GATE_PROFILES = Object.freeze(["all", "portable", "custody"]);

export function effectiveTestTimeoutMs(test, overrideMs = null) {
  const declaredSeconds = Number(test?.timeout_seconds);
  if (!Number.isInteger(declaredSeconds) || declaredSeconds < 1) {
    throw new Error(`Registry test ${test?.id ?? "<unknown>"} has an invalid timeout_seconds.`);
  }
  if (overrideMs === null || overrideMs === undefined) return declaredSeconds * 1000;
  const numericOverride = Number(overrideMs);
  if (!Number.isInteger(numericOverride) || numericOverride < 1000) {
    throw new Error("--timeout-ms must be an integer of at least 1000.");
  }
  return numericOverride;
}

export function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function testProfile(test) {
  return (test.requires ?? []).some((name) => CUSTODY_INPUT_SET.has(name))
    ? "custody"
    : "portable";
}

export function effectiveTestMetadata(registry, test) {
  const contract = registry.metadata_contract;
  if (!contract || contract.schema_version !== "development-test-metadata/1.0") {
    throw new Error("Registry metadata contract is absent or unsupported.");
  }
  const owner = contract.owner_by_phase?.[test.phase];
  const declaredTestClass = test.test_class;
  const auditClass = contract.audit_class_by_test_class?.[declaredTestClass];
  if (!owner) throw new Error(`Registry test ${test.id} has no owner for phase ${test.phase}.`);
  if (!declaredTestClass || !auditClass) {
    throw new Error(`Registry test ${test.id} has no canonical test-class mapping.`);
  }
  if (!contract.allowed_audit_classes?.includes(auditClass)) {
    throw new Error(`Registry test ${test.id} resolves to disallowed audit class ${auditClass}.`);
  }
  for (const [status, exitCode] of Object.entries({ PASS: 0, FAIL: 1, BLOCKED: 1 })) {
    if (contract.expected_exit_contract?.[status] !== exitCode) {
      throw new Error(`Registry expected-exit contract for ${status} must be ${exitCode}.`);
    }
  }
  return canonical({
    owner,
    declared_test_class: declaredTestClass,
    audit_class: auditClass,
    expected_exit_contract: contract.expected_exit_contract,
  });
}

export function selectRegistryTests(registry, { profile = "all", phases = null } = {}) {
  if (!DEVELOPMENT_GATE_PROFILES.includes(profile)) {
    throw new Error(`Unknown development-gate profile ${profile}.`);
  }
  const phaseSet = phases ? new Set(phases) : null;
  return registry.tests.filter((test) =>
    (!phaseSet || phaseSet.has(test.phase)) &&
    (profile === "all" || testProfile(test) === profile));
}

export function testIdSetSha256(tests) {
  return sha256Text(`${tests.map((test) => test.id).sort().join("\n")}\n`);
}

/**
 * Prove that every registry argument names an input the runner can actually
 * resolve.  This is deliberately performed before the pool starts: a typo in
 * the final registry row must not masquerade as a nearly-complete gate run.
 */
export function validateRegistryInvocationContract(
  tests,
  availableSources,
) {
  const available = new Set(availableSources ?? []);
  const errors = [];
  for (const test of tests ?? []) {
    for (const requirement of test.requires ?? []) {
      if (!available.has(requirement)) {
        errors.push(`${test.id}: unknown required source ${requirement}`);
      }
    }
    for (const [index, argument] of (test.arguments ?? []).entries()) {
      const structured = argument && typeof argument === "object" && !Array.isArray(argument);
      if (structured && !["directory", "executable", "file", "literal"].includes(argument.type)) {
        errors.push(`${test.id}: argument ${index} has unknown type ${String(argument.type)}`);
        continue;
      }
      if (structured && argument.type === "literal" && argument.value === undefined) {
        errors.push(`${test.id}: literal argument ${index} has no value`);
        continue;
      }
      if (structured && argument.type !== "literal" && !argument.source) {
        errors.push(`${test.id}: argument ${index} has no source`);
        continue;
      }
      const source = structured
        ? argument.type === "literal" ? null : argument.source
        : /^\$([A-Z_]+)$/.exec(String(argument))?.[1] ?? null;
      if (source && !available.has(source)) {
        errors.push(`${test.id}: argument ${index} names unknown source ${source}`);
      }
    }
  }
  return errors;
}

export function aggregateGateReports({ registry, registrySha256, profile, reports }) {
  const errors = [];
  if (!DEVELOPMENT_GATE_PROFILES.includes(profile)) {
    errors.push(`Unknown aggregate profile ${profile}.`);
  }
  if (!Array.isArray(reports) || reports.length === 0) {
    errors.push("At least one development-gate report is required.");
  }

  const expectedTests = errors.length === 0
    ? selectRegistryTests(registry, { profile })
    : [];
  const expectedIds = expectedTests.map((test) => test.id).sort();
  const expectedSet = new Set(expectedIds);
  const seen = new Map();
  let sourceCommit = null;
  const failed = [];

  for (const [reportIndex, report] of (reports ?? []).entries()) {
    if (report?.schema_version !== "development-gate-report/2.0") {
      errors.push(`Report ${reportIndex} has the wrong schema version.`);
      continue;
    }
    if (report.registry?.sha256 !== registrySha256) {
      errors.push(`Report ${reportIndex} is bound to a different registry hash.`);
    }
    if (!report.source?.commit) {
      errors.push(`Report ${reportIndex} has no source commit.`);
    } else if (sourceCommit === null) {
      sourceCommit = report.source.commit;
    } else if (report.source.commit !== sourceCommit) {
      errors.push(`Report ${reportIndex} is bound to a different source commit.`);
    }
    if (report.source?.worktree_dirty === true) {
      errors.push(`Report ${reportIndex} was produced from a dirty worktree.`);
    }
    if (profile !== "all" && report.selection?.profile !== profile) {
      errors.push(`Report ${reportIndex} has profile ${report.selection?.profile ?? "<missing>"}, expected ${profile}.`);
    }
    if (profile === "all" && !["all", "portable", "custody"].includes(report.selection?.profile)) {
      errors.push(`Report ${reportIndex} has an invalid selection profile.`);
    }

    const reportResults = report.results ?? [];
    const reportSelectionSha256 = testIdSetSha256(reportResults);
    if (report.selection?.selected_test_ids_sha256 !== reportSelectionSha256) {
      errors.push(`Report ${reportIndex} selected-test hash does not match its results.`);
    }

    for (const result of reportResults) {
      if (!expectedSet.has(result.id)) {
        errors.push(`Unexpected test id ${result.id}.`);
        continue;
      }
      if (seen.has(result.id)) {
        errors.push(`Duplicate test id ${result.id}.`);
        continue;
      }
      seen.set(result.id, reportIndex);
      if (result.status !== "PASS") failed.push(result.id);
    }
  }

  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length > 0) errors.push(`Missing test ids: ${missing.join(", ")}.`);

  const result = canonical({
    schema_version: "development-gate-aggregate/1.0",
    profile,
    source_commit: sourceCommit,
    registry_sha256: registrySha256,
    expected_test_count: expectedIds.length,
    observed_test_count: seen.size,
    expected_test_ids_sha256: testIdSetSha256(expectedTests),
    failed_test_ids: [...new Set(failed)].sort(),
    errors,
    status: errors.length === 0 && failed.length === 0 ? "PASS" : "FAIL",
  });
  return result;
}
