#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MANIFEST_PATH = path.join(
  ROOT,
  "test-fixtures",
  "az-replay",
  "manifest.json",
);
const EMITTER = path.join(HERE, "run_evidence_run_tests.mjs");
const CONTROLLER_HARNESS = path.join(
  HERE,
  "test-support",
  "authenticated_controller_test_harness.mjs",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalise(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
  );
}

function carrierHash(carrier) {
  const { carrier_hash: _ignored, ...body } = carrier;
  return sha256(JSON.stringify(canonicalise(body), null, 2));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

async function verifyCarrier(runDir, result) {
  const expectedPath = path.join(runDir, "run-carrier.json");
  assert(
    await fs.realpath(result.carrier) === await fs.realpath(expectedPath),
    "Result does not point at the preserved run carrier.",
  );
  const carrier = JSON.parse(await fs.readFile(expectedPath, "utf8"));
  assert(
    carrier.carrier_hash === carrierHash(carrier),
    "Run-carrier self-hash does not match its contents.",
  );
  assert(
    carrier.status === "AWAITING_DECISIONS",
    `Run-carrier status ${carrier.status} is not resumable at decisions.`,
  );
  for (const name of ["evidence_run", "forecast_plan", "forecast_plan_status"]) {
    const descriptor = carrier.files?.[name];
    assert(descriptor, `Run carrier omitted ${name}.`);
    const target = path.join(runDir, descriptor.path);
    assert(await exists(target), `Run-carrier member ${name} is absent.`);
    assert(
      sha256(await fs.readFile(target)) === descriptor.sha256,
      `Run-carrier member ${name} does not match its sealed hash.`,
    );
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  const carrierFixturePath = path.join(ROOT, manifest.carrier.path);
  assert(
    sha256(await fs.readFile(carrierFixturePath)) === manifest.carrier.sha256,
    "Sanitised carrier bytes do not match the incident manifest.",
  );

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "az-replay-"));
  const evidencePath = path.join(workDir, "evidence-run.json");
  const runDir = path.join(workDir, "run");
  try {
    await exec(process.execPath, [
      EMITTER,
      path.join(ROOT, "test-fixtures", "cases"),
      "--emit-fixture",
      manifest.fixture_id,
      evidencePath,
    ], {
      cwd: ROOT,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });

    let stdout = "";
    try {
      ({ stdout } = await exec(process.execPath, [
        CONTROLLER_HARNESS,
        "user_flow",
        evidencePath,
        "--out",
        runDir,
        "--stop-after",
        manifest.maximum_stage,
        "--json",
      ], {
        cwd: ROOT,
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      }));
    } catch (error) {
      stdout = error.stdout ?? "";
      if (!stdout.trim()) throw error;
    }

    const result = JSON.parse(stdout);
    const expected = manifest.expected_earliest_stop;
    for (const field of [
      "status",
      "stage",
      "outcome",
      "reason_code",
      "blocker_class",
      "user_blocking",
    ]) {
      assert(
        result[field] === expected[field],
        `${field} ${JSON.stringify(result[field])} !== ${JSON.stringify(expected[field])}`,
      );
    }
    assert(result.screen == null, "Internal-work stop exposed a user screen.");

    const statusPath = path.join(
      runDir,
      "stages",
      "decisions",
      "forecast-plan-status.json",
    );
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    assert(status.status === "BLOCKED", "Forecast-plan status is not BLOCKED.");
    assert(
      JSON.stringify(status.blocked.map((entry) => entry.state_id)) ===
        JSON.stringify(expected.blocked_state_ids),
      "Blocked states do not exactly match the working-capital incident surface.",
    );

    const files = await walk(runDir);
    for (const forbidden of manifest.forbidden_outputs) {
      assert(
        !files.some((target) => path.basename(target) === forbidden),
        `Forbidden downstream/user artifact exists: ${forbidden}`,
      );
    }
    assert(
      !await exists(path.join(runDir, "stages", "build_checks")),
      "Replay crossed the decisions-stage cap into build checks.",
    );
    await verifyCarrier(runDir, result);

    process.stdout.write(
      `PASS az-incident-carrier: status=${result.status} stage=${result.stage} ` +
        `blocked=${status.blocked.length} selected_authority=absent ` +
        `carrier=preserved user_question=absent\n`,
    );
    if (process.env.E8_KEEP === "1") {
      process.stdout.write(`artifacts=${workDir}\n`);
    }
  } finally {
    if (process.env.E8_KEEP !== "1") {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL az-incident-carrier: ${error.message}\n`);
  process.exitCode = 1;
});
