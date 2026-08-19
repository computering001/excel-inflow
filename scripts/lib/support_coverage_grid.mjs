/**
 * P7.1a — Support-envelope coverage grid compiler (v3.7.7).
 *
 * Invariant: every value the support envelope CLAIMS is joined to the
 * evidence proving it, tier-labelled; a claimed value with no proving
 * evidence is reported as a typed coverage gap.
 *
 * REPORT MODE ONLY. This module reads assets/support-envelope-v377.json and
 * never writes it, never narrows it, never changes classification and is
 * consumed by no run. Its single output is a joinable measurement artifact,
 * assets/support-coverage-grid-v1.json. The narrowing decision belongs to the
 * user and is taken outside this file.
 *
 * TWO EVIDENCE TIERS, and only two:
 *
 *   extraction_evidence   a REAL filing is required, because the claim
 *                         concerns reading messy source documents (scanned
 *                         PDFs, inline XBRL, unit labels, layout). Such
 *                         evidence lives in CUSTODY and is referenced by
 *                         hash/id ONLY. No custody byte is copied into the
 *                         repository and no custody path is recorded here.
 *
 *   model_shape_evidence  a SYNTHETIC in-repo case suffices, because the
 *                         claim concerns economics, period arithmetic, or a
 *                         pre-extraction refusal decided from intake facts
 *                         alone (no document is opened to decide it).
 *
 * PORTABILITY CONTRACT: the compiled grid is byte-identical with and without
 * a custody root. Custody families are enumerated BY MANIFEST ONLY (the
 * in-repo, redacted, hash-bound register under
 * test-fixtures/real-filings-custody-v1/). A custody root supplied via
 * --custody-root or EXCEL_INFLOW_CUSTODY_ROOT drives a separate runtime probe
 * whose absence is typed CUSTODY_ROOT_ABSENT_NOT_A_FAILURE and which never
 * touches a row status. Absence is absence: never a failure, never a proof.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

export const GRID_SCHEMA_VERSION = "excel-inflow-support-coverage-grid/1.0";
export const GRID_RELATIVE_PATH = "assets/support-coverage-grid-v1.json";
export const GRID_SCHEMA_RELATIVE_PATH = "assets/support-coverage-grid-v1.schema.json";
export const ENVELOPE_RELATIVE_PATH = "assets/support-envelope-v377.json";

const FIXTURE_CASES_DIR = "test-fixtures/cases";
const BLOCKER_MANIFEST = "test-corpus/blockers/corpus_manifest.json";
const CUSTODY_INVENTORY = "test-fixtures/real-filings-custody-v1/candidate-inventory.json";
const CUSTODY_RECEIPT = "test-fixtures/real-filings-custody-v1/corpus-classification-receipt.json";
const CUSTODY_OUTCOMES = "test-fixtures/real-filings-custody-v1/corpus-extraction-outcomes.json";

export const EXTRACTION = "extraction_evidence";
export const MODEL_SHAPE = "model_shape_evidence";

export const TIER_DEFINITIONS = {
  [EXTRACTION]:
    "A real filing is required: the claim concerns reading messy source documents (scanned PDFs, inline XBRL, unit labels, layout, caption vocabulary). This evidence lives in CUSTODY and is referenced by hash/id only — never copied into the repository.",
  [MODEL_SHAPE]:
    "A synthetic in-repo case suffices: the claim concerns economics, period arithmetic, or a pre-extraction refusal decided from intake facts alone. No document is opened to decide it.",
};

export const GAP_REASON_VOCABULARY = {
  no_real_filing_available:
    "The extraction tier is unmet: the custody register carries a classification axis for this dimension but no attested candidate exhibits this value. Closing it needs a new real filing classified into the existing axis.",
  custody_register_lacks_dimension_axis:
    "The extraction tier is unmet because the custody register has NO classification axis for this envelope dimension at all. No candidate can be joined until the register is extended — a classification-work gap, not merely a filing-supply gap.",
  no_synthetic_case_authored:
    "The model-shape tier is unmet: no in-repo synthetic case exhibits this value, though one could be authored without any new filing.",
  archetype_absent_from_corpus:
    "Both required tiers are unmet: the archetype is absent from every available source. Closing it needs a new real filing AND a new synthetic recipe.",
};

/**
 * TIER CLASSIFICATION TABLE — every declared envelope value, classified into
 * the tier it genuinely needs, with a one-line justification. Totality over
 * the envelope is a hard gate: a declared value absent from this table makes
 * the compiler throw, so the classification can never be silently partial.
 *
 * Keys are "<dimension>/<value>". Values whose risk is genuinely BOTH the
 * reading of a real document AND the economics record both tiers; the row
 * then reports which tier is missing.
 */
