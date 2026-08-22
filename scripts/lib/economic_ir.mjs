/**
 * P3.1 — the canonical Economic IR, compiled in SHADOW mode.
 *
 * model_ir_v3's projection is a *proof* object: five planes of identity,
 * authority, graph and presentation, with a blocking PASS/BLOCK verdict and no
 * economic values anywhere in it. This module compiles the missing half — the
 * canonical economic object — beside it:
 *
 *  - one node per economic concept (the projection's concept identity), each
 *    carrying a HISTORICAL lane and a FORECAST lane;
 *  - every value slot is a TYPED financial value (P1.2, twelve states) — never
 *    a bare number, and blank / nil / missing / unresolved NEVER become zero;
 *  - the per-forecast-period typed SCHEDULE state (P4.3) the proof projection
 *    omits entirely — RCF, acquisition and cash buckets;
 *  - a deterministic seal: same case -> same sha256.
 *
 * SHADOW discipline (the whole point of this package):
 *  - the IR is attached to the proof projection as a NON-ENUMERABLE property,
 *    so JSON.stringify — and therefore the emitted .model-ir-v3.json sidecar,
 *    transformationReceipt().output_sha256, the workbook proof contract's
 *    model_ir_sha256 and its closure hash — are byte-identical to the tree
 *    before this package;
 *  - it changes no decision, no finding and no emitted number;
 *  - a shadow that cannot compile is RECORDED as unavailable, never thrown:
 *    the shadow lane must not be able to fail a delivery. Its correctness is
 *    proven by scripts/run_economic_ir_tests.mjs, not by blocking a run.
 *
 * Validators validate, they never repair: compileEconomicIr THROWS on an
 * invalid compile (contained by the shadow attach), and validateEconomicIr
 * returns error strings without touching the object it judges.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { validateJsonSchema } from "./json_schema.mjs";
import {
  NEVER_ZERO_STATES,
  VALUE_BEARING_STATES,
  numericValueOf,
  typedValue,
} from "./typed_financial_value.mjs";
import {
  CASH_AGGREGATE_SELECTORS,
  SCHEDULE_TYPED_STATE_SCHEMA_VERSION,
  compileScheduleTypedStates,
  forecastPeriodsOf,
} from "./schedule_typed_states.mjs";

export const ECONOMIC_IR_SCHEMA_VERSION = "economic-ir/1.0";
export const ECONOMIC_IR_SHADOW_SCHEMA_VERSION = "economic-ir-shadow/1.0";
/** The non-enumerable property the shadow IR rides on. */
export const ECONOMIC_IR_SHADOW_PROPERTY = "economic_ir_shadow";

/** Read the contract version off the typed-value constructor, never restate it. */
const TYPED_VALUE_CONTRACT_VERSION = typedValue("missing").contract_version;

const ALL_VALUE_STATES = Object.freeze([
  ...VALUE_BEARING_STATES,
  ...NEVER_ZERO_STATES,
]);

