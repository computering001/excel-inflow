#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
import { resolvePythonExecutable, runProcessTree } from "./lib/process_tree.mjs";
import { ReleaseCheckpointStore } from "./lib/release_checkpoint_store.mjs";

const run = createRunner({
  name: "phase15_fault_injection_tests",
  importMetaUrl: import.meta.url,
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-phase15-faults-"));
let mutations = 0;

async function killNamedProcess(label) {
  const script = path.join(root, `${label}.mjs`);
  await fs.writeFile(script, [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });',
    'process.stdout.write(JSON.stringify({ owner: process.pid, descendant: child.pid }) + "\\n");',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  const result = await runProcessTree(process.execPath, [script], {
    timeout: 250,
    terminationGraceMs: 100,
    survivorVerificationMs: 2_000,
  });
  run.check(`${label} reaches the forced timeout`, () => {
    assert.ok(result.timed_out === true, `${label} did not reach the forced timeout`);
    return true;
  });
  run.check(`${label} process tree custody is verified`, () => {
    assert.ok(result.termination_verified === true, `${label} process tree custody was not verified`);
    return true;
  });
  run.check(`${label} leaves no orphan process`, () => {
    assert.ok((result.survivor_pids ?? []).length === 0, `${label} left an orphan process`);
    return true;
  });
  run.check(`${label} keeps bounded process evidence`, () => {
    assert.ok(/descendant/.test(result.stdout), `${label} lost bounded process evidence`);
    return true;
  });
}

try {
  await killNamedProcess("broker-extraction");
  await killNamedProcess("libreoffice");
  mutations += 2;

  const pythonRejected = await resolvePythonExecutable(path.join(root, "missing-python"), { cwd: root, timeout: 500 }).then(
    () => false,
    (error) => /Python|executable|ENOENT|available/i.test(error?.message ?? String(error)),
  );
  run.check("missing python executable is rejected", () => {
    assert.ok(pythonRejected, "missing python executable was not rejected");
    return true;
  });
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
  const cleanReusable = (await store.inspect(declaration)).reusable;
  run.check("clean checkpoint is reused", () => {
    assert.ok(cleanReusable === true, "clean checkpoint did not reuse");
    return true;
  });

  const receiptPath = store.receiptPath("emit");
  const cleanReceipt = await fs.readFile(receiptPath, "utf8");
  const corruptionCases = [
    async () => fs.writeFile(receiptPath, "{not-json"),
    async () => fs.writeFile(output, "mutated-workbook"),
    async () => fs.rm(output),
    async () => fs.writeFile(receiptPath, cleanReceipt.replace(/"receipt_hash":\s*"[a-f0-9]+"/, `"receipt_hash": "${"0".repeat(64)}"`)),
  ];
  for (const [index, corrupt] of corruptionCases.entries()) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, "sealed-workbook");
    await fs.writeFile(receiptPath, cleanReceipt);
    await corrupt();
    const inspected = await store.inspect(declaration);
    run.check(`corrupt checkpoint ${index + 1} is not reused`, () => {
      assert.ok(inspected.reusable === false, "corrupt checkpoint was reused");
      return true;
    });
    run.check(`corrupt checkpoint ${index + 1} has a classified reason`, () => {
      assert.ok((inspected.reasons ?? []).length > 0, "corrupt checkpoint had no classified reason");
      return true;
    });
  }
  mutations += corruptionCases.length;

  const wrongInput = await store.inspect({
    ...declaration,
    inputHashes: { case: "b".repeat(64) },
  });
  run.check("changed checkpoint input is not reused", () => {
    assert.ok(wrongInput.reusable === false, "changed checkpoint input was reused");
    return true;
  });
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