export const TIER_TABLE = {
  // ---- accounting_framework: framework identity is a reading problem. ----
  "accounting_framework/ifrs": {
    required_tiers: [EXTRACTION],
    justification:
      "IFRS identity is read off a real filing's captions and note structure; no synthetic case in this repository declares a framework at all.",
  },
  "accounting_framework/us_gaap": {
    required_tiers: [EXTRACTION],
    justification:
      "US GAAP identity is read off a real 10-K's caption vocabulary and layout; a synthetic case asserts no framework.",
  },
  "accounting_framework/local_gaap_english": {
    required_tiers: [EXTRACTION],
    justification:
      "Local-GAAP caption vocabulary exists only inside a real local filing; it cannot be synthesised faithfully.",
  },
  "accounting_framework/other_or_unknown": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "A declared refusal decided from the intake framework fact alone, before any document byte is read; a synthetic intake case proves it.",
  },

  // ---- entity_type: supported archetypes need both; refusals need neither filing. ----
  "entity_type/non_financial_corporate": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "The archetype must be recognised from a real filing's own statements (extraction) and compiled by the standard three-statement economics (model shape).",
  },
  "entity_type/utility": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "Regulated-utility captions (rate base, regulatory assets and liabilities) only appear in a real utility filing, and the regulated economics must also compile.",
  },
  "entity_type/reit": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "REIT presentation (FFO reconciliations, investment-property revaluation) is a real-filing reading problem, and the property economics are a distinct model shape.",
  },
  "entity_type/holding_company": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "A holdco perimeter and its minority interests must be read from a real filing, and the disclosed lower authority behind the SUPPORTED_DEGRADED promise must be modelled.",
  },
  "entity_type/mixed_group_predominantly_non_financial": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "A captive-finance segment must be recognised in a real filing, and its consolidation into an industrial group is separate period arithmetic.",
  },
  "entity_type/bank": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "A declared early stop decided from the intake entity_type alone; the envelope promises the run stops before any byte is read, so no filing is needed to prove it.",
  },
  "entity_type/insurer": {
    required_tiers: [MODEL_SHAPE],
    justification: "Declared early stop from the intake entity_type alone; no document is opened.",
  },
  "entity_type/fund": {
    required_tiers: [MODEL_SHAPE],
    justification: "Declared early stop from the intake entity_type alone; no document is opened.",
  },
  "entity_type/financial_spv": {
    required_tiers: [MODEL_SHAPE],
    justification: "Declared early stop from the intake entity_type alone; no document is opened.",
  },
  "entity_type/investment_company": {
    required_tiers: [MODEL_SHAPE],
    justification: "Declared early stop from the intake entity_type alone; no document is opened.",
  },

  // ---- filing_language_format: the document IS the claim. ----
  "filing_language_format/english_text_pdf": {
    required_tiers: [EXTRACTION],
    justification:
      "Column layout, unit labels and page furniture are properties of real PDF bytes; a synthetic case has no document.",
  },
  "filing_language_format/structured_inline_xbrl": {
    required_tiers: [EXTRACTION],
    justification:
      "Inline-XBRL fact and context structure exists only in real filing markup; it cannot be synthesised as a case.",
  },
  "filing_language_format/english_scanned_ocr": {
    required_tiers: [EXTRACTION],
    justification:
      "OCR noise, rasterisation and recovered-text error modes only occur on real scanned bytes.",
  },
  "filing_language_format/non_english": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "Declared early stop from the intake language fact plus the absence of a declared adapter; decided before extraction.",
  },

  // ---- historical_periods: comparatives are read, then arithmetic. ----
  "historical_periods/three_or_more": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "Three comparative columns must be read off real face statements (extraction) and they drive the model's period arithmetic (model shape).",
  },
  "historical_periods/two_with_prior_filing_support": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "Stitching a prior filing needs two real documents and their overlap reconciled (extraction), and the degraded two-period arithmetic must compile (model shape).",
  },
  "historical_periods/fewer_than_two": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "Declared early stop from the intake period count alone; a synthetic intake case proves the refusal.",
  },

  // ---- statement_topology ----
  "statement_topology/standard_three_statement": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "The three face statements must be located in a real filing (extraction) and the linked three-statement model must compile (model shape).",
  },
  "statement_topology/condensed_or_interim": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "Condensed interim layouts differ only in the source document (extraction), and interim-to-annual period stitching is distinct arithmetic (model shape).",
  },
  "statement_topology/cash_flow_absent": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "Declared early stop from the intake topology fact alone; the run must stop before extraction, so no filing proves it.",
  },

  // ---- cash_flow_method ----
  "cash_flow_method/indirect": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "An indirect-method statement must be recognised in a real filing (extraction), and the addback and working-capital roll is economics (model shape).",
  },
  "cash_flow_method/direct": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "A direct-method receipts-and-payments layout only exists in a real filing (extraction), and its conversion into the model's indirect roll is arithmetic (model shape).",
  },

  // ---- fiscal_calendar ----
  "fiscal_calendar/fixed_date": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "A fixed year-end is pure period arithmetic; the date carries no document-reading risk beyond the date itself.",
  },
  "fiscal_calendar/week_52_53": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "52/53-week period labels and their shifting year-ends must be read off a real retailer filing (extraction), and the 53-week period arithmetic must compile (model shape).",
  },

  // ---- debt_instruments: mechanics are economics; exotics are disclosure reading. ----
  "debt_instruments/within_declared_matrix": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "Instrument mechanics are economics; the declared matrix is exercised end to end by synthetic instrument recipes.",
  },
  "debt_instruments/convertible_or_hybrid": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "Hybrid and convertible terms live in real note disclosures (extraction), and the conversion, PIK and split-accounting arithmetic is economics (model shape).",
  },
  "debt_instruments/exotic_or_structured": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "A structure outside the declared matrix is discovered by reading real notes (extraction) before any bespoke arithmetic can be modelled (model shape).",
  },
  "debt_instruments/none_disclosed": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "A no-debt balance sheet is a synthetic shape; the SUPPORTED_DEGRADED promise concerns the model's behaviour, not a document.",
  },

  // ---- broker_availability ----
  "broker_availability/broker_pack_present": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "The broker overlay is economics over supplied consensus figures; licensed research is never held in the repository, so a synthetic pack is the correct and only lawful proof.",
  },
  "broker_availability/broker_pack_absent": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "The absent-pack path is a synthetic shape: the model must degrade to filing-only authorities with the degradation disclosed.",
  },

  // ---- acquisition_overlay: terms are user-declared, not extracted. ----
  "acquisition_overlay/none": {
    required_tiers: [MODEL_SHAPE],
    justification: "The no-overlay path is a synthetic shape; nothing is read to establish it.",
  },
  "acquisition_overlay/single_declared_acquisition": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "Deal terms arrive as declared intake facts, not extracted text; the overlay is funding and consolidation arithmetic.",
  },
  "acquisition_overlay/multi_step_or_contingent": {
    required_tiers: [MODEL_SHAPE],
    justification:
      "Multi-step and contingent consideration remain user-declared terms; the risk is the staged arithmetic, not the reading.",
  },

  // ---- restructuring_complexity ----
  "restructuring_complexity/none": {
    required_tiers: [MODEL_SHAPE],
    justification: "The no-restructuring path is a synthetic shape.",
  },
  "restructuring_complexity/discontinued_operations_disclosed": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "Discontinued-operations re-presentation of comparatives only exists in a real filing (extraction), and the continuing/discontinued split is distinct arithmetic (model shape).",
  },
  "restructuring_complexity/major_perimeter_change": {
    required_tiers: [EXTRACTION, MODEL_SHAPE],
    justification:
      "Restated comparatives after a perimeter change exist only in real filings (extraction), and the perimeter arithmetic must compile (model shape).",
  },
};

/**
 * The ten declared debt-instrument classes are a claim set of their own: the
 * envelope promises that debt_instruments/within_declared_matrix is CERTIFIED
 * because THESE classes are handled. Each is economics, so each needs a
 * synthetic instrument recipe.
 */
export const DECLARED_MATRIX_DIMENSION = "debt_instruments.declared_matrix";
const DECLARED_MATRIX_JUSTIFICATION =
  "One member of the envelope's declared instrument matrix: its roll-forward, interest and inclusion mechanics are economics, proven by a synthetic instrument recipe rather than by any document.";

