#!/usr/bin/env node
/**
 * P1.1 — Canonical contract toolchain tests.
 *
 * Invariant: every producer emits an object that validates immediately
 * against the same canonical contract used by consumers — in both
 * languages, from one generated source, with unknown versions refused.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadSupportEnvelope, classifySupport } from "./lib/support_envelope.mjs";
import {
  validate as validateJs,
  CONTRACT_VERSION,
  SUPPORTED_VERSIONS,
} from "./lib/generated/support_envelope_contract.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const python = option("python", "python3");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

// 0. Generated artifacts are clean against the definitions (the CI gate).
await exec(process.execPath, [path.join(HERE, "compile_canonical_contracts.mjs"), "--check"], { cwd: ROOT });
checks += 1;

// 1. A REAL producer object (the P0.4 classifier's output plus the envelope
// identity) validates against the generated JS binding.
const { contract, sha256, version } = loadSupportEnvelope();
const baseline = {
  accounting_framework: "us_gaap", entity_type: "non_financial_corporate",
  filing_language_format: "english_text_pdf", historical_periods: "three_or_more",
  statement_topology: "standard_three_statement", cash_flow_method: "indirect",
  fiscal_calendar: "week_52_53", debt_instruments: "within_declared_matrix",
  broker_availability: "broker_pack_absent", acquisition_overlay: "none",
  restructuring_complexity: "none",
};
const produced = {
  contract_version: CONTRACT_VERSION,
  envelope_version: version,
  envelope_sha256: sha256,
  ...classifySupport(contract, baseline),
};
check(validateJs(produced).length === 0,
  `producer object must validate: ${validateJs(produced)[0] ?? ""}`);

// stopped variant of the union
const stopped = {
  contract_version: CONTRACT_VERSION,
  envelope_version: version,
  envelope_sha256: sha256,
  ...classifySupport(contract, { ...baseline, entity_type: "bank" }),
};
check(validateJs(stopped).length === 0, "stopped-variant object must validate");

// 2. Negative: unknown version refused, never reinterpreted.
check(validateJs({ ...produced, contract_version: "0.9.0" })
  .some((error) => error.includes("unsupported contract_version")),
  "an unknown contract_version must be refused");
check(SUPPORTED_VERSIONS.includes(CONTRACT_VERSION), "current version is supported");

// 3. Negative: a structurally invalid object fails (class outside the enum).
{
  const broken = structuredClone(produced);
  broken.support_class = "MOSTLY_FINE";
  check(validateJs(broken).length > 0, "an out-of-enum class must fail validation");
}
{
  const broken = structuredClone(stopped);
  broken.early_stop.reason_code = null; // stopped=true demands a typed reason
  check(validateJs(broken).length > 0, "a stopped union variant without a reason must fail");
}

// 4. JavaScript -> Python -> JavaScript round trip: Python validates the same
// bytes with the generated Python binding, re-serializes canonically, and the
// object survives byte-identical re-validation in JS.
const payload = JSON.stringify(produced);
const payloadPath = path.join(ROOT, "ci", "contract-roundtrip-payload.tmp.json");
await fs.writeFile(payloadPath, payload, "utf8");
const py = await exec(python, ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "scripts", "generated"))})
from support_envelope_contract import validate, CONTRACT_VERSION
candidate = json.load(open(${JSON.stringify("PAYLOAD")}.replace("PAYLOAD", sys.argv[1])))
errors = validate(candidate)
if errors:
    raise SystemExit("PY_VALIDATE_FAIL: " + "; ".join(errors))
bad = dict(candidate); bad["contract_version"] = "0.9.0"
if not validate(bad):
    raise SystemExit("PY_VERSION_GATE_FAIL")
print(json.dumps(candidate, sort_keys=False, separators=(",", ":")))
`, payloadPath]);
await fs.unlink(payloadPath);
const roundTripped = JSON.parse(py.stdout.trim());
check(validateJs(roundTripped).length === 0, "round-tripped object must re-validate in JS");
check(JSON.stringify(roundTripped) === payload, "round trip must be byte-preserving");

console.log(JSON.stringify({ status: "PASS", checks, contract_version: CONTRACT_VERSION }));
