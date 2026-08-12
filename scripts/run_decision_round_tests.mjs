#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { planQuestions } from "./lib/flow_questions.mjs";

const supplied = process.argv[2] ?? process.env.DECISION_ROUND_CASE;
let fixture;
if (supplied) {
  fixture = JSON.parse(await fs.readFile(path.resolve(supplied), "utf8"));
} else {
  const cases = path.resolve(
    process.env.DEBT_OVERLAY_CASES_DIR ??
      "/Users/archiepreston/Documents/Codex/2026-07-24/ok/work/v2-certification/cases",
  );
  const generated = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-decision-round.")),
    "compiled-case.json",
  );
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./run_evidence_run_tests.mjs", import.meta.url)),
      cases,
      "--emit-compiled-case",
      generated,
    ],
    { stdio: "ignore" },
  );
  const base = JSON.parse(
    await fs.readFile(generated, "utf8"),
  );
  const noQuestions = JSON.parse(
    await fs.readFile(new URL("./flow-fixtures/no-questions.json", import.meta.url), "utf8"),
  );
  const extraMaturities = Array.from({ length: 6 }, (_, index) => ({
    instrument_id: `decision_round_note_${index + 1}`,
    source_row: `decision.round.${index + 1}`,
    description: `Senior notes ${index + 1}`,
    instrument_type: "fixed_bond",
    currency: base.issuer.reporting_currency,
    outstanding_amount: 50,
    maturity_date: `${2026 + (index % 3)}-12-31`,
    maturity_precision: "day",
    maturity_treatment: "contractual",
    rate_type: "fixed",
    coupon_rate: 0.05,
    refinancing_intent: null,
  }));
  base.instruments.push(
    ...extraMaturities.map((row, index) => ({
      instrument_id: row.instrument_id,
      display_order: 10 + index,
      name: row.description,
      class: row.instrument_type,
      currency: row.currency,
      balance_basis: "native_principal",
      opening_balance: row.outstanding_amount,
      maturity_date: row.maturity_date,
      maturity_precision: row.maturity_precision,
      maturity_treatment: row.maturity_treatment,
      scheduled_amortisation: [0, 0, 0],
      new_issuance: [0, 0, 0],
      rate_type: "fixed",
      coupon_or_all_in_rate: [row.coupon_rate, row.coupon_rate, row.coupon_rate],
      facility_capacity: null,
      include_in_gross_debt: true,
      include_in_net_debt: true,
      cash_interest: true,
      source_line_ids: [],
      other_non_cash_movement: [0, 0, 0],
    })),
  );
  fixture = { draft_case: base, intake: structuredClone(noQuestions.intake) };
  fixture.intake.export.instruments.push(...extraMaturities);
}
const plan = planQuestions({
  draftCase: fixture.draft_case,
  intake: fixture.intake,
  reconciliation: fixture.reconciliation ?? null,
  limit: 5,
});
if (process.env.DECISION_ROUND_DEBUG === "1") {
  process.stderr.write(`${JSON.stringify({ status: plan.status, detected: plan.detected, candidates: plan.candidates, blocked: plan.blocked, assumptions: plan.assumptions, survivors: plan.survivors.map((entry) => entry.id) }, null, 2)}\n`);
}
if (plan.status === "inputs_look_wrong") throw new Error("question cardinality still masquerades as bad evidence");
if (plan.survivors.length <= 5) throw new Error(`fixture did not produce more than five material decisions (${plan.survivors.length})`);
if (plan.status !== "ask" || plan.questions.length !== 5) throw new Error("first decision batch is not exactly five");
if (plan.remaining_question_count !== plan.survivors.length - 5) throw new Error("remaining question count is not preserved");
if (plan.pending_questions.length !== plan.remaining_question_count) throw new Error("pending question identities are not preserved");
process.stdout.write(`${JSON.stringify({ status: "PASS", survivor_count: plan.survivors.length, current_round_count: plan.questions.length, remaining_question_count: plan.remaining_question_count ?? 0 })}\n`);
