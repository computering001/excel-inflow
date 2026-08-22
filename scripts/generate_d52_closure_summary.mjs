#!/usr/bin/env node
/**
 * Exact derived Markdown view of the D52 closure ledger. The JSON ledger owns
 * every status, count, commit fact and deferred reason; this file owns none.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const D52_LEDGER = "audit/v379/d52-closure-ledger.json";
export const D52_MAP = "audit/v379/commit-to-finding-map.json";
export const D52_SUMMARY = "audit/v379/D52_CLOSURE_SUMMARY.md";

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function statusLabel(status) {
  if (status === "custody-deferred") return "Custody-deferred";
  return status[0].toUpperCase() + status.slice(1);
}

export function renderD52ClosureSummary(ledger, sourceMap, ledgerBytes) {
  const observed = { closed: 0, "custody-deferred": 0, open: 0 };
  for (const finding of ledger.findings) {
    if (!Object.hasOwn(observed, finding.status)) throw new Error(`unsupported D52 status ${finding.status}`);
    observed[finding.status] += 1;
  }
  const total = ledger.findings.length;
  if (
    ledger.summary.total !== total ||
    ledger.summary.closed !== observed.closed ||
    ledger.summary.custody_deferred !== observed["custody-deferred"] ||
    ledger.summary.open !== observed.open
  ) throw new Error("D52 ledger summary disagrees with its findings");
  if (ledger.source_map.path !== D52_MAP || ledger.source_map.schema_version !== sourceMap.schema_version) {
    throw new Error("D52 ledger source-map declaration disagrees with the source map");
  }

  const commits = Object.entries(ledger.commit_verification)
    .filter(([, value]) => value && typeof value === "object" && typeof value.sha === "string")
    .map(([role, value]) => `| ${role.replaceAll("_", " ")} | \`${value.sha}\` | ${value.subject} | ${value.exists_in_history ? "yes" : "no"} |`)
    .join("\n");
  const deferred = ledger.findings.filter((finding) => finding.status === "custody-deferred");
  const deferredText = deferred.length === 0
    ? "None."
    : deferred.map((finding, index) => `${index + 1}. **\`${finding.finding_id}\`** — ${finding.deferred_reason}`).join("\n");
  const digest = createHash("sha256").update(ledgerBytes).digest("hex");

  return `# D52 Findings Closure Summary

<!-- generated-document:d52-closure-summary/1.0 BEGIN -->
<!-- DERIVED DOCUMENT: every claim below is generated from audit/v379/d52-closure-ledger.json and commit-to-finding-map.json. -->
<!-- Writer: node scripts/generate_d52_closure_summary.mjs -->
<!-- Read-only check: node scripts/generate_d52_closure_summary.mjs --check -->
<!-- Do not hand-edit. Drift remedy: change the authoritative JSON evidence, then run the writer. -->
<!-- generated-document:d52-closure-summary/1.0 END -->

- **Ledger:** [\`${D52_LEDGER}\`](./d52-closure-ledger.json) (\`${ledger.schema_version}\`)
- **Source map:** [\`${D52_MAP}\`](./commit-to-finding-map.json) (\`${sourceMap.schema_version}\`)
- **Ledger SHA-256:** \`${digest}\`
- **Ledger generated at:** \`${ledger.generated_at}\`

## Result

| Status | Count |
| --- | ---: |
| Closed | ${observed.closed} |
| Custody-deferred | ${observed["custody-deferred"]} |
| Open | ${observed.open} |
| **Total** | **${total}** |

These counts are a projection of all ${total} ledger findings; they are not an
independent closure claim. The source map's audited base is
\`${sourceMap.audited_base.commit}\`.

## Commit verification

| Role | SHA | Subject | Verified in history |
| --- | --- | --- | --- |
${commits}

${ledger.commit_verification.principal_path_spot_checks}

## Custody-deferred findings (${deferred.length})

${deferredText}

## Closure policy

- **Closed:** ${ledger.closure_policy.closed}
- **Custody-deferred:** ${ledger.closure_policy["custody-deferred"]}
- **Open:** ${ledger.closure_policy.open}
`;
}

export function generateD52ClosureSummary(root = DEFAULT_ROOT) {
  const ledgerPath = path.join(root, D52_LEDGER);
  const ledgerBytes = fs.readFileSync(ledgerPath);
  return renderD52ClosureSummary(JSON.parse(ledgerBytes), readJson(root, D52_MAP), ledgerBytes);
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const rootIndex = args.indexOf("--root");
  const root = rootIndex === -1 ? DEFAULT_ROOT : args[rootIndex + 1];
  const supported = new Set(["--check", "--root", root]);
  if (!root || args.some((arg) => !supported.has(arg))) {
    console.error("usage: generate_d52_closure_summary.mjs [--check] [--root <repo-root>]");
    process.exit(2);
  }
  const expected = generateD52ClosureSummary(root);
  const target = path.join(root, D52_SUMMARY);
  const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (check) {
    if (actual !== expected) {
      console.error(`D52_DOC_DRIFT: ${D52_SUMMARY} is stale or hand-edited. Run: node scripts/generate_d52_closure_summary.mjs`);
      process.exit(1);
    }
    console.log(`D52_DOC_PASS: ${D52_SUMMARY} exactly regenerates from its JSON authorities.`);
    return;
  }
  fs.writeFileSync(target, expected, "utf8");
  console.log(`${actual === expected ? "up-to-date" : "regenerated"}: ${D52_SUMMARY}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
