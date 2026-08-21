/**
 * Functional LibreOffice workbook capability probe.
 *
 * This module deliberately does not resolve executables or own compatibility
 * policy. Its caller supplies one already-selected absolute Python and soffice
 * executable plus the soffice version/hash identity it has established.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runProcessTree } from "./process_tree.mjs";

export const LIBREOFFICE_WORKBOOK_CAPABILITY_VERSION =
  "libreoffice-workbook-capability/1.0";

const FIXTURE_NAME = "excel-inflow-libreoffice-capability.xlsx";
const EXPECTED_FORMULA = "=SUM(A1:A3)";
const EXPECTED_RESULT = 12.5;

const GENERATE_FIXTURE = String.raw`
import datetime, os, pathlib, re, sys, zipfile
from openpyxl import Workbook

target = pathlib.Path(sys.argv[1])
raw = target.with_suffix('.raw.xlsx')
book = Workbook()
sheet = book.active
sheet.title = 'Capability'
sheet['A1'] = 7
sheet['A2'] = 3
sheet['A3'] = 2.5
sheet['B1'] = '=SUM(A1:A3)'
book.calculation.calcMode = 'auto'
book.calculation.fullCalcOnLoad = True
book.calculation.forceFullCalc = True
fixed = datetime.datetime(2000, 1, 1, 0, 0, 0)
book.properties.created = fixed
book.properties.modified = fixed
book.properties.creator = 'Excel Inflow capability probe'
book.properties.lastModifiedBy = 'Excel Inflow capability probe'
book.save(raw)
with zipfile.ZipFile(raw, 'r') as source, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for name in sorted(source.namelist()):
        data = source.read(name)
        if name == 'docProps/core.xml':
            data = re.sub(
                rb'(<dcterms:modified[^>]*>)[^<]+',
                rb'\g<1>2000-01-01T00:00:00Z',
                data,
            )
        info = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o600 << 16
        info.create_system = 3
        output.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
raw.unlink()
`;

const INSPECT_RESULT = String.raw`
import json, pathlib, sys
from openpyxl import load_workbook

target = pathlib.Path(sys.argv[1])
formulas = load_workbook(target, read_only=True, data_only=False)
values = load_workbook(target, read_only=True, data_only=True)
try:
    print(json.dumps({
        'sheet_names': formulas.sheetnames,
        'formula': formulas['Capability']['B1'].value,
        'cached_result': values['Capability']['B1'].value,
    }, sort_keys=True))
finally:
    formulas.close()
    values.close()
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(target) {
  const bytes = await fs.readFile(target);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function processEvidence(result) {
  return {
    ok: result?.ok === true,
    code: Number.isInteger(result?.code) ? result.code : null,
    signal: result?.signal ?? null,
    killed: result?.killed === true,
    timed_out: result?.timed_out === true,
    termination_verified: result?.termination_verified ?? null,
    terminated_pids: result?.terminated_pids ?? [],
    survivor_pids: result?.survivor_pids ?? [],
    error_code: result?.error_code ?? null,
    stdout_tail: String(result?.stdout ?? "").slice(-2000),
    stderr_tail: String(result?.stderr ?? "").slice(-2000),
  };
}

export async function generateDeterministicWorkbookFixture({
  pythonExecutable,
  target,
  timeoutMs = 30_000,
  runner = runProcessTree,
} = {}) {
  const python = path.resolve(String(pythonExecutable));
  const output = path.resolve(String(target));
  if (!path.isAbsolute(String(pythonExecutable))) {
    throw new Error("selected Python executable must be absolute");
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.rm(output, { force: true });
  const generated = await runner(python, ["-c", GENERATE_FIXTURE, output], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!generated.ok) {
    throw new Error(
      `selected Python/openpyxl did not generate the deterministic workbook fixture ` +
      `(${generated.error_code ?? `exit ${generated.code}`}: ${generated.stderr || generated.stdout})`,
    );
  }
  const identity = await hashFile(output);
  return Object.freeze({
    path: output,
    ...identity,
    formula: EXPECTED_FORMULA,
    expected_result: EXPECTED_RESULT,
    generator_process: Object.freeze(processEvidence(generated)),
  });
}

/**
 * Return PASS or a typed FAIL; ordinary host incapability never escapes as an
 * exception. Test-only operation injection is used solely to prove cleanup
 * failures cannot be rounded into a pass.
 */
