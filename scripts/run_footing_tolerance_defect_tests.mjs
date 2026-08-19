#!/usr/bin/env node
/**
 * P2.10 — one footing oracle, one classification requirement, one unit scale.
 *
 * Three defects from programme/gap-reports/DEFECT_REGISTER.md, all instances of
 * the same invariant failure: a validator must not disagree with itself, and a
 * missing/blank/nil cell must never become a zero NOR silently escape.
 *
 * RED PROOFS (verified against the tree at 85ac6f2, before this package):
 *
 *  D5  members 12.3 + 45.6 against printed 57.9, no declared precision:
 *      sourceHistoricalSumMatches() === false  (case_compiler.sourceTolerance
 *      returned EXACTLY 0) while compileModelIrV3() returned PASS with zero
 *      family findings (model_ir_v3.footingTolerance added 1e-9 * max(1,|t|)).
 *      Two oracles, identical figures, opposite verdicts.
 *      Second red, the OTHER direction: a genuine 1-unit mis-footing on a
 *      500,000,000 total printed at precision 0 PASSED the footing pass,
 *      because 1e-9 * 5e8 exactly doubled the half-unit rounding tolerance.
 *
 *  D6  a material family total filed as [null, null, null] against members
 *      summing to 30 compiled PASS with ZERO findings ("a filed dash asserts
 *      nothing"), while the same dash carrying a reported_zero classification
 *      BLOCKED on all three periods. Nothing forced the printed glyph to be
 *      classified, so a genuine reported nil escaped verification entirely.
 *
 *  D9  standard-maximal-v2 with every printed unit witness rewritten from
 *      "USD millions" to "USD thousands" — a UNIFORM 1000x scale
 *      contradiction — compiled PASS with zero findings. The figures foot
 *      perfectly (every member and its total share the same wrong scale), so
 *      footing can never see it.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { compileModelIrV3 } from "./lib/model_ir_v3.mjs";
import { sourceHistoricalSumMatches } from "./lib/case_compiler.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import { compileInstrumentPeriodState } from "./lib/instrument_period_state.mjs";
import {
  DECLARED_ABSENCE_STATES,
  VALUE_BEARING_STATES,
  filedCellAssertion,
  floatNoiseTolerance,
  printedUnitMagnitude,
  sourceTolerance,
} from "./lib/source_tolerance.mjs";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

// ---------------------------------------------------------------------------
// Harness: the same synthetic statement family P2.5's suite uses, so the two
// footing oracles can be pointed at byte-identical figures.
// ---------------------------------------------------------------------------
function statementNode(id, extra = {}) {
  return {
    node_id: `statement.${id}`,
    node_kind: "statement_row",
    row_id: id,
    label: id,
    section: "cash_flow",
    semantic_role: null,
    projection_status: "rendered",
    physical_row: extra.physical_row ?? 10,
    row_type: "input",
    forecast_authorities: [],
    ...extra,
  };
}

function compileFamily({ totalValues, memberValues, options = {} }) {
  const nodes = [
    statementNode("family_total", {
      physical_row: 10,
      forecast_authorities: options.immaterial
        ? []
        : [{ forecast_index: 0, method: "user_assumption", material: true }],
      aggregation_authority: "reported_parent",
    }),
  ];
  const planRows = [
    {
      row_id: "family_total",
      row: 10,
      row_type: "input",
      historical_authority: "source_input",
      aggregation_authority: "reported_parent",
      values: totalValues,
      ...(options.totalPrecisions
        ? { historical_value_precisions: options.totalPrecisions }
        : {}),
      ...(options.totalStates
        ? { historical_value_states: options.totalStates }
        : {}),
    },
  ];
  memberValues.forEach((values, index) => {
    const id = `member_${index}`;
    nodes.push(
      statementNode(id, {
        physical_row: 11 + index,
        parent_row_id: "family_total",
        aggregation_role: "working_child",
      }),
    );
    planRows.push({
      row_id: id,
      row: 11 + index,
      row_type: "input",
      historical_authority: "source_input",
      parent_row_id: "family_total",
      aggregation_role: "working_child",
      values,
    });
  });
  return compileModelIrV3({
    modelCase: {},
    rowPlan: { statement_rows: { income_statement: [], cash_flow: planRows } },
    semanticManifest: {
      case_id: "p210-footing-tolerance",
      case_sha256: "0".repeat(64),
      accounting_basis: "ifrs",
      source_inventory: [],
      edges: [],
      nodes,
    },
    sourceCrosswalk: [],
  });
}

const familyFindings = (ir, code) =>
  [...ir.proof.blocking_findings, ...ir.proof.warnings].filter(
    (item) => item.code === code,
  );
const allFamilyFindings = (ir) =>
  [...ir.proof.blocking_findings, ...ir.proof.warnings].filter((item) =>
    item.code.startsWith("STATEMENT_FAMILY_"),
  );

// The SAME figures put to both oracles. The manifest-line shape the case
// compiler reads and the row-plan shape the model IR reads carry the identical
// numbers; only the field names differ.
function bothOracles({ total, members, precisions = null }) {
  const line = (values) => ({
    reported_historical_values: values,
    ...(precisions ? { value_precisions: precisions } : {}),
  });
  const compilerVerdict = sourceHistoricalSumMatches(
    line(total),
    members.map((values) => ({ reported_historical_values: values })),
  );
  const ir = compileFamily({
    totalValues: total,
    memberValues: members,
    options: precisions ? { totalPrecisions: precisions } : {},
  });
  const modelVerdict =
    familyFindings(ir, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 0;
  return { compilerVerdict, modelVerdict, ir };
}

// ===========================================================================
// D5 — one tolerance function, one home, both callers consuming it.
// ===========================================================================

// (1) RED PROOF, direction A: IEEE754 representation noise is not a
//     mis-footing. 12.3 + 45.6 === 57.900000000000006, so an exact-zero
//     tolerance rejects arithmetic that is correct to every printed digit.
{
  check(
    12.3 + 45.6 !== 57.9,
    "the reproduction rests on a real IEEE754 residue, not a typo",
  );
  const { compilerVerdict, modelVerdict } = bothOracles({
    total: [57.9, 57.9, 57.9],
    members: [
      [12.3, 12.3, 12.3],
      [45.6, 45.6, 45.6],
    ],
  });
  check(
    compilerVerdict === true,
    "float-representation residue must not be reported as a source mis-footing",
  );
  check(
    modelVerdict === true,
    "the footing pass agrees: float residue is not an unfooted total",
  );
}

// (2) RED PROOF, direction B: the previously LOOSER oracle let a genuine
//     mis-footing through. 1e-9 * 500_000_000 exactly doubled the half-unit
//     rounding tolerance at precision 0, so a real 1-unit break PASSED.
{
  const legacyFootingTolerance =
    0.5 * 10 ** -0 + 1e-9 * Math.max(1, Math.abs(500_000_000)) + 1e-12;
  check(
    Math.abs(1) <= legacyFootingTolerance,
    "the pre-repair footing tolerance did admit a whole-unit break at this scale",
  );
  const { compilerVerdict, modelVerdict, ir } = bothOracles({
    total: [500_000_000, 500_000_000, 500_000_000],
    members: [
      [300_000_000, 300_000_000, 300_000_000],
      [200_000_001, 200_000_001, 200_000_001],
    ],
    precisions: [0, 0, 0],
  });
  check(
    compilerVerdict === false,
    "a whole printed unit of break is a mis-footing at any scale (compiler)",
  );
  check(
    modelVerdict === false,
    "a whole printed unit of break is a mis-footing at any scale (footing pass)",
  );
  check(
    ir.proof.status === "BLOCK" &&
      familyFindings(ir, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 3,
    "unifying the tolerance did not make the looser oracle's verdict the answer",
  );
}

// (3) MATERIAL MIS-FOOTING CONTROL: a break that matters must still BLOCK, and
//     both oracles must say so.
{
  const { compilerVerdict, modelVerdict, ir } = bothOracles({
    total: [100, 100, 100],
    members: [
      [60, 60, 60],
      [30, 30, 30],
    ],
  });
  check(compilerVerdict === false, "a 10-unit material break fails the compiler oracle");
  check(modelVerdict === false, "a 10-unit material break fails the footing oracle");
  check(
    ir.proof.status === "BLOCK" &&
      ir.proof.blocking_findings.some(
        (item) =>
          item.code === "STATEMENT_FAMILY_UNFOOTED_TOTAL" &&
          item.filed === 100 &&
          item.members_sum === 90,
      ),
    "the material mis-footing control BLOCKS with its provenance intact",
  );
}

// (4) The two oracles agree across a grid spanning every tolerance regime:
//     exact, float residue, inside/outside declared rounding, and material.
{
  const grid = [
    { name: "exact", total: [90, 90, 90], members: [[60, 60, 60], [30, 30, 30]] },
    {
      name: "float-residue",
      total: [0.3, 0.3, 0.3],
      members: [[0.1, 0.1, 0.1], [0.2, 0.2, 0.2]],
    },
    {
      name: "inside-declared-rounding",
      total: [90.4, 90.4, 90.4],
      members: [[60, 60, 60], [30, 30, 30]],
      precisions: [0, 0, 0],
    },
    {
      name: "outside-declared-rounding",
      total: [90.6, 90.6, 90.6],
      members: [[60, 60, 60], [30, 30, 30]],
      precisions: [0, 0, 0],
    },
    {
      name: "sub-unit-break-at-scale",
      total: [500_000_000.4, 500_000_000.4, 500_000_000.4],
      members: [[300_000_000, 300_000_000, 300_000_000], [200_000_000, 200_000_000, 200_000_000]],
      precisions: [0, 0, 0],
    },
    {
      name: "material",
      total: [1000, 1000, 1000],
      members: [[600, 600, 600], [300, 300, 300]],
    },
    {
      name: "cancelling-long-family",
      total: [0, 0, 0],
      members: Array.from({ length: 12 }, (_, index) =>
        [0, 1, 2].map(() => (index % 2 === 0 ? 1_000_000.1 : -1_000_000.1)),
      ),
    },
  ];
  for (const item of grid) {
    const { compilerVerdict, modelVerdict } = bothOracles(item);
    check(
      compilerVerdict === modelVerdict,
      `the two footing oracles must agree on identical figures (${item.name}: compiler ${compilerVerdict}, footing ${modelVerdict})`,
    );
  }
  check(grid.length === 7, "the agreement grid covers every tolerance regime");
}

// (5) ANTI-DIVERGENCE MUTATION: neither caller may re-inline tolerance
//     arithmetic. If a future edit mints a second tolerance expression in
//     either file, this fails — the two oracles cannot silently diverge again.
{
  const sources = {
    "scripts/lib/case_compiler.mjs": await fs.readFile(
      new URL("./lib/case_compiler.mjs", import.meta.url),
      "utf8",
    ),
    "scripts/lib/model_ir_v3.mjs": await fs.readFile(
      new URL("./lib/model_ir_v3.mjs", import.meta.url),
      "utf8",
    ),
  };
  for (const [path, text] of Object.entries(sources)) {
    const body = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    check(
      /from "\.\/source_tolerance\.mjs"/.test(body),
      `${path} consumes the shared tolerance home`,
    );
    check(
      !/0\.5\s*\*\s*(?:10\s*\*\*|Math\.pow)/.test(body),
      `${path} does not re-inline a half-unit rounding tolerance`,
    );
    check(
      !/1e-9/.test(body),
      `${path} does not re-inline a hand-picked float epsilon`,
    );
  }
  // The shared home is the ONLY place the arithmetic lives, and it is the
  // arithmetic both callers get.
  check(
    sourceTolerance({ precision: 0, target: 90, terms: [60, 30] }) > 0.5 &&
      sourceTolerance({ precision: 0, target: 90, terms: [60, 30] }) < 0.500001,
    "the shared tolerance is a half printed unit plus IEEE754 noise, nothing more",
  );
  check(
    sourceTolerance({ precision: null, target: 57.9, terms: [12.3, 45.6] }) >=
      Math.abs(12.3 + 45.6 - 57.9),
    "with no declared precision the shared tolerance is exactly the float-noise bound",
  );
  check(
    sourceTolerance({ precision: null, target: 57.9, terms: [12.3, 45.6] }) < 1e-12,
    "the float-noise bound stays far below any printable quantity",
  );
  check(
    sourceTolerance({ precision: 0, target: 5e8, terms: [3e8, 2e8 + 1] }) < 1,
    "the float-noise term can never grow to swallow a whole printed unit",
  );
  // At any scale a statement can actually print, the noise term stays orders of
  // magnitude below materiality: a 16-member family whose absolute values total
  // ten billion units still tolerates less than a thousandth of one unit.
  check(
    floatNoiseTolerance({
      target: 1e10,
      terms: Array.from({ length: 16 }, () => 1e10 / 16),
    }) < 1e-3,
    "the noise floor cannot grow into materiality at real statement scale",
  );
}

// (5b) NO WEAKENING, measured against the tolerance it replaced. For every
//      ordinary statement family the unified tolerance is STRICTLY TIGHTER than
//      the `1e-9 * max(1, |target|)` form it replaces. Where it is looser — a
//      long family whose members cancel — the old form was demonstrably WRONG:
//      it sat below the arithmetic's own error, so it would have refused a
//      family that foots exactly.
{
  const legacyFootingTolerance = (precision, target) =>
    (Number.isInteger(precision) ? 0.5 * 10 ** -precision : 0) +
    1e-9 * Math.max(1, Math.abs(target)) +
    1e-12;
  const ordinary = [
    { precision: null, target: 57.9, terms: [12.3, 45.6] },
    { precision: 0, target: 90, terms: [60, 30] },
    { precision: 1, target: 584.7, terms: [500.2, 84.5] },
    { precision: 0, target: 5e8, terms: [3e8, 2e8] },
    { precision: 2, target: 1234.56, terms: [1000.01, 234.55] },
  ];
  for (const item of ordinary) {
    check(
      sourceTolerance(item) < legacyFootingTolerance(item.precision, item.target),
      `the unified tolerance is tighter than the epsilon it replaced (target ${item.target})`,
    );
  }
  // The cancelling regime: 12 members of ±1,000,000.1 footing to exactly zero.
  const cancelling = Array.from({ length: 12 }, (_, index) =>
    index % 2 === 0 ? 1_000_000.1 : -1_000_000.1,
  );
  const cancellingResidue = Math.abs(
    cancelling.reduce((sum, value) => sum + value, 0) - 0,
  );
  check(
    sourceTolerance({ precision: null, target: 0, terms: cancelling }) >=
      cancellingResidue,
    "a cancelling family that foots exactly is not refused",
  );
  const zeroTarget = compileFamily({
    totalValues: [0, 0, 0],
    memberValues: cancelling.map((value) => [value, value, value]),
    options: { totalStates: ["reported_zero", "reported_zero", "reported_zero"] },
  });
  check(
    familyFindings(zeroTarget, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 0 &&
      zeroTarget.proof.status === "PASS",
    "the cancelling family compiles clean — the tolerance follows the arithmetic",
  );
  // …and a real break inside that same family is still refused.
  const broken = cancelling.map((value, index) =>
    index === 0 ? value + 1 : value,
  );
  const brokenIr = compileFamily({
    totalValues: [0, 0, 0],
    memberValues: broken.map((value) => [value, value, value]),
    options: { totalStates: ["reported_zero", "reported_zero", "reported_zero"] },
  });
  check(
    brokenIr.proof.status === "BLOCK" &&
      familyFindings(brokenIr, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 3,
    "a one-unit break inside the cancelling family still BLOCKS",
  );
}

// ===========================================================================
// D6 — a printed cell must carry a classification; absence of one is a defect.
// ===========================================================================

// (6) RED PROOF: a material family total filed as three nulls, with no declared
//     classification, against members that sum to 30. Pre-repair: PASS, 0
//     findings — the total escaped the footing pass entirely.
{
  const ir = compileFamily({
    totalValues: [null, null, null],
    memberValues: [
      [20, 20, 20],
      [10, 10, 10],
    ],
  });
  const unclassified = familyFindings(
    ir,
    "STATEMENT_FAMILY_UNCLASSIFIED_FILED_CELL",
  );
  check(
    unclassified.length === 3,
    "an unclassified filed total cell is a typed finding on every period",
  );
  check(
    ir.proof.status === "BLOCK",
    "a MATERIAL unclassified printed cell refuses; it does not escape",
  );
  check(
    unclassified.every(
      (item) =>
        item.reason === "no_declared_classification" &&
        item.display_ids.includes("family_total") &&
        Number.isInteger(item.period),
    ),
    "the finding names the row, the period and the missing classification",
  );
  // NEVER-ZERO: the refusal must not be a mis-footing computed off a coerced
  // zero. No total was read, so no sum was compared to one.
  check(
    familyFindings(ir, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 0,
    "an absent cell is never coerced to zero and refused as a mis-footing",
  );
  check(
    unclassified.every((item) => !("filed" in item) && !("members_sum" in item)),
    "the refusal asserts nothing about the cell's numeric value",
  );
}

// (7) The NOT-PRINTED side: a DECLARED absence asserts nothing and is still
//     skipped in silence. This is the distinction the fix must preserve.
{
  for (const state of [...DECLARED_ABSENCE_STATES]) {
    const ir = compileFamily({
      totalValues: [null, null, null],
      memberValues: [
        [20, 20, 20],
        [10, 10, 10],
      ],
      options: { totalStates: [state, state, state] },
    });
    check(
      allFamilyFindings(ir).length === 0 && ir.proof.status === "PASS",
      `a declared ${state} total asserts nothing: no finding, no refusal, no zero`,
    );
  }
  // The empty string is the case compiler's own witness for a printed blank
  // (typedHistoricalStates: "" -> reported_blank); the two files must read it
  // the same way even with no state array declared.
  const blankByValue = compileFamily({
    totalValues: ["", "", ""],
    memberValues: [
      [20, 20, 20],
      [10, 10, 10],
    ],
  });
  check(
    allFamilyFindings(blankByValue).length === 0,
    "a printed blank cell asserts nothing, declared by state or by empty value",
  );
}

// (8) The PRINTED-BUT-UNCLASSIFIED side: a dash glyph recorded as such names
//     the glyph but not its numeric meaning. That is a defect, and a DIFFERENT
//     one from a declared absence.
{
  const ir = compileFamily({
    totalValues: [null, null, null],
    memberValues: [
      [20, 20, 20],
      [10, 10, 10],
    ],
    options: { totalStates: ["reported_dash", "reported_dash", "reported_dash"] },
  });
  const unclassified = familyFindings(
    ir,
    "STATEMENT_FAMILY_UNCLASSIFIED_FILED_CELL",
  );
  check(
    unclassified.length === 3 && ir.proof.status === "BLOCK",
    "a printed dash whose meaning is undeclared is refused, not skipped",
  );
  check(
    unclassified.every(
      (item) =>
        item.reason === "printed_glyph_unclassified" &&
        item.declared_state === "reported_dash",
    ),
    "the printed-glyph defect is typed distinctly from a missing classification",
  );
}

// (9) A classification that CLAIMS a number over an empty cell is its own
//     contradiction, and is typed as one.
{
  const ir = compileFamily({
    totalValues: [null, null, null],
    memberValues: [
      [20, 20, 20],
      [10, 10, 10],
    ],
    options: { totalStates: ["reported_number", "reported_zero", "reported_number"] },
  });
  const unclassified = familyFindings(
    ir,
    "STATEMENT_FAMILY_UNCLASSIFIED_FILED_CELL",
  );
  check(
    unclassified.length === 3 &&
      unclassified.every(
        (item) => item.reason === "value_bearing_state_over_empty_cell",
      ),
    "a value-bearing classification over an empty cell is a typed contradiction",
  );
}

// (10) The classified-zero comparison from the register: the SAME dash read as
//      a genuine reported zero blocks on all three periods. The classification
//      is what decides, and it is now impossible to withhold it silently.
{
  const zero = compileFamily({
    totalValues: [0, 0, 0],
    memberValues: [
      [20, 20, 20],
      [10, 10, 10],
    ],
    options: { totalStates: ["reported_zero", "reported_zero", "reported_zero"] },
  });
  check(
    zero.proof.status === "BLOCK" &&
      familyFindings(zero, "STATEMENT_FAMILY_UNFOOTED_TOTAL").length === 3,
    "a genuine reported nil total contradicting its members is refused",
  );
  check(
    familyFindings(zero, "STATEMENT_FAMILY_UNCLASSIFIED_FILED_CELL").length === 0,
    "a classified cell raises no classification defect",
  );
}

// (11) An IMMATERIAL unclassified cell is recorded, not refused — the region's
//      existing material/immaterial split, unchanged.
{
  const ir = compileFamily({
    totalValues: [null, null, null],
    memberValues: [
      [20, 20, 20],
      [10, 10, 10],
    ],
    options: { immaterial: true },
  });
  check(
    ir.proof.status === "PASS" &&
      ir.proof.warnings.filter(
        (item) => item.code === "STATEMENT_FAMILY_UNCLASSIFIED_FILED_CELL",
      ).length === 3,
    "an immaterial unclassified cell is recorded as a typed warning",
  );
}

// (12) ANTI-DIVERGENCE: the shared classification and the case compiler's
//      numeric reading must not disagree about which states carry a value.
{
  const vocabulary = [
    "reported_number",
    "reported_zero",
    "reported_dash",
    "reported_blank",
    "not_applicable",
    "unresolved",
  ];
  for (const state of vocabulary) {
    const sharedValueBearing =
      filedCellAssertion(
        { historical_value_states: [state, state, state] },
        0,
        1,
      ).kind === "value_bearing";
    const compilerReadsANumber = sourceHistoricalSumMatches(
      {
        reported_historical_values: [1, 1, 1],
        reported_historical_value_states: [state, state, state],
      },
      [{ reported_historical_values: [1, 1, 1] }],
    );
    check(
      sharedValueBearing === compilerReadsANumber,
      `the value-bearing vocabulary agrees across both files for ${state}`,
    );
  }
  check(
    [...VALUE_BEARING_STATES].every((state) => vocabulary.includes(state)) &&
      [...DECLARED_ABSENCE_STATES].every((state) => vocabulary.includes(state)),
    "the classification sets are drawn from the declared state vocabulary",
  );
}

// ===========================================================================
// D9 — a UNIFORM declared-vs-printed scale disagreement, at the compile
// boundary, where footing structurally cannot see it.
// ===========================================================================

const fixture = JSON.parse(
  await fs.readFile(
    new URL("../test-fixtures/cases/standard-maximal-v2.json", import.meta.url),
    "utf8",
  ),
);
const instrumentPeriodState = compileInstrumentPeriodState(fixture);
const fixtureRowPlan = compileRowPlan(fixture, { instrumentPeriodState });
const fixtureManifest = compileSemanticManifest(fixture, fixtureRowPlan, {
  instrumentPeriodState,
});
const compileWithProvenance = (mutate) => {
  const modelCase = JSON.parse(JSON.stringify(fixture));
  mutate(modelCase);
  return compileModelIrV3({
    modelCase,
    rowPlan: fixtureRowPlan,
    semanticManifest: fixtureManifest,
    sourceCrosswalk: [],
  });
};
const unitFindings = (ir, code) =>
  [...ir.proof.blocking_findings, ...ir.proof.warnings].filter(
    (item) => item.code === code,
  );

// (13) The certified fixture as it sits: printed witness "USD millions",
//      declared basis "millions". Agreement mints nothing.
{
  const ir = compileWithProvenance(() => {});
  check(
    unitFindings(ir, "DECLARED_UNIT_SCALE_CONTRADICTED").length === 0 &&
      unitFindings(ir, "UNIT_SCALE_PER_STATEMENT_UNREPRESENTABLE").length === 0 &&
      unitFindings(ir, "PRINTED_UNIT_WITNESS_UNPARSED").length === 0,
    "a printed unit witness agreeing with the declared basis mints no finding",
  );
  check(
    printedUnitMagnitude("USD millions") === "millions",
    "the shared reader parses the certified fixture's printed witness",
  );
}

// (14) RED PROOF: a UNIFORM mis-scale. Every printed witness says thousands,
//      the declaration says millions, and every figure is untouched — so the
//      whole model foots perfectly. Pre-repair: PASS, 0 findings.
{
  const ir = compileWithProvenance((modelCase) => {
    for (const entries of Object.values(modelCase.provenance)) {
      for (const entry of entries) entry.units = "USD thousands";
    }
  });
  const contradicted = unitFindings(ir, "DECLARED_UNIT_SCALE_CONTRADICTED");
  check(
    contradicted.length >= 1,
    "a uniform declared-vs-printed scale contradiction is a typed finding",
  );
  check(
    ir.proof.status === "BLOCK",
    "a uniform 1000x scale contradiction refuses at the compile boundary",
  );
  check(
    contradicted.every(
      (item) =>
        item.printed_units === "thousands" &&
        item.declared_units === "millions" &&
        Array.isArray(item.display_ids) &&
        item.display_ids.length > 0,
    ),
    "the refusal names the printed magnitude, the declared basis and the rows",
  );
  // No footing finding could have caught this: the figures are unchanged.
  const clean = compileWithProvenance(() => {});
  check(
    allFamilyFindings(ir).length === allFamilyFindings(clean).length,
    "the mis-scale changes no footing verdict — footing structurally cannot see it",
  );
}

// (15) The contract limitation, named rather than invented: issuer.units is one
//      enumerated scalar, so two different printed magnitudes have NO lawful
//      representation. That is a typed refusal, not a silently chosen winner.
{
  const ir = compileWithProvenance((modelCase) => {
    const rows = Object.keys(modelCase.provenance);
    for (const entry of modelCase.provenance[rows[0]]) {
      entry.units = "USD thousands";
    }
  });
  const unrepresentable = unitFindings(
    ir,
    "UNIT_SCALE_PER_STATEMENT_UNREPRESENTABLE",
  );
  check(
    unrepresentable.length === 1 && ir.proof.status === "BLOCK",
    "two printed magnitudes in one case is a single typed refusal",
  );
  check(
    unrepresentable[0].printed_magnitudes.join("|") === "millions|thousands" ||
      unrepresentable[0].printed_magnitudes.join("|") === "thousands|millions",
    "the refusal enumerates every printed magnitude it found",
  );
  check(
    /issuer\.units/.test(unrepresentable[0].message) &&
      /single|one/i.test(unrepresentable[0].message),
    "the refusal names the contract limitation instead of picking a scale",
  );
  check(
    unrepresentable[0].contract_limitation === "issuer.units_is_a_single_scalar",
    "the limitation is a typed field, not only prose",
  );
}

// (16) An unparseable printed witness is RECORDED, never invented and never
//      repaired: the model side cannot prove a contradiction from free text.
{
  const ir = compileWithProvenance((modelCase) => {
    for (const entries of Object.values(modelCase.provenance)) {
      for (const entry of entries) entry.units = "USD millions except per share";
    }
  });
  const unparsed = unitFindings(ir, "PRINTED_UNIT_WITNESS_UNPARSED");
  check(unparsed.length >= 1, "an unparseable printed unit witness is recorded");
  check(
    unitFindings(ir, "DECLARED_UNIT_SCALE_CONTRADICTED").length === 0,
    "an unparseable witness proves no contradiction, so it refuses nothing",
  );
  check(
    ir.proof.blocking_findings.every(
      (item) => item.code !== "PRINTED_UNIT_WITNESS_UNPARSED",
    ),
    "inability to verify records; only a proven contradiction blocks",
  );
}

// (17) No printed witness at all mints nothing: the compiler never invents
//      evidence the contract does not carry.
{
  const ir = compileWithProvenance((modelCase) => {
    delete modelCase.provenance;
  });
  check(
    unitFindings(ir, "DECLARED_UNIT_SCALE_CONTRADICTED").length === 0 &&
      unitFindings(ir, "PRINTED_UNIT_WITNESS_UNPARSED").length === 0 &&
      unitFindings(ir, "UNIT_SCALE_PER_STATEMENT_UNREPRESENTABLE").length === 0,
    "a case carrying no printed unit witness is not accused of one",
  );
  const synthetic = compileFamily({
    totalValues: [90, 90, 90],
    memberValues: [
      [60, 60, 60],
      [30, 30, 30],
    ],
  });
  check(
    synthetic.proof.status === "PASS",
    "the unit pass is inert on a case with no issuer and no provenance",
  );
}

// (18) The printed-magnitude reader mirrors the extraction side's vocabulary
//      (scripts/extract_filing_statements.py UNIT_LABEL_MAGNITUDES), so the
//      two reconciliations cannot disagree about what a label says.
{
  const cases = [
    ["USD millions", "millions"],
    ["GBP thousands", "thousands"],
    ["in £000s", "thousands"],
    ["$m", "millions"],
    ["EUR bn", "billions"],
    ["amounts in units", "units"],
    ["(USD millions)", "millions"],
    ["USD millions unless otherwise stated", "millions"],
    ["per share amounts", null],
    ["", null],
  ];
  for (const [label, expected] of cases) {
    check(
      printedUnitMagnitude(label) === expected,
      `printed unit label "${label}" reads as ${expected}`,
    );
  }
}

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
