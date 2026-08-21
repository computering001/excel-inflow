#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { proposeCaseSource } from "./lib/case_source_proposer.mjs";

const args = process.argv.slice(2);
const declarationsPath = args[0];
const evidencePath = args[1];
const outIndex = args.indexOf("--out");
if (!declarationsPath || !evidencePath || outIndex < 0 || !args[outIndex + 1]) {
  throw new Error("Usage: propose_case_source.mjs <declarations.json> <case-evidence.json> --out <case-source.json>");
}
const declarations = JSON.parse(fs.readFileSync(path.resolve(declarationsPath), "utf8"));
const caseEvidence = JSON.parse(fs.readFileSync(path.resolve(evidencePath), "utf8"));
const result = proposeCaseSource({ declarations, caseEvidence });
fs.writeFileSync(path.resolve(args[outIndex + 1]), `${JSON.stringify(result, null, 2)}\n`);
