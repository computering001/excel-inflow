#!/usr/bin/env node
/**
 * P3.1 — the canonical Economic IR (SHADOW).
 *
 * Invariant under test: a canonical Economic IR is compiled in shadow mode
 * beside the existing proof projection — computed, sealed and hashed, never
 * gating delivery — carrying TYPED financial values (P1.2's twelve states) for
 * every economic slot and the SCHEDULE state (P4.3) the proof projection omits;
 * the IR is deterministic (same case -> same seal) and its seal is recorded in
 * the transformation receipt.
 *
 * Red proof (this tree before the work package, captured against
 * scripts/lib/model_ir_v3.mjs at branch tip):
 *   compileModelIrV3(standard-maximal-v2) returned exactly
 *   [schema_version, case_id, case_sha256, evidence_epoch, planes, proof] —
 *   no economic IR under any key; the serialised projection contained ZERO
 *   typed_financial_value objects (no "contract_version", no "reported_number",
 *   no "derived_number") and no "schedule-typed-states" artifact; and
 *   transformationReceipt() carried no economic-IR hash under any key. The
 *   projection was a blocking, value-free proof object. Documented in
 *   programme/P3.1_issue_card.md.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  ECONOMIC_IR_SCHEMA,
  ECONOMIC_IR_SCHEMA_VERSION,
  ECONOMIC_IR_SHADOW_PROPERTY,
  compileEconomicIr,
  economicIrContentSha256,
  economicIrTypedSlots,
  shadowEconomicIrOf,
  validateEconomicIr,
} from "./lib/economic_ir.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  NEVER_ZERO_STATES,
  VALUE_BEARING_STATES,
  numericValueOf,
} from "./lib/typed_financial_value.mjs";
import { SCHEDULE_TYPED_STATE_SCHEMA_VERSION } from "./lib/schedule_typed_states.mjs";
import { compileModelIrV3, transformationReceipt } from "./lib/model_ir_v3.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import { compileInstrumentPeriodState } from "./lib/instrument_period_state.mjs";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const ALL_STATES = [...VALUE_BEARING_STATES, ...NEVER_ZERO_STATES];

async function compileFixture(name) {
  const modelCase = JSON.parse(
    await fs.readFile(
      new URL(`../test-fixtures/cases/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
  const instrumentPeriodState = compileInstrumentPeriodState(modelCase);
  const rowPlan = compileRowPlan(modelCase, { instrumentPeriodState });
  const semanticManifest = compileSemanticManifest(modelCase, rowPlan, {
    instrumentPeriodState,
  });
  const modelIr = compileModelIrV3({
    modelCase,
    rowPlan,
    semanticManifest,
    sourceCrosswalk: [],
  });
  return { modelCase, rowPlan, semanticManifest, modelIr };
}

const maximal = await compileFixture("standard-maximal-v2");

// ---------------------------------------------------------------------------
// (1) The Economic IR exists, is sealed, and is a canonical named object.
// ---------------------------------------------------------------------------
{
  const ir = compileEconomicIr({ ...maximal });
  check(
    ir.schema_version === ECONOMIC_IR_SCHEMA_VERSION,
    "the Economic IR declares its schema version",
  );
  check(ir.mode === "shadow", "the Economic IR declares shadow mode");
  check(
    ir.gates_delivery === false,
    "the Economic IR declares that it gates nothing",
  );
  check(
    ir.case_id === maximal.modelIr.case_id &&
      ir.case_sha256 === maximal.modelIr.case_sha256,
    "the Economic IR binds the same case identity as the proof projection",
  );
  check(
    ir.evidence_epoch_sha256 === maximal.modelIr.evidence_epoch.epoch_sha256,
    "the Economic IR binds the proof projection's sealed evidence epoch",
  );
  check(
    /^[a-f0-9]{64}$/.test(ir.seal.content_sha256),
    "the Economic IR carries a sha256 seal",
  );
  check(
    ir.seal.content_sha256 === economicIrContentSha256(ir),
    "the seal is the hash of the IR's own content",
  );
  check(ir.nodes.length > 0, "the Economic IR carries economic nodes");
  check(
    ir.contracts.typed_financial_value === "1.0.0" &&
      ir.contracts.schedule_typed_states === SCHEDULE_TYPED_STATE_SCHEMA_VERSION,
    "the Economic IR names the typed-value and schedule-state contracts it uses",
  );
}

// ---------------------------------------------------------------------------
// (2) Determinism: two compiles of the same case produce the same seal.
// ---------------------------------------------------------------------------
{
  const first = compileEconomicIr({ ...maximal });
  const second = compileEconomicIr({ ...maximal });
  check(
    first.seal.content_sha256 === second.seal.content_sha256,
    "two compiles of one case produce one seal (deterministic)",
  );
  check(
    JSON.stringify(first) === JSON.stringify(second),
    "two compiles of one case produce byte-identical IRs",
  );
  const other = await compileFixture("standard-net-cash-v2");
  const otherIr = compileEconomicIr({ ...other });
  check(
    otherIr.seal.content_sha256 !== first.seal.content_sha256,
    "a different case produces a different seal",
  );
  check(
    validateEconomicIr(otherIr).length === 0,
    "the second real fixture also compiles a valid Economic IR",
  );
  // standard-net-cash-v2 declares no acquisition. In a REAL fixture that must
  // read not_applicable across every forecast period — never a zero schedule.
  check(
    other.modelCase.acquisition === undefined ||
      Number(other.modelCase.acquisition?.enabled) !== 1,
    "the net-cash fixture genuinely declares no live acquisition",
  );
  const acquisitionSlots = otherIr.schedules.flatMap((period) =>
    Object.values(period.acquisition),
  );
  check(
    acquisitionSlots.length === 15 &&
      acquisitionSlots.every(
        (slot) => slot.state === "not_applicable" && numericValueOf(slot) === null,
      ),
    "a real case with no acquisition types every acquisition quantity not_applicable, never zero",
  );
}

// ---------------------------------------------------------------------------
// (2b) The historical lane decides what counts as FILED by exactly the P2.5
//      rule: only face source_input rows and retained reported series are
//      reported_*; schedule- and formula-owned caches are derived, never filed.
// ---------------------------------------------------------------------------
{
  const ir = compileEconomicIr({ ...maximal });
  const declaredBases = [
    "filed_face_series",
    "reported_total_reconciled",
    "model_projection",
    "structural_header",
    "no_plan_row",
  ];
  check(
    ir.nodes.every((node) => declaredBases.includes(node.historical_basis)),
    "every node declares which series its historical lane reads",
  );
  const reportedStates = ["reported_number", "reported_zero"];
  check(
    ir.nodes
      .filter((node) => node.historical_basis === "model_projection")
      .flatMap((node) => node.historical)
      .every((slot) => !reportedStates.includes(slot.value.state)),
    "a model-projected cache never claims reported_* provenance it does not have",
  );
  check(
    ir.nodes
      .filter((node) => node.historical_basis === "filed_face_series")
      .flatMap((node) => node.historical)
      .some((slot) => reportedStates.includes(slot.value.state)),
    "the filed face lane does claim reported provenance",
  );
  check(
    ir.nodes
      .filter((node) => node.historical_basis === "no_plan_row")
      .flatMap((node) => node.historical)
      .every(
        (slot) =>
          slot.value.state === "missing" && numericValueOf(slot.value) === null,
      ),
    "a node with no row-plan row is missing, never zero",
  );
}

// ---------------------------------------------------------------------------
// (2c) An empty legacy revolver shell is a structural historical absence, not
//      six economic zeroes.  The negative cases prove the classifier cannot
//      swallow either real activity or an explicitly sourced zero.
// ---------------------------------------------------------------------------
{
  const netCash = await compileFixture("standard-net-cash-v2");
  const netCashIr = compileEconomicIr({ ...netCash });
  const revolverRoles = new Set(["rcf_draw", "rcf_repayment"]);
  const netCashRows = netCash.rowPlan.statement_rows.cash_flow.filter((row) =>
    revolverRoles.has(row.semantic_role),
  );
  const netCashNodes = netCashIr.nodes.filter((node) =>
    revolverRoles.has(node.semantic_role),
  );
  check(
    netCashRows.length === 2 &&
      netCashRows.every(
        (row) =>
          row.historical_authority === "not_applicable" &&
          row.historical_value_states?.every(
            (state) => state === "not_applicable",
          ),
      ),
    "empty legacy RCF shells acquire explicit not_applicable historical authority",
  );
  check(
    netCashNodes.length === 2 &&
      netCashNodes
        .flatMap((node) => node.historical)
        .every(
          (slot) =>
            slot.value.state === "not_applicable" &&
            numericValueOf(slot.value) === null,
        ),
    "the six absent net-cash RCF cells type as null not_applicable, never derived zero",
  );

  const compileMutation = (mutate) => {
    const modelCase = structuredClone(netCash.modelCase);
    const rows = modelCase.statement_structure.cash_flow.filter((row) =>
      revolverRoles.has(row.semantic_role),
    );
    mutate(rows);
    const instrumentPeriodState = compileInstrumentPeriodState(modelCase);
    const rowPlan = compileRowPlan(modelCase, { instrumentPeriodState });
    const semanticManifest = compileSemanticManifest(modelCase, rowPlan, {
      instrumentPeriodState,
    });
    const modelIr = compileModelIrV3({
      modelCase,
      rowPlan,
      semanticManifest,
      sourceCrosswalk: [],
    });
    return {
      rowPlan,
      ir: compileEconomicIr({ modelCase, rowPlan, semanticManifest, modelIr }),
    };
  };

  const active = compileMutation(([draw]) => {
    draw.values = [0, 25, 0, ...draw.values.slice(3)];
  });
  const activeDraw = active.rowPlan.statement_rows.cash_flow.find(
    (row) => row.semantic_role === "rcf_draw",
  );
  const activeDrawNode = active.ir.nodes.find(
    (node) => node.semantic_role === "rcf_draw",
  );
  check(
    activeDraw.historical_authority !== "not_applicable" &&
      activeDrawNode.historical.map((slot) => numericValueOf(slot.value)).join(",") ===
        "0,25,0",
    "one real RCF movement defeats structural-absence typing and preserves its surrounding economic zeroes",
  );

  const sourcedZero = compileMutation(([draw]) => {
    draw.historical_authority = "source_input";
  });
  const sourcedZeroNode = sourcedZero.ir.nodes.find(
    (node) => node.semantic_role === "rcf_draw",
  );
  check(
    sourcedZeroNode.historical.every(
      (slot) =>
        slot.value.state === "reported_zero" &&
        numericValueOf(slot.value) === 0,
    ),
    "explicit source authority preserves a reported historical zero instead of blanking it",
  );
}

// ---------------------------------------------------------------------------
// (3) Typed-value coverage: every economic slot is a typed value, never a bare
//     number, and the validator REFUSES a bare number rather than repairing it.
// ---------------------------------------------------------------------------
{
  const ir = compileEconomicIr({ ...maximal });
  const slots = [...economicIrTypedSlots(ir)];
  check(slots.length > 0, "the Economic IR exposes typed slots");
  check(
    slots.every(([, slot]) => slot !== null && typeof slot === "object"),
    "no economic slot holds a bare number where a typed state is required",
  );
  check(
    slots.every(([, slot]) => ALL_STATES.includes(slot.state)),
    "every economic slot claims one of the twelve declared value states",
  );
  check(
    slots.every(([, slot]) => slot.contract_version === "1.0.0"),
    "every economic slot stamps the typed-value contract version",
  );
  check(
    slots.every(([path, slot]) => {
      try {
        numericValueOf(slot);
        return true;
      } catch {
        return false;
      }
    }),
    "every economic slot validates under the typed-value contract",
  );
  check(
    ir.coverage.typed_slots === slots.length &&
      ir.coverage.bare_number_slots === 0,
    "the coverage census counts exactly the typed slots and no bare numbers",
  );
  check(
    ALL_STATES.every((state) => Object.hasOwn(ir.coverage.by_state, state)),
    "the census reports all twelve states, including the ones with zero members",
  );
  check(
    ALL_STATES.reduce((sum, state) => sum + ir.coverage.by_state[state], 0) ===
      slots.length,
    "the per-state census sums to the typed-slot count",
  );

  // The validator refuses a smuggled bare number; it does not repair it.
  // A bare 0 is the exact drift typed values exist to prevent, so it is the
  // mutation used here.
  const nodeLane = /^nodes\[(\d+)\]\.(historical|forecast)\[(\d+)\]\.value$/;
  for (const bareSlotPath of [
    slots.find(([path]) => nodeLane.test(path))[0],
    "schedules[0].rcf.draw",
  ]) {
    const tampered = structuredClone(ir);
    const match = nodeLane.exec(bareSlotPath);
    if (match) {
      tampered.nodes[Number(match[1])][match[2]][Number(match[3])].value = 0;
    } else {
      tampered.schedules[0].rcf.draw = 0;
    }
    const bareErrors = validateEconomicIr(tampered);
    const readBack = match
      ? tampered.nodes[Number(match[1])][match[2]][Number(match[3])].value
      : tampered.schedules[0].rcf.draw;
    check(
      bareErrors.some((error) => error.includes(bareSlotPath)),
      `a bare number smuggled into ${bareSlotPath} is refused by name`,
    );
    check(
      bareErrors.some((error) =>
        error.includes("is not a typed financial value"),
      ),
      `${bareSlotPath}: the refusal names the typed-value contract`,
    );
    check(
      bareErrors.some((error) => error.includes("bare")),
      `${bareSlotPath}: the coverage census records the bare slot`,
    );
    check(readBack === 0, `${bareSlotPath}: the validator repairs nothing`);
  }
}

// ---------------------------------------------------------------------------
// (4) An unresolved input NEVER becomes zero — the whole point of typed values.
// ---------------------------------------------------------------------------
{
  const ir = compileEconomicIr({ ...maximal });
  const neverZero = [...economicIrTypedSlots(ir)].filter(([, slot]) =>
    NEVER_ZERO_STATES.includes(slot.state),
  );
  check(
    neverZero.length > 0,
    "the real case does carry unresolved / not-applicable economic slots",
  );
  check(
    neverZero.every(([, slot]) => numericValueOf(slot) === null),
    "every never-zero slot reads as null, never as zero",
  );
  check(
    neverZero.every(([, slot]) => !Object.hasOwn(slot, "value")),
    "a never-zero slot carries no value field at all",
  );

  // The forecast lane holds no number at IR-compile time: revenue's forecast
  // cache is null in the row plan and its authority is a broker input. It must
  // be unresolved, reading null — not a zero-valued forecast.
  const revenue = ir.nodes.find((node) => node.display_id === "revenue");
  check(Boolean(revenue), "the Economic IR carries the revenue node");
  check(
    revenue.forecast.length > 0 &&
      revenue.forecast.every(
        (slot) =>
          NEVER_ZERO_STATES.includes(slot.value.state) &&
          numericValueOf(slot.value) === null,
      ),
    "an unresolved forecast input reads null, never zero",
  );
  check(
    revenue.historical.some(
      (slot) =>
        VALUE_BEARING_STATES.includes(slot.value.state) &&
        typeof numericValueOf(slot.value) === "number",
    ),
    "the historical lane does carry real filed numbers (the IR is not value-free)",
  );

  // A structurally absent facility is not_applicable, never a fabricated zero.
  const noFacility = compileEconomicIr({
    ...maximal,
    modelCase: {
      ...maximal.modelCase,
      rcf_policy: undefined,
      acquisition: undefined,
    },
  });
  const absentRcf = noFacility.schedules.flatMap((period) =>
    ["opening_balance", "draw", "repayment", "ending_balance"].map(
      (field) => period.rcf[field],
    ),
  );
  check(
    absentRcf.length > 0 &&
      absentRcf.every(
        (slot) => slot.state === "not_applicable" && numericValueOf(slot) === null,
      ),
    "an absent facility is not_applicable, never a zero balance",
  );
}

// ---------------------------------------------------------------------------
// (5) The schedule state the proof projection omits is present and typed.
// ---------------------------------------------------------------------------
{
  const ir = compileEconomicIr({ ...maximal });
  const forecastPeriods = maximal.modelCase.periods.filter(
    (period) => period.status === "forecast",
  );
  check(
    ir.schedules.length === forecastPeriods.length && ir.schedules.length > 0,
    "the schedule lane covers every case-declared forecast period (never a hard-wired 3)",
  );
  check(
    ir.schedules.every(
      (period) => period.schema_version === SCHEDULE_TYPED_STATE_SCHEMA_VERSION,
    ),
    "each schedule period is a P4.3 typed-schedule artifact",
  );
  check(
    ir.schedules.every(
      (period) =>
        period.rcf && period.acquisition && period.cash?.aggregates,
    ),
    "the schedule lane carries RCF, acquisition and cash state",
  );
  check(
    ir.schedules.every((period, index) => period.period_index === index),
    "schedule periods are ordered and index-bound",
  );
  check(
    JSON.stringify(maximal.modelIr).includes("schedule-typed-states") === false,
    "the proof projection still omits schedule state (the IR is the addition)",
  );
}

// ---------------------------------------------------------------------------
// (6) Schema validation through the repository JSON-Schema validator.
// ---------------------------------------------------------------------------
{
  const ir = compileEconomicIr({ ...maximal });
  check(
    validateJsonSchema(ir, ECONOMIC_IR_SCHEMA).length === 0,
    "the compiled Economic IR validates against assets/economic-ir-v1.schema.json",
  );
  check(
    ECONOMIC_IR_SCHEMA.additionalProperties === false,
    "the Economic IR contract is closed (additionalProperties false)",
  );
  const undeclared = structuredClone(ir);
  undeclared.smuggled_field = 1;
  check(
    validateJsonSchema(undeclared, ECONOMIC_IR_SCHEMA).length > 0,
    "an undeclared top-level field is refused by the schema",
  );
  const wrongMode = structuredClone(ir);
  wrongMode.mode = "gating";
  check(
    validateJsonSchema(wrongMode, ECONOMIC_IR_SCHEMA).length > 0,
    "the schema pins the IR to shadow mode",
  );
  const noSeal = structuredClone(ir);
  delete noSeal.seal;
  check(
    validateJsonSchema(noSeal, ECONOMIC_IR_SCHEMA).length > 0,
    "an unsealed IR is refused by the schema",
  );
  check(
    validateEconomicIr(undeclared).length > 0 &&
      validateEconomicIr(noSeal).length > 0,
    "validateEconomicIr surfaces the schema refusals too",
  );
}

// ---------------------------------------------------------------------------
// (7) Mutation: a tampered IR field changes the hash and breaks the seal.
// ---------------------------------------------------------------------------
{
  const ir = compileEconomicIr({ ...maximal });
  const mutations = [
    ["a node identity", (candidate) => { candidate.nodes[0].display_id = "tampered"; }],
    ["a typed value state", (candidate) => { candidate.nodes[0].historical[0].value = { contract_version: "1.0.0", state: "unresolved" }; }],
    ["a typed value number", (candidate) => {
      const slot = candidate.nodes.flatMap((node) => node.historical).find(
        (item) => Object.hasOwn(item.value, "value"),
      );
      slot.value.value += 1;
    }],
    ["a schedule state", (candidate) => { candidate.schedules[0].rcf.draw = { contract_version: "1.0.0", state: "not_applicable" }; }],
    ["the coverage census", (candidate) => { candidate.coverage.by_state.unresolved += 1; }],
  ];
  for (const [what, mutate] of mutations) {
    const tampered = structuredClone(ir);
    mutate(tampered);
    check(
      economicIrContentSha256(tampered) !== ir.seal.content_sha256,
      `tampering with ${what} changes the Economic IR hash`,
    );
    check(
      validateEconomicIr(tampered).some((error) => error.includes("seal")),
      `tampering with ${what} breaks the seal check`,
    );
  }
  const resealed = structuredClone(ir);
  resealed.nodes[0].display_id = "tampered";
  resealed.seal.content_sha256 = economicIrContentSha256(resealed);
  check(
    resealed.seal.content_sha256 !== ir.seal.content_sha256,
    "a resealed mutation still carries a different hash from the original",
  );
}

// ---------------------------------------------------------------------------
// (8) SHADOW discipline: the IR rides beside the proof projection, changes no
//     decision, no finding and no emitted hash, and its seal is in the receipt.
// ---------------------------------------------------------------------------
{
  const { modelIr } = maximal;
  check(
    JSON.stringify(Object.keys(modelIr)) ===
      JSON.stringify([
        "schema_version",
        "case_id",
        "case_sha256",
        "evidence_epoch",
        "planes",
        "proof",
      ]),
    "the proof projection's enumerable shape is unchanged (every emitted hash is byte-identical)",
  );
  check(
    !JSON.stringify(modelIr).includes("economic_ir"),
    "the shadow IR never enters the serialised model-ir-v3 sidecar",
  );
  const shadow = shadowEconomicIrOf(modelIr);
  check(Boolean(shadow), "the shadow IR is attached to the proof projection");
  check(
    shadow.status === "sealed" && shadow.gates_delivery === false,
    "the attached shadow is sealed and gates nothing",
  );
  check(
    shadow.economic_ir_sha256 === shadow.economic_ir.seal.content_sha256,
    "the shadow record's hash is the IR's own seal",
  );
  check(
    shadow.economic_ir_sha256 ===
      compileEconomicIr({ ...maximal }).seal.content_sha256,
    "the shadow attached during projection equals an independent compile",
  );
  const receipt = transformationReceipt(modelIr);
  check(
    receipt.economic_ir_sha256 === shadow.economic_ir_sha256,
    "the transformation receipt records the Economic IR seal",
  );
  check(
    receipt.economic_ir.mode === "shadow" &&
      receipt.economic_ir.gates_delivery === false &&
      receipt.economic_ir.status === "sealed",
    "the receipt records the IR as a non-gating shadow",
  );
  check(
    receipt.economic_ir.node_count === shadow.economic_ir.nodes.length &&
      receipt.economic_ir.typed_slot_count ===
        shadow.economic_ir.coverage.typed_slots,
    "the receipt records the node and typed-slot counts a golden can pin",
  );
  check(
    receipt.status === modelIr.proof.status &&
      receipt.output_kind === "model_ir_v3" &&
      receipt.output_sha256 !== receipt.economic_ir_sha256 &&
      receipt.passes.length === 5,
    "the receipt's existing status/hash/pass fields still describe the proof projection alone",
  );
  check(
    modelIr.proof.blocking_findings.length === 0 &&
      modelIr.proof.warnings.length === 0,
    "the shadow adds no blocker and no warning to the real fixture",
  );
}

// ---------------------------------------------------------------------------
// (9) Containment: a shadow that cannot compile is recorded, never thrown, and
//     never blocks. A caseless projection (the P2.5 synthetic harness shape)
//     must still compile PASS.
// ---------------------------------------------------------------------------
{
  const synthetic = compileModelIrV3({
    modelCase: {},
    rowPlan: { statement_rows: { income_statement: [], cash_flow: [] } },
    semanticManifest: {
      case_id: "p31-caseless",
      case_sha256: "0".repeat(64),
      accounting_basis: "ifrs",
      source_inventory: [],
      edges: [],
      nodes: [],
    },
    sourceCrosswalk: [],
  });
  check(
    synthetic.proof.status === "PASS",
    "a caseless synthetic projection still compiles PASS with the shadow attached",
  );
  const shadow = shadowEconomicIrOf(synthetic);
  check(
    shadow.status === "sealed" && shadow.economic_ir.schedules.length === 0,
    "a case with no forecast periods seals an empty schedule lane rather than inventing one",
  );
  check(
    shadow.economic_ir.periods.forecast.length === 0 &&
      shadow.economic_ir.periods.historical.length === 0,
    "period vocabulary is derived from the case, never assumed",
  );
  check(
    transformationReceipt(synthetic).economic_ir.status === "sealed",
    "the caseless receipt still records a shadow status",
  );
}

console.log(JSON.stringify({ status: "PASS", checks }));
