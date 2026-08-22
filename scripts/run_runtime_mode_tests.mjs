#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { identitySha256 } from "./lib/identity_vocabulary.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { completePackageInventoryIdentity } from "./lib/release_package_attestation.mjs";
import { captureRuntimeIntegrity } from "./lib/runtime_isolation.mjs";
import {
  InstalledRuntimeIdentityError,
  resolveInstalledRuntimeIdentity,
} from "./lib/installed_runtime_identity.mjs";
import { deriveRuntimeMode, RUNTIME_MODES } from "./lib/runtime_mode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-runtime-mode-"));
const SHA = (seed) => identitySha256({ seed });
const GIT = (character) => character.repeat(40);
const passed = [];
// Honest mutation accounting: every MUTATION-prefixed test tampers a copy of
// an installed-identity artefact (or withholds a required receipt) and is
// counted CAUGHT only when production refuses it while the mutant is active;
// a surviving mutant throws and no count line is printed.
let mutations_total = 0;
let mutations_caught = 0;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

async function rewriteRecord(target, field, mutate) {
  const value = JSON.parse(await fs.readFile(target, "utf8"));
  mutate(value);
  if (field) {
    const body = { ...value };
    delete body[field];
    value[field] = identitySha256(body);
  }
  return writeJson(target, value);
}

async function test(name, work) {
  const isMutation = /^MUTATION/.test(name);
  if (isMutation) mutations_total += 1;
  await work();
  passed.push(name);
  process.stdout.write(`PASS ${name}\n`);
  if (isMutation) mutations_caught += 1;
}

async function refuses(work, code) {
  await assert.rejects(work, (error) => {
    assert(error instanceof InstalledRuntimeIdentityError, String(error?.stack ?? error));
    assert.equal(error.code, code);
    return true;
  });
}

async function basePackage({ mode, checkout = false, channel = null } = {}) {
  const packageRoot = path.join(SCRATCH, `package-${mode}-${passed.length}-${Date.now()}-${Math.random()}`);
  await fs.mkdir(path.join(packageRoot, "assets"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "SKILL.md"), "fixture skill\n");
  await fs.writeFile(path.join(packageRoot, "scripts", "fixture-runtime.mjs"), "export default true;\n");
  for (const name of [
    "installation-receipt-v1.schema.json",
    "active-install-pointer-v1.schema.json",
    "production-promotion-receipt-v1.schema.json",
  ]) {
    await fs.copyFile(path.join(ROOT, "assets", name), path.join(packageRoot, "assets", name));
  }
  await writeJson(path.join(packageRoot, "assets", "deployment-profile.json"), {
    reference_allowlist: [],
    asset_allowlist: [],
    script_allowlist: ["fixture-runtime.mjs"],
    python_module_allowlist: [],
    resource_directory_allowlist: [],
    vendored_dependencies: [],
  });
  await writeJson(path.join(packageRoot, "assets", "runtime-manifest.json"), {
    skill_version: "fixture",
    status: checkout ? "v2_development" : "compiled_fixture",
    package_mode: checkout ? "development" : mode,
    // MP2 Phase A (A4): the release channel rides beside the version; a
    // source checkout is inherently a dev-channel build.
    release_channel: checkout ? "dev" : (channel ?? "stable"),
    deployment_status: "not_installed",
  });
  if (checkout) {
    await fs.mkdir(path.join(packageRoot, ".git"));
    return { packageRoot, stateRoot: null, local: null };
  }

  const closure = (await captureRuntimeIntegrity(packageRoot)).runtime_code_closure.sha256;
  const certified = mode === "certified" ? closure : null;
  await writeJson(path.join(packageRoot, "release-manifest.json"), {
    schemaVersion: 2,
    releaseName: "fixture",
    packageMode: mode,
    skillVersion: "fixture",
    identity: {
      schema_version: "product-identity/2.0",
      source: {
        identity_kind: "source_tree",
        repository: "fixture/repository",
        commit_sha: GIT("a"),
        tree_sha: GIT("b"),
      },
      package: {
        mode,
        runtime_code_closure: {
          identity_kind: "runtime_code_closure",
          sha256: closure,
          certified_sha256: certified,
        },
        complete_package_inventory: { identity_kind: "complete_package_inventory", sha256: null },
        archive: { identity_kind: "archive", sha256: null },
      },
      deployment: {
        status: "not_installed",
        installation_identity: null,
        installed_package: { identity_kind: "installed_package", sha256: null },
      },
    },
    files: [],
  });
  const inventory = await completePackageInventoryIdentity(packageRoot);
  const stateRoot = path.join(SCRATCH, `state-${mode}-${passed.length}-${Date.now()}-${Math.random()}`);
  await fs.mkdir(stateRoot, { recursive: true });
  const archiveBytes = Buffer.from(`archive:${inventory.sha256}\n`, "utf8");
  await fs.writeFile(path.join(stateRoot, "package-archive.tar"), archiveBytes);
  return {
    packageRoot,
    stateRoot,
    local: {
      mode,
      closure,
      certified,
      inventory: inventory.sha256,
      archive: sha256(archiveBytes),
    },
  };
}

