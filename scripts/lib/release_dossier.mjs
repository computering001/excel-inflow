/**
 * P8.7 — the PORTABLE RELEASE CERTIFICATION DOSSIER: assembly, approvals,
 * expiry, and the waiver-register verdict.
 *
 * P8.0 split the certification evidence set into five portable-required classes
 * and two permanently excluded native ones, and made
 * `validateReleaseCertificationEvidence` tier-aware. That made a portable
 * dossier SPELLABLE. It did not make one EXIST: nothing gathered the evidence,
 * nothing bound it to bytes, nothing recorded who approved it or when the
 * approval stops counting. This module is that missing layer.
 *
 * Four things it is deliberately NOT:
 *
 *  1. It is not a second certification validator. The gate is
 *     `validateReleaseCertificationEvidence` (release_certification.mjs,
 *     P8.0's, imported and never edited). This module ASSEMBLES a dossier and
 *     then submits it to that validator; the validator's verdict is copied into
 *     the assembly record verbatim. Nothing here can make a dossier pass that
 *     the committed validator would fail.
 *
 *  2. It is not a repair layer. Every constructor refuses rather than corrects,
 *     and `validatePortableDossierAssembly` returns findings and changes
 *     nothing on disk.
 *
 *  3. It is not a place where a class can be declared satisfied by assertion.
 *     There is NO digest parameter anywhere in the assembly API. A satisfied
 *     class exists only as the return value of a function that read the
 *     artifact's bytes and hashed them itself, and supplying a digest is an
 *     error rather than a shortcut.
 *
 *  4. It is not a dispensation mechanism. See WAIVER_REGISTER below: the
 *     register is declared UNNECESSARY, and every spelling of a dispensation is
 *     refused at the API boundary in the same idiom P8.1 used for the
 *     comparison-exclusion refusal, so the verdict cannot be quietly reversed
 *     by a caller passing an option.
 *
 * A dossier has three states and exactly three, and the difference between the
 * second and the third is the whole point of the module:
 *
 *   CERTIFIABLE                  every portable-required class is satisfied by
 *                                bound bytes, the committed validator says
 *                                PASS, the tree is clean, an unexpired human
 *                                approval names this dossier.
 *   ASSEMBLED_NOT_CERTIFIABLE    honestly assembled, and at least one
 *                                portable-required class is a TYPED ABSENCE.
 *                                This is a REFUSAL, not a soft pass.
 *   REFUSED                      the assembly input itself was inadmissible.
 *
 * A typed absence is NOT an exclusion. P8.0's two native classes are permanent
 * declared exclusions with `revisit_condition: null`; a typed absence is a
 * temporary, reason-carrying, revisit-condition-bearing statement that this
 * host could not produce a producible artifact today. The two are structurally
 * prevented from wearing each other's clothes: `typedAbsence` refuses the
 * permanent-exclusion tokens, refuses a permanently excluded class outright,
 * and requires a non-null revisit condition — while `assembleEvidenceClass`
 * refuses a permanently excluded class as satisfied evidence.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  EXCLUDED_NATIVE_HOST,
  NATIVE_CERTIFIED_PACKAGE_MODE,
  PERMANENT_DECLARED_EXCLUSION,
  PHYSICAL_LANE_TERMINAL_DECLARATION,
  PORTABLE_CERTIFIED_PACKAGE_MODE,
} from "./identity_vocabulary.mjs";
import {
  PERMANENTLY_EXCLUDED_EVIDENCE,
  PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  PORTABLE_REQUIRED_EVIDENCE,
} from "./release_certification.mjs";
import {
  RELEASE_JOURNAL_FILENAME,
  appendReleaseJournalRecord,
  readReleaseJournal,
} from "./release_journal.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MINIMUM_REASON_LENGTH = 40;

export const PORTABLE_DOSSIER_SCHEMA_VERSION =
  "excel-inflow-portable-release-dossier/1.0";
export const PORTABLE_DOSSIER_PLAN_SCHEMA_VERSION =
  "excel-inflow-portable-release-dossier-plan/1.0";
export const PORTABLE_DOSSIER_APPROVAL_SCHEMA_VERSION =
  "excel-inflow-portable-release-dossier-approval/1.0";
export const PORTABLE_DOSSIER_WAIVER_REGISTER_SCHEMA_VERSION =
  "excel-inflow-portable-release-waiver-register/1.0";

export const CERTIFICATION_MANIFEST_FILENAME = "portable-certification-manifest.json";
export const ASSEMBLY_RECEIPT_FILENAME = "dossier-assembly-receipt.json";
export const WAIVER_REGISTER_FILENAME = "waiver-register.json";
export const ASSEMBLY_PLAN_FILENAME = "assembly-plan.json";
export const APPROVALS_DIRECTORY = "approvals";
export const APPROVALS_JOURNAL_FILENAME = RELEASE_JOURNAL_FILENAME;

export const ASSEMBLY_STATUSES = Object.freeze([
  "CERTIFIABLE",
  "ASSEMBLED_NOT_CERTIFIABLE",
  "REFUSED",
]);

export const CLASS_DISPOSITIONS = Object.freeze({
  SATISFIED_WITH_BOUND_ARTIFACT: "SATISFIED_WITH_BOUND_ARTIFACT",
  TYPED_ABSENCE: "TYPED_ABSENCE",
});

/**
 * The typed-absence vocabulary. Every member shares four flags, and they are
 * the flags that keep an absence from being read as either a pass or an
 * exclusion: it BLOCKS certification, it is NOT an exclusion, it is NOT a
 * waiver, and it IS pending — an absence names work that is genuinely still to
 * do, which is precisely the property P8.0's exclusions must never have.
 */
function absenceDisposition(description, defaultRevisit) {
  return Object.freeze({
    disposition: null,
    description,
    default_revisit_condition: defaultRevisit,
    blocks_certification: true,
    is_exclusion: false,
    is_waiver: false,
    is_pending: true,
  });
}

export const TYPED_ABSENCE_DISPOSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      ASSEMBLY_BLOCKED_UPSTREAM_BUILD_REFUSAL: absenceDisposition(
        "The artifact is producible in principle on a portable host, but a committed refusal upstream of the producer stops the pipeline before the artifact exists. The refusal is correct; the dossier records that it fired rather than routing around it.",
        "The upstream refusal is repaired at its own layer and the producer runs to completion at the certification commit.",
      ),
      ASSEMBLY_BLOCKED_HOST_TOOLCHAIN: absenceDisposition(
        "The producer exists and is portable, but this host does not satisfy its declared toolchain closure, so running it would half-work and fail deep in the lane. Detected by the runtime doctor before any expensive work started.",
        "The missing distributions are installed into ONE interpreter, the runtime doctor returns a satisfied verdict for the required lanes, and the producer runs at the certification commit.",
      ),
      ASSEMBLY_BLOCKED_ARTIFACT_ABSENT_FROM_REPOSITORY: absenceDisposition(
        "The producer requires a companion input that this repository does not contain at the certification commit — an immutable baseline, an authority corpus or a lineage ledger. The producer is not at fault and inventing the input would fabricate the evidence.",
        "The companion input is committed to the repository (or bound as a declared external custody artifact) and the producer runs at the certification commit.",
      ),
    }).map(([name, record]) => [name, Object.freeze({ ...record, disposition: name })]),
  ),
);

/**
 * The dispensation refusal, enforced in the API rather than in a comment.
 *
 * P8.0 established the honest position for the two native classes: they are
 * EXCLUSIONS, not waivers. This module establishes the other half — that a
 * portable-required class that could not be produced today is a TYPED ABSENCE
 * that BLOCKS certification, also not a waiver. Between them those two cases
 * exhaust every reason a class can fail to be satisfied, so a waiver has no
 * remaining subject. WAIVER_REGISTER records that verdict; this list makes it
 * unreversible by a caller. Every key of every object entering the assembly API
 * is scanned, at any depth.
 */
