/**
 * P6.7 — Runtime doctor (host pre-flight).
 *
 * Invariant: before expensive work begins, a runtime doctor verifies that THIS
 * host can actually complete a run. Every declared precondition is checked,
 * each result is TYPED (satisfied / unsatisfied / not-applicable-with-reason /
 * unknown-with-reason / excluded-installed-host), and an unsatisfied mandatory
 * precondition produces a TYPED REFUSAL naming a registered reason code —
 * rather than a failure discovered forty minutes later.
 *
 * The failure this closes: the only environment probe in the system is
 * stage-4-internal (`exactEnvironmentProbe`, scripts/orchestrate_release.mjs
 * :262, called at :602). Stage 4 is spawned from the user-flow controller at
 * run_user_flow.mjs:1881 — i.e. AFTER acquisition, ingress, broker evidence,
 * case compilation, the decisions stage, the forecast plan and the solver have
 * all already run. A missing `soffice`, a Python interpreter without openpyxl,
 * or an unwritable work root was therefore discovered only after the whole
 * expensive upstream half had been paid for.
 *
 * VALIDATORS VALIDATE, NEVER REPAIR. This module reports and refuses. It never
 * installs anything, never mutates PATH, never creates a missing working
 * directory, and never "fixes" the host. Its only writes are to a temporary
 * probe directory it creates inside an ALREADY-EXISTING temp root and removes
 * again; that probe is declared in the report rather than performed silently.
 *
 * REPORT-FIRST. Every check here is a cheap capability question (a version
 * print, an import, a stat, a small write). Nothing in this module renders,
 * recalculates, extracts, compiles or solves.
 *
 * PORTABILITY. This file contains NO absolute host paths. Interpreter and
 * binary locations come from arguments, the environment, the shipped
 * deployment profile, or PATH resolution performed at run time.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { selectedIngressPythonExecutable } from "./attachment_ingress.mjs";
import { resolvePythonExecutable, runProcessTree } from "./process_tree.mjs";
import { resolveActiveSourceIdentity } from "./source_identity.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_SKILL_ROOT = path.resolve(HERE, "..", "..");

export const RUNTIME_DOCTOR_SCHEMA_VERSION = "excel-inflow-runtime-doctor-report/1.0";
export const RUNTIME_DOCTOR_WORK_PACKAGE = "P6.7";

/**
 * The five result types. Only "satisfied" is a pass. "unknown" exists so a
 * check that could not reach an answer is never quietly rounded up into a
 * pass — an unknown mandatory precondition refuses exactly like an
 * unsatisfied one.
 */
export const RUNTIME_DOCTOR_RESULTS = Object.freeze([
  "satisfied",
  "unsatisfied",
  "not_applicable",
  "unknown",
  "excluded_installed_host",
]);

export const RUNTIME_DOCTOR_OBLIGATIONS = Object.freeze([
  "mandatory",
  "optional",
  "excluded_installed_host",
]);

/**
 * Delivery lanes. A precondition declares the lane it serves; when that lane
 * is not requested the check is legally not_applicable, and only then.
 * `always` means the precondition holds for any run at all.
 */
export const RUNTIME_DOCTOR_LANES = Object.freeze(["workbook", "evidence"]);

/**
 * Which lane each deployment-profile package belongs to. Derived from
 * assets/deployment-profile.json `used_by_packages`; declared here rather than
 * guessed at probe time so an unmapped package is a loud error.
 */
export const PACKAGE_LANES = Object.freeze({
  emit: "workbook",
  render: "workbook",
  "extract_broker_evidence.py": "evidence",
  "archive_broker_pages.py": "evidence",
  "extract_filing_statements.py": "evidence",
});

/**
 * The reason code the refusal carries. The terminal-reason registry
 * (assets/terminal-reason-registry-v1.json) is SEALED and read-only here, and
 * it has no host/environment category: the closest declared code is the
 * internal catch-all, whose recoverability (`resumable_after_repair`),
 * category (`internal`), user_action (`none - engineering owns this`) and
 * terminal state (`INTERNAL_FAILURE`) all match a host-precondition refusal
 * exactly. Only its `owner_layer` (case_compiler_or_graph) is wrong. That
 * mismatch is DECLARED in every refusal via `reason_code_fidelity` and
 * `requested_reason_code` rather than hidden.
 */
export const RUNTIME_DOCTOR_REASON_CODE = "INTERNAL.compiler_or_graph_defect";
export const RUNTIME_DOCTOR_REQUESTED_REASON_CODE = "INTERNAL.host_precondition_unsatisfied";
export const RUNTIME_DOCTOR_TERMINAL_STATE = "INTERNAL_FAILURE";
export const RUNTIME_DOCTOR_RESPONSIBLE_LAYER = "runtime_host_preflight";

/**
 * The precondition register. Every id here MUST appear exactly once in a
 * compiled report — the compiler enforces closure, so a precondition cannot be
 * silently skipped.
 */