async function installFixture({ mode = "development", production = false, channel = null } = {}) {
  const fixture = await basePackage({ mode, channel });
  const installedAt = new Date(Date.now() - 120_000).toISOString();
  const activatedAt = new Date(Date.now() - 60_000).toISOString();
  const installationBody = {
    schema_version: "excel-inflow-installation-receipt/1.0",
    installation_identity: "installation-fixture-1",
    installation_generation: 7,
    slot_id: "slot-under-test",
    installed_at: installedAt,
    package: {
      source_commit: GIT("a"),
      source_tree: GIT("b"),
      package_mode: mode,
      package_inventory_sha256: fixture.local.inventory,
      archive_sha256: fixture.local.archive,
      runtime_closure_sha256: fixture.local.closure,
      certified_runtime_closure_sha256: fixture.local.certified,
      installed_package_sha256: fixture.local.inventory,
    },
  };
  installationBody.receipt_sha256 = identitySha256(installationBody);
  const installationPath = path.join(fixture.stateRoot, "installation-receipt.json");
  const installationRawSha = await writeJson(installationPath, installationBody);

  const certification = {
    schema_version: "fixture-certification/1.0",
    status: "PASS",
    runtime_code_closure_sha256: fixture.local.closure,
  };
  const certificationBytes = Buffer.from(`${JSON.stringify(certification)}\n`, "utf8");
  const rollbackBytes = Buffer.from("retained previous known good package\n", "utf8");

  let promotionRawSha = null;
  let pointerBody;
  if (production) {
    await fs.writeFile(path.join(fixture.stateRoot, "certification-receipt.json"), certificationBytes);
    await fs.writeFile(path.join(fixture.stateRoot, "rollback-package.tar"), rollbackBytes);
    const promotionBody = {
      schema_version: "excel-inflow-production-promotion-receipt/1.0",
      promotion_id: "promotion-fixture-1",
      activation_generation: 11,
      installation_generation: 7,
      slot_id: "slot-under-test",
      installation_identity: "installation-fixture-1",
      installation_receipt_sha256: installationRawSha,
      package_inventory_sha256: fixture.local.inventory,
      archive_sha256: fixture.local.archive,
      runtime_closure_sha256: fixture.local.closure,
      certified_runtime_closure_sha256: fixture.local.certified,
      certification_receipt_sha256: sha256(certificationBytes),
      previous_slot_id: "slot-previous-good",
      rollback_package_sha256: sha256(rollbackBytes),
      promoted_at: activatedAt,
    };
    promotionBody.receipt_sha256 = identitySha256(promotionBody);
    promotionRawSha = await writeJson(
      path.join(fixture.stateRoot, "production-promotion-receipt.json"),
      promotionBody,
    );
    pointerBody = {
      schema_version: "excel-inflow-active-install-pointer/1.0",
      generation: 11,
      slot_id: "slot-under-test",
      installation_identity: "installation-fixture-1",
      installation_receipt_sha256: installationRawSha,
      package_inventory_sha256: fixture.local.inventory,
      archive_sha256: fixture.local.archive,
      runtime_closure_sha256: fixture.local.closure,
      promotion_receipt_sha256: promotionRawSha,
      previous_slot_id: "slot-previous-good",
      rollback_package_sha256: sha256(rollbackBytes),
      activated_at: activatedAt,
    };
  } else {
    pointerBody = {
      schema_version: "excel-inflow-active-install-pointer/1.0",
      generation: 9,
      slot_id: "different-active-slot",
      installation_identity: "different-installation",
      installation_receipt_sha256: SHA("different-installation-receipt"),
      package_inventory_sha256: SHA("different-inventory"),
      archive_sha256: SHA("different-archive"),
      runtime_closure_sha256: SHA("different-closure"),
      promotion_receipt_sha256: SHA("different-promotion"),
      previous_slot_id: "different-previous-slot",
      rollback_package_sha256: SHA("different-rollback"),
      activated_at: activatedAt,
    };
  }
  pointerBody.pointer_sha256 = identitySha256(pointerBody);
  await writeJson(path.join(fixture.stateRoot, "active-install-pointer.json"), pointerBody);

  fixture.paths = {
    installation: installationPath,
    pointer: path.join(fixture.stateRoot, "active-install-pointer.json"),
    promotion: path.join(fixture.stateRoot, "production-promotion-receipt.json"),
    archive: path.join(fixture.stateRoot, "package-archive.tar"),
    rollback: path.join(fixture.stateRoot, "rollback-package.tar"),
  };
  fixture.installation = installationBody;
  return fixture;
}

