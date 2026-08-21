#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMPANY_SCREEN_SESSION_CONTRACT_SHA256, renderCompanyScreen } from "./lib/flow_screens.mjs";
import { identitySha256 } from "./lib/identity_vocabulary.mjs";
import { InstalledRuntimeIdentityError, resolveInstalledRuntimeIdentity } from "./lib/installed_runtime_identity.mjs";
import { completePackageInventoryIdentity } from "./lib/release_package_attestation.mjs";
import { captureRuntimeIntegrity } from "./lib/runtime_isolation.mjs";
import { deriveRuntimeMode } from "./lib/runtime_mode.mjs";
import { consumeScreenSession, issueScreenSession, verifyScreenSession } from "./lib/screen_session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-phase3-integration-"));
const GIT = (character) => character.repeat(40);
const SHA = (seed) => identitySha256({ seed });
const NOW = "2026-08-21T12:00:00.000Z";
const VERIFY_AT = new Date("2026-08-21T12:00:01.000Z");
const DOCTOR_SHA = SHA("runtime-doctor");
const results = [];
let mutations = 0;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
  }
  return value;
}

function capabilityDigest(receipt) {
  const body = { ...receipt };
  delete body.receipt_sha256;
  return sha256(Buffer.from(`${JSON.stringify(canonicalise(body))}\n`, "utf8"));
}

async function writeJson(target, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return sha256(bytes);
}

async function reseal(target, hashField, mutate) {
  const value = JSON.parse(await fs.readFile(target, "utf8"));
  mutate(value);
  delete value[hashField];
  value[hashField] = identitySha256(value);
  return writeJson(target, value);
}

async function check(id, name, proof, work) {
  await work();
  results.push({ id, name, proof, status: "PASS" });
  process.stdout.write(`PASS ${id} ${name} [${proof}]\n`);
}

async function identityRefusal(work, code) {
  mutations += 1;
  await assert.rejects(work, (error) => {
    assert(error instanceof InstalledRuntimeIdentityError, String(error?.stack ?? error));
    assert.equal(error.code, code);
    return true;
  });
}

async function sessionRefusal(work, reason) {
  mutations += 1;
  await assert.rejects(work, (error) => {
    assert.equal(error?.reason, reason, String(error?.stack ?? error));
    return true;
  });
}

async function buildPackage(mode = "development") {
  const packageRoot = path.join(SCRATCH, `package-${mode}-${results.length}-${Math.random()}`);
  await fs.mkdir(path.join(packageRoot, "assets"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), "phase 3 fixture\n");
  await fs.writeFile(path.join(packageRoot, "scripts", "fixture-runtime.mjs"), "export default true;\n");
  for (const name of [
    "installation-receipt-v1.schema.json",
    "active-install-pointer-v1.schema.json",
    "production-promotion-receipt-v1.schema.json",
  ]) await fs.copyFile(path.join(ROOT, "assets", name), path.join(packageRoot, "assets", name));
  await writeJson(path.join(packageRoot, "assets", "deployment-profile.json"), {
    reference_allowlist: [], asset_allowlist: [], script_allowlist: ["fixture-runtime.mjs"],
    python_module_allowlist: [], resource_directory_allowlist: [], vendored_dependencies: [],
  });
  await writeJson(path.join(packageRoot, "assets", "runtime-manifest.json"), {
    skill_version: "phase3-fixture", status: "compiled_fixture", package_mode: mode,
    deployment_status: "not_installed",
  });
  const closure = (await captureRuntimeIntegrity(packageRoot)).runtime_code_closure.sha256;
  await writeJson(path.join(packageRoot, "release-manifest.json"), {
    schemaVersion: 2,
    releaseName: "phase3-fixture",
    packageMode: mode,
    skillVersion: "phase3-fixture",
    identity: {
      schema_version: "product-identity/2.0",
      source: { identity_kind: "source_tree", repository: "fixture/repository", commit_sha: GIT("a"), tree_sha: GIT("b") },
      package: {
        mode,
        runtime_code_closure: { identity_kind: "runtime_code_closure", sha256: closure, certified_sha256: mode === "certified" ? closure : null },
        complete_package_inventory: { identity_kind: "complete_package_inventory", sha256: null },
        archive: { identity_kind: "archive", sha256: null },
      },
      deployment: { status: "not_installed", installation_identity: null, installed_package: { identity_kind: "installed_package", sha256: null } },
    },
    files: [],
  });
  const inventory = (await completePackageInventoryIdentity(packageRoot)).sha256;
  const stateRoot = path.join(SCRATCH, `state-${mode}-${results.length}-${Math.random()}`);
  await fs.mkdir(stateRoot, { recursive: true });
  const archiveBytes = Buffer.from(`archive:${inventory}\n`, "utf8");
  await fs.writeFile(path.join(stateRoot, "package-archive.tar"), archiveBytes);
  return { packageRoot, stateRoot, mode, closure, inventory, archive: sha256(archiveBytes) };
}

