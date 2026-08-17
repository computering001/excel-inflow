#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  applyRunScopedBrokerConcepts,
  runScopedConceptHash,
  validateRunScopedBrokerConcepts,
} from "./lib/run_scoped_broker_concepts.mjs";

const clone = (value) => structuredClone(value);
const runId = "run-dynamic-concept-test";
const body = {
  schema_version: "run-scoped-broker-concept/1.0",
  run_id: runId,
  metric_id: "run.legal_settlement_cash",
  section: "cash_flow",
  definition: "Cash settlement payments separately forecast by the selected broker houses.",
  unit_kind: "currency",
  sign_convention: "negative",
  parent_row_id: "exceptional_cash_flows",
  placement_anchor: { relation: "child_of", row_id: "exceptional_cash_flows" },
  materiality: {
    is_material: true,
    basis: "headline_anchor",
    threshold: 0.05,
    observed_value: 0.12,
  },
  forecast_behavior: "independent_input",
  additive: true,
  double_count_proof: {
    status: "no_overlap",
    compared_metric_ids: ["capex", "committed_restructuring"],
    rationale: "The source table presents this cash settlement outside both compared lines.",
  },
  row_relation: {
    mode: "existing_company_row",
    row_id: "known_child",
  },
  review_status: "reviewed",
};
const concept = { ...body, contract_sha256: runScopedConceptHash(body) };
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const schema = JSON.parse(
  fs.readFileSync(new URL("../assets/run-scoped-broker-concept-v1.schema.json", import.meta.url)),
);
check(validateJsonSchema(concept, schema).length === 0, "valid contract must satisfy its schema");
check(
  validateRunScopedBrokerConcepts([concept], { runId }).errors.length === 0,
  "valid contract must satisfy executable validation",
);

const python = spawnSync(
  process.env.PYTHON ?? "python3",
  ["-c", "import json,sys; from broker_dynamic_concepts import canonical_hash; print(canonical_hash(json.load(sys.stdin)))"],
  {
    cwd: new URL(".", import.meta.url),
    input: JSON.stringify(body),
    encoding: "utf8",
  },
);
check(python.status === 0, `Python validator must run: ${python.stderr}`);
check(python.stdout.trim() === concept.contract_sha256, "Python and JavaScript contract hashes must agree");

for (const mutate of [
  (value) => { value.run_id = "another-run"; },
  (value) => { value.metric_id = "custom.unscoped"; },
  (value) => { value.double_count_proof.compared_metric_ids = []; },
  (value) => { value.contract_sha256 = "0".repeat(64); },
]) {
  const changed = clone(concept);
  mutate(changed);
  check(
    validateRunScopedBrokerConcepts([changed], { runId }).errors.length > 0,
    "mutated contract must fail executable validation",
  );
}

const modelCase = {
  controls: { broker_case: "Consensus" },
  broker_pack: {
    run_scoped_concepts: [concept],
    metrics: {
      [concept.metric_id]: {
        label: "Legal settlement cash",
        unit_kind: "currency",
        brokers: { HouseA: [-12, -10, -8] },
      },
    },
  },
  statement_structure: {
    income_statement: [],
    cash_flow: [
      {
        row_id: "exceptional_cash_flows",
        label: "Exceptional cash flows",
        row_type: "calculation",
        calculation: { operator: "sum", refs: ["known_child"] },
      },
      {
        row_id: "known_child",
        label: "Known child",
        row_type: "input",
        values: [1, 1, 1, null, null, null],
        parent_row_id: "exceptional_cash_flows",
      },
    ],
  },
};
const findings = [];
applyRunScopedBrokerConcepts(modelCase, {
  add(id, severity, message) { findings.push({ id, severity, message }); },
});
check(findings.length === 0, "valid insertion must not create findings");
const bound = modelCase.statement_structure.cash_flow.find((row) => row.row_id === "known_child");
check(bound?.broker_metric_id === concept.metric_id, "existing company row must consume the contracted metric");

const unsafe = clone(modelCase);
unsafe.broker_pack.run_scoped_concepts[0].row_relation = {
  mode: "new_company_specific_row",
  row_id: "legal_settlement_cash",
};
const unsafeBody = Object.fromEntries(
  Object.entries(unsafe.broker_pack.run_scoped_concepts[0]).filter(([key]) => key !== "contract_sha256"),
);
unsafe.broker_pack.run_scoped_concepts[0].contract_sha256 = runScopedConceptHash(unsafeBody);
delete unsafe.statement_structure.cash_flow[1].broker_metric_id;
const unsafeFindings = [];
applyRunScopedBrokerConcepts(unsafe, {
  add(id, severity, message) { unsafeFindings.push({ id, severity, message }); },
});
check(
  unsafeFindings.some((finding) => finding.severity === "BLOCK"),
  "a broker-only additive row must be rejected before it can enter the company equation graph",
);

console.log(JSON.stringify({ status: "PASS", checks, mutation_count: 4 }, null, 2));
