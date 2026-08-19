#!/usr/bin/env node
/**
 * P8.6a — release rollback policy + release journal proof (PORTABLE HALF).
 *
 * Invariant under proof: a release rollback is a DECLARED, executable,
 * evidence-preserving procedure. There is a versioned rollback policy asset
 * naming the trigger conditions, the authorisation required, the target
 * identity you roll back TO, what happens to in-flight runs (the package
 * pinning rule) and what evidence must be preserved; a release journal records
 * every release-affecting event (compile, attest, tag, retain, promote,
 * rollback, supersede) as an append-only hash-chained record; and a validator
 * proves the policy is complete and the journal well-formed and append-only.
 *
 * The INSTALLED half (Rogo active-pointer re-point, installed identity
 * read-back, post-rollback installed parity) is permanently excluded — the
 * policy must say so in the asset, and this suite proves the exclusion is
 * code-declared so the asset can never quietly claim it is satisfied.
 *
 * Nothing here mutates a live install; every write lands in a temporary
 * directory. This is a policy/journal/validator proof, not deployment
 * automation.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEPLOYMENT_STATUSES,
  PACKAGE_MODES,
  identitySha256,
  productIdentity,
} from "./lib/identity_vocabulary.mjs";
import {
  buildReleasePackageAttestation,
  createDeterministicPackageArchive,
} from "./lib/release_package_attestation.mjs";
import {
  EXCLUDED_INSTALLED_HOST,
  RELEASE_JOURNAL_EVENT_TYPES,
  RELEASE_JOURNAL_FILENAME,
  RELEASE_JOURNAL_RECORD_SCHEMA_VERSION,
  RELEASE_ROLLBACK_POLICY_SCHEMA_VERSION,
  ROLLBACK_POLICY_CLAUSE_CONTRACT,
  appendReleaseJournalRecord,
  assertRollbackTargetAttestable,
  createReleaseJournalRecord,
  loadReleaseRollbackPolicy,
  readReleaseJournal,
  releaseJournalLine,
  validateReleaseJournal,
  validateReleaseRollbackPolicy,
  verifyRollbackTargetAttestation,
} from "./lib/release_journal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`RELEASE_ROLLBACK_FAIL: ${message}`);
  checks += 1;
}
function refuses(findings, fragment, message) {
  check(
    Array.isArray(findings) && findings.some((finding) => String(finding).includes(fragment)),
    `${message} (expected a finding containing ${JSON.stringify(fragment)}; got ${JSON.stringify(findings)})`,
  );
}

const hex40 = (seed) => identitySha256({ seed }).slice(0, 40);
const hex64 = (seed) => identitySha256({ seed });

// ---------------------------------------------------------------------------
// 1. The policy asset exists, parses, and is complete.
// ---------------------------------------------------------------------------
const loaded = await loadReleaseRollbackPolicy();
const policy = loaded.policy;
check(policy.schema_version === RELEASE_ROLLBACK_POLICY_SCHEMA_VERSION, "policy schema_version");
check(policy.work_package === "P8.6a", "policy names its work package");
check(typeof policy.invariant === "string" && policy.invariant.length > 40, "policy states its invariant");
check(/^[a-f0-9]{64}$/.test(loaded.policy_sha256), "policy carries a computed identity digest");
check(validateReleaseRollbackPolicy(policy).length === 0,
  `the shipped rollback policy must validate clean; got ${JSON.stringify(validateReleaseRollbackPolicy(policy))}`);

// Every clause the contract requires is present, exactly, with no extras.
const clauseIds = Object.keys(policy.clauses).sort();
const requiredIds = Object.keys(ROLLBACK_POLICY_CLAUSE_CONTRACT).sort();
check(JSON.stringify(clauseIds) === JSON.stringify(requiredIds),
  `policy clause set must equal the contract clause set; got ${JSON.stringify(clauseIds)}`);
check(requiredIds.length === 12, `the rollback policy contract declares 12 clauses; got ${requiredIds.length}`);

// The installed-host exclusions are code-declared and marked in the asset.
const excludedIds = requiredIds.filter(
  (id) => ROLLBACK_POLICY_CLAUSE_CONTRACT[id].satisfiability === EXCLUDED_INSTALLED_HOST,
);
check(excludedIds.length === 3, `exactly three clauses are installed-host excluded; got ${excludedIds.length}`);
for (const id of excludedIds) {
  const clause = policy.clauses[id];
  check(clause.satisfiability === EXCLUDED_INSTALLED_HOST, `clause ${id} must declare ${EXCLUDED_INSTALLED_HOST}`);
  check(typeof clause.exclusion_reason === "string" && clause.exclusion_reason.length > 20,
    `excluded clause ${id} must carry a real exclusion reason`);
  check(clause.excluded_from_portable_gate === true, `excluded clause ${id} must be out of the portable gate`);
  check(clause.procedure_steps.length === 0, `excluded clause ${id} must not pretend to have portable steps`);
}
for (const id of requiredIds.filter((candidate) => !excludedIds.includes(candidate))) {
  const clause = policy.clauses[id];
  check(clause.satisfiability === "portable", `clause ${id} must be portable`);
  check(clause.procedure_steps.length > 0, `portable clause ${id} must carry procedure steps`);
  check(clause.evidence.length > 0, `portable clause ${id} must name its evidence`);
  check(clause.exclusion_reason === null, `portable clause ${id} must not carry an exclusion reason`);
  check(clause.excluded_from_portable_gate === false, `portable clause ${id} is inside the portable gate`);
}

// The policy binds the EXISTING identity vocabulary — it never mints a second one.
const transitions = policy.clauses.deployment_status_transitions.binding;
check(DEPLOYMENT_STATUSES.includes(transitions.withdrawn_package.from), "withdrawn from-status is vocabulary");
check(transitions.withdrawn_package.to === "rollback", "a withdrawn package lands on the rollback status");
check(transitions.terminal_statuses.includes("rollback"), "rollback is a terminal deployment status");
check(PACKAGE_MODES.includes(policy.clauses.rollback_target_identity.binding.required_package_mode),
  "the rollback target's package mode is vocabulary");

// The in-flight-run stop path reuses a REGISTERED terminal reason; the policy
// may not mint reason codes.
const pinning = policy.clauses.in_flight_run_package_pinning.binding;
check(pinning.rollback_repoints_in_flight_run === false, "a rollback never re-points an in-flight run");
check(pinning.stop_path.new_reason_code_required === false, "the policy must not mint a terminal reason code");
const registry = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"),
);
check(pinning.stop_path.terminal_reason_code in registry.reason_codes,
  `the stop path's terminal reason ${pinning.stop_path.terminal_reason_code} must already be registered`);
check(registry.reason_codes[pinning.stop_path.terminal_reason_code].evidence_preserved === true,
  "the stop path's registered reason must preserve evidence");

// Evidence preservation and retention are declared, not implied.
check(policy.clauses.evidence_preservation.binding.preserved_classes.length >= 4,
  "at least four evidence classes are preserved across a rollback");
check(policy.clauses.evidence_preservation.binding.preserved_classes.every((entry) => entry.never_delete === true),
  "every preserved evidence class is never-delete");
check(policy.clauses.retained_previous_known_good.binding.retained_previous_known_good_count >= 1,
  "at least one previous-known-good package is retained");
check(policy.clauses.retained_previous_known_good.binding.retention_precedes_promotion === true,
  "retention is a precondition of promotion, not an afterthought");

// The anti-conflation clause: per-run resumability is NOT release rollback.
check(policy.clauses.release_journal_record.binding.journal_filename === RELEASE_JOURNAL_FILENAME,
  "the policy and the writer agree on the journal filename");
check(policy.clauses.rollback_is_not_run_resume.binding.distinguished_from
  .some((entry) => entry.includes("scripts/lib/release_checkpoint_store.mjs")),
  "the policy must explicitly distinguish per-run checkpoint resume from release rollback");

// ---------------------------------------------------------------------------
// 2. Policy mutations: an incomplete or vocabulary-breaking policy is caught.
// ---------------------------------------------------------------------------
{
  const missingClause = structuredClone(policy);
  delete missingClause.clauses.evidence_preservation;
  refuses(validateReleaseRollbackPolicy(missingClause), "evidence_preservation",
    "a policy missing a required clause MUST be caught");
}
{
  const noTriggers = structuredClone(policy);
  noTriggers.clauses.trigger_conditions.binding.triggers = [];
  refuses(validateReleaseRollbackPolicy(noTriggers), "trigger",
    "a policy declaring no trigger condition MUST be caught");
}
{
  const claimsInstalled = structuredClone(policy);
  claimsInstalled.clauses.active_pointer_repoint.satisfiability = "portable";
  claimsInstalled.clauses.active_pointer_repoint.excluded_from_portable_gate = false;
  refuses(validateReleaseRollbackPolicy(claimsInstalled), "active_pointer_repoint",
    "an installed-host clause claiming to be portable MUST be caught");
}
{
  const bogusStatus = structuredClone(policy);
  bogusStatus.clauses.deployment_status_transitions.binding.withdrawn_package.to = "unpromoted";
  refuses(validateReleaseRollbackPolicy(bogusStatus), "deployment status",
    "a deployment status outside DEPLOYMENT_STATUSES MUST be caught");
}
{
  const noRetention = structuredClone(policy);
  delete noRetention.clauses.retained_previous_known_good.binding.retained_previous_known_good_count;
  refuses(validateReleaseRollbackPolicy(noRetention), "retained_previous_known_good",
    "a retention clause without a retained count MUST be caught");
}
{
  const mintedReason = structuredClone(policy);
  mintedReason.clauses.in_flight_run_package_pinning.binding.stop_path.terminal_reason_code =
    "ROLLBACK.release_withdrawn";
  refuses(validateReleaseRollbackPolicy(mintedReason), "terminal reason",
    "a policy inventing an unregistered terminal reason code MUST be caught");
}
{
  const authorisedByRobot = structuredClone(policy);
  authorisedByRobot.clauses.authorisation.binding.automation_may_authorise = true;
  refuses(validateReleaseRollbackPolicy(authorisedByRobot), "automation",
    "a policy letting automation authorise a rollback MUST be caught");
}
{
  const unattestableTarget = structuredClone(policy);
  unattestableTarget.clauses.rollback_target_identity.binding.attestation_required = false;
  refuses(validateReleaseRollbackPolicy(unattestableTarget), "attestation",
    "a policy waiving rollback-target attestation MUST be caught");
}
{
  const unpinned = structuredClone(policy);
  unpinned.clauses.in_flight_run_package_pinning.binding.rollback_repoints_in_flight_run = true;
  refuses(validateReleaseRollbackPolicy(unpinned), "in-flight",
    "a policy that re-points in-flight runs MUST be caught");
}

// ---------------------------------------------------------------------------
// 3. A real, attestable rollback target.
// ---------------------------------------------------------------------------
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "release-rollback-proof-"));
const goodRoot = path.join(scratch, "known-good-package");
await fs.mkdir(path.join(goodRoot, "scripts"), { recursive: true });
await fs.writeFile(path.join(goodRoot, "scripts", "entry.mjs"), "export const ok = true;\n");
const goodClosure = hex64("known-good-closure");
const goodManifest = {
  releaseName: "Excel Inflow rollback-target fixture",
  skillVersion: "3.7.7",
  packageMode: "development",
  identity: productIdentity({
    repository: "computering001/excel-inflow",
    sourceCommit: hex40("known-good-commit"),
    sourceTree: hex40("known-good-tree"),
    packageMode: "development",
    deploymentStatus: "not_installed",
    runtimeCodeClosureSha256: goodClosure,
  }),
};
await fs.writeFile(
  path.join(goodRoot, "release-manifest.json"),
  `${JSON.stringify(goodManifest, null, 2)}\n`,
);
const goodArchivePath = path.join(scratch, "known-good-package.tar");
const goodArchive = await createDeterministicPackageArchive({
  packageRoot: goodRoot,
  archivePath: goodArchivePath,
});
const goodAttestation = await buildReleasePackageAttestation({
  packageRoot: goodRoot,
  archive: goodArchive,
  issuedAt: "2026-08-19T09:00:00.000Z",
});

const targetVerification = await verifyRollbackTargetAttestation({
  packageRoot: goodRoot,
  attestation: goodAttestation,
  archivePath: goodArchivePath,
  expectedRuntimeCodeClosureSha256: goodClosure,
});
check(targetVerification.status === "PASS",
  `an intact previous-known-good package must be an attestable rollback target; got ${JSON.stringify(targetVerification.findings)}`);
check(targetVerification.target.runtime_code_closure_sha256 === goodClosure,
  "the verified target reports the closure identity it was checked against");
check(/^[a-f0-9]{64}$/.test(targetVerification.target.complete_package_inventory_sha256),
  "the verified target binds a complete-package inventory identity");
check(/^[a-f0-9]{64}$/.test(targetVerification.target.archive_sha256),
  "the verified target binds an archive identity");

check(
  (await assertRollbackTargetAttestable({
    packageRoot: goodRoot,
    attestation: goodAttestation,
    archivePath: goodArchivePath,
    expectedRuntimeCodeClosureSha256: goodClosure,
  })).status === "PASS",
  "the throwing assertion accepts an attestable target",
);
{
  const wrongClosure = await verifyRollbackTargetAttestation({
    packageRoot: goodRoot,
    attestation: goodAttestation,
    archivePath: goodArchivePath,
    expectedRuntimeCodeClosureSha256: hex64("some-other-closure"),
  });
  check(wrongClosure.status === "FAIL", "a target whose closure is not the one being rolled back to MUST be refused");
  refuses(wrongClosure.findings, "runtime-code closure", "the closure mismatch must be named");
}
{
  const mutatedRoot = path.join(scratch, "mutated-package");
  await fs.cp(goodRoot, mutatedRoot, { recursive: true });
  await fs.writeFile(path.join(mutatedRoot, "scripts", "entry.mjs"), "export const ok = false;\n");
  const mutated = await verifyRollbackTargetAttestation({
    packageRoot: mutatedRoot,
    attestation: goodAttestation,
    archivePath: goodArchivePath,
    expectedRuntimeCodeClosureSha256: goodClosure,
  });
  check(mutated.status === "FAIL", "a rollback target whose bytes moved after attestation MUST be refused");
  refuses(mutated.findings, "inventory", "the inventory divergence must be named");
  let threw = null;
  await assertRollbackTargetAttestable({
    packageRoot: mutatedRoot,
    attestation: goodAttestation,
    archivePath: goodArchivePath,
    expectedRuntimeCodeClosureSha256: goodClosure,
  }).then(() => {}, (error) => { threw = error; });
  check(threw !== null && /not attestable/.test(threw.message),
    "the throwing assertion refuses a target whose bytes moved");
}

// ---------------------------------------------------------------------------
// 4. Journal records: shape, chaining, and the rollback payload rules.
// ---------------------------------------------------------------------------
const actor = { kind: "human", identity: "release owner" };
const withdrawnClosure = hex64("withdrawn-closure");
const releaseBlock = ({ closure, status, mode = "development" }) => ({
  repository: "computering001/excel-inflow",
  source_commit: hex40(`commit-${closure}`),
  source_tree: hex40(`tree-${closure}`),
  skill_version: "3.7.7",
  package_mode: mode,
  deployment_status: status,
  runtime_code_closure_sha256: closure,
  complete_package_inventory_sha256: null,
  archive_sha256: null,
  release_package_attestation_sha256: null,
});

const genesis = createReleaseJournalRecord({
  policy: loaded,
  sequence: 0,
  previousRecordHash: null,
  eventType: "compile",
  recordedAt: "2026-08-19T09:00:00.000Z",
  actor,
  release: releaseBlock({ closure: withdrawnClosure, status: "not_installed" }),
});
check(genesis.schema_version === RELEASE_JOURNAL_RECORD_SCHEMA_VERSION, "record schema_version");
check(genesis.sequence === 0 && genesis.previous_record_hash === null, "the genesis record opens the chain");
check(genesis.record_hash === releaseJournalLine.hash(genesis), "the genesis record hash is self-consistent");
check(RELEASE_JOURNAL_EVENT_TYPES.includes(genesis.event_type), "event type is vocabulary");
check(genesis.rollback === null, "a compile record carries no rollback payload");

const retained = createReleaseJournalRecord({
  policy: loaded,
  sequence: 1,
  previousRecordHash: genesis.record_hash,
  eventType: "retain",
  recordedAt: "2026-08-19T09:05:00.000Z",
  actor,
  release: {
    ...releaseBlock({ closure: goodClosure, status: "not_installed" }),
    complete_package_inventory_sha256: targetVerification.target.complete_package_inventory_sha256,
    archive_sha256: targetVerification.target.archive_sha256,
    release_package_attestation_sha256: goodAttestation.attestation_sha256,
  },
});
const promoted = createReleaseJournalRecord({
  policy: loaded,
  sequence: 2,
  previousRecordHash: retained.record_hash,
  eventType: "promote",
  recordedAt: "2026-08-19T09:10:00.000Z",
  actor,
  release: releaseBlock({ closure: withdrawnClosure, status: "production_promoted" }),
});
const rollbackPayload = {
  trigger_id: policy.clauses.trigger_conditions.binding.triggers[0].trigger_id,
  authorisation_reference: "programme/P8.6a_issue_card.md",
  from: {
    source_commit: hex40(`commit-${withdrawnClosure}`),
    source_tree: hex40(`tree-${withdrawnClosure}`),
    runtime_code_closure_sha256: withdrawnClosure,
  },
  to: {
    source_commit: hex40(`commit-${goodClosure}`),
    source_tree: hex40(`tree-${goodClosure}`),
    runtime_code_closure_sha256: goodClosure,
    complete_package_inventory_sha256: targetVerification.target.complete_package_inventory_sha256,
    archive_sha256: targetVerification.target.archive_sha256,
    release_package_attestation_sha256: goodAttestation.attestation_sha256,
  },
  target_attestation_status: "PASS",
  in_flight_runs: [
    { run_id: "run-pinned-0001", disposition: "pinned_continue", terminal_reason_code: null },
    {
      run_id: "run-stopped-0002",
      disposition: "stopped_cancelled",
      terminal_reason_code: pinning.stop_path.terminal_reason_code,
    },
  ],
  preserved_evidence: [
    "rollback-evidence/withdrawn-package.tar",
    "rollback-evidence/withdrawn-package.attestation.json",
    "rollback-evidence/trigger-finding.json",
  ],
};
const rolledBack = createReleaseJournalRecord({
  policy: loaded,
  sequence: 3,
  previousRecordHash: promoted.record_hash,
  eventType: "rollback",
  recordedAt: "2026-08-19T09:20:00.000Z",
  actor,
  release: releaseBlock({ closure: withdrawnClosure, status: "rollback" }),
  rollback: rollbackPayload,
});
const chain = [genesis, retained, promoted, rolledBack];
{
  const verdict = validateReleaseJournal(chain, { policy: loaded });
  check(verdict.status === "PASS",
    `a well-formed four-event chain must validate; got ${JSON.stringify(verdict.findings)}`);
  check(verdict.record_count === 4 && verdict.tip_record_hash === rolledBack.record_hash,
    "the verdict reports the chain length and tip");
}

// Rollback payload rules.
{
  const noPayload = structuredClone(chain);
  noPayload[3].rollback = null;
  refuses(validateReleaseJournal(noPayload, { policy: loaded }).findings, "rollback payload",
    "a rollback event without a rollback payload MUST be caught");
}
{
  const strayPayload = structuredClone(chain);
  strayPayload[2].rollback = structuredClone(rollbackPayload);
  refuses(validateReleaseJournal(strayPayload, { policy: loaded }).findings, "rollback payload",
    "a non-rollback event carrying a rollback payload MUST be caught");
}
{
  const wrongStatus = structuredClone(chain);
  wrongStatus[3].release.deployment_status = "production_promoted";
  refuses(validateReleaseJournal(wrongStatus, { policy: loaded }).findings, "rollback",
    "a rollback record whose withdrawn package is not on the rollback status MUST be caught");
}
{
  const unknownTrigger = structuredClone(chain);
  unknownTrigger[3].rollback.trigger_id = "someone_felt_like_it";
  refuses(validateReleaseJournal(unknownTrigger, { policy: loaded }).findings, "trigger",
    "a rollback naming an undeclared trigger condition MUST be caught");
}
{
  const unattested = structuredClone(chain);
  unattested[3].rollback.target_attestation_status = "FAIL";
  refuses(validateReleaseJournal(unattested, { policy: loaded }).findings, "attestation",
    "a rollback whose target attestation did not pass MUST be caught");
}
{
  const unretained = structuredClone(chain);
  unretained.splice(1, 1);
  unretained[1].sequence = 1;
  unretained[2].sequence = 2;
  refuses(validateReleaseJournal(unretained, { policy: loaded }).findings, "retain",
    "a rollback to a target that was never journalled as retained MUST be caught");
}
{
  const untypedStop = structuredClone(chain);
  untypedStop[3].rollback.in_flight_runs[1].terminal_reason_code = null;
  refuses(validateReleaseJournal(untypedStop, { policy: loaded }).findings, "terminal reason",
    "a stopped in-flight run without the registered terminal reason MUST be caught");
}
{
  const invented = structuredClone(chain);
  invented[3].rollback.in_flight_runs[0].disposition = "silently_migrated";
  refuses(validateReleaseJournal(invented, { policy: loaded }).findings, "disposition",
    "an in-flight-run disposition outside the policy MUST be caught");
}
{
  const nowhere = structuredClone(chain);
  nowhere[3].rollback.to.runtime_code_closure_sha256 = withdrawnClosure;
  refuses(validateReleaseJournal(nowhere, { policy: loaded }).findings, "same package",
    "a rollback to the package being withdrawn MUST be caught");
}
{
  const repromoted = structuredClone(chain);
  repromoted.push(
    createReleaseJournalRecord({
      policy: loaded,
      sequence: 4,
      previousRecordHash: rolledBack.record_hash,
      eventType: "promote",
      recordedAt: "2026-08-19T09:30:00.000Z",
      actor,
      release: releaseBlock({ closure: withdrawnClosure, status: "production_promoted" }),
    }),
  );
  refuses(validateReleaseJournal(repromoted, { policy: loaded }).findings, "withdrawn",
    "re-promoting a package identity that was rolled back MUST be caught");
}
{
  const foreignPolicy = structuredClone(chain);
  foreignPolicy[1].policy.policy_sha256 = hex64("a-different-policy");
  refuses(validateReleaseJournal(foreignPolicy, { policy: loaded }).findings, "policy",
    "a record sealed under a different policy identity MUST be caught");
}

// Chain integrity mutations.
{
  const outOfChain = structuredClone(chain);
  outOfChain[2].previous_record_hash = hex64("not-the-previous-record");
  refuses(validateReleaseJournal(outOfChain, { policy: loaded }).findings, "previous_record_hash",
    "a record inserted out of chain MUST be caught");
}
{
  const gap = structuredClone(chain);
  gap.splice(2, 1);
  refuses(validateReleaseJournal(gap, { policy: loaded }).findings, "sequence",
    "a sequence gap MUST be caught");
}
{
  const tampered = structuredClone(chain);
  tampered[1].actor.identity = "someone else";
  refuses(validateReleaseJournal(tampered, { policy: loaded }).findings, "record_hash",
    "editing a sealed record MUST be caught");
}
{
  const reordered = [chain[0], chain[2], chain[1], chain[3]].map((record) => structuredClone(record));
  refuses(validateReleaseJournal(reordered, { policy: loaded }).findings, "sequence",
    "reordering two records MUST be caught");
}
{
  const forked = structuredClone(chain);
  forked[3].previous_record_hash = genesis.record_hash;
  refuses(validateReleaseJournal(forked, { policy: loaded }).findings, "previous_record_hash",
    "a fork off an earlier record MUST be caught");
}
{
  const backdated = structuredClone(chain);
  backdated[2].recorded_at = "2026-08-19T08:00:00.000Z";
  refuses(validateReleaseJournal(backdated, { policy: loaded }).findings, "recorded_at",
    "a backdated record MUST be caught");
}
{
  const noGenesis = structuredClone(chain).slice(1);
  refuses(validateReleaseJournal(noGenesis, { policy: loaded }).findings, "sequence",
    "a journal that does not start at sequence 0 MUST be caught");
}

// ---------------------------------------------------------------------------
// 5. On disk: the journal is genuinely append-only.
// ---------------------------------------------------------------------------
const journalPath = path.join(scratch, "release-journal.jsonl");
const appendedGenesis = await appendReleaseJournalRecord({
  journalPath,
  policy: loaded,
  event: {
    event_type: "compile",
    recorded_at: "2026-08-19T09:00:00.000Z",
    actor,
    release: releaseBlock({ closure: withdrawnClosure, status: "not_installed" }),
  },
});
check(appendedGenesis.sequence === 0, "the first appended record is sequence 0");
const bytesAfterFirst = await fs.readFile(journalPath);
const appendedSecond = await appendReleaseJournalRecord({
  journalPath,
  policy: loaded,
  event: {
    event_type: "retain",
    recorded_at: "2026-08-19T09:05:00.000Z",
    actor,
    release: {
      ...releaseBlock({ closure: goodClosure, status: "not_installed" }),
      complete_package_inventory_sha256: targetVerification.target.complete_package_inventory_sha256,
      archive_sha256: targetVerification.target.archive_sha256,
      release_package_attestation_sha256: goodAttestation.attestation_sha256,
    },
  },
});
const bytesAfterSecond = await fs.readFile(journalPath);
check(appendedSecond.sequence === 1 && appendedSecond.previous_record_hash === appendedGenesis.record_hash,
  "the second appended record chains onto the first");
check(bytesAfterSecond.subarray(0, bytesAfterFirst.length).equals(bytesAfterFirst),
  "appending MUST leave every earlier byte untouched");
check(bytesAfterSecond.length > bytesAfterFirst.length, "appending adds bytes");

const rolledBackOnDisk = await appendReleaseJournalRecord({
  journalPath,
  policy: loaded,
  event: {
    event_type: "promote",
    recorded_at: "2026-08-19T09:10:00.000Z",
    actor,
    release: releaseBlock({ closure: withdrawnClosure, status: "production_promoted" }),
  },
});
check(rolledBackOnDisk.sequence === 2, "the third appended record is sequence 2");
const appendedRollback = await appendReleaseJournalRecord({
  journalPath,
  policy: loaded,
  event: {
    event_type: "rollback",
    recorded_at: "2026-08-19T09:20:00.000Z",
    actor,
    release: releaseBlock({ closure: withdrawnClosure, status: "rollback" }),
    rollback: rollbackPayload,
  },
  rollbackTargetVerification: targetVerification,
});
check(appendedRollback.sequence === 3, "the rollback record is sequence 3");
{
  const readBack = await readReleaseJournal(journalPath, { policy: loaded });
  check(readBack.status === "PASS", `the on-disk journal must read back clean; got ${JSON.stringify(readBack.findings)}`);
  check(readBack.record_count === 4, "the on-disk journal holds four records");
  check(readBack.tip_record_hash === appendedRollback.record_hash, "the read-back tip is the last appended record");
}

// A rollback may not be journalled without an attestable target.
{
  const unattestable = await verifyRollbackTargetAttestation({
    packageRoot: goodRoot,
    attestation: goodAttestation,
    archivePath: goodArchivePath,
    expectedRuntimeCodeClosureSha256: hex64("some-other-closure"),
  });
  const beforeRefusal = await fs.readFile(journalPath);
  let refused = null;
  await appendReleaseJournalRecord({
    journalPath,
    policy: loaded,
    event: {
      event_type: "rollback",
      recorded_at: "2026-08-19T09:40:00.000Z",
      actor,
      release: releaseBlock({ closure: withdrawnClosure, status: "rollback" }),
      rollback: rollbackPayload,
    },
    rollbackTargetVerification: unattestable,
  }).then(
    () => {},
    (error) => { refused = error; },
  );
  check(refused !== null, "journalling a rollback whose target is NOT attestable MUST be refused");
  check(/not attestable|attestation/i.test(refused.message), "the refusal names the attestation failure");
  check((await fs.readFile(journalPath)).equals(beforeRefusal), "the refused append wrote nothing");
  const stillFour = await readReleaseJournal(journalPath, { policy: loaded });
  check(stillFour.record_count === 4, "the refused rollback append left the journal at four records");
}
{
  let refused = null;
  await appendReleaseJournalRecord({
    journalPath,
    policy: loaded,
    event: {
      event_type: "rollback",
      recorded_at: "2026-08-19T09:45:00.000Z",
      actor,
      release: releaseBlock({ closure: withdrawnClosure, status: "rollback" }),
      rollback: rollbackPayload,
    },
  }).then(() => {}, (error) => { refused = error; });
  check(refused !== null, "journalling a rollback with NO target verification at all MUST be refused");
}

// Appending onto a tampered journal is refused, not repaired.
{
  const tamperedPath = path.join(scratch, "tampered-journal.jsonl");
  const lines = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n");
  const second = JSON.parse(lines[1]);
  second.actor.identity = "someone else";
  lines[1] = JSON.stringify(second);
  await fs.writeFile(tamperedPath, `${lines.join("\n")}\n`);
  const verdict = await readReleaseJournal(tamperedPath, { policy: loaded });
  check(verdict.status === "FAIL", "a tampered on-disk journal must read FAIL");
  let refused = null;
  await appendReleaseJournalRecord({
    journalPath: tamperedPath,
    policy: loaded,
    event: {
      event_type: "supersede",
      recorded_at: "2026-08-19T10:00:00.000Z",
      actor,
      release: releaseBlock({ closure: hex64("next-closure"), status: "not_installed" }),
    },
  }).then(() => {}, (error) => { refused = error; });
  check(refused !== null, "appending onto a broken chain MUST be refused, never repaired");
  const afterRefusal = (await fs.readFile(tamperedPath, "utf8")).trimEnd().split("\n");
  check(afterRefusal.length === 4, "the refused append did not grow the tampered journal");
}
{
  const garbagePath = path.join(scratch, "garbage-journal.jsonl");
  await fs.writeFile(garbagePath, "{not json}\n");
  const verdict = await readReleaseJournal(garbagePath, { policy: loaded });
  check(verdict.status === "FAIL", "an unparseable journal line must read FAIL");
  refuses(verdict.findings, "line 1", "the unparseable line must be named");
}
{
  const absent = await readReleaseJournal(path.join(scratch, "no-such-journal.jsonl"), { policy: loaded });
  check(absent.status === "PASS" && absent.record_count === 0,
    "an absent journal is an empty journal, not a broken one");
}

// ---------------------------------------------------------------------------
// 6. The human runbook exists and declares the installed-host exclusion.
// ---------------------------------------------------------------------------
{
  const runbook = await fs.readFile(path.join(ROOT, "references", "release-rollback-runbook.md"), "utf8");
  check(runbook.includes(EXCLUDED_INSTALLED_HOST),
    "the runbook must name the installed-host exclusion explicitly");
  for (const id of requiredIds) {
    check(runbook.includes(id), `the runbook must cover clause ${id}`);
  }
  check(runbook.includes("assets/release-rollback-policy-v1.json"), "the runbook cites the policy asset");
  check(runbook.includes("release_journal.mjs"), "the runbook cites the journal writer");
  check(!/\brelease rollback is a run resume\b/i.test(runbook), "the runbook must not conflate run resume with rollback");
}

await fs.rm(scratch, { recursive: true, force: true });

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