export const REFUSED_DISPENSATION_SPELLINGS = Object.freeze([
  "waiver", "waivers", "waive", "waived", "waiver_id", "waiver_reference",
  "dispensation", "dispensations", "exception", "exceptions", "exemption", "exempt",
  "grace", "grace_period", "accepted_risk", "risk_accepted", "risk_acceptance",
  "override", "overrides", "allow_missing", "allow_absent", "allow_unproven",
  "skip", "skipped", "tolerate", "tolerated", "ignore", "ignored", "excuse",
  "sign_off_override", "provisional_pass", "conditional_pass", "temporary_pass",
]);

const DISPENSATION_SET = new Set(REFUSED_DISPENSATION_SPELLINGS);
// Assigned immediately after WAIVER_REGISTER is declared; the scan exempts the
// register only by this exact digest.
let WAIVER_REGISTER_SHA256 = null;

/**
 * THE WAIVER-REGISTER VERDICT.
 *
 * Declared UNNECESSARY, and declared as data so the verdict travels with the
 * dossier instead of living only in a card. The argument is a closed-case
 * argument: there are exactly three ways a certification evidence class can
 * stand, each already has an honest home, and none of the three is a
 * dispensation. A register would therefore have to invent a fourth case, and
 * the only way to invent one is to reclassify one of the three — which is
 * exactly the move P8.0 refused for the native classes.
 */
export const WAIVER_REGISTER = Object.freeze({
  schema_version: PORTABLE_DOSSIER_WAIVER_REGISTER_SCHEMA_VERSION,
  register_disposition: "DECLARED_UNNECESSARY_ZERO_WAIVERS",
  waivers: Object.freeze([]),
  waiver_count: 0,
  admits_waivers: false,
  verdict:
    "A waiver register is UNNECESSARY for the portable certification tier and is deliberately not created as a populated register. It is declared here, empty and closed, so that 'zero waivers' is a recorded assertion rather than an absence a reader has to interpret.",
  closed_case_argument: Object.freeze([
    Object.freeze({
      case: "the class is satisfied",
      home: "manifest.evidence.<class>, hash-bound to the artifact bytes and accepted by validateReleaseCertificationEvidence at the portable tier",
      needs_dispensation: false,
      why: "Nothing is being skipped, so there is nothing to dispense from.",
    }),
    Object.freeze({
      case: "the class is unsatisfiable on this host by construction",
      home: "PERMANENTLY_EXCLUDED_EVIDENCE (release_certification.mjs, P8.0) and manifest.declared_exclusions",
      needs_dispensation: false,
      why: "A permanent declared exclusion is a statement about host capability, never permission to skip a reachable check. It carries is_waiver: false and revisit_condition: null by contract, and P8.0's validator refuses any dossier that spells it as a waiver or as pending. Registering it as a waiver would be the exact reclassification P8.0 refused: it would convert a permanent, honest, strictly-weaker claim into a temporary, dischargeable one that somebody could later be told to close.",
    }),
    Object.freeze({
      case: "the class is producible but was not produced at this commit",
      home: "the dossier's TYPED_ABSENCE_DISPOSITIONS record, carrying a reason, the blocking artifact's digest and a revisit condition",
      needs_dispensation: false,
      why: "A typed absence BLOCKS certification. It does not permit certification to proceed without the evidence, so it is the opposite of a waiver: a waiver's function is to let a gate pass while a check is missing, and nothing in this module can do that. The correct disposition is a refused certification with the blocker named, which is what the assembler produces.",
    }),
  ]),
  therefore:
    "The three cases are exhaustive for any member of NATIVE_REQUIRED_EVIDENCE, and none admits a dispensation, so a waiver register would have no legitimate subject. Creating one anyway would only be useful if a permanent exclusion or a blocking absence were filed in it, and both of those filings are refused in code.",
  enforcement:
    "REFUSED_DISPENSATION_SPELLINGS is scanned over every key, at every depth, of every object entering the assembly API and of the assembled dossier itself. A caller cannot introduce a waiver by option, by plan key, by approval field or by hand-editing the receipt and re-validating it.",
  freeze_criterion: "v3.7.7 freeze criterion 8 — 'portable dossier PASS, native/visual permanent declared exclusions, zero waivers'.",
});

WAIVER_REGISTER_SHA256 = canonicalSha256(WAIVER_REGISTER);
export const WAIVER_REGISTER_CANONICAL_SHA256 = WAIVER_REGISTER_SHA256;

/**
 * THE APPROVAL EXPIRY MODEL.
 *
 * Expiry is two-dimensional on purpose. Clock expiry alone would let an
 * approval outlive the thing it approved: the dossier could be reassembled
 * against new bytes and the old signature would still be sitting there. Subject
 * expiry alone would let a stale-but-still-matching approval certify a release
 * indefinitely. An approval must survive BOTH tests at the moment it is read.
 *
 * Renewal is append-only: a lapsed approval is never extended, re-dated or
 * edited. A new approval record is appended to the release journal, so the
 * lapse stays visible in the chain.
 */
export const APPROVAL_EXPIRY_MODEL = Object.freeze({
  model: "absolute_clock_expiry_AND_subject_binding",
  clock: "UTC",
  max_validity_days: 90,
  default_validity_days: 30,
  minimum_validity_days: 1,
  expiry_is_refusal: true,
  auto_renewal: false,
  renewal:
    "A lapsed approval is never extended, re-dated or edited in place. A new approval document is written and a new record is appended to the release journal, so the lapse and the re-approval are both permanently visible in the chain.",
  invalidated_by: Object.freeze([
    "expires_at has passed at the moment the dossier is read",
    "the dossier assembly receipt digest the approval names has changed",
    "the runtime-code closure the approval names has changed",
    "the certification tier the approval names has changed",
  ]),
  automation_may_approve: false,
  automation_may_record: true,
  authority:
    "P8.6a's discipline, unchanged: automation records, humans authorise. An approval is an authorising act, so an approval whose actor.kind is \"automation\" is refused at creation and again at validation.",
  journal:
    "The approvals RECORD is P8.6a's hash-chained append-only release journal (scripts/lib/release_journal.mjs), reused rather than duplicated. Approvals are appended with event_type \"attest\".",
  journal_event_type_note:
    "RELEASE_JOURNAL_EVENT_TYPES has no \"approve\" member and release_journal.mjs is not this package's file to widen, so a dossier approval is journalled as \"attest\" with a detail string that names it a portable-certification-dossier approval and binds the approval document's digest. The event vocabulary should gain a first-class approval member when its owner next opens it; until then the conflation is declared here rather than hidden.",
});

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalSha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Refuse a dispensation anywhere in a structure, at any depth, by key OR by
 * string value. Throws — this is an input contract, not a finding.
 */
export function assertNoDispensation(value, label = "input") {
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    // ONE exemption, and it is not a hole: the code-declared waiver register
    // itself, recognised by its canonical digest rather than by its position or
    // its key name. The register's whole content is the words "zero waivers"
    // said carefully, so it necessarily contains the vocabulary it forbids.
    // Because the exemption is keyed on the exact bytes, a register with a
    // waiver ADDED to it is not exempt: it fails this scan, and it fails the
    // separate equality check in validatePortableDossierAssembly as well.
    if (canonicalSha256(node) === WAIVER_REGISTER_SHA256) return;
    for (const [key, child] of Object.entries(node)) {
      const normalised = String(key).toLowerCase();
      if (DISPENSATION_SET.has(normalised)) {
        throw new Error(
          [
            `${label} carries a dispensation key ${JSON.stringify(key)} at ${trail}.`,
            "The portable certification tier admits no waiver, exception, override or dispensation of any kind:",
            "a class is either satisfied by bound bytes, a PERMANENT DECLARED EXCLUSION (release_certification.mjs's register), or a TYPED ABSENCE that blocks certification.",
            "See WAIVER_REGISTER.closed_case_argument for why there is no fourth case.",
          ].join(" "),
        );
      }
      walk(child, `${trail}.${key}`);
    }
  };
  walk(value, label);
  return value;
}