export const PRECONDITION_DECLARATIONS = Object.freeze({
  node_interpreter: Object.freeze({
    title: "The Node interpreter running this run is an absolute, executable path",
    obligation: "mandatory",
    lane: "always",
    checked_by: "process.execPath is absolute and passes an X_OK access check",
    exclusion_reason: null,
  }),
  node_minimum_version: Object.freeze({
    title: "The Node interpreter satisfies the declared minimum version",
    obligation: "optional",
    lane: "always",
    checked_by:
      "assets/deployment-profile.json declares no minimum Node version and there is " +
      "no engines field, so there is no floor to compare process.version against; the " +
      "running version is REPORTED and the comparison is declared unavailable",
    exclusion_reason: null,
  }),
  node_vendored_dependency_closure: Object.freeze({
    title: "Every vendored Node dependency is present at its declared install path with its pinned hash",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "for each assets/deployment-profile.json vendored_dependencies entry, sha256 of " +
      "install_path is compared with the declared sha256",
    exclusion_reason: null,
  }),
  python_interpreter_custody: Object.freeze({
    title: "One Python interpreter is selected and resolved to an absolute path under custody",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "attachment_ingress.selectedIngressPythonExecutable(env) then " +
      "process_tree.resolvePythonExecutable — the SAME functions the run uses, so the " +
      "doctor cannot certify a different interpreter from the one that will be spawned",
    exclusion_reason: null,
  }),
  python_minimum_version: Object.freeze({
    title: "The resolved Python satisfies the declared minimum version",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "sys.version_info from the resolved interpreter compared with " +
      "assets/deployment-profile.json python_runtime.minimum_version",
    exclusion_reason: null,
  }),
  python_import_time_module_closure: Object.freeze({
    title: "The resolved Python satisfies every third-party module declared required_at=import",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "each allowed_python_third_party_imports entry with required_at=import is imported " +
      "in the resolved interpreter",
    exclusion_reason: null,
  }),
  python_single_interpreter_lane_closure: Object.freeze({
    title: "ONE resolved interpreter satisfies the whole declared module closure for the requested lanes",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "every allowed_python_third_party_imports entry whose required_at is import or " +
      "runtime and whose used_by_packages touch a REQUESTED lane is imported in the " +
      "single resolved interpreter. This is the documented trap: a host can have " +
      "openpyxl on one interpreter and PyMuPDF on another, and the run would then " +
      "half-work. The doctor names the missing modules before anything is paid for.",
    exclusion_reason: null,
  }),
  python_optional_module_closure: Object.freeze({
    title: "Modules declared required_at=runtime_optional are present",
    obligation: "optional",
    lane: "always",
    checked_by:
      "each allowed_python_third_party_imports entry with required_at=runtime_optional is " +
      "imported; absence degrades a corroboration, it does not block a run",
    exclusion_reason: null,
  }),
  soffice_available: Object.freeze({
    title: "LibreOffice (soffice) answers a version probe",
    obligation: "mandatory",
    lane: "workbook",
    checked_by:
      "the explicit --soffice argument, else the SOFFICE_BIN environment variable, else " +
      "the names declared in assets/deployment-profile.json python_runtime.external_binaries " +
      "resolved through PATH; each candidate is asked for --version. No absolute host " +
      "path is hardcoded in this repository.",
    exclusion_reason: null,
  }),
  workbook_font_metrics: Object.freeze({
    title: "A Carlito/Calibri-metric font file is locatable for clipping prediction",
    obligation: "optional",
    lane: "workbook",
    checked_by:
      "render/textfit.load_font_set() is asked, in the resolved interpreter, to resolve " +
      "its OWN shipped candidate list — the doctor does not restate the font paths. " +
      "Optional because the LibreOffice render, not the metric prediction, is the " +
      "authority on clipping.",
    exclusion_reason: null,
  }),
  work_root_writable: Object.freeze({
    title: "The requested run root (or its existing parent) is writable without the doctor creating it",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "the nearest EXISTING ancestor of the requested run root is stat'ed and W_OK-checked. " +
      "The doctor NEVER creates the missing directory — a missing writable parent is an " +
      "unsatisfied precondition, not something to repair.",
    exclusion_reason: null,
  }),
  temp_root_writable: Object.freeze({
    title: "The temp root is writable by this process",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "a probe directory is created inside the ALREADY-EXISTING temp root, a small file " +
      "is written and read back, and the probe directory is removed. The probe is " +
      "self-cleaning and is declared in the report detail.",
    exclusion_reason: null,
  }),
  temp_free_space: Object.freeze({
    title: "The temp root has free space above the requested floor",
    obligation: "optional",
    lane: "always",
    checked_by:
      "fs.statfs on the temp root, compared with a floor supplied by argument or the " +
      "EXCEL_INFLOW_DOCTOR_MIN_FREE_BYTES environment variable. Optional because no " +
      "shipped asset declares a free-space floor, so a missing floor is reported as " +
      "unknown rather than invented.",
    exclusion_reason: null,
  }),
  active_source_identity: Object.freeze({
    title: "The active runtime code closure is the closure the package identity declares",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "source_identity.resolveActiveSourceIdentity — the doctor reports its " +
      "active_runtime_code_closure_check.status. A pinned package whose live bytes " +
      "differ throws there, and that throw is reported as an unsatisfied precondition " +
      "with the mismatch, not as a stack print.",
    exclusion_reason: null,
  }),
  installed_package_hash_readback: Object.freeze({
    title: "The installed package hash on the live host equals the promoted package identity",
    obligation: "excluded_installed_host",
    lane: "always",
    checked_by: null,
    exclusion_reason:
      "Requires reading a live Rogo install's versioned install destination. The " +
      "installed-host tier is PERMANENTLY EXCLUDED by standing directive (see " +
      "assets/release-rollback-policy-v1.json scope.installed_host_tier); no script in " +
      "this repository may attempt it, so this precondition is unsatisfiable here by " +
      "construction rather than merely unfinished. It is never reported as passed.",
  }),
  installed_active_pointer: Object.freeze({
    title: "The active install pointer resolves to the package this run believes it is",
    obligation: "excluded_installed_host",
    lane: "always",
    checked_by: null,
    exclusion_reason:
      "Requires resolving a live install's active pointer from a fresh session. Same " +
      "permanently excluded installed-host tier; declared exclusion, never a waiver.",
  }),
  installed_rollback_package_present: Object.freeze({
    title: "A retained previous-known-good package is present to roll back to",
    obligation: "excluded_installed_host",
    lane: "always",
    checked_by: null,
    exclusion_reason:
      "The retained rollback target lives in the install destination's retention area on " +
      "the live host. Portable tier can attest a package; only the installed tier can " +
      "confirm one is retained THERE. Same permanent exclusion.",
  }),
  installed_host_write_permissions: Object.freeze({
    title: "This process may write the install destination the release procedure needs",
    obligation: "excluded_installed_host",
    lane: "always",
    checked_by: null,
    exclusion_reason:
      "Probing write access to a live install destination is itself an installed-host " +
      "mutation risk and is forbidden here. Same permanent exclusion.",
  }),
});

export const PRECONDITION_IDS = Object.freeze(Object.keys(PRECONDITION_DECLARATIONS));

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function declarationFor(preconditionId) {
  const declaration = PRECONDITION_DECLARATIONS[preconditionId];
  if (!declaration) {
    throw new Error(
      `Undeclared runtime-doctor precondition ${JSON.stringify(String(preconditionId))}. ` +
      "Add it to PRECONDITION_DECLARATIONS; the register is the closure.",
    );
  }
  return declaration;
}

