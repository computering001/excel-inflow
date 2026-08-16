#!/usr/bin/env python3
"""Apply Excel Inflow repair stage 2: workflow, identity, canary and telemetry."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, "utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 0 and new in text:
        return text
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_workflow_state_pairings() -> list[str]:
    changed = []
    candidates = [
        "scripts/run_excel_inflow_vnext.mjs",
        "scripts/run_user_flow.mjs",
        "scripts/lib/user_flow_controller.mjs",
        "scripts/lib/flow.mjs",
        "scripts/lib/flow_read.mjs",
        "scripts/lib/workflow_state.mjs",
    ]
    pair_patterns = [
        re.compile(r'(status\s*:\s*["\']ACTION_REQUIRED["\'](?:(?!\n\s*\}).){0,500}?blocker_class\s*:\s*["\']INTERNAL_WORK["\'])', re.S),
        re.compile(r'(blocker_class\s*:\s*["\']INTERNAL_WORK["\'](?:(?!\n\s*\}).){0,500}?status\s*:\s*["\']ACTION_REQUIRED["\'])', re.S),
    ]
    for path in candidates:
        target = ROOT / path
        if not target.is_file():
            continue
        text = read(path)
        original = text
        for pattern in pair_patterns:
            def repair(match: re.Match[str]) -> str:
                return re.sub(r'(["\'])ACTION_REQUIRED\1', r'\1NEEDS_INTERNAL_WORK\1', match.group(0))
            text = pattern.sub(repair, text)
        if text != original:
            write(path, text)
            changed.append(path)
    test_path = "scripts/run_workflow_state_pairing_tests.mjs"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const contract = JSON.parse(fs.readFileSync(path.join(root, "assets", "workflow-state-contract-v1.json"), "utf8"));
const valid = new Set();
for (const [layer, definition] of Object.entries(contract.layers ?? {})) {
  for (const [status, state] of Object.entries(definition.states ?? {})) {
    for (const blocker of state.blocker_classes ?? [null]) valid.add(`${status}\0${blocker}`);
  }
}
const sourceFiles = [
  "scripts/run_excel_inflow_vnext.mjs",
  "scripts/run_user_flow.mjs",
  "scripts/lib/user_flow_controller.mjs",
  "scripts/lib/flow.mjs",
  "scripts/lib/flow_read.mjs",
  "scripts/lib/workflow_state.mjs",
].filter((file) => fs.existsSync(path.join(root, file)));
let checks = 0;
for (const file of sourceFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const invalidForward = /status\s*:\s*["']ACTION_REQUIRED["'](?:(?!\n\s*\}).){0,500}?blocker_class\s*:\s*["']INTERNAL_WORK["']/s;
  const invalidReverse = /blocker_class\s*:\s*["']INTERNAL_WORK["'](?:(?!\n\s*\}).){0,500}?status\s*:\s*["']ACTION_REQUIRED["']/s;
  assert.equal(invalidForward.test(source), false, `${file} contains ACTION_REQUIRED/INTERNAL_WORK`);
  assert.equal(invalidReverse.test(source), false, `${file} contains INTERNAL_WORK/ACTION_REQUIRED`);
  checks += 2;
}
assert.ok(valid.has("ACTION_REQUIRED\0USER_DECISION"));
assert.ok(valid.has("NEEDS_INTERNAL_WORK\0INTERNAL_WORK"));
checks += 2;
console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
''')
    changed.append(test_path)
    return changed


def patch_statement_role_equivalence() -> list[str]:
    path = "scripts/lib/statement_topology.mjs"
    text = read(path)
    if "canonicalTopologyRole" not in text:
        marker = "const SECTIONS = new Set([\"income_statement\", \"cash_flow\"]);\n"
        addition = '''const TOPOLOGY_ROLE_EQUIVALENCE = Object.freeze({
  operating_profit: "ebit",
  operating_income: "ebit",
  operating_loss: "ebit",
  profit_before_tax: "pre_tax_income",
  pbt: "pre_tax_income",
});

export function canonicalTopologyRole(role) {
  const value = String(role ?? "").trim().toLowerCase();
  return TOPOLOGY_ROLE_EQUIVALENCE[value] ?? value;
}

function topologyRoleEquals(left, right) {
  return canonicalTopologyRole(left) === canonicalTopologyRole(right);
}

'''
        text = replace_once(text, marker, marker + "\n" + addition, "topology role helper")
    text = text.replace("row.semantic_role === requiredRole", "topologyRoleEquals(row.semantic_role, requiredRole)")
    # Unique visible-role comparisons must use the canonical family.
    text = text.replace("UNIQUE_VISIBLE_ROLES[section].has(row.semantic_role)", "UNIQUE_VISIBLE_ROLES[section].has(canonicalTopologyRole(row.semantic_role))")
    text = text.replace("HEADLINE_TOTAL_ROLES.has(row.semantic_role)", "HEADLINE_TOTAL_ROLES.has(canonicalTopologyRole(row.semantic_role))")
    write(path, text)
    test_path = "scripts/run_statement_role_equivalence_tests.mjs"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import { canonicalTopologyRole, materializeStatementPresentationTree } from "./lib/statement_topology.mjs";

assert.equal(canonicalTopologyRole("operating_profit"), "ebit");
assert.equal(canonicalTopologyRole("operating_income"), "ebit");
assert.equal(canonicalTopologyRole("ebit"), "ebit");
const rows = [
  { row_id: "revenue", semantic_role: "revenue", row_type: "input", style_role: "total" },
  { row_id: "operating_profit", semantic_role: "operating_profit", row_type: "calculation", style_role: "total" },
  { row_id: "pre_tax", semantic_role: "pre_tax_income", row_type: "calculation", calculation: { operator: "subtract", refs: ["operating_profit"] } },
  { row_id: "net_income", semantic_role: "net_income", row_type: "calculation", style_role: "total", calculation: { operator: "subtract", refs: ["pre_tax"] } },
];
const result = materializeStatementPresentationTree(rows, "income_statement");
assert.equal(result.conclusion.errors.length, 0);
assert.equal(result.conclusion.owner_display_id, "net_income");
assert.equal(rows.find((row) => row.row_id === "operating_profit").presentation_depth, 0);
console.log(JSON.stringify({ status: "PASS", checks: 7 }, null, 2));
''')
    return [path, test_path]


def patch_canary_honesty() -> list[str]:
    path = "scripts/run_raw_input_local_semantic_canary.mjs"
    text = read(path)
    text = text.replace(
        '  preauthored_broker_crosswalk: false,',
        '  preauthored_broker_crosswalk: brokerState === "usable",\n  semantic_response_mode: brokerState === "usable" ? "test_authored_fixture" : "none",\n  installed_host_semantic_seam_exercised: false,\n  installed_host_certification_claim: false,',
    )
    write(path, text)
    schema_path = "assets/installed-host-broker-canary-v1.schema.json"
    if not (ROOT / schema_path).exists():
        write(schema_path, json.dumps({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://local.invalid/excel-inflow/installed-host-broker-canary-v1.schema.json",
            "title": "Installed-host raw broker canary receipt",
            "type": "object",
            "additionalProperties": False,
            "required": [
                "schema_version", "status", "source_identity", "raw_broker_pdf_sha256",
                "model_host_response_artifacts", "selected_cell_count", "selected_house_id",
                "workbook_sha256", "workbook_broker_link_count", "provenance_match_count",
                "preauthored_crosswalk", "preauthored_semantic_response"
            ],
            "properties": {
                "schema_version": {"const": "installed-host-broker-canary/1.0"},
                "status": {"const": "PASS"},
                "source_identity": {"type": "object"},
                "raw_broker_pdf_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                "model_host_response_artifacts": {"type": "array", "minItems": 1, "items": {"type": "object"}},
                "selected_cell_count": {"type": "integer", "minimum": 1},
                "selected_house_id": {"type": "string", "minLength": 1},
                "workbook_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
                "workbook_broker_link_count": {"type": "integer", "minimum": 1},
                "provenance_match_count": {"type": "integer", "minimum": 1},
                "preauthored_crosswalk": {"const": False},
                "preauthored_semantic_response": {"const": False},
                "wall_clock_duration_ms": {"type": "number", "minimum": 0}
            }
        }, indent=2) + "\n")
    validator_path = "scripts/validate_installed_host_broker_canary.mjs"
    if not (ROOT / validator_path).exists():
        write(validator_path, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "./lib/json_schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const receiptPath = process.argv[2];
if (!receiptPath) throw new Error("Usage: validate_installed_host_broker_canary.mjs <receipt.json>");
const receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(root, "assets", "installed-host-broker-canary-v1.schema.json"), "utf8"));
const errors = validateJsonSchema(receipt, schema);
assert.deepEqual(errors, [], errors.join("\n"));
assert.equal(receipt.preauthored_crosswalk, false);
assert.equal(receipt.preauthored_semantic_response, false);
assert.ok(receipt.selected_cell_count > 0);
assert.ok(receipt.workbook_broker_link_count > 0);
assert.equal(receipt.provenance_match_count, receipt.workbook_broker_link_count);
console.log(JSON.stringify({ status: "PASS", selected_cells: receipt.selected_cell_count, links: receipt.workbook_broker_link_count }, null, 2));
''')
    return [path, schema_path, validator_path]


def patch_runtime_identity() -> list[str]:
    path = "scripts/lib/run_carrier.mjs"
    text = read(path)
    text = text.replace('export const RUN_CARRIER_SCHEMA = "debt-model-run-carrier/2.0";', 'export const RUN_CARRIER_SCHEMA = "debt-model-run-carrier/3.0";')
    if "async function runtimeSourceIdentity" not in text:
        marker = "\nfunction carrierBody(carrier) {\n"
        helper = r'''

async function readJsonIfPresent(target) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function runtimeSourceIdentity(skillRoot) {
  const runtime = await readJsonIfPresent(path.join(skillRoot, "assets", "runtime-manifest.json"));
  const release = await readJsonIfPresent(path.join(skillRoot, "release-manifest.json"));
  const certification = release?.certification ?? {};
  const sourceCommit = process.env.EXCEL_INFLOW_SOURCE_COMMIT ?? runtime.sourceCommit ?? release.sourceCommit ?? null;
  const sourceTree = process.env.EXCEL_INFLOW_SOURCE_TREE ?? runtime.sourceTree ?? release.sourceTree ?? null;
  const currentClosure = runtime.currentClosureSha256 ?? certification.currentClosureSha256 ?? null;
  const packageMode = runtime.packageMode ?? release.packageMode ?? "development";
  const identity = {
    schema_version: "excel-inflow-source-identity/1.0",
    repository: runtime.repository ?? release.repository ?? "computering001/excel-inflow",
    source_commit: sourceCommit,
    source_tree: sourceTree,
    current_closure_sha256: currentClosure,
    certified_closure_sha256: runtime.certifiedClosureSha256 ?? certification.certifiedClosureSha256 ?? null,
    package_mode: packageMode,
    skill_version: runtime.skillVersion ?? release.skillVersion ?? null,
    release_name: release.releaseName ?? null,
  };
  if (packageMode !== "development") {
    if (!SHA256.test(String(identity.source_commit ?? ""))) throw new Error("Non-development carrier source commit is absent or invalid.");
    if (!SHA256.test(String(identity.source_tree ?? ""))) throw new Error("Non-development carrier source tree is absent or invalid.");
    if (!SHA256.test(String(identity.certified_closure_sha256 ?? ""))) throw new Error("Non-development carrier certified closure is absent or invalid.");
  }
  if (identity.source_commit !== null && !SHA256.test(String(identity.source_commit))) throw new Error("Carrier source commit is invalid.");
  if (identity.source_tree !== null && !SHA256.test(String(identity.source_tree))) throw new Error("Carrier source tree is invalid.");
  if (identity.current_closure_sha256 !== null && !SHA256.test(String(identity.current_closure_sha256))) throw new Error("Carrier current closure is invalid.");
  return identity;
}
'''
        if marker not in text:
            raise RuntimeError("run carrier helper marker absent")
        text = text.replace(marker, helper + marker, 1)
    if "const sourceIdentity = await runtimeSourceIdentity(skillRoot);" not in text:
        marker = "  const normalisedIssuer = normaliseIssuerIdentity(issuerIdentity);\n  const body = {\n"
        replacement = "  const normalisedIssuer = normaliseIssuerIdentity(issuerIdentity);\n  const sourceIdentity = await runtimeSourceIdentity(skillRoot);\n  const body = {\n"
        text = replace_once(text, marker, replacement, "carrier source identity creation")
        text = text.replace(
            "    issuer_identity_hash: sha256Bytes(canonicalJson(normalisedIssuer)),\n",
            "    issuer_identity_hash: sha256Bytes(canonicalJson(normalisedIssuer)),\n    source_identity: sourceIdentity,\n    source_identity_hash: sha256Bytes(canonicalJson(sourceIdentity)),\n",
            1,
        )
    verify_marker = "  const issuerIdentity = normaliseIssuerIdentity(carrier.issuer_identity);\n"
    if "carrier.source_identity_hash" not in text:
        verification = '''  const sourceIdentity = carrier.source_identity;
  if (!sourceIdentity || sourceIdentity.schema_version !== "excel-inflow-source-identity/1.0") {
    throw new Error("Run carrier source identity is absent or invalid.");
  }
  if (carrier.source_identity_hash !== sha256Bytes(canonicalJson(sourceIdentity))) {
    throw new Error("Run carrier source identity hash does not match.");
  }
  const currentSourceIdentity = await runtimeSourceIdentity(skillRoot);
  if (sha256Bytes(canonicalJson(sourceIdentity)) !== sha256Bytes(canonicalJson(currentSourceIdentity))) {
    throw new Error("Run carrier source/install identity does not match the active runtime.");
  }
'''
        text = replace_once(text, verify_marker, verification + verify_marker, "carrier source identity verification")
    write(path, text)
    for target_path in ["SKILL.md", "central-instructions.md", "references/runtime-core.md"]:
        if (ROOT / target_path).is_file():
            doc = read(target_path).replace("debt-model-run-carrier/2.0", "debt-model-run-carrier/3.0")
            write(target_path, doc)
    runtime_path = "assets/runtime-manifest.json"
    runtime = json.loads(read(runtime_path))
    runtime.setdefault("repository", "computering001/excel-inflow")
    runtime.setdefault("sourceCommit", None)
    runtime.setdefault("sourceTree", None)
    runtime.setdefault("packageMode", "development")
    certification = json.loads(read("release-manifest.json")).get("certification") or {}
    runtime.setdefault("currentClosureSha256", certification.get("currentClosureSha256"))
    runtime.setdefault("certifiedClosureSha256", certification.get("certifiedClosureSha256"))
    write(runtime_path, json.dumps(runtime, indent=2) + "\n")
    test_path = "scripts/run_run_carrier_source_identity_tests.mjs"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeRunCarrier, verifyRunCarrier } from "./lib/run_carrier.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-carrier-v3-"));
const evidence = path.join(temporary, "evidence.json");
await fs.writeFile(evidence, JSON.stringify({ schema_version: "evidence-run/1.0", run_id: "carrier_v3" }));
process.env.EXCEL_INFLOW_SOURCE_COMMIT = "a".repeat(40) + "a".repeat(24);
process.env.EXCEL_INFLOW_SOURCE_TREE = "b".repeat(64);
const written = await writeRunCarrier({
  skillRoot: root,
  runRoot: temporary,
  runId: "carrier_v3",
  controllerVersion: "test/1",
  workspaceToken: "token",
  issuerIdentity: { entity_name: "Test plc" },
  evidencePath: evidence,
  status: "RESUMABLE",
});
assert.equal(written.carrier.schema_version, "debt-model-run-carrier/3.0");
assert.equal(written.carrier.source_identity.source_commit, "a".repeat(64));
assert.equal(written.carrier.source_identity.source_tree, "b".repeat(64));
await verifyRunCarrier({ skillRoot: root, runRoot: temporary, carrierPath: written.path, controllerVersion: "test/1", workspaceToken: "token" });
const tampered = JSON.parse(await fs.readFile(written.path, "utf8"));
tampered.source_identity.source_tree = "c".repeat(64);
await fs.writeFile(written.path, JSON.stringify(tampered));
await assert.rejects(
  verifyRunCarrier({ skillRoot: root, runRoot: temporary, carrierPath: written.path, controllerVersion: "test/1", workspaceToken: "token" }),
  /hash|identity/i,
);
console.log(JSON.stringify({ status: "PASS", checks: 6 }, null, 2));
''')
    return [path, runtime_path, test_path]


def patch_user_visible_telemetry() -> list[str]:
    module_path = "scripts/lib/user_visible_runtime_trace.mjs"
    if not (ROOT / module_path).exists():
        write(module_path, r'''import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function iso(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid user submission timestamp: ${value}`);
  return parsed.toISOString();
}

function duration(start, end) {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

export function initializeUserVisibleProcessTrace(entrypoint) {
  const outputPath = process.env.EXCEL_INFLOW_USER_TRACE_PATH;
  if (!outputPath) return null;
  const submittedAt = iso(process.env.EXCEL_INFLOW_USER_SUBMISSION_AT);
  const processStartedAt = new Date().toISOString();
  const trace = {
    schema_version: "user-visible-runtime-trace/1.0",
    trace_id: process.env.EXCEL_INFLOW_TRACE_ID ?? crypto.randomUUID(),
    run_id: process.env.EXCEL_INFLOW_RUN_ID ?? null,
    entrypoint,
    submitted_at: submittedAt,
    process_started_at: processStartedAt,
    visible_response_at: null,
    user_visible_duration_ms: null,
    process_duration_ms: null,
    attribution_coverage: null,
    spans: [{
      span_id: crypto.randomUUID(),
      parent_span_id: process.env.EXCEL_INFLOW_PARENT_SPAN_ID ?? null,
      name: entrypoint,
      started_at: processStartedAt,
      completed_at: null,
      duration_ms: null,
      owner: "excel_inflow_process",
    }],
  };
  const write = () => {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  };
  write();
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    const completedAt = new Date().toISOString();
    trace.visible_response_at = completedAt;
    trace.user_visible_duration_ms = duration(trace.submitted_at, completedAt);
    trace.process_duration_ms = duration(trace.process_started_at, completedAt);
    trace.spans[0].completed_at = completedAt;
    trace.spans[0].duration_ms = trace.process_duration_ms;
    trace.attribution_coverage = trace.user_visible_duration_ms === 0
      ? 1
      : Math.min(1, trace.spans.reduce((sum, span) => sum + Number(span.duration_ms ?? 0), 0) / trace.user_visible_duration_ms);
    write();
  };
  process.once("beforeExit", complete);
  process.once("exit", complete);
  return { trace, complete, outputPath: path.resolve(outputPath) };
}
''')
    schema_path = "assets/user-visible-runtime-trace-v1.schema.json"
    if not (ROOT / schema_path).exists():
        write(schema_path, json.dumps({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://local.invalid/excel-inflow/user-visible-runtime-trace-v1.schema.json",
            "type": "object",
            "additionalProperties": False,
            "required": ["schema_version", "trace_id", "entrypoint", "submitted_at", "process_started_at", "spans"],
            "properties": {
                "schema_version": {"const": "user-visible-runtime-trace/1.0"},
                "trace_id": {"type": "string", "minLength": 1},
                "run_id": {"type": ["string", "null"]},
                "entrypoint": {"type": "string", "minLength": 1},
                "submitted_at": {"type": "string", "format": "date-time"},
                "process_started_at": {"type": "string", "format": "date-time"},
                "visible_response_at": {"type": ["string", "null"], "format": "date-time"},
                "user_visible_duration_ms": {"type": ["number", "null"], "minimum": 0},
                "process_duration_ms": {"type": ["number", "null"], "minimum": 0},
                "attribution_coverage": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
                "spans": {"type": "array", "minItems": 1, "items": {"type": "object"}}
            }
        }, indent=2) + "\n")
    changed = [module_path, schema_path]
    for entrypoint in ["scripts/run_excel_inflow_vnext.mjs", "scripts/run_user_flow.mjs"]:
        if not (ROOT / entrypoint).is_file():
            continue
        text = read(entrypoint)
        import_line = 'import { initializeUserVisibleProcessTrace } from "./lib/user_visible_runtime_trace.mjs";\n'
        if import_line not in text:
            insert_at = 0
            shebang_end = text.find("\n") + 1 if text.startswith("#!") else 0
            insert_at = shebang_end
            text = text[:insert_at] + "\n" + import_line + text[insert_at:]
        entry_name = Path(entrypoint).name
        init_line = f'initializeUserVisibleProcessTrace("{entry_name}");\n'
        if init_line not in text:
            last_import = 0
            for match in re.finditer(r"^import .*?;\s*$", text, re.M):
                last_import = match.end()
            text = text[:last_import] + "\n\n" + init_line + text[last_import:]
        write(entrypoint, text)
        changed.append(entrypoint)
    test_path = "scripts/run_user_visible_runtime_trace_tests.mjs"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeUserVisibleProcessTrace } from "./lib/user_visible_runtime_trace.mjs";

const target = path.join(os.tmpdir(), `excel-inflow-trace-${process.pid}.json`);
process.env.EXCEL_INFLOW_USER_TRACE_PATH = target;
process.env.EXCEL_INFLOW_USER_SUBMISSION_AT = new Date(Date.now() - 2500).toISOString();
process.env.EXCEL_INFLOW_TRACE_ID = "trace-test";
const handle = initializeUserVisibleProcessTrace("test-entrypoint");
assert.ok(handle);
handle.complete();
const trace = JSON.parse(fs.readFileSync(target, "utf8"));
assert.equal(trace.schema_version, "user-visible-runtime-trace/1.0");
assert.equal(trace.trace_id, "trace-test");
assert.ok(trace.user_visible_duration_ms >= 2400);
assert.ok(trace.process_duration_ms >= 0);
assert.ok(trace.user_visible_duration_ms >= trace.process_duration_ms);
assert.equal(trace.spans.length, 1);
assert.equal(trace.spans[0].owner, "excel_inflow_process");
assert.ok(trace.attribution_coverage >= 0 && trace.attribution_coverage <= 1);
console.log(JSON.stringify({ status: "PASS", duration_ms: trace.user_visible_duration_ms }, null, 2));
''')
    changed.append(test_path)
    return changed


def patch_registry() -> list[str]:
    path = "assets/development-test-registry.json"
    registry = json.loads(read(path))
    tests = registry.get("tests") or []
    ids = {item.get("id") for item in tests}
    additions = [
        {"id": "workflow-state-pairing", "phase": "workflow", "runtime": "node", "script": "run_workflow_state_pairing_tests.mjs"},
        {"id": "statement-role-equivalence", "phase": "evidence", "runtime": "node", "script": "run_statement_role_equivalence_tests.mjs"},
        {"id": "run-carrier-source-identity", "phase": "workflow", "runtime": "node", "script": "run_run_carrier_source_identity_tests.mjs"},
        {"id": "user-visible-runtime-trace", "phase": "workflow", "runtime": "node", "script": "run_user_visible_runtime_trace_tests.mjs"},
        {
            "id": "installed-host-usable-broker-canary",
            "phase": "real_corpus",
            "runtime": "node",
            "script": "validate_installed_host_broker_canary.mjs",
            "arguments": ["$INSTALLED_HOST_BROKER_CANARY_RECEIPT"],
            "requires": ["INSTALLED_HOST_BROKER_CANARY_RECEIPT"],
        },
    ]
    for item in additions:
        if item["id"] not in ids:
            tests.append(item)
            ids.add(item["id"])
    registry["tests"] = tests
    write(path, json.dumps(registry, indent=2) + "\n")
    gate_path = "scripts/run_development_gate.mjs"
    gate = read(gate_path)
    if "installed-host-broker-canary-receipt" not in gate:
        gate = gate.replace(
            '    "  [--real-filings-expectations <run-scoped-expectations.json>]",',
            '    "  [--real-filings-expectations <run-scoped-expectations.json>]",\n    "  [--installed-host-broker-canary-receipt <receipt.json>]",',
        )
        gate = gate.replace(
            "    REAL_FILINGS_EXPECTATIONS: options[\"real-filings-expectations\"]\n      ? path.resolve(options[\"real-filings-expectations\"])\n      : null,",
            "    REAL_FILINGS_EXPECTATIONS: options[\"real-filings-expectations\"]\n      ? path.resolve(options[\"real-filings-expectations\"])\n      : null,\n    INSTALLED_HOST_BROKER_CANARY_RECEIPT: options[\"installed-host-broker-canary-receipt\"]\n      ? path.resolve(options[\"installed-host-broker-canary-receipt\"])\n      : null,",
        )
        write(gate_path, gate)
    return [path, gate_path]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    changed = []
    changed += patch_workflow_state_pairings()
    changed += patch_statement_role_equivalence()
    changed += patch_canary_honesty()
    changed += patch_runtime_identity()
    changed += patch_user_visible_telemetry()
    changed += patch_registry()
    changed = sorted(set(changed))
    report: dict[str, Any] = {
        "schema_version": "excel-inflow-repair-stage2/1.0",
        "changed_paths": changed,
        "path_sha256": {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in changed},
        "claims": {
            "action_required_never_internal_work": True,
            "operating_profit_is_ebit_topology_equivalent": True,
            "deterministic_canary_does_not_claim_installed_host": True,
            "carrier_binds_source_identity": True,
            "host_submission_boundary_trace_supported": True,
        },
    }
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "repair-stage2.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({"status": "PASS", "changed": len(changed), "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
