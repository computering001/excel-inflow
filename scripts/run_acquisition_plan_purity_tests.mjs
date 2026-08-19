#!/usr/bin/env node
// P5.1a — ACQUISITION PLAN PURITY.
//
// The invariant this suite proves: every economic value the funded-acquisition
// overlay contributes enters through the PLAN — recorded plan operations,
// derivable from (rowPlan, modelCase) alone, each carrying provenance — and
// never through post-serialisation label matching over sheet XML or plan rows.
// The mutation half of the suite runs the historical label-matching pass
// against a pure plan and demands the purity verifier reject what it wrote.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquisitionTransactionFlows } from "./lib/acquisition_policy.mjs";
import {
  applyFundedAcquisitionPlan,
  applyFundedAcquisitionPlanOperations,
  applyFundedAcquisitionWorkbook,
  planFundedAcquisitionOperations,
  verifyFundedAcquisitionPlanPurity,
} from "./lib/funded_acquisition_plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const check = (fn) => {
  fn();
  checks += 1;
};

// ---------------------------------------------------------------------------
// Fixture — the same funded transaction the transaction suite drives.
// ---------------------------------------------------------------------------
const modelCase = {
  controls: { acquisition: 1 },
  periods: ["2023", "2024", "2025", "2026", "2027", "2028"].map((date, i) => ({
    date,
    status: i < 3 ? "historical" : "forecast",
  })),
  acquisition: {
    enabled: 1,
    mode: "funded_transaction",
    transaction_enterprise_value: 1482.5,
    acquisition_debt_amount: 1187.5,
    entry_ev_to_ebitda: 8.375,
    incremental_rate: 0.0685,
    close_year: 2027,
    close_month: 5,
  },
};

const rowPlan = {
  controls: {
    adjustments_enabled: 4,
    transaction_enterprise_value: 5,
    acquisition_debt_amount: 8,
    close_year: 10,
  },
  statement_rows: {
    cash_flow: [
      { row_id: "acquisitions_net_of_cash", semantic_role: "acquisitions_net_of_cash", row: 65 },
      { row_id: "change_in_debt", semantic_role: "change_in_debt", row: 70 },
      {
        row_id: "debt_issuance",
        semantic_role: "debt_issuance",
        row: 71,
        forecast_treatment: "uncalculated",
        forecast_capture_parent_id: "change_in_debt",
      },
      {
        row_id: "cash_from_investing",
        semantic_role: "cash_from_investing",
        row: 82,
        calculation: { operator: "sum", refs: ["acquisitions_net_of_cash"] },
      },
      {
        row_id: "cash_from_financing",
        semantic_role: "cash_from_financing",
        row: 90,
        calculation: { operator: "sum", refs: ["change_in_debt"] },
      },
      { row_id: "fx_effect_on_cash", semantic_role: "fx_effect_on_cash", row: 101 },
    ],
  },
};

function schemaShapedPlan() {
  const cells = {};
  for (const [row, link] of [
    [65, () => "0"],
    [70, (column) => `${column}115`],
    [101, () => "0"],
  ]) {
    for (const column of ["N", "O", "P"]) {
      cells[`${column}${row}`] = {
        f: `IF($P$4=0,0,${link(column)})`,
        v: row === 70 ? 1459.04 : 0,
        t: "n",
      };
    }
  }
  return {
    plan_version: "1",
    workbook: { sheets: [{ name: "Operating Model", cells }] },
  };
}

// ---------------------------------------------------------------------------
// 1. The recorded plan operations — economics, provenance, consolidation.
// ---------------------------------------------------------------------------
const planned = planFundedAcquisitionOperations(rowPlan, modelCase);
check(() =>
  assert.equal(
    planned.operations.length,
    3,
    "A consolidated Change in Debt parent owns transaction debt through the schedule; only the consideration row takes recorded operations.",
  ),
);
check(() =>
  assert.ok(
    planned.consolidated_schedule_debt === true && planned.debt_proceeds_row === 70,
    "The consolidated schedule-debt decision must be part of the recorded operations.",
  ),
);
check(() => {
  for (const [index, op] of planned.operations.entries()) {
    assert.equal(op.address, `${["N", "O", "P"][index]}65`);
    assert.match(op.formula, /^IF\(\$P\$4=0,0,IF\(20\d\d=\$P\$10,-\$P\$5,0\)\)$/);
    assert.ok(!op.formula.startsWith("="), "recorded formulas are canonical plan text, without '='");
  }
});
check(() => {
  for (const [index, op] of planned.operations.entries()) {
    const flow = acquisitionTransactionFlows(modelCase, index);
    assert.equal(op.cached_value, flow.consideration_cash_flow);
  }
  assert.equal(planned.operations[1].cached_value, -1482.5);
});
check(() => {
  for (const op of planned.operations) {
    assert.equal(op.provenance.source, "funded_acquisition_plan");
    assert.equal(op.provenance.operation, "funded_acquisition_transaction");
    assert.equal(op.provenance.kind, "consideration");
    assert.equal(op.provenance.row_id, "acquisitions_net_of_cash");
    assert.ok(Number.isInteger(op.provenance.period_index));
    assert.ok(Number.isInteger(op.provenance.period_year));
  }
});
// Determinism: the operations are derivable from (rowPlan, modelCase) alone.
check(() =>
  assert.deepEqual(planned.operations, planFundedAcquisitionOperations(rowPlan, modelCase).operations),
);

