#!/usr/bin/env node
/**
 * E4 step 1 — the Economic IR PARITY harness: an evidence machine, nothing more.
 *
 * QUESTION IT ANSWERS (nightly, before any later gating/cutover phase may run):
 * does the canonical Economic IR — compiled in SHADOW mode beside the proof
 * projection — agree number-for-number with the LEGACY emitted layer, slot by
 * slot, across every certified corpus fixture?
 *
 * THE TWO SIDES.
 *
 *   IR side     compileFixtureEconomicIr(fixtureId, { fixtureDir })
 *               (scripts/lib/behavioural_golden.mjs:278) — the SAME compile
 *               path run_behavioural_golden_tests.mjs uses: compileRowPlan ->
 *               compileSemanticManifest -> compileModelIrV3
 *               (build_dynamic_model.mjs:13008), which shadow-attaches the IR
 *               via model_ir_v3.mjs attachShadowEconomicIr. Every typed slot is
 *               enumerated with economicIrTypedSlots(ir)
 *               (scripts/lib/economic_ir.mjs:372).
 *
 *   Legacy side the emitted workbook caches. The certified corpus fixtures are
 *               production-shaped custody inputs that cannot enter the builder
 *               unmarked, so this harness stages a THROWAWAY forensic copy with
 *               execution_profile forced to reference_parity — the exact
 *               convention scripts/run_canonical_model_module_tests.mjs (loadCase)
 *               established — and drives the REAL builder CLI over it:
 *                 node scripts/build_dynamic_model.mjs <staged> --out X.xlsx --plan-only
 *               The emitted numbers are read from X.xlsx.plan.json cell `v`
 *               fields; cells are addressed via X.xlsx.row-map.json row_ids and
 *               the period column map scripts/lib/wb_style.mjs:126-129
 *               (historical G/H/I, forecast J/K/L).
 *
 * THE DIFF. Every typed slot is walked:
 *   - a VALUE-BEARING slot (reported_number / reported_zero / prior_filing_support /
 *     derived_number) must find an emitted number at its matched cell and the two
 *     numbers must be exactly equal;
 *   - conversely every emitted LITERAL hardcode in the statement grid (G..L,
 *     formula-free cells — the numbers that originate from the plan's own value
 *     arrays) must be mirrored by a value-bearing slot holding the same number;
 *   - a never-zero slot (missing / unresolved / not_applicable / ...) with a
 *     number sitting on its filed cell is a mismatch — blank collapsing into a
 *     reading is exactly what the typed contract forbids;
 *   - solver-owned caches on rows whose shadow slot is unresolved are counted as
 *     OUT OF SCOPE context, not compared: the shadow IR deliberately compiles
 *     BEFORE the solver and holds no solver numbers (economic_ir.mjs header
 *     discipline). Flagging them would misread the architecture this package
 *     freezes.
 *
 * WHAT THIS HARNESS IS NOT. It promotes nothing, gates nothing and edits
 * nothing: it never writes inside the repository, never touches goldens/, never
 * mutates gates_delivery (it ASSERTS the shadow boundary instead — mode shadow,
 * gates_delivery false — because behavioural_golden.mjs declares
 * shadow_boundary_violation NEVER_ACCEPTABLE and promoting the IR is a NEW
 * SCHEMA VERSION, never a golden update or a flag flip here). Genuine parity
 * mismatches are FINDINGS to report, not defects of this suite: the suite fails
 * loudly and prints the first ten divergent slots with both values.
 *
 * OUTPUT: a sealed parity-report.json ({fixture, slots_compared, mismatches[]}
 * per fixture) whose content_sha256 covers the canonical body sans seal, hashed
 * with the Economic IR's own canonicalisation (economicIrContentSha256). The
 * suite PASSes only when mismatches = 0 across ALL fixtures.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  compileFixtureEconomicIr,
  listCertifiedFixtures,
} from "./lib/behavioural_golden.mjs";
import {
  economicIrContentSha256,
  economicIrTypedSlots,
  validateEconomicIr,
} from "./lib/economic_ir.mjs";
import {
  VALUE_BEARING_STATES,
  numericValueOf,
} from "./lib/typed_financial_value.mjs";
import { FORECAST_COLUMNS, HISTORICAL_COLUMNS } from "./lib/wb_style.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(ROOT, "test-fixtures", "cases");
const BUILDER = path.join(ROOT, "scripts", "build_dynamic_model.mjs");
const OPERATING_MODEL_SHEET = "Operating Model";
const PARITY_REPORT_SCHEMA_VERSION = "economic-ir-parity-report/1.0";
/** Grid columns an emitted LITERAL may declare a plan value in (wb_style.mjs). */
const DECLARED_VALUE_COLUMNS = new Map([
  ...HISTORICAL_COLUMNS.map((column, index) => [column, { lane: "historical", index }]),
  ...FORECAST_COLUMNS.map((column, index) => [column, { lane: "forecast", index }]),
]);

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Numeric equality for parity: bit-equal, or within the SAME relative band the
 * builder itself applies when judging shipped hardcodes against filed figures
 * (build_dynamic_model.mjs: `tolerance = 1e-6 * Math.max(1, Math.abs(filed))`).
 * The two layers derive one quantity through different arithmetic (a declared
 * total versus SUM over its members), so last-bit summation drift is not
 * economic drift; anything outside this band is.
 */