/**
 * Envelope claims that are declared but are NOT joinable to a corpus case,
 * recorded explicitly so their exclusion is visible rather than silent.
 */
export const EXCLUDED_CLAIM_KINDS = [
  {
    claim_kind: "unknown_value_class",
    reason:
      "A per-dimension fallback class for an UNSTATED value, not an enumerated value a case can exhibit. Pinned by the classifier suite (scripts/run_support_envelope_tests.mjs), not joinable to corpus evidence.",
  },
  {
    claim_kind: "early_stop_predicates",
    reason:
      "Rule text over intake facts, with its own positive and negative examples inside the envelope. Its verdicts are pinned by the classifier and preflight suites; the refusal VALUES it consumes are carried as rows here.",
  },
];

// ---------------------------------------------------------------------------
// Structural probes over in-repo synthetic cases (model_shape_evidence).
// Each probe is a named, auditable predicate over the case JSON. A probe that
// does not fire yields no evidence — never a default proof.
// ---------------------------------------------------------------------------

function historicalPeriodCount(kase) {
  return (kase.periods ?? []).filter((period) => period.status === "historical").length;
}

function instrumentClasses(kase) {
  const classes = new Set();
  for (const instrument of kase.instruments ?? []) {
    if (typeof instrument.class === "string") classes.add(instrument.class);
  }
  if (kase.rcf_policy) classes.add("rcf");
  if (kase.lease_policy) classes.add("lease_liability");
  return classes;
}

function cashFlowRows(kase) {
  return kase.statement_structure?.cash_flow ?? [];
}

function caseText(kase) {
  return JSON.stringify(kase);
}

export const FIXTURE_PROBES = [
  {
    id: "declared_intake_framework_other_or_unknown",
    dimension: "accounting_framework",
    value: "other_or_unknown",
    test: (kase) => kase.accounting_framework === "other_or_unknown",
  },
  {
    id: "corporate_three_statement_shape",
    dimension: "entity_type",
    value: "non_financial_corporate",
    test: (kase) =>
      Boolean(kase.operating_metrics) &&
      (kase.statement_structure?.income_statement ?? []).length > 0 &&
      cashFlowRows(kase).length > 0,
  },
  {
    id: "declared_intake_entity_type_utility",
    dimension: "entity_type",
    value: "utility",
    test: (kase) => kase.entity_type === "utility",
  },
  {
    id: "declared_intake_entity_type_reit",
    dimension: "entity_type",
    value: "reit",
    test: (kase) => kase.entity_type === "reit",
  },
  {
    id: "declared_intake_entity_type_holding_company",
    dimension: "entity_type",
    value: "holding_company",
    test: (kase) => kase.entity_type === "holding_company",
  },
  {
    id: "declared_intake_entity_type_mixed_group",
    dimension: "entity_type",
    value: "mixed_group_predominantly_non_financial",
    test: (kase) => kase.entity_type === "mixed_group_predominantly_non_financial",
  },
  {
    id: "declared_intake_entity_type_bank",
    dimension: "entity_type",
    value: "bank",
    test: (kase) => kase.entity_type === "bank",
  },
  {
    id: "declared_intake_entity_type_insurer",
    dimension: "entity_type",
    value: "insurer",
    test: (kase) => kase.entity_type === "insurer",
  },
  {
    id: "declared_intake_entity_type_fund",
    dimension: "entity_type",
    value: "fund",
    test: (kase) => kase.entity_type === "fund",
  },
  {
    id: "declared_intake_entity_type_financial_spv",
    dimension: "entity_type",
    value: "financial_spv",
    test: (kase) => kase.entity_type === "financial_spv",
  },
  {
    id: "declared_intake_entity_type_investment_company",
    dimension: "entity_type",
    value: "investment_company",
    test: (kase) => kase.entity_type === "investment_company",
  },
  {
    id: "declared_intake_language_non_english",
    dimension: "filing_language_format",
    value: "non_english",
    test: (kase) => kase.filing_language_format === "non_english",
  },
  {
    id: "three_or_more_historical_periods",
    dimension: "historical_periods",
    value: "three_or_more",
    test: (kase) => historicalPeriodCount(kase) >= 3,
  },
  {
    id: "two_periods_with_prior_filing_supplement",
    dimension: "historical_periods",
    value: "two_with_prior_filing_support",
    test: (kase) => historicalPeriodCount(kase) === 2 && Boolean(kase.historical_supplement),
  },
  {
    id: "fewer_than_two_historical_periods",
    dimension: "historical_periods",
    value: "fewer_than_two",
    test: (kase) => historicalPeriodCount(kase) < 2,
  },
  {
    id: "income_statement_and_cash_flow_present",
    dimension: "statement_topology",
    value: "standard_three_statement",
    test: (kase) =>
      (kase.statement_structure?.income_statement ?? []).length > 0 && cashFlowRows(kase).length > 0,
  },
  {
    id: "declared_interim_or_condensed_topology",
    dimension: "statement_topology",
    value: "condensed_or_interim",
    test: (kase) =>
      kase.reporting_period === "interim" ||
      kase.statement_topology === "condensed_or_interim" ||
      (kase.periods ?? []).some((period) => period.status === "interim"),
  },
  {
    id: "cash_flow_structure_absent",
    dimension: "statement_topology",
    value: "cash_flow_absent",
    test: (kase) => cashFlowRows(kase).length === 0,
  },
  {
    id: "indirect_cash_flow_starts_from_profit",
    dimension: "cash_flow_method",
    value: "indirect",
    test: (kase) =>
      cashFlowRows(kase).some((row) => row.semantic_role === "cash_flow_net_income") &&
      cashFlowRows(kase).some((row) => /tax_addback|depreciation|working_capital/.test(row.row_id ?? "")),
  },
  {
    id: "direct_cash_flow_receipts_and_payments",
    dimension: "cash_flow_method",
    value: "direct",
    test: (kase) =>
      cashFlowRows(kase).some((row) =>
        /receipts_from_customers|cash_received_from_customers|payments_to_suppliers/.test(
          `${row.row_id ?? ""}${row.semantic_role ?? ""}`,
        ),
      ),
  },
  {
    id: "fixed_date_fiscal_year_end",
    dimension: "fiscal_calendar",
    value: "fixed_date",
    test: (kase) => /^\d{2}-\d{2}$/.test(kase.issuer?.fiscal_year_end ?? ""),
  },
  {
    id: "week_52_53_fiscal_calendar",
    dimension: "fiscal_calendar",
    value: "week_52_53",
    test: (kase) =>
      kase.issuer?.fiscal_calendar === "week_52_53" ||
      /week|saturday|sunday/i.test(kase.issuer?.fiscal_year_end ?? ""),
  },
  {
    id: "all_instruments_within_declared_matrix",
    dimension: "debt_instruments",
    value: "within_declared_matrix",
    // Bound at build time against the envelope's own declared_matrix list.
    needsMatrix: true,
    test: (kase, matrix) => {
      const classes = instrumentClasses(kase);
      return classes.size > 0 && [...classes].every((klass) => matrix.includes(klass));
    },
  },
  {
    id: "convertible_or_hybrid_instrument_present",
    dimension: "debt_instruments",
    value: "convertible_or_hybrid",
    test: (kase) =>
      (kase.instruments ?? []).some((instrument) =>
        /convertible|hybrid|exchangeable|pik/i.test(`${instrument.class ?? ""}${instrument.name ?? ""}`),
      ),
  },
  {
    id: "instrument_outside_declared_matrix_present",
    dimension: "debt_instruments",
    value: "exotic_or_structured",
    needsMatrix: true,
    test: (kase, matrix) => [...instrumentClasses(kase)].some((klass) => !matrix.includes(klass)),
  },
  {
    id: "no_debt_disclosed",
    dimension: "debt_instruments",
    value: "none_disclosed",
    test: (kase) => instrumentClasses(kase).size === 0,
  },
  {
    id: "broker_pack_with_metrics_present",
    dimension: "broker_availability",
    value: "broker_pack_present",
    test: (kase) => Object.keys(kase.broker_pack?.metrics ?? {}).length > 0,
  },
  {
    id: "broker_pack_absent",
    dimension: "broker_availability",
    value: "broker_pack_absent",
    test: (kase) => !kase.broker_pack,
  },
  {
    id: "acquisition_overlay_disabled",
    dimension: "acquisition_overlay",
    value: "none",
    test: (kase) => !kase.acquisition || !kase.acquisition.enabled,
  },
  {
    id: "single_declared_acquisition_enabled",
    dimension: "acquisition_overlay",
    value: "single_declared_acquisition",
    test: (kase) =>
      Boolean(kase.acquisition?.enabled) &&
      !Array.isArray(kase.acquisition?.steps) &&
      kase.acquisition?.close_year != null,
  },
  {
    id: "multi_step_or_contingent_acquisition",
    dimension: "acquisition_overlay",
    value: "multi_step_or_contingent",
    test: (kase) =>
      (Array.isArray(kase.acquisition?.steps) && kase.acquisition.steps.length > 1) ||
      Boolean(kase.acquisition?.contingent_consideration),
  },
  {
    id: "no_restructuring_markers",
    dimension: "restructuring_complexity",
    value: "none",
    test: (kase) => !/discontinued|perimeter|restated/i.test(caseText(kase)),
  },
  {
    id: "discontinued_operations_marker_present",
    dimension: "restructuring_complexity",
    value: "discontinued_operations_disclosed",
    test: (kase) => /discontinued/i.test(caseText(kase)),
  },
  {
    id: "major_perimeter_change_marker_present",
    dimension: "restructuring_complexity",
    value: "major_perimeter_change",
    test: (kase) => /perimeter|restated_comparatives/i.test(caseText(kase)),
  },
];

