#!/usr/bin/env node
/**
 * P8.7 — the portable release certification dossier.
 *
 * Invariant under test: a portable release dossier can be ASSEMBLED, is
 * hash-bound to the artifacts it cites, and is satisfiable on a portable host —
 * while the two native classes remain PERMANENT DECLARED EXCLUSIONS that no
 * dossier can present as satisfied or as merely pending. A dossier citing an
 * artifact whose bytes have changed is refused.
 *
 * The suite proves five things, in order:
 *   A. Assembly cannot fabricate. There is no digest parameter; a satisfied
 *      class exists only where bytes were read.
 *   B. SATISFIABILITY, end to end and against real bytes: five produced
 *      evidence reports become a dossier whose manifest the COMMITTED
 *      certification validator (P8.0's, imported and unedited) accepts at the
 *      portable tier, which a human then approves, and which re-verifies clean.
 *   C. The four required mutations, and twenty more.
 *   D. Approvals and expiry, on P8.6a's real hash-chained journal.
 *   E. The waiver-register verdict is unreversible: every spelling of a
 *      dispensation is refused at the API boundary and in the assembled record.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  NATIVE_CERTIFIED_PACKAGE_MODE,
  PERMANENT_DECLARED_EXCLUSION,
  PORTABLE_CERTIFIED_PACKAGE_MODE,
} from "./lib/identity_vocabulary.mjs";
import {
  PERMANENTLY_EXCLUDED_EVIDENCE,
  PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  PORTABLE_REQUIRED_EVIDENCE,
  validateReleaseCertificationEvidence,
} from "./lib/release_certification.mjs";
import {
  APPROVAL_EXPIRY_MODEL,
  CLASS_DISPOSITIONS,
  REFUSED_DISPENSATION_SPELLINGS,
  TYPED_ABSENCE_DISPOSITIONS,
  WAIVER_REGISTER,
  appendPortableDossierApproval,
  assembleEvidenceClass,
  assemblePortableDossier,
  assertNoDispensation,
  buildCertificationManifest,
  createPortableDossierApproval,
  digestArtifact,
  readApprovalsRecord,
  typedAbsence,
  validatePortableDossierApproval,
  validatePortableDossierAssembly,
} from "./lib/release_dossier.mjs";
import { loadReleaseRollbackPolicy, readReleaseJournal } from "./lib/release_journal.mjs";

process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE = "1";

const CLOSURE = "c".repeat(64);
const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const SHEETS = ["Operating Model", "Brokers", "Forward Curves"];
const NOW = "2026-08-20T00:00:00.000Z";
const PLAN_SCHEMA = "excel-inflow-portable-release-dossier-plan/1.0";

let checks = 0;
function check(assertion, message) {
  assert(assertion, message);
  checks += 1;
}
async function refuses(fn, pattern, message) {
  await assert.rejects(async () => fn(), pattern, message);
  checks += 1;
}
function refusesSync(fn, pattern, message) {
  assert.throws(fn, pattern, message);
  checks += 1;
}
/** A dossier verdict must FAIL, and must fail by NAME on the finding that matters. */
function refusedBy(verdict, id, message) {
  check(verdict.status === "FAIL", `${message} — the verdict was ${verdict.status}`);
  check(
    verdict.findings.some((finding) => finding.id === id || finding.id.startsWith(id)),
    `${message} — no finding named ${id}; got ${JSON.stringify(verdict.findings.map((f) => f.id))}`,
  );
}

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const IDENTITY = Object.freeze({
  repository: "excel-inflow",
  source_commit: COMMIT,
  source_tree: TREE,
  skill_version: "3.7.7",
  runtime_code_closure_sha256: CLOSURE,
  runtime_code_closure_file_count: 332,
  runtime_code_closure_identity_source: "test fixture",
  worktree_clean: true,
  worktree_status_sha256: sha(""),
});

const tempRoots = [];
async function tempRoot(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `excel-inflow-dossier-${name}-`));
  tempRoots.push(root);
  return root;
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.writeFile(target, bytes);
  return { path: target, sha256: sha(bytes) };
}
async function writeBlob(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.from(value, "utf8");
  await fs.writeFile(target, bytes);
  return { path: target, sha256: sha(bytes), name: path.basename(target) };
}

/* ================================================================== *
 * A. Assembly cannot fabricate
 * ================================================================== */

// The absence of a digest parameter is a RULE, not an oversight: ten spellings
// of a caller-supplied digest are refused by name.
{
  const root = await tempRoot("nodigest");
  const artifact = await writeBlob(path.join(root, "report.json"), "{}");
  for (const spelling of ["sha256", "digest", "hash", "expected_sha256", "checksum", "declared_sha256"]) {
    await refuses(
      () => digestArtifact(artifact.path, { [spelling]: sha("anything") }),
      /does not accept a caller-supplied/,
      `digestArtifact accepted a caller-supplied ${spelling}`,
    );
  }
  const digested = await digestArtifact(artifact.path);
  check(digested.sha256 === artifact.sha256, "digestArtifact did not hash the bytes on disk");
  check(digested.byte_length === 2, "digestArtifact did not record the byte length it read");
  // A class cannot be satisfied by a file that is not there: there is no path
  // from "no bytes" to a digest.
  await refuses(
    () => assembleEvidenceClass({
      evidenceClass: "frozen_cohort",
      artifactPath: path.join(root, "absent.json"),
      runtimeCodeClosureSha256: CLOSURE,
      root,
    }),
    /ENOENT/,
    "a class was satisfied by an artifact that does not exist",
  );
  // ...nor by bytes that are not an evidence report...
  await writeBlob(path.join(root, "garbage.json"), "not json");
  await refuses(
    () => assembleEvidenceClass({
      evidenceClass: "frozen_cohort",
      artifactPath: path.join(root, "garbage.json"),
      runtimeCodeClosureSha256: CLOSURE,
      root,
    }),
    /does not parse as JSON/,
    "a class was satisfied by an artifact that is not JSON",
  );
  // ...nor by another package's evidence.
  await writeJson(path.join(root, "wrong-closure.json"), { certified_closure_sha256: "d".repeat(64) });
  await refuses(
    () => assembleEvidenceClass({
      evidenceClass: "frozen_cohort",
      artifactPath: path.join(root, "wrong-closure.json"),
      runtimeCodeClosureSha256: CLOSURE,
      root,
    }),
    /bound to runtime-code closure/,
    "a class was satisfied by evidence bound to a different closure",
  );
  // ...nor by an artifact outside the dossier, whose companion tree the dossier
  // neither names nor hashes.
  const outside = await tempRoot("outside");
  await writeJson(path.join(outside, "report.json"), { certified_closure_sha256: CLOSURE });
  await refuses(
    () => assembleEvidenceClass({
      evidenceClass: "frozen_cohort",
      artifactPath: path.join(outside, "report.json"),
      runtimeCodeClosureSha256: CLOSURE,
      root,
    }),
    /must be self-contained/,
    "a class was satisfied by an artifact outside the dossier directory",
  );
}

