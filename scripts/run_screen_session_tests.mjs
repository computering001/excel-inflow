#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonBytes } from "./lib/durable_artifact_generation.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  consumeScreenSession,
  issueScreenSession,
  verifyScreenSession,
} from "./lib/screen_session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "screen-session-receipt-v1.schema.json"), "utf8"),
);

const CREATED_AT = "2026-08-21T12:00:00.000Z";
const VERIFY_AT = new Date("2026-08-21T12:00:01.000Z");
const SHA = Object.freeze({
  package: "a".repeat(64),
  packageChanged: "b".repeat(64),
  closure: "c".repeat(64),
  closureChanged: "d".repeat(64),
  pointer: "e".repeat(64),
  pointerChanged: "f".repeat(64),
  capability: "1".repeat(64),
  doctor: "2".repeat(64),
  screen: "3".repeat(64),
  rendered: "4".repeat(64),
});
const SOURCE_COMMIT = "5".repeat(40);
const SOURCE_TREE = "6".repeat(40);
const INSTALLATION = "excel-inflow-v379-candidate-a";

let checks = 0;
let mutations = 0;

function secret() {
  return randomBytes(32).toString("hex");
}

function candidateIssue(sessionRoot, sessionId, sessionSecret, overrides = {}) {
  return {
    skillRoot: ROOT,
    sessionRoot,
    sessionId,
    sessionSecret,
    runtimeMode: "INSTALLED_CANDIDATE",
    createdAt: CREATED_AT,
    ttlMs: 600_000,
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
    runtimeClosureSha256: SHA.closure,
    packageInventorySha256: SHA.package,
    installationIdentity: INSTALLATION,
    activePointerSha256: SHA.pointer,
    capabilityReceiptSha256: SHA.capability,
    runtimeDoctorReportSha256: SHA.doctor,
    screenContractSha256: SHA.screen,
    renderedScreenSha256: SHA.rendered,
    ...overrides,
  };
}

function candidateExpected(overrides = {}) {
  return {
    runtime_mode: "INSTALLED_CANDIDATE",
    source_commit: SOURCE_COMMIT,
    source_tree: SOURCE_TREE,
    runtime_closure_sha256: SHA.closure,
    package_inventory_sha256: SHA.package,
    installation_identity: INSTALLATION,
    active_pointer_sha256: SHA.pointer,
    capability_receipt_sha256: SHA.capability,
    runtime_doctor_report_sha256: SHA.doctor,
    screen_contract_sha256: SHA.screen,
    rendered_screen_sha256: SHA.rendered,
    ...overrides,
  };
}

function verification(issued, sessionId, sessionSecret, overrides = {}) {
  return {
    skillRoot: ROOT,
    sessionRoot: issued.sessionRoot,
    receiptPath: issued.receiptPath,
    sessionId,
    sessionSecret,
    expected: candidateExpected(),
    now: VERIFY_AT,
    ...overrides,
  };
}