// ---------------------------------------------------------------------------
// Structural probes over the blocker corpus manifest (typed fields only).
// ---------------------------------------------------------------------------

function blockerHasCustodyFixture(kase) {
  return (kase.fixtures ?? []).some((fixture) => fixture.location === "custody");
}

export function blockerCaseTier(kase) {
  // A blocker case carries EXTRACTION evidence only when raw filing bytes are
  // held in custody. A sealed derived case or a synthetic reproducer is model
  // shape, however real the issuer behind it once was.
  return blockerHasCustodyFixture(kase) ? EXTRACTION : MODEL_SHAPE;
}

export const BLOCKER_PROBES = [
  {
    id: "blocker_accounting_basis_ifrs",
    dimension: "accounting_framework",
    value: "ifrs",
    test: (kase) => kase.accounting_basis === "IFRS",
  },
  {
    id: "blocker_accounting_basis_us_gaap",
    dimension: "accounting_framework",
    value: "us_gaap",
    test: (kase) => kase.accounting_basis === "US_GAAP",
  },
  {
    id: "blocker_custody_pdf_fixture",
    dimension: "filing_language_format",
    value: "english_text_pdf",
    test: (kase) =>
      (kase.fixtures ?? []).some(
        (fixture) => fixture.location === "custody" && /\.pdf$/i.test(fixture.path ?? ""),
      ),
  },
];

// ---------------------------------------------------------------------------
// Custody register joins. Enumerated BY MANIFEST ONLY and referenced by
// hash/id. Two computed forms plus one declared form:
//   attested_category      — the register itself attests the category
//                            HASH_BOUND_VERIFIED for named candidate ids.
//   attested_qualification — a boolean qualification on a candidate.
//   structural             — a media metric on a classified document.
// ---------------------------------------------------------------------------

export const CUSTODY_CATEGORY_CROSSWALK = [
  {
    id: "custody_category_accounting_framework_ifrs",
    category: "accounting_framework.ifrs",
    dimension: "accounting_framework",
    value: "ifrs",
    justification:
      "The register's own accounting_framework axis attests an IFRS candidate; the envelope's ifrs value is the same claim about the same framework.",
  },
  {
    id: "custody_category_accounting_framework_us_gaap",
    category: "accounting_framework.us_gaap",
    dimension: "accounting_framework",
    value: "us_gaap",
    justification:
      "The register's accounting_framework axis attests a US GAAP candidate; the envelope's us_gaap value is the same claim.",
  },
  {
    id: "custody_category_native_pdf",
    category: "document_format.native_pdf",
    dimension: "filing_language_format",
    value: "english_text_pdf",
    justification:
      "A native-text PDF in the register is exactly the envelope's english_text_pdf format; the register's eligibility contract admits English-language local or official public filings only.",
  },
  {
    id: "custody_category_scanned_pdf",
    category: "document_format.scanned_pdf",
    dimension: "filing_language_format",
    value: "english_scanned_ocr",
    justification:
      "A scanned PDF can only be read through OCR, which is precisely the envelope's english_scanned_ocr format.",
  },
  {
    id: "custody_category_interim_reporting_period",
    category: "reporting_period.interim",
    dimension: "statement_topology",
    value: "condensed_or_interim",
    justification:
      "An interim report in the register carries the condensed interim statement topology the envelope names; the join is from reporting period to the topology that period implies.",
  },
  {
    id: "custody_category_multi_page_cash_flow",
    category: "statement_structure.multi_page_cash_flow",
    dimension: "statement_topology",
    value: "standard_three_statement",
    justification:
      "A multi-page cash-flow statement located in a real annual filing evidences the full three-statement topology: the cash-flow face statement is present and was found across pages.",
  },
];

