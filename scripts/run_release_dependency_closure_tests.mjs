#!/usr/bin/env node
/**
 * Release dependency-closure mutation suite.
 *
 * Proves that declarative runtime manifests, external JSON-Schema references
 * and Markdown instruction links are compiler-owned closure edges. These are
 * the three dependency classes that previously existed in the source checkout
 * but disappeared from an installed package.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "release-dependency-closure-"));
const python = path.resolve(
  process.env.EXCEL_INFLOW_TEST_PYTHON ?? process.env.EXCEL_INFLOW_PYTHON ?? process.env.PYTHON ?? "python3",
);
let checks = 0;
const mutations = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

async function cloneSkill(name) {
  const destination = path.join(scratch, name);
  await fs.cp(ROOT, destination, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git",
  });
  return destination;
}

async function compile(skillRoot, name) {
  const out = path.join(scratch, `${name}-package`);
  try {
    const done = await execFileAsync(process.execPath, [
      path.join(skillRoot, "scripts", "compile_skill_release.mjs"),
      "--skill", skillRoot,
      "--out", out,
      "--development",
    ], {
      cwd: skillRoot,
      env: {
        ...process.env,
        EXCEL_INFLOW_PYTHON: python,
        PYTHON: python,
        EXCEL_INFLOW_SOURCE_REPOSITORY: "computering001/excel-inflow",
        EXCEL_INFLOW_SOURCE_COMMIT: "1".repeat(40),
        EXCEL_INFLOW_SOURCE_TREE: "2".repeat(40),
        EXCEL_INFLOW_BUILD_TIMESTAMP: "2026-08-20T00:00:00.000Z",
      },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 240_000,
    });
    return { code: 0, stdout: done.stdout, stderr: done.stderr, out };
  } catch (error) {
    return {
      code: Number(error.code ?? -1),
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
      out,
    };
  }
}

async function mutateJson(target, mutate) {
  const value = JSON.parse(await fs.readFile(target, "utf8"));
  mutate(value);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

try {
  const manifestOnly = await cloneSkill("manifest-only-positive");
  await fs.writeFile(
    path.join(manifestOnly, "scripts", "runtime_manifest_only_child.mjs"),
    "export const runtimeManifestOnlyProbe = true;\n",
  );
  await fs.writeFile(
    path.join(manifestOnly, "assets", "runtime-manifest-only-probe.json"),
    '{"probe":true}\n',
  );
  await mutateJson(path.join(manifestOnly, "assets", "deployment-profile.json"), (profile) => {
    profile.script_allowlist.push("runtime_manifest_only_child.mjs");
    profile.asset_allowlist.push("runtime-manifest-only-probe.json");
  });
  await mutateJson(path.join(manifestOnly, "assets", "filings-runtime-members.json"), (manifest) => {
    manifest.members.push(
      "scripts/runtime_manifest_only_child.mjs",
      "assets/runtime-manifest-only-probe.json",
    );
  });
  const manifestOnlyResult = await compile(manifestOnly, "manifest-only-positive");
  check(manifestOnlyResult.code === 0, `manifest-only closure did not compile: ${manifestOnlyResult.stderr}`);
  const manifestOnlyRelease = JSON.parse(
    await fs.readFile(path.join(manifestOnlyResult.out, "release-manifest.json"), "utf8"),
  );
  check(
    manifestOnlyRelease.closure.privateEntryPoints.includes(
      "scripts/runtime_manifest_only_child.mjs",
    ) && manifestOnlyRelease.closure.assetsLoadedByScripts.includes(
      "assets/runtime-manifest-only-probe.json",
    ),
    "runtime-manifest-only private code/resource did not enter the compiled closure",
  );
  check(
    await fs.stat(path.join(manifestOnlyResult.out, "scripts", "runtime_manifest_only_child.mjs"))
      .then((entry) => entry.isFile(), () => false) &&
    await fs.stat(path.join(manifestOnlyResult.out, "assets", "runtime-manifest-only-probe.json"))
      .then((entry) => entry.isFile(), () => false),
    "runtime-manifest-only bytes disappeared from the emitted package",
  );

  const duplicate = await cloneSkill("duplicate-member");
  await mutateJson(path.join(duplicate, "assets", "filings-runtime-members.json"), (manifest) => {
    manifest.members.push(manifest.members[0]);
  });
  const duplicateResult = await compile(duplicate, "duplicate-member");
  check(
    duplicateResult.code !== 0 && /duplicate runtime members/i.test(duplicateResult.stderr),
    "duplicate runtime member was not refused before package output",
  );
  mutations.push("duplicate_runtime_member");

  const traversal = await cloneSkill("traversal-member");
  await mutateJson(path.join(traversal, "assets", "filings-runtime-members.json"), (manifest) => {
    manifest.members.push("scripts/../SKILL.md");
  });
  const traversalResult = await compile(traversal, "traversal-member");
  check(
    traversalResult.code !== 0 && /unsafe runtime member/i.test(traversalResult.stderr),
    "runtime-member traversal was not refused before package output",
  );
  mutations.push("runtime_member_traversal");

  const missingSchema = await cloneSkill("missing-schema-ref");
  await mutateJson(
    path.join(missingSchema, "assets", "installed-capability-receipt-v1.3.schema.json"),
    (schema) => {
      schema.allOf = [...(schema.allOf ?? []), { $ref: "release-dependency-missing.schema.json" }];
    },
  );
  const missingSchemaResult = await compile(missingSchema, "missing-schema-ref");
  check(
    missingSchemaResult.code !== 0 && /references missing schema asset/i.test(missingSchemaResult.stderr),
    "missing external JSON-Schema dependency was not refused",
  );
  mutations.push("missing_external_schema_ref");

  const missingMarkdown = await cloneSkill("missing-markdown-ref");
  await fs.appendFile(
    path.join(missingMarkdown, "SKILL.md"),
    "\n[unshipped runtime policy](references/release-dependency-missing.md)\n",
  );
  const missingMarkdownResult = await compile(missingMarkdown, "missing-markdown-ref");
  check(
    missingMarkdownResult.code !== 0 && /absent from reference_allowlist/i.test(missingMarkdownResult.stderr),
    "missing Markdown instruction dependency was not refused",
  );
  mutations.push("missing_markdown_reference");

  const expectedMutations = [
    "duplicate_runtime_member",
    "missing_external_schema_ref",
    "missing_markdown_reference",
    "runtime_member_traversal",
  ];
  check(
    JSON.stringify([...mutations].sort()) === JSON.stringify(expectedMutations),
    "release dependency mutation set became vacuous or changed without review",
  );

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    checks,
    mutations: mutations.length,
    mutation_ids: [...mutations].sort(),
  })}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