// A PERMANENTLY EXCLUDED class can be neither assembled nor absented. This is
// the structural half of "an exclusion is not a pending item".
for (const excluded of Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE)) {
  const root = await tempRoot(`excluded-${excluded}`);
  const artifact = await writeJson(path.join(root, "report.json"), { certified_closure_sha256: CLOSURE });
  await refuses(
    () => assembleEvidenceClass({
      evidenceClass: excluded,
      artifactPath: artifact.path,
      runtimeCodeClosureSha256: CLOSURE,
      root,
    }),
    /PERMANENT DECLARED EXCLUSION/,
    `${excluded} was assembled as satisfied evidence`,
  );
  await refuses(
    () => typedAbsence({
      evidenceClass: excluded,
      disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
      reason: "x".repeat(60),
      revisitCondition: "y".repeat(60),
      blockingArtifactPath: artifact.path,
      blockedAtLayer: "somewhere",
      root,
    }),
    /PERMANENT DECLARED EXCLUSION/,
    `${excluded} was recorded as a pending typed absence`,
  );
}

// A typed absence must earn every field. Each of these is a separate refusal.
{
  const root = await tempRoot("absence");
  const blocking = await writeBlob(path.join(root, "blocker.txt"), "the block");
  const base = {
    evidenceClass: "frozen_cohort",
    disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
    reason: "r".repeat(60),
    revisitCondition: "c".repeat(60),
    blockingArtifactPath: blocking.path,
    blockedAtLayer: "runtime_host_preflight",
    root,
  };
  const good = await typedAbsence(base);
  check(good.disposition === CLASS_DISPOSITIONS.TYPED_ABSENCE, "a well-formed absence was not typed as one");
  check(good.absence.blocks_certification === true, "a typed absence does not block certification");
  check(good.absence.is_exclusion === false, "a typed absence claims to be an exclusion");
  check(good.absence.is_waiver === false, "a typed absence claims to be a waiver");
  check(good.absence.is_pending === true, "a typed absence does not admit it is pending work");
  check(good.absence.blocking_evidence.sha256 === blocking.sha256, "a typed absence is not hash-bound to its block");
  check(good.artifact === null, "a typed absence carries an artifact binding");
  await refuses(() => typedAbsence({ ...base, disposition: "PENDING" }), /not in the declared vocabulary/, "an invented absence disposition was accepted");
  await refuses(() => typedAbsence({ ...base, disposition: PERMANENT_DECLARED_EXCLUSION }), /not in the declared vocabulary/, "an absence claimed the permanent-exclusion disposition");
  await refuses(() => typedAbsence({ ...base, reason: "blocked" }), /token reason is refused/, "an absence with a token reason was accepted");
  await refuses(() => typedAbsence({ ...base, revisitCondition: null }), /revisit condition/, "an absence with no revisit condition was accepted");
  await refuses(() => typedAbsence({ ...base, revisitCondition: "later" }), /revisit condition/, "an absence with a token revisit condition was accepted");
  await refuses(() => typedAbsence({ ...base, blockedAtLayer: "" }), /earliest responsible layer/, "an absence naming no responsible layer was accepted");
  await refuses(() => typedAbsence({ ...base, blockingArtifactPath: path.join(root, "nope.txt") }), /ENOENT/, "an absence with no captured block was accepted");
  // Every declared disposition is honest about its four flags.
  for (const [name, declared] of Object.entries(TYPED_ABSENCE_DISPOSITIONS)) {
    check(declared.disposition === name, `${name} does not name itself`);
    check(declared.blocks_certification === true && declared.is_exclusion === false &&
      declared.is_waiver === false && declared.is_pending === true,
      `${name} does not carry the four flags that keep an absence from reading as a pass or an exclusion`);
    check(typeof declared.default_revisit_condition === "string" && declared.default_revisit_condition.length >= 40,
      `${name} declares no revisit condition of substance`);
  }
}

// An incomplete manifest is never minted, and a satisfied class with no digest
// cannot mint one either. (Required mutation 1, at the assembly layer.)
{
  const root = await tempRoot("manifest");
  const blocking = await writeBlob(path.join(root, "blocker.txt"), "block");
  const classes = {};
  for (const name of PORTABLE_REQUIRED_EVIDENCE) {
    classes[name] = await typedAbsence({
      evidenceClass: name,
      disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
      reason: "r".repeat(60),
      revisitCondition: "c".repeat(60),
      blockingArtifactPath: blocking.path,
      blockedAtLayer: "host",
      root,
    });
  }
  refusesSync(
    () => buildCertificationManifest({ classes, runtimeCodeClosureSha256: CLOSURE }),
    /Refusing to mint a portable certification manifest/,
    "a manifest was minted for a dossier of typed absences",
  );
  const forged = Object.fromEntries(PORTABLE_REQUIRED_EVIDENCE.map((name) => [name, {
    evidence_class: name,
    disposition: CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT,
    artifact: { path: `${name}.json` },
    absence: null,
  }]));
  refusesSync(
    () => buildCertificationManifest({ classes: forged, runtimeCodeClosureSha256: CLOSURE }),
    /marked satisfied with no artifact digest/,
    "a manifest was minted from classes marked satisfied with no artifact digest",
  );
}

/* ================================================================== *
 * B. SATISFIABILITY — a real five-class dossier, end to end
 * ================================================================== */

/**
 * The five portable classes as REAL hash-bound files, in the same shapes the
 * committed validator demands, so the dossier is proven against bytes rather
 * than against claims. Same fixture discipline as P8.0's suite; the authority
 * digests are overridden through the adversarial test mode, which is the only
 * way the immutable V4 identities may be substituted.
 */