function numbersAgree(left, right) {
  if (Object.is(left, right)) return true;
  return Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(left), Math.abs(right));
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

/**
 * Stage a throwaway forensic copy of one certified fixture and drive the real
 * builder CLI over it (--plan-only). Returns the parsed plan and row-map.
 * Nothing is written inside the repository: staging and emission live in one
 * mkdtemp work directory.
 */
async function emitLegacyLayer(fixtureId, modelCase, workDir) {
  const stagedCasePath = path.join(workDir, `${fixtureId}.reference-parity.json`);
  const stagedCase = structuredClone(modelCase);
  // The repo's declared convention for solving maintained custody fixtures
  // (run_canonical_model_module_tests.mjs loadCase): a forensic scenario names
  // itself reference_parity. The staged copy differs from the certified
  // fixture by this one field and is written OUTSIDE the tree.
  stagedCase.execution_profile = "reference_parity";
  await fs.writeFile(stagedCasePath, `${JSON.stringify(stagedCase, null, 1)}\n`, "utf8");

  const outputPath = path.join(workDir, `${fixtureId}.xlsx`);
  let stdout;
  try {
    ({ stdout } = await exec(
      process.execPath,
      [BUILDER, stagedCasePath, "--out", outputPath, "--plan-only"],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(
      `builder CLI exited ${error.code ?? "?"} for ${fixtureId}: ${String(error.stderr ?? error.message).slice(-2000)}`,
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    throw new Error(`builder CLI printed no JSON receipt for ${fixtureId}: ${stdout.slice(0, 400)}`);
  }
  if (receipt.status !== "PLANNED") {
    throw new Error(`builder CLI status ${JSON.stringify(receipt.status)} for ${fixtureId}`);
  }
  if (Number(receipt.unresolved_caches ?? 0) !== 0) {
    throw new Error(
      `builder left ${receipt.unresolved_caches} unresolved cache(s) for ${fixtureId}; the emitted layer is incomplete`,
    );
  }
  const [plan, rowMap] = await Promise.all([
    fs.readFile(`${outputPath}.plan.json`, "utf8").then(JSON.parse),
    fs.readFile(`${outputPath}.row-map.json`, "utf8").then(JSON.parse),
  ]);
  return { plan, rowMap, receipt };
}

/** Every finite emitted number on the Operating Model sheet, keyed by address. */
function emittedNumericCaches(plan) {
  const sheet = plan?.workbook?.sheets?.find((entry) => entry.name === OPERATING_MODEL_SHEET);
  if (!sheet || !sheet.cells || typeof sheet.cells !== "object") {
    throw new Error(`emitted plan carries no ${OPERATING_MODEL_SHEET} cells`);
  }
  const numbers = new Map();
  const formulaCells = new Set();
  let literalsInGrid = 0;
  for (const [address, cell] of Object.entries(sheet.cells)) {
    if (typeof cell?.f === "string" && cell.f.length > 0) formulaCells.add(address);
    if (!isFiniteNumber(cell?.v)) continue;
    numbers.set(address, cell.v);
    const column = /^([A-Z]+)(\d+)$/.exec(address)?.[1] ?? "";
    if (DECLARED_VALUE_COLUMNS.has(column) && !formulaCells.has(address)) literalsInGrid += 1;
  }
  return { numbers, formulaCells, literalsInGrid };
}

/** row_id / sheet-row indexes over the emitted row-map's statement rows. */
function statementIndexes(rowMap) {
  const byRowId = new Map();
  const byRowNumber = new Map();
  for (const rows of Object.values(rowMap?.statement_rows ?? {})) {
    for (const definition of rows ?? []) {
      byRowId.set(definition.row_id, definition);
      byRowNumber.set(Number(definition.row), definition);
    }
  }
  return { byRowId, byRowNumber };
}

/**
 * Slot lookups per node: display_id -> {lane -> (periodIndex -> {path, slot})},
 * so an emitted cell can find the slot that mirrors it.
 */
function irSlotIndexes(ir) {
  const byDisplayId = new Map();
  for (const [slotPath, slot] of economicIrTypedSlots(ir)) {
    const nodeMatch = /^nodes\[(\d+)\]\.(historical|forecast)\[(\d+)\]\.value$/.exec(slotPath);
    if (!nodeMatch) continue;
    const node = ir.nodes[Number(nodeMatch[1])];
    const lane = nodeMatch[2];
    const entry = node[lane][Number(nodeMatch[3])];
    const periodIndex = lane === "historical" ? entry.period_index : entry.forecast_index;
    if (!byDisplayId.has(node.display_id)) byDisplayId.set(node.display_id, new Map());
    const lanes = byDisplayId.get(node.display_id);
    if (!lanes.has(lane)) lanes.set(lane, new Map());
    lanes.get(lane).set(periodIndex, { path: slotPath, slot, period_id: entry.period_id });
  }
  return byDisplayId;
}

function addressOf(lane, periodIndex, rowNumber) {
  const columns = lane === "historical" ? HISTORICAL_COLUMNS : FORECAST_COLUMNS;
  const column = columns[periodIndex];
  return Number.isInteger(periodIndex) && column ? `${column}${rowNumber}` : null;
}

// ---------------------------------------------------------------------------
// One fixture: compile both layers, walk every slot, collect mismatches.
// ---------------------------------------------------------------------------
async function parityForFixture(fixtureId, workDir) {
  const { modelCase, ir } = await compileFixtureEconomicIr(fixtureId, { fixtureDir: FIXTURE_DIR });

  // Shadow-boundary pins: the evidence machine proves the IR it compares is
  // still the non-promoting shadow — and changes nothing about it.
  if (ir.mode !== "shadow" || ir.gates_delivery !== false) {
    throw new Error(
      `${fixtureId}: the Economic IR is no longer a delivery-blind shadow (mode ${JSON.stringify(ir.mode)}, gates_delivery ${JSON.stringify(ir.gates_delivery)}); promoting it is a new schema version, never a parity run.`,
    );
  }
  const irErrors = validateEconomicIr(ir);
  if (irErrors.length > 0) {
    throw new Error(`${fixtureId}: the compiled Economic IR is invalid: ${irErrors[0]}`);
  }

  const { plan, rowMap } = await emitLegacyLayer(fixtureId, modelCase, workDir);
  if ((plan?.case_id ?? rowMap?.case_id) && plan.case_id !== ir.case_id) {
    throw new Error(
      `${fixtureId}: the emitted plan names case ${JSON.stringify(plan.case_id)} but the IR names ${JSON.stringify(ir.case_id)}`,
    );
  }

  const { numbers: legacyNumbers, formulaCells, literalsInGrid } = emittedNumericCaches(plan);
  const { byRowId, byRowNumber } = statementIndexes(rowMap);
  const slotsByDisplayId = irSlotIndexes(ir);
  const mirroredCells = new Set();

  const result = {
    fixture: fixtureId,
    ir_seal_sha256: ir.seal.content_sha256,
    slots_compared: 0,
    value_bearing_slots: 0,
    matched_pairs: 0,
    never_zero_slots: 0,
    schedule_slots: 0,
    out_of_scope_solver_owned_cells: 0,
    emitted_literals_checked: 0,
    mismatches: [],
  };
  const mismatch = (record) => {
    result.mismatches.push(record);
  };

  // DIRECTION ONE — every IR slot against its matched emitted cell.
  for (const [slotPath, slot] of economicIrTypedSlots(ir)) {
    result.slots_compared += 1;

    if (slotPath.startsWith("schedules[")) {
      result.schedule_slots += 1;
      if (VALUE_BEARING_STATES.includes(slot?.state)) {
        // A schedule family produced a number in shadow mode: there is no
        // row_plan binding for it at all, so parity cannot hold by construction.
        mismatch({
          slot_path: slotPath,
          cell: null,
          ir_value: slot?.value ?? null,
          legacy_value: null,
          direction: "ir_to_emitted",
          reason: "value_bearing_schedule_slot_has_no_statement_row_binding",
        });
      }
      continue;
    }

    const state = slot?.state ?? null;
    const valueBearing = VALUE_BEARING_STATES.includes(state);
    if (valueBearing) result.value_bearing_slots += 1;
    else result.never_zero_slots += 1;

    const nodeMatch = /^nodes\[(\d+)\]\.(historical|forecast)\[(\d+)\]\.value$/.exec(slotPath);
    if (!nodeMatch) {
      mismatch({ slot_path: slotPath, cell: null, ir_value: null, legacy_value: null, direction: "ir_to_emitted", reason: "unroutable_slot_path" });
      continue;
    }
    const node = ir.nodes[Number(nodeMatch[1])];
    const lane = nodeMatch[2];
    const entry = node[lane][Number(nodeMatch[3])];
    const periodIndex = lane === "historical" ? entry.period_index : entry.forecast_index;
    const definition = byRowId.get(node.display_id);
    const address = definition && Number.isInteger(definition.row)
      ? addressOf(lane, periodIndex, definition.row)
      : null;

    if (!address) {
      // Header / bridge concepts have no statement row. Legitimate only while
      // they carry no number: a number with nowhere to be emitted IS a break.
      if (valueBearing) {
        mismatch({
          slot_path: slotPath,
          cell: null,
          ir_value: numericValueOf(slot),
          legacy_value: null,
          direction: "ir_to_emitted",
          reason: `ir_number_on_${node.display_id}_without_statement_row`,
        });
      }
      continue;
    }

    if (!valueBearing) {
      // Never-zero slot. A NUMBER on its FILED cell contradicts the typing
      // (blank/absent collapsed into a reading). Solver-owned caches under an
      // unresolved MODEL-projection slot are the shadow IR's declared blind
      // spot, recorded as context rather than judged here.
      if (legacyNumbers.has(address)) {
        const basis = String(node.historical_basis ?? "");
        if (lane === "forecast" || basis === "model_projection") {
          result.out_of_scope_solver_owned_cells += 1;
        } else {
          mismatch({
            slot_path: slotPath,
            cell: address,
            ir_value: null,
            legacy_value: legacyNumbers.get(address),
            direction: "ir_to_emitted",
            reason: `emitted_number_under_never_zero_slot_state_${state}`,
          });
        }
      }
      continue;
    }

    const irNumber = numericValueOf(slot);
    if (!legacyNumbers.has(address)) {
      mismatch({
        slot_path: slotPath,
        cell: address,
        ir_value: irNumber,
        legacy_value: null,
        direction: "ir_to_emitted",
        reason: "ir_number_without_emitted_cache",
      });
      continue;
    }
    const legacyValue = legacyNumbers.get(address);
    if (!numbersAgree(legacyValue, irNumber)) {
      mismatch({
        slot_path: slotPath,
        cell: address,
        ir_value: irNumber,
        legacy_value: legacyValue,
        direction: "ir_to_emitted",
        reason: "numeric_divergence",
      });
      continue;
    }
    mirroredCells.add(address);
    result.matched_pairs += 1;
  }

  // DIRECTION TWO — every emitted LITERAL in the declared-value grid must be
  // mirrored by a value-bearing IR slot with the same number. Formula caches
  // are derived/solver-owned projections, outside the shadow IR's scope.
  for (const [address, value] of legacyNumbers) {
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    if (!match) continue;
    const grid = DECLARED_VALUE_COLUMNS.get(match[1]);
    if (!grid) continue;
    // Skip addresses carrying an emitted formula cache: those caches are
    // ITERATED projections (solver-owned), not literals the plan's value
    // arrays declared, and direction one has already judged every slot the
    // IR owns — comparing them here would re-read them as literal hardcodes.
    if (formulaCells.has(address)) continue;
    const definition = byRowNumber.get(Number(match[2]));
    if (!definition) continue;
    const laneMaps = slotsByDisplayId.get(definition.row_id);
    const lookup = laneMaps?.get(grid.lane)?.get(grid.index);
    if (!lookup) {
      // Only judge cells the IR could have owned; a literal on a row the IR
      // has no node for is a structural finding either way.
      mismatch({
        slot_path: null,
        cell: address,
        ir_value: null,
        legacy_value: value,
        direction: "emitted_to_ir",
        reason: `emitted_literal_for_${definition.row_id}_${grid.lane}_period_${grid.index}_without_ir_slot`,
      });
      continue;
    }
    result.emitted_literals_checked += 1;
    if (mirroredCells.has(address)) continue;
    const state = lookup.slot?.state ?? null;
    if (!VALUE_BEARING_STATES.includes(state)) {
      mismatch({
        slot_path: lookup.path,
        cell: address,
        ir_value: null,
        legacy_value: value,
        direction: "emitted_to_ir",
        reason: `emitted_literal_under_never_zero_slot_state_${state}`,
      });
      continue;
    }
    const irNumber = numericValueOf(lookup.slot);
    // Same IEEE drift band as direction one (numbersAgree, precedent
    // build_dynamic_model.mjs:639): the emitted literal and the IR number
    // derive through different arithmetic, so last-bit drift is not economic.
    if (!numbersAgree(irNumber, value)) {
      mismatch({
        slot_path: lookup.path,
        cell: address,
        ir_value: irNumber,
        legacy_value: value,
        direction: "emitted_to_ir",
        reason: "numeric_divergence",
      });
    }
  }

  if (result.matched_pairs === 0 && result.value_bearing_slots > 0) {
    throw new Error(`${fixtureId}: the parity diff visited ${result.value_bearing_slots} value-bearing slot(s) and matched none — the join described nothing.`);
  }
  result.emitted_literals_in_grid = literalsInGrid;
  return result;
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------
const certified = await listCertifiedFixtures(FIXTURE_DIR);
if (certified.length < 2) {
  fail(`the certified fixture roster holds ${certified.length} fixture(s); parity evidence needs the corpus (>= 2).`);
} else {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "e4-economic-ir-parity-"));
  const suites = [];
  for (const fixtureId of certified) {
    try {
      const result = await parityForFixture(fixtureId, workDir);
      suites.push(result);
      console.log(
        `[${result.mismatches.length === 0 ? "ok" : "DIFF"}] ${fixtureId}: slots_compared=${result.slots_compared} value_bearing=${result.value_bearing_slots} matched=${result.matched_pairs} never_zero=${result.never_zero_slots} schedule=${result.schedule_slots} solver_owned_out_of_scope=${result.out_of_scope_solver_owned_cells} literals=${result.emitted_literals_checked} mismatches=${result.mismatches.length}`,
      );
    } catch (error) {
      fail(`${fixtureId}: ${error.message}`);
      process.exitCode = 1;
    }
  }

  const totalMismatches = suites.reduce((total, entry) => total + entry.mismatches.length, 0);
  const reportPath = process.env.TEST_OUT
    ? path.join(process.env.TEST_OUT, "economic-ir-parity-report.json")
    : path.join(workDir, "parity-report.json");
  if (suites.length === certified.length && process.exitCode !== 1) {
    const body = {
      schema_version: PARITY_REPORT_SCHEMA_VERSION,
      status: totalMismatches === 0 ? "PASS" : "FAIL",
      fixtures: suites,
      totals: {
        fixtures: suites.length,
        slots_compared: suites.reduce((total, entry) => total + entry.slots_compared, 0),
        value_bearing_slots: suites.reduce((total, entry) => total + entry.value_bearing_slots, 0),
        matched_pairs: suites.reduce((total, entry) => total + entry.matched_pairs, 0),
        mismatches: totalMismatches,
      },
      seal: { content_sha256: "", algorithm: "economic-ir-canonical-sha256 sans seal" },
    };
    body.seal.content_sha256 = economicIrContentSha256(body);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    console.log(`parity-report.json sealed at ${reportPath} (content_sha256 ${body.seal.content_sha256})`);

    if (totalMismatches > 0) {
      process.exitCode = 1;
      console.error(`PARITY FAILURES: ${totalMismatches} divergent slot(s) across ${suites.length} fixture(s). First 10:`);
      for (const entry of suites.flatMap((suite) =>
        suite.mismatches.map((record) => ({ fixture: suite.fixture, ...record })),
      ).slice(0, 10)) {
        console.error(
          `  ${entry.fixture} ${entry.slot_path ?? "(no slot)"} @ ${entry.cell ?? "(no cell)"} ir=${JSON.stringify(entry.ir_value)} legacy=${JSON.stringify(entry.legacy_value)} — ${entry.direction}: ${entry.reason}`,
        );
      }
    } else {
      console.log(
        `ECONOMIC IR PARITY PASS: ${body.totals.slots_compared} typed slots walked, ${body.totals.matched_pairs} exact IR<->emitted number pairs, 0 mismatches across ${suites.length} fixture(s).`,
      );
    }
  } else if (process.exitCode !== 1) {
    fail("not every certified fixture produced a parity verdict.");
  }
}
