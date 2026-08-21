#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runInstalledInlineXbrlProbe } from "./lib/installed_inline_xbrl_probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const pythonInput = process.argv[2] ?? process.env.EXCEL_INFLOW_TEST_PYTHON;
if (!pythonInput) {
  throw new Error("usage: run_installed_inline_xbrl_probe_tests.mjs <selected-python>");
}
const selectedPython = path.resolve(pythonInput);
const fixturePath = path.join(ROOT, "assets", "installed-inline-xbrl-capability-probe-v1.json");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "installed-inline-xbrl-probe-tests-"));
let checks = 0;
const mutationIds = [
  "contradictory-dimensioned-value-quarantined",
  "dimensioned-fact-selected",
  "missing-income-statement-fact",
  "missing-worker",
  "worker-timeout",
  "malformed-worker-result",
  "schema-invalid-worker-result",
  "malformed-fixture",
  "fixture-html-hash",
  "worker-failure",
  "cleanup-failure",
];
const caught = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFixture(name, mutate, { reseal = true } = {}) {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  mutate(fixture);
  if (reseal) fixture.html_sha256 = sha256(Buffer.from(fixture.html, "utf8"));
  const target = path.join(scratch, `${name}.json`);
  await fs.writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return target;
}

async function writeWorker(name, source) {
  const target = path.join(scratch, `${name}.py`);
  await fs.writeFile(target, source, "utf8");
  return target;
}

async function run(overrides = {}) {
  return runInstalledInlineXbrlProbe({
    skillRoot: ROOT,
    selectedPython,
    tempRoot: scratch,
    timeoutMs: 10_000,
    ...overrides,
  });
}

async function expectRefusal(id, expectedCodes, overrides, { expectScratchRemoved = true } = {}) {
  const report = await run(overrides);
  check(report.status === "REFUSED", `${id} unexpectedly passed`);
  check(expectedCodes.includes(report.reason_code), `${id} returned ${report.reason_code}`);
  check(
    report.scratch_removed === expectScratchRemoved,
    `${id} scratch cleanup evidence did not match the mutation`,
  );
  caught.push(id);
  return report;
}

