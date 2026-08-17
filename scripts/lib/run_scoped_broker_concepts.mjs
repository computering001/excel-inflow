import { createHash } from "node:crypto";

const METRIC_ID = /^run\.[a-z0-9][a-z0-9_.-]*$/;
const SECTIONS = new Set(["income_statement", "cash_flow"]);
const UNIT_KINDS = new Set(["currency", "ratio", "percent_decimal"]);
const SIGNS = new Set(["positive", "negative", "source_signed"]);
const BEHAVIORS = new Set([
  "independent_input",
  "driver",
  "carry_forward",
  "reference_only",
]);
const ACTIVE_BEHAVIORS = new Set(["independent_input", "driver"]);
const RELATIONS = new Set(["before", "after", "child_of"]);
const ROW_MODES = new Set(["existing_company_row", "new_company_specific_row"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function runScopedConceptHash(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest("hex");
}

export function validateRunScopedBrokerConcepts(concepts, { runId = null } = {}) {
  if (concepts === undefined || concepts === null) return { concepts: new Map(), errors: [] };
  if (!Array.isArray(concepts)) {
    return { concepts: new Map(), errors: ["run_scoped_concepts must be an array"] };
  }
  const indexed = new Map();
  const errors = [];
  for (const [index, concept] of concepts.entries()) {
    const at = `run_scoped_concepts[${index}]`;
    if (!concept || typeof concept !== "object" || Array.isArray(concept)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const metricId = concept.metric_id;
    if (!METRIC_ID.test(String(metricId ?? ""))) {
      errors.push(`${at}.metric_id must use the run.* namespace`);
      continue;
    }
    if (indexed.has(metricId)) errors.push(`${at} duplicates metric_id ${metricId}`);
    if (concept.schema_version !== "run-scoped-broker-concept/1.0") {
      errors.push(`${at} has the wrong schema_version`);
    }
    if (!concept.run_id || (runId !== null && concept.run_id !== runId)) {
      errors.push(`${at} belongs to another run`);
    }
    if (!SECTIONS.has(concept.section)) errors.push(`${at}.section is unsupported`);
    if (String(concept.definition ?? "").trim().length < 12) {
      errors.push(`${at}.definition is not specific enough`);
    }
    if (!UNIT_KINDS.has(concept.unit_kind)) errors.push(`${at}.unit_kind is unsupported`);
    if (!SIGNS.has(concept.sign_convention)) errors.push(`${at}.sign_convention is unsupported`);
    if (!String(concept.parent_row_id ?? "").trim()) errors.push(`${at}.parent_row_id is required`);
    if (
      !RELATIONS.has(concept.placement_anchor?.relation) ||
      !String(concept.placement_anchor?.row_id ?? "").trim()
    ) errors.push(`${at}.placement_anchor is invalid`);
    if (
      typeof concept.materiality?.is_material !== "boolean" ||
      !["headline_anchor", "revenue", "absolute_currency"].includes(concept.materiality?.basis) ||
      !Number.isFinite(concept.materiality?.threshold) ||
      !Number.isFinite(concept.materiality?.observed_value)
    ) errors.push(`${at}.materiality is incomplete`);
    if (!BEHAVIORS.has(concept.forecast_behavior)) {
      errors.push(`${at}.forecast_behavior is unsupported`);
    }
    if (typeof concept.additive !== "boolean") errors.push(`${at}.additive must be boolean`);
    if (
      concept.double_count_proof?.status !== "no_overlap" ||
      !Array.isArray(concept.double_count_proof?.compared_metric_ids) ||
      concept.double_count_proof.compared_metric_ids.length === 0 ||
      new Set(concept.double_count_proof.compared_metric_ids).size !==
        concept.double_count_proof.compared_metric_ids.length ||
      String(concept.double_count_proof?.rationale ?? "").trim().length < 12
    ) errors.push(`${at}.double_count_proof is incomplete`);
    if (
      !ROW_MODES.has(concept.row_relation?.mode) ||
      !String(concept.row_relation?.row_id ?? "").trim()
    ) errors.push(`${at}.row_relation is invalid`);
    if (
      concept.row_relation?.mode === "new_company_specific_row" &&
      (concept.additive !== false || concept.forecast_behavior !== "reference_only")
    ) errors.push(`${at} may create a new company row only as non-additive reference evidence`);
    if (concept.review_status !== "reviewed") errors.push(`${at}.review_status must be reviewed`);
    const body = Object.fromEntries(
      Object.entries(concept).filter(([key]) => key !== "contract_sha256"),
    );
    if (concept.contract_sha256 !== runScopedConceptHash(body)) {
      errors.push(`${at}.contract_sha256 is stale`);
    }
    indexed.set(metricId, concept);
  }
  return { concepts: indexed, errors };
}

export function applyRunScopedBrokerConcepts(modelCase, report) {
  const contracts = modelCase.broker_pack?.run_scoped_concepts;
  const { concepts, errors } = validateRunScopedBrokerConcepts(contracts);
  for (const message of errors) {
    report.add(
      "broker.run_scoped_contract",
      "BLOCK",
      message,
      "Repair or remove the run-scoped contract; an invalid contract cannot become model authority.",
    );
  }
  if (errors.length) return;
  const allRows = () => [
    ...(modelCase.statement_structure?.income_statement ?? []),
    ...(modelCase.statement_structure?.cash_flow ?? []),
  ];
  for (const [metricId, contract] of concepts) {
    const metric = modelCase.broker_pack?.metrics?.[metricId];
    const rows = modelCase.statement_structure?.[contract.section] ?? [];
    const rowId = contract.row_relation.row_id;
    const parent = rows.find((row) => row.row_id === contract.parent_row_id);
    const anchor = rows.find((row) => row.row_id === contract.placement_anchor.row_id);
    const block = (message, remedy) => report.add(
      "broker.run_scoped_insertion",
      "BLOCK",
      `${metricId}: ${message}`,
      remedy,
      { metric_id: metricId, section: contract.section, row_id: rowId },
    );
    if (!metric) {
      block("the contract has no matching broker metric declaration.", "Declare the exact run.* metric in the sealed broker pack or remove the contract.");
      continue;
    }
    if (metric.unit_kind !== contract.unit_kind) {
      block("the metric unit disagrees with the insertion contract.", "Use one reviewed unit convention in the metric and contract.");
      continue;
    }
    if (!parent || !anchor) {
      block("the parent or placement anchor is absent from the compiled company statement.", "Bind the contract to existing row ids in the declared section.");
      continue;
    }
    if (contract.placement_anchor.relation === "child_of" && anchor.row_id !== parent.row_id) {
      block("a child_of anchor must name the declared parent row.", "Make placement_anchor.row_id equal parent_row_id.");
      continue;
    }
    if (contract.row_relation.mode === "existing_company_row") {
      if (!contract.materiality.is_material || !ACTIVE_BEHAVIORS.has(contract.forecast_behavior)) {
        block("an existing-row authority must be material and use independent_input or driver behavior.", "Keep the concept as reference evidence, or supply a reviewed material active contract.");
        continue;
      }
      const target = rows.find((row) => row.row_id === rowId);
      if (!target || target.row_type === "header") {
        block("the declared existing company row is absent or non-economic.", "Bind the metric to an existing non-header company row.");
        continue;
      }
      if (target.broker_metric_id && target.broker_metric_id !== metricId) {
        block(`row ${rowId} already consumes ${target.broker_metric_id}.`, "Use one broker authority per company row.");
        continue;
      }
      target.broker_metric_id = metricId;
      if (["calculation", "subtotal"].includes(target.row_type)) target.forecast_treatment = "broker";
      continue;
    }
    // A broker contract may introduce a visible run-local reference line, but
    // it may not mint historical company economics. A genuinely new additive
    // company row must first be established by the filings/statement-expansion
    // lane; it then uses existing_company_row above. This keeps broker evidence
    // from becoming a back door around filings authority.
    if (contract.additive || contract.forecast_behavior !== "reference_only") {
      block("a new company-specific row may be inserted only as non-additive reference evidence.", "Establish additive company economics through the filings lane, then bind this contract to that existing row.");
      continue;
    }
    if (allRows().some((row) => row.row_id === rowId)) {
      block(`row_id ${rowId} already exists.`, "Choose a unique run-scoped company row id.");
      continue;
    }
    const newRow = {
      row_id: rowId,
      label: `${metric.label} (broker reference)`,
      row_type: "uncalculated",
      values: [null, null, null, null, null, null],
      historical_authority: "not_applicable",
      forecast_treatment: "uncalculated",
      parent_row_id: parent.row_id,
      aggregation_role: "working_child",
      indent: Math.min(3, Number(parent.indent ?? 0) + 1),
      number_format: contract.unit_kind === "currency" ? "amount" : "percentage",
      style_role: "body",
    };
    const anchorIndex = rows.indexOf(anchor);
    const insertAt = contract.placement_anchor.relation === "before"
      ? anchorIndex
      : anchorIndex + 1;
    rows.splice(insertAt, 0, newRow);
  }
}