async function producedEvidence(dossierRoot) {
  const maximalWorkbook = await writeBlob(path.join(dossierRoot, "standard-maximal.xlsx"), "maximal authority");
  const netCashWorkbook = await writeBlob(path.join(dossierRoot, "standard-net-cash.xlsx"), "net-cash authority");
  const caseFile = await writeBlob(path.join(dossierRoot, "case.json"), "case");
  const financeWorkbook = await writeBlob(path.join(dossierRoot, "finance.xlsx"), "finance");
  const financeRowMap = await writeBlob(`${financeWorkbook.path}.row-map.json`, "row map");
  const parityWorkbook = await writeBlob(path.join(dossierRoot, "parity.xlsx"), "parity");
  const parityRowMap = await writeBlob(path.join(dossierRoot, "parity.row-map.json"), "parity row map");
  const parityLedger = await writeBlob(path.join(dossierRoot, "parity-ledger.json"), "parity ledger");

  const authority = async (label, caseName, workbook) => {
    const sheets = [];
    for (const sheet of SHEETS) {
      const page = await writeBlob(path.join(dossierRoot, `${label}-${sheet.replaceAll(" ", "-")}.png`), `${label}:${sheet}`);
      sheets.push({
        sheet,
        verdict: "PASS",
        visual_regression: { mode: "compared", baselines_written: [], baselines_removed: [] },
        rendered_pages: [{ path: page.name, sha256: page.sha256 }],
      });
    }
    return {
      schema: "render-evidence/2",
      generated_by: "scripts/render/check_render.py",
      verdict: "PASS",
      comparison_scope: "exact_authority_replay",
      case: caseName,
      baseline_case: caseName,
      certified_closure_sha256: CLOSURE,
      workbook: path.basename(workbook.path),
      workbook_sha256: workbook.sha256,
      sheets,
    };
  };

  const reports = {
    exact_maximal: await authority("maximal", "standard-maximal", maximalWorkbook),
    exact_net_cash: await authority("net-cash", "standard-net-cash", netCashWorkbook),
    frozen_cohort: {
      status: "PASS",
      mode: "frozen_cohort_development",
      evidence_class: "AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY",
      release_gate_status: "NOT_EVALUATED",
      certified_closure_sha256: CLOSURE,
      summary: { passed: 32, failed: 0 },
      development_scope: { not_claimed: ["release_readiness"] },
    },
    finance_proof_mutations: {
      kind: "independent_finance_proof_mutations",
      status: "PASS",
      certified_closure_sha256: CLOSURE,
      summary: { passed: 5, failed: 0 },
      case: path.basename(caseFile.path),
      case_sha256: caseFile.sha256,
      workbook: path.basename(financeWorkbook.path),
      workbook_sha256: financeWorkbook.sha256,
      row_map: path.basename(financeRowMap.path),
      row_map_sha256: financeRowMap.sha256,
    },
    source_parity: {
      status: "PASS",
      certified_closure_sha256: CLOSURE,
      ledger_applicable: true,
      coverage: { ledger_pass: "ran" },
      stats: { checked: 4 },
      violations: [],
      bindings: {
        workbook: { path: path.basename(parityWorkbook.path), sha256: parityWorkbook.sha256 },
        row_map: { path: path.basename(parityRowMap.path), sha256: parityRowMap.sha256 },
        ledger: { path: path.basename(parityLedger.path), sha256: parityLedger.sha256 },
      },
    },
  };
  const files = {};
  for (const [name, report] of Object.entries(reports)) {
    files[name] = await writeJson(path.join(dossierRoot, `${name}.json`), report);
  }
  return {
    files,
    authorityHashes: {
      "standard-maximal": {
        workbook_sha256: maximalWorkbook.sha256,
        exact_replay_fingerprint_sha256: sha("maximal-fingerprint"),
      },
      "standard-net-cash": {
        workbook_sha256: netCashWorkbook.sha256,
        exact_replay_fingerprint_sha256: sha("net-cash-fingerprint"),
      },
    },
  };
}

async function satisfiableDossier(name = "satisfiable") {
  const dossierRoot = await tempRoot(name);
  const produced = await producedEvidence(dossierRoot);
  const plan = {
    schema_version: PLAN_SCHEMA,
    classes: Object.fromEntries(PORTABLE_REQUIRED_EVIDENCE.map((className) => [className, {
      artifact: path.basename(produced.files[className].path),
    }])),
  };
  let manifestPath = null;
  const assembled = await assemblePortableDossier({
    root: dossierRoot,
    dossierRoot,
    plan,
    identity: IDENTITY,
    assembledAt: NOW,
    assembler: "run_release_dossier_tests.mjs",
    certificationValidator: async ({ manifest }) => {
      manifestPath = path.join(dossierRoot, "portable-certification-manifest.json");
      await writeJson(manifestPath, manifest);
      return validateReleaseCertificationEvidence({
        manifestPath,
        runtimeCodeClosureSha256: CLOSURE,
        certificationTier: PORTABLE_CERTIFIED_PACKAGE_MODE,
        authorityHashes: produced.authorityHashes,
      });
    },
  });
  const receiptPath = path.join(dossierRoot, "dossier-assembly-receipt.json");
  const written = await writeJson(receiptPath, assembled.receipt);
  await fs.mkdir(path.join(dossierRoot, "approvals"), { recursive: true });
  return { dossierRoot, produced, plan, manifestPath, receiptPath, receiptSha256: written.sha256, ...assembled };
}

const satisfiable = await satisfiableDossier();

check(satisfiable.receipt.assembly_status === "CERTIFIABLE",
  `a complete portable dossier did not assemble as CERTIFIABLE: ${satisfiable.receipt.assembly_status}`);
check(satisfiable.receipt.certification_receipt.status === "PASS",
  `the COMMITTED certification validator refused a complete portable dossier: ${JSON.stringify(satisfiable.receipt.certification_receipt.findings ?? [])}`);
check(satisfiable.receipt.certification_receipt.package_mode === PORTABLE_CERTIFIED_PACKAGE_MODE,
  "the certification receipt is not a portable-tier receipt");
check(satisfiable.receipt.certification_receipt.claims_native_host_evidence === false,
  "a portable certification receipt claims native-host evidence");
check(satisfiable.receipt.satisfied_classes.length === 5 && satisfiable.receipt.typed_absence_classes.length === 0,
  "a complete dossier did not record five satisfied classes and zero absences");
check(satisfiable.manifest.schema_version === PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  "the minted manifest does not declare the portable dossier schema version");
check(satisfiable.manifest.package_mode === PORTABLE_CERTIFIED_PACKAGE_MODE &&
  satisfiable.manifest.certification_tier === PORTABLE_CERTIFIED_PACKAGE_MODE,
  "the minted manifest does not declare the portable tier");
check(Object.keys(satisfiable.manifest.declared_exclusions).sort().join(",") === "native_excel,visual_review",
  "the minted manifest does not declare exactly the two permanent exclusions");
for (const className of PORTABLE_REQUIRED_EVIDENCE) {
  check(satisfiable.manifest.evidence[className].sha256 === satisfiable.produced.files[className].sha256,
    `the minted manifest does not bind ${className} to the bytes on disk`);
}
// Every digest in the dossier was computed from bytes, not copied from a plan:
// the plan carries no digests at all.
check(JSON.stringify(satisfiable.plan).includes("sha256") === false,
  "the assembly plan carries digests, so a dossier could inherit a digest nobody computed");

// The assembled dossier re-verifies clean against the bytes on disk.
{
  const verdict = await validatePortableDossierAssembly({
    receipt: satisfiable.receipt,
    receiptSha256: satisfiable.receiptSha256,
    dossierRoot: satisfiable.dossierRoot,
    now: NOW,
  });
  // Approval is the one thing missing: assembly is not approval.
  check(verdict.status === "FAIL" && verdict.findings.length === 1 &&
    verdict.findings[0].id === "approvals.absent",
    `a CERTIFIABLE dossier with no approval failed for some reason other than the missing approval: ${JSON.stringify(verdict.findings.map((f) => f.id))}`);
  check(verdict.satisfied_classes.length === 5, "the verdict does not report five satisfied classes");
  check(verdict.typed_absence_classes.length === 0, "the verdict invents a typed absence");
}

