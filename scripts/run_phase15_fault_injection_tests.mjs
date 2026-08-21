#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
import { resolvePythonExecutable, runProcessTree } from "./lib/process_tree.mjs";
import { ReleaseCheckpointStore } from "./lib/release_checkpoint_store.mjs";

const run = createRunner({ name: "phase15_fault_injection_tests", importMetaUrl: import.meta.url });

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-phase15-faults-"));
let mutations = 0;

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
  run.ok(result.timed_out === true, `${label} did not reach the forced timeout`);
  run.ok(result.termination_verified === true, `${label} process tree custody was not verified`);
  run.ok((result.survivor_pids ?? []).length === 0, `${label} left an orphan process`);
  run.match(result.stdout, /descendant/, `${label} lost bounded process evidence`);
}

try {
  await killNamedProcess("broker-extraction");
  await killNamedProcess("libreoffice");
  mutations += 2;

  try {
    await resolvePythonExecutable(path.join(root, "missing-python"), { cwd: root, timeout: 500 });
    run.ok(false, "a missing python executable resolved without error");
  } catch (error) {
    run.match(String(error?.message ?? error), /Python|executable|ENOENT|available/i, "a missing python executable failed with a classified error");
  }
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
  run.ok((await store.inspect(declaration)).reusable === true, "clean checkpoint did not reuse");

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
    run.ok(inspected.reusable === false, "corrupt checkpoint was reused");
    run.ok((inspected.reasons ?? []).length > 0, "corrupt checkpoint had no classified reason");
  }
  mutations += corruptionCases.length;

  const wrongInput = await store.inspect({
    ...declaration,
    inputHashes: { case: "b".repeat(64) },
  });
  run.ok(wrongInput.reusable === false, "changed checkpoint input was reused");
  mutations += 1;

  run.finish({
    schema_version: "phase15-portable-fault-injection/1.0",
    mutations_rejected: mutations,
    orphan_processes: 0,
    unclassified_failures: 0,
  });
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