/**
 * Build ONE typed check result. The type discipline is enforced here so no
 * call site can produce an untyped or over-claiming result:
 *
 *  - the id must be declared;
 *  - the result must be one of the five declared types;
 *  - an excluded-installed-host precondition MUST carry the
 *    "excluded_installed_host" result — it is structurally impossible to
 *    report one as satisfied;
 *  - any result other than "satisfied" MUST carry a reason;
 *  - "satisfied" MUST NOT carry a reason (a pass with an excuse is not a pass).
 */
export function typedCheck({ precondition_id: preconditionId, result, reason = null, detail = null }) {
  const declaration = declarationFor(preconditionId);
  if (!RUNTIME_DOCTOR_RESULTS.includes(result)) {
    throw new Error(
      `Runtime-doctor check ${preconditionId} produced the untyped result ` +
      `${JSON.stringify(String(result))}; legal results are ${RUNTIME_DOCTOR_RESULTS.join(", ")}.`,
    );
  }
  if (declaration.obligation === "excluded_installed_host" && result !== "excluded_installed_host") {
    throw new Error(
      `Runtime-doctor precondition ${preconditionId} is a declared installed-host exclusion ` +
      `and may only carry the result "excluded_installed_host"; it tried to report ` +
      `${JSON.stringify(result)}. A declared exclusion is never a pass.`,
    );
  }
  if (result === "excluded_installed_host" && declaration.obligation !== "excluded_installed_host") {
    throw new Error(
      `Runtime-doctor precondition ${preconditionId} is not a declared installed-host ` +
      "exclusion and may not claim one.",
    );
  }
  if (result !== "satisfied" && (typeof reason !== "string" || reason.trim() === "")) {
    throw new Error(
      `Runtime-doctor check ${preconditionId} reported ${result} without a reason. ` +
      "Every non-pass is typed WITH its reason.",
    );
  }
  if (result === "satisfied" && reason !== null) {
    throw new Error(
      `Runtime-doctor check ${preconditionId} reported satisfied with a reason; ` +
      "a pass that needs an excuse is not a pass.",
    );
  }
  return Object.freeze({
    precondition_id: preconditionId,
    title: declaration.title,
    obligation: declaration.obligation,
    lane: declaration.lane,
    result,
    reason: result === "satisfied" ? null : reason,
    detail: detail === null ? null : detail,
    checked_by: declaration.checked_by,
    exclusion_reason: declaration.exclusion_reason,
  });
}

function normaliseLanes(lanes) {
  const requested = Array.isArray(lanes) && lanes.length > 0 ? lanes : RUNTIME_DOCTOR_LANES;
  const unknownLane = requested.find((lane) => !RUNTIME_DOCTOR_LANES.includes(lane));
  if (unknownLane) {
    throw new Error(
      `Unknown delivery lane ${JSON.stringify(String(unknownLane))}; declared lanes are ` +
      `${RUNTIME_DOCTOR_LANES.join(", ")}.`,
    );
  }
  return Object.freeze([...new Set(requested)].sort());
}

function laneRequested(lane, requestedLanes) {
  return lane === "always" || requestedLanes.includes(lane);
}

/**
 * Compile the typed report. This is where the refusal rule lives:
 *
 *  - only "satisfied" is a pass;
 *  - "unknown" on a mandatory precondition REFUSES — an unreached answer is
 *    never rounded up;
 *  - "not_applicable" is legal on a mandatory precondition ONLY when that
 *    precondition's lane was not requested;
 *  - a declared installed-host exclusion neither passes nor refuses.
 */
export function compileRuntimeDoctorReport({
  checks,
  host,
  lanes,
  skillRoot = DEFAULT_SKILL_ROOT,
  runRoot = null,
  sourceHashes = {},
  generatedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(checks)) throw new Error("Runtime-doctor checks must be an array.");
  const requestedLanes = normaliseLanes(lanes);

  const seen = new Map();
  for (const check of checks) {
    if (!check || typeof check.precondition_id !== "string") {
      throw new Error("Every runtime-doctor check must carry a precondition_id.");
    }
    declarationFor(check.precondition_id);
    if (seen.has(check.precondition_id)) {
      throw new Error(`Runtime-doctor precondition ${check.precondition_id} was reported twice.`);
    }
    if (!RUNTIME_DOCTOR_RESULTS.includes(check.result)) {
      throw new Error(
        `Runtime-doctor precondition ${check.precondition_id} carries the untyped result ` +
        `${JSON.stringify(String(check.result))}.`,
      );
    }
    seen.set(check.precondition_id, check);
  }
  const missing = PRECONDITION_IDS.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(
      `The runtime doctor did not report on ${missing.join(", ")}. Every declared ` +
      "precondition is checked or explicitly typed; none is silently skipped.",
    );
  }

  const ordered = PRECONDITION_IDS.map((id) => seen.get(id));

  for (const check of ordered) {
    const declaration = declarationFor(check.precondition_id);
    if (declaration.obligation === "excluded_installed_host" && check.result !== "excluded_installed_host") {
      throw new Error(
        `Precondition ${check.precondition_id} is a declared installed-host exclusion and ` +
        "was reported as something else. No portable gate may report it as passed.",
      );
    }
    if (
      check.result === "not_applicable" &&
      declaration.obligation === "mandatory" &&
      laneRequested(declaration.lane, requestedLanes)
    ) {
      throw new Error(
        `Precondition ${check.precondition_id} is mandatory for a requested lane ` +
        `(${declaration.lane}) and may not be excused as not_applicable.`,
      );
    }
    if (check.result !== "satisfied" && (typeof check.reason !== "string" || check.reason.trim() === "")) {
      throw new Error(`Precondition ${check.precondition_id} reported ${check.result} with no reason.`);
    }
  }

  const counts = Object.fromEntries(RUNTIME_DOCTOR_RESULTS.map((result) => [result, 0]));
  for (const check of ordered) counts[check.result] += 1;
  counts.total = ordered.length;

  const blocking = ordered.filter((check) => {
    const declaration = declarationFor(check.precondition_id);
    if (declaration.obligation !== "mandatory") return false;
    return check.result === "unsatisfied" || check.result === "unknown";
  });

  const advisory = ordered.filter((check) => {
    const declaration = declarationFor(check.precondition_id);
    if (declaration.obligation !== "optional") return false;
    return check.result === "unsatisfied" || check.result === "unknown";
  });

  const verdict = blocking.length === 0 ? "HOST_READY" : "REFUSED";

  const refusal = verdict === "HOST_READY" ? null : Object.freeze({
    // The five fields the terminal-reason registry requires of an internal
    // failure payload (internal_failure_payload_requirements).
    reason_code: RUNTIME_DOCTOR_REASON_CODE,
    earliest_responsible_layer: RUNTIME_DOCTOR_RESPONSIBLE_LAYER,
    resumable_checkpoint_path: null,
    preserved_source_hashes: Object.freeze({ ...sourceHashes }),
    downstream_invalidation_scope: "no_work_started",
    // Declared fidelity: the sealed registry has no host/environment code.
    reason_code_fidelity: "closest_available",
    requested_reason_code: RUNTIME_DOCTOR_REQUESTED_REASON_CODE,
    reason_code_fidelity_note:
      "assets/terminal-reason-registry-v1.json declares no host/environment reason code. " +
      `${RUNTIME_DOCTOR_REASON_CODE} is the closest declared match on category, ` +
      "severity, recoverability, user_action and terminal state; only its owner_layer " +
      `differs. The needed code is ${RUNTIME_DOCTOR_REQUESTED_REASON_CODE} ` +
      "(owner_layer runtime_governance). The registry is sealed and was not edited.",
    terminal_state: RUNTIME_DOCTOR_TERMINAL_STATE,
    refusal_message:
      "This host cannot complete a run: " +
      blocking.map((check) => `${check.precondition_id} (${check.result})`).join(", ") +
      ". No expensive work was started.",
    unsatisfied_preconditions: Object.freeze(blocking.map((check) => Object.freeze({
      precondition_id: check.precondition_id,
      result: check.result,
      reason: check.reason,
    }))),
  });

  return Object.freeze({
    schema_version: RUNTIME_DOCTOR_SCHEMA_VERSION,
    work_package: RUNTIME_DOCTOR_WORK_PACKAGE,
    invariant:
      "Before expensive work begins, every declared host precondition is checked, each " +
      "result is typed, and an unsatisfied mandatory precondition produces a typed " +
      "refusal naming a registered reason code.",
    generated_at: generatedAt,
    report_only: true,
    performed_expensive_work: false,
    repaired_host: false,
    skill_root_present: typeof skillRoot === "string" && skillRoot.length > 0,
    run_root: runRoot,
    requested_lanes: requestedLanes,
    host: Object.freeze({ ...host }),
    verdict,
    counts: Object.freeze(counts),
    advisory_preconditions: Object.freeze(advisory.map((check) => Object.freeze({
      precondition_id: check.precondition_id,
      result: check.result,
      reason: check.reason,
    }))),
    checks: Object.freeze(ordered.map((check) => Object.freeze({ ...check }))),
    refusal,
  });
}

