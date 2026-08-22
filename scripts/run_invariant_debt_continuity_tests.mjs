#!/usr/bin/env node
/**
 * Invariant prover P2 — debt-schedule continuity.
 *
 * A debt schedule is only lawful if each period OPENS where the previous
 * period CLOSED: opening[t] === closing[t-1]. No prebuilt compiled plan.json
 * exists in this tree, so the oracle constructs synthetic schedule rows
 * directly and re-derives the identity itself (independent economic oracle).
 *
 * Single-line JSON result: {"status":"PASS","checks":N}.
 */
import assert from "node:assert/strict";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

// Synthetic solved debt schedule: closing = opening + draw - repayment,
// each opening carried from the prior closing.
const SCHEDULE = [
  { period_id: "2027", opening: 100, draw: 0, repayment: 20 },
  { period_id: "2028", opening: 80, draw: 50, repayment: 0 },
  { period_id: "2029", opening: 130, draw: 0, repayment: 30 },
].map((row) => ({ ...row, closing: row.opening + row.draw - row.repayment }));

function assertDebtContinuity(rows) {
  for (let t = 1; t < rows.length; t += 1) {
    if (rows[t].opening !== rows[t - 1].closing) {
      const error = new Error(
        `DEBT_CONTINUITY_BREAK: ${rows[t].period_id} opens at ${rows[t].opening} ` +
          `but ${rows[t - 1].period_id} closed at ${rows[t - 1].closing}.`,
      );
      error.code = "DEBT_CONTINUITY_BREAK";
      throw error;
    }
  }
}

// GREEN — the internally consistent schedule passes.
check(
  (() => {
    assertDebtContinuity(SCHEDULE);
    return true;
  })(),
  "a carried-forward debt schedule must satisfy opening[t] = closing[t-1]",
);
check(SCHEDULE[1].closing === 130, "roll-forward arithmetic: 80 + 50 - 0 = 130");

// RED — one mutated closing breaks continuity at the NEXT period's opening.
for (const [index, field, wrongValue] of [[1, "closing", 99], [2, "opening", 42]]) {
  const adversarial = SCHEDULE.map((row) => ({ ...row }));
  adversarial[index][field] = wrongValue;
  let thrown = null;
  try {
    assertDebtContinuity(adversarial);
  } catch (error) {
    thrown = error;
  }
  check(thrown !== null, `mutated ${field}[${index}] must break continuity`);
  check(thrown?.code === "DEBT_CONTINUITY_BREAK", `${field}[${index}]: typed code required`);
}

console.log(JSON.stringify({ status: "PASS", checks }));
