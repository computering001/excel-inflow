#!/usr/bin/env node
/**
 * P8.7 — assemble the portable release certification dossier.
 *
 * This is an ASSEMBLER, not a validator. It gathers the portable evidence a
 * plan names, digests each artifact from its own bytes, records what it could
 * not produce as a TYPED ABSENCE hash-bound to the captured block, mints the
 * P8.0-contract certification manifest if and only if all five portable
 * classes are satisfied, submits that manifest to the COMMITTED certification
 * validator, and writes the result.
 *
 * Two commands, deliberately separate, because assembling and approving are
 * different acts by different kinds of actor:
 *
 *   assemble   automation gathers and records.        (default)
 *   --approve  a named human authorises, with an expiry.
 *   --verify   re-read an assembled dossier and re-hash everything it cites.
 *
 * Usage:
 *   node scripts/assemble_release_dossier.mjs
 *       --plan  <assembly-plan.json>
 *       [--out  <dossier-directory>]      default evidence/release_v377
 *       [--skill <skill-root>]            default the repository root
 *       [--now  <RFC3339 UTC>]
 *
 *   node scripts/assemble_release_dossier.mjs --verify [--out <dir>] [--now <t>]
 *
 *   node scripts/assemble_release_dossier.mjs --approve
 *       --approval-id <id> --approver "<name>" --statement "<why>"
 *       [--validity-days N] [--out <dir>] [--now <t>]
 *
 * Exit 0 only when the requested action succeeded AND, for --verify, the
 * dossier verdict is PASS.
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PORTABLE_CERTIFIED_PACKAGE_MODE } from "./lib/identity_vocabulary.mjs";
import { validateReleaseCertificationEvidence } from "./lib/release_certification.mjs";
import {
  APPROVALS_DIRECTORY,
  APPROVAL_EXPIRY_MODEL,
  ASSEMBLY_PLAN_FILENAME,
  ASSEMBLY_RECEIPT_FILENAME,
  CERTIFICATION_MANIFEST_FILENAME,
  WAIVER_REGISTER,
  WAIVER_REGISTER_FILENAME,
  appendPortableDossierApproval,
  assemblePortableDossier,
  canonicalSha256,
  createPortableDossierApproval,
  validatePortableDossierAssembly,
} from "./lib/release_dossier.mjs";
import { loadReleaseRollbackPolicy } from "./lib/release_journal.mjs";
import { resolveActiveSourceIdentity } from "./lib/source_identity.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const skillRoot = path.resolve(option("skill", ROOT));
const dossierRoot = path.resolve(option("out", path.join(skillRoot, "evidence", "release_v377")));
const now = option("now", new Date().toISOString().replace(/\.\d+Z$/, ".000Z"));

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.writeFile(target, bytes);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function fileSha256(target) {
  return crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex");
}

/**
 * The identity of the tree being certified, resolved from LIVE BYTES.
 *
 * The runtime-code closure comes from resolveActiveSourceIdentity — P8.2a's
 * live closure over the shipped bytes. The release compiler computes its own
 * closure from the deployment profile's allowlists, and the Phase-8 work order
 * records that the two definitions have never been proven to agree. The dossier
 * therefore RECORDS which definition produced its closure identity, so a reader
 * can see the residual instead of assuming convergence that nobody proved.
 */