/** The typed refusal, as an Error carrying the payload — never a bare throw. */
export class RuntimeDoctorRefusal extends Error {
  constructor(report) {
    super(report.refusal.refusal_message);
    this.name = "RuntimeDoctorRefusal";
    this.typed_internal_outcome = Object.freeze({ ...report.refusal });
    this.runtime_doctor_report = report;
  }
}

export function assertRuntimeDoctorSatisfied(report) {
  if (report.verdict !== "HOST_READY") throw new RuntimeDoctorRefusal(report);
  return report;
}

// --------------------------------------------------------------------------
// Probes. Each one is cheap and answers exactly one capability question.
// --------------------------------------------------------------------------

async function readJsonIfPresent(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

async function hostFingerprint() {
  let hostnameHash = null;
  try {
    hostnameHash = sha256Hex(os.hostname());
  } catch {
    hostnameHash = null;
  }
  return {
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    cpu_count: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    // Hashed: the doctor identifies the host without disclosing its name.
    hostname_sha256: hostnameHash,
  };
}

async function checkNodeInterpreter() {
  const execPath = process.execPath;
  if (!path.isAbsolute(execPath)) {
    return typedCheck({
      precondition_id: "node_interpreter",
      result: "unsatisfied",
      reason: "process.execPath is not an absolute path, so the interpreter has no stable identity.",
      detail: { exec_path_absolute: false },
    });
  }
  try {
    await fs.access(execPath, fsConstants.X_OK);
  } catch (error) {
    return typedCheck({
      precondition_id: "node_interpreter",
      result: "unsatisfied",
      reason: `The Node interpreter is not executable by this process: ${error?.code ?? error?.message}.`,
      detail: { exec_path_absolute: true },
    });
  }
  return typedCheck({
    precondition_id: "node_interpreter",
    result: "satisfied",
    detail: { exec_path_absolute: true, resolved_executable: execPath },
  });
}

function checkNodeMinimumVersion(profile) {
  const declared = profile?.node_runtime?.minimum_version ?? null;
  if (!Array.isArray(declared) || declared.length === 0) {
    return typedCheck({
      precondition_id: "node_minimum_version",
      result: "unknown",
      reason:
        "assets/deployment-profile.json declares no node_runtime.minimum_version and the " +
        "repository has no package.json engines field, so there is no floor to compare " +
        "against. COULD NOT CHECK — declared, not skipped. The running version is reported.",
      detail: { running_version: process.version, declared_minimum_version: null },
    });
  }
  const running = process.versions.node.split(".").map(Number);
  const satisfied = declared.every((part, index) => (running[index] ?? 0) >= part)
    || running[0] > declared[0];
  return typedCheck({
    precondition_id: "node_minimum_version",
    result: satisfied ? "satisfied" : "unsatisfied",
    reason: satisfied ? null : `Node ${process.versions.node} is below the declared minimum ${declared.join(".")}.`,
    detail: { running_version: process.version, declared_minimum_version: declared },
  });
}

async function checkVendoredNodeDependencies(profile, skillRoot) {
  const declared = Array.isArray(profile?.vendored_dependencies) ? profile.vendored_dependencies : null;
  if (declared === null) {
    return typedCheck({
      precondition_id: "node_vendored_dependency_closure",
      result: "unknown",
      reason:
        "assets/deployment-profile.json could not be read or declares no " +
        "vendored_dependencies array, so the vendored closure cannot be verified.",
      detail: null,
    });
  }
  const findings = [];
  for (const entry of declared) {
    const relative = typeof entry?.install_path === "string" ? entry.install_path : null;
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      findings.push({ name: entry?.name ?? null, status: "undeclared_install_path" });
      continue;
    }
    const target = path.resolve(skillRoot, relative);
    let bytes = null;
    try {
      bytes = await fs.readFile(target);
    } catch (error) {
      findings.push({ name: entry.name, install_path: relative, status: "absent", code: error?.code ?? null });
      continue;
    }
    const actual = sha256Hex(bytes);
    findings.push({
      name: entry.name,
      install_path: relative,
      status: actual === entry.sha256 ? "match" : "hash_mismatch",
    });
  }
  const bad = findings.filter((finding) => finding.status !== "match");
  return typedCheck({
    precondition_id: "node_vendored_dependency_closure",
    result: bad.length === 0 ? "satisfied" : "unsatisfied",
    reason: bad.length === 0
      ? null
      : `Vendored Node dependencies are not the declared bytes: ${
        bad.map((finding) => `${finding.name}=${finding.status}`).join(", ")
      }.`,
    detail: { declared_count: declared.length, findings },
  });
}