function assertReason(reason, label) {
  if (typeof reason !== "string" || reason.trim().length < MINIMUM_REASON_LENGTH) {
    throw new Error(
      `${label} must state, in at least ${MINIMUM_REASON_LENGTH} characters, what is actually missing; a token reason is refused.`,
    );
  }
  return reason.trim();
}

function assertPortableRequiredClass(evidenceClass, label) {
  if (evidenceClass in PERMANENTLY_EXCLUDED_EVIDENCE) {
    throw new Error(
      [
        `${label}: evidence class ${JSON.stringify(evidenceClass)} is a PERMANENT DECLARED EXCLUSION`,
        `(${PERMANENTLY_EXCLUDED_EVIDENCE[evidenceClass].satisfiability}).`,
        "It can never be assembled as satisfied evidence and can never be recorded as a typed absence,",
        "because a typed absence is pending work and an exclusion is not. It belongs only in the dossier's",
        "declared_exclusions block, which the assembler writes from the code-declared register.",
      ].join(" "),
    );
  }
  if (!PORTABLE_REQUIRED_EVIDENCE.includes(evidenceClass)) {
    throw new Error(
      `${label}: ${JSON.stringify(evidenceClass)} is not a portable-required certification evidence class (${PORTABLE_REQUIRED_EVIDENCE.join(", ")}).`,
    );
  }
  return evidenceClass;
}

/**
 * Digest an artifact by READING IT. There is deliberately no digest parameter
 * anywhere in this module's assembly API: the only way a digest enters a dossier
 * is by this function hashing bytes it read from disk itself. Ten spellings of a
 * caller-supplied digest are refused by name so the omission reads as a rule
 * rather than an oversight.
 */
export async function digestArtifact(artifactPath, options = {}) {
  for (const forbidden of [
    "sha256", "digest", "hash", "expected_sha256", "expectedSha256",
    "checksum", "sha", "sha256sum", "declared_sha256", "artifact_sha256",
  ]) {
    if (forbidden in (options ?? {})) {
      throw new Error(
        `digestArtifact does not accept a caller-supplied ${JSON.stringify(forbidden)}. A dossier binds bytes it read, never a digest it was handed; a supplied digest would let assembly certify an artifact nobody opened.`,
      );
    }
  }
  const absolute = path.resolve(artifactPath);
  const bytes = await fs.readFile(absolute);
  return Object.freeze({
    path: absolute,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.length,
  });
}

function relativise(absolute, root) {
  const relative = path.relative(root, absolute);
  return relative.startsWith("..") ? absolute : relative.split(path.sep).join("/");
}

/**
 * A dossier must be self-contained. An evidence report cited from outside the
 * dossier directory is a report the dossier cannot vouch for: the certification
 * validator resolves the report's own internal file bindings relative to the
 * report's directory, so a report that lives elsewhere brings a companion tree
 * the dossier neither names nor hashes. Same rule the native-Excel validator
 * already applies to its state workbooks.
 */
function assertUnderDossier(absolute, dossierRoot, label) {
  const root = path.resolve(dossierRoot);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `${label} lives outside the dossier directory (${absolute}). A portable dossier must be self-contained: cite evidence that sits under ${root}, so the dossier hashes everything it depends on.`,
    );
  }
  return absolute;
}

/**
 * Assemble ONE portable-required class as SATISFIED. The only way to reach the
 * SATISFIED_WITH_BOUND_ARTIFACT disposition.
 *
 * Three things must all hold, and each is a separate refusal: the file must
 * exist and be readable (so a digest exists at all), it must parse as JSON (an
 * evidence report the validator cannot read is not evidence), and it must
 * declare the same runtime-code closure the dossier is bound to (an artifact
 * from another closure is another package's evidence).
 */
export async function assembleEvidenceClass({
  evidenceClass,
  artifactPath,
  runtimeCodeClosureSha256,
  root,
}) {
  assertPortableRequiredClass(evidenceClass, "assembleEvidenceClass");
  if (!SHA256.test(String(runtimeCodeClosureSha256 ?? ""))) {
    throw new Error("assembleEvidenceClass requires the lowercase SHA-256 runtime-code closure the dossier is bound to.");
  }
  const artifact = await digestArtifact(artifactPath);
  assertUnderDossier(artifact.path, root, `Evidence report for ${evidenceClass}`);
  let report;
  try {
    report = JSON.parse(await fs.readFile(artifact.path, "utf8"));
  } catch (error) {
    throw new Error(
      `Evidence class ${evidenceClass} cites ${artifact.path}, which does not parse as JSON (${error.message}). An evidence report the certification validator cannot read is not evidence.`,
    );
  }
  const declaredClosure =
    report?.certified_runtime_code_closure_sha256 ?? report?.certified_closure_sha256 ?? null;
  if (declaredClosure !== runtimeCodeClosureSha256) {
    throw new Error(
      [
        `Evidence class ${evidenceClass} is bound to runtime-code closure ${JSON.stringify(declaredClosure)}`,
        `but the dossier is bound to ${runtimeCodeClosureSha256}.`,
        "Evidence produced against different bytes belongs to a different package and is refused at assembly,",
        "before the certification validator would refuse it again.",
      ].join(" "),
    );
  }
  assertNoDispensation(report, `evidence report for ${evidenceClass}`);
  return Object.freeze({
    evidence_class: evidenceClass,
    disposition: CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT,
    artifact: Object.freeze({
      path: relativise(artifact.path, root),
      sha256: artifact.sha256,
      byte_length: artifact.byte_length,
    }),
    certified_runtime_code_closure_sha256: declaredClosure,
    absence: null,
  });
}

/**
 * Record ONE portable-required class as a TYPED ABSENCE.
 *
 * An absence must earn every one of its fields: a declared disposition from the
 * vocabulary, a reason of real length, a non-null revisit condition, and a
 * BLOCKING ARTIFACT — the digest of the captured refusal, doctor report or
 * probe transcript that demonstrates the block. That last requirement is what
 * separates a typed absence from a shrug: the absence itself is hash-bound to
 * evidence that the block is real.
 */
export async function typedAbsence({
  evidenceClass,
  disposition,
  reason,
  revisitCondition,
  blockingArtifactPath,
  blockedAtLayer,
  root,
}) {
  assertPortableRequiredClass(evidenceClass, "typedAbsence");
  const declared = TYPED_ABSENCE_DISPOSITIONS[disposition];
  if (!declared) {
    throw new Error(
      `Typed absence for ${evidenceClass} declares disposition ${JSON.stringify(disposition)}, which is not in the declared vocabulary (${Object.keys(TYPED_ABSENCE_DISPOSITIONS).join(", ")}).`,
    );
  }
  const statedReason = assertReason(reason, `Typed absence for ${evidenceClass}`);
  if (typeof revisitCondition !== "string" || revisitCondition.trim().length < MINIMUM_REASON_LENGTH) {
    throw new Error(
      [
        `Typed absence for ${evidenceClass} must carry a revisit condition of at least ${MINIMUM_REASON_LENGTH} characters.`,
        "A typed absence is PENDING work on a producible class; if there were genuinely no condition under which it",
        `could be produced it would be a permanent declared exclusion, and only ${Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE).join(" and ")} are.`,
      ].join(" "),
    );
  }
  if (typeof blockedAtLayer !== "string" || !blockedAtLayer.trim()) {
    throw new Error(`Typed absence for ${evidenceClass} must name the earliest responsible layer that blocked it.`);
  }
  const blocking = await digestArtifact(blockingArtifactPath);
  assertUnderDossier(blocking.path, root, `Blocking evidence for ${evidenceClass}`);
  return Object.freeze({
    evidence_class: evidenceClass,
    disposition: CLASS_DISPOSITIONS.TYPED_ABSENCE,
    artifact: null,
    certified_runtime_code_closure_sha256: null,
    absence: Object.freeze({
      absence_disposition: declared.disposition,
      absence_disposition_description: declared.description,
      reason: statedReason,
      revisit_condition: revisitCondition.trim(),
      blocked_at_layer: blockedAtLayer.trim(),
      blocking_evidence: Object.freeze({
        path: relativise(blocking.path, root),
        sha256: blocking.sha256,
        byte_length: blocking.byte_length,
      }),
      // The four flags that stop an absence being read as a pass or as an
      // exclusion. They are copied from the declared vocabulary, never from the
      // caller, so an absence cannot claim not to block certification.
      blocks_certification: declared.blocks_certification,
      is_exclusion: declared.is_exclusion,
      is_waiver: declared.is_waiver,
      is_pending: declared.is_pending,
    }),
  });
}