// The same manifest submitted to the NATIVE gate is still refused by name. The
// portable tier is not a back door into a native claim.
{
  const native = await validateReleaseCertificationEvidence({
    manifestPath: satisfiable.manifestPath,
    runtimeCodeClosureSha256: CLOSURE,
    authorityHashes: satisfiable.produced.authorityHashes,
  });
  check(native.status === "FAIL", "a portable dossier satisfied the NATIVE certification gate");
  check(native.findings.some((finding) => finding.id === "manifest.native.portable_dossier"),
    "the native gate did not refuse the portable dossier by name");
  check(native.findings.some((finding) => finding.id === "evidence.native_excel.path") &&
    native.findings.some((finding) => finding.id === "evidence.visual_review.path"),
    "the native gate no longer requires the two native-host evidence classes");
  check(native.package_mode === NATIVE_CERTIFIED_PACKAGE_MODE, "the native receipt is not a native receipt");
}

/* ================================================================== *
 * C. Mutations
 * ================================================================== */

/** Deep clone so a mutation cannot leak into the next case. */
const clone = (value) => JSON.parse(JSON.stringify(value));

// REQUIRED MUTATION 1 — a class marked satisfied with no artifact digest.
{
  const receipt = clone(satisfiable.receipt);
  delete receipt.classes.frozen_cohort.artifact.sha256;
  refusedBy(
    await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
    "class.frozen_cohort.artifact",
    "a class marked satisfied with no artifact digest was admitted",
  );
}
{
  const receipt = clone(satisfiable.receipt);
  receipt.classes.frozen_cohort.artifact = null;
  refusedBy(
    await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
    "class.frozen_cohort.artifact",
    "a class marked satisfied with a null artifact was admitted",
  );
}
{
  const receipt = clone(satisfiable.receipt);
  receipt.classes.frozen_cohort.artifact.sha256 = "not a digest";
  refusedBy(
    await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
    "class.frozen_cohort.artifact",
    "a class marked satisfied with a malformed digest was admitted",
  );
}

// REQUIRED MUTATION 2 — a cited artifact whose BYTES CHANGED.
{
  const tampered = await satisfiableDossier("tampered");
  const target = path.join(tampered.dossierRoot, "frozen_cohort.json");
  const before = JSON.parse(await fs.readFile(target, "utf8"));
  await writeJson(target, { ...before, summary: { passed: 31, failed: 1 } });
  const verdict = await validatePortableDossierAssembly({
    receipt: tampered.receipt,
    receiptSha256: tampered.receiptSha256,
    dossierRoot: tampered.dossierRoot,
    now: NOW,
  });
  refusedBy(verdict, "class.frozen_cohort.artifact.sha256", "a dossier citing an artifact whose bytes changed was admitted");
  const finding = verdict.findings.find((entry) => entry.id === "class.frozen_cohort.artifact.sha256");
  check(finding.recorded !== finding.actual && /^[0-9a-f]{64}$/.test(finding.actual),
    "the byte-change refusal does not name both digests");
  // One byte is enough — the refusal is not a coarse size check.
  const oneByte = await satisfiableDossier("onebyte");
  const page = path.join(oneByte.dossierRoot, "maximal-Operating-Model.png");
  const bytes = await fs.readFile(page);
  bytes[0] ^= 0x01;
  await fs.writeFile(page, bytes);
  const receipt = await validateReleaseCertificationEvidence({
    manifestPath: oneByte.manifestPath,
    runtimeCodeClosureSha256: CLOSURE,
    certificationTier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    authorityHashes: oneByte.produced.authorityHashes,
  });
  check(receipt.status === "FAIL" &&
    receipt.findings.some((entry) => entry.id === "authority.maximal.sheet.0.page.0"),
    "one flipped byte inside a rendered page did not invalidate the portable certification");
}
// The blocking evidence of an ABSENCE is hash-bound too: an absence whose
// captured block was edited is refused just as firmly as tampered evidence.
{
  const root = await tempRoot("absence-tamper");
  const blocking = await writeBlob(path.join(root, "blocker.txt"), "the block");
  const plan = {
    schema_version: PLAN_SCHEMA,
    classes: Object.fromEntries(PORTABLE_REQUIRED_EVIDENCE.map((className) => [className, {
      absence: {
        absence_disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
        reason: "r".repeat(60),
        revisit_condition: "c".repeat(60),
        blocked_at_layer: "runtime_host_preflight",
        blocking_evidence: "blocker.txt",
      },
    }])),
  };
  const { receipt } = await assemblePortableDossier({
    root, dossierRoot: root, plan, identity: IDENTITY, assembledAt: NOW,
  });
  check(receipt.assembly_status === "ASSEMBLED_NOT_CERTIFIABLE",
    "a dossier of five typed absences did not assemble as ASSEMBLED_NOT_CERTIFIABLE");
  check(receipt.certification_manifest.present === false,
    "a manifest was written for a dossier of five typed absences");
  check(receipt.certification_receipt.status === "NOT_RUN",
    "an incomplete dossier carries a certification receipt status other than NOT_RUN");
  const clean = await validatePortableDossierAssembly({ receipt, dossierRoot: root, now: NOW });
  check(clean.status === "PASS", `an honestly assembled incomplete dossier did not validate: ${JSON.stringify(clean.findings.map((f) => f.id))}`);
  check(clean.assembly_status === "ASSEMBLED_NOT_CERTIFIABLE" && clean.typed_absence_classes.length === 5,
    "the verdict does not report the five typed absences");
  await writeBlob(blocking.path, "the block, edited");
  refusedBy(
    await validatePortableDossierAssembly({ receipt, dossierRoot: root, now: NOW }),
    "class.exact_maximal.absence.blocking_evidence.sha256",
    "an absence whose captured block was edited was admitted",
  );
}

// REQUIRED MUTATION 3 — an excluded class presented as SATISFIED, or as PENDING.
for (const excluded of Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE)) {
  {
    const receipt = clone(satisfiable.receipt);
    receipt.classes[excluded] = {
      evidence_class: excluded,
      disposition: CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT,
      artifact: { path: "frozen_cohort.json", sha256: satisfiable.produced.files.frozen_cohort.sha256 },
      absence: null,
    };
    refusedBy(
      await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
      `class.${excluded}.excluded_class_present`,
      `${excluded} was admitted as satisfied evidence`,
    );
  }
  {
    const receipt = clone(satisfiable.receipt);
    receipt.classes[excluded] = {
      evidence_class: excluded,
      disposition: CLASS_DISPOSITIONS.TYPED_ABSENCE,
      artifact: null,
      absence: {
        absence_disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
        reason: "r".repeat(60),
        revisit_condition: "c".repeat(60),
        blocked_at_layer: "host",
        blocking_evidence: { path: "frozen_cohort.json", sha256: satisfiable.produced.files.frozen_cohort.sha256 },
        blocks_certification: true,
        is_exclusion: false,
        is_waiver: false,
        is_pending: true,
      },
    };
    refusedBy(
      await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
      `class.${excluded}.excluded_class_present`,
      `${excluded} was admitted as a PENDING typed absence`,
    );
  }
  // And the four spellings of "pending" inside the declared-exclusions block.
  const mutations = [
    ["is_pending", true, `receipt.declared_exclusions.${excluded}.is_pending`],
    ["revisit_condition", "when a native host is procured", `receipt.declared_exclusions.${excluded}.revisit_condition`],
    ["is_waiver", true, `receipt.declared_exclusions.${excluded}.is_waiver`],
    ["excluded_from_portable_gate", false, `receipt.declared_exclusions.${excluded}.excluded_from_portable_gate`],
    ["exclusion_disposition", "PENDING_MANUAL", `receipt.declared_exclusions.${excluded}.exclusion_disposition`],
    ["exclusion_reason", "tbd", `receipt.declared_exclusions.${excluded}.exclusion_reason`],
    ["required_host_capability", "none", `receipt.declared_exclusions.${excluded}.required_host_capability`],
  ];
  for (const [field, value, expectedId] of mutations) {
    const receipt = clone(satisfiable.receipt);
    receipt.declared_exclusions[excluded][field] = value;
    refusedBy(
      await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
      expectedId,
      `a permanent exclusion with ${field}=${JSON.stringify(value)} was admitted`,
    );
  }
  // Dropping an exclusion entirely: silence about an excluded class is refused.
  {
    const receipt = clone(satisfiable.receipt);
    delete receipt.declared_exclusions[excluded];
    refusedBy(
      await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
      `receipt.declared_exclusions.${excluded}`,
      `a dossier silent about the ${excluded} exclusion was admitted`,
    );
  }
}

