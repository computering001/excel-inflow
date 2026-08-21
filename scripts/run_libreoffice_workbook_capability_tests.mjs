#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  generateDeterministicWorkbookFixture,
  probeLibreOfficeWorkbookCapability,
} from "./lib/libreoffice_workbook_capability.mjs";
import { resolvePythonExecutable, runProcessTree } from "./lib/process_tree.mjs";

const [pythonArgument, sofficeArgument] = process.argv.slice(2);
const python = await resolvePythonExecutable(
  pythonArgument ?? process.env.EXCEL_INFLOW_TEST_PYTHON ?? process.env.EXCEL_INFLOW_PYTHON ?? "python3",
);
const sofficeInput = sofficeArgument ?? process.env.SOFFICE_BIN;
if (!sofficeInput || !path.isAbsolute(sofficeInput)) {
  throw new Error(
    "usage: run_libreoffice_workbook_capability_tests.mjs <absolute-python> <absolute-soffice> " +
    "(or set EXCEL_INFLOW_TEST_PYTHON and SOFFICE_BIN)",
  );
}
const soffice = await fs.realpath(sofficeInput);

let checks = 0;
const mutations = [];
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function fileSha(target) {
  return sha256(await fs.readFile(target));
}
function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const versionProbe = await runProcessTree(soffice, ["--version"], { timeout: 15_000 });
if (!versionProbe.ok) {
  throw new Error(`selected soffice did not answer --version: ${versionProbe.stderr}`);
}
const sofficeVersion = (versionProbe.stdout.trim() || versionProbe.stderr.trim())
  .split(/\r?\n/)[0];
const sofficeSha256 = await fileSha(soffice);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "libreoffice-capability-tests-"));
const EXPECTED_FIXTURE_SHA256 =
  "3e0c92a6c11d7da3a8dd7e293c4e9951af033c393a421647e2ef5b3d130c7da5";

const FAKE_SOFFICE = String.raw`#!__PYTHON__
import os, pathlib, shutil, signal, subprocess, sys, time, urllib.parse, zipfile
import xml.etree.ElementTree as ET

if '--version' in sys.argv:
    print('LibreOffice Fake Version-Only 1.0')
    raise SystemExit(0)
mode = os.environ.get('FAKE_SOFFICE_MODE', 'version-only')
if mode == 'version-only':
    raise SystemExit(2)
profile_arg = next((arg for arg in sys.argv if arg.startswith('-env:UserInstallation=')), None)
if profile_arg:
    uri = profile_arg.split('=', 1)[1]
    profile = pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(uri).path))
    profile.mkdir(parents=True, exist_ok=True)
    (profile / 'fake-profile-state').write_text(mode, encoding='utf-8')
if mode == 'hang':
    child = subprocess.Popen([
        sys.executable, '-c',
        "import signal,time; signal.signal(signal.SIGTERM,lambda *a:None); time.sleep(3600)",
    ], start_new_session=True)
    print('DESCENDANT_PID=' + str(child.pid), flush=True)
    signal.signal(signal.SIGTERM, lambda *args: None)
    while True:
        time.sleep(1)
if mode == 'no-output':
    raise SystemExit(0)
outdir = pathlib.Path(sys.argv[sys.argv.index('--outdir') + 1])
source = pathlib.Path(sys.argv[-1])
target = outdir / source.name
cached = '999' if mode == 'wrong-result' else '12.5'
namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
with zipfile.ZipFile(source, 'r') as incoming, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as outgoing:
    for info in incoming.infolist():
        data = incoming.read(info.filename)
        if info.filename == 'xl/worksheets/sheet1.xml':
            root = ET.fromstring(data)
            cell = root.find('.//{' + namespace + '}c[@r="B1"]')
            value = cell.find('{' + namespace + '}v')
            if value is None:
                value = ET.SubElement(cell, '{' + namespace + '}v')
            value.text = cached
            data = ET.tostring(root, encoding='utf-8', xml_declaration=False)
        outgoing.writestr(info, data)
if mode == 'stale-output':
    os.utime(target, (1, 1))
if mode == 'success-orphan':
    child = subprocess.Popen([
        sys.executable, '-c', 'import time; time.sleep(3600)',
    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
       stderr=subprocess.DEVNULL, start_new_session=True)
    print('DESCENDANT_PID=' + str(child.pid), flush=True)
    time.sleep(0.15)
`;

