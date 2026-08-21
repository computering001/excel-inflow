import { createHash } from "node:crypto";

import {
  InstalledRuntimeIdentityError,
  resolveInstalledRuntimeIdentity,
} from "./installed_runtime_identity.mjs";

export const RUNTIME_MODES = Object.freeze({
  DEVELOPMENT_SOURCE: "DEVELOPMENT_SOURCE",
  INSTALLED_CANDIDATE: "INSTALLED_CANDIDATE",
  PRODUCTION_ACTIVE: "PRODUCTION_ACTIVE",
});

const PLACEMENT_TO_MODE = Object.freeze({
  development_source: RUNTIME_MODES.DEVELOPMENT_SOURCE,
  installed_candidate: RUNTIME_MODES.INSTALLED_CANDIDATE,
  production_active: RUNTIME_MODES.PRODUCTION_ACTIVE,
});

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, frozen(child)]),
    ));
  }
  return value;
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
  return createHash("sha256")
    .update(`${JSON.stringify(canonicalise(body))}\n`, "utf8")
    .digest("hex");
}

function assertCapability(verified, receipt, claimedSha256) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new InstalledRuntimeIdentityError(
      "HOST_CAPABILITY_REQUIRED",
      "an installed runtime mode requires the post-doctor host capability receipt",
    );
  }
  const calculated = capabilityDigest(receipt);
  if (receipt.receipt_sha256 !== calculated || claimedSha256 !== calculated) {
    throw new InstalledRuntimeIdentityError(
      "HOST_CAPABILITY_HASH_MISMATCH",
      "capability receipt object, self-hash and supplied hash are not identical",
    );
  }
  if (
    receipt.status !== "HOST_READY" ||
    !["evidence", "workbook"].every((lane) => receipt.requested_lanes?.includes(lane))
  ) {
    throw new InstalledRuntimeIdentityError(
      "HOST_CAPABILITY_NOT_READY",
      "both evidence and workbook lanes must be HOST_READY",
    );
  }
  const source = receipt.source_identity ?? {};
  const installation = verified.installation;
  const expected = verified.source_identity_overrides;
  const findings = [
    ["installation identity", source.installation_identity, installation.installation_identity],
    ["deployment status", source.deployment_status, expected.deployment_status],
    ["runtime closure", source.active_runtime_code_closure_sha256, expected.runtime_code_closure_sha256],
    ["package inventory", source.complete_package_inventory_sha256, expected.complete_package_inventory_sha256],
    ["archive", source.archive_sha256, expected.archive_sha256],
  ].filter(([, actual, wanted]) => actual !== wanted)
    .map(([label]) => `${label} mismatch`);
  if (verified.placement === "installed_candidate" && receipt.candidate_slot_ready !== true) {
    findings.push("candidate_slot_ready is not true");
  }
  if (findings.length > 0) {
    throw new InstalledRuntimeIdentityError("HOST_CAPABILITY_IDENTITY_MISMATCH", findings);
  }
  return calculated;
}

/**
 * Compile the only three public runtime modes from verified package placement.
 * Placement inputs are filesystem locators only. The optional capability
 * receipt is accepted only after doctor execution and is hash/self-hash bound.
 * There is no mode, deployment-status, installation-identity or pointer
 * override parameter.
 */
export async function deriveRuntimeMode({
  skillRoot,
  installStateRoot = null,
  capabilityReceipt = null,
  capabilityReceiptSha256 = null,
} = {}) {
  if (arguments[0] && Object.keys(arguments[0]).some(
    (key) => ![
      "skillRoot", "installStateRoot", "capabilityReceipt", "capabilityReceiptSha256",
    ].includes(key),
  )) {
    throw new InstalledRuntimeIdentityError(
      "UNTRUSTED_RUNTIME_MODE_INPUT",
      "only skillRoot/installStateRoot locators and the post-doctor capability receipt/hash are accepted",
    );
  }
  const verified = await resolveInstalledRuntimeIdentity({ skillRoot, installStateRoot });
  const runtimeMode = PLACEMENT_TO_MODE[verified.placement];
  if (!runtimeMode) {
    throw new InstalledRuntimeIdentityError(
      "UNRECOGNISED_VERIFIED_PLACEMENT",
      `verified placement ${JSON.stringify(verified.placement)} has no runtime mode`,
    );
  }

  const capabilitySha256 = runtimeMode === RUNTIME_MODES.DEVELOPMENT_SOURCE
    ? null
    : assertCapability(verified, capabilityReceipt, capabilityReceiptSha256);

  const installed = verified.installation;
  const local = verified.local_package;

  return frozen({
    schema_version: "excel-inflow-derived-runtime-mode/1.0",
    runtime_mode: runtimeMode,
    disk_space_policy_mode: runtimeMode === RUNTIME_MODES.DEVELOPMENT_SOURCE
      ? "development"
      : "candidate",
    source_identity_overrides: verified.source_identity_overrides,
    installed_placement: {
      slot_id: installed?.slot_id ?? null,
      installation_generation: installed?.installation_generation ?? null,
      installation_identity: installed?.installation_identity ?? null,
      installation_receipt_sha256:
        verified.evidence_hashes.installation_receipt_sha256,
      active_pointer_sha256: verified.evidence_hashes.active_pointer_sha256,
      promotion_receipt_sha256:
        verified.evidence_hashes.production_promotion_receipt_sha256,
      capability_receipt_sha256: capabilitySha256,
      active_pointer_generation: verified.active_pointer?.generation ?? null,
      previous_slot_id: verified.active_pointer?.previous_slot_id ?? null,
      rollback_package_sha256: verified.active_pointer?.rollback_package_sha256 ?? null,
    },
  });
}

export default { RUNTIME_MODES, deriveRuntimeMode };
