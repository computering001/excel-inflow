#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DURABLE_DIRECTORY_SYNC_UNSUPPORTED,
  canonicalJsonBytes,
  publishDurableImmutableJson,
  publishDurableJsonGeneration,
} from "./lib/durable_artifact_generation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "durable-artifact-generation-tests-"));
let checks = 0;
const mutationIds = [
  "crash-after-alias",
  "crash-after-immutable-report",
  "crash-after-immutable-receipt",
  "crash-before-pointer",
  "short-write",
  "file-fsync-failure",
  "directory-fsync-failure",
  "temp-residue",
  "existing-byte-collision",
  "cross-process-no-clobber",
  "concurrent-same-generation",
  "concurrent-distinct-generations",
];
const caught = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function values(id) {
  return {
    report: { schema_version: "test-report/1.0", id, status: "PASS" },
    receipt: { schema_version: "test-receipt/1.0", id, report_id: id },
  };
}

async function publish(directory, id, options = {}) {
  const generation = values(id);
  return publishDurableJsonGeneration({
    directory,
    rawAliases: options.rawAliases === false ? [] : [
      { name: "runtime-doctor-report.json", value: generation.report },
      { name: "installed-capability-receipt.json", value: generation.receipt },
    ],
    immutableArtifacts: [
      { key: "report", prefix: "runtime-doctor-report-", value: generation.report },
      { key: "receipt", prefix: "installed-capability-receipt-", value: generation.receipt },
    ],
    pointerName: "host-preflight-current.json",
    pointerFactory: (immutable) => ({
      schema_version: "test-pointer/1.0",
      id,
      report_file: immutable.report.file,
      report_sha256: immutable.report.sha256,
      report_bytes: immutable.report.bytes,
      receipt_file: immutable.receipt.file,
      receipt_sha256: immutable.receipt.sha256,
      receipt_bytes: immutable.receipt.bytes,
    }),
    operations: options.operations,
    afterStage: options.afterStage,
    beforePointer: options.beforePointer,
  });
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function residues(directory) {
  return (await fs.readdir(directory).catch(() => []))
    .filter((name) => name.includes(".tmp-"));
}

function runChild(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      cwd: ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFiles(files, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await Promise.all(files.map((target) => fs.stat(target).then(() => true, () => false)));
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`child-process publisher barrier did not close: ${files.join(", ")}`);
}

async function assertPointerGeneration(directory) {
  const pointerPath = path.join(directory, "host-preflight-current.json");
  const pointer = await readJson(pointerPath);
  const reportBytes = await fs.readFile(path.join(directory, pointer.report_file));
  const receiptBytes = await fs.readFile(path.join(directory, pointer.receipt_file));
  const report = JSON.parse(reportBytes);
  const receipt = JSON.parse(receiptBytes);
  check(digest(reportBytes) === pointer.report_sha256, "pointer report hash does not bind bytes");
  check(digest(receiptBytes) === pointer.receipt_sha256, "pointer receipt hash does not bind bytes");
  check(reportBytes.length === pointer.report_bytes, "pointer report size does not bind bytes");
  check(receiptBytes.length === pointer.receipt_bytes, "pointer receipt size does not bind bytes");
  check(report.id === pointer.id && receipt.id === pointer.id, "pointer mixed two generation identities");
  return pointer;
}

try {
  check(
    JSON.stringify(DURABLE_DIRECTORY_SYNC_UNSUPPORTED) ===
      JSON.stringify(["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]),
    "directory-fsync unsupported set widened or drifted",
  );

  const positiveRoot = path.join(scratch, "positive");
  const renameOrder = [];
  const positive = await publish(positiveRoot, "generation-a", {
    operations: {
      rename: async (source, target) => {
        await fs.rename(source, target);
        renameOrder.push(path.basename(target));
      },
    },
  });
  check(renameOrder.at(-1) === "host-preflight-current.json", "pointer was not the final rename");
  check(
    renameOrder.indexOf("runtime-doctor-report.json") < renameOrder.indexOf("host-preflight-current.json") &&
      renameOrder.indexOf("installed-capability-receipt.json") < renameOrder.indexOf("host-preflight-current.json"),
    "raw compatibility aliases published after the authoritative pointer",
  );
  check(positive.aliases.length === 2, "positive generation omitted raw aliases");
  check(Object.keys(positive.immutable).length === 2, "positive generation omitted immutable objects");
  await assertPointerGeneration(positiveRoot);
  check((await residues(positiveRoot)).length === 0, "positive generation retained temp files");
  check(
    (await fs.readFile(path.join(positiveRoot, positive.immutable.report.file))).equals(
      canonicalJsonBytes(values("generation-a").report),
    ),
    "immutable report bytes are not canonical JSON",
  );

  const aliaslessRoot = path.join(scratch, "aliasless");
  const aliasless = await publish(aliaslessRoot, "aliasless", { rawAliases: false });
  check(aliasless.aliases.length === 0, "aliasless integration route manufactured aliases");
  await assertPointerGeneration(aliaslessRoot);

  const crashRoot = path.join(scratch, "crash");
  await publish(crashRoot, "old");
  const oldPointer = await fs.readFile(path.join(crashRoot, "host-preflight-current.json"));
  const stageCrashes = [
    [
      "crash-after-alias",
      (event) => event.stage === "alias_published" && event.name === "runtime-doctor-report.json",
    ],
    [
      "crash-after-immutable-report",
      (event) => event.stage === "immutable_published" && event.key === "report",
    ],
    [
      "crash-after-immutable-receipt",
      (event) => event.stage === "immutable_published" && event.key === "receipt",
    ],
  ];
  for (const [id, shouldCrash] of stageCrashes) {
    let boundaryCaught = false;
    try {
      await publish(crashRoot, id, {
        afterStage: async (event) => {
          if (!shouldCrash(event)) return;
          const error = new Error(`injected ${id}`);
          error.code = "INJECTED_STAGE_CRASH";
          throw error;
        },
      });
    } catch (error) {
      boundaryCaught = error.code === "INJECTED_STAGE_CRASH";
    }
    check(boundaryCaught, `${id} injection did not execute`);
    check(
      (await fs.readFile(path.join(crashRoot, "host-preflight-current.json"))).equals(oldPointer),
      `${id} exposed a partial generation through the authoritative pointer`,
    );
    await assertPointerGeneration(crashRoot);
    check((await residues(crashRoot)).length === 0, `${id} retained temp files`);
    caught.push(id);
  }
  let crashed = false;
  try {
    await publish(crashRoot, "new", {
      beforePointer: async () => {
        const error = new Error("injected crash before pointer");
        error.code = "INJECTED_CRASH";
        throw error;
      },
    });
  } catch (error) {
    crashed = error.code === "INJECTED_CRASH";
  }
  check(crashed, "crash-before-pointer injection did not execute");
  check(
    (await fs.readFile(path.join(crashRoot, "host-preflight-current.json"))).equals(oldPointer),
    "crash before pointer exposed a partial generation",
  );
  await assertPointerGeneration(crashRoot);
  check((await residues(crashRoot)).length === 0, "crash path retained temp files");
  caught.push("crash-before-pointer");

  const shortRoot = path.join(scratch, "short-write");
  let shortCaught = false;
  try {
    await publish(shortRoot, "short", {
      rawAliases: false,
      operations: { writeChunk: async () => ({ bytesWritten: 0 }) },
    });
  } catch (error) {
    shortCaught = error.code === "DURABLE_ARTIFACT_SHORT_WRITE";
  }
  check(shortCaught, "zero-byte short write was accepted");
  check((await residues(shortRoot)).length === 0, "short-write failure retained temp files");
  check(!(await fs.stat(path.join(shortRoot, "host-preflight-current.json")).then(() => true, () => false)), "short write published a pointer");
  caught.push("short-write");

  const fileSyncRoot = path.join(scratch, "file-fsync");
  let fileSyncCaught = false;
  try {
    await publish(fileSyncRoot, "file-fsync", {
      rawAliases: false,
      operations: {
        syncFile: async () => {
          const error = new Error("injected file fsync failure");
          error.code = "EIO";
          throw error;
        },
      },
    });
  } catch (error) {
    fileSyncCaught = error.code === "EIO";
  }
  check(fileSyncCaught, "file fsync failure was accepted");
  check((await residues(fileSyncRoot)).length === 0, "file fsync failure retained temp files");
  caught.push("file-fsync-failure");

  const directorySyncRoot = path.join(scratch, "directory-fsync");
  let directorySyncCaught = false;
  try {
    await publish(directorySyncRoot, "directory-fsync", {
      rawAliases: false,
      operations: {
        syncDirectory: async () => {
          const error = new Error("injected directory fsync failure");
          error.code = "EIO";
          throw error;
        },
      },
    });
  } catch (error) {
    directorySyncCaught = error.code === "EIO";
  }
  check(directorySyncCaught, "real directory fsync failure was tolerated");
  check((await residues(directorySyncRoot)).length === 0, "directory fsync failure retained temp files");
  check(!(await fs.stat(path.join(directorySyncRoot, "host-preflight-current.json")).then(() => true, () => false)), "directory fsync failure published a pointer");
  caught.push("directory-fsync-failure");

  const unsupportedRoot = path.join(scratch, "directory-fsync-unsupported");
  await publish(unsupportedRoot, "unsupported", {
    rawAliases: false,
    operations: {
      syncDirectory: async () => {
        const error = new Error("platform does not support directory fsync");
        error.code = "EINVAL";
        throw error;
      },
    },
  });
  await assertPointerGeneration(unsupportedRoot);
  check((await residues(unsupportedRoot)).length === 0, "unsupported directory fsync path retained temp files");

  const residueRoot = path.join(scratch, "temp-residue");
  let residueCaught = false;
  try {
    await publish(residueRoot, "residue", {
      rawAliases: false,
      operations: {
        syncFile: async () => {
          const error = new Error("force staging cleanup");
          error.code = "EIO";
          throw error;
        },
        remove: async () => {},
      },
    });
  } catch (error) {
    residueCaught = error.code === "DURABLE_ARTIFACT_TEMP_RESIDUE";
  }
  check(residueCaught, "staging residue was not elevated to a typed refusal");
  check((await residues(residueRoot)).length === 1, "temp-residue injection did not leave the evidence it claims");
  await fs.rm(residueRoot, { recursive: true, force: true });
  caught.push("temp-residue");

  const collisionRoot = path.join(scratch, "collision");
  await fs.mkdir(collisionRoot, { recursive: true });
  const collisionValue = { schema_version: "collision/1.0", value: "expected" };
  const collisionHash = digest(canonicalJsonBytes(collisionValue));
  const collisionTarget = path.join(collisionRoot, `artifact-${collisionHash}.json`);
  const conflictingBytes = Buffer.from('{"different":true}\n', "utf8");
  await fs.writeFile(collisionTarget, conflictingBytes);
  let collisionCaught = false;
  try {
    await publishDurableImmutableJson({ target: collisionTarget, value: collisionValue });
  } catch (error) {
    collisionCaught = error.code === "DURABLE_ARTIFACT_IMMUTABLE_COLLISION";
  }
  check(collisionCaught, "different bytes at an immutable content address were overwritten");
  check((await fs.readFile(collisionTarget)).equals(conflictingBytes), "collision changed pre-existing immutable bytes");
  caught.push("existing-byte-collision");

  const crossRoot = path.join(scratch, "cross-process");
  await fs.mkdir(crossRoot, { recursive: true });
  const crossTarget = path.join(crossRoot, `artifact-${"0".repeat(64)}.json`);
  const go = path.join(crossRoot, "go");
  const markerA = path.join(crossRoot, "ready-a");
  const markerB = path.join(crossRoot, "ready-b");
  const moduleUrl = pathToFileURL(path.join(ROOT, "scripts", "lib", "durable_artifact_generation.mjs")).href;
  const childSource = String.raw`
import fs from "node:fs/promises";
const [moduleUrl,target,marker,go,id] = process.argv.slice(1);
const {publishDurableImmutableJson} = await import(moduleUrl);
let result;
try {
  const published = await publishDurableImmutableJson({
    target,
    value: {schema_version:"cross-process/1.0",id},
    operations: {
      link: async (source,destination) => {
        await fs.writeFile(marker,id);
        for (let attempt=0; attempt<1000; attempt+=1) {
          if (await fs.stat(go).then(()=>true,()=>false)) break;
          await new Promise((resolve)=>setTimeout(resolve,5));
        }
        return fs.link(source,destination);
      },
    },
  });
  result = {status:"PUBLISHED",created:published.created,id};
} catch (error) {
  result = {status:"REFUSED",code:error.code,id};
}
process.stdout.write(JSON.stringify(result)+"\n");
`;
  const childA = runChild(childSource, [moduleUrl, crossTarget, markerA, go, "a"]);
  const childB = runChild(childSource, [moduleUrl, crossTarget, markerB, go, "b"]);
  await waitForFiles([markerA, markerB]);
  await fs.writeFile(go, "go\n");
  const childResults = await Promise.all([childA, childB]);
  check(childResults.every((result) => result.code === 0), `cross-process publishers broke: ${JSON.stringify(childResults)}`);
  const outcomes = childResults.map((result) => JSON.parse(result.stdout.trim()));
  check(outcomes.filter((result) => result.status === "PUBLISHED" && result.created === true).length === 1, "cross-process no-replace had other than one winner");
  check(outcomes.filter((result) => result.code === "DURABLE_ARTIFACT_IMMUTABLE_COLLISION").length === 1, "cross-process loser did not return typed collision");
  const winningId = outcomes.find((result) => result.status === "PUBLISHED").id;
  check(JSON.parse(await fs.readFile(crossTarget, "utf8")).id === winningId, "winning immutable bytes changed after cross-process collision");
  check((await residues(crossRoot)).length === 0, "cross-process no-replace retained temp files");
  caught.push("cross-process-no-clobber");

  const concurrentSameRoot = path.join(scratch, "concurrent-same");
  const same = await Promise.all(
    Array.from({ length: 12 }, () => publish(concurrentSameRoot, "same", { rawAliases: false })),
  );
  check(same.length === 12, "concurrent same-generation publishers did not all close");
  check(new Set(same.map((item) => item.immutable.report.file)).size === 1, "same generation produced multiple report addresses");
  check(new Set(same.map((item) => item.immutable.receipt.file)).size === 1, "same generation produced multiple receipt addresses");
  await assertPointerGeneration(concurrentSameRoot);
  check((await residues(concurrentSameRoot)).length === 0, "concurrent same generation retained temp files");
  caught.push("concurrent-same-generation");

  const concurrentDistinctRoot = path.join(scratch, "concurrent-distinct");
  await Promise.all([
    publish(concurrentDistinctRoot, "distinct-a"),
    publish(concurrentDistinctRoot, "distinct-b"),
  ]);
  const selected = await assertPointerGeneration(concurrentDistinctRoot);
  check(["distinct-a", "distinct-b"].includes(selected.id), "concurrent pointer selected no complete generation");
  check((await residues(concurrentDistinctRoot)).length === 0, "concurrent distinct generations retained temp files");
  caught.push("concurrent-distinct-generations");

  check(caught.length === mutationIds.length, "not every declared durable-publication mutation executed");
  check(caught.every((id, index) => id === mutationIds[index]), "durable-publication mutation order drifted");
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    mutations_declared: mutationIds.length,
    mutations_applied: caught.length,
    mutations_caught: caught.length,
    mutations_survived: mutationIds.length - caught.length,
    mutation_ids: caught,
    semantics: {
      raw_aliases: "non_authoritative_before_pointer_or_omitted",
      immutable: "compare_or_create_never_replace_different_bytes",
      pointer: "atomic_durable_final_publication",
      directory_sync_unsupported: DURABLE_DIRECTORY_SYNC_UNSUPPORTED,
    },
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