function capabilityFor(fixture, { production = false, candidateReady = !production } = {}) {
  const receipt = {
    schema_version: "excel-inflow-installed-capability-receipt/1.3",
    status: "HOST_READY",
    requested_lanes: ["evidence", "workbook"],
    candidate_slot_ready: candidateReady,
    source_identity: {
      deployment_status: production ? "production_promoted" : "installed_candidate",
      installation_identity: fixture.installation.installation_identity,
      active_runtime_code_closure_sha256: fixture.local.closure,
      complete_package_inventory_sha256: fixture.local.inventory,
      archive_sha256: fixture.local.archive,
    },
  };
  receipt.receipt_sha256 = capabilityDigest(receipt);
  return receipt;
}

await test("strict schemas accept the three clean installed-identity records", async () => {
  const fixture = await installFixture({ mode: "certified", production: true });
  for (const [schemaName, recordName] of [
    ["installation-receipt-v1.schema.json", "installation-receipt.json"],
    ["active-install-pointer-v1.schema.json", "active-install-pointer.json"],
    ["production-promotion-receipt-v1.schema.json", "production-promotion-receipt.json"],
  ]) {
    const schema = JSON.parse(await fs.readFile(path.join(ROOT, "assets", schemaName), "utf8"));
    const record = JSON.parse(await fs.readFile(path.join(fixture.stateRoot, recordName), "utf8"));
    assert.deepEqual(validateJsonSchema(record, schema), []);
    const extra = { ...record, undeclared: true };
    assert(validateJsonSchema(extra, schema).length > 0);
  }
});

await test("development source is derived without consulting deployment environment claims", async () => {
  const fixture = await basePackage({ mode: "development", checkout: true });
  const priorStatus = process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS;
  const priorInstall = process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY;
  process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS = "production_promoted";
  process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY = "spoofed-install";
  try {
    const result = await deriveRuntimeMode({ skillRoot: fixture.packageRoot });
    assert.equal(result.runtime_mode, RUNTIME_MODES.DEVELOPMENT_SOURCE);
    assert.equal(result.source_identity_overrides.deployment_status, "not_installed");
    assert.equal(result.source_identity_overrides.installation_identity, null);
  } finally {
    if (priorStatus === undefined) delete process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS;
    else process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS = priorStatus;
    if (priorInstall === undefined) delete process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY;
    else process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY = priorInstall;
  }
});

await test("verified inactive installed slot plus doctor receipt derives candidate mode", async () => {
  const fixture = await installFixture();
  const placement = await resolveInstalledRuntimeIdentity({
    skillRoot: fixture.packageRoot,
    installStateRoot: fixture.stateRoot,
  });
  assert.equal(placement.placement, "installed_candidate");
  assert.equal(placement.disk_space_policy_mode, "candidate");
  assert.equal(placement.source_identity_overrides.installation_identity, "installation-fixture-1");
  assert.equal(placement.evidence_hashes.active_pointer_sha256?.length, 64);
  const capability = capabilityFor(fixture);
  const result = await deriveRuntimeMode({
    skillRoot: fixture.packageRoot,
    installStateRoot: fixture.stateRoot,
    capabilityReceipt: capability,
    capabilityReceiptSha256: capability.receipt_sha256,
  });
  assert.equal(result.runtime_mode, RUNTIME_MODES.INSTALLED_CANDIDATE);
  assert.equal(result.disk_space_policy_mode, "candidate");
  assert.equal(result.installed_placement.capability_receipt_sha256, capability.receipt_sha256);
});

