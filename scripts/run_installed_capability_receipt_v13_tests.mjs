#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateInstalledCapabilityReceiptV13Semantics } from "./lib/installed_capability_receipt_v13.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { declaredSkillVersion } from "./lib/skill_version_declaration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SKILL_VERSION = declaredSkillVersion(ROOT);
const schema = JSON.parse(await fs.readFile(
  path.join(ROOT, "assets", "installed-capability-receipt-v1.3.schema.json"),
  "utf8",
));
const SHA = "a".repeat(64);
const GIT = "b".repeat(40);
const GENERATED = "2026-08-21T10:00:00.000Z";
const EVALUATED = "2026-08-21T10:05:00.000Z";
const EXPIRES = "2026-08-21T11:00:00.000Z";
let checks = 0;
const mutationIds = [
  "source-commit-omitted",
  "source-tree-null",
  "active-closure-null",
  "active-declared-closure-mismatch",
  "production-promoted-not-inactive-candidate",
  "filing-fixture-omitted",
  "work-root-fact-omitted",
  "temp-root-operation-false",
  "work-root-free-space-omitted",
  "temp-root-free-space-omitted",
  "compatibility-contract-hash-omitted",
  "libreoffice-capability-omitted",
  "libreoffice-output-hash-omitted",
  "inline-xbrl-omitted",
  "dimensioned-context-selected",
  "freshness-max-age-widened",
  "freshness-expiry-arithmetic",
  "freshness-future-skew",
  "freshness-currently-expired",
  "freshness-top-level-mismatch",
  "free-space-headroom-arithmetic",
  "free-space-volume-mismatch",
  "legacy-v12-activation",
];
const caught = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function volume(device) {
  return { device_id: device, filesystem_type: "apfs", block_size_bytes: 4096 };
}

function filesystemFacts(purpose, requested, device) {
  const isTemp = purpose === "temp_root";
  return {
    purpose,
    requested_root: requested,
    requested_run_root: isTemp ? null : requested,
    requested_temp_root: isTemp ? requested : null,
    temp_root: isTemp ? requested : null,
    canonical_requested_root: requested,
    nearest_existing_ancestor: requested,
    canonical_probe_parent: requested,
    probe_parent: requested,
    immutable_skill_root: "/installed/excel-inflow",
    outside_immutable_skill_root: true,
    requested_root_existed_before: isTemp,
    requested_root_existed_after: isTemp,
    real_run_directory_created: false,
    volume_identity: volume(device),
    created: true,
    written: true,
    flushed: true,
    closed: true,
    read_back: true,
    bytes_match: true,
    renamed: true,
    statted: true,
    deleted: true,
    cleanup_verified: true,
    probe_payload_bytes: 64,
    probe_payload_sha256: SHA,
    error: null,
  };
}

function diskSpaceRoot(device) {
  return {
    available_bytes: 10_000_000_000,
    required_bytes: 2_000_000_000,
    headroom_bytes: 8_000_000_000,
    status: "PASS",
    volume_identity: volume(device),
  };
}

function diskSpaceEvaluation() {
  return {
    schema_version: "excel-inflow-disk-space-evaluation/1.1",
    status: "PASS",
    mode: "candidate",
    requested_lanes: ["evidence", "workbook"],
    selected_lane: "combined",
    selected_volume_topology: "distinct_volumes",
    observed_at: EVALUATED,
    policy_floor_bytes: {
      distinct_volumes: { work_root: 2_000_000_000, temp_root: 2_000_000_000 },
      shared_volume: 3_000_000_000,
    },
    override_min_free_bytes: null,
    required_free_bytes: {
      distinct_volumes: { work_root: 2_000_000_000, temp_root: 2_000_000_000 },
      shared_volume: 3_000_000_000,
    },
    roots: { work_root: diskSpaceRoot("1"), temp_root: diskSpaceRoot("2") },
    policy_evidence: {
      policy_schema_version: "excel-inflow-disk-space-policy/1.1",
      policy_schema_sha256: SHA,
      policy_sha256: SHA,
      policy_sealed: true,
      measurement_evidence_sha256: SHA,
      measurement_schema_version: "excel-inflow-disk-space-measurement/1.1",
      measurement_schema_sha256: SHA,
      raw_manifest_sha256: {
        sample_receipts: SHA, filings: SHA, brokers: SHA, workbook: SHA,
      },
    },
    total_violations: 0,
    findings: [],
  };
}