try {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  check(fixture.schema_version === "installed-inline-xbrl-capability-probe/1.0", "fixture version drifted");
  check(fixture.expected.non_dimensioned_context_ids.length === 3, "fixture does not declare three annual authority contexts");
  check(Object.keys(fixture.expected.selected_authority).length === 2, "fixture does not cover IS and CF concepts");
  check(sha256(Buffer.from(fixture.html, "utf8")) === fixture.html_sha256, "fixture bytes are not frozen by hash");

  const positive = await run();
  check(positive.status === "PASS", `real Inline XBRL probe refused: ${positive.reason_code} ${positive.reason ?? ""}`);
  check(positive.lxml_worker_execution === "PASS", "shipped Python/lxml worker was not executed");
  check(positive.fact_count === 7, "positive probe did not extract seven facts");
  check(positive.context_count === 4, "positive probe did not parse all four contexts");
  check(positive.unit_count === 1, "positive probe did not parse exactly one unit");
  check(positive.scratch_removed === true, "positive probe retained scratch state");
  for (const field of [
    "fixture_sha256", "html_sha256", "worker_sha256", "result_schema_sha256",
    "selected_python_sha256", "result_sha256",
  ]) {
    check(/^[a-f0-9]{64}$/.test(positive[field] ?? ""), `${field} is not a bound SHA-256`);
  }
  check(
    JSON.stringify(positive.selected_non_dimensioned_authority["probe:Revenue"].map((fact) => fact.value)) ===
      JSON.stringify([100000000, 110000000, 120000000]),
    "selected revenue authority is wrong",
  );
  check(
    JSON.stringify(positive.selected_non_dimensioned_authority["probe:CashFromOperations"].map((fact) => fact.value)) ===
      JSON.stringify([20000000, 22000000, 25000000]),
    "selected cash-flow authority is wrong",
  );
  check(
    positive.quarantined_dimensioned_fact.context_ref === "DSEG2025" &&
      positive.quarantined_dimensioned_fact.value === 30000000 &&
      positive.quarantined_dimensioned_fact.dimensions["probe:SegmentAxis"] ===
        "probe:SegmentMember",
    "benign dimensioned fact was not quarantined",
  );

  const contradictoryDimension = await writeFixture("contradictory-dimension", (mutated) => {
    mutated.html = mutated.html
      .replace("probe:SegmentMember", "probe:ContradictorySegmentMember")
      .replace(">30</ix:nonFraction>", ">999</ix:nonFraction>");
    mutated.expected.dimensioned_fact.value = 999000000;
    mutated.expected.dimensioned_fact.member = "probe:ContradictorySegmentMember";
  });
  const contradiction = await run({ fixturePath: contradictoryDimension });
  check(
    contradiction.status === "PASS" &&
      contradiction.quarantined_dimensioned_fact.value === 999000000 &&
      contradiction.selected_non_dimensioned_authority["probe:Revenue"]
        .every((fact) => fact.value !== 999000000),
    "MUTATION FAILED: a contradictory test-only dimensioned fact entered selected authority",
  );
  caught.push("contradictory-dimensioned-value-quarantined");

  const selectedDimension = await writeFixture("dimensioned-selected", (mutated) => {
    mutated.html = mutated.html.replace(
      'name="probe:Revenue" contextRef="DSEG2025"',
      'name="probe:Revenue" contextRef="D2025"',
    );
  });
  await expectRefusal(
    "dimensioned-fact-selected",
    ["INLINE_XBRL_PROBE_CONTEXT_SELECTION_MISMATCH", "INLINE_XBRL_PROBE_SELECTED_AUTHORITY_MISMATCH"],
    { fixturePath: selectedDimension },
  );

  const missingFact = await writeFixture("missing-is-fact", (mutated) => {
    mutated.html = mutated.html.replace(
      /<ix:nonFraction name="probe:Revenue" contextRef="D2024"[^>]*>110<\/ix:nonFraction>/,
      "",
    );
  });
  await expectRefusal(
    "missing-income-statement-fact",
    ["INLINE_XBRL_PROBE_CARDINALITY_MISMATCH", "INLINE_XBRL_PROBE_SELECTED_AUTHORITY_MISMATCH"],
    { fixturePath: missingFact },
  );

  await expectRefusal(
    "missing-worker",
    ["INLINE_XBRL_PROBE_COMPONENT_MISSING"],
    { workerPath: path.join(scratch, "does-not-exist.py") },
  );

  const sleepyWorker = await writeWorker(
    "sleepy-worker",
    "import time\ntime.sleep(5)\n",
  );
  const timeout = await expectRefusal(
    "worker-timeout",
    ["INLINE_XBRL_PROBE_TIMEOUT"],
    { workerPath: sleepyWorker, timeoutMs: 50 },
  );
  check(timeout.detail?.timed_out === true, "timeout refusal lacks timed_out evidence");
  check(timeout.detail?.termination_verified === true, "timeout process tree was not proven terminated");
  check(Array.isArray(timeout.detail?.survivor_pids) && timeout.detail.survivor_pids.length === 0, "timeout left survivor PIDs");

  const malformedWorker = await writeWorker(
    "malformed-result-worker",
    "import pathlib,sys\nout = pathlib.Path(sys.argv[sys.argv.index('--out') + 1])\nout.write_text('{broken', encoding='utf-8')\n",
  );
  await expectRefusal(
    "malformed-worker-result",
    ["INLINE_XBRL_PROBE_RESULT_MALFORMED"],
    { workerPath: malformedWorker },
  );

  const invalidWorker = await writeWorker(
    "schema-invalid-result-worker",
    "import json,pathlib,sys\nout = pathlib.Path(sys.argv[sys.argv.index('--out') + 1])\nout.write_text(json.dumps({}), encoding='utf-8')\n",
  );
  await expectRefusal(
    "schema-invalid-worker-result",
    ["INLINE_XBRL_PROBE_RESULT_SCHEMA_INVALID"],
    { workerPath: invalidWorker },
  );

  const malformedFixture = path.join(scratch, "malformed-fixture.json");
  await fs.writeFile(malformedFixture, "{broken", "utf8");
  await expectRefusal(
    "malformed-fixture",
    ["INLINE_XBRL_PROBE_COMPONENT_MALFORMED"],
    { fixturePath: malformedFixture },
  );

  const unsealedFixture = await writeFixture("unsealed-fixture", (mutated) => {
    mutated.html = mutated.html.replace(">120</ix:nonFraction>", ">121</ix:nonFraction>");
  }, { reseal: false });
  await expectRefusal(
    "fixture-html-hash",
    ["INLINE_XBRL_PROBE_FIXTURE_HASH_MISMATCH"],
    { fixturePath: unsealedFixture },
  );

  const failingWorker = await writeWorker(
    "failing-worker",
    "raise RuntimeError('bounded probe negative')\n",
  );
  await expectRefusal(
    "worker-failure",
    ["INLINE_XBRL_PROBE_WORKER_FAILED"],
    { workerPath: failingWorker },
  );

  await expectRefusal(
    "cleanup-failure",
    ["INLINE_XBRL_PROBE_CLEANUP_FAILED"],
    { removeScratch: async () => { throw new Error("injected cleanup refusal"); } },
    { expectScratchRemoved: false },
  );

  check(caught.length === mutationIds.length, "not every declared mutation executed");
  check(caught.every((id, index) => id === mutationIds[index]), "mutation execution order drifted");
  console.log(JSON.stringify({
    status: "PASS",
    checks,
    fixture_sha256: positive.fixture_sha256,
    html_sha256: positive.html_sha256,
    worker_sha256: positive.worker_sha256,
    result_schema_sha256: positive.result_schema_sha256,
    result_sha256: positive.result_sha256,
    selected_python_sha256: positive.selected_python_sha256,
    mutations_declared: mutationIds.length,
    mutations_applied: caught.length,
    mutations_caught: caught.length,
    mutations_survived: mutationIds.length - caught.length,
    mutation_ids: mutationIds,
  }));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