await test("certified package with exact pointer promotion and rollback derives production active", async () => {
  const fixture = await installFixture({ mode: "certified", production: true });
  const capability = capabilityFor(fixture, { production: true });
  const result = await deriveRuntimeMode({
    skillRoot: fixture.packageRoot,
    installStateRoot: fixture.stateRoot,
    capabilityReceipt: capability,
    capabilityReceiptSha256: capability.receipt_sha256,
  });
  assert.equal(result.runtime_mode, RUNTIME_MODES.PRODUCTION_ACTIVE);
  assert.equal(result.disk_space_policy_mode, "candidate");
  assert.equal(result.source_identity_overrides.deployment_status, "production_promoted");
  assert.equal(result.installed_placement.previous_slot_id, "slot-previous-good");
});

await test("MUTATION — compiled package without installation receipt refuses", async () => {
  const fixture = await basePackage({ mode: "development" });
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "INSTALLATION_RECEIPT_MISSING",
  );
});

await test("MUTATION — candidate without read-back active pointer refuses", async () => {
  const fixture = await installFixture();
  await fs.rm(fixture.paths.pointer);
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "ACTIVE_POINTER_MISSING",
  );
});

await test("MUTATION — install-state root inside immutable skill refuses", async () => {
  const fixture = await basePackage({ mode: "development", checkout: true });
  const inside = path.join(fixture.packageRoot, "install-state");
  await fs.mkdir(inside);
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: inside }),
    "INSTALL_STATE_ROOT_INSIDE_SKILL",
  );
});

await test("MUTATION — install-state symlink is rejected", async () => {
  const fixture = await installFixture();
  const link = path.join(SCRATCH, `state-link-${Date.now()}-${Math.random()}`);
  await fs.symlink(fixture.stateRoot, link);
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: link }),
    "INSTALL_STATE_ROOT_INVALID",
  );
});

await test("MUTATION — tampered installation record fails its self hash", async () => {
  const fixture = await installFixture();
  const value = JSON.parse(await fs.readFile(fixture.paths.installation, "utf8"));
  value.installation_generation += 1;
  await writeJson(fixture.paths.installation, value);
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "INSTALLED_IDENTITY_SELF_HASH_MISMATCH",
  );
});

await test("MUTATION — strict installation schema rejects missing installation identity", async () => {
  const fixture = await installFixture();
  await rewriteRecord(fixture.paths.installation, "receipt_sha256", (value) => {
    delete value.installation_identity;
  });
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "INSTALLED_IDENTITY_SCHEMA_INVALID",
  );
});

await test("MUTATION — tampered installed archive refuses exact package join", async () => {
  const fixture = await installFixture();
  await fs.appendFile(fixture.paths.archive, "tamper");
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "INSTALLATION_PACKAGE_MISMATCH",
  );
});

