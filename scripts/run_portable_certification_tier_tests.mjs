#!/usr/bin/env node
/**
 * P8.0 — the portable certification tier.
 *
 * Invariant under test: the release vocabulary admits a PORTABLE CERTIFIED tier
 * whose evidence set is exactly the evidence a portable host can produce, with
 * the native-Excel and visual-review classes recorded as PERMANENT DECLARED
 * EXCLUSIONS — not waivers, not pending items, not silence. A portable-certified
 * package must be honestly distinguishable from a natively-certified one, and
 * nothing may present a portable certification as a native one.
 *
 * The suite proves four things in order:
 *   A. The tier exists in the vocabulary and is a THIRD, separately named mode.
 *   B. Adding it did NOT make the native tier easier to claim (four refusals,
 *      including two from committed validators this package never touched).
 *   C. A portable dossier of the five producible classes, with both exclusions
 *      declared permanent, PASSES — and every check the portable classes
 *      already faced still applies at full strength.
 *   D. The four required mutations are refused.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ECONOMIC_SOLVE_POLICY } from "./lib/economic_solve_policy.mjs";
import {
  CERTIFICATION_TIER_CONTRACT,
  CERTIFIED_PACKAGE_MODES,
  EXCLUDED_NATIVE_HOST,
  NATIVE_CERTIFIED_PACKAGE_MODE,
  PACKAGE_MODES,
  PERMANENT_DECLARED_EXCLUSION,
  PHYSICAL_LANE_TERMINAL_DECLARATION,
  PORTABLE_CERTIFIED_PACKAGE_MODE,
  assertCertifiedPackageMode,
  assertNativeCertifiedPackageMode,
  assertPackageMode,
  certificationTierContractFor,
  productIdentity,
} from "./lib/identity_vocabulary.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  NATIVE_REQUIRED_EVIDENCE,
  PERMANENTLY_EXCLUDED_EVIDENCE,
  PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  PORTABLE_REQUIRED_EVIDENCE,
  validateReleaseCertificationEvidence,
} from "./lib/release_certification.mjs";
import { assertCertifiedProductionIdentity } from "./lib/source_identity.mjs";

process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE = "1";

const CLOSURE = "a".repeat(64);
const SHEETS = ["Operating Model", "Brokers", "Forward Curves"];
const TOLERANCE_POLICY = {
  currency_abs: 1e-6,
  ratio_abs: 1e-9,
  percentage_abs: 1e-10,
  control_abs: 0,
  default_abs: 1e-9,
  relative: 1e-12,
};

let checks = 0;
function check(assertion, message) {
  assert(assertion, message);
  checks += 1;
}
function refuses(fn, pattern, message) {
  assert.throws(fn, pattern, message);
  checks += 1;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const POLICY_SHA256 = sha(JSON.stringify(canonical(ECONOMIC_SOLVE_POLICY)));

/* ================================================================== *
 * A. The tier exists, as a third separately named mode
 * ================================================================== */

check(PACKAGE_MODES.length === 3, "PACKAGE_MODES still offers no third tier");
check(
  assertPackageMode(PORTABLE_CERTIFIED_PACKAGE_MODE) === "portable_certified",
  "portable_certified is not an admitted package mode",
);
check(
  PORTABLE_CERTIFIED_PACKAGE_MODE !== NATIVE_CERTIFIED_PACKAGE_MODE,
  "the portable tier is a flag on the native mode rather than a distinct value",
);
check(
  JSON.stringify(CERTIFIED_PACKAGE_MODES) === JSON.stringify(["certified", "portable_certified"]),
  "the certified-mode family does not name exactly the two certified tiers",
);
// Every pre-existing `=== "certified"` comparison in the repository must keep
// meaning "natively certified"; that is only true while the two tiers are
// different string values, which the check above pins.
check(
  certificationTierContractFor(PORTABLE_CERTIFIED_PACKAGE_MODE).claims_native_host_evidence === false,
  "the portable tier claims native-host evidence",
);
check(
  certificationTierContractFor(NATIVE_CERTIFIED_PACKAGE_MODE).claims_native_host_evidence === true,
  "the native tier no longer claims native-host evidence",
);
check(
  CERTIFICATION_TIER_CONTRACT[NATIVE_CERTIFIED_PACKAGE_MODE].supersedes
    .includes(PORTABLE_CERTIFIED_PACKAGE_MODE),
  "the tier contract does not record that native certification supersedes portable",
);
check(
  CERTIFICATION_TIER_CONTRACT[PORTABLE_CERTIFIED_PACKAGE_MODE].supersedes.length === 0,
  "the portable tier claims to supersede something",
);