// A dossier claiming CERTIFIABLE while carrying an absence, a failing receipt,
// no manifest, or a dirty worktree.
{
  const cases = [
    [(receipt) => {
      receipt.classes.frozen_cohort = {
        evidence_class: "frozen_cohort",
        disposition: CLASS_DISPOSITIONS.TYPED_ABSENCE,
        artifact: null,
        absence: {
          absence_disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
          reason: "r".repeat(60),
          revisit_condition: "c".repeat(60),
          blocked_at_layer: "host",
          blocking_evidence: { path: "case.json", sha256: sha("case") },
          blocks_certification: true, is_exclusion: false, is_waiver: false, is_pending: true,
        },
      };
    }, "receipt.certifiable_with_absence"],
    [(receipt) => { receipt.certification_receipt.status = "FAIL"; }, "receipt.certifiable_without_receipt"],
    [(receipt) => { receipt.certification_receipt = null; }, "receipt.certifiable_without_receipt"],
    [(receipt) => { receipt.certification_manifest.present = false; }, "receipt.certifiable_without_manifest"],
    [(receipt) => { receipt.identity.worktree_clean = false; }, "receipt.certifiable_dirty_worktree"],
    [(receipt) => { receipt.certification_tier = NATIVE_CERTIFIED_PACKAGE_MODE; }, "receipt.certification_tier"],
    [(receipt) => { receipt.assembly_status = "PASS_PENDING_MANUAL"; }, "receipt.assembly_status"],
    [(receipt) => { receipt.schema_version = "something-else/1.0"; }, "receipt.schema_version"],
    [(receipt) => { delete receipt.classes.source_parity; }, "class.source_parity.missing"],
    [(receipt) => { receipt.classes.invented_class = { evidence_class: "invented_class", disposition: CLASS_DISPOSITIONS.SATISFIED_WITH_BOUND_ARTIFACT, artifact: { path: "case.json", sha256: sha("case") } }; }, "class.invented_class.unknown"],
    [(receipt) => { receipt.classes.frozen_cohort.evidence_class = "exact_maximal"; }, "class.frozen_cohort.evidence_class"],
    [(receipt) => { receipt.classes.frozen_cohort.disposition = "SATISFIED"; }, "class.frozen_cohort.disposition"],
    [(receipt) => { receipt.identity.runtime_code_closure_sha256 = null; }, "receipt.identity.runtime_code_closure_sha256"],
    [(receipt) => { receipt.classes.frozen_cohort.artifact.path = "absent.json"; }, "class.frozen_cohort.artifact.read"],
    [(receipt) => { receipt.waiver_register.register_disposition = "ACTIVE"; }, "receipt.waiver_register"],
    [(receipt) => { receipt.waiver_register.admits_waivers = true; }, "receipt.waiver_register"],
    [(receipt) => { receipt.declared_exclusions.invented = { satisfiability: "x" }; }, "receipt.declared_exclusions.invented"],
  ];
  for (const [mutate, expectedId] of cases) {
    const receipt = clone(satisfiable.receipt);
    mutate(receipt);
    refusedBy(
      await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
      expectedId,
      `mutation expected to be refused as ${expectedId} was admitted`,
    );
  }
}

// A typed absence dressed up as something it is not.
{
  const absent = await tempRoot("absence-mutations");
  const blocking = await writeBlob(path.join(absent, "blocker.txt"), "block");
  const plan = {
    schema_version: PLAN_SCHEMA,
    classes: Object.fromEntries(PORTABLE_REQUIRED_EVIDENCE.map((className) => [className, {
      absence: {
        absence_disposition: "ASSEMBLY_BLOCKED_UPSTREAM_BUILD_REFUSAL",
        reason: "r".repeat(60),
        revisit_condition: "c".repeat(60),
        blocked_at_layer: "builder",
        blocking_evidence: "blocker.txt",
      },
    }])),
  };
  const { receipt: base } = await assemblePortableDossier({ root: absent, dossierRoot: absent, plan, identity: IDENTITY, assembledAt: NOW });
  const cases = [
    [(receipt) => { receipt.classes.frozen_cohort.absence.blocks_certification = false; }, "class.frozen_cohort.absence.blocks_certification"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.is_pending = false; }, "class.frozen_cohort.absence.is_pending"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.is_exclusion = true; }, "class.frozen_cohort.absence.is_exclusion"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.satisfiability = PERMANENTLY_EXCLUDED_EVIDENCE.native_excel.satisfiability; }, "class.frozen_cohort.absence.is_exclusion"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.exclusion_disposition = PERMANENT_DECLARED_EXCLUSION; }, "class.frozen_cohort.absence.is_exclusion"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.is_waiver = true; }, "class.frozen_cohort.absence.is_waiver"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.reason = "blocked"; }, "class.frozen_cohort.absence.reason"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.revisit_condition = null; }, "class.frozen_cohort.absence.revisit_condition"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.absence_disposition = "PENDING"; }, "class.frozen_cohort.absence.disposition"],
    [(receipt) => { receipt.classes.frozen_cohort.absence.blocking_evidence = null; }, "class.frozen_cohort.absence.blocking_evidence"],
    [(receipt) => { receipt.classes.frozen_cohort.absence = null; }, "class.frozen_cohort.absence"],
    [(receipt) => { receipt.classes.frozen_cohort.artifact = { path: "blocker.txt", sha256: sha("block") }; }, "class.frozen_cohort.artifact"],
  ];
  for (const [mutate, expectedId] of cases) {
    const receipt = clone(base);
    mutate(receipt);
    refusedBy(
      await validatePortableDossierAssembly({ receipt, dossierRoot: absent, now: NOW }),
      expectedId,
      `an absence mutation expected to be refused as ${expectedId} was admitted`,
    );
  }
}