function exclusionRecordFor(name) {
  const source = PERMANENTLY_EXCLUDED_EVIDENCE[name];
  return {
    evidence_class: source.evidence_class,
    satisfiability: source.satisfiability,
    exclusion_disposition: source.exclusion_disposition,
    excluded_from_portable_gate: source.excluded_from_portable_gate,
    is_pending: source.is_pending,
    is_waiver: source.is_waiver,
    revisit_condition: source.revisit_condition,
    required_host_capability: source.required_host_capability,
    exclusion_reason: source.exclusion_reason,
  };
}

/**
 * The P8.0-contract portable manifest — and ONLY when every portable-required
 * class is satisfied.
 *
 * The manifest is the object `validateReleaseCertificationEvidence` reads at the
 * portable tier, and P8.0's contract refuses unknown keys, so nothing from this
 * module's own layer (assembly status, absences, approvals, the waiver verdict)
 * may appear in it. That constraint is a feature: the certification manifest
 * stays exactly the shape the committed validator declared, and everything P8.7
 * adds lives in the assembly receipt beside it.
 *
 * A manifest is never written for an incomplete dossier. A manifest listing four
 * of five classes would be a dossier presenting a portable-required class as
 * pending, which is precisely what must not exist.
 */
export function buildCertificationManifest({ classes, runtimeCodeClosureSha256 }) {
  const missing = PORTABLE_REQUIRED_EVIDENCE.filter(
    (name) => classes[name]?.disposition !== CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT,
  );
  if (missing.length > 0) {
    throw new Error(
      [
        `Refusing to mint a portable certification manifest: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not satisfied by a bound artifact.`,
        "An incomplete manifest would present a portable-required class as pending. The honest artifact for an",
        "incomplete dossier is the assembly receipt with its typed absences and NO certification manifest.",
      ].join(" "),
    );
  }
  const evidence = {};
  for (const name of PORTABLE_REQUIRED_EVIDENCE) {
    const record = classes[name];
    if (!SHA256.test(String(record.artifact?.sha256 ?? ""))) {
      throw new Error(`Evidence class ${name} is marked satisfied with no artifact digest; assembly refuses to mint a manifest from it.`);
    }
    evidence[name] = { path: record.artifact.path, sha256: record.artifact.sha256 };
  }
  return {
    schema_version: PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    package_mode: PORTABLE_CERTIFIED_PACKAGE_MODE,
    certified_runtime_code_closure_sha256: runtimeCodeClosureSha256,
    evidence,
    declared_exclusions: Object.fromEntries(
      Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE).map((name) => [name, exclusionRecordFor(name)]),
    ),
  };
}

/**
 * One approval document. Human actor mandatory, validity window bounded, and
 * the subject bound by digest so the approval cannot outlive the dossier it
 * approved.
 */
export function createPortableDossierApproval({
  approvalId,
  actor,
  approvedAt,
  validityDays = APPROVAL_EXPIRY_MODEL.default_validity_days,
  statement,
  subject,
}) {
  assertNoDispensation({ actor, subject, statement }, "portable dossier approval");
  if (typeof approvalId !== "string" || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(approvalId)) {
    throw new Error("A portable dossier approval requires an approval_id of 3-64 lowercase characters.");
  }
  if (!isPlainObject(actor) || actor.kind !== "human" || typeof actor.identity !== "string" || !actor.identity.trim()) {
    throw new Error(
      [
        "A portable certification approval requires a named HUMAN actor.",
        "P8.6a's discipline is unchanged: automation records, humans authorise —",
        "and an approval is an authorising act, so actor.kind must be \"human\" with a real identity.",
      ].join(" "),
    );
  }
  if (!RFC3339_UTC.test(String(approvedAt ?? ""))) {
    throw new Error("A portable dossier approval requires approved_at as an RFC 3339 UTC instant.");
  }
  if (!Number.isInteger(validityDays) ||
      validityDays < APPROVAL_EXPIRY_MODEL.minimum_validity_days ||
      validityDays > APPROVAL_EXPIRY_MODEL.max_validity_days) {
    throw new Error(
      `A portable dossier approval's validity must be an integer between ${APPROVAL_EXPIRY_MODEL.minimum_validity_days} and ${APPROVAL_EXPIRY_MODEL.max_validity_days} days; got ${JSON.stringify(validityDays)}. An unbounded or perpetual approval is refused: an approval that never expires is not an approval, it is a default.`,
    );
  }
  assertReason(statement, "A portable dossier approval's statement");
  if (!isPlainObject(subject) ||
      !SHA256.test(String(subject.assembly_receipt_sha256 ?? "")) ||
      !SHA256.test(String(subject.runtime_code_closure_sha256 ?? "")) ||
      subject.certification_tier !== PORTABLE_CERTIFIED_PACKAGE_MODE) {
    throw new Error(
      "A portable dossier approval must bind its subject: the assembly receipt digest, the runtime-code closure digest, and the portable certification tier. An approval that names no subject approves everything.",
    );
  }
  const expiresAt = new Date(Date.parse(approvedAt) + validityDays * 86400000)
    .toISOString()
    .replace(/\.\d{3}Z$/, ".000Z");
  const body = {
    schema_version: PORTABLE_DOSSIER_APPROVAL_SCHEMA_VERSION,
    approval_id: approvalId,
    certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    actor: { kind: actor.kind, identity: actor.identity.trim() },
    approved_at: approvedAt,
    validity_days: validityDays,
    expires_at: expiresAt,
    expiry_model: APPROVAL_EXPIRY_MODEL.model,
    statement: statement.trim(),
    subject: {
      assembly_receipt_sha256: subject.assembly_receipt_sha256,
      runtime_code_closure_sha256: subject.runtime_code_closure_sha256,
      certification_tier: subject.certification_tier,
      source_commit: subject.source_commit ?? null,
    },
  };
  return Object.freeze({ ...body, approval_sha256: canonicalSha256(body) });
}

/**
 * Validate one approval AT A MOMENT, against a SUBJECT. Findings, never repair,
 * and never a renewal: an expired approval is reported expired.
 */
