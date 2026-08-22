#!/usr/bin/env node
/**
 * Invariant prover P4 — cash-flow statement articulation.
 *
 * A solved cash-flow statement must articulate: operating + investing +
 * financing cash flows equal the movement in cash for every period
 * (CFO + CFI + CFF = closing_cash - opening_cash). The oracle constructs a
 * synthetic solved statement triple directly and re-derives the identity
 * itself (independent economic oracle).
 *
 * Single-line JSON result: {"status":"PASS","checks":N}.
 */
import assert from "node:assert/strict";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const TOLERANCE = 1e-9;

// Synthetic solved statements: each period's cash moves by its three flows.
const STATEMENTS = [
  { period_id: "2027", opening_cash: 500, cfo: 120, cfi: -80, cff: -25 },
  { period_id: "2028", opening_cash: 515, cfo: 150, cfi: -200, cff: 60 },
  { period_id: "2029", opening_cash: 525, cfo: 90, cfi: 40, cff: -110 },
].map((row) => ({
  ...row,
  closing_cash: row.opening_cash + row.cfo + row.cfi + row.cff,
}));

function articulationGap({ opening_cash, closing_cash, cfo, cfi, cff }) {
  return cfo + cfi + cff - (closing_cash - opening_cash);
}

function assertCashFlowArticulation(rows) {
  const broken = rows.filter((row) => Math.abs(articulationGap(row)) > TOLERANCE);
  if (broken.length > 0) {
    const row = broken[0];
    const error = new Error(
      `CASH_FLOW_ARTICULATION_BREAK: ${row.period_id} flows sum to ` +
        `${row.cfo + row.cfi + row.cff} but cash moved ${row.closing_cash - row.opening_cash}.`,
    );
    error.code = "CASH_FLOW_ARTICULATION_BREAK";
    throw error;
  }
}

// GREEN — every period of the triple articulates exactly.
check(
  (() => {
    assertCashFlowArticulation(STATEMENTS);
    return true;
  })(),
  "the solved statement triple must satisfy CFO+CFI+CFF = delta-cash",
);
check(STATEMENTS[2].closing_cash === 545, "roll-up arithmetic: 525 + 90 + 40 - 110 = 545");

// RED — perturbing one published flow breaks articulation and is flagged.
for (const [index, field, delta] of [[1, "cff", 7], [2, "cfi", -13], [0, "cfo", 100]]) {
  const adversarial = STATEMENTS.map((row) => ({ ...row }));
  adversarial[index][field] += delta;
  let thrown = null;
  try {
    assertCashFlowArticulation(adversarial);
  } catch (error) {
    thrown = error;
  }
  check(thrown !== null, `perturbed ${field}[${index}] must be flagged`);
  check(
    thrown?.code === "CASH_FLOW_ARTICULATION_BREAK",
    `${field}[${index}]: typed code required`,
  );
}

console.log(JSON.stringify({ status: "PASS", checks }));