export async function probeLibreOfficeWorkbookCapability({
  sofficeExecutable,
  sofficeVersion,
  sofficeSha256,
  pythonExecutable,
  scratchRoot,
  timeoutMs = 60_000,
  env = process.env,
  runner = runProcessTree,
  operations = {},
} = {}) {
  const removePath = operations.removePath ??
    ((target) => fs.rm(target, { recursive: true, force: true }));
  const result = {
    schema_version: LIBREOFFICE_WORKBOOK_CAPABILITY_VERSION,
    status: "FAIL",
    reason_code: "LIBREOFFICE_WORKBOOK_CAPABILITY_UNPROVEN",
    failure: null,
    expected: {
      sheet: "Capability",
      cell: "B1",
      formula: EXPECTED_FORMULA,
      cached_result: EXPECTED_RESULT,
    },
    soffice: {
      executable: sofficeExecutable ?? null,
      version: sofficeVersion ?? null,
      supplied_sha256: sofficeSha256 ?? null,
      observed_sha256: null,
    },
    python: { executable: pythonExecutable ?? null },
    fixture: null,
    output: null,
    process: null,
    inspection_process: null,
    cleanup: {
      profile_removed: false,
      fixture_removed: false,
      output_removed: false,
      workspace_removed: false,
      residue_paths: [],
    },
  };
  let workspace = null;
  let profileRoot = null;
  let fixtureRoot = null;
  let outputRoot = null;
  try {
    for (const [label, value] of [
      ["selected soffice executable", sofficeExecutable],
      ["selected Python executable", pythonExecutable],
      ["scratch root", scratchRoot],
    ]) {
      if (typeof value !== "string" || !path.isAbsolute(value)) {
        throw new Error(`${label} must be an absolute path`);
      }
    }
    if (typeof sofficeVersion !== "string" || sofficeVersion.trim() === "") {
      throw new Error("the caller did not supply the selected soffice version identity");
    }
    if (!/^[a-f0-9]{64}$/.test(String(sofficeSha256 ?? ""))) {
      throw new Error("the caller did not supply a valid selected soffice SHA-256 identity");
    }
    const [sofficeStat, pythonStat, scratchStat] = await Promise.all([
      fs.stat(sofficeExecutable),
      fs.stat(pythonExecutable),
      fs.stat(scratchRoot),
    ]);
    if (!sofficeStat.isFile() || !pythonStat.isFile() || !scratchStat.isDirectory()) {
      throw new Error("selected executables must be files and scratch root must be a directory");
    }
    result.soffice.observed_sha256 = (await hashFile(sofficeExecutable)).sha256;
    if (result.soffice.observed_sha256 !== sofficeSha256) {
      throw new Error("the selected soffice executable bytes do not match the supplied identity");
    }

    workspace = await fs.mkdtemp(path.join(scratchRoot, "excel-inflow-lo-capability-"));
    profileRoot = path.join(workspace, "profile");
    fixtureRoot = path.join(workspace, "fixture");
    outputRoot = path.join(workspace, "output");
    await Promise.all([
      fs.mkdir(profileRoot),
      fs.mkdir(fixtureRoot),
      fs.mkdir(outputRoot),
    ]);
    const fixturePath = path.join(fixtureRoot, FIXTURE_NAME);
    const fixture = await generateDeterministicWorkbookFixture({
      pythonExecutable,
      target: fixturePath,
      timeoutMs: Math.min(timeoutMs, 30_000),
      runner,
    });
    result.fixture = {
      bytes: fixture.bytes,
      sha256: fixture.sha256,
      formula: fixture.formula,
      expected_result: fixture.expected_result,
    };

    const outputPath = path.join(outputRoot, FIXTURE_NAME);
    if (await exists(outputPath)) {
      throw new Error("a stale output workbook existed before LibreOffice launch");
    }
    const launchedAt = Date.now();
    const profileUrl = pathToFileURL(profileRoot).href;
    const converted = await runner(sofficeExecutable, [
      "--headless",
      "--nologo",
      "--nodefault",
      "--nofirststartwizard",
      `-env:UserInstallation=${profileUrl}`,
      "--convert-to", "xlsx",
      "--outdir", outputRoot,
      fixturePath,
    ], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env,
      terminateDescendantsOnSuccess: true,
    });
    result.process = processEvidence(converted);
    if (!converted.ok) {
      throw new Error(
        converted.timed_out
          ? "LibreOffice workbook capability timed out and its process tree was terminated"
          : `LibreOffice did not calculate and save the fixture (${converted.error_code ?? `exit ${converted.code}`})`,
      );
    }
    if (!(await exists(outputPath))) {
      throw new Error("LibreOffice exited successfully but produced no output workbook");
    }
    const outputStat = await fs.stat(outputPath);
    if (!outputStat.isFile() || outputStat.size <= 0) {
      throw new Error("LibreOffice output is not a non-empty regular workbook file");
    }
    if (outputStat.mtimeMs < launchedAt - 2_000) {
      throw new Error("LibreOffice output predates this launch and is stale");
    }
    const outputIdentity = await hashFile(outputPath);
    const inspected = await runner(pythonExecutable, ["-c", INSPECT_RESULT, outputPath], {
      timeout: Math.min(timeoutMs, 30_000),
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    result.inspection_process = processEvidence(inspected);
    if (!inspected.ok) {
      throw new Error("selected Python/openpyxl could not reopen and inspect the LibreOffice output");
    }
    const line = inspected.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
    let observation;
    try {
      observation = JSON.parse(line);
    } catch {
      throw new Error("selected Python/openpyxl returned no typed workbook observation");
    }
    result.output = {
      ...outputIdentity,
      sheet_names: observation.sheet_names,
      formula: observation.formula,
      cached_result: observation.cached_result,
      fresh_after_launch: true,
    };
    if (
      !Array.isArray(observation.sheet_names) ||
      !observation.sheet_names.includes("Capability") ||
      observation.formula !== EXPECTED_FORMULA ||
      typeof observation.cached_result !== "number" ||
      Math.abs(observation.cached_result - EXPECTED_RESULT) > 1e-9
    ) {
      throw new Error(
        `LibreOffice output did not retain ${EXPECTED_FORMULA}=${EXPECTED_RESULT}; ` +
        `observed ${JSON.stringify(observation.formula)}=${JSON.stringify(observation.cached_result)}`,
      );
    }
    result.status = "PASS";
    result.reason_code = null;
  } catch (error) {
    result.failure = String(error?.message ?? error);
  } finally {
    const cleanupTargets = [
      ["profile_removed", profileRoot],
      ["fixture_removed", fixtureRoot],
      ["output_removed", outputRoot],
    ];
    for (const [field, target] of cleanupTargets) {
      if (target === null) continue;
      try {
        await removePath(target);
        result.cleanup[field] = !(await exists(target));
      } catch (error) {
        result.cleanup[field] = false;
        if (result.failure === null) result.failure = `Capability cleanup failed: ${error?.message ?? error}`;
      }
    }
    if (workspace !== null) {
      try {
        await fs.rmdir(workspace);
        result.cleanup.workspace_removed = !(await exists(workspace));
      } catch (error) {
        result.cleanup.workspace_removed = false;
        if (result.failure === null) result.failure = `Capability workspace cleanup failed: ${error?.message ?? error}`;
      }
      for (const target of [profileRoot, fixtureRoot, outputRoot, workspace]) {
        if (target !== null && await exists(target).catch(() => true)) {
          result.cleanup.residue_paths.push(path.basename(target));
        }
      }
      // Safety cleanup cannot turn a failed required cleanup operation into a
      // pass; it only prevents a diagnostic mutation from polluting the host.
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
    if (
      result.status === "PASS" &&
      (!result.cleanup.profile_removed || !result.cleanup.fixture_removed ||
        !result.cleanup.output_removed || !result.cleanup.workspace_removed)
    ) {
      result.status = "FAIL";
      result.reason_code = "LIBREOFFICE_WORKBOOK_CAPABILITY_UNPROVEN";
      result.failure ??= "LibreOffice capability artifacts were not completely removed";
    }
  }
  return Object.freeze(result);
}

export default {
  LIBREOFFICE_WORKBOOK_CAPABILITY_VERSION,
  generateDeterministicWorkbookFixture,
  probeLibreOfficeWorkbookCapability,
};
