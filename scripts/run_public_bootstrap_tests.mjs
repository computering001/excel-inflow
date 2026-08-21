#!/usr/bin/env node
/**
 * Public-bootstrap package and mutation suite.
 *
 * Compiles one real development package, then applies every Phase-1 mutation
 * to disposable unpacked copies.  Source-checkout-only tests would not prove
 * the release inventory boundary and are intentionally insufficient here.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  CONTROLLER_HANDOFF_PATH_ENV,
  CONTROLLER_HANDOFF_SECRET_ENV,
  consumeControllerHandoff,
  createControllerHandoff,
} from "./lib/controller_handoff.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-public-bootstrap-"));
const packageRoot = path.join(scratch, "compiled-package");
const bootstrapRelative = "scripts/run_excel_inflow_bootstrap.mjs";
const vnextRelative = "scripts/run_excel_inflow_vnext.mjs";
const doctorRelative = "scripts/run_runtime_doctor.mjs";
const userFlowRelative = "scripts/run_user_flow.mjs";
const handoffRelative = "scripts/lib/controller_handoff.mjs";
const durablePublicationRelative = "scripts/lib/durable_artifact_generation.mjs";
const COMPANY_HEADER = "+=[ EXCEL INFLOW ]==============================[ COMPANY ]=+";
const refusalSchema = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "runtime-bootstrap-refusal-v1.schema.json"), "utf8"),
);
const python = path.resolve(
  process.env.EXCEL_INFLOW_TEST_PYTHON ??
  process.env.EXCEL_INFLOW_PYTHON ??
  process.env.PYTHON ??
  "python3",
);
let checks = 0;
const caught = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function compilePackage() {
  await execFileAsync(process.execPath, [
    path.join(ROOT, "scripts", "compile_skill_release.mjs"),
    "--skill", ROOT,
    "--out", packageRoot,
    "--development",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      EXCEL_INFLOW_PYTHON: python,
      PYTHON: python,
      EXCEL_INFLOW_SOURCE_REPOSITORY: "computering001/excel-inflow",
      EXCEL_INFLOW_SOURCE_COMMIT: "1".repeat(40),
      EXCEL_INFLOW_SOURCE_TREE: "2".repeat(40),
      EXCEL_INFLOW_BUILD_TIMESTAMP: "2026-08-21T00:00:00.000Z",
    },
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function clonePackage(name, destination = path.join(scratch, name)) {
  await fs.cp(packageRoot, destination, { recursive: true });
  return destination;
}

async function readManifest(root) {
  return JSON.parse(await fs.readFile(path.join(root, "release-manifest.json"), "utf8"));
}

async function writeManifest(root, manifest) {
  await fs.writeFile(
    path.join(root, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function mutateManifest(root, mutate) {
  const manifest = await readManifest(root);
  mutate(manifest);
  await writeManifest(root, manifest);
}

async function resealMember(root, relative) {
  const bytes = await fs.readFile(path.join(root, ...relative.split("/")));
  await mutateManifest(root, (manifest) => {
    const record = manifest.files.find((entry) => entry.path === relative);
    if (!record) throw new Error(`No release inventory record for ${relative}`);
    record.sha256 = digest(bytes);
    record.bytes = bytes.length;
  });
}

async function writeResealed(root, relative, source) {
  await fs.writeFile(path.join(root, ...relative.split("/")), source, "utf8");
  await resealMember(root, relative);
}

async function runBootstrap(root, args) {
  try {
    const done = await execFileAsync(process.execPath, [
      path.join(root, ...bootstrapRelative.split("/")),
      ...args,
    ], {
      cwd: scratch,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    return {
      code: Number(error.code ?? -1),
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

async function runDirect(root, relative, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, PYTHONDONTWRITEBYTECODE: "1" };
  delete env[CONTROLLER_HANDOFF_PATH_ENV];
  delete env[CONTROLLER_HANDOFF_SECRET_ENV];
  try {
    const done = await execFileAsync(process.execPath, [path.join(root, ...relative.split("/")), ...args], {
      cwd: scratch,
      env,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    return { code: Number(error.code ?? -1), stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message ?? "") };
  }
}

async function expectHandoffRefusal(expectedReason, operation, label) {
  let caughtError = null;
  try { await operation(); } catch (error) { caughtError = error; }
  check(caughtError?.controller_handoff_refusal === true, `${label} was not a typed controller-handoff refusal`);
  check(caughtError?.handoff_reason === expectedReason, `${label} refused as ${caughtError?.handoff_reason}, not ${expectedReason}`);
}

function parseRefusal(result, label) {
  let refusal;
  try {
    refusal = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not emit one JSON refusal: ${result.stdout.slice(0, 400)}`);
  }
  check(result.code !== 0, `${label} unexpectedly exited zero`);
  check(refusal.schema_version === "excel-inflow-runtime-bootstrap-refusal/1.0", `${label} refusal schema drifted`);
  check(refusal.verdict === "REFUSED" && refusal.terminal_state === "INTERNAL_FAILURE", `${label} refusal is not typed internal failure`);
  check(refusal.reason_code === "INTERNAL.runtime_bootstrap_failed", `${label} used an unregistered or wrong reason`);
  check(refusal.earliest_responsible_layer === "runtime_bootstrap", `${label} assigned the wrong earliest layer`);
  check(validateJsonSchema(refusal, refusalSchema).length === 0, `${label} refusal does not satisfy the shipped schema`);
  check(!result.stdout.includes(COMPANY_HEADER), `${label} leaked a success-looking Company screen`);
  return refusal;
}

async function readPointer(out) {
  const pointerPath = path.join(out, "runtime-bootstrap-current.json");
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  const immutable = await fs.readFile(path.join(out, pointer.refusal_file));
  check(pointer.refusal_sha256 === digest(immutable), "bootstrap pointer does not hash immutable refusal bytes");
  check(pointer.refusal_bytes === immutable.length, "bootstrap pointer byte count does not bind immutable refusal bytes");
  return { pointer, immutable };
}

async function mutation(id, callback) {
  await callback();
  caught.push(id);
}

const normalStub = `
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ok:true,cwd:process.cwd(),args}) + "\\n");
`;
const partialScreenStub = [
  `process.stdout.write(${JSON.stringify(`\`\`\`text\n${COMPANY_HEADER}\n| partial\n`)});`,
  "process.exitCode = 9;",
  "",
].join("\n");
const validFailureStub = `
import fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const index = args.indexOf("--out");
const out = path.resolve(args[index + 1]);
await fs.mkdir(out, {recursive:true});
await fs.writeFile(path.join(out, "child-internal-failure.json"), JSON.stringify({schema_version:"child-internal-failure/1.0",terminal_state:"INTERNAL_FAILURE",reason_code:"INTERNAL.compiler_or_graph_defect"}) + "\\n");
process.exitCode = 7;
`;

try {
  await compilePackage();
  const manifest = await readManifest(packageRoot);
  const inventory = new Map(manifest.files.map((record) => [record.path, record]));
  check(inventory.has(bootstrapRelative), "compiled package omitted the public bootstrap");
  check(inventory.has(vnextRelative), "compiled package omitted the private vNext controller");
  check(inventory.has(doctorRelative), "compiled package omitted the runtime doctor");
  check(inventory.has(handoffRelative), "compiled package omitted the controller handoff owner");
  check(
    inventory.has(durablePublicationRelative),
    "compiled package omitted the runtime doctor's durable publication owner",
  );
  check(manifest.closure.entryPoints.includes(bootstrapRelative), "release manifest does not expose bootstrap as a public entrypoint");
  check(!manifest.closure.entryPoints.includes(vnextRelative), "release manifest still exposes vNext as a public entrypoint");
  check(manifest.closure.privateEntryPoints.includes(vnextRelative), "release manifest does not retain vNext as a private controller");

  const bootstrapSource = await fs.readFile(path.join(ROOT, bootstrapRelative), "utf8");
  const doctorLibrarySource = await fs.readFile(
    path.join(ROOT, "scripts", "lib", "runtime_doctor.mjs"),
    "utf8",
  );
  const doctorCliSource = await fs.readFile(path.join(ROOT, doctorRelative), "utf8");
  check(
    doctorLibrarySource.includes('from "./durable_artifact_generation.mjs"') &&
      doctorLibrarySource.includes("publishDurableJsonGeneration({"),
    "the runtime doctor does not delegate report/receipt/pointer publication to the shared durable owner",
  );
  const cliArtifactCall = doctorCliSource.indexOf("await writeInstalledCapabilityArtifactSet({");
  const cliJsonOutput = doctorCliSource.indexOf("if (options.json === true)", cliArtifactCall);
  check(
    cliArtifactCall > 0 && cliJsonOutput > cliArtifactCall &&
      !doctorCliSource.slice(cliArtifactCall, cliJsonOutput).includes("await writeAtomic("),
    "the runtime-doctor CLI performs a caller file write after durable pointer publication",
  );
  const staticImports = [...bootstrapSource.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  check(staticImports.length >= 6, "bootstrap import test is vacuous");
  check(staticImports.every((specifier) => specifier.startsWith("node:")), "bootstrap statically imports a package-owned or third-party module");
  check(
    bootstrapSource.includes('new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP"])') &&
      bootstrapSource.includes("if (!unsupported.has(error?.code)) throw error"),
    "bootstrap does not narrowly tolerate Windows-unsupported directory fsync after durable file publication",
  );
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"));
  const reason = registry.reason_codes?.["INTERNAL.runtime_bootstrap_failed"];
  check(reason?.owner_layer === "runtime_bootstrap" && reason.allowed_terminal_states.includes("INTERNAL_FAILURE"), "bootstrap reason is not registered to the runtime-bootstrap owner");

  const vnextSource = await fs.readFile(path.join(ROOT, vnextRelative), "utf8");
  const userFlowSource = await fs.readFile(path.join(ROOT, userFlowRelative), "utf8");
  check(
    vnextSource.includes("await consumeControllerHandoff({") &&
      vnextSource.includes("async function runUserFlow(") &&
      (vnextSource.match(/await runUserFlow\(/g) ?? []).length === 4,
    "vNext does not consume the public handoff and mint a private handoff at all four user-flow product delegates",
  );
  check(
    userFlowSource.includes("await consumeControllerHandoff({") &&
      !userFlowSource.includes("EXCEL_INFLOW_TOP_CONTROLLER_HANDOFF"),
    "user_flow still has an unbound product route or the legacy Company-only token",
  );
  const compiledTwoHopScreen = await runBootstrap(packageRoot, ["--screen", "inputs"]);
  check(compiledTwoHopScreen.code === 0, "compiled bootstrap -> vNext -> user_flow two-hop screen route failed");
  check(
    compiledTwoHopScreen.stderr === "" && compiledTwoHopScreen.stdout.includes("CHECKPOINT: INPUT PACK"),
    "compiled two-hop route did not preserve the existing visible screen UX",
  );

  await mutation("direct_vnext_product_route_refused", async () => {
    const out = path.join(scratch, "direct-vnext-product-out");
    const evidence = path.join(scratch, "direct-vnext-evidence.json");
    await fs.writeFile(evidence, "{}\n");
    const result = await runDirect(packageRoot, vnextRelative, ["--evidence-run", evidence, "--out", out]);
    check(result.code !== 0, "direct vNext normal product input unexpectedly ran");
    check(!(await fs.stat(out).then(() => true, () => false)), "direct vNext created a run/build output before refusing");
    check(!result.stdout.includes(COMPANY_HEADER) && !/workbook|deliver/i.test(result.stdout), "direct vNext emitted product success output");
  });

  await mutation("direct_user_flow_product_route_refused", async () => {
    const out = path.join(scratch, "direct-user-flow-product-out");
    const evidence = path.join(scratch, "direct-user-flow-evidence.json");
    await fs.writeFile(evidence, "{}\n");
    const result = await runDirect(packageRoot, userFlowRelative, [evidence, "--out", out, "--json"]);
    check(result.code !== 0, "direct user_flow normal product input unexpectedly ran");
    check(!(await fs.stat(out).then(() => true, () => false)), "direct user_flow created Company/Build/Deliver output before refusing");
    check(!result.stdout.includes(COMPANY_HEADER) && !/workbook|deliver/i.test(result.stdout), "direct user_flow emitted product success output");
  });

  await mutation("typed_private_diagnostics_only", async () => {
    for (const [relative, controller] of [[vnextRelative, "run_excel_inflow_vnext"], [userFlowRelative, "run_user_flow"]]) {
      const result = await runDirect(packageRoot, relative, ["--controller-diagnostic"]);
      check(result.code === 0, `${controller} typed diagnostic was not permitted`);
      const payload = JSON.parse(result.stdout);
      check(payload.controller === controller && payload.product_route_executed === false, `${controller} diagnostic executed a product route`);
    }
  });

  await mutation("handoff_stale_refused", async () => {
    const handoff = await createControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
      ttlMs: 1_000,
      nowEpochMs: Date.now() - 10_000,
    });
    await expectHandoffRefusal("stale_or_invalid_time", () => consumeControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
      env: { ...handoff.env },
    }), "stale handoff");
    await handoff.cleanup();
  });

  await mutation("handoff_replay_refused", async () => {
    const handoff = await createControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
    });
    const replayEnv = { ...handoff.env };
    await consumeControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
      env: { ...handoff.env },
    });
    await expectHandoffRefusal("missing_or_replayed", () => consumeControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
      env: replayEnv,
    }), "replayed handoff");
    await handoff.cleanup();
  });

  await mutation("handoff_wrong_package_refused", async () => {
    const otherRoot = await clonePackage("wrong-package-handoff");
    const handoff = await createControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
    });
    await expectHandoffRefusal("wrong_package", () => consumeControllerHandoff({
      packageRoot: otherRoot,
      parentController: path.join(otherRoot, bootstrapRelative),
      childController: path.join(otherRoot, vnextRelative),
      childArgs: ["--screen", "company"],
      env: { ...handoff.env },
    }), "wrong-package handoff");
    await handoff.cleanup();
  });

  await mutation("handoff_wrong_controller_refused", async () => {
    const handoff = await createControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
    });
    await expectHandoffRefusal("wrong_child_controller", () => consumeControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, userFlowRelative),
      childArgs: ["--screen", "company"],
      env: { ...handoff.env },
    }), "wrong-controller handoff");
    await handoff.cleanup();
  });

  await mutation("handoff_wrong_arguments_refused", async () => {
    const handoff = await createControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "company"],
    });
    await expectHandoffRefusal("wrong_child_arguments", () => consumeControllerHandoff({
      packageRoot,
      parentController: path.join(packageRoot, bootstrapRelative),
      childController: path.join(packageRoot, vnextRelative),
      childArgs: ["--screen", "delivery"],
      env: { ...handoff.env },
    }), "wrong-arguments handoff");
    await handoff.cleanup();
  });

  const diagnosticRoot = await clonePackage("diagnostic-pass-through");
  await writeResealed(diagnosticRoot, doctorRelative, normalStub);
  const diagnosticReport = path.join(scratch, "diagnostic-output", "report.json");
  const diagnostic = await runBootstrap(diagnosticRoot, [
    "--diagnostic", "--out", diagnosticReport, "--bootstrap-diagnostic", "preserved",
  ]);
  check(diagnostic.code === 0, "diagnostic invocation did not execute normally");
  const diagnosticPayload = JSON.parse(diagnostic.stdout);
  check(
    diagnosticPayload.args.includes("--bootstrap-diagnostic") &&
      diagnosticPayload.args.includes("preserved") &&
      !diagnosticPayload.args.includes("--diagnostic"),
    "diagnostic selector or diagnostic arguments were not routed correctly",
  );

  await mutation("remove_vnext_controller", async () => {
    const root = await clonePackage("remove-vnext");
    await fs.rm(path.join(root, vnextRelative));
    const refusal = parseRefusal(await runBootstrap(root, ["--screen", "company"]), "missing vNext");
    check(refusal.subordinate_execution_attempted === false, "missing controller should refuse before child execution");
  });

  await mutation("invalid_vnext_syntax", async () => {
    const root = await clonePackage("invalid-vnext-syntax");
    await writeResealed(root, vnextRelative, "this is not valid JavaScript {{{\n");
    const out = path.join(scratch, "invalid-vnext-out");
    const refusal = parseRefusal(await runBootstrap(root, ["--screen", "company", "--out", out]), "invalid vNext syntax");
    check(refusal.subordinate_execution_attempted === true, "invalid syntax should be caught after a child attempt");
    await readPointer(out);
  });

  await mutation("remove_runtime_doctor", async () => {
    const root = await clonePackage("remove-doctor");
    await fs.rm(path.join(root, doctorRelative));
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "missing runtime doctor");
  });

  await mutation("remove_top_level_import", async () => {
    const root = await clonePackage("remove-import");
    await fs.rm(path.join(root, "scripts", "lib", "json_schema.mjs"));
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "missing top-level library");
  });

  await mutation("modify_packaged_runtime_byte", async () => {
    const root = await clonePackage("changed-byte");
    await fs.appendFile(path.join(root, vnextRelative), "\n");
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "changed runtime byte");
  });

  await mutation("unexpected_package_file", async () => {
    const root = await clonePackage("unexpected-file");
    await fs.writeFile(path.join(root, "unexpected.txt"), "unexpected\n");
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "unexpected package file");
  });

  await mutation("symlink_package_member", async () => {
    const root = await clonePackage("symlink-member");
    await fs.rm(path.join(root, vnextRelative));
    await fs.symlink("run_excel_inflow_bootstrap.mjs", path.join(root, vnextRelative));
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "symlink package member");
  });

  await mutation("corrupt_release_manifest_json", async () => {
    const root = await clonePackage("corrupt-manifest");
    await fs.writeFile(path.join(root, "release-manifest.json"), "{broken\n");
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "corrupt release manifest");
  });

  await mutation("remove_release_manifest", async () => {
    const root = await clonePackage("missing-manifest");
    await fs.rm(path.join(root, "release-manifest.json"));
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "missing release manifest");
  });

  await mutation("duplicate_inventory_path", async () => {
    const root = await clonePackage("duplicate-inventory");
    await mutateManifest(root, (value) => value.files.push({ ...value.files[0] }));
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "duplicate inventory path");
  });

  await mutation("inventory_parent_traversal", async () => {
    const root = await clonePackage("traversal-inventory");
    await mutateManifest(root, (value) => value.files.push({ path: "../escape", sha256: "a".repeat(64), bytes: 1 }));
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "inventory traversal");
  });

  await mutation("inventory_windows_drive_path", async () => {
    const root = await clonePackage("windows-drive-inventory");
    await mutateManifest(root, (value) => value.files.push({ path: "C:escape.mjs", sha256: "a".repeat(64), bytes: 1 }));
    const refusal = parseRefusal(await runBootstrap(root, ["--screen", "company"]), "Windows drive-relative inventory path");
    check(
      refusal.findings.some((finding) => finding.path === "C:escape.mjs" && finding.issue === "invalid_inventory_record"),
      "Windows drive-relative inventory member was not rejected at path validation",
    );
  });

  await mutation("declared_byte_count_only", async () => {
    const root = await clonePackage("wrong-byte-count");
    await mutateManifest(root, (value) => {
      value.files.find((record) => record.path === vnextRelative).bytes += 1;
    });
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "declared byte count mutation");
  });

  await mutation("declared_sha_only", async () => {
    const root = await clonePackage("wrong-sha");
    await mutateManifest(root, (value) => {
      value.files.find((record) => record.path === vnextRelative).sha256 = "f".repeat(64);
    });
    parseRefusal(await runBootstrap(root, ["--screen", "company"]), "declared SHA mutation");
  });

  await mutation("output_symlink_into_package", async () => {
    const root = await clonePackage("output-symlink-package");
    const link = path.join(scratch, "output-link-into-package");
    await fs.symlink(path.join(root, "assets"), link);
    const refusal = parseRefusal(await runBootstrap(root, ["--out", link]), "output symlink into package");
    check(refusal.subordinate_execution_attempted === false, "unsafe output path launched the child");
    check(!(await fs.stat(path.join(root, "assets", "runtime-bootstrap-current.json")).then(() => true, () => false)), "bootstrap wrote through an output symlink into the package");
  });

  for (const [id, directoryName] of [
    ["package_path_spaces", "package with spaces"],
    ["package_path_unicode", "package-雪-model"],
    ["package_path_parentheses_long", `package (candidate) ${"long-".repeat(12)}name`],
  ]) {
    await mutation(id, async () => {
      const root = await clonePackage(id, path.join(scratch, directoryName));
      await writeResealed(root, vnextRelative, normalStub);
      const out = path.join(scratch, `${id}-out`);
      const result = await runBootstrap(root, ["--out", out, "--bootstrap-pass-through", id]);
      check(result.code === 0, `${id} did not execute normally: ${result.stdout} ${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      check(payload.ok === true && payload.cwd === await fs.realpath(root), `${id} did not run from canonical package root`);
      check(payload.args.includes("--bootstrap-pass-through") && payload.args.includes(id), `${id} did not preserve normal-run arguments`);
    });
  }

  await mutation("partial_company_screen_suppressed", async () => {
    const root = await clonePackage("partial-company-screen");
    await writeResealed(root, vnextRelative, partialScreenStub);
    const out = path.join(scratch, "partial-screen-out");
    const refusal = parseRefusal(await runBootstrap(root, ["--screen", "company", "--out", out]), "partial Company screen");
    check(refusal.subordinate_execution_attempted === true, "partial-screen child was not recorded as attempted");
    await readPointer(out);
  });

  await mutation("child_typed_failure_preserved", async () => {
    const root = await clonePackage("child-owned-failure");
    await writeResealed(root, vnextRelative, validFailureStub);
    const out = path.join(scratch, "child-owned-out");
    const result = await runBootstrap(root, ["--out", out]);
    check(result.code === 7, "bootstrap did not preserve the child failure exit");
    const childPath = path.join(out, "child-internal-failure.json");
    const childBefore = await fs.readFile(childPath);
    check(!(await fs.stat(path.join(out, "runtime-bootstrap-current.json")).then(() => true, () => false)), "bootstrap overwrote a valid child failure with its own pointer");
    check(digest(await fs.readFile(childPath)) === digest(childBefore), "bootstrap changed the child failure artifact");
  });

  await mutation("child_failure_without_artifact", async () => {
    const root = await clonePackage("child-no-artifact");
    await writeResealed(root, vnextRelative, "process.exitCode = 8;\n");
    const out = path.join(scratch, "child-no-artifact-out");
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, "stale-internal-failure.json"),
      '{"schema_version":"stale/1.0","terminal_state":"INTERNAL_FAILURE","reason_code":"INTERNAL.compiler_or_graph_defect"}\n',
    );
    const refusal = parseRefusal(await runBootstrap(root, ["--out", out]), "child failure without artifact");
    check(refusal.subordinate_execution_attempted === true, "unowned child failure was not recorded as attempted");
    await readPointer(out);
  });

  const declared = [
    "direct_vnext_product_route_refused",
    "direct_user_flow_product_route_refused",
    "typed_private_diagnostics_only",
    "handoff_stale_refused",
    "handoff_replay_refused",
    "handoff_wrong_package_refused",
    "handoff_wrong_controller_refused",
    "handoff_wrong_arguments_refused",
    "remove_vnext_controller",
    "invalid_vnext_syntax",
    "remove_runtime_doctor",
    "remove_top_level_import",
    "modify_packaged_runtime_byte",
    "unexpected_package_file",
    "symlink_package_member",
    "corrupt_release_manifest_json",
    "remove_release_manifest",
    "duplicate_inventory_path",
    "inventory_parent_traversal",
    "inventory_windows_drive_path",
    "declared_byte_count_only",
    "declared_sha_only",
    "output_symlink_into_package",
    "package_path_spaces",
    "package_path_unicode",
    "package_path_parentheses_long",
    "partial_company_screen_suppressed",
    "child_typed_failure_preserved",
    "child_failure_without_artifact",
  ];
  check(declared.length > 0, "bootstrap mutation declaration is vacuous");
  check(JSON.stringify(caught) === JSON.stringify(declared), "bootstrap mutation table was not executed exactly once in declared order");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    mutations_declared: declared.length,
    mutations_applied: caught.length,
    mutations_caught: caught.length,
    mutations_survived: 0,
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