// The assembly plan itself: silence about a class, both dispositions at once,
// neither, and a plan naming an excluded class.
{
  const root = await tempRoot("plan-mutations");
  const blocking = await writeBlob(path.join(root, "blocker.txt"), "block");
  const absence = {
    absence_disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
    reason: "r".repeat(60),
    revisit_condition: "c".repeat(60),
    blocked_at_layer: "host",
    blocking_evidence: "blocker.txt",
  };
  const full = () => Object.fromEntries(PORTABLE_REQUIRED_EVIDENCE.map((name) => [name, { absence: { ...absence } }]));
  const assemble = (classes, extra = {}) => assemblePortableDossier({
    root, dossierRoot: root, identity: IDENTITY, assembledAt: NOW,
    plan: { schema_version: PLAN_SCHEMA, classes, ...extra },
  });
  const partial = full();
  delete partial.source_parity;
  await refuses(() => assemble(partial), /says nothing about source_parity/, "a plan silent about a class was accepted");
  const both = full();
  both.frozen_cohort = { artifact: "blocker.txt", absence: { ...absence } };
  await refuses(() => assemble(both), /EXACTLY ONE/, "a plan entry declaring both an artifact and an absence was accepted");
  const neither = full();
  neither.frozen_cohort = {};
  await refuses(() => assemble(neither), /EXACTLY ONE/, "a plan entry declaring neither an artifact nor an absence was accepted");
  const excluded = full();
  excluded.native_excel = { absence: { ...absence } };
  await refuses(() => assemble(excluded), /PERMANENT DECLARED EXCLUSION/, "a plan naming a permanently excluded class was accepted");
  await refuses(
    () => assemblePortableDossier({ root, dossierRoot: root, identity: IDENTITY, assembledAt: NOW, plan: { classes: full() } }),
    /schema_version/, "a plan with no schema version was accepted",
  );
  await refuses(
    () => assemblePortableDossier({ root, dossierRoot: root, plan: { schema_version: PLAN_SCHEMA, classes: full() }, assembledAt: NOW, identity: { ...IDENTITY, runtime_code_closure_sha256: null } }),
    /live runtime-code closure identity/, "assembly without a closure identity was accepted",
  );
  await refuses(
    () => assemblePortableDossier({ root, dossierRoot: root, plan: { schema_version: PLAN_SCHEMA, classes: full() }, assembledAt: NOW, identity: { ...IDENTITY, source_commit: "HEAD" } }),
    /source commit and tree/, "assembly without a real source commit was accepted",
  );
  await refuses(
    () => assemblePortableDossier({ root, dossierRoot: root, plan: { schema_version: PLAN_SCHEMA, classes: full() }, assembledAt: "yesterday", identity: IDENTITY }),
    /RFC 3339/, "assembly with no real timestamp was accepted",
  );
  check(blocking.sha256.length === 64, "the blocking fixture was not written");
}

/* ================================================================== *
 * D. Approvals and expiry, on P8.6a's real journal
 * ================================================================== */

const SUBJECT = Object.freeze({
  assembly_receipt_sha256: satisfiable.receiptSha256,
  runtime_code_closure_sha256: CLOSURE,
  certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
  source_commit: COMMIT,
});

check(APPROVAL_EXPIRY_MODEL.automation_may_approve === false, "the expiry model lets automation approve");
check(APPROVAL_EXPIRY_MODEL.auto_renewal === false, "the expiry model auto-renews approvals");
check(APPROVAL_EXPIRY_MODEL.expiry_is_refusal === true, "the expiry model does not treat expiry as a refusal");
check(APPROVAL_EXPIRY_MODEL.max_validity_days === 90, "the maximum approval validity moved");
check(APPROVAL_EXPIRY_MODEL.invalidated_by.length === 4,
  "the expiry model no longer invalidates on all four of clock, receipt digest, closure and tier");

// A well-formed approval.
const approval = createPortableDossierApproval({
  approvalId: "v377-portable-certification",
  actor: { kind: "human", identity: "release-owner" },
  approvedAt: NOW,
  validityDays: 30,
  statement: "The five portable evidence classes are satisfied against bound bytes and the two native classes are permanent declared exclusions.",
  subject: SUBJECT,
});
check(approval.expires_at === "2026-09-19T00:00:00.000Z", `the approval expiry was not computed from the validity window: ${approval.expires_at}`);
check(validatePortableDossierApproval(approval, { now: NOW, subject: SUBJECT }).status === "PASS",
  "a well-formed approval did not validate");

// Automation may never approve — at creation and again at validation.
refusesSync(
  () => createPortableDossierApproval({ ...{ approvalId: "a-bot", approvedAt: NOW, validityDays: 30, statement: "x".repeat(60), subject: SUBJECT }, actor: { kind: "automation", identity: "ci" } }),
  /named HUMAN actor/, "automation was allowed to approve a certification",
);
refusesSync(
  () => createPortableDossierApproval({ approvalId: "anon", actor: { kind: "human", identity: "  " }, approvedAt: NOW, validityDays: 30, statement: "x".repeat(60), subject: SUBJECT }),
  /named HUMAN actor/, "an unnamed human was allowed to approve",
);
// An unbounded or over-long approval.
for (const validityDays of [0, -1, 91, 3650, 1.5, null]) {
  refusesSync(
    () => createPortableDossierApproval({ approvalId: "forever", actor: { kind: "human", identity: "x" }, approvedAt: NOW, validityDays, statement: "x".repeat(60), subject: SUBJECT }),
    /validity/, `an approval with validity ${JSON.stringify(validityDays)} was accepted`,
  );
}
refusesSync(
  () => createPortableDossierApproval({ approvalId: "nosubject", actor: { kind: "human", identity: "x" }, approvedAt: NOW, validityDays: 30, statement: "x".repeat(60), subject: { certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE } }),
  /must bind its subject/, "an approval naming no subject was accepted",
);
refusesSync(
  () => createPortableDossierApproval({ approvalId: "native", actor: { kind: "human", identity: "x" }, approvedAt: NOW, validityDays: 30, statement: "x".repeat(60), subject: { ...SUBJECT, certification_tier: NATIVE_CERTIFIED_PACKAGE_MODE } }),
  /must bind its subject/, "an approval claiming the native tier was accepted",
);
refusesSync(
  () => createPortableDossierApproval({ approvalId: "terse", actor: { kind: "human", identity: "x" }, approvedAt: NOW, validityDays: 30, statement: "ok", subject: SUBJECT }),
  /at least 40 characters/, "an approval with a token statement was accepted",
);

