#!/usr/bin/env node
/**
 * P6.7 — Runtime doctor suite.
 *
 * Proves, in order:
 *  0. THE CLOSED RED. The runtime doctor is a shipped entry point and the one
 *     top-level controller invokes it before the Company screen and before any
 *     issuer work.
 *  1. Interpreter custody: a poisoned PATH must not change the resolved
 *     interpreter (reusing the same custody functions the run uses, so the
 *     doctor cannot certify one interpreter and the run spawn another).
 *  2. An unsatisfied mandatory precondition REFUSES typed, naming a code that
 *     is registered in the sealed terminal-reason registry and carrying the
 *     registry's five internal-failure payload fields.
 *  3. An excluded installed-host check can never be reported as satisfied —
 *     at the check constructor AND at the report compiler.
 *  4. A check whose result is unknown is never reported as satisfied, and an
 *     unknown MANDATORY precondition refuses exactly like an unsatisfied one.
 *  5. The doctor validates and never repairs: a missing run root is reported,
 *     not created.
 *  6. A real compiled report on this host conforms to
 *     assets/runtime-doctor-report-v1.schema.json, and the standalone CLI
 *     exit code matches its own verdict.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import { probePhysicalFilesystem } from "./lib/filesystem_probe.mjs";
import { resolvePythonExecutable } from "./lib/process_tree.mjs";
import {
  PRECONDITION_DECLARATIONS,
  PRECONDITION_IDS,
  RUNTIME_DOCTOR_LANES,
  RUNTIME_DOCTOR_REASON_CODE,
  RUNTIME_DOCTOR_REQUESTED_REASON_CODE,
  RUNTIME_DOCTOR_RESULTS,
  RUNTIME_DOCTOR_SCHEMA_VERSION,
  RuntimeDoctorRefusal,
  assertRuntimeDoctorSatisfied,
  compileInstalledCapabilityReceipt,
  compileRuntimeDoctorReport,
  installedCapabilityReceiptDigest,
  resolveDoctorPython,
  runRuntimeDoctor,
  selectDiskSpacePolicyAuthority,
  typedCheck,
  writeInstalledCapabilityArtifactSet,
} from "./lib/runtime_doctor.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
const mutations = [];
const EXPECTED_MUTATION_IDS = Object.freeze([
  "poisoned_path_did_not_replace_resolved_interpreter",
  "bare_relative_python_override_rejected_by_doctor",
  "silently_skipped_precondition_rejected",
  "unsatisfied_mandatory_precondition_refused_typed",
  "mandatory_precondition_not_excusable_while_its_lane_is_requested",
  "excluded_installed_host_check_never_reported_satisfied",
  "unknown_result_never_reported_satisfied",
  "canonical_symlink_into_skill_refused",
  "physical_probe_write_failure_refused",
  "physical_probe_read_failure_refused",
  "physical_probe_rename_failure_refused",
  "physical_probe_cleanup_failure_refused",
  "one_volume_only_failure_remained_independent",
  "durable_doctor_crash_after_alias_kept_prior_pointer",
  "durable_doctor_crash_after_report_kept_prior_pointer",
  "durable_doctor_crash_after_receipt_kept_prior_pointer",
  "durable_doctor_crash_before_pointer_kept_prior_pointer",
  "out_of_range_runtime_prevents_real_evidence_probes",
  "aggregate_probe_lease_exhaustion_prevents_subordinates",
  "broken_preflight_cannot_emit_static_company_screen",
]);

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-doctor-tests-"));

try {
  const candidateAuthority = selectDiskSpacePolicyAuthority({
    mode: "candidate",
    skillRoot: ROOT,
    profilePolicy: { path: "assets/measured-policy.json", sha256: "a".repeat(64) },
    callerPolicyPath: "/tmp/forged-lower-policy.json",
    callerPolicySha256: "b".repeat(64),
    env: {
      EXCEL_INFLOW_DISK_SPACE_POLICY: "/tmp/env-forged-policy.json",
      EXCEL_INFLOW_DISK_SPACE_POLICY_SHA256: "c".repeat(64),
    },
  });
  check(
    candidateAuthority.authority === "deployment_profile_only" &&
      candidateAuthority.policy_path === path.join(ROOT, "assets", "measured-policy.json") &&
      candidateAuthority.expected_policy_sha256 === "a".repeat(64) &&
      candidateAuthority.candidate_override_refused === true,
    "candidate disk-policy authority accepted or preferred a caller/environment override",
  );
  const unmeasuredDevelopmentAuthority = selectDiskSpacePolicyAuthority({
    mode: "development",
    skillRoot: ROOT,
    profilePolicy: null,
    env: {},
  });
  check(
    unmeasuredDevelopmentAuthority.policy_path === null &&
      unmeasuredDevelopmentAuthority.expected_policy_sha256 === null,
    "development without a measured policy invented a path or hash",
  );
  // ------------------------------------------------------------------------
  // 0. CLOSED RED — the preflight now owns the first executable boundary.
  // ------------------------------------------------------------------------
  const orchestrateSource = await fs.readFile(path.join(HERE, "orchestrate_release.mjs"), "utf8");
  const userFlowSource = await fs.readFile(path.join(HERE, "run_user_flow.mjs"), "utf8");

  // The old stage-4 probe remains as a downstream second opinion.
  check(
    orchestrateSource.includes("async function exactEnvironmentProbe("),
    "the stage-4 environment probe is no longer where the gap report found it",
  );
  const probeDefinition = orchestrateSource.indexOf("async function exactEnvironmentProbe(");
  const probeCallSite = orchestrateSource.indexOf("await exactEnvironmentProbe({");
  const stage4MainStart = orchestrateSource.indexOf("async function main() {");
  check(probeCallSite > stage4MainStart, "the stage-4 probe is not called from stage-4 main");
  check(probeDefinition < probeCallSite, "probe definition/call-site ordering changed");

  // ...and stage 4 is still spawned after the upstream half, which is why it
  // cannot substitute for the new pre-interaction doctor.
  const spawnStage4 = userFlowSource.indexOf('"orchestrate_release.mjs"');
  const compileCaseCall = userFlowSource.indexOf("compileCase(");
  const runIntakeCall = userFlowSource.indexOf("runIntake(");
  check(spawnStage4 > 0, "the controller no longer spawns stage 4 by name");
  check(compileCaseCall > 0 && runIntakeCall > 0, "the upstream half is no longer where it was");
  check(
    spawnStage4 > compileCaseCall && spawnStage4 > runIntakeCall,
    "the downstream stage-4 probe unexpectedly moved ahead of intake/case compilation",
  );

  const topControllerSource = await fs.readFile(
    path.join(HERE, "run_excel_inflow_vnext.mjs"),
    "utf8",
  );
  check(
    topControllerSource.includes('from "./lib/runtime_doctor.mjs"') &&
    topControllerSource.includes("runMandatoryHostPreflight({"),
    "the top-level controller does not import and invoke the runtime doctor",
  );
  const companyBranch = topControllerSource.indexOf('String(options.screen) === "company"');
  const companyPreflight = topControllerSource.indexOf("await runMandatoryHostPreflight({", companyBranch);
  const companyScreenSpawn = topControllerSource.indexOf("await runUserFlow(screenArgs", companyBranch);
  const bootstrapHandoffConsume = topControllerSource.indexOf("await consumeControllerHandoff({");
  check(
    bootstrapHandoffConsume > 0 && bootstrapHandoffConsume < companyBranch &&
      companyBranch > 0 && companyPreflight > companyBranch && companyPreflight < companyScreenSpawn,
    "the Company route is not ordered bootstrap handoff -> mandatory host preflight -> private screen delegate",
  );
  const runOutGuard = topControllerSource.indexOf("if (out === ROOT");
  const runPreflight = topControllerSource.indexOf("const hostPreflight = await runMandatoryHostPreflight", runOutGuard);
  const clockOpen = topControllerSource.indexOf("ACTIVE_RUN_DEADLINE = await openRunDeadline", runOutGuard);
  const issuerAttachmentWork = topControllerSource.indexOf('if (options["attachment-spec"])', runPreflight);
  check(
    clockOpen > runOutGuard && clockOpen < runPreflight &&
      issuerAttachmentWork > runPreflight,
    "the one run clock must include host preflight while issuer work remains downstream of it",
  );
  check(
    !orchestrateSource.includes("runtime_doctor") &&
      !userFlowSource.includes("runRuntimeDoctor(") &&
      !userFlowSource.includes("compileInstalledCapabilityReceipt("),
    "a second controller now owns runtime-doctor policy; keep one top-level owner",
  );

  // ------------------------------------------------------------------------
  // 1. MUTATION — a poisoned PATH must not change the resolved interpreter.
  // ------------------------------------------------------------------------
  const trueResolved = await resolvePythonExecutable(
    process.env.EXCEL_INFLOW_TEST_PYTHON ?? process.env.PYTHON ?? "python3",
  );
  check(path.isAbsolute(trueResolved), "the baseline Python did not resolve absolutely");

  const poisonBin = path.join(scratch, "poison-bin");
  await fs.mkdir(poisonBin);
  const poisonPython = path.join(poisonBin, "python3");
  await fs.writeFile(poisonPython, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const poisonedEnv = {
    ...process.env,
    PATH: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}`,
    PYTHON: poisonPython,
    EXCEL_INFLOW_PYTHON: trueResolved,
  };

  const custody = await resolveDoctorPython({ env: poisonedEnv });
  check(
    custody.resolved === trueResolved,
    "MUTATION FAILED: a poisoned PATH replaced the resolved interpreter selection",
  );
  check(
    custody.resolved !== poisonPython,
    "MUTATION FAILED: the doctor resolved the poison binary",
  );
  mutations.push("poisoned_path_did_not_replace_resolved_interpreter");

  // The custody discipline survives an END-TO-END doctor run under the poisoned
  // environment: the certified interpreter is the resolved one, not PATH's.
  const poisonedReport = await runRuntimeDoctor({
    skillRoot: ROOT,
    env: poisonedEnv,
    lanes: ["evidence"],
    runRoot: path.join(scratch, "poisoned-run"),
  });
  const custodyCheck = poisonedReport.checks.find(
    (entry) => entry.precondition_id === "python_interpreter_custody",
  );
  check(
    custodyCheck.result === "satisfied" &&
    custodyCheck.detail.resolved_executable === trueResolved,
    "MUTATION FAILED: an end-to-end doctor run under a poisoned PATH certified the wrong interpreter",
  );
  check(
    custodyCheck.detail.resolved_absolute === true,
    "the doctor certified a non-absolute interpreter",
  );
  // A bare relative EXCEL_INFLOW_PYTHON is refused by the shared custody guard.
  await assert.rejects(
    () => resolveDoctorPython({ env: { EXCEL_INFLOW_PYTHON: "python3" } }),
    /resolved absolute executable/,
  );
  checks += 1;
  mutations.push("bare_relative_python_override_rejected_by_doctor");

  // ------------------------------------------------------------------------
  // Fixture: a full set of typed checks in which everything passes.
  // ------------------------------------------------------------------------
  function satisfiedSet(overrides = {}) {
    return PRECONDITION_IDS.map((id) => {
      if (overrides[id]) return overrides[id];
      const declaration = PRECONDITION_DECLARATIONS[id];
      if (declaration.obligation === "excluded_installed_host") {
        return typedCheck({
          precondition_id: id,
          result: "excluded_installed_host",
          reason: declaration.exclusion_reason,
        });
      }
      return typedCheck({ precondition_id: id, result: "satisfied" });
    });
  }

  const host = {
    platform: "test",
    architecture: "test",
    node_version: process.version,
    cpu_count: 1,
    total_memory_bytes: 1,
    hostname_sha256: null,
  };

  const greenReport = compileRuntimeDoctorReport({
    checks: satisfiedSet(),
    host,
    lanes: RUNTIME_DOCTOR_LANES,
    runRoot: path.join(scratch, "green"),
  });
  check(greenReport.verdict === "HOST_READY", "an all-satisfied host must be HOST_READY");
  check(greenReport.refusal === null, "a ready host must carry no refusal");
  check(greenReport.report_only === true, "the report must declare itself report-only");
  check(greenReport.performed_expensive_work === false, "the doctor must declare it did no expensive work");
  check(greenReport.repaired_host === false, "the doctor must declare it repaired nothing");
  check(greenReport.schema_version === RUNTIME_DOCTOR_SCHEMA_VERSION, "report schema version");
  check(
    greenReport.checks.length === PRECONDITION_IDS.length,
    "every declared precondition must appear in the report",
  );
  check(
    assertRuntimeDoctorSatisfied(greenReport) === greenReport,
    "a ready host must pass the assertion unchanged",
  );

  // Closure: a precondition may not be silently skipped.
  assert.throws(
    () => compileRuntimeDoctorReport({
      checks: satisfiedSet().slice(1),
      host,
      lanes: RUNTIME_DOCTOR_LANES,
    }),
    /did not report on/,
  );
  checks += 1;
  mutations.push("silently_skipped_precondition_rejected");

  // ...nor reported twice.
  assert.throws(
    () => compileRuntimeDoctorReport({
      checks: [...satisfiedSet(), typedCheck({ precondition_id: PRECONDITION_IDS[0], result: "satisfied" })],
      host,
      lanes: RUNTIME_DOCTOR_LANES,
    }),
    /was reported twice/,
  );
  checks += 1;

  // ------------------------------------------------------------------------
  // 2. MUTATION — an unsatisfied mandatory precondition must refuse TYPED.
  // ------------------------------------------------------------------------
  const registry = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"),
  );
  const refusedReport = compileRuntimeDoctorReport({
    checks: satisfiedSet({
      soffice_available: typedCheck({
        precondition_id: "soffice_available",
        result: "unsatisfied",
        reason: "no LibreOffice binary answered a version probe",
      }),
    }),
    host,
    lanes: RUNTIME_DOCTOR_LANES,
    sourceHashes: { active_runtime_code_closure_sha256: "a".repeat(64) },
  });
  check(refusedReport.verdict === "REFUSED", "MUTATION FAILED: an unsatisfied mandatory precondition did not refuse");
  check(refusedReport.refusal !== null, "a refusal verdict must carry a refusal payload");
  check(
    refusedReport.refusal.reason_code === RUNTIME_DOCTOR_REASON_CODE,
    "the refusal must name the chosen reason code",
  );
  check(
    Object.prototype.hasOwnProperty.call(registry.reason_codes, refusedReport.refusal.reason_code),
    "MUTATION FAILED: the refusal names a code that is NOT registered in the sealed registry",
  );
  const registryEntry = registry.reason_codes[refusedReport.refusal.reason_code];
  check(
    registryEntry.allowed_terminal_states.includes(refusedReport.refusal.terminal_state),
    "the refusal's terminal state is not allowed for the reason code it names",
  );
  for (const field of registry.internal_failure_payload_requirements) {
    check(
      Object.prototype.hasOwnProperty.call(refusedReport.refusal, field),
      `the refusal payload lacks the registry-required field ${field}`,
    );
  }
  check(
    refusedReport.refusal.downstream_invalidation_scope === "no_work_started" &&
    refusedReport.refusal.resumable_checkpoint_path === null,
    "a pre-flight refusal must say honestly that no work started and invent no checkpoint",
  );
  check(
    refusedReport.refusal.reason_code_fidelity === "exact" &&
    refusedReport.refusal.requested_reason_code === RUNTIME_DOCTOR_REQUESTED_REASON_CODE &&
    Object.prototype.hasOwnProperty.call(
      registry.reason_codes,
      RUNTIME_DOCTOR_REQUESTED_REASON_CODE,
    ),
    "the host refusal must use the exact registered runtime-governance reason code",
  );
  check(
    refusedReport.refusal.unsatisfied_preconditions.length === 1 &&
    refusedReport.refusal.unsatisfied_preconditions[0].precondition_id === "soffice_available",
    "the refusal must name the precondition that caused it",
  );
  let thrown = null;
  try {
    assertRuntimeDoctorSatisfied(refusedReport);
  } catch (error) {
    thrown = error;
  }
  check(thrown instanceof RuntimeDoctorRefusal, "a refused host must throw the typed refusal");
  check(
    thrown.typed_internal_outcome.reason_code === RUNTIME_DOCTOR_REASON_CODE &&
    thrown.runtime_doctor_report === refusedReport,
    "the refusal must throw a TYPED outcome carrying its report, not a bare Error",
  );
  mutations.push("unsatisfied_mandatory_precondition_refused_typed");

  // The same unsatisfied precondition on an OPTIONAL obligation must NOT refuse.
  const advisoryReport = compileRuntimeDoctorReport({
    checks: satisfiedSet({
      workbook_font_metrics: typedCheck({
        precondition_id: "workbook_font_metrics",
        result: "unsatisfied",
        reason: "no metric-compatible font file was locatable",
      }),
    }),
    host,
    lanes: RUNTIME_DOCTOR_LANES,
  });
  check(
    advisoryReport.verdict === "HOST_READY" &&
    advisoryReport.advisory_preconditions.length === 1,
    "an unsatisfied OPTIONAL precondition must degrade to advisory, never refuse",
  );

  // A mandatory precondition may be excused not_applicable ONLY when its lane
  // was not requested — never while that lane is in play.
  const laneSkipped = compileRuntimeDoctorReport({
    checks: satisfiedSet({
      soffice_available: typedCheck({
        precondition_id: "soffice_available",
        result: "not_applicable",
        reason: "the workbook lane was not requested",
      }),
      workbook_font_metrics: typedCheck({
        precondition_id: "workbook_font_metrics",
        result: "not_applicable",
        reason: "the workbook lane was not requested",
      }),
    }),
    host,
    lanes: ["evidence"],
  });
  check(laneSkipped.verdict === "HOST_READY", "a lane that was not requested must not refuse");
  assert.throws(
    () => compileRuntimeDoctorReport({
      checks: satisfiedSet({
        soffice_available: typedCheck({
          precondition_id: "soffice_available",
          result: "not_applicable",
          reason: "pretending the workbook lane is irrelevant while it is requested",
        }),
      }),
      host,
      lanes: ["workbook"],
    }),
    /may not be excused as not_applicable/,
  );
  checks += 1;
  mutations.push("mandatory_precondition_not_excusable_while_its_lane_is_requested");

  // ------------------------------------------------------------------------
  // 3. MUTATION — an excluded installed-host check may never be satisfied.
  // ------------------------------------------------------------------------
  const excludedIds = PRECONDITION_IDS.filter(
    (id) => PRECONDITION_DECLARATIONS[id].obligation === "excluded_installed_host",
  );
  check(excludedIds.length >= 1, "the register declares no installed-host exclusion");
  for (const id of excludedIds) {
    check(
      typeof PRECONDITION_DECLARATIONS[id].exclusion_reason === "string" &&
      PRECONDITION_DECLARATIONS[id].exclusion_reason.length > 0,
      `installed-host exclusion ${id} carries no exclusion reason`,
    );
    check(
      PRECONDITION_DECLARATIONS[id].checked_by === null,
      `installed-host exclusion ${id} claims a check method; it is never attempted`,
    );
    // At the constructor.
    for (const forbidden of ["satisfied", "unsatisfied", "not_applicable", "unknown"]) {
      assert.throws(
        () => typedCheck({ precondition_id: id, result: forbidden, reason: "smuggled" }),
        /declared installed-host exclusion/,
      );
      checks += 1;
    }
    // And again at the compiler, for a hand-built object that bypassed it.
    assert.throws(
      () => compileRuntimeDoctorReport({
        checks: satisfiedSet({
          [id]: {
            precondition_id: id,
            title: PRECONDITION_DECLARATIONS[id].title,
            obligation: "excluded_installed_host",
            lane: "always",
            result: "satisfied",
            reason: null,
            detail: null,
            checked_by: null,
            exclusion_reason: PRECONDITION_DECLARATIONS[id].exclusion_reason,
          },
        }),
        host,
        lanes: RUNTIME_DOCTOR_LANES,
      }),
      /declared installed-host exclusion and\s*was reported as something else|No portable gate may report it as passed/,
    );
    checks += 1;
  }
  // The excluded result belongs ONLY to a declared exclusion.
  assert.throws(
    () => typedCheck({
      precondition_id: "soffice_available",
      result: "excluded_installed_host",
      reason: "pretending a portable check is an installed-host problem",
    }),
    /not a declared installed-host\s*exclusion and may not claim one/,
  );
  checks += 1;
  // Exclusions neither pass nor refuse.
  check(
    greenReport.counts.excluded_installed_host === excludedIds.length &&
    greenReport.counts.satisfied === PRECONDITION_IDS.length - excludedIds.length,
    "an installed-host exclusion was counted as satisfied",
  );
  mutations.push("excluded_installed_host_check_never_reported_satisfied");

  // ------------------------------------------------------------------------
  // 4. MUTATION — an unknown result is never a pass.
  // ------------------------------------------------------------------------
  const unknownReport = compileRuntimeDoctorReport({
    checks: satisfiedSet({
      python_single_interpreter_lane_closure: typedCheck({
        precondition_id: "python_single_interpreter_lane_closure",
        result: "unknown",
        reason: "the resolved interpreter did not complete the capability probe",
      }),
    }),
    host,
    lanes: RUNTIME_DOCTOR_LANES,
  });
  check(
    unknownReport.verdict === "REFUSED",
    "MUTATION FAILED: an UNKNOWN mandatory precondition was rounded up into a pass",
  );
  check(
    unknownReport.counts.satisfied === PRECONDITION_IDS.length - excludedIds.length - 1 &&
    unknownReport.counts.unknown === 1,
    "an unknown result was counted as satisfied",
  );
  check(
    unknownReport.refusal.unsatisfied_preconditions[0].result === "unknown",
    "the refusal must disclose that the blocking precondition was UNKNOWN, not merely failed",
  );
  // An unknown OPTIONAL precondition is advisory only.
  const unknownOptional = compileRuntimeDoctorReport({
    checks: satisfiedSet({
      workbook_font_metrics: typedCheck({
        precondition_id: "workbook_font_metrics",
        result: "unknown",
        reason: "the optional font corroboration was unavailable",
      }),
    }),
    host,
    lanes: RUNTIME_DOCTOR_LANES,
  });
  check(
    unknownOptional.verdict === "HOST_READY" &&
    unknownOptional.advisory_preconditions[0].result === "unknown",
    "an unknown OPTIONAL precondition must be advisory, not blocking",
  );
  // A non-pass without a reason, and a pass WITH one, are both rejected.
  assert.throws(
    () => typedCheck({ precondition_id: "disk_space_policy", result: "unknown" }),
    /without a reason/,
  );
  checks += 1;
  assert.throws(
    () => typedCheck({ precondition_id: "disk_space_policy", result: "satisfied", reason: "mostly" }),
    /a pass that needs an excuse is not a pass/,
  );
  checks += 1;
  assert.throws(
    () => typedCheck({ precondition_id: "disk_space_policy", result: "probably_fine", reason: "x" }),
    /untyped result/,
  );
  checks += 1;
  assert.throws(
    () => typedCheck({ precondition_id: "not_a_real_precondition", result: "satisfied" }),
    /Undeclared runtime-doctor precondition/,
  );
  checks += 1;
  mutations.push("unknown_result_never_reported_satisfied");

  // ------------------------------------------------------------------------
  // 5. VALIDATORS VALIDATE, NEVER REPAIR.
  // ------------------------------------------------------------------------
  const absentRunRoot = path.join(scratch, "does-not-exist", "nor-this", "run");
  const norepairReport = await runRuntimeDoctor({
    skillRoot: ROOT,
    env: process.env,
    lanes: ["evidence"],
    runRoot: absentRunRoot,
  });
  const workRootCheck = norepairReport.checks.find(
    (entry) => entry.precondition_id === "work_root_writable",
  );
  check(
    workRootCheck.result === "satisfied" &&
    workRootCheck.detail.requested_root_existed_before === false &&
    workRootCheck.detail.requested_root_existed_after === false &&
    workRootCheck.detail.real_run_directory_created === false &&
    workRootCheck.detail.created === true &&
    workRootCheck.detail.written === true &&
    workRootCheck.detail.flushed === true &&
    workRootCheck.detail.closed === true &&
    workRootCheck.detail.read_back === true &&
    workRootCheck.detail.bytes_match === true &&
    workRootCheck.detail.renamed === true &&
    workRootCheck.detail.statted === true &&
    workRootCheck.detail.deleted === true &&
    workRootCheck.detail.cleanup_verified === true &&
    typeof workRootCheck.detail.volume_identity?.device_id === "string",
    "the doctor must report a missing run root, not create it",
  );
  check(
    await fs.access(path.join(scratch, "does-not-exist")).then(() => false, () => true),
    "MUTATION FAILED: the doctor created the missing working directory it was asked about",
  );
  // No run root supplied at all => unknown, never satisfied.
  const noRunRoot = await runRuntimeDoctor({ skillRoot: ROOT, env: process.env, lanes: ["evidence"] });
  const noRunRootCheck = noRunRoot.checks.find(
    (entry) => entry.precondition_id === "work_root_writable",
  );
  check(
    noRunRootCheck.result === "unknown" && noRunRoot.verdict === "REFUSED",
    "a run root that was never supplied must be UNKNOWN and must refuse, not pass by default",
  );
  // The temp probe cleans up after itself.
  const tempEntriesBefore = (await fs.readdir(os.tmpdir()))
    .filter((entry) => entry.startsWith(".excel-inflow-filesystem-probe-"));
  check(tempEntriesBefore.length === 0, "the temp-root probe left its scratch directory behind");

  // The path matrix is physical, not a string assertion. Each spelling is
  // probed at the target volume and the runtime modules are imported through a
  // symlink carrying that exact spelling with Node's symlink preservation on.
  const pathMatrix = [
    ["spaces", ["path with spaces"]],
    ["unicode", ["模型-évidence-Δ"]],
    ["literal-percent-encoding", ["literal-%2F-%20-%25"]],
    ["parentheses", ["runtime (candidate)"]],
    ["nested-long", [
      `level-${"a".repeat(48)}`,
      `level-${"b".repeat(48)}`,
      `level-${"c".repeat(48)}`,
      `level-${"d".repeat(48)}`,
    ]],
  ];
  const importProbeSource = [
    "import path from 'node:path'",
    "import {pathToFileURL} from 'node:url'",
    "const root=process.argv[1]",
    "const output=process.argv[2]",
    "await import(pathToFileURL(path.join(root,'scripts/lib/attachment_ingress.mjs')).href)",
    "const doctor=await import(pathToFileURL(path.join(root,'scripts/lib/runtime_doctor.mjs')).href)",
    "if(path.resolve(doctor.RUNTIME_DOCTOR_DEFAULT_SKILL_ROOT)!==path.resolve(root)) throw new Error('runtime doctor decoded the default root incorrectly')",
    "const identity=await import(pathToFileURL(path.join(root,'scripts/lib/source_identity.mjs')).href)",
    "const resolved=await identity.resolveSourceIdentity()",
    "if(!resolved.skill_version) throw new Error('source identity did not resolve from the URL-safe default root')",
    "const trace=await import(pathToFileURL(path.join(root,'scripts/lib/experience_trace.mjs')).href)",
    "await trace.writeExperienceTrace(output,{path_probe:true})",
  ].join(";");
  for (const [label, segments] of pathMatrix) {
    const matrixParent = path.join(scratch, "path-matrix", ...segments);
    await fs.mkdir(matrixParent, { recursive: true });
    const proposedRunRoot = path.join(matrixParent, "proposed run", "nested");
    const result = await probePhysicalFilesystem({
      requestedRoot: proposedRunRoot,
      skillRoot: ROOT,
      purpose: "run_root",
    });
    check(result.ok, `${label} path failed the physical run-root probe: ${result.facts.error}`);
    check(
      result.facts.requested_run_root === path.resolve(proposedRunRoot) &&
      result.facts.cleanup_verified === true &&
      result.facts.real_run_directory_created === false,
      `${label} path was decoded, left residue, or created the real run directory`,
    );
    const aliasRoot = path.join(matrixParent, "skill link");
    await fs.symlink(ROOT, aliasRoot, "dir");
    const traceTarget = path.join(matrixParent, "trace output", "trace (proof).json");
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "--preserve-symlinks",
      "--preserve-symlinks-main",
      "-e",
      importProbeSource,
      aliasRoot,
      traceTarget,
    ], { maxBuffer: 16 * 1024 * 1024 });
    check(
      JSON.parse(await fs.readFile(traceTarget, "utf8")).path_probe === true,
      `${label} path failed runtime-module import or trace output-path resolution`,
    );
  }

  // Canonical path security: an apparently external symlink whose nearest
  // existing directory resolves into the immutable skill is refused before a
  // probe directory can be created there.
  const skillSymlink = path.join(scratch, "symlink-into-skill");
  await fs.symlink(path.join(ROOT, "assets"), skillSymlink, "dir");
  const symlinkMutation = await probePhysicalFilesystem({
    requestedRoot: path.join(skillSymlink, "would-be-run"),
    skillRoot: ROOT,
    purpose: "run_root",
  });
  check(
    symlinkMutation.ok === false &&
    symlinkMutation.facts.outside_immutable_skill_root === false &&
    symlinkMutation.facts.created === false,
    "MUTATION FAILED: a symlink into the immutable skill root admitted a physical probe",
  );
  mutations.push("canonical_symlink_into_skill_refused");

  const operationMutations = [
    ["write", { writeSynced: async () => { throw Object.assign(new Error("injected write failure"), { code: "EWRITE" }); } }, "written"],
    ["read", { readFile: async () => { throw Object.assign(new Error("injected read failure"), { code: "EREAD" }); } }, "read_back"],
    ["rename", { rename: async () => { throw Object.assign(new Error("injected rename failure"), { code: "ERENAME" }); } }, "renamed"],
    ["cleanup", { rmdir: async () => { throw Object.assign(new Error("injected cleanup failure"), { code: "ECLEANUP" }); } }, "cleanup_verified"],
  ];
  for (const [name, operations, incompleteField] of operationMutations) {
    let createdProbe = null;
    const observedOperations = {
      ...operations,
      mkdtemp: async (...args) => {
        createdProbe = await fs.mkdtemp(...args);
        return createdProbe;
      },
    };
    const result = await probePhysicalFilesystem({
      requestedRoot: path.join(scratch, "faults", name, "run"),
      skillRoot: ROOT,
      purpose: "run_root",
      operations: observedOperations,
    });
    check(
      result.ok === false && result.facts.error !== null && result.facts[incompleteField] === false,
      `MUTATION FAILED: injected ${name} failure was reported as a completed filesystem probe`,
    );
    check(
      createdProbe === null || await fs.lstat(createdProbe).then(() => false, (error) => error?.code === "ENOENT"),
      `injected ${name} failure left probe residue`,
    );
    mutations.push(`physical_probe_${name}_failure_refused`);
  }

  // A pass on one proposed volume/role is never copied onto the other. The
  // second probe executes independently and can fail alone.
  const independentRunProbe = await probePhysicalFilesystem({
    requestedRoot: path.join(scratch, "volume-run", "run"),
    skillRoot: ROOT,
    purpose: "run_root",
  });
  const independentTempRoot = path.join(scratch, "volume-temp");
  await fs.mkdir(independentTempRoot, { recursive: true });
  const independentTempProbe = await probePhysicalFilesystem({
    requestedRoot: independentTempRoot,
    skillRoot: ROOT,
    purpose: "temp_root",
    operations: {
      rename: async () => { throw Object.assign(new Error("temp-volume-only failure"), { code: "ERENAME" }); },
    },
  });
  check(
    independentRunProbe.ok === true && independentTempProbe.ok === false &&
    independentRunProbe.facts.purpose === "run_root" &&
    independentTempProbe.facts.purpose === "temp_root",
    "MUTATION FAILED: one filesystem result was reused for the other root",
  );
  mutations.push("one_volume_only_failure_remained_independent");
  // The doctor library declares no absolute host path.
  const doctorSource = await fs.readFile(path.join(HERE, "lib", "runtime_doctor.mjs"), "utf8");
  check(
    !/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(doctorSource) &&
    !/["']\/(?:usr|opt|Applications|Library)\//.test(doctorSource),
    "the doctor hardcodes an absolute host path; interpreter and binary locations must come " +
    "from arguments, the environment or PATH resolution",
  );
  check(
    !/\bexecSync\b|\bnpm install\b|\bpip install\b/.test(doctorSource) &&
    !/process\.env\.PATH\s*=/.test(doctorSource),
    "the doctor must never install anything or mutate PATH",
  );

  // ------------------------------------------------------------------------
  // 6. A real report on THIS host conforms to the shipped schema, and the
  //    standalone CLI's exit code matches its own verdict.
  // ------------------------------------------------------------------------
  const schema = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "runtime-doctor-report-v1.schema.json"), "utf8"),
  );
  const capabilitySchema = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "installed-capability-receipt-v1.3.schema.json"), "utf8"),
  );
  const pointerSchema = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "host-preflight-pointer-v1.schema.json"), "utf8"),
  );
  const bootstrapRefusalSchema = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "runtime-bootstrap-refusal-v1.schema.json"), "utf8"),
  );
  for (const report of [greenReport, refusedReport, unknownReport, laneSkipped, norepairReport]) {
    const errors = validateJsonSchema(JSON.parse(JSON.stringify(report)), schema);
    check(errors.length === 0, `a compiled report violated the shipped schema: ${errors.join("; ")}`);
  }
  for (const result of RUNTIME_DOCTOR_RESULTS) {
    check(
      schema.$defs.result.enum.includes(result),
      `the shipped schema does not admit the declared result type ${result}`,
    );
  }

  const cliOut = path.join(scratch, "cli-report.json");
  let cliExit = 0;
  let cliStdout = "";
  try {
    const done = await execFileAsync(process.execPath, [
      path.join(HERE, "run_runtime_doctor.mjs"),
      "--run-root", path.join(scratch, "cli-run"),
      "--lane", "evidence",
      "--out", cliOut,
      "--json",
    ], { maxBuffer: 16 * 1024 * 1024 });
    cliStdout = done.stdout;
  } catch (error) {
    cliExit = error.code ?? -1;
    cliStdout = error.stdout ?? "";
  }
  const cliReport = JSON.parse(cliStdout);
  check(
    validateJsonSchema(cliReport, schema).length === 0,
    "the standalone CLI emitted a report that violates the shipped schema",
  );
  check(
    (cliReport.verdict === "HOST_READY" && cliExit === 0) ||
    (cliReport.verdict === "REFUSED" && cliExit === 1),
    `the CLI exit code (${cliExit}) does not match its own verdict (${cliReport.verdict})`,
  );
  check(
    JSON.parse(await fs.readFile(cliOut, "utf8")).verdict === cliReport.verdict,
    "the CLI's written artifact disagrees with what it printed",
  );
  const cliPointerPath = path.join(path.dirname(cliOut), "host-preflight-current.json");
  const cliPointer = JSON.parse(await fs.readFile(cliPointerPath, "utf8"));
  check(
    validateJsonSchema(cliPointer, pointerSchema).length === 0 &&
      cliPointer.status === "HOST_REFUSED",
    "an evidence-only diagnostic was mislabeled as a full HOST_READY generation",
  );
  const pointedReportBytes = await fs.readFile(path.join(path.dirname(cliOut), cliPointer.report_file));
  const pointedReceiptBytes = await fs.readFile(path.join(path.dirname(cliOut), cliPointer.receipt_file));
  check(
    createHash("sha256").update(pointedReportBytes).digest("hex") === cliPointer.report_sha256,
    "the standalone doctor's pointer does not bind its immutable report bytes",
  );
  check(
    createHash("sha256").update(pointedReceiptBytes).digest("hex") === cliPointer.receipt_sha256,
    "the standalone doctor's pointer does not bind its immutable receipt bytes",
  );
  check(
    JSON.parse(pointedReceiptBytes).receipt_sha256 === cliPointer.receipt_self_sha256,
    "the standalone doctor's pointer does not bind the receipt self-hash",
  );
  check(
    Buffer.compare(pointedReportBytes, await fs.readFile(cliOut)) === 0,
    "the caller-named report alias differs from the pointer-authoritative report",
  );
  check(
    cliReport.checks.every((entry) => entry.result !== "satisfied" || entry.reason === null),
    "a real report contains a pass carrying an excuse",
  );
  check(
    cliReport.requested_lanes.length === 1 &&
    cliReport.checks.find((entry) => entry.precondition_id === "soffice_available").result === "not_applicable",
    "requesting only the evidence lane must make the workbook binary not-applicable, not failed",
  );
  const evidenceLibreOfficeCapability = cliReport.checks.find(
    (entry) => entry.precondition_id === "libreoffice_workbook_capability",
  );
  check(
    evidenceLibreOfficeCapability.result === "not_applicable",
    "requesting only the evidence lane executed or failed the workbook-only LibreOffice capability probe",
  );
  const evidenceCompatibility = cliReport.checks.find(
    (entry) => entry.precondition_id === "runtime_version_compatibility",
  );
  check(
    evidenceCompatibility.result === "satisfied" &&
      evidenceCompatibility.detail.status === "PASS" &&
      evidenceCompatibility.detail.total_violations === 0 &&
      evidenceCompatibility.detail.findings.length === 0,
    "the evidence-only doctor did not close its active runtime compatibility contract",
  );
  check(
    evidenceCompatibility.detail.contract_sha256 === createHash("sha256").update(
      await fs.readFile(path.join(ROOT, "assets", "runtime-compatibility-v1.json")),
    ).digest("hex"),
    "the compatibility result does not bind the exact central contract bytes",
  );
  const measuredDevelopmentDisk = cliReport.checks.find(
    (entry) => entry.precondition_id === "disk_space_policy",
  );
  check(
    measuredDevelopmentDisk.obligation === "mandatory" &&
      measuredDevelopmentDisk.result === "satisfied" &&
      measuredDevelopmentDisk.detail.mode === "development" &&
      measuredDevelopmentDisk.detail.expected_policy_sha256 ===
        "bac34ba378984e705e7baa2c38982860f61993adebd175c89567d9b21dcb95b1" &&
      measuredDevelopmentDisk.detail.evaluation?.status === "PASS" &&
      measuredDevelopmentDisk.detail.evaluation?.policy_evidence?.policy_sealed === true &&
      measuredDevelopmentDisk.detail.evaluation?.policy_evidence?.raw_manifest_sha256
        ?.sample_receipts ===
        "368ee2800363a2bfaec77082a9a0089afc2b4dec0e5c4f657d96f803ebd03a1a",
    "the real measured development disk policy did not close or bind its exact sealed evidence",
  );
  check(
    evidenceCompatibility.detail.observations.PyMuPDF.import_name === "fitz" &&
      evidenceCompatibility.detail.observations.PyMuPDF.distribution_name === "PyMuPDF" &&
      evidenceCompatibility.detail.observations.lxml.import_name === "lxml" &&
      evidenceCompatibility.detail.observations.openpyxl.import_name === "openpyxl" &&
      !evidenceCompatibility.detail.evaluated_runtime_names.includes("LibreOffice") &&
      !evidenceCompatibility.detail.evaluated_runtime_names.includes("Pillow") &&
      !evidenceCompatibility.detail.evaluated_runtime_names.includes("NumPy"),
    "the selected-interpreter evidence observations lost import/distribution identity or evaluated inactive workbook runtimes",
  );
  const inlineXbrlCapability = cliReport.checks.find(
    (entry) => entry.precondition_id === "inline_xbrl_host_probe",
  );
  check(
    inlineXbrlCapability.result === "satisfied" &&
      inlineXbrlCapability.detail.status === "PASS" &&
      inlineXbrlCapability.detail.lxml_worker_execution === "PASS" &&
      inlineXbrlCapability.detail.scratch_removed === true,
    "the real evidence-lane doctor did not execute and clean the installed Inline XBRL worker",
  );
  check(
    [
      "fixture_sha256", "html_sha256", "worker_sha256", "result_schema_sha256",
      "result_sha256", "selected_python_sha256",
    ].every((field) => /^[a-f0-9]{64}$/.test(inlineXbrlCapability.detail[field] ?? "")) &&
      inlineXbrlCapability.detail.selected_python ===
        evidenceCompatibility.detail.observations.Python.executable,
    "the Inline XBRL report did not bind fixture, worker, schema, result and selected Python bytes",
  );
  check(
    Object.keys(inlineXbrlCapability.detail.selected_non_dimensioned_authority).length === 2 &&
      Object.keys(inlineXbrlCapability.detail.quarantined_dimensioned_fact.dimensions).length === 1 &&
      inlineXbrlCapability.detail.quarantined_dimensioned_fact.value === 30000000,
    "the Inline XBRL report lost selected non-dimensioned authority or dimension quarantine",
  );
  check(
    inlineXbrlCapability.detail.compatibility_prerequisite.status === "PASS" &&
      inlineXbrlCapability.detail.compatibility_prerequisite.total_violations === 0 &&
      inlineXbrlCapability.detail.compatibility_prerequisite.evaluated_runtime_names.includes("Python") &&
      inlineXbrlCapability.detail.compatibility_prerequisite.evaluated_runtime_names.includes("lxml"),
    "the Inline XBRL worker did not bind a closed selected Python/lxml compatibility prerequisite",
  );

  // Compatibility is a real execution gate, not a report compiled after the
  // expensive workers have already run. A development-unpinned copy carries
  // an intentionally out-of-range PyMuPDF contract and sentinel replacements
  // for both evidence workers; neither sentinel may execute.
  const incompatibleSkill = path.join(scratch, "incompatible-runtime-skill");
  await fs.cp(ROOT, incompatibleSkill, { recursive: true });
  const incompatibleContractPath = path.join(
    incompatibleSkill,
    "assets",
    "runtime-compatibility-v1.json",
  );
  const incompatibleContract = JSON.parse(await fs.readFile(incompatibleContractPath, "utf8"));
  const pymupdfContract = incompatibleContract.runtimes.find(
    (entry) => entry.runtime_name === "PyMuPDF",
  );
  pymupdfContract.minimum_version = "1.26.4";
  pymupdfContract.maximum_exclusive_version = "1.26.5";
  await fs.writeFile(incompatibleContractPath, `${JSON.stringify(incompatibleContract, null, 2)}\n`);
  const executionSentinel = path.join(scratch, "incompatible-probe-executed");
  await fs.writeFile(
    path.join(incompatibleSkill, "scripts", "run_filings_pipeline.mjs"),
    [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.EXCEL_INFLOW_PROBE_SENTINEL, "filings");',
      "process.exit(86);",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(incompatibleSkill, "scripts", "extract_inline_xbrl.py"),
    [
      "import os, pathlib",
      "pathlib.Path(os.environ['EXCEL_INFLOW_PROBE_SENTINEL']).write_text('xbrl')",
      "raise SystemExit(86)",
      "",
    ].join("\n"),
  );
  const incompatibleReport = await runRuntimeDoctor({
    skillRoot: incompatibleSkill,
    env: {
      ...process.env,
      EXCEL_INFLOW_PYTHON: trueResolved,
      PYTHON: trueResolved,
      EXCEL_INFLOW_PROBE_SENTINEL: executionSentinel,
    },
    lanes: ["evidence"],
    runRoot: path.join(scratch, "incompatible-run"),
    tempRoot: scratch,
  });
  const incompatibleVersion = incompatibleReport.checks.find(
    (entry) => entry.precondition_id === "runtime_version_compatibility",
  );
  const skippedFiling = incompatibleReport.checks.find(
    (entry) => entry.precondition_id === "filings_extraction_probe",
  );
  const skippedXbrl = incompatibleReport.checks.find(
    (entry) => entry.precondition_id === "inline_xbrl_host_probe",
  );
  check(
    incompatibleVersion.result === "unsatisfied" &&
      skippedFiling.result === "unknown" &&
      skippedFiling.detail.subordinate_execution_attempted === false &&
      skippedXbrl.result === "unknown" &&
      skippedXbrl.detail.subordinate_execution_attempted === false &&
      await fs.lstat(executionSentinel).then(() => false, (error) => error?.code === "ENOENT"),
    "MUTATION FAILED: an out-of-range evidence runtime executed a real subordinate probe",
  );
  mutations.push("out_of_range_runtime_prevents_real_evidence_probes");

  const exhaustedLeaseReport = await runRuntimeDoctor({
    skillRoot: ROOT,
    env: { ...process.env, EXCEL_INFLOW_PYTHON: trueResolved, PYTHON: trueResolved },
    lanes: ["evidence"],
    runRoot: path.join(scratch, "exhausted-lease-run"),
    tempRoot: scratch,
    probeTimeoutMs: 1,
  });
  const leaseFiling = exhaustedLeaseReport.checks.find(
    (entry) => entry.precondition_id === "filings_extraction_probe",
  );
  const leaseXbrl = exhaustedLeaseReport.checks.find(
    (entry) => entry.precondition_id === "inline_xbrl_host_probe",
  );
  check(
    leaseFiling.result === "unknown" &&
      leaseFiling.detail.subordinate_execution_attempted === false &&
      leaseXbrl.result === "unknown" &&
      leaseXbrl.detail.subordinate_execution_attempted === false,
    "MUTATION FAILED: the exhausted aggregate host-probe lease launched a subordinate probe",
  );
  mutations.push("aggregate_probe_lease_exhaustion_prevents_subordinates");
  const workbookOnlyReport = await runRuntimeDoctor({
    skillRoot: ROOT,
    env: { ...process.env, EXCEL_INFLOW_PYTHON: trueResolved, PYTHON: trueResolved },
    lanes: ["workbook"],
    runRoot: path.join(scratch, "workbook-only-run"),
  });
  check(
    workbookOnlyReport.checks.find(
      (entry) => entry.precondition_id === "inline_xbrl_host_probe",
    ).result === "not_applicable",
    "a workbook-only preflight executed or failed the evidence-only Inline XBRL probe",
  );

  const capabilityReceipt = compileInstalledCapabilityReceipt(cliReport);
  check(
    capabilityReceipt.schema_version === "excel-inflow-installed-capability-receipt/1.3" &&
      capabilityReceipt.status === "REFUSED" &&
      capabilityReceipt.candidate_slot_ready === false &&
      capabilityReceipt.filesystem.disk_space_evaluation?.status === "PASS" &&
      capabilityReceipt.filesystem.disk_space_evaluation?.mode === "development",
    "the evidence-only development receipt lost its measured disk proof or overclaimed candidate readiness",
  );
  check(
    validateJsonSchema(capabilityReceipt, capabilitySchema).length === 0,
    "the evidence-only installed-capability receipt violated its shipped schema",
  );
  const receiptBody = { ...capabilityReceipt };
  delete receiptBody.receipt_sha256;
  check(
    capabilityReceipt.receipt_sha256 === installedCapabilityReceiptDigest(receiptBody),
    "the candidate-slot receipt is not self-bound to its exact body",
  );
  check(
    capabilityReceipt.inline_xbrl?.result_sha256 ===
      inlineXbrlCapability.detail.result_sha256 &&
      capabilityReceipt.inline_xbrl?.selected_python_sha256 ===
        capabilityReceipt.python.executable_sha256,
    "the installed receipt did not bind the report's Inline XBRL result and selected interpreter",
  );
  const concurrentArtifactRoot = path.join(scratch, "concurrent-artifact-publish");
  const concurrentPublishes = await Promise.all(
    Array.from({ length: 8 }, () => writeInstalledCapabilityArtifactSet({
      artifactDirectory: concurrentArtifactRoot,
      report: cliReport,
    })),
  );
  check(
    new Set(concurrentPublishes.map((entry) => entry.reportPath)).size === 1 &&
      new Set(concurrentPublishes.map((entry) => entry.receiptPath)).size === 1,
    "concurrent publication did not converge on one content-addressed generation",
  );
  const concurrentNames = await fs.readdir(concurrentArtifactRoot);
  check(
    concurrentNames.filter((name) => name.includes(".tmp-")).length === 0,
    "concurrent publication left an incomplete temporary generation",
  );
  const crashArtifactRoot = path.join(scratch, "crash-before-pointer");
  const firstGeneration = await writeInstalledCapabilityArtifactSet({
    artifactDirectory: crashArtifactRoot,
    report: cliReport,
    reportAliasName: "runtime-doctor-report.json",
    receiptAliasName: "installed-capability-receipt.json",
  });
  const pointerBeforeCrash = await fs.readFile(firstGeneration.pointerPath, "utf8");
  const nextReport = structuredClone(cliReport);
  nextReport.generated_at = new Date(Date.parse(cliReport.generated_at) + 1_000).toISOString();
  const doctorStageCrashes = [
    [
      "alias",
      (event) => event.stage === "alias_published" && event.name === "runtime-doctor-report.json",
    ],
    [
      "report",
      (event) => event.stage === "immutable_published" && event.key === "report",
    ],
    [
      "receipt",
      (event) => event.stage === "immutable_published" && event.key === "receipt",
    ],
  ];
  for (const [boundary, shouldCrash] of doctorStageCrashes) {
    let boundaryObserved = false;
    try {
      await writeInstalledCapabilityArtifactSet({
        artifactDirectory: crashArtifactRoot,
        report: nextReport,
        reportAliasName: "runtime-doctor-report.json",
        receiptAliasName: "installed-capability-receipt.json",
        afterStage: async (event) => {
          if (!shouldCrash(event)) return;
          const error = new Error(`injected crash after ${boundary}`);
          error.code = "INJECTED_DOCTOR_STAGE_CRASH";
          throw error;
        },
      });
    } catch (error) {
      boundaryObserved = error.code === "INJECTED_DOCTOR_STAGE_CRASH";
    }
    check(boundaryObserved, `the doctor ${boundary} crash boundary did not execute`);
    check(
      await fs.readFile(firstGeneration.pointerPath, "utf8") === pointerBeforeCrash,
      `a crash after doctor ${boundary} publication exposed a partial generation`,
    );
    check(
      (await fs.readdir(crashArtifactRoot)).every((name) => !name.includes(".tmp-")),
      `a crash after doctor ${boundary} publication left temporary residue`,
    );
    mutations.push(`durable_doctor_crash_after_${boundary}_kept_prior_pointer`);
  }
  let crashObserved = false;
  try {
    await writeInstalledCapabilityArtifactSet({
      artifactDirectory: crashArtifactRoot,
      report: nextReport,
      reportAliasName: "runtime-doctor-report.json",
      receiptAliasName: "installed-capability-receipt.json",
      beforePointer: async () => {
        throw new Error("injected crash before pointer publication");
      },
    });
  } catch (error) {
    crashObserved = String(error?.message).includes("injected crash");
  }
  check(crashObserved, "the pointer-last crash injection did not execute");
  check(
    await fs.readFile(firstGeneration.pointerPath, "utf8") === pointerBeforeCrash,
    "a crash before pointer publication exposed a partial generation",
  );
  mutations.push("durable_doctor_crash_before_pointer_kept_prior_pointer");
  check(
    bootstrapRefusalSchema.properties.reason_code.enum.includes(RUNTIME_DOCTOR_REASON_CODE) &&
      bootstrapRefusalSchema.properties.reason_code.enum.includes("INTERNAL.runtime_bootstrap_failed") &&
      bootstrapRefusalSchema.properties.subordinate_execution_attempted.type === "boolean" &&
      bootstrapRefusalSchema.required.includes("resumable_checkpoint_path") &&
      bootstrapRefusalSchema.required.includes("preserved_source_hashes"),
    "the shipped bootstrap-refusal schema is not bound to the registered runtime reason/payload",
  );
  const refusedArtifactSet = await writeInstalledCapabilityArtifactSet({
    artifactDirectory: path.join(scratch, "ordinary-host-refusal"),
    report: refusedReport,
  });
  check(
    refusedArtifactSet.receipt.status === "REFUSED" &&
      refusedArtifactSet.pointer.status === "HOST_REFUSED" &&
      validateJsonSchema(refusedArtifactSet.pointer, pointerSchema).length === 0,
    "an ordinary host-precondition refusal published a ready or invalid pointer",
  );
  check(
    capabilityReceipt.mandatory_filings_probe?.pdf_sha256 &&
    capabilityReceipt.mandatory_filings_probe?.extractor_sha256 &&
    capabilityReceipt.python.module_versions.fitz &&
    capabilityReceipt.node.executable_sha256 &&
    capabilityReceipt.python.executable_sha256,
    "the host-capability receipt omitted the PDF, extractor, interpreter bytes or PyMuPDF identity",
  );
  const invalidInactiveReceipt = structuredClone(capabilityReceipt);
  invalidInactiveReceipt.candidate_slot_ready = false;
  invalidInactiveReceipt.candidate_slot_refusal_reason = null;
  check(
    validateJsonSchema(invalidInactiveReceipt, capabilitySchema).some(
      (error) => error.includes("candidate_slot_refusal_reason"),
    ),
    "the local schema validator ignored the candidate-slot contract's else branch",
  );
  const invalidActiveReceipt = structuredClone(capabilityReceipt);
  invalidActiveReceipt.candidate_slot_ready = true;
  invalidActiveReceipt.candidate_slot_refusal_reason = null;
  invalidActiveReceipt.source_identity.source_worktree_dirty = true;
  check(
    validateJsonSchema(invalidActiveReceipt, capabilitySchema).some(
      (error) => error.includes("source_worktree_dirty"),
    ),
    "the receipt schema admitted candidate-slot readiness for dirty source bytes",
  );
  const invalidPromotionReceipt = structuredClone(capabilityReceipt);
  invalidPromotionReceipt.production_promotion_eligible = true;
  check(
    validateJsonSchema(invalidPromotionReceipt, capabilitySchema).some(
      (error) => error.includes("production_promotion_eligible"),
    ),
    "the host-capability receipt falsely admitted production promotion without external canaries",
  );

  // A broken preflight may never fall back to the prose Company screen.
  let refusedScreenExit = 0;
  let refusedScreenStdout = "";
  let refusedScreenStderr = "";
  try {
    await execFileAsync(process.execPath, [
      path.join(HERE, "run_excel_inflow_vnext.mjs"),
      "--screen", "company",
      "--python", poisonPython,
    ], {
      env: { ...process.env, EXCEL_INFLOW_PYTHON: poisonPython, PYTHON: poisonPython },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    refusedScreenExit = Number(error.code ?? -1);
    refusedScreenStdout = String(error.stdout ?? "");
    refusedScreenStderr = String(error.stderr ?? "");
  }
  check(refusedScreenExit === 1, "a broken Company-screen preflight did not refuse");
  check(
    !refusedScreenStdout.includes("EXCEL INFLOW") &&
    !refusedScreenStdout.includes("COMPANY"),
    "a static Company screen masked the broken executable route",
  );
  check(
    refusedScreenStderr.includes("INTERNAL_FAILURE"),
    "the broken Company-screen route did not return a typed internal failure",
  );
  mutations.push("broken_preflight_cannot_emit_static_company_screen");

  check(
    new Set(mutations).size === mutations.length,
    "the runtime-doctor mutation census contains duplicate identifiers",
  );
  check(
    JSON.stringify([...mutations].sort()) === JSON.stringify([...EXPECTED_MUTATION_IDS].sort()),
    `the runtime-doctor mutation census drifted: ${JSON.stringify(mutations)}`,
  );
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    mutations_declared: EXPECTED_MUTATION_IDS.length,
    mutations_applied: mutations.length,
    mutations_caught: mutations.length,
    mutations_survived: 0,
    mutation_ids: mutations,
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