export const CUSTODY_QUALIFICATION_PROBES = [
  {
    id: "custody_qualification_three_period_face_statements",
    field: "three_period_face_statements_selected",
    dimension: "historical_periods",
    value: "three_or_more",
    justification:
      "The candidate's own attested qualification records that three periods of face statements were selected from the real document — the envelope's three_or_more claim, read off a real filing.",
  },
];

export const CUSTODY_DOCUMENT_PROBES = [
  {
    id: "custody_document_inline_xbrl_markers",
    dimension: "filing_language_format",
    value: "structured_inline_xbrl",
    justification:
      "Inline-XBRL markers counted in the document's own media metrics are direct structural evidence of the envelope's structured_inline_xbrl format.",
    test: (document) => (document.media_metrics?.inline_xbrl_markers ?? 0) > 0,
  },
  {
    id: "custody_document_fully_rasterised_pages",
    dimension: "filing_language_format",
    value: "english_scanned_ocr",
    justification:
      "A full-page raster fraction at or above 0.9 means the pages carry no native text layer, so the document can only be read by OCR.",
    test: (document) => (document.media_metrics?.full_page_raster_fraction_ppm ?? 0) >= 900_000,
  },
  {
    id: "custody_document_native_text_pdf",
    dimension: "filing_language_format",
    value: "english_text_pdf",
    justification:
      "A PDF with a low raster fraction and a substantial median native-text character count per page is a text PDF read without OCR.",
    test: (document) =>
      document.media_kind === "pdf" &&
      (document.media_metrics?.full_page_raster_fraction_ppm ?? 1_000_000) < 500_000 &&
      (document.media_metrics?.median_native_text_characters_per_page ?? 0) >= 1_000,
  },
];

/**
 * The envelope dimensions the custody register can speak to AT ALL, derived
 * from the join mechanisms above rather than asserted. A dimension outside
 * this set cannot be joined to any real filing until the register itself gains
 * a classification axis for it — a classification-work gap, distinct from a
 * filing-supply gap, and the distinction the user needs when deciding.
 */
export function joinableEnvelopeDimensions() {
  return new Set([
    ...CUSTODY_CATEGORY_CROSSWALK.map((join) => join.dimension),
    ...CUSTODY_QUALIFICATION_PROBES.map((probe) => probe.dimension),
    ...CUSTODY_DOCUMENT_PROBES.map((probe) => probe.dimension),
  ]);
}

/**
 * CURATED MAPPINGS — the only joins that rest on human semantic judgement
 * rather than a computed predicate. Each names the manifest field it reads,
 * and where a token is cited the compiler asserts the field actually contains
 * it, so the curation is verified rather than merely asserted.
 */
export const CURATED_MAPPINGS = [
  {
    mapping_id: "curated.blocker_entity_is_non_financial_corporate",
    source: "blocker_corpus",
    source_ref: "apple-us-gaap-raw-canary",
    field: "privacy_classification",
    verified_token: "public filing",
    dimension: "entity_type",
    value: "non_financial_corporate",
    tier: EXTRACTION,
    justification:
      "This case's declared entity (corpus_manifest.json entity field) is a listed non-financial manufacturer and its custody-held annual report on Form 10-K is the extraction evidence; the manifest's privacy_classification confirms a public filing, not a derived case.",
  },
  {
    mapping_id: "curated.blocker_indirect_cash_flow_method",
    source: "blocker_corpus",
    source_ref: "working-capital-capture-blocker",
    field: "replay_assertion",
    verified_token: "change_in_working_capital",
    dimension: "cash_flow_method",
    value: "indirect",
    tier: EXTRACTION,
    justification:
      "The case's replay assertion is over change_in_working_capital addbacks read out of the custody-held filing's cash-flow statement — an indirect-method presentation, verified by the cited token being present in the manifest field.",
  },
];

// ---------------------------------------------------------------------------
// Evidence scanning.
// ---------------------------------------------------------------------------

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