// REQUIRED MUTATION 4 — an EXPIRED approval.
{
  const oneDayLater = "2026-09-19T00:00:00.000Z";
  const verdict = validatePortableDossierApproval(approval, { now: oneDayLater, subject: SUBJECT });
  check(verdict.status === "FAIL" && verdict.expired === true, "an approval read on its expiry instant was not refused");
  check(verdict.findings.some((finding) => finding.id === "approval.expired"), "the expiry refusal is not named");
  const wellAfter = validatePortableDossierApproval(approval, { now: "2027-01-01T00:00:00.000Z", subject: SUBJECT });
  check(wellAfter.status === "FAIL" && wellAfter.expired === true, "an approval read long after expiry was not refused");
  const inside = validatePortableDossierApproval(approval, { now: "2026-09-18T23:59:59.000Z", subject: SUBJECT });
  check(inside.status === "PASS" && inside.expired === false, "an approval one second inside its window was refused");
}
// Expiry by IDENTITY as well as by clock: the approval does not survive the
// dossier it approved being reassembled.
{
  const drifted = validatePortableDossierApproval(approval, {
    now: NOW,
    subject: { ...SUBJECT, assembly_receipt_sha256: sha("a different dossier") },
  });
  check(drifted.status === "FAIL" &&
    drifted.findings.some((finding) => finding.id === "approval.subject.assembly_receipt_sha256"),
    "an approval survived the dossier it approved changing");
  const reclosured = validatePortableDossierApproval(approval, {
    now: NOW,
    subject: { ...SUBJECT, runtime_code_closure_sha256: "e".repeat(64) },
  });
  check(reclosured.status === "FAIL", "an approval survived the runtime-code closure changing");
}
// An edited approval.
{
  const edited = { ...approval, expires_at: "2099-01-01T00:00:00.000Z" };
  const verdict = validatePortableDossierApproval(edited, { now: "2027-01-01T00:00:00.000Z", subject: SUBJECT });
  check(verdict.status === "FAIL" && verdict.findings.some((finding) => finding.id === "approval.approval_sha256"),
    "an approval whose expiry was extended by hand was accepted");
  const rekinded = { ...approval, actor: { kind: "automation", identity: "ci" } };
  const rekindedVerdict = validatePortableDossierApproval(rekinded, { now: NOW, subject: SUBJECT });
  check(rekindedVerdict.findings.some((finding) => finding.id === "approval.actor"),
    "an approval switched to an automation actor was accepted");
}
// A missing clock is a refusal, never an assumption that we are inside the window.
check(validatePortableDossierApproval(approval, { now: "whenever", subject: SUBJECT }).status === "FAIL",
  "an approval evaluated against a malformed clock was accepted");

// The approvals RECORD is P8.6a's journal, reused: real chaining, real
// append-only bytes, and an approval outside the chain does not count.
{
  const { policy } = await loadReleaseRollbackPolicy();
  const journalRoot = await tempRoot("journal");
  await fs.mkdir(path.join(journalRoot, "approvals"), { recursive: true });
  const journalPath = path.join(journalRoot, "release-journal.jsonl");
  const release = {
    repository: "excel-inflow",
    source_commit: COMMIT,
    source_tree: TREE,
    skill_version: "3.7.7",
    package_mode: PORTABLE_CERTIFIED_PACKAGE_MODE,
    deployment_status: "not_installed",
    runtime_code_closure_sha256: CLOSURE,
    complete_package_inventory_sha256: null,
    archive_sha256: null,
    release_package_attestation_sha256: null,
  };
  const record = await appendPortableDossierApproval({ journalPath, policy, approval, release, recordedAt: NOW });
  check(record.sequence === 0 && record.previous_record_hash === null, "the genesis approval record is not a genesis record");
  check(record.event_type === "attest" && record.actor.kind === "human", "the approval record is not a human attest record");
  check(record.detail.includes(`approval_sha256=${approval.approval_sha256}`), "the journal record does not bind the approval document");
  const second = createPortableDossierApproval({
    approvalId: "v377-portable-certification-second",
    actor: { kind: "human", identity: "release-owner-2" },
    approvedAt: "2026-08-21T00:00:00.000Z",
    validityDays: 7,
    statement: "Second reviewer confirms the same evidence set against the same bound bytes.",
    subject: SUBJECT,
  });
  const secondRecord = await appendPortableDossierApproval({ journalPath, policy, approval: second, release, recordedAt: "2026-08-21T00:00:00.000Z" });
  check(secondRecord.sequence === 1 && secondRecord.previous_record_hash === record.record_hash,
    "the second approval does not chain onto the first");
  const journal = await readReleaseJournal(journalPath, { policy });
  check(journal.status === "PASS" && journal.record_count === 2, "the reused release journal does not validate");
  // A journal record whose body was edited breaks the chain — P8.6a's property,
  // exercised here because the approvals record depends on it.
  const lines = (await fs.readFile(journalPath, "utf8")).trim().split("\n");
  const forged = JSON.parse(lines[0]);
  forged.detail = `${forged.detail} expires_at=2099-01-01T00:00:00.000Z`;
  await fs.writeFile(journalPath, `${JSON.stringify(forged)}\n${lines[1]}\n`);
  const broken = await readReleaseJournal(journalPath, { policy });
  check(broken.status === "FAIL", "an edited approval record did not break the journal");
  await fs.writeFile(journalPath, `${lines.join("\n")}\n`);

  // An approval on disk but NOT in the chain does not count.
  await writeJson(path.join(journalRoot, "approvals", "v377-portable-certification.json"), approval);
  const orphan = createPortableDossierApproval({
    approvalId: "unjournalled",
    actor: { kind: "human", identity: "someone" },
    approvedAt: NOW,
    validityDays: 30,
    statement: "An approval dropped into the directory without ever being appended to the chain.",
    subject: SUBJECT,
  });
  await writeJson(path.join(journalRoot, "approvals", "unjournalled.json"), orphan);
  const record0 = await readApprovalsRecord({ dossierRoot: journalRoot, now: NOW, subject: SUBJECT, policy });
  check(record0.approvals.length === 2, "the approvals record did not read both documents");
  check(record0.valid_approval_count === 1, "an approval outside the hash chain was counted as valid");
  check(record0.approvals.find((entry) => entry.approval_id === "unjournalled").journalled === false,
    "an unjournalled approval was reported as journalled");
  check(record0.approved === true, "a journalled unexpired approval was not counted");
  // ...and after expiry, nothing is approved.
  const expiredRead = await readApprovalsRecord({ dossierRoot: journalRoot, now: "2027-01-01T00:00:00.000Z", subject: SUBJECT, policy });
  check(expiredRead.approved === false && expiredRead.valid_approval_count === 0,
    "an expired approval still counted as an approval");

  // An approval may not be journalled against the NATIVE tier.
  await refuses(
    () => appendPortableDossierApproval({ journalPath, policy, approval, recordedAt: NOW, release: { ...release, package_mode: "certified" } }),
    /must be journalled against package_mode portable_certified/,
    "a portable approval was journalled against the native package mode",
  );
  // A malformed approval never reaches the chain.
  await refuses(
    () => appendPortableDossierApproval({ journalPath, policy, approval: { ...approval, approval_sha256: sha("forged") }, recordedAt: NOW, release }),
    /does not validate/, "an approval with a broken self-hash was journalled",
  );
}