async function installFixture({ mode = "development", production = false } = {}) {
  const fixture = await buildPackage(mode);
  fixture.installedAt = new Date(Date.now() - 120_000).toISOString();
  fixture.activatedAt = new Date(Date.now() - 60_000).toISOString();
  const installation = {
    schema_version: "excel-inflow-installation-receipt/1.0",
    installation_identity: "installation-phase3-fixture",
    installation_generation: 7,
    slot_id: "slot-under-test",
    installed_at: fixture.installedAt,
    package: {
      source_commit: GIT("a"), source_tree: GIT("b"), package_mode: mode,
      package_inventory_sha256: fixture.inventory, archive_sha256: fixture.archive,
      runtime_closure_sha256: fixture.closure,
      certified_runtime_closure_sha256: mode === "certified" ? fixture.closure : null,
      installed_package_sha256: fixture.inventory,
    },
  };
  installation.receipt_sha256 = identitySha256(installation);
  fixture.installationRawSha = await writeJson(path.join(fixture.stateRoot, "installation-receipt.json"), installation);
  fixture.installation = installation;
  await writePointer(fixture, { production: false });
  if (production) await promoteFixture(fixture);
  return fixture;
}

async function writePointer(fixture, { production, promotionRawSha = null, rollbackSha = null } = {}) {
  const pointer = production ? {
    schema_version: "excel-inflow-active-install-pointer/1.0", generation: 11,
    slot_id: "slot-under-test", installation_identity: fixture.installation.installation_identity,
    installation_receipt_sha256: fixture.installationRawSha,
    package_inventory_sha256: fixture.inventory, archive_sha256: fixture.archive,
    runtime_closure_sha256: fixture.closure, promotion_receipt_sha256: promotionRawSha,
    previous_slot_id: "slot-previous-good", rollback_package_sha256: rollbackSha,
    activated_at: fixture.activatedAt,
  } : {
    schema_version: "excel-inflow-active-install-pointer/1.0", generation: 9,
    slot_id: "different-active-slot", installation_identity: "different-installation",
    installation_receipt_sha256: SHA("other-install"), package_inventory_sha256: SHA("other-package"),
    archive_sha256: SHA("other-archive"), runtime_closure_sha256: SHA("other-closure"),
    promotion_receipt_sha256: SHA("other-promotion"), previous_slot_id: "other-slot",
    rollback_package_sha256: SHA("other-rollback"), activated_at: fixture.activatedAt,
  };
  pointer.pointer_sha256 = identitySha256(pointer);
  await writeJson(path.join(fixture.stateRoot, "active-install-pointer.json"), pointer);
}

async function promoteFixture(fixture) {
  const certification = Buffer.from(`${JSON.stringify({ status: "PASS", runtime_code_closure_sha256: fixture.closure })}\n`);
  const rollback = Buffer.from("previous known-good package\n");
  await fs.writeFile(path.join(fixture.stateRoot, "certification-receipt.json"), certification);
  await fs.writeFile(path.join(fixture.stateRoot, "rollback-package.tar"), rollback);
  const promotion = {
    schema_version: "excel-inflow-production-promotion-receipt/1.0", promotion_id: "promotion-phase3-fixture",
    activation_generation: 11, installation_generation: 7, slot_id: "slot-under-test",
    installation_identity: fixture.installation.installation_identity,
    installation_receipt_sha256: fixture.installationRawSha,
    package_inventory_sha256: fixture.inventory, archive_sha256: fixture.archive,
    runtime_closure_sha256: fixture.closure, certified_runtime_closure_sha256: fixture.closure,
    certification_receipt_sha256: sha256(certification), previous_slot_id: "slot-previous-good",
    rollback_package_sha256: sha256(rollback), promoted_at: fixture.activatedAt,
  };
  promotion.receipt_sha256 = identitySha256(promotion);
  const promotionRawSha = await writeJson(path.join(fixture.stateRoot, "production-promotion-receipt.json"), promotion);
  await writePointer(fixture, { production: true, promotionRawSha, rollbackSha: sha256(rollback) });
}