// The evidence split: exhaustive, non-overlapping, and unchanged for native.
check(
  JSON.stringify(PORTABLE_REQUIRED_EVIDENCE) === JSON.stringify([
    "exact_maximal", "exact_net_cash", "frozen_cohort", "finance_proof_mutations", "source_parity",
  ]),
  "the portable-required evidence set is not the five producible classes",
);
check(
  JSON.stringify(Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE).sort()) ===
    JSON.stringify(["native_excel", "visual_review"]),
  "the permanent-exclusion register does not name exactly the two native-host classes",
);
check(
  JSON.stringify([...NATIVE_REQUIRED_EVIDENCE]) === JSON.stringify([
    "exact_maximal", "exact_net_cash", "native_excel", "visual_review",
    "frozen_cohort", "finance_proof_mutations", "source_parity",
  ]),
  "the NATIVE required-evidence set changed membership or order",
);
check(
  PORTABLE_REQUIRED_EVIDENCE.every((name) => !(name in PERMANENTLY_EXCLUDED_EVIDENCE)),
  "a class is both portable-required and permanently excluded",
);

// Each exclusion is machine-readable, reason-carrying and unmistakably permanent.
for (const [name, record] of Object.entries(PERMANENTLY_EXCLUDED_EVIDENCE)) {
  check(record.satisfiability === EXCLUDED_NATIVE_HOST, `${name} does not carry the EXCLUDED_NATIVE_HOST token`);
  check(record.exclusion_disposition === PERMANENT_DECLARED_EXCLUSION, `${name} is not declared a permanent exclusion`);
  check(record.excluded_from_portable_gate === true, `${name} is not excluded from the portable gate`);
  check(record.is_pending === false, `${name} is still presented as pending`);
  check(record.is_waiver === false, `${name} is presented as a waiver`);
  check(record.revisit_condition === null, `${name} carries a revisit condition, so it reads as deferred`);
  check(
    typeof record.exclusion_reason === "string" && record.exclusion_reason.length >= 40,
    `${name} does not state which host capability is missing`,
  );
  check(
    typeof record.portable_substitute === "string" && record.portable_substitute.length >= 40,
    `${name} does not record what the portable tier proves instead`,
  );
}

// The physical lane's terminal state is DECLARED permanent, once, in the
// vocabulary — while the pinned token strings and exit code stay untouched.
check(PHYSICAL_LANE_TERMINAL_DECLARATION.status_token === "PASS_PENDING_MANUAL", "the pinned status token was renamed");
check(
  PHYSICAL_LANE_TERMINAL_DECLARATION.release_gate_token === "PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW",
  "the pinned release-gate token was renamed",
);
check(PHYSICAL_LANE_TERMINAL_DECLARATION.process_exit_code === 0, "the exit-0 contract of the physical lane was changed");
check(
  PHYSICAL_LANE_TERMINAL_DECLARATION.disposition === PERMANENT_DECLARED_EXCLUSION &&
    PHYSICAL_LANE_TERMINAL_DECLARATION.is_pending === false &&
    PHYSICAL_LANE_TERMINAL_DECLARATION.revisit_condition === null &&
    PHYSICAL_LANE_TERMINAL_DECLARATION.token_wording_is_historical_misnomer === true,
  "the physical lane is still declared as pending rather than as its permanent terminal state",
);
check(
  JSON.stringify([...PHYSICAL_LANE_TERMINAL_DECLARATION.excluded_evidence_classes].sort()) ===
    JSON.stringify(Object.keys(PERMANENTLY_EXCLUDED_EVIDENCE).sort()),
  "the terminal declaration and the exclusion register disagree about which classes are excluded",
);
check(
  PHYSICAL_LANE_TERMINAL_DECLARATION.reachable_certification_tier === PORTABLE_CERTIFIED_PACKAGE_MODE,
  "the terminal declaration does not name the reachable tier",
);

/* ================================================================== *
 * B. The native tier did not get easier to claim
 * ================================================================== */

