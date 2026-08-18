#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePythonExecutable, runProcessTree } from "./lib/process_tree.mjs";
import { ReleaseCheckpointStore } from "./lib/release_checkpoint_store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-phase15-faults-"));
let checks = 0;
let mutations = 0;
const check = (value, message) => {
  assert.ok(value, message);
  checks += 1;
};

async function killNamedProcess(label) {
  const script = path.join(root, `${label}.mjs`);
  await fs.writeFile(script, [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "process.on(\\\"SIGTERM\\\",()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });',
    'process.stdout.write(JSON.stringify({ owner: process.pid, descendant: child.pid }) + "\\n");',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  const result = await runProcessTree(process.execPath, [script], {
    timeout: 250,
    terminationGraceMs: 100,
    survivorVerificationMs: 2_000,
  });
  check(result.timed_out === true, `${label} did not reach the forced timeout`);
  check(result.termination_verified === true, `${label} process tree custody was not verified`);
  check((result.survivor_pids ?? []).length === 0, `${label} left an orphan process`);
  check(/descendant/.test(result.stdout), `${label} lost bounded process evidence`);
}

try {
  await killNamedProcess("broker-extraction");
  await killNamedProcess("libreoffice");
  mutations += 2;

  await assert.rejects(
    () => resolvePythonExecutable(path.join(root, "missing-python"), { cwd: root, timeout: 500 }),
    /Python|executable|ENOENT|available/i,
  );
  checks += 1;
  mutations += 1;

  const runDir = path.join(root, "checkpoint-run");
  const store = await ReleaseCheckpointStore.open(runDir);
  const output = path.join(store.workDir("emit"), "model.xlsx");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, "sealed-workbook");
  const declaration = {
    checkpointId: "emit",
    recipe: "phase15-corruption/1.0",
    inputHashes: { case: "a".repeat(64) },
    outputs: { workbook: output },
  };
  await store.persist({ ...declaration, status: "success" });
  check((await store.inspect(declaration)).reusable === true, "clean checkpoint did not reuse");

  const receiptPath = store.receiptPath("emit");
  const cleanReceipt = await fs.readFile(receiptPath, "utf8");
  const corruptionCases = [
    async () => fs.writeFile(receiptPath, "{not-json"),
    async () => fs.writeFile(output, "mutated-workbook"),
    async () => fs.rm(output),
    async () => fs.writeFile(receiptPath, cleanReceipt.replace(/"receipt_hash":\s*"[a-f0-9]+"/, `"receipt_hash": "${"0".repeat(64)}"`)),
  ];
  for (const corrupt of corruptionCases) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, "sealed-workbook");
    await fs.writeFile(receiptPath, cleanReceipt);
    await corrupt();
    const inspected = await store.inspect(declaration);
    check(inspected.reusable === false, "corrupt checkpoint was reused");
    check((inspected.reasons ?? []).length > 0, "corrupt checkpoint had no classified reason");
  }
  mutations += corruptionCases.length;

  const wrongInput = await store.inspect({
    ...declaration,
    inputHashes: { case: "b".repeat(64) },
  });
  check(wrongInput.reusable === false, "changed checkpoint input was reused");
  mutations += 1;

  console.log(JSON.stringify({
    schema_version: "phase15-portable-fault-injection/1.0",
    status: "PASS",
    checks,
    mutations_rejected: mutations,
    orphan_processes: 0,
    unclassified_failures: 0,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