async function resolveIdentity() {
  const identity = await resolveActiveSourceIdentity({ skillRoot });
  const [{ stdout: commit }, { stdout: tree }, { stdout: status }] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: skillRoot }),
    exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: skillRoot }),
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: skillRoot }),
  ]);
  const porcelain = status.trim();
  return {
    repository: identity.repository ?? null,
    source_commit: commit.trim(),
    source_tree: tree.trim(),
    skill_version: identity.skill_version ?? null,
    runtime_code_closure_sha256: identity.active_runtime_code_closure?.sha256 ?? null,
    runtime_code_closure_file_count:
      Object.keys(identity.active_runtime_code_closure?.files ?? {}).length || null,
    runtime_code_closure_identity_source:
      "resolveActiveSourceIdentity (scripts/lib/source_identity.mjs) over live bytes. NOT the release compiler's deployment-profile closure; the Phase-8 work order records that the two closure definitions have never been proven equal, and P8.2's closure-convergence slice is the package that must close that gap before a dossier closure may be asserted equal to a package closure.",
    worktree_clean: porcelain === "",
    worktree_status_sha256: crypto.createHash("sha256").update(porcelain).digest("hex"),
    worktree_status_line_count: porcelain === "" ? 0 : porcelain.split("\n").length,
  };
}

async function assemble() {
  const planPath = option("plan");
  if (!planPath) {
    throw new Error("Assembly requires --plan <assembly-plan.json>. There is no default plan: what a dossier claims must be stated, never inferred.");
  }
  const plan = await readJson(path.resolve(planPath));
  const identity = await resolveIdentity();
  await fs.mkdir(dossierRoot, { recursive: true });

  const { receipt, manifest } = await assemblePortableDossier({
    root: skillRoot,
    dossierRoot,
    plan,
    identity,
    assembledAt: now,
    assembler: "scripts/assemble_release_dossier.mjs",
    certificationValidator: async ({ manifest: candidate }) => {
      // Write the manifest, then hand its PATH to the committed validator, so
      // the receipt records what the validator said about the bytes that
      // actually shipped rather than about an in-memory object.
      const target = path.join(dossierRoot, CERTIFICATION_MANIFEST_FILENAME);
      await writeJson(target, candidate);
      return validateReleaseCertificationEvidence({
        manifestPath: target,
        runtimeCodeClosureSha256: identity.runtime_code_closure_sha256,
        certificationTier: PORTABLE_CERTIFIED_PACKAGE_MODE,
      });
    },
  });

  const waiverSha256 = await writeJson(path.join(dossierRoot, WAIVER_REGISTER_FILENAME), WAIVER_REGISTER);
  const planSha256 = await writeJson(path.join(dossierRoot, ASSEMBLY_PLAN_FILENAME), plan);
  receipt.waiver_register_file = { filename: WAIVER_REGISTER_FILENAME, sha256: waiverSha256 };
  receipt.plan.filename = ASSEMBLY_PLAN_FILENAME;
  receipt.plan.file_sha256 = planSha256;
  if (manifest) {
    receipt.certification_manifest.sha256 = await fileSha256(
      path.join(dossierRoot, CERTIFICATION_MANIFEST_FILENAME));
  }
  receipt.receipt_body_sha256 = canonicalSha256(receipt);

  const receiptPath = path.join(dossierRoot, ASSEMBLY_RECEIPT_FILENAME);
  const receiptSha256 = await writeJson(receiptPath, receipt);
  await fs.mkdir(path.join(dossierRoot, APPROVALS_DIRECTORY), { recursive: true });

  const verdict = await validatePortableDossierAssembly({
    receipt,
    receiptSha256,
    dossierRoot,
    now,
    policy: await loadReleaseRollbackPolicy().catch(() => null),
  });

  console.log(JSON.stringify({
    action: "assemble",
    dossier: dossierRoot,
    assembly_status: receipt.assembly_status,
    assembly_receipt_sha256: receiptSha256,
    satisfied_classes: receipt.satisfied_classes,
    typed_absence_classes: receipt.typed_absence_classes,
    declared_exclusions: Object.keys(receipt.declared_exclusions),
    waiver_register: WAIVER_REGISTER.register_disposition,
    certification_manifest: receipt.certification_manifest.present
      ? receipt.certification_manifest.filename
      : null,
    certification_receipt_status: receipt.certification_receipt?.status ?? null,
    integrity_verdict: verdict.status,
    integrity_findings: verdict.findings.map((entry) => entry.id),
  }, null, 2));
  // An incomplete dossier is a REFUSAL. Exit non-zero so a caller that treats a
  // zero exit as "certified" cannot be misled by a dossier full of absences.
  if (receipt.assembly_status !== "CERTIFIABLE") process.exitCode = 1;
}