function capabilityFor(fixture, production = false) {
  const receipt = {
    schema_version: "excel-inflow-installed-capability-receipt/1.3", status: "HOST_READY",
    requested_lanes: ["evidence", "workbook"], candidate_slot_ready: !production,
    source_identity: {
      deployment_status: production ? "production_promoted" : "installed_candidate",
      installation_identity: fixture.installation.installation_identity,
      active_runtime_code_closure_sha256: fixture.closure,
      complete_package_inventory_sha256: fixture.inventory, archive_sha256: fixture.archive,
    },
  };
  receipt.receipt_sha256 = capabilityDigest(receipt);
  return receipt;
}

async function deriveInstalled(fixture, production = false) {
  const capability = capabilityFor(fixture, production);
  return deriveRuntimeMode({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot, capabilityReceipt: capability, capabilityReceiptSha256: capability.receipt_sha256 });
}

function expectedFrom(mode, overrides = {}) {
  const source = mode.source_identity_overrides;
  return {
    runtime_mode: mode.runtime_mode,
    source_commit: source.source_commit,
    source_tree: source.source_tree,
    runtime_closure_sha256: source.runtime_code_closure_sha256,
    package_inventory_sha256: source.complete_package_inventory_sha256,
    installation_identity: source.installation_identity,
    active_pointer_sha256: mode.installed_placement.active_pointer_sha256,
    ...overrides,
  };
}

async function issueFor(mode, sessionId, sessionSecret, suffix, overrides = {}) {
  const expected = expectedFrom(mode);
  return issueScreenSession({
    skillRoot: ROOT, sessionRoot: path.join(SCRATCH, `sessions-${suffix}`), sessionId, sessionSecret,
    runtimeMode: mode.runtime_mode, createdAt: NOW, ttlMs: 600_000,
    sourceCommit: expected.source_commit ?? GIT("c"), sourceTree: expected.source_tree ?? GIT("d"),
    runtimeClosureSha256: expected.runtime_closure_sha256,
    packageInventorySha256: expected.package_inventory_sha256,
    installationIdentity: expected.installation_identity, activePointerSha256: expected.active_pointer_sha256,
    capabilityReceiptSha256: mode.installed_placement.capability_receipt_sha256 ?? SHA("development-capability"),
    runtimeDoctorReportSha256: DOCTOR_SHA, screenContractSha256: COMPANY_SCREEN_SESSION_CONTRACT_SHA256,
    renderedScreenSha256: null, ...overrides,
  });
}

function verifyArgs(issued, mode, sessionId, sessionSecret, overrides = {}) {
  return { skillRoot: ROOT, sessionRoot: issued.sessionRoot, receiptPath: issued.receiptPath, sessionId, sessionSecret, expected: expectedFrom(mode), now: VERIFY_AT, ...overrides };
}