// --- the contract: load, validate, freeze (economic_solve_policy precedent) --
const loadedSchema = JSON.parse(
  readFileSync(
    new URL("../../assets/economic-ir-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
for (const [description, condition] of [
  [
    "$id must be the Economic IR contract id",
    loadedSchema.$id === "https://excel-inflow.local/economic-ir-v1.schema.json",
  ],
  [
    `properties.schema_version.const must be ${ECONOMIC_IR_SCHEMA_VERSION}`,
    loadedSchema.properties?.schema_version?.const === ECONOMIC_IR_SCHEMA_VERSION,
  ],
  [
    "the contract must be closed (additionalProperties false)",
    loadedSchema.additionalProperties === false,
  ],
  [
    "the contract must pin mode to shadow",
    loadedSchema.properties?.mode?.const === "shadow",
  ],
  [
    "the contract must pin gates_delivery to false",
    loadedSchema.properties?.gates_delivery?.const === false,
  ],
  [
    "the contract must forbid bare numbers in typed slots (coverage.bare_number_slots const 0)",
    loadedSchema.$defs?.coverage?.properties?.bare_number_slots?.const === 0,
  ],
  [
    "the contract's value-state enum must be exactly the twelve declared states",
    JSON.stringify([...(loadedSchema.$defs?.valueState?.enum ?? [])].sort()) ===
      JSON.stringify([...ALL_VALUE_STATES].sort()),
  ],
]) {
  if (!condition) {
    throw new Error(`Invalid Economic IR contract: ${description}.`);
  }
}
export const ECONOMIC_IR_SCHEMA = Object.freeze(loadedSchema);

// --- canonicalisation ------------------------------------------------------
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Locale-independent ordering, matching model_ir_v3's portableCompare. */
function portableCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

/**
 * The Economic IR's content hash: sha256 over the canonical IR EXCLUDING its
 * own seal. Any change to any field changes this hash.
 */
export function economicIrContentSha256(ir) {
  const { seal, ...content } = ir ?? {};
  void seal;
  return sha256(content);
}

// --- period vocabulary (derived from the case, never assumed) --------------
function periodIdOf(period, index) {
  const date = period?.date;
  return typeof date === "string" && date.length > 0 ? date : `period_${index}`;
}

function periodVocabulary(modelCase) {
  const declared = Array.isArray(modelCase?.periods) ? modelCase.periods : [];
  const historical = [];
  const forecast = [];
  declared.forEach((period, index) => {
    const period_id = periodIdOf(period, index);
    if (period?.status === "forecast") {
      forecast.push({
        period_index: index,
        forecast_index: forecast.length,
        period_id,
        status: "forecast",
      });
    } else if (period?.status === "historical") {
      historical.push({ period_index: index, period_id, status: "historical" });
    }
  });
  return { historical, forecast };
}

// --- the historical lane ---------------------------------------------------
/**
 * Which series the historical lane may read, decided by exactly the rule the
 * P2.5 footing pass uses (model_ir_v3.mjs memberFiledState): only source_input
 * face rows and the retained reported series behind a reconciled total are
 * FILED history. Schedule-owned and formula-owned caches are model
 * projections, so they are typed derived_number, never reported_*.
 */
function historicalBasisOf(planRow) {
  if (!planRow) return "no_plan_row";
  if (planRow.row_type === "header") return "structural_header";
  const authority = planRow.historical_authority ?? null;
  if (authority === "reported_total_reconciled") return "reported_total_reconciled";
  if (authority === "source_input") return "filed_face_series";
  if (
    authority === null &&
    !planRow.calculation &&
    ["input", "uncalculated"].includes(planRow.row_type)
  ) return "filed_face_series";
  return "model_projection";
}

function filedSeriesOf(planRow, basis) {
  return basis === "reported_total_reconciled"
    ? planRow.reported_historical_values
    : planRow.values;
}

function precisionOf(planRow, basis, periodIndex) {
  const precisions =
    basis === "reported_total_reconciled"
      ? planRow.reported_historical_value_precisions
      : planRow.historical_value_precisions;
  const precision = Array.isArray(precisions) ? precisions[periodIndex] : null;
  return Number.isInteger(precision) && precision >= 0 && precision <= 12
    ? precision
    : null;
}

/**
 * A FILED cell as a typed value. Absent is `missing`, an explicit empty string
 * is `reported_blank`, an unparseable cell is `parse_failure` — none of them is
 * ever zero. Only a filed 0 is `reported_zero`.
 */
function typedFiledValue(raw, precision) {
  if (raw === undefined || raw === null) return typedValue("missing");
  if (raw === "") return typedValue("reported_blank");
  if (typeof raw === "boolean") {
    return typedValue("parse_failure", {
      raw_text: String(raw),
      failure_reason: "a boolean is not a filed numeric",
    });
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    return typedValue("parse_failure", {
      raw_text: String(raw),
      failure_reason: "the filed cell does not parse to a finite number",
    });
  }
  const raw_text = precision === null ? String(number) : number.toFixed(precision);
  if (number === 0) return typedValue("reported_zero", { value: 0, raw_text });
  return typedValue("reported_number", {
    value: number,
    raw_text,
    ...(precision === null ? {} : { precision }),
  });
}

/** A model-projected historical cache: derived, or unresolved — never zero. */
function typedProjectedValue(raw, planRow) {
  if (planRow?.historical_authority === "not_applicable") {
    return typedValue("not_applicable");
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return typedValue("unresolved");
  }
  return typedValue("derived_number", {
    value: raw,
    derivation: {
      operator:
        planRow?.calculation?.operator ??
        planRow?.historical_authority ??
        "model_projection",
      refs: (planRow?.calculation?.refs ?? []).map(String),
    },
  });
}

function historicalSlotValue(planRow, basis, periodIndex) {
  if (basis === "no_plan_row") return typedValue("missing");
  if (basis === "structural_header") return typedValue("not_applicable");
  const series = filedSeriesOf(planRow, basis);
  const raw = Array.isArray(series) ? series[periodIndex] : undefined;
  if (basis === "model_projection") return typedProjectedValue(raw, planRow);
  return typedFiledValue(raw, precisionOf(planRow, basis, periodIndex));
}

// --- the forecast lane -----------------------------------------------------
/**
 * A forecast slot's typed value.
 *
 * The IR compiles BEFORE the solver runs and before any workbook formula
 * exists, so for most producers it holds no number — and the honest typed
 * reading of "no number here" is `unresolved` (null), never zero. Who WILL
 * write the cell is carried in the slot's own producer_type / authority_status
 * fields, not smuggled into the value state.
 */
function forecastSlotValue(item, planRow, absolutePeriodIndex) {
  if (item.status !== "resolved") return typedValue("unresolved");
  if (item.producer_type === "NotApplicable") return typedValue("not_applicable");
  if (item.producer_type === "CapturedBy") {
    return item.capture_parent_display_id
      ? typedValue("captured", {
          capture_parent_id: String(item.capture_parent_display_id),
        })
      : typedValue("unresolved");
  }
  if (item.producer_type === "ExplicitZero") {
    // A declared zero is a genuine zero — that is what reported_zero is for.
    return typedValue("reported_zero", { value: 0, raw_text: "0" });
  }
  const cached = Array.isArray(planRow?.values)
    ? planRow.values[absolutePeriodIndex]
    : undefined;
  if (typeof cached === "number" && Number.isFinite(cached)) {
    return typedValue("derived_number", {
      value: cached,
      derivation: {
        operator: item.formula_operator ?? item.method ?? "forecast_producer",
        refs: (item.formula_refs ?? []).map(String),
      },
    });
  }
  return typedValue("unresolved");
}

// --- the schedule lane ----------------------------------------------------
function yearOf(periodId) {
  const year = Number(String(periodId).slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

function cashBucketsOf(modelCase, rowPlan) {
  const declared = Array.isArray(modelCase?.cash_policy?.buckets)
    ? modelCase.cash_policy.buckets
    : Array.isArray(rowPlan?.cash_buckets)
      ? rowPlan.cash_buckets
      : [];
  return declared.map((bucket) => ({
    bucket_id: String(bucket.bucket_id ?? "unknown"),
    label: bucket.label ?? null,
    included_in_cash_flow_cash: bucket.included_in_cash_flow_cash !== false,
    available_for_liquidity: bucket.available_for_liquidity === true,
    net_debt_eligible_percentage: bucket.net_debt_eligible_percentage,
    interest_eligible_percentage: bucket.interest_eligible_percentage,
  }));
}

/**
 * The structural schedule skeleton for one forecast period. `solvedSchedules`
 * (absent in shadow mode — the solver has not run) may supply the numbers a
 * later phase holds; without them every present-but-unsolved quantity types as
 * `unresolved` and every structurally absent facility as `not_applicable`.
 * Neither is zero.
 */
function scheduleInputFor(modelCase, rowPlan, period, periodCount, solved) {
  const rcfPolicy = modelCase?.rcf_policy ?? null;
  const rcfEnabled = Boolean(
    rcfPolicy &&
      (rcfPolicy.instrument_id || Number.isFinite(Number(rcfPolicy.capacity))),
  );
  const acquisition = modelCase?.acquisition ?? null;
  const acquisitionEnabled =
    Boolean(acquisition) &&
    (acquisition.enabled === true || Number(acquisition.enabled) === 1);
  const closeYear = acquisitionEnabled ? Number(acquisition.close_year) : null;
  const periodYear = yearOf(period.period_id);
  const comparable =
    Number.isInteger(closeYear) && Number.isInteger(periodYear);
  return {
    period_id: period.period_id,
    period_index: period.forecast_index,
    period_count: periodCount,
    rcf: {
      enabled: rcfEnabled,
      instrument_id: rcfPolicy?.instrument_id ?? null,
      ...(solved?.rcf ?? {}),
    },
    acquisition: {
      enabled: acquisitionEnabled,
      active: comparable ? periodYear >= closeYear : false,
      closes_this_period: comparable ? periodYear === closeYear : false,
      ...(solved?.acquisition ?? {}),
    },
    cash: {
      buckets: cashBucketsOf(modelCase, rowPlan),
      aggregates: {},
      ...(solved?.cash ?? {}),
    },
  };
}

// --- typed-slot walk ------------------------------------------------------
/**
 * Every slot in the IR that MUST hold a typed financial value, as
 * [path, slot] pairs. The paths are stable and are what a validator, a census
 * and a Phase-9 parity diff all address slots by.
 */
export function* economicIrTypedSlots(ir) {
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const historical = Array.isArray(node?.historical) ? node.historical : [];
    for (let slot = 0; slot < historical.length; slot += 1) {
      yield [`nodes[${index}].historical[${slot}].value`, historical[slot]?.value];
    }
    const forecast = Array.isArray(node?.forecast) ? node.forecast : [];
    for (let slot = 0; slot < forecast.length; slot += 1) {
      yield [`nodes[${index}].forecast[${slot}].value`, forecast[slot]?.value];
    }
  }
  const schedules = Array.isArray(ir?.schedules) ? ir.schedules : [];
  for (let index = 0; index < schedules.length; index += 1) {
    const period = schedules[index];
    const at = `schedules[${index}]`;
    for (const field of ["opening_balance", "draw", "repayment", "ending_balance"]) {
      yield [`${at}.rcf.${field}`, period?.rcf?.[field]];
    }
    for (const field of [
      "debt_addition",
      "debt_proceeds",
      "cash_consideration",
      "debt_repayment",
      "debt_ending_balance",
    ]) {
      yield [`${at}.acquisition.${field}`, period?.acquisition?.[field]];
    }
    yield [`${at}.cash.ending_cash`, period?.cash?.ending_cash];
    const buckets = Array.isArray(period?.cash?.buckets) ? period.cash.buckets : [];
    for (let bucket = 0; bucket < buckets.length; bucket += 1) {
      yield [
        `${at}.cash.buckets[${bucket}].opening_balance`,
        buckets[bucket]?.opening_balance,
      ];
      yield [
        `${at}.cash.buckets[${bucket}].ending_balance`,
        buckets[bucket]?.ending_balance,
      ];
    }
    for (const selector of CASH_AGGREGATE_SELECTORS) {
      yield [
        `${at}.cash.aggregates.${selector.aggregate_id}`,
        period?.cash?.aggregates?.[selector.aggregate_id],
      ];
    }
  }
}

function censusOf(ir) {
  const by_state = Object.fromEntries(ALL_VALUE_STATES.map((state) => [state, 0]));
  let typed_slots = 0;
  let historical_slots = 0;
  let forecast_slots = 0;
  let schedule_slots = 0;
  let value_bearing_slots = 0;
  let never_zero_slots = 0;
  let bare_number_slots = 0;
  for (const [path, slot] of economicIrTypedSlots(ir)) {
    typed_slots += 1;
    if (path.startsWith("schedules[")) schedule_slots += 1;
    else if (path.includes(".historical[")) historical_slots += 1;
    else forecast_slots += 1;
    if (
      slot === null ||
      typeof slot !== "object" ||
      Array.isArray(slot) ||
      !Object.hasOwn(by_state, slot.state)
    ) {
      bare_number_slots += 1;
      continue;
    }
    by_state[slot.state] += 1;
    if (VALUE_BEARING_STATES.includes(slot.state)) value_bearing_slots += 1;
    else never_zero_slots += 1;
  }
  return {
    typed_slots,
    historical_slots,
    forecast_slots,
    schedule_slots,
    value_bearing_slots,
    never_zero_slots,
    bare_number_slots,
    by_state,
  };
}

// --- the compiler ---------------------------------------------------------
/**
 * Compile the canonical Economic IR from the case, the row plan and the sealed
 * proof projection. THROWS if the compiled IR does not satisfy its contract —
 * a compiler that patches its own output would defeat the point.
 */
export function compileEconomicIr({
  modelCase,
  rowPlan,
  semanticManifest,
  modelIr,
  solvedSchedules = null,
}) {
  if (!Array.isArray(modelIr?.planes?.statement)) {
    throw new Error(
      "compileEconomicIr requires a compiled model_ir_v3 projection (planes.statement).",
    );
  }
  const periods = periodVocabulary(modelCase);
  const planRowById = new Map();
  for (const rows of Object.values(rowPlan?.statement_rows ?? {})) {
    for (const row of rows ?? []) planRowById.set(row.row_id, row);
  }
  const authoritiesByDisplay = new Map();
  for (const item of modelIr.planes.authority) {
    const bucket = authoritiesByDisplay.get(item.display_id) ?? [];
    bucket.push(item);
    authoritiesByDisplay.set(item.display_id, bucket);
  }
  const forecastPeriodByIndex = new Map(
    periods.forecast.map((period) => [period.forecast_index, period]),
  );

  const nodes = modelIr.planes.statement
    .map((node) => {
      const planRow = planRowById.get(node.display_id) ?? null;
      const basis = historicalBasisOf(planRow);
      const historical = periods.historical.map((period) => ({
        period_index: period.period_index,
        period_id: period.period_id,
        value: historicalSlotValue(planRow, basis, period.period_index),
      }));
      const forecast = (authoritiesByDisplay.get(node.display_id) ?? [])
        .filter((item) => forecastPeriodByIndex.has(item.forecast_index))
        .map((item) => {
          const period = forecastPeriodByIndex.get(item.forecast_index);
          return {
            forecast_index: item.forecast_index,
            period_index: period.period_index,
            period_id: period.period_id,
            producer_type: item.producer_type,
            authority_status: item.status,
            method: item.method ?? null,
            source_kind: item.source_kind ?? null,
            source_id: item.source_id ?? null,
            capture_parent_display_id: item.capture_parent_display_id ?? null,
            formula_operator: item.formula_operator ?? null,
            formula_refs: (item.formula_refs ?? []).map(String),
            period_relation: item.period_relation ?? "same_period",
            value: forecastSlotValue(item, planRow, period.period_index),
          };
        })
        .sort((left, right) => left.forecast_index - right.forecast_index);
      return {
        economic_concept_id: node.economic_concept_id,
        display_id: node.display_id,
        section: node.section,
        label: node.label ?? "",
        semantic_role: node.semantic_role ?? null,
        projection_status: node.projection_status ?? "rendered",
        definition_signature: { ...node.definition_signature },
        source_line_ids: [...(node.source_line_ids ?? [])].map(String),
        historical_basis: basis,
        historical,
        forecast,
      };
    })
    .sort(
      (left, right) =>
        portableCompare(left.economic_concept_id, right.economic_concept_id) ||
        portableCompare(left.display_id, right.display_id),
    );

  const forecastPeriods = forecastPeriodsOf(modelCase);
  if (forecastPeriods.length !== periods.forecast.length) {
    throw new Error(
      `Economic IR forecast period count ${periods.forecast.length} disagrees with the case's ${forecastPeriods.length}.`,
    );
  }
  const schedules = periods.forecast.map((period) =>
    compileScheduleTypedStates(
      scheduleInputFor(
        modelCase,
        rowPlan,
        period,
        periods.forecast.length,
        solvedSchedules?.[period.forecast_index] ?? null,
      ),
    ),
  );

  const ir = {
    schema_version: ECONOMIC_IR_SCHEMA_VERSION,
    mode: "shadow",
    gates_delivery: false,
    case_id: modelIr.case_id ?? semanticManifest?.case_id ?? "unknown_case",
    case_sha256: modelIr.case_sha256,
    evidence_epoch_sha256: modelIr.evidence_epoch.epoch_sha256,
    contracts: {
      typed_financial_value: TYPED_VALUE_CONTRACT_VERSION,
      schedule_typed_states: SCHEDULE_TYPED_STATE_SCHEMA_VERSION,
      proof_projection_schema_version: modelIr.schema_version,
    },
    periods,
    nodes,
    schedules,
    coverage: null,
    seal: null,
  };
  ir.coverage = censusOf(ir);
  ir.seal = { content_sha256: "", sealed_slots: ir.coverage.typed_slots };
  ir.seal.content_sha256 = economicIrContentSha256(ir);

  const errors = validateEconomicIr(ir);
  if (errors.length > 0) {
    throw new Error(
      `compiled Economic IR invalid (${errors.length} error(s)): ${errors[0]}`,
    );
  }
  return ir;
}

/**
 * Validate a compiled Economic IR. Returns error strings (empty = valid) and
 * NEVER mutates the candidate.
 */
export function validateEconomicIr(ir) {
  const errors = validateJsonSchema(ir, ECONOMIC_IR_SCHEMA);
  for (const [path, slot] of economicIrTypedSlots(ir)) {
    let numeric;
    try {
      numeric = numericValueOf(slot); // throws on anything not a typed value
    } catch (error) {
      errors.push(`${path} is not a typed financial value: ${error.message}`);
      continue;
    }
    if (VALUE_BEARING_STATES.includes(slot.state)) {
      if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
        errors.push(
          `${path} claims value-bearing state ${slot.state} but reads ${numeric}.`,
        );
      }
    } else if (numeric !== null) {
      errors.push(
        `${path} claims never-zero state ${slot.state} but reads ${numeric}; a blank, missing or unresolved value can never surface as a number.`,
      );
    }
  }
  if (ir?.coverage !== undefined) {
    const recomputed = censusOf(ir);
    if (
      JSON.stringify(canonical(ir.coverage)) !==
      JSON.stringify(canonical(recomputed))
    ) {
      errors.push(
        `coverage census does not describe the IR's own typed slots (declared ${JSON.stringify(ir.coverage?.typed_slots)} slots / ${JSON.stringify(ir.coverage?.bare_number_slots)} bare, walked ${recomputed.typed_slots} / ${recomputed.bare_number_slots}).`,
      );
    }
  }
  if (typeof ir?.seal?.content_sha256 === "string") {
    const expected = economicIrContentSha256(ir);
    if (ir.seal.content_sha256 !== expected) {
      errors.push(
        `seal.content_sha256 ${ir.seal.content_sha256} does not match the IR content ${expected}.`,
      );
    }
    if (ir.seal.sealed_slots !== ir.coverage?.typed_slots) {
      errors.push(
        `seal.sealed_slots ${ir.seal.sealed_slots} does not match the sealed typed-slot count ${ir.coverage?.typed_slots}.`,
      );
    }
  } else {
    errors.push("the Economic IR carries no seal.content_sha256.");
  }
  return errors;
}

// --- the shadow attach ----------------------------------------------------
/**
 * Compile the Economic IR and attach it to the proof projection as a
 * NON-ENUMERABLE property. Non-enumerable is load-bearing: JSON.stringify
 * skips it, so the emitted model-ir-v3 sidecar and every hash taken over the
 * projection stay byte-identical to the pre-P3.1 tree.
 *
 * This function never throws: a shadow lane must not be able to fail a
 * delivery. A failed compile is recorded as `status: "unavailable"` with its
 * reason, visible in the transformation receipt and asserted against by
 * scripts/run_economic_ir_tests.mjs.
 */
export function attachShadowEconomicIr(target, inputs) {
  let record;
  try {
    const ir = compileEconomicIr({ ...inputs, modelIr: target });
    record = {
      schema_version: ECONOMIC_IR_SHADOW_SCHEMA_VERSION,
      mode: "shadow",
      gates_delivery: false,
      status: "sealed",
      economic_ir_sha256: ir.seal.content_sha256,
      economic_ir: ir,
      failure: null,
    };
  } catch (error) {
    record = {
      schema_version: ECONOMIC_IR_SHADOW_SCHEMA_VERSION,
      mode: "shadow",
      gates_delivery: false,
      status: "unavailable",
      economic_ir_sha256: null,
      economic_ir: null,
      failure: {
        name: error?.name ?? "Error",
        message: String(error?.message ?? error),
      },
    };
  }
  try {
    Object.defineProperty(target, ECONOMIC_IR_SHADOW_PROPERTY, {
      value: record,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    // A non-extensible projection simply carries no shadow; still never fatal.
  }
  return record;
}

/** The shadow record attached to a proof projection, or null. */
export function shadowEconomicIrOf(target) {
  return target?.[ECONOMIC_IR_SHADOW_PROPERTY] ?? null;
}

/**
 * The compact, receipt-shaped binding of the shadow IR: the seal a Phase-7
 * golden pins and the counts a Phase-9 parity harness compares, without
 * carrying the whole IR into the receipt.
 */
export function economicIrReceiptBinding(target) {
  const shadow = shadowEconomicIrOf(target);
  if (!shadow) {
    return {
      schema_version: ECONOMIC_IR_SCHEMA_VERSION,
      mode: "shadow",
      gates_delivery: false,
      status: "absent",
      sha256: null,
      node_count: null,
      typed_slot_count: null,
      schedule_period_count: null,
      typed_state_census: null,
      failure: null,
    };
  }
  const ir = shadow.economic_ir;
  return {
    schema_version: ECONOMIC_IR_SCHEMA_VERSION,
    mode: shadow.mode,
    gates_delivery: false,
    status: shadow.status,
    sha256: shadow.economic_ir_sha256,
    node_count: ir ? ir.nodes.length : null,
    typed_slot_count: ir ? ir.coverage.typed_slots : null,
    schedule_period_count: ir ? ir.schedules.length : null,
    typed_state_census: ir ? { ...ir.coverage.by_state } : null,
    failure: shadow.failure,
  };
}