/**
 * Resolve the ONE Python interpreter the run will use, through the run's own
 * custody functions. Custody discipline: the selection comes from
 * EXCEL_INFLOW_PYTHON / PYTHON via selectedIngressPythonExecutable, and a
 * poisoned PATH cannot replace an absolute selection.
 */
export async function resolveDoctorPython({ env = process.env, explicit = null } = {}) {
  const effectiveEnv = explicit
    ? { ...env, EXCEL_INFLOW_PYTHON: path.isAbsolute(explicit) ? explicit : undefined, PYTHON: explicit }
    : env;
  const selected = selectedIngressPythonExecutable(effectiveEnv);
  const resolved = path.isAbsolute(selected)
    ? selected
    : await resolvePythonExecutable(selected, { env: effectiveEnv });
  if (!path.isAbsolute(resolved)) {
    throw new Error("The selected Python interpreter did not resolve to an absolute executable path.");
  }
  await fs.access(resolved, fsConstants.X_OK);
  return { selected, resolved };
}

const PYTHON_PROBE = [
  "import importlib, json, sys",
  "modules = {}",
  "for name in sys.argv[1:]:",
  "    try:",
  "        importlib.import_module(name)",
  "        modules[name] = True",
  "    except Exception:",
  "        modules[name] = False",
  "print(json.dumps({",
  "    'executable': sys.executable,",
  "    'version': list(sys.version_info[:3]),",
  "    'prefix_is_venv': sys.prefix != getattr(sys, 'base_prefix', sys.prefix),",
  "    'modules': modules,",
  "}, sort_keys=True))",
].join("\n");

async function probePython(resolved, moduleNames, { timeout = 60_000 } = {}) {
  const probe = await runProcessTree(resolved, ["-c", PYTHON_PROBE, ...moduleNames], { timeout });
  if (!probe.ok) {
    return { ok: false, error: probe.stderr || probe.error_code || `exit ${probe.code}` };
  }
  const line = probe.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, error: "the interpreter did not print a parsable probe result" };
  }
}

function declaredModules(profile) {
  const declared = profile?.allowed_python_third_party_imports;
  if (!declared || typeof declared !== "object") return null;
  return Object.entries(declared).map(([moduleName, entry]) => ({
    module: moduleName,
    distribution: entry?.distribution ?? null,
    required_at: entry?.required_at ?? null,
    used_by_packages: Array.isArray(entry?.used_by_packages) ? entry.used_by_packages : [],
  }));
}

function modulesForLanes(declared, requestedLanes, requiredAt) {
  return declared.filter((entry) => {
    if (!requiredAt.includes(entry.required_at)) return false;
    if (entry.used_by_packages.length === 0) return true;
    return entry.used_by_packages.some((packageName) => {
      const lane = PACKAGE_LANES[packageName];
      if (!lane) return true; // unmapped package: assume it is needed rather than excuse it
      return laneRequested(lane, requestedLanes);
    });
  });
}

async function checkSoffice({ profile, explicit, env, timeout }) {
  const declaredNames = (profile?.python_runtime?.external_binaries ?? [])
    .filter((entry) => entry?.name)
    .map((entry) => String(entry.name));
  const candidates = [
    explicit,
    env.SOFFICE_BIN,
    ...declaredNames,
    // A conventional sibling name; resolved through PATH, never a literal path.
    declaredNames.includes("soffice") ? "libreoffice" : null,
  ].filter(Boolean);
  const attempts = [];
  for (const candidate of candidates) {
    const probe = await runProcessTree(candidate, ["--version"], { timeout, env });
    if (probe.ok) {
      const version = (probe.stdout.trim() || probe.stderr.trim()).split(/\r?\n/)[0] ?? "";
      return typedCheck({
        precondition_id: "soffice_available",
        result: "satisfied",
        detail: {
          candidate,
          candidate_source: candidate === explicit
            ? "argument"
            : candidate === env.SOFFICE_BIN ? "SOFFICE_BIN" : "PATH_resolved_declared_name",
          version,
          attempts,
        },
      });
    }
    attempts.push({ candidate, error: probe.error_code ?? `exit ${probe.code}` });
  }
  return typedCheck({
    precondition_id: "soffice_available",
    result: "unsatisfied",
    reason:
      "No LibreOffice binary answered a --version probe. The workbook lane recalculates " +
      "through soffice and returns BLOCKED without it. Supply --soffice or SOFFICE_BIN. " +
      `Candidates tried: ${candidates.join(", ") || "(none declared)"}.`,
    detail: { attempts, candidates },
  });
}