function authority(values) {
  return [
    { context_ref: "D2023", period_end: "2023-12-31", unit_ref: "usd", value: values[0] },
    { context_ref: "D2024", period_end: "2024-12-31", unit_ref: "usd", value: values[1] },
    { context_ref: "D2025", period_end: "2025-12-31", unit_ref: "usd", value: values[2] },
  ];
}

function specimen() {
  return {
    schema_version: "excel-inflow-installed-capability-receipt/1.3",
    status: "HOST_READY",
    readiness_scope: "inactive_candidate_slot_only",
    candidate_slot_ready: true,
    candidate_slot_refusal_reason: null,
    production_promotion_eligible: false,
    production_promotion_refusal_reason: "Candidate-slot capability is not production promotion.",
    generated_at: GENERATED,
    requested_lanes: ["evidence", "workbook"],
    host: { platform: "darwin", architecture: "arm64" },
    source_identity: {
      repository: "owner/repository",
      source_commit: GIT,
      source_tree: GIT,
      source_worktree_dirty: false,
      skill_version: SKILL_VERSION,
      package_mode: "development",
      deployment_status: "installed_candidate",
      closure_check_status: "match",
      active_runtime_code_closure_sha256: SHA,
      declared_runtime_code_closure_sha256: SHA,
      complete_package_inventory_sha256: SHA,
      archive_sha256: SHA,
      release_package_attestation_sha256: SHA,
      installation_identity: "installed-candidate:test",
    },
    node: { executable: "/runtime/node", executable_sha256: SHA, version: "v22.23.2" },
    python: {
      executable: "/runtime/python", executable_sha256: SHA, version: [3, 9, 6],
      required_modules: ["lxml", "openpyxl"], per_module: { lxml: true, openpyxl: true },
      module_versions: { lxml: "6.1.1", openpyxl: "3.1.5" },
    },
    workbook: {
      soffice_executable: "/runtime/soffice", soffice_executable_sha256: SHA,
      soffice_version: "LibreOffice 26.2.5.2",
      functional_capability: {
        schema_version: "libreoffice-workbook-capability/1.0", status: "PASS",
        fixture: { sha256: SHA }, output: { sha256: SHA, cached_result: 12.5 },
        cleanup: {
          profile_removed: true, fixture_removed: true, output_removed: true,
          workspace_removed: true, residue_paths: [],
        },
      },
    },
    runtime_compatibility: {
      contract_schema_version: "excel-inflow-runtime-compatibility/1.0",
      contract_sha256: SHA,
      status: "PASS",
      total_violations: 0,
      evaluated_runtime_names: ["Node", "Python", "lxml", "openpyxl", "LibreOffice"],
      observations: { Node: { version: "v22.23.2" } },
      findings: [],
    },
    process_spawn: "PASS",
    mandatory_filings_probe: {
      fixture_sha256: SHA, pdf_sha256: SHA, extractor_sha256: SHA, request_sha256: SHA,
      response_sha256: SHA, response_schema_sha256: SHA, semantic_projection_sha256: SHA,
      filings_controller_sha256: SHA, filings_state_sha256: SHA, filings_bundle_sha256: SHA,
      runtime_closure_sha256: SHA, scratch_removed: true,
    },
    inline_xbrl: {
      schema_version: "excel-inflow-installed-inline-xbrl-probe/1.0", status: "PASS", reason_code: null,
      selected_python: "/runtime/python", lxml_worker_execution: "PASS", timeout_ms: 10000, duration_ms: 100,
      fixture_sha256: SHA, html_sha256: SHA, worker_sha256: SHA, result_schema_sha256: SHA,
      selected_python_sha256: SHA, result_sha256: SHA, fact_count: 7, context_count: 4, unit_count: 1,
      selected_non_dimensioned_authority: {
        "probe:Revenue": authority([100, 110, 120]),
        "probe:CashFromOperations": authority([20, 22, 25]),
      },
      quarantined_dimensioned_fact: {
        concept: "probe:Revenue", context_ref: "DSEG2025",
        dimensions: { "probe:SegmentAxis": "probe:ContradictorySegmentMember" }, value: 999,
      },
      scratch_removed: true,
    },
    filesystem: {
      work_root: { result: "satisfied", facts: filesystemFacts("run_root", "/runs/company", "1") },
      temp_root: { result: "satisfied", facts: filesystemFacts("temp_root", "/runtime/temp", "2") },
      disk_space_evaluation: diskSpaceEvaluation(),
    },
    freshness: {
      policy: "activation_transaction", max_age_seconds: 3600,
      generated_at: GENERATED, expires_at: EXPIRES, evaluated_at: EVALUATED, status: "FRESH",
    },
    runtime_doctor_sha256: SHA,
    receipt_sha256: SHA,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function evaluate(value, now = EVALUATED) {
  const structural = validateJsonSchema(value, schema);
  const semantic = validateInstalledCapabilityReceiptV13Semantics(value, { now });
  return { structural, semantic };
}

function mutation(id, mutate, { now = EVALUATED, semanticCode = null } = {}) {
  const value = specimen();
  mutate(value);
  const result = evaluate(value, now);
  check(
    result.structural.length > 0 || result.semantic.status !== "PASS",
    `${id} escaped both schema and semantic validation`,
  );
  if (semanticCode !== null) {
    check(
      result.semantic.findings.some((finding) => finding.code === semanticCode),
      `${id} did not produce semantic code ${semanticCode}`,
    );
  }
  caught.push(id);
}

const clean = specimen();
const cleanResult = evaluate(clean);
check(cleanResult.structural.length === 0, `clean 1.3 specimen violates schema: ${cleanResult.structural.join("; ")}`);
check(cleanResult.semantic.status === "PASS" && cleanResult.semantic.total_violations === 0, "clean 1.3 semantics failed");
check(schema.properties.schema_version.const.endsWith("/1.3"), "schema asset is not frozen at 1.3");
check(schema.additionalProperties === false, "receipt 1.3 permits undeclared top-level fields");

mutation("source-commit-omitted", (value) => { delete value.source_identity.source_commit; });
mutation("source-tree-null", (value) => { value.source_identity.source_tree = null; });
mutation("active-closure-null", (value) => { value.source_identity.active_runtime_code_closure_sha256 = null; });
mutation("active-declared-closure-mismatch", (value) => {
  value.source_identity.declared_runtime_code_closure_sha256 = "c".repeat(64);
}, { semanticCode: "ACTIVE_DECLARED_CLOSURE_MISMATCH" });
mutation("production-promoted-not-inactive-candidate", (value) => {
  value.source_identity.deployment_status = "production_promoted";
}, { semanticCode: "NOT_INACTIVE_CANDIDATE" });
mutation("filing-fixture-omitted", (value) => { delete value.mandatory_filings_probe.fixture_sha256; });
mutation("work-root-fact-omitted", (value) => { delete value.filesystem.work_root.facts.canonical_requested_root; });
mutation("temp-root-operation-false", (value) => { value.filesystem.temp_root.facts.bytes_match = false; });
mutation("work-root-free-space-omitted", (value) => { delete value.filesystem.disk_space_evaluation.roots.work_root; });
mutation("temp-root-free-space-omitted", (value) => { delete value.filesystem.disk_space_evaluation.roots.temp_root; });
mutation("compatibility-contract-hash-omitted", (value) => { delete value.runtime_compatibility.contract_sha256; });
mutation("libreoffice-capability-omitted", (value) => { value.workbook.functional_capability = null; });
mutation("libreoffice-output-hash-omitted", (value) => { delete value.workbook.functional_capability.output.sha256; });
mutation("inline-xbrl-omitted", (value) => { value.inline_xbrl = null; });
mutation("dimensioned-context-selected", (value) => {
  value.inline_xbrl.quarantined_dimensioned_fact.context_ref = "D2025";
}, { semanticCode: "DIMENSIONED_CONTEXT_ENTERED_AUTHORITY" });
mutation("freshness-max-age-widened", (value) => { value.freshness.max_age_seconds = 7200; }, { semanticCode: "WRONG_MAX_AGE" });
mutation("freshness-expiry-arithmetic", (value) => {
  value.freshness.expires_at = "2026-08-21T11:00:01.000Z";
}, { semanticCode: "EXPIRY_ARITHMETIC_MISMATCH" });
mutation("freshness-future-skew", (value) => {
  value.generated_at = "2026-08-21T10:06:00.000Z";
  value.freshness.generated_at = value.generated_at;
  value.freshness.expires_at = "2026-08-21T11:06:00.000Z";
  value.freshness.evaluated_at = "2026-08-21T10:00:00.000Z";
}, { now: "2026-08-21T10:00:00.000Z", semanticCode: "FUTURE_SKEW_EXCEEDED" });
mutation("freshness-currently-expired", () => {}, {
  now: "2026-08-21T11:00:00.000Z", semanticCode: "CURRENTLY_EXPIRED",
});
mutation("freshness-top-level-mismatch", (value) => {
  value.generated_at = "2026-08-21T10:00:01.000Z";
}, { semanticCode: "TOP_LEVEL_TIMESTAMP_MISMATCH" });
mutation("free-space-headroom-arithmetic", (value) => {
  value.filesystem.disk_space_evaluation.roots.work_root.headroom_bytes += 1;
}, { semanticCode: "HEADROOM_ARITHMETIC_MISMATCH" });
mutation("free-space-volume-mismatch", (value) => {
  value.filesystem.disk_space_evaluation.roots.temp_root.volume_identity.device_id = "different";
}, { semanticCode: "VOLUME_IDENTITY_MISMATCH" });
mutation("legacy-v12-activation", (value) => {
  value.schema_version = "excel-inflow-installed-capability-receipt/1.2";
}, { semanticCode: "LEGACY_NOT_ACTIVATION_ELIGIBLE" });

const skewBoundary = clone(clean);
skewBoundary.generated_at = "2026-08-21T10:05:00.000Z";
skewBoundary.freshness.generated_at = skewBoundary.generated_at;
skewBoundary.freshness.expires_at = "2026-08-21T11:05:00.000Z";
skewBoundary.freshness.evaluated_at = "2026-08-21T10:00:00.000Z";
const boundary = evaluate(skewBoundary, "2026-08-21T10:00:00.000Z");
check(boundary.structural.length === 0 && boundary.semantic.status === "PASS", "exact five-minute future skew was rejected");

check(caught.length === mutationIds.length, "not every declared 1.3 mutation executed");
check(caught.every((id, index) => id === mutationIds[index]), "1.3 mutation order drifted");
process.stdout.write(`${JSON.stringify({
  status: "PASS",
  checks,
  schema_version: schema.properties.schema_version.const,
  mutations_declared: mutationIds.length,
  mutations_applied: caught.length,
  mutations_caught: caught.length,
  mutations_survived: mutationIds.length - caught.length,
  mutation_ids: caught,
  legacy_v12: "LEGACY_NOT_ACTIVATION_ELIGIBLE",
  freshness: {
    policy: "activation_transaction",
    max_age_seconds: 3600,
    future_skew_seconds_inclusive: 300,
  },
})}\n`);