// A legacy (non-consolidated) plan still records direct proceeds operations.
const legacyRowPlan = structuredClone(rowPlan);
legacyRowPlan.statement_rows.cash_flow = legacyRowPlan.statement_rows.cash_flow
  .filter((row) => row.row_id !== "change_in_debt")
  .map((row) =>
    row.row_id === "debt_issuance"
      ? { row_id: "debt_issuance", semantic_role: "debt_issuance", row: 71 }
      : row.row_id === "cash_from_financing"
        ? { ...row, calculation: { operator: "sum", refs: ["debt_issuance"] } }
        : row,
  );
const legacyPlanned = planFundedAcquisitionOperations(legacyRowPlan, modelCase);
check(() => {
  assert.equal(legacyPlanned.operations.length, 6);
  const proceeds = legacyPlanned.operations.filter((op) => op.provenance.kind === "debt_proceeds");
  assert.equal(proceeds.length, 3);
  assert.equal(proceeds[1].cached_value, 1187.5);
  assert.match(proceeds[1].formula, /\$P\$8/);
});

// ---------------------------------------------------------------------------
// 2. The workbook hook consumes the same recorded operations (one authority).
// ---------------------------------------------------------------------------
const workbookCells = new Map();
for (const rowNumber of [65, 70]) {
  for (const column of ["N", "O", "P"]) {
    workbookCells.set(`${column}${rowNumber}`, {
      formula: rowNumber === 70 ? `=${column}115` : "=0",
      cachedValue: 0,
    });
  }
}
const workbook = {
  sheetByName(name) {
    return name !== "Operating Model"
      ? null
      : {
          cellAt: (address) => workbookCells.get(address),
          setFormulaText(address, formula) {
            const cell = workbookCells.get(address);
            if (!cell) return false;
            cell.formula = formula;
            return true;
          },
          setCachedValue(address, value) {
            const cell = workbookCells.get(address);
            if (!cell) return false;
            cell.cachedValue = value;
            return true;
          },
        };
  },
};
check(() => {
  const result = applyFundedAcquisitionWorkbook(workbook, rowPlan, modelCase);
  assert.equal(result.changed, 3);
  assert.equal(
    workbookCells.get("O65").formula.replace(/^=/, ""),
    planned.operations[1].formula,
    "the workbook hook and the recorded plan operations must write identical formula text",
  );
  assert.equal(workbookCells.get("O65").cachedValue, -1482.5);
  assert.equal(workbookCells.get("O70").formula, "=O115");
});

// ---------------------------------------------------------------------------
// 3. Applying the recorded operations to a serialised plan — by address only.
// ---------------------------------------------------------------------------
const purePlan = schemaShapedPlan();
check(() => {
  const applied = applyFundedAcquisitionPlanOperations(purePlan, rowPlan, modelCase);
  assert.equal(applied.changed, 3);
});
const pureCells = purePlan.workbook.sheets[0].cells;
check(() => {
  assert.equal(pureCells.O65.f, planned.operations[1].formula);
  assert.equal(pureCells.O65.v, -1482.5);
  assert.equal(Math.abs(pureCells.N65.v), 0);
});
check(() => {
  assert.equal(pureCells.O70.f, "IF($P$4=0,0,O115)", "the consolidated Change in Debt row must not be rewritten");
  assert.equal(pureCells.O101.f, "IF($P$4=0,0,0)", "the FX row must never receive transaction economics");
});
check(() => {
  const missing = schemaShapedPlan();
  delete missing.workbook.sheets[0].cells.O65;
  assert.throws(
    () => applyFundedAcquisitionPlanOperations(missing, rowPlan, modelCase),
    /O65/,
    "an operation whose target cell is absent from the plan must fail closed",
  );
});