export function loadEnvelopeForGrid(root = ROOT) {
  const bytes = fs.readFileSync(path.join(root, ENVELOPE_RELATIVE_PATH));
  const contract = JSON.parse(bytes.toString("utf8"));
  return { contract, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Every declared claim row the envelope makes, in declaration order. */
export function enumerateDeclaredValues(contract) {
  const rows = [];
  for (const [dimension, spec] of Object.entries(contract.dimensions)) {
    for (const [value, declaredClass] of Object.entries(spec.values)) {
      rows.push({ dimension, value, declared_class: declaredClass });
    }
  }
  for (const value of contract.dimensions.debt_instruments?.declared_matrix ?? []) {
    rows.push({
      dimension: DECLARED_MATRIX_DIMENSION,
      value,
      declared_class: "DECLARED_MATRIX_MEMBER",
    });
  }
  return rows;
}

export function scanRepoFixtures(root = ROOT, matrix = []) {
  const dir = path.join(root, FIXTURE_CASES_DIR);
  const files = fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const cases = [];
  for (const file of files) {
    const kase = readJson(root, `${FIXTURE_CASES_DIR}/${file}`);
    const caseId = kase.case_id;
    if (typeof caseId !== "string" || caseId.length === 0) {
      throw new Error(`SUPPORT_COVERAGE_GRID_FAIL: fixture ${file} declares no case_id`);
    }
    const facts = [];
    for (const probe of FIXTURE_PROBES) {
      const fired = probe.needsMatrix ? probe.test(kase, matrix) : probe.test(kase);
      if (fired) facts.push({ probe: probe.id, dimension: probe.dimension, value: probe.value });
    }
    // The declared instrument matrix is exercised class by class.
    for (const klass of [...instrumentClasses(kase)].sort()) {
      facts.push({
        probe: `instrument_class_present.${klass}`,
        dimension: DECLARED_MATRIX_DIMENSION,
        value: klass,
      });
    }
    cases.push({ case_id: caseId, source: "repo_fixture", tier: MODEL_SHAPE, facts });
  }
  return cases;
}

export function scanBlockerCorpus(root = ROOT) {
  const manifest = readJson(root, BLOCKER_MANIFEST);
  const cases = [];
  for (const kase of manifest.cases ?? []) {
    const facts = [];
    for (const probe of BLOCKER_PROBES) {
      if (probe.test(kase)) {
        facts.push({ probe: probe.id, dimension: probe.dimension, value: probe.value });
      }
    }
    cases.push({
      case_id: kase.case_id,
      source: "blocker_corpus",
      tier: blockerCaseTier(kase),
      raw: kase,
      facts,
    });
  }
  return cases;
}

/**
 * Custody families, enumerated BY MANIFEST ONLY. No custody path, host, URL or
 * issuer name enters the returned evidence — candidates are hash ids.
 */
export function scanCustodyRegister(root = ROOT) {
  const inventory = readJson(root, CUSTODY_INVENTORY);
  const receipt = readJson(root, CUSTODY_RECEIPT);
  const outcomes = readJson(root, CUSTODY_OUTCOMES);

  const attestedCategories = new Map();
  for (const [dimension, rows] of Object.entries(inventory.corpus_design_matrix?.dimensions ?? {})) {
    for (const row of rows) {
      if (row.status !== "HASH_BOUND_VERIFIED") continue;
      attestedCategories.set(`${dimension}.${row.category_id}`, row.candidate_ids ?? []);
    }
  }
  // The classification receipt is the second attesting witness; a category is
  // joinable only where both the inventory matrix and the receipt agree.
  const receiptCategories = new Map();
  for (const category of receipt.categories ?? []) {
    if (category.status !== "HASH_BOUND_VERIFIED") continue;
    receiptCategories.set(`${category.dimension}.${category.category_id}`, category.candidate_ids ?? []);
  }

  const extractionPassed = new Set(
    (outcomes.documents ?? [])
      .filter((document) => document.terminal_status === "EXTRACTION_PASS")
      .map((document) => document.candidate_id),
  );

  const evidence = [];

  for (const join of CUSTODY_CATEGORY_CROSSWALK) {
    const inventoryIds = attestedCategories.get(join.category);
    const receiptIds = receiptCategories.get(join.category);
    if (!inventoryIds || !receiptIds) continue;
    const agreed = inventoryIds.filter((id) => receiptIds.includes(id)).sort();
    for (const candidateId of agreed) {
      evidence.push({
        case_id: candidateId,
        source: "custody_family",
        tier: EXTRACTION,
        probe: join.id,
        probe_kind: "attested_category",
        attestation: join.category,
        dimension: join.dimension,
        value: join.value,
      });
    }
  }

  for (const probe of CUSTODY_QUALIFICATION_PROBES) {
    for (const candidate of inventory.candidates ?? []) {
      if (candidate.qualifications?.[probe.field] !== true) continue;
      evidence.push({
        case_id: candidate.candidate_id,
        source: "custody_family",
        tier: EXTRACTION,
        probe: probe.id,
        probe_kind: "attested_qualification",
        attestation: probe.field,
        dimension: probe.dimension,
        value: probe.value,
      });
    }
  }

  for (const probe of CUSTODY_DOCUMENT_PROBES) {
    for (const document of receipt.documents ?? []) {
      if (!probe.test(document)) continue;
      // A document only carries extraction evidence once its own extraction
      // attempt actually passed; a blocked document proves nothing.
      if (!extractionPassed.has(document.candidate_id)) continue;
      evidence.push({
        case_id: document.candidate_id,
        source: "custody_family",
        tier: EXTRACTION,
        probe: probe.id,
        probe_kind: "structural",
        attestation: null,
        dimension: probe.dimension,
        value: probe.value,
      });
    }
  }

  const candidateIds = new Set([
    ...(inventory.candidates ?? []).map((candidate) => candidate.candidate_id),
    ...[...attestedCategories.values()].flat(),
    ...(receipt.documents ?? []).map((document) => document.candidate_id),
    ...(outcomes.documents ?? []).map((document) => document.candidate_id),
  ]);

  const joins = [
    ...CUSTODY_CATEGORY_CROSSWALK.filter(
      (join) => attestedCategories.has(join.category) && receiptCategories.has(join.category),
    ).map((join) => ({
      join_id: join.id,
      join_kind: "attested_category",
      register_reference: join.category,
      dimension: join.dimension,
      value: join.value,
      justification: join.justification,
    })),
    ...CUSTODY_QUALIFICATION_PROBES.map((probe) => ({
      join_id: probe.id,
      join_kind: "attested_qualification",
      register_reference: probe.field,
      dimension: probe.dimension,
      value: probe.value,
      justification: probe.justification,
    })),
    ...CUSTODY_DOCUMENT_PROBES.map((probe) => ({
      join_id: probe.id,
      join_kind: "structural_media_metric",
      register_reference: "corpus-classification-receipt.documents[].media_metrics",
      dimension: probe.dimension,
      value: probe.value,
      justification: probe.justification,
    })),
  ];

  return {
    evidence,
    joins,
    candidateIds,
    joinableDimensions: joinableEnvelopeDimensions(),
    documentCount: (receipt.documents ?? []).length,
    candidateCount: (inventory.candidates ?? []).length,
    attestedCategoryCount: attestedCategories.size,
  };
}

/**
 * The custody-root probe. Root presence is a RUNTIME fact reported alongside
 * the grid and never folded into it: absence is typed, not failed, and not
 * proven. No path is returned — the portability contract forbids absolute
 * paths in the artifact, so only the state is reported.
 */
export function probeCustodyRoot({ custodyRoot = null, env = process.env } = {}) {
  const declared = custodyRoot ?? env.EXCEL_INFLOW_CUSTODY_ROOT ?? null;
  if (!declared) {
    return {
      custody_root_declared: false,
      custody_root_state: "ABSENT",
      typed_reason: "CUSTODY_ROOT_ABSENT_NOT_A_FAILURE",
      note:
        "No custody root was declared. Custody evidence is joined from the in-repo hash-bound register alone; byte-level re-verification is unavailable in this checkout. This is absence, not failure and not proof.",
    };
  }
  const present = fs.existsSync(declared) && fs.statSync(declared).isDirectory();
  return {
    custody_root_declared: true,
    custody_root_state: present ? "PRESENT" : "ABSENT",
    typed_reason: present ? null : "CUSTODY_ROOT_ABSENT_NOT_A_FAILURE",
    note: present
      ? "A custody root was declared and resolves to a directory. Byte-level re-verification is possible out of band; the grid is unchanged, because custody families are enumerated by manifest only."
      : "A custody root was declared but does not resolve to a directory. Typed as absence: the grid is unchanged and no row is failed or proven by it.",
  };
}

// ---------------------------------------------------------------------------
// Grid compilation.
// ---------------------------------------------------------------------------

function primaryGapReason(missingTiers, byTier) {
  if (missingTiers.length === 0) return null;
  if (missingTiers.length === 2) return "archetype_absent_from_corpus";
  return byTier[missingTiers[0]];
}

export function buildSupportCoverageGrid({ root = ROOT } = {}) {
  const { contract, sha256 } = loadEnvelopeForGrid(root);
  const matrix = contract.dimensions.debt_instruments?.declared_matrix ?? [];
  const declared = enumerateDeclaredValues(contract);

  const fixtureCases = scanRepoFixtures(root, matrix);
  const blockerCases = scanBlockerCorpus(root);
  const custody = scanCustodyRegister(root);

  // Index evidence by "<dimension>/<value>".
  const byKey = new Map();
  const push = (key, entry) => {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  };

  for (const kase of fixtureCases) {
    for (const fact of kase.facts) {
      push(`${fact.dimension}/${fact.value}`, {
        case_id: kase.case_id,
        tier: kase.tier,
        source: kase.source,
        probe: fact.probe,
        probe_kind: "structural",
        attestation: null,
      });
    }
  }
  for (const kase of blockerCases) {
    for (const fact of kase.facts) {
      push(`${fact.dimension}/${fact.value}`, {
        case_id: kase.case_id,
        tier: kase.tier,
        source: kase.source,
        probe: fact.probe,
        probe_kind: "structural",
        attestation: null,
      });
    }
  }
  for (const entry of custody.evidence) {
    push(`${entry.dimension}/${entry.value}`, {
      case_id: entry.case_id,
      tier: entry.tier,
      source: entry.source,
      probe: entry.probe,
      probe_kind: entry.probe_kind,
      attestation: entry.attestation,
    });
  }

  // Curated mappings, each verified against the manifest field it cites.
  const blockerById = new Map(blockerCases.map((kase) => [kase.case_id, kase]));
  const fixtureById = new Map(fixtureCases.map((kase) => [kase.case_id, kase]));
  const curatedRecords = [];
  for (const mapping of CURATED_MAPPINGS) {
    let carrier = null;
    if (mapping.source === "blocker_corpus") carrier = blockerById.get(mapping.source_ref);
    else if (mapping.source === "repo_fixture") carrier = fixtureById.get(mapping.source_ref);
    else if (mapping.source === "custody_family" && custody.candidateIds.has(mapping.source_ref)) {
      carrier = { case_id: mapping.source_ref, tier: EXTRACTION, source: "custody_family" };
    }
    if (!carrier) {
      throw new Error(
        `SUPPORT_COVERAGE_GRID_FAIL: curated mapping ${mapping.mapping_id} cites unknown ${mapping.source} reference ${mapping.source_ref}`,
      );
    }
    if (mapping.verified_token) {
      const field = carrier.raw?.[mapping.field];
      if (typeof field !== "string" || !field.includes(mapping.verified_token)) {
        throw new Error(
          `SUPPORT_COVERAGE_GRID_FAIL: curated mapping ${mapping.mapping_id} cites token "${mapping.verified_token}" absent from ${mapping.source_ref}.${mapping.field}`,
        );
      }
    }
    if (carrier.tier !== mapping.tier) {
      throw new Error(
        `SUPPORT_COVERAGE_GRID_FAIL: curated mapping ${mapping.mapping_id} claims tier ${mapping.tier} but ${mapping.source_ref} carries ${carrier.tier} evidence`,
      );
    }
    push(`${mapping.dimension}/${mapping.value}`, {
      case_id: mapping.source_ref,
      tier: mapping.tier,
      source: mapping.source,
      probe: mapping.mapping_id,
      probe_kind: "curated_manifest_field",
      attestation: mapping.field,
    });
    curatedRecords.push({
      mapping_id: mapping.mapping_id,
      source: mapping.source,
      source_ref: mapping.source_ref,
      dimension: mapping.dimension,
      value: mapping.value,
      tier: mapping.tier,
      verified_token: mapping.verified_token ?? null,
      justification: mapping.justification,
    });
  }

  // Adjacent, non-case evidence: recorded so the gap is exact, never as proof.
  const CLASSIFIER_PINNED = new Set(
    declared
      .filter((row) => row.declared_class === "UNSUPPORTED")
      .map((row) => `${row.dimension}/${row.value}`),
  );

  const rows = [];
  for (const declaredRow of declared) {
    const key = `${declaredRow.dimension}/${declaredRow.value}`;
    const tierSpec =
      declaredRow.dimension === DECLARED_MATRIX_DIMENSION
        ? { required_tiers: [MODEL_SHAPE], justification: DECLARED_MATRIX_JUSTIFICATION }
        : TIER_TABLE[key];
    if (!tierSpec) {
      throw new Error(
        `SUPPORT_COVERAGE_GRID_FAIL: declared envelope value ${key} has no tier classification — the tier table must be TOTAL over the envelope`,
      );
    }
    const requiredTiers = [...tierSpec.required_tiers];
    const all = (byKey.get(key) ?? []).filter((entry) => requiredTiers.includes(entry.tier));
    all.sort(
      (left, right) =>
        left.tier.localeCompare(right.tier) ||
        left.source.localeCompare(right.source) ||
        left.case_id.localeCompare(right.case_id) ||
        left.probe.localeCompare(right.probe),
    );
    const satisfied = requiredTiers.filter((tier) => all.some((entry) => entry.tier === tier));
    const missing = requiredTiers.filter((tier) => !satisfied.includes(tier));
    const status =
      missing.length === 0 ? "proven" : satisfied.length > 0 ? "partially_proven" : "unproven";

    // Per-tier reasons stay tier-specific — collapsing them would hide the
    // decision-relevant difference between "the register cannot classify this
    // dimension at all" and "the register can, but no candidate covers it".
    const byTier = {};
    for (const tier of missing) {
      if (tier === EXTRACTION) {
        byTier[EXTRACTION] = custody.joinableDimensions.has(declaredRow.dimension)
          ? "no_real_filing_available"
          : "custody_register_lacks_dimension_axis";
      } else {
        byTier[MODEL_SHAPE] = "no_synthetic_case_authored";
      }
    }

    rows.push({
      dimension: declaredRow.dimension,
      value: declaredRow.value,
      declared_class: declaredRow.declared_class,
      required_tiers: requiredTiers,
      tier_justification: tierSpec.justification,
      proving_cases: all,
      satisfied_tiers: satisfied,
      missing_tiers: missing,
      status,
      gap_reason: primaryGapReason(missing, byTier),
      gap_reasons_by_tier: byTier,
      adjacent_non_case_evidence:
        status !== "proven" && CLASSIFIER_PINNED.has(key)
          ? "The classifier verdict for this value is pinned by scripts/run_support_envelope_tests.mjs, but no corpus case exercises the refusal end to end; a unit assertion is not a case and never counts as proof here."
          : null,
    });
  }

  const dimensionsDeclared = Object.keys(contract.dimensions).length;
  const unprovenByReason = {};
  const gappedByReason = {};
  const extractionGapsByReason = {};
  let modelShapeGaps = 0;
  for (const row of rows) {
    if (row.gap_reasons_by_tier[EXTRACTION]) {
      const reason = row.gap_reasons_by_tier[EXTRACTION];
      extractionGapsByReason[reason] = (extractionGapsByReason[reason] ?? 0) + 1;
    }
    if (row.gap_reasons_by_tier[MODEL_SHAPE]) modelShapeGaps += 1;
    if (row.gap_reason === null) continue;
    gappedByReason[row.gap_reason] = (gappedByReason[row.gap_reason] ?? 0) + 1;
    if (row.status === "unproven") {
      unprovenByReason[row.gap_reason] = (unprovenByReason[row.gap_reason] ?? 0) + 1;
    }
  }
  const dimensionsWithoutCustodyAxis = Object.keys(contract.dimensions)
    .filter((dimension) => !custody.joinableDimensions.has(dimension))
    .sort();

  const grid = {
    schema_version: GRID_SCHEMA_VERSION,
    work_package: "P7.1a",
    invariant:
      "Every value the support envelope CLAIMS is joined to the evidence proving it, tier-labelled; a claimed value with no proving evidence is reported as a typed coverage gap.",
    mode: "REPORT_ONLY",
    envelope_version: contract.envelope_version,
    envelope_sha256: sha256,
    tier_definitions: TIER_DEFINITIONS,
    gap_reason_vocabulary: GAP_REASON_VOCABULARY,
    evidence_sources: [
      {
        source: "repo_fixture",
        manifest: FIXTURE_CASES_DIR,
        tier: MODEL_SHAPE,
        case_count: fixtureCases.length,
        note: "Synthetic standardised cases held in the repository. They carry no issuer, filing or licensed research, so they can only ever prove model shape.",
      },
      {
        source: "blocker_corpus",
        manifest: BLOCKER_MANIFEST,
        tier: "mixed",
        case_count: blockerCases.length,
        note: "Known-blocker reproducers. A case carries extraction evidence only where raw filing bytes are held in custody; a sealed derived case or synthetic reproducer is model shape.",
      },
      {
        source: "custody_family",
        manifest: "test-fixtures/real-filings-custody-v1",
        tier: EXTRACTION,
        case_count: custody.documentCount + custody.candidateCount,
        note: "Real filings, enumerated by the in-repo redacted hash-bound register and referenced by candidate id only. No byte, path, host or issuer name is copied into this artifact or the repository.",
      },
    ],
    custody_absence_typing: {
      contract:
        "Custody families are enumerated BY MANIFEST ONLY, so this grid is byte-identical with and without a custody root. A declared-but-unresolvable root is reported by the runtime probe as CUSTODY_ROOT_ABSENT_NOT_A_FAILURE and changes no row.",
      typed_reason: "CUSTODY_ROOT_ABSENT_NOT_A_FAILURE",
      grid_effect: "none",
    },
    excluded_claim_kinds: EXCLUDED_CLAIM_KINDS,
    custody_joins: custody.joins,
    curated_mappings: curatedRecords,
    rows,
    totals: {
      dimensions_declared: dimensionsDeclared,
      values_declared: rows.length,
      proven: rows.filter((row) => row.status === "proven").length,
      partially_proven: rows.filter((row) => row.status === "partially_proven").length,
      unproven: rows.filter((row) => row.status === "unproven").length,
      proven_by_real_filing: rows.filter((row) =>
        row.proving_cases.some((entry) => entry.tier === EXTRACTION),
      ).length,
      proven_by_synthetic_case: rows.filter((row) =>
        row.proving_cases.some((entry) => entry.tier === MODEL_SHAPE),
      ).length,
      required_extraction_only: rows.filter(
        (row) => row.required_tiers.length === 1 && row.required_tiers[0] === EXTRACTION,
      ).length,
      required_model_shape_only: rows.filter(
        (row) => row.required_tiers.length === 1 && row.required_tiers[0] === MODEL_SHAPE,
      ).length,
      required_both_tiers: rows.filter((row) => row.required_tiers.length === 2).length,
      unproven_by_gap_reason: unprovenByReason,
      gapped_rows_by_gap_reason: gappedByReason,
      extraction_tier_gaps_by_reason: extractionGapsByReason,
      model_shape_tier_gaps: modelShapeGaps,
      dimensions_without_custody_axis: dimensionsWithoutCustodyAxis,
    },
  };

  return {
    grid,
    evidence_index: byKey,
    reference_namespaces: {
      repo_fixture: new Set(fixtureCases.map((kase) => kase.case_id)),
      blocker_corpus: new Set(blockerCases.map((kase) => kase.case_id)),
      custody_family: custody.candidateIds,
    },
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function serialiseGrid(grid) {
  return `${JSON.stringify(grid, null, 2)}\n`;
}

export function writeCommittedGrid(grid, root = ROOT) {
  fs.writeFileSync(path.join(root, GRID_RELATIVE_PATH), serialiseGrid(grid), "utf8");
}

export function readCommittedGrid(root = ROOT) {
  const file = path.join(root, GRID_RELATIVE_PATH);
  if (!fs.existsSync(file)) return null;
  return { text: fs.readFileSync(file, "utf8"), grid: JSON.parse(fs.readFileSync(file, "utf8")) };
}

export function readGridSchema(root = ROOT) {
  return readJson(root, GRID_SCHEMA_RELATIVE_PATH);
}
