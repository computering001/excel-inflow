#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";

const [casePath, suppliedFirstImage, suppliedSecondImage] = process.argv.slice(2);
if (!casePath) {
  throw new Error(
    "Usage: node scripts/run_broker_page_evidence_tests.mjs <case.json> [page1.png] [page2.png]",
  );
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), "broker-page-evidence-"));
const modelCase = JSON.parse(await fs.readFile(casePath, "utf8"));
// This test mutates only workbook presentation by attaching synthetic page
// images.  Frozen certification cases may predate the production evidence
// contract fields, so run the disposable derivative under the explicit
// reference-parity profile rather than weakening production-model validation.
modelCase.execution_profile = "reference_parity";
const generatedPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const generatedFirst = path.join(root, "page-1.png");
const generatedSecond = path.join(root, "page-2.png");
await fs.writeFile(generatedFirst, generatedPng);
await fs.writeFile(generatedSecond, generatedPng);
const images = [
  path.resolve(suppliedFirstImage ?? generatedFirst),
  path.resolve(suppliedSecondImage ?? suppliedFirstImage ?? generatedSecond),
];
const imageHashes = await Promise.all(images.map(async (image) => sha256(await fs.readFile(image))));
const names = Object.keys(Object.values(modelCase.broker_pack.metrics)[0].brokers);
modelCase.broker_pack.page_evidence = names.map((houseName, index) => ({
  house_id: `house_${index + 1}`,
  house_name: houseName,
  source_id: `broker_${index + 1}`,
  content_sha256: "a".repeat(64 - String(index).length) + String(index),
  file_name: `${houseName}.pdf`,
  pages: (index === 0 ? [0, 1] : [0]).map((imageIndex, pageIndex) => ({
    page_number: pageIndex + 1,
    surface_id: `house_${index + 1}.p${pageIndex + 1}`,
    width_points: 612,
    height_points: 792,
    artifact_path: images[imageIndex],
    artifact_sha256: imageHashes[imageIndex],
  })),
}));
modelCase.broker_pack.source_mappings = names.flatMap((houseName, houseIndex) =>
  Object.entries(modelCase.broker_pack.metrics).flatMap(([metricId, metric]) =>
    (metric.brokers?.[houseName] ?? []).flatMap((value, periodIndex) =>
      value === null || value === undefined
        ? []
        : [{
            mapping_id: `map_${houseIndex + 1}_${metricId}_${periodIndex}`.replace(/[^a-z0-9_.-]/g, "_"),
            house_id: `house_${houseIndex + 1}`,
            metric_id: metricId,
            period_index: periodIndex,
            components: [{
              table_id: `source_${houseIndex + 1}`,
              row: 1,
              column: periodIndex + 1,
              source_ref: `${houseName}.pdf page 1`,
              raw_value: Number(value),
              coefficient: 1,
              contribution: Number(value),
            }],
            constant: 0,
            multiplier: 1,
            value: Number(value),
            rationale: "Test-only exact source observation.",
            review_status: "reviewed",
          }],
    ),
  ),
);
const caseOut = path.join(root, "case.json");
const planWorkbook = path.join(root, "plan", "model.xlsx");
const workbook = path.join(root, "emit", "model.xlsx");
await fs.mkdir(path.dirname(planWorkbook), { recursive: true });
await fs.mkdir(path.dirname(workbook), { recursive: true });
await fs.writeFile(caseOut, `${JSON.stringify(modelCase, null, 2)}\n`);
execFileSync("node", ["scripts/build_dynamic_model.mjs", caseOut, "--out", planWorkbook, "--plan-only"], {
  cwd: path.resolve("."), stdio: "pipe",
});
const planPath = `${planWorkbook}.plan.json`;
const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const namesInPlan = plan.workbook.sheets.map((sheet) => sheet.name);
check(!namesInPlan.includes("> Brokers"), "page-image mode must not emit the obsolete broker divider");
const brokerSheets = plan.workbook.sheets.filter((sheet) => /^B\d{2} /.test(sheet.name));
check(brokerSheets.length === names.length, "one Bxx page sheet is required per house");
for (const sheet of brokerSheets) {
  check(
    Object.values(sheet.cells ?? {}).every((cell) => !cell?.f && cell?.t !== "f"),
    `${sheet.name} must be screenshot/metadata only and contain no formula dependency`,
  );
  check(
    (sheet.conditional_formats ?? []).length === 0 &&
      (sheet.data_validations ?? []).length === 0,
    `${sheet.name} must not carry calculation controls`,
  );
}
check(brokerSheets[0].images?.length === 2, "multi-page reports must retain every page");
check(
  brokerSheets[0].images[0].anchor === "B4" && brokerSheets[0].images[1].anchor === "V4",
  "broker pages must run horizontally from left to right",
);
execFileSync("python3", ["-m", "emit", "build", planPath, "--out", workbook], {
  cwd: path.join(path.resolve("."), "scripts"), stdio: "pipe",
  env: { ...process.env, PYTHONPATH: path.join(path.resolve("."), "scripts") },
});
for (const entry of await fs.readdir(path.dirname(planWorkbook), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.startsWith("model.xlsx.")) continue;
  await fs.copyFile(
    path.join(path.dirname(planWorkbook), entry.name),
    path.join(path.dirname(workbook), entry.name),
  );
}
const archive = await JSZip.loadAsync(await fs.readFile(workbook));
const media = Object.keys(archive.files).filter((name) => /^xl\/media\//.test(name));
const drawings = Object.keys(archive.files).filter((name) => /^xl\/drawings\/drawing\d+\.xml$/.test(name));
check(media.length === names.length + 1, "every declared broker page must be embedded");
check(drawings.length === names.length, "each Bxx sheet must own one drawing part");
const oraclePath = path.join(root, "oracle.json");
execFileSync("python3", [
  "scripts/verify/workbook_semantic_oracle.py",
  "--xlsx", workbook,
  "--contract", `${workbook}.workbook-proof-contract.json`,
  "--model-ir", `${workbook}.model-ir-v3.json`,
  "--out", oraclePath,
], { cwd: path.resolve("."), stdio: "pipe" });
check(
  JSON.parse(await fs.readFile(oraclePath, "utf8")).status === "PASS",
  "independent OOXML broker page-image proof did not pass",
);
const validatorOut = path.join(root, "validator");
execFileSync("python3", [
  "scripts/verify/validate_dynamic_model.py",
  workbook,
  "--out", validatorOut,
], { cwd: path.resolve("."), stdio: "pipe" });
const validator = JSON.parse(
  await fs.readFile(path.join(validatorOut, "validation-report.json"), "utf8"),
);
check(
  validator.total_violations === 0,
  "shipping validator rejected the broker page-image workbook",
);

const tamperedPlan = structuredClone(plan);
tamperedPlan.workbook.sheets.find((sheet) => /^B\d{2} /.test(sheet.name)).images[0].sha256 = "0".repeat(64);
const tamperedPath = path.join(root, "tampered.plan.json");
await fs.writeFile(tamperedPath, `${JSON.stringify(tamperedPlan, null, 2)}\n`);
let tamperBlocked = false;
try {
  execFileSync("python3", ["-m", "emit", "build", tamperedPath, "--out", path.join(root, "tampered.xlsx")], {
    cwd: path.join(path.resolve("."), "scripts"), stdio: "pipe",
    env: { ...process.env, PYTHONPATH: path.join(path.resolve("."), "scripts") },
  });
} catch {
  tamperBlocked = true;
}
check(tamperBlocked, "a stale broker page-image hash must block rendering");
console.log(JSON.stringify({ status: "PASS", houses: names.length, pages: media.length, horizontal_pages: 2, screenshot_only_tabs: brokerSheets.length, calculation_dependencies: 0, oracle: "PASS", validator_violations: 0, tamper_blocked: true, root }));
