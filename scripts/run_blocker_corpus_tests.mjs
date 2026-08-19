#!/usr/bin/env node
/**
 * P0.2 — Immutable blocker replay corpus (v3.7.7 finalisation programme).
 *
 * Invariant: every known blocker reproduces deterministically or is
 * explicitly classified as non-reproducible with its missing evidence named.
 *
 * This runner:
 *   1. verifies the SHA-256 of every fixture the corpus manifest names,
 *      BEFORE any replay executes — a tampered fixture is refused with a
 *      typed error, never run;
 *   2. proves the refusal with a built-in negative self-test (a copied
 *      manifest with one corrupted digest must be rejected);
 *   3. executes the fast deterministic replays and asserts each case's
 *      documented signature; heavy replays (the full raw canary) are
 *      hash-verified here and executed by their own registered suites;
 *   4. reports custody-bound fixtures as typed CUSTODY_ABSENT when the
 *      custody root is not present — absence is reported, never silent.
 *
 * The corpus is a registry (one manifest), not fixtures scattered across
 * one-off scripts.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const manifestPath = path.resolve(
  option("corpus", path.join(ROOT, "test-corpus", "blockers", "corpus_manifest.json")),
);
const custodyRoot = option("custody-root", "/Users/archiepreston/Documents/Codex/private-test-custody");

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function fixtureAbsolutePath(fixture) {
  if (fixture.location === "custody") return path.join(custodyRoot, fixture.path);
  return path.join(ROOT, fixture.path);
}

async function verifyFixtures(manifest, { label }) {
  const results = [];
  for (const testCase of manifest.cases) {
    for (const fixture of testCase.fixtures) {
      const absolute = fixtureAbsolutePath(fixture);
      let state;
      try {
        await fs.access(absolute);
        const digest = await sha256(absolute);
        state = digest === fixture.sha256
          ? { status: "VERIFIED" }
          : {
              status: "TAMPERED",
              message:
                `Blocker fixture hash mismatch for ${testCase.case_id}:${fixture.path} — ` +
                `expected ${fixture.sha256}, found ${digest}. The fixture is refused; no replay may run.`,
            };
      } catch {
        state = fixture.location === "custody"
          ? {
              status: "CUSTODY_ABSENT",
              message: `Custody fixture ${fixture.path} is not present under ${custodyRoot}; hash verification deferred to a custody-bearing host.`,
            }
          : {
              status: "MISSING",
              message: `Repo fixture ${fixture.path} is absent — the corpus is broken.`,
            };
      }
      results.push({ case_id: testCase.case_id, path: fixture.path, ...state });
    }
  }
  const tampered = results.filter((item) => item.status === "TAMPERED" || item.status === "MISSING");
  if (tampered.length > 0) {
    const detail = tampered.map((item) => item.message).join("\n");
    const error = new Error(`BLOCKER_CORPUS_FIXTURE_REJECTED (${label}):\n${detail}`);
    error.typed = "BLOCKER_CORPUS_FIXTURE_REJECTED";
    throw error;
  }
  return results;
}

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
check(manifest.schema_version === "excel-inflow-blocker-corpus/1.0", "corpus manifest schema mismatch");
check(manifest.cases.length >= 6, "the corpus must carry the six mandatory Phase 0 cases");
for (const testCase of manifest.cases) {
  for (const field of [
    "case_id", "entity", "accounting_basis", "expected_support_class",
    "expected_terminal_result", "observed_failure_stage", "known_reason_code",
    "privacy_classification", "replayable", "replay_command", "replay_assertion",
  ]) {
    check(field in testCase, `case ${testCase.case_id ?? "?"} lacks required field ${field}`);
  }
  check(
    testCase.replayable === "FULL" || typeof testCase.evidence_gap === "string",
    `case ${testCase.case_id}: a non-fully-replayable case must name its missing evidence`,
  );
}

// 1. hash-verification for every fixture
const verification = await verifyFixtures(manifest, { label: "primary" });
const verified = verification.filter((item) => item.status === "VERIFIED").length;
const custodyAbsent = verification.filter((item) => item.status === "CUSTODY_ABSENT");
check(verified > 0, "no fixture verified — corpus hash verification cannot pass vacuously");

// 2. negative self-test: a corrupted digest must be refused BEFORE execution
{
  const mutated = structuredClone(manifest);
  const target = mutated.cases
    .flatMap((testCase) => testCase.fixtures.map((fixture) => ({ testCase, fixture })))
    .find(({ fixture }) => {
      const absolute = fixtureAbsolutePath(fixture);
      return fixture.location !== "custody" || verification.some(
        (item) => item.path === fixture.path && item.status === "VERIFIED",
      ) ? absolute : null;
    });
  check(Boolean(target), "negative self-test needs at least one verifiable fixture");
  target.fixture.sha256 = "0".repeat(64);
  let refused = false;
  try {
    await verifyFixtures(mutated, { label: "negative-self-test" });
  } catch (error) {
    refused = error.typed === "BLOCKER_CORPUS_FIXTURE_REJECTED";
  }
  check(refused, "a corrupted fixture digest MUST be refused with the typed rejection");
}

// 3. fast deterministic replays with documented signatures
async function run(command, args) {
  const result = await exec(command, args, {
    cwd: path.join(ROOT, "scripts"),
    timeout: 900000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout.trim();
}
const replays = [];
{
  const stdout = await run(process.execPath, ["run_tax_rate_policy_tests.mjs"]);
  const tail = stdout.split("\n").at(-1);
  check(JSON.parse(tail).status === "PASS" && JSON.parse(tail).checks === 24,
    `etr-recursion-normalisation replay signature mismatch: ${tail}`);
  replays.push({ case_id: "etr-recursion-normalisation", status: "PASS" });
}
{
  const stdout = await run(process.execPath, ["run_run_deadline_tests.mjs"]);
  const tail = stdout.split("\n").at(-1);
  check(JSON.parse(tail).status === "PASS" && JSON.parse(tail).checks === 17,
    `runtime-deadline-overrun replay signature mismatch: ${tail}`);
  replays.push({ case_id: "runtime-deadline-overrun", status: "PASS" });
}
{
  // Documented CURRENT signature at the frozen baseline: the identity
  // governance suite carries a stale 3.7.5 version pin and MUST fail with
  // exactly that assertion. When P0.3 repairs the pin, this replay's
  // expectation flips to PASS alongside the manifest entry.
  let signature = null;
  try {
    await run(process.execPath, ["run_release_identity_governance_tests.mjs"]);
  } catch (error) {
    signature = `${error.stderr ?? ""}${error.stdout ?? ""}${error.message ?? ""}`;
  }
  check(
    signature !== null && signature.includes("'3.7.6' !== '3.7.5'"),
    "package-identity-discrepancy: the documented stale-version-pin failure signature did not reproduce " +
      "(either the defect was repaired — update the corpus expectation per P0.3 — or a different failure appeared)",
  );
  replays.push({ case_id: "package-identity-discrepancy", status: "KNOWN_FAILING_SIGNATURE_REPRODUCED" });
}
const heavy = manifest.cases
  .map((testCase) => testCase.case_id)
  .filter((id) => !replays.some((replay) => replay.case_id === id));

console.log(JSON.stringify({
  status: "PASS",
  checks,
  fixtures_verified: verified,
  custody_absent: custodyAbsent.map((item) => item.path),
  fast_replays: replays,
  heavy_replays_hash_verified_only: heavy,
}, null, 0));