try {
  // The input workbook itself is deterministic even though LibreOffice's
  // output package may carry producer-assigned metadata.
  const fixtureAPath = path.join(scratch, "fixture-a", "fixture.xlsx");
  const fixtureBPath = path.join(scratch, "fixture-b", "fixture.xlsx");
  const fixtureA = await generateDeterministicWorkbookFixture({
    pythonExecutable: python,
    target: fixtureAPath,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const fixtureB = await generateDeterministicWorkbookFixture({
    pythonExecutable: python,
    target: fixtureBPath,
  });
  check(
    fixtureA.sha256 === fixtureB.sha256 && fixtureA.bytes === fixtureB.bytes,
    "the generated LibreOffice capability fixture is not byte-deterministic",
  );
  check(
    fixtureA.sha256 === EXPECTED_FIXTURE_SHA256,
    `the fixture drifted from its independently sealed OOXML hash: ${fixtureA.sha256}`,
  );
  const childFixturePath = path.join(scratch, "fixture-child", "fixture.xlsx");
  const fixtureModuleUrl = new URL("./lib/libreoffice_workbook_capability.mjs", import.meta.url).href;
  const childSource = [
    `const { generateDeterministicWorkbookFixture } = await import(${JSON.stringify(fixtureModuleUrl)});`,
    `const result = await generateDeterministicWorkbookFixture({ pythonExecutable: ${JSON.stringify(python)}, target: ${JSON.stringify(childFixturePath)} });`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const childFixtureProcess = await runProcessTree(
    process.execPath,
    ["--input-type=module", "--eval", childSource],
    { timeout: 30_000 },
  );
  const childFixture = childFixtureProcess.ok
    ? JSON.parse(childFixtureProcess.stdout)
    : null;
  check(
    childFixtureProcess.ok === true &&
      childFixture?.sha256 === EXPECTED_FIXTURE_SHA256 &&
      childFixture?.sha256 === fixtureA.sha256 &&
      childFixture?.bytes === fixtureA.bytes,
    "a separate Node process did not reproduce the sealed deterministic fixture bytes",
  );
  const mutatedFixtureBytes = Buffer.from(await fs.readFile(fixtureAPath));
  mutatedFixtureBytes[mutatedFixtureBytes.length - 1] ^= 0x01;
  check(
    sha256(mutatedFixtureBytes) !== EXPECTED_FIXTURE_SHA256,
    "MUTATION FAILED: a one-byte fixture change retained the sealed fixture hash",
  );
  mutations.push("fixture_byte_mutation_changes_exact_hash");
  check(
    fixtureA.formula === "=SUM(A1:A3)" && fixtureA.expected_result === 12.5,
    "the deterministic fixture does not bind the known formula/result",
  );

  const real = await probeLibreOfficeWorkbookCapability({
    sofficeExecutable: soffice,
    sofficeVersion,
    sofficeSha256,
    pythonExecutable: python,
    scratchRoot: scratch,
    timeoutMs: 60_000,
  });
  check(real.status === "PASS" && real.failure === null, `real LibreOffice capability failed: ${real.failure}`);
  check(
    real.soffice.observed_sha256 === sofficeSha256 &&
    real.fixture.sha256 === fixtureA.sha256 &&
    real.output?.cached_result === 12.5 &&
    real.output?.formula === "=SUM(A1:A3)",
    "real capability did not bind executable, deterministic fixture and cached result",
  );
  check(
    real.process?.ok === true && real.inspection_process?.ok === true &&
    real.cleanup.profile_removed === true && real.cleanup.fixture_removed === true &&
    real.cleanup.output_removed === true && real.cleanup.workspace_removed === true &&
    real.cleanup.residue_paths.length === 0,
    "real capability did not close both processes and all isolated artifacts",
  );

  const fakeSoffice = path.join(scratch, "fake-soffice");
  await fs.writeFile(
    fakeSoffice,
    FAKE_SOFFICE.replace("__PYTHON__", python),
    { mode: 0o700 },
  );
  const fakeSha256 = await fileSha(fakeSoffice);
  const fakeVersion = await runProcessTree(fakeSoffice, ["--version"], { timeout: 5_000 });
  check(fakeVersion.ok && fakeVersion.stdout.includes("Version-Only"), "fake version-only binary is not a valid version probe");

  const runFake = (mode, overrides = {}) => probeLibreOfficeWorkbookCapability({
    sofficeExecutable: fakeSoffice,
    sofficeVersion: "LibreOffice Fake Version-Only 1.0",
    sofficeSha256: fakeSha256,
    pythonExecutable: python,
    scratchRoot: scratch,
    // Keep fixture generation independently bounded at ten seconds.  The
    // 400 ms mutation applies only to the fake hung soffice process; applying
    // it to Python/openpyxl made host load look like failed tree termination.
    timeoutMs: 10_000,
    runner: mode === "hang"
      ? (binary, args, options = {}) => runProcessTree(binary, args, {
          ...options,
          timeout: binary === fakeSoffice ? 400 : options.timeout,
        })
      : runProcessTree,
    env: { ...process.env, FAKE_SOFFICE_MODE: mode },
    ...overrides,
  });

  const versionOnly = await runFake("version-only");
  check(
    versionOnly.status === "FAIL" && versionOnly.process?.ok === false &&
    versionOnly.output === null,
    "MUTATION FAILED: a --version-only binary satisfied functional workbook capability",
  );
  mutations.push("version_only_binary_refused");

  const noOutput = await runFake("no-output");
  check(
    noOutput.status === "FAIL" && noOutput.process?.ok === true &&
    noOutput.failure.includes("produced no output workbook"),
    "MUTATION FAILED: exit zero with no workbook was admitted",
  );
  mutations.push("no_output_refused");

  const wrongResult = await runFake("wrong-result");
  check(
    wrongResult.status === "FAIL" && wrongResult.output?.cached_result === 999 &&
    wrongResult.failure.includes("did not retain"),
    "MUTATION FAILED: the wrong cached formula result was admitted",
  );
  mutations.push("wrong_formula_result_refused");

  const hung = await runFake("hang");
  const descendantPid = Number(/DESCENDANT_PID=(\d+)/.exec(hung.process?.stdout_tail ?? "")?.[1]);
  check(
    hung.status === "FAIL" && hung.process?.timed_out === true &&
    hung.process?.termination_verified === true && hung.process?.survivor_pids.length === 0 &&
    Number.isInteger(descendantPid) && hung.process.terminated_pids.includes(descendantPid) &&
    !processIsLive(descendantPid),
    "MUTATION FAILED: a hung LibreOffice tree survived or was reported as capability: " +
      JSON.stringify({
        descendantPid,
        status: hung.status,
        failure: hung.failure,
        process: hung.process,
        cleanup: hung.cleanup,
      }),
  );
  mutations.push("hung_process_tree_terminated");

  const successOrphan = await runFake("success-orphan");
  const successOrphanPid = Number(
    /DESCENDANT_PID=(\d+)/.exec(successOrphan.process?.stdout_tail ?? "")?.[1],
  );
  check(
    successOrphan.status === "PASS" && successOrphan.process?.ok === true &&
    successOrphan.process?.termination_verified === true &&
    Number.isInteger(successOrphanPid) &&
    successOrphan.process.terminated_pids.includes(successOrphanPid) &&
    successOrphan.process.survivor_pids.length === 0 &&
    !processIsLive(successOrphanPid),
    "MUTATION FAILED: a detached child survived a successful LibreOffice launcher",
  );
  mutations.push("successful_launcher_detached_child_terminated");

  const stale = await runFake("stale-output");
  check(
    stale.status === "FAIL" && stale.failure.includes("predates this launch and is stale"),
    "MUTATION FAILED: a stale workbook was accepted as this invocation's output",
  );
  mutations.push("stale_output_refused");

  const profileResidue = await runFake("functional", {
    operations: {
      removePath: async (target) => {
        if (path.basename(target) === "profile") throw new Error("injected profile cleanup failure");
        await fs.rm(target, { recursive: true, force: true });
      },
    },
  });
  check(
    profileResidue.status === "FAIL" && profileResidue.cleanup.profile_removed === false &&
    profileResidue.cleanup.residue_paths.includes("profile") &&
    profileResidue.failure.includes("cleanup failed"),
    "MUTATION FAILED: profile residue was rounded into a capability pass",
  );
  mutations.push("profile_residue_refused");

  const identityMismatch = await probeLibreOfficeWorkbookCapability({
    sofficeExecutable: fakeSoffice,
    sofficeVersion: "LibreOffice Fake Version-Only 1.0",
    sofficeSha256: "0".repeat(64),
    pythonExecutable: python,
    scratchRoot: scratch,
  });
  check(
    identityMismatch.status === "FAIL" && identityMismatch.failure.includes("do not match"),
    "MUTATION FAILED: functional capability did not bind the caller-supplied soffice identity",
  );
  mutations.push("soffice_byte_identity_mismatch_refused");

  const liveProbeResidue = (await fs.readdir(scratch))
    .filter((name) => name.startsWith("excel-inflow-lo-capability-"));
  check(liveProbeResidue.length === 0, "LibreOffice capability tests left live probe workspaces");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    mutations_declared: mutations.length,
    mutations_applied: mutations.length,
    mutations_caught: mutations.length,
    mutations_survived: 0,
    fixture_sha256: fixtureA.sha256,
    real_output_sha256: real.output.sha256,
    soffice_version: sofficeVersion,
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