try {
  const devMode = await deriveRuntimeMode({ skillRoot: ROOT });
  const devSecret = randomBytes(32).toString("hex");
  const devReceipt = await issueFor(devMode, "phase3-dev", devSecret, "dev");
  await check("9.8-01", "source checkout host ready", "real mode derivation + dynamic renderer", async () => {
    const screen = renderCompanyScreen({ runtimeMode: devMode.runtime_mode, screenNonce: devReceipt.receipt.screen_nonce });
    assert.match(screen, /DEVELOPMENT SOURCE · NOT INSTALLED/);
    assert.match(screen, new RegExp(`HOST READY · SESSION ${devReceipt.receipt.screen_nonce}`));
  });
  await check("9.8-02", "development checkout pretending production", "untrusted override refusal + environment ignored", async () => {
    await identityRefusal(() => deriveRuntimeMode({ skillRoot: ROOT, runtimeMode: "PRODUCTION_ACTIVE" }), "UNTRUSTED_RUNTIME_MODE_INPUT");
    const prior = process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS;
    process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS = "production_promoted";
    try { assert.equal((await deriveRuntimeMode({ skillRoot: ROOT })).runtime_mode, "DEVELOPMENT_SOURCE"); }
    finally { if (prior === undefined) delete process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS; else process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS = prior; }
  });

  const candidateFixture = await installFixture({ mode: "certified" });
  const candidateMode = await deriveInstalled(candidateFixture);
  const candidateSecret = randomBytes(32).toString("hex");
  const candidateReceipt = await issueFor(candidateMode, "phase3-candidate", candidateSecret, "candidate");
  await check("9.8-03", "installed candidate", "installed identity + capability + dynamic renderer", async () => {
    const screen = renderCompanyScreen({ runtimeMode: candidateMode.runtime_mode, screenNonce: candidateReceipt.receipt.screen_nonce });
    assert.match(screen, /CANDIDATE SLOT · NOT ACTIVE/);
    assert.doesNotMatch(screen, /DEVELOPMENT SOURCE/);
  });
  await check("9.8-04", "candidate without installation identity", "strict installation schema", async () => {
    const fixture = await installFixture();
    await reseal(path.join(fixture.stateRoot, "installation-receipt.json"), "receipt_sha256", (value) => { delete value.installation_identity; });
    await identityRefusal(() => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }), "INSTALLED_IDENTITY_SCHEMA_INVALID");
  });
  await check("9.8-05", "production package without promotion receipt", "production identity resolver", async () => {
    const fixture = await installFixture({ mode: "certified", production: true });
    await fs.rm(path.join(fixture.stateRoot, "production-promotion-receipt.json"));
    await identityRefusal(() => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }), "INSTALLED_IDENTITY_ARTIFACT_MISSING");
  });
  await check("9.8-06", "production package with wrong active pointer", "pointer/package join", async () => {
    const fixture = await installFixture({ mode: "certified", production: true });
    await reseal(path.join(fixture.stateRoot, "active-install-pointer.json"), "pointer_sha256", (value) => { value.slot_id = "wrong-slot"; });
    await identityRefusal(() => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }), "STALE_OR_WRONG_ACTIVE_POINTER");
  });
  await check("9.8-07", "production package with stale promotion receipt", "promotion generation join", async () => {
    const fixture = await installFixture({ mode: "certified", production: true });
    const promotionSha = await reseal(path.join(fixture.stateRoot, "production-promotion-receipt.json"), "receipt_sha256", (value) => { value.activation_generation = 10; });
    await reseal(path.join(fixture.stateRoot, "active-install-pointer.json"), "pointer_sha256", (value) => { value.promotion_receipt_sha256 = promotionSha; });
    await identityRefusal(() => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }), "PRODUCTION_ACTIVE_IDENTITY_MISMATCH");
  });

  await check("9.8-08", "receipt from different package", "receipt current-identity comparison", async () => {
    await sessionRefusal(verifyScreenSession(verifyArgs(candidateReceipt, candidateMode, "phase3-candidate", candidateSecret, { expected: expectedFrom(candidateMode, { package_inventory_sha256: SHA("foreign-package") }) })), "WRONG_PACKAGE");
  });
  await check("9.8-09", "receipt from different installation", "receipt current-identity comparison", async () => {
    await sessionRefusal(verifyScreenSession(verifyArgs(candidateReceipt, candidateMode, "phase3-candidate", candidateSecret, { expected: expectedFrom(candidateMode, { installation_identity: "foreign-installation" }) })), "WRONG_INSTALLATION");
  });
  await check("9.8-10", "expired receipt", "bounded receipt expiry", async () => {
    const shortReceipt = await issueFor(candidateMode, "phase3-expired", randomBytes(32).toString("hex"), "expired", { ttlMs: 1_000 });
    await sessionRefusal(verifyScreenSession({ ...verifyArgs(shortReceipt, candidateMode, "phase3-expired", "unused"), sessionSecret: "x".repeat(32), now: new Date("2026-08-21T12:00:01.000Z") }), "EXPIRED");
  });
  await check("9.8-11", "already consumed receipt", "atomic one-use claim", async () => {
    await consumeScreenSession({ ...verifyArgs(candidateReceipt, candidateMode, "phase3-candidate", candidateSecret), consumerRunId: "phase3-run-one", consumedAt: "2026-08-21T12:00:02.000Z" });
    await sessionRefusal(consumeScreenSession({ ...verifyArgs(candidateReceipt, candidateMode, "phase3-candidate", candidateSecret), consumerRunId: "phase3-run-two", consumedAt: "2026-08-21T12:00:03.000Z" }), "ALREADY_CONSUMED");
  });
  await check("9.8-12", "static Company-screen copy with no receipt", "explicit receipt-path membership", async () => {
    const staticPath = path.join(candidateReceipt.sessionRoot, "static-company-screen.txt");
    await fs.writeFile(staticPath, renderCompanyScreen({ runtimeMode: candidateMode.runtime_mode, screenNonce: "ABC123" }));
    await sessionRefusal(verifyScreenSession({ ...verifyArgs(candidateReceipt, candidateMode, "phase3-candidate", candidateSecret), receiptPath: staticPath }), "RECEIPT_OUTSIDE_STORE");
  });
  await check("9.8-13", "two fresh sessions", "cryptographic receipt ID + nonce", async () => {
    const first = await issueFor(candidateMode, "phase3-fresh-a", randomBytes(32).toString("hex"), "fresh-a");
    const second = await issueFor(candidateMode, "phase3-fresh-b", randomBytes(32).toString("hex"), "fresh-b");
    assert.notEqual(first.receipt.screen_session_id, second.receipt.screen_session_id);
    assert.notEqual(first.receipt.screen_nonce, second.receipt.screen_nonce);
  });
  await check("9.8-14", "one session company reply supplied to another", "session ID + secret binding", async () => {
    await sessionRefusal(verifyScreenSession(verifyArgs(devReceipt, devMode, "phase3-candidate", candidateSecret)), "WRONG_SESSION_ID");
  });
  await check("9.8-15", "package changes after screen receipt", "continuation current-package recheck", async () => {
    await sessionRefusal(verifyScreenSession(verifyArgs(candidateReceipt, candidateMode, "phase3-candidate", candidateSecret, { expected: expectedFrom(candidateMode, { package_inventory_sha256: SHA("package-after-upgrade") }) })), "WRONG_PACKAGE");
  });
  await check("9.8-16", "active pointer changes after screen receipt", "fresh pointer readback comparison", async () => {
    await reseal(
      path.join(candidateFixture.stateRoot, "active-install-pointer.json"),
      "pointer_sha256",
      (value) => { value.generation += 1; },
    );
    const newMode = await deriveInstalled(candidateFixture);
    assert.notEqual(newMode.installed_placement.active_pointer_sha256, candidateMode.installed_placement.active_pointer_sha256);
    await sessionRefusal(verifyScreenSession(verifyArgs(candidateReceipt, newMode, "phase3-candidate", candidateSecret)), "WRONG_ACTIVE_POINTER");
  });
  await check("9.8-17", "candidate promoted after receipt", "same installed slot re-derived as production", async () => {
    await promoteFixture(candidateFixture);
    const productionMode = await deriveInstalled(candidateFixture, true);
    assert.equal(productionMode.runtime_mode, "PRODUCTION_ACTIVE");
    await sessionRefusal(verifyScreenSession(verifyArgs(candidateReceipt, productionMode, "phase3-candidate", candidateSecret)), "WRONG_RUNTIME_MODE");
  });

  assert.equal(results.length, 17);
  process.stdout.write(`${JSON.stringify({ schema_version: "phase3-runtime-session-integration-tests/1.0", status: "PASS", cases: results.length, mutations, results })}\n`);
} finally {
  await fs.rm(SCRATCH, { recursive: true, force: true });
}