async function checkFontMetrics({ resolvedPython, scriptsDir, timeout }) {
  const source = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "try:",
    "    from render.textfit import load_font_set",
    "except Exception as error:",
    "    print(json.dumps({'status': 'probe_unavailable', 'error': str(error)}))",
    "else:",
    "    try:",
    "        fonts = load_font_set()",
    "    except Exception as error:",
    "        print(json.dumps({'status': 'absent', 'error': str(error)}))",
    "    else:",
    "        print(json.dumps({",
    "            'status': 'present',",
    "            'regular_present': bool(fonts.regular_path),",
    "            'bold_present': bool(fonts.bold_path),",
    "        }))",
  ].join("\n");
  const probe = await runProcessTree(resolvedPython, ["-c", source, scriptsDir], { timeout });
  if (!probe.ok) {
    return typedCheck({
      precondition_id: "workbook_font_metrics",
      result: "unknown",
      reason:
        "The shipped font resolver could not be asked (the probe interpreter did not " +
        `complete): ${probe.stderr || probe.error_code || `exit ${probe.code}`}.`,
      detail: null,
    });
  }
  let value;
  try {
    value = JSON.parse(probe.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
  } catch {
    return typedCheck({
      precondition_id: "workbook_font_metrics",
      result: "unknown",
      reason: "The font probe did not print a parsable result.",
      detail: null,
    });
  }
  if (value.status === "present") {
    return typedCheck({
      precondition_id: "workbook_font_metrics",
      result: "satisfied",
      detail: value,
    });
  }
  if (value.status === "probe_unavailable") {
    return typedCheck({
      precondition_id: "workbook_font_metrics",
      result: "unknown",
      reason: `render.textfit could not be imported, so its own candidate list could not be asked: ${value.error}.`,
      detail: value,
    });
  }
  return typedCheck({
    precondition_id: "workbook_font_metrics",
    result: "unsatisfied",
    reason:
      "No Carlito/Calibri-metric font file was locatable, so metric clipping prediction " +
      `is unavailable (the LibreOffice render remains the authority): ${value.error}.`,
    detail: value,
  });
}

async function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stat = await fs.stat(current);
      return { path: current, is_directory: stat.isDirectory(), created_by_doctor: false };
    } catch (error) {
      if (error?.code !== "ENOENT") return { path: current, error: error?.code ?? error?.message };
      const parent = path.dirname(current);
      if (parent === current) return { path: current, error: "ENOENT" };
      current = parent;
    }
  }
  return { path: current, error: "ancestor search exhausted" };
}