export function validatePortableDossierApproval(approval, { now, subject = null } = {}) {
  const findings = [];
  const push = (id, message, detail = {}) => findings.push({ id, message, ...detail });
  if (!isPlainObject(approval)) {
    return { status: "FAIL", expired: null, findings: [{ id: "approval", message: "The approval is not an object." }] };
  }
  try {
    assertNoDispensation(approval, "approval");
  } catch (error) {
    push("approval.dispensation", error.message);
  }
  if (approval.schema_version !== PORTABLE_DOSSIER_APPROVAL_SCHEMA_VERSION) {
    push("approval.schema_version", `An approval must declare schema_version ${PORTABLE_DOSSIER_APPROVAL_SCHEMA_VERSION}.`, { actual: approval.schema_version ?? null });
  }
  const { approval_sha256: declaredHash, ...body } = approval;
  if (declaredHash !== canonicalSha256(body)) {
    push("approval.approval_sha256", "The approval's self-hash does not match its body; the approval was edited after signing.");
  }
  if (approval.actor?.kind !== "human" || !String(approval.actor?.identity ?? "").trim()) {
    push("approval.actor", "A certification approval must carry a named human actor; automation records, humans authorise.", { actual: approval.actor?.kind ?? null });
  }
  if (!RFC3339_UTC.test(String(approval.approved_at ?? "")) || !RFC3339_UTC.test(String(approval.expires_at ?? ""))) {
    push("approval.instants", "approved_at and expires_at must both be RFC 3339 UTC instants.");
  }
  if (!Number.isInteger(approval.validity_days) ||
      approval.validity_days > APPROVAL_EXPIRY_MODEL.max_validity_days ||
      approval.validity_days < APPROVAL_EXPIRY_MODEL.minimum_validity_days) {
    push("approval.validity_days", `An approval's validity must be between ${APPROVAL_EXPIRY_MODEL.minimum_validity_days} and ${APPROVAL_EXPIRY_MODEL.max_validity_days} days.`, { actual: approval.validity_days ?? null });
  }
  const evaluatedAt = String(now ?? new Date().toISOString());
  if (!RFC3339_UTC.test(evaluatedAt)) {
    push("approval.now", "An approval can only be evaluated against an RFC 3339 UTC instant; a missing clock is refused rather than assumed to be inside the window.");
  }
  let expired = null;
  if (RFC3339_UTC.test(String(approval.expires_at ?? "")) && RFC3339_UTC.test(evaluatedAt)) {
    expired = Date.parse(evaluatedAt) >= Date.parse(approval.expires_at);
    if (expired) {
      push("approval.expired", "The approval has EXPIRED and is refused. An expired approval is never silently renewed, extended or re-dated; append a new approval to the release journal.", {
        expires_at: approval.expires_at,
        evaluated_at: evaluatedAt,
      });
    }
    if (Date.parse(evaluatedAt) < Date.parse(approval.approved_at ?? evaluatedAt)) {
      push("approval.not_yet_effective", "The approval is dated in the future relative to the moment it is being read.");
    }
  }
  if (subject) {
    for (const key of ["assembly_receipt_sha256", "runtime_code_closure_sha256", "certification_tier"]) {
      if (subject[key] !== undefined && approval.subject?.[key] !== subject[key]) {
        push(`approval.subject.${key}`, "The approval names a different subject than the dossier being read; an approval does not survive the thing it approved changing.", {
          expected: subject[key],
          actual: approval.subject?.[key] ?? null,
        });
      }
    }
  }
  return { status: findings.length === 0 ? "PASS" : "FAIL", expired, findings };
}

/**
 * Append one approval to P8.6a's release journal. The journal is reused
 * verbatim: hash-chained, append-only, O_APPEND + fsync, byte-prefix verified,
 * refusing to append onto a journal that does not validate. Nothing here
 * reimplements any of that.
 */
export async function appendPortableDossierApproval({
  journalPath,
  policy,
  approval,
  release,
  recordedAt,
}) {
  const verdict = validatePortableDossierApproval(approval, { now: recordedAt });
  if (verdict.status !== "PASS") {
    throw new Error(
      `Refusing to journal an approval that does not validate: ${verdict.findings.map((f) => f.message).join("; ")}`,
    );
  }
  if (release?.package_mode !== PORTABLE_CERTIFIED_PACKAGE_MODE) {
    throw new Error(
      `A portable certification approval must be journalled against package_mode ${PORTABLE_CERTIFIED_PACKAGE_MODE}; ${JSON.stringify(release?.package_mode ?? null)} would record the approval against a tier whose evidence this dossier does not hold.`,
    );
  }
  return appendReleaseJournalRecord({
    journalPath,
    policy,
    event: {
      event_type: "attest",
      recorded_at: recordedAt,
      actor: { kind: approval.actor.kind, identity: approval.actor.identity },
      release,
      detail: [
        "portable_certification_dossier_approval",
        `approval_id=${approval.approval_id}`,
        `approval_sha256=${approval.approval_sha256}`,
        `assembly_receipt_sha256=${approval.subject.assembly_receipt_sha256}`,
        `expires_at=${approval.expires_at}`,
      ].join(" "),
    },
  });
}

/**
 * Read the approvals record: the journal, plus every approval document it
 * names, evaluated at `now` against `subject`.
 *
 * An ABSENT journal is a first-class answer, not an error: P8.6a's
 * readReleaseJournal already returns PASS with zero records for a journal that
 * does not exist, and zero approvals is exactly the honest state of a dossier
 * nobody has approved yet.
 */