// ---------------------------------------------------------------------------
// 4. The purity verifier accepts the pure plan…
// ---------------------------------------------------------------------------
check(() => {
  const verdict = verifyFundedAcquisitionPlanPurity(purePlan, rowPlan, modelCase);
  assert.equal(verdict.verified_cells, 3);
  assert.equal(verdict.consolidated_schedule_debt, true);
});

// ---------------------------------------------------------------------------
// 5. …and catches every post-hoc injection.
// ---------------------------------------------------------------------------
// 5a. THE HISTORICAL LABEL-MATCHING PASS ITSELF, run over an addressed-node
// plan the way the captured route once did. It rewrites the consolidated
// Change in Debt row into a direct proceeds hardcode and swaps the recorded
// literal-year formulas for header-discovered ones. Both must be rejected.
const addressedCells = (rowNumber, formula) =>
  ["N", "O", "P"].map((column) => ({
    address: `${column}${rowNumber}`,
    formula: formula(column),
    cached_value: 0,
  }));
const addressedPlan = {
  rows: [
    {
      row_id: "acquisitions_net_of_cash",
      semantic_role: "acquisitions_net_of_cash",
      cells: addressedCells(65, () => "=0"),
    },
    {
      row_id: "change_in_debt",
      semantic_role: "change_in_debt",
      cells: addressedCells(70, (column) => `=${column}115`),
    },
    {
      row_id: "fx_effect_on_cash",
      semantic_role: "fx_effect_on_cash",
      cells: addressedCells(101, () => "=0"),
    },
  ],
};
check(() => {
  const pureAddressed = structuredClone(addressedPlan);
  applyFundedAcquisitionPlanOperations(pureAddressed, rowPlan, modelCase);
  const verdict = verifyFundedAcquisitionPlanPurity(pureAddressed, rowPlan, modelCase);
  assert.equal(verdict.verified_cells, 3, "the verifier must read addressed-node plans as well as schema plans");
});
check(() => {
  const injected = structuredClone(addressedPlan);
  const labelPass = applyFundedAcquisitionPlan(injected, modelCase);
  assert.equal(labelPass.changed, 6, "precondition: the label pass injects six cells, including the consolidated debt parent");
  assert.throws(
    () => verifyFundedAcquisitionPlanPurity(injected, rowPlan, modelCase),
    /purity/i,
    "THE POST-HOC-INJECTION MUTATION: label-matched economics must be rejected by the plan contract",
  );
});
// 5b. A direct proceeds hardcode smuggled onto the consolidated debt parent.
check(() => {
  const injected = structuredClone(purePlan);
  injected.workbook.sheets[0].cells.O70.f = "IF($P$4=0,0,IF(2027=$P$10,$P$8,0))";
  injected.workbook.sheets[0].cells.O70.v = 1187.5;
  assert.throws(
    () => verifyFundedAcquisitionPlanPurity(injected, rowPlan, modelCase),
    /O70/,
    "a second financing writer on the consolidated parent must be rejected",
  );
});
// 5c. A cache tampered after serialisation.
check(() => {
  const tampered = structuredClone(purePlan);
  tampered.workbook.sheets[0].cells.O65.v = -1483.5;
  assert.throws(() => verifyFundedAcquisitionPlanPurity(tampered, rowPlan, modelCase), /O65/);
});
// 5d. A formula rewritten to a value the plan operations cannot derive.
check(() => {
  const rewritten = structuredClone(purePlan);
  rewritten.workbook.sheets[0].cells.O65.f = "IF($P$4=0,0,IF(2027=$P$10,-1482.5,0))";
  assert.throws(() => verifyFundedAcquisitionPlanPurity(rewritten, rowPlan, modelCase), /O65/);
});

// ---------------------------------------------------------------------------
// 6. The build is wired through the recorded operations, not the label pass.
// ---------------------------------------------------------------------------
const builderSource = fs.readFileSync(
  path.join(root, "scripts", "build_dynamic_model.mjs"),
  "utf8",
);
check(() =>
  assert.doesNotMatch(
    builderSource,
    /applyFundedAcquisitionPlan\(/,
    "build_dynamic_model.mjs still runs the post-serialisation label-matching pass over a serialised plan",
  ),
);
check(() =>
  assert.match(
    builderSource,
    /applyFundedAcquisitionPlanOperations\(\s*plan,\s*rowPlan,\s*modelCase\s*\)/,
    "the captured plan must receive the funded transaction through recorded plan operations",
  ),
);
check(() =>
  assert.ok(
    (builderSource.match(/verifyFundedAcquisitionPlanPurity\(/g) ?? []).length >= 2,
    "every serialised plan the build ships (captured and synthesised) must pass the purity verifier",
  ),
);

console.log(JSON.stringify({ status: "PASS", checks }));
