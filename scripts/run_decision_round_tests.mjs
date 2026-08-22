#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createRunner } from "./lib/test_harness.mjs";
import { planQuestions } from "./lib/flow_questions.mjs";
import { sealForecastAuthorityLedger } from "./lib/forecast_authority_ledger.mjs";

const run = createRunner({ name: "decision_round_tests", importMetaUrl: import.meta.url });

const supplied = process.argv[2] ?? process.env.DECISION_ROUND_CASE;
let fixture;
if (supplied) {
  fixture = JSON.parse(await fs.readFile(path.resolve(supplied), "utf8"));
} else {
  const cases = path.resolve(
    process.env.DEBT_OVERLAY_CASES_DIR ??
      fileURLToPath(new URL("../test-fixtures/cases", import.meta.url)),
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
  const unresolvedIntents = [null, "ask", "unclear", "unknown", null, "ask"];
  const extraMaturities = Array.from({ length: 6 }, (_, index) => ({
    instrument_id: `decision_round_note_${index + 1}`,
    source_row: `decision.round.${index + 1}`,
    description: `Senior notes ${index + 1}`,
    instrument_type: "bond_fixed",
    currency: base.issuer.reporting_currency,
    outstanding_amount: 50,
    maturity_date: `${2026 + (index % 3)}-12-31`,
    maturity_precision: "day",
    maturity_treatment: "contractual",
    rate_type: "fixed",
    coupon_rate: 0.05,
    refinancing_intent: unresolvedIntents[index],
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
  // The ownership census now covers instrument schedule cells as well as
  // statement rows, so this deliberate instrument mutation must be resealed
  // before the decision-planning layer verifies the compiled case.
  sealForecastAuthorityLedger(base);
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
const maturityQuestions = (plan.detected ?? []).filter((entry) => entry.kind === "refinance_at_maturity");
run.ok(maturityQuestions.length === 0, "toggle-covered maturities still produced questions");
run.ok(!(plan.survivors ?? []).some((entry) => entry.kind === "refinance_at_maturity"), "toggle-covered maturities survived deterministic pruning");
run.ok(!(plan.pending_questions ?? []).some((id) => id.startsWith("refinance_at_maturity:")), "toggle-covered maturities leaked into a second decision round");

const malformedLeaseFixture = structuredClone(fixture);
delete malformedLeaseFixture.draft_case.lease_policy.include_in_leverage;
malformedLeaseFixture.draft_case.lease_policy.historical_liabilities[2] = "";
malformedLeaseFixture.intake.filings.leverage_basis = null;
sealForecastAuthorityLedger(malformedLeaseFixture.draft_case);
run.throws(
  () => planQuestions({
    draftCase: malformedLeaseFixture.draft_case,
    intake: malformedLeaseFixture.intake,
    reconciliation: malformedLeaseFixture.reconciliation ?? null,
    limit: 5,
  }),
  /historical_liabilities must contain three finite financial numbers/,
  "lease decision detector refuses a blank reported liability instead of treating it as zero",
);
run.finish({
  maturity_question_count: 0,
  pending_maturity_question_count: 0,
  total_violation_count: 0,
});