refuses(
  () => assertNativeCertifiedPackageMode(PORTABLE_CERTIFIED_PACKAGE_MODE),
  /can never satisfy a native certification check/,
  "a portable-certified mode satisfies the native-certification assertion",
);
refuses(
  () => assertNativeCertifiedPackageMode("development"),
  /must be certified/,
  "a development mode satisfies the native-certification assertion",
);
refuses(
  () => assertCertifiedPackageMode("development"),
  /certified, portable_certified/,
  "a development package counts as certified",
);
// assertCertifiedProductionIdentity is P8.2a's, committed and untouched here. A
// portable-certified identity must not walk through it.
refuses(
  () => assertCertifiedProductionIdentity({
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    runtime_code_closure_sha256: CLOSURE,
    certified_runtime_code_closure_sha256: CLOSURE,
    certification_evidence_receipt: { status: "PASS" },
    release_package_attestation_sha256: "b".repeat(64),
    installation_identity: "install:v77",
    package_mode: PORTABLE_CERTIFIED_PACKAGE_MODE,
    deployment_status: "production_promoted",
  }),
  /package_mode=certified/,
  "a portable-certified identity satisfies the certified-production identity assertion",
);
refuses(
  () => assertPackageMode("production"),
  /development, certified/,
  "the package-mode diagnostic no longer reads development, certified",
);

// The typed product-identity vocabulary stays coherent for the new mode. The
// mode ENUM in assets/product-identity-v2.schema.json is a forbidden file in
// this package, so this asserts the residual precisely: a portable identity may
// diverge from the asset on package.mode and on NOTHING else.
const portableIdentity = productIdentity({
  repository: "owner/repository",
  sourceCommit: "1".repeat(40),
  sourceTree: "2".repeat(40),
  packageMode: PORTABLE_CERTIFIED_PACKAGE_MODE,
  deploymentStatus: "not_installed",
  runtimeCodeClosureSha256: CLOSURE,
  certifiedRuntimeCodeClosureSha256: CLOSURE,
  completePackageInventorySha256: "d".repeat(64),
  archiveSha256: "e".repeat(64),
});
const identitySchema = JSON.parse(
  await fs.readFile(new URL("../assets/product-identity-v2.schema.json", import.meta.url), "utf8"),
);
const identityFindings = validateJsonSchema(portableIdentity, identitySchema);
check(
  portableIdentity.package.mode === PORTABLE_CERTIFIED_PACKAGE_MODE,
  "the typed product identity dropped the portable mode",
);
check(
  identityFindings.every((message) => /package\.mode|\$\.package\.mode/.test(message)),
  `a portable product identity diverges from product-identity/2.0 beyond package.mode: ${JSON.stringify(identityFindings)}`,
);
check(
  portableIdentity.schema_version === "product-identity/2.0" &&
    portableIdentity.package.runtime_code_closure.identity_kind === "runtime_code_closure" &&
    portableIdentity.deployment.installed_package.identity_kind === "installed_package",
  "the typed identity kinds were disturbed by the new mode",
);

/* ================================================================== *
 * C+D. The portable dossier
 * ================================================================== */

async function writeJson(filename, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.writeFile(filename, bytes);
  return { path: filename, sha256: sha(bytes) };
}
async function writeBlob(filename, value) {
  const bytes = Buffer.from(value, "utf8");
  await fs.writeFile(filename, bytes);
  return { path: filename, sha256: sha(bytes) };
}

