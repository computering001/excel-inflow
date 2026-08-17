#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LEGACY_RUN_CARRIER_SCHEMA, RETIRED_RUN_CARRIER_SCHEMA, RUN_CARRIER_SCHEMA,
  runCarrierMigrationStageInput, verifyRunCarrier, writeRunCarrier,
  writeRunCarrierMigrationReceipt,
} from "./lib/run_carrier.mjs";
import { identitySha256 } from "./lib/identity_vocabulary.mjs";
import { resolveActiveSourceIdentity } from "./lib/source_identity.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-carrier-v4-"));
const runRoot = path.join(temporary, "run");
const evidencePath = path.join(temporary, "evidence.json");
const controllerVersion = "carrier-v4-test-controller";
const workspaceToken = "carrier-v4-test-token";
const issuerIdentity = { name: "Carrier Test plc" };
let checks = 0;

function canonicalise(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
}
const canonicalJson = (value) => JSON.stringify(canonicalise(value), null, 2);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function carrierHash(carrier) {
  const { carrier_hash: _ignored, ...body } = carrier;
  return sha256(canonicalJson(body));
}
function receiptHash(receipt) {
  const { receipt_hash: _ignored, ...body } = receipt;
  return sha256(canonicalJson(body));
}
function resumeProjection(productIdentity) {
  return {
    schema_version: "run-resume-product-identity/1.0",
    source_commit: productIdentity.source.commit_sha,
    source_tree: productIdentity.source.tree_sha,
    runtime_code_closure_sha256: productIdentity.package.runtime_code_closure.sha256,
    package_mode: productIdentity.package.mode,
    deployment_status: productIdentity.deployment.status,
    installation_identity: productIdentity.deployment.installation_identity,
  };
}
async function writeCarrier(target, carrier) {
  carrier.carrier_hash = carrierHash(carrier);
  await fs.writeFile(target, `${JSON.stringify(carrier, null, 2)}\n`);
}
async function rejects(action, pattern, label) {
  await assert.rejects(action, pattern, label);
  checks += 1;
}

