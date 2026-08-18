#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { validateLocalWorkbookReview } from "./lib/local_workbook_review.mjs";

const args = process.argv.slice(2);
const evidence = args.find((argument) => !argument.startsWith("--"));
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : null;
if (!evidence) throw new Error("Usage: node scripts/validate_local_workbook_review.mjs <local-review-evidence.json> [--out <validation.json>]");
const result = await validateLocalWorkbookReview(path.resolve(evidence));
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (out) {
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), serialized);
}
process.stdout.write(serialized);
if (result.status !== "PASS") process.exitCode = 1;
