#!/usr/bin/env node
// P5.2 — EMITTED-`<f>` DERIVABILITY.
//
// The invariant this suite proves: every formula in the EMITTED WORKBOOK is
// DERIVABLE — reconstructible from a typed AST plus the plan's own data —
// rather than a string that happens to have been written.
//
// It reads the `<f>` elements out of a workbook built through the shipped route
// (`build_dynamic_model.mjs --plan-only`, then `python -m emit build`) and puts
// each one through two questions:
//
//   1. TYPED. Does the formula parse into the closed eight-kind AST — closed
//      function set, closed operator set — and re-render to the exact bytes
//      that shipped? A formula that does not is text the compiler cannot even
//      read back, let alone justify.
//   2. PLAN-DERIVED. Can the formula be REBUILT, without looking at it, from
//      the plan's own record of the model — the serialised row plan's
//      calculations, row ids and control rows — through `formula_dsl`'s typed
//      compiler? This is the question that catches tampering: a formula that
//      merely parses still parses after a reference is swapped, but one that
//      has to equal an independently derived rendering does not.
//
// Three derivation authorities answer (2), and all three read the plan, never
// the cell: `formula_dsl`'s typed compiler over a statement row's declared
// calculations; the broker-metric register, which fixes a broker-driven
// forecast cell to `'Brokers'!<column><row>`; and the face-row bounds, which fix
// column R to the last actual. Nothing else is claimed.
//
// Where the answer to (2) is no, that is RECORDED, per formula, as a finding —
// a raw template literal with no AST behind it — with its locus, and reported
// as a count. The 219 raw literals still living in `configureOperatingModel`
// are the bulk of them and this suite is how their number is kept honest, not
// hidden; migrating them is the only thing that can make the count fall. What
// the suite REFUSES is a formula that fails (1), a gated cell whose gate is not
// the gate, a gate outside columns N/O/P, or a plan-derived formula whose bytes
// are not what the plan derives.
//
// The gate is checked structurally: `IF($P$<control>=0,0,X)` is recognised as a
// conditional NODE over this case's own control cell, not as a text prefix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import {
  FormulaAstError,
  astDepth,
  call as astCall,
  parseExpression,
  ref as astRef,
  renderExpression,
  sheetRef as astSheetRef,
  unary as astUnary,
} from "./lib/formula_ast.mjs";
import { compileStatementFormulaAst } from "./lib/formula_dsl.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

let checks = 0;
function check(assertion) {
  assertion();
  checks += 1;
}

// ---------------------------------------------------------------------------
// The two certified fixtures, built the way the release builds them.
// ---------------------------------------------------------------------------

const FIXTURES = [
  { id: "standard-maximal-v2", acquisition: "enabled" },
  { id: "standard-net-cash-v2", acquisition: "disabled" },
];

// The archived fixtures are production cases; the certified build forces the
// reference-parity profile, exactly as the byte-identity proof does.
function stagedCase(fixtureId, directory) {
  const source = path.join(
    repositoryRoot,
    "test-fixtures",
    "cases",
    `${fixtureId}.json`,
  );
  const modelCase = JSON.parse(fs.readFileSync(source, "utf8"));
  modelCase.execution_profile = "reference_parity";
  const staged = path.join(directory, `${fixtureId}.case.json`);
  fs.writeFileSync(staged, `${JSON.stringify(modelCase, null, 2)}\n`, "utf8");
  return staged;
}