try {
  await fs.writeFile(evidencePath, `${JSON.stringify({ run_id: "carrier-v4-test" })}\n`);
  const active = await resolveActiveSourceIdentity({ skillRoot: ROOT });
  assert.equal(active.schema_version, "source-identity/2.0");
  assert.equal(active.product_identity.schema_version, "product-identity/2.0");
  assert.ok(active.source_commit && active.source_tree && active.runtime_code_closure_sha256);
  checks += 3;

  const written = await writeRunCarrier({
    skillRoot: ROOT, runRoot, runId: "carrier-v4-test", controllerVersion,
    workspaceToken, issuerIdentity, evidencePath, status: "RESUMABLE",
  });
  assert.equal(written.carrier.schema_version, RUN_CARRIER_SCHEMA);
  assert.deepEqual(written.carrier.product_identity, active.product_identity);
  assert.equal(written.carrier.resume_identity_sha256, identitySha256(resumeProjection(active.product_identity)));
  const verifiedV4 = await verifyRunCarrier({
    skillRoot: ROOT, runRoot, carrierPath: written.path, controllerVersion, workspaceToken,
  });
  assert.equal(verifiedV4.stage_invalidation, null);
  assert.equal(verifiedV4.legacy_carrier_schema_migration, null);
  checks += 5;

  for (const [dimension, mutate] of [
    ["source_tree", (identity) => { identity.source.tree_sha = "e".repeat(40); }],
    ["runtime_code_closure_sha256", (identity) => {
      identity.package.runtime_code_closure.sha256 = "0".repeat(64);
    }],
    ["package_mode", (identity) => { identity.package.mode = identity.package.mode === "development" ? "certified" : "development"; }],
    ["deployment_status", (identity) => { identity.deployment.status = "installed_candidate"; }],
    ["installation_identity", (identity) => { identity.deployment.installation_identity = "different-installation"; }],
  ]) {
    const forged = structuredClone(written.carrier);
    mutate(forged.product_identity);
    forged.resume_identity_sha256 = identitySha256(resumeProjection(forged.product_identity));
    const target = path.join(runRoot, `forged-v4-${dimension}.json`);
    await writeCarrier(target, forged);
    await rejects(
      () => verifyRunCarrier({ skillRoot: ROOT, runRoot, carrierPath: target, controllerVersion, workspaceToken }),
      new RegExp(`${dimension}.*migration receipt is required`),
      `forged v4 ${dimension} was accepted`,
    );
  }

  // Baseline reproduction: v3 accepted this forged, internally hash-consistent
  // identity because it never compared the values with the active installation.
  const forgedV3 = structuredClone(written.carrier);
  forgedV3.schema_version = LEGACY_RUN_CARRIER_SCHEMA;
  forgedV3.source_identity = structuredClone(active);
  forgedV3.source_identity.source_commit = "f".repeat(40);
  forgedV3.source_identity.product_identity.source.commit_sha = "f".repeat(40);
  delete forgedV3.product_identity;
  delete forgedV3.resume_identity_sha256;
  const forgedV3Path = path.join(runRoot, "forged-v3-carrier.json");
  await writeCarrier(forgedV3Path, forgedV3);
  await rejects(
    () => verifyRunCarrier({ skillRoot: ROOT, runRoot, carrierPath: forgedV3Path, controllerVersion, workspaceToken }),
    /source_commit.*migration receipt is required/,
    "forged v3 carrier identity was accepted without active comparison",
  );
  await rejects(
    () => writeRunCarrierMigrationReceipt({
      skillRoot: ROOT, runRoot, carrierPath: forgedV3Path, controllerVersion,
      workspaceToken: "wrong-workspace-token",
    }),
    /token does not match migration controller/,
    "migration receipt was minted without workspace authority",
  );

  const migration = await writeRunCarrierMigrationReceipt({
    skillRoot: ROOT, runRoot, carrierPath: forgedV3Path, controllerVersion,
    workspaceToken,
    outPath: path.join(runRoot, "carrier", "source-migration.json"),
  });
  assert.equal(migration.receipt.stage_invalidation.earliest_stage, "inputs");
  assert.deepEqual(migration.receipt.stage_invalidation.reusable_stages, []);
  assert.deepEqual(migration.receipt.stage_invalidation.invalidated_stages, [
    "inputs", "evidence_review", "decisions", "build_checks", "delivery",
  ]);
  const migrated = await verifyRunCarrier({
    skillRoot: ROOT, runRoot, carrierPath: forgedV3Path, controllerVersion, workspaceToken,
    migrationReceiptPath: migration.path,
  });
  assert.equal(migrated.legacy_carrier_schema_migration, "v3_identity_reverified");
  assert.equal(migrated.migration.receipt.receipt_hash, migration.receipt.receipt_hash);
  checks += 5;

  for (const [name, mutate] of [
    ["carrier-hash", (receipt) => { receipt.prior_carrier_hash = "0".repeat(64); }],
    ["prior-identity", (receipt) => { receipt.prior_resume_identity_sha256 = "1".repeat(64); }],
    ["active-identity", (receipt) => { receipt.active_resume_identity_sha256 = "2".repeat(64); }],
    ["mismatch-set", (receipt) => { receipt.mismatch_dimensions = []; }],
    ["stage-invalidation", (receipt) => { receipt.stage_invalidation.earliest_stage = "delivery"; }],
    ["stage-nonce", (receipt) => { receipt.stage_input_sha256 = "3".repeat(64); }],
  ]) {
    const mutated = structuredClone(migration.receipt);
    mutate(mutated);
    mutated.receipt_hash = receiptHash(mutated);
    const target = path.join(runRoot, "carrier", `mutated-${name}.json`);
    await fs.writeFile(target, `${JSON.stringify(mutated, null, 2)}\n`);
    await rejects(
      () => verifyRunCarrier({
        skillRoot: ROOT, runRoot, carrierPath: forgedV3Path, controllerVersion,
        workspaceToken, migrationReceiptPath: target,
      }),
      /recomputed identity invalidation/,
      `migration ${name} mutation was accepted`,
    );
  }
  const brokenHashReceipt = structuredClone(migration.receipt);
  brokenHashReceipt.mismatch_dimensions = [];
  const brokenHashPath = path.join(runRoot, "carrier", "broken-receipt-hash.json");
  await fs.writeFile(brokenHashPath, `${JSON.stringify(brokenHashReceipt, null, 2)}\n`);
  await rejects(
    () => verifyRunCarrier({
      skillRoot: ROOT, runRoot, carrierPath: forgedV3Path, controllerVersion,
      workspaceToken, migrationReceiptPath: brokenHashPath,
    }),
    /receipt hash does not match/,
    "migration receipt body mutation passed its own hash",
  );
  const outsideReceiptPath = path.join(temporary, "outside-migration.json");
  await fs.writeFile(outsideReceiptPath, `${JSON.stringify(migration.receipt, null, 2)}\n`);
  await rejects(
    () => verifyRunCarrier({
      skillRoot: ROOT, runRoot, carrierPath: forgedV3Path, controllerVersion,
      workspaceToken, migrationReceiptPath: outsideReceiptPath,
    }),
    /must be beneath the canonical run root/,
    "external migration receipt escaped run custody",
  );

  const opaqueV3 = structuredClone(forgedV3);
  delete opaqueV3.source_identity.product_identity;
  const opaqueV3Path = path.join(runRoot, "opaque-v3-carrier.json");
  await writeCarrier(opaqueV3Path, opaqueV3);
  await rejects(
    () => verifyRunCarrier({ skillRoot: ROOT, runRoot, carrierPath: opaqueV3Path, controllerVersion, workspaceToken }),
    /no typed product identity/,
    "opaque v3 source identity was treated as authority",
  );

  const retiredV2 = structuredClone(forgedV3);
  retiredV2.schema_version = RETIRED_RUN_CARRIER_SCHEMA;
  const retiredV2Path = path.join(runRoot, "retired-v2-carrier.json");
  await writeCarrier(retiredV2Path, retiredV2);
  await rejects(
    () => verifyRunCarrier({ skillRoot: ROOT, runRoot, carrierPath: retiredV2Path, controllerVersion, workspaceToken }),
    /v2 run carriers are retired/,
    "v2 carrier crossed the typed identity boundary",
  );

  const matchingV3 = structuredClone(written.carrier);
  matchingV3.schema_version = LEGACY_RUN_CARRIER_SCHEMA;
  matchingV3.source_identity = structuredClone(active);
  delete matchingV3.product_identity;
  delete matchingV3.resume_identity_sha256;
  const matchingV3Path = path.join(runRoot, "matching-v3-carrier.json");
  await writeCarrier(matchingV3Path, matchingV3);
  const verifiedV3 = await verifyRunCarrier({
    skillRoot: ROOT, runRoot, carrierPath: matchingV3Path, controllerVersion, workspaceToken,
  });
  assert.equal(verifiedV3.legacy_carrier_schema_migration, "v3_identity_reverified");
  checks += 1;

  const deploymentV3 = structuredClone(matchingV3);
  deploymentV3.source_identity.product_identity.deployment.status = "installed_candidate";
  deploymentV3.source_identity.product_identity.deployment.installation_identity = "prior-installation";
  const deploymentV3Path = path.join(runRoot, "deployment-v3-carrier.json");
  await writeCarrier(deploymentV3Path, deploymentV3);
  const deploymentMigration = await writeRunCarrierMigrationReceipt({
    skillRoot: ROOT, runRoot, carrierPath: deploymentV3Path, controllerVersion,
    workspaceToken,
    outPath: path.join(runRoot, "carrier", "deployment-migration.json"),
  });
  assert.equal(deploymentMigration.receipt.stage_invalidation.earliest_stage, "build_checks");
  assert.deepEqual(deploymentMigration.receipt.stage_invalidation.reusable_stages, [
    "inputs", "evidence_review", "decisions",
  ]);
  assert.deepEqual(deploymentMigration.receipt.stage_invalidation.invalidated_stages, ["build_checks", "delivery"]);
  const deploymentMigrated = await verifyRunCarrier({
    skillRoot: ROOT, runRoot, carrierPath: deploymentV3Path, controllerVersion,
    workspaceToken, migrationReceiptPath: deploymentMigration.path,
  });
  assert.deepEqual(runCarrierMigrationStageInput(deploymentMigrated, "inputs"), {});
  assert.deepEqual(runCarrierMigrationStageInput(deploymentMigrated, "build_checks"), {
    carrier_identity_migration: deploymentMigration.receipt.stage_input_sha256,
  });
  assert.deepEqual(runCarrierMigrationStageInput(deploymentMigrated, "delivery"), {
    carrier_identity_migration: deploymentMigration.receipt.stage_input_sha256,
  });
  checks += 6;

  await rejects(
    () => verifyRunCarrier({
      skillRoot: ROOT, runRoot, carrierPath: written.path, controllerVersion,
      workspaceToken, migrationReceiptPath: migration.path,
    }),
    /migration receipt is stale/,
    "stale migration receipt was accepted for matching v4 identity",
  );

  console.log(JSON.stringify({ status: "PASS", checks }));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
