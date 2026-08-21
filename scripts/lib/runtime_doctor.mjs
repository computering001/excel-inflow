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
 * directory, and never "fixes" the host. Its only filesystem-preflight writes
 * are self-cleaning probe directories on the proposed run-root and effective
 * temp-root volumes; it removes them and declares every operation in the report.
 *
 * REPORT-FIRST. Every check here is a bounded capability question (a version
 * print, an import, a bounded physical filesystem probe, or the frozen two-page filing
 * extraction probe). It never processes issuer evidence, renders a workbook,
 * recalculates, compiles a case or solves the model.
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
import { fileURLToPath } from "node:url";

import { selectedIngressPythonExecutable } from "./attachment_ingress.mjs";
import { publishDurableJsonGeneration } from "./durable_artifact_generation.mjs";
import { probePhysicalFilesystem } from "./filesystem_probe.mjs";
import {
  evaluateDiskSpacePolicy,
  loadDiskSpacePolicy,
} from "./disk_space_policy.mjs";
import { runInstalledInlineXbrlProbe } from "./installed_inline_xbrl_probe.mjs";
import { resolveInstalledRuntimeIdentity } from "./installed_runtime_identity.mjs";
import {
  ACTIVATION_FRESHNESS_MAX_AGE_SECONDS,
  validateInstalledCapabilityReceiptV13Semantics,
} from "./installed_capability_receipt_v13.mjs";
import { validateJsonSchema } from "./json_schema.mjs";
import { probeLibreOfficeWorkbookCapability } from "./libreoffice_workbook_capability.mjs";
import { resolvePythonExecutable, runProcessTree } from "./process_tree.mjs";
import {
  evaluateRuntimeCompatibility,
  loadRuntimeCompatibilityContract,
} from "./runtime_compatibility.mjs";
import { resolveActiveSourceIdentity } from "./source_identity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_ROOT = path.resolve(HERE, "..", "..");
export const RUNTIME_DOCTOR_DEFAULT_SKILL_ROOT = DEFAULT_SKILL_ROOT;

export const RUNTIME_DOCTOR_SCHEMA_VERSION = "excel-inflow-runtime-doctor-report/1.0";
export const RUNTIME_DOCTOR_WORK_PACKAGE = "P6.7";
export const INSTALLED_CAPABILITY_RECEIPT_SCHEMA_VERSION =
  "excel-inflow-installed-capability-receipt/1.3";
const INSTALLED_CAPABILITY_RECEIPT_V13_SCHEMA = JSON.parse(
  await fs.readFile(
    path.join(DEFAULT_SKILL_ROOT, "assets", "installed-capability-receipt-v1.3.schema.json"),
    "utf8",
  ),
);

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
  "extract_inline_xbrl.py": "evidence",
});

/**
 * Runtime governance owns a failed host precondition directly. It is never
 * laundered through the compiler/graph owner.
 */
