#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assessCoverage } from "./lib/coverage.mjs";
import { solveCase, validateCaseShape } from "./lib/solver.mjs";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
}

async function writeJson(filePath, value) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  process.stdout.write(`${target}\n`);
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  debt-model-economics.mjs validate-case <case.json>",
      "  debt-model-economics.mjs coverage <case.json> [--out <coverage.json>]",
      "  debt-model-economics.mjs solve <case.json> <solution.json>",
      "",
    ].join("\n"),
  );
}

const [command, casePath, ...args] = process.argv.slice(2);

try {
  if (!command || !casePath) {
    usage();
    process.exitCode = 2;
  } else if (command === "validate-case") {
    const modelCase = await readJson(casePath);
    const errors = validateCaseShape(modelCase);
    if (errors.length > 0) {
      process.stderr.write(`${errors.map((item) => `- ${item}`).join("\n")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("PASS\n");
    }
  } else if (command === "coverage") {
    const modelCase = await readJson(casePath);
    const coverage = assessCoverage(modelCase);
    const outputIndex = args.indexOf("--out");
    const outputPath =
      outputIndex >= 0 && args[outputIndex + 1]
        ? args[outputIndex + 1]
        : null;
    if (outputPath) {
      await writeJson(outputPath, coverage);
    } else {
      process.stdout.write(`${JSON.stringify(coverage, null, 2)}\n`);
    }
    if (!coverage.ready_to_build) process.exitCode = 1;
  } else if (command === "solve") {
    if (!args[0]) {
      usage();
      process.exitCode = 2;
    } else {
      const modelCase = await readJson(casePath);
      const errors = validateCaseShape(modelCase);
      if (errors.length > 0) {
        process.stderr.write(
          `${errors.map((item) => `- ${item}`).join("\n")}\n`,
        );
        process.exitCode = 1;
      } else {
        const coverage = assessCoverage(modelCase);
        if (!coverage.ready_to_build) {
          process.stderr.write(
            "Coverage gate is not ready_to_build; solve is blocked.\n",
          );
          process.exitCode = 1;
        } else {
          const solution = solveCase(modelCase);
          if (!solution.all_checks_pass) {
            process.stderr.write(
              "Independent economic solver returned failed checks.\n",
            );
            process.exitCode = 1;
          } else {
            await writeJson(args[0], solution);
          }
        }
      }
    }
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? String(error)}\n`);
  process.exitCode = 1;
}
