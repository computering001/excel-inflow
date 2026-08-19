#!/usr/bin/env node
/**
 * P6.7 — Runtime doctor suite.
 *
 * Proves, in order:
 *  0. THE RED PROOF. No runtime doctor existed, and the only environment probe
 *     in the system is positioned AFTER the expensive upstream half.
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
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validateJsonSchema } from "./lib/json_schema.mjs";
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
  compileRuntimeDoctorReport,
  resolveDoctorPython,
  runRuntimeDoctor,
  typedCheck,
} from "./lib/runtime_doctor.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
const mutations = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-doctor-tests-"));

try {
  // ------------------------------------------------------------------------
  // 0. RED PROOF — what did not exist, and why the existing probe is too late.
  // ------------------------------------------------------------------------
  const orchestrateSource = await fs.readFile(path.join(HERE, "orchestrate_release.mjs"), "utf8");
  const userFlowSource = await fs.readFile(path.join(HERE, "run_user_flow.mjs"), "utf8");

  // The ONLY environment probe in the system is stage-4-internal.
  check(
    orchestrateSource.includes("async function exactEnvironmentProbe("),
    "the stage-4 environment probe is no longer where the gap report found it",
  );
  const probeDefinition = orchestrateSource.indexOf("async function exactEnvironmentProbe(");
  const probeCallSite = orchestrateSource.indexOf("await exactEnvironmentProbe({");
  const stage4MainStart = orchestrateSource.indexOf("async function main() {");
  check(probeCallSite > stage4MainStart, "the stage-4 probe is not called from stage-4 main");
  check(probeDefinition < probeCallSite, "probe definition/call-site ordering changed");

  // ...and stage 4 is only SPAWNED after the expensive upstream half. Proven by
  // ordering, not by brittle absolute line numbers: the controller compiles the
  // case and replays intake BEFORE it ever spawns the stage that probes.
  const spawnStage4 = userFlowSource.indexOf('"orchestrate_release.mjs"');
  const compileCaseCall = userFlowSource.indexOf("compileCase(");
  const runIntakeCall = userFlowSource.indexOf("runIntake(");
  check(spawnStage4 > 0, "the controller no longer spawns stage 4 by name");
  check(compileCaseCall > 0 && runIntakeCall > 0, "the upstream half is no longer where it was");
  check(
    spawnStage4 > compileCaseCall && spawnStage4 > runIntakeCall,
    "RED PROOF INVALID: stage 4 (the only environment probe) must be spawned AFTER intake " +
    "and case compilation — that ordering is the whole reason a missing precondition was " +
    "discovered forty minutes late",
  );

  // Nothing but this work package's own three files mentions a runtime doctor.
  const scriptEntries = await fs.readdir(HERE);
  const doctorFiles = scriptEntries.filter((entry) => entry.includes("runtime_doctor"));
  check(
    doctorFiles.length === 2 &&
    doctorFiles.includes("run_runtime_doctor.mjs") &&
    doctorFiles.includes("run_runtime_doctor_tests.mjs"),
    "the runtime doctor CLI and suite are not the only doctor entry points in scripts/",
  );
  check(
    !orchestrateSource.includes("runtime_doctor") && !userFlowSource.includes("runtime_doctor"),
    "RED PROOF: at the time this suite was written no controller invoked the doctor; if a " +
    "controller now does, update this pin deliberately rather than letting it rot",
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
    refusedReport.refusal.reason_code_fidelity === "closest_available" &&
    refusedReport.refusal.requested_reason_code === RUNTIME_DOCTOR_REQUESTED_REASON_CODE &&
    !Object.prototype.hasOwnProperty.call(
      registry.reason_codes,
      RUNTIME_DOCTOR_REQUESTED_REASON_CODE,
    ),
    "the reason-code shortfall must be DECLARED: the code actually needed is named and is " +
    "genuinely absent from the sealed registry",
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
      temp_free_space: typedCheck({
        precondition_id: "temp_free_space",
        result: "unknown",
        reason: "no free-space floor is declared anywhere, so nothing can be compared",
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
    () => typedCheck({ precondition_id: "temp_free_space", result: "unknown" }),
    /without a reason/,
  );
  checks += 1;
  assert.throws(
    () => typedCheck({ precondition_id: "temp_free_space", result: "satisfied", reason: "mostly" }),
    /a pass that needs an excuse is not a pass/,
  );
  checks += 1;
  assert.throws(
    () => typedCheck({ precondition_id: "temp_free_space", result: "probably_fine", reason: "x" }),
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
    workRootCheck.detail.run_root_exists === false &&
    workRootCheck.detail.doctor_created_anything === false,
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
    .filter((entry) => entry.startsWith("excel-inflow-doctor-probe-"));
  check(tempEntriesBefore.length === 0, "the temp-root probe left its scratch directory behind");
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
  check(
    cliReport.checks.every((entry) => entry.result !== "satisfied" || entry.reason === null),
    "a real report contains a pass carrying an excuse",
  );
  check(
    cliReport.requested_lanes.length === 1 &&
    cliReport.checks.find((entry) => entry.precondition_id === "soffice_available").result === "not_applicable",
    "requesting only the evidence lane must make the workbook binary not-applicable, not failed",
  );

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