await test("MUTATION — installed mode requires a hash-bound post-doctor capability receipt", async () => {
  const fixture = await installFixture();
  await refuses(
    () => deriveRuntimeMode({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "HOST_CAPABILITY_REQUIRED",
  );
  const capability = capabilityFor(fixture);
  await refuses(
    () => deriveRuntimeMode({
      skillRoot: fixture.packageRoot,
      installStateRoot: fixture.stateRoot,
      capabilityReceipt: capability,
      capabilityReceiptSha256: SHA("wrong-capability"),
    }),
    "HOST_CAPABILITY_HASH_MISMATCH",
  );
});

await test("MUTATION — candidate requires candidate_slot_ready and exact capability joins", async () => {
  const fixture = await installFixture();
  const notReady = capabilityFor(fixture, { candidateReady: false });
  await refuses(
    () => deriveRuntimeMode({
      skillRoot: fixture.packageRoot,
      installStateRoot: fixture.stateRoot,
      capabilityReceipt: notReady,
      capabilityReceiptSha256: notReady.receipt_sha256,
    }),
    "HOST_CAPABILITY_IDENTITY_MISMATCH",
  );
  const wrongInstall = capabilityFor(fixture);
  wrongInstall.source_identity.installation_identity = "another-installation";
  wrongInstall.receipt_sha256 = capabilityDigest(wrongInstall);
  await refuses(
    () => deriveRuntimeMode({
      skillRoot: fixture.packageRoot,
      installStateRoot: fixture.stateRoot,
      capabilityReceipt: wrongInstall,
      capabilityReceiptSha256: wrongInstall.receipt_sha256,
    }),
    "HOST_CAPABILITY_IDENTITY_MISMATCH",
  );
});

await test("MUTATION — production active refuses missing promotion receipt", async () => {
  const fixture = await installFixture({ mode: "certified", production: true });
  await fs.rm(fixture.paths.promotion);
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "INSTALLED_IDENTITY_ARTIFACT_MISSING",
  );
});

await test("MUTATION — stale activation generation refuses production", async () => {
  const fixture = await installFixture({ mode: "certified", production: true });
  const newPromotionRawSha = await rewriteRecord(fixture.paths.promotion, "receipt_sha256", (value) => {
    value.activation_generation -= 1;
  });
  await rewriteRecord(fixture.paths.pointer, "pointer_sha256", (value) => {
    value.promotion_receipt_sha256 = newPromotionRawSha;
  });
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "PRODUCTION_ACTIVE_IDENTITY_MISMATCH",
  );
});

await test("MUTATION — wrong active pointer cannot demote a promoted package silently", async () => {
  const fixture = await installFixture({ mode: "certified", production: true });
  await rewriteRecord(fixture.paths.pointer, "pointer_sha256", (value) => {
    value.slot_id = "different-active-slot";
  });
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "STALE_OR_WRONG_ACTIVE_POINTER",
  );
});

await test("MUTATION — tampered rollback package refuses production active", async () => {
  const fixture = await installFixture({ mode: "certified", production: true });
  await fs.appendFile(fixture.paths.rollback, "tamper");
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "PRODUCTION_ACTIVE_IDENTITY_MISMATCH",
  );
});

await test("MUTATION — portable-certified package is never production active", async () => {
  const fixture = await installFixture({ mode: "portable_certified", production: true });
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "INSTALLED_IDENTITY_SCHEMA_INVALID",
  );
});

await test("MUTATION — caller cannot provide mode status or installation identity overrides", async () => {
  const fixture = await basePackage({ mode: "development", checkout: true });
  for (const extra of [
    { runtimeMode: "PRODUCTION_ACTIVE" },
    { deployment_status: "production_promoted" },
    { installation_identity: "spoof" },
  ]) {
    await refuses(
      () => deriveRuntimeMode({ skillRoot: fixture.packageRoot, ...extra }),
      "UNTRUSTED_RUNTIME_MODE_INPUT",
    );
  }
});

await test("MUTATION — dev-channel build with production receipts refuses at the installer ingress", async () => {
  // Every receipt join is honest; the refusal is purely the declared channel
  // (dev) not being installable_as_stable.
  const fixture = await installFixture({ mode: "certified", production: true, channel: "dev" });
  await refuses(
    () => resolveInstalledRuntimeIdentity({ skillRoot: fixture.packageRoot, installStateRoot: fixture.stateRoot }),
    "RELEASE_CHANNEL_REFUSAL_DEV_BUILD_AS_STABLE",
  );
});

await test("dev-channel build resolves installed_candidate in an inactive slot", async () => {
  const fixture = await installFixture({ channel: "dev" });
  const placement = await resolveInstalledRuntimeIdentity({
    skillRoot: fixture.packageRoot,
    installStateRoot: fixture.stateRoot,
  });
  assert.equal(placement.placement, "installed_candidate");
});

await fs.rm(SCRATCH, { recursive: true, force: true });
process.stdout.write(`\n${passed.length}/${passed.length} runtime-mode tests pass\n`);
process.stdout.write(
  `${JSON.stringify({ status: "PASS", tests: passed.length, mutations_total, mutations_caught })}\n`,
);