export const RUNTIME_DOCTOR_REASON_CODE = "INTERNAL.host_precondition_unsatisfied";
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
      "process.version compared with the Node inclusive minimum in the single " +
      "assets/runtime-compatibility-v1.json authority; the mandatory central compatibility " +
      "check also enforces its exclusive maximum",
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
      "the Python inclusive minimum in assets/runtime-compatibility-v1.json; the mandatory " +
      "central compatibility check also enforces its exclusive maximum",
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
  filings_extraction_probe: Object.freeze({
    title: "The installed mandatory filing route opens and extracts the frozen PDF fixture",
    obligation: "mandatory",
    lane: "evidence",
    checked_by:
      "the one resolved Python opens the frozen two-page PDF with PyMuPDF, runs the " +
      "shipped extract_filing_statements.py entry point, validates its response schema, " +
      "and proves labels, values, explicit zero, dash, blank, periods and units",
    exclusion_reason: null,
  }),
  inline_xbrl_host_probe: Object.freeze({
    title: "The installed Inline XBRL route parses and selects the frozen annual facts",
    obligation: "mandatory",
    lane: "evidence",
    checked_by:
      "after the one selected Python and lxml version close through the shared compatibility " +
      "owner, the shipped extract_inline_xbrl.py worker parses a frozen three-context fixture, " +
      "returns a schema-valid result, selects only non-dimensioned annual authority, quarantines " +
      "the contradictory dimensioned observation and removes its bounded scratch directory",
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
  runtime_version_compatibility: Object.freeze({
    title: "Every runtime required by the requested lanes is inside its exercised compatibility range",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "assets/runtime-compatibility-v1.json supplies inclusive minimum and exclusive maximum " +
      "ranges; Node, the one selected Python, importlib.metadata distribution versions and " +
      "the selected soffice banner are evaluated through the shared compatibility owner",
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
  libreoffice_workbook_capability: Object.freeze({
    title: "The selected LibreOffice opens, calculates, saves and yields the known workbook result",
    obligation: "mandatory",
    lane: "workbook",
    checked_by:
      "a deterministic openpyxl fixture is opened headlessly with an isolated file-URL user " +
      "profile, converted to xlsx, reopened through the one selected Python and required to " +
      "retain =SUM(A1:A3)=12.5 before every profile/output artifact is removed",
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
    title: "The requested run root's real filesystem completes the required physical operations",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "the requested path is canonicalised through its nearest existing ancestor, proven " +
      "outside the immutable skill root, and its real volume completes random-byte " +
      "write, flush, close, read/compare, rename, stat, delete and verified cleanup. " +
      "Only a self-cleaning probe directory is created; the real run directory is not.",
    exclusion_reason: null,
  }),
  temp_root_writable: Object.freeze({
    title: "The effective temp root's real filesystem completes the required physical operations",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "independently of the run-root result, the effective temp volume completes the same " +
      "random-byte write, flush, close, read/compare, rename, stat, delete and verified " +
      "cleanup probe and records its volume identity.",
    exclusion_reason: null,
  }),
  disk_space_policy: Object.freeze({
    title: "Both physical roots have measured free-space headroom under the selected lane policy",
    obligation: "mandatory",
    lane: "always",
    checked_by:
      "the versioned disk-space policy loads its hash-bound measurement evidence and raw " +
      "manifests, selects evidence/workbook/combined demand, observes free bytes independently " +
      "on the work and temp volumes, and refuses missing candidate custody, lower overrides or " +
      "negative headroom. No fallback floor is invented.",
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
    obligation: "optional",
    lane: "always",
    checked_by:
      "installed_runtime_identity.resolveInstalledRuntimeIdentity reads the immutable " +
      "installation receipt, package archive and live package inventory without mutation.",
    exclusion_reason: null,
  }),
  installed_active_pointer: Object.freeze({
    title: "The active install pointer resolves to the package this run believes it is",
    obligation: "optional",
    lane: "always",
    checked_by:
      "installed_runtime_identity.resolveInstalledRuntimeIdentity reads and hash-verifies " +
      "the active pointer; it neither writes nor repoints it.",
    exclusion_reason: null,
  }),
  installed_rollback_package_present: Object.freeze({
    title: "A retained previous-known-good package is present to roll back to",
    obligation: "optional",
    lane: "always",
    checked_by:
      "installed_runtime_identity.resolveInstalledRuntimeIdentity reads the retained " +
      "rollback bytes and joins their SHA only when deriving PRODUCTION_ACTIVE.",
    exclusion_reason: null,
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

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalise(value))}\n`;
}

export function selectDiskSpacePolicyAuthority({
  mode,
  skillRoot,
  profilePolicy = null,
  callerPolicyPath = null,
  callerPolicySha256 = null,
  env = {},
}) {
  if (!new Set(["development", "candidate"]).has(mode)) {
    throw new Error(`Unsupported disk-space policy authority mode ${JSON.stringify(mode)}.`);
  }
  const callerOverridePresent = callerPolicyPath !== null || callerPolicySha256 !== null ||
    env.EXCEL_INFLOW_DISK_SPACE_POLICY !== undefined ||
    env.EXCEL_INFLOW_DISK_SPACE_POLICY_SHA256 !== undefined;
  const declaredPath = mode === "candidate"
    ? profilePolicy?.path ?? null
    : callerPolicyPath ?? env.EXCEL_INFLOW_DISK_SPACE_POLICY ?? profilePolicy?.path ?? null;
  const fromCaller = mode === "development" &&
    (callerPolicyPath !== null || env.EXCEL_INFLOW_DISK_SPACE_POLICY !== undefined);
  const policyPath = declaredPath === null
    ? null
    : path.isAbsolute(String(declaredPath))
      ? path.resolve(String(declaredPath))
      : path.resolve(fromCaller ? String(declaredPath) : path.join(skillRoot, String(declaredPath)));
  const expectedPolicySha256 = mode === "candidate"
    ? profilePolicy?.sha256 ?? null
    : callerPolicySha256 ?? env.EXCEL_INFLOW_DISK_SPACE_POLICY_SHA256 ?? profilePolicy?.sha256 ?? null;
  return Object.freeze({
    policy_path: policyPath,
    expected_policy_sha256: expectedPolicySha256,
    candidate_override_refused: mode === "candidate" && callerOverridePresent,
    authority: mode === "candidate" ? "deployment_profile_only" : fromCaller ? "development_caller" : "deployment_profile",
  });
}

export function serializeRuntimeDoctorReport(report) {
  return canonicalJson(report);
}

export function installedCapabilityReceiptDigest(receipt) {
  const { receipt_sha256: _ignored, ...body } = receipt;
  return sha256Hex(Buffer.from(canonicalJson(body), "utf8"));
}

export function serializeInstalledCapabilityReceipt(receipt) {
  return canonicalJson(receipt);
}

/**
 * Publish the doctor report and capability receipt as one content-addressed
 * generation, then expose that generation through one pointer written last.
 * Consumers must follow the pointer; caller-named report/receipt files are
 * compatibility aliases only and are never the custody authority.
 */
export async function writeInstalledCapabilityArtifactSet({
  artifactDirectory,
  report,
  pointerName = "host-preflight-current.json",
  reportAliasName = null,
  receiptAliasName = null,
  beforePointer = null,
  afterStage = null,
  durableOperations = {},
}) {
  const directory = path.resolve(String(artifactDirectory));
  const receipt = compileInstalledCapabilityReceipt(report);
  const reportBytes = serializeRuntimeDoctorReport(report);
  const receiptBytes = serializeInstalledCapabilityReceipt(receipt);
  const reportSha256 = sha256Hex(Buffer.from(reportBytes, "utf8"));
  const receiptBytesSha256 = sha256Hex(Buffer.from(receiptBytes, "utf8"));
  const rawAliases = [];
  if (reportAliasName !== null) rawAliases.push({ name: reportAliasName, value: report });
  if (receiptAliasName !== null) rawAliases.push({ name: receiptAliasName, value: receipt });
  if (
    rawAliases.length === 2 && rawAliases[0].name === rawAliases[1].name
  ) {
    throw new Error("Report and receipt aliases must use distinct filenames.");
  }
  const generation = await publishDurableJsonGeneration({
    directory,
    rawAliases,
    immutableArtifacts: [
      { key: "report", prefix: "runtime-doctor-report-", value: report },
      { key: "receipt", prefix: "installed-capability-receipt-", value: receipt },
    ],
    pointerName,
    pointerFactory: (immutable) => ({
      schema_version: "excel-inflow-host-preflight-pointer/1.1",
      status: receipt.status === "HOST_READY" ? "HOST_READY" : "HOST_REFUSED",
      report_file: immutable.report.file,
      report_sha256: immutable.report.sha256,
      receipt_file: immutable.receipt.file,
      receipt_sha256: immutable.receipt.sha256,
      receipt_self_sha256: receipt.receipt_sha256,
    }),
    operations: durableOperations,
    afterStage,
    beforePointer: beforePointer === null
      ? null
      : ({ root, aliases, immutable, pointer }) => beforePointer({
        reportPath: path.join(root, immutable.report.file),
        receiptPath: path.join(root, immutable.receipt.file),
        pointerPath: path.join(root, pointerName),
        pointer,
        aliases,
      }),
  });
  const reportPath = path.join(directory, generation.immutable.report.file);
  const receiptPath = path.join(directory, generation.immutable.receipt.file);
  const pointerPath = generation.pointer.target;
  const pointer = generation.pointer.value;
  if (
    generation.immutable.report.sha256 !== reportSha256 ||
    generation.immutable.receipt.sha256 !== receiptBytesSha256
  ) {
    throw new Error("Durable generation hashes disagree with the runtime report/receipt serializers.");
  }
  return {
    report,
    reportBytes,
    reportPath,
    receipt,
    receiptBytes,
    receiptPath,
    pointer,
    pointerPath,
    rawAliases: generation.aliases,
  };
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
    reason_code_fidelity: "exact",
    requested_reason_code: RUNTIME_DOCTOR_REQUESTED_REASON_CODE,
    reason_code_fidelity_note:
      "The registered reason code exactly assigns this failure to runtime_governance.",
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
  let executableSha256;
  try {
    await fs.access(execPath, fsConstants.X_OK | fsConstants.R_OK);
    executableSha256 = sha256Hex(await fs.readFile(execPath));
  } catch (error) {
    return typedCheck({
      precondition_id: "node_interpreter",
      result: "unsatisfied",
      reason: `The Node interpreter is not executable and readable by this process: ${error?.code ?? error?.message}.`,
      detail: { exec_path_absolute: true },
    });
  }
  return typedCheck({
    precondition_id: "node_interpreter",
    result: "satisfied",
    detail: {
      exec_path_absolute: true,
      resolved_executable: execPath,
      executable_sha256: executableSha256,
    },
  });
}

function checkNodeMinimumVersion(compatibilityContract) {
  const declared = compatibilityContract?.runtimes
    ?.find((entry) => entry.runtime_name === "Node")
    ?.minimum_version?.split(".").map(Number) ?? null;
  if (!Array.isArray(declared) || declared.length === 0) {
    return typedCheck({
      precondition_id: "node_minimum_version",
      result: "unknown",
      reason:
        "assets/runtime-compatibility-v1.json did not expose a parsable Node minimum. " +
        "COULD NOT CHECK — declared, not skipped. The running version is reported.",
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
  "import importlib, importlib.metadata, json, sys",
  "requested = json.loads(sys.argv[1])",
  "modules = {}",
  "module_versions = {}",
  "distribution_names = {}",
  "for item in requested:",
  "    name = item['module']",
  "    distribution = item['distribution']",
  "    distribution_names[name] = distribution",
  "    try:",
  "        importlib.import_module(name)",
  "        modules[name] = True",
  "    except Exception:",
  "        modules[name] = False",
  "        module_versions[name] = None",
  "        continue",
  "    try:",
  "        module_versions[name] = importlib.metadata.version(distribution)",
  "    except Exception:",
  "        module_versions[name] = None",
  "print(json.dumps({",
  "    'executable': sys.executable,",
  "    'version': list(sys.version_info[:3]),",
  "    'prefix_is_venv': sys.prefix != getattr(sys, 'base_prefix', sys.prefix),",
  "    'modules': modules,",
  "    'module_versions': module_versions,",
  "    'distribution_names': distribution_names,",
  "}, sort_keys=True))",
].join("\n");

async function probePython(resolved, moduleEntries, { timeout = 60_000 } = {}) {
  const requested = moduleEntries.map((entry) => ({
    module: entry.module,
    distribution: entry.distribution,
  }));
  const probe = await runProcessTree(
    resolved,
    ["-c", PYTHON_PROBE, JSON.stringify(requested)],
    { timeout },
  );
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

export function compileInstalledCapabilityReceipt(report) {
  const pythonCustody = report.checks.find(
    (entry) => entry.precondition_id === "python_interpreter_custody",
  );
  const pythonVersion = report.checks.find(
    (entry) => entry.precondition_id === "python_minimum_version",
  );
  const pythonClosure = report.checks.find(
    (entry) => entry.precondition_id === "python_single_interpreter_lane_closure",
  );
  const filingsProbe = report.checks.find(
    (entry) => entry.precondition_id === "filings_extraction_probe",
  );
  const inlineXbrlProbe = report.checks.find(
    (entry) => entry.precondition_id === "inline_xbrl_host_probe",
  );
  const sourceIdentity = report.checks.find(
    (entry) => entry.precondition_id === "active_source_identity",
  );
  const runtimeCompatibility = report.checks.find(
    (entry) => entry.precondition_id === "runtime_version_compatibility",
  );
  const libreOfficeCapability = report.checks.find(
    (entry) => entry.precondition_id === "libreoffice_workbook_capability",
  );
  const workRoot = report.checks.find(
    (entry) => entry.precondition_id === "work_root_writable",
  );
  const tempRoot = report.checks.find(
    (entry) => entry.precondition_id === "temp_root_writable",
  );
  const diskSpace = report.checks.find(
    (entry) => entry.precondition_id === "disk_space_policy",
  );
  const coversActivationLanes = ["evidence", "workbook"].every(
    (lane) => report.requested_lanes.includes(lane),
  );
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  const GIT_PATTERN = /^[a-f0-9]{40}$/;
  const attestedActivePackage =
    sourceIdentity?.detail?.closure_check_status === "match" &&
    sourceIdentity?.detail?.source_worktree_dirty === false &&
    sourceIdentity?.detail?.deployment_status === "installed_candidate" &&
    GIT_PATTERN.test(String(sourceIdentity?.detail?.source_commit ?? "")) &&
    GIT_PATTERN.test(String(sourceIdentity?.detail?.source_tree ?? "")) &&
    typeof sourceIdentity?.detail?.installation_identity === "string" &&
    sourceIdentity.detail.installation_identity.trim() !== "" &&
    SHA256_PATTERN.test(String(sourceIdentity?.detail?.active_runtime_code_closure_sha256 ?? "")) &&
    sourceIdentity.detail.active_runtime_code_closure_sha256 ===
      sourceIdentity?.detail?.declared_runtime_code_closure_sha256 &&
    SHA256_PATTERN.test(String(sourceIdentity?.detail?.complete_package_inventory_sha256 ?? "")) &&
    SHA256_PATTERN.test(String(sourceIdentity?.detail?.archive_sha256 ?? "")) &&
    SHA256_PATTERN.test(String(sourceIdentity?.detail?.release_package_attestation_sha256 ?? ""));
  const generatedEpoch = Date.parse(report.generated_at);
  const currentEpoch = Date.now();
  // Receipt bytes are a pure projection of the immutable report. Recompiling
  // the same report concurrently must converge on one content-addressed
  // generation, so the transaction evaluation timestamp is the report's own
  // generation timestamp rather than a second wall-clock read.
  const evaluatedEpoch = generatedEpoch;
  const expiresEpoch = generatedEpoch + ACTIVATION_FRESHNESS_MAX_AGE_SECONDS * 1000;
  const freshnessStatus = Number.isFinite(generatedEpoch) &&
    generatedEpoch - currentEpoch <= 300_000 && currentEpoch < expiresEpoch
    ? "FRESH"
    : "EXPIRED";
  const hostCapabilityReady =
    report.verdict === "HOST_READY" && coversActivationLanes &&
    filingsProbe?.result === "satisfied" && inlineXbrlProbe?.result === "satisfied" &&
    diskSpace?.result === "satisfied" && freshnessStatus === "FRESH";
  const candidateDiskReady =
    diskSpace?.detail?.evaluation?.status === "PASS" &&
    diskSpace.detail.evaluation.mode === "candidate" &&
    diskSpace.detail.evaluation.policy_evidence?.policy_sealed === true;
  const candidateSlotReady = hostCapabilityReady && attestedActivePackage && candidateDiskReady;
  const inlineXbrlProjection = inlineXbrlProbe?.result === "satisfied"
    ? Object.fromEntries(
      Object.entries(inlineXbrlProbe.detail ?? {}).filter(([key]) => key !== "compatibility_prerequisite"),
    )
    : null;
  const body = {
    schema_version: INSTALLED_CAPABILITY_RECEIPT_SCHEMA_VERSION,
    status: hostCapabilityReady ? "HOST_READY" : "REFUSED",
    readiness_scope: "inactive_candidate_slot_only",
    candidate_slot_ready: candidateSlotReady,
    candidate_slot_refusal_reason: candidateSlotReady
      ? null
      : !hostCapabilityReady
        ? "The full evidence+workbook host capability did not close."
        : sourceIdentity?.detail?.source_worktree_dirty === true
          ? "Host capability may be exercised, but activation requires a clean source snapshot; this package was compiled from a dirty worktree whose HEAD commit/tree do not identify all packaged bytes."
          : sourceIdentity?.detail?.deployment_status !== "installed_candidate" ||
              typeof sourceIdentity?.detail?.installation_identity !== "string"
            ? "Host capability may be exercised, but candidate-slot readiness requires a verified installed-candidate identity in an inactive slot."
          : !candidateDiskReady
            ? "Host capability may be exercised, but candidate-slot readiness requires a sealed measured candidate-mode disk-space policy and positive headroom on both physical roots."
            : "Host capability may be exercised, but candidate-slot readiness requires a verified external package attestation binding the declared closure, complete inventory and deterministic archive.",
    production_promotion_eligible: false,
    production_promotion_refusal_reason:
      "This receipt proves only inactive candidate-slot host readiness. Production promotion additionally requires candidate-bound fresh-session, IFRS, US-GAAP, broker-state, active-pointer read-back and post-activation receipts.",
    generated_at: report.generated_at,
    requested_lanes: report.requested_lanes,
    host: report.host,
    source_identity: {
      repository: sourceIdentity?.detail?.repository ?? null,
      source_commit: sourceIdentity?.detail?.source_commit ?? null,
      source_tree: sourceIdentity?.detail?.source_tree ?? null,
      source_worktree_dirty: sourceIdentity?.detail?.source_worktree_dirty ?? null,
      skill_version: sourceIdentity?.detail?.skill_version ?? null,
      package_mode: sourceIdentity?.detail?.package_mode ?? null,
      deployment_status: sourceIdentity?.detail?.deployment_status ?? null,
      closure_check_status: sourceIdentity?.detail?.closure_check_status ?? null,
      active_runtime_code_closure_sha256:
        sourceIdentity?.detail?.active_runtime_code_closure_sha256 ?? null,
      declared_runtime_code_closure_sha256:
        sourceIdentity?.detail?.declared_runtime_code_closure_sha256 ?? null,
      complete_package_inventory_sha256:
        sourceIdentity?.detail?.complete_package_inventory_sha256 ?? null,
      archive_sha256: sourceIdentity?.detail?.archive_sha256 ?? null,
      release_package_attestation_sha256:
        sourceIdentity?.detail?.release_package_attestation_sha256 ?? null,
      installation_identity: sourceIdentity?.detail?.installation_identity ?? null,
    },
    node: {
      executable: report.checks.find((entry) => entry.precondition_id === "node_interpreter")
        ?.detail?.resolved_executable ?? null,
      executable_sha256: report.checks.find((entry) => entry.precondition_id === "node_interpreter")
        ?.detail?.executable_sha256 ?? null,
      version: report.host.node_version,
    },
    python: {
      executable: pythonCustody?.detail?.resolved_executable ?? null,
      executable_sha256: pythonCustody?.detail?.executable_sha256 ?? null,
      version: pythonVersion?.detail?.running_version ?? null,
      required_modules: pythonClosure?.detail?.required ?? [],
      per_module: pythonClosure?.detail?.per_module ?? {},
      module_versions: pythonClosure?.detail?.module_versions ?? {},
    },
    workbook: {
      soffice_executable: report.checks.find(
        (entry) => entry.precondition_id === "soffice_available",
      )?.detail?.resolved_executable ?? null,
      soffice_executable_sha256: report.checks.find(
        (entry) => entry.precondition_id === "soffice_available",
      )?.detail?.executable_sha256 ?? null,
      soffice_version: report.checks.find(
        (entry) => entry.precondition_id === "soffice_available",
      )?.detail?.version ?? null,
      functional_capability:
        libreOfficeCapability?.result === "satisfied" ? libreOfficeCapability.detail : null,
    },
    runtime_compatibility:
      runtimeCompatibility?.result === "satisfied" ? runtimeCompatibility.detail : null,
    process_spawn: pythonClosure?.result === "satisfied" ? "PASS" : "FAIL",
    mandatory_filings_probe: filingsProbe?.result === "satisfied" ? filingsProbe.detail : null,
    inline_xbrl: inlineXbrlProjection,
    filesystem: {
      work_root: {
        result: workRoot?.result ?? "unknown",
        facts: workRoot?.detail ?? null,
      },
      temp_root: {
        result: tempRoot?.result ?? "unknown",
        facts: tempRoot?.detail ?? null,
      },
      disk_space_evaluation: diskSpace?.detail?.evaluation ?? null,
    },
    freshness: {
      policy: "activation_transaction",
      max_age_seconds: ACTIVATION_FRESHNESS_MAX_AGE_SECONDS,
      generated_at: report.generated_at,
      expires_at: Number.isFinite(expiresEpoch) ? new Date(expiresEpoch).toISOString() : report.generated_at,
      evaluated_at: new Date(evaluatedEpoch).toISOString(),
      status: freshnessStatus,
    },
    runtime_doctor_sha256: sha256Hex(Buffer.from(serializeRuntimeDoctorReport(report), "utf8")),
  };
  const receipt = {
    ...body,
    receipt_sha256: "",
  };
  receipt.receipt_sha256 = installedCapabilityReceiptDigest(receipt);
  const structural = validateJsonSchema(receipt, INSTALLED_CAPABILITY_RECEIPT_V13_SCHEMA);
  if (structural.length > 0) {
    throw new Error(`Installed capability receipt 1.3 failed schema compilation: ${structural.join("; ")}.`);
  }
  const semantic = validateInstalledCapabilityReceiptV13Semantics(receipt, {
    now: new Date(currentEpoch),
  });
  if (semantic.status !== "PASS") {
    throw new Error(
      `Installed capability receipt 1.3 failed semantic compilation: ${semantic.findings.map((item) => item.code).join(", ")}.`,
    );
  }
  return Object.freeze(receipt);
}

async function checkFilingsExtractionProbe({
  resolvedPython,
  skillRoot,
  tempRoot,
  timeout,
}) {
  const precondition_id = "filings_extraction_probe";
  if (!resolvedPython) {
    return typedCheck({
      precondition_id,
      result: "unknown",
      reason: "No resolved Python interpreter exists, so the mandatory filings route could not be executed.",
      detail: null,
    });
  }
  const fixturePath = path.join(
    skillRoot,
    "assets",
    "installed-filings-capability-probe-v1.json",
  );
  const responseSchemaPath = path.join(
    skillRoot,
    "assets",
    "filings-extraction-response-v1.schema.json",
  );
  const extractorPath = path.join(skillRoot, "scripts", "extract_filing_statements.py");
  const filingsControllerPath = path.join(skillRoot, "scripts", "run_filings_pipeline.mjs");
  let probeRoot = null;
  const started = Date.now();
  try {
    const fixtureBytes = await fs.readFile(fixturePath);
    const fixture = JSON.parse(fixtureBytes.toString("utf8"));
    const pdfBytes = Buffer.from(String(fixture.pdf_base64 ?? ""), "base64");
    const pdfSha256 = sha256Hex(pdfBytes);
    if (fixture.schema_version !== "installed-filings-capability-probe/1.0") {
      throw new Error("the installed filings fixture has the wrong schema_version");
    }
    if (pdfSha256 !== fixture.pdf_sha256) {
      throw new Error(
        `the installed filings fixture bytes drifted (${pdfSha256} != ${fixture.pdf_sha256})`,
      );
    }
    const [responseSchema, extractorBytes, filingsControllerBytes] = await Promise.all([
      readJsonIfPresent(responseSchemaPath),
      fs.readFile(extractorPath),
      fs.readFile(filingsControllerPath),
    ]);
    if (!responseSchema) throw new Error("the filings extraction response schema is absent");
    probeRoot = await fs.mkdtemp(path.join(tempRoot, "excel-inflow-filings-capability-"));
    const pdfPath = path.join(probeRoot, "probe-annual-report.pdf");
    const requestPath = path.join(probeRoot, "filings-request.json");
    const outputRoot = path.join(probeRoot, "output");
    await fs.writeFile(pdfPath, pdfBytes);
    const request = {
      schema_version: "filings-extraction-request/1.0",
      run_id: "installed_filings_capability_probe",
      documents: [{
        document_id: "probe-annual",
        attachment_id: "probe-annual",
        source_id: "probe_annual",
        path: pdfPath,
        media_type: "application/pdf",
        expected_sha256: pdfSha256,
      }],
      filing_facts: {
        entity_name: "Installed Capability Probe plc",
        reporting_currency: "GBP",
        units: "millions",
        fiscal_calendar_kind: "fixed_date",
        historical_periods: fixture.expected.periods,
        forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
        reported_gross_debt: 1,
        reported_cash: 1,
      },
    };
    const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`, "utf8");
    await fs.writeFile(requestPath, requestBytes);

    const openProbeSource = [
      "import fitz,json,sys",
      "doc=fitz.open(sys.argv[1])",
      "print(json.dumps({'page_count':doc.page_count,'text_chars':sum(len(p.get_text()) for p in doc)}))",
      "doc.close()",
    ].join("\n");
    const opened = await runProcessTree(
      resolvedPython,
      ["-c", openProbeSource, pdfPath],
      {
        cwd: skillRoot,
        timeout,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    if (!opened.ok) {
      throw new Error(
        `PyMuPDF could not open the frozen PDF (${opened.stderr || opened.error_code || `exit ${opened.code}`})`,
      );
    }
    const openedValue = JSON.parse(opened.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    if (
      openedValue.page_count !== fixture.expected.page_count ||
      !Number.isInteger(openedValue.text_chars) ||
      openedValue.text_chars <= 0
    ) {
      throw new Error("PyMuPDF opened the fixture but did not expose the declared pages and text");
    }

    const extracted = await runProcessTree(
      process.execPath,
      [
        filingsControllerPath,
        requestPath,
        "--out", outputRoot,
        "--filing-extraction-timeout-ms", String(Math.min(timeout, 480_000)),
      ],
      {
        cwd: skillRoot,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          EXCEL_INFLOW_NODE: process.execPath,
          EXCEL_INFLOW_PYTHON: resolvedPython,
          PYTHON: resolvedPython,
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    if (!extracted.ok) {
      throw new Error(
        `the shipped filings controller failed (${extracted.stderr || extracted.error_code || `exit ${extracted.code}`})`,
      );
    }
    const statePath = path.join(outputRoot, "filings-run-state.json");
    const stateBytes = await fs.readFile(statePath);
    const state = JSON.parse(stateBytes.toString("utf8"));
    if (
      state.schema_version !== "filings-run-state/1.0" ||
      state.pipeline_status !== "PASS" || state.user_blocking !== false ||
      state.blocker_class !== null || (state.tasks ?? []).length !== 0 ||
      typeof state.runtime_closure_sha256 !== "string"
    ) {
      throw new Error(`the filings controller did not close PASS: ${JSON.stringify(state.summary ?? state)}`);
    }
    for (const [name, artifactPath] of Object.entries(state.artifacts ?? {})) {
      const artifactBytes = await fs.readFile(artifactPath);
      if (sha256Hex(artifactBytes) !== state.artifact_sha256?.[name]) {
        throw new Error(`the filings controller state did not bind artifact ${name}`);
      }
    }
    const receiptPath = state.artifacts?.native_extraction_receipt;
    const bundlePath = state.artifacts?.filings_bundle;
    if (!receiptPath || !bundlePath) {
      throw new Error("the filings controller omitted its native receipt or evidence bundle");
    }
    const responsePath = path.join(path.dirname(receiptPath), "filings-extraction-response.json");
    const [receiptBytes, responseBytes, bundleBytes] = await Promise.all([
      fs.readFile(receiptPath),
      fs.readFile(responsePath),
      fs.readFile(bundlePath),
    ]);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const response = JSON.parse(responseBytes.toString("utf8"));
    const bundle = JSON.parse(bundleBytes.toString("utf8"));
    if (
      receipt.schema_version !== "filings-native-extraction-receipt/1.0" ||
      receipt.status !== "PASS" || receipt.findings?.length !== 0 ||
      receipt.request_sha256 !== sha256Hex(requestBytes) ||
      receipt.response_sha256 !== sha256Hex(responseBytes) ||
      receipt.document_count !== 1
    ) {
      throw new Error("the extractor receipt did not bind the request, response and one-document result");
    }
    const { bundle_sha256: declaredBundleSha256, ...bundleBody } = bundle;
    if (
      bundle.schema_version !== "filings-evidence-bundle/1.0" ||
      bundle.run_id !== request.run_id ||
      bundle.runtime_closure_sha256 !== state.runtime_closure_sha256 ||
      declaredBundleSha256 !== sha256Hex(Buffer.from(canonicalJson(bundleBody), "utf8"))
    ) {
      throw new Error("the filings evidence bundle did not bind the controller runtime and payload");
    }
    const schemaErrors = validateJsonSchema(response, responseSchema);
    if (schemaErrors.length > 0) {
      throw new Error(`the extraction response violated its shipped schema: ${schemaErrors.join("; ")}`);
    }
    const manifests = response.documents?.[0]?.face_statement_manifests ?? {};
    if (response.documents?.[0]?.raw_sha256 !== pdfSha256) {
      throw new Error("the extraction response did not bind the frozen PDF bytes");
    }
    const observed = {};
    for (const section of ["income_statement", "cash_flow"]) {
      const sectionManifests = manifests[section] ?? [];
      if (sectionManifests.length !== 1) {
        throw new Error(`${section} did not produce exactly one selected face-statement manifest`);
      }
      const manifest = sectionManifests[0];
      if (
        JSON.stringify(manifest.periods) !== JSON.stringify(fixture.expected.periods) ||
        manifest.units !== fixture.expected.units ||
        manifest.reporting_currency !== "GBP"
      ) {
        throw new Error(`${section} periods, units or reporting currency were not preserved`);
      }
      const rows = manifest.rows ?? [];
      const expectation = fixture.expected[section];
      if (rows.length < expectation.minimum_row_count) {
        throw new Error(`${section} retained ${rows.length} rows; expected at least ${expectation.minimum_row_count}`);
      }
      observed[section] = {
        row_count: rows.length,
        periods: manifest.periods,
        units: manifest.units,
        reporting_currency: manifest.reporting_currency,
        required_rows: {},
      };
      for (const [label, expectedRow] of Object.entries(expectation.required_rows)) {
        const row = rows.find((candidate) => candidate.raw_label === label);
        if (!row) throw new Error(`${section} omitted required row ${label}`);
        if (JSON.stringify(row.values) !== JSON.stringify(expectedRow.values)) {
          throw new Error(`${section}.${label} values were not preserved`);
        }
        if (JSON.stringify(row.value_states) !== JSON.stringify(expectedRow.value_states)) {
          throw new Error(`${section}.${label} zero/dash/blank states were not preserved`);
        }
        if (
          !Array.isArray(row.cells) || row.cells.length !== fixture.expected.periods.length ||
          row.cells.some((cell, index) =>
            cell.period !== fixture.expected.periods[index] ||
            cell.units !== fixture.expected.units ||
            cell.currency !== "GBP" ||
            cell.typed_state !== expectedRow.value_states[index] ||
            cell.normalized_value !== expectedRow.values[index] ||
            !Number.isInteger(cell.source_page) || cell.source_page < 1 ||
            cell.source_coordinates?.coordinate_system !== "pdf_points_top_left"
          )
        ) {
          throw new Error(`${section}.${label} cell-local period/unit/state/provenance was not preserved`);
        }
        observed[section].required_rows[label] = {
          values: row.values,
          value_states: row.value_states,
          cells: row.cells.map((cell) => ({
            period: cell.period,
            units: cell.units,
            currency: cell.currency,
            typed_state: cell.typed_state,
            normalized_value: cell.normalized_value,
            source_page: cell.source_page,
            source_coordinates: cell.source_coordinates,
          })),
        };
      }
    }
    const detail = {
      resolved_executable: resolvedPython,
      duration_ms: Date.now() - started,
      fixture_sha256: sha256Hex(fixtureBytes),
      pdf_sha256: pdfSha256,
      extractor_sha256: sha256Hex(extractorBytes),
      filings_controller_sha256: sha256Hex(filingsControllerBytes),
      request_sha256: sha256Hex(requestBytes),
      response_schema_sha256: sha256Hex(await fs.readFile(responseSchemaPath)),
      response_sha256: sha256Hex(responseBytes),
      extractor_receipt_sha256: sha256Hex(receiptBytes),
      filings_state_sha256: sha256Hex(stateBytes),
      filings_bundle_sha256: sha256Hex(bundleBytes),
      runtime_closure_sha256: state.runtime_closure_sha256,
      semantic_projection_sha256: sha256Hex(Buffer.from(canonicalJson(observed), "utf8")),
      page_count: openedValue.page_count,
      text_chars: openedValue.text_chars,
      periods: fixture.expected.periods,
      units: fixture.expected.units,
      observed,
      scratch_removed: false,
    };
    await fs.rm(probeRoot, { recursive: true, force: false });
    probeRoot = null;
    detail.scratch_removed = true;
    return typedCheck({
      precondition_id,
      result: "satisfied",
      detail,
    });
  } catch (error) {
    return typedCheck({
      precondition_id,
      result: "unsatisfied",
      reason: `The installed mandatory filings capability did not close: ${error?.message ?? String(error)}.`,
      detail: {
        resolved_executable: resolvedPython,
        duration_ms: Date.now() - started,
      },
    });
  } finally {
    if (probeRoot) await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
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

async function resolveBinaryExecutable(candidate, env) {
  const selected = String(candidate ?? "");
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const candidates = [];
  if (path.isAbsolute(selected) || selected.includes(path.sep)) {
    const base = path.resolve(selected);
    candidates.push(base, ...extensions.filter(Boolean).map((extension) => `${base}${extension}`));
  } else {
    for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const base = path.join(directory, selected);
      candidates.push(base, ...extensions.filter(Boolean).map((extension) => `${base}${extension}`));
    }
  }
  for (const possible of candidates) {
    try {
      await fs.access(possible, fsConstants.X_OK | fsConstants.R_OK);
      const stat = await fs.stat(possible);
      if (!stat.isFile()) continue;
      return await fs.realpath(possible);
    } catch {
      // Continue through the bounded declared/PATH candidate set.
    }
  }
  throw new Error(`Executable ${JSON.stringify(selected)} did not resolve to a readable regular file.`);
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
    let resolved;
    try {
      resolved = await resolveBinaryExecutable(candidate, env);
    } catch (error) {
      attempts.push({ candidate, error: error.message });
      continue;
    }
    const probe = await runProcessTree(resolved, ["--version"], { timeout, env });
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
          resolved_executable: resolved,
          executable_sha256: sha256Hex(await fs.readFile(resolved)),
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

async function checkWorkRootWritable(runRoot, skillRoot) {
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
  const probe = await probePhysicalFilesystem({
    requestedRoot: runRoot,
    skillRoot,
    purpose: "run_root",
  });
  return typedCheck({
    precondition_id: "work_root_writable",
    result: probe.ok ? "satisfied" : "unsatisfied",
    reason: probe.ok
      ? null
      : `The proposed run root did not complete the physical filesystem probe (${probe.facts.error ?? "incomplete operation"}).`,
    detail: probe.facts,
  });
}

async function checkTempRootWritable(tempRoot, skillRoot) {
  const probe = await probePhysicalFilesystem({
    requestedRoot: tempRoot,
    skillRoot,
    purpose: "temp_root",
  });
  return typedCheck({
    precondition_id: "temp_root_writable",
    result: probe.ok ? "satisfied" : "unsatisfied",
    reason: probe.ok
      ? null
      : `The effective temp root did not complete its independent physical filesystem probe (${probe.facts.error ?? "incomplete operation"}).`,
    detail: probe.facts,
  });
}

async function availableBytes(target) {
  if (typeof fs.statfs !== "function") {
    throw new Error("This Node build exposes no fs.statfs.");
  }
  const stats = await fs.statfs(target);
  const value = Number(stats.bsize) * Number(stats.bavail);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`fs.statfs returned an unsafe free-byte observation for ${target}.`);
  }
  return value;
}

async function checkDiskSpacePolicy({
  requestedLanes,
  workRootCheck,
  tempRootCheck,
  mode,
  policyPath,
  expectedPolicySha256,
  overrideMinFreeBytes,
  skillRoot,
  candidateOverrideRefused = false,
}) {
  const baseDetail = {
    mode,
    policy_path: policyPath,
    expected_policy_sha256: expectedPolicySha256,
    override_min_free_bytes: overrideMinFreeBytes,
    evaluation: null,
  };
  if (mode === "candidate" && candidateOverrideRefused) {
    return typedCheck({
      precondition_id: "disk_space_policy",
      result: "unsatisfied",
      reason: "Candidate mode refuses caller/environment disk-policy path or hash overrides; only the deployment-profile-bound path and SHA-256 are authoritative.",
      detail: { ...baseDetail, error_code: "DISK_SPACE_CANDIDATE_OVERRIDE_REFUSED" },
    });
  }
  if (!policyPath) {
    return typedCheck({
      precondition_id: "disk_space_policy",
      result: mode === "candidate" ? "unsatisfied" : "unknown",
      reason: mode === "candidate"
        ? "Candidate mode has no declared, hash-sealed disk-space policy."
        : "No measured disk-space policy was supplied by caller or deployment profile; development mode refuses to invent production floors.",
      detail: baseDetail,
    });
  }
  if (workRootCheck.result !== "satisfied" || tempRootCheck.result !== "satisfied") {
    return typedCheck({
      precondition_id: "disk_space_policy",
      result: "unknown",
      reason: "Free-space policy could not be evaluated because both physical filesystem probes did not close.",
      detail: baseDetail,
    });
  }
  try {
    const loadedPolicy = await loadDiskSpacePolicy({
      policyPath,
      expectedPolicySha256,
      mode,
      schemaPath: path.join(skillRoot, "assets", "disk-space-policy-v1.schema.json"),
    });
    const workFacts = workRootCheck.detail;
    const tempFacts = tempRootCheck.detail;
    const shared = workFacts.volume_identity.device_id === tempFacts.volume_identity.device_id;
    const workFree = await availableBytes(workFacts.canonical_probe_parent);
    const tempFree = shared
      ? workFree
      : await availableBytes(tempFacts.canonical_probe_parent);
    const evaluation = evaluateDiskSpacePolicy({
      loadedPolicy,
      mode,
      requestedLanes,
      observations: {
        work_root: { available_bytes: workFree, volume_identity: workFacts.volume_identity },
        temp_root: { available_bytes: tempFree, volume_identity: tempFacts.volume_identity },
      },
      overrideMinFreeBytes,
    });
    return typedCheck({
      precondition_id: "disk_space_policy",
      result: evaluation.status === "PASS" ? "satisfied" : "unsatisfied",
      reason: evaluation.status === "PASS"
        ? null
        : `Disk-space policy refused: ${evaluation.findings.map((item) => item.code).join(", ")}.`,
      detail: { ...baseDetail, evaluation },
    });
  } catch (error) {
    return typedCheck({
      precondition_id: "disk_space_policy",
      result: "unsatisfied",
      reason: `Disk-space policy custody or evaluation failed: ${error?.code ?? error?.message ?? String(error)}.`,
      detail: {
        ...baseDetail,
        error_code: error?.code ?? null,
        error_detail: error?.detail ?? null,
      },
    });
  }
}

async function checkActiveSourceIdentity(skillRoot, verifiedPlacement) {
  try {
    const identity = await resolveActiveSourceIdentity({
      skillRoot,
      overrides: verifiedPlacement?.source_identity_overrides ?? {},
    });
    const check = identity.active_runtime_code_closure_check;
    if (check?.status === "match") {
      return {
        check: typedCheck({
          precondition_id: "active_source_identity",
          result: "satisfied",
          detail: {
            closure_check_status: check.status,
            repository: identity.repository ?? null,
            source_commit: identity.source_commit ?? null,
            source_tree: identity.source_tree ?? null,
            source_worktree_dirty: identity.source_worktree_dirty ?? null,
            skill_version: identity.skill_version ?? null,
            package_mode: identity.package_mode ?? null,
            deployment_status: identity.deployment_status ?? null,
            active_runtime_code_closure_sha256: check.active_runtime_code_closure_sha256,
            declared_runtime_code_closure_sha256: check.declared_runtime_code_closure_sha256,
            complete_package_inventory_sha256:
              identity.product_identity?.package?.complete_package_inventory?.sha256 ?? null,
            archive_sha256: identity.product_identity?.package?.archive?.sha256 ?? null,
            release_package_attestation_sha256:
              identity.release_package_attestation_sha256 ?? null,
            installation_identity: identity.installation_identity ?? null,
            verified_runtime_placement: verifiedPlacement?.placement ?? null,
            installation_receipt_sha256:
              verifiedPlacement?.evidence_hashes.installation_receipt_sha256 ?? null,
            active_pointer_sha256:
              verifiedPlacement?.evidence_hashes.active_pointer_sha256 ?? null,
            production_promotion_receipt_sha256:
              verifiedPlacement?.evidence_hashes.production_promotion_receipt_sha256 ?? null,
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
            repository: identity.repository ?? null,
            source_commit: identity.source_commit ?? null,
            source_tree: identity.source_tree ?? null,
            source_worktree_dirty: identity.source_worktree_dirty ?? null,
            skill_version: identity.skill_version ?? null,
            package_mode: identity.package_mode ?? null,
            deployment_status: identity.deployment_status ?? null,
            active_runtime_code_closure_sha256: check.active_runtime_code_closure_sha256,
            complete_package_inventory_sha256:
              identity.product_identity?.package?.complete_package_inventory?.sha256 ?? null,
            archive_sha256: identity.product_identity?.package?.archive?.sha256 ?? null,
            release_package_attestation_sha256:
              identity.release_package_attestation_sha256 ?? null,
            installation_identity: identity.installation_identity ?? null,
            verified_runtime_placement: verifiedPlacement?.placement ?? null,
            installation_receipt_sha256:
              verifiedPlacement?.evidence_hashes.installation_receipt_sha256 ?? null,
            active_pointer_sha256:
              verifiedPlacement?.evidence_hashes.active_pointer_sha256 ?? null,
            production_promotion_receipt_sha256:
              verifiedPlacement?.evidence_hashes.production_promotion_receipt_sha256 ?? null,
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

function installedIdentityReadbackChecks(verifiedPlacement) {
  const placement = verifiedPlacement?.placement ?? null;
  const unavailable = (preconditionId, reason) => typedCheck({
    precondition_id: preconditionId,
    result: "not_applicable",
    reason,
    detail: { verified_runtime_placement: placement, attempted: false },
  });
  if (!placement || placement === "development_source") {
    const reason =
      "No verified installed placement was configured for this capability diagnostic; " +
      "runtime mode derivation still refuses any installed product route without it.";
    return [
      unavailable("installed_package_hash_readback", reason),
      unavailable("installed_active_pointer", reason),
      unavailable("installed_rollback_package_present", reason),
    ];
  }
  const common = {
    verified_runtime_placement: placement,
    installation_identity: verifiedPlacement.installation.installation_identity,
    installation_receipt_sha256:
      verifiedPlacement.evidence_hashes.installation_receipt_sha256,
    package_inventory_sha256:
      verifiedPlacement.local_package.package_inventory_sha256,
    active_pointer_sha256:
      verifiedPlacement.evidence_hashes.active_pointer_sha256,
  };
  const checks = [
    typedCheck({
      precondition_id: "installed_package_hash_readback",
      result: "satisfied",
      detail: common,
    }),
    typedCheck({
      precondition_id: "installed_active_pointer",
      result: "satisfied",
      detail: {
        ...common,
        selected_slot_id: verifiedPlacement.active_pointer.slot_id,
        installed_slot_id: verifiedPlacement.installation.slot_id,
        pointer_selects_this_package:
          verifiedPlacement.active_pointer.slot_id === verifiedPlacement.installation.slot_id,
      },
    }),
  ];
  if (placement === "production_active") {
    checks.push(typedCheck({
      precondition_id: "installed_rollback_package_present",
      result: "satisfied",
      detail: {
        ...common,
        previous_slot_id: verifiedPlacement.active_pointer.previous_slot_id,
        rollback_package_sha256: verifiedPlacement.active_pointer.rollback_package_sha256,
        production_promotion_receipt_sha256:
          verifiedPlacement.evidence_hashes.production_promotion_receipt_sha256,
      },
    }));
  } else {
    checks.push(unavailable(
      "installed_rollback_package_present",
      "An inactive candidate proves the currently active pointer selects another slot; " +
      "rollback-package custody becomes mandatory only before PRODUCTION_ACTIVE.",
    ));
  }
  return checks;
}

/**
 * Run every declared precondition check and compile the typed report.
 *
 * Nothing here performs issuer work: version prints, module imports, hash
 * reads, two independent self-cleaning physical probes and the frozen two-page
 * filing extraction capability probe.
 */
export async function runRuntimeDoctor({
  skillRoot = DEFAULT_SKILL_ROOT,
  env = process.env,
  lanes = RUNTIME_DOCTOR_LANES,
  runRoot = null,
  python = null,
  soffice = null,
  tempRoot = null,
  diskSpacePolicyPath = null,
  diskSpacePolicySha256 = null,
  minFreeBytes = null,
  installStateRoot = null,
  probeTimeoutMs = 60_000,
} = {}) {
  if (!Number.isFinite(Number(probeTimeoutMs)) || Number(probeTimeoutMs) <= 0) {
    throw new Error("probeTimeoutMs must be a positive finite aggregate host-probe lease");
  }
  const probeLeaseLimitMs = Number(probeTimeoutMs);
  const probeLeaseStartedNs = process.hrtime.bigint();
  const probeLeaseElapsedMs = () =>
    Number(process.hrtime.bigint() - probeLeaseStartedNs) / 1_000_000;
  const remainingProbeLeaseMs = (localCapMs) => Math.max(
    0,
    Math.floor(Math.min(Number(localCapMs), probeLeaseLimitMs - probeLeaseElapsedMs())),
  );
  const requestedLanes = normaliseLanes(lanes);
  const profile = await readJsonIfPresent(path.join(skillRoot, "assets", "deployment-profile.json"));
  let compatibilityContract = null;
  let compatibilityContractSha256 = null;
  let compatibilityContractError = null;
  try {
    const compatibilityPath = path.join(skillRoot, "assets", "runtime-compatibility-v1.json");
    compatibilityContractSha256 = sha256Hex(await fs.readFile(compatibilityPath));
    compatibilityContract = await loadRuntimeCompatibilityContract(compatibilityPath);
  } catch (error) {
    compatibilityContractError = String(error?.message ?? error);
  }
  const scriptsDir = path.join(skillRoot, "scripts");
  const effectiveTempRoot = tempRoot ?? env.TMPDIR ?? os.tmpdir();
  const profileDiskPolicy = profile?.runtime_disk_space_policy ?? null;
  const overrideMinFreeBytes = minFreeBytes === null && env.EXCEL_INFLOW_DOCTOR_MIN_FREE_BYTES === undefined
    ? null
    : Number(minFreeBytes ?? env.EXCEL_INFLOW_DOCTOR_MIN_FREE_BYTES);

  const checks = [];
  checks.push(await checkNodeInterpreter());
  checks.push(checkNodeMinimumVersion(compatibilityContract));
  checks.push(await checkVendoredNodeDependencies(profile, skillRoot));

  // Prove the complete active package closure before executing any shipped
  // child entry point. A drifted extractor must never run and only then be
  // rejected by a late identity check.
  let verifiedPlacement = null;
  let placementFailure = null;
  if (installStateRoot !== null && installStateRoot !== undefined) {
    try {
      verifiedPlacement = await resolveInstalledRuntimeIdentity({
        skillRoot,
        installStateRoot,
      });
    } catch (error) {
      placementFailure = error;
    }
  }
  let identity;
  if (placementFailure) {
    const check = typedCheck({
      precondition_id: "active_source_identity",
      result: "unsatisfied",
      reason:
        "The configured runtime placement, installation, active pointer, promotion or rollback " +
        `identity could not be verified: ${placementFailure?.code ?? placementFailure?.message ?? String(placementFailure)}`,
      detail: {
        verified_runtime_placement: null,
        error_code: placementFailure?.code ?? null,
        findings: placementFailure?.findings ?? null,
      },
    });
    checks.push(check);
    identity = { check, sourceHashes: {} };
  } else {
    identity = await checkActiveSourceIdentity(skillRoot, verifiedPlacement);
    checks.push(identity.check);
  }
  checks.push(...installedIdentityReadbackChecks(verifiedPlacement));
  // A compiled package that is being diagnosed before installation is not a
  // runtime candidate mode, but it must still prove the conservative
  // candidate disk floor. Runtime mode itself remains unreachable until the
  // external install-state reader verifies a slot and pointer.
  const diskPolicyMode = verifiedPlacement?.disk_space_policy_mode ??
    (identity.check?.detail?.closure_check_status === "match" ? "candidate" : "development");
  const diskPolicyAuthority = selectDiskSpacePolicyAuthority({
    mode: diskPolicyMode,
    skillRoot,
    profilePolicy: profileDiskPolicy,
    callerPolicyPath: diskSpacePolicyPath,
    callerPolicySha256: diskSpacePolicySha256,
    env,
  });
  const resolvedDiskPolicyPath = diskPolicyAuthority.policy_path;
  const expectedDiskPolicySha256 = diskPolicyAuthority.expected_policy_sha256;
  if (identity.check.result !== "satisfied") {
    const integrityReason =
      "The active package identity did not close, so no shipped Python entry point was executed.";
    for (const id of [
      "python_interpreter_custody",
      "python_minimum_version",
      "python_import_time_module_closure",
      "python_single_interpreter_lane_closure",
      "python_optional_module_closure",
    ]) {
      checks.push(typedCheck({
        precondition_id: id,
        result: "unknown",
        reason: integrityReason,
        detail: { subordinate_execution_attempted: false },
      }));
    }
    checks.push(typedCheck({
      precondition_id: "filings_extraction_probe",
      result: "unknown",
      reason: integrityReason,
      detail: { subordinate_execution_attempted: false },
    }));
    checks.push(typedCheck({
      precondition_id: "inline_xbrl_host_probe",
      result: requestedLanes.includes("evidence") ? "unknown" : "not_applicable",
      reason: requestedLanes.includes("evidence")
        ? integrityReason
        : "The evidence lane was not requested.",
      detail: { subordinate_execution_attempted: false },
    }));
    checks.push(typedCheck({
      precondition_id: "runtime_version_compatibility",
      result: "unknown",
      reason: integrityReason,
      detail: { subordinate_execution_attempted: false },
    }));
    for (const id of [
      "soffice_available",
      "libreoffice_workbook_capability",
      "workbook_font_metrics",
    ]) {
      checks.push(typedCheck({
        precondition_id: id,
        result: requestedLanes.includes("workbook") ? "unknown" : "not_applicable",
        reason: requestedLanes.includes("workbook")
          ? integrityReason
          : "The workbook lane was not requested.",
        detail: { subordinate_execution_attempted: false },
      }));
    }
    const workRootCheck = await checkWorkRootWritable(runRoot, skillRoot);
    const tempRootCheck = await checkTempRootWritable(effectiveTempRoot, skillRoot);
    checks.push(workRootCheck, tempRootCheck);
    checks.push(await checkDiskSpacePolicy({
      requestedLanes,
      workRootCheck,
      tempRootCheck,
      mode: diskPolicyMode,
      policyPath: resolvedDiskPolicyPath,
      expectedPolicySha256: expectedDiskPolicySha256,
      overrideMinFreeBytes,
      skillRoot,
      candidateOverrideRefused: diskPolicyAuthority.candidate_override_refused,
    }));
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

  // --- Python custody: resolve ONCE, then answer every python question from
  // that one resolved executable. -----------------------------------------
  let resolvedPython = null;
  try {
    const custody = await resolveDoctorPython({ env, explicit: python });
    resolvedPython = custody.resolved;
    const executableSha256 = sha256Hex(await fs.readFile(custody.resolved));
    checks.push(typedCheck({
      precondition_id: "python_interpreter_custody",
      result: "satisfied",
      detail: {
        selected: custody.selected,
        resolved_executable: custody.resolved,
        executable_sha256: executableSha256,
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
    ? [...new Map(
      [...laneClosure, ...optional]
        .sort((left, right) => left.module.localeCompare(right.module))
        .map((entry) => [entry.module, entry]),
    ).values()]
    : [];

  let probe = null;
  if (resolvedPython !== null && declared !== null) {
    const pythonProbeBudgetMs = remainingProbeLeaseMs(probeTimeoutMs);
    probe = pythonProbeBudgetMs > 0
      ? await probePython(resolvedPython, allModules, { timeout: pythonProbeBudgetMs })
      : { ok: false, error: "aggregate host-probe lease exhausted before Python capability probe" };
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
    const declaredMinimum = compatibilityContract?.runtimes
      ?.find((entry) => entry.runtime_name === "Python")
      ?.minimum_version?.split(".").map(Number) ?? null;
    const version = probe.value.version;
    if (!Array.isArray(declaredMinimum) || declaredMinimum.length === 0) {
      checks.push(typedCheck({
        precondition_id: "python_minimum_version",
        result: "unknown",
        reason:
          "assets/runtime-compatibility-v1.json declares no parsable Python minimum, so " +
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
        module_versions: Object.fromEntries(
          laneClosure.map((entry) => [entry.module, probe.value.module_versions?.[entry.module] ?? null]),
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

  // Resolve the selected office executable and evaluate every requested
  // runtime range before any real filing, workbook or Inline-XBRL API probe
  // executes. A known-incompatible runtime is evidence, never something the
  // doctor is allowed to execute and reject afterwards.
  let sofficeCheck = null;
  if (requestedLanes.includes("workbook")) {
    const sofficeBudgetMs = remainingProbeLeaseMs(30_000);
    sofficeCheck = sofficeBudgetMs > 0
      ? await checkSoffice({
        profile,
        explicit: soffice,
        env,
        timeout: sofficeBudgetMs,
      })
      : typedCheck({
        precondition_id: "soffice_available",
        result: "unknown",
        reason: "The aggregate host-probe lease expired before LibreOffice identity could be checked.",
        detail: { subordinate_execution_attempted: false },
      });
    checks.push(sofficeCheck);
  }

  let evidenceCompatibility = null;
  let workbookCompatibility = null;
  if (compatibilityContract === null) {
    checks.push(typedCheck({
      precondition_id: "runtime_version_compatibility",
      result: "unsatisfied",
      reason: `The runtime compatibility contract could not be loaded: ${compatibilityContractError}.`,
      detail: { contract_error: compatibilityContractError },
    }));
  } else {
    const observations = {
      Node: {
        version: process.version,
        import_name: null,
        distribution_name: "Node.js",
      },
    };
    if (resolvedPython !== null && probe?.ok) {
      observations.Python = {
        version: probe.value.version,
        executable: resolvedPython,
        import_name: null,
        distribution_name: "CPython",
      };
      for (const entry of compatibilityContract.runtimes.filter(
        (candidate) => candidate.runtime_kind === "python_distribution",
      )) {
        observations[entry.runtime_name] = {
          version: probe.value.module_versions?.[entry.import_name] ?? null,
          import_name: entry.import_name,
          distribution_name: entry.distribution_name,
          python_executable: resolvedPython,
        };
      }
    }
    if (sofficeCheck?.result === "satisfied") {
      observations.LibreOffice = {
        version: sofficeCheck.detail.version,
        import_name: null,
        distribution_name: "LibreOffice",
      };
    }
    const compatibility = evaluateRuntimeCompatibility({
      contract: compatibilityContract,
      observations,
      requestedLanes,
    });
    evidenceCompatibility = requestedLanes.includes("evidence")
      ? evaluateRuntimeCompatibility({
        contract: compatibilityContract,
        observations,
        requestedLanes: ["evidence"],
      })
      : null;
    workbookCompatibility = requestedLanes.includes("workbook")
      ? evaluateRuntimeCompatibility({
        contract: compatibilityContract,
        observations,
        requestedLanes: ["workbook"],
      })
      : null;
    checks.push(typedCheck({
      precondition_id: "runtime_version_compatibility",
      result: compatibility.status === "PASS" ? "satisfied" : "unsatisfied",
      reason: compatibility.status === "PASS"
        ? null
        : `Required runtime versions are absent, unparsable or outside the exercised ranges: ${
          compatibility.findings.map((finding) => `${finding.code}:${finding.runtime_name}`).join(", ")
        }.`,
      detail: {
        contract_schema_version: compatibilityContract.schema_version,
        contract_sha256: compatibilityContractSha256,
        status: compatibility.status,
        total_violations: compatibility.total_violations,
        evaluated_runtime_names: compatibility.evaluated_runtime_names,
        observations,
        findings: compatibility.findings,
        probe_lease: {
          limit_ms: probeLeaseLimitMs,
          elapsed_ms_at_compatibility: probeLeaseElapsedMs(),
          remaining_ms_at_compatibility: remainingProbeLeaseMs(probeLeaseLimitMs),
          clock: "monotonic_process_hrtime",
        },
      },
    }));
  }

  const filingProbeBudgetMs = remainingProbeLeaseMs(60_000);
  if (
    requestedLanes.includes("evidence") &&
    evidenceCompatibility?.status === "PASS" &&
    filingProbeBudgetMs > 0
  ) {
    checks.push(await checkFilingsExtractionProbe({
      resolvedPython,
      skillRoot,
      tempRoot: effectiveTempRoot,
      timeout: filingProbeBudgetMs,
    }));
  } else if (requestedLanes.includes("evidence")) {
    checks.push(typedCheck({
      precondition_id: "filings_extraction_probe",
      result: "unknown",
      reason:
        "The filing extraction probe was not executed because the shared evidence-lane " +
        "runtime compatibility prerequisite did not close or the aggregate host-probe lease expired.",
      detail: {
        subordinate_execution_attempted: false,
        compatibility_findings: evidenceCompatibility?.findings ?? [],
        probe_lease_remaining_ms: filingProbeBudgetMs,
      },
    }));
  } else {
    checks.push(typedCheck({
      precondition_id: "filings_extraction_probe",
      result: "not_applicable",
      reason: "The evidence lane was not requested, so the filing extractor is not needed.",
      detail: { requested_lanes: requestedLanes },
    }));
  }

  // --- Workbook-lane preconditions ---------------------------------------
  if (requestedLanes.includes("workbook")) {
    if (
      sofficeCheck.result === "satisfied" && resolvedPython !== null &&
      probe?.value?.modules?.openpyxl === true &&
      workbookCompatibility?.status === "PASS" &&
      remainingProbeLeaseMs(60_000) > 0
    ) {
      const workbookProbeBudgetMs = remainingProbeLeaseMs(60_000);
      const capability = await probeLibreOfficeWorkbookCapability({
        sofficeExecutable: sofficeCheck.detail.resolved_executable,
        sofficeVersion: sofficeCheck.detail.version,
        sofficeSha256: sofficeCheck.detail.executable_sha256,
        pythonExecutable: resolvedPython,
        scratchRoot: effectiveTempRoot,
        timeoutMs: workbookProbeBudgetMs,
        env: {
          ...env,
          EXCEL_INFLOW_PYTHON: resolvedPython,
          PYTHON: resolvedPython,
        },
      });
      checks.push(typedCheck({
        precondition_id: "libreoffice_workbook_capability",
        result: capability.status === "PASS" ? "satisfied" : "unsatisfied",
        reason: capability.status === "PASS"
          ? null
          : `The selected LibreOffice did not close the functional workbook probe: ${capability.failure}.`,
        detail: capability,
      }));
    } else {
      checks.push(typedCheck({
        precondition_id: "libreoffice_workbook_capability",
        result: "unknown",
        reason:
          "The functional workbook probe could not run because the selected soffice or the " +
          "one selected Python/openpyxl capability did not close.",
        detail: {
          soffice_result: sofficeCheck.result,
          selected_python: resolvedPython,
          openpyxl_importable: probe?.value?.modules?.openpyxl ?? null,
          runtime_compatibility_status: workbookCompatibility?.status ?? null,
          subordinate_execution_attempted: false,
          probe_lease_remaining_ms: remainingProbeLeaseMs(60_000),
        },
      }));
    }
    const fontProbeBudgetMs = remainingProbeLeaseMs(30_000);
    if (
      resolvedPython === null ||
      workbookCompatibility?.status !== "PASS" ||
      fontProbeBudgetMs <= 0
    ) {
      checks.push(typedCheck({
        precondition_id: "workbook_font_metrics",
        result: "unknown",
        reason:
          "The font resolver was not executed because the selected Python or workbook " +
          "runtime compatibility prerequisite did not close.",
        detail: { subordinate_execution_attempted: false },
      }));
    } else {
      checks.push(await checkFontMetrics({
        resolvedPython,
        scriptsDir,
        timeout: fontProbeBudgetMs,
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
      precondition_id: "libreoffice_workbook_capability",
      result: "not_applicable",
      reason: "The workbook lane was not requested, so no functional LibreOffice workbook probe is needed.",
      detail: { requested_lanes: requestedLanes },
    }));
    checks.push(typedCheck({
      precondition_id: "workbook_font_metrics",
      result: "not_applicable",
      reason: "The workbook lane was not requested, so no font metrics are needed.",
      detail: { requested_lanes: requestedLanes },
    }));
  }

  // Inline XBRL is an evidence-lane capability, not a workbook prerequisite.
  // It executes only after the shared compatibility owner has proved the one
  // selected Python and its lxml distribution in-range. The normal frozen
  // fixture uses benign dimensional data; contradiction is injected only by
  // the focused mutation suite.
  if (!requestedLanes.includes("evidence")) {
    checks.push(typedCheck({
      precondition_id: "inline_xbrl_host_probe",
      result: "not_applicable",
      reason: "The evidence lane was not requested, so Inline XBRL parsing is not needed.",
      detail: { requested_lanes: requestedLanes },
    }));
  } else if (evidenceCompatibility?.status !== "PASS") {
    checks.push(typedCheck({
      precondition_id: "inline_xbrl_host_probe",
      result: "unknown",
      reason:
        "The Inline XBRL host probe was not executed because the shared evidence-lane " +
        "Python/lxml compatibility prerequisite did not close.",
      detail: {
        subordinate_execution_attempted: false,
        compatibility_findings: evidenceCompatibility?.findings ?? [],
      },
    }));
  } else if (remainingProbeLeaseMs(30_000) <= 0) {
    checks.push(typedCheck({
      precondition_id: "inline_xbrl_host_probe",
      result: "unknown",
      reason: "The Inline XBRL host probe was not executed because the aggregate host-probe lease expired.",
      detail: {
        subordinate_execution_attempted: false,
        probe_lease_remaining_ms: 0,
      },
    }));
  } else {
    const inlineXbrlBudgetMs = remainingProbeLeaseMs(30_000);
    const inlineXbrl = await runInstalledInlineXbrlProbe({
      skillRoot,
      selectedPython: resolvedPython,
      tempRoot: effectiveTempRoot,
      timeoutMs: inlineXbrlBudgetMs,
    });
    checks.push(typedCheck({
      precondition_id: "inline_xbrl_host_probe",
      result: inlineXbrl.status === "PASS" ? "satisfied" : "unsatisfied",
      reason: inlineXbrl.status === "PASS"
        ? null
        : `The installed Inline XBRL capability did not close: ${inlineXbrl.reason_code}: ${inlineXbrl.reason}.`,
      detail: {
        ...inlineXbrl,
        compatibility_prerequisite: {
          status: evidenceCompatibility.status,
          total_violations: evidenceCompatibility.total_violations,
          evaluated_runtime_names: evidenceCompatibility.evaluated_runtime_names,
          findings: evidenceCompatibility.findings,
        },
      },
    }));
  }

  // --- Filesystem --------------------------------------------------------
  const workRootCheck = await checkWorkRootWritable(runRoot, skillRoot);
  const tempRootCheck = await checkTempRootWritable(effectiveTempRoot, skillRoot);
  checks.push(workRootCheck, tempRootCheck);
  checks.push(await checkDiskSpacePolicy({
    requestedLanes,
    workRootCheck,
    tempRootCheck,
    mode: diskPolicyMode,
    policyPath: resolvedDiskPolicyPath,
    expectedPolicySha256: expectedDiskPolicySha256,
    overrideMinFreeBytes,
    skillRoot,
    candidateOverrideRefused: diskPolicyAuthority.candidate_override_refused,
  }));

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
  RUNTIME_DOCTOR_DEFAULT_SKILL_ROOT,
  PRECONDITION_DECLARATIONS,
  PRECONDITION_IDS,
  typedCheck,
  compileRuntimeDoctorReport,
  assertRuntimeDoctorSatisfied,
  RuntimeDoctorRefusal,
  resolveDoctorPython,
  runRuntimeDoctor,
  compileInstalledCapabilityReceipt,
};
