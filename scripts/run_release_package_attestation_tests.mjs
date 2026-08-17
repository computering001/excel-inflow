#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  identitySha256,
  productIdentity,
  runtimeCodeClosureIdentity,
} from "./lib/identity_vocabulary.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { resolveSourceIdentity } from "./lib/source_identity.mjs";
import {
  assertExternalArtifactPath,
  buildReleasePackageAttestation,
  completePackageInventoryIdentity,
  createDeterministicPackageArchive,
  verifyReleasePackageAttestation,
  writeExternalReleasePackageAttestation,
} from "./lib/release_package_attestation.mjs";

const FIXED_TIME = "2026-08-17T00:00:00.000Z";
const EVIDENCE_RECEIPT = Object.freeze({
  status: "PASS",
  manifestSha256: "b".repeat(64),
});
const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-package-attestation-test-"));
const schema = JSON.parse(
  await fs.readFile(
    new URL("../assets/release-package-attestation-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const productSchema = JSON.parse(
  await fs.readFile(new URL("../assets/product-identity-v2.schema.json", import.meta.url), "utf8"),
);
const compilerSource = await fs.readFile(
  new URL("./compile_skill_release.mjs", import.meta.url),
  "utf8",
);

let checks = 0;
function check(value, message) {
  assert(value, message);
  checks += 1;
}

check(
  !/fs\.writeFile\(\s*runtimeManifestPath/.test(compilerSource),
  "certification still mutates source runtime-manifest after hashing",
);
check(
  compilerSource.indexOf('path.join(outputDir, "release-manifest.json")') <
    compilerSource.indexOf("const sealedInventory = await completePackageInventoryIdentity"),
  "compiler inventories package before its final manifest exists",
);

async function fixture(name, content = "export const value = 1;\n") {
  const packageRoot = path.join(root, name);
  await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "scripts", "runtime.mjs"), content);
  const runtime = runtimeCodeClosureIdentity({
    "scripts/runtime.mjs": "a".repeat(64),
  });
  const releaseManifest = {
    releaseName: "Excel Inflow test",
    skillVersion: "3.7.0",
    packageMode: "certified",
    deploymentStatus: "not_installed",
    identity: productIdentity({
      repository: "owner/repository",
      sourceCommit: "1".repeat(40),
      sourceTree: "2".repeat(40),
      packageMode: "certified",
      deploymentStatus: "not_installed",
      runtimeCodeClosureSha256: runtime.sha256,
      certifiedRuntimeCodeClosureSha256: runtime.sha256,
    }),
    certification: {
      evidenceReceipt: null,
      externalAttestationSchema: "release-package-attestation/1.0",
    },
  };
  await fs.writeFile(
    path.join(packageRoot, "release-manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );
  return packageRoot;
}

try {
  const packageA = await fixture("package-a");
  const archiveAPath = path.join(root, "package-a.tar");
  const archiveA = await createDeterministicPackageArchive({
    packageRoot: packageA,
    archivePath: archiveAPath,
  });
  const attestationA = await buildReleasePackageAttestation({
    packageRoot: packageA,
    archive: archiveA,
    certificationEvidenceReceipt: EVIDENCE_RECEIPT,
    issuedAt: FIXED_TIME,
  });
  check(validateJsonSchema(attestationA, schema).length === 0, "attestation schema failed");
  check(
    validateJsonSchema(attestationA.package.product_identity, productSchema).length === 0,
    "sealed product identity schema failed",
  );
  const verificationA = await verifyReleasePackageAttestation({
    packageRoot: packageA,
    attestation: attestationA,
    archivePath: archiveAPath,
  });
  check(verificationA.status === "PASS", "clean sealed package did not verify");
  check(
    attestationA.package.complete_package_inventory.files["release-manifest.json"],
    "complete inventory omitted release manifest",
  );
  check(
    !attestationA.package.complete_package_inventory.files["release-package-attestation.json"],
    "external attestation leaked into package identity",
  );
  check(archiveA.format === "ustar", "archive format is not deterministic ustar");

  const attestationPath = path.join(root, "package-a.attestation.json");
  await writeExternalReleasePackageAttestation({
    packageRoot: packageA,
    attestationPath,
    attestation: attestationA,
  });
  check((await fs.stat(attestationPath)).isFile(), "external attestation was not written");
  check(
    (await completePackageInventoryIdentity(packageA)).sha256 ===
      attestationA.package.complete_package_inventory.sha256,
    "external attestation write mutated sealed package bytes",
  );
  const resolvedIdentity = await resolveSourceIdentity({ skillRoot: packageA });
  check(
    resolvedIdentity.product_identity.package.complete_package_inventory.sha256 ===
      attestationA.package.complete_package_inventory.sha256,
    "source identity did not consume verified external complete-package identity",
  );
  check(
    resolvedIdentity.release_package_attestation_sha256 ===
      attestationA.attestation_sha256,
    "source identity did not bind external attestation identity",
  );
  assert.throws(
    () => assertExternalArtifactPath(packageA, path.join(packageA, "attestation.json"), "Attestation"),
    /outside the immutable package/,
  );
  checks += 1;

  const packageA2 = await fixture("package-a-copy");
  const archiveA2 = await createDeterministicPackageArchive({
    packageRoot: packageA2,
    archivePath: path.join(root, "package-a-copy.tar"),
  });
  const inventoryA = await completePackageInventoryIdentity(packageA);
  const inventoryA2 = await completePackageInventoryIdentity(packageA2);
  check(inventoryA.sha256 === inventoryA2.sha256, "identical package inventories differ");
  check(archiveA.sha256 === archiveA2.sha256, "identical deterministic archives differ");

  await fs.writeFile(path.join(packageA, "scripts", "runtime.mjs"), "export const value = 2;\n");
  const mutated = await verifyReleasePackageAttestation({
    packageRoot: packageA,
    attestation: attestationA,
    archivePath: archiveAPath,
  });
  check(mutated.status === "FAIL", "post-seal package mutation was accepted");
  check(
    mutated.findings.includes("complete package inventory does not match attestation"),
    "post-seal mutation did not fail the complete inventory",
  );

  const packageB = await fixture("package-b", "export const value = 99;\n");
  const archiveB = await createDeterministicPackageArchive({
    packageRoot: packageB,
    archivePath: path.join(root, "package-b.tar"),
  });
  const attestationB = await buildReleasePackageAttestation({
    packageRoot: packageB,
    archive: archiveB,
    certificationEvidenceReceipt: EVIDENCE_RECEIPT,
    issuedAt: FIXED_TIME,
  });
  const swapped = await verifyReleasePackageAttestation({
    packageRoot: packageA2,
    attestation: attestationB,
  });
  check(swapped.status === "FAIL", "attestation/package swap was accepted");
  check(
    swapped.findings.includes("complete package inventory does not match attestation"),
    "attestation/package swap did not fail complete inventory",
  );

  const selfMutated = structuredClone(attestationA);
  selfMutated.package.complete_package_inventory.sha256 = "f".repeat(64);
  const selfMutationResult = await verifyReleasePackageAttestation({
    packageRoot: packageA2,
    attestation: selfMutated,
  });
  check(
    selfMutationResult.findings.includes("attestation self-hash does not match"),
    "attestation mutation was accepted",
  );

  const rehashedIdentityMutation = structuredClone(attestationA);
  rehashedIdentityMutation.package.product_identity.source.commit_sha = "9".repeat(40);
  const { attestation_sha256: _oldHash, ...rehashedBody } = rehashedIdentityMutation;
  rehashedIdentityMutation.attestation_sha256 = identitySha256(rehashedBody);
  const rehashedIdentityResult = await verifyReleasePackageAttestation({
    packageRoot: packageA2,
    attestation: rehashedIdentityMutation,
  });
  check(rehashedIdentityResult.status === "FAIL", "Rehashed source-identity mutation was accepted");
  check(
    rehashedIdentityResult.findings.includes(
      "sealed product identity does not match release manifest and package identities",
    ),
    "Rehashed source-identity mutation did not fail manifest binding",
  );

  const damagedArchivePath = path.join(root, "damaged.tar");
  const archiveBytes = await fs.readFile(path.join(root, "package-a-copy.tar"));
  archiveBytes[0] ^= 0xff;
  await fs.writeFile(damagedArchivePath, archiveBytes);
  const archiveMismatch = await verifyReleasePackageAttestation({
    packageRoot: packageA2,
    attestation: await buildReleasePackageAttestation({
      packageRoot: packageA2,
      archive: archiveA2,
      certificationEvidenceReceipt: EVIDENCE_RECEIPT,
      issuedAt: FIXED_TIME,
    }),
    archivePath: damagedArchivePath,
  });
  check(archiveMismatch.status === "FAIL", "archive mutation was accepted");
  check(
    archiveMismatch.findings.includes("archive identity does not match attestation"),
    "archive mutation did not fail archive identity",
  );

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
