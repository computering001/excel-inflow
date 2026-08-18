#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { cancelProcessTreePids } from "./lib/process_tree.mjs";
import {
  resolveRuntimeBudgetPolicy,
  RuntimeStageBudgetLedger,
  STAGE4_RUNTIME_STAGES,
} from "./lib/runtime_budget_policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
let mutations = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

let clock = 0;
const policy = resolveRuntimeBudgetPolicy({
  solver: 100,
  workbook_build: 110,
  recalculation: 120,
  validation: 130,
});
const ledger = new RuntimeStageBudgetLedger(policy, { now: () => clock });
let token = ledger.begin("solver");
clock += 60;
ledger.end(token);
token = ledger.begin("solver");
check(ledger.timeout("solver", 500) === 40, "solver child reset the cumulative budget");
clock += 40;
ledger.end(token, { outcome: "TIMEOUT", terminationVerified: true });
check(ledger.remaining("solver") === 0, "solver budget did not close independently");
for (const [stage, duration] of [["workbook_build", 20], ["recalculation", 30], ["validation", 40]]) {
  token = ledger.begin(stage);
  clock += duration;
  ledger.end(token);
}
const receipt = ledger.receipt({ requireAll: true });
check(receipt.stage_executions.length === 4, "Stage-4 receipt omitted an independent leaf budget");
check(STAGE4_RUNTIME_STAGES.every((stage) => receipt.stage_executions.some((item) => item.stage === stage)), "Stage-4 leaf names drifted");
check(receipt.status === "FAIL" && receipt.violations.some((item) => item.startsWith("nonpassing_stage:solver")), "successful delivery could ignore a timed-out leaf stage");

const child = spawn(process.execPath, ["-e", [
  "const {spawn}=require('node:child_process')",
  "spawn(process.execPath,['-e','setInterval(()=>{},1000)'])",
  "setInterval(()=>{},1000)",
].join(";")], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 150));
const cancellation = await cancelProcessTreePids([child.pid], { graceMs: 100 });
check(cancellation.verified && cancellation.survivor_pids.length === 0, "ownership cancellation retained a live descendant");
check(cancellation.targeted_pids.length >= 2, "ownership cancellation did not capture the descendant topology");

const python = process.env.EXCEL_INFLOW_TEST_PYTHON ?? process.env.PYTHON ?? "python3";
const callOrder = spawnSync(python, ["-c", [
  "import pathlib,sys",
  `sys.path.insert(0, ${JSON.stringify(HERE)})`,
  "from run_attachment_evidence_pipeline import lane_requires_execution",
  "reused={'filings': {'pipeline_status':'PASS'}, 'dcs': {'pipeline_status':'PASS'}}",
  "assert not lane_requires_execution('filings', reused)",
  "assert not lane_requires_execution('dcs', reused)",
  "assert lane_requires_execution('broker', reused)",
].join("\n")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
check(callOrder.status === 0, `broker downstream-resume call order failed: ${callOrder.stderr}`);

const pythonTreeTimeout = spawnSync(python, ["-c", [
  "import os,pathlib,sys,tempfile,time",
  `sys.path.insert(0, ${JSON.stringify(HERE)})`,
  "from run_attachment_evidence_pipeline import run",
  "root=pathlib.Path(tempfile.mkdtemp(prefix='phase5-python-tree-'))",
  "pidfile=root/'grandchild.pid'",
  "script=root/'tree.py'",
  "script.write_text(\"import pathlib,subprocess,sys,time\\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True)\\npathlib.Path(sys.argv[1]).write_text(str(p.pid))\\ntime.sleep(60)\\n\")",
  "result=run([sys.executable,str(script),str(pidfile)],timeout_seconds=1)",
  "assert result.returncode == 124",
  "grandchild=int(pidfile.read_text())",
  "try: os.kill(grandchild,0); alive=True",
  "except ProcessLookupError: alive=False",
  "assert not alive",
  "assert '\"verified\": true' in result.stderr and '\"survivor_pids\": []' in result.stderr",
].join("\n")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
check(pythonTreeTimeout.status === 0, `filings lane timeout did not terminate its process group: ${pythonTreeTimeout.stderr}`);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-phase5-"));
for (const [flag, value] of [
  ["--source-acquisition-timeout-ms", "120001"],
  ["--filing-extraction-timeout-ms", "480001"],
]) {
  const rejected = spawnSync(process.execPath, [
    path.join(HERE, "run_filings_pipeline.mjs"),
    path.join(scratch, "absent.json"),
    "--out", scratch,
    flag, value,
  ], { encoding: "utf8" });
  check(rejected.status !== 0, `${flag} accepted an aggregate or oversized timeout`);
  mutations += 1;
}
await fs.rm(scratch, { recursive: true, force: true });

console.log(JSON.stringify({ status: "PASS", checks, mutations_rejected: mutations, violations: 0 }, null, 2));
