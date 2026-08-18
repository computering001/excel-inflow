#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  compileStructuralOwnershipPreflight,
  verifyStructuralOwnershipPreflight,
} from "./lib/forecast_ownership_resolver.mjs";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

async function readJson(target, label) {
  const value = JSON.parse(await fs.readFile(path.resolve(target), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value;
}

function projectedCase(filingsBundle, demandGraph) {
  const filings = filingsBundle?.filings ?? filingsBundle;
  const demandBySource = new Map();
  const demandByMetric = new Map();
  for (const node of demandGraph?.nodes ?? []) {
    if (node?.source_line_id && node?.metric_id) {
      const key = String(node.source_line_id);
      const current = demandBySource.get(key) ?? [];
      current.push(node);
      demandBySource.set(key, current);
    }
    if (node?.metric_id) {
      const key = String(node.metric_id);
      const current = demandByMetric.get(key) ?? [];
      current.push(node);
      demandByMetric.set(key, current);
    }
  }
  const projectRows = (section) => {
    const sources = filings?.[section] ?? [];
    const rowIdFor = (source, index) =>
      String(source?.row_id ?? source?.source_line_id ?? `${section}_${index + 1}`);
    const rowIdBySource = new Map(
      sources.map((source, index) => [String(source?.source_line_id ?? ""), rowIdFor(source, index)]),
    );
    const rowIdsByLabel = new Map();
    for (const [index, source] of sources.entries()) {
      const label = String(source?.label ?? source?.raw_label ?? "").trim().toLowerCase();
      if (!label) continue;
      const rowIds = rowIdsByLabel.get(label) ?? [];
      rowIds.push(rowIdFor(source, index));
      rowIdsByLabel.set(label, rowIds);
    }
    return sources.map((source, index) => {
      const row = structuredClone(source);
      row.row_id = rowIdFor(source, index);
      const explicitParent =
        row.parent_row_id ?? row.parent_source_line_id ?? null;
      const parentFromSource = explicitParent
        ? rowIdBySource.get(String(explicitParent)) ?? String(explicitParent)
        : null;
      const parentLabel = String(row.parent_label ?? "").trim().toLowerCase();
      const parentFromLabel = parentLabel && rowIdsByLabel.get(parentLabel)?.length === 1
        ? rowIdsByLabel.get(parentLabel)[0]
        : null;
      if (parentFromSource || parentFromLabel) {
        row.parent_row_id = parentFromSource ?? parentFromLabel;
      }
      const demandedNodes =
        demandBySource.get(String(row.source_line_id ?? "")) ??
        demandByMetric.get(String(row.broker_metric_id ?? row.semantic_role ?? row.row_id));
      if (demandedNodes?.length) {
        row.broker_metric_id = String(demandedNodes[0].metric_id);
        row.broker_demand_node_ids = demandedNodes
          .map((node) => String(node.node_id))
          .sort();
      }
      return row;
    });
  };
  return {
    case_id: String(demandGraph?.run_id ?? filingsBundle?.run_id ?? "pre_broker_structural"),
    statement_structure: {
      income_statement: projectRows("income_statement"),
      cash_flow: projectRows("cash_flow"),
    },
  };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (positional.length !== 2 || !options.out) {
    throw new Error(
      "Usage: run_structural_ownership_preflight.mjs <filings-bundle.json> <pre-broker-demand.json> --out <receipt.json> [--verify <receipt.json>]",
    );
  }
  const filingsBundle = await readJson(positional[0], "filings bundle");
  const demandGraph = await readJson(positional[1], "pre-broker demand graph");
  const modelCase = projectedCase(filingsBundle, demandGraph);
  let receipt;
  if (options.verify) {
    receipt = await readJson(options.verify, "structural ownership receipt");
    verifyStructuralOwnershipPreflight(modelCase, receipt);
  } else {
    receipt = compileStructuralOwnershipPreflight(modelCase);
    verifyStructuralOwnershipPreflight(modelCase, receipt);
  }
  const target = path.resolve(options.out);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: receipt.status, receipt: target, receipt_sha256: receipt.receipt_sha256 })}\n`);
  if (receipt.status !== "PASS") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