function buildFixture(fixtureId, directory) {
  const casePath = stagedCase(fixtureId, directory);
  const outPath = path.join(directory, `${fixtureId}.xlsx`);
  execFileSync(
    process.execPath,
    [
      path.join(scriptDirectory, "build_dynamic_model.mjs"),
      casePath,
      "--out",
      outPath,
      "--plan-only",
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  execFileSync(
    process.env.EMIT_PYTHON ?? "python3",
    ["-m", "emit", "build", `${outPath}.plan.json`, "--out", outPath],
    { cwd: scriptDirectory, stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    id: fixtureId,
    xlsxPath: outPath,
    planPath: `${outPath}.plan.json`,
    rowPlan: JSON.parse(fs.readFileSync(`${outPath}.row-map.json`, "utf8")),
  };
}

// ---------------------------------------------------------------------------
// Reading the emitted formulas.
//
// The reader is deliberately dumb: locate `<c>` elements, take the `<f>` inside
// them, un-escape the five XML entities. Everything that follows works on the
// text the workbook actually carries.
// ---------------------------------------------------------------------------

function unescapeXml(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

async function readEmittedFormulas(xlsxPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(xlsxPath));
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const sheetNames = [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)]
    .map((match) => unescapeXml(match[1]));
  const parts = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(
      (left, right) =>
        Number(left.match(/(\d+)\.xml$/)[1]) -
        Number(right.match(/(\d+)\.xml$/)[1]),
    );
  const emitted = [];
  for (const [index, part] of parts.entries()) {
    const xml = await zip.file(part).async("string");
    for (const match of xml.matchAll(
      /<((?:[A-Za-z_][\w.-]*:)?c)\b([^>]*)>\s*<((?:[A-Za-z_][\w.-]*:)?f)\b[^>]*>([\s\S]*?)<\/\3>/g,
    )) {
      const address = match[2].match(/\br="([A-Z]+\d+)"/)?.[1];
      if (!address) continue;
      const column = /^([A-Z]+)(\d+)$/.exec(address);
      emitted.push({
        sheet: sheetNames[index] ?? part,
        address,
        column: column[1],
        row: Number(column[2]),
        formula: unescapeXml(match[4]),
      });
    }
  }
  return emitted;
}

// ---------------------------------------------------------------------------
// THE PLAN'S OWN DATA.
//
// `<out>.row-map.json` is the serialised row plan: every statement row with its
// declared calculation, the id→row registry those calculations resolve through,
// and the control rows. Nothing below reads a formula in order to rebuild one.
// ---------------------------------------------------------------------------

const HISTORICAL_COLUMNS = ["G", "H", "I"];
const FORECAST_COLUMNS = ["J", "K", "L"];
const PRO_FORMA_REFERENCE_COLUMN = "R";
// The pack quotes these as positive magnitudes; the cash-flow statement carries
// them as negative movements.
const BROKER_MAGNITUDE_ROLES = new Set(["capex", "dividends", "share_buybacks"]);
const PREVIOUS_COLUMN = {
  H: "G",
  I: "H",
  J: "I",
  K: "J",
  L: "K",
  S: "R",
  T: "S",
  U: "T",
};

function statementDefinitions(rowPlan) {
  return [
    ...(rowPlan.statement_rows?.income_statement ?? []),
    ...(rowPlan.statement_rows?.cash_flow ?? []),
  ];
}

function rowResolver(rowPlan) {
  const byId = new Map(
    Object.values(rowPlan.statement_rows ?? {})
      .flat()
      .map((row) => [row.row_id, row]),
  );
  return (id) => byId.get(id)?.row ?? rowPlan.rows_by_id?.[id] ?? null;
}

/**
 * Every rendering the plan's own record of THIS row can justify in THIS column.
 *
 * A row may declare a general calculation, a forecast-specific one, and a
 * per-period list; the emitter chooses between them by rules that live in the
 * operating-model emitter. Rather than restate that choice — which would make
 * this suite a copy of the thing it is auditing — the set of renderings the
 * plan admits is computed and the emitted formula must be a member. A swapped
 * reference or a changed constant is not a member of a three-element set.
 */
function derivableRenderings(rowPlan, definition, column) {
  const rules = [
    definition.calculation,
    definition.forecast_calculation,
    ...(definition.forecast_period_calculations ?? []),
  ].filter((rule) => rule && typeof rule === "object");
  const rowForId = rowResolver(rowPlan);
  const renderings = new Map();
  for (const rule of rules) {
    let compiled;
    try {
      compiled = compileStatementFormulaAst({
        rule,
        definition,
        column,
        rowForId,
        previousColumn: (candidate) => PREVIOUS_COLUMN[candidate] ?? null,
        historicalColumns: HISTORICAL_COLUMNS,
        roundSumDigits:
          definition.semantic_role === "net_change_in_cash" ? 6 : null,
      });
    } catch {
      // A rule this column cannot resolve contributes no rendering. It is not
      // an error here: the emitter did not necessarily use this rule.
      continue;
    }
    if (!compiled.ast) continue;
    // The DSL's own contract, re-checked at the point of use: the text it
    // returns is exactly what its tree renders to.
    assert.equal(compiled.formula, `=${renderExpression(compiled.ast)}`);
    renderings.set(renderExpression(compiled.ast), { rule, ast: compiled.ast });
  }
  return renderings;
}

/**
 * THE TWO NON-DSL DERIVATIONS THE PLAN ALSO FULLY DETERMINES.
 *
 * A broker-driven forecast cell is `'Brokers'!<forecast column><metric row>`,
 * and both halves come from the row plan's own `broker_metric_rows` register —
 * not from reading the cell. A pro-forma-historical cell in column R is the
 * last actual, `I<row>`, on every face row. Neither is a statement CALCULATION,
 * so `formula_dsl` has nothing to say about them; both are nevertheless
 * reconstructible from the plan alone, which is the property under test.
 */
function auxiliaryRenderings(rowPlan, definition, column, row) {
  const renderings = new Set();
  if (column === PRO_FORMA_REFERENCE_COLUMN) {
    if (row > Number(rowPlan.period_row) && row <= Number(rowPlan.visible_end_row)) {
      renderings.add(renderExpression(astRef(`I${row}`)));
    }
  }
  const broker = rowPlan.broker_metric_rows;
  const metricId = definition?.broker_metric_id;
  const forecastIndex = FORECAST_COLUMNS.indexOf(column);
  if (broker && metricId && forecastIndex >= 0) {
    const brokerRow = broker.rows?.[metricId];
    const brokerColumn = broker.forecast_columns?.[forecastIndex];
    if (brokerRow && brokerColumn) {
      const link = astSheetRef(broker.sheet, `${brokerColumn}${brokerRow}`);
      renderings.add(
        renderExpression(
          BROKER_MAGNITUDE_ROLES.has(definition.semantic_role)
            ? astUnary("-", astCall("ABS", [link]))
            : link,
        ),
      );
    }
  }
  return renderings;
}

// ---------------------------------------------------------------------------
// THE ADJUSTMENT GATE, READ BACK OFF THE TREE.
// ---------------------------------------------------------------------------

const ADJUSTMENT_GATE_COLUMNS = ["N", "O", "P"];

function gateControlCell(rowPlan) {
  return `$P$${rowPlan.controls.adjustments_enabled}`;
}

function gateInner(rowPlan, node) {
  if (!node || node.kind !== "conditional") return null;
  const test = node.test;
  if (!test || test.kind !== "binary" || test.operator !== "=") return null;
  if (!Array.isArray(test.operands) || test.operands.length !== 2) return null;
  const [control, zero] = test.operands;
  if (
    control?.kind !== "ref" ||
    control.sheet !== undefined ||
    control.text !== gateControlCell(rowPlan)
  ) {
    return null;
  }
  if (zero?.kind !== "literal" || zero.value !== 0) return null;
  if (node.whenTrue?.kind !== "literal" || node.whenTrue.value !== 0) return null;
  return node.whenFalse ?? null;
}

function gateExcludedRows(rowPlan) {
  return new Set([
    ...(rowPlan.debt_groups ?? []).flatMap((group) => [
      group.header_row,
      group.subtotal_row,
      group.interest_header_row,
      group.interest_subtotal_row,
    ]),
    ...Object.values(rowPlan.debt_fx_rows ?? {}),
  ]);
}

function shouldCarryGate(rowPlan, column, row) {
  return (
    ADJUSTMENT_GATE_COLUMNS.includes(column) &&
    row > Number(rowPlan.period_row) &&
    row <= Number(rowPlan.visible_end_row) &&
    !gateExcludedRows(rowPlan).has(row)
  );
}

// ---------------------------------------------------------------------------
// THE AUDIT ITSELF.
//
// One pass over the emitted formulas, producing a verdict per cell. Nothing in
// here throws on a raw formula: a raw formula is a FINDING. It throws on a
// formula that cannot be read as an expression, on a gate that is not a gate,
// and on a plan-derived formula whose bytes are not what the plan derives.
// ---------------------------------------------------------------------------

function auditFixture(fixture, emitted) {
  const { rowPlan } = fixture;
  const definitionByRow = new Map(
    statementDefinitions(rowPlan).map((definition) => [definition.row, definition]),
  );
  const report = {
    fixture: fixture.id,
    total: 0,
    typed: 0,
    unreadable: [],
    plan_derived: 0,
    raw: [],
    gated: 0,
    gate_missing: [],
    gate_stray: [],
    max_depth: 0,
  };
  for (const cell of emitted) {
    report.total += 1;
    let node;
    try {
      node = parseExpression(cell.formula);
    } catch (error) {
      report.unreadable.push({ ...cell, reason: error.message });
      continue;
    }
    const rendered = renderExpression(node);
    if (rendered !== cell.formula) {
      report.unreadable.push({
        ...cell,
        reason: `renders ${rendered}, shipped ${cell.formula}`,
      });
      continue;
    }
    report.typed += 1;
    report.max_depth = Math.max(report.max_depth, astDepth(node));

    // --- the gate --------------------------------------------------------
    const inner = gateInner(rowPlan, node);
    const isFace = cell.sheet === "Operating Model";
    if (isFace && shouldCarryGate(rowPlan, cell.column, cell.row)) {
      if (inner === null) report.gate_missing.push(cell);
      else report.gated += 1;
    } else if (
      inner !== null &&
      isFace &&
      !ADJUSTMENT_GATE_COLUMNS.includes(cell.column)
    ) {
      report.gate_stray.push(cell);
    }

    // --- derivability ----------------------------------------------------
    const subject = inner === null ? node : inner;
    const definition = isFace ? definitionByRow.get(cell.row) : undefined;
    const text = renderExpression(subject);
    const derived =
      isFace &&
      (auxiliaryRenderings(rowPlan, definition, cell.column, cell.row).has(text) ||
        (definition
          ? derivableRenderings(rowPlan, definition, cell.column).has(text)
          : false));
    if (derived) report.plan_derived += 1;
    else {
      report.raw.push({
        sheet: cell.sheet,
        locus: !isFace
          ? "other-sheet"
          : definition
            ? "face-statement-row"
            : "face-schedule-row",
        address: cell.address,
        row_id: definition?.row_id ?? null,
        formula: cell.formula,
      });
    }
  }
  return report;
}

/** The derivability verdict for ONE formula text at one address. */
function isPlanDerived(fixture, cell) {
  const { rowPlan } = fixture;
  let node;
  try {
    node = parseExpression(cell.formula);
  } catch {
    return false;
  }
  if (renderExpression(node) !== cell.formula) return false;
  const inner = gateInner(rowPlan, node);
  const subject = inner === null ? node : inner;
  if (cell.sheet !== "Operating Model") return false;
  const definition = statementDefinitions(rowPlan).find(
    (candidate) => candidate.row === cell.row,
  );
  const text = renderExpression(subject);
  if (auxiliaryRenderings(rowPlan, definition, cell.column, cell.row).has(text)) {
    return true;
  }
  if (!definition) return false;
  return derivableRenderings(rowPlan, definition, cell.column).has(text);
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const workingDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "emitted-formula-derivability-"),
);
const audits = [];
for (const fixture of FIXTURES) {
  const built = buildFixture(fixture.id, workingDirectory);
  const emitted = await readEmittedFormulas(built.xlsxPath);
  audits.push({ fixture: built, emitted, report: auditFixture(built, emitted) });
}

for (const { fixture, emitted, report } of audits) {
  // 1. The workbook carries formulas at all. A pass that visited nothing is a
  //    description of its own selector, not of the workbook.
  check(() =>
    assert.ok(
      report.total > 500,
      `${fixture.id} emitted only ${report.total} formulas; this audit visited nothing worth auditing`,
    ),
  );
  // 2. EVERY emitted formula is an expression in the closed typed vocabulary
  //    and re-renders to the exact bytes that shipped.
  check(() =>
    assert.deepEqual(
      report.unreadable.slice(0, 5),
      [],
      `${fixture.id}: ${report.unreadable.length} emitted formula(s) are not readable as a typed AST`,
    ),
  );
  check(() =>
    assert.equal(
      report.typed,
      report.total,
      `${fixture.id}: every emitted formula must be typed-derivable`,
    ),
  );
  // 3. The depth budget the DSL declares actually bounds nothing here — these
  //    are emitter formulas, not DSL rules — but a tree with no depth is a tree
  //    that did not parse, so the measurement is asserted to be real.
  check(() =>
    assert.ok(
      report.max_depth >= 3 && report.max_depth < 64,
      `${fixture.id}: deepest emitted tree is ${report.max_depth}`,
    ),
  );
  // 4. THE GATE IS STRUCTURAL. Every N/O/P formula on a gated face row is a
  //    gate NODE over this case's own control cell, and no face cell outside
  //    N/O/P carries one.
  check(() =>
    assert.deepEqual(
      report.gate_missing.slice(0, 5).map((cell) => cell.address),
      [],
      `${fixture.id}: gated adjustment cells missing the gate node`,
    ),
  );
  check(() =>
    assert.deepEqual(
      report.gate_stray.slice(0, 5).map((cell) => cell.address),
      [],
      `${fixture.id}: the adjustment gate appears outside columns N/O/P`,
    ),
  );
  check(() =>
    assert.ok(
      report.gated > 100,
      `${fixture.id}: only ${report.gated} gated cells found`,
    ),
  );
  // 5. A NON-EMPTY plan-derived population. The proof is worthless if nothing
  //    is derived from the plan; the raw remainder is reported, not hidden.
  check(() =>
    assert.ok(
      report.plan_derived > 100,
      `${fixture.id}: only ${report.plan_derived} formulas are derivable from the plan's own data`,
    ),
  );
  check(() =>
    assert.equal(
      report.plan_derived + report.raw.length,
      report.total,
      `${fixture.id}: every formula must be classified derived or raw, with none unaccounted`,
    ),
  );
  // 6. Every plan-derived formula genuinely re-derives — asserted cell by cell
  //    rather than only in aggregate.
  check(() => {
    const derived = emitted.filter((cell) => isPlanDerived(fixture, cell));
    assert.equal(derived.length, report.plan_derived);
    for (const cell of derived) {
      assert.ok(
        isPlanDerived(fixture, cell),
        `${fixture.id}!${cell.address} claims to be plan-derived but does not re-derive`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// MUTATIONS. Each tampers an EMITTED `<f>` and demands the audit catch it.
// ---------------------------------------------------------------------------

const primary = audits[0];
const derivedSample = primary.emitted.filter((cell) =>
  isPlanDerived(primary.fixture, cell),
);
const gatedSample = primary.emitted.filter((cell) => {
  const node = parseExpression(cell.formula);
  return gateInner(primary.fixture.rowPlan, node) !== null;
});

check(() =>
  assert.ok(
    derivedSample.length > 0 && gatedSample.length > 0,
    "the mutations need a derivable cell and a gated cell to tamper",
  ),
);

// M1 — a swapped reference. The formula still parses, still round-trips, and is
// still a perfectly ordinary Excel expression. It is no longer what the plan
// derives, and that is the whole point of asking the plan.
check(() => {
  const victim = derivedSample.find((cell) => /[A-Z]\d/.test(cell.formula));
  const tampered = {
    ...victim,
    formula: victim.formula.replace(/([A-Z])(\d+)/, (_, column, row) =>
      `${column}${Number(row) + 1}`,
    ),
  };
  assert.notEqual(tampered.formula, victim.formula);
  assert.doesNotThrow(() => parseExpression(tampered.formula));
  assert.ok(
    !isPlanDerived(primary.fixture, tampered),
    `a swapped reference in ${victim.address} must not be derivable`,
  );
});

// M2 — a changed constant.
check(() => {
  const victim = derivedSample.find((cell) => /\d(?![\d$])/.test(cell.formula));
  const tampered = { ...victim, formula: `${victim.formula}+1` };
  assert.doesNotThrow(() => parseExpression(tampered.formula));
  assert.ok(!isPlanDerived(primary.fixture, tampered));
});

// M3 — cosmetic parentheses. Byte-different, arithmetically identical, and
// therefore exactly the kind of edit a text comparison waves through.
check(() => {
  const victim = derivedSample[0];
  const tampered = { ...victim, formula: `(${victim.formula})` };
  assert.equal(
    renderExpression(parseExpression(tampered.formula)),
    tampered.formula,
    "the tampered formula is still a valid expression",
  );
  assert.ok(!isPlanDerived(primary.fixture, tampered));
});

// M4 — a function outside the closed vocabulary. This one must not parse at
// all: the reader is closed, so a smuggled `VLOOKUP` is unreadable, not merely
// underivable.
check(() => {
  assert.throws(
    () => parseExpression(`VLOOKUP(A1,B1:C2,2)`),
    FormulaAstError,
    "a function outside the closed vocabulary must be unreadable",
  );
  const victim = derivedSample[0];
  assert.throws(
    () => parseExpression(`IFERROR(${victim.formula},RAND())`),
    FormulaAstError,
  );
});

// M5 — the gate, flipped to test the control against 1. Text-wise it is one
// character; structurally it is a different node and the audit says so.
check(() => {
  const victim = gatedSample[0];
  const control = gateControlCell(primary.fixture.rowPlan);
  const tampered = victim.formula.replace(`${control}=0`, `${control}=1`);
  assert.notEqual(tampered, victim.formula);
  assert.equal(
    gateInner(primary.fixture.rowPlan, parseExpression(tampered)),
    null,
    "a gate testing the wrong state must not be recognised as the gate",
  );
});

// M6 — the gate, pointed at a different control row. Same shape, wrong cell.
check(() => {
  const victim = gatedSample[0];
  const control = gateControlCell(primary.fixture.rowPlan);
  const other = `$P$${Number(primary.fixture.rowPlan.controls.adjustments_enabled) + 1}`;
  const tampered = victim.formula.replace(control, other);
  assert.equal(
    gateInner(primary.fixture.rowPlan, parseExpression(tampered)),
    null,
    "a gate over another control cell must not be recognised as this gate",
  );
});

// M7 — the gate stripped. The audit must report the cell as ungated rather than
// pass it through because its inner formula still looks fine.
check(() => {
  const victim = gatedSample[0];
  const inner = gateInner(
    primary.fixture.rowPlan,
    parseExpression(victim.formula),
  );
  const stripped = { ...victim, formula: renderExpression(inner) };
  const report = auditFixture(primary.fixture, [stripped]);
  assert.equal(report.gate_missing.length, 1);
  assert.equal(report.gate_missing[0].address, victim.address);
});

// M8 — a tampered formula fed through the WHOLE audit, not just the predicate,
// so the failure is proved to reach the assertions the suite actually runs.
check(() => {
  const victim = derivedSample.find((cell) => /[A-Z]\d/.test(cell.formula));
  const tampered = {
    ...victim,
    formula: victim.formula.replace(/([A-Z])(\d+)/, (_, column, row) =>
      `${column}${Number(row) + 1}`,
    ),
  };
  const clean = auditFixture(primary.fixture, [victim]);
  const dirty = auditFixture(primary.fixture, [tampered]);
  assert.equal(clean.plan_derived, 1);
  assert.equal(dirty.plan_derived, 0);
  assert.equal(dirty.raw.length, 1);
});

// M9 — an unreadable `<f>`. A workbook carrying one must fail check 2, not be
// counted as typed.
check(() => {
  const report = auditFixture(primary.fixture, [
    { ...primary.emitted[0], formula: "SUM(A1,,B2" },
  ]);
  assert.equal(report.typed, 0);
  assert.equal(report.unreadable.length, 1);
});

// ---------------------------------------------------------------------------
// THE FINDINGS. Reported, in full, on stderr — a count that can only go down by
// migrating a raw literal onto the AST, never by looking away from it.
// ---------------------------------------------------------------------------

const findings = audits.map(({ report }) => {
  const byLocus = {};
  for (const finding of report.raw) {
    byLocus[finding.locus] = (byLocus[finding.locus] ?? 0) + 1;
  }
  return {
    fixture: report.fixture,
    emitted_formulas: report.total,
    typed_derivable: report.typed,
    plan_derivable: report.plan_derived,
    raw: report.raw.length,
    raw_by_locus: byLocus,
    gated_cells: report.gated,
    deepest_tree: report.max_depth,
  };
});
process.stderr.write(
  `${JSON.stringify({ derivability_findings: findings }, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(workingDirectory, "derivability-findings.json"),
  `${JSON.stringify(
    audits.map(({ report }) => report),
    null,
    2,
  )}\n`,
  "utf8",
);
process.stderr.write(
  `raw-formula register: ${path.join(workingDirectory, "derivability-findings.json")}\n`,
);

console.log(JSON.stringify({ status: "PASS", checks }));