function exclusionRecord(name) {
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
 * The five portable evidence classes, produced as real hash-bound files so the
 * dossier is validated against bytes rather than against claims.
 */
async function fixture(root) {
  await fs.mkdir(root, { recursive: true });
  const maximalWorkbook = await writeBlob(path.join(root, "standard-maximal.xlsx"), "maximal authority");
  const netCashWorkbook = await writeBlob(path.join(root, "standard-net-cash.xlsx"), "net-cash authority");
  const caseFile = await writeBlob(path.join(root, "case.json"), "case");
  const financeWorkbook = await writeBlob(path.join(root, "finance.xlsx"), "finance");
  const financeRowMap = await writeBlob(`${financeWorkbook.path}.row-map.json`, "row map");
  const parityWorkbook = await writeBlob(path.join(root, "parity.xlsx"), "parity");
  const parityRowMap = await writeBlob(path.join(root, "parity.row-map.json"), "parity row map");
  const parityLedger = await writeBlob(path.join(root, "parity-ledger.json"), "parity ledger");

  const authority = async (name, caseName, workbook) => {
    const sheets = [];
    for (const sheetName of SHEETS) {
      const page = await writeBlob(
        path.join(root, `${name}-${sheetName.replaceAll(" ", "-")}.png`),
        `${name}:${sheetName}`,
      );
      sheets.push({
        sheet: sheetName,
        verdict: "PASS",
        visual_regression: { mode: "compared", baselines_written: [], baselines_removed: [] },
        rendered_pages: [page],
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
      workbook: workbook.path,
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
      case: caseFile.path,
      case_sha256: caseFile.sha256,
      workbook: financeWorkbook.path,
      workbook_sha256: financeWorkbook.sha256,
      row_map: financeRowMap.path,
      row_map_sha256: financeRowMap.sha256,
    },
    source_parity: {
      status: "PASS",
      certified_closure_sha256: CLOSURE,
      ledger_applicable: true,
      coverage: { ledger_pass: "ran" },
      stats: { checked: 4 },
      violations: [],
      bindings: { workbook: parityWorkbook, row_map: parityRowMap, ledger: parityLedger },
    },
  };

  const evidence = {};
  for (const [name, report] of Object.entries(reports)) {
    evidence[name] = await writeJson(path.join(root, `${name}.json`), report);
  }
  const manifestPath = path.join(root, "portable-certification-evidence.json");
  await writeJson(manifestPath, {
    schema_version: PORTABLE_CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certification_tier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    package_mode: PORTABLE_CERTIFIED_PACKAGE_MODE,
    certified_runtime_code_closure_sha256: CLOSURE,
    evidence,
    declared_exclusions: {
      native_excel: exclusionRecord("native_excel"),
      visual_review: exclusionRecord("visual_review"),
    },
  });
  return {
    manifestPath,
    reports,
    evidence,
    tolerance_policy: TOLERANCE_POLICY,
    economic_solve_policy_sha256: POLICY_SHA256,
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

const readManifest = async (manifestPath) => JSON.parse(await fs.readFile(manifestPath, "utf8"));
const saveManifest = (manifestPath, value) => writeJson(manifestPath, value);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "p80-portable-tier-"));
let mutationsRefused = 0;
try {
  /* --- C. the portable gate is SATISFIABLE ------------------------- */
  const valid = await fixture(path.join(root, "valid"));
  const pass = await validateReleaseCertificationEvidence({
    manifestPath: valid.manifestPath,
    runtimeCodeClosureSha256: CLOSURE,
    certificationTier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    authorityHashes: valid.authorityHashes,
  });
  check(pass.status === "PASS", `portable certification is still unsatisfiable: ${JSON.stringify(pass.findings)}`);
  check(pass.total_violations === 0, "a passing portable receipt still reports violations");
  check(pass.certification_tier === "PORTABLE_CERTIFIED", "the portable receipt does not name its tier");
  check(pass.package_mode === PORTABLE_CERTIFIED_PACKAGE_MODE, "the portable receipt does not name its package mode");
  check(pass.claims_native_host_evidence === false, "a portable receipt claims native-host evidence");
  check(
    JSON.stringify(pass.required_evidence) === JSON.stringify([...PORTABLE_REQUIRED_EVIDENCE]),
    "the portable receipt does not enumerate the portable gate set",
  );
  check(
    Object.keys(pass.declared_exclusions ?? {}).sort().join(",") === "native_excel,visual_review",
    "the portable receipt does not carry both declared exclusions",
  );
  check(
    Object.values(pass.declared_exclusions).every((record) =>
      record.exclusion_disposition === PERMANENT_DECLARED_EXCLUSION &&
      record.is_pending === false && record.is_waiver === false && record.revisit_condition === null &&
      typeof record.exclusion_reason === "string"),
    "a receipt exclusion could be read as a pending item",
  );
  check(
    pass.physical_lane_terminal_declaration?.disposition === PERMANENT_DECLARED_EXCLUSION,
    "the portable receipt does not carry the permanent physical-lane declaration",
  );
  check(
    Object.keys(pass.evidence).sort().join(",") === [...PORTABLE_REQUIRED_EVIDENCE].sort().join(","),
    "the portable receipt does not bind exactly the five portable evidence files",
  );
  check(
    Object.values(pass.evidence).every((record) => /^[0-9a-f]{64}$/.test(record.sha256)),
    "the portable receipt records an evidence file without a hash binding",
  );

  // The portable tier is still hash-bound and still applies every pre-existing
  // check on the classes it does require. Nothing was relaxed to make it pass.
  const tamperRoot = path.join(root, "tampered-page");
  const tampered = await fixture(tamperRoot);
  await fs.appendFile(tampered.reports.exact_maximal.sheets[0].rendered_pages[0].path, "tamper", "utf8");
  const tamperResult = await validateReleaseCertificationEvidence({
    manifestPath: tampered.manifestPath,
    runtimeCodeClosureSha256: CLOSURE,
    certificationTier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    authorityHashes: tampered.authorityHashes,
  });
  check(
    tamperResult.status === "FAIL" &&
      tamperResult.findings.some((item) => item.id === "authority.maximal.sheet.0.page.0"),
    "the portable tier stopped verifying rendered-page bytes",
  );
  const overrideRoot = path.join(root, "authority-override");
  const overrideFixture = await fixture(overrideRoot);
  delete process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE;
  const deniedOverride = await validateReleaseCertificationEvidence({
    manifestPath: overrideFixture.manifestPath,
    runtimeCodeClosureSha256: CLOSURE,
    certificationTier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    authorityHashes: overrideFixture.authorityHashes,
  });
  process.env.EXCEL_INFLOW_RELEASE_CERT_TEST_MODE = "1";
  check(
    deniedOverride.status === "FAIL" &&
      deniedOverride.findings.some((item) => item.id === "authority.override"),
    "the portable tier is an escape hatch around the immutable V4 authority identities",
  );
  const closureRoot = path.join(root, "wrong-closure");
  const closureFixture = await fixture(closureRoot);
  const closureManifest = await readManifest(closureFixture.manifestPath);
  closureManifest.certified_runtime_code_closure_sha256 = "b".repeat(64);
  await saveManifest(closureFixture.manifestPath, closureManifest);
  const closureResult = await validateReleaseCertificationEvidence({
    manifestPath: closureFixture.manifestPath,
    runtimeCodeClosureSha256: CLOSURE,
    certificationTier: PORTABLE_CERTIFIED_PACKAGE_MODE,
    authorityHashes: closureFixture.authorityHashes,
  });
  check(
    closureResult.status === "FAIL" && closureResult.findings.some((item) => item.id === "manifest.closure"),
    "the portable tier stopped binding the dossier to the runtime-code closure",
  );

  // And an UNKNOWN tier is refused rather than silently treated as portable.
  await assert.rejects(
    () => validateReleaseCertificationEvidence({
      manifestPath: valid.manifestPath,
      runtimeCodeClosureSha256: CLOSURE,
      certificationTier: "development",
    }),
    /certification tier must be one of certified, portable_certified/,
    "a development package can request a certification receipt",
  );
  checks += 1;
  await assert.rejects(
    () => validateReleaseCertificationEvidence({
      manifestPath: valid.manifestPath,
      runtimeCodeClosureSha256: CLOSURE,
      certificationTier: "portable",
    }),
    /certification tier must be one of certified, portable_certified/,
    "an invented certification tier is accepted",
  );
  checks += 1;

  /* --- D. the four required mutations ------------------------------ */
  const mutation = async (name, mutate, expectedId, options = {}) => {
    const data = await fixture(path.join(root, name));
    await mutate(data);
    const result = await validateReleaseCertificationEvidence({
      manifestPath: data.manifestPath,
      runtimeCodeClosureSha256: CLOSURE,
      certificationTier: options.tier ?? PORTABLE_CERTIFIED_PACKAGE_MODE,
      authorityHashes: data.authorityHashes,
    });
    assert.equal(result.status, "FAIL", `mutation ${name} was accepted`);
    assert(
      result.findings.some((item) => item.id.includes(expectedId)),
      `mutation ${name} was refused for the wrong reason: ${JSON.stringify(result.findings)}`,
    );
    mutationsRefused += 1;
    checks += 1;
    return result;
  };

  // 1. A portable package claiming native certification.
  //    (a) the dossier names the native mode ...
  await mutation("claims-native-mode", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.package_mode = NATIVE_CERTIFIED_PACKAGE_MODE;
    value.certification_tier = NATIVE_CERTIFIED_PACKAGE_MODE;
    await saveManifest(manifestPath, value);
  }, "manifest.portable.native_claim");
  //    (b) ... and the same portable dossier submitted TO the native gate.
  const nativeGateResult = await mutation("portable-dossier-at-native-gate", async () => {},
    "manifest.native.portable_dossier", { tier: NATIVE_CERTIFIED_PACKAGE_MODE });
  check(
    nativeGateResult.findings.some((item) => item.id === "evidence.native_excel.path") &&
      nativeGateResult.findings.some((item) => item.id === "evidence.visual_review.path"),
    "the native gate stopped requiring the native-host evidence classes",
  );
  check(
    nativeGateResult.declared_exclusions === null &&
      nativeGateResult.certification_tier === "NATIVE_CERTIFIED",
    "a native-tier receipt carries portable exclusions",
  );

  // 2. An excluded evidence class presented as SATISFIED.
  await mutation("excluded-presented-as-satisfied", async ({ manifestPath, evidence }) => {
    const value = await readManifest(manifestPath);
    value.evidence.native_excel = { ...evidence.frozen_cohort };
    await saveManifest(manifestPath, value);
  }, "manifest.portable.excluded_presented_as_satisfied.native_excel");
  await mutation("visual-review-presented-as-satisfied", async ({ manifestPath, evidence }) => {
    const value = await readManifest(manifestPath);
    value.evidence.visual_review = { ...evidence.source_parity };
    await saveManifest(manifestPath, value);
  }, "manifest.portable.excluded_presented_as_satisfied.visual_review");

  // 3. An excluded class presented as merely PENDING — every spelling.
  await mutation("excluded-presented-as-pending-disposition", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.declared_exclusions.native_excel.exclusion_disposition = "PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW";
    await saveManifest(manifestPath, value);
  }, "exclusion.native_excel.disposition");
  await mutation("excluded-presented-as-pending-flag", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.declared_exclusions.visual_review.is_pending = true;
    await saveManifest(manifestPath, value);
  }, "exclusion.visual_review.is_pending");
  await mutation("excluded-presented-as-revisitable", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.declared_exclusions.native_excel.revisit_condition = "when a Rogo host becomes available";
    await saveManifest(manifestPath, value);
  }, "exclusion.native_excel.revisit_condition");
  await mutation("excluded-presented-as-waiver", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.declared_exclusions.visual_review.is_waiver = true;
    await saveManifest(manifestPath, value);
  }, "exclusion.visual_review.is_waiver");
  await mutation("excluded-counted-as-portable-pass", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.declared_exclusions.native_excel.excluded_from_portable_gate = false;
    await saveManifest(manifestPath, value);
  }, "exclusion.native_excel.excluded_from_portable_gate");
  await mutation("exclusion-without-reason", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.declared_exclusions.visual_review.exclusion_reason = "n/a";
    await saveManifest(manifestPath, value);
  }, "exclusion.visual_review.exclusion_reason");
  // Silence is refused too: dropping the declaration is not the same as
  // declaring it, and neither is renaming the excluded capability.
  await mutation("exclusion-omitted-entirely", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    delete value.declared_exclusions;
    await saveManifest(manifestPath, value);
  }, "manifest.portable.declared_exclusions");
  await mutation("one-exclusion-omitted", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    delete value.declared_exclusions.visual_review;
    await saveManifest(manifestPath, value);
  }, "exclusion.visual_review");
  await mutation("exclusion-renames-host-capability", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.declared_exclusions.native_excel.required_host_capability = "any spreadsheet application";
    await saveManifest(manifestPath, value);
  }, "exclusion.native_excel.required_host_capability");

  // 4. A portable dossier MISSING a portable-required class.
  for (const name of PORTABLE_REQUIRED_EVIDENCE) {
    await mutation(`portable-required-missing-${name}`, async ({ manifestPath }) => {
      const value = await readManifest(manifestPath);
      delete value.evidence[name];
      await saveManifest(manifestPath, value);
    }, `manifest.portable.required_missing.${name}`);
  }
  // ... and an invented class is not a substitute for a missing one.
  await mutation("invented-evidence-class", async ({ manifestPath, evidence }) => {
    const value = await readManifest(manifestPath);
    delete value.evidence.source_parity;
    value.evidence.portable_equivalent_of_source_parity = { ...evidence.source_parity };
    await saveManifest(manifestPath, value);
  }, "manifest.portable.unknown_evidence.portable_equivalent_of_source_parity");
  await mutation("portable-schema-version-spoof", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.schema_version = "release-certification-evidence/1.0";
    await saveManifest(manifestPath, value);
  }, "manifest.portable.schema_version");
  await mutation("portable-escape-hatch-key", async ({ manifestPath }) => {
    const value = await readManifest(manifestPath);
    value.unreviewed_escape_hatch = true;
    await saveManifest(manifestPath, value);
  }, "manifest.portable.unknown_key");

  check(mutationsRefused === 21, `expected 21 refused mutations, got ${mutationsRefused}`);
  console.log(JSON.stringify({ status: "PASS", checks }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