async function expectRefusal(label, work, reason = null) {
  checks += 1;
  mutations += 1;
  await assert.rejects(work, (error) => {
    if (reason !== null) {
      assert.equal(error?.reason, reason, `${label}: ${error?.stack ?? error}`);
    }
    return true;
  }, label);
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-screen-session-"));
try {
  const store = path.join(scratch, "sessions");
  const sessionA = "rogo-session-a";
  const sessionB = "rogo-session-b";
  const secretA = secret();
  const secretB = secret();

  const issuedA = await issueScreenSession(candidateIssue(store, sessionA, secretA, {
    receiptPath: path.join(store, "company-entry-a.json"),
  }));
  const issuedB = await issueScreenSession(candidateIssue(store, sessionB, secretB));
  checks += 8;
  assert.notEqual(issuedA.receipt.screen_session_id, issuedB.receipt.screen_session_id);
  assert.notEqual(issuedA.receipt.screen_nonce, issuedB.receipt.screen_nonce);
  assert.match(issuedA.receipt.screen_nonce, /^[A-F0-9]{6}$/);
  assert.equal(validateJsonSchema(issuedA.receipt, SCHEMA).length, 0);
  assert.equal(validateJsonSchema(issuedB.receipt, SCHEMA).length, 0);
  assert.equal(issuedA.receipt.expected_next_stage, "company_resolution");
  assert.equal(issuedA.receipt.runtime_mode, "INSTALLED_CANDIDATE");
  assert.equal(issuedA.receipt.active_pointer_sha256, SHA.pointer);

  const rawA = await fs.readFile(issuedA.receiptPath, "utf8");
  checks += 3;
  assert.equal(rawA.includes(secretA), false, "Session secret leaked into the receipt bytes.");
  assert.equal(Object.hasOwn(issuedA.receipt, "session_secret"), false);
  assert.equal((await fs.readdir(store)).some((name) => /^(latest|current)/i.test(name)), false);
  await expectRefusal(
    "caller-selected receipt target is immutable and cannot be clobbered",
    issueScreenSession(candidateIssue(store, "rogo-session-c", secret(), {
      receiptPath: issuedA.receiptPath,
    })),
  );
  checks += 1;
  assert.equal(await fs.readFile(issuedA.receiptPath, "utf8"), rawA);

  const verifiedA = await verifyScreenSession(verification(issuedA, sessionA, secretA));
  const verifiedB = await verifyScreenSession(verification(issuedB, sessionB, secretB));
  checks += 2;
  assert.equal(verifiedA.receipt.receipt_sha256, issuedA.receipt.receipt_sha256);
  assert.equal(verifiedB.receipt.receipt_sha256, issuedB.receipt.receipt_sha256);

  await expectRefusal(
    "wrong session secret",
    verifyScreenSession(verification(issuedA, sessionA, secret(), {})),
    "WRONG_SESSION_SECRET",
  );
  await expectRefusal(
    "one session reply supplied to another",
    verifyScreenSession(verification(issuedA, sessionB, secretB)),
    "WRONG_SESSION_ID",
  );
  await expectRefusal(
    "wrong package identity",
    verifyScreenSession(verification(issuedA, sessionA, secretA, {
      expected: candidateExpected({ package_inventory_sha256: SHA.packageChanged }),
    })),
    "WRONG_PACKAGE",
  );
  await expectRefusal(
    "wrong installation identity",
    verifyScreenSession(verification(issuedA, sessionA, secretA, {
      expected: candidateExpected({ installation_identity: "excel-inflow-v379-candidate-b" }),
    })),
    "WRONG_INSTALLATION",
  );
  await expectRefusal(
    "active pointer changes after screen receipt",
    verifyScreenSession(verification(issuedA, sessionA, secretA, {
      expected: candidateExpected({ active_pointer_sha256: SHA.pointerChanged }),
    })),
    "WRONG_ACTIVE_POINTER",
  );
  await expectRefusal(
    "runtime closure changes after screen receipt",
    verifyScreenSession(verification(issuedA, sessionA, secretA, {
      expected: candidateExpected({ runtime_closure_sha256: SHA.closureChanged }),
    })),
    "WRONG_RUNTIME_CLOSURE",
  );
  await expectRefusal(
    "candidate receipt presented after promotion",
    verifyScreenSession(verification(issuedA, sessionA, secretA, {
      expected: candidateExpected({ runtime_mode: "PRODUCTION_ACTIVE" }),
    })),
    "WRONG_RUNTIME_MODE",
  );

  const copiedStore = path.join(scratch, "copied-session-store");
  await fs.mkdir(copiedStore, { recursive: true });
  const copiedReceipt = path.join(copiedStore, path.basename(issuedA.receiptPath));
  await fs.copyFile(issuedA.receiptPath, copiedReceipt);
  await expectRefusal(
    "authenticated static receipt copied to another explicit root",
    verifyScreenSession({
      ...verification(issuedA, sessionA, secretA),
      sessionRoot: copiedStore,
      receiptPath: copiedReceipt,
    }),
    "WRONG_SESSION_ROOT",
  );

  const copiedSameRoot = path.join(store, "copied-company-entry.json");
  await fs.copyFile(issuedA.receiptPath, copiedSameRoot);
  await expectRefusal(
    "authenticated receipt copied to another path in the same store",
    verifyScreenSession({
      ...verification(issuedA, sessionA, secretA),
      receiptPath: copiedSameRoot,
    }),
    "WRONG_RECEIPT_PATH",
  );

  const staticScreen = path.join(store, "company-screen.txt");
  await fs.writeFile(staticScreen, "HOST READY - copied static screen\n", "utf8");
  await expectRefusal(
    "static Company-screen copy has no receipt",
    verifyScreenSession({
      ...verification(issuedA, sessionA, secretA),
      receiptPath: staticScreen,
    }),
    "RECEIPT_OUTSIDE_STORE",
  );

  const expiredStore = path.join(scratch, "expired");
  const expiredSecret = secret();
  const expired = await issueScreenSession(candidateIssue(
    expiredStore,
    "expired-session",
    expiredSecret,
    { ttlMs: 1_000 },
  ));
  await expectRefusal(
    "expired receipt",
    verifyScreenSession(verification(expired, "expired-session", expiredSecret, {
      now: new Date("2026-08-21T12:00:01.000Z"),
    })),
    "EXPIRED",
  );

  const tamperStore = path.join(scratch, "tamper");
  const tamperSecret = secret();
  const tampered = await issueScreenSession(candidateIssue(tamperStore, "tamper-session", tamperSecret));
  const tamperedValue = JSON.parse(await fs.readFile(tampered.receiptPath, "utf8"));
  tamperedValue.source_commit = "7".repeat(40);
  await fs.writeFile(tampered.receiptPath, canonicalJsonBytes(tamperedValue));
  await expectRefusal(
    "receipt content changes without resealing",
    verifyScreenSession(verification(tampered, "tamper-session", tamperSecret)),
    "SELF_HASH_MISMATCH",
  );

  const replayClaim = await consumeScreenSession({
    ...verification(issuedB, sessionB, secretB),
    consumerRunId: "model-run-b",
    consumedAt: "2026-08-21T12:00:02.000Z",
  });
  checks += 2;
  assert.equal(replayClaim.claim.receipt_sha256, issuedB.receipt.receipt_sha256);
  assert.equal(replayClaim.claim.consumer_run_id, "model-run-b");
  await expectRefusal(
    "already consumed receipt",
    consumeScreenSession({
      ...verification(issuedB, sessionB, secretB),
      consumerRunId: "model-run-b",
      consumedAt: "2026-08-21T12:00:02.000Z",
    }),
    "ALREADY_CONSUMED",
  );

  const concurrentStore = path.join(scratch, "concurrent");
  const concurrentSecret = secret();
  const concurrent = await issueScreenSession(candidateIssue(
    concurrentStore,
    "concurrent-session",
    concurrentSecret,
  ));
  const concurrentVerification = verification(
    concurrent,
    "concurrent-session",
    concurrentSecret,
  );
  const claims = await Promise.allSettled([
    consumeScreenSession({
      ...concurrentVerification,
      consumerRunId: "concurrent-run-a",
      consumedAt: "2026-08-21T12:00:03.000Z",
    }),
    consumeScreenSession({
      ...concurrentVerification,
      consumerRunId: "concurrent-run-b",
      consumedAt: "2026-08-21T12:00:03.000Z",
    }),
  ]);
  checks += 3;
  mutations += 1;
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(claims.filter((result) => result.status === "rejected").length, 1);
  assert.equal(claims.find((result) => result.status === "rejected")?.reason?.reason, "ALREADY_CONSUMED");

  const developmentStore = path.join(scratch, "development");
  const developmentSecret = secret();
  const development = await issueScreenSession({
    ...candidateIssue(developmentStore, "development-session", developmentSecret),
    runtimeMode: "DEVELOPMENT_SOURCE",
    packageInventorySha256: null,
    installationIdentity: null,
    activePointerSha256: null,
  });
  const verifiedDevelopment = await verifyScreenSession({
    skillRoot: ROOT,
    sessionRoot: development.sessionRoot,
    receiptPath: development.receiptPath,
    sessionId: "development-session",
    sessionSecret: developmentSecret,
    now: VERIFY_AT,
    expected: {
      ...candidateExpected(),
      runtime_mode: "DEVELOPMENT_SOURCE",
      package_inventory_sha256: null,
      installation_identity: null,
      active_pointer_sha256: null,
    },
  });
  checks += 1;
  assert.equal(verifiedDevelopment.receipt.runtime_mode, "DEVELOPMENT_SOURCE");

  const productionStore = path.join(scratch, "production");
  const productionSecret = secret();
  const production = await issueScreenSession({
    ...candidateIssue(productionStore, "production-session", productionSecret),
    runtimeMode: "PRODUCTION_ACTIVE",
  });
  const verifiedProduction = await verifyScreenSession({
    ...verification(production, "production-session", productionSecret),
    expected: candidateExpected({ runtime_mode: "PRODUCTION_ACTIVE" }),
  });
  checks += 2;
  assert.equal(verifiedProduction.receipt.runtime_mode, "PRODUCTION_ACTIVE");
  assert.equal(verifiedProduction.receipt.active_pointer_sha256, SHA.pointer);

  await expectRefusal(
    "candidate without installation identity",
    issueScreenSession(candidateIssue(path.join(scratch, "bad-candidate"), "bad-candidate", secret(), {
      installationIdentity: null,
    })),
    "INVALID_ARGUMENT",
  );
  await expectRefusal(
    "installed candidate without current active-pointer identity",
    issueScreenSession(candidateIssue(path.join(scratch, "bad-pointer"), "bad-pointer", secret(), {
      activePointerSha256: null,
    })),
    "INVALID_ARGUMENT",
  );
  await expectRefusal(
    "production package without active promotion-pointer identity",
    issueScreenSession({
      ...candidateIssue(path.join(scratch, "bad-production"), "bad-production", secret()),
      runtimeMode: "PRODUCTION_ACTIVE",
      activePointerSha256: null,
    }),
    "INVALID_ARGUMENT",
  );

  const insideRoot = path.join(ROOT, `.screen-session-refusal-${process.pid}`);
  await fs.rm(insideRoot, { recursive: true, force: true });
  await expectRefusal(
    "session root directly inside immutable package",
    issueScreenSession(candidateIssue(insideRoot, "inside-package", secret())),
  );
  checks += 1;
  await assert.rejects(fs.lstat(insideRoot), (error) => error?.code === "ENOENT");

  const symlinkRoot = path.join(scratch, "symlink-into-package");
  await fs.symlink(path.join(ROOT, "assets"), symlinkRoot, "dir");
  await expectRefusal(
    "session root symlink resolves inside immutable package",
    issueScreenSession(candidateIssue(symlinkRoot, "symlink-package", secret())),
  );

  const residue = [];
  for (const directory of [
    store,
    expiredStore,
    tamperStore,
    concurrentStore,
    developmentStore,
    productionStore,
  ]) {
    for (const name of await fs.readdir(directory)) {
      if (name.includes(".tmp-")) residue.push(path.join(directory, name));
    }
  }
  checks += 1;
  assert.deepEqual(residue, [], `Durable publication left temporary residue: ${residue.join(", ")}`);

  process.stdout.write(`${JSON.stringify({
    schema_version: "screen-session-focused-tests/1.0",
    status: "PASS",
    total_checks: checks,
    non_vacuous_mutations: mutations,
    receipt_count: 7,
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
