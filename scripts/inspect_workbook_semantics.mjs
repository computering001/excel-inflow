#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { inspectWorkbookSemantics } from "./lib/workbook_semantic_inventory.mjs";

const args = process.argv.slice(2);
const workbook = args.find((argument) => !argument.startsWith("--"));
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : null;
if (!workbook) {
  throw new Error("Usage: node scripts/inspect_workbook_semantics.mjs <workbook.xlsx> [--out <inventory.json>]");
}
const result = await inspectWorkbookSemantics(path.resolve(workbook));
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (out) {
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), serialized);
}
process.stdout.write(serialized);
if (result.status !== "PASS") process.exitCode = 1;