async function checkWorkRootWritable(runRoot) {
  if (!runRoot) {
    return typedCheck({
      precondition_id: "work_root_writable",
      result: "unknown",
      reason:
        "No run root was supplied, so the working directory this run would write cannot be " +
        "checked. Pass --run-root. COULD NOT CHECK — declared, not skipped.",
      detail: null,
    });
  }
  const requested = path.resolve(runRoot);
  const ancestor = await nearestExistingAncestor(requested);
  if (ancestor.error) {
    return typedCheck({
      precondition_id: "work_root_writable",
      result: "unsatisfied",
      reason: `No existing ancestor of the requested run root could be stat'ed (${ancestor.error}).`,
      detail: { requested_run_root: requested, nearest_existing: ancestor },
    });
  }
  if (!ancestor.is_directory) {
    return typedCheck({
      precondition_id: "work_root_writable",
      result: "unsatisfied",
      reason: "The nearest existing ancestor of the requested run root is not a directory.",
      detail: { requested_run_root: requested, nearest_existing: ancestor },
    });
  }
  try {
    await fs.access(ancestor.path, fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    return typedCheck({
      precondition_id: "work_root_writable",
      result: "unsatisfied",
      reason:
        `The nearest existing ancestor of the requested run root is not writable by this ` +
        `process (${error?.code ?? error?.message}). The doctor does not create or chmod it.`,
      detail: { requested_run_root: requested, nearest_existing: ancestor },
    });
  }
  return typedCheck({
    precondition_id: "work_root_writable",
    result: "satisfied",
    detail: {
      requested_run_root: requested,
      nearest_existing_ancestor: ancestor.path,
      run_root_exists: ancestor.path === requested,
      doctor_created_anything: false,
    },
  });
}

async function checkTempRootWritable(tempRoot) {
  let probeDir = null;
  try {
    const stat = await fs.stat(tempRoot);
    if (!stat.isDirectory()) {
      return typedCheck({
        precondition_id: "temp_root_writable",
        result: "unsatisfied",
        reason: "The temp root is not a directory.",
        detail: { temp_root: tempRoot },
      });
    }
    probeDir = await fs.mkdtemp(path.join(tempRoot, "excel-inflow-doctor-probe-"));
    const probeFile = path.join(probeDir, "probe");
    const payload = "runtime-doctor-probe";
    await fs.writeFile(probeFile, payload, "utf8");
    const readBack = await fs.readFile(probeFile, "utf8");
    if (readBack !== payload) {
      return typedCheck({
        precondition_id: "temp_root_writable",
        result: "unsatisfied",
        reason: "A file written into the temp root did not read back byte-identical.",
        detail: { temp_root: tempRoot },
      });
    }
    return typedCheck({
      precondition_id: "temp_root_writable",
      result: "satisfied",
      detail: {
        temp_root: tempRoot,
        probe: "created a temporary directory inside the already-existing temp root, wrote and read back a small file, then removed it",
        probe_removed: true,
        created_missing_directories: false,
      },
    });
  } catch (error) {
    return typedCheck({
      precondition_id: "temp_root_writable",
      result: "unsatisfied",
      reason: `The temp root is not usable by this process (${error?.code ?? error?.message}).`,
      detail: { temp_root: tempRoot },
    });
  } finally {
    if (probeDir) await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkTempFreeSpace(tempRoot, floorBytes) {
  if (typeof fs.statfs !== "function") {
    return typedCheck({
      precondition_id: "temp_free_space",
      result: "unknown",
      reason:
        "This Node build exposes no fs.statfs, so free space on the temp root cannot be " +
        "measured. COULD NOT CHECK — declared, not skipped.",
      detail: { temp_root: tempRoot },
    });
  }
  let freeBytes = null;
  try {
    const stats = await fs.statfs(tempRoot);
    freeBytes = Number(stats.bsize) * Number(stats.bavail);
  } catch (error) {
    return typedCheck({
      precondition_id: "temp_free_space",
      result: "unknown",
      reason: `Free space on the temp root could not be measured (${error?.code ?? error?.message}).`,
      detail: { temp_root: tempRoot },
    });
  }
  if (!Number.isFinite(floorBytes) || floorBytes <= 0) {
    return typedCheck({
      precondition_id: "temp_free_space",
      result: "unknown",
      reason:
        "No shipped asset declares a temp free-space floor and none was supplied via " +
        "--min-free-bytes or EXCEL_INFLOW_DOCTOR_MIN_FREE_BYTES, so there is nothing to " +
        "compare the measurement against. The measurement is reported; a floor is not invented.",
      detail: { temp_root: tempRoot, free_bytes: freeBytes, floor_bytes: null },
    });
  }
  return typedCheck({
    precondition_id: "temp_free_space",
    result: freeBytes >= floorBytes ? "satisfied" : "unsatisfied",
    reason: freeBytes >= floorBytes
      ? null
      : `The temp root has ${freeBytes} free bytes, below the requested floor of ${floorBytes}.`,
    detail: { temp_root: tempRoot, free_bytes: freeBytes, floor_bytes: floorBytes },
  });
}

async function checkActiveSourceIdentity(skillRoot) {
  try {
    const identity = await resolveActiveSourceIdentity({ skillRoot });
    const check = identity.active_runtime_code_closure_check;
    if (check?.status === "match") {
      return {
        check: typedCheck({
          precondition_id: "active_source_identity",
          result: "satisfied",
          detail: {
            closure_check_status: check.status,
            package_mode: identity.package_mode ?? null,
            deployment_status: identity.deployment_status ?? null,
          },
        }),
        sourceHashes: {
          active_runtime_code_closure_sha256: check.active_runtime_code_closure_sha256,
          declared_runtime_code_closure_sha256: check.declared_runtime_code_closure_sha256,
        },
      };
    }
    if (check?.status === "development_unpinned") {
      // Honest typing: an unpinned development tree CAN run; there is simply no
      // declared package identity to compare the live bytes against. That is a
      // satisfied precondition with the status reported, not a hidden pass.
      return {
        check: typedCheck({
          precondition_id: "active_source_identity",
          result: "satisfied",
          detail: {
            closure_check_status: check.status,
            note: "no declared package identity is pinned, so the live closure is the identity",
            active_runtime_code_closure_sha256: check.active_runtime_code_closure_sha256,
          },
        }),
        sourceHashes: {
          active_runtime_code_closure_sha256: check.active_runtime_code_closure_sha256,
          declared_runtime_code_closure_sha256: null,
        },
      };
    }
    return {
      check: typedCheck({
        precondition_id: "active_source_identity",
        result: "unknown",
        reason:
          `The active runtime-code-closure check reported the unrecognised status ` +
          `${JSON.stringify(String(check?.status))}; an unrecognised status is never a pass.`,
        detail: { closure_check_status: check?.status ?? null },
      }),
      sourceHashes: {},
    };
  } catch (error) {
    return {
      check: typedCheck({
        precondition_id: "active_source_identity",
        result: "unsatisfied",
        reason:
          "The active runtime code closure is not the closure the package identity declares, " +
          `or the identity could not be resolved: ${error?.message ?? String(error)}`,
        detail: null,
      }),
      sourceHashes: {},
    };
  }
}

/**
 * Run every declared precondition check and compile the typed report.
 *
 * Nothing here is expensive: version prints, module imports, hash reads, one
 * stat and one self-cleaning temp probe.
 */
export async function runRuntimeDoctor({
  skillRoot = DEFAULT_SKILL_ROOT,
  env = process.env,
  lanes = RUNTIME_DOCTOR_LANES,
  runRoot = null,
  python = null,
  soffice = null,
  tempRoot = null,
  minFreeBytes = null,
  probeTimeoutMs = 60_000,
} = {}) {
  const requestedLanes = normaliseLanes(lanes);
  const profile = await readJsonIfPresent(path.join(skillRoot, "assets", "deployment-profile.json"));
  const scriptsDir = path.join(skillRoot, "scripts");
  const effectiveTempRoot = tempRoot ?? env.TMPDIR ?? os.tmpdir();
  const floorBytes = Number(
    minFreeBytes ?? env.EXCEL_INFLOW_DOCTOR_MIN_FREE_BYTES ?? Number.NaN,
  );

  const checks = [];
  checks.push(await checkNodeInterpreter());
  checks.push(checkNodeMinimumVersion(profile));
  checks.push(await checkVendoredNodeDependencies(profile, skillRoot));

  // --- Python custody: resolve ONCE, then answer every python question from
  // that one resolved executable. -----------------------------------------
  let resolvedPython = null;
  try {
    const custody = await resolveDoctorPython({ env, explicit: python });
    resolvedPython = custody.resolved;
    checks.push(typedCheck({
      precondition_id: "python_interpreter_custody",
      result: "satisfied",
      detail: {
        selected: custody.selected,
        resolved_executable: custody.resolved,
        resolved_absolute: true,
        custody_note:
          "resolved through selectedIngressPythonExecutable + resolvePythonExecutable, " +
          "the same custody path the run uses; a poisoned PATH cannot replace an " +
          "absolute selection",
      },
    }));
  } catch (error) {
    checks.push(typedCheck({
      precondition_id: "python_interpreter_custody",
      result: "unsatisfied",
      reason: `No Python interpreter could be selected and resolved: ${error?.message ?? String(error)}`,
      detail: null,
    }));
  }

  const declared = declaredModules(profile);
  const importTime = declared ? modulesForLanes(declared, requestedLanes, ["import"]) : [];
  const laneClosure = declared ? modulesForLanes(declared, requestedLanes, ["import", "runtime"]) : [];
  const optional = declared ? modulesForLanes(declared, requestedLanes, ["runtime_optional"]) : [];
  const allModules = declared
    ? [...new Set([...laneClosure, ...optional].map((entry) => entry.module))].sort()
    : [];

  let probe = null;
  if (resolvedPython !== null && declared !== null) {
    probe = await probePython(resolvedPython, allModules, { timeout: probeTimeoutMs });
  }

  const pythonUnavailableReason = resolvedPython === null
    ? "the Python interpreter could not be resolved, so no Python precondition could be checked"
    : declared === null
      ? "assets/deployment-profile.json declares no allowed_python_third_party_imports, so the required module closure is unknown"
      : probe?.ok
        ? null
        : `the resolved interpreter did not complete the capability probe (${probe?.error ?? "unknown error"})`;

  if (pythonUnavailableReason !== null) {
    for (const id of [
      "python_minimum_version",
      "python_import_time_module_closure",
      "python_single_interpreter_lane_closure",
      "python_optional_module_closure",
    ]) {
      checks.push(typedCheck({
        precondition_id: id,
        result: "unknown",
        reason: `Not determinable on this host: ${pythonUnavailableReason}. An unreached answer is never a pass.`,
        detail: null,
      }));
    }
  } else {
    const declaredMinimum = profile?.python_runtime?.minimum_version ?? null;
    const version = probe.value.version;
    if (!Array.isArray(declaredMinimum) || declaredMinimum.length === 0) {
      checks.push(typedCheck({
        precondition_id: "python_minimum_version",
        result: "unknown",
        reason:
          "assets/deployment-profile.json declares no python_runtime.minimum_version, so " +
          "there is no floor to compare the interpreter against.",
        detail: { running_version: version, declared_minimum_version: null },
      }));
    } else {
      const compare = (running, floor) => {
        for (let index = 0; index < floor.length; index += 1) {
          const left = running[index] ?? 0;
          const right = floor[index] ?? 0;
          if (left !== right) return left > right ? 1 : -1;
        }
        return 0;
      };
      const ok = compare(version, declaredMinimum) >= 0;
      checks.push(typedCheck({
        precondition_id: "python_minimum_version",
        result: ok ? "satisfied" : "unsatisfied",
        reason: ok
          ? null
          : `The resolved Python is ${version.join(".")}, below the declared minimum ${declaredMinimum.join(".")}.`,
        detail: {
          running_version: version,
          declared_minimum_version: declaredMinimum,
          resolved_executable: probe.value.executable,
          in_virtual_environment: probe.value.prefix_is_venv,
        },
      }));
    }

    const importMissing = importTime.filter((entry) => probe.value.modules[entry.module] !== true);
    checks.push(typedCheck({
      precondition_id: "python_import_time_module_closure",
      result: importMissing.length === 0 ? "satisfied" : "unsatisfied",
      reason: importMissing.length === 0
        ? null
        : `The resolved interpreter cannot import ${
          importMissing.map((entry) => `${entry.module} (${entry.distribution})`).join(", ")
        }, which the deployment profile declares required_at=import.`,
      detail: {
        required: importTime.map((entry) => entry.module),
        missing: importMissing.map((entry) => entry.module),
        resolved_executable: probe.value.executable,
      },
    }));

    const laneMissing = laneClosure.filter((entry) => probe.value.modules[entry.module] !== true);
    checks.push(typedCheck({
      precondition_id: "python_single_interpreter_lane_closure",
      result: laneMissing.length === 0 ? "satisfied" : "unsatisfied",
      reason: laneMissing.length === 0
        ? null
        : "No single interpreter satisfies the declared closure for the requested lanes: " +
          `${probe.value.executable} cannot import ${
            laneMissing.map((entry) => `${entry.module} (${entry.distribution}, needed by ${entry.used_by_packages.join("/")})`).join(", ")
          }. A run started on this interpreter would half-work and fail deep in the lane ` +
          "that needs the missing module. Install the missing distributions into ONE " +
          "interpreter and pass it as EXCEL_INFLOW_PYTHON.",
      detail: {
        requested_lanes: requestedLanes,
        required: laneClosure.map((entry) => entry.module),
        missing: laneMissing.map((entry) => entry.module),
        resolved_executable: probe.value.executable,
        per_module: Object.fromEntries(
          laneClosure.map((entry) => [entry.module, probe.value.modules[entry.module] === true]),
        ),
      },
    }));

    const optionalMissing = optional.filter((entry) => probe.value.modules[entry.module] !== true);
    checks.push(typedCheck({
      precondition_id: "python_optional_module_closure",
      result: optionalMissing.length === 0 ? "satisfied" : "unsatisfied",
      reason: optionalMissing.length === 0
        ? null
        : `Optional modules absent (a corroboration degrades, the run is not blocked): ${
          optionalMissing.map((entry) => entry.module).join(", ")
        }.`,
      detail: {
        declared: optional.map((entry) => entry.module),
        missing: optionalMissing.map((entry) => entry.module),
      },
    }));
  }

  // --- Workbook-lane preconditions ---------------------------------------
  if (requestedLanes.includes("workbook")) {
    checks.push(await checkSoffice({
      profile,
      explicit: soffice,
      env,
      timeout: Math.min(probeTimeoutMs, 30_000),
    }));
    if (resolvedPython === null) {
      checks.push(typedCheck({
        precondition_id: "workbook_font_metrics",
        result: "unknown",
        reason: "The font resolver could not be asked because no Python interpreter resolved.",
        detail: null,
      }));
    } else {
      checks.push(await checkFontMetrics({
        resolvedPython,
        scriptsDir,
        timeout: Math.min(probeTimeoutMs, 30_000),
      }));
    }
  } else {
    checks.push(typedCheck({
      precondition_id: "soffice_available",
      result: "not_applicable",
      reason: "The workbook lane was not requested, so no recalculation binary is needed.",
      detail: { requested_lanes: requestedLanes },
    }));
    checks.push(typedCheck({
      precondition_id: "workbook_font_metrics",
      result: "not_applicable",
      reason: "The workbook lane was not requested, so no font metrics are needed.",
      detail: { requested_lanes: requestedLanes },
    }));
  }

  // --- Filesystem --------------------------------------------------------
  checks.push(await checkWorkRootWritable(runRoot));
  checks.push(await checkTempRootWritable(effectiveTempRoot));
  checks.push(await checkTempFreeSpace(effectiveTempRoot, floorBytes));

  // --- Active source identity -------------------------------------------
  const identity = await checkActiveSourceIdentity(skillRoot);
  checks.push(identity.check);

  // --- Declared installed-host exclusions --------------------------------
  for (const [id, declaration] of Object.entries(PRECONDITION_DECLARATIONS)) {
    if (declaration.obligation !== "excluded_installed_host") continue;
    checks.push(typedCheck({
      precondition_id: id,
      result: "excluded_installed_host",
      reason: declaration.exclusion_reason,
      detail: { attempted: false, portable_gate_may_report_as_passed: false },
    }));
  }

  return compileRuntimeDoctorReport({
    checks,
    host: await hostFingerprint(),
    lanes: requestedLanes,
    skillRoot,
    runRoot: runRoot === null ? null : path.resolve(runRoot),
    sourceHashes: identity.sourceHashes,
  });
}

export default {
  RUNTIME_DOCTOR_SCHEMA_VERSION,
  RUNTIME_DOCTOR_RESULTS,
  RUNTIME_DOCTOR_OBLIGATIONS,
  RUNTIME_DOCTOR_LANES,
  RUNTIME_DOCTOR_REASON_CODE,
  RUNTIME_DOCTOR_REQUESTED_REASON_CODE,
  PRECONDITION_DECLARATIONS,
  PRECONDITION_IDS,
  typedCheck,
  compileRuntimeDoctorReport,
  assertRuntimeDoctorSatisfied,
  RuntimeDoctorRefusal,
  resolveDoctorPython,
  runRuntimeDoctor,
};