// An APPROVED dossier verifies clean, end to end, through the real record.
{
  const approved = await satisfiableDossier("approved");
  const subject = {
    assembly_receipt_sha256: approved.receiptSha256,
    runtime_code_closure_sha256: CLOSURE,
    certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    source_commit: COMMIT,
  };
  const document = createPortableDossierApproval({
    approvalId: "approved-dossier",
    actor: { kind: "human", identity: "release-owner" },
    approvedAt: NOW,
    validityDays: 30,
    statement: "The complete portable evidence set is bound to these bytes and the exclusions are permanent.",
    subject,
  });
  const { policy } = await loadReleaseRollbackPolicy();
  await appendPortableDossierApproval({
    journalPath: path.join(approved.dossierRoot, "release-journal.jsonl"),
    policy,
    approval: document,
    recordedAt: NOW,
    release: {
      repository: "excel-inflow", source_commit: COMMIT, source_tree: TREE, skill_version: "3.7.7",
      package_mode: PORTABLE_CERTIFIED_PACKAGE_MODE, deployment_status: "not_installed",
      runtime_code_closure_sha256: CLOSURE, complete_package_inventory_sha256: null,
      archive_sha256: null, release_package_attestation_sha256: null,
    },
  });
  await writeJson(path.join(approved.dossierRoot, "approvals", "approved-dossier.json"), document);
  const verdict = await validatePortableDossierAssembly({
    receipt: approved.receipt,
    receiptSha256: approved.receiptSha256,
    dossierRoot: approved.dossierRoot,
    now: NOW,
    policy,
    requireApproval: true,
  });
  check(verdict.status === "PASS",
    `a complete, approved portable dossier did not verify: ${JSON.stringify(verdict.findings.map((f) => f.id))}`);
  check(verdict.approvals.approved === true && verdict.approvals.valid_approval_count === 1,
    "the approved dossier does not report its approval");
  check(verdict.approvals.journal.record_count === 1 && /^[0-9a-f]{64}$/.test(verdict.approvals.journal.tip_record_hash),
    "the approved dossier does not bind the journal tip");
  // The same dossier, read after the approval lapses, is no longer approved.
  const lapsed = await validatePortableDossierAssembly({
    receipt: approved.receipt,
    receiptSha256: approved.receiptSha256,
    dossierRoot: approved.dossierRoot,
    now: "2027-01-01T00:00:00.000Z",
    policy,
  });
  refusedBy(lapsed, "approvals.absent", "a dossier with only a lapsed approval was still treated as approved");
  // ...and if the evidence bytes then move, the tampering is reported too.
  await writeJson(path.join(approved.dossierRoot, "frozen_cohort.json"), { certified_closure_sha256: CLOSURE, status: "PASS" });
  const both = await validatePortableDossierAssembly({
    receipt: approved.receipt, receiptSha256: approved.receiptSha256,
    dossierRoot: approved.dossierRoot, now: "2027-01-01T00:00:00.000Z", policy,
  });
  refusedBy(both, "class.frozen_cohort.artifact.sha256", "a lapsed-and-tampered dossier hid the tampering behind the lapse");
}

/* ================================================================== *
 * E. The waiver-register verdict is unreversible
 * ================================================================== */

check(WAIVER_REGISTER.register_disposition === "DECLARED_UNNECESSARY_ZERO_WAIVERS",
  "the waiver-register verdict changed");
check(WAIVER_REGISTER.waivers.length === 0 && WAIVER_REGISTER.waiver_count === 0 &&
  WAIVER_REGISTER.admits_waivers === false,
  "the waiver register admits a waiver");
check(WAIVER_REGISTER.closed_case_argument.length === 3 &&
  WAIVER_REGISTER.closed_case_argument.every((entry) => entry.needs_dispensation === false),
  "the closed-case argument no longer covers exactly the three cases, each without a dispensation");
check(WAIVER_REGISTER.closed_case_argument.every((entry) => entry.why.length >= 40),
  "a case in the closed-case argument is asserted without a reason");
check(REFUSED_DISPENSATION_SPELLINGS.length >= 30, "the dispensation-spelling refusal list was shortened");

// Every spelling is refused, at any depth, by key.
for (const spelling of REFUSED_DISPENSATION_SPELLINGS) {
  refusesSync(
    () => assertNoDispensation({ classes: { frozen_cohort: { [spelling]: "just this once" } } }, "test"),
    /dispensation key/,
    `the dispensation spelling ${spelling} was admitted`,
  );
}
// ...including through the assembly plan, which is where a caller would try.
{
  const root = await tempRoot("dispensation-plan");
  await writeBlob(path.join(root, "blocker.txt"), "block");
  await refuses(
    () => assemblePortableDossier({
      root, dossierRoot: root, identity: IDENTITY, assembledAt: NOW,
      plan: {
        schema_version: PLAN_SCHEMA,
        classes: Object.fromEntries(PORTABLE_REQUIRED_EVIDENCE.map((name) => [name, {
          absence: {
            absence_disposition: "ASSEMBLY_BLOCKED_HOST_TOOLCHAIN",
            reason: "r".repeat(60), revisit_condition: "c".repeat(60),
            blocked_at_layer: "host", blocking_evidence: "blocker.txt",
            waiver: "approved by the release owner",
          },
        }])),
      },
    }),
    /dispensation key/, "a plan carrying a waiver was assembled",
  );
}
// ...and through a hand-edited receipt submitted for verification.
{
  const receipt = clone(satisfiable.receipt);
  receipt.classes.frozen_cohort.exemption = "signed off";
  refusedBy(
    await validatePortableDossierAssembly({ receipt, receiptSha256: satisfiable.receiptSha256, dossierRoot: satisfiable.dossierRoot, now: NOW }),
    "receipt.dispensation",
    "a hand-edited receipt carrying an exemption was admitted",
  );
}
// ...and through an approval.
refusesSync(
  () => createPortableDossierApproval({
    approvalId: "waiving", actor: { kind: "human", identity: "x", waiver: "yes" },
    approvedAt: NOW, validityDays: 30, statement: "x".repeat(60), subject: SUBJECT,
  }),
  /dispensation key/, "an approval carrying a waiver was created",
);
// The register's own text is exempt ONLY by its exact digest: a register with a
// waiver added to it is refused by the same scan.
{
  assertNoDispensation({ waiver_register: WAIVER_REGISTER }, "the code-declared register");
  checks += 1;
  const tampered = { ...WAIVER_REGISTER, waivers: [{ waiver_id: "w1", reason: "just this once" }] };
  refusesSync(
    () => assertNoDispensation({ waiver_register: tampered }, "a tampered register"),
    /dispensation key/,
    "a register with a waiver added to it was still exempt from the dispensation scan",
  );
}
// The register the dossier carries must be the code-declared one.
check(satisfiable.receipt.waiver_register.register_disposition === WAIVER_REGISTER.register_disposition,
  "the assembled dossier does not carry the code-declared waiver-register verdict");
check(satisfiable.receipt.approval_expiry_model.model === APPROVAL_EXPIRY_MODEL.model,
  "the assembled dossier does not carry the approval expiry model");
check(satisfiable.receipt.physical_lane_terminal_declaration.status_token === "PASS_PENDING_MANUAL",
  "the assembled dossier dropped the physical-lane terminal declaration");
check(satisfiable.receipt.assembler.kind === "automation",
  "the assembler records itself as something other than automation");

for (const root of tempRoots) await fs.rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ status: "PASS", checks }));
