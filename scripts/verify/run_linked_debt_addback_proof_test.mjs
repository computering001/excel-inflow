#!/usr/bin/env node
/** Positive + mutation regression for a debt-linked cash add-back that matures. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, "..");

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600000,
    ...options,
  });
}

const casePath = process.argv[2];
const python = process.argv[3] ?? "python3";
if (!casePath) {
  console.error("usage: run_linked_debt_addback_proof_test.mjs representative-v2-case.json [python]");
  process.exit(2);
}
const source = JSON.parse(fs.readFileSync(casePath, "utf8"));
// This harness mutates an archived representative case outside the production
// evidence route.  Mark it explicitly as reference parity so the production
// compiler contracts are neither invented nor weakened for a test fixture.
source.execution_profile = "reference_parity";
const rcfId = source.rcf_policy?.instrument_id;
const linked = (source.instruments ?? []).find((instrument) =>
  instrument.instrument_id !== rcfId
  && instrument.class !== "lease"
  && instrument.include_in_gross_debt !== false
  && instrument.include_in_net_debt !== false
  && Number(instrument.opening_balance ?? 0) > 0
  && String(instrument.maturity_date ?? "") <= String(source.periods?.[3]?.date ?? ""),
);
if (!linked) throw new Error("representative case has no linked-debt candidate that matures in FY1");

const oldCash = source.cash_policy ?? {};
if (Array.isArray(oldCash.buckets)) throw new Error("representative case already uses explicit cash buckets");
const historical = [...(oldCash.historical_year_end_cash ?? [0, 0, 0])];
const linkedOpening = Number(linked.opening_balance);
historical[2] = Math.max(0, Number(historical[2] ?? 0) - linkedOpening);
const endingCashRow = (source.statement_structure?.cash_flow ?? []).find(
  (row) => row.semantic_role === "ending_cash" || row.row_id === "ending_cash",
);
if (!endingCashRow) throw new Error("representative case has no cash-flow ending-cash row");
endingCashRow.reported_historical_values = [...historical];
endingCashRow.values = [...historical, null, null, null];
source.cash_policy = {
  minimum_cash_override: oldCash.minimum_cash_override ?? null,
  interest_income_cash_flow_classification:
    oldCash.interest_income_cash_flow_classification ?? "investing",
  buckets: [
    {
      bucket_id: "balancing_cash",
      label: "Cash and cash equivalents",
      historical_year_end: historical,
      forecast_treatment: "balancing",
      included_in_cash_flow_cash: true,
      available_for_liquidity: true,
      net_debt_eligible_percentage: Number(oldCash.eligible_cash_percentage ?? 1),
      interest_eligible_percentage: 1,
      cash_yield: [...(oldCash.cash_yield ?? [0, 0, 0])],
    },
    {
      bucket_id: "linked_debt_addback",
      label: "Debt-linked cash add-back",
      historical_year_end: [0, 0, linkedOpening],
      forecast_treatment: "linked_debt_addback",
      included_in_cash_flow_cash: false,
      linked_instrument_ids: [linked.instrument_id],
      available_for_liquidity: false,
      net_debt_eligible_percentage: 1,
      interest_eligible_percentage: 0,
      cash_yield: [0, 0, 0],
    },
  ],
};
source.case_id = `${source.case_id}-linked-debt-addback-proof`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-linked-proof-"));
const derivedCase = path.join(work, "case.json");
const workbook = path.join(work, "model.xlsx");
const financeReport = path.join(work, "finance-proof.json");
const mutations = path.join(work, "mutations");
fs.writeFileSync(derivedCase, `${JSON.stringify(source, null, 2)}\n`);
run(process.execPath, [path.join(SCRIPTS, "build_dynamic_model.mjs"), derivedCase, "--plan-only", "--out", workbook]);
run(python, [path.join(SCRIPTS, "emit", "__main__.py"), "build", `${workbook}.plan.json`, "--out", workbook]);
run(python, [path.join(HERE, "finance_proof.py"), derivedCase, workbook, "--out", financeReport]);
run(python, [path.join(HERE, "run_finance_proof_mutations.py"), derivedCase, workbook, "--out", mutations]);

const finance = JSON.parse(fs.readFileSync(financeReport, "utf8"));
const mutation = JSON.parse(fs.readFileSync(path.join(mutations, "finance-proof-mutations.json"), "utf8"));
const linkedMutation = mutation.mutations.find((item) => item.id === "linked-debt-cash-bucket");
const report = {
  schema_version: "linked-debt-addback-proof-test/1.0",
  status: finance.status === "PASS" && mutation.status === "PASS" && linkedMutation?.status === "PASS"
    ? "PASS" : "FAIL",
  linked_instrument_id: linked.instrument_id,
  expected_fy1_ending_balance: 0,
  finance_status: finance.status,
  finance_violations: finance.summary?.violations ?? null,
  mutation_status: mutation.status,
  linked_mutation_status: linkedMutation?.status ?? "MISSING",
  work_folder: work,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === "PASS" ? 0 : 1;