async function verify() {
  const receiptPath = path.join(dossierRoot, ASSEMBLY_RECEIPT_FILENAME);
  const receipt = await readJson(receiptPath);
  const verdict = await validatePortableDossierAssembly({
    receipt,
    receiptSha256: await fileSha256(receiptPath),
    dossierRoot,
    now,
    policy: await loadReleaseRollbackPolicy().catch(() => null),
    requireApproval: flag("require-approval"),
  });
  console.log(JSON.stringify(verdict, null, 2));
  if (verdict.status !== "PASS") process.exitCode = 1;
}

async function approve() {
  const receiptPath = path.join(dossierRoot, ASSEMBLY_RECEIPT_FILENAME);
  const receipt = await readJson(receiptPath);
  const receiptSha256 = await fileSha256(receiptPath);
  if (receipt.assembly_status !== "CERTIFIABLE") {
    throw new Error(
      [
        `Refusing to approve a dossier whose assembly status is ${receipt.assembly_status}.`,
        `Typed absences: ${(receipt.typed_absence_classes ?? []).join(", ") || "none"}.`,
        "An approval is a decision about complete evidence. Approving an incomplete dossier is exactly the",
        "waiver the portable tier does not admit, so it is refused at the earliest layer rather than recorded.",
      ].join(" "),
    );
  }
  const approver = option("approver");
  if (!approver) {
    throw new Error("--approve requires --approver \"<name>\": automation records, humans authorise, and an unnamed human is not a human.");
  }
  const approval = createPortableDossierApproval({
    approvalId: option("approval-id"),
    actor: { kind: "human", identity: approver },
    approvedAt: now,
    validityDays: Number(option("validity-days", String(APPROVAL_EXPIRY_MODEL.default_validity_days))),
    statement: option("statement", ""),
    subject: {
      assembly_receipt_sha256: receiptSha256,
      runtime_code_closure_sha256: receipt.identity.runtime_code_closure_sha256,
      certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
      source_commit: receipt.identity.source_commit,
    },
  });
  const { policy } = await loadReleaseRollbackPolicy();
  const record = await appendPortableDossierApproval({
    journalPath: path.join(dossierRoot, "release-journal.jsonl"),
    policy,
    approval,
    recordedAt: now,
    release: {
      repository: receipt.identity.repository ?? "excel-inflow",
      source_commit: receipt.identity.source_commit,
      source_tree: receipt.identity.source_tree,
      skill_version: receipt.identity.skill_version,
      package_mode: PORTABLE_CERTIFIED_PACKAGE_MODE,
      deployment_status: "not_installed",
      runtime_code_closure_sha256: receipt.identity.runtime_code_closure_sha256,
      complete_package_inventory_sha256: null,
      archive_sha256: null,
      release_package_attestation_sha256: null,
    },
  });
  const approvalPath = path.join(dossierRoot, APPROVALS_DIRECTORY, `${approval.approval_id}.json`);
  await writeJson(approvalPath, approval);
  console.log(JSON.stringify({
    action: "approve",
    approval_id: approval.approval_id,
    approver: approval.actor.identity,
    approved_at: approval.approved_at,
    expires_at: approval.expires_at,
    validity_days: approval.validity_days,
    approval_sha256: approval.approval_sha256,
    journal_sequence: record.sequence,
    journal_record_hash: record.record_hash,
  }, null, 2));
}

try {
  if (flag("verify")) await verify();
  else if (flag("approve")) await approve();
  else await assemble();
} catch (error) {
  console.error(`${error.message}`);
  process.exitCode = 2;
}
