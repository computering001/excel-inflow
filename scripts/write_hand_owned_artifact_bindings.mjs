#!/usr/bin/env node
/**
 * MP2-D4 — deterministic bindings for hand-curated generated artifacts.
 *
 * The policy BODY remains deliberately hand-owned. This writer owns only the
 * `_generated_bindings` leaf, which seals that body to the source files it
 * governs and to an independent verifier. Default mode is read-only `--check`;
 * `--write` is the sole supported way to refresh the committed bindings.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");
const BINDING_KEY = "_generated_bindings";
const WRITER_VERSION = "hand-owned-artifact-bindings/1.0";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return process.argv[index + 1];
}

const ROOT = path.resolve(option("root", DEFAULT_ROOT));
const WRITE = process.argv.includes("--write");
const CHECK = process.argv.includes("--check") || !WRITE;
if (WRITE && process.argv.includes("--check")) {
  throw new Error("Choose exactly one mode: --check (default) or --write.");
}

const TARGETS = Object.freeze({
  "assets/controller-terminal-exit-inventory-v1.json": Object.freeze({
    verifier: "scripts/run_controller_exit_inventory_tests.mjs",
    sources: Object.freeze([
      "scripts/run_excel_inflow_bootstrap.mjs",
      "scripts/run_excel_inflow_vnext.mjs",
      "scripts/run_user_flow.mjs",
    ]),
  }),
  "assets/workflow-state-contract-v1.json": Object.freeze({
    verifier: "scripts/run_workflow_state_tests.mjs",
    sources: Object.freeze([
      "scripts/lib/workflow_state.mjs",
      "scripts/workflow_state.py",
    ]),
  }),
});

const selected = option("artifact", null);
if (selected !== null && !Object.hasOwn(TARGETS, selected)) {
  throw new Error(
    `Unknown --artifact ${JSON.stringify(selected)}; expected one of ${Object.keys(TARGETS).join(", ")}`,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBytes(relative) {
  const absolute = path.join(ROOT, ...relative.split("/"));
  if (!fs.existsSync(absolute)) {
    throw new Error(`Required binding input is absent: ${relative}`);
  }
  return fs.readFileSync(absolute);
}

function serialise(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function expectedArtifact(relative, definition) {
  const currentBytes = readBytes(relative);
  let current;
  try {
    current = JSON.parse(currentBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${relative} is not valid JSON: ${error.message}`);
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`${relative} must contain one JSON object`);
  }

  const body = { ...current };
  delete body[BINDING_KEY];
  const bodyBytes = Buffer.from(serialise(body), "utf8");
  const sourceSha256 = Object.fromEntries(
    definition.sources.map((source) => [source, sha256(readBytes(source))]),
  );
  const verifierSha256 = sha256(readBytes(definition.verifier));
  const expected = {
    ...body,
    [BINDING_KEY]: {
      schema_version: WRITER_VERSION,
      body_sha256: sha256(bodyBytes),
      source_sha256: sourceSha256,
      verifier_path: definition.verifier,
      verifier_sha256: verifierSha256,
      writer: "node scripts/write_hand_owned_artifact_bindings.mjs --write",
      check: "node scripts/write_hand_owned_artifact_bindings.mjs --check",
      policy:
        "The body is hand-curated authority. Any body, governed-source or independent-verifier change makes this binding stale until the sanctioned writer is run deliberately.",
    },
  };
  return {
    currentBytes,
    expectedBytes: Buffer.from(serialise(expected), "utf8"),
    binding: expected[BINDING_KEY],
  };
}

const results = [];
for (const [relative, definition] of Object.entries(TARGETS)) {
  if (selected !== null && relative !== selected) continue;
  const computed = expectedArtifact(relative, definition);
  const agrees = computed.currentBytes.equals(computed.expectedBytes);
  if (WRITE) {
    fs.writeFileSync(path.join(ROOT, ...relative.split("/")), computed.expectedBytes);
    results.push({ artifact_path: relative, status: "WRITTEN", ...computed.binding });
    continue;
  }
  results.push({
    artifact_path: relative,
    status: agrees ? "PASS" : "FAIL",
    body_sha256: computed.binding.body_sha256,
    source_sha256: computed.binding.source_sha256,
    verifier_sha256: computed.binding.verifier_sha256,
    repair: agrees
      ? null
      : `Run the writer: node scripts/write_hand_owned_artifact_bindings.mjs --write --artifact ${relative}`,
  });
}

const failed = results.filter((result) => result.status === "FAIL");
console.log(JSON.stringify({
  status: failed.length === 0 ? (WRITE ? "WRITTEN" : "PASS") : "FAIL",
  mode: WRITE ? "write" : CHECK ? "check" : "check",
  root: ROOT,
  artifacts: results,
  failures: failed.length,
}));
process.exit(failed.length === 0 ? 0 : 1);