export async function readApprovalsRecord({ dossierRoot, now, subject = null, policy = null }) {
  const journalPath = path.join(dossierRoot, APPROVALS_JOURNAL_FILENAME);
  const journal = await readReleaseJournal(journalPath, { policy });
  const approvalsDir = path.join(dossierRoot, APPROVALS_DIRECTORY);
  let filenames = [];
  try {
    filenames = (await fs.readdir(approvalsDir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const approvals = [];
  const findings = [];
  for (const name of filenames) {
    const target = path.join(approvalsDir, name);
    let document;
    try {
      document = JSON.parse(await fs.readFile(target, "utf8"));
    } catch (error) {
      findings.push({ id: `approval.${name}.read`, message: `Approval document could not be read as JSON: ${error.message}` });
      continue;
    }
    const verdict = validatePortableDossierApproval(document, { now, subject });
    const journalled = journal.records.some((record) =>
      typeof record?.detail === "string" && record.detail.includes(`approval_sha256=${document.approval_sha256}`));
    if (!journalled) {
      findings.push({
        id: `approval.${name}.journal`,
        message: "The approval document is not recorded in the append-only release journal; an approval that is not in the chain is not an approval.",
      });
    }
    approvals.push({
      path: relativise(target, dossierRoot),
      approval_id: document?.approval_id ?? null,
      actor: document?.actor ?? null,
      approved_at: document?.approved_at ?? null,
      expires_at: document?.expires_at ?? null,
      approval_sha256: document?.approval_sha256 ?? null,
      journalled,
      status: verdict.status,
      expired: verdict.expired,
      findings: verdict.findings,
    });
    findings.push(...verdict.findings.map((entry) => ({ ...entry, id: `approval.${name}.${entry.id}` })));
  }
  const valid = approvals.filter((entry) => entry.status === "PASS" && entry.journalled);
  return {
    journal: {
      path: relativise(journalPath, dossierRoot),
      present: journal.record_count > 0,
      status: journal.status,
      record_count: journal.record_count,
      tip_record_hash: journal.tip_record_hash,
      findings: [...journal.findings],
    },
    approvals,
    valid_approval_count: valid.length,
    approved: valid.length > 0,
    findings,
  };
}

/**
 * ASSEMBLE. The one writer of a portable dossier.
 *
 * The order matters and is the whole safety argument:
 *   1. Every plan entry becomes either a satisfied class (digest computed from
 *      bytes, here, by us) or a typed absence (blocking evidence digested).
 *   2. A certification manifest is minted ONLY if all five are satisfied.
 *   3. The manifest, if minted, is handed to the COMMITTED validator at the
 *      portable tier and its verdict is copied in verbatim.
 *   4. The status is derived from those facts, never supplied.
 */
export async function assemblePortableDossier({
  root,
  dossierRoot,
  plan,
  identity,
  certificationValidator,
  assembledAt,
  assembler,
}) {
  assertNoDispensation(plan, "assembly plan");
  if (plan?.schema_version !== PORTABLE_DOSSIER_PLAN_SCHEMA_VERSION) {
    throw new Error(`An assembly plan must declare schema_version ${PORTABLE_DOSSIER_PLAN_SCHEMA_VERSION}.`);
  }
  if (!SHA256.test(String(identity?.runtime_code_closure_sha256 ?? ""))) {
    throw new Error("Assembly requires the live runtime-code closure identity of the tree being certified.");
  }
  if (!GIT_OID.test(String(identity?.source_commit ?? "")) || !GIT_OID.test(String(identity?.source_tree ?? ""))) {
    throw new Error("Assembly requires the source commit and tree of the tree being certified.");
  }
  if (!RFC3339_UTC.test(String(assembledAt ?? ""))) {
    throw new Error("Assembly requires assembled_at as an RFC 3339 UTC instant.");
  }
  const closure = identity.runtime_code_closure_sha256;
  const planned = plan.classes ?? {};
  for (const name of Object.keys(planned)) {
    assertPortableRequiredClass(name, "assembly plan");
  }
  const missingFromPlan = PORTABLE_REQUIRED_EVIDENCE.filter((name) => !(name in planned));
  if (missingFromPlan.length > 0) {
    throw new Error(
      `The assembly plan says nothing about ${missingFromPlan.join(", ")}. Every portable-required class must be planned as either an artifact or a typed absence; silence about a class is refused, because silence is how a gate set quietly shrinks.`,
    );
  }

  const classes = {};
  for (const name of PORTABLE_REQUIRED_EVIDENCE) {
    const entry = planned[name];
    const hasArtifact = Boolean(typeof entry?.artifact === "string" && entry.artifact.trim());
    const hasAbsence = isPlainObject(entry?.absence);
    if (hasArtifact === hasAbsence) {
      throw new Error(
        `Assembly plan entry for ${name} must declare EXACTLY ONE of "artifact" (a produced evidence report) or "absence" (a typed absence). ${hasArtifact ? "Both were declared" : "Neither was declared"}.`,
      );
    }
    if (hasArtifact) {
      classes[name] = await assembleEvidenceClass({
        evidenceClass: name,
        artifactPath: path.resolve(root, entry.artifact),
        runtimeCodeClosureSha256: closure,
        root: dossierRoot,
      });
    } else {
      classes[name] = await typedAbsence({
        evidenceClass: name,
        disposition: entry.absence.absence_disposition,
        reason: entry.absence.reason,
        revisitCondition: entry.absence.revisit_condition,
        blockingArtifactPath: path.resolve(root, entry.absence.blocking_evidence),
        blockedAtLayer: entry.absence.blocked_at_layer,
        root: dossierRoot,
      });
    }
  }

  const satisfied = PORTABLE_REQUIRED_EVIDENCE.filter(
    (name) => classes[name].disposition === CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT);
  const absent = PORTABLE_REQUIRED_EVIDENCE.filter(
    (name) => classes[name].disposition === CLASS_DISPOSITIONS.TYPED_ABSENCE);

  let manifest = null;
  let manifestRefusal = null;
  let certificationReceipt = null;
  if (absent.length === 0) {
    manifest = buildCertificationManifest({ classes, runtimeCodeClosureSha256: closure });
  } else {
    manifestRefusal = [
      `No portable certification manifest was minted: ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} a typed absence.`,
      "A manifest naming fewer than the five portable-required classes would present a portable-required class as",
      "pending, which the portable dossier contract refuses by design. The absence is recorded here instead.",
    ].join(" ");
  }

  const receipt = {
    schema_version: PORTABLE_DOSSIER_SCHEMA_VERSION,
    assembly_status: null,
    certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    native_tier_not_claimed: NATIVE_CERTIFIED_PACKAGE_MODE,
    assembled_at: assembledAt,
    assembler: {
      kind: "automation",
      identity: assembler ?? "scripts/assemble_release_dossier.mjs",
      authority_note:
        "Automation assembles and records; it never approves. See APPROVAL_EXPIRY_MODEL.automation_may_approve.",
    },
    identity: {
      repository: identity.repository ?? null,
      source_commit: identity.source_commit,
      source_tree: identity.source_tree,
      skill_version: identity.skill_version ?? null,
      runtime_code_closure_sha256: closure,
      runtime_code_closure_file_count: identity.runtime_code_closure_file_count ?? null,
      runtime_code_closure_identity_source: identity.runtime_code_closure_identity_source ?? null,
      worktree_clean: identity.worktree_clean ?? null,
      worktree_status_sha256: identity.worktree_status_sha256 ?? null,
    },
    plan: {
      schema_version: plan.schema_version,
      sha256: canonicalSha256(plan),
    },
    required_evidence: [...PORTABLE_REQUIRED_EVIDENCE],
    satisfied_classes: satisfied,
    typed_absence_classes: absent,
    classes,
    declared_exclusions: Object.fromEntries(
      Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE).map((name) => [name, exclusionRecordFor(name)]),
    ),
    physical_lane_terminal_declaration: PHYSICAL_LANE_TERMINAL_DECLARATION,
    waiver_register: WAIVER_REGISTER,
    approval_expiry_model: APPROVAL_EXPIRY_MODEL,
    certification_manifest: manifest
      ? { present: true, filename: CERTIFICATION_MANIFEST_FILENAME, sha256: null }
      : { present: false, filename: null, sha256: null, refusal_reason: manifestRefusal },
    certification_receipt: null,
    // The approvals RECORD deliberately does not live inside this receipt: an
    // approval binds this receipt's FILE DIGEST as its subject, so a receipt
    // that contained its own approvals could never be hashed. What lives here
    // is the contract for finding and reading them.
    approvals: {
      record: `${APPROVALS_JOURNAL_FILENAME} (P8.6a's hash-chained append-only release journal, reused) plus ${APPROVALS_DIRECTORY}/*.json`,
      subject_binding:
        "Each approval names the SHA-256 of this receipt file as written. Re-assembling the dossier changes that digest and every prior approval stops applying — expiry by identity as well as by clock.",
      human_approval_required: true,
      automation_may_approve: APPROVAL_EXPIRY_MODEL.automation_may_approve,
      expiry_model: APPROVAL_EXPIRY_MODEL.model,
      max_validity_days: APPROVAL_EXPIRY_MODEL.max_validity_days,
    },
  };

  if (manifest && typeof certificationValidator === "function") {
    certificationReceipt = await certificationValidator({ manifest });
    receipt.certification_receipt = certificationReceipt;
  } else if (!manifest) {
    receipt.certification_receipt = {
      status: "NOT_RUN",
      reason:
        "The certification validator was not run: there is no manifest to submit, because the dossier is incomplete. This is a REFUSAL, not a pass — no portable certification exists for this tree.",
    };
  }

  receipt.assembly_status = absent.length === 0 && certificationReceipt?.status === "PASS"
    ? "CERTIFIABLE"
    : "ASSEMBLED_NOT_CERTIFIABLE";
  return { receipt, manifest, classes };
}

/**
 * VALIDATE an assembled dossier that is already on disk — the half of the
 * invariant that has to survive the assembler being long gone.
 *
 * It re-reads every cited artifact and re-hashes it, so a dossier whose
 * evidence bytes changed after assembly is refused. It does not repair, does
 * not re-digest into the record, and does not accept the record's own claim
 * about anything it can check for itself.
 */
export async function validatePortableDossierAssembly({
  receipt,
  receiptSha256 = null,
  dossierRoot,
  now = null,
  policy = null,
  requireApproval = false,
}) {
  const findings = [];
  const push = (id, message, detail = {}) => findings.push({ id, message, ...detail });
  if (!isPlainObject(receipt)) {
    return { status: "FAIL", total_violations: 1, findings: [{ id: "receipt", message: "The assembly receipt is not an object." }] };
  }
  try {
    assertNoDispensation(receipt, "assembly receipt");
  } catch (error) {
    push("receipt.dispensation", error.message);
  }
  if (receipt.schema_version !== PORTABLE_DOSSIER_SCHEMA_VERSION) {
    push("receipt.schema_version", `A dossier assembly receipt must declare schema_version ${PORTABLE_DOSSIER_SCHEMA_VERSION}.`, { actual: receipt.schema_version ?? null });
  }
  if (!ASSEMBLY_STATUSES.includes(receipt.assembly_status)) {
    push("receipt.assembly_status", `assembly_status must be one of ${ASSEMBLY_STATUSES.join(", ")}.`, { actual: receipt.assembly_status ?? null });
  }
  if (receipt.certification_tier !== PORTABLE_CERTIFIED_PACKAGE_MODE) {
    push("receipt.certification_tier", `A portable dossier receipt must declare certification_tier ${PORTABLE_CERTIFIED_PACKAGE_MODE}; a portable dossier may never present itself as ${NATIVE_CERTIFIED_PACKAGE_MODE}.`, { actual: receipt.certification_tier ?? null });
  }
  const closure = receipt.identity?.runtime_code_closure_sha256 ?? null;
  if (!SHA256.test(String(closure ?? ""))) {
    push("receipt.identity.runtime_code_closure_sha256", "A dossier must bind the runtime-code closure it certifies.");
  }

  const classes = isPlainObject(receipt.classes) ? receipt.classes : {};
  for (const name of Object.keys(classes)) {
    if (name in PERMANENTLY_EXCLUDED_EVIDENCE) {
      // The class-record block is the SATISFIED/PENDING surface. A permanently
      // excluded class appearing here at all is the reclassification P8.0
      // refused, whichever disposition it wears.
      push(`class.${name}.excluded_class_present`, `Evidence class ${name} is a PERMANENT DECLARED EXCLUSION (${EXCLUDED_NATIVE_HOST}) and may never appear among the dossier's assembled classes — not as satisfied evidence and not as a pending typed absence. It belongs only in declared_exclusions.`, {
        disposition: classes[name]?.disposition ?? null,
      });
      continue;
    }
    if (!PORTABLE_REQUIRED_EVIDENCE.includes(name)) {
      push(`class.${name}.unknown`, `${JSON.stringify(name)} is not a declared certification evidence class.`);
    }
  }
  for (const name of PORTABLE_REQUIRED_EVIDENCE) {
    if (!(name in classes)) {
      push(`class.${name}.missing`, `Portable-required evidence class ${name} is absent from the dossier's class records; the portable gate set is not optional and an unmentioned class is not an absence, it is a hole.`);
    }
  }

  for (const [name, record] of Object.entries(classes)) {
    if (name in PERMANENTLY_EXCLUDED_EVIDENCE) continue;
    const prefix = `class.${name}`;
    if (!isPlainObject(record)) {
      push(prefix, "The class record is not an object.");
      continue;
    }
    if (record.evidence_class !== name) {
      push(`${prefix}.evidence_class`, "The class record does not name itself.", { actual: record.evidence_class ?? null });
    }
    if (record.disposition === CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT) {
      const artifact = record.artifact;
      if (!isPlainObject(artifact) || typeof artifact.path !== "string" || !SHA256.test(String(artifact.sha256 ?? ""))) {
        push(`${prefix}.artifact`, "A class marked satisfied MUST carry a path and a lowercase SHA-256 artifact digest. A satisfied class with no digest is an assertion, not evidence, and is refused.", {
          artifact: artifact ?? null,
        });
        continue;
      }
      if (record.absence !== null && record.absence !== undefined) {
        push(`${prefix}.absence`, "A satisfied class must not also carry an absence record.");
      }
      const absolute = path.resolve(dossierRoot, artifact.path);
      let actual = null;
      try {
        actual = (await digestArtifact(absolute)).sha256;
      } catch (error) {
        push(`${prefix}.artifact.read`, "The cited evidence artifact could not be read; a dossier that cannot re-read its own evidence certifies nothing.", { path: absolute, error: error.message });
        continue;
      }
      if (actual !== artifact.sha256) {
        push(`${prefix}.artifact.sha256`, "The cited artifact's BYTES HAVE CHANGED since assembly. The dossier is refused: it names evidence that no longer exists in the form it was assembled from.", {
          path: absolute,
          recorded: artifact.sha256,
          actual,
        });
        continue;
      }
      let report = null;
      try {
        report = JSON.parse(await fs.readFile(absolute, "utf8"));
      } catch (error) {
        push(`${prefix}.artifact.json`, `The cited evidence artifact does not parse as JSON: ${error.message}`);
        continue;
      }
      const declared = report?.certified_runtime_code_closure_sha256 ?? report?.certified_closure_sha256 ?? null;
      if (declared !== closure) {
        push(`${prefix}.artifact.closure`, "The cited evidence is bound to a different runtime-code closure than the dossier.", { expected: closure, actual: declared });
      }
    } else if (record.disposition === CLASS_DISPOSITIONS.TYPED_ABSENCE) {
      if (record.artifact !== null && record.artifact !== undefined) {
        push(`${prefix}.artifact`, "A typed absence must not carry an artifact binding; an absence with a digest is a satisfied class in disguise.");
      }
      const absence = record.absence;
      if (!isPlainObject(absence)) {
        push(`${prefix}.absence`, "A class that is not satisfied MUST carry a typed absence record; an untyped absence is refused.");
        continue;
      }
      const declared = TYPED_ABSENCE_DISPOSITIONS[absence.absence_disposition];
      if (!declared) {
        push(`${prefix}.absence.disposition`, `Typed absence disposition ${JSON.stringify(absence.absence_disposition ?? null)} is not in the declared vocabulary.`);
      }
      if (typeof absence.reason !== "string" || absence.reason.trim().length < MINIMUM_REASON_LENGTH) {
        push(`${prefix}.absence.reason`, `A typed absence must state what is missing in at least ${MINIMUM_REASON_LENGTH} characters.`);
      }
      if (typeof absence.revisit_condition !== "string" || absence.revisit_condition.trim().length < MINIMUM_REASON_LENGTH) {
        push(`${prefix}.absence.revisit_condition`, "A typed absence must carry a revisit condition; an absence with no revisit condition is claiming to be a permanent exclusion, and only the two native-host classes are.");
      }
      if (absence.blocks_certification !== true) {
        push(`${prefix}.absence.blocks_certification`, "A typed absence must carry blocks_certification: true. An absence that does not block certification is a dispensation wearing another name.", { actual: absence.blocks_certification ?? null });
      }
      if (absence.is_exclusion !== false || absence.satisfiability === EXCLUDED_NATIVE_HOST ||
          absence.exclusion_disposition === PERMANENT_DECLARED_EXCLUSION) {
        push(`${prefix}.absence.is_exclusion`, `A typed absence on a portable-required class may never be dressed as a permanent declared exclusion; only ${Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE).join(" and ")} are excluded, and they are excluded by host capability rather than by circumstance.`);
      }
      if (absence.is_waiver !== false) {
        push(`${prefix}.absence.is_waiver`, "A typed absence is not a waiver; the portable tier admits no waivers at all.");
      }
      if (absence.is_pending !== true) {
        push(`${prefix}.absence.is_pending`, "A typed absence on a producible class IS pending work and must say so; that is exactly what distinguishes it from a permanent exclusion.", { actual: absence.is_pending ?? null });
      }
      const blocking = absence.blocking_evidence;
      if (!isPlainObject(blocking) || typeof blocking.path !== "string" || !SHA256.test(String(blocking.sha256 ?? ""))) {
        push(`${prefix}.absence.blocking_evidence`, "A typed absence must be hash-bound to captured evidence that the block is real — a refusal transcript, a doctor report or a probe receipt.");
      } else {
        const absolute = path.resolve(dossierRoot, blocking.path);
        try {
          const actual = (await digestArtifact(absolute)).sha256;
          if (actual !== blocking.sha256) {
            push(`${prefix}.absence.blocking_evidence.sha256`, "The blocking evidence bytes have changed since assembly.", { path: absolute, recorded: blocking.sha256, actual });
          }
        } catch (error) {
          push(`${prefix}.absence.blocking_evidence.read`, "The blocking evidence could not be read.", { path: absolute, error: error.message });
        }
      }
    } else {
      push(`${prefix}.disposition`, `A class record must be ${CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT} or ${CLASS_DISPOSITIONS.TYPED_ABSENCE}.`, { actual: record.disposition ?? null });
    }
  }

  // The declared exclusions must be the code-declared register, exactly. This is
  // the receipt-level echo of P8.0's manifest-level rule.
  const exclusions = isPlainObject(receipt.declared_exclusions) ? receipt.declared_exclusions : null;
  if (!exclusions) {
    push("receipt.declared_exclusions", "A portable dossier receipt must DECLARE the permanent exclusions; silence about an excluded class is refused.");
  } else {
    for (const name of Object.keys(exclusions)) {
      if (!(name in PERMANENTLY_EXCLUDED_EVIDENCE)) {
        push(`receipt.declared_exclusions.${name}`, "Only the code-declared permanently excluded classes may be declared as exclusions.");
      }
    }
    for (const [name, expected] of Object.entries(PERMANENTLY_EXCLUDED_EVIDENCE)) {
      const record = exclusions[name];
      if (!isPlainObject(record)) {
        push(`receipt.declared_exclusions.${name}`, `Permanently excluded class ${name} is not declared in the receipt.`);
        continue;
      }
      for (const key of ["satisfiability", "exclusion_disposition", "required_host_capability", "exclusion_reason"]) {
        if (record[key] !== expected[key]) {
          push(`receipt.declared_exclusions.${name}.${key}`, "A declared exclusion must match the code-declared register value.", { expected: expected[key], actual: record[key] ?? null });
        }
      }
      if (record.is_pending !== false) {
        push(`receipt.declared_exclusions.${name}.is_pending`, `Excluded class ${name} must carry is_pending: false. Presenting a permanent exclusion as PENDING is refused: it converts a permanent statement about host capability into a task somebody could be told to close.`, { actual: record.is_pending ?? null });
      }
      if (record.revisit_condition !== null) {
        push(`receipt.declared_exclusions.${name}.revisit_condition`, `Excluded class ${name} must carry revisit_condition: null; a revisit condition makes an exclusion read as deferred.`, { actual: record.revisit_condition });
      }
      if (record.is_waiver !== false) {
        push(`receipt.declared_exclusions.${name}.is_waiver`, `Excluded class ${name} must carry is_waiver: false.`, { actual: record.is_waiver ?? null });
      }
      if (record.excluded_from_portable_gate !== true) {
        push(`receipt.declared_exclusions.${name}.excluded_from_portable_gate`, `Excluded class ${name} must carry excluded_from_portable_gate: true; an excluded class is never counted as a portable-gate pass.`, { actual: record.excluded_from_portable_gate ?? null });
      }
    }
  }

  // The waiver-register verdict travels with the dossier and must be the
  // code-declared one.
  if (receipt.waiver_register?.register_disposition !== WAIVER_REGISTER.register_disposition ||
      receipt.waiver_register?.admits_waivers !== false ||
      (receipt.waiver_register?.waivers ?? null)?.length !== 0) {
    push("receipt.waiver_register", `A portable dossier must carry the code-declared waiver-register verdict ${WAIVER_REGISTER.register_disposition} with zero waivers and admits_waivers: false.`, {
      actual: receipt.waiver_register?.register_disposition ?? null,
    });
  }

  const absentClasses = PORTABLE_REQUIRED_EVIDENCE.filter(
    (name) => classes[name]?.disposition === CLASS_DISPOSITIONS.TYPED_ABSENCE);
  const claimsCertifiable = receipt.assembly_status === "CERTIFIABLE";
  if (claimsCertifiable) {
    if (absentClasses.length > 0) {
      push("receipt.certifiable_with_absence", `A dossier claiming CERTIFIABLE may not carry a typed absence; ${absentClasses.join(", ")} ${absentClasses.length === 1 ? "is" : "are"} absent.`);
    }
    if (receipt.certification_receipt?.status !== "PASS") {
      push("receipt.certifiable_without_receipt", "A dossier claiming CERTIFIABLE must carry a PASS receipt from validateReleaseCertificationEvidence at the portable tier.", {
        actual: receipt.certification_receipt?.status ?? null,
      });
    }
    if (receipt.certification_receipt?.certification_tier &&
        receipt.certification_receipt.package_mode !== PORTABLE_CERTIFIED_PACKAGE_MODE) {
      push("receipt.certifiable_tier", "A portable dossier's certification receipt must be a portable-tier receipt.", {
        actual: receipt.certification_receipt.package_mode ?? null,
      });
    }
    if (receipt.certification_manifest?.present !== true) {
      push("receipt.certifiable_without_manifest", "A dossier claiming CERTIFIABLE must have minted a certification manifest.");
    }
    if (receipt.identity?.worktree_clean === false) {
      push("receipt.certifiable_dirty_worktree", "A dossier claiming CERTIFIABLE may not be assembled from a worktree with uncommitted changes; the certified bytes must be the committed bytes.");
    }
  }

  const approvalsRecord = await readApprovalsRecord({
    dossierRoot,
    now,
    policy,
    // The subject is the receipt file's own digest, computed by the caller from
    // the bytes on disk. An approval that names a different digest approved a
    // different dossier, and is reported as such rather than accepted.
    subject: SHA256.test(String(receiptSha256 ?? ""))
      ? {
        assembly_receipt_sha256: receiptSha256,
        runtime_code_closure_sha256: closure,
        certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
      }
      : null,
  });
  findings.push(...approvalsRecord.findings.map((entry) => ({ ...entry, id: `approvals.${entry.id}` })));
  if ((requireApproval || claimsCertifiable) && !approvalsRecord.approved) {
    push("approvals.absent", "No unexpired, journalled, human approval names this dossier, so it is not an approved certification. An assembled dossier is a set of facts; an approved one is a decision, and only a human makes it.", {
      approval_count: approvalsRecord.approvals.length,
      valid_approval_count: approvalsRecord.valid_approval_count,
    });
  }

  return {
    schema_version: "excel-inflow-portable-release-dossier-verdict/1.0",
    status: findings.length === 0 ? "PASS" : "FAIL",
    total_violations: findings.length,
    assembly_status: receipt.assembly_status ?? null,
    certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    satisfied_classes: PORTABLE_REQUIRED_EVIDENCE.filter(
      (name) => classes[name]?.disposition === CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT),
    typed_absence_classes: absentClasses,
    declared_exclusions: Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE),
    approvals: approvalsRecord,
    findings,
  };
}

export default {
  APPROVALS_DIRECTORY,
  APPROVALS_JOURNAL_FILENAME,
  APPROVAL_EXPIRY_MODEL,
  ASSEMBLY_PLAN_FILENAME,
  ASSEMBLY_RECEIPT_FILENAME,
  ASSEMBLY_STATUSES,
  CERTIFICATION_MANIFEST_FILENAME,
  CLASS_DISPOSITIONS,
  PORTABLE_DOSSIER_APPROVAL_SCHEMA_VERSION,
  PORTABLE_DOSSIER_PLAN_SCHEMA_VERSION,
  PORTABLE_DOSSIER_SCHEMA_VERSION,
  PORTABLE_DOSSIER_WAIVER_REGISTER_SCHEMA_VERSION,
  REFUSED_DISPENSATION_SPELLINGS,
  TYPED_ABSENCE_DISPOSITIONS,
  WAIVER_REGISTER,
  WAIVER_REGISTER_FILENAME,
  appendPortableDossierApproval,
  assembleEvidenceClass,
  assemblePortableDossier,
  assertNoDispensation,
  buildCertificationManifest,
  canonicalSha256,
  createPortableDossierApproval,
  digestArtifact,
  readApprovalsRecord,
  typedAbsence,
  validatePortableDossierApproval,
  validatePortableDossierAssembly,
};
